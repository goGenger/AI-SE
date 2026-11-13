import { ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { MCPServerDefinition } from "../contracts";

/**
 * Phase 5.5-4 test fixture: launcher for the official-SDK Streamable HTTP
 * fake MCP server (src/testing/fake-http-server-entry.js), plus the
 * MCPServerDefinition factory for remote definitions.
 */

export const FAKE_HTTP_SERVER_ID = "fake-http-server";
export const FAKE_HTTP_SERVER_NAME = "fake-http-server";
export const FAKE_HTTP_TOOL_NAMES = ["echo", "slow", "failing"] as const;

export function fakeHTTPServerEntryPath(): string {
  return path.join(__dirname, "fake-http-server-entry.js");
}

export interface FakeHTTPServerHandle {
  port: number;
  endpoint: string;
  child: ChildProcess;
  /** Debug endpoint hit counters (posts that reached the MCP handler / auth failures). */
  hits(): Promise<{ hits: number; authFailures: number; jsonMode: boolean }>;
  /** Accumulated fixture stderr (diagnostics only). */
  stderrText(): string;
  stop(): Promise<void>;
}

export interface StartFakeHTTPServerOptions {
  /** Fixed port (reconnect tests reuse it) or 0/undefined for an ephemeral port. */
  port?: number;
  /** true → JSON responses; false → SSE responses. */
  jsonMode?: boolean;
  /** When set, POST /mcp requires `Authorization: Bearer <auth>`. */
  auth?: string;
}

export async function startFakeHTTPServer(
  options: StartFakeHTTPServerOptions = {}
): Promise<FakeHTTPServerHandle> {
  const child = spawn(process.execPath, [fakeHTTPServerEntryPath()], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PORT: String(options.port ?? 0),
      ...(options.jsonMode ? { JSON_MODE: "1" } : {}),
      ...(options.auth ? { AUTH: options.auth } : {})
    }
  });

  let stderr = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`fake http server did not become ready; stderr: ${stderr}`));
    }, 10_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = /FAKE_HTTP_SERVER_READY (\d+)/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fake http server exited early (code ${code}); stderr: ${stderr}`));
    });
  });

  const endpoint = `http://127.0.0.1:${port}/mcp`;
  return {
    port,
    endpoint,
    child,
    stderrText: () => stderr,
    hits: async () => {
      const response = await fetch(`http://127.0.0.1:${port}/__hits`);
      return (await response.json()) as { hits: number; authFailures: number; jsonMode: boolean };
    },
    stop: async () => {
      if (child.exitCode === null && !child.killed) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await exited;
      }
    }
  };
}

export function createFakeHTTPServerDefinition(
  endpoint: string,
  overrides: Partial<MCPServerDefinition> = {}
): MCPServerDefinition {
  return {
    id: FAKE_HTTP_SERVER_ID,
    name: FAKE_HTTP_SERVER_NAME,
    description: "Fake remote MCP server (Streamable HTTP, official SDK).",
    transport: "streamable-http",
    endpoint,
    enabled: true,
    ...overrides
  };
}
