import { AgentRegistry, ScriptedDeepAgentModel, type ScriptedAgentStep } from "@ai-se/agent-core";
import {
  PgAgentArtifactRepository,
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
import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { RequirementAnalysis, TaskPlan } from "@ai-se/shared";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryCancellationStore } from "../services/cancellationStore";
import { TaskContextBuilder } from "../services/taskContextBuilder";
import { WorkflowService } from "../services/workflowService";
import { createWorkflowRequestIdResolver } from "../services/workflowCorrelation";
import { PersistentWorkflowTaskExecutor } from "../services/workflowTaskExecutor";

/**
 * F2-3（FX-35/36）终止传播复查（集成测试，真 Postgres + 真服务链 + 脚本化「假 LLM」持续工具调用）：
 *  - FX-35：任务进入终态（TIMEOUT / FAILED / CANCELLED）后，agent run 在 N 秒内中止，
 *    此后 `tool_calls` 表中零新增（按时间戳断言；N = 4s，C-6 ghosts 为 2–23 分钟）。
 *  - FX-36：工作流取消、暂停同样满足上述断言。暂停语义按现状核查：暂停停止新调度、
 *    在途任务自然完成（预算暂停场景要求不中止在途）；断言暂停期零新 agent run、
 *    在途终态后零新增 tool_calls，resume 后正常收敛。
 * 沙箱为进程内 FakeSandbox（本组用例聚焦终止传播语义，不触 Docker）。
 */

const execFileAsync = promisify(execFile);

type Pool = ReturnType<typeof createPool>;

const SETTLE_MS = 4_000;

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres() {
  const name = `ai-se-f23-postgres-${randomUUID()}`;
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
  throw new Error("PostgreSQL test container did not become ready");
}

class FakeSandbox implements Sandbox {
  readonly calls: string[] = [];
  async runCommand(_workspacePath: string, command: SandboxCommand): Promise<SandboxResult> {
    this.calls.push(command.command);
    return {
      command: command.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      duration: 1,
      timedOut: false
    };
  }
}

/**
 * 脚本化「假 LLM」：由既有 ScriptedDeepAgentModel 承载——步骤队列足够长（持续工具调用）；
 * signal 中止敏感与真实 chat 模型一致。`loopSteps(400) + delayMs` = 在测试时长内持续调用。
 * 注：工具路径须落在任务类型权限内（backend-agent readPaths 含 package.json；越权路径会被
 * 权限层拦截为空转且无审计记录）。
 */
function loopSteps(count: number): ScriptedAgentStep[] {
  return Array.from({ length: count }, () => ({
    toolName: "read_file",
    input: { path: "package.json" }
  }));
}

const successOutcome = {
  status: "SUCCESS" as const,
  summary: "loop finished",
  artifacts: [],
  issues: [],
  recommendations: [],
  metadata: {}
};

const failureOutcome = {
  status: "FAILED" as const,
  summary: "loop failed",
  artifacts: [],
  issues: [],
  recommendations: [],
  metadata: {}
};

const analysis: RequirementAnalysis = {
  id: "F23-ANALYSIS",
  summary: "Termination propagation fixture.",
  goals: ["Verify terminal propagation"],
  constraints: [],
  assumptions: [],
  acceptanceCriteria: ["No ghost tool calls"],
  risks: []
};

function plannedTask(
  id: string,
  type: TaskPlan["tasks"][number]["type"]
): TaskPlan["tasks"][number] {
  return {
    id,
    title: id,
    description: `Complete ${id}`,
    type,
    priority: "MEDIUM",
    dependencies: [],
    estimatedComplexity: 1,
    acceptanceCriteria: [`${id} succeeds`],
    sourceSpecTypes: ["TECHNICAL"]
  };
}

interface Harness {
  pool: Pool;
  workflowService: WorkflowService;
  workflows: PgWorkflowRepository;
  executor: PersistentWorkflowTaskExecutor;
  projects: PgProjectRepository;
  planning: PgPlanningRepository;
  createWorkflowFor: (
    model: ScriptedDeepAgentModel,
    execution?: Record<string, unknown>
  ) => Promise<{ workflowId: string; taskId: string }>;
}

