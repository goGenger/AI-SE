# Phase 7-B — Workflows UI 重构（实施记录）

> 阶段：Phase 7-B（WorkflowsView 视觉层重构）
> 前置：Phase 7-A PASS（`docs/76-phase-7-workflows-analysis.md`）
> 依据：`docs/design/*`、`docs/ui-reference/ai-se-home.png`、Phase 3-B/3-C/4/5/6 既有实现、7-A §9 Migration Mapping
> 原则：**Visual Redesign, Functional Preservation** —— UI 图只定义视觉语言，现有代码决定业务功能。
> 日期：2026-09-15

---

## 1. 修改文件

| 文件 | 变更 | 行数 |
| --- | --- | --- |
| `apps/web/src/views/WorkflowsView.vue` | template + scoped 样式重写；`<script setup>` **业务代码逐行未改**（仅新增组件/映射函数 import） | 292 → **445** |
| `apps/web/src/viewmodels/workflowViewModel.ts` | **仅新增** `WorkflowStatusTone` 类型 + `workflowStatusTone()` 纯展示映射 | 64 → **94** |
| `apps/web/src/__tests__/workflowsView.test.ts` | 新增（页面契约测试） | **332**（新） |
| `apps/web/src/__tests__/workflowViewModel.test.ts` | +2 例 tone 断言 | 54 → **75** |

未改动（逐文件 mtime 核对）：`styles.css`（960 行 / 11:41）、`api/workflows.ts`（9-14）、`stores/workflows.ts`（9-14）、`router/index.ts`（9-11）、`package.json`（12:12）、`RequirementsView.vue`（15:01，6-B）、`styles/app.css`、`components/**`、其他 9 个视图。

复用组件（无新增组件、无新增依赖）：PageHeader / SectionHeader / Card / StatusBadge / EmptyState（3-C）＋ Button / Badge / Input / Label（3-B）＋ `taskStatusTone()`（6-B）。

## 2. 新增测试

`apps/web/src/__tests__/workflowsView.test.ts`（**10 例**，Vue 官方 SSR 渲染 + Pinia + memory router，零新增测试依赖）：

1. PageHeader 文案 + 创建表单全部字段与校验属性（`required` ×2、number min/max、`maxlength=1000`、5 个策略选项、checkbox、提交按钮）
2. 工作流列表三态：`加载中…` / `暂无工作流。` / 列表项（状态徽标 tone + 截断 id + 版本号）
3. 无选中工作流 → `请选择或创建工作流。`
4. 错误提示渲染为 `text-danger`（`.error-banner` → Tailwind）
5. 详情：状态徽标 + 3 项元数据 + PENDING 时仅「开始/取消」
6. PAUSED → 继续+取消；RUNNING → 暂停+取消
7. 终态（SUCCESS/FAILED/CANCELLED）**不渲染任何生命周期按钮**
8. 审批面板：无 PENDING 不渲染；有则渲染任务标题/原因 + 批准/拒绝，且**两个按钮均不带 `disabled` 属性**
9. 工作流图：节点 key/标题、类型 `Badge`、状态 `StatusBadge`（running/warning tone）、`前置：`、`动态任务 ·`、`执行 Agent：`、`/agent-run?run=` 深链接、grid 内联列定义
10. 事件时间线：时间 / `eventLabel` / 任务短 id 或「工作流」、三列 grid 定义

`workflowViewModel.test.ts` **+2 例**：7 种状态 → tone 全量断言；tone 与 `canStart/canPause/canResume` 语义解耦。

> SSR 下 `onMounted` 与非 immediate 的 `watch` 不执行 ⇒ 测试**不发任何网络请求、不建立 SSE**；Store 状态由测试注入，不做 API mock。真实 API / SSE 由 §11 浏览器验证承担。

## 3. 删除的 legacy class（本页 30 个 → 0）

`page`、`workflow-page`、`page-header`、`eyebrow`、`error-banner`、`workflow-layout`、`workflow-sidebar`、`workflow-detail`、`form-panel`、`stacked-form`、`panel`、`panel-header`、`workflow-list-panel`、`workflow-list-item`(+`active`)、`status-pill`、`workflow-actions`、`workflow-metadata`、`approval-panel`、`approval-row`、`workflow-graph`、`workflow-node`(+`[data-status]`)、`event-timeline`、`empty`、`workflow-empty`、`state`、`mcp-note`、`checkbox-row`、`button`。

实测残留：上列 17 组选择器在页面内命中数**全部为 0**（含 `.page` / `.panel` / `.button` / `.error-banner` / `.status-pill` / `.event-timeline` / `.workflow-node` / `.approval-*` / `.state` / `.mcp-note` / `.checkbox-row` / `.eyebrow`）。

