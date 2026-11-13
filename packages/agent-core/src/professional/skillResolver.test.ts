import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKEND_NODE_PROFILE, FRONTEND_VUE_PROFILE, Task } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { AgentRegistry, PROFESSIONAL_AGENT_DEFINITIONS } from "./AgentRegistry";
import {
  formatInjectedSkillsBlock,
  getSkill,
  listFrontendVueSkills,
  planningIntentContractBlock,
  PLANNING_GRAPH_CONTRACT_STAGES,
  resolveSkills,
  skillsRoot,
  withInjectedSkills,
  withPlanningIntentContract
} from "./skillResolver";

function task(type: Task["type"], input = {}): Task {
  return {
    id: "task-1",
    projectId: "project-1",
    taskKey: "TASK-1",
    title: "Task",
    description: "Task",
    type,
    status: "READY",
    priority: "MEDIUM",
    input,
    retryCount: 0,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

const VISUAL_IDS = ["visual-intent-contract", "vue-visual-contract"] as const;

/** Framework / library names the generic contract skill must not mention. */
const FORBIDDEN_FRAMEWORK_TERMS = [
  "vue",
  "react",
  "angular",
  "svelte",
  "element-plus",
  "element plus",
  "elementplus",
  "ant design",
  "antd",
  "naive-ui",
  "naive ui",
  "vuetify",
  "pinia",
  "redux",
  "next.js",
  "nextjs",
  "nuxt",
  "shadcn",
  "tailwind",
  "chakra",
  "mui",
  "material ui",
  "bootstrap"
] as const;

function idsOf(input: Parameters<typeof resolveSkills>[0]): string[] {
  return resolveSkills(input).map((s) => s.id);
}

describe("skillResolver bind matrix (docs/252)", () => {
  it("loads the frontend-vue skills from disk", () => {
    const skills = listFrontendVueSkills();
    expect(skills.map((s) => s.id)).toEqual([
      "vue-visual-contract",
      "vue-implement",
      "vue-test-fixture",
      "vue-debug-repair"
    ]);
    for (const skill of skills) {
      expect(skill.body.length).toBeGreaterThan(80);
      expect(skill.binds.capabilityProfiles).toContain("frontend-vue");
    }
  });

  it("FRONTEND + frontend-vue → vue-implement + vue-test-fixture (plus visual contract)", () => {
    expect(idsOf({ taskType: "FRONTEND", capabilityProfile: "frontend-vue" })).toEqual([
      "visual-intent-contract",
      "vue-visual-contract",
      "vue-implement",
      "vue-test-fixture"
    ]);
  });

  it("TEST → test-quality-contract + vue-test-fixture", () => {
    expect(idsOf({ taskType: "TEST", capabilityProfile: "frontend-vue" })).toEqual([
      "test-quality-contract",
      "vue-test-fixture"
    ]);
  });

  it("DEBUG → visual contract + vue-test-fixture + vue-debug-repair", () => {
    expect(idsOf({ taskType: "DEBUG", capabilityProfile: "frontend-vue" })).toEqual([
      "visual-intent-contract",
      "vue-visual-contract",
      "vue-test-fixture",
      "vue-debug-repair"
    ]);
  });

  it("TEST_FIXTURE_GAP adds fixture + debug repair on FRONTEND", () => {
    expect(
      idsOf({
        taskType: "FRONTEND",
        failureClass: "TEST_FIXTURE_GAP",
        capabilityProfile: "frontend-vue"
      })
    ).toEqual([
      "visual-intent-contract",
      "vue-visual-contract",
      "vue-implement",
      "vue-test-fixture",
      "vue-debug-repair"
    ]);
  });

  it("SPEC_CONFLICT → vue-test-fixture only", () => {
    expect(
      idsOf({
        taskType: "FRONTEND",
        failureClass: "SPEC_CONFLICT",
        capabilityProfile: "frontend-vue"
      })
    ).toEqual(["vue-test-fixture"]);
  });

  it("format block uses Injected skills markers and createPinia guidance", () => {
    const block = formatInjectedSkillsBlock(
      resolveSkills({ taskType: "FRONTEND", capabilityProfile: "frontend-vue" })
    );
    expect(block).toContain("## Injected skills");
    expect(block).toContain("### visual-intent-contract");
    expect(block).toContain("### vue-visual-contract");
    expect(block).toContain("### vue-implement");
    expect(block).toContain("createPinia");
  });
});

describe("visual intent skills (docs/265)", () => {
  it("generic contract text contains no framework or component-library names", () => {
    const root = skillsRoot();
    expect(root).toBeDefined();
    const raw = readFileSync(join(root!, "common", "visual-intent-contract", "SKILL.md"), "utf8");
    const haystack = raw.toLowerCase();
    const hits = FORBIDDEN_FRAMEWORK_TERMS.filter((term) => haystack.includes(term));
    expect(hits).toEqual([]);
    const skill = getSkill("visual-intent-contract");
    expect(skill.binds.capabilityProfiles).toEqual([]);
    expect(skill.body).toMatch(/encapsulation layer/i);
    expect(skill.body).toMatch(/design tokens/i);
    expect(skill.body).toMatch(/design intent/i);
    expect(skill.body).toMatch(/official visual gate/i);
  });

  it("frontend-vue implement and repair tasks inject the generic contract and the Vue mapping", () => {
    for (const taskType of ["FRONTEND", "DEBUG"] as const) {
      const ids = idsOf({ taskType, capabilityProfile: "frontend-vue" });
      expect(ids).toContain("visual-intent-contract");
      expect(ids).toContain("vue-visual-contract");
    }
  });

  it("non-Vue frontend profile may get the generic contract but never the Vue mapping", () => {
    expect(idsOf({ taskType: "FRONTEND", capabilityProfile: "frontend-react" })).toEqual([
      "visual-intent-contract"
    ]);
    expect(idsOf({ taskType: "DEBUG", capabilityProfile: "frontend-react" })).toEqual([
      "visual-intent-contract"
    ]);
    expect(idsOf({ taskType: "TEST", capabilityProfile: "frontend-react" })).toEqual([
      "test-quality-contract"
    ]);
  });

  it("backend-node FRONTEND gets only the generic contract", () => {
    expect(idsOf({ taskType: "FRONTEND", capabilityProfile: "backend-node" })).toEqual([
      "visual-intent-contract"
    ]);
  });

  it("non-UI task types do not inject either visual skill", () => {
    const nonUi = ["TEST", "BACKEND", "REVIEW", "BUILD", "DATABASE", "ANALYSIS", "DESIGN"] as const;
    for (const taskType of nonUi) {
      const vueIds = idsOf({ taskType, capabilityProfile: "frontend-vue" });
      const backendIds = idsOf({ taskType, capabilityProfile: "backend-node" });
      for (const id of VISUAL_IDS) {
        expect(vueIds).not.toContain(id);
        expect(backendIds).not.toContain(id);
      }
    }
    expect(
      idsOf({
        taskType: "DEBUG",
        capabilityProfile: "backend-node"
      })
    ).not.toEqual(expect.arrayContaining([...VISUAL_IDS]));
    for (const id of VISUAL_IDS) {
      expect(idsOf({ taskType: "DEBUG", capabilityProfile: "backend-node" })).not.toContain(id);
    }
  });
});

describe("AgentRegistry.resolveTask injects skills for frontend-vue", () => {
  it("FRONTEND instructions include skill markers and keep createPinia anti-tamper", () => {
    const registry = new AgentRegistry(PROFESSIONAL_AGENT_DEFINITIONS, FRONTEND_VUE_PROFILE);
    const definition = registry.resolveTask(task("FRONTEND"));
    expect(definition.systemInstructions).toContain("## Injected skills");
    expect(definition.systemInstructions).toContain("### visual-intent-contract");
    expect(definition.systemInstructions).toContain("### vue-visual-contract");
    expect(definition.systemInstructions).toContain("### vue-implement");
    expect(definition.systemInstructions).toContain("### vue-test-fixture");
    expect(definition.systemInstructions).toMatch(/createPinia\(\)/);
    expect(definition.systemInstructions).toMatch(
      /Never weaken, relax, or delete an existing assertion/
    );
  });

  it("TEST injects test-quality-contract and vue-test-fixture", () => {
    const registry = new AgentRegistry(PROFESSIONAL_AGENT_DEFINITIONS, FRONTEND_VUE_PROFILE);
    const definition = registry.resolveTask(task("TEST"));
    expect(definition.systemInstructions).toContain("### test-quality-contract");
    expect(definition.systemInstructions).toContain("### vue-test-fixture");
    expect(definition.systemInstructions).not.toContain("### vue-implement");
    expect(definition.systemInstructions).not.toContain("### visual-intent-contract");
    expect(definition.systemInstructions).not.toContain("### vue-visual-contract");
    expect(definition.systemInstructions).not.toContain("### review-evidence-contract");
    expect(definition.systemInstructions).not.toContain("### planning-intent-contract");
  });

  it("DEBUG injects debug-repair; input failureClass shapes FRONTEND", () => {
    const registry = new AgentRegistry(PROFESSIONAL_AGENT_DEFINITIONS, FRONTEND_VUE_PROFILE);
    const debug = registry.resolveTask(task("DEBUG", { targetTaskType: "FRONTEND" }));
    expect(debug.systemInstructions).toContain("### vue-debug-repair");
    expect(debug.systemInstructions).toContain("### vue-test-fixture");
    expect(debug.systemInstructions).toContain("### visual-intent-contract");
    expect(debug.systemInstructions).toContain("### vue-visual-contract");

    const fixtureFrontend = registry.resolveTask(
      task("FRONTEND", { failureClass: "TEST_FIXTURE_GAP" })
    );
    expect(fixtureFrontend.systemInstructions).toContain("### vue-debug-repair");
  });

  it("backend-node FRONTEND resolve does not inject vue skills", () => {
    const registry = new AgentRegistry(PROFESSIONAL_AGENT_DEFINITIONS, BACKEND_NODE_PROFILE);
    const definition = registry.resolveTask(task("FRONTEND"));
    expect(definition.systemInstructions).toContain("## Injected skills");
    expect(definition.systemInstructions).toContain("### visual-intent-contract");
    expect(definition.systemInstructions).not.toContain("### vue-visual-contract");
    expect(definition.systemInstructions).not.toContain("### vue-implement");
    expect(definition.systemInstructions).not.toContain("### vue-test-fixture");
    expect(definition.systemInstructions).not.toContain("### vue-debug-repair");
  });

  it("withInjectedSkills returns same object when nothing matches", () => {
    const base = { systemInstructions: "base only" };
    expect(withInjectedSkills(base, { taskType: "BUILD", capabilityProfile: "frontend-vue" })).toBe(
      base
    );
  });
});

describe("planning / test quality / review contracts (docs/267)", () => {
  const COMMON_CONTRACT_IDS = [
    "planning-intent-contract",
    "test-quality-contract",
    "review-evidence-contract"
  ] as const;

  it("generic contract text contains no framework or component-library names", () => {
    const rootDir = skillsRoot();
    expect(rootDir).toBeDefined();
    for (const id of COMMON_CONTRACT_IDS) {
      const raw = readFileSync(join(rootDir!, "common", id, "SKILL.md"), "utf8");
      const haystack = raw.toLowerCase();
      const hits = FORBIDDEN_FRAMEWORK_TERMS.filter((term) => haystack.includes(term));
      expect({ id, hits }).toEqual({ id, hits: [] });
      const skill = getSkill(id);
      expect(skill.binds.capabilityProfiles).toEqual([]);
      expect(skill.body.length).toBeGreaterThan(80);
    }
  });

  it("ANALYSIS and DESIGN inject only the planning contract on any profile", () => {
    for (const taskType of ["ANALYSIS", "DESIGN"] as const) {
      expect(idsOf({ taskType, capabilityProfile: "frontend-vue" })).toEqual([
        "planning-intent-contract"
      ]);
      expect(idsOf({ taskType, capabilityProfile: "backend-node" })).toEqual([
        "planning-intent-contract"
      ]);
      expect(idsOf({ taskType, capabilityProfile: "frontend-react" })).toEqual([
        "planning-intent-contract"
      ]);
    }
  });

  it("TEST injects the quality contract on every profile, plus vue-test-fixture only on frontend-vue", () => {
    expect(idsOf({ taskType: "TEST", capabilityProfile: "frontend-vue" })).toEqual([
      "test-quality-contract",
      "vue-test-fixture"
    ]);
    expect(idsOf({ taskType: "TEST", capabilityProfile: "backend-node" })).toEqual([
      "test-quality-contract"
    ]);
    expect(idsOf({ taskType: "TEST", capabilityProfile: "frontend-react" })).toEqual([
      "test-quality-contract"
    ]);
  });

  it("REVIEW injects only the evidence contract, including on non-Vue profiles", () => {
    expect(idsOf({ taskType: "REVIEW", capabilityProfile: "frontend-vue" })).toEqual([
      "review-evidence-contract"
    ]);
    expect(idsOf({ taskType: "REVIEW", capabilityProfile: "backend-node" })).toEqual([
      "review-evidence-contract"
    ]);
  });

  it("FRONTEND still gets visual + vue skills and not the review or planning contracts", () => {
    expect(idsOf({ taskType: "FRONTEND", capabilityProfile: "frontend-vue" })).toEqual([
      "visual-intent-contract",
      "vue-visual-contract",
      "vue-implement",
      "vue-test-fixture"
    ]);
    const ids = idsOf({ taskType: "FRONTEND", capabilityProfile: "frontend-vue" });
    expect(ids).not.toContain("review-evidence-contract");
    expect(ids).not.toContain("planning-intent-contract");
    expect(ids).not.toContain("test-quality-contract");
  });

  it("DEBUG does not receive the test-quality contract", () => {
    expect(idsOf({ taskType: "DEBUG", capabilityProfile: "frontend-vue" })).not.toContain(
      "test-quality-contract"
    );
    expect(idsOf({ taskType: "DEBUG", capabilityProfile: "backend-node" })).not.toContain(
      "test-quality-contract"
    );
  });

  it("SPEC_CONFLICT does not gain the new common contracts", () => {
    expect(
      idsOf({
        taskType: "FRONTEND",
        failureClass: "SPEC_CONFLICT",
        capabilityProfile: "frontend-vue"
      })
    ).toEqual(["vue-test-fixture"]);
  });

  it("BACKEND and DATABASE do not receive the three common contracts or Vue skills", () => {
    for (const taskType of ["BACKEND", "DATABASE"] as const) {
      expect(idsOf({ taskType, capabilityProfile: "frontend-vue" })).toEqual([]);
      expect(idsOf({ taskType, capabilityProfile: "backend-node" })).toEqual([]);
    }
  });

  it("AgentRegistry injects the new contracts on ANALYSIS, TEST, and REVIEW", () => {
    const registry = new AgentRegistry(PROFESSIONAL_AGENT_DEFINITIONS, FRONTEND_VUE_PROFILE);
    const analysis = registry.resolveTask(task("ANALYSIS"));
    expect(analysis.systemInstructions).toContain("### planning-intent-contract");
    expect(analysis.systemInstructions).not.toContain("### vue-implement");

    const review = registry.resolveTask(task("REVIEW"));
    expect(review.systemInstructions).toContain("### review-evidence-contract");
    expect(review.systemInstructions).not.toContain("### visual-intent-contract");
    expect(review.systemInstructions).not.toContain("### vue-visual-contract");
  });
});

describe("planning graph contract loader (docs/268)", () => {
  it("reads the same SKILL.md as resolveSkills and can be appended once", () => {
    const skill = getSkill("planning-intent-contract");
    const block = planningIntentContractBlock();
    expect(PLANNING_GRAPH_CONTRACT_STAGES).toContain("slice_planning");
    expect(block).toContain("### planning-intent-contract");
    expect(block).toContain(skill.body.trim());

    const once = withPlanningIntentContract("Base prompt.");
    expect(once.startsWith("Base prompt.")).toBe(true);
    expect(once).toContain(block);
    expect(withPlanningIntentContract(once)).toBe(once);
  });
});
