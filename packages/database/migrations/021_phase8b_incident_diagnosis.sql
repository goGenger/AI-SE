-- Phase 8-B (docs/242): attach structured read-only diagnosis to incidents.
-- Diagnosis is JSON matching IncidentDiagnosisSchema; no fix/delivery columns.

ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS diagnosis JSONB,
  ADD COLUMN IF NOT EXISTS diagnosed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS incidents_diagnosed_at_idx
  ON incidents (diagnosed_at DESC NULLS LAST);
