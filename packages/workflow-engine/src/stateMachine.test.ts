import { describe, expect, it } from "vitest";
import {
  assertTaskTransition,
  assertWorkflowTransition,
  canTransitionTask,
  canTransitionWorkflow
} from "./stateMachine";

describe("workflow state machines", () => {
  it("accepts valid workflow and task transitions", () => {
    expect(canTransitionWorkflow("PENDING", "RUNNING")).toBe(true);
    expect(canTransitionWorkflow("PAUSED", "RUNNING")).toBe(true);
    expect(canTransitionTask("FAILED", "RETRYING")).toBe(true);
    expect(canTransitionTask("WAITING_APPROVAL", "READY")).toBe(true);
  });

  it("exposes the manual-retry edges (FAILED workflow / BLOCKED task)", () => {
    expect(canTransitionWorkflow("FAILED", "RUNNING")).toBe(true);
    expect(canTransitionTask("BLOCKED", "PENDING")).toBe(true);
    expect(canTransitionWorkflow("SUCCESS", "RUNNING")).toBe(false);
    expect(canTransitionWorkflow("CANCELLED", "RUNNING")).toBe(false);
  });

  it("rejects invalid transitions", () => {
    expect(canTransitionWorkflow("SUCCESS", "RUNNING")).toBe(false);
    expect(canTransitionTask("SUCCESS", "RUNNING")).toBe(false);
    expect(() => assertWorkflowTransition("PENDING", "SUCCESS")).toThrow(
      "Invalid workflow transition"
    );
    expect(() => assertTaskTransition("READY", "SUCCESS")).toThrow("Invalid task transition");
  });

  /**
   * N-37：崩溃恢复要把中断的 RUNNING 任务重新排队。这条边此前**不在表里**，
   * 恢复路径绕过状态机直接 UPDATE——从此它是一条显式合法的边，且必须过 `assertTaskTransition`。
   */
  it("allows the crash-recovery edge RUNNING -> RETRYING", () => {
    expect(canTransitionTask("RUNNING", "RETRYING")).toBe(true);
    expect(() => assertTaskTransition("RUNNING", "RETRYING")).not.toThrow();
  });

  it("allows RETRYING -> FAILED when recovery/retry budget is exhausted", () => {
    expect(canTransitionTask("RETRYING", "FAILED")).toBe(true);
    expect(() => assertTaskTransition("RETRYING", "FAILED")).not.toThrow();
  });

  it("does not open any other new exit from RUNNING", () => {
    expect(canTransitionTask("RUNNING", "READY")).toBe(false);
    expect(canTransitionTask("RUNNING", "PENDING")).toBe(false);
    expect(canTransitionTask("RUNNING", "BLOCKED")).toBe(false);
  });
});
