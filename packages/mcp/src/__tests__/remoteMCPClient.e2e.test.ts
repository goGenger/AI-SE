import http from "node:http";
import net from "node:net";
import {
  ToolCallFinishedRecord,
  ToolCallRecorder,
  ToolCallStartedRecord,
  ToolRuntime,
  createPhase1Tools
} from "@ai-se/tool-runtime";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCPClientError } from "../client/MCPClientError";
import { MCPRemoteStateEvent, RemoteMCPClient } from "../client/RemoteMCPClient";
import { mapMCPErrorToRuntimeError } from "../errors";
import { redactCredentialShapedText } from "../security/credentials";
import { InMemoryMCPRegistryStore } from "../registry/inMemoryStore";
import { PersistentMCPRegistry } from "../registry/persistentRegistry";
import { FakeHTTPServerHandle, startFakeHTTPServer } from "../testing/fakeHTTPServer";

/**
 * Phase 5.5-4 E2E: RemoteMCPClient against REAL local Streamable HTTP MCP
 * servers (official SDK transport, real child processes), covering JSON and
 * SSE response modes, lifecycle/reconnect, auth references, secret isolation,
 * and the full ToolRuntime integration with zero-request DENY assertions.
 */

const fakeSandbox = {
  async runCommand() {
    return { command: "", exitCode: 0, stdout: "", stderr: "", duration: 0, timedOut: false };
  }
};

function context(recorder?: ToolCallRecorder, extra: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    projectId: "proj-1",
    taskId: "task-1",
    agentRunId: "run-1",
    toolCallId: randomUUID(),
    actor: "dev-agent",
    workspacePath: "/workspace",
    sandbox: fakeSandbox,
    ...(recorder ? { toolCallRecorder: recorder } : {}),
    ...extra
  } as never;
}

class MemoryToolCallRecorder implements ToolCallRecorder {
  readonly started: ToolCallStartedRecord[] = [];
  readonly finished: ToolCallFinishedRecord[] = [];

  async recordToolCallStarted(record: ToolCallStartedRecord): Promise<void> {
    this.started.push(record);
  }

  async recordToolCallFinished(record: ToolCallFinishedRecord): Promise<void> {
    this.finished.push(record);
  }
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

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function remoteDefinition(endpoint: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `remote-${randomUUID().slice(0, 8)}`,
    name: `remote-test-${randomUUID().slice(0, 8)}`,
    transport: "streamable-http" as const,
    endpoint,
    enabled: true,
    ...overrides
  };
}

describe("RemoteMCPClient — Streamable HTTP (JSON responses)", () => {
  let server: FakeHTTPServerHandle;
  const client = new RemoteMCPClient();

  beforeAll(async () => {
    server = await startFakeHTTPServer({ jsonMode: true });
  });

  afterAll(async () => {
    await client.disconnect("remote-json").catch(() => undefined);
    await server.stop();
  });

  it("connects, negotiates initialize and lists tools", async () => {
    await client.connect(remoteDefinition(server.endpoint, { id: "remote-json" }));
    expect(client.getConnectionState("remote-json")).toBe("CONNECTED");

    const tools = await client.listTools("remote-json");
    expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "failing", "slow"]);
    expect(tools.every((tool) => typeof tool.inputSchema === "object")).toBe(true);
  });

  it("round-trips arbitrary JSON through echo (JSON response mode)", async () => {
    const result = (await client.callTool("remote-json", "echo", {
      hello: "remote",
      nested: { a: [1, 2, 3] }
    })) as { content: Array<{ type: string; text?: string }> };
    expect(JSON.parse(result.content[0].text!)).toEqual({
      hello: "remote",
      nested: { a: [1, 2, 3] }
    });
  });

  it("classifies a remote tool failure", async () => {
    const error = await client
      .callTool("remote-json", "failing", {})
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MCPClientError);
    expect((error as MCPClientError).mcpErrorCategory).toBe("REMOTE_TOOL");
  });

  it("disconnects cleanly and rejects further calls", async () => {
    await client.disconnect("remote-json");
    expect(client.getConnectionState("remote-json")).toBe("DISCONNECTED");
    await expect(client.callTool("remote-json", "echo", {})).rejects.toThrow(/Not connected/);
  });
});

