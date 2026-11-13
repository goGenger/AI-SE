import type { VisualInputRecord, VisualViewport } from "@ai-se/shared";
import type { VLMPageObservation } from "./types";

/**
 * Phase 5.6-1 Repair: the ONE shape every source adapter must satisfy so
 * `analyzeUnifiedInput` can drive Screenshot / Figma / URL chains uniformly.
 * VLMProvider is preserved for the screenshot path (5.6-3 VLM boundary).
 */

export interface ObserveContext {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ObservableSource {
  readonly name: string;
  observe(
    record: VisualInputRecord,
    options?: ObserveContext
  ): Promise<VLMPageObservation>;
}

/** Wrap an existing VLMProvider (real OpenAI-wired or the deterministic fake). */
export function fromVLMProvider(provider: import("./types").VLMProvider): ObservableSource {
  return {
    name: provider.name,
    async observe(record: VisualInputRecord, options?: ObserveContext): Promise<VLMPageObservation> {
      const input = {
        imageBase64: record.assetRef ?? "",
        mimeType: "image/png",
        viewport: record.viewport as VisualViewport
      };
      return provider.recognize(input, { signal: options?.signal, timeoutMs: options?.timeoutMs });
    }
  };
}

/** Figma REST source: asset ref `figma://file/<key>` → node-tree mapping. */
export function fromFigmaProvider(provider: import("./figmaProvider").FigmaVLMProvider): ObservableSource {
  return {
    name: provider.name,
    async observe(record: VisualInputRecord, options?: ObserveContext): Promise<VLMPageObservation> {
      return provider.recognize(
        record.assetRef ?? "",
        record.viewport as VisualViewport,
        { signal: options?.signal, timeoutMs: options?.timeoutMs }
      );
    }
  };
}

/** URL fetch source: asset ref `url://<host>/<path>` → HTML parse mapping. */
export function fromUrlProvider(provider: import("./urlFetchProvider").UrlFetchVLMProvider): ObservableSource {
  return {
    name: provider.name,
    async observe(record: VisualInputRecord, options?: ObserveContext): Promise<VLMPageObservation> {
      return provider.recognize(
        record.assetRef ?? "",
        record.viewport as VisualViewport,
        { signal: options?.signal, timeoutMs: options?.timeoutMs }
      );
    }
  };
}
