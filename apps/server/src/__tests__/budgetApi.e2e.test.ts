import {
  PgAgentRunStore,
  PgPlanningRepository,
  PgProjectRepository,
  PgToolCallStore,
  PgWorkflowEventStore,
  PgWorkflowRepository,
  createPool,
  runMigrations
} from "@ai-se/database";
import { createLogger } from "@ai-se/observability";
import { createTodoPlanningFixtures, ScriptedPlanningModel } from "@ai-se/agent-core";
import { WorkflowDetailView, WorkflowRun } from "@ai-se/shared";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../app";
import { AgentRunService } from "../services/agentRunService";
import { MemoryCancellationStore } from "../services/cancellationStore";
import { PlanningService } from "../services/planningService";
import { WorkflowService } from "../services/workflowService";

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres(): Promise<{ pool: Pool; stop: () => Promise<void> }> {
  const name = `ai-se-budget-postgres-test-${randomUUID()}`;

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

  const portLine = await docker(["port", name, "5432/tcp"]);
  const port = portLine.split(":").at(-1);
  if (!port) {
    throw new Error("Cannot resolve PostgreSQL test container port");
  }

  const pool = createPool(`postgres://aise@127.0.0.1:${port}/aise`);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return {
        pool,
        stop: async () => {
          await pool.end();
          await docker(["rm", "-f", name]);
        }
      };
    } catch {
      await sleep(500);
    }
  }

  const logs = await docker(["logs", name]);
  await pool.end();
  await docker(["rm", "-f", name]);
  throw new Error(`PostgreSQL test container did not become ready: ${logs}`);
}

async function waitFor<T>(fn: () => Promise<T | null>, attempts = 120): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await fn();
    if (value !== null) {
      return value;
    }
    await sleep(500);
  }
  throw new Error("waitFor timed out");
}

