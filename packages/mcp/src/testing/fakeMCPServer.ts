import path from "node:path";
import { MCPServerDefinition } from "../contracts";

/**
 * Phase 5.5-1 test fixture: definition of the official-SDK fake MCP server
 * (src/testing/fake-server-entry.js), spawned as a real stdio child process.
 * Phase 5.5-6 added resources/prompts via the shared fake-capabilities module.
 */

export const FAKE_MCP_SERVER_ID = "fake-stdio-server";

export const FAKE_MCP_TOOL_NAMES = ["echo", "slow", "failing"] as const;

/** Resource uris served by both fake fixtures (mirrors fake-capabilities.js). */
export const FAKE_RESOURCE_URIS = {
  greeting: "fake://resources/greeting",
  binary: "fake://resources/binary",
  slow: "fake://resources/slow",
  malformed: "fake://resources/malformed",
  leaky: "fake://resources/leaky"
} as const;

export const FAKE_PROMPT_NAMES = ["welcome", "code_review", "attach"] as const;

/** Phase 5.5-7 UI app fixture (mirrors fake-capabilities.js). */
export const FAKE_UI_APP_URI = "ui://apps/counter";
export const FAKE_UI_APP_MIME = "text/html;profile=mcp-app";

export const FAKE_GREETING_TEXT = "Hello from AI-SE fake resource";

export const FAKE_BINARY_BASE64 = Buffer.from("BINARY-DATA").toString("base64");

/** Token-shaped text the leaky fixture embeds in its error message. */
export const FAKE_LEAKY_TOKEN = "sk-live1234567890abcdef";

export function fakeServerEntryPath(): string {
  return path.join(__dirname, "fake-server-entry.js");
}

export function createFakeMCPServerDefinition(
  overrides: Partial<MCPServerDefinition> = {}
): MCPServerDefinition {
  return {
    id: FAKE_MCP_SERVER_ID,
    name: "AI-SE Fake MCP Server",
    description: "Official-SDK stdio server exposing echo / slow / failing.",
    transport: "stdio",
    stdio: {
      command: process.execPath,
      args: [fakeServerEntryPath()]
    },
    enabled: true,
    ...overrides
  };
}
