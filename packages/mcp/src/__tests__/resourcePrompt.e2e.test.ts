import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCPClientError } from "../client/MCPClientError";
import { StdioMCPClient } from "../client/StdioMCPClient";
import type { MCPCapabilityAuditEvent } from "../integration/capability";
import { createMCPPromptAdapter } from "../integration/promptAdapter";
import { createMCPResourceAdapter } from "../integration/resourceAdapter";
import {
  FAKE_BINARY_BASE64,
  FAKE_GREETING_TEXT,
  FAKE_MCP_SERVER_ID,
  FAKE_PROMPT_NAMES,
  FAKE_RESOURCE_URIS,
  createFakeMCPServerDefinition
} from "../testing/fakeMCPServer";

/**
 * Phase 5.5-6 E2E: resources/prompts over the REAL MCP protocol (official SDK,
 * stdio child process). Covers listing, reading (text + blob), prompt argument
 * transfer and message conversion, server errors, malformed payloads, timeout,
 * cancellation, audit events and secret redaction. Tool behavior is covered by
 * the 5.5-1 suites and is intentionally re-asserted once here.
 */

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

async function rejectionOf(run: () => Promise<unknown>): Promise<MCPClientError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(MCPClientError);
    return error as MCPClientError;
  }
  throw new Error("Expected the call to fail");
}

