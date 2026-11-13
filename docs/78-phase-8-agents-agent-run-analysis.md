# Phase 8-A — Agents / AgentRun 现状分析（只读）

> 阶段：Phase 8-A（只读分析；**禁止修改任何源码**）
> 依据：`docs/design/*`、`docs/ui-reference/ai-se-home.png`、`docs/60`–`docs/76`、Phase 3-B / 3-C / 4 / 5 / 6 / 7 既有实现
> 全部结论来自当前代码与真实数据实测；无法确定处标记 `Unknown`。
> 日期：2026-09-15

> ⚠️ **文件编号说明**：任务书要求 `docs/77-phase-8-agents-agent-run-analysis.md`，但 **`docs/77` 已被上一阶段实施记录 `docs/77-phase-7-workflows.md`（Phase 7-B）占用**。按任务书自身规则「如果 77 已存在，禁止覆盖，使用下一个连续编号并说明原因」，本次分析写入 **`docs/78-phase-8-agents-agent-run-analysis.md`**，`docs/77` 原样保留。

---

## 1. Route / View

| 路由 | name | 组件 | 行数 |
| --- | --- | --- | --- |
| `/agents` | `agents` | `AgentsView.vue` | **130** |
| `/agent-run` | `agent-run` | `AgentRunView.vue` | **233** |

- **不存在 `/agent-run/:id`**。运行详情通过**查询参数**深链接：`/agent-run?run=<agentRunId>`。
- 两条路由均**无** `meta`、**无** 守卫、**无** 权限、**无** 懒加载（与其余 11 条路由一致，全部静态 import）。
- 侧栏菜单：`{ label: "Agent", to: "/agents" }`、`{ label: "Agent 运行", to: "/agent-run" }`（默认激活态由 Router 驱动，无 query 匹配逻辑）。
- **深链接行为（关键）**：
  - `AgentRunView` 读取深链接**只在 `onMounted`**：`if (typeof route.query.run === "string") void store.loadRun(route.query.run);` —— **没有 `watch(route.query.run)`**。
  - 因此从 `/agents` 或 `/workflows/:id` 跳到 `/agent-run?run=X` 会正常加载（路由不同 → 组件重新挂载）；但在 **`/agent-run?run=A` 内再跳到 `?run=B` 不会刷新详情**（同路由不重挂载）。此为**既有行为**。
- **跨页深链接来源（必须保留）**：
  - `AgentsView`：「Agent 运行」面板每行的 `<RouterLink :to="`/agent-run?run=${run.id}`">打开</RouterLink>`。
  - `WorkflowsView`（Phase 7-B 已迁移）：任务节点「查看 Agent 运行」→ 同一 URL 形态。
- 页面宽度：`AgentsView` 用 `.page`（**1180px**）；`AgentRunView` 用 `.page.agent-run-page`（**1280px**）。

## 2. API

### 2.1 `api/agents.ts`（31 行，3 个导出，**全部在用**）

| 函数 | 请求 | 参数 | 返回 |
| --- | --- | --- | --- |
| `listAgents()` | `GET /api/agents` | — | `AgentDefinitionView[]` |
| `getAgent(name)` | `GET /api/agents/:name` | `encodeURIComponent(name)` | `AgentRegistryDetail` |
| `getAgentMetrics()` | `GET /api/agents/metrics` | — | `AgentEvaluationMetrics` |

### 2.2 `api/agentRuns.ts`（77 行，6 个导出）

| 函数 | 请求 | 使用情况 |
| --- | --- | --- |
| `createAgentRun({ task })` | `POST /api/agent-runs` | ✅ 页面 → store `create` |
| `listAgentRuns()` | `GET /api/agent-runs` | ✅ store `loadRuns` |
| `getAgentRun(id)` | `GET /api/agent-runs/:id` | ✅ store `loadRun` / 轮询；**同时被 `stores/requirements.ts` 使用** |
| `cancelAgentRun(id)` | `POST /api/agent-runs/:id/cancel` | ✅ store `cancelCurrentRun` |
| `listAgentRunEvents(id)` | `GET /api/agent-runs/:id/events` | ❌ **全项目无调用方（死代码）** |
| `openAgentRunStream(id, onSnapshot, onError)` | `EventSource /api/agent-runs/:id/stream`（事件名 `snapshot`） | ✅ store SSE；**同时被 `stores/requirements.ts` 使用** |
| `runCodingAgentDemo({ task })` | `POST /api/agent-runs/coding-demo` | ⚠️ 仅被 store `runDemo` 调用，而 `runDemo` **无任何调用方** → **传递性死代码**（不在页面路径上） |

**错误处理契约（两模块一致，冻结）**：`{success,data}`；`success === false` → `payload.error.message`；网络失败 → `"网络请求失败：无法连接后端服务"`；非 JSON → `"请求失败（HTTP <status>）"`。Store 兜底：agentRuns `"Agent 运行失败"`、agents `"Agent 请求失败"`。

