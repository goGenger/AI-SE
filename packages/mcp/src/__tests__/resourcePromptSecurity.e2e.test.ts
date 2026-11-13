import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCPClientError } from "../client/MCPClientError";
import { StdioMCPClient } from "../client/StdioMCPClient";
import type {
  MCPClientPort,
  MCPPromptDescriptor,
  MCPPromptResult,
  MCPResourceDescriptor,
  MCPResourceReadResult,
  MCPServerDefinition,
  MCPToolDefinition
} from "../contracts";
import { createMCPResourceAdapter } from "../integration/resourceAdapter";
import { InMemoryMCPRegistryStore } from "../registry/inMemoryStore";
import { PersistentMCPRegistry } from "../registry/persistentRegistry";
import {
  FAKE_GREETING_TEXT,
  FAKE_RESOURCE_URIS,
  createFakeMCPServerDefinition
} from "../testing/fakeMCPServer";

/**
 * Phase 5.5-6 security matrix: capability (resource/prompt) authorization is
 * the SAME store-backed chain as tools, with zero MCP requests for every
 * denied operation (proven with a counting client around the real stdio SDK
 * client). Tool-scoped grants never authorize capabilities; a revocation
 * takes effect on the very next call and nothing is cached.
 */

class CapabilityCountingClient implements MCPClientPort {
  resourcesListCalls = 0;
  resourceReadCalls = 0;
  promptsListCalls = 0;
  promptGetCalls = 0;

  constructor(private readonly delegate: StdioMCPClient) {}

  async connect(server: MCPServerDefinition): Promise<void> {
    return await this.delegate.connect(server);
  }
  async disconnect(serverId: string): Promise<void> {
    return await this.delegate.disconnect(serverId);
  }
  async listTools(serverId: string): Promise<MCPToolDefinition[]> {
    return await this.delegate.listTools(serverId);
  }
  async callTool(serverId: string, name: string, input: unknown, signal?: AbortSignal) {
    return await this.delegate.callTool(serverId, name, input, signal);
  }
  async listResources(serverId: string): Promise<MCPResourceDescriptor[]> {
    this.resourcesListCalls += 1;
    return await this.delegate.listResources(serverId);
  }
  async readResource(
    serverId: string,
    uri: string,
    signal?: AbortSignal
  ): Promise<MCPResourceReadResult> {
    this.resourceReadCalls += 1;
    return await this.delegate.readResource(serverId, uri, signal);
  }
  async listPrompts(serverId: string): Promise<MCPPromptDescriptor[]> {
    this.promptsListCalls += 1;
    return await this.delegate.listPrompts(serverId);
  }
  async getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<MCPPromptResult> {
    this.promptGetCalls += 1;
    return await this.delegate.getPrompt(serverId, name, args, signal);
  }
  pidOf(serverId: string): number | null {
    return this.delegate.pidOf(serverId);
  }
}

const PROJECT = "project-1";
const AGENT = "agent-1";

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

async function denialOf(run: () => Promise<unknown>): Promise<MCPClientError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(MCPClientError);
    return error as MCPClientError;
  }
  throw new Error("Expected capability access to be denied");
}

