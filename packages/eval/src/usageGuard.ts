/**
 * PL-M15（`docs/176` §7 第 3 项裁定）：配额守卫的**唯一一份**读取口径。
 *
 * 背景（N-8）：批次脚本的止损线是「周窗口内 `agent_runs.token_usage.input_tokens` 之和」，
 * 而 N-8 会让单个 agent run 写出 10^14–10^18 量级的坏值。**一条坏值就足以让守卫在下一次
 * run 前无条件掐断**——L1-M4f run 2 与便宜档探针各实际发生过一次。
 *
 * 处置：**合理性上界法**（不是统计离群——离群法需要历史分布，而坏值本身会污染那个分布，
 * 阈值还会随平台演进失效）。
 */

/**
 * 单个 agent run 的 `input_tokens` 上界；超过即视为异常值，**守卫侧忽略**。
 *
 * 推导：`maxIterations × 单轮请求上下文上界` = 50 × 1,000,000 = 50,000,000，取整到 1e8。
 * 历史正常最大值 2,716,139（37 倍余量），坏值最低 4.7e14（低 6 个数量级）。
 *
 * **不改任何历史行**（`AGENTS.md` §6）：坏值原样留在库里，这里只是读数时忽略它们。
 */
export const MAX_SANE_RUN_INPUT_TOKENS = 100_000_000;

export function isSaneRunInputTokens(value: unknown): boolean {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return false;
  return parsed <= MAX_SANE_RUN_INPUT_TOKENS;
}

/**
 * 求和。异常值与不可解析的值被**跳过**（不是当成 0 记入，也不产出 NaN）——
 * 守卫的读数必须是「合理行的和」，不是「所有行的和」。
 */
export function sumSaneInputTokens(values: Iterable<unknown>): number {
  let total = 0;
  for (const value of values) {
    if (!isSaneRunInputTokens(value)) continue;
    total += typeof value === "number" ? value : Number(value);
  }
  return total;
}
