/**
 * PL-M18 / N-10 probe: TEST red-light check scope fallback.
 *
 * Loads the REAL L1-M4i run-1 workflow (default a0434bc9 / task T10) from the dev DB
 * and replays the verification gate against suite output reconstructed from the task's
 * OWN recorded acResults (so the input is production-derived, not invented).
 *
 * Production reading (tasks.output.verification of T10, workflow a0434bc9):
 *   acResults = { AC-04: passed, AC-29: passed, AC-30: passed, FR-06: passed, TR-03: passed }
 *   acSummary = { total: 5, failed: 0, passed: 5 }
 *   verdict   = failed, failureCode = VACUOUS_TEST
 * i.e. every scoped AC PASSED, so the verdict did NOT come from a failing test.
 * The task declares no `input.acKeys`, so `scopedEvidenceKeys` falls back to the full
 * parsed set, and `acImplementationEvidence` requires EVERY scoped key to be covered by
 * a SUCCESS + dev-type task. FR-06 / TR-03 are requirement identifiers matched by
 * BRACKETED_MARKER_PATTERN (/\[([A-Za-z]{2,})-(\d+)\]/g) that NO task ever declares.
 *
 * Variants:
 *   V0  production shape (no acKeys)                  -> expect failed / VACUOUS_TEST
 *   V0i per-key evidence attribution                  -> names the blocking keys
 *   V1  candidate (a): slice-scoped acKeys            -> expect verified / expected=pass
 *   V2  negative control: slice-scoped acKeys, no evidence -> expect failed / VACUOUS_TEST
 *   V3  candidate (b) observation: declared-but-empty acKeys -> reports current behaviour
 *
 * Read-only: opens a pool, runs no writes, modifies no rows.
 *
 * Run from the repo root with .env sourced:
 *   corepack pnpm --filter @ai-se/server exec tsx scripts/probe-n10-redlight-scope.ts \
 *     [workflowRunId] [taskKey] [--out packages/eval/results/n10-probe]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createPool, PgPlanningRepository, PgWorkflowRepository } from "@ai-se/database";
import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { Task, WorkflowRun } from "@ai-se/shared";
import { TaskExecutionResult } from "@ai-se/workflow-engine";
import { TaskVerifier } from "../src/services/taskVerifier.js";
import { isDevTaskType } from "../src/services/taskVerifierRules.js";

const DEFAULT_WORKFLOW = "a0434bc9-26ba-4f00-89a0-213511c4834a";
const DEFAULT_TASK_KEY = "T10";
const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(`Node ${process.versions.node} is too old; run with Node >= 22 on PATH.`);
  process.exit(1);
}

type SandboxScript = (command: string) => Partial<SandboxResult> | undefined;

class ReplaySandbox implements Sandbox {
  readonly calls: string[] = [];
  constructor(private readonly script: SandboxScript) {}
  async runCommand(_workspacePath: string, command: SandboxCommand): Promise<SandboxResult> {
    this.calls.push(command.command);
    const partial = this.script(command.command);
    if (!partial) throw new Error(`unscripted sandbox command: ${command.command}`);
    return {
      command: command.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      duration: 1,
      timedOut: false,
      ...partial
    };
  }
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Positional args = argv[2..] minus every `--flag value` pair. */
function positionals(): string[] {
  const out: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const entry = process.argv[index];
    if (entry.startsWith("--")) {
      index += 1;
      continue;
    }
    out.push(entry);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Display-only mirror of the verifier's canonicalisation (see taskVerifier.ts:179). */
function canonicalAcKey(key: string): string {
  const match = /^([A-Za-z]{2,})-(\d+)$/.exec(key.trim());
  if (!match) return key;
  return `${match[1].toUpperCase()}-${String(Number(match[2]))}`;
}

/** Display-only mirror of taskVerifier.ts:186 (not exported). */
function taskCoversAc(task: Task, acKey: string): boolean {
  const canonical = canonicalAcKey(acKey);
  const planned = task.input.acKeys;
  if (Array.isArray(planned) && planned.some((entry) => canonicalAcKey(String(entry)) === canonical)) {
    return true;
  }
  const verification = asRecord(task.output?.verification);
  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  return checks.some((entry) =>
    Object.entries(asRecord(asRecord(entry).acResults)).some(
      ([key, value]) => value === "passed" && canonicalAcKey(key) === canonical
    )
  );
}

function makeWorkflow(task: Task, workflowRunId: string, requirementId: string): WorkflowRun {
  const now = new Date().toISOString();
  return {
    id: workflowRunId,
    projectId: task.projectId,
    requirementId,
    planningVersion: 1,
    status: "RUNNING",
    policy: {
      maxConcurrency: 1,
      maxRetries: 1,
      failureStrategy: "FAIL_FAST",
      allowRetry: true,
      allowReplan: false,
      approvalRequired: false
    },
    input: { workspacePath: "/replay" },
    createdAt: now,
    updatedAt: now
  };
}

function withAcKeys(task: Task, acKeys: string[] | undefined): Task {
  const input = { ...task.input } as Record<string, unknown>;
  if (acKeys === undefined) delete input.acKeys;
  else input.acKeys = acKeys;
  return { ...task, input } as Task;
}

/**
 * Pre-fix simulation: strip `sliceKey` so the PL-M18 slice fallback is disabled and the
 * scope falls back to the full parsed set — i.e. exactly the code path that produced the
 * production VACUOUS_TEST. Used as the A/B baseline after the fix lands.
 */
function withoutSliceKey(task: Task): Task {
  const next = { ...task } as Task & { sliceKey?: string };
  delete next.sliceKey;
  return next;
}

async function main(): Promise<void> {
  const positional = positionals();
  const workflowRunId = positional[0] ?? DEFAULT_WORKFLOW;
  const taskKey = positional[1] ?? DEFAULT_TASK_KEY;
  const outDir = resolve(REPO_ROOT, argValue("--out") ?? "packages/eval/results/n10-probe");

  const pool = createPool();
  const repository = new PgWorkflowRepository(pool);
  const planning = new PgPlanningRepository(pool);
  try {
    const tasks = await repository.findTasks(workflowRunId);
    const task = tasks.find((entry) => entry.taskKey === taskKey);
    if (!task) throw new Error(`task ${taskKey} not found in workflow ${workflowRunId}`);

    const workflowRow = await pool.query<{ requirement_id: string }>(
      "SELECT requirement_id FROM workflow_runs WHERE id = $1",
      [workflowRunId]
    );
    const requirementId = workflowRow.rows[0]?.requirement_id;
    if (!requirementId) throw new Error(`workflow ${workflowRunId} has no requirement_id`);

    const verification = asRecord(task.output?.verification);
    const recorded = asRecord(verification.acResults);
    const scopedKeys = Object.keys(recorded)
      .filter((key) => recorded[key] === "passed")
      .sort();
    if (scopedKeys.length === 0) {
      throw new Error(`task ${taskKey} has no recorded passed acResults to replay`);
    }

    const suiteOutput = scopedKeys.map((key, index) => `ok ${index + 1} - [${key}] replay`).join("\n");
    const sandbox = new ReplaySandbox((command) => {
      if (command.includes("package.json")) return { stdout: '{"test":"node --test"}' };
      if (command.includes("test")) return { stdout: suiteOutput };
      return undefined;
    });

    const requirementTasks = await planning.findRuntimeTasksByRequirementId(requirementId);
    const cutoff = new Date(
      (asRecord(verification).finishedAt as string | undefined) ?? Date.now()
    );
    const evidence = requirementTasks.filter(
      (entry) =>
        entry.id !== task.id &&
        entry.status === "SUCCESS" &&
        isDevTaskType(entry.type) &&
        entry.finishedAt !== undefined &&
        new Date(entry.finishedAt).getTime() < cutoff.getTime()
    );

    console.log(`workflow=${workflowRunId} task=${taskKey} id=${task.id} type=${task.type}`);
    console.log(`declared acKeys: ${JSON.stringify(task.input.acKeys ?? null)}`);
    console.log(`sliceKey=${task.sliceKey ?? "(none)"} cutoff=${cutoff.toISOString()}`);
    console.log(`scoped keys (recorded passed acResults): ${scopedKeys.join(",")}`);
    console.log(`evidence face (dev+SUCCESS, finished<cutoff): ${evidence.length} tasks`);

    // V0i: per-key attribution over the production scope.
    const attribution = scopedKeys.map((key) => ({
      key,
      canonical: canonicalAcKey(key),
      coveringTasks: evidence
        .filter((entry) => taskCoversAc(entry, key))
        .map((entry) => entry.taskKey),
      everDeclaredByAnyTask: requirementTasks.some((entry) =>
        Array.isArray(entry.input.acKeys)
          ? (entry.input.acKeys as unknown[]).some(
              (candidate) => canonicalAcKey(String(candidate)) === canonicalAcKey(key)
            )
          : false
      )
    }));
    for (const row of attribution) {
      console.log(
        `  ${row.key.padEnd(7)} <- ${
          row.coveringTasks.length > 0 ? row.coveringTasks.join(",") : "(none)"
        }${row.everDeclaredByAnyTask ? "" : "   [never declared by any task in this requirement]"}`
      );
    }

    // Candidate (a) input: the AC keys declared by the requirement's tasks in the SAME slice.
    const sliceKeys = [
      ...new Set(
        requirementTasks
          .filter((entry) => entry.sliceKey === task.sliceKey)
          .flatMap((entry) =>
            Array.isArray(entry.input.acKeys)
              ? (entry.input.acKeys as unknown[]).map((candidate) => String(candidate))
              : []
          )
      )
    ].sort();
    const sliceScoped = sliceKeys.filter((key) =>
      scopedKeys.some((candidate) => canonicalAcKey(candidate) === canonicalAcKey(key))
    );
    console.log(`slice=${task.sliceKey ?? "(none)"} declared keys: ${sliceKeys.join(",") || "(none)"}`);
    console.log(`slice-scoped ∩ parsed: ${sliceScoped.join(",") || "(empty)"}`);

    const realRequirementTasks = (id: string) => planning.findRuntimeTasksByRequirementId(id);
    const runVariant = async (label: string, variant: Task, evidenceLoader?: typeof realRequirementTasks) => {
      const verifier = new TaskVerifier({
        sandbox,
        mode: "enforce",
        ...(evidenceLoader ? { requirementTasks: evidenceLoader } : {})
      });
      const record = await verifier.verify({
        workflow: makeWorkflow(variant, workflowRunId, requirementId),
        task: variant,
        result: { status: "succeeded", output: { summary: "probe" }, agentRunId: "probe-run" } as TaskExecutionResult
      });
      const check = record.checks.find((entry) => entry.name === "test");
      const summary = {
        label,
        verdict: record.verdict,
        failureCode: record.failureCode ?? null,
        reason: record.reason ?? null,
        checkExpected: check?.expected ?? null,
        checkPassed: check?.passed ?? null,
        acSummary: record.acSummary ?? null
      };
      console.log(
        `${label}: verdict=${summary.verdict} expected=${summary.checkExpected} ` +
          `passed=${summary.checkPassed} failureCode=${summary.failureCode} ac=${JSON.stringify(summary.acSummary)}`
      );
      return summary;
    };

    const v0 = await runVariant("V0 production shape (no acKeys, real sliceKey)", task, realRequirementTasks);
    const v0p = await runVariant(
      "V0p pre-fix simulation (no acKeys, sliceKey stripped)",
      withoutSliceKey(task),
      realRequirementTasks
    );
    const v1 = await runVariant(
      "V1 candidate (a): slice-scoped acKeys",
      withAcKeys(task, sliceScoped),
      realRequirementTasks
    );
    const v2 = await runVariant(
      "V2 negative control: slice-scoped acKeys, no evidence",
      withAcKeys(task, sliceScoped),
      async () => []
    );
    const v3 = await runVariant(
      "V3 candidate (b) observation: declared-but-empty acKeys",
      withAcKeys(task, []),
      realRequirementTasks
    );

    const expectations = {
      V0_FIXED: v0.verdict === "verified" && v0.checkExpected === "pass" && v0.checkPassed === true,
      V0P_REPRODUCES_PRE_FIX: v0p.verdict === "failed" && v0p.failureCode === "VACUOUS_TEST",
      V1_FLIPS: v1.verdict === "verified" && v1.checkExpected === "pass" && v1.checkPassed === true,
      V2_STILL_BLOCKS: v2.verdict === "failed" && v2.failureCode === "VACUOUS_TEST",
      V3_OBSERVED: v3.failureCode !== null || v3.verdict === "verified"
    };
    for (const [name, ok] of Object.entries(expectations)) console.log(`${name}=${ok}`);

    const report = {
      generatedAt: new Date().toISOString(),
      workflowRunId,
      taskKey,
      taskId: task.id,
      taskType: task.type,
      sliceKey: task.sliceKey ?? null,
      declaredAcKeys: task.input.acKeys ?? null,
      cutoff: cutoff.toISOString(),
      scopedKeys,
      evidenceTaskCount: evidence.length,
      evidenceTaskKeys: evidence.map((entry) => entry.taskKey),
      attribution,
      sliceKeys,
      sliceScoped,
      variants: { v0, v0p, v1, v2, v3 },
      expectations
    };
    mkdirSync(outDir, { recursive: true });
    const outFile = resolve(outDir, `n10-${taskKey}-${Date.now()}.json`);
    writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`report=${outFile}`);

    if (
      !expectations.V0_FIXED ||
      !expectations.V0P_REPRODUCES_PRE_FIX ||
      !expectations.V1_FLIPS ||
      !expectations.V2_STILL_BLOCKS
    ) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
