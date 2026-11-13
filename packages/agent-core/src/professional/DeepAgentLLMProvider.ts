import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { BaseLanguageModel } from "@langchain/core/language_models/base";
import { StructuredToolInterface } from "@langchain/core/tools";
import { createDeepAgent, registerHarnessProfile } from "deepagents";
import { LLMInvokeOptions, LLMProvider } from "../llm/LLMProvider";
import { estimateCostUsd, ModelPricing, totalTokenUsage } from "../llm/usage";
import { createAbortTerminationMiddleware } from "./abortTermination";
import { AgentDefinition } from "./AgentRegistry";
import { captureSubmittedOutcome, createSubmitResultTerminationMiddleware } from "./submitResult";
import { ToolRuntimeBackend } from "./ToolRuntimeBackend";
import { withUntrustedInputClause } from "./untrustedInput";

let configured = false;

function configureHarness(): void {
  if (configured) return;
  configured = true;
  registerHarnessProfile("openai", {
    excludedTools: ["task", "execute", "delete", "glob"],
    generalPurposeSubagent: { enabled: false }
  });
}

function finalMessage(value: unknown): AIMessage {
  if (typeof value !== "object" || value === null || !("messages" in value)) {
    throw new Error("Deep Agent did not return messages");
  }
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) throw new Error("Deep Agent messages are invalid");
  const result = [...messages].reverse().find((message) => AIMessage.isInstance(message));
  if (!result || !AIMessage.isInstance(result))
    throw new Error("Deep Agent returned no final answer");
  return result;
}

/**
 * PL-C2：内层循环**全部** AIMessage 的 `usage_metadata`（整轮用量的求和输入）。
 * 取 `messages` 而非只取 `finalMessage` —— 后者只是最后一次调用。
 *
 * PL-M15（N-8）：**必须剔除调用方传进来的那些消息**。外层图每轮把 provider 上一轮交回的
 * AIMessage 回灌进 `messages`（`AgentGraph.agentNode` 的 `messages: [response]`），而内层
 * deep agent 的 `result.messages` 会**按同引用**把这条消息带回来——它身上的
 * `usage_metadata` 是**上一轮的累计值**。不剔除就是复利：实测
 * `T(n) = sum_{k<n} T(k) + 本轮用量`，即每轮翻倍（探针 `scripts/probe-usage-compounding.ts`：
 * 49 轮 → 5.6e17，与生产坏值同量级；`docs/176` / `docs/177`）。
 */
function innerProducedAIMessages(value: unknown, carried: ReadonlySet<BaseMessage>): AIMessage[] {
  if (typeof value !== "object" || value === null || !("messages" in value)) return [];
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (message): message is AIMessage => AIMessage.isInstance(message) && !carried.has(message)
  );
}

/**
 * PL-M16（N-9）：交回外层的消息**不得再带工具调用**。
 *
 * 内层 deep agent 已经通过同一个 ToolRuntime 执行过它请求的每一个工具，外层 `AgentGraph`
 * 的 tools 节点再执行一次就是**重复执行**。而生产的 `ChatOpenAI` 把工具调用放在
 * `additional_kwargs.tool_calls` 里（探针实测每轮 `additionalKwargKeys = function_call,tool_calls`），
 * 重建消息时若原样带回，`AIMessage` 就会派生出 `tool_calls`，`shouldContinue` 于是回到 tools
 * 节点——而内层每轮又被终止中间件直接 `jumpTo end`（**零模型调用**），于是空转到
 * `maxIterations` 守卫。L1-M4g run 1 实测：44 轮 / 1.2 秒 / 零模型调用 / `TOOL_ERROR`，
 * 任务自报 `outcome: SUCCESS` 仍判 FAILED。探针 `scripts/probe-outer-loop-spin.ts` 场景 A/B
 * 复现并验证了本修复。
 *
 * **只剔除 `tool_calls` 这一个键**：`additional_kwargs` 的其余键必须原样保留，那是 N-6 的
 * `reasoning_content` 的载体（`docs/172`，`DeepAgentLLMProvider.test.ts` 有钉住它的用例）。
 */
