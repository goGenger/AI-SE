import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  BaseChatModelCallOptions,
  BindToolsInput
} from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import { Runnable } from "@langchain/core/runnables";
import { JsonObject } from "@ai-se/shared";
import { Sandbox } from "@ai-se/sandbox";
import { ToolDefinition, ToolExecutionError, ToolRuntime } from "@ai-se/tool-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentContext } from "../agent/AgentContext";
import { AgentRegistry } from "./AgentRegistry";
import {
  parseOutcome,
  ProfessionalAgent,
  type ProfessionalAgentOptions
} from "./ProfessionalAgent";
import { createSubmitResultTool, SUBMIT_RESULT_TOOL_NAME } from "./submitResult";
import { UNTRUSTED_INPUT_CLAUSE } from "./untrustedInput";

const outcome = {
  status: "SUCCESS",
  summary: "Planning complete for T-001",
  artifacts: [],
  issues: [],
  recommendations: [],
  metadata: { plannedLayout: ["apps/api", "apps/web"] }
};

describe("parseOutcome", () => {
  it("parses a bare JSON answer", () => {
    const parsed = parseOutcome(JSON.stringify(outcome));
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.summary).toBe(outcome.summary);
  });

  it("accepts extra top-level fields instead of rejecting the whole result", () => {
    const parsed = parseOutcome(
      JSON.stringify({ ...outcome, deliverable: "index.html", notes: ["a", "b"] })
    );
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.summary).toBe(outcome.summary);
  });

  it("normalizes lowercase enum values", () => {
    const parsed = parseOutcome('{"status":"success","summary":"x"}');
    expect(parsed.status).toBe("SUCCESS");
    const withIssue = parseOutcome(
      '{"status":"SUCCESS","summary":"x","issues":[{"severity":"high","description":"d","recommendation":"r"}]}'
    );
    expect(withIssue.issues[0]?.severity).toBe("HIGH");
  });

  it("recovers answers whose JSON strings contain raw newlines", () => {
    const answer = '{"status":"SUCCESS","summary":"line one\nline two\ttabbed"}';
    expect(() => JSON.parse(answer)).toThrow();
    const parsed = parseOutcome(answer);
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.summary).toBe("line one\nline two\ttabbed");
  });

  it("extracts JSON from a fenced code block", () => {
    const answer = `Here is my result:\n\n\`\`\`json\n${JSON.stringify(outcome)}\n\`\`\`\n`;
    expect(parseOutcome(answer).status).toBe("SUCCESS");
  });

  it("extracts JSON followed by trailing prose", () => {
    const answer = `${JSON.stringify(outcome)}\n\nLet me know if you need more detail.`;
    expect(parseOutcome(answer).status).toBe("SUCCESS");
  });

  it("extracts JSON preceded by prose", () => {
    const answer = `Work summary follows.\n${JSON.stringify(outcome)}`;
    expect(parseOutcome(answer).status).toBe("SUCCESS");
  });

  it("falls back with head/tail diagnostics when no valid outcome exists", () => {
    const truncated = '{"status":"SUCCESS","summary":"Planning complete for T-001 (Project setup';
    const parsed = parseOutcome(truncated);
    expect(parsed.status).toBe("FAILED");
    expect(parsed.issues[0]?.severity).toBe("HIGH");
    expect(parsed.metadata.errorType).toBe("INVALID_AGENT_RESULT");
    expect(parsed.metadata.answerLength).toBe(truncated.length);
    expect(parsed.metadata.answerTail).toBe(truncated);
  });

  it("still rejects structurally invalid outcomes", () => {
    const parsed = parseOutcome('{"status":"MAYBE","summary":"x"}');
    expect(parsed.status).toBe("FAILED");
    expect(parsed.metadata.errorType).toBe("INVALID_AGENT_RESULT");
  });

  it("repairs unescaped inner quotes in an HTML-heavy summary", () => {
    // 真实破损形态（2026-09-28 真实运行）：长 summary 内嵌 <canvas id="scene" width="960"> 时引号未转义。
    const answer =
      '{"status":"SUCCESS","summary":"deliverable /workspace/index.html with <canvas id="scene" width="960" height="540"> inside a centered .stage container","verification":{"staticStructure":"21/22 pass"}}';
    const parsed = parseOutcome(answer);
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.summary).toContain('width="960"');
    expect(parsed.metadata.errorType).toBeUndefined();
  });

  it("repairs invalid escape sequences coming from regex fragments", () => {
    const answer =
      '{"status":"SUCCESS","summary":"checked with /[\\s\\S]+/ and \\d+ patterns","artifacts":[],"issues":[],"recommendations":[],"metadata":{}}';
    const parsed = parseOutcome(answer);
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.summary).toContain("\\d+");
  });

  it("still reports INVALID for answers beyond repair (truncated)", () => {
    const truncated = '{"status":"SUCCESS","summary":"cut off with <canvas id="scene"';
    const parsed = parseOutcome(truncated);
    expect(parsed.status).toBe("FAILED");
    expect(parsed.metadata.errorType).toBe("INVALID_AGENT_RESULT");
    expect(parsed.metadata.answerText).toBe(truncated);
  });

  it("salvages status and summary from a fenced answer whose long string is broken", () => {
    // 真实形态（2026-09-28 12:26 真实运行，2739 字）：散文 + ```json 围栏块。
    // realHead / realTail 为 DB 中 answerHead / answerTail 的**逐字原文**；
    // 中间片段按同形态重建（原始引号 + `"loading", "empty"` 这类"引号后跟逗号"，恰在修复函数盲区）。
    const realHead =
      '{"status":"SUCCESS","summary":"T2 complete. The single self-contained deliverable /workspace/index.html (28,375 bytes, 875 lines) delivers the HTML skeleton ';
    const brokenMiddle =
      'with inline CSS and inline JavaScript: (1) <!DOCTYPE html> with well-formed <html>/<head>/<body>; (2) zero external references — no <link>, no src=; (3) an HTML5 Canvas drawing surface with explicit width="960" height="540"; (4) the states "loading", "empty" and "error" all render; (5) the animation ';
    const realTail =
      'engine; no uncaught runtime errors across all injected failure modes.","verification":{"staticStructure":"17/17 pass","runtimeStates":"24/24 pass","stateCoverage":["loading","empty","success(running)","paused","error"],"externalReferences":"none (<link>, <img>, <iframe>, src=, href=, http(s), @import, url(remote/data) all absent)","drawingSurface":"<canvas id=\\"scene\\" width=\\"960\\" height=\\"540\\"> inside centered .stage","fileCoverage":"single deliverable, no other files required to run"}}}';
    const answer = [
      "All acceptance criteria verified: 17/17 static structure checks and 24/24 runtime state checks (loading, empty, error, success) pass.",
      "",
      "```json",
      realHead + brokenMiddle + realTail,
      "```"
    ].join("\n");

    const parsed = parseOutcome(answer);
    expect(parsed.status).toBe("SUCCESS");
    // 抢救只读锚点之间的原文：真实头部与真实尾部都应完整保留。
    expect(parsed.summary).toContain("/workspace/index.html (28,375 bytes, 875 lines)");
    expect(parsed.summary).toContain(
      "engine; no uncaught runtime errors across all injected failure modes."
    );
    expect(parsed.metadata.parseRecovery).toBe("salvage");
  });

  it("does not salvage an outcome whose status is outside the enum", () => {
    const parsed = parseOutcome('{"status":"MAYBE","summary":"x","verification":{}}');
    expect(parsed.status).toBe("FAILED");
    expect(parsed.metadata.errorType).toBe("INVALID_AGENT_RESULT");
    expect(parsed.metadata.answerText).toContain("MAYBE");
  });
});

