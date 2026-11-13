import type { Incident, IncidentDiagnosis, TaskPlan } from "@ai-se/shared";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IncidentFixWorkflowOpenInput } from "../services/incidentFixWorkflowOpener";
import {
  buildStagingFixTaskPlan,
  findForbiddenRemediationPlanViolation,
  isAutoRemediateFaultType,
  isWhitelistedFaultType,
  resolveIncidentFaultType,
  resolveRemediationAutoStart
} from "../services/incidentRemediationPolicy";
import { IncidentService, type IncidentStore } from "../services/incidentService";

function diagnosis(): IncidentDiagnosis {
  const diagnosedAt = "2026-11-04T05:00:00.000Z";
  return {
    summary: "fixture",
    rootCauseHypothesis: "fixture",
    evidence: [
      {
        sourceKind: "metrics",
        ref: "m",
        excerpt: '{"failedAgentRuns":1}',
        collectedAt: diagnosedAt,
        labels: {}
      },
      {
        sourceKind: "alert",
        ref: "a",
        excerpt: "alert",
        collectedAt: diagnosedAt,
        labels: {}
      }
    ],
    fixPlan: "staging fix",
    risk: "low if gated",
    recommendedAction: "await_human_review_then_propose_staging_fix",
    agentName: "incident-agent",
    diagnosedAt
  };
}

