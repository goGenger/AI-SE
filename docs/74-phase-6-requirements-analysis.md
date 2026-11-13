# Phase 6-A — Requirements 现状分析（只读）

> 阶段：Phase 6-A（Requirements 分析；**禁止修改源码**）
> 依据：`docs/design/*`、`docs/ui-reference/ai-se-home.png`、`docs/60`–`docs/73`
> 结论全部来自对当前代码与真实数据的实测；无法确定处标记 `Unknown`。
> 日期：2026-09-15

---

## 1. 页面 / 路由

| 路由 | name | View | 行数 / 字节 |
| --- | --- | --- | --- |
| `/requirements` | `requirements` | `apps/web/src/views/RequirementsView.vue` | **281 行 / 9824 B（全项目最大页面）** |

- **不存在任何 Requirements 详情路由或子路由**：详情区（指标 + 4 个面板）是**同页右栏内联渲染**，靠 `selectedRequirement` 状态切换，不依赖路由参数。
- 无 `meta`、无守卫、无权限、无懒加载（与其他 12 条路由一致）。
- 该页面**同时使用两个资源域**的 API：项目（用于下拉选择）与需求/规格/任务；以及 **Agent Run 的 SSE 流**（见 §3）。

## 2. API（`apps/web/src/api/requirements.ts`，78 行 —— 冻结）

| 函数 | 调用 | 本页是否使用 |
| --- | --- | --- |
| `listRequirements(projectId)` | `GET /api/projects/:projectId/requirements` | ✅ 需求列表 |
| `createRequirement(projectId, input)` | `POST /api/projects/:projectId/requirements` | ✅ 新建需求 |
| `getRequirement(id)` | `GET /api/requirements/:id` | ✅ 选中详情 |
| `listRequirementSpecifications(id)` | `GET /api/requirements/:id/specifications` | ✅ 规格面板 |
| `listRequirementTasks(id)` | `GET /api/requirements/:id/tasks` | ✅ 任务 DAG 面板 |
| `analyzeRequirement(id, { regenerate })` | `POST /api/requirements/:id/analyze` | ✅ 「分析」按钮 |
| `getTask(id)` | `GET /api/tasks/:id` | ❌ **全项目无使用者**（仅定义） |
| `getTaskDependencies(id)` | `GET /api/tasks/:id/dependencies` | ❌ **全项目无使用者**（仅定义） |

跨模块依赖（**不在本页直接调用，但由 store 内部使用，属冻结范围**）：
- `apps/web/src/api/agentRuns.ts` → `getAgentRun(id)`、`openAgentRunStream(id, …)`（**SSE**）
- `apps/web/src/api/projects.ts` → `listProjects()`（本页经 `useProjectsStore` 使用）

统一响应契约与错误文案（与 `api/projects.ts` 完全同构，**必须原样保留**）：
`{ success, data }`；`success === false` → 抛出 `payload.error.message`；网络失败 → `"网络请求失败：无法连接后端服务"`；响应非 JSON → `"请求失败（HTTP <status>）"`。

## 3. Store / ViewModel

### 3.1 `useRequirementsStore`（`stores/requirements.ts`，210 行 —— 全文冻结）

- **state**：`requirements`、`selectedRequirement`、`specifications`、`taskGraph { tasks, dependencies }`、`currentAgentRun`、`loading`、`detailLoading`、`creating`、`analyzing`、`error`
- **actions**：
  - `loadRequirements(projectId)` — 列表；`loading` + `error`
  - `loadRequirement(id)` — 详情；成功后再 `loadPlanningArtifacts`；**失败时把 `selectedRequirement` / `specifications` / `taskGraph` 全部清空**并写 `error`
  - `loadPlanningArtifacts(id)` — `Promise.all([specifications, tasks])`
  - `createRequirement(projectId, input)` — 前置插入去重 → 再 `loadRequirement(id)`（即创建后自动选中）
  - `analyzeSelectedRequirement(regenerate = false)` — 调分析接口 → 回写 `status` → 若有 `agentRunId` 则 `loadAgentRun` + **`startRealtime`**
  - `applyAgentRunSnapshot(snapshot)` — SSE/轮询回填；**终态（succeeded/failed/cancelled/timed_out）→ `stopRealtime()` + 重新 `loadRequirement`**
  - `loadAgentRun` / `startRealtime` / `startPolling` / `stopRealtime`
