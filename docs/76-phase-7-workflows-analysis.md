# Phase 7-A — Workflows 现状分析（只读）

> 阶段：Phase 7-A（Workflows 分析；**禁止修改源码**）
> 依据：`docs/design/*`、`docs/ui-reference/ai-se-home.png`、`docs/60`–`docs/75`、Phase 3-B/3-C/4/5/6 既有实现
> 所有结论来自对当前代码与真实数据的实测；无法确定处标记 `Unknown`。
> 日期：2026-09-15

> ⚠️ **文件编号说明**：任务书要求输出 `docs/75-phase-7-workflows-analysis.md`，但 `docs/75` 已被上一阶段的实施记录 `docs/75-phase-6-requirements.md`（Phase 6-B）占用。**覆盖它会销毁 6-B 的交付物**，因此本次分析写入下一个连续编号 **`docs/76-phase-7-workflows-analysis.md`**，`docs/75` 保持原样。如确需改名为 75，请在下一阶段指令中说明（届时需先迁移 6-B 记录）。

---

## 1. 页面 / Route

| 路由 | name | 组件 |
| --- | --- | --- |
| `/workflows` | `workflows` | `WorkflowsView.vue` |
| `/workflows/:id` | `workflow-detail` | **同一组件** `WorkflowsView.vue` |

- View：`apps/web/src/views/WorkflowsView.vue`，**292 行 / 11004 B**。
- **详情是深链接**：`selectedId = computed(() => typeof route.params.id === "string" ? route.params.id : "")`；`watch(selectedId)` → `loadWorkflow(id)`；创建成功后 `router.push(\`/workflows/${workflow.id}\`)`（**直接跳转到详情 URL**）。
- **无** `meta`、**无** 守卫、**无** 权限、**无** 懒加载（与其他 13 条路由一致）。
- 页面内**存在跨页面深链接**：任务节点上 `<RouterLink :to="\`/agent-run?run=${task.output.agentRunId}\`">查看 Agent 运行</RouterLink>`。
- 页面结构是「左侧栏（创建表单 + 工作流列表）+ 右侧详情（工作流详情 / 审批 / 工作流图 / 事件时间线）」的两栏布局。

## 2. API（`apps/web/src/api/workflows.ts`，89 行 —— 冻结）

| 函数 | 调用 | 页面是否使用 |
| --- | --- | --- |
| `listWorkflows()` | `GET /api/workflows` | ✅ 列表 |
| `createWorkflow(input)` | `POST /api/workflows` | ✅ 创建 |
| `getWorkflow(id)` | `GET /api/workflows/:id` | ✅ 详情（返回 `WorkflowDetailView`，含 tasks/dependencies/approvals/events） |
| `workflowAction(id, action)` | `POST /api/workflows/:id/{start\|pause\|resume\|cancel}` | ✅ 生命周期动作 |
| `decideApproval(id, action, input)` | `POST /api/approvals/:id/{approve\|reject}` | ✅ 审批决策 |
| `openWorkflowStream(id, …)` | `EventSource /api/workflows/:id/stream`（事件名 `snapshot`） | ✅ 实时通道（由 store 调用） |
| `listWorkflowTasks(id)` | `GET /api/workflows/:id/tasks` | ❌ **本页未使用** |
| `listWorkflowEvents(id)` | `GET /api/workflows/:id/events` | ❌ **本页未使用** |
| `getWorkflowGraph(id)` | `GET /api/workflows/:id/graph` | ❌ **本页未使用** |
| `listWorkflowApprovals(id)` | `GET /api/workflows/:id/approvals` | ❌ **本页未使用** |

> 10 个导出中 6 个在用、**4 个仅定义未使用**（任务/事件/图/审批均有独立端点，但页面只消费 `getWorkflow` 的聚合结果）。仅记录，不清理。

**跨模块调用（重要）**：
- `listRequirements(projectId)` 由 **View 直接导入并调用**（`api/requirements.ts`），**不经过 requirements store**；结果只放进页面本地 `ref`（`:25`、`:41`）。→ Workflows 与 Requirements 页面**不共享需求状态**。
- `useProjectsStore().fetchProjects()`（共享 store）。

统一响应契约与错误文案：`{success,data}`；`success===false` → `payload.error.message`；网络失败 → `"网络请求失败：无法连接后端服务"`；非 JSON → `"请求失败（HTTP <status>）"`；store 兜底 `"工作流请求失败"`。