describe("RemoteMCPClient — Streamable HTTP (SSE responses)", () => {
  let server: FakeHTTPServerHandle;
  const client = new RemoteMCPClient();

  beforeAll(async () => {
    server = await startFakeHTTPServer({ jsonMode: false });
  });

  afterAll(async () => {
    await client.disconnect("remote-sse").catch(() => undefined);
    await server.stop();
  });

  it("calls tools over request-scoped SSE responses", async () => {
    await client.connect(remoteDefinition(server.endpoint, { id: "remote-sse" }));
    const tools = await client.listTools("remote-sse");
    expect(tools.length).toBe(3);

    const result = (await client.callTool("remote-sse", "echo", { via: "sse" })) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(JSON.parse(result.content[0].text!)).toEqual({ via: "sse" });

    // The fixture really served SSE responses (not JSON), and requests hit it.
    expect((await server.hits()).jsonMode).toBe(false);
    expect((await server.hits()).hits).toBeGreaterThan(0);
  });
});

describe("RemoteMCPClient — failure paths and reconnect", () => {
  it("fails closed when the server is unavailable", async () => {
    const port = await closedPort();
    const client = new RemoteMCPClient();
    const error = await client
      .connect(remoteDefinition(`http://127.0.0.1:${port}/mcp`))
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MCPClientError);
    expect((error as MCPClientError).mcpErrorCategory).toBe("CONNECTION");
    const mapped = mapMCPErrorToRuntimeError((error as MCPClientError).mcpErrorCategory, error);
    expect(mapped.code).toBe("TOOL_ERROR");
  });

  it("fails closed on malformed MCP responses", async () => {
    const bad = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("definitely-not-json{");
    });
    await new Promise<void>((resolve) => bad.listen(0, "127.0.0.1", () => resolve()));
    const port = (bad.address() as net.AddressInfo).port;

    const client = new RemoteMCPClient();
    const error = await client
      .connect(remoteDefinition(`http://127.0.0.1:${port}/mcp`))
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MCPClientError);
    const category = (error as MCPClientError).mcpErrorCategory;
    expect(["CONNECTION", "INTERNAL"]).toContain(category);
    expect(mapMCPErrorToRuntimeError(category, error).code).toBe("TOOL_ERROR");

    await new Promise<void>((resolve) => bad.close(() => resolve()));
  });

  it("fails closed on a 404 endpoint", async () => {
    const server = await startFakeHTTPServer({ jsonMode: true });
    try {
      const client = new RemoteMCPClient();
      const error = await client
        .connect(remoteDefinition(`http://127.0.0.1:${server.port}/nope`))
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MCPClientError);
      expect((error as MCPClientError).mcpErrorCategory).toBe("CONNECTION");
    } finally {
      await server.stop();
    }
  });

  it("fails closed on a connection timeout (server accepts but never responds)", async () => {
    const silent = net.createServer(() => {
      // Accept and never respond.
    });
    const sockets = new Set<net.Socket>();
    silent.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
    const port = (silent.address() as net.AddressInfo).port;

    const client = new RemoteMCPClient({ connectionTimeoutMs: 400 });
    const started = Date.now();
    const error = await client
      .connect(remoteDefinition(`http://127.0.0.1:${port}/mcp`))
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    // Destroy lingering sockets so close() is prompt (the aborted fetch may
    // leave a half-open connection on the accept side).
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
    expect(error).toBeInstanceOf(MCPClientError);
    expect((error as MCPClientError).mcpErrorCategory).toBe("TIMEOUT");
    expect(mapMCPErrorToRuntimeError("TIMEOUT", error).code).toBe("TIMEOUT_ERROR");
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);

  it("goes DEGRADED, runs a bounded reconnect, and ends DISCONNECTED on exhaustion", async () => {
    const server = await startFakeHTTPServer({ jsonMode: true });
    const events: MCPRemoteStateEvent[] = [];
    const client = new RemoteMCPClient({
      reconnect: { maxAttempts: 3, initialDelayMs: 60, factor: 2, maxDelayMs: 200 },
      onStateChange: (event) => events.push(event)
    });

    await client.connect(remoteDefinition(server.endpoint, { id: "remote-exhaust" }));
    await server.stop();

    // A failed call detects the loss: DEGRADED + bounded reconnect.
    const callError = await client.callTool("remote-exhaust", "echo", {}).catch((e: unknown) => e);
    expect((callError as MCPClientError).mcpErrorCategory).toBe("CONNECTION");
    expect(events.some((event) => event.state === "DEGRADED")).toBe(true);

    await waitFor(
      () => client.getConnectionState("remote-exhaust") === "DISCONNECTED",
      "reconnect exhaustion",
      8000
    );

    const attempts = events.filter((event) => event.state === "RECONNECTING").map((e) => e.attempt);
    expect(attempts).toEqual([1, 2, 3]); // bounded: exactly maxAttempts, no storm
    const degradedAt = events.findIndex((event) => event.state === "DEGRADED");
    expect(degradedAt).toBeGreaterThanOrEqual(0);
    expect(events.slice(degradedAt).some((event) => event.state === "CONNECTED")).toBe(false);
  });

  it("reconnects and recovers when the server returns on the same port", async () => {
    const server = await startFakeHTTPServer({ jsonMode: true });
    const port = server.port;
    const events: MCPRemoteStateEvent[] = [];
    const client = new RemoteMCPClient({
      reconnect: { maxAttempts: 40, initialDelayMs: 100, factor: 1.3, maxDelayMs: 300 },
      onStateChange: (event) => events.push(event)
    });

    await client.connect(remoteDefinition(server.endpoint, { id: "remote-recover" }));
    await server.stop();

    // Kick the detection, then bring the server back on the same port.
    await client.callTool("remote-recover", "echo", {}).catch(() => undefined);
    const restarted = await startFakeHTTPServer({ jsonMode: true, port });

    try {
      await waitFor(
        () => client.getConnectionState("remote-recover") === "CONNECTED",
        "reconnect recovery",
        10_000
      );
      expect(events.some((event) => event.state === "DEGRADED")).toBe(true);
      expect(events.some((event) => event.state === "RECONNECTING")).toBe(true);

      // The re-established connection is fully functional.
      const result = (await client.callTool("remote-recover", "echo", { recovered: true })) as {
        content: Array<{ type: string; text?: string }>;
      };
      expect(JSON.parse(result.content[0].text!)).toEqual({ recovered: true });
    } finally {
      await client.disconnect("remote-recover").catch(() => undefined);
      await restarted.stop();
    }
  });

  it("de-duplicates concurrent reconnect requests (single flight)", async () => {
    const server = await startFakeHTTPServer({ jsonMode: true });
    const events: MCPRemoteStateEvent[] = [];
    const client = new RemoteMCPClient({
      reconnect: { maxAttempts: 4, initialDelayMs: 60, factor: 2, maxDelayMs: 200 },
      onStateChange: (event) => events.push(event)
    });

    await client.connect(remoteDefinition(server.endpoint, { id: "remote-once" }));
    await server.stop();
    await client.callTool("remote-once", "echo", {}).catch(() => undefined);

    // Concurrent reconnect calls share ONE cycle.
    const first = client.reconnect("remote-once");
    const second = client.reconnect("remote-once");
    await Promise.allSettled([first, second]);
    await waitFor(
      () => client.getConnectionState("remote-once") === "DISCONNECTED",
      "single-flight exhaustion",
      8000
    );

    const attempts = events.filter((event) => event.state === "RECONNECTING").length;
    expect(attempts).toBe(4); // one cycle of maxAttempts, not two
  });

  it("cancels an in-flight reconnect cycle", async () => {
    const server = await startFakeHTTPServer({ jsonMode: true });
    const client = new RemoteMCPClient({
      reconnect: { maxAttempts: 50, initialDelayMs: 150, factor: 1, maxDelayMs: 150 }
    });

    await client.connect(remoteDefinition(server.endpoint, { id: "remote-cancel" }));
    await server.stop();
    await client.callTool("remote-cancel", "echo", {}).catch(() => undefined);
    await waitFor(
      () => client.getConnectionState("remote-cancel") === "RECONNECTING",
      "reconnecting state",
      4000
    );

    client.cancelReconnect("remote-cancel");
    await waitFor(
      () => client.getConnectionState("remote-cancel") === "DISCONNECTED",
      "cancelled reconnect",
      4000
    );
  });
});

