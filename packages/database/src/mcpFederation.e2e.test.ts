import {
  createFakeMCPServerDefinition,
  MCPClientPort,
  MCPServerDefinition,
  MCPToolDefinition,
  PersistentMCPRegistry,
  StdioMCPClient
} from "@ai-se/mcp";
import { ToolRuntime, createPhase1Tools } from "@ai-se/tool-runtime";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";
import { PgMCPRegistryStore } from "./mcpRegistryStore";
import { createTestProject, startPostgresContainer } from "./testPostgresContainer";

/**
 * Phase 5.5-3 E2E: PersistentMCPRegistry on REAL PostgreSQL (migration 008)
 * with the REAL stdio MCP server, the REAL ToolRuntime boundary, and
 * zero-request assertions for every fail-closed path. Several denials are
 * applied as DIRECT SQL changes (as if made by another process) to prove the
 * call-time re-check never serves stale authorization.
 */

class CountingMCPClient implements MCPClientPort {
  private readonly counts = new Map<string, number>();

  constructor(private readonly delegate: StdioMCPClient) {}

  requestCount(toolName: string): number {
    return this.counts.get(toolName) ?? 0;
  }

  async connect(server: MCPServerDefinition): Promise<void> {
    return await this.delegate.connect(server);
  }

  async disconnect(serverId: string): Promise<void> {
    return await this.delegate.disconnect(serverId);
  }

  async listTools(serverId: string): Promise<MCPToolDefinition[]> {
    return await this.delegate.listTools(serverId);
  }

  async callTool(
    serverId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    this.counts.set(name, this.requestCount(name) + 1);
    return await this.delegate.callTool(serverId, name, input, signal);
  }

  async listResources(serverId: string) {
    return await this.delegate.listResources(serverId);
  }

  async readResource(serverId: string, uri: string, signal?: AbortSignal) {
    return await this.delegate.readResource(serverId, uri, signal);
  }

  async listPrompts(serverId: string) {
    return await this.delegate.listPrompts(serverId);
  }

  async getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal
  ) {
    return await this.delegate.getPrompt(serverId, name, args, signal);
  }

  pidOf(serverId: string): number | null {
    return this.delegate.pidOf(serverId);
  }
}

const fakeSandbox = {
  async runCommand() {
    return { command: "", exitCode: 0, stdout: "", stderr: "", duration: 0, timedOut: false };
  }
};

