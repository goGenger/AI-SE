# UX-03 — AgentRun Context / Execution Trace / Failure Context

> 阶段门任务：只做 AgentRun 相关体验（列表上下文 / 执行轨迹 / 失败与恢复上下文 / 结果与产出物）。
> 不涉及 Agent Runtime 重构、Workflow Engine 重构、Observability、AI SRE，不新增 Agent/Recovery 能力。

## 背景（侦察结论，以代码为准）

- 列表仅显示 `状态 + 任务文本 + 创建时间`，无 Project / Workflow / Task / Agent 上下文；
- 详情只有「三指标 + 运行详情 dl + 工具调用列表 + 工作流事件列表 + 最终结果文本」，
  没有执行过程视图、没有失败分类、没有恢复链路、没有产出物/Evidence；
- 数据现实：`agent_runs` 无 `workflow_run_id` 列（关联在 `input` JSONB：`workflowRunId /
taskKey / agentName / agentType`，工作流派生运行由 `workflowTaskExecutor` 写入）；
  `tool_calls.agent_run_id`、`agent_artifacts.agent_run_id`、`evidence_records.agent_run_id`
  均为既有外键；`FAILURE_ROUTED` 仅在 `failureRouter` 接线时由引擎发出（当前未接，恢复主信号
  是**诊断任务** `tasks.source_task_id`）。

## 关键决策

| 决策点               | 结论                                                                                                                                                                 | 依据                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 列表上下文           | 服务端 `findMany` LEFT JOIN projects / tasks / workflow_runs(经 `input->>'workflowRunId'`) / requirements 解析名称；`agentName/agentType` 取自 run.input             | 不在前端维护第二套映射                                            |
| 详情上下文链         | 新增 `findContext(id)`（单条富查询）：Project → Workflow（需求名 + 规划版本）→ Task（key/标题/类型/状态/重试）                                                       | 复用既有实体，无新模型                                            |
| 恢复状态             | `recovery` 由 **既有** `FAILURE_ROUTED / FAILURE_HUMAN_REQUIRED / TASK_RETRYING` 事件（窄查询）+ `findTaskBySourceTaskId`（诊断任务）推导；无任何恢复痕迹时返回 null | 不新建 Recovery 模型；failureRouter 未接时以诊断任务为主          |
| 执行轨迹             | 前端纯函数 `buildExecutionTrace`：ToolCallAudit（工具结果、耗时、错误）+ 非 `tool_call_*` 事件合并为**时间升序**节点                                                 | 与 UX-02 时间线（DESC 最新在上）刻意不同：轨迹是"从开始看到结束"  |
| Trace 去重           | `tool_call_started/finished` 事件不单独渲染（由 ToolCall 行代表）                                                                                                    | 避免同一动作双行                                                  |
| 长轨迹               | 默认双头预览（最早 30 + 最近 30），中间「展开中间 N 条」按需加载                                                                                                     | 现有 API 不分页（§15 允许先复用现有数据能力，作为后续优化点记录） |
| 失败分类             | 复用既有错误码（LLM/TOOL/SANDBOX/COMMAND/TEST/TIMEOUT/CANCELLED/UNKNOWN）→ 中文标签 + tone                                                                           | 不新建 Error 模型                                                 |
| Attempt              | `retryCount + 1`（"第 N 次尝试"）；任务级重试 `task.retryCount / policy.maxRetries`                                                                                  | AgentRun 无 maxRetries 字段 —— 不伪造分母                         |
| 产出物               | 详情内联 `artifacts`（既有 `agent_artifacts`），内容折叠展示                                                                                                         | 不重复实现 Artifact 能力                                          |
| Evidence             | 详情内联 `evidence`（既有 `evidence_records`，`findMany({agentRunId})`）；为空时不渲染                                                                               | 无独立 Evidence 页面/路由（13 路由冻结）                          |
| SSE/轮询/取消/深链接 | 协议与语义不变（快照 payload 增补字段，客户端已有读取路径不受影响）                                                                                                  | 不修改 Agent Runtime 协议                                         |

## API 变更（最小扩展）

1. `GET /api/agent-runs` — 列表项在 `AgentRun` 基础上**增量**增加：`projectName`、
   `workflowRunId`、`requirementName`、`planningVersion`、`taskKey`、`taskTitle`、
   `agentName`、`agentType`。
2. `GET /api/agent-runs/:id`（与 SSE 快照同源）— `AgentRunDetailView` 增量增加：
   `context`（上下文链）、`recovery`（恢复状态或 null）、`artifacts`、`evidence`。
   `AgentRunStreamPayload` 类型同步为 `AgentRunDetailView`（线上 payload 本就是完整详情）。

## 变更文件

