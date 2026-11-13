import { describe, expect, it } from "vitest";
import { Task, sliceAcKeys, taskAcKeys } from "./index";

/**
 * N-40（`docs/231` §8）：`taskAcKeys` / `sliceAcKeys` 从 `taskVerifier` 上移到 `@ai-se/shared`。
 *
 * 上移的理由是**同一份定义**：校验器按 `[AC-xx]` 选测试，任务提示词要告诉 agent 写哪些编号，
 * 两处必须用完全相同的口径，否则一边按切片兜底、另一边按任务声明，agent 写出的标记对不上。
 */

function task(id: string, input: Record<string, unknown>, sliceKey?: string): Task {
  return {
    id,
    projectId: "p-1",
    taskKey: id,
    title: id,
    description: "",
    type: "BACKEND",
    status: "PENDING",
    priority: "MEDIUM",
    input,
    retryCount: 0,
    version: 1,
    ...(sliceKey !== undefined ? { sliceKey } : {}),
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z"
  } as Task;
}

describe("taskAcKeys", () => {
  it("取任务自己声明的编号，trim 掉空白", () => {
    expect(taskAcKeys(task("t1", { acKeys: [" AC-01 ", "AC-02"] }))).toEqual(["AC-01", "AC-02"]);
  });

  it("缺字段、非数组、混入非字符串都安全降级", () => {
    expect(taskAcKeys(task("t1", {}))).toEqual([]);
    expect(taskAcKeys(task("t1", { acKeys: "AC-01" }))).toEqual([]);
    expect(taskAcKeys(task("t1", { acKeys: ["AC-01", 7, null, "  "] }))).toEqual(["AC-01"]);
  });
});

describe("sliceAcKeys", () => {
  it("同切片任务的编号取并集并去重", () => {
    const tasks = [
      task("t1", { acKeys: ["AC-01", "AC-02"] }),
      task("t2", { acKeys: ["AC-02", "AC-03"] })
    ];
    expect(sliceAcKeys(tasks)).toEqual(["AC-01", "AC-02", "AC-03"]);
  });

  it("传 first 时它的编号排在最前（保持 F1-5 的顺序语义）", () => {
    const first = task("t2", { acKeys: ["AC-03"] });
    const tasks = [task("t1", { acKeys: ["AC-01"] }), first];
    expect(sliceAcKeys(tasks, first)).toEqual(["AC-03", "AC-01"]);
  });

  it("空集合得到空数组", () => {
    expect(sliceAcKeys([])).toEqual([]);
    expect(sliceAcKeys([task("t1", {}), task("t2", {})])).toEqual([]);
  });
});
