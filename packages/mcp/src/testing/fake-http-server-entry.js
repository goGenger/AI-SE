/**
 * Phase 5.5-4 fake REMOTE MCP server: official SDK Streamable HTTP transport
 * over a plain node:http server, spawned as a real child process.
 *
 * Env:
 *   PORT       — listen port (0 = ephemeral; the real port is printed)
 *   JSON_MODE  — "1" → JSON responses (enableJsonResponse); else SSE responses
 *   AUTH       — optional expected bearer token; POST /mcp then requires
 *                "Authorization: Bearer <AUTH>", otherwise 401 "unauthorized"
 *
 * Prints "FAKE_HTTP_SERVER_READY <port>" on stderr once listening.
 * Debug routes: GET /__hits → { hits, authFailures } (no MCP handling).
 *
 * Tools (same contract as the stdio fake server): echo / slow / failing.
 * Resources/prompts (Phase 5.5-6): shared fake-capabilities.js module.
 */
"use strict";

const http = require("node:http");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const { registerFakeCapabilities, UI_APP_URI } = require("./fake-capabilities.js");

const PORT = Number(process.env.PORT ?? 0);
const JSON_MODE = process.env.JSON_MODE === "1";
const AUTH = process.env.AUTH ?? "";

// Orphan guard: a hard-killed runner (SIGKILL / interrupted suite) never reaches the
// handle's stop(), leaving this fixture listening forever. On reparent (ppid change) exit.
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid) {
    process.exit(0);
  }
}, 1000).unref();

let hits = 0;
let authFailures = 0;

function createMcpServer() {
  const server = new McpServer({ name: "ai-se-fake-http-mcp-server", version: "0.1.0" });

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

  // Phase 5.5-6: resources + prompts (shared with the stdio fixture).
  registerFakeCapabilities(server);

  return server;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw.toString("utf8")));
      } catch {
        resolve(Symbol.for("invalid-json"));
      }
    });
    req.on("error", () => resolve(Symbol.for("invalid-json")));
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Stateless Streamable HTTP: the SDK pattern creates a FRESH server+transport
 * per request (no session model, no cross-request transport state).
 */
async function handleMcpPost(req, res, body) {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: JSON_MODE
  });
  res.on("close", () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/__hits" && req.method === "GET") {
    sendJson(res, 200, { hits, authFailures, jsonMode: JSON_MODE });
    return;
  }
  if (url.pathname === "/__health" && req.method === "GET") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname !== "/mcp") {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  if (req.method !== "POST") {
    // No server-initiated streams in this fixture.
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  if (AUTH) {
    const header = req.headers.authorization ?? "";
    if (header !== `Bearer ${AUTH}`) {
      authFailures += 1;
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
  }

  hits += 1;
  const body = await readBody(req);
  if (typeof body === "symbol") {
    sendJson(res, 400, { error: "invalid json body" });
    return;
  }
  try {
    await handleMcpPost(req, res, body);
  } catch (error) {
    process.stderr.write(
      `MCP REQUEST ERROR: ${error && error.stack ? error.stack : String(error)}\n`
    );
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal error" });
    }
  }
});

httpServer.listen(PORT, "127.0.0.1", () => {
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  process.stderr.write(`FAKE_HTTP_SERVER_READY ${port}\n`);
});
