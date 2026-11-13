import type { Pool } from "pg";
import type { EvidenceRecord, EvidenceRecordDraft } from "@ai-se/shared";

/**
 * Phase 5.7-4: persistence for evidence_records (migration 009).
 * Repo stays thin: rows are written/read exactly as the evidence builder
 * produced them (already redacted + validated against the frozen contract).
 */

export interface EvidenceRecordQuery {
  projectId?: string;
  workflowRunId?: string;
  taskId?: string;
  agentRunId?: string;
  toolCallId?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface EvidenceRow {
  id: string;
  project_id: string;
  workflow_run_id: string | null;
  task_id: string | null;
  agent_run_id: string | null;
  tool_call_id: string | null;
  action_ref: unknown;
  external_id: string | null;
  before_snapshot: unknown;
  after_snapshot: unknown;
  result: unknown;
  verification: unknown;
  screenshot_ref: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    ...(row.workflow_run_id ? { workflowRunId: row.workflow_run_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.agent_run_id ? { agentRunId: row.agent_run_id } : {}),
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    actionRef: row.action_ref,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    before: row.before_snapshot,
    after: row.after_snapshot,
    result: row.result,
    ...(row.screenshot_ref ? { screenshotRef: row.screenshot_ref } : {}),
    verification: row.verification,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  } as EvidenceRecord;
}

export class PgEvidenceRepository {
  constructor(private readonly pool: Pool) {}

  async create(draft: EvidenceRecordDraft): Promise<EvidenceRecord> {
    const result = await this.pool.query<EvidenceRow>(
      `INSERT INTO evidence_records (
         project_id, workflow_run_id, task_id, agent_run_id, tool_call_id,
         action_ref, external_id, before_snapshot, after_snapshot,
         result, verification, screenshot_ref
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        draft.projectId,
        draft.workflowRunId ?? null,
        draft.taskId ?? null,
        draft.agentRunId ?? null,
        draft.toolCallId ?? null,
        draft.actionRef,
        draft.externalId ?? null,
        draft.before,
        draft.after,
        draft.result,
        draft.verification,
        draft.screenshotRef ?? null
      ]
    );
    return mapRow(result.rows[0]!);
  }

  async findById(id: string): Promise<EvidenceRecord | null> {
    const result = await this.pool.query<EvidenceRow>(
      "SELECT * FROM evidence_records WHERE id = $1",
      [id]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async findMany(query: EvidenceRecordQuery = {}): Promise<EvidenceRecord[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.projectId) {
      values.push(query.projectId);
      conditions.push(`project_id = $${values.length}`);
    }
    if (query.workflowRunId) {
      values.push(query.workflowRunId);
      conditions.push(`workflow_run_id = $${values.length}`);
    }
    if (query.taskId) {
      values.push(query.taskId);
      conditions.push(`task_id = $${values.length}`);
    }
    if (query.agentRunId) {
      values.push(query.agentRunId);
      conditions.push(`agent_run_id = $${values.length}`);
    }
    if (query.toolCallId) {
      values.push(query.toolCallId);
      conditions.push(`tool_call_id = $${values.length}`);
    }
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    values.push(limit);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<EvidenceRow>(
      `SELECT * FROM evidence_records ${where} ORDER BY created_at DESC LIMIT $${values.length}`,
      values
    );
    return result.rows.map((row) => mapRow(row));
  }
}
