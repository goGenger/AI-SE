import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";
import { PgMCPRegistryStore } from "./mcpRegistryStore";
import { createTestProject, startPostgresContainer } from "./testPostgresContainer";

describe("PgMCPRegistryStore (migration 008)", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let store: PgMCPRegistryStore;
  let projectId: string;

  beforeAll(async () => {
    const container = await startPostgresContainer();
    pool = container.pool;
    stop = container.stop;
    await runMigrations(pool);
    projectId = await createTestProject(pool, "mcp-store");
    store = new PgMCPRegistryStore(pool);
  });

  afterAll(async () => {
    await stop();
  });

  it("runs migration 008 idempotently", async () => {
    expect(await runMigrations(pool)).toEqual([]);
  });

  it("creates, reads, lists, updates and deletes servers with full stdio config", async () => {
    const created = await store.createServer({
      id: randomUUID(),
      name: `fake-${randomUUID().slice(0, 8)}`,
      description: "stdio server",
      transport: "stdio",
      command: process.execPath,
      args: ["-v"],
      env: { AI_SE_TEST: "1" },
      cwd: "/tmp",
      status: "REGISTERED",
      enabled: false,
      credentialRef: "secret:mcp/test"
    });

    expect(created.enabled).toBe(false); // fail-closed default
    expect(created.args).toEqual(["-v"]);
    expect(created.env).toEqual({ AI_SE_TEST: "1" });
    expect(created.cwd).toBe("/tmp");

    const fetched = await store.getServer(created.id);
    expect(fetched?.name).toBe(created.name);
    expect((await store.listServers()).some((server) => server.id === created.id)).toBe(true);

    // Duplicate names are rejected by the unique index.
    await expect(
      store.createServer({
        id: randomUUID(),
        name: created.name,
        description: "",
        transport: "stdio",
        command: "node",
        args: [],
        env: {},
        status: "REGISTERED",
        enabled: false
      })
    ).rejects.toThrow();

    // Patch semantics: values update; null clears; lastError roundtrips.
    const degraded = await store.updateServer(created.id, {
      status: "DEGRADED",
      lastError: "spawn failed"
    });
    expect(degraded?.status).toBe("DEGRADED");
    expect(degraded?.lastError).toBe("spawn failed");

    const connected = await store.updateServer(created.id, {
      status: "CONNECTED",
      lastError: null,
      enabled: true,
      lastConnectedAt: "2026-09-10T00:00:00.000Z"
    });
    expect(connected?.lastError).toBeUndefined();
    expect(connected?.enabled).toBe(true);
    expect(connected?.lastConnectedAt).toBe("2026-09-10T00:00:00.000Z");

    expect(await store.deleteServer(created.id)).toBe(true);
    expect(await store.getServer(created.id)).toBeNull();
    expect(await store.deleteServer(created.id)).toBe(false);
  });

  it("persists discovery fail-closed and preserves operator state across re-discovery", async () => {
    const server = await store.createServer({
      id: randomUUID(),
      name: `discovery-${randomUUID().slice(0, 8)}`,
      description: "",
      transport: "stdio",
      command: "node",
      args: [],
      env: {},
      status: "REGISTERED",
      enabled: false
    });

    const discovered = await store.upsertDiscoveredTools(server.id, [
      { name: "echo", description: "Returns input", inputSchema: { type: "object" } },
      { name: "slow", description: "Waits", inputSchema: { type: "object" } }
    ]);
    expect(discovered.every((tool) => tool.enabled === false)).toBe(true);
    expect(discovered.every((tool) => tool.riskLevel === "MEDIUM")).toBe(true);
    expect(discovered.every((tool) => tool.requiresApproval === false)).toBe(true);

    // Operator enables echo and raises its risk.
    const echo = await store.getToolByName(server.id, "echo");
    await store.updateTool(echo!.id, { enabled: true, riskLevel: "HIGH" });

    // Re-discovery updates metadata but must NOT reset enabled / risk / approval.
    await store.upsertDiscoveredTools(server.id, [
      {
        name: "echo",
        description: "Returns input (v2)",
        inputSchema: { type: "object", properties: {} }
      },
      { name: "slow", description: "Waits", inputSchema: { type: "object" } },
      { name: "failing", description: "Fails", inputSchema: { type: "object" } }
    ]);

    const echoAfter = await store.getToolByName(server.id, "echo");
    expect(echoAfter?.description).toBe("Returns input (v2)");
    expect(echoAfter?.enabled).toBe(true);
    expect(echoAfter?.riskLevel).toBe("HIGH");

    const failing = await store.getToolByName(server.id, "failing");
    expect(failing?.enabled).toBe(false); // new tools stay disabled

    expect((await store.listTools(server.id)).length).toBe(3);
    expect(await store.getToolByName(server.id, "missing")).toBeNull();

    await store.deleteServer(server.id);
  });

  it("enforces binding scopes, uniqueness and cascade cleanup", async () => {
    const server = await store.createServer({
      id: randomUUID(),
      name: `bindings-${randomUUID().slice(0, 8)}`,
      description: "",
      transport: "stdio",
      command: "node",
      args: [],
      env: {},
      status: "REGISTERED",
      enabled: false
    });
    await store.upsertDiscoveredTools(server.id, [
      { name: "echo", description: "", inputSchema: {} },
      { name: "slow", description: "", inputSchema: {} }
    ]);
    const echo = (await store.getToolByName(server.id, "echo"))!;

    // Project-scope grant (all tools).
    await store.replaceProjectBinding({ projectId, serverId: server.id });
    // Agent-scope grant (echo only).
    await store.replaceAgentBinding({
      projectId,
      serverId: server.id,
      agentName: "dev-agent",
      toolNames: ["echo"]
    });

    let bindings = await store.listBindings({ projectId, serverId: server.id });
    expect(bindings.length).toBe(2);
    const projectBinding = bindings.find((binding) => binding.agentName === undefined);
    const agentBinding = bindings.find((binding) => binding.agentName === "dev-agent");
    expect(projectBinding?.mcpToolId).toBeUndefined();
    expect(agentBinding?.mcpToolId).toBe(echo.id);
    expect(bindings.every((binding) => binding.enabled === true)).toBe(true);

    // Replacing a scope is idempotent (no duplicate rows).
    await store.replaceAgentBinding({
      projectId,
      serverId: server.id,
      agentName: "dev-agent",
      toolNames: ["echo", "slow"]
    });
    bindings = await store.listBindings({ projectId, serverId: server.id });
    expect(bindings.filter((binding) => binding.agentName === "dev-agent").length).toBe(2);

    // Dormant grants are possible.
    await store.replaceAgentBinding({
      projectId,
      serverId: server.id,
      agentName: "qa-agent",
      enabled: false
    });
    const dormant = (await store.listBindings({ projectId, serverId: server.id })).find(
      (binding) => binding.agentName === "qa-agent"
    );
    expect(dormant?.enabled).toBe(false);

    // Removal.
    await store.removeAgentBinding(projectId, "qa-agent", server.id);
    expect(
      (await store.listBindings({ projectId, serverId: server.id })).some(
        (binding) => binding.agentName === "qa-agent"
      )
    ).toBe(false);
    await store.removeProjectBinding(projectId, server.id);
    expect(
      (await store.listBindings({ projectId, serverId: server.id })).some(
        (binding) => binding.agentName === undefined
      )
    ).toBe(false);

    // Re-create grants, then verify cascade cleanup on server deletion.
    await store.replaceProjectBinding({ projectId, serverId: server.id });
    await store.replaceAgentBinding({ projectId, serverId: server.id, agentName: "dev-agent" });
    expect(await store.deleteServer(server.id)).toBe(true);
    expect(await store.listTools(server.id)).toEqual([]);
    expect(await store.listBindings({ serverId: server.id })).toEqual([]);
  });

  it("rejects bindings to unknown tools and unknown projects", async () => {
    const server = await store.createServer({
      id: randomUUID(),
      name: `invalid-${randomUUID().slice(0, 8)}`,
      description: "",
      transport: "stdio",
      command: "node",
      args: [],
      env: {},
      status: "REGISTERED",
      enabled: false
    });
    await store.upsertDiscoveredTools(server.id, [
      { name: "echo", description: "", inputSchema: {} }
    ]);

    await expect(
      store.replaceAgentBinding({
        projectId,
        serverId: server.id,
        agentName: "dev-agent",
        toolNames: ["does-not-exist"]
      })
    ).rejects.toThrow(/Unknown MCP tool/);

    await expect(
      store.replaceProjectBinding({ projectId: randomUUID(), serverId: server.id })
    ).rejects.toThrow();

    await store.deleteServer(server.id);
  });

  it("supports binding-row CRUD with typed errors (console)", async () => {
    const server = await store.createServer({
      id: randomUUID(),
      name: `row-crud-${randomUUID().slice(0, 8)}`,
      description: "",
      transport: "stdio",
      command: "node",
      args: [],
      env: {},
      status: "REGISTERED",
      enabled: false
    });
    await store.upsertDiscoveredTools(server.id, [
      { name: "echo", description: "", inputSchema: {} }
    ]);
    const tool = (await store.getToolByName(server.id, "echo"))!;

    const projectRow = await store.createBinding({ projectId, serverId: server.id });
    expect(projectRow.agentName).toBeUndefined();
    expect(projectRow.mcpToolId).toBeUndefined();
    expect(projectRow.enabled).toBe(true);

    const agentRow = await store.createBinding({
      projectId,
      serverId: server.id,
      agentName: "qa-agent",
      toolName: "echo"
    });
    expect(agentRow.mcpToolId).toBe(tool.id);

    await expect(
      store.createBinding({
        projectId,
        serverId: server.id,
        agentName: "qa-agent",
        toolName: "echo"
      })
    ).rejects.toMatchObject({ code: "DUPLICATE_BINDING" });
    await expect(
      store.createBinding({ projectId, serverId: server.id, toolName: "missing" })
    ).rejects.toMatchObject({ code: "UNKNOWN_TOOL" });
    await expect(
      store.createBinding({ projectId: randomUUID(), serverId: server.id })
    ).rejects.toMatchObject({ code: "UNKNOWN_PROJECT" });
    await expect(store.createBinding({ projectId, serverId: randomUUID() })).rejects.toMatchObject({
      code: "UNKNOWN_SERVER"
    });

    const dormant = await store.createBinding({
      projectId,
      serverId: server.id,
      agentName: "dormant-agent",
      enabled: false
    });
    expect(dormant.enabled).toBe(false);

    const disabled = await store.updateBinding(agentRow.id, { enabled: false });
    expect(disabled?.enabled).toBe(false);
    expect(await store.updateBinding(randomUUID(), { enabled: true })).toBeNull();
    expect(await store.deleteBinding(dormant.id)).toBe(true);
    expect(await store.deleteBinding(dormant.id)).toBe(false);

    await store.deleteServer(server.id);
    expect(await store.listBindings({ serverId: server.id })).toEqual([]);
  });
});