const REPAIR_MARKER = "Your previous reply was not the required result JSON";

/**
 * Minimal chat-model stand-in: answers by inspecting the prompt, so it works
 * regardless of how many model turns the harness performs per agent run.
 */
class ScriptedAnswerModel extends BaseChatModel<BaseChatModelCallOptions> {
  static lc_name(): string {
    return "ChatOpenAI";
  }

  readonly prompts: string[] = [];

  constructor(
    private readonly answer: (prompt: string, call: number) => string,
    private readonly steps: { toolName: string; input: JsonObject }[] = []
  ) {
    super({});
  }

  _llmType(): string {
    return "ai-se-scripted-answer";
  }

  bindTools(_tools: BindToolsInput[]): Runnable<unknown, AIMessageChunk, BaseChatModelCallOptions> {
    return this as unknown as Runnable<unknown, AIMessageChunk, BaseChatModelCallOptions>;
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    this.prompts.push(
      messages
        .map((message) =>
          typeof message.content === "string" ? message.content : JSON.stringify(message.content)
        )
        .join("\n")
    );
    const prompt = this.prompts[this.prompts.length - 1];
    const call = this.prompts.length - 1;
    const step = this.steps[call];
    const message = step
      ? new AIMessage({
          content: "",
          tool_calls: [
            { id: `call-${call}`, name: step.toolName, args: step.input, type: "tool_call" }
          ]
        })
      : new AIMessage({ content: this.answer(prompt, call) });
    return {
      generations: [{ text: typeof message.content === "string" ? message.content : "", message }]
    };
  }
}

