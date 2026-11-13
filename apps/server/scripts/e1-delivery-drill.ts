/**
 * D-4 drill bootstrap (docs/123): seeds the delivery-drill requirement and two
 * plan versions for the [eval] E1 project, then drives workflow creation and
 * start through the platform API. It never touches deployments or containers
 * directly -- every deploy action must be triggered by the platform.
 *
 * Run from the repo root with .env sourced:
 *   corepack pnpm --filter @ai-se/server exec tsx scripts/e1-delivery-drill.ts seed
 *   corepack pnpm --filter @ai-se/server exec tsx scripts/e1-delivery-drill.ts run1
 *   corepack pnpm --filter @ai-se/server exec tsx scripts/e1-delivery-drill.ts run2
 *   corepack pnpm --filter @ai-se/server exec tsx scripts/e1-delivery-drill.ts status
 *
 * Env: DRILL_BASE_URL (default http://127.0.0.1:47557), DATABASE_URL (from .env).
 * Flag: --new  allow creating another workflow when one already exists for the version.
 */
import { createPool, PgPlanningRepository } from "@ai-se/database";
import { RequirementAnalysis, TaskPlan } from "@ai-se/shared";

const BASE_URL = process.env.DRILL_BASE_URL ?? "http://127.0.0.1:47557";
const PROJECT_ID = "f72e8999-55a7-4cc5-bcde-0719a4d13c40";
const WORKSPACE = "/Users/shixianbao/Desktop/study/ai-se-eval/repos/e1-taskboard-workspace";
const TITLE = "Delivery drill (D-4/N6)";

const analysis: RequirementAnalysis = {
  id: "DRILL",
  summary: "Deploy the current TaskBoard commit to staging and production, and exercise rollback.",
  goals: ["Deliver the current Git commit", "Verify health", "Exercise rollback"],
  constraints: [],
  assumptions: [],
  acceptanceCriteria: ["Staging and production health checks pass"],
  risks: []
};

const specifications = [
  { type: "FUNCTIONAL", content: { requirements: [] } },
  { type: "TECHNICAL", content: { requirements: [] } },
  { type: "ARCHITECTURE", content: { components: [], dataFlow: [] } },
  { type: "API", content: { endpoints: [] } },
  { type: "DATABASE", content: { tables: [] } },
  { type: "UI", content: { pages: [] } }
];

const plan1: TaskPlan = {
  summary: "Delivery drill 1: full chain to production",
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
      id: "DEPLOY-STAGING",
      title: "Deploy staging",
      description: "Deploy the image to staging and verify health.",
      type: "DEPLOY",
      priority: "HIGH",
      dependencies: ["CI"],
      estimatedComplexity: 1,
      acceptanceCriteria: ["Staging is healthy"],
      sourceSpecTypes: ["ARCHITECTURE"],
      delivery: { action: "DEPLOY", environment: "staging" }
    },
    {
      id: "VERIFY-STAGING",
      title: "Verify staging",
      description: "Verify staging health and readiness.",
      type: "TEST",
      priority: "HIGH",
      dependencies: ["DEPLOY-STAGING"],
      estimatedComplexity: 1,
      acceptanceCriteria: ["Staging verified"],
      sourceSpecTypes: ["TECHNICAL"],
      delivery: { action: "VERIFY", environment: "staging" }
    },
    {
      id: "DEPLOY-PRODUCTION",
      title: "Deploy production",
      description: "Deploy the image to production (requires approval).",
      type: "DEPLOY",
      priority: "HIGH",
      dependencies: ["VERIFY-STAGING"],
      estimatedComplexity: 1,
      acceptanceCriteria: ["Production healthy"],
      sourceSpecTypes: ["ARCHITECTURE"],
      delivery: { action: "DEPLOY", environment: "production" }
    }
  ]
};

