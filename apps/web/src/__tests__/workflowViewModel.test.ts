import { Task, TaskDependencyView, WorkflowEvent, type WorkflowSummary } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_ACTIVE_STATUSES,
  WORKFLOW_ATTENTION_STATUSES,
  canPause,
  canResume,
  countWorkflowsInStatus,
  latestWorkflows,
  canRetry,
  canStart,
  displayTaskStatus,
  displayTaskStatusLabel,
  displayTaskStatusTone,
  eventTimeLabel,
  filterWorkflows,
  isTaskFailureResolved,
  normalizeWorkspacePath,
  taskAgentRunId,
  taskDependencies,
  taskResolutionNote,
  workflowDurationLabel,
  workflowEventView,
  workflowProgressLabel,
  workflowStatusLabel,
  workflowStatusTone,
  workflowTaskProgress,
  workflowTimeLabel,
  deriveAutonomyRepairProgress,
  autonomyFailureClassLabel,
  formatDisplayValue
} from "../viewmodels/workflowViewModel";

const task = { id: "B" } as Task;
const dependencies = [
  {
    id: "edge",
    sourceTaskId: "A",
    targetTaskId: "B",
    sourceTaskKey: "TASK-A",
    targetTaskKey: "TASK-B",
    active: true,
    createdAt: ""
  }
] as TaskDependencyView[];

describe("workflow view model", () => {
  it("maps actions to legal workflow states", () => {
    expect(canStart("PENDING")).toBe(true);
    expect(canPause("RUNNING")).toBe(true);
    expect(canPause("WAITING_APPROVAL")).toBe(true);
    expect(canResume("PAUSED")).toBe(true);
    expect(canStart("SUCCESS")).toBe(false);
  });

  it("maps the manual retry action to the FAILED state only", () => {
    expect(canRetry("FAILED")).toBe(true);
    for (const status of [
      "PENDING",
      "RUNNING",
      "PAUSED",
      "WAITING_APPROVAL",
      "SUCCESS",
      "CANCELLED"
    ] as const) {
      expect(canRetry(status), `${status} 不应出现重试入口`).toBe(false);
    }
  });

  it("formats statuses and active task dependencies", () => {
    expect(workflowStatusLabel("WAITING_APPROVAL")).toBe("等待审批");
    expect(taskDependencies(task, dependencies)).toEqual(["TASK-A"]);
    dependencies[0].active = false;
    expect(taskDependencies(task, dependencies)).toEqual([]);
  });

  it("maps workflow status to StatusBadge tone (Phase 7-B 纯展示映射)", () => {
    expect(workflowStatusTone("PENDING")).toBe("pending");
    expect(workflowStatusTone("RUNNING")).toBe("running");
    expect(workflowStatusTone("PAUSED")).toBe("neutral");
    expect(workflowStatusTone("WAITING_APPROVAL")).toBe("warning");
    expect(workflowStatusTone("SUCCESS")).toBe("success");
    expect(workflowStatusTone("FAILED")).toBe("error");
    expect(workflowStatusTone("CANCELLED")).toBe("neutral");
  });

  it("keeps tone independent from lifecycle predicates (tone 不参与业务判定)", () => {
    // 同一状态在 tone 与 canStart/canPause/canResume 上的语义互不影响
    expect(workflowStatusTone("PENDING")).toBe("pending");
    expect(canStart("PENDING")).toBe(true);
    expect(workflowStatusTone("PAUSED")).toBe("neutral");
    expect(canResume("PAUSED")).toBe(true);
    expect(workflowStatusTone("FAILED")).toBe("error");
    expect(canStart("FAILED")).toBe(false);
    expect(canPause("FAILED")).toBe(false);
  });

  it("normalizes the optional workspace path", () => {
    expect(normalizeWorkspacePath("  /srv/repos/app  ")).toBe("/srv/repos/app");
    expect(normalizeWorkspacePath("")).toBeUndefined();
    expect(normalizeWorkspacePath("   ")).toBeUndefined();
  });

  it("converts file:// URLs (drag-and-drop) to plain local paths", () => {
    expect(normalizeWorkspacePath("file:///Users/me/Desktop/study/Mini-Todo")).toBe(
      "/Users/me/Desktop/study/Mini-Todo"
    );
    expect(normalizeWorkspacePath("file:///Users/me/My%20Repo")).toBe("/Users/me/My Repo");
  });
});

