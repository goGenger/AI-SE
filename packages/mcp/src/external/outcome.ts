import { redactCredentialShapedText } from "@ai-se/observability";
import { ActionResultSchema, type ActionResult, type ExternalActionRef } from "@ai-se/shared";
import { ToolExecutionError } from "@ai-se/tool-runtime";

/**
 * Phase 5.7-2: unified external-action output.
 *
 * Every external engineering action outputs the frozen 5.7-0 ActionResult
 * (identity / status / error / timing) PLUS the external system's returned
 * payload as DATA under `result`. The frozen ActionResult schema is strict and
 * has no result slot, so the two travel together in this outcome envelope —
 * no second action-result system is introduced.
 *
 * Externally returned content is UNTRUSTED: it enters tool results / agent
 * context as data only. This module never interprets it: the payload is walked
 * (bounded) so every string passes the shared credential-shaped redaction sink,
 * and nothing from it is ever promoted into status, error, audit, or any
 * control channel.
 */

export interface ExternalToolOutcome {
  /** Frozen 5.7-0 result: status success/failed/cancelled + target + error. */
  actionResult: ActionResult;
  /** External system payload, as data (untrusted). Present on success. */
  result?: unknown;
}

const MAX_REDACT_DEPTH = 8;
const MAX_REDACT_NODES = 5000;
const MAX_SERIALIZED_DEPTH_LIMIT = 10_000;

/**
 * Bounded structural redaction of untrusted external data: strings pass the
 * shared credential-shaped sink; containers are copied (never mutated).
 * Beyond the depth/node bounds the remaining value is preserved in serialized
 * (redacted, truncated) form instead of being walked further.
 */
export function redactUntrustedExternalData(
  value: unknown,
  budget: { nodes: number } = { nodes: MAX_REDACT_NODES },
  depth = 0
): unknown {
  if (typeof value === "string") return redactCredentialShapedText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (budget.nodes <= 0 || depth >= MAX_REDACT_DEPTH) {
    let serialized: string;
    try {
      serialized = JSON.stringify(value) ?? String(value);
    } catch {
      serialized = String(value);
    }
    return redactCredentialShapedText(serialized.slice(0, MAX_SERIALIZED_DEPTH_LIMIT));
  }
  budget.nodes -= 1;
  if (Array.isArray(value)) {
    return value.map((entry) => redactUntrustedExternalData(entry, budget, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[redactCredentialShapedText(key)] = redactUntrustedExternalData(
        entry,
        budget,
        depth + 1
      );
    }
    return output;
  }
  // undefined / function / symbol / bigint never appear in MCP JSON payloads.
  return redactCredentialShapedText(String(value));
}

export function newExternalResultId(): string {
  return `result-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Frozen 5.7-0 mcp-arm action identity. */
export function externalActionRef(
  serverName: string,
  toolName: string,
  callId: string
): ExternalActionRef {
  return { source: "mcp", serverName, toolName, callId };
}

/**
 * Error field for a failed action outcome. Prefers the MCP error category
 * (metadata on the normalized ToolExecutionError) so the placeholder
 * `error.code` stays informative until 5.7-5 freezes the vocabulary; the
 * message always passes the redaction sink.
 */
export function externalActionError(error: unknown): { code: string; message: string } {
  const base =
    error instanceof ToolExecutionError
      ? { code: error.code as string, message: error.message }
      : {
          code: "EXTERNAL_ACTION_FAILED",
          message: error instanceof Error ? error.message : "unknown external action failure"
        };
  const details =
    error instanceof ToolExecutionError &&
    typeof error.details === "object" &&
    error.details !== null
      ? (error.details as { mcpErrorCategory?: unknown })
      : undefined;
  const category =
    typeof details?.mcpErrorCategory === "string" ? details.mcpErrorCategory : undefined;
  const code = category ? `MCP_${category}` : base.code;
  return {
    code: code.slice(0, 80),
    message: redactCredentialShapedText(base.message).slice(0, 2000)
  };
}

/**
 * Governance-level failures stay at the ToolResult envelope (never ran an
 * action): cancellation, timeout, permission denial, approval denial. All
 * other MCP invocation errors are outcomes of an attempted action and map
 * into a failed ActionResult instead.
 */
export function isGovernanceLevelFailure(error: unknown): boolean {
  if (!(error instanceof ToolExecutionError)) return true;
  if (error.code === "CANCELLED_ERROR" || error.code === "TIMEOUT_ERROR") return true;
  const details =
    typeof error.details === "object" && error.details !== null
      ? (error.details as { mcpErrorCategory?: unknown })
      : undefined;
  return (
    details?.mcpErrorCategory === "PERMISSION_DENIED" ||
    details?.mcpErrorCategory === "APPROVAL_REQUIRED"
  );
}

interface OutcomeTiming {
  startedAtMs: number;
  occurredAt: string;
  resultId: string;
  actionRef: ExternalActionRef;
}

export function buildSuccessOutcome(timing: OutcomeTiming, raw: unknown): ExternalToolOutcome {
  const actionResult = ActionResultSchema.parse({
    resultId: timing.resultId,
    actionRef: timing.actionRef,
    status: "success",
    durationMs: Date.now() - timing.startedAtMs,
    occurredAt: timing.occurredAt
  });
  return { actionResult, result: redactUntrustedExternalData(raw) };
}

export function buildFailedOutcome(timing: OutcomeTiming, error: unknown): ExternalToolOutcome {
  return {
    actionResult: ActionResultSchema.parse({
      resultId: timing.resultId,
      actionRef: timing.actionRef,
      status: "failed",
      error: externalActionError(error),
      durationMs: Date.now() - timing.startedAtMs,
      occurredAt: timing.occurredAt
    })
  };
}

export function buildCancelledOutcome(timing: OutcomeTiming): ExternalToolOutcome {
  const cancelledAt = new Date().toISOString();
  return {
    actionResult: ActionResultSchema.parse({
      resultId: timing.resultId,
      actionRef: timing.actionRef,
      status: "cancelled",
      cancelledAt,
      durationMs: Date.now() - timing.startedAtMs,
      occurredAt: timing.occurredAt
    })
  };
}
