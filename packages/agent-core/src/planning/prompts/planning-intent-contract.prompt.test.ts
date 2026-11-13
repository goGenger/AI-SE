import { BACKEND_NODE_PROFILE, FRONTEND_VUE_PROFILE } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  getSkill,
  PLANNING_GRAPH_CONTRACT_STAGES,
  planningIntentContractBlock
} from "../../professional/skillResolver";
import { API_SPEC_PROMPT } from "./api-spec.prompt";
import { ARCHITECTURE_PROMPT } from "./architecture.prompt";
import { DATABASE_SPEC_PROMPT } from "./database-spec.prompt";
import { FUNCTIONAL_SPEC_PROMPT } from "./functional-spec.prompt";
import { REPAIR_PROMPT } from "./repair.prompt";
import { requirementAnalysisPrompt } from "./requirement-analysis.prompt";
import { slicePlanningPrompt } from "./slice-planning.prompt";
import { taskPlanningPrompt } from "./task-planning.prompt";
import { TECHNICAL_SPEC_PROMPT } from "./technical-spec.prompt";
import { uiSpecPrompt } from "./ui-spec.prompt";

describe("planning-intent-contract injection into the planning graph (docs/268)", () => {
  const contract = planningIntentContractBlock();
  const skill = getSkill("planning-intent-contract");

  it("loads the contract from the same SKILL.md used by resolveSkills", () => {
    expect(contract).toContain("### planning-intent-contract");
    expect(contract).toContain(skill.body.trim());
    expect(PLANNING_GRAPH_CONTRACT_STAGES).toEqual([
      "requirement_analysis",
      "slice_planning",
      "ui_spec",
      "task_planning"
    ]);
  });

  it("injects the contract into requirement, slice, UI spec, and task planning prompts", () => {
    const requirement = requirementAnalysisPrompt();
    const slice = slicePlanningPrompt({ profile: FRONTEND_VUE_PROFILE });
    const ui = uiSpecPrompt();
    const tasks = taskPlanningPrompt({ profile: FRONTEND_VUE_PROFILE });

    for (const prompt of [requirement, slice, ui, tasks]) {
      expect(prompt).toContain("### planning-intent-contract");
      expect(prompt).toContain(skill.body.trim());
    }
  });

  it("does not inject the contract into later spec or repair prompts", () => {
    for (const prompt of [
      FUNCTIONAL_SPEC_PROMPT,
      TECHNICAL_SPEC_PROMPT,
      ARCHITECTURE_PROMPT,
      API_SPEC_PROMPT,
      DATABASE_SPEC_PROMPT,
      REPAIR_PROMPT
    ]) {
      expect(prompt).not.toContain("### planning-intent-contract");
      expect(prompt).not.toContain("planning-intent-contract");
    }
  });

  it("applies the capability-profile rule to slice planning under frontend-vue", () => {
    const prompt = slicePlanningPrompt({ profile: FRONTEND_VUE_PROFILE });
    expect(prompt).toContain("Capability profile: frontend-vue");
    expect(prompt).toContain("does not enable backend or database work");
    expect(prompt).toContain("Set involvesData=false on every slice");
    expect(prompt).toContain("visualBaselineGaps");
    expect(prompt).toContain("acceptanceCriteria");
  });

  it("keeps data-layer slices available under backend-node", () => {
    const prompt = slicePlanningPrompt({ profile: BACKEND_NODE_PROFILE });
    expect(prompt).toContain("Capability profile: backend-node");
    expect(prompt).toContain(
      "Set involvesData=false only when the slice introduces no data-layer changes"
    );
    expect(prompt).not.toContain("Set involvesData=false on every slice");
  });
});
