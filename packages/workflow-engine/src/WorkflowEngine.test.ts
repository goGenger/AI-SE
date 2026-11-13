import {
  Approval,
  AUTONOMY_DECISION_EVENT_TYPES,
  BACKEND_NODE_PROFILE,
  JsonObject,
  parseAutonomyDecisionPayload,
  Task,
  TaskDependencyView,
  TaskTypeSchema,
  WorkflowEvent,
  WorkflowRun,
  WorkflowStatus
} from "@ai-se/shared";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeBudgetWallClockMs, nextReplanKeyAttempt, WorkflowEngine } from "./WorkflowEngine";
import {
  ReplanInput,
  TaskExecutionResult,
  WorkflowRunPatch,
  WorkflowRunUsage,
  WorkflowStore,
  WorkflowTaskExecutor,
  WorkflowTaskPatch
} from "./types";

function workflow(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "workflow",
    projectId: "project",
    requirementId: "requirement",
    planningVersion: 1,
    status: "PENDING",
    policy: {
      maxConcurrency: 2,
      maxRetries: 1,
      failureStrategy: "FAIL_FAST",
      allowRetry: true,
      allowReplan: false,
      approvalRequired: false
    },
    input: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    projectId: "project",
    workflowRunId: "workflow",
    taskKey: id,
    title: id,
    description: id,
    type: "TEST",
    status: "PENDING",
    priority: "MEDIUM",
    input: {},
    retryCount: 0,
    version: 1,
    origin: "RUNTIME",
    approvalRequired: false,
    failureHandled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function edge(sourceTaskId: string, targetTaskId: string): TaskDependencyView {
  return {
    id: randomUUID(),
    sourceTaskId,
    targetTaskId,
    sourceTaskKey: sourceTaskId,
    targetTaskKey: targetTaskId,
    workflowRunId: "workflow",
    origin: "RUNTIME",
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

class MemoryStore implements WorkflowStore {
  approvals: Approval[] = [];
  events: WorkflowEvent[] = [];
  /** 写调用留痕:用于断言"未被触碰"与重排参数(retry 用例)。 */
  taskWrites: Array<{ id: string; patch: WorkflowTaskPatch }> = [];
  workflowWrites: Array<{ id: string; patch: WorkflowRunPatch }> = [];
  /** T6：可注入用量（默认 0 / 无成本数据）；usageReads 供「未设限零查询」断言。 */
  usage: WorkflowRunUsage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: null };
  usageReads = 0;

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
    this.workflowWrites.push({ id, patch });
    const { clearError, clearFinishedAt, ...rest } = patch;
    this.run = {
      ...this.run,
      ...rest,
      ...(clearError ? { error: undefined } : {}),
      ...(clearFinishedAt ? { finishedAt: undefined } : {}),
      updatedAt: new Date().toISOString()
    };
    return this.run;
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
    this.taskWrites.push({ id, patch });
    const current = this.tasks[index];
    const next: Task = {
      ...current,
      ...patch,
      claimToken: patch.clearClaim ? undefined : current.claimToken,
      claimedAt: patch.clearClaim ? undefined : current.claimedAt,
      updatedAt: new Date().toISOString()
    };
    delete (next as Task & { clearClaim?: boolean }).clearClaim;
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
        entry.retryCount = entry.retryCount + 1;
        count += 1;
      }
    }
    return count;
  }

  async createApproval(workflowRunId: string, taskId: string, reason: string) {
    const approval: Approval = {
      id: randomUUID(),
      workflowRunId,
      taskId,
      status: "PENDING",
      reason,
      comment: "",
      requestedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.approvals.push(approval);
    return approval;
  }

  async findApprovals() {
    return this.approvals;
  }

  async findApprovalById(id: string) {
    return this.approvals.find((entry) => entry.id === id) ?? null;
  }

  async decideApproval(id: string, status: "APPROVED" | "REJECTED", comment: string) {
    const approval = this.approvals.find((entry) => entry.id === id && entry.status === "PENDING");
    if (!approval) return null;
    approval.status = status;
    approval.comment = comment;
    approval.decidedAt = new Date().toISOString();
    return approval;
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
    const version = this.tasks.find((entry) => entry.id === input.sourceTaskId)?.version ?? 1;
    for (const dynamic of input.tasks) {
      // Mirror tasks_workflow_key_idx so collision bugs surface in unit tests.
      if (
        this.tasks.some(
          (entry) =>
            entry.workflowRunId === dynamic.workflowRunId && entry.taskKey === dynamic.taskKey
        )
      ) {
        throw new Error(
          `duplicate key value violates unique constraint "tasks_workflow_key_idx": (${dynamic.workflowRunId}, ${dynamic.taskKey})`
        );
      }
      this.tasks.push(
        task(dynamic.id, {
          projectId: dynamic.projectId,
          workflowRunId: dynamic.workflowRunId,
          planTaskId: dynamic.planTaskId,
          taskKey: dynamic.taskKey,
          title: dynamic.title,
          description: dynamic.description,
          type: dynamic.type,
          priority: dynamic.priority,
          input: dynamic.input,
          version,
          origin: "DYNAMIC",
          sourceTaskId: dynamic.sourceTaskId,
          creationReason: dynamic.creationReason,
          approvalRequired: dynamic.approvalRequired
        })
      );
    }
    for (const dependency of this.dependencies) {
      if (input.deactivateDependencyIds.includes(dependency.id)) dependency.active = false;
    }
    this.dependencies.push(
      ...input.dependencies.map((entry) => edge(entry.sourceTaskId, entry.targetTaskId))
    );
    const source = this.tasks.find((entry) => entry.id === input.sourceTaskId);
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
      ...input,
      createdAt: new Date().toISOString()
    };
    this.events.push(event);
    return event;
  }

  async sumRunUsage() {
    this.usageReads += 1;
    return this.usage;
  }

  async findEvents() {
    return this.events;
  }
}

class SequenceExecutor implements WorkflowTaskExecutor {
  started: string[] = [];
  cancelled: string[] = [];

  constructor(private readonly results: Record<string, TaskExecutionResult[]> = {}) {}

  async execute(_workflow: WorkflowRun, current: Task): Promise<TaskExecutionResult> {
    this.started.push(current.taskKey);
    return this.results[current.taskKey]?.shift() ?? { status: "succeeded", output: { ok: true } };
  }