> 未使用的 API **不清理**（任务书禁止 dead-code cleanup），仅记录。

## 3. Store

### 3.1 `stores/agents.ts`（44 行）—— 仅 `AgentsView` 使用

- **state**：`agents: AgentDefinitionView[]`、`current: AgentRegistryDetail | null`、`metrics: AgentEvaluationMetrics | null`、`loading`、`error`
- **actions**：
  - `load()` —— `Promise.all([listAgents(), getAgentMetrics()])`；**若无 current 且有 agents[0] 则自动 `select(agents[0].name)`**（首屏自动选中第一个 Agent）
  - `select(name)` —— `getAgent(name)` → `current`；**同样置 `loading = true`**（与 `load` 共用一个标志位）
- **无 SSE、无轮询、无快照**（纯请求应答）。
- 既有测试 `stores/__tests__/agents.test.ts`（1 例）：`loads registry, metrics, and agent detail` → 冻结契约。

### 3.2 `stores/agentRuns.ts`（182 行）—— 仅 `AgentRunView` 使用

- **state**：`runs: AgentRun[]`、`currentRun: AgentRunDetailView | null`、`loading`、`detailLoading`、`creating`、`cancelling`、`error`
- **actions**：
  - `applySnapshot(snapshot)` —— 回填 `currentRun = { run, toolCalls, events }`，并把 `snapshot.run` **upsert 进 `runs`**；**终态（succeeded/failed/cancelled/timed_out）→ `stopRealtime()`**
  - `loadRuns()` / `loadRun(id)`（后者成功 → `startRealtime(id)`，**无条件**，终态也会先建通道再由快照关闭）
  - `create(task)` —— `POST` → `runs.unshift(run)` → `await loadRun(run.id)`
  - `cancelCurrentRun()` —— 无 `currentRun` 直接返回；成功后**替换 `currentRun.run` 与 `runs` 中同 id 项**
  - `startRealtime(id)`（SSE；`typeof EventSource === "undefined"` → `startPolling`）/ `startPolling(id)`（**2 秒**）/ `stopRealtime()`
  - `runDemo(task)` —— **无调用方（死代码）**
- **模块级实时通道单例**：`let eventSource`、`let poller` → **独立于 Requirements / Workflows 的 SSE 通道**。
- **跨页面共享关系（重点）**：
  - `useAgentRunsStore` → **仅 `AgentRunView`**；`useAgentsStore` → **仅 `AgentsView`**；两者**互不共享**、也**不与 Requirements / Workflows 共享**。
  - **`api/agentRuns.ts` 被两个 store 共享**：`stores/requirements.ts` 自己持有 `currentAgentRun` + 独立 `openAgentRunStream` + 独立 2 秒轮询（`stores/requirements.ts:169/179/196`），由 **`RequirementsView`** 消费（`currentAgentRun.events` 面板）。→ 全项目共 **4 条实时通道**（requirements 计划详情、requirements 的 agent run、workflows、agent runs）。
- 既有测试 `stores/__tests__/agentRuns.test.ts`（3 例）：`loads agent runs`、`creates and selects a run`（断言 `createAgentRun` 入参与 `currentRun.run.id`）、`cancels the current run`（断言 `cancelAgentRun("run-1")` 与 `currentRun.run.status === "cancelling"`、列表项同步）→ 冻结契约。

## 4. ViewModel

### 4.1 `viewmodels/agentRunViewModel.ts`（137 行）

| 导出 | 输出 / 行为 | 跨页使用者 |
| --- | --- | --- |
| `agentStatusLabel(status)` | created 已创建 / running 运行中 / succeeded 已成功 / failed 失败 / cancelling 取消中 / cancelled 已取消 / timed_out 已超时 | AgentsView（运行列表）、AgentRunView |
| `toolStatusLabel(tool)` | `status === "failed"` → **`tool.error?.code ?? "失败"`**（业务错误码原文）；否则 `agentStatusLabel(...)`（`timed_out` 直传） | AgentRunView |
| **`isActiveRun(run)`** | `["created","running","cancelling"].includes(status)` —— **权限/操作红线函数** | AgentRunView（`canCancel`） |
| `eventLabel(event)` | 映射表 **72 条**（Agent 运行时 / 工作流引擎 / 交付 / 规划事件）+ 未命中回退 `event.eventType` | **RequirementsView（6-B）、WorkflowsView（7-B）、AgentRunView** |
| `eventSummary(event)` | `payload.action / toolName / status / errorCode` 以 `" / "` 连接；空 → `"已记录"` | **RequirementsView、AgentRunView** |
| `formatDuration(ms?)` | `<1000` → `"${ms}ms"`；否则 `"${(ms/1000).toFixed(1)}s"`；非 number → `"-"` | AgentRunView |
| `formatDateTime(value?)` | `Intl.DateTimeFormat("zh-CN", {month:"short",day:"2-digit",hour,minute,second})`；空 → `"-"` | **RequirementsView、AgentRunView** |

