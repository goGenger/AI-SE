# Phase 8-B — Agents / AgentRun UI 重构（实施记录）

> 阶段：Phase 8-B（`AgentsView.vue` + `AgentRunView.vue` 视觉层重构）
> 前置：Phase 8-A PASS（`docs/78-phase-8-agents-agent-run-analysis.md`）
> 依据：`docs/design/*`、`docs/ui-reference/ai-se-home.png`、Phase 3-B / 3-C / 4 / 5 / 6 / 7 既有实现、8-A §9 Migration Mapping
> 原则：**Visual Redesign, Functional Preservation** —— UI 图只定义视觉语言，现有代码决定业务功能。
> 日期：2026-09-15

---

## 1. 修改文件

| 文件 | 变更 | 行数 |
| --- | --- | --- |
| `apps/web/src/views/AgentsView.vue` | template + 页面 scoped 样式重写；`<script setup>` 业务代码逐行未改（仅新增组件/tone 导入） | 130 → **241** |
| `apps/web/src/views/AgentRunView.vue` | 同上（`DEFAULT_TASK`、`createRun`、`selectRun`、`cancelRun`、`runTask`、`summary`、`elapsedMs`、`onMounted`/`onUnmounted` 逐字保留） | 233 → **343** |
| `apps/web/src/viewmodels/agentRunViewModel.ts` | **仅新增** `AgentRunStatusTone` + `agentStatusTone()` + `toolStatusTone()`（其余 7 个导出与 72 条事件文案零改动） | 137 → **185** |
| `apps/web/src/__tests__/agentRunViewModel.test.ts` | +3 例 tone 断言 | 65 → **95** |

唯一非本阶段文件的 mtime 变动：`apps/web/src/__tests__/workflowViewModel.test.ts`（Phase 7-B 交付物）。原因：一次误指向的 `patch` 调用改动了其换行，随即**已完整回滚**；复核 `75 行` + `prettier --check` 通过（与 7-B 结束时一致），非本阶段内容变更，如实记录。

## 2. 新增文件

| 文件 | 说明 | 行数 |
| --- | --- | --- |
| `apps/web/src/__tests__/agentsView.test.ts` | AgentsView 页面契约测试（7 例） | 183 |
| `apps/web/src/__tests__/agentRunView.test.ts` | AgentRunView 页面契约测试（11 例） | 278 |

测试覆盖（任务书要求逐项对应）：

- **Agents**：页面结构/组件 ✓、6 个 metric（文案/顺序/取值 + `text-metric` ×6）✓、agent selection（列表项 + active 类）✓、status tone（success/warning，另有中性分支）✓、empty/error ✓（含 `text-danger` 与「不得出现 error-banner」）、deep-link URL（`href="/agent-run?run=…"` ×2）✓
- **AgentRun**：创建入口（页头 + 表单同函数）✓、textarea 约束（`rows=5` / `maxlength=2000` / `DEFAULT_TASK` 初值 / label 关联）✓、disabled 条件（idle 可点、creating 时两处按钮 `disabled` 且文案「创建中…」）✓、run selection（列表项 + active）✓、cancel visibility（running/cancelling 可见 + destructive + cancelled 时的 `取消中…` disabled；4 种终态均不渲染）✓、status/tool status tone（含 failed → 业务错误码 `TEST_ASSERT`）✓、empty/loading/error（4 处）✓、final result 三分支 ✓、`?run=` 深链接 ✓
- 未破坏现有 Store / ViewModel 测试 ✓（24 files / 158 tests 全绿）

## 3. API / Store / Router / SSE 是否变化

| 项 | 结论 |
| --- | --- |
| **API** | **未变化**（`api/agents.ts` 3 导出、`api/agentRuns.ts` 6 导出，含 2 处死代码原样保留） |
| **Store** | **未变化**（`stores/agents.ts`、`stores/agentRuns.ts` 零改动；`stores/requirements.ts` 的 `currentAgentRun` 独立通道零改动） |
| **Router** | **未变化**（2 条路由、`onMounted` 读取 `route.query.run` 的行为与「无 watcher」原样保留） |
| **SSE / polling** | **未变化**（agentRuns 独立通道 + 2 秒轮询兜底 + `onUnmounted → stopRealtime` 原样；浏览器实测通道与兜底路径均按原逻辑工作） |
| **表单约束** | **未变化**（rows/maxlength/v-model.trim/disabled 条件） |
| **cancel 行为** | **未变化**（`canCancel = isActiveRun(...)`、`disabled=cancelling`、**无 confirm**） |
| **ViewModel 既有输出** | **未变化**（`agentStatusLabel` / `toolStatusLabel` / `isActiveRun` / `eventLabel` / `eventSummary` / `formatDuration` / `formatDateTime` / `formatRate` / `metricCards` / `agentTypeLabel` / `agentAvailabilityLabel` / `artifactTypeLabel` / `capabilityLabel`） |
| **依赖 / styles.css** | **未变化**（`styles.css` 仍 960 行 / mtime 11:41；`package.json` mtime 12:12） |