describe("UX-02 workflow context & timeline helpers", () => {
  const evt = (overrides: Partial<WorkflowEvent> = {}): WorkflowEvent =>
    ({
      id: "e1",
      eventType: "TASK_STARTED",
      payload: {},
      createdAt: "2026-09-14T03:04:56.701Z",
      ...overrides
    }) as WorkflowEvent;

  it("formats task progress without inventing a progress entity", () => {
    expect(workflowProgressLabel(3, 10)).toBe("3 / 10");
    expect(workflowProgressLabel(0, 0)).toBe("—");
  });

  it("formats duration from started/finished timestamps", () => {
    expect(workflowDurationLabel()).toBe("—");
    expect(workflowDurationLabel("2026-01-01T00:00:00.000Z")).toBe("进行中");
    expect(workflowDurationLabel("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.500Z")).toBe(
      "<1s"
    );
    expect(workflowDurationLabel("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:12.000Z")).toBe(
      "12s"
    );
    expect(workflowDurationLabel("2026-01-01T00:00:00.000Z", "2026-01-01T00:03:05.000Z")).toBe(
      "3m 05s"
    );
    expect(workflowDurationLabel("2026-01-01T00:00:00.000Z", "2026-01-01T01:20:00.000Z")).toBe(
      "1h 20m"
    );
    expect(workflowDurationLabel("2026-01-01T00:00:10.000Z", "2026-01-01T00:00:00.000Z")).toBe("—");
  });

  it("renders invalid timestamps as placeholder", () => {
    expect(workflowTimeLabel()).toBe("—");
    expect(workflowTimeLabel("not-a-date")).toBe("—");
    expect(eventTimeLabel()).toBe("—");
    expect(eventTimeLabel("not-a-date")).toBe("—");
  });

  it("filters workflow list by project and status", () => {
    const items = [
      { projectId: "p1", status: "RUNNING" },
      { projectId: "p1", status: "FAILED" },
      { projectId: "p2", status: "RUNNING" }
    ] as Array<{ projectId: string; status: "RUNNING" | "FAILED" }>;

    expect(filterWorkflows(items, {})).toHaveLength(3);
    expect(filterWorkflows(items, { projectId: "p1" })).toHaveLength(2);
    expect(filterWorkflows(items, { status: "RUNNING" })).toHaveLength(2);
    expect(filterWorkflows(items, { projectId: "p1", status: "RUNNING" })).toHaveLength(1);
    expect(filterWorkflows(items, { projectId: "p2", status: "FAILED" })).toHaveLength(0);
  });

  it("summarizes a failure event with type, reason and attempt", () => {
    const task = {
      id: "t1",
      title: "实现 Todo API",
      assignedAgent: "backend-agent",
      retryCount: 2,
      output: { error: "POST /api/todos 返回 500" }
    } as unknown as Task;

    const view = workflowEventView(
      evt({ eventType: "TASK_FAILED", taskId: "t1", payload: { errorCode: "TEST_ERROR" } }),
      { tasks: [task], maxRetries: 3 }
    );

    expect(view.summary).toBe("「实现 Todo API」执行失败");
    expect(view.tone).toBe("error");
    expect(view.taskTitle).toBe("实现 Todo API");
    expect(view.agentName).toBe("backend-agent");
    expect(view.taskId).toBe("t1");
    expect(view.details).toEqual([
      { label: "执行 Agent", value: "backend-agent" },
      { label: "错误类型", value: "TEST_ERROR" },
      { label: "原因", value: "POST /api/todos 返回 500" },
      { label: "尝试", value: "2 / 3" }
    ]);
  });

  it("keeps agent run links and recovers output-based agent run ids", () => {
    const task = {
      id: "t1",
      title: "实现 Todo API",
      assignedAgent: "backend-agent",
      output: { agentRunId: "run-42" }
    } as unknown as Task;

    const view = workflowEventView(evt({ taskId: "t1" }), { tasks: [task] });
    expect(view.agentRunId).toBe("run-42");
    expect(view.summary).toBe("backend-agent 开始执行「实现 Todo API」");
  });

  it("summarizes agent runtime events on the workflow timeline", () => {
    expect(
      workflowEventView(
        evt({
          eventType: "tool_call_finished",
          payload: { toolName: "git_status", status: "succeeded", duration: 120, iteration: 3 }
        })
      ).summary
    ).toBe("工具 git_status 调用完成");

    const failedTool = workflowEventView(
      evt({
        eventType: "tool_call_finished",
        payload: { toolName: "run_build", error: { code: "COMMAND_FAILED", message: "exit 1" } }
      })
    );
    expect(failedTool.summary).toBe("工具 run_build 调用失败");
    expect(failedTool.tone).toBe("error");
    expect(failedTool.details).toEqual(
      expect.arrayContaining([
        { label: "错误码", value: "COMMAND_FAILED" },
        { label: "原因", value: "exit 1" }
      ])
    );

    expect(
      workflowEventView(
        evt({
          eventType: "agent_run_finished",
          payload: { status: "timed_out", errorCode: "TIMEOUT_ERROR" }
        })
      ).tone
    ).toBe("warning");

    expect(
      workflowEventView(
        evt({
          eventType: "agent_resolved",
          payload: { agentName: "planner-agent", taskType: "DESIGN", capabilities: ["PLAN"] }
        })
      ).summary
    ).toBe("已选定 Agent：planner-agent");

    expect(
      workflowEventView(
        evt({
          eventType: "agent_run_created",
          payload: { agentName: "database-agent", taskKey: "T-002" }
        })
      ).summary
    ).toBe("Agent database-agent 已接手任务 T-002");

    expect(
      workflowEventView(evt({ eventType: "tool_call_started", payload: { toolName: "read_file" } }))
        .tone
    ).toBe("running");
  });

  it("summarizes routing / replan / lifecycle events and falls back for unknown types", () => {
    expect(
      workflowEventView(
        evt({
          eventType: "FAILURE_ROUTED",
          payload: { strategy: "RETRY", failureClass: "TEST_ERROR" }
        })
      ).summary
    ).toBe("失败已路由：重试");

    expect(workflowEventView(evt({ eventType: "WORKFLOW_STARTED" })).summary).toBe("工作流已启动");

    expect(
      workflowEventView(
        evt({ eventType: "REPLAN_COMPLETED", payload: { dynamicTaskIds: ["a", "b"] } })
      ).details
    ).toEqual([{ label: "新增动态任务", value: "2" }]);

    const unknown = workflowEventView(evt({ eventType: "SOMETHING_NEW" }));
    expect(unknown.summary).toBe("已记录");
    expect(unknown.tone).toBe("neutral");
  });

  it("summarizes the manual retry events (re-queued task / retried workflow)", () => {
    const task = { id: "t1", title: "实现 Todo API" } as unknown as Task;

    const requeued = workflowEventView(
      evt({
        eventType: "TASK_RETRY_REQUESTED",
        taskId: "t1",
        payload: { taskKey: "T1", from: "FAILED" }
      }),
      { tasks: [task] }
    );
    expect(requeued.summary).toBe("「实现 Todo API」已重新排队");
    expect(requeued.tone).toBe("warning");
    expect(requeued.details).toEqual([{ label: "来源", value: "失败重试" }]);

    const unblocked = workflowEventView(
      evt({
        eventType: "TASK_RETRY_REQUESTED",
        taskId: "t1",
        payload: { taskKey: "T1", from: "BLOCKED" }
      }),
      { tasks: [task] }
    );
    expect(unblocked.details).toEqual([{ label: "来源", value: "解除阻塞" }]);

    const retried = workflowEventView(
      evt({
        eventType: "WORKFLOW_RETRIED",
        payload: { retriedTaskKeys: ["T1", "T2"], requeuedTaskKeys: ["T3"] }
      })
    );
    expect(retried.summary).toBe("工作流已重试（失败任务 2 个 / 解除阻塞 1 个）");
    expect(retried.tone).toBe("warning");
  });
});

