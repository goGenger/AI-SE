import { AgentContext } from "./AgentContext";
import { AgentResult } from "./AgentResult";

export interface Agent {
  name: string;
  run(task: string, context: AgentContext, options?: AgentRunOptions): Promise<AgentResult>;
}

export interface AgentRunOptions {
  maxIterations?: number;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}
