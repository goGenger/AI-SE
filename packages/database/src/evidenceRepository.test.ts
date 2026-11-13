import { randomUUID } from "node:crypto";
import type { EvidenceRecordDraft } from "@ai-se/shared";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgEvidenceRepository } from "./evidenceRepository";
import { runMigrations } from "./migrate";
import { createTestProject, startPostgresContainer } from "./testPostgresContainer";

function evidenceDraft(overrides: Partial<EvidenceRecordDraft> = {}): EvidenceRecordDraft {
  return {
    projectId: overrides.projectId!,
    actionRef: {
      source: "browser",
      sessionId: "browser:1",
      toolName: "browser.action.click",
      target: "#go"
    },
    before: {
      observation: {
        observationId: "obs-before",
        actionRef: {
          source: "browser",
          sessionId: "browser:1",
          toolName: "browser.observe",
          target: "#go"
        },
        dom: {
          nodes: [
            { ref: "r1", role: "generic", name: "count: 0", clickable: false, text: "count: 0" }
          ]
        },
        takenAt: "2026-09-13T10:00:00.000Z"
      },
      capturedAt: "2026-09-13T10:00:00.000Z"
    },
    after: {
      observation: {
        observationId: "obs-after",
        actionRef: {
          source: "browser",
          sessionId: "browser:1",
          toolName: "browser.observe",
          target: "#go"
        },
        dom: {
          nodes: [
            { ref: "r1", role: "generic", name: "count: 1", clickable: false, text: "count: 1" }
          ]
        },
        takenAt: "2026-09-13T10:00:01.000Z"
      },
      capturedAt: "2026-09-13T10:00:01.000Z"
    },
    result: {
      resultId: "res-1",
      actionRef: {
        source: "browser",
        sessionId: "browser:1",
        toolName: "browser.action.click",
        target: "#go"
      },
      status: "success",
      durationMs: 4,
      occurredAt: "2026-09-13T10:00:01.000Z"
    },
    screenshotRef: "screenshot://browser:1/2.png",
    verification: {
      status: "VERIFIED",
      findings: [
        { expectation: { kind: "contains", value: "count: 1" }, ok: true, detail: "found" }
      ],
      verifiedAt: "2026-09-13T10:00:02.000Z"
    },
    ...overrides
  };
}

describe("Phase 5.7-4 PgEvidenceRepository (migration 009)", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repository: PgEvidenceRepository;
  let projectId: string;

  beforeAll(async () => {
    const container = await startPostgresContainer();
    pool = container.pool;
    stop = container.stop;
    await runMigrations(pool);
    projectId = await createTestProject(pool, "evidence-repo");
    repository = new PgEvidenceRepository(pool);
  }, 180_000);

  afterAll(async () => {
    await stop();
  });

  it("runs migration 009 idempotently", async () => {
    expect(await runMigrations(pool)).toEqual([]);
  });

  it("creates and reads evidence with the full contract shape", async () => {
    const created = await repository.create(evidenceDraft({ projectId }));
    expect(created.id).toBeTruthy();
    expect(created.projectId).toBe(projectId);
    expect(created.screenshotRef).toBe("screenshot://browser:1/2.png");
    expect(created.verification.status).toBe("VERIFIED");

    const readBack = await repository.findById(created.id);
    expect(readBack).toEqual(created);
    expect(readBack?.before.observation?.observationId).toBe("obs-before");
    expect(readBack?.after.observation?.observationId).toBe("obs-after");
    expect(readBack?.result.status).toBe("success");
    expect(readBack?.workflowRunId).toBeUndefined();
    expect(readBack?.externalId).toBeUndefined();
  });

  it("associates runs/tasks/tool calls and supports the list filters", async () => {
    const requirementId = await pool
      .query<{
        id: string;
      }>(
        `INSERT INTO requirements (project_id, title, raw_content) VALUES ($1, 'Evidence requirement', 'raw') RETURNING id`,
        [projectId]
      )
      .then((result) => result.rows[0]!.id);
    const runId = await pool
      .query<{
        id: string;
      }>(
        `INSERT INTO workflow_runs (project_id, requirement_id, planning_version, status) VALUES ($1, $2, 1, 'RUNNING') RETURNING id`,
        [projectId, requirementId]
      )
      .then((result) => result.rows[0]!.id);
    const external = await repository.create(
      evidenceDraft({
        projectId,
        workflowRunId: runId,
        toolCallId: "call-7",
        actionRef: {
          source: "mcp",
          serverName: "github",
          toolName: "issues.create",
          callId: "call-7"
        },
        externalId: "ISS-101",
        before: { result: { issues: [] }, capturedAt: "2026-09-13T10:00:00.000Z" },
        after: { result: { issues: [{ id: "ISS-101" }] }, capturedAt: "2026-09-13T10:00:01.000Z" }
      })
    );
    expect(external.externalId).toBe("ISS-101");
    expect(external.workflowRunId).toBe(runId);

    const byRun = await repository.findMany({ workflowRunId: runId });
    expect(byRun.map((record) => record.id)).toEqual([external.id]);
    expect(byRun[0]?.after.result).toEqual({ issues: [{ id: "ISS-101" }] });

    const byProject = await repository.findMany({ projectId });
    expect(byProject.length).toBeGreaterThanOrEqual(2);
    expect((byProject[0]?.createdAt ?? "") >= (byProject[1]?.createdAt ?? "")).toBe(true);

    const byToolCall = await repository.findMany({ toolCallId: "call-7" });
    expect(byToolCall.map((record) => record.id)).toEqual([external.id]);
    expect(await repository.findMany({ projectId: randomUUID() })).toEqual([]);

    // UX-03：按 agent_run_id 过滤（AgentRun 详情的 Evidence 关联）
    const agentRunId = await pool
      .query<{ id: string }>(
        `INSERT INTO agent_runs (project_id, task_id, status, input, max_iterations)
         VALUES ($1, $2, 'succeeded', '{}'::jsonb, 8) RETURNING id`,
        [projectId, randomUUID()]
      )
      .then((result) => result.rows[0]!.id);
    const linked = await repository.create(
      evidenceDraft({ projectId, agentRunId, workflowRunId: runId })
    );
    const byAgentRun = await repository.findMany({ agentRunId });
    expect(byAgentRun.map((record) => record.id)).toEqual([linked.id]);
    expect(await repository.findMany({ agentRunId: randomUUID() })).toEqual([]);
  });

  it("does not store inline screenshot bytes anywhere in the row", async () => {
    const created = await repository.create(evidenceDraft({ projectId }));
    const serialized = JSON.stringify(created);
    expect(serialized).not.toContain("data:image/png;base64");
    expect(serialized).not.toContain("iVBORw0KGgo"); // PNG magic in base64
  });
});
