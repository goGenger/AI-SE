CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  task_id UUID NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'created' CHECK (
    status IN ('created', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled', 'timed_out')
  ),
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  current_iteration INTEGER NOT NULL DEFAULT 0 CHECK (current_iteration >= 0),
  max_iterations INTEGER NOT NULL DEFAULT 0 CHECK (max_iterations >= 0),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error JSONB,
  token_usage JSONB,
  estimated_cost NUMERIC(14, 6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_runs_project_id_idx ON agent_runs(project_id);
CREATE INDEX IF NOT EXISTS agent_runs_task_id_idx ON agent_runs(task_id);
CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON agent_runs(status);
CREATE INDEX IF NOT EXISTS agent_runs_created_at_idx ON agent_runs(created_at);

DROP TRIGGER IF EXISTS agent_runs_set_updated_at ON agent_runs;
CREATE TRIGGER agent_runs_set_updated_at
BEFORE UPDATE ON agent_runs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS tool_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  iteration INTEGER NOT NULL DEFAULT 0 CHECK (iteration >= 0),
  tool_call_id VARCHAR(160) NOT NULL,
  tool_name VARCHAR(120) NOT NULL,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  status VARCHAR(32) NOT NULL DEFAULT 'running' CHECK (
    status IN ('running', 'succeeded', 'failed', 'cancelled', 'timed_out')
  ),
  error JSONB,
  duration INTEGER CHECK (duration IS NULL OR duration >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_run_id, tool_call_id)
);

CREATE INDEX IF NOT EXISTS tool_calls_agent_run_id_idx ON tool_calls(agent_run_id);
CREATE INDEX IF NOT EXISTS tool_calls_status_idx ON tool_calls(status);
CREATE INDEX IF NOT EXISTS tool_calls_created_at_idx ON tool_calls(created_at);

CREATE TABLE IF NOT EXISTS workflow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  event_type VARCHAR(120) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_events_agent_run_id_idx ON workflow_events(agent_run_id);
CREATE INDEX IF NOT EXISTS workflow_events_event_type_idx ON workflow_events(event_type);
CREATE INDEX IF NOT EXISTS workflow_events_created_at_idx ON workflow_events(created_at);
