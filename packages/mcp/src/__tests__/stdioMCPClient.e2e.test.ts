import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCPClientError } from "../client/MCPClientError";
import { StdioMCPClient } from "../client/StdioMCPClient";
import { classifyMCPError, mapMCPErrorToRuntimeError } from "../errors";
import {
  FAKE_MCP_SERVER_ID,
  FAKE_MCP_TOOL_NAMES,
  createFakeMCPServerDefinition
} from "../testing/fakeMCPServer";

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

function callError(client: StdioMCPClient, serverId: string, name: string, input: unknown) {
  return client
    .callTool(serverId, name, input)
    .then(() => undefined)
    .catch((error: unknown) => error);
}

function textContent(result: unknown): string {
  const record = result as { content?: Array<{ type: string; text?: string }> };
  return (record.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("\n");
}

describe("StdioMCPClient happy path (real MCP protocol over stdio)", () => {
  let client: StdioMCPClient;
  let pid: number;

  beforeAll(async () => {
    client = new StdioMCPClient();
    await client.connect(createFakeMCPServerDefinition());
    const spawned = client.pidOf(FAKE_MCP_SERVER_ID);
    expect(spawned).toBeTypeOf("number");
    pid = spawned as number;
  });

  afterAll(async () => {
    await client.disconnect(FAKE_MCP_SERVER_ID);
    await waitForProcessExit(pid, 3000);
  });

  it("connect spawns the server and completes the initialize handshake", () => {
    // connect() runs the SDK initialize flow; a successful connect implies
    // initialize succeeded, and every request below requires it.
    expect(isProcessAlive(pid)).toBe(true);
  });

  it("listTools returns the frozen echo/slow/failing catalog", async () => {
    const tools = await client.listTools(FAKE_MCP_SERVER_ID);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...FAKE_MCP_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.serverId).toBe(FAKE_MCP_SERVER_ID);
      expect(tool.description).toBeTruthy();
      const schema = tool.inputSchema as { type?: string };
      expect(schema.type).toBe("object");
    }
  });

  it("echo round-trips arbitrary JSON over tools/call", async () => {
    const input = { text: "hello", nested: { list: [1, 2, 3], flag: true } };
    const result = await client.callTool(FAKE_MCP_SERVER_ID, "echo", input);
    expect(JSON.parse(textContent(result))).toEqual(input);
  });

  it("slow returns the measured delay", async () => {
    const result = await client.callTool(FAKE_MCP_SERVER_ID, "slow", { delayMs: 50 });
    const payload = JSON.parse(textContent(result)) as { delayMs: number; waitedMs: number };
    expect(payload.delayMs).toBe(50);
    expect(payload.waitedMs).toBe(50);
  });

  it("failing maps to REMOTE_TOOL and the unified TOOL_ERROR", async () => {
    const error = await callError(client, FAKE_MCP_SERVER_ID, "failing", {
      message: "controlled failure"
    });
    expect(error).toBeInstanceOf(MCPClientError);
    expect((error as MCPClientError).mcpErrorCategory).toBe("REMOTE_TOOL");
    expect((error as Error).message).toBe("controlled failure");

    expect(classifyMCPError({ error })).toBe("REMOTE_TOOL");
    const mapped = mapMCPErrorToRuntimeError("REMOTE_TOOL", error);
    expect(mapped.code).toBe("TOOL_ERROR");
    expect(mapped.details).toEqual({ mcpErrorCategory: "REMOTE_TOOL" });
  });

  it("unknown tool names normalize to REMOTE_TOOL", async () => {
    const error = await callError(client, FAKE_MCP_SERVER_ID, "no_such_tool", {});
    expect(error).toBeInstanceOf(MCPClientError);
    expect((error as MCPClientError).mcpErrorCategory).toBe("REMOTE_TOOL");
  });
});

