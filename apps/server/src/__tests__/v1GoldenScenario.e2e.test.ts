/**
 * AI-SE V1 Final Acceptance — Golden Scenario E2E.
 *
 * One small full-stack business requirement runs through the whole V1 chain on
 * real infrastructure:
 *
 *   PRD → Requirement / Specifications → Task DAG
 *   → Dynamic Workflow (real scheduler, claim protection, maxConcurrency)
 *   → Multi-Agent development (real Docker-sandboxed tools, real file edits)
 *   → QA (real failing test) → dynamic Re-plan (debug + fix task) → Review
 *   → CI (real local pipeline: lint/typecheck/test/build + docker image)
 *   → Staging (real container + health) → Human Approval → Production
 *
 * Plus, in the same round:
 *   - pause / resume / cancel on the same WorkflowEngine + REST surface,
 *   - server-restart recovery: a fresh engine re-claims in-flight work and
 *     finishes the workflow without re-executing completed tasks,
 *   - SSE workflow stream, agent registry, and a real Chromium pass over the
 *     page the frontend agent actually produced (screenshot asset).
 *
 * Real PostgreSQL (fresh container + migrations), real Docker sandbox, real
 * Chromium, real local delivery adapters. Agent *decisions* come from the
 * deterministic ScriptedDeepAgentModel stand-in (no OPENAI_API_KEY in this
 * environment — live LLM agent execution is BLOCKED BY EXTERNAL CONFIG), so
 * planning content and per-task step scripts are deterministic fixtures; every
 * execution path below the decision layer is the real production path.
 */
import {
  AgentRegistry,
  ScriptedPlanningModel,
  ToolRuntimeBackend,
  type AgentContext,
  type AgentPermissions
} from "@ai-se/agent-core";
import {
  BrowserSession,
  COMPUTER_USE_BROWSER_TOOLS,
  createRealPlaywright,
  type NavigateAllowlist
} from "@ai-se/browser";
import {
  PgAgentArtifactRepository,
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
import { DockerSandbox } from "@ai-se/sandbox";
import { RequirementAnalysis, TaskPlan, WorkflowDetailView, type Observation } from "@ai-se/shared";
import {
  ToolRuntime,
  type ToolCallFinishedRecord,
  type ToolCallStartedRecord
} from "@ai-se/tool-runtime";
import type { TaskExecutionResult, WorkflowTaskExecutor } from "@ai-se/workflow-engine";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createPortProbe } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { AgentRegistryService } from "../services/agentRegistryService";
import { AgentRunService } from "../services/agentRunService";
import { MemoryCancellationStore } from "../services/cancellationStore";
import { DeploymentOrchestrator } from "../services/deploymentOrchestrator";
import {
  LocalCiOperations,
  LocalDockerOperations,
  createDeliveryOperations
} from "../services/deliveryAdapters";
import { PlanningService } from "../services/planningService";
import { TaskContextBuilder } from "../services/taskContextBuilder";
import { PersistentWorkflowTaskExecutor } from "../services/workflowTaskExecutor";
import { WorkflowService } from "../services/workflowService";
import { createWorkflowRequestIdResolver } from "../services/workflowCorrelation";

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 180_000 });
  return stdout.trim();
}

async function startPostgres(): Promise<{
  pool: ReturnType<typeof createPool>;
  stop: () => Promise<void>;
}> {
  const name = `ai-se-v1-golden-${randomUUID()}`;
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

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createPortProbe();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe();
    if (value !== undefined) return value;
    await sleep(100);
  }
  throw new Error("waitFor timed out");
}

const analysis: RequirementAnalysis = {
  id: "GOLDEN-ANALYSIS",
  summary: "Small full-stack Todo business requirement.",
  goals: ["Ship a working Todo slice to staging, then production after approval."],
  constraints: ["Reuse the existing project structure."],
  assumptions: [],
  acceptanceCriteria: ["Tests and review pass; staging health is green."],
  risks: []
};

function plannedTask(
  id: string,
  dependencies: string[] = [],
  type: TaskPlan["tasks"][number]["type"] = "TEST"
): TaskPlan["tasks"][number] {
  return {
    id,
    title: id,
    description: `Execute ${id}`,
    type,
    priority: "MEDIUM",
    dependencies,
    estimatedComplexity: 1,
    acceptanceCriteria: [`${id} completes`],
    sourceSpecTypes: ["TECHNICAL"]
  };
}