/**
 * PL-C2（`docs/162` §2）：给每次调用挂确定性的 `usage_metadata`，
 * 用来断言「价目 → 成本 → `AgentResult.estimatedCost`」这条链在 agent 层真的通了。
 */
class UsageScriptedAnswerModel extends ScriptedAnswerModel {
  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const result = await super._generate(messages, options, runManager);
    return {
      generations: result.generations.map((generation) => ({
        ...generation,
        message: new AIMessage({
          content: generation.message.content,
          usage_metadata: {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            total_tokens: 2_000_000
          }
        })
      }))
    };
  }
}

function testContext(): AgentContext {
  return {
    requestId: "req-repair",
    projectId: "project-repair",
    taskId: "task-repair",
    agentRunId: "run-repair",
    actor: "vitest",
    workspacePath: process.cwd(),
    sandbox: {
      runCommand: async () => {
        throw new Error("sandbox is not used in these tests");
      }
    } as unknown as Sandbox
  };
}

function buildAgent(
  model: ScriptedAnswerModel,
  tools: ToolDefinition<unknown, unknown>[] = [],
  options: Partial<ProfessionalAgentOptions> = {}
) {
  return new ProfessionalAgent({
    definition: new AgentRegistry().get("planner-agent"),
    model,
    toolRuntime: new ToolRuntime({ tools }),
    defaultTimeoutMs: 30_000,
    ...options
  });
}

describe("ProfessionalAgent repair turn", () => {
  it("re-runs once when the answer is prose, then records the JSON outcome", async () => {
    const model = new ScriptedAnswerModel((prompt) =>
      prompt.includes(REPAIR_MARKER) ? JSON.stringify(outcome) : "Findings in prose, without JSON."
    );
    const result = await buildAgent(model).run("Plan T-001", testContext(), {
      maxIterations: 3,
      timeoutMs: 30_000
    });

    expect(result.professionalResult?.status).toBe("SUCCESS");
    expect(result.professionalResult?.summary).toBe(outcome.summary);
    expect(model.prompts.filter((prompt) => prompt.includes(REPAIR_MARKER))).toHaveLength(1);
  });

  it("keeps the diagnostic fallback when the repair attempt fails too", async () => {
    const model = new ScriptedAnswerModel(() => "Still answering in prose only.");
    const result = await buildAgent(model).run("Plan T-002", testContext(), {
      maxIterations: 3,
      timeoutMs: 30_000
    });

    expect(result.professionalResult?.status).toBe("FAILED");
    expect(result.professionalResult?.metadata.errorType).toBe("INVALID_AGENT_RESULT");
    expect(model.prompts.filter((prompt) => prompt.includes(REPAIR_MARKER))).toHaveLength(1);
  });
});

