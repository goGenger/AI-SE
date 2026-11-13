import { AgentRegistry } from "@ai-se/agent-core";
import { PgAgentArtifactRepository, PgAgentRunStore } from "@ai-se/database";
import { AgentDefinitionView } from "@ai-se/shared";

export class AgentRegistryService {
  constructor(
    private readonly dependencies: {
      registry: AgentRegistry;
      agentRuns: PgAgentRunStore;
      artifacts: PgAgentArtifactRepository;
    }
  ) {}

  list(): AgentDefinitionView[] {
    return this.dependencies.registry
      .listEnabled()
      .map((agent) => this.dependencies.registry.toView(agent));
  }

  async detail(name: string) {
    const definition = this.dependencies.registry.toView(this.dependencies.registry.get(name));
    const [runs, artifacts] = await Promise.all([
      this.dependencies.agentRuns.findMany(),
      this.dependencies.artifacts.findMany(name)
    ]);
    return {
      definition,
      runs: runs.filter((run) => run.input.agentName === name).slice(0, 25),
      artifacts
    };
  }

  async metrics() {
    return await this.dependencies.artifacts.metrics();
  }
}