- **模块级实时通道单例（重要）**：`eventSource`（EventSource）+ `poller`（`setInterval` **2 秒**轮询兜底）；`EventSource` 不可用或流报错时降级为轮询。
- 错误兜底文案：`"需求请求失败"`。

### 3.2 ViewModel（两个文件）

`viewmodels/requirementViewModel.ts`（94 行）—— 本页使用全部 8 个导出：
`requirementStatusLabel`（DRAFT 草稿 / ANALYZING 分析中 / ANALYZED 已分析 / FAILED 失败）、`specificationTypeLabel`（7 种）、`taskTypeLabel`（12 种）、`taskStatusLabel`（9 种）、`latestSpecifications`、`latestTasks`、`dependencyLabel`（`A -> B`）、`taskSourceSummary`。

`viewmodels/agentRunViewModel.ts` —— 本页额外使用 3 个导出：`eventLabel`、`eventSummary`、`formatDateTime`（`"-"` 兜底 + `zh-CN` 月/日/时分格式）。

其他页面对同一 viewmodel 的使用：`WorkflowsView` 使用 `taskStatusLabel` / `taskTypeLabel` → **这些函数的输出属于多页共享契约，改动会波及 Workflows**。

**当前不存在任何「业务状态 → StatusBadge tone」映射函数**（`projectStatusTone` 只服务 ProjectStatus）。本页涉及 3 组状态枚举：`RequirementStatus`(4)、`TaskStatus`(9)、`Specification.status`（后端返回 `VALIDATED` 等，页面未直接展示）。

## 4. UI / 交互

### 4.1 结构

```
section.page.requirement-page（max-width: 1320px）
├── header.page-header
│   ├── eyebrow「需求规划」 + h1「需求」
│   └── button.button.primary「分析」/「分析中…」  ← disabled 三条件
└── div.run-layout（360px | 1fr，gap 24）
    ├── aside.form-panel（左栏）
    │   ├── h2「新建需求」 + form.stacked-form（5 项）
    │   ├── div.panel-header.run-list-header：h2「需求列表」 + span.status 计数
    │   ├── loading / error / empty（.empty.compact-empty）/ ul.run-list
    │   └── li > button.run-list-item[.active]（标题 / 状态文案 / formatDateTime）
    └── div.main-column（右栏）
        ├── detailLoading → p.state「正在加载需求详情…」
        ├── !selectedRequirement → div.empty「请选择或创建需求。」
        └── template
            ├── div.metric-grid.run-metrics：3 个 .metric（状态 / 版本 v{n} / 任务数）
            ├── section.panel「需求详情」：.panel-header（h2 + span.status = 需求标题）
            │     + dl.detail-list.compact-detail-list（描述 / 创建时间 / PRD）
            ├── section.panel「规划事件」：.panel-header（h2 + span.status = 事件数）
            │     + 空态「暂无规划事件。」/ ul.event-list > li.event-row（标签+摘要 / 时间）
            ├── section.panel「规格」：.panel-header（h2 + span.status = 规格数）
            │     + 空态「尚未生成规格。」/ .spec-grid > article（类型 + v{version} + pre.result-block JSON）
            └── section.panel「任务 DAG」：.panel-header（h2 + span.status = 「n 条依赖」）
                  + 空态「尚未生成任务。」/ .dag-layout（.dag-grid > article.dag-node + .dependency-list）
```

### 4.2 表单（左栏 `form.stacked-form`，5 项）

