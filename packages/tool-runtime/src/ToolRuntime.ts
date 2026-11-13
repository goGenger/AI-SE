import { sanitizeLogData } from "@ai-se/observability";
import { ApiErrorBody, JsonObject, ToolCallStatus } from "@ai-se/shared";
import { randomUUID } from "node:crypto";
import { ToolExecutionError, normalizeRuntimeError } from "./errors";
import { ToolAuditInfo, ToolDefinition, ToolExecutionContext, ToolResult } from "./types";

export interface ToolRuntimeOptions {
  tools: ToolDefinition<unknown, unknown>[];
}

const MAX_AUDIT_SUMMARY_LENGTH = 800;

function summarizeForAudit(value: unknown): JsonObject {
  const sanitized = sanitizeLogData(value);

  if (typeof sanitized === "string") {
    return { summary: sanitized.slice(0, MAX_AUDIT_SUMMARY_LENGTH) };
  }

  if (typeof sanitized === "object" && sanitized !== null) {
    const record = sanitized as Record<string, unknown>;
    const candidate =
      record.summary ?? record.stderr ?? record.stdout ?? record.diff ?? record.status;
    if (typeof candidate === "string" && candidate.trim()) {
      return { summary: candidate.trim().slice(0, MAX_AUDIT_SUMMARY_LENGTH) };
    }
  }

  try {
    return { summary: JSON.stringify(sanitized).slice(0, MAX_AUDIT_SUMMARY_LENGTH) };
  } catch {
    return { summary: "Unable to summarize value" };
  }
}

function statusFromResult(result: ToolResult): ToolCallStatus {
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

function errorBody(error: ToolResult["error"]): ApiErrorBody | undefined {
  if (!error) {
    return undefined;
  }

  return {
    code: error.code,
    message: error.message,
    details: error.details
  };
}

export class ToolRuntime {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();

  constructor(options: ToolRuntimeOptions) {
    for (const tool of options.tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`Duplicate tool registered: ${tool.name}`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  getToolDefinitions(): ToolDefinition<unknown, unknown>[] {
    return [...this.tools.values()];
  }

  async execute(
    toolName: string,
    input: unknown,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const toolCallId = context.toolCallId || randomUUID();
    const tool = this.tools.get(toolName);
    let startedRecorded = false;

    const recordStarted = async () => {
      await context.toolCallRecorder?.recordToolCallStarted({
        agentRunId: context.agentRunId,
        iteration: context.iteration ?? 0,
        toolCallId,
        toolName,
        input: summarizeForAudit(input),
        startedAt
      });
      startedRecorded = Boolean(context.toolCallRecorder);
    };

    const recordFinished = async (result: ToolResult) => {
      if (!startedRecorded) {
        return;
      }

      await context.toolCallRecorder?.recordToolCallFinished({
        agentRunId: context.agentRunId,
        toolCallId,
        output: result.success ? summarizeForAudit(result.data) : undefined,
        status: statusFromResult(result),
        error: errorBody(result.error),
        duration: result.duration,
        finishedAt: new Date(started + result.duration).toISOString()
      });
    };

    if (!tool) {
      await recordStarted();
      const result = this.createFailureResult(toolName, toolCallId, started, context, {
        code: "TOOL_ERROR",
        message: `Unknown tool: ${toolName}`
      });
      await recordFinished(result);
      return result;
    }

    const audit = this.createAudit(tool, context, toolCallId);
    context.logger?.info(sanitizeLogData({ audit }), "tool execution started");

    try {
      await recordStarted();

      if (context.signal?.aborted) {
        throw new ToolExecutionError("CANCELLED_ERROR", "Tool execution cancelled");
      }

      const parsed = tool.inputSchema.safeParse(input);
      if (!parsed.success) {
        throw new ToolExecutionError(
          "TOOL_ERROR",
          "Tool input validation failed",
          parsed.error.flatten()
        );
      }

      const data = await this.withTimeout(tool, parsed.data, { ...context, toolCallId });
      const result: ToolResult = {
        success: true,
        data,
        duration: Date.now() - started,
        toolName,
        toolCallId,
        audit
      };
      await recordFinished(result);
      context.logger?.info(sanitizeLogData(result), "tool execution finished");
      return result;
    } catch (error) {
      const normalized = normalizeRuntimeError(error, "SANDBOX_ERROR");
      const result = this.createFailureResult(
        toolName,
        toolCallId,
        started,
        context,
        normalized,
        audit
      );
      await recordFinished(result);
      context.logger?.warn(sanitizeLogData(result), "tool execution failed");
      return result;
    }
  }

  private async withTimeout<TInput>(
    tool: ToolDefinition<TInput, unknown>,
    input: TInput,
    context: ToolExecutionContext
  ): Promise<unknown> {
    if (!context.timeoutMs) {
      return await tool.execute(input, context);
    }

    const controller = new AbortController();
    const abortListener = () => controller.abort();
    context.signal?.addEventListener("abort", abortListener, { once: true });

    try {
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          controller.abort();
          reject(
            new ToolExecutionError("TIMEOUT_ERROR", "Tool execution timed out", {
              timeoutMs: context.timeoutMs
            })
          );
        }, context.timeoutMs);
        const abortListener = () => {
          controller.abort();
          reject(new ToolExecutionError("CANCELLED_ERROR", "Tool execution cancelled"));
        };

        context.signal?.addEventListener("abort", abortListener, { once: true });
        tool
          .execute(input, { ...context, signal: controller.signal })
          .then(resolve)
          .catch(reject)
          .finally(() => {
            clearTimeout(timer);
            context.signal?.removeEventListener("abort", abortListener);
          });
      });
    } finally {
      context.signal?.removeEventListener("abort", abortListener);
    }
  }

  private createAudit(
    tool: ToolDefinition<unknown, unknown>,
    context: ToolExecutionContext,
    toolCallId: string
  ): ToolAuditInfo {
    return {
      requestId: context.requestId,
      projectId: context.projectId,
      workflowRunId: context.workflowRunId,
      taskId: context.taskId,
      agentRunId: context.agentRunId,
      toolCallId,
      toolName: tool.name,
      riskLevel: tool.riskLevel,
      actor: context.actor
    };
  }

  private createFailureResult(
    toolName: string,
    toolCallId: string,
    started: number,
    context: ToolExecutionContext,
    error: ToolResult["error"],
    audit?: ToolAuditInfo
  ): ToolResult {
    const fallbackAudit: ToolAuditInfo = audit ?? {
      requestId: context.requestId,
      projectId: context.projectId,
      workflowRunId: context.workflowRunId,
      taskId: context.taskId,
      agentRunId: context.agentRunId,
      toolCallId,
      toolName,
      riskLevel: "LOW",
      actor: context.actor
    };

    return {
      success: false,
      error,
      duration: Date.now() - started,
      toolName,
      toolCallId,
      audit: fallbackAudit
    };
  }
}
