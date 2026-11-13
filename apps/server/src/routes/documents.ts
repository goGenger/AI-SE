import { RequirementDocumentKindSchema } from "@ai-se/shared";
import { raw, Router } from "express";
import { z } from "zod";
import { AppError, asyncHandler } from "../http/errors";
import { sendSuccess } from "../http/response";
import { DocumentService } from "../services/documentService";

const IdParamSchema = z.object({
  id: z.string().uuid()
});

const UploadQuerySchema = z.object({
  kind: RequirementDocumentKindSchema,
  fileName: z.string().trim().min(1).max(255)
});

function parseId(params: unknown): string {
  const result = IdParamSchema.safeParse(params);
  if (!result.success) {
    throw new AppError(400, "VALIDATION_ERROR", "id must be a UUID", result.error.flatten());
  }
  return result.data.id;
}

/**
 * D1（`docs/229`）文档入口 + UI 参照图。
 *
 * 上传用 **raw body**：单文件用不着 multipart。元数据走 query。
 * `limit` 比服务侧的字节上限宽 1 MB，好让「太大」由我们自己给出可读原因。
 */
export function createDocumentRouter(service: DocumentService): Router {
  const router = Router();

  router.post(
    "/requirements/:id/documents",
    raw({ type: () => true, limit: "6mb" }),
    asyncHandler(async (req, res) => {
      const requirementId = parseId(req.params);
      const parsed = UploadQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "kind 与 fileName 为必填（kind=PRD|TECHNICAL|UI_REFERENCE）",
          parsed.error.flatten()
        );
      }
      if (!Buffer.isBuffer(req.body)) {
        throw new AppError(400, "DOCUMENT_UNREADABLE", "请求体必须是文件原始字节");
      }

      const document = await service.upload({
        requirementId,
        kind: parsed.data.kind,
        fileName: parsed.data.fileName,
        bytes: req.body
      });
      sendSuccess(res, document, 201);
    })
  );

  router.get(
    "/requirements/:id/documents",
    asyncHandler(async (req, res) => {
      const requirementId = parseId(req.params);
      sendSuccess(res, await service.list(requirementId));
    })
  );

  router.get(
    "/documents/:id/raw",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params);
      const file = await service.rawBytes(id);
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`
      );
      res.status(200).send(file.bytes);
    })
  );

  router.delete(
    "/documents/:id",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params);
      await service.remove(id);
      sendSuccess(res, { deleted: true });
    })
  );

  return router;
}
