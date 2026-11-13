import {
  EvidenceRecordDraftSchema,
  type ActionResult,
  type EvidenceExpectation,
  type EvidenceRecordDraft,
  type EvidenceSnapshot,
  type ExternalActionRef
} from "@ai-se/shared";
import { redactEvidenceContent } from "./redact";
import { verifyActionEvidence } from "./verify";

/**
 * Phase 5.7-4: evidence capture.
 *
 *   before observation → action → after observation (→ screenshot)
 *   → verification → EvidenceRecordDraft
 *
 * Capture runs the REAL pieces: callers supply the real observation callbacks
 * (browser session / MCP call) and the real action (through ToolRuntime). The
 * builder then verifies against expectations, redacts every piece of content
 * through the single sink, and validates the draft against the frozen 5.7-4
 * contract. Evidence records FACTS only — it never retries, re-plans,
 * recovers, or decides approvals (those stay with their owning systems).
 */

export interface EvidenceIdentity {
  projectId: string;
  workflowRunId?: string;
  taskId?: string;
  agentRunId?: string;
  toolCallId?: string;
  actionRef: ExternalActionRef;
}

export interface EvidenceActionOutcome {
  /** The action's real result (5.7-0 ActionResult; 5.7-1/2 tools never throw for op failures). */
  result: ActionResult;
  /** The action's own actionRef when it differs from the identity (real ref wins). */
  actionRef?: ExternalActionRef;
  /** External-system id of the affected object, when the system returns one. */
  externalId?: string;
}

export interface CaptureActionEvidenceInput {
  identity: EvidenceIdentity;
  /** At least one expectation; the verdict reads real evidence only. */
  expectations: EvidenceExpectation[];
  /** Real BEFORE state (browser observation / external snapshot). */
  before: () => Promise<EvidenceSnapshot>;
  /** The action itself — goes through the existing ToolRuntime path. */
  act: () => Promise<EvidenceActionOutcome>;
  /** Real AFTER state. */
  after: () => Promise<EvidenceSnapshot>;
  /** Optional screenshot captured after the AFTER observation (5.6-3 ref). */
  screenshot?: () => Promise<string | undefined>;
}

export function buildEvidenceDraft(input: {
  identity: EvidenceIdentity;
  expectations: EvidenceExpectation[];
  before: EvidenceSnapshot;
  after: EvidenceSnapshot;
  result: ActionResult;
  screenshotRef?: string;
  externalId?: string;
}): EvidenceRecordDraft {
  const verification = verifyActionEvidence({
    before: input.before,
    after: input.after,
    result: input.result,
    expectations: input.expectations
  });
  const draft = {
    projectId: input.identity.projectId,
    ...(input.identity.workflowRunId ? { workflowRunId: input.identity.workflowRunId } : {}),
    ...(input.identity.taskId ? { taskId: input.identity.taskId } : {}),
    ...(input.identity.agentRunId ? { agentRunId: input.identity.agentRunId } : {}),
    ...(input.identity.toolCallId ? { toolCallId: input.identity.toolCallId } : {}),
    actionRef: input.identity.actionRef,
    ...(input.externalId ? { externalId: input.externalId } : {}),
    before: input.before,
    after: input.after,
    result: input.result,
    ...(input.screenshotRef ? { screenshotRef: input.screenshotRef } : {}),
    verification
  };
  // Single redaction sink over every content-bearing string, then the frozen
  // contract's strict validation (fail closed on anything unexpected).
  const redacted = redactEvidenceContent(draft) as EvidenceRecordDraft;
  return EvidenceRecordDraftSchema.parse(redacted);
}

export async function captureActionEvidence(
  input: CaptureActionEvidenceInput
): Promise<EvidenceRecordDraft> {
  const before = await input.before();
  const outcome = await input.act();
  const after = await input.after();
  const screenshotRef = input.screenshot ? await input.screenshot() : undefined;
  return buildEvidenceDraft({
    identity: {
      ...input.identity,
      ...(outcome.actionRef ? { actionRef: outcome.actionRef } : {})
    },
    expectations: input.expectations,
    before,
    after,
    result: outcome.result,
    ...(screenshotRef ? { screenshotRef } : {}),
    ...(outcome.externalId ? { externalId: outcome.externalId } : {})
  });
}
