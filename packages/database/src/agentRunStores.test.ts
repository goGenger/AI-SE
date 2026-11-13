import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";
import { PgAgentRunStore, PgToolCallStore, PgWorkflowEventStore } from "./agentRunStores";
import { PgPlanningRepository } from "./planningRepositories";
import { PgProjectRepository } from "./projectRepository";
import { PgWorkflowRepository } from "./workflowRepositories";

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres(): Promise<{ pool: Pool; stop: () => Promise<void> }> {
  const name = `ai-se-postgres-test-${randomUUID()}`;

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

  const pool = new Pool({
    connectionString: `postgres://aise@127.0.0.1:${port}/aise`,
    max: 2
  });

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

describe("Phase 2 persistence stores", () => {
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

  it("applies the agent runtime migration", async () => {
    const result = await pool.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('agent_runs', 'tool_calls', 'workflow_events')
        ORDER BY table_name
      `
    );

    expect(result.rows.map((row) => row.table_name)).toEqual([
      "agent_runs",
      "tool_calls",
      "workflow_events"
    ]);
  });

  it("persists agent runs, tool calls and workflow events", async () => {
    const agentRuns = new PgAgentRunStore(pool);
    const toolCalls = new PgToolCallStore(pool);
    const events = new PgWorkflowEventStore(pool);

    const run = await agentRuns.create({
      taskId: randomUUID(),
      input: { task: "fix tests" },
      maxIterations: 12
    });

    expect(run.status).toBe("created");

    const running = await agentRuns.update(run.id, {
      status: "running",
      currentIteration: 1,
      startedAt: new Date().toISOString()
    });
    expect(running?.currentIteration).toBe(1);

    await toolCalls.start({
      agentRunId: run.id,
      iteration: 1,
      toolCallId: "tool-1",
      toolName: "read_file",
      input: { summary: "read calculator" }
    });

    const finishedTool = await toolCalls.finish({
      agentRunId: run.id,
      toolCallId: "tool-1",
      status: "succeeded",
      output: { summary: "file read" },
      duration: 15
    });
    expect(finishedTool?.status).toBe("succeeded");

    const event = await events.create({
      agentRunId: run.id,
      eventType: "agent_iteration",
      payload: { iteration: 1, status: "running" }
    });
    expect(event.eventType).toBe("agent_iteration");

    const detail = await agentRuns.update(run.id, {
      status: "succeeded",
      output: { finalResult: "done" },
      finishedAt: new Date().toISOString()
    });

    expect(detail?.status).toBe("succeeded");
    await expect(toolCalls.findByAgentRunId(run.id)).resolves.toHaveLength(1);
    await expect(events.findByAgentRunId(run.id)).resolves.toHaveLength(1);
  });

  it("UX-03: resolves the run context chain (project / workflow / task) and task failure events", async () => {
    const agentRuns = new PgAgentRunStore(pool);
    const events = new PgWorkflowEventStore(pool);
    const projects = new PgProjectRepository(pool);
    const planning = new PgPlanningRepository(pool);
    const workflows = new PgWorkflowRepository(pool);

    const project = await projects.create({
      name: "UX-03 项目",
      description: "",
      repository: `https://github.com/example/${randomUUID()}`,
      status: "active"
    });
    const requirement = await planning.createRequirement(project.id, {
      title: "UX-03 需求",
      description: "",
      rawContent: "Run one task."
    });
    await planning.savePlanningResult({
      projectId: project.id,
      requirementId: requirement.id,
      requirementVersion: 1,
      version: 1,
      analysis: {
        id: "ANALYSIS",
        summary: "UX-03",
        goals: [],
        constraints: [],
        assumptions: [],
        acceptanceCriteria: [],
        risks: []
      },
      specifications: [
        { type: "FUNCTIONAL", content: { requirements: [] } },
        { type: "TECHNICAL", content: { requirements: [] } },
        { type: "ARCHITECTURE", content: { components: [], dataFlow: [] } },
        { type: "API", content: { endpoints: [] } },
        { type: "DATABASE", content: { tables: [] } },
        { type: "UI", content: { pages: [] } }
      ],
      taskPlan: {
        summary: "UX-03 plan",
        tasks: [
          {
            id: "A",
            title: "A",
            description: "Root A",
            type: "BACKEND",
            priority: "MEDIUM",
            dependencies: [],
            estimatedComplexity: 1,
            acceptanceCriteria: ["A done"],
            sourceSpecTypes: ["TECHNICAL"]
          }
        ]
      }
    });
    const workflow = await workflows.create({
      projectId: project.id,
      requirementId: requirement.id,
      policy: {
        maxConcurrency: 1,
        maxRetries: 2,
        failureStrategy: "RETRY",
        allowRetry: true,
        allowReplan: false,
        approvalRequired: false
      },
      approvalTaskKeys: []
    });
    const task = (await workflows.findTasks(workflow.id))[0];

    const run = await agentRuns.create({
      projectId: project.id,
      taskId: task.id,
      input: {
        runtime: "professional-deep-agent",
        workflowRunId: workflow.id,
        taskKey: task.taskKey,
        agentName: "backend-agent",
        agentType: "BACKEND"
      },
      maxIterations: 8
    });

    // 列表 DTO：服务端解析的上下文（无需前端二次映射）
    const summary = (await agentRuns.findMany()).find((item) => item.id === run.id);
    expect(summary?.projectName).toBe("UX-03 项目");
    expect(summary?.requirementName).toBe("UX-03 需求");
    expect(summary?.planningVersion).toBe(1);
    expect(summary?.workflowRunId).toBe(workflow.id);
    expect(summary?.taskKey).toBe(task.taskKey);
    expect(summary?.taskTitle).toBe("A");
    expect(summary?.agentName).toBe("backend-agent");
    expect(summary?.agentType).toBe("BACKEND");

    // 详情上下文链
    const context = await agentRuns.findContext(run.id);
    expect(context?.projectName).toBe("UX-03 项目");
    expect(context?.workflow).toEqual({
      id: workflow.id,
      requirementName: "UX-03 需求",
      planningVersion: 1
    });
    expect(context?.task?.id).toBe(task.id);
    expect(context?.task?.taskKey).toBe(task.taskKey);
    expect(context?.task?.title).toBe("A");
    expect(context?.agentName).toBe("backend-agent");
    expect(context?.maxRetries).toBe(2);

    // 任务失败事件（窄查询：只取恢复相关类型）
    await events.create({
      workflowRunId: workflow.id,
      taskId: task.id,
      eventType: "FAILURE_ROUTED",
      payload: { strategy: "RETRY" }
    });
    await events.create({
      workflowRunId: workflow.id,
      taskId: task.id,
      eventType: "TASK_RETRYING",
      payload: { retryCount: 1 }
    });
    await events.create({
      workflowRunId: workflow.id,
      taskId: task.id,
      eventType: "TASK_STARTED",
      payload: {}
    });
    const failureEvents = await events.findTaskFailureEvents(workflow.id, task.id);
    expect(failureEvents.map((event) => event.eventType)).toEqual([
      "FAILURE_ROUTED",
      "TASK_RETRYING"
    ]);
  });
});
