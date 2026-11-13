import { MCPServerStatus, MCPToolRisk } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  approvalLabel,
  approvalTone,
  bindingScopeLabel,
  bindingTargetLabel,
  enabledLabel,
  enabledTone,
  formatMCPTimestamp,
  riskClass,
  riskLabel,
  riskTone,
  serverStatusClass,
  serverStatusHint,
  serverStatusLabel,
  serverStatusTone,
  transportLabel
} from "../viewmodels/mcpViewModel";

const ALL_STATUSES: MCPServerStatus[] = [
  "REGISTERED",
  "CONNECTING",
  "CONNECTED",
  "DEGRADED",
  "RECONNECTING",
  "DISCONNECTED",
  "REVOKED"
];

describe("mcpViewModel", () => {
  it("labels every registry status with a stable class", () => {
    expect(serverStatusLabel("CONNECTED")).toBe("已连接");
    expect(serverStatusLabel("DEGRADED")).toBe("降级");
    expect(serverStatusLabel("RECONNECTING")).toBe("重连中");
    expect(serverStatusLabel("DISCONNECTED")).toBe("未连接");
    expect(serverStatusLabel("REVOKED")).toBe("已撤销");

    for (const status of ALL_STATUSES) {
      expect(serverStatusClass(status)).toBe(`status mcp-status-${status.toLowerCase()}`);
    }
  });

  it("explains degraded / reconnecting without dropping tools", () => {
    expect(serverStatusHint("DEGRADED")).toContain("保留");
    expect(serverStatusHint("RECONNECTING")).toContain("重连");
    expect(serverStatusHint("REVOKED")).toContain("终态");
  });

  it("labels transports", () => {
    expect(transportLabel("stdio")).toBe("stdio");
    expect(transportLabel("streamable-http")).toBe("流式 HTTP");
  });

  it("labels risk levels and approval requirements", () => {
    const risks: MCPToolRisk[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    expect(risks.map(riskLabel)).toEqual(["低", "中", "高", "严重"]);
    expect(riskClass("HIGH")).toBe("status mcp-risk-high");
    expect(approvalLabel(true)).toBe("需要审批");
    expect(approvalLabel(false)).toBe("无需审批");
    expect(enabledLabel(true)).toBe("已启用");
    expect(enabledLabel(false)).toBe("已禁用");
  });

  it("labels binding scopes and targets", () => {
    expect(bindingScopeLabel({ id: "b1" } as never)).toBe("项目级");
    expect(bindingScopeLabel({ id: "b2", agentName: "dev-agent" } as never)).toBe(
      "Agent: dev-agent"
    );
    expect(bindingTargetLabel({ id: "b3" } as never)).toBe("全部工具");
    expect(bindingTargetLabel({ id: "b4", toolName: "echo" } as never)).toBe("echo");
  });

  it("formats timestamps defensively", () => {
    expect(formatMCPTimestamp(undefined)).toBe("—");
    expect(formatMCPTimestamp("2026-09-10T00:00:00.000Z")).toContain("2026");
  });

  /**
   * Phase 10-B：状态 → StatusBadge tone 的纯展示映射。
   * 只断言"哪个状态用哪种语义色"，不改动上面任何既有断言的语义。
   */
  it("maps registry statuses to StatusBadge tones", () => {
    expect(ALL_STATUSES.map(serverStatusTone)).toEqual([
      "pending", // REGISTERED
      "pending", // CONNECTING
      "success", // CONNECTED
      "warning", // DEGRADED
      "running", // RECONNECTING
      "neutral", // DISCONNECTED
      "neutral" // REVOKED
    ]);
  });

  it("maps tool risk levels, approval and enabled flags to tones", () => {
    const risks: MCPToolRisk[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    expect(risks.map(riskTone)).toEqual(["success", "running", "warning", "error"]);
    expect(approvalTone(true)).toBe("warning");
    expect(approvalTone(false)).toBe("neutral");
    expect(enabledTone(true)).toBe("success");
    expect(enabledTone(false)).toBe("neutral");
  });
});
