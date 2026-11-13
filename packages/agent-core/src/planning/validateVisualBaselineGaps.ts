import type { ProvidedUiReference, VisualBaselineGap } from "@ai-se/shared";

export const MISSING_VISUAL_BASELINE_GAP_ERROR =
  "UI-facing plan is missing official visual baselines and does not record visualBaselineGaps.";

export interface VisualBaselineGapValidationInput {
  /** Whether the plan or stage delivers user-visible UI. */
  uiFacing: boolean;
  providedUiReferences?: ReadonlyArray<Pick<ProvidedUiReference, "fileName">> | undefined;
  gaps?: ReadonlyArray<VisualBaselineGap> | undefined;
}

/**
 * docs/268：缺关键页 / 关键态官方视觉基线时，必须在计划里点明缺口。
 *
 * 硬规则（可判定、不挡规划）：
 * - 非 UI 工作：不要求缺口记录；
 * - 已有 `providedUiReferences`：视为已提供基线，剩余关键态缺口由提示词引导补记；
 * - 有界面、没有任何参照图、且 `visualBaselineGaps` 为空或缺失：视为静默跳过，拒绝。
 * 记录缺口即通过，不因缺基线而拒绝规划。
 */
export function validateVisualBaselineGaps(input: VisualBaselineGapValidationInput): string[] {
  if (!input.uiFacing) {
    return [];
  }
  const references = input.providedUiReferences ?? [];
  if (references.length > 0) {
    return [];
  }
  const gaps = (input.gaps ?? []).filter((gap) => gap.page.trim().length > 0 && gap.note.trim().length > 0);
  if (gaps.length > 0) {
    return [];
  }
  return [MISSING_VISUAL_BASELINE_GAP_ERROR];
}

export function mergeVisualBaselineGaps(
  ...sources: Array<{ visualBaselineGaps?: VisualBaselineGap[] } | undefined>
): VisualBaselineGap[] {
  return sources.flatMap((source) => source?.visualBaselineGaps ?? []);
}
