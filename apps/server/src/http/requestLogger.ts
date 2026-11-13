import { randomUUID } from "crypto";
import { RequestHandler } from "express";
import { Logger } from "pino";

/** F1-7（FX-22）：敏感查询参数名（出现时值脱敏；令牌不得经 URL/日志外泄）。 */
const SENSITIVE_QUERY_PARAMS = new Set(["token", "api_token", "apiToken", "access_token", "auth"]);

/** 访问日志路径脱敏：`?token=xxx` → `?token=[REDACTED]`（其余参数原样）。 */
export function sanitizeUrlForLog(url: string): string {
  const [pathname, query] = url.split("?", 2);
  if (!query) return url;
  const params = new URLSearchParams(query);
  let redacted = false;
  for (const key of [...params.keys()]) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      params.set(key, "[REDACTED]");
      redacted = true;
    }
  }
  return redacted ? `${pathname}?${params.toString()}` : url;
}

export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const requestId = req.header("x-request-id") || randomUUID();
    const childLogger = logger.child({ requestId });

    res.locals.requestId = requestId;
    res.locals.logger = childLogger;
    res.setHeader("x-request-id", requestId);

    const startedAt = Date.now();
    res.on("finish", () => {
      childLogger.info(
        {
          method: req.method,
          path: sanitizeUrlForLog(req.originalUrl),
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt
        },
        "request completed"
      );
    });

    next();
  };
}
