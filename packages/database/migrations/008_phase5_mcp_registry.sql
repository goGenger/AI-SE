-- Phase 5.5-3 MCP Registry & Persistence
-- mcp_servers / mcp_tools / mcp_tool_bindings
--
-- Design follows docs/25 §3 (frozen 5.5-0 contract) with two documented
-- adjustments to match the actual codebase:
--   1. bindings use agent_name TEXT (agents are code-defined in AgentRegistry;
--      there is no agents table, and the 5.5-2 MCPToolRegistry contract
--      addresses agents by name).
--   2. mcp_servers additionally persists stdio env/cwd because
--      MCPServerDefinition.stdio carries them and restart recovery must
--      restore the exact definition (validation still rejects
--      credential-shaped env keys at the application layer).
--
-- Defaults are fail-closed: servers, tools and bindings start disabled and
-- must be explicitly enabled.

CREATE TABLE IF NOT EXISTS mcp_servers (
  id                UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  transport         TEXT NOT NULL DEFAULT 'stdio',
  endpoint          TEXT,
  command           TEXT,
  args              JSONB NOT NULL DEFAULT '[]'::jsonb,
  env               JSONB NOT NULL DEFAULT '{}'::jsonb,
  cwd               TEXT,
  status            TEXT NOT NULL DEFAULT 'REGISTERED',
  enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  auth_ref          TEXT,
  credential_ref    TEXT,
  last_connected_at TIMESTAMPTZ,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_servers_name_key ON mcp_servers (name);

DROP TRIGGER IF EXISTS mcp_servers_set_updated_at ON mcp_servers;
CREATE TRIGGER mcp_servers_set_updated_at
BEFORE UPDATE ON mcp_servers
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS mcp_tools (
  id                UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  mcp_server_id     UUID NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  input_schema      JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  risk_level        TEXT NOT NULL DEFAULT 'MEDIUM',
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_tools_server_name_key ON mcp_tools (mcp_server_id, name);
CREATE INDEX IF NOT EXISTS mcp_tools_server_idx ON mcp_tools (mcp_server_id);

DROP TRIGGER IF EXISTS mcp_tools_set_updated_at ON mcp_tools;
CREATE TRIGGER mcp_tools_set_updated_at
BEFORE UPDATE ON mcp_tools
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS mcp_tool_bindings (
  id              UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  agent_name      TEXT,
  mcp_server_id   UUID NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
  mcp_tool_id     UUID REFERENCES mcp_tools (id) ON DELETE CASCADE,
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_tool_bindings_scope_key
  ON mcp_tool_bindings (project_id, agent_name, mcp_server_id, mcp_tool_id)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS mcp_tool_bindings_project_idx ON mcp_tool_bindings (project_id);
CREATE INDEX IF NOT EXISTS mcp_tool_bindings_agent_idx ON mcp_tool_bindings (agent_name);
CREATE INDEX IF NOT EXISTS mcp_tool_bindings_server_idx ON mcp_tool_bindings (mcp_server_id);

DROP TRIGGER IF EXISTS mcp_tool_bindings_set_updated_at ON mcp_tool_bindings;
CREATE TRIGGER mcp_tool_bindings_set_updated_at
BEFORE UPDATE ON mcp_tool_bindings
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