function withoutToolCalls(
  additionalKwargs: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!additionalKwargs) return {};
  const { tool_calls: _dropped, ...rest } = additionalKwargs;
  return rest;
}

export class DeepAgentLLMProvider implements LLMProvider {
  constructor(
    private readonly model: BaseLanguageModel,
    private readonly definition: AgentDefinition,
    private readonly backend: ToolRuntimeBackend,
    /** T2：结构化提交工具名；设置后启用「提交即终止」中间件与结果摘要回填。 */
    private readonly outcomeTool?: string,
    /** PL-C2：价目；未配置 → 不产出成本（`agent_runs.estimated_cost` 维持 NULL）。 */
    private readonly pricing?: ModelPricing
  ) {
    configureHarness();
  }

  async invoke(messages: BaseMessage[], options?: LLMInvokeOptions): Promise<AIMessage> {
    const middleware = [
      createAbortTerminationMiddleware(options?.signal),
      ...(this.outcomeTool ? [createSubmitResultTerminationMiddleware(this.outcomeTool)] : [])
    ];
    const agent = createDeepAgent({
      name: this.definition.name,
      model: this.model,
      backend: this.backend,
      tools: this.backend.createCustomTools(),
      systemPrompt: withUntrustedInputClause(this.definition.systemInstructions),
      checkpointer: false,
      subagents: [],
      middleware
    });
    const result = await agent.invoke(
      { messages },
      { signal: options?.signal, configurable: { thread_id: this.backend.id } }
    );
    const message = finalMessage(result);
    // T2：submit_result 被接受后，以提交结果摘要作为最终回答——空文本的提交消息
    // 不再触发图层「空回复重问」，finalAnswer 直接反映提交结果。
    const submitted = captureSubmittedOutcome(this.backend.toolResults, this.outcomeTool);
    // PL-C2：内层 deep agent 跑了很多轮 LLM 调用，`finalMessage` 只给最后一条——它的
    // `usage_metadata` 只是**最后一次调用**的用量。整轮用量要把全部 AIMessage 加起来。
    // PL-M15（N-8）：只加**本轮自产**的那些，调用方回灌进来的不计（见 innerProducedAIMessages）。
    const usage = totalTokenUsage(
      innerProducedAIMessages(result, new Set(messages)).map((message) => message.usage_metadata)
    );
    const cost = estimateCostUsd(usage, this.pricing);
    return new AIMessage({
      content: submitted ? submitted.summary : message.content,
      // N-6（docs/172）：必须原样带回 `additional_kwargs`。网关在 thinking 模式下要求
      // assistant 消息回传 `reasoning_content`，而依赖补丁只在消息自身携带该字段时才发它
      // ——这里重建消息时丢掉它，等于把补丁废掉（探针实测：丢掉后下一轮请求 reasoning=ABSENT）。
      // PL-M16（N-9）：只剔除其中的 `tool_calls`——内层已经执行过它们，交回外层会让图重复执行
      // 并空转到守卫（见 withoutToolCalls）。**其余键一个不动**，N-6 的修复必须原样成立。
      additional_kwargs: withoutToolCalls(message.additional_kwargs),
      // 求和结果的形状就是 `usage_metadata` 的形状（逐字段累加自真实的 `usage_metadata`）。
      usage_metadata: (usage ?? message.usage_metadata) as AIMessage["usage_metadata"],
      response_metadata: {
        ...message.response_metadata,
        agentIterations: this.backend.iterations,
        ...(cost !== undefined ? { estimatedCostUsd: cost } : {})
      }
    });
  }

  async *stream(messages: BaseMessage[], options?: LLMInvokeOptions): AsyncIterable<AIMessage> {
    yield await this.invoke(messages, options);
  }

  bindTools(_tools: StructuredToolInterface[]): LLMProvider {
    return this;
  }
}
