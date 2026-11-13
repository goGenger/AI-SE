import { Task, TaskDependencyView } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { blockedTaskIds, readyTaskIds, validateWorkflowGraph } from "./scheduler";

function task(id: string, status: Task["status"]): Task {
  return {
    id,
    projectId: "project",
    workflowRunId: "workflow",
    taskKey: id,
    title: id,
    description: id,
    type: "TEST",
    status,
    priority: "MEDIUM",
    input: {},
    retryCount: 0,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function edge(sourceTaskId: string, targetTaskId: string): TaskDependencyView {
  return {
    id: `${sourceTaskId}-${targetTaskId}`,
    sourceTaskId,
    targetTaskId,
    sourceTaskKey: sourceTaskId,
    targetTaskKey: targetTaskId,
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("workflow scheduler", () => {
  it("resolves dependencies and parallel roots", () => {
    const tasks = [task("A", "PENDING"), task("B", "PENDING"), task("C", "PENDING")];
    const dependencies = [edge("A", "C"), edge("B", "C")];
    expect(readyTaskIds(tasks, dependencies)).toEqual(["A", "B"]);
    tasks[0].status = "SUCCESS";
    expect(readyTaskIds(tasks, dependencies)).toEqual(["B"]);
    tasks[1].status = "SUCCESS";
    expect(readyTaskIds(tasks, dependencies)).toEqual(["C"]);
  });

  it("blocks tasks after failed dependencies", () => {
    expect(blockedTaskIds([task("A", "FAILED"), task("B", "PENDING")], [edge("A", "B")])).toEqual([
      "B"
    ]);
  });

  it("validates dynamic dependencies and cycles", () => {
    expect(validateWorkflowGraph(["A", "B"], [edge("A", "B")])).toEqual([]);
    expect(validateWorkflowGraph(["A", "B"], [edge("A", "B"), edge("B", "A")])).toContain(
      "Cycle detected in Workflow Task DAG"
    );
    expect(validateWorkflowGraph(["A"], [edge("A", "missing")])[0]).toContain("missing task");
  });
});


describe("scheduler superseded REPLAN predecessors (v9)", () => {
  it("does not block / does ready when FAILED predecessor is superseded by SUCCESS source", () => {
    const source = task("T-08", "SUCCESS");
    source.resolvedByTaskId = "replan-2";
    const leaf = task("replan-2", "FAILED");
    leaf.failureHandled = true;
    const tasks = [source, leaf, task("T-10", "PENDING")];
    const dependencies = [edge("replan-2", "T-10")];
    expect(blockedTaskIds(tasks, dependencies)).toEqual([]);
    expect(readyTaskIds(tasks, dependencies)).toEqual(["T-10"]);
  });
});
