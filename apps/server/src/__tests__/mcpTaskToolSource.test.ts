import {
  InMemoryMCPRegistryStore,
  PersistentMCPRegistry,
  type MCPClientPort,
  type MCPPromptResult,
  type MCPResourceReadResult,
  type MCPServerDefinition,
  type MCPToolDefinition
} from "@ai-se/mcp";
import { describe, expect, it } from "vitest";
import {
  MCP_TASK_TOOL_LIMIT,
  MCPTaskToolSource,
  assignServerAliases,
  namespaceToolName
} from "../services/mcpTaskToolSource";

/**
 * T2（`docs/231` §3.3）：MCP 工具进入任务工具集的三条约束。
 *
 * 可见性链（绑定 / 启用 / 吊销）用**真实的** `PersistentMCPRegistry` 跑，
 * 只有 MCP 协议客户端是假的——所以这里断言的「未绑定就不可见」不是替身行为。
 */

const PROJECT_ID = "6f0d2c1a-1111-4c1a-8f0e-000000000001";
const OTHER_PROJECT_ID = "6f0d2c1a-1111-4c1a-8f0e-000000000002";

class FakeClient implements MCPClientPort {
  private readonly tools = new Map<string, string[]>();

  constructor(private readonly toolNames: (server: MCPServerDefinition) => string[]) {}

  async connect(server: MCPServerDefinition): Promise<void> {
    this.tools.set(server.id, this.toolNames(server));
  }

  async disconnect(serverId: string): Promise<void> {
    this.tools.delete(serverId);
  }

  async listTools(serverId: string): Promise<MCPToolDefinition[]> {
    return (this.tools.get(serverId) ?? []).map((name) => ({
      serverId,
      name,
      description: `tool ${name}`,
      inputSchema: { type: "object", properties: {} }
    }));
  }

  async callTool(): Promise<unknown> {
    throw new Error("not exercised");
  }

  async listResources(): Promise<never[]> {
    return [];
  }

  async readResource(): Promise<MCPResourceReadResult> {
    throw new Error("not exercised");
  }

  async listPrompts(): Promise<never[]> {
    return [];
  }

  async getPrompt(): Promise<MCPPromptResult> {
    throw new Error("not exercised");
  }
}

interface HarnessOptions {
  toolNames?: (server: MCPServerDefinition) => string[];
}

function buildHarness(options: HarnessOptions = {}) {
  const store = new InMemoryMCPRegistryStore();
  const client = new FakeClient(
    options.toolNames ?? ((server) => [`${server.name}-tool-a`, `${server.name}-tool-b`])
  );
  const registries = {
    stdio: new PersistentMCPRegistry({ client, store }),
    "streamable-http": new PersistentMCPRegistry({ client, store })
  };
  const source = new MCPTaskToolSource({ store, registries, maxTools: MCP_TASK_TOOL_LIMIT });
  return { store, registries, source };
}

/** 注册 + 连接 + 发现工具（走真实 registry 路径）。 */
async function addServer(
  harness: ReturnType<typeof buildHarness>,
  name: string,
  extra: { enabled?: boolean } = {}
) {
  const registry = harness.registries.stdio;
  const server = await registry.createServer({
    name,
    transport: "stdio",
    stdio: { command: "fake-mcp" },
    enabled: extra.enabled ?? true
  });
  if (extra.enabled ?? true) {
    await registry.connectServer(server.id);
    await registry.refreshTools(server.id);
  }
  return server;
}

/**
 * 让工具真的可见：冻结的可见性链要求**项目级与 agent 级绑定同时存在**
 * （`isMCPToolVisible` 是 AND），并且**工具本身已启用**
 * （`mcp_tools.enabled` 建表默认 FALSE）。这是既有语义，不是本阶段引入的。
 */
async function bind(
  harness: ReturnType<typeof buildHarness>,
  serverId: string,
  options: { agentName?: string; toolName?: string } = {}
) {
  const agentName = options.agentName ?? "backend";
  const scoped = options.toolName !== undefined ? { toolName: options.toolName } : {};
  await harness.store.createBinding({ projectId: PROJECT_ID, serverId });
  await harness.store.createBinding({ projectId: PROJECT_ID, serverId, agentName, ...scoped });
}

/** 运维在控制台逐个打开工具（默认是关的）。 */
async function enableTools(harness: ReturnType<typeof buildHarness>, serverId: string) {
  for (const tool of await harness.store.listTools(serverId)) {
    await harness.store.updateTool(tool.id, { enabled: true });
  }
}

