# 268 · 把规划合同打进需求 / 切片 / 任务规划图

> 状态：**已落地**（2026-11-12 Asia/Shanghai）。本轮把已有的 `planning-intent-contract` 注入 PlanningAgent 的需求 / 切片 / 任务规划图，并用提示词 + 硬校验抬高计划质量。未改 `.env`、沙箱镜像、产品 Playwright 钉版，未删 backend / database agent 实现，也未改 taskflow-vue。

相关前文：[docs/267](./267-planning-test-review-contracts.md)、[docs/252](./252-agent-skills.md)、[docs/235](./235-capability-profile-design.md)、[docs/265](./265-visual-intent-gate.md)。

---

## 1. 为什么要接进规划图

`docs/267` 已经把 `planning-intent-contract` 声明式注入职业任务类型 `ANALYSIS` / `DESIGN`。需求拆分、切片和任务 DAG 却走 `PlanningGraph` 自己的提示词，不经过 `resolveSkills`。合同写了四条规则，主规划路径当时几乎只教模型填对 schema，不会按能力面切、不会强制点明缺失的 UI 基线，也不要求每个计划项都有可独立验证的命名检查。

本轮不发明 `PLAN` / `PLANNER` 任务类型，也不另写一份政策。政策正文仍以 `packages/agent-core/skills/common/planning-intent-contract/SKILL.md` 为唯一来源。

---

## 2. 注入方式

`skillResolver.planningIntentContractBlock()` / `withPlanningIntentContract()` 用 `getSkill("planning-intent-contract")` 读取同一份 SKILL.md，格式与职业任务的 `## Injected skills` / `### planning-intent-contract` 块相同。

规划图在下列阶段追加该块：

- `requirement_analysis`
- `slice_planning`
- `ui_spec`
- `task_planning`

`functional_spec`、`technical_spec`、`architecture`、`api_spec`、`database_spec`、`repair` 不注入。阶段提示词可以说明「这条规则在本阶段怎么落地」（例如 `visualBaselineGaps`、`involvesData=false`），但不重写合同正文。

`PlanningAgent` 的 level1 路径现在也会把 `capabilityProfile` 传给 `runLevel1PlanningGraph`；`PlanningService` 的两级规划与关口 1 重做同样传入当前 profile。

---

## 3. 硬校验与提示词

软硬双保险：提示词引导模型写出正确形状，校验器在修复轮里拒绝错误形状。

| 规则 | 硬校验 | 提示词 |
| --- | --- | --- |
| 只规划当前能力面启用的工作 | 是。`frontend-vue` 等未启用 DATABASE / BACKEND 的 profile：切片不得 `involvesData=true`，也不得省略该字段（省略会打开 `database_spec`）。任务类型继续走既有 `validatePlannableTaskTypes`。二级规划在 profile 未启用数据层时，即使旧切片省略了 `involvesData`，也会跳过 `database_spec`。 | 切片提示词写明当前 profile 与 `involvesData` 约束；任务提示词继续列出 `plannable` 类型。 |
| 缺关键页 / 关键态官方视觉基线必须点明 | 是。UI 工作且 `providedUiReferences` 为空时，计划必须在 `visualBaselineGaps` 里记录缺口（分析、切片计划、UI 规格任一处点明即可）。记录缺口即通过，不因缺基线而拒绝规划。静默当作基线已有会失败。 | `MISSING_VISUAL_BASELINES_CLAUSE` + 合同正文。 |
| 每个切片 / 任务必须有命名检查 | 是。切片走 `validateSlicePlan`（传入 profile 时）；任务走 `validateNamedPlanChecks`，schema 本身已要求任务 `acceptanceCriteria` 至少一条。 | 切片与任务提示词要求写出能证明做完的检查（验收标准或官方门禁）。 |
| 官方 E2E / 视觉审查放在切片末或 CI | 否（保持既有平台规则）。提示词明确不要把全量官方门禁挂到每一个中间实现任务上。既有交付链归属、官方门禁时机规则不减弱。 | 合同第 4 条 + 阶段提示词。 |

`visualBaselineGaps` 是新增的小字段（`page`、可选 `state`、`note`），挂在 `RequirementAnalysis`、`SlicePlan`、`UiSpec` 上。规格以 JSON 落库，因此分析与 UI 规格里的缺口记录会随规格一起保存。切片级 `acceptanceCriteria` 在计划生成时校验；本轮尚未给 `requirement_slices` 加列，所以切片命名检查暂不落库。

硬校验抓的是「完全没有参照图又完全不记缺口」。`ProvidedUiReference` 目前没有页 / 态索引，关键态只覆盖一部分、其余被静默跳过的情况，仍主要靠提示词约束。

---

## 4. 本轮没有做的

- 不按 `specs.generate` 从规划图里拆掉 `architecture` / `api_spec`。单级与两级产品主路径都会跑这些阶段；数据层由 `involvesData` 与 profile 跳过。`frontend-vue` 消费 API 时，`api_spec` 的职责改为规划前端封装（`docs/269`），而不是跳过该阶段。
- 不把切片 `acceptanceCriteria` 或切片计划级 `visualBaselineGaps` 写成数据库列。
- 不新增 skills 管理页、React / backend / database skills、Figma MCP，也不改产品视觉风格。
- 不把 Playwright 钉版、防空烧、官方 E2E 时机再写成一份新 skill。

---

## 5. 相关

- `docs/267-planning-test-review-contracts.md`：三份通用合同及职业任务注入矩阵。
- `docs/252-agent-skills.md`：frontend-vue 实现 / 夹具 / 修复 skill 绑定表。
- `docs/265-visual-intent-gate.md`：官方视觉基线与视觉门禁。
- `docs/269-frontend-vue-api-consume-planning.md`：消费 API 时 `api_spec` 仍运行，规划前端封装。
