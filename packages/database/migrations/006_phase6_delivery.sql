ALTER TABLE workflow_runs
  DROP CONSTRAINT IF EXISTS workflow_runs_failure_strategy_check;

ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_failure_strategy_check CHECK (
    failure_strategy IN ('FAIL_FAST', 'RETRY', 'CONTINUE', 'REPLAN', 'ROLLBACK')
  );

CREATE TABLE IF NOT EXISTS deployment_environments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(16) NOT NULL CHECK (name IN ('dev', 'staging', 'production')),
  endpoint VARCHAR(1000) NOT NULL,
  adapter VARCHAR(32) NOT NULL DEFAULT 'docker' CHECK (adapter IN ('docker')),
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_reference VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

DROP TRIGGER IF EXISTS deployment_environments_set_updated_at ON deployment_environments;
CREATE TRIGGER deployment_environments_set_updated_at
BEFORE UPDATE ON deployment_environments
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS ci_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  provider VARCHAR(16) NOT NULL CHECK (provider IN ('github', 'local')),
  provider_run_id VARCHAR(160),
  workflow_file VARCHAR(200) NOT NULL,
  git_commit VARCHAR(160),
  image VARCHAR(500),
  status VARCHAR(16) NOT NULL DEFAULT 'QUEUED' CHECK (
    status IN ('QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED')
  ),
  url VARCHAR(1000),
  error JSONB,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, task_id)
);

CREATE INDEX IF NOT EXISTS ci_runs_project_id_idx ON ci_runs(project_id);
CREATE INDEX IF NOT EXISTS ci_runs_workflow_run_id_idx ON ci_runs(workflow_run_id);
CREATE INDEX IF NOT EXISTS ci_runs_status_idx ON ci_runs(status);

DROP TRIGGER IF EXISTS ci_runs_set_updated_at ON ci_runs;
CREATE TRIGGER ci_runs_set_updated_at
BEFORE UPDATE ON ci_runs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  ci_run_id UUID REFERENCES ci_runs(id) ON DELETE SET NULL,
  version VARCHAR(160) NOT NULL,
  environment VARCHAR(16) NOT NULL CHECK (environment IN ('dev', 'staging', 'production')),
  image VARCHAR(500) NOT NULL,
  git_commit VARCHAR(160) NOT NULL,
  operation VARCHAR(16) NOT NULL DEFAULT 'DEPLOY' CHECK (operation IN ('DEPLOY', 'ROLLBACK')),
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK (
    status IN (
      'PENDING', 'RUNNING', 'SUCCESS', 'FAILED',
      'ROLLING_BACK', 'ROLLED_BACK', 'ROLLBACK_FAILED'
    )
  ),
  endpoint VARCHAR(1000) NOT NULL,
  health_check JSONB NOT NULL DEFAULT '{}'::jsonb,
  rollback_version VARCHAR(160),
  rollback_deployment_id UUID REFERENCES deployments(id) ON DELETE SET NULL,
  rollback_reason TEXT,
  rollback_at TIMESTAMPTZ,
  error JSONB,
  idempotency_key VARCHAR(500) NOT NULL UNIQUE,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deployments_project_id_idx ON deployments(project_id);
CREATE INDEX IF NOT EXISTS deployments_workflow_run_id_idx ON deployments(workflow_run_id);
CREATE INDEX IF NOT EXISTS deployments_environment_idx ON deployments(project_id, environment);
CREATE INDEX IF NOT EXISTS deployments_status_idx ON deployments(status);

DROP TRIGGER IF EXISTS deployments_set_updated_at ON deployments;
CREATE TRIGGER deployments_set_updated_at
BEFORE UPDATE ON deployments
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS deployment_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  level VARCHAR(8) NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deployment_logs_deployment_id_idx
  ON deployment_logs(deployment_id, created_at);
