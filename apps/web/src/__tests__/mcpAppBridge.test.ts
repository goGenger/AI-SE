import { MCP_APP_CHANNEL } from "@ai-se/shared";
import { describe, expect, it, vi } from "vitest";
import {
  MCPAppBridgeResult,
  MCP_APP_SANDBOX,
  buildAppDocument,
  createMCPAppHost,
  mcpAppBootstrapScript
} from "../viewmodels/mcpAppBridge";

/**
 * Phase 5.5-7: host bridge tests — schema/source validation, unknown and
 * invalid messages rejected without executing anything, controlled actions
 * forwarded to the backend delegate only.
 */

function harness(result?: MCPAppBridgeResult) {
  const frameWindow = { postMessage: vi.fn() };
  const onAction = vi.fn(
    async (_action: { toolName: string; arguments?: unknown }) =>
      result ?? { ok: true, data: { echoed: true } }
  );
  const onRejected = vi.fn();
  const host = createMCPAppHost({
    getContentWindow: () => frameWindow,
    context: { serverId: "server-1", toolName: "echo", resourceUri: "ui://apps/counter" },
    onAction,
    onRejected
  });
  return { frameWindow, onAction, onRejected, host };
}

function actionEvent(frameWindow: unknown, action: Record<string, unknown>) {
  return {
    source: frameWindow,
    data: {
      channel: MCP_APP_CHANNEL,
      type: "app/action",
      id: "req-1",
      action: { kind: "tool", toolName: "echo", ...action }
    }
  };
}

describe("MCP app sandbox + document builder", () => {
  it("uses only allow-scripts as the sandbox permission", () => {
    expect(MCP_APP_SANDBOX).toBe("allow-scripts");
    for (const forbidden of [
      "allow-same-origin",
      "allow-top-navigation",
      "allow-popups",
      "allow-forms",
      "allow-modals",
      "allow-downloads"
    ]) {
      expect(MCP_APP_SANDBOX).not.toContain(forbidden);
    }
  });

  it("prepends the bridge bootstrap before the app markup", () => {
    const document = buildAppDocument("<html><body>app</body></html>");
    expect(document.startsWith("<script>")).toBe(true);
    expect(document).toContain("window.aiseMcpApp");
    expect(document.indexOf("window.aiseMcpApp")).toBeLessThan(document.indexOf("<html>"));

    const bootstrap = mcpAppBootstrapScript();
    expect(bootstrap).toContain('type: "app/ready"');
    // The bootstrap talks to the host via postMessage only.
    expect(bootstrap).not.toContain("fetch(");
    expect(bootstrap).not.toContain("localStorage");
    expect(bootstrap).not.toContain("sessionStorage");
    expect(bootstrap).not.toContain("document.cookie");
  });
});

describe("host bridge message handling", () => {
  it("answers app/ready with host/init (no credential material)", async () => {
    const { frameWindow, host } = harness();
    await host.handleMessage({
      source: frameWindow,
      data: { channel: MCP_APP_CHANNEL, type: "app/ready" }
    });

    expect(frameWindow.postMessage).toHaveBeenCalledWith(
      {
        channel: MCP_APP_CHANNEL,
        type: "host/init",
        serverId: "server-1",
        toolName: "echo",
        resourceUri: "ui://apps/counter"
      },
      "*"
    );
    expect(JSON.stringify(frameWindow.postMessage.mock.calls)).not.toMatch(
      /token|credential|secret|authorization/i
    );
  });

  it("forwards valid actions to the backend delegate and returns the result", async () => {
    const { frameWindow, onAction, host } = harness();
    await host.handleMessage(
      actionEvent(frameWindow, { arguments: { from: "app" }, toolName: "echo" })
    );

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({ toolName: "echo", arguments: { from: "app" } });
    expect(frameWindow.postMessage).toHaveBeenCalledWith(
      {
        channel: MCP_APP_CHANNEL,
        type: "host/action-result",
        id: "req-1",
        ok: true,
        data: { echoed: true }
      },
      "*"
    );
  });

  it("relays backend denials as error results", async () => {
    const { frameWindow, host } = harness({
      ok: false,
      error: { code: "MCP_APP_ACTION_DENIED", message: "MCP tool is not permitted" }
    });
    await host.handleMessage(actionEvent(frameWindow, {}));
    expect(frameWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "host/action-result",
        id: "req-1",
        ok: false,
        error: { code: "MCP_APP_ACTION_DENIED", message: "MCP tool is not permitted" }
      }),
      "*"
    );
  });

  it("drops messages from any window other than the app frame", async () => {
    const { frameWindow, onAction, onRejected, host } = harness();
    await host.handleMessage(actionEvent({ postMessage: vi.fn() }, {}));

    expect(onAction).not.toHaveBeenCalled();
    expect(frameWindow.postMessage).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith("source");
  });

  it("rejects unknown message types and malformed payloads without executing", async () => {
    const { frameWindow, onAction, onRejected, host } = harness();

    await host.handleMessage({
      source: frameWindow,
      data: { channel: MCP_APP_CHANNEL, type: "app/execute-anything" }
    });
    await host.handleMessage({
      source: frameWindow,
      data: { channel: "other", type: "app/ready" }
    });
    await host.handleMessage({ source: frameWindow, data: { channel: MCP_APP_CHANNEL } });
    // Missing id on an action message.
    await host.handleMessage({
      source: frameWindow,
      data: {
        channel: MCP_APP_CHANNEL,
        type: "app/action",
        action: { kind: "tool", toolName: "echo" }
      }
    });
    // Credential-shaped extra fields on the action are rejected by strict
    // schemas (the protocol itself never carries credentials).
    await host.handleMessage(actionEvent(frameWindow, { credentialRef: "vault://mcp/x" }));

    expect(onAction).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(5);
    expect(frameWindow.postMessage).not.toHaveBeenCalled();
  });

  it("rejects oversized action arguments", async () => {
    const { frameWindow, onAction, host } = harness();
    await host.handleMessage(actionEvent(frameWindow, { arguments: { blob: "x".repeat(70_000) } }));

    expect(onAction).not.toHaveBeenCalled();
    expect(frameWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "host/action-result",
        ok: false,
        error: expect.objectContaining({ code: "MCP_APP_ARGUMENTS_TOO_LARGE" })
      }),
      "*"
    );
  });

  it("turns delegate failures into error results instead of crashing", async () => {
    const frameWindow = { postMessage: vi.fn() };
    const host = createMCPAppHost({
      getContentWindow: () => frameWindow,
      context: { serverId: "server-1", resourceUri: "ui://apps/counter" },
      onAction: async () => {
        throw new Error("backend unavailable");
      }
    });

    await host.handleMessage(actionEvent(frameWindow, {}));
    expect(frameWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "host/action-result",
        ok: false,
        error: { code: "MCP_APP_ACTION_FAILED", message: "backend unavailable" }
      }),
      "*"
    );
  });

  it("does not post when the frame is gone", async () => {
    const onAction = vi.fn();
    const host = createMCPAppHost({
      getContentWindow: () => null,
      context: { serverId: "server-1", resourceUri: "ui://apps/counter" },
      onAction
    });
    await host.handleMessage({
      source: { postMessage: vi.fn() },
      data: { channel: MCP_APP_CHANNEL, type: "app/ready" }
    });
    expect(onAction).not.toHaveBeenCalled();
  });
});