describe("taskAgentRunId", () => {
  const runningTask = { id: "task-1", output: { agentRunId: "run-old" } } as unknown as Task;
  const event = (id: string, taskId: string, agentRunId?: string): WorkflowEvent =>
    ({
      id,
      taskId,
      agentRunId,
      eventType: "tool_call_started",
      payload: {},
      createdAt: ""
    }) as WorkflowEvent;

  it("优先取该任务最新事件里的运行 id（运行中即可跳转）", () => {
    expect(
      taskAgentRunId(runningTask, [
        event("e1", "task-1", "run-old"),
        event("e2", "task-1", "run-new")
      ])
    ).toBe("run-new");
  });

  it("该任务没有带 agentRunId 的事件时回退到 output.agentRunId", () => {
    expect(taskAgentRunId(runningTask, [event("e1", "task-2", "run-other")])).toBe("run-old");
  });

  it("跳过无 agentRunId 的事件（TASK_STARTED / TASK_COMPLETED 之类）", () => {
    expect(
      taskAgentRunId(runningTask, [event("e1", "task-1", "run-new"), event("e2", "task-1")])
    ).toBe("run-new");
  });

  it("事件与 output 都没有运行时返回 undefined（不渲染跳转）", () => {
    expect(taskAgentRunId({ id: "task-9", output: {} } as unknown as Task, [])).toBeUndefined();
  });
});

