import {
  PgAgentRunStore,
  PgPlanningRepository,
  PgProjectRepository,
  PgToolCallStore,
  PgWorkflowEventStore,
  PgWorkflowRepository,
  createPool,
  runMigrations
} from "@ai-se/database";
import { createLogger } from "@ai-se/observability";
import { createTodoPlanningFixtures, ScriptedPlanningModel } from "@ai-se/agent-core";
import type { RequirementSlicesView } from "@ai-se/shared";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Express } from "express";
import { createApp } from "../app";
import { AgentRunService } from "../services/agentRunService";
import { MemoryCancellationStore } from "../services/cancellationStore";
import { PlanningService } from "../services/planningService";
import { WorkflowService } from "../services/workflowService";

const execFileAsync = promisify(execFile);

/**
 * 自治 L2（`docs/227`）：关口 1 的判决据化。
 *
 * 三条要钉住的：
 *  - L2-5/L2-6：判据全满足 ⇒ 走**既有** approve 路径自动批准，并写 `GATE1_AUTO_APPROVED`；
 *  - 判据不满足 ⇒ 保持 PENDING（交人工），且**不写**该事件；
 *  - 未声明自治级别 ⇒ 行为与现状逐项一致（回归门）。
 */

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres(): Promise<{ pool: Pool; stop: () => Promise<void> }> {
  const name = `ai-se-gate1-autonomy-test-${randomUUID()}`;
  await docker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e",
    "POSTGRES_USER=aise",
    "-e",
    "POSTGRES_DB=aise",
    "-p",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "postgres:16-alpine"
  ]);
  const portLine = await docker(["port", name, "5432/tcp"]);
  const port = portLine.split(":").at(-1);
  if (!port) {
    throw new Error("Cannot resolve PostgreSQL test container port");
  }
  const pool = createPool(`postgres://aise@127.0.0.1:${port}/aise`);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return {
        pool,
        stop: async () => {
          await pool.end();
          await docker(["rm", "-f", name]);
        }
      };
    } catch {
      await sleep(500);
    }
  }
  const logs = await docker(["logs", name]);
  await pool.end();
  await docker(["rm", "-f", name]);
  throw new Error(`PostgreSQL test container did not become ready: ${logs}`);
}

async function waitFor<T>(fn: () => Promise<T | null>, attempts = 120): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await fn();
    if (value !== null) {
      return value;
    }
    await sleep(500);
  }
  throw new Error("waitFor timed out");
}

/** 一个只满足「FR 全部覆盖」、但每片 FR 数超限的计划——规划器接受，判据拒绝。 */
function singleOversizedSliceFixtures() {
  const fixtures = createTodoPlanningFixtures();
  fixtures.slice_planning = {
    slices: [
      {
        id: "SLICE-1",
        title: "All in one",
        goal: "一次性交付全部 FR。",
        frKeys: ["FR-001", "FR-002", "FR-003", "FR-004"],
        dependsOn: [],
        order: 1,
        involvesUi: true,
        involvesData: false,
        acceptanceCriteria: [
          "The combined Todo flows can be verified by a named acceptance check."
        ]
      }
    ],
    milestones: ["完成"],
    visualBaselineGaps: [
      {
        page: "Todo List",
        state: "Empty",
        note: "No official visual baseline was provided for the Todo List empty state."
      }
    ]
  };
  return fixtures;
}

