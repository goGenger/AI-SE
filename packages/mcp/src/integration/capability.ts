import { MCPClientError } from "../client/MCPClientError";
import { classifyMCPError, MCPErrorCategory } from "../errors";
import { redactCredentialShapedText } from "../security/credentials";

/**
 * Phase 5.5-6: shared runtime plumbing for the resource/prompt adapters.
 *
 * Reused mechanisms ONLY — nothing here is a new engine:
 *  - timeout/cancellation mirror the ToolRuntime.withTimeout semantics
 *    (external signal + timer → abort the in-flight request, classified error);
 *  - errors are classified through the EXISTING MCPErrorCategory set;
 *  - messages are scrubbed with the existing redactCredentialShapedText;
 *  - the audit sink is dependency-injected (same pattern as approvalGate in
 *    5.5-2): the MCP layer stores nothing and owns no audit state.
 */

export interface MCPCapabilityAuditEvent {
  capability: "resource" | "prompt";
  serverId: string;
  /** Resource uri or prompt name. */
  target: string;
  outcome: "succeeded" | "denied" | "failed";
  durationMs: number;
  errorCategory?: MCPErrorCategory;
}

export type MCPCapabilityAuditSink = (event: MCPCapabilityAuditEvent) => void | Promise<void>;

/** Emits one audit event; a broken sink must never break the capability call. */
export async function emitCapabilityAudit(
  sink: MCPCapabilityAuditSink | undefined,
  event: MCPCapabilityAuditEvent
): Promise<void> {
  try {
    await sink?.(event);
  } catch {
    // Audit delivery is best-effort; the platform wires sinks that cannot fail
    // the capability path.
  }
}

export function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/**
 * Normalizes any thrown error into a declared, redacted MCPClientError:
 * existing categories only, credential-shaped substrings scrubbed.
 */
export function toCapabilityError(error: unknown, aborted: boolean): MCPClientError {
  if (error instanceof MCPClientError) {
    return new MCPClientError(
      error.mcpErrorCategory,
      redactCredentialShapedText(error.message),
      error.cause ?? error
    );
  }
  const category = classifyMCPError({ error, aborted });
  return new MCPClientError(
    category,
    redactCredentialShapedText(messageOf(error, `MCP ${category.toLowerCase()} error`)),
    error
  );
}

export function outcomeOf(error: unknown): "denied" | "failed" {
  const category =
    error instanceof MCPClientError
      ? error.mcpErrorCategory
      : classifyMCPError({ error, aborted: false });
  return category === "PERMISSION_DENIED" ? "denied" : "failed";
}

/**
 * Timeout + cancellation wrapper with the same semantics as the Tool Runtime:
 * the external signal and the timer both abort the inner controller, and the
 * rejection carries a classified MCPClientError (TIMEOUT / CANCELLED) mapped
 * later onto the existing RuntimeErrorCode set.
 */
export async function withCapabilityTimeout<T>(
  label: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (signal?.aborted) {
    throw new MCPClientError("CANCELLED", `${label} was cancelled`);
  }
  if (!timeoutMs && !signal) {
    return await run(new AbortController().signal);
  }

  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            controller.abort();
            reject(new MCPClientError("TIMEOUT", `${label} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : undefined;
      const onCancel = (): void => {
        controller.abort();
        reject(new MCPClientError("CANCELLED", `${label} was cancelled`));
      };
      signal?.addEventListener("abort", onCancel, { once: true });

      run(controller.signal)
        .then(resolve, reject)
        .finally(() => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onCancel);
        });
    });
  } finally {
    signal?.removeEventListener("abort", onExternalAbort);
  }
}