/**
 * 仪表盘口径（W6）。这四个导出只服务 DashboardView：
 * 把「什么算需要处理 / 什么算正在跑」写成常量而不是散在模板里的字符串比较。
 */
describe("工作流口径：需要处理 / 正在运行（W6 仪表盘）", () => {
  function wf(id: string, status: WorkflowSummary["status"], createdAt: string): WorkflowSummary {
    return { id, status, createdAt } as unknown as WorkflowSummary;
  }

  it("关注口径 = FAILED + WAITING_APPROVAL + PAUSED", () => {
    expect([...WORKFLOW_ATTENTION_STATUSES]).toEqual(["FAILED", "WAITING_APPROVAL", "PAUSED"]);
  });

  it("推进口径 = RUNNING + PENDING", () => {
    expect([...WORKFLOW_ACTIVE_STATUSES]).toEqual(["RUNNING", "PENDING"]);
  });

  it("SUCCESS / CANCELLED 不属于任何一边，因此不计入任何一个数字", () => {
    const list = [
      wf("w1", "SUCCESS", "2026-01-01T00:00:00.000Z"),
      wf("w2", "CANCELLED", "2026-01-02T00:00:00.000Z")
    ];
    expect(countWorkflowsInStatus(list, WORKFLOW_ATTENTION_STATUSES)).toBe(0);
    expect(countWorkflowsInStatus(list, WORKFLOW_ACTIVE_STATUSES)).toBe(0);
  });

  it("计数按真实状态过滤", () => {
    const list = [
      wf("w1", "FAILED", "2026-01-01T00:00:00.000Z"),
      wf("w2", "FAILED", "2026-01-02T00:00:00.000Z"),
      wf("w3", "WAITING_APPROVAL", "2026-01-03T00:00:00.000Z"),
      wf("w4", "RUNNING", "2026-01-04T00:00:00.000Z")
    ];
    expect(countWorkflowsInStatus(list, WORKFLOW_ATTENTION_STATUSES)).toBe(3);
    expect(countWorkflowsInStatus(list, WORKFLOW_ACTIVE_STATUSES)).toBe(1);
    expect(countWorkflowsInStatus(list, [])).toBe(0);
  });

  it("latestWorkflows 按 createdAt 倒序、默认 5 条、不改动入参", () => {
    const list = [
      wf("old", "SUCCESS", "2026-01-01T00:00:00.000Z"),
      wf("new", "SUCCESS", "2026-01-09T00:00:00.000Z"),
      wf("mid", "SUCCESS", "2026-01-05T00:00:00.000Z")
    ];
    expect(latestWorkflows(list).map((w) => w.id)).toEqual(["new", "mid", "old"]);
    expect(list.map((w) => w.id)).toEqual(["old", "new", "mid"]);
    expect(latestWorkflows(list, 1).map((w) => w.id)).toEqual(["new"]);
  });
});


