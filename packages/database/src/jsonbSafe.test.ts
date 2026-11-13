import { describe, expect, it } from "vitest";
import { jsonbSafe } from "./jsonbSafe";

/**
 * N-48（`docs/232` §9.12）：Postgres 的 jsonb 存不下 U+0000——写入抛
 * `ERROR: unsupported Unicode escape sequence`。实测第五次回归里 5 个任务因此连续失败。
 */
describe("N-48 jsonbSafe：持久化前去掉 NUL", () => {
  it("顶层字符串里的 NUL 被去掉，其余字符不动", () => {
    expect(jsonbSafe("a\u0000b")).toBe("ab");
    expect(jsonbSafe("中文\u0000🙂")).toBe("中文🙂");
    expect(jsonbSafe("clean")).toBe("clean");
  });

  it("嵌套对象/数组里的字符串同样被清理（模型输出就是这种形状）", () => {
    const value = {
      summary: "done\u0000",
      artifacts: [{ path: "src/a.js", content: "const a = 1;\u0000" }],
      nested: { deep: "x\u0000y", count: 2, flag: true }
    };
    expect(jsonbSafe(value)).toEqual({
      summary: "done",
      artifacts: [{ path: "src/a.js", content: "const a = 1;" }],
      nested: { deep: "xy", count: 2, flag: true }
    });
  });

  it("null / undefined / 数字 / 布尔原样返回", () => {
    expect(jsonbSafe(null)).toBeNull();
    expect(jsonbSafe(undefined)).toBeUndefined();
    expect(jsonbSafe(42)).toBe(42);
    expect(jsonbSafe(false)).toBe(false);
  });

  it("循环引用不会死循环", () => {
    const cyclic: Record<string, unknown> = { name: "a\u0000" };
    cyclic.self = cyclic;
    const safe = jsonbSafe(cyclic) as Record<string, unknown>;
    expect(safe.name).toBe("a");
    expect(safe.self).toBe(cyclic);
  });

  it("非纯对象（如 Date）原样保留", () => {
    const date = new Date("2026-10-25T00:00:00.000Z");
    expect(jsonbSafe({ at: date })).toEqual({ at: date });
  });
});
