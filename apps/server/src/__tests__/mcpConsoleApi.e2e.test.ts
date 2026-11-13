import {
  PgAgentRunStore,
  PgMCPRegistryStore,
  PgProjectRepository,
  PgToolCallStore,
  PgWorkflowEventStore,
  createPool,
  runMigrations
} from "@ai-se/database";
import {
  MCPClientPort,
  MCPServerDefinition,
  MCPToolDefinition,
  PersistentMCPRegistry,
  RemoteMCPClient,
  StdioMCPClient,
  createFakeMCPServerDefinition,
  startFakeHTTPServer
} from "@ai-se/mcp";
import type { FakeHTTPServerHandle } from "@ai-se/mcp";
import { createLogger } from "@ai-se/observability";
import { ToolRuntime } from "@ai-se/tool-runtime";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { AgentRunService } from "../services/agentRunService";
import { MemoryCancellationStore } from "../services/cancellationStore";
import { MCPConsoleService } from "../services/mcpService";

/**
 * Phase 5.5-5: MCP Console API E2E.
 *
 * Real PostgreSQL (migration 008), the REAL stdio MCP server and the REAL
 * Streamable HTTP fixture from 5.5-4, the real Console service and app. The
 * zero-request security assertions prove console binding changes reach the
 * enforcement path immediately (stale ToolDefinitions DENY, MCP server
 * hit counters stay flat).
 */

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres() {
  const name = `ai-se-mcp-console-${randomUUID()}`;
  await docker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e",
    "POSTGRES_USER=aise",
    "-e",
    "POSTGRES_DB=aise",
    "-p",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "postgres:16-alpine"
  ]);
  const port = (await docker(["port", name, "5432/tcp"])).split(":").at(-1);
  if (!port) throw new Error("Cannot resolve PostgreSQL test port");
  const pool = createPool(`postgres://aise@127.0.0.1:${port}/aise`);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return {
        pool,
        stop: async () => {
          await pool.end();
          await docker(["rm", "-f", name]);
        }
      };
    } catch {
      await sleep(500);
    }
  }
  throw new Error("PostgreSQL test container did not become ready");
}

class CountingMCPClient implements MCPClientPort {
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly delegate: MCPClientPort & { pidOf?: (id: string) => number | null }
  ) {}

  requestCount(toolName: string): number {
    return this.counts.get(toolName) ?? 0;
  }

  pidOf(serverId: string): number | null {
    return this.delegate.pidOf?.(serverId) ?? null;
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
}

const fakeSandbox = {
  async runCommand() {
    return { command: "", exitCode: 0, stdout: "", stderr: "", duration: 0, timedOut: false };
  }
};

function context(projectId: string) {
  return {
    requestId: "req-1",
    projectId,
    taskId: "task-1",
    agentRunId: "run-1",
    toolCallId: "call-1",
    actor: "console-e2e",
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
    await sleep(50);
  }
  throw new Error(`Process ${pid} still alive after ${timeoutMs}ms`);
}

const ENV_MARKER = "env-secret-marker-xyz";
const AGENT = "console-agent";
const DENY_AGENT = "deny-agent";

