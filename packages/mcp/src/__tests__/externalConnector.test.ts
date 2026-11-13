import { ActionResultSchema } from "@ai-se/shared";
import {
  ToolCallFinishedRecord,
  ToolCallRecorder,
  ToolCallStartedRecord,
  ToolExecutionContext,
  ToolRuntime
} from "@ai-se/tool-runtime";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MCPClientError } from "../client/MCPClientError";
import { MCPClientPort, MCPServerDefinition, MCPToolDefinition } from "../contracts";
import { ExternalToolCatalog } from "../external/catalog";
import { createExternalToolRegistry, ExternalEngineeringConnector } from "../external/connector";
import { redactUntrustedExternalData } from "../external/outcome";
import {
  createFakeExternalSystemEntry,
  FAKE_EXTERNAL_SERVER_ID,
  FAKE_HOSTILE_PAYLOADS
} from "../testing/externalSystemServer";

/** Phase 5.7-2: connector unit coverage over a canned (non-process) MCP client. */

const TOOL_NAMES = [
  "issues.list",
  "issues.create",
  "ci.status",
  "docs.search",
  "issues.fail",
  "issues.slow",
  "releases.publish",
  "fixture.hostile"
] as const;

const TOOL_SCHEMAS: Record<string, unknown> = {
  "issues.list": {
    type: "object",
    properties: { state: { type: "string", enum: ["open", "closed"] } }
  },
  "issues.create": {
    type: "object",
    properties: { title: { type: "string", minLength: 1 } },
    required: ["title"]
  },
  "ci.status": {
    type: "object",
    properties: { runId: { type: "string" } },
    required: ["runId"]
  },
  "docs.search": {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"]
  },
  "issues.fail": { type: "object", properties: { message: { type: "string" } } },
  "issues.slow": {
    type: "object",
    properties: { delayMs: { type: "number" } },
    required: ["delayMs"]
  },
  "releases.publish": {
    type: "object",
    properties: { tag: { type: "string", minLength: 1 } },
    required: ["tag"]
  },
  "fixture.hostile": {
    type: "object",
    properties: { kind: { type: "string" } },
    required: ["kind"]
  },
  "secrets.export": { type: "object", properties: {} }
};

const DISCOVERED: MCPToolDefinition[] = TOOL_NAMES.map((name) => ({
  serverId: FAKE_EXTERNAL_SERVER_ID,
  name,
  description: `Remote description for ${name}.`,
  inputSchema: TOOL_SCHEMAS[name] ?? { type: "object", properties: {} }
}));
// The remote server also exposes a tool the catalog does NOT declare: it must
// stay invisible / unusable (platform allowlist wins over remote discovery).
DISCOVERED.push({
  serverId: FAKE_EXTERNAL_SERVER_ID,
  name: "secrets.export",
  description: "Exports secrets (undeclared — must never be mapped).",
  inputSchema: TOOL_SCHEMAS["secrets.export"]
});

class FakeExternalClient implements MCPClientPort {
  readonly calls: string[] = [];

  requestCount(toolName: string): number {
    return this.calls.filter((name) => name === toolName).length;
  }

  async connect(_server: MCPServerDefinition): Promise<void> {}

  async disconnect(_serverId: string): Promise<void> {}

  async listTools(_serverId: string): Promise<MCPToolDefinition[]> {
    return DISCOVERED.map((tool) => ({ ...tool }));
  }

  async callTool(
    _serverId: string,
    name: string,
    input: unknown,
    _signal?: AbortSignal
  ): Promise<unknown> {
    this.calls.push(name);
    const args = (input ?? {}) as Record<string, unknown>;
    switch (name) {
      case "issues.list":
        return {
          structuredContent: { issues: [{ id: "ISS-1", title: "Crash on login", state: "open" }] }
        };
      case "issues.create":
        return {
          structuredContent: {
            id: "ISS-101",
            title: args.title,
            state: "open",
            url: "https://github.example/Issues/101"
          }
        };
      case "ci.status":
        return { structuredContent: { runId: args.runId, conclusion: "success", failedJobs: 0 } };
      case "docs.search":
        return { structuredContent: { results: [{ title: `Doc for ${args.query}` }] } };
      case "issues.fail":
        throw new MCPClientError(
          "REMOTE_TOOL",
          typeof args.message === "string" ? args.message : "remote issue tracker failure"
        );
      case "issues.slow":
        return { structuredContent: { delayMs: args.delayMs, waitedMs: args.delayMs } };
      case "releases.publish":
        return { structuredContent: { tag: args.tag, published: true } };
      case "fixture.hostile":
        return {
          structuredContent: {
            kind: args.kind,
            text: FAKE_HOSTILE_PAYLOADS[args.kind as keyof typeof FAKE_HOSTILE_PAYLOADS]
          }
        };
      case "secrets.export":
        return { structuredContent: { exported: true } };
      default:
        throw new MCPClientError("REMOTE_TOOL", `unknown tool ${name}`);
    }
  }

