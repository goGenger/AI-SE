import {
  MCPRemoteStateEvent,
  PersistentMCPRegistry,
  RemoteMCPClient,
  startFakeHTTPServer,
  FakeHTTPServerHandle
} from "@ai-se/mcp";
import { ToolRuntime } from "@ai-se/tool-runtime";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";
import { PgMCPRegistryStore } from "./mcpRegistryStore";
import { createTestProject, startPostgresContainer } from "./testPostgresContainer";

/**
 * Phase 5.5-4 persistence E2E: Remote MCP server lifecycle against REAL
 * PostgreSQL (migration 008) + a REAL local Streamable HTTP server:
 * CONNECTED / DEGRADED / recovery states are persisted, discovered tools are
 * never deleted on transient failure, and execution stays on the unified
 * ToolRuntime error path.
 */

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
    toolCallId: randomUUID(),
    actor: "dev-agent",
    workspacePath: "/workspace",
    sandbox: fakeSandbox
  } as never;
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("Remote MCP persistence E2E (PostgreSQL + real Streamable HTTP server)", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let store: PgMCPRegistryStore;
  let projectId: string;
  let server: FakeHTTPServerHandle;
  let registry: PersistentMCPRegistry;
  let serverId: string;

  const stateEvents: MCPRemoteStateEvent[] = [];
  const AGENT = "dev-agent";
  const query = () => ({ projectId, agentName: AGENT });

  beforeAll(async () => {
    const container = await startPostgresContainer();
    pool = container.pool;
    stop = container.stop;
    await runMigrations(pool);
    projectId = await createTestProject(pool, "mcp-remote");

    server = await startFakeHTTPServer({ jsonMode: true });
    store = new PgMCPRegistryStore(pool);
    const client = new RemoteMCPClient({
      reconnect: { maxAttempts: 6, initialDelayMs: 100, factor: 1.3, maxDelayMs: 250 },
      onStateChange: (event) => {
        stateEvents.push(event);
        void registry.applyConnectionState(event);
      }
    });
    registry = new PersistentMCPRegistry({ client, store });

    const created = await registry.createServer({
      name: "remote-http-server",
      transport: "streamable-http",
      endpoint: server.endpoint,
      enabled: true
    });
    serverId = created.id;

    const tools = await registry.connectAndDiscover(serverId);
    for (const tool of tools) {
      await registry.setToolEnabled(tool.id, true);
    }
    await registry.bindProject({ projectId, serverId });
    await registry.bindAgent({ projectId, agentName: AGENT, serverId });
  });

  afterAll(async () => {
    await registry.disconnectServer(serverId).catch(() => undefined);
    await server.stop();
    await stop();
  });

  it("persists a remote server row with endpoint, CONNECTED status and tools", async () => {
    const row = await pool.query<{
      transport: string;
      endpoint: string;
      status: string;
      last_connected_at: Date | null;
    }>(`SELECT transport, endpoint, status, last_connected_at FROM mcp_servers WHERE id = $1`, [
      serverId
    ]);
    expect(row.rows[0].transport).toBe("streamable-http");
    expect(row.rows[0].endpoint).toBe(server.endpoint);
    expect(row.rows[0].status).toBe("CONNECTED");
    expect(row.rows[0].last_connected_at).not.toBeNull();

    const tools = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM mcp_tools WHERE mcp_server_id = $1`,
      [serverId]
    );
    expect(Number(tools.rows[0].count)).toBe(3);
  });

  it("executes a granted remote tool through the ToolRuntime", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(query()) });
    const result = await runtime.execute("echo", { persisted: true }, context());
    expect(result.success).toBe(true);
    expect(result.audit.toolName).toBe("echo");
  });

  it(
    "persists DEGRADED on server loss, keeps tools, and returns unified errors",
    { timeout: 30_000 },
    async () => {
      await server.stop();

      // Stateless HTTP has no standing socket: the failed call is the loss
      // trigger and must flow through the unified ToolRuntime error path.
      const result = await new ToolRuntime({
        tools: await registry.listVisibleToolDefinitions(query())
      }).execute("echo", { degraded: true }, context());
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("TOOL_ERROR");
      expect((result.error?.details as Record<string, unknown>)?.mcpErrorCategory).toBe(
        "CONNECTION"
      );

      await waitFor(
        async () => (await registry.getServer(serverId))?.status !== "CONNECTED",
        "post-loss status in PostgreSQL",
        8000
      );
      expect(stateEvents.some((event) => event.state === "DEGRADED")).toBe(true);

      const row = await pool.query<{ status: string; last_error: string | null }>(
        `SELECT status, last_error FROM mcp_servers WHERE id = $1`,
        [serverId]
      );
      expect(["DEGRADED", "RECONNECTING", "DISCONNECTED"]).toContain(row.rows[0].status);
      expect(row.rows[0].last_error).toBeTruthy();

      // Tools were NOT deleted by the failure.
      const tools = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM mcp_tools WHERE mcp_server_id = $1`,
        [serverId]
      );
      expect(Number(tools.rows[0].count)).toBe(3);
    }
  );

  it(
    "recovers to CONNECTED after the server returns and refreshes discovery",
    { timeout: 30_000 },
    async () => {
      // Let the bounded reconnect cycle finish (exhaustion → DISCONNECTED)
      // before restarting, so the explicit reconnect is deterministic.
      await waitFor(
        async () => (await registry.getServer(serverId))?.status === "DISCONNECTED",
        "reconnect exhaustion",
        8000
      );

      const restarted = await startFakeHTTPServer({ jsonMode: true, port: server.port });
      try {
        await registry.connectServer(serverId);
        await waitFor(
          async () => (await registry.getServer(serverId))?.status === "CONNECTED",
          "recovered CONNECTED",
          6000
        );

        const refreshed = await registry.refreshTools(serverId);
        expect(refreshed.length).toBe(3);

        const result = await new ToolRuntime({
          tools: await registry.listVisibleToolDefinitions(query())
        }).execute("echo", { recovered: true }, context());
        expect(result.success).toBe(true);
      } finally {
        await restarted.stop();
      }
    }
  );

  it("redacts credentials when persisting an authentication failure", async () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.persist-secret-check.c2ln";
    const authServer = await startFakeHTTPServer({ jsonMode: true, auth: token });
    try {
      const client = new RemoteMCPClient({
        credentialResolver: () => "wrong-token-forced-failure",
        onStateChange: (event) => {
          void registry.applyConnectionState(event);
        }
      });
      const authRegistry = new PersistentMCPRegistry({ client, store });
      const created = await authRegistry.createServer({
        name: "auth-required-server",
        transport: "streamable-http",
        endpoint: authServer.endpoint,
        enabled: true,
        credentialRef: "secret:mcp/remote-auth"
      });

      await expect(authRegistry.connectServer(created.id)).rejects.toThrow();

      // The DEGRADED write and the async onStateChange → applyConnectionState
      // write are not ordered against each other; under parallel load the
      // read can land on a transient (CONNECTING/RECONNECTING) row. Wait for
      // the row to leave CONNECTING, then assert the settled state.
      let row = {
        status: "CONNECTING",
        last_error: null as string | null
      };
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const current = await pool.query<{ status: string; last_error: string | null }>(
          `SELECT status, last_error FROM mcp_servers WHERE id = $1`,
          [created.id]
        );
        row = current.rows[0];
        if (row.status !== "CONNECTING") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(row.status).not.toBe("CONNECTING");
      expect(row.last_error ?? "").not.toContain("wrong-token-forced-failure");
      expect(row.last_error ?? "").not.toContain(token);

      // No credential material anywhere in the mcp_* tables.
      const leaked = await pool.query<{ count: string }>(
        `
          SELECT (
            (SELECT COUNT(*) FROM mcp_servers WHERE name LIKE '%wrong-token%' OR endpoint LIKE '%wrong-token%')
            + (SELECT COUNT(*) FROM mcp_tools WHERE description LIKE '%wrong-token%')
          ) AS count
        `
      );
      expect(Number(leaked.rows[0].count)).toBe(0);

      await authRegistry.deleteServer(created.id);
    } finally {
      await authServer.stop();
    }
  });

  it("still serves native tools alongside the federated remote tools", async () => {
    const { createPhase1Tools } = await import("@ai-se/tool-runtime");
    const runtime = new ToolRuntime({
      tools: [...createPhase1Tools(), ...(await registry.listVisibleToolDefinitions(query()))]
    });
    expect((await runtime.execute("git_status", {}, context())).success).toBe(true);
  });
});