## 3. Store（`apps/web/src/stores/workflows.ts`，158 行 —— 全文冻结）

- **state**：`workflows: WorkflowRun[]`、`current: WorkflowDetailView | null`、`loading`、`creating`、`acting`、`error`
- **actions**：
  - `applySnapshot(snapshot)` — 回填 `current`，并把 `snapshot.workflow` **upsert 进列表**（存在则替换，否则 `unshift`）；**终态（SUCCESS/FAILED/CANCELLED）→ `stopRealtime()`**
  - `loadWorkflows()` / `loadWorkflow(id)`（后者成功且非终态时 `startRealtime(id)`）
  - `create(input)` — `unshift` + `await loadWorkflow(id)` + 返回 workflow（失败返回 `null`）
  - `act(action: "start"|"pause"|"resume"|"cancel")` — 动作成功后 `await loadWorkflow(current.id)`
  - `decide(approvalId, "approve"|"reject")` — 成功后 `await loadWorkflow(current.id)`
  - `startRealtime(id)` / `startPolling(id)`（**2 秒轮询兜底**）/ `stopRealtime()`
- **模块级实时通道单例**：`source: EventSource` + `poller`；`EventSource` 不存在或 `onerror` 时降级为轮询。**这是全项目第 3 个 SSE 通道**（与 agentRuns、requirements 各自独立）。
- 错误兜底：`"工作流请求失败"`。
- **跨页面共享情况**：`useWorkflowsStore` **仅被 `WorkflowsView` 使用**（+ 其自身 store 测试），**不与任何其他页面共享**；共享的是 `useProjectsStore`。
- **已存在的冻结测试**：`apps/web/src/stores/__tests__/workflows.test.ts`（2 例，`vi.mock("../../api/workflows")`）断言 `loadWorkflows` / `create` / `act("start")→workflowAction("workflow-1","start")` / `decide("approval","approve")→decideApproval(...)` → 属**既有契约**，7-B 不得破坏。

## 4. ViewModel

### 4.1 `viewmodels/workflowViewModel.ts`（64 行）—— 7 个导出，**全部被本页使用**

| 函数 | 输出 / 行为 |
| --- | --- |
| `workflowStatusLabel(status)` | PENDING 等待中 / RUNNING 运行中 / PAUSED 已暂停 / WAITING_APPROVAL 等待审批 / SUCCESS 成功 / FAILED 失败 / CANCELLED 已取消 |
| `failureStrategyLabel(strategy)` | FAIL_FAST 快速失败 / RETRY 重试 / CONTINUE 继续 / REPLAN 重规划 / ROLLBACK 回滚部署 |
| `taskDependencies(task, dependencies)` | 返回 `active !== false` 且 `targetTaskId === task.id` 的 `sourceTaskKey[]` |
| `canStart(status)` | `status === "PENDING"` |
| `canPause(status)` | `"RUNNING"` 或 `"WAITING_APPROVAL"` |
| `canResume(status)` | `"PAUSED"` |
| `normalizeWorkspacePath(value)` | trim；空串 → `undefined`（字段整体省略）；`file://` URL → 本地路径（含 `%20` 解码）；不可解析时保留原值 |

### 4.2 跨页共享的 ViewModel（**输出必须冻结**）

| 来源 | 被本页使用的函数 | 其他使用者 |
| --- | --- | --- |
| `viewmodels/requirementViewModel.ts` | **`taskStatusLabel`**（9 种）、**`taskTypeLabel`**（12 种） | **RequirementsView**（同一对函数） |
| `viewmodels/agentRunViewModel.ts` | `eventLabel`（事件时间线标题） | RequirementsView、AgentRunView |

> `taskStatusTone` 已在 Phase 6-B 建立（`requirementViewModel.ts`），**7-B 可直接复用**；`workflowStatusLabel` 对应的 tone 映射**尚不存在**。

涉及状态枚举：`WorkflowStatus`(7)、`TaskStatus`(9)、`TaskType`(12)、`WorkflowFailureStrategy`(5)、`Approval.status`（页面只筛 `PENDING`）。

## 5. UI / 交互（含异常与边界状态）

### 5.1 结构