  async listResources(): Promise<never[]> {
    return [];
  }

  async readResource(): Promise<never> {
    throw new Error("not supported");
  }

  async listPrompts(): Promise<never[]> {
    return [];
  }

  async getPrompt(): Promise<never> {
    throw new Error("not supported");
  }
}

class MemoryToolCallRecorder implements ToolCallRecorder {
  readonly started: ToolCallStartedRecord[] = [];
  readonly finished: ToolCallFinishedRecord[] = [];

  async recordToolCallStarted(record: ToolCallStartedRecord): Promise<void> {
    this.started.push(record);
  }

  async recordToolCallFinished(record: ToolCallFinishedRecord): Promise<void> {
    this.finished.push(record);
  }
}

const fakeSandbox = {
  async runCommand() {
    return { command: "", exitCode: 0, stdout: "", stderr: "", duration: 0, timedOut: false };
  }
};

function makeContext(
  recorder: ToolCallRecorder,
  overrides: Partial<ToolExecutionContext> = {}
): ToolExecutionContext {
  return {
    requestId: "req-external-1",
    projectId: "proj-1",
    taskId: "task-1",
    agentRunId: "run-1",
    toolCallId: randomUUID(),
    actor: "engineering-agent",
    workspacePath: "/workspace",
    sandbox: fakeSandbox,
    toolCallRecorder: recorder,
    ...overrides
  };
}

async function setupConnector(
  options: {
    approvalGate?: (context: ToolExecutionContext) => boolean | Promise<boolean>;
  } = {}
) {
  const client = new FakeExternalClient();
  const catalog = new ExternalToolCatalog([createFakeExternalSystemEntry()]);
  const registry = createExternalToolRegistry({
    client,
    catalog,
    approvalGate: options.approvalGate
  });
  const connector = new ExternalEngineeringConnector({
    client,
    catalog,
    registry,
    approvalGate: options.approvalGate
  });
  await connector.connectAll();
  registry.bindProject({ projectId: "proj-1", serverId: FAKE_EXTERNAL_SERVER_ID });
  registry.bindAgent({
    projectId: "proj-1",
    agentName: "dev-agent",
    serverId: FAKE_EXTERNAL_SERVER_ID
  });
  return { client, catalog, registry, connector };
}

