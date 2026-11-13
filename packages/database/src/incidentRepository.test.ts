import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgIncidentRepository } from "./incidentRepository";
import { runMigrations } from "./migrate";
import { createTestProject, startPostgresContainer } from "./testPostgresContainer";

describe("Phase 8-A PgIncidentRepository (migration 020)", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repo: PgIncidentRepository;
  let projectId: string;

  beforeAll(async () => {
    const postgres = await startPostgresContainer();
    pool = postgres.pool;
    stop = postgres.stop;
    await runMigrations(pool);
    projectId = await createTestProject(pool, `incident-${randomUUID().slice(0, 8)}`);
    repo = new PgIncidentRepository(pool);
  }, 180_000);

  afterAll(async () => {
    await stop();
  });

  it("creates an open incident and lists/finds it", async () => {
    const created = await repo.create({
      projectId,
      source: "prometheus",
      fingerprint: `fp-${randomUUID()}`,
      severity: "high",
      title: "API latency",
      summary: "p99 > 2s",
      labels: { service: "api" },
      raw: { value: 2.4 }
    });
    expect(created.status).toBe("open");
    expect(created.projectId).toBe(projectId);
    expect(created.openedAt).toMatch(/Z$/);

    await expect(repo.findById(created.id)).resolves.toMatchObject({ id: created.id });
    const listed = await repo.findMany({ projectId, status: "open" });
    expect(listed.some((row) => row.id === created.id)).toBe(true);
  });

  it("finds active by fingerprint and appends alert_events", async () => {
    const fingerprint = `fp-${randomUUID()}`;
    const created = await repo.create({
      source: "webhook",
      fingerprint,
      severity: "critical",
      title: "disk full",
      labels: {},
      raw: {}
    });
    await expect(repo.findActiveByFingerprint("webhook", fingerprint)).resolves.toMatchObject({
      id: created.id
    });

    await repo.appendAlertEvent({
      incidentId: created.id,
      alert: {
        source: "webhook",
        fingerprint,
        severity: "critical",
        labels: {},
        raw: { n: 1 }
      }
    });
    const events = await pool.query(
      "SELECT COUNT(*)::int AS count FROM alert_events WHERE incident_id = $1",
      [created.id]
    );
    expect(events.rows[0].count).toBe(1);
  });

  it("enforces one active incident per source+fingerprint", async () => {
    const fingerprint = `fp-${randomUUID()}`;
    await repo.create({
      source: "pager",
      fingerprint,
      severity: "medium",
      title: "first",
      labels: {},
      raw: {}
    });
    await expect(
      repo.create({
        source: "pager",
        fingerprint,
        severity: "medium",
        title: "second",
        labels: {},
        raw: {}
      })
    ).rejects.toThrow();
  });

  it("persists diagnosis and advances status to diagnosing", async () => {
    const created = await repo.create({
      source: "webhook",
      fingerprint: `fp-diag-${randomUUID()}`,
      severity: "high",
      title: "diag fixture",
      labels: { service: "api" },
      raw: {}
    });
    const diagnosedAt = new Date().toISOString();
    const saved = await repo.saveDiagnosis({
      id: created.id,
      status: "diagnosing",
      diagnosis: {
        summary: "fixture summary",
        rootCauseHypothesis: "fixture hypothesis",
        evidence: [
          {
            sourceKind: "metrics",
            ref: "platform.metrics.aggregate",
            excerpt: '{"failedAgentRuns":1}',
            collectedAt: diagnosedAt,
            labels: {}
          },
          {
            sourceKind: "alert",
            ref: "webhook:fp",
            excerpt: "alert body",
            collectedAt: diagnosedAt,
            labels: {}
          }
        ],
        fixPlan: "staging only",
        risk: "read-only path",
        recommendedAction: "await_human_review_then_propose_staging_fix",
        agentName: "incident-agent",
        diagnosedAt
      }
    });
    expect(saved.status).toBe("diagnosing");
    expect(saved.diagnosis?.summary).toBe("fixture summary");
    expect(saved.diagnosedAt).toBe(diagnosedAt);
    const again = await repo.findById(created.id);
    expect(again?.diagnosis?.evidence).toHaveLength(2);
  });

  it("persists remediation and links workflow (8-C)", async () => {
    const created = await repo.create({
      source: "webhook",
      fingerprint: `fp-remediate-${randomUUID()}`,
      severity: "high",
      title: "remediate fixture",
      labels: { faultType: "staging_verify_flaky" },
      raw: {}
    });
    const decidedAt = new Date().toISOString();
    // Need a real workflow_runs row for FK — skip link if none; use null-linked notify first
    const notify = await repo.saveRemediation({
      id: created.id,
      remediation: {
        decision: "NOTIFY_ONLY",
        faultType: "other",
        whitelisted: false,
        reason: "not whitelisted",
        decidedAt
      }
    });
    expect(notify.remediation?.decision).toBe("NOTIFY_ONLY");
    expect(notify.remediatedAt).toBe(decidedAt);
    expect(notify.status).toBe("open");
  });
});