| 控件 | 绑定 | 约束 |
| --- | --- | --- |
| `<select>` 项目 | `selectedProjectId` | 首项 `<option value="">选择项目</option>`，其余由 `projects` 渲染 |
| `<input>` 标题 | `title`（`v-model.trim`） | `maxlength="160"` |
| `<input>` 描述 | `description`（`v-model.trim`） | `maxlength="1000"` |
| `<textarea>` PRD | `rawContent`（`v-model.trim`） | `rows="7"`、`maxlength="20000"` |
| `<button type="submit">` 创建 | — | `:disabled="creating \|\| !selectedProjectId \|\| !title.trim() \|\| !rawContent.trim()"`，文案「创建」/「创建中…」 |

⚠️ **注意：本页表单没有 `required` / `type` 等 HTML 校验属性**，校验完全由「创建按钮 disabled 表达式」+ `createRequirement()` 内部的 `if (!selectedProjectId \|\| !title.trim() \|\| !rawContent.trim()) return;` 守卫承担 —— 与 Projects 页（`required` + HTML 校验）**机制不同，必须逐字保留**。

### 4.3 交互清单（全部冻结）

| # | 交互 | 行为 |
| --- | --- | --- |
| 1 | `onMounted` | `projectsStore.fetchProjects()` → 选中 `projects[0].id`（无项目则空串） |
| 2 | `watch(selectedProjectId)` | 变化即 `loadRequirements(projectId)`（空串则不加载） |
| 3 | `<select>` 选择项目 | 改 `selectedProjectId` → 触发 #2 |
| 4 | 提交新建表单 | `createRequirement()`（守卫 → store.createRequirement → 前置插入 + 自动 `loadRequirement`）；**成功后不清空表单**（与 Projects 不同） |
| 5 | 点击需求列表项 | `selectRequirement(id)` → `loadRequirement(id)`（详情 + 规格 + 任务） |
| 6 | 点击「分析」 | `analyzeRequirement()` → `analyzeSelectedRequirement(false)` → 回写状态 +（若有 run）启动 SSE |
| 7 | 实时更新 | SSE `applyAgentRunSnapshot` 刷新 `currentAgentRun`；**终态时停止实时并重新加载该需求** |
| 8 | `onUnmounted` | `requirementsStore.stopRealtime()` |
| 9 | 依赖 disabled 三条件 | 「分析」：`!selectedRequirement \|\| analyzing \|\| selectedRequirement.status === 'ANALYZING'` |

### 4.4 响应式

- `.run-layout`：`360px | minmax(0,1fr)`，`gap: 24px`；**`@media (max-width:900px)` → 单列**
- `.metric-grid`：`repeat(3, minmax(0,1fr))`，`gap 16px`，`margin-bottom 24px`；**≤900px 单列**
- `.event-row`：`grid-template-columns: minmax(0,1fr) 180px`；**≤900px → `grid-template-columns: 1fr`（且 `.page-header` 等同媒体查询内改为纵向堆叠）**
- `.dag-grid`：`repeat(auto-fit, minmax(220px, 1fr))`（自适应，无媒体查询）
- 页面最大宽度：`.requirement-page { max-width: 1320px }` —— **全项目第三种页面宽度**（Projects 1180 / AgentRun 1280 / 本页 1320）

## 5. Loading / Error / Empty / Success

| 状态 | 现状 |
| --- | --- |
| Loading | **4 个独立标志**：`loading`（左栏列表「正在加载需求…」）、`detailLoading`（右栏「正在加载需求详情…」）、`creating`（按钮「创建中…」）、`analyzing`（按钮「分析中…」）。无 Skeleton。 |
| Error | **只有一个展示位**：左栏列表区的 `p.state.error`（`store.error`）。**右栏没有错误展示** —— 详情加载失败时 store 会清空 `selectedRequirement`，右栏因此落到「请选择或创建需求。」空态。⚠️ 这与 Projects 的「error 优先于 empty」**不同**，必须原样保留。 |
| Empty | **共 5 处**：左栏「暂无需求。」（`.empty.compact-empty`）、右栏「请选择或创建需求。」（`.empty`）、「暂无规划事件。」、「尚未生成规格。」、「尚未生成任务。」（均 `.empty.compact-empty`）。 |
| Success | 无 toast / 无成功提示。可见反馈＝按钮文案回落、指标与面板刷新、事件列表实时追加、终态后需求自动重载。 |
| 分支优先级 | 左栏：loading → error → empty → list；右栏：detailLoading → !selectedRequirement → 内容。 |

