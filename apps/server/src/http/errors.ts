import { sanitizeLogData } from "@ai-se/observability";
import { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { Logger } from "pino";
import { ZodError } from "zod";
import { sendError } from "./response";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

type AsyncRoute = (req: Request, res: Response, next: NextFunction) => Promise<void>;

export function asyncHandler(handler: AsyncRoute): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof ZodError) {
    return new AppError(400, "VALIDATION_ERROR", "Request validation failed", error.flatten());
  }

  return new AppError(500, "INTERNAL_SERVER_ERROR", "Internal server error");
}

function getLogger(res: Response, fallback: Logger): Logger {
  return res.locals.logger && typeof res.locals.logger.warn === "function"
    ? (res.locals.logger as Logger)
    : fallback;
}

export function notFoundHandler(_req: Request, res: Response): void {
  sendError(res, { code: "NOT_FOUND", message: "Route not found" }, 404);
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    const appError = normalizeError(error);
    const requestLogger = getLogger(res, logger);
    // Keep the client-facing AppError, but always log the original failure
    // (message + stack). Without `err`, unexpected 500s only showed
    // "Internal server error" and operators saw no root cause on the console.
    // Use `failure` (not pino's reserved `err`): pino's default err serializer
    // re-wraps already-sanitized plain objects as `{ type: "Object", ... }` and
    // obscures the real Error name. sanitizeLogData keeps message + stack.
    const logPayload = sanitizeLogData({
      code: appError.code,
      statusCode: appError.statusCode,
      details: appError.details,
      failure: error
    });

    if (appError.statusCode >= 500) {
      requestLogger.error(logPayload, appError.message);
    } else {
      requestLogger.warn(logPayload, appError.message);
    }

    sendError(
      res,
      {
        code: appError.code,
        message: appError.message,
        details: appError.details
      },
      appError.statusCode
    );
  };
}
