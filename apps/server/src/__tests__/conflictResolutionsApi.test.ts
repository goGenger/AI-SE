import { createLogger } from "@ai-se/observability";
import { ConflictResolution, ConflictResolutionData } from "@ai-se/shared";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { AgentRunService } from "../services/agentRunService";
import { PlanningService } from "../services/planningService";

function createStubAgentRunService(): AgentRunService {
  return {
    create: vi.fn(),
    list: vi.fn(async () => []),
    get: vi.fn(),
    cancel: vi.fn(),
    notifyRunChanged: vi.fn()
  } as unknown as AgentRunService;
}

describe("conflict resolutions API", () => {
  it("GET 空列表；POST 校验 CUSTOM 缺 note；POST 成功回写", async () => {
    const requirementId = randomUUID();
    const saved: ConflictResolution[] = [];
    const planningService = {
      async listConflictResolutions(id: string) {
        expect(id).toBe(requirementId);
        return saved;
      },
      async upsertConflictResolutions(id: string, resolutions: ConflictResolutionData[]) {
        expect(id).toBe(requirementId);
        saved.splice(
          0,
          saved.length,
          ...resolutions.map((item, index) => ({
            id: randomUUID(),
            requirementId: id,
            topic: item.topic,
            source: item.source,
            prdSays: item.prdSays,
            documentSays: item.documentSays,
            choice: item.choice,
            note: item.note ?? null,
            resolvedAt: new Date(2026, 10, 5, index).toISOString()
          }))
        );
        return saved;
      }
    } as unknown as PlanningService;

    const app = createApp({
      logger: createLogger({ enabled: false }),
      corsOrigin: "*",
      projectRepository: {
        create: vi.fn(),
        findMany: vi.fn(async () => []),
        findById: vi.fn(),
        attachRepository: vi.fn(),
        updateWorkspacePath: vi.fn(),
        deleteById: vi.fn()
      },
      agentRunService: createStubAgentRunService(),
      planningService,
      checkDatabase: async () => undefined,
      checkRedis: async () => undefined
    });

    const empty = await request(app)
      .get(`/api/requirements/${requirementId}/conflict-resolutions`)
      .expect(200);
    expect(empty.body.success).toBe(true);
    expect(empty.body.data).toEqual([]);

    const invalid = await request(app)
      .post(`/api/requirements/${requirementId}/conflict-resolutions`)
      .send({
        resolutions: [
          {
            topic: "auth",
            source: "trd.md",
            prdSays: "JWT",
            documentSays: "session",
            choice: "CUSTOM"
          }
        ]
      })
      .expect(400);
    expect(invalid.body.success).toBe(false);

    const ok = await request(app)
      .post(`/api/requirements/${requirementId}/conflict-resolutions`)
      .send({
        resolutions: [
          {
            topic: "auth",
            source: "trd.md",
            prdSays: "JWT",
            documentSays: "session",
            choice: "FOLLOW_TRD"
          }
        ]
      })
      .expect(200);
    expect(ok.body.data).toHaveLength(1);
    expect(ok.body.data[0].choice).toBe("FOLLOW_TRD");

    const listed = await request(app)
      .get(`/api/requirements/${requirementId}/conflict-resolutions`)
      .expect(200);
    expect(listed.body.data[0].topic).toBe("auth");
  });
});
