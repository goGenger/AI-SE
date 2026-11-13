import { join } from "node:path";
import {
  EvalFailure,
  EvalFixture,
  EvalPolicy,
  EvalRunRecord,
  PlanningMetricsSnapshot,
  StagingSegmentView
} from "./types";
import { CommandRunner, runOracle } from "./oracle";

export interface HttpDeps {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  /** N-73：PUT（交付环境 upsert 需要）。缺省时可省略——不声明交付环境的夹具用不到。 */
  put?(path: string, body?: unknown): Promise<unknown>;
  del(path: string): Promise<void>;
}

export interface HarnessDeps {
  http: HttpDeps;
  commands: CommandRunner;
  baseUrl: string;
  policy: EvalPolicy;
  packageDir: string;
  log(message: string): void;
  sleep(ms: number): Promise<void>;
  prepareWorkspace(fixture: EvalFixture, runIndex: number): Promise<string>;
}

export interface RunOptions {
  runs: number;
  replan: boolean;
  /**
   * 单切片预算的**下界**。N-60（`docs/232` §10）之后它不再是无条件上限——
   * 实际预算是 `max(runTimeoutMs, 任务数 × perTaskTimeoutMs)`。
   */
  runTimeoutMs: number;
  /**
   * N-60（`docs/232` §10，用户 2026-10-29 裁定「按任务计时」）：每个任务分到的预算。
   *
   * 为什么不能只按切片计时：REPLAN/DEBUG 会**动态派生**新任务，一个切片可能从 7 个任务长到
   * 21 个，而固定的 90 分钟与任务数无关。实测（F1 第二轮）slice-1 用 7 个任务 28 分钟轻松过，
   * slice-2 派生到 21 个任务、92 分钟撞满上限被切断——切断位置由「这片刻苦不刻苦」决定，
   * 而不是由「它还有多少活没干」决定。
   *
   * 缺省 8 分钟/任务（N-63：6 分钟在任务数 ≥15 时等于没有余量）。
   */
  perTaskTimeoutMs?: number;
  pollIntervalMs: number;
  oracleTimeoutMs: number;
}

/**
 * N-60：每任务预算的缺省值。
 *
 * N-63（`docs/232` §10，用户 2026-11-01 裁定「按 8 分钟改」）：**6 → 8 分钟**。
 * 6 分钟没有余量——切片任务数 ≥15 时 `taskCount × 6min` 恰好等于 90 分钟下界，
 * 「预算随任务数增长」退化成固定 90 分钟，于是任务更重、失败更少的切片反而先被切断
 * （第四轮 slice-4：15 个任务、12 成功 / 0 失败 / 3 未完成）。8 分钟覆盖了全批观测值
 * （最高 6.2 min/task），并让 15 个任务的预算抬到 120 分钟。
 */
export const DEFAULT_PER_TASK_TIMEOUT_MS = 8 * 60 * 1000;
/**
 * N-60（`docs/232` §10，用户 2026-10-29 裁定「按任务计时」）：**单切片预算的唯一计算处**。
 *
 * `预算 = max(runTimeoutMs, 任务数 × perTaskTimeoutMs)`
 *
 * - `runTimeoutMs` 退化为**下界**：小切片（任务少）的行为与改动前完全一致；
 * - 任务多时按任务数放大：REPLAN/DEBUG 每派生一个任务就多一份预算。
 *
 * 为什么要按任务数：实测 F1 第二轮 slice-1（7 个任务）28 分钟轻松过，slice-2 派生到 21 个
 * 任务后 92 分钟撞满固定 90 分钟上限。固定墙钟把「这片刻苦不刻苦」当成了判据，而真正该问的是
 * 「它还有多少活没干」。
 */
export function workflowBudgetMs(
  taskCount: number,
  runTimeoutMs: number,
  perTaskTimeoutMs: number
): number {
  return Math.max(runTimeoutMs, taskCount * perTaskTimeoutMs);
}

const TERMINAL_WORKFLOW = new Set(["SUCCESS", "FAILED", "CANCELLED"]);
const PROJECT_PREFIX = "[eval] ";

/** 解包 API 信封 {success,data}；失败抛错。 */
export function unwrap<T>(payload: unknown, path: string): T {
  const envelope = payload as { success?: boolean; data?: T; error?: { message?: string } };
  if (envelope && envelope.success === false) {
    throw new Error(`${path} 失败：${envelope.error?.message ?? "unknown error"}`);
  }
  if (envelope && envelope.success === true) return envelope.data as T;
  return payload as T;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const items = (value as { items?: unknown[] } | null)?.items;
  return Array.isArray(items) ? items : [];
}

export function collectTaskMetrics(
  tasks: Array<{
    id?: string;
    status: string;
    /**
     * N-56：失败被哪个任务解决（replan / 自愈链）。与 `@ai-se/workflow-engine` 的
     * `isFailureResolved` 同一语义；eval 不依赖该包，故在此实现同形判定（见 `isResolvedBySuccessor`）。
     */
    resolvedByTaskId?: string | null;
    output?: unknown;
  }>
): {
  taskStatuses: Record<string, number>;
  parseRecoveryRuns: number;
  errorTypes: Record<string, number>;
  reportedSuccess: boolean;
} {
  const taskStatuses: Record<string, number> = {};
  const errorTypes: Record<string, number> = {};
  let parseRecoveryRuns = 0;
  let notSucceeded = 0;
  const byId = new Map<string, { status: string; resolvedByTaskId?: string | null }>();
  for (const task of tasks) {
    if (typeof task.id === "string") byId.set(task.id, task);
  }
  for (const task of tasks) {
    taskStatuses[task.status] = (taskStatuses[task.status] ?? 0) + 1;
    if (task.status !== "SUCCESS" && !isResolvedBySuccessor(task, byId)) notSucceeded += 1;
    const output = (task.output ?? {}) as Record<string, unknown>;
    if (typeof output.parseRecovery === "string" && output.parseRecovery !== "") {
      parseRecoveryRuns += 1;
    }
    if (typeof output.errorType === "string" && output.errorType !== "") {
      errorTypes[output.errorType] = (errorTypes[output.errorType] ?? 0) + 1;
    }
  }
  // 自报成功＝平台把**全部有效**任务判为 SUCCESS（有 RUNNING/未解决的 FAILED 一律不算成功）。
  //
  // N-56（`docs/232` §9.29）：**被后继成功任务解决掉的失败祖先不计入**。第十二次回归里
  // `T-001` / `T4-readme-contract-test` / `T6` 三行 FAILED 全部由 `*-REPLAN-1` 成功替代，五个切片
  // 全 DONE、交付链 100%，旧口径却报「自报成功率 0%」——它把已经恢复的历史行当成了当前状态。
  const reportedSuccess = tasks.length > 0 && notSucceeded === 0;
  return { taskStatuses, parseRecoveryRuns, errorTypes, reportedSuccess };
}

/**
 * N-56：失败是否被**后继成功任务**解决（可跨多跳，与 `workflow-engine` 的 `isFailureResolved` 同形）。
 * 只沿 `resolvedByTaskId` 走；解析器缺失或链断在未成功处都不算解决。
 */
