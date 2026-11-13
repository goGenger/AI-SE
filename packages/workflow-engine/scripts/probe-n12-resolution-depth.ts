/**
 * PL-M19 / N-12 probe: how deep does the engine's "resolved" bookkeeping go?
 *
 * N-12 (L1-M4j, workflow bb5f0610): a FAILED task counts as resolved only when its DIRECT
 * `resolvedByTaskId` points at a SUCCESS task (`WorkflowEngine.ts:532-538`, and the same
 * predicate at `:278-282`). `replan()` sets that pointer to the NEXT layer down
 * (`WorkflowEngine.ts:968`), so when the rescue itself needs a second re-plan the top task
 * keeps a pointer to an intermediate that is still FAILED — and the workflow is reported
 * FAILED even though the chain terminated in SUCCESS.
 *
 * FAITHFULNESS (the point of this probe): `applyReplan` below replicates the real store
 * (`packages/database/src/workflowRepositories.ts:821-824`) EXACTLY — it writes
 * `resolved_by_task_id` on the source and **leaves the source FAILED**. The PL-M18 / N-11
 * probe's store did not: it forced the source to SUCCESS, which is why N-12 was invisible
 * to it. A probe that simplifies away the bookkeeping cannot see a bookkeeping defect.
 *
 * Variants (all on the RULED L1 policy: failureStrategy REPLAN + allowReplan true):
 *   P0  single-layer rescue   T-01 fails, T-01-REPLAN-1 succeeds            => SUCCESS (control)
 *   P1  second-layer rescue   T-01 and T-01-REPLAN-1 fail, ...-REPLAN-2 ok  => the N-12 shape
 *   P2  chain ends in failure every layer fails                            => FAILED (reverse control)
 *
 * P1 is the observed variable: it is FAILED before the fix and must be SUCCESS after.
 * P0 / P2 are invariants the fix must not move — P2 in particular is the "a chain that
 * really could not be rescued must stay FAILED" red line.
 *
 * The engine is the REAL one; only the executor is fake. Read-only: no DB, no network.
 *
 * Run from the repo root:
 *   corepack pnpm --filter @ai-se/workflow-engine exec tsx scripts/probe-n12-resolution-depth.ts \
 *     [--out packages/eval/results/n12-probe]
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

/** The ruled L1 policy (PL-M18): REPLAN is the failure response, depth budget 2. */
const L1_POLICY = {
  maxConcurrency: 1,
  maxRetries: 2,
  failureStrategy: "REPLAN",
  allowRetry: true,
  allowReplan: true,
  approvalRequired: false
} as const;

function workflow(): WorkflowRun {
  const now = new Date().toISOString();
  return {
    id: "wf-n12",
    projectId: "project-1",
    requirementId: "req-1",
    planningVersion: 1,
    status: "PENDING",
    policy: L1_POLICY as unknown as WorkflowRun["policy"],
    input: {},
    createdAt: now,
    updatedAt: now
  };
}

