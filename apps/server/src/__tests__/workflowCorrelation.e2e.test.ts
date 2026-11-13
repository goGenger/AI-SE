import { AgentRegistry } from "@ai-se/agent-core";
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
import { RequirementAnalysis, TaskPlan, WorkflowDetailView } from "@ai-se/shared";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Logger } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { AgentRunService } from "../services/agentRunService";
import { MemoryCancellationStore } from "../services/cancellationStore";
import { TaskContextBuilder } from "../services/taskContextBuilder";
import { createWorkflowRequestIdResolver } from "../services/workflowCorrelation";
import { WorkflowService } from "../services/workflowService";
import { PersistentWorkflowTaskExecutor } from "../services/workflowTaskExecutor";

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres(): Promise<{
  pool: ReturnType<typeof createPool>;
  stop: () => Promise<void>;
}> {
  const name = "ai-se-workflow-correlation-test-" + randomUUID();
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

interface CapturedLog {
  bindings: Record<string, unknown>;
  data: unknown;
  message: string | undefined;
}

/**
 * 7-A：捕获日志行。Tool Runtime 与工作流执行器写的是子 logger，所以 child() 共享同一份记录表。
 */
class CapturingLogger {
  constructor(
    readonly entries: CapturedLog[] = [],
    private readonly bindings: Record<string, unknown> = {}
  ) {}

  child(bindings: Record<string, unknown>): CapturingLogger {
    return new CapturingLogger(this.entries, { ...this.bindings, ...bindings });
  }

  private record(data: unknown, message?: unknown): void {
    this.entries.push({
      bindings: this.bindings,
      data: data instanceof Error ? { message: data.message } : data,
      message: typeof message === "string" ? message : undefined
    });
  }

  info(data: unknown, message?: unknown): void {
    this.record(data, message);
  }
  warn(data: unknown, message?: unknown): void {
    this.record(data, message);
  }
  error(data: unknown, message?: unknown): void {
    this.record(data, message);
  }
  debug(data: unknown, message?: unknown): void {
    this.record(data, message);
  }
  trace(data: unknown, message?: unknown): void {
    this.record(data, message);
  }
  fatal(data: unknown, message?: unknown): void {
    this.record(data, message);
  }
}

function auditOf(entry: CapturedLog | undefined): Record<string, unknown> {
  const data = entry?.data;
  if (typeof data !== "object" || data === null) return {};
  const audit = (data as { audit?: unknown }).audit;
  return typeof audit === "object" && audit !== null ? (audit as Record<string, unknown>) : {};
}

const analysis: RequirementAnalysis = {
  id: "ANALYSIS",
  summary: "Workflow correlation E2E",
  goals: ["Execute tasks"],
  constraints: [],
  assumptions: [],
  acceptanceCriteria: ["Workflow completes"],
  risks: []
};

function plan(tasks: TaskPlan["tasks"]): TaskPlan {
  return { summary: "Workflow correlation plan", tasks };
}

function plannedTask(id: string, type: "BACKEND" | "TEST" = "BACKEND") {
  return {
    id,
    title: id,
    description: "Execute " + id,
    type,
    priority: "MEDIUM" as const,
    dependencies: [],
    estimatedComplexity: 1,
    acceptanceCriteria: [id + " completes"],
    sourceSpecTypes: ["TECHNICAL" as const]
  };
}

/** 任意命令都成功：本用例只验证关联 ID，不验证工具语义。 */
const sandbox: Sandbox = {
  async runCommand(_workspacePath: string, command: SandboxCommand): Promise<SandboxResult> {
    return {
      command: command.command,
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      duration: 1,
      timedOut: false
    };
  }
};

describe("Workflow correlation E2E (7-A)", () => {
  let pool: ReturnType<typeof createPool>;
  let stop: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let projectId: string;
  let planning: PgPlanningRepository;
  let workflows: PgWorkflowRepository;
  let workflowEvents: PgWorkflowEventStore;
  let workflowService: WorkflowService;
  let logs: CapturingLogger;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await runMigrations(pool);
    const logger = createLogger({ enabled: false });
    const projects = new PgProjectRepository(pool);
    const cancellationStore = new MemoryCancellationStore();
    workflowEvents = new PgWorkflowEventStore(pool);
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
      agentRuns,
      toolCalls,
      workflowEvents,
      projects,
      cancellationStore,
      logger
    });
    logs = new CapturingLogger();
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
        sandbox,
        requestId: createWorkflowRequestIdResolver(workflowEvents, logger),
        llmProvider: "mock",
        logger: logs as unknown as Logger
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
      name: "Workflow correlation",
      description: "7-A",
      repository: "https://github.com/example/" + randomUUID(),
      status: "active"
    });
    projectId = project.id;
  }, 180_000);

  afterAll(async () => stop?.());

  /**
   * 建需求并把脚本化的工具调用注入任务。
   *
   * 步骤用 `git_diff` + `run_unit_test`：实测这两个走 Tool Runtime 并落 `tool_calls` 行。
   * 脚本化的 `read_file` 步骤在本案例中**不产生任何工具调用记录**（Agent 一次迭代即收尾），
   * 用它做本用例会得到「零工具调用」的假阴性。换步骤前先确认 `tool_calls` 有行。
   */
  async function createRequirement(taskPlan: TaskPlan, toolStepTaskKey?: string): Promise<string> {
    const requirement = await planning.createRequirement(projectId, {
      title: "Correlation " + randomUUID(),
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
    if (toolStepTaskKey) {
      await pool.query(
        "UPDATE tasks SET input = input || $3::jsonb WHERE requirement_id = $1 AND task_key = $2",
        [
          requirement.id,
          toolStepTaskKey,
          JSON.stringify({
            execution: {
              deepAgentSteps: [
                { toolName: "git_diff", input: {} },
                { toolName: "run_unit_test", input: { command: "node --test" } }
              ]
            }
          })
        ]
      );
    }
    return requirement.id;
  }

  it("correlates the run, its tool logs and its tool_calls rows with the triggering request", async () => {
    const requirementId = await createRequirement(plan([plannedTask("A", "TEST")]), "A");
    const created = await request(app)
      .post("/api/workflows")
      .send({
        projectId,
        requirementId,
        policy: {
          maxConcurrency: 1,
          maxRetries: 1,
          failureStrategy: "FAIL_FAST",
          allowRetry: true,
          allowReplan: false,
          approvalRequired: false
        }
      })
      .expect(201);
    const workflowId = created.body.data.id as string;

    const requestId = randomUUID();
    const started = await request(app)
      .post("/api/workflows/" + workflowId + "/start")
      .set("x-request-id", requestId)
      .expect(200);
    // OB-02（前半）：响应体回传的就是本次请求的 ID。
    expect(started.body.requestId).toBe(requestId);

    const detail = (await workflowService.waitForTerminal(workflowId, 30_000)) as WorkflowDetailView;
    expect(detail.workflow.status).toBe("SUCCESS");

    // OB-02（后半）：WORKFLOW_STARTED 事件里记录的 requestId 与 HTTP 响应一致。
    const events = await workflowEvents.findByWorkflowRunId(workflowId);
    const startedEvent = events.find((event) => event.eventType === "WORKFLOW_STARTED");
    expect(startedEvent?.payload.requestId).toBe(requestId);

    // 执行器沿用同一 requestId（不再每次执行新生成）。
    const agentRunLogs = logs.entries.filter(
      (entry) => entry.bindings.agentRunId && entry.bindings.workflowRunId === workflowId
    );
    expect(agentRunLogs.length).toBeGreaterThan(0);
    for (const entry of agentRunLogs) {
      expect(entry.bindings.requestId).toBe(requestId);
    }

    // OB-01：每个 tool_calls 行都能在工具日志里按 (agentRunId, toolCallId) 找到，且带 workflowRunId。
    const calls = await pool.query<{ agent_run_id: string; tool_call_id: string }>(
      "SELECT agent_run_id, tool_call_id FROM tool_calls"
    );
    expect(calls.rows.length).toBeGreaterThan(0);
    const finished = logs.entries.filter((entry) => entry.message === "tool execution finished");
    for (const row of calls.rows) {
      const match = finished.find((entry) => {
        const audit = auditOf(entry);
        return audit.toolCallId === row.tool_call_id && audit.agentRunId === row.agent_run_id;
      });
      expect(match, `tool log line for ${row.tool_call_id}`).toBeDefined();
      const audit = auditOf(match);
      expect(audit.workflowRunId).toBe(workflowId);
      expect(audit.requestId).toBe(requestId);
    }
  }, 120_000);

  it("keeps working without a request id (started without one) and reads it back from the event", async () => {
    const requirementId = await createRequirement(plan([plannedTask("B", "TEST")]));
    const created = await request(app)
      .post("/api/workflows")
      .send({ projectId, requirementId })
      .expect(201);
    const workflowId = created.body.data.id as string;

    // 直接走服务层（没有 HTTP 请求 ID）：事件 payload 不含 requestId，行为与旧版一致。
    await workflowService.start(workflowId);
    const detail = (await workflowService.waitForTerminal(workflowId, 30_000)) as WorkflowDetailView;
    expect(detail.workflow.status).toBe("SUCCESS");

    const events = await workflowEvents.findByWorkflowRunId(workflowId);
    const startedEvent = events.find((event) => event.eventType === "WORKFLOW_STARTED");
    expect(startedEvent?.payload.requestId).toBeUndefined();

    // 解析器回落到新 ID，但不抛错（关联信息不得让任务失败）。
    const resolved = await createWorkflowRequestIdResolver(workflowEvents)(
      "00000000-0000-4000-8000-000000000000"
    );
    expect(resolved).toMatch(/^[0-9a-f-]{36}$/);
  }, 120_000);
});