function specifications() {
  return [
    { type: "FUNCTIONAL" as const, content: { requirements: [] } },
    { type: "TECHNICAL" as const, content: { requirements: [] } },
    { type: "ARCHITECTURE" as const, content: { components: [], dataFlow: [] } },
    { type: "API" as const, content: { endpoints: [] } },
    { type: "DATABASE" as const, content: { tables: [] } },
    { type: "UI" as const, content: { pages: [] } }
  ];
}

function startedEvents(detail: WorkflowDetailView, taskKey: string): number {
  const task = detail.tasks.find((entry) => entry.taskKey === taskKey);
  return detail.events.filter(
    (event) => event.eventType === "TASK_STARTED" && event.taskId === task?.id
  ).length;
}

interface SseReadResult {
  contentType: string;
  text: string;
}

/** Read the first SSE chunk(s) from the workflow stream route (real HTTP). */
async function readWorkflowSse(
  app: ReturnType<typeof createApp>,
  workflowId: string
): Promise<SseReadResult> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/workflows/${workflowId}/stream`, {
      signal: controller.signal
    });
    const contentType = response.headers.get("content-type") ?? "";
    const reader = response.body?.getReader();
    let text = "";
    if (reader) {
      const decoder = new TextDecoder();
      while (!text.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      await reader.cancel().catch(() => undefined);
    }
    return { contentType, text };
  } finally {
    clearTimeout(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("AI-SE V1 final acceptance — golden scenario (real PG + Docker + Chromium + local delivery)", () => {
  let pool: ReturnType<typeof createPool>;
  let stop: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let workspaceRoot = "";
  let workspace = "";
  let projectId = "";
  let planning: PgPlanningRepository;
  let projects: PgProjectRepository;
  let workflows: PgWorkflowRepository;
  let deployments: PgDeploymentRepository;
  let workflowService: WorkflowService;
  let agentExecutor: PersistentWorkflowTaskExecutor;
  const containers = new Set<string>();
  const images = new Set<string>();

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "ai-se-v1-golden-workspaces-"));
    workspace = path.join(workspaceRoot, "todo-app");
    await cp(path.resolve("../../examples/delivery-test-project"), workspace, { recursive: true });
    await mkdir(path.join(workspace, "database"), { recursive: true });
    await mkdir(path.join(workspace, "server"), { recursive: true });
    await mkdir(path.join(workspace, "web"), { recursive: true });
    await mkdir(path.join(workspace, "tests"), { recursive: true });
    await Promise.all([
      writeFile(path.join(workspace, "database/schema.sql"), "-- TODO\n"),
      writeFile(
        path.join(workspace, "server/todos.cjs"),
        "exports.createTodo = (title) => ({ id: 'todo-1', title: 'broken', completed: false });\n"
      ),
      writeFile(
        path.join(workspace, "web/index.html"),
        '<!doctype html>\n<html lang="en">\n  <head><meta charset="utf-8" /><title>Golden Todo</title></head>\n  <body><main>TODO</main></body>\n</html>\n'
      ),
      writeFile(
        path.join(workspace, "tests/todos.test.mjs"),
        [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import todos from '../server/todos.cjs';",
          "test('creates a Todo with the provided title', () => assert.equal(todos.createTodo('Ship').title, 'Ship'));"
        ].join("\n")
      )
    ]);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "ai-se@example.test"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "AI-SE"], { cwd: workspace });
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "golden baseline"], { cwd: workspace });

    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await runMigrations(pool);

    const logger = createLogger({ enabled: false });
    projects = new PgProjectRepository(pool);
    planning = new PgPlanningRepository(pool);
    workflows = new PgWorkflowRepository(pool);
    deployments = new PgDeploymentRepository(pool);
    const agentRuns = new PgAgentRunStore(pool);
    const toolCalls = new PgToolCallStore(pool);
    const workflowEvents = new PgWorkflowEventStore(pool);
    const artifacts = new PgAgentArtifactRepository(pool);
    const registry = new AgentRegistry();
    const contextBuilder = new TaskContextBuilder({
      projects,
      planning,
      workflows,
      agentRuns,
      artifacts
    });
    const cancellationStore = new MemoryCancellationStore();
    agentExecutor = new PersistentWorkflowTaskExecutor({
      agentRuns,
      toolCalls,
      workflowEvents,
      artifacts,
      contextBuilder,
      registry,
      cancellationStore,
      sandbox: new DockerSandbox({ allowedWorkspaceRoot: workspaceRoot, logger }),
      requestId: createWorkflowRequestIdResolver(workflowEvents, logger),
      llmProvider: "mock",
      logger
    });
    const deliveryOrchestrator = new DeploymentOrchestrator({
      deployments,
      projects,
      workflows,
      agentRuns,
      toolCalls,
      requestId: createWorkflowRequestIdResolver(workflowEvents, logger),
      operations: createDeliveryOperations({
        ci: new LocalCiOperations(),
        docker: new LocalDockerOperations()
      }),
      ciProvider: "local",
      sandbox: {
        async runCommand() {
          throw new Error("Delivery must not use the coding sandbox");
        }
      },
      logger
    });
    const composite: WorkflowTaskExecutor = {
      async execute(workflow, task) {
        return deliveryOrchestrator.canHandle(task)
          ? await deliveryOrchestrator.execute(workflow, task)
          : await agentExecutor.execute(workflow, task);
      },
      async cancel(task) {
        await Promise.all([agentExecutor.cancel(task), deliveryOrchestrator.cancel(task)]);
      }
    };
    workflowService = new WorkflowService({ workflows, projects, executor: composite });
    const agentRunService = new AgentRunService({
      agentRuns,
      toolCalls,
      workflowEvents,
      projects,
      cancellationStore,
      logger
    });
    const planningService = new PlanningService({
      planning,
      agentRuns,
      workflowEvents,
      projects,
      cancellationStore,
      notifyRunChanged: (agentRunId) => agentRunService.notifyRunChanged(agentRunId),
      // v1 金路径回归：锁定旧一次性规划语义（N2 两级开关的 single 档）。
      mode: "single",
      model: new ScriptedPlanningModel(),
      logger
    });
    app = createApp({
      logger,
      projectRepository: projects,
      agentRunService,
      planningService,
      workflowService,
      deploymentOrchestrator: deliveryOrchestrator,
      agentRegistryService: new AgentRegistryService({ registry, agentRuns, artifacts }),
      checkDatabase: async () => {
        await pool.query("SELECT 1");
      },
      checkRedis: async () => undefined,
      corsOrigin: "http://localhost:5173"
    });

    const project = await projects.create({
      name: "Golden Scenario",
      description: "AI-SE V1 final acceptance",
      repository: `https://local.test/golden/${randomUUID()}`,
      status: "active"
    });
    projectId = project.id;
    const stagingPort = await freePort();
    const productionPort = await freePort();
    const stagingContainer = `ai-se-golden-staging-${randomUUID().slice(0, 8)}`;
    const productionContainer = `ai-se-golden-production-${randomUUID().slice(0, 8)}`;
    containers.add(stagingContainer);
    containers.add(productionContainer);
    await request(app)
      .put("/api/environments")
      .send({
        projectId,
        name: "staging",
        endpoint: `http://127.0.0.1:${stagingPort}`,
        adapter: "docker",
        configuration: {
          containerName: stagingContainer,
          hostPort: stagingPort,
          containerPort: 3000
        }
      })
      .expect(200);
    await request(app)
      .put("/api/environments")
      .send({
        projectId,
        name: "production",
        endpoint: `http://127.0.0.1:${productionPort}`,
        adapter: "docker",
        configuration: {
          containerName: productionContainer,
          hostPort: productionPort,
          containerPort: 3000
        }
      })
      .expect(200);
  }, 240_000);

  afterAll(async () => {
    for (const container of containers) {
      await docker(["rm", "-f", container]).catch(() => undefined);
    }
    for (const image of images) {
      await docker(["image", "rm", "-f", image]).catch(() => undefined);
    }
    await stop?.();
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  });

  async function seedRequirement(plan: TaskPlan): Promise<string> {
    const requirement = await planning.createRequirement(projectId, {
      title: `Golden ${randomUUID()}`,
      description: "",
      rawContent: plan.summary
    });
    await planning.savePlanningResult({
      projectId,
      requirementId: requirement.id,
      requirementVersion: 1,
      version: 1,
      analysis,
      specifications: specifications(),
      taskPlan: plan
    });
    return requirement.id;
  }

  it("PRD → Planning → Dynamic Workflow → Multi-Agent → QA/Re-plan → Review → CI → Staging → Approval → Production", async () => {
    // ── 1. PRD → Requirement → Specifications → Task DAG (real planning service) ──
    const created = await request(app)
      .post(`/api/projects/${projectId}/requirements`)
      .send({
        title: "小型 Todo 业务需求",
        description: "Golden scenario PRD",
        rawContent:
          "创建一个简单的 Todo 管理系统：数据库表、REST API、页面、测试、评审，并通过 CI 交付到 staging。"
      })
      .expect(201);
    const requirementId = created.body.data.id as string;
    const analyze = await request(app)
      .post(`/api/requirements/${requirementId}/analyze`)
      .send({})
      .expect(202);
    const analyzeRunId = analyze.body.data.agentRunId as string;
    await waitFor(async () => {
      const response = await request(app).get(`/api/agent-runs/${analyzeRunId}`).expect(200);
      const status = response.body.data.run.status as string;
      return ["succeeded", "failed", "cancelled", "timed_out"].includes(status)
        ? status
        : undefined;
    }, 60_000);
    const specs = await request(app)
      .get(`/api/requirements/${requirementId}/specifications`)
      .expect(200);
    expect(specs.body.data).toHaveLength(7);
    const specTypes = (specs.body.data as Array<{ type: string }>).map((spec) => spec.type);
    expect(specTypes).toEqual(
      expect.arrayContaining(["REQUIREMENT_ANALYSIS", "API", "DATABASE", "UI", "TECHNICAL"])
    );
    const graph = await request(app).get(`/api/requirements/${requirementId}/tasks`).expect(200);
    const planKeys = (graph.body.data.tasks as Array<{ taskKey: string }>).map(
      (task) => task.taskKey
    );
    expect(planKeys).toEqual([
      "TASK-001",
      "TASK-002",
      "TASK-003",
      "TASK-004",
      "TASK-005",
      "TASK-006",
      "TASK-007",
      "TASK-008",
      "TASK-009",
      "TASK-010"
    ]);
    expect(graph.body.data.dependencies.length).toBeGreaterThanOrEqual(9);
    const deliveryInput = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM tasks WHERE requirement_id = $1 AND input->'delivery' IS NOT NULL",
      [requirementId]
    );
    expect(Number(deliveryInput.rows[0].count)).toBe(4);

    // ── 2. Deterministic agent step scripts (decision stand-in; execution is real) ──
    const scripts: Record<string, object> = {
      "TASK-002": {
        deepAgentSteps: [
          {
            toolName: "edit_file",
            input: {
              path: "database/schema.sql",
              search: "-- TODO",
              replace:
                "CREATE TABLE todos (id text primary key, title text not null, completed boolean not null);"
            }
          }
        ]
      },
      "TASK-003": {
        deepAgentSteps: [
          {
            toolName: "edit_file",
            input: {
              path: "server/todos.cjs",
              search: "title: 'broken'",
              replace: "title: title.trim().toUpperCase()"
            }
          }
        ]
      },
      "TASK-004": {
        deepAgentSteps: [
          {
            toolName: "edit_file",
            input: {
              path: "web/index.html",
              search: "<main>TODO</main>",
              replace:
                '<main><h1>Todo</h1><form><input aria-label="Todo title" /><button type="button">Add</button></form><p>No todos yet.</p></main>'
            }
          }
        ]
      },
      "TASK-005": {
        deepAgentSteps: [
          { toolName: "run_unit_test", input: { command: "node --test tests/todos.test.mjs" } }
        ],
        failuresBeforeSuccess: 1,
        fixTaskType: "BACKEND",
        fixSteps: [
          {
            toolName: "edit_file",
            input: {
              path: "server/todos.cjs",
              search: "title: title.trim().toUpperCase()",
              replace: "title: title.trim()"
            }
          }
        ]
      },
      "TASK-006": {
        deepAgentSteps: [
          { toolName: "git_diff", input: {} },
          { toolName: "run_unit_test", input: { command: "node --test tests/todos.test.mjs" } }
        ]
      }
    };
    for (const [taskKey, execution] of Object.entries(scripts)) {
      await pool.query(
        "UPDATE tasks SET input = input || $3::jsonb WHERE requirement_id = $1 AND task_key = $2",
        [requirementId, taskKey, JSON.stringify({ execution })]
      );
    }

    // ── 3. Dynamic workflow: agents → QA fails → re-plan → review → CI → staging → approval ──
    const workflow = await request(app)
      .post("/api/workflows")
      .send({
        projectId,
        requirementId,
        workspacePath: workspace,
        policy: {
          maxConcurrency: 2,
          maxRetries: 1,
          failureStrategy: "REPLAN",
          allowRetry: true,
          allowReplan: true,
          approvalRequired: false
        }
      })
      .expect(201);
    const workflowId = workflow.body.data.id as string;
    await request(app).post(`/api/workflows/${workflowId}/start`).expect(200);

    const parked = await waitFor(async () => {
      const detail = await workflowService.getDetail(workflowId);
      return detail?.workflow.status === "WAITING_APPROVAL" ? detail : undefined;
    }, 240_000);

    // Human boundary blocks production: staging is live, production is NOT.
    const beforeApproval = await deployments.findMany(projectId);
    expect(beforeApproval).toHaveLength(1);
    const staged = beforeApproval[0];
    expect(staged?.environment).toBe("staging");
    expect(staged?.status).toBe("SUCCESS");
    expect(staged?.healthCheck).toEqual({ "/health": 200, "/ready": 200 });
    expect(staged?.image).toBeTruthy();
    if (staged?.image) images.add(staged.image);
    const production = parked.tasks.find((task) => task.taskKey === "TASK-010");
    expect(production?.approvalRequired).toBe(true);
    expect(production?.status).toBe("WAITING_APPROVAL");

    // SSE stream serves the live snapshot over real HTTP.
    const sse = await readWorkflowSse(app, workflowId);
    expect(sse.contentType).toContain("text/event-stream");
    expect(sse.text).toContain("event: snapshot");
    expect(sse.text).toContain(workflowId);

    // Agent registry page/API follows the current capability profile
    // (`new AgentRegistry()` ⇒ default frontend-vue ⇒ 5 enabled agents).
    // All 7 definitions remain in the catalog; backend-agent / database-agent
    // are hidden from this list until a profile enables them. DevOps for
    // non-delivery BUILD tasks is exercised end-to-end by professionalAgents.e2e.test.ts.
    const agents = await request(app).get("/api/agents").expect(200);
    expect(agents.body.data.map((agent: { name: string }) => agent.name)).toEqual([
      "planner-agent",
      "frontend-agent",
      "qa-agent",
      "reviewer-agent",
      "devops-agent"
    ]);
    const devops = await request(app).get("/api/agents/devops-agent").expect(200);
    expect(devops.body.data.definition.type).toBe("DEVOPS");

    // Approve → production deploys.
    const approvalId = parked.approvals.find((approval) => approval.status === "PENDING")?.id;
    expect(approvalId).toBeTruthy();
    await request(app)
      .post(`/api/approvals/${approvalId}/approve`)
      .send({ comment: "golden approval" })
      .expect(200);
    const finished = await workflowService.waitForTerminal(workflowId, 240_000);
    expect(finished?.workflow.status).toBe("SUCCESS");
    if (!finished) throw new Error("Workflow did not reach a terminal state");

    // ── 4. Chain assertions ──
    const dynamicTasks = finished.tasks.filter((task) => task.origin === "DYNAMIC");
    expect(dynamicTasks).toHaveLength(2);
    expect(finished.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "REPLAN_STARTED",
        "REPLAN_COMPLETED",
        "APPROVAL_REQUIRED",
        "APPROVAL_GRANTED",
        "WORKFLOW_COMPLETED"
      ])
    );
    const assigned = new Set(finished.tasks.map((task) => task.assignedAgent));
    expect([...assigned]).toEqual(
      expect.arrayContaining([
        "planner-agent",
        "database-agent",
        "backend-agent",
        "frontend-agent",
        "qa-agent",
        "reviewer-agent",
        // Delivery tasks (CI / deploy / verify) are executed by the existing
        // DeliveryOrchestrator, not by an agent — the DevOps function.
        "DeliveryOrchestrator"
      ])
    );

    // Claim protection: planned tasks start exactly once each.
    for (const key of ["TASK-001", "TASK-002", "TASK-003", "TASK-004", "TASK-006"]) {
      expect(startedEvents(finished, key), key).toBe(1);
    }
    // maxConcurrency ≤ 2 across the whole run.
    let runningIds = new Set<string>();
    let observedMax = 0;
    for (const event of finished.events) {
      if (event.eventType === "TASK_STARTED" && event.taskId) {
        runningIds.add(event.taskId);
        observedMax = Math.max(observedMax, runningIds.size);
      }
      if (
        ["TASK_COMPLETED", "TASK_FAILED", "TASK_CANCELLED"].includes(event.eventType) &&
        event.taskId
      ) {
        runningIds = new Set([...runningIds].filter((id) => id !== event.taskId));
      }
    }
    expect(observedMax).toBeLessThanOrEqual(2);

    // Real workspace outcome: files changed, real test passes after the fix task.
    expect(await readFile(path.join(workspace, "server/todos.cjs"), "utf8")).toContain(
      "title: title.trim()"
    );
    expect(await readFile(path.join(workspace, "web/index.html"), "utf8")).toContain(
      "No todos yet."
    );
    expect(await readFile(path.join(workspace, "database/schema.sql"), "utf8")).toContain(
      "CREATE TABLE todos"
    );
    const nodeTest = await execFileAsync("node", ["--test", "tests/todos.test.mjs"], {
      cwd: workspace
    });
    expect(nodeTest.stdout).toContain("pass 1");

    // Tool audit: real failure first, real success after the fix; delivery
    // tools (run_ci / deploy_release / verify_release) flow through the
    // same ToolRuntime.
    const toolRows = await pool.query<{ tool_name: string; status: string }>(
      "SELECT tool_name, status FROM tool_calls WHERE agent_run_id IN (SELECT id FROM agent_runs WHERE input->>'workflowRunId' = $1) ORDER BY created_at ASC",
      [workflowId]
    );
    expect(toolRows.rows.map((row) => row.tool_name)).toEqual(
      expect.arrayContaining([
        "edit_file",
        "run_unit_test",
        "git_diff",
        "run_ci",
        "deploy_release",
        "verify_release"
      ])
    );
    expect(
      toolRows.rows.some((row) => row.tool_name === "run_unit_test" && row.status === "failed")
    ).toBe(true);
    expect(
      toolRows.rows.some((row) => row.tool_name === "run_unit_test" && row.status === "succeeded")
    ).toBe(true);

    // Artifacts + persisted agent runs.
    const artifactRows = await pool.query<{ type: string }>(
      "SELECT type FROM agent_artifacts WHERE task_id IN (SELECT id FROM tasks WHERE workflow_run_id = $1)",
      [workflowId]
    );
    expect(artifactRows.rows.map((row) => row.type)).toEqual(
      expect.arrayContaining(["GENERATED_FILE", "TEST_RESULT", "CODE_DIFF", "REVIEW_RESULT"])
    );
    // CI status persistence (real local CI run tied to this workflow).
    const ciRuns = await pool.query<{
      status: string;
      provider: string;
      image: string | null;
      git_commit: string | null;
    }>("SELECT status, provider, image, git_commit FROM ci_runs WHERE workflow_run_id = $1", [
      workflowId
    ]);
    expect(ciRuns.rows).toHaveLength(1);
    expect(ciRuns.rows[0]?.status).toBe("SUCCESS");
    expect(ciRuns.rows[0]?.provider).toBe("local");
    expect(ciRuns.rows[0]?.image).toBeTruthy();
    const runCount = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM agent_runs WHERE input->>'workflowRunId' = $1",
      [workflowId]
    );
    expect(Number(runCount.rows[0].count)).toBeGreaterThanOrEqual(12);

    // Delivery: staging + production, traceable to this workflow, same image.
    const history = await deployments.findMany(projectId);
    expect(history).toHaveLength(2);
    const staging = history.find((entry) => entry.environment === "staging");
    const shipped = history.find((entry) => entry.environment === "production");
    expect(staging?.status).toBe("SUCCESS");
    expect(shipped?.status).toBe("SUCCESS");
    expect(shipped?.workflowRunId).toBe(workflowId);
    expect(shipped?.image).toBe(staging?.image);
    expect(shipped?.healthCheck).toEqual({ "/health": 200, "/ready": 200 });
    if (shipped?.image) images.add(shipped.image);
    const head = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })
    ).stdout.trim();
    expect(shipped?.gitCommit).toBe(head);

    // ── 5. Real Chromium over the page the frontend agent produced ──
    const staticServer = createServer(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await readFile(path.join(workspace, "web/index.html")));
    });
    await new Promise<void>((resolve) => staticServer.listen(0, "127.0.0.1", resolve));
    const staticAddress = staticServer.address();
    const staticPort = typeof staticAddress === "object" && staticAddress ? staticAddress.port : 0;
    const allowHttp: NavigateAllowlist = { allowedProtocols: ["http"] };
    const session = new BrowserSession({
      playwright: createRealPlaywright(),
      navigateAllowlist: allowHttp,
      sessionId: "browser:golden:1"
    });
    try {
      await session.launch({ headless: true });
      await session.setViewport(1280, 720);
      const runtime = new ToolRuntime({ tools: [...COMPUTER_USE_BROWSER_TOOLS] });
      const startedRecords: ToolCallStartedRecord[] = [];
      const finishedRecords: ToolCallFinishedRecord[] = [];
      const context = {
        requestId: "golden-browser",
        taskId: "golden-browser-task",
        agentRunId: "golden-browser-run",
        actor: "acceptance",
        workspacePath: workspace,
        sandbox: { async runCommand() {} },
        session
      } as unknown as AgentContext;
      const backend = new ToolRuntimeBackend({
        runtime,
        permissions: {
          tools: ["browser.action.navigate", "browser.observe", "browser.action.screenshot"],
          readPaths: [],
          writePaths: []
        } as AgentPermissions,
        context,
        toolCallRecorder: {
          async recordToolCallStarted(record) {
            startedRecords.push(record);
          },
          async recordToolCallFinished(record) {
            finishedRecords.push(record);
          }
        }
      });
      const nav = await backend.executeTool("browser.action.navigate", {
        url: `http://127.0.0.1:${staticPort}/index.html`
      });
      expect(nav.success, JSON.stringify(nav.error)).toBe(true);
      const observed = await backend.executeTool("browser.observe", {});
      expect(observed.success).toBe(true);
      const observation = observed.data as Observation;
      expect(observation.dom?.nodes.some((node) => node.text.includes("No todos yet."))).toBe(true);
      const shot = await backend.executeTool("browser.action.screenshot", {});
      expect(shot.success).toBe(true);
      const actionResult = shot.data as { observation?: { screenshotRef?: string } };
      expect(actionResult.observation?.screenshotRef?.startsWith("screenshot://")).toBe(true);
      expect(startedRecords.map((record) => record.toolName)).toEqual([
        "browser.action.navigate",
        "browser.observe",
        "browser.action.screenshot"
      ]);
      expect(finishedRecords.every((record) => record.status === "succeeded")).toBe(true);
    } finally {
      await session.close();
      await new Promise<void>((resolve) => staticServer.close(() => resolve()));
    }
  }, 600_000);

  it("pause / resume controls the scheduler through the REST surface", async () => {
    const requirementId = await seedRequirement({
      summary: "Pause drill",
      tasks: [plannedTask("A"), plannedTask("B", ["A"])]
    });
    await pool.query(
      "UPDATE tasks SET input = input || $2::jsonb WHERE requirement_id = $1 AND task_key = 'A'",
      [requirementId, JSON.stringify({ execution: { delayMs: 4000 } })]
    );
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
          approvalRequired: false
        }
      })
      .expect(201);
    const id = created.body.data.id as string;
    await request(app).post(`/api/workflows/${id}/start`).expect(200);
    await waitFor(
      async () =>
        (await workflows.findTasks(id)).find((task) => task.taskKey === "A")?.status === "RUNNING"
          ? true
          : undefined,
      30_000
    );
    const paused = await request(app).post(`/api/workflows/${id}/pause`).expect(200);
    expect(paused.body.data.status).toBe("PAUSED");
    await waitFor(
      async () =>
        (await workflows.findTasks(id)).find((task) => task.taskKey === "A")?.status === "SUCCESS"
          ? true
          : undefined,
      30_000
    );
    await sleep(700);
    const whilePaused = await workflowService.getDetail(id);
    expect(whilePaused?.workflow.status).toBe("PAUSED");
    expect(whilePaused?.tasks.find((task) => task.taskKey === "B")?.status).toBe("PENDING");
    if (!whilePaused) throw new Error("Paused workflow not found");
    expect(startedEvents(whilePaused, "B")).toBe(0);
    await request(app).post(`/api/workflows/${id}/resume`).expect(200);
    const finished = await workflowService.waitForTerminal(id, 60_000);
    if (!finished) throw new Error("Workflow did not finish after resume");
    expect(finished.workflow.status).toBe("SUCCESS");
    expect(startedEvents(finished, "B")).toBe(1);
  }, 180_000);

  it("cancel stops a running workflow through the REST surface", async () => {
    const requirementId = await seedRequirement({
      summary: "Cancel drill",
      tasks: [plannedTask("A")]
    });
    await pool.query(
      "UPDATE tasks SET input = input || $2::jsonb WHERE requirement_id = $1 AND task_key = 'A'",
      [requirementId, JSON.stringify({ execution: { delayMs: 6000 } })]
    );
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
          approvalRequired: false
        }
      })
      .expect(201);
    const id = created.body.data.id as string;
    await request(app).post(`/api/workflows/${id}/start`).expect(200);
    await waitFor(
      async () =>
        (await workflows.findTasks(id)).find((task) => task.taskKey === "A")?.status === "RUNNING"
          ? true
          : undefined,
      30_000
    );
    const cancelled = await request(app).post(`/api/workflows/${id}/cancel`).expect(200);
    expect(cancelled.body.data.status).toBe("CANCELLED");
    const detail = await workflowService.getDetail(id);
    expect(detail?.workflow.status).toBe("CANCELLED");
    expect(detail?.events.map((event) => event.eventType)).toContain("WORKFLOW_CANCELLED");
    expect(detail?.tasks.find((task) => task.taskKey === "A")?.status).toBe("CANCELLED");
  }, 180_000);

  it("server restart: a fresh engine recovers in-flight work and continues the workflow", async () => {
    const requirementId = await seedRequirement({
      summary: "Restart drill",
      tasks: [plannedTask("A"), plannedTask("B")]
    });
    const calls = new Map<string, number>();
    const crashExecutor: WorkflowTaskExecutor = {
      async execute(_workflow, task) {
        const attempt = (calls.get(task.taskKey) ?? 0) + 1;
        calls.set(task.taskKey, attempt);
        if (task.taskKey === "B" && attempt === 1) {
          // The "old server process" dies mid-task: its execution never settles.
          return new Promise<never>(() => {});
        }
        return { status: "succeeded", output: { attempt } } as TaskExecutionResult;
      },
      async cancel() {}
    };
    const firstProcess = new WorkflowService({ workflows, projects, executor: crashExecutor });
    const workflow = await firstProcess.create({
      projectId,
      requirementId,
      approvalTaskKeys: [],
      // F1-7（FX-23）：T3 未做前串行执行（maxConcurrency 钳为 1）——A 先完成、B 在途挂起。
      policy: {
        maxConcurrency: 1,
        maxRetries: 1,
        failureStrategy: "FAIL_FAST",
        allowRetry: false,
        allowReplan: false,
        approvalRequired: false
      }
    });
    await firstProcess.start(workflow.id);
    await waitFor(async () => {
      const tasks = await workflows.findTasks(workflow.id);
      const aDone = tasks.find((task) => task.taskKey === "A")?.status === "SUCCESS";
      const bRunning = tasks.find((task) => task.taskKey === "B")?.status === "RUNNING";
      return aDone && bRunning ? true : undefined;
    }, 30_000);
    expect(calls.get("A")).toBe(1);
    expect(calls.get("B")).toBe(1);

    // "Restart": a brand-new server process builds a fresh engine over the same store.
    const restartedProcess = new WorkflowService({
      workflows,
      projects,
      executor: crashExecutor
    });
    const recovered = await restartedProcess.recover();
    expect(recovered).toBe(1);
    const finished = await restartedProcess.waitForTerminal(workflow.id, 60_000);
    if (!finished) throw new Error("Recovered workflow did not finish");
    expect(finished.workflow.status).toBe("SUCCESS");
    expect(finished.events.some((event) => event.eventType === "WORKFLOW_RESUMED")).toBe(true);
    const resumed = finished.events.find((event) => event.eventType === "WORKFLOW_RESUMED");
    expect((resumed?.payload as { recovery?: boolean })?.recovery).toBe(true);
    // In-flight work was re-claimed and completed; completed work was NOT re-executed.
    expect(calls.get("A")).toBe(1);
    expect(calls.get("B")).toBe(2);
    expect(startedEvents(finished, "A")).toBe(1);
    expect(startedEvents(finished, "B")).toBe(2);
    const tasks = await workflows.findTasks(workflow.id);
    expect(tasks.every((task) => task.status === "SUCCESS")).toBe(true);
  }, 180_000);
});
