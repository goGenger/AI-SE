import { TaskPlan, TaskPlanItem, isRuntimeOnlyTaskType } from "@ai-se/shared";
import { canonicalAcKey } from "./acceptanceCriteria";

export interface TaskGraphEdge {
  sourceTaskId: string;
  targetTaskId: string;
}

export interface TaskGraphValidationResult {
  valid: boolean;
  errors: string[];
  roots: string[];
  leaves: string[];
  edges: TaskGraphEdge[];
}

export class TaskGraphValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Task DAG validation failed: ${errors.join("; ")}`);
  }
}

/**
 * 运行时专属类型（`DEBUG` / `MONITOR` / `INCIDENT`）由 Workflow Engine 在 REPLAN 链里自己创建。
 * 计划项里出现它们时，执行期必然以 "No professional agent for task type …" 瞬失败（真实案例 2026-09-28：
 * 计划项 T8 type=DEBUG → 3 次瞬失败、整条工作流 FAILED），所以在规划期就拦下并交给修复轮重规划。
 *
 * 判定本身在 `@ai-se/shared`（`isRuntimeOnlyTaskType`）——三处消费方共用一份，避免漂移。
 */

/** DEPLOY 计划项必须带可交付的 delivery 块，否则会落到 agent 执行器且无对应 agent。 */
const DEPLOYABLE_DELIVERY_ACTIONS = new Set(["DEPLOY", "ROLLBACK"]);

/**
 * F1-3：交付链任务（计划期）——DEPLOY，或携带 delivery 块的 BUILD/VERIFY 等交付类任务。
 * 归属规则：只允许出现在最终切片（validateTaskGraph 的 isFinalSlice 参数）。
 */
export function isDeliveryChainTask(task: TaskPlanItem): boolean {
  return task.type === "DEPLOY" || task.delivery !== undefined;
}

function executabilityErrors(task: TaskPlanItem, options: TaskGraphValidationOptions): string[] {
  const errors: string[] = [];
  if (isRuntimeOnlyTaskType(task.type)) {
    errors.push(
      `Task ${task.id} uses runtime-only type ${task.type}; the Workflow Engine creates ${task.type} tasks itself — plan a work-type task (e.g. FRONTEND or BACKEND) instead`
    );
  }

  if (options.isFinalSlice === false && isDeliveryChainTask(task)) {
    // F1-3/F1-4 归属守卫：非最终切片出现交付链任务 → 明确错误码（不再报「缺交付块」——
    // 该任务在本切片本就不该存在，补块同样不适用）。
    errors.push(
      `Task ${task.id} is a delivery task but this is not the final slice (DELIVERY_TASK_OUTSIDE_FINAL_SLICE); delivery tasks (BUILD/DEPLOY/VERIFY with a delivery block) belong to the final slice — plan implementation, testing and review tasks here`
    );
  } else if (task.type === "DEPLOY") {
    const action = task.delivery?.action;
    if (action === undefined || !DEPLOYABLE_DELIVERY_ACTIONS.has(action)) {
      errors.push(
        `Task ${task.id} is a DEPLOY task without a deployable delivery block (action DEPLOY or ROLLBACK); it would resolve to no professional agent`
      );
    }
  }

  if (options.deliveryConfigured === false && task.delivery) {
    errors.push(
      `Task ${task.id} plans delivery work (${task.delivery.action}) but the project has no Git repository bound; CI and deployment cannot run — plan implementation, testing and review tasks only`
    );
  }

  // F1-4：全局性 AC（Deploy/Doc 类验证）只允许出现在最终集成切片。
  if (
    options.isFinalSlice === false &&
    options.globalAcKeys !== undefined &&
    options.globalAcKeys.length > 0
  ) {
    const globalKeys = new Set(options.globalAcKeys.map(canonicalAcKey));
    const hits = (task.acKeys ?? []).filter((key) => globalKeys.has(canonicalAcKey(key)));
    if (hits.length > 0) {
      errors.push(
        `Task ${task.id} carries global acceptance criteria (${hits.join(", ")}) that must be delivered by the final slice (GLOBAL_AC_OUTSIDE_FINAL_SLICE); remove them here — deployment/documentation acceptance is verified once the whole system exists`
      );
    }
  }
  return errors;
}

export interface TaskGraphValidationOptions {
  /**
   * 项目是否具备交付能力（已绑定 Git 仓库）。显式 false 时，计划里不得出现任何 delivery
   * 任务（CI / 部署 / 交付验证）—— 运行期 DeploymentOrchestrator 会直接以
   * REPOSITORY_NOT_CONFIGURED 失败（真实案例 2026-09-29：交付链 4 个任务全部瞬失败）。
   * undefined = 不校验，保持既有行为。
   */
  deliveryConfigured?: boolean;
  /**
   * F1-3：当前切片是否最终切片（序号与总数由上层依据 `requirement_slices.slice_order` 传入）。
   * 显式 false 时交付链任务触发 `DELIVERY_TASK_OUTSIDE_FINAL_SLICE`；undefined = 不校验
   * （单级 full 模式与非切片场景维持既有行为）。
   */
  isFinalSlice?: boolean;
  /**
   * F1-4：全局性 AC 编号（Deploy/Doc 类验证；上层由 AC 记录判定后传入）。
   * 显式 false 的切片（非最终）任务引用其中任一编号 → `GLOBAL_AC_OUTSIDE_FINAL_SLICE`；
   * undefined = 不校验（单级 full 模式与非切片场景维持既有行为）。
   */
  globalAcKeys?: string[];
}

export function taskEdges(plan: TaskPlan): TaskGraphEdge[] {
  return plan.tasks.flatMap((task) =>
    task.dependencies.map((dependency) => ({
      sourceTaskId: dependency,
      targetTaskId: task.id
    }))
  );
}

export function validateTaskGraph(
  plan: TaskPlan,
  options: TaskGraphValidationOptions = {}
): TaskGraphValidationResult {
  const errors: string[] = [];
  const ids = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const task of plan.tasks) {
    if (ids.has(task.id)) {
      duplicateIds.add(task.id);
    }
    ids.add(task.id);
  }

  for (const id of duplicateIds) {
    errors.push(`Duplicate task id: ${id}`);
  }

  for (const task of plan.tasks) {
    errors.push(...executabilityErrors(task, options));
  }

  const edgeKeys = new Set<string>();
  const edges: TaskGraphEdge[] = [];
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of ids) {
    inDegree.set(id, 0);
    outDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const task of plan.tasks) {
    for (const dependency of task.dependencies) {
      const edgeKey = `${dependency}->${task.id}`;
      if (!ids.has(dependency)) {
        errors.push(`Dependency points to missing task: ${dependency} -> ${task.id}`);
        continue;
      }
      if (dependency === task.id) {
        errors.push(`Task cannot depend on itself: ${task.id}`);
        continue;
      }
      if (edgeKeys.has(edgeKey)) {
        errors.push(`Duplicate dependency: ${edgeKey}`);
        continue;
      }

      edgeKeys.add(edgeKey);
      edges.push({ sourceTaskId: dependency, targetTaskId: task.id });
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      outDegree.set(dependency, (outDegree.get(dependency) ?? 0) + 1);
      adjacency.set(dependency, [...(adjacency.get(dependency) ?? []), task.id]);
    }
  }

  const roots = [...inDegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  const leaves = [...outDegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);

  if (roots.length === 0) {
    errors.push("Task DAG must contain at least one root task");
  }

  if (leaves.length === 0) {
    errors.push("Task DAG must contain at least one leaf task");
  }

  const queue = [...roots];
  let visited = 0;
  const remainingInDegree = new Map(inDegree);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    visited += 1;

    for (const next of adjacency.get(current) ?? []) {
      const nextDegree = (remainingInDegree.get(next) ?? 0) - 1;
      remainingInDegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
      }
    }
  }

  if (visited !== ids.size) {
    errors.push("Cycle detected in Task DAG");
  }

  return {
    valid: errors.length === 0,
    errors,
    roots,
    leaves,
    edges
  };
}

export function assertValidTaskGraph(plan: TaskPlan): TaskGraphValidationResult {
  const result = validateTaskGraph(plan);
  if (!result.valid) {
    throw new TaskGraphValidationError(result.errors);
  }

  return result;
}
