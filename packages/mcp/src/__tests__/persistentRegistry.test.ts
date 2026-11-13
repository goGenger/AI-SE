import { ToolRuntime } from "@ai-se/tool-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StdioMCPClient } from "../client/StdioMCPClient";
import { MCPServerDefinition, MCPToolDefinition } from "../contracts";
import { MCPContractError } from "../contracts";
import { InMemoryMCPRegistryStore } from "../registry/inMemoryStore";
import { PersistentMCPRegistry } from "../registry/persistentRegistry";
import { MCPRegistryStore } from "../registry/store";
import { createFakeMCPServerDefinition } from "../testing/fakeMCPServer";

/**
 * Phase 5.5-3: PersistentMCPRegistry semantics against the IN-MEMORY store
 * backend + the REAL stdio fake server. The PostgreSQL backend is covered by
 * @ai-se/database tests; this suite proves the registry logic itself:
 * deny-by-default, the full fail-closed matrix, live (non-stale) call-time
 * re-checks, and restart recovery.
 */

class CountingMCPClient {
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

function context(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    projectId: "proj-1",
    taskId: "task-1",
    agentRunId: "run-1",
    toolCallId: "call-1",
    actor: "dev-agent",
    workspacePath: "/workspace",
    sandbox: fakeSandbox,
    ...overrides
  } as never;
}

function fakeServerStdio() {
  const fake = createFakeMCPServerDefinition();
  return { name: fake.name, stdio: { command: fake.stdio!.command, args: fake.stdio!.args } };
}

const PROJECT = "11111111-1111-4111-8111-111111111111";
const AGENT = "dev-agent";
const QUERY = { projectId: PROJECT, agentName: AGENT };

