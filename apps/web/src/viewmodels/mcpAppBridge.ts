import {
  MCPAppInboundMessageSchema,
  MCPAppOutboundMessage,
  MCPAppOutboundMessageSchema,
  MCP_APP_CHANNEL,
  MCP_APP_MAX_ARGUMENT_BYTES
} from "@ai-se/shared";

/**
 * Phase 5.5-7: host side of the MCP App bridge.
 *
 * Security model (see docs/33):
 *  - the app document is rendered in an iframe with `sandbox="allow-scripts"`
 *    ONLY (no same-origin permission, no forms, no popups, no top navigation),
 *    so the frame runs in an opaque origin with no cookies, no parent DOM and
 *    no credentials of any kind;
 *  - every inbound message is validated against the shared strict schemas and
 *    MUST come from the app frame's own contentWindow (source identity check —
 *    an opaque origin cannot be compared by string);
 *  - unknown message types / invalid payloads are dropped, never executed;
 *  - actions are forwarded to the backend through the console REST API, where
 *    the existing Tool Runtime governance re-authorizes them. The bridge
 *    itself never calls tools, never reads credentials (it has none), and the
 *    messages carry no credential material by construction.
 */

/** The ONLY sandbox permissions granted to an MCP app frame. */
export const MCP_APP_SANDBOX = "allow-scripts";

/** Timeout for one app-initiated action round trip (app side, in-iframe). */
export const MCP_APP_ACTION_TIMEOUT_MS = 60_000;

/**
 * In-iframe bootstrap defining `window.aiseMcpApp`
 * (notifyReady / requestToolCall). It only ever talks to `window.parent` via
 * postMessage — no network access, no storage.
 */
export function mcpAppBootstrapScript(): string {
  return `(function () {
  var CHANNEL = "${MCP_APP_CHANNEL}";
  var pending = new Map();
  var counter = 0;
  function post(message) {
    if (window.parent === window) return;
    window.parent.postMessage(message, "*");
  }
  window.aiseMcpApp = {
    notifyReady: function () {
      post({ channel: CHANNEL, type: "app/ready" });
    },
    requestToolCall: function (toolName, args) {
      return new Promise(function (resolve, reject) {
        if (typeof toolName !== "string" || toolName.trim() === "") {
          reject(new Error("toolName is required"));
          return;
        }
        var id = "req-" + (++counter);
        var timer = setTimeout(function () {
          if (pending.delete(id)) reject(new Error("host did not answer in time"));
        }, ${MCP_APP_ACTION_TIMEOUT_MS});
        pending.set(id, {
          resolve: function (value) { clearTimeout(timer); resolve(value); },
          reject: function (error) { clearTimeout(timer); reject(error); }
        });
        post({
          channel: CHANNEL,
          type: "app/action",
          id: id,
          action: { kind: "tool", toolName: toolName, arguments: args || undefined }
        });
      });
    }
  };
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.channel !== CHANNEL) return;
    if (data.type === "host/init") {
      window.dispatchEvent(new CustomEvent("aise-mcp-app-init", {
        detail: { serverId: data.serverId, toolName: data.toolName, resourceUri: data.resourceUri }
      }));
      return;
    }
    if (data.type === "host/action-result" && typeof data.id === "string" && pending.has(data.id)) {
      var entry = pending.get(data.id);
      pending.delete(data.id);
      if (data.ok) entry.resolve(data.data);
      else entry.reject(new Error((data.error && data.error.message) || "host rejected the action"));
    }
  });
})();`;
}

/**
 * Builds the iframe document: the host bootstrap is PREPENDED so the bridge
 * API exists before any app script runs. `sandbox` + srcdoc (not a URL) keep
 * the frame in an opaque origin.
 */
export function buildAppDocument(html: string): string {
  return `<script>${mcpAppBootstrapScript()}</script>${html}`;
}

export interface MCPAppBridgeAction {
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface MCPAppBridgeResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export interface MCPAppHostContext {
  serverId: string;
  toolName?: string;
  resourceUri: string;
}

export interface MCPAppHostOptions {
  /** Current app frame window (source identity is validated against it). */
  getContentWindow: () => {
    postMessage(message: unknown, targetOrigin: string): void;
  } | null;
  context: MCPAppHostContext;
  /** Runs one controlled action through the BACKEND (Tool Runtime chain). */
  onAction: (action: MCPAppBridgeAction) => Promise<MCPAppBridgeResult>;
  /** Diagnostics only (never message content). */
  onRejected?: (reason: string) => void;
}

function argumentBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? {})).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export interface MCPAppHost {
  /** Feed one window message event through the bridge. */
  handleMessage(event: { source: unknown; data: unknown }): Promise<void>;
}

export function createMCPAppHost(options: MCPAppHostOptions): MCPAppHost {
  function post(message: MCPAppOutboundMessage): void {
    const target = options.getContentWindow();
    if (!target) return;
    // Sandboxed frames have an opaque origin ("null"), so a concrete
    // targetOrigin cannot be used; the message is addressed to the frame's
    // own contentWindow and contains no credential material.
    target.postMessage(message, "*");
  }

  function postResult(id: string, result: MCPAppBridgeResult, fallbackCode: string): void {
    post(
      MCPAppOutboundMessageSchema.parse({
        channel: MCP_APP_CHANNEL,
        type: "host/action-result",
        id,
        ok: result.ok,
        ...(result.ok ? { data: result.data } : {}),
        ...(!result.ok
          ? {
              error: result.error ?? {
                code: fallbackCode,
                message: "The host rejected the action"
              }
            }
          : {})
      })
    );
  }

  return {
    async handleMessage(event): Promise<void> {
      const target = options.getContentWindow();
      if (!target || event.source !== target) {
        options.onRejected?.("source");
        return;
      }

      const parsed = MCPAppInboundMessageSchema.safeParse(event.data);
      if (!parsed.success) {
        // Unknown types and invalid payloads (including credential-shaped
        // extra fields, rejected by the strict schemas) are dropped.
        options.onRejected?.("invalid-message");
        return;
      }
      const message = parsed.data;

      if (message.type === "app/ready") {
        post(
          MCPAppOutboundMessageSchema.parse({
            channel: MCP_APP_CHANNEL,
            type: "host/init",
            serverId: options.context.serverId,
            ...(options.context.toolName ? { toolName: options.context.toolName } : {}),
            resourceUri: options.context.resourceUri
          })
        );
        return;
      }

      if (argumentBytes(message.action.arguments) > MCP_APP_MAX_ARGUMENT_BYTES) {
        options.onRejected?.("arguments-too-large");
        postResult(
          message.id,
          {
            ok: false,
            error: {
              code: "MCP_APP_ARGUMENTS_TOO_LARGE",
              message: "Arguments exceed the size limit"
            }
          },
          "MCP_APP_ARGUMENTS_TOO_LARGE"
        );
        return;
      }

      let result: MCPAppBridgeResult;
      try {
        result = await options.onAction({
          toolName: message.action.toolName,
          arguments: message.action.arguments
        });
      } catch (error) {
        result = {
          ok: false,
          error: {
            code: "MCP_APP_ACTION_FAILED",
            message: error instanceof Error ? error.message : "Action failed"
          }
        };
      }
      postResult(message.id, result, "MCP_APP_ACTION_FAILED");
    }
  };
}
