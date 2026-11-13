import { AlertIngestSchema, IncidentStatusSchema } from "@ai-se/shared";
import { Router } from "express";
import { z } from "zod";
import { alertIngestGuard } from "../http/alertIngestAuth";
import { AppError, asyncHandler } from "../http/errors";
import { sendSuccess } from "../http/response";
import { IncidentService } from "../services/incidentService";

const IdSchema = z.object({ id: z.string().uuid() });
const ListSchema = z.object({
  projectId: z.string().uuid().optional(),
  status: IncidentStatusSchema.optional(),
  source: z.string().trim().min(1).max(120).optional(),
  fingerprint: z.string().trim().min(1).max(300).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});
const DetailSchema = z.object({ projectId: z.string().uuid().optional() });
const RemediateBodySchema = z
  .object({
    /**
     * Optional override. When omitted, server uses INCIDENT_AUTO_REMEDIATE (default off).
     * Explicit true/false always wins. Production DEPLOY still requires approval.
     */
    startWorkflow: z.boolean().optional(),
    workspacePath: z.string().trim().min(1).max(1000).optional()
  })
  .strict();

function id(params: unknown): string {
  const parsed = IdSchema.safeParse(params);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Id must be a UUID");
  return parsed.data.id;
}

/**
 * Alert ingest only. Mount **before** the global `apiTokenGuard` so a dedicated
 * `ALERT_INGEST_TOKEN` can authenticate webhooks without also needing `API_TOKEN`.
 */
export function createAlertIngestRouter(
  service: IncidentService,
  auth: { alertIngestToken?: string; apiToken?: string; nodeEnv: string }
): Router {
  const router = Router();
  router.post(
    "/alerts",
    alertIngestGuard(auth),
    asyncHandler(async (req, res) => {
      const body = AlertIngestSchema.safeParse(req.body);
      if (!body.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid alert payload", body.error.flatten());
      }
      const result = await service.ingestAlert(body.data);
      sendSuccess(res, result, result.deduplicated ? 200 : 201);
    })
  );
  return router;
}

/** Incident list/detail (behind global API token when configured). */
export function createIncidentsRouter(service: IncidentService): Router {
  const router = Router();

  router.get(
    "/incidents",
    asyncHandler(async (req, res) => {
      const query = ListSchema.safeParse(req.query);
      if (!query.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid incident query");
      sendSuccess(res, await service.list(query.data));
    })
  );

  router.get(
    "/incidents/:id",
    asyncHandler(async (req, res) => {
      const query = DetailSchema.safeParse(req.query);
      if (!query.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid project scope");
      sendSuccess(res, await service.get(id(req.params), query.data));
    })
  );

  /** 8-B：只读诊断（证据聚合 + 结构化输出）；不触发修复 / 部署。 */
  router.post(
    "/incidents/:id/diagnose",
    asyncHandler(async (req, res) => {
      const query = DetailSchema.safeParse(req.query);
      if (!query.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid project scope");
      sendSuccess(res, await service.diagnose(id(req.params), query.data));
    })
  );

  /** 8-C/8-D：白名单受控修复（复用 WorkflowService + Delivery）；非白名单仅通知；8-D 可选自动 start。 */
  router.post(
    "/incidents/:id/remediate",
    asyncHandler(async (req, res) => {
      const query = DetailSchema.safeParse(req.query);
      if (!query.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid project scope");
      const body = RemediateBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid remediate payload", body.error.flatten());
      }
      sendSuccess(
        res,
        await service.remediate(id(req.params), {
          ...query.data,
          startWorkflow: body.data.startWorkflow,
          ...(body.data.workspacePath ? { workspacePath: body.data.workspacePath } : {})
        })
      );
    })
  );

  return router;
}
