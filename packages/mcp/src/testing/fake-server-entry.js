/**
 * Phase 5.5-1 fake MCP server built on the official MCP TypeScript SDK.
 *
 * Standalone CJS entry: spawned as a real child process over stdio by the
 * StdioMCPClient tests, so the full MCP protocol (initialize, tools/list,
 * tools/call, resources/list, resources/read, prompts/list, prompts/get) is
 * exercised for real.
 *
 * Tools (frozen in Phase 5.5-0):
 *   echo    — returns the input JSON unchanged
 *   slow    — waits delayMs, then returns { delayMs, waitedMs }
 *   failing — always returns an isError result with a predictable message
 *
 * Resources / prompts (Phase 5.5-6): see ./fake-capabilities.js.
 */
"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const { registerFakeCapabilities, UI_APP_URI } = require("./fake-capabilities.js");

const server = new McpServer({ name: "ai-se-fake-mcp-server", version: "0.1.0" });

server.registerTool(
  "echo",
  {
    description: "Returns the input JSON unchanged.",
    inputSchema: z.record(z.string(), z.unknown()),
    // Phase 5.5-7: UI-app link consumed by the MCP Apps host bridge.
    _meta: { ui: { resourceUri: UI_APP_URI } }
  },
  async (args) => {
    return { content: [{ type: "text", text: JSON.stringify(args ?? {}) }] };
  }
);

server.registerTool(
  "slow",
  {
    description: "Waits for delayMs milliseconds, then returns the measured delay.",
    inputSchema: { delayMs: z.number().min(0).max(60_000) }
  },
  async ({ delayMs }) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      content: [{ type: "text", text: JSON.stringify({ delayMs, waitedMs: delayMs }) }]
    };
  }
);

server.registerTool(
  "failing",
  {
    description: "Always fails with a predictable, classifiable error.",
    inputSchema: { message: z.string().optional() }
  },
  async ({ message }) => {
    return {
      content: [{ type: "text", text: message || "Fake server tool failure" }],
      isError: true
    };
  }
);

// Phase 5.5-6: resources + prompts (shared with the Streamable HTTP fixture).
registerFakeCapabilities(server);

server.connect(new StdioServerTransport()).catch((error) => {
  process.stderr.write(`fake server failed: ${error && error.message}\n`);
  process.exit(1);
});
