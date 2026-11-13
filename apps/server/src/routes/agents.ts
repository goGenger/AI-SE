import { Router } from "express";
import { AppError, asyncHandler } from "../http/errors";
import { sendSuccess } from "../http/response";
import { AgentRegistryService } from "../services/agentRegistryService";

export function createAgentsRouter(
  service: Pick<AgentRegistryService, "list" | "detail" | "metrics">
): Router {
  const router = Router();

  router.get("/agents", (_req, res) => sendSuccess(res, service.list()));
  router.get(
    "/agents/metrics",
    asyncHandler(async (_req, res) => sendSuccess(res, await service.metrics()))
  );
  router.get(
    "/agents/:name",
    asyncHandler(async (req, res) => {
      try {
        const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
        sendSuccess(res, await service.detail(name));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("No registered agent")) {
          throw new AppError(404, "AGENT_NOT_FOUND", error.message);
        }
        throw error;
      }
    })
  );

  return router;
}
