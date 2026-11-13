import { randomUUID } from "node:crypto";
import { ToolDefinition, ToolExecutionContext } from "@ai-se/tool-runtime";
import {
  MCPCapabilityPolicy,
  MCPClientPort,
  MCPPromptDescriptor,
  MCPPromptResult,
  MCPResourceDescriptor,
  MCPResourceReadResult,
  MCPServerDefinition,
  MCPToolDefinition,
  MCPToolPolicy,
  MCPToolUiLink,
  MCPTransport,
  validateMCPServerDefinition
} from "../contracts";
import { MCPClientError } from "../client/MCPClientError";
import type { MCPRemoteStateEvent } from "../client/RemoteMCPClient";
import { createMCPToolAdapter, toUnifiedToolDefinition } from "../integration/adapter";
import { createMCPPromptAdapter } from "../integration/promptAdapter";
import { createMCPResourceAdapter, MCPResourcePolicyContext } from "../integration/resourceAdapter";
import {
  isMCPToolVisible,
  MCPServerEntity,
  MCPToolBindingEntity,
  MCPToolEntity
} from "../persistence";
import { MCPRegistryStore, MCPServerPatch } from "./store";

/**
 * Phase 5.5-3: store-backed MCP registry.
 *
 * Same frozen visibility chain as the in-memory MCPToolRegistry
 * (docs/25 §3.4), but the store is the single source of truth:
 *
 *   - every visibility read hits the store, so database changes (including
 *     revocations made outside this process) can never leave stale
 *     authorization — the call-time canExecute re-check re-reads the store;
 *   - any state that fails (missing/disabled/revoked row, unknown tool,
 *     store error) or any undefined policy DENIES the tool (fail-closed);
 *   - bindings are FEDERATION grants only: they decide whether an MCP tool may
 *     become agent-visible. Execution still flows through the existing
 *     ToolRuntime boundary, and the caller may additionally AND the agent's
 *     tool allowlist (agentToolAllowlist) so federation grants can never
 *     bypass AgentPermissions.
 */

export interface PersistentMCPRegistryOptions {
  client: MCPClientPort;
  store: MCPRegistryStore;
  /** Platform policy. Returning undefined DENIES the tool. When absent the
   *  persisted per-tool policy (risk_level / requires_approval) is used. */
  policyProvider?: (
    server: MCPServerDefinition,
    tool: MCPToolDefinition
  ) => MCPToolPolicy | undefined;
  /** Platform approval gate, consulted when the effective policy requires approval. */
  approvalGate?: (context: ToolExecutionContext) => boolean | Promise<boolean>;
  /**
   * Phase 5.5-6: platform policy for resource reads. Returning undefined
   * DENIES the resource. When absent, admitted resources default to
   * riskLevel "LOW" (grants are still required).
   */
  resourcePolicyProvider?: (
    server: MCPServerDefinition,
    resource: MCPResourceDescriptor
  ) => MCPCapabilityPolicy | undefined;
  /** Phase 5.5-6: platform policy for prompt gets. Returning undefined DENIES
   *  the prompt. When absent, admitted prompts default to riskLevel "LOW". */
  promptPolicyProvider?: (
    server: MCPServerDefinition,
    prompt: MCPPromptDescriptor
  ) => MCPCapabilityPolicy | undefined;
}

export interface MCPRegistryQuery {
  projectId?: string;
  agentName?: string;
  /**
   * The agent's own tool allowlist (AgentPermissions.tools). When provided,
   * federation visibility is ANDed with it: a bound MCP tool that is not in
   * the agent allowlist stays invisible and is denied at call time.
   */
  agentToolAllowlist?: string[];
  /**
   * Phase 5.5-7: optional server filter for definition assembly. When set,
   * only servers with an id in this list contribute definitions.
   */
  serverIds?: string[];
}

export interface CreateMCPServerInput {
  name: string;
  description?: string;
  transport?: MCPTransport;
  stdio?: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  };
  /** Reserved for 5.5-4. */
  endpoint?: string;
  /** Fail-closed default: false. */
  enabled?: boolean;
  authRef?: string;
  credentialRef?: string;
}