既有测试 `__tests__/agentRunViewModel.test.ts`（4 例）：状态文案、`isActiveRun`、`eventLabel`/`eventSummary`、`formatDuration` → 冻结。

### 4.2 `viewmodels/agentRegistryViewModel.ts`（61 行）—— 仅 `AgentsView`

| 导出 | 输出 |
| --- | --- |
| `formatRate(value?)` | `undefined` → `"暂无数据"`；否则 `${Math.round(value*100)}%` |
| `metricCards(metrics)` | **6 张卡**：Agent 成功率 / 任务成功率 / 工具成功率 / 测试通过率 / 评审通过率 / 修复成功率 |
| `agentTypeLabel(type)` | PLANNER 规划 / FRONTEND 前端 / BACKEND 后端 / DATABASE 数据库 / QA QA / REVIEWER 评审 / DEVOPS 运维（未命中回退原值） |
| `agentAvailabilityLabel(status)` | `"available"` → `"可用"`；否则原值 |
| `artifactTypeLabel(type)` | CODE_DIFF 代码差异 / TEST_RESULT 测试结果 / REVIEW_RESULT 评审结果 / BUILD_RESULT 构建结果 / DOCUMENTATION 文档 / GENERATED_FILE 生成文件 |
| `capabilityLabel(capability)` | PLAN 规划 / FRONTEND_CODE 前端编码 / BACKEND_CODE 后端编码 / DATABASE_SCHEMA 数据库结构 / TEST 测试 / REVIEW 评审 / BUILD 构建 |

既有测试 `__tests__/agentRegistryViewModel.test.ts`（1 例）：`formatRate(0.875) === "88%"`、`formatRate() === "暂无数据"`、`metricCards({agentSuccessRate:1})` 长度为 6 → 冻结。

### 4.3 状态枚举与 tone

- `AgentRunStatus`(7)：`created / running / succeeded / failed / cancelling / cancelled / timed_out`（与 `agentStatusLabel` 的 7 个分支一致）
- `ToolCallAudit.status`：实测取值 `succeeded / failed / timed_out`（另有 created / running 语义分支）
- **当前不存在任何 AgentRun / ToolCall / Agent 可用性的 tone 映射**（`StatusBadge` 的 tone 仅在 4 / 6-B / 7-B 为 project / requirement / task / workflow 建立）。
- `agentAvailabilityLabel` 的真实数据**全部为 `available`**（7/7）→ 非 available 分支无真实样本。

## 5. UI / 交互（含异常与边界）

### 5.1 AgentsView（`/agents`，130 行）

```
section.page（1180px）
├── header.page-header：eyebrow「阶段 5」+ h1「专业 Agent」     ← 无 actions
├── p.error-banner（store.error）                              ← .error-banner 全项目仍未定义
├── div.metric-grid.agent-metrics：6 × div.metric（span label / strong value，28px）
└── div.agent-registry-layout（minmax(220px,300px) + 1fr，gap 16；≤800 → 1fr）
    ├── aside.panel.agent-list-panel：panel-header「注册表」
    │   ├── p「加载中…」（无 class；条件 `loading && !agents.length`）
    │   ├── p.empty.compact-empty「暂无已注册的 Agent。」
    │   └── button.workflow-list-item[.active]（每 Agent 一行：强=类型文案、span=agent.name）
    │        ← **复用了 Workflows 的 legacy 类名**
    ├── main.agent-detail-column（v-if store.current）
    │   ├── panel：panel-header（eyebrow「Agent 详情」+ h2 = definition.name + span.status = 可用性）
    │   │        + p = description + dl.detail-list.compact-detail-list（能力/工具/路径/模式 → 110px 1fr）
    │   ├── panel：「Agent 运行」+ span.status = runs.length
    │   │        + 空态「暂无运行记录。」+ ul.event-list > li.event-row（强=状态文案、p=taskKey‖taskId、RouterLink「打开」）
    │   └── panel：「产出物」+ span.status = artifacts.length
    │            + 空态「暂无产出物。」+ ul.tool-call-list > li.tool-call-row（强=类型文案、p=name、small=toLocaleString）
    └── div.empty「请选择 Agent。」（v-else）
```

交互：`onMounted → store.load()`（自动选中第一个 Agent）；点击注册表行 → `store.select(name)`；`RouterLink` 深链接 `打开`。**无 confirm**。

### 5.2 AgentRunView（`/agent-run`，233 行）