  async cancel(current: Task) {
    this.cancelled.push(current.taskKey);
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition not reached");
}

describe("WorkflowEngine", () => {
  it("runs A -> B -> C in dependency order", async () => {
    const store = new MemoryStore(
      workflow(),
      [task("A"), task("B"), task("C")],
      [edge("A", "B"), edge("B", "C")]
    );
    const executor = new SequenceExecutor();
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");
    expect(executor.started).toEqual(["A", "B", "C"]);
  });

  it("runs independent roots in parallel and obeys maxConcurrency", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class GateExecutor extends SequenceExecutor {
      override async execute(_workflow: WorkflowRun, current: Task) {
        this.started.push(current.taskKey);
        await gate;
        return { status: "succeeded" as const };
      }
    }
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, maxConcurrency: 2 } }),
      [task("A"), task("B"), task("C")]
    );
    const executor = new GateExecutor();
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => executor.started.length === 2);
    expect(executor.started).toEqual(["A", "B"]);
    release();
    await waitFor(() => store.run.status === "SUCCESS");
    expect(executor.started).toContain("C");
  });

  it("retries a failed task and stops after max retries", async () => {
    const retryStore = new MemoryStore(
      workflow({ policy: { ...workflow().policy, failureStrategy: "RETRY", maxRetries: 1 } }),
      [task("A")]
    );
    const retryExecutor = new SequenceExecutor({
      A: [{ status: "failed" }, { status: "succeeded" }]
    });
    await new WorkflowEngine({ store: retryStore, executor: retryExecutor }).start("workflow");
    await waitFor(() => retryStore.run.status === "SUCCESS");
    expect(retryStore.tasks[0].retryCount).toBe(1);

    const failedStore = new MemoryStore(
      workflow({ policy: { ...workflow().policy, failureStrategy: "RETRY", maxRetries: 1 } }),
      [task("A")]
    );
    const failedExecutor = new SequenceExecutor({
      A: [{ status: "failed" }, { status: "failed" }]
    });
    await new WorkflowEngine({ store: failedStore, executor: failedExecutor }).start("workflow");
    await waitFor(() => failedStore.run.status === "FAILED");
    expect(failedExecutor.started).toHaveLength(2);
  });

  it("retries a transient deployment failure once", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, failureStrategy: "RETRY", maxRetries: 1 } }),
      [
        task("DEPLOY", {
          type: "DEPLOY",
          input: { delivery: { action: "DEPLOY", environment: "staging" } }
        })
      ]
    );
    const executor = new SequenceExecutor({
      DEPLOY: [{ status: "failed" }, { status: "succeeded" }]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");
    expect(executor.started).toEqual(["DEPLOY", "DEPLOY"]);
  });

  it("creates validated dynamic debug and retry tasks after failure", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, failureStrategy: "REPLAN", allowReplan: true } }),
      [task("TEST", { input: { execution: { failuresBeforeSuccess: 1 } } })]
    );
    const executor = new SequenceExecutor({ TEST: [{ status: "failed" }] });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");
    expect(store.tasks.filter((entry) => entry.origin === "DYNAMIC")).toHaveLength(2);
    expect(store.events.map((event) => event.eventType)).toContain("REPLAN_COMPLETED");
  });

  it("re-targets a failed DEBUG task at its parent work type instead of DEBUG", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, failureStrategy: "REPLAN", allowReplan: true } }),
      [task("FIX", { type: "DEBUG", input: { targetTaskType: "BACKEND" } })]
    );
    const executor = new SequenceExecutor({
      FIX: [{ status: "failed" }],
      "FIX-REPLAN-1": [{ status: "succeeded" }]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");
    // DEBUG 源不再叠 Diagnose：直接开继承 targetTaskType 的修复任务。
    expect(store.tasks.some((entry) => entry.taskKey === "FIX-DEBUG-1")).toBe(false);
    const retry = store.tasks.find((entry) => entry.taskKey === "FIX-REPLAN-1");
    expect(retry?.type).toBe("BACKEND");
    expect(retry?.input.targetTaskType).toBe("BACKEND");
  });

  /**
   * N-61（`docs/232` §10）：**上游不可用不走 REPLAN**。
   *
   * 实测（2026-10-29 F1 第三轮）：`T7` 撞 429 → REPLAN 造 `T7-DEBUG-1` → 再撞 429 →
   * `T7-DEBUG-1-DEBUG-2`，三次全撞同一堵墙。诊断任务治不了上游容量，只会烧调用并把
   * 归因指向「agent 做错了」那一层。
   */
  describe("N-61：上游不可用改走原任务重试", () => {
    const providerDown = {
      status: "failed" as const,
      output: { errorReason: "PROVIDER_UNAVAILABLE" }
    };

    it("策略是 REPLAN 时改为原地重试，且不创建诊断任务", async () => {
      const store = new MemoryStore(
        workflow({
          policy: {
            ...workflow().policy,
            failureStrategy: "REPLAN",
            allowReplan: true,
            maxRetries: 2
          }
        }),
        [task("A")]
      );
      const executor = new SequenceExecutor({ A: [providerDown, { status: "succeeded" }] });
      await new WorkflowEngine({ store, executor }).start("workflow");
      await waitFor(() => store.run.status === "SUCCESS");

      expect(executor.started).toEqual(["A", "A"]);
      expect(store.tasks.some((entry) => entry.type === "DEBUG")).toBe(false);
      expect(store.events.filter((event) => event.eventType === "REPLAN_STARTED")).toHaveLength(0);
      expect(store.events.find((event) => event.eventType === "FAILURE_ROUTED")?.payload).toMatchObject(
        { strategy: "RETRY", failureClass: "provider-unavailable" }
      );
    });

    it("重试额度用尽后如实终结，措辞点名「上游不可用」", async () => {
      const store = new MemoryStore(
        workflow({
          policy: {
            ...workflow().policy,
            failureStrategy: "REPLAN",
            allowReplan: true,
            maxRetries: 1
          }
        }),
        [task("A")]
      );
      const executor = new SequenceExecutor({ A: [providerDown, providerDown] });
      await new WorkflowEngine({ store, executor }).start("workflow");
      await waitFor(() => store.run.status === "FAILED");

      expect(executor.started).toEqual(["A", "A"]);
      expect(store.tasks.some((entry) => entry.type === "DEBUG")).toBe(false);
      expect(store.run.error?.message ?? "").toContain("Model provider unavailable");
    });

    it("没有该标记的普通失败仍走 REPLAN（别把整条链关掉）", async () => {
      const store = new MemoryStore(
        workflow({ policy: { ...workflow().policy, failureStrategy: "REPLAN", allowReplan: true } }),
        [task("A")]
      );
      const executor = new SequenceExecutor({ A: [{ status: "failed" }] });
      await new WorkflowEngine({ store, executor }).start("workflow");
      await waitFor(() => store.run.status === "SUCCESS");
      expect(store.tasks.some((entry) => entry.type === "DEBUG")).toBe(true);
    });

    it("配额耗尽标记 ⇒ 人工介入，不烧重试额度", async () => {
      const quotaDown = {
        status: "failed" as const,
        error: { code: "LLM_ERROR", message: "429 Go usage limit exceeded" },
        output: { errorReason: "QUOTA_EXHAUSTED" }
      };
      const store = new MemoryStore(
        workflow({
          policy: {
            ...workflow().policy,
            failureStrategy: "REPLAN",
            allowReplan: true,
            maxRetries: 2
          }
        }),
        [task("A")]
      );
      const executor = new SequenceExecutor({ A: [quotaDown] });
      await new WorkflowEngine({ store, executor }).start("workflow");
      await waitFor(() => store.run.status === "WAITING_APPROVAL");
      expect(executor.started).toEqual(["A"]);
      expect(store.events.some((event) => event.eventType === "FAILURE_HUMAN_REQUIRED")).toBe(true);
      expect(
        store.events.find((event) => event.eventType === "FAILURE_HUMAN_REQUIRED")?.payload
      ).toMatchObject({ failureClass: "quota-exhausted" });
    });
  });

  /**
   * `docs/235` §6.5：`fixFallback` **真的被读到了**。
   *
   * 失败的是 REVIEW（不是工作类型），切片里也没有任何工作类型 ⇒ 修复任务落在 profile 的
   * `fixFallback` 上。缺省 BACKEND 是迁移前行为；换成 FRONTEND 后没有任何分支需要改——
   * 这正是"能力面收拢"要的那种形状。
   */
  it("docs/235 §6.5：修复任务的回退类型来自能力 profile", async () => {
    const frontendProfile = {
      ...BACKEND_NODE_PROFILE,
      taskTypes: {
        ...BACKEND_NODE_PROFILE.taskTypes,
        work: ["FRONTEND"] as const,
        fixFallback: "FRONTEND" as const
      }
    };
    const replanPolicy = {
      ...workflow().policy,
      failureStrategy: "REPLAN" as const,
      allowReplan: true
    };

    const first = new MemoryStore(workflow({ policy: replanPolicy }), [
      task("REV", { type: "REVIEW" })
    ]);
    await new WorkflowEngine({
      store: first,
      executor: new SequenceExecutor({ REV: [{ status: "failed" }] }),
      profile: frontendProfile
    }).start("workflow");
    await waitFor(() => first.run.status === "SUCCESS");
    expect(first.tasks.find((entry) => entry.taskKey === "REV-REPLAN-1")?.type).toBe("FRONTEND");

    // 反向对照：同一场景、缺省 profile（frontend-vue）⇒ fixFallback = FRONTEND。
    const second = new MemoryStore(workflow({ policy: replanPolicy }), [
      task("REV", { type: "REVIEW" })
    ]);
    await new WorkflowEngine({
      store: second,
      executor: new SequenceExecutor({ REV: [{ status: "failed" }] })
    }).start("workflow");
    await waitFor(() => second.run.status === "SUCCESS");
    expect(second.tasks.find((entry) => entry.taskKey === "REV-REPLAN-1")?.type).toBe("FRONTEND");
  });

  it("PL-M3：fixTaskType 不在 TaskType 枚举内（IMPLEMENTATION）→ 回退到源任务的工作类型并记事件", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, failureStrategy: "REPLAN", allowReplan: true } }),
      [task("FIX", { type: "DEBUG", input: { targetTaskType: "BACKEND" } })]
    );
    const executor = new SequenceExecutor({
      FIX: [{ status: "failed", output: { fixTaskType: "IMPLEMENTATION" } }],
      "FIX-REPLAN-1": [{ status: "succeeded" }]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    expect(store.tasks.some((entry) => entry.taskKey === "FIX-DEBUG-1")).toBe(false);
    const retry = store.tasks.find((entry) => entry.taskKey === "FIX-REPLAN-1");
    expect(retry?.type).toBe("BACKEND");
    // 不得产出任何 `type` 落在枚举外的任务。
    for (const entry of store.tasks) {
      expect(TaskTypeSchema.options).toContain(entry.type);
    }
    const fallback = store.events.find(
      (event) => event.eventType === "DEBUG_TARGET_TYPE_FALLBACK"
    );
    expect(fallback?.payload).toMatchObject({
      sourceTaskId: expect.any(String),
      sourceTaskKey: "FIX",
      fallbackTaskType: "BACKEND",
      reason: "fixTaskType is not a usable task type"
    });
  });

  it("PL-M3：fixTaskType 是运行期专属类型（MONITOR）→ 同样回退", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, failureStrategy: "REPLAN", allowReplan: true } }),
      [task("FIX", { type: "DEBUG", input: { targetTaskType: "FRONTEND" } })]
    );
    const executor = new SequenceExecutor({
      FIX: [{ status: "failed", output: { fixTaskType: "MONITOR" } }],
      "FIX-REPLAN-1": [{ status: "succeeded" }]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    const retry = store.tasks.find((entry) => entry.taskKey === "FIX-REPLAN-1");
    expect(retry?.type).toBe("FRONTEND");
    expect(
      store.events.some((event) => event.eventType === "DEBUG_TARGET_TYPE_FALLBACK")
    ).toBe(true);
  });

  it("PL-M3：合法 fixTaskType 行为不变、不记回退事件", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, failureStrategy: "REPLAN", allowReplan: true } }),
      [task("FIX", { type: "DEBUG", input: { targetTaskType: "BACKEND" } })]
    );
    const executor = new SequenceExecutor({
      FIX: [{ status: "failed", output: { fixTaskType: "FRONTEND" } }],
      "FIX-REPLAN-1": [{ status: "succeeded" }]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    expect(store.tasks.some((entry) => entry.taskKey === "FIX-DEBUG-1")).toBe(false);
    const retry = store.tasks.find((entry) => entry.taskKey === "FIX-REPLAN-1");
    expect(retry?.type).toBe("FRONTEND");
    expect(retry?.title).toContain("FRONTEND");
    expect(
      store.events.some((event) => event.eventType === "DEBUG_TARGET_TYPE_FALLBACK")
    ).toBe(false);
  });

  it("stops re-planning after maxRetries", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, failureStrategy: "REPLAN", allowReplan: true } }),
      [task("TEST", { status: "FAILED", input: { executionAttempt: 1 } })]
    );

    await new WorkflowEngine({ store, executor: new SequenceExecutor() }).start("workflow");
    await waitFor(() => store.run.status === "FAILED");

    expect(store.tasks.filter((entry) => entry.origin === "DYNAMIC")).toHaveLength(0);
  });

  it("creates a workflow-owned rollback task for failed deployments", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, failureStrategy: "ROLLBACK" } }),
      [
        task("DEPLOY", {
          type: "DEPLOY",
          input: { delivery: { action: "DEPLOY", environment: "staging" } }
        })
      ]
    );
    const executor = new SequenceExecutor({
      DEPLOY: [{ status: "failed", output: { deploymentId: "failed-deployment" } }]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");
    const rollback = store.tasks.find((entry) => entry.taskKey === "DEPLOY-ROLLBACK");
    expect(rollback?.input.delivery).toEqual({ action: "ROLLBACK", environment: "staging" });
    expect(rollback?.input.rollbackDeploymentId).toBe("failed-deployment");
    expect(store.events.map((event) => event.eventType)).toContain("ROLLBACK_TASK_CREATED");
  });

  it("waits for approval and supports approve and reject", async () => {
    const approvedStore = new MemoryStore(workflow(), [task("A", { approvalRequired: true })]);
    const approvedEngine = new WorkflowEngine({
      store: approvedStore,
      executor: new SequenceExecutor()
    });
    await approvedEngine.start("workflow");
    await waitFor(() => approvedStore.run.status === "WAITING_APPROVAL");
    await approvedEngine.approve(approvedStore.approvals[0].id, "ok");
    await waitFor(() => approvedStore.run.status === "SUCCESS");

    const rejectedStore = new MemoryStore(workflow(), [task("A", { approvalRequired: true })]);
    const rejectedEngine = new WorkflowEngine({
      store: rejectedStore,
      executor: new SequenceExecutor()
    });
    await rejectedEngine.start("workflow");
    await waitFor(() => rejectedStore.run.status === "WAITING_APPROVAL");
    await rejectedEngine.reject(rejectedStore.approvals[0].id, "no");
    await waitFor(() => rejectedStore.run.status === "FAILED");
    expect(rejectedStore.approvals[0].status).toBe("REJECTED");
  });

  it("pauses, resumes, cancels, recovers, and detects deadlock", async () => {
    const store = new MemoryStore(workflow(), [task("A")]);
    const engine = new WorkflowEngine({ store, executor: new SequenceExecutor() });
    store.run.status = "RUNNING";
    await engine.pause("workflow");
    expect(store.run.status).toBe("PAUSED");
    await engine.resume("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    const cancelStore = new MemoryStore(workflow(), [task("A")]);
    const cancelEngine = new WorkflowEngine({
      store: cancelStore,
      executor: new SequenceExecutor()
    });
    await cancelEngine.cancel("workflow");
    expect(cancelStore.run.status).toBe("CANCELLED");
    expect(cancelStore.tasks[0].status).toBe("CANCELLED");

    const recoveryStore = new MemoryStore(workflow({ status: "RUNNING" }), [
      task("A", { status: "RUNNING" })
    ]);
    const recoveryEngine = new WorkflowEngine({
      store: recoveryStore,
      executor: new SequenceExecutor()
    });
    await recoveryEngine.recover();
    await waitFor(() => recoveryStore.run.status === "SUCCESS");
    expect(recoveryStore.events.some((event) => event.payload.recovery === true)).toBe(true);

    // 崩溃恢复硬停：retryCount 已达 maxRetries 时不得再重排队同一 Diagnose。
    const exhaustStore = new MemoryStore(
      workflow({
        status: "RUNNING",
        policy: { ...workflow().policy, maxRetries: 2, failureStrategy: "REPLAN", allowReplan: true }
      }),
      [task("DIAG", { type: "DEBUG", status: "RUNNING", retryCount: 2, title: "Diagnose AC-13" })]
    );
    const exhaustEngine = new WorkflowEngine({
      store: exhaustStore,
      executor: new SequenceExecutor()
    });
    await exhaustEngine.recover();
    expect(exhaustStore.run.status).toBe("FAILED");
    expect(exhaustStore.run.error?.code).toBe("TASK_RECOVERY_BUDGET_EXHAUSTED");
    expect(exhaustStore.tasks[0].status).toBe("FAILED");
    expect(exhaustStore.tasks[0].retryCount).toBe(2);
    expect(
      exhaustStore.events.some(
        (event) =>
          event.eventType === "FAILURE_ROUTED" &&
          event.payload.failureClass === "repair-exhausted"
      )
    ).toBe(true);
    // 不得再造出新的 DEBUG/REPLAN 子任务
    expect(exhaustStore.tasks).toHaveLength(1);

    const deadlockStore = new MemoryStore(
      workflow({ status: "RUNNING" }),
      [task("A")],
      [edge("A", "A")]
    );
    await new WorkflowEngine({ store: deadlockStore, executor: new SequenceExecutor() }).advance(
      "workflow"
    );
    expect(deadlockStore.run.error?.code).toBe("WORKFLOW_DEADLOCK");
  });
});

