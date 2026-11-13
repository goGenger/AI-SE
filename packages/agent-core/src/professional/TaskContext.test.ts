import { AgentArtifact, AgentRun, Project, Specification, Task } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { AgentRegistry } from "./AgentRegistry";
import { TaskContext, isolateTaskContext } from "./TaskContext";

const project: Project = {
  id: "project",
  name: "Project",
  description: "",
  repository: "https://example.com/repo",
  workspacePath: null,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const task: Task = {
  id: "task",
  projectId: project.id,
  taskKey: "TASK",
  title: "Task",
  description: "Task",
  type: "FRONTEND",
  status: "READY",
  priority: "MEDIUM",
  input: {},
  retryCount: 0,
  version: 1,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt
};

function specification(type: Specification["type"]): Specification {
  return {
    id: type,
    projectId: project.id,
    requirementId: "requirement",
    type,
    version: 1,
    status: "VALIDATED",
    content: {},
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
}

const context: TaskContext = {
  project,
  requirement: undefined,
  task,
  specifications: [specification("UI"), specification("API"), specification("DATABASE")],
  dependencyResults: [],
  relevantFiles: [],
  previousAttempts: [] as AgentRun[],
  testResults: [] as AgentArtifact[],
  reviewResults: [] as AgentArtifact[]
};

describe("TaskContext isolation", () => {
  it("gives frontend and backend agents only their relevant specifications", () => {
    const registry = new AgentRegistry();
    expect(
      isolateTaskContext(registry.get("frontend-agent"), context).specifications.map(
        (entry) => entry.type
      )
    ).toEqual(["UI", "API"]);
    expect(
      isolateTaskContext(registry.get("backend-agent"), context).specifications.map(
        (entry) => entry.type
      )
    ).toEqual(["API", "DATABASE"]);
  });
});
