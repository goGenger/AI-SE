import { OutputParserException } from "@langchain/core/output_parsers";
import { ChatOpenAI } from "@langchain/openai";
import { describe, expect, it, vi, type Mock } from "vitest";
import { z } from "zod";
import { LangChainPlanningModel } from "../planning/LangChainPlanningModel";

function stubStructuredOutput() {
  const invoke = vi.fn(async (_messages: unknown, _options?: unknown) => ({ ok: true }));
  const spy = vi
    .spyOn(ChatOpenAI.prototype, "withStructuredOutput")
    .mockReturnValue({ invoke } as unknown as ReturnType<ChatOpenAI["withStructuredOutput"]>);
  return { invoke, spy };
}

function stubStructuredOutputWith(invoke: Mock) {
  const spy = vi
    .spyOn(ChatOpenAI.prototype, "withStructuredOutput")
    .mockReturnValue({ invoke } as unknown as ReturnType<ChatOpenAI["withStructuredOutput"]>);
  return { spy };
}

function request() {
  return {
    stage: "requirement_analysis" as const,
    prompt: "plan",
    schema: z.object({ ok: z.boolean() }),
    input: {},
    validationErrors: []
  };
}

describe("LangChainPlanningModel structured output", () => {
  it("keeps the default strict jsonSchema path when no method is configured", async () => {
    const { spy, invoke } = stubStructuredOutput();
    try {
      const model = new LangChainPlanningModel({ apiKey: "test-key" });
      const result = await model.generateStructured(request());
      expect(result).toEqual({ ok: true });
      expect(invoke).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0]?.[1]).toEqual({ name: "requirement_analysis", strict: true });
    } finally {
      spy.mockRestore();
    }
  });

  it("forwards an explicit functionCalling method for OpenAI-compatible endpoints", async () => {
    const { spy } = stubStructuredOutput();
    try {
      const model = new LangChainPlanningModel({
        apiKey: "test-key",
        baseUrl: "https://api.deepseek.com/v1",
        structuredOutputMethod: "functionCalling"
      });
      await model.generateStructured(request());
      // No `strict` on the tool path: the tool conversion does not apply the
      // additionalProperties/required transforms strict mode requires.
      expect(spy.mock.calls[0]?.[1]).toEqual({
        name: "requirement_analysis",
        method: "functionCalling"
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps strict when jsonSchema is selected explicitly", async () => {
    const { spy } = stubStructuredOutput();
    try {
      const model = new LangChainPlanningModel({
        apiKey: "test-key",
        structuredOutputMethod: "jsonSchema"
      });
      await model.generateStructured(request());
      expect(spy.mock.calls[0]?.[1]).toEqual({
        name: "requirement_analysis",
        strict: true,
        method: "jsonSchema"
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("drops strict for jsonMode and injects the json schema instruction", async () => {
    const { spy, invoke } = stubStructuredOutput();
    try {
      const model = new LangChainPlanningModel({
        apiKey: "test-key",
        structuredOutputMethod: "jsonMode"
      });
      await model.generateStructured(request());
      expect(spy.mock.calls[0]?.[1]).toEqual({
        name: "requirement_analysis",
        method: "jsonMode"
      });
      // `response_format: json_object` needs the word "json" in the prompt and
      // langchain does not inject the schema for jsonMode, so the wrapper must.
      const messages = invoke.mock.calls[0]?.[0] as Array<{ content: unknown }> | undefined;
      const systemContent = String(messages?.[0]?.content ?? "");
      expect(systemContent).toContain("json");
      expect(systemContent).toContain('"ok"');
    } finally {
      spy.mockRestore();
    }
  });

  it("re-samples malformed model output before failing", async () => {
    const { spy } = stubStructuredOutputWith(
      vi
        .fn()
        .mockRejectedValueOnce(new OutputParserException('Failed to parse. Text: "{"'))
        .mockResolvedValueOnce({ ok: true })
    );
    try {
      const model = new LangChainPlanningModel({ apiKey: "test-key" });
      const result = await model.generateStructured(request());
      expect(result).toEqual({ ok: true });
    } finally {
      spy.mockRestore();
    }
  });

  it("gives up after three malformed samples and preserves the parser error", async () => {
    const invoke = vi
      .fn()
      .mockRejectedValue(new OutputParserException('Failed to parse. Text: "{"'));
    const { spy } = stubStructuredOutputWith(invoke);
    try {
      const model = new LangChainPlanningModel({ apiKey: "test-key" });
      await expect(model.generateStructured(request())).rejects.toBeInstanceOf(
        OutputParserException
      );
      expect(invoke).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not re-sample non-parser failures", async () => {
    const invoke = vi
      .fn()
      .mockRejectedValue(new Error("400 This response_format type is unavailable now"));
    const { spy } = stubStructuredOutputWith(invoke);
    try {
      const model = new LangChainPlanningModel({ apiKey: "test-key" });
      await expect(model.generateStructured(request())).rejects.toThrow("response_format");
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * N-25（`docs/206`）：用量必须经 `handleLLMEnd` 报出，**包括解析失败的那次重采样**。
   * `OutputParserException` 只带 `llmOutput: string`，不含用量——若把用量挂在返回值上，
   * 第一次（失败）的消耗会被整段丢掉，累计值必然偏低。
   */
  it("N-25：每次模型调用的用量都经 onUsage 报出（含解析失败的重采样）", async () => {
    let attempt = 0;
    const invoke = vi.fn(
      async (
        _messages: unknown,
        options?: { callbacks?: Array<{ handleLLMEnd?: (output: unknown) => Promise<void> }> }
      ) => {
        attempt += 1;
        await options?.callbacks?.[0]?.handleLLMEnd?.({
          generations: [
            [
              {
                message: {
                  usage_metadata: {
                    input_tokens: 100 * attempt,
                    output_tokens: 10 * attempt,
                    total_tokens: 110 * attempt
                  }
                }
              }
            ]
          ]
        });
        if (attempt === 1) throw new OutputParserException("malformed", "{");
        return { ok: true };
      }
    );
    const { spy } = stubStructuredOutputWith(invoke);
    try {
      const model = new LangChainPlanningModel({ apiKey: "test-key" });
      const usages: unknown[] = [];
      const result = await model.generateStructured({
        ...request(),
        onUsage: (usage) => usages.push(usage)
      });
      expect(result).toEqual({ ok: true });
      expect(usages).toEqual([
        { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        { input_tokens: 200, output_tokens: 20, total_tokens: 220 }
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("LangChainPlanningModel UI reference multimodal", () => {
  it("attaches image_url parts when providedUiReferences carry base64", async () => {
    const { spy, invoke } = stubStructuredOutput();
    try {
      const model = new LangChainPlanningModel({ apiKey: "test-key" });
      await model.generateStructured({
        ...request(),
        input: {
          providedUiReferences: [
            {
              fileName: "home.png",
              mimeType: "image/png",
              note: "[UI reference image: home.png]",
              base64: "qqq"
            }
          ]
        }
      });
      const messages = invoke.mock.calls[0]?.[0] as Array<{ content: unknown }>;
      const human = messages?.[1];
      expect(Array.isArray(human?.content)).toBe(true);
      const parts = human?.content as Array<{ type: string; image_url?: { url: string } }>;
      expect(parts.some((part) => part.type === "text")).toBe(true);
      const image = parts.find((part) => part.type === "image_url");
      expect(image?.image_url?.url).toBe("data:image/png;base64,qqq");
      // JSON payload must not embed the raw base64 blob.
      const textPart = parts.find((part) => part.type === "text") as
        | { type: string; text?: string }
        | undefined;
      expect(textPart?.text).toBeTypeOf("string");
      expect(textPart?.text).not.toContain('"base64":"qqq"');
      expect(textPart?.text).toContain("home.png");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps plain text HumanMessage when no UI images are present", async () => {
    const { spy, invoke } = stubStructuredOutput();
    try {
      const model = new LangChainPlanningModel({ apiKey: "test-key" });
      await model.generateStructured(request());
      const messages = invoke.mock.calls[0]?.[0] as Array<{ content: unknown }>;
      expect(typeof messages?.[1]?.content).toBe("string");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not attach image_url on OpenCode endpoints by default", async () => {
    const { spy, invoke } = stubStructuredOutput();
    try {
      const model = new LangChainPlanningModel({
        apiKey: "test-key",
        baseUrl: "https://opencode.ai/zen/go/v1"
      });
      await model.generateStructured({
        ...request(),
        input: {
          providedUiReferences: [
            {
              fileName: "home.png",
              mimeType: "image/png",
              note: "UI reference analysis for home.png: purple sidebar",
              base64: "qqq"
            }
          ]
        }
      });
      const messages = invoke.mock.calls[0]?.[0] as Array<{ content: unknown }>;
      expect(typeof messages?.[1]?.content).toBe("string");
      expect(String(messages?.[1]?.content)).toContain("purple sidebar");
      expect(String(messages?.[1]?.content)).not.toContain('"base64":"qqq"');
    } finally {
      spy.mockRestore();
    }
  });

  it("retries text-only when multimodal is rejected by atlas", async () => {
    const invoke = vi.fn(async (messages: Array<{ content: unknown }>) => {
      if (Array.isArray(messages[1]?.content)) {
        throw new Error(
          "400 Upstream request failed: [invalid_request_error] this feature is not yet supported by atlas"
        );
      }
      return { ok: true };
    });
    const { spy } = stubStructuredOutputWith(invoke);
    try {
      const model = new LangChainPlanningModel({
        apiKey: "test-key",
        baseUrl: "https://api.openai.com/v1",
        attachUiReferenceImages: true
      });
      const result = await model.generateStructured({
        ...request(),
        input: {
          providedUiReferences: [
            {
              fileName: "home.png",
              mimeType: "image/png",
              note: "[UI reference image: home.png]",
              base64: "qqq"
            }
          ]
        }
      });
      expect(result).toEqual({ ok: true });
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(Array.isArray(invoke.mock.calls[0]?.[0]?.[1]?.content)).toBe(true);
      expect(typeof invoke.mock.calls[1]?.[0]?.[1]?.content).toBe("string");
    } finally {
      spy.mockRestore();
    }
  });

});