| 层       | 文件                                                                                                      | 变更                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| shared   | `packages/shared/src/index.ts`                                                                            | 新增 `AgentRunSummary`/`AgentRunContext`/`AgentRunRecoveryView`；`AgentRunDetailView` 扩展；`AgentRunStreamPayload = AgentRunDetailView` |
| database | `agentRunStores.ts`                                                                                       | `findMany` 富查询；新增 `findContext(id)`、`findTaskFailureEvents(workflowRunId, taskId)`（窄查询）                                      |
| database | `workflowRepositories.ts`                                                                                 | 新增 `findTaskBySourceTaskId(sourceTaskId)`                                                                                              |
| database | `evidenceRepository.ts`                                                                                   | `EvidenceRecordQuery.agentRunId` 过滤                                                                                                    |
| server   | `services/agentRunService.ts`                                                                             | `list()` → Summary；`getDetail` 编排 context/recovery/artifacts/evidence；`buildRecovery` 推导                                           |
| server   | `index.ts`                                                                                                | 装配 artifacts / evidence / tasks 上下文读取器                                                                                           |
| web      | `api/agentRuns.ts` · `stores/agentRuns.ts` · `viewmodels/agentRunViewModel.ts` · `views/AgentRunView.vue` | 列表上下文 + ID 复制；执行摘要 / 执行轨迹 / 结果与产出物 / 失败上下文 / 恢复 / Evidence；store 保真合并                                  |
| tests    | web 4 文件 + server e2e + database 3 文件                                                                 | 新增/更新用例（见下）                                                                                                                    |

## 测试

| 套件                                                                                                  | 结果     |
| ----------------------------------------------------------------------------------------------------- | -------- |
| `packages/database` — agentRunStores（新增 UX-03 上下文链用例，真实 PostgreSQL）                      | 3/3 ✔   |
| `packages/database` — evidenceRepository（扩展 agentRunId 过滤用例）                                  | 4/4 ✔   |
| `packages/database` — workflowRepositories（扩展 source_task_id 查询用例）                            | 5/5 ✔   |
| `apps/server` — workflowApi.e2e（新增 UX-03 用例，真实 PostgreSQL + 真实工作流/REPLAN 执行）          | 7/7 ✔   |
| `apps/web` — agentRunView / agentRunViewModel / stores·agentRuns / stores·requirements / uiComponents | 86/86 ✔ |

新增用例覆盖：列表 DTO 上下文与恢复、上下文链（db/e2e/web 三层）、失败事件窄查询、
失败类型映射（TEST/COMMAND/TOOL/TIMEOUT…）、Attempt、轨迹升序与 `tool_call_*` 去重、
长轨迹折叠、失败上下文（类型/摘要/错误/任务/工具锚点/尝试）、恢复（策略/诊断任务/退路徽标）、
结果与产出物、Evidence 条件渲染、store 快照保真。

## 验收对照

| 验收项                                                                              | 结果    | 证据                                                                                                          |
| ----------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| 列表识别 Project / Workflow / Task / Agent                                          | ✅      | 列表行渲染服务端解析名称（e2e 断言四者）                                                                      |
| Status / Attempt / Duration 清晰                                                    | ✅      | 状态徽标 + 「第 N 次尝试」+ 耗时（formatDuration）                                                            |
| ID 降级为辅助信息                                                                   | ✅      | 底部 `ID xxxxxxxx` + 复制按钮（列表与详情）                                                                   |
| 执行轨迹可见过程 / Tool Call / Tool Result / 失败节点 / Retry / Re-plan 与 Recovery | ✅      | `buildExecutionTrace`：工具行（状态/耗时/命令）/ 失败/重试/恢复/结果节点（tone 色点）                         |
| 不展示模型隐藏 Chain-of-Thought                                                     | ✅      | 轨迹只由 ToolCall 审计 + 引擎/运行时事件构成（结构化工程信息），无任何模型推理字段                            |
| 不新建第二套 Trace/Error/Recovery/Evidence/Artifact 模型                            | ✅      | 全部复用既有表与类型；仅新增展示层与窄查询                                                                    |
| 失败上下文：类型/摘要/错误/任务/工具/尝试/恢复                                      | ✅      | 失败卡片 + 恢复卡片（含跳转链接与工具锚点）                                                                   |
| 可跳转关联对象                                                                      | ✅      | 「查看任务」「查看恢复任务」→ `/workflows/:id`；「查看工具调用」→ 页内锚点 `#tool-<toolCallId>`               |
| Result 可读 / Artifact 可追踪 / Evidence 可追踪                                     | ✅      | 结果卡（状态 + 摘要 + 输出）；产出物列表（类型/名称/内容折叠）；Evidence 有则渲染（当前库 0 条 → 空态不渲染） |
| SSE / Polling / Cancel / Deep Link 正常                                             | ✅      | 协议与语义未动；store 单测（快照保真）+ 浏览器实测（见下）                                                    |
| typecheck / lint / test / build                                                     | ✅ PASS | 见「门禁」：`typecheck=0 / lint=0 / build=0`；test 全仓 941/948（7 个先存失败与 UX-03 无关）                  |