describe("WorkflowEngine failure router (Phase 5.7-5)", () => {
  /** Mirrors the frozen recovery-router contract used by production wiring. */
  function routerFor(
    strategy: "RETRY" | "REPLAN" | "HUMAN" | "FAIL",
    failureClass = "ELEMENT_MISSING"
  ) {
    return (input: { task: Task; approvals: Approval[] }) => {
      const decided = input.approvals.find(
        (approval) => approval.taskId === input.task.id && approval.status !== "PENDING"
      );
      if (decided?.status === "REJECTED") return { strategy: "FAIL" as const, reason: "rejected" };
      return { strategy, reason: `router:${strategy}`, failureClass, stalled: false };
    };
  }

  it("router RETRY steers the existing retry chain even when policy says FAIL_FAST", async () => {
    const store = new MemoryStore(workflow({ policy: { ...workflow().policy, maxRetries: 1 } }), [
      task("A")
    ]);
    const executor = new SequenceExecutor({ A: [{ status: "failed" }, { status: "succeeded" }] });
    await new WorkflowEngine({ store, executor, failureRouter: routerFor("RETRY") }).start(
      "workflow"
    );
    await waitFor(() => store.run.status === "SUCCESS");
    expect(store.tasks[0].retryCount).toBe(1);
    expect(executor.started).toEqual(["A", "A"]);
    const routed = store.events.find((event) => event.eventType === "FAILURE_ROUTED");
    expect(routed?.payload).toMatchObject({ strategy: "RETRY", failureClass: "ELEMENT_MISSING" });
  });

  it("router HUMAN parks the workflow in the existing WAITING_APPROVAL flow; approval resumes it", async () => {
    const store = new MemoryStore(workflow(), [task("A")]);
    const executor = new SequenceExecutor({ A: [{ status: "failed" }, { status: "succeeded" }] });
    const engine = new WorkflowEngine({
      store,
      executor,
      failureRouter: routerFor("HUMAN", "LOGIN_EXPIRED")
    });
    await engine.start("workflow");
    await waitFor(() => store.run.status === "WAITING_APPROVAL");

    expect(store.tasks[0].status).toBe("WAITING_APPROVAL");
    expect(store.tasks[0].retryCount).toBe(0); // the human boundary consumes no retry budget
    expect(store.approvals).toHaveLength(1);
    expect(store.approvals[0].status).toBe("PENDING");
    const eventTypes = store.events.map((event) => event.eventType);
    expect(eventTypes).toContain("FAILURE_ROUTED");
    expect(eventTypes).toContain("FAILURE_HUMAN_REQUIRED");
    expect(eventTypes).toContain("APPROVAL_REQUIRED");
    const human = store.events.find((event) => event.eventType === "FAILURE_HUMAN_REQUIRED");
    expect(human?.payload).toMatchObject({ failureClass: "LOGIN_EXPIRED" });
    expect(executor.started).toEqual(["A"]); // nothing re-ran before the decision

    await engine.approve(store.approvals[0].id, "go");
    await waitFor(() => store.run.status === "SUCCESS");
    expect(executor.started).toEqual(["A", "A"]);
  });

  it("rejecting the human boundary fails the workflow with zero further executions", async () => {
    const store = new MemoryStore(workflow(), [task("A")]);
    const executor = new SequenceExecutor({ A: [{ status: "failed" }, { status: "succeeded" }] });
    const engine = new WorkflowEngine({ store, executor, failureRouter: routerFor("HUMAN") });
    await engine.start("workflow");
    await waitFor(() => store.run.status === "WAITING_APPROVAL");
    await engine.reject(store.approvals[0].id, "no");
    await waitFor(() => store.run.status === "FAILED");
    expect(executor.started).toEqual(["A"]); // zero further attempts
    expect(store.approvals[0].status).toBe("REJECTED");
  });

  it("router FAIL terminates the workflow and an approved-but-ineffective recovery is terminal", async () => {
    const store = new MemoryStore(workflow(), [task("A")]);
    const executor = new SequenceExecutor({ A: [{ status: "failed" }] });
    await new WorkflowEngine({
      store,
      executor,
      failureRouter: routerFor("FAIL", "CANCELLED")
    }).start("workflow");
    await waitFor(() => store.run.status === "FAILED");
    expect(store.run.error?.code).toBe("WORKFLOW_TASK_FAILED");
    expect(executor.started).toEqual(["A"]);

    // Approved once, then the same failure again → FAIL (no boundary loop).
    const store2 = new MemoryStore(workflow(), [task("A")]);
    const executor2 = new SequenceExecutor({
      A: [{ status: "failed" }, { status: "failed" }]
    });
    const router2 = (input: { task: Task; approvals: Approval[] }) => {
      const approved = input.approvals.some(
        (approval) => approval.taskId === input.task.id && approval.status === "APPROVED"
      );
      return approved
        ? { strategy: "FAIL" as const, reason: "approved recovery failed" }
        : { strategy: "HUMAN" as const, reason: "boundary", failureClass: "LOGIN_EXPIRED" };
    };
    const engine2 = new WorkflowEngine({
      store: store2,
      executor: executor2,
      failureRouter: router2
    });
    await engine2.start("workflow");
    await waitFor(() => store2.run.status === "WAITING_APPROVAL");
    await engine2.approve(store2.approvals[0].id, "go");
    await waitFor(() => store2.run.status === "FAILED");
    expect(executor2.started).toEqual(["A", "A"]);
  });

  it("without a router the built-in policy behavior is untouched", async () => {
    const store = new MemoryStore(workflow(), [task("A")]);
    await new WorkflowEngine({
      store,
      executor: new SequenceExecutor({ A: [{ status: "failed" }] })
    }).start("workflow");
    await waitFor(() => store.run.status === "FAILED");
    expect(store.events.some((event) => event.eventType === "FAILURE_ROUTED")).toBe(false);
    expect(store.approvals).toHaveLength(0);
  });
});

