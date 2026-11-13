import type { Incident } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { IncidentAgent } from "../services/incidentAgent";
import { IncidentEvidenceCollector } from "../services/incidentEvidenceCollector";
import { IncidentService, type IncidentStore } from "../services/incidentService";
import { randomUUID } from "node:crypto";

function openIncident(overrides: Partial<Incident> = {}): Incident {
  const now = "2026-11-04T04:00:00.000Z";
  return {
    id: randomUUID(),
    status: "open",
    source: "prometheus",
    fingerprint: "api-5xx",
    severity: "high",
    title: "API 5xx spike",
    labels: { service: "api" },
    raw: { token: "sk-abcdefghijklmnop" },
    openedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("Phase 8-B IncidentAgent", () => {
  it("SRE-05/06: emits schema output citing ≥2 source kinds", () => {
    const agent = new IncidentAgent();
    const diagnosis = agent.diagnose({
      incident: openIncident(),
      evidence: [
        {
          sourceKind: "metrics",
          ref: "platform.metrics.aggregate",
          excerpt: JSON.stringify({ failedAgentRuns: 3, failedDeployments: 1 }),
          collectedAt: "2026-11-04T04:01:00.000Z",
          labels: {}
        },
        {
          sourceKind: "workflow_trace",
          ref: "workflow:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          excerpt: JSON.stringify({ rootStatus: "FAILED", counts: { tasks: 2 } }),
          collectedAt: "2026-11-04T04:01:00.000Z",
          labels: {}
        }
      ],
      now: "2026-11-04T04:01:01.000Z"
    });
    expect(diagnosis.summary.length).toBeGreaterThan(0);
    expect(diagnosis.rootCauseHypothesis.length).toBeGreaterThan(0);
    expect(diagnosis.fixPlan.length).toBeGreaterThan(0);
    expect(diagnosis.risk.length).toBeGreaterThan(0);
    expect(diagnosis.recommendedAction.length).toBeGreaterThan(0);
    expect(new Set(diagnosis.evidence.map((item) => item.sourceKind)).size).toBeGreaterThanOrEqual(
      2
    );
  });

  it("SRE-08: redacts credential-shaped text in evidence excerpts", () => {
    const agent = new IncidentAgent();
    const diagnosis = agent.diagnose({
      incident: openIncident(),
      evidence: [
        {
          sourceKind: "metrics",
          ref: "platform.metrics.aggregate",
          excerpt: "token=sk-abcdefghijklmnop",
          collectedAt: "2026-11-04T04:01:00.000Z",
          labels: { authorization: "Bearer supersecretvalue1" }
        },
        {
          sourceKind: "alert",
          ref: "prometheus:api-5xx",
          excerpt: "password: hunter2token",
          collectedAt: "2026-11-04T04:01:00.000Z",
          labels: {}
        }
      ],
      now: "2026-11-04T04:01:01.000Z"
    });
    const blob = JSON.stringify(diagnosis);
    expect(blob).not.toContain("sk-abcdefghijklmnop");
    expect(blob).toContain("[REDACTED]");
  });

  it("refuses empty / single-source evidence", () => {
    const agent = new IncidentAgent();
    expect(() =>
      agent.diagnose({
        incident: openIncident(),
        evidence: [
          {
            sourceKind: "metrics",
            ref: "m",
            excerpt: "{}",
            collectedAt: "2026-11-04T04:01:00.000Z",
            labels: {}
          }
        ]
      })
    ).toThrow(/INSUFFICIENT_EVIDENCE/);
  });
});

describe("Phase 8-B evidence collector + service", () => {
  it("collects metrics + alert (and optional trace) without writes", async () => {
    let metricsCalls = 0;
    const collector = new IncidentEvidenceCollector({
      metricsAggregate: async () => {
        metricsCalls += 1;
        return {
          agentRuns: { succeeded: 10, failed: 2 },
          toolCalls: { succeeded: 20 },
          deployments: { SUCCESS: 3, FAILED: 1 },
          toolDurationMs: 100,
          toolDurationSamples: 5,
          workflowDurationMs: 200,
          workflowDurationSamples: 2
        };
      },
      buildWorkflowTrace: async () => ({
        workflowRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        generatedAt: "2026-11-04T04:01:00.000Z",
        root: {
          kind: "workflow",
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          label: "demo",
          status: "FAILED",
          detail: {},
          children: []
        },
        counts: { tasks: 1, agentRuns: 1, toolCalls: 0, deployments: 0 }
      })
    });

    const evidence = await collector.collect(
      openIncident({
        linkedWorkflowRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      })
    );
    expect(metricsCalls).toBe(1);
    const kinds = new Set(evidence.map((item) => item.sourceKind));
    expect(kinds.has("alert")).toBe(true);
    expect(kinds.has("metrics")).toBe(true);
    expect(kinds.has("workflow_trace")).toBe(true);
  });

  it("persists diagnosis and moves status to diagnosing", async () => {
    const incidents = new Map<string, Incident>();
    const store: IncidentStore = {
      async findActiveByFingerprint() {
        return null;
      },
      async create() {
        throw new Error("unused");
      },
      async appendAlertEvent() {},
      async findById(id) {
        return incidents.get(id) ?? null;
      },
      async findMany() {
        return [...incidents.values()];
      },
      async saveDiagnosis(input) {
        const current = incidents.get(input.id);
        if (!current) throw new Error("missing");
        const updated: Incident = {
          ...current,
          status: input.status ?? "diagnosing",
          diagnosis: input.diagnosis,
          diagnosedAt: input.diagnosis.diagnosedAt,
          updatedAt: input.diagnosis.diagnosedAt
        };
        incidents.set(input.id, updated);
        return updated;
      }
    };

    const incident = openIncident();
    incidents.set(incident.id, incident);

    const service = new IncidentService(store, {
      collector: new IncidentEvidenceCollector({
        metricsAggregate: async () => ({
          agentRuns: { failed: 1 },
          toolCalls: {},
          deployments: { FAILED: 1 },
          toolDurationMs: 0,
          toolDurationSamples: 0,
          workflowDurationMs: 0,
          workflowDurationSamples: 0
        })
      }),
      agent: new IncidentAgent()
    });

    const diagnosed = await service.diagnose(incident.id);
    expect(diagnosed.status).toBe("diagnosing");
    expect(diagnosed.diagnosis?.evidence.length).toBeGreaterThanOrEqual(2);
    expect(diagnosed.diagnosis?.agentName).toBe("incident-agent");
  });
});