## 6. Legacy CSS

### 6.1 本页使用的 legacy 类（38 个）

`page`、`requirement-page`、`page-header`、`eyebrow`、`button primary`、`run-layout`、`form-panel`、`stacked-form`、`panel-header`、`run-list-header`、`status`、`state`、`state error`、`empty`、`compact-empty`、`run-list`、`run-list-item`（+ `active`）、`main-column`、`metric-grid`、`run-metrics`、`metric`、`panel`、`detail-list`、`compact-detail-list`、`event-list`、`event-row`、`spec-grid`、`result-block`、`dag-layout`、`dag-grid`、`dag-node`、`dag-node-meta`、`dependency-list`

### 6.2 仍被其他页面使用（**6-B 不得删除任何一个**）

| legacy 类 | 其他使用者 |
| --- | --- |
| `page` / `page-header` / `eyebrow` / `button` / `status` / `state` / `empty` / `panel` | 其余 7 个页面 |
| `run-layout` / `run-list` / `run-list-item` / `run-list-header` / `run-metrics` / `main-column` | **AgentRunView** |
| `form-panel` / `stacked-form` | AgentRun、Deployments、Workflows（`stacked-form` 还被 MCPApp、MCPServerDetail 使用） |
| `metric-grid` / `metric` | AgentRun、Agents（`metric` 还被 Dashboard，但 Dashboard 已脱离） |
| `panel-header` | AgentRun、Agents、Deployments、Workflows |
| `detail-list` / `compact-detail-list` / `event-list` / `event-row` | AgentRun、Agents |
| `result-block` | AgentRun |
| **`requirement-page` / `spec-grid` / `dag-layout` / `dag-grid` / `dag-node` / `dag-node-meta` / `dependency-list`** | **仅本页**（6-B 可让本页脱离，但按纪律**不删 styles.css**） |

### 6.3 与 Design Token 的偏差（6-B 需对齐的点）

| legacy 取值 | Token / 设计 |
| --- | --- |
| `.requirement-page` 1320px | 设计未规定；本页现为最宽页面 |
| `.run-layout` 360px 侧栏 | 保留（同 Projects 的 360px 侧栏语言） |
| `.run-list-item`：白底 + `#dde5ee` 边框 + 8px 圆角 + `padding:12px` + `gap:6px` | Card：`--border` + 12px + `--card-padding`(20px) 或更紧凑的 12–16px |
| `.run-list-item.active`：`border-color:#1d6fd3` + `inset 3px 0 0 #1d6fd3`（**蓝色内阴影**） | 应改为 Primary `#6C5CE7`；建议 `bg-primary-light` 或左侧主色条 |
| `.run-metrics .metric strong`: **22px** | 设计 §4「Metric Number 24-28px/600」→ 本页指标数字偏小 |
| `.metric`：`padding:18px`、`gap:8px`；label `#65758a` 14px | `--card-padding` 20px / `text-body` / `text-muted-foreground` |
| `.status`：固定绿胶囊（`#e8f6ef`/`#16633d`），本页用作**计数/文本标记**（需求数、事件数、规格数、依赖数、需求标题） | 设计 §11 的 StatusBadge 针对状态；计数与标题本非状态 → 建议改用 `Badge variant="secondary"`（3-B），避免把非状态语义塞进 StatusBadge |
| `.detail-list.compact-detail-list`：`grid 110px 1fr`、行内距 `12px 0`、分隔线 `#edf1f5` | 110px + `--border`；列宽与 Projects 详情的 140px 不同（本页更紧凑） |
| `.result-block`：`#f7f9fb` 底 + `#dde5ee` 边框 + 8px 圆角 + `max-height:220px` + `overflow:auto` + `white-space:pre-wrap` | `--muted` 底 + `--border` + 12px；`pre-wrap` 与 `max-height` 需保留 |
| `.event-row`：`grid minmax(0,1fr) 180px`，`padding:12px 0`，首行无上边框 | 保留结构；边框改 `--border` |
| `.dag-node`：`#f9fbfd` 底 + `#dde5ee` 边框 + 8px + `padding:14px` + `min-height:150px` | Card 或 `--muted` 底容器 |
| `.dependency-list p`：`#edf3f8` 胶囊 + `#455468` 文字 | `Badge variant="secondary"` |
| `.button.primary`：蓝 `#1d6fd3` | Primary `#6C5CE7` |

