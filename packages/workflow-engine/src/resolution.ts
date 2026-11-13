import type { Task, TaskDependencyView } from "@ai-se/shared";

/** 剥掉尾部 -DEBUG-N / -REPLAN-N，得到计划源任务 key（与 server autonomy 同口径）。 */
const DYNAMIC_KEY_SUFFIX = /-(DEBUG|REPLAN)-\d+$/;

export function replanRootTaskKey(taskKey: string): string {
  let key = taskKey;
  while (DYNAMIC_KEY_SUFFIX.test(key)) {
    key = key.replace(DYNAMIC_KEY_SUFFIX, "");
  }
  return key;
}

/**
 * 「失败是否已被解决」的唯一判定。
 *
 * `replan()` 只把源任务的 `resolvedByTaskId` 指向**下一层**的 retry 任务
 * （`WorkflowEngine.replan`），而 retry 任务自己也可能失败、再被重规划一层。
 * 历史嵌套键是 `T → T-REPLAN-1 → T-REPLAN-1-REPLAN-2`；现已改为同根 `T-REPLAN-N`，
 * 但判定仍须沿 `resolvedByTaskId` 链走到头（中间节点自身都可能是 FAILED）。
 * **只认直接指针**会把「第二层才救回来」误判为未解决，让一条工作全部做完的工作流
 * 报 `WORKFLOW_TASK_FAILED`（N-12）。故判定必须沿链走到头。
 *
 * 链走到头是 SUCCESS ⇒ 已解决；走到头是 FAILED / 断链 / 成环 ⇒ 未解决（fail-closed）。
 * 深度由策略的 `maxRetries` 界定，此处**不写死层数**，只用 visited 集合防环。
 *
 * N-50（`docs/232` §9.16）：`pendingSuccessId` 供**验证期**调用方使用——验证在任务变成 SUCCESS
 * **之前**执行，此刻「解决者」这一行还是 RUNNING。若调用方正在判定的正是链上那个解决者，
 * 传它进来即视为已解决；否则链会在最后一步被判未解决，而实际上它马上就要成功。
 * 判定口径仍然只有这一处（`docs/160` 的漂移成因），不在调用方另抄一份。
 *
 * Thrash fix（docs/251 追加）：SUCCESS 任务若仍带着指向后续修复层的 `resolvedByTaskId`
 * （人工重试把源任务跑成 SUCCESS，指针却未清），则该 SUCCESS 出站链上的后续 FAILED /
 * CANCELLED 修复层视为已被前驱成功接替——不再重排、也不再挡终局。
 */
export function isFailureResolved(
  task: Task,
  byId: ReadonlyMap<string, Task>,
  options: { pendingSuccessId?: string } = {}
): boolean {
  if (isSupersededBySuccessfulPredecessor(task, byId, options)) return true;
  const seen = new Set<string>();
  let next = task.resolvedByTaskId;
  while (next && !seen.has(next)) {
    seen.add(next);
    const resolver = byId.get(next);
    if (!resolver) return false;
    if (resolver.status === "SUCCESS" || resolver.id === options.pendingSuccessId) return true;
    next = resolver.resolvedByTaskId;
  }
  return false;
}

/**
 * SUCCESS 前驱仍指向本任务（或其下游）⇒ 本任务是被成功前驱接替的过时修复层。
 * 典型形状：T-05-REPLAN-1 SUCCESS 且 resolvedBy→REPLAN-2，REPLAN-2 仍 FAILED/CANCELLED。
 *
 * docs/257：计划根后来自己跑成 SUCCESS（人工重试源任务），旧的 T-13-REPLAN-N
 * 仍是 FAILED 且没有 resolvedBy 指针。这类过时修复叶不得再挡住切片末门禁或终局。
 * 只认动态后缀叶（-REPLAN-N / -DEBUG-N）；根自己失败时不算被自己解决。
 */
export function isSupersededBySuccessfulPredecessor(
  task: Task,
  byId: ReadonlyMap<string, Task>,
  options: { pendingSuccessId?: string } = {}
): boolean {
  for (const candidate of byId.values()) {
    if (candidate.status !== "SUCCESS" || !candidate.resolvedByTaskId) continue;
    const seen = new Set<string>();
    let next: string | undefined = candidate.resolvedByTaskId;
    while (next && !seen.has(next)) {
      if (next === task.id) return true;
      seen.add(next);
      const hop = byId.get(next);
      if (!hop) break;
      next = hop.resolvedByTaskId;
    }
  }
  const rootKey = replanRootTaskKey(task.taskKey);
  if (rootKey !== task.taskKey) {
    for (const candidate of byId.values()) {
      if (candidate.taskKey !== rootKey) continue;
      if (candidate.status === "SUCCESS") return true;
      if (options.pendingSuccessId && candidate.id === options.pendingSuccessId) return true;
    }
  }
  return false;
}

/** FAILED 且未被解决的任务——终局 / 进度判定用。 */
export function unresolvedFailedTasks(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.filter((task) => task.status === "FAILED" && !isFailureResolved(task, byId));
}

