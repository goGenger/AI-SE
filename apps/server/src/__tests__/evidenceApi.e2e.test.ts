import { buildEvidenceDraft } from "@ai-se/evidence";
import {
  createPool,
  PgAgentRunStore,
  PgEvidenceRepository,
  PgProjectRepository,
  PgToolCallStore,
  PgWorkflowEventStore,
  runMigrations
} from "@ai-se/database";
import { createLogger } from "@ai-se/observability";
import type { EvidenceRecordDraft } from "@ai-se/shared";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { AgentRunService } from "../services/agentRunService";
import { MemoryCancellationStore } from "../services/cancellationStore";
import { EvidenceService } from "../services/evidenceService";

/**
 * Phase 5.7-4 evidence API E2E (real PostgreSQL):
 * list / detail + project-scope denial (cross-project read → 403, zero
 * leakage), 404/400 paths, and credential-free responses — seeded through the
 * REAL evidence builder (redaction + strict contract), served by the real
 * PgEvidenceRepository through createApp.
 */

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

const CREDENTIAL = "sk-live1234567890abcdefghij";

function makeDraft(input: {
  projectId: string;
  workflowRunId?: string;
  taskId?: string;
  externalId?: string;
  credential?: boolean;
}): EvidenceRecordDraft {
  const actionRef = {
    source: "browser" as const,
    sessionId: "browser:api:1",
    toolName: "browser.action.click",
    target: "#go"
  };
  return buildEvidenceDraft({
    identity: {
      projectId: input.projectId,
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      toolCallId: `call-${randomUUID().slice(0, 8)}`,
      actionRef
    },
    expectations: [{ kind: "action-succeeded" }, { kind: "changed" }],
    before: {
      observation: {
        observationId: "obs-before",
        actionRef,
        dom: { nodes: [{ ref: "r1", role: "generic", name: "0", clickable: false, text: "0" }] },
        takenAt: "2026-09-13T10:00:00.000Z"
      },
      capturedAt: "2026-09-13T10:00:00.000Z"
    },
    after: {
      observation: {
        observationId: "obs-after",
        actionRef,
        dom: { nodes: [{ ref: "r1", role: "generic", name: "1", clickable: false, text: "1" }] },
        takenAt: "2026-09-13T10:00:01.000Z"
      },
      ...(input.credential ? { result: { note: `use ${CREDENTIAL} to continue` } } : {}),
      capturedAt: "2026-09-13T10:00:01.000Z"
    },
    result: {
      resultId: "res-1",
      actionRef,
      status: "success",
      durationMs: 4,
      occurredAt: "2026-09-13T10:00:01.000Z"
    },
    screenshotRef: "screenshot://browser:api:1/2.png",
    ...(input.externalId ? { externalId: input.externalId } : {})
  });
}