/** 每次调用都延迟后返回空回复:用于制造"运行超时"。 */
class SlowEmptyModel extends ScriptedAnswerModel {
  constructor(private readonly delayMs: number) {
    super(() => "");
  }

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return await super._generate(messages, options, runManager);
  }
}

/**
 * N-24（`docs/204`）：**模型调用本身抛错**。`AgentGraph.ts:302` 于是以 `status: "failed"` +
 * `error.code = "LLM_ERROR"` 结束运行，`finalAnswer` 因此为空。
 *
 * 此前这段被记成 `EMPTY_FINAL_ANSWER`（「agent 连续空回复」）——实测 L1-M4o run 1 的 5 个实例
 * 全部如此，其中一个 run **只跑了 1 秒**，那个读数本身就证伪了那条归因。
 */
class ThrowingModel extends ScriptedAnswerModel {
  constructor() {
    super(() => "");
  }

  override async _generate(): Promise<ChatResult> {
    throw new Error("429 Upstream request failed: Endpoint is unavailable.");
  }
}

describe("ProfessionalAgent timeout / empty-final outcomes", () => {
  it("reports a timeout as the failure reason and skips the repair turn", async () => {
    const model = new SlowEmptyModel(150);
    const result = await buildAgent(model).run("Plan T-006", testContext(), {
      maxIterations: 3,
      timeoutMs: 40
    });

    expect(result.status).toBe("timed_out");
    expect(result.professionalResult?.status).toBe("FAILED");
    expect(result.professionalResult?.metadata.errorType).toBe("TIMEOUT");
    expect(result.professionalResult?.summary).toContain("超时");
    // 不再对着空答案启动"修复轮"(否则模型会把整个任务重做一遍)。
    expect(model.prompts.filter((prompt) => prompt.includes(REPAIR_MARKER))).toHaveLength(0);
  });

  it("reports the exhausted empty-reply case without a repair turn", async () => {
    const model = new ScriptedAnswerModel(() => "");
    const result = await buildAgent(model).run("Plan T-007", testContext(), {
      maxIterations: 5,
      timeoutMs: 5_000
    });

    expect(result.professionalResult?.status).toBe("FAILED");
    expect(result.professionalResult?.metadata.errorType).toBe("EMPTY_FINAL_ANSWER");
    expect(result.professionalResult?.summary).toContain("未返回结果");
    expect(model.prompts.filter((prompt) => prompt.includes(REPAIR_MARKER))).toHaveLength(0);
  });

  it("N-24：运行本身失败（模型调用抛错）⇒ 记 LLM_ERROR，而不是 EMPTY_FINAL_ANSWER（27a）", async () => {
    const model = new ThrowingModel();
    const result = await buildAgent(model).run("Plan T-008", testContext(), {
      maxIterations: 5,
      timeoutMs: 5_000
    });

    expect(result.status).toBe("failed");
    expect(result.professionalResult?.status).toBe("FAILED");
    expect(result.professionalResult?.metadata.errorType).toBe("LLM_ERROR");
    // 不回显上游原文（外部文本，本包无 sanitize 通道）。
    expect(result.professionalResult?.summary).not.toContain("429");
    // 不启动修复轮：对着一个失败的运行重问没有意义。
    expect(model.prompts.filter((prompt) => prompt.includes(REPAIR_MARKER))).toHaveLength(0);
  });

  it("N-24 负控（27b）：真正的空答案（run 无错误码）仍记 EMPTY_FINAL_ANSWER", async () => {
    const model = new ScriptedAnswerModel(() => "");
    const result = await buildAgent(model).run("Plan T-009", testContext(), {
      maxIterations: 5,
      timeoutMs: 5_000
    });

    expect(result.professionalResult?.metadata.errorType).toBe("EMPTY_FINAL_ANSWER");
    expect(result.professionalResult?.summary).toContain("未返回结果");
  });
});

