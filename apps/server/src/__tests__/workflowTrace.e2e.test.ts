import {
  PgDeploymentRepository,
  PgAgentRunStore,
  PgPlanningRepository,
  PgProjectRepository,
  PgToolCallStore,
  PgWorkflowEventStore,
  PgWorkflowRepository,
  createPool,
  runMigrations
} from "@ai-se/database";
import { createLogger, redactCredentialShapedText } from "@ai-se/observability";
import { RequirementAnalysis, TaskPlan, TraceNode, WorkflowTraceView } from "@ai-se/shared";
import { DeliveryOperations } from "@ai-se/tool-runtime";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { AgentRunService } from "../services/agentRunService";
import { MemoryCancellationStore } from "../services/cancellationStore";
import { DeploymentOrchestrator } from "../services/deploymentOrchestrator";
import { TraceService } from "../services/traceService";
import { createWorkflowRequestIdResolver } from "../services/workflowCorrelation";
import { WorkflowService } from "../services/workflowService";

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres(): Promise<{
  pool: ReturnType<typeof createPool>;
  stop: () => Promise<void>;
}> {
  const name = "ai-se-workflow-trace-test-" + randomUUID();
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
  id: "TRACE",
  summary: "Delivery trace",
  goals: ["Ship"],
  constraints: [],
  assumptions: [],
  acceptanceCriteria: ["Production is healthy"],
  risks: []
};

/** 交付链四节点（OB-08）：CI → staging DEPLOY → VERIFY → production DEPLOY。 */
const plan: TaskPlan = {
  summary: "CI to production",
  tasks: [
    {
      id: "CI",
      title: "CI",
      description: "Build image",
      type: "BUILD",
      priority: "HIGH",
      dependencies: [],
      estimatedComplexity: 1,
      acceptanceCriteria: ["CI passes"],
      sourceSpecTypes: ["TECHNICAL"],
      delivery: { action: "CI", ref: "main", workflowFile: "ci.yml" }
    },
    {
      id: "STAGING",
      title: "Staging",
      description: "Deploy staging",
      type: "DEPLOY",
      priority: "HIGH",
      dependencies: ["CI"],
      estimatedComplexity: 1,
      acceptanceCriteria: ["Staging healthy"],
      sourceSpecTypes: ["ARCHITECTURE"],
      delivery: { action: "DEPLOY", environment: "staging" }
    },
    {
      id: "E2E",
      title: "Staging E2E",
      description: "Verify staging",
      type: "TEST",
      priority: "HIGH",
      dependencies: ["STAGING"],
      estimatedComplexity: 1,
      acceptanceCriteria: ["E2E passes"],
      sourceSpecTypes: ["FUNCTIONAL"],
      delivery: { action: "VERIFY", environment: "staging" }
    },
    {
      id: "PRODUCTION",
      title: "Production",
      description: "Deploy production",
      type: "DEPLOY",
      priority: "HIGH",
      dependencies: ["E2E"],
      estimatedComplexity: 1,
      acceptanceCriteria: ["Production healthy"],
      sourceSpecTypes: ["ARCHITECTURE"],
      delivery: { action: "DEPLOY", environment: "production" }
    }
  ]
};

function nodesOfKind(node: TraceNode, kind: TraceNode["kind"]): TraceNode[] {
  return [
    ...(node.kind === kind ? [node] : []),
    ...node.children.flatMap((child) => nodesOfKind(child, kind))
  ];
}

