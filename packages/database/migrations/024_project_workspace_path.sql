-- Project owns local workspace path; workflows inherit by default.
-- Nullable for legacy rows; API create always persists a durable path under AGENT_WORKSPACE_ROOT.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS workspace_path TEXT;

COMMENT ON COLUMN projects.workspace_path IS
  'Local absolute workspace directory under AGENT_WORKSPACE_ROOT; workflows inherit when input.workspacePath is omitted.';
