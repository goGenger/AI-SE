import type {
  MCPRegistryStore,
  MCPServerEntity,
  MCPToolBindingEntity,
  PersistentMCPRegistry
} from "@ai-se/mcp";
import type { ToolDefinition } from "@ai-se/tool-runtime";

/**
 * T2：把「绑定可见的 MCP 工具」变成 agent 任务工具集的一部分（`docs/231` §3）。
 *
 * 三条约束都落在这一层：
 *   1. **命名空间**——模型 API 只接受 `^[a-zA-Z0-9_-]+$`（实测点号 400，见 `docs/232`），
 *      故用 `mcp__<server>__<tool>`；工具名自身的其它字符一律降为 `_`。
 *   2. **上限 20**——按绑定优先级（agent 级 > 项目级）再按名称稳定排序后截断，
 *      调用方据此记一条「被截断」事件。
 *   3. **任务开始快照**——每个任务只调用一次 `forTask()`；此后列表不再重算。
 *      掉线的服务器由 registry 的 `canExecute` 在**每次调用**时重新判定（fail-closed），
 *      所以「快照 + 掉线即 DENY」两条同时成立。
 *
 * 这个类只做**读取与投影**，不持有任何授权判断：可⻅性唯一来源仍是
 * `PersistentMCPRegistry.listVisibleToolDefinitions`（绑定、启用、策略、吊销）。
 */

export const MCP_TASK_TOOL_LIMIT = 20;

/** 模型 API 的函数名约束：`^[a-zA-Z0-9_-]+$`（`mcp.` 前缀会把整次请求打成 400）。 */
export const MCP_TOOL_NAME_PREFIX = "mcp__";

export interface MCPTaskToolQuery {
  projectId: string;
  agentName: string;
}

export interface MCPTaskToolset {
  tools: ToolDefinition<unknown, unknown>[];
  /** 绑定可见的工具总数（截断前）——与 tools.length 不等即发生了截断。 */
  visibleCount: number;
  truncated: boolean;
}

export interface MCPTaskToolSourceOptions {
  store: Pick<MCPRegistryStore, "listServers" | "listTools" | "listBindings">;
  registries: { stdio: PersistentMCPRegistry; "streamable-http": PersistentMCPRegistry };
  maxTools?: number;
}

interface Candidate {
  /** 0 = 绑定点名了这个工具；1 = 绑定授予整台服务器。小者优先。 */
  rank: number;
  alias: string;
  definition: ToolDefinition<unknown, unknown>;
  sortKey: string;
}

/** 工具名降级到模型 API 允许的字符集；不影响可读性（`search.web` → `search_web`）。 */
export function sanitizeToolNamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function namespaceToolName(alias: string, toolName: string): string {
  return `${MCP_TOOL_NAME_PREFIX}${sanitizeToolNamePart(alias)}__${sanitizeToolNamePart(toolName)}`;
}

/**
 * 服务器别名：取名称的小写 slug。重名时按 id 顺序追加 `-2`、`-3`——
 * 别名一旦进过工具名，就必须在**同一批**里唯一，否则两个服务器会互相覆盖。
 */
export function assignServerAliases(servers: MCPServerEntity[]): Map<string, string> {
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  for (const server of [...servers].sort((a, b) => a.id.localeCompare(b.id))) {
    const base =
      server.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "server";
    let alias = base;
    let suffix = 2;
    while (used.has(alias)) {
      alias = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(alias);
    aliases.set(server.id, alias);
  }
  return aliases;
}

export class MCPTaskToolSource {
  constructor(private readonly options: MCPTaskToolSourceOptions) {}

  /**
   * 该 (项目, agent) 在**任务开始时**可用的 MCP 工具快照。
   * 单个服务器读取失败只损失它自己的工具，不牵连整个任务。
   */
  async forTask(query: MCPTaskToolQuery): Promise<MCPTaskToolset> {
    const limit = this.options.maxTools ?? MCP_TASK_TOOL_LIMIT;
    const servers = await this.options.store.listServers();
    const aliases = assignServerAliases(servers);
    const bindings = await this.options.store.listBindings({ projectId: query.projectId });
    const candidates: Candidate[] = [];

    for (const server of servers) {
      if (!server.enabled || server.status === "REVOKED") continue;
      const alias = aliases.get(server.id);
      if (!alias) continue;

      // 排序依据：本 agent 在该服务器上的绑定，哪些点名了具体工具。
      // 注意可见性另有判据（registry 的 isToolVisible 要求项目级与 agent 级**同时**存在），
      // 这里只决定「截断时先留谁」，不决定「谁能被看见」。
      const ranks = await this.toolRanks(server.id, query.agentName, bindings);
      if (ranks.size === 0) continue;

      let definitions: ToolDefinition<unknown, unknown>[];
      try {
        definitions = await this.registryFor(server).listVisibleToolDefinitions({
          projectId: query.projectId,
          agentName: query.agentName,
          serverIds: [server.id]
        });
      } catch {
        // fail-closed：这台服务器这一轮贡献 0 个工具。
        continue;
      }

      for (const definition of definitions) {
        const rank = ranks.get(definition.name);
        if (rank === undefined) continue;
        candidates.push({
          rank,
          alias,
          definition,
          sortKey: `${alias}__${definition.name}`
        });
      }
    }

    candidates.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.sortKey.localeCompare(b.sortKey);
    });

    const chosen = candidates.slice(0, limit);
    const tools = chosen.map((candidate) => ({
      ...candidate.definition,
      name: namespaceToolName(candidate.alias, candidate.definition.name)
    }));

    return {
      tools,
      visibleCount: candidates.length,
      truncated: candidates.length > limit
    };
  }

  private registryFor(server: MCPServerEntity): PersistentMCPRegistry {
    return server.transport === "stdio"
      ? this.options.registries.stdio
      : this.options.registries["streamable-http"];
  }

  /**
   * 本 agent 在该服务器上的绑定 → 每个工具的排序档位。
   * 空 Map = 这台服务器对本 agent 没有任何绑定（一个工具也不该进来）。
   *
   * 档位只分辨一件事：绑定点名了具体工具（0）还是授予整台服务器（1）。
   * 之所以不按「项目级 vs agent 级」分档——可见性链要求两者**同时**存在，
   * 到了这一层已经没有「只有项目级」的工具了。
   */
  private async toolRanks(
    serverId: string,
    agentName: string,
    bindings: MCPToolBindingEntity[]
  ): Promise<Map<string, number>> {
    const mine = bindings.filter(
      (binding) =>
        binding.enabled && binding.mcpServerId === serverId && binding.agentName === agentName
    );
    if (mine.length === 0) return new Map();

    const tools = await this.options.store.listTools(serverId);
    const ranks = new Map<string, number>();
    const nameById = new Map(tools.map((tool) => [tool.id, tool.name]));
    for (const binding of mine) {
      if (binding.mcpToolId == null) continue;
      const name = nameById.get(binding.mcpToolId);
      if (name !== undefined) ranks.set(name, 0);
    }
    if (mine.some((binding) => binding.mcpToolId == null)) {
      for (const tool of tools) {
        if (!ranks.has(tool.name)) ranks.set(tool.name, 1);
      }
    }
    return ranks;
  }
}