function baseIncident(overrides: Partial<Incident> = {}): Incident {
  const now = "2026-11-04T05:00:00.000Z";
  return {
    id: randomUUID(),
    projectId: randomUUID(),
    status: "diagnosing",
    source: "prometheus",
    fingerprint: "fp-1",
    severity: "high",
    title: "staging verify flake",
    labels: { faultType: "staging_verify_flaky" },
    raw: {},
    diagnosis: diagnosis(),
    diagnosedAt: diagnosis().diagnosedAt,
    openedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function memoryStore(seed: Incident): IncidentStore & { get(id: string): Incident | undefined } {
  const incidents = new Map<string, Incident>([[seed.id, seed]]);
  return {
    get: (id) => incidents.get(id),
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
      const current = incidents.get(input.id)!;
      const updated = {
        ...current,
        diagnosis: input.diagnosis,
        diagnosedAt: input.diagnosis.diagnosedAt,
        status: input.status ?? "diagnosing",
        updatedAt: input.diagnosis.diagnosedAt
      };
      incidents.set(input.id, updated);
      return updated;
    },
    async saveRemediation(input) {
      const current = incidents.get(input.id)!;
      const updated: Incident = {
        ...current,
        remediation: input.remediation,
        remediatedAt: input.remediation.decidedAt,
        ...(input.status ? { status: input.status } : {}),
        ...(input.linkedWorkflowRunId
          ? { linkedWorkflowRunId: input.linkedWorkflowRunId }
          : {}),
        updatedAt: input.remediation.decidedAt
      };
      incidents.set(input.id, updated);
      return updated;
    }
  };
}

describe("Phase 8-C remediation policy", () => {
  it("recognizes whitelist fault types from labels", () => {
    expect(resolveIncidentFaultType(baseIncident())).toBe("staging_verify_flaky");
    expect(isWhitelistedFaultType("staging_verify_flaky")).toBe(true);
    expect(isWhitelistedFaultType("ci_release_missing")).toBe(true);
    expect(isWhitelistedFaultType("config_drift_staging")).toBe(true);
    expect(isWhitelistedFaultType("delete_production_db")).toBe(false);
    expect(isWhitelistedFaultType(undefined)).toBe(false);
  });

  it("SRE-10: staging fix plan uses delivery CI/DEPLOY/VERIFY types with prod last", () => {
    const plan: TaskPlan = buildStagingFixTaskPlan(baseIncident());
    expect(plan.tasks.map((t) => t.id)).toEqual(["CI", "STAGING", "VERIFY", "PRODUCTION"]);
    expect(plan.tasks[0]?.delivery).toEqual({ action: "CI", ref: "main" });
    expect(plan.tasks[1]?.delivery).toEqual({ action: "DEPLOY", environment: "staging" });
    expect(plan.tasks[2]?.delivery).toEqual({ action: "VERIFY", environment: "staging" });
    expect(plan.tasks[3]?.delivery).toEqual({ action: "DEPLOY", environment: "production" });
    // SRE-11: PRODUCTION depends on VERIFY — verify failure cannot promote
    expect(plan.tasks[3]?.dependencies).toEqual(["VERIFY"]);
  });
});

describe("Phase 8-C IncidentService.remediate", () => {
  it("SRE-09: whitelist opens fix workflow via injected opener", async () => {
    const incident = baseIncident();
    const store = memoryStore(incident);
    const openFixWorkflow = vi.fn(async (_input: IncidentFixWorkflowOpenInput) => ({
      workflowRunId: "11111111-1111-4111-8111-111111111111",
      requirementId: "22222222-2222-4222-8222-222222222222",
      started: false
    }));
    const service = new IncidentService(store, undefined, { openFixWorkflow });
    const result = await service.remediate(incident.id);
    expect(result.remediation.decision).toBe("OPENED_STAGING_FIX_WORKFLOW");
    expect(result.remediation.whitelisted).toBe(true);
    expect(result.incident.status).toBe("mitigating");
    expect(result.incident.linkedWorkflowRunId).toBe("11111111-1111-4111-8111-111111111111");
    expect(openFixWorkflow).toHaveBeenCalledOnce();
    const arg = openFixWorkflow.mock.calls[0]![0];
    expect(arg.approvalTaskKeys).toEqual(["PRODUCTION"]);
    expect(arg.start).toBe(false);
    expect(arg.taskPlan.tasks.at(-1)?.delivery).toMatchObject({
      action: "DEPLOY",
      environment: "production"
    });
  });

  it("SRE-09: non-whitelist is notify-only and does not open a workflow", async () => {
    const incident = baseIncident({
      labels: { faultType: "arbitrary_production_shell" },
      fingerprint: "fp-non"
    });
    const store = memoryStore(incident);
    const openFixWorkflow = vi.fn();
    const service = new IncidentService(store, undefined, { openFixWorkflow });
    const result = await service.remediate(incident.id);
    expect(result.remediation.decision).toBe("NOTIFY_ONLY");
    expect(result.remediation.whitelisted).toBe(false);
    expect(result.incident.status).toBe("diagnosing");
    expect(result.incident.linkedWorkflowRunId).toBeUndefined();
    expect(openFixWorkflow).not.toHaveBeenCalled();
  });

  it("requires diagnosis before remediation", async () => {
    const incident = baseIncident();
    delete (incident as { diagnosis?: IncidentDiagnosis }).diagnosis;
    const store = memoryStore(incident);
    const service = new IncidentService(store, undefined, {
      openFixWorkflow: async () => {
        throw new Error("should not open");
      }
    });
    await expect(service.remediate(incident.id)).rejects.toMatchObject({
      code: "INCIDENT_DIAGNOSIS_REQUIRED"
    });
  });

  it("is idempotent after a workflow was opened", async () => {
    const workflowRunId = "33333333-3333-4333-8333-333333333333";
    const incident = baseIncident({
      status: "mitigating",
      linkedWorkflowRunId: workflowRunId,
      remediation: {
        decision: "OPENED_STAGING_FIX_WORKFLOW",
        faultType: "staging_verify_flaky",
        whitelisted: true,
        reason: "already",
        workflowRunId,
        decidedAt: "2026-11-04T05:01:00.000Z"
      }
    });
    const store = memoryStore(incident);
    const openFixWorkflow = vi.fn();
    const service = new IncidentService(store, undefined, { openFixWorkflow });
    const result = await service.remediate(incident.id);
    expect(result.remediation.workflowRunId).toBe(workflowRunId);
    expect(openFixWorkflow).not.toHaveBeenCalled();
  });
});

describe("Phase 8-D optional auto-remediate policy", () => {
  it("defaults to no auto-start when flag is off", () => {
    expect(
      resolveRemediationAutoStart({
        autoRemediateEnabled: false,
        faultType: "staging_verify_flaky"
      })
    ).toEqual({ start: false, autoStarted: false });
  });

  it("SRE-13: flag on + whitelist auto-starts; explicit false wins", () => {
    expect(isAutoRemediateFaultType("staging_verify_flaky")).toBe(true);
    expect(
      resolveRemediationAutoStart({
        autoRemediateEnabled: true,
        faultType: "staging_verify_flaky"
      })
    ).toEqual({ start: true, autoStarted: true });
    expect(
      resolveRemediationAutoStart({
        autoRemediateEnabled: true,
        faultType: "staging_verify_flaky",
        startWorkflow: false
      })
    ).toEqual({ start: false, autoStarted: false });
    expect(
      resolveRemediationAutoStart({
        autoRemediateEnabled: false,
        faultType: "staging_verify_flaky",
        startWorkflow: true
      })
    ).toEqual({ start: true, autoStarted: false });
  });

  it("SRE-15: non-whitelist never auto-starts even when flag is on", () => {
    expect(
      resolveRemediationAutoStart({
        autoRemediateEnabled: true,
        faultType: "arbitrary_production_shell"
      })
    ).toEqual({ start: false, autoStarted: false });
  });

  it("SRE-15: staging fix plan has no forbidden shell/secrets and keeps prod gate", () => {
    const plan = buildStagingFixTaskPlan(baseIncident());
    expect(findForbiddenRemediationPlanViolation(plan)).toBeNull();
    expect(plan.tasks.some((t) => /shell|secret/i.test(`${t.title} ${t.description}`))).toBe(
      false
    );
    expect(plan.tasks.at(-1)?.id).toBe("PRODUCTION");
    expect(plan.tasks.at(-1)?.delivery).toEqual({ action: "DEPLOY", environment: "production" });
  });
});

describe("Phase 8-D IncidentService.remediate auto-start", () => {
  it("SRE-13: autoRemediateEnabled starts whitelist workflow and records autoStarted", async () => {
    const incident = baseIncident();
    const store = memoryStore(incident);
    const openFixWorkflow = vi.fn(async (input: IncidentFixWorkflowOpenInput) => ({
      workflowRunId: "44444444-4444-4444-8444-444444444444",
      requirementId: "55555555-5555-4555-8555-555555555555",
      started: input.start
    }));
    const service = new IncidentService(store, undefined, {
      openFixWorkflow,
      autoRemediateEnabled: true
    });
    const result = await service.remediate(incident.id);
    expect(result.remediation.decision).toBe("OPENED_STAGING_FIX_WORKFLOW");
    expect(result.remediation.started).toBe(true);
    expect(result.remediation.autoStarted).toBe(true);
    expect(result.remediation.autoRemediateEnabled).toBe(true);
    expect(openFixWorkflow.mock.calls[0]![0].start).toBe(true);
    expect(openFixWorkflow.mock.calls[0]![0].approvalTaskKeys).toEqual(["PRODUCTION"]);
  });

  it("SRE-15: flag on still notify-only for non-whitelist (no workflow, no bypass)", async () => {
    const incident = baseIncident({
      labels: { faultType: "delete_production_db" },
      fingerprint: "fp-forbid"
    });
    const store = memoryStore(incident);
    const openFixWorkflow = vi.fn();
    const service = new IncidentService(store, undefined, {
      openFixWorkflow,
      autoRemediateEnabled: true
    });
    const result = await service.remediate(incident.id);
    expect(result.remediation.decision).toBe("NOTIFY_ONLY");
    expect(openFixWorkflow).not.toHaveBeenCalled();
  });

  it("explicit startWorkflow=false disables auto-start even when flag is on", async () => {
    const incident = baseIncident({ fingerprint: "fp-force-off" });
    const store = memoryStore(incident);
    const openFixWorkflow = vi.fn(async (input: IncidentFixWorkflowOpenInput) => ({
      workflowRunId: "66666666-6666-4666-8666-666666666666",
      requirementId: "77777777-7777-4777-8777-777777777777",
      started: input.start
    }));
    const service = new IncidentService(store, undefined, {
      openFixWorkflow,
      autoRemediateEnabled: true
    });
    const result = await service.remediate(incident.id, { startWorkflow: false });
    expect(result.remediation.started).toBe(false);
    expect(result.remediation.autoStarted).toBe(false);
    expect(openFixWorkflow.mock.calls[0]![0].start).toBe(false);
    expect(openFixWorkflow.mock.calls[0]![0].approvalTaskKeys).toEqual(["PRODUCTION"]);
  });
});