describe("capability security: grants, revocation and zero-request denials", () => {
  let client: CapabilityCountingClient;
  let stdio: StdioMCPClient;
  let store: InMemoryMCPRegistryStore;
  let registry: PersistentMCPRegistry;
  let serverId: string;

  const query = () => ({ projectId: PROJECT, agentName: AGENT });

  beforeAll(async () => {
    stdio = new StdioMCPClient();
    client = new CapabilityCountingClient(stdio);
    store = new InMemoryMCPRegistryStore();
    registry = new PersistentMCPRegistry({ client, store });

    const fake = createFakeMCPServerDefinition();
    const server = await registry.createServer({
      name: fake.name,
      stdio: { command: fake.stdio!.command, args: fake.stdio!.args },
      enabled: true
    });
    serverId = server.id;
    await registry.connectServer(serverId);
    // Tool rows exist so tool-scoped grants can be created (they must NOT
    // authorize capabilities); tools themselves stay disabled.
    await store.upsertDiscoveredTools(serverId, [
      { name: "echo", description: "", inputSchema: {} }
    ]);
  });

  afterAll(async () => {
    // The disable-path test reconnected the server, so re-read the live pid.
    const finalPid = stdio.pidOf(serverId);
    await registry.disconnectServer(serverId).catch(() => undefined);
    if (finalPid) await waitForProcessExit(finalPid, 3000).catch(() => undefined);
  });

  it("denies without any grant — zero MCP requests", async () => {
    expect(await registry.listVisibleResources(serverId, query())).toEqual([]);
    expect(await registry.listVisiblePrompts(serverId, query())).toEqual([]);
    const read = await denialOf(() =>
      registry.readResource(serverId, FAKE_RESOURCE_URIS.greeting, query())
    );
    expect(read.mcpErrorCategory).toBe("PERMISSION_DENIED");
    const prompt = await denialOf(() =>
      registry.getPrompt(serverId, "welcome", undefined, query())
    );
    expect(prompt.mcpErrorCategory).toBe("PERMISSION_DENIED");
    // Missing query fields are a denial too.
    await denialOf(() => registry.readResource(serverId, FAKE_RESOURCE_URIS.greeting, {}));

    expect(client.resourcesListCalls).toBe(0);
    expect(client.resourceReadCalls).toBe(0);
    expect(client.promptsListCalls).toBe(0);
    expect(client.promptGetCalls).toBe(0);
  });

  it("requires BOTH the project and the agent server-scope grant", async () => {
    await store.createBinding({ projectId: PROJECT, serverId });
    expect(await registry.listVisibleResources(serverId, query())).toEqual([]);
    await denialOf(() => registry.readResource(serverId, FAKE_RESOURCE_URIS.greeting, query()));
    expect(client.resourceReadCalls).toBe(0);
  });

  it("never lets a TOOL-scoped grant authorize resources or prompts", async () => {
    const toolScoped = await store.createBinding({
      projectId: PROJECT,
      serverId,
      agentName: AGENT,
      toolName: "echo"
    });
    expect(await registry.listVisibleResources(serverId, query())).toEqual([]);
    await denialOf(() => registry.readResource(serverId, FAKE_RESOURCE_URIS.greeting, query()));
    await denialOf(() => registry.getPrompt(serverId, "welcome", undefined, query()));
    expect(client.resourceReadCalls).toBe(0);
    expect(client.promptGetCalls).toBe(0);

    await store.deleteBinding(toolScoped.id);
  });

  it("serves resources and prompts once both server-scope grants exist", async () => {
    await store.createBinding({ projectId: PROJECT, serverId, agentName: AGENT });

    const resources = await registry.listVisibleResources(serverId, query());
    expect(resources.map((resource) => resource.name).sort()).toEqual([
      "binary",
      "counter",
      "greeting",
      "leaky",
      "malformed",
      "slow"
    ]);
    expect(client.resourcesListCalls).toBe(1);

    const greeting = await registry.readResource(serverId, FAKE_RESOURCE_URIS.greeting, query());
    expect(greeting.contents[0].text).toBe(FAKE_GREETING_TEXT);
    expect(client.resourceReadCalls).toBe(1);

    const prompts = await registry.listVisiblePrompts(serverId, query());
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      "attach",
      "code_review",
      "welcome"
    ]);
    expect(client.promptsListCalls).toBe(1);

    const welcome = await registry.getPrompt(serverId, "welcome", undefined, query());
    expect(welcome.messages.length).toBe(1);
    expect(client.promptGetCalls).toBe(1);
  });

  it("revocation takes effect on the next call — zero requests after revoke", async () => {
    const agentRow = (await store.listBindings({ projectId: PROJECT, serverId })).find(
      (binding) => binding.agentName === AGENT
    )!;
    await store.deleteBinding(agentRow.id);

    expect(await registry.listVisibleResources(serverId, query())).toEqual([]);
    await denialOf(() => registry.readResource(serverId, FAKE_RESOURCE_URIS.greeting, query()));
    await denialOf(() => registry.getPrompt(serverId, "welcome", undefined, query()));
    expect(client.resourcesListCalls).toBe(1); // unchanged since the granted call
    expect(client.resourceReadCalls).toBe(1);
    expect(client.promptGetCalls).toBe(1);
  });

  it("re-checks access at call time even on an adapter built while granted", async () => {
    let allowed = true;
    const adapter = createMCPResourceAdapter(client, serverId, {
      canAccess: () => allowed
    });

    await adapter.readResource(FAKE_RESOURCE_URIS.greeting);
    expect(client.resourceReadCalls).toBe(2);

    allowed = false;
    const denied = await denialOf(() => adapter.readResource(FAKE_RESOURCE_URIS.greeting));
    expect(denied.mcpErrorCategory).toBe("PERMISSION_DENIED");
    expect(client.resourceReadCalls).toBe(2); // zero new requests
  });

  it("denies everything while the server is disabled (and after REVOKED)", async () => {
    await store.createBinding({ projectId: PROJECT, serverId, agentName: AGENT });
    expect((await registry.listVisibleResources(serverId, query())).length).toBe(6);

    await registry.setServerEnabled(serverId, false);
    expect(await registry.listVisibleResources(serverId, query())).toEqual([]);
    await denialOf(() => registry.readResource(serverId, FAKE_RESOURCE_URIS.greeting, query()));
    const readCalls = client.resourceReadCalls;

    await store.updateServer(serverId, { status: "REVOKED" });
    await registry.setServerEnabled(serverId, true);
    expect(await registry.listVisibleResources(serverId, query())).toEqual([]);
    await denialOf(() => registry.readResource(serverId, FAKE_RESOURCE_URIS.greeting, query()));
    expect(client.resourceReadCalls).toBe(readCalls);

    // Restore: enabled + CONNECTED + a live connection for the tests below.
    await store.updateServer(serverId, { status: "CONNECTED" });
    await registry.connectServer(serverId);
  });

  it("policy providers deny per resource/prompt — reads and gets stay zero-request", async () => {
    const policyRegistry = new PersistentMCPRegistry({
      client,
      store,
      resourcePolicyProvider: (_server, resource) =>
        resource.uri === FAKE_RESOURCE_URIS.binary ? undefined : { riskLevel: "LOW" },
      promptPolicyProvider: (_server, prompt) =>
        prompt.name === "attach" ? undefined : { riskLevel: "LOW" }
    });

    const resources = await policyRegistry.listVisibleResources(serverId, query());
    expect(resources.map((resource) => resource.name).sort()).toEqual([
      "counter",
      "greeting",
      "leaky",
      "malformed",
      "slow"
    ]);

    const reads = client.resourceReadCalls;
    const deniedRead = await denialOf(() =>
      policyRegistry.readResource(serverId, FAKE_RESOURCE_URIS.binary, query())
    );
    expect(deniedRead.mcpErrorCategory).toBe("PERMISSION_DENIED");
    expect(client.resourceReadCalls).toBe(reads); // zero requests for the denied read

    await policyRegistry.readResource(serverId, FAKE_RESOURCE_URIS.greeting, query());
    expect(client.resourceReadCalls).toBe(reads + 1);

    const prompts = await policyRegistry.listVisiblePrompts(serverId, query());
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(["code_review", "welcome"]);

    const gets = client.promptGetCalls;
    const deniedGet = await denialOf(() =>
      policyRegistry.getPrompt(serverId, "attach", undefined, query())
    );
    expect(deniedGet.mcpErrorCategory).toBe("PERMISSION_DENIED");
    expect(client.promptGetCalls).toBe(gets);

    await policyRegistry.getPrompt(serverId, "code_review", { language: "TS", code: "x" }, query());
    expect(client.promptGetCalls).toBe(gets + 1);
  });
});
