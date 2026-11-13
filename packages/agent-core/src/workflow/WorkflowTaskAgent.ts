import { Agent, AgentRunOptions } from "../agent/Agent";
import { AgentContext } from "../agent/AgentContext";
import { AgentResult } from "../agent/AgentResult";
import { AgentRunner, AgentRunnerOptions } from "../agent/AgentRunner";

const WORKFLOW_TASK_PROMPT = [
  "You execute one workflow task.",
  "Return a concise result summary for the supplied task.",
  "Do not create other agents, reveal hidden reasoning, or access external systems without tools."
].join("\n");

export class WorkflowTaskAgent implements Agent {
  readonly name = "workflow-task-agent";
  private readonly runner: AgentRunner;

  constructor(options: Omit<AgentRunnerOptions, "systemPrompt"> & { systemPrompt?: string }) {
    this.runner = new AgentRunner({
      ...options,
      systemPrompt: options.systemPrompt ?? WORKFLOW_TASK_PROMPT
    });
  }

  async run(task: string, context: AgentContext, options?: AgentRunOptions): Promise<AgentResult> {
    return await this.runner.run(task, context, options);
  }
}
