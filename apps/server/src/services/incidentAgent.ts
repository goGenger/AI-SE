import { sanitizeLogData } from "@ai-se/observability";
import {
  IncidentDiagnosisSchema,
  type Incident,
  type IncidentDiagnosis,
  type IncidentEvidence
} from "@ai-se/shared";

/**
 * Phase 8-B Incident Agent (read-only synthesizer).
 *
 * Produces the six-field diagnosis contract from collected evidence.
 * Does **not** call Tool Runtime for writes, open fix workflows, or deploy
 * anything — that is 8-C+. Sensitive strings are scrubbed via sanitizeLogData
 * before schema parse (SRE-08).
 */
export const INCIDENT_AGENT_NAME = "incident-agent";

function scrub(text: string): string {
  const sanitized = sanitizeLogData(text);
  return typeof sanitized === "string" ? sanitized : String(sanitized);
}

function uniqueSourceKinds(evidence: IncidentEvidence[]): Set<string> {
  return new Set(evidence.map((item) => item.sourceKind));
}

function findEvidence(
  evidence: IncidentEvidence[],
  kind: IncidentEvidence["sourceKind"]
): IncidentEvidence | undefined {
  return evidence.find((item) => item.sourceKind === kind);
}

function summarizeMetrics(excerpt: string): string {
  try {
    const parsed = JSON.parse(excerpt) as {
      failedAgentRuns?: number;
      failedDeployments?: number;
      agentRuns?: Record<string, number>;
      deployments?: Record<string, number>;
    };
    const parts: string[] = [];
    if (typeof parsed.failedAgentRuns === "number") {
      parts.push(`failedAgentRuns=${parsed.failedAgentRuns}`);
    }
    if (typeof parsed.failedDeployments === "number") {
      parts.push(`failedDeployments=${parsed.failedDeployments}`);
    }
    if (parsed.agentRuns) {
      parts.push(`agentRuns=${JSON.stringify(parsed.agentRuns)}`);
    }
    if (parsed.deployments) {
      parts.push(`deployments=${JSON.stringify(parsed.deployments)}`);
    }
    return parts.join("; ") || excerpt.slice(0, 240);
  } catch {
    return excerpt.slice(0, 240);
  }
}

export class IncidentAgent {
  /**
   * Build a schema-valid diagnosis. Requires evidence from **≥2 distinct
   * sourceKind** values (SRE-06). Throws if evidence is insufficient so callers
   * never persist an empty-evidence SUCCESS (docs/242 risk table).
   */
  diagnose(input: {
    incident: Incident;
    evidence: IncidentEvidence[];
    now?: string;
  }): IncidentDiagnosis {
    const kinds = uniqueSourceKinds(input.evidence);
    if (input.evidence.length === 0 || kinds.size < 2) {
      throw new Error(
        `INCIDENT_DIAGNOSIS_INSUFFICIENT_EVIDENCE: need ≥2 source kinds, got ${kinds.size}`
      );
    }

    const metrics = findEvidence(input.evidence, "metrics");
    const trace = findEvidence(input.evidence, "workflow_trace");
    const deployment = findEvidence(input.evidence, "deployment");
    const workflow = findEvidence(input.evidence, "workflow_summary");

    const metricBits = metrics ? summarizeMetrics(metrics.excerpt) : "metrics unavailable";
    const traceBits = trace
      ? `linked workflow ${trace.ref}: ${trace.excerpt.slice(0, 200)}`
      : "no linked workflow trace";
    const deployBits = deployment
      ? `recent deployments: ${deployment.excerpt.slice(0, 160)}`
      : "no recent deployment sample";

    const summary = scrub(
      `Read-only diagnosis for ${input.incident.title} (${input.incident.severity}) from ${input.incident.source}. Evidence kinds: ${[...kinds].sort().join(", ")}.`
    );
    const rootCauseHypothesis = scrub(
      `Hypothesis: alert fingerprint "${input.incident.fingerprint}" correlates with platform signals (${metricBits}). ${traceBits}. ${deployBits}.`
    );
    const fixPlan = scrub(
      [
        "1. Confirm the linked workflow / service named in evidence (no production change).",
        "2. Reproduce from metrics + workflow trace excerpts attached above.",
        "3. Draft a staging-only fix workflow under existing DeliveryOrchestrator + approval gates (Phase 8-C).",
        "4. Do not run production shell, mutate secrets, or bypass WAITING_APPROVAL."
      ].join(" ")
    );
    const risk = scrub(
      "Diagnosis path is read-only. Applying a fix without staging VERIFY and approval would risk unverified production change; 8-B deliberately does not open repair workflows."
    );
    const recommendedAction = scrub(
      workflow || deployment || trace
        ? "await_human_review_then_propose_staging_fix"
        : "collect_more_telemetry_then_rediagnose"
    );

    const diagnosedAt = input.now ?? new Date().toISOString();
    const draft = {
      summary,
      rootCauseHypothesis,
      evidence: input.evidence.map((item) => ({
        ...item,
        excerpt: scrub(item.excerpt),
        ref: scrub(item.ref),
        labels: Object.fromEntries(
          Object.entries(item.labels).map(([key, value]) => [key, scrub(value)])
        )
      })),
      fixPlan,
      risk,
      recommendedAction,
      agentName: INCIDENT_AGENT_NAME,
      diagnosedAt
    };

    return IncidentDiagnosisSchema.parse(draft);
  }
}
