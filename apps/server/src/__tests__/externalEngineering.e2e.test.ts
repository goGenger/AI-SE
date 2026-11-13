/**
 * Phase 5.7-2 e2e: the AGENT-side boundary for external engineering tools.
 *
 *   Agent permissions → ToolRuntimeBackend → ToolRuntime → ExternalToolDefinition
 *   → MCPToolAdapter → MCP client → REAL MCP stdio → mock external system
 *
 * Verifies that the existing agent-tool permission gate (AgentPermissions.tools,
 * the 5.5-era mechanism — no second permission system) governs external tools:
 * denied tools never reach the MCP server (zero requests); permitted ones run
 * through the frozen ToolRuntime with audit records; hostile external content
 * stays inert data. Also statically asserts that agent-core has no direct MCP /
 * external-API dependency. Zero external network.
 */
import { ToolRuntimeBackend, type AgentContext, type AgentPermissions } from "@ai-se/agent-core";
import {
  createExternalToolRegistry,
  createFakeExternalSystemEntry,
  ExternalEngineeringConnector,
  ExternalToolCatalog,
  FAKE_EXTERNAL_SERVER_ID,
  type ExternalToolOutcome,
  type MCPClientPort,
  type MCPServerDefinition,
  type MCPToolDefinition,
  StdioMCPClient
} from "@ai-se/mcp";
import type { ActionResult } from "@ai-se/shared";
import {
  ToolRuntime,
  type ToolCallFinishedRecord,
  type ToolCallStartedRecord
} from "@ai-se/tool-runtime";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

class CountingMCPClient implements MCPClientPort {
  private readonly counts = new Map<string, number>();

  constructor(private readonly delegate: MCPClientPort) {}

  totalRequests(): number {
    return [...this.counts.values()].reduce((sum, count) => sum + count, 0);
  }

  async connect(server: MCPServerDefinition): Promise<void> {
    return await this.delegate.connect(server);
  }

  async disconnect(serverId: string): Promise<void> {
    return await this.delegate.disconnect(serverId);
  }

  async listTools(serverId: string): Promise<MCPToolDefinition[]> {
    return await this.delegate.listTools(serverId);
  }

  async callTool(
    serverId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
    return await this.delegate.callTool(serverId, name, input, signal);
  }

  async listResources(serverId: string) {
    return await this.delegate.listResources(serverId);
  }

  async readResource(serverId: string, uri: string, signal?: AbortSignal) {
    return await this.delegate.readResource(serverId, uri, signal);
  }

  async listPrompts(serverId: string) {
    return await this.delegate.listPrompts(serverId);
  }

  async getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal
  ) {
    return await this.delegate.getPrompt(serverId, name, args, signal);
  }
}

interface Recorder {
  started: ToolCallStartedRecord[];
  finished: ToolCallFinishedRecord[];
}

function makeRecorder(): {
  recorder: Recorder;
  api: {
    recordToolCallStarted(r: ToolCallStartedRecord): Promise<void>;
    recordToolCallFinished(r: ToolCallFinishedRecord): Promise<void>;
  };
} {
  const recorder: Recorder = { started: [], finished: [] };
  return {
    recorder,
    api: {
      async recordToolCallStarted(record) {
        recorder.started.push(record);
      },
      async recordToolCallFinished(record) {
        recorder.finished.push(record);
      }
    }
  };
}

