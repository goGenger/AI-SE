import { redactCredentialShapedText, redactString } from "@ai-se/observability";

/**
 * Phase 5.7-4: single redaction sink for evidence content. Every string that
 * can enter an EvidenceRecord (snapshots, results, external ids, verification
 * details, keys) passes BOTH existing observability redactors before the
 * draft is built or persisted — no new secret store, no new redaction rules.
 */

const MAX_DEPTH = 10;
const MAX_NODES = 8000;

export function redactEvidenceString(value: string): string {
  return redactCredentialShapedText(redactString(value));
}

/**
 * Bounded recursive redaction (copies, never mutates). Beyond the bounds the
 * remaining value is preserved as a redacted serialized cut.
 */
export function redactEvidenceContent(
  value: unknown,
  budget: { nodes: number } = { nodes: MAX_NODES },
  depth = 0
): unknown {
  if (typeof value === "string") return redactEvidenceString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (budget.nodes <= 0 || depth >= MAX_DEPTH) {
    let serialized: string;
    try {
      serialized = JSON.stringify(value) ?? String(value);
    } catch {
      serialized = String(value);
    }
    return redactEvidenceString(serialized.slice(0, 20_000));
  }
  budget.nodes -= 1;
  if (Array.isArray(value)) {
    return value.map((entry) => redactEvidenceContent(entry, budget, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[redactEvidenceString(key)] = redactEvidenceContent(entry, budget, depth + 1);
    }
    return output;
  }
  return redactEvidenceString(String(value));
}
