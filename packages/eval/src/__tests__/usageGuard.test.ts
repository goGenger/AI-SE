import { describe, expect, it } from "vitest";
import {
  MAX_SANE_RUN_INPUT_TOKENS,
  isSaneRunInputTokens,
  sumSaneInputTokens
} from "../usageGuard";

/**
 * N-8（`docs/176`）：坏值原文（`agent_runs.token_usage`，逐字取自 dev 库）。
 * 这些值让守卫的读数变成 10^17 量级，于是止损线在下一次 run 前就被顶穿。
 */
const N8_BAD_VALUES = [
  "263816819968573440",
  "684582327732404200",
  "737833874888851500",
  "4139511744995262500"
];

describe("usageGuard (PL-M15)", () => {
  it("ignores a single absurd value instead of letting it defeat the stop-line", () => {
    const week = ["2716139", "1960199", ...N8_BAD_VALUES, "1277164"];
    const total = sumSaneInputTokens(week);

    // 合理行照常计入。
    expect(total).toBe(2716139 + 1960199 + 1277164);
    // 关键性质：读数停在止损线以下，守卫不会被一条坏值废掉。
    expect(total).toBeLessThan(20_000_000);
  });

  it("ignores EVERY bad value in the window, not just the first", () => {
    expect(sumSaneInputTokens(N8_BAD_VALUES)).toBe(0);
  });

  it("keeps values at or below the bound and drops values above it", () => {
    expect(isSaneRunInputTokens(MAX_SANE_RUN_INPUT_TOKENS)).toBe(true);
    expect(isSaneRunInputTokens(MAX_SANE_RUN_INPUT_TOKENS + 1)).toBe(false);
    expect(isSaneRunInputTokens("0")).toBe(true);
  });

  it("skips values it cannot parse rather than producing NaN", () => {
    expect(sumSaneInputTokens(["1000", "", "  ", "not-a-number", null, undefined, "2000"])).toBe(
      3000
    );
  });

  it("returns 0 for an empty window", () => {
    expect(sumSaneInputTokens([])).toBe(0);
  });

  it("does not let a bad value leak into the total through a numeric type", () => {
    // 同一份坏值以 number 传入时也必须被剔除（psql 给的是字符串，但守卫不该依赖这一点）。
    expect(sumSaneInputTokens([2_716_139, 4.7e14, 1_000_000])).toBe(3_716_139);
  });
});