```
section.page.agent-run-page（1280px）
├── header.page-header：eyebrow「Agent 运行时」+ h1「Agent 运行」+ button.button.primary「创建运行 / 创建中…」（disabled=creating）
└── div.run-layout（360px + 1fr，gap 24；≤900 → 1fr）
    ├── aside.form-panel
    │   ├── h2「新建运行」+ form.stacked-form
    │   │   ├── label > span「任务」+ textarea v-model.trim rows=5 maxlength=2000
    │   │   └── button.button.primary「开始 / 创建中…」（`:disabled="creating || !task.trim()"`）
    │   ├── div.panel-header.run-list-header：h2「运行列表」+ span.status = runs.length
    │   ├── p.state「正在加载 Agent 运行…」（`loading`）
    │   ├── p.state.error「{{ error }}」（`error`，红字）
    │   ├── div.empty.compact-empty「暂无 Agent 运行记录。」（`runs.length === 0`）
    │   └── ul.run-list > li > button.run-list-item[.active]（强=状态文案、span=任务文案、small=创建时间）
    └── div.main-column
        ├── p.state「正在加载运行详情…」（`detailLoading`）
        ├── div.empty「请选择或创建 Agent 运行。」（`!currentRun`）
        └── template v-else
            ├── div.metric-grid.run-metrics：3 × div.metric（状态 / 当前迭代 `${cur} / ${max}` / 重试），strong **22px**
            ├── section.panel.run-summary-panel：panel-header「运行详情」+ button.button.danger「取消 / 取消中…」
            │     （`v-if="canCancel"`、`disabled=cancelling`）+ dl.detail-list.compact-detail-list（任务/开始时间/结束时间/耗时）
            ├── section.panel「工具调用」+ span.status = toolCalls.length
            │     + 空态「暂无工具调用记录。」
            │     + ul.tool-call-list > li.tool-call-row：强=toolName、p=summary‖error.message‖「进行中」、small=第 n 轮
            │       + div.tool-call-meta：span.status[.status-error] = toolStatusLabel(tool) + span = formatDuration(duration)
            ├── section.panel「工作流事件」+ span.status = events.length
            │     + 空态「暂无事件记录。」+ ul.event-list > li.event-row（强=eventLabel、p=eventSummary、span=formatDateTime）
            └── section.panel「最终结果」+ pre.result-block（`run.output?.finalResult || run.error?.message || "等待中"`）
```

交互清单（冻结）：① `onMounted` → `loadRuns()` + `route.query.run` → `loadRun`；② 页头「创建运行」与表单「开始」**调用同一个 `createRun()`** → `store.create(task)`；③ `selectRun(id)` → `store.loadRun(id)`；④ `cancelRun()` → `store.cancelCurrentRun()`（**无 confirm**）；⑤ SSE `snapshot` → `applySnapshot`（含终态停实时）；⑥ 失败降级 2 秒轮询；⑦ `onUnmounted → store.stopRealtime()`；⑧ 提交后**表单不清空**（`task` ref 不重置）。

状态与边界：
- 局部脚本常量：`DEFAULT_TASK = "修复项目中的测试失败问题，并确保所有测试通过。"`（textarea 初始值）；`runTask(input)` → `typeof input.task === "string" ? input.task : "编码任务"`；`summary(value)` → `value.summary` 或 `""`；`elapsedMs(startedAt, finishedAt)` → 未开始 → `undefined`（`formatDuration` 显示 `-`），否则 `max(0, finished - started)`。
- **Loading 四处**：列表「正在加载 Agent 运行…」、详情「正在加载运行详情…」、创建/取消按钮文案、`creating`/`cancelling` disabled。
- **Error 两处**：列表区 `p.state.error`、以及 store.error 会影响该段落；**AgentRunView 没有独立的顶部 error banner**。
- **Empty 四处**：运行列表、详情「请选择或创建 Agent 运行。」、工具调用、事件；Agents 侧另有「请选择 Agent。」「暂无已注册的 Agent。」「暂无运行记录。」「暂无产出物。」。
- **Success**：无 toast、无成功提示（仅按钮文案回落 + 列表/详情刷新）。
- **Confirm**：两页**均无** confirm / alert / window 调用（实测 grep 为 0）。
- 真实数据特征：57 个 run 中 **`isActiveRun` 为真的数量 = 0**（29 succeeded / 23 failed / 4 timed_out / 1 cancelled）→ **「取消」按钮当前无法用真实数据出现**。

### 5.3 响应式（全部为既有行为）

| 断点 | 影响 |
| --- | --- |
| ≤900px | `.metric-grid`（两页的指标卡）→ 单列；`.run-layout`（360px + 1fr）→ 单列；`.tool-call-row` / `.event-row`（`minmax(0,1fr) 180px`）→ 单列；`.tool-call-meta` 左对齐；`.page-header` → 纵向 |
| ≤800px | `.agent-registry-layout` → 单列（**与 900 不同，Agents 专属**） |

`AgentRunView` 页宽 1280（`.agent-run-page`），`AgentsView` 页宽 1180（`.page`）。

## 6. Legacy CSS

### 6.1 实际使用的 legacy 类与共享范围