describe("deriveAutonomyRepairProgress (AFC-M5)", () => {
  const evt = (
    eventType: string,
    payload: Record<string, unknown>,
    id = "e1"
  ): WorkflowEvent =>
    ({
      id,
      workflowRunId: "w1",
      eventType,
      payload,
      createdAt: "2026-11-05T12:00:00.000Z"
    }) as WorkflowEvent;

  it("AFC-8: active REPLAN shows round + failure class + evidence", () => {
    const progress = deriveAutonomyRepairProgress(
      [
        evt("FAILURE_ROUTED", {
          strategy: "REPLAN",
          failureClass: "DEPENDENCIES_MISSING",
          attempt: 0,
          evidenceSummary: "vue-tsc: not found"
        }),
        evt("REPLAN_STARTED", {}, "e2")
      ],
      "RUNNING"
    );
    expect(progress).not.toBeNull();
    expect(progress?.active).toBe(true);
    expect(progress?.exhausted).toBe(false);
    expect(progress?.round).toBe(1);
    expect(progress?.failureClass).toBe("DEPENDENCIES_MISSING");
    expect(progress?.evidenceLine).toContain("vue-tsc");
    expect(progress?.label).toContain("自治修复中");
    expect(progress?.label).toContain("依赖/环境缺失");
  });

  it("AFC-9: repair-exhausted is readable (not blank FAILED)", () => {
    const progress = deriveAutonomyRepairProgress(
      [
        evt("FAILURE_ROUTED", {
          strategy: "FAIL",
          failureClass: "repair-exhausted",
          attempt: 2,
          evidenceSummary: "last gate exit 127",
          reason: "Autonomy repair exhausted: executionAttempt 2 reached maxRetries 2"
        })
      ],
      "FAILED"
    );
    expect(progress?.exhausted).toBe(true);
    expect(progress?.active).toBe(false);
    expect(progress?.label).toContain("耗尽");
    expect(progress?.evidenceLine).toContain("exit 127");
  });

  it("no FAILURE_ROUTED → null (no banner)", () => {
    expect(deriveAutonomyRepairProgress([evt("TASK_COMPLETED", {})], "SUCCESS")).toBeNull();
  });

  it("strips literal [object Object] from evidenceLine", () => {
    const progress = deriveAutonomyRepairProgress(
      [
        evt("FAILURE_ROUTED", {
          strategy: "REPLAN",
          failureClass: "AGENT_TIMEOUT",
          attempt: 0,
          evidenceSummary:
            "Agent 运行超时（900s），未返回结果。 Agent 运行超时（900s），未返回结果。[object Object]"
        })
      ],
      "RUNNING"
    );
    expect(progress?.evidenceLine).toBe(
      "Agent 运行超时（900s），未返回结果。 Agent 运行超时（900s），未返回结果。"
    );
    expect(progress?.evidenceLine).not.toContain("[object Object]");
  });

  it("evidenceLine becomes null when only [object Object] remains", () => {
    const progress = deriveAutonomyRepairProgress(
      [
        evt("FAILURE_ROUTED", {
          strategy: "FAIL",
          failureClass: "repair-exhausted",
          attempt: 2,
          evidenceSummary: "[object Object]  [object Object]"
        })
      ],
      "FAILED"
    );
    expect(progress?.evidenceLine).toBeNull();
  });
});

