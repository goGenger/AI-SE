import { describe, expect, it } from "vitest";
import {
  dependencyLabel,
  latestSpecifications,
  latestTasks,
  requirementAnalysisProgress,
  requirementStatusLabel,
  requirementStatusTone,
  canStartSliceWorkflow,
  shouldShowAnalysisProgress,
  sliceStatusLabel,
  sliceStatusTone,
  specificationIsEmpty,
  specificationTypeLabel,
  taskSourceSummary,
  taskStatusLabel,
  taskStatusTone,
  taskTypeLabel
} from "../viewmodels/requirementViewModel";
import { Specification, Task, TaskDependencyView } from "@ai-se/shared";

describe("requirementViewModel", () => {
  it("formats requirement planning labels", () => {
    expect(requirementStatusLabel("ANALYZING")).toBe("分析中");
    expect(requirementStatusLabel("PLANNING_REVIEW")).toBe("规划待确认");
    expect(specificationTypeLabel("REQUIREMENT_ANALYSIS")).toBe("需求分析");
    expect(taskTypeLabel("BACKEND")).toBe("后端");
    expect(taskStatusLabel("WAITING_APPROVAL")).toBe("等待审批");
  });


  it("canStartSliceWorkflow：已规划/失败/完成且有 planningVersion 才可手动启动", () => {
    expect(canStartSliceWorkflow({ status: "PLANNED", planningVersion: 2 })).toBe(true);
    expect(canStartSliceWorkflow({ status: "FAILED", planningVersion: 2 })).toBe(true);
    expect(canStartSliceWorkflow({ status: "DONE", planningVersion: 2 })).toBe(true);
    expect(canStartSliceWorkflow({ status: "RUNNING", planningVersion: 2 })).toBe(false);
    expect(canStartSliceWorkflow({ status: "PENDING", planningVersion: null })).toBe(false);
    expect(canStartSliceWorkflow({ status: "PLANNED", planningVersion: null })).toBe(false);
  });
  it("formats slice status labels and tones（N2 关口 1）", () => {
    expect(sliceStatusLabel("PENDING")).toBe("待规划");
    expect(sliceStatusLabel("PLANNED")).toBe("已规划");
    expect(sliceStatusLabel("DONE")).toBe("已完成");
    expect(sliceStatusTone("PENDING")).toBe("pending");
    expect(sliceStatusTone("RUNNING")).toBe("running");
    expect(sliceStatusTone("DONE")).toBe("success");
    expect(sliceStatusTone("FAILED")).toBe("error");
  });

  it("detects empty specifications（类别不适用 = 全空数组）", () => {
    expect(specificationIsEmpty({ endpoints: [] })).toBe(true);
    expect(specificationIsEmpty({ components: [], dataFlow: [] })).toBe(true);
    expect(specificationIsEmpty({})).toBe(true);
    expect(specificationIsEmpty({ endpoints: [{ method: "GET" }] })).toBe(false);
    expect(specificationIsEmpty({ specKey: "spec-1" })).toBe(false);
    expect(specificationIsEmpty({ requirements: [{ id: "R-1" }] })).toBe(false);
  });

  it("maps requirement status to StatusBadge tone (Phase 6-B 纯展示映射)", () => {
    expect(requirementStatusTone("DRAFT")).toBe("pending");
    expect(requirementStatusTone("ANALYZING")).toBe("running");
    expect(requirementStatusTone("PLANNING_REVIEW")).toBe("warning");
    expect(requirementStatusTone("ANALYZED")).toBe("success");
    expect(requirementStatusTone("FAILED")).toBe("error");
  });

  it("maps task status to StatusBadge tone (Phase 6-B 纯展示映射)", () => {
    expect(taskStatusTone("PENDING")).toBe("pending");
    expect(taskStatusTone("READY")).toBe("pending");
    expect(taskStatusTone("RUNNING")).toBe("running");
    expect(taskStatusTone("RETRYING")).toBe("running");
    expect(taskStatusTone("WAITING_APPROVAL")).toBe("warning");
    expect(taskStatusTone("BLOCKED")).toBe("warning");
    expect(taskStatusTone("SUCCESS")).toBe("success");
    expect(taskStatusTone("FAILED")).toBe("error");
    expect(taskStatusTone("CANCELLED")).toBe("neutral");
  });

  it("selects latest specifications and tasks", () => {
    const specs: Specification[] = [
      spec("spec-1", 1, "API"),
      spec("spec-2", 2, "API"),
      spec("spec-3", 2, "UI")
    ];
    const tasks: Task[] = [task("task-1", 1), task("task-2", 2), task("task-3", 2)];

    expect(latestSpecifications(specs).map((entry) => entry.id)).toEqual(["spec-2", "spec-3"]);
    expect(latestTasks(tasks).map((entry) => entry.id)).toEqual(["task-2", "task-3"]);
  });

  it("formats dependencies and source specs", () => {
    const dependency: TaskDependencyView = {
      id: "dep-1",
      sourceTaskId: "task-1",
      targetTaskId: "task-2",
      sourceTaskKey: "TASK-001",
      targetTaskKey: "TASK-002",
      createdAt: new Date().toISOString()
    };

    expect(dependencyLabel(dependency)).toBe("TASK-001 -> TASK-002");
    expect(taskSourceSummary(task("task-1", 1))).toBe("API、UI");
  });

  it("derives analysis progress from status / events / approval（不编造步骤）", () => {
    expect(shouldShowAnalysisProgress("ANALYZED")).toBe(false);
    expect(shouldShowAnalysisProgress("DRAFT")).toBe(false);
    expect(shouldShowAnalysisProgress("ANALYZING")).toBe(true);
    expect(shouldShowAnalysisProgress("PLANNING_REVIEW")).toBe(true);
    expect(shouldShowAnalysisProgress("FAILED")).toBe(true);

    expect(requirementAnalysisProgress({ status: "DRAFT" }).label).toBe("待分析");
    expect(requirementAnalysisProgress({ status: "ANALYZED" }).label).toBe("已分析完成");
    expect(
      requirementAnalysisProgress({
        status: "FAILED",
        agentRun: {
          run: {
            id: "run-1",
            taskId: "task-1",
            status: "failed",
            input: {},
            currentIteration: 1,
            maxIterations: 8,
            retryCount: 0,
            createdAt: "",
            updatedAt: "",
            error: { code: "PLANNING_ERROR", message: "vision failed" }
          },
          toolCalls: [],
          events: [],
          context: {
            projectName: null,
            workflow: null,
            task: null,
            agentName: null,
            agentType: null,
            maxRetries: null
          },
          recovery: null,
          artifacts: [],
          evidence: []
        }
      })
    ).toEqual({
      label: "分析失败",
      detail: "[PLANNING_ERROR] vision failed",
      tone: "error"
    });

    expect(
      requirementAnalysisProgress({
        status: "PLANNING_REVIEW",
        approval: { status: "PENDING", reason: "切片过大，请确认" }
      })
    ).toEqual({
      label: "等待确认切片计划",
      detail: "切片过大，请确认",
      tone: "warning"
    });

    expect(
      requirementAnalysisProgress({
        status: "ANALYZING",
        agentRun: {
          run: {
            id: "run-1",
            taskId: "task-1",
            status: "running",
            input: {},
            currentIteration: 1,
            maxIterations: 8,
            retryCount: 0,
            createdAt: "",
            updatedAt: ""
          },
          toolCalls: [],
          events: [
            {
              id: "e1",
              eventType: "PLANNING_STARTED",
              payload: {},
              createdAt: "2026-01-01T00:00:00.000Z"
            },
            {
              id: "e2",
              eventType: "UI_REFERENCE_DESCRIBED",
              payload: { describedCount: 2 },
              createdAt: "2026-01-01T00:01:00.000Z"
            }
          ],
          context: {
            projectName: null,
            workflow: null,
            task: null,
            agentName: null,
            agentType: null,
            maxRetries: null
          },
          recovery: null,
          artifacts: [],
          evidence: []
        }
      })
    ).toEqual({
      label: "UI 参照图已描述，继续规划",
      detail: "已描述 2 张",
      tone: "running"
    });

    expect(
      requirementAnalysisProgress({ status: "ANALYZING", analyzing: true }).label
    ).toBe("分析进行中");
  });

});

function spec(id: string, version: number, type: Specification["type"]): Specification {
  const timestamp = new Date().toISOString();
  return {
    id,
    projectId: "project-1",
    requirementId: "requirement-1",
    type,
    version,
    status: "VALIDATED",
    content: {},
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function task(id: string, version: number): Task {
  const timestamp = new Date().toISOString();
  return {
    id,
    projectId: "project-1",
    requirementId: "requirement-1",
    taskKey: id.toUpperCase(),
    title: id,
    description: `${id} description`,
    type: "BACKEND",
    status: "PENDING",
    priority: "MEDIUM",
    input: { sourceSpecTypes: ["API", "UI"] },
    retryCount: 0,
    version,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