describe("WorkflowEngine retry (失败工作流重试)", () => {
  class GateExecutor extends SequenceExecutor {
    constructor(private readonly gate: Promise<void>) {
      super();
    }

    override async execute(_workflow: WorkflowRun, current: Task): Promise<TaskExecutionResult> {
      this.started.push(current.taskKey);
      await this.gate;
      return { status: "succeeded", output: { ok: true } };
    }
  }

  function failedWorkflow(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
    return workflow({
      status: "FAILED",
      error: { code: "WORKFLOW_TASK_FAILED", message: "Workflow contains unresolved failed tasks" },
      finishedAt: "2026-01-02T00:00:00.000Z",
      ...overrides
    });
  }

  function gate(): { promise: Promise<void>; release: () => void } {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  it("re-arms only unresolved failures and blocked tasks; SUCCESS stays untouched", async () => {
    const held = gate();
    const store = new MemoryStore(failedWorkflow(), [
      task("A", { status: "SUCCESS" }),
      task("B", {
        status: "FAILED",
        failureHandled: true,
        retryCount: 1,
        input: { executionAttempt: 1 }
      }),
      task("C", { status: "FAILED", failureHandled: true, resolvedByTaskId: "A" }),
      task("D", { status: "BLOCKED" })
    ]);
    const executor = new GateExecutor(held.promise);
    const engine = new WorkflowEngine({ store, executor });

    const updated = await engine.retry("workflow");
    expect(updated.status).toBe("RUNNING");
    expect(updated.error).toBeUndefined();
    expect(updated.finishedAt).toBeUndefined();

    // 重排写留痕:只有 B(FAILED → RETRYING)与 D(BLOCKED → PENDING);A / C 零触碰。
    expect(store.taskWrites[0]).toMatchObject({
      id: "B",
      patch: { status: "RETRYING", failureHandled: false, clearClaim: true }
    });
    expect(store.taskWrites[1]).toEqual({ id: "D", patch: { status: "PENDING" } });
    expect(store.taskWrites.some((write) => write.id === "A" || write.id === "C")).toBe(false);
    expect(store.tasks.find((entry) => entry.id === "A")?.status).toBe("SUCCESS");
    expect(store.tasks.find((entry) => entry.id === "C")?.status).toBe("FAILED");

    // 事件:两条 TASK_RETRY_REQUESTED(FAILED / BLOCKED 各一)→ WORKFLOW_RETRIED。
    expect(store.events.slice(0, 3).map((event) => event.eventType)).toEqual([
      "TASK_RETRY_REQUESTED",
      "TASK_RETRY_REQUESTED",
      "WORKFLOW_RETRIED"
    ]);
    expect(store.events[0].payload).toMatchObject({ taskKey: "B", from: "FAILED" });
    expect(store.events[1].payload).toMatchObject({ taskKey: "D", from: "BLOCKED" });
    expect(store.events[2].payload).toMatchObject({
      retriedTaskKeys: ["B"],
      requeuedTaskKeys: ["D"]
    });

    // D1:重排不修改 retryCount / input(executionAttempt)。
    const b = store.tasks.find((entry) => entry.id === "B");
    expect(b?.retryCount).toBe(1);
    expect(b?.input).toEqual({ executionAttempt: 1 });
    expect(b?.failureHandled).toBe(false);

    held.release();
    await waitFor(() => store.run.status === "SUCCESS");
    expect(executor.started).toContain("B");
    expect(executor.started).toContain("D");
    expect(executor.started).not.toContain("A");
    expect(executor.started).not.toContain("C");

    // 事件序列:重排事件在前,之后才是 advance 产生的 TASK_READY / TASK_STARTED。
    const retriedIndex = store.events.findIndex((event) => event.eventType === "WORKFLOW_RETRIED");
    const firstReady = store.events.findIndex((event) => event.eventType === "TASK_READY");
    expect(retriedIndex).toBeGreaterThanOrEqual(0);
    expect(firstReady).toBeGreaterThan(retriedIndex);
    expect(store.events.some((event) => event.eventType === "TASK_STARTED")).toBe(true);
  });

  it("rejects a retry with nothing to re-arm and writes nothing", async () => {
    const store = new MemoryStore(failedWorkflow(), [
      task("A", { status: "SUCCESS" }),
      task("C", { status: "FAILED", failureHandled: true, resolvedByTaskId: "A" })
    ]);
    const engine = new WorkflowEngine({ store, executor: new SequenceExecutor() });

    await expect(engine.retry("workflow")).rejects.toThrow("No retryable tasks");
    expect(store.taskWrites).toEqual([]);
    expect(store.workflowWrites).toEqual([]);
    expect(store.run.status).toBe("FAILED");
  });

  it("only a FAILED workflow can be retried", async () => {
    const store = new MemoryStore(workflow({ status: "RUNNING" }), [
      task("A", { status: "FAILED", failureHandled: true })
    ]);
    const engine = new WorkflowEngine({ store, executor: new SequenceExecutor() });

    await expect(engine.retry("workflow")).rejects.toThrow("Workflow is not failed");
    expect(store.taskWrites).toEqual([]);
    expect(store.workflowWrites).toEqual([]);
  });

  it("refuses the whole retry when a re-armed task's approval was rejected", async () => {
    const store = new MemoryStore(failedWorkflow(), [
      task("B", { status: "FAILED", failureHandled: true }),
      task("D", { status: "BLOCKED" })
    ]);
    store.approvals.push({
      id: "approval-B",
      workflowRunId: "workflow",
      taskId: "B",
      status: "REJECTED",
      reason: "no",
      comment: "no",
      requestedAt: "2026-01-02T00:00:00.000Z",
      decidedAt: "2026-01-02T00:00:00.000Z",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z"
    });
    const engine = new WorkflowEngine({ store, executor: new SequenceExecutor() });

    await expect(engine.retry("workflow")).rejects.toThrow("Retry blocked by rejected approval: B");
    expect(store.taskWrites).toEqual([]);
    expect(store.workflowWrites).toEqual([]);
    expect(store.run.status).toBe("FAILED");
    expect(store.tasks.find((entry) => entry.id === "D")?.status).toBe("BLOCKED");
  });

  it("a second retry on the now-RUNNING workflow is rejected (no double re-arm)", async () => {
    const held = gate();
    const store = new MemoryStore(failedWorkflow(), [
      task("B", { status: "FAILED", failureHandled: true })
    ]);
    const engine = new WorkflowEngine({ store, executor: new GateExecutor(held.promise) });

    await engine.retry("workflow");
    await expect(engine.retry("workflow")).rejects.toThrow("Workflow is not failed");
    expect(store.taskWrites.filter((write) => write.patch.status === "RETRYING")).toHaveLength(1);
    held.release();
    await waitFor(() => store.run.status === "SUCCESS");
  });

  it("a re-armed task that fails again follows the existing policy (FAIL_FAST fails again)", async () => {
    const store = new MemoryStore(failedWorkflow(), [
      task("B", { status: "FAILED", failureHandled: true, retryCount: 1 })
    ]);
    const executor = new SequenceExecutor({ B: [{ status: "failed" }] });
    const engine = new WorkflowEngine({ store, executor });

    await engine.retry("workflow");
    await waitFor(() => store.run.status === "FAILED");
    expect(store.run.error?.code).toBe("WORKFLOW_TASK_FAILED");
    expect(executor.started).toEqual(["B"]);
    expect(store.tasks.find((entry) => entry.id === "B")?.retryCount).toBe(1);
  });

  it("start requires PENDING and resume requires PAUSED (retry edge is not a lifecycle shortcut)", async () => {
    const failedStore = new MemoryStore(failedWorkflow(), [
      task("A", { status: "FAILED", failureHandled: true })
    ]);
    const engine = new WorkflowEngine({ store: failedStore, executor: new SequenceExecutor() });

    await expect(engine.start("workflow")).rejects.toThrow("Workflow is not pending");
    await expect(engine.resume("workflow")).rejects.toThrow("Workflow is not paused");
    expect(failedStore.run.status).toBe("FAILED");
    expect(failedStore.workflowWrites).toEqual([]);

    const pausedStore = new MemoryStore(workflow({ status: "PAUSED" }), [task("A")]);
    await expect(
      new WorkflowEngine({ store: pausedStore, executor: new SequenceExecutor() }).start("workflow")
    ).rejects.toThrow("Workflow is not pending");
  });
});

describe("computeBudgetWallClockMs（T6 wallClock 口径）", () => {
  it("deducts closed and unclosed pause segments", () => {
    const events = [
      { eventType: "WORKFLOW_PAUSED", createdAt: "2026-09-29T10:00:10.000Z" },
      { eventType: "WORKFLOW_RESUMED", createdAt: "2026-09-29T10:00:20.000Z" },
      { eventType: "WORKFLOW_PAUSED", createdAt: "2026-09-29T10:00:30.000Z" }
    ];
    const now = Date.parse("2026-09-29T10:00:40.000Z");

    // 40s 总长 − 10s（已闭合暂停段）− 10s（未闭合段计至 now）= 20s
    expect(computeBudgetWallClockMs("2026-09-29T10:00:00.000Z", events, now)).toBe(20_000);
  });

  it("ignores recovery RESUMED without a preceding pause and handles missing start", () => {
    const events = [{ eventType: "WORKFLOW_RESUMED", createdAt: "2026-09-29T10:00:05.000Z" }];

    expect(
      computeBudgetWallClockMs(
        "2026-09-29T10:00:00.000Z",
        events,
        Date.parse("2026-09-29T10:00:10.000Z")
      )
    ).toBe(10_000);
    expect(computeBudgetWallClockMs(null, [], 123)).toBe(0);
  });
});

describe("WorkflowEngine budget (T6)", () => {
  it("pauses with BUDGET_EXCEEDED before claiming tasks when a limit is exceeded", async () => {
    const store = new MemoryStore(
      workflow({ status: "RUNNING", policy: { ...workflow().policy, maxTokens: 100 } }),
      [task("A")]
    );
    store.usage = { inputTokens: 60, outputTokens: 60, estimatedCostUsd: null };
    const executor = new SequenceExecutor();
    const engine = new WorkflowEngine({ store, executor });

    await engine.advance(store.run.id);

    expect(store.run.status).toBe("PAUSED");
    expect(store.run.error?.code).toBe("BUDGET_EXCEEDED");
    expect(store.tasks.every((entry) => entry.status === "PENDING")).toBe(true);
    expect(executor.started).toHaveLength(0);
    const paused = store.events.find((entry) => entry.eventType === "WORKFLOW_PAUSED");
    expect(paused?.payload.reason).toBe("BUDGET_EXCEEDED");
    expect(paused?.payload.exceeded).toEqual(["maxTokens"]);
  });

  it("emits exactly one 80% warning and never pauses below the limit", async () => {
    const store = new MemoryStore(
      workflow({ status: "RUNNING", policy: { ...workflow().policy, maxTokens: 100 } }),
      [task("A", { status: "RUNNING" })]
    );
    store.usage = { inputTokens: 80, outputTokens: 0, estimatedCostUsd: null };
    const engine = new WorkflowEngine({ store, executor: new SequenceExecutor() });

    await engine.advance(store.run.id);
    await engine.advance(store.run.id);

    expect(
      store.events.filter((entry) => entry.eventType === "WORKFLOW_BUDGET_WARNING")
    ).toHaveLength(1);
    expect(store.events.some((entry) => entry.eventType === "WORKFLOW_PAUSED")).toBe(false);
  });

  it("enforces maxCostUsd only when cost data exists", async () => {
    const noData = new MemoryStore(
      workflow({ status: "RUNNING", policy: { ...workflow().policy, maxCostUsd: 1 } }),
      []
    );
    noData.usage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: null };
    await new WorkflowEngine({ store: noData, executor: new SequenceExecutor() }).advance(
      noData.run.id
    );
    expect(noData.events.some((entry) => entry.eventType === "WORKFLOW_PAUSED")).toBe(false);

    const withData = new MemoryStore(
      workflow({ status: "RUNNING", policy: { ...workflow().policy, maxCostUsd: 1 } }),
      []
    );
    withData.usage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 5 };
    await new WorkflowEngine({ store: withData, executor: new SequenceExecutor() }).advance(
      withData.run.id
    );
    expect(withData.run.status).toBe("PAUSED");
    expect(withData.run.error?.code).toBe("BUDGET_EXCEEDED");
  });

  it("queries no usage and emits no budget events when no limits are set", async () => {
    const store = new MemoryStore(workflow({ status: "RUNNING" }), [
      task("A", { status: "RUNNING" })
    ]);
    const engine = new WorkflowEngine({ store, executor: new SequenceExecutor() });

    await engine.advance(store.run.id);

    expect(store.usageReads).toBe(0);
    expect(
      store.events.some(
        (entry) =>
          entry.eventType === "WORKFLOW_BUDGET_WARNING" ||
          (entry.eventType === "WORKFLOW_PAUSED" && entry.payload.reason === "BUDGET_EXCEEDED")
      )
    ).toBe(false);
  });

  it("resumes after the limit is raised and does not re-run completed tasks", async () => {
    const store = new MemoryStore(
      workflow({ status: "RUNNING", policy: { ...workflow().policy, maxTokens: 10 } }),
      [task("A")]
    );
    store.usage = { inputTokens: 100, outputTokens: 0, estimatedCostUsd: null };
    const executor = new SequenceExecutor();
    const engine = new WorkflowEngine({ store, executor });

    await engine.advance(store.run.id);
    expect(store.run.status).toBe("PAUSED");

    store.run = { ...store.run, policy: { ...store.run.policy, maxTokens: 10_000 } };
    await engine.resume(store.run.id);
    await waitFor(() => store.run.status === "SUCCESS");

    expect(executor.started).toEqual(["A"]);
  });

  it("7-A：start 把触发请求的 requestId 写进 WORKFLOW_STARTED，缺省时不写该字段", async () => {
    const store = new MemoryStore(workflow(), [task("A")]);
    const engine = new WorkflowEngine({
      store,
      executor: new SequenceExecutor({ A: [{ status: "succeeded" }] })
    });
    await engine.start("workflow", { requestId: "req-1" });
    await waitFor(() => store.run.status === "SUCCESS");

    expect(store.events.find((event) => event.eventType === "WORKFLOW_STARTED")?.payload).toEqual({
      status: "RUNNING",
      requestId: "req-1"
    });

    const plain = new MemoryStore(workflow(), [task("A")]);
    await new WorkflowEngine({
      store: plain,
      executor: new SequenceExecutor({ A: [{ status: "succeeded" }] })
    }).start("workflow");
    await waitFor(() => plain.run.status === "SUCCESS");

    expect(plain.events.find((event) => event.eventType === "WORKFLOW_STARTED")?.payload).toEqual({
      status: "RUNNING"
    });
  });
});

