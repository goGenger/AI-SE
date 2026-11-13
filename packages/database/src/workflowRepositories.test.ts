import { RequirementAnalysis, TaskPlan } from "@ai-se/shared";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";
import { PgPlanningRepository } from "./planningRepositories";
import { PgProjectRepository } from "./projectRepository";
import { PgWorkflowRepository } from "./workflowRepositories";

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres(): Promise<{ pool: Pool; stop: () => Promise<void> }> {
  const name = `ai-se-workflow-postgres-test-${randomUUID()}`;
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
  const pool = new Pool({ connectionString: `postgres://aise@127.0.0.1:${port}/aise`, max: 4 });
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
  summary: "Workflow plan",
  goals: ["Run workflow"],
  constraints: [],
  assumptions: [],
  acceptanceCriteria: ["Workflow completes"],
  risks: []
};

const plan: TaskPlan = {
  summary: "Parallel workflow",
  tasks: [
    {
      id: "A",
      title: "A",
      description: "Root A",
      type: "BACKEND",
      priority: "HIGH",
      dependencies: [],
      estimatedComplexity: 1,
      acceptanceCriteria: ["A done"],
      sourceSpecTypes: ["TECHNICAL"]
    },
    {
      id: "B",
      title: "B",
      description: "Root B",
      type: "FRONTEND",
      priority: "HIGH",
      dependencies: [],
      estimatedComplexity: 1,
      acceptanceCriteria: ["B done"],
      sourceSpecTypes: ["UI"]
    },
    {
      id: "C",
      title: "C",
      description: "Join",
      type: "TEST",
      priority: "MEDIUM",
      dependencies: ["A", "B"],
      estimatedComplexity: 1,
      acceptanceCriteria: ["C done"],
      sourceSpecTypes: ["FUNCTIONAL"]
    }
  ]
};

