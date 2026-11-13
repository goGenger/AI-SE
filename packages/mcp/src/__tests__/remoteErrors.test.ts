import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { MCPClientError } from "../client/MCPClientError";
import { classifyRemoteMCPClientError } from "../client/RemoteMCPClient";
import { mapMCPErrorToRuntimeError } from "../errors";

class FakeStreamableHTTPError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

describe("classifyRemoteMCPClientError", () => {
  it("maps HTTP auth failures to PERMISSION_DENIED", () => {
    expect(
      classifyRemoteMCPClientError(new FakeStreamableHTTPError(401, "unauthorized"), false)
    ).toBe("PERMISSION_DENIED");
    expect(classifyRemoteMCPClientError(new FakeStreamableHTTPError(403, "forbidden"), false)).toBe(
      "PERMISSION_DENIED"
    );
  });

  it("maps server/transport failures to CONNECTION", () => {
    expect(classifyRemoteMCPClientError(new FakeStreamableHTTPError(404, "not found"), false)).toBe(
      "CONNECTION"
    );
    expect(classifyRemoteMCPClientError(new FakeStreamableHTTPError(405, "no GET"), false)).toBe(
      "CONNECTION"
    );
    expect(classifyRemoteMCPClientError(new FakeStreamableHTTPError(500, "boom"), false)).toBe(
      "CONNECTION"
    );
    expect(classifyRemoteMCPClientError(new TypeError("fetch failed"), false)).toBe("CONNECTION");
    expect(classifyRemoteMCPClientError(new Error("connect ECONNREFUSED 127.0.0.1:1"), false)).toBe(
      "CONNECTION"
    );
    expect(
      classifyRemoteMCPClientError(
        new Error("Unexpected token 'o', not-json is not valid JSON"),
        false
      )
    ).toBe("CONNECTION");
  });

  it("declared categories and SDK protocol errors win over heuristics", () => {
    const declared = new MCPClientError("APPROVAL_REQUIRED", "nope");
    expect(classifyRemoteMCPClientError(declared, false)).toBe("APPROVAL_REQUIRED");

    expect(
      classifyRemoteMCPClientError(new McpError(ErrorCode.RequestTimeout, "timed out"), false)
    ).toBe("TIMEOUT");
    expect(
      classifyRemoteMCPClientError(new McpError(ErrorCode.ConnectionClosed, "closed"), false)
    ).toBe("CONNECTION");
    expect(
      classifyRemoteMCPClientError(new McpError(ErrorCode.MethodNotFound, "no tool"), false)
    ).toBe("REMOTE_TOOL");
  });

  it("maps aborts to CANCELLED", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyRemoteMCPClientError(abort, false)).toBe("CANCELLED");
    expect(classifyRemoteMCPClientError(new FakeStreamableHTTPError(500, "x"), true)).toBe(
      "CANCELLED"
    );
  });

  it("always maps onto existing RuntimeErrorCode values (no new codes)", () => {
    const categories = [
      classifyRemoteMCPClientError(new FakeStreamableHTTPError(401, "x"), false),
      classifyRemoteMCPClientError(new FakeStreamableHTTPError(500, "x"), false),
      classifyRemoteMCPClientError(new Error("mystery"), false),
      classifyRemoteMCPClientError(new McpError(ErrorCode.RequestTimeout, "x"), false),
      classifyRemoteMCPClientError(new Error("aborted"), true)
    ] as const;

    for (const category of categories) {
      const mapped = mapMCPErrorToRuntimeError(category, new Error("x"));
      expect(["TOOL_ERROR", "TIMEOUT_ERROR", "CANCELLED_ERROR"]).toContain(mapped.code);
    }
    expect(mapMCPErrorToRuntimeError("PERMISSION_DENIED", new Error("x")).code).toBe("TOOL_ERROR");
    expect(mapMCPErrorToRuntimeError("CONNECTION", new Error("x")).code).toBe("TOOL_ERROR");
  });
});
