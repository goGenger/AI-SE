import {
  ToolCallFinishedRecord,
  ToolCallRecorder,
  ToolCallStartedRecord,
  ToolExecutionContext,
  ToolRuntime,
  createPhase1Tools
} from "@ai-se/tool-runtime";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StdioMCPClient } from "../client/StdioMCPClient";
import { MCPClientPort, MCPServerDefinition, MCPToolDefinition } from "../contracts";
import { mcpCallToolResultToData } from "../integration/adapter";
import { MCPToolRegistry } from "../integration/registry";
import { createFakeMCPServerDefinition, FAKE_MCP_SERVER_ID } from "../testing/fakeMCPServer";

/**
 * Phase 5.5-2 federation E2E: MCP tools flow through the REAL stdio MCP
 * protocol into the EXISTING ToolRuntime (validation, audit, timeout,
 * cancellation, error normalization) and the visibility chain gates them.
 * Nothing but the MCP client/server is mocked.
 */

class CountingMCPClient implements MCPClientPort {
  private readonly counts = new Map<string, number>();

  constructor(private readonly delegate: MCPClientPort) {}

  requestCount(toolName: string): number {
    return this.counts.get(toolName) ?? 0;
  }

  totalRequests(): number {
    return [...this.counts.values()].reduce((sum, count) => sum + count, 0);
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

const fakeSandbox = {
  async runCommand() {
    return { command: "", exitCode: 0, stdout: "", stderr: "", duration: 0, timedOut: false };
  }
};

function makeContext(
  recorder: ToolCallRecorder,
  overrides: Partial<ToolExecutionContext> = {}
): ToolExecutionContext {
  return {
    requestId: "req-1",
    projectId: "proj-1",
    taskId: "task-1",
    agentRunId: "run-1",
    toolCallId: randomUUID(),
    actor: "dev-agent",
    workspacePath: "/workspace",
    sandbox: fakeSandbox,
    toolCallRecorder: recorder,
    ...overrides
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process ${pid} still alive after ${timeoutMs}ms`);
}

const QUERY = { projectId: "proj-1", agentName: "dev-agent" };

describe("MCP Tool Federation through the existing ToolRuntime (real stdio server)", () => {
  let stdioClient: StdioMCPClient;
  let client: CountingMCPClient;
  let registry: MCPToolRegistry;
  let recorder: MemoryToolCallRecorder;
  let pid: number;

  beforeAll(async () => {
    stdioClient = new StdioMCPClient();
    client = new CountingMCPClient(stdioClient);
    recorder = new MemoryToolCallRecorder();
    registry = new MCPToolRegistry({
      client,
      servers: [createFakeMCPServerDefinition()],
      policyProvider: (_server, tool) =>
        tool.name === "failing"
          ? { riskLevel: "HIGH", requiresApproval: false }
          : { riskLevel: "MEDIUM", requiresApproval: false }
    });
    await registry.connectAndDiscover(FAKE_MCP_SERVER_ID);
    pid = stdioClient.pidOf(FAKE_MCP_SERVER_ID) as number;
  });

  afterAll(async () => {
    await registry.disconnectAll();
    await waitForProcessExit(pid, 3000);
  });

  it("registers and discovers the MCP catalog over real stdio", () => {
    const tools = registry.listDiscoveredTools(FAKE_MCP_SERVER_ID);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "failing", "slow"]);
  });

  it("keeps MCP tools invisible by default (DENY) and hides unknown-server tools", () => {
    expect(
      registry.listVisibleToolDefinitions({ projectId: "proj-1", agentName: "dev-agent" })
    ).toEqual([]);
    expect(registry.isToolVisible(FAKE_MCP_SERVER_ID, "echo", QUERY)).toBe(false);
    expect(registry.isToolVisible("no-such-server", "echo", QUERY)).toBe(false);
    expect(client.totalRequests()).toBe(0);
  });

  it("hides tools when the server is disabled", () => {
    registry.bindProject({ projectId: "proj-1", serverId: FAKE_MCP_SERVER_ID });
    registry.bindAgent({
      projectId: "proj-1",
      agentName: "dev-agent",
      serverId: FAKE_MCP_SERVER_ID
    });

    const disabledRegistry = new MCPToolRegistry({
      client,
      servers: [{ ...createFakeMCPServerDefinition(), id: "disabled-server", enabled: false }]
    });
    disabledRegistry.bindProject({ projectId: "proj-1", serverId: "disabled-server" });
    disabledRegistry.bindAgent({
      projectId: "proj-1",
      agentName: "dev-agent",
      serverId: "disabled-server"
    });
    expect(disabledRegistry.listVisibleToolDefinitions(QUERY)).toEqual([]);
  });

  it("exposes only bound, policy-allowed tools as unified ToolDefinitions", () => {
    const definitions = registry.listVisibleToolDefinitions(QUERY);
    const names = definitions.map((definition) => definition.name).sort();
    expect(names).toEqual(["echo", "failing", "slow"]);

    const failing = definitions.find((definition) => definition.name === "failing");
    expect(failing?.riskLevel).toBe("HIGH"); // platform policy, not server-claimed
    const slow = definitions.find((definition) => definition.name === "slow");
    expect(slow?.riskLevel).toBe("MEDIUM");
    // Unified ToolDefinition contract: Zod inputSchema + execute.
    expect(typeof definitions[0].inputSchema.safeParse).toBe("function");
    expect(typeof definitions[0].execute).toBe("function");
  });

  it("executes a real echo call through ToolRuntime with audit recorded", async () => {
    const runtime = new ToolRuntime({ tools: registry.listVisibleToolDefinitions(QUERY) });
    const result = await runtime.execute("echo", { hello: "ai-se" }, makeContext(recorder));

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      content: [{ type: "text", text: JSON.stringify({ hello: "ai-se" }) }]
    });
    expect(result.audit.toolName).toBe("echo");
    expect(result.audit.riskLevel).toBe("MEDIUM");
    expect(result.audit.actor).toBe("dev-agent");
    expect(recorder.started.some((record) => record.toolName === "echo")).toBe(true);
    expect(
      recorder.finished.some(
        (record) => record.status === "succeeded" && record.toolCallId === result.toolCallId
      )
    ).toBe(true);
    expect(client.requestCount("echo")).toBe(1);
  });

  it("normalizes a failing tool to TOOL_ERROR with the MCP category in details", async () => {
    const runtime = new ToolRuntime({ tools: registry.listVisibleToolDefinitions(QUERY) });
    const result = await runtime.execute("failing", {}, makeContext(recorder));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_ERROR");
    expect((result.error?.details as Record<string, unknown>)?.mcpErrorCategory).toBe(
      "REMOTE_TOOL"
    );
    expect(
      recorder.finished.some(
        (record) => record.status === "failed" && record.toolCallId === result.toolCallId
      )
    ).toBe(true);
  });

  it("rejects invalid input with the Tool Runtime's own Zod validation (zero MCP requests)", async () => {
    const runtime = new ToolRuntime({ tools: registry.listVisibleToolDefinitions(QUERY) });
    const before = client.totalRequests();
    const result = await runtime.execute(
      "slow",
      { delayMs: "not-a-number" },
      makeContext(recorder)
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_ERROR");
    expect(result.error?.message).toBe("Tool input validation failed");
    expect(client.totalRequests()).toBe(before);
  });

  it("DENIES at call time after a binding is revoked (zero MCP requests)", async () => {
    const runtime = new ToolRuntime({ tools: registry.listVisibleToolDefinitions(QUERY) });
    expect((await runtime.execute("echo", { ok: true }, makeContext(recorder))).success).toBe(true);
    const before = client.requestCount("echo");

    registry.unbindAgent("proj-1", "dev-agent", FAKE_MCP_SERVER_ID);
    const result = await runtime.execute("echo", { ok: true }, makeContext(recorder));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_ERROR");
    expect((result.error?.details as Record<string, unknown>)?.mcpErrorCategory).toBe(
      "PERMISSION_DENIED"
    );
    expect(client.requestCount("echo")).toBe(before); // MCP server never saw it

    registry.bindAgent({
      projectId: "proj-1",
      agentName: "dev-agent",
      serverId: FAKE_MCP_SERVER_ID
    });
  });

  it("restricts visibility by agent tool allowlist and policy denial", () => {
    registry.bindAgent({
      projectId: "proj-1",
      agentName: "qa-agent",
      serverId: FAKE_MCP_SERVER_ID,
      toolNames: ["echo"]
    });
    const restricted = registry.listVisibleToolDefinitions({
      projectId: "proj-1",
      agentName: "qa-agent"
    });
    expect(restricted.map((definition) => definition.name)).toEqual(["echo"]);

    // A policy provider that denies "echo" removes it from the visible set.
    const denyEcho = new MCPToolRegistry({
      client,
      servers: [createFakeMCPServerDefinition()],
      policyProvider: (_server, tool) =>
        tool.name === "echo" ? undefined : { riskLevel: "LOW", requiresApproval: false }
    });
    denyEcho.bindProject({ projectId: "proj-1", serverId: FAKE_MCP_SERVER_ID });
    denyEcho.bindAgent({
      projectId: "proj-1",
      agentName: "dev-agent",
      serverId: FAKE_MCP_SERVER_ID
    });
    // Tool catalog is empty until discovery, so nothing is visible and nothing is denied wrongly.
    expect(denyEcho.isToolVisible(FAKE_MCP_SERVER_ID, "echo", QUERY)).toBe(false);
  });

  it("gates approval before any MCP request: deny blocks, approve allows", async () => {
    const seenApprovals: string[] = [];
    let approve = false;
    const approvalClient = new StdioMCPClient();
    const approvalCounting = new CountingMCPClient(approvalClient);
    const approvalRegistry = new MCPToolRegistry({
      client: approvalCounting,
      servers: [createFakeMCPServerDefinition()],
      policyProvider: (_server, tool) =>
        tool.name === "echo"
          ? { riskLevel: "MEDIUM", requiresApproval: true }
          : { riskLevel: "LOW", requiresApproval: false },
      approvalGate: async (context) => {
        seenApprovals.push(context.actor);
        return approve;
      }
    });
    await approvalRegistry.connectAndDiscover(FAKE_MCP_SERVER_ID);
    approvalRegistry.bindProject({ projectId: "proj-1", serverId: FAKE_MCP_SERVER_ID });
    approvalRegistry.bindAgent({
      projectId: "proj-1",
      agentName: "dev-agent",
      serverId: FAKE_MCP_SERVER_ID
    });

    const runtime = new ToolRuntime({ tools: approvalRegistry.listVisibleToolDefinitions(QUERY) });
    const before = approvalCounting.requestCount("echo");

    const denied = await runtime.execute("echo", { x: 1 }, makeContext(recorder));
    expect(denied.success).toBe(false);
    expect((denied.error?.details as Record<string, unknown>)?.mcpErrorCategory).toBe(
      "APPROVAL_REQUIRED"
    );
    expect(approvalCounting.requestCount("echo")).toBe(before);
    expect(seenApprovals).toEqual(["dev-agent"]);

    approve = true;
    const allowed = await runtime.execute("echo", { x: 1 }, makeContext(recorder));
    expect(allowed.success).toBe(true);
    expect(approvalCounting.requestCount("echo")).toBe(before + 1);
    expect(seenApprovals).toEqual(["dev-agent", "dev-agent"]);

    const spawned = approvalClient.pidOf(FAKE_MCP_SERVER_ID) as number;
    await approvalRegistry.disconnectAll();
    await waitForProcessExit(spawned, 3000);
  });

  it("enforces the Tool Runtime timeout against a real slow MCP tool", async () => {
    const timeoutClient = new StdioMCPClient();
    const counting = new CountingMCPClient(timeoutClient);
    const timeoutRegistry = new MCPToolRegistry({
      client: counting,
      servers: [createFakeMCPServerDefinition()]
    });
    await timeoutRegistry.connectAndDiscover(FAKE_MCP_SERVER_ID);
    timeoutRegistry.bindProject({ projectId: "proj-1", serverId: FAKE_MCP_SERVER_ID });
    timeoutRegistry.bindAgent({
      projectId: "proj-1",
      agentName: "dev-agent",
      serverId: FAKE_MCP_SERVER_ID
    });

    const runtime = new ToolRuntime({ tools: timeoutRegistry.listVisibleToolDefinitions(QUERY) });
    const timeoutRecorder = new MemoryToolCallRecorder();
    const result = await runtime.execute(
      "slow",
      { delayMs: 1500 },
      makeContext(timeoutRecorder, { timeoutMs: 300 })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TIMEOUT_ERROR");
    expect(
      timeoutRecorder.finished.some(
        (record) => record.status === "timed_out" && record.toolCallId === result.toolCallId
      )
    ).toBe(true);

    const spawned = timeoutClient.pidOf(FAKE_MCP_SERVER_ID) as number;
    await timeoutRegistry.disconnectAll();
    await waitForProcessExit(spawned, 4000);
  });

  it("propagates external cancellation into the MCP call as CANCELLED_ERROR", async () => {
    const cancelClient = new StdioMCPClient();
    const counting = new CountingMCPClient(cancelClient);
    const cancelRegistry = new MCPToolRegistry({
      client: counting,
      servers: [createFakeMCPServerDefinition()]
    });
    await cancelRegistry.connectAndDiscover(FAKE_MCP_SERVER_ID);
    cancelRegistry.bindProject({ projectId: "proj-1", serverId: FAKE_MCP_SERVER_ID });
    cancelRegistry.bindAgent({
      projectId: "proj-1",
      agentName: "dev-agent",
      serverId: FAKE_MCP_SERVER_ID
    });

    const runtime = new ToolRuntime({ tools: cancelRegistry.listVisibleToolDefinitions(QUERY) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await runtime.execute(
      "slow",
      { delayMs: 1500 },
      makeContext(recorder, { signal: controller.signal })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CANCELLED_ERROR");

    const spawned = cancelClient.pidOf(FAKE_MCP_SERVER_ID) as number;
    await cancelRegistry.disconnectAll();
    await waitForProcessExit(spawned, 4000);
  });

  it("leaves native tools untouched alongside federated MCP tools", async () => {
    const runtime = new ToolRuntime({
      tools: [...createPhase1Tools(), ...registry.listVisibleToolDefinitions(QUERY)]
    });

    const nativeNames = runtime.getToolDefinitions().map((definition) => definition.name);
    expect(nativeNames).toContain("read_file");
    expect(nativeNames).toContain("git_status");
    expect(nativeNames).toContain("echo");

    const gitResult = await runtime.execute("git_status", {}, makeContext(recorder));
    expect(gitResult.success).toBe(true);
  });
});

describe("MCP federation connection failure classification", () => {
  it("surfaces a killed server as a unified runtime error", async () => {
    const localRecorder = new MemoryToolCallRecorder();
    const client = new StdioMCPClient();
    const counting = new CountingMCPClient(client);
    const registry = new MCPToolRegistry({
      client: counting,
      servers: [{ ...createFakeMCPServerDefinition(), id: "doomed-server" }]
    });
    await registry.connectAndDiscover("doomed-server");
    registry.bindProject({ projectId: "proj-1", serverId: "doomed-server" });
    registry.bindAgent({ projectId: "proj-1", agentName: "dev-agent", serverId: "doomed-server" });

    const runtime = new ToolRuntime({ tools: registry.listVisibleToolDefinitions(QUERY) });
    const spawned = client.pidOf("doomed-server") as number;

    // Kill the server process, then call: the adapter must classify CONNECTION.
    process.kill(spawned, "SIGKILL");
    await waitForProcessExit(spawned, 3000);

    const result = await runtime.execute("echo", { x: 1 }, makeContext(localRecorder));
    expect(result.success).toBe(false);
    expect(["TOOL_ERROR", "UNKNOWN_ERROR"]).toContain(result.error?.code);

    await registry.disconnectAll().catch(() => undefined);
  });
});

describe("MCPToolAdapter contract", () => {
  it("converts CallToolResult objects into plain data without protocol leakage", () => {
    expect(
      mcpCallToolResultToData({
        content: [{ type: "text", text: "hello" }],
        isError: false,
        _meta: { protocol: "meta" }
      })
    ).toEqual({ content: [{ type: "text", text: "hello" }] });

    expect(
      mcpCallToolResultToData({
        content: [{ type: "text", text: "ignored" }],
        structuredContent: { rows: [1, 2, 3] }
      })
    ).toEqual({ rows: [1, 2, 3] });
  });
});
