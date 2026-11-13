import { RollbackDeploymentSchema, UpsertDeploymentEnvironmentSchema } from "@ai-se/shared";
import { Router } from "express";
import { z } from "zod";
import { AppError, asyncHandler } from "../http/errors";
import { sendSuccess } from "../http/response";
import { DeploymentOrchestrator } from "../services/deploymentOrchestrator";

const IdSchema = z.object({ id: z.string().uuid() });
const ListSchema = z.object({ projectId: z.string().uuid().optional() });

function id(params: unknown): string {
  const parsed = IdSchema.safeParse(params);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Id must be a UUID");
  return parsed.data.id;
}

export function createDeploymentsRouter(service: DeploymentOrchestrator): Router {
  const router = Router();

  router.get(
    "/deployments",
    asyncHandler(async (req, res) => {
      const query = ListSchema.safeParse(req.query);
      if (!query.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid project id");
      sendSuccess(res, await service.list(query.data.projectId));
    })
  );

  router.get(
    "/deployments/:id",
    asyncHandler(async (req, res) => {
      const detail = await service.get(id(req.params));
      if (!detail) throw new AppError(404, "DEPLOYMENT_NOT_FOUND", "Deployment not found");
      sendSuccess(res, detail);
    })
  );

  router.post(
    "/deployments/:id/rollback",
    asyncHandler(async (req, res) => {
      const parsed = RollbackDeploymentSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Rollback input is invalid",
          parsed.error.flatten()
        );
      }
      sendSuccess(res, await service.rollback(id(req.params), parsed.data));
    })
  );

  router.get(
    "/environments",
    asyncHandler(async (req, res) => {
      const query = ListSchema.safeParse(req.query);
      if (!query.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid project id");
      sendSuccess(res, await service.environments(query.data.projectId));
    })
  );

  router.put(
    "/environments",
    asyncHandler(async (req, res) => {
      const parsed = UpsertDeploymentEnvironmentSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Environment input is invalid",
          parsed.error.flatten()
        );
      }
      sendSuccess(res, await service.upsertEnvironment(parsed.data));
    })
  );

  return router;
}
