import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_POLICY,
  isAutonomyAtLeastL1,
  L1_WORKFLOW_POLICY,
  resolveSliceWorkflowPolicy,
  SLICE_WORKFLOW_POLICY,
  WorkflowPolicySchema
} from "./index";

/**
 * 自治 L1 的策略载体（L1-7，`docs/154` §3）。
 * 两条要钉住的东西：① `autonomyLevel` 只在显式声明时生效；② 未声明时与既有版本逐项一致。
 */

/** 本次改动之前就存在的策略形状——它必须原样继续通过（既有工作流不受影响）。 */
const LEGACY_POLICY = {
  maxConcurrency: 1,
  maxRetries: 1,
  failureStrategy: "FAIL_FAST",
  allowRetry: true,
  allowReplan: false,
  approvalRequired: false
};

describe("autonomy L1 policy carrier (L1-7)", () => {
  it("keeps the pre-existing policy shape valid and unchanged", () => {
    const parsed = WorkflowPolicySchema.parse(LEGACY_POLICY);
    expect(parsed).toEqual({ ...LEGACY_POLICY });
    expect(parsed.autonomyLevel).toBeUndefined();
    expect(parsed.deployFailureStrategy).toBeUndefined();
    expect(isAutonomyAtLeastL1(parsed)).toBe(false);
  });

  it("does not put an autonomy level into the default policy", () => {
    expect(DEFAULT_WORKFLOW_POLICY.autonomyLevel).toBeUndefined();
    expect(DEFAULT_WORKFLOW_POLICY.deployFailureStrategy).toBeUndefined();
    expect(isAutonomyAtLeastL1(DEFAULT_WORKFLOW_POLICY)).toBe(false);
  });

  it("accepts L1 with its deploy-failure strategy and reports it as autonomous", () => {
    const parsed = WorkflowPolicySchema.parse({
      ...LEGACY_POLICY,
      autonomyLevel: "L1",
      deployFailureStrategy: "ROLLBACK"
    });
    expect(isAutonomyAtLeastL1(parsed)).toBe(true);
    expect(parsed.deployFailureStrategy).toBe("ROLLBACK");
  });

  it("accepts L2 as a defined level while still rejecting L3 and malformed values", () => {
    // `docs/227`：L2 已定义（关口 1 纳入自治），L3 仍未定义、不预留空壳值。
    for (const level of ["L3", "l1", "l2", "AUTONOMOUS"]) {
      expect(WorkflowPolicySchema.safeParse({ ...LEGACY_POLICY, autonomyLevel: level }).success).toBe(
        false
      );
    }
    expect(
      WorkflowPolicySchema.safeParse({ ...LEGACY_POLICY, deployFailureStrategy: "FAIL" }).success
    ).toBe(false);
  });

  it("L2 ⊇ L1: the L1 baseline predicate is true for both levels", () => {
    const l1 = WorkflowPolicySchema.parse({ ...LEGACY_POLICY, autonomyLevel: "L1" });
    const l2 = WorkflowPolicySchema.parse({ ...LEGACY_POLICY, autonomyLevel: "L2" });
    expect(isAutonomyAtLeastL1(l1)).toBe(true);
    expect(isAutonomyAtLeastL1(l2)).toBe(true);
    expect(isAutonomyAtLeastL1(WorkflowPolicySchema.parse(LEGACY_POLICY))).toBe(false);
  });

  it("still rejects unknown keys (strictness is not weakened by the new fields)", () => {
    expect(
      WorkflowPolicySchema.safeParse({ ...LEGACY_POLICY, autonomy: true }).success
    ).toBe(false);
  });

  it("the L1 preset is schema-valid, and never carries an approval waiver", () => {
    const parsed = WorkflowPolicySchema.parse({ ...DEFAULT_WORKFLOW_POLICY, ...L1_WORKFLOW_POLICY });
    expect(parsed).toEqual({
      ...DEFAULT_WORKFLOW_POLICY,
      ...L1_WORKFLOW_POLICY
    });
    expect(isAutonomyAtLeastL1(parsed)).toBe(true);
    expect(parsed.maxRetries).toBe(2); // L1-5 的裁定上限
    // PL-M18（N-11）：L1 预设由 RETRY 改为 REPLAN 并打开 allowReplan（两处必须成对，
    // 否则 REPLAN 分支不可达——`WorkflowEngine` 的闸门是 `strategy === "REPLAN" && allowReplan`）。
    expect(parsed.failureStrategy).toBe("REPLAN");
    expect(parsed.allowReplan).toBe(true);
    // L1-9 红线：预设不得携带能关闭人工门的字段。
    expect(Object.keys(L1_WORKFLOW_POLICY)).not.toContain("approvalRequired");
  });
});

describe("slice autonomy workflow policy", () => {
  it("SLICE_WORKFLOW_POLICY matches L1 repair defaults", () => {
    expect(SLICE_WORKFLOW_POLICY).toEqual(L1_WORKFLOW_POLICY);
    const resolved = resolveSliceWorkflowPolicy();
    expect(resolved.failureStrategy).toBe("REPLAN");
    expect(resolved.allowReplan).toBe(true);
    expect(isAutonomyAtLeastL1(resolved)).toBe(true);
  });

  it("DEFAULT remains FAIL_FAST for non-slice / manual workflows", () => {
    expect(DEFAULT_WORKFLOW_POLICY.failureStrategy).toBe("FAIL_FAST");
    expect(DEFAULT_WORKFLOW_POLICY.allowReplan).toBe(false);
  });

  it("upgrades inherited FAIL_FAST to slice REPLAN autonomy", () => {
    const upgraded = resolveSliceWorkflowPolicy({
      ...DEFAULT_WORKFLOW_POLICY,
      failureStrategy: "FAIL_FAST",
      allowReplan: false
    });
    expect(upgraded.failureStrategy).toBe("REPLAN");
    expect(upgraded.allowReplan).toBe(true);
    expect(upgraded.autonomyLevel).toBe("L1");
    expect(upgraded.maxRetries).toBe(2);
  });
});
