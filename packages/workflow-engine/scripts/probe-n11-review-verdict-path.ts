/**
 * PL-M18 / N-11 probe: does a REVIEW task's honest negative verdict have a path?
 *
 * Runs the REAL WorkflowEngine against a real (in-memory) WorkflowStore and a fake executor
 * that returns the shape the server's task executor produces for a REVIEW whose professional
 * outcome is FAILED (`workflowTaskExecutor.ts:391`: agent run succeeded but the agent's
 * self-reported outcome is not SUCCESS => the TASK status is "failed").
 *
 * Tokens under test are the REAL policy objects:
 *   P0 = current eval L1 policy  ("RETRY", allowRetry, maxRetries 2, allowReplan FALSE)
 *   P1 = ruled new eval L1 policy ("REPLAN", allowRetry, maxRetries 2, allowReplan TRUE)
 *   P2 = control: the same task SUCCEEDS (no failure path entered at all)
 *
 * For each: workflow terminal status, per-task status, whether ANY dynamic (FIX/REPLAN)
 * task was created, and the event trail. The point of the probe is the branch SELECTION at
 * WorkflowEngine.ts:772 + 844-854, so the engine must be the real one; the store is a faithful
 * in-memory WorkflowStore of the same shape the engine's own unit tests use.
 *
 * Read-only: no DB access, no network, no writable state outside the process.
 *
 * Run from the repo root:
 *   corepack pnpm --filter @ai-se/workflow-engine exec tsx scripts/probe-n11-review-verdict-path.ts \
 *     [--out packages/eval/results/n11-probe]
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Approval,
  JsonObject,
  Task,
  TaskDependencyView,
  WorkflowEvent,
  WorkflowRun,
  WorkflowStatus
} from "@ai-se/shared";
import { WorkflowEngine } from "../src/WorkflowEngine.js";
import type {
  ReplanInput,
  TaskExecutionResult,
  WorkflowRunPatch,
  WorkflowRunUsage,
  WorkflowStore,
  WorkflowTaskExecutor,
  WorkflowTaskPatch
} from "../src/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface PolicyLike {
  maxConcurrency: number;
  maxRetries: number;
  failureStrategy: string;
  allowRetry: boolean;
  allowReplan: boolean;
  approvalRequired: boolean;
}

/** P0: the eval L1 policy as it stood before PL-M18 (packages/eval/src/cli.ts L1_POLICY_OVERRIDE). */
const P0_EVAL_L1: PolicyLike = {
  maxConcurrency: 1,
  maxRetries: 2,
  failureStrategy: "RETRY",
  allowRetry: true,
  allowReplan: false,
  approvalRequired: false
};

/** P1: the policy ruled for PL-M18 (failureStrategy REPLAN + allowReplan true). */
const P1_EVAL_L1: PolicyLike = {
  ...P0_EVAL_L1,
  failureStrategy: "REPLAN",
  allowReplan: true
};

function workflow(policy: PolicyLike): WorkflowRun {
  const now = new Date().toISOString();
  return {
    id: "wf-n11",
    projectId: "project-1",
    requirementId: "req-1",
    planningVersion: 1,
    status: "PENDING",
    policy: policy as unknown as WorkflowRun["policy"],
    input: {},
    createdAt: now,
    updatedAt: now
  };
}

/** The production shape: one REVIEW task in a slice, nothing else. */
function reviewTask(): Task {
  const now = new Date().toISOString();
  return {
    id: "task-review",
    projectId: "project-1",
    workflowRunId: "wf-n11",
    taskKey: "T-S4-R2",
    title: "Review slice-4 for AC coverage and 5xx risk",
    description: "review",
    type: "REVIEW",
    status: "READY",
    priority: "MEDIUM",
    input: {},
    retryCount: 0,
    version: 1,
    origin: "RUNTIME",
    failureHandled: false,
    createdAt: now,
    updatedAt: now
  };
}

class MemoryStore implements WorkflowStore {
  events: WorkflowEvent[] = [];

  constructor(
    public run: WorkflowRun,
    public tasks: Task[],
    public dependencies: TaskDependencyView[] = []
  ) {}

  async findWorkflowById(id: string) {
    return id === this.run.id ? this.run : null;
  }

  async findWorkflowsByStatuses(statuses: WorkflowStatus[]) {
    return statuses.includes(this.run.status) ? [this.run] : [];
  }

