/**
 * Phase 5.5-6 shared fixture capabilities: resources + prompts registered on
 * BOTH fake MCP servers (stdio child process + Streamable HTTP fixture), so
 * the full resource/prompt protocol surface is exercised for real.
 *
 * Resources:
 *   greeting  — text/plain text resource
 *   binary    — application/octet-stream blob resource (base64)
 *   slow      — waits 400ms before answering (timeout / cancellation tests)
 *   malformed — returns protocol-invalid contents on purpose (text: 12345)
 *   leaky     — fails with a token-shaped message on purpose (redaction test)
 *
 * UI app (Phase 5.5-7):
 *   ui://apps/counter — text/html;profile=mcp-app app served over resources/read;
 *                       talks to the host through the sandboxed-iframe bridge.
 *
 * Prompts:
 *   welcome     — single text message, no arguments
 *   code_review — two required arguments (language, code)
 *   attach      — text message + embedded resource message
 */
"use strict";

const { ErrorCode, McpError } = require("@modelcontextprotocol/sdk/types.js");
const { z } = require("zod");

const GREETING_TEXT = "Hello from AI-SE fake resource";
const BINARY_PAYLOAD = "BINARY-DATA";

/** Phase 5.5-7: the UI app uri + its MIME type (mirrored in fakeMCPServer.ts). */
const UI_APP_URI = "ui://apps/counter";
const UI_APP_MIME = "text/html;profile=mcp-app";

/** Small sandboxed-app fixture: announces itself and calls a tool via the host. */
const UI_APP_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>AI-SE Counter App</title></head>
<body>
  <h1 data-app="counter">AI-SE Counter App</h1>
  <p id="status">starting</p>
  <button id="echo" type="button">Echo via host</button>
  <pre id="result"></pre>
  <script>
    (function () {
      var count = 0;
      var api = window.aiseMcpApp;
      var statusEl = document.getElementById("status");
      function setStatus(text) { statusEl.textContent = text; }
      if (!api) { setStatus("no host bridge"); return; }
      api.notifyReady();
      setStatus("ready");
      document.getElementById("echo").addEventListener("click", function () {
        count += 1;
        api.requestToolCall("echo", { from: "counter-app", count: count })
          .then(function (data) {
            setStatus("host call ok");
            document.getElementById("result").textContent = JSON.stringify(data, null, 2);
          })
          .catch(function (error) {
            setStatus("host denied: " + (error && error.message ? error.message : String(error)));
          });
      });
    })();
  </script>
</body>
</html>`;

const RESOURCE_URIS = {
  greeting: "fake://resources/greeting",
  binary: "fake://resources/binary",
  slow: "fake://resources/slow",
  malformed: "fake://resources/malformed",
  leaky: "fake://resources/leaky"
};

function registerFakeResources(server) {
  server.registerResource(
    "counter",
    UI_APP_URI,
    { title: "Counter App", description: "Sandboxed UI app fixture.", mimeType: UI_APP_MIME },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: UI_APP_MIME, text: UI_APP_HTML }]
    })
  );

  server.registerResource(
    "greeting",
    RESOURCE_URIS.greeting,
    { title: "Greeting", description: "A friendly greeting.", mimeType: "text/plain" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: GREETING_TEXT }]
    })
  );

  server.registerResource(
    "binary",
    RESOURCE_URIS.binary,
    {
      title: "Binary",
      description: "Base64 binary payload.",
      mimeType: "application/octet-stream"
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/octet-stream",
          blob: Buffer.from(BINARY_PAYLOAD).toString("base64")
        }
      ]
    })
  );

  server.registerResource(
    "slow",
    RESOURCE_URIS.slow,
    { title: "Slow", description: "Waits before answering.", mimeType: "text/plain" },
    async (uri) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Slow resource ready" }] };
    }
  );

  server.registerResource(
    "malformed",
    RESOURCE_URIS.malformed,
    {
      title: "Malformed",
      description: "Returns protocol-invalid contents on purpose.",
      mimeType: "text/plain"
    },
    async (uri) => ({ contents: [{ uri: uri.href, text: 12345 }] })
  );

  server.registerResource(
    "leaky",
    RESOURCE_URIS.leaky,
    { title: "Leaky", description: "Fails with a token-shaped message on purpose." },
    async () => {
      throw new McpError(ErrorCode.InvalidParams, "resource unavailable: sk-live1234567890abcdef");
    }
  );
}

function registerFakePrompts(server) {
  server.registerPrompt(
    "welcome",
    { title: "Welcome", description: "A welcome message." },
    async () => ({
      messages: [
        { role: "user", content: { type: "text", text: "Welcome to the AI-SE fake MCP server." } }
      ]
    })
  );

  server.registerPrompt(
    "code_review",
    {
      title: "Code review",
      description: "Reviews a code snippet.",
      argsSchema: { language: z.string(), code: z.string() }
    },
    async ({ language, code }) => ({
      messages: [
        { role: "user", content: { type: "text", text: `Review this ${language} code:\n${code}` } }
      ]
    })
  );

  server.registerPrompt(
    "attach",
    { title: "Attach", description: "Context with an embedded resource." },
    async () => ({
      messages: [
        { role: "user", content: { type: "text", text: "Context attached below." } },
        {
          role: "user",
          content: {
            type: "resource",
            resource: {
              uri: RESOURCE_URIS.greeting,
              mimeType: "text/plain",
              text: GREETING_TEXT
            }
          }
        }
      ]
    })
  );
}

function registerFakeCapabilities(server) {
  registerFakeResources(server);
  registerFakePrompts(server);
}

module.exports = { registerFakeCapabilities, RESOURCE_URIS, UI_APP_URI, UI_APP_MIME };
