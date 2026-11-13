import { ProjectRepository } from "@ai-se/database";
import {
  AgentRun,
  AgentRunView,
  CreateProjectData,
  JsonObject,
  Project,
  ToolCallAudit,
  WorkflowEvent
} from "@ai-se/shared";
import { randomUUID } from "crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createLogger } from "@ai-se/observability";
import { AgentRunService } from "../services/agentRunService";
import { MemoryCancellationStore } from "../services/cancellationStore";

const runDockerTests = process.env.AI_SE_SKIP_DOCKER_TESTS !== "1";

function createMemoryRepository(): ProjectRepository {
  const projects = new Map<string, Project>();

  return {
    async create(input: CreateProjectData) {
      const now = new Date().toISOString();
      const project: Project = {
        id: randomUUID(),
        name: input.name,
        description: input.description,
        repository: input.repository ?? null,
        workspacePath: input.workspacePath ?? null,
        status: input.status,
        createdAt: now,
        updatedAt: now
      };
      projects.set(project.id, project);
      return project;
    },
    async findMany() {
      return Array.from(projects.values());
    },
    async findById(id: string) {
      return projects.get(id) ?? null;
    },
    async attachRepository(id: string, url: string) {
      const project = projects.get(id);
      if (!project) return null;
      const updated: Project = {
        ...project,
        repository: url,
        updatedAt: new Date().toISOString()
      };
      projects.set(id, updated);
      return updated;
    },
    async updateWorkspacePath(id: string, workspacePath: string) {
      const project = projects.get(id);
      if (!project) return null;
      const updated: Project = {
        ...project,
        workspacePath,
        updatedAt: new Date().toISOString()
      };
      projects.set(id, updated);
      return updated;
    },
    async deleteById(id: string) {
      return projects.delete(id);
    }
  };
}

function now(): string {
  return new Date().toISOString();
}

function createMemoryAgentRunService(repository: ProjectRepository): AgentRunService {
  const runs = new Map<string, AgentRun>();
  const toolCalls = new Map<string, ToolCallAudit>();
  const events: WorkflowEvent[] = [];

  return new AgentRunService({
    agentRuns: {
      async create(input) {
        const createdAt = now();
        const run: AgentRun = {
          id: input.id ?? randomUUID(),
          projectId: input.projectId,
          taskId: input.taskId,
          status: input.status ?? "created",
          input: input.input,
          currentIteration: 0,
          maxIterations: input.maxIterations,
          retryCount: 0,
          createdAt,
          updatedAt: createdAt
        };
        runs.set(run.id, run);
        return run;
      },
      async findMany() {
        return Array.from(runs.values()).map((run) => ({
          ...run,
          projectName: null,
          workflowRunId: null,
          requirementName: null,
          planningVersion: null,
          taskKey: null,
          taskTitle: null,
          agentName: null,
          agentType: null
        }));
      },
      async findContext() {
        return {
          projectName: null,
          workflow: null,
          task: null,
          agentName: null,
          agentType: null,
          maxRetries: null
        };
      },
      async findById(id) {
        return runs.get(id) ?? null;
      },
      async update(id, patch) {
        const run = runs.get(id);
        if (!run) {
          return null;
        }
        const updated: AgentRun = {
          ...run,
          ...patch,
          updatedAt: now()
        };
        runs.set(id, updated);
        return updated;
      },
      async markCancellationRequested(id) {
        const run = runs.get(id);
        if (!run) {
          return null;
        }
        const updated: AgentRun = {
          ...run,
          status: run.status === "created" || run.status === "running" ? "cancelling" : run.status,
          updatedAt: now()
        };
        runs.set(id, updated);
        return updated;
      }
    },
    toolCalls: {
      async start(input) {
        const id = randomUUID();
        const toolCall: ToolCallAudit = {
          id,
          agentRunId: input.agentRunId,
          iteration: input.iteration,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          input: input.input,
          status: input.status ?? "running",
          startedAt: input.startedAt ?? now(),
          createdAt: now()
        };
        toolCalls.set(`${input.agentRunId}:${input.toolCallId}`, toolCall);
        return toolCall;
      },
      async finish(input) {
        const key = `${input.agentRunId}:${input.toolCallId}`;
        const toolCall = toolCalls.get(key);
        if (!toolCall) {
          return null;
        }
        const updated: ToolCallAudit = {
          ...toolCall,
          output: input.output,
          status: input.status,
          error: input.error,
          duration: input.duration,
          finishedAt: input.finishedAt ?? now()
        };
        toolCalls.set(key, updated);
        return updated;
      },
      async findByAgentRunId(agentRunId) {
        return Array.from(toolCalls.values()).filter((entry) => entry.agentRunId === agentRunId);
      }
    },
    workflowEvents: {
      async create(input) {
        const event: WorkflowEvent = {
          id: randomUUID(),
          agentRunId: input.agentRunId,
          eventType: input.eventType,
          payload: input.payload as JsonObject,
          createdAt: input.createdAt ?? now()
        };
        events.push(event);
        return event;
      },
      async findByAgentRunId(agentRunId) {
        return events.filter((event) => event.agentRunId === agentRunId);
      },
      async findTaskFailureEvents(workflowRunId, taskId) {
        return events.filter(
          (event) => event.workflowRunId === workflowRunId && event.taskId === taskId
        );
      }
    },
    projects: repository,
    cancellationStore: new MemoryCancellationStore(),
    logger: createLogger({ enabled: false })
  });
}

function createTestApp(
  repository = createMemoryRepository(),
  agentWorkspaceRoot = process.cwd()
) {
  return createApp({
    logger: createLogger({ enabled: false }),
    projectRepository: repository,
    agentRunService: createMemoryAgentRunService(repository),
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
    corsOrigin: "http://localhost:5173",
    agentWorkspaceRoot
  });
}