```
section.page.workflow-page            ← .workflow-page 无 CSS 规则（未定义）
├── header.page-header：eyebrow「阶段 4」+ h1「工作流」      ← 无 actions
├── p.error-banner（v-if workflows.error）                  ← .error-banner 全项目未定义！
└── div.workflow-layout（320px | 1fr，gap 24，≤900 → 1fr）
    ├── aside.workflow-sidebar（grid，gap 20）
    │   ├── form.form-panel.stacked-form「创建工作流」
    │   │   ├── select 项目（required，来自 projects store）
    │   │   ├── select 需求（required，**仅 `status === 'ANALYZED'` 的需求**）
    │   │   ├── input 目标仓库路径（可选，maxlength=1000，placeholder=/absolute/path/to/your/repo）
    │   │   ├── p.state.mcp-note（路径填写提示长文案，纯静态说明）
    │   │   ├── input[type=number] 最大并发（min=1 max=16）
    │   │   ├── input[type=number] 最大重试次数（min=0 max=10）
    │   │   ├── select 失败策略（5 个选项）
    │   │   ├── label.checkbox-row：input[type=checkbox] 需要人工审批
    │   │   └── button.button.primary「创建」/「创建中…」（`:disabled="workflows.creating"`）
    │   └── div.panel.workflow-list-panel：h2「工作流列表」
    │       ├── p「加载中…」（`loading && !workflows.length`）
    │       ├── p.empty「暂无工作流。」（`!workflows.length`）
    │       └── button.workflow-list-item[.active]：状态文案 + `id.slice(0,8) · v{planningVersion}`
    └── main.workflow-detail（v-if workflows.current，grid gap 20）
        ├── section.panel.workflow-summary
        │   ├── panel-header：eyebrow「工作流详情」+ h2＝workflow.id + span.status-pill＝状态文案
        │   ├── div.workflow-actions：开始 / 暂停 / 继续 / 取消（4 个按钮，条件渲染，`:disabled="workflows.acting"`）
        │   └── dl.workflow-metadata：并发 / 重试 / 策略（3 列，上边框 + 12px 间距）
        ├── section.panel.approval-panel（v-if activeApprovals.length）
        │   └── panel-header「审批」+ div.approval-row × n：任务标题 + 原因 + 批准/拒绝
        ├── section.panel「工作流图」
        │   └── div.workflow-graph（auto-fill minmax(210px,1fr)）→ article.workflow-node[data-status]
        │       ├── taskKey + title；small = 类型 · 状态；前置：…；动态任务 · creationReason；执行 Agent：…
        │       └── RouterLink「查看 Agent 运行」→ `/agent-run?run=<agentRunId>`（仅当 `task.output.agentRunId` 为字符串）
        └── section.panel「事件时间线」
            └── ol.event-timeline → li：time(toLocaleTimeString zh-CN) / eventLabel / taskId.slice(0,8) 或「工作流」
    └── div.empty.workflow-empty（v-else）「请选择或创建工作流。」
```

### 5.2 交互清单（全部冻结）

| # | 交互 | 行为 |
| --- | --- | --- |
| 1 | `onMounted` | `Promise.all([projects.fetchProjects(), workflows.loadWorkflows()])`；若 URL 带 id 再 `loadWorkflow(id)` |
| 2 | `watch(projectId)` | 清空 `requirementId` → `requirements = id ? await listRequirements(id) : []` |
| 3 | `watch(selectedId)` | `loadWorkflow(id)`（深链接 / 列表点击 / 创建跳转都会触发） |
| 4 | 提交创建 | 守卫 `if (!projectId \|\| !requirementId) return;` → `normalizeWorkspacePath` + policy `{maxConcurrency, maxRetries, failureStrategy, allowRetry: strategy==='RETRY', allowReplan: strategy==='REPLAN', approvalRequired}` → 成功后 `router.push('/workflows/:id')` |
| 5 | 点击列表项 | `router.push('/workflows/${id}')` |
| 6 | 开始 | `canStart` 时可见 → `act('start')` |
| 7 | 暂停 | `canPause` 时可见 → `act('pause')` |
| 8 | 继续 | `canResume` 时可见 → `act('resume')` |
| 9 | 取消 | 状态**不在** `['SUCCESS','FAILED','CANCELLED']` 时可见 → `act('cancel')`；**没有 confirm 确认** |
| 10 | 批准 / 拒绝 | `decide(approval.id, 'approve' \| 'reject')`；**没有 disabled 绑定**（不受 `acting` 约束） |
| 11 | 查看 Agent 运行 | `RouterLink` → `/agent-run?run=<id>` |
| 12 | `onBeforeUnmount` | `workflows.stopRealtime()` |
| 13 | 实时 | SSE `snapshot` → `applySnapshot`（列表 upsert + 终态停止）；失败降级 2s 轮询 |

