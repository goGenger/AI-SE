import { AcceptanceCriterion } from "@ai-se/shared";
import { selectAcceptanceCriteriaForSlice } from "./acceptanceCriteria";

export interface AcceptanceCoverageInput {
  criteria: AcceptanceCriterion[];
  tasks: Array<{ id: string; acKeys?: string[] }>;
  /** 切片 FR 范围（第二级）；缺省 = 全需求 AC 参与覆盖。 */
  frKeys?: string[];
  /** F1-4：切片级归属（非最终切片剔除全局性 AC；最终切片并入全部全局性 AC）。 */
  isFinalSlice?: boolean;
}

/**
 * N3 映射覆盖检查（确定性；参照 validateSlicePlan 模式）：
 * - 每个（切片范围内的）AC 至少被一个任务的 acKeys 覆盖；
 * - 任务不得引用需求 AC 集之外的编号（无虚构）。
 * criteria 为空（无编号 PRD 且无 LLM 记录）→ 跳过检查，返回空。
 */
export function validateAcceptanceCoverage(input: AcceptanceCoverageInput): string[] {
  if (input.criteria.length === 0) {
    return [];
  }

  const errors: string[] = [];
  const known = new Set(input.criteria.map((ac) => ac.acKey));
  const referenced = new Set<string>();

  for (const task of input.tasks) {
    for (const acKey of task.acKeys ?? []) {
      if (!known.has(acKey)) {
        errors.push(`Task ${task.id} references unknown AC: ${acKey}`);
      } else {
        referenced.add(acKey);
      }
    }
  }

  for (const ac of selectAcceptanceCriteriaForSlice(input.criteria, input.frKeys, {
    ...(input.isFinalSlice !== undefined ? { isFinalSlice: input.isFinalSlice } : {})
  })) {
    if (!referenced.has(ac.acKey)) {
      errors.push(`AC not covered by any task: ${ac.acKey}`);
    }
  }

  return errors;
}
