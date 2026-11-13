import { createHash } from "node:crypto";
import {
  ProvidedTechnicalDocument,
  ProvidedUiReference,
  REQUIREMENT_DOCUMENT_MAX_BYTES,
  REQUIREMENT_UI_REFERENCE_MAX_COUNT,
  RequirementDocument,
  RequirementDocumentKind,
  RequirementDocumentsView
} from "@ai-se/shared";
import { PgPlanningRepository, PgRequirementDocumentRepository } from "@ai-se/database";
import { AppError } from "../http/errors";
import {
  assertValidImageBytes,
  detectFormat,
  DocumentExtractionError,
  extractDocumentText,
  isImageFormat,
  isTextFormat,
  mimeForFormat,
  uiReferencePlaceholder,
  type ImageFormat
} from "./documentExtraction";

export interface UploadRequirementDocumentInput {
  requirementId: string;
  kind: RequirementDocumentKind;
  fileName: string;
  bytes: Buffer;
}

export class DocumentService {
  constructor(
    private readonly dependencies: {
      documents: Pick<
        PgRequirementDocumentRepository,
        | "create"
        | "findByRequirementId"
        | "findContentsByRequirementId"
        | "findUiReferencesByRequirementId"
        | "findById"
        | "findRawById"
        | "delete"
        | "countByRequirementIdAndKind"
      >;
      planning: Pick<
        PgPlanningRepository,
        | "findRequirementById"
        | "updateRequirementContent"
        | "touchDocumentsChanged"
        | "documentsChangedAt"
        | "latestAnalysisAt"
      >;
    }
  ) {}

  async upload(input: UploadRequirementDocumentInput): Promise<RequirementDocument> {
    const requirement = await this.dependencies.planning.findRequirementById(input.requirementId);
    if (!requirement) {
      throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
    }
    if (input.bytes.byteLength === 0) {
      throw new AppError(400, "DOCUMENT_UNREADABLE", "文件内容为空", { reason: "EMPTY_DOCUMENT" });
    }
    if (input.bytes.byteLength > REQUIREMENT_DOCUMENT_MAX_BYTES) {
      throw new AppError(
        413,
        "DOCUMENT_TOO_LARGE",
        `文件超过 ${REQUIREMENT_DOCUMENT_MAX_BYTES} 字节上限`
      );
    }
    const format = detectFormat(input.fileName);
    if (!format) {
      throw new AppError(
        400,
        "UNSUPPORTED_DOCUMENT_FORMAT",
        input.kind === "UI_REFERENCE"
          ? "UI 参照图只支持 .png / .jpg / .jpeg / .webp"
          : "只支持 .md / .txt / .docx 文件",
        { reason: "UNSUPPORTED_FORMAT" }
      );
    }

    if (input.kind === "UI_REFERENCE") {
      if (!isImageFormat(format)) {
        throw new AppError(
          400,
          "UNSUPPORTED_DOCUMENT_FORMAT",
          "UI 参照图只支持 .png / .jpg / .jpeg / .webp",
          { reason: "UNSUPPORTED_FORMAT" }
        );
      }
      const existing = await this.dependencies.documents.countByRequirementIdAndKind(
        input.requirementId,
        "UI_REFERENCE"
      );
      if (existing >= REQUIREMENT_UI_REFERENCE_MAX_COUNT) {
        throw new AppError(
          400,
          "DOCUMENT_LIMIT_EXCEEDED",
          `单个需求最多 ${REQUIREMENT_UI_REFERENCE_MAX_COUNT} 张 UI 参照图`,
          { reason: "UI_REFERENCE_LIMIT" }
        );
      }
      try {
        assertValidImageBytes(format as ImageFormat, input.bytes);
      } catch (error) {
        if (error instanceof DocumentExtractionError) {
          throw new AppError(400, "DOCUMENT_UNREADABLE", error.message, { reason: error.code });
        }
        throw error;
      }
      const placeholder = uiReferencePlaceholder(input.fileName);
      const document = await this.dependencies.documents.create({
        requirementId: input.requirementId,
        kind: input.kind,
        fileName: input.fileName,
        mimeType: mimeForFormat(format),
        byteSize: input.bytes.byteLength,
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
        contentText: placeholder.text,
        rawBytes: input.bytes,
        truncated: placeholder.truncated
      });
      await this.dependencies.planning.touchDocumentsChanged(input.requirementId);
      return document;
    }

    if (!isTextFormat(format)) {
      throw new AppError(400, "UNSUPPORTED_DOCUMENT_FORMAT", "只支持 .md / .txt / .docx 文件", {
        reason: "UNSUPPORTED_FORMAT"
      });
    }

    let extracted: { text: string; truncated: boolean };
    try {
      extracted = await extractDocumentText(format, input.bytes);
    } catch (error) {
      if (error instanceof DocumentExtractionError) {
        throw new AppError(400, "DOCUMENT_UNREADABLE", error.message, { reason: error.code });
      }
      throw error;
    }

    const document = await this.dependencies.documents.create({
      requirementId: input.requirementId,
      kind: input.kind,
      fileName: input.fileName,
      mimeType: mimeForFormat(format),
      byteSize: input.bytes.byteLength,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      contentText: extracted.text,
      rawBytes: input.bytes,
      truncated: extracted.truncated
    });

    // PRD 是需求正文的唯一来源：文件形态的 PRD 抽取后写回 raw_content。
    if (input.kind === "PRD") {
      await this.dependencies.planning.updateRequirementContent(input.requirementId, extracted.text);
    }
    await this.dependencies.planning.touchDocumentsChanged(input.requirementId);

    return document;
  }