describe("Phase 4 workflow repository", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repository: PgWorkflowRepository;
  let projectId: string;
  let requirementId: string;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await runMigrations(pool);
    const projects = new PgProjectRepository(pool);
    const planning = new PgPlanningRepository(pool);
    const project = await projects.create({
      name: "Workflow",
      description: "Phase 4",
      repository: `https://github.com/example/${randomUUID()}`,
      status: "active"
    });
    projectId = project.id;
    const requirement = await planning.createRequirement(project.id, {
      title: "Workflow",
      description: "",
      rawContent: "Execute A and B before C."
    });
    requirementId = requirement.id;
    await planning.savePlanningResult({
      projectId,
      requirementId,
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
      taskPlan: plan
    });
    repository = new PgWorkflowRepository(pool);
  }, 180_000);

  afterAll(async () => stop?.());

  it("applies workflow migration", async () => {
    const tables = await pool.query<{ table_name: string }>(
      `
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('workflow_runs', 'approvals')
        ORDER BY table_name
      `
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(["approvals", "workflow_runs"]);
    const columns = await pool.query<{ column_name: string }>(
      `
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tasks' AND column_name IN (
          'plan_task_id', 'origin', 'claim_token', 'failure_handled'
        ) ORDER BY column_name
      `
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "claim_token",
      "failure_handled",
      "origin",
      "plan_task_id"
    ]);
  });

  it("persists the autonomy level so the L1/L2 enforce rule can see it after a reload (N-38)", async () => {
    // N-38：mapWorkflow 从列重建 policy，原先没有 autonomy_level 这一列，于是任何从库里读回的
    // 工作流都缺 autonomyLevel，VerifyingWorkflowTaskExecutor.modeFor 永远退回全局开关——
    // 「L1 工作流一律 enforce」从未生效（实测 m4u 全批 119 条验证事件均为 observe）。
    const withLevel = await repository.create({
      projectId,
      requirementId,
      policy: {
        maxConcurrency: 2,
        maxRetries: 1,
        failureStrategy: "FAIL_FAST",
        allowRetry: true,
        allowReplan: false,
        approvalRequired: false,
        autonomyLevel: "L1"
      },
      approvalTaskKeys: []
    });
    const reloaded = await repository.findWorkflowById(withLevel.id);
    expect(reloaded?.policy.autonomyLevel).toBe("L1");

    const withoutLevel = await repository.create({
      projectId,
      requirementId,
      policy: {
        maxConcurrency: 2,
        maxRetries: 1,
        failureStrategy: "FAIL_FAST",
        allowRetry: true,
        allowReplan: false,
        approvalRequired: false
      },
      approvalTaskKeys: []
    });
    const plain = await repository.findWorkflowById(withoutLevel.id);
    expect(plain?.policy.autonomyLevel).toBeUndefined();
  });

  it("clones the original task plan without modifying it", async () => {
    const workflow = await repository.create({
      projectId,
      requirementId,
      policy: {
        maxConcurrency: 2,
        maxRetries: 1,
        failureStrategy: "FAIL_FAST",
        allowRetry: true,
        allowReplan: false,
        approvalRequired: false
      },
      approvalTaskKeys: []
    });
    const runtimeTasks = await repository.findTasks(workflow.id);
    expect(runtimeTasks).toHaveLength(3);
    expect(runtimeTasks.every((task) => task.origin === "RUNTIME" && task.planTaskId)).toBe(true);
    const original = await pool.query<{ status: string; workflow_run_id: string | null }>(
      "SELECT status, workflow_run_id FROM tasks WHERE requirement_id = $1",
      [requirementId]
    );
    expect(
      original.rows.every((row) => row.status === "PENDING" && row.workflow_run_id === null)
    ).toBe(true);
    expect(await repository.findDependencies(workflow.id)).toHaveLength(2);
  });

  it("limits parallel claims and prevents duplicate claims", async () => {
    const workflow = await repository.create({
      projectId,
      requirementId,
      policy: {
        maxConcurrency: 2,
        maxRetries: 1,
        failureStrategy: "FAIL_FAST",
        allowRetry: true,
        allowReplan: false,
        approvalRequired: false
      },
      approvalTaskKeys: []
    });
    await repository.updateWorkflow(workflow.id, ["PENDING"], { status: "RUNNING" });
    const roots = (await repository.findTasks(workflow.id)).filter((task) => task.taskKey !== "C");
    await Promise.all(
      roots.map((task) => repository.updateTask(task.id, ["PENDING"], { status: "READY" }))
    );
    const claimed = await Promise.all([
      repository.claimNextTask(workflow.id, randomUUID()),
      repository.claimNextTask(workflow.id, randomUUID()),
      repository.claimNextTask(workflow.id, randomUUID())
    ]);
    const ids = claimed.filter(Boolean).map((task) => task?.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("persists approvals, events, and restart recovery state", async () => {
    const workflow = await repository.create({
      projectId,
      requirementId,
      policy: {
        maxConcurrency: 1,
        maxRetries: 1,
        failureStrategy: "FAIL_FAST",
        allowRetry: true,
        allowReplan: false,
        approvalRequired: true
      },
      approvalTaskKeys: []
    });
    const first = (await repository.findTasks(workflow.id))[0];
    const approval = await repository.createApproval(workflow.id, first.id, "Review task");
    expect((await repository.decideApproval(approval.id, "APPROVED", "ok"))?.status).toBe(
      "APPROVED"
    );
    await repository.createEvent({
      workflowRunId: workflow.id,
      taskId: first.id,
      eventType: "APPROVAL_GRANTED",
      payload: { safe: true }
    });
    expect(await repository.findEvents(workflow.id)).toHaveLength(1);
    await repository.updateWorkflow(workflow.id, ["PENDING"], { status: "RUNNING" });
    await repository.updateTask(first.id, ["PENDING"], { status: "READY" });
    await repository.claimNextTask(workflow.id, randomUUID());
    expect(await repository.recoverRunningTasks(workflow.id)).toBe(1);
    expect((await repository.findTasks(workflow.id))[0].status).toBe("RETRYING");
  });

  it("UX-02: findMany resolves project/requirement names + progress; findEventsPage is newest-first", async () => {
    const workflow = await repository.create({
      projectId,
      requirementId,
      policy: {
        maxConcurrency: 2,
        maxRetries: 1,
        failureStrategy: "FAIL_FAST",
        allowRetry: true,
        allowReplan: false,
        approvalRequired: false
      },
      approvalTaskKeys: []
    });
    expect(await repository.findTasks(workflow.id)).toHaveLength(3);
    await repository.updateWorkflow(workflow.id, ["PENDING"], { status: "RUNNING" });
    const first = (await repository.findTasks(workflow.id))[0];
    await repository.updateTask(first.id, ["PENDING"], { status: "READY" });
    const claimed = await repository.claimNextTask(workflow.id, randomUUID());
    expect(claimed?.status).toBe("RUNNING");
    await repository.updateTask(claimed!.id, ["RUNNING"], { status: "SUCCESS" });

    // 列表 DTO：LEFT JOIN 解析 Project / Requirement 名 + 任务进度计数
    const summaries = await repository.findMany();
    const summary = summaries.find((item) => item.id === workflow.id);
    expect(summary).toBeDefined();
    expect(summary!.projectName).toBe("Workflow");
    expect(summary!.requirementName).toBe("Workflow");
    expect(summary!.taskProgress).toEqual({ total: 3, completed: 1 });

    // 事件分页：created_at DESC（同毫秒由 sequence DESC 决定），带 total
    await repository.createEvent({ workflowRunId: workflow.id, eventType: "E1", payload: {} });
    await repository.createEvent({ workflowRunId: workflow.id, eventType: "E2", payload: {} });
    await repository.createEvent({ workflowRunId: workflow.id, eventType: "E3", payload: {} });

    const page1 = await repository.findEventsPage(workflow.id, 2, 0);
    expect(page1.total).toBe(3);
    expect(page1.items.map((event) => event.eventType)).toEqual(["E3", "E2"]);

    const page2 = await repository.findEventsPage(workflow.id, 2, 2);
    expect(page2.total).toBe(3);
    expect(page2.items.map((event) => event.eventType)).toEqual(["E1"]);

    // 越界页：items 为空但 total 保持正确
    const beyond = await repository.findEventsPage(workflow.id, 2, 10);
    expect(beyond.items).toHaveLength(0);
    expect(beyond.total).toBe(3);

    // UX-03：恢复/诊断任务查询（source_task_id → 最早创建的子任务）
    const runtimeTasks = await repository.findTasks(workflow.id);
    await pool.query("UPDATE tasks SET source_task_id = $2 WHERE id = $1", [
      runtimeTasks[1].id,
      runtimeTasks[0].id
    ]);
    const recoveryTask = await repository.findTaskBySourceTaskId(runtimeTasks[0].id);
    expect(recoveryTask?.id).toBe(runtimeTasks[1].id);
    expect(await repository.findTaskBySourceTaskId(randomUUID())).toBeNull();
  });

  /**
   * N-37（`docs/231` §8）：崩溃恢复此前只翻状态、不加计数，进程反复崩溃时同一任务
   * 可以被无上限地重新排队——重试预算形同虚设。这里钉住「恢复也要花掉一次预算」。
   */
  it("N-37: recovery re-queues RUNNING tasks and consumes one retry budget", async () => {
    const workflow = await repository.create({
      projectId,
      requirementId,
      policy: {
        maxConcurrency: 1,
        maxRetries: 3,
        failureStrategy: "FAIL_FAST",
        allowRetry: true,
        allowReplan: false,
        approvalRequired: false
      },
      approvalTaskKeys: []
    });
    const [target] = await repository.findTasks(workflow.id);
    await repository.updateTask(target!.id, ["PENDING"], { status: "READY" });
    await repository.updateTask(target!.id, ["READY"], { status: "RUNNING" });

    const recovered = await repository.recoverRunningTasks(workflow.id);

    expect(recovered).toBe(1);
    const after = (await repository.findTasks(workflow.id)).find((task) => task.id === target!.id);
    expect(after?.status).toBe("RETRYING");
    expect(after?.retryCount).toBe(1);
  });
});
