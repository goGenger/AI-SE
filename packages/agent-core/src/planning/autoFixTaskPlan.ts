import { AcceptanceCriterion, DeliveryTask, TaskPlanItem } from "@ai-se/shared";
import { dependencyClosure, listTestFirstEdgeRepairs } from "./validateTestFirstPlan";
import { isTestFirstMandatedEdge, listScriptConsumers, listScriptProviders } from "./validateScriptProviders";
import { isDeliveryChainTask, taskEdges } from "./validateTaskGraph";

/**
 * F1-3（发现③）：LLM 修复循环**之前**的确定性自动修复层。
 *
 * 规则白名单（只增依赖边 + 只补交付块字段；不增删任务、不改 AC 映射）：
 * - 测试先行依赖：对每个未满足的（实现任务，测试任务）对补一条依赖边；
 *   补边会成环时，先断开环上**倒置的测试先行边**（「测试依赖实现」，N4 否定的方向）再补正边；
 *   没有可断的倒置边才记录环路径（交 LLM 修复路径处理）——N-46。
 * - DEPLOY 交付块缺失：仅最终切片（isFinalSlice === true）且调用方给出补块环境时，
 *   按「块仅需 action + environment」补全；非最终切片不补块（由归属守卫拦截）。
 * - PL-M9 9b **脚本提供者先于消费者**：TEST 任务必须（传递）依赖声明了 `test` script 的任务。
 *   本规则**扩了白名单**——run 1 的实测形状是**倒置边**（提供者依赖消费者），只增边必然成环，
 *   故须先删除该倒置边再补边（删除边不可能造环，见 `docs/166` §4 裁定 4）。
 *   若该倒置边恰是 N4 强制的「实现任务 → 测试任务（共享 AC）」边，则两个要求同时成立、计划无解
 *   ——不删边，记 blocked 交 LLM 修复轮。
 *
 * 调用方负责把 fixes 记为 `PLAN_AUTOFIXED` 事件（规则、对象、前后差异）、blocked 记环路径。
 */

export interface TaskPlanAutoFixFix {
  rule: "non-final-slice-delivery" | "test-first-edge" | "delivery-block" | "script-provider-edge";
  taskId: string;
  detail: Record<string, unknown>;
}

export interface TaskPlanAutoFixBlocked {
  implementationTaskId: string;
  testTaskId: string;
  /**
   * 既有依赖路径（`implementationTaskId → … → testTaskId`）；新边与其构成环。
   * PL-M9 9b 复用本形状报告「N4 与脚本提供者守卫同时成立」的无解冲突（提供者为实现类任务时）。
   */
  cyclePath: string[];
  /** 触发本条的规则；缺省 = `test-first-edge`（规则 1，既有事件形状不变）。 */
  rule?: "script-provider-edge";
}

export interface TaskPlanAutoFixResult {
  tasks: TaskPlanItem[];
  fixes: TaskPlanAutoFixFix[];
  blocked: TaskPlanAutoFixBlocked[];
}

export interface TaskPlanAutoFixInput {
  tasks: TaskPlanItem[];
  criteria: AcceptanceCriterion[];
  /** 切片 FR 范围（第二级）；缺省 = 全需求。 */
  frKeys?: string[];
  /** 显式 false = 非最终切片（不补块）；true/undefined 时才可能补块（undefined 亦不补——仅最终切片）。 */
  isFinalSlice?: boolean;
  /** 补块环境名（来自项目 deployment_environments；缺省/空 = 不能补块）。 */
  deliveryEnvironment?: string | null;
}

const DEPLOYABLE_ACTIONS = new Set(["DEPLOY", "ROLLBACK"]);

function cloneTasks(tasks: TaskPlanItem[]): TaskPlanItem[] {
  return tasks.map((task) => ({
    ...task,
    ...(task.dependencies ? { dependencies: [...task.dependencies] } : {}),
    ...(task.acKeys ? { acKeys: [...task.acKeys] } : {}),
    ...(task.providesScripts ? { providesScripts: [...task.providesScripts] } : {}),
    ...(task.delivery ? { delivery: { ...task.delivery } } : {})
  }));
}

function adjacencyOf(tasks: TaskPlanItem[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of taskEdges({ summary: "autofix", tasks })) {
    adjacency.set(edge.sourceTaskId, [
      ...(adjacency.get(edge.sourceTaskId) ?? []),
      edge.targetTaskId
    ]);
  }
  return adjacency;
}