  async updateWorkflow(id: string, expected: WorkflowStatus[], patch: WorkflowRunPatch) {
    if (id !== this.run.id || !expected.includes(this.run.status)) return null;
    const { clearError, clearFinishedAt, ...rest } = patch;
    this.run = {
      ...this.run,
      ...rest,
      ...(clearError ? { error: undefined } : {}),
      ...(clearFinishedAt ? { finishedAt: undefined } : {}),
      updatedAt: new Date().toISOString()
    } as WorkflowRun;
    return this.run;
  }

  async sumRunUsage(): Promise<WorkflowRunUsage> {
    return { inputTokens: 0, outputTokens: 0, estimatedCostUsd: null };
  }

  async findEvents() {
    return this.events;
  }

  async findTasks() {
    return this.tasks;
  }

  async findDependencies() {
    return this.dependencies;
  }

  async updateTask(id: string, expected: Task["status"][], patch: WorkflowTaskPatch) {
    const index = this.tasks.findIndex(
      (entry) => entry.id === id && expected.includes(entry.status)
    );
    if (index < 0) return null;
    const current = this.tasks[index];
    const next = {
      ...current,
      ...patch,
      claimToken: patch.clearClaim ? undefined : current.claimToken,
      claimedAt: patch.clearClaim ? undefined : current.claimedAt,
      updatedAt: new Date().toISOString()
    } as Task & { clearClaim?: boolean };
    delete next.clearClaim;
    this.tasks[index] = next;
    return next;
  }

  async claimNextTask(_workflowRunId: string, claimToken: string) {
    const running = this.tasks.filter((entry) => entry.status === "RUNNING").length;
    if (running >= this.run.policy.maxConcurrency) return null;
    const candidate = this.tasks.find((entry) => entry.status === "READY");
    if (!candidate) return null;
    candidate.status = "RUNNING";
    candidate.claimToken = claimToken;
    candidate.startedAt = new Date().toISOString();
    return candidate;
  }

  async claimFailureHandling(taskId: string) {
    const candidate = this.tasks.find(
      (entry) => entry.id === taskId && entry.status === "FAILED" && entry.failureHandled !== true
    );
    if (!candidate) return null;
    candidate.failureHandled = true;
    return candidate;
  }

  async cancelNonTerminalTasks() {
    return this.tasks
      .filter((entry) =>
        ["PENDING", "READY", "RUNNING", "RETRYING", "WAITING_APPROVAL"].includes(entry.status)
      )
      .map((entry) => {
        entry.status = "CANCELLED";
        return entry;
      });
  }

  async recoverRunningTasks() {
    let count = 0;
    for (const entry of this.tasks) {
      if (entry.status === "RUNNING") {
        entry.status = "RETRYING";
        count += 1;
      }
    }
    return count;
  }

  async createApproval(workflowRunId: string, taskId: string, reason: string) {
    const now = new Date().toISOString();
    const approval: Approval = {
      id: randomUUID(),
      workflowRunId,
      taskId,
      status: "PENDING",
      reason,
      comment: "",
      requestedAt: now,
      createdAt: now,
      updatedAt: now
    };
    return approval;
  }

  async findApprovals() {
    return [] as Approval[];
  }

  async findApprovalById() {
    return null;
  }

  async decideApproval() {
    return null;
  }

  async setDependenciesActive(
    _workflowRunId: string,
    updates: Array<{ id: string; active: boolean }>
  ) {
    const byId = new Map(updates.map((entry) => [entry.id, entry.active]));
    for (const dependency of this.dependencies) {
      if (byId.has(dependency.id)) dependency.active = byId.get(dependency.id)!;
    }
  }

  async applyReplan(input: ReplanInput) {
    for (const dynamic of input.tasks) {
      this.tasks.push({
        ...reviewTask(),
        id: dynamic.id,
        taskKey: dynamic.taskKey,
        title: dynamic.title,
        description: dynamic.description,
        type: dynamic.type,
        status: "READY",
        priority: dynamic.priority,
        input: dynamic.input as JsonObject,
        origin: "DYNAMIC",
        sourceTaskId: dynamic.sourceTaskId,
        creationReason: dynamic.creationReason
      } as Task);
    }
    const source = this.tasks.find((entry) => entry.id === input.sourceTaskId);
    if (source && !["SUCCESS", "CANCELLED"].includes(source.status)) source.status = "SUCCESS";
  }