  async list(requirementId: string): Promise<RequirementDocumentsView> {
    const requirement = await this.dependencies.planning.findRequirementById(requirementId);
    if (!requirement) {
      throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
    }
    const [documents, latestAnalysisAt, documentsChangedAt] = await Promise.all([
      this.dependencies.documents.findByRequirementId(requirementId),
      this.dependencies.planning.latestAnalysisAt(requirementId),
      this.dependencies.planning.documentsChangedAt(requirementId)
    ]);
    const planningStale =
      latestAnalysisAt !== null && documentsChangedAt !== null && documentsChangedAt > latestAnalysisAt;
    return { documents, planningStale, latestAnalysisAt, documentsChangedAt };
  }

  async remove(id: string): Promise<void> {
    const existing = await this.dependencies.documents.findById(id);
    if (!existing) {
      throw new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    }
    await this.dependencies.documents.delete(id);
    await this.dependencies.planning.touchDocumentsChanged(existing.requirementId);
  }

  /** 规划输入：技术文档正文，按上传顺序。 */
  async technicalDocumentsForPlanning(requirementId: string): Promise<ProvidedTechnicalDocument[]> {
    const contents = await this.dependencies.documents.findContentsByRequirementId(requirementId);
    return contents.map((content) => ({
      fileName: content.fileName,
      text: content.text,
      truncated: content.truncated
    }));
  }

  /** 规划 / Agent：UI 参照图（含 base64，供多模态）。 */
  async uiReferencesForPlanning(requirementId: string): Promise<ProvidedUiReference[]> {
    const rows = await this.dependencies.documents.findUiReferencesByRequirementId(requirementId);
    return rows.map((row) => ({
      fileName: row.fileName,
      mimeType: row.mimeType,
      note: row.note,
      base64: row.rawBytes.toString("base64")
    }));
  }

  /** 详情预览：按 id 取原件字节。 */
  async rawBytes(id: string): Promise<{ mimeType: string; fileName: string; bytes: Buffer }> {
    const row = await this.dependencies.documents.findRawById(id);
    if (!row) {
      throw new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    }
    return row;
  }
}
