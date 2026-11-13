import { randomUUID } from "node:crypto";
import { MCPServerEntity, MCPToolBindingEntity, MCPToolEntity } from "../persistence";
import {
  DiscoveredToolRecord,
  MCPBindingFilter,
  MCPBindingRowInput,
  MCPBindingScopeInput,
  MCPRegistryStore,
  MCPRegistryStoreError,
  MCPServerPatch,
  MCPToolPatch,
  NewMCPServerRecord
} from "./store";

/**
 * In-memory MCPRegistryStore for tests and simple embeddings. It mirrors the
 * PostgreSQL semantics (fail-closed defaults, replace-scope binding writes)
 * so the persistent registry can be exercised without a database.
 */
export class InMemoryMCPRegistryStore implements MCPRegistryStore {
  private readonly servers = new Map<string, MCPServerEntity>();
  private readonly tools = new Map<string, MCPToolEntity>();
  private readonly bindings: MCPToolBindingEntity[] = [];

  private now(): string {
    return new Date().toISOString();
  }

  async createServer(record: NewMCPServerRecord): Promise<MCPServerEntity> {
    if ([...this.servers.values()].some((server) => server.name === record.name)) {
      throw new Error(`MCP server name already registered: ${record.name}`);
    }
    const timestamp = this.now();
    const entity: MCPServerEntity = {
      id: record.id,
      name: record.name,
      description: record.description,
      transport: record.transport,
      endpoint: record.endpoint,
      command: record.command,
      args: [...record.args],
      env: { ...record.env },
      cwd: record.cwd,
      status: record.status,
      enabled: record.enabled,
      authRef: record.authRef,
      credentialRef: record.credentialRef,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.servers.set(entity.id, entity);
    return { ...entity };
  }

  async getServer(id: string): Promise<MCPServerEntity | null> {
    const entity = this.servers.get(id);
    return entity ? { ...entity } : null;
  }

  async listServers(): Promise<MCPServerEntity[]> {
    return [...this.servers.values()].map((entity) => ({ ...entity }));
  }

  async updateServer(id: string, patch: MCPServerPatch): Promise<MCPServerEntity | null> {
    const entity = this.servers.get(id);
    if (!entity) return null;
    const assignDefined = <T extends keyof MCPServerEntity>(
      key: T,
      value: MCPServerEntity[T] | null | undefined
    ) => {
      if (value === undefined) return;
      if (value === null) {
        delete entity[key];
        return;
      }
      entity[key] = value;
    };
    assignDefined("name", patch.name);
    assignDefined("description", patch.description);
    assignDefined("transport", patch.transport);
    assignDefined("endpoint", patch.endpoint);
    assignDefined("command", patch.command);
    if (patch.args !== undefined) entity.args = [...patch.args];
    if (patch.env !== undefined) entity.env = { ...patch.env };
    assignDefined("cwd", patch.cwd);
    assignDefined("status", patch.status);
    assignDefined("enabled", patch.enabled);
    assignDefined("authRef", patch.authRef);
    assignDefined("credentialRef", patch.credentialRef);
    assignDefined("lastConnectedAt", patch.lastConnectedAt);
    assignDefined("lastError", patch.lastError);
    entity.updatedAt = this.now();
    return { ...entity };
  }

  async deleteServer(id: string): Promise<boolean> {
    if (!this.servers.delete(id)) return false;
    for (const [toolId, tool] of [...this.tools]) {
      if (tool.mcpServerId === id) this.tools.delete(toolId);
    }
    for (let index = this.bindings.length - 1; index >= 0; index -= 1) {
      if (this.bindings[index].mcpServerId === id) this.bindings.splice(index, 1);
    }
    return true;
  }

  async listTools(serverId: string): Promise<MCPToolEntity[]> {
    return [...this.tools.values()]
      .filter((tool) => tool.mcpServerId === serverId)
      .map((tool) => ({ ...tool }));
  }

  async getToolById(id: string): Promise<MCPToolEntity | null> {
    const tool = this.tools.get(id);
    return tool ? { ...tool } : null;
  }

  async getToolByName(serverId: string, name: string): Promise<MCPToolEntity | null> {
    const tool = [...this.tools.values()].find(
      (entry) => entry.mcpServerId === serverId && entry.name === name
    );
    return tool ? { ...tool } : null;
  }

  async upsertDiscoveredTools(
    serverId: string,
    tools: DiscoveredToolRecord[]
  ): Promise<MCPToolEntity[]> {
    for (const discovered of tools) {
      const existing = [...this.tools.values()].find(
        (entry) => entry.mcpServerId === serverId && entry.name === discovered.name
      );
      const timestamp = this.now();
      if (existing) {
        existing.description = discovered.description;
        existing.inputSchema = (discovered.inputSchema ?? {}) as MCPToolEntity["inputSchema"];
        existing.updatedAt = timestamp;
        continue;
      }
      const entity: MCPToolEntity = {
        id: randomUUID(),
        mcpServerId: serverId,
        name: discovered.name,
        description: discovered.description,
        inputSchema: (discovered.inputSchema ?? {}) as MCPToolEntity["inputSchema"],
        enabled: false,
        riskLevel: "MEDIUM",
        requiresApproval: false,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      this.tools.set(entity.id, entity);
    }
    return await this.listTools(serverId);
  }

  async updateTool(id: string, patch: MCPToolPatch): Promise<MCPToolEntity | null> {
    const tool = this.tools.get(id);
    if (!tool) return null;
    if (patch.enabled !== undefined) tool.enabled = patch.enabled;
    if (patch.riskLevel !== undefined) tool.riskLevel = patch.riskLevel;
    if (patch.requiresApproval !== undefined) tool.requiresApproval = patch.requiresApproval;
    tool.updatedAt = this.now();
    return { ...tool };
  }

  async listBindings(filter: MCPBindingFilter): Promise<MCPToolBindingEntity[]> {
    return this.bindings
      .filter((binding) => (filter.projectId ? binding.projectId === filter.projectId : true))
      .filter((binding) => (filter.serverId ? binding.mcpServerId === filter.serverId : true))
      .map((binding) => ({ ...binding }));
  }

  private toolIdFor(serverId: string, toolName: string): string {
    const tool = [...this.tools.values()].find(
      (entry) => entry.mcpServerId === serverId && entry.name === toolName
    );
    if (!tool) {
      throw new Error(`Unknown MCP tool ${serverId}/${toolName} for binding`);
    }
    return tool.id;
  }

  private replaceScope(
    projectId: string,
    serverId: string,
    agentName: string | undefined,
    toolNames: string[] | undefined,
    enabled: boolean
  ): void {
    for (let index = this.bindings.length - 1; index >= 0; index -= 1) {
      const binding = this.bindings[index];
      if (
        binding.projectId === projectId &&
        binding.mcpServerId === serverId &&
        binding.agentName === agentName
      ) {
        this.bindings.splice(index, 1);
      }
    }
    const timestamp = this.now();
    const scopes = toolNames ?? [undefined];
    for (const toolName of scopes) {
      this.bindings.push({
        id: randomUUID(),
        projectId,
        agentName,
        mcpServerId: serverId,
        mcpToolId: toolName === undefined ? undefined : this.toolIdFor(serverId, toolName),
        enabled,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }
  }

  async replaceProjectBinding(input: MCPBindingScopeInput): Promise<void> {
    this.replaceScope(
      input.projectId,
      input.serverId,
      undefined,
      input.toolNames,
      input.enabled ?? true
    );
  }

  async replaceAgentBinding(input: MCPBindingScopeInput & { agentName: string }): Promise<void> {
    this.replaceScope(
      input.projectId,
      input.serverId,
      input.agentName,
      input.toolNames,
      input.enabled ?? true
    );
  }

  async removeProjectBinding(projectId: string, serverId: string): Promise<void> {
    this.replaceScope(projectId, serverId, undefined, [], true);
  }

  async removeAgentBinding(projectId: string, agentName: string, serverId: string): Promise<void> {
    for (let index = this.bindings.length - 1; index >= 0; index -= 1) {
      const binding = this.bindings[index];
      if (
        binding.projectId === projectId &&
        binding.agentName === agentName &&
        binding.mcpServerId === serverId
      ) {
        this.bindings.splice(index, 1);
      }
    }
  }

  // ── Phase 5.5-5: binding-row CRUD (console) ──────────────────────────────

  async createBinding(input: MCPBindingRowInput): Promise<MCPToolBindingEntity> {
    let toolId: string | undefined;
    if (input.toolName !== undefined) {
      const tool = [...this.tools.values()].find(
        (entry) => entry.mcpServerId === input.serverId && entry.name === input.toolName
      );
      if (!tool) {
        throw new MCPRegistryStoreError(
          "UNKNOWN_TOOL",
          `Unknown MCP tool ${input.serverId}/${input.toolName} for binding`
        );
      }
      toolId = tool.id;
    }

    const duplicate = this.bindings.some(
      (binding) =>
        binding.projectId === input.projectId &&
        binding.mcpServerId === input.serverId &&
        (binding.agentName ?? null) === (input.agentName ?? null) &&
        (binding.mcpToolId ?? null) === (toolId ?? null)
    );
    if (duplicate) {
      throw new MCPRegistryStoreError(
        "DUPLICATE_BINDING",
        `MCP binding already exists for ${input.serverId}/${input.toolName ?? "all tools"}`
      );
    }

    const timestamp = this.now();
    const binding: MCPToolBindingEntity = {
      id: randomUUID(),
      projectId: input.projectId,
      agentName: input.agentName,
      mcpServerId: input.serverId,
      mcpToolId: toolId,
      enabled: input.enabled ?? true,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.bindings.push(binding);
    return { ...binding };
  }

  async updateBinding(
    id: string,
    patch: { enabled: boolean }
  ): Promise<MCPToolBindingEntity | null> {
    const binding = this.bindings.find((entry) => entry.id === id);
    if (!binding) return null;
    binding.enabled = patch.enabled;
    binding.updatedAt = this.now();
    return { ...binding };
  }

  async deleteBinding(id: string): Promise<boolean> {
    const index = this.bindings.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.bindings.splice(index, 1);
    return true;
  }
}
