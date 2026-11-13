import { sanitizeLogData } from "@ai-se/observability";
import { PROVIDER_UNAVAILABLE_REASON, QUOTA_EXHAUSTED_REASON } from "@ai-se/shared";
import {
  RuntimeErrorCode,
  ToolCallRecorder,
  ToolExecutionContext,
  ToolResult,
  ToolRuntime,
  normalizeRuntimeError
} from "@ai-se/tool-runtime";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolCall,
  ToolMessage
} from "@langchain/core/messages";
import { StructuredToolInterface, tool } from "@langchain/core/tools";
import {
  MAX_TOTAL_BACKOFF_MS,
  backoffDelayMs,
  classifyLlmFailure,
  isQuotaExhaustedMessage,
  sleepWithSignal
} from "../llm/retryBackoff";
import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
  messagesStateReducer
} from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentContext } from "../agent/AgentContext";
import { AgentLifecycleHooks } from "../agent/AgentLifecycle";
import { AgentState, AgentToolCall } from "../agent/AgentState";
import { LLMProvider } from "../llm/LLMProvider";
import { sumTokenUsage } from "../llm/usage";
import { messageContentToText } from "../llm/LangChainLLMProvider";

export interface AgentGraphOptions {
  llmProvider: LLMProvider;
  toolRuntime: ToolRuntime;
  systemPrompt: string;
  maxIterations: number;
  maxRetries: number;
  context: AgentContext;
  signal?: AbortSignal;
  lifecycle?: AgentLifecycleHooks;
  toolCallRecorder?: ToolCallRecorder;
  onRetry?: (error: unknown) => Promise<void>;
}

const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => []
  }),
  projectId: Annotation<string | undefined>(),
  taskId: Annotation<string>(),
  agentRunId: Annotation<string>(),
  iteration: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0
  }),
  status: Annotation<AgentState["status"]>({
    reducer: (_left, right) => right,
    default: () => "running"
  }),
  lastToolCall: Annotation<AgentToolCall | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  lastToolResult: Annotation<ToolResult | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  toolResults: Annotation<ToolResult[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  }),
  error: Annotation<AgentState["error"] | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  metadata: Annotation<Record<string, unknown>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({})
  })
});

type GraphState = typeof StateAnnotation.State;
type GraphUpdate = typeof StateAnnotation.Update;

export function createLangChainTools(runtime: ToolRuntime): StructuredToolInterface[] {
  return runtime.getToolDefinitions().map((definition) =>
    tool(
      async () => "Tool execution is handled by AI-SE ToolRuntime inside the LangGraph tools node.",
      {
        name: definition.name,
        description: definition.description,
        schema: definition.inputSchema as z.ZodObject<z.ZodRawShape>
      }
    )
  );
}

function getLastMessage(messages: BaseMessage[]): BaseMessage | undefined {
  return messages.at(-1);
}

/**
 * 空回复重问：模型（尤其 thinking 模型在长任务末尾）可能以"空内容、无工具调用"的消息
 * 结束；旧行为把它当作最终答案（succeeded + 空 finalAnswer），下游结果解析必然失败
 * （真实案例：frontend-agent 40 次工具调用后以空回复结束 → INVALID_AGENT_RESULT）。
 * 现在最多重问 MAX_EMPTY_FINAL_NUDGES 次；仍未产出文本才按原行为结束（交上游判定）。
 */
const EMPTY_FINAL_NUDGE =
  "Your previous reply contained no text. Reply with your final answer now.";
const MAX_EMPTY_FINAL_NUDGES = 2;

/**
 * 迭代预算将尽：强制收工提示（与空回复重问同形）。
 * 在最后 BUDGET_CONCLUDE_WITHIN 轮进入 agent 节点时注入一次，要求立刻 submit_result /
 * 输出结果 JSON，避免空转验证烧到 maxIterations / 墙钟超时仍无结果。
 * DeepAgent 路径常在单次 invoke 内跑完内层循环，外层可能看不到逐步 iteration——见 docs/251。
 */
