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
import {
  AgentRunDetailView,
  RequirementSlicesView,
  RequirementTasksView,
  Specification
} from "@ai-se/shared";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres(): Promise<{ pool: Pool; stop: () => Promise<void> }> {
  const name = `ai-se-planning-api-postgres-test-${randomUUID()}`;

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

describe("Planning API E2E", () => {
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

  it("creates a requirement, analyzes it, and exposes specifications and task DAG", async () => {
    const logger = createLogger({ enabled: false });
    const projectRepository = new PgProjectRepository(pool);
    const cancellationStore = new MemoryCancellationStore();
    const agentRunService = new AgentRunService({
      agentRuns: new PgAgentRunStore(pool),
      toolCalls: new PgToolCallStore(pool),
      workflowEvents: new PgWorkflowEventStore(pool),
      projects: projectRepository,
      cancellationStore,
      logger
    });
    const workflowRepository = new PgWorkflowRepository(pool);
    // F1-1：第一级已落盘 N3 库记录（分析提取，AC-01…）→ 切片计划必须携带 acKeys，
    // 否则规划期以 PLAN_ACKEYS_MISSING 拦截。为脚本模型补足合规形状，验证正常通过。
    // F1-3：本需求为两级规划（SLICE-1/2），SLICE-1 非最终切片 → 计划不得含交付链任务
    // （原 Todo 夹具 TASK-007..010 属交付链，交付链由最终切片承担）——从切片计划中移除。
    const fixtures = createTodoPlanningFixtures();
    // 产品默认 frontend-vue：剔除交付链与不可规划的 BACKEND/DATABASE，补 acKeys + 测试先行。
    fixtures.task_planning.tasks = [
      {
        id: "TASK-001",
        title: "编写前端验收测试",
        description: "按 AC 写红灯测试。",
        type: "TEST",
        priority: "HIGH",
        dependencies: [],
        estimatedComplexity: 2,
        acceptanceCriteria: ["测试覆盖关键 AC。"],
        acKeys: ["AC-01", "AC-02", "AC-03", "AC-04"],
        sourceSpecTypes: ["FUNCTIONAL", "UI"]
      },
      {
        id: "TASK-002",
        title: "实现 Todo 控制台",
        description: "按切片实现前端页面与状态。",
        type: "FRONTEND",
        priority: "HIGH",
        dependencies: ["TASK-001"],
        estimatedComplexity: 4,
        acceptanceCriteria: ["Todo UI 可用。"],
        acKeys: ["AC-01", "AC-02", "AC-03", "AC-04"],
        sourceSpecTypes: ["UI", "FUNCTIONAL", "TECHNICAL"]
      }
    ];
    const planningService = new PlanningService({
      planning: new PgPlanningRepository(pool),
      agentRuns: new PgAgentRunStore(pool),
      workflowEvents: new PgWorkflowEventStore(pool),
      projects: projectRepository,
      cancellationStore,
      notifyRunChanged: (agentRunId) => agentRunService.notifyRunChanged(agentRunId),
      // N2：两级规划（默认模式）+ 关口 1 审批读写（approvals 同表方法）。
      approvals: workflowRepository,
      model: new ScriptedPlanningModel(fixtures),
      logger
    });
    const workflowService = new WorkflowService({
      workflows: workflowRepository,
      projects: projectRepository,
      executor: {
        execute: async () => ({
          status: "succeeded" as const,
          output: { summary: "planning-api stub" }
        }),
        cancel: async () => undefined
      },
      sliceHooks: {
        onSliceApprovalDecided: async (approval) => {
          await planningService.handleSliceApprovalDecided(approval);
        }
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
        name: "Planning API",
        description: "Phase 3",
        repository: `https://github.com/example/${randomUUID()}`
      })
      .expect(201);
    const projectId = project.body.data.id as string;

    const createdRequirement = await request(app)
      .post(`/api/projects/${projectId}/requirements`)
      .send({
        title: "Todo 管理系统",
        description: "Phase 3 sample",
        rawContent: "创建一个简单的 Todo 管理系统，支持用户创建、查看、修改和删除 Todo。"
      })
      .expect(201);
    const requirementId = createdRequirement.body.data.id as string;

    await request(app)
      .get(`/api/projects/${projectId}/requirements`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data).toHaveLength(1);
      });

    const analyze = await request(app)
      .post(`/api/requirements/${requirementId}/analyze`)
      .send({})
      .expect(202);
    const agentRunId = analyze.body.data.agentRunId as string;
    expect(analyze.body.data.accepted).toBe(true);

    let detail: AgentRunDetailView | null = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request(app).get(`/api/agent-runs/${agentRunId}`).expect(200);
      detail = response.body.data as AgentRunDetailView;
      if (terminalStatuses.has(detail.run.status)) {
        break;
      }
      await sleep(500);
    }

    expect(detail?.run.status).toBe("succeeded");
    expect(detail?.events.some((event) => event.eventType === "PLANNING_COMPLETED")).toBe(true);

    // N2 两级规划：第一级后进入关口 1（PLANNING_REVIEW + 待确认审批）。
    await request(app)
      .get(`/api/requirements/${requirementId}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.status).toBe("PLANNING_REVIEW");
      });

    const slicesResponse = await request(app)
      .get(`/api/requirements/${requirementId}/slices`)
      .expect(200);
    const slicesView = slicesResponse.body.data as RequirementSlicesView;
    expect(slicesView.slices.map((slice) => slice.sliceKey)).toEqual(["SLICE-1", "SLICE-2"]);
    expect(slicesView.approval?.status).toBe("PENDING");

    // 关口 1：批准 → 第二级规划切片 1 → requirement ANALYZED。
    await request(app)
      .post(`/api/approvals/${slicesView.approval!.id}/approve`)
      .send({})
      .expect(200);

    let analyzed = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request(app).get(`/api/requirements/${requirementId}`).expect(200);
      if (response.body.data.status === "ANALYZED") {
        analyzed = true;
        break;
      }
      await sleep(500);
    }
    expect(analyzed).toBe(true);

    const afterApproval = await request(app)
      .get(`/api/requirements/${requirementId}/slices`)
      .expect(200);
    expect(
      (afterApproval.body.data as RequirementSlicesView).slices.map(
        (slice) => `${slice.sliceKey}:${slice.status}`
      )
    ).toEqual(["SLICE-1:PLANNED", "SLICE-2:PENDING"]);

    await request(app)
      .get(`/api/requirements/${requirementId}/specifications`)
      .expect(200)
      .expect((response) => {
        const specifications = response.body.data as Specification[];
        expect(specifications).toHaveLength(7);
        expect(specifications.some((specification) => specification.type === "API")).toBe(true);
      });

    const taskResponse = await request(app)
      .get(`/api/requirements/${requirementId}/tasks`)
      .expect(200);
    const taskGraph = taskResponse.body.data as RequirementTasksView;
    expect(taskGraph.tasks.map((task) => task.taskKey)).toContain("TASK-001");
    expect(taskGraph.tasks.every((task) => task.sliceKey === "SLICE-1")).toBe(true);
    expect(taskGraph.dependencies.length).toBeGreaterThan(0);

    const taskId = taskGraph.tasks[0].id;
    await request(app).get(`/api/tasks/${taskId}`).expect(200);
    await request(app).get(`/api/tasks/${taskId}/dependencies`).expect(200);

    await request(app)
      .post(`/api/requirements/${requirementId}/analyze`)
      .send({})
      .expect(200)
      .expect((response) => {
        expect(response.body.data.accepted).toBe(false);
      });
  }, 180_000);
});
