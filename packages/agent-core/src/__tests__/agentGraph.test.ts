import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { ToolRuntime, createPhase1Tools } from "@ai-se/tool-runtime";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { StructuredToolInterface } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { AgentContext } from "../agent/AgentContext";
import { AgentLifecycleHooks } from "../agent/AgentLifecycle";
import { AgentRunner } from "../agent/AgentRunner";
import { createLangChainTools } from "../graph/AgentGraph";
import { LLMInvokeOptions, LLMProvider } from "../llm/LLMProvider";

describe("AgentGraph", () => {
  it("exposes Phase 1 tools to LangChain", () => {
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });
    const tools = createLangChainTools(runtime);

    expect(tools.map((entry) => entry.name)).toContain("read_file");
    expect(tools.map((entry) => entry.name)).toContain("run_unit_test");
  });
});

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

/** 记录每次调用消息的 provider：按队列返回响应，耗尽后返回 "done"。 */
class RecordingLLMProvider implements LLMProvider {
  readonly calls: BaseMessage[][] = [];

  constructor(private readonly responses: AIMessage[]) {}

  async invoke(messages: BaseMessage[], _options?: LLMInvokeOptions): Promise<AIMessage> {
    this.calls.push(messages);
    const next = this.responses.shift();
    return next ?? new AIMessage("done");
  }

  async *stream(messages: BaseMessage[], options?: LLMInvokeOptions): AsyncIterable<AIMessage> {
    yield await this.invoke(messages, options);
  }

  bindTools(_tools: StructuredToolInterface[]): LLMProvider {
    return this;
  }
}

function testContext(): AgentContext {
  return {
    requestId: "req-empty-final",
    taskId: "task-empty-final",
    agentRunId: "run-empty-final",
    actor: "vitest",
    workspacePath: process.cwd(),
    sandbox: new FakeSandbox()
  };
}

interface CapturedEvent {
  eventType: string;
  payload: Record<string, unknown>;
}

function recordingLifecycle(events: CapturedEvent[]): AgentLifecycleHooks {
  return {
    onEvent: async (record) => {
      events.push({ eventType: record.eventType, payload: record.payload as never });
    }
  };
}

function buildRunner(provider: LLMProvider, events: CapturedEvent[]): AgentRunner {
  return new AgentRunner({
    llmProvider: provider,
    toolRuntime: new ToolRuntime({ tools: [] }),
    systemPrompt: "system",
    defaultMaxIterations: 8,
    defaultTimeoutMs: 5_000,
    defaultMaxRetries: 0,
    lifecycle: recordingLifecycle(events)
  });
}

describe("AgentGraph empty-final nudge", () => {
  it("re-asks once when the model returns an empty final reply, then keeps the real answer", async () => {
    const answer = JSON.stringify({ status: "SUCCESS", summary: "done" });
    const provider = new RecordingLLMProvider([new AIMessage(""), new AIMessage(answer)]);
    const events: CapturedEvent[] = [];

    const result = await buildRunner(provider, events).run("do the task", testContext(), {
      maxIterations: 8,
      timeoutMs: 5_000
    });

    expect(result.status).toBe("succeeded");
    expect(result.finalAnswer).toBe(answer);
    expect(provider.calls).toHaveLength(2);
    // 第二次调用必须带上"空回复"提示（HumanMessage），模型才知道需要重答
    expect(
      provider.calls[1].some(
        (message) =>
          HumanMessage.isInstance(message) && String(message.content).includes("contained no text")
      )
    ).toBe(true);
    // 事件流：空回复重试记为 agent_action/empty_reply_retry；真正的结束是 agent_final
    expect(
      events.find(
        (event) =>
          event.eventType === "agent_action" && event.payload.action === "empty_reply_retry"
      )
    ).toBeDefined();
    expect(
      events.some(
        (event) => event.eventType === "agent_final" && event.payload.action === "final_answer"
      )
    ).toBe(true);
  });

  it("stops after the bounded nudge count when the model keeps replying empty", async () => {
    const provider = new RecordingLLMProvider([
      new AIMessage(""),
      new AIMessage(""),
      new AIMessage("")
    ]);
    const events: CapturedEvent[] = [];

    const result = await buildRunner(provider, events).run("do the task", testContext(), {
      maxIterations: 8,
      timeoutMs: 5_000
    });

    // 初始 1 次 + 最多 2 次重问 = 3 次调用；之后仍为空答案（上游按 INVALID 处理）
    expect(provider.calls).toHaveLength(3);
    expect(result.finalAnswer).toBe("");
    expect(result.status).toBe("succeeded");
    expect(
      events.filter(
        (event) =>
          event.eventType === "agent_action" && event.payload.action === "empty_reply_retry"
      )
    ).toHaveLength(2);
  });
});


