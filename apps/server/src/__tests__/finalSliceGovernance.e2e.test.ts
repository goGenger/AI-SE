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
 * F1-4 集成（FX-13b / FX-15b）：
 * - 场景 A：最终切片 enforce 超限（阈值 2）压缩不收敛 → 一级重做拆分（工程契约 + 部署验证）→
 *   关口 1 审批（`[planning-split:…]` 前缀）→ 批准后仅规划「工程契约」段；已完成切片零改动（回归断言）；
 * - 场景 B：工作流创建预检——计划含交付链任务但项目无环境记录 → 明确失败（不创建工作流）+ 事件留痕。
 */

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres(): Promise<{ pool: Pool; stop: () => Promise<void> }> {
  const name = `ai-se-final-slice-postgres-test-${randomUUID()}`;

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

/** 最终切片超大计划（3 任务 > 阈值 2；含交付链任务）——enforce 超限、压缩不收敛。 */
const bigFinalPlan = {
  summary: "最终切片超限计划",
  tasks: [
    ...goodPlan.tasks,
    {
      id: "TASK-003",
      title: "CI 构建与镜像",
      description: "运行质量门并构建交付镜像。",
      type: "BUILD",
      priority: "HIGH",
      dependencies: ["TASK-002"],
      estimatedComplexity: 2,
      acceptanceCriteria: ["CI 通过。"],
      sourceSpecTypes: ["TECHNICAL"],
      delivery: { action: "CI", ref: "main", workflowFile: "ci.yml" }
    }
  ]
};

/** 最终切片含完整交付块（LLM 自带 environment）——工作流创建预检场景用。 */
const deliveryPlan = {
  summary: "最终切片含交付链（无环境记录时预检应失败）",
  tasks: [
    ...goodPlan.tasks,
    {
      id: "TASK-003",
      title: "部署 staging",
      description: "将构建产物部署到 staging。",
      type: "DEPLOY",
      priority: "HIGH",
      dependencies: ["TASK-002"],
      estimatedComplexity: 2,
      acceptanceCriteria: ["Staging 健康检查通过。"],
      sourceSpecTypes: ["TECHNICAL"],
      delivery: { action: "DEPLOY", environment: "staging" }
    }
  ]
};

/** 按调用序返回任务计划。 */
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

describe("Final Slice Governance E2E（F1-4：拆分 / 预检）", () => {
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

  async function boot(plans: unknown[], finalSliceMaxTasks?: number) {
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
    const model = new SequenceModel(fixtures, plans);

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
      ...(finalSliceMaxTasks !== undefined ? { finalSliceMaxTasks } : {}),
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
          output: { summary: "final-slice stub" }
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

    return { app, model };
  }

  async function createAnalyzedSlice1(
    app: ReturnType<typeof createApp>,
    title: string
  ): Promise<{
    projectId: string;
    requirementId: string;
    slice1Version: number;
    workflowId: string;
  }> {
    const project = await request(app)
      .post("/api/projects")
      .send({
        name: title,
        description: "F1-4 final slice governance",
        repository: `https://github.com/example/${randomUUID()}`
      })
      .expect(201);
    const projectId = project.body.data.id as string;

    const created = await request(app)
      .post(`/api/projects/${projectId}/requirements`)
      .send({
        title: `${title} 需求`,
        description: "F1-4",
        rawContent: "两级规划：切片计划 → 关口 1 → 第二级（最终切片治理演练）。"
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

    const workspace = await mkdtemp(join(tmpdir(), "final-slice-ws-"));
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
    const workflowId = firstWorkflow.body.data.id as string;
    await request(app).post(`/api/workflows/${workflowId}/start`).expect(200);

    return { projectId, requirementId, slice1Version: slice1.planningVersion!, workflowId };
  }

  it("场景 A（FX-15b）：最终切片超限 → 拆分（工程契约+部署验证）→ 关口 1 审批 → 仅规划工程契约段；已完成切片零改动", async () => {
    const { app, model } = await boot(
      [goodPlan, bigFinalPlan, bigFinalPlan, bigFinalPlan, goodPlan],
      2
    );
    const { requirementId, workflowId } = await createAnalyzedSlice1(app, "Final Slice Split");

    // 等切片 1 工作流收尾（链推进已接力）——基线取终态快照，拆分对照才稳定。
    await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const slice = view.slices.find((entry) => entry.sliceKey === "SLICE-1");
      return slice?.status === "DONE" ? slice : null;
    });

    // 拆分前记录已完成切片（SLICE-1）行与计划行口径。
    const slice1Before = await pool.query(
      `SELECT status, workflow_run_id, planning_version FROM requirement_slices
        WHERE requirement_id = $1 AND slice_key = 'SLICE-1'`,
      [requirementId]
    );
    const slice1TasksBefore = await pool.query(
      `SELECT count(*)::int AS count FROM tasks
        WHERE requirement_id = $1 AND slice_key = 'SLICE-1' AND superseded_at IS NULL`,
      [requirementId]
    );

    // 切片 2：三轮超限（压缩不收敛）→ 拆分 + 关口 1 审批。
    const splitView = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const second = view.slices.find((entry) => entry.sliceKey === "SLICE-2");
      const escalation = view.approval;
      return second?.status === "PENDING" &&
        escalation?.status === "PENDING" &&
        escalation.reason.startsWith("[planning-split:SLICE-2|SLICE-2-deploy]")
        ? view
        : null;
    });

    expect(splitView.slices.map((entry) => entry.sliceKey)).toEqual([
      "SLICE-1",
      "SLICE-2",
      "SLICE-2-deploy"
    ]);
    const engineering = splitView.slices.find((entry) => entry.sliceKey === "SLICE-2");
    const deployment = splitView.slices.find((entry) => entry.sliceKey === "SLICE-2-deploy");
    expect(engineering?.title).toContain("（工程契约）");
    expect(engineering?.status).toBe("PENDING");
    expect(deployment?.title).toContain("部署验证");
    expect(deployment?.status).toBe("PENDING");
    expect(deployment?.order).toBe(3);
    expect(deployment?.dependsOn).toContain("SLICE-2");

    const requirementDuring = (
      await request(app).get(`/api/requirements/${requirementId}`).expect(200)
    ).body.data as { status: string };
    expect(requirementDuring.status).toBe("PLANNING_REVIEW");

    // 事件面：拆分事件 + 未升级的失败标记（split: true）。
    const splitEvents = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM workflow_events WHERE event_type = 'FINAL_SLICE_SPLIT'`
    );
    expect(splitEvents.rows).toHaveLength(1);
    expect(splitEvents.rows[0]?.payload).toMatchObject({
      sliceKey: "SLICE-2",
      deploySliceKey: "SLICE-2-deploy"
    });
    const failedEvents = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM workflow_events
        WHERE event_type = 'SLICE_PLANNING_FAILED' AND payload->>'split' = 'true'`
    );
    expect(failedEvents.rows).toHaveLength(1);

    // 已完成切片零改动（回归断言：行与计划行原样；未标 SUPERSEDED）。
    const slice1After = await pool.query(
      `SELECT status, workflow_run_id, planning_version FROM requirement_slices
        WHERE requirement_id = $1 AND slice_key = 'SLICE-1'`,
      [requirementId]
    );
    expect(slice1After.rows).toEqual(slice1Before.rows);
    const slice1TasksAfter = await pool.query(
      `SELECT count(*)::int AS count FROM tasks
        WHERE requirement_id = $1 AND slice_key = 'SLICE-1' AND superseded_at IS NULL`,
      [requirementId]
    );
    expect(slice1TasksAfter.rows[0].count).toBe(slice1TasksBefore.rows[0].count);
    expect(slice1After.rows[0].workflow_run_id).toBe(workflowId);

    // 批准拆分 → 仅规划「工程契约」段（SLICE-2）；部署验证段保持 PENDING。
    await request(app)
      .post(`/api/approvals/${splitView.approval!.id}/approve`)
      .send({})
      .expect(200);

    const retried = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const second = view.slices.find((entry) => entry.sliceKey === "SLICE-2");
      return second?.status === "PLANNED" && second.planningVersion ? view : null;
    });
    const deploymentAfter = retried.slices.find((entry) => entry.sliceKey === "SLICE-2-deploy");
    expect(deploymentAfter?.status).toBe("PENDING");

    const approvedEvents = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM workflow_events WHERE event_type = 'SLICE_PLANNING_SPLIT_APPROVED'`
    );
    expect(approvedEvents.rows).toHaveLength(1);
    expect(approvedEvents.rows[0]?.payload).toMatchObject({
      sliceKey: "SLICE-2",
      deploySliceKey: "SLICE-2-deploy"
    });

    // 模型调用数 = 1（切片 1）+ 3（切片 2 三轮）+ 1（拆分后工程契约段）。
    expect(model.taskPlanCalls).toBe(5);
  }, 240_000);

  it("场景 B（FX-13b）：计划含交付链但缺环境记录 → 工作流创建预检明确失败（不创建工作流）", async () => {
    const { app, model } = await boot([goodPlan, deliveryPlan]);
    const { requirementId } = await createAnalyzedSlice1(app, "Delivery Preflight");

    // 切片 2 规划成功（LLM 自带完整交付块）→ 链推进到工作流创建 → 预检失败。
    const failed = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const second = view.slices.find((entry) => entry.sliceKey === "SLICE-2");
      return second?.status === "FAILED" ? second : null;
    });
    expect(failed.workflowRunId ?? null).toBeNull();

    // 未创建切片 2 工作流：需求下工作流数 = 1（仅切片 1）。
    const workflows = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM workflow_runs WHERE requirement_id = $1`,
      [requirementId]
    );
    expect(workflows.rows[0].count).toBe(1);

    const preflightEvents = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM workflow_events WHERE event_type = 'DELIVERY_ENVIRONMENT_PREFLIGHT_FAILED'`
    );
    expect(preflightEvents.rows).toHaveLength(1);
    expect(preflightEvents.rows[0]?.payload).toMatchObject({
      sliceKey: "SLICE-2",
      errorCode: "DELIVERY_ENVIRONMENT_MISSING",
      deliveryTaskCount: 1,
      stage: "workflow_creation"
    });

    expect(model.taskPlanCalls).toBe(2);
  }, 240_000);
});
