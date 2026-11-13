import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCPClientError } from "../client/MCPClientError";
import { RemoteMCPClient } from "../client/RemoteMCPClient";
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
import { InMemoryMCPRegistryStore } from "../registry/inMemoryStore";
import { PersistentMCPRegistry } from "../registry/persistentRegistry";
import {
  FAKE_MCP_SERVER_ID,
  FAKE_UI_APP_MIME,
  FAKE_UI_APP_URI,
  createFakeMCPServerDefinition
} from "../testing/fakeMCPServer";
import {
  FAKE_HTTP_SERVER_ID,
  createFakeHTTPServerDefinition,
  startFakeHTTPServer
} from "../testing/fakeHTTPServer";
import type { FakeHTTPServerHandle } from "../testing/fakeHTTPServer";

/**
 * Phase 5.5-7 E2E: MCP Apps UI resources over the REAL MCP protocol.
 *
 * - tool `_meta.ui` is normalized into the stable `uiResourceUri` field
 *   (stdio + Streamable HTTP);
 * - `ui://` resources flow through the EXISTING resource architecture
 *   (resources/list, resources/read, capability gates) — nothing bypasses it;
 * - the app-link listing (`listVisibleToolUiLinks`) is gated by the SAME
 *   store-backed chain, with zero MCP requests for every denied call.
 */

class ToolListingCountingClient implements MCPClientPort {
  toolsListCalls = 0;
  callToolCalls = 0;
  resourcesListCalls = 0;
  resourceReadCalls = 0;

