/**
 * N-48（`docs/232` §9.12）：PostgreSQL 的 **jsonb 存不下 U+0000**。
 *
 * 实测（2026-10-25 第五次回归）：`T-06`/`T-07` 及其 DEBUG 共 5 个任务连续以
 * `LLM_ERROR: unsupported Unicode escape sequence` 失败、整片 FAILED。这条消息是 Postgres 对
 * 「jsonb 里出现 `\u0000`」的原文（`ERROR: unsupported Unicode escape sequence`，SQLSTATE 22P05），
 * 不是模型网关的话——模型/命令输出里出现一个 NUL，写 `agent_runs.output` 时就炸，重试与 DEBUG
 * 都会在同一个写点再炸一次。
 *
 * jsonb 无法表达 NUL，所以**在存储边界**把它去掉；内存里的字符串语义不动。
 */
export function jsonbSafe<T>(value: T): T {
  return stripNul(value, new Set<unknown>()) as T;
}

function stripNul(value: unknown, seen: Set<unknown>): unknown {
  if (typeof value === "string") {
    return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => stripNul(item, seen));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = stripNul(item, seen);
  }
  return output;
}
