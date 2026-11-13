import { describe, expect, it } from "vitest";
import { isMCPToolVisible, MCPToolVisibilityInput } from "../persistence";

const visible: MCPToolVisibilityInput = {
  serverEnabled: true,
  toolEnabled: true,
  projectBound: true,
  agentBound: true,
  policyAllowed: true
};

describe("MCP tool visibility chain", () => {
  it("is visible only when the full chain is satisfied", () => {
    expect(isMCPToolVisible(visible)).toBe(true);
  });

  it("denies when the server is disabled", () => {
    expect(isMCPToolVisible({ ...visible, serverEnabled: false })).toBe(false);
  });

  it("denies when the tool is disabled", () => {
    expect(isMCPToolVisible({ ...visible, toolEnabled: false })).toBe(false);
  });

  it("denies when there is no project binding", () => {
    expect(isMCPToolVisible({ ...visible, projectBound: false })).toBe(false);
  });

  it("denies when there is no agent binding", () => {
    expect(isMCPToolVisible({ ...visible, agentBound: false })).toBe(false);
  });

  it("denies when policy does not allow it, even with full bindings", () => {
    expect(isMCPToolVisible({ ...visible, policyAllowed: false })).toBe(false);
  });

  it("denies by default when nothing is bound", () => {
    expect(
      isMCPToolVisible({
        serverEnabled: true,
        toolEnabled: true,
        projectBound: false,
        agentBound: false,
        policyAllowed: true
      })
    ).toBe(false);
  });
});