describe("5.7-4 evidence API (real PostgreSQL)", () => {
  let pool: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createApp>;
  let repository: PgEvidenceRepository;
  let containerName = "";
  let projectA = "";
  let projectB = "";
  let workflowRunA = "";
  let taskA = "";
  let recordPlain = "";
  let recordScoped = "";
  let recordCredential = "";

  beforeAll(async () => {
    const name = `ai-se-evidence-api-${randomUUID()}`;
    containerName = name;
    await docker([
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "-e",
      "POSTGRES_USER=aise",
      "-e",
      "POSTGRES_DB=aise",
      "-p",
      "127.0.0.1::5432",
      "--tmpfs",
      "/var/lib/postgresql/data",
      "postgres:16-alpine"
    ]);
    const port = (await docker(["port", name, "5432/tcp"])).split(":").at(-1);
    if (!port) throw new Error("Cannot resolve PostgreSQL test port");
    pool = createPool(`postgres://aise@127.0.0.1:${port}/aise`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await pool.query("SELECT 1");
        break;
      } catch {
        await sleep(500);
      }
    }
    await runMigrations(pool);

    const projects = new PgProjectRepository(pool);
    projectA = (
      await projects.create({
        name: "Evidence API A",
        description: "Phase 5.7-4",
        repository: "https://local.test/evidence-api-a",
        status: "active"
      })
    ).id;
    projectB = (
      await projects.create({
        name: "Evidence API B",
        description: "Phase 5.7-4",
        repository: "https://local.test/evidence-api-b",
        status: "active"
      })
    ).id;

    const requirementId = await pool
      .query<{
        id: string;
      }>(
        `INSERT INTO requirements (project_id, title, raw_content) VALUES ($1, 'Evidence API run', 'raw') RETURNING id`,
        [projectA]
      )
      .then((result) => result.rows[0]!.id);
    workflowRunA = await pool
      .query<{
        id: string;
      }>(
        `INSERT INTO workflow_runs (project_id, requirement_id, planning_version, status) VALUES ($1, $2, 1, 'RUNNING') RETURNING id`,
        [projectA, requirementId]
      )
      .then((result) => result.rows[0]!.id);
    taskA = await pool
      .query<{
        id: string;
      }>(
        `INSERT INTO tasks (project_id, requirement_id, task_key, title, type) VALUES ($1, $2, 'EVIDENCE_TASK', 'Evidence task', 'TEST') RETURNING id`,
        [projectA, requirementId]
      )
      .then((result) => result.rows[0]!.id);

    repository = new PgEvidenceRepository(pool);
    recordPlain = (await repository.create(makeDraft({ projectId: projectA }))).id;
    recordScoped = (
      await repository.create(
        makeDraft({ projectId: projectA, workflowRunId: workflowRunA, taskId: taskA })
      )
    ).id;
    recordCredential = (
      await repository.create(
        makeDraft({ projectId: projectA, credential: true, externalId: "ISS-201" })
      )
    ).id;
    await repository.create(makeDraft({ projectId: projectB }));

    const logger = createLogger({ enabled: false });
    const agentRuns = new PgAgentRunStore(pool);
    const toolCalls = new PgToolCallStore(pool);
    const workflowEvents = new PgWorkflowEventStore(pool);
    const agentRunService = new AgentRunService({
      agentRuns,
      toolCalls,
      workflowEvents,
      projects,
      cancellationStore: new MemoryCancellationStore(),
      logger
    });
    app = createApp({
      logger,
      projectRepository: projects,
      agentRunService,
      evidenceService: new EvidenceService(repository),
      checkDatabase: async () => {
        await pool.query("SELECT 1");
      },
      checkRedis: async () => undefined,
      corsOrigin: "*"
    });
  }, 240_000);

  afterAll(async () => {
    await pool.end();
    await docker(["rm", "-f", containerName]).catch(() => undefined);
  });

  it("lists evidence per project and filters by workflowRun/task/limit", async () => {
    const all = await request(app).get(`/api/evidence?projectId=${projectA}`).expect(200);
    expect(all.body.success).toBe(true);
    expect(all.body.data.map((record: { id: string }) => record.id).sort()).toEqual(
      [recordPlain, recordScoped, recordCredential].sort()
    );

    const byWorkflow = await request(app)
      .get(`/api/evidence?workflowRunId=${workflowRunA}`)
      .expect(200);
    expect(byWorkflow.body.data.map((record: { id: string }) => record.id)).toEqual([recordScoped]);

    const byTask = await request(app).get(`/api/evidence?taskId=${taskA}`).expect(200);
    expect(byTask.body.data.map((record: { id: string }) => record.id)).toEqual([recordScoped]);

    const limited = await request(app)
      .get(`/api/evidence?projectId=${projectA}&limit=1`)
      .expect(200);
    expect(limited.body.data).toHaveLength(1);

    await request(app).get("/api/evidence?projectId=not-a-uuid").expect(400);
  });

  it("returns the full evidence detail", async () => {
    const detail = await request(app).get(`/api/evidence/${recordScoped}`).expect(200);
    const record = detail.body.data;
    expect(record.workflowRunId).toBe(workflowRunA);
    expect(record.taskId).toBe(taskA);
    expect(record.before.observation.observationId).toBe("obs-before");
    expect(record.after.observation.observationId).toBe("obs-after");
    expect(record.result.status).toBe("success");
    expect(record.verification.status).toBe("VERIFIED");
    expect(record.screenshotRef).toBe("screenshot://browser:api:1/2.png");
    expect(record.externalId).toBeUndefined();
  });

  it("denies cross-project reads with 403 and zero payload leakage", async () => {
    const denied = await request(app)
      .get(`/api/evidence/${recordPlain}?projectId=${projectB}`)
      .expect(403);
    expect(denied.body.success).toBe(false);
    expect(denied.body.error.code).toBe("EVIDENCE_ACCESS_DENIED");
    expect(JSON.stringify(denied.body)).not.toContain("obs-before");

    const scopedOk = await request(app)
      .get(`/api/evidence/${recordPlain}?projectId=${projectA}`)
      .expect(200);
    expect(scopedOk.body.data.id).toBe(recordPlain);
  });

  it("404s unknown evidence and 400s malformed ids", async () => {
    const missing = await request(app).get(`/api/evidence/${randomUUID()}`).expect(404);
    expect(missing.body.error.code).toBe("EVIDENCE_NOT_FOUND");
    await request(app).get("/api/evidence/not-a-uuid").expect(400);
  });

  it("serves credential-bearing evidence already redacted", async () => {
    const detail = await request(app).get(`/api/evidence/${recordCredential}`).expect(200);
    const serialized = JSON.stringify(detail.body);
    expect(serialized).not.toContain(CREDENTIAL);
    expect(serialized).toContain("[REDACTED]");
    expect(detail.body.data.externalId).toBe("ISS-201");
  });
});