describe("AgentGraph budget conclude nudge", () => {
  it("injects a conclude nudge when iteration is within the last 2 of maxIterations", async () => {
    const answer = JSON.stringify({ status: "SUCCESS", summary: "done" });
    const provider = new RecordingLLMProvider([new AIMessage(answer)]);
    const events: CapturedEvent[] = [];

    const result = await buildRunner(provider, events).run("do the task", testContext(), {
      // iteration 0 >= maxIterations - 2 → nudge on the first (and only) turn
      maxIterations: 2,
      timeoutMs: 5_000
    });

    expect(result.status).toBe("succeeded");
    expect(
      provider.calls[0].some(
        (message) =>
          HumanMessage.isInstance(message) &&
          String(message.content).includes("Budget is nearly exhausted")
      )
    ).toBe(true);
    expect(
      events.find(
        (event) =>
          event.eventType === "agent_action" && event.payload.action === "budget_conclude_nudge"
      )
    ).toBeDefined();
  });

  it("does not budget-nudge while still far from maxIterations", async () => {
    const answer = JSON.stringify({ status: "SUCCESS", summary: "done" });
    const provider = new RecordingLLMProvider([new AIMessage(answer)]);
    const events: CapturedEvent[] = [];

    await buildRunner(provider, events).run("do the task", testContext(), {
      maxIterations: 8,
      timeoutMs: 5_000
    });

    expect(
      provider.calls[0].some(
        (message) =>
          HumanMessage.isInstance(message) &&
          String(message.content).includes("Budget is nearly exhausted")
      )
    ).toBe(false);
    expect(
      events.find(
        (event) =>
          event.eventType === "agent_action" && event.payload.action === "budget_conclude_nudge"
      )
    ).toBeUndefined();
  });
});

describe("AgentGraph LLM retry abort", () => {
  class AbortingProvider implements LLMProvider {
    calls = 0;

    constructor(private readonly controller: AbortController) {}

    async invoke(_messages: BaseMessage[], _options?: LLMInvokeOptions): Promise<AIMessage> {
      this.calls += 1;
      // 模拟超时/取消:调用失败的同时信号已中止。
      this.controller.abort();
      throw new Error("LLM call aborted");
    }

    async *stream(messages: BaseMessage[], options?: LLMInvokeOptions): AsyncIterable<AIMessage> {
      yield await this.invoke(messages, options);
    }

    bindTools(_tools: StructuredToolInterface[]): LLMProvider {
      return this;
    }
  }

  it("does not retry an LLM call after the run was aborted (timeout / cancel)", async () => {
    const controller = new AbortController();
    const provider = new AbortingProvider(controller);
    const events: CapturedEvent[] = [];
    const runner = new AgentRunner({
      llmProvider: provider,
      toolRuntime: new ToolRuntime({ tools: [] }),
      systemPrompt: "system",
      defaultMaxIterations: 8,
      defaultTimeoutMs: 5_000,
      defaultMaxRetries: 2,
      lifecycle: recordingLifecycle(events)
    });

    const result = await runner.run("do the task", testContext(), {
      maxIterations: 8,
      timeoutMs: 5_000,
      maxRetries: 2,
      signal: controller.signal
    });

    // 中止后不重试:只调用一次,且不产生 llm_retry 事件(否则真实原因会被掩盖成 LLM_ERROR)。
    // 中止后不重试:只调用一次,且不产生 llm_retry 事件(否则真实原因会被掩盖成 LLM_ERROR)。
    expect(provider.calls).toBe(1);
    expect(events.some((event) => event.eventType === "llm_retry")).toBe(false);
    // 外部信号中止 → 运行按取消收尾(超时路径走 timed_out;两者都不再重试)。
    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("CANCELLED_ERROR");
  });
});

/**
 * PL-C2（`docs/162` §2）：用量必须**跨轮累加**。
 * 修复前 `agentNode` 每轮直接写 `{ tokenUsage }`，而 `metadata` 的 reducer 是覆盖式合并——
 * 整轮只留下最后一次调用的用量（真实案例：90 次内层调用的 run 只落一次调用的 token 数）。
 *
 * 这里用「空回复重问」路径拿到**两次** LLM 调用（无需工具），断言得到的是**和**而非**最后一条**。
 */
function usageMessage(
  content: string,
  input: number,
  output: number,
  cost?: number
): AIMessage {
  return new AIMessage({
    content,
    usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output },
    ...(cost !== undefined ? { response_metadata: { estimatedCostUsd: cost } } : {})
  });
}