const BUDGET_CONCLUDE_NUDGE =
  "Budget is nearly exhausted (iteration limit). Stop exploring and verifying. Call submit_result now (or reply with the result JSON) describing what is done and what remains. Do not run more tool loops.";
const BUDGET_CONCLUDE_WITHIN = 2;
const MAX_BUDGET_CONCLUDE_NUDGES = 1;

function getToolCalls(message: BaseMessage | undefined): ToolCall[] {
  if (!message || !AIMessage.isInstance(message)) {
    return [];
  }

  return message.tool_calls ?? [];
}

function normalizeToolArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return args ?? {};
}

function toolResultForModel(result: ToolResult): Record<string, unknown> {
  return sanitizeLogData({
    success: result.success,
    toolName: result.toolName,
    duration: result.duration,
    data: result.data,
    error: result.error
  }) as Record<string, unknown>;
}

function usageMetadata(response: AIMessage): Record<string, unknown> | undefined {
  const usage = response.usage_metadata;
  return typeof usage === "object" && usage !== null
    ? (usage as Record<string, unknown>)
    : undefined;
}

/**
 * PL-C2：成本由 provider 按价目算出并挂在 `response_metadata` 上（与既有的
 * `agentIterations` 同一手法）。未配置价目时 provider 不写该键 → 此处返回 `undefined`
 * → `agent_runs.estimated_cost` 维持 `NULL`（**不编造数字**）。
 */
