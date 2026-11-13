import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { ToolRuntime, createPhase1Tools } from "@ai-se/tool-runtime";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { StructuredToolInterface } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { AgentLifecycleHooks } from "../agent/AgentLifecycle";
import { AgentContext } from "../agent/AgentContext";
import { AgentRunner, recursionLimitFor } from "../agent/AgentRunner";
import { LLMInvokeOptions, LLMProvider } from "../llm/LLMProvider";

class FakeSandbox implements Sandbox {
  async runCommand(_workspacePath: string, command: SandboxCommand): Promise<SandboxResult> {
    return {
      command: command.command,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      duration: 1,
      timedOut: false
    };
  }
}

class QueueLLMProvider implements LLMProvider {
  private tools: StructuredToolInterface[] = [];

  constructor(private readonly responses: (AIMessage | Error)[]) {}

  async invoke(_messages: BaseMessage[], _options?: LLMInvokeOptions): Promise<AIMessage> {
    const next = this.responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? new AIMessage("done");
  }

  async *stream(messages: BaseMessage[], options?: LLMInvokeOptions): AsyncIterable<AIMessage> {
    yield await this.invoke(messages, options);
  }

  bindTools(tools: StructuredToolInterface[]): LLMProvider {
    this.tools = tools;
    return this;
  }

  toolCount(): number {
    return this.tools.length;
  }
}

class AbortAwareLLMProvider implements LLMProvider {
  async invoke(_messages: BaseMessage[], options?: LLMInvokeOptions): Promise<AIMessage> {
    await new Promise<void>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true
      });
    });
    return new AIMessage("unused");
  }

  async *stream(messages: BaseMessage[], options?: LLMInvokeOptions): AsyncIterable<AIMessage> {
    yield await this.invoke(messages, options);
  }

  bindTools(_tools: StructuredToolInterface[]): LLMProvider {
    return this;
  }
}

function context(): AgentContext {
  return {
    requestId: "req-1",
    taskId: "task-1",
    agentRunId: "run-1",
    actor: "test",
    workspacePath: process.cwd(),
    sandbox: new FakeSandbox()
  };
}

function runner(provider: LLMProvider, lifecycle?: AgentLifecycleHooks): AgentRunner {
  return new AgentRunner({
    llmProvider: provider,
    toolRuntime: new ToolRuntime({ tools: createPhase1Tools() }),
    systemPrompt: "You are a test engineer.",
    defaultTimeoutMs: 1_000,
    lifecycle
  });
}

