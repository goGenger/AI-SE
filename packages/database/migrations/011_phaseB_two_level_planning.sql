-- Phase B (N2): two-level planning — slice plan, slice-scoped tasks, requirement-level approvals.
-- 1) requirements: allow PLANNING_REVIEW (关口 1 等待人工确认切片计划).
ALTER TABLE requirements
  DROP CONSTRAINT IF EXISTS requirements_status_check;

ALTER TABLE requirements
  ADD CONSTRAINT requirements_status_check CHECK (
    status IN ('DRAFT', 'ANALYZING', 'ANALYZED', 'PLANNING_REVIEW', 'FAILED')
  );

-- 2) requirement_slices: 第一级切片计划的持久化（每需求一份，重做=替换）。
CREATE TABLE IF NOT EXISTS requirement_slices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id UUID NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  -- 该切片第二级产物（specifications/tasks）的规划版本；第一级落盘时为 NULL。
  planning_version INTEGER CHECK (planning_version IS NULL OR planning_version > 0),
  slice_key VARCHAR(40) NOT NULL CHECK (length(trim(slice_key)) > 0),
  title VARCHAR(160) NOT NULL CHECK (length(trim(title)) > 0),
  goal TEXT NOT NULL CHECK (length(trim(goal)) > 0),
  fr_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  depends_on JSONB NOT NULL DEFAULT '[]'::jsonb,
  slice_order INTEGER NOT NULL CHECK (slice_order > 0),
  involves_ui BOOLEAN NOT NULL DEFAULT true,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'PLANNING', 'PLANNED', 'RUNNING', 'DONE', 'FAILED')
  ),
  workflow_run_id UUID REFERENCES workflow_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (requirement_id, slice_key)
);

CREATE INDEX IF NOT EXISTS requirement_slices_requirement_id_idx
  ON requirement_slices(requirement_id);
CREATE INDEX IF NOT EXISTS requirement_slices_status_idx ON requirement_slices(status);
CREATE INDEX IF NOT EXISTS requirement_slices_workflow_run_id_idx
  ON requirement_slices(workflow_run_id);

DROP TRIGGER IF EXISTS requirement_slices_set_updated_at ON requirement_slices;
CREATE TRIGGER requirement_slices_set_updated_at
BEFORE UPDATE ON requirement_slices
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- 3) tasks: slice_key（第二级任务计划按切片归属；旧数据为 NULL）。
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS slice_key VARCHAR(40);

CREATE INDEX IF NOT EXISTS tasks_slice_key_idx ON tasks(requirement_id, slice_key);

-- 4) approvals: 支持需求级（关口 1）审批——workflow_run_id/task_id 可空 + requirement_id。
ALTER TABLE approvals
  ALTER COLUMN workflow_run_id DROP NOT NULL,
  ALTER COLUMN task_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS requirement_id UUID REFERENCES requirements(id) ON DELETE CASCADE;

ALTER TABLE approvals
  DROP CONSTRAINT IF EXISTS approvals_owner_check;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_owner_check CHECK (task_id IS NOT NULL OR requirement_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS approvals_requirement_id_idx ON approvals(requirement_id);
