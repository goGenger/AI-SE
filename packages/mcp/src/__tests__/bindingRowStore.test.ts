import { describe, expect, it } from "vitest";
import { MCPClientPort, MCPServerDefinition, MCPToolDefinition } from "../contracts";
import { InMemoryMCPRegistryStore } from "../registry/inMemoryStore";
import { PersistentMCPRegistry } from "../registry/persistentRegistry";
import { MCPRegistryStoreError } from "../registry/store";

/**
 * Phase 5.5-5: binding-ROW CRUD on the store port (the console management
 * unit). Scope semantics of replaceProjectBinding / replaceAgentBinding are
 * covered by persistentRegistry.test.ts and stay unchanged.
 */

class UnusedClient implements MCPClientPort {
  async connect(_server: MCPServerDefinition): Promise<void> {
    throw new Error("not used");
  }
  async disconnect(_serverId: string): Promise<void> {
    throw new Error("not used");
  }
  async listTools(_serverId: string): Promise<MCPToolDefinition[]> {
    throw new Error("not used");
  }
  async callTool(
    _serverId: string,
    _name: string,
    _input: unknown,
    _signal?: AbortSignal
  ): Promise<unknown> {
    throw new Error("not used");
  }
  async listResources(): Promise<never> {
    throw new Error("not used");
  }
  async readResource(): Promise<never> {
    throw new Error("not used");
  }
  async listPrompts(): Promise<never> {
    throw new Error("not used");
  }
  async getPrompt(): Promise<never> {
    throw new Error("not used");
  }
}

async function seededStore() {
  const store = new InMemoryMCPRegistryStore();
  const server = await store.createServer({
    id: "server-1",
    name: "fixture",
    description: "",
    transport: "stdio",
    command: "node",
    args: [],
    env: {},
    status: "CONNECTED",
    enabled: true
  });
  await store.upsertDiscoveredTools(server.id, [
    { name: "echo", description: "", inputSchema: {} },
    { name: "slow", description: "", inputSchema: {} }
  ]);
  await store.updateTool((await store.getToolByName(server.id, "echo"))!.id, { enabled: true });
  await store.updateTool((await store.getToolByName(server.id, "slow"))!.id, { enabled: true });
  return { store, server };
}

describe("MCPRegistryStore binding-row CRUD (in-memory)", () => {
  it("creates project- and agent-scope rows with fail-closed duplicate protection", async () => {
    const { store, server } = await seededStore();

    const projectRow = await store.createBinding({ projectId: "p1", serverId: server.id });
    expect(projectRow.agentName).toBeUndefined();
    expect(projectRow.mcpToolId).toBeUndefined();
    expect(projectRow.enabled).toBe(true);

    const agentRow = await store.createBinding({
      projectId: "p1",
      serverId: server.id,
      agentName: "dev-agent",
      toolName: "echo"
    });
    expect(agentRow.agentName).toBe("dev-agent");
    expect(agentRow.mcpToolId).toBeTruthy();

    // Same scope again → duplicate; different scope/tool → fine.
    await expect(
      store.createBinding({
        projectId: "p1",
        serverId: server.id,
        agentName: "dev-agent",
        toolName: "echo"
      })
    ).rejects.toMatchObject({ code: "DUPLICATE_BINDING" });
    await expect(
      store.createBinding({
        projectId: "p1",
        serverId: server.id,
        agentName: "dev-agent",
        toolName: "slow"
      })
    ).resolves.toBeTruthy();

    await expect(
      store.createBinding({
        projectId: "p1",
        serverId: server.id,
        agentName: "dev-agent",
        toolName: "nope"
      })
    ).rejects.toMatchObject({ code: "UNKNOWN_TOOL" });

    expect(await store.listBindings({ serverId: server.id })).toHaveLength(3);
  });

  it("updates and deletes single binding rows", async () => {
    const { store, server } = await seededStore();
    const row = await store.createBinding({ projectId: "p1", serverId: server.id });

    const disabled = await store.updateBinding(row.id, { enabled: false });
    expect(disabled?.enabled).toBe(false);
    expect(await store.updateBinding("missing", { enabled: true })).toBeNull();

    expect(await store.deleteBinding(row.id)).toBe(true);
    expect(await store.deleteBinding(row.id)).toBe(false);
    expect(await store.listBindings({ serverId: server.id })).toEqual([]);
  });

  it("row grants drive visibility through the registry and revoke immediately", async () => {
    const { store, server } = await seededStore();
    const registry = new PersistentMCPRegistry({ client: new UnusedClient(), store });
    const query = { projectId: "p1", agentName: "dev-agent" };

    expect(await registry.isToolVisible(server.id, "echo", query)).toBe(false);

    await store.createBinding({ projectId: "p1", serverId: server.id });
    expect(await registry.isToolVisible(server.id, "echo", query)).toBe(false); // agent scope missing

    const agentRow = await store.createBinding({
      projectId: "p1",
      serverId: server.id,
      agentName: "dev-agent"
    });
    expect(await registry.isToolVisible(server.id, "echo", query)).toBe(true);

    // Disable the agent row: the already-visible tool flips to DENY.
    await store.updateBinding(agentRow.id, { enabled: false });
    expect(await registry.isToolVisible(server.id, "echo", query)).toBe(false);

    // Re-enable, then revoke outright.
    await store.updateBinding(agentRow.id, { enabled: true });
    expect(await registry.isToolVisible(server.id, "echo", query)).toBe(true);
    await store.deleteBinding(agentRow.id);
    expect(await registry.isToolVisible(server.id, "echo", query)).toBe(false);
  });

  it("exposes typed errors for the API boundary", async () => {
    const error = new MCPRegistryStoreError("UNKNOWN_TOOL", "nope");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("MCPRegistryStoreError");
    expect(error.code).toBe("UNKNOWN_TOOL");
  });
});
