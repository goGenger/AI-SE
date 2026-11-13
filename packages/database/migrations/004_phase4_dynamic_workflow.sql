CREATE TABLE IF NOT EXISTS workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id UUID NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  planning_version INTEGER NOT NULL CHECK (planning_version > 0),
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'RUNNING', 'PAUSED', 'WAITING_APPROVAL', 'SUCCESS', 'FAILED', 'CANCELLED')
  ),
  max_concurrency INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrency > 0),
  max_retries INTEGER NOT NULL DEFAULT 1 CHECK (max_retries >= 0),
  failure_strategy VARCHAR(32) NOT NULL DEFAULT 'FAIL_FAST' CHECK (
    failure_strategy IN ('FAIL_FAST', 'RETRY', 'CONTINUE', 'REPLAN')
  ),
  allow_retry BOOLEAN NOT NULL DEFAULT true,
  allow_replan BOOLEAN NOT NULL DEFAULT false,
  approval_required BOOLEAN NOT NULL DEFAULT false,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  error JSONB,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_runs_project_id_idx ON workflow_runs(project_id);
CREATE INDEX IF NOT EXISTS workflow_runs_requirement_id_idx ON workflow_runs(requirement_id);
CREATE INDEX IF NOT EXISTS workflow_runs_status_idx ON workflow_runs(status);

DROP TRIGGER IF EXISTS workflow_runs_set_updated_at ON workflow_runs;
CREATE TRIGGER workflow_runs_set_updated_at
BEFORE UPDATE ON workflow_runs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_requirement_id_version_task_key_key;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_status_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check CHECK (
    status IN (
      'PENDING', 'READY', 'RUNNING', 'WAITING_APPROVAL', 'SUCCESS',
      'FAILED', 'RETRYING', 'BLOCKED', 'CANCELLED'
    )
  );

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS plan_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origin VARCHAR(16) NOT NULL DEFAULT 'ORIGINAL' CHECK (
    origin IN ('ORIGINAL', 'RUNTIME', 'DYNAMIC')
  ),
  ADD COLUMN IF NOT EXISTS creation_reason TEXT,
  ADD COLUMN IF NOT EXISTS source_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_by_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approval_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_handled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_workflow_run_id_fkey;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_workflow_run_id_fkey
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_original_plan_key_idx
  ON tasks(requirement_id, version, task_key)
  WHERE workflow_run_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_workflow_key_idx
  ON tasks(workflow_run_id, task_key)
  WHERE workflow_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_workflow_run_id_idx ON tasks(workflow_run_id);
CREATE INDEX IF NOT EXISTS tasks_claim_idx ON tasks(workflow_run_id, status, claimed_at);

ALTER TABLE task_dependencies
  ADD COLUMN IF NOT EXISTS workflow_run_id UUID REFERENCES workflow_runs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS origin VARCHAR(16) NOT NULL DEFAULT 'ORIGINAL' CHECK (
    origin IN ('ORIGINAL', 'RUNTIME', 'DYNAMIC')
  ),
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS task_dependencies_workflow_run_id_idx
  ON task_dependencies(workflow_run_id);

CREATE TABLE IF NOT EXISTS approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'APPROVED', 'REJECTED')
  ),
  reason TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id)
);

CREATE INDEX IF NOT EXISTS approvals_workflow_run_id_idx ON approvals(workflow_run_id);
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status);

DROP TRIGGER IF EXISTS approvals_set_updated_at ON approvals;
CREATE TRIGGER approvals_set_updated_at
BEFORE UPDATE ON approvals
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

ALTER TABLE workflow_events
  ALTER COLUMN agent_run_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS sequence BIGSERIAL,
  ADD COLUMN IF NOT EXISTS workflow_run_id UUID REFERENCES workflow_runs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES tasks(id) ON DELETE CASCADE;

ALTER TABLE workflow_events
  DROP CONSTRAINT IF EXISTS workflow_events_owner_check;

ALTER TABLE workflow_events
  ADD CONSTRAINT workflow_events_owner_check CHECK (
    agent_run_id IS NOT NULL OR workflow_run_id IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS workflow_events_workflow_run_id_idx
  ON workflow_events(workflow_run_id);
CREATE INDEX IF NOT EXISTS workflow_events_task_id_idx ON workflow_events(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_events_sequence_idx ON workflow_events(sequence);