describe("5.7-2 agent-path e2e: permissions gate external engineering tools", () => {
  it("denied tools never reach the MCP server; permitted tools run with audit; hostile data stays inert", async () => {
    const client = new CountingMCPClient(new StdioMCPClient());
    const catalog = new ExternalToolCatalog([createFakeExternalSystemEntry()]);
    const registry = createExternalToolRegistry({ client, catalog });
    const connector = new ExternalEngineeringConnector({ client, catalog, registry });
    await connector.connectAll();
    registry.bindProject({ projectId: "proj-1", serverId: FAKE_EXTERNAL_SERVER_ID });
    registry.bindAgent({
      projectId: "proj-1",
      agentName: "dev-agent",
      serverId: FAKE_EXTERNAL_SERVER_ID
    });
    const definitions = connector.toolDefinitions({ projectId: "proj-1", agentName: "dev-agent" });
    const runtime = new ToolRuntime({ tools: definitions });
    const { recorder, api } = makeRecorder();
    const context = {
      requestId: "req-ext-agent-1",
      projectId: "proj-1",
      taskId: "task-ext-agent-1",
      agentRunId: "run-ext-agent-1",
      actor: "external-engineering-agent",
      workspacePath: process.cwd(),
      sandbox: {
        async runCommand() {
          throw new Error("external engineering tests never touch the sandbox");
        }
      }
    } as unknown as AgentContext;
    try {
      // 1. Tool NOT granted → the existing permission gate denies it, zero MCP requests.
      const deniedBackend = new ToolRuntimeBackend({
        runtime,
        permissions: { tools: ["read_file"], readPaths: [], writePaths: [] } as AgentPermissions,
        context
      });
      const denied = await deniedBackend.executeTool("issues.create", { title: "Denied" });
      expect(denied.success).toBe(false);
      expect(denied.error?.message).toContain("not permitted");
      expect(client.totalRequests()).toBe(0);
      expect(recorder.started).toHaveLength(0);

      // 2. Tool granted → real MCP call through the backend, ActionResult + audit.
      const grantedBackend = new ToolRuntimeBackend({
        runtime,
        permissions: {
          tools: ["issues.create"],
          readPaths: [],
          writePaths: []
        } as AgentPermissions,
        context,
        toolCallRecorder: api
      });
      const created = await grantedBackend.executeTool("issues.create", {
        title: "Agent-created issue"
      });
      expect(created.success).toBe(true);
      const outcome = created.data as ExternalToolOutcome;
      const actionResult = outcome.actionResult as ActionResult;
      expect(actionResult.status).toBe("success");
      expect(actionResult.actionRef).toMatchObject({
        source: "mcp",
        serverName: "github",
        toolName: "issues.create"
      });
      expect(outcome.result).toMatchObject({ id: "ISS-101", title: "Agent-created issue" });

      // 3. Audit: the granted call was recorded start → finish.
      expect(recorder.started.map((record) => record.toolName)).toEqual(["issues.create"]);
      expect(recorder.finished.map((record) => record.status)).toEqual(["succeeded"]);

      // 4. Hostile external content through the agent path stays inert data.
      const hostileBackend = new ToolRuntimeBackend({
        runtime,
        permissions: {
          tools: ["fixture.hostile"],
          readPaths: [],
          writePaths: []
        } as AgentPermissions,
        context
      });
      const requestsBefore = client.totalRequests();
      const hostile = await hostileBackend.executeTool("fixture.hostile", { kind: "instruction" });
      expect(hostile.success).toBe(true);
      const hostileOutcome = hostile.data as ExternalToolOutcome;
      expect(hostileOutcome.actionResult.status).toBe("success");
      expect(JSON.stringify(hostileOutcome.actionResult)).not.toContain(
        "IGNORE ALL PREVIOUS INSTRUCTIONS"
      );
      expect(JSON.stringify(hostileOutcome.result)).toContain("IGNORE ALL PREVIOUS INSTRUCTIONS");
      expect(client.totalRequests()).toBe(requestsBefore + 1);
    } finally {
      await registry.disconnectAll();
    }
  }, 120_000);
});

describe("5.7-2 boundary: agent code has no direct MCP / external API dependency", () => {
  it("agent-core never imports @ai-se/mcp or an external API client", () => {
    const repoRoot = path.resolve(process.cwd(), "../..");
    const grep = spawnSync(
      "grep",
      [
        "-rnE",
        "@ai-se/mcp|@octokit|octokit|node:https|node:http|fetch\\(",
        "packages/agent-core/src",
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