/**
 * 自治 L1（`docs/17`「自治 L1」节，实施 `docs/154`）。
 * 判据集中在两件事：**L1 声明的行为确实发生**，以及**没声明 L1 时逐项与现状一致**（L1-7）。
 */
describe("WorkflowEngine autonomy L1", () => {
  /** L1 预设的展开形式（`L1_WORKFLOW_POLICY` 并进默认策略）。 */
  const L1_POLICY: WorkflowRun["policy"] = {
    maxConcurrency: 2,
    maxRetries: 2,
    failureStrategy: "RETRY",
    allowRetry: true,
    allowReplan: false,
    approvalRequired: false,
    autonomyLevel: "L1",
    deployFailureStrategy: "ROLLBACK"
  };

  // 契约要求 workflowRunId / taskId 是 UUID（生产里就是主键）；夹具照此给，才能顺带断言
  // 写出的 payload 能通过契约解析。taskKey 保持可读，便于断言执行顺序。
  const l1Run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun =>
    workflow({ id: randomUUID(), policy: L1_POLICY, ...overrides });
  const l1Task = (taskKey: string, overrides: Partial<Task> = {}): Task =>
    task(randomUUID(), { taskKey, ...overrides });

  const autonomyEvents = (store: MemoryStore) =>
    store.events.filter((event) =>
      (AUTONOMY_DECISION_EVENT_TYPES as readonly string[]).includes(event.eventType)
    );

  /** 契约一致性：写出的每条决策事件都必须能通过 `docs/152` 的解析入口。 */
  const expectContractValid = (store: MemoryStore) => {
    for (const event of autonomyEvents(store)) {
      expect(() =>
        parseAutonomyDecisionPayload(
          event.eventType as Parameters<typeof parseAutonomyDecisionPayload>[0],
          event.payload
        )
      ).not.toThrow();
    }
  };

  it("L1-5/L1-6: retries to the declared bound, then fails — never a third attempt", async () => {
    const store = new MemoryStore(l1Run(), [l1Task("A")]);
    const executor = new SequenceExecutor({
      A: [{ status: "failed" }, { status: "failed" }, { status: "failed" }]
    });
    await new WorkflowEngine({ store, executor }).start(store.run.id);
    await waitFor(() => store.run.status === "FAILED");

    expect(executor.started).toEqual(["A", "A", "A"]); // 首次 + 2 次重试；无第 4 次
    expect(store.tasks[0].retryCount).toBe(2);
    expect(store.run.error?.code).toBe("WORKFLOW_TASK_FAILED");
    expect(store.run.error?.message).toBeTruthy(); // 原因可读，不静默

    const retried = autonomyEvents(store).filter((event) => event.eventType === "AUTO_RETRIED");
    expect(retried.map((event) => event.payload.attempt)).toEqual([1, 2]);
    expect(retried.every((event) => event.payload.maxAttempts === 2)).toBe(true);
    expect(retried.every((event) => event.payload.policyId === "L1")).toBe(true);
    // 机械事实与策略决策各记一条（`docs/154` §6 第 2 项）。
    expect(store.events.filter((event) => event.eventType === "TASK_RETRYING")).toHaveLength(2);
    expectContractValid(store);
  });

  it("L1-7: without an autonomy level nothing changes and no decision event is written", async () => {
    const store = new MemoryStore(workflow({ id: randomUUID() }), [l1Task("A")]);
    const executor = new SequenceExecutor({
      A: [{ status: "failed" }, { status: "succeeded" }]
    });
    await new WorkflowEngine({ store, executor }).start(store.run.id);
    await waitFor(() => store.run.status === "FAILED");

    expect(executor.started).toEqual(["A"]); // 默认 FAIL_FAST：不重试（现状）
    expect(autonomyEvents(store)).toHaveLength(0);
  });

  it("L1-5: a failed staging DEPLOY rolls back automatically and is recorded", async () => {
    const deploymentId = randomUUID();
    const store = new MemoryStore(l1Run(), [
      l1Task("STAGING", {
        type: "DEPLOY",
        input: { delivery: { action: "DEPLOY", environment: "staging" } }
      })
    ]);
    const executor = new SequenceExecutor({
      STAGING: [{ status: "failed", output: { deploymentId } }]
    });
    await new WorkflowEngine({ store, executor }).start(store.run.id);
    await waitFor(() => store.events.some((event) => event.eventType === "AUTO_ROLLED_BACK"));

    const rolledBack = store.events.find((event) => event.eventType === "AUTO_ROLLED_BACK");
    expect(rolledBack?.payload).toMatchObject({
      policyId: "L1",
      environment: "staging",
      deploymentId
    });
    // 回滚任务由引擎既有实现创建，且确实被执行。
    expect(store.tasks.map((entry) => entry.taskKey)).toContain("STAGING-ROLLBACK");
    await waitFor(() => store.run.status === "SUCCESS");
    expect(executor.started).toEqual(["STAGING", "STAGING-ROLLBACK"]);
    expectContractValid(store);
  });

  it("L1-6: a staging DEPLOY with no approval gate is recorded as AUTO_APPROVED", async () => {
    const store = new MemoryStore(l1Run(), [
      l1Task("STAGING", {
        type: "DEPLOY",
        input: { delivery: { action: "DEPLOY", environment: "staging" } }
      })
    ]);
    await new WorkflowEngine({ store, executor: new SequenceExecutor() }).start(store.run.id);
    await waitFor(() => store.run.status === "SUCCESS");

    const approved = store.events.filter((event) => event.eventType === "AUTO_APPROVED");
    expect(approved).toHaveLength(1);
    expect(approved[0].payload).toMatchObject({ policyId: "L1", environment: "staging" });
    expect(store.approvals).toHaveLength(0); // staging 不产生审批记录（L1-1）
    expectContractValid(store);
  });

  it("L1-6: an enforced verification failure is recorded with its failed checks", async () => {
    const store = new MemoryStore(l1Run(), [l1Task("A")]);
    const executor = new SequenceExecutor({
      A: [
        {
          status: "failed",
          output: {
            verification: {
              mode: "enforce",
              verdict: "failed",
              checks: [
                { name: "unit-test", passed: false },
                { name: "build", passed: true }
              ],
              commitSha: "abcdef1234567890"
            },
            errorType: "VERIFICATION_FAILED"
          }
        }
      ]
    });
    await new WorkflowEngine({ store, executor }).start(store.run.id);
    await waitFor(() =>
      store.events.some((event) => event.eventType === "VERIFICATION_ENFORCED_FAILURE")
    );

    const enforced = store.events.find(
      (event) => event.eventType === "VERIFICATION_ENFORCED_FAILURE"
    );
    expect(enforced?.payload).toMatchObject({
      policyId: "L1",
      gateMode: "enforce",
      failedChecks: ["unit-test"],
      commitSha: "abcdef1234567890"
    });
    expectContractValid(store);
  });

  it("L1-6: anti-tamper failures name the gate component instead of inventing a check", async () => {
    const store = new MemoryStore(l1Run(), [l1Task("A")]);
    const executor = new SequenceExecutor({
      A: [
        {
          status: "failed",
          output: {
            verification: {
              mode: "enforce",
              verdict: "failed",
              checks: [],
              antiTamper: { verdict: "failed", changed: ["test/app.test.ts"] }
            },
            errorType: "VERIFICATION_FAILED"
          }
        }
      ]
    });
    await new WorkflowEngine({ store, executor }).start(store.run.id);
    await waitFor(() =>
      store.events.some((event) => event.eventType === "VERIFICATION_ENFORCED_FAILURE")
    );
    const enforced = store.events.find(
      (event) => event.eventType === "VERIFICATION_ENFORCED_FAILURE"
    );
    expect(enforced?.payload.failedChecks).toEqual(["anti-tamper"]);
    expectContractValid(store);
  });
});

/**
 * PL-M18（N-11）：REVIEW 的负结论必须落到**工作类型**上。
 *
 * 起因（L1-M4i run 2 的 `T-S4-R2`）：REVIEW 诚实判「不通过」被记成任务失败；改动前
 * `replan()` 的 retry 任务继承源任务类型 ⇒ REPLAN 造出的是**另一个 REVIEW**，同一负结论
 * 必然重现，逐层嵌套（`-REPLAN-1-REPLAN-2`）撞深度守卫 ⇒ 工作流 FAILED。
 */
describe("PL-M18（N-11）：修复任务落在工作类型上", () => {
  const replanPolicy = { failureStrategy: "REPLAN" as const, allowReplan: true };

  it("REVIEW 失败 → DEBUG 的目标类型与 retry 的类型都是同切片的工作类型，而不是 REVIEW", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [
        task("S4-BE-1", { type: "BACKEND", status: "SUCCESS", sliceKey: "slice-4" }),
        task("S4-R", { type: "REVIEW", sliceKey: "slice-4" })
      ]
    );
    const executor = new SequenceExecutor({ "S4-R": [{ status: "failed" }] });
    // 显式 backend-node：本用例验证「同切片 BACKEND 工作类型」语义；缺省 frontend-vue 的 work 不含 BACKEND。
    await new WorkflowEngine({ store, executor, profile: BACKEND_NODE_PROFILE }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    const debug = store.tasks.find((entry) => entry.taskKey === "S4-R-DEBUG-1");
    expect(debug?.type).toBe("DEBUG");
    expect(debug?.input.targetTaskType).toBe("BACKEND");
    const retry = store.tasks.find((entry) => entry.taskKey === "S4-R-REPLAN-1");
    expect(retry?.type).toBe("BACKEND");
  });

  it("其它切片的工作类型不参与判定；同切片没有工作类型时回退 profile.fixFallback（默认 FRONTEND）", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [
        task("S1-FE-1", { type: "FRONTEND", status: "SUCCESS", sliceKey: "slice-1" }),
        task("S4-R", { type: "REVIEW", sliceKey: "slice-4" })
      ]
    );
    const executor = new SequenceExecutor({ "S4-R": [{ status: "failed" }] });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    const retry = store.tasks.find((entry) => entry.taskKey === "S4-R-REPLAN-1");
    expect(retry?.type).toBe("FRONTEND");
  });

  it("源任务自己就是工作类型 → 原样重试同一类工作", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [task("S4-BE-9", { type: "DATABASE", sliceKey: "slice-4" })]
    );
    const executor = new SequenceExecutor({ "S4-BE-9": [{ status: "failed" }] });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    const retry = store.tasks.find((entry) => entry.taskKey === "S4-BE-9-REPLAN-1");
    expect(retry?.type).toBe("DATABASE");
  });
});

/**
 * N-23（`docs/200`）：交付任务的 `type` 是**平台契约**，replan 不得把它换成工作类型。
 *
 * 起因（L1-M4n run 3）：`T7`（`BUILD` + `delivery.action = "CI"`）失败后 replan 产出
 * `T7-REPLAN-1`（**`BACKEND`**）。`DeliveryOrchestrator.canHandle` 按 `task.type` 分派
 * （`deploymentOrchestrator.ts:76-84`：`BUILD`+`CI` / `DEPLOY`+`DEPLOY` / `TEST`+`VERIFY`），
 * type 一变即**恒 false** ⇒ `input.delivery` 契约悄悄作废：任务照跑、还自报 SUCCESS，
 * 而它该做的那件事从未发生；下游 `T8`（DEPLOY）随即死在 `CI_RELEASE_NOT_FOUND`。
 *
 * **PL-M18 对 `REVIEW` 的判定不受影响**（`REVIEW` 不承载平台行为，见上一组用例）。
 */
