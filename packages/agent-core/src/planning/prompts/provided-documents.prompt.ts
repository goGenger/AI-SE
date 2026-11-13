/**
 * D1（`docs/229`）：用户提供技术需求文档时的统一约束句。
 *
 * 语义（用户 2026-10-23 口径）：上传的技术文档**一定是已经规划好的**，所以它是权威输入，
 * 不是参考资料。规划仍要做（切片 / 任务分解），但不得与文档矛盾，也不得自行取舍冲突。
 *
 * 拼在阶段提示词里，`providedTechnicalDocs` 本身由 `PlanningGraph.inputForStage` 传入。
 */
export const PROVIDED_TECHNICAL_DOCUMENTS_CLAUSE =
  "Authoritative input: the `providedTechnicalDocs` in the input are documents the user has already " +
  "written and approved. Follow them; do not contradict or silently rewrite what they state. If a " +
  "document conflicts with the PRD, do not pick a side yourself — record it in " +
  "`technicalDocumentConflicts` (requirement analysis) or report it in your result.";

/**
 * UI 参照图（intake）：有图时即官方视觉基线（docs/265 设计意图门禁）。
 * 仍不是像素级规格，不做 OCR，也不把旧的像素差分 visualFixLoop 当作通过条件。
 */
export const PROVIDED_UI_REFERENCES_CLAUSE =
  "Official visual baselines: when `providedUiReferences` is non-empty, those images are the " +
  "authoritative design-intent references for the named pages and states (layout, hierarchy, " +
  "color and typography system, primary controls). Official visual review at slice end compares " +
  "against them. They are not pixel-perfect specs, must not be satisfied by an agent's self-report " +
  "alone, and must not invent product requirements that contradict the PRD.";

/**
 * docs/268：缺关键页 / 关键态官方视觉基线时必须点明缺口。
 * 这是规划合同第 2 条在阶段提示词上的落点，政策正文仍以 planning-intent-contract SKILL.md 为准。
 */
export const MISSING_VISUAL_BASELINES_CLAUSE =
  "Missing official visual baselines: if this work is UI-facing and a key page or key state has " +
  "no official baseline in `providedUiReferences`, record that gap in `visualBaselineGaps` " +
  "(page, optional state, and a short note). Recording the gap is valid and required; do not " +
  "plan as if those baselines already exist, and do not refuse to produce the plan just because " +
  "baselines are missing.";

/**
 * 人工冲突裁决：规划必须服从已落库的决定，不得对已裁决 topic 再自行取舍或重复上报。
 */
export const CONFLICT_RESOLUTIONS_CLAUSE =
  "Human adjudications: when `conflictResolutions` is non-empty, those entries are final decisions " +
  "for the listed topics. Follow each choice — FOLLOW_PRD uses the PRD side, FOLLOW_TRD uses the " +
  "technical document (`documentSays`) side, CUSTOM uses the note. Do not re-list adjudicated " +
  "topics in `technicalDocumentConflicts`. Only report unresolved conflicts that are not already decided.";