### 6.4 级联风险

1. **全局未分层 `a { color:#1d4f91 }`**：本页 `<RouterLink>` 仅出现在导航外壳，页面内**没有链接**（3 处交互全是 `<button>`：列表项、分析、创建）。→ 风险低于 Projects，但若 6-B 引入任何 `<a>` 需同样处理。
2. **未分层 `.form-panel input/select/textarea`**（`border:#cbd5df` / 8px / `padding:10px 12px`）：本页 `<select>` **完全依赖这条规则**取得外观。6-B 若移除 `.form-panel` 类，**原生 select 会退回 UA 外观**（且项目内没有 Select 组件可替代）。
3. **`button, input, select, textarea { font: inherit }`**：Input / Textarea 组件已在 3-B 用 scoped 规则解决；**`<select>` 没有对应组件**，若需要 `text-body` 字号须显式声明。
4. `@media (max-width:900px)` 中同时有 `.page-header`、`.event-row` 的堆叠规则 → 6-B 让本页脱离这些类后，**必须自行用断点类复现堆叠行为**，否则窄屏会失去纵向布局。

## 7. Component Gap（只记录，不实现）

现有可用：**3-B** Button / Card(+6 子组件) / Badge / Input / Textarea / Label / Separator；**3-C** PageHeader / SectionHeader / StatusBadge / EmptyState。

| 需求 | 现有组件 | 结论 |
| --- | --- | --- |
| 页标题 + 「分析」按钮 | ✅ PageHeader（`#actions` 插槽） | 够用 |
| 4 个面板 + 表单容器 + 列表项 | ✅ Card | 够用 |
| 面板标题 + 右侧计数/标题标记 | ✅ SectionHeader（`#actions`）+ `Badge variant="secondary"` | 够用（计数非状态，用 Badge 而非 StatusBadge） |
| 需求状态 / 任务状态展示 | ⚠️ StatusBadge 存在，但**缺 3 组「业务状态 → tone」映射** | **需决策**：Phase 4 先例把纯展示映射放在**已有 viewmodel** 中（`projectStatusTone`）。本页需要 `requirementStatusTone` 与 `taskStatusTone`（放 `viewmodels/requirementViewModel.ts`）。6-B 是否授权新建这两个纯函数**由阶段指令裁定**；否则只能保留纯文本状态。 |
| 5 处空态 | ✅ EmptyState（`size="compact"` 对应 `.compact-empty`） | 够用 |
| 按钮（分析 / 创建 / 列表项） | ✅ Button（列表项需保留 `<button>` + active 态，建议 Card 化 + 主色激活样式） | 够用 |
| 表单（3 输入 + textarea） | ✅ Label / Input / Textarea | 够用 |
| **项目下拉 `<select>`** | ❌ **无 Select 组件** | 仅记录：6-B **保留原生 `<select>`**，用 Tailwind + Token 显式给外观（不新建组件） |
| 指标（状态 / 版本 / 任务数） | ❌ 无 MetricCard（3-C 明确未建） | 仅记录：复用 Dashboard 的「Card + `text-metric`」写法 |
| 规格 JSON 预览（`<pre>`） | ❌ 无组件 | 仅记录：Tailwind + `<pre>` 保留 `pre-wrap` / `max-height` / `overflow:auto` |
| DAG 节点 / 依赖胶囊 | ❌ 无组件 | 仅记录：Card-ish 容器 + `Badge variant="secondary"` 胶囊 |
| 事件行 | ❌ 无组件 | 仅记录：Tailwind grid 行 |
| Dialog / Table / Pagination / Tabs / Toast / Skeleton / Form | ❌ 均无 | 本页**不需要**（无删除确认、无表格、无分页、无 tab、无 toast、无骨架需求）→ 不实现 |

