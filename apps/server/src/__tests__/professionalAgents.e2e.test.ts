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
import { DockerSandbox } from "@ai-se/sandbox";
import { RequirementAnalysis, TaskPlan } from "@ai-se/shared";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { TaskContextBuilder } from "../services/taskContextBuilder";
import { createWorkflowRequestIdResolver } from "../services/workflowCorrelation";
import { WorkflowService } from "../services/workflowService";
import { PersistentWorkflowTaskExecutor } from "../services/workflowTaskExecutor";

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres() {
  const name = `ai-se-phase5-postgres-${randomUUID()}`;
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
  id: "TODO-ANALYSIS",
  summary: "Create a small Todo full-stack project.",
  goals: ["Persist, expose, render, test, and review Todos"],
  constraints: ["Use the existing project structure"],
  assumptions: [],
  acceptanceCriteria: ["Tests and review pass"],
  risks: []
};

function plannedTask(
  id: string,
  type: TaskPlan["tasks"][number]["type"],
  dependencies: string[]
): TaskPlan["tasks"][number] {
  return {
    id,
    title: id,
    description: `Complete ${id}`,
    type,
    priority: "MEDIUM",
    dependencies,
    estimatedComplexity: 1,
    acceptanceCriteria: [`${id} succeeds`],
    sourceSpecTypes: ["TECHNICAL"]
  };
}