| 类 | 定义要点 | 仅本页 / 共享 |
| --- | --- | --- |
| `page` | `max-width: 1180px` | 6 个未迁移页面共享 |
| `agent-run-page` | `max-width: 1280px` | **仅 AgentRunView** |
| `page-header` / `eyebrow` | flex 两端 + 小号强调字 | 6 页共享 |
| `panel` / `panel-header` | 白底 1px `#dde5ee` 8px 圆角 / flex 两端 mb 14 | panel 5 页；panel-header 3 页（含 Deployments） |
| `form-panel` / `stacked-form` | 20px 内距 + `align-self: start` / 纵向 14px gap | AgentRun + **Deployments**（stacked-form 还含 MCPApp、MCPServerDetail） |
| `state` / `state.error` | `margin:12px 0` / `color:#b3261e` | 4 页共享 |
| `empty` / `compact-empty` | 白底 8px 圆角 + `padding:28px` 居中 / `padding:18px` | 6 页共享 / **两页共享** |
| `button`（`primary` / `danger`） | 旧按钮体系 | 8 个文件（含已迁移页的历史残留为 0） |
| `status` / `status-error` | **绿底胶囊**（`#e8f6ef` / `#16633d`，radius 999px，padding 4px 10px）/ 红底 | AgentRun、Agents、MCPServerDetail |
| `metric-grid` / `metric` | `repeat(3,minmax(0,1fr))` gap 16 mb 24 / 白卡 18px 内距；`span` 14px `#65758a`，`strong` **28px** | **仅 Agents + AgentRun 两页** |
| `detail-list` + `compact-detail-list` | 白卡；行 `140px 1fr`（compact **110px**，`padding:12px 0`） | **仅两页** |
| `event-list` / `event-row` | 纵向 10px gap / 行 `minmax(0,1fr) 180px`、`border-top #edf1f5`、`padding:12px 0`；`:first-child` 无边框 | **仅两页** |
| `tool-call-list` / `tool-call-row` / `tool-call-meta` | 10px gap / 行 `minmax(0,1fr) 180px`、`padding:14px 0` / 右对齐 meta | list+row **两页**；meta **仅 AgentRun** |
| `result-block` | `bg #f7f9fb`、`max-height:220px`、`overflow:auto`、`white-space:pre-wrap` | **仅 AgentRun** |
| `run-layout` / `run-list` / `run-list-item`(+`.active`) / `run-list-header` / `run-metrics` / `main-column` | 360px+1fr；卡片列表；`.active` = **旧蓝 `#1d6fd3`** 边框 + `inset 3px 0`；`run-metrics strong` **22px**（覆盖 28px） | **仅 AgentRun** |
| `agent-registry-layout` / `agent-list-panel` / `agent-detail-column` / `agent-metrics` | `minmax(220px,300px) + 1fr`（≤800 单列）/ 两列容器 gap 16 / mb 16 | **仅 Agents** |
| `workflow-list-item`(+`.active`) | **来自 Workflows 的 legacy 类**，在 AgentsView 中复用（`.active` = 旧蓝） | 曾两页共享（Workflows 已在 7-B 脱离 → 现**仅 Agents**） |
| `error-banner` | **全项目未定义** | Agents + Deployments |

### 6.2 级联风险（8-B 必须处理）

1. **`.workflow-list-item span { color:#65758a; font-size:13px }`**（`styles.css:310`）会命中 AgentsView 注册表行内的 `<span>{{ agent.name }}</span>` —— 与 7-B 发现的 P1 同源；若继续复用该类名，任何工具类文字色/字号都会被静默改写。
2. **`.run-list-item span`** 额外带 `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`；`.run-list-item small` / `.event-row span` / `.tool-call-row small` 统一 `color:#65758a`。
3. **全局未分层 `a { color:#1d4f91 }`** → AgentsView 的 `<RouterLink>打开</RouterLink>` 当前为旧链接蓝；8-B 需与 AppSidebar / 4 个已迁移页一致的 scoped 处理。
4. **未分层 `button, input, select, textarea { font: inherit }`** → 移除 `.stacked-form` 后 textarea 与按钮字号需显式声明（项目无 Select/Textarea 之外的表单组件问题；Textarea 组件已存在 ✓）。
5. **`.status` 恒为绿色**（计数胶囊也是绿色）→ 迁移到 `Badge`/`StatusBadge` 属**有意视觉变化**（语义化），需在报告中标注。
6. `.metric strong` 28px 与 `.run-metrics .metric strong` 22px 的**页级覆盖**；`.detail-list` 140px 与 `.compact-detail-list` 110px 的变体差异。
7. `.agent-registry-layout` 的折叠断点是 **800px**（≠ 其他页的 900px），不得统一。
8. **两页共享 9 个类**（`metric-grid` / `metric` / `detail-list` / `compact-detail-list` / `event-list` / `event-row` / `tool-call-list` / `tool-call-row` / `compact-empty`）→ 8-B 迁移任一页时，**新 markup 不得复用这些类名**（否则 legacy 全局规则继续穿透），且不得删除 `styles.css` 中定义（另一页仍在用）。

