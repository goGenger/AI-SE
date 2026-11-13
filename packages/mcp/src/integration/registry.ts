import { ToolDefinition, ToolExecutionContext } from "@ai-se/tool-runtime";
import {
  MCPClientPort,
  MCPServerDefinition,
  MCPToolDefinition,
  MCPToolPolicy,
  validateMCPServerDefinition
} from "../contracts";
import { createMCPToolAdapter, toUnifiedToolDefinition } from "./adapter";

/**
 * Phase 5.5-2: in-memory MCP Tool Registry.
 *
 * Implements the frozen visibility chain:
 *
 *   MCP Server registered → server enabled → project binding → agent binding
 *   → tool allowed → policy allowed → agent-visible
 *
 * Default is DENY: without a project AND agent binding, no MCP tool is visible.
 * Persistence (mcp_servers / mcp_tools / mcp_tool_bindings) arrives in 5.5-3;
 * this registry keeps the same semantics in memory so 5.5-3 can back it with
 * the database without changing the contract.
 */

export interface MCPToolRegistryOptions {
  client: MCPClientPort;
  servers: MCPServerDefinition[];
  /** Platform policy: risk/approval for a discovered tool. Returning undefined
   *  DENIES the tool. Default: MEDIUM, no approval. */
  policyProvider?: (
    server: MCPServerDefinition,
    tool: MCPToolDefinition
  ) => MCPToolPolicy | undefined;
  /** Platform approval gate, consulted when policy.requiresApproval is true. */
  approvalGate?: (context: ToolExecutionContext) => boolean | Promise<boolean>;
}

export interface MCPProjectBinding {
  projectId: string;
  serverId: string;
  /** Undefined = all discovered tools of the server. */
  toolNames?: string[];
}

export interface MCPAgentBinding {
  projectId: string;
  agentName: string;
  serverId: string;
  /** Undefined = all discovered tools of the server. */
  toolNames?: string[];
}

export interface MCPVisibilityQuery {
  projectId?: string;
  agentName?: string;
}

interface ServerEntry {
  definition: MCPServerDefinition;
  tools: MCPToolDefinition[];
}

const DEFAULT_POLICY: MCPToolPolicy = { riskLevel: "MEDIUM", requiresApproval: false };

function sameList(current: string[] | undefined, next: string[] | undefined): boolean {
  if (current === undefined || next === undefined) return current === next;
  if (current.length !== next.length) return false;
  return current.every((entry, index) => entry === next[index]);
}

export class MCPToolRegistry {
  private readonly servers = new Map<string, ServerEntry>();
  private readonly projectBindings: MCPProjectBinding[] = [];
  private readonly agentBindings: MCPAgentBinding[] = [];

  constructor(private readonly options: MCPToolRegistryOptions) {
    for (const server of options.servers) {
      this.registerServer(server);
    }
  }

  /** Validates and registers a server definition (frozen credential guard applies). */
  registerServer(server: unknown): MCPServerDefinition {
    const definition = validateMCPServerDefinition(server);
    if (this.servers.has(definition.id)) {
      throw new Error(`MCP server already registered: ${definition.id}`);
    }
    this.servers.set(definition.id, { definition, tools: [] });
    return definition;
  }

  getServer(serverId: string): MCPServerDefinition | undefined {
    return this.servers.get(serverId)?.definition;
  }

  async connectServer(serverId: string): Promise<void> {
    const entry = this.servers.get(serverId);
    if (!entry) throw new Error(`No registered MCP server named ${serverId}`);
    await this.options.client.connect(entry.definition);
  }

  async connectAll(): Promise<void> {
    for (const entry of this.servers.values()) {
      await this.options.client.connect(entry.definition);
    }
  }

  async disconnectServer(serverId: string): Promise<void> {
    await this.options.client.disconnect(serverId);
  }

  async disconnectAll(): Promise<void> {
    for (const entry of this.servers.values()) {
      await this.options.client.disconnect(entry.definition.id);
    }
  }

  /** Runs tools/list against the connected server and caches the discovered catalog. */
  async refreshTools(serverId: string): Promise<MCPToolDefinition[]> {
    const entry = this.servers.get(serverId);
    if (!entry) throw new Error(`No registered MCP server named ${serverId}`);
    const tools = await this.options.client.listTools(serverId);
    entry.tools = tools;
    return tools;
  }

  /** connect + initialize + tools/list in one step. */
  async connectAndDiscover(serverId: string): Promise<MCPToolDefinition[]> {
    await this.connectServer(serverId);
    return await this.refreshTools(serverId);
  }

  listDiscoveredTools(serverId: string): MCPToolDefinition[] {
    return [...(this.servers.get(serverId)?.tools ?? [])];
  }

