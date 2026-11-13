import type {
  MCPBindingRowInput,
  MCPRegistryStore,
  MCPServerEntity,
  MCPToolBindingEntity,
  MCPToolEntity,
  MCPTransport,
  PersistentMCPRegistry
} from "@ai-se/mcp";
import type { ProjectRepository } from "@ai-se/database";
import type {
  CreateMCPBindingData,
  CreateMCPServerData,
  MCPBindingSummary,
  MCPServerDetail,
  MCPServerSummary,
  MCPToolSummary
} from "@ai-se/shared";

/**
 * Phase 5.5-5: MCP Console service (backend side of the console API).
 *
 * Read model: the PgMCPRegistryStore rows (mcp_servers / mcp_tools /
 * mcp_tool_bindings) — the same store the PersistentMCPRegistry uses, so the
 * console can never disagree with the enforcement path.
 *
 * Mutations: binding-row CRUD via the store's row methods. Bindings are
 * FEDERATION grants only: every change takes effect on the next visibility
 * read (call-time re-check in the registry), no restart or cache TTL involved.
 *
 * The service never touches MCP clients directly; connection lifecycle stays
 * in PersistentMCPRegistry (5.5-3/5.5-4).
 */

export interface MCPConsoleRegistries {
  stdio: PersistentMCPRegistry;
  "streamable-http": PersistentMCPRegistry;
}

export interface MCPConsoleServiceOptions {
  store: MCPRegistryStore;
  registries: MCPConsoleRegistries;
  projects?: ProjectRepository;
}

export interface MCPInitializeSummary {
  connected: string[];
  failed: Array<{ serverId: string; error: string }>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Compact schema summary for the tool table (no schema editor in v1). */
export function summarizeInputSchema(schema: unknown): string {
  if (typeof schema !== "object" || schema === null) return "No parameters";
  const record = schema as { properties?: unknown; required?: unknown };
  if (typeof record.properties !== "object" || record.properties === null) {
    return "No parameters";
  }
  const names = Object.keys(record.properties as Record<string, unknown>).sort();
  if (names.length === 0) return "No parameters";
  const required = Array.isArray(record.required)
    ? record.required.filter(
        (name): name is string => typeof name === "string" && names.includes(name)
      )
    : [];
  const suffix = required.length > 0 ? ` • required: ${required.join(", ")}` : "";
  return `Properties: ${names.join(", ")}${suffix}`;
}

export class MCPConsoleService {
  constructor(private readonly options: MCPConsoleServiceOptions) {}

  /**
   * Boot / restart recovery: connects every enabled, non-revoked server on
   * the registry of its transport and refreshes discovery. Individual
   * failures are reported, never fatal.
   */
  async initialize(): Promise<MCPInitializeSummary> {
    const summary: MCPInitializeSummary = { connected: [], failed: [] };
    for (const server of await this.options.store.listServers()) {
      if (!server.enabled || server.status === "REVOKED") continue;
      const registry = this.registryFor(server);
      try {
        await registry.connectServer(server.id);
        summary.connected.push(server.id);
      } catch (error) {
        summary.failed.push({ serverId: server.id, error: messageOf(error) });
        continue;
      }
      try {
        await registry.refreshTools(server.id);
      } catch (error) {
        summary.failed.push({ serverId: server.id, error: messageOf(error) });
      }
    }
    return summary;
  }

