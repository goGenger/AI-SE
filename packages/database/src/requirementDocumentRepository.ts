import { RequirementDocument, RequirementDocumentKind } from "@ai-se/shared";
import { Pool } from "pg";

interface RequirementDocumentRow {
  id: string;
  requirement_id: string;
  kind: RequirementDocumentKind;
  file_name: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  content_text: string;
  truncated: boolean;
  created_at: Date | string;
}

interface RequirementDocumentRawRow extends RequirementDocumentRow {
  raw_bytes: Buffer;
}

export interface CreateRequirementDocumentInput {
  requirementId: string;
  kind: RequirementDocumentKind;
  fileName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  contentText: string;
  rawBytes: Buffer;
  truncated: boolean;
}

/** 规划侧读取：正文随文档返回（列表接口一律不返回大字段）。 */
export interface RequirementDocumentContent {
  id: string;
  kind: RequirementDocumentKind;
  fileName: string;
  text: string;
  truncated: boolean;
}

/** UI 参照图：规划多模态需要原件字节。 */
export interface RequirementUiReferenceContent {
  id: string;
  fileName: string;
  mimeType: string;
  note: string;
  rawBytes: Buffer;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapDocument(row: RequirementDocumentRow): RequirementDocument {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    kind: row.kind,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    charCount: row.content_text.length,
    truncated: row.truncated,
    createdAt: iso(row.created_at)
  };
}

export class PgRequirementDocumentRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * 落库一份文档。`PRD` 至多一份（`018` 的部分唯一索引）——重复上传即替换。
   * UI_REFERENCE / TECHNICAL 允许多份。
   */
  async create(input: CreateRequirementDocumentInput): Promise<RequirementDocument> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (input.kind === "PRD") {
        await client.query(
          "DELETE FROM requirement_documents WHERE requirement_id = $1 AND kind = 'PRD'",
          [input.requirementId]
        );
      }
      const result = await client.query<RequirementDocumentRow>(
        `
          INSERT INTO requirement_documents (
            requirement_id, kind, file_name, mime_type, byte_size, sha256,
            content_text, raw_bytes, truncated
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING *
        `,
        [
          input.requirementId,
          input.kind,
          input.fileName,
          input.mimeType,
          input.byteSize,
          input.sha256,
          input.contentText,
          input.rawBytes,
          input.truncated
        ]
      );
      await client.query("COMMIT");
      return mapDocument(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findByRequirementId(requirementId: string): Promise<RequirementDocument[]> {
    const result = await this.pool.query<RequirementDocumentRow>(
      `
        SELECT id, requirement_id, kind, file_name, mime_type, byte_size, sha256,
               content_text, truncated, created_at
        FROM requirement_documents
        WHERE requirement_id = $1
        ORDER BY created_at ASC, file_name ASC
      `,
      [requirementId]
    );
    return result.rows.map(mapDocument);
  }

  /** 规划输入用：只要技术文档的正文（PRD 走 `requirements.raw_content`，不重复喂）。 */
  async findContentsByRequirementId(requirementId: string): Promise<RequirementDocumentContent[]> {
    const result = await this.pool.query<RequirementDocumentRow>(
      `
        SELECT id, requirement_id, kind, file_name, mime_type, byte_size, sha256,
               content_text, truncated, created_at
        FROM requirement_documents
        WHERE requirement_id = $1 AND kind = 'TECHNICAL'
        ORDER BY created_at ASC, file_name ASC
      `,
      [requirementId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      fileName: row.file_name,
      text: row.content_text,
      truncated: row.truncated
    }));
  }

  /** 规划 / Agent：UI 参照图原件（不做 OCR）。 */
  async findUiReferencesByRequirementId(
    requirementId: string
  ): Promise<RequirementUiReferenceContent[]> {
    const result = await this.pool.query<RequirementDocumentRawRow>(
      `
        SELECT id, requirement_id, kind, file_name, mime_type, byte_size, sha256,
               content_text, raw_bytes, truncated, created_at
        FROM requirement_documents
        WHERE requirement_id = $1 AND kind = 'UI_REFERENCE'
        ORDER BY created_at ASC, file_name ASC
      `,
      [requirementId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      note: row.content_text,
      rawBytes: Buffer.isBuffer(row.raw_bytes) ? row.raw_bytes : Buffer.from(row.raw_bytes)
    }));
  }

  async countByRequirementIdAndKind(
    requirementId: string,
    kind: RequirementDocumentKind
  ): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM requirement_documents
        WHERE requirement_id = $1 AND kind = $2
      `,
      [requirementId, kind]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async findRawById(
    id: string
  ): Promise<{ mimeType: string; fileName: string; bytes: Buffer } | null> {
    const result = await this.pool.query<{
      file_name: string;
      mime_type: string;
      raw_bytes: Buffer;
    }>(
      `
        SELECT file_name, mime_type, raw_bytes
        FROM requirement_documents
        WHERE id = $1
      `,
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      fileName: row.file_name,
      mimeType: row.mime_type,
      bytes: Buffer.isBuffer(row.raw_bytes) ? row.raw_bytes : Buffer.from(row.raw_bytes)
    };
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM requirement_documents WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async findById(id: string): Promise<RequirementDocument | null> {
    const result = await this.pool.query<RequirementDocumentRow>(
      `
        SELECT id, requirement_id, kind, file_name, mime_type, byte_size, sha256,
               content_text, truncated, created_at
        FROM requirement_documents
        WHERE id = $1
      `,
      [id]
    );
    return result.rows[0] ? mapDocument(result.rows[0]) : null;
  }
}
