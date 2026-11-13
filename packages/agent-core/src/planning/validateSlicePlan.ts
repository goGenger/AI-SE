import {
  profileEnablesDataLayer,
  type CapabilityProfile,
  type ProvidedUiReference,
  type RequirementAnalysis,
  type SlicePlan,
  type VisualBaselineGap
} from "@ai-se/shared";
import { validateNamedPlanChecks } from "./validateNamedPlanChecks";
import {
  mergeVisualBaselineGaps,
  validateVisualBaselineGaps
} from "./validateVisualBaselineGaps";

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  return [...duplicates];
}

export interface SlicePlanValidationInput {
  slicePlan: SlicePlan;
  functionalRequirements: Array<{ id: string }>;
  /**
   * docs/268：传入时启用能力面与基线缺口硬校验。
   * 既有只测 FR 覆盖的单元测试可不传，以免把新不变量叠进结构用例。
   */
  profile?: CapabilityProfile;
  providedUiReferences?: ReadonlyArray<Pick<ProvidedUiReference, "fileName">>;
  requirementAnalysis?: Pick<RequirementAnalysis, "visualBaselineGaps">;
}

function validateSliceCapabilityProfile(
  slicePlan: SlicePlan,
  profile: CapabilityProfile
): string[] {
  if (profileEnablesDataLayer(profile)) {
    return [];
  }
  const errors: string[] = [];
  for (const slice of slicePlan.slices) {
    if (slice.involvesData === true) {
      errors.push(
        `Slice ${slice.id} sets involvesData=true which is not enabled under capability profile ${profile.id}.`
      );
    } else if (slice.involvesData !== false) {
      errors.push(
        `Slice ${slice.id} omits involvesData, which would open database_spec; capability profile ${profile.id} does not enable database or backend work.`
      );
    }
  }
  return errors;
}

/**
 * N2 第一级切片计划的确定性覆盖检查（不依赖 LLM 判断）：
 * - FR 集非空（requirement_analysis 必须给出 functionalRequirements）；
 * - 每个 FR 至少被一个切片涵盖；切片不得引用 FR 集之外的编号（无虚构）；
 * - 切片 id 与顺序唯一；dependsOn 只引用存在的切片且不得自依赖；
 * - 单片 FR 数不超过 5（“每片规模上限 3–5 个 FR”）。
 *
 * docs/268 在传入 `profile` 时追加：
 * - 能力面未启用数据层 / 后端时，拒绝 `involvesData=true` 或省略（省略会打开 database_spec）；
 * - 每个切片必须有命名检查；
 * - UI 切片在没有任何官方视觉基线时必须点明 `visualBaselineGaps`。
 */
export function validateSlicePlan(input: SlicePlanValidationInput): string[] {
  const errors: string[] = [];
  const known = new Set(input.functionalRequirements.map((entry) => entry.id));

  if (known.size === 0) {
    errors.push("Requirement analysis did not provide functionalRequirements");
  }

  for (const id of duplicateValues(input.slicePlan.slices.map((slice) => slice.id))) {
    errors.push(`Duplicate slice id: ${id}`);
  }

  for (const order of duplicateValues(input.slicePlan.slices.map((slice) => String(slice.order)))) {
    errors.push(`Duplicate slice order: ${order}`);
  }

  const sliceIds = new Set(input.slicePlan.slices.map((slice) => slice.id));
  const covered = new Set<string>();

  for (const slice of input.slicePlan.slices) {
    if (slice.frKeys.length > 5) {
      errors.push(`Slice ${slice.id} exceeds the 5-FR limit (${slice.frKeys.length})`);
    }

    for (const frKey of slice.frKeys) {
      if (!known.has(frKey)) {
        errors.push(`Slice ${slice.id} references unknown FR: ${frKey}`);
      }
      covered.add(frKey);
    }

    for (const dependency of slice.dependsOn) {
      if (dependency === slice.id) {
        errors.push(`Slice ${slice.id} depends on itself`);
      } else if (!sliceIds.has(dependency)) {
        errors.push(`Slice ${slice.id} depends on unknown slice: ${dependency}`);
      }
    }
  }

  for (const frKey of known) {
    if (!covered.has(frKey)) {
      errors.push(`FR not covered by any slice: ${frKey}`);
    }
  }

  if (input.profile) {
    errors.push(...validateSliceCapabilityProfile(input.slicePlan, input.profile));
    errors.push(
      ...validateNamedPlanChecks({
        items: input.slicePlan.slices,
        kind: "slice"
      })
    );
    const uiFacing = input.slicePlan.slices.some((slice) => slice.involvesUi !== false);
    const gaps: VisualBaselineGap[] = mergeVisualBaselineGaps(
      input.requirementAnalysis,
      input.slicePlan
    );
    errors.push(
      ...validateVisualBaselineGaps({
        uiFacing,
        providedUiReferences: input.providedUiReferences,
        gaps
      })
    );
  }

  return errors;
}
