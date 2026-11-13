import { AIMessage, HumanMessage, BaseMessage } from "@langchain/core/messages";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { ChatResult } from "@langchain/core/outputs";
import { ToolRuntime, createPhase1Tools } from "@ai-se/tool-runtime";
import { describe, expect, it } from "vitest";
import { AgentRegistry } from "./AgentRegistry";
import { DeepAgentLLMProvider } from "./DeepAgentLLMProvider";
import { ScriptedDeepAgentModel } from "./ScriptedDeepAgentModel";
import { createSubmitResultTool, SUBMIT_RESULT_TOOL_NAME } from "./submitResult";
import { ToolRuntimeBackend } from "./ToolRuntimeBackend";
import { UNTRUSTED_INPUT_CLAUSE } from "./untrustedInput";

/** D-2：捕获每次模型调用看到的全部消息文本（用于断言 systemPrompt 组合结果）。 */
class CapturingDeepAgentModel extends ScriptedDeepAgentModel {
  readonly captured: string[] = [];

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    this.captured.push(
      messages
        .map((message) =>
          typeof message.content === "string" ? message.content : JSON.stringify(message.content)
        )
        .join("\n")
    );
    return await super._generate(messages, options, runManager);
  }
}

/**
 * PL-C2（`docs/162` §2）：给内层每一次模型调用挂上确定性的 `usage_metadata`，
 * 用来断言 provider 交回的是**整轮求和**而不是最后一次调用。
 */
class UsageReportingDeepAgentModel extends ScriptedDeepAgentModel {
  private calls = 0;
  private readonly reported: { input_tokens: number; output_tokens: number; total_tokens: number }[] =
    [];

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const result = await super._generate(messages, options, runManager);
    this.calls += 1;
    const usage = {
      input_tokens: 100 * this.calls,
      output_tokens: 10 * this.calls,
      total_tokens: 110 * this.calls
    };
    this.reported.push(usage);
    return {
      ...result,
      generations: result.generations.map((generation) => ({
        ...generation,
        message: new AIMessage({
          content: generation.message.content,
          tool_calls: AIMessage.isInstance(generation.message)
            ? generation.message.tool_calls
            : undefined,
          usage_metadata: usage
        })
      }))
    };
  }

  get callCount(): number {
    return this.calls;
  }

  get lastCallUsage(): { input_tokens: number; output_tokens: number; total_tokens: number } {
    return this.reported[this.reported.length - 1]!;
  }

  get summedUsage(): { input_tokens: number; output_tokens: number; total_tokens: number } {
    return this.reported.reduce(
      (sum, entry) => ({
        input_tokens: sum.input_tokens + entry.input_tokens,
        output_tokens: sum.output_tokens + entry.output_tokens,
        total_tokens: sum.total_tokens + entry.total_tokens
      }),
      { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
    );
  }
}

const REASONING_SENTINEL = "PROBE_REASONING_SENTINEL";

/**
 * N-9（`docs/179`）：生产的 `ChatOpenAI` 把工具调用放在 `additional_kwargs.tool_calls` 里
 * （探针实测：每轮 `additionalKwargKeys = function_call,tool_calls`），`AIMessage` 由它派生出
 * `tool_calls`。这个模型复现该形状，好让「重建消息时把已执行的工具调用又交回外层」这件事
 * 在单测里可复现。
 */
