import {
  InMemoryMCPRegistryStore,
  PersistentMCPRegistry,
  type MCPClientPort,
  type MCPPromptDescriptor,
  type MCPPromptResult,
  type MCPResourceDescriptor,
  type MCPResourceReadResult,
  type MCPServerDefinition,
  type MCPToolDefinition
} from "@ai-se/mcp";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../http/errors";
import { createMCPRouter } from "../routes/mcp";
import { MCPConsoleService } from "../services/mcpService";

/**
 * T2：`POST /api/mcp/servers` 的 HTTP 面契约。
 *
 * 用的是**真实的** `PersistentMCPRegistry` + `InMemoryMCPRegistryStore`，
 * 只有 MCP 协议客户端是假的——因此 `validateMCPServerDefinition`（冻结契约）
 * 与「建行 → 连接 → 发现工具」的顺序都是真跑的，不是替身。
 */
class FakeClient implements MCPClientPort {
  connected: string[] = [];
  /** 让某个命令的连接失败，用来验证「建成功但连不上」的返回形态。 */
  constructor(private readonly failCommand?: string) {}

  async connect(server: MCPServerDefinition): Promise<void> {
    if (this.failCommand && server.stdio?.command === this.failCommand) {
      throw new Error("spawn ENOENT");
    }
    this.connected.push(server.id);
  }

  async disconnect(serverId: string): Promise<void> {
    this.connected = this.connected.filter((id) => id !== serverId);
  }

  async listTools(serverId: string): Promise<MCPToolDefinition[]> {
    return ["echo", "search.web"].map((name) => ({
      serverId,
      name,
      description: `fake ${name}`,
      inputSchema: { type: "object", properties: {} }
    }));
  }

  async callTool(): Promise<unknown> {
    throw new Error("callTool is not exercised by this test");
  }

  async listResources(): Promise<MCPResourceDescriptor[]> {
    return [];
  }

  async readResource(): Promise<MCPResourceReadResult> {
    throw new Error("readResource is not exercised by this test");
  }

  async listPrompts(): Promise<MCPPromptDescriptor[]> {
    return [];
  }

  async getPrompt(): Promise<MCPPromptResult> {
    throw new Error("getPrompt is not exercised by this test");
  }
}

function buildApp(failCommand?: string) {
  const store = new InMemoryMCPRegistryStore();
  const client = new FakeClient(failCommand);
  const registries = {
    stdio: new PersistentMCPRegistry({ client, store }),
    "streamable-http": new PersistentMCPRegistry({ client, store })
  };
  const service = new MCPConsoleService({ store, registries });
  const app = express();
  app.use(express.json());
  app.use("/api/mcp", createMCPRouter(service));
  app.use(errorHandler(pino({ level: "silent" })));
  return { app, service };
}

describe("POST /api/mcp/servers (T2)", () => {
  it("注册 stdio 服务器：201、立即连接并发现工具", async () => {
    const { app } = buildApp();
    const response = await request(app)
      .post("/api/mcp/servers")
      .send({
        name: "github",
        description: "代码托管",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"]
      })
      .expect(201);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toMatchObject({
      name: "github",
      transport: "stdio",
      enabled: true,
      status: "CONNECTED",
      toolCount: 2,
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"]
    });
    expect(response.body.data.id).toBeTruthy();
  });

  it("stdio 缺启动命令：400，错误码来自冻结契约", async () => {
    const { app } = buildApp();
    const response = await request(app)
      .post("/api/mcp/servers")
      .send({ name: "broken", transport: "stdio" })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe("MCP_SERVER_INVALID");
  });

  it("请求体带未知字段（如 env）：400 VALIDATION_ERROR", async () => {
    const { app } = buildApp();
    const response = await request(app)
      .post("/api/mcp/servers")
      .send({
        name: "with-env",
        transport: "stdio",
        command: "npx",
        env: { GITHUB_TOKEN: "plaintext-secret" }
      })
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("http 端点内嵌凭据：400，拒绝把凭据写进 URL", async () => {
    const { app } = buildApp();
    const response = await request(app)
      .post("/api/mcp/servers")
      .send({
        name: "remote",
        transport: "streamable-http",
        endpoint: "https://user:pass@mcp.example.com/mcp"
      })
      .expect(400);

    expect(response.body.error.code).toBe("MCP_SERVER_INVALID");
  });

  it("连不上时仍返回 201，并把降级状态与原因落在服务器行上", async () => {
    const { app } = buildApp("explode");
    const response = await request(app)
      .post("/api/mcp/servers")
      .send({ name: "flaky", transport: "stdio", command: "explode" })
      .expect(201);

    expect(response.body.data.status).toBe("DEGRADED");
    expect(response.body.data.toolCount).toBe(0);
    expect(response.body.data.lastError).toContain("spawn ENOENT");
  });
});
