import {
  ApiErrorBody,
  AutonomyDecisionEventType,
  AutonomyDecisionPayload,
  DEFAULT_CAPABILITY_PROFILE,
  DeliveryTaskSchema,
  isAutonomyAtLeastL1,
  isDeliveryTaskType,
  isProfileAllowedRepairType,
  isUsableTargetTaskType,
  isWorkTaskType,
  JsonObject,
  PROVIDER_UNAVAILABLE_REASON,
  QUOTA_EXHAUSTED_REASON,
  Task,
  type CapabilityProfile,
  WorkflowRun
} from "@ai-se/shared";
import { randomUUID } from "node:crypto";
import { blockedTaskIds, readyTaskIds, validateWorkflowGraph } from "./scheduler";
import {
  hasUnresolvedFailure,
  planSupersededReplanEdgeRestore,
  replanRootTaskKey,
  retryableFailedTasks
} from "./resolution";
import {
  extractOfficialEvidenceFingerprint,
  extractOfficialGateFailureHint,
  mergeAcKeys,
  withOfficialFailedGateBriefing
} from "./officialGateFailure";
import { assertTaskTransition, assertWorkflowTransition } from "./stateMachine";
import {
  FailureRoute,
  FailureRouter,
  ReplanInput,
  TaskExecutionResult,
  WorkflowStore,
  WorkflowTaskExecutor
} from "./types";

const TERMINAL_TASKS = new Set(["SUCCESS", "FAILED", "BLOCKED", "CANCELLED"]);

function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return { code, message, details };
}

/**
 * N-22（`docs/199` 判据 25e）：失败任务的 `output` 必须**带上平台已知的错误码**。
 *
 * 事件里有 `errorCode`（`result.error?.code`），而任务 `output` 此前不带 ⇒ 批次的
 * `errorTypes`（`packages/eval/src/harness.ts:73-75`，**只收非空 `output.errorType`**）漏计。
 * 实测 L1-M4n run 2：`T7`（交付编排路径，`result.output` 为空）的事件是 **`CI_FAILED`**、
 * 任务 `output.errorType` **为空** ⇒ 4 个失败只报出 1 个。**同一个失败码有两个来源且不一致。**
 *
 * 已有 `errorType` 时**不覆盖**——agent 侧给的码更具体。
 */
function failedTaskOutput(result: TaskExecutionResult): JsonObject {
  const output: JsonObject = { ...(result.output ?? {}) };
  if (output.errorType === undefined && result.error?.code !== undefined) {
    output.errorType = result.error.code;
  }
  if (result.output === undefined) {
    output.error = result.error?.message ?? "Task failed";
  }
  return output;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 为 `${rootTaskKey}-REPLAN-N` / `-DEBUG-N` 分配下一个后缀。
 *
 * 源任务若已是 `T-08-REPLAN-1`，仍挂回原计划根 `T-08`，生成 `T-08-REPLAN-2`，
 * **禁止**再嵌套成 `T-08-REPLAN-1-REPLAN-2`（taskflow-vue v9 用户反馈）。
 *
 * 不能只靠 `source.input.executionAttempt + 1`：人工 `retry()` 重排源任务时
 * executionAttempt 往往仍是 0（源行从未被抬高；预算烧在下游 REPLAN 子任务上），
 * 再 replan 会再次生成已存在的 `T-08-REPLAN-1`，撞上
 * `tasks_workflow_key_idx (workflow_run_id, task_key)`。
 *
 * 扫描同根家族（含历史嵌套键）里出现过的全部 -REPLAN-N/-DEBUG-N，与 priorAttempt+1
 * 取较大值。
 */
const DYNAMIC_ATTEMPT_IN_KEY = /-(?:REPLAN|DEBUG)-(\d+)/g;

export function nextReplanKeyAttempt(
  sourceTaskKey: string,
  tasks: readonly Task[],
  priorAttempt = 0
): number {
  const rootKey = replanRootTaskKey(sourceTaskKey);
  let maxExisting = 0;
  for (const task of tasks) {
    if (replanRootTaskKey(task.taskKey) !== rootKey) continue;
    DYNAMIC_ATTEMPT_IN_KEY.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DYNAMIC_ATTEMPT_IN_KEY.exec(task.taskKey)) !== null) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > maxExisting) maxExisting = n;
    }
  }
  return Math.max(priorAttempt + 1, maxExisting + 1);
}

/**
 * PL-M3（`docs/158` §3）：目标工作类型必须真的可用——既在 `TaskType` 枚举内，又不是运行期专属类型
 * （`DEBUG` / `MONITOR` / `INCIDENT` 由本引擎在 REPLAN 链里自己创建，**没有专业 agent** 与之对应）。
 * `fixTaskType` 来自 **agent 输出**、`targetTaskType` 来自既有任务输入，二者原先都被直接
 * `as Task["type"]`，非法值会造出无人可执行的任务并瞬失败（`validateTaskGraph.ts` 记录过
 * 同类事故：计划项 `type=DEBUG` → 3 次瞬失败、整条工作流 FAILED）。
 *
 * PL-C3：判定上移到 `@ai-se/shared`（`isUsableTargetTaskType`），与计划期、任务派发侧**共用一份**——
 * 此前本包与 `agent-core/src/planning` 各持一份同义副本，而第三份正在 `AgentRegistry` 出现。
 */

/**
 * The work type a DEBUG task must target. Agents name the fix type in their
 * outcome (`fixTaskType`); a failed DEBUG task falls back to the work type its
 * parent was debugging — inheriting its own "DEBUG" label would resolve to no
 * professional agent and kill the dynamic task instantly.
 *
 * PL-M3：两条来源都先做**成员判定**，非法值一律回退到源任务的工作类型。
 * `rejectedFixTaskType` = agent 确实给了一个 `fixTaskType` 但它不可用（缺省则不算回退——
 * 那种情况走的是既有的 `targetTaskType` 继承路径，属正常运作）。
 * **不回显原始值**：它来自 agent 输出的自由文本，本包没有 sanitize 通道（`AGENTS.md` §10）。
 *
 * PL-M18（N-11）：最后一道兜底由 `source.type` 改为 `workType`（见 `fixWorkTargetType`）。
 * 源任务自己是 `REVIEW` 这类**非工作类型**时，原兜底会给出 `REVIEW`——修复任务于是又变成一次
 * 审查，同一负结论必然重现。
 */
function debugTargetType(
  source: Task,
  workType: Task["type"],
  profile: CapabilityProfile = DEFAULT_CAPABILITY_PROFILE
): { type: Task["type"]; rejectedFixTaskType: boolean } {
  const fixTaskType = source.output?.fixTaskType;
  // 显式 fixTaskType：须同时通过「可用」与「能力面允许」（frontend-vue 拒 BACKEND/DATABASE）。
  if (isProfileAllowedRepairType(fixTaskType, profile)) {
    return { type: fixTaskType, rejectedFixTaskType: false };
  }

  const rejectedFixTaskType = typeof fixTaskType === "string";
  const inherited = source.input.targetTaskType;
  // targetTaskType 是平台写入的派发键（可含 backend-node 夹具里的 BACKEND），不做 profile 过滤。
  if (source.type === "DEBUG" && isUsableTargetTaskType(inherited)) {
    return { type: inherited, rejectedFixTaskType };
  }
  // N-23（`docs/200`）：交付任务的 `type` 是**平台契约**，不是「谁来做」的标签——
  // `DeliveryOrchestrator.canHandle` 按 `task.type` 分派（`deploymentOrchestrator.ts:76-84`），
  // 换成工作类型会让 `input.delivery` **悄悄作废**（字段还在，没人再读）。
  // 实测 L1-M4n run 3：`T7`(BUILD/CI) → `T7-REPLAN-1`(BACKEND)，**一条 `ci_runs` 都没写却自报 SUCCESS**
  // ⇒ 下游 `T8`(DEPLOY) 死在 `CI_RELEASE_NOT_FOUND`。这是 PL-M18 的溢出。
  // **位置**：第 3 步之前、第 1 步之后——agent 明确给出的 `fixTaskType`（N-22）仍然优先，
  // 否则 N-22 刚开的通道会被本条立刻无视。
  if (isDeliveryTaskType(source.type)) {
    return { type: source.type, rejectedFixTaskType };
  }
  return { type: isWorkTaskType(source.type) ? source.type : workType, rejectedFixTaskType };
}

/**
 * 非交付源上，REPLAN 动态任务应落在哪个 type。
 * - 有能力面允许的显式 fixTaskType ⇒ 用它（诊断说 FRONTEND 就开 FRONTEND，不再克隆 TEST）
 * - 否则沿用 debugTargetType / 交付契约逻辑
 */
function resolveReplanRetryType(
  source: Task,
  workType: Task["type"],
  profile: CapabilityProfile,
  deliveryOrchestrated: boolean
): { type: Task["type"]; rejectedFixTaskType: boolean; usedExplicitFix: boolean } {
  const target = debugTargetType(source, workType, profile);
  if (deliveryOrchestrated) {
    // PL-M28：交付源的契约键保持源类型；显式 fix 只影响是否先派 DEBUG。
    return { type: source.type, rejectedFixTaskType: target.rejectedFixTaskType, usedExplicitFix: false };
  }
  const explicit = source.output?.fixTaskType;
  if (isProfileAllowedRepairType(explicit, profile)) {
    return { type: explicit, rejectedFixTaskType: false, usedExplicitFix: true };
  }
  return { type: target.type, rejectedFixTaskType: target.rejectedFixTaskType, usedExplicitFix: false };
}

