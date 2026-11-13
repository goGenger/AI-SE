import express from "express";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { assertListenSecurity } from "../config";
import { apiTokenGuard, tokenMatches } from "../http/apiToken";
import { requestLogger, sanitizeUrlForLog } from "../http/requestLogger";

/**
 * F1-7（FX-22）：部署面 API 安全加固单测 + 日志扫描——
 * 非回环监听未配令牌拒绝启动；令牌比较常量时间；令牌不出现在日志与 URL。
 */

describe("FX-22 启动防护（assertListenSecurity）", () => {
  it("回环地址免令牌（默认开发形态零变化）", () => {
    expect(() => assertListenSecurity({ host: "127.0.0.1" })).not.toThrow();
    expect(() => assertListenSecurity({ host: "localhost" })).not.toThrow();
    expect(() => assertListenSecurity({ host: "::1" })).not.toThrow();
    expect(() => assertListenSecurity({ host: "127.0.0.5" })).not.toThrow();
  });

  it("非回环地址未配置 API_TOKEN → 拒绝启动并给出明确提示", () => {
    expect(() => assertListenSecurity({ host: "0.0.0.0" })).toThrow(/Refusing to start/);
    expect(() => assertListenSecurity({ host: "0.0.0.0" })).toThrow(/API_TOKEN is not configured/);
    expect(() => assertListenSecurity({ host: "192.168.1.5" })).toThrow(/Refusing to start/);
  });

  it("非回环地址 + 配置令牌 → 允许启动", () => {
    expect(() => assertListenSecurity({ host: "0.0.0.0", apiToken: "secret-token" })).not.toThrow();
  });
});

describe("FX-22 常量时间令牌比较", () => {
  it("匹配语义与定长摘要保护", () => {
    expect(tokenMatches("secret-token", "secret-token")).toBe(true);
    expect(tokenMatches("secret-token", "secret-toke!")).toBe(false);
    // 长度不同（timingSafeEqual 对长度敏感——先经 sha256 定长化，不会抛错）。
    expect(tokenMatches("secret-token", "s")).toBe(false);
    expect(tokenMatches("secret-token", "")).toBe(false);
  });
});

describe("FX-22 日志扫描：令牌不出现在日志与 URL", () => {
  it("header 鉴权请求通过；URL 令牌不被接受且日志已脱敏（全量日志不含令牌明文）", async () => {
    const TOKEN = "scan-token-9f2b";
    const lines: string[] = [];
    const logger = pino({ level: "info" }, {
      write: (line: string) => lines.push(line)
    } as unknown as pino.DestinationStream);
    const app = express();
    app.use(requestLogger(logger));
    app.use("/api", apiTokenGuard(TOKEN));
    app.get("/api/ping", (_req, res) => {
      res.json({ ok: true });
    });
    app.get("/health", (_req, res) => {
      res.json({ ok: true });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const authorized = await fetch(`${base}/api/ping`, {
        headers: { authorization: `Bearer ${TOKEN}` }
      });
      expect(authorized.status).toBe(200);

      const rejected = await fetch(`${base}/api/ping`);
      expect(rejected.status).toBe(401);

      // URL 携带令牌不被接受（只认 Authorization 头）——且访问日志对敏感参数脱敏。
      const urlToken = await fetch(`${base}/api/ping?token=${TOKEN}`);
      expect(urlToken.status).toBe(401);
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 100));
      const logText = lines.join("\n");
      expect(logText).not.toContain(TOKEN);
      // URLSearchParams 会把方括号编码为 %5B/%5D——脱敏标记以「REDACTED」子串断言。
      expect(logText).toContain("REDACTED");
      expect(logText).toContain("/api/ping");
      expect(logText).toContain("/health");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sanitizeUrlForLog：敏感参数值脱敏，其余参数原样", () => {
    expect(sanitizeUrlForLog("/api/items?status=open&page=2")).toBe(
      "/api/items?status=open&page=2"
    );
    expect(sanitizeUrlForLog("/api/items?token=abc123&page=2")).toBe(
      "/api/items?token=%5BREDACTED%5D&page=2"
    );
    expect(sanitizeUrlForLog("/api/items")).toBe("/api/items");
  });
});