describe("RemoteMCPClient — credentialRef / authRef and secret isolation", () => {
  const TOKEN = "eyJhbGciOiJIUzI1NiJ9.ai-se-remote-secret.c2lnbmF0dXJl";
  let server: FakeHTTPServerHandle;

  beforeAll(async () => {
    server = await startFakeHTTPServer({ jsonMode: true, auth: TOKEN });
  });

  afterAll(async () => {
    await server.stop();
  });

  it("fails closed without a resolver and names only the reference", async () => {
    const client = new RemoteMCPClient();
    const error = await client
      .connect(remoteDefinition(server.endpoint, { credentialRef: "secret:mcp/remote-auth" }))
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MCPClientError);
    expect((error as MCPClientError).mcpErrorCategory).toBe("CONNECTION");
    expect((error as MCPClientError).message).toContain("secret:mcp/remote-auth");
    expect((error as MCPClientError).message).not.toContain(TOKEN);
  });

  it("fails closed when the resolver returns nothing", async () => {
    const client = new RemoteMCPClient({ credentialResolver: () => undefined });
    const error = await client
      .connect(remoteDefinition(server.endpoint, { credentialRef: "secret:mcp/remote-auth" }))
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect((error as MCPClientError).mcpErrorCategory).toBe("CONNECTION");
    expect((error as MCPClientError).message).toContain("no value");
  });

  it("never leaks resolver internals when resolution fails", async () => {
    const client = new RemoteMCPClient({
      credentialResolver: () => {
        throw new Error(`resolver exploded with ${TOKEN}`);
      }
    });
    const error = await client
      .connect(remoteDefinition(server.endpoint, { credentialRef: "secret:mcp/remote-auth" }))
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect((error as MCPClientError).message).not.toContain(TOKEN);
    expect((error as MCPClientError).message).toContain("Credential resolution failed");
  });

  it("maps a wrong credential to PERMISSION_DENIED without echoing the secret", async () => {
    const wrong = "wrong-token-abcdef123456";
    const client = new RemoteMCPClient({ credentialResolver: () => wrong });
    const error = await client
      .connect(remoteDefinition(server.endpoint, { credentialRef: "secret:mcp/remote-auth" }))
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect((error as MCPClientError).mcpErrorCategory).toBe("PERMISSION_DENIED");
    expect((error as MCPClientError).message).not.toContain(wrong);
    const mapped = mapMCPErrorToRuntimeError((error as MCPClientError).mcpErrorCategory, error);
    expect(mapped.code).toBe("TOOL_ERROR");
  });

  it("connects and works with the resolved credential, keeping it out of results", async () => {
    const client = new RemoteMCPClient({ credentialResolver: () => TOKEN });
    const definition = remoteDefinition(server.endpoint, {
      id: "remote-auth-ok",
      authRef: "secret:mcp/remote-auth"
    });

    await client.connect(definition);
    const tools = await client.listTools("remote-auth-ok");
    expect(tools.length).toBe(3);

    const result = (await client.callTool("remote-auth-ok", "echo", { authed: true })) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(JSON.stringify(result)).not.toContain(TOKEN);

    await client.disconnect("remote-auth-ok");
  });
});