function estimatedCostOf(response: AIMessage): number | undefined {
  const value = response.response_metadata?.estimatedCostUsd;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function responseIteration(response: AIMessage, fallback: number): number {
  const value = response.response_metadata?.agentIterations;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.max(fallback, value)
    : fallback;
}

async function invokeLLMWithRetry(
  provider: LLMProvider,
  messages: BaseMessage[],
  maxRetries: number,
  signal?: AbortSignal,
  onRetry?: (error: unknown) => Promise<void>
): Promise<AIMessage> {
  let attempt = 0;
  let totalBackoffMs = 0;
  let lastError: unknown;

  while (attempt <= maxRetries) {
    try {
      return await provider.invoke(messages, { signal });
    } catch (error) {
      lastError = error;
      attempt += 1;
      // 中止(超时/取消)不重试:再打一次只会浪费调用并把真实原因掩盖成 LLM_ERROR。
      if (attempt > maxRetries || signal?.aborted) {
        break;
      }
      // N-61（`docs/232` §10）：按失败类型决定要不要等、等多久。
      // 不可重试的（400/401/403/404 一类）直接短路——重试只会重复同一条错误，
      // 还会把配置/密钥问题拖成超时。
      const classification = classifyLlmFailure(lastError);
      if (!classification.retryable) {
        break;
      }
      const delayMs = backoffDelayMs(attempt, classification.retryAfterMs);
      // 累计退避不得吃掉整个 run 的预算：超限就如实放弃，而不是把时间全花在等待上。
      if (totalBackoffMs + delayMs > MAX_TOTAL_BACKOFF_MS) {
        break;
      }
      await onRetry?.(error);
      totalBackoffMs += delayMs;
      await sleepWithSignal(delayMs, signal);
      if (signal?.aborted) {
        break;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("LLM invocation failed");
}

function cancelledUpdate(): GraphUpdate {
  return {
    status: "cancelled",
    error: {
      code: "CANCELLED_ERROR",
      message: "Agent run cancelled"
    }
  };
}

function failureUpdate(
  code: RuntimeErrorCode,
  error: unknown,
  details?: Record<string, unknown>
): GraphUpdate {
  const normalized = normalizeRuntimeError(error, code);
  return {
    status: "failed",
    error: details ? { ...normalized, details } : normalized
  };
}

function toolEventStatus(result: ToolResult): "succeeded" | "failed" | "cancelled" | "timed_out" {
  if (result.success) {
    return "succeeded";
  }
  if (result.error?.code === "CANCELLED_ERROR") {
    return "cancelled";
  }
  if (result.error?.code === "TIMEOUT_ERROR") {
    return "timed_out";
  }
  return "failed";
}

export function createAgentGraph(options: AgentGraphOptions) {
  const langChainTools = createLangChainTools(options.toolRuntime);
  const llmWithTools = options.llmProvider.bindTools(langChainTools);
  let emptyFinalNudges = 0;
  let budgetConcludeNudges = 0;

  async function agentNode(state: GraphState): Promise<GraphUpdate> {
    if (options.signal?.aborted) {
      return cancelledUpdate();
    }

    if (state.iteration >= options.maxIterations) {
      return {
        status: "failed",
        error: {
          code: "TOOL_ERROR",
          message: "Agent reached max iterations",
          details: { maxIterations: options.maxIterations }
        }
      };
    }

    try {
      const nearBudget =
        state.iteration >= Math.max(0, options.maxIterations - BUDGET_CONCLUDE_WITHIN);
      const nudgeBudgetConclude =
        nearBudget && budgetConcludeNudges < MAX_BUDGET_CONCLUDE_NUDGES;
      if (nudgeBudgetConclude) {
        budgetConcludeNudges += 1;
      }
      const messages = [
        new SystemMessage(options.systemPrompt),
        ...state.messages,
        ...(nudgeBudgetConclude ? [new HumanMessage(BUDGET_CONCLUDE_NUDGE)] : [])
      ];
      if (nudgeBudgetConclude) {
        await options.lifecycle?.onEvent?.({
          agentRunId: options.context.agentRunId,
          eventType: "agent_action",
          payload: {
            iteration: state.iteration,
            action: "budget_conclude_nudge",
            status: "running",
            maxIterations: options.maxIterations
          }
        });
      }
      const response = await invokeLLMWithRetry(
        llmWithTools,
        messages,
        options.maxRetries,
        options.signal,
        options.onRetry
      );
      const toolCalls = getToolCalls(response);
      const nextIteration = responseIteration(response, state.iteration + 1);
      const responseText = messageContentToText(response.content).trim();
      const nudgeEmptyFinal =
        toolCalls.length === 0 && responseText === "" && emptyFinalNudges < MAX_EMPTY_FINAL_NUDGES;
      if (nudgeEmptyFinal) {
        emptyFinalNudges += 1;
      }
      const status = toolCalls.length > 0 || nudgeEmptyFinal ? "running" : "succeeded";

      await options.lifecycle?.onIteration?.({
        agentRunId: options.context.agentRunId,
        iteration: nextIteration,
        status
      });
      await options.lifecycle?.onEvent?.({
        agentRunId: options.context.agentRunId,
        eventType: toolCalls.length > 0 || nudgeEmptyFinal ? "agent_action" : "agent_final",
        payload: {
          iteration: nextIteration,
          action:
            toolCalls.length > 0
              ? "tool_call_requested"
              : nudgeEmptyFinal
                ? "empty_reply_retry"
                : "final_answer",
          tools: toolCalls.map((toolCall) => toolCall.name),
          status
        }
      });

      const usage = usageMetadata(response);
      const callCost = estimatedCostOf(response);
      const metadata: Record<string, unknown> = {};
      if (usage) {
        metadata.tokenUsage = sumTokenUsage(state.metadata.tokenUsage, usage);
      }
      if (callCost !== undefined) {
        const priorCost =
          typeof state.metadata.estimatedCost === "number" ? state.metadata.estimatedCost : 0;
        metadata.estimatedCost = priorCost + callCost;
      }

      return {
        messages: nudgeEmptyFinal ? [response, new HumanMessage(EMPTY_FINAL_NUDGE)] : [response],
        iteration: nextIteration,
        status,
        metadata
      };
    } catch (error) {
      if (options.signal?.aborted) {
        return cancelledUpdate();
      }
      // N-61（`docs/232` §10）：可重试类失败（429 / 5xx / 网络）在**重试耗尽后**意味着
      // 「上游不可用」，不是「任务做错了」。不新增 `RuntimeErrorCode`（`AGENTS.md` §10），
      // 把区分信息放在既有码的 `details` 上，供归因与后续的重规划策略使用。
      const classification = classifyLlmFailure(error);
      // Prefer the same text surface classifyLlmFailure saw (message + cause).
      const quotaExhausted =
        !classification.retryable &&
        classification.kind === "not-retryable" &&
        isQuotaExhaustedMessage(
          [error instanceof Error ? error.message : String(error ?? "")]
            .concat(
              error instanceof Error && error.cause instanceof Error ? [error.cause.message] : []
            )
            .join("\n")
        );
      return failureUpdate(
        "LLM_ERROR",
        error,
        classification.retryable
          ? { reason: PROVIDER_UNAVAILABLE_REASON, kind: classification.kind }
          : quotaExhausted
            ? { reason: QUOTA_EXHAUSTED_REASON, kind: classification.kind }
            : undefined
      );
    }
  }

  async function toolsNode(state: GraphState): Promise<GraphUpdate> {
    if (options.signal?.aborted) {
      return cancelledUpdate();
    }

    const toolCalls = getToolCalls(getLastMessage(state.messages));
    const toolMessages: ToolMessage[] = [];
    const toolResults: ToolResult[] = [];
    let lastToolCall: AgentToolCall | undefined;
    let lastToolResult: ToolResult | undefined;

    for (const toolCall of toolCalls) {
      const toolCallId = toolCall.id ?? randomUUID();
      lastToolCall = {
        id: toolCallId,
        name: toolCall.name,
        args: normalizeToolArgs(toolCall.args)
      };

      const toolContext: ToolExecutionContext = {
        ...options.context,
        toolCallId,
        iteration: state.iteration,
        toolCallRecorder: options.toolCallRecorder,
        signal: options.signal
      };
      await options.lifecycle?.onEvent?.({
        agentRunId: options.context.agentRunId,
        eventType: "tool_call_started",
        payload: {
          iteration: state.iteration,
          toolCallId,
          toolName: toolCall.name,
          status: "running"
        }
      });
      const result = await options.toolRuntime.execute(
        toolCall.name,
        normalizeToolArgs(toolCall.args),
        toolContext
      );
      await options.lifecycle?.onEvent?.({
        agentRunId: options.context.agentRunId,
        eventType: "tool_call_finished",
        payload: {
          iteration: state.iteration,
          toolCallId,
          toolName: toolCall.name,
          status: toolEventStatus(result),
          duration: result.duration,
          errorCode: result.error?.code
        }
      });

      lastToolResult = result;
      toolResults.push(result);
      toolMessages.push(
        new ToolMessage({
          content: JSON.stringify(toolResultForModel(result)),
          tool_call_id: toolCallId,
          status: result.success ? "success" : "error",
          metadata: {
            toolName: toolCall.name,
            success: result.success
          }
        })
      );
    }

    return {
      messages: toolMessages,
      lastToolCall,
      lastToolResult,
      toolResults
    };
  }

  function shouldContinue(state: GraphState): "tools" | typeof END {
    if (state.status === "cancelled" || state.status === "failed" || state.status === "succeeded") {
      return END;
    }

    const last = getLastMessage(state.messages);
    // 空回复重问：循环提示以 HumanMessage 追加 → 经 tools 节点空转回到 agent。
    if (HumanMessage.isInstance(last)) {
      return "tools";
    }

    return getToolCalls(last).length > 0 ? "tools" : END;
  }

  return new StateGraph(StateAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", shouldContinue, ["tools", END])
    .addEdge("tools", "agent")
    .compile({ checkpointer: new MemorySaver() });
}

export function createHumanTaskMessage(task: string): HumanMessage {
  return new HumanMessage(task);
}

export function finalAnswerFromMessages(messages: BaseMessage[]): string {
  const finalMessage = [...messages].reverse().find((message) => AIMessage.isInstance(message));
  return finalMessage && AIMessage.isInstance(finalMessage)
    ? messageContentToText(finalMessage.content)
    : "";
}
