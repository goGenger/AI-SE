import { Router } from "express";
import { asyncHandler } from "../http/errors";
import { MetricsService } from "../services/metricsService";

/**
 * 7-B：`GET /api/metrics`——Prometheus 文本格式（不是统一 JSON 信封）。
 * 挂在 `/api` 之下以继承既有的 `apiTokenGuard`（`apps/server/src/app.ts`）。
 */
export function createMetricsRouter(service: Pick<MetricsService, "render">): Router {
  const router = Router();

  router.get(
    "/metrics",
    asyncHandler(async (_req, res) => {
      res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.send(await service.render());
    })
  );

  return router;
}