describe("AgentRunner", () => {
  it("runs agent and tool nodes through LangGraph", async () => {
    const provider = new QueueLLMProvider([
      new AIMessage({
        content: "read",
        tool_calls: [
          {
            name: "read_file",
            args: { path: "src/index.ts" },
            id: "call-1",
            type: "tool_call"
          }
        ]
      }),
      new AIMessage("done")
    ]);

    const result = await runner(provider).run("read file", context(), { maxIterations: 4 });

    expect(result.status).toBe("succeeded");
    expect(result.iterations).toBe(2);
    expect(result.retryCount).toBe(0);
    expect(result.toolResults).toHaveLength(1);
    expect(provider.toolCount()).toBeGreaterThan(0);
  });

  it("classifies LLM failures", async () => {
    const result = await runner(new QueueLLMProvider([new Error("provider down")])).run(
      "fail",
      context(),
      { maxIterations: 2, maxRetries: 0 }
    );

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("LLM_ERROR");
  });

  it("retries transient LLM failures", async () => {
    const result = await runner(
      new QueueLLMProvider([new Error("temporary"), new AIMessage("done")])
    ).run("retry", context(), {
      maxIterations: 2,
      maxRetries: 1,
      // N-61：重试之间现在有退避（默认基数 2s）。这里给足预算——用辅助函数的 1s 默认值，
      // 退避会吃掉整个 run 的预算，重试永远来不及发生（那是另一条用例）。
      timeoutMs: 10_000
    });

    expect(result.status).toBe("succeeded");
    expect(result.retryCount).toBe(1);
    expect(result.error).toBeUndefined();
  });

  /**
   * N-61 (c)：退避不得吃掉整个 run 的预算。预算装不下退避时应当**快速失败**，
   * 而不是把时间全花在等待上、最后以一个看不出原因的超时收场。
   */
  it("budget smaller than the backoff ⇒ fails fast instead of sleeping through it", async () => {
    const started = Date.now();
    const result = await runner(
      new QueueLLMProvider([new Error("temporary"), new AIMessage("done")])
    ).run("retry", context(), { maxIterations: 2, maxRetries: 1 });

    // 默认 1s 预算 + 2s 退避：run 不应超过预算太多（中止把 sleep 打断）。
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.status).not.toBe("succeeded");
  });

  it("records lifecycle persistence events", async () => {
    const events: string[] = [];
    const provider = new QueueLLMProvider([new AIMessage("done")]);

    const result = await runner(provider, {
      async onRunStarted() {
        events.push("started");
      },
      async onIteration(record) {
        events.push(`iteration:${record.iteration}`);
      },
      async onRunFinished(record) {
        events.push(`finished:${record.status}`);
      },
      async onEvent(record) {
        events.push(record.eventType);
      }
    }).run("record", context(), { maxIterations: 2 });

    expect(result.status).toBe("succeeded");
    expect(events).toEqual([
      "started",
      "agent_run_started",
      "iteration:1",
      "agent_final",
      "finished:succeeded",
      "agent_run_finished"
    ]);
  });

  it("stops at max iterations", async () => {
    const provider = new QueueLLMProvider([
      new AIMessage({
        content: "again",
        tool_calls: [{ name: "read_file", args: { path: "x" }, id: "call-1", type: "tool_call" }]
      }),
      new AIMessage({
        content: "again",
        tool_calls: [{ name: "read_file", args: { path: "x" }, id: "call-2", type: "tool_call" }]
      })
    ]);

    const result = await runner(provider).run("loop", context(), { maxIterations: 1 });

    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("max iterations");
  });

  it("reaches the platform guard instead of LangGraph's default recursion limit (N-7)", async () => {
    // A provider that never converges. Without an explicit recursionLimit the outer graph
    // stops at LangGraph's default 25 supersteps -- about 13 iterations of the two-node
    // agent<->tools loop -- and reports the framework's UNKNOWN_ERROR, so the platform's
    // own maxIterations guard never gets to fire. Verified before the fix by
    // scripts/probe-agent-recursion-limit.ts: 13 iterations, UNKNOWN_ERROR,
    // "Recursion limit of 25".
    class NeverConvergingProvider implements LLMProvider {
      async invoke(_messages: BaseMessage[], _options?: LLMInvokeOptions): Promise<AIMessage> {
        return new AIMessage({
          content: "again",
          tool_calls: [{ name: "read_file", args: { path: "x" }, id: "call", type: "tool_call" }]
        });
      }

      async *stream(messages: BaseMessage[], options?: LLMInvokeOptions): AsyncIterable<AIMessage> {
        yield await this.invoke(messages, options);
      }

      bindTools(_tools: StructuredToolInterface[]): LLMProvider {
        return this;
      }
    }

    const result = await runner(new NeverConvergingProvider()).run("loop", context(), {
      maxIterations: 50,
      maxRetries: 0
    });

    expect(result.error?.code).toBe("TOOL_ERROR");
    expect(result.error?.message).toContain("max iterations");
    expect(result.iterations).toBe(50);
  });

  it("derives the LangGraph recursion limit from maxIterations (N-7)", () => {
    // Two supersteps per agent<->tools iteration, plus headroom. The probe measured 101
    // supersteps to reach the guard at maxIterations = 50, so the limit must stay above
    // 2 * maxIterations + 1.
    expect(recursionLimitFor(50)).toBe(104);
    expect(recursionLimitFor(12)).toBe(28);
    expect(recursionLimitFor(50)).toBeGreaterThan(2 * 50 + 1);
  });

  it("supports cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runner(new QueueLLMProvider([new AIMessage("unused")])).run(
      "cancel",
      context(),
      { signal: controller.signal }
    );

    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("CANCELLED_ERROR");
  });

  it("marks timeout separately from failure", async () => {
    const result = await runner(new AbortAwareLLMProvider()).run("timeout", context(), {
      timeoutMs: 20,
      maxRetries: 0
    });

    expect(result.status).toBe("timed_out");
    expect(result.error?.code).toBe("TIMEOUT_ERROR");
  });
});
