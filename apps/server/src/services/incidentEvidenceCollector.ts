import type { PlatformMetricsAggregate } from "@ai-se/database";
import { sanitizeLogData } from "@ai-se/observability";
import type {
  Incident,
  IncidentEvidence,
  IncidentEvidenceSourceKind,
  WorkflowTraceView
} from "@ai-se/shared";

/**
 * Phase 8-B read-only evidence ports. Callers wire existing Metrics / Trace /
 * Deployment / Workflow repositories — never a second observability stack.
 */
export interface IncidentEvidenceSources {
  metricsAggregate(): Promise<PlatformMetricsAggregate>;
  buildWorkflowTrace?(workflowRunId: string): Promise<WorkflowTraceView | null>;
  listRecentDeployments?(limit: number): Promise<
    Array<{
      id: string;
      status: string;
      environment: string;
      version: string;
      createdAt: string;
      workflowRunId?: string;
    }>
  >;
  listRecentWorkflowSummaries?(limit: number): Promise<
    Array<{
      id: string;
      status: string;
      updatedAt?: string;
      name?: string;
    }>
  >;
}

function excerpt(value: unknown, max = 500): string {
  const sanitized = sanitizeLogData(value);
  const text =
    typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized, null, 0) ?? "null";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function evidence(input: {
  sourceKind: IncidentEvidenceSourceKind;
  ref: string;
  body: unknown;
  labels?: Record<string, string>;
  collectedAt: string;
}): IncidentEvidence {
  return {
    sourceKind: input.sourceKind,
    ref: input.ref.slice(0, 300),
    excerpt: excerpt(input.body),
    collectedAt: input.collectedAt,
    labels: input.labels ?? {}
  };
}

function resolveWorkflowRunId(incident: Incident): string | undefined {
  if (incident.linkedWorkflowRunId) return incident.linkedWorkflowRunId;
  const fromLabels =
    incident.labels.workflow_run_id ??
    incident.labels.workflowRunId ??
    incident.labels.workflowId;
  if (fromLabels && /^[0-9a-f-]{36}$/i.test(fromLabels)) return fromLabels;
  const raw = incident.raw.workflowRunId ?? incident.raw.workflow_run_id;
  if (typeof raw === "string" && /^[0-9a-f-]{36}$/i.test(raw)) return raw;
  return undefined;
}

function failedCount(counts: Record<string, number>, keys: string[]): number {
  return keys.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
}

/**
 * Collects sanitized evidence from platform metrics (+ optional workflow trace /
 * deployments / recent workflows). Produces **no** writes and never touches
 * DeliveryOrchestrator (SRE-07).
 */
export class IncidentEvidenceCollector {
  constructor(private readonly sources: IncidentEvidenceSources) {}

  async collect(incident: Incident): Promise<IncidentEvidence[]> {
    const collectedAt = new Date().toISOString();
    const items: IncidentEvidence[] = [];

    items.push(
      evidence({
        sourceKind: "alert",
        ref: `${incident.source}:${incident.fingerprint}`,
        body: {
          title: incident.title,
          severity: incident.severity,
          summary: incident.summary,
          labels: incident.labels
        },
        labels: { source: incident.source },
        collectedAt
      })
    );

    const metrics = await this.sources.metricsAggregate();
    const failedAgents = failedCount(metrics.agentRuns, ["failed", "FAILED", "error", "ERROR"]);
    const failedDeployments = failedCount(metrics.deployments, [
      "failed",
      "FAILED",
      "rolled_back",
      "ROLLED_BACK"
    ]);
    items.push(
      evidence({
        sourceKind: "metrics",
        ref: "platform.metrics.aggregate",
        body: {
          agentRuns: metrics.agentRuns,
          toolCalls: metrics.toolCalls,
          deployments: metrics.deployments,
          toolDurationSamples: metrics.toolDurationSamples,
          workflowDurationSamples: metrics.workflowDurationSamples,
          failedAgentRuns: failedAgents,
          failedDeployments
        },
        collectedAt
      })
    );

    const workflowRunId = resolveWorkflowRunId(incident);
    if (workflowRunId && this.sources.buildWorkflowTrace) {
      const trace = await this.sources.buildWorkflowTrace(workflowRunId);
      if (trace) {
        items.push(
          evidence({
            sourceKind: "workflow_trace",
            ref: `workflow:${workflowRunId}`,
            body: {
              workflowRunId: trace.workflowRunId,
              requestId: trace.requestId,
              rootStatus: trace.root.status,
              rootLabel: trace.root.label,
              counts: trace.counts
            },
            labels: { workflowRunId },
            collectedAt
          })
        );
      }
    }

    if (this.sources.listRecentDeployments) {
      const deployments = await this.sources.listRecentDeployments(5);
      if (deployments.length > 0) {
        items.push(
          evidence({
            sourceKind: "deployment",
            ref: "deployments.recent",
            body: deployments.map((row) => ({
              id: row.id,
              status: row.status,
              environment: row.environment,
              version: row.version,
              createdAt: row.createdAt,
              workflowRunId: row.workflowRunId
            })),
            collectedAt
          })
        );
      }
    }

    if (this.sources.listRecentWorkflowSummaries) {
      const workflows = await this.sources.listRecentWorkflowSummaries(5);
      if (workflows.length > 0) {
        items.push(
          evidence({
            sourceKind: "workflow_summary",
            ref: "workflows.recent",
            body: workflows,
            collectedAt
          })
        );
      }
    }

    return items;
  }
}

export { resolveWorkflowRunId };
