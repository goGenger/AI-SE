# UX-03 后续修复 — 规划冗余与 AgentRun/任务状态一致性

> 来源：UX-03 交付后用户实测反馈的两个问题。只做这两个问题的最小修复，
> 不进入 Agent Runtime / Workflow Engine 重构。

## 问题 1：简单需求的分析生成了不涉及的 API / 架构 / 数据库规格

### 侦察结论（真实数据）

需求「画画」（项目「画个自行车」，随意写的"只用 html 绘制鳄鱼骑自行车动画"）的规划结果里：

- `API` 规格：虚构了 `GET /` 端点（自述 "static host or file system may return this document"）；
- `DATABASE` 规格：虚构了 `static_deliverable` 表；
- `ARCHITECTURE` 规格：为单个 HTML 文件虚构了 9 个组件。

### 根因

1. `PlanningGraph` 无条件执行全部 6 个规格阶段（functional → technical → architecture →
   api → database → ui），每个阶段的输出都用 `packages/shared` 的 zod schema 校验；
2. 这些 schema **强制非空**：`ApiSpecSchema.endpoints.min(1)`、`DatabaseSpecSchema.tables.min(1)`、
   `ArchitectureSpecSchema.components.min(1)/dataFlow.min(1)`、`UiSpecSchema.pages.min(1)`；
3. 提示词只有 "Only include APIs needed…" 这类方向性约束，**没有"不适用→空数组"的合法出口**；
4. 模型为了通过校验，只能虚构端点/表/组件"凑模板"——这不是模型跑偏，是契约不允许它说"没有"。

### 修复

| 层         | 文件                                                             | 变更                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared     | `packages/shared/src/index.ts`                                   | 四类规格顶层集合允许空数组（`endpoints/tables/components/dataFlow/pages` 由 `.min(1)` 改 `.default([])`），元素级校验保持不变（端点仍需合法 path、表仍须有列） |
| agent-core | `planning/prompts/{api,architecture,database,ui}-spec.prompt.ts` | 增加 Applicability 规则：不适用时输出空数组是**正确**答案，禁止为通过校验虚构条目                                                                              |
| web        | `requirementViewModel.ts` + `RequirementsView.vue`               | 空规格（全空数组）显示「不适用：该类别在本需求中没有条目…」，不再平铺空 JSON                                                                                   |

历史数据不重写：已生成的需求（如「画画」）保留原内容，新分析按新契约输出。

## 问题 2：工作流页显示 Agent 失败 → 运行页显示成功；最终结果状态矛盾

### 侦察结论（真实数据：工作流 680488bc，T-004）

- task **T-004** 状态 FAILED、重试 3 次，工作流 FAILED；
- 但 T-004 的 3 次 agent run **全部 succeeded**——代理实际交付了 `index.html`（17,955 字节）；
- run 详情里 task 结果 `outcome: FAILED`、`summary: "Failed to read git status"`；
- 运行页「最终结果」显示 `已成功 + Failed to read git status`，与工作流页的失败互相矛盾。

### 根因链（`packages/agent-core/src/professional/ProfessionalAgent.ts`）

1. **「任一工具调用失败 → 无条件把结果强制改为 FAILED」**：代理在非 git 目录里探了一次
   `git_status`（`Failed to read git status`，来自 `tool-runtime/gitTools.ts` 的真实命令失败），
   该规则把已交付的任务判死；重试 3 次每次重演 → 工作流 FAILED。
   全树检查确认：该策略**没有任何测试钉住**、没有任何文档描述。
2. **结果解析失败时跳过"修复轮"**（`toolAlreadyFailed` 时 skip）→ 代理返回的结构化结果若
   因长文本 JSON（未转义换行等）解析失败，连一次"重新格式化"机会都没有；
3. **摘要被工具错误覆盖**：解析失败的诊断摘要（判定原因）被 `Failed to read git status` 覆盖，
   用户看到的失败原因不是真正的原因；
4. UI 三层信息不呼应：时间线写「frontend-agent 执行 T-004 失败」（暗示 Agent 失败）、
   任务卡不显示失败原因、运行页不解释运行成功与任务失败的差异。

### 修复

| 层              | 文件                                                                               | 变更                                                                                                                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent-core      | `ProfessionalAgent.ts`                                                             | ① 解析失败时修复轮**不再跳过**（解析失败本身就是要修复的问题）；② 工具失败**不再推翻**已解析的 Agent 自报结果——如实记录到 `metadata.failedTools/toolErrorCode/toolErrors`，自报 SUCCESS 时将每次失败追加为 MEDIUM 问题；③ 解析失败时保留 `INVALID_AGENT_RESULT` 诊断摘要，不再被工具错误覆盖 |
| server          | `workflowTaskExecutor.ts`                                                          | 任务输出新增 `errorType`（结构化判定原因，便于排障）                                                                                                                                                                                                                                         |
| server/database | `AgentRunContext.task` 增补 `outcome`/`summary`（`findContext` SQL 读 `t.output`） | run 详情可解释"运行成功但任务失败"                                                                                                                                                                                                                                                           |
| web             | `AgentRunView.vue` + `agentRunViewModel.ts`                                        | 执行摘要新增「任务结果」行（状态 · Agent 结果）；运行成功但任务未通过时给出解释行 + 查看任务；最终结果新增「Agent 结果」徽标与「问题」列表                                                                                                                                                   |
| web             | `WorkflowViewModel`/`WorkflowsView.vue`                                            | TASK_FAILED 事件摘要改为任务为主体（「T-004」执行失败），Agent 移入明细行；失败任务卡直接显示「失败原因：…」                                                                                                                                                                                 |