describe("Workflow trace E2E (7-C)", () => {
  let stop: () => Promise<void>;
  let pool: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createApp>;
  let workflows: PgWorkflowRepository;
  let projectId: string;
  let workflowId: string;
  const requestId = randomUUID();
  const operations: DeliveryOperations = {
    runCi: vi.fn(async () => ({
      providerRunId: "local-1",
      status: "SUCCESS" as const,
      gitCommit: "abcdef1234567890",
      image: "ai-se-app:abcdef1234567890",
      logs: ["lint, test, build and image publish passed"]
    })),
    deploy: vi.fn(async () => ({
      status: "SUCCESS" as const,
      healthCheck: { "/health": 200, "/ready": 200 },
      logs: ["deployment healthy"]
    })),
    verify: vi.fn(async () => ({
      status: "SUCCESS" as const,
      healthCheck: { "/health": 200, "/ready": 200 },
      logs: ["staging E2E passed"]
    })),
    rollback: vi.fn(async () => ({
      status: "SUCCESS" as const,
      healthCheck: { "/health": 200, "/ready": 200 },
      logs: ["rollback healthy"]
    }))
  };

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await runMigrations(pool);
    const logger = createLogger({ enabled: false });
    const projects = new PgProjectRepository(pool);
    const planning = new PgPlanningRepository(pool);
    workflows = new PgWorkflowRepository(pool);
    const deployments = new PgDeploymentRepository(pool);
    const agentRuns = new PgAgentRunStore(pool);
    const toolCalls = new PgToolCallStore(pool);
    const workflowEvents = new PgWorkflowEventStore(pool);
    const orchestrator = new DeploymentOrchestrator({
      deployments,
      projects,
      workflows,
      agentRuns,
      toolCalls,
      requestId: createWorkflowRequestIdResolver(workflowEvents, logger),
      operations,
      ciProvider: "local",
      sandbox: {
        async runCommand() {
          throw new Error("Delivery integration must not use the coding sandbox");
        }
      },
      logger
    });
    const workflowService = new WorkflowService({
      workflows,
      projects,
      executor: orchestrator
    });
    // 与组合根同一组来源（只读派生）。
    const traceService = new TraceService({
      findWorkflowById: (id) => workflows.findWorkflowById(id),
      findTasks: (id) => workflows.findTasks(id),
      findByTaskIds: (ids) => agentRuns.findByTaskIds(ids),
      findByAgentRunIds: (ids) => toolCalls.findByAgentRunIds(ids),
      findByWorkflowRunId: (id) => deployments.findByWorkflowRunId(id),
      findWorkflowStartedRequestId: (id) => workflowEvents.findWorkflowStartedRequestId(id)
    });
    app = createApp({
      logger,
      projectRepository: projects,
      agentRunService: new AgentRunService({
        agentRuns,
        toolCalls,
        workflowEvents,
        projects,
        cancellationStore: new MemoryCancellationStore(),
        logger
      }),
      workflowService,
      traceService,
      deploymentOrchestrator: orchestrator,
      checkDatabase: async () => void (await pool.query("SELECT 1")),
      checkRedis: async () => undefined,
      corsOrigin: "http://localhost:5173"
    });

    const project = await projects.create({
      name: "Workflow trace",
      description: "7-C",
      repository: `https://example.test/${randomUUID()}`,
      status: "active"
    });
    projectId = project.id;
    const requirement = await planning.createRequirement(projectId, {
      title: "Delivery",
      description: "",
      rawContent: "Ship to production"
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
      taskPlan: plan
    });
    for (const [name, hostPort] of [
      ["staging", 18011],
      ["production", 18012]
    ] as const) {
      await request(app)
        .put("/api/environments")
        .send({
          projectId,
          name,
          endpoint: `http://${name}.example.test`,
          adapter: "docker",
          configuration: { hostPort, containerPort: 3000 }
        })
        .expect(200);
    }
    const created = await request(app)
      .post("/api/workflows")
      .send({
        projectId,
        requirementId: requirement.id,
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
    workflowId = created.body.data.id as string;
    await request(app)
      .post(`/api/workflows/${workflowId}/start`)
      .set("x-request-id", requestId)
      .expect(200);
  }, 180_000);

  afterAll(async () => stop?.());

  async function trace(): Promise<WorkflowTraceView> {
    const response = await request(app).get(`/api/workflows/${workflowId}/trace`).expect(200);
    return response.body.data as WorkflowTraceView;
  }

  /** OB-07：逐类节点数 = 直接 SQL 数出的行数；`expected` 同时钉住该阶段应有的规模。 */
  async function assertCountsMatchDatabase(
    view: WorkflowTraceView,
    expected: { agentRuns: number; deployments: number }
  ): Promise<void> {
    const result = await pool.query<{
      tasks: number;
      agent_runs: number;
      tool_calls: number;
      deployments: number;
    }>(
      `
        SELECT
          (SELECT count(*)::int FROM tasks WHERE workflow_run_id = $1) AS tasks,
          (SELECT count(*)::int FROM agent_runs ar
             JOIN tasks t ON t.id = ar.task_id WHERE t.workflow_run_id = $1) AS agent_runs,
          (SELECT count(*)::int FROM tool_calls tc
             JOIN agent_runs ar ON ar.id = tc.agent_run_id
             JOIN tasks t ON t.id = ar.task_id WHERE t.workflow_run_id = $1) AS tool_calls,
          (SELECT count(*)::int FROM deployments WHERE workflow_run_id = $1) AS deployments
      `,
      [workflowId]
    );
    const row = result.rows[0];
    expect(view.counts).toEqual({
      tasks: row.tasks,
      agentRuns: row.agent_runs,
      toolCalls: row.tool_calls,
      deployments: row.deployments
    });
    // 非空洞断言：四类节点都真实存在，且树确实按层级挂上去了。
    expect(view.counts.tasks).toBe(4);
    expect(view.counts.agentRuns).toBe(expected.agentRuns);
    expect(view.counts.deployments).toBe(expected.deployments);
    expect(view.counts.toolCalls).toBeGreaterThan(0);
    expect(nodesOfKind(view.root, "toolCall")).toHaveLength(view.counts.toolCalls);
    expect(nodesOfKind(view.root, "agentRun")).toHaveLength(view.counts.agentRuns);
  }

  it("exposes the delivery chain and the approval gate, then the completed run (OB-07 / OB-08)", async () => {
    let status = "";
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const detail = await request(app).get(`/api/workflows/${workflowId}`).expect(200);
      status = detail.body.data.workflow.status as string;
      if (status === "WAITING_APPROVAL") break;
      await sleep(50);
    }
    expect(status).toBe("WAITING_APPROVAL");

    // ── 等待审批时的树 ─────────────────────────────────────────────────────
    const pending = await trace();
    expect(pending.workflowRunId).toBe(workflowId);
    expect(pending.root.kind).toBe("workflow");
    expect(pending.root.status).toBe("WAITING_APPROVAL");
    // 7-A 的关联 ID 在追踪树上可见（触发本次运行的 HTTP 请求）。
    expect(pending.requestId).toBe(requestId);
    // PRODUCTION 尚未开跑：3 个任务各有 Agent Run，只有 staging 部署落地。
    await assertCountsMatchDatabase(pending, { agentRuns: 3, deployments: 1 });

    // OB-08：交付链四节点可见，顺序与计划一致。
    const taskNodes = nodesOfKind(pending.root, "task");
    expect(taskNodes.map((node) => node.label)).toEqual(["CI", "STAGING", "E2E", "PRODUCTION"]);
    expect(taskNodes.map((node) => node.status)).toEqual([
      "SUCCESS",
      "SUCCESS",
      "SUCCESS",
      "WAITING_APPROVAL"
    ]);
    const production = taskNodes[3];
    // 审批前 PRODUCTION 没有跑过：没有 Agent Run，也没有部署。
    expect(production.children).toEqual([]);

    // 审批前没有任何凭据形状的字符串出境。
    const serialized = JSON.stringify(pending);
    expect(redactCredentialShapedText(serialized)).toBe(serialized);

    // ── 审批后的树 ─────────────────────────────────────────────────────────
    const detail = await request(app).get(`/api/workflows/${workflowId}`).expect(200);
    const approvalId = (detail.body.data.approvals as Array<{ id: string; status: string }>).find(
      (approval) => approval.status === "PENDING"
    )?.id;
    expect(approvalId).toBeTruthy();
    await request(app)
      .post(`/api/approvals/${approvalId}/approve`)
      .send({ comment: "ship" })
      .expect(200);

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await request(app).get(`/api/workflows/${workflowId}`).expect(200);
      status = current.body.data.workflow.status as string;
      if (["SUCCESS", "FAILED"].includes(status)) break;
      await sleep(50);
    }
    expect(status).toBe("SUCCESS");

    const completed = await trace();
    expect(completed.root.status).toBe("SUCCESS");
    expect(completed.requestId).toBe(requestId);
    await assertCountsMatchDatabase(completed, { agentRuns: 4, deployments: 2 });

    const deployments = nodesOfKind(completed.root, "deployment");
    expect(deployments.map((node) => node.label).sort()).toEqual([
      "production DEPLOY",
      "staging DEPLOY"
    ]);
    // 部署挂在其任务下：production DEPLOY 是 PRODUCTION 任务的子节点，与它的 Agent Run 同级。
    const productionTask = nodesOfKind(completed.root, "task").find(
      (node) => node.label === "PRODUCTION"
    );
    expect(productionTask?.children.map((child) => child.kind).sort()).toEqual([
      "agentRun",
      "deployment"
    ]);
    expect(productionTask?.children.some((child) => child.label === "production DEPLOY")).toBe(true);
    expect(completed.root.children.every((node) => node.durationMs !== undefined)).toBe(true);
  }, 120_000);
});