describe("AgentGraph usage accumulation (PL-C2)", () => {
  it("sums token usage across turns instead of keeping only the last call", async () => {
    const provider = new RecordingLLMProvider([
      usageMessage("", 100, 10),
      usageMessage("final answer", 200, 20)
    ]);
    const events: CapturedEvent[] = [];

    const result = await buildRunner(provider, events).run("do the task", testContext(), {
      maxIterations: 8,
      timeoutMs: 5_000
    });

    expect(result.tokenUsage).toMatchObject({
      input_tokens: 300,
      output_tokens: 30,
      total_tokens: 330
    });
  });

  it("sums the provider-reported cost across turns", async () => {
    const provider = new RecordingLLMProvider([
      usageMessage("", 100, 10, 0.5),
      usageMessage("final answer", 200, 20, 0.25)
    ]);
    const events: CapturedEvent[] = [];

    const result = await buildRunner(provider, events).run("do the task", testContext(), {
      maxIterations: 8,
      timeoutMs: 5_000
    });

    expect(result.estimatedCost).toBeCloseTo(0.75, 10);
  });

  it("leaves estimatedCost undefined when the provider reports no cost", async () => {
    const provider = new RecordingLLMProvider([
      usageMessage("", 100, 10),
      usageMessage("final answer", 200, 20)
    ]);
    const events: CapturedEvent[] = [];

    const result = await buildRunner(provider, events).run("do the task", testContext(), {
      maxIterations: 8,
      timeoutMs: 5_000
    });

    // 未配置价目 → 维持 undefined（落库为 NULL）——宁可留空，也不编造数字。
    expect(result.tokenUsage).toBeDefined();
    expect(result.estimatedCost).toBeUndefined();
  });
});

/**
 * N-61（`docs/232` §10）：429 要**等**，且等多久听上游的；不可重试的 4xx 不要白撞。
 *
 * 原缺陷实证：上游回 `retry shortly (after 21 s)`，平台 6 秒内跑完三次完整 agent_run。
 */
describe("AgentGraph LLM backoff (N-61)", () => {
  class FailingProvider implements LLMProvider {
    calls = 0;

    constructor(private readonly message: string) {}

    async invoke(_messages: BaseMessage[], _options?: LLMInvokeOptions): Promise<AIMessage> {
      this.calls += 1;
      throw new Error(this.message);
    }

    async *stream(messages: BaseMessage[], options?: LLMInvokeOptions): AsyncIterable<AIMessage> {
      yield await this.invoke(messages, options);
    }

    bindTools(_tools: StructuredToolInterface[]): LLMProvider {
      return this;
    }
  }

  function runnerWith(provider: LLMProvider, events: CapturedEvent[], maxRetries: number) {
    return new AgentRunner({
      llmProvider: provider,
      toolRuntime: new ToolRuntime({ tools: [] }),
      systemPrompt: "system",
      defaultMaxIterations: 8,
      defaultTimeoutMs: 10_000,
      defaultMaxRetries: maxRetries,
      lifecycle: recordingLifecycle(events)
    });
  }

  it("429 带 `after ... ms` ⇒ 真的等过再重试（不是立即重打）", async () => {
    const provider = new FailingProvider("429 Too Many Requests; retry after 300 ms");
    const events: CapturedEvent[] = [];

    const started = Date.now();
    const result = await runnerWith(provider, events, 1).run("do the task", testContext(), {
      maxIterations: 8,
      timeoutMs: 10_000,
      maxRetries: 1
    });
    const elapsed = Date.now() - started;

    // 两次尝试，中间至少等了 300ms。
    expect(provider.calls).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(280);
    // 重试事件照旧发（可观测性不变）。
    expect(events.some((event) => event.eventType === "llm_retry")).toBe(true);
    expect(result.status).toBe("failed");
  });

  it("认证类错误（401）不重试——重打只会重复同一条错误", async () => {
    const provider = new FailingProvider("401 Unauthorized");
    const events: CapturedEvent[] = [];

    const result = await runnerWith(provider, events, 2).run("do the task", testContext(), {
      maxIterations: 8,
      timeoutMs: 10_000,
      maxRetries: 2
    });

    expect(provider.calls).toBe(1);
    expect(events.some((event) => event.eventType === "llm_retry")).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("可重试类耗尽后标记 PROVIDER_UNAVAILABLE（与「任务做错了」区分开）", async () => {
    const provider = new FailingProvider("429 Too Many Requests; retry after 10 ms");
    const events: CapturedEvent[] = [];

    const result = await runnerWith(provider, events, 1).run("do the task", testContext(), {
      maxIterations: 8,
      timeoutMs: 10_000,
      maxRetries: 1
    });

    const details = result.error?.details as { reason?: string; kind?: string } | undefined;
    expect(result.error?.code).toBe("LLM_ERROR");
    expect(details?.reason).toBe("PROVIDER_UNAVAILABLE");
    expect(details?.kind).toBe("rate-limit");
  });

  it("不可重试类（401）不带该标记——那是配置/密钥问题，不是上游不可用", async () => {
    const provider = new FailingProvider("401 Unauthorized");
    const events: CapturedEvent[] = [];

    const result = await runnerWith(provider, events, 0).run("do the task", testContext(), {
      maxIterations: 8,
      timeoutMs: 10_000,
      maxRetries: 0
    });

    const details = result.error?.details as { reason?: string } | undefined;
    expect(result.error?.code).toBe("LLM_ERROR");
    expect(details?.reason).toBeUndefined();
  });
});