替代实现：Card / SectionHeader / PageHeader / StatusBadge / EmptyState / Button / Badge / Input / Label + Tailwind；原生 3 `<select>` / 2 number / 1 checkbox 用**页面级 scoped 样式**（未用 `!important`、未改 `styles.css`、未新增组件）。

### 3.1 本阶段发现并修复的真实缺陷（P1，legacy 复合选择器穿透）

**症状**：列表项内状态徽标实测 `color: rgb(101,117,138)` / `font-size: 13px`，而类名是 `bg-danger-bg text-danger` / `text-caption`（应 12px）。

**根因**：`styles.css:310` 存在未分层复合选择器
```css
.workflow-list-item span, .workflow-node small, .workflow-node p, .approval-row p { color:#65758a; font-size:13px; margin:0 }
```
初版实现复用了 legacy 类名 `.workflow-list-item`，该规则（0,1,1，未分层）**恒定压过** `@layer utilities` 中的 `.text-danger` / `text-caption`（0,1,0）→ 语义色与字号被静默改写。

**修复**：列表项类名改为 `workflow-item` / `workflow-item--active`，本页与 legacy CSS **完全无交集**。

**复验**：`legacyMatchOnBadge: false`、legacy 元素命中数 0；徽标恢复 `rgb(107,114,128)`/12px（neutral）、`rgb(220,38,38)`/12px（error）。同时在组件注释与测试中断言「不得复用 `.workflow-list-item`」防回归。

## 4. API 是否变化

**NO**。`api/workflows.ts` 10 个导出（含 4 个未使用端点）零改动；`getWorkflow` 聚合返回、`listRequirements` **继续由 View 直接调用**（未改走 requirements store）；3 条错误文案与 store 兜底文案逐字保留。

## 5. Store 是否变化

**NO**。`stores/workflows.ts` 全文（SSE 单例、2 秒轮询兜底、`applySnapshot` 列表 upsert + 终态停实时、`act`/`decide` 后 `loadWorkflow`、`loading/creating/acting/error` 语义）零改动；既有 `stores/__tests__/workflows.test.ts` 2 例契约测试未改且继续通过。

## 6. Router 是否变化

**NO**。两条路由（`/workflows` 与 `/workflows/:id` 共用同一组件）、深链接、`watch(selectedId)`、创建成功后 `router.push('/workflows/:id')`、`/agent-run?run=` 跨页深链接全部原样；未新增路由/子路由。

## 7. ViewModel 是否变化

**仅新增一个纯展示映射**，其余 7 个函数（`workflowStatusLabel` / `failureStrategyLabel` / `taskDependencies` / `canStart` / `canPause` / `canResume` / `normalizeWorkspacePath`）**逐字未改**：

```ts
export type WorkflowStatusTone = "pending" | "running" | "warning" | "success" | "error" | "neutral";
// PENDING→pending  RUNNING→running  PAUSED→neutral  WAITING_APPROVAL→warning
// SUCCESS→success  FAILED→error     CANCELLED→neutral
export function workflowStatusTone(status: WorkflowStatus): WorkflowStatusTone;
```

跨页共享契约 `requirementViewModel.ts`（`taskStatusLabel` / `taskTypeLabel`）与 `agentRunViewModel.ts`（`eventLabel`）**零改动**；任务状态复用 6-B 已建的 `taskStatusTone()`。

## 8. Business behavior 是否变化

**NO**。逐项核对：`onMounted → Promise.all(fetchProjects, loadWorkflows)` → 有深链接 id 再 `loadWorkflow`；`watch(projectId)` 清空 `requirementId` + 直连 `listRequirements`；`watch(selectedId)`；`create()` 守卫 `if (!projectId || !requirementId) return;` + `normalizeWorkspacePath` + `allowRetry/allowReplan` 由策略推导 + 成功跳转；Start/Pause/Resume/Cancel 的可见性条件（含取消按钮**内联** `!['SUCCESS','FAILED','CANCELLED'].includes(status)`）与 `:disabled="workflows.acting"`；Approval approve/reject（**未加 disabled**）；SSE + 2s 轮询；`onBeforeUnmount → stopRealtime`；表单字段/校验/`v-model.trim`/`v-model.number`；需求下拉仅 `ANALYZED`；全部文案、状态枚举、四类 Loading/Error/Empty 分支顺序。

**专项确认**：① 取消**未新增 confirm**（实测点击时 `window.confirm` 调用数 = 0）；② 审批按钮**未新增 disabled**（测试断言属性级检查）；③ `listRequirements` 仍由 View 直连；④ **未新增** Dialog / Select / Checkbox 组件；⑤ 未使用 `!important`；⑥ 未引入 DAG 库/SVG/Canvas；⑦ 926 条事件仍全量渲染（**未加**滚动容器、限高或虚拟列表）。

