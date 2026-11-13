import { describe, expect, it } from "vitest";
import {
  AUTONOMY_DECISION_EVENT_TYPES,
  AUTONOMY_DECISION_PAYLOAD_SCHEMAS,
  parseAutonomyDecisionPayload
} from "./index";

/**
 * 7-E：自治决策事件契约（OB-09）。四个事件各有合法 / 非法 payload 断言，
 * 另钉住两条不变量（自动批准仅 staging、自动重试有界）与 `.strict()` 的封闭性。
 */

const base = {
  policyId: "L1",
  reason: "staging 部署在 L1 策略下自动执行",
  workflowRunId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222"
};

describe("autonomy decision event contract (7-E)", () => {
  it("maps every declared event type to exactly one payload schema", () => {
    expect(AUTONOMY_DECISION_EVENT_TYPES).toEqual([
      "AUTO_APPROVED",
      "AUTO_RETRIED",
      "AUTO_ROLLED_BACK",
      "VERIFICATION_ENFORCED_FAILURE",
      "GATE1_AUTO_APPROVED"
    ]);
    expect(Object.keys(AUTONOMY_DECISION_PAYLOAD_SCHEMAS).sort()).toEqual(
      [...AUTONOMY_DECISION_EVENT_TYPES].sort()
    );
  });

  it("GATE1_AUTO_APPROVED is requirement-scoped, not workflow-scoped", () => {
    const schema = AUTONOMY_DECISION_PAYLOAD_SCHEMAS.GATE1_AUTO_APPROVED;
    const valid = {
      policyId: "L2",
      reason: "slice plan satisfied all deterministic gate-1 criteria",
      requirementId: "11111111-1111-4111-8111-111111111111",
      sliceCount: 3,
      satisfiedReasons: ["fr-coverage", "slice-scope"],
      estimatedFinalSliceTasks: 7
    };
    expect(schema.safeParse(valid).success).toBe(true);
    // 关口 1 发生在任何工作流之前：`workflowRunId` / `taskId` 在这条契约里**不存在**。
    expect(schema.safeParse({ ...valid, workflowRunId: base.workflowRunId }).success).toBe(false);
    expect(schema.safeParse({ ...valid, taskId: base.taskId }).success).toBe(false);
    // 空判据列表不可表达（自动批准必须有依据）。
    expect(schema.safeParse({ ...valid, satisfiedReasons: [] }).success).toBe(false);
  });

  it("AUTO_APPROVED accepts staging and rejects every other environment", () => {
    const schema = AUTONOMY_DECISION_PAYLOAD_SCHEMAS.AUTO_APPROVED;
    expect(
      schema.safeParse({ ...base, environment: "staging", approvalId: base.taskId }).success
    ).toBe(true);
    expect(schema.safeParse({ ...base, environment: "staging" }).success).toBe(true);
    // 生产与 dev 在契约层不可表达（L1-9：生产审批门不可由策略关闭）。
    expect(schema.safeParse({ ...base, environment: "production" }).success).toBe(false);
    expect(schema.safeParse({ ...base, environment: "dev" }).success).toBe(false);
  });

  it("AUTO_RETRIED is bounded by maxAttempts", () => {
    const schema = AUTONOMY_DECISION_PAYLOAD_SCHEMAS.AUTO_RETRIED;
    expect(schema.safeParse({ ...base, attempt: 1, maxAttempts: 2 }).success).toBe(true);
    expect(schema.safeParse({ ...base, attempt: 2, maxAttempts: 2 }).success).toBe(true);
    expect(schema.safeParse({ ...base, attempt: 3, maxAttempts: 2 }).success).toBe(false);
    expect(schema.safeParse({ ...base, attempt: 0, maxAttempts: 2 }).success).toBe(false);
    expect(schema.safeParse({ ...base, attempt: 1.5, maxAttempts: 2 }).success).toBe(false);
  });

  it("AUTO_ROLLED_BACK requires the rolled-back deployment", () => {
    const schema = AUTONOMY_DECISION_PAYLOAD_SCHEMAS.AUTO_ROLLED_BACK;
    const deploymentId = "33333333-3333-4333-8333-333333333333";
    expect(schema.safeParse({ ...base, environment: "staging", deploymentId }).success).toBe(true);
    expect(
      schema.safeParse({
        ...base,
        environment: "staging",
        deploymentId,
        rollbackDeploymentId: "44444444-4444-4444-8444-444444444444"
      }).success
    ).toBe(true);
    expect(schema.safeParse({ ...base, environment: "staging" }).success).toBe(false);
    expect(
      schema.safeParse({ ...base, environment: "staging", deploymentId: "not-a-uuid" }).success
    ).toBe(false);
    expect(
      schema.safeParse({ ...base, environment: "somewhere-else", deploymentId }).success
    ).toBe(false);
  });

  it("VERIFICATION_ENFORCED_FAILURE carries failed check names only, and only under enforce", () => {
    const schema = AUTONOMY_DECISION_PAYLOAD_SCHEMAS.VERIFICATION_ENFORCED_FAILURE;
    expect(
      schema.safeParse({ ...base, failedChecks: ["test"], gateMode: "enforce" }).success
    ).toBe(true);
    expect(schema.safeParse({ ...base, failedChecks: [], gateMode: "enforce" }).success).toBe(false);
    expect(
      schema.safeParse({ ...base, failedChecks: ["test"], gateMode: "observe" }).success
    ).toBe(false);
    // 契约只收检查名：把输出塞进来会被 `.strict()` 挡下。
    expect(
      schema.safeParse({
        ...base,
        failedChecks: ["test"],
        gateMode: "enforce",
        stdoutTail: "npm ERR!"
      }).success
    ).toBe(false);
  });

  it("rejects payloads that are missing the shared fields or carry unknown keys", () => {
    const schema = AUTONOMY_DECISION_PAYLOAD_SCHEMAS.AUTO_APPROVED;
    const { reason: _reason, ...withoutReason } = base;
    expect(schema.safeParse({ ...withoutReason, environment: "staging" }).success).toBe(false);
    expect(schema.safeParse({ ...base, environment: "staging", token: "sk-abc" }).success).toBe(
      false
    );
    expect(schema.safeParse({ ...base, environment: "staging", policyId: "" }).success).toBe(false);
    expect(schema.safeParse({ ...base, environment: "staging", workflowRunId: "wf" }).success).toBe(
      false
    );
  });

  it("parseAutonomyDecisionPayload returns the payload and throws on invalid input", () => {
    expect(
      parseAutonomyDecisionPayload("AUTO_APPROVED", { ...base, environment: "staging" })
    ).toEqual({ ...base, environment: "staging" });
    expect(() =>
      parseAutonomyDecisionPayload("AUTO_RETRIED", { ...base, attempt: 9, maxAttempts: 2 })
    ).toThrow();
  });
});
