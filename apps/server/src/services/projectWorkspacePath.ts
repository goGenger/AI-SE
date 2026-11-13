import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../http/errors";

/**
 * Project-owned local workspace paths.
 *
 * Product choice: optional on create UI; when omitted the server allocates
 * `{agentWorkspaceRoot}/projects/{slug}-{shortId}` , creates the directory, and
 * persists it on the project — so auto-started slice workflows never fall back
 * to `process.cwd()` (apps/server).
 */

export function slugifyProjectName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "project";
}

export function defaultProjectWorkspacePath(
  agentWorkspaceRoot: string,
  projectName: string,
  projectId: string
): string {
  const shortId = projectId.replace(/-/g, "").slice(0, 8);
  return path.join(agentWorkspaceRoot, "projects", `${slugifyProjectName(projectName)}-${shortId}`);
}

function isInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate === resolvedRoot) return true;
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  return resolvedCandidate.startsWith(prefix);
}

/**
 * Validate absolute path under agentWorkspaceRoot and ensure the directory exists.
 * Returns the resolved absolute path.
 */
export async function ensureWorkspacePathUnderRoot(
  workspacePath: string,
  agentWorkspaceRoot: string
): Promise<string> {
  if (!workspacePath.startsWith("/")) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `目标工作区路径必须是本机绝对路径（以 / 开头）：${workspacePath}`
    );
  }
  const resolved = path.resolve(workspacePath);
  if (!isInsideRoot(agentWorkspaceRoot, resolved)) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `目标工作区路径必须位于 AGENT_WORKSPACE_ROOT（${path.resolve(agentWorkspaceRoot)}）之下：${workspacePath}`
    );
  }
  await mkdir(resolved, { recursive: true });
  return resolved;
}

/**
 * Resolve the durable path for a new project.
 * - If the client supplied one: validate + mkdir under root.
 * - If omitted: allocate `{root}/projects/{slug}-{shortId}` (shortId from projectId) + mkdir.
 */
export async function resolveProjectWorkspacePath(input: {
  requested?: string | undefined;
  projectName: string;
  projectId: string;
  agentWorkspaceRoot: string;
}): Promise<string> {
  const requested = input.requested?.trim();
  if (requested) {
    return await ensureWorkspacePathUnderRoot(requested, input.agentWorkspaceRoot);
  }
  const allocated = defaultProjectWorkspacePath(
    input.agentWorkspaceRoot,
    input.projectName,
    input.projectId
  );
  return await ensureWorkspacePathUnderRoot(allocated, input.agentWorkspaceRoot);
}
