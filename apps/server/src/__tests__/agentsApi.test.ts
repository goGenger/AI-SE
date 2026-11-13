import { AgentRegistry, PROFESSIONAL_AGENT_DEFINITIONS } from "@ai-se/agent-core";
import { BACKEND_NODE_PROFILE, FRONTEND_VUE_PROFILE } from "@ai-se/shared";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createAgentsRouter } from "../routes/agents";
import { AgentRegistryService } from "../services/agentRegistryService";

const stores = {
  agentRuns: { findMany: async () => [] },
  artifacts: { findMany: async () => [], metrics: async () => ({ agentSuccessRate: 1 }) }
};

function appFor(registry: AgentRegistry) {
  const service = new AgentRegistryService({
    registry,
    agentRuns: stores.agentRuns as never,
    artifacts: stores.artifacts as never
  });
  const app = express();
  app.use("/api", createAgentsRouter(service));
  app.use(
    (
      error: Error & { statusCode?: number; code?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      res.status(error.statusCode ?? 500).json({ success: false, error: { code: error.code } });
    }
  );
  return app;
}

describe("Agents API", () => {
  it("lists only agents enabled by frontend-vue, and still serves details and metrics", async () => {
    const app = appFor(new AgentRegistry(PROFESSIONAL_AGENT_DEFINITIONS, FRONTEND_VUE_PROFILE));

    const listed = (await request(app).get("/api/agents").expect(200)).body.data;
    expect(listed.map((agent: { name: string }) => agent.name)).toEqual([
      "planner-agent",
      "frontend-agent",
      "qa-agent",
      "reviewer-agent",
      "devops-agent"
    ]);
    expect(listed.map((agent: { name: string }) => agent.name)).not.toContain("backend-agent");
    expect(listed.map((agent: { name: string }) => agent.name)).not.toContain("database-agent");
    // Definitions remain in the catalog; a direct detail lookup still works.
    expect(
      (await request(app).get("/api/agents/backend-agent").expect(200)).body.data.definition.type
    ).toBe("BACKEND");
    expect(
      (await request(app).get("/api/agents/metrics").expect(200)).body.data.agentSuccessRate
    ).toBe(1);
    await request(app).get("/api/agents/missing").expect(404);
  });

  it("lists backend-agent and database-agent when the profile enables them", async () => {
    const app = appFor(new AgentRegistry(PROFESSIONAL_AGENT_DEFINITIONS, BACKEND_NODE_PROFILE));
    const listed = (await request(app).get("/api/agents").expect(200)).body.data;
    expect(listed.map((agent: { name: string }) => agent.name)).toEqual([
      "planner-agent",
      "frontend-agent",
      "backend-agent",
      "database-agent",
      "qa-agent",
      "reviewer-agent",
      "devops-agent"
    ]);
  });
});
