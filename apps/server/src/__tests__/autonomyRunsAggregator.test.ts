import type { Task, WorkflowEvent, WorkflowRun } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  aggregateAutonomyRunsForWorkflow,
  rootTaskKey,
  sanitizeAutonomyText
} from "../services/autonomyRunsAggregator";

function workflow(partial: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "wf-1",
    projectId: "proj-1",
    requirementId: "req-1",
    planningVersion: 8,
    status: "FAILED",
    policy: {
      maxConcurrency: 1,
      maxRetries: 2,
      failureStrategy: "REPLAN",
      allowRetry: true,
      allowReplan: true,
      approvalRequired: false,
      autonomyLevel: "L1"
    },
    input: { sliceKey: "slice-task-crud" },
    createdAt: "2026-11-06T01:00:00.000Z",
    updatedAt: "2026-11-06T07:00:00.000Z",
    ...partial
  };
}

function task(
  overrides: Partial<Task> & Pick<Task, "id" | "taskKey" | "type" | "status">
): Task {
  return {
    projectId: "proj-1",
    title: overrides.title ?? overrides.taskKey,
    description: "",
    priority: "MEDIUM",
    input: {},
    retryCount: 0,
    version: 1,
    origin: overrides.origin ?? "RUNTIME",
    createdAt: overrides.createdAt ?? "2026-11-06T01:10:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-11-06T01:10:00.000Z",
    ...overrides
  };
}

function evt(
  eventType: string,
  partial: Partial<WorkflowEvent> & { taskId?: string; payload?: Record<string, unknown> }
): WorkflowEvent {
  return {
    id: partial.id ?? `${eventType}-${partial.taskId ?? "x"}`,
    workflowRunId: "wf-1",
    eventType,
    payload: partial.payload ?? {},
    createdAt: partial.createdAt ?? "2026-11-06T01:20:00.000Z",
    ...(partial.taskId ? { taskId: partial.taskId } : {})
  };
}

describe("rootTaskKey / sanitizeAutonomyText", () => {
  it("strips nested DEBUG/REPLAN suffixes", () => {
    expect(rootTaskKey("T-02-DEBUG-1-REPLAN-2")).toBe("T-02");
    expect(rootTaskKey("T-01-REPLAN-1-DEBUG-2")).toBe("T-01");
    expect(rootTaskKey("T-04")).toBe("T-04");
  });

  it("never yields [object Object]", () => {
    expect(sanitizeAutonomyText({ a: 1 })).toBe('{"a":1}');
    expect(sanitizeAutonomyText("x [object Object] y")).toBe("x y");
    expect(sanitizeAutonomyText(undefined)).toBeNull();
  });
});

