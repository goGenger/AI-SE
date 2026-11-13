import { Client } from "@modelcontextprotocol/sdk/client";
import {
  StdioClientTransport,
  StdioServerParameters
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Readable } from "node:stream";
import {
  MCPClientPort,
  MCPPromptDescriptor,
  MCPPromptResult,
  MCPResourceDescriptor,
  MCPResourceReadResult,
  MCPServerDefinition,
  MCPToolDefinition,
  validateMCPServerDefinition
} from "../contracts";
import { MCPErrorCategory } from "../errors";
import { MCPClientError } from "./MCPClientError";
import {
  normalizePromptDescriptor,
  normalizePromptResult,
  normalizeResourceContents,
  normalizeResourceDescriptor,
  toolUiResourceUri
} from "./normalize";

/**
 * Phase 5.5-1: real stdio MCP client built on the official MCP TypeScript SDK.
 *
 * Implements the frozen MCPClientPort (Phase 5.5-0). Protocol-layer concerns
 * only: spawn, initialize, tools/list, tools/call, disconnect, cancellation,
 * protocol error normalization. No permission, approval, audit, or policy.
 */

const CLIENT_INFO = { name: "ai-se-mcp-client", version: "0.1.0" };

interface ConnectedServer {
  definition: MCPServerDefinition;
  transport: StdioClientTransport;
  client: Client;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStdioParameters(
  config: NonNullable<MCPServerDefinition["stdio"]>
): StdioServerParameters {
  return {
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
    stderr: "pipe"
  };
}

/**
 * Pure mapping from official-SDK failures to the frozen MCPErrorCategory.
 * Declared categories (MCPClientError) always win.
 */
export function classifyMCPClientError(error: unknown, aborted: boolean): MCPErrorCategory {
  if (aborted) return "CANCELLED";
  if (error instanceof MCPClientError) return error.mcpErrorCategory;
  if (error instanceof McpError) {
    switch (error.code) {
      case ErrorCode.RequestTimeout:
        return "TIMEOUT";
      case ErrorCode.ConnectionClosed:
        return "CONNECTION";
      case ErrorCode.MethodNotFound:
      case ErrorCode.InvalidParams:
      case ErrorCode.InternalError:
        return "REMOTE_TOOL";
      default:
        return "INTERNAL";
    }
  }
  if (error instanceof Error && error.name === "AbortError") return "CANCELLED";
  return "INTERNAL";
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/** Text payload of a CallToolResult error: concat of text content entries. */
function toolErrorText(result: { content: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(
      (entry): entry is { type: string; text: string } =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { type?: unknown }).type === "text" &&
        typeof (entry as { text?: unknown }).text === "string"
    )
    .map((entry) => entry.text)
    .join("\n")
    .trim();
  return text || "MCP tool failed";
}

async function closeQuietly(
  client: Client | undefined,
  transport: StdioClientTransport
): Promise<void> {
  try {
    await client?.close();
  } catch {
    // Cleanup-phase failures are swallowed; the connection is dropped either way.
  }
  try {
    await transport.close();
  } catch {
    // The child may already be dead.
  }
}

export class StdioMCPClient implements MCPClientPort {
  private readonly connections = new Map<string, ConnectedServer>();

  async connect(server: MCPServerDefinition): Promise<void> {
    const definition = validateMCPServerDefinition(server);
    if (!definition.enabled) {
      throw new MCPClientError("CONNECTION", `Server ${definition.id} is disabled`);
    }
    if (this.connections.has(definition.id)) {
      throw new MCPClientError("CONNECTION", `Server ${definition.id} is already connected`);
    }
    if (!definition.stdio) {
      throw new MCPClientError("CONNECTION", `Server ${definition.id} has no stdio config`);
    }

    const transport = new StdioClientTransport(toStdioParameters(definition.stdio));
    (transport.stderr as Readable | null)?.resume();
    const client = new Client(CLIENT_INFO);

    try {
      // client.connect() starts the transport and runs the MCP initialize flow.
      await client.connect(transport);
    } catch (error) {
      await closeQuietly(undefined, transport);
      throw new MCPClientError(
        "CONNECTION",
        `Failed to connect ${definition.id}: ${messageOf(error, "unknown error")}`,
        error
      );
    }

    transport.onerror = () => this.drop(definition.id, transport);
    transport.onclose = () => this.drop(definition.id, transport);
    this.connections.set(definition.id, { definition, transport, client });
  }

  async disconnect(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new MCPClientError("CONNECTION", `Not connected: ${serverId}`);
    }
    this.connections.delete(serverId);
    await closeQuietly(connection.client, connection.transport);
  }

  async listTools(serverId: string): Promise<MCPToolDefinition[]> {
    const connection = this.requireConnection(serverId);
    try {
      const result = await connection.client.listTools();
      return result.tools.map((tool) => ({
        serverId,
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
        uiResourceUri: toolUiResourceUri(tool)
      }));
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async callTool(
    serverId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const connection = this.requireConnection(serverId);
    try {
      const result = await connection.client.callTool(
        // MCP arguments must be a JSON object; wrap non-object inputs.
        { name, arguments: isRecord(input) ? input : { input } },
        undefined,
        { signal }
      );
      if (result.isError) {
        // "content" in result narrows the SDK's union return type.
        const content = "content" in result ? result.content : [];
        throw new MCPClientError("REMOTE_TOOL", toolErrorText({ content }));
      }
      return result;
    } catch (error) {
      throw this.wrapError(error, Boolean(signal?.aborted));
    }
  }

  /** Child pid of a connected server, or null when not connected. Test/observability aid. */
  pidOf(serverId: string): number | null {
    return this.connections.get(serverId)?.transport.pid ?? null;
  }

  // ── Phase 5.5-6: resource / prompt protocol surface ──────────────────────

  async listResources(serverId: string): Promise<MCPResourceDescriptor[]> {
    const connection = this.requireConnection(serverId);
    try {
      const result = await connection.client.listResources();
      return result.resources.map((resource) => normalizeResourceDescriptor(serverId, resource));
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async readResource(
    serverId: string,
    uri: string,
    signal?: AbortSignal
  ): Promise<MCPResourceReadResult> {
    const connection = this.requireConnection(serverId);
    try {
      const result = await connection.client.readResource({ uri }, { signal });
      return { serverId, contents: normalizeResourceContents(serverId, result.contents) };
    } catch (error) {
      throw this.wrapError(error, Boolean(signal?.aborted));
    }
  }

  async listPrompts(serverId: string): Promise<MCPPromptDescriptor[]> {
    const connection = this.requireConnection(serverId);
    try {
      const result = await connection.client.listPrompts();
      return result.prompts.map((prompt) => normalizePromptDescriptor(serverId, prompt));
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<MCPPromptResult> {
    const connection = this.requireConnection(serverId);
    try {
      const result = await connection.client.getPrompt({ name, arguments: args }, { signal });
      return normalizePromptResult(serverId, name, result);
    } catch (error) {
      throw this.wrapError(error, Boolean(signal?.aborted));
    }
  }

  private requireConnection(serverId: string): ConnectedServer {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new MCPClientError("CONNECTION", `Not connected: ${serverId}`);
    }
    return connection;
  }

  private wrapError(error: unknown, aborted = false): MCPClientError {
    if (error instanceof MCPClientError) return error;
    const category = classifyMCPClientError(error, aborted);
    return new MCPClientError(
      category,
      messageOf(error, `MCP ${category.toLowerCase()} error`),
      error
    );
  }

  private drop(serverId: string, transport: StdioClientTransport): void {
    const connection = this.connections.get(serverId);
    if (connection?.transport === transport) {
      this.connections.delete(serverId);
    }
  }
}
