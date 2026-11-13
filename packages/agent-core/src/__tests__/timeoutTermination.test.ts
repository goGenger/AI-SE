import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { ToolRuntime, createPhase1Tools } from "@ai-se/tool-runtime";
import {
  BaseChatModel,
  BaseChatModelCallOptions,
  BindToolsInput
} from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import { Runnable } from "@langchain/core/runnables";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentContext } from "../agent/AgentContext";
import { AgentRunner } from "../agent/AgentRunner";
import { AgentRegistry } from "../professional/AgentRegistry";
import { DeepAgentLLMProvider } from "../professional/DeepAgentLLMProvider";
import { ToolRuntimeBackend } from "../professional/ToolRuntimeBackend";

/**
 * E-0(b)（docs/125）：超时终止传播复现——深代理循环在 run 超时后必须停止：
 *  1) run 在超时附近收敛（不得等循环自然结束）；
 *  2) 超时后零新增模型调用与零新增工具调用（C-6 ghosts：timed_out 后仍持续调用 2–23 分钟）。
 */

class FakeSandbox implements Sandbox {
  async runCommand(_workspacePath: string, command: SandboxCommand): Promise<SandboxResult> {
    return {
      command: command.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      duration: 1,
      timedOut: false
    };
  }
}

/** 脚本化深代理模型：N 步工具调用循环；与真实 chat 模型一致地对 signal 中止敏感。 */
class LoopModel extends BaseChatModel<BaseChatModelCallOptions> {
  static lc_name(): string {
    return "ChatOpenAI";
  }

  invocations = 0;

  constructor(
    private readonly steps: number,
    private readonly delayMs: number
  ) {
    super({});
  }

  _llmType(): string {
    return "e0-loop-model";
  }

  bindTools(_tools: BindToolsInput[]): Runnable<unknown, AIMessageChunk, BaseChatModelCallOptions> {
    return this as Runnable<unknown, AIMessageChunk, BaseChatModelCallOptions>;
  }

  async _generate(
    _messages: BaseMessage[],
    options: this["ParsedCallOptions"]
  ): Promise<ChatResult> {
    this.invocations += 1;
    if (options.signal?.aborted) throw new Error("aborted");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true }
      );
    });
    const message =
      this.invocations <= this.steps
        ? new AIMessage({
            content: "",
            tool_calls: [
              {
                id: randomUUID(),
                name: "read_file",
                args: { path: "apps/server/package.json" },
                type: "tool_call"
              }
            ]
          })
        : new AIMessage("done");
    return { generations: [{ text: "", message }] };
  }
}

function makeBackend(definition: ReturnType<AgentRegistry["get"]>, context: AgentContext) {
  return new ToolRuntimeBackend({
    runtime: new ToolRuntime({ tools: createPhase1Tools() }),
    permissions: definition.permissions,
    context
  });
}

describe("run timeout termination (E-0b)", () => {
  it("settles near the timeout and stops the deep-agent loop (no post-timeout calls)", async () => {
    const definition = new AgentRegistry().get("backend-agent");
    const context: AgentContext = {
      requestId: "req-e0",
      taskId: "task-e0",
      agentRunId: "run-e0",
      actor: definition.name,
      workspacePath: process.cwd(),
      sandbox: new FakeSandbox()
    };
    const backend = makeBackend(definition, context);
    const model = new LoopModel(30, 60);
    const provider = new DeepAgentLLMProvider(model, definition, backend);
    const runner = new AgentRunner({
      llmProvider: provider,
      toolRuntime: new ToolRuntime({ tools: createPhase1Tools() }),
      systemPrompt: "You are a test engineer."
    });

    const started = Date.now();
    const result = await runner.run("loop forever", context, { timeoutMs: 250 });
    const settledAfter = Date.now() - started;

    expect(result.status).toBe("timed_out");
    // 1) 超时附近收敛（循环自然结束约需 30*60ms ≈ 1.8s+）。
    expect(settledAfter).toBeLessThan(1_200);

    const modelCallsAtEnd = model.invocations;
    const toolCallsAtEnd = backend.iterations;
    const finishedAtEnd = backend.toolResults.length;
    await new Promise((resolve) => setTimeout(resolve, 900));
    // 2) 超时后零新增模型调用 / 工具调用。
    expect(model.invocations).toBe(modelCallsAtEnd);
    expect(backend.iterations).toBe(toolCallsAtEnd);
    expect(backend.toolResults.length).toBe(finishedAtEnd);
  });
});
