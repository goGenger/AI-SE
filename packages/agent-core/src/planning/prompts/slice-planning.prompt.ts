import {
  DEFAULT_CAPABILITY_PROFILE,
  profileEnablesDataLayer,
  type CapabilityProfile
} from "@ai-se/shared";
import { withPlanningIntentContract } from "../../professional/skillResolver";
import {
  CONFLICT_RESOLUTIONS_CLAUSE,
  MISSING_VISUAL_BASELINES_CLAUSE
} from "./provided-documents.prompt";

function slicePlanningBaseLines(profile: CapabilityProfile): string[] {
  const dataEnabled = profileEnablesDataLayer(profile);
  const dataLine = dataEnabled
    ? `Capability profile: ${profile.id}. Plan only work this profile enables (plannable types: ${profile.taskTypes.plannable.join(", ")}). Set involvesData=false only when the slice introduces no data-layer changes (its database_spec stage will then be skipped).`
    : `Capability profile: ${profile.id}. This profile does not enable backend or database work. Set involvesData=false on every slice; do not create data-layer slices, and do not invent out-of-profile backend work. Omitting involvesData or setting it true is invalid, because that would open database_spec.`;

  return [
    "Role: Delivery slicer for a two-level planning pipeline.",
    "Input: one validated requirement analysis, including its functionalRequirements list (FR ids).",
    "Output Schema: SlicePlan.",
    "Constraints: split the delivery into a short list of sequentially executable slices; every slice covers between 1 and 5 FR ids taken from the analysis's functionalRequirements; every FR id must be covered by at least one slice; never invent FR ids outside that list; dependsOn may only reference other slice ids; order is the sequential execution order starting at 1 and is unique per slice; set involvesUi=false only when the slice delivers no user-visible UI (its ui_spec stage will then be skipped).",
    dataLine,
    "Each slice must include acceptanceCriteria that name a check (an acceptance criterion or an official gate) that would prove the slice is done. A slice without a named check is not a complete plan item. Official E2E and official visual review belong at slice end, not as a required check on every intermediate slice.",
    "Do not invent requirements outside the provided FR list.",
    MISSING_VISUAL_BASELINES_CLAUSE,
    CONFLICT_RESOLUTIONS_CLAUSE
  ];
}

export function slicePlanningPrompt(options: { profile?: CapabilityProfile } = {}): string {
  const profile = options.profile ?? DEFAULT_CAPABILITY_PROFILE;
  return withPlanningIntentContract(slicePlanningBaseLines(profile).join("\n"));
}

/** 默认合成（产品默认 profile + planning-intent-contract）。 */
export const SLICE_PLANNING_PROMPT = slicePlanningPrompt();
