import { describe, expect, it } from "vitest";
import { isRuntimeOnlyTaskType, isUsableTargetTaskType, TaskTypeSchema } from "./index";

/**
 * PL-C3（`docs/161` Known Issue 4）：**唯一**的「运行期专属任务类型」与「可用目标工作类型」判据。
 * 上移到 shared 之前，同一语义有两份副本（`agent-core/src/planning/validateTaskGraph.ts`、
 * `workflow-engine/src/WorkflowEngine.ts`，后者注释自陈「同义」），第三份正要在 `AgentRegistry` 出现。
 * 重复定义必然漂移——这正是 PL-M5 那类缺陷的成因类型。
 */

describe("isRuntimeOnlyTaskType (PL-C3)", () => {
  it("recognizes the types the Workflow Engine creates itself", () => {
    expect(isRuntimeOnlyTaskType("DEBUG")).toBe(true);
    expect(isRuntimeOnlyTaskType("MONITOR")).toBe(true);
    expect(isRuntimeOnlyTaskType("INCIDENT")).toBe(true);
  });

  it("does not flag work types that a professional agent handles", () => {
    for (const type of ["ANALYSIS", "DESIGN", "DATABASE", "BACKEND", "FRONTEND", "TEST", "REVIEW", "BUILD"]) {
      expect(isRuntimeOnlyTaskType(type), type).toBe(false);
    }
  });

  it("does not flag unknown strings", () => {
    expect(isRuntimeOnlyTaskType("IMPLEMENTATION")).toBe(false);
    expect(isRuntimeOnlyTaskType("")).toBe(false);
  });
});

describe("isUsableTargetTaskType (PL-C3)", () => {
  it("accepts enum members that a professional agent can take", () => {
    expect(isUsableTargetTaskType("BACKEND")).toBe(true);
    expect(isUsableTargetTaskType("FRONTEND")).toBe(true);
    expect(isUsableTargetTaskType("TEST")).toBe(true);
  });

  it("rejects values outside the TaskType enum", () => {
    // 真实案例：agent 自标 `fixTaskType: "IMPLEMENTATION"`，而枚举里没有这个值（PL-M3）。
    expect(isUsableTargetTaskType("IMPLEMENTATION")).toBe(false);
    expect(isUsableTargetTaskType("backend")).toBe(false);
    expect(isUsableTargetTaskType("")).toBe(false);
  });

  it("rejects the runtime-only types (they have no professional agent)", () => {
    expect(isUsableTargetTaskType("DEBUG")).toBe(false);
    expect(isUsableTargetTaskType("MONITOR")).toBe(false);
    expect(isUsableTargetTaskType("INCIDENT")).toBe(false);
  });

  it("rejects DEPLOY (delivery orchestrator only — no professional agent)", () => {
    // F1 round17：DEBUG→DEPLOY 在 AgentRegistry 瞬失败。
    expect(isUsableTargetTaskType("DEPLOY")).toBe(false);
  });

  it("rejects non-string values", () => {
    for (const value of [undefined, null, 42, {}, []]) {
      expect(isUsableTargetTaskType(value)).toBe(false);
    }
  });

  it("keeps every accepted value inside the TaskType enum", () => {
    const options = TaskTypeSchema.options as readonly string[];
    for (const value of options) {
      if (isUsableTargetTaskType(value)) expect(options).toContain(value);
    }
  });
});
