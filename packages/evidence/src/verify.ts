import {
  EvidenceVerificationSchema,
  type ActionResult,
  type EvidenceExpectation,
  type EvidenceSnapshot,
  type EvidenceVerification
} from "@ai-se/shared";
import { redactEvidenceString } from "./redact";

/**
 * Phase 5.7-4: verification of one action against caller-declared
 * expectations, using ONLY the real evidence (before/after snapshots + the
 * action's ActionResult). Fixed verdict vocabulary VERIFIED / FAILED with
 * per-expectation findings — the 5.6-4 spirit (structured comparison against
 * the expectation; no new scoring, no grading engine).
 *
 * Nothing here consults an agent report: the verdict reads the captured
 * before/after states and the action result only.
 */

export interface VerifyEvidenceInput {
  before: EvidenceSnapshot;
  after: EvidenceSnapshot;
  result: ActionResult;
  expectations: EvidenceExpectation[];
}

/** Content projection for the `changed` expectation: volatile fields
 * (observationId / callIds / timestamps) never count as a change. */
function snapshotContent(snapshot: EvidenceSnapshot): string {
  const observation = snapshot.observation;
  return JSON.stringify({
    dom:
      observation?.dom?.nodes.map((node) => ({
        role: node.role,
        name: node.name,
        clickable: node.clickable,
        text: node.text
      })) ?? null,
    accessibility: observation?.accessibility?.tree ?? null,
    result: snapshot.result ?? null
  });
}

/**
 * Phase 5.7-5 reuse: did the state really move between two snapshots? Same
 * content projection as the `changed` expectation (identity/timestamps are
 * ignored) — the single comparison used by recovery progress accounting.
 */
export function snapshotsDiffer(before: EvidenceSnapshot, after: EvidenceSnapshot): boolean {
  return snapshotContent(after) !== snapshotContent(before);
}

function searchableText(snapshot: EvidenceSnapshot): string {
  const parts: string[] = [];
  const observation = snapshot.observation;
  if (observation?.dom) {
    for (const node of observation.dom.nodes) {
      parts.push(node.name, node.text);
    }
  }
  if (observation?.accessibility) parts.push(observation.accessibility.tree);
  if (snapshot.result !== undefined) {
    try {
      parts.push(JSON.stringify(snapshot.result) ?? String(snapshot.result));
    } catch {
      parts.push(String(snapshot.result));
    }
  }
  return parts.join("\n");
}

export function verifyActionEvidence(input: VerifyEvidenceInput): EvidenceVerification {
  const findings = input.expectations.map((expectation) => {
    switch (expectation.kind) {
      case "action-succeeded": {
        const ok = input.result.status === "success";
        return {
          expectation,
          ok,
          detail: ok
            ? "action result status success"
            : `action result status ${input.result.status}${input.result.error ? ` (${input.result.error.code})` : ""}`
        };
      }
      case "contains": {
        const ok = searchableText(input.after).includes(expectation.value);
        return {
          expectation,
          ok,
          detail: ok
            ? `after snapshot contains "${expectation.value}"`
            : `after snapshot does not contain "${expectation.value}"`
        };
      }
      case "changed": {
        const ok = snapshotsDiffer(input.before, input.after);
        return {
          expectation,
          ok,
          detail: ok
            ? "after snapshot content differs from before"
            : "after snapshot content is identical to before"
        };
      }
    }
  });

  const status = findings.every((finding) => finding.ok) ? "VERIFIED" : "FAILED";
  return EvidenceVerificationSchema.parse({
    status,
    findings: findings.map((finding) => ({
      expectation: finding.expectation,
      ok: finding.ok,
      detail: redactEvidenceString(finding.detail)
    })),
    verifiedAt: new Date().toISOString()
  });
}
