import { JsonObject } from "@ai-se/shared";
import { ToolRiskLevel } from "@ai-se/tool-runtime";
import { MCPTransport } from "./contracts";

/**
 * Phase 5.5-0 Persistence Contract
 *
 * Freezes the minimal model for three entities:
 *
 *   mcp_servers        — server registration + connection state
 *   mcp_tools          — discovered tool metadata (static), no runtime state
 *   mcp_tool_bindings  — Project / Agent grants, deny by default
 *
 * These are ENTITY TYPES only. The SQL migration, repositories, and wiring are
 * implemented in Phase 5.5-3 (Registry & Persistence); see
 * docs/25-mcp-contract-freeze.md for the full DDL design (keys, indexes,
 * unique constraints, relations).
 *
 * MCP tool-call audit is NOT duplicated: it reuses the existing tool_calls /
 * audit_logs tables via ToolCallRecorder.
 */

export type MCPServerStatus =
  | "REGISTERED"
  | "CONNECTING"
  | "CONNECTED"
  | "DEGRADED"
  | "RECONNECTING"
  | "DISCONNECTED"
  | "REVOKED";

export interface MCPServerEntity {
  id: string;
  name: string;
  description: string;
  transport: MCPTransport;
  /** Reserved for 5.5-4 Streamable HTTP; NULL for stdio. */
  endpoint?: string;
  /** stdio launch command; NULL once remote transports exist. */
  command?: string;
  /** JSONB string[] */
  args: string[];
  /** stdio env (credential-shaped keys are rejected by validateMCPServerDefinition). */
  env: Record<string, string>;
  /** stdio working directory. */
  cwd?: string;
  status: MCPServerStatus;
  enabled: boolean;
  /** References only — never plaintext credentials. */
  authRef?: string;
  credentialRef?: string;
  lastConnectedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MCPToolEntity {
  id: string;
  mcpServerId: string;
  name: string;
  description: string;
  /** JSON Schema object reported by the server, stored as JSONB. */
  inputSchema: JsonObject;
  enabled: boolean;
  /** Platform-decided risk, not server-reported. */
  riskLevel: ToolRiskLevel;
  requiresApproval: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MCPToolBindingEntity {
  id: string;
  projectId: string;
  /**
   * NULL = project-scope grant (applies to every agent of the project).
   * Agents are code-defined in AgentRegistry, so bindings address them by
   * their stable name (matching the 5.5-2 MCPToolRegistry contract).
   */
  agentName?: string;
  mcpServerId: string;
  /** NULL = all tools of the server. */
  mcpToolId?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Resolved inputs for the frozen visibility chain:
 *
 *   MCP Server registered
 *       → Server enabled
 *       → Project binding
 *       → Agent binding
 *       → Tool enabled
 *       → Policy allowed
 *       → Agent-visible
 *
 * Any unresolved binding is DENY.
 */
export interface MCPToolVisibilityInput {
  serverEnabled: boolean;
  toolEnabled: boolean;
  projectBound: boolean;
  agentBound: boolean;
  policyAllowed: boolean;
}

export function isMCPToolVisible(input: MCPToolVisibilityInput): boolean {
  return (
    input.serverEnabled &&
    input.projectBound &&
    input.agentBound &&
    input.toolEnabled &&
    input.policyAllowed
  );
}
