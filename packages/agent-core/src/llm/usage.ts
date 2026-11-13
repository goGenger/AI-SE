/**
 * PL-C2（`docs/162` §2）：agent 用量元数据的**唯一一份**累加与计价口径。
 *
 * 背景：`agent_runs.token_usage` 此前只落**一次** LLM 调用的用量——外层图每轮直接写
 * `{ tokenUsage }` 覆盖前一轮，内层 deep agent 又只把最后一条消息的 `usage_metadata`
 * 交回。整轮用量必须显式累加，且累加口径要**只有一份**（两份必然漂移，见 `docs/160`）。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 数值字段递归相加——`usage_metadata` 除 `input_tokens` / `output_tokens` / `total_tokens`
 * 外还带 `input_token_details`（`cache_read` 等）与 `output_token_details`（`reasoning` 等）
 * 的嵌套明细，这些也要一起累加，否则明细与总量对不上。
 *
 * 非数值字段取新值（如 `*_details.audio` 一类可能为 `null` 的占位）。
 */
export function sumTokenUsage(
  previous: unknown,
  next: Record<string, unknown>
): Record<string, unknown> {
  const base = isRecord(previous) ? previous : {};
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    const prior = merged[key];
    if (typeof value === "number" && typeof prior === "number") merged[key] = prior + value;
    else if (isRecord(value) && isRecord(prior)) merged[key] = sumTokenUsage(prior, value);
    else merged[key] = value;
  }
  return merged;
}

/**
 * 把一串用量记录求和。全部为空/非法时返回 `undefined`——**不产出空对象**，
 * 免得下游把 `{}` 当成「有数据」。
 */
export function totalTokenUsage(
  values: readonly unknown[]
): Record<string, unknown> | undefined {
  let total: Record<string, unknown> | undefined;
  for (const value of values) {
    if (!isRecord(value)) continue;
    total = sumTokenUsage(total, value);
  }
  return total;
}

/** 价目：每百万 token 的美元单价。**由配置注入**，不写死在代码里。 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

function tokenCount(usage: Record<string, unknown>, key: string): number {
  const value = usage[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 按价目估算成本。**未配置价目 → `undefined`**（`agent_runs.estimated_cost` 维持 `NULL`）。
 * 部署的模型是网关别名（`OPENAI_MODEL` 可随时更换），代码内静态价表换模型即失准——
 * 所以宁可留空，也不编造一个看起来可信的数字。
 *
 * 边界：不建模缓存折扣（`input_token_details.cache_read` 按原价计），故结果是**上界估计**。
 */
export function estimateCostUsd(
  usage: unknown,
  pricing: ModelPricing | undefined
): number | undefined {
  if (!isRecord(usage) || !pricing) return undefined;
  const input = tokenCount(usage, "input_tokens");
  const output = tokenCount(usage, "output_tokens");
  if (input === 0 && output === 0) return undefined;
  return (input / 1_000_000) * pricing.inputPerMTok + (output / 1_000_000) * pricing.outputPerMTok;
}
