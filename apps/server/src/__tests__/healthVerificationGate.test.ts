import { createLogger } from "@ai-se/observability";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";

/**
 * N-39（`docs/231` §8）：验证门的**运行时口径**必须能被外部读到。
 *
 * 此前口径只由「平台怎么启动」决定（启动脚本导出 `VERIFICATION_GATE=enforce`，
 * 直接 `pnpm dev` 则是配置默认 observe），批次脚本又只查 dist 时间——两批读数
 * 看起来一样，实际是在不同规则下测出来的。`/health` 现在把这个口径暴露出来，
 * 供批次脚本在**起跑前**断言。
 */
function buildApp(verificationGate?: "off" | "observe" | "enforce") {
  return createApp({
    logger: createLogger({ enabled: false }),
    projectRepository: {} as never,
    agentRunService: {} as never,
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
    corsOrigin: "http://localhost:5173",
    ...(verificationGate !== undefined ? { verificationGate } : {})
  });
}

describe("/health 暴露验证门口径（N-39）", () => {
  it("配置了验收门模式时原样回报", async () => {
    const response = await request(buildApp("enforce")).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ status: "ok", verificationGate: "enforce" });
  });

  it("未配置时不编造值（字段缺席而不是 null/unknown）", async () => {
    const response = await request(buildApp()).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ status: "ok" });
    expect(response.body.data).not.toHaveProperty("verificationGate");
  });
});
