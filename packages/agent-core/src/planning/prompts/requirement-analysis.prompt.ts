import { withPlanningIntentContract } from "../../professional/skillResolver";
import {
  CONFLICT_RESOLUTIONS_CLAUSE,
  MISSING_VISUAL_BASELINES_CLAUSE,
  PROVIDED_TECHNICAL_DOCUMENTS_CLAUSE
} from "./provided-documents.prompt";

export const REQUIREMENT_ANALYSIS_PROMPT_BASE = [
  "Role: Requirement analyst for AI-SE Phase 3.",
  "Input: one software requirement or PRD.",
  "Output Schema: RequirementAnalysis.",
  "Constraints: summarize goals, constraints, assumptions, risks, and acceptance criteria.",
  "Do not invent unspecified requirements. Mark necessary assumptions explicitly.",
  PROVIDED_TECHNICAL_DOCUMENTS_CLAUSE,
  CONFLICT_RESOLUTIONS_CLAUSE,
  MISSING_VISUAL_BASELINES_CLAUSE
].join("\n");

export function requirementAnalysisPrompt(): string {
  return withPlanningIntentContract(REQUIREMENT_ANALYSIS_PROMPT_BASE);
}

/** 默认合成（含 planning-intent-contract）；测试或需要即时重读 skill 时请用函数。 */
export const REQUIREMENT_ANALYSIS_PROMPT = requirementAnalysisPrompt();
