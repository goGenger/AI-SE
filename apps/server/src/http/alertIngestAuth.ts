import { RequestHandler } from "express";
import { AppError } from "./errors";
import { tokenMatches } from "./apiToken";

/**
 * Phase 8-A alert ingest auth (docs/242 §8 — minimal safe default pending user confirm).
 *
 * Precedence:
 * 1. `ALERT_INGEST_TOKEN` configured → Bearer must match it (dedicated webhook secret).
 * 2. Else `API_TOKEN` configured → Bearer must match API_TOKEN (same as other /api routes;
 *    the global guard already enforced this, but we re-check for clarity when this
 *    middleware is unit-tested in isolation).
 * 3. Else both unset:
 *    - production → 401 (refuse naked webhook)
 *    - otherwise → allow (local/dev parity with API_TOKEN default-off)
 */
export function alertIngestGuard(options: {
  alertIngestToken?: string;
  apiToken?: string;
  nodeEnv: string;
}): RequestHandler {
  const { alertIngestToken, apiToken, nodeEnv } = options;
  return (req, _res, next) => {
    const header = req.headers.authorization ?? "";
    const prefix = "Bearer ";
    const provided = header.startsWith(prefix) ? header.slice(prefix.length) : "";

    if (alertIngestToken) {
      if (!provided || !tokenMatches(alertIngestToken, provided)) {
        next(new AppError(401, "UNAUTHORIZED", "Alert ingest token is required"));
        return;
      }
      next();
      return;
    }

    if (apiToken) {
      if (!provided || !tokenMatches(apiToken, provided)) {
        next(new AppError(401, "UNAUTHORIZED", "API token is required"));
        return;
      }
      next();
      return;
    }

    if (nodeEnv === "production") {
      next(
        new AppError(
          401,
          "UNAUTHORIZED",
          "Alert ingest requires ALERT_INGEST_TOKEN (or API_TOKEN) in production"
        )
      );
      return;
    }

    next();
  };
}
