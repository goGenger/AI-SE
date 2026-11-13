import { Router } from "express";
import { z } from "zod";
import { AppError, asyncHandler } from "../http/errors";
import { sendSuccess } from "../http/response";
import { AutonomyRunsService } from "../services/autonomyRunsService";

const ListSchema = z.object({
  workflowId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

const WorkflowIdSchema = z.object({ id: z.string().uuid() });

export function createAutonomyRunsRouter(service: AutonomyRunsService): Router {
  const router = Router();

  router.get(
    "/autonomy-runs",
    asyncHandler(async (req, res) => {
      const parsed = ListSchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid autonomy-runs query", parsed.error.flatten());
      }
      sendSuccess(res, await service.list(parsed.data));
    })
  );

  /** 工作流详情侧栏可复用：同一聚合，限定单个 workflow。 */
  router.get(
    "/workflows/:id/autonomy-runs",
    asyncHandler(async (req, res) => {
      const id = WorkflowIdSchema.safeParse(req.params);
      if (!id.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Workflow id must be a UUID");
      }
      sendSuccess(res, await service.list({ workflowId: id.data.id }));
    })
  );

  return router;
}
