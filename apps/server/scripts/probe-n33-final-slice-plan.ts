/**
 * PL-M37 / N-33 probe: does the plan for the FINAL slice now carry a `VERIFY` delivery action?
 *
 * Why this probe exists. N-33 was "fixed" by rewriting `DELIVERY_READY_LINE` in
 * `task-planning.prompt.ts` so it spells out the four delivery blocks (action + type). The fix
 * could NOT be checked by the batch it was written during: `l1-m4t`'s three runs share ONE plan
 * generated at run 1 (`harness.ts:122-128`), and run 1 planned before the new prompt existed
 * (`docs/218` §12). The next batch is the only way to test it the normal way - and the weekly
 * quota window does not reset until 2026-10-25 23:00 UTC. So test the prompt directly instead.
 *
 * A prompt-level A/B is only meaningful when everything else is held constant. This probe
 * therefore reuses the REAL planning inputs of the batch's final slice - requirement, persisted
 * `requirement_analysis` (seed), AC records, slice scope, delivery environment - and calls the
 * REAL `runPlanningGraph(level2)` with the REAL provider. The only thing that differs from the
 * recorded run is the prompt text, which is exactly the variable under test.
 *
 * Read-only: `runPlanningGraph` is pure. Persistence lives in `PlanningService.afterGraph`, which
 * this probe deliberately does not supply, so no requirement/slice/task row is written and the
 * running batch is untouched. One planning call is spent.
 *
 * Verdict:
 *   VERIFY-PRESENT   a task carries delivery.action === "VERIFY"  -> the prompt fix works
 *   VERIFY-MISSING   the final slice still plans DEPLOY("verify") -> prompt route failed,
 *                    fall back to the deterministic backfill (docs/218 §9 known issue 1)
 *
 * Run from the repo root (env must be loaded, the same way the platform server is started):
 *   set -a; source .env; set +a
 *   corepack pnpm --filter @ai-se/server exec tsx scripts/probe-n33-final-slice-plan.ts \
 *     [--requirement <uuid>] [--slice slice-3-tasks]
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LangChainPlanningModel, runPlanningGraph } from "@ai-se/agent-core";
import {
  createPool,
  PgDeploymentRepository,
  PgPlanningRepository,
  PgProjectRepository
} from "@ai-se/database";
import { loadConfig } from "../src/config.js";
import { LivePlanningModel } from "../src/services/liveModel.js";
import { ModelConfigService } from "../src/services/modelConfigService.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const OUT_DIR = join(REPO_ROOT, "packages/eval/results/n33-plan-probe");
const STAGING = "staging";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const planning = new PgPlanningRepository(pool);
  const projects = new PgProjectRepository(pool);
  const deployments = new PgDeploymentRepository(pool);

  try {
    const requirementId =
      flag("requirement") ??
      (
        await pool.query<{ requirement_id: string }>(
          "select requirement_id from workflow_runs order by created_at desc limit 1"
        )
      ).rows[0]?.requirement_id;
    if (!requirementId) {
      throw new Error("no requirement given and no workflow_runs row to derive one from");
    }

    const requirement = await planning.findRequirementById(requirementId);
    if (!requirement) throw new Error(`requirement not found: ${requirementId}`);

    const slices = await planning.findSlicesByRequirementId(requirementId);
    if (slices.length === 0) throw new Error(`requirement ${requirementId} has no slices`);
    // Final slice = last by slice_order, the same rule as `planningService.executeSliceRun`.
    const sliceKey = flag("slice") ?? slices[slices.length - 1].sliceKey;
    const slice = slices.find((entry) => entry.sliceKey === sliceKey);
    if (!slice) throw new Error(`slice not found: ${sliceKey}`);

    const analysis = await planning.findLatestAnalysis(requirementId);
    if (!analysis) throw new Error(`requirement ${requirementId} has no requirement_analysis`);
    const acRecords = await planning.findAcceptanceCriteriaByRequirementId(requirementId);
    const project = await projects.findById(requirement.projectId);
    const environments = project?.repository
      ? await deployments.findEnvironments(requirement.projectId)
      : [];
    // Same preference as production: staging first, otherwise any known delivery environment.
    const deliveryEnvironment = environments.some((entry) => entry.name === STAGING)
      ? STAGING
      : (environments[0]?.name ?? null);

    console.log(`requirement : ${requirement.id} (${requirement.title})`);
    console.log(`slice       : ${slice.sliceKey} — ${slice.title} (final=${slice === slices.at(-1)})`);
    console.log(`analysis    : ${analysis.id} (persisted seed)`);
    console.log(`AC records  : ${acRecords.length}`);
    console.log(`git bound   : ${Boolean(project?.repository)}  env: ${deliveryEnvironment ?? "-"}`);

    const modelConfig = new ModelConfigService({
      provider: config.llmProvider,
      model: config.llmModel,
      apiKey: config.llmApiKey,
      baseUrl: config.llmBaseUrl
    });
    // Construction copied from `apps/server/src/index.ts:147-158` — the production model stack.
    const model = new LivePlanningModel(
      modelConfig,
      () =>
        new LangChainPlanningModel({
          ...modelConfig.getOptions(),
          structuredOutputMethod: config.llmStructuredOutputMethod,
          sessionId: "ai-se-planning"
        })
    );

    const startedAt = Date.now();
    const result = await runPlanningGraph({
      agentRunId: randomUUID(),
      taskId: randomUUID(),
      requirement,
      model,
      acceptanceCriteria: acRecords.map((record) => ({
        acKey: record.acKey,
        text: record.text,
        priority: record.priority,
        verification: record.verification,
        smoke: record.smoke,
        frKeys: record.frKeys
      })),
      isFinalSlice: slice === slices.at(-1),
      deliveryEnvironment,
      pipeline: "level2",
      slice: {
        key: slice.sliceKey,
        title: slice.title,
        goal: slice.goal,
        frKeys: slice.frKeys
      },
      skipStages: [
        ...(slice.involvesUi ? [] : (["ui_spec"] as const)),
        ...(slice.involvesData === false ? (["database_spec"] as const) : [])
      ],
      seedAnalysis: analysis,
      maxValidationRetries: 2,
      stageTimeoutMs: config.planningStageTimeoutMs,
      stageRetries: config.planningStageRetries,
      ...(config.planningFinalSliceMaxTasks !== undefined
        ? { finalSliceMaxTasks: config.planningFinalSliceMaxTasks }
        : {})
    });
    const durationMs = Date.now() - startedAt;

    const tasks = result.taskPlan.tasks;
    const delivery = tasks.filter((task) => task.delivery);
    const verifyTasks = delivery.filter((task) => task.delivery?.action === "VERIFY");
    const verdict = verifyTasks.length > 0 ? "VERIFY-PRESENT" : "VERIFY-MISSING";

    console.log(`\ntasks: ${tasks.length}   delivery blocks: ${delivery.length}   ${durationMs} ms\n`);
    for (const task of tasks) {
      const block = task.delivery
        ? ` delivery=${JSON.stringify(task.delivery)}`
        : "";
      console.log(`  ${task.id.padEnd(6)} ${task.type.padEnd(8)} ${task.title}${block}`);
    }
    console.log(`\nVERDICT: ${verdict}`);
    if (verifyTasks.length > 0) {
      for (const task of verifyTasks) {
        console.log(`  VERIFY task: ${task.id} (${task.type}) — ${task.title}`);
      }
    }

    mkdirSync(OUT_DIR, { recursive: true });
    const artifact = join(OUT_DIR, `plan-${slice.sliceKey}-${Date.now()}.json`);
    writeFileSync(
      artifact,
      JSON.stringify(
        {
          probedAt: new Date().toISOString(),
          durationMs,
          verdict,
          inputs: {
            requirementId: requirement.id,
            sliceKey: slice.sliceKey,
            analysisId: analysis.id,
            acceptanceCriteria: acRecords.length,
            deliveryConfigured: Boolean(project?.repository),
            deliveryEnvironment
          },
          tasks,
          delivery
        },
        null,
        2
      )
    );
    console.log(`artifact: ${artifact}`);

    process.exitCode = verdict === "VERIFY-PRESENT" ? 0 : 2;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