**Tone 新增（仅纯展示映射，未改动任何文案或业务判定）**：`agentStatusTone`（created→pending、running→running、succeeded→success、failed→error、cancelling→warning、cancelled→neutral、timed_out→warning）；`toolStatusTone`（running→running、succeeded→success、failed→error、cancelled→neutral、timed_out→warning）；可用性在页面内联映射（available→success，其他→neutral）。

## 4. Legacy class 是否全部退出页面

**是（两页 0 残留，且经两道独立校验）**。

1. **静态检索**：两文件 legacy 类命中数 **0**（`workflow-list-item` / `run-list-item` / `metric(-grid)` / `detail-list` / `compact-detail-list` / `event-list` / `event-row` / `tool-call-list` / `tool-call-row` / `tool-call-meta` / `result-block` / `panel(-header)` / `status` / `state` / `empty` / `compact-empty` / `form-panel` / `stacked-form` / `page(-header)` / `eyebrow` / `main-column` / `run-layout` / `run-metrics` / `run-summary-panel` / `agent-*` 布局类 / `error-banner`）。
2. **运行时规则审计**（浏览器内遍历 `document.styleSheets`，对每条 legacy 选择器执行 `querySelectorAll` 统计命中）：**`leaks: []`、`legacyHits: {}`** —— 不仅未复用类名，**没有任何 legacy CSS 规则命中新 markup**（含 `.metric span` / `.detail-list dt` / `.run-list-item span` / `.workflow-list-item span` / `.status` / `.state` / `.empty` / `.event-row p` / `.tool-call-row p` 等复合选择器）。

新增页面 scoped 类：`agent-item` / `agent-item--active` / `agent-item-type` / `agent-item-name` / `agent-link`（Agents）；`run-item` / `run-item--active` / `run-item-task`（AgentRun）。均在注释中写明「为何不复用 legacy 名」，并断言防回归。

## 5. 浏览器验证结果

环境：`vite preview --port 5173`（真实后端 :3000，真实数据 7 agents / 57 runs）+ 应用加载前注入 console hook / EventSource 捕获 / fetch 日志。