describe("Gate 1 autonomy (L2)", () => {
  let pool: Pool;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const started = await startPostgres();
    pool = started.pool;
    stop = started.stop;
    await runMigrations(pool);
  }, 180_000);

  afterAll(async () => {
    await stop();
  });

  async function harness(fixtures = createTodoPlanningFixtures()): Promise<{
    app: Express;
    projectId: string;
  }> {
    const logger = createLogger({ enabled: false });
    const projectRepository = new PgProjectRepository(pool);
    const cancellationStore = new MemoryCancellationStore();
    const workflowRepository = new PgWorkflowRepository(pool);
    const agentRunService = new AgentRunService({
      agentRuns: new PgAgentRunStore(pool),
      toolCalls: new PgToolCallStore(pool),
      workflowEvents: new PgWorkflowEventStore(pool),
      projects: projectRepository,
      cancellationStore,
      logger
    });

    let workflowServiceRef: WorkflowService | null = null;
    const planningService = new PlanningService({
      planning: new PgPlanningRepository(pool),
      agentRuns: new PgAgentRunStore(pool),
      workflowEvents: new PgWorkflowEventStore(pool),
      projects: projectRepository,
      cancellationStore,
      notifyRunChanged: (agentRunId) => agentRunService.notifyRunChanged(agentRunId),
      approvals: workflowRepository,
      workflows: workflowRepository,
      startSliceWorkflow: async (input) => {
        const service = workflowServiceRef;
        if (!service) {
          throw new Error("Workflow service is not ready");
        }
        const workflow = await service.create(input);
        await service.start(workflow.id);
        return workflow;
      },
      model: new ScriptedPlanningModel(fixtures),
      logger
    });

    const workflowService = new WorkflowService({
      workflows: workflowRepository,
      projects: projectRepository,
      executor: {
        execute: async () => ({ status: "succeeded" as const, output: { summary: "stub" } }),
        cancel: async () => undefined
      },
      sliceHooks: {
        onSliceWorkflowCreated: async (requirementId, sliceKey, workflowRunId) => {
          await planningService.handleSliceWorkflowCreated(requirementId, sliceKey, workflowRunId);
        },
        onSliceApprovalDecided: async (approval) => {
          await planningService.handleSliceApprovalDecided(approval);
        },
        onWorkflowTerminal: (workflowRunId, status) => {
          planningService.handleWorkflowTerminal(workflowRunId, status);
        }
      }
    });
    workflowServiceRef = workflowService;

    const app = createApp({
      logger,
      projectRepository,
      agentRunService,
      planningService,
      workflowService,
      checkDatabase: async () => {
        await pool.query("SELECT 1");
      },
      checkRedis: async () => undefined,
      corsOrigin: "http://localhost:5173"
    });

    const project = await request(app)
      .post("/api/projects")
      .send({
        name: "Gate 1 autonomy",
        description: "自治 L2 判据",
        repository: `https://github.com/example/${randomUUID()}`
      })
      .expect(201);

    return { app, projectId: project.body.data.id as string };
  }

  async function createRequirement(
    app: Express,
    projectId: string,
    autonomyLevel?: "L2"
  ): Promise<string> {
    const created = await request(app)
      .post(`/api/projects/${projectId}/requirements`)
      .send({
        title: "关口 1 自治需求",
        description: "autonomy L2",
        rawContent: "两级规划：切片计划 → 关口 1 → 第二级 → 切片工作流链。",
        ...(autonomyLevel ? { autonomyLevel } : {})
      })
      .expect(201);
    return created.body.data.id as string;
  }

  async function slicesOf(app: Express, requirementId: string): Promise<RequirementSlicesView> {
    return (await request(app).get(`/api/requirements/${requirementId}/slices`).expect(200)).body
      .data as RequirementSlicesView;
  }

  async function gate1Events(requirementId: string): Promise<Array<Record<string, unknown>>> {
    const result = await pool.query(
      "SELECT payload FROM workflow_events WHERE event_type = 'GATE1_AUTO_APPROVED' AND payload->>'requirementId' = $1",
      [requirementId]
    );
    return result.rows.map((row) => row.payload as Record<string, unknown>);
  }

  it("L2 + all criteria satisfied ⇒ auto-approved through the existing approval path, with the decision recorded", async () => {
    const { app, projectId } = await harness();
    const requirementId = await createRequirement(app, projectId, "L2");
    await request(app).post(`/api/requirements/${requirementId}/analyze`).send({}).expect(202);

    // `/slices` 只暴露**待决**审批（批准后为 null），所以这里等的是库内事实，不是视图。
    const events = await waitFor(async () => {
      const rows = await gate1Events(requirementId);
      return rows.length === 1 ? rows : null;
    });
    expect(events[0]).toMatchObject({ policyId: "L2", sliceCount: 2 });
    expect(events[0]?.satisfiedReasons).toEqual([
      "fr-coverage",
      "slice-scope",
      "slice-dependencies",
      "final-slice-scale"
    ]);

    // 只看**关口 1 那条**审批（后续切片规划若升级会另建一条，不能混为一谈）。
    const approval = await pool.query(
      "SELECT status FROM approvals WHERE requirement_id = $1 AND comment LIKE 'gate-1 auto-approved by autonomy L2%'",
      [requirementId]
    );
    expect(approval.rows).toEqual([{ status: "APPROVED" }]);

    const view = await slicesOf(app, requirementId);
    expect(view.slices.map((slice) => slice.sliceKey)).toEqual(["SLICE-1", "SLICE-2"]);
  }, 120_000);

  it("L2 + a criterion unmet ⇒ stays PENDING for a human, and no auto-approval event is written", async () => {
    const { app, projectId } = await harness(singleOversizedSliceFixtures());
    const requirementId = await createRequirement(app, projectId, "L2");
    await request(app).post(`/api/requirements/${requirementId}/analyze`).send({}).expect(202);

    const pending = await waitFor(async () => {
      const view = await slicesOf(app, requirementId);
      return view.approval?.status === "PENDING" ? view : null;
    });
    expect(pending.slices).toHaveLength(1);
    expect(await gate1Events(requirementId)).toHaveLength(0);

    // 观察到「为什么被送人工」：判据名写进事件，便于批次归因。
    const checked = await pool.query(
      "SELECT payload FROM workflow_events WHERE event_type = 'GATE1_GATE_CHECKED' AND payload->>'requirementId' = $1",
      [requirementId]
    );
    expect(checked.rows).toHaveLength(1);
    expect((checked.rows[0].payload as { unmet: string[] }).unmet).toContain("slice-scope");
  }, 120_000);

  it("no autonomy level ⇒ behaviour unchanged: the gate waits for a human", async () => {
    const { app, projectId } = await harness();
    const requirementId = await createRequirement(app, projectId);
    await request(app).post(`/api/requirements/${requirementId}/analyze`).send({}).expect(202);

    const pending = await waitFor(async () => {
      const view = await slicesOf(app, requirementId);
      return view.approval?.status === "PENDING" ? view : null;
    });
    expect(pending.approval?.status).toBe("PENDING");
    expect(await gate1Events(requirementId)).toHaveLength(0);
  }, 120_000);
});
