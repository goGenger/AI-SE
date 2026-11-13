import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { StructuredToolInterface } from "@langchain/core/tools";

export interface LLMProvider {
  invoke(messages: BaseMessage[], options?: LLMInvokeOptions): Promise<AIMessage>;
  stream(messages: BaseMessage[], options?: LLMInvokeOptions): AsyncIterable<AIMessage>;
  bindTools(tools: StructuredToolInterface[]): LLMProvider;
}

export interface LLMInvokeOptions {
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}