## 7. Component Gap（只记录，不实现）

| 需求 | 现有组件 | 结论 |
| --- | --- | --- |
| 两页页头 | ✅ PageHeader（eyebrow/title/actions slot） | 够用（AgentRun 的「创建运行」放 actions） |
| 面板容器 / 标题 | ✅ Card + SectionHeader | 够用（含 `#actions` 放计数徽标/取消按钮） |
| 指标卡（6 张 / 3 张） | ✅ Card + `text-metric` | 够用（**不新增 MetricCard**） |
| 注册表行 / 运行列表行 | ✅ 原生 `<button>` + Tailwind（6-B/7-B 已验证模式） | 够用 |
| 状态展示（运行状态 / 工具状态 / 可用性） | ✅ StatusBadge（需新增 tone 映射纯函数） | **需决策**：`agentStatusTone()`、`toolStatusTone()`、可用性 tone |
| 计数胶囊（`.status` 绿色） | ✅ `Badge variant="secondary"` | 够用（语义化 = 有意视觉变化） |
| 详情 dl（140/110px 两列） | ✅ Tailwind `dl`（6-B 已验证） | 够用 |
| 事件时间线 / 工具调用行 | ✅ Tailwind grid（6-B/7-B 已验证） | 够用 |
| `<pre>` 最终结果 | ✅ `<pre>` + Tailwind（6-B 已验证 pre-wrap/max-height/overflow） | 够用 |
| textarea | ✅ **Textarea**（3-B） | 够用（可替代表单原生 textarea） |
| Select / Checkbox / Tabs / Table / Pagination / Toast / Skeleton / Dialog / Drawer / Form | ❌ 均无 | 本阶段**不需要**；且**本页当前无 confirm、无 toast、无表格、无分页** → 不得新增 |

**结论：不需要新增任何组件**；唯一需要新增代码的是（待裁定的）tone 映射纯函数与页面内 scoped 样式。

## 8. Business Freeze

- **API**：`api/agents.ts` 3 个导出 + `api/agentRuns.ts` 6 个导出（含 2 处死代码保留）、endpoint / 参数 / `encodeURIComponent` / 响应结构、3 条错误文案 + 2 条 store 兜底文案
- **Store**：`stores/agents.ts` 全文（含 `load()` 自动选中第一个 Agent、`select()` 复用 `loading` 标志）；`stores/agentRuns.ts` 全文（含 `applySnapshot` upsert、终态停实时、`create` 的 unshift+loadRun、`cancelCurrentRun` 的双写、2 秒轮询兜底、`runDemo` 保留）
- **既有 store 测试契约**：`agents.test.ts`（1 例）、`agentRuns.test.ts`（3 例）不得破坏
- **Router**：2 条路由、`?run=` 查询深链接、**无 `watch(route.query.run)`**（同路由切换不刷新，属既有行为）
- **深链接契约**：`AgentsView` 的 `/agent-run?run=<id>`「打开」；`WorkflowsView`（7-B）的「查看 Agent 运行」→ 同一形态，不得改路径
- **SSE / polling**：agentRuns 独立通道 + 2 秒轮询 + `onUnmounted → stopRealtime`；**requirements store 自身的 agent run 通道不得改动**
- **AgentRun lifecycle**：`isActiveRun` 三态判定（created/running/cancelling）、终态集合（succeeded/failed/cancelled/timed_out）、`cancelCurrentRun` 行为
- **cancel**：`canCancel = isActiveRun(selectedRun)`；按钮文案「取消 / 取消中…」；`disabled=cancelling`；**无 confirm**
- **ViewModel**：`agentStatusLabel` / `toolStatusLabel`（failed → error.code）/ `eventLabel`（72 条）/ `eventSummary` / `formatDuration` / `formatDateTime` / `formatRate` / `metricCards`（6 张、文案与顺序）/ `agentTypeLabel` / `agentAvailabilityLabel` / `artifactTypeLabel` / `capabilityLabel` —— **跨页共享的 `eventLabel` / `eventSummary` / `formatDateTime` 一律冻结**
- **状态枚举**：`AgentRunStatus`(7)、`ToolCallAudit.status`、`AgentType`(7)、`AgentArtifactType`(6)、capabilities(7)、availability
- **文案**：全部业务中文文案（含 `DEFAULT_TASK`、`"编码任务"`、`"等待中"`、`"进行中"`、`"已记录"`、4 处空态、2 处 loading、按钮两态文案）
- **Loading / Error / Empty**：两页各自的顺序与出现条件（含 Agents「加载中…」无 class、AgentRun 无顶部 error banner）
- **Agent / Task / Event 数据关系**：`AgentDefinitionView → AgentRegistryDetail {definition, runs, artifacts}`；`AgentRunDetailView {run, toolCalls, events}`；事件来自 `WorkflowEvent`（payload.action/toolName/status/errorCode）；`run.input` 实测结构 `{runtime, taskKey, taskType, agentName, agentType, workflowRunId}`（**无 `task` 字段** → `runTask()` 显示占位「编码任务」，属既有行为）
- **交互**：5 项 AgentRun 交互 + 3 项 Agents 交互、`createRun` 双入口、表单不清空、深链接、`store.select`
- **表单约束**：`rows=5`、`maxlength=2000`、`v-model.trim`、提交按钮 `disabled = creating || !task.trim()`、`DEFAULT_TASK` 初始值

