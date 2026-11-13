import type { VisualViewport } from "@ai-se/shared";
import type {
  VLMElementObservation,
  VLMPageObservation,
  VLMProvider,
  VLMRecognizeInput,
  VLMSectionObservation
} from "./types";

/**
 * Phase 5.6-1: deterministic LOCAL fake VLM provider (no network, no file
 * access, no model). It derives structure from the base64 payload determinis-
 * tically so that tests are reproducible and re-runnable:
 *
 *   - the payload length selects the layout variant (header/body/footer);
 *   - declared markers inside the payload ("color:", "font:", "badge:", ...)
 *     become style/state observations (see fixture builders in tests);
 *   - the same bytes always produce the same observation.
 */

export interface FakeVLMProviderOptions {
  /** Writes one "bad payload" recognition (malformed → VLM_MALFORMED). */
  malformed?: boolean;
  /** Overrides the default settle behavior (delayMs for timeout tests). */
  delayMs?: number;
}

const DEFAULT_FAKE_DELAY_MS = 5;
void DEFAULT_FAKE_DELAY_MS;

function layoutVariant(base64: string): "narrow" | "wide" {
  return base64.length % 2 === 0 ? "wide" : "narrow";
}

export class FakeVLMProvider implements VLMProvider {
  readonly name = "fake-deterministic";

  constructor(private readonly options: FakeVLMProviderOptions = {}) {}

  async recognize(
    input: VLMRecognizeInput,
    options?: { signal?: AbortSignal }
  ): Promise<VLMPageObservation> {
    if (this.options.malformed) {
      // Simulated broken provider output — the analyzer classifies this as
      // VLM_MALFORMED instead of crashing.
      return {
        pageName: "",
        sections: [
          {
            // Zero-width rect must be filtered with a warning, not dropped
            // silently and not crashing.
            name: "broken-section",
            rect: { x: -5, y: -5, width: 0, height: 0 }
          }
        ],
        warnings: []
      };
    }

    if (this.options.delayMs && this.options.delayMs > 0) {
      const aborted = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), this.options.delayMs);
        options?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          { once: true }
        );
      });
      if (aborted) {
        // Real providers reject on abort; the fake matches that semantics so
        // the analyzer's cancellation mapping stays exercised end to end.
        throw new Error("The operation was aborted");
      }
    }

    const raw = input.imageBase64;
    const wide = layoutVariant(raw) === "wide";

    const style: VLMSectionObservation["style"] = {
      color: extractColor(raw),
      fontSizePx: extractNumber(raw, "font:"),
      radiusPx: extractNumber(raw, "radius:"),
      shadow: extractQuoted(raw, "shadow:")
    };

    const sections: VLMSectionObservation[] = [headerSection(input.viewport, style)];

    if (raw.includes("badge:error")) {
      sections[0].elements?.push(statusBadge("error"));
    } else if (raw.includes("badge:loading")) {
      sections[0].elements?.push(statusBadge("loading"));
    }

    if (raw.includes("icon:logo")) {
      sections[0].elements?.push(element("logo", "icon"));
    }
    if (raw.includes("button:submit")) {
      sections[0].elements?.push(element("submit", "button"));
    }
    if (raw.includes("image:avatar")) {
      sections[0].elements?.push(element("avatar", "image"));
    }

    if (wide) {
      sections.push({
        name: "Body",
        rect: {
          x: 0,
          y: headerHeight(input.viewport) + 8,
          width: input.viewport.width,
          height: Math.max(1, input.viewport.height - headerHeight(input.viewport) - 8)
        },
        style,
        elements: [element("content", "text")]
      });
    }

    const warnings: string[] = [];
    if (raw.includes("warn:low-contrast")) warnings.push("Low contrast text detected (fixture)");
    if (raw.includes("warn:noise")) warnings.push("Noisy OCR region included (fixture)");

    return {
      pageName: extractQuoted(raw, "page:") ?? "Fixture Page",
      sections,
      warnings
    };
  }
}

const HEADER_FRACTION = 0.2;

/** Canonical fixture screenshot content (base64 of a synthetic payload with
 * page name, colors, font, icon/button markers — no real image decoding). */
export const FAKE_SCREENSHOT_ASSET = [
  "cGFnZToiRml4dHVyZSBQYWdlIg==",
  "color:#1533ff",
  "font:14",
  "radius:12",
  "icon:logo",
  "button:submit"
].join("");

/** Canonical leaky fixture payload for redaction verification. */
export const FAKE_LEAKY_SCREENSHOT_ASSET =
  'page:"Checkout" color:#1533ff shadow:"sk-leaky1234567890abcdef and Bearer AAAABBBBCCCC"';

function headerHeight(viewport: VisualViewport): number {
  return Math.max(1, Math.round(viewport.height * HEADER_FRACTION));
}

function headerSection(
  viewport: VisualViewport,
  style: VLMSectionObservation["style"]
): VLMSectionObservation {
  return {
    name: "Header",
    rect: { x: 0, y: 0, width: viewport.width, height: headerHeight(viewport) },
    style,
    elements: []
  };
}

function element(name: string, role: VLMElementObservation["role"]): VLMElementObservation {
  return { name, role, rect: { x: 8, y: 8, width: 64, height: 24 } };
}

function statusBadge(state: "error" | "loading"): VLMElementObservation {
  return { name: `badge-${state}`, role: "text", stateHint: state };
}

function extractColor(raw: string): string | undefined {
  const match = /color:(#[0-9a-fA-F]{3,8})/.exec(raw);
  return match?.[1]?.toLowerCase();
}

function extractNumber(raw: string, marker: string): number | undefined {
  const match = new RegExp(`${marker}(\\d+)`).exec(raw);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function extractQuoted(raw: string, marker: string): string | undefined {
  const match = new RegExp(`${marker}"([^"]{1,100})"`).exec(raw);
  return match?.[1];
}
