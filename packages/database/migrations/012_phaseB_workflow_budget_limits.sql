-- Phase B (T6): workflow-level budget limits — three optional policy columns on workflow_runs.
-- 预算检查在 claim 循环前进行（WorkflowEngine.enforceBudget）；未设置（NULL）= 不限制。
ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS max_cost_usd NUMERIC(14, 6) CHECK (max_cost_usd IS NULL OR max_cost_usd > 0),
  ADD COLUMN IF NOT EXISTS max_tokens BIGINT CHECK (max_tokens IS NULL OR max_tokens > 0),
  ADD COLUMN IF NOT EXISTS max_wall_clock_ms BIGINT CHECK (max_wall_clock_ms IS NULL OR max_wall_clock_ms > 0);
