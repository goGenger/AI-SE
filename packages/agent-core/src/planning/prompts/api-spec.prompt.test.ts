import { BACKEND_NODE_PROFILE, FRONTEND_VUE_PROFILE } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { API_SPEC_PROMPT, apiSpecPrompt } from "./api-spec.prompt";
import { ARCHITECTURE_PROMPT, architecturePrompt } from "./architecture.prompt";

describe("api-spec and architecture prompts (docs/269)", () => {
  it("frontend-vue consumes API contracts and plans frontend encapsulation", () => {
    const prompt = apiSpecPrompt({ profile: FRONTEND_VUE_PROFILE });
    expect(prompt).toContain("Frontend API encapsulation planner");
    expect(prompt).toContain("consumes API contracts as input");
    expect(prompt).toContain("encapsulation");
    expect(prompt).toContain("apiContractGaps");
    expect(prompt).toContain("Do not invent a server-side API");
    expect(prompt).not.toContain("Role: API designer.");
    expect(API_SPEC_PROMPT).toContain("Frontend API encapsulation planner");
  });

  it("backend-node keeps the generate-an-API-spec prompt", () => {
    const prompt = apiSpecPrompt({ profile: BACKEND_NODE_PROFILE });
    expect(prompt).toContain("Role: API designer.");
    expect(prompt).toContain("never invent endpoints to fill the schema");
    expect(prompt).not.toContain("Frontend API encapsulation planner");
    expect(prompt).not.toContain("apiContractGaps");
  });

  it("frontend-vue architecture does not invent backend or server APIs", () => {
    const prompt = architecturePrompt({ profile: FRONTEND_VUE_PROFILE });
    expect(prompt).toContain("frontend components");
    expect(prompt).toContain("Do not invent backend services, databases, or a server-side API");
    expect(ARCHITECTURE_PROMPT).toContain("Do not invent backend services, databases, or a server-side API");
  });

  it("backend-node architecture keeps the existing generate prompt", () => {
    const prompt = architecturePrompt({ profile: BACKEND_NODE_PROFILE });
    expect(prompt).toContain("Role: Application architect.");
    expect(prompt).toContain("list components, responsibilities, dependencies, and data flow.");
    expect(prompt).not.toContain("Do not invent backend services, databases, or a server-side API");
  });
});
