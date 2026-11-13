/**
 * N-35 follow-up probe: why did two slice-auth workflows get no `slice-boundary` check?
 *
 * The predicate lives in `TaskVerifier.maybeSliceBoundaryCheck` and has six early returns. Four are
 * ruled out from the database (`slice_key` present, `test` script in use, `acKeys` non-empty,
 * `workflowTasks` wired in production). The remaining one is the sibling gate:
 *
 *     status !== "SUCCESS" && !(status === "FAILED" && isFailureResolved(...))
 *
 * This probe replays that gate over the FINAL task state of a workflow and prints, per possible
 * anchor, which siblings look unfinished and whether the boundary would run. Read-only.
 *
 * If every anchor says "would run", the final state does not explain the missing check and the
 * difference must have been the in-memory state at verification time.
 *
 * Run from the repo root:
 *   set -a; source .env; set +a
 *   corepack pnpm --filter @ai-se/server exec tsx scripts/probe-boundary-anchor.ts <workflowId>...
 */
import { createPool, PgWorkflowRepository } from "@ai-se/database";
import { isFailureResolved } from "@ai-se/workflow-engine";
import { loadConfig } from "../src/config.js";
import type { Task } from "@ai-se/shared";

function hasDeliveryBlock(task: Task): boolean {
  const delivery = task.input.delivery;
  return typeof delivery === "object" && delivery !== null;
}

function taskAcKeys(task: Task): string[] {
  const raw = task.input.acKeys;
  return Array.isArray(raw)
    ? raw.filter((key): key is string => typeof key === "string").map((key) => key.trim())
    : [];
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter((value) => !value.startsWith("--"));
  if (ids.length === 0) throw new Error("pass at least one workflow id");

  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const workflows = new PgWorkflowRepository(pool);
  try {
    for (const id of ids) {
      const tasks = await workflows.findTasks(id);
      const byId = new Map(tasks.map((task) => [task.id, task]));
      console.log(`\n=== ${id} (${tasks.length} tasks) ===`);
      for (const anchor of tasks) {
        if (!anchor.sliceKey) {
          console.log(`  ${anchor.taskKey}: no sliceKey -> boundary returns null`);
          continue;
        }
        const sliceTasks = tasks.filter((task) => task.sliceKey === anchor.sliceKey);
        const siblings = sliceTasks.filter(
          (task) => task.id !== anchor.id && !hasDeliveryBlock(task)
        );
        const unfinished = siblings.filter(
          (task) =>
            task.status !== "SUCCESS" &&
            !(task.status === "FAILED" && isFailureResolved(task, byId))
        );
        const acKeys = [...new Set(sliceTasks.flatMap(taskAcKeys).filter((key) => key !== ""))];
        const runs = unfinished.length === 0 && acKeys.length > 0;
        const detail = unfinished.map((task) => `${task.taskKey}:${task.status}`).join(",");
        console.log(
          `  ${anchor.taskKey.padEnd(14)} ${anchor.status.padEnd(8)} ` +
            `siblings=${siblings.length} unfinished=[${detail}] acKeys=${acKeys.length} ` +
            `-> boundary ${runs ? "WOULD RUN" : "returns null"}`
        );
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