describe("PersistentMCPRegistry (in-memory store + real stdio fake server)", () => {
  const store: MCPRegistryStore = new InMemoryMCPRegistryStore();
  const stdio = new StdioMCPClient();
  const client = new CountingMCPClient(stdio);
  let policyDenied = false;
  const registry = new PersistentMCPRegistry({
    client,
    store,
    policyProvider: (_server, tool) =>
      policyDenied
        ? undefined
        : tool.name === "failing"
          ? { riskLevel: "HIGH", requiresApproval: false }
          : { riskLevel: "MEDIUM", requiresApproval: false }
  });

  let serverId: string;
  let echoId: string;
  let slowId: string;

  beforeAll(async () => {
    serverId = (await registry.createServer({ ...fakeServerStdio(), enabled: true })).id;
    const tools = await registry.connectAndDiscover(serverId);
    echoId = tools.find((tool) => tool.name === "echo")!.id;
    slowId = tools.find((tool) => tool.name === "slow")!.id;
  });

  afterAll(async () => {
    await registry.disconnectServer(serverId).catch(() => undefined);
  });

  it("rejects credential-shaped server input", async () => {
    await expect(
      registry.createServer({ ...fakeServerStdio(), authRef: "Bearer eyJhbGciOiJIUzI1NiJ9" })
    ).rejects.toThrow(MCPContractError);
    await expect(
      registry.createServer({
        ...fakeServerStdio(),
        stdio: { ...fakeServerStdio().stdio, env: { api_key: "plaintext" } }
      })
    ).rejects.toThrow(MCPContractError);
  });

  it("persists discovery with fail-closed defaults", async () => {
    const tools = await registry.listTools(serverId);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "failing", "slow"]);
    expect(tools.every((tool) => tool.enabled === false)).toBe(true);
    expect(tools.every((tool) => tool.requiresApproval === false)).toBe(true);
    const server = await registry.getServer(serverId);
    expect(server?.status).toBe("CONNECTED");
    expect(server?.lastConnectedAt).toBeDefined();
  });

  it("keeps everything invisible by default (deny by default)", async () => {
    expect(await registry.isToolVisible(serverId, "echo", QUERY)).toBe(false);
    expect(await registry.listVisibleToolDefinitions(QUERY)).toEqual([]);
    expect(client.requestCount("echo")).toBe(0);
  });

  it("denies while the tool itself is disabled", async () => {
    await registry.bindProject({ projectId: PROJECT, serverId });
    await registry.bindAgent({ projectId: PROJECT, agentName: AGENT, serverId });
    expect(await registry.isToolVisible(serverId, "echo", QUERY)).toBe(false);
    expect(client.requestCount("echo")).toBe(0);
  });

  it("requires BOTH project and agent bindings in addition to tool enablement", async () => {
    await registry.setToolEnabled(echoId, true);

    // Both bindings granted by the previous test: now visible.
    expect(await registry.isToolVisible(serverId, "echo", QUERY)).toBe(true);

    // Remove agent binding: denied.
    await registry.unbindAgent(PROJECT, AGENT, serverId);
    expect(await registry.isToolVisible(serverId, "echo", QUERY)).toBe(false);

    // Only agent binding (no project): denied.
    await registry.bindAgent({ projectId: PROJECT, agentName: AGENT, serverId });
    await registry.unbindProject(PROJECT, serverId);
    expect(await registry.isToolVisible(serverId, "echo", QUERY)).toBe(false);

    // Undefined scope (no project/agent in query): denied.
    expect(await registry.isToolVisible(serverId, "echo", {})).toBe(false);

    await registry.bindProject({ projectId: PROJECT, serverId });
    expect(await registry.isToolVisible(serverId, "echo", QUERY)).toBe(true);
    expect(client.requestCount("echo")).toBe(0);
  });

  it("executes a granted tool through the existing ToolRuntime", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(QUERY) });
    const result = await runtime.execute("echo", { ok: 1 }, context());

    expect(result.success).toBe(true);
    expect(result.audit.toolName).toBe("echo");
    expect(result.audit.riskLevel).toBe("MEDIUM");
    expect(client.requestCount("echo")).toBe(1);
  });

  it("denies revoked agent bindings at call time even for existing ToolDefinitions", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(QUERY) });
    await registry.unbindAgent(PROJECT, AGENT, serverId);

    const result = await runtime.execute("echo", { ok: 1 }, context());
    expect(result.success).toBe(false);
    expect((result.error?.details as Record<string, unknown>)?.mcpErrorCategory).toBe(
      "PERMISSION_DENIED"
    );
    expect(client.requestCount("echo")).toBe(1); // zero additional requests

    await registry.bindAgent({ projectId: PROJECT, agentName: AGENT, serverId });
  });

  it("denies tools disabled after discovery at call time", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(QUERY) });
    await registry.setToolEnabled(echoId, false);

    const result = await runtime.execute("echo", { ok: 1 }, context());
    expect(result.success).toBe(false);
    expect(client.requestCount("echo")).toBe(1);

    await registry.setToolEnabled(echoId, true);
  });

  it("denies servers disabled after discovery at call time and disconnects them", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(QUERY) });
    await registry.setServerEnabled(serverId, false);

    const result = await runtime.execute("echo", { ok: 1 }, context());
    expect(result.success).toBe(false);
    expect(client.requestCount("echo")).toBe(1);

    const server = await registry.getServer(serverId);
    expect(server?.status).toBe("DISCONNECTED");

    // No connection is made for disabled servers.
    await expect(registry.connectServer(serverId)).rejects.toThrow(/disabled/);

    await registry.setServerEnabled(serverId, true);
    await registry.connectServer(serverId);
  });

  it("denies when the policy provider rejects the tool", async () => {
    const runtime = new ToolRuntime({ tools: await registry.listVisibleToolDefinitions(QUERY) });
    policyDenied = true;

    expect(await registry.isToolVisible(serverId, "echo", QUERY)).toBe(false);
    const result = await runtime.execute("echo", { ok: 1 }, context());
    expect(result.success).toBe(false);
    expect(client.requestCount("echo")).toBe(1);

    policyDenied = false;
  });

  it("ANDs federation grants with the agent tool allowlist (no bypass)", async () => {
    const excludedQuery = { ...QUERY, agentToolAllowlist: ["some_native_tool"] };
    expect(await registry.isToolVisible(serverId, "echo", excludedQuery)).toBe(false);
    expect(await registry.listVisibleToolDefinitions(excludedQuery)).toEqual([]);

    const allowedQuery = { ...QUERY, agentToolAllowlist: ["some_native_tool", "echo"] };
    expect(await registry.isToolVisible(serverId, "echo", allowedQuery)).toBe(true);
    expect((await registry.listVisibleToolDefinitions(allowedQuery)).map((d) => d.name)).toEqual([
      "echo"
    ]);

    // A stale ToolDefinition built under a wider allowlist is denied when the
    // query object narrows.
    const mutableQuery = { ...QUERY, agentToolAllowlist: ["echo"] as string[] };
    const runtime = new ToolRuntime({
      tools: await registry.listVisibleToolDefinitions(mutableQuery)
    });
    mutableQuery.agentToolAllowlist = [];
    const result = await runtime.execute("echo", { ok: 1 }, context());
    expect(result.success).toBe(false);
    expect(client.requestCount("echo")).toBe(1);
  });

  it("gates approval before any request when policy requires it", async () => {
    let approve = false;
    const decisions: string[] = [];
    const approvalStore = new InMemoryMCPRegistryStore();
    const approvalClient = new CountingMCPClient(new StdioMCPClient());
    const approvalRegistry = new PersistentMCPRegistry({
      client: approvalClient,
      store: approvalStore,
      policyProvider: (_server, tool) =>
        tool.name === "echo"
          ? { riskLevel: "MEDIUM", requiresApproval: true }
          : { riskLevel: "LOW", requiresApproval: false },
      approvalGate: async (toolContext) => {
        decisions.push(toolContext.actor);
        return approve;
      }
    });

    const created = await approvalRegistry.createServer({ ...fakeServerStdio(), enabled: true });
    const tools = await approvalRegistry.connectAndDiscover(created.id);
    const echo = tools.find((tool) => tool.name === "echo")!;
    await approvalRegistry.setToolEnabled(echo.id, true);
    await approvalRegistry.bindProject({ projectId: PROJECT, serverId: created.id });
    await approvalRegistry.bindAgent({
      projectId: PROJECT,
      agentName: AGENT,
      serverId: created.id
    });

    const runtime = new ToolRuntime({
      tools: await approvalRegistry.listVisibleToolDefinitions(QUERY)
    });

    const denied = await runtime.execute("echo", { ok: 1 }, context());
    expect(denied.success).toBe(false);
    expect((denied.error?.details as Record<string, unknown>)?.mcpErrorCategory).toBe(
      "APPROVAL_REQUIRED"
    );
    expect(approvalClient.requestCount("echo")).toBe(0);
    expect(decisions).toEqual([AGENT]);

    approve = true;
    const allowed = await runtime.execute("echo", { ok: 1 }, context());
    expect(allowed.success).toBe(true);
    expect(approvalClient.requestCount("echo")).toBe(1);

    const pid = approvalClient.pidOf(created.id)!;
    await approvalRegistry.disconnectServer(created.id);
    await waitForProcessExit(pid, 3000);
  });

  it("restores state after a restart and keeps revocations revoked", async () => {
    // Revoke the agent binding BEFORE the restart: it must stay revoked.
    await registry.unbindAgent(PROJECT, AGENT, serverId);

    const restartedClient = new CountingMCPClient(new StdioMCPClient());
    const restarted = new PersistentMCPRegistry({ client: restartedClient, store });

    const outcome = await restarted.initialize();
    expect(outcome.connected).toEqual([serverId]);
    expect(outcome.failed).toEqual([]);

    // Persisted tools survived: no re-discovery happened.
    expect((await restarted.listTools(serverId)).length).toBe(3);
    // Revoked binding still revoked after restart.
    expect(await restarted.isToolVisible(serverId, "echo", QUERY)).toBe(false);

    // Re-grant and execute against the restarted registry.
    await restarted.bindAgent({ projectId: PROJECT, agentName: AGENT, serverId });
    const defs = await restarted.listVisibleToolDefinitions(QUERY);
    expect(defs.map((definition) => definition.name).sort()).toEqual(["echo"]);
    const runtime = new ToolRuntime({ tools: defs });
    const result = await runtime.execute("echo", { after: "restart" }, context());
    expect(result.success).toBe(true);
    expect(restartedClient.requestCount("echo")).toBe(1);

    const pid = restartedClient.pidOf(serverId)!;
    await restarted.disconnectServer(serverId);
    await waitForProcessExit(pid, 3000);
  });

  it("excludes slow from the visible set when the agent binding is tool-scoped", async () => {
    await registry.setToolEnabled(slowId, true);
    await registry.bindAgent({
      projectId: PROJECT,
      agentName: AGENT,
      serverId,
      toolNames: ["echo"]
    });

    const defs = await registry.listVisibleToolDefinitions(QUERY);
    expect(defs.map((definition) => definition.name)).toEqual(["echo"]);
    expect(await registry.isToolVisible(serverId, "slow", QUERY)).toBe(false);
    expect(client.requestCount("slow")).toBe(0);
  });
});

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