describe("server app", () => {
  it("returns health and readiness responses", async () => {
    const app = createTestApp();

    await request(app)
      .get("/health")
      .expect(200)
      .expect((response) => {
        expect(response.body.success).toBe(true);
        expect(response.body.data.status).toBe("ok");
      });

    await request(app)
      .get("/ready")
      .expect(200)
      .expect((response) => {
        expect(response.body.data.checks).toEqual({ database: "ok", redis: "ok" });
      });
  });

  it("creates, lists, reads and deletes projects", async () => {
    const app = createTestApp();

    const created = await request(app)
      .post("/api/projects")
      .send({
        name: "AI-SE",
        description: "Engineering foundation",
        repository: "https://github.com/example/ai-se"
      })
      .expect(201);

    const projectId = created.body.data.id;
    expect(created.body.data).toMatchObject({
      name: "AI-SE",
      description: "Engineering foundation",
      repository: "https://github.com/example/ai-se",
      status: "active"
    });

    await request(app)
      .get("/api/projects")
      .expect(200)
      .expect((response) => {
        expect(response.body.data).toHaveLength(1);
      });

    await request(app)
      .get(`/api/projects/${projectId}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.id).toBe(projectId);
      });

    await request(app)
      .delete(`/api/projects/${projectId}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.id).toBe(projectId);
      });

    await request(app).get(`/api/projects/${projectId}`).expect(404);
  });

  it("auto-allocates a workspacePath under AGENT_WORKSPACE_ROOT when omitted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ai-se-proj-"));
    try {
      const app = createTestApp(createMemoryRepository(), root);
      const created = await request(app)
        .post("/api/projects")
        .send({ name: "Auto Path App" })
        .expect(201);
      const workspacePath = created.body.data.workspacePath as string;
      expect(workspacePath.startsWith(root)).toBe(true);
      expect(workspacePath).toContain(`${path.sep}projects${path.sep}`);

      const updated = await request(app)
        .put(`/api/projects/${created.body.data.id}/workspace-path`)
        .send({ workspacePath: path.join(root, "custom-override") })
        .expect(200);
      expect(updated.body.data.workspacePath).toBe(path.join(root, "custom-override"));

      await request(app)
        .put(`/api/projects/${created.body.data.id}/workspace-path`)
        .send({ workspacePath: "/tmp/outside-allowlist" })
        .expect(400);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a project without a repository and binds one later (UX-01)", async () => {
    const app = createTestApp();

    const created = await request(app)
      .post("/api/projects")
      .send({ name: "Workspace First" })
      .expect(201);
    expect(created.body.data.repository).toBeNull();
    const projectId = created.body.data.id as string;

    await request(app)
      .get("/api/projects")
      .expect(200)
      .expect((response) => {
        expect(response.body.data).toHaveLength(1);
      });

    const bound = await request(app)
      .put(`/api/projects/${projectId}/repository`)
      .send({ repository: "https://github.com/example/later" })
      .expect(200);
    expect(bound.body.data.repository).toBe("https://github.com/example/later");

    await request(app)
      .get(`/api/projects/${projectId}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.repository).toBe("https://github.com/example/later");
      });

    await request(app)
      .put(`/api/projects/${randomUUID()}/repository`)
      .send({ repository: "https://github.com/example/missing" })
      .expect(404);

    await request(app)
      .put(`/api/projects/${projectId}/repository`)
      .send({ repository: "not-a-url" })
      .expect(400);
  });

  it("rejects invalid project input", async () => {
    const app = createTestApp();

    await request(app)
      .post("/api/projects")
      .send({ name: "", repository: "not-a-url" })
      .expect(400)
      .expect((response) => {
        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe("VALIDATION_ERROR");
      });
  });

  it("creates, reads, lists events and cancels agent runs", async () => {
    const app = createTestApp();

    const created = await request(app)
      .post("/api/agent-runs")
      .send({
        task: "修复项目中的测试失败问题，并确保所有测试通过。",
        maxIterations: 2,
        timeoutMs: 2_000
      })
      .expect(201);

    const agentRunId = created.body.data.id as string;
    expect(created.body.data.status).toBe("created");

    await request(app)
      .get("/api/agent-runs")
      .expect(200)
      .expect((response) => {
        expect(response.body.data.some((run: AgentRun) => run.id === agentRunId)).toBe(true);
      });

    await request(app)
      .get(`/api/agent-runs/${agentRunId}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.run.id).toBe(agentRunId);
      });

    await request(app)
      .get(`/api/agent-runs/${agentRunId}/events`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.length).toBeGreaterThan(0);
      });

    await request(app)
      .post(`/api/agent-runs/${agentRunId}/cancel`)
      .expect(200)
      .expect((response) => {
        expect(["cancelling", "cancelled", "succeeded", "failed", "timed_out"]).toContain(
          response.body.data.status
        );
      });
  });

  it.skipIf(!runDockerTests)(
    "runs the coding agent demo",
    async () => {
      const app = createTestApp();

      await request(app)
        .post("/api/agent-runs/coding-demo")
        .send({ task: "修复项目中的测试失败问题，并确保所有测试通过。" })
        .expect(201)
        .expect((response) => {
          const run = response.body.data as AgentRunView;
          expect(run.status).toBe("succeeded");
          expect(run.toolCalls.some((entry) => entry.toolName === "git_diff")).toBe(true);
          expect(run.toolCalls.some((entry) => entry.toolName === "run_unit_test")).toBe(true);
          expect(run.finalResult).toContain("SUCCESS");
        });
    },
    240_000
  );
});
