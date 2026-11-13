import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { OutputParserException } from "@langchain/core/output_parsers";
import type { LLMResult } from "@langchain/core/outputs";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { JsonObject } from "@ai-se/shared";
import { openCodeGatewayConfiguration } from "../llm/LangChainLLMProvider";
import { PlanningModel, PlanningModelRequest } from "./PlanningModel";
import {
  isMultimodalUnsupportedError,
  isOpenCodePlanningEndpoint
} from "./describeUiReferences";

/**
 * N-25 (docs/206): pull `usage_metadata` off the chat message of a finished LLM call.
 * Shape matches `agent_runs.token_usage` (input_tokens / output_tokens / total_tokens + details).
 */
function usageFromLLMResult(result: LLMResult): JsonObject | undefined {
  const generation = result.generations?.[0]?.[0] as
    | { message?: { usage_metadata?: unknown } }
    | undefined;
  const usage = generation?.message?.usage_metadata;
  if (typeof usage === "object" && usage !== null && !Array.isArray(usage)) {
    return usage as JsonObject;
  }
  return undefined;
}

export type PlanningStructuredOutputMethod = "jsonSchema" | "functionCalling" | "jsonMode";

/**
 * Thinking models occasionally emit malformed JSON (e.g. a missing closing
 * bracket) that the structured-output parser rejects. Each planning stage is a
 * fresh sample, so a bounded re-sample resolves these without masking real
 * errors. Domain-level validation errors keep their existing repair flow.
 */
const STRUCTURED_OUTPUT_ATTEMPTS = 3;

export interface LangChainPlanningModelOptions {
  model?: string;
  apiKey?: string;
  temperature?: number;
  /** OpenAI-compatible endpoint override (e.g. DeepSeek). Falls back to OPENAI_BASE_URL. */
  baseUrl?: string;
  /**
   * Structured-output strategy for the planning stages.
   * Default (unset) keeps the provider-agnostic `jsonSchema` path; endpoints
   * without `response_format: json_schema` support (e.g. DeepSeek) use
   * `functionCalling` (strict tool calling) or `jsonMode`.
   */
  structuredOutputMethod?: PlanningStructuredOutputMethod;
  /** OpenCode Go 网关的会话 ID（x-opencode-session）；仅当端点指向 opencode 时注入。 */
  sessionId?: string;
  /**
   * Whether to attach UI reference base64 as OpenAI image_url parts.
   * Default: false on OpenCode/atlas (multimodal rejected); true elsewhere.
   * Prefer describeUiReferencesForPlanning → text notes before planning.
   */
  attachUiReferenceImages?: boolean;
}

export class LangChainPlanningModel implements PlanningModel {
  private readonly model: ChatOpenAI;
  private readonly structuredOutputMethod?: PlanningStructuredOutputMethod;
  private readonly attachUiReferenceImages: boolean;

  constructor(options: LangChainPlanningModelOptions = {}) {
    this.structuredOutputMethod = options.structuredOutputMethod;
    const baseURL = options.baseUrl ?? process.env.OPENAI_BASE_URL;
    const configuration = openCodeGatewayConfiguration(baseURL, options.sessionId);
    this.attachUiReferenceImages =
      options.attachUiReferenceImages ?? !isOpenCodePlanningEndpoint(baseURL);
    this.model = new ChatOpenAI({
      model: options.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
      temperature: options.temperature ?? 0,
      ...(Object.keys(configuration).length > 0 ? { configuration } : {})
    });
  }

  async generateStructured<TOutput extends JsonObject>(
    request: PlanningModelRequest<TOutput>
  ): Promise<unknown> {
    try {
      return await this.invokeStructured(request, this.attachUiReferenceImages);
    } catch (error) {
      // Atlas/OpenCode rejects multimodal image_url; fall back to text-only notes once.
      if (
        this.attachUiReferenceImages &&
        hasUiReferenceImages(request.input) &&
        isMultimodalUnsupportedError(error)
      ) {
        return await this.invokeStructured(request, false);
      }
      throw error;
    }
  }