describe("Workflow Budget E2E（T6：预算超限暂停 → PATCH 放宽 → 恢复）", () => {
  let pool: Pool;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await runMigrations(pool);
  }, 180_000);

  afterAll(async () => {
    await stop?.();
  });

  it("pauses on BUDGET_EXCEEDED, resumes after the limit is raised, and re-runs no task", async () => {
    const logger = createLogger({ enabled: false });
    const projectRepository = new PgProjectRepository(pool);
    const cancellationStore = new MemoryCancellationStore();
    const workflowRepository = new PgWorkflowRepository(pool);
    const agentRunService = new AgentRunService({
      agentRuns: new PgAgentRunStore(pool),
      toolCalls: new PgToolCallStore(pool),
      workflowEvents: new PgWorkflowEventStore(pool),
      projects: projectRepository,
      cancellationStore,
      logger
    });

    // 最小任务图：不含交付链（审批与交付由既有套件覆盖）。
    const fixtures = createTodoPlanningFixtures();
    fixtures.task_planning = {
      summary: "预算冒烟最小任务图",
      tasks: [
        {
          id: "TASK-001",
          title: "实现功能",
          description: "实现被预算约束的功能。",
          type: "BACKEND",
          priority: "HIGH",
          dependencies: [],
          estimatedComplexity: 1,
          acceptanceCriteria: ["功能可用。"],
          sourceSpecTypes: ["FUNCTIONAL"]
        },
        {
          id: "TASK-002",
          title: "功能测试",
          description: "覆盖功能行为。",
          type: "TEST",
          priority: "MEDIUM",
          dependencies: ["TASK-001"],
          estimatedComplexity: 1,
          acceptanceCriteria: ["测试通过。"],
          sourceSpecTypes: ["FUNCTIONAL"]
        }
      ]
    };

    const planningService = new PlanningService({
      planning: new PgPlanningRepository(pool),
      agentRuns: new PgAgentRunStore(pool),
      workflowEvents: new PgWorkflowEventStore(pool),
      projects: projectRepository,
      cancellationStore,
      notifyRunChanged: (agentRunId) => agentRunService.notifyRunChanged(agentRunId),
      // T6 冒烟走旧一次性路径（预算与规划模式解耦）。
      mode: "single",
      model: new ScriptedPlanningModel(fixtures),
      logger
    });

    const executed: string[] = [];
    const workflowService = new WorkflowService({
      workflows: workflowRepository,
      projects: projectRepository,
      executor: {
        execute: async (_workflow, task) => {
          executed.push(task.taskKey);
          return { status: "succeeded" as const, output: { summary: "budget stub" } };
        },
        cancel: async () => undefined
      }
    });

    const app = createApp({
      logger,
      projectRepository,
      agentRunService,
      planningService,
      workflowService,
      checkDatabase: async () => {
        await pool.query("SELECT 1");
      },
      checkRedis: async () => undefined,
      corsOrigin: "http://localhost:5173"
    });

    const project = await request(app)
      .post("/api/projects")
      .send({
        name: "Budget Smoke",
        description: "T6 预算冒烟",
        repository: `https://github.com/example/${randomUUID()}`
      })
      .expect(201);
    const projectId = project.body.data.id as string;

    const created = await request(app)
      .post(`/api/projects/${projectId}/requirements`)
      .send({
        title: "预算冒烟需求",
        description: "T6 budget",
        rawContent: "验证工作流级预算上限：超限暂停、调整恢复。"
      })
      .expect(201);
    const requirementId = created.body.data.id as string;

    await request(app).post(`/api/requirements/${requirementId}/analyze`).send({}).expect(202);
    await waitFor(async () => {
      const response = await request(app).get(`/api/requirements/${requirementId}`).expect(200);
      return response.body.data.status === "ANALYZED" ? true : null;
    });

    const workspace = await mkdtemp(join(tmpdir(), "budget-e2e-ws-"));
    const basePolicy = {
      maxConcurrency: 1,
      maxRetries: 0,
      failureStrategy: "FAIL_FAST" as const,
      allowRetry: false,
      allowReplan: false,
      approvalRequired: false
    };

    // ① 极小 wallClock 预算 → claim 前暂停（BUDGET_EXCEEDED）
    const limited = await request(app)
      .post("/api/workflows")
      .send({
        projectId,
        requirementId,
        workspacePath: workspace,
        policy: { ...basePolicy, maxWallClockMs: 1 }
      })
      .expect(201);
    const limitedId = limited.body.data.id as string;
    expect((limited.body.data as WorkflowRun).policy.maxWallClockMs).toBe(1);
    await request(app).post(`/api/workflows/${limitedId}/start`).expect(200);

    const paused = await waitFor(async () => {
      const detail = (await request(app).get(`/api/workflows/${limitedId}`).expect(200)).body
        .data as WorkflowDetailView;
      return detail.workflow.status === "PAUSED" ? detail : null;
    });
    expect(paused.workflow.error?.code).toBe("BUDGET_EXCEEDED");
    const budgetEvents = (paused.events ?? []).filter(
      (event) => event.eventType === "WORKFLOW_PAUSED"
    );
    expect(budgetEvents.length).toBeGreaterThan(0);
    expect(budgetEvents.at(-1)?.payload.reason).toBe("BUDGET_EXCEEDED");

    // ② PATCH 放宽预算 → 既有 resume 恢复 → 完成；已完成任务不重跑
    const executedBeforeResume = [...executed];
    const patched = await request(app)
      .patch(`/api/workflows/${limitedId}/policy`)
      .send({ maxWallClockMs: 600_000 })
      .expect(200);
    expect((patched.body.data as WorkflowRun).policy.maxWallClockMs).toBe(600_000);

    await request(app).post(`/api/workflows/${limitedId}/resume`).expect(200);
    const finished = await waitFor(async () => {
      const detail = (await request(app).get(`/api/workflows/${limitedId}`).expect(200)).body
        .data as WorkflowDetailView;
      return detail.workflow.status === "SUCCESS" ? detail : null;
    });
    expect(finished.tasks.every((task) => task.status === "SUCCESS")).toBe(true);
    // 每次任务只执行一次（暂停前已完成的任务不因恢复重跑）
    expect(new Set(executed).size).toBe(executed.length);
    expect(
      executedBeforeResume.every((key) => executed.filter((e) => e === key).length === 1)
    ).toBe(true);

    // ③ 终态工作流不可调整预算
    await request(app)
      .patch(`/api/workflows/${limitedId}/policy`)
      .send({ maxWallClockMs: 1 })
      .expect(409);

    // ④ 未设限工作流零干预（无预算事件、无暂停）
    const plain = await request(app)
      .post("/api/workflows")
      .send({ projectId, requirementId, workspacePath: workspace, policy: basePolicy })
      .expect(201);
    const plainId = plain.body.data.id as string;
    await request(app).post(`/api/workflows/${plainId}/start`).expect(200);
    const plainDone = await waitFor(async () => {
      const detail = (await request(app).get(`/api/workflows/${plainId}`).expect(200)).body
        .data as WorkflowDetailView;
      return detail.workflow.status === "SUCCESS" ? detail : null;
    });
    expect(
      (plainDone.events ?? []).some(
        (event) =>
          event.eventType === "WORKFLOW_BUDGET_WARNING" ||
          (event.eventType === "WORKFLOW_PAUSED" && event.payload.reason === "BUDGET_EXCEEDED")
      )
    ).toBe(false);
  }, 240_000);
});
