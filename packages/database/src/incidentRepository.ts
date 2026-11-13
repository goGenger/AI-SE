import type { Pool } from "pg";
import {
  IncidentDiagnosisSchema,
  IncidentRemediationDecisionSchema,
  type AlertIngest,
  type AlertSeverity,
  type Incident,
  type IncidentDiagnosis,
  type IncidentRemediationDecision,
  type IncidentStatus
} from "@ai-se/shared";

/**
 * Phase 8-A: persistence for incidents (+ alert_events audit rows).
 * Idempotency for active fingerprints is enforced by a partial unique index;
 * the service layer still prefers find-then-create to return a clean
 * `deduplicated` flag without racing into a constraint error in the common case.
 */

export interface IncidentListQuery {
  projectId?: string;
  status?: IncidentStatus;
  source?: string;
  fingerprint?: string;
  limit?: number;
}

export interface CreateIncidentInput {
  projectId?: string;
  source: string;
  fingerprint: string;
  severity: AlertSeverity;
  title: string;
  summary?: string;
  labels: Record<string, string>;
  raw: Record<string, unknown>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface IncidentRow {
  id: string;
  project_id: string | null;
  status: IncidentStatus;
  source: string;
  fingerprint: string;
  severity: AlertSeverity;
  title: string;
  summary: string | null;
  labels: unknown;
  raw: unknown;
  linked_workflow_run_id: string | null;
  diagnosis: unknown;
  diagnosed_at: Date | string | null;
  remediation: unknown;
  remediated_at: Date | string | null;
  opened_at: Date | string;
  resolved_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function asUnknownRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseDiagnosis(value: unknown): IncidentDiagnosis | undefined {
  if (value == null) return undefined;
  const parsed = IncidentDiagnosisSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseRemediation(value: unknown): IncidentRemediationDecision | undefined {
  if (value == null) return undefined;
  const parsed = IncidentRemediationDecisionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function mapRow(row: IncidentRow): Incident {
  const diagnosis = parseDiagnosis(row.diagnosis);
  const remediation = parseRemediation(row.remediation);
  return {
    id: row.id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    status: row.status,
    source: row.source,
    fingerprint: row.fingerprint,
    severity: row.severity,
    title: row.title,
    ...(row.summary ? { summary: row.summary } : {}),
    labels: asStringRecord(row.labels),
    raw: asUnknownRecord(row.raw),
    ...(row.linked_workflow_run_id ? { linkedWorkflowRunId: row.linked_workflow_run_id } : {}),
    ...(diagnosis ? { diagnosis } : {}),
    ...(row.diagnosed_at ? { diagnosedAt: iso(row.diagnosed_at) } : {}),
    ...(remediation ? { remediation } : {}),
    ...(row.remediated_at ? { remediatedAt: iso(row.remediated_at) } : {}),
    openedAt: iso(row.opened_at),
    ...(row.resolved_at ? { resolvedAt: iso(row.resolved_at) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export class PgIncidentRepository {
  constructor(private readonly pool: Pool) {}

  async findActiveByFingerprint(source: string, fingerprint: string): Promise<Incident | null> {
    const result = await this.pool.query<IncidentRow>(
      `SELECT * FROM incidents
       WHERE source = $1 AND fingerprint = $2
         AND status IN ('open', 'diagnosing', 'mitigating')
       LIMIT 1`,
      [source, fingerprint]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async create(input: CreateIncidentInput): Promise<Incident> {
    const result = await this.pool.query<IncidentRow>(
      `INSERT INTO incidents (
         project_id, status, source, fingerprint, severity, title, summary, labels, raw
       ) VALUES ($1, 'open', $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
       RETURNING *`,
      [
        input.projectId ?? null,
        input.source,
        input.fingerprint,
        input.severity,
        input.title,
        input.summary ?? null,
        JSON.stringify(input.labels),
        JSON.stringify(input.raw)
      ]
    );
    return mapRow(result.rows[0]!);
  }

  async appendAlertEvent(input: {
    incidentId: string;
    alert: AlertIngest;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO alert_events (incident_id, source, fingerprint, severity, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        input.incidentId,
        input.alert.source,
        input.alert.fingerprint,
        input.alert.severity,
        JSON.stringify(input.alert)
      ]
    );
  }

  async findById(id: string): Promise<Incident | null> {
    const result = await this.pool.query<IncidentRow>("SELECT * FROM incidents WHERE id = $1", [
      id
    ]);
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async findMany(query: IncidentListQuery = {}): Promise<Incident[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.projectId) {
      values.push(query.projectId);
      conditions.push(`project_id = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      conditions.push(`status = $${values.length}`);
    }
    if (query.source) {
      values.push(query.source);
      conditions.push(`source = $${values.length}`);
    }
    if (query.fingerprint) {
      values.push(query.fingerprint);
      conditions.push(`fingerprint = $${values.length}`);
    }
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    values.push(limit);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<IncidentRow>(
      `SELECT * FROM incidents ${where} ORDER BY opened_at DESC LIMIT $${values.length}`,
      values
    );
    return result.rows.map(mapRow);
  }

  async saveDiagnosis(input: {
    id: string;
    diagnosis: IncidentDiagnosis;
    status?: IncidentStatus;
  }): Promise<Incident> {
    const status = input.status ?? "diagnosing";
    const result = await this.pool.query<IncidentRow>(
      `UPDATE incidents
          SET diagnosis = $2::jsonb,
              diagnosed_at = $3::timestamptz,
              status = $4,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [input.id, JSON.stringify(input.diagnosis), input.diagnosis.diagnosedAt, status]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Incident not found: ${input.id}`);
    }
    return mapRow(row);
  }

  /**
   * 8-C: persist whitelist decision; optionally link a staging fix workflow and
   * advance status to `mitigating` when a workflow was opened.
   */
  async saveRemediation(input: {
    id: string;
    remediation: IncidentRemediationDecision;
    status?: IncidentStatus;
    linkedWorkflowRunId?: string;
  }): Promise<Incident> {
    const status =
      input.status ??
      (input.remediation.decision === "OPENED_STAGING_FIX_WORKFLOW" ? "mitigating" : undefined);
    const result = await this.pool.query<IncidentRow>(
      `UPDATE incidents
          SET remediation = $2::jsonb,
              remediated_at = $3::timestamptz,
              linked_workflow_run_id = COALESCE($4::uuid, linked_workflow_run_id),
              status = COALESCE($5, status),
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        input.id,
        JSON.stringify(input.remediation),
        input.remediation.decidedAt,
        input.linkedWorkflowRunId ?? null,
        status ?? null
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Incident not found: ${input.id}`);
    }
    return mapRow(row);
  }
}
