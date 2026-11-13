import type { VisualViewport } from "@ai-se/shared";
import { redactCredentialShapedText } from "@ai-se/observability";
import { VisualAnalyzerError } from "../errors";
import type {
  VLMElementObservation,
  VLMPageObservation,
  VLMProvider,
  VLMRecognizeInput,
  VLMSectionObservation
} from "./types";

/**
 * Phase 5.6-1 Repair: REAL VLM provider over any OpenAI-compatible
 * chat-completions vision endpoint (configurable baseUrl/model; the key is
 * injected by the caller and is NEVER logged, echoed, or stored here).
 * ponytail: stdlib fetch, zero SDK dependency; JSON responses are
 * schema-mapped into the existing VLMPageObservation.
 */

 export interface OpenAIWireVLMOptions {
 /** Injected credential — required; absent → construction fails fast. */
 apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Request timeout ceiling (mirrors VLMInvokeOptions semantics). */
  timeoutMs?: number;
}

export class OpenAIWireVLMProvider implements VLMProvider {
  readonly name = "openai-wire";

  constructor(private readonly options: OpenAIWireVLMOptions) {
    if (!options.apiKey) {
      // Fail fast: a keyless provider must refuse construction, never fake.
      throw new VisualAnalyzerError(
        "VLM_UNAVAILABLE",
        "OpenAIWireVLMProvider requires an injected apiKey (refusing to fake PASS)"
      );
    }
  }

  async recognize(
    input: VLMRecognizeInput,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<VLMPageObservation> {
    if (options?.signal?.aborted) {
      throw new VisualAnalyzerError("VLM_CANCELLED", "Visual analysis was cancelled");
    }
    const timeoutMs = options?.timeoutMs ?? this.options.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetch(`${this.options.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Key only lives here; never logged, never echoed.
          authorization: `Bearer ${this.options.apiKey}`
        },
        body: JSON.stringify({
          model: this.options.model ?? "gpt-5.6",
          messages: [
            {
              role: "system",
              content:
                "You are a UI structure extractor. Given a screenshot, reply with STRICT JSON only: " +
                '{"pageName":string,"sections":[{"name":string,"rect":{"x":number,"y":number,"width":number,"height":number},' +
                '"style":{"color":string(optional hex "#rrggbb"),"fontSizePx":number(optional),"radiusPx":number(optional),' +
                '"shadow":string(optional)},"elements":[{"name":string,"role":"text"|"button"|"input"|"image"|"icon"|"link"|"list"|"table"|"container"|"other",' +
                '"rect":{"x":number,"y":number,"width":number,"height":number}(optional),"stateHint":string(optional)}]}],"warnings":string[]}. ' +
                "No markdown fences, no commentary."
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Extract UI structure. Viewport: ${input.viewport.width}x${input.viewport.height}.`
                },
                {
                  type: "image_url",
                  image_url: { url: `data:${input.mimeType};base64,${input.imageBase64}` }
                }
              ]
            }
          ],
          // ponytail: deterministic-ish extraction; no creative temperature.
          temperature: 0
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new VisualAnalyzerError(
          "VLM_UNAVAILABLE",
          `VLM endpoint returned ${response.status} ${redactCredentialShapedText(response.statusText)}`
        );
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new VisualAnalyzerError(
          "VLM_MALFORMED",
          "VLM response missing choices[0].message.content"
        );
      }
      return parseModelJson(content, input.viewport);
    } catch (error) {
      if (controller.signal.aborted) {
        throw options?.signal?.aborted
          ? new VisualAnalyzerError("VLM_CANCELLED", "Visual analysis was cancelled")
          : new VisualAnalyzerError("VLM_TIMEOUT", `Visual analysis exceeded ${timeoutMs}ms`);
      }
      if (error instanceof VisualAnalyzerError) throw error;
      throw new VisualAnalyzerError(
        "VLM_UNAVAILABLE",
        `VLM request failed: ${error instanceof Error ? redactCredentialShapedText(error.message) : "unknown"}`
      );
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Model must reply WITH STRICT JSON. Anything else → VLM_MALFORMED. */
function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

export function parseModelJson(
  content: string,
  viewport: VisualViewport
): VLMPageObservation {
  let parsed: unknown;
  try {
    const cleaned = stripJsonFences(content);
    parsed = JSON.parse(cleaned);
  } catch {
    throw new VisualAnalyzerError("VLM_MALFORMED", "VLM output is not valid JSON");
  }
  const shape = parsed as {
    pageName?: unknown;
    sections?: unknown;
    warnings?: unknown;
  };
  if (
    typeof shape.pageName !== "string" ||
    !Array.isArray(shape.sections)
  ) {
    throw new VisualAnalyzerError("VLM_MALFORMED", "VLM JSON missing pageName/sections");
  }
  if (typeof shape.pageName !== "string" || shape.pageName.length === 0) {
    throw new VisualAnalyzerError("VLM_MALFORMED", "VLM JSON pageName is empty");
  }
  const sections: VLMSectionObservation[] = [];
  for (const raw of shape.sections) {
    const section = raw as {
      name?: unknown;
      rect?: unknown;
      style?: unknown;
      elements?: unknown;
    };
    if (typeof section.name !== "string" || !isRect(section.rect)) {
      throw new VisualAnalyzerError("VLM_MALFORMED", "VLM JSON section missing name/rect");
    }
    const elements: VLMElementObservation[] = [];
    if (Array.isArray(section.elements)) {
      for (const rawElement of section.elements) {
        const element = rawElement as {
          name?: unknown;
          role?: unknown;
          rect?: unknown;
          stateHint?: unknown;
        };
        if (typeof element.name !== "string" || typeof element.role !== "string") {
          throw new VisualAnalyzerError("VLM_MALFORMED", "VLM JSON element missing name/role");
        }
        elements.push({
          name: element.name,
          role: element.role as VLMElementObservation["role"],
          rect: isRect(element.rect) ? element.rect : undefined,
          stateHint: typeof element.stateHint === "string" ? element.stateHint : undefined
        });
      }
    }
    sections.push({
      name: section.name,
      rect: section.rect,
      style: isStyle(section.style) ? section.style : undefined,
      elements
    });
  }
  const warnings = Array.isArray(shape.warnings)
    ? shape.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  void viewport;
  return { pageName: shape.pageName, sections, warnings };
}

function isRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  const rect = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  return (
    typeof rect?.x === "number" &&
    typeof rect?.y === "number" &&
    typeof rect?.width === "number" &&
    typeof rect?.height === "number" &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.width)
  );
}

function isStyle(value: unknown): value is NonNullable<VLMSectionObservation["style"]> {
  if (typeof value !== "object" || value === null) return false;
  const style = value as {
    color?: unknown;
    fontSizePx?: unknown;
    radiusPx?: unknown;
    shadow?: unknown;
  };
  return (
    typeof style.color === "string" ||
    typeof style.fontSizePx === "number" ||
    typeof style.radiusPx === "number" ||
    typeof style.shadow === "string"
  );
}
