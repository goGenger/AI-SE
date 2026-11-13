import { AgentRegistry, PROFESSIONAL_AGENT_DEFINITIONS } from "@ai-se/agent-core";
import { BACKEND_NODE_PROFILE, FRONTEND_VUE_PROFILE } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { AgentRegistryService } from "../services/agentRegistryService";

const stubs = {
  agentRuns: { findMany: async () => [] },
  artifacts: { findMany: async () => [], metrics: async () => ({}) }
};

function serviceFor(profile: typeof FRONTEND_VUE_PROFILE) {
  return new AgentRegistryService({
    registry: new AgentRegistry(PROFESSIONAL_AGENT_DEFINITIONS, profile),
    agentRuns: stubs.agentRuns as never,
    artifacts: stubs.artifacts as never
  });
}

describe("AgentRegistryService.list", () => {
  it("omits BACKEND and DATABASE under frontend-vue", () => {
    const names = serviceFor(FRONTEND_VUE_PROFILE)
      .list()
      .map((agent) => agent.name);
    expect(names).toEqual([
      "planner-agent",
      "frontend-agent",
      "qa-agent",
      "reviewer-agent",
      "devops-agent"
    ]);
    expect(names).not.toContain("backend-agent");
    expect(names).not.toContain("database-agent");
  });

  it("includes BACKEND and DATABASE under backend-node", () => {
    expect(
      serviceFor(BACKEND_NODE_PROFILE)
        .list()
        .map((agent) => agent.name)
    ).toEqual([
      "planner-agent",
      "frontend-agent",
      "backend-agent",
      "database-agent",
      "qa-agent",
      "reviewer-agent",
      "devops-agent"
    ]);
  });
});