describe("MCPTaskToolSource（T2）", () => {
  it("没有绑定 ⇒ 一个工具都不可见（fail-closed）", async () => {
    const harness = buildHarness();
    await addServer(harness, "github");

    const toolset = await harness.source.forTask({ projectId: PROJECT_ID, agentName: "backend" });

    expect(toolset.tools).toEqual([]);
    expect(toolset.visibleCount).toBe(0);
    expect(toolset.truncated).toBe(false);
  });

  it("项目 + agent 绑定后工具可见，名字进命名空间且只含模型 API 允许的字符", async () => {
    const harness = buildHarness({
      // 带点的工具名（真实 MCP 服务器里很常见）
      toolNames: () => ["search.web", "read_file"]
    });
    const server = await addServer(harness, "GitHub MCP");
    await bind(harness, server.id);
    await enableTools(harness, server.id);

    const toolset = await harness.source.forTask({ projectId: PROJECT_ID, agentName: "backend" });

    expect(toolset.tools.map((tool) => tool.name).sort()).toEqual([
      "mcp__github-mcp__read_file",
      "mcp__github-mcp__search_web"
    ]);
    for (const tool of toolset.tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
    expect(toolset.truncated).toBe(false);
  });

  it("只有项目级绑定、没有 agent 级绑定 ⇒ 仍不可见（AND 语义）", async () => {
    const harness = buildHarness();
    const server = await addServer(harness, "github");
    await harness.store.createBinding({ projectId: PROJECT_ID, serverId: server.id });
    await enableTools(harness, server.id);

    const toolset = await harness.source.forTask({ projectId: PROJECT_ID, agentName: "backend" });

    expect(toolset.tools).toEqual([]);
  });

  it("工具默认是关闭的：绑定齐全但没打开工具 ⇒ 仍不可见", async () => {
    const harness = buildHarness();
    const server = await addServer(harness, "github");
    await bind(harness, server.id);

    const before = await harness.source.forTask({
      projectId: PROJECT_ID,
      agentName: "backend"
    });
    expect(before.tools).toEqual([]);

    await enableTools(harness, server.id);
    const after = await harness.source.forTask({ projectId: PROJECT_ID, agentName: "backend" });
    expect(after.tools).toHaveLength(2);
  });

  it("别的项目的绑定不会漏进来", async () => {
    const harness = buildHarness();
    const server = await addServer(harness, "github");
    await harness.store.createBinding({ projectId: OTHER_PROJECT_ID, serverId: server.id });

    const toolset = await harness.source.forTask({ projectId: PROJECT_ID, agentName: "backend" });

    expect(toolset.tools).toEqual([]);
  });

  it("超过上限按 20 截断，并如实报告截断前总数", async () => {
    const harness = buildHarness({
      toolNames: () => Array.from({ length: 25 }, (_, index) => `tool-${String(index).padStart(2, "0")}`)
    });
    const server = await addServer(harness, "big");
    await bind(harness, server.id);
    await enableTools(harness, server.id);

    const toolset = await harness.source.forTask({ projectId: PROJECT_ID, agentName: "backend" });

    expect(toolset.tools).toHaveLength(MCP_TASK_TOOL_LIMIT);
    expect(toolset.visibleCount).toBe(25);
    expect(toolset.truncated).toBe(true);
    // 稳定排序：截断后留下的是名称靠前的 20 个，不是随机的 20 个。
    expect(toolset.tools[0]?.name).toBe("mcp__big__tool-00");
    expect(toolset.tools.at(-1)?.name).toBe("mcp__big__tool-19");
  });

  it("截断时点名了具体工具的绑定优先于授予整台服务器的绑定", async () => {
    const harness = buildHarness({
      toolNames: (server) => [`${server.name}-a`, `${server.name}-b`]
    });
    const broad = await addServer(harness, "aaa-broad");
    const precise = await addServer(harness, "zzz-precise");
    await bind(harness, broad.id);
    // 只点名 zzz-precise-b：它排在名称序的后面，但应当先被保留。
    await bind(harness, precise.id, { toolName: "zzz-precise-b" });
    await enableTools(harness, broad.id);
    await enableTools(harness, precise.id);

    const capped = new MCPTaskToolSource({
      store: harness.store,
      registries: harness.registries,
      maxTools: 1
    });
    const toolset = await capped.forTask({ projectId: PROJECT_ID, agentName: "backend" });

    expect(toolset.tools.map((tool) => tool.name)).toEqual(["mcp__zzz-precise__zzz-precise-b"]);
    expect(toolset.truncated).toBe(true);
  });

  it("被停用的服务器不贡献工具（即便有绑定）", async () => {
    const harness = buildHarness();
    const server = await addServer(harness, "github");
    await bind(harness, server.id);
    await harness.store.updateServer(server.id, { enabled: false });

    const toolset = await harness.source.forTask({ projectId: PROJECT_ID, agentName: "backend" });

    expect(toolset.tools).toEqual([]);
  });
});

describe("命名与别名", () => {
  it("同名服务器得到互不覆盖的别名", () => {
    const aliases = assignServerAliases([
      { id: "b", name: "GitHub" } as never,
      { id: "a", name: "github" } as never
    ]);

    expect(aliases.get("a")).toBe("github");
    expect(aliases.get("b")).toBe("github-2");
  });

  it("空名称与全非 ASCII 名称回落到 server", () => {
    const aliases = assignServerAliases([{ id: "x", name: "  " } as never]);
    expect(aliases.get("x")).toBe("server");
  });

  it("prefix 段与工具段分别清洗，分隔符保持双下划线", () => {
    expect(namespaceToolName("my srv", "do.thing")).toBe("mcp__my_srv__do_thing");
  });
});
