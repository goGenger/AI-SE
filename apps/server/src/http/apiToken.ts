import { createHash, timingSafeEqual } from "node:crypto";
import { RequestHandler } from "express";
import { AppError } from "./errors";

/** F1-7（FX-22）：常量时间令牌比较——两侧 sha256（定长）后 timingSafeEqual，消除长度侧信道。 */
function digestToken(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function tokenMatches(expected: string, provided: string): boolean {
  return timingSafeEqual(digestToken(expected), digestToken(provided));
}

/**
 * D-3（T8-c）：部署面 API 最小 Token 鉴权。
 *
 * 未配置 token（默认，本地开发）＝ 零行为变化；配置后 `/api/*` 需
 * `Authorization: Bearer <token>`（`/health` `/ready` 不在 /api 下，天然豁免）。
 */
export function apiTokenGuard(token: string | undefined): RequestHandler {
  return (req, _res, next) => {
    if (!token) {
      next();
      return;
    }
    const header = req.headers.authorization ?? "";
    const prefix = "Bearer ";
    const provided = header.startsWith(prefix) ? header.slice(prefix.length) : "";
    if (!provided || !tokenMatches(token, provided)) {
      next(new AppError(401, "UNAUTHORIZED", "API token is required"));
      return;
    }
    next();
  };
}
