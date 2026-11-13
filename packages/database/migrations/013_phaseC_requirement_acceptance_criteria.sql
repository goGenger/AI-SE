-- Phase C (N3): acceptance criteria as first-class records.
-- 一 AC 一行（编号 / 文本 / 优先级 / 验证方式 / 是否 smoke / FR 编号集）+ 归一化文本哈希（与 PRD 原文比对）。
-- 提取=整体替换（先例 replaceSlicePlan）；任务↔AC 映射走 tasks.input.acKeys（不动 tasks 表结构）。
CREATE TABLE IF NOT EXISTS requirement_acceptance_criteria (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id UUID NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  ac_key VARCHAR(20) NOT NULL CHECK (length(trim(ac_key)) > 0),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  text_hash CHAR(64) NOT NULL CHECK (length(trim(text_hash)) > 0),
  priority VARCHAR(10) CHECK (priority IS NULL OR priority IN ('Must', 'Should')),
  verification VARCHAR(160),
  smoke BOOLEAN NOT NULL DEFAULT false,
  fr_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- parsed：PRD 已带编号的确定性解析；llm：无编号 PRD 的 LLM 提取（关口 1 人工确认）。
  source VARCHAR(10) NOT NULL DEFAULT 'parsed' CHECK (source IN ('parsed', 'llm')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (requirement_id, ac_key)
);

CREATE INDEX IF NOT EXISTS requirement_acceptance_criteria_requirement_id_idx
  ON requirement_acceptance_criteria(requirement_id);

DROP TRIGGER IF EXISTS requirement_acceptance_criteria_set_updated_at
  ON requirement_acceptance_criteria;
CREATE TRIGGER requirement_acceptance_criteria_set_updated_at
BEFORE UPDATE ON requirement_acceptance_criteria
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
