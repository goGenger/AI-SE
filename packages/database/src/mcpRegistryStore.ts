import type {
  MCPServerEntity,
  MCPServerStatus,
  MCPToolBindingEntity,
  MCPToolEntity
} from "@ai-se/mcp";
import type {
  DiscoveredToolRecord,
  MCPBindingFilter,
  MCPBindingRowInput,
  MCPBindingScopeInput,
  MCPRegistryStore,
  MCPServerPatch,
  MCPToolPatch,
  NewMCPServerRecord
} from "@ai-se/mcp";
import { MCPRegistryStoreError } from "@ai-se/mcp";
import { Pool, PoolClient } from "pg";

/**
 * Phase 5.5-3: PostgreSQL implementation of the MCP registry store
 * (mcp_servers / mcp_tools / mcp_tool_bindings, migration 008).
 *
 * Raw SQL only (no ORM), following the Pg*Store conventions of this package.
 * updated_at is maintained by the table triggers, not by these queries.
 */

interface MCPServerRow {
  id: string;
  name: string;
  description: string;
  transport: string;
  endpoint: string | null;
  command: string | null;
  args: unknown;
  env: unknown;
  cwd: string | null;
  status: MCPServerStatus;
  enabled: boolean;
  auth_ref: string | null;
  credential_ref: string | null;
  last_connected_at: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MCPToolRow {
  id: string;
  mcp_server_id: string;
  name: string;
  description: string;
  input_schema: unknown;
  enabled: boolean;
  risk_level: MCPToolEntity["riskLevel"];
  requires_approval: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MCPBindingRow {
  id: string;
  project_id: string;
  agent_name: string | null;
  mcp_server_id: string;
  mcp_tool_id: string | null;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIsoString(value: Date | string | null): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") record[key] = entry;
  }
  return record;
}

function jsonObject(value: unknown): MCPToolEntity["inputSchema"] {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as MCPToolEntity["inputSchema"])
    : {};
}

function mapServer(row: MCPServerRow): MCPServerEntity {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    transport: row.transport as MCPServerEntity["transport"],
    endpoint: row.endpoint ?? undefined,
    command: row.command ?? undefined,
    args: stringArray(row.args),
    env: stringRecord(row.env),
    cwd: row.cwd ?? undefined,
    status: row.status,
    enabled: row.enabled,
    authRef: row.auth_ref ?? undefined,
    credentialRef: row.credential_ref ?? undefined,
    lastConnectedAt: toIsoString(row.last_connected_at),
    lastError: row.last_error ?? undefined,
    createdAt: toIsoString(row.created_at) ?? "",
    updatedAt: toIsoString(row.updated_at) ?? ""
  };
}

function mapTool(row: MCPToolRow): MCPToolEntity {
  return {
    id: row.id,
    mcpServerId: row.mcp_server_id,
    name: row.name,
    description: row.description,
    inputSchema: jsonObject(row.input_schema),
    enabled: row.enabled,
    riskLevel: row.risk_level,
    requiresApproval: row.requires_approval,
    createdAt: toIsoString(row.created_at) ?? "",
    updatedAt: toIsoString(row.updated_at) ?? ""
  };
}

function mapBinding(row: MCPBindingRow): MCPToolBindingEntity {
  return {
    id: row.id,
    projectId: row.project_id,
    agentName: row.agent_name ?? undefined,
    mcpServerId: row.mcp_server_id,
    mcpToolId: row.mcp_tool_id ?? undefined,
    enabled: row.enabled,
    createdAt: toIsoString(row.created_at) ?? "",
    updatedAt: toIsoString(row.updated_at) ?? ""
  };
}

const SERVER_PATCH_COLUMNS: Record<keyof MCPServerPatch, string> = {
  name: "name",
  description: "description",
  transport: "transport",
  endpoint: "endpoint",
  command: "command",
  args: "args",
  env: "env",
  cwd: "cwd",
  status: "status",
  enabled: "enabled",
  authRef: "auth_ref",
  credentialRef: "credential_ref",
  lastConnectedAt: "last_connected_at",
  lastError: "last_error"
};

const TOOL_PATCH_COLUMNS: Record<keyof MCPToolPatch, string> = {
  enabled: "enabled",
  riskLevel: "risk_level",
  requiresApproval: "requires_approval"
};

export class PgMCPRegistryStore implements MCPRegistryStore {
  constructor(private readonly pool: Pool) {}

  // ── mcp_servers ──────────────────────────────────────────────────────────

  async createServer(record: NewMCPServerRecord): Promise<MCPServerEntity> {
    const result = await this.pool.query<MCPServerRow>(
      `
        INSERT INTO mcp_servers (
          id, name, description, transport, endpoint, command, args, env, cwd,
          status, enabled, auth_ref, credential_ref
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
      `,
      [
        record.id,
        record.name,
        record.description,
        record.transport,
        record.endpoint ?? null,
        record.command ?? null,
        JSON.stringify(record.args),
        JSON.stringify(record.env),
        record.cwd ?? null,
        record.status,
        record.enabled,
        record.authRef ?? null,
        record.credentialRef ?? null
      ]
    );
    return mapServer(result.rows[0]);
  }

