import type {
  MCPRegistryStore,
  MCPServerEntity,
  PersistentMCPRegistry,
  MCPToolUiLink
} from "@ai-se/mcp";
import { MCPClientError, redactCredentialShapedText } from "@ai-se/mcp";
import type {
  MCPAppActionResult,
  MCPAppActionRequest,
  MCPAppLink,
  MCPAppUiResource
} from "@ai-se/shared";
import type { ToolCallRecorder, ToolExecutionContext } from "@ai-se/tool-runtime";
import { ToolRuntime } from "@ai-se/tool-runtime";
import { randomUUID } from "node:crypto";
import { AppError } from "../http/errors";
import type { MCPConsoleRegistries } from "./mcpService";

/**
 * Phase 5.5-7: MCP Apps backend service (controlled-action host).
 *
 *  - UI resources are ordinary MCP resources: they are read through the SAME
 *    capability gate as 5.5-6 (server-scope bindings, call-time re-check,
 *    fail-closed) — the console never talks to an MCP server directly.
 *  - Controlled actions NEVER call the MCP client directly: the action is
 *    executed by a ToolRuntime built from the registry's visible definitions
 *    (permission/binding chain, policy, approval gate, timeout, cancellation,
 *    error normalization, audit) — see docs/33 for the chain diagram.
 *  - Every failure message is scrubbed with the existing
 *    redactCredentialShapedText before it leaves the backend.
 */

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const MAX_UI_RESOURCE_CHARS = 1_000_000;

/** MCP tool adapters never touch a sandbox; native tools can never appear here. */
const blockedSandbox = {
  async runCommand(): Promise<never> {
    throw new Error("MCP app actions must not use the coding sandbox");
  }
};

export interface MCPAppServiceOptions {
  store: MCPRegistryStore;
  registries: MCPConsoleRegistries;
  /**
   * Optional audit recorder (existing ToolCallRecorder DI). Wiring it into
   * tool_calls requires a real agent run id (NOT NULL FK); the platform layer
   * supplies one when app actions become part of a run.
   */
  toolCallRecorder?: ToolCallRecorder;
}

export class MCPAppService {
  constructor(private readonly options: MCPAppServiceOptions) {}

  /** UI-app links (tool `_meta.ui.resourceUri`) visible to the given agent. */
  async listUiApps(serverId: string, projectId: string, agentName: string): Promise<MCPAppLink[]> {
    const server = await this.requireServer(serverId);
    const links = await this.registryFor(server).listVisibleToolUiLinks(serverId, {
      projectId,
      agentName
    });
    return links.map((link: MCPToolUiLink) => ({
      toolName: link.toolName,
      resourceUri: link.resourceUri
    }));
  }

  /** Reads one `ui://` app document through the 5.5-6 capability gate. */
  async readUiResource(
    serverId: string,
    uri: string,
    projectId: string,
    agentName: string
  ): Promise<MCPAppUiResource> {
    if (!uri.startsWith("ui://")) {
      throw new AppError(400, "MCP_APP_INVALID_URI", "App resources must use the ui:// scheme");
    }
    const server = await this.requireServer(serverId);

    let read;
    try {
      read = await this.registryFor(server).readResource(serverId, uri, { projectId, agentName });
    } catch (error) {
      if (error instanceof MCPClientError) {
        const message = redactCredentialShapedText(error.message);
        if (error.mcpErrorCategory === "PERMISSION_DENIED") {
          throw new AppError(403, "MCP_APP_RESOURCE_DENIED", "MCP app resource is not permitted");
        }
        if (error.mcpErrorCategory === "REMOTE_TOOL") {
          throw new AppError(404, "MCP_APP_RESOURCE_NOT_FOUND", message);
        }
        throw new AppError(502, "MCP_APP_RESOURCE_FAILED", message);
      }
      throw error;
    }

    const entry = read.contents.find(
      (content) =>
        typeof content.text === "string" && (content.mimeType ?? "").startsWith("text/html")
    );
    if (!entry || typeof entry.text !== "string") {
      throw new AppError(
        400,
        "MCP_APP_NOT_HTML",
        "MCP app resource does not contain a text/html document"
      );
    }
    if (entry.text.length > MAX_UI_RESOURCE_CHARS) {
      throw new AppError(413, "MCP_APP_TOO_LARGE", "MCP app resource exceeds the size limit");
    }
    return { uri, mimeType: entry.mimeType!, html: entry.text };
  }

