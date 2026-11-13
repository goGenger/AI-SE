-- Phase 5.7-4 Evidence & Verification
-- evidence_records: persisted evidence for key actions (browser + external).
--
-- Design follows docs/17 §5.7-4 and the frozen 5.7-4 contract block in
-- @ai-se/shared (EvidenceRecordSchema):
--   * action/target identity reuses the 5.7-0 actionRef (JSONB) — no second
--     id system; association columns reuse the existing ids
--     (workflow_run_id / task_id / agent_run_id / tool_call_id).
--   * before_snapshot / after_snapshot / result / verification are JSONB
--     documents produced by @ai-se/evidence (already redacted before
--     persistence — credential-shaped content never reaches this table).
--   * large screenshots stay behind screenshot_ref artifact refs
--     (`screenshot://…`, 5.6-3 pipeline) — never inline bytes.

CREATE TABLE IF NOT EXISTS evidence_records (
  id              UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_run_id UUID REFERENCES workflow_runs(id) ON DELETE SET NULL,
  task_id         UUID REFERENCES tasks(id) ON DELETE SET NULL,
  agent_run_id    UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  tool_call_id    VARCHAR(160),
  action_ref      JSONB NOT NULL,
  external_id     VARCHAR(300),
  before_snapshot JSONB NOT NULL,
  after_snapshot  JSONB NOT NULL,
  result          JSONB NOT NULL,
  verification    JSONB NOT NULL,
  screenshot_ref  VARCHAR(1000),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evidence_records_project_idx ON evidence_records (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS evidence_records_workflow_run_idx ON evidence_records (workflow_run_id);
CREATE INDEX IF NOT EXISTS evidence_records_task_idx ON evidence_records (task_id);

DROP TRIGGER IF EXISTS evidence_records_set_updated_at ON evidence_records;
CREATE TRIGGER evidence_records_set_updated_at
BEFORE UPDATE ON evidence_records
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
