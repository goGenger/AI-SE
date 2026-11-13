import { ToolMessage } from "@langchain/core/messages";
import { ToolExecutionContext, ToolRuntime } from "@ai-se/tool-runtime";
import { describe, expect, it } from "vitest";
import { PROFESSIONAL_AGENT_DEFINITIONS } from "./AgentRegistry";
import {
  captureSubmittedOutcome,
  createSubmitResultTerminationMiddleware,
  createSubmitResultTool,
  SUBMIT_RESULT_TOOL_NAME
} from "./submitResult";

const outcome = {
  status: "SUCCESS" as const,
  summary: "submit_result test outcome",
  artifacts: [],
  issues: [],
  recommendations: [],
  metadata: { source: "vitest" }
};

function context(): ToolExecutionContext {
  return {
    requestId: "request",
    projectId: "project",
    taskId: "task",
    agentRunId: "run",
    toolCallId: "call",
    actor: "vitest",
    workspacePath: process.cwd(),
    sandbox: {
      runCommand: async () => {
        throw new Error("submit_result must not execute commands");
      }
    } as unknown as ToolExecutionContext["sandbox"]
  };
}

describe("submit_result tool (T2)", () => {
  it("validates arguments through ToolRuntime and returns the validated outcome as data", async () => {
    const runtime = new ToolRuntime({ tools: [createSubmitResultTool()] });
    const accepted = await runtime.execute(SUBMIT_RESULT_TOOL_NAME, outcome, context());
    expect(accepted.success).toBe(true);
    expect(accepted.data).toMatchObject({ status: "SUCCESS", summary: outcome.summary });

    const rejected = await runtime.execute(SUBMIT_RESULT_TOOL_NAME, { status: "MAYBE" }, context());
    expect(rejected.success).toBe(false);
    expect(rejected.error?.code).toBe("TOOL_ERROR");
    expect(JSON.stringify(rejected.error?.details)).toContain("status");
  });

  it("captureSubmittedOutcome returns the last accepted submission only", async () => {
    const runtime = new ToolRuntime({ tools: [createSubmitResultTool()] });
    const failed = await runtime.execute(SUBMIT_RESULT_TOOL_NAME, { status: "MAYBE" }, context());
    const first = await runtime.execute(
      SUBMIT_RESULT_TOOL_NAME,
      { ...outcome, summary: "first" },
      context()
    );
    const second = await runtime.execute(
      SUBMIT_RESULT_TOOL_NAME,
      { ...outcome, summary: "second" },
      context()
    );
    expect(captureSubmittedOutcome([failed, first, second], SUBMIT_RESULT_TOOL_NAME)?.summary).toBe(
      "second"
    );
    expect(captureSubmittedOutcome([failed], SUBMIT_RESULT_TOOL_NAME)).toBeUndefined();
    expect(captureSubmittedOutcome([first], undefined)).toBeUndefined();
  });

  it("termination middleware jumps to end after an accepted submission", async () => {
    const middleware = createSubmitResultTerminationMiddleware(SUBMIT_RESULT_TOOL_NAME);
    const beforeModel = middleware.beforeModel as {
      hook: (state: unknown) => Promise<{ jumpTo: string } | undefined>;
    };
    const accepted = new ToolMessage({
      content: JSON.stringify({ success: true, toolName: SUBMIT_RESULT_TOOL_NAME }),
      tool_call_id: "call-1"
    });
    await expect(beforeModel.hook({ messages: [accepted] })).resolves.toEqual({ jumpTo: "end" });

    const failed = new ToolMessage({
      content: JSON.stringify({ success: false, toolName: SUBMIT_RESULT_TOOL_NAME }),
      tool_call_id: "call-2"
    });
    await expect(beforeModel.hook({ messages: [failed] })).resolves.toBeUndefined();
    await expect(beforeModel.hook({ messages: [] })).resolves.toBeUndefined();

    const otherTool = new ToolMessage({
      content: JSON.stringify({ success: true, toolName: "read_file" }),
      tool_call_id: "call-3"
    });
    await expect(beforeModel.hook({ messages: [otherTool] })).resolves.toBeUndefined();
  });

  it("N-22：根上的 fixTaskType 被接受（不再只能藏在 metadata 里）", async () => {
    const runtime = new ToolRuntime({ tools: [createSubmitResultTool()] });
    const accepted = await runtime.execute(
      SUBMIT_RESULT_TOOL_NAME,
      { ...outcome, status: "REPLAN", fixTaskType: "TEST" },
      context()
    );
    expect(accepted.success).toBe(true);
    expect(captureSubmittedOutcome([accepted], SUBMIT_RESULT_TOOL_NAME)?.fixTaskType).toBe("TEST");
  });

  it("N-22：不给 fixTaskType 仍然合法（判据 25g 的负控——缺省时第 3 步兜底不变）", async () => {
    const runtime = new ToolRuntime({ tools: [createSubmitResultTool()] });
    const accepted = await runtime.execute(
      SUBMIT_RESULT_TOOL_NAME,
      { ...outcome, status: "REPLAN" },
      context()
    );
    expect(accepted.success).toBe(true);
    expect(captureSubmittedOutcome([accepted], SUBMIT_RESULT_TOOL_NAME)?.fixTaskType).toBeUndefined();
  });

  it("N-22：metadata.fixTaskType 仍被容忍（历史任务与未更新提示词的 agent）", async () => {
    const runtime = new ToolRuntime({ tools: [createSubmitResultTool()] });
    const accepted = await runtime.execute(
      SUBMIT_RESULT_TOOL_NAME,
      { ...outcome, status: "REPLAN", metadata: { fixTaskType: "BACKEND" } },
      context()
    );
    expect(accepted.success).toBe(true);
    expect(captureSubmittedOutcome([accepted], SUBMIT_RESULT_TOOL_NAME)?.metadata.fixTaskType).toBe(
      "BACKEND"
    );
  });

  it("exposes submit_result to every professional agent definition", () => {
    for (const definition of PROFESSIONAL_AGENT_DEFINITIONS) {
      expect(definition.tools).toContain(SUBMIT_RESULT_TOOL_NAME);
      expect(definition.permissions.tools).toContain(SUBMIT_RESULT_TOOL_NAME);
    }
  });
});