describe("N-23：交付任务的类型在 replan 后保持不变", () => {
  const replanPolicy = { failureStrategy: "REPLAN" as const, allowReplan: true };

  // BUILD / TEST 仍有职业 agent（DEVOPS / QA），可派 DEBUG；DEPLOY 没有——见下一组。
  const agentBackedDeliveryCases: ReadonlyArray<Task["type"]> = ["BUILD", "TEST"];

  for (const deliveryType of agentBackedDeliveryCases) {
    it(`${deliveryType} 失败 → retry 仍是 ${deliveryType}，而不是切片里的工作类型`, async () => {
      const store = new MemoryStore(
        workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
        [
          // 切片里有一个工作类型：第 3 步的兜底会挑它，正是缺陷的入口。
          task("S4-BE-1", { type: "BACKEND", status: "SUCCESS", sliceKey: "slice-4" }),
          task("S4-D", { type: deliveryType, sliceKey: "slice-4" })
        ]
      );
      const executor = new SequenceExecutor({ "S4-D": [{ status: "failed" }] });
      await new WorkflowEngine({ store, executor }).start("workflow");
      await waitFor(() => store.run.status === "SUCCESS");

      const retry = store.tasks.find((entry) => entry.taskKey === "S4-D-REPLAN-1");
      expect(retry?.type).toBe(deliveryType);
      // DEBUG 的目标类型也跟随源任务，而不是被换成工作类型。
      const debug = store.tasks.find((entry) => entry.taskKey === "S4-D-DEBUG-1");
      expect(debug?.input.targetTaskType).toBe(deliveryType);
    });
  }

  it("DEPLOY 失败 → retry 仍是 DEPLOY，且不派无用的 DEBUG（无职业 agent）", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [
        task("S4-BE-1", { type: "BACKEND", status: "SUCCESS", sliceKey: "slice-4" }),
        task("S4-D", { type: "DEPLOY", sliceKey: "slice-4" })
      ]
    );
    const executor = new SequenceExecutor({ "S4-D": [{ status: "failed" }] });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    const retry = store.tasks.find((entry) => entry.taskKey === "S4-D-REPLAN-1");
    expect(retry?.type).toBe("DEPLOY");
    expect(store.tasks.some((entry) => entry.taskKey === "S4-D-DEBUG-1")).toBe(false);
    expect(store.events.some((event) => event.eventType === "REPLAN_DEBUG_SKIPPED")).toBe(true);
  });

  it("agent 明确给出的 fixTaskType 仍然优先（N-22 的通道不被本条无视）", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [
        task("S4-BE-1", { type: "BACKEND", status: "SUCCESS", sliceKey: "slice-4" }),
        task("S4-CI", { type: "BUILD", sliceKey: "slice-4" })
      ]
    );
    // 「这条链要改的是测试文件」——agent 的显式请求。
    const executor = new SequenceExecutor({
      "S4-CI": [{ status: "failed", output: { fixTaskType: "TEST" } }]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    const retry = store.tasks.find((entry) => entry.taskKey === "S4-CI-REPLAN-1");
    expect(retry?.type).toBe("TEST");
  });
});

/**
 * DEBUG×DEPLOY（F1 round17）：带 `input.delivery` 的交付编排任务失败后，不得派 DEBUG。
 * DeliveryOrchestrator 走编排器，DEBUG 会落到 AgentRegistry 并因目标无 agent 瞬失败。
 */
describe("DEBUG×DEPLOY：交付编排失败跳过 DEBUG，只造同契约 retry", () => {
  const replanPolicy = { failureStrategy: "REPLAN" as const, allowReplan: true };

  it("staging DEPLOY（带 delivery）失败 → 无 DEBUG，有 REPLAN retry，二次可成功", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [
        task("T-09", {
          type: "DEPLOY",
          sliceKey: "slice-5",
          input: { delivery: { action: "DEPLOY", environment: "staging" } }
        })
      ]
    );
    const executor = new SequenceExecutor({
      "T-09": [{ status: "failed", error: { code: "DEPLOYMENT_FAILED", message: "preview timeout" } }],
      "T-09-REPLAN-1": [{ status: "succeeded" }]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    expect(store.tasks.some((entry) => entry.type === "DEBUG")).toBe(false);
    const retry = store.tasks.find((entry) => entry.taskKey === "T-09-REPLAN-1");
    expect(retry?.type).toBe("DEPLOY");
    expect(retry?.input.delivery).toEqual({ action: "DEPLOY", environment: "staging" });
    expect(store.events.some((event) => event.eventType === "REPLAN_DEBUG_SKIPPED")).toBe(true);
    expect(executor.started).toEqual(["T-09", "T-09-REPLAN-1"]);
  });

  it("CI（BUILD + delivery）失败 → 同样跳过 DEBUG（交付链不进职业 agent）", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [
        task("T-08", {
          type: "BUILD",
          sliceKey: "slice-5",
          input: { delivery: { action: "CI" } }
        })
      ]
    );
    const executor = new SequenceExecutor({
      "T-08": [{ status: "failed", error: { code: "CI_FAILED", message: "tests failed" } }]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    expect(store.tasks.some((entry) => entry.type === "DEBUG")).toBe(false);
    const retry = store.tasks.find((entry) => entry.taskKey === "T-08-REPLAN-1");
    expect(retry?.type).toBe("BUILD");
    expect(retry?.input.delivery).toEqual({ action: "CI" });
  });

  it("PL-M28/门禁P1：交付 CI + fixTaskType=TEST → DEBUG(改测) 后同契约 CI retry（非盲目重跑）", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [
        task("T-10", {
          type: "BUILD",
          sliceKey: "slice-5",
          input: { delivery: { action: "CI" } }
        })
      ]
    );
    const executor = new SequenceExecutor({
      "T-10": [
        {
          status: "failed",
          error: {
            code: "CONTRADICTORY_TEST_EXPECTATIONS",
            message: "CONTRADICTORY_TEST_EXPECTATIONS: fail-fast before pnpm test"
          },
          output: {
            errorType: "CONTRADICTORY_TEST_EXPECTATIONS",
            fixTaskType: "TEST"
          }
        }
      ],
      "T-10-DEBUG-1": [{ status: "succeeded" }],
      "T-10-REPLAN-1": [{ status: "succeeded" }]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    const debug = store.tasks.find((entry) => entry.taskKey === "T-10-DEBUG-1");
    expect(debug?.type).toBe("DEBUG");
    expect(debug?.input.targetTaskType).toBe("TEST");
    expect(debug?.input.delivery).toBeUndefined();

    const retry = store.tasks.find((entry) => entry.taskKey === "T-10-REPLAN-1");
    expect(retry?.type).toBe("BUILD");
    expect(retry?.input.delivery).toEqual({ action: "CI" });
    expect(store.events.some((event) => event.eventType === "REPLAN_DEBUG_SKIPPED")).toBe(false);
    expect(executor.started).toEqual(["T-10", "T-10-DEBUG-1", "T-10-REPLAN-1"]);
  });

  it("PL-M28 30b：交付 CI 无/非法 fixTaskType → 仍跳过 DEBUG，只同契约 retry", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [
        task("T-11", {
          type: "BUILD",
          sliceKey: "slice-5",
          input: { delivery: { action: "CI" } }
        })
      ]
    );
    const executor = new SequenceExecutor({
      "T-11": [
        {
          status: "failed",
          error: { code: "CI_FAILED", message: "tests failed" },
          output: { fixTaskType: "IMPLEMENTATION" }
        }
      ],
      "T-11-REPLAN-1": [{ status: "succeeded" }]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    expect(store.tasks.some((entry) => entry.type === "DEBUG")).toBe(false);
    const retry = store.tasks.find((entry) => entry.taskKey === "T-11-REPLAN-1");
    expect(retry?.type).toBe("BUILD");
    expect(retry?.input.delivery).toEqual({ action: "CI" });
  });
});

/**
 * N-22（`docs/199` 判据 25e）：失败任务的 `output` 必须带上**平台已知的错误码**。
 *
 * 事件里有 `errorCode`（`result.error?.code`），而任务 `output` 此前不带 ⇒ 批次的
 * `errorTypes`（`harness.ts:73-75`，只收非空 `output.errorType`）漏计。实测 L1-M4n run 2：
 * `T7` 的事件是 **`CI_FAILED`**、任务 `output.errorType` **为空**——**同一个失败码两个来源且不一致**。
 */

/**
 * taskflow-vue v8：诊断/REPLAN_REQUESTED 给出的 fixTaskType 必须决定 REPLAN 任务类型，
 * 不得继续克隆 TEST；frontend-vue 下越权 BACKEND 回退；耗尽时类型切换仍可开 FRONTEND。
 */