### 5.3 状态与边界

- **Loading**：`workflows.loading`（列表内「加载中…」文本，且仅在**列表为空时**显示；详情加载**没有独立 loading 文案**）；`creating`（创建按钮文案）；`acting`（4 个动作按钮 disabled）。
- **Error**：**只有顶部一条** `.error-banner`（`workflows.error`）；**该 class 在全项目 CSS 中未定义**（见 §6）。
- **Empty**：列表「暂无工作流。」、详情「请选择或创建工作流。」、审批面板**整体不渲染**（`v-if activeApprovals.length`，无空态文案）。
- **Success**：无 toast、无成功提示；反馈＝按钮文案回落、列表 upsert、详情面板刷新、事件时间线增长。
- **Confirm**：**本页面没有任何 confirm / dialog**（取消是直接执行）。
- **表单校验**：两个 `<select required>`；数字 `min/max`；路径 `maxlength=1000`；**没有 JS 侧校验，只有 `create()` 的守卫**。

### 5.4 响应式

- `.workflow-layout`：`320px | minmax(0,1fr)`，`gap 24`；**`@media (max-width:900px)` → 单列**。
- `.workflow-metadata`：`repeat(3, minmax(0,1fr))`；**无媒体查询**。
- `.workflow-graph`：`repeat(auto-fill, minmax(210px,1fr))`；**无媒体查询**（自适应）。
- `.event-timeline li`：`100px minmax(0,1fr) 90px`；**无媒体查询**（窄屏会压缩，不折叠）。
- 页面宽度：`.page` → `max-width: 1180px`（`.workflow-page` 未定义、无额外约束）。

## 6. Legacy CSS

### 6.1 本页使用的 legacy 类（30 个）

`page`、`workflow-page`、`page-header`、`eyebrow`、`error-banner`、`workflow-layout`、`workflow-sidebar`、`form-panel`、`stacked-form`、`panel`、`panel-header`、`workflow-list-panel`、`workflow-list-item`(+`active`)、`empty`、`workflow-empty`、`workflow-detail`、`workflow-summary`、`status-pill`、`workflow-actions`、`workflow-metadata`、`approval-panel`、`approval-row`、`workflow-graph`、`workflow-node`(+`[data-status]`)、`event-timeline`、`state`、`mcp-note`、`checkbox-row`、`button primary/danger`

### 6.2 仅 Workflows 使用（7-B 可脱离，但按纪律**不删 styles.css**）

`workflow-layout`、`workflow-sidebar`、`workflow-list-panel`、`workflow-list-item`、`workflow-empty`、`workflow-detail`、`workflow-summary`、`workflow-actions`、`workflow-metadata`、`approval-panel`、`approval-row`、`workflow-graph`、`workflow-node`、`checkbox-row`

### 6.3 仍被其他页面使用（**不得删除**）

| legacy 类 | 其他使用者 |
| --- | --- |
| `page` / `page-header` / `eyebrow` / `panel` / `panel-header` / `empty` / `state` / `button` | 其余 6 个页面 |
| **`form-panel`** / **`stacked-form`** | AgentRun、Deployments（`stacked-form` 还被 MCPApp、MCPServerDetail） |
| **`status-pill`** | **DeploymentsView** |
| **`event-timeline`** | **DeploymentsView** |
| **`error-banner`** | **AgentsView、DeploymentsView**（3 页共用，但**全项目未定义**） |
| `mcp-note` | MCPApp、MCPServerDetail、MCPServers |

### 6.4 关键事实与偏差

