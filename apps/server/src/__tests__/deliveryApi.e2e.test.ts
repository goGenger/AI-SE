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
import { RequirementAnalysis, TaskPlan, WorkflowDetailView } from "@ai-se/shared";
import { DeliveryOperations } from "@ai-se/tool-runtime";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Logger } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { AgentRunService } from "../services/agentRunService";
import { MemoryCancellationStore } from "../services/cancellationStore";
import { DeploymentOrchestrator } from "../services/deploymentOrchestrator";
import { createWorkflowRequestIdResolver } from "../services/workflowCorrelation";
import { WorkflowService } from "../services/workflowService";

const execFileAsync = promisify(execFile);

/** 7-A：捕获部署编排器的工具日志（子 logger 共享同一份记录表）。 */
function capturingLogger() {
  const entries: Array<{ message: string | undefined; data: unknown }> = [];
  const make = (): unknown => ({
    child: () => make(),
    info: (data: unknown, message?: unknown) =>
      entries.push({ message: typeof message === "string" ? message : undefined, data }),
    warn: (data: unknown, message?: unknown) =>
      entries.push({ message: typeof message === "string" ? message : undefined, data }),
    error: (data: unknown, message?: unknown) =>
      entries.push({ message: typeof message === "string" ? message : undefined, data }),
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined
  });
  return { logger: make() as Logger, entries };
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres() {
  const name = `ai-se-delivery-api-${randomUUID()}`;
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

const analysis: RequirementAnalysis = {
  id: "DELIVERY",
  summary: "Delivery lifecycle",
  goals: ["Ship"],
  constraints: [],
  assumptions: [],
  acceptanceCriteria: ["Production is healthy"],
  risks: []
};

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

describe("Phase 6 delivery API integration", () => {
  let stop: () => Promise<void>;
  let pool: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createApp>;
  let workflows: PgWorkflowRepository;
  let deployments: PgDeploymentRepository;
  let projectId: string;
  let workflowId: string;
  let orchestrator: DeploymentOrchestrator;
  /** 7-A：本次交付 run 的触发请求 ID 与部署编排器的工具日志。 */
  const deliveryRequestId = randomUUID();
  const deliveryLogs = capturingLogger();
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
    deployments = new PgDeploymentRepository(pool);
    const agentRuns = new PgAgentRunStore(pool);
    const toolCalls = new PgToolCallStore(pool);
    const workflowEvents = new PgWorkflowEventStore(pool);
    orchestrator = new DeploymentOrchestrator({
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
      logger: deliveryLogs.logger
    });
    const workflowService = new WorkflowService({
      workflows,
      projects,
      executor: orchestrator
    });
    const cancellationStore = new MemoryCancellationStore();
    const agentRunService = new AgentRunService({
      agentRuns,
      toolCalls,
      workflowEvents,
      projects,
      cancellationStore,
      logger
    });
    app = createApp({
      logger,
      projectRepository: projects,
      agentRunService,
      workflowService,
      deploymentOrchestrator: orchestrator,
      checkDatabase: async () => void (await pool.query("SELECT 1")),
      checkRedis: async () => undefined,
      corsOrigin: "http://localhost:5173"
    });
    const project = await projects.create({
      name: "Delivery API",
      description: "Phase 6",
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
    await request(app)
      .put("/api/environments")
      .send({
        projectId,
        name: "staging",
        endpoint: "http://staging.example.test",
        adapter: "docker",
        configuration: { hostPort: 18001, containerPort: 3000 }
      })
      .expect(200);
    await request(app)
      .put("/api/environments")
      .send({
        projectId,
        name: "production",
        endpoint: "http://production.example.test",
        adapter: "docker",
        configuration: { hostPort: 18002, containerPort: 3000 },
        secretReference: "secret://production/app"
      })
      .expect(200);
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
      .set("x-request-id", deliveryRequestId)
      .expect(200);
  }, 180_000);

  afterAll(async () => stop?.());

  it("runs CI, staging, E2E, approval, production, and traceability", async () => {
    let detail: WorkflowDetailView | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await request(app).get(`/api/workflows/${workflowId}`).expect(200);
      detail = response.body.data as WorkflowDetailView;
      if (detail.workflow.status === "WAITING_APPROVAL") break;
      await sleep(50);
    }
    expect(detail?.workflow.status).toBe("WAITING_APPROVAL");
    expect(detail?.tasks.find((task) => task.taskKey === "PRODUCTION")?.approvalRequired).toBe(
      true
    );

    // L1-1（回归门）：staging DEPLOY 不要求审批、自动执行并进入 VERIFY，且不产生审批记录。
    const stagingTask = detail?.tasks.find((task) => task.taskKey === "STAGING");
    expect(stagingTask?.approvalRequired).toBe(false);
    expect(stagingTask?.status).toBe("SUCCESS");
    expect(detail?.tasks.find((task) => task.taskKey === "E2E")?.status).toBe("SUCCESS");
    expect(detail?.approvals).toHaveLength(1); // 全链只有 production 那一个
    expect(detail?.approvals.every((approval) => approval.taskId !== stagingTask?.id)).toBe(true);

    // L1-2（回归门）：批准之前，deployments 里没有 production 记录——人工门确实拦住了它。
    const beforeApproval = await request(app)
      .get(`/api/deployments?projectId=${projectId}`)
      .expect(200);
    expect(
      beforeApproval.body.data.map((item: { environment: string }) => item.environment)
    ).toEqual(["staging"]);

    const approvalId = detail?.approvals.find((approval) => approval.status === "PENDING")?.id;
    expect(approvalId).toBeTruthy();
    await request(app)
      .post(`/api/approvals/${approvalId}/approve`)
      .send({ comment: "ship" })
      .expect(200);
    await request(app)
      .post(`/api/approvals/${approvalId}/approve`)
      .send({ comment: "again" })
      .expect(409);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await request(app).get(`/api/workflows/${workflowId}`).expect(200);
      detail = response.body.data as WorkflowDetailView;
      if (["SUCCESS", "FAILED"].includes(detail.workflow.status)) break;
      await sleep(50);
    }
    expect(detail?.workflow.status).toBe("SUCCESS");
    const history = await request(app).get(`/api/deployments?projectId=${projectId}`).expect(200);
    expect(history.body.data).toHaveLength(2);
    expect(
      history.body.data.map((item: { environment: string }) => item.environment).sort()
    ).toEqual(["production", "staging"]);
    const production = history.body.data.find(
      (item: { environment: string }) => item.environment === "production"
    );
    const productionDetail = await request(app)
      .get(`/api/deployments/${production.id}`)
      .expect(200);
    expect(productionDetail.body.data.deployment.workflowRunId).toBe(workflowId);
    expect(productionDetail.body.data.deployment.gitCommit).toBe("abcdef1234567890");
    expect(productionDetail.body.data.deployment.image).toBe("ai-se-app:abcdef1234567890");
    expect(productionDetail.body.data.logs.length).toBeGreaterThan(0);
    expect(operations.runCi).toHaveBeenCalledOnce();
    expect(operations.deploy).toHaveBeenCalledTimes(2);
    expect(operations.verify).toHaveBeenCalledTimes(3);

    // 7-A（OB-01）：交付 run 的每个工具日志行都带 workflowRunId，且沿用触发请求的 requestId。
    const deliveryToolNames = ["run_ci", "deploy_release", "verify_release"];
    const toolLogs = deliveryLogs.entries.filter(
      (entry) =>
        entry.message === "tool execution finished" &&
        deliveryToolNames.includes(String((entry.data as { toolName?: string }).toolName))
    );
    expect(toolLogs.length).toBeGreaterThan(0);
    for (const entry of toolLogs) {
      expect(
        (entry.data as { audit?: Record<string, unknown> }).audit,
        String((entry.data as { toolName?: string }).toolName)
      ).toMatchObject({ workflowRunId: workflowId, requestId: deliveryRequestId });
    }

    // 与 tool_calls 行按 toolCallId 一一对齐（每一行日志都能找到落库的调用记录）。
    const persisted = await pool.query<{ tool_call_id: string }>(
      "SELECT tool_call_id FROM tool_calls"
    );
    const persistedIds = new Set(persisted.rows.map((row) => row.tool_call_id));
    const loggedIds = toolLogs.map((entry) =>
      String((entry.data as { audit?: { toolCallId?: string } }).audit?.toolCallId)
    );
    expect(loggedIds.every((id) => persistedIds.has(id))).toBe(true);
  });

  it("performs an idempotent rollback to the previous staging version", async () => {
    const workflowTasks = await workflows.findTasks(workflowId);
    const e2eTask = workflowTasks.find((task) => task.taskKey === "E2E");
    const previous = await deployments.findLatestSuccessful(projectId, "staging");
    const workflow = await workflows.findWorkflowById(workflowId);
    expect(e2eTask && previous && workflow).toBeTruthy();
    vi.mocked(operations.deploy).mockResolvedValueOnce({
      status: "FAILED",
      healthCheck: { "/health": 503 },
      logs: ["controlled health failure"],
      error: "health check failed"
    });
    const failed = await orchestrator.execute(workflow!, {
      ...e2eTask!,
      type: "DEPLOY",
      input: { delivery: { action: "DEPLOY", environment: "staging" } }
    });
    expect(failed.status).toBe("failed");
    const currentId = String(failed.output?.deploymentId);
    const current = await deployments.findById(currentId);
    expect(current?.status).toBe("FAILED");
    expect(current?.healthCheck).toEqual({ "/health": 503 });
    const first = await request(app)
      .post(`/api/deployments/${currentId}/rollback`)
      .send({ reason: "health check failed" })
      .expect(200);
    const second = await request(app)
      .post(`/api/deployments/${currentId}/rollback`)
      .send({ reason: "duplicate" })
      .expect(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(first.body.data.version).toBe(previous!.version);
    expect(first.body.data.status).toBe("SUCCESS");
    expect(operations.rollback).toHaveBeenCalledOnce();
  });
});
