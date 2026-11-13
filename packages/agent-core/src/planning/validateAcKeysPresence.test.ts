import { describe, expect, it } from "vitest";
import { validateAcKeysPresence } from "./validateAcKeysPresence";

/** F1-1：AC 保护缺输入守卫（纯规则单测）。 */

describe("validateAcKeysPresence（F1-1：缺输入失败，不再静默跳过）", () => {
  it("FX-01：有 AC 记录而计划无 acKeys → PLAN_ACKEYS_MISSING", () => {
    const result = validateAcKeysPresence({
      tasks: [{ id: "T1" }, { id: "T2", acKeys: [] }],
      inScopeCriteriaCount: 11
    });

    expect(result.acProtection).toBe("enforced");
    expect(result.errors).toEqual([
      "PLAN_ACKEYS_MISSING: The requirement defines acceptance criteria (in scope: 11) but no task carries acKeys; test-first and AC coverage checks would be skipped. Provide acKeys on the tasks that deliver acceptance criteria."
    ]);
  });

  it("至少一个任务带 acKeys → 通过（N4/覆盖检查照常执行）", () => {
    expect(
      validateAcKeysPresence({
        tasks: [{ id: "T1" }, { id: "T2", acKeys: ["AC-01"] }],
        inScopeCriteriaCount: 11
      })
    ).toEqual({ errors: [], acProtection: "enforced" });
  });

  it("FX-02（纯规则部分）：本计划范围无 AC 记录 → 允许跳过并标注 acProtection=none", () => {
    expect(
      validateAcKeysPresence({
        tasks: [{ id: "T1" }, { id: "T2" }],
        inScopeCriteriaCount: 0
      })
    ).toEqual({ errors: [], acProtection: "none" });
  });
});
