import { createLogger } from "@ai-se/observability";
import type { AlertIngest, Incident } from "@ai-se/shared";
import { CreateProjectData, Project } from "@ai-se/shared";
import { ProjectRepository } from "@ai-se/database";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { AgentRunService } from "../services/agentRunService";
import { IncidentAgent } from "../services/incidentAgent";
import { IncidentEvidenceCollector } from "../services/incidentEvidenceCollector";
import { IncidentService, type IncidentStore } from "../services/incidentService";

function memoryProjects(): ProjectRepository {
  const projects = new Map<string, Project>();
  return {
    async create(input: CreateProjectData) {
      const now = new Date().toISOString();
      const project: Project = {
        id: randomUUID(),
        name: input.name,
        description: input.description,
        repository: input.repository ?? null,
        workspacePath: input.workspacePath ?? null,
        status: input.status,
        createdAt: now,
        updatedAt: now
      };
      projects.set(project.id, project);
      return project;
    },
    async findMany() {
      return Array.from(projects.values());
    },
    async findById(id: string) {
      return projects.get(id) ?? null;
    },
    async attachRepository(id: string, url: string) {
      const project = projects.get(id);
      if (!project) return null;
      const updated = { ...project, repository: url, updatedAt: new Date().toISOString() };
      projects.set(id, updated);
      return updated;
    },
    async updateWorkspacePath(id: string, workspacePath: string) {
      const project = projects.get(id);
      if (!project) return null;
      const updated: Project = {
        ...project,
        workspacePath,
        updatedAt: new Date().toISOString()
      };
      projects.set(id, updated);
      return updated;
    },
    async deleteById(id: string) {
      return projects.delete(id);
    }
  };
}

