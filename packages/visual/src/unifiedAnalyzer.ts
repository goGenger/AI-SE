/**
 * Phase 5.6-1 Repair: unified entry for the three real input chains.
 * Screenshot → (real or fake VLM) → VLMPageObservation; Figma → REST mapping
 * (deterministic); URL → fetch+parse (deterministic). All three feed the
 * SAME analyzer post-processing pipeline (buildSpecification + token
 * extraction) → frozen 5.6-0 schema.
 */
import {
  validateVisualInput,
  type VisualInputAllowlist,
  type VisualInputRecord
} from "@ai-se/shared";
import { redactCredentialShapedText } from "@ai-se/observability";
import { VisualAnalyzerError } from "./errors";
import {
  buildSpecification,
  extractDesignTokens,
  type AnalyzeOutcome
} from "./analyzer";
import type { ObservableSource } from "./vlm/unifiedSource";

export interface RealAnalyzeOptions {
  allowlist?: VisualInputAllowlist;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Unified multi-source entry: Screenshot / Figma / URL record → observation
 * (real or test fake) → deterministic analyzer pipeline → frozen spec.
 *
 * Wraps timeout / cancellation / error normalization ONCE here so every
 * source adapter gets identical semantics (real-VLM parity with 5.6-1).
 */
export async function analyzeUnifiedInput(
  source: ObservableSource,
  record: VisualInputRecord,
  options: RealAnalyzeOptions = {}
): Promise<AnalyzeOutcome> {
  const allowlist = options.allowlist ?? [];
  const validated = validateVisualInput(record, allowlist);
  if (!validated.ok) {
    throw new VisualAnalyzerError("INPUT_INVALID", validated.reason);
  }

  if (options.signal?.aborted) {
    throw new VisualAnalyzerError("VLM_CANCELLED", "Visual analysis was cancelled");
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const observation = await source.observe(validated.record, {
      signal: controller.signal,
      timeoutMs
    });
    const specification = buildSpecification(observation, validated.record);
    const tokenFindings = extractDesignTokens(observation.sections[0]?.style);
    return {
      specification,
      tokenFindings,
      providerWarnings: observation.warnings.map((warning) =>
        redactCredentialShapedText(warning)
      )
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw options.signal?.aborted
        ? new VisualAnalyzerError("VLM_CANCELLED", "Visual analysis was cancelled")
        : new VisualAnalyzerError("VLM_TIMEOUT", `Visual analysis exceeded ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
