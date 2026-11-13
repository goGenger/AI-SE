import { ProjectRepository } from "@ai-se/database";
import { createLogger } from "@ai-se/observability";
import { CreateProjectData, Project } from "@ai-se/shared";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { AgentRunService } from "../services/agentRunService";

function memoryProjects(): ProjectRepository {
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

function buildApp(apiToken?: string) {
  return createApp({
    logger: createLogger({ enabled: false }),
    projectRepository: memoryProjects(),
    agentRunService: {} as unknown as AgentRunService,
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
    corsOrigin: "http://localhost:5173",
    apiToken
  });
}

describe("api token guard (D-3/T8-c)", () => {
  it("passes /api requests through when no token is configured (default)", async () => {
    const response = await request(buildApp()).get("/api/projects");
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it("rejects missing or wrong tokens when configured", async () => {
    const app = buildApp("secret-token");
    const missing = await request(app).get("/api/projects");
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe("UNAUTHORIZED");
    const wrong = await request(app).get("/api/projects").set("Authorization", "Bearer nope");
    expect(wrong.status).toBe(401);
  });

  it("accepts the configured token and exempts /health", async () => {
    const app = buildApp("secret-token");
    const ok = await request(app).get("/api/projects").set("Authorization", "Bearer secret-token");
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
  });
});
