import { ApiErrorBody, JsonObject } from "@ai-se/shared";
import { ToolCallRecorder, ToolExecutionError, normalizeRuntimeError } from "@ai-se/tool-runtime";
import { createInitialAgentState } from "./AgentState";
import { AgentContext } from "./AgentContext";
import { AgentLifecycleHooks } from "./AgentLifecycle";
import { AgentResult } from "./AgentResult";
import { LLMProvider } from "../llm/LLMProvider";
import { ToolRuntime } from "@ai-se/tool-runtime";
import {
  createAgentGraph,
  createHumanTaskMessage,
  finalAnswerFromMessages
} from "../graph/AgentGraph";

export interface AgentRunnerOptions {
  llmProvider: LLMProvider;
  toolRuntime: ToolRuntime;
  systemPrompt: string;
  defaultMaxIterations?: number;
  defaultTimeoutMs?: number;
  defaultMaxRetries?: number;
  lifecycle?: AgentLifecycleHooks;
  toolCallRecorder?: ToolCallRecorder;
}

export interface AgentRunnerRunOptions {
  maxIterations?: number;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

function mergeSignals(
  parentSignal: AbortSignal | undefined,
  controller: AbortController
): AbortSignal {
  if (!parentSignal) {
    return controller.signal;
  }

  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return controller.signal;
}

function errorBody(error: ReturnType<typeof normalizeRuntimeError>): ApiErrorBody {
  return {
    code: error.code,
    message: error.message,
    details: error.details
  };
}

function optionalJsonObject(value: unknown): JsonObject | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * N-7（docs/174）：外层图是 `agent` ↔ `tools` 的两节点环，**每轮迭代消耗 2 个 LangGraph 超步**。
 * 不传 `recursionLimit` 时 LangGraph 用默认值 25（`@langchain/langgraph` 的
 * `DEFAULT_RECURSION_LIMIT`），图会在约 12 轮就被框架掐断——**平台自己的
 * `maxIterations` 守卫永远等不到**，而且报出来的是框架的 `UNKNOWN_ERROR` 而不是平台的
 * `TOOL_ERROR`。所以上限必须由 `maxIterations` 推导，让平台的守卫成为真正生效的那一个。
 *
 * 取 `* 2 + 4`：2 是每轮的超步数，余量覆盖 `START`、终态那一步，以及将来万一多出一个节点。
 * 探针实测（`scripts/probe-agent-recursion-limit.ts`，`maxIterations=50`）走到平台守卫需要
 * **101** 个超步，即最坏情形为 `2 * maxIterations + 1`；取 `+4` 留 3 步余量。宁可宽不可窄
 * ——窄了就退化成「换个数字的同一个缺陷」，且失败模式是**悄悄退回**框架的 `UNKNOWN_ERROR`。
 */
export function recursionLimitFor(maxIterations: number): number {
  return maxIterations * 2 + 4;
}

function resultOutput(
  result: Pick<AgentResult, "finalAnswer" | "status" | "toolResults">
): JsonObject {
  return {
    finalResult: result.finalAnswer,
    status: result.status,
    toolCallCount: result.toolResults.length
  };
}

export class AgentRunner {
  constructor(private readonly options: AgentRunnerOptions) {}

  async run(
    task: string,
    context: AgentContext,
    runOptions: AgentRunnerRunOptions = {}
  ): Promise<AgentResult> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const timeoutMs = runOptions.timeoutMs ?? this.options.defaultTimeoutMs ?? 120_000;
    const maxIterations = runOptions.maxIterations ?? this.options.defaultMaxIterations ?? 12;
    const maxRetries = runOptions.maxRetries ?? this.options.defaultMaxRetries ?? 1;
    const controller = new AbortController();
    const signal = mergeSignals(runOptions.signal, controller);
    const lifecycle = this.options.lifecycle;
    let retryCount = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      if (signal.aborted) {
        throw new ToolExecutionError("CANCELLED_ERROR", "Agent run cancelled");
      }

      await lifecycle?.onRunStarted?.({
        agentRunId: context.agentRunId,
        taskId: context.taskId,
        projectId: context.projectId,
        startedAt,
        maxIterations
      });
      await lifecycle?.onEvent?.({
        agentRunId: context.agentRunId,
        eventType: "agent_run_started",
        payload: { taskId: context.taskId, projectId: context.projectId, maxIterations }
      });