## 9. Phase 8-B Migration Mapping（计划，未实施）

### 9.1 AgentsView

| Legacy | New |
| --- | --- |
| `.page` | `max-w-[1180px]`（保留既有页宽） |
| `.page-header` + `.eyebrow` + `<h1>` | `PageHeader eyebrow="阶段 5" title="专业 Agent"`（无 actions） |
| `p.error-banner` | 同分支 + Tailwind 危险色文字（**有意视觉变化**） |
| `div.metric-grid.agent-metrics` + `.metric` ×6 | `grid grid-cols-1 min-[900px]:grid-cols-3 gap-4` + `Card` ×6，值用 `text-metric`（28px，与 legacy 一致） |
| `.agent-registry-layout` | `grid grid-cols-1 min-[800px]:grid-cols-[minmax(220px,300px)_minmax(0,1fr)] gap-4`（**保留 800px 断点**） |
| `.panel.agent-list-panel` + `.panel-header` | `Card` + `SectionHeader title="注册表"` |
| 加载中 `<p>`（无 class） | 同文案 + `text-body text-muted-foreground` |
| `.empty.compact-empty` | `EmptyState size="compact"`（「暂无已注册的 Agent。」） |
| `button.workflow-list-item[.active]` | 原生 `<button>` + **新类名**（`agent-item` / `agent-item--active`，**不得复用 legacy 名**）+ Card 化 Tailwind；激活态改 **Primary** |
| 详情 `panel` ×3 | `Card` + `SectionHeader`（Agent 详情 / Agent 运行 / 产出物） |
| `.status`（可用性、3 处计数） | 可用性 → `StatusBadge tone="success"`；计数 → `Badge variant="secondary"` |
| `dl.detail-list.compact-detail-list` | `dl` + `min-[800px]:grid-cols-[110px_minmax(0,1fr)]` 行 + `divide-y divide-border`（保留字段顺序） |
| `ul.event-list` / `li.event-row` | Tailwind `ul` + 行 `min-[900px]:grid-cols-[minmax(0,1fr)_180px]` |
| `ul.tool-call-list` / `li.tool-call-row` | 同上（产出物行） |
| `RouterLink 打开` | 保留 `<RouterLink>` + 页面 scoped 链接色（对抗全局 `a{color}`） |
| `.empty`（请选择 Agent） | `EmptyState` |

### 9.2 AgentRunView

| Legacy | New |
| --- | --- |
| `.page.agent-run-page` | `max-w-[1280px]`（保留 1280 页宽） |
| `.page-header` + actions | `PageHeader eyebrow="Agent 运行时" title="Agent 运行"` + `Button`（「创建运行 / 创建中…」，`disabled=creating`） |
| `.run-layout` | `grid grid-cols-1 gap-6 min-[900px]:grid-cols-[360px_minmax(0,1fr)]` |
| `.form-panel` + `h2` + `.stacked-form` | `Card` + `SectionHeader title="新建运行"` + `form` grid；textarea → **`Textarea`**（保留 rows=5 / maxlength=2000 / `v-model.trim`）；按钮 → `Button`（`:disabled="creating \|\| !task.trim()"`） |
| `.panel-header.run-list-header` + `.status` | `SectionHeader title="运行列表"` + `#actions` 内 `Badge variant="secondary"`（计数） |
| `p.state` / `p.state.error` | 同文案 + `text-body text-muted-foreground` / `text-danger`（**无 class 变更语义**） |
| `.empty.compact-empty` | `EmptyState size="compact"` |
| `ul.run-list` / `button.run-list-item[.active]` | Tailwind `ul` + 原生 `<button>` + **新类名**（`run-item` / `run-item--active`）；激活态 Primary；任务行保留单行省略（`truncate`） |
| `.main-column` | `grid content-start gap-5`（`min-w-0` 保留） |
| 详情 loading / empty | 同文案 + `EmptyState`（「请选择或创建 Agent 运行。」） |
| `.metric-grid.run-metrics` + `.metric` ×3 | 3 张 `Card`；数值用 `text-metric`（28px，同 6-B 先例；legacy 的 22px 覆盖退役 → **有意视觉变化**） |
| `.panel.run-summary-panel` + `.detail-list.compact-detail-list` | `Card` + `SectionHeader title="运行详情"` + `#actions` 内 `Button variant="destructive"`（取消，`v-if=canCancel`、`disabled=cancelling`）+ `dl` 110px 两列 |
| `.panel` ×3（工具调用/工作流事件/最终结果） | `Card` + `SectionHeader` + `#actions` 计数徽标；工具状态 → `StatusBadge`（待 tone 裁定）；`pre.result-block` → `<pre>` + `bg-muted` / `border-border` / `whitespace-pre-wrap` / `max-h-[220px]` / `overflow-auto` |