  async createEvent(input: {
    workflowRunId: string;
    taskId?: string;
    agentRunId?: string;
    eventType: string;
    payload: JsonObject;
  }) {
    const event: WorkflowEvent = {
      id: randomUUID(),
      workflowRunId: input.workflowRunId,
      taskId: input.taskId,
      agentRunId: input.agentRunId,
      eventType: input.eventType,
      payload: input.payload,
      createdAt: new Date().toISOString()
    } as WorkflowEvent;
    this.events.push(event);
    return event;
  }
}

/**
 * Production shape seen by the engine: the REVIEW task comes back failed
 * (`workflowTaskExecutor.ts:391`), every other task type completes normally.
 */
class FailingReviewExecutor implements WorkflowTaskExecutor {
  executed: Array<{ taskKey: string; type: string; result: string }> = [];
  constructor(private readonly succeed = false) {}

  async execute(_workflow: WorkflowRun, current: Task): Promise<TaskExecutionResult> {
    const shouldFail = !this.succeed && current.type === "REVIEW";
    this.executed.push({
      taskKey: current.taskKey,
      type: current.type,
      result: shouldFail ? "failed" : "succeeded"
    });
    if (!shouldFail) return { status: "succeeded", output: { outcome: "SUCCESS" } };
    return {
      status: "failed",
      output: {
        outcome: "FAILED",
        outcomeMode: "tool",
        summary: "NOT APPROVED: project-wide pnpm test is not green (144/145)"
      },
      error: { code: "AGENT_FAILED", message: "review did not approve the slice" }
    } as unknown as TaskExecutionResult;
  }

  async cancel() {}
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("Condition not reached");
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function runVariant(label: string, policy: PolicyLike, succeed: boolean) {
  const store = new MemoryStore(workflow(policy), [reviewTask()]);
  const executor = new FailingReviewExecutor(succeed);
  const engine = new WorkflowEngine({ store, executor });
  await engine.start("wf-n11");
  await waitFor(() => ["SUCCESS", "FAILED", "CANCELLED"].includes(store.run.status));

  const dynamic = store.tasks.filter((entry) => entry.origin === "DYNAMIC");
  const result = {
    label,
    policy: {
      failureStrategy: policy.failureStrategy,
      allowRetry: policy.allowRetry,
      maxRetries: policy.maxRetries,
      allowReplan: policy.allowReplan
    },
    workflowStatus: store.run.status,
    executedAttempts: executor.executed.length,
    executed: executor.executed,
    tasks: store.tasks.map((entry) => ({
      taskKey: entry.taskKey,
      type: entry.type,
      status: entry.status,
      retryCount: entry.retryCount,
      origin: entry.origin
    })),
    dynamicTaskKeys: dynamic.map((entry) => entry.taskKey),
    fixTasksCreated: dynamic.length,
    eventTypes: [...new Set(store.events.map((entry) => entry.eventType))]
  };
  console.log(
    `${label}: wf=${result.workflowStatus} attempts=${result.executedAttempts} ` +
      `fixTasks=${result.fixTasksCreated} events=[${result.eventTypes.join(",")}]`
  );
  console.log(`  tasks: ${result.tasks.map((t) => `${t.taskKey}:${t.status}(retry=${t.retryCount})`).join(" ")}`);
  return result;
}

async function main(): Promise<void> {
  const outDir = resolve(REPO_ROOT, argValue("--out") ?? "packages/eval/results/n11-probe");

  const p0 = await runVariant("P0 current eval L1 (RETRY, allowReplan=false)", P0_EVAL_L1, false);
  const p1 = await runVariant("P1 ruled eval L1 (REPLAN, allowReplan=true)", P1_EVAL_L1, false);
  const p2 = await runVariant("P2 control (REVIEW succeeds)", P0_EVAL_L1, true);

  const expectations = {
    P0_NO_PATH: p0.workflowStatus === "FAILED" && p0.fixTasksCreated === 0,
    P1_HAS_PATH: p1.workflowStatus !== "FAILED" && p1.fixTasksCreated > 0,
    P2_CONTROL_OK: p2.workflowStatus === "SUCCESS" && p2.fixTasksCreated === 0
  };
  for (const [name, ok] of Object.entries(expectations)) console.log(`${name}=${ok}`);

  const report = {
    generatedAt: new Date().toISOString(),
    variants: { p0, p1, p2 },
    expectations
  };
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, `n11-${Date.now()}.json`);
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`report=${outFile}`);

  if (!expectations.P0_NO_PATH || !expectations.P1_HAS_PATH || !expectations.P2_CONTROL_OK) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
