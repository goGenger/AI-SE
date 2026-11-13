import { ApiErrorBody, ApiResponse } from "@ai-se/shared";
import { Response } from "express";

function requestIdFrom(res: Response): string {
  return typeof res.locals.requestId === "string" ? res.locals.requestId : "";
}

export function sendSuccess<T>(res: Response, data: T, statusCode = 200): void {
  const body: ApiResponse<T> = {
    success: true,
    data,
    requestId: requestIdFrom(res)
  };

  res.status(statusCode).json(body);
}

export function sendError(res: Response, error: ApiErrorBody, statusCode: number): void {
  const body: ApiResponse<never> = {
    success: false,
    error,
    requestId: requestIdFrom(res)
  };

  res.status(statusCode).json(body);
}
