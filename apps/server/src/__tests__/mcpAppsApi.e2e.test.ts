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
  FAKE_UI_APP_MIME,
  FAKE_UI_APP_URI,
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
import type { ToolCallFinishedRecord, ToolCallStartedRecord } from "@ai-se/tool-runtime";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { AgentRunService } from "../services/agentRunService";
import { MemoryCancellationStore } from "../services/cancellationStore";
import { MCPAppService } from "../services/mcpAppService";
import { MCPConsoleService } from "../services/mcpService";

/**
 * Phase 5.5-7: MCP Apps API E2E.
 *
 * Real PostgreSQL (migration 008), the REAL stdio MCP server and the REAL
 * Streamable HTTP fixture. Proves: UI resources are served through the SAME
 * capability gates as 5.5-6; controlled actions execute through the Tool
 * Runtime chain (permission / approval / timeout / cancellation / audit) and
 * every denied action fails BEFORE the MCP server is touched (hit counters).
 */

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres() {
  const name = `ai-se-mcp-apps-${randomUUID()}`;
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
  toolsListCalls = 0;
  resourceReadCalls = 0;

  constructor(
    private readonly delegate: MCPClientPort & { pidOf?: (id: string) => number | null }
  ) {}

  requestCount(toolName: string): number {
    return this.counts.get(toolName) ?? 0;
  }

  totalCalls(): number {
    let total = 0;
    for (const count of this.counts.values()) total += count;
    return total;
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
    this.toolsListCalls += 1;
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
    this.resourceReadCalls += 1;
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

class RecordingToolCalls {
  readonly started: ToolCallStartedRecord[] = [];
  readonly finished: ToolCallFinishedRecord[] = [];

  async recordToolCallStarted(record: ToolCallStartedRecord): Promise<void> {
    this.started.push(record);
  }

  async recordToolCallFinished(record: ToolCallFinishedRecord): Promise<void> {
    this.finished.push(record);
  }
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

const ENV_MARKER = "env-secret-marker-apps-123";
const AGENT = "apps-agent";

describe("MCP Apps API E2E (PostgreSQL + real stdio & Streamable HTTP servers)", () => {
  let pool: Awaited<ReturnType<typeof startPostgres>>["pool"];
  let stop: () => Promise<void>;
  let httpFake: FakeHTTPServerHandle;
  let stdioClient: CountingMCPClient;
  let remoteClient: CountingMCPClient;
  let stdioRegistry: PersistentMCPRegistry;
  let remoteRegistry: PersistentMCPRegistry;
  let consoleService: MCPConsoleService;
  let appService: MCPAppService;
  let recorder: RecordingToolCalls;
  let app: ReturnType<typeof createApp>;
  let projectId: string;
  let stdioServerId: string;
  let httpServerId: string;
  let gateApproves = true;

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
      name: "MCP Apps",
      description: "Phase 5.5-7",
      repository: `https://example.test/${randomUUID()}`,
      status: "active"
    });
    projectId = project.id;

    // Registry wiring mirrors apps/server/src/index.ts (+ an approval gate so
    // the approval branch is exercisable; it fails closed when it returns false).
    const store = new PgMCPRegistryStore(pool);
    stdioClient = new CountingMCPClient(new StdioMCPClient());
    stdioRegistry = new PersistentMCPRegistry({
      client: stdioClient,
      store,
      approvalGate: () => gateApproves
    });
    httpFake = await startFakeHTTPServer({});
    remoteClient = new CountingMCPClient(new RemoteMCPClient({}));
    remoteRegistry = new PersistentMCPRegistry({
      client: remoteClient,
      store,
      approvalGate: () => gateApproves
    });
    const registries = { stdio: stdioRegistry, "streamable-http": remoteRegistry };
    consoleService = new MCPConsoleService({ store, registries, projects });
    recorder = new RecordingToolCalls();
    appService = new MCPAppService({ store, registries, toolCallRecorder: recorder });

    const fake = createFakeMCPServerDefinition();
    const stdioServer = await stdioRegistry.createServer({
      name: "fake-stdio-apps",
      description: "Local fixture",
      stdio: {
        command: fake.stdio!.command,
        args: fake.stdio!.args,
        env: { AI_SE_TEST_NOTE: ENV_MARKER }
      },
      enabled: true,
      credentialRef: "vault://mcp/apps"
    });
    stdioServerId = stdioServer.id;

    const httpServer = await remoteRegistry.createServer({
      name: "fake-http-apps",
      description: "Remote fixture",
      transport: "streamable-http",
      endpoint: httpFake.endpoint,
      enabled: true
    });
    httpServerId = httpServer.id;

    const initialized = await consoleService.initialize();
    expect(initialized.failed).toEqual([]);

    for (const serverId of [stdioServerId, httpServerId]) {
      for (const tool of await store.listTools(serverId)) {
        await store.updateTool(tool.id, { enabled: true });
      }
    }

    await stdioRegistry.bindProject({ projectId, serverId: stdioServerId });
    await stdioRegistry.bindAgent({ projectId, agentName: AGENT, serverId: stdioServerId });
    await remoteRegistry.bindProject({ projectId, serverId: httpServerId });
    await remoteRegistry.bindAgent({ projectId, agentName: AGENT, serverId: httpServerId });

    app = createApp({
      logger,
      projectRepository: projects,
      agentRunService,
      mcpService: consoleService,
      mcpAppService: appService,
      checkDatabase: async () => void (await pool.query("SELECT 1")),
      checkRedis: async () => undefined,
      corsOrigin: "http://localhost:5173"
    });
  }, 120_000);

  afterAll(async () => {
    const pid = stdioClient?.pidOf(stdioServerId) ?? null;
    await consoleService?.shutdown().catch(() => undefined);
    if (pid) await waitForProcessExit(pid, 3000).catch(() => undefined);
    await httpFake?.stop().catch(() => undefined);
    await stop?.();
  });

  // ── App discovery (tool `_meta.ui` links) ────────────────────────────────

  it("lists the app link of the `_meta.ui`-carrying tool for granted projects", async () => {
    const response = await request(app)
      .get(`/api/mcp/servers/${stdioServerId}/ui-apps`)
      .query({ projectId, agentName: AGENT })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toEqual([{ toolName: "echo", resourceUri: FAKE_UI_APP_URI }]);

    const remote = await request(app)
      .get(`/api/mcp/servers/${httpServerId}/ui-apps`)
      .query({ projectId, agentName: AGENT })
      .expect(200);
    expect(remote.body.data).toEqual([{ toolName: "echo", resourceUri: FAKE_UI_APP_URI }]);

    const raw = JSON.stringify(response.body) + JSON.stringify(remote.body);
    expect(raw).not.toContain(ENV_MARKER);
    expect(raw).not.toContain("Bearer ");
  });

  it("returns no apps for an ungranted project — zero MCP requests", async () => {
    const before = stdioClient.toolsListCalls;
    const response = await request(app)
      .get(`/api/mcp/servers/${stdioServerId}/ui-apps`)
      .query({ projectId: randomUUID(), agentName: AGENT })
      .expect(200);
    expect(response.body.data).toEqual([]);
    expect(stdioClient.toolsListCalls).toBe(before);
  });

  // ── UI resource serving (existing resource architecture) ─────────────────

  it("serves the ui:// app document to the console (sandbox srcdoc payload)", async () => {
    const before = stdioClient.resourceReadCalls;
    const response = await request(app)
      .get(`/api/mcp/servers/${stdioServerId}/ui-resource`)
      .query({ uri: FAKE_UI_APP_URI, projectId, agentName: AGENT })
      .expect(200);

    expect(response.body.data.uri).toBe(FAKE_UI_APP_URI);
    expect(response.body.data.mimeType).toBe(FAKE_UI_APP_MIME);
    expect(response.body.data.html).toContain("aiseMcpApp");
    expect(stdioClient.resourceReadCalls).toBe(before + 1);

    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain(ENV_MARKER);
    expect(raw).not.toContain("Bearer ");
    expect(raw).not.toContain("token");
  });

  it("rejects non-ui:// URIs and unknown app resources", async () => {
    await request(app)
      .get(`/api/mcp/servers/${stdioServerId}/ui-resource`)
      .query({ uri: "https://example.test/app", projectId, agentName: AGENT })
      .expect(400);

    const missing = await request(app)
      .get(`/api/mcp/servers/${stdioServerId}/ui-resource`)
      .query({ uri: "ui://apps/does-not-exist", projectId, agentName: AGENT })
      .expect(404);
    expect(missing.body.error.code).toBe("MCP_APP_RESOURCE_NOT_FOUND");
  });

  it("denies an ungranted read — zero MCP requests", async () => {
    const before = stdioClient.resourceReadCalls;
    const response = await request(app)
      .get(`/api/mcp/servers/${stdioServerId}/ui-resource`)
      .query({ uri: FAKE_UI_APP_URI, projectId: randomUUID(), agentName: AGENT })
      .expect(403);
    expect(response.body.error.code).toBe("MCP_APP_RESOURCE_DENIED");
    expect(stdioClient.resourceReadCalls).toBe(before);
  });

  // ── Controlled actions (Tool Runtime chain) ──────────────────────────────

  it("executes an allowed action through the Tool Runtime (stdio)", async () => {
    const before = stdioClient.requestCount("echo");
    const response = await request(app)
      .post("/api/mcp/apps/actions")
      .send({
        serverId: stdioServerId,
        projectId,
        agentName: AGENT,
        toolName: "echo",
        arguments: { from: "e2e" }
      })
      .expect(200);

    expect(response.body.data.data).toEqual({
      content: [{ type: "text", text: JSON.stringify({ from: "e2e" }) }]
    });
    expect(response.body.data.duration).toBeTypeOf("number");
    expect(response.body.data.audit.toolName).toBe("echo");
    expect(response.body.data.audit.riskLevel).toBe("MEDIUM");
    expect(response.body.data.audit.actor).toBe(AGENT);
    expect(response.body.data.audit.requestId).toBeTruthy();
    expect(stdioClient.requestCount("echo")).toBe(before + 1);

    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain(ENV_MARKER);
    expect(raw).not.toContain("Bearer ");
  });

  it("executes an allowed action over Streamable HTTP", async () => {
    const before = (await httpFake.hits()).hits;
    const response = await request(app)
      .post("/api/mcp/apps/actions")
      .send({
        serverId: httpServerId,
        projectId,
        agentName: AGENT,
        toolName: "echo",
        arguments: { transport: "http" }
      })
      .expect(200);
    expect(response.body.data.data.content[0].text).toContain("http");
    expect((await httpFake.hits()).hits).toBe(before + 1);
  });

  it("denies actions outside the granted scope — zero MCP requests", async () => {
    const before = stdioClient.totalCalls();

    // Ungranted project.
    const project = await request(app)
      .post("/api/mcp/apps/actions")
      .send({
        serverId: stdioServerId,
        projectId: randomUUID(),
        agentName: AGENT,
        toolName: "echo",
        arguments: {}
      })
      .expect(403);
    expect(project.body.error.code).toBe("MCP_APP_ACTION_DENIED");

    // Host-side allowlist mismatch.
    const allowlist = await request(app)
      .post("/api/mcp/apps/actions")
      .send({
        serverId: stdioServerId,
        projectId,
        agentName: AGENT,
        toolName: "echo",
        arguments: {},
        allowedTools: ["slow"]
      })
      .expect(403);
    expect(allowlist.body.error.code).toBe("MCP_APP_ACTION_DENIED");

    // Unknown tool.
    const unknown = await request(app)
      .post("/api/mcp/apps/actions")
      .send({
        serverId: stdioServerId,
        projectId,
        agentName: AGENT,
        toolName: "nope",
        arguments: {}
      })
      .expect(404);
    expect(unknown.body.error.code).toBe("MCP_TOOL_NOT_FOUND");

    expect(stdioClient.totalCalls()).toBe(before);
  });

  it("denies disabled tools and revoked bindings at call time — zero MCP requests", async () => {
    const store = new PgMCPRegistryStore(pool);
    const failing = await store.getToolByName(stdioServerId, "failing");
    await store.updateTool(failing!.id, { enabled: false });

    const before = stdioClient.totalCalls();
    const disabled = await request(app)
      .post("/api/mcp/apps/actions")
      .send({
        serverId: stdioServerId,
        projectId,
        agentName: AGENT,
        toolName: "failing",
        arguments: {}
      })
      .expect(403);
    expect(disabled.body.error.code).toBe("MCP_APP_ACTION_DENIED");
    expect(stdioClient.totalCalls()).toBe(before);

    await store.updateTool(failing!.id, { enabled: true });

    // Binding revocation takes effect on the next action, with zero requests.
    const binding = (await stdioRegistry.listBindings({ projectId, serverId: stdioServerId })).find(
      (row) => row.agentName === AGENT
    )!;
    await store.deleteBinding(binding.id);
    const revoked = await request(app)
      .post("/api/mcp/apps/actions")
      .send({
        serverId: stdioServerId,
        projectId,
        agentName: AGENT,
        toolName: "echo",
        arguments: {}
      })
      .expect(403);
    expect(revoked.body.error.code).toBe("MCP_APP_ACTION_DENIED");
    expect(stdioClient.totalCalls()).toBe(before);

    await stdioRegistry.bindAgent({ projectId, agentName: AGENT, serverId: stdioServerId });
  });

  it("routes approval-required tools through the existing approval gate", async () => {
    const store = new PgMCPRegistryStore(pool);
    const echo = await store.getToolByName(stdioServerId, "echo");
    await store.updateTool(echo!.id, { requiresApproval: true });

    const before = stdioClient.requestCount("echo");
    gateApproves = false;
    const denied = await request(app)
      .post("/api/mcp/apps/actions")
      .send({
        serverId: stdioServerId,
        projectId,
        agentName: AGENT,
        toolName: "echo",
        arguments: { approved: false }
      })
      .expect(403);
    expect(denied.body.error.code).toBe("MCP_APP_APPROVAL_REQUIRED");
    expect(stdioClient.requestCount("echo")).toBe(before);

    gateApproves = true;
    await request(app)
      .post("/api/mcp/apps/actions")
      .send({
        serverId: stdioServerId,
        projectId,
        agentName: AGENT,
        toolName: "echo",
        arguments: { approved: true }
      })
      .expect(200);
    expect(stdioClient.requestCount("echo")).toBe(before + 1);

    await store.updateTool(echo!.id, { requiresApproval: false });
  });

  it("times out slow actions with the runtime TIMEOUT code", async () => {
    const started = Date.now();
    const response = await request(app)
      .post("/api/mcp/apps/actions")
      .send({
        serverId: stdioServerId,
        projectId,
        agentName: AGENT,
        toolName: "slow",
        arguments: { delayMs: 500 },
        timeoutMs: 100
      })
      .expect(504);
    expect(response.body.error.code).toBe("MCP_APP_ACTION_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(450);
  });

  it("cancels actions through the runtime signal — zero MCP requests", async () => {
    const controller = new AbortController();
    controller.abort();
    const before = stdioClient.requestCount("slow");

    let caught: { statusCode: number; code: string } | null = null;
    try {
      await appService.runAction(
        {
          serverId: stdioServerId,
          projectId,
          agentName: AGENT,
          toolName: "slow",
          arguments: { delayMs: 500 }
        },
        controller.signal
      );
    } catch (error) {
      caught = error as { statusCode: number; code: string };
    }
    expect(caught?.code).toBe("MCP_APP_ACTION_CANCELLED");
    expect(caught?.statusCode).toBe(408);
    expect(stdioClient.requestCount("slow")).toBe(before);
  });

  it("records actions through the Tool Runtime recorder (audit reuse)", async () => {
    const startedBefore = recorder.started.length;
    const finishedBefore = recorder.finished.length;

    await request(app)
      .post("/api/mcp/apps/actions")
      .send({
        serverId: stdioServerId,
        projectId,
        agentName: AGENT,
        toolName: "echo",
        arguments: { audited: true }
      })
      .expect(200);

    expect(recorder.started.length).toBe(startedBefore + 1);
    expect(recorder.started.at(-1)!.toolName).toBe("echo");
    expect(recorder.finished.length).toBe(finishedBefore + 1);
    expect(recorder.finished.at(-1)!.status).toBe("succeeded");
  });

  it("redacts credential-shaped tool errors (secret isolation)", async () => {
    const response = await request(app)
      .post("/api/mcp/apps/actions")
      .send({
        serverId: stdioServerId,
        projectId,
        agentName: AGENT,
        toolName: "failing",
        arguments: { message: "boom sk-live1234567890abcdef" }
      })
      .expect(502);

    expect(response.body.error.code).toBe("MCP_APP_ACTION_FAILED");
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("sk-live1234567890abcdef");
    expect(raw).toContain("[REDACTED]");
    expect(raw).not.toContain(ENV_MARKER);
  });

  it("validates action payloads strictly (unknown fields rejected)", async () => {
    const before = stdioClient.totalCalls();
    const response = await request(app)
      .post("/api/mcp/apps/actions")
      .send({
        serverId: stdioServerId,
        projectId,
        agentName: AGENT,
        toolName: "echo",
        arguments: {},
        credentialRef: "vault://mcp/apps"
      })
      .expect(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(stdioClient.totalCalls()).toBe(before);
  });
});