**不做**：不新增组件、不新增 confirm/Dialog/Toast、不加虚拟滚动、不改任何 API/Store/Router/文案/表单约束、不引入图表库。

## 10. Risks / Unknowns

**Risks**
1. **「取消」按钮无真实数据**：57 个 run 中 `isActiveRun` 为真者 **0 个**（29 succeeded / 23 failed / 4 timed_out / 1 cancelled）→ 取消路径只能靠**离线/拦截**方式验证（复用 7-B 的「离线 + fetch 记录 + 后端状态复核」手法），不得为了验证真实取消而中断真实运行。
2. **查询参数深链接 + 无 watcher**：`?run=` 只在 `onMounted` 生效；从 `/agents`（或 Workflows）跳入正常，但同路由内换 `?run=` 不刷新 —— 8-B **不得**顺手加 `watch`。
3. **两条并行的 AgentRun 实时通道**：`stores/agentRuns.ts` 与 `stores/requirements.ts` 各自持有 `openAgentRunStream` + 2 秒轮询；8-B 只能动前者所在页面的渲染层，**不得**把 Requirements 的通道改走 agentRuns store。
4. **数据量大**：运行列表 **57 项**全量渲染；最大单 run 为 **151 toolCalls / 356 events**（`38edeb4c`，timed_out），合计 725 toolCalls / 1892 events → 单页可达 ~500 行；7-B 已验证 926 行渲染可行，本阶段**不加**限高/虚拟列表。
5. **`runTask()` 占位文案**：真实 run 的 `input` 无 `task` 字段（为 `taskKey/agentName/...`）→ 列表与详情「任务」显示占位 `"编码任务"`。属既有行为，**不得"顺手修"**。
6. **`toolStatusLabel(failed)` 返回业务错误码**（`tool.error.code`）而非「失败」→ 迁移后文案必须不变。
7. **`.workflow-list-item` 复用**：AgentsView 仍在用 Workflows 的 legacy 类（含 `.active` 旧蓝 + `.workflow-list-item span` 颜色/字号穿透）→ 新 markup 必须改名并走 Primary（同 7-B P1 修复结论）。
8. **全局 `a{color}`**：AgentsView 的「打开」链接需 scoped 处理。
9. **两个断点**：Agents 800px / AgentRun 900px，另有 `.page-header`/`.metric-grid`/`.tool-call-row`/`.event-row`/`.tool-call-meta` 的 900px 行为 —— 迁移后需逐项复现。
10. **页宽差异**：AgentRun 1280 vs Agents 1180 —— 不得统一。
11. **form controls**：textarea 若改用 `Textarea` 组件，需确认 `rows=5` / `maxlength` / `v-model.trim` 与 legacy 视觉一致（3-B 的 Textarea 已有 scoped 字号处理）。
12. **Agents 详情无 loading 指示**：`select()` 期间旧详情保留到新数据到达（`current` 不清空）→ 不得新增 Skeleton/loading 态。
13. **两页共享 9 个 legacy 类**：迁移页面新 markup 不得复用这些类名；`styles.css` 定义不得删除（另一页仍在使用）。

**Unknowns**
1. 是否授权新增 tone 映射纯函数：`agentStatusTone()`（7 状态）、`toolStatusTone()`（含 timed_out → warning?）、以及可用性 → `success`。
2. 计数胶囊（`.status` 绿色）是否统一为 `Badge variant="secondary"`（语义化 → 有意视觉变化）。
3. `.run-metrics` 的 22px 是否统一到设计体系的 `text-metric` 28px（6-B 先例为 22px → 28px）。
4. `.error-banner` 是否在 AgentsView 首次上色（7-B 已有同类先例）。
5. AgentsView「加载中…」无 class 的 `<p>` 是否补齐排版工具类（纯视觉，无行为影响）。
6. `listAgentRunEvents` / `runCodingAgentDemo` / `runDemo` 三处死代码保持不动（任务书禁止清理）。

---

**Code changed: NONE**
**API changed: NONE**
**Store changed: NONE**
**Router changed: NONE**
**CSS changed: NONE**
**Dependencies changed: NONE**

（本阶段只新增本文档 `docs/78-phase-8-agents-agent-run-analysis.md`；`docs/77-phase-7-workflows.md` 等既有文档与全部源码、配置均未改动。）

按阶段纪律**在此停止**，不进入 Phase 8-B。
