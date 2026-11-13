import { Agent, AgentRunOptions } from "../agent/Agent";
import { AgentContext } from "../agent/AgentContext";
import { AgentResult } from "../agent/AgentResult";
import { AgentRunner, AgentRunnerOptions } from "../agent/AgentRunner";

export const CODING_AGENT_SYSTEM_PROMPT = [
  "You are a Software Engineer.",
  "Analyze code issues, find the root cause, edit code through tools, run tests, and continue fixing based on test results.",
  "Use tools for every filesystem, git, command, lint, test, and build action.",
  "Do not reveal hidden chain-of-thought or private reasoning.",
  "When finished, return a concise structured result with status, files changed, tests run, and final summary."
].join("\n");

export class CodingAgent implements Agent {
  readonly name = "coding-agent";
  private readonly runner: AgentRunner;

  constructor(options: Omit<AgentRunnerOptions, "systemPrompt"> & { systemPrompt?: string }) {
    this.runner = new AgentRunner({
      ...options,
      systemPrompt: options.systemPrompt ?? CODING_AGENT_SYSTEM_PROMPT
    });
  }

  async run(task: string, context: AgentContext, options?: AgentRunOptions): Promise<AgentResult> {
    return await this.runner.run(task, context, options);
  }
}