  private async invokeStructured<TOutput extends JsonObject>(
    request: PlanningModelRequest<TOutput>,
    attachImages: boolean
  ): Promise<unknown> {
    const structured = this.model.withStructuredOutput<TOutput>(request.schema, {
      name: request.stage,
      // Strict adherence is kept only on the default jsonSchema path:
      // - jsonMode rejects `strict` outright (library validation);
      // - the functionCalling tool conversion does not apply the strict-schema
      //   transforms (additionalProperties/required) that both OpenAI and
      //   DeepSeek demand when a tool is declared strict:true.
      ...(this.structuredOutputMethod && this.structuredOutputMethod !== "jsonSchema"
        ? {}
        : { strict: true }),
      ...(this.structuredOutputMethod ? { method: this.structuredOutputMethod } : {})
    });
    const messages: BaseMessage[] = [
      new SystemMessage(this.systemPrompt(request)),
      this.buildHumanMessage(request, attachImages)
    ];

    // N-25 (docs/206): usage is reported through a callback, not the return value. A parse
    // failure throws an OutputParserException that carries only the raw string, so a
    // return-value design would lose every resampled attempt. handleLLMEnd fires as soon as
    // the model call completes, before any parsing happens.
    const onUsage = request.onUsage;
    const callbacks = onUsage
      ? [
          {
            handleLLMEnd: async (output: LLMResult): Promise<void> => {
              const usage = usageFromLLMResult(output);
              if (usage) onUsage(usage);
            }
          }
        ]
      : undefined;
    const invokeOptions = {
      signal: request.signal,
      ...(callbacks ? { callbacks } : {})
    };

    let lastParseError: unknown;
    for (let attempt = 0; attempt < STRUCTURED_OUTPUT_ATTEMPTS; attempt += 1) {
      try {
        return await structured.invoke(messages, invokeOptions);
      } catch (error) {
        // Only parser rejections (malformed / schema-invalid JSON) are
        // re-sampled; transport, auth, abort and provider errors surface as-is.
        if (!(error instanceof OutputParserException)) {
          throw error;
        }
        lastParseError = error;
      }
    }
    throw lastParseError;
  }


  /**
   * UI 参照图：JSON 里只留元数据（含 vision describe 后的 note）。
   * 原件仅在 attachImages=true 时以 image_url 附着；OpenCode/atlas 默认关闭。
   * 无图时保持纯文本 HumanMessage（既有路径逐字节不变）。
   */
  private buildHumanMessage(
    request: PlanningModelRequest<JsonObject>,
    attachImages = this.attachUiReferenceImages
  ): HumanMessage {
    const refs = Array.isArray(request.input.providedUiReferences)
      ? (request.input.providedUiReferences as Array<Record<string, unknown>>)
      : [];
    const images = attachImages
      ? refs.filter(
          (ref) => typeof ref.base64 === "string" && (ref.base64 as string).length > 0
        )
      : [];
    const inputForJson: JsonObject = {
      ...request.input,
      providedUiReferences: refs.map((ref) => ({
        fileName: typeof ref.fileName === "string" ? ref.fileName : "ui-reference",
        mimeType: typeof ref.mimeType === "string" ? ref.mimeType : "application/octet-stream",
        note:
          typeof ref.note === "string"
            ? ref.note
            : `[UI reference image: ${typeof ref.fileName === "string" ? ref.fileName : "ui-reference"}]`
      }))
    };
    const payload = JSON.stringify({
      stage: request.stage,
      input: inputForJson,
      validationErrors: request.validationErrors
    });
    if (images.length === 0) {
      return new HumanMessage(payload);
    }
    return new HumanMessage({
      content: [
        { type: "text", text: payload },
        ...images.map((ref) => {
          const mime =
            typeof ref.mimeType === "string" && ref.mimeType.startsWith("image/")
              ? ref.mimeType
              : "image/png";
          return {
            type: "image_url" as const,
            image_url: { url: `data:${mime};base64,${ref.base64 as string}` }
          };
        })
      ]
    });
  }

  /**
   * jsonMode sends `response_format: { type: "json_object" }`, which providers
   * (OpenAI, DeepSeek/thinking models) only accept when the prompt mentions
   * "json" — and langchain does not inject the schema for this method, so the
   * instruction must carry it explicitly. All other methods keep the prompt
   * untouched (langchain handles their schema wiring).
   */
  private systemPrompt(request: PlanningModelRequest<JsonObject>): string {
    if (this.structuredOutputMethod !== "jsonMode") {
      return request.prompt;
    }

    return [
      request.prompt,
      "",
      "Return your answer as a single json object that conforms to this JSON schema:",
      JSON.stringify(z.toJSONSchema(request.schema)),
      "Output only the json object, with no extra text."
    ].join("\n");
  }
}

function hasUiReferenceImages(input: JsonObject): boolean {
  const refs = Array.isArray(input.providedUiReferences) ? input.providedUiReferences : [];
  return refs.some(
    (ref) =>
      typeof ref === "object" &&
      ref !== null &&
      typeof (ref as { base64?: unknown }).base64 === "string" &&
      ((ref as { base64: string }).base64.length > 0)
  );
}