function context() {
  return {
    requestId: "req-1",
    projectId: "any",
    taskId: "task-1",
    agentRunId: "run-1",
    toolCallId: "call-1",
    actor: "dev-agent",
    workspacePath: "/workspace",
    sandbox: fakeSandbox
  } as never;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process ${pid} still alive after ${timeoutMs}ms`);
}

const AGENT = "dev-agent";

describe("MCP federation persistence E2E (PostgreSQL + real stdio server)", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let store: PgMCPRegistryStore;
  let projectId: string;
  let client: CountingMCPClient;
  let stdio: StdioMCPClient;
  let registry: PersistentMCPRegistry;
  let serverId: string;
  let echoToolId: string;
  let policyDenied = false;

  const query = () => ({ projectId, agentName: AGENT });

  beforeAll(async () => {
    const container = await startPostgresContainer();
    pool = container.pool;
    stop = container.stop;
    await runMigrations(pool);
    projectId = await createTestProject(pool, "mcp-federation");

    store = new PgMCPRegistryStore(pool);
    stdio = new StdioMCPClient();
    client = new CountingMCPClient(stdio);
    registry = new PersistentMCPRegistry({
      client,
      store,
      policyProvider: (_server, tool) =>
        policyDenied
          ? undefined
          : tool.name === "failing"
            ? { riskLevel: "HIGH", requiresApproval: false }
            : { riskLevel: "MEDIUM", requiresApproval: false }
    });

    const fake = createFakeMCPServerDefinition();
    const server = await registry.createServer({
      name: fake.name,
      stdio: { command: fake.stdio!.command, args: fake.stdio!.args },
      enabled: true
    });
    serverId = server.id;

    const tools = await registry.connectAndDiscover(serverId);
    echoToolId = tools.find((tool) => tool.name === "echo")!.id;
    for (const tool of tools) {
      await registry.setToolEnabled(tool.id, true);
    }
    await registry.bindProject({ projectId, serverId });
    await registry.bindAgent({ projectId, agentName: AGENT, serverId });
  });

  afterAll(async () => {
    await registry.disconnectServer(serverId).catch(() => undefined);
    await stop();
  });

  it("persists server, discovered tools and grants as real database rows", async () => {
    const tools = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM mcp_tools WHERE mcp_server_id = $1`,
      [serverId]
    );
    expect(Number(tools.rows[0].count)).toBe(3);

    const bindings = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM mcp_tool_bindings WHERE mcp_server_id = $1`,
      [serverId]
    );
    expect(Number(bindings.rows[0].count)).toBe(2);

    const server = await pool.query<{ status: string; enabled: boolean }>(
      `SELECT status, enabled FROM mcp_servers WHERE id = $1`,
      [serverId]
    );
    expect(server.rows[0].status).toBe("CONNECTED");
    expect(server.rows[0].enabled).toBe(true);
    expect(client.requestCount("echo")).toBe(0);
  });

  it("executes a granted tool through the existing ToolRuntime", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(query()) });
    const result = await runtime.execute("echo", { via: "pg" }, context());

    expect(result.success).toBe(true);
    expect(result.audit.toolName).toBe("echo");
    expect(client.requestCount("echo")).toBe(1);
  });

  it("denies stale ToolDefinitions when the server is disabled directly in the database", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(query()) });

    await pool.query(`UPDATE mcp_servers SET enabled = FALSE WHERE id = $1`, [serverId]);

    const result = await runtime.execute("echo", { via: "pg" }, context());
    expect(result.success).toBe(false);
    expect((result.error?.details as Record<string, unknown>)?.mcpErrorCategory).toBe(
      "PERMISSION_DENIED"
    );
    expect(client.requestCount("echo")).toBe(1); // zero new requests
    expect(await registry.listVisibleToolDefinitions(query())).toEqual([]);

    await pool.query(`UPDATE mcp_servers SET enabled = TRUE WHERE id = $1`, [serverId]);
    expect((await registry.listVisibleToolDefinitions(query())).length).toBe(3);
  });

  it("denies stale ToolDefinitions when the tool is disabled directly in the database", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(query()) });

    await pool.query(`UPDATE mcp_tools SET enabled = FALSE WHERE id = $1`, [echoToolId]);

    const result = await runtime.execute("echo", { via: "pg" }, context());
    expect(result.success).toBe(false);
    expect(client.requestCount("echo")).toBe(1);

    await pool.query(`UPDATE mcp_tools SET enabled = TRUE WHERE id = $1`, [echoToolId]);
  });

  it("denies when the project binding is removed", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(query()) });
    await registry.unbindProject(projectId, serverId);

    const result = await runtime.execute("echo", { via: "pg" }, context());
    expect(result.success).toBe(false);
    expect(client.requestCount("echo")).toBe(1);

    await registry.bindProject({ projectId, serverId });
    expect(await registry.isToolVisible(serverId, "echo", query())).toBe(true);
  });

  it("denies stale ToolDefinitions when the agent binding is removed directly in the database", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(query()) });

    await pool.query(
      `DELETE FROM mcp_tool_bindings WHERE project_id = $1 AND mcp_server_id = $2 AND agent_name = $3`,
      [projectId, serverId, AGENT]
    );

    const result = await runtime.execute("echo", { via: "pg" }, context());
    expect(result.success).toBe(false);
    expect(client.requestCount("echo")).toBe(1);

    await registry.bindAgent({ projectId, agentName: AGENT, serverId });
  });

  it("denies when the platform policy rejects the tool", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(query()) });
    policyDenied = true;

    expect(await registry.isToolVisible(serverId, "echo", query())).toBe(false);
    const result = await runtime.execute("echo", { via: "pg" }, context());
    expect(result.success).toBe(false);
    expect(client.requestCount("echo")).toBe(1);

    policyDenied = false;
  });

  it("recovers after a restart without re-discovery and keeps revocations revoked", async () => {
    // Revoke BEFORE the restart: the denial must survive it.
    await registry.unbindAgent(projectId, AGENT, serverId);

    const originalPid = client.pidOf(serverId)!;
    await registry.disconnectServer(serverId);
    await waitForProcessExit(originalPid, 3000);

    const restartedStdio = new StdioMCPClient();
    const restartedClient = new CountingMCPClient(restartedStdio);
    const restarted = new PersistentMCPRegistry({ client: restartedClient, store });

    const outcome = await restarted.initialize();
    expect(outcome.connected).toEqual([serverId]);
    expect(outcome.failed).toEqual([]);

    // Tools came from PostgreSQL, not from a new discovery pass.
    expect((await restarted.listTools(serverId)).length).toBe(3);
    // Revocation persisted across the restart.
    expect(await restarted.isToolVisible(serverId, "echo", query())).toBe(false);

    await restarted.bindAgent({ projectId, agentName: AGENT, serverId });
    const defs = await restarted.listVisibleToolDefinitions(query());
    expect(defs.map((definition) => definition.name).sort()).toEqual(["echo", "failing", "slow"]);

    const runtime = new ToolRuntime({ tools: defs });
    const granted = await runtime.execute("echo", { after: "restart" }, context());
    expect(granted.success).toBe(true);
    expect(restartedClient.requestCount("echo")).toBe(1);

    // Revoke again AFTER the restart: the already-built definitions must deny.
    await restarted.unbindAgent(projectId, AGENT, serverId);
    const revoked = await runtime.execute("echo", { after: "restart" }, context());
    expect(revoked.success).toBe(false);
    expect(restartedClient.requestCount("echo")).toBe(1);

    await restarted.bindAgent({ projectId, agentName: AGENT, serverId });

    const restartedPid = restartedClient.pidOf(serverId)!;
    await restarted.disconnectServer(serverId);
    await waitForProcessExit(restartedPid, 3000);
  });

  it("keeps native tools unaffected alongside federated MCP tools", async () => {
    await registry.connectServer(serverId);
    const runtime = new ToolRuntime({
      tools: [...createPhase1Tools(), ...(await registry.listVisibleToolDefinitions(query()))]
    });

    const names = runtime.getToolDefinitions().map((definition) => definition.name);
    expect(names).toContain("read_file");
    expect(names).toContain("git_status");
    expect(names).toContain("echo");

    const git = await runtime.execute("git_status", {}, context());
    expect(git.success).toBe(true);
    const echo = await runtime.execute("echo", { native: "regression" }, context());
    expect(echo.success).toBe(true);
  });
});
