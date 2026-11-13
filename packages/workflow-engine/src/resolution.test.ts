import type { Task, TaskDependencyView } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  countWorkflowTaskProgress,
  hasUnresolvedFailure,
  isFailureResolved,
  isSupersededBySuccessfulPredecessor,
  planSupersededReplanEdgeRestore,
  replanRootTaskKey,
  retryableFailedTasks,
  unresolvedFailedTasks
} from "./resolution";

function task(id: string, status: Task["status"], resolvedByTaskId?: string): Task {
  return {
    id,
    projectId: "project",
    workflowRunId: "workflow",
    taskKey: id,
    title: id,
    description: id,
    type: "BACKEND",
    status,
    priority: "MEDIUM",
    input: {},
    retryCount: 0,
    version: 1,
    origin: "RUNTIME",
    failureHandled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(resolvedByTaskId ? { resolvedByTaskId } : {})
  };
}

function index(tasks: Task[]): Map<string, Task> {
  return new Map(tasks.map((entry) => [entry.id, entry]));
}

describe("PL-M19（N-12）：失败是否已被解决＝沿 resolvedByTaskId 链走到头", () => {
  it("单层：直接指向 SUCCESS ⇒ 已解决", () => {
    const tasks = [task("A", "FAILED", "B"), task("B", "SUCCESS")];
    expect(isFailureResolved(tasks[0], index(tasks))).toBe(true);
  });

  it("两层：中间节点自身 FAILED，尽头 SUCCESS ⇒ 已解决（N-12 的核心形状）", () => {
    const tasks = [task("A", "FAILED", "B"), task("B", "FAILED", "C"), task("C", "SUCCESS")];
    expect(isFailureResolved(tasks[0], index(tasks))).toBe(true);
    expect(isFailureResolved(tasks[1], index(tasks))).toBe(true);
  });

  it("三层：层数由策略界定，判定不写死层数", () => {
    const tasks = [
      task("A", "FAILED", "B"),
      task("B", "FAILED", "C"),
      task("C", "FAILED", "D"),
      task("D", "SUCCESS")
    ];
    expect(isFailureResolved(tasks[0], index(tasks))).toBe(true);
  });

  it("链走到头是 FAILED ⇒ 未解决（真的救不回来）", () => {
    const tasks = [task("A", "FAILED", "B"), task("B", "FAILED", "C"), task("C", "FAILED")];
    expect(isFailureResolved(tasks[0], index(tasks))).toBe(false);
  });

  it("断链（指针指向不存在的任务）⇒ 未解决", () => {
    const tasks = [task("A", "FAILED", "ghost")];
    expect(isFailureResolved(tasks[0], index(tasks))).toBe(false);
  });

  it("无指针 ⇒ 未解决", () => {
    const tasks = [task("A", "FAILED")];
    expect(isFailureResolved(tasks[0], index(tasks))).toBe(false);
  });

  it("成环 ⇒ 未解决，且不挂死", () => {
    const tasks = [task("A", "FAILED", "B"), task("B", "FAILED", "A")];
    expect(isFailureResolved(tasks[0], index(tasks))).toBe(false);
  });

  it("解析者是 BLOCKED / CANCELLED ⇒ 未解决（不算被解决）", () => {
    const tasks = [task("A", "FAILED", "B"), task("B", "BLOCKED")];
    expect(isFailureResolved(tasks[0], index(tasks))).toBe(false);
    const cancelled = [task("A", "FAILED", "B"), task("B", "CANCELLED")];
    expect(isFailureResolved(cancelled[0], index(cancelled))).toBe(false);
  });
});

describe("PL-M19（N-12）：两个消费点同源", () => {
  it("unresolvedFailedTasks 只挑 FAILED 且未解决的；SUCCESS / BLOCKED 不入列", () => {
    const tasks = [
      task("A", "SUCCESS"),
      task("B", "FAILED"),
      task("C", "FAILED", "A"),
      task("D", "FAILED", "E"),
      task("E", "FAILED", "F"),
      task("F", "SUCCESS"),
      task("G", "BLOCKED"),
      task("H", "FAILED", "I"),
      task("I", "FAILED")
    ];
    // B 无指针；H → I 链尽头仍是 FAILED，故 H 与 I 都未解决；C / D / E 已解决；G 不是 FAILED。
    expect(unresolvedFailedTasks(tasks).map((entry) => entry.id)).toEqual(["B", "H", "I"]);
  });

  it("hasUnresolvedFailure ＝ BLOCKED/CANCELLED 存在，或 unresolvedFailedTasks 非空", () => {
    const allResolved = [
      task("A", "FAILED", "B"),
      task("B", "FAILED", "C"),
      task("C", "SUCCESS")
    ];
    expect(hasUnresolvedFailure(allResolved)).toBe(false);
    expect(unresolvedFailedTasks(allResolved)).toEqual([]);

    const deepRescue = [
      task("A", "FAILED", "B"),
      task("B", "FAILED", "C"),
      task("C", "FAILED"),
      task("D", "BLOCKED")
    ];
    expect(hasUnresolvedFailure(deepRescue)).toBe(true);
    expect(unresolvedFailedTasks(deepRescue).length > 0).toBe(true);

    const blockedOnly = [task("A", "SUCCESS"), task("B", "BLOCKED")];
    expect(hasUnresolvedFailure(blockedOnly)).toBe(true);
    expect(unresolvedFailedTasks(blockedOnly)).toEqual([]);
  });
});

