ALTER TABLE ci_runs
  ADD COLUMN IF NOT EXISTS pull_request INTEGER CHECK (pull_request IS NULL OR pull_request > 0);
