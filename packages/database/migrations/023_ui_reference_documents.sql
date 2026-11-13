-- UI 参照图（intake）：可选挂到需求上，仅作规划/前端的视觉参照。
-- 与 docs/231 视觉修复闭环的「设计稿上传」裁定无关——这里不进 visualEvidence / visualFixLoop。
ALTER TABLE requirement_documents DROP CONSTRAINT IF EXISTS requirement_documents_kind_check;
ALTER TABLE requirement_documents
  ADD CONSTRAINT requirement_documents_kind_check
  CHECK (kind IN ('PRD', 'TECHNICAL', 'UI_REFERENCE'));
