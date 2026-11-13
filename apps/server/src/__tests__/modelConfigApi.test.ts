import type { ProjectRepository } from "@ai-se/database";
import { createLogger } from "@ai-se/observability";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { AgentRunService } from "../services/agentRunService";
import { ModelConfigService } from "../services/modelConfigService";

const ENV_CONFIG = {
  provider: "openai" as const,
  model: "gpt-5.4-mini",
  apiKey: "env-key",
  baseUrl: "https://env.example/v1"
};

/** 本文件只打 /api/model-config。项目仓储被碰到就说明测试跑偏了 —— 炸掉，不要静默返回空。 */
function unusedProjects(): ProjectRepository {
  const fail = (): never => {
    throw new Error("model-config 测试不应访问项目仓储");
  };

  return {
    create: fail,
    findMany: fail,
    findById: fail,
    attachRepository: fail,
    updateWorkspacePath: fail,
    deleteById: fail
  } as unknown as ProjectRepository;
}

function buildApp() {
  const config = new ModelConfigService(ENV_CONFIG);
  const app = createApp({
    logger: createLogger({ enabled: false }),
    projectRepository: unusedProjects(),
    agentRunService: {} as unknown as AgentRunService,
    modelConfigService: config,
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
    corsOrigin: "http://localhost:5173"
  });

  return { app, config };
}

describe("GET /api/model-config", () => {
  it("回读当前配置，且整条响应里没有密钥值", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/api/model-config");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
      baseUrl: "https://env.example/v1",
      apiKeyConfigured: true,
      source: "env",
      overridden: []
    });
    // 只暴露「有没有密钥」，不暴露「是什么」—— AGENTS.md §10 的硬约束。
    expect(response.text).not.toContain("env-key");
  });
});

describe("PUT /api/model-config", () => {
  it("运行时覆盖立即生效，且不外泄密钥", async () => {
    const { app, config } = buildApp();

    const response = await request(app)
      .put("/api/model-config")
      .send({ model: "gpt-5.5", apiKey: "runtime-secret" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      model: "gpt-5.5",
      apiKeyConfigured: true,
      source: "runtime",
      overridden: ["model", "apiKey"]
    });
    expect(response.text).not.toContain("runtime-secret");
    // 模型路径真正读到的那个对象也已经变了。
    expect(config.getOptions().apiKey).toBe("runtime-secret");
  });

  it("空串与 null 同义：清除覆盖、回落到环境变量", async () => {
    const { app, config } = buildApp();
    await request(app).put("/api/model-config").send({ model: "gpt-5.5" });

    const response = await request(app).put("/api/model-config").send({ model: "" });

    expect(response.body.data.model).toBe("gpt-5.4-mini");
    expect(response.body.data.source).toBe("env");
    expect(config.getOptions().model).toBe("gpt-5.4-mini");
  });

  it("校验失败时不回显请求体 —— 请求体里可能带明文密钥", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .put("/api/model-config")
      .send({ apiKey: "sk-leak-me", unexpected: true });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.text).not.toContain("sk-leak-me");
    // 连「哪个字段错了」都不给：flatten() 会带着请求体的形状回去。
    expect(response.body.error.details).toBeUndefined();
  });

  it("字段类型不对就拒绝，且不改动现状", async () => {
    const { app, config } = buildApp();

    const response = await request(app).put("/api/model-config").send({ model: 123 });

    expect(response.status).toBe(400);
    expect(config.getOptions().model).toBe("gpt-5.4-mini");
  });
});
