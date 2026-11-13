import { describe, expect, it } from "vitest";
import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  backoffDelayMs,
  classifyLlmFailure,
  extractRetryAfterMs,
  sleepWithSignal
} from "../llm/retryBackoff";

/**
 * N-61（`docs/232` §10）：429/5xx 必须退避，且尊重上游给的 `Retry-After`。
 *
 * 实测样张（2026-10-29 F1 第三轮，真实 upstream 回包）：
 * `429 Upstream request failed: [ttft_admission_refused] the cell is at capacity; retry shortly (after 21 s)`
 * 平台当时在 6 秒内连撞三次，因为重试之间没有任何等待。
 */
const REAL_429 =
  "429 Upstream request failed: [ttft_admission_refused] the cell is at capacity; " +
  "retry shortly (after 21 s)\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_RATE_LIMIT/";

describe("extractRetryAfterMs", () => {
  it("认得实测样张里的 `(after 21 s)`", () => {
    expect(extractRetryAfterMs(REAL_429)).toBe(21_000);
  });

  it("认得 `Retry-After: 20`", () => {
    expect(extractRetryAfterMs("HTTP 429 Retry-After: 20")).toBe(20_000);
  });

  it("认得毫秒单位，不按秒放大", () => {
    expect(extractRetryAfterMs("retry after 1500 ms")).toBe(1500);
  });

  it("没有该字段时返回 undefined（交给指数退避）", () => {
    expect(extractRetryAfterMs("429 Too Many Requests")).toBeUndefined();
  });
});

describe("classifyLlmFailure", () => {
  it("429 / 容量不足 ⇒ rate-limit，可重试，并带出 Retry-After", () => {
    const result = classifyLlmFailure(new Error(REAL_429));
    expect(result.kind).toBe("rate-limit");
    expect(result.retryable).toBe(true);
    expect(result.retryAfterMs).toBe(21_000);
  });

  it("5xx ⇒ server-error，可重试", () => {
    expect(classifyLlmFailure(new Error("503 Service Unavailable")).retryable).toBe(true);
    expect(classifyLlmFailure(new Error("502 Bad Gateway")).kind).toBe("server-error");
  });

  it("网络类 ⇒ transient，可重试", () => {
    for (const message of ["ECONNRESET", "ETIMEDOUT", "socket hang up", "fetch failed"]) {
      const result = classifyLlmFailure(new Error(message));
      expect(result.kind, message).toBe("transient");
      expect(result.retryable, message).toBe(true);
    }
  });

  it("认证/参数类 ⇒ 不可重试（重试只会重复同一条错误）", () => {
    for (const message of [
      "401 Unauthorized",
      "403 Forbidden",
      "400 invalid api key",
      "404 model not found"
    ]) {
      expect(classifyLlmFailure(new Error(message)).retryable, message).toBe(false);
    }
  });

  it("认不出来的错误默认**可重试**（保守：漏一次调用好过判死任务）", () => {
    const result = classifyLlmFailure(new Error("temporary"));
    expect(result.retryable).toBe(true);
    expect(result.kind).toBe("transient");
  });

  it("429 必须先于 4xx 判定——否则限流会被当成不可重试", () => {
    // 这条钉的是分类顺序：`429` 同时命中「4xx」与「限流」，必须走前者。
    expect(classifyLlmFailure(new Error("429 Too Many Requests")).retryable).toBe(true);
  });

  it("Go / plan usage limit ⇒ 不可重试（配额耗尽，退避无意义）", () => {
    const result = classifyLlmFailure(
      new Error(
        "429 Go usage limit exceeded\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_RATE_LIMIT/\n"
      )
    );
    expect(result.kind).toBe("not-retryable");
    expect(result.retryable).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("没有 Retry-After 时按指数增长", () => {
    expect(backoffDelayMs(1)).toBe(BASE_BACKOFF_MS);
    expect(backoffDelayMs(2)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffDelayMs(3)).toBe(BASE_BACKOFF_MS * 4);
  });

  it("上游说了等更久 ⇒ 按上游的（取较大值）", () => {
    expect(backoffDelayMs(1, 21_000)).toBe(21_000);
  });

  it("上游说的比指数算出来的短 ⇒ 仍取指数（不提前重打）", () => {
    expect(backoffDelayMs(3, 100)).toBe(BASE_BACKOFF_MS * 4);
  });

  it("单次退避有上限，不会无限增长", () => {
    expect(backoffDelayMs(20)).toBe(MAX_BACKOFF_MS);
  });
});

describe("sleepWithSignal", () => {
  it("到点返回", async () => {
    const started = Date.now();
    await sleepWithSignal(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it("被中止时立即返回，不睡满", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = sleepWithSignal(5_000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await pending;
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("已经中止的信号不会等待", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await sleepWithSignal(5_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