  async getServer(id: string): Promise<MCPServerEntity | null> {
    const result = await this.pool.query<MCPServerRow>(`SELECT * FROM mcp_servers WHERE id = $1`, [
      id
    ]);
    return result.rows[0] ? mapServer(result.rows[0]) : null;
  }

  async listServers(): Promise<MCPServerEntity[]> {
    const result = await this.pool.query<MCPServerRow>(
      `SELECT * FROM mcp_servers ORDER BY created_at ASC`
    );
    return result.rows.map(mapServer);
  }

  async updateServer(id: string, patch: MCPServerPatch): Promise<MCPServerEntity | null> {
    const assignments: string[] = [];
    const values: unknown[] = [id];

    for (const [key, column] of Object.entries(SERVER_PATCH_COLUMNS) as Array<
      [keyof MCPServerPatch, string]
    >) {
      const value = patch[key];
      if (value === undefined) continue;
      // JSONB columns: serialize explicitly (pg would turn arrays into
      // Postgres array literals instead of JSON).
      values.push(key === "args" || key === "env" ? JSON.stringify(value) : value);
      assignments.push(`${column} = $${values.length}`);
    }

    if (assignments.length === 0) {
      return await this.getServer(id);
    }

    const result = await this.pool.query<MCPServerRow>(
      `UPDATE mcp_servers SET ${assignments.join(", ")} WHERE id = $1 RETURNING *`,
      values
    );
    return result.rows[0] ? mapServer(result.rows[0]) : null;
  }

  async deleteServer(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM mcp_servers WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  // ── mcp_tools ────────────────────────────────────────────────────────────

  async listTools(serverId: string): Promise<MCPToolEntity[]> {
    const result = await this.pool.query<MCPToolRow>(
      `SELECT * FROM mcp_tools WHERE mcp_server_id = $1 ORDER BY name ASC`,
      [serverId]
    );
    return result.rows.map(mapTool);
  }

  async getToolById(id: string): Promise<MCPToolEntity | null> {
    const result = await this.pool.query<MCPToolRow>(`SELECT * FROM mcp_tools WHERE id = $1`, [id]);
    return result.rows[0] ? mapTool(result.rows[0]) : null;
  }

  async getToolByName(serverId: string, name: string): Promise<MCPToolEntity | null> {
    const result = await this.pool.query<MCPToolRow>(
      `SELECT * FROM mcp_tools WHERE mcp_server_id = $1 AND name = $2`,
      [serverId, name]
    );
    return result.rows[0] ? mapTool(result.rows[0]) : null;
  }

  async upsertDiscoveredTools(
    serverId: string,
    tools: DiscoveredToolRecord[]
  ): Promise<MCPToolEntity[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const tool of tools) {
        await client.query(
          `
            INSERT INTO mcp_tools (mcp_server_id, name, description, input_schema)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (mcp_server_id, name)
            DO UPDATE SET
              description = EXCLUDED.description,
              input_schema = EXCLUDED.input_schema
          `,
          [serverId, tool.name, tool.description, tool.inputSchema ?? {}]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return await this.listTools(serverId);
  }

  async updateTool(id: string, patch: MCPToolPatch): Promise<MCPToolEntity | null> {
    const assignments: string[] = [];
    const values: unknown[] = [id];

    for (const [key, column] of Object.entries(TOOL_PATCH_COLUMNS) as Array<
      [keyof MCPToolPatch, string]
    >) {
      const value = patch[key];
      if (value === undefined) continue;
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }

    if (assignments.length === 0) {
      return await this.getToolById(id);
    }

    const result = await this.pool.query<MCPToolRow>(
      `UPDATE mcp_tools SET ${assignments.join(", ")} WHERE id = $1 RETURNING *`,
      values
    );
    return result.rows[0] ? mapTool(result.rows[0]) : null;
  }

  // ── mcp_tool_bindings ────────────────────────────────────────────────────

  async listBindings(filter: MCPBindingFilter): Promise<MCPToolBindingEntity[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter.projectId !== undefined) {
      values.push(filter.projectId);
      conditions.push(`project_id = $${values.length}`);
    }
    if (filter.serverId !== undefined) {
      values.push(filter.serverId);
      conditions.push(`mcp_server_id = $${values.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<MCPBindingRow>(
      `SELECT * FROM mcp_tool_bindings ${where} ORDER BY created_at ASC`,
      values
    );
    return result.rows.map(mapBinding);
  }

  private async resolveToolIds(
    client: PoolClient,
    serverId: string,
    toolNames: string[]
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const name of toolNames) {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM mcp_tools WHERE mcp_server_id = $1 AND name = $2`,
        [serverId, name]
      );
      if (!result.rows[0]) {
        throw new Error(`Unknown MCP tool ${serverId}/${name} for binding`);
      }
      ids.push(result.rows[0].id);
    }
    return ids;
  }

  private async replaceScope(
    input: MCPBindingScopeInput,
    agentName: string | undefined
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM mcp_tool_bindings
         WHERE project_id = $1 AND mcp_server_id = $2
           AND agent_name IS NOT DISTINCT FROM $3`,
        [input.projectId, input.serverId, agentName ?? null]
      );

      const enabled = input.enabled ?? true;
      const toolIds =
        input.toolNames === undefined
          ? [null]
          : await this.resolveToolIds(client, input.serverId, input.toolNames);

      for (const toolId of toolIds) {
        await client.query(
          `
            INSERT INTO mcp_tool_bindings (project_id, agent_name, mcp_server_id, mcp_tool_id, enabled)
            VALUES ($1, $2, $3, $4, $5)
          `,
          [input.projectId, agentName ?? null, input.serverId, toolId, enabled]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceProjectBinding(input: MCPBindingScopeInput): Promise<void> {
    await this.replaceScope(input, undefined);
  }

  async replaceAgentBinding(input: MCPBindingScopeInput & { agentName: string }): Promise<void> {
    await this.replaceScope(input, input.agentName);
  }

  async removeProjectBinding(projectId: string, serverId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM mcp_tool_bindings
       WHERE project_id = $1 AND mcp_server_id = $2 AND agent_name IS NULL`,
      [projectId, serverId]
    );
  }

