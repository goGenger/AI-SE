import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCPClientPort } from "../contracts";
import {
  FakeMCPClient,
  FakeMCPError,
  MOCK_MCP_SERVER_ID,
  MOCK_MCP_TOOLS
} from "./fixtures/fakeMCPClient";

const server = {
  id: MOCK_MCP_SERVER_ID,
  name: "Mock MCP Server",
  transport: "stdio" as const,
  stdio: { command: "node", args: ["mock.js"] },
  enabled: true
};

const disabledServer = { ...server, enabled: false };

function categoryOf(error: unknown): string | undefined {
  return error instanceof FakeMCPError ? error.mcpErrorCategory : undefined;
}

describe("Mock MCP Server contract", () => {
  let client: FakeMCPClient;

  beforeEach(() => {
    client = new FakeMCPClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("implements the frozen MCPClientPort", () => {
    const port: MCPClientPort = client;
    expect(typeof port.connect).toBe("function");
  });

  it("freezes the echo/slow/failing tool catalog", async () => {
    await client.connect(server);
    const tools = await client.listTools(MOCK_MCP_SERVER_ID);
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "slow", "failing"]);
    for (const tool of tools) {
      expect(tool.serverId).toBe(MOCK_MCP_SERVER_ID);
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTypeOf("object");
    }
  });

  it("starts with zero server requests", () => {
    expect(client.requestCount).toBe(0);
  });

  it("echo returns the input JSON unchanged", async () => {
    await client.connect(server);
    const input = { text: "hello", nested: { list: [1, 2, 3] } };
    await expect(client.callTool(MOCK_MCP_SERVER_ID, "echo", input)).resolves.toEqual(input);
    expect(client.requestCount).toBe(1);
  });

  it("slow waits for delayMs, then returns the measured delay", async () => {
    vi.useFakeTimers();
    await client.connect(server);
    const pending = client.callTool(MOCK_MCP_SERVER_ID, "slow", { delayMs: 100 });
    const settled = expect(pending).resolves.toMatchObject({ delayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await settled;
    expect(client.requestCount).toBe(1);
  });

  it("slow honours AbortSignal (cancellation)", async () => {
    vi.useFakeTimers();
    await client.connect(server);
    const controller = new AbortController();
    const pending = client.callTool(
      MOCK_MCP_SERVER_ID,
      "slow",
      { delayMs: 10_000 },
      controller.signal
    );
    const assertion = expect(pending).rejects.toThrow("Tool call aborted");
    controller.abort();
    await assertion;
    const error = await pending.catch((caught: unknown) => caught);
    expect(categoryOf(error)).toBe("CANCELLED");
    expect(client.requestCount).toBe(1);
  });

  it("failing rejects with a predictable, classifiable error", async () => {
    await client.connect(server);
    const error = await client
      .callTool(MOCK_MCP_SERVER_ID, "failing", { message: "boom" })
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FakeMCPError);
    expect(categoryOf(error)).toBe("REMOTE_TOOL");
    expect((error as Error).message).toBe("boom");
    expect(client.requestCount).toBe(1);
  });

  it("failing forwards an explicit category for classification tests", async () => {
    await client.connect(server);
    const error = await client
      .callTool(MOCK_MCP_SERVER_ID, "failing", { category: "RATE_LIMITED", message: "429" })
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(categoryOf(error)).toBe("RATE_LIMITED");
  });

  it("rejects calls to unknown tools without counting a server request", async () => {
    await client.connect(server);
    const error = await client
      .callTool(MOCK_MCP_SERVER_ID, "no_such_tool", {})
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(categoryOf(error)).toBe("REMOTE_TOOL");
    expect(client.requestCount).toBe(0);
  });

  it("listTools never counts as a server tool call", async () => {
    await client.connect(server);
    await client.listTools(MOCK_MCP_SERVER_ID);
    expect(client.requestCount).toBe(0);
  });

  it("rejects calls after disconnect with a CONNECTION failure", async () => {
    await client.connect(server);
    await client.disconnect(MOCK_MCP_SERVER_ID);
    const error = await client
      .callTool(MOCK_MCP_SERVER_ID, "echo", {})
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(categoryOf(error)).toBe("CONNECTION");
    expect(client.requestCount).toBe(0);
  });

  it("refuses to connect a disabled server", async () => {
    await expect(client.connect(disabledServer)).rejects.toThrow("is disabled");
    expect(client.connectedServerIds.size).toBe(0);
  });

  it("keeps the frozen catalog stable across connects", async () => {
    await client.connect(server);
    const first = await client.listTools(MOCK_MCP_SERVER_ID);
    await client.disconnect(MOCK_MCP_SERVER_ID);
    await client.connect(server);
    const second = await client.listTools(MOCK_MCP_SERVER_ID);
    expect(second).toEqual(first);
    expect(MOCK_MCP_TOOLS.map((tool) => tool.name)).toEqual(["echo", "slow", "failing"]);
  });
});