/**
 * N-50（`docs/232` §9.16）：验证期调用方在任务变成 SUCCESS **之前**判定「谁没收尾」，
 * 此时链末端的解决者还是 RUNNING。`pendingSuccessId` 把「正在验证的那个任务」视为已解决，
 * 否则「最后一步救回来」的形状会被判成未解决（第七次回归 S1：工作流 SUCCESS 却没有边界检查）。
 */
describe("N-50：验证期的 pendingSuccessId", () => {
  it("链末端正是当前正在验证的任务（RUNNING）⇒ 视为已解决", () => {
    const tasks = [task("A", "FAILED", "B"), task("B", "RUNNING")];
    expect(isFailureResolved(tasks[0], index(tasks))).toBe(false);
    expect(isFailureResolved(tasks[0], index(tasks), { pendingSuccessId: "B" })).toBe(true);
  });

  it("多层链的末端是当前任务 ⇒ 已解决", () => {
    const tasks = [
      task("A", "FAILED", "B"),
      task("B", "FAILED", "C"),
      task("C", "RUNNING")
    ];
    expect(isFailureResolved(tasks[0], index(tasks), { pendingSuccessId: "C" })).toBe(true);
  });

  it("当前任务不在链上 ⇒ 口径不变（仍然未解决）", () => {
    const tasks = [task("A", "FAILED", "B"), task("B", "PENDING"), task("C", "RUNNING")];
    expect(isFailureResolved(tasks[0], index(tasks), { pendingSuccessId: "C" })).toBe(false);
  });
});

describe("countWorkflowTaskProgress：展示进度含已解决失败", () => {
  it("直接指向 SUCCESS 的 FAILED 计入 completed → N/N", () => {
    const tasks = [
      task("A", "FAILED", "B"),
      task("B", "SUCCESS"),
      task("C", "SUCCESS")
    ];
    expect(countWorkflowTaskProgress(tasks)).toEqual({ completed: 3, total: 3 });
  });

  it("多层链尽头 SUCCESS → 中间 FAILED 也计入 completed", () => {
    const tasks = [
      task("A", "FAILED", "B"),
      task("B", "FAILED", "C"),
      task("C", "SUCCESS")
    ];
    expect(countWorkflowTaskProgress(tasks)).toEqual({ completed: 3, total: 3 });
  });

  it("未解决 FAILED 不计入 completed", () => {
    const tasks = [task("A", "FAILED"), task("B", "SUCCESS"), task("C", "RUNNING")];
    expect(countWorkflowTaskProgress(tasks)).toEqual({ completed: 1, total: 3 });
  });
});



describe("thrash fix：SUCCESS 前驱接替过时修复层", () => {
  it("REPLAN-1 SUCCESS 仍指向 REPLAN-2 FAILED ⇒ REPLAN-2 已解决（不重排）", () => {
    const tasks = [
      task("T-05", "FAILED", "REPLAN-1"),
      task("REPLAN-1", "SUCCESS", "REPLAN-2"),
      task("REPLAN-2", "FAILED")
    ];
    // 给 REPLAN-1 挂上 SUCCESS + resolvedBy（task helper 只在有第三参时写指针）
    expect(isSupersededBySuccessfulPredecessor(tasks[2], index(tasks))).toBe(true);
    expect(isFailureResolved(tasks[2], index(tasks))).toBe(true);
    expect(isFailureResolved(tasks[0], index(tasks))).toBe(true);
    expect(unresolvedFailedTasks(tasks)).toEqual([]);
    expect(retryableFailedTasks(tasks)).toEqual([]);
    expect(hasUnresolvedFailure(tasks)).toBe(false);
  });

  it("SUCCESS 前驱出站链上的 CANCELLED 不算未解决", () => {
    const tasks = [
      task("REPLAN-1", "SUCCESS", "REPLAN-2"),
      task("REPLAN-2", "CANCELLED")
    ];
    expect(hasUnresolvedFailure(tasks)).toBe(false);
  });

  it("整链 FAILED 时 retry 只重排最上游一层（不叠跑中间/叶子）", () => {
    const tasks = [
      task("A", "FAILED", "B"),
      task("B", "FAILED", "C"),
      task("C", "FAILED")
    ];
    expect(unresolvedFailedTasks(tasks).map((e) => e.id)).toEqual(["A", "B", "C"]);
    expect(retryableFailedTasks(tasks).map((e) => e.id)).toEqual(["A"]);
  });

  it("同根并行 REPLAN 森林只重排计划源一行（不叠跑过时支链）", () => {
    const tasks = [
      task("T-10", "FAILED", "T-10-REPLAN-3"),
      task("T-10-REPLAN-1", "FAILED", "T-10-REPLAN-1-REPLAN-3"),
      task("T-10-REPLAN-1-REPLAN-2", "FAILED", "T-10-REPLAN-2"),
      task("T-10-REPLAN-2", "FAILED"),
      task("T-10-REPLAN-3", "FAILED"),
      task("T-10-REPLAN-1-REPLAN-3", "FAILED")
    ];
    expect(replanRootTaskKey("T-10-REPLAN-1-REPLAN-3-REPLAN-2")).toBe("T-10");
    expect(retryableFailedTasks(tasks).map((e) => e.id)).toEqual(["T-10"]);
  });
});