| # | 验证项 | 实测结果 |
| --- | --- | --- |
| 1 | `/agents` 结构 | h1 **24px/600**「专业 Agent」+ eyebrow「阶段 5」；6 张指标卡（真实值 73% / 8% / 82% / 暂无数据 / 暂无数据 / 0%），数值 **28px/600**（`text-metric`）、标签 13px |
| 2 | 注册表 | **7 项**（planner/frontend/backend/database/qa/reviewer/devops）；首项自动选中（active：底 `rgb(240,237,255)` + 边框 + `inset 3px 0 rgb(108,92,231)`，radius 12px）；仅 1 个 active；名称为 `rgb(107,114,128)`/13px（**非** legacy 的 `rgb(101,117,138)`） |
| 3 | hover / focus | hover 白 → `rgb(248,249,252)`（`--muted`）；focus-visible **2px `rgb(108,92,231)`** |
| 4 | 详情 | 可用性 `StatusBadge` = 「可用」+ `text-success`；`dl` 四行 **110px + 1fr**（能力/工具/路径/模式）；计数 `Badge` = 22 / 1 |
| 5 | RouterLink | 「打开」→ `/agent-run?run=<uuid>`，颜色 **`rgb(108,92,231)`**、无下划线（全局未分层 `a{color:#1d4f91}` 已被 scoped 规则压制）✓ |
| 6 | 响应式（Agents） | @1440/@1280：指标 3 列、布局 300px + 1fr；**@800：两栏（300 + 265）**；**@799：单列（580px）**；无横向溢出 |
| 7 | `/agent-run` 结构 | h1 24px/600；页宽 **1280px**；页头「创建运行」；表单 label「任务」+ textarea `rows=5` / `maxlength=2000` / 14px / 高 130px / 初值 `DEFAULT_TASK`；「开始」36px 可点 |
| 8 | 运行列表 | **57 项全量渲染**；状态徽标 tone（已超时 → `text-warning`）；任务行 `ellipsis + nowrap`（truncate 保留）；active = Primary |
| 9 | 深链接 `?run=` | `?run=38edeb4c…`（151 工具 / 356 事件）与 `?run=6545d83f…`（4 工具 / 14 事件）均正确加载对应运行 |
| 10 | 详情 | 三指标「状态 / 当前迭代 / 重试」= 已超时 / 59 / 50 / 1，**28px/600**；`dl` 四项（任务=「编码任务」占位保留 / 开始 / 结束 / 耗时 120.0s） |
| 11 | 工具调用 | **151 行**；`StatusBadge`（git_status 已成功 → `text-success`）、耗时 147ms、`min-[900px]` 行内 `1fr + 180px`、meta 桌面 `justify-items:end` |
| 12 | 工作流事件 | **356 行**（`eventLabel` / `eventSummary` / 时间） |
| 13 | 最终结果 | `<pre>`：`max-height 220px` / `overflow auto` / `white-space: pre-wrap` / 底 `rgb(248,249,252)`；内容 = 真实 `output.finalResult`‖`error.message`（"Agent run timed out"） |
| 14 | 响应式（AgentRun） | @1440：360 + 837；@1280：360 + 677；**@900：两栏 360 + 297**；**@899：单列 680px**（指标单列、工具行单列、meta 左对齐）；四档 `overflowX = 0` |
| 15 | Loading / Error / Empty | 延迟 API 时间线：列表「正在加载 Agent 运行…」（空态**未**出现）→ 57 项；详情「正在加载运行详情…」→ 渲染；列表失败 → `text-danger` 错误行 + 详情空态，**列表空态不出现**（v-if 顺序与 legacy 一致）；Agents：空注册表 → 「暂无已注册的 Agent。」+「请选择 Agent。」，失败 → 错误行 `rgb(220,38,38)` + 6 指标「暂无数据」 |
| 16 | **SSE** | `EventSource → /api/agent-runs/<id>/stream` 建立；终态运行收到快照后 **readyState 2（已关闭）** —— `applySnapshot` 的终态停实时逻辑按原样工作 |
| 17 | **SSE → UI 刷新** | 合成 `snapshot`（status→running）→ UI 0.4s 内变为「运行中」且**「取消」按钮出现**（destructive `rgb(220,38,38)`，未 disabled） |
| 18 | **Polling 兜底** | `delete window.EventSource` 后：**0 次 `/stream` 请求**，改为 `GET /api/agent-runs/<id>`（列表 + 详情 + **2 秒后的轮询**），终态快照到达后自动停止；详情正常渲染 |
| 19 | **取消 UI（离线验证，不中断真实运行）** | 离线点击「取消」→ 记录到 `POST /api/agent-runs/<id>/cancel` 尝试（请求未离开浏览器）、**`window.confirm` 调用 0 次**（无新增 confirm）、按钮文案回落「取消」（无卡死）、错误行 danger；恢复在线后状态由真实数据恢复 |
| 20 | 控制台 | 两页 + 全部分支场景 **0 console error / 0 Vue warning / 0 unhandled rejection** |
| 21 | 其他页面回归 | `/`、`/projects`、`/requirements`、`/workflows`、`/deployments`、`/mcp` 全部正常渲染、无横向溢出、无 console 输出 |
| 22 | 业务零副作用 | 复核后端：**57 runs**（timed_out 4 / succeeded 29 / failed 23 / cancelled 1，`isActiveRun` 为真者 **0**）、**7 agents** —— 与验证前完全一致 |

## 6. 测试结果

```
Test Files  24 passed (24)     ← 22 → 24（+2 文件）
Tests       158 passed (158)   ← 137 → 158（+21 例）
```
四道门禁：`typecheck` ✅ 0 error｜`lint` ✅ 0 warning/error｜`test` ✅ 全绿｜`build` ✅。
`prettier --check`：`viewmodels/agentRunViewModel.ts` ✅ 通过（与既有 viewmodel 一致）；`.vue` 与测试文件沿用仓库既有基线（本阶段未引入新的格式差异）。

## 7. build 结果

