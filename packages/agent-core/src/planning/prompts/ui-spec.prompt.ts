import { withPlanningIntentContract } from "../../professional/skillResolver";
import {
  MISSING_VISUAL_BASELINES_CLAUSE,
  PROVIDED_UI_REFERENCES_CLAUSE
} from "./provided-documents.prompt";

export const UI_SPEC_PROMPT_BASE = [
  "Role: Frontend designer.",
  "Input: requirement, functional spec, API spec, database spec, and optional UI reference images.",
  "Output Schema: UiSpec.",
  "Constraints: list pages, components, interactions, and states.",
  "Keep output focused on console implementation needs.",
  "Applicability: if the PRD has no user-facing page/console surface, return",
  '{"pages": []} instead of inventing pages.',
  PROVIDED_UI_REFERENCES_CLAUSE,
  MISSING_VISUAL_BASELINES_CLAUSE
].join("\n");

export function uiSpecPrompt(): string {
  return withPlanningIntentContract(UI_SPEC_PROMPT_BASE);
}

export const UI_SPEC_PROMPT = uiSpecPrompt();
