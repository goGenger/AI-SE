import { Deployment } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  canRollback,
  deploymentStatusLabel,
  deploymentStatusTone,
  shortVersion
} from "../viewmodels/deploymentViewModel";

const deployment = {
  operation: "DEPLOY",
  status: "SUCCESS"
} as Deployment;

describe("deployment view model", () => {
  it("formats status and version", () => {
    expect(deploymentStatusLabel("ROLLBACK_FAILED")).toBe("回滚失败");
    expect(shortVersion("1234567890abcdef")).toBe("1234567890ab");
  });

  it("allows rollback only for completed deployment attempts", () => {
    expect(canRollback(deployment)).toBe(true);
    expect(canRollback({ ...deployment, operation: "ROLLBACK" })).toBe(false);
    expect(canRollback({ ...deployment, status: "RUNNING" })).toBe(false);
  });

  it("maps DeploymentStatus to StatusBadge tone (Phase 9-B 纯展示映射)", () => {
    expect(deploymentStatusTone("PENDING")).toBe("pending");
    expect(deploymentStatusTone("RUNNING")).toBe("running");
    expect(deploymentStatusTone("SUCCESS")).toBe("success");
    expect(deploymentStatusTone("FAILED")).toBe("error");
    expect(deploymentStatusTone("ROLLING_BACK")).toBe("warning");
    expect(deploymentStatusTone("ROLLED_BACK")).toBe("neutral");
    expect(deploymentStatusTone("ROLLBACK_FAILED")).toBe("error");
  });

  it("keeps tone independent from labels and the rollback gate", () => {
    // tone 只影响视觉，不参与 canRollback 判定，也不改变任何文案
    expect(canRollback(deployment)).toBe(true);
    expect(deploymentStatusTone("SUCCESS")).toBe("success");
    expect(deploymentStatusLabel("SUCCESS")).toBe("成功");
    expect(deploymentStatusTone("FAILED")).toBe("error");
    expect(canRollback({ ...deployment, status: "FAILED" })).toBe(true);
    expect(deploymentStatusTone("ROLLING_BACK")).toBe("warning");
    expect(canRollback({ ...deployment, status: "ROLLING_BACK" })).toBe(false);
  });
});
