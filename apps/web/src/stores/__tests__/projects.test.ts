import { type Project } from "@ai-se/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachProjectRepository,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProjectWorkspacePath
} from "../../api/projects";
import { useProjectsStore } from "../projects";

vi.mock("../../api/projects", () => ({
  attachProjectRepository: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  getProject: vi.fn(),
  listProjects: vi.fn(),
  updateProjectWorkspacePath: vi.fn()
}));

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "9becd595-23db-44cf-b79a-1e614271a6bc",
    name: "Demo",
    description: "",
    repository: null,
    workspacePath: null,
    status: "active",
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    ...overrides
  };
}

describe("projects store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.resetAllMocks();
  });

  it("exposes updateWorkspacePath as a callable action", () => {
    const store = useProjectsStore();
    expect(typeof store.updateWorkspacePath).toBe("function");
  });

  it("updateWorkspacePath calls API and syncs selectedProject + list", async () => {
    const existing = project({
      workspacePath: "/Users/shixianbao/Desktop/study/projects/old"
    });
    const updated = project({
      workspacePath: "/Users/shixianbao/Desktop/study/projects/new-app",
      updatedAt: "2026-11-05T01:00:00.000Z"
    });
    vi.mocked(updateProjectWorkspacePath).mockResolvedValue(updated);

    const store = useProjectsStore();
    store.projects = [existing];
    store.selectedProject = existing;

    const result = await store.updateWorkspacePath(
      existing.id,
      "/Users/shixianbao/Desktop/study/projects/new-app"
    );

    expect(updateProjectWorkspacePath).toHaveBeenCalledWith(
      existing.id,
      "/Users/shixianbao/Desktop/study/projects/new-app"
    );
    expect(result.workspacePath).toBe("/Users/shixianbao/Desktop/study/projects/new-app");
    expect(store.selectedProject?.workspacePath).toBe(
      "/Users/shixianbao/Desktop/study/projects/new-app"
    );
    expect(store.projects[0]?.workspacePath).toBe(
      "/Users/shixianbao/Desktop/study/projects/new-app"
    );
  });

  it("createProject still works alongside workspace-path action", async () => {
    const created = project({
      name: "Created",
      workspacePath: "/Users/shixianbao/Desktop/study/projects/created"
    });
    vi.mocked(createProject).mockResolvedValue(created);
    vi.mocked(listProjects).mockResolvedValue([created]);

    const store = useProjectsStore();
    await store.createProject({ name: "Created", description: "" });
    await store.fetchProjects();

    expect(store.projects).toEqual([created]);
    expect(typeof store.updateWorkspacePath).toBe("function");
    expect(typeof store.attachRepository).toBe("function");
    expect(getProject).not.toHaveBeenCalled();
    expect(deleteProject).not.toHaveBeenCalled();
    expect(attachProjectRepository).not.toHaveBeenCalled();
  });
});
