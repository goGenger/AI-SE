/**
 * Phase 5.6-1: self-contained error taxonomy for visual analysis.
 *
 * NOT a second runtime error system: these are analysis-domain error codes
 * (analyzer-facing). They never wrap or re-emit foreign SDK objects — the
 * analyzer normalizes provider failures into these codes and keeps the
 * original message OUT of result payloads when it may leak credentials.
 */

export type VisualAnalyzerErrorCode =
  | "VLM_TIMEOUT"
  | "VLM_CANCELLED"
  | "VLM_MALFORMED"
  | "VLM_UNAVAILABLE"
  | "INPUT_INVALID";

export class VisualAnalyzerError extends Error {
  readonly code: VisualAnalyzerErrorCode;

  constructor(code: VisualAnalyzerErrorCode, message: string) {
    super(message);
    this.name = "VisualAnalyzerError";
    this.code = code;
  }
}