## 9. 测试结果

```
Test Files  22 passed (22)      ← 21 → 22（+1 文件）
Tests       137 passed (137)    ← 125 → 137（+12 例）
```
四道门禁：`typecheck` ✅ 0 error；`lint` ✅ 0 warning/error；`test` ✅ 全绿；`build` ✅。
`prettier --check`：`workflowViewModel.ts` ✅ 通过（与既有 viewmodel 一致）；`.vue` / 测试文件与 3-B/3-C/4/5-B/6-B 既有交付物保持同一基线（仓库现状 18 个文件均不满足 prettier，非本阶段引入）。

## 10. build 结果

```
dist/index.html                   0.43 kB │ gzip:   0.30 kB
dist/assets/index-CZduX-jB.css   28.50 kB │ gzip:   6.19 kB
dist/assets/index-9D0PPzb1.js   324.66 kB │ gzip: 103.85 kB
✓ 2070 modules transformed / built in 593ms
```
（上一阶段基线：CSS 26.45 kB / JS 321.84 kB → CSS +2.05 kB、JS +2.82 kB，新增部分为 Workflows 页样式与测试无关的组件引用。）

## 11. 浏览器验证结果

环境：`vite preview --port 5173`（= 后端 `CORS_ORIGIN`，**真实 API**，后端 :3000 + Postgres/Redis）；真实数据 **7 条工作流**（1 × PAUSED + 6 × FAILED），其中 PAUSED 的 `99975877-48e3-4448-9092-2ea9b10d53fe` 含 **33 任务 / 73 依赖 / 926 事件**。

| # | 验证项 | 实测结果 |
| --- | --- | --- |
| 1 | `/workflows` 结构 | `PageHeader` → h1 **24px/600**、eyebrow「阶段 4」；两栏 **320px + 717px**、gap 24；2 张 Card（创建 / 列表）；7 个列表项 |
| 2 | 创建表单（原生控件） | 3 × `<select>`：h **36px**、字号 **14px**、边框 `rgb(232,234,240)`、圆角 **10px**、白底；`required` ×2；策略 5 选项齐备；number `min/max` 与 `maxlength=1000` 保留 |
| 3 | checkbox | `accent-color: rgb(108,92,231)`（Primary）、行 `grid-template-columns: 20px 250px` |
| 4 | 提交按钮 | 「创建」h 36px、底 `rgb(108,92,231)`、白字、圆角 10px |
| 5 | 列表状态徽标 | 7 项：`已暂停` → `bg-muted`（neutral）、6 × `失败` → `bg-danger-bg text-danger`（error）；**计算值 12px**（修复后） |
| 6 | 列表激活态 | 边框 + 底色 `rgb(240,237,255)` + `inset 3px 0 rgb(108,92,231)`（旧蓝 `#1d6fd3` 已消失）；类名 `workflow-item workflow-item--active` |
| 7 | 列表 hover | 白 → `rgb(248,249,252)` = `--muted`（CDP 真实鼠标） |
| 8 | 深链接 `/workflows/:id` | h2 = workflow UUID；状态徽标 `已暂停`（neutral）；元数据 **3 列**：并发 2 / 重试 2 / 策略「重试」（与真实数据一致） |
| 9 | 动作按钮 | PAUSED → 「继续」(primary) + 「取消」(destructive `rgb(220,38,38)`)，无「开始/暂停」；切到 FAILED → **0 个动作按钮**（终态） |
| 10 | 工作流图 | **33 个节点**；类型 `Badge`（如「设计」）+ 状态 `StatusBadge`；tone 集合 `bg-success-bg`(SUCCESS) / `bg-danger-bg`(FAILED) / `bg-neutral-bg`(PENDING) / `bg-muted`(其他)；`前置：T-000` 32 行；`执行 Agent：` 3 行；`data-status` 属性已移除 |
| 11 | Agent Run 深链接 | 3 条「查看 Agent 运行」→ `/agent-run?run=<uuid>`；**颜色 `rgb(108,92,231)`**、无下划线（scoped 规则胜出全局未分层 `a{color:#1d4f91}`） |
| 12 | 事件时间线（**926 行**） | 渲染 **926 条**（与 API 一致）；三列 `100px / 461px / 90px`；首行「18:41:02 / 工作流已创建 / 工作流」；上边框 `--border` |
| 13 | 分支时间线（延迟 API，真实路径） | t≈0.9–2.8s：列表「加载中…」显示且空态**未**出现；t≈3.4s：7 项渲染；详情等待期显示「请选择或创建工作流。」→ 随后渲染 33 节点 / 926 行 |
| 14 | Error 分支 | 构造列表请求失败：「网络请求失败：无法连接后端服务」以 `mb-5 text-body text-danger`、`rgb(220,38,38)`/14px 渲染；`.error-banner` 命中数 **0**；列表空态与详情空态**同时**出现（与 legacy 行为一致） |
| 15 | 状态切换（列表点击） | 点击 FAILED 项 → URL 变为该 id、徽标 `失败`、动作按钮清空、任务 33 / 事件 57、激活项跟随 ✓ |
| 16 | SSE | `EventSource → http://localhost:3000/api/workflows/<id>/stream`，`readyState = 1`；**真实推送约 1 次/秒**（6s 内 6 次） |
| 17 | SSE → UI 刷新 | 合成 `snapshot` 事件（重试 2→9、头部插入 1 条事件）→ 0.3s 内 UI 变为 **重试 9 / 926→927 行 / 首行「工作流已暂停」**；1 秒后真实推送到达并刷新回真值（证明实时刷新双向有效） |
| 18 | 焦点可达性 | select / checkbox / 列表项 / 提交按钮 focus-visible 均为 **2px `rgb(108,92,231)`** 环；Agent 链接 focus 后保持 Primary 色 |
| 19 | 响应式 | @1280：320+717 两栏、元数据 3 列、图 3 列；@900：320+337 两栏、图 1 列；**@899：单列 680px、元数据单列（本阶段允许的修正）**；三档 `overflowX = 0` |
| 20 | 控制台 | 全程 **0 console error / 0 Vue warning / 0 unhandled rejection**（在应用加载前注入 console hook 捕获） |
| 21 | 业务零副作用 | 点击「继续」「取消」在**离线**环境执行（请求不可能到达后端）+ fetch 记录显示 `POST .../resume`、`POST .../cancel` 均被尝试、`confirm` 调用 0 次；复核后端：7 条工作流（1 PAUSED + 6 FAILED）、`updatedAt` 未变、33/73/926/0 未变 |

