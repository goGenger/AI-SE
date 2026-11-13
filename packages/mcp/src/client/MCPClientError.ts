import { MCPErrorCategory } from "../errors";

/**
 * Error thrown by MCP client implementations. Carries a DECLARED
 * MCPErrorCategory so classifyMCPError maps it deterministically onto the
 * existing RuntimeErrorCode set without heuristics.
 */
export class MCPClientError extends Error {
  constructor(
    public readonly mcpErrorCategory: MCPErrorCategory,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "MCPClientError";
  }
}
