import {
  PgAgentRunStore,
  PgDeploymentRepository,
  PgPlanningRepository,
  PgProjectRepository,
  PgToolCallStore,
  PgWorkflowEventStore,
  PgWorkflowRepository,
  createPool,
  runMigrations
} from "@ai-se/database";
import { createLogger } from "@ai-se/observability";
import {
  createTodoPlanningFixtures,
  PlanningModelRequest,
  ScriptedPlanningModel
} from "@ai-se/agent-core";
import { JsonObject, RequirementSlicesView } from "@ai-se/shared";
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

/**
 * F1-3 / FX-11 集成：切片规划确定性修复耗尽 → 升级人工关口（复用需求级审批）→ 单独重试该切片。
 * 场景：切片 1 正常规划与执行（stub 成功）；切片 2 的规划三轮均成环不可自动修复 →
 * SLICE_PLANNING_ESCALATED + 审批 PENDING + 切片复位 PENDING；批准后仅重试切片 2 并成功。
 */

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres(): Promise<{ pool: Pool; stop: () => Promise<void> }> {
  const name = `ai-se-planning-escalation-postgres-test-${randomUUID()}`;

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

async function waitFor<T>(
  fn: () => Promise<T | null>,
  attempts = 120,
  intervalMs = 500
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await fn();
    if (value !== null) {
      return value;
    }
    await sleep(intervalMs);
  }
  throw new Error("waitFor timed out");
}

const ALL_AC = ["AC-01", "AC-02", "AC-03", "AC-04"];

const goodPlan = {
  summary: "切片最小任务图（测试先行）",
  tasks: [
    {
      id: "TASK-001",
      title: "写 AC 测试",
      description: "为 AC-01..AC-04 先写测试。",
      type: "TEST",
      priority: "HIGH",
      dependencies: [] as string[],
      estimatedComplexity: 2,
      acceptanceCriteria: ["AC-01..AC-04 测试就绪。"],
      acKeys: ALL_AC,
      sourceSpecTypes: ["FUNCTIONAL"]
    },
    {
      id: "TASK-002",
      title: "实现切片逻辑",
      description: "按切片范围实现功能。",
      type: "BACKEND",
      priority: "HIGH",
      dependencies: ["TASK-001"],
      estimatedComplexity: 2,
      acceptanceCriteria: ["切片逻辑可用。"],
      acKeys: ALL_AC,
      sourceSpecTypes: ["FUNCTIONAL", "TECHNICAL"]
    }
  ]
};

/**
 * 测试任务经 BUILD 反向依赖实现任务：补边会成环 → 自动修复层不修，LLM 三轮无法收敛。
 *
 * N-46（`docs/232` §9.10）：中间的 BUILD 任务让环上**没有**「测试依赖实现」的倒置边，
 * 用例才仍然落在「修复耗尽 → 升级人工关口」这条路径上（有倒置边的形状现在同轮就被修好）。
 */
const badPlan = {
  summary: "测试任务经 BUILD 反向依赖实现任务（补边成环）",
  tasks: [
    {
      id: "TASK-101",
      title: "写 AC 测试（错误顺序）",
      description: "测试经构建任务反向依赖实现。",
      type: "TEST",
      priority: "HIGH",
      dependencies: ["TASK-103"],
      estimatedComplexity: 2,
      acceptanceCriteria: ["测试先行（错误形态）。"],
      acKeys: ALL_AC,
      sourceSpecTypes: ["FUNCTIONAL"]
    },
    {
      id: "TASK-102",
      title: "实现切片逻辑",
      description: "实现功能。",
      type: "BACKEND",
      priority: "HIGH",
      dependencies: [] as string[],
      estimatedComplexity: 2,
      acceptanceCriteria: ["实现可用。"],
      acKeys: ALL_AC,
      sourceSpecTypes: ["FUNCTIONAL", "TECHNICAL"]
    },
    {
      id: "TASK-103",
      title: "产出构建物",
      description: "构建。",
      type: "BUILD",
      priority: "MEDIUM",
      dependencies: ["TASK-102"],
      estimatedComplexity: 2,
      acceptanceCriteria: ["构建成功。"],
      sourceSpecTypes: ["TECHNICAL"]
    }
  ]
};

