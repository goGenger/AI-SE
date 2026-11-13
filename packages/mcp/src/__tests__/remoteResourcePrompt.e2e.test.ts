import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCPClientError } from "../client/MCPClientError";
import { RemoteMCPClient } from "../client/RemoteMCPClient";
import { createMCPPromptAdapter } from "../integration/promptAdapter";
import { createMCPResourceAdapter } from "../integration/resourceAdapter";
import {
  FAKE_BINARY_BASE64,
  FAKE_GREETING_TEXT,
  FAKE_PROMPT_NAMES,
  FAKE_RESOURCE_URIS
} from "../testing/fakeMCPServer";
import {
  FAKE_HTTP_SERVER_ID,
  createFakeHTTPServerDefinition,
  startFakeHTTPServer
} from "../testing/fakeHTTPServer";
import type { FakeHTTPServerHandle } from "../testing/fakeHTTPServer";

/**
 * Phase 5.5-6 E2E over the REAL Streamable HTTP transport (official SDK
 * fixture): resources/prompts work identically to stdio, and denied
 * capability calls never reach the HTTP server (fixture hit counter).
 */

async function rejectionOf(run: () => Promise<unknown>): Promise<MCPClientError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(MCPClientError);
    return error as MCPClientError;
  }
  throw new Error("Expected the call to fail");
}

describe("resources & prompts over real Streamable HTTP MCP", () => {
  let fake: FakeHTTPServerHandle;
  let client: RemoteMCPClient;

  beforeAll(async () => {
    fake = await startFakeHTTPServer({});
    client = new RemoteMCPClient({});
    await client.connect(createFakeHTTPServerDefinition(fake.endpoint));
  });

  afterAll(async () => {
    await client.disconnect(FAKE_HTTP_SERVER_ID).catch(() => undefined);
    await fake.stop();
  });

  it("lists and reads resources over Streamable HTTP", async () => {
    const resources = await client.listResources(FAKE_HTTP_SERVER_ID);
    expect(resources.map((resource) => resource.name).sort()).toEqual([
      "binary",
      "counter",
      "greeting",
      "leaky",
      "malformed",
      "slow"
    ]);

    const text = await client.readResource(FAKE_HTTP_SERVER_ID, FAKE_RESOURCE_URIS.greeting);
    expect(text.contents[0].text).toBe(FAKE_GREETING_TEXT);
    expect(text.contents[0].mimeType).toBe("text/plain");

    const blob = await client.readResource(FAKE_HTTP_SERVER_ID, FAKE_RESOURCE_URIS.binary);
    expect(blob.contents[0].blob).toBe(FAKE_BINARY_BASE64);
  });

  it("lists and gets prompts over Streamable HTTP (arguments included)", async () => {
    const prompts = await client.listPrompts(FAKE_HTTP_SERVER_ID);
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([...FAKE_PROMPT_NAMES].sort());

    const welcome = await client.getPrompt(FAKE_HTTP_SERVER_ID, "welcome");
    expect(welcome.messages[0].content).toEqual({
      type: "text",
      text: "Welcome to the AI-SE fake MCP server."
    });

    const review = await client.getPrompt(FAKE_HTTP_SERVER_ID, "code_review", {
      language: "Go",
      code: 'fmt.Println("hi")'
    });
    expect(review.messages[0].content).toEqual({
      type: "text",
      text: 'Review this Go code:\nfmt.Println("hi")'
    });
  });

  it("classifies server-side errors over HTTP", async () => {
    const error = await rejectionOf(() =>
      client.readResource(FAKE_HTTP_SERVER_ID, "fake://resources/does-not-exist")
    );
    expect(error.mcpErrorCategory).toBe("REMOTE_TOOL");
  });

  it("keeps denied capability calls at zero HTTP requests", async () => {
    const deniedResource = createMCPResourceAdapter(client, FAKE_HTTP_SERVER_ID, {
      canAccess: () => false
    });
    const deniedPrompt = createMCPPromptAdapter(client, FAKE_HTTP_SERVER_ID, {
      canAccess: () => false
    });

    const before = (await fake.hits()).hits;
    const read = await rejectionOf(() => deniedResource.readResource(FAKE_RESOURCE_URIS.greeting));
    expect(read.mcpErrorCategory).toBe("PERMISSION_DENIED");
    const get = await rejectionOf(() => deniedPrompt.getPrompt("welcome"));
    expect(get.mcpErrorCategory).toBe("PERMISSION_DENIED");
    expect((await fake.hits()).hits).toBe(before);
  });

  it("keeps policy-denied reads at zero HTTP requests", async () => {
    const policyDenied = createMCPResourceAdapter(client, FAKE_HTTP_SERVER_ID, {
      policy: (resource) =>
        resource.uri === FAKE_RESOURCE_URIS.binary ? undefined : { riskLevel: "LOW" }
    });
    const before = (await fake.hits()).hits;
    const denied = await rejectionOf(() => policyDenied.readResource(FAKE_RESOURCE_URIS.binary));
    expect(denied.mcpErrorCategory).toBe("PERMISSION_DENIED");
    expect((await fake.hits()).hits).toBe(before);

    await policyDenied.readResource(FAKE_RESOURCE_URIS.greeting);
  });

  it("redacts credential-shaped server text over HTTP", async () => {
    const adapter = createMCPResourceAdapter(client, FAKE_HTTP_SERVER_ID);
    const error = await rejectionOf(() => adapter.readResource(FAKE_RESOURCE_URIS.leaky));
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("sk-live1234567890abcdef");
  });

  it("keeps the tool surface unchanged over HTTP", async () => {
    const echo = (await client.callTool(FAKE_HTTP_SERVER_ID, "echo", { ok: 1 })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(echo.content[0].text)).toEqual({ ok: 1 });
    expect((await client.listTools(FAKE_HTTP_SERVER_ID)).map((tool) => tool.name).sort()).toEqual([
      "echo",
      "failing",
      "slow"
    ]);
  });
});
