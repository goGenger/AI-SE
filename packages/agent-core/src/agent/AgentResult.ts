import { JsonObject } from "@ai-se/shared";
import { NormalizedRuntimeError, ToolResult } from "@ai-se/tool-runtime";
import { AgentRunStatus } from "./AgentState";
import { ProfessionalOutcome } from "../professional/types";

export interface AgentResult {
  agentRunId: string;
  taskId: string;
  projectId?: string;
  status: AgentRunStatus;
  iterations: number;
  retryCount: number;
  finalAnswer: string;
  toolResults: ToolResult[];
  error?: NormalizedRuntimeError;
  tokenUsage?: JsonObject;
  estimatedCost?: number;
  startedAt: string;
  finishedAt: string;
  duration: number;
  metadata: Record<string, unknown>;
  professionalResult?: ProfessionalOutcome;
}
