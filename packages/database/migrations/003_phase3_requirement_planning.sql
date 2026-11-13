CREATE TABLE IF NOT EXISTS requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT NOT NULL DEFAULT '',
  raw_content TEXT NOT NULL CHECK (length(trim(raw_content)) > 0),
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN ('DRAFT', 'ANALYZING', 'ANALYZED', 'FAILED')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS requirements_project_id_idx ON requirements(project_id);
CREATE INDEX IF NOT EXISTS requirements_status_idx ON requirements(status);
CREATE INDEX IF NOT EXISTS requirements_created_at_idx ON requirements(created_at);

DROP TRIGGER IF EXISTS requirements_set_updated_at ON requirements;
CREATE TRIGGER requirements_set_updated_at
BEFORE UPDATE ON requirements
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS specifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id UUID NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  type VARCHAR(40) NOT NULL CHECK (
    type IN (
      'REQUIREMENT_ANALYSIS',
      'FUNCTIONAL',
      'TECHNICAL',
      'ARCHITECTURE',
      'API',
      'DATABASE',
      'UI'
    )
  ),
  version INTEGER NOT NULL CHECK (version > 0),
  status VARCHAR(32) NOT NULL DEFAULT 'GENERATED' CHECK (
    status IN ('DRAFT', 'GENERATED', 'VALIDATED', 'FAILED')
  ),
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (requirement_id, type, version)
);

CREATE INDEX IF NOT EXISTS specifications_project_id_idx ON specifications(project_id);
CREATE INDEX IF NOT EXISTS specifications_requirement_id_idx ON specifications(requirement_id);
CREATE INDEX IF NOT EXISTS specifications_type_idx ON specifications(type);

DROP TRIGGER IF EXISTS specifications_set_updated_at ON specifications;
CREATE TRIGGER specifications_set_updated_at
BEFORE UPDATE ON specifications
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id UUID REFERENCES requirements(id) ON DELETE CASCADE,
  workflow_run_id UUID,
  task_key VARCHAR(80) NOT NULL,
  title VARCHAR(180) NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT NOT NULL DEFAULT '',
  type VARCHAR(32) NOT NULL CHECK (
    type IN (
      'ANALYSIS',
      'DESIGN',
      'DATABASE',
      'BACKEND',
      'FRONTEND',
      'TEST',
      'REVIEW',
      'DEBUG',
      'BUILD',
      'DEPLOY',
      'MONITOR',
      'INCIDENT'
    )
  ),
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (
    status IN (
      'PENDING',
      'READY',
      'RUNNING',
      'WAITING_APPROVAL',
      'SUCCESS',
      'FAILED',
      'BLOCKED',
      'CANCELLED'
    )
  ),
  priority VARCHAR(16) NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH')),
  assigned_agent VARCHAR(120),
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (requirement_id, version, task_key)
);

CREATE INDEX IF NOT EXISTS tasks_project_id_idx ON tasks(project_id);
CREATE INDEX IF NOT EXISTS tasks_requirement_id_idx ON tasks(requirement_id);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_type_idx ON tasks(type);

DROP TRIGGER IF EXISTS tasks_set_updated_at ON tasks;
CREATE TRIGGER tasks_set_updated_at
BEFORE UPDATE ON tasks
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS task_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_task_id <> target_task_id),
  UNIQUE (source_task_id, target_task_id)
);

CREATE INDEX IF NOT EXISTS task_dependencies_source_task_id_idx
  ON task_dependencies(source_task_id);
CREATE INDEX IF NOT EXISTS task_dependencies_target_task_id_idx
  ON task_dependencies(target_task_id);
