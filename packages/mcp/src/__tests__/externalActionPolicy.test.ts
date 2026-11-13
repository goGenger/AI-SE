import { ActionResultSchema } from "@ai-se/shared";
import { ToolRuntime, type ToolCallRecorder, type ToolExecutionContext } from "@ai-se/tool-runtime";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MCPClientPort, MCPServerDefinition, MCPToolDefinition } from "../contracts";
import { ExternalToolCatalog } from "../external/catalog";
import { createExternalToolRegistry, ExternalEngineeringConnector } from "../external/connector";
import {
  createFakeExternalSystemEntry,
  FAKE_EXTERNAL_SERVER_ID
} from "../testing/externalSystemServer";

/**
 * Phase 5.7-3: the unified Action Policy is the final authority over external
 * action risk — catalog declarations are INPUTS. Misdeclared-low entries are
 * raised to the policy decision, HIGH actions get the approval gate (zero
 * requests when denied), and ToolRuntime audit carries the policy risk level.
 */

const TOOL_NAMES = ["issues.list", "issues.create", "releases.publish"] as const;

class FakeExternalClient implements MCPClientPort {
  readonly calls: string[] = [];

  requestCount(toolName: string): number {
    return this.calls.filter((name) => name === toolName).length;
  }

  async connect(_server: MCPServerDefinition): Promise<void> {}

  async disconnect(_serverId: string): Promise<void> {}

  async listTools(_serverId: string): Promise<MCPToolDefinition[]> {
    return TOOL_NAMES.map((name) => ({
      serverId: FAKE_EXTERNAL_SERVER_ID,
      name,
      description: `Remote description for ${name}.`,
      inputSchema:
        name === "issues.list"
          ? { type: "object", properties: {} }
          : { type: "object", properties: { tag: { type: "string" }, title: { type: "string" } } }
    }));
  }

  async callTool(_serverId: string, name: string, input: unknown): Promise<unknown> {
    this.calls.push(name);
    const args = (input ?? {}) as Record<string, unknown>;
    if (name === "releases.publish")
      return { structuredContent: { tag: args.tag, published: true } };
    if (name === "issues.create") return { structuredContent: { id: "ISS-1", title: args.title } };
    return { structuredContent: { issues: [] } };
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

const memoryRecorder: ToolCallRecorder = {
  async recordToolCallStarted() {},
  async recordToolCallFinished() {}
};

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    requestId: "req-policy-ext",
    projectId: "proj-1",
    taskId: "task-1",
    agentRunId: "run-1",
    toolCallId: randomUUID(),
    actor: "policy-e2e",
    workspacePath: "/workspace",
    sandbox: {
      async runCommand() {
        throw new Error("external policy tests never touch the sandbox");
      }
    },
    toolCallRecorder: memoryRecorder,
    ...overrides
  } as unknown as ToolExecutionContext;
}

/** Catalog where releases.publish is MISDECLARED low — the policy must raise it. */
function misdeclaredCatalog(): ExternalToolCatalog {
  const base = createFakeExternalSystemEntry();
  return new ExternalToolCatalog([
    {
      ...base,
      tools: [
        { name: "issues.list", riskLevel: "LOW", requiresApproval: false },
        { name: "issues.create", riskLevel: "LOW", requiresApproval: false }, // floor raises to MEDIUM
        { name: "releases.publish", riskLevel: "LOW", requiresApproval: false } // floor raises to HIGH + approval
      ]
    }
  ]);
}

async function setup(options: { approvalGate?: (context: ToolExecutionContext) => boolean } = {}) {
  const client = new FakeExternalClient();
  const catalog = misdeclaredCatalog();
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
  return { client, connector };
}

describe("5.7-3 external actions: the policy raises misdeclared-low risk", () => {
  it("descriptors and ToolDefinitions carry the POLICY decision, not the catalog declaration", async () => {
    const { connector } = await setup();
    const descriptors = connector.descriptors({ projectId: "proj-1", agentName: "dev-agent" });
    expect(descriptors.find((entry) => entry.toolName === "releases.publish")).toMatchObject({
      riskLevel: "HIGH",
      requiresApproval: true
    });
    expect(descriptors.find((entry) => entry.toolName === "issues.create")).toMatchObject({
      riskLevel: "MEDIUM",
      requiresApproval: false
    });

    const definitions = connector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" });
    expect(definitions.find((def) => def.name === "releases.publish")?.riskLevel).toBe("HIGH");
    expect(definitions.find((def) => def.name === "issues.create")?.riskLevel).toBe("MEDIUM");
    expect(definitions.find((def) => def.name === "issues.list")?.riskLevel).toBe("LOW");
  });

  it("HIGH (raised) action denied: zero MCP requests, audit carries the policy risk", async () => {
    const { client, connector } = await setup();
    const runtime = new ToolRuntime({
      tools: connector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" })
    });
    // No approval gate wired → adapter fails closed with APPROVAL_REQUIRED.
    const denied = await runtime.execute("releases.publish", { tag: "v1" }, makeContext());
    expect(denied.success).toBe(false);
    expect(denied.error?.message).toContain("approval");
    expect(denied.audit.riskLevel).toBe("HIGH");
    expect(client.requestCount("releases.publish")).toBe(0);

    // Gate explicitly denying → still zero requests.
    const { client: deniedClient, connector: deniedConnector } = await setup({
      approvalGate: () => false
    });
    const deniedRuntime = new ToolRuntime({
      tools: deniedConnector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" })
    });
    const rejected = await deniedRuntime.execute("releases.publish", { tag: "v1" }, makeContext());
    expect(rejected.success).toBe(false);
    expect(rejected.error?.message).toContain("not approved");
    expect(deniedClient.requestCount("releases.publish")).toBe(0);
  });

  it("approved HIGH action executes for real; MEDIUM raised action runs without approval", async () => {
    const { client, connector } = await setup({ approvalGate: () => true });
    const runtime = new ToolRuntime({
      tools: connector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" })
    });

    const published = await runtime.execute("releases.publish", { tag: "v9" }, makeContext());
    expect(published.success).toBe(true);
    const outcome = published.data as { actionResult: unknown; result?: { published?: boolean } };
    expect(ActionResultSchema.parse(outcome.actionResult).status).toBe("success");
    expect(outcome.result?.published).toBe(true);
    expect(client.requestCount("releases.publish")).toBe(1);

    const created = await runtime.execute(
      "issues.create",
      { title: "From policy test" },
      makeContext()
    );
    expect(created.success).toBe(true);
    expect(created.audit.riskLevel).toBe("MEDIUM");
    expect(client.requestCount("issues.create")).toBe(1);
  });
});
