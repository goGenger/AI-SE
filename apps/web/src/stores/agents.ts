import { AgentDefinitionView, AgentEvaluationMetrics, AgentRegistryDetail } from "@ai-se/shared";
import { defineStore } from "pinia";
import { getAgent, getAgentMetrics, listAgents } from "../api/agents";

interface State {
  agents: AgentDefinitionView[];
  current: AgentRegistryDetail | null;
  metrics: AgentEvaluationMetrics | null;
  loading: boolean;
  error: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Agent 请求失败";
}

export const useAgentsStore = defineStore("agents", {
  state: (): State => ({ agents: [], current: null, metrics: null, loading: false, error: "" }),
  actions: {
    async load() {
      this.loading = true;
      this.error = "";
      try {
        [this.agents, this.metrics] = await Promise.all([listAgents(), getAgentMetrics()]);
        if (!this.current && this.agents[0]) await this.select(this.agents[0].name);
      } catch (error) {
        this.error = message(error);
      } finally {
        this.loading = false;
      }
    },
    async select(name: string) {
      this.loading = true;
      this.error = "";
      try {
        this.current = await getAgent(name);
      } catch (error) {
        this.error = message(error);
      } finally {
        this.loading = false;
      }
    }
  }
});