describe("F2-3 终止传播（FX-35/36）", () => {
  let stopPostgres: () => Promise<void>;
  let workspaceRoot: string;
  let harness: Harness;

  beforeAll(async () => {
    const postgres = await startPostgres();
    stopPostgres = postgres.stop;
    const pool = postgres.pool;
    await runMigrations(pool);
    const logger = createLogger({ enabled: false });
    const projects = new PgProjectRepository(pool);
    const planning = new PgPlanningRepository(pool);
    const workflows = new PgWorkflowRepository(pool);
    const agentRuns = new PgAgentRunStore(pool);
    const toolCalls = new PgToolCallStore(pool);
    const workflowEvents = new PgWorkflowEventStore(pool);
    const artifacts = new PgAgentArtifactRepository(pool);
    const cancellationStore = new MemoryCancellationStore();
    const registry = new AgentRegistry();
    const contextBuilder = new TaskContextBuilder({
      projects,
      planning,
      workflows,
      agentRuns,
      artifacts
    });
    let activeModel: ScriptedDeepAgentModel | undefined;
    const executor = new PersistentWorkflowTaskExecutor({
      agentRuns,
      toolCalls,
      workflowEvents,
      artifacts,
      contextBuilder,
      registry,
      cancellationStore,
      sandbox: new FakeSandbox(),
      requestId: createWorkflowRequestIdResolver(workflowEvents, logger),
      llmProvider: "mock",
      modelFactory: () => activeModel!,
      logger
    });
    const workflowService = new WorkflowService({ workflows, projects, executor });

    workspaceRoot = await mkdtemp(path.join(tmpdir(), "ai-se-f23-workspaces-"));
    let sequence = 0;

    harness = {
      pool,
      workflowService,
      workflows,
      executor,
      projects,
      planning,
      async createWorkflowFor(model, execution = {}) {
        activeModel = model;
        sequence += 1;
        const workspace = path.join(workspaceRoot, `ws-${sequence}`);
        await execFileAsync("mkdir", ["-p", workspace]);
        const project = await projects.create({
          name: `F23 ${sequence}`,
          description: "termination propagation",
          repository: `https://example.com/${randomUUID()}`,
          status: "active"
        });
        const requirement = await planning.createRequirement(project.id, {
          title: `F23 req ${sequence}`,
          description: "",
          rawContent: "Loop fixture"
        });
        const taskPlan: TaskPlan = {
          summary: "F23 plan",
          tasks: [plannedTask("LOOP", "BACKEND")]
        };
        await planning.savePlanningResult({
          projectId: project.id,
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
        await pool.query(
          "UPDATE tasks SET input = input || $3::jsonb WHERE requirement_id = $1 AND task_key = $2",
          [requirement.id, "LOOP", JSON.stringify({ execution })]
        );
        const workflow = await workflowService.create({
          projectId: project.id,
          requirementId: requirement.id,
          workspacePath: workspace,
          approvalTaskKeys: [],
          policy: {
            maxConcurrency: 1,
            maxRetries: 0,
            failureStrategy: "FAIL_FAST",
            allowRetry: false,
            allowReplan: false,
            approvalRequired: false
          }
        });
        const tasks = await workflows.findTasks(workflow.id);
        return { workflowId: workflow.id, taskId: tasks[0]!.id };
      }
    };
  });

  afterAll(async () => {
    await stopPostgres?.();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  async function waitFor<T>(
    check: () => Promise<T | undefined>,
    description: string,
    timeoutMs = 20_000
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await check();
      if (value !== undefined) return value;
      await sleep(150);
    }
    throw new Error(`waitFor timeout: ${description}`);
  }

  async function agentRunForTask(
    taskId: string
  ): Promise<{ id: string; status: string } | undefined> {
    const { rows } = await harness.pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM agent_runs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1",
      [taskId]
    );
    return rows[0];
  }

  async function toolCallCount(agentRunId: string): Promise<number> {
    const { rows } = await harness.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM tool_calls WHERE agent_run_id = $1",
      [agentRunId]
    );
    return rows[0]?.n ?? -1;
  }

  async function toolCallsStartedAfter(agentRunId: string, afterIso: string): Promise<number> {
    const { rows } = await harness.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM tool_calls WHERE agent_run_id = $1 AND started_at > $2",
      [agentRunId, afterIso]
    );
    return rows[0]?.n ?? -1;
  }

  /**
   * 等到**假 LLM 真的开始产出工具调用**为止。
   *
   * 调用方此前等的是「agent run 处于 running」——但那条状态写入**早于**第一个 `tool_calls` 行，
   * 于是「已 running、零调用」是一个真实存在的窗口。机器一慢，取消就落进那个窗口，
   * 随后 `assertNoGhostCalls` 里「非空跑」的前置断言（`> 0`）就会失败——那不是幽灵调用，
   * 是**取消先于首调用**。整套并行跑时这里失败过多次，单文件连跑 3 次全绿。
   *
   * 这个 helper 把「run 在跑」升级为「跑起来了」：等到真有一次工具调用落库。
   */
  async function waitForToolCalls(agentRunId: string, minimum = 1): Promise<void> {
    await waitFor(async () => {
      const count = await toolCallCount(agentRunId);
      return count >= minimum ? true : undefined;
    }, `agent run ${agentRunId} produced >= ${minimum} tool call(s)`);
  }

  /** 终态后零新增：锚点计数 + 静置 SETTLE_MS 后计数不变，且无晚于锚点时间戳的调用。 */
  async function assertNoGhostCalls(agentRunId: string): Promise<void> {
    const anchorIso = new Date().toISOString();
    const atAnchor = await toolCallCount(agentRunId);
    // 假 LLM 确实在持续发起工具调用（非空跑）。
    expect(atAnchor).toBeGreaterThan(0);
    await sleep(SETTLE_MS);
    const afterSettle = await toolCallCount(agentRunId);
    expect(afterSettle).toBe(atAnchor);
    expect(await toolCallsStartedAfter(agentRunId, anchorIso)).toBe(0);
  }

  it("FX-35：任务超时（TIMEOUT）→ run 中止、终态后零新增 tool_calls", async () => {
    const { workflowId, taskId } = await harness.createWorkflowFor(
      new ScriptedDeepAgentModel({ steps: loopSteps(400), delayMs: 25 }),
      { timeoutMs: 1_200 }
    );
    await harness.workflowService.start(workflowId);
    const detail = await harness.workflowService.waitForTerminal(workflowId, 30_000);
    expect(detail?.workflow.status).toBe("FAILED");

    const run = await waitFor(async () => {
      const current = await agentRunForTask(taskId);
      if (!current) return undefined;
      return current.status === "running" ? undefined : current;
    }, "agent run terminal");
    expect(run.status).toBe("timed_out");
    const task = detail?.tasks.find((entry) => entry.id === taskId);
    expect(["FAILED", "CANCELLED"]).toContain(task?.status);
    await assertNoGhostCalls(run.id);
  }, 60_000);

  it("FX-35：任务失败（FAILED，结构化提交失败结果）→ 终态后零新增 tool_calls", async () => {
    const { workflowId, taskId } = await harness.createWorkflowFor(
      new ScriptedDeepAgentModel({ steps: loopSteps(4), outcome: failureOutcome, delayMs: 25 })
    );
    await harness.workflowService.start(workflowId);
    const detail = await harness.workflowService.waitForTerminal(workflowId, 30_000);
    expect(detail?.workflow.status).toBe("FAILED");
    expect(detail?.tasks.find((entry) => entry.id === taskId)?.status).toBe("FAILED");

    const run = await waitFor(() => agentRunForTask(taskId), "agent run created");
    expect(["succeeded", "failed"]).toContain(run.status);
    await assertNoGhostCalls(run.id);
  }, 60_000);

  it("FX-35：任务取消（CANCELLED，经 executor.cancel）→ run 中止、终态后零新增 tool_calls", async () => {
    const { workflowId, taskId } = await harness.createWorkflowFor(
      new ScriptedDeepAgentModel({ steps: loopSteps(400), delayMs: 25 })
    );
    await harness.workflowService.start(workflowId);
    const running = await waitFor(async () => {
      const current = await agentRunForTask(taskId);
      if (!current) return undefined;
      return current.status === "running" ? current : undefined;
    }, "agent run running");
    await waitForToolCalls((await agentRunForTask(taskId))!.id);
    const tasks = await harness.workflows.findTasks(workflowId);
    const task = tasks.find((entry) => entry.id === taskId)!;
    await harness.executor.cancel(task);

    const run = await waitFor(async () => {
      const current = await agentRunForTask(taskId);
      if (!current) return undefined;
      return current.status === "running" ? undefined : current;
    }, "agent run terminal after cancel");
    expect(run.status).toBe("cancelled");
    await assertNoGhostCalls(run.id);
    expect(run.id).toBe(running.id);
  }, 60_000);

  it("FX-36：工作流取消 → 任务 CANCELLED、run 中止、终态后零新增 tool_calls", async () => {
    const { workflowId, taskId } = await harness.createWorkflowFor(
      new ScriptedDeepAgentModel({ steps: loopSteps(400), delayMs: 25 })
    );
    await harness.workflowService.start(workflowId);
    await waitFor(async () => {
      const current = await agentRunForTask(taskId);
      if (!current) return undefined;
      return current.status === "running" ? current : undefined;
    }, "agent run running");
    await waitForToolCalls((await agentRunForTask(taskId))!.id);
    await harness.workflowService.cancel(workflowId);
    const detail = await harness.workflowService.waitForTerminal(workflowId, 30_000);
    expect(detail?.workflow.status).toBe("CANCELLED");
    expect(detail?.tasks.find((entry) => entry.id === taskId)?.status).toBe("CANCELLED");

    const run = await waitFor(async () => {
      const current = await agentRunForTask(taskId);
      if (!current) return undefined;
      return current.status === "running" ? undefined : current;
    }, "agent run terminal after workflow cancel");
    expect(run.status).toBe("cancelled");
    await assertNoGhostCalls(run.id);
  }, 60_000);

  it("FX-36：工作流暂停 → 暂停期零新调度、在途自然终态后零新增、resume 收敛", async () => {
    const { workflowId, taskId } = await harness.createWorkflowFor(
      new ScriptedDeepAgentModel({ steps: loopSteps(6), outcome: successOutcome, delayMs: 40 })
    );
    await harness.workflowService.start(workflowId);
    await waitFor(async () => {
      const current = await agentRunForTask(taskId);
      if (!current) return undefined;
      return current.status === "running" ? current : undefined;
    }, "agent run running");
    await waitForToolCalls((await agentRunForTask(taskId))!.id);
    await harness.workflowService.pause(workflowId);
    const paused = await harness.workflows.findWorkflowById(workflowId);
    expect(paused?.status).toBe("PAUSED");

    const run = await waitFor(async () => {
      const current = await agentRunForTask(taskId);
      if (!current) return undefined;
      return current.status === "running" ? undefined : current;
    }, "in-flight run settles while paused");
    expect(run.status).toBe("succeeded");
    // 暂停期：零新 agent run（无新调度）。
    const { rows } = await harness.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM agent_runs WHERE task_id = $1",
      [taskId]
    );
    expect(rows[0]?.n).toBe(1);
    const stillPaused = await harness.workflows.findWorkflowById(workflowId);
    expect(stillPaused?.status).toBe("PAUSED");
    const taskAfter = await waitFor(async () => {
      const tasks = await harness.workflows.findTasks(workflowId);
      const task = tasks.find((entry) => entry.id === taskId);
      return task && task.status === "SUCCESS" ? task : undefined;
    }, "task SUCCESS while paused");
    expect(taskAfter.status).toBe("SUCCESS");
    await assertNoGhostCalls(run.id);

    await harness.workflowService.resume(workflowId);
    const detail = await harness.workflowService.waitForTerminal(workflowId, 30_000);
    expect(detail?.workflow.status).toBe("SUCCESS");
  }, 60_000);
});
