CREATE TABLE IF NOT EXISTS agent_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  agent_name VARCHAR(120) NOT NULL,
  type VARCHAR(40) NOT NULL CHECK (
    type IN (
      'CODE_DIFF',
      'TEST_RESULT',
      'REVIEW_RESULT',
      'BUILD_RESULT',
      'DOCUMENTATION',
      'GENERATED_FILE'
    )
  ),
  name VARCHAR(200) NOT NULL,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_artifacts_project_id_idx ON agent_artifacts(project_id);
CREATE INDEX IF NOT EXISTS agent_artifacts_task_id_idx ON agent_artifacts(task_id);
CREATE INDEX IF NOT EXISTS agent_artifacts_agent_run_id_idx ON agent_artifacts(agent_run_id);
CREATE INDEX IF NOT EXISTS agent_artifacts_agent_name_idx ON agent_artifacts(agent_name);
