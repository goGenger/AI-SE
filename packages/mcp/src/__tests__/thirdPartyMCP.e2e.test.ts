import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCPClientError } from "../client/MCPClientError";
import { StdioMCPClient } from "../client/StdioMCPClient";
import { MCPServerDefinition } from "../contracts";

/**
 * Third-party connectivity proof: StdioMCPClient against the OFFICIAL
 * @modelcontextprotocol/server-everything reference server (the SDK repo's own
 * conformance server), spawned as a real stdio child process. This is not a
 * mock: the full MCP protocol runs against an independently implemented server.
 */

const requireFromHere = createRequire(__filename);

function everythingServerEntry(): string {
  const packageJson = requireFromHere.resolve(
    "@modelcontextprotocol/server-everything/package.json"
  );
  return path.join(path.dirname(packageJson), "dist", "index.js");
}

function everythingServerDefinition(): MCPServerDefinition {
  return {
    id: "everything-server",
    name: "Official MCP Everything Server",
    description: "Official SDK reference server (third-party).",
    transport: "stdio",
    stdio: {
      command: process.execPath,
      args: [everythingServerEntry()]
    },
    enabled: true
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

describe("StdioMCPClient against a real third-party MCP server (server-everything)", () => {
  let client: StdioMCPClient;
  let pid: number;

  beforeAll(async () => {
    client = new StdioMCPClient();
    await client.connect(everythingServerDefinition());
    const spawned = client.pidOf("everything-server");
    expect(spawned).toBeTypeOf("number");
    pid = spawned as number;
  });

  afterAll(async () => {
    await client.disconnect("everything-server");
    await waitForProcessExit(pid, 3000);
  });

  it("completes initialize and discovers the third-party tool catalog", async () => {
    expect(isProcessAlive(pid)).toBe(true);
    const tools = await client.listTools("everything-server");
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("echo");
    expect(names).toContain("get-sum");
    expect(names.length).toBeGreaterThan(5);
  });

  it("calls the third-party echo tool and gets a real response", async () => {
    const result = (await client.callTool("everything-server", "echo", {
      message: "hello from ai-se"
    })) as { content: Array<{ type: string; text?: string }> };
    expect(result.content[0].text).toBe("Echo: hello from ai-se");
  });

  it("calls the third-party get-sum tool and gets the computed result", async () => {
    const result = (await client.callTool("everything-server", "get-sum", {
      a: 2,
      b: 3
    })) as { content: Array<{ type: string; text?: string }> };
    expect(result.content[0].text).toBe("The sum of 2 and 3 is 5.");
  });

  it("normalizes a third-party validation failure to REMOTE_TOOL", async () => {
    const error = await client
      .callTool("everything-server", "echo", { message: 42 })
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MCPClientError);
    expect((error as MCPClientError).mcpErrorCategory).toBe("REMOTE_TOOL");
  });
});
