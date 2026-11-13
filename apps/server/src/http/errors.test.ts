import { describe, expect, it, vi } from "vitest";
import { errorHandler, AppError } from "./errors";
import type { Request, Response } from "express";

function mockRes(): Response {
  const res = {
    locals: {},
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  };
  return res as unknown as Response;
}

describe("errorHandler logging", () => {
  it("logs original Error message and stack on unexpected 500", () => {
    const error = vi.fn();
    const warn = vi.fn();
    const logger = { error, warn, child: vi.fn() } as never;
    const handler = errorHandler(logger);
    const boom = new Error("database went away");

    handler(boom, {} as Request, mockRes(), vi.fn());

    expect(error).toHaveBeenCalledTimes(1);
    const [payload, message] = error.mock.calls[0];
    expect(message).toBe("Internal server error");
    expect(payload.statusCode).toBe(500);
    expect(payload.code).toBe("INTERNAL_SERVER_ERROR");
    expect(payload.failure).toMatchObject({
      type: "Error",
      message: "database went away"
    });
    expect(String(payload.failure.stack)).toContain("database went away");
  });

  it("logs AppError at warn for 4xx without inventing a 500", () => {
    const error = vi.fn();
    const warn = vi.fn();
    const logger = { error, warn, child: vi.fn() } as never;
    const handler = errorHandler(logger);

    handler(
      new AppError(404, "NOT_FOUND", "missing"),
      {} as Request,
      mockRes(),
      vi.fn()
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });
});
