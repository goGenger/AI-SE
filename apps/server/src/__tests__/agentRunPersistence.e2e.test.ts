import {
  PgAgentRunStore,
  PgProjectRepository,
  PgToolCallStore,
  PgWorkflowEventStore,
  createPool,
  runMigrations
} from "@ai-se/database";
import { createLogger } from "@ai-se/observability";
import { AgentRunDetailView } from "@ai-se/shared";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { AgentRunService } from "../services/agentRunService";
import { MemoryCancellationStore } from "../services/cancellationStore";
import type { Pool } from "pg";

const execFileAsync = promisify(execFile);
const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres(): Promise<{ pool: Pool; stop: () => Promise<void> }> {
  const name = `ai-se-server-postgres-test-${randomUUID()}`;

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

describe("Agent Run persistence E2E", () => {
  let pool: Pool;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await runMigrations(pool);
  }, 180_000);

  afterAll(async () => {
    await stop?.();
  });

  it("runs the coding agent through Docker Sandbox and persists audit rows", async () => {
    const logger = createLogger({ enabled: false });
    const projectRepository = new PgProjectRepository(pool);
    const service = new AgentRunService({
      agentRuns: new PgAgentRunStore(pool),
      toolCalls: new PgToolCallStore(pool),
      workflowEvents: new PgWorkflowEventStore(pool),
      projects: projectRepository,
      cancellationStore: new MemoryCancellationStore(),
      logger
    });
    const app = createApp({
      logger,
      projectRepository,
      agentRunService: service,
      checkDatabase: async () => {
        await pool.query("SELECT 1");
      },
      checkRedis: async () => undefined,
      corsOrigin: "http://localhost:5173"
    });

    const created = await request(app)
      .post("/api/agent-runs")
      .send({
        task: "修复项目中的测试失败问题，并确保所有测试通过。",
        maxIterations: 16,
        timeoutMs: 180_000
      })
      .expect(201);

    const agentRunId = created.body.data.id as string;
    let detail: AgentRunDetailView | null = null;

    for (let attempt = 0; attempt < 240; attempt += 1) {
      const response = await request(app).get(`/api/agent-runs/${agentRunId}`).expect(200);
      detail = response.body.data as AgentRunDetailView;
      if (terminalStatuses.has(detail.run.status)) {
        break;
      }
      await sleep(1_000);
    }

    expect(detail?.run.status).toBe("succeeded");
    expect(detail?.toolCalls.some((entry) => entry.toolName === "run_unit_test")).toBe(true);
    expect(detail?.events.some((event) => event.eventType === "agent_run_finished")).toBe(true);

    const rowCounts = await pool.query<{
      agent_runs: string;
      tool_calls: string;
      workflow_events: string;
    }>(
      `
        SELECT
          (SELECT count(*) FROM agent_runs WHERE id = $1) AS agent_runs,
          (SELECT count(*) FROM tool_calls WHERE agent_run_id = $1) AS tool_calls,
          (SELECT count(*) FROM workflow_events WHERE agent_run_id = $1) AS workflow_events
      `,
      [agentRunId]
    );

    expect(Number(rowCounts.rows[0].agent_runs)).toBe(1);
    expect(Number(rowCounts.rows[0].tool_calls)).toBeGreaterThan(0);
    expect(Number(rowCounts.rows[0].workflow_events)).toBeGreaterThan(0);
  }, 300_000);
});
