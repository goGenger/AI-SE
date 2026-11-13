import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  BaseChatModelCallOptions,
  BindToolsInput
} from "@langchain/core/language_models/chat_models";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import { Runnable } from "@langchain/core/runnables";
import { JsonObject } from "@ai-se/shared";
import { randomUUID } from "node:crypto";
import { ProfessionalOutcome } from "./types";

export interface ScriptedAgentStep {
  toolName: string;
  input: JsonObject;
}

export interface ScriptedDeepAgentModelOptions {
  steps?: ScriptedAgentStep[];
  outcome?: ProfessionalOutcome;
  delayMs?: number;
}

const DEFAULT_OUTCOME: ProfessionalOutcome = {
  status: "SUCCESS",
  summary: "Professional task completed successfully.",
  artifacts: [],
  issues: [],
  recommendations: [],
  metadata: {}
};

export class ScriptedDeepAgentModel extends BaseChatModel<BaseChatModelCallOptions> {
  static lc_name(): string {
    return "ChatOpenAI";
  }

  private index = 0;

  constructor(private readonly options: ScriptedDeepAgentModelOptions = {}) {
    super({});
  }

  _llmType(): string {
    return "ai-se-scripted-deep-agent";
  }

  bindTools(
    _tools: BindToolsInput[]
  ): Runnable<
    unknown,
    import("@langchain/core/messages").AIMessageChunk,
    BaseChatModelCallOptions
  > {
    return this as Runnable<
      unknown,
      import("@langchain/core/messages").AIMessageChunk,
      BaseChatModelCallOptions
    >;
  }

  async _generate(
    _messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    if (options.signal?.aborted) throw new Error("Professional Agent cancelled");
    if (this.options.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.options.delayMs);
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("Professional Agent cancelled"));
          },
          { once: true }
        );
      });
    }
    const step = this.options.steps?.[this.index];
    this.index += 1;
    const message = step
      ? new AIMessage({
          content: "",
          tool_calls: [
            { id: randomUUID(), name: step.toolName, args: step.input, type: "tool_call" }
          ]
        })
      : new AIMessage(JSON.stringify(this.options.outcome ?? DEFAULT_OUTCOME));
    return {
      generations: [{ text: typeof message.content === "string" ? message.content : "", message }]
    };
  }
}
