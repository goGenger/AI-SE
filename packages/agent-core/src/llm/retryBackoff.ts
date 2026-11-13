/**
 * N-61（`docs/232` §10）：**模型调用的退避策略**。
 *
 * 原缺陷：`AgentGraph.invokeLLMWithRetry` 的两次尝试之间没有任何等待，也不读上游给的
 * `Retry-After`。实测（2026-10-29 F1 第三轮）上游回
 * `429 ... retry shortly (after 21 s)`，平台在 **6 秒内**跑完三次完整 agent_run
 * （T7 / T7-DEBUG-1 / T7-DEBUG-1-DEBUG-2），全撞同一堵墙，整片失败。
 *
 * 这里只做纯判定与纯计算，sleep 单独一个函数——便于单测，也避免把「等多久」和「怎么等」
 * 缠在一起。
 */

/** 首次退避基数：2s。 */
export const BASE_BACKOFF_MS = 2_000;
/** 单次退避上限：30s（上游常见的 Retry-After 量级都在这之内）。 */
export const MAX_BACKOFF_MS = 30_000;
/**
 * 一个 agent run 内**累计**退避上限：90s。
 *
 * 为什么需要上限：退避会占用 `runTimeoutMs` 的预算（N-60 是按任务计时）。一次 run 把时间全花
 * 在等待上，与直接失败没有区别，还会掩盖真实原因。超限就停止重试、如实报错。
 */
export const MAX_TOTAL_BACKOFF_MS = 90_000;

export type LlmFailureKind = "rate-limit" | "server-error" | "transient" | "not-retryable";

export interface LlmFailureClassification {
  kind: LlmFailureKind;
  /** 是否值得再试一次。 */
  retryable: boolean;
  /** 上游明说的等待时长（`Retry-After` / "after 21 s"），没有则 undefined。 */
  retryAfterMs?: number;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    // 有些 provider 把上游原文挂在 cause / response 上，尽量都扫一遍。
    const extra = [String(error.message ?? "")];
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) extra.push(String(cause.message ?? ""));
    return extra.join("\n");
  }
  return String(error ?? "");
}

/**
 * 从错误文本里提取上游建议的等待时长。
 *
 * 认三种常见形态（实测样张是第一种）：
 * - `retry shortly (after 21 s)`
 * - `retry after 30`（秒，无单位）
 * - `Retry-After: 20` / `retry-after: 20`
 * 带 `ms` 的按毫秒解释。
 */
export function extractRetryAfterMs(text: string): number | undefined {
  const withUnit = /retry[- ]?after[:\s]+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?)\b/i.exec(text);
  if (withUnit) {
    const value = Number(withUnit[1]);
    if (!Number.isFinite(value)) return undefined;
    return withUnit[2]?.toLowerCase() === "ms" ? Math.round(value) : Math.round(value * 1000);
  }
  // 实测样张：`... at capacity; retry shortly (after 21 s)`
  const afterPhrase = /after\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?)\b/i.exec(text);
  if (afterPhrase) {
    const value = Number(afterPhrase[1]);
    if (!Number.isFinite(value)) return undefined;
    return afterPhrase[2]?.toLowerCase() === "ms" ? Math.round(value) : Math.round(value * 1000);
  }
  // 无单位：按秒（LangChain / OpenAI 文档里 Retry-After 的默认单位是秒）。
  const bare = /retry[- ]?after[:\s]+(\d+)\b/i.exec(text);
  if (bare) {
    const value = Number(bare[1]);
    return Number.isFinite(value) ? value * 1000 : undefined;
  }
  return undefined;
}

/**
 * 失败分类。**顺序有意义**：
 *
 * 1. 429 / 容量不足先判（否则会被「4xx 不重试」吞掉）；
 * 2. 5xx ⇒ server-error；
 * 3. 认证 / 参数类（400 / 401 / 403 / 404）⇒ **不可重试**：重打只会重复同一条错误，
 *    还会把配置或密钥问题拖成超时；
 * 4. **其余一律 transient（可重试）**——包括认不出来的错误。
 *
 * 第 4 条是刻意的保守选择：重试一个真正不可恢复的错误只损失一次调用，而不重试一个本可恢复的
 * 错误会直接判死任务。改动前后既有行为（未知错误会重试）保持一致。
 */
/** True when the upstream message is a hard quota / plan limit, not a short capacity blip. */
export function isQuotaExhaustedMessage(text: string): boolean {
  return /usage limit|quota.?exceeded|GoUsageLimit|monthly.?limit|billing.?hard.?limit/i.test(
    text
  );
}

export function classifyLlmFailure(error: unknown): LlmFailureClassification {
  const text = errorText(error);
  const retryAfterMs = extractRetryAfterMs(text);
  const withDelay = () => (retryAfterMs ? { retryAfterMs } : {});

  // Quota / plan limits first: "429 Go usage limit exceeded" also matches the 429 branch
  // below, but retrying it is futile until the window resets or the key changes.
  if (isQuotaExhaustedMessage(text)) {
    return { kind: "not-retryable", retryable: false, ...withDelay() };
  }
  if (/\b429\b|rate.?limit|too many requests|ttft_admission_refused|capacity/i.test(text)) {
    return { kind: "rate-limit", retryable: true, ...withDelay() };
  }
  if (/\b5\d\d\b|bad gateway|service unavailable|gateway timeout|internal server error/i.test(text)) {
    return { kind: "server-error", retryable: true, ...withDelay() };
  }
  if (
    /\b40[0134]\b|invalid api key|unauthorized|forbidden|authentication|model not found|invalid_request/i.test(
      text
    )
  ) {
    return { kind: "not-retryable", retryable: false };
  }
  return { kind: "transient", retryable: true, ...withDelay() };
}

/**
 * 第 `attempt` 次重试前该等多久（`attempt` 从 1 开始）。
 *
 * `delay = min(MAX_BACKOFF_MS, max(上游建议值, BASE_BACKOFF_MS × 2^(attempt-1)))`
 *
 * 取两者的**较大值**：上游说等 21s 就必须等够 21s（比指数退避算出来的 2s 长）；上游没说
 * 就按指数走。
 */
export function backoffDelayMs(attempt: number, retryAfterMs?: number): number {
  const exponential = BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1);
  const floor = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : 0;
  return Math.min(MAX_BACKOFF_MS, Math.max(exponential, floor));
}

/** 可被 abort 打断的等待。中止后立即返回（不抛错——调用方自己判 `signal.aborted`）。 */
export async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}