function isResolvedBySuccessor(
  task: { status: string; resolvedByTaskId?: string | null },
  byId: ReadonlyMap<string, { status: string; resolvedByTaskId?: string | null }>
): boolean {
  if (task.status === "SUCCESS") return false;
  const seen = new Set<string>();
  let next = task.resolvedByTaskId ?? null;
  while (next !== null && !seen.has(next)) {
    seen.add(next);
    const resolver = byId.get(next);
    if (!resolver) return false;
    if (resolver.status === "SUCCESS") return true;
    next = resolver.resolvedByTaskId ?? null;
  }
  return false;
}

export function countHumanInterventions(events: Array<{ eventType?: string }>): number {
  return events.filter((event) => {
    const type = event.eventType ?? "";
    return (
      type === "FAILURE_HUMAN_REQUIRED" ||
      type.startsWith("approval_") ||
      type === "APPROVAL_REQUESTED"
    );
  }).length;
}

/**
 * F1-8（FX-26）冻结口径：链完成与最远切片。
 * - 两级（有切片）：链完成 = **全部切片 DONE**；最远切片 = 最后一个非 PENDING 的切片。
 * - 单级（无切片）：链完成 = 全部执行工作流 SUCCESS；最远切片 = null。
 */
/**
 * N-59（`docs/232` §10）：本轮耗时的**唯一计算处**。
 *
 * 旧实现只累加同时有 `startedAt` 与 `finishedAt` 的工作流，于是被 `runTimeoutMs` 切断的切片
 * 被整片丢弃——F1 第二轮记 28 分钟，实际 120 分钟（低报 4.3 倍）。
 *
 * 两条规则：
 * 1. 没有 `finishedAt` 的工作流按「now − startedAt」计入，并计入 `incomplete`；
 * 2. 结果**不小于批次墙钟**（`now − runStartedAt`）——各片之和不可能是本轮真实耗时的下界。
 */
export function collectDurationMetrics(
  workflows: Array<{ startedAt?: string; finishedAt?: string }>,
  runStartedAt: number,
  nowMs: number
): { durationMs: number; incomplete: number } {
  let durationMs = 0;
  let incomplete = 0;
  for (const workflow of workflows) {
    const startedAt = workflow.startedAt ? Date.parse(workflow.startedAt) : NaN;
    if (!Number.isFinite(startedAt)) continue;
    const finishedAt = workflow.finishedAt ? Date.parse(workflow.finishedAt) : NaN;
    if (Number.isFinite(finishedAt)) {
      durationMs += finishedAt - startedAt;
    } else {
      durationMs += Math.max(0, nowMs - startedAt);
      incomplete += 1;
    }
  }
  return { durationMs: Math.max(durationMs, Math.max(0, nowMs - runStartedAt)), incomplete };
}

export function collectChainMetrics(
  slices: SliceView[],
  workflowStatuses: string[]
): { chainCompleted: boolean; sliceReached: string | null } {
  if (slices.length === 0) {
    return {
      chainCompleted:
        workflowStatuses.length > 0 && workflowStatuses.every((status) => status === "SUCCESS"),
      sliceReached: null
    };
  }
  let reachedIndex = -1;
  slices.forEach((slice, index) => {
    if (slice.status !== "PENDING") reachedIndex = index;
  });
  return {
    chainCompleted: slices.every((slice) => slice.status === "DONE"),
    sliceReached: reachedIndex >= 0 ? slices[reachedIndex].sliceKey : null
  };
}

/**
 * N-16（`docs/189` §4.4）：把需求切片视图限定到**本次 run 实际驱动过的工作流**。
 *
 * `requirement_slices` 是按**需求（计划版本）**存的，一批多个 run 共用同一份；run 1 把 S2
 * 置成 FAILED 之后，run 2 / run 3 从未创建过 S2 工作流，却因 `sliceReached` 的定义
 * （「最后一个非 PENDING 的切片」）被记成「到达 S2」。库内真相是 run 1 → S2、run 2 → S1、
 * run 3 → S1。`chainCompleted` 同病。
 *
 * 判据取自 harness 自己产出的 `executed`（`sliceKey` + `workflowId`），**不依赖服务端是否
 * 回填 `requirement_slices.workflow_run_id`**：本次 run 没驱动过的切片一律按 PENDING 计。
 * 只改读取面——数据模型与写入路径一律不动。
 */
export function scopeSlicesToRun(
  slices: SliceView[],
  executedSliceKeys: readonly (string | null)[]
): SliceView[] {
  const reached = new Set(executedSliceKeys.filter((key): key is string => key !== null));
  return slices.map((slice) =>
    reached.has(slice.sliceKey) ? slice : { ...slice, status: "PENDING" }
  );
}

/**
 * L1-8（`docs/154` §3 M4）：staging 段交付判据 = CI 成功 ∧ staging DEPLOY 成功 ∧ staging VERIFY 成功。
 *
 * 只看任务终态，**不采信任务自报**（`output`），也**不读部署记录**——三段都是工作流任务，
 * 单一读取面即可判定。任务集是本次运行全部切片工作流的并集（最终切片的交付链在其中）。
 */
export function collectStagingSegment(tasks: DeliveryCapableTask[]): StagingSegmentView {
  const statusOf = (
    match: (delivery: { action?: string; environment?: string }) => boolean
  ): string | null => {
    const matches = tasks.filter((task) => {
      const delivery = task.input?.delivery;
      return delivery !== undefined && match(delivery);
    });
    if (matches.length === 0) return null;
    // N-36（`docs/146`）：取**最终一次**尝试，不是第一条。
    //
    // 交付任务失败后会被 replan 成另一行任务（`T-10` FAILED → `T-10-REPLAN-1` SUCCESS），
    // 而 `tasks` 是各切片工作流任务数组的拼接、**未按时间排序**。原先的 `tasks.find(...)`
    // 因此读到**原始那条 FAILED**，把「已被重试救回」的段判成失败——`l1-m4u` run 2 就是这样：
    // CI 失败 → 诊断 → 重跑成功 → 才部署 → VERIFY 成功，链完成、oracle 通过，而 staging 段记 0。
    // 与 N-35 同族（都源于「replan 之后源任务行永远是 FAILED」）。
    //
    // 排序用 `createdAt`（ISO 串可直接字典序比较）；缺失时间戳时退回数组顺序（末位为最终）。
    const ordered = matches
      .map((task, index) => ({ task, index }))
      .sort((left, right) => {
        const a = left.task.createdAt ?? "";
        const b = right.task.createdAt ?? "";
        if (a === b) return left.index - right.index;
        return a < b ? -1 : 1;
      });
    return ordered[ordered.length - 1].task.status;
  };
  const ci = statusOf((delivery) => delivery.action === "CI");
  const deploy = statusOf(
    (delivery) => delivery.action === "DEPLOY" && delivery.environment === "staging"
  );
  const verify = statusOf(
    (delivery) => delivery.action === "VERIFY" && delivery.environment === "staging"
  );
  return {
    ci,
    deploy,
    verify,
    delivered: ci === "SUCCESS" && deploy === "SUCCESS" && verify === "SUCCESS"
  };
}