describe("fixTaskType-honoring REPLAN (taskflow-vue v8)", () => {
  const replanPolicy = {
    failureStrategy: "REPLAN" as const,
    allowReplan: true,
    maxRetries: 2
  };

  it("DEBUG success/observe + output.fixTaskType=FRONTEND ⇒ sibling REPLAN retargeted to FRONTEND", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [task("T-02", { type: "TEST", sliceKey: "slice-task-crud" })]
    );
    const executor = new SequenceExecutor({
      "T-02": [
        {
          status: "failed",
          output: {
            summary: "tests red; components missing",
            errorType: "GATE_FAILURE"
          }
        }
      ],
      "T-02-DEBUG-1": [
        {
          status: "succeeded",
          output: {
            outcome: "REPLAN",
            fixTaskType: "FRONTEND",
            summary: "need TaskForm.vue; TEST cannot go green",
            verification: { mode: "observe", verdict: "failed" }
          }
        }
      ],
      "T-02-REPLAN-1": [{ status: "succeeded" }]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    const retry = store.tasks.find((entry) => entry.taskKey === "T-02-REPLAN-1");
    expect(retry?.type).toBe("FRONTEND");
    expect(
      store.events.some((event) => event.eventType === "REPLAN_TYPE_RETARGETED")
    ).toBe(true);
    expect(store.events.find((event) => event.eventType === "REPLAN_TYPE_RETARGETED")?.payload).toMatchObject({
      fromType: "TEST",
      toType: "FRONTEND"
    });
  });

  it("TEST + REPLAN_REQUESTED + fixTaskType=FRONTEND ⇒ next task FRONTEND, not another TEST", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [
        task("T-02-REPLAN-1", {
          type: "TEST",
          status: "FAILED",
          sliceKey: "slice-task-crud",
          input: { executionAttempt: 1 },
          output: {
            outcome: "REPLAN",
            errorType: "REPLAN_REQUESTED",
            fixTaskType: "FRONTEND",
            summary: "product components missing; FRONTEND required"
          }
        })
      ]
    );
    const executor = new SequenceExecutor({
      "T-02-REPLAN-2": [{ status: "succeeded" }]
    });
    // failureRouter not wired here — engine built-in REPLAN policy path
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    const repair = store.tasks.find((entry) => entry.taskKey === "T-02-REPLAN-2");
    expect(repair?.type).toBe("FRONTEND");
    expect(repair?.title).toContain("FRONTEND");
    expect(store.tasks.filter((entry) => entry.type === "TEST" && entry.origin === "DYNAMIC")).toHaveLength(
      0
    );
  });

  it("TEST at maxRetries with REPLAN_REQUESTED+FRONTEND still gets a FRONTEND repair (type-switch)", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [
        task("T-QA", {
          type: "TEST",
          status: "FAILED",
          sliceKey: "slice-task-crud",
          input: { executionAttempt: 2 },
          output: {
            errorType: "REPLAN_REQUESTED",
            fixTaskType: "FRONTEND",
            summary: "cannot go green without product code"
          }
        })
      ]
    );
    const executor = new SequenceExecutor({
      "T-QA-REPLAN-3": [{ status: "succeeded" }]
    });
    await new WorkflowEngine({
      store,
      executor,
      failureRouter: ({ task }) => ({
        strategy: "REPLAN" as const,
        reason: "type-switch after diagnosis",
        failureClass: "GATE_FAILURE",
        attempt: 2
      })
    }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    const repair = store.tasks.find((entry) => entry.taskKey === "T-QA-REPLAN-3");
    expect(repair?.type).toBe("FRONTEND");
    expect(repair?.input.executionAttempt).toBe(1);
    expect(repair?.input.typeSwitchUsed).toBe(true);
    expect(store.run.status).toBe("SUCCESS");
  });

  it("docs/258: official e2e failures are prepended to the repair brief and merged into acKeys", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [
        task("T-15-REPLAN-1", {
          type: "TEST",
          status: "FAILED",
          sliceKey: "slice-dashboard-list",
          input: {
            executionAttempt: 1,
            acKeys: ["AC-07", "AC-08", "AC-09", "AC-15", "AC-18", "AC-19"]
          },
          output: {
            outcome: "SUCCESS",
            errorType: "VERIFICATION_FAILED",
            failureClass: "GATE_FAILURE",
            fixTaskType: "TEST",
            summary: "task-crud 不在本任务 AC 范围内，故未修改",
            verification: {
              mode: "enforce",
              verdict: "failed",
              reason: "checks failed: e2e",
              checks: [
                { name: "test", passed: true, exitCode: 0 },
                {
                  name: "e2e",
                  passed: false,
                  exitCode: 1,
                  stdoutTail: `  4 failed
    [chromium] › tests/e2e/task-crud.spec.ts:147:1 › [AC-02] 编辑任务并保存后列表展示更新后的字段值
    [chromium] › tests/e2e/task-crud.spec.ts:184:1 › [AC-03] 点击删除先弹出确认对话框，取消后任务仍然保留
    [chromium] › tests/e2e/task-crud.spec.ts:209:1 › [AC-03] 在确认对话框点击确认删除后目标任务从列表消失
    [chromium] › tests/e2e/task-crud.spec.ts:231:1 › [AC-14] 打开任务详情查看八个字段并在详情中修改状态后列表状态同步
  27 passed (1.5m)
`
                }
              ]
            }
          }
        })
      ]
    );
    const executor = new SequenceExecutor({
      "T-15-REPLAN-2": [{ status: "succeeded" }]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    const repair = store.tasks.find((entry) => entry.taskKey === "T-15-REPLAN-2");
    const acKeys = Array.isArray(repair?.input.acKeys) ? repair.input.acKeys : [];
    expect(acKeys.slice(0, 3)).toEqual(["AC-02", "AC-03", "AC-14"]);
    expect(acKeys).toEqual([
      "AC-02",
      "AC-03",
      "AC-14",
      "AC-07",
      "AC-08",
      "AC-09",
      "AC-15",
      "AC-18",
      "AC-19"
    ]);
    expect(repair?.description).toContain("官方门禁失败");
    expect(repair?.description).toContain("task-crud.spec.ts");
    expect(repair?.description).toContain("[AC-02]");
    expect(repair?.description).toContain("不要因为源任务的 AC 列表未包含它们就当成范围外");
    expect(repair?.description).toContain("task-crud 不在本任务 AC 范围内，故未修改");
  });

  it("BACKEND fixTaskType under frontend-vue is rejected; falls back safely", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [
        task("T-02", {
          type: "TEST",
          status: "FAILED",
          sliceKey: "slice-task-crud",
          input: { executionAttempt: 0 },
          output: {
            errorType: "REPLAN_REQUESTED",
            fixTaskType: "BACKEND",
            summary: "agent wrongly asked for BACKEND"
          }
        })
      ]
    );
    const executor = new SequenceExecutor({
      "T-02-DEBUG-1": [{ status: "succeeded" }],
      "T-02-REPLAN-1": [{ status: "succeeded" }]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    expect(store.tasks.every((entry) => entry.type !== "BACKEND")).toBe(true);
    const fallback = store.events.find((event) => event.eventType === "DEBUG_TARGET_TYPE_FALLBACK");
    expect(fallback).toBeTruthy();
  });

  it("unspecified fixTaskType keeps clone/diagnose behavior for TEST", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [task("T-02", { type: "TEST", sliceKey: "slice-task-crud" })]
    );
    const executor = new SequenceExecutor({
      "T-02": [{ status: "failed", output: { summary: "red tests", errorType: "GATE_FAILURE" } }],
      "T-02-DEBUG-1": [{ status: "succeeded" }],
      "T-02-REPLAN-1": [{ status: "succeeded" }]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    expect(store.tasks.some((entry) => entry.taskKey === "T-02-DEBUG-1")).toBe(true);
    const retry = store.tasks.find((entry) => entry.taskKey === "T-02-REPLAN-1");
    expect(retry?.type).toBe("TEST");
  });
});

describe("N-22（判据 25e）：失败任务的错误码落到 output.errorType", () => {
  const replanPolicy = { failureStrategy: "REPLAN" as const, allowReplan: true };

  it("交付编排路径（结果不带 output）→ output.errorType 取 result.error.code", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [task("S4-CI", { type: "BUILD", sliceKey: "slice-4" })]
    );
    const executor = new SequenceExecutor({
      "S4-CI": [
        {
          status: "failed",
          error: { code: "CI_FAILED", message: "No successful CI release found" }
        }
      ]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    const failed = store.tasks.find((entry) => entry.taskKey === "S4-CI");
    expect(failed?.status).toBe("FAILED");
    expect(failed?.output?.errorType).toBe("CI_FAILED");
  });

  it("结果已带 errorType 时不覆盖（agent 侧的码更具体）", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [task("S4-BE-1", { type: "BACKEND", sliceKey: "slice-4" })]
    );
    const executor = new SequenceExecutor({
      "S4-BE-1": [
        {
          status: "failed",
          output: { errorType: "VERIFICATION_FAILED" },
          error: { code: "TASK_EXECUTION_FAILED", message: "verification gate" }
        }
      ]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    const failed = store.tasks.find((entry) => entry.taskKey === "S4-BE-1");
    expect(failed?.output?.errorType).toBe("VERIFICATION_FAILED");
  });
});

/**
 * PL-M19（N-12）：`replan()` 只把源任务的 `resolvedByTaskId` 指向**下一层**，而 retry 任务
 * 自己也可能失败、再被重规划一层。只认直接指针会把「第二层才救回来」误判为未解决，让
 * 工作全部做完的工作流报 `WORKFLOW_TASK_FAILED`（L1-M4j run 2 / `bb5f0610`）。
 *
 * 判定改为沿链走到头（`./resolution`）；`BLOCKED` / `CANCELLED` 与「链尽头仍 FAILED」
 * 一律保持未解决——后者是本组的**反向对照**。
 */
describe("PL-M19（N-12）：第二层才救回来的失败也算已解决", () => {
  const deepReplanPolicy = {
    failureStrategy: "REPLAN" as const,
    allowReplan: true,
    maxRetries: 2
  };
  const failed = { status: "failed" } as const;
  const failedWorkflowRun = () =>
    workflow({
      status: "FAILED",
      error: { code: "WORKFLOW_TASK_FAILED", message: "Workflow contains unresolved failed tasks" },
      finishedAt: "2026-01-02T00:00:00.000Z"
    });

  it("源失败 → 重规划失败 → 再重规划成功 ⇒ 工作流 SUCCESS", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...deepReplanPolicy } }),
      [task("S4-BE-1", { type: "BACKEND", sliceKey: "slice-4" })]
    );
    const executor = new SequenceExecutor({
      "S4-BE-1": [failed],
      "S4-BE-1-REPLAN-1": [failed]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS");

    expect(store.run.status).toBe("SUCCESS");
    expect(store.run.error).toBeUndefined();
    expect(store.tasks.find((entry) => entry.taskKey === "S4-BE-1-REPLAN-2")?.status).toBe(
      "SUCCESS"
    );
    // 修的是**判定**，不是数据：指针仍是「下一层」，没有被改写。
    const source = store.tasks.find((entry) => entry.taskKey === "S4-BE-1");
    const firstRetry = store.tasks.find((entry) => entry.taskKey === "S4-BE-1-REPLAN-1");
    expect(source?.status).toBe("FAILED");
    expect(source?.resolvedByTaskId).toBe(firstRetry?.id);
  });

  it("反向对照：链走到头仍是 FAILED ⇒ 工作流 FAILED", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...deepReplanPolicy } }),
      [task("S4-BE-1", { type: "BACKEND", sliceKey: "slice-4" })]
    );
    const executor = new SequenceExecutor({
      "S4-BE-1": [failed],
      "S4-BE-1-REPLAN-1": [failed],
      "S4-BE-1-REPLAN-2": [failed]
    });
    await new WorkflowEngine({ store, executor }).start("workflow");
    await waitFor(() => store.run.status === "FAILED");

    expect(store.run.status).toBe("FAILED");
    expect(store.run.error?.code).toBe("WORKFLOW_TASK_FAILED");
  });

  it("retry()：已由第二层救回的失败不重排（与 advanceOnce 同源）", async () => {
    const store = new MemoryStore(failedWorkflowRun(), [
      task("A", { status: "FAILED", failureHandled: true, resolvedByTaskId: "B" }),
      task("B", { status: "FAILED", failureHandled: true, resolvedByTaskId: "C" }),
      task("C", { status: "SUCCESS" })
    ]);
    const engine = new WorkflowEngine({ store, executor: new SequenceExecutor() });

    await expect(engine.retry("workflow")).rejects.toThrow("No retryable tasks");
    expect(store.taskWrites).toEqual([]);
    expect(store.run.status).toBe("FAILED");
  });

  it("retry()：链走到头是 FAILED 时只重排最上游那层（不叠跑中间/叶子）", async () => {
    const store = new MemoryStore(failedWorkflowRun(), [
      task("A", { status: "FAILED", failureHandled: true, resolvedByTaskId: "B" }),
      task("B", { status: "FAILED", failureHandled: true, resolvedByTaskId: "C" }),
      task("C", { status: "FAILED", failureHandled: true })
    ]);
    const engine = new WorkflowEngine({ store, executor: new SequenceExecutor() });

    const updated = await engine.retry("workflow");
    expect(updated.status).toBe("RUNNING");
    expect(
      store.taskWrites.filter((write) => write.patch.status === "RETRYING").map((write) => write.id)
    ).toEqual(["A"]);
    expect(store.tasks.find((entry) => entry.id === "B")?.status).toBe("FAILED");
    expect(store.tasks.find((entry) => entry.id === "C")?.status).toBe("FAILED");
  });

  it("retry()：REPLAN-1 SUCCESS 接替后不再重排 REPLAN-2 FAILED（thrash fix）", async () => {
    const store = new MemoryStore(failedWorkflowRun(), [
      task("T-05", { status: "FAILED", failureHandled: true, resolvedByTaskId: "REPLAN-1" }),
      task("REPLAN-1", {
        status: "SUCCESS",
        failureHandled: true,
        resolvedByTaskId: "REPLAN-2"
      }),
      task("REPLAN-2", { status: "FAILED", failureHandled: true })
    ]);
    const engine = new WorkflowEngine({ store, executor: new SequenceExecutor() });

    await expect(engine.retry("workflow")).rejects.toThrow("No retryable tasks");
    expect(store.taskWrites).toEqual([]);
    expect(store.tasks.find((entry) => entry.id === "REPLAN-2")?.status).toBe("FAILED");
    expect(store.run.status).toBe("FAILED");
  });
});

