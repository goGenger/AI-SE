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
  RequirementAcceptanceCriteriaView,
  RequirementSlicesView,
  RequirementTraceabilityView,
  WorkflowDetailView
} from "@ai-se/shared";
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
  const name = `ai-se-slice-flow-postgres-test-${randomUUID()}`;

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

describe("Slice Flow E2E（N2 两级规划：关口 1 → 第二级 → 切片工作流链）", () => {
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

  it("analyze → 切片 → 批准 → 切片 1 工作流 → 自动推进切片 2 → 双切片完成", async () => {
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

    // 最小任务图：不含交付链（避免生产部署审批阻塞链式推进；审批与交付由既有套件覆盖）。
    // F1-1：第一级已落盘 N3 库记录（分析提取，AC-01…）→ 切片计划必须携带 acKeys，
    // 否则规划期以 PLAN_ACKEYS_MISSING 拦截（本用例验证合规计划正常通过并完成链式推进）。
    const fixtures = createTodoPlanningFixtures();
    // 产品默认 capability profile = frontend-vue：BACKEND/DATABASE 不可规划，须用 FRONTEND。
    // 测试先行：实现任务依赖覆盖同 AC 的 TEST。
    fixtures.task_planning = {
      summary: "切片流程最小任务图",
      tasks: [
        {
          id: "TASK-001",
          title: "切片测试",
          description: "覆盖切片行为。",
          type: "TEST",
          priority: "HIGH",
          dependencies: [],
          estimatedComplexity: 2,
          acceptanceCriteria: ["测试通过。"],
          acKeys: ["AC-01", "AC-02", "AC-03", "AC-04"],
          sourceSpecTypes: ["FUNCTIONAL"]
        },
        {
          id: "TASK-002",
          title: "实现切片前端",
          description: "按切片范围实现前端功能。",
          type: "FRONTEND",
          priority: "HIGH",
          dependencies: ["TASK-001"],
          estimatedComplexity: 2,
          acceptanceCriteria: ["切片逻辑可用。"],
          acKeys: ["AC-01", "AC-02", "AC-03", "AC-04"],
          sourceSpecTypes: ["FUNCTIONAL", "TECHNICAL", "UI"]
        }
      ]
    };

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
      startSliceWorkflow: async (input) => {
        const service = workflowServiceRef;
        if (!service) {
          throw new Error("Workflow service is not ready");
        }
        const workflow = await service.create(input);
        await service.start(workflow.id);
        return workflow;
      },
      model: new ScriptedPlanningModel(fixtures),
      logger
    });
    const workflowService = new WorkflowService({
      workflows: workflowRepository,
      projects: projectRepository,
      executor: {
        execute: async () => ({
          status: "succeeded" as const,
          output: { summary: "slice-flow stub" }
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
        name: "Slice Flow",
        description: "N2 两级规划切片流",
        repository: `https://github.com/example/${randomUUID()}`
      })
      .expect(201);
    const projectId = project.body.data.id as string;

    const created = await request(app)
      .post(`/api/projects/${projectId}/requirements`)
      .send({
        title: "切片流程需求",
        description: "N2 slice flow",
        rawContent: "两级规划：切片计划 → 关口 1 → 第二级 → 切片工作流链。"
      })
      .expect(201);
    const requirementId = created.body.data.id as string;

    await request(app).post(`/api/requirements/${requirementId}/analyze`).send({}).expect(202);

    // 第一级完成 → 关口 1 待确认
    await waitFor(async () => {
      const response = await request(app).get(`/api/requirements/${requirementId}`).expect(200);
      return response.body.data.status === "PLANNING_REVIEW" ? true : null;
    });
    const pendingView = (
      await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200)
    ).body.data as RequirementSlicesView;
    expect(pendingView.slices.map((slice) => slice.sliceKey)).toEqual(["SLICE-1", "SLICE-2"]);
    expect(pendingView.approval?.status).toBe("PENDING");

    // 自治 L2 / L2-1（docs/227）：关口 1 未决时**不产生任何第二级规划**。
    // 这是「关口 1 阻塞第二级」的正面断言——不是靠 `PLANNING_REVIEW` 这个状态名推断的。
    const tasksBeforeApproval = (
      await request(app).get(`/api/requirements/${requirementId}/tasks`).expect(200)
    ).body.data as { tasks: unknown[]; dependencies: unknown[] };
    expect(tasksBeforeApproval.tasks).toEqual([]);
    expect(tasksBeforeApproval.dependencies).toEqual([]);

    // 关口 1：批准 → 第二级规划切片 1
    await request(app)
      .post(`/api/approvals/${pendingView.approval!.id}/approve`)
      .send({})
      .expect(200);

    // 产品补齐：关口 1 批准 → 规划成功后自动 create+start 切片 1 工作流。
    const slice1 = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const slice = view.slices.find((entry) => entry.sliceKey === "SLICE-1");
      // create+start 一并完成时 stub 执行器可能已把切片推到 DONE，不能只认 RUNNING。
      return slice?.workflowRunId &&
        slice.planningVersion &&
        (slice.status === "RUNNING" || slice.status === "DONE")
        ? slice
        : null;
    });
    const firstWorkflowId = slice1.workflowRunId as string;

    // 链式推进：切片 1 SUCCESS → 自动规划切片 2 → 自动创建并启动切片 2 工作流 → 双切片 DONE
    const finalView = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const first = view.slices.find((entry) => entry.sliceKey === "SLICE-1");
      const second = view.slices.find((entry) => entry.sliceKey === "SLICE-2");
      return first?.status === "DONE" && second?.status === "DONE" ? view : null;
    });

    const secondSlice = finalView.slices.find((entry) => entry.sliceKey === "SLICE-2");
    expect(secondSlice?.workflowRunId).toBeTruthy();
    expect(secondSlice?.workflowRunId).not.toBe(firstWorkflowId);

    const firstDetail = (await request(app).get(`/api/workflows/${firstWorkflowId}`).expect(200))
      .body.data as WorkflowDetailView;
    expect(firstDetail.workflow.status).toBe("SUCCESS");
    expect(firstDetail.tasks.every((task) => task.sliceKey === "SLICE-1")).toBe(true);

    const secondDetail = (
      await request(app).get(`/api/workflows/${secondSlice!.workflowRunId}`).expect(200)
    ).body.data as WorkflowDetailView;
    expect(secondDetail.workflow.status).toBe("SUCCESS");
    expect(String(secondDetail.workflow.input.sliceKey)).toBe("SLICE-2");
    expect(secondDetail.tasks.every((task) => task.sliceKey === "SLICE-2")).toBe(true);
    // 链式工作流复用前序工作区（首片自动启动无 workspace 时后序也保持缺省）
    expect(secondDetail.workflow.input.workspacePath).toBe(
      firstDetail.workflow.input.workspacePath
    );

    // N3：AC 一等记录落盘（无编号 PRD → LLM 提取串；编号按出现顺序生成）+ 映射数可读。
    const criteriaView = (
      await request(app).get(`/api/requirements/${requirementId}/acceptance-criteria`).expect(200)
    ).body.data as RequirementAcceptanceCriteriaView;
    expect(criteriaView.criteria.length).toBeGreaterThan(0);
    expect(criteriaView.criteria.every((criterion) => criterion.acKey.startsWith("AC-"))).toBe(
      true
    );
    expect(
      criteriaView.criteria.every((criterion) => typeof criterion.mappingCount === "number")
    ).toBe(true);

    // N5：追溯表端点（零 LLM 确定性生成；每条 AC 有状态）。
    const traceability = (
      await request(app).get(`/api/requirements/${requirementId}/traceability`).expect(200)
    ).body.data as RequirementTraceabilityView;
    expect(traceability.criteria.length).toBe(criteriaView.criteria.length);
    expect(traceability.summary.total).toBe(traceability.criteria.length);
    expect(
      traceability.criteria.every((entry) =>
        ["passed", "failed", "unverified", "no-test"].includes(entry.status)
      )
    ).toBe(true);

    // ── 重跑回归（B-4 缺陷）：把切片 2 复位为 PENDING（模拟「待推进」），再为切片 1
    //    重启新工作流——修复后：新工作流被登记（切片 1 行指向新 id）、终态后链再次
    //    推进切片 2（重新规划 → 新工作流 → DONE）。──
    await pool.query(
      `UPDATE requirement_slices
          SET status = 'PENDING', workflow_run_id = NULL, planning_version = NULL
        WHERE requirement_id = $1 AND slice_key = 'SLICE-2'`,
      [requirementId]
    );

    const workspace = await mkdtemp(join(tmpdir(), "slice-flow-ws-"));
    const rerun = await request(app)
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
    const rerunWorkflowId = rerun.body.data.id as string;
    await request(app).post(`/api/workflows/${rerunWorkflowId}/start`).expect(200);

    const rerunView = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const first = view.slices.find((entry) => entry.sliceKey === "SLICE-1");
      const second = view.slices.find((entry) => entry.sliceKey === "SLICE-2");
      return first?.status === "DONE" && second?.status === "DONE" ? view : null;
    });
    const rerunFirst = rerunView.slices.find((entry) => entry.sliceKey === "SLICE-1");
    const rerunSecond = rerunView.slices.find((entry) => entry.sliceKey === "SLICE-2");
    // 登记修复：切片 1 行必须指向重跑工作流（旧行为下该行停留在首轮工作流）。
    expect(rerunFirst?.workflowRunId).toBe(rerunWorkflowId);
    // 推进修复：切片 2 被再次规划并以新工作流重启（不再是首轮的 workflowRunId）。
    expect(rerunSecond?.workflowRunId).toBeTruthy();
    expect(rerunSecond?.workflowRunId).not.toBe(secondSlice!.workflowRunId);
  }, 240_000);

  it("G4（GX-11）：更早切片未完成时不跳过推进——挂起 + SLICE_CHAIN_HELD_BY_EARLIER_SLICE", async () => {
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

    // 3 切片 fixture：SLICE-1（本次成功）→ SLICE-2（预置 FAILED）→ SLICE-3（PENDING，不得被跳过推进）。
    const fixtures = createTodoPlanningFixtures();
    fixtures.task_planning = {
      summary: "切片流程最小任务图",
      tasks: [
        {
          id: "TASK-001",
          title: "切片测试",
          description: "覆盖切片行为。",
          type: "TEST",
          priority: "HIGH",
          dependencies: [],
          estimatedComplexity: 2,
          acceptanceCriteria: ["测试通过。"],
          acKeys: ["AC-01", "AC-02", "AC-03", "AC-04"],
          sourceSpecTypes: ["FUNCTIONAL"]
        },
        {
          id: "TASK-002",
          title: "实现切片前端",
          description: "按切片范围实现前端功能。",
          type: "FRONTEND",
          priority: "HIGH",
          dependencies: ["TASK-001"],
          estimatedComplexity: 2,
          acceptanceCriteria: ["切片逻辑可用。"],
          acKeys: ["AC-01", "AC-02", "AC-03", "AC-04"],
          sourceSpecTypes: ["FUNCTIONAL", "TECHNICAL", "UI"]
        }
      ]
    };
    fixtures.slice_planning = {
      ...fixtures.slice_planning,
      slices: [
        ...fixtures.slice_planning.slices,
        {
          id: "SLICE-3",
          title: "Todo 收尾",
          goal: "收尾切片（仅用于前序完整性验证）。",
          frKeys: ["FR-004"],
          dependsOn: ["SLICE-2"],
          order: 3,
          involvesUi: false,
          involvesData: false,
          acceptanceCriteria: [
            "Closing work for this slice can be verified by a named acceptance check."
          ]
        }
      ]
    };

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
      startSliceWorkflow: async (input) => {
        const service = workflowServiceRef;
        if (!service) {
          throw new Error("Workflow service is not ready");
        }
        const workflow = await service.create(input);
        await service.start(workflow.id);
        return workflow;
      },
      model: new ScriptedPlanningModel(fixtures),
      logger
    });
    const workflowService = new WorkflowService({
      workflows: workflowRepository,
      projects: projectRepository,
      executor: {
        execute: async () => ({
          status: "succeeded" as const,
          output: { summary: "slice-flow stub" }
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
        name: "Slice Hold",
        description: "G4 前序完整性",
        repository: `https://github.com/example/${randomUUID()}`
      })
      .expect(201);
    const projectId = project.body.data.id as string;

    const created = await request(app)
      .post(`/api/projects/${projectId}/requirements`)
      .send({
        title: "前序完整性需求",
        description: "G4 hold",
        rawContent: "G4：前序切片未完成时不跳过推进。"
      })
      .expect(201);
    const requirementId = created.body.data.id as string;

    await request(app).post(`/api/requirements/${requirementId}/analyze`).send({}).expect(202);
    await waitFor(async () => {
      const response = await request(app).get(`/api/requirements/${requirementId}`).expect(200);
      return response.body.data.status === "PLANNING_REVIEW" ? true : null;
    });
    const pendingView = (
      await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200)
    ).body.data as RequirementSlicesView;
    expect(pendingView.slices.map((slice) => slice.sliceKey)).toEqual([
      "SLICE-1",
      "SLICE-2",
      "SLICE-3"
    ]);
    // 预置：SLICE-2 为 FAILED（模拟重跑场景中更早切片未完成）。放在批准前，避免首片
    // 自动启动后秒级跑完而抢在预置之前。
    await pool.query(
      `UPDATE requirement_slices SET status = 'FAILED'
        WHERE requirement_id = $1 AND slice_key = 'SLICE-2'`,
      [requirementId]
    );
    await request(app)
      .post(`/api/approvals/${pendingView.approval!.id}/approve`)
      .send({})
      .expect(200);
    const slice1 = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const slice = view.slices.find((entry) => entry.sliceKey === "SLICE-1");
      // 自动启动后可能已 DONE；有 workflowRunId 即视为首片已拉起。
      return slice?.workflowRunId && (slice.status === "RUNNING" || slice.status === "DONE")
        ? slice
        : null;
    });
    const workflowId = slice1.workflowRunId as string;

    // SLICE-1 终态 SUCCESS；更早未完成切片存在 → 挂起（不规划/不启动 SLICE-3），并留事件。
    await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const first = view.slices.find((entry) => entry.sliceKey === "SLICE-1");
      return first?.status === "DONE" ? true : null;
    });
    const heldPayload = await waitFor(async () => {
      const events = await pool.query(
        "SELECT payload FROM workflow_events WHERE event_type = 'SLICE_CHAIN_HELD_BY_EARLIER_SLICE'"
      );
      const payloads = events.rows.map((row) => row.payload as Record<string, unknown>);
      return payloads.find((entry) => entry.sliceKey === "SLICE-1") ?? null;
    });
    expect(heldPayload.blockedBy).toMatchObject({ sliceKey: "SLICE-2", status: "FAILED" });
    const heldView = (
      await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200)
    ).body.data as RequirementSlicesView;
    const heldSecond = heldView.slices.find((entry) => entry.sliceKey === "SLICE-2");
    const heldThird = heldView.slices.find((entry) => entry.sliceKey === "SLICE-3");
    expect(heldSecond?.status).toBe("FAILED");
    expect(heldThird?.status).toBe("PENDING");
    expect(heldThird?.workflowRunId ?? null).toBeNull();

    // 解除阻塞（SLICE-2 复位 PENDING）后再次触发推进 → 链继续直至三切片全部 DONE。
    await pool.query(
      `UPDATE requirement_slices SET status = 'PENDING'
        WHERE requirement_id = $1 AND slice_key = 'SLICE-2'`,
      [requirementId]
    );
    planningService.handleWorkflowTerminal(workflowId, "SUCCESS");
    const advancedView = await waitFor(async () => {
      const view = (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200))
        .body.data as RequirementSlicesView;
      const third = view.slices.find((entry) => entry.sliceKey === "SLICE-3");
      return third?.status === "DONE" ? view : null;
    });
    expect(advancedView.slices.find((entry) => entry.sliceKey === "SLICE-2")?.status).toBe("DONE");

    // 第三相（run3 双链形状）：更早切片 RUNNING（harness 重启中）+ 后序 PENDING → 仍挂起、不跳推。
    await pool.query(
      `UPDATE requirement_slices SET status = 'RUNNING'
        WHERE requirement_id = $1 AND slice_key = 'SLICE-2'`,
      [requirementId]
    );
    await pool.query(
      `UPDATE requirement_slices SET status = 'PENDING', workflow_run_id = NULL
        WHERE requirement_id = $1 AND slice_key = 'SLICE-3'`,
      [requirementId]
    );
    planningService.handleWorkflowTerminal(workflowId, "SUCCESS");
    const runningHold = await waitFor(async () => {
      const events = await pool.query(
        "SELECT payload FROM workflow_events WHERE event_type = 'SLICE_CHAIN_HELD_BY_EARLIER_SLICE'"
      );
      const payloads = events.rows.map((row) => row.payload as Record<string, unknown>);
      return (
        payloads.find(
          (entry) => (entry.blockedBy as Record<string, unknown> | undefined)?.status === "RUNNING"
        ) ?? null
      );
    });
    expect(runningHold.blockedBy).toMatchObject({ sliceKey: "SLICE-2", status: "RUNNING" });
    const finalView = (
      await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200)
    ).body.data as RequirementSlicesView;
    expect(finalView.slices.find((entry) => entry.sliceKey === "SLICE-3")?.status).toBe("PENDING");
    expect(
      finalView.slices.find((entry) => entry.sliceKey === "SLICE-3")?.workflowRunId ?? null
    ).toBeNull();
  }, 240_000);
});