/** BFS：沿「依赖 → 依赖方」方向求 from → to 的路径；无路径返回 null。 */
function findDependencyPath(
  adjacency: Map<string, string[]>,
  from: string,
  to: string
): string[] | null {
  const queue: string[][] = [[from]];
  const seen = new Set<string>([from]);
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) break;
    const last = path[path.length - 1];
    if (last === to) {
      return path;
    }
    for (const next of adjacency.get(last ?? "") ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

/**
 * N-46（`docs/232` §9.9）：边 `source → target` 表示「target 依赖 source」。
 * `isTestFirstMandatedEdge(a, b)` 判定的是「a 是实现类、b 是 TEST、共享 AC」——放进 adjacency，
 * 它描述的正是「TEST 依赖实现」这条 **N4 否定的倒置边**。判定只保留一份，这里直接复用。
 */
function isInvertedTestFirstEdge(source: TaskPlanItem, target: TaskPlanItem): boolean {
  return isTestFirstMandatedEdge(source, target);
}

/**
 * N-46：补边成环时，沿着 `from → to` 的既有路径逐条断开**倒置的测试先行边**，直到不再成环。
 * 返回被删掉的边（供事件留痕）；没有可断的倒置边时原样返回，由调用方记 `cycle-blocked` 交 LLM。
 */
function breakInvertedTestFirstEdges(
  tasks: TaskPlanItem[],
  byId: Map<string, TaskPlanItem>,
  from: string,
  to: string
): Array<{ sourceTaskId: string; targetTaskId: string }> {
  const removedEdges: Array<{ sourceTaskId: string; targetTaskId: string }> = [];
  const maxIterations = tasks.reduce((sum, task) => sum + task.dependencies.length, 0) + 1;
  for (let guard = 0; guard < maxIterations; guard += 1) {
    const path = findDependencyPath(adjacencyOf(tasks), from, to);
    if (!path || path.length < 2) break;
    let removed = false;
    for (let index = 0; index + 1 < path.length; index += 1) {
      const source = byId.get(path[index] ?? "");
      const target = byId.get(path[index + 1] ?? "");
      if (!source || !target) continue;
      if (!isInvertedTestFirstEdge(source, target)) continue;
      target.dependencies = target.dependencies.filter((id) => id !== source.id);
      removedEdges.push({ sourceTaskId: source.id, targetTaskId: target.id });
      removed = true;
      break;
    }
    if (!removed) break;
  }
  return removedEdges;
}

export function autoFixTaskPlan(input: TaskPlanAutoFixInput): TaskPlanAutoFixResult {  let tasks = cloneTasks(input.tasks);
  let byId = new Map(tasks.map((task) => [task.id, task]));
  const fixes: TaskPlanAutoFixFix[] = [];
  const blocked: TaskPlanAutoFixBlocked[] = [];

  // 规则 0（N-41）：非最终切片不得出现交付链任务。
  //
  // 校验器对这个形态直接判死（`DELIVERY_TASK_OUTSIDE_FINAL_SLICE`），而实测模型连续
  // 3 轮修复都不把交付任务挪走——整次运行的规划就死在这里。这是**确定性的形态错误**，
  // 不该指望模型自愈：直接把这些任务从本切片剔出（它们本来就该由最终切片产出），
  // 并清掉其它任务对它们的依赖引用，避免留下悬空边。
  //
  // 必须是第一条规则：后面的规则都基于任务图，先删再修才不会被已删任务带偏。
  if (input.isFinalSlice === false) {
    const removed = tasks.filter((task) => isDeliveryChainTask(task));
    if (removed.length > 0) {
      const removedIds = new Set(removed.map((task) => task.id));
      tasks = tasks.filter((task) => !removedIds.has(task.id));
      for (const task of tasks) {
        task.dependencies = task.dependencies.filter((id) => !removedIds.has(id));
      }
      byId = new Map(tasks.map((task) => [task.id, task]));
      for (const task of removed) {
        fixes.push({
          rule: "non-final-slice-delivery",
          taskId: task.id,
          detail: { taskId: task.id, type: task.type, delivery: task.delivery ?? null }
        });
      }
    }
  }

  // 规则 1：测试先行依赖边（只增边；成环不修、记录环路径）。
  const repairs = listTestFirstEdgeRepairs({
    tasks,
    criteria: input.criteria,
    ...(input.frKeys ? { frKeys: input.frKeys } : {})
  });
  for (const repair of repairs) {
    const implementation = byId.get(repair.implementationTaskId);
    const test = byId.get(repair.testTaskId);
    if (!implementation || !test) continue;
    if (implementation.dependencies.includes(test.id)) continue;

    // N-46（`docs/232` §9.9）：成环时先断开环上**倒置的测试先行边**（「测试依赖实现」）再补正边。
    // 实测：部署类 AC 上模型三轮都写「部署测试排在部署实现之后」，只记 `cycle-blocked` 交 LLM
    // 会让整片规划连续失败（11 次 cycle-blocked / 3 次校验失败）。没有可断的倒置边时口径不变。
    let removedEdges: Array<{ sourceTaskId: string; targetTaskId: string }> = [];
    if (findDependencyPath(adjacencyOf(tasks), implementation.id, test.id)) {
      removedEdges = breakInvertedTestFirstEdges(tasks, byId, implementation.id, test.id);
      const remaining = findDependencyPath(adjacencyOf(tasks), implementation.id, test.id);
      if (remaining) {
        blocked.push({
          implementationTaskId: implementation.id,
          testTaskId: test.id,
          cyclePath: [test.id, ...remaining]
        });
        continue;
      }
    }

    implementation.dependencies.push(test.id);
    fixes.push({
      rule: "test-first-edge",
      taskId: implementation.id,
      detail: {
        implementationTaskId: implementation.id,
        testTaskId: test.id,
        addedDependency: test.id,
        sharedAcKeys: repair.sharedAcKeys,
        ...(removedEdges.length > 0 ? { removedEdges } : {})
      }
    });
  }

  // 规则 3（PL-M9 9b）：脚本提供者先于消费者——TEST 任务必须（传递）依赖声明了 `test` script 的任务。
  // 必须排在规则 1 **之后**：规则 1 补的「实现 → 测试」边是 N4 强制的，本规则遇到它只记 blocked 不删边；
  // 反序会先补「测试 → 提供者」再被规则 1 补回反向边，成环。
  const providers = listScriptProviders(tasks);
  if (providers.length > 0) {
    const maxIterations = tasks.reduce((sum, task) => sum + task.dependencies.length, 0) + 1;
    for (const consumer of listScriptConsumers(tasks)) {
      const reached = dependencyClosure(tasks).get(consumer.id) ?? new Set<string>();
      if (providers.some((provider) => reached.has(provider.id))) continue;
      const provider = providers.find((entry) => entry.id !== consumer.id);
      if (!provider) continue;

      // 补边方向是「消费者 → 提供者」。它在「提供者（传递）依赖消费者」时成环——即依赖图的下游
      // 方向存在「消费者 → … → 提供者」路径（`adjacency` 是「被依赖方 → 依赖方」）。
      // 逐个断开该路径的首边（`taskEdges` 的 source = 被依赖方、target = 依赖方）。
      const removedEdges: Array<{ sourceTaskId: string; targetTaskId: string }> = [];
      let conflict: string[] | null = null;
      for (let guard = 0; guard < maxIterations; guard += 1) {
        const path = findDependencyPath(adjacencyOf(tasks), consumer.id, provider.id);
        if (!path || path.length < 2) break;
        const source = byId.get(path[0] ?? "");
        const target = byId.get(path[1] ?? "");
        if (!source || !target) break;
        // 该边若恰是 N4 强制的「实现任务 → 测试任务（共享 AC）」边，两个要求同时成立、计划无解。
        if (isTestFirstMandatedEdge(target, source)) {
          conflict = path;
          break;
        }
        target.dependencies = target.dependencies.filter((id) => id !== source.id);
        removedEdges.push({ sourceTaskId: source.id, targetTaskId: target.id });
      }
      if (conflict) {
        blocked.push({
          implementationTaskId: provider.id,
          testTaskId: consumer.id,
          cyclePath: conflict,
          rule: "script-provider-edge"
        });
        continue;
      }

      consumer.dependencies.push(provider.id);
      fixes.push({
        rule: "script-provider-edge",
        taskId: consumer.id,
        detail: {
          consumerTaskId: consumer.id,
          providerTaskId: provider.id,
          addedDependency: provider.id,
          removedEdges
        }
      });
    }
  }

  // 规则 2：DEPLOY 交付块补全（仅最终切片；块仅需 action + environment）。
  const environment = input.deliveryEnvironment?.trim();
  if (input.isFinalSlice === true && environment) {
    for (const task of tasks) {
      if (task.type !== "DEPLOY") continue;
      const current = task.delivery;
      const action = current?.action;
      const deployable = action !== undefined && DEPLOYABLE_ACTIONS.has(action);
      const currentEnvironment = current?.environment;
      const hasEnvironment = typeof currentEnvironment === "string";
      if (deployable && hasEnvironment) continue;

      const before = current ? { ...current } : null;
      task.delivery = {
        ...(current ?? {}),
        action: (deployable ? action : "DEPLOY") as DeliveryTask["action"],
        environment: (hasEnvironment
          ? currentEnvironment
          : environment) as DeliveryTask["environment"]
      };
      fixes.push({
        rule: "delivery-block",
        taskId: task.id,
        detail: { taskId: task.id, before, after: { ...task.delivery } }
      });
    }
  }

  return { tasks, fixes, blocked };
}
