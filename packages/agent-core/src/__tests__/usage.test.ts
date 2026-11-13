import { describe, expect, it } from "vitest";
import { estimateCostUsd, sumTokenUsage, totalTokenUsage } from "../llm/usage";

/**
 * PL-C2（`docs/162` §2）：用量累加与计价的口径**只有一份**（`src/llm/usage.ts`），
 * 由外层图（`AgentGraph`）与内层 provider（`DeepAgentLLMProvider`）共用。
 */
describe("sumTokenUsage", () => {
  it("adds numeric fields and keeps nested details in step", () => {
    const total = sumTokenUsage(
      {
        input_tokens: 100,
        output_tokens: 10,
        total_tokens: 110,
        input_token_details: { cache_read: 64, cache_creation: 0 },
        output_token_details: { reasoning: 4 }
      },
      {
        input_tokens: 200,
        output_tokens: 20,
        total_tokens: 220,
        input_token_details: { cache_read: 32, cache_creation: 8 },
        output_token_details: { reasoning: 6 }
      }
    );

    expect(total).toEqual({
      input_tokens: 300,
      output_tokens: 30,
      total_tokens: 330,
      input_token_details: { cache_read: 96, cache_creation: 8 },
      output_token_details: { reasoning: 10 }
    });
  });

  it("treats a missing or non-record previous value as empty", () => {
    const next = { input_tokens: 5, output_tokens: 1, total_tokens: 6 };
    expect(sumTokenUsage(undefined, next)).toEqual(next);
    expect(sumTokenUsage("not-a-record", next)).toEqual(next);
    expect(sumTokenUsage(null, next)).toEqual(next);
  });

  it("keeps a previous-only field (partial reports accumulate)", () => {
    const total = sumTokenUsage({ input_tokens: 100, cache_read: 7 }, { output_tokens: 3 });
    expect(total).toEqual({ input_tokens: 100, cache_read: 7, output_tokens: 3 });
  });

  it("replaces non-numeric leaves instead of concatenating them", () => {
    const total = sumTokenUsage({ note: "first" }, { note: "second" });
    expect(total).toEqual({ note: "second" });
  });
});

describe("totalTokenUsage", () => {
  it("sums every record and ignores non-records", () => {
    const total = totalTokenUsage([
      { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      undefined,
      "junk",
      { input_tokens: 2, output_tokens: 3, total_tokens: 5 }
    ]);

    expect(total).toEqual({ input_tokens: 3, output_tokens: 4, total_tokens: 7 });
  });

  it("returns undefined when there is nothing to sum (never an empty object)", () => {
    expect(totalTokenUsage([])).toBeUndefined();
    expect(totalTokenUsage([undefined, "junk"])).toBeUndefined();
  });
});

describe("estimateCostUsd", () => {
  const pricing = { inputPerMTok: 3, outputPerMTok: 15 };

  it("prices input and output separately", () => {
    // 2M 输入 × $3 + 1M 输出 × $15 = $21
    expect(estimateCostUsd({ input_tokens: 2_000_000, output_tokens: 1_000_000 }, pricing)).toBe(21);
  });

  it("returns undefined when no pricing is configured (never guesses)", () => {
    expect(estimateCostUsd({ input_tokens: 1_000, output_tokens: 1_000 }, undefined)).toBeUndefined();
  });

  it("returns undefined for empty or unusable usage", () => {
    expect(estimateCostUsd(undefined, pricing)).toBeUndefined();
    expect(estimateCostUsd({}, pricing)).toBeUndefined();
    expect(estimateCostUsd({ input_tokens: 0, output_tokens: 0 }, pricing)).toBeUndefined();
    expect(estimateCostUsd("junk", pricing)).toBeUndefined();
  });
});
