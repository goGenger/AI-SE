/**
 * F1-4 (FX-14b) L2 planning drill.
 *
 * Replans the E1 requirement through the real two-level planning pipeline in-process
 * (real model gateway, NO workflow creation), then plans every remaining PENDING slice
 * in order via PlanningService.planPendingSlicesInOrder, and verifies:
 *   - no slice workflow is created by the drill (workflow_runs count unchanged);
 *   - global (Deploy/Doc) acceptance criteria appear ONLY in the final slice plan;
 * and records the final slice scale (taskCount / deliveryTaskCount / frCount / globalAcCount).
 *
 * The service instance is deliberately assembled WITHOUT startSliceWorkflow/workflows deps,
 * so neither the approval handler nor the slice chain can create a slice workflow.
 *
 * Run from the repo root with .env sourced (Node >= 22 on PATH):
 *   corepack pnpm --filter @ai-se/server exec tsx scripts/l2-planning-drill.ts [requirementId] [--out result.json]
 */
import {
  LangChainPlanningModel,
  ScriptedPlanningModel,
  isGlobalAcceptanceCriterion
} from "@ai-se/agent-core";
import {
  PgAgentRunStore,
  PgDeploymentRepository,
  PgPlanningRepository,
  PgProjectRepository,
  PgWorkflowEventStore,
  PgWorkflowRepository,
  createPool
} from "@ai-se/database";
import { createLogger } from "@ai-se/observability";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../src/config.js";
import { MemoryCancellationStore } from "../src/services/cancellationStore.js";
import { PlanningService } from "../src/services/planningService.js";

const DEFAULT_REQUIREMENT = "a30f30cc-64f5-4b31-9bbb-9b3d5bbaba53";
const PLANNING_WAIT_MS = 15 * 60 * 1000;

async function waitForValue<T>(
  fn: () => Promise<T | null>,
  label: string,
  timeoutMs = PLANNING_WAIT_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(2000);
  }
}