**结论：不需要新增任何组件即可完成 6-B**；唯二需要「新建代码」的是 §7 表格中的两个 tone 映射纯函数（待裁定）与原生 select 的显式样式（写在页面内）。

## 8. Business Freeze（Phase 6-B 冻结清单）

- **API contract**：8 个 endpoint（含 2 个当前无人使用的 `getTask` / `getTaskDependencies`）、请求体字段、响应结构、3 条错误文案语义
- **Store**：`stores/requirements.ts` 全文（含 SSE 单例 + 2s 轮询兜底 + 终态处理 + 失败清空详情 + 创建后自动 `loadRequirement`）
- **Router**：`/requirements` 单路由；**不得新增详情子路由**
- **权限**：无（不得新增）
- **业务状态**：`RequirementStatus`(4) / `TaskStatus`(9) / `TaskType`(12) / `SpecificationType`(7) 枚举与中文文案
- **业务规则**：创建守卫（`!selectedProjectId \|\| !title.trim() \|\| !rawContent.trim()`）、**创建后不清空表单**、分析 disabled 三条件、`analyzeSelectedRequirement(false)`（不传 regenerate=true）、终态自动重载、`onUnmounted` 停止实时
- **表单校验**：`maxlength` 160 / 1000 / 20000、`rows=7`、**无 `required`**（校验靠 disabled 守卫）
- **错误文案**：`"需求请求失败"` + API 层 3 条
- **Loading / Error / Empty 分支**：4 个 loading 标志、**单一错误展示位（左栏）**、5 处空态文案与其出现条件、分支优先级
- **现有交互**：§4.3 的 9 项
- **导航行为**：菜单进入、无页面内跳转（详情内联）
- **ViewModel 输出**：`requirementViewModel` 8 个函数与 `agentRunViewModel` 3 个函数的**输出字符串**（`WorkflowsView` 共享其中 2 个）

## 9. Phase 6-B Migration Mapping（计划，未执行）

| Legacy | New | 备注 |
| --- | --- | --- |
| `.page.requirement-page` | `max-w-[1320px]`（保留本页原有宽度） | 全项目第 3 种页面宽度，**需裁定**是否统一 |
| `.page-header` + `.eyebrow` | `PageHeader eyebrow="需求规划" title="需求"` + `#actions` 放「分析」Button | disabled 三条件逐字保留 |
| `.run-layout` | `grid grid-cols-1 gap-6 min-[900px]:grid-cols-[360px_minmax(0,1fr)]` | 保留 900px 折叠点 |
| `.form-panel` + `.stacked-form` | `Card` + `SectionHeader title="新建需求"` + `Label`/`Input`/`Textarea`/原生 `<select>`/`Button` | select 需显式 Token 样式 |
| `.run-list-header` + `.status` 计数 | `SectionHeader title="需求列表"` + `#actions` 内 `Badge variant="secondary"` | 计数非状态 |
| `.state` / `.state.error` | Tailwind `<p>`（`text-muted-foreground` / `text-danger`） | 3-C 无 LoadingState/ErrorState |
| `.empty` / `.empty.compact-empty` | `EmptyState`（`size="compact"`） | 5 处文案原样 |
| `.run-list` + `.run-list-item[.active]` | `ul/li` + `Card` 化原生 `<button>`，激活态用 `bg-primary-light` / 主色左边条 | **蓝色 `#1d6fd3` 内阴影 → Primary** |
| `.main-column` | `min-w-0` | |
| `.metric-grid.run-metrics` + `.metric` | `Card` ×3（同 Dashboard 指标写法），数字 `text-metric` | **22px → 28px 的视觉变化需记录** |
| `.panel` + `.panel-header` | `Card` + `SectionHeader`（右侧计数/标题入 `#actions`） | 4 个面板 |
| `.detail-list.compact-detail-list` | `dl` + `divide-y divide-border`，行 `grid-cols-[110px_1fr] px-[var(--card-padding)] py-3` | 110px 列宽保留 |
| 需求状态（3 处：列表项 / 指标 / 详情标记） | `StatusBadge` **或**保留纯文本 | 取决于 tone 映射授权 |
| `.event-list` + `.event-row` | `ul` + 行 `grid min-[900px]:grid-cols-[minmax(0,1fr)_180px]` | 保留 900px 堆叠 |
| `.spec-grid` + `.result-block` | `Card`/article + `<pre>`：`bg-muted` + `--border` + 12px + `max-h-[220px] overflow-auto whitespace-pre-wrap` | JSON 预览行为不变 |
| `.dag-layout` / `.dag-grid` / `.dag-node` / `.dag-node-meta` | Tailwind grid（`auto-fit minmax(220px,1fr)`）+ 节点容器 + flex meta | |
| `.dependency-list` | `Badge variant="secondary"` 胶囊 + `strong` 标题 | |
| `.button.primary` | `<Button>`（Primary `#6C5CE7`） | |