  constructor(private readonly delegate: StdioMCPClient) {}

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
  async callTool(serverId: string, name: string, input: unknown, signal?: AbortSignal) {
    this.callToolCalls += 1;
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
    return await this.delegate.listPrompts(serverId);
  }
  async getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<MCPPromptResult> {
    return await this.delegate.getPrompt(serverId, name, args, signal);
  }
  pidOf(serverId: string): number | null {
    return this.delegate.pidOf(serverId);
  }
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

describe("MCP Apps UI resources over real stdio MCP", () => {
  let client: StdioMCPClient;
  let pid: number;

  beforeAll(async () => {
    client = new StdioMCPClient();
    await client.connect(createFakeMCPServerDefinition());
    pid = client.pidOf(FAKE_MCP_SERVER_ID) as number;
  });

  afterAll(async () => {
    await client.disconnect(FAKE_MCP_SERVER_ID);
    await waitForProcessExit(pid, 3000);
  });

  it("normalizes the tool `_meta.ui` link into uiResourceUri", async () => {
    const tools = await client.listTools(FAKE_MCP_SERVER_ID);
    const echo = tools.find((tool) => tool.name === "echo")!;
    expect(echo.uiResourceUri).toBe(FAKE_UI_APP_URI);

    // Tools without _meta.ui carry no link.
    const slow = tools.find((tool) => tool.name === "slow")!;
    expect(slow.uiResourceUri).toBeUndefined();

    // The stable shape is unchanged otherwise.
    expect(Object.keys(echo).sort()).toEqual([
      "description",
      "inputSchema",
      "name",
      "serverId",
      "uiResourceUri"
    ]);
  });

  it("serves the ui:// app through the existing resource architecture", async () => {
    const resources = await client.listResources(FAKE_MCP_SERVER_ID);
    const app = resources.find((resource) => resource.uri === FAKE_UI_APP_URI);
    expect(app).toBeDefined();
    expect(app!.name).toBe("counter");
    expect(app!.mimeType).toBe(FAKE_UI_APP_MIME);

    const read = await client.readResource(FAKE_MCP_SERVER_ID, FAKE_UI_APP_URI);
    expect(read.contents.length).toBe(1);
    expect(read.contents[0].mimeType).toBe(FAKE_UI_APP_MIME);
    // The document is the host-bridge-aware app fixture, plain text/HTML.
    expect(read.contents[0].text).toContain("aiseMcpApp");
    expect(read.contents[0].text).toContain("Counter App");
    expect(read.contents[0].blob).toBeUndefined();
  });

  it("keeps MCP SDK objects internal (no SDK leak on the resource path)", async () => {
    const read = await client.readResource(FAKE_MCP_SERVER_ID, FAKE_UI_APP_URI);
    expect(Object.keys(read.contents[0]).sort()).toEqual(["mimeType", "text", "uri"]);
  });
});

describe("MCP Apps UI resources over real Streamable HTTP MCP", () => {
  let fake: FakeHTTPServerHandle;
  let client: RemoteMCPClient;

  beforeAll(async () => {
    fake = await startFakeHTTPServer({});
    client = new RemoteMCPClient({});
    await client.connect(createFakeHTTPServerDefinition(fake.endpoint));
  });

  afterAll(async () => {
    await client.disconnect(FAKE_HTTP_SERVER_ID).catch(() => undefined);
    await fake.stop();
  });

  it("carries _meta.ui and ui:// resources over Streamable HTTP too", async () => {
    const tools = await client.listTools(FAKE_HTTP_SERVER_ID);
    const echo = tools.find((tool) => tool.name === "echo")!;
    expect(echo.uiResourceUri).toBe(FAKE_UI_APP_URI);

    const read = await client.readResource(FAKE_HTTP_SERVER_ID, FAKE_UI_APP_URI);
    expect(read.contents[0].mimeType).toBe(FAKE_UI_APP_MIME);
    expect(read.contents[0].text).toContain("aiseMcpApp");
  });
});

describe("MCP App link visibility (registry layer, zero-request denials)", () => {
  let client: ToolListingCountingClient;
  let stdio: StdioMCPClient;
  let store: InMemoryMCPRegistryStore;
  let registry: PersistentMCPRegistry;
  let serverId: string;

  const PROJECT = "project-apps";
  const AGENT = "agent-apps";
  const query = () => ({ projectId: PROJECT, agentName: AGENT });

  beforeAll(async () => {
    stdio = new StdioMCPClient();
    client = new ToolListingCountingClient(stdio);
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
    await store.upsertDiscoveredTools(serverId, [
      { name: "echo", description: "", inputSchema: {} },
      { name: "slow", description: "", inputSchema: {} }
    ]);
  });

  afterAll(async () => {
    const finalPid = stdio.pidOf(serverId);
    await registry.disconnectServer(serverId).catch(() => undefined);
    if (finalPid) await waitForProcessExit(finalPid, 3000).catch(() => undefined);
  });

  it("denies the app list without grants — zero MCP requests", async () => {
    expect(await registry.listVisibleToolUiLinks(serverId, query())).toEqual([]);
    expect(client.toolsListCalls).toBe(0);
  });

  it("lists app links only for visible, enabled, _meta.ui-linked tools", async () => {
    // Tool visibility needs BOTH the project-scope and the agent-scope grant.
    await store.createBinding({ projectId: PROJECT, serverId });
    await store.createBinding({ projectId: PROJECT, serverId, agentName: AGENT });
    const echoRow = (await store.getToolByName(serverId, "echo"))!;
    const slowRow = (await store.getToolByName(serverId, "slow"))!;

    // Disabled tools are not linked even when the grants exist.
    expect(await registry.listVisibleToolUiLinks(serverId, query())).toEqual([]);
    const listingsAfterDenied = client.toolsListCalls;

    await store.updateTool(echoRow.id, { enabled: true });
    await store.updateTool(slowRow.id, { enabled: true });
    const links = await registry.listVisibleToolUiLinks(serverId, query());
    // `slow` has no `_meta.ui` link; only `echo` is an app-carrying tool.
    expect(links).toEqual([{ serverId, toolName: "echo", resourceUri: FAKE_UI_APP_URI }]);
    // The visibility call does hit the server ONCE (live discovery)…
    expect(client.toolsListCalls).toBe(listingsAfterDenied + 1);

    // …and the ui:// document itself is served through the capability gate.
    const app = await registry.readResource(serverId, FAKE_UI_APP_URI, query());
    expect(app.contents[0].text).toContain("aiseMcpApp");
  });

  it("revocation removes the link on the next call — zero requests after revoke", async () => {
    const agentRow = (await store.listBindings({ projectId: PROJECT, serverId })).find(
      (binding) => binding.agentName === AGENT
    )!;
    await store.deleteBinding(agentRow.id);

    expect(await registry.listVisibleToolUiLinks(serverId, query())).toEqual([]);
    const listings = client.toolsListCalls;
    expect(await registry.listVisibleToolUiLinks(serverId, query())).toEqual([]);
    expect(client.toolsListCalls).toBe(listings);

    let denied: MCPClientError | null = null;
    try {
      await registry.readResource(serverId, FAKE_UI_APP_URI, query());
    } catch (error) {
      denied = error as MCPClientError;
    }
    expect(denied).toBeInstanceOf(MCPClientError);
    expect(denied!.mcpErrorCategory).toBe("PERMISSION_DENIED");
    expect(client.resourceReadCalls).toBe(1); // unchanged since the granted read
  });
});
