-- Phase 8-A (docs/242 / docs/13): Alert ingest + Incident persistence.
--
-- SRE-01/02: fingerprint idempotency for *active* incidents; optional alert_events
-- audit trail. No diagnosis / fix / delivery columns beyond linked_workflow_run_id.

CREATE TABLE IF NOT EXISTS incidents (
  id                      UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id              UUID REFERENCES projects(id) ON DELETE SET NULL,
  status                  TEXT NOT NULL
                            CHECK (status IN ('open', 'diagnosing', 'mitigating', 'resolved', 'cancelled')),
  source                  VARCHAR(120) NOT NULL,
  fingerprint             VARCHAR(300) NOT NULL,
  severity                TEXT NOT NULL
                            CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  title                   VARCHAR(300) NOT NULL,
  summary                 TEXT,
  labels                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  linked_workflow_run_id  UUID REFERENCES workflow_runs(id) ON DELETE SET NULL,
  opened_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active incident per (source, fingerprint). Resolved/cancelled free the key.
CREATE UNIQUE INDEX IF NOT EXISTS incidents_active_fingerprint_uidx
  ON incidents (source, fingerprint)
  WHERE status IN ('open', 'diagnosing', 'mitigating');

CREATE INDEX IF NOT EXISTS incidents_opened_at_idx ON incidents (opened_at DESC);
CREATE INDEX IF NOT EXISTS incidents_project_idx ON incidents (project_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents (status, opened_at DESC);

DROP TRIGGER IF EXISTS incidents_set_updated_at ON incidents;
CREATE TRIGGER incidents_set_updated_at
BEFORE UPDATE ON incidents
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS alert_events (
  id            UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  incident_id   UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  source        VARCHAR(120) NOT NULL,
  fingerprint   VARCHAR(300) NOT NULL,
  severity      TEXT NOT NULL
                  CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  payload       JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alert_events_incident_idx ON alert_events (incident_id, received_at DESC);
CREATE INDEX IF NOT EXISTS alert_events_fingerprint_idx ON alert_events (source, fingerprint, received_at DESC);
