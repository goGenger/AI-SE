import { AgentRegistry } from "@ai-se/agent-core";
import {
  PgAgentArtifactRepository,
  PgAgentRunStore,
  PgMetricsRepository,
  PgPlanningRepository,
  PgProjectRepository,
  PgToolCallStore,
  PgWorkflowEventStore,
  PgWorkflowRepository,
  createPool,
  runMigrations
} from "@ai-se/database";
import { createLogger, redactCredentialShapedText } from "@ai-se/observability";
import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { RequirementAnalysis, TaskPlan } from "@ai-se/shared";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { AgentRunService } from "../services/agentRunService";
import { MemoryCancellationStore } from "../services/cancellationStore";
import { MetricsService } from "../services/metricsService";
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
  const name = "ai-se-metrics-endpoint-test-" + randomUUID();
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

/** 取一条样本行的数值；缺行即报错（缺样本本身就是失败）。 */
function sampleValue(text: string, line: string): number {
  const found = text.split("\n").find((entry) => entry.startsWith(line + " "));
  if (!found) throw new Error(`missing sample: ${line}\n---\n${text}`);
  return Number(found.slice(line.length + 1));
}

function sampleOrUndefined(text: string, line: string): number | undefined {
  const found = text.split("\n").find((entry) => entry.startsWith(line + " "));
  return found ? Number(found.slice(line.length + 1)) : undefined;
}

const analysis: RequirementAnalysis = {
  id: "ANALYSIS",
  summary: "Metrics endpoint E2E",
  goals: ["Execute tasks"],
  constraints: [],
  assumptions: [],
  acceptanceCriteria: ["Workflow completes"],
  risks: []
};

function plan(tasks: TaskPlan["tasks"]): TaskPlan {
  return { summary: "Metrics endpoint plan", tasks };
}

