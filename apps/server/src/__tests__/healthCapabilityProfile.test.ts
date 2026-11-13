import { createLogger } from "@ai-se/observability";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";

/**
 * `docs/235` §6.5：能力 profile 的**运行时口径**必须能被外部读到——与 `verificationGate`
 * 同因（N-39）。没有它，批次脚本无法断言「这一批到底在什么能力面上跑」：
 * F1 批次会拿 `backend-node` 的读数冒充前端口径，而两边看起来一模一样。
 */
function buildApp(capabilityProfile?: string) {
  return createApp({
    logger: createLogger({ enabled: false }),
    projectRepository: {} as never,
    agentRunService: {} as never,
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
    corsOrigin: "http://localhost:5173",
    ...(capabilityProfile !== undefined ? { capabilityProfile } : {})
  });
}

describe("/health 暴露能力 profile（docs/235 §6.5）", () => {
  it("配置了 profile 时原样回报", async () => {
    const response = await request(buildApp("frontend-vue")).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ status: "ok", capabilityProfile: "frontend-vue" });
  });

  it("未配置时不编造值（字段缺席而不是 null/unknown）", async () => {
    const response = await request(buildApp()).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ status: "ok" });
    expect(response.body.data).not.toHaveProperty("capabilityProfile");
  });
});
