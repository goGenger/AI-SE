import { describe, expect, it } from "vitest";
import { filterTasks, isTitleValid, type Task } from "../src/tasks";

const TASKS: Task[] = [
  { id: "1", title: "Alpha task", done: false, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "2", title: "Beta task", done: true, createdAt: "2026-01-01T00:00:01.000Z" },
  { id: "3", title: "Gamma task", done: false, createdAt: "2026-01-01T00:00:02.000Z" }
];

describe("filterTasks", () => {
  it("filter=all 保持 mock 顺序", () => {
    expect(filterTasks(TASKS, "", "all").map((task) => task.id)).toEqual(["1", "2", "3"]);
  });

  it("搜索大小写不敏感的子串", () => {
    expect(filterTasks(TASKS, "ALP", "all").map((task) => task.id)).toEqual(["1"]);
  });

  it("筛选与搜索叠加（AC-15）", () => {
    expect(filterTasks(TASKS, "a", "done").map((task) => task.id)).toEqual(["2"]);
  });

  it("无匹配时返回空数组", () => {
    expect(filterTasks(TASKS, "zzz", "all")).toEqual([]);
  });
});

describe("isTitleValid", () => {
  it("空白标题无效，正常标题有效", () => {
    expect(isTitleValid("   ")).toBe(false);
    expect(isTitleValid(" write docs ")).toBe(true);
  });
});
