import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  ToolMessage
} from "@langchain/core/messages";
import { StructuredToolInterface } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import {
  LangChainLLMProvider,
  createOpenAIChatModel,
  openCodeGatewayConfiguration,
  openCodeGatewayHeaders
} from "../llm/LangChainLLMProvider";

class FakeChatModel {
  public tools: StructuredToolInterface[] = [];

  constructor(private readonly output: AIMessage | AIMessageChunk) {}

  async invoke(_messages: BaseMessage[]) {
    return this.output;
  }

  bindTools(tools: StructuredToolInterface[]) {
    this.tools = tools;
    return this;
  }
}

describe("LangChainLLMProvider", () => {
  it("wraps a LangChain chat model", async () => {
    const model = new FakeChatModel(new AIMessage("done"));
    const provider = new LangChainLLMProvider(model);

    const result = await provider.invoke([new HumanMessage("hello")]);

    expect(result.content).toBe("done");
  });

  it("normalizes AIMessageChunk output", async () => {
    const model = new FakeChatModel(new AIMessageChunk("chunked"));
    const provider = new LangChainLLMProvider(model);

    const result = await provider.invoke([new HumanMessage("hello")]);

    expect(result).toBeInstanceOf(AIMessage);
    expect(result.content).toBe("chunked");
  });

  it("keeps additional_kwargs when the cost is attached to the response (N-6)", async () => {
    const model = new FakeChatModel(
      new AIMessage({
        content: "done",
        additional_kwargs: { reasoning_content: "SENTINEL" },
        usage_metadata: { input_tokens: 1_000_000, output_tokens: 0, total_tokens: 1_000_000 }
      })
    );
    const provider = new LangChainLLMProvider(model, { inputPerMTok: 1, outputPerMTok: 1 });

    const result = await provider.invoke([new HumanMessage("hello")]);

    // N-6（docs/172）：挂成本时会再重建一次消息；丢掉 additional_kwargs 会让网关
    // 要求的 reasoning_content 无法回传。
    expect(result.response_metadata?.estimatedCostUsd).toBe(1);
    expect(result.additional_kwargs.reasoning_content).toBe("SENTINEL");
  });
});

