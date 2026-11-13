import { RequirementAnalysis, TaskPlan } from "@ai-se/shared";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgAgentRunStore } from "./agentRunStores";
import { PgDeploymentRepository } from "./deploymentRepository";
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
  const name = `ai-se-delivery-postgres-test-${randomUUID()}`;
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
  const pool = new Pool({ connectionString: `postgres://aise@127.0.0.1:${port}/aise` });
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
  summary: "Deliver an image",
  goals: ["Deploy"],
  constraints: [],
  assumptions: [],
  acceptanceCriteria: ["Deployment succeeds"],
  risks: []
};

const taskPlan: TaskPlan = {
  summary: "CI then deploy",
  tasks: [
    {
      id: "BUILD",
      title: "Build",
      description: "Run CI",
      type: "BUILD",
      priority: "HIGH",
      dependencies: [],
      estimatedComplexity: 1,
      acceptanceCriteria: ["CI succeeds"],
      sourceSpecTypes: ["TECHNICAL"],
      delivery: { action: "CI", ref: "main", workflowFile: "ci.yml" }
    },
    {
      id: "DEPLOY",
      title: "Deploy production",
      description: "Deploy image",
      type: "DEPLOY",
      priority: "HIGH",
      dependencies: ["BUILD"],
      estimatedComplexity: 1,
      acceptanceCriteria: ["Health checks pass"],
      sourceSpecTypes: ["ARCHITECTURE"],
      delivery: { action: "DEPLOY", environment: "production" }
    }
  ]
};

describe("Phase 6 deployment repository", () => {
  let pool: Pool;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await runMigrations(pool);
  }, 180_000);

  afterAll(async () => stop?.());

  it("persists environments, CI traceability, deployments, logs, and idempotency", async () => {
    const projects = new PgProjectRepository(pool);
    const planning = new PgPlanningRepository(pool);
    const workflows = new PgWorkflowRepository(pool);
    const agentRuns = new PgAgentRunStore(pool);
    const repository = new PgDeploymentRepository(pool);
    const project = await projects.create({
      name: "Delivery",
      description: "Phase 6",
      repository: `https://github.com/example/${randomUUID()}`,
      status: "active"
    });
    const requirement = await planning.createRequirement(project.id, {
      title: "Delivery",
      description: "",
      rawContent: "Build and deploy"
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
      taskPlan
    });
    const workflow = await workflows.create({
      projectId: project.id,
      requirementId: requirement.id,
      policy: {
        maxConcurrency: 1,
        maxRetries: 1,
        failureStrategy: "ROLLBACK",
        allowRetry: false,
        allowReplan: false,
        approvalRequired: false
      },
      approvalTaskKeys: []
    });
    const [buildTask, deployTask] = await workflows.findTasks(workflow.id);
    expect(deployTask.approvalRequired).toBe(true);
    const agentRun = await agentRuns.create({
      projectId: project.id,
      taskId: buildTask.id,
      input: { runtime: "delivery" },
      maxIterations: 1
    });
    const environment = await repository.upsertEnvironment({
      projectId: project.id,
      name: "production",
      endpoint: "http://localhost:18002",
      adapter: "docker",
      configuration: { hostPort: 18002, containerPort: 3000 }
    });
    expect(environment.secretReference).toBeUndefined();
    const ci = await repository.createCiRun({
      projectId: project.id,
      workflowRunId: workflow.id,
      taskId: buildTask.id,
      agentRunId: agentRun.id,
      provider: "github",
      workflowFile: "ci.yml"
    });
    const successfulCi = await repository.updateCiRun(ci.id, {
      status: "SUCCESS",
      providerRunId: "42",
      gitCommit: "abcdef1234567890",
      pullRequest: 12,
      image: "ghcr.io/example/app:abcdef1234567890",
      finishedAt: new Date().toISOString()
    });
    expect(successfulCi?.gitCommit).toBe("abcdef1234567890");
    expect(successfulCi?.pullRequest).toBe(12);
    const created = await repository.createDeployment({
      projectId: project.id,
      workflowRunId: workflow.id,
      taskId: deployTask.id,
      agentRunId: agentRun.id,
      ciRunId: ci.id,
      version: "abcdef1234567890",
      environment: "production",
      image: "ghcr.io/example/app:abcdef1234567890",
      gitCommit: "abcdef1234567890",
      endpoint: environment.endpoint,
      idempotencyKey: `${workflow.id}:${deployTask.id}:DEPLOY`
    });
    const duplicate = await repository.createDeployment({
      projectId: project.id,
      workflowRunId: workflow.id,
      taskId: deployTask.id,
      ciRunId: ci.id,
      version: "abcdef1234567890",
      environment: "production",
      image: "ghcr.io/example/app:abcdef1234567890",
      gitCommit: "abcdef1234567890",
      endpoint: environment.endpoint,
      idempotencyKey: `${workflow.id}:${deployTask.id}:DEPLOY`
    });
    expect(duplicate.id).toBe(created.id);
    await repository.appendLog(created.id, "info", "health check passed");
    const finished = await repository.updateDeployment(created.id, {
      status: "SUCCESS",
      healthCheck: { "/health": 200, "/ready": 200 },
      finishedAt: new Date().toISOString()
    });
    expect(finished?.workflowRunId).toBe(workflow.id);
    expect(finished?.ciRunId).toBe(ci.id);
    expect(await repository.findLogs(created.id)).toHaveLength(1);
  });
});