**语义变更（显式记录，可否决）**：任务判定由「任一工具失败即失败」改为「以 Agent 自报的结构化
结果为准，工具失败如实记录」。理由：真实使用中该规则把已完成交付的任务错杀并引发确定性重试
死循环；工具失败仍完整保留在 tool_calls、运行轨迹与 issues 中，不做静默。

## 测试

| 套件                                                                                                                                                                                                                                                                                                         | 结果     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `packages/shared` planningSchemas（+2 用例：空规格合法；端点/组件元素级校验仍拒绝）                                                                                                                                                                                                                          | 48/48 ✔ |
| `packages/agent-core` ProfessionalAgent（+3 用例：工具失败保留 SUCCESS 并记 MEDIUM 问题；修复轮在工具失败后照常执行并可翻盘；INVALID 诊断摘要不被工具错误覆盖）                                                                                                                                              | 11/11 ✔ |
| `apps/server` workflowApi.e2e（UX-03 用例增强：context.task.outcome/summary 断言；真实 PostgreSQL + 真实工作流）                                                                                                                                                                                             | 7/7 ✔   |
| `apps/web` agentRunView（14，含任务失败/运行成功新用例）· agentRunViewModel（含 taskOutcomeNote/agentOutcomeLabel/issueSeverityLabel）· workflowViewModel（TASK_FAILED 新文案 + 执行 Agent 明细）· workflowsView（失败原因行）· requirementViewModel（specificationIsEmpty）· requirementsView（不适用显示） | 通过 ✔  |

## 验证

### 真实规划验证（问题 1，2026-09-17，真实 DeepSeek）

临时项目「规划验证-可删除」（`aa9fa02a…`）+ 需求「鳄鱼骑自行车动画」（`89d0a0f6…`），
PRD = "只用 HTML 绘制一只鳄鱼骑自行车的动画…不涉及任何后端、接口或数据库"。分析结果：

| 规格                                               | 内容规模                                                       |
| -------------------------------------------------- | -------------------------------------------------------------- |
| API                                                | `endpoints: 0`（不再虚构端点）                                 |
| DATABASE                                           | `tables: 0`（不再虚构表）                                      |
| ARCHITECTURE                                       | `components: 0, dataFlow: 0`                                   |
| FUNCTIONAL / TECHNICAL / REQUIREMENT_ANALYSIS / UI | 4 / 10 / 完整 / 1 页（有意义的内容保留，UI 一页 = 动画页本身） |

浏览器复验需求页：API / 架构 / 数据库三张卡片显示「不适用：该类别在本需求中没有条目
（分析不会为凑模板虚构内容）。」，其余卡片正常展示 JSON。

### 浏览器复验（问题 2，真实历史数据）

- 运行页（run `417f2a68`，workflow `680488bc` 的 T-004，历史数据）：
  「任务结果＝失败 · Agent 结果：失败」+ 解释行「本次运行成功，但任务 T-004 最终未通过：
  Failed to read git status」+ 查看任务；最终结果卡：「Agent 结果：失败」徽标 + 问题（1）列表；
  终态运行不再显示"等待中"。
- 工作流页：任务卡 T-004 显示「失败原因：Failed to read git status」；时间线 TASK_FAILED
  改为任务为主体（「Create single-file HTML shell…」执行失败 + 执行 Agent 明细行）。
- 历史数据不重写：既有 run/task/规格保持原样，仅展示层解释差异。

### 门禁（final11，全仓）

`typecheck=0 / lint=0 / test=1 / build=0`（`test=1` = apps/web 7 个先存 eyebrow 用例）；
补跑 database **43/43** · agent-core **58/58** · mcp **235/235** · browser **38/38** ·
server **90/90**；全仓 **127 文件 / 957 例 / 950 通过 / 7 失败（全部先存）**。

## 边界与已知问题

1. 历史数据不重写：已生成的规格/任务保留原样（含虚构内容）；「画画」需求仍显示旧的虚构规格。
2. 工具失败不再降级任务为失败——工具失败是否影响交付由 Agent 自报 + 问题列表 + 审查任务共同呈现；
   如认为风险不可接受，可回退该策略（单文件改动）。
3. 修复轮仍为单次（沿用既有边界）；模型输出若再次不可解析且修复失败，任务失败原因现在明确显示
   「invalid structured result」。
4. 任务规划层面未改动：静态单文件需求仍会生成 14 个任务（含 BUILD/DEPLOY）——这是任务规划提示词的
   既有行为，属另一个问题域（本次未改）。
5. 验证用临时项目「规划验证-可删除」留在库中供查看，可随时在控制台删除。