class AdditionalKwargsToolCallModel extends ScriptedDeepAgentModel {
  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const result = await super._generate(messages, options, runManager);
    return {
      ...result,
      generations: result.generations.map((generation) => {
        const message = generation.message;
        const calls = AIMessage.isInstance(message) ? (message.tool_calls ?? []) : [];
        if (calls.length === 0) return generation;
        return {
          ...generation,
          message: new AIMessage({
            content: message.content,
            additional_kwargs: {
              tool_calls: calls.map((call, index) => ({
                id: call.id ?? `call-${index}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) }
              }))
            }
          })
        };
      })
    };
  }
}

/**
 * N-6（`docs/172`）：让内层返回的每条 AIMessage 都带上 `additional_kwargs.reasoning_content`。
 * 网关在 thinking 模式下要求 assistant 消息回传该字段，而依赖补丁（`@langchain/openai`
 * 的 `completions.js`）只在消息自身携带它时才发——所以 provider 重建消息时必须保留它。
 */
class ReasoningReportingDeepAgentModel extends ScriptedDeepAgentModel {
  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const result = await super._generate(messages, options, runManager);
    return {
      ...result,
      generations: result.generations.map((generation) => ({
        ...generation,
        message: new AIMessage({
          content: generation.message.content,
          additional_kwargs: { reasoning_content: REASONING_SENTINEL }
        })
      }))
    };
  }
}

describe("DeepAgentLLMProvider", () => {
  it("executes scripted Deep Agent tool calls through ToolRuntime", async () => {
    const direct = await new ScriptedDeepAgentModel({
      steps: [{ toolName: "edit_file", input: { path: "server/index.ts" } }]
    }).invoke("test");
    expect(direct.tool_calls?.[0]?.name).toBe("edit_file");
    let command = "";
    const definition = new AgentRegistry().get("backend-agent");
    const backend = new ToolRuntimeBackend({
      runtime: new ToolRuntime({ tools: createPhase1Tools() }),
      permissions: definition.permissions,
      context: {
        requestId: "request",
        taskId: "task",
        agentRunId: "run",
        actor: definition.name,
        workspacePath: process.cwd(),
        sandbox: {
          async runCommand(_workspacePath, input) {
            command = input.command;
            return {
              command: input.command,
              exitCode: 0,
              stdout: "1",
              stderr: "",
              duration: 1,
              timedOut: false
            };
          }
        }
      }
    });
    const provider = new DeepAgentLLMProvider(
      new ScriptedDeepAgentModel({
        steps: [
          {
            toolName: "edit_file",
            input: {
              file_path: "server/index.ts",
              old_string: "before",
              new_string: "after",
              replace_all: false
            }
          }
        ]
      }),
      definition,
      backend
    );

    const result = await provider.invoke([new HumanMessage("edit")]);

    expect(command).toContain("server/index.ts");
    expect(backend.toolResults).toHaveLength(1);
    expect(result.content).toContain('"status":"SUCCESS"');
  });

  it("ends the loop after an accepted submit_result and returns the submitted summary", async () => {
    const submitted = {
      status: "SUCCESS",
      summary: "outcome submitted through the tool",
      artifacts: [],
      issues: [],
      recommendations: [],
      metadata: {}
    };
    const definition = new AgentRegistry().get("backend-agent");
    const backend = new ToolRuntimeBackend({
      runtime: new ToolRuntime({ tools: [...createPhase1Tools(), createSubmitResultTool()] }),
      permissions: definition.permissions,
      context: {
        requestId: "request",
        taskId: "task",
        agentRunId: "run",
        actor: definition.name,
        workspacePath: process.cwd(),
        sandbox: {
          async runCommand() {
            throw new Error("no commands expected");
          }
        }
      }
    });
    const provider = new DeepAgentLLMProvider(
      new ScriptedDeepAgentModel({
        steps: [{ toolName: SUBMIT_RESULT_TOOL_NAME, input: submitted }]
      }),
      definition,
      backend,
      SUBMIT_RESULT_TOOL_NAME
    );

    const result = await provider.invoke([new HumanMessage("work")]);

    // 中间件在提交被接受后跳转结束：模型没有被再叫一次（否则 content 会是脚本文本），
    // 且最终回答回填为提交摘要。
    expect(result.content).toBe("outcome submitted through the tool");
    expect(backend.toolResults).toHaveLength(1);
    expect(backend.toolResults[0]?.success).toBe(true);
  });

  it("does not hand the outer loop a tool call the inner agent already ran (N-9)", async () => {
    // 提交被接受后外层已无事可做。若重建的消息仍带 `tool_calls`，`AgentGraph.shouldContinue`
    // 会回到 tools 节点反复执行同一个 submit_result；而内层每轮都被终止中间件直接 `jumpTo end`
    // （零模型调用），于是空转到 `maxIterations` 守卫——L1-M4g run 1 实测 44 轮 / 1.2 秒 / 零调用。
    const submitted = {
      status: "SUCCESS",
      summary: "outcome submitted through the tool",
      artifacts: [],
      issues: [],
      recommendations: [],
      metadata: {}
    };
    const definition = new AgentRegistry().get("backend-agent");
    const backend = new ToolRuntimeBackend({
      runtime: new ToolRuntime({ tools: [...createPhase1Tools(), createSubmitResultTool()] }),
      permissions: definition.permissions,
      context: {
        requestId: "request",
        taskId: "task",
        agentRunId: "run",
        actor: definition.name,
        workspacePath: process.cwd(),
        sandbox: {
          async runCommand() {
            throw new Error("no commands expected");
          }
        }
      }
    });
    const provider = new DeepAgentLLMProvider(
      new AdditionalKwargsToolCallModel({
        steps: [{ toolName: SUBMIT_RESULT_TOOL_NAME, input: submitted }]
      }),
      definition,
      backend,
      SUBMIT_RESULT_TOOL_NAME
    );

    const response = await provider.invoke([new HumanMessage("work")]);

    // 内层确实执行并接受了这次提交（否则本用例证明不了「已经跑过」这件事）。
    expect(backend.toolResults).toHaveLength(1);
    expect(backend.toolResults[0]?.toolName).toBe(SUBMIT_RESULT_TOOL_NAME);
    expect(response.content).toBe("outcome submitted through the tool");
    // 交回外层的消息**不得**再带工具调用。
    expect(response.tool_calls ?? []).toHaveLength(0);
  });

  it("composes the untrusted-input clause into the deep-agent system prompt", async () => {
    const model = new CapturingDeepAgentModel();
    const definition = new AgentRegistry().get("backend-agent");
    const backend = new ToolRuntimeBackend({
      runtime: new ToolRuntime({ tools: createPhase1Tools() }),
      permissions: definition.permissions,
      context: {
        requestId: "request",
        taskId: "task",
        agentRunId: "run",
        actor: definition.name,
        workspacePath: process.cwd(),
        sandbox: {
          async runCommand(_workspacePath, input) {
            return {
              command: input.command,
              exitCode: 0,
              stdout: "",
              stderr: "",
              duration: 1,
              timedOut: false
            };
          }
        }
      }
    });
    const provider = new DeepAgentLLMProvider(model, definition, backend);

    await provider.invoke([new HumanMessage("read the project notes")]);

    expect(model.captured.length).toBeGreaterThan(0);
    expect(model.captured[0]).toContain(UNTRUSTED_INPUT_CLAUSE);
  });

  it("returns the summed usage of every inner LLM call, not just the last one (PL-C2)", async () => {
    const model = new UsageReportingDeepAgentModel({
      steps: [
        {
          toolName: "edit_file",
          input: {
            file_path: "server/a.ts",
            old_string: "before",
            new_string: "after",
            replace_all: false
          }
        },
        {
          toolName: "edit_file",
          input: {
            file_path: "server/b.ts",
            old_string: "before",
            new_string: "after",
            replace_all: false
          }
        }
      ]
    });
    const definition = new AgentRegistry().get("backend-agent");
    const backend = new ToolRuntimeBackend({
      runtime: new ToolRuntime({ tools: createPhase1Tools() }),
      permissions: definition.permissions,
      context: {
        requestId: "request",
        taskId: "task",
        agentRunId: "run",
        actor: definition.name,
        workspacePath: process.cwd(),
        sandbox: {
          async runCommand(_workspacePath, input) {
            return {
              command: input.command,
              exitCode: 0,
              stdout: "1",
              stderr: "",
              duration: 1,
              timedOut: false
            };
          }
        }
      }
    });
    const provider = new DeepAgentLLMProvider(model, definition, backend);

    const response = await provider.invoke([new HumanMessage("work")]);

    // 内层确实跑了多轮——否则本用例证明不了「求和」这件事。
    expect(model.callCount).toBeGreaterThan(1);
    expect(response.usage_metadata).toEqual(model.summedUsage);
    // 修复前交回的是最后一次调用的用量；这里明确断言它与求和**不同**。
    expect(response.usage_metadata).not.toEqual(model.lastCallUsage);
  });

  it("does not re-count usage carried by the messages the caller passed back in (N-8)", async () => {
    // 外层图每轮把 provider 上一轮交回的 AIMessage 回灌进来（`AgentGraph.agentNode` 的
    // `messages: [response]`），而内层 deep agent 的 `result.messages` 会按**同引用**把它带回。
    // 不剔除就是复利：实测 T(n) = sum_{k<n} T(k) + 本轮用量，每轮翻倍，49 轮即 5.6e17。
    const model = new UsageReportingDeepAgentModel();
    const definition = new AgentRegistry().get("backend-agent");
    const backend = new ToolRuntimeBackend({
      runtime: new ToolRuntime({ tools: createPhase1Tools() }),
      permissions: definition.permissions,
      context: {
        requestId: "request",
        taskId: "task",
        agentRunId: "run",
        actor: definition.name,
        workspacePath: process.cwd(),
        sandbox: {
          async runCommand() {
            throw new Error("no commands expected");
          }
        }
      }
    });
    const provider = new DeepAgentLLMProvider(model, definition, backend);

    const plain = await provider.invoke([new HumanMessage("work")]);
    const carried = new AIMessage({
      content: "previous round",
      usage_metadata: { input_tokens: 1_000_000, output_tokens: 1, total_tokens: 1_000_001 }
    });
    const fed = await provider.invoke([new HumanMessage("work"), carried]);

    // 第二次 invoke 脚本已耗尽 ⇒ 只跑一次模型调用 ⇒ 自产用量就是那一次。
    expect(fed.usage_metadata).toEqual(model.lastCallUsage);
    // 修复前是「回灌的累计值 + 自产」的复利形态（实测 1,000,000 + 200）。
    expect(fed.usage_metadata?.input_tokens).toBeLessThan(1_000_000);
    expect(plain.usage_metadata?.input_tokens).toBeLessThan(1_000_000);
  });

  it("leaves estimatedCost off the response when no pricing is configured (PL-C2)", async () => {
    const model = new UsageReportingDeepAgentModel();
    const definition = new AgentRegistry().get("backend-agent");
    const backend = new ToolRuntimeBackend({
      runtime: new ToolRuntime({ tools: createPhase1Tools() }),
      permissions: definition.permissions,
      context: {
        requestId: "request",
        taskId: "task",
        agentRunId: "run",
        actor: definition.name,
        workspacePath: process.cwd(),
        sandbox: {
          async runCommand() {
            throw new Error("no commands expected");
          }
        }
      }
    });
    const provider = new DeepAgentLLMProvider(model, definition, backend);

    const response = await provider.invoke([new HumanMessage("work")]);

    // 未配置价目 → 不写该键 → 上游 `agent_runs.estimated_cost` 维持 NULL（不编造数字）。
    expect(response.response_metadata?.estimatedCostUsd).toBeUndefined();
  });

  it("preserves additional_kwargs so reasoning_content survives the rebuild (N-6)", async () => {
    const definition = new AgentRegistry().get("backend-agent");
    const backend = new ToolRuntimeBackend({
      runtime: new ToolRuntime({ tools: createPhase1Tools() }),
      permissions: definition.permissions,
      context: {
        requestId: "request",
        taskId: "task",
        agentRunId: "run",
        actor: definition.name,
        workspacePath: process.cwd(),
        sandbox: {
          async runCommand() {
            throw new Error("no commands expected");
          }
        }
      }
    });
    const provider = new DeepAgentLLMProvider(
      new ReasoningReportingDeepAgentModel(),
      definition,
      backend
    );

    const response = await provider.invoke([new HumanMessage("work")]);

    // 这一条一旦回归，网关就会在 thinking 模式下 400「reasoning_content must be passed back」。
    expect(response.additional_kwargs.reasoning_content).toBe(REASONING_SENTINEL);
  });
});