describe("createOpenAIChatModel", () => {
  it("routes an OpenAI-compatible endpoint through configuration.baseURL", () => {
    const model = createOpenAIChatModel({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com/v1"
    });
    expect(model.clientConfig.baseURL).toBe("https://api.deepseek.com/v1");
  });

  it("falls back to OPENAI_BASE_URL from the environment", () => {
    const original = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = "https://gateway.example.test/v1";
    try {
      const model = createOpenAIChatModel({ apiKey: "test-key" });
      expect(model.clientConfig.baseURL).toBe("https://gateway.example.test/v1");
    } finally {
      if (original === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = original;
    }
  });

  it("omits baseURL when no endpoint is configured", () => {
    const original = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    try {
      const model = createOpenAIChatModel({ apiKey: "test-key" });
      expect(model.clientConfig.baseURL).toBeUndefined();
    } finally {
      if (original !== undefined) process.env.OPENAI_BASE_URL = original;
    }
  });
});

describe("OpenCode Go gateway compliance", () => {
  it("derives the compliance headers only for the opencode gateway", () => {
    expect(openCodeGatewayHeaders("https://opencode.ai/zen/go/v1", "task-1")).toEqual({
      "User-Agent": "ai-se-platform/1.0",
      "x-opencode-session": "task-1"
    });
    expect(
      openCodeGatewayHeaders("https://opencode.ai/zen/go/v1", undefined)?.["x-opencode-session"]
    ).toBe("ai-se-platform");
    expect(openCodeGatewayHeaders("https://api.deepseek.com/v1", "task-1")).toBeUndefined();
    expect(openCodeGatewayHeaders(undefined, "task-1")).toBeUndefined();
  });

  it("attaches the compliance headers to the model client config", () => {
    const model = createOpenAIChatModel({
      apiKey: "test-key",
      baseUrl: "https://opencode.ai/zen/go/v1",
      sessionId: "task-42"
    });

    const headers = model.clientConfig.defaultHeaders as Record<string, string> | undefined;
    expect(headers?.["x-opencode-session"]).toBe("task-42");
    expect(String(headers?.["User-Agent"])).toContain("ai-se-platform/1.0");

    const other = createOpenAIChatModel({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com/v1"
    });
    const otherHeaders = other.clientConfig.defaultHeaders as Record<string, string> | undefined;
    expect(otherHeaders?.["x-opencode-session"]).toBeUndefined();
  });

  it("builds the gateway configuration only for the opencode endpoint", () => {
    const configuration = openCodeGatewayConfiguration("https://opencode.ai/zen/go/v1", "sess-42");

    expect(configuration.baseURL).toBe("https://opencode.ai/zen/go/v1");
    expect(configuration.defaultHeaders?.["x-opencode-session"]).toBe("sess-42");
    expect(typeof configuration.fetch).toBe("function");

    const other = openCodeGatewayConfiguration("https://api.deepseek.com/v1", "sess-42");
    expect(other.baseURL).toBe("https://api.deepseek.com/v1");
    expect(other.defaultHeaders).toBeUndefined();
    expect(other.fetch).toBeUndefined();
  });

  it("rewrites the User-Agent at the fetch layer (LangChain overrides the header)", async () => {
    const original = globalThis.fetch;
    const seen: Record<string, string | undefined> = {};
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen["user-agent"] = new Headers(init?.headers ?? {}).get("User-Agent") ?? undefined;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const configuration = openCodeGatewayConfiguration(
        "https://opencode.ai/zen/go/v1",
        "sess-42"
      );

      await configuration.fetch?.("https://opencode.ai/zen/go/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "User-Agent": "langchainjs-openai/1.0.0 (node)"
        },
        body: "{}"
      });

      // 覆盖 LangChain/SDK 自带的通用 UA，改为自有客户端标识。
      expect(seen["user-agent"]).toBe("ai-se-platform/1.0");
    } finally {
      globalThis.fetch = original;
    }
  });

  /**
   * PL-M17（N-6 复发）：网关在 thinking 模式下要求「带 tool_calls 的 assistant 消息必须
   * 回传 reasoning_content」。当网关**没有**为某一轮返回 reasoning 时（间歇性，`docs/173`
   * KI 6），平台无法凭空造出内容——但实测（`scripts/probe-n6-gateway-rule.ts`）表明网关
   * **接受空字符串**（R2/R3 均 200），而只去掉 tool_calls 会撞上另一条规则（R5 400）。
   *
   * 所以补丁在转换器里补一个空 `reasoning_content`。这条用例钉住的是**平台侧的调用契约**：
   * 从 LangChain 消息对象出发，出站 body 里那条 assistant 消息必须带 `reasoning_content`。
   */
  it("sends reasoning_content for a tool-call assistant message that never had one (PL-M17)", async () => {
    const original = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "test-model",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    try {
      const model = createOpenAIChatModel({
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "test-key",
        model: "test-model"
      });
      await model.invoke([
        new HumanMessage("read the file"),
        new AIMessage({
          content: "",
          tool_calls: [{ name: "read_file", args: { file_path: "a.txt" }, id: "c1", type: "tool_call" }]
        }),
        new ToolMessage({ content: "file body", tool_call_id: "c1" })
      ]);
    } finally {
      globalThis.fetch = original;
    }

    const messages = bodies[0]?.messages as Record<string, unknown>[] | undefined;
    expect(messages).toBeDefined();
    const assistant = messages?.find((message) => message.role === "assistant");
    expect(assistant).toBeDefined();
    // 工具调用仍在（不去掉它——去掉会撞上网关另一条规则）。
    expect(Array.isArray(assistant?.tool_calls)).toBe(true);
    // 而 reasoning_content 必须**存在**（空字符串即可，网关实测接受）。
    expect(typeof assistant?.reasoning_content).toBe("string");
  });
});
