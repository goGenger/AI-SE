import { Router } from "express";
import { z } from "zod";
import { AppError, asyncHandler } from "../http/errors";
import { sendSuccess } from "../http/response";
import { EvidenceService } from "../services/evidenceService";

const IdSchema = z.object({ id: z.string().uuid() });
const ListSchema = z.object({
  projectId: z.string().uuid().optional(),
  workflowRunId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  toolCallId: z.string().trim().min(1).max(160).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});
const DetailSchema = z.object({ projectId: z.string().uuid().optional() });

function id(params: unknown): string {
  const parsed = IdSchema.safeParse(params);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Id must be a UUID");
  return parsed.data.id;
}

export function createEvidenceRouter(service: EvidenceService): Router {
  const router = Router();

  router.get(
    "/evidence",
    asyncHandler(async (req, res) => {
      const query = ListSchema.safeParse(req.query);
      if (!query.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid evidence query");
      sendSuccess(res, await service.list(query.data));
    })
  );

  router.get(
    "/evidence/:id",
    asyncHandler(async (req, res) => {
      const query = DetailSchema.safeParse(req.query);
      if (!query.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid project scope");
      sendSuccess(res, await service.get(id(req.params), query.data));
    })
  );

  return router;
}
