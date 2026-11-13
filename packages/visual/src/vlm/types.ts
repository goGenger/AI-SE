import type { VisualViewport } from "@ai-se/shared";

/**
 * Phase 5.6-1: VLMProvider — the ONLY seam through which visual recognition
 * happens. Real vision models plug in here LATER (5.6-1 ships a deterministic
 * local fake only); the contract freezes the interface, timeout, cancellation
 * and error taxonomy so later providers cannot drift.
 */

/** Page-level structured observation produced by one recognize pass. */
export interface VLMPageObservation {
  /** Page name as seen in the source image (used for stable id slugs). */
  pageName: string;
  /** Sections with element-relative geometry in the given viewport. */
  sections: VLMSectionObservation[];
  /** Low-confidence / text-noise notes surfaced as spec warnings. */
  warnings: string[];
}

export interface VLMSectionObservation {
  name: string;
  /** Pixels within the viewport; normalized + ordered by the analyzer. */
  rect: { x: number; y: number; width: number; height: number };
  style?: VLMStyleObservation;
  elements?: VLMElementObservation[];
}

export interface VLMElementObservation {
  name: string;
  role:
    | "text"
    | "button"
    | "input"
    | "image"
    | "icon"
    | "link"
    | "list"
    | "table"
    | "container"
    | "other";
  rect?: { x: number; y: number; width: number; height: number };
  /** Any colored badge / status hint the provider saw (intersection with the
   * frozen VisualStateName vocabulary is enforced by the analyzer). */
  stateHint?: string;
}

export interface VLMStyleObservation {
  /** Dominant color as lowercase hex (e.g. "#1533ff"). */
  color?: string;
  /** Body font size in px. */
  fontSizePx?: number;
  /** Corner radius in px. */
  radiusPx?: number;
  /** Shadow description (short, e.g. "0 8px 24px rgba(0,0,0,0.2)"). */
  shadow?: string;
}

export interface VLMRecognizeInput {
  /** Raw base64 screenshot content (no data: prefix). */
  imageBase64: string;
  mimeType: string;
  viewport: VisualViewport;
}

export interface VLMProvider {
  readonly name: string;
  recognize(input: VLMRecognizeInput, options?: VLMInvokeOptions): Promise<VLMPageObservation>;
}

export interface VLMInvokeOptions {
  /** Abort provider work (analyzer maps it to a CANCELLED error). */
  signal?: AbortSignal;
  /** Timeout in ms; the analyzer enforces a default when absent. */
  timeoutMs?: number;
}
