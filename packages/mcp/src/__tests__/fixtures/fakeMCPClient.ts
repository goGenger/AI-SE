import {
  MCPClientPort,
  MCPPromptDescriptor,
  MCPPromptResult,
  MCPResourceDescriptor,
  MCPResourceReadResult,
  MCPServerDefinition,
  MCPToolDefinition
} from "../../contracts";
import { isMCPErrorCategory, MCPErrorCategory } from "../../errors";

/**
 * Phase 5.5-0 Mock MCP Server Contract (test fixture, not production API)
 *
 * Frozen semantics of the controllable mock server used by later phases:
 *
 *   echo    — returns the input JSON unchanged
 *   slow    — waits delayMs, then returns { delayMs, elapsedMs };
 *             honours AbortSignal (timeout / cancellation tests)
 *   failing — always rejects with a predictable, classifiable error
 *             (error normalization / failure classification tests)
 *
 * requestCount counts tool calls actually dispatched to the server. It is the
 * counter Phase 5.5-2 uses to assert "Policy DENY ⇒ 0 server requests".
 * listTools and failed lookups never increment it.
 */

export const MOCK_MCP_SERVER_ID = "mock-server";

export const MOCK_MCP_TOOLS: MCPToolDefinition[] = [
  {
    serverId: MOCK_MCP_SERVER_ID,
    name: "echo",
    description: "Returns the input JSON unchanged.",
    inputSchema: {
      type: "object",
      properties: { input: {} },
      additionalProperties: true
    }
  },
  {
    serverId: MOCK_MCP_SERVER_ID,
    name: "slow",
    description: "Waits for delayMs milliseconds, then returns the measured delay.",
    inputSchema: {
      type: "object",
      properties: { delayMs: { type: "number", minimum: 0 } },
      required: ["delayMs"]
    }
  },
  {
    serverId: MOCK_MCP_SERVER_ID,
    name: "failing",
    description: "Always fails with a predictable, classifiable error.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string" },
        message: { type: "string" }
      }
    }
  }
];

/** Predictable error shape used by the mock and by 5.5-1's SDK adapter. */
export class FakeMCPError extends Error {
  constructor(
    public readonly mcpErrorCategory: MCPErrorCategory,
    message: string
  ) {
    super(message);
    this.name = "FakeMCPError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class FakeMCPClient implements MCPClientPort {
  readonly connectedServerIds = new Set<string>();
  /** Number of tool calls actually dispatched to a server. */
  requestCount = 0;
  private readonly toolsByServer = new Map<string, MCPToolDefinition[]>();

  async connect(server: MCPServerDefinition): Promise<void> {
    if (!server.enabled) {
      throw new FakeMCPError("CONNECTION", `Server ${server.id} is disabled`);
    }
    this.connectedServerIds.add(server.id);
    this.toolsByServer.set(server.id, MOCK_MCP_TOOLS);
  }

  async disconnect(serverId: string): Promise<void> {
    if (!this.connectedServerIds.has(serverId)) {
      throw new FakeMCPError("CONNECTION", `Not connected: ${serverId}`);
    }
    this.connectedServerIds.delete(serverId);
  }

  async listTools(serverId: string): Promise<MCPToolDefinition[]> {
    if (!this.connectedServerIds.has(serverId)) {
      throw new FakeMCPError("CONNECTION", `Not connected: ${serverId}`);
    }
    return [...(this.toolsByServer.get(serverId) ?? [])];
  }

  async callTool(
    serverId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (!this.connectedServerIds.has(serverId)) {
      throw new FakeMCPError("CONNECTION", `Not connected: ${serverId}`);
    }
    if (!MOCK_MCP_TOOLS.some((tool) => tool.name === name)) {
      throw new FakeMCPError("REMOTE_TOOL", `Unknown tool: ${name}`);
    }

    this.requestCount += 1;
    const record = isRecord(input) ? input : {};

    switch (name) {
      case "echo":
        return input;
      case "slow":
        return await this.slow(record, signal);
      case "failing":
        return this.failing(record);
      default:
        throw new FakeMCPError("REMOTE_TOOL", `Unknown tool: ${name}`);
    }
  }

  // ── Phase 5.5-6 resource/prompt surface (tool semantics unchanged above) ──

  async listResources(serverId: string): Promise<MCPResourceDescriptor[]> {
    if (!this.connectedServerIds.has(serverId)) {
      throw new FakeMCPError("CONNECTION", `Not connected: ${serverId}`);
    }
    return [];
  }

  async readResource(serverId: string, uri: string): Promise<MCPResourceReadResult> {
    if (!this.connectedServerIds.has(serverId)) {
      throw new FakeMCPError("CONNECTION", `Not connected: ${serverId}`);
    }
    throw new FakeMCPError("REMOTE_TOOL", `Unknown resource: ${uri}`);
  }

  async listPrompts(serverId: string): Promise<MCPPromptDescriptor[]> {
    if (!this.connectedServerIds.has(serverId)) {
      throw new FakeMCPError("CONNECTION", `Not connected: ${serverId}`);
    }
    return [];
  }

  async getPrompt(serverId: string, name: string): Promise<MCPPromptResult> {
    if (!this.connectedServerIds.has(serverId)) {
      throw new FakeMCPError("CONNECTION", `Not connected: ${serverId}`);
    }
    throw new FakeMCPError("REMOTE_TOOL", `Unknown prompt: ${name}`);
  }

  private slow(record: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const delayMs = typeof record.delayMs === "number" ? record.delayMs : 0;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ delayMs, elapsedMs: Date.now() - started }),
        delayMs
      );
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new FakeMCPError("CANCELLED", "Tool call aborted"));
        },
        { once: true }
      );
    });
  }

  private failing(record: Record<string, unknown>): never {
    const category = isMCPErrorCategory(record.category) ? record.category : "REMOTE_TOOL";
    const message =
      typeof record.message === "string" && record.message.trim()
        ? record.message
        : "Mock tool failure";
    throw new FakeMCPError(category, message);
  }
}
