import { ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteMCPClient } from "../client/RemoteMCPClient";

/**
 * Phase 5.5-4 third-party interop proof: RemoteMCPClient against the OFFICIAL
 * @modelcontextprotocol/server-everything reference server running in its
 * `streamableHttp` mode (independently implemented, real HTTP).
 */

const requireFromHere = createRequire(__filename);

function everythingEntry(): string {
  const packageJson = requireFromHere.resolve(
    "@modelcontextprotocol/server-everything/package.json"
  );
  return path.join(path.dirname(packageJson), "dist", "index.js");
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("RemoteMCPClient against a real third-party Streamable HTTP server (server-everything)", () => {
  let child: ChildProcess;
  let client: RemoteMCPClient;
  const serverId = "everything-http";
  let endpoint = "";

  beforeAll(async () => {
    const port = await freePort();
    child = spawn(process.execPath, [everythingEntry(), "streamableHttp"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: String(port) }
    });
    endpoint = `http://127.0.0.1:${port}/mcp`;

    let stderr = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`everything server not ready; stderr: ${stderr}`)),
        15_000
      );
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (/listening on port/i.test(stderr)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`everything server exited early (code ${code}); stderr: ${stderr}`));
      });
    });

    client = new RemoteMCPClient();
    await client.connect({
      id: serverId,
      name: "everything-streamable-http",
      transport: "streamable-http",
      endpoint,
      enabled: true
    });
  });

  afterAll(async () => {
    await client.disconnect(serverId).catch(() => undefined);
    if (child.exitCode === null && !child.killed) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }
  });

  it("initializes over Streamable HTTP and discovers the third-party tool catalog", async () => {
    const tools = await client.listTools(serverId);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("echo");
    expect(names).toContain("get-sum");
    expect(names.length).toBeGreaterThan(5);
  });

  it("calls third-party tools over Streamable HTTP", async () => {
    const echo = (await client.callTool(serverId, "echo", { message: "hello ai-se remote" })) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(echo.content[0].text).toBe("Echo: hello ai-se remote");

    const sum = (await client.callTool(serverId, "get-sum", { a: 2, b: 3 })) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(sum.content[0].text).toBe("The sum of 2 and 3 is 5.");
  });
});