/** 按调用序返回任务计划：切片 1 = good；切片 2 三轮 = bad；升级批准后重试 = good。 */
class SequenceModel extends ScriptedPlanningModel {
  taskPlanCalls = 0;

  constructor(
    fixtures: ReturnType<typeof createTodoPlanningFixtures>,
    private readonly plans: unknown[]
  ) {
    super(fixtures);
  }

  override async generateStructured<TOutput extends JsonObject>(
    input: PlanningModelRequest<TOutput>
  ): Promise<unknown> {
    if (input.stage === "task_planning") {
      const plan = this.plans[Math.min(this.taskPlanCalls, this.plans.length - 1)];
      this.taskPlanCalls += 1;
      return plan;
    }
    return super.generateStructured(input);
  }
}

describe("Planning Escalation E2E（F1-3：修复耗尽 → 人工关口 → 单切片重试）", () => {
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

  it("切片 2 规划成环耗尽 → 升级审批（已完成切片零影响）→ 批准后仅重试该切片并成功", async () => {
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

    const fixtures = createTodoPlanningFixtures();
    const model = new SequenceModel(fixtures, [goodPlan, badPlan, badPlan, badPlan, goodPlan]);

    let workflowServiceRef: WorkflowService | null = null;
    const planningService = new PlanningService({
      planning: new PgPlanningRepository(pool),
      agentRuns: new PgAgentRunStore(pool),
      workflowEvents: new PgWorkflowEventStore(pool),
      projects: projectRepository,
      cancellationStore,
      notifyRunChanged: (agentRunId) => agentRunService.notifyRunChanged(agentRunId),
      approvals: workflowRepository,
      workflows: workflowRepository,
      deployments: new PgDeploymentRepository(pool),
      startSliceWorkflow: async (input) => {
        const service = workflowServiceRef;
        if (!service) {
          throw new Error("Workflow service is not ready");
        }
        const workflow = await service.create(input);
        await service.start(workflow.id);
        return workflow;
      },
      model,
      logger
    });
    const workflowService = new WorkflowService({
      workflows: workflowRepository,
      projects: projectRepository,
      executor: {
        execute: async () => ({
          status: "succeeded" as const,
          output: { summary: "planning-escalation stub" }
        }),
        cancel: async () => undefined
      },
      sliceHooks: {
        onSliceWorkflowCreated: async (requirementId, sliceKey, workflowRunId) => {
          await planningService.handleSliceWorkflowCreated(requirementId, sliceKey, workflowRunId);
        },
        onSliceApprovalDecided: async (approval) => {
          await planningService.handleSliceApprovalDecided(approval);
        },
        onWorkflowTerminal: (workflowRunId, status) => {
          planningService.handleWorkflowTerminal(workflowRunId, status);
        }
      }
    });
    workflowServiceRef = workflowService;

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
        name: "Planning Escalation",
        description: "F1-3 人工关口",
        repository: `https://github.com/example/${randomUUID()}`
      })
      .expect(201);
    const projectId = project.body.data.id as string;

    const created = await request(app)
      .post(`/api/projects/${projectId}/requirements`)
      .send({
        title: "规划升级需求",
        description: "F1-3 escalation",
        rawContent: "两级规划：切片计划 → 关口 1 → 第二级（含升级演练）。"
      })
      .expect(201);
    const requirementId = created.body.data.id as string;

    await request(app).post(`/api/requirements/${requirementId}/analyze`).send({}).expect(202);

    // 关口 1：需求进入 PLANNING_REVIEW，待批准。
    const pendingView = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      return view.approval?.status === "PENDING" ? view : null;
    });
    expect(pendingView.slices.map((slice) => slice.sliceKey)).toEqual(["SLICE-1", "SLICE-2"]);

    // 批准关口 1 → 切片 1 规划（好计划）。
    await request(app)
      .post(`/api/approvals/${pendingView.approval!.id}/approve`)
      .send({})
      .expect(200);

    const slice1 = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const slice = view.slices.find((entry) => entry.sliceKey === "SLICE-1");
      return slice?.status === "PLANNED" ? slice : null;
    });
    expect(slice1.planningVersion).toBeTruthy();

    // 人为创建并启动切片 1 工作流（stub 执行器成功）→ 链式推进切片 2 规划。
    const workspace = await mkdtemp(join(tmpdir(), "planning-escalation-ws-"));
    const firstWorkflow = await request(app)
      .post("/api/workflows")
      .send({
        projectId,
        requirementId,
        workspacePath: workspace,
        sliceKey: "SLICE-1",
        planningVersion: slice1.planningVersion,
        policy: {
          maxConcurrency: 1,
          maxRetries: 0,
          failureStrategy: "FAIL_FAST",
          allowRetry: false,
          allowReplan: false,
          approvalRequired: false
        }
      })
      .expect(201);
    const firstWorkflowId = firstWorkflow.body.data.id as string;
    await request(app).post(`/api/workflows/${firstWorkflowId}/start`).expect(200);

    // 切片 2：三轮成环耗尽 → 升级人工关口（切片复位 PENDING + 升级审批 PENDING）。
    let escalatedView: RequirementSlicesView;
    try {
      escalatedView = await waitFor(async () => {
        const view = (
          await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200)
        ).body.data as RequirementSlicesView;
        const second = view.slices.find((entry) => entry.sliceKey === "SLICE-2");
        const escalation = view.approval;
        return second?.status === "PENDING" &&
          escalation?.status === "PENDING" &&
          escalation.reason.startsWith("[planning-escalation:SLICE-2]")
          ? view
          : null;
      });
    } catch (error) {
      const debugSlices = await pool.query(
        "SELECT slice_key, status, workflow_run_id, planning_version FROM requirement_slices ORDER BY slice_order"
      );
      const debugEvents = await pool.query(
        "SELECT event_type, payload FROM workflow_events ORDER BY sequence DESC LIMIT 40"
      );
      const debugApprovals = await pool.query("SELECT status, reason FROM approvals");
      console.error("DEBUG slices:", JSON.stringify(debugSlices.rows));
      console.error("DEBUG approvals:", JSON.stringify(debugApprovals.rows));
      console.error("DEBUG events:", JSON.stringify(debugEvents.rows));
      throw error;
    }

    // 已完成切片零影响；需求状态为等待人工确认。
    const firstDuringEscalation = escalatedView.slices.find(
      (entry) => entry.sliceKey === "SLICE-1"
    );
    expect(firstDuringEscalation?.status).toBe("DONE");
    expect(firstDuringEscalation?.workflowRunId).toBe(firstWorkflowId);
    const requirementDuring = (
      await request(app).get(`/api/requirements/${requirementId}`).expect(200)
    ).body.data as { status: string };
    expect(requirementDuring.status).toBe("PLANNING_REVIEW");

    // 事件面：三轮回环路径留痕（每轮 1 条）+ 升级事件 + FAILED 标记 escalated。
    const cycleEvents = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM workflow_events
        WHERE event_type = 'PLAN_AUTOFIXED' AND payload->>'status' = 'cycle-blocked'
        ORDER BY sequence ASC`
    );
    expect(cycleEvents.rows).toHaveLength(3);
    expect(cycleEvents.rows[0]?.payload).toMatchObject({
      rule: "test-first-edge",
      implementationTaskId: "TASK-102",
      testTaskId: "TASK-101",
      cyclePath: ["TASK-101", "TASK-102", "TASK-103", "TASK-101"]
    });
    const escalatedEvents = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM workflow_events
        WHERE event_type = 'SLICE_PLANNING_ESCALATED'`
    );
    expect(escalatedEvents.rows).toHaveLength(1);
    expect(escalatedEvents.rows[0]?.payload).toMatchObject({
      sliceKey: "SLICE-2",
      errorCode: "VALIDATION_ERROR",
      retryable: true
    });
    const failedEvents = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM workflow_events
        WHERE event_type = 'SLICE_PLANNING_FAILED' AND payload->>'escalated' = 'true'`
    );
    expect(failedEvents.rows).toHaveLength(1);

    // 批准升级 → 仅重试该切片规划（好计划）→ SLICE-2 PLANNED。
    await request(app)
      .post(`/api/approvals/${escalatedView.approval!.id}/approve`)
      .send({})
      .expect(200);

    const retried = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const second = view.slices.find((entry) => entry.sliceKey === "SLICE-2");
      return second?.status === "PLANNED" && second.planningVersion ? second : null;
    });
    expect(retried.planningVersion).toBeTruthy();

    const retryEvents = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM workflow_events
        WHERE event_type = 'SLICE_PLANNING_RETRY_APPROVED'`
    );
    expect(retryEvents.rows).toHaveLength(1);
    expect(retryEvents.rows[0]?.payload).toMatchObject({ sliceKey: "SLICE-2" });

    // 重试后：切片 1 仍指向原工作流（零改动）；模型调用数 = 1（切片 1）+ 3（切片 2 三轮）+ 1（重试）。
    const finalView = (
      await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200)
    ).body.data as RequirementSlicesView;
    expect(finalView.slices.find((entry) => entry.sliceKey === "SLICE-1")?.workflowRunId).toBe(
      firstWorkflowId
    );
    expect(model.taskPlanCalls).toBe(5);
  }, 240_000);

  it("升级重试达上限 → 终态失败（不再建审批；已完成切片零影响）", async () => {
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

    const fixtures = createTodoPlanningFixtures();
    // 切片 1 好；切片 2 每次尝试均三轮坏（三次尝试：首次 + 两次升级重试）。
    const model = new SequenceModel(fixtures, [
      goodPlan,
      badPlan,
      badPlan,
      badPlan,
      badPlan,
      badPlan,
      badPlan,
      badPlan,
      badPlan,
      badPlan
    ]);

    let workflowServiceRef: WorkflowService | null = null;
    const planningService = new PlanningService({
      planning: new PgPlanningRepository(pool),
      agentRuns: new PgAgentRunStore(pool),
      workflowEvents: new PgWorkflowEventStore(pool),
      projects: projectRepository,
      cancellationStore,
      notifyRunChanged: (agentRunId) => agentRunService.notifyRunChanged(agentRunId),
      approvals: workflowRepository,
      workflows: workflowRepository,
      deployments: new PgDeploymentRepository(pool),
      startSliceWorkflow: async (input) => {
        const service = workflowServiceRef;
        if (!service) {
          throw new Error("Workflow service is not ready");
        }
        const workflow = await service.create(input);
        await service.start(workflow.id);
        return workflow;
      },
      model,
      logger
    });
    const workflowService = new WorkflowService({
      workflows: workflowRepository,
      projects: projectRepository,
      executor: {
        execute: async () => ({
          status: "succeeded" as const,
          output: { summary: "planning-escalation stub" }
        }),
        cancel: async () => undefined
      },
      sliceHooks: {
        onSliceWorkflowCreated: async (requirementId, sliceKey, workflowRunId) => {
          await planningService.handleSliceWorkflowCreated(requirementId, sliceKey, workflowRunId);
        },
        onSliceApprovalDecided: async (approval) => {
          await planningService.handleSliceApprovalDecided(approval);
        },
        onWorkflowTerminal: (workflowRunId, status) => {
          planningService.handleWorkflowTerminal(workflowRunId, status);
        }
      }
    });
    workflowServiceRef = workflowService;

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
        name: "Planning Escalation Exhaustion",
        description: "F1-3 重试上限",
        repository: `https://github.com/example/${randomUUID()}`
      })
      .expect(201);
    const projectId = project.body.data.id as string;

    const created = await request(app)
      .post(`/api/projects/${projectId}/requirements`)
      .send({
        title: "规划升级上限需求",
        description: "F1-3 exhaustion",
        rawContent: "两级规划：切片计划 → 关口 1 → 第二级（升级重试上限演练）。"
      })
      .expect(201);
    const requirementId = created.body.data.id as string;

    await request(app).post(`/api/requirements/${requirementId}/analyze`).send({}).expect(202);

    const pendingView = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      return view.approval?.status === "PENDING" ? view : null;
    });
    await request(app)
      .post(`/api/approvals/${pendingView.approval!.id}/approve`)
      .send({})
      .expect(200);

    const slice1 = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const slice = view.slices.find((entry) => entry.sliceKey === "SLICE-1");
      return slice?.status === "PLANNED" ? slice : null;
    });

    const workspace = await mkdtemp(join(tmpdir(), "planning-escalation-exhaustion-ws-"));
    const firstWorkflow = await request(app)
      .post("/api/workflows")
      .send({
        projectId,
        requirementId,
        workspacePath: workspace,
        sliceKey: "SLICE-1",
        planningVersion: slice1.planningVersion,
        policy: {
          maxConcurrency: 1,
          maxRetries: 0,
          failureStrategy: "FAIL_FAST",
          allowRetry: false,
          allowReplan: false,
          approvalRequired: false
        }
      })
      .expect(201);
    await request(app).post(`/api/workflows/${firstWorkflow.body.data.id}/start`).expect(200);

    // 升级 #1：切片 2 首败 → 审批 PENDING。
    const esc1 = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const second = view.slices.find((entry) => entry.sliceKey === "SLICE-2");
      return second?.status === "PENDING" &&
        view.approval?.status === "PENDING" &&
        view.approval.reason.startsWith("[planning-escalation:SLICE-2]")
        ? view
        : null;
    });
    await request(app)
      .post(`/api/approvals/${esc1.approval!.id}/approve`)
      .send({})
      .expect(200);

    // 升级 #2：重试再败 → 第二个审批 PENDING。
    const esc2 = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const second = view.slices.find((entry) => entry.sliceKey === "SLICE-2");
      return second?.status === "PENDING" &&
        view.approval?.status === "PENDING" &&
        view.approval.reason.startsWith("[planning-escalation:SLICE-2]")
        ? view
        : null;
    });
    await request(app)
      .post(`/api/approvals/${esc2.approval!.id}/approve`)
      .send({})
      .expect(200);

    // 上限耗尽：第三次失败 → 切片 FAILED、需求 ANALYZED（切片 1 已完成）、无新 PENDING 审批。
    const exhausted = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const second = view.slices.find((entry) => entry.sliceKey === "SLICE-2");
      return second?.status === "FAILED" ? view : null;
    });
    expect(exhausted.approval?.status).not.toBe("PENDING");
    const requirementAfter = (
      await request(app).get(`/api/requirements/${requirementId}`).expect(200)
    ).body.data as { status: string };
    expect(requirementAfter.status).toBe("ANALYZED");
    expect(exhausted.slices.find((entry) => entry.sliceKey === "SLICE-1")?.status).toBe("DONE");

    // 审批计数 = 2（不再产生第三次升级）；exhausted 事件留痕。
    const escalationApprovals = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM approvals WHERE requirement_id = $1 AND starts_with(reason, '[planning-escalation:SLICE-2]')",
      [requirementId]
    );
    expect(escalationApprovals.rows[0]?.n).toBe(2);
    const exhaustedEvents = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM workflow_events
        WHERE event_type = 'SLICE_PLANNING_FAILED' AND payload->>'retriesExhausted' = 'true'`
    );
    expect(exhaustedEvents.rows).toHaveLength(1);
    expect(exhaustedEvents.rows[0]?.payload).toMatchObject({
      sliceKey: "SLICE-2",
      retriesExhausted: true
    });

    // 模型调用数 = 1（切片 1）+ 3×3（切片 2 三次尝试各三轮）。
    expect(model.taskPlanCalls).toBe(10);
  }, 240_000);
});
