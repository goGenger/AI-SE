import { AgentRegistry } from "@ai-se/agent-core";
import {
  PgAgentArtifactRepository,
  PgAgentRunStore,
  PgEvidenceRepository,
  PgPlanningRepository,
  PgProjectRepository,
  PgToolCallStore,
  PgWorkflowEventStore,
  PgWorkflowRepository,
  createPool,
  runMigrations
} from "@ai-se/database";
import { createLogger } from "@ai-se/observability";
import { RequirementAnalysis, TaskPlan, WorkflowDetailView } from "@ai-se/shared";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { AgentRunService } from "../services/agentRunService";
import { MemoryCancellationStore } from "../services/cancellationStore";
import { WorkflowService } from "../services/workflowService";
import { createWorkflowRequestIdResolver } from "../services/workflowCorrelation";
import { PersistentWorkflowTaskExecutor } from "../services/workflowTaskExecutor";
import { TaskContextBuilder } from "../services/taskContextBuilder";

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres(): Promise<{
  pool: ReturnType<typeof createPool>;
  stop: () => Promise<void>;
}> {
  const name = "ai-se-workflow-api-test-" + randomUUID();
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
  const pool = createPool("postgres://aise@127.0.0.1:" + port + "/aise");
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
  throw new Error("PostgreSQL test container did not become ready");
}

const analysis: RequirementAnalysis = {
  id: "ANALYSIS",
  summary: "Workflow E2E",
  goals: ["Execute tasks"],
  constraints: [],
  assumptions: [],
  acceptanceCriteria: ["Workflow completes"],
  risks: []
};

function plan(tasks: TaskPlan["tasks"]): TaskPlan {
  return { summary: "Workflow E2E plan", tasks };
}

function plannedTask(
  id: string,
  dependencies: string[] = [],
  type: "BACKEND" | "FRONTEND" | "TEST" = "TEST"
) {
  return {
    id,
    title: id,
    description: "Execute " + id,
    type,
    priority: "MEDIUM" as const,
    dependencies,
    estimatedComplexity: 1,
    acceptanceCriteria: [id + " completes"],
    sourceSpecTypes: ["TECHNICAL" as const]
  };
}