## 浏览器验证（真实数据）

环境：vite `:5173`（dev）+ 当前代码 server（tsx watch，pid 67905），库内真实数据
（57 条 AgentRun，工作流 `99975877` 926 事件 / 项目 Mini Todo）。

| #   | 检查项                                                                                                                                                                                                                                    | 结果 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | 列表 57 条真实运行，行内直接可读上下文：`已超时 · Error handling middleware… · Agent：backend-agent · 后端 · 项目：Mini Todo · 工作流：Todo 管理系统 · 任务：T-004 · … · 尝试 第 2 次尝试 · 用时 120.0s · ID f0ea9abd · 复制 ID`          | ✅   |
| 2   | 详情（run `f0ea9abd`）：执行摘要 = 项目 / 工作流 `Todo 管理系统 · v1` / 任务 T-004 / 开始时间 / 耗时 / 第 2 次尝试 · 39 / 50 迭代                                                                                                         | ✅   |
| 3   | 执行轨迹：72 工具 + 20 事件 = 92 节点；默认双头 60 行（最早 30 + 最近 30）；「展开中间 32 条」→ 92 行；行内状态全中文（已成功/失败），工具行含 耗时/迭代/命令/错误码；失败行 `run_unit_test … 错误码 TEST_ERROR`；57 个工具锚点 `#tool-*` | ✅   |
| 4   | 失败上下文（超时运行）：`执行超时（TIMEOUT_ERROR）` / 摘要 `工具 edit_file 执行失败：…` / 错误 `Agent run timed out` / 任务 T-004 + 「查看任务」/ 工具 `edit_file（COMMAND_ERROR）` + 「查看工具调用」/ `第 2 次尝试 · 任务重试 1 / 2`    | ✅   |
| 5   | 恢复卡片（run `d2dd0be5`，T-001 失败后 REPLAN）：徽标 `已创建诊断任务` · `任务级重试 0 / 3` · 诊断任务 `T-001-REPLAN-1 · Retry Project setup…` + 「查看恢复任务」                                                                         | ✅   |
| 6   | 最终结果 + 产出物：14 个 artifact（类型徽标 + 名称 + 「查看内容」折叠），内容不平铺                                                                                                                                                       | ✅   |
| 7   | Evidence：真实库 0 条 → 不渲染卡片（与「只展示已存在数据」一致）；关联路径由 database/server/web 三层测试覆盖                                                                                                                             | ✅   |
| 8   | 浏览器抓到并修复：轨迹行状态曾渲染英文枚举（`succeeded/failed`）→ 改 `toolCallStatusLabel` 中文化后复验通过；`git_diff` 的 JSON 摘要 `{"diff":""}` 由摘要行折叠进「输出」明细                                                             | ✅   |

## 门禁（final10，全仓）

- `typecheck=0 / lint=0 / test=1 / build=0`（`test=1` = apps/web 7 个**先存** eyebrow 用例，非 UX-03 引入；
  UX-03 重写 `agentRunView.test.ts` 后该失败集 8 → 7）。
- 补跑（`pnpm -r` 首败 bail 跳过的包）：database **43/43** · agent-core **55/55** · mcp **235/235** ·
  browser **38/38** · server **90/90**。
- server 首跑唯一失败 `failureRecovery.e2e`（5.7-5，真 Chromium + 真 MCP）单例**重跑 10/10 全过** ——
  已知环境瞬态，非回归；UX-03 未触及恢复路径（grep 证实）。
- 全仓合计：**127 文件 / 948 例 / 941 通过 / 7 失败（全部为先存 eyebrow 用例）**。

## 已知问题 / 边界

1. `FAILURE_ROUTED` 只在 `failureRouter` 接线时由引擎发出（当前 server 未接）——恢复卡片以
   「诊断任务 + 任务级重试」为主信号，策略/失败分类字段在有路由时自动亮起（同一渲染路径，e2e 覆盖）。
2. 长轨迹为客户端双头预览；服务端事件/工具调用暂无分页（现有 API 一次性返回，§15 允许），
   后续优化点为 Trace 专用分页端点。
3. AgentRun 无 maxRetries 字段：列表/详情只显示「第 N 次尝试」（retryCount+1），任务级重试
   才带分母（`task.retryCount / policy.maxRetries`）。
4. Evidence 当前数据库为空（0 条），页面在无记录时不渲染该卡片；关联查询与渲染路径已由
   database/server/web 三层测试覆盖。
5. 「查看任务」跳转到工作流详情页（无独立任务路由，13 路由冻结）；不做跨页锚点滚动。

## 停止

完成验收后停止；未进入 Agent Runtime 重构 / Workflow Engine 重构 / Observability Phase / AI SRE。
