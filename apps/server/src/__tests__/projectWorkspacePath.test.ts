import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../http/errors";
import {
  defaultProjectWorkspacePath,
  ensureWorkspacePathUnderRoot,
  resolveProjectWorkspacePath,
  slugifyProjectName
} from "../services/projectWorkspacePath";

describe("projectWorkspacePath", () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "ai-se-ws-"));
    roots.push(root);
    return root;
  }

  it("slugifies project names", () => {
    expect(slugifyProjectName(" My Vue App ")).toBe("my-vue-app");
    expect(slugifyProjectName("!!!")).toBe("project");
  });

  it("allocates under AGENT_WORKSPACE_ROOT/projects/{slug}-{shortId}", async () => {
    const root = await tempRoot();
    const id = "abcdef12-3456-7890-abcd-ef1234567890";
    const allocated = defaultProjectWorkspacePath(root, "TaskFlow", id);
    expect(allocated).toBe(path.join(root, "projects", "taskflow-abcdef12"));

    const resolved = await resolveProjectWorkspacePath({
      projectName: "TaskFlow",
      projectId: id,
      agentWorkspaceRoot: root
    });
    expect(resolved).toBe(allocated);
    expect((await stat(resolved)).isDirectory()).toBe(true);
  });

  it("accepts an explicit path under the root and creates it", async () => {
    const root = await tempRoot();
    const target = path.join(root, "custom", "app");
    const resolved = await resolveProjectWorkspacePath({
      requested: target,
      projectName: "X",
      projectId: "11111111-1111-1111-1111-111111111111",
      agentWorkspaceRoot: root
    });
    expect(resolved).toBe(path.resolve(target));
    expect((await stat(resolved)).isDirectory()).toBe(true);
  });

  it("rejects paths outside the root and relative paths", async () => {
    const root = await tempRoot();
    await expect(
      ensureWorkspacePathUnderRoot("/tmp/outside-ai-se-workspace", root)
    ).rejects.toBeInstanceOf(AppError);
    await expect(ensureWorkspacePathUnderRoot("relative/path", root)).rejects.toBeInstanceOf(
      AppError
    );
  });
});
