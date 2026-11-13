import { AgentRunStatus } from "@ai-se/shared";
import { NormalizedRuntimeError, ToolResult } from "@ai-se/tool-runtime";
import { BaseMessage } from "@langchain/core/messages";

export type { AgentRunStatus };

export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentState {
  messages: BaseMessage[];
  projectId?: string;
  taskId: string;
  agentRunId: string;
  iteration: number;
  status: AgentRunStatus;
  lastToolCall?: AgentToolCall;
  lastToolResult?: ToolResult;
  toolResults: ToolResult[];
  error?: NormalizedRuntimeError;
  metadata: Record<string, unknown>;
}

export function createInitialAgentState(input: {
  messages: BaseMessage[];
  projectId?: string;
  taskId: string;
  agentRunId: string;
  metadata?: Record<string, unknown>;
}): AgentState {
  return {
    messages: input.messages,
    projectId: input.projectId,
    taskId: input.taskId,
    agentRunId: input.agentRunId,
    iteration: 0,
    status: "running",
    toolResults: [],
    metadata: input.metadata ?? {}
  };
}