describe("StdioMCPClient lifecycle", () => {
  it("rejects double connect without spawning a second process", async () => {
    const client = new StdioMCPClient();
    await client.connect(createFakeMCPServerDefinition());
    const firstPid = client.pidOf(FAKE_MCP_SERVER_ID);
    expect(firstPid).toBeTypeOf("number");

    const error = await client
      .connect(createFakeMCPServerDefinition())
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MCPClientError);
    expect((error as MCPClientError).mcpErrorCategory).toBe("CONNECTION");

    // Same child: no second process was spawned.
    expect(client.pidOf(FAKE_MCP_SERVER_ID)).toBe(firstPid);
    expect(isProcessAlive(firstPid as number)).toBe(true);

    await client.disconnect(FAKE_MCP_SERVER_ID);
    await waitForProcessExit(firstPid as number, 3000);
  });

  it("disconnect terminates the server process and rejects later calls", async () => {
    const client = new StdioMCPClient();
    await client.connect(createFakeMCPServerDefinition());
    const pid = client.pidOf(FAKE_MCP_SERVER_ID) as number;

    await client.disconnect(FAKE_MCP_SERVER_ID);
    await waitForProcessExit(pid, 3000);

    const error = await callError(client, FAKE_MCP_SERVER_ID, "echo", {});
    expect(error).toBeInstanceOf(MCPClientError);
    expect((error as MCPClientError).mcpErrorCategory).toBe("CONNECTION");
  });

  it("disconnecting twice rejects the second call", async () => {
    const client = new StdioMCPClient();
    await client.connect(createFakeMCPServerDefinition());
    await client.disconnect(FAKE_MCP_SERVER_ID);

    const error = await client
      .disconnect(FAKE_MCP_SERVER_ID)
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MCPClientError);
    expect((error as MCPClientError).mcpErrorCategory).toBe("CONNECTION");
  });
});

describe("StdioMCPClient connection failures", () => {
  it("connect with an invalid command fails with CONNECTION", async () => {
    const client = new StdioMCPClient();
    const error = await client
      .connect(
        createFakeMCPServerDefinition({
          stdio: {
            command: "definitely-not-a-real-command-ai-se-xyz",
            args: []
          }
        })
      )
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MCPClientError);
    expect((error as MCPClientError).mcpErrorCategory).toBe("CONNECTION");
    expect(client.pidOf(FAKE_MCP_SERVER_ID)).toBeNull();
  });

  it("connect rejects a disabled server without spawning", async () => {
    const client = new StdioMCPClient();
    const error = await client
      .connect(createFakeMCPServerDefinition({ enabled: false }))
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MCPClientError);
    expect((error as MCPClientError).mcpErrorCategory).toBe("CONNECTION");
    expect(client.pidOf(FAKE_MCP_SERVER_ID)).toBeNull();
  });
});

describe("StdioMCPClient cancellation", () => {
  it("aborting a slow call classifies as CANCELLED and maps to CANCELLED_ERROR", async () => {
    const client = new StdioMCPClient();
    await client.connect(createFakeMCPServerDefinition());
    const pid = client.pidOf(FAKE_MCP_SERVER_ID) as number;

    const controller = new AbortController();
    const pending = client.callTool(
      FAKE_MCP_SERVER_ID,
      "slow",
      { delayMs: 2000 },
      controller.signal
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(MCPClientError);
    setTimeout(() => controller.abort(), 30);
    await assertion;

    const error = await pending.catch((caught: unknown) => caught);
    expect((error as MCPClientError).mcpErrorCategory).toBe("CANCELLED");
    expect(classifyMCPError({ error, aborted: true })).toBe("CANCELLED");
    expect(mapMCPErrorToRuntimeError("CANCELLED", error).code).toBe("CANCELLED_ERROR");

    // The server is still sleeping (delayMs=2000); disconnect and confirm the
    // child is cleaned up once the pending timer fires.
    await client.disconnect(FAKE_MCP_SERVER_ID);
    await waitForProcessExit(pid, 4000);
  });
});