  async removeAgentBinding(projectId: string, agentName: string, serverId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM mcp_tool_bindings
       WHERE project_id = $1 AND mcp_server_id = $2 AND agent_name = $3`,
      [projectId, serverId, agentName]
    );
  }

  // ── Phase 5.5-5: binding-row CRUD (console) ──────────────────────────────

  async createBinding(input: MCPBindingRowInput): Promise<MCPToolBindingEntity> {
    let toolId: string | null = null;
    if (input.toolName !== undefined) {
      const tool = await this.getToolByName(input.serverId, input.toolName);
      if (!tool) {
        throw new MCPRegistryStoreError(
          "UNKNOWN_TOOL",
          `Unknown MCP tool ${input.serverId}/${input.toolName} for binding`
        );
      }
      toolId = tool.id;
    }

    const duplicate = await this.pool.query(
      `SELECT id FROM mcp_tool_bindings
       WHERE project_id = $1 AND mcp_server_id = $2
         AND agent_name IS NOT DISTINCT FROM $3
         AND mcp_tool_id IS NOT DISTINCT FROM $4`,
      [input.projectId, input.serverId, input.agentName ?? null, toolId]
    );
    if ((duplicate.rowCount ?? 0) > 0) {
      throw new MCPRegistryStoreError(
        "DUPLICATE_BINDING",
        `MCP binding already exists for ${input.serverId}/${input.toolName ?? "all tools"}`
      );
    }

    try {
      const result = await this.pool.query<MCPBindingRow>(
        `
          INSERT INTO mcp_tool_bindings (project_id, agent_name, mcp_server_id, mcp_tool_id, enabled)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `,
        [input.projectId, input.agentName ?? null, input.serverId, toolId, input.enabled ?? true]
      );
      return mapBinding(result.rows[0]);
    } catch (error) {
      // Backstop for races the pre-check cannot see; the unique index and the
      // FKs are declared with stable names in migration 008.
      const code = (error as { code?: string }).code;
      if (code === "23505") {
        throw new MCPRegistryStoreError(
          "DUPLICATE_BINDING",
          `MCP binding already exists for ${input.serverId}/${input.toolName ?? "all tools"}`
        );
      }
      if (code === "23503") {
        const constraint = (error as { constraint?: string }).constraint ?? "";
        if (constraint.includes("project_id")) {
          throw new MCPRegistryStoreError("UNKNOWN_PROJECT", `Unknown project: ${input.projectId}`);
        }
        if (constraint.includes("server_id")) {
          throw new MCPRegistryStoreError(
            "UNKNOWN_SERVER",
            `Unknown MCP server: ${input.serverId}`
          );
        }
        throw new MCPRegistryStoreError("UNKNOWN_TOOL", `Invalid MCP binding reference`);
      }
      throw error;
    }
  }

  async updateBinding(
    id: string,
    patch: { enabled: boolean }
  ): Promise<MCPToolBindingEntity | null> {
    const result = await this.pool.query<MCPBindingRow>(
      `UPDATE mcp_tool_bindings SET enabled = $2 WHERE id = $1 RETURNING *`,
      [id, patch.enabled]
    );
    return result.rows[0] ? mapBinding(result.rows[0]) : null;
  }

  async deleteBinding(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM mcp_tool_bindings WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
