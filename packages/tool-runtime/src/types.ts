import { Sandbox } from "@ai-se/sandbox";
import { ApiErrorBody, JsonObject, ToolCallStatus } from "@ai-se/shared";
import { Logger } from "pino";
import { z } from "zod";
import { NormalizedRuntimeError } from "./errors";

export type ToolRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ToolAuditInfo {
  requestId: string;
  projectId?: string;
  /** 7-A：所属工作流运行（工作流外的单次运行没有此字段）。 */
  workflowRunId?: string;
  taskId: string;
  agentRunId: string;
  toolCallId: string;
  toolName: string;
  riskLevel: ToolRiskLevel;
  actor: string;
}

export interface ToolExecutionContext {
  requestId: string;
  projectId?: string;
  /** 7-A：所属工作流运行；用于把工具日志与 `tool_calls` 行关联回工作流。 */
  workflowRunId?: string;
  taskId: string;
  agentRunId: string;
  toolCallId: string;
  iteration?: number;
  actor: string;
  workspacePath: string;
  sandbox: Sandbox;
  /**
   * `docs/236` §4.2：这个运行**允许**装依赖出网。
   *
   * 由平台按项目/夹具的声明决定（第 4 步），agent 侧没有任何入口能设置它——`run_command`
   * 之类的入参 schema 里没有网络字段。缺省 `false` ⇒ 与之前行为完全一致。
   *
   * 注意它是**能力上限**而不是开关：置真时也只有被判为 install 的命令拿 `registry`，
   * build / test / 任意 shell 仍然无网。
   */
  dependencyInstallAllowed?: boolean;
  logger?: Logger;
  timeoutMs?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  toolCallRecorder?: ToolCallRecorder;
}

export interface ToolResult<TData = unknown> {
  success: boolean;
  data?: TData;
  error?: NormalizedRuntimeError;
  duration: number;
  toolName: string;
  toolCallId: string;
  audit: ToolAuditInfo;
}

export interface ToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  riskLevel: ToolRiskLevel;
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

export interface ToolCallStartedRecord {
  agentRunId: string;
  iteration: number;
  toolCallId: string;
  toolName: string;
  input: JsonObject;
  startedAt: string;
}

export interface ToolCallFinishedRecord {
  agentRunId: string;
  toolCallId: string;
  output?: JsonObject;
  status: ToolCallStatus;
  error?: ApiErrorBody;
  duration: number;
  finishedAt: string;
}

export interface ToolCallRecorder {
  recordToolCallStarted(record: ToolCallStartedRecord): Promise<void>;
  recordToolCallFinished(record: ToolCallFinishedRecord): Promise<void>;
}