/** The production shape: one BACKEND task in slice-1; every re-plan grows from it. */
function rootTask(): Task {
  const now = new Date().toISOString();
  return {
    id: "task-root",
    projectId: "project-1",
    workflowRunId: "wf-n12",
    taskKey: "T-01",
    title: "Implement the slice-1 API surface",
    description: "backend work",
    type: "BACKEND",
    status: "READY",
    priority: "MEDIUM",
    input: {},
    sliceKey: "slice-1",
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

  /**
   * FAITHFUL to `workflowRepositories.ts:821-824`: the dynamic tasks are appended, then the
   * source's `resolvedByTaskId` is written — and the source KEEPS its FAILED status.
   */
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
    const source = this.tasks.find((entry) => entry.id === input.sourceTaskId);
    for (const dynamic of input.tasks) {
      this.tasks.push({
        ...rootTask(),
        id: dynamic.id,
        taskKey: dynamic.taskKey,
        title: dynamic.title,
        description: dynamic.description,
        type: dynamic.type,
        status: "READY",
        priority: dynamic.priority,
        input: dynamic.input as JsonObject,
        sliceKey: source?.sliceKey,
        origin: "DYNAMIC",
        sourceTaskId: dynamic.sourceTaskId,
        creationReason: dynamic.creationReason
      } as Task);
    }
    for (const dependency of input.dependencies) {
      this.dependencies.push({
        id: randomUUID(),
        workflowRunId: input.workflowRunId,
        sourceTaskId: dependency.sourceTaskId,
        targetTaskId: dependency.targetTaskId,
        origin: "DYNAMIC",
        active: true
      } as unknown as TaskDependencyView);
    }
    if (source) {
      source.resolvedByTaskId = input.resolvedByTaskId;
      source.failureHandled = true;
    }
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

/** DEBUG diagnostics always succeed (as they did in L1-M4j); the plan decides the rest. */
class PlanExecutor implements WorkflowTaskExecutor {
  executed: Array<{ taskKey: string; type: string; result: string }> = [];
  constructor(private readonly shouldFail: (taskKey: string) => boolean) {}

  async execute(_workflow: WorkflowRun, current: Task): Promise<TaskExecutionResult> {
    const fail = current.type !== "DEBUG" && this.shouldFail(current.taskKey);
    this.executed.push({
      taskKey: current.taskKey,
      type: current.type,
      result: fail ? "failed" : "succeeded"
    });
    if (!fail) return { status: "succeeded", output: { outcome: "SUCCESS" } };
    return {
      status: "failed",
      output: { outcome: "FAILED" },
      error: { code: "AGENT_FAILED", message: "task did not pass verification" }
    } as unknown as TaskExecutionResult;
  }

  async cancel() {}
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("Condition not reached");
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function runVariant(label: string, shouldFail: (taskKey: string) => boolean) {
  const store = new MemoryStore(workflow(), [rootTask()]);
  const executor = new PlanExecutor(shouldFail);
  const engine = new WorkflowEngine({ store, executor });
  await engine.start("wf-n12");
  await waitFor(() => ["SUCCESS", "FAILED", "CANCELLED"].includes(store.run.status));

  const byId = new Map(store.tasks.map((entry) => [entry.id, entry]));
  const chain = (key: string): string => {
    const seen = new Set<string>();
    let current = store.tasks.find((entry) => entry.taskKey === key);
    const parts: string[] = [];
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      parts.push(`${current.taskKey}:${current.status}`);
      current = current.resolvedByTaskId ? byId.get(current.resolvedByTaskId) : undefined;
    }
    return parts.length > 0 ? parts.join(" -> ") : "(none)";
  };

  const result = {
    label,
    workflowStatus: store.run.status,
    errorCode: store.run.error?.code ?? null,
    errorMessage: store.run.error?.message ?? null,
    executedAttempts: executor.executed.length,
    executed: executor.executed,
    tasks: store.tasks.map((entry) => ({
      taskKey: entry.taskKey,
      type: entry.type,
      status: entry.status,
      origin: entry.origin,
      resolvedByTaskKey: entry.resolvedByTaskId
        ? (byId.get(entry.resolvedByTaskId)?.taskKey ?? "(missing)")
        : null
    })),
    resolutionChain: chain("T-01"),
    eventTypes: [...new Set(store.events.map((entry) => entry.eventType))]
  };
  console.log(`${label}: wf=${result.workflowStatus} attempts=${result.executedAttempts}`);
  console.log(`  T-01 resolution chain: ${result.resolutionChain}`);
  console.log(
    `  tasks: ${result.tasks
      .map((t) => `${t.taskKey}:${t.status}${t.resolvedByTaskKey ? `->${t.resolvedByTaskKey}` : ""}`)
      .join(" ")}`
  );
  return result;
}

async function main(): Promise<void> {
  const outDir = resolve(REPO_ROOT, argValue("--out") ?? "packages/eval/results/n12-probe");

  const p0 = await runVariant("P0 single-layer rescue (control)", (key) => key === "T-01");
  const p1 = await runVariant(
    "P1 second-layer rescue (N-12 shape)",
    (key) => key === "T-01" || key === "T-01-REPLAN-1"
  );
  const p2 = await runVariant(
    "P2 chain ends in failure (reverse control)",
    (key) =>
      key === "T-01" || key === "T-01-REPLAN-1" || key === "T-01-REPLAN-1-REPLAN-2"
  );

  const findings = {
    P0_INVARIANT_SUCCESS: p0.workflowStatus === "SUCCESS",
    P2_INVARIANT_FAILED: p2.workflowStatus === "FAILED",
    /** true while the defect is live; false once the rescue is followed transitively. */
    N12_REPRODUCED: p1.workflowStatus === "FAILED"
  };
  for (const [name, ok] of Object.entries(findings)) console.log(`${name}=${ok}`);

  const report = {
    generatedAt: new Date().toISOString(),
    policy: L1_POLICY,
    variants: { p0, p1, p2 },
    findings
  };
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, `n12-${Date.now()}.json`);
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`report=${outFile}`);

  if (!findings.P0_INVARIANT_SUCCESS || !findings.P2_INVARIANT_FAILED) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
