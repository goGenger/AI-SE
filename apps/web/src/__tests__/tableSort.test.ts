import { describe, expect, it } from "vitest";
import {
  compareValues,
  nextSortState,
  sortRows,
  type SortState
} from "@/components/ui/table/sort";

/**
 * W7 — Table 排序的纯逻辑层。
 *
 * `Table.vue` 的表头点击只做两件事：把点击交给 `nextSortState`、把结果交给 `sortRows`。
 * 因此排序行为可以在 Node 环境下完整测掉，浏览器只需验证「点表头真的会重排」。
 */
describe("nextSortState（表头点击的三态）", () => {
  it("未排序 → 该列升序", () => {
    expect(nextSortState(null, "name")).toEqual({ key: "name", direction: "asc" });
  });

  it("同列升序 → 降序", () => {
    expect(nextSortState({ key: "name", direction: "asc" }, "name")).toEqual({
      key: "name",
      direction: "desc"
    });
  });

  it("同列降序 → 取消排序", () => {
    expect(nextSortState({ key: "name", direction: "desc" }, "name")).toBeNull();
  });

  it("换一列：直接进入该列升序，不继承上一列的方向", () => {
    expect(nextSortState({ key: "name", direction: "desc" }, "createdAt")).toEqual({
      key: "createdAt",
      direction: "asc"
    });
  });
});

describe("compareValues", () => {
  it("两边都是数字时按数值比较（不是字典序）", () => {
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues(10, 2)).toBeGreaterThan(0);
    expect(compareValues(3, 3)).toBe(0);
  });

  it("字符串带数字时按数值段比较（第 2 版排在 第 10 版 之前）", () => {
    expect(compareValues("第 2 版", "第 10 版")).toBeLessThan(0);
  });

  it("ISO 时间串按字典序即时间序", () => {
    expect(compareValues("2026-01-09T08:00:00Z", "2026-01-05T08:00:00Z")).toBeGreaterThan(0);
  });

  it("布尔值 false 在前", () => {
    expect(compareValues(false, true)).toBeLessThan(0);
  });
});

describe("sortRows", () => {
  interface Row {
    id: string;
    name?: string | null;
    createdAt: string;
    size?: number;
  }

  const rows: Row[] = [
    { id: "b", name: "banana", createdAt: "2026-01-05T08:00:00Z", size: 20 },
    { id: "a", name: null, createdAt: "2026-01-09T08:00:00Z", size: 3 },
    { id: "c", name: "apple", createdAt: "2026-01-07T08:00:00Z", size: 100 }
  ];

  it("state 为 null 时原样返回（不复制、不改序）", () => {
    expect(sortRows(rows, null)).toBe(rows);
  });

  it("升序 / 降序", () => {
    const asc = sortRows(rows, { key: "createdAt", direction: "asc" } satisfies SortState);
    expect(asc.map((row) => row.id)).toEqual(["b", "c", "a"]);
    const desc = sortRows(rows, { key: "createdAt", direction: "desc" });
    expect(desc.map((row) => row.id)).toEqual(["a", "c", "b"]);
  });

  it("空值恒定排在末尾，不随升序/降序翻转", () => {
    expect(sortRows(rows, { key: "name", direction: "asc" }).map((r) => r.id)).toEqual([
      "c",
      "b",
      "a"
    ]);
    expect(sortRows(rows, { key: "name", direction: "desc" }).map((r) => r.id)).toEqual([
      "b",
      "c",
      "a"
    ]);
  });

  it("数字列按数值排序", () => {
    const asc = sortRows(rows, { key: "size", direction: "asc" });
    expect(asc.map((row) => row.size)).toEqual([3, 20, 100]);
  });

  it("accessors 覆盖默认的 row[key] 取值（嵌套字段）", () => {
    const nested = [
      { id: "x", progress: { completed: 5 } },
      { id: "y", progress: { completed: 1 } },
      { id: "z", progress: { completed: 3 } }
    ];
    const sorted = sortRows(nested, { key: "progress", direction: "asc" }, {
      progress: (row) => row.progress.completed
    });
    expect(sorted.map((row) => row.id)).toEqual(["y", "z", "x"]);
  });

  it("不改动入参，并按稳定排序保持同值行的原始相对顺序", () => {
    const original = [...rows];
    const ties = [
      { id: "1", name: "同" },
      { id: "2", name: "同" },
      { id: "3", name: "同" }
    ];
    expect(sortRows(ties, { key: "name", direction: "asc" }).map((r) => r.id)).toEqual([
      "1",
      "2",
      "3"
    ]);
    expect(rows).toEqual(original);
  });
});