1. **`.error-banner` 从未定义**（`grep -c "^\.error-banner" styles.css` = **0**）：本页顶部的错误提示目前**没有任何样式**（UA `<p>`）。属既有实现问题，**本阶段只记录、不修复**。
2. **`.workflow-page` 从未定义**：纯语义类，无样式。
3. **`.checkbox-row` 使用了 `!important`**（`grid-template-columns: auto 1fr !important`）—— 全项目唯一的 `!important` 之一；脱离该类后该 `!important` 自然失效。
4. `.workflow-node[data-status]` 用**属性选择器**着色：默认左边框 `#8293a5`、`RUNNING` → `#1d6fd3`、`SUCCESS` → `#2c8b57`、`FAILED`/`BLOCKED` → `#b3261e`。
5. `.workflow-list-item.active`：`border-color: #1d6fd3` + `inset 3px 0 #1d6fd3`（旧蓝色）。
6. `.status-pill`：`#b8c8d8` 描边 + `#31465c` 文字 + 12px/700 胶囊（**无颜色语义**）。
7. 值域偏差：`.workflow-list-item` 圆角 6px / 边框 `#d8e1ea` / 内距 12px；`.workflow-node` 圆角 6px / 边框 `#ccd7e2` / 左边框 4px / min-height 112px；`.workflow-metadata` 3 列 + `border-top #e2e8ef`；`.event-timeline li` 上边框 `#e4eaf0`。

### 6.5 级联风险

1. **未分层 `.form-panel input/select/textarea` + `button, input, select, textarea { font: inherit }`**：本页表单含 **3 个 `<select>`、3 个 `<input>`（1 × text + 2 × number）、1 个 `<input type=checkbox>`（无 textarea）** —— 移除 `form-panel` 后必须显式给 select / number / checkbox 外观与字号（项目内**没有 Select / Checkbox 组件**）。
2. **全局未分层 `a { color:#1d4f91 }`**：本页唯一的 `<a>` 是「查看 Agent 运行」`<RouterLink>` → 7-B 需要与 AppSidebar / 4 页先例一致的 scoped 链接色处理。
3. `.error-banner` 若改用 Tailwind `text-danger`，会**首次**给该提示上色（有意变化）。

## 7. Component Gap（只记录，不实现）

现有可用：**3-B** Button / Card(+6 子组件) / Badge / Input / Textarea / Label / Separator；**3-C** PageHeader / SectionHeader / StatusBadge / EmptyState；**6-B** 新增的 `taskStatusTone`。

| 需求 | 现有组件 | 结论 |
| --- | --- | --- |
| 页头（无 actions） | ✅ PageHeader | 够用 |
| 创建表单容器 / 列表容器 / 4 个详情面板 | ✅ Card + SectionHeader | 够用 |
| 生命周期按钮（开始/继续 primary、暂停 secondary、取消 destructive） | ✅ Button（4 个变体齐备） | 够用 |
| 工作流状态展示（列表项 + 详情 header） | ⚠️ StatusBadge 存在，但**缺 WorkflowStatus → tone 映射** | **需决策**：按 Phase 4/6-B 先例新增 `workflowStatusTone`（放 `viewmodels/workflowViewModel.ts`）；未授权则保持纯文本 |
| 工作流列表项 | ✅ 原生 `<button>` + Card 化工具类（6-B 已验证的模式） | 够用 |
| 任务节点 | ✅ Card 风格容器 + `StatusBadge`（复用 **`taskStatusTone`**）+ `Badge`（类型） | 够用 |
| 事件时间线 | ❌ 无组件 | 仅记录：Tailwind grid + `<ol>` |
| **原生 `<select>` ×3** | ❌ **无 Select 组件** | 仅记录：保持原生 + scoped 显式样式（6-B 已验证的模式） |
| **原生 checkbox ×1** | ❌ **无 Checkbox 组件** | 仅记录：保持原生 + `accent-color` / scoped 样式 |
| **Dialog / ConfirmDialog** | ❌ 无 | 仅记录：**本页当前没有 confirm，7-B 不得新增** |
| Toast / Skeleton / Table / Pagination / Tabs / Drawer / Form | ❌ 均无 | 本页**不需要**（无成功提示、无表格、无分页、无 tab） |

**结论：不需要新增任何组件即可完成 7-B**；唯一需要新增代码的是（待裁定的）`workflowStatusTone` 与页面内的原生控件显式样式。

## 8. Business Freeze（Phase 7-B 冻结清单）