  /**
   * Controlled action: iframe → Host Bridge → (console REST) → this method →
   * ToolRuntime → permission/policy/approval → MCP tool adapter → MCP server.
   * The UI can never pick a different server (bound by the caller's serverId),
   * and only definitions from the registry's visibility chain are executable.
   */
  async runAction(input: MCPAppActionRequest, signal?: AbortSignal): Promise<MCPAppActionResult> {
    const server = await this.requireServer(input.serverId);

    if (input.allowedTools && !input.allowedTools.includes(input.toolName)) {
      throw new AppError(403, "MCP_APP_ACTION_DENIED", "Tool is not allowed for this app");
    }

    const entity = await this.options.store.getToolByName(input.serverId, input.toolName);
    if (!entity) {
      throw new AppError(404, "MCP_TOOL_NOT_FOUND", "MCP tool not found for this server");
    }

    const definitions = await this.registryFor(server).listVisibleToolDefinitions({
      projectId: input.projectId,
      agentName: input.agentName,
      serverIds: [input.serverId]
    });
    if (!definitions.some((definition) => definition.name === input.toolName)) {
      // Disabled, unbound, revoked, policy-denied or approval-without-gate:
      // never reaches the MCP server (canExecute re-check at call time too).
      throw new AppError(403, "MCP_APP_ACTION_DENIED", "MCP tool is not permitted");
    }

    const runtime = new ToolRuntime({ tools: definitions });
    const context: ToolExecutionContext = {
      requestId: randomUUID(),
      projectId: input.projectId,
      taskId: randomUUID(),
      agentRunId: randomUUID(),
      toolCallId: randomUUID(),
      actor: input.agentName,
      workspacePath: "/mcp-apps",
      sandbox: blockedSandbox as unknown as ToolExecutionContext["sandbox"],
      timeoutMs: input.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
      signal,
      toolCallRecorder: this.options.toolCallRecorder
    };

    const result = await runtime.execute(input.toolName, input.arguments ?? {}, context);
    if (!result.success) {
      const message = redactCredentialShapedText(result.error?.message ?? "MCP app action failed");
      const category = (result.error?.details as { mcpErrorCategory?: string } | undefined)
        ?.mcpErrorCategory;
      if (category === "PERMISSION_DENIED") {
        throw new AppError(403, "MCP_APP_ACTION_DENIED", message);
      }
      if (category === "APPROVAL_REQUIRED") {
        throw new AppError(403, "MCP_APP_APPROVAL_REQUIRED", message);
      }
      if (result.error?.code === "TIMEOUT_ERROR") {
        throw new AppError(504, "MCP_APP_ACTION_TIMEOUT", message);
      }
      if (result.error?.code === "CANCELLED_ERROR") {
        throw new AppError(408, "MCP_APP_ACTION_CANCELLED", message);
      }
      throw new AppError(502, "MCP_APP_ACTION_FAILED", message);
    }

    return {
      data: result.data,
      duration: result.duration,
      audit: {
        toolName: result.audit.toolName,
        actor: result.audit.actor,
        riskLevel: result.audit.riskLevel,
        requestId: result.audit.requestId
      }
    };
  }

  private async requireServer(serverId: string): Promise<MCPServerEntity> {
    const server = await this.options.store.getServer(serverId);
    if (!server) {
      throw new AppError(404, "MCP_SERVER_NOT_FOUND", "MCP server not found");
    }
    return server;
  }

  private registryFor(server: MCPServerEntity): PersistentMCPRegistry {
    if (server.transport === "stdio") return this.options.registries.stdio;
    if (server.transport === "streamable-http") {
      return this.options.registries["streamable-http"];
    }
    throw new AppError(500, "MCP_TRANSPORT_UNSUPPORTED", "Unsupported MCP transport");
  }
}
