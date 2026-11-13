import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { StructuredToolInterface } from "@langchain/core/tools";
import { LLMInvokeOptions, LLMProvider } from "../llm/LLMProvider";

export interface ScriptedWorkflowTaskOptions {
  fail?: boolean;
  delayMs?: number;
  summary?: string;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Workflow task cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export class ScriptedWorkflowTaskLLMProvider implements LLMProvider {
  constructor(private readonly options: ScriptedWorkflowTaskOptions = {}) {}

  async invoke(_messages: BaseMessage[], options?: LLMInvokeOptions): Promise<AIMessage> {
    await delay(this.options.delayMs ?? 0, options?.signal);
    if (this.options.fail) throw new Error("Scripted workflow task failure");
    return new AIMessage(this.options.summary ?? "Workflow task completed successfully.");
  }

  async *stream(messages: BaseMessage[], options?: LLMInvokeOptions): AsyncIterable<AIMessage> {
    yield await this.invoke(messages, options);
  }

  bindTools(_tools: StructuredToolInterface[]): LLMProvider {
    return this;
  }
}
