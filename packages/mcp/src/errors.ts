import { NormalizedRuntimeError } from "@ai-se/tool-runtime";

/**
 * Phase 5.5-0 Error Contract
 *
 * MCP-layer failures are classified into categories, then mapped onto the
 * EXISTING RuntimeErrorCode set of @ai-se/tool-runtime
 * (LLM_ERROR | TOOL_ERROR | SANDBOX_ERROR | COMMAND_ERROR | TEST_ERROR |
 *  TIMEOUT_ERROR | CANCELLED_ERROR | UNKNOWN_ERROR).
 *
 * No new error-code enum is created. The category travels as metadata in
 * NormalizedRuntimeError.details so Workflow/Task layers consume only unified
 * errors and never MCP protocol details.
 *
 * VALIDATION / PERMISSION_DENIED / APPROVAL_REQUIRED are handled by the Tool
 * Runtime chain BEFORE the adapter is reached; if one ever surfaces here it
 * maps to TOOL_ERROR.
 */

export type MCPErrorCategory =
  | "VALIDATION"
  | "PERMISSION_DENIED"
  | "APPROVAL_REQUIRED"
  | "TIMEOUT"
  | "CANCELLED"
  | "CONNECTION"
  | "REMOTE_TOOL"
  | "RATE_LIMITED"
  | "INTERNAL";

const MCP_ERROR_CATEGORIES: readonly MCPErrorCategory[] = [
  "VALIDATION",
  "PERMISSION_DENIED",
  "APPROVAL_REQUIRED",
  "TIMEOUT",
  "CANCELLED",
  "CONNECTION",
  "REMOTE_TOOL",
  "RATE_LIMITED",
  "INTERNAL"
];

export function isMCPErrorCategory(value: unknown): value is MCPErrorCategory {
  return typeof value === "string" && MCP_ERROR_CATEGORIES.includes(value as MCPErrorCategory);
}

export interface MCPErrorClassificationInput {
  error?: unknown;
  aborted?: boolean;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/**
 * Errors may carry a declared category (e.g. the SDK adapter in 5.5-1, or the
 * mock fixture in this package) which always wins over heuristics.
 */
function declaredCategory(error: unknown): MCPErrorCategory | undefined {
  if (typeof error === "object" && error !== null && "mcpErrorCategory" in error) {
    const value = (error as { mcpErrorCategory?: unknown }).mcpErrorCategory;
    return isMCPErrorCategory(value) ? value : undefined;
  }
  return undefined;
}

export function classifyMCPError(input: MCPErrorClassificationInput): MCPErrorCategory {
  if (input.aborted) return "CANCELLED";
  const declared = declaredCategory(input.error);
  if (declared) return declared;

  const name = errorName(input.error);
  const message = errorMessage(input.error);

  if (name === "TimeoutError" || /\btimed?\s?out\b/i.test(message)) return "TIMEOUT";
  if (name === "AbortError") return "CANCELLED";
  if (/\brate[ -]?limit(ed|ing)?\b|429/i.test(message)) return "RATE_LIMITED";
  if (/ECONN|ENOTFOUND|ETIMEDOUT|connection refused|not connected/i.test(message)) {
    return "CONNECTION";
  }
  return "INTERNAL";
}

/**
 * Frozen mapping onto the existing RuntimeErrorCode set. Every produced code
 * must already exist in @ai-se/tool-runtime — no new codes.
 */
export function mapMCPErrorToRuntimeError(
  category: MCPErrorCategory,
  error: unknown
): NormalizedRuntimeError {
  const message = errorMessage(error) || `MCP ${category.toLowerCase()} error`;
  const details = { mcpErrorCategory: category };

  switch (category) {
    case "TIMEOUT":
      return { code: "TIMEOUT_ERROR", message, details };
    case "CANCELLED":
      return { code: "CANCELLED_ERROR", message, details };
    default:
      // VALIDATION / PERMISSION_DENIED / APPROVAL_REQUIRED are platform-level
      // concerns that the Tool Runtime resolves before the adapter is reached.
      return { code: "TOOL_ERROR", message, details };
  }
}