const plan2: TaskPlan = {
  summary: "Delivery drill 2: broken release rolls back",
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
      id: "DEPLOY-STAGING",
      title: "Deploy staging",
      description: "Deploy the image to staging and verify health.",
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

interface ApiEnvelope {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = (await response.json()) as ApiEnvelope;
  if (!payload.success) {
    throw new Error(`${method} ${path} failed: ${payload.error?.code} ${payload.error?.message}`);
  }
  return payload.data;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  const allowNew = process.argv.includes("--new");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required (source .env first)");

  const pool = createPool(databaseUrl);
  const planning = new PgPlanningRepository(pool);
  try {
    const requirements = await planning.findRequirementsByProjectId(PROJECT_ID);
    let requirement = requirements.find((entry) => entry.title === TITLE) ?? null;

    if (command === "status") {
      console.log(
        "requirement:",
        requirement ? `${requirement.id} (${requirement.status})` : "not seeded"
      );
      if (requirement) {
        const plans = await pool.query(
          "SELECT version, count(*)::int AS tasks FROM tasks WHERE requirement_id = $1 GROUP BY version ORDER BY version",
          [requirement.id]
        );
        console.log("plan versions:", plans.rows);
        const workflows = await pool.query(
          "SELECT id, status, planning_version FROM workflow_runs WHERE requirement_id = $1 ORDER BY created_at",
          [requirement.id]
        );
        console.log("workflows:", workflows.rows);
      }
      const deployments = await pool.query(
        "SELECT environment, status, version, image FROM deployments ORDER BY created_at"
      );
      console.log("deployments:", deployments.rows);
      const ciRuns = await pool.query(
        "SELECT status, git_commit, image FROM ci_runs ORDER BY created_at"
      );
      console.log("ci_runs:", ciRuns.rows);
      return;
    }

    if (!requirement) {
      console.log("WILL CREATE: requirement", { projectId: PROJECT_ID, title: TITLE });
      requirement = await planning.createRequirement(PROJECT_ID, {
        title: TITLE,
        description: "",
        rawContent: "Delivery drill for the TaskBoard project (D-4/N6)."
      });
    }
    console.log("requirement:", requirement.id, requirement.status);

    const versionRows = await pool.query<{ version: number }>(
      "SELECT DISTINCT version FROM tasks WHERE requirement_id = $1 ORDER BY version",
      [requirement.id]
    );
    const existingVersions = versionRows.rows.map((row) => row.version);

    if (command === "seed" || command === "run1" || command === "run2") {
      if (!existingVersions.includes(1)) {
        console.log("WILL SAVE: plan version 1", { tasks: plan1.tasks.length });
        await planning.savePlanningResult({
          projectId: PROJECT_ID,
          requirementId: requirement.id,
          requirementVersion: 1,
          version: 1,
          analysis,
          specifications,
          taskPlan: plan1
        });
        console.log("saved plan version 1");
      } else {
        console.log("plan version 1 already present");
      }
      if (!existingVersions.includes(2)) {
        console.log("WILL SAVE: plan version 2", { tasks: plan2.tasks.length });
        await planning.savePlanningResult({
          projectId: PROJECT_ID,
          requirementId: requirement.id,
          requirementVersion: 1,
          version: 2,
          analysis,
          specifications,
          taskPlan: plan2
        });
        console.log("saved plan version 2");
      } else {
        console.log("plan version 2 already present");
      }
    }

    if (command !== "run1" && command !== "run2") {
      if (command !== "seed") console.log("unknown command (use seed|run1|run2|status)");
      return;
    }

    const planningVersion = command === "run1" ? 1 : 2;
    const existing = await pool.query(
      "SELECT id, status FROM workflow_runs WHERE requirement_id = $1 AND planning_version = $2 ORDER BY created_at",
      [requirement.id, planningVersion]
    );
    if (existing.rows.length > 0 && !allowNew) {
      console.log("existing workflows for version", planningVersion, ":", existing.rows);
      console.log("pass --new to create another workflow");
      return;
    }

    const policy = {
      maxConcurrency: 1,
      maxRetries: 1,
      failureStrategy: command === "run1" ? "FAIL_FAST" : "ROLLBACK",
      allowRetry: false,
      allowReplan: false,
      approvalRequired: false
    };
    console.log("WILL CREATE: workflow", { planningVersion, workspacePath: WORKSPACE, policy });
    const workflow = (await api("POST", "/api/workflows", {
      projectId: PROJECT_ID,
      requirementId: requirement.id,
      workspacePath: WORKSPACE,
      planningVersion,
      policy,
      approvalTaskKeys: []
    })) as { id: string };
    console.log("workflow created:", workflow.id);
    const started = (await api("POST", `/api/workflows/${workflow.id}/start`)) as {
      status: string;
    };
    console.log("workflow started:", workflow.id, started.status);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
