import { z } from "zod";
import { ToolExecutionError } from "../errors";
import { ToolDefinition } from "../types";
import { commandFailureDetails, normalizeRelativePath, shellQuote } from "./shell";

const GitStatusInputSchema = z.object({
  cwd: z.string().min(1).optional().describe("Workspace-relative path; omit for the workspace root")
});

const GitDiffInputSchema = z.object({
  path: z.string().min(1).optional(),
  cwd: z.string().min(1).optional().describe("Workspace-relative path; omit for the workspace root")
});

export function createGitTools(): ToolDefinition<unknown, unknown>[] {
  return [gitStatusTool, gitDiffTool];
}

const gitStatusTool: ToolDefinition<z.infer<typeof GitStatusInputSchema>, { status: string }> = {
  name: "git_status",
  description: "Show git status for the sandbox workspace.",
  riskLevel: "LOW",
  inputSchema: GitStatusInputSchema,
  async execute(input, context) {
    const result = await context.sandbox.runCommand(
      context.workspacePath,
      {
        command: "git status --short",
        cwd: input.cwd ? normalizeRelativePath(input.cwd, "cwd") : undefined,
        timeoutMs: context.timeoutMs
      },
      context.signal
    );

    if (result.exitCode !== 0) {
      throw new ToolExecutionError(
        "COMMAND_ERROR",
        "Failed to read git status",
        commandFailureDetails(result.command, result.exitCode, result.stdout, result.stderr)
      );
    }

    return { status: result.stdout };
  }
};

const gitDiffTool: ToolDefinition<z.infer<typeof GitDiffInputSchema>, { diff: string }> = {
  name: "git_diff",
  description: "Show git diff for the sandbox workspace.",
  riskLevel: "LOW",
  inputSchema: GitDiffInputSchema,
  async execute(input, context) {
    const filePath = input.path ? normalizeRelativePath(input.path) : "";
    const command = filePath ? `git diff -- ${shellQuote(filePath)}` : "git diff";
    const result = await context.sandbox.runCommand(
      context.workspacePath,
      {
        command,
        cwd: input.cwd ? normalizeRelativePath(input.cwd, "cwd") : undefined,
        timeoutMs: context.timeoutMs
      },
      context.signal
    );

    if (result.exitCode !== 0) {
      throw new ToolExecutionError(
        "COMMAND_ERROR",
        "Failed to read git diff",
        commandFailureDetails(result.command, result.exitCode, result.stdout, result.stderr)
      );
    }

    return { diff: result.stdout };
  }
};