describe("resources & prompts over real stdio MCP", () => {
  let client: StdioMCPClient;
  let pid: number;

  beforeAll(async () => {
    client = new StdioMCPClient();
    await client.connect(createFakeMCPServerDefinition());
    pid = client.pidOf(FAKE_MCP_SERVER_ID) as number;
  });

  afterAll(async () => {
    await client.disconnect(FAKE_MCP_SERVER_ID);
    await waitForProcessExit(pid, 3000);
  });

  it("lists resources with uri/name/description/mimeType", async () => {
    const resources = await client.listResources(FAKE_MCP_SERVER_ID);
    expect(resources.map((resource) => resource.name).sort()).toEqual([
      "binary",
      "counter",
      "greeting",
      "leaky",
      "malformed",
      "slow"
    ]);

    const greeting = resources.find((resource) => resource.name === "greeting")!;
    expect(greeting.serverId).toBe(FAKE_MCP_SERVER_ID);
    expect(greeting.uri).toBe(FAKE_RESOURCE_URIS.greeting);
    expect(greeting.description).toBe("A friendly greeting.");
    expect(greeting.mimeType).toBe("text/plain");
    // MCP SDK objects never leak: only stable fields survive.
    expect(Object.keys(greeting).sort()).toEqual([
      "description",
      "mimeType",
      "name",
      "serverId",
      "uri"
    ]);
  });

  it("reads a text resource", async () => {
    const result = await client.readResource(FAKE_MCP_SERVER_ID, FAKE_RESOURCE_URIS.greeting);
    expect(result.serverId).toBe(FAKE_MCP_SERVER_ID);
    expect(result.contents).toEqual([
      {
        uri: FAKE_RESOURCE_URIS.greeting,
        mimeType: "text/plain",
        text: FAKE_GREETING_TEXT
      }
    ]);
  });

  it("reads a blob resource (base64 binary)", async () => {
    const result = await client.readResource(FAKE_MCP_SERVER_ID, FAKE_RESOURCE_URIS.binary);
    expect(result.contents.length).toBe(1);
    expect(result.contents[0].blob).toBe(FAKE_BINARY_BASE64);
    expect(result.contents[0].mimeType).toBe("application/octet-stream");
    expect(result.contents[0].text).toBeUndefined();
  });

  it("classifies unknown-resource errors from the MCP server", async () => {
    const error = await rejectionOf(() =>
      client.readResource(FAKE_MCP_SERVER_ID, "fake://resources/does-not-exist")
    );
    expect(error.mcpErrorCategory).toBe("REMOTE_TOOL");
    expect(error.message).toContain("not found");
  });

  it("rejects malformed server payloads as classified errors", async () => {
    const error = await rejectionOf(() =>
      client.readResource(FAKE_MCP_SERVER_ID, FAKE_RESOURCE_URIS.malformed)
    );
    expect(error.mcpErrorCategory).toBe("INTERNAL");
  });

  it("lists prompts with argument metadata", async () => {
    const prompts = await client.listPrompts(FAKE_MCP_SERVER_ID);
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([...FAKE_PROMPT_NAMES].sort());

    const codeReview = prompts.find((prompt) => prompt.name === "code_review")!;
    expect(codeReview.description).toBe("Reviews a code snippet.");
    expect(codeReview.arguments).toEqual([
      { name: "language", description: undefined, required: true },
      { name: "code", description: undefined, required: true }
    ]);

    const welcome = prompts.find((prompt) => prompt.name === "welcome")!;
    expect(welcome.arguments).toEqual([]);
  });

  it("gets a prompt without arguments", async () => {
    const result = await client.getPrompt(FAKE_MCP_SERVER_ID, "welcome");
    expect(result.serverId).toBe(FAKE_MCP_SERVER_ID);
    expect(result.name).toBe("welcome");
    expect(result.messages).toEqual([
      { role: "user", content: { type: "text", text: "Welcome to the AI-SE fake MCP server." } }
    ]);
  });

  it("passes prompt arguments through and converts the messages", async () => {
    const result = await client.getPrompt(FAKE_MCP_SERVER_ID, "code_review", {
      language: "TypeScript",
      code: "const x = 1;"
    });
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toEqual({
      type: "text",
      text: "Review this TypeScript code:\nconst x = 1;"
    });
  });

  it("converts embedded resource messages", async () => {
    const result = await client.getPrompt(FAKE_MCP_SERVER_ID, "attach");
    expect(result.messages.length).toBe(2);
    expect(result.messages[1].content).toEqual({
      type: "resource",
      resource: {
        uri: FAKE_RESOURCE_URIS.greeting,
        mimeType: "text/plain",
        text: FAKE_GREETING_TEXT
      }
    });
  });

  it("classifies unknown-prompt and invalid-argument errors", async () => {
    const unknown = await rejectionOf(() => client.getPrompt(FAKE_MCP_SERVER_ID, "nope"));
    expect(unknown.mcpErrorCategory).toBe("REMOTE_TOOL");

    const invalidArgs = await rejectionOf(() =>
      client.getPrompt(FAKE_MCP_SERVER_ID, "code_review", { language: "TypeScript" })
    );
    expect(invalidArgs.mcpErrorCategory).toBe("REMOTE_TOOL");
  });

  it("keeps the tool surface unchanged while serving resources/prompts", async () => {
    const echo = (await client.callTool(FAKE_MCP_SERVER_ID, "echo", { ok: true })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(echo.content[0].text)).toEqual({ ok: true });
    const tools = await client.listTools(FAKE_MCP_SERVER_ID);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "failing", "slow"]);
  });

  describe("adapter runtime behaviors (timeout / cancellation / audit / redaction)", () => {
    function auditSink(): { events: MCPCapabilityAuditEvent[] } {
      return { events: [] };
    }

    it("times out slow reads with the existing TIMEOUT classification", async () => {
      const adapter = createMCPResourceAdapter(client, FAKE_MCP_SERVER_ID, { timeoutMs: 100 });
      const started = Date.now();
      const error = await rejectionOf(() => adapter.readResource(FAKE_RESOURCE_URIS.slow));
      expect(error.mcpErrorCategory).toBe("TIMEOUT");
      expect(Date.now() - started).toBeLessThan(380);
    });

    it("honours caller cancellation (pre-aborted and mid-flight)", async () => {
      const adapter = createMCPResourceAdapter(client, FAKE_MCP_SERVER_ID);

      const preAborted = new AbortController();
      preAborted.abort();
      const preError = await rejectionOf(() =>
        adapter.readResource(FAKE_RESOURCE_URIS.slow, preAborted.signal)
      );
      expect(preError.mcpErrorCategory).toBe("CANCELLED");

      const controller = new AbortController();
      const pending = adapter.readResource(FAKE_RESOURCE_URIS.slow, controller.signal);
      setTimeout(() => controller.abort(), 50);
      const midError = await rejectionOf(() => pending);
      expect(midError.mcpErrorCategory).toBe("CANCELLED");
    });

    it("emits audit events for success, denial and failure — and never stores state", async () => {
      const sink = auditSink();
      const allowed = createMCPResourceAdapter(client, FAKE_MCP_SERVER_ID, {
        audit: (event) => {
          sink.events.push(event);
        }
      });
      await allowed.readResource(FAKE_RESOURCE_URIS.greeting);
      expect(sink.events).toEqual([
        expect.objectContaining({
          capability: "resource",
          serverId: FAKE_MCP_SERVER_ID,
          target: FAKE_RESOURCE_URIS.greeting,
          outcome: "succeeded"
        })
      ]);

      const denied = createMCPResourceAdapter(client, FAKE_MCP_SERVER_ID, {
        canAccess: () => false,
        audit: (event) => {
          sink.events.push(event);
        }
      });
      await rejectionOf(() => denied.readResource(FAKE_RESOURCE_URIS.greeting));
      expect(sink.events[1]).toEqual(
        expect.objectContaining({ outcome: "denied", errorCategory: "PERMISSION_DENIED" })
      );

      const failing = createMCPPromptAdapter(client, FAKE_MCP_SERVER_ID, {
        audit: (event) => {
          sink.events.push(event);
        }
      });
      await rejectionOf(() => failing.getPrompt("nope"));
      expect(sink.events[2]).toEqual(
        expect.objectContaining({ capability: "prompt", target: "nope", outcome: "failed" })
      );
    });

    it("redacts credential-shaped text from error messages", async () => {
      const adapter = createMCPResourceAdapter(client, FAKE_MCP_SERVER_ID);
      const error = await rejectionOf(() => adapter.readResource(FAKE_RESOURCE_URIS.leaky));
      expect(error.message).toContain("[REDACTED]");
      expect(error.message).not.toContain("sk-live1234567890abcdef");
    });
  });
});