/**
 * F1-8（FX-26）：任务级验证分歧（自报成功后验证 FAIL 的任务数）与验证门失败码分布。
 * PL-M9 9a（`docs/166` §3）：另计**检查不可判定**的任务数——`verification.missingChecks` 非空，
 * 即本类型有候选检查、但工作区缺对应 script（一条检查都没跑）。此前这类任务与「本类型没有客观检查」
 * 共用 `unavailable` 且不进任何计数，故「红灯检查整片缺席」在批次层面不可见。
 */
export function collectVerificationMetrics(tasks: Array<{ status: string; output?: unknown }>): {
  taskVerificationDivergence: number;
  verificationFailureCodes: Record<string, number>;
  /** PL-M9 9a：检查不可判定的任务数（本类型有候选检查、但工作区缺 script）。 */
  verificationUnavailable: number;
  verificationUnavailableByType: Record<string, number>;
} {
  let taskVerificationDivergence = 0;
  let verificationUnavailable = 0;
  const verificationFailureCodes: Record<string, number> = {};
  const verificationUnavailableByType: Record<string, number> = {};
  for (const task of tasks) {
    const output = (task.output ?? {}) as Record<string, unknown>;
    const verification = (output.verification ?? {}) as Record<string, unknown>;
    if (verification.verdict === "failed") taskVerificationDivergence += 1;
    if (Array.isArray(verification.missingChecks) && verification.missingChecks.length > 0) {
      verificationUnavailable += 1;
      const type = typeof verification.taskType === "string" ? verification.taskType : "UNKNOWN";
      verificationUnavailableByType[type] = (verificationUnavailableByType[type] ?? 0) + 1;
    }
    const sources: unknown[] = [verification.failureCode];
    if (Array.isArray(verification.checks)) {
      for (const check of verification.checks) {
        if (check && typeof check === "object") {
          sources.push((check as Record<string, unknown>).failureCode);
        }
      }
    }
    for (const code of sources) {
      if (typeof code === "string" && code !== "") {
        verificationFailureCodes[code] = (verificationFailureCodes[code] ?? 0) + 1;
      }
    }
  }
  return {
    taskVerificationDivergence,
    verificationFailureCodes,
    verificationUnavailable,
    verificationUnavailableByType
  };
}

/** F1-8（FX-26）：失败分层映射——规划 / 验证门 / agent 级。 */
export function classifyFailureLayer(code: string): "planning" | "verification" | "agent" {
  if (/^(VERIFICATION_FAILED|VACUOUS_TEST|EVIDENCE_MISSING)$/.test(code)) {
    return "verification";
  }
  if (
    /^(PLANNING|SLICE_PLANNING|PLAN_|FINAL_SLICE|GLOBAL_AC|DELIVERY_TASK|DELIVERY_ENVIRONMENT|AC_KEYS|AC_PROTECTION|VALIDATION_ERROR)/.test(
      code
    )
  ) {
    return "planning";
  }
  return "agent";
}

/** F1-8（FX-26）：失败分布按层（任务/运行错误码 + 规划事件错误码合并计数）。 */
export function collectFailureLayers(
  errorTypes: Record<string, number>,
  planningCodes: Record<string, number> = {}
): { planning: number; verification: number; agent: number } {
  const layers = { planning: 0, verification: 0, agent: 0 };
  const merged: Record<string, number> = { ...errorTypes };
  for (const [code, count] of Object.entries(planningCodes)) {
    merged[code] = (merged[code] ?? 0) + count;
  }
  for (const [code, count] of Object.entries(merged)) {
    layers[classifyFailureLayer(code)] += count;
  }
  return layers;
}

/**
 * F1-8（FX-26）：规划侧修复与收敛指标（事件面：规划 run 时间线）。
 * - 自动修复轮数 = `PLAN_AUTOFIXED` 计数；LLM 修复轮数 = `PLANNING_REPAIR_REQUESTED` 计数；
 * - 首轮通过 = 无 LLM 修复请求且无切片级校验失败；收敛 = 无终败事件（SLICE_PLANNING_FAILED /
 *   REQUIREMENT_ANALYSIS_FAILED）；
 * - 规划侧错误码分布 = 事件 payload.errorCode（如 DELIVERY_ENVIRONMENT_MISSING / PLANNING_ERROR）。
 */
export function collectPlanningMetrics(
  events: Array<{ eventType?: string; payload?: unknown }>
): PlanningMetricsSnapshot {
  let autoFixRounds = 0;
  let llmRepairRounds = 0;
  let sliceValidationFailureRounds = 0;
  let converged = true;
  const failureCodes: Record<string, number> = {};
  for (const event of events) {
    const type = event.eventType ?? "";
    if (type === "PLAN_AUTOFIXED") autoFixRounds += 1;
    else if (type === "PLANNING_REPAIR_REQUESTED") llmRepairRounds += 1;
    else if (type === "SLICE_PLAN_VALIDATION_FAILED") sliceValidationFailureRounds += 1;
    if (type === "SLICE_PLANNING_FAILED" || type === "REQUIREMENT_ANALYSIS_FAILED") {
      converged = false;
    }
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const errorCode =
      typeof payload.errorCode === "string" && payload.errorCode !== "" ? payload.errorCode : null;
    if (errorCode) failureCodes[errorCode] = (failureCodes[errorCode] ?? 0) + 1;
  }
  return {
    autoFixRounds,
    llmRepairRounds,
    sliceValidationFailureRounds,
    firstPass: llmRepairRounds === 0 && sliceValidationFailureRounds === 0,
    converged,
    failureCodes
  };
}

/** F1-8（FX-26）：超范围写入标注（`SCOPE_VIOLATION` 事件；F2-1 observe 上线前事件面为空 → false）。 */
export function collectScopeViolation(events: Array<{ eventType?: string }>): boolean {
  return events.some((event) => event.eventType === "SCOPE_VIOLATION");
}

/**
 * 观察项小修（docs/129）：规划指标只计「本轮窗口内」的规划 run。
 * 修复前按需求全历史过滤 → 同需求多批次/多尝试的事件累计污染（S1 档 llmRepairRounds=1141）。
 */
export function filterPlanningRunsInWindow<
  T extends { id?: string; createdAt?: string; input?: Record<string, unknown> }
>(runs: T[], requirementId: string, runStartedAt: number): T[] {
  return runs.filter((run) => {
    if (run.input?.runtime !== "planning-agent") return false;
    if (run.input?.requirementId !== requirementId) return false;
    const createdAt = Date.parse(String(run.createdAt ?? ""));
    return Number.isFinite(createdAt) && createdAt >= runStartedAt;
  });
}

/**
 * 观察项小修（docs/129）：sv 采集面补全——本轮窗口内、同需求、未被本轮收录的工作流
 * （平台内部重试/重建的工作流，其事件此前落在采集面之外）。
 */
