import { RuntimeErrorCode } from "@ai-se/tool-runtime";
import { describe, expect, it } from "vitest";
import {
  MCPErrorCategory,
  classifyMCPError,
  isMCPErrorCategory,
  mapMCPErrorToRuntimeError
} from "../errors";
import { FakeMCPError } from "./fixtures/fakeMCPClient";

/** The complete existing code set of @ai-se/tool-runtime — no new codes allowed. */
const EXISTING_RUNTIME_CODES: readonly RuntimeErrorCode[] = [
  "LLM_ERROR",
  "TOOL_ERROR",
  "SANDBOX_ERROR",
  "COMMAND_ERROR",
  "TEST_ERROR",
  "TIMEOUT_ERROR",
  "CANCELLED_ERROR",
  "UNKNOWN_ERROR"
];

const ALL_CATEGORIES: readonly MCPErrorCategory[] = [
  "VALIDATION",
  "PERMISSION_DENIED",
  "APPROVAL_REQUIRED",
  "TIMEOUT",
  "CANCELLED",
  "CONNECTION",
  "REMOTE_TOOL",
  "RATE_LIMITED",
  "INTERNAL"
];

describe("classifyMCPError", () => {
  it("classifies an aborted call as CANCELLED", () => {
    expect(classifyMCPError({ aborted: true })).toBe("CANCELLED");
  });

  it("prefers a declared category over heuristics", () => {
    expect(classifyMCPError({ error: new FakeMCPError("RATE_LIMITED", "slow down") })).toBe(
      "RATE_LIMITED"
    );
  });

  it("classifies TimeoutError by name", () => {
    const error = new Error("boom");
    error.name = "TimeoutError";
    expect(classifyMCPError({ error })).toBe("TIMEOUT");
  });

  it("classifies AbortError by name", () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    expect(classifyMCPError({ error })).toBe("CANCELLED");
  });

  it("classifies rate limiting by message", () => {
    expect(classifyMCPError({ error: new Error("429 Too Many Requests") })).toBe("RATE_LIMITED");
  });

  it("classifies connection failures by message", () => {
    expect(classifyMCPError({ error: new Error("connect ECONNREFUSED 127.0.0.1:1") })).toBe(
      "CONNECTION"
    );
  });

  it("classifies unknown errors as INTERNAL", () => {
    expect(classifyMCPError({ error: new Error("something else") })).toBe("INTERNAL");
    expect(classifyMCPError({})).toBe("INTERNAL");
  });

  it("rejects invalid category values", () => {
    expect(isMCPErrorCategory("TIMEOUT")).toBe(true);
    expect(isMCPErrorCategory("nonsense")).toBe(false);
    expect(isMCPErrorCategory(undefined)).toBe(false);
    expect(isMCPErrorCategory(42)).toBe(false);
  });
});

describe("mapMCPErrorToRuntimeError", () => {
  it("maps TIMEOUT to the existing TIMEOUT_ERROR", () => {
    const error = new Error("slow tool exceeded budget");
    const mapped = mapMCPErrorToRuntimeError("TIMEOUT", error);
    expect(mapped.code).toBe("TIMEOUT_ERROR");
    expect(mapped.message).toBe("slow tool exceeded budget");
  });

  it("maps CANCELLED to the existing CANCELLED_ERROR", () => {
    const mapped = mapMCPErrorToRuntimeError("CANCELLED", new Error("aborted"));
    expect(mapped.code).toBe("CANCELLED_ERROR");
  });

  it("maps every remaining category to the existing TOOL_ERROR", () => {
    const remaining: MCPErrorCategory[] = [
      "VALIDATION",
      "PERMISSION_DENIED",
      "APPROVAL_REQUIRED",
      "CONNECTION",
      "REMOTE_TOOL",
      "RATE_LIMITED",
      "INTERNAL"
    ];
    for (const category of remaining) {
      const mapped = mapMCPErrorToRuntimeError(category, new Error("x"));
      expect(mapped.code).toBe("TOOL_ERROR");
    }
  });

  it("only produces codes from the existing RuntimeErrorCode set", () => {
    for (const category of ALL_CATEGORIES) {
      const mapped = mapMCPErrorToRuntimeError(category, new Error("x"));
      expect(EXISTING_RUNTIME_CODES).toContain(mapped.code);
    }
  });

  it("carries the MCP category as details metadata, not as a new code", () => {
    const mapped = mapMCPErrorToRuntimeError("RATE_LIMITED", new Error("429"));
    expect(mapped.details).toEqual({ mcpErrorCategory: "RATE_LIMITED" });
  });
});
