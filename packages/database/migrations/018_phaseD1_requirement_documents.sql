-- Phase D1（文档入口）：需求可以携带以文件形式给过来的 PRD 与技术需求文档。
-- 技术文档绝不拼进 requirements.raw_content——那是 AC/FR 解析器的唯一输入
-- （planningService.ts / PlanningGraph.ts 的 parseAcceptanceCriteriaFromPrd），
-- 拼进去会把文档里的编号与表格误当验收标准。
--
-- 存原件（raw_bytes）而不只存抽取文本：抽取规则将来会改（换解析器、修换行），
-- 只有留原件才能重放。docx 通常几百 KB，PG 无压力。
CREATE TABLE IF NOT EXISTS requirement_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id UUID NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('PRD', 'TECHNICAL')),
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(128) NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  content_text TEXT NOT NULL,
  raw_bytes BYTEA NOT NULL,
  truncated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS requirement_documents_requirement_idx
  ON requirement_documents (requirement_id, created_at);

-- PRD 至多一份（重复上传即替换 raw_content）；技术文档允许多份（架构 / 接口 / 数据模型分开写）。
CREATE UNIQUE INDEX IF NOT EXISTS requirement_documents_prd_unique
  ON requirement_documents (requirement_id) WHERE kind = 'PRD';

-- 文档集合最后一次变化的时间（上传或删除）。「规划是否过期」由它与最近一次规划时间比较得出：
-- 删除文档不会改变其它行的 created_at，只靠 requirement_documents 无法察觉，故落在需求上。
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS documents_changed_at TIMESTAMPTZ;