describe("REPLAN 接替失败的展示 / 进度（与引擎 isFailureResolved 同形）", () => {
  function t(
    id: string,
    status: Task["status"],
    opts: { resolvedByTaskId?: string; taskKey?: string } = {}
  ): Task {
    return {
      id,
      projectId: "p",
      workflowRunId: "w",
      taskKey: opts.taskKey ?? id,
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
      ...(opts.resolvedByTaskId ? { resolvedByTaskId: opts.resolvedByTaskId } : {})
    } as Task;
  }

  it("直接指向 SUCCESS ⇒ 已解决，徽章「已解决」+ 成功色，进度计入 completed", () => {
    const tasks = [
      t("A", "FAILED", { resolvedByTaskId: "B", taskKey: "TASK-09" }),
      t("B", "SUCCESS", { taskKey: "TASK-09-REPLAN-1" }),
      t("C", "SUCCESS", { taskKey: "TASK-11" })
    ];
    expect(isTaskFailureResolved(tasks[0], tasks)).toBe(true);
    expect(displayTaskStatus(tasks[0], tasks)).toBe("RESOLVED");
    expect(displayTaskStatusLabel(tasks[0], tasks)).toBe("已解决");
    expect(displayTaskStatusTone(tasks[0], tasks)).toBe("success");
    expect(taskResolutionNote(tasks[0], tasks)).toBe("已由 TASK-09-REPLAN-1 解决");
    expect(workflowTaskProgress(tasks)).toEqual({ completed: 3, total: 3 });
  });

  it("多层链尽头 SUCCESS ⇒ 中间 FAILED 也算已解决", () => {
    const tasks = [
      t("A", "FAILED", { resolvedByTaskId: "B", taskKey: "TASK-09" }),
      t("B", "FAILED", { resolvedByTaskId: "C", taskKey: "TASK-09-REPLAN-1" }),
      t("C", "SUCCESS", { taskKey: "TASK-09-REPLAN-1-REPLAN-2" })
    ];
    expect(isTaskFailureResolved(tasks[0], tasks)).toBe(true);
    expect(isTaskFailureResolved(tasks[1], tasks)).toBe(true);
    expect(taskResolutionNote(tasks[0], tasks)).toBe("已由 TASK-09-REPLAN-1-REPLAN-2 解决");
    expect(workflowTaskProgress(tasks)).toEqual({ completed: 3, total: 3 });
  });

  it("未解决 FAILED 仍显示失败，不计入 completed", () => {
    const tasks = [
      t("A", "FAILED", { taskKey: "TASK-09" }),
      t("B", "SUCCESS", { taskKey: "TASK-10" }),
      t("C", "RUNNING", { taskKey: "TASK-11" })
    ];
    expect(isTaskFailureResolved(tasks[0], tasks)).toBe(false);
    expect(displayTaskStatus(tasks[0], tasks)).toBe("FAILED");
    expect(displayTaskStatusLabel(tasks[0], tasks)).toBe("失败");
    expect(displayTaskStatusTone(tasks[0], tasks)).toBe("error");
    expect(taskResolutionNote(tasks[0], tasks)).toBeNull();
    expect(workflowTaskProgress(tasks)).toEqual({ completed: 1, total: 3 });
  });
});


describe("formatDisplayValue (no [object Object])", () => {
  it("serializes objects and arrays instead of [object Object]", () => {
    expect(formatDisplayValue("plain")).toBe("plain");
    expect(formatDisplayValue(42)).toBe("42");
    expect(formatDisplayValue(true)).toBe("true");
    expect(formatDisplayValue(null)).toBe("");
    expect(formatDisplayValue(undefined)).toBe("");
    expect(formatDisplayValue({ code: "X", n: 1 })).toBe('{"code":"X","n":1}');
    expect(formatDisplayValue(["a", "b"])).toBe('["a","b"]');
    expect(formatDisplayValue({ nested: { a: 1 } })).not.toContain("[object Object]");
  });

  it("workflowEventView details never render [object Object] for known push values", () => {
    const replan = workflowEventView({
      id: "e1",
      workflowRunId: "w1",
      eventType: "REPLAN_COMPLETED",
      payload: { dynamicTaskIds: ["a", "b", "c"] },
      createdAt: "2026-11-05T12:00:00.000Z"
    } as WorkflowEvent);
    expect(replan.details).toEqual([{ label: "新增动态任务", value: "3" }]);
    expect(JSON.stringify(replan.details)).not.toContain("[object Object]");

    // Defensive: formatDisplayValue is what push uses — object input must not become [object Object]
    expect(formatDisplayValue({ reason: "timeout", meta: { n: 1 } })).toBe(
      '{"reason":"timeout","meta":{"n":1}}'
    );
  });
});
