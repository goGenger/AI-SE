import {
  ConflictResolution,
  ConflictResolutionChoice,
  ConflictResolutionData
} from "@ai-se/shared";
import { Pool } from "pg";

interface ConflictResolutionRow {
  id: string;
  requirement_id: string;
  topic: string;
  source: string;
  prd_says: string;
  document_says: string;
  choice: ConflictResolutionChoice;
  note: string | null;
  resolved_at: Date | string;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: ConflictResolutionRow): ConflictResolution {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    topic: row.topic,
    source: row.source,
    prdSays: row.prd_says,
    documentSays: row.document_says,
    choice: row.choice,
    note: row.note,
    resolvedAt: toIsoString(row.resolved_at)
  };
}

const COLUMNS = `
  id,
  requirement_id,
  topic,
  source,
  prd_says,
  document_says,
  choice,
  note,
  resolved_at
`;

export class PgConflictResolutionRepository {
  constructor(private readonly pool: Pool) {}

  async findByRequirementId(requirementId: string): Promise<ConflictResolution[]> {
    const result = await this.pool.query<ConflictResolutionRow>(
      `
        SELECT ${COLUMNS}
        FROM requirement_conflict_resolutions
        WHERE requirement_id = $1
        ORDER BY resolved_at ASC, topic ASC, source ASC
      `,
      [requirementId]
    );
    return result.rows.map(mapRow);
  }

  /**
   * Upsert by (requirement_id, topic, source). Returns the full set after write
   * so the API can round-trip without a second list call.
   */
  async upsertMany(
    requirementId: string,
    resolutions: ConflictResolutionData[]
  ): Promise<ConflictResolution[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const item of resolutions) {
        await client.query(
          `
            INSERT INTO requirement_conflict_resolutions (
              requirement_id, topic, source, prd_says, document_says, choice, note, resolved_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, now())
            ON CONFLICT (requirement_id, topic, source)
            DO UPDATE SET
              prd_says = EXCLUDED.prd_says,
              document_says = EXCLUDED.document_says,
              choice = EXCLUDED.choice,
              note = EXCLUDED.note,
              resolved_at = now()
          `,
          [
            requirementId,
            item.topic,
            item.source,
            item.prdSays,
            item.documentSays,
            item.choice,
            item.note ?? null
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.findByRequirementId(requirementId);
  }
}