/**
 * `WorkflowEngine.retry` 的重排范围：
 * 1) 未解决失败里只取每条 `resolvedByTaskId` 链的最上游一层；
 * 2) 再按 `replanRootTaskKey` 归并——同一计划根下的并行/嵌套 REPLAN 森林只留一个，
 *    优先计划源行（`taskKey === root`），否则最早创建的那条。
 * 避免一次人工重试把 T-10 + T-10-REPLAN-1 + T-10-REPLAN-1-REPLAN-2 叠跑空烧额度
 * （taskflow-vue v9 实测）。
 */
export function retryableFailedTasks(tasks: Task[]): Task[] {
  const unresolved = unresolvedFailedTasks(tasks);
  if (unresolved.length <= 1) return unresolved;
  const unresolvedIds = new Set(unresolved.map((task) => task.id));
  const chainRoots = unresolved.filter(
    (task) =>
      !unresolved.some(
        (other) =>
          other.id !== task.id &&
          unresolvedIds.has(other.id) &&
          other.resolvedByTaskId === task.id
      )
  );
  if (chainRoots.length <= 1) return chainRoots;

  const byRoot = new Map<string, Task[]>();
  for (const task of chainRoots) {
    const root = replanRootTaskKey(task.taskKey);
    const group = byRoot.get(root);
    if (group) group.push(task);
    else byRoot.set(root, [task]);
  }

  const picked: Task[] = [];
  for (const [root, group] of byRoot) {
    if (group.length === 1) {
      picked.push(group[0]!);
      continue;
    }
    const planRow = group.find((task) => task.taskKey === root);
    if (planRow) {
      picked.push(planRow);
      continue;
    }
    const sorted = [...group].sort((a, b) => {
      const byCreated = (a.createdAt || "").localeCompare(b.createdAt || "");
      return byCreated !== 0 ? byCreated : a.taskKey.localeCompare(b.taskKey);
    });
    picked.push(sorted[0]!);
  }
  return picked;
}

/**
 * 工作流里是否还有「未解决」的失败——`WorkflowEngine.advanceOnce` 的终局判定。
 * `BLOCKED` 一律算未解决；`CANCELLED` 若已被 SUCCESS 前驱接替则不算（与 FAILED 同源）。
 */
export function hasUnresolvedFailure(tasks: Task[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (tasks.some((task) => task.status === "BLOCKED")) return true;
  if (
    tasks.some(
      (task) =>
        task.status === "CANCELLED" && !isSupersededBySuccessfulPredecessor(task, byId)
    )
  ) {
    return true;
  }
  return unresolvedFailedTasks(tasks).length > 0;
}

/**
 * 列表 / 详情进度计数：与终局判定同源。
 * - total = 全部任务（含被 REPLAN 接替的历史行）
 * - completed = SUCCESS + 「FAILED 且 isFailureResolved」
 * 这样整体 SUCCESS、仅有被接替失败时显示 N/N，而不是 18/20。
 */
export function countWorkflowTaskProgress(
  tasks: readonly Task[]
): { completed: number; total: number } {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  let completed = 0;
  for (const task of tasks) {
    if (task.status === "SUCCESS") {
      completed += 1;
    } else if (task.status === "FAILED" && isFailureResolved(task, byId)) {
      completed += 1;
    }
  }
  return { completed, total: tasks.length };
}


/**
 * When a source is SUCCESS/RETRYING again but an exhausted REPLAN descendant still
 * holds active DYNAMIC outs (original source outs inactive), plan edge flips so
 * dependents wait on the source instead of the dead repair leaf (taskflow-vue v9 deadlock).
 */
export function planSupersededReplanEdgeRestore(
  source: Task,
  tasks: readonly Task[],
  dependencies: readonly TaskDependencyView[]
): { deactivateIds: string[]; reactivateIds: string[]; unblockTargetIds: string[] } {
  const deactivateIds: string[] = [];
  const reactivateIds: string[] = [];
  const unblockTargetIds: string[] = [];
  if (!source.resolvedByTaskId) {
    return { deactivateIds, reactivateIds, unblockTargetIds };
  }
  if (source.status !== "SUCCESS" && source.status !== "RETRYING") {
    return { deactivateIds, reactivateIds, unblockTargetIds };
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const chainIds = new Set<string>();
  const seen = new Set<string>();
  let next: string | undefined = source.resolvedByTaskId;
  while (next && !seen.has(next)) {
    seen.add(next);
    chainIds.add(next);
    next = byId.get(next)?.resolvedByTaskId;
  }
  if (chainIds.size === 0) {
    return { deactivateIds, reactivateIds, unblockTargetIds };
  }

  const staleOuts = dependencies.filter(
    (dependency) => dependency.active !== false && chainIds.has(dependency.sourceTaskId)
  );
  if (staleOuts.length === 0) {
    return { deactivateIds, reactivateIds, unblockTargetIds };
  }

  const targetIds = new Set(staleOuts.map((dependency) => dependency.targetTaskId));
  for (const dependency of staleOuts) {
    deactivateIds.push(dependency.id);
  }
  for (const dependency of dependencies) {
    if (
      dependency.active === false &&
      dependency.sourceTaskId === source.id &&
      targetIds.has(dependency.targetTaskId)
    ) {
      reactivateIds.push(dependency.id);
    }
  }
  for (const targetId of targetIds) {
    const target = byId.get(targetId);
    if (target?.status === "BLOCKED") unblockTargetIds.push(targetId);
  }
  return { deactivateIds, reactivateIds, unblockTargetIds };
}
