import { AgentRunStatus, ApiErrorBody, JsonObject } from "@ai-se/shared";

export interface AgentRunStartedRecord {
  agentRunId: string;
  taskId: string;
  projectId?: string;
  startedAt: string;
  maxIterations: number;
}

export interface AgentRunIterationRecord {
  agentRunId: string;
  iteration: number;
  status: AgentRunStatus;
}

export interface AgentRunRetryRecord {
  agentRunId: string;
  retryCount: number;
  error: ApiErrorBody;
}

export interface AgentRunFinishedRecord {
  agentRunId: string;
  status: AgentRunStatus;
  output: JsonObject;
  currentIteration: number;
  retryCount: number;
  error?: ApiErrorBody;
  tokenUsage?: JsonObject;
  estimatedCost?: number;
  finishedAt: string;
}

export interface AgentWorkflowEventRecord {
  agentRunId: string;
  eventType: string;
  payload: JsonObject;
}

export interface AgentLifecycleHooks {
  onRunStarted?(record: AgentRunStartedRecord): Promise<void>;
  onIteration?(record: AgentRunIterationRecord): Promise<void>;
  onRetry?(record: AgentRunRetryRecord): Promise<void>;
  onRunFinished?(record: AgentRunFinishedRecord): Promise<void>;
  onEvent?(record: AgentWorkflowEventRecord): Promise<void>;
}
