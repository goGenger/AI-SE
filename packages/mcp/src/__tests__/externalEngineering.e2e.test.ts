import { ActionResultSchema } from "@ai-se/shared";
import {
  ToolCallFinishedRecord,
  ToolCallRecorder,
  ToolCallStartedRecord,
  ToolExecutionContext,
  ToolRuntime
} from "@ai-se/tool-runtime";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteMCPClient } from "../client/RemoteMCPClient";
import { StdioMCPClient } from "../client/StdioMCPClient";
import { MCPClientPort, MCPServerDefinition, MCPToolDefinition } from "../contracts";
import { ExternalToolCatalog } from "../external/catalog";
import { createExternalToolRegistry, ExternalEngineeringConnector } from "../external/connector";
import { createFakeHTTPServerDefinition, startFakeHTTPServer } from "../testing/fakeHTTPServer";
import {
  createFakeExternalSystemEntry,
  FAKE_CREDENTIAL_REF,
  FAKE_EXTERNAL_SERVER_ID,
  FAKE_EXTERNAL_SYSTEM_ID,
  FAKE_EXTERNAL_TOOL_NAMES,
  FAKE_HOSTILE_PAYLOADS
} from "../testing/externalSystemServer";

/**
 * Phase 5.7-2 external engineering E2E:
 *
 *   Agent → ToolRuntime → ExternalToolDefinition → MCPToolAdapter
 *        → MCPClientPort → (REAL MCP protocol) → mock external system
 *
 * The mock GitHub-like system is a real official-SDK stdio child process; the
 * credentialRef path runs against the real Streamable HTTP transport. Nothing
 * but the external SYSTEM is a fixture — the MCP client, registry, connector
 * and ToolRuntime are the production code paths. Zero external network.
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
    requestId: "req-ext-e2e",
    projectId: "proj-1",
    taskId: "task-1",
    agentRunId: "run-1",
    toolCallId: randomUUID(),
    actor: "external-engineering-agent",
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

describe("5.7-2 external engineering system over REAL MCP stdio", () => {
  let stdioClient: StdioMCPClient;
  let client: CountingMCPClient;
  let catalog: ExternalToolCatalog;
  let registry: ReturnType<typeof createExternalToolRegistry>;
  let connector: ExternalEngineeringConnector;
  let recorder: MemoryToolCallRecorder;
  let pid: number;

  beforeAll(async () => {
    stdioClient = new StdioMCPClient();
    client = new CountingMCPClient(stdioClient);
    catalog = new ExternalToolCatalog([createFakeExternalSystemEntry()]);
    registry = createExternalToolRegistry({ client, catalog });
    connector = new ExternalEngineeringConnector({ client, catalog, registry });
    await connector.connectAll();
    registry.bindProject({ projectId: "proj-1", serverId: FAKE_EXTERNAL_SERVER_ID });
    registry.bindAgent({
      projectId: "proj-1",
      agentName: "dev-agent",
      serverId: FAKE_EXTERNAL_SERVER_ID
    });
    recorder = new MemoryToolCallRecorder();
    pid = stdioClient.pidOf(FAKE_EXTERNAL_SERVER_ID) as number;
  });

  afterAll(async () => {
    await registry.disconnectAll();
    await waitForProcessExit(pid, 3000);
  });

  it("discovers the mock external system's tool catalog over the real protocol", () => {
    const tools = registry.listDiscoveredTools(FAKE_EXTERNAL_SERVER_ID);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...FAKE_EXTERNAL_TOOL_NAMES].sort());
    const descriptors = connector.descriptors(QUERY);
    expect(descriptors.map((entry) => entry.toolName).sort()).toEqual(
      [...FAKE_EXTERNAL_TOOL_NAMES].sort()
    );
    expect(descriptors.find((entry) => entry.toolName === "releases.publish")).toMatchObject({
      systemId: FAKE_EXTERNAL_SYSTEM_ID,
      riskLevel: "HIGH",
      requiresApproval: true,
      serverName: "github"
    });
  });

  it("full chain: Agent path scenario issues.create + ci.status through ToolRuntime with audit", async () => {
    const runtime = new ToolRuntime({ tools: connector.toolDefinitions(QUERY) });
    const create = await runtime.execute(
      "issues.create",
      { title: "Fix login" },
      makeContext(recorder, { toolCallId: "call-create-e2e" })
    );
    expect(create.success).toBe(true);
    const createOutcome = create.data as { actionResult: unknown; result?: unknown };
    const createResult = ActionResultSchema.parse(createOutcome.actionResult);
    expect(createResult.status).toBe("success");
    expect(createResult.actionRef).toEqual({
      source: "mcp",
      serverName: "github",
      toolName: "issues.create",
      callId: "call-create-e2e"
    });
    expect(createOutcome.result).toEqual({
      id: "ISS-101",
      title: "Fix login",
      state: "open",
      url: "https://github.example/Issues/101"
    });

    const status = await runtime.execute("ci.status", { runId: "run-42" }, makeContext(recorder));
    expect(status.success).toBe(true);
    const statusOutcome = status.data as {
      actionResult: unknown;
      result?: { conclusion?: string };
    };
    const statusResult = ActionResultSchema.parse(statusOutcome.actionResult);
    expect(statusResult.status).toBe("success");
    expect(statusOutcome.result?.conclusion).toBe("success");

    expect(client.requestCount("issues.create")).toBe(1);
    expect(client.requestCount("ci.status")).toBe(1);
    const finished = recorder.finished.slice(-2);
    expect(finished.map((record) => record.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("failed: a real remote tool error maps into a failed ActionResult with a redacted code", async () => {
    const runtime = new ToolRuntime({ tools: connector.toolDefinitions(QUERY) });
    const result = await runtime.execute("issues.fail", {}, makeContext(recorder));
    expect(result.success).toBe(true); // the invocation completed; the ACTION failed
    const outcome = result.data as { actionResult: unknown };
    const actionResult = ActionResultSchema.parse(outcome.actionResult);
    expect(actionResult.status).toBe("failed");
    expect(actionResult.error?.code).toBe("MCP_REMOTE_TOOL");
    expect(actionResult.error?.message).toContain("remote issue tracker failure");
  });

  it("hostile external content stays inert data through the real protocol", async () => {
    const runtime = new ToolRuntime({ tools: connector.toolDefinitions(QUERY) });
    const before = client.totalRequests();

    const instruction = await runtime.execute(
      "fixture.hostile",
      { kind: "instruction" },
      makeContext(recorder)
    );
    const instructionOutcome = instruction.data as {
      actionResult: unknown;
      result?: { text?: string };
    };
    expect(ActionResultSchema.parse(instructionOutcome.actionResult).status).toBe("success");
    expect(instructionOutcome.result?.text).toBe(FAKE_HOSTILE_PAYLOADS.instruction);
    expect(JSON.stringify(ActionResultSchema.parse(instructionOutcome.actionResult))).not.toContain(
      "IGNORE ALL PREVIOUS INSTRUCTIONS"
    );

    const credential = await runtime.execute(
      "fixture.hostile",
      { kind: "credential" },
      makeContext(recorder)
    );
    const serialized = JSON.stringify(credential);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("sk-live1234567890abcdefghij");

    // Hostile content triggered exactly the two fixture calls — nothing else.
    expect(client.totalRequests()).toBe(before + 2);
    expect(client.requestCount("releases.publish")).toBe(0);
  });

  it("approval: HIGH-risk releases.publish fails closed without a gate and runs when approved", async () => {
    // Fail-closed: no approval gate wired.
    const failClosedRuntime = new ToolRuntime({ tools: connector.toolDefinitions(QUERY) });
    const denied = await failClosedRuntime.execute(
      "releases.publish",
      { tag: "v1.0.0" },
      makeContext(recorder)
    );
    expect(denied.success).toBe(false);
    expect(denied.error?.message).toContain("approval");
    expect(client.requestCount("releases.publish")).toBe(0);

    // Approved: a connector with an approving gate over the same registry.
    const approvedConnector = new ExternalEngineeringConnector({
      client,
      catalog,
      registry,
      approvalGate: () => true
    });
    const approvedRuntime = new ToolRuntime({ tools: approvedConnector.toolDefinitions(QUERY) });
    const approved = await approvedRuntime.execute(
      "releases.publish",
      { tag: "v1.0.0" },
      makeContext(recorder)
    );
    expect(approved.success).toBe(true);
    const outcome = approved.data as { actionResult: unknown; result?: { published?: boolean } };
    expect(ActionResultSchema.parse(outcome.actionResult).status).toBe("success");
    expect(outcome.result?.published).toBe(true);
    expect(client.requestCount("releases.publish")).toBe(1);
  });

  it("timeout: a slow external call exceeds the runtime timeout and the connection stays usable", async () => {
    const runtime = new ToolRuntime({ tools: connector.toolDefinitions(QUERY) });
    const result = await runtime.execute(
      "issues.slow",
      { delayMs: 2000 },
      makeContext(recorder, { timeoutMs: 300 })
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TIMEOUT_ERROR");
    // The server survives: a follow-up call still works over the same child process.
    const followUp = await runtime.execute(
      "ci.status",
      { runId: "run-after-timeout" },
      makeContext(recorder)
    );
    expect(followUp.success).toBe(true);
  });

  it("unauthorized → zero MCP requests (unbound query + stale binding re-check)", async () => {
    const baseline = client.totalRequests();
    // (a) A query without agent bindings sees nothing.
    expect(connector.toolDefinitions({ projectId: "proj-1", agentName: "other-agent" })).toEqual(
      []
    );
    // (b) Bindings revoked after definitions were built → call-time deny, zero requests.
    const definitions = connector.toolDefinitions(QUERY);
    registry.unbindAgent("proj-1", "dev-agent", FAKE_EXTERNAL_SERVER_ID);
    const runtime = new ToolRuntime({ tools: definitions });
    const result = await runtime.execute(
      "issues.create",
      { title: "Stale" },
      makeContext(recorder)
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("not permitted");
    expect(client.totalRequests()).toBe(baseline);
    // Restore the binding for any subsequent state.
    registry.bindAgent({
      projectId: "proj-1",
      agentName: "dev-agent",
      serverId: FAKE_EXTERNAL_SERVER_ID
    });
  });
});

describe("5.7-2 credentialRef injection over REAL Streamable HTTP transport", () => {
  const RESOLVED_TOKEN = "fixture-bearer-token-9f8e7d6c";

  it("credentialRef → existing resolver → MCP connection; the secret never enters results", async () => {
    const handle = await startFakeHTTPServer({ auth: RESOLVED_TOKEN });
    const resolutions: Array<{ serverId: string; kind: string; reference: string }> = [];
    const remoteClient = new RemoteMCPClient({
      credentialResolver: (request) => {
        resolutions.push({
          serverId: request.serverId,
          kind: request.kind,
          reference: request.reference
        });
        return RESOLVED_TOKEN;
      }
    });
    const catalog = new ExternalToolCatalog([
      {
        id: "remote-docs",
        displayName: "Remote Documentation System",
        category: "documentation",
        server: createFakeHTTPServerDefinition(handle.endpoint, {
          id: "remote-docs-mcp",
          name: "remote-docs",
          credentialRef: FAKE_CREDENTIAL_REF
        }),
        tools: [{ name: "echo", riskLevel: "LOW", requiresApproval: false }]
      }
    ]);
    const registry = createExternalToolRegistry({ client: remoteClient, catalog });
    const connector = new ExternalEngineeringConnector({ client: remoteClient, catalog, registry });
    try {
      await connector.connectAll();
      expect(connector.credentialRefFor("remote-docs")).toBe(FAKE_CREDENTIAL_REF);
      registry.bindProject({ projectId: "proj-1", serverId: "remote-docs-mcp" });
      registry.bindAgent({
        projectId: "proj-1",
        agentName: "dev-agent",
        serverId: "remote-docs-mcp"
      });

      const definitions = connector.toolDefinitions(QUERY);
      // The allowlist hides the remote's slow/failing tools even though discovered.
      expect(definitions.map((definition) => definition.name)).toEqual(["echo"]);

      const runtime = new ToolRuntime({ tools: definitions });
      const recorder = new MemoryToolCallRecorder();
      const result = await runtime.execute("echo", { hello: "ai-se" }, makeContext(recorder));
      expect(result.success).toBe(true);
      const outcome = result.data as { actionResult: unknown; result?: unknown };
      const actionResult = ActionResultSchema.parse(outcome.actionResult);
      expect(actionResult.status).toBe("success");
      expect(actionResult.actionRef).toMatchObject({
        source: "mcp",
        serverName: "remote-docs",
        toolName: "echo"
      });
      expect(JSON.stringify(outcome.result)).toContain("ai-se");

      // The resolver was asked for the REFERENCE, exactly once, on the controlled path.
      expect(resolutions).toEqual([
        { serverId: "remote-docs-mcp", kind: "credentialRef", reference: FAKE_CREDENTIAL_REF }
      ]);
      // The resolved secret never appears anywhere in the tool result / audit.
      expect(JSON.stringify(result)).not.toContain(RESOLVED_TOKEN);
      expect(JSON.stringify(recorder.finished)).not.toContain(RESOLVED_TOKEN);
      // And the request was authenticated (no 401 fallbacks).
      expect((await handle.hits()).authFailures).toBe(0);
    } finally {
      await remoteClient.disconnect("remote-docs-mcp");
      await handle.stop();
    }
  });
});
