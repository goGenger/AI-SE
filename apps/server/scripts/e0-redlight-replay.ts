/**
 * E-0 (docs/125) + G1 (docs/130/131) red-light replay check.
 *
 * Loads the real C-6 run-1 workflow (default 6c841bd2 / task T-13) from the dev
 * DB, replays the verification gate against reconstructed suite output (TAP
 * lines rebuilt from the task's own recorded acResults), and asserts:
 *   run A (requirement-scoped real tasks as evidence) -> verified / expected=pass (flip)
 *   run B (empty evidence)                            -> failed / expected=fail (fail-closed)
 *
 * G1 note: the flip evidence face is requirement-scoped (all runtime tasks of
 * workflow_runs.requirement_id, finished before the check); the real requirement
 * id is read from the workflow row.
 *
 * Run from the repo root with .env sourced:
 *   corepack pnpm --filter @ai-se/server exec tsx scripts/e0-redlight-replay.ts [workflowRunId] [taskKey]
 */
import { createPool, PgPlanningRepository, PgWorkflowRepository } from "@ai-se/database";
import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { Task, WorkflowRun } from "@ai-se/shared";
import { TaskExecutionResult } from "@ai-se/workflow-engine";
import { TaskVerifier } from "../src/services/taskVerifier.js";
import { isDevTaskType } from "../src/services/taskVerifierRules.js";

const DEFAULT_WORKFLOW = "6c841bd2-74a4-4251-8c62-773043b2408e";
const DEFAULT_TASK_KEY = "T-13";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(`Node ${process.versions.node} is too old; run with Node >= 22 on PATH.`);
  process.exit(1);
}

type SandboxScript = (command: string) => Partial<SandboxResult> | undefined;

class ReplaySandbox implements Sandbox {
  constructor(private readonly script: SandboxScript) {}
  async runCommand(_workspacePath: string, command: SandboxCommand): Promise<SandboxResult> {
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Display-only mirror of the verifier's coverage predicate (acKeys plan + acResults evidence). */
function displayCoverage(task: Task, acKey: string): boolean {
  const planned = task.input.acKeys;
  if (Array.isArray(planned) && planned.includes(acKey)) return true;
  const verification = asRecord(task.output?.verification);
  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  return checks.some((entry) => asRecord(asRecord(entry).acResults)[acKey] === "passed");
}

async function main(): Promise<void> {
  const workflowRunId = process.argv[2] ?? DEFAULT_WORKFLOW;
  const taskKey = process.argv[3] ?? DEFAULT_TASK_KEY;

  const pool = createPool();
  const repository = new PgWorkflowRepository(pool);
  const planning = new PgPlanningRepository(pool);
  try {
    const tasks = await repository.findTasks(workflowRunId);
    const task = tasks.find((entry) => entry.taskKey === taskKey);
    if (!task) throw new Error(`task ${taskKey} not found in workflow ${workflowRunId}`);

    // G1：证据面按需求口径——读取工作流行的真实 requirement_id。
    const workflowRow = await pool.query<{ requirement_id: string }>(
      "SELECT requirement_id FROM workflow_runs WHERE id = $1",
      [workflowRunId]
    );
    const requirementId = workflowRow.rows[0]?.requirement_id ?? "replay";

    const verification = asRecord(task.output?.verification);
    const recorded = asRecord(verification.acResults);
    const passedKeys = Object.keys(recorded)
      .filter((key) => recorded[key] === "passed")
      .sort();
    if (passedKeys.length === 0) {
      throw new Error(`task ${taskKey} has no recorded passed acResults to replay`);
    }

    // Rebuild TAP lines from the task's own recorded acResults.
    const suiteOutput = passedKeys
      .map((key, index) => `ok ${index + 1} - [${key}] replay`)
      .join("\n");

    const sandbox = new ReplaySandbox((command) => {
      if (command.includes("package.json")) return { stdout: '{"test":"node --test"}' };
      if (command === "npm run test") return { stdout: suiteOutput };
      return undefined;
    });

    const now = new Date().toISOString();
    const workflow: WorkflowRun = {
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
    const result: TaskExecutionResult = {
      status: "succeeded",
      output: { summary: "replay" },
      agentRunId: "replay-run"
    };

    console.log(`workflow=${workflowRunId} task=${taskKey} id=${task.id} type=${task.type}`);
    console.log(`recorded acResults (passed): ${passedKeys.join(",")}`);

    const requirementTasks = await planning.findRuntimeTasksByRequirementId(requirementId);
    const evidence = requirementTasks.filter(
      (entry) => entry.id !== task.id && entry.status === "SUCCESS" && isDevTaskType(entry.type)
    );
    console.log(
      `evidence candidates (dev+SUCCESS, requirement-scoped): ${evidence.map((entry) => entry.taskKey).join(",")}`
    );
    for (const key of passedKeys) {
      const covering = evidence
        .filter((entry) => displayCoverage(entry, key))
        .map((entry) => entry.taskKey);
      console.log(`  ${key} <- ${covering.length > 0 ? covering.join(",") : "(none)"}`);
    }

    // Run A: requirement-scoped real tasks wired in (G1 evidence face).
    const realVerifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      requirementTasks: (id) => planning.findRuntimeTasksByRequirementId(id)
    });
    const recordA = await realVerifier.verify({ workflow, task, result });
    const checkA = recordA.checks.find((check) => check.name === "test");
    console.log(
      `run A: verdict=${recordA.verdict} expected=${checkA?.expected} passed=${checkA?.passed} ` +
        `acSummary=${JSON.stringify(recordA.acSummary)}`
    );

    // Run B: empty evidence (negative control).
    const controlVerifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      requirementTasks: async () => []
    });
    const recordB = await controlVerifier.verify({ workflow, task, result });
    const checkB = recordB.checks.find((check) => check.name === "test");
    console.log(
      `run B: verdict=${recordB.verdict} expected=${checkB?.expected} passed=${checkB?.passed} ` +
        `reason=${recordB.reason}`
    );

    const okA =
      recordA.verdict === "verified" &&
      checkA?.expected === "pass" &&
      checkA?.passed === true &&
      recordA.acSummary?.total === passedKeys.length &&
      recordA.acSummary?.failed === 0;
    const okB =
      recordB.verdict === "failed" && checkB?.expected === "fail" && checkB?.passed === false;
    console.log(`REPLAY_A_OK=${okA} REPLAY_B_OK=${okB}`);
    if (!okA || !okB) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
