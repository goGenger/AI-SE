import { describe, expect, it } from "vitest";
import {
  agentRunFailureView,
  agentRunTask,
  agentStatusLabel,
  agentStatusTone,
  attemptLabel,
  buildExecutionTrace,
  eventLabel,
  eventSummary,
  failureTypeLabel,
  failureTypeTone,
  formatDuration,
  isActiveRun,
  agentOutcomeLabel,
  issueSeverityLabel,
  recoveryBadgeText,
  recoveryStrategyLabel,
  recoveryStrategyText,
  taskOutcomeNote,
  toolCallStatusLabel,
  toolStatusLabel,
  toolStatusTone
} from "../viewmodels/agentRunViewModel";

describe("agentRunViewModel", () => {
  it("formats agent and tool statuses", () => {
    expect(agentStatusLabel("timed_out")).toBe("已超时");
    expect(toolCallStatusLabel("succeeded")).toBe("已成功");
    expect(toolCallStatusLabel("failed")).toBe("失败");
    expect(toolCallStatusLabel("timed_out")).toBe("已超时");
    expect(toolCallStatusLabel("UNKNOWN_STATE")).toBe("UNKNOWN_STATE");
    expect(agentOutcomeLabel("SUCCESS")).toBe("成功");
    expect(agentOutcomeLabel("FAILED")).toBe("失败");
    expect(agentOutcomeLabel("RETRY")).toBe("请求重试");
    expect(agentOutcomeLabel(undefined)).toBe("—");
    expect(issueSeverityLabel("MEDIUM")).toBe("中");
    expect(issueSeverityLabel("CRITICAL")).toBe("严重");
    expect(issueSeverityLabel("WEIRD")).toBe("WEIRD");
    expect(
      toolStatusLabel({
        id: "tool-row-1",
        agentRunId: "run-1",
        iteration: 1,
        toolCallId: "call-1",
        toolName: "run_unit_test",
        input: { summary: "run tests" },
        status: "failed",
        duration: 10,
        error: { code: "TEST_ERROR", message: "tests failed" },
        startedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      })
    ).toBe("TEST_ERROR");
  });

  it("detects active runs", () => {
    expect(
      isActiveRun({
        id: "run-1",
        taskId: "task-1",
        status: "running",
        input: {},
        currentIteration: 1,
        maxIterations: 16,
        retryCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
    ).toBe(true);
  });

  it("formats events", () => {
    const event = {
      id: "event-1",
      agentRunId: "run-1",
      eventType: "tool_call_finished",
      payload: { toolName: "read_file", status: "succeeded" },
      createdAt: new Date().toISOString()
    };

    expect(eventLabel(event)).toBe("工具完成");
    expect(eventSummary(event)).toBe("read_file / succeeded");
  });

  it("formats durations", () => {
    expect(formatDuration(90)).toBe("90ms");
    expect(formatDuration(1250)).toBe("1.3s");
    expect(formatDuration()).toBe("-");
  });

  it("maps AgentRunStatus to StatusBadge tone (Phase 8-B 纯展示映射)", () => {
    expect(agentStatusTone("created")).toBe("pending");
    expect(agentStatusTone("running")).toBe("running");
    expect(agentStatusTone("succeeded")).toBe("success");
    expect(agentStatusTone("failed")).toBe("error");
    expect(agentStatusTone("cancelling")).toBe("warning");
    expect(agentStatusTone("cancelled")).toBe("neutral");
    expect(agentStatusTone("timed_out")).toBe("warning");
  });

  it("maps ToolCallStatus to StatusBadge tone（created/running 均为 running）", () => {
    expect(toolStatusTone("running")).toBe("running");
    expect(toolStatusTone("succeeded")).toBe("success");
    expect(toolStatusTone("failed")).toBe("error");
    expect(toolStatusTone("cancelled")).toBe("neutral");
    expect(toolStatusTone("timed_out")).toBe("warning");
  });

  it("keeps tone independent from labels and lifecycle predicates (tone 不参与业务判定)", () => {
    expect(agentStatusTone("timed_out")).toBe("warning");
    expect(agentStatusLabel("timed_out")).toBe("已超时");
    expect(isActiveRun({ id: "run-1", status: "cancelling", input: {} } as never)).toBe(true);
    expect(agentStatusTone("cancelling")).toBe("warning");
    expect(isActiveRun({ id: "run-2", status: "timed_out", input: {} } as never)).toBe(false);
    // failed 工具仍返回业务错误码，tone 仅影响视觉
    expect(toolStatusTone("failed")).toBe("error");
  });
});

describe("UX-03 agent run context & trace helpers", () => {
  it("maps the existing failure taxonomy to labels and tones", () => {
    expect(failureTypeLabel("TEST_ERROR")).toBe("测试失败");
    expect(failureTypeLabel("COMMAND_ERROR")).toBe("命令执行失败");
    expect(failureTypeLabel("TOOL_ERROR")).toBe("工具错误");
    expect(failureTypeLabel("TIMEOUT_ERROR")).toBe("执行超时");
    expect(failureTypeLabel("LLM_ERROR")).toBe("模型错误");
    // 未知类型回退原文，不吞信息
    expect(failureTypeLabel("SOME_NEW_ERROR")).toBe("SOME_NEW_ERROR");
    expect(failureTypeLabel()).toBe("未知错误");
    expect(failureTypeTone("TIMEOUT_ERROR")).toBe("warning");
    expect(failureTypeTone("TEST_ERROR")).toBe("error");
  });

  it("formats attempts, goals and recovery strategies", () => {
    expect(attemptLabel(0)).toBe("第 1 次尝试");
    expect(attemptLabel(2)).toBe("第 3 次尝试");
    expect(agentRunTask({ task: "fix tests" })).toBe("fix tests");
    expect(agentRunTask({})).toBe("编码任务");
    expect(recoveryStrategyLabel("REPLAN")).toBe("重规划");
    expect(recoveryStrategyLabel("debug")).toBe("创建诊断任务");
    expect(recoveryStrategyLabel(null)).toBe("未触发恢复");
    expect(recoveryStrategyLabel("CUSTOM")).toBe("CUSTOM");
    expect(recoveryStrategyText("REPLAN")).toBe("重规划（REPLAN）");
    expect(recoveryStrategyText(null)).toBe("未触发恢复");
    expect(recoveryStrategyText("CUSTOM")).toBe("CUSTOM");
    expect(recoveryBadgeText({ strategy: "REPLAN", recoveryTask: null })).toBe("重规划");
    expect(recoveryBadgeText({ strategy: null, recoveryTask: { id: "t" } })).toBe("已创建诊断任务");
    expect(recoveryBadgeText({ strategy: null, recoveryTask: null })).toBe("已恢复");
  });

  it("builds an ascending execution trace and skips duplicate tool_call events", () => {
    const trace = buildExecutionTrace({
      run: {
        id: "run-1",
        taskId: "task-1",
        status: "failed",
        input: {},
        currentIteration: 3,
        maxIterations: 50,
        retryCount: 1,
        createdAt: "2026-09-14T03:04:00.000Z",
        updatedAt: "2026-09-14T03:06:00.000Z"
      },
      toolCalls: [
        {
          id: "tool-row-1",
          agentRunId: "run-1",
          iteration: 1,
          toolCallId: "call-1",
          toolName: "read_file",
          input: { path: "src/app.ts" },
          output: { summary: "读取完成" },
          status: "succeeded",
          duration: 1250,
          startedAt: "2026-09-14T03:04:10.000Z",
          createdAt: "2026-09-14T03:04:10.000Z"
        }
      ],
      events: [
        {
          id: "evt-1",
          agentRunId: "run-1",
          eventType: "agent_run_started",
          payload: {},
          createdAt: "2026-09-14T03:04:05.000Z"
        },
        {
          id: "evt-2",
          agentRunId: "run-1",
          eventType: "tool_call_finished",
          payload: { toolName: "read_file", status: "succeeded" },
          createdAt: "2026-09-14T03:04:11.000Z"
        },
        {
          id: "evt-3",
          agentRunId: "run-1",
          eventType: "TASK_FAILED",
          taskId: "task-1",
          payload: { errorCode: "TEST_ERROR" },
          createdAt: "2026-09-14T03:05:00.000Z"
        },
        {
          id: "evt-4",
          agentRunId: "run-1",
          eventType: "agent_run_finished",
          payload: { status: "failed" },
          createdAt: "2026-09-14T03:06:00.000Z"
        }
      ],
      context: {
        projectName: "Mini Todo",
        workflow: { id: "wf-1", requirementName: "Todo", planningVersion: 1 },
        task: {
          id: "task-1",
          taskKey: "T-004",
          title: "Error handling",
          type: "BACKEND",
          status: "FAILED",
          origin: "RUNTIME",
          retryCount: 1
        },
        agentName: "backend-agent",
        agentType: "BACKEND",
        maxRetries: 2
      },
      recovery: null,
      artifacts: [],
      evidence: []
    } as never);

    // 时间升序（从开始看到结束）
    expect(trace.map((node) => node.id)).toEqual([
      "event-evt-1",
      "tool-tool-row-1",
      "event-evt-3",
      "event-evt-4"
    ]);
    expect(trace.map((node) => node.kind)).toEqual(["agent", "tool", "failure", "result"]);
    // tool_call_finished 不产生重复节点；工具节点带锚点与详情
    const tool = trace[1];
    expect(tool.label).toBe("工具调用 · read_file");
    expect(tool.summary).toBe("读取完成");
    expect(tool.anchorId).toBe("tool-call-1");
    expect(tool.details).toEqual(
      expect.arrayContaining([
        { label: "路径", value: "src/app.ts" },
        { label: "耗时", value: "1.3s" },
        { label: "迭代", value: "1" }
      ])
    );
    expect(trace.some((node) => node.label === "工具完成")).toBe(false);
  });

  it("derives the failure view from the run error and the failed tool", () => {
    const failure = agentRunFailureView({
      run: {
        id: "run-1",
        taskId: "task-1",
        status: "failed",
        input: {},
        currentIteration: 3,
        maxIterations: 50,
        retryCount: 1,
        error: { code: "TEST_ERROR", message: "Todo API integration test failed." },
        createdAt: "2026-09-14T03:04:00.000Z",
        updatedAt: "2026-09-14T03:06:00.000Z"
      },
      toolCalls: [
        {
          id: "tool-row-2",
          agentRunId: "run-1",
          iteration: 2,
          toolCallId: "call-2",
          toolName: "run_unit_test",
          input: {},
          status: "failed",
          error: { code: "TEST_ERROR", message: "Expected 201, received 500." },
          startedAt: "2026-09-14T03:05:00.000Z",
          createdAt: "2026-09-14T03:05:00.000Z"
        }
      ],
      events: [],
      context: {
        projectName: "Mini Todo",
        workflow: { id: "wf-1", requirementName: "Todo", planningVersion: 1 },
        task: {
          id: "task-1",
          taskKey: "T-004",
          title: "Error handling",
          type: "BACKEND",
          status: "FAILED",
          origin: "RUNTIME",
          retryCount: 1
        },
        agentName: "backend-agent",
        agentType: "BACKEND",
        maxRetries: 2
      },
      recovery: null,
      artifacts: [],
      evidence: []
    } as never);

    expect(failure).not.toBeNull();
    expect(failure!.typeCode).toBe("TEST_ERROR");
    expect(failure!.typeLabel).toBe("测试失败");
    expect(failure!.tone).toBe("error");
    expect(failure!.summary).toBe("工具 run_unit_test 执行失败：Expected 201, received 500.");
    expect(failure!.errorMessage).toBe("Todo API integration test failed.");
    expect(failure!.failedTool?.toolName).toBe("run_unit_test");
    expect(failure!.attempt).toBe("第 2 次尝试");
    expect(failure!.taskRetry).toBe("1 / 2");

    // 成功运行不产生失败上下文
    expect(
      agentRunFailureView({
        run: {
          id: "run-2",
          taskId: "task-1",
          status: "succeeded",
          input: {},
          currentIteration: 3,
          maxIterations: 50,
          retryCount: 0,
          createdAt: "2026-09-14T03:04:00.000Z",
          updatedAt: "2026-09-14T03:06:00.000Z"
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
      } as never)
    ).toBeNull();
  });

  it("explains a succeeded run whose task was failed (run/task 判定差异)", () => {
    const detail = (runStatus: string, taskStatus: string, summary?: string) =>
      ({
        run: { id: "run-1", status: runStatus },
        context: {
          projectName: null,
          workflow: null,
          task: {
            id: "task-1",
            taskKey: "T-004",
            title: "任务",
            type: "FRONTEND",
            status: taskStatus,
            origin: "RUNTIME",
            retryCount: 0,
            ...(summary === undefined ? {} : { summary })
          },
          agentName: null,
          agentType: null,
          maxRetries: null
        },
        toolCalls: [],
        events: [],
        recovery: null,
        artifacts: [],
        evidence: []
      }) as never;

    expect(taskOutcomeNote(detail("succeeded", "FAILED", "Failed to read git status"))).toBe(
      "本次运行成功，但任务 T-004 最终未通过：Failed to read git status"
    );
    expect(taskOutcomeNote(detail("succeeded", "FAILED"))).toBe(
      "本次运行成功，但任务 T-004 最终未通过"
    );
    // 判定一致时不解释：运行失败 / 任务成功 / 无任务
    expect(taskOutcomeNote(detail("failed", "FAILED"))).toBeNull();
    expect(taskOutcomeNote(detail("succeeded", "SUCCESS"))).toBeNull();
  });
});