function memoryIncidents(): IncidentStore {
  const incidents = new Map<string, Incident>();
  const events: Array<{ incidentId: string; alert: AlertIngest }> = [];

  return {
    async findActiveByFingerprint(source, fingerprint) {
      for (const incident of incidents.values()) {
        if (
          incident.source === source &&
          incident.fingerprint === fingerprint &&
          (incident.status === "open" ||
            incident.status === "diagnosing" ||
            incident.status === "mitigating")
        ) {
          return incident;
        }
      }
      return null;
    },
    async create(input) {
      const now = new Date().toISOString();
      const incident: Incident = {
        id: randomUUID(),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        status: "open",
        source: input.source,
        fingerprint: input.fingerprint,
        severity: input.severity,
        title: input.title,
        ...(input.summary ? { summary: input.summary } : {}),
        labels: input.labels,
        raw: input.raw,
        openedAt: now,
        createdAt: now,
        updatedAt: now
      };
      for (const existing of incidents.values()) {
        if (
          existing.source === incident.source &&
          existing.fingerprint === incident.fingerprint &&
          (existing.status === "open" ||
            existing.status === "diagnosing" ||
            existing.status === "mitigating")
        ) {
          throw new Error("duplicate active fingerprint");
        }
      }
      incidents.set(incident.id, incident);
      return incident;
    },
    async appendAlertEvent(input) {
      events.push(input);
    },
    async findById(id) {
      return incidents.get(id) ?? null;
    },
    async findMany(query = {}) {
      let rows = Array.from(incidents.values());
      if (query.projectId) rows = rows.filter((row) => row.projectId === query.projectId);
      if (query.status) rows = rows.filter((row) => row.status === query.status);
      if (query.source) rows = rows.filter((row) => row.source === query.source);
      if (query.fingerprint) rows = rows.filter((row) => row.fingerprint === query.fingerprint);
      rows.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
      return rows.slice(0, query.limit ?? 50);
    },
    async saveDiagnosis(input) {
      const current = incidents.get(input.id);
      if (!current) throw new Error(`Incident not found: ${input.id}`);
      const updated: Incident = {
        ...current,
        status: input.status ?? "diagnosing",
        diagnosis: input.diagnosis,
        diagnosedAt: input.diagnosis.diagnosedAt,
        updatedAt: input.diagnosis.diagnosedAt
      };
      incidents.set(input.id, updated);
      return updated;
    },
    async saveRemediation(input) {
      const current = incidents.get(input.id);
      if (!current) throw new Error(`Incident not found: ${input.id}`);
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

function buildApp(opts: {
  alertIngestToken?: string;
  apiToken?: string;
  nodeEnv?: string;
  store?: IncidentStore;
  withDiagnosis?: boolean;
  openFixWorkflow?: (input: unknown) => Promise<{
    workflowRunId: string;
    requirementId: string;
    started: boolean;
  }>;
} = {}) {
  const store = opts.store ?? memoryIncidents();
  const diagnosis =
    opts.withDiagnosis === false
      ? undefined
      : {
          collector: new IncidentEvidenceCollector({
            metricsAggregate: async () => ({
              agentRuns: { succeeded: 4, failed: 1 },
              toolCalls: { succeeded: 8 },
              deployments: { SUCCESS: 2, FAILED: 1 },
              toolDurationMs: 10,
              toolDurationSamples: 2,
              workflowDurationMs: 20,
              workflowDurationSamples: 1
            }),
            listRecentDeployments: async () => [
              {
                id: randomUUID(),
                status: "FAILED",
                environment: "staging",
                version: "1.0.0",
                createdAt: new Date().toISOString()
              }
            ]
          }),
          agent: new IncidentAgent()
        };
  const remediation = opts.openFixWorkflow
    ? { openFixWorkflow: opts.openFixWorkflow }
    : {
        openFixWorkflow: async () => ({
          workflowRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          requirementId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          started: false
        })
      };
  return {
    store,
    app: createApp({
      logger: createLogger({ enabled: false }),
      projectRepository: memoryProjects(),
      agentRunService: {} as unknown as AgentRunService,
      incidentService: new IncidentService(store, diagnosis, remediation),
      checkDatabase: async () => undefined,
      checkRedis: async () => undefined,
      corsOrigin: "http://localhost:5173",
      apiToken: opts.apiToken,
      alertIngestToken: opts.alertIngestToken,
      nodeEnv: opts.nodeEnv ?? "development"
    })
  };
}

const sampleAlert = {
  source: "prometheus",
  fingerprint: "api-5xx",
  severity: "high" as const,
  title: "API 5xx spike",
  labels: { service: "api" },
  raw: { count: 3 }
};

describe("Phase 8-A incidents API", () => {
  it("SRE-01: creates once and deduplicates on fingerprint replay", async () => {
    const { app } = buildApp();
    const first = await request(app).post("/api/alerts").send(sampleAlert);
    expect(first.status).toBe(201);
    expect(first.body.success).toBe(true);
    expect(first.body.data.deduplicated).toBe(false);
    const id = first.body.data.incident.id as string;

    const second = await request(app).post("/api/alerts").send(sampleAlert);
    expect(second.status).toBe(200);
    expect(second.body.data.deduplicated).toBe(true);
    expect(second.body.data.incident.id).toBe(id);
  });

  it("SRE-02/03: incident fields and GET list/detail match store", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/alerts").send({
      ...sampleAlert,
      fingerprint: "disk-full",
      severity: "critical",
      summary: "root partition 95%"
    });
    const incident = created.body.data.incident;
    expect(incident).toMatchObject({
      status: "open",
      source: "prometheus",
      fingerprint: "disk-full",
      openedAt: expect.any(String)
    });
    expect(incident.linkedWorkflowRunId).toBeUndefined();

    const list = await request(app).get("/api/incidents");
    expect(list.status).toBe(200);
    expect(list.body.data.some((row: Incident) => row.id === incident.id)).toBe(true);

    const detail = await request(app).get(`/api/incidents/${incident.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.id).toBe(incident.id);
  });

  it("rejects invalid alert payloads", async () => {
    const { app } = buildApp();
    const bad = await request(app).post("/api/alerts").send({ source: "x" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requires ALERT_INGEST_TOKEN when configured", async () => {
    const { app } = buildApp({ alertIngestToken: "alert-secret" });
    const missing = await request(app).post("/api/alerts").send(sampleAlert);
    expect(missing.status).toBe(401);
    const ok = await request(app)
      .post("/api/alerts")
      .set("Authorization", "Bearer alert-secret")
      .send({ ...sampleAlert, fingerprint: "auth-ok" });
    expect(ok.status).toBe(201);
  });

  it("refuses naked ingest in production when no tokens configured", async () => {
    const { app } = buildApp({ nodeEnv: "production" });
    const res = await request(app).post("/api/alerts").send(sampleAlert);
    expect(res.status).toBe(401);
  });

  it("accepts ALERT_INGEST_TOKEN alone even when API_TOKEN differs", async () => {
    const { app } = buildApp({ apiToken: "api-secret", alertIngestToken: "alert-secret" });
    const withApi = await request(app)
      .post("/api/alerts")
      .set("Authorization", "Bearer api-secret")
      .send({ ...sampleAlert, fingerprint: "api-only" });
    expect(withApi.status).toBe(401);

    const withAlert = await request(app)
      .post("/api/alerts")
      .set("Authorization", "Bearer alert-secret")
      .send({ ...sampleAlert, fingerprint: "alert-only" });
    expect(withAlert.status).toBe(201);
  });
});

describe("Phase 8-B incidents diagnose API", () => {
  it("SRE-05/06: POST /incidents/:id/diagnose attaches multi-source diagnosis", async () => {
    const { app } = buildApp();
    const created = await request(app)
      .post("/api/alerts")
      .send({ ...sampleAlert, fingerprint: "diagnose-me", raw: { password: "secret-value" } });
    expect(created.status).toBe(201);
    const id = created.body.data.incident.id as string;

    const diagnosed = await request(app).post(`/api/incidents/${id}/diagnose`);
    expect(diagnosed.status).toBe(200);
    expect(diagnosed.body.success).toBe(true);
    const incident = diagnosed.body.data as Incident;
    expect(incident.status).toBe("diagnosing");
    expect(incident.diagnosis?.summary).toBeTruthy();
    expect(incident.diagnosis?.rootCauseHypothesis).toBeTruthy();
    expect(incident.diagnosis?.fixPlan).toBeTruthy();
    expect(incident.diagnosis?.risk).toBeTruthy();
    expect(incident.diagnosis?.recommendedAction).toBeTruthy();
    const kinds = new Set((incident.diagnosis?.evidence ?? []).map((row) => row.sourceKind));
    expect(kinds.size).toBeGreaterThanOrEqual(2);
    expect(kinds.has("metrics")).toBe(true);

    const detail = await request(app).get(`/api/incidents/${id}`);
    expect(detail.body.data.diagnosis?.agentName).toBe("incident-agent");
    // SRE-08：诊断载荷与证据摘录不得回灌明文；incident.raw 仍是入站原样（8-A 存证）。
    const diagnosisBlob = JSON.stringify(detail.body.data.diagnosis);
    expect(diagnosisBlob).not.toMatch(/secret-value/);
    expect(diagnosisBlob).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });

  it("returns 503 when diagnosis wiring is absent", async () => {
    const { app } = buildApp({ withDiagnosis: false });
    const created = await request(app)
      .post("/api/alerts")
      .send({ ...sampleAlert, fingerprint: "no-diag" });
    const id = created.body.data.incident.id as string;
    const res = await request(app).post(`/api/incidents/${id}/diagnose`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("INCIDENT_DIAGNOSIS_UNAVAILABLE");
  });
});

describe("Phase 8-C incidents remediate API", () => {
  it("SRE-09: whitelist opens workflow; non-whitelist notify-only", async () => {
    const projectId = randomUUID();
    const { app } = buildApp();

    const created = await request(app)
      .post("/api/alerts")
      .send({
        source: "prometheus",
        fingerprint: "remediate-whitelist",
        severity: "high",
        title: "flake",
        projectId,
        labels: { faultType: "staging_verify_flaky" }
      })
      .expect(201);
    const id = created.body.data.incident.id as string;

    await request(app).post(`/api/incidents/${id}/diagnose`).expect(200);

    const opened = await request(app)
      .post(`/api/incidents/${id}/remediate`)
      .send({})
      .expect(200);
    expect(opened.body.data.remediation.decision).toBe("OPENED_STAGING_FIX_WORKFLOW");
    expect(opened.body.data.incident.status).toBe("mitigating");
    expect(opened.body.data.incident.linkedWorkflowRunId).toBeTruthy();

    const other = await request(app)
      .post("/api/alerts")
      .send({
        source: "prometheus",
        fingerprint: "remediate-deny",
        severity: "high",
        title: "shell",
        projectId,
        labels: { faultType: "arbitrary_production_shell" }
      })
      .expect(201);
    const otherId = other.body.data.incident.id as string;
    await request(app).post(`/api/incidents/${otherId}/diagnose`).expect(200);
    const denied = await request(app)
      .post(`/api/incidents/${otherId}/remediate`)
      .send({})
      .expect(200);
    expect(denied.body.data.remediation.decision).toBe("NOTIFY_ONLY");
    expect(denied.body.data.incident.linkedWorkflowRunId).toBeUndefined();
  });
});