function dep(
  id: string,
  sourceTaskId: string,
  targetTaskId: string,
  active: boolean
): TaskDependencyView {
  return {
    id,
    sourceTaskId,
    targetTaskId,
    sourceTaskKey: sourceTaskId,
    targetTaskKey: targetTaskId,
    workflowRunId: "workflow",
    origin: "DYNAMIC",
    active,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("planSupersededReplanEdgeRestore (taskflow-vue v9 deadlock)", () => {
  it("deactivates exhausted REPLAN outs and reactivates inactive source outs", () => {
    const tasks = [
      task("T-08", "SUCCESS", "replan-1"),
      task("replan-1", "FAILED", "replan-2"),
      task("replan-2", "FAILED"),
      task("T-10", "BLOCKED"),
      task("T-11", "BLOCKED")
    ];
    const dependencies = [
      dep("e-src-10", "T-08", "T-10", false),
      dep("e-src-11", "T-08", "T-11", false),
      dep("e-r2-10", "replan-2", "T-10", true),
      dep("e-r2-11", "replan-2", "T-11", true)
    ];
    const plan = planSupersededReplanEdgeRestore(tasks[0], tasks, dependencies);
    expect(plan.deactivateIds.sort()).toEqual(["e-r2-10", "e-r2-11"]);
    expect(plan.reactivateIds.sort()).toEqual(["e-src-10", "e-src-11"]);
    expect(plan.unblockTargetIds.sort()).toEqual(["T-10", "T-11"]);
  });

  it("no-ops when there are no stale REPLAN outs", () => {
    const tasks = [task("T-08", "SUCCESS", "replan-1"), task("replan-1", "SUCCESS")];
    const plan = planSupersededReplanEdgeRestore(tasks[0], tasks, [
      dep("e-src-10", "T-08", "T-10", true)
    ]);
    expect(plan.deactivateIds).toEqual([]);
    expect(plan.reactivateIds).toEqual([]);
  });
});


describe("docs/257：成功根任务下的旧失败修复行视为已解决", () => {
  function keyed(
    id: string,
    taskKey: string,
    status: Task["status"],
    resolvedByTaskId?: string
  ): Task {
    return { ...task(id, status, resolvedByTaskId), taskKey };
  }

  it("T-13 SUCCESS and stale T-13-REPLAN-6 FAILED without pointer → resolved", () => {
    const tasks = [
      keyed("t13", "T-13", "SUCCESS"),
      keyed("t13r1", "T-13-REPLAN-1", "FAILED"),
      keyed("t13r6", "T-13-REPLAN-6", "FAILED"),
      keyed("t14", "T-14", "RUNNING")
    ];
    const byId = index(tasks);
    expect(isFailureResolved(tasks[1], byId)).toBe(true);
    expect(isFailureResolved(tasks[2], byId)).toBe(true);
    expect(isSupersededBySuccessfulPredecessor(tasks[2], byId)).toBe(true);
    expect(unresolvedFailedTasks(tasks).map((entry) => entry.taskKey)).toEqual([]);
  });

  it("pendingSuccessId on the plan root also resolves stale repair leaves", () => {
    const tasks = [
      keyed("t13", "T-13", "RUNNING"),
      keyed("t13r6", "T-13-REPLAN-6", "FAILED")
    ];
    expect(isFailureResolved(tasks[1], index(tasks))).toBe(false);
    expect(isFailureResolved(tasks[1], index(tasks), { pendingSuccessId: "t13" })).toBe(true);
  });

  it("does not resolve a failed repair leaf when the plan root is still FAILED", () => {
    const tasks = [
      keyed("t14", "T-14", "FAILED", "t14r2"),
      keyed("t14r2", "T-14-REPLAN-2", "FAILED")
    ];
    expect(isFailureResolved(tasks[1], index(tasks))).toBe(false);
    expect(unresolvedFailedTasks(tasks).map((entry) => entry.taskKey)).toEqual([
      "T-14",
      "T-14-REPLAN-2"
    ]);
  });
});
