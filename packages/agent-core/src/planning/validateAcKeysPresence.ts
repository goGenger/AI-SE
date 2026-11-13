/**
 * F1-1（发现②）：AC 覆盖保护缺输入检测。
 *
 * 需求存在 AC 记录（本计划范围内）而计划未携带任何 acKeys 时，N4 测试先行校验与 AC 覆盖
 * 检查会整体退化为空转（"先实现后测试"等违规被静默放行）——直接判失败（PLAN_ACKEYS_MISSING）
 * 并进入修复流程，而不是静默跳过。
 * 本计划范围内没有 AC 记录（编号 PRD 与 N3 库记录皆空）时才允许跳过，并以 acProtection=none
 * 显式标注（见 PlanningGraph 的 AC_PROTECTION_NONE 事件与计划产出负载）。
 */
export interface AcKeysPresenceInput {
  tasks: Array<{ id: string; acKeys?: string[] }>;
  /** 本计划范围内的 AC 记录数（0 = 无记录，允许跳过并标注 acProtection=none）。 */
  inScopeCriteriaCount: number;
}

export interface AcKeysPresenceResult {
  errors: string[];
  acProtection: "enforced" | "none";
}

export function validateAcKeysPresence(input: AcKeysPresenceInput): AcKeysPresenceResult {
  if (input.inScopeCriteriaCount === 0) {
    return { errors: [], acProtection: "none" };
  }

  const planCarriesAcKeys = input.tasks.some((task) => (task.acKeys ?? []).length > 0);
  if (planCarriesAcKeys) {
    return { errors: [], acProtection: "enforced" };
  }

  return {
    errors: [
      `PLAN_ACKEYS_MISSING: The requirement defines acceptance criteria (in scope: ${input.inScopeCriteriaCount}) but no task carries acKeys; test-first and AC coverage checks would be skipped. Provide acKeys on the tasks that deliver acceptance criteria.`
    ],
    acProtection: "enforced"
  };
}