  /** Graceful shutdown: disconnect servers that still hold a connection. */
  async shutdown(): Promise<void> {
    for (const server of await this.options.store.listServers()) {
      if (!["CONNECTED", "CONNECTING", "DEGRADED", "RECONNECTING"].includes(server.status)) {
        continue;
      }
      await this.registryFor(server)
        .disconnectServer(server.id)
        .catch(() => undefined);
    }
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async listServers(): Promise<MCPServerSummary[]> {
    const servers = await this.options.store.listServers();
    const summaries: MCPServerSummary[] = [];
    for (const server of servers) {
      const tools = await this.options.store.listTools(server.id);
      summaries.push(toServerSummary(server, tools.length));
    }
    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getServer(id: string): Promise<MCPServerDetail | null> {
    const server = await this.options.store.getServer(id);
    if (!server) return null;
    const tools = await this.options.store.listTools(server.id);
    return toServerDetail(server, tools.length);
  }

  /** null → unknown server (HTTP 404). */
  async listTools(serverId: string): Promise<MCPToolSummary[] | null> {
    const server = await this.options.store.getServer(serverId);
    if (!server) return null;
    const tools = await this.options.store.listTools(serverId);
    return tools.map((tool) => toToolSummary(tool)).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** null → unknown server (HTTP 404). */
  async listBindings(serverId: string): Promise<MCPBindingSummary[] | null> {
    const server = await this.options.store.getServer(serverId);
    if (!server) return null;
    const bindings = await this.options.store.listBindings({ serverId });
    const summaries = await this.describeBindings(bindings);
    return summaries.sort((a, b) => {
      const scope = (a.agentName ?? "").localeCompare(b.agentName ?? "");
      if (scope !== 0) return scope;
      return (a.toolName ?? "").localeCompare(b.toolName ?? "");
    });
  }

  // ── Server registration (T2：控制台第一条服务器创建路径） ────────────────

  /**
   * Registers a server and, when it is enabled, immediately connects and
   * discovers its tools.
   *
   * 为什么这里不抛「连不上」：服务器行已经落库，连不上是**运行状态**而不是
   * 请求失败——把 5xx 返回给调用方会让用户重试一次就多出一条重复的服务器。
   * 连接失败由 registry 写进 `lastError`/`DEGRADED`，控制台列表直接可见。
   */
  async createServer(input: CreateMCPServerData): Promise<MCPServerDetail> {
    const registry = this.registryForTransport(input.transport);
    const enabled = input.enabled ?? true;
    const created = await registry.createServer({
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      transport: input.transport,
      ...(input.transport === "stdio"
        ? {
            stdio: {
              command: input.command!,
              ...(input.args !== undefined ? { args: input.args } : {}),
              ...(input.cwd !== undefined ? { cwd: input.cwd } : {})
            }
          }
        : {
            endpoint: input.endpoint!,
            ...(input.credentialRef !== undefined ? { credentialRef: input.credentialRef } : {})
          }),
      enabled
    });

    if (created.enabled) {
      try {
        await registry.connectServer(created.id);
        await registry.refreshTools(created.id);
      } catch {
        // 状态与 lastError 已由 registry 落库；这里只吞掉，保证响应仍是 201。
      }
    }

    const detail = await this.getServer(created.id);
    if (!detail) throw new Error(`MCP server ${created.id} vanished right after creation`);
    return detail;
  }

  // ── Tool mutations (T2：发现到的工具默认是关的，必须能打开） ──────────────

  /** null → unknown tool (HTTP 404). */
  async setToolEnabled(id: string, enabled: boolean): Promise<MCPToolSummary | null> {
    const tool = await this.options.store.updateTool(id, { enabled });
    return tool ? toToolSummary(tool) : null;
  }

  // ── Binding mutations (immediate effect on the visibility chain) ─────────

  /** Throws MCPRegistryStoreError on duplicate / unknown references. */
  async createBinding(serverId: string, input: CreateMCPBindingData): Promise<MCPBindingSummary> {
    const row: MCPBindingRowInput = {
      projectId: input.projectId,
      serverId,
      agentName: input.agentName,
      toolName: input.toolName,
      enabled: input.enabled
    };
    const binding = await this.options.store.createBinding(row);
    const [summary] = await this.describeBindings([binding]);
    return summary;
  }

  async setBindingEnabled(id: string, enabled: boolean): Promise<MCPBindingSummary | null> {
    const binding = await this.options.store.updateBinding(id, { enabled });
    if (!binding) return null;
    const [summary] = await this.describeBindings([binding]);
    return summary;
  }

  async deleteBinding(id: string): Promise<boolean> {
    return await this.options.store.deleteBinding(id);
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private registryFor(server: MCPServerEntity): PersistentMCPRegistry {
    return this.registryForTransport(server.transport);
  }

  private registryForTransport(transport: MCPTransport): PersistentMCPRegistry {
    if (transport === "stdio") return this.options.registries.stdio;
    if (transport === "streamable-http") {
      return this.options.registries["streamable-http"];
    }
    throw new Error(`Unsupported MCP transport "${transport}"`);
  }

  private async describeBindings(bindings: MCPToolBindingEntity[]): Promise<MCPBindingSummary[]> {
    const servers = new Map(
      (await this.options.store.listServers()).map((server) => [server.id, server.name])
    );
    const projectNames = new Map<string, string | undefined>();
    const toolsByServer = new Map<string, MCPToolEntity[]>();
    const summaries: MCPBindingSummary[] = [];

    for (const binding of bindings) {
      if (!toolsByServer.has(binding.mcpServerId)) {
        toolsByServer.set(
          binding.mcpServerId,
          await this.options.store.listTools(binding.mcpServerId)
        );
      }
      const tool = toolsByServer
        .get(binding.mcpServerId)!
        .find((entry) => entry.id === binding.mcpToolId);
      if (!projectNames.has(binding.projectId) && this.options.projects) {
        const project = await this.options.projects.findById(binding.projectId).catch(() => null);
        projectNames.set(binding.projectId, project?.name);
      }
      summaries.push({
        id: binding.id,
        projectId: binding.projectId,
        projectName: projectNames.get(binding.projectId),
        agentName: binding.agentName,
        serverId: binding.mcpServerId,
        serverName: servers.get(binding.mcpServerId),
        toolId: binding.mcpToolId,
        toolName: tool?.name,
        enabled: binding.enabled,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt
      });
    }
    return summaries;
  }
}

function toServerSummary(server: MCPServerEntity, toolCount: number): MCPServerSummary {
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    transport: server.transport,
    enabled: server.enabled,
    status: server.status,
    toolCount,
    lastConnectedAt: server.lastConnectedAt,
    lastError: server.lastError
  };
}

function toServerDetail(server: MCPServerEntity, toolCount: number): MCPServerDetail {
  return {
    ...toServerSummary(server, toolCount),
    command: server.command,
    args: server.transport === "stdio" ? server.args : undefined,
    endpoint: server.endpoint,
    // References only — the console never sees credential values.
    authRef: server.authRef,
    credentialRef: server.credentialRef,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt
  };
}

function toToolSummary(tool: MCPToolEntity): MCPToolSummary {
  return {
    id: tool.id,
    serverId: tool.mcpServerId,
    name: tool.name,
    description: tool.description,
    enabled: tool.enabled,
    riskLevel: tool.riskLevel,
    requiresApproval: tool.requiresApproval,
    inputSchemaSummary: summarizeInputSchema(tool.inputSchema)
  };
}
