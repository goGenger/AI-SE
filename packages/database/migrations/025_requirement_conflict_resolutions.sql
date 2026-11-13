-- Human adjudications for PRD vs technical-document conflicts (D1 follow-up).
-- Identity: (requirement_id, topic, source). Upsert replaces choice/note.
CREATE TABLE IF NOT EXISTS requirement_conflict_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id UUID NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  source TEXT NOT NULL,
  prd_says TEXT NOT NULL,
  document_says TEXT NOT NULL,
  choice VARCHAR(16) NOT NULL CHECK (choice IN ('FOLLOW_PRD', 'FOLLOW_TRD', 'CUSTOM')),
  note TEXT,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT requirement_conflict_resolutions_identity
    UNIQUE (requirement_id, topic, source)
);

CREATE INDEX IF NOT EXISTS requirement_conflict_resolutions_requirement_idx
  ON requirement_conflict_resolutions (requirement_id, resolved_at DESC);

COMMENT ON TABLE requirement_conflict_resolutions IS
  'Human decisions for technicalDocumentConflicts; injected into planning prompts on analyze/planSlice.';
