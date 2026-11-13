import { AcceptanceCriterion, TaskType } from "@ai-se/shared";
import { selectAcceptanceCriteriaForSlice } from "./acceptanceCriteria";

/**
 * N4 测试先行规则（确定性校验，零 LLM）：
 * - 顺序：实现类任务与 TEST 任务覆盖相同 AC 时，实现任务必须（传递）依赖 TEST 任务；
 * - 覆盖：切片范围内每个 Must AC 至少被一个 TEST 任务引用（reviewer 对应关系校验的计划期部分）。
 * 无编号 AC（criteria 为空）→ 跳过，保持既有行为。
 */

export interface TestFirstTask {
  id: string;
  type: TaskType;
  acKeys?: string[];
  dependencies: string[];
}

export interface TestFirstValidationInput {
  tasks: TestFirstTask[];
  criteria: AcceptanceCriterion[];
  /** 切片 FR 范围（第二级）；缺省 = 全需求 AC 参与。 */
  frKeys?: string[];
  /** F1-4：切片级归属（非最终切片剔除全局性 AC；最终切片并入全部全局性 AC）。 */
  isFinalSlice?: boolean;
}

/**
 * 实现类任务类型——「测试先行」与「实现覆盖」两个校验器共用同一份定义。
 * 注意与 `apps/server` 的 `DEV_TASK_TYPES`（多一个 `DEBUG`）**不是**同一口径：后者是
 * 切片边界绿灯的锚点判定（计划外修复任务也算），本表是计划期「谁负责把红灯转绿」。
 */
export const IMPLEMENTATION_TYPES: readonly TaskType[] = ["BACKEND", "FRONTEND", "DATABASE"];

/** 依赖闭包：任务 → 其全部（传递）依赖；环安全（占位缓存）。PL-M9 9b 的脚本提供者守卫复用同一实现。 */
export function dependencyClosure(
  tasks: ReadonlyArray<{ id: string; dependencies: string[] }>
): Map<string, Set<string>> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cache = new Map<string, Set<string>>();
  const closure = (id: string, stack: Set<string>): Set<string> => {
    const cached = cache.get(id);
    if (cached) return cached;
    const result = new Set<string>();
    cache.set(id, result);
    if (stack.has(id)) return result;
    stack.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      result.add(dependency);
      for (const found of closure(dependency, stack)) {
        result.add(found);
      }
    }
    stack.delete(id);
    return result;
  };
  return new Map(tasks.map((task) => [task.id, closure(task.id, new Set())]));
}

/** F1-3：待补的测试先行依赖边（实现任务 → 应依赖的测试任务）。 */
export interface TestFirstEdgeRepair {
  implementationTaskId: string;
  testTaskId: string;
  sharedAcKeys: string[];
}

/**
 * F1-3（发现③）：测试先行「补边」清单——与校验器同源（同一遍历），供确定性自动修复层消费。
 * 仅列出**未满足**的对（实现任务尚未传递依赖该测试任务）；criteria 为空时不产生（保持既有行为）。
 *
 * N-70（`docs/232` §10）：**按 AC 判定，不按「实现任务 × 每个 TEST 任务」逐对判定**。
 *
 * 旧口径要求实现任务依赖**每一个**与它共享 AC 的 TEST 任务。切片里一旦同时存在「写红灯测试」
 * 与「跑全片验证」两个 TEST 任务，规划器写对的 `实现 → 收尾验证` 就会被判成倒置边，自动修复
 * 把它反转，验证任务于是成了 DAG 的根、先跑先红（第十轮 slice-4 的 `T6`）。
 *
 * 新口径回到规则本意：**对实现任务覆盖的每条 AC，只要已经传递依赖任一覆盖它的 TEST 任务即可**；
 * 只有某条 AC 的所有 TEST 任务都排在它之后时，才从覆盖它的 TEST 任务里取第一个补边。
 * 收尾验证任务因此留在最后，红灯测试仍然先写。
 */
export function listTestFirstEdgeRepairs(input: TestFirstValidationInput): TestFirstEdgeRepair[] {
  if (input.criteria.length === 0) {
    return [];
  }

  const repairs: TestFirstEdgeRepair[] = [];
  const closures = dependencyClosure(input.tasks);
  const testTasks = input.tasks.filter((task) => task.type === "TEST");

  for (const task of input.tasks) {
    if (!IMPLEMENTATION_TYPES.includes(task.type)) continue;
    const acKeys = [...new Set(task.acKeys ?? [])];
    if (acKeys.length === 0) continue;

    const closure = closures.get(task.id);
    // 每条 AC 单独判定；未满足的 AC 按「补边目标」归组，保证一个 (实现, 测试) 对只出一条修复。
    const unsatisfiedByTest = new Map<string, string[]>();
    for (const acKey of acKeys) {
      const covering = testTasks.filter((entry) => (entry.acKeys ?? []).includes(acKey));
      if (covering.length === 0) continue; // 完全没有测试覆盖 → 由 MustAcTestCoverage 负责
      if (covering.some((entry) => closure?.has(entry.id))) continue;
      const target = covering[0];
      if (!target) continue;
      unsatisfiedByTest.set(target.id, [...(unsatisfiedByTest.get(target.id) ?? []), acKey]);
    }

    for (const [testTaskId, sharedAcKeys] of unsatisfiedByTest) {
      repairs.push({
        implementationTaskId: task.id,
        testTaskId,
        sharedAcKeys
      });
    }
  }

  return repairs;
}

export function validateTestFirstOrder(input: TestFirstValidationInput): string[] {
  return listTestFirstEdgeRepairs(input).map(
    (repair) =>
      `Implementation task ${repair.implementationTaskId} must depend on test task ${repair.testTaskId} (shared ACs: ${repair.sharedAcKeys.join(", ")}) to keep tests first.`
  );
}

export function validateMustAcTestCoverage(input: TestFirstValidationInput): string[] {
  if (input.criteria.length === 0) {
    return [];
  }

  const coveredByTests = new Set<string>();
  for (const task of input.tasks) {
    if (task.type !== "TEST") continue;
    for (const key of task.acKeys ?? []) {
      coveredByTests.add(key);
    }
  }

  const errors: string[] = [];
  for (const ac of selectAcceptanceCriteriaForSlice(input.criteria, input.frKeys, {
    ...(input.isFinalSlice !== undefined ? { isFinalSlice: input.isFinalSlice } : {})
  })) {
    if (ac.priority === "Must" && !coveredByTests.has(ac.acKey)) {
      errors.push(`Must acceptance criterion ${ac.acKey} has no TEST task coverage.`);
    }
  }
  return errors;
}
