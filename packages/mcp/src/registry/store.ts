import { ToolRiskLevel } from "@ai-se/tool-runtime";
import { MCPTransport } from "../contracts";
import {
  MCPServerEntity,
  MCPServerStatus,
  MCPToolBindingEntity,
  MCPToolEntity
} from "../persistence";

/**
 * Phase 5.5-3: persistence backend port for the MCP registry.
 *
 * The store owns ONLY rows and constraints. Authorization semantics stay in
 * the registry layer (frozen visibility chain); the store never decides.
 * Implementations: InMemoryMCPRegistryStore (tests/dev) and
 * PgMCPRegistryStore (@ai-se/database, production).
 *
 * Fail-closed contract: registry reads treat store errors as DENY.
 */

export interface NewMCPServerRecord {
  id: string;
  name: string;
  description: string;
  transport: MCPTransport;
  endpoint?: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  status: MCPServerStatus;
  enabled: boolean;
  authRef?: string;
  credentialRef?: string;
}

export interface MCPServerPatch {
  name?: string;
  description?: string;
  transport?: MCPTransport;
  endpoint?: string | null;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  status?: MCPServerStatus;
  enabled?: boolean;
  authRef?: string | null;
  credentialRef?: string | null;
  lastConnectedAt?: string | null;
  lastError?: string | null;
}

/** One discovered tool as reported by tools/list. */
export interface DiscoveredToolRecord {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface MCPToolPatch {
  enabled?: boolean;
  riskLevel?: ToolRiskLevel;
  requiresApproval?: boolean;
}

export interface MCPBindingFilter {
  projectId?: string;
  serverId?: string;
}

export interface MCPBindingScopeInput {
  projectId: string;
  serverId: string;
  /** Undefined = all tools of the server. */
  toolNames?: string[];
  /** Bindings default to enabled; pass false to create a dormant grant. */
  enabled?: boolean;
}

/** One binding ROW (console CRUD unit; the scope methods above stay unchanged). */
export interface MCPBindingRowInput {
  projectId: string;
  serverId: string;
  /** Undefined = project-scope grant. */
  agentName?: string;
  /** Undefined = all tools of the server. */
  toolName?: string;
  /** Fail-closed ergonomics: console grants default to enabled. */
  enabled?: boolean;
}

export type MCPRegistryStoreErrorCode =
  | "DUPLICATE_BINDING"
  | "UNKNOWN_TOOL"
  | "UNKNOWN_PROJECT"
  | "UNKNOWN_SERVER";

/**
 * Phase 5.5-5: typed store failures so the Console API can map them onto
 * HTTP semantics without parsing messages.
 */
export class MCPRegistryStoreError extends Error {
  constructor(
    public readonly code: MCPRegistryStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "MCPRegistryStoreError";
  }
}

export interface MCPRegistryStore {
  // ── mcp_servers ──────────────────────────────────────────────────────────
  createServer(record: NewMCPServerRecord): Promise<MCPServerEntity>;
  getServer(id: string): Promise<MCPServerEntity | null>;
  listServers(): Promise<MCPServerEntity[]>;
  updateServer(id: string, patch: MCPServerPatch): Promise<MCPServerEntity | null>;
  deleteServer(id: string): Promise<boolean>;

  // ── mcp_tools ────────────────────────────────────────────────────────────
  listTools(serverId: string): Promise<MCPToolEntity[]>;
  getToolById(id: string): Promise<MCPToolEntity | null>;
  getToolByName(serverId: string, name: string): Promise<MCPToolEntity | null>;
  /**
   * Persists one discovery pass (tools/list result):
   *  - new tools are inserted disabled with default policy;
   *  - existing tools keep enabled / risk / approval (operator state);
   *  - tools no longer reported are left untouched (calls fail loudly at the
   *    server; rows are kept so bindings are not cascade-deleted).
   */
  upsertDiscoveredTools(serverId: string, tools: DiscoveredToolRecord[]): Promise<MCPToolEntity[]>;
  updateTool(id: string, patch: MCPToolPatch): Promise<MCPToolEntity | null>;

  // ── mcp_tool_bindings ────────────────────────────────────────────────────
  listBindings(filter: MCPBindingFilter): Promise<MCPToolBindingEntity[]>;
  /** Replaces the project-scope grant (agent_name IS NULL) for one server. */
  replaceProjectBinding(input: MCPBindingScopeInput): Promise<void>;
  /** Replaces the agent-scope grant for one server. */
  replaceAgentBinding(input: MCPBindingScopeInput & { agentName: string }): Promise<void>;
  removeProjectBinding(projectId: string, serverId: string): Promise<void>;
  removeAgentBinding(projectId: string, agentName: string, serverId: string): Promise<void>;

  /**
   * Phase 5.5-5 (console): creates ONE binding row without touching the other
   * rows of the same scope. Duplicate (project, agent, server, tool) →
   * MCPRegistryStoreError("DUPLICATE_BINDING"); unknown tool name →
   * MCPRegistryStoreError("UNKNOWN_TOOL"); unfilled FK →
   * MCPRegistryStoreError("UNKNOWN_PROJECT" / "UNKNOWN_SERVER").
   */
  createBinding(input: MCPBindingRowInput): Promise<MCPToolBindingEntity>;
  /** Enables/disables ONE binding row by id; null when the row is missing. */
  updateBinding(id: string, patch: { enabled: boolean }): Promise<MCPToolBindingEntity | null>;
  /** Revokes ONE binding row by id; false when the row is missing. */
  deleteBinding(id: string): Promise<boolean>;
}
