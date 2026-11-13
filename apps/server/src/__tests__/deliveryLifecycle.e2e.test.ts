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
import { RequirementAnalysis, TaskPlan } from "@ai-se/shared";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeploymentOrchestrator } from "../services/deploymentOrchestrator";
import {
  LocalCiOperations,
  LocalDockerOperations,
  createDeliveryOperations
} from "../services/deliveryAdapters";
import { WorkflowService } from "../services/workflowService";
import { createWorkflowRequestIdResolver } from "../services/workflowCorrelation";

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 180_000 });
  return stdout.trim();
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const analysis: RequirementAnalysis = {
  id: "DELIVERY_E2E",
  summary: "Deliver a real container",
  goals: ["Deploy and rollback"],
  constraints: [],
  assumptions: [],
  acceptanceCriteria: ["Health checks pass"],
  risks: []
};

const plan: TaskPlan = {
  summary: "Build and deploy staging",
  tasks: [
    {
      id: "CI",
      title: "Run CI",
      description: "Run all quality gates and build an immutable image.",
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
      title: "Deploy staging",
      description: "Deploy and verify the image.",
      type: "DEPLOY",
      priority: "HIGH",
      dependencies: ["CI"],
      estimatedComplexity: 1,
      acceptanceCriteria: ["Staging is healthy"],
      sourceSpecTypes: ["ARCHITECTURE"],
      delivery: { action: "DEPLOY", environment: "staging" }
    }
  ]
};

describe("Phase 6 real local delivery lifecycle E2E", () => {
  let stop: () => Promise<void>;
  let workspace = "";
  let postgresContainer = "";
  let releaseContainer = "";
  let pool: ReturnType<typeof createPool>;
  let projects: PgProjectRepository;
  let planning: PgPlanningRepository;
  let workflows: PgWorkflowRepository;
  let deployments: PgDeploymentRepository;
  let workflowService: WorkflowService;
  let projectId = "";
  const images = new Set<string>();

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "ai-se-delivery-e2e-"));
    await cp(path.resolve("../../examples/delivery-test-project"), workspace, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "ai-se@example.test"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "AI-SE"], { cwd: workspace });
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "healthy release"], { cwd: workspace });

    postgresContainer = `ai-se-delivery-lifecycle-db-${randomUUID()}`;
    await docker([
      "run",
      "-d",
      "--rm",
      "--name",
      postgresContainer,
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
    const databasePort = (await docker(["port", postgresContainer, "5432/tcp"])).split(":").at(-1);
    if (!databasePort) throw new Error("Cannot resolve PostgreSQL port");
    pool = createPool(`postgres://aise@127.0.0.1:${databasePort}/aise`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await pool.query("SELECT 1");
        break;
      } catch {
        await sleep(500);
      }
    }
    await runMigrations(pool);
    projects = new PgProjectRepository(pool);
    planning = new PgPlanningRepository(pool);
    workflows = new PgWorkflowRepository(pool);
    deployments = new PgDeploymentRepository(pool);
    const agentRuns = new PgAgentRunStore(pool);
    const toolCalls = new PgToolCallStore(pool);
    const workflowEvents = new PgWorkflowEventStore(pool);
    const logger = createLogger({ enabled: false });
    const orchestrator = new DeploymentOrchestrator({
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
          throw new Error("Delivery E2E must not use the coding sandbox");
        }
      },
      logger
    });
    workflowService = new WorkflowService({ workflows, projects, executor: orchestrator });
    const project = await projects.create({
      name: "Real delivery E2E",
      description: "Phase 6",
      repository: "https://local.test/ai-se-delivery-e2e",
      status: "active"
    });
    projectId = project.id;
    const hostPort = await freePort();
    releaseContainer = `ai-se-delivery-e2e-${randomUUID()}`;
    await deployments.upsertEnvironment({
      projectId,
      name: "staging",
      endpoint: `http://127.0.0.1:${hostPort}`,
      adapter: "docker",
      configuration: { containerName: releaseContainer, hostPort, containerPort: 3000 }
    });
    stop = async () => {
      await pool.end();
      await docker(["rm", "-f", releaseContainer]).catch(() => undefined);
      for (const image of images) await docker(["image", "rm", "-f", image]).catch(() => undefined);
      await docker(["rm", "-f", postgresContainer]).catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    };
  }, 180_000);

  afterAll(async () => stop?.());

  async function createWorkflow(failureStrategy: "FAIL_FAST" | "ROLLBACK") {
    const requirement = await planning.createRequirement(projectId, {
      title: `Delivery ${randomUUID()}`,
      description: "",
      rawContent: "Build and deploy the current Git commit"
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
    return await workflowService.create({
      projectId,
      requirementId: requirement.id,
      workspacePath: workspace,
      policy: {
        maxConcurrency: 1,
        maxRetries: 1,
        failureStrategy,
        allowRetry: false,
        allowReplan: false,
        approvalRequired: false
      },
      approvalTaskKeys: []
    });
  }

  it("deploys a healthy image, then rolls a broken image back to the previous version", async () => {
    const healthyWorkflow = await createWorkflow("FAIL_FAST");
    await workflowService.start(healthyWorkflow.id);
    const healthyResult = await workflowService.waitForTerminal(healthyWorkflow.id, 180_000);
    expect(healthyResult?.workflow.status).toBe("SUCCESS");
    const healthyDeployment = await deployments.findLatestSuccessful(projectId, "staging");
    expect(healthyDeployment?.status).toBe("SUCCESS");
    images.add(healthyDeployment!.image);

    await writeFile(path.join(workspace, "health-status.txt"), "broken\n");
    await execFileAsync("git", ["add", "health-status.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "broken release"], { cwd: workspace });

    const brokenWorkflow = await createWorkflow("ROLLBACK");
    await workflowService.start(brokenWorkflow.id);
    const recovered = await workflowService.waitForTerminal(brokenWorkflow.id, 180_000);
    expect(recovered?.workflow.status).toBe("SUCCESS");
    const history = await deployments.findMany(projectId);
    const rollback = history.find(
      (deployment) =>
        deployment.workflowRunId === brokenWorkflow.id && deployment.operation === "ROLLBACK"
    );
    const failed = history.find(
      (deployment) =>
        deployment.workflowRunId === brokenWorkflow.id && deployment.operation === "DEPLOY"
    );
    expect(failed?.status).toBe("ROLLED_BACK");
    expect(rollback?.status).toBe("SUCCESS");
    expect(rollback?.version).toBe(healthyDeployment?.version);
    images.add(failed!.image);
    const events = await workflows.findEvents(brokenWorkflow.id);
    expect(events.map((event) => event.eventType)).toContain("ROLLBACK_TASK_CREATED");
    expect(events.map((event) => event.eventType)).toContain("DEPLOYMENT_FINISHED");
  }, 360_000);
});
