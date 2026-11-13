import { selectAcceptanceCriteriaForSlice } from "./acceptanceCriteria";
import { IMPLEMENTATION_TYPES, TestFirstValidationInput } from "./validateTestFirstPlan";

/**
 * PL-M1（`docs/158` §3）：计划期**实现覆盖**校验——切片范围内每个 Must AC 必须至少被一个
 * 实现类任务（BACKEND / FRONTEND / DATABASE）引用。
 *
 * 与 `validateMustAcTestCoverage` 严格对称：那条管「Must AC 有测试覆盖」，这条管「Must AC 有实现
 * 覆盖」；两条合起来才闭环。缺了本条的后果（`docs/158` §1.2–1.4）：系统主动要求 TEST 任务却从不
 * 要求实现任务，而 TEST 任务的验证检查是**红灯检查**（`expectation: "fail"`，见
 * `apps/server/src/services/taskVerifierRules.ts:95-100`）——红测试在切片内判 SUCCESS，没有实现任务
 * 把它转绿，切片边界绿灯检查又因无实现锚点而不触发，交付链一路走到 CI 才炸。E1×3 三次都死在这里。
 *
 * 只报错、不自动造任务（`docs/158` §6 第 3 项裁定 A）：错误汇入 `PlanningGraph` 的既有 `errors[]`，
 * 交给既有 LLM 修复轮重规划。`autoFixTaskPlan` 的白名单明确「不增删任务」，确定性层不越界。
 * 无编号 AC（criteria 为空）→ 跳过，保持既有行为。
 */
export function validateImplementationCoverage(input: TestFirstValidationInput): string[] {
  if (input.criteria.length === 0) {
    return [];
  }

  const coveredByImplementation = new Set<string>();
  for (const task of input.tasks) {
    if (!IMPLEMENTATION_TYPES.includes(task.type)) continue;
    for (const key of task.acKeys ?? []) {
      coveredByImplementation.add(key);
    }
  }

  const errors: string[] = [];
  for (const ac of selectAcceptanceCriteriaForSlice(input.criteria, input.frKeys, {
    ...(input.isFinalSlice !== undefined ? { isFinalSlice: input.isFinalSlice } : {})
  })) {
    if (ac.priority === "Must" && !coveredByImplementation.has(ac.acKey)) {
      errors.push(`Must acceptance criterion ${ac.acKey} has no implementation task coverage.`);
    }
  }
  return errors;
}