describe("Workflow API E2E", () => {
  let pool: ReturnType<typeof createPool>;
  let stop: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let projectId: string;
  let planning: PgPlanningRepository;
  let workflows: PgWorkflowRepository;
  let workflowService: WorkflowService;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await runMigrations(pool);
    const logger = createLogger({ enabled: false });
    const projects = new PgProjectRepository(pool);
    const cancellationStore = new MemoryCancellationStore();
    const workflowEvents = new PgWorkflowEventStore(pool);
    workflows = new PgWorkflowRepository(pool);
    planning = new PgPlanningRepository(pool);
    const artifacts = new PgAgentArtifactRepository(pool);
    const agentRuns = new PgAgentRunStore(pool);
    const toolCalls = new PgToolCallStore(pool);
    const registry = new AgentRegistry();
    const contextBuilder = new TaskContextBuilder({
      projects,
      planning,
      workflows,
      agentRuns,
      artifacts
    });
    const agentRunService = new AgentRunService({
      agentRuns: new PgAgentRunStore(pool),
      toolCalls: new PgToolCallStore(pool),
      workflowEvents,
      projects,
      cancellationStore,
      // UX-03: full context readers for the AgentRun detail.
      artifacts,
      evidence: new PgEvidenceRepository(pool),
      tasks: workflows,
      logger
    });
    workflowService = new WorkflowService({
      workflows,
      projects,
      executor: new PersistentWorkflowTaskExecutor({
        agentRuns,
        toolCalls,
        workflowEvents,
        artifacts,
        contextBuilder,
        registry,
        cancellationStore,
        sandbox: {
          async runCommand() {
            throw new Error("No tool execution expected in Phase 4 workflow tests");
          }
        },
        requestId: createWorkflowRequestIdResolver(workflowEvents, logger),
        llmProvider: "mock",
        logger
      })
    });
    app = createApp({
      logger,
      projectRepository: projects,
      agentRunService,
      workflowService,
      checkDatabase: async () => {
        await pool.query("SELECT 1");
      },
      checkRedis: async () => undefined,
      corsOrigin: "http://localhost:5173"
    });
    const project = await projects.create({
      name: "Workflow API",
      description: "Phase 4",
      repository: "https://github.com/example/" + randomUUID(),
      status: "active"
    });
    projectId = project.id;
  }, 180_000);

  afterAll(async () => stop?.());

  async function createRequirement(taskPlan: TaskPlan, failingTaskKey?: string): Promise<string> {
    const requirement = await planning.createRequirement(projectId, {
      title: "Workflow " + randomUUID(),
      description: "",
      rawContent: taskPlan.summary
    });
    await planning.savePlanningResult({
      projectId,
      requirementId: requirement.id,
      requirementVersion: 1,
      version: 1,
      analysis,
      specifications: [
        { type: "FUNCTIONAL", content: { requirements: [] } },
        { type: "TECHNICAL", content: { requirements: [] } },
        { type: "ARCHITECTURE", content: { components: [], dataFlow: [] } },
        { type: "API", content: { endpoints: [] } },
        { type: "DATABASE", content: { tables: [] } },
        { type: "UI", content: { pages: [] } }
      ],
      taskPlan
    });
    if (failingTaskKey) {
      await pool.query(
        "UPDATE tasks SET input = input || $3::jsonb WHERE requirement_id = $1 AND task_key = $2",
        [
          requirement.id,
          failingTaskKey,
          JSON.stringify({ execution: { failuresBeforeSuccess: 1 } })
        ]
      );
    }
    return requirement.id;
  }

  async function createAndStart(requirementId: string, body: Record<string, unknown> = {}) {
    const created = await request(app)
      .post("/api/workflows")
      .send({
        projectId,
        requirementId,
        policy: {
          maxConcurrency: 2,
          maxRetries: 1,
          failureStrategy: "FAIL_FAST",
          allowRetry: true,
          allowReplan: false,
          approvalRequired: false,
          ...body
        }
      })
      .expect(201);
    const id = created.body.data.id as string;
    await request(app)
      .post("/api/workflows/" + id + "/start")
      .expect(200);
    return id;
  }

  async function terminal(id: string): Promise<WorkflowDetailView> {
    const detail = await workflowService.waitForTerminal(id, 15_000);
    if (!detail) throw new Error("Workflow did not finish");
    return detail;
  }

  /** 每个 taskKey 的 AgentRun 计数(跳过已完成任务的直接证据:不重跑 = 计数不变)。 */
  async function runCounts(workflowId: string): Promise<Record<string, number>> {
    const result = await pool.query<{ task_key: string; count: string }>(
      `SELECT input->>'taskKey' AS task_key, count(*) AS count
         FROM agent_runs
        WHERE input->>'workflowRunId' = $1
        GROUP BY 1`,
      [workflowId]
    );
    return Object.fromEntries(result.rows.map((row) => [row.task_key, Number(row.count)]));
  }

  /** 移除脚本失败注入(模拟"外部原因已修复"),供 retry 用例使用。 */
  async function clearFailureInjection(workflowId: string, taskKey: string): Promise<void> {
    await pool.query(
      "UPDATE tasks SET input = input || '{\"execution\":{}}'::jsonb WHERE workflow_run_id = $1 AND task_key = $2",
      [workflowId, taskKey]
    );
  }

  it("rejects workspace paths that are not usable local directories", async () => {
    const requirementId = await createRequirement(plan([plannedTask("A")]));

    const relative = await request(app)
      .post("/api/workflows")
      .send({ projectId, requirementId, workspacePath: "Users/me/projects/app" })
      .expect(400);
    expect(relative.body.error.code).toBe("VALIDATION_ERROR");
    expect(relative.body.error.message).toContain("绝对路径");

    const missing = await request(app)
      .post("/api/workflows")
      .send({ projectId, requirementId, workspacePath: "/definitely/missing-workspace-12345" })
      .expect(400);
    expect(missing.body.error.code).toBe("VALIDATION_ERROR");
    expect(missing.body.error.message).toContain("不存在");

    await request(app)
      .post("/api/workflows")
      .send({ projectId, requirementId, workspacePath: process.cwd() })
      .expect(201);
  });

  it("executes A -> B -> C through persisted AgentRuns", async () => {
    const requirementId = await createRequirement(
      plan([plannedTask("A"), plannedTask("B", ["A"]), plannedTask("C", ["B"])])
    );
    const id = await createAndStart(requirementId);
    const detail = await terminal(id);
    expect(detail.workflow.status).toBe("SUCCESS");
    const started = detail.events
      .filter((event) => event.eventType === "TASK_STARTED")
      .map((event) => detail.tasks.find((task) => task.id === event.taskId)?.taskKey);
    expect(started).toEqual(["A", "B", "C"]);
    const runs = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM agent_runs WHERE input->>'workflowRunId' = $1",
      [id]
    );
    expect(Number(runs.rows[0].count)).toBe(3);
  });

  it("runs A and B serially before C (FX-23: maxConcurrency clamped to 1 until T3)", async () => {
    const requirementId = await createRequirement(
      plan([
        plannedTask("A", [], "BACKEND"),
        plannedTask("B", [], "FRONTEND"),
        plannedTask("C", ["A", "B"])
      ])
    );
    await pool.query(
      "UPDATE tasks SET input = input || $2::jsonb WHERE requirement_id = $1 AND task_key IN ('A', 'B')",
      [requirementId, JSON.stringify({ execution: { delayMs: 100 } })]
    );
    const id = await createAndStart(requirementId);
    const detail = await terminal(id);
    // F1-7（FX-23）：T3 未做前不开放并行——创建期钳为 1 并留痕。
    expect(detail.events.map((event) => event.eventType)).toContain(
      "WORKFLOW_MAX_CONCURRENCY_CLAMPED"
    );
    const taskEvents = detail.events.filter((event) =>
      ["TASK_STARTED", "TASK_COMPLETED"].includes(event.eventType)
    );
    // 串行执行：第一对事件是 STARTED → COMPLETED（而非两个 STARTED 并行）。
    expect(taskEvents.slice(0, 2).map((event) => event.eventType)).toEqual([
      "TASK_STARTED",
      "TASK_COMPLETED"
    ]);
    const completedRoots = taskEvents
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.eventType === "TASK_COMPLETED")
      .filter(({ event }) => {
        const key = detail.tasks.find((task) => task.id === event.taskId)?.taskKey;
        return key === "A" || key === "B";
      });
    const cStartedIndex = taskEvents.findIndex((event) => {
      return (
        event.eventType === "TASK_STARTED" &&
        detail.tasks.find((task) => task.id === event.taskId)?.taskKey === "C"
      );
    });
    // 依赖语义不变：C 在两个根任务都完成之后才开始。
    expect(completedRoots).toHaveLength(2);
    expect(completedRoots.every(({ index }) => index < cStartedIndex)).toBe(true);
  });

  it("re-plans failure into Debug -> Retry -> Success", async () => {
    const requirementId = await createRequirement(plan([plannedTask("TEST")]), "TEST");
    const id = await createAndStart(requirementId, {
      failureStrategy: "REPLAN",
      allowReplan: true
    });
    const detail = await terminal(id);
    expect(detail.workflow.status).toBe("SUCCESS");
    expect(detail.tasks.filter((task) => task.origin === "DYNAMIC")).toHaveLength(2);
    expect(detail.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "TASK_FAILED",
        "REPLAN_STARTED",
        "REPLAN_COMPLETED",
        "WORKFLOW_COMPLETED"
      ])
    );
  });

  it("supports approval API before task execution", async () => {
    const requirementId = await createRequirement(plan([plannedTask("APPROVED-TASK")]));
    const created = await request(app)
      .post("/api/workflows")
      .send({
        projectId,
        requirementId,
        policy: {
          maxConcurrency: 1,
          maxRetries: 0,
          failureStrategy: "FAIL_FAST",
          allowRetry: false,
          allowReplan: false,
          approvalRequired: true
        }
      })
      .expect(201);
    const id = created.body.data.id as string;
    await request(app)
      .post("/api/workflows/" + id + "/start")
      .expect(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await workflows.findWorkflowById(id))?.status === "WAITING_APPROVAL") break;
      await sleep(20);
    }
    const approvals = await request(app)
      .get("/api/workflows/" + id + "/approvals")
      .expect(200);
    const approvalId = approvals.body.data[0].id as string;
    await request(app)
      .post("/api/approvals/" + approvalId + "/approve")
      .send({ comment: "approved" })
      .expect(200);
    expect((await terminal(id)).workflow.status).toBe("SUCCESS");
  });

  it("UX-02: list carries Project/Requirement context + progress; events endpoint is a DESC page", async () => {
    const requirementId = await createRequirement(
      plan([plannedTask("A"), plannedTask("B", ["A"])])
    );
    const id = await createAndStart(requirementId);
    expect((await terminal(id)).workflow.status).toBe("SUCCESS");

    // ① 列表 DTO：Project / Requirement 名 + 任务进度由服务端解析
    const list = await request(app).get("/api/workflows").expect(200);
    const item = (list.body.data as Array<Record<string, unknown>>).find(
      (workflow) => workflow.id === id
    );
    expect(item).toBeDefined();
    expect(item!.projectName).toBe("Workflow API");
    expect(String(item!.requirementName)).toContain("Workflow");
    expect(item!.taskProgress).toEqual({ total: 2, completed: 2 });

    // ② 事件分页：created_at DESC（新事件在前）+ 分页元数据
    const full = await workflowService.getEvents(id);
    const desc = [...full].reverse();
    expect(full.length).toBeGreaterThan(3);

    const first = await request(app)
      .get(`/api/workflows/${id}/events?page=1&pageSize=3`)
      .expect(200);
    expect(first.body.data.page).toBe(1);
    expect(first.body.data.pageSize).toBe(3);
    expect(first.body.data.total).toBe(full.length);
    expect(first.body.data.totalPages).toBe(Math.ceil(full.length / 3));
    expect(first.body.data.items.map((event: { id: string }) => event.id)).toEqual(
      desc.slice(0, 3).map((event) => event.id)
    );
    // 数据层已排序：时间戳非递增
    const times = first.body.data.items.map((event: { createdAt: string }) =>
      new Date(event.createdAt).getTime()
    );
    expect(times[0]).toBeGreaterThanOrEqual(times[1]);
    expect(times[1]).toBeGreaterThanOrEqual(times[2]);

    const second = await request(app)
      .get(`/api/workflows/${id}/events?page=2&pageSize=3`)
      .expect(200);
    expect(second.body.data.items.map((event: { id: string }) => event.id)).toEqual(
      desc.slice(3, 6).map((event) => event.id)
    );

    // 默认分页参数（page=1 / pageSize=20）
    const defaults = await request(app).get(`/api/workflows/${id}/events`).expect(200);
    expect(defaults.body.data.page).toBe(1);
    expect(defaults.body.data.pageSize).toBe(20);

    // 非法分页参数 → 400
    const bad = await request(app).get(`/api/workflows/${id}/events?page=0`).expect(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("UX-03: agent runs expose the context chain, trace data and recovery state", async () => {
    const requirementId = await createRequirement(plan([plannedTask("TEST")]), "TEST");
    const workflowId = await createAndStart(requirementId, {
      failureStrategy: "REPLAN",
      allowReplan: true
    });
    const detail = await terminal(workflowId);
    expect(detail.workflow.status).toBe("SUCCESS");

    // ① 列表：无需进入详情即可识别 Project / Workflow / Task / Agent
    const failedTask = detail.tasks.find((task) => task.taskKey === "TEST");
    expect(failedTask).toBeDefined();
    const list = await request(app).get("/api/agent-runs").expect(200);
    const rows = list.body.data as Array<Record<string, unknown>>;
    const summary = rows.find((row) => row.taskId === failedTask!.id);
    expect(summary, "应存在 TEST 任务的 Agent Run").toBeDefined();
    expect(summary!.projectName).toBe("Workflow API");
    expect(String(summary!.requirementName)).toContain("Workflow");
    expect(summary!.workflowRunId).toBe(workflowId);
    expect(summary!.taskKey).toBe("TEST");
    expect(summary!.taskTitle).toBe("TEST");
    expect(typeof summary!.agentName).toBe("string");
    expect(summary!.agentName).toBeTruthy();

    // ② 详情：上下文链 + 产出物/Evidence 数组 + 失败与恢复（REPLAN 产生诊断任务）
    const response = await request(app).get(`/api/agent-runs/${summary!.id}`).expect(200);
    const runDetail = response.body.data as {
      context: {
        projectName: string | null;
        workflow: { id: string; requirementName: string | null; planningVersion: number } | null;
        task: {
          taskKey: string;
          title: string;
          retryCount: number;
          outcome?: string;
          summary?: string;
        } | null;
        agentName: string | null;
        maxRetries: number | null;
      };
      recovery: {
        strategy: string | null;
        recoveryTask: { taskKey: string; title: string } | null;
        humanRequired: boolean;
      } | null;
      artifacts: unknown[];
      evidence: unknown[];
      toolCalls: unknown[];
    };
    expect(runDetail.context.projectName).toBe("Workflow API");
    expect(runDetail.context.workflow?.id).toBe(workflowId);
    expect(String(runDetail.context.workflow?.requirementName)).toContain("Workflow");
    expect(runDetail.context.task?.taskKey).toBe("TEST");
    expect(runDetail.context.agentName).toBe(summary!.agentName);
    expect(runDetail.context.maxRetries).toBe(1);
    // 任务级结果随上下文返回：run 成功/失败与任务判定的差异可解释（脚本失败 → outcome FAILED）。
    expect(runDetail.context.task?.outcome).toBe("FAILED");
    expect(typeof runDetail.context.task?.summary).toBe("string");
    expect(Array.isArray(runDetail.artifacts)).toBe(true);
    expect(runDetail.evidence).toEqual([]);
    expect(Array.isArray(runDetail.toolCalls)).toBe(true);
    // 恢复链路：REPLAN 失败后创建了诊断任务（FAILURE_ROUTED 需要 failureRouter 接线，
    // 该 e2e 未接 —— 恢复状态由诊断任务 + 任务级重试推导）
    expect(runDetail.recovery).not.toBeNull();
    expect(runDetail.recovery!.humanRequired).toBe(false);
    expect(runDetail.recovery!.recoveryTask).not.toBeNull();
    expect(runDetail.recovery!.recoveryTask!.taskKey).toBeTruthy();
    expect(typeof runDetail.recovery!.recoveryTask!.title).toBe("string");
  });

  it("retry re-runs only the failed task and continues the rest (SUCCESS tasks are skipped)", async () => {
    const requirementId = await createRequirement(
      plan([plannedTask("A"), plannedTask("B", ["A"]), plannedTask("C", ["B"])]),
      "B"
    );
    const id = await createAndStart(requirementId, { failureStrategy: "FAIL_FAST" });

    const failed = await terminal(id);
    expect(failed.workflow.status).toBe("FAILED");
    expect(failed.workflow.error?.code).toBe("WORKFLOW_TASK_FAILED");
    expect(failed.workflow.finishedAt).toBeDefined();
    expect(failed.tasks.find((task) => task.taskKey === "B")?.status).toBe("FAILED");
    expect(failed.tasks.find((task) => task.taskKey === "C")?.status).toBe("PENDING");

    const before = await runCounts(id);
    expect(before).toMatchObject({ A: 1, B: 1 });
    expect(before.C ?? 0).toBe(0);

    await clearFailureInjection(id, "B");
    const response = await request(app).post(`/api/workflows/${id}/retry`).expect(200);
    expect(response.body.data.status).toBe("RUNNING");

    const retried = await terminal(id);
    expect(retried.workflow.status).toBe("SUCCESS");
    expect(retried.tasks.find((task) => task.taskKey === "B")?.status).toBe("SUCCESS");
    expect(retried.tasks.find((task) => task.taskKey === "C")?.status).toBe("SUCCESS");
    expect(retried.workflow.error).toBeUndefined();
    expect(retried.workflow.finishedAt).toBeDefined();
    // A 的 run 数不变 = 已完成任务被跳过、不重烧 token;B 恰好 +1;C 继续执行。
    const after = await runCounts(id);
    expect(after).toEqual({ A: 1, B: 2, C: 1 });
    const eventTypes = retried.events.map((event) => event.eventType);
    expect(eventTypes).toContain("TASK_RETRY_REQUESTED");
    expect(eventTypes).toContain("WORKFLOW_RETRIED");
  });

  it("retry of a still-failing task fails the workflow again with a bounded number of runs", async () => {
    const requirementId = await createRequirement(plan([plannedTask("TEST")]), "TEST");
    const id = await createAndStart(requirementId, { failureStrategy: "FAIL_FAST" });
    expect((await terminal(id)).workflow.status).toBe("FAILED");
    expect((await runCounts(id)).TEST).toBe(1);

    await request(app).post(`/api/workflows/${id}/retry`).expect(200);

    expect((await terminal(id)).workflow.status).toBe("FAILED");
    // 有界:一次重排 = 一次新 run,无自动循环。
    expect((await runCounts(id)).TEST).toBe(2);
  });

  it("retry guards: only FAILED workflows can be retried", async () => {
    const successRequirement = await createRequirement(plan([plannedTask("A")]));
    const successId = await createAndStart(successRequirement);
    expect((await terminal(successId)).workflow.status).toBe("SUCCESS");
    const successAttempt = await request(app).post(`/api/workflows/${successId}/retry`).expect(409);
    expect(successAttempt.body.error.code).toBe("INVALID_WORKFLOW_TRANSITION");

    const runningRequirement = await createRequirement(plan([plannedTask("SLOW")]));
    await pool.query(
      "UPDATE tasks SET input = input || $2::jsonb WHERE requirement_id = $1 AND task_key = 'SLOW'",
      [runningRequirement, JSON.stringify({ execution: { delayMs: 1500 } })]
    );
    const runningId = await createAndStart(runningRequirement);
    const runningAttempt = await request(app).post(`/api/workflows/${runningId}/retry`).expect(409);
    expect(runningAttempt.body.error.code).toBe("INVALID_WORKFLOW_TRANSITION");
    expect((await terminal(runningId)).workflow.status).toBe("SUCCESS");
  });

  it("retry re-queues blocked tasks and resumes the remaining chain", async () => {
    const requirementId = await createRequirement(
      plan([plannedTask("A"), plannedTask("B", ["A"]), plannedTask("C", ["B"])]),
      "B"
    );
    const id = await createAndStart(requirementId, { failureStrategy: "CONTINUE" });

    const failed = await terminal(id);
    expect(failed.workflow.status).toBe("FAILED");
    expect(failed.tasks.find((task) => task.taskKey === "B")?.status).toBe("FAILED");
    expect(failed.tasks.find((task) => task.taskKey === "C")?.status).toBe("BLOCKED");

    await clearFailureInjection(id, "B");
    const response = await request(app).post(`/api/workflows/${id}/retry`).expect(200);
    expect(response.body.data.status).toBe("RUNNING");

    const finished = await terminal(id);
    expect(finished.workflow.status).toBe("SUCCESS");
    expect(finished.tasks.find((task) => task.taskKey === "C")?.status).toBe("SUCCESS");
  });
});