describe("aggregateAutonomyRunsForWorkflow", () => {
  it("groups v8-like lineages: T-01 repaired, T-02 exhausted, T-03 failed; ignores plain SUCCESS", () => {
    const t01 = task({
      id: "t01",
      taskKey: "T-01",
      type: "FRONTEND",
      status: "FAILED",
      title: "骨架",
      resolvedByTaskId: "t01r1",
      createdAt: "2026-11-06T01:10:00.000Z"
    });
    const t01d1 = task({
      id: "t01d1",
      taskKey: "T-01-DEBUG-1",
      type: "DEBUG",
      status: "SUCCESS",
      origin: "DYNAMIC",
      sourceTaskId: "t01",
      output: { summary: "Timeout root cause; retry FRONTEND" },
      createdAt: "2026-11-06T01:43:00.000Z"
    });
    const t01r1 = task({
      id: "t01r1",
      taskKey: "T-01-REPLAN-1",
      type: "FRONTEND",
      status: "FAILED",
      origin: "DYNAMIC",
      sourceTaskId: "t01",
      resolvedByTaskId: "t01r2",
      createdAt: "2026-11-06T01:43:01.000Z"
    });
    const t01d2 = task({
      id: "t01d2",
      taskKey: "T-01-REPLAN-1-DEBUG-2",
      type: "DEBUG",
      status: "SUCCESS",
      origin: "DYNAMIC",
      sourceTaskId: "t01r1",
      output: { summary: "Still timeout; one more FRONTEND pass" },
      createdAt: "2026-11-06T02:07:00.000Z"
    });
    const t01r2 = task({
      id: "t01r2",
      taskKey: "T-01-REPLAN-1-REPLAN-2",
      type: "FRONTEND",
      status: "SUCCESS",
      origin: "DYNAMIC",
      sourceTaskId: "t01r1",
      createdAt: "2026-11-06T02:07:01.000Z"
    });

    const t02 = task({
      id: "t02",
      taskKey: "T-02",
      type: "TEST",
      status: "SUCCESS",
      createdAt: "2026-11-06T02:20:00.000Z"
    });
    const t02d1 = task({
      id: "t02d1",
      taskKey: "T-02-DEBUG-1",
      type: "DEBUG",
      status: "SUCCESS",
      origin: "DYNAMIC",
      sourceTaskId: "t02",
      output: { summary: "Need FRONTEND for missing TaskForm", fixTaskType: "FRONTEND" },
      createdAt: "2026-11-06T02:44:00.000Z"
    });
    const t02r2 = task({
      id: "t02r2",
      taskKey: "T-02-DEBUG-1-REPLAN-2",
      type: "TEST",
      status: "FAILED",
      origin: "DYNAMIC",
      sourceTaskId: "t02d1",
      createdAt: "2026-11-06T03:26:00.000Z"
    });

    const t03 = task({
      id: "t03",
      taskKey: "T-03",
      type: "TEST",
      status: "SUCCESS",
      createdAt: "2026-11-06T02:30:00.000Z"
    });
    const t03d2 = task({
      id: "t03d2",
      taskKey: "T-03-DEBUG-1-DEBUG-2",
      type: "DEBUG",
      status: "READY",
      origin: "DYNAMIC",
      sourceTaskId: "t03",
      createdAt: "2026-11-06T03:41:00.000Z"
    });
    const t03r2 = task({
      id: "t03r2",
      taskKey: "T-03-DEBUG-1-REPLAN-2",
      type: "TEST",
      status: "PENDING",
      origin: "DYNAMIC",
      sourceTaskId: "t03",
      createdAt: "2026-11-06T03:41:01.000Z"
    });

    const t04 = task({
      id: "t04",
      taskKey: "T-04",
      type: "TEST",
      status: "SUCCESS",
      createdAt: "2026-11-06T02:50:00.000Z"
    });

    const events: WorkflowEvent[] = [
      evt("FAILURE_ROUTED", {
        taskId: "t01",
        createdAt: "2026-11-06T01:43:00.000Z",
        payload: {
          strategy: "REPLAN",
          failureClass: "AGENT_TIMEOUT",
          errorType: "AGENT_TIMEOUT",
          attempt: 0,
          reason: "AGENT_TIMEOUT: Timeout repair"
        }
      }),
      evt("REPLAN_STARTED", {
        taskId: "t01",
        createdAt: "2026-11-06T01:43:00.100Z",
        payload: { sourceTaskId: "t01" }
      }),
      evt("FAILURE_ROUTED", {
        taskId: "t02",
        createdAt: "2026-11-06T02:44:00.000Z",
        payload: {
          strategy: "REPLAN",
          failureClass: "AGENT_TIMEOUT",
          attempt: 0,
          reason: "AGENT_TIMEOUT"
        }
      }),
      evt("FAILURE_ROUTED", {
        taskId: "t02r2",
        createdAt: "2026-11-06T07:06:00.000Z",
        payload: {
          strategy: "FAIL",
          failureClass: "repair-exhausted",
          attempt: 2,
          reason: "Autonomy repair exhausted: executionAttempt 2 reached maxRetries 2",
          errorType: "REPLAN_REQUESTED"
        }
      }),
      evt("FAILURE_ROUTED", {
        taskId: "t03",
        createdAt: "2026-11-06T02:59:00.000Z",
        payload: {
          strategy: "REPLAN",
          failureClass: "AGENT_TIMEOUT",
          attempt: 0,
          reason: "AGENT_TIMEOUT"
        }
      })
    ];

    const records = aggregateAutonomyRunsForWorkflow({
      workflow: workflow(),
      projectName: "taskflow-vue",
      requirementName: "TaskFlow",
      tasks: [t01, t01d1, t01r1, t01d2, t01r2, t02, t02d1, t02r2, t03, t03d2, t03r2, t04],
      events
    });

    const keys = records.map((row) => row.sourceTaskKey).sort();
    expect(keys).toEqual(["T-01", "T-02", "T-03"]);
    expect(records.find((row) => row.sourceTaskKey === "T-04")).toBeUndefined();

    const r01 = records.find((row) => row.sourceTaskKey === "T-01")!;
    expect(r01.outcome).toBe("repaired");
    expect(r01.failureClass).toBe("AGENT_TIMEOUT");
    expect(r01.diagnosisSummary).toContain("Still timeout");
    expect(r01.repairTasks.map((item) => item.taskKey)).toEqual([
      "T-01-DEBUG-1",
      "T-01-REPLAN-1",
      "T-01-REPLAN-1-DEBUG-2",
      "T-01-REPLAN-1-REPLAN-2"
    ]);
    expect(r01.link).toBe("/workflows/wf-1");
    expect(r01.sliceKey).toBe("slice-task-crud");
    expect(r01.projectName).toBe("taskflow-vue");

    const r02 = records.find((row) => row.sourceTaskKey === "T-02")!;
    expect(r02.outcome).toBe("exhausted");
    expect(r02.failureClass).toBe("repair-exhausted");
    expect(r02.diagnosisSummary).toContain("TaskForm");
    expect(r02.repairTasks.some((item) => item.fixTaskType === "FRONTEND")).toBe(true);

    const r03 = records.find((row) => row.sourceTaskKey === "T-03")!;
    expect(r03.outcome).toBe("failed");
    expect(r03.repairTasks.some((item) => item.status === "READY")).toBe(true);
  });

  it("marks in_progress when workflow still running with open repair tasks", () => {
    const source = task({
      id: "s1",
      taskKey: "T-09",
      type: "FRONTEND",
      status: "FAILED",
      resolvedByTaskId: "r1"
    });
    const repair = task({
      id: "r1",
      taskKey: "T-09-REPLAN-1",
      type: "FRONTEND",
      status: "RUNNING",
      origin: "DYNAMIC",
      sourceTaskId: "s1",
      createdAt: "2026-11-06T03:00:00.000Z"
    });
    const records = aggregateAutonomyRunsForWorkflow({
      workflow: workflow({ status: "RUNNING" }),
      tasks: [source, repair],
      events: [
        evt("FAILURE_ROUTED", {
          taskId: "s1",
          payload: { strategy: "REPLAN", failureClass: "GATE_FAILURE", attempt: 0, reason: "gate" }
        }),
        evt("REPLAN_STARTED", { taskId: "s1", payload: { sourceTaskId: "s1" } })
      ]
    });
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("in_progress");
    expect(records[0].round).toBe(1);
  });
});