/**
 * taskflow-vue v9：人工重试源任务后，旧的 -REPLAN-N 行仍在同一 workflow_run 上。
 * replan 必须分配未占用的 taskKey，否则撞 tasks_workflow_key_idx，自治开环失败。
 */
describe("REPLAN key uniqueness after workflow retry (taskflow-vue v9)", () => {
  const replanPolicy = {
    failureStrategy: "REPLAN" as const,
    allowReplan: true,
    maxRetries: 2
  };

  it("nextReplanKeyAttempt roots at plan key and skips occupied -REPLAN-N / -DEBUG-N", () => {
    const tasks = [
      task("T-08"),
      task("T-08-REPLAN-1", { taskKey: "T-08-REPLAN-1" }),
      task("T-08-REPLAN-1-REPLAN-2", { taskKey: "T-08-REPLAN-1-REPLAN-2" }),
      task("T-08-DEBUG-1", { taskKey: "T-08-DEBUG-1" })
    ];
    // 同根家族最大 N=2（含历史嵌套键）⇒ 下一后缀 3
    expect(nextReplanKeyAttempt("T-08", tasks, 0)).toBe(3);
    expect(nextReplanKeyAttempt("T-08", tasks, 2)).toBe(3);
    // 即使传入已是 REPLAN-1，也挂回 T-08，不得再造 T-08-REPLAN-1-REPLAN-N
    expect(nextReplanKeyAttempt("T-08-REPLAN-1", tasks, 1)).toBe(3);
    expect(nextReplanKeyAttempt("T-fresh", [], 0)).toBe(1);
  });

  it("replan of a failed REPLAN leaf creates rooted T-*-REPLAN-N (no nested key/title)", async () => {
    const store = new MemoryStore(
      workflow({ policy: { ...workflow().policy, ...replanPolicy } }),
      [
        task("T-10-REPLAN-1", {
          type: "FRONTEND",
          status: "FAILED",
          input: { executionAttempt: 1 },
          output: {
            errorType: "GATE_FAILURE",
            fixTaskType: "FRONTEND",
            summary: "still red"
          }
        })
      ]
    );
    const executor = new SequenceExecutor({
      "T-10-REPLAN-2": [{ status: "succeeded" }]
    });
    await new WorkflowEngine({
      store,
      executor,
      failureRouter: () => ({ strategy: "REPLAN", reason: "gate repair", failureClass: "GATE_FAILURE" })
    }).start("workflow");
    await waitFor(() => store.run.status === "SUCCESS" || store.run.status === "FAILED");

    expect(store.run.status).toBe("SUCCESS");
    const repair = store.tasks.find((entry) => entry.taskKey === "T-10-REPLAN-2");
    expect(repair).toBeTruthy();
    expect(repair?.title).toBe("Implement FRONTEND fix for T-10 (attempt 2)");
    expect(store.tasks.some((entry) => entry.taskKey.includes("REPLAN-1-REPLAN"))).toBe(false);
  });

  it("retry then fail source again creates a fresh -REPLAN-N (no unique-key collision)", async () => {
    const store = new MemoryStore(
      workflow({
        status: "FAILED",
        policy: { ...workflow().policy, ...replanPolicy }
      }),
      [
        task("T-08", {
          type: "TEST",
          status: "FAILED",
          failureHandled: true,
          resolvedByTaskId: "replan-1-id",
          input: { executionAttempt: 0 },
          output: {
            errorType: "GATE_FAILURE",
            fixTaskType: "FRONTEND",
            summary: "anti-tamper / product gap"
          }
        }),
        task("replan-1-id", {
          taskKey: "T-08-REPLAN-1",
          type: "FRONTEND",
          status: "FAILED",
          failureHandled: true,
          resolvedByTaskId: "replan-2-id",
          origin: "DYNAMIC",
          input: { executionAttempt: 1 }
        }),
        task("replan-2-id", {
          taskKey: "T-08-REPLAN-1-REPLAN-2",
          type: "FRONTEND",
          status: "FAILED",
          failureHandled: true,
          origin: "DYNAMIC",
          input: { executionAttempt: 2 }
        })
      ]
    );
    const executor = new SequenceExecutor({
      "T-08": [
        {
          status: "failed",
          output: {
            errorType: "GATE_FAILURE",
            fixTaskType: "FRONTEND",
            summary: "still red after retry"
          }
        }
      ],
      // 历史嵌套键已占用到 N=2 ⇒ 新开同根 T-08-REPLAN-3
      "T-08-REPLAN-3": [{ status: "succeeded" }]
    });
    const engine = new WorkflowEngine({
      store,
      executor,
      failureRouter: () => ({
        strategy: "REPLAN",
        reason: "gate repair",
        failureClass: "GATE_FAILURE",
        attempt: 0
      })
    });

    await engine.retry("workflow");
    await waitFor(() => store.run.status === "SUCCESS" || store.run.status === "FAILED");

    expect(store.run.status).toBe("SUCCESS");
    expect(store.tasks.some((entry) => entry.taskKey === "T-08-REPLAN-3")).toBe(true);
    expect(store.tasks.some((entry) => entry.taskKey === "T-08-REPLAN-1-REPLAN-3")).toBe(false);
    expect(store.events.some((event) => event.eventType === "REPLAN_STARTED")).toBe(true);
    expect(store.events.some((event) => event.eventType === "TASK_CREATED")).toBe(true);
    expect(store.events.some((event) => event.eventType === "REPLAN_COMPLETED")).toBe(true);
    expect(store.events.some((event) => event.eventType === "REPLAN_FAILED")).toBe(false);
    expect(
      store.events.some((event) => event.eventType === "REPLAN_SUPERSEDED_PRIOR_CHAIN")
    ).toBe(true);
    expect(store.tasks.find((entry) => entry.id === "replan-2-id")?.resolvedByTaskId).toBe(
      store.tasks.find((entry) => entry.taskKey === "T-08-REPLAN-3")?.id
    );
    expect(executor.started).toContain("T-08");
    expect(executor.started).toContain("T-08-REPLAN-3");
  });
});


/**
 * taskflow-vue v9 deadlock：源 T-08 已 SUCCESS，耗尽叶子仍握着 T-10/T-11 的 DYNAMIC 出边，
 * 原源出边 inactive、下游 BLOCKED → WORKFLOW_DEADLOCK / 终局失败。
 * retry 必须卸边并让下游可跑，工作流应能 SUCCESS。
 */
describe("superseded REPLAN downstream restore (taskflow-vue v9 deadlock)", () => {
  it("retry with SUCCESS source + exhausted REPLAN outs unblocks downstream (no deadlock)", async () => {
    const eSrc10 = edge("T-08", "T-10");
    eSrc10.active = false;
    const eSrc11 = edge("T-08", "T-11");
    eSrc11.active = false;
    const eR210 = edge("replan-2", "T-10");
    const eR211 = edge("replan-2", "T-11");
    const store = new MemoryStore(
      workflow({ status: "FAILED" }),
      [
        task("T-08", {
          type: "TEST",
          status: "SUCCESS",
          failureHandled: true,
          resolvedByTaskId: "replan-1"
        }),
        task("replan-1", {
          taskKey: "T-08-REPLAN-1",
          type: "FRONTEND",
          status: "FAILED",
          failureHandled: true,
          resolvedByTaskId: "replan-2",
          origin: "DYNAMIC"
        }),
        task("replan-2", {
          taskKey: "T-08-REPLAN-1-REPLAN-2",
          type: "FRONTEND",
          status: "FAILED",
          failureHandled: true,
          origin: "DYNAMIC"
        }),
        task("T-10", { status: "BLOCKED" }),
        task("T-11", { status: "BLOCKED" })
      ],
      [eSrc10, eSrc11, eR210, eR211]
    );
    const executor = new SequenceExecutor({
      "T-10": [{ status: "succeeded" }],
      "T-11": [{ status: "succeeded" }]
    });
    const engine = new WorkflowEngine({ store, executor });
    await engine.retry("workflow");
    await waitFor(() => store.run.status === "SUCCESS" || store.run.status === "FAILED");

    expect(store.run.status).toBe("SUCCESS");
    expect(store.run.error?.code).not.toBe("WORKFLOW_DEADLOCK");
    expect(eR210.active).toBe(false);
    expect(eR211.active).toBe(false);
    expect(eSrc10.active).toBe(true);
    expect(eSrc11.active).toBe(true);
    expect(store.tasks.find((entry) => entry.id === "T-10")?.status).toBe("SUCCESS");
    expect(store.tasks.find((entry) => entry.id === "T-11")?.status).toBe("SUCCESS");
    expect(
      store.events.some((event) => event.eventType === "REPLAN_DOWNSTREAM_RESTORED")
    ).toBe(true);
  });

  it("retry re-arms FAILED source then restores outs so downstream is not blocked by exhausted leaf", async () => {
    const eSrc10 = edge("T-08", "T-10");
    eSrc10.active = false;
    const eR210 = edge("replan-2", "T-10");
    const store = new MemoryStore(
      workflow({ status: "FAILED" }),
      [
        task("T-08", {
          type: "TEST",
          status: "FAILED",
          failureHandled: true,
          resolvedByTaskId: "replan-1"
        }),
        task("replan-1", {
          taskKey: "T-08-REPLAN-1",
          status: "FAILED",
          failureHandled: true,
          resolvedByTaskId: "replan-2",
          origin: "DYNAMIC"
        }),
        task("replan-2", {
          taskKey: "T-08-REPLAN-1-REPLAN-2",
          status: "FAILED",
          failureHandled: true,
          origin: "DYNAMIC"
        }),
        task("T-10", { status: "BLOCKED" })
      ],
      [eSrc10, eR210]
    );
    const executor = new SequenceExecutor({
      "T-08": [{ status: "succeeded" }],
      "T-10": [{ status: "succeeded" }]
    });
    const engine = new WorkflowEngine({ store, executor });
    await engine.retry("workflow");
    await waitFor(() => store.run.status === "SUCCESS" || store.run.status === "FAILED");

    expect(store.run.status).toBe("SUCCESS");
    expect(eR210.active).toBe(false);
    expect(eSrc10.active).toBe(true);
    expect(executor.started).toEqual(expect.arrayContaining(["T-08", "T-10"]));
  });
});