async function main(): Promise<void> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22) {
    console.error(`Node ${process.versions.node} is too old; run with Node >= 22 on PATH.`);
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
  const requirementId =
    args.find(
      (entry, index) => !entry.startsWith("--") && (outIndex < 0 || index !== outIndex + 1)
    ) ?? DEFAULT_REQUIREMENT;

  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const planning = new PgPlanningRepository(pool);
  const workflowRepository = new PgWorkflowRepository(pool);

  try {
    // Keep the logger ON so a failing stage leaves evidence in the run log.
    const logger = createLogger({ level: config.logLevel });
    const model =
      config.llmProvider === "openai"
        ? new LangChainPlanningModel({
            model: config.llmModel,
            apiKey: config.llmApiKey,
            baseUrl: config.llmBaseUrl,
            structuredOutputMethod: config.llmStructuredOutputMethod,
            sessionId: "ai-se-l2-drill"
          })
        : new ScriptedPlanningModel();

    // NOTE: no startSliceWorkflow / workflows deps -> the chain cannot create workflows.
    const service = new PlanningService({
      planning,
      agentRuns: new PgAgentRunStore(pool),
      workflowEvents: new PgWorkflowEventStore(pool),
      projects: new PgProjectRepository(pool),
      cancellationStore: new MemoryCancellationStore(),
      approvals: workflowRepository,
      deployments: new PgDeploymentRepository(pool),
      model,
      logger
    });

    const countWorkflows = async (): Promise<number> => {
      const result = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM workflow_runs WHERE requirement_id = $1",
        [requirementId]
      );
      return result.rows[0]?.count ?? 0;
    };

    if (args.includes("--smoke")) {
      // Connectivity/dry check: construct the service and read state without any LLM call.
      const requirement = await planning.findRequirementById(requirementId);
      console.log(
        JSON.stringify(
          {
            smoke: true,
            requirementId,
            requirementStatus: requirement?.status ?? null,
            workflowCount: await countWorkflows(),
            modelSource: config.llmProvider
          },
          null,
          2
        )
      );
      process.exit(0);
    }

    const workflowCountBefore = await countWorkflows();

    // 1) Level-1 replan (regenerate) with the fixed pipeline.
    const analyze = await service.analyzeRequirement(
      requirementId,
      { regenerate: true },
      randomUUID()
    );
    console.log(
      `analyze accepted: agentRunId=${analyze.agentRunId} planningVersion=${analyze.version}`
    );
    await service.waitForPlanningRun(analyze.agentRunId, PLANNING_WAIT_MS);

    // 2) Approve gate 1 (auto), then let the approval handler plan the first slice.
    const approval = await waitForValue(async () => {
      const requirement = await planning.findRequirementById(requirementId);
      if (!requirement) {
        throw new Error(`requirement ${requirementId} not found`);
      }
      if (requirement.status === "FAILED") {
        throw new Error("level-1 replan FAILED");
      }
      if (requirement.status !== "PLANNING_REVIEW") {
        return null;
      }
      return (await workflowRepository.findPendingApprovalByRequirement(requirementId)) ?? null;
    }, "PLANNING_REVIEW + pending gate-1 approval");

    const decided = await workflowRepository.decideApproval(
      approval.id,
      "APPROVED",
      "L2 planning drill auto-approval"
    );
    if (!decided) {
      throw new Error(`approval ${approval.id} could not be decided`);
    }
    await service.handleSliceApprovalDecided(decided);
    console.log(`gate 1 approved: approval=${approval.id}`);

    await waitForValue(async () => {
      const slices = await planning.findSlicesByRequirementId(requirementId);
      const first = slices[0];
      if (first?.status === "PLANNED") {
        return slices;
      }
      if (first?.status === "PENDING") {
        const pending = await workflowRepository.findPendingApprovalByRequirement(requirementId);
        if (pending) {
          throw new Error(`first-slice planning escalated to human gate: ${pending.reason}`);
        }
      }
      return null;
    }, "first slice planned");

    // 3) Plan every remaining PENDING slice in order (no workflows created).
    await service.planPendingSlicesInOrder(requirementId);

    // 4) Collect + self-check.
    const records = await planning.findAcceptanceCriteriaByRequirementId(requirementId);
    const globalKeys = new Set(
      records.filter((record) => isGlobalAcceptanceCriterion(record)).map((record) => record.acKey)
    );
    const slices = await planning.findSlicesByRequirementId(requirementId);
    const allTasks = await planning.findTasksByRequirementId(requirementId);
    const lastSliceKey = slices[slices.length - 1]?.sliceKey;

    const perSlice = slices.map((slice) => {
      const tasks = allTasks.filter(
        (task) => !task.workflowRunId && task.sliceKey === slice.sliceKey
      );
      const globalRefs = [
        ...new Set(
          tasks.flatMap((task) =>
            ((task.input.acKeys as string[] | undefined) ?? []).filter((key) => globalKeys.has(key))
          )
        )
      ];
      const deliveryTaskCount = tasks.filter(
        (task) => task.type === "DEPLOY" || (task.input.delivery ?? null) !== null
      ).length;
      return {
        sliceKey: slice.sliceKey,
        title: slice.title,
        order: slice.order,
        status: slice.status,
        planningVersion: slice.planningVersion ?? null,
        isFinal: slice.sliceKey === lastSliceKey,
        frKeys: slice.frKeys,
        taskCount: tasks.length,
        taskKeys: tasks.map((task) => task.taskKey),
        deliveryTaskCount,
        globalAcRefs: globalRefs
      };
    });

    const finalSlice = perSlice.find((entry) => entry.isFinal) ?? null;
    const nonFinalWithGlobals = perSlice.filter(
      (entry) => !entry.isFinal && entry.globalAcRefs.length > 0
    );
    const workflowCountAfter = await countWorkflows();
    const unplanned = perSlice.filter((entry) => entry.status !== "PLANNED");

    const violations: string[] = [];
    if (nonFinalWithGlobals.length > 0) {
      violations.push(
        `global ACs outside the final slice: ${nonFinalWithGlobals
          .map((entry) => `${entry.sliceKey}=[${entry.globalAcRefs.join(",")}]`)
          .join("; ")}`
      );
    }
    if (workflowCountAfter !== workflowCountBefore) {
      violations.push(
        `workflows created during drill: before=${workflowCountBefore} after=${workflowCountAfter}`
      );
    }
    if (unplanned.length > 0) {
      violations.push(
        `slices not planned: ${unplanned
          .map((entry) => `${entry.sliceKey}=${entry.status}`)
          .join(", ")}`
      );
    }

    const result = {
      drill: "F1-4 FX-14b L2 planning drill",
      requirementId,
      ranAt: new Date().toISOString(),
      globalAcKeys: [...globalKeys],
      workflowCountBefore,
      workflowCountAfter,
      sliceCount: perSlice.length,
      slices: perSlice,
      finalSliceScale: finalSlice
        ? {
            taskCount: finalSlice.taskCount,
            deliveryTaskCount: finalSlice.deliveryTaskCount,
            frCount: finalSlice.frKeys.length,
            globalAcCount: finalSlice.globalAcRefs.length
          }
        : null,
      violations
    };

    console.log(JSON.stringify(result, null, 2));
    if (outPath) {
      writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
      console.log(`result written to ${outPath}`);
    }
    process.exit(violations.length > 0 ? 1 : 0);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
