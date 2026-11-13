-- Phase 8-C (docs/242): controlled remediation audit on incidents.
-- linked_workflow_run_id already exists (8-A); this stores whitelist decision + timestamps.

ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS remediation JSONB,
  ADD COLUMN IF NOT EXISTS remediated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS incidents_remediated_at_idx
  ON incidents (remediated_at DESC NULLS LAST);