export function selectUncollectedWorkflows(
  workflows: Array<{ id?: string; requirementId?: string; createdAt?: string }>,
  opts: { requirementId: string; runStartedAt: number; collectedIds: string[] }
): string[] {
  return workflows
    .filter((workflow) => {
      if (!workflow.id || opts.collectedIds.includes(workflow.id)) return false;
      if (workflow.requirementId !== opts.requirementId) return false;
      const createdAt = Date.parse(String(workflow.createdAt ?? ""));
      return Number.isFinite(createdAt) && createdAt >= opts.runStartedAt;
    })
    .map((workflow) => workflow.id as string);
}

/** N2：需求切片视图（GET /api/requirements/:id/slices 的最小形状）。 */
export interface SliceView {
  sliceKey: string;
  status: string;
  planningVersion?: number | null;
  workflowRunId?: string | null;
}

/** 读取切片列表；单级模式（无切片）或旧服务端（无该路由）返回空数组。 */
export async function loadSlices(deps: HarnessDeps, requirementId: string): Promise<SliceView[]> {
  try {
    const view = unwrap<{ slices?: SliceView[] }>(
      await deps.http.get(`/api/requirements/${requirementId}/slices`),
      "GET /api/requirements/:id/slices"
    );
    return view.slices ?? [];
  } catch {
    return [];
  }
}

/**
 * N2：等待下一片被链式编排启动（RUNNING + workflowRunId）。
 * - DONE（重跑场景）：返回 workflowId=null，由 harness 按该片规划版本重新启动；
 * - FAILED 且「本轮开始前即失败」（preRunFailed）：同上由 harness 重启（B-4 缺陷修复）；
 * - PENDING/PLANNING：链仍在推进该片，继续等待；
 * - PLANNED 且超过宽限期仍无工作流（F1-4：拆分/升级批准后「仅规划不启工作流」）→ 返回
 *   workflowId=null，由 harness 自启动该片；
 * - FAILED（本轮链中途转失败）/ 超时：抛错（失败不自动前进，由整批隔离）。
 * F1-4（FX-15d）：等待途中若需求进入 PLANNING_REVIEW（关口重审：最终切片拆分或升级重试），
 * 自动批准并将该次人工介入计入 `interventions`（调用方累加到 humanInterventions）。
 */
export async function ensureSliceStarted(
  deps: HarnessDeps,
  requirementId: string,
  sliceKey: string,
  options: RunOptions,
  preRunFailed: ReadonlySet<string> = new Set()
): Promise<{ workflowId: string | null; slice: SliceView | null; interventions: number }> {
  const deadline = Date.now() + Math.max(options.runTimeoutMs, 30 * 60 * 1000);
  // 链式编排在切片 PLANNED 后数秒内创建工作流；宽限期避免与链抢跑（默认 poll 15s → 30s）。
  const graceMs = Math.max(1_000, options.pollIntervalMs * 2);
  let plannedSince: number | null = null;
  let interventions = 0;
  for (;;) {
    const slice =
      (await loadSlices(deps, requirementId)).find((entry) => entry.sliceKey === sliceKey) ?? null;
    if (slice?.status === "RUNNING" && slice.workflowRunId) {
      return { workflowId: slice.workflowRunId, slice, interventions };
    }
    if (slice?.status === "FAILED") {
      if (preRunFailed.has(sliceKey)) {
        // 上一轮遗留的失败：重跑场景按原规划版本由 harness 重启（等价 DONE 的自驱重启）。
        return { workflowId: null, slice, interventions };
      }
      throw new Error(`切片 ${sliceKey} 失败`);
    }
    if (slice?.status === "DONE") {
      return { workflowId: null, slice, interventions };
    }
    if (slice?.status === "PLANNED" && !slice.workflowRunId) {
      plannedSince = plannedSince ?? Date.now();
      if (Date.now() - plannedSince > graceMs) {
        // 链已停（仅规划、未创建工作流）→ 由 harness 自启动该片。
        return { workflowId: null, slice, interventions };
      }
    } else {
      plannedSince = null;
    }
    // F1-4（FX-15d）：等待途中处理关口重审（拆分/升级）——批准并计人工介入。
    interventions += await approvePendingPlanningReview(deps, requirementId);
    if (Date.now() > deadline) {
      throw new Error(`切片 ${sliceKey} 未被链式编排启动`);
    }
    await deps.sleep(options.pollIntervalMs);
  }
}

/**
 * F1-4（FX-15d）：需求处于 PLANNING_REVIEW 且有 PENDING 审批时自动批准。
 * 返回 1 = 本次发生一次人工介入（供 harness 累计 gateInterventions 口径）；0 = 无需处理。
 */
export async function approvePendingPlanningReview(
  deps: HarnessDeps,
  requirementId: string
): Promise<number> {
  try {
    const detail = unwrap<{ status?: string }>(
      await deps.http.get(`/api/requirements/${requirementId}`),
      "GET /api/requirements/:id"
    );
    if (detail.status !== "PLANNING_REVIEW") {
      return 0;
    }
    const view = unwrap<{ approval: { id: string; status: string } | null }>(
      await deps.http.get(`/api/requirements/${requirementId}/slices`),
      "GET /api/requirements/:id/slices"
    );
    if (!view.approval || view.approval.status !== "PENDING") {
      return 0;
    }
    deps.log(`  关口重审：批准（审批 ${view.approval.id}）…`);
    await deps.http.post(`/api/approvals/${view.approval.id}/approve`);
    return 1;
  } catch {
    return 0;
  }
}

/**
 * L1-8 补充（`docs/216`）：**任务级审批**（最终切片的生产部署）由 harness 模拟人工放行。
 *
 * 此前 harness 只批准**规划**类审批（`approvePendingPlanningReview`），任务级审批无人处理 ⇒
 * 一旦最终切片规划出生产部署，工作流就停在 `WAITING_APPROVAL`，直到 E1 的 `runTimeoutMs`
 * （**2 小时**）超时。实测：`l1-m4s` run 2 就是这样白等；库里还留着 3 个更早的同形遗留
 * （10-14、10-19、10-20 各一个，已清理）。此前批次从没走到最终切片，所以从未暴露。
 *
 * **这不是绕过审批**：审批门仍然开启、仍然需要「人」——harness 就是那个「人」，并且每次批准都
 * 计入 `humanInterventions`（与关口 1 同一口径）。production 的审批策略本身（L1-9 红线）未改。
 */
export async function approvePendingTaskApprovals(
  deps: HarnessDeps,
  workflowId: string
): Promise<number> {
  try {
    const approvals = unwrap<Array<{ id: string; status: string; reason?: string }>>(
      await deps.http.get(`/api/workflows/${workflowId}/approvals`),
      "GET /api/workflows/:id/approvals"
    );
    let approved = 0;
    for (const approval of approvals) {
      if (approval.status !== "PENDING") continue;
      deps.log(`  任务审批：批准（${approval.reason ?? "approval"}；审批 ${approval.id}）…`);
      await deps.http.post(`/api/approvals/${approval.id}/approve`);
      approved += 1;
    }
    return approved;
  } catch {
    return 0;
  }
}