function plannedTask(id: string, type: "BACKEND" | "TEST" = "TEST") {
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

describe("Metrics endpoint E2E (7-B)", () => {
  let pool: ReturnType<typeof createPool>;
  let stop: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let projectId: string;
  let planning: PgPlanningRepository;
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
    const workflows = new PgWorkflowRepository(pool);
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
        logger
      })
    });
    app = createApp({
      logger,
      projectRepository: projects,
      agentRunService: new AgentRunService({
        agentRuns,
        toolCalls,
        workflowEvents,
        projects,
        cancellationStore,
        logger
      }),
      workflowService,
      metricsService: new MetricsService({ artifacts, metrics: new PgMetricsRepository(pool) }),
      checkDatabase: async () => {
        await pool.query("SELECT 1");
      },
      checkRedis: async () => undefined,
      corsOrigin: "http://localhost:5173"
    });
    const project = await projects.create({
      name: "Metrics endpoint",
      description: "7-B",
      repository: "https://github.com/example/" + randomUUID(),
      status: "active"
    });
    projectId = project.id;
  }, 180_000);

  afterAll(async () => stop?.());

  /** 跑一次真工作流（含工具调用），并造出部署行与 token / 成本数据。 */
  async function seedData(): Promise<string> {
    const requirement = await planning.createRequirement(projectId, {
      title: "Metrics " + randomUUID(),
      description: "",
      rawContent: "metrics"
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
      taskPlan: plan([plannedTask("A")])
    });
    await pool.query(
      "UPDATE tasks SET input = input || $3::jsonb WHERE requirement_id = $1 AND task_key = $2",
      [
        requirement.id,
        "A",
        JSON.stringify({
          execution: { deepAgentSteps: [{ toolName: "run_unit_test", input: { command: "node --test" } }] }
        })
      ]
    );

    const created = await request(app)
      .post("/api/workflows")
      .send({ projectId, requirementId: requirement.id })
      .expect(201);
    const workflowId = created.body.data.id as string;
    await workflowService.start(workflowId);
    const detail = await workflowService.waitForTerminal(workflowId, 30_000);
    if (detail?.workflow.status !== "SUCCESS") {
      throw new Error("seed workflow did not succeed: " + JSON.stringify(detail?.workflow.status));
    }

    // token / 成本：agent_runs 上有真实字段，但 mock 模型不产生用量，直接写值以覆盖这两项。
    await pool.query(
      "UPDATE agent_runs SET token_usage = $1::jsonb, estimated_cost = $2",
      [JSON.stringify({ total_tokens: 1234 }), 0.25]
    );

    // 部署行：SUCCESS + FAILED 各一条，覆盖 Deployment Success/Failure 的标签分桶。
    const task = await pool.query<{ id: string }>(
      "SELECT id FROM tasks WHERE workflow_run_id = $1 LIMIT 1",
      [workflowId]
    );
    for (const status of ["SUCCESS", "FAILED"]) {
      await pool.query(
        `INSERT INTO deployments (
           project_id, workflow_run_id, task_id, version, environment, image, git_commit,
           operation, status, endpoint, idempotency_key, started_at, finished_at
         ) VALUES ($1, $2, $3, $4, 'staging', 'ai-se:test', 'deadbeef', 'DEPLOY', $5, $6, $7, now(), now())`,
        [
          projectId,
          workflowId,
          task.rows[0].id,
          "v-" + status.toLowerCase(),
          status,
          "http://localhost:18001",
          "metrics-" + status.toLowerCase()
        ]
      );
    }
    return workflowId;
  }

  it("exports the docs/12 nine metrics consistent with direct SQL aggregation", async () => {
    await seedData();
    const response = await request(app).get("/api/metrics").expect(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    const text = response.text;

    // 1. Agent Run Count（口径与成功率分母一致）
    const agentRuns = await pool.query<{ status: string; total: string }>(
      "SELECT status, count(*) AS total FROM agent_runs WHERE input ? 'agentName' GROUP BY status"
    );
    for (const row of agentRuns.rows) {
      expect(sampleValue(text, `ai_se_agent_runs{status="${row.status}"}`)).toBe(Number(row.total));
    }

    // 2. Agent Success Rate
    const agentRate = await pool.query<{ rate: string | null }>(
      `SELECT count(*) FILTER (WHERE status = 'succeeded')::numeric / NULLIF(count(*), 0) AS rate
         FROM agent_runs WHERE input ? 'agentName'`
    );
    expect(sampleValue(text, "ai_se_agent_success_rate")).toBe(Number(agentRate.rows[0].rate));

    // 3. Task Success Rate
    const taskRate = await pool.query<{ rate: string | null }>(
      `SELECT count(*) FILTER (WHERE status = 'SUCCESS')::numeric / NULLIF(count(*), 0) AS rate
         FROM tasks WHERE workflow_run_id IS NOT NULL
           AND status IN ('SUCCESS', 'FAILED', 'BLOCKED', 'CANCELLED')`
    );
    expect(sampleValue(text, "ai_se_task_success_rate")).toBe(Number(taskRate.rows[0].rate));

    // 4. Tool Success Rate
    const toolRate = await pool.query<{ rate: string | null }>(
      `SELECT count(*) FILTER (WHERE status = 'succeeded')::numeric / NULLIF(count(*), 0) AS rate
         FROM tool_calls WHERE status IN ('succeeded', 'failed', 'cancelled', 'timed_out')`
    );
    expect(sampleValue(text, "ai_se_tool_success_rate")).toBe(Number(toolRate.rows[0].rate));

    // 5. Tool Duration（均值，秒）+ 样本数（导出器口径：sum / count / 1000）
    const toolDuration = await pool.query<{ total_ms: string; samples: string }>(
      `SELECT COALESCE(sum(duration), 0) AS total_ms, count(*) AS samples
         FROM tool_calls WHERE duration IS NOT NULL`
    );
    expect(sampleValue(text, "ai_se_tool_duration_seconds")).toBe(
      Number(toolDuration.rows[0].total_ms) / Number(toolDuration.rows[0].samples) / 1000
    );
    expect(sampleValue(text, "ai_se_tool_duration_observations")).toBe(
      Number(toolDuration.rows[0].samples)
    );

    // 6. Workflow Duration（均值，秒）+ 样本数
    const workflowDuration = await pool.query<{ total_s: string; samples: string }>(
      `SELECT COALESCE(sum(extract(epoch FROM (finished_at - started_at))), 0) AS total_s,
              count(*) AS samples
         FROM workflow_runs WHERE started_at IS NOT NULL AND finished_at IS NOT NULL`
    );
    expect(sampleValue(text, "ai_se_workflow_duration_seconds")).toBe(
      Number(workflowDuration.rows[0].total_s) / Number(workflowDuration.rows[0].samples)
    );
    expect(sampleValue(text, "ai_se_workflow_duration_observations")).toBe(
      Number(workflowDuration.rows[0].samples)
    );

    // 7. Token Usage
    const tokens = await pool.query<{ total: string }>(
      `SELECT COALESCE(sum(CASE WHEN token_usage->>'total_tokens' ~ '^[0-9]+$'
                                THEN (token_usage->>'total_tokens')::numeric ELSE 0 END), 0) AS total
         FROM agent_runs`
    );
    expect(sampleValue(text, "ai_se_token_usage")).toBe(Number(tokens.rows[0].total));

    // 8. Estimated Cost
    const cost = await pool.query<{ total: string }>(
      "SELECT COALESCE(sum(estimated_cost), 0) AS total FROM agent_runs"
    );
    expect(sampleValue(text, "ai_se_estimated_cost")).toBe(Number(cost.rows[0].total));

    // 9. Deployment Success/Failure
    const deployments = await pool.query<{ status: string; total: string }>(
      "SELECT status, count(*) AS total FROM deployments GROUP BY status"
    );
    expect(deployments.rows.length).toBeGreaterThan(1);
    for (const row of deployments.rows) {
      expect(sampleValue(text, `ai_se_deployments{status="${row.status}"}`)).toBe(Number(row.total));
    }

    // OB-06：输出里没有任何凭据形状的字符串（用平台自己的脱敏判定）。
    expect(redactCredentialShapedText(text)).toBe(text);
    // 标签只允许有限集合。
    const labelKeys = [...text.matchAll(/\{([a-z_]+)="/g)].map((match) => match[1]);
    expect([...new Set(labelKeys)]).toEqual(["status"]);
  }, 180_000);

  it("keeps the JSON envelope out and inherits the /api token guard", async () => {
    const guarded = createApp({
      logger: createLogger({ enabled: false }),
      projectRepository: new PgProjectRepository(pool),
      agentRunService: new AgentRunService({
        agentRuns: new PgAgentRunStore(pool),
        toolCalls: new PgToolCallStore(pool),
        workflowEvents: new PgWorkflowEventStore(pool),
        projects: new PgProjectRepository(pool),
        cancellationStore: new MemoryCancellationStore()
      }),
      metricsService: new MetricsService({
        artifacts: new PgAgentArtifactRepository(pool),
        metrics: new PgMetricsRepository(pool)
      }),
      checkDatabase: async () => undefined,
      checkRedis: async () => undefined,
      corsOrigin: "http://localhost:5173",
      apiToken: "metrics-token"
    });

    await request(guarded).get("/api/metrics").expect(401);
    const authorized = await request(guarded)
      .get("/api/metrics")
      .set("Authorization", "Bearer metrics-token")
      .expect(200);
    // 文本格式，不是统一 JSON 信封；无标签的指标行不带花括号。
    expect(authorized.text.startsWith("# HELP ai_se_")).toBe(true);
    expect(sampleOrUndefined(authorized.text, "ai_se_token_usage")).toBeGreaterThan(0);
  });
});