      const graph = createAgentGraph({
        llmProvider: this.options.llmProvider,
        toolRuntime: this.options.toolRuntime,
        systemPrompt: this.options.systemPrompt,
        maxIterations,
        maxRetries,
        context,
        signal,
        lifecycle,
        toolCallRecorder: this.options.toolCallRecorder,
        onRetry: async (error) => {
          retryCount += 1;
          const normalized = normalizeRuntimeError(error, "LLM_ERROR");
          await lifecycle?.onRetry?.({
            agentRunId: context.agentRunId,
            retryCount,
            error: errorBody(normalized)
          });
          await lifecycle?.onEvent?.({
            agentRunId: context.agentRunId,
            eventType: "llm_retry",
            payload: {
              retryCount,
              errorCode: normalized.code,
              message: normalized.message
            }
          });
        }
      });

      const state = createInitialAgentState({
        messages: [createHumanTaskMessage(task)],
        projectId: context.projectId,
        taskId: context.taskId,
        agentRunId: context.agentRunId,
        metadata: context.metadata
      });
      const finalState = await graph.invoke(state, {
        // N-7（docs/174）：见 recursionLimitFor 的说明。少了这一行，图会撞 LangGraph 的默认上限 25。
        recursionLimit: recursionLimitFor(maxIterations),
        configurable: { thread_id: context.agentRunId }
      });
      const finished = Date.now();
      const finishedAt = new Date(finished).toISOString();
      const timeoutError = timedOut
        ? {
            code: "TIMEOUT_ERROR" as const,
            message: "Agent run timed out",
            details: { timeoutMs }
          }
        : undefined;
      const result: AgentResult = {
        agentRunId: context.agentRunId,
        taskId: context.taskId,
        projectId: context.projectId,
        status: timedOut ? "timed_out" : finalState.status,
        iterations: finalState.iteration,
        retryCount,
        finalAnswer: finalAnswerFromMessages(finalState.messages),
        toolResults: finalState.toolResults,
        error: timeoutError ?? finalState.error,
        tokenUsage: optionalJsonObject(finalState.metadata.tokenUsage),
        estimatedCost: optionalNumber(finalState.metadata.estimatedCost),
        startedAt,
        finishedAt,
        duration: finished - started,
        metadata: finalState.metadata
      };
      await lifecycle?.onRunFinished?.({
        agentRunId: context.agentRunId,
        status: result.status,
        output: resultOutput(result),
        currentIteration: result.iterations,
        retryCount,
        error: result.error ? errorBody(result.error) : undefined,
        tokenUsage: result.tokenUsage,
        estimatedCost: result.estimatedCost,
        finishedAt
      });
      await lifecycle?.onEvent?.({
        agentRunId: context.agentRunId,
        eventType: "agent_run_finished",
        payload: {
          status: result.status,
          currentIteration: result.iterations,
          retryCount,
          errorCode: result.error?.code
        }
      });
      return result;
    } catch (error) {
      const finished = Date.now();
      const isTimeout = signal.aborted && !runOptions.signal?.aborted;
      const normalized = normalizeRuntimeError(
        error,
        isTimeout ? "TIMEOUT_ERROR" : "UNKNOWN_ERROR"
      );
      const finishedAt = new Date(finished).toISOString();
      const status =
        normalized.code === "CANCELLED_ERROR"
          ? "cancelled"
          : normalized.code === "TIMEOUT_ERROR"
            ? "timed_out"
            : "failed";
      const result: AgentResult = {
        agentRunId: context.agentRunId,
        taskId: context.taskId,
        projectId: context.projectId,
        status,
        iterations: 0,
        retryCount,
        finalAnswer: "",
        toolResults: [],
        error: normalized,
        startedAt,
        finishedAt,
        duration: finished - started,
        metadata: context.metadata ?? {}
      };
      await lifecycle?.onRunFinished?.({
        agentRunId: context.agentRunId,
        status,
        output: resultOutput(result),
        currentIteration: result.iterations,
        retryCount,
        error: errorBody(normalized),
        finishedAt
      });
      await lifecycle?.onEvent?.({
        agentRunId: context.agentRunId,
        eventType: "agent_run_finished",
        payload: {
          status,
          currentIteration: result.iterations,
          retryCount,
          errorCode: normalized.code
        }
      });
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
}