/**
 * N-62（`docs/232` §10）：**超时后必须取消工作流**。
 *
 * 实测（2026-10-29 F1 第四轮）：批次打印 `run 1 done` / `F1_FRONTEND_X3_ALL_COMPLETE` 时，
 * slice-4 在库里仍是 `RUNNING`（12 成功 / 0 失败 / 3 未完成），直到手工
 * `POST /api/workflows/:id/cancel` 才变成 `CANCELLED`。窗口短（约 3 分钟、0 个 agent_run）所以
 * 那轮没烧到钱，但形状是**必然**的：超时那一刻仍有任务在飞，harness 转身就走。
 *
 * 与 N-58 同一手法：**回读状态**，不以「调用返回 200」当作已停。
 * 调用/回读失败都不抛错——超时这件事已经发生了，不能因为收拾不干净就把结论丢掉。
 */
async function cancelTimedOutWorkflow(
  deps: HarnessDeps,
  workflowId: string,
  options: RunOptions
): Promise<void> {
  try {
    await deps.http.post(`/api/workflows/${workflowId}/cancel`);
  } catch (error) {
    deps.log(
      `  警告：取消超时工作流 ${workflowId} 失败（${
        error instanceof Error ? error.message : String(error)
      }）——请手工 cancel`
    );
    return;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let status: string;
    try {
      const detail = unwrap<WorkflowDetail>(
        await deps.http.get(`/api/workflows/${workflowId}`),
        "GET /api/workflows/:id"
      );
      status = detail.workflow?.status ?? "";
    } catch {
      deps.log(`  警告：取消后回读 ${workflowId} 失败——请手工确认`);
      return;
    }
    if (TERMINAL_WORKFLOW.has(status)) {
      deps.log(`  超时工作流 ${workflowId} 已停止（${status}）`);
      return;
    }
    await deps.sleep(options.pollIntervalMs);
  }
  deps.log(`  警告：工作流 ${workflowId} 在超时后仍未停止——请手工 cancel`);
}

/**
 * 轮询单个工作流至终态；超时返回 `"TIMEOUT"`（记为 timeout，不中断整批）。
 * 停在 `WAITING_APPROVAL` 时逐次尝试放行任务级审批，并把次数计入 `interventions`
 * （调用方累加到 `humanInterventions`）。
 *
 * **N-60（`docs/232` §10）：预算按任务数算，不按墙钟固定值。**
 * `budget = max(runTimeoutMs, tasks.length × perTaskTimeoutMs)`，每次轮询重算——REPLAN/DEBUG
 * 派生出的新任务会把预算一起抬高，于是「还有多少活没干」决定切不切，而不是「已经过了多久」。
 * `runTimeoutMs` 因此退化为**下界**（小切片行为不变）。
 *
 * **N-62（`docs/232` §10）：超时前先取消该工作流**——判超时不是「不再看它」，是「不再为它付钱」。
 */
export async function waitWorkflowTerminal(
  deps: HarnessDeps,
  workflowId: string,
  options: RunOptions
): Promise<{ status: string; interventions: number; budgetMs: number; taskCount: number }> {
  const startedAt = Date.now();
  const perTaskMs = options.perTaskTimeoutMs ?? DEFAULT_PER_TASK_TIMEOUT_MS;
  let interventions = 0;
  let detail = unwrap<WorkflowDetail>(
    await deps.http.get(`/api/workflows/${workflowId}`),
    "GET /api/workflows/:id"
  );
  let taskCount = detail.tasks?.length ?? 0;
  let budgetMs = workflowBudgetMs(taskCount, options.runTimeoutMs, perTaskMs);
  // N-63：预算此前只在**超时**时打印，跑成功的轮次读不到——启动时打一行，让「每任务多少分钟、
  // 有没有被下界吃掉」直接可观测（台账里不再只能靠「没被切断」反推）。
  deps.log(
    `  预算：${taskCount} 个任务 × ${Math.round(perTaskMs / 60_000)} min = ` +
      `${Math.round(budgetMs / 60_000)} min（下界 ${Math.round(options.runTimeoutMs / 60_000)} min）`
  );
  while (!TERMINAL_WORKFLOW.has(detail.workflow?.status ?? "")) {
    if (Date.now() - startedAt > budgetMs) {
      // N-62：判超时不是「不再看它」，是「不再为它付钱」——先停，再返回。
      await cancelTimedOutWorkflow(deps, workflowId, options);
      return { status: "TIMEOUT", interventions, budgetMs, taskCount };
    }
    if (detail.workflow?.status === "WAITING_APPROVAL") {
      interventions += await approvePendingTaskApprovals(deps, workflowId);
    }
    await deps.sleep(options.pollIntervalMs);
    detail = unwrap<WorkflowDetail>(
      await deps.http.get(`/api/workflows/${workflowId}`),
      "GET /api/workflows/:id"
    );
    // N-60：每轮重算——REPLAN/DEBUG 派生的新任务会把预算一起抬高。
    taskCount = detail.tasks?.length ?? taskCount;
    budgetMs = workflowBudgetMs(taskCount, options.runTimeoutMs, perTaskMs);
  }
  return { status: detail.workflow?.status ?? "", interventions, budgetMs, taskCount };
}

interface WorkflowDetail {
  workflow?: { status?: string; startedAt?: string; finishedAt?: string };
  tasks?: DeliveryCapableTask[];
  events?: Array<{ eventType?: string }>;
}

/**
 * 任务的最小形状。`input.delivery` 是 L1-8 的 staging 段判据来源——平台 `GET /api/workflows/:id`
 * 返回完整 `Task[]`，此前本地类型只取 `{status, output}`，故此处补上投递字段。
 */
interface DeliveryCapableTask {
  status: string;
  taskKey?: string;
  type?: string;
  /** N-36：replan 重试与源任务并存时，用它判定「最终一次尝试」（缺省 → 退回数组顺序）。 */
  createdAt?: string;
  input?: { delivery?: { action?: string; environment?: string } };
  output?: unknown;
}

interface AgentRunLike {
  id: string;
  createdAt?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  /** 平台真实形状：{ input_tokens, output_tokens, total_tokens, ... } */
  tokenUsage?: { input_tokens?: number; output_tokens?: number } | null;
  estimatedCost?: number | null;
}

/**
 * 从 run 记录里抽出可累加的用量与诊断字段（纯函数，便于单测）。
 *
 * **不抽 `output.errorType`**：失败原因分布只按任务级统计，理由见 `collectTaskMetrics` 的调用点
 * （run 级与任务级是同一份 `outcome.metadata`，相加正好翻倍）。
 */
export function extractRunUsage(run: AgentRunLike): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  parseRecovery: boolean;
} {
  const output = (run.output ?? {}) as Record<string, unknown>;
  return {
    inputTokens: run.tokenUsage?.input_tokens ?? 0,
    outputTokens: run.tokenUsage?.output_tokens ?? 0,
    costUsd: typeof run.estimatedCost === "number" ? run.estimatedCost : null,
    parseRecovery: typeof output.parseRecovery === "string" && output.parseRecovery !== ""
  };
}

