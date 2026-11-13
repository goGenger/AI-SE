import { AIMessage, AIMessageChunk, BaseMessage, MessageContent } from "@langchain/core/messages";
import { StructuredToolInterface } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { LLMInvokeOptions, LLMProvider } from "./LLMProvider";
import { estimateCostUsd, ModelPricing } from "./usage";

interface InvokableChatModel {
  invoke(input: BaseMessage[], options?: LLMInvokeOptions): Promise<unknown>;
  bindTools?(tools: StructuredToolInterface[]): InvokableChatModel;
}

export interface OpenAILLMProviderOptions {
  model?: string;
  apiKey?: string;
  temperature?: number;
  /** OpenAI-compatible endpoint override (e.g. DeepSeek). Falls back to OPENAI_BASE_URL. */
  baseUrl?: string;
  /**
   * 会话 ID（OpenCode Go 网关的 x-opencode-session 头）；仅当 baseUrl 指向 opencode 网关时注入。
   * 网关缺失该头会直接 400："Request is missing x-opencode-session and cannot be routed efficiently"。
   */
  sessionId?: string;
  /** 额外默认请求头（与 opencode 合规头合并；测试或特殊网关用）。 */
  defaultHeaders?: Record<string, string>;
  /** PL-C2：每百万 token 的美元单价；未配置 → 不产出成本。 */
  pricing?: ModelPricing;
}

/**
 * OpenCode Go / Zen 的客户端合规头（官方 "Where can I use it?" 要求）：
 *   1. 用自家 User-Agent 标识客户端，而不是通用 SDK/HTTP 库名；
 *   2. 每次会话带稳定的 x-opencode-session（路由与 prompt 缓存优化）。
 * 仅当端点指向 opencode 网关时注入，避免污染其他 provider（DeepSeek 直连等）。
 */
export function openCodeGatewayHeaders(
  baseUrl: string | undefined,
  sessionId: string | undefined
): Record<string, string> | undefined {
  if (!baseUrl || !/opencode\.ai/i.test(baseUrl)) return undefined;
  return {
    "User-Agent": "ai-se-platform/1.0",
    "x-opencode-session": sessionId && sessionId.trim() !== "" ? sessionId : "ai-se-platform"
  };
}

export interface GatewayClientConfiguration {
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  fetch?: typeof fetch;
}

/**
 * LangChain 会在合并时覆盖 configuration.defaultHeaders 里的 User-Agent，
 * 因此在 fetch 层再改写一次 —— 只改请求头，不动 body / 流 / 超时。
 */
function withGatewayUserAgent(fetchImpl: typeof fetch, userAgent: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    headers.set("User-Agent", userAgent);
    return fetchImpl(input, { ...init, headers });
  };
}

/**
 * OpenAI 客户端配置：endpoint + （opencode 网关时）合规头与 UA 改写。
 * 非 opencode 端点只带 baseURL，不注入任何额外头。
 */
export function openCodeGatewayConfiguration(
  baseUrl: string | undefined,
  sessionId: string | undefined
): GatewayClientConfiguration {
  const headers = openCodeGatewayHeaders(baseUrl, sessionId);
  return {
    ...(baseUrl ? { baseURL: baseUrl } : {}),
    ...(headers
      ? {
          defaultHeaders: headers,
          fetch: withGatewayUserAgent(globalThis.fetch, headers["User-Agent"])
        }
      : {})
  };
}

function toAIMessage(output: unknown): AIMessage {
  if (AIMessage.isInstance(output)) {
    return output;
  }

  if (AIMessageChunk.isInstance(output)) {
    return new AIMessage({
      content: output.content,
      tool_calls: output.tool_calls,
      invalid_tool_calls: output.invalid_tool_calls,
      usage_metadata: output.usage_metadata
    });
  }

  throw new Error("LLM provider did not return an AI message");
}

export class LangChainLLMProvider implements LLMProvider {
  constructor(
    private readonly model: InvokableChatModel,
    /** PL-C2：价目；未配置 → 不产出成本（`agent_runs.estimated_cost` 维持 NULL）。 */
    private readonly pricing?: ModelPricing
  ) {}

  static fromOpenAI(options: OpenAILLMProviderOptions = {}): LangChainLLMProvider {
    return new LangChainLLMProvider(createOpenAIChatModel(options), options.pricing);
  }

  async invoke(messages: BaseMessage[], options?: LLMInvokeOptions): Promise<AIMessage> {
    const response = toAIMessage(await this.model.invoke(messages, options));
    // PL-C2：与 DeepAgentLLMProvider 同一手法——成本挂在 `response_metadata` 上，
    // 由 AgentGraph 读取并跨轮累加。
    const cost = estimateCostUsd(response.usage_metadata, this.pricing);
    if (cost === undefined) return response;
    return new AIMessage({
      content: response.content,
      // N-6（docs/172）：与 DeepAgentLLMProvider 同因——重建时丢掉 `additional_kwargs`
      // 会把网关要求回传的 `reasoning_content` 一并丢掉。
      additional_kwargs: response.additional_kwargs,
      tool_calls: response.tool_calls,
      invalid_tool_calls: response.invalid_tool_calls,
      usage_metadata: response.usage_metadata,
      response_metadata: { ...response.response_metadata, estimatedCostUsd: cost }
    });
  }

  async *stream(messages: BaseMessage[], options?: LLMInvokeOptions): AsyncIterable<AIMessage> {
    yield await this.invoke(messages, options);
  }

  bindTools(tools: StructuredToolInterface[]): LLMProvider {
    if (!this.model.bindTools) {
      throw new Error("Configured LangChain chat model does not support bindTools");
    }

    return new LangChainLLMProvider(this.model.bindTools(tools), this.pricing);
  }
}

export function createOpenAIChatModel(options: OpenAILLMProviderOptions = {}): ChatOpenAI {
  const baseURL = options.baseUrl ?? process.env.OPENAI_BASE_URL;
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const defaultHeaders = options.defaultHeaders;
  const configuration = {
    ...openCodeGatewayConfiguration(baseURL, options.sessionId),
    ...(defaultHeaders ? { defaultHeaders: { ...defaultHeaders } } : {})
  };
  return new ChatOpenAI({
    model: options.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    apiKey,
    temperature: options.temperature ?? 0,
    ...(Object.keys(configuration).length > 0 ? { configuration } : {})
  });
}

export function messageContentToText(content: MessageContent): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if ("text" in block && typeof block.text === "string") {
        return block.text;
      }
      return JSON.stringify(block);
    })
    .join("");
}
