export type RuntimeErrorCode =
  | "LLM_ERROR"
  | "TOOL_ERROR"
  | "SANDBOX_ERROR"
  | "COMMAND_ERROR"
  | "TEST_ERROR"
  | "TIMEOUT_ERROR"
  | "CANCELLED_ERROR"
  | "UNKNOWN_ERROR";

export interface NormalizedRuntimeError {
  code: RuntimeErrorCode;
  message: string;
  details?: unknown;
}

export class ToolExecutionError extends Error {
  constructor(
    public readonly code: RuntimeErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function normalizeRuntimeError(
  error: unknown,
  fallbackCode: RuntimeErrorCode = "UNKNOWN_ERROR"
): NormalizedRuntimeError {
  if (error instanceof ToolExecutionError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  }

  if (error instanceof Error) {
    return {
      code: fallbackCode,
      message: error.message
    };
  }

  return {
    code: fallbackCode,
    message: "Unknown runtime error",
    details: error
  };
}