export async function ensureProject(deps: HarnessDeps, fixture: EvalFixture): Promise<string> {
  const name = `${PROJECT_PREFIX}${fixture.id}`;
  const existing = asArray(unwrap<unknown>(await deps.http.get("/api/projects"), "/api/projects"));
  const found = existing.find((project) => (project as { name?: string }).name === name);
  if (found) return (found as { id: string }).id;
  const created = unwrap<{ id: string }>(
    await deps.http.post("/api/projects", {
      name,
      description: `P0 评测夹具 ${fixture.id}（${fixture.title}）—— 由 packages/eval 自动创建`
    }),
    "POST /api/projects"
  );
  deps.log(`  创建项目 ${name} (${created.id})`);
  return created.id;
}

/**
 * N-73（`docs/232` §10）：**把夹具声明的交付环境 upsert 进项目**。
 *
 * 没有 `deployment_environments` 行时，规划期会以 `DELIVERY_ENVIRONMENT_MISSING` 失败、
 * 运行期也找不到 staging。`static` 适配器就是工作区优先的前端（无仓库、无 Dockerfile，
 * `docs/233` §5.4）：CI 在工作区里跑、DEPLOY 起静态预览、VERIFY 用浏览器探页面。
 */
export async function ensureEnvironments(
  deps: HarnessDeps,
  projectId: string,
  fixture: EvalFixture
): Promise<void> {
  const environments = fixture.delivery?.environments ?? [];
  if (environments.length === 0) return;
  if (!deps.http.put) {
    throw new Error(`fixture ${fixture.id} declares delivery environments but the HTTP client has no PUT`);
  }
  for (const environment of environments) {
    await deps.http.put("/api/environments", {
      projectId,
      name: environment.name,
      endpoint: environment.endpoint,
      adapter: environment.adapter,
      ...(environment.configuration ? { configuration: environment.configuration } : {})
    });
    deps.log(`  交付环境 ${environment.name} → ${environment.endpoint}（${environment.adapter}）`);
  }
}

export async function ensurePlanning(
  deps: HarnessDeps,
  fixture: EvalFixture,
  projectId: string,
  replan: boolean
): Promise<{
  requirementId: string;
  planningVersion: number | null;
  planTaskKeys: string[];
  slices: SliceView[];
  gateInterventions: number;
}> {
  const requirements = asArray(
    unwrap<unknown>(
      await deps.http.get(`/api/projects/${projectId}/requirements`),
      "/api/projects/:id/requirements"
    )
  );
  // 复用同标题需求能省一次规划，但**终态失败的需求永不复用**：项目里只要还躺着一条
  // 旧的 FAILED 记录（实测：`[eval] E1` 里那条自 2026-09-30 起就是 FAILED），
  // 任何一次重跑都会立刻拿到它并直接判「规划失败」——回归检查会静默失效。
  const reusable = requirements
    .filter((item) => (item as { title?: string }).title === fixture.id)
    .filter((item) => {
      const status = (item as { status?: string }).status;
      return status !== "FAILED" && status !== "CANCELLED";
    })
    .sort((a, b) =>
      String((b as { createdAt?: string }).createdAt ?? "").localeCompare(
        String((a as { createdAt?: string }).createdAt ?? "")
      )
    );
  let requirementId = (reusable[0] as { id: string } | undefined)?.id;
  if (!requirementId) {
    const created = unwrap<{ id: string }>(
      await deps.http.post(`/api/projects/${projectId}/requirements`, {
        title: fixture.id,
        description: fixture.title,
        rawContent: fixture.requirementText
      }),
      "POST /api/projects/:id/requirements"
    );
    requirementId = created.id;
    deps.log(`  创建需求 ${fixture.id} (${requirementId})`);
  }

  let gateInterventions = 0;
  const detail = unwrap<{ status?: string }>(
    await deps.http.get(`/api/requirements/${requirementId}`),
    "GET /api/requirements/:id"
  );
  if (replan || detail.status !== "ANALYZED") {
    deps.log(`  规划中（analyze）…`);
    // 已 ANALYZED 的需求需 regenerate=true 才会强制重规划（否则服务端早退复用旧计划）。
    await deps.http.post(
      `/api/requirements/${requirementId}/analyze`,
      replan ? { regenerate: true } : undefined
    );
    const deadline = Date.now() + 20 * 60 * 1000;
    for (;;) {
      const current = unwrap<{ status?: string }>(
        await deps.http.get(`/api/requirements/${requirementId}`),
        "GET /api/requirements/:id"
      );
      if (current.status === "ANALYZED") break;
      if (current.status === "PLANNING_REVIEW") {
        // N2 关口 1：harness 模拟人工确认（计 1 次人工介入）后进入第二级。
        const view = unwrap<{
          slices: SliceView[];
          approval: { id: string; status: string } | null;
        }>(
          await deps.http.get(`/api/requirements/${requirementId}/slices`),
          "GET /api/requirements/:id/slices"
        );
        if (view.approval && view.approval.status === "PENDING") {
          deps.log(`  关口 1：批准切片计划（审批 ${view.approval.id}）…`);
          await deps.http.post(`/api/approvals/${view.approval.id}/approve`);
          gateInterventions += 1;
        }
      } else if (current.status === "FAILED") {
        throw new Error(`规划失败：${requirementId}`);
      }
      if (Date.now() > deadline) throw new Error(`规划超时：${requirementId}`);
      await deps.sleep(2000);
    }
  }

  const slices = await loadSlices(deps, requirementId);
  const specifications = asArray(
    unwrap<unknown>(
      await deps.http.get(`/api/requirements/${requirementId}/specifications`),
      "GET /api/requirements/:id/specifications"
    )
  );
  const planningVersion =
    slices[0]?.planningVersion ??
    (specifications[0] as { version?: number } | undefined)?.version ??
    null;

  const plan = unwrap<{ tasks?: Array<{ taskKey?: string; id?: string }> }>(
    await deps.http.get(`/api/requirements/${requirementId}/tasks`),
    "GET /api/requirements/:id/tasks"
  );
  const planTaskKeys = (plan.tasks ?? []).map((task) => task.taskKey ?? task.id ?? "?");
  deps.log(
    `  复用计划 v${planningVersion ?? "?"}：${planTaskKeys.length} 个任务 [${planTaskKeys.join(", ")}]（切片 ${slices.length}）`
  );
  return { requirementId, planningVersion, planTaskKeys, slices, gateInterventions };
}

export interface FixtureOutcome {
  records: EvalRunRecord[];
  failures: EvalFailure[];
}

/**
 * 单夹具失败（例如规划超时）只登记、不中断整批；单次运行失败同样跳过该次继续后续运行。
 */