const failingReadFileTool: ToolDefinition<unknown, unknown> = {
  name: "read_file",
  description: "Always fails (test double for the failed-tool policy).",
  riskLevel: "LOW",
  inputSchema: z.object({ file_path: z.string().optional() }),
  execute: async () => {
    throw new ToolExecutionError("COMMAND_ERROR", "Test double: read_file failed");
  }
};

const TOOL_STEP = [{ toolName: "read_file", input: { file_path: "missing.txt" } }];

describe("ProfessionalAgent failed-tool policy", () => {
  it("keeps a parsed SUCCESS outcome when a tool call failed, recording it as a MEDIUM issue", async () => {
    const model = new ScriptedAnswerModel(() => JSON.stringify(outcome), TOOL_STEP);
    const result = await buildAgent(model, [failingReadFileTool]).run("Plan T-003", testContext(), {
      maxIterations: 5,
      timeoutMs: 30_000
    });

    // 工具失败不再推翻自报结果：任务不因一次可恢复的工具失败被判失败。
    expect(result.professionalResult?.status).toBe("SUCCESS");
    expect(result.professionalResult?.summary).toBe(outcome.summary);
    expect(result.professionalResult?.metadata.failedTools).toEqual(["read_file"]);
    expect(result.professionalResult?.metadata.toolErrorCode).toBe("COMMAND_ERROR");
    // 失败如实保留：issues 追加 MEDIUM 记录 + 轨迹里仍有失败调用。
    expect(
      result.professionalResult?.issues.some(
        (issue) => issue.severity === "MEDIUM" && issue.description.includes("read_file 调用失败")
      )
    ).toBe(true);
    expect(result.toolResults.some((toolResult) => !toolResult.success)).toBe(true);
  });

  it("still runs the repair turn after a tool failure and can recover the verdict", async () => {
    const model = new ScriptedAnswerModel(
      (prompt) => (prompt.includes(REPAIR_MARKER) ? JSON.stringify(outcome) : "Prose answer only."),
      TOOL_STEP
    );
    const result = await buildAgent(model, [failingReadFileTool]).run("Plan T-004", testContext(), {
      maxIterations: 6,
      timeoutMs: 30_000
    });

    expect(model.prompts.filter((prompt) => prompt.includes(REPAIR_MARKER))).toHaveLength(1);
    expect(result.professionalResult?.status).toBe("SUCCESS");
    expect(result.professionalResult?.metadata.failedTools).toEqual(["read_file"]);
  });

  it("keeps the INVALID_AGENT_RESULT diagnostic summary instead of the tool error", async () => {
    const model = new ScriptedAnswerModel(() => "Still answering in prose only.", TOOL_STEP);
    const result = await buildAgent(model, [failingReadFileTool]).run("Plan T-005", testContext(), {
      maxIterations: 5,
      timeoutMs: 30_000
    });

    expect(result.professionalResult?.status).toBe("FAILED");
    expect(result.professionalResult?.metadata.errorType).toBe("INVALID_AGENT_RESULT");
    // 判定原因必须可见：摘要保留"结果无法解析"，而不是被工具错误覆盖。
    expect(result.professionalResult?.summary).toContain("invalid structured result");
    expect(result.professionalResult?.summary).not.toBe("Test double: read_file failed");
    expect(result.professionalResult?.metadata.failedTools).toEqual(["read_file"]);
  });
});