## 10. Risks / Unknowns

**Risks**
1. **SSE + 2s 轮询**：本页是本项目中实时性最强、状态最多的页面。6-B 只允许动渲染层；验证需要一次真实「分析」运行（依赖后端 Agent/LLM，可能较慢）。**不建议**在验证中触发新分析，优先用现有 `ANALYZED` 需求做静态渲染验证。
2. **原生 `<select>` 无组件可替代**：移除 `.form-panel` 后必须显式给 `border/bg/padding/radius/font-size`，否则外观退化。属页面内样式，不新建组件。
3. **单错误展示位**：错误只在左栏出现，右栏显示空态 —— 与 Projects 语义相反，容易被「顺手修正」，**必须保持**。
4. **创建后不清空表单**：与 Projects 行为不同（Projects 会清空），不得统一。
5. **`WorkflowsView` 共享 `taskStatusLabel` / `taskTypeLabel`**：本轮不得改动 viewmodel 输出文案。
6. **`getTask` / `getTaskDependencies` 是死代码**（全项目无使用者）：仅记录，不在 6-B「顺手清理」。
7. **页面宽度三套并存**（1180 / 1280 / 1320）：本页 1320；若统一，需单独裁定。
8. **指标数字 22px → 28px**：属设计对齐的有意变化，需写入记录。
9. **页面体量最大**（281 行、4 面板 + DAG + 规格）：6-B 的改动量与回归面为目前最大，建议单页分两次浏览器验证（静态渲染 + 空态/加载态）。
10. **`<pre>` 中的 JSON 是 `JSON.stringify(content, null, 2)`**：换行与缩进必须保留（`whitespace: pre-wrap`）。

**Unknowns**
1. 是否授权新增 `requirementStatusTone` / `taskStatusTone` 两个纯展示映射（Phase 4 先例允许放在已有 viewmodel）——**若未授权，状态保持纯文本**。
2. 计数/标题标记（`.status`）应使用 `Badge variant="secondary"`（推荐）还是保留绿色胶囊 —— 推荐前者（与设计 §11 的「状态用 StatusBadge、其他用 Badge」语义一致）。
3. 详情列表面板（`.detail-list`）是否需要 `Card` 内的 Header（现为 `h2 需求详情 + 标题标记`）—— 保持现状即可，不新增字段。
4. 是否需要「重新生成分析」（`analyzeSelectedRequirement(true)`）—— 当前 UI **没有**该入口，不得新增。
5. DAG 是否需要图形化（无图库、无坐标数据）—— **默认保持卡片网格**。

---

**Code changed: NONE**
**API/Store/Router changed: NONE**
**CSS changed: NONE**
**Dependencies changed: NONE**

（本阶段只新增本文档 `docs/74-phase-6-requirements-analysis.md`；未触碰任何源码、配置、`styles.css` 或真实数据。）

按阶段纪律**在此停止**，不进入 Phase 6-B。