```
dist/index.html                   0.43 kB │ gzip:   0.30 kB
dist/assets/index-CcyfClsR.css   30.67 kB │ gzip:   6.40 kB
dist/assets/index-472K6Bww.js   329.55 kB │ gzip: 102.94 kB
✓ 2072 modules transformed / built in 927ms
```
（上一阶段：CSS 28.50 kB / JS 324.66 kB → CSS +2.17 kB、JS +4.89 kB，来自两页样式与 tone 映射。）

## 8. 风险 / 已知视觉差异

**有意视觉差异（Design System 对齐，任务书已授权）**

1. **AgentRun 指标 22px → 28px**：`text-metric`（`.run-metrics .metric strong { font-size: 22px }` 的页级覆盖退役）——实测 28px/600 ✓。
2. **计数胶囊语义化**：legacy `.status` 恒为绿底（计数也是绿色）→ 计数改为 `Badge variant="secondary"`（中性）、工具状态/可用性改为 `StatusBadge` tone。属语义化变更，非等价像素。
3. **`.error-banner` 首次上色**：Agents 页错误行此前无任何样式，现为 `text-danger`（同 7-B 先例）。
4. **激活态色相**：注册表/运行列表的 active 由旧蓝 `#1d6fd3` 改为 Primary `#6C5CE7` 体系（含 `inset 3px`）。
5. **断点边界 1px 语义**：legacy `@media (max-width: 800px|900px)` 在**恰好等于**断点时折叠为单列；迁移后使用 `min-[800px]` / `min-[900px]` ⇒ 恰好 800/900 时为两栏（实测 @800 两栏、@799 单列；@900 两栏、@899 单列）。与 Phase 5-B / 6-B / 7-B 既有做法一致（各页统一「≥N 两栏」语义），如需与 legacy 逐像素一致可改为 `min-[801px]` / `min-[901px]`，留待裁定。

**风险 / 限制**

6. **「取消」无真实数据可触发**：全库 57 runs 中 `isActiveRun` 为真者 **0** ⇒ 取消按钮的真实出现只能用「合成 SSE 快照 + 离线点击」验证（本阶段已如此执行，未中断任何真实运行）。真实取消链路（后端中断运行 → `cancelling` → 终态）仍未被端到端覆盖。
7. **同路由内换 `?run=` 不刷新**：`onMounted` 读取 + 无 watcher 为既有行为，本阶段保留；从 `/agents` 或 `/workflows` 跳入正常。
8. **大页面量级**：AgentRun 页单次渲染 57 列表项 + 151 工具行 + 356 事件行（约 500+ 行），无虚拟滚动（任务书禁止），实测无报错、无卡顿、无溢出。
9. **`runTask()` 占位**：真实 run 的 `input` 无 `task` 字段 ⇒ 列表/详情「任务」显示「编码任务」（既有行为，未修）。
10. **`toolStatusLabel(failed)` 返回业务错误码**（如 `TEST_ASSERT`）在 `StatusBadge` 中带 error tone 展示 —— 文案与业务语义未变。
11. **Agents 详情无 loading 指示**：`select()` 期间保留旧详情（既有行为，未新增 Skeleton）。
12. **`a{color}` 与 `font:inherit` 两个全局级联陷阱**仍需每页 scoped 规避（根治留 Phase 11）；本阶段两页均已处理（`agent-link` scoped + 列表项 scoped `font-size`）。
13. **资源残留**：验证用 preview 服务与浏览器标签已全部关闭，5173 端口已释放（另清理了一个此前遗留的 preview 孤儿进程）。
14. **未清理死代码**：`listAgentRunEvents` / `runCodingAgentDemo` / `runDemo` 三处保持原样。

---

**Code changed: ONLY Agents / AgentRun-related files**（5 个：`views/AgentsView.vue`、`views/AgentRunView.vue`、`viewmodels/agentRunViewModel.ts`、2 个新测试文件；另有 1 个 7-B 测试文件因误改已完整回滚，内容等价）
**API changed: NO** ｜ **Store changed: NO** ｜ **Router changed: NO** ｜ **SSE changed: NO** ｜ **Dependencies changed: NO** ｜ **styles.css changed: NO**
**Verification**: 24 files / 158 tests PASS；typecheck / lint / build 全绿；真实 API + 真实 SSE + polling 兜底 + 离线取消 + 8 路由回归 + legacy 规则穿透审计（leaks = 0）全部通过；后端业务状态零变化。

按阶段纪律**在此停止**，不进入 Phase 9。