describe("Phase 5 Professional Multi-Agent E2E", () => {
  let stopPostgres: () => Promise<void>;
  let workspaceRoot: string;
  let workspace: string;

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "ai-se-phase5-workspaces-"));
    workspace = path.join(workspaceRoot, "todo-project");
    await Promise.all([
      mkdir(path.join(workspace, "database"), { recursive: true }),
      mkdir(path.join(workspace, "server"), { recursive: true }),
      mkdir(path.join(workspace, "web"), { recursive: true }),
      mkdir(path.join(workspace, "tests"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(workspace, "database/schema.sql"), "-- TODO\n"),
      writeFile(
        path.join(workspace, "server/todos.cjs"),
        "exports.createTodo = (title) => ({ id: 'todo-1', title: 'broken', completed: false });\n"
      ),
      writeFile(path.join(workspace, "web/index.html"), "<main>TODO</main>\n"),
      writeFile(
        path.join(workspace, "tests/todo.test.mjs"),
        [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import todos from '../server/todos.cjs';",
          "test('creates a Todo', () => assert.equal(todos.createTodo('Ship').title, 'Ship'));"
        ].join("\n")
      )
    ]);
    await execFileAsync("git", ["init", "-q"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "ai-se@example.test"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "AI-SE"], { cwd: workspace });
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: workspace });
  });

  afterAll(async () => {
    await stopPostgres?.();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("builds, repairs, tests, and reviews a Todo project through real tools and Docker Sandbox", async () => {
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
    const agentRunService = new AgentRunService({
      agentRuns,
      toolCalls,
      workflowEvents,
      projects,
      cancellationStore,
      logger
    });
    const workflowService = new WorkflowService({
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
        sandbox: new DockerSandbox({ allowedWorkspaceRoot: workspaceRoot, logger }),
        requestId: createWorkflowRequestIdResolver(workflowEvents, logger),
        llmProvider: "mock",
        logger
      })
    });
    const app = createApp({
      logger,
      projectRepository: projects,
      agentRunService,
      workflowService,
      agentRegistryService: new AgentRegistryService({ registry, agentRuns, artifacts }),
      checkDatabase: async () => {
        await pool.query("SELECT 1");
      },
      checkRedis: async () => undefined,
      corsOrigin: "http://localhost:5173"
    });

    const project = await projects.create({
      name: "Todo E2E",
      description: "Phase 5",
      repository: `https://example.com/${randomUUID()}`,
      status: "active"
    });
    const requirement = await planning.createRequirement(project.id, {
      title: "Todo Management",
      description: "",
      rawContent: "Build a Todo database, API module, UI, tests, build, and review."
    });
    const taskPlan: TaskPlan = {
      summary: "Professional Agent Todo plan",
      tasks: [
        plannedTask("PLAN", "DESIGN", []),
        plannedTask("DB", "DATABASE", ["PLAN"]),
        plannedTask("FRONTEND", "FRONTEND", ["PLAN"]),
        plannedTask("BACKEND", "BACKEND", ["DB"]),
        plannedTask("BUILD", "BUILD", ["BACKEND", "FRONTEND"]),
        plannedTask("QA", "TEST", ["BACKEND", "FRONTEND"]),
        plannedTask("REVIEW", "REVIEW", ["BUILD", "QA"])
      ]
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

    const scripts: Record<string, object> = {
      DB: {
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
      FRONTEND: {
        deepAgentSteps: [
          {
            toolName: "edit_file",
            input: {
              path: "web/index.html",
              search: "<main>TODO</main>",
              replace:
                '<main><form><input aria-label="Todo title"><button>Add</button></form><p>No todos yet.</p></main>'
            }
          }
        ]
      },
      BACKEND: {
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
      BUILD: {
        deepAgentSteps: [
          { toolName: "run_build", input: { command: "node --check server/todos.cjs" } }
        ]
      },
      QA: {
        deepAgentSteps: [
          { toolName: "run_unit_test", input: { command: "node --test tests/todo.test.mjs" } }
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
      REVIEW: {
        deepAgentSteps: [
          { toolName: "git_diff", input: {} },
          { toolName: "run_unit_test", input: { command: "node --test tests/todo.test.mjs" } }
        ]
      }
    };
    for (const [taskKey, execution] of Object.entries(scripts)) {
      await pool.query(
        "UPDATE tasks SET input = input || $3::jsonb WHERE requirement_id = $1 AND task_key = $2",
        [requirement.id, taskKey, JSON.stringify({ execution })]
      );
    }

    const created = await request(app)
      .post("/api/workflows")
      .send({
        projectId: project.id,
        requirementId: requirement.id,
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
    const workflowId = created.body.data.id as string;
    await request(app).post(`/api/workflows/${workflowId}/start`).expect(200);
    const detail = await workflowService.waitForTerminal(workflowId, 90_000);
    expect(detail?.workflow.status).toBe("SUCCESS");

    const taskAgents = new Set(detail?.tasks.map((task) => task.assignedAgent));
    expect([...taskAgents]).toEqual(
      expect.arrayContaining([
        "planner-agent",
        "database-agent",
        "backend-agent",
        "frontend-agent",
        "devops-agent",
        "qa-agent",
        "reviewer-agent"
      ])
    );
    expect(detail?.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["REPLAN_STARTED", "REPLAN_COMPLETED", "agent_resolved"])
    );
    const persistedToolCalls = await pool.query<{
      tool_name: string;
      status: string;
      error: unknown;
    }>("SELECT tool_name, status, error FROM tool_calls ORDER BY created_at ASC");
    expect(persistedToolCalls.rows.map((row) => row.tool_name)).toEqual(
      expect.arrayContaining(["edit_file", "run_unit_test", "run_build", "git_diff"])
    );
    expect(persistedToolCalls.rows.some((row) => row.status === "failed")).toBe(true);
    const toolEvents = detail?.events.filter(
      (event) => event.eventType === "tool_call_finished" && event.payload.status === "failed"
    );
    expect(
      persistedToolCalls.rows.some(
        (row) => row.tool_name === "run_unit_test" && row.status === "succeeded"
      ),
      JSON.stringify({ persistedToolCalls: persistedToolCalls.rows, toolEvents })
    ).toBe(true);
    const persistedArtifacts = await artifacts.findMany();
    expect(persistedArtifacts.map((artifact) => artifact.type)).toEqual(
      expect.arrayContaining([
        "GENERATED_FILE",
        "TEST_RESULT",
        "BUILD_RESULT",
        "CODE_DIFF",
        "REVIEW_RESULT"
      ])
    );
    expect(await readFile(path.join(workspace, "server/todos.cjs"), "utf8")).toContain(
      "title: title.trim()"
    );
    const tests = await execFileAsync("node", ["--test", "tests/todo.test.mjs"], {
      cwd: workspace
    });
    expect(tests.stdout).toContain("pass 1");

    const metrics = await artifacts.metrics();
    expect(metrics.taskSuccessRate).toBeGreaterThan(0.8);
    expect(metrics.repairSuccessRate).toBe(1);
  }, 180_000);

  it("routes outcomes through submit_result in tool mode and keeps legacy text behavior when off (C-1/T2)", async () => {
    const postgres = await startPostgres();
    const previousStop = stopPostgres;
    stopPostgres = async () => {
      await postgres.stop();
      await previousStop?.();
    };
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
    const agentRunService = new AgentRunService({
      agentRuns,
      toolCalls,
      workflowEvents,
      projects,
      cancellationStore,
      logger
    });

    const runScenario = async (submitResultMode: "tool" | "text", steps: object[]) => {
      const workflowService = new WorkflowService({
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
          sandbox: new DockerSandbox({ allowedWorkspaceRoot: workspaceRoot, logger }),
          requestId: createWorkflowRequestIdResolver(workflowEvents, logger),
          llmProvider: "mock",
          submitResultMode,
          logger
        })
      });
      const app = createApp({
        logger,
        projectRepository: projects,
        agentRunService,
        workflowService,
        agentRegistryService: new AgentRegistryService({ registry, agentRuns, artifacts }),
        checkDatabase: async () => {
          await pool.query("SELECT 1");
        },
        checkRedis: async () => undefined,
        corsOrigin: "http://localhost:5173"
      });
      const project = await projects.create({
        name: `submit-result-${submitResultMode}-${randomUUID().slice(0, 8)}`,
        description: "T2 wiring",
        repository: `https://example.com/${randomUUID()}`,
        status: "active"
      });
      const requirement = await planning.createRequirement(project.id, {
        title: "Submit Result Wiring",
        description: "",
        rawContent: "Produce a single plan task."
      });
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
        taskPlan: { summary: "submit_result plan", tasks: [plannedTask("PLAN", "DESIGN", [])] }
      });
      await pool.query(
        "UPDATE tasks SET input = input || $3::jsonb WHERE requirement_id = $1 AND task_key = $2",
        [requirement.id, "PLAN", JSON.stringify({ execution: { deepAgentSteps: steps } })]
      );
      const created = await request(app)
        .post("/api/workflows")
        .send({
          projectId: project.id,
          requirementId: requirement.id,
          workspacePath: workspace,
          policy: {
            maxConcurrency: 1,
            maxRetries: 1,
            failureStrategy: "REPLAN",
            allowRetry: true,
            allowReplan: true,
            approvalRequired: false
          }
        })
        .expect(201);
      const workflowId = created.body.data.id as string;
      await request(app).post(`/api/workflows/${workflowId}/start`).expect(200);
      const detail = await workflowService.waitForTerminal(workflowId, 90_000);
      // 运行时任务行与计划模板行分离（requirement_id 为空、经 workflowRunId 关联），输出从 detail 读取。
      const task = detail?.tasks.find((entry) => entry.taskKey === "PLAN");
      const output = task?.output as unknown as
        | { agentRunId?: string; outcomeMode?: string; summary?: string }
        | undefined;
      const toolRows = output?.agentRunId
        ? (
            await pool.query<{ tool_name: string; status: string }>(
              "SELECT tool_name, status FROM tool_calls WHERE agent_run_id = $1",
              [output.agentRunId]
            )
          ).rows
        : [];
      return { detail, output, toolRows };
    };

    const submitted = await runScenario("tool", [
      {
        toolName: "submit_result",
        input: {
          status: "SUCCESS",
          summary: "submitted via submit_result tool",
          artifacts: [],
          issues: [],
          recommendations: [],
          metadata: {}
        }
      }
    ]);
    expect(submitted.detail?.workflow.status).toBe("SUCCESS");
    expect(
      submitted.output?.outcomeMode,
      JSON.stringify({ output: submitted.output, toolRows: submitted.toolRows })
    ).toBe("tool");
    expect(submitted.output?.summary).toBe("submitted via submit_result tool");
    expect(submitted.toolRows).toEqual(
      expect.arrayContaining([{ tool_name: "submit_result", status: "succeeded" }])
    );

    const fallback = await runScenario("tool", []);
    expect(fallback.detail?.workflow.status).toBe("SUCCESS");
    expect(
      fallback.output?.outcomeMode,
      JSON.stringify({ output: fallback.output, toolRows: fallback.toolRows })
    ).toBe("text-fallback");
    expect(fallback.toolRows.some((row) => row.tool_name === "submit_result")).toBe(false);

    const off = await runScenario("text", []);
    expect(off.detail?.workflow.status).toBe("SUCCESS");
    expect(
      off.output?.outcomeMode,
      JSON.stringify({ output: off.output, toolRows: off.toolRows })
    ).toBe("text");
    expect(off.toolRows.some((row) => row.tool_name === "submit_result")).toBe(false);
  }, 180_000);
});