- **API contract**：10 个导出（含 4 个未使用）、endpoint / 参数 / 响应结构、`getWorkflow` 的聚合返回、3 条错误文案 + store 兜底「工作流请求失败」
- **Store**：`stores/workflows.ts` 全文（含 SSE 单例 + 2s 轮询兜底、`applySnapshot` 的列表 upsert、终态停止实时、`act`/`decide` 后 `loadWorkflow`、`creating`/`acting` 语义）
- **既有 store 测试**：`stores/__tests__/workflows.test.ts` 的 2 例断言（mock 契约）不得破坏
- **Router**：两条路由（同组件）、**深链接 `/workflows/:id`**、创建后跳转、`watch(selectedId)`
- **权限**：无（不得新增）
- **状态枚举**：`WorkflowStatus`(7) / `TaskStatus`(9) / `TaskType`(12) / `WorkflowFailureStrategy`(5) / `Approval.status`
- **ViewModel 文案**：`workflowStatusLabel` / `failureStrategyLabel` / **`taskStatusLabel` / `taskTypeLabel`（跨页共享）** / `eventLabel` 输出逐字保留
- **业务规则**：需求下拉**仅 ANALYZED**；`allowRetry`/`allowReplan` 由策略推导；`normalizeWorkspacePath` 的 `file://` 归一化；`canStart`/`canPause`/`canResume` 与取消按钮的**内联**终态判断
- **表单校验**：2 个 `required` select、number `min/max`、路径 `maxlength=1000`、`v-model.trim` / `v-model.number`
- **Loading / Error / Empty 分支**：`loading && !length` 才显示「加载中…」、单一顶部 error、两处 empty 文案、审批面板 v-if（无空态）、详情**无独立 loading**
- **Confirm 行为**：**无 confirm**（取消直接执行，不得新增对话框）
- **Start / Pause / Resume / Cancel**：可见性条件与 `disabled=acting`
- **SSE / polling**：`startRealtime` / `startPolling(2s)` / `stopRealtime` / `onBeforeUnmount`
- **Agent Run 行为**：`/agent-run?run=<id>` 深链接与 `task.output.agentRunId` 判定
- **导航行为**：列表点击 → 详情；创建成功 → 详情
- **错误文案**：全部逐字保留

## 9. Phase 7-B Migration Mapping（计划，未实施）

| Legacy | New |
| --- | --- |
| `.page.workflow-page` | `max-w-[1180px]`（保留 `.page` 的既有宽度；`.workflow-page` 本就无样式） |
| `.page-header` + `.eyebrow` + `<h1>` | `PageHeader eyebrow="阶段 4" title="工作流"`（无 actions，与现状一致） |
| `.error-banner` | 同分支 + Tailwind 危险色文字（`text-danger`）；**不引入 ErrorState 组件** |
| `.workflow-layout` | `grid grid-cols-1 gap-6 min-[900px]:grid-cols-[320px_minmax(0,1fr)]` |
| `.workflow-sidebar` / `.workflow-detail` | `grid content-start gap-5`（20px，同 legacy） |
| `.form-panel.stacked-form` | `Card` + `SectionHeader title="创建工作流"` + `Label`/`Input`/`Button` + **原生 3 `<select>` / 1 `<input type=number>` ×2 / 1 checkbox**（scoped 显式外观） |
| `.panel.workflow-list-panel` | `Card` + `SectionHeader title="工作流列表"` + 「加载中…」`<p>` + `EmptyState size="compact"` + **原生 `<button>`** 列表项（Card 化，激活态改 **Primary**） |
| `.status-pill` | `StatusBadge` + `workflowStatusTone()`（**待授权**） |
| `.workflow-actions` | `flex flex-wrap gap-2`；开始/继续 `Button default`、暂停 `Button secondary`、取消 `Button destructive`（条件与 disabled 逐字保留） |
| `.workflow-metadata` | 3 列 `dl`：`dt` muted 12px、`dd` 加粗，列内 `border-t border-border pt-2.5`（结构保留，颜色换 Token） |
| `.approval-panel` / `.approval-row` | `Card` + `SectionHeader title="审批"` + 行 `flex items-center justify-between gap-4` + 批准 `default` / 拒绝 `destructive`（**不加 disabled**） |
| `.workflow-graph` / `.workflow-node[data-status]` | Tailwind grid `repeat(auto-fill, minmax(210px,1fr))` + 节点容器（`--border` + 12px 圆角）；**任务状态改 `StatusBadge` + 复用 `taskStatusTone()`**，类型用 `Badge variant="secondary"`；`[data-status]` 左边框着色方案退役 |
| `.event-timeline` | `Card` + `SectionHeader title="事件时间线"` + `<ol>` `grid` 行 `grid-cols-[100px_minmax(0,1fr)_90px]`（`time`/`eventLabel`/`taskId.slice(0,8)`‖「工作流」） |
| `.empty` / `.workflow-empty` | `EmptyState`（「请选择或创建工作流。」无 compact；列表内用 compact） |
| `.button` 各变体 | `Button`（Primary `#6C5CE7`） |
| 「查看 Agent 运行」`<RouterLink>` | 保留 `<RouterLink>` + 页面 scoped 链接色（对抗全局未分层 `a{color}`，同 4 页先例） |

