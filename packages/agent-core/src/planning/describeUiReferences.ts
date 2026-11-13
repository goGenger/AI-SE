import type { ProvidedUiReference } from "@ai-se/shared";
import { openCodeGatewayHeaders } from "../llm/LangChainLLMProvider";

const MULTIMODAL_UNSUPPORTED_PATTERN =
  /not yet supported by atlas|multimodal|image_url|vision.*(not|un)supported|does not support.*(image|vision|multimodal)/i;

const DEFAULT_VISION_TIMEOUT_MS = 60_000;
const MAX_NOTE_CHARS = 2_500;

export interface DescribeUiReferencesOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** OpenCode session header when baseUrl points at opencode. */
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * When true (default for OpenCode endpoints), drop base64 after describe so
   * planning never sends image_url parts through atlas.
   * Non-OpenCode keeps base64 on describe failure so native multimodal can retry.
   */
  forceTextOnly?: boolean;
  /** Injected fetch (tests). */
  fetchImpl?: typeof fetch;
}

export interface DescribeUiReferencesResult {
  references: ProvidedUiReference[];
  /** Human-readable warnings (describe failures, missing key, etc.). */
  warnings: string[];
  /** How many refs received a vision-produced note. */
  describedCount: number;
  /** True when planning must not attach image_url parts. */
  textOnly: boolean;
}

export function isOpenCodePlanningEndpoint(baseUrl: string | undefined): boolean {
  return typeof baseUrl === "string" && /opencode\.ai/i.test(baseUrl);
}

export function isMultimodalUnsupportedError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error
          ? String((error as { message?: unknown }).message ?? "")
          : String(error ?? "");
  return MULTIMODAL_UNSUPPORTED_PATTERN.test(message);
}

function defaultNote(fileName: string): string {
  return `[UI reference image: ${fileName}]`;
}

function clipNote(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_NOTE_CHARS) return normalized;
  return `${normalized.slice(0, MAX_NOTE_CHARS - 1)}…`;
}

function formatObservationNote(fileName: string, body: string): string {
  return clipNote(`UI reference analysis for ${fileName}: ${body}`);
}

/**
 * OpenAI-compatible vision describe for planning intake.
 * Produces concise text notes and optionally strips base64 so OpenCode/atlas
 * planning never receives unsupported multimodal image_url parts.
 */
export async function describeUiReferencesForPlanning(
  refs: ProvidedUiReference[],
  options: DescribeUiReferencesOptions = {}
): Promise<DescribeUiReferencesResult> {
  const baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL;
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
  const openCode = isOpenCodePlanningEndpoint(baseUrl);
  const textOnly = options.forceTextOnly ?? openCode;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const warnings: string[] = [];
  let describedCount = 0;

  if (refs.length === 0) {
    return { references: [], warnings, describedCount, textOnly };
  }

  const withImages = refs.filter((ref) => typeof ref.base64 === "string" && ref.base64.length > 0);
  if (withImages.length === 0) {
    return {
      references: refs.map((ref) => ({
        fileName: ref.fileName,
        mimeType: ref.mimeType,
        note: ref.note || defaultNote(ref.fileName)
      })),
      warnings,
      describedCount,
      textOnly
    };
  }

  if (!apiKey) {
    warnings.push(
      "UI reference vision describe skipped: OPENAI_API_KEY missing; planning will use filename notes only"
    );
    return {
      references: refs.map((ref) => stripOrKeep(ref, textOnly)),
      warnings,
      describedCount,
      textOnly
    };
  }

  const endpoint = `${(baseUrl && baseUrl.trim() !== "" ? baseUrl : "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
  const gatewayHeaders = openCodeGatewayHeaders(baseUrl, options.sessionId ?? "ai-se-planning-vision");

  const described: ProvidedUiReference[] = [];
  for (const ref of refs) {
    if (!ref.base64) {
      described.push({
        fileName: ref.fileName,
        mimeType: ref.mimeType,
        note: ref.note || defaultNote(ref.fileName)
      });
      continue;
    }

    try {
      const note = await describeOne(ref, {
        endpoint,
        apiKey,
        model,
        headers: gatewayHeaders,
        timeoutMs: options.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS,
        signal: options.signal,
        fetchImpl
      });
      describedCount += 1;
      described.push({
        fileName: ref.fileName,
        mimeType: ref.mimeType,
        note
        // intentional: vision notes replace raw multimodal for planning
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : "unknown";
      warnings.push(`UI reference vision describe failed for ${ref.fileName}: ${message}`);
      described.push(stripOrKeep(ref, textOnly));
    }
  }

  return { references: described, warnings, describedCount, textOnly };
}

function stripOrKeep(ref: ProvidedUiReference, textOnly: boolean): ProvidedUiReference {
  if (textOnly) {
    return {
      fileName: ref.fileName,
      mimeType: ref.mimeType,
      note: ref.note || defaultNote(ref.fileName)
    };
  }
  return {
    fileName: ref.fileName,
    mimeType: ref.mimeType,
    note: ref.note || defaultNote(ref.fileName),
    ...(ref.base64 ? { base64: ref.base64 } : {})
  };
}

async function describeOne(
  ref: ProvidedUiReference,
  args: {
    endpoint: string;
    apiKey: string;
    model: string;
    headers?: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
    fetchImpl: typeof fetch;
  }
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const onAbort = () => controller.abort();
  args.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const mime =
      typeof ref.mimeType === "string" && ref.mimeType.startsWith("image/")
        ? ref.mimeType
        : "image/png";
    const response = await args.fetchImpl(args.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${args.apiKey}`,
        ...(args.headers ?? {})
      },
      body: JSON.stringify({
        model: args.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You analyze UI reference mockups for software planning. Reply with concise plain text (no markdown fences) covering: (1) overall layout, (2) main regions, (3) key components/controls, (4) color and style cues, (5) notable empty/loading states if visible. Keep it under 400 words. Chinese or English matching the UI labels is fine."
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Describe this UI reference image for planning. fileName=${ref.fileName}`
              },
              {
                type: "image_url",
                image_url: { url: `data:${mime};base64,${ref.base64}` }
              }
            ]
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const statusText = response.statusText || "";
      let bodyText = "";
      try {
        bodyText = (await response.text()).slice(0, 300);
      } catch {
        bodyText = "";
      }
      throw new Error(
        `vision endpoint returned ${response.status} ${statusText}${bodyText ? `: ${bodyText}` : ""}`
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) => (typeof part?.text === "string" ? part.text : ""))
              .filter(Boolean)
              .join("\n")
          : "";
    if (!text.trim()) {
      throw new Error("vision response missing choices[0].message.content");
    }
    return formatObservationNote(ref.fileName, text);
  } catch (error) {
    if (controller.signal.aborted && !args.signal?.aborted) {
      throw new Error(`vision describe exceeded ${args.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", onAbort);
  }
}

/** Drop base64 so LangChainPlanningModel will not attach image_url parts. */
export function stripUiReferenceImages(refs: ProvidedUiReference[]): ProvidedUiReference[] {
  return refs.map((ref) => ({
    fileName: ref.fileName,
    mimeType: ref.mimeType,
    note: ref.note || defaultNote(ref.fileName)
  }));
}