## 12. 风险 / 已知偏差

1. **修复 P1 缺陷的副产物**：列表项类名由 `.workflow-list-item` 改为 `.workflow-item`（本次唯一偏离 7-A §9 字面的地方，原因见 §3.1）。`styles.css` 中的 `.workflow-list-item` 现在**不再被任何页面使用**（仅 Workflows 曾用），但按纪律**未删除**，留待 Phase 11。
2. **审批面板无法用真实数据验证**：全库唯一审批记录为 `APPROVED`，**无 PENDING**（7-A Risk #11 已记录）→ 批准/拒绝路径仅由 SSR 契约测试覆盖（含「无 `disabled`」断言）。
3. **926 行时间线 + 1Hz 快照**：页面每秒全量重渲染 926 行，实测无报错、无卡顿、无内存告警，但属已知性能特征；本阶段**未**加限高/滚动/虚拟列表（任务书明确禁止改变渲染行为）。
4. **`.error-banner` 首次上色**：该文案此前完全无样式；现为 `text-danger`（任务书 §8 允许的视觉变化）。
5. **Agent 链接无 focus-visible 环**：沿用 legacy（原本也无），未新增视觉；仅颜色与下划线纳入 Token。
6. **`--input` 边框色实测 = `--border`（`#E8EAF0`）**：与 `Input` 组件一致；未新增第二个边框色。
7. **@900px 时元数据 3 列仅 90px/列**：沿用 legacy 行为（legacy 恒为 3 列），<900 才单列（本阶段允许的修正）。
8. **`prettier --check` 非本仓库门禁**：`.vue`/测试文件与既有交付物同基线（仓库 18 个文件不满足），仅 viewmodel 保持 prettier-clean（与既有 viewmodel 一致）。
9. **Header / 其他页面 legacy 类级联问题**（全局 `a{color}`、`button,input,select,textarea{font:inherit}`）仍按既有 scoped 手法规避，根治仍留 Phase 11。
10. **未清理死代码**：4 个未使用的 workflow API 端点、`api/requirements.ts` 的 `getTask`/`getTaskDependencies` 等原样保留。

---

**Code changed: ONLY Workflows-related files**（4 个：`views/WorkflowsView.vue`、`viewmodels/workflowViewModel.ts`、2 个测试文件；未改其他页面、未改 `styles.css`）
**API changed: NO** ｜ **Store changed: NO** ｜ **Router changed: NO** ｜ **Dependencies changed: NO**
**Business behavior changed: NO** ｜ **ViewModel 既有输出 changed: NO**（仅新增 `workflowStatusTone`）
**Verification**: 22 files / 137 tests PASS；typecheck / lint / build 全绿；真实 API + 真实 SSE + 926 事件页面验证通过；后端业务状态零变化。

按阶段纪律**在此停止**，不进入 Phase 7-C，不修改其他页面与 `styles.css`。