**不做**：不新增组件、不新增 confirm/Dialog、不引入 DAG 图库/SVG/Canvas、不改任何 API/Store/Router/文案/表单约束。

## 10. Risks / Unknowns

**Risks**
1. **SSE + 2 秒轮询（第 3 条实时通道）**：7-B 只动渲染层；验证需注意 SSE 会让详情持续刷新，截图/断言需在稳定窗口内完成。
2. **真实数据量级**：现有 7 条工作流中，PAUSED 那条含 **33 任务 / 73 依赖 / 926 事件** —— 事件时间线会渲染 **926 行**（当前无虚拟滚动）。7-B 不得为此新增依赖或改变数据（仅记录性能与视觉高度影响）。
3. **深链接双通道**：`/workflows/:id` 深链接 + `/agent-run?run=` 跨页链接，都必须保留。
4. **原生控件多**：3 个 `<select>` + 2 个 number + 1 个 checkbox + 1 个 checkbox label —— 无对应组件，需页面内 scoped 显式样式（6-B 已验证该模式）。
5. **`.error-banner` 目前完全无样式**：7-B 首次为其上色属**有意视觉变化**，需写入记录。
6. **取消没有 confirm**：不得因为「看起来危险」就新增 Dialog（属新增交互 + 新组件）。
7. **批准/拒绝没有 disabled**：保持原样，不得加 `:disabled="acting"`（行为变化）。
8. **`taskStatusLabel` / `taskTypeLabel` 与 Requirements 共享**，文案不得改动。
9. **`listRequirements` 在 View 内直连**：不得「顺手」改成走 requirements store（会引入跨页面状态耦合与行为变化）。
10. **`.checkbox-row` 的 `!important`**：脱离该类后自然失效；不得把 `!important` 带到新实现。
11. **审批面板无真实数据**：真实 7 条工作流的 `approvals` 均为 0 → 批准/拒绝路径**无法用真实数据验证**（需在测试或后续阶段覆盖）。
12. **响应式缺口**：`.workflow-metadata`（3 列）与 `.workflow-graph`（≥210px 自适应）**没有媒体查询**，`event-timeline li` 三列在窄屏会压缩 —— 7-B 需明确保持或调整（建议：metadata 在 <900px 改单列，其余保持）。

**Unknowns**
1. 是否授权新增 **`workflowStatusTone`**（Phase 4/6-B 先例：纯展示映射放已有 viewmodel）；若未授权，状态保持纯文本。
2. `status-pill` 与工作流详情 h2 的关系：现状 h2 显示 **workflow.id（UUID 全文）**，是否保留全文展示（不改数据）—— 建议保留。
3. `.workflow-metadata` 是否改为 3 个 Card（设计偏 Card 化）还是保留 dl 结构 —— 建议保留 dl（信息密度更高，且非独立卡片语义）。
4. 事件时间线 926 行是否需要在视觉上限定高度/滚动（属新增交互）—— 默认**不限定**。
5. 工作流列表是否需要在项内显示状态 Badge（现状为纯文本 `<strong>` + 次要行）—— 建议仅将状态替换为 `StatusBadge`，不新增字段。

---

**Code changed: NONE**
**API changed: NONE**
**Store changed: NONE**
**Router changed: NONE**
**CSS changed: NONE**
**Dependencies changed: NONE**

（本阶段只新增本文档 `docs/76-phase-7-workflows-analysis.md`；`docs/75-phase-6-requirements.md` 等既有文档与全部源码、配置均未改动。）

按阶段纪律**在此停止**，不进入 Phase 7-B。