  bindProject(binding: MCPProjectBinding): void {
    if (!this.servers.has(binding.serverId)) {
      throw new Error(`Cannot bind unknown MCP server: ${binding.serverId}`);
    }
    const existing = this.projectBindings.find(
      (entry) => entry.projectId === binding.projectId && entry.serverId === binding.serverId
    );
    if (existing) {
      existing.toolNames = binding.toolNames;
      return;
    }
    this.projectBindings.push({ ...binding });
  }

  bindAgent(binding: MCPAgentBinding): void {
    if (!this.servers.has(binding.serverId)) {
      throw new Error(`Cannot bind unknown MCP server: ${binding.serverId}`);
    }
    const existing = this.agentBindings.find(
      (entry) =>
        entry.projectId === binding.projectId &&
        entry.agentName === binding.agentName &&
        entry.serverId === binding.serverId
    );
    if (existing) {
      existing.toolNames = binding.toolNames;
      return;
    }
    this.agentBindings.push({ ...binding });
  }

  unbindProject(projectId: string, serverId: string): void {
    const index = this.projectBindings.findIndex(
      (entry) => entry.projectId === projectId && entry.serverId === serverId
    );
    if (index >= 0) this.projectBindings.splice(index, 1);
  }

  unbindAgent(projectId: string, agentName: string, serverId: string): void {
    const index = this.agentBindings.findIndex(
      (entry) =>
        entry.projectId === projectId &&
        entry.agentName === agentName &&
        entry.serverId === serverId
    );
    if (index >= 0) this.agentBindings.splice(index, 1);
  }

  /** Frozen visibility chain. Any false step ⇒ DENY (tool invisible, zero requests). */
  isToolVisible(serverId: string, toolName: string, query: MCPVisibilityQuery): boolean {
    const entry = this.servers.get(serverId);
    if (!entry || !entry.definition.enabled) return false;
    if (query.projectId === undefined || query.agentName === undefined) return false;

    const project = this.projectBindings.find(
      (binding) => binding.projectId === query.projectId && binding.serverId === serverId
    );
    if (!project) return false;

    const agent = this.agentBindings.find(
      (binding) =>
        binding.projectId === query.projectId &&
        binding.agentName === query.agentName &&
        binding.serverId === serverId
    );
    if (!agent) return false;

    if (!sameList(project.toolNames, undefined) && !project.toolNames?.includes(toolName))
      return false;
    if (!sameList(agent.toolNames, undefined) && !agent.toolNames?.includes(toolName)) return false;
    const tool = entry.tools.find((entryTool) => entryTool.name === toolName);
    if (!tool) return false;
    // Policy allowed: a policy provider that returns undefined DENIES the tool.
    if (!this.policyFor(serverId, tool)) return false;

    return true;
  }

  policyFor(serverId: string, tool: MCPToolDefinition): MCPToolPolicy | undefined {
    const definition = this.servers.get(serverId)?.definition;
    if (!definition) return undefined;
    if (!this.options.policyProvider) return DEFAULT_POLICY;
    return this.options.policyProvider(definition, tool);
  }

  /**
   * Agent-visible MCP tools for the query, mapped onto the existing unified
   * ToolDefinition. The returned definitions are ready to compose into the
   * current ToolRuntime (ToolRuntime.execute provides validation, audit,
   * timeout, cancellation, and error normalization).
   */
  listVisibleToolDefinitions(query: MCPVisibilityQuery): ToolDefinition<unknown, unknown>[] {
    const definitions: ToolDefinition<unknown, unknown>[] = [];
    for (const entry of this.servers.values()) {
      if (!entry.definition.enabled) continue;
      for (const tool of entry.tools) {
        if (!this.isToolVisible(entry.definition.id, tool.name, query)) continue;
        const policy = this.policyFor(entry.definition.id, tool);
        if (!policy) continue; // policy denied (isToolVisible already filtered, but keep the guard)
        const adapter = createMCPToolAdapter(this.options.client, entry.definition.id, tool.name, {
          riskLevel: policy.riskLevel,
          canExecute: () => this.isToolVisible(entry.definition.id, tool.name, query),
          requiresApproval: policy.requiresApproval,
          approvalGate: this.options.approvalGate
        });
        definitions.push(toUnifiedToolDefinition(tool, policy, adapter));
      }
    }
    return definitions;
  }

  /** Diagnostic view: visible MCP tool catalog for the query (names + servers). */
  listVisibleTools(query: MCPVisibilityQuery): MCPToolDefinition[] {
    const tools: MCPToolDefinition[] = [];
    for (const entry of this.servers.values()) {
      if (!entry.definition.enabled) continue;
      for (const tool of entry.tools) {
        if (this.isToolVisible(entry.definition.id, tool.name, query)) tools.push(tool);
      }
    }
    return tools;
  }
}