function stripStackedRepairTitle(title: string): string {
  return title
    .replace(/^(?:Retry\s+)+/i, "")
    .replace(/^(?:Diagnose\s+)+/i, "")
    .replace(/\s*\(attempt\s+\d+\)\s*$/i, "")
    .trim();
}

function replanTaskTitle(
  source: Task,
  retryType: Task["type"],
  usedExplicitFix: boolean,
  rootKey: string,
  attempt: number
): string {
  if (source.type === "DEBUG" || usedExplicitFix) {
    return `Implement ${retryType} fix for ${rootKey} (attempt ${attempt})`;
  }
  const base = stripStackedRepairTitle(source.title) || rootKey;
  return `Retry ${base} (attempt ${attempt})`;
}

function replanTaskDescription(source: Task, retryType: Task["type"], usedExplicitFix: boolean): string {
  if (source.type === "DEBUG" || usedExplicitFix) {
    return (
      `Implement the diagnosed product fix as a ${retryType} task` +
      (typeof source.output?.summary === "string" && source.output.summary.length > 0
        ? `: ${source.output.summary}`
        : ".")
    );
  }
  return source.description;
}

/**
 * PL-M18（N-11）：失败任务的修复任务应当落在**哪个工作类型**上。
 *
 * 源任务自己已经是工作类型 ⇒ 原样（照旧重试同一类工作）。否则取**源任务所在切片**里出现过的
 * 工作类型（同工作流；源任务带 `sliceKey` 时只算同切片的），按出现次数取最多、平局按
 * profile.work 顺序；切片里一个都没有则回退 `profile.taskTypes.fixFallback`。
 *
 * 为什么不能继承源任务类型：`REVIEW` 的负结论讲的是**产品**，把它 replan 成另一个 `REVIEW`
 * 只会得到同一个结论（实测：L1-M4i 的 `T-S4-R2` 逐层嵌套 `-REPLAN-2` 直到深度守卫）。
 */