export interface UpdateMCPServerInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  stdio?: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  };
  /** streamable-http transport only. */
  endpoint?: string;
  authRef?: string;
  credentialRef?: string;
}

export interface MCPProjectBindingInput {
  projectId: string;
  serverId: string;
  toolNames?: string[];
  enabled?: boolean;
}

export interface MCPAgentBindingInput extends MCPProjectBindingInput {
  agentName: string;
}

export interface MCPInitializeResult {
  connected: string[];
  failed: Array<{ serverId: string; error: string }>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PersistentMCPRegistry {
  private readonly connected = new Set<string>();

  constructor(private readonly options: PersistentMCPRegistryOptions) {}

  // ── Server registration / CRUD ───────────────────────────────────────────

  async createServer(input: CreateMCPServerInput): Promise<MCPServerEntity> {
    const definition = validateMCPServerDefinition({
      id: randomUUID(),
      name: input.name,
      description: input.description ?? "",
      transport: input.transport ?? "stdio",
      stdio: input.stdio,
      endpoint: input.endpoint,
      enabled: input.enabled ?? false,
      authRef: input.authRef,
      credentialRef: input.credentialRef
    });

    return await this.options.store.createServer({
      id: definition.id,
      name: definition.name,
      description: definition.description ?? "",
      transport: definition.transport,
      endpoint: input.endpoint,
      command: definition.stdio?.command,
      args: definition.stdio?.args ?? [],
      env: definition.stdio?.env ?? {},
      cwd: definition.stdio?.cwd,
      status: "REGISTERED",
      enabled: definition.enabled,
      authRef: definition.authRef,
      credentialRef: definition.credentialRef
    });
  }

  async listServers(): Promise<MCPServerEntity[]> {
    return await this.options.store.listServers();
  }

  async getServer(id: string): Promise<MCPServerEntity | null> {
    return await this.options.store.getServer(id);
  }

  async updateServer(id: string, patch: UpdateMCPServerInput): Promise<MCPServerEntity | null> {
    const current = await this.options.store.getServer(id);
    if (!current) return null;

    const merged = validateMCPServerDefinition({
      id: current.id,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      transport: current.transport,
      ...(current.transport === "stdio"
        ? {
            stdio: {
              command: patch.stdio?.command ?? current.command,
              args: patch.stdio?.args ?? current.args,
              env: patch.stdio?.env ?? current.env,
              cwd: patch.stdio?.cwd ?? current.cwd
            }
          }
        : {}),
      ...(current.transport === "streamable-http"
        ? { endpoint: patch.endpoint ?? current.endpoint }
        : {}),
      enabled: patch.enabled ?? current.enabled,
      authRef: patch.authRef ?? current.authRef,
      credentialRef: patch.credentialRef ?? current.credentialRef
    });

    const storePatch: MCPServerPatch = {
      name: merged.name,
      description: merged.description ?? "",
      enabled: merged.enabled,
      authRef: merged.authRef ?? null,
      credentialRef: merged.credentialRef ?? null
    };
    if (merged.transport === "stdio") {
      storePatch.args = merged.stdio?.args ?? [];
      storePatch.env = merged.stdio?.env ?? {};
      storePatch.cwd = merged.stdio?.cwd ?? null;
      if (patch.stdio?.command !== undefined) storePatch.command = merged.stdio?.command;
    } else {
      storePatch.endpoint = merged.endpoint ?? null;
    }

    const updated = await this.options.store.updateServer(id, storePatch);
    if (updated && !updated.enabled) {
      await this.disconnectServer(id).catch(() => undefined);
    }
    return updated;
  }

  async setServerEnabled(id: string, enabled: boolean): Promise<MCPServerEntity | null> {
    return await this.updateServer(id, { enabled });
  }

  async deleteServer(id: string): Promise<boolean> {
    await this.disconnectServer(id).catch(() => undefined);
    return await this.options.store.deleteServer(id);
  }

  /**
   * Persists a client-reported connection state transition (Remote MCP
   * lifecycle: CONNECTING → CONNECTED → DEGRADED → RECONNECTING → CONNECTED /
   * DISCONNECTED). Wire it via RemoteMCPClient's onStateChange. The reason
   * text is already credential-redacted by the client.
   */
  async applyConnectionState(event: MCPRemoteStateEvent): Promise<void> {
    const patch: MCPServerPatch = { status: event.state };
    if (event.state === "CONNECTED") {
      patch.lastConnectedAt = new Date().toISOString();
      patch.lastError = null;
    }
    if (event.error) {
      patch.lastError = event.error;
    }
    await this.options.store.updateServer(event.serverId, patch);
  }

  // ── Connection lifecycle ─────────────────────────────────────────────────

  /**
   * Restart recovery: connects every enabled, non-revoked server from the
   * store. Individual failures are recorded as DEGRADED and returned; they do
   * not block the remaining servers.
   */
  async initialize(): Promise<MCPInitializeResult> {
    const result: MCPInitializeResult = { connected: [], failed: [] };
    for (const server of await this.options.store.listServers()) {
      if (!server.enabled || server.status === "REVOKED") continue;
      try {
        await this.connectServer(server.id);
        result.connected.push(server.id);
      } catch (error) {
        result.failed.push({ serverId: server.id, error: messageOf(error) });
      }
    }
    return result;
  }

  async connectServer(id: string): Promise<void> {
    const entity = await this.options.store.getServer(id);
    if (!entity) throw new Error(`No registered MCP server: ${id}`);
    if (!entity.enabled) throw new Error(`MCP server is disabled: ${id}`);

    const definition = this.toServerDefinition(entity);
    await this.options.store.updateServer(id, { status: "CONNECTING" });
    try {
      await this.options.client.connect(definition);
      this.connected.add(id);
      await this.options.store.updateServer(id, {
        status: "CONNECTED",
        lastConnectedAt: new Date().toISOString(),
        lastError: null
      });
    } catch (error) {
      await this.options.store.updateServer(id, {
        status: "DEGRADED",
        lastError: messageOf(error)
      });
      throw error;
    }
  }

  async disconnectServer(id: string): Promise<void> {
    try {
      await this.options.client.disconnect(id);
    } catch {
      // Idempotent lifecycle op: already-disconnected servers are fine.
    } finally {
      this.connected.delete(id);
      await this.options.store.updateServer(id, { status: "DISCONNECTED" });
    }
  }

  /** Runs tools/list and persists the discovery result into mcp_tools. */
  async refreshTools(serverId: string): Promise<MCPToolEntity[]> {
    const entity = await this.options.store.getServer(serverId);
    if (!entity) throw new Error(`No registered MCP server: ${serverId}`);
    this.toServerDefinition(entity); // validates the row before touching the client
    const discovered = await this.options.client.listTools(serverId);
    return await this.options.store.upsertDiscoveredTools(
      serverId,
      discovered.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    );
  }

  async connectAndDiscover(serverId: string): Promise<MCPToolEntity[]> {
    await this.connectServer(serverId);
    return await this.refreshTools(serverId);
  }

  // ── Tool CRUD ────────────────────────────────────────────────────────────

  async listTools(serverId: string): Promise<MCPToolEntity[]> {
    return await this.options.store.listTools(serverId);
  }

  async setToolEnabled(toolId: string, enabled: boolean): Promise<MCPToolEntity | null> {
    return await this.options.store.updateTool(toolId, { enabled });
  }

  async updateToolPolicy(
    toolId: string,
    patch: { riskLevel?: MCPToolPolicy["riskLevel"]; requiresApproval?: boolean }
  ): Promise<MCPToolEntity | null> {
    return await this.options.store.updateTool(toolId, patch);
  }

  // ── Bindings (federation grants) ─────────────────────────────────────────

  async bindProject(input: MCPProjectBindingInput): Promise<void> {
    await this.requireServer(input.serverId);
    await this.options.store.replaceProjectBinding({
      projectId: input.projectId,
      serverId: input.serverId,
      toolNames: input.toolNames,
      enabled: input.enabled
    });
  }

  async bindAgent(input: MCPAgentBindingInput): Promise<void> {
    await this.requireServer(input.serverId);
    if (!input.agentName.trim()) throw new Error("agentName must not be empty");
    await this.options.store.replaceAgentBinding({
      projectId: input.projectId,
      serverId: input.serverId,
      agentName: input.agentName,
      toolNames: input.toolNames,
      enabled: input.enabled
    });
  }

  async unbindProject(projectId: string, serverId: string): Promise<void> {
    await this.options.store.removeProjectBinding(projectId, serverId);
  }

  async unbindAgent(projectId: string, agentName: string, serverId: string): Promise<void> {
    await this.options.store.removeAgentBinding(projectId, agentName, serverId);
  }

  async listBindings(
    filter: { projectId?: string; serverId?: string } = {}
  ): Promise<MCPToolBindingEntity[]> {
    return await this.options.store.listBindings(filter);
  }

  // ── Visibility (frozen chain, store-backed, fail-closed) ────────────────

  async isToolVisible(
    serverId: string,
    toolName: string,
    query: MCPRegistryQuery
  ): Promise<boolean> {
    try {
      if (!query.projectId || !query.agentName) return false;
      if (query.agentToolAllowlist && !query.agentToolAllowlist.includes(toolName)) return false;

      const server = await this.options.store.getServer(serverId);
      if (!server || !server.enabled || server.status === "REVOKED") return false;

      const tool = await this.options.store.getToolByName(serverId, toolName);
      if (!tool || !tool.enabled) return false;

      const bindings = await this.options.store.listBindings({
        projectId: query.projectId,
        serverId
      });
      const projectBound = bindings.some(
        (binding) =>
          binding.agentName == null &&
          binding.enabled &&
          (binding.mcpToolId == null || binding.mcpToolId === tool.id)
      );
      const agentBound = bindings.some(
        (binding) =>
          binding.agentName === query.agentName &&
          binding.enabled &&
          (binding.mcpToolId == null || binding.mcpToolId === tool.id)
      );

      const policy = this.policyFor(server, tool);

      return isMCPToolVisible({
        serverEnabled: server.enabled,
        projectBound,
        agentBound,
        toolEnabled: tool.enabled,
        policyAllowed: policy !== undefined
      });
    } catch {
      // Fail-closed: any store/definition failure denies the tool.
      return false;
    }
  }

  /** Visible MCP catalog (persisted metadata) for the query. */
  async listVisibleTools(query: MCPRegistryQuery): Promise<MCPToolEntity[]> {
    const visible: MCPToolEntity[] = [];
    for (const server of await this.options.store.listServers()) {
      if (!server.enabled || server.status === "REVOKED") continue;
      for (const tool of await this.options.store.listTools(server.id)) {
        if (await this.isToolVisible(server.id, tool.name, query)) visible.push(tool);
      }
    }
    return visible;
  }

  /**
   * Agent-visible MCP tools mapped onto the existing unified ToolDefinition.
   * canExecute re-reads the store on EVERY call, so a revocation (even by
   * another process) is honored before any request reaches the MCP server.
   */
  async listVisibleToolDefinitions(
    query: MCPRegistryQuery
  ): Promise<ToolDefinition<unknown, unknown>[]> {
    const definitions: ToolDefinition<unknown, unknown>[] = [];
    for (const server of await this.options.store.listServers()) {
      if (!server.enabled || server.status === "REVOKED") continue;
      if (query.serverIds && !query.serverIds.includes(server.id)) continue;
      for (const tool of await this.options.store.listTools(server.id)) {
        if (!(await this.isToolVisible(server.id, tool.name, query))) continue;
        const policy = this.policyFor(server, tool);
        if (!policy) continue;
        const adapter = createMCPToolAdapter(this.options.client, server.id, tool.name, {
          riskLevel: policy.riskLevel,
          canExecute: () => this.isToolVisible(server.id, tool.name, query),
          requiresApproval: policy.requiresApproval,
          approvalGate: this.options.approvalGate
        });
        definitions.push(
          toUnifiedToolDefinition(
            { name: tool.name, description: tool.description, inputSchema: tool.inputSchema },
            policy,
            adapter
          )
        );
      }
    }
    return definitions;
  }

  // ── Resource / Prompt capabilities (Phase 5.5-6, store-backed, fail-closed) ─

  /**
   * resources/list for one server. Denied (unbound/disabled/revoked) returns
   * an EMPTY list without contacting the MCP server — the same composition
   * semantics as listVisibleToolDefinitions. Resource-scoped grants use the
   * server-scope binding rows (mcpToolId IS NULL); tool-scoped rows never
   * authorize resources.
   */
  async listVisibleResources(
    serverId: string,
    query: MCPRegistryQuery
  ): Promise<MCPResourceDescriptor[]> {
    const server = await this.capabilityServer(serverId, query);
    if (!server) return [];
    const adapter = this.resourceAdapter(server, query);
    return await adapter.listResources();
  }

  /** resources/read. Denied reads THROW PERMISSION_DENIED before any request. */
  async readResource(
    serverId: string,
    uri: string,
    query: MCPRegistryQuery,
    signal?: AbortSignal
  ): Promise<MCPResourceReadResult> {
    const server = await this.capabilityServer(serverId, query);
    if (!server) {
      throw new MCPClientError(
        "PERMISSION_DENIED",
        `MCP resource ${serverId}/${uri} is not permitted`
      );
    }
    return await this.resourceAdapter(server, query).readResource(uri, signal);
  }

  /** prompts/list for one server; denied ⇒ empty list, zero MCP requests. */
  async listVisiblePrompts(
    serverId: string,
    query: MCPRegistryQuery
  ): Promise<MCPPromptDescriptor[]> {
    const server = await this.capabilityServer(serverId, query);
    if (!server) return [];
    return await this.promptAdapter(server, query).listPrompts();
  }

  /** prompts/get. Denied gets THROW PERMISSION_DENIED before any request. */
  async getPrompt(
    serverId: string,
    name: string,
    args: Record<string, string> | undefined,
    query: MCPRegistryQuery,
    signal?: AbortSignal
  ): Promise<MCPPromptResult> {
    const server = await this.capabilityServer(serverId, query);
    if (!server) {
      throw new MCPClientError(
        "PERMISSION_DENIED",
        `MCP prompt ${serverId}/${name} is not permitted`
      );
    }
    return await this.promptAdapter(server, query).getPrompt(name, args, signal);
  }

  /**
   * Phase 5.5-7: UI-app links (tool `_meta.ui.resourceUri`) of one server,
   * limited to tools whose read-visibility chain also passes. Denied
   * (unbound/disabled/revoked) returns an EMPTY list without contacting the
   * MCP server. The links only reference `ui://` resources — the app HTML is
   * fetched through readResource (same capability gate), never directly.
   */
  async listVisibleToolUiLinks(
    serverId: string,
    query: MCPRegistryQuery
  ): Promise<MCPToolUiLink[]> {
    const server = await this.capabilityServer(serverId, query);
    if (!server) return [];

    const tools = await this.options.client.listTools(serverId);
    const links: MCPToolUiLink[] = [];
    for (const tool of tools) {
      if (!tool.uiResourceUri) continue;
      const entity = await this.options.store.getToolByName(serverId, tool.name);
      if (!entity || !entity.enabled) continue;
      if (!(await this.isToolVisible(serverId, tool.name, query))) continue;
      links.push({ serverId, toolName: tool.name, resourceUri: tool.uiResourceUri });
    }
    return links;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /**
   * Phase 5.5-6 capability authorization: the server row must be enabled and
   * not REVOKED, and BOTH the project-scope and agent-scope server-level
   * grants (mcp_tool_bindings rows with mcp_tool_id IS NULL) must exist and be
   * enabled. Store failures deny (fail-closed). Tool-scoped rows do NOT grant
   * resource/prompt access. The agent tool allowlist (AgentPermissions.tools)
   * governs tools only and is deliberately not consulted here.
   */
  private async capabilityServer(
    serverId: string,
    query: MCPRegistryQuery
  ): Promise<MCPServerEntity | null> {
    try {
      if (!query.projectId || !query.agentName) return null;
      const server = await this.options.store.getServer(serverId);
      if (!server || !server.enabled || server.status === "REVOKED") return null;

      const bindings = await this.options.store.listBindings({
        projectId: query.projectId,
        serverId
      });
      const serverScopeGrant = (
        agentName: string | null | undefined,
        binding: MCPToolBindingEntity
      ) =>
        (binding.agentName ?? null) === agentName && binding.enabled && binding.mcpToolId == null;
      const projectBound = bindings.some((binding) => serverScopeGrant(null, binding));
      const agentBound = bindings.some((binding) =>
        serverScopeGrant(query.agentName ?? null, binding)
      );

      return projectBound && agentBound ? server : null;
    } catch {
      // Fail-closed: any store failure denies the capability.
      return null;
    }
  }

  /** Adapter wired with the call-time re-check and the platform policy provider. */
  private resourceAdapter(server: MCPServerEntity, query: MCPRegistryQuery) {
    return createMCPResourceAdapter(this.options.client, server.id, {
      canAccess: async () => (await this.capabilityServer(server.id, query)) !== null,
      policy: (resource) => this.resourcePolicyFor(server, resource)
    });
  }

  private promptAdapter(server: MCPServerEntity, query: MCPRegistryQuery) {
    return createMCPPromptAdapter(this.options.client, server.id, {
      canAccess: async () => (await this.capabilityServer(server.id, query)) !== null,
      policy: (prompt) => this.promptPolicyFor(server, { name: prompt.name })
    });
  }

  private resourcePolicyFor(
    server: MCPServerEntity,
    resource: MCPResourcePolicyContext
  ): MCPCapabilityPolicy | undefined {
    if (!this.options.resourcePolicyProvider) {
      return { riskLevel: "LOW" };
    }
    const descriptor: MCPResourceDescriptor = {
      serverId: server.id,
      uri: resource.uri,
      name: resource.name ?? resource.uri,
      mimeType: resource.mimeType
    };
    return this.options.resourcePolicyProvider(this.toServerDefinition(server), descriptor);
  }

  private promptPolicyFor(
    server: MCPServerEntity,
    prompt: { name: string }
  ): MCPCapabilityPolicy | undefined {
    if (!this.options.promptPolicyProvider) {
      return { riskLevel: "LOW" };
    }
    const descriptor: MCPPromptDescriptor = {
      serverId: server.id,
      name: prompt.name,
      arguments: []
    };
    return this.options.promptPolicyProvider(this.toServerDefinition(server), descriptor);
  }

  private async requireServer(serverId: string): Promise<MCPServerEntity> {
    const server = await this.options.store.getServer(serverId);
    if (!server) throw new Error(`No registered MCP server: ${serverId}`);
    return server;
  }

  private toServerDefinition(entity: MCPServerEntity): MCPServerDefinition {
    if (entity.transport === "stdio") {
      return validateMCPServerDefinition({
        id: entity.id,
        name: entity.name,
        description: entity.description,
        transport: "stdio",
        stdio: {
          command: entity.command,
          args: entity.args,
          env: entity.env,
          cwd: entity.cwd
        },
        enabled: entity.enabled,
        authRef: entity.authRef,
        credentialRef: entity.credentialRef
      });
    }
    if (entity.transport === "streamable-http") {
      return validateMCPServerDefinition({
        id: entity.id,
        name: entity.name,
        description: entity.description,
        transport: "streamable-http",
        endpoint: entity.endpoint,
        enabled: entity.enabled,
        authRef: entity.authRef,
        credentialRef: entity.credentialRef
      });
    }
    throw new Error(`Unsupported MCP transport "${entity.transport}"`);
  }

  private policyFor(server: MCPServerEntity, tool: MCPToolEntity): MCPToolPolicy | undefined {
    if (!this.options.policyProvider) {
      return { riskLevel: tool.riskLevel, requiresApproval: tool.requiresApproval };
    }
    const definition = this.toServerDefinition(server);
    const toolDefinition: MCPToolDefinition = {
      serverId: server.id,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    };
    return this.options.policyProvider(definition, toolDefinition);
  }
}