describe("RemoteMCPClient — Registry / ToolRuntime integration (fail-closed, DEGRADED, audit)", () => {
  let server: FakeHTTPServerHandle;
  let store: InMemoryMCPRegistryStore;
  let registry: PersistentMCPRegistry;
  let client: RemoteMCPClient;
  let serverId: string;
  let policyDenied = false;
  const events: MCPRemoteStateEvent[] = [];

  const PROJECT = "22222222-2222-4222-8222-222222222222";
  const AGENT = "dev-agent";

  beforeAll(async () => {
    server = await startFakeHTTPServer({ jsonMode: true });
    store = new InMemoryMCPRegistryStore();
    client = new RemoteMCPClient({
      reconnect: { maxAttempts: 12, initialDelayMs: 100, factor: 1.3, maxDelayMs: 300 },
      onStateChange: (event) => {
        events.push(event);
        void registry.applyConnectionState(event);
      }
    });
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

    const created = await registry.createServer({
      name: "remote-registry-server",
      transport: "streamable-http",
      endpoint: server.endpoint,
      enabled: true
    });
    serverId = created.id;

    const tools = await registry.connectAndDiscover(serverId);
    for (const tool of tools) {
      await registry.setToolEnabled(tool.id, true);
    }
    await registry.bindProject({ projectId: PROJECT, serverId });
    await registry.bindAgent({ projectId: PROJECT, agentName: AGENT, serverId });
  });

  afterAll(async () => {
    await registry.disconnectServer(serverId).catch(() => undefined);
    await server.stop();
  });

  const query = () => ({ projectId: PROJECT, agentName: AGENT });

  it("discovers remote tools and records CONNECTED with lastConnectedAt", async () => {
    const entity = await registry.getServer(serverId);
    expect(entity?.status).toBe("CONNECTED");
    expect(entity?.endpoint).toBe(server.endpoint);
    expect(entity?.lastConnectedAt).toBeDefined();
    expect((await registry.listTools(serverId)).length).toBe(3);
  });

  it("executes remote tools through the existing ToolRuntime with audit", async () => {
    const recorder = new MemoryToolCallRecorder();
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(query()) });

    const before = (await server.hits()).hits;
    const result = await runtime.execute("echo", { through: "registry" }, context(recorder));

    expect(result.success).toBe(true);
    expect(result.audit.toolName).toBe("echo");
    expect(result.audit.riskLevel).toBe("MEDIUM");
    expect(recorder.started.some((record) => record.toolName === "echo")).toBe(true);
    expect(recorder.finished.some((record) => record.status === "succeeded")).toBe(true);
    expect((await server.hits()).hits).toBe(before + 1);
  });

  it("DENY: revoked agent binding produces zero HTTP requests", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(query()) });
    await registry.unbindAgent(PROJECT, AGENT, serverId);
    const before = (await server.hits()).hits;

    const result = await runtime.execute("echo", { denied: true }, context());
    expect(result.success).toBe(false);
    expect((result.error?.details as Record<string, unknown>)?.mcpErrorCategory).toBe(
      "PERMISSION_DENIED"
    );
    expect((await server.hits()).hits).toBe(before);

    await registry.bindAgent({ projectId: PROJECT, agentName: AGENT, serverId });
  });

  it("DENY: disabled tool and disabled server produce zero HTTP requests", async () => {
    const tools = await registry.listTools(serverId);
    const echo = tools.find((tool) => tool.name === "echo")!;

    const runtime1 = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(query()) });
    await registry.setToolEnabled(echo.id, false);
    const before1 = (await server.hits()).hits;
    expect((await runtime1.execute("echo", {}, context())).success).toBe(false);
    expect((await server.hits()).hits).toBe(before1);
    await registry.setToolEnabled(echo.id, true);

    const runtime2 = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(query()) });
    await registry.setServerEnabled(serverId, false);
    const before2 = (await server.hits()).hits;
    expect((await runtime2.execute("echo", {}, context())).success).toBe(false);
    expect((await server.hits()).hits).toBe(before2);

    await registry.setServerEnabled(serverId, true);
    await registry.connectServer(serverId);
  });

  it("DENY: policy rejection produces zero HTTP requests", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(query()) });
    policyDenied = true;
    const before = (await server.hits()).hits;

    expect((await runtime.execute("echo", {}, context())).success).toBe(false);
    expect((await server.hits()).hits).toBe(before);
    policyDenied = false;
  });

  it("maps ToolRuntime timeout to TIMEOUT_ERROR over a real slow remote tool", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(query()) });
    const result = await runtime.execute(
      "slow",
      { delayMs: 1500 },
      context(undefined, { timeoutMs: 300 })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TIMEOUT_ERROR");
  });

  it("maps cancellation to CANCELLED_ERROR and aborts the HTTP request", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(query()) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await runtime.execute(
      "slow",
      { delayMs: 1500 },
      context(undefined, { signal: controller.signal })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CANCELLED_ERROR");
  });

  it(
    "goes DEGRADED on server loss: tools stay persisted, execution returns a unified error",
    { timeout: 30_000 },
    async () => {
      await server.stop();

      const result = await new ToolRuntime({
        tools: await registry.listVisibleToolDefinitions(query())
      }).execute("echo", { degraded: true }, context());
      expect(result.success).toBe(false);
      expect(["TOOL_ERROR", "TIMEOUT_ERROR"]).toContain(result.error?.code);
      expect((result.error?.details as Record<string, unknown>)?.mcpErrorCategory).toBe(
        "CONNECTION"
      );

      // Registry tracked the loss: the client event stream shows DEGRADED, and
      // the persisted status is a post-loss state (DEGRADED → RECONNECTING → ...).
      expect(events.some((event) => event.state === "DEGRADED")).toBe(true);
      await waitFor(
        async () =>
          ["DEGRADED", "RECONNECTING", "DISCONNECTED"].includes(
            (await registry.getServer(serverId))?.status ?? ""
          ),
        "registry post-loss status",
        5000
      );
      expect((await registry.getServer(serverId))?.status).not.toBe("CONNECTED");
      expect((await registry.listTools(serverId)).length).toBe(3);
      await expect(registry.refreshTools(serverId)).rejects.toThrow();

      // Exhaustion ends DISCONNECTED (bounded policy from beforeAll).
      await waitFor(
        async () => (await registry.getServer(serverId))?.status === "DISCONNECTED",
        "registry DISCONNECTED",
        10_000
      );
    }
  );

  it("recovers: reconnect → CONNECTED → refreshTools updates metadata → execution works", async () => {
    const restarted = await startFakeHTTPServer({ jsonMode: true, port: server.port });
    try {
      // Restarting alone does not heal the client; an explicit reconnect does.
      await registry.connectServer(serverId);
      await waitFor(
        async () => (await registry.getServer(serverId))?.status === "CONNECTED",
        "registry CONNECTED",
        5000
      );

      const refreshed = await registry.refreshTools(serverId);
      expect(refreshed.length).toBe(3);
      expect(
        refreshed.every((tool) => tool.inputSchema && typeof tool.inputSchema === "object")
      ).toBe(true);

      const result = await new ToolRuntime({
        tools: await registry.listVisibleToolDefinitions(query())
      }).execute("echo", { after: "recovery" }, context());
      expect(result.success).toBe(true);
    } finally {
      await restarted.stop();
      await registry.disconnectServer(serverId).catch(() => undefined);
    }
  });

  it("keeps native tools unaffected alongside remote MCP tools", async () => {
    const runtime = new ToolRuntime({
      tools: [...createPhase1Tools(), ...(await registry.listVisibleToolDefinitions(query()))]
    });
    const names = runtime.getToolDefinitions().map((definition) => definition.name);
    expect(names).toContain("git_status");
    expect(names).toContain("echo");
    expect((await runtime.execute("git_status", {}, context())).success).toBe(true);
  });
});

describe("RemoteMCPClient — contract guards", () => {
  it("rejects stdio definitions on the remote client", async () => {
    const client = new RemoteMCPClient();
    await expect(
      client.connect({
        id: "stdio-on-remote",
        name: "stdio-on-remote",
        transport: "stdio",
        stdio: { command: "node" },
        enabled: true
      })
    ).rejects.toThrow(/streamable-http/);
  });

  it("redacts credential-shaped text and known secrets", () => {
    const secret = "super-secret-value-123456".repeat(2);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig";
    const cleaned = redactCredentialShapedText(`failed with Bearer ${secret} and token ${jwt}`, [
      secret
    ]);
    expect(cleaned).not.toContain(secret);
    expect(cleaned).not.toContain(jwt);
    expect(cleaned).toContain("[REDACTED]");
  });
});