describe("MCP Console API E2E (PostgreSQL + real stdio & Streamable HTTP servers)", () => {
  let pool: Awaited<ReturnType<typeof startPostgres>>["pool"];
  let stop: () => Promise<void>;
  let httpFake: FakeHTTPServerHandle;
  let stdioClient: CountingMCPClient;
  let stdioRegistry: PersistentMCPRegistry;
  let remoteRegistry: PersistentMCPRegistry;
  let service: MCPConsoleService;
  let app: ReturnType<typeof createApp>;
  let projectId: string;
  let stdioServerId: string;
  let httpServerId: string;
  let agentBindingId: string;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await runMigrations(pool);

    const logger = createLogger({ enabled: false });
    const projects = new PgProjectRepository(pool);
    const agentRuns = new PgAgentRunStore(pool);
    const toolCalls = new PgToolCallStore(pool);
    const workflowEvents = new PgWorkflowEventStore(pool);
    const agentRunService = new AgentRunService({
      agentRuns,
      toolCalls,
      workflowEvents,
      projects,
      cancellationStore: new MemoryCancellationStore(),
      logger
    });

    const project = await projects.create({
      name: "MCP Console",
      description: "Phase 5.5-5",
      repository: `https://example.test/${randomUUID()}`,
      status: "active"
    });
    projectId = project.id;

    // Registry wiring mirrors apps/server/src/index.ts.
    const store = new PgMCPRegistryStore(pool);
    stdioClient = new CountingMCPClient(new StdioMCPClient());
    stdioRegistry = new PersistentMCPRegistry({ client: stdioClient, store });
    httpFake = await startFakeHTTPServer({});
    const remoteClient = new CountingMCPClient(new RemoteMCPClient({}));
    remoteRegistry = new PersistentMCPRegistry({ client: remoteClient, store });
    service = new MCPConsoleService({
      store,
      registries: { stdio: stdioRegistry, "streamable-http": remoteRegistry },
      projects
    });

    const fake = createFakeMCPServerDefinition();
    const stdioServer = await stdioRegistry.createServer({
      name: "fake-stdio",
      description: "Local fixture",
      stdio: {
        command: fake.stdio!.command,
        args: fake.stdio!.args,
        env: { AI_SE_TEST_NOTE: ENV_MARKER }
      },
      enabled: true,
      credentialRef: "vault://mcp/demo"
    });
    stdioServerId = stdioServer.id;

    const httpServer = await remoteRegistry.createServer({
      name: "fake-http",
      description: "Remote fixture",
      transport: "streamable-http",
      endpoint: httpFake.endpoint,
      enabled: true
    });
    httpServerId = httpServer.id;

    const initialized = await service.initialize();
    expect(initialized.failed).toEqual([]);
    expect(initialized.connected.sort()).toEqual([stdioServerId, httpServerId].sort());

    // Operator enables tools and tunes policy (display-only for the console).
    for (const serverId of [stdioServerId, httpServerId]) {
      for (const tool of await store.listTools(serverId)) {
        await store.updateTool(tool.id, { enabled: true });
      }
    }
    const slow = await store.getToolByName(stdioServerId, "slow");
    await store.updateTool(slow!.id, { requiresApproval: true });
    const failing = await store.getToolByName(stdioServerId, "failing");
    await store.updateTool(failing!.id, { riskLevel: "HIGH" });

    // Federation grants: project-scope + one agent scope.
    await stdioRegistry.bindProject({ projectId, serverId: stdioServerId });
    await stdioRegistry.bindAgent({ projectId, agentName: AGENT, serverId: stdioServerId });
    agentBindingId = (
      await stdioRegistry.listBindings({ projectId, serverId: stdioServerId })
    ).find((binding) => binding.agentName === AGENT)!.id;

    app = createApp({
      logger,
      projectRepository: projects,
      agentRunService,
      mcpService: service,
      checkDatabase: async () => void (await pool.query("SELECT 1")),
      checkRedis: async () => undefined,
      corsOrigin: "http://localhost:5173"
    });
  }, 120_000);

  afterAll(async () => {
    // Defensive: the setup hook above may have failed before every fixture
    // existed (docker + two spawned MCP servers under parallel load).
    const pid = stdioClient?.pidOf(stdioServerId) ?? null;
    await service?.shutdown().catch(() => undefined);
    if (pid) await waitForProcessExit(pid, 3000).catch(() => undefined);
    await httpFake?.stop().catch(() => undefined);
    await stop?.();
  });

  // ── Server list / detail ─────────────────────────────────────────────────

  it("lists both transports with live registry status and tool counts", async () => {
    const response = await request(app).get("/api/mcp/servers").expect(200);

    expect(response.body.success).toBe(true);
    const servers = response.body.data as Array<Record<string, unknown>>;
    expect(servers.length).toBe(2);

    const stdio = servers.find((server) => server.name === "fake-stdio")!;
    expect(stdio.transport).toBe("stdio");
    expect(stdio.enabled).toBe(true);
    expect(stdio.status).toBe("CONNECTED");
    expect(stdio.toolCount).toBe(3);
    expect(stdio.lastConnectedAt).toBeTruthy();

    const http = servers.find((server) => server.name === "fake-http")!;
    expect(http.transport).toBe("streamable-http");
    expect(http.status).toBe("CONNECTED");
    expect(http.toolCount).toBe(3);

    // Secret isolation: the raw response never carries env values or secrets.
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain(ENV_MARKER);
    expect(raw).not.toContain("Bearer ");
    expect(raw).not.toContain("token");
  });

  it("exposes transport configuration and credential references only", async () => {
    const stdio = (await request(app).get(`/api/mcp/servers/${stdioServerId}`).expect(200)).body
      .data;
    expect(stdio.command).toBe(process.execPath);
    expect(Array.isArray(stdio.args)).toBe(true);
    expect(stdio.args.length).toBeGreaterThan(0);
    expect(stdio.endpoint).toBeUndefined();
    expect(stdio.credentialRef).toBe("vault://mcp/demo");
    expect(stdio.authRef).toBeUndefined();
    expect("env" in stdio).toBe(false);
    expect(JSON.stringify(stdio)).not.toContain(ENV_MARKER);

    const http = (await request(app).get(`/api/mcp/servers/${httpServerId}`).expect(200)).body.data;
    expect(http.endpoint).toBe(httpFake.endpoint);
    expect(http.command).toBeUndefined();
  });

  // ── Tool list / risk / approval / schema summary ─────────────────────────

  it("lists tools with risk, approval and input schema summaries from the registry", async () => {
    const tools = (await request(app).get(`/api/mcp/servers/${stdioServerId}/tools`).expect(200))
      .body.data as Array<Record<string, unknown>>;
    expect(tools.length).toBe(3);

    const echo = tools.find((tool) => tool.name === "echo")!;
    expect(echo.enabled).toBe(true);
    expect(echo.riskLevel).toBe("MEDIUM");
    expect(echo.requiresApproval).toBe(false);
    expect(echo.inputSchemaSummary).toBe("No parameters");

    expect(tools.find((tool) => tool.name === "slow")!.requiresApproval).toBe(true);
    expect(tools.find((tool) => tool.name === "failing")!.riskLevel).toBe("HIGH");

    // A newly discovered tool with a properties schema: summary + fail-closed.
    await new PgMCPRegistryStore(pool).upsertDiscoveredTools(stdioServerId, [
      {
        name: "query",
        description: "Query records",
        inputSchema: {
          type: "object",
          properties: { filter: { type: "string" }, limit: { type: "number" } },
          required: ["filter"]
        }
      }
    ]);
    const after = (await request(app).get(`/api/mcp/servers/${stdioServerId}/tools`).expect(200))
      .body.data as Array<Record<string, unknown>>;
    const query = after.find((tool) => tool.name === "query")!;
    expect(query.enabled).toBe(false); // new tools stay disabled (fail-closed)
    expect(query.inputSchemaSummary).toBe("Properties: filter, limit • required: filter");
  });

  it("rejects unknown servers and exposes no MCP protocol endpoints", async () => {
    const missing = await request(app).get(`/api/mcp/servers/${randomUUID()}`).expect(404);
    expect(missing.body.error.code).toBe("MCP_SERVER_NOT_FOUND");
    await request(app).get(`/api/mcp/servers/${randomUUID()}/tools`).expect(404);
    await request(app).get(`/api/mcp/servers/${randomUUID()}/bindings`).expect(404);

    // The console API is REST management only — there is no JSON-RPC /
    // tools-call proxy the browser could use as an MCP endpoint.
    await request(app).post(`/api/mcp/servers/${stdioServerId}/tools/call`).send({}).expect(404);
    await request(app).post(`/api/mcp/servers/${stdioServerId}/tools/list`).send({}).expect(404);
  });

  // ── Bindings ─────────────────────────────────────────────────────────────

  it("lists project and agent bindings with resolved names", async () => {
    const bindings = (
      await request(app).get(`/api/mcp/servers/${stdioServerId}/bindings`).expect(200)
    ).body.data as Array<Record<string, unknown>>;
    expect(bindings.length).toBe(2);

    const projectBinding = bindings.find((binding) => binding.agentName === undefined)!;
    expect(projectBinding.projectName).toBe("MCP Console");
    expect(projectBinding.serverName).toBe("fake-stdio");
    expect(projectBinding.toolName).toBeUndefined();
    expect(projectBinding.enabled).toBe(true);

    const agentBinding = bindings.find((binding) => binding.agentName === AGENT)!;
    expect(agentBinding.id).toBe(agentBindingId);
    expect(agentBinding.enabled).toBe(true);
  });

  it("creates bindings and rejects duplicates and invalid references", async () => {
    const created = await request(app)
      .post(`/api/mcp/servers/${stdioServerId}/bindings`)
      .send({ projectId, agentName: AGENT, toolName: "echo" })
      .expect(201);
    expect(created.body.data.agentName).toBe(AGENT);
    expect(created.body.data.toolName).toBe("echo");
    expect(created.body.data.enabled).toBe(true);

    const duplicate = await request(app)
      .post(`/api/mcp/servers/${stdioServerId}/bindings`)
      .send({ projectId, agentName: AGENT, toolName: "echo" })
      .expect(409);
    expect(duplicate.body.error.code).toBe("MCP_BINDING_EXISTS");

    const unknownTool = await request(app)
      .post(`/api/mcp/servers/${stdioServerId}/bindings`)
      .send({ projectId, agentName: AGENT, toolName: "does-not-exist" })
      .expect(400);
    expect(unknownTool.body.error.code).toBe("MCP_TOOL_NOT_FOUND");

    const unknownServer = await request(app)
      .post(`/api/mcp/servers/${randomUUID()}/bindings`)
      .send({ projectId, agentName: AGENT })
      .expect(404);
    expect(unknownServer.body.error.code).toBe("MCP_SERVER_NOT_FOUND");

    const unknownProject = await request(app)
      .post(`/api/mcp/servers/${stdioServerId}/bindings`)
      .send({ projectId: randomUUID(), agentName: AGENT })
      .expect(400);
    expect(unknownProject.body.error.code).toBe("MCP_PROJECT_NOT_FOUND");

    const invalid = await request(app)
      .post(`/api/mcp/servers/${stdioServerId}/bindings`)
      .send({ agentName: AGENT })
      .expect(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");

    // Dormant grant via the console: created disabled, then enabled via PATCH.
    const dormant = await request(app)
      .post(`/api/mcp/servers/${stdioServerId}/bindings`)
      .send({ projectId, agentName: AGENT, toolName: "slow", enabled: false })
      .expect(201);
    expect(dormant.body.data.enabled).toBe(false);
    await request(app).delete(`/api/mcp/bindings/${dormant.body.data.id}`).expect(200);
  });

  it("binding changes take effect immediately: stale definitions DENY with zero requests", async () => {
    const seed = await request(app)
      .post(`/api/mcp/servers/${stdioServerId}/bindings`)
      .send({ projectId, agentName: DENY_AGENT })
      .expect(201);
    const bindingId = seed.body.data.id as string;

    const query = { projectId, agentName: DENY_AGENT };
    const definitions = await stdioRegistry.listVisibleToolDefinitions(query);
    // "query" stays invisible: it was discovered later and is still disabled.
    expect(definitions.map((definition) => definition.name).sort()).toEqual([
      "echo",
      "failing",
      "slow"
    ]);

    const runtime = new ToolRuntime({ tools: definitions });
    const before = stdioClient.requestCount("echo");

    const granted = await runtime.execute("echo", { step: "granted" }, context(projectId));
    expect(granted.success).toBe(true);
    expect(stdioClient.requestCount("echo")).toBe(before + 1);

    // Disable through the CONSOLE API — the already-built definitions must DENY.
    const disabled = await request(app)
      .patch(`/api/mcp/bindings/${bindingId}`)
      .send({ enabled: false })
      .expect(200);
    expect(disabled.body.data.enabled).toBe(false);

    const denied = await runtime.execute("echo", { step: "denied" }, context(projectId));
    expect(denied.success).toBe(false);
    expect((denied.error?.details as Record<string, unknown>)?.mcpErrorCategory).toBe(
      "PERMISSION_DENIED"
    );
    expect(stdioClient.requestCount("echo")).toBe(before + 1); // zero new requests

    // Re-enable → allowed again.
    await request(app).patch(`/api/mcp/bindings/${bindingId}`).send({ enabled: true }).expect(200);
    const regranted = await runtime.execute("echo", { step: "regranted" }, context(projectId));
    expect(regranted.success).toBe(true);
    expect(stdioClient.requestCount("echo")).toBe(before + 2);

    // Revoke → DENY again with zero requests.
    await request(app).delete(`/api/mcp/bindings/${bindingId}`).expect(200);
    expect(await stdioRegistry.listVisibleToolDefinitions(query)).toEqual([]);
    const revoked = await runtime.execute("echo", { step: "revoked" }, context(projectId));
    expect(revoked.success).toBe(false);
    expect(stdioClient.requestCount("echo")).toBe(before + 2);

    // Unknown binding ids are rejected.
    await request(app)
      .patch(`/api/mcp/bindings/${randomUUID()}`)
      .send({ enabled: true })
      .expect(404);
    await request(app).delete(`/api/mcp/bindings/${randomUUID()}`).expect(404);
  });

  // ── Degraded / revoked display ───────────────────────────────────────────

  it("keeps tools listed for a DEGRADED server and reflects status transitions", async () => {
    const store = new PgMCPRegistryStore(pool);
    await store.updateServer(httpServerId, { status: "DEGRADED", lastError: "fixture down" });

    const servers = (await request(app).get("/api/mcp/servers").expect(200)).body.data as Array<
      Record<string, unknown>
    >;
    const http = servers.find((server) => server.id === httpServerId)!;
    expect(http.status).toBe("DEGRADED");
    expect(http.lastError).toBe("fixture down");

    // DEGRADED never removes tools or flips them to disabled.
    const tools = (await request(app).get(`/api/mcp/servers/${httpServerId}/tools`).expect(200))
      .body.data as Array<Record<string, unknown>>;
    expect(tools.length).toBe(3);
    expect(tools.every((tool) => tool.enabled === true)).toBe(true);

    await store.updateServer(httpServerId, { status: "REVOKED", lastError: null });
    const revoked = (await request(app).get("/api/mcp/servers").expect(200)).body.data as Array<
      Record<string, unknown>
    >;
    expect(revoked.find((server) => server.id === httpServerId)!.status).toBe("REVOKED");

    await store.updateServer(httpServerId, { status: "CONNECTED" });
  });
});
