import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { MCPClientError } from "../client/MCPClientError";
import { classifyMCPClientError } from "../client/StdioMCPClient";

describe("classifyMCPClientError (SDK error mapping)", () => {
  it("maps RequestTimeout to TIMEOUT", () => {
    expect(classifyMCPClientError(new McpError(ErrorCode.RequestTimeout, "too slow"), false)).toBe(
      "TIMEOUT"
    );
  });

  it("maps ConnectionClosed to CONNECTION", () => {
    expect(classifyMCPClientError(new McpError(ErrorCode.ConnectionClosed, "closed"), false)).toBe(
      "CONNECTION"
    );
  });

  it("maps MethodNotFound / InvalidParams / InternalError to REMOTE_TOOL", () => {
    expect(classifyMCPClientError(new McpError(ErrorCode.MethodNotFound, "no tool"), false)).toBe(
      "REMOTE_TOOL"
    );
    expect(classifyMCPClientError(new McpError(ErrorCode.InvalidParams, "bad args"), false)).toBe(
      "REMOTE_TOOL"
    );
    expect(
      classifyMCPClientError(new McpError(ErrorCode.InternalError, "server broke"), false)
    ).toBe("REMOTE_TOOL");
  });

  it("maps protocol-level parse failures to INTERNAL", () => {
    expect(classifyMCPClientError(new McpError(ErrorCode.ParseError, "parse"), false)).toBe(
      "INTERNAL"
    );
  });

  it("maps aborted requests to CANCELLED", () => {
    expect(classifyMCPClientError(new Error("boom"), true)).toBe("CANCELLED");
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    expect(classifyMCPClientError(abortError, false)).toBe("CANCELLED");
  });

  it("lets declared MCPClientError categories win", () => {
    expect(classifyMCPClientError(new MCPClientError("RATE_LIMITED", "slow down"), false)).toBe(
      "RATE_LIMITED"
    );
    expect(classifyMCPClientError(new MCPClientError("CANCELLED", "aborted"), true)).toBe(
      "CANCELLED"
    );
  });

  it("falls back to INTERNAL for unknown failures", () => {
    expect(classifyMCPClientError(new Error("mystery"), false)).toBe("INTERNAL");
    expect(classifyMCPClientError(undefined, false)).toBe("INTERNAL");
  });
});
