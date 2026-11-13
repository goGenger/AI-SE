import { PgEvidenceRepository } from "@ai-se/database";
import type { EvidenceRecord, EvidenceRecordDraft } from "@ai-se/shared";
import { AppError } from "../http/errors";

/**
 * Phase 5.7-4: minimal evidence service. Records FACTS only — list/detail
 * reads plus the persist endpoint used by capture flows. No retry, no
 * re-plan, no approval lifecycle: evidence never becomes a runtime.
 *
 * Access model (no new auth system): every read may declare a project scope;
 * when a scope is declared it must match the record's project — a cross
 * project read is denied (403) instead of leaking another project's evidence.
 */

export interface EvidenceListQuery {
  projectId?: string;
  workflowRunId?: string;
  taskId?: string;
  toolCallId?: string;
  limit?: number;
}

export class EvidenceService {
  constructor(private readonly records: PgEvidenceRepository) {}

  async create(draft: EvidenceRecordDraft): Promise<EvidenceRecord> {
    return this.records.create(draft);
  }

  async list(query: EvidenceListQuery): Promise<EvidenceRecord[]> {
    return this.records.findMany(query);
  }

  async get(id: string, scope: { projectId?: string } = {}): Promise<EvidenceRecord> {
    const record = await this.records.findById(id);
    if (!record) {
      throw new AppError(404, "EVIDENCE_NOT_FOUND", "Evidence record not found");
    }
    if (scope.projectId && scope.projectId !== record.projectId) {
      throw new AppError(
        403,
        "EVIDENCE_ACCESS_DENIED",
        "Evidence record belongs to a different project scope"
      );
    }
    return record;
  }
}
