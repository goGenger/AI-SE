import { describe, expect, it } from "vitest";
import {
  MCPContractError,
  classifyMCPError,
  isMCPToolVisible,
  mapMCPErrorToRuntimeError,
  toUnifiedToolMetadata,
  validateMCPServerDefinition
} from "../index";

describe("@ai-se/mcp export surface", () => {
  it("exposes the frozen contract functions", () => {
    expect(typeof validateMCPServerDefinition).toBe("function");
    expect(typeof toUnifiedToolMetadata).toBe("function");
    expect(typeof classifyMCPError).toBe("function");
    expect(typeof mapMCPErrorToRuntimeError).toBe("function");
    expect(typeof isMCPToolVisible).toBe("function");
    expect(typeof MCPContractError).toBe("function");
  });
});