export async function runFixture(
  deps: HarnessDeps,
  fixture: EvalFixture,
  options: RunOptions
): Promise<FixtureOutcome> {
  deps.log(`[${fixture.id}] ${fixture.title}（${fixture.tier} 档）`);
  const records: EvalRunRecord[] = [];
  const failures: EvalFailure[] = [];
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  // 观察项小修（docs/129）：本轮夹具的窗口起点——规划指标与 sv 采集面按此过滤；
  // run 1 的窗口覆盖其 replan（ensurePlanning 在运行循环之前执行）。
  const fixtureStartedAt = Date.now();

  let projectId: string;
  let planning: Awaited<ReturnType<typeof ensurePlanning>>;
  try {
    projectId = await ensureProject(deps, fixture);
    // N-73：声明了交付环境的夹具先把环境 upsert 进项目，规划才会排出交付链。
    await ensureEnvironments(deps, projectId, fixture);
    planning = await ensurePlanning(deps, fixture, projectId, options.replan);
  } catch (error) {
    deps.log(`  ✗ 规划阶段失败：${message(error)}`);
    failures.push({ fixtureId: fixture.id, stage: "planning", message: message(error) });
    return { records, failures };
  }

  for (let runIndex = 1; runIndex <= options.runs; runIndex += 1) {
    try {
      const runStartedAt = runIndex === 1 ? fixtureStartedAt : Date.now();
      const workspacePath = await deps.prepareWorkspace(fixture, runIndex);
      // 重跑语义（B-4 缺陷修复）：快照本轮开始前的切片状态——此前即 FAILED 的切片属于
      // 上一轮遗留，允许按原规划版本重启；本轮链中途转 FAILED 仍按失败处理。
      const preRunFailed = new Set(
        (await loadSlices(deps, planning.requirementId))
          .filter((entry) => entry.status === "FAILED")
          .map((entry) => entry.sliceKey)
      );

      const startWorkflow = async (sliceKey: string | null, version: number | null) => {
        const created = unwrap<{ id: string }>(
          await deps.http.post("/api/workflows", {
            projectId,
            requirementId: planning.requirementId,
            workspacePath,
            ...(version ? { planningVersion: version } : {}),
            ...(sliceKey ? { sliceKey } : {}),
            policy: deps.policy
          }),
          "POST /api/workflows"
        );
        await deps.http.post(`/api/workflows/${created.id}/start`);
        return created.id;
      };

      // N2：两级模式按切片顺序执行——首片由 harness 启动；后续优先由平台链式编排接管；
      // 重跑场景下已完成（DONE）切片由 harness 按原规划版本重新启动（等价于单级模式的“同计划重跑”）。
      const executed: Array<{ sliceKey: string | null; workflowId: string; status: string }> = [];
      const sliceList = planning.slices;
      // F1-4（FX-15d）：运行途中的关口重审（拆分/升级）人工介入计数。
      let journeyInterventions = 0;
      if (sliceList.length === 0) {
        const workflowId = await startWorkflow(null, planning.planningVersion);
        deps.log(`  run ${runIndex}: 工作流 ${workflowId} 启动…`);
        const waited = await waitWorkflowTerminal(deps, workflowId, options);
        journeyInterventions += waited.interventions;
        if (waited.status === "TIMEOUT") {
          deps.log(
            `  单级工作流超时：预算 ${Math.round(waited.budgetMs / 60_000)} min` +
              `（${waited.taskCount} 个任务，下界 ${Math.round(options.runTimeoutMs / 60_000)} min）`
          );
        }
        executed.push({
          sliceKey: null,
          workflowId,
          status: waited.status
        });
      } else {
        let current = {
          sliceKey: sliceList[0].sliceKey,
          workflowId: await startWorkflow(
            sliceList[0].sliceKey,
            sliceList[0].planningVersion ?? null
          )
        };
        deps.log(`  run ${runIndex}: 切片 ${current.sliceKey} 工作流 ${current.workflowId} 启动…`);
        for (;;) {
          const waited = await waitWorkflowTerminal(deps, current.workflowId, options);
          journeyInterventions += waited.interventions;
          const status = waited.status;
          if (status === "TIMEOUT") {
            // N-60：超时必须能归因——是任务多（预算已经跟着放大了）还是单纯太慢。
            deps.log(
              `  切片 ${current.sliceKey} 超时：预算 ${Math.round(waited.budgetMs / 60_000)} min` +
                `（${waited.taskCount} 个任务 × ${Math.round((options.perTaskTimeoutMs ?? DEFAULT_PER_TASK_TIMEOUT_MS) / 60_000)} min，` +
                `下界 ${Math.round(options.runTimeoutMs / 60_000)} min）`
            );
          }
          executed.push({ ...current, status });
          if (status !== "SUCCESS") {
            break; // 失败按既有失败策略处理、不自动前进
          }
          // F1-4：拆分/重做会追加或替换切片——动态刷新切片列表按顺序解析下一片
          // （重跑场景的既有行为不变：下一片仍按顺序取，由 ensureSliceStarted 决定自驱重启）。
          const freshSlices = await loadSlices(deps, planning.requirementId);
          const index = freshSlices.findIndex((entry) => entry.sliceKey === current.sliceKey);
          const nextKey = freshSlices[index + 1]?.sliceKey;
          if (!nextKey) {
            break;
          }
          const next = await ensureSliceStarted(
            deps,
            planning.requirementId,
            nextKey,
            options,
            preRunFailed
          );
          journeyInterventions += next.interventions;
          const workflowId =
            next.workflowId ?? (await startWorkflow(nextKey, next.slice?.planningVersion ?? null));
          deps.log(`  切片 ${nextKey} 工作流 ${workflowId} 启动…`);
          current = { sliceKey: nextKey, workflowId };
        }
      }

      if (executed.some((entry) => entry.status === "TIMEOUT")) {
        deps.log(`  run ${runIndex}: 超时（记为 timeout，不中断整批）`);
      }

      const details: WorkflowDetail[] = [];
      for (const entry of executed) {
        details.push(
          unwrap<WorkflowDetail>(
            await deps.http.get(`/api/workflows/${entry.workflowId}`),
            "GET /api/workflows/:id"
          )
        );
      }
      const workflowIds = executed.map((entry) => entry.workflowId);
      const tasks = details.flatMap((detail) => detail.tasks ?? []);
      const events = details.flatMap((detail) => detail.events ?? []);
      const metrics = collectTaskMetrics(tasks);
      // 关口 1 的人工确认（规划阶段发生）计 1 次人工介入；F1-4 运行途中的关口重审（拆分/升级）同样计入。
      const humanInterventions =
        countHumanInterventions(events) + planning.gateInterventions + journeyInterventions;

      const allRuns = asArray(
        unwrap<unknown>(await deps.http.get("/api/agent-runs"), "/api/agent-runs")
      ).map((item) => item as AgentRunLike);
      const runs = allRuns.filter((run) =>
        workflowIds.includes(String(run.input?.workflowRunId ?? ""))
      );

      let tokenUsage: { input: number; output: number } | null = null;
      let estimatedCostUsd: number | null = null;
      // 降级率只按 run 级统计（任务级标记只反映最后一次尝试，会重复计数）。
      let parseRecoveryRuns = 0;
      // 失败原因分布只按**任务级**统计（`collectTaskMetrics`），**不**再叠加 run 级。
      // （上一行的降级率取 run 级、这一行取任务级，**两者口径不同是有意的**：降级率问
      // 「降级**事件**发生几次」，失败原因分布问「**任务**因何而败」。不要顺手「统一」。）
      // 理由一：`tasks.output` 与 `agent_runs.output` 是**同一份** `outcome.metadata`——
      // `workflowTaskExecutor.ts:355-389` 把同一个 `output` 对象既写进 run，又作为任务结果返回；
      // 于是同一份 `errorType` 两级各计一次，相加正好翻倍。实测 l1-m4m run-2：真实只有 3 个任务
      // TIMEOUT，旧口径报表记 6（`failureLayers.agent` 同样记 6）。
      // 理由二：`VERIFICATION_FAILED` **只**写在任务上（`verifyingTaskExecutor.ts:81` 覆盖任务
      // output，run 保留 agent 自己的码），只取 run 级会让 `failureLayers.verification` 恒为 0
      // ——全库 122 次 `VERIFICATION_FAILED` 会全部丢失。
      const errorTypes = metrics.errorTypes;
      for (const summaryRun of runs) {
        const runDetail = unwrap<{ run?: AgentRunLike }>(
          await deps.http.get(`/api/agent-runs/${summaryRun.id}`),
          "GET /api/agent-runs/:id"
        );
        const run = runDetail.run ?? summaryRun;
        const usage = extractRunUsage(run);
        const previous: { input: number; output: number } = tokenUsage ?? { input: 0, output: 0 };
        tokenUsage = {
          input: previous.input + usage.inputTokens,
          output: previous.output + usage.outputTokens
        };
        if (usage.costUsd !== null) estimatedCostUsd = (estimatedCostUsd ?? 0) + usage.costUsd;
        if (usage.parseRecovery) parseRecoveryRuns += 1;
      }

      // N-59 (docs/232 sec.10): unfinished workflows count up to `now` and the batch wall clock
      // is the floor - see collectDurationMetrics for the rule and the 4.3x under-report it fixes.
      const nowMs = Date.now();
      const durationMetrics = collectDurationMetrics(
        details.map((detail) => detail.workflow ?? {}),
        runStartedAt,
        nowMs
      );
      const durationMs: number = durationMetrics.durationMs;
      const incompleteWorkflows = durationMetrics.incomplete;

      // oracle 的 cwd 是夹具目录（与工作区完全隔离），脚本路径 oracle.mjs 相对夹具目录解析。
      const oracle = await runOracle(fixture, workspacePath, deps.commands, {
        packageDir: join(deps.packageDir, "fixtures", fixture.id),
        timeoutMs: options.oracleTimeoutMs
      });
      // 失败时打印**完整** oracle 输出。此前只在汇总行里 `slice(0, 120)`，导致逐条 AC 的失败原因
      // 被截断丢弃——查 `l1-m4s` 的 AC-20 / AC-27 时日志里只剩半行 JSON，无法定位。
      if (!oracle.passed) {
        deps.log(`  oracle 明细（完整，含逐条 AC）：\n${oracle.output}`);
      }

      // F1-8（FX-26）：链完成 / 最远切片 / 验证门分歧 / 失败分层 / 规划侧修复与收敛。
      const postRunSlices = await loadSlices(deps, planning.requirementId);
      const chain = collectChainMetrics(
        scopeSlicesToRun(
          postRunSlices,
          executed.map((entry) => entry.sliceKey)
        ),
        executed.map((entry) => entry.status)
      );
      const verificationMetrics = collectVerificationMetrics(tasks);
      const planningRuns = filterPlanningRunsInWindow(
        allRuns,
        planning.requirementId,
        runStartedAt
      );
      const planningEvents: Array<{ eventType?: string; payload?: unknown }> = [];
      for (const run of planningRuns) {
        planningEvents.push(
          ...asArray(
            unwrap<unknown>(
              await deps.http.get(`/api/agent-runs/${run.id}/events`),
              "GET /api/agent-runs/:id/events"
            )
          ).map((event) => event as { eventType?: string; payload?: unknown })
        );
      }
      const extraWorkflowEvents: Array<{ eventType?: string }> = [];
      try {
        const allWorkflows = asArray(
          unwrap<unknown>(await deps.http.get("/api/workflows"), "GET /api/workflows")
        ).map((item) => item as { id?: string; requirementId?: string; createdAt?: string });
        for (const extraId of selectUncollectedWorkflows(allWorkflows, {
          requirementId: planning.requirementId,
          runStartedAt,
          collectedIds: workflowIds
        })) {
          const extraDetail = unwrap<WorkflowDetail>(
            await deps.http.get(`/api/workflows/${extraId}`),
            "GET /api/workflows/:id"
          );
          extraWorkflowEvents.push(...(extraDetail.events ?? []));
        }
      } catch {
        deps.log("  sv 采集面补全跳过（/api/workflows 列表不可用）");
      }
      const planningMetrics = collectPlanningMetrics(planningEvents);
      const failureLayers = collectFailureLayers(errorTypes, planningMetrics.failureCodes);
      const scopeViolation = collectScopeViolation([
        ...events,
        ...extraWorkflowEvents,
        ...planningEvents
      ]);

      const failedTask = tasks.find((task) => task.status === "FAILED") as
        | { output?: { summary?: string } }
        | undefined;
      const record: EvalRunRecord = {
        fixtureId: fixture.id,
        tier: fixture.tier,
        runIndex,
        workflowId: workflowIds[0] ?? "",
        workflowIds,
        workspacePath,
        taskCount: tasks.length,
        runCount: runs.length,
        taskStatuses: metrics.taskStatuses,
        reportedSuccess: metrics.reportedSuccess,
        oraclePassed: oracle.passed,
        falsePositive: metrics.reportedSuccess && !oracle.passed,
        parseRecoveryRuns,
        humanInterventions,
        tokenUsage,
        estimatedCostUsd,
        durationMs,
        incompleteWorkflows,
        errorTypes,
        failureSummary: failedTask?.output?.summary ?? null,
        chainCompleted: chain.chainCompleted,
        deliveredSuccess: oracle.passed && chain.chainCompleted,
        falseNegative: oracle.passed && !chain.chainCompleted,
        scopeViolation,
        sliceReached: chain.sliceReached,
        taskVerificationDivergence: verificationMetrics.taskVerificationDivergence,
        verificationFailureCodes: verificationMetrics.verificationFailureCodes,
        verificationUnavailable: verificationMetrics.verificationUnavailable,
        verificationUnavailableByType: verificationMetrics.verificationUnavailableByType,
        failureLayers,
        planningMetrics,
        stagingSegment: collectStagingSegment(tasks)
      };
      deps.log(
        `  run ${runIndex}: 自报=${record.reportedSuccess ? "成功" : "失败"} oracle=${
          record.oraclePassed ? "通过" : "不通过"
        } 假阳性=${record.falsePositive ? "是" : "否"} 链完成=${
          chain.chainCompleted ? "是" : "否"
        } 交付成功=${record.deliveredSuccess ? "是" : "否"} staging 段=${
          record.stagingSegment?.delivered ? "是" : "否"
        }（ci=${record.stagingSegment?.ci ?? "-"} deploy=${
          record.stagingSegment?.deploy ?? "-"
        } verify=${record.stagingSegment?.verify ?? "-"}）${
          oracle.output ? ` | ${oracle.output.slice(0, 120)}` : ""
        }`
      );
      records.push(record);
    } catch (error) {
      deps.log(`  ✗ run ${runIndex} 失败：${message(error)}`);
      failures.push({ fixtureId: fixture.id, stage: "run", message: message(error) });
    }
  }
  return { records, failures };
}
