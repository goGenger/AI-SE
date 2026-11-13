import { describe, expect, it } from "vitest";
import {
  AlertIngestSchema,
  INCIDENT_AUTO_REMEDIATE_WHITELIST,
  INCIDENT_REMEDIATION_WHITELIST,
  IncidentDiagnosisSchema,
  IncidentRemediationDecisionSchema,
  IncidentRemediateResultSchema,
  IncidentSchema
} from "./index";

describe("Phase 8-A alert/incident contracts", () => {
  it("accepts a minimal alert and fills defaults", () => {
    const parsed = AlertIngestSchema.parse({
      source: "prometheus",
      fingerprint: "api-5xx",
      severity: "high"
    });
    expect(parsed.labels).toEqual({});
    expect(parsed.raw).toEqual({});
  });

  it("rejects empty fingerprint and unknown fields", () => {
    expect(() =>
      AlertIngestSchema.parse({
        source: "prometheus",
        fingerprint: " ",
        severity: "high"
      })
    ).toThrow();
    expect(() =>
      AlertIngestSchema.parse({
        source: "prometheus",
        fingerprint: "x",
        severity: "high",
        extra: true
      })
    ).toThrow();
  });

  it("round-trips a frozen incident shape", () => {
    const incident = IncidentSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      status: "open",
      source: "webhook",
      fingerprint: "fp-1",
      severity: "critical",
      title: "API 5xx spike",
      labels: { service: "api" },
      raw: { count: 12 },
      openedAt: "2026-11-04T02:00:00.000Z",
      createdAt: "2026-11-04T02:00:00.000Z",
      updatedAt: "2026-11-04T02:00:00.000Z"
    });
    expect(incident.status).toBe("open");
    expect(incident.linkedWorkflowRunId).toBeUndefined();
  });
});

describe("Phase 8-B incident diagnosis contract", () => {
  const evidence = [
    {
      sourceKind: "metrics" as const,
      ref: "platform.metrics.aggregate",
      excerpt: '{"failedAgentRuns":2}',
      collectedAt: "2026-11-04T03:00:00.000Z",
      labels: {}
    },
    {
      sourceKind: "workflow_trace" as const,
      ref: "workflow:22222222-2222-4222-8222-222222222222",
      excerpt: '{"rootStatus":"FAILED"}',
      collectedAt: "2026-11-04T03:00:00.000Z",
      labels: {}
    }
  ];

  it("SRE-05: requires the six diagnosis fields", () => {
    const diagnosis = IncidentDiagnosisSchema.parse({
      summary: "spike",
      rootCauseHypothesis: "likely bad deploy",
      evidence,
      fixPlan: "roll forward in staging",
      risk: "low while read-only",
      recommendedAction: "await_human_review_then_propose_staging_fix",
      diagnosedAt: "2026-11-04T03:00:01.000Z"
    });
    expect(diagnosis.agentName).toBe("incident-agent");
    expect(diagnosis.evidence).toHaveLength(2);
  });

  it("rejects empty evidence array", () => {
    expect(() =>
      IncidentDiagnosisSchema.parse({
        summary: "x",
        rootCauseHypothesis: "y",
        evidence: [],
        fixPlan: "z",
        risk: "r",
        recommendedAction: "a",
        diagnosedAt: "2026-11-04T03:00:01.000Z"
      })
    ).toThrow();
  });

  it("round-trips diagnosis on an incident", () => {
    const diagnosis = IncidentDiagnosisSchema.parse({
      summary: "spike",
      rootCauseHypothesis: "likely bad deploy",
      evidence,
      fixPlan: "roll forward in staging",
      risk: "low while read-only",
      recommendedAction: "await_human_review_then_propose_staging_fix",
      diagnosedAt: "2026-11-04T03:00:01.000Z"
    });
    const incident = IncidentSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      status: "diagnosing",
      source: "webhook",
      fingerprint: "fp-1",
      severity: "critical",
      title: "API 5xx spike",
      labels: {},
      raw: {},
      diagnosis,
      diagnosedAt: diagnosis.diagnosedAt,
      openedAt: "2026-11-04T02:00:00.000Z",
      createdAt: "2026-11-04T02:00:00.000Z",
      updatedAt: "2026-11-04T03:00:01.000Z"
    });
    expect(incident.diagnosis?.evidence[0]?.sourceKind).toBe("metrics");
  });
});

describe("Phase 8-C incident remediation contract", () => {
  it("accepts 8-C remediation decision and whitelist constants", () => {
    expect(INCIDENT_REMEDIATION_WHITELIST).toContain("staging_verify_flaky");
    const remediation = IncidentRemediationDecisionSchema.parse({
      decision: "OPENED_STAGING_FIX_WORKFLOW",
      faultType: "staging_verify_flaky",
      whitelisted: true,
      reason: "whitelisted",
      workflowRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      requirementId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      started: false,
      decidedAt: "2026-11-04T05:00:00.000Z"
    });
    const incident = IncidentSchema.parse({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "mitigating",
      source: "prometheus",
      fingerprint: "fp-1",
      severity: "high",
      title: "t",
      labels: { faultType: "staging_verify_flaky" },
      raw: {},
      linkedWorkflowRunId: remediation.workflowRunId,
      remediation,
      remediatedAt: remediation.decidedAt,
      openedAt: "2026-11-04T04:00:00.000Z",
      createdAt: "2026-11-04T04:00:00.000Z",
      updatedAt: "2026-11-04T05:00:00.000Z"
    });
    IncidentRemediateResultSchema.parse({ incident, remediation });
  });
});

describe("Phase 8-D incident auto-remediate contract", () => {
  it("reuses the written 8-C whitelist and accepts autoStarted audit fields", () => {
    expect(INCIDENT_AUTO_REMEDIATE_WHITELIST).toEqual(INCIDENT_REMEDIATION_WHITELIST);
    const remediation = IncidentRemediationDecisionSchema.parse({
      decision: "OPENED_STAGING_FIX_WORKFLOW",
      faultType: "ci_release_missing",
      whitelisted: true,
      reason: "auto",
      workflowRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      requirementId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      started: true,
      autoStarted: true,
      autoRemediateEnabled: true,
      decidedAt: "2026-11-04T06:00:00.000Z"
    });
    expect(remediation.autoStarted).toBe(true);
  });
});

