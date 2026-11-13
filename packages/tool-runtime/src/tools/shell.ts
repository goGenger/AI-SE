import path from "node:path";
import { ToolExecutionError } from "../errors";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Agents naturally address the sandbox workspace as `/` or `/workspace`
 * (that is where the sandbox mounts it — observed: five consecutive
 * `git_status` calls with cwd `/`, `/workspace`, `/.`). Map those aliases to
 * workspace-relative form BEFORE the boundary check; genuinely-outside
 * absolute paths (e.g. `/etc`) still fail the check.
 */
function stripWorkspaceAlias(input: string): string {
  if (input === "/" || input === "/." || input === "/workspace") return ".";
  if (input.startsWith("/workspace/")) return input.slice("/workspace/".length);
  return input;
}

export function normalizeRelativePath(input: string, fieldName = "path"): string {
  const trimmed = stripWorkspaceAlias(input.trim());
  const normalized = path.posix.normalize(trimmed || ".");

  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new ToolExecutionError("TOOL_ERROR", `${fieldName} must stay inside the workspace`);
  }

  return normalized;
}

export function commandFailureDetails(
  command: string,
  exitCode: number | null,
  stdout: string,
  stderr: string
) {
  return {
    command,
    exitCode,
    stdout,
    stderr,
    summary: stderr.trim() || stdout.trim() || `Command exited with ${exitCode}`
  };
}
