import { AgentDefinitionView, AgentRegistryDetail } from "@ai-se/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgent, getAgentMetrics, listAgents } from "../../api/agents";
import { useAgentsStore } from "../agents";

vi.mock("../../api/agents", () => ({
  getAgent: vi.fn(),
  getAgentMetrics: vi.fn(),
  listAgents: vi.fn()
}));

const definition: AgentDefinitionView = {
  name: "backend-agent",
  type: "BACKEND",
  description: "Backend",
  capabilities: ["BACKEND_CODE"],
  tools: ["read_file"],
  permissions: { tools: ["read_file"], pathPrefixes: ["apps/server"], readOnly: false },
  status: "available"
};

const detail: AgentRegistryDetail = { definition, runs: [], artifacts: [] };

describe("agents store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("loads registry, metrics, and agent detail", async () => {
    vi.mocked(listAgents).mockResolvedValue([definition]);
    vi.mocked(getAgentMetrics).mockResolvedValue({ agentSuccessRate: 1 });
    vi.mocked(getAgent).mockResolvedValue(detail);
    const store = useAgentsStore();
    await store.load();
    expect(store.agents).toEqual([definition]);
    expect(store.current).toEqual(detail);
    expect(store.metrics?.agentSuccessRate).toBe(1);
  });
});