describe("ProfessionalAgent outcome tool (T2)", () => {
  it("captures the outcome from an accepted submit_result call", async () => {
    const model = new ScriptedAnswerModel(
      () => "unused",
      [{ toolName: SUBMIT_RESULT_TOOL_NAME, input: outcome }]
    );
    const result = await buildAgent(model, [createSubmitResultTool()], {
      outcomeTool: SUBMIT_RESULT_TOOL_NAME
    }).run("Plan T-101", testContext(), { maxIterations: 5, timeoutMs: 30_000 });

    expect(result.professionalResult?.status).toBe("SUCCESS");
    expect(result.professionalResult?.summary).toBe(outcome.summary);
    expect(result.professionalResult?.metadata.outcomeMode).toBe("tool");
    expect(
      result.toolResults.some(
        (toolResult) => toolResult.toolName === SUBMIT_RESULT_TOOL_NAME && toolResult.success
      )
    ).toBe(true);
  });

  it("falls back to text parsing when the submission keeps failing validation", async () => {
    const model = new ScriptedAnswerModel(
      () => JSON.stringify(outcome),
      [{ toolName: SUBMIT_RESULT_TOOL_NAME, input: { status: "MAYBE" } }]
    );
    const result = await buildAgent(model, [createSubmitResultTool()], {
      outcomeTool: SUBMIT_RESULT_TOOL_NAME
    }).run("Plan T-102", testContext(), { maxIterations: 5, timeoutMs: 30_000 });

    expect(result.professionalResult?.status).toBe("SUCCESS");
    expect(result.professionalResult?.summary).toBe(outcome.summary);
    expect(result.professionalResult?.metadata.outcomeMode).toBe("text-fallback");
    // 无效参数在框架层即被拒（错误回传模型、计入迭代），不会进入 ToolRuntime 记录；
    // 模型下一轮给出文本结果 → 走降级解析。
    expect(model.prompts).toHaveLength(2);
    expect(
      result.toolResults.some((toolResult) => toolResult.toolName === SUBMIT_RESULT_TOOL_NAME)
    ).toBe(false);
    // 控制流的校验失败不进入交付失败清单。
    expect(result.professionalResult?.metadata.failedTools ?? []).not.toContain(
      SUBMIT_RESULT_TOOL_NAME
    );
  });

  it("records outcomeMode=text when tool mode is off", async () => {
    const model = new ScriptedAnswerModel(() => JSON.stringify(outcome));
    const result = await buildAgent(model).run("Plan T-103", testContext(), {
      maxIterations: 3,
      timeoutMs: 30_000
    });
    expect(result.professionalResult?.metadata.outcomeMode).toBe("text");
  });

  it("composes the untrusted-input clause into the agent system prompt", async () => {
    const model = new ScriptedAnswerModel(() => JSON.stringify(outcome));
    await buildAgent(model).run("Plan T-104", testContext(), {
      maxIterations: 3,
      timeoutMs: 30_000
    });
    expect(model.prompts[0]).toContain(UNTRUSTED_INPUT_CLAUSE);
  });
});

describe("ProfessionalAgent cost reporting (PL-C2)", () => {
  it("reports estimatedCost when pricing is configured", async () => {
    const model = new UsageScriptedAnswerModel(() => JSON.stringify(outcome));

    const result = await buildAgent(model, [], {
      modelPricing: { inputPerMTok: 3, outputPerMTok: 15 }
    }).run("Plan T-201", testContext(), { maxIterations: 3, timeoutMs: 30_000 });

    // 1M 输入 × $3 + 1M 输出 × $15 = $18
    expect(result.estimatedCost).toBe(18);
    expect(result.tokenUsage).toMatchObject({ input_tokens: 1_000_000 });
  });

  it("omits estimatedCost when no pricing is configured", async () => {
    const model = new UsageScriptedAnswerModel(() => JSON.stringify(outcome));

    const result = await buildAgent(model).run("Plan T-202", testContext(), {
      maxIterations: 3,
      timeoutMs: 30_000
    });

    // 未配置价目 → 不产出成本（落库为 NULL），但用量照记。
    expect(result.estimatedCost).toBeUndefined();
    expect(result.tokenUsage).toMatchObject({ input_tokens: 1_000_000 });
  });
});