describe("5.7-2 ExternalEngineeringConnector: mapping + ToolRuntime execution", () => {
  it("maps only catalog-declared discovered tools onto ToolDefinitions with platform risk", async () => {
    const { connector } = await setupConnector();
    const definitions = connector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" });
    const names = definitions.map((definition) => definition.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(names).not.toContain("secrets.export");

    const publish = definitions.find((definition) => definition.name === "releases.publish");
    expect(publish?.riskLevel).toBe("HIGH");
    const create = definitions.find((definition) => definition.name === "issues.create");
    expect(create?.description).toContain("External issue-tracker action");

    // Schema validation is single-sourced from the 5.5-2 JSON Schema → Zod conversion.
    expect(create?.inputSchema.safeParse({ title: "Fix login" }).success).toBe(true);
    expect(create?.inputSchema.safeParse({}).success).toBe(false);
    expect(create?.inputSchema.safeParse({ title: 42 }).success).toBe(false);

    const descriptors = connector.descriptors({ projectId: "proj-1", agentName: "dev-agent" });
    expect(descriptors).toHaveLength(TOOL_NAMES.length);
    expect(descriptors.find((entry) => entry.toolName === "releases.publish")).toMatchObject({
      systemId: "github",
      category: "issue-tracker",
      serverName: "github",
      riskLevel: "HIGH",
      requiresApproval: true
    });
  });

  it("unauthorized queries expose nothing; stale bindings deny at call time with ZERO MCP requests", async () => {
    const { client, registry, connector } = await setupConnector();
    // No bindings → no tools visible at all.
    expect(connector.toolDefinitions({ projectId: "proj-1", agentName: "other-agent" })).toEqual(
      []
    );

    // Bindings revoked AFTER definitions were built → the call-time re-check denies.
    const definitions = connector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" });
    registry.unbindAgent("proj-1", "dev-agent", FAKE_EXTERNAL_SERVER_ID);
    const runtime = new ToolRuntime({ tools: definitions });
    const recorder = new MemoryToolCallRecorder();
    const result = await runtime.execute(
      "issues.create",
      { title: "Stale call" },
      makeContext(recorder)
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("not permitted");
    expect(client.requestCount("issues.create")).toBe(0);
    expect(client.calls).toEqual([]);
  });

  it("invalid input fails schema validation with zero MCP requests", async () => {
    const { client, connector } = await setupConnector();
    const runtime = new ToolRuntime({
      tools: connector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" })
    });
    const recorder = new MemoryToolCallRecorder();
    const result = await runtime.execute("issues.create", {}, makeContext(recorder));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_ERROR");
    // Validation rejected the call before any MCP request was sent.
    expect(client.requestCount("issues.create")).toBe(0);
    // The runtime still audited the attempt: started + failed finish.
    expect(recorder.started.map((record) => record.toolName)).toEqual(["issues.create"]);
    expect(recorder.finished[0]?.status).toBe("failed");
    expect(recorder.finished[0]?.error).toBeDefined();
  });

  it("success: outcome carries the frozen ActionResult + untrusted result data, audit recorded", async () => {
    const { client, connector } = await setupConnector();
    const runtime = new ToolRuntime({
      tools: connector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" })
    });
    const recorder = new MemoryToolCallRecorder();
    const context = makeContext(recorder, { toolCallId: "call-create-1" });
    const result = await runtime.execute("issues.create", { title: "Fix login" }, context);
    expect(result.success).toBe(true);
    expect(client.requestCount("issues.create")).toBe(1);

    const outcome = result.data as { actionResult: unknown; result?: unknown };
    const actionResult = ActionResultSchema.parse(outcome.actionResult);
    expect(actionResult.status).toBe("success");
    expect(actionResult.actionRef).toEqual({
      source: "mcp",
      serverName: "github",
      toolName: "issues.create",
      callId: "call-create-1"
    });
    expect(actionResult.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.result).toMatchObject({ id: "ISS-101", title: "Fix login" });

    expect(recorder.started.map((record) => record.toolName)).toEqual(["issues.create"]);
    expect(recorder.finished.map((record) => record.status)).toEqual(["succeeded"]);
  });

  it("failed: a remote tool error maps into a failed ActionResult (invocation completed)", async () => {
    const { connector } = await setupConnector();
    const runtime = new ToolRuntime({
      tools: connector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" })
    });
    const recorder = new MemoryToolCallRecorder();
    const result = await runtime.execute("issues.fail", {}, makeContext(recorder));
    expect(result.success).toBe(true);
    const outcome = result.data as { actionResult: unknown; result?: unknown };
    const actionResult = ActionResultSchema.parse(outcome.actionResult);
    expect(actionResult.status).toBe("failed");
    expect(actionResult.error?.code).toBe("MCP_REMOTE_TOOL");
    expect(actionResult.error?.message).toContain("remote issue tracker failure");
    expect(outcome.result).toBeUndefined();
  });

  it("cancelled: a pre-aborted signal yields a cancelled ActionResult with zero requests", async () => {
    const { client, connector } = await setupConnector();
    const definition = connector
      .toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" })
      .find((entry) => entry.name === "issues.create");
    const recorder = new MemoryToolCallRecorder();
    const controller = new AbortController();
    controller.abort();
    const outcome = (await definition?.execute(
      { title: "Cancel me" },
      makeContext(recorder, { signal: controller.signal })
    )) as { actionResult: unknown };
    const actionResult = ActionResultSchema.parse(outcome.actionResult);
    expect(actionResult.status).toBe("cancelled");
    expect(actionResult.cancelledAt).toBeDefined();
    expect(client.requestCount("issues.create")).toBe(0);
  });

  it("approval: fail-closed without a gate, zero requests on denial, runs when approved", async () => {
    {
      const { client, connector } = await setupConnector();
      const runtime = new ToolRuntime({
        tools: connector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" })
      });
      const result = await runtime.execute(
        "releases.publish",
        { tag: "v1.0.0" },
        makeContext(new MemoryToolCallRecorder())
      );
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("approval");
      expect(client.requestCount("releases.publish")).toBe(0);
    }
    {
      const { client, connector } = await setupConnector({ approvalGate: () => false });
      const runtime = new ToolRuntime({
        tools: connector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" })
      });
      const result = await runtime.execute(
        "releases.publish",
        { tag: "v1.0.0" },
        makeContext(new MemoryToolCallRecorder())
      );
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("not approved");
      expect(client.requestCount("releases.publish")).toBe(0);
    }
    {
      const { client, connector } = await setupConnector({ approvalGate: () => true });
      const runtime = new ToolRuntime({
        tools: connector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" })
      });
      const result = await runtime.execute(
        "releases.publish",
        { tag: "v1.0.0" },
        makeContext(new MemoryToolCallRecorder())
      );
      expect(result.success).toBe(true);
      const actionResult = ActionResultSchema.parse(
        (result.data as { actionResult: unknown }).actionResult
      );
      expect(actionResult.status).toBe("success");
      expect(client.requestCount("releases.publish")).toBe(1);
    }
  });
});

describe("5.7-2 untrusted external data: hostile payloads stay inert data", () => {
  it.each(["instruction", "system", "markdown", "link", "toolresult"] as const)(
    "kind %s: payload passes through as data and never touches control channels",
    async (kind) => {
      const { client, connector } = await setupConnector();
      const runtime = new ToolRuntime({
        tools: connector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" })
      });
      const recorder = new MemoryToolCallRecorder();
      const result = await runtime.execute("fixture.hostile", { kind }, makeContext(recorder));
      expect(result.success).toBe(true);

      const outcome = result.data as {
        actionResult: unknown;
        result?: { kind: string; text: string };
      };
      const actionResult = ActionResultSchema.parse(outcome.actionResult);
      // The action itself succeeded; the payload lives ONLY under `result` as data.
      expect(actionResult.status).toBe("success");
      expect(outcome.result?.text).toBe(FAKE_HOSTILE_PAYLOADS[kind]);
      const serializedActionResult = JSON.stringify(actionResult);
      expect(serializedActionResult).not.toContain(FAKE_HOSTILE_PAYLOADS[kind]);
      // Control channels in the audit records stay clean: the call succeeded,
      // no error was derived from the hostile text.
      expect(recorder.finished[0]?.status).toBe("succeeded");
      expect(recorder.finished[0]?.error).toBeUndefined();
      // Hostile content cannot trigger further actions: exactly one MCP request.
      expect(client.calls).toEqual(["fixture.hostile"]);
      expect(client.requestCount("releases.publish")).toBe(0);
    }
  );

  it("credential-shaped content inside external data is redacted through the shared sink", async () => {
    const { connector } = await setupConnector();
    const runtime = new ToolRuntime({
      tools: connector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" })
    });
    const recorder = new MemoryToolCallRecorder();
    const result = await runtime.execute(
      "fixture.hostile",
      { kind: "credential" },
      makeContext(recorder)
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-live1234567890abcdefghij");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redactUntrustedExternalData walks nested structures and never mutates the input", () => {
    const input = {
      message: "token sk-live1234567890abcdefghij here",
      nested: [{ header: "Bearer ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH" }]
    };
    const redacted = redactUntrustedExternalData(input) as typeof input;
    expect(JSON.stringify(redacted)).toContain("[REDACTED]");
    expect(JSON.stringify(redacted)).not.toContain("sk-live1234567890abcdefghij");
    expect(JSON.stringify(redacted)).not.toContain("ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");
    // The original stays untouched (redaction copies).
    expect(input.message).toContain("sk-live1234567890abcdefghij");
  });

  it("error paths: a credential-shaped remote error message is redacted before it becomes an ActionResult", async () => {
    const { connector } = await setupConnector();
    const runtime = new ToolRuntime({
      tools: connector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" })
    });
    const recorder = new MemoryToolCallRecorder();
    const result = await runtime.execute(
      "issues.fail",
      { message: "boom sk-live1234567890abcdefghij" },
      makeContext(recorder)
    );
    const outcome = result.data as {
      actionResult: { status: string; error?: { message: string } };
    };
    expect(outcome.actionResult.status).toBe("failed");
    expect(outcome.actionResult.error?.message).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("sk-live1234567890abcdefghij");
  });
});

describe("5.7-2 boundary: the external layer adds no direct external API surface", () => {
  it("no http/fetch/undici/sdk imports inside packages/mcp/src/external", () => {
    const repoRoot = path.resolve(process.cwd());
    const grep = spawnSync(
      "grep",
      [
        "-rnE",
        "node:http|node:https|node:net|fetch\\(|undici|axios|XMLHttpRequest|https\\.request|child_process|playwright",
        "packages/mcp/src/external",
        "--include=*.ts"
      ],
      { cwd: repoRoot, encoding: "utf8" }
    );
    const matches = (grep.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(matches).toEqual([]);
  });
});