function fixWorkTargetType(
  source: Task,
  workflowTasks: Task[],
  profile: CapabilityProfile = DEFAULT_CAPABILITY_PROFILE
): Task["type"] {
  if (isWorkTaskType(source.type)) return source.type;

  const sliceKey = source.sliceKey;
  const counts = new Map<string, number>();
  for (const entry of workflowTasks) {
    if (entry.id === source.id) continue;
    if (sliceKey !== undefined && entry.sliceKey !== sliceKey) continue;
    if (!isWorkTaskType(entry.type)) continue;
    counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
  }

  let best: Task["type"] | undefined;
  let bestCount = 0;
  for (const candidate of profile.taskTypes.work) {
    const count = counts.get(candidate) ?? 0;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best ?? profile.taskTypes.fixFallback;
}

/**
 * L1-6：识别「验证门在 enforce 下判失败」的任务结果，并给出契约要求的 `failedChecks`。
 * **不引跨包常量**：observe 模式不覆盖任务结果（`verifyingTaskExecutor` 只在 enforce 下
 * 改写），所以「任务已失败 + 记录 verdict=failed」只可能来自 enforce。
 */
function enforcedVerificationFailure(
  output: JsonObject | undefined
): { failedChecks: string[]; commitSha?: string } | undefined {
  const record = output?.verification;
  if (typeof record !== "object" || record === null) return undefined;
  const entry = record as {
    verdict?: unknown;
    checks?: unknown;
    commitSha?: unknown;
    antiTamper?: { verdict?: unknown } | undefined;
    writeScope?: { outcome?: unknown } | undefined;
  };
  if (entry.verdict !== "failed") return undefined;
  const names = (Array.isArray(entry.checks) ? entry.checks : [])
    .filter(
      (check): check is { name: string; passed: boolean } =>
        typeof check === "object" &&
        check !== null &&
        typeof (check as { name?: unknown }).name === "string" &&
        (check as { passed?: unknown }).passed === false
    )
    .map((check) => check.name.slice(0, 120));
  // 没有失败检查 = 失败来自防篡改或写范围违规。用**门组件名**，不编造检查名。
  const components: string[] = [];
  if (names.length === 0) {
    if (entry.antiTamper?.verdict === "failed") components.push("anti-tamper");
    if (entry.writeScope?.outcome === "violation") components.push("write-scope");
  }
  return {
    failedChecks: names.length > 0 ? names : components.length > 0 ? components : ["verification-gate"],
    ...(typeof entry.commitSha === "string" ? { commitSha: entry.commitSha.slice(0, 80) } : {})
  };
}

/**
 * N-61（`docs/232` §10）：**上游模型服务不可用**，不是「任务做错了」。
 *
 * 标记来自 `AgentGraph`（重试耗尽后写 `error.details.reason`）→
 * `ProfessionalAgent.failedRunOutcome`（转成 `metadata.errorReason`）→
 * `workflowTaskExecutor` 的 `output` 白名单（那边是显式枚举，不铺开 `metadata`）。
 *
 * 为什么必须区别对待：REPLAN 会造一个 `DEBUG` 任务去「诊断」——诊断改变不了上游容量，
 * 它只会撞同一堵墙。实测（2026-10-29 F1 第三轮）：`T7` → `T7-DEBUG-1` →
 * `T7-DEBUG-1-DEBUG-2` 三次全撞 429、整片失败，且被记进「agent 做错了」那一层。
 */
function providerUnavailableFailure(task: Task): boolean {
  return task.output?.errorReason === PROVIDER_UNAVAILABLE_REASON;
}

function quotaExhaustedFailure(task: Task): boolean {
  return task.output?.errorReason === QUOTA_EXHAUSTED_REASON;
}

export interface WorkflowEngineOptions {
  store: WorkflowStore;
  executor: WorkflowTaskExecutor;
  onChanged?: (workflowRunId: string) => void;
  /** Phase 5.7-5: optional failure routing hook (default = policy strategies). */
  failureRouter?: FailureRouter;
  /** N2：工作流进入终态（SUCCESS/FAILED/CANCELLED）后的轻量编排钩子（切片链式推进）。 */
  onTerminal?: (workflowRunId: string, status: "SUCCESS" | "FAILED" | "CANCELLED") => void;
  /**
   * `docs/235` §6.5：能力 profile（组合根注入一次）。它只影响**修复任务落在哪个工作类型**——
   * 缺省 `DEFAULT_CAPABILITY_PROFILE`（现为 `frontend-vue`）⇒ 回退 `fixFallback`（FRONTEND）。
   */
  profile?: CapabilityProfile;
}

/**
 * T6：wallClock 口径（冻结默认）= `startedAt → now` 扣除 PAUSED 段。
 * PAUSED/RESUMED 事件对推导暂停时长；未闭合的暂停段计至 now；
 * recover() 的 RESUMED（无前置 PAUSED）自然被忽略。
 */
export function computeBudgetWallClockMs(
  startedAt: string | null | undefined,
  events: Array<{ eventType: string; createdAt: string }>,
  nowMs: number
): number {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return 0;
  let pausedMs = 0;
  let pauseStart: number | null = null;
  for (const event of events) {
    if (event.eventType === "WORKFLOW_PAUSED") {
      pauseStart = Date.parse(event.createdAt);
    } else if (event.eventType === "WORKFLOW_RESUMED" && pauseStart !== null) {
      pausedMs += Math.max(0, Date.parse(event.createdAt) - pauseStart);
      pauseStart = null;
    }
  }
  if (pauseStart !== null) {
    pausedMs += Math.max(0, nowMs - pauseStart);
  }
  return Math.max(0, nowMs - start - pausedMs);
}

export class WorkflowEngine {
  private readonly advancing = new Set<string>();
  private readonly rerun = new Set<string>();
  private readonly completionQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: WorkflowEngineOptions) {}

  /**
   * 7-A：`options.requestId` 是触发本次启动的 HTTP 请求 ID，写进 `WORKFLOW_STARTED`
   * 的 payload（不改表结构），供后续执行沿用同一关联 ID；缺省时行为与旧版一致。
   */
  async start(id: string, options?: { requestId?: string }): Promise<WorkflowRun> {
    const workflow = await this.requiredWorkflow(id);
    if (workflow.status !== "PENDING") throw new Error("Workflow is not pending");
    assertWorkflowTransition(workflow.status, "RUNNING");
    const updated = await this.options.store.updateWorkflow(id, [workflow.status], {
      status: "RUNNING",
      startedAt: workflow.startedAt ?? new Date().toISOString()
    });
    if (!updated) throw new Error("Workflow state changed before start");
    await this.event(id, "WORKFLOW_STARTED", {
      status: updated.status,
      ...(options?.requestId ? { requestId: options.requestId } : {})
    });
    void this.advance(id);
    return updated;
  }

  async pause(id: string): Promise<WorkflowRun> {
    const workflow = await this.requiredWorkflow(id);
    assertWorkflowTransition(workflow.status, "PAUSED");
    const updated = await this.options.store.updateWorkflow(id, [workflow.status], {
      status: "PAUSED"
    });
    if (!updated) throw new Error("Workflow state changed before pause");
    await this.event(id, "WORKFLOW_PAUSED", { status: updated.status });
    return updated;
  }

  async resume(id: string): Promise<WorkflowRun> {
    const workflow = await this.requiredWorkflow(id);
    if (workflow.status !== "PAUSED") throw new Error("Workflow is not paused");
    assertWorkflowTransition(workflow.status, "RUNNING");
    const updated = await this.options.store.updateWorkflow(id, [workflow.status], {
      status: "RUNNING"
    });
    if (!updated) throw new Error("Workflow state changed before resume");
    await this.event(id, "WORKFLOW_RESUMED", { status: updated.status });
    void this.advance(id);
    return updated;
  }

  async cancel(id: string): Promise<WorkflowRun> {
    const workflow = await this.requiredWorkflow(id);
    if (workflow.status === "CANCELLED") return workflow;
    assertWorkflowTransition(workflow.status, "CANCELLED");
    const tasks = await this.options.store.findTasks(id);
    const updated = await this.options.store.updateWorkflow(id, [workflow.status], {
      status: "CANCELLED",
      finishedAt: new Date().toISOString()
    });
    if (!updated) throw new Error("Workflow state changed before cancellation");
    await this.options.store.cancelNonTerminalTasks(id);
    await Promise.all(
      tasks
        .filter((task) => task.status === "RUNNING")
        .map((task) => this.options.executor.cancel(task))
    );
    await this.event(id, "WORKFLOW_CANCELLED", { status: updated.status });
    this.options.onTerminal?.(id, "CANCELLED");
    return updated;
  }

  /**
   * 人工重试失败工作流(Retry Failed Workflow):未解决失败任务 FAILED → RETRYING
   * (复位 failure_handled)、BLOCKED → PENDING、工作流 FAILED → RUNNING,随后交既有
   * advance() 继续执行。SUCCESS / 已解决失败 / RUNNING / WAITING_APPROVAL 任务一律
   * 不触碰;重排任务再次失败时完全按既有 policy 策略处理(零新增分支)。
   */
  async retry(id: string): Promise<WorkflowRun> {
    const workflow = await this.requiredWorkflow(id);
    if (workflow.status !== "FAILED") throw new Error("Workflow is not failed");
    const tasks = await this.options.store.findTasks(id);
    const approvals = await this.options.store.findApprovals(id);
    // 人工重试只重排每条修复链的最上游未解决失败（retryableFailedTasks）；
    // SUCCESS 前驱出站链上的过时 REPLAN 层由 isFailureResolved 视为已解决，不再入列。
    const failed = retryableFailedTasks(tasks);
    const blocked = tasks.filter((task) => task.status === "BLOCKED");
    const approvalBlocked = failed.filter((task) =>
      approvals.some((approval) => approval.taskId === task.id && approval.status !== "APPROVED")
    );
    if (approvalBlocked.length > 0) {
      throw new Error(
        `Retry blocked by rejected approval: ${approvalBlocked
          .map((task) => task.taskKey)
          .join(", ")}`
      );
    }
    if (failed.length === 0 && blocked.length === 0) throw new Error("No retryable tasks");

    for (const task of failed) {
      assertTaskTransition(task.status, "RETRYING");
      const updated = await this.options.store.updateTask(task.id, ["FAILED"], {
        status: "RETRYING",
        failureHandled: false,
        clearClaim: true
      });
      if (!updated) throw new Error("Task state changed before retry");
      await this.event(
        id,
        "TASK_RETRY_REQUESTED",
        { taskId: task.id, taskKey: task.taskKey, from: "FAILED" },
        task.id
      );
    }
    for (const task of blocked) {
      assertTaskTransition(task.status, "PENDING");
      const updated = await this.options.store.updateTask(task.id, ["BLOCKED"], {
        status: "PENDING"
      });
      if (!updated) throw new Error("Task state changed before retry");
      await this.event(
        id,
        "TASK_RETRY_REQUESTED",
        { taskId: task.id, taskKey: task.taskKey, from: "BLOCKED" },
        task.id
      );
    }

    // v9 deadlock：耗尽 REPLAN 仍握着 DYNAMIC 出边时，先把下游挂回源任务再推进。
    await this.restoreSupersededReplanDownstream(id);

    assertWorkflowTransition(workflow.status, "RUNNING");
    const updated = await this.options.store.updateWorkflow(id, ["FAILED"], {
      status: "RUNNING",
      clearError: true,
      clearFinishedAt: true
    });
    if (!updated) throw new Error("Workflow state changed before retry");
    await this.event(id, "WORKFLOW_RETRIED", {
      retriedTaskKeys: failed.map((task) => task.taskKey),
      requeuedTaskKeys: blocked.map((task) => task.taskKey)
    });
    void this.advance(id);
    return updated;
  }

  async approve(approvalId: string, comment: string): Promise<void> {
    const approval = await this.options.store.findApprovalById(approvalId);
    if (!approval || approval.status !== "PENDING") throw new Error("Approval is not pending");
    const decided = await this.options.store.decideApproval(approvalId, "APPROVED", comment);
    if (!decided) throw new Error("Approval state changed before approval");
    const workflowRunId = approval.workflowRunId;
    const taskId = approval.taskId;
    if (!workflowRunId || !taskId) throw new Error("Approval is not a task approval");
    const task = (await this.options.store.findTasks(workflowRunId)).find(
      (entry) => entry.id === taskId
    );
    if (!task) throw new Error("Approval task not found");
    assertTaskTransition(task.status, "READY");
    await this.options.store.updateTask(task.id, [task.status], { status: "READY" });
    await this.event(workflowRunId, "APPROVAL_GRANTED", { approvalId, taskId: task.id }, task.id);
    const pending = (await this.options.store.findApprovals(workflowRunId)).some(
      (entry) => entry.status === "PENDING"
    );
    if (!pending) {
      await this.options.store.updateWorkflow(workflowRunId, ["WAITING_APPROVAL"], {
        status: "RUNNING"
      });
      void this.advance(workflowRunId);
    }
  }

  async reject(approvalId: string, comment: string): Promise<void> {
    const approval = await this.options.store.findApprovalById(approvalId);
    if (!approval || approval.status !== "PENDING") throw new Error("Approval is not pending");
    const decided = await this.options.store.decideApproval(approvalId, "REJECTED", comment);
    if (!decided) throw new Error("Approval state changed before rejection");
    const workflowRunId = approval.workflowRunId;
    const taskId = approval.taskId;
    if (!workflowRunId || !taskId) throw new Error("Approval is not a task approval");
    const task = (await this.options.store.findTasks(workflowRunId)).find(
      (entry) => entry.id === taskId
    );
    if (!task) throw new Error("Approval task not found");
    assertTaskTransition(task.status, "FAILED");
    await this.options.store.updateTask(task.id, [task.status], {
      status: "FAILED",
      output: { error: "Approval rejected", comment },
      finishedAt: new Date().toISOString(),
      failureHandled: false
    });
    await this.options.store.updateWorkflow(workflowRunId, ["WAITING_APPROVAL"], {
      status: "RUNNING"
    });
    await this.event(workflowRunId, "APPROVAL_REJECTED", { approvalId, taskId: task.id }, task.id);
    void this.advance(workflowRunId);
  }

  async recover(): Promise<number> {
    const workflows = await this.options.store.findWorkflowsByStatuses(["RUNNING"]);
    for (const workflow of workflows) {
      // N-37：恢复写入也要过状态机。此前 `recoverRunningTasks` 直接 UPDATE，
      // 是全仓唯一绕过 `assertTaskTransition` 的写入。
      // 硬停：retryCount 已达 maxRetries 的 RUNNING 不再重排队——否则每次进程重启
      // （「Agent run was interrupted before this server process started」）都会把同一条
      // Diagnose/DEBUG 再跑一遍，retryCount 可远超策略上限（TASK-09-DEBUG-1 实测 11 次）。
      const tasks = await this.options.store.findTasks(workflow.id);
      const exhaustedTaskKeys: string[] = [];
      for (const task of tasks) {
        if (task.status !== "RUNNING") continue;
        if (task.retryCount >= workflow.policy.maxRetries) {
          assertTaskTransition(task.status, "FAILED");
          await this.options.store.updateTask(task.id, ["RUNNING"], {
            status: "FAILED",
            finishedAt: new Date().toISOString(),
            failureHandled: true
          });
          await this.event(
            workflow.id,
            "FAILURE_ROUTED",
            {
              taskId: task.id,
              strategy: "FAIL",
              failureClass: "repair-exhausted",
              reason: `Crash recovery budget exhausted for ${task.taskKey} (retryCount=${task.retryCount}, maxRetries=${workflow.policy.maxRetries})`,
              attempt: task.retryCount,
              stalled: true
            },
            task.id
          );
          exhaustedTaskKeys.push(task.taskKey);
          continue;
        }
        assertTaskTransition(task.status, "RETRYING");
      }
      const recoveredTasks = await this.options.store.recoverRunningTasks(workflow.id);
      await this.event(workflow.id, "WORKFLOW_RESUMED", {
        recovery: true,
        recoveredTasks,
        ...(exhaustedTaskKeys.length > 0 ? { recoveryBudgetExhausted: exhaustedTaskKeys } : {})
      });
      if (exhaustedTaskKeys.length > 0) {
        await this.failWorkflow(
          workflow.id,
          "TASK_RECOVERY_BUDGET_EXHAUSTED",
          `Crash recovery budget exhausted; not re-queueing: ${exhaustedTaskKeys.join(", ")}`
        );
        continue;
      }
      void this.advance(workflow.id);
    }
    return workflows.length;
  }

  async advance(id: string): Promise<void> {
    if (this.advancing.has(id)) {
      this.rerun.add(id);
      return;
    }
    this.advancing.add(id);
    try {
      do {
        this.rerun.delete(id);
        await this.advanceOnce(id);
      } while (this.rerun.has(id));
    } finally {
      this.advancing.delete(id);
    }
  }

  private async advanceOnce(id: string): Promise<void> {
    const workflow = await this.options.store.findWorkflowById(id);
    if (!workflow || workflow.status !== "RUNNING") return;

    await this.handleFailures(workflow);
    const current = await this.options.store.findWorkflowById(id);
    if (!current || current.status !== "RUNNING") return;

    // T6：claim 循环前检查工作流级预算（超限 → PAUSED + 原因；未设限零干预）。
    if (await this.enforceBudget(current)) return;

    let tasks = await this.options.store.findTasks(id);
    let dependencies = await this.options.store.findDependencies(id);

    for (const taskId of blockedTaskIds(tasks, dependencies)) {
      const task = tasks.find((entry) => entry.id === taskId);
      if (!task) continue;
      assertTaskTransition(task.status, "BLOCKED");
      const blocked = await this.options.store.updateTask(task.id, [task.status], {
        status: "BLOCKED",
        finishedAt: new Date().toISOString()
      });
      if (blocked) await this.event(id, "TASK_BLOCKED", { taskId: task.id }, task.id);
    }

    tasks = await this.options.store.findTasks(id);
    dependencies = await this.options.store.findDependencies(id);
    // 防御：超预算的 RETRYING 不得再进 READY/claim（崩溃恢复硬停的第二道闸）。
    for (const task of tasks) {
      if (task.status !== "RETRYING") continue;
      if (task.retryCount <= current.policy.maxRetries) continue;
      assertTaskTransition(task.status, "FAILED");
      await this.options.store.updateTask(task.id, ["RETRYING"], {
        status: "FAILED",
        finishedAt: new Date().toISOString(),
        failureHandled: true
      });
      await this.event(
        id,
        "FAILURE_ROUTED",
        {
          taskId: task.id,
          strategy: "FAIL",
          failureClass: "repair-exhausted",
          reason: `Retry budget exhausted for ${task.taskKey} while RETRYING (retryCount=${task.retryCount}, maxRetries=${current.policy.maxRetries})`,
          attempt: task.retryCount,
          stalled: true
        },
        task.id
      );
      await this.failWorkflow(
        id,
        "TASK_RECOVERY_BUDGET_EXHAUSTED",
        `Retry budget exhausted; not re-queueing: ${task.taskKey}`
      );
      return;
    }
    tasks = await this.options.store.findTasks(id);
    dependencies = await this.options.store.findDependencies(id);
    const approvals = await this.options.store.findApprovals(id);
    for (const taskId of readyTaskIds(tasks, dependencies)) {
      const task = tasks.find((entry) => entry.id === taskId);
      if (!task) continue;
      const approved = approvals.some(
        (approval) => approval.taskId === task.id && approval.status === "APPROVED"
      );
      if (task.approvalRequired && !approved) {
        const existing = approvals.find((approval) => approval.taskId === task.id);
        if (!existing) {
          const approval = await this.options.store.createApproval(
            id,
            task.id,
            "Task requires human approval"
          );
          assertTaskTransition(task.status, "WAITING_APPROVAL");
          await this.options.store.updateTask(task.id, [task.status], {
            status: "WAITING_APPROVAL"
          });
          await this.event(
            id,
            "APPROVAL_REQUIRED",
            { approvalId: approval.id, taskId: task.id },
            task.id
          );
        }
        const waiting = await this.options.store.updateWorkflow(id, ["RUNNING"], {
          status: "WAITING_APPROVAL"
        });
        if (waiting) this.options.onChanged?.(id);
        return;
      }

      assertTaskTransition(task.status, "READY");
      const ready = await this.options.store.updateTask(task.id, [task.status], {
        status: "READY"
      });
      if (ready) await this.event(id, "TASK_READY", { taskId: task.id }, task.id);
    }

    let claimed = 0;
    while (true) {
      const task = await this.options.store.claimNextTask(id, randomUUID());
      if (!task) break;
      claimed += 1;
      await this.event(
        id,
        "TASK_STARTED",
        { taskId: task.id, retryCount: task.retryCount },
        task.id
      );
      if (isAutonomyAtLeastL1(current.policy) && this.isAutoApprovedStagingDeploy(task)) {
        await this.autonomyDecision(
          id,
          "AUTO_APPROVED",
          {
            policyId: "L1",
            reason: "L1 policy: staging deployment needs no human approval",
            workflowRunId: id,
            taskId: task.id,
            environment: "staging"
          },
          task.id
        );
      }
      void this.executeTask(current, task);
    }
    if (claimed > 0) return;

    tasks = await this.options.store.findTasks(id);
    const running = tasks.some((task) => task.status === "RUNNING");
    if (running) return;
    const waitingApproval = tasks.some((task) => task.status === "WAITING_APPROVAL");
    if (waitingApproval) {
      await this.options.store.updateWorkflow(id, ["RUNNING"], { status: "WAITING_APPROVAL" });
      this.options.onChanged?.(id);
      return;
    }

    const allTerminal = tasks.every((task) => TERMINAL_TASKS.has(task.status));
    if (allTerminal) {
      const unresolvedFailure = hasUnresolvedFailure(tasks);
      if (unresolvedFailure) {
        await this.failWorkflow(
          id,
          "WORKFLOW_TASK_FAILED",
          "Workflow contains unresolved failed tasks"
        );
      } else {
        const updated = await this.options.store.updateWorkflow(id, ["RUNNING"], {
          status: "SUCCESS",
          output: { taskCount: tasks.length },
          finishedAt: new Date().toISOString()
        });
        if (updated) {
          await this.event(id, "WORKFLOW_COMPLETED", { status: "SUCCESS" });
          this.options.onTerminal?.(id, "SUCCESS");
        }
      }
      return;
    }

    await this.failWorkflow(
      id,
      "WORKFLOW_DEADLOCK",
      "Workflow has unfinished tasks but no runnable work"
    );
  }

  /**
   * T6：工作流级预算检查（claim 循环前调用）。
   * - 任一侧限超限 → PAUSED + error(BUDGET_EXCEEDED) + WORKFLOW_PAUSED 事件（payload 含超限项与用量）；
   * - 任一侧限首次越过 80% → 发一次 WORKFLOW_BUDGET_WARNING（以既有事件查询去重，不刷屏）；
   * - 未设限 → 零查询、零干预；maxCostUsd 仅在存在成本数据时参与判定。
   * 返回 true 表示本周期不得继续 claim（已暂停或状态已变）。
   */
  private async enforceBudget(workflow: WorkflowRun): Promise<boolean> {
    const policy = workflow.policy;
    const hasLimits =
      policy.maxCostUsd !== undefined ||
      policy.maxTokens !== undefined ||
      policy.maxWallClockMs !== undefined;
    if (!hasLimits) return false;

    const usage = await this.options.store.sumRunUsage(workflow.id);
    const events = await this.options.store.findEvents(workflow.id);
    const totalTokens = usage.inputTokens + usage.outputTokens;
    const wallClockMs = computeBudgetWallClockMs(workflow.startedAt, events, Date.now());

    const exceeded: string[] = [];
    if (policy.maxWallClockMs !== undefined && wallClockMs > policy.maxWallClockMs) {
      exceeded.push("maxWallClockMs");
    }
    if (policy.maxTokens !== undefined && totalTokens > policy.maxTokens) {
      exceeded.push("maxTokens");
    }
    if (
      policy.maxCostUsd !== undefined &&
      usage.estimatedCostUsd !== null &&
      usage.estimatedCostUsd > policy.maxCostUsd
    ) {
      exceeded.push("maxCostUsd");
    }

    const usageSummary: JsonObject = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens,
      wallClockMs,
      ...(usage.estimatedCostUsd !== null ? { estimatedCostUsd: usage.estimatedCostUsd } : {})
    };
    const limits: JsonObject = {
      ...(policy.maxCostUsd !== undefined ? { maxCostUsd: policy.maxCostUsd } : {}),
      ...(policy.maxTokens !== undefined ? { maxTokens: policy.maxTokens } : {}),
      ...(policy.maxWallClockMs !== undefined ? { maxWallClockMs: policy.maxWallClockMs } : {})
    };

    if (exceeded.length > 0) {
      const updated = await this.options.store.updateWorkflow(workflow.id, ["RUNNING"], {
        status: "PAUSED",
        error: errorBody("BUDGET_EXCEEDED", `工作流预算超限：${exceeded.join("、")}`, {
          exceeded,
          limits,
          usage: usageSummary
        })
      });
      if (updated) {
        await this.event(workflow.id, "WORKFLOW_PAUSED", {
          reason: "BUDGET_EXCEEDED",
          exceeded,
          limits,
          usage: usageSummary
        });
      }
      return true;
    }

    const ratios: number[] = [];
    if (policy.maxWallClockMs !== undefined) {
      ratios.push(wallClockMs / policy.maxWallClockMs);
    }
    if (policy.maxTokens !== undefined) {
      ratios.push(totalTokens / policy.maxTokens);
    }
    if (policy.maxCostUsd !== undefined && usage.estimatedCostUsd !== null) {
      ratios.push(usage.estimatedCostUsd / policy.maxCostUsd);
    }
    if (
      ratios.some((ratio) => ratio >= 0.8) &&
      !events.some((entry) => entry.eventType === "WORKFLOW_BUDGET_WARNING")
    ) {
      await this.event(workflow.id, "WORKFLOW_BUDGET_WARNING", { limits, usage: usageSummary });
    }
    return false;
  }

  private async executeTask(workflow: WorkflowRun, task: Task): Promise<void> {
    let result;
    try {
      result = await this.options.executor.execute(workflow, task);
    } catch (error) {
      result = {
        status: "failed" as const,
        error: errorBody(
          "TASK_EXECUTION_ERROR",
          error instanceof Error ? error.message : "Task execution failed"
        )
      };
    }

    await this.serializeCompletion(workflow.id, async () => {
      await this.persistTaskResult(workflow, task, result);
      await this.advance(workflow.id);
    });
  }

  private async serializeCompletion(workflowRunId: string, action: () => Promise<void>) {
    const previous = this.completionQueues.get(workflowRunId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.completionQueues.set(workflowRunId, current);
    try {
      await current;
    } finally {
      if (this.completionQueues.get(workflowRunId) === current) {
        this.completionQueues.delete(workflowRunId);
      }
    }
  }

  private async persistTaskResult(
    workflow: WorkflowRun,
    task: Task,
    result: TaskExecutionResult
  ): Promise<void> {
    const latestWorkflow = await this.options.store.findWorkflowById(workflow.id);
    if (!latestWorkflow || latestWorkflow.status === "CANCELLED") return;
    const finishedAt = new Date().toISOString();
    if (result.status === "succeeded") {
      const completed = await this.options.store.updateTask(task.id, ["RUNNING"], {
        status: "SUCCESS",
        assignedAgent: result.assignedAgent,
        output: result.output ?? {},
        finishedAt,
        clearClaim: true
      });
      if (completed) {
        await this.event(
          workflow.id,
          "TASK_COMPLETED",
          { taskId: task.id, agentRunId: result.agentRunId },
          task.id,
          result.agentRunId
        );
        // DEBUG 交接成功且给出 fixTaskType 时：纠正仍 PENDING/READY 的兄弟 -REPLAN-N 类型
        // （replan 造 DEBUG+REPLAN 时类型在诊断前就锁死；否则会再跑一遍注定失败的 TEST）。
        if (task.type === "DEBUG") {
          await this.retargetPendingReplansAfterDebug(workflow, { ...task, output: result.output ?? {} });
        }
        // 源任务再次 SUCCESS 时卸掉耗尽 REPLAN 挡路边（与 retry 对称）。
        await this.restoreSupersededReplanDownstream(workflow.id, task.id);
      }
      return;
    }
    if (result.status === "cancelled") {
      await this.options.store.updateTask(task.id, ["RUNNING"], {
        status: "CANCELLED",
        assignedAgent: result.assignedAgent,
        output: result.output ?? {},
        finishedAt,
        clearClaim: true
      });
      return;
    }
    const failed = await this.options.store.updateTask(task.id, ["RUNNING"], {
      status: "FAILED",
      assignedAgent: result.assignedAgent,
      output: failedTaskOutput(result),
      finishedAt,
      clearClaim: true,
      failureHandled: false
    });
    if (failed) {
      await this.event(
        workflow.id,
        "TASK_FAILED",
        {
          taskId: task.id,
          agentRunId: result.agentRunId,
          errorCode: result.error?.code,
          status: result.status
        },
        task.id,
        result.agentRunId
      );
      // L1-6：验证门在 enforce 下把自报成功判成失败，是一次**策略强制**——记一条决策事件。
      const enforced = isAutonomyAtLeastL1(workflow.policy)
        ? enforcedVerificationFailure(result.output)
        : undefined;
      if (enforced) {
        await this.autonomyDecision(
          workflow.id,
          "VERIFICATION_ENFORCED_FAILURE",
          {
            policyId: "L1",
            reason: `L1 policy: verification gate enforced failure on ${task.taskKey}`,
            workflowRunId: workflow.id,
            taskId: task.id,
            failedChecks: enforced.failedChecks,
            gateMode: "enforce",
            ...(enforced.commitSha ? { commitSha: enforced.commitSha } : {})
          },
          task.id
        );
      }
    }
  }

  /**
   * L1-1 的判定面：staging DEPLOY 任务由策略判定无需人工、直接进入执行。
   * **只认 staging**——production 的审批门不由策略关闭（L1-9 红线），契约层也已把
   * `AUTO_APPROVED.environment` 锁死为 `"staging"`。
   *
   * N-31（`docs/215`）：**不再以 `task.type` 为前提。** `DeliveryOrchestrator.canHandle` 已改为
   * 按 `input.delivery` 分派 ⇒ 一个挂在别的类型上的 staging DEPLOY 会**由编排器执行**、却仍
   * 因为这里类型不匹配而**等一个人审**——那正是 N-31 的同类失效（契约与判定面不同源）。
   * 两处现在都以 `input.delivery` 为唯一依据。
   */
  private isAutoApprovedStagingDeploy(task: Task): boolean {
    const parsed = DeliveryTaskSchema.safeParse(task.input.delivery);
    return (
      parsed.success && parsed.data.action === "DEPLOY" && parsed.data.environment === "staging"
    );
  }

  private async handleFailures(workflow: WorkflowRun): Promise<void> {
    const failures = (await this.options.store.findTasks(workflow.id)).filter(
      (task) => task.status === "FAILED" && task.failureHandled !== true
    );
    for (const failure of failures) {
      const task = await this.options.store.claimFailureHandling(failure.id);
      if (!task) continue;

      // Phase 5.7-5: the failure router (when wired) sees the real persisted
      // facts and steers the EXISTING chains; undefined = built-in policy.
      const routed = this.options.failureRouter?.({
        workflow,
        task,
        approvals: await this.options.store.findApprovals(workflow.id)
      });
      if (routed) {
        await this.event(
          workflow.id,
          "FAILURE_ROUTED",
          {
            taskId: task.id,
            strategy: routed.strategy,
            ...(routed.failureClass ? { failureClass: routed.failureClass } : {}),
            ...(routed.reason ? { reason: routed.reason } : {}),
            ...(routed.stalled ? { stalled: true } : {}),
            ...(routed.attempt !== undefined ? { attempt: routed.attempt } : {}),
            ...(routed.evidenceSummary ? { evidenceSummary: routed.evidenceSummary } : {}),
            ...(routed.errorType ? { errorType: routed.errorType } : {}),
            ...(routed.fixTaskType ? { fixTaskType: routed.fixTaskType } : {})
          },
          task.id
        );
      }
      // L1-5：DEPLOY 任务失败时，策略声明的 deployFailureStrategy 优先于通用 failureStrategy。
      // 只在显式声明 ROLLBACK 时生效；未声明 = 现状（沿用 failureStrategy）。
      const deployOverride =
        task.type === "DEPLOY" && workflow.policy.deployFailureStrategy === "ROLLBACK"
          ? "ROLLBACK"
          : undefined;
      const policyStrategy = deployOverride ?? routed?.strategy ?? workflow.policy.failureStrategy;
      // Round16：配额耗尽（Go usage limit / monthly）重试或 REPLAN 都无意义——停给人换 key / 等重置。
      if (quotaExhaustedFailure(task)) {
        await this.requestHumanIntervention(
          workflow,
          task,
          "Model provider quota exhausted; waiting for a key/endpoint change or quota reset",
          {
            strategy: "HUMAN",
            failureClass: "quota-exhausted",
            reason: "Model provider quota exhausted"
          }
        );
        continue;
      }
      // N-61：上游不可用时 REPLAN 是错的方向（诊断任务治不了容量问题，只会同样撞墙）。
      // 改成原任务重试——重试会再次走 `AgentGraph` 的退避，真实恢复能接得住。
      const providerUnavailable = providerUnavailableFailure(task);
      const strategy =
        providerUnavailable && policyStrategy === "REPLAN" ? "RETRY" : policyStrategy;
      if (providerUnavailable && strategy !== policyStrategy && !routed) {
        await this.event(
          workflow.id,
          "FAILURE_ROUTED",
          {
            taskId: task.id,
            strategy,
            failureClass: "provider-unavailable",
            reason: `Model provider unavailable; retrying ${task.taskKey} instead of re-planning`
          },
          task.id
        );
      }

      if (strategy === "HUMAN") {
        await this.requestHumanIntervention(
          workflow,
          task,
          routed?.reason ?? "Failure requires human intervention",
          routed
        );
        continue;
      }

      if (strategy === "FAIL") {
        await this.failWorkflow(
          workflow.id,
          "WORKFLOW_TASK_FAILED",
          routed?.reason ?? `Task failed: ${task.title}`
        );
        return;
      }

      if (
        strategy === "RETRY" &&
        workflow.policy.allowRetry &&
        task.retryCount < workflow.policy.maxRetries
      ) {
        assertTaskTransition(task.status, "RETRYING");
        await this.options.store.updateTask(task.id, ["FAILED"], {
          status: "RETRYING",
          retryCount: task.retryCount + 1,
          clearClaim: true
        });
        await this.event(
          workflow.id,
          "TASK_RETRYING",
          {
            taskId: task.id,
            retryCount: task.retryCount + 1
          },
          task.id
        );
        // L1-6：重试的**策略决策**另记一条——`TASK_RETRYING` 是引擎的机械事实，
        // 这条回答「策略为什么这么决定」（2026-10-15 裁定，`docs/154` §6 第 2 项）。
        if (isAutonomyAtLeastL1(workflow.policy)) {
          await this.autonomyDecision(
            workflow.id,
            "AUTO_RETRIED",
            {
              policyId: "L1",
              reason: `L1 policy: automatic retry of ${task.taskKey} (attempt ${
                task.retryCount + 1
              } of ${workflow.policy.maxRetries})`,
              workflowRunId: workflow.id,
              taskId: task.id,
              attempt: task.retryCount + 1,
              maxAttempts: workflow.policy.maxRetries
            },
            task.id
          );
        }
        continue;
      }

      // N-61：上游不可用却没有重试额度——如实终结，别把它伪装成任务质量问题、也别再
      // 叠一层诊断任务。措辞里点名原因，归因时才不会记到 agent 头上。
      if (providerUnavailable && strategy === "RETRY") {
        await this.failWorkflow(
          workflow.id,
          "WORKFLOW_TASK_FAILED",
          `Model provider unavailable; ${task.taskKey} could not be retried (` +
            `${workflow.policy.allowRetry ? "retry budget exhausted" : "retry disabled"})`
        );
        return;
      }

      if (
        strategy === "ROLLBACK" &&
        task.type === "DEPLOY" &&
        DeliveryTaskSchema.safeParse(task.input.delivery).success
      ) {
        await this.rollback(workflow, task);
        continue;
      }

      // failureRouter 显式返回 REPLAN 时（切片自治 / 门禁修复），即使工作流仍是旧的
      // FAIL_FAST + allowReplan=false，也要进入修复链——否则真实任务重试永远卡在「审批不通过」。
      const replanAuthorized =
        workflow.policy.allowReplan || routed?.strategy === "REPLAN";
      const replanBudget = Math.max(workflow.policy.maxRetries, routed?.strategy === "REPLAN" ? 2 : 0);
      const profile = this.options.profile ?? DEFAULT_CAPABILITY_PROFILE;
      const recommendedFix =
        (isProfileAllowedRepairType(task.output?.fixTaskType, profile)
          ? task.output?.fixTaskType
          : undefined) ??
        (typeof routed?.fixTaskType === "string" ? routed.fixTaskType : undefined);
      const typeSwitchAvailable =
        isProfileAllowedRepairType(recommendedFix, profile) &&
        recommendedFix !== task.type &&
        task.input?.typeSwitchUsed !== true &&
        (task.output?.errorType === "REPLAN_REQUESTED" ||
          typeof task.output?.fixTaskType === "string" ||
          typeof routed?.fixTaskType === "string");
      const withinReplanBudget = asNumber(task.input.executionAttempt, 0) < replanBudget;
      if (
        strategy === "REPLAN" &&
        replanAuthorized &&
        (withinReplanBudget || typeSwitchAvailable)
      ) {
        // docs/253：自治 router 的 fixTaskType（如 DOCS_GAP→BUILD）优先于 agent 误报的 FRONTEND。
        const routedFix = routed?.fixTaskType;
        const taskForReplan =
          typeof routedFix === "string" && isProfileAllowedRepairType(routedFix, profile)
            ? {
                ...task,
                output: {
                  ...(task.output ?? {}),
                  fixTaskType: routedFix,
                  ...(routed?.failureClass ? { failureClass: routed.failureClass } : {})
                }
              }
            : task;
        await this.replan(workflow, taskForReplan);
        continue;
      }

      if (strategy === "CONTINUE") continue;
      // N-29（`docs/211`）方案 D：诊断任务失败时点明它的身份。批次归因里
      // 「Task failed: Diagnose Diagnose …」的**叠词**是嵌套的直接证据——别让读报告的人去猜。
      await this.failWorkflow(
        workflow.id,
        "WORKFLOW_TASK_FAILED",
        `Task failed: ${task.title}${task.type === "DEBUG" ? " (diagnosis task)" : ""}`
      );
      return;
    }
  }

  /**
   * Phase 5.7-5 human boundary: reuses the EXISTING approval entity and the
   * EXISTING WAITING_APPROVAL statuses (FAILED → RETRYING → WAITING_APPROVAL is
   * the frozen task state machine path). Approve → READY (re-run through the
   * full ToolRuntime / policy governance again); reject → FAILED → the router
   * terminates the workflow. No new approval state machine.
   */
  private async requestHumanIntervention(
    workflow: WorkflowRun,
    task: Task,
    reason: string,
    routed?: FailureRoute
  ): Promise<void> {
    const approval = await this.options.store.createApproval(workflow.id, task.id, reason);
    assertTaskTransition(task.status, "RETRYING");
    await this.options.store.updateTask(task.id, ["FAILED"], {
      status: "RETRYING",
      clearClaim: true
    });
    await this.options.store.updateTask(task.id, ["RETRYING"], {
      status: "WAITING_APPROVAL"
    });
    await this.event(
      workflow.id,
      "FAILURE_HUMAN_REQUIRED",
      {
        taskId: task.id,
        approvalId: approval.id,
        reason,
        ...(routed?.failureClass ? { failureClass: routed.failureClass } : {}),
        ...(routed?.stalled ? { stalled: true } : {})
      },
      task.id
    );
    const waiting = await this.options.store.updateWorkflow(workflow.id, ["RUNNING"], {
      status: "WAITING_APPROVAL"
    });
    if (waiting) {
      await this.event(
        workflow.id,
        "APPROVAL_REQUIRED",
        { approvalId: approval.id, taskId: task.id, reason },
        task.id
      );
      this.options.onChanged?.(workflow.id);
    }
  }

  /**
   * DEBUG 任务 SUCCESS（含 N-29 handoff）后：若依赖边上的兄弟 REPLAN 仍是 PENDING/READY，
   * 且类型与诊断给出的 fixTaskType 不一致，则就地改成该类型（并改标题），避免再跑一轮
   * 已判明无效的 TEST/源类型克隆。
   */
  private async retargetPendingReplansAfterDebug(
    workflow: WorkflowRun,
    debugTask: Task
  ): Promise<void> {
    const profile = this.options.profile ?? DEFAULT_CAPABILITY_PROFILE;
    const fix = debugTask.output?.fixTaskType;
    if (!isProfileAllowedRepairType(fix, profile)) return;
    if (DeliveryTaskSchema.safeParse(debugTask.input.delivery).success) return;

    const dependencies = await this.options.store.findDependencies(workflow.id);
    const tasks = await this.options.store.findTasks(workflow.id);
    const childIds = new Set(
      dependencies
        .filter(
          (dependency) =>
            dependency.active !== false && dependency.sourceTaskId === debugTask.id
        )
        .map((dependency) => dependency.targetTaskId)
    );
    for (const sibling of tasks) {
      if (!childIds.has(sibling.id)) continue;
      if (sibling.origin !== "DYNAMIC") continue;
      if (!sibling.taskKey.includes("-REPLAN-")) continue;
      if (sibling.status !== "PENDING" && sibling.status !== "READY") continue;
      if (sibling.type === fix) continue;

      const updated = await this.options.store.updateTask(sibling.id, [sibling.status], {
        type: fix,
        title: `Implement ${fix} fix for ${debugTask.taskKey}`,
        description:
          typeof debugTask.output?.summary === "string" && debugTask.output.summary.length > 0
            ? `Implement the diagnosed product fix as a ${fix} task: ${debugTask.output.summary}`
            : `Implement the diagnosed product fix as a ${fix} task.`,
        input: {
          ...sibling.input,
          targetTaskType: fix,
          typeSwitchUsed: true,
          typeSwitchFrom: sibling.type
        }
      });
      if (updated) {
        await this.event(
          workflow.id,
          "REPLAN_TYPE_RETARGETED",
          {
            debugTaskId: debugTask.id,
            debugTaskKey: debugTask.taskKey,
            replanTaskId: sibling.id,
            replanTaskKey: sibling.taskKey,
            fromType: sibling.type,
            toType: fix
          },
          sibling.id
        );
      }
    }
  }

  /**
   * taskflow-vue v9：源任务 RETRYING/SUCCESS 后，耗尽的 REPLAN 叶子若仍握着指向下游的
   * DYNAMIC 出边、而源→下游边已 inactive，则下游会被永远 BLOCKED / 触发 WORKFLOW_DEADLOCK。
   * 这里把 stale REPLAN 出边卸掉、把源出边重新点亮，并把因此卡住的 BLOCKED 下游收回 PENDING。
   */
  private async restoreSupersededReplanDownstream(
    workflowId: string,
    onlySourceId?: string
  ): Promise<void> {
    let tasks = await this.options.store.findTasks(workflowId);
    let dependencies = await this.options.store.findDependencies(workflowId);
    const candidates = tasks.filter(
      (task) =>
        (task.status === "SUCCESS" || task.status === "RETRYING") &&
        Boolean(task.resolvedByTaskId) &&
        (onlySourceId === undefined || task.id === onlySourceId)
    );
    for (const source of candidates) {
      const plan = planSupersededReplanEdgeRestore(source, tasks, dependencies);
      if (plan.deactivateIds.length === 0 && plan.reactivateIds.length === 0) {
        continue;
      }
      const updates = [
        ...plan.deactivateIds.map((id) => ({ id, active: false })),
        ...plan.reactivateIds.map((id) => ({ id, active: true }))
      ];
      await this.options.store.setDependenciesActive(workflowId, updates);
      for (const targetId of plan.unblockTargetIds) {
        const target = tasks.find((entry) => entry.id === targetId);
        if (!target || target.status !== "BLOCKED") continue;
        assertTaskTransition(target.status, "PENDING");
        const updated = await this.options.store.updateTask(target.id, ["BLOCKED"], {
          status: "PENDING"
        });
        if (updated) {
          await this.event(
            workflowId,
            "TASK_RETRY_REQUESTED",
            { taskId: target.id, taskKey: target.taskKey, from: "BLOCKED", reason: "replan-downstream-restored" },
            target.id
          );
        }
      }
      await this.event(
        workflowId,
        "REPLAN_DOWNSTREAM_RESTORED",
        {
          sourceTaskId: source.id,
          sourceTaskKey: source.taskKey,
          deactivatedDependencyIds: plan.deactivateIds,
          reactivatedDependencyIds: plan.reactivateIds,
          unblockedTaskIds: plan.unblockTargetIds
        },
        source.id
      );
      tasks = await this.options.store.findTasks(workflowId);
      dependencies = await this.options.store.findDependencies(workflowId);
    }
  }

  private async replan(workflow: WorkflowRun, source: Task): Promise<void> {
    await this.event(workflow.id, "REPLAN_STARTED", { sourceTaskId: source.id }, source.id);
    const tasks = await this.options.store.findTasks(workflow.id);
    // 人工 retry 后再 replan 时，源任务可能仍挂着上一轮 REPLAN 链的 resolvedBy。
    // 新链成功后必须把旧链末梢接到新修复任务，否则旧 FAILED 行继续挡终局（v9）。
    const previousResolverId = source.resolvedByTaskId;
    const dependencies = await this.options.store.findDependencies(workflow.id);
    const predecessors = dependencies.filter(
      (dependency) => dependency.active !== false && dependency.targetTaskId === source.id
    );
    const downstream = dependencies.filter(
      (dependency) => dependency.active !== false && dependency.sourceTaskId === source.id
    );
    const retryId = randomUUID();
    const profile = this.options.profile ?? DEFAULT_CAPABILITY_PROFILE;
    const deliveryOrchestrated = DeliveryTaskSchema.safeParse(source.input.delivery).success;
    const workType = fixWorkTargetType(source, tasks, profile);
    const resolved = resolveReplanRetryType(source, workType, profile, deliveryOrchestrated);
    const target = debugTargetType(source, workType, profile);
    // 类型切换宽限：诊断/REPLAN_REQUESTED 已点名另一类任务时，新任务从 attempt=1 起算，
    // 并标记 typeSwitchUsed，避免 TEST 预算耗尽后无法开出 FRONTEND。
    const explicitFix = source.output?.fixTaskType;
    const switchingType =
      isProfileAllowedRepairType(explicitFix, profile) &&
      explicitFix !== source.type &&
      !deliveryOrchestrated;
    const priorAttempt = asNumber(source.input.executionAttempt, source.retryCount);
    // taskKey：挂回计划根（T-08），生成 T-08-REPLAN-N，禁止 T-08-REPLAN-1-REPLAN-2 嵌套。
    // 扫描同根家族已有后缀，避免 retry 后与旧行撞唯一索引；预算计数仍跟 priorAttempt。
    const rootKey = replanRootTaskKey(source.taskKey);
    const keyAttempt = nextReplanKeyAttempt(rootKey, tasks, priorAttempt);
    const attempt = priorAttempt + 1;
    const reason = `Re-plan after task failure: ${rootKey}`;
    // DEBUG×DEPLOY（F1 round17）：交付链由 DeliveryOrchestrator 执行；若 DEBUG 目标仍是
    // DEPLOY/BUILD 等交付类型，AgentRegistry 无承接 agent ⇒ 诊断瞬失败、交付重试永远走不到。
    // PL-M28 / 门禁 P1（docs/210 方案 A）：把「谁来修」(派发键) 与「重跑什么」(契约键) 拆开——
    // 交付源的 retry **保住源交付类型**（N-23）；若失败任务给出合法 fixTaskType（如矛盾期望门禁
    // → TEST），则派 DEBUG(target=fixTaskType) 先改测，再重跑同契约 CI/DEPLOY。两键相同时
    // （无独立修复类型）行为与 DEBUG×DEPLOY 一致：跳过 DEBUG，只造同契约 retry。
    //
    // taskflow-vue v8：非交付源若已给出能力面允许的 fixTaskType（含 DEBUG 交接 / TEST 的
    // REPLAN_REQUESTED），直接开该类型修复任务，不再先造「克隆源类型」的 REPLAN，也不再
    // 叠一层 Diagnose（诊断已经说完该谁修）。
    const retryType: Task["type"] = resolved.type;
    const repairType: Task["type"] = isProfileAllowedRepairType(explicitFix, profile)
      ? explicitFix
      : isProfileAllowedRepairType(target.type, profile)
        ? target.type
        : retryType;
    const knownRepairType = isProfileAllowedRepairType(explicitFix, profile);
    const spawnDebug =
      isUsableTargetTaskType(repairType) &&
      (deliveryOrchestrated
        ? repairType !== retryType
        : source.type !== "DEBUG" && !knownRepairType);
    const debugId = spawnDebug ? randomUUID() : undefined;

    const officialHint = extractOfficialGateFailureHint(source.output?.verification);
    const officialFingerprint = extractOfficialEvidenceFingerprint(source.output?.verification);


    const retryTask = {
      id: retryId,
      workflowRunId: workflow.id,
      projectId: workflow.projectId,
      requirementId: workflow.requirementId,
      planTaskId: source.planTaskId,
      taskKey: `${rootKey}-REPLAN-${keyAttempt}`,
      title: replanTaskTitle(
        source,
        retryType,
        resolved.usedExplicitFix || source.type === "DEBUG",
        rootKey,
        keyAttempt
      ),
      description: withOfficialFailedGateBriefing(
        replanTaskDescription(
          source,
          retryType,
          resolved.usedExplicitFix || source.type === "DEBUG"
        ),
        source.output?.verification
      ),
      // PL-M18（N-11）+ PL-M28 + v8 fixTaskType：非交付源用解析后的修复类型；交付源用契约键。
      type: retryType,
      priority: source.priority,
      input: {
        ...source.input,
        executionAttempt: switchingType ? 1 : attempt,
        ...(switchingType ? { typeSwitchUsed: true, typeSwitchFrom: source.type } : {}),
        ...(resolved.usedExplicitFix || source.type === "DEBUG"
          ? { targetTaskType: retryType }
          : {}),
        // docs/252：把源失败类带进修复任务，供 skillResolver 声明式注入。
        ...(typeof source.output?.failureClass === "string" && source.output.failureClass.length > 0
          ? { failureClass: source.output.failureClass }
          : typeof source.input?.failureClass === "string" && source.input.failureClass.length > 0
            ? { failureClass: source.input.failureClass }
            : {}),
        // docs/258：官方门禁失败的 AC 并入修复任务，且排在源任务声明之前。
        ...(officialHint && officialHint.acKeys.length > 0
          ? { acKeys: mergeAcKeys(source.input?.acKeys, officialHint.acKeys) }
          : {}),
        // docs/262：把本轮官方失败指纹交给下一轮，避免同证据同类型再空烧一轮。
        ...(officialFingerprint ? { priorOfficialEvidence: officialFingerprint } : {})
      },
      sourceTaskId: source.id,
      creationReason: reason,
      approvalRequired: false
    };

    const plan: ReplanInput = spawnDebug
      ? {
          workflowRunId: workflow.id,
          sourceTaskId: source.id,
          resolvedByTaskId: retryId,
          deactivateDependencyIds: downstream.map((dependency) => dependency.id),
          tasks: [
            {
              id: debugId!,
              workflowRunId: workflow.id,
              projectId: workflow.projectId,
              requirementId: workflow.requirementId,
              taskKey: `${rootKey}-DEBUG-${keyAttempt}`,
              title: `Diagnose ${rootKey} (attempt ${keyAttempt})`,
              description: `Diagnose the failure before retrying ${rootKey}.`,
              type: "DEBUG",
              priority: source.priority,
              input: {
                sourceTaskId: source.id,
                // PL-M28：派发键 = 谁来修（合法 fixTaskType），不是契约键。
                targetTaskType: repairType,
                execution: Array.isArray(source.output?.fixSteps)
                  ? { deepAgentSteps: source.output.fixSteps }
                  : {},
                executionAttempt: attempt,
                ...(typeof source.output?.failureClass === "string" &&
                source.output.failureClass.length > 0
                  ? { failureClass: source.output.failureClass }
                  : {})
              },
              sourceTaskId: source.id,
              creationReason: reason,
              approvalRequired: false
            },
            retryTask
          ],
          dependencies: [
            ...predecessors.map((dependency) => ({
              sourceTaskId: dependency.sourceTaskId,
              targetTaskId: debugId!
            })),
            { sourceTaskId: debugId!, targetTaskId: retryId },
            ...downstream.map((dependency) => ({
              sourceTaskId: retryId,
              targetTaskId: dependency.targetTaskId
            }))
          ]
        }
      : {
          workflowRunId: workflow.id,
          sourceTaskId: source.id,
          resolvedByTaskId: retryId,
          deactivateDependencyIds: downstream.map((dependency) => dependency.id),
          tasks: [retryTask],
          dependencies: [
            ...predecessors.map((dependency) => ({
              sourceTaskId: dependency.sourceTaskId,
              targetTaskId: retryId
            })),
            ...downstream.map((dependency) => ({
              sourceTaskId: retryId,
              targetTaskId: dependency.targetTaskId
            }))
          ]
        };

    const newTaskIds = spawnDebug ? [debugId!, retryId] : [retryId];
    const graphDependencies = [
      ...dependencies
        .filter(
          (dependency) =>
            dependency.active !== false && !plan.deactivateDependencyIds.includes(dependency.id)
        )
        .map((dependency) => ({
          sourceTaskId: dependency.sourceTaskId,
          targetTaskId: dependency.targetTaskId
        })),
      ...plan.dependencies
    ];
    const errors = validateWorkflowGraph(
      [...tasks.map((task) => task.id), ...newTaskIds],
      graphDependencies
    );
    if (errors.length > 0) {
      await this.failWorkflow(workflow.id, "REPLAN_VALIDATION_ERROR", errors.join("; "));
      return;
    }
    try {
      await this.options.store.applyReplan(plan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.event(
        workflow.id,
        "REPLAN_FAILED",
        { sourceTaskId: source.id, sourceTaskKey: source.taskKey, error: message },
        source.id
      );
      await this.failWorkflow(workflow.id, "REPLAN_APPLY_ERROR", message);
      return;
    }
    if (previousResolverId && previousResolverId !== retryId) {
      const byId = new Map(tasks.map((entry) => [entry.id, entry]));
      const seen = new Set<string>();
      let tipId: string | undefined = previousResolverId;
      while (tipId && !seen.has(tipId)) {
        seen.add(tipId);
        const hop = byId.get(tipId);
        if (!hop?.resolvedByTaskId || hop.resolvedByTaskId === retryId) break;
        tipId = hop.resolvedByTaskId;
      }
      const tip = tipId ? byId.get(tipId) : undefined;
      if (tip && tip.id !== retryId) {
        const retired = await this.options.store.updateTask(tip.id, [tip.status], {
          resolvedByTaskId: retryId
        });
        if (retired) {
          const tipOuts = dependencies.filter(
            (dependency) =>
              dependency.active !== false && dependency.sourceTaskId === tip.id
          );
          if (tipOuts.length > 0) {
            await this.options.store.setDependenciesActive(
              workflow.id,
              tipOuts.map((dependency) => ({ id: dependency.id, active: false }))
            );
          }
          await this.event(
            workflow.id,
            "REPLAN_SUPERSEDED_PRIOR_CHAIN",
            {
              sourceTaskId: source.id,
              sourceTaskKey: source.taskKey,
              priorTipTaskId: tip.id,
              priorTipTaskKey: tip.taskKey,
              resolvedByTaskId: retryId,
              deactivatedOutbound: tipOuts.map((dependency) => dependency.id)
            },
            tip.id
          );
        }
      }
    }
    if (spawnDebug && debugId) {
      await this.event(
        workflow.id,
        "TASK_CREATED",
        { taskId: debugId, sourceTaskId: source.id, reason },
        debugId
      );
    }
    if (target.rejectedFixTaskType || resolved.rejectedFixTaskType) {
      // PL-M3：agent 给的 `fixTaskType` 不可用，已回退——记事件说明回退原因（不回显原始值）。
      await this.event(
        workflow.id,
        "DEBUG_TARGET_TYPE_FALLBACK",
        {
          sourceTaskId: source.id,
          sourceTaskKey: source.taskKey,
          ...(debugId ? { debugTaskId: debugId } : { retryTaskId: retryId }),
          fallbackTaskType: retryType,
          reason: "fixTaskType is not a usable task type"
        },
        debugId ?? retryId
      );
    }
    if (!spawnDebug) {
      await this.event(
        workflow.id,
        "REPLAN_DEBUG_SKIPPED",
        {
          sourceTaskId: source.id,
          sourceTaskKey: source.taskKey,
          retryTaskId: retryId,
          reason: deliveryOrchestrated
            ? repairType === retryType
              ? "delivery tasks are executed by DeliveryOrchestrator; no distinct fixTaskType for repair"
              : "delivery tasks are executed by DeliveryOrchestrator; DEBUG has no professional agent"
            : knownRepairType
              ? "explicit fixTaskType already names the repair task type; skipping redundant DEBUG"
              : source.type === "DEBUG"
                ? "source is already DEBUG; creating repair task directly"
                : "DEBUG target task type is missing or unusable"
        },
        source.id
      );
    }
    await this.event(
      workflow.id,
      "TASK_CREATED",
      { taskId: retryId, sourceTaskId: source.id, reason },
      retryId
    );
    await this.event(
      workflow.id,
      "REPLAN_COMPLETED",
      {
        sourceTaskId: source.id,
        dynamicTaskIds: newTaskIds
      },
      source.id
    );
  }

  private async rollback(workflow: WorkflowRun, source: Task): Promise<void> {
    const delivery = DeliveryTaskSchema.parse(source.input.delivery);
    if (!delivery.environment || delivery.action !== "DEPLOY") {
      await this.failWorkflow(
        workflow.id,
        "ROLLBACK_NOT_SUPPORTED",
        "Only failed deployment tasks can be rolled back"
      );
      return;
    }
    const tasks = await this.options.store.findTasks(workflow.id);
    const dependencies = await this.options.store.findDependencies(workflow.id);
    const downstream = dependencies.filter(
      (dependency) => dependency.active !== false && dependency.sourceTaskId === source.id
    );
    const rollbackId = randomUUID();
    const reason = `Rollback after deployment failure: ${source.taskKey}`;
    const plan: ReplanInput = {
      workflowRunId: workflow.id,
      sourceTaskId: source.id,
      resolvedByTaskId: rollbackId,
      deactivateDependencyIds: downstream.map((dependency) => dependency.id),
      tasks: [
        {
          id: rollbackId,
          workflowRunId: workflow.id,
          projectId: workflow.projectId,
          requirementId: workflow.requirementId,
          taskKey: `${source.taskKey}-ROLLBACK`,
          title: `Rollback ${source.title}`,
          description: `Restore the previous successful ${delivery.environment} release.`,
          type: "DEPLOY",
          priority: "HIGH",
          input: {
            delivery: { ...delivery, action: "ROLLBACK" },
            rollbackDeploymentId: source.output?.deploymentId
          },
          sourceTaskId: source.id,
          creationReason: reason,
          approvalRequired: delivery.environment === "production"
        }
      ],
      dependencies: downstream.map((dependency) => ({
        sourceTaskId: rollbackId,
        targetTaskId: dependency.targetTaskId
      }))
    };
    const errors = validateWorkflowGraph(
      [...tasks.map((task) => task.id), rollbackId],
      [
        ...dependencies
          .filter(
            (dependency) =>
              dependency.active !== false && !plan.deactivateDependencyIds.includes(dependency.id)
          )
          .map((dependency) => ({
            sourceTaskId: dependency.sourceTaskId,
            targetTaskId: dependency.targetTaskId
          })),
        ...plan.dependencies
      ]
    );
    if (errors.length > 0) {
      await this.failWorkflow(workflow.id, "ROLLBACK_VALIDATION_ERROR", errors.join("; "));
      return;
    }
    await this.options.store.applyReplan(plan);
    await this.event(
      workflow.id,
      "ROLLBACK_TASK_CREATED",
      { taskId: rollbackId, sourceTaskId: source.id, environment: delivery.environment },
      rollbackId
    );
    // L1-6：自动回滚是**策略决策**，另记一条。契约要求指明被回滚的那个部署——拿不到
    // id 时不写（宁缺勿造一个假 uuid）。`rollbackDeploymentId` 留空：此刻回滚任务尚未
    // 执行，回滚产物还不存在。
    const rolledBackDeploymentId = source.output?.deploymentId;
    if (isAutonomyAtLeastL1(workflow.policy) && typeof rolledBackDeploymentId === "string") {
      await this.autonomyDecision(
        workflow.id,
        "AUTO_ROLLED_BACK",
        {
          policyId: "L1",
          reason: `L1 policy: automatic rollback after ${source.taskKey} deployment failure`,
          workflowRunId: workflow.id,
          taskId: source.id,
          environment: delivery.environment,
          deploymentId: rolledBackDeploymentId
        },
        source.id
      );
    }
  }

  private async failWorkflow(id: string, code: string, message: string): Promise<void> {
    const updated = await this.options.store.updateWorkflow(id, ["RUNNING", "WAITING_APPROVAL"], {
      status: "FAILED",
      error: errorBody(code, message),
      finishedAt: new Date().toISOString()
    });
    if (updated) {
      await this.event(id, "WORKFLOW_FAILED", { code, message });
      this.options.onTerminal?.(id, "FAILED");
    }
  }

  private async requiredWorkflow(id: string): Promise<WorkflowRun> {
    const workflow = await this.options.store.findWorkflowById(id);
    if (!workflow) throw new Error("Workflow not found");
    return workflow;
  }

  private async event(
    workflowRunId: string,
    eventType: string,
    payload: JsonObject,
    taskId?: string,
    agentRunId?: string
  ): Promise<void> {
    await this.options.store.createEvent({ workflowRunId, taskId, agentRunId, eventType, payload });
    this.options.onChanged?.(workflowRunId);
  }

  /**
   * L1-6：写一条自治决策事件。
   *
   * 形状由 `docs/152` 的契约类型在**编译期**约束（`AutonomyDecisionPayload`），**不做运行期
   * 校验**：观测路径不得因契约问题让工作流失败（`docs/147` §7「观测只读」）。契约的
   * 运行期一致性由测试断言 `parseAutonomyDecisionPayload` 通过来保证。调用点全部在
   * `isAutonomyAtLeastL1` 之下。
   */
  private async autonomyDecision(
    workflowRunId: string,
    eventType: AutonomyDecisionEventType,
    payload: AutonomyDecisionPayload,
    taskId: string
  ): Promise<void> {
    await this.event(workflowRunId, eventType, payload, taskId);
  }
}
