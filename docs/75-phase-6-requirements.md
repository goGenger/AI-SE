# Phase 6-B — Requirements UI 重构（实施记录）

> 阶段：Phase 6-B（Requirements 页面视觉重构）
> 前置：`docs/74-phase-6-requirements-analysis.md`（Phase 6-A 现状分析与冻结清单）
> 依据：`docs/design/*`、`docs/ui-reference/ai-se-home.png`、`docs/60`–`docs/74`、Phase 3-B/3-C/4/5 既有视觉体系
> 范围：仅 `/requirements`
> 日期：2026-09-15

---

## 1. 修改文件

| 文件 | 类型 | 改动 |
| --- | --- | --- |
| `apps/web/src/views/RequirementsView.vue` | 修改 | template / class / 组件组合 + scoped 样式（原生 select 与列表项）；`<script setup>` 业务代码逐行未改 |
| `apps/web/src/viewmodels/requirementViewModel.ts` | 修改 | **仅新增** `requirementStatusTone()` / `taskStatusTone()` 两个纯展示映射及其类型；既有 8 个函数（含 4 个文案函数）一字未改 |
| `apps/web/src/__tests__/requirementsView.test.ts` | 新增 | 页面契约测试（12 例） |
| `apps/web/src/__tests__/requirementViewModel.test.ts` | 修改 | **仅新增** 2 例 tone 映射断言 |

**未改动**：API（`api/requirements.ts` 9月14）、Store（`stores/requirements.ts` 9月14）、Router（`router/index.ts` 9月11）、`styles.css`（11:41）、Design Token、其他页面（`WorkflowsView.vue` 9月14）、`package.json`（12:12）、依赖。**未新增任何组件/路由/依赖。**

## 2. UI 重构内容

| # | 区域 | Legacy | New |
| --- | --- | --- | --- |
| 1 | 页头 | `.page-header` + `.eyebrow` + `<h1>` + `button.primary` | `PageHeader eyebrow="需求规划" title="需求"` + `#actions` 内 `<Button>`（「分析」/「分析中…」，disabled 三条件逐字保留） |
| 2 | 布局 | `.page.requirement-page` + `.run-layout`（360px + 1fr，≤900 折叠） | `max-w-[1320px]` + `grid grid-cols-1 gap-6 min-[900px]:grid-cols-[360px_minmax(0,1fr)]` |
| 3 | 创建表单 | `.form-panel` + `.stacked-form` + 包裹式 `<label><span>` | `Card` + `SectionHeader title="新建需求"` + `Label for` / `Input` / `Textarea` + `<Button type="submit">`；**原生 `<select>` 保留**并以 scoped 规则显式声明 width/height/padding/border/background/color/font-size/line-height/focus-visible（全部 Token） |
| 4 | 需求列表 | `.run-list` + `.button.run-list-item[.active]`（蓝色 `#1d6fd3` 内阴影）+ `.status` 计数 | `Card` + `SectionHeader title="需求列表"`（`#actions` 内 `Badge variant="secondary"` 计数）+ **原生 `<button>`** 列表项（Card 化外观）：**激活态 = `--primary` 边框 + `--primary-light` 底色 + `--primary` 3px 内阴影**，hover = `--muted`，focus-visible = 2px `--ring` |
| 5 | 需求状态 | 纯文本 `requirementStatusLabel` | `<StatusBadge :tone="requirementStatusTone(...)">`（列表项内） |
| 6 | 指标 | `.metric-grid.run-metrics` + `.metric`（数字 **22px**） | 3 × `Card` + `text-metric`（**28px/600**，设计 §4 区间上限） |
| 7 | 四个面板 | `.panel` + `.panel-header`（h2 + `.status` 标记） | 4 × `Card` + `SectionHeader`（右侧标记改 `Badge variant="secondary"`：需求标题 / 事件数 / 规格数 / 「n 条依赖」） |
| 8 | 详情列表 | `.detail-list.compact-detail-list`（`110px 1fr`，内联分割线） | `<dl class="divide-y divide-border">` + 行 `grid-cols-[110px_1fr]` + `py-3`；**字段顺序未变**（描述 / 创建时间 / PRD） |
| 9 | 规划事件 | `.event-list` + `.event-row`（`minmax(0,1fr) 180px`，≤900 折叠） | `ul` + 行 `grid grid-cols-1 … min-[900px]:grid-cols-[minmax(0,1fr)_180px]`，保留 label / summary / time 与首行无上边框 |
| 10 | 规格 | `.spec-grid` + `pre.result-block` | `Card` 内 article 列表（首项无上边框）+ `<pre>`：`bg-muted` + `border-border` + `rounded-lg` + `max-h-[220px]` + `overflow-auto` + `whitespace-pre-wrap` + 13px；**JSON 仍为 `JSON.stringify(content, null, 2)`** |
| 11 | 任务 DAG | `.dag-layout` / `.dag-grid` / `.dag-node` / `.dag-node-meta` / `.dependency-list` | Tailwind grid（`repeat(auto-fit, minmax(220px,1fr))`）+ 节点容器（`bg-muted` + `--border` + 12px）；任务类型/来源用 `Badge variant="secondary"`，**任务状态用 `StatusBadge :tone="taskStatusTone(...)"`**，依赖关系用 `Badge variant="secondary"`（`T-001 -> T-002` 文案不变）；**未引入任何 DAG 图库 / SVG / Canvas / 坐标系统** |
| 12 | 空态 / 加载 | `.state` / `.empty` / `.empty.compact-empty` | Tailwind `<p>`（muted / danger）+ `EmptyState size="compact"`（5 处文案逐字保留） |

级联处理：页面**无任何 `<RouterLink>`**，故不需要链接色 scoped 规则；原生 `<select>` 与列表项 `<button>` 使用 scoped 规则（未分层 + class 特异性）对抗 `styles.css` 中未分层的 `button, input, select, textarea { font: inherit }`。**未使用 `!important`，未新增全局类，未修改 styles.css。**页面内 legacy 类残留 **0 个**（浏览器实测）。

## 3. 业务冻结验证

| 冻结项 | 验证方式与结果 |
| --- | --- |
| API contract | 未改文件；浏览器记录到的真实请求：`GET /api/projects` → `GET /api/projects/:id/requirements` → `GET /api/requirements/:id` + `/specifications` + `/tasks` |
| Store（含 SSE / 轮询 / 终态 / 清空行为） | `stores/requirements.ts` mtime 仍 9月14，未改一行 |
| Router | 未新增路由；`router/index.ts` mtime 仍 9月11 |
| 1. mounted → fetchProjects → 默认选 projects[0] | 真实数据实测：select value = 真实项目 id，选项 = 「选择项目」+「Mini Todo」 |
| 2. project 改变 → loadRequirements | 时间线实测（注入 2s 延迟）：列表 loading 分支出现 → 数据到达后列表渲染 |
| 3. 创建守卫 | 实测：清空标题（`.trim` 后为空）→ 创建按钮 disabled；未选项目 → disabled |
| 4. 创建成功后**不清空表单** | 实测（拦截 POST/GET，不写库）：提交后三个字段仍为 `PHASE6B-TEMP` / `临时描述` / `# 临时 PRD`；POST body 仅 `{title, description, rawContent}` |
| 5. 点击列表 → loadRequirement | 实测：点击 → 详情加载分支 → 指标/四面板渲染（真实 33 个任务节点） |
| 6. 分析按钮 disabled 三条件 | 实测：未选需求 → disabled；已选 ANALYZED → enabled；**全程未点击**（避免触发外部 Agent/LLM） |
| 7. `analyzeSelectedRequirement(false)` | 代码逐字保留（未改） |
| 8. SSE 实时更新 | store 未改；页面仅渲染 `currentAgentRun` |
| 9. unmount → stopRealtime | 代码逐字保留 |
| 10. Loading / Error / Empty 分支顺序 | 左栏：loading → error → empty → list（时间线 + error 分支实测）；右栏：detailLoading → !selectedRequirement → 内容（时间线 + 空态实测） |
| 表单约束 | 实测 DOM：`maxlength` 160 / 1000 / 20000、`rows=7`；**未新增 `required` / HTML 校验**（测试断言 `<input|select|textarea[required]` 不存在）；`v-model.trim` 行为实测生效（输入 "   " → 值为 ""） |
| 错误文案 | 实测：拦截 API 后左栏显示 `网络请求失败：无法连接后端服务`（danger 色），且**空态不出现**（error 优先） |
| 详情失败仍显示「请选择或创建需求。」 | **未改造为 ErrorState**；实测初始状态即为该空态 + 分析按钮 disabled |
| 业务文案 | 全部逐字保留（PageHeader / 5 处空态 / 面板标题 / 指标标签 / 按钮文案 / 字段名 / 错误文案） |
| ViewModel 既有输出 | 4 个文案函数未改（测试断言未变），`WorkflowsView` 共享的 `taskStatusLabel` / `taskTypeLabel` 输出不变 |

**真实数据零变化**：全程只做 GET；创建流程用拦截验证，`curl` 复核数据库仍为 **2 条需求**（`Todo 管理系统 ANALYZED` / `Todo 管理系统 FAILED`）。

## 4. 测试结果

- **before：20 files / 111 tests** → **after：21 files / 125 tests**（+14：`requirementsView.test.ts` 12 例、`requirementViewModel.test.ts` +2 例；既有 111 例全部保留、断言未改）
- 新增覆盖：PageHeader 与表单控件约束（含「无 required」断言）、表单初始值与提交 disabled、左栏 4 分支互斥、列表项为 `<button>` 且激活态唯一、右栏 2 分支、3 指标 + 4 面板 + `dl` 字段、`<pre>` 的 pre-wrap/限高/可滚动与 JSON 内容、事件行渲染（label/summary/time）、DAG 节点与任务状态 tone、分析按钮 disabled。

| 门禁 | 结果 |
| --- | --- |
| typecheck | **PASS**（exit 0） |
| lint | **PASS**（exit 0，0 problem） |
| test | **PASS**（21 files / 125 tests） |
| build | **PASS**（`index-DOAzhXn1.css` 26.45 kB / `index-k7cSruQ6.js` 321.84 kB） |

## 5. 浏览器验证结果（真实 API + 真实浏览器）

> 后端 `:3000`（真实数据：1 项目 / 2 需求（ANALYZED、FAILED）/ 7 规格 / 33 任务 / 73 依赖）+ `vite preview` `:5173`。**未触发任何分析任务。**

| 检查项 | 结果 |
| --- | --- |
| 正常状态 | h1「需求」24px；PageHeader 分析按钮；表单 4 字段；列表 2 项（均为 `<button>`）；点击第 1 条 → 指标「已分析 / v1 / **33**」全为 **28px/600**；6 个面板（新建需求/需求列表/需求详情/规划事件/规格/任务 DAG）全部渲染 |
| 需求状态 StatusBadge | 已分析 → `#059669` on `#ECFDF5`（success）；失败 → `#DC2626` on `#FEF2F2`（error）；草稿（拦截创建）→ neutral 系 |
| 任务状态 StatusBadge | 待处理 → `#52525B` on `#F2F4F7`（pending）；单测另覆盖 等待审批 → warning |
| 规格 JSON | `<pre>` 实测：`max-height:220px` / `white-space:pre-wrap` / `overflow:auto` / `bg #F8F9FC` / 圆角 12px / 13px，内容为真实 JSON（`endpoints…`） |
| 任务 DAG | 33 个节点（T-001…T-033）+ 类型徽标 + 任务状态徽标 + 来源徽标；`minmax(220px,1fr)` 自适应网格；依赖关系胶囊 73 条 |
| 原生 select | `14px / 36px / border #E8EAF0 / 圆角 10px / 白底 / #1F2937`；focus-visible → `0 0 0 2px #6C5CE7` ✓ |
| 列表激活态 | 边框 `#6C5CE7` + 底色 `#F0EDFF` + inset 3px `#6C5CE7`（**已无 `#1d6fd3`**）；非激活 hover → `#F8F9FC`（`--muted`）✓ |
| 详情加载 | 注入 2s 延迟 + 点击列表项 → 时间线：`detailLoading` 出现「正在加载需求详情…」（指标隐藏）→ 数据到达后恢复 ✓ |
| 详情空态 | 初始状态显示「请选择或创建需求。」+ 分析按钮 disabled ✓ |
| 列表 loading | 时间线：进入页面后依次出现 `(初始)` → **`正在加载需求…`（列表隐藏）** → 列表渲染 ✓ |
| 列表 error | 阻断 API → 「网络请求失败：无法连接后端服务」danger 色，**空态不出现**（error > empty）✓ |
| 无需求 | 拦截列表返回 `[]` → `EmptyState`「暂无需求。」（12px 圆角 / `#E8EAF0` / 16px 内距 = compact）+ 计数徽标 0 ✓ |
| 无项目 | 拦截项目列表返回 `[]` → select 仅「选择项目」且值为空 → 创建与分析按钮均 disabled ✓ |
| 创建按钮 disabled | 清空标题后 disabled ✓；有默认值+已选项目时 enabled ✓ |
| 创建成功后表单不清空 | 拦截 POST/GET 实测：提交后 `title/description/rawContent` **保持原值**；新需求前置插入列表；**数据库仍为 2 条（零写入）** ✓ |
| 分析按钮 disabled | 未选需求 → true；已选 ANALYZED → false；**未点击**（避免外部 Agent/LLM）✓ |
| 响应式 | 880 / 899px → **单列**（左栏与右栏堆叠，宽 661/680）；900 / 1024 / 1440px → **360px + 1fr 双栏**；事件行/指标网格按断点规则生成（CSS 产物已验证 `min-[900px]` 规则存在） |
| 横向溢出 | 全部档位 `0` 或负值（无溢出）✓ |
| focus-visible | 真实键盘 Tab：select、3 个输入、按钮、2 个列表项均出现 2px Primary 焦点环（14/21；其余为可滚动的 `<pre>`，沿用浏览器原生轮廓，与迁移前一致） |
| 控制台 | 无 `window.onerror` / `unhandledrejection`，无 `[Vue warn]` ✓ |
| 其他页面回归 | `/` 与 `/projects` 仍为 24px 已迁移态；`/workflows`、`/mcp` 仍为 legacy 32px 结构；全部无溢出 ✓ |
| legacy 残留 | 本页 29 个 legacy 类**全部为 0** ✓ |

## 6. 风险 / 已知问题

1. **指标在 768–900px 区间保持 3 列**（原 legacy 在 ≤900px 折叠为单列）：本次按设计 §15 的换行策略使用 `md:grid-cols-3`，属**有意的小幅偏差**，未影响 ≥900px 与 <768px 的既有表现。
2. **规划事件面板在真实数据下为空**：事件只在执行「分析」后由 SSE/轮询写入 `currentAgentRun`；为避免触发外部 Agent/LLM，本次未发起分析，事件行渲染改由单测覆盖（label/summary/time + 900px 折叠类）。
3. **`<pre>` 的焦点轮廓**：可滚动 `<pre>` 被 Chrome 纳入 Tab 序列并使用原生 outline（非 Primary ring）—— 与迁移前的 `.result-block` 行为一致，未改。
4. **依赖胶囊数量可能较多**（真实数据 73 条）：当前为 `flex-wrap` 换行，长列表会让该面板变高；未做折叠（属新增交互，本阶段禁止）。
5. **`requirementStatusTone` / `taskStatusTone` 的 tone 语义**为本阶段新定义（DRAFT→pending、ANALYZING→running、ANALYZED→success、FAILED→error；PENDING/READY→pending、RUNNING/RETRYING→running、WAITING_APPROVAL/BLOCKED→warning、SUCCESS→success、FAILED→error、CANCELLED→neutral）。BLOCKED 取 warning（需关注而非失败）为**主观取舍**，如与后端语义不符可在后续阶段调整。
6. **`getTask` / `getTaskDependencies` 死代码**未清理（本阶段禁止清理死代码）。
7. `styles.css` 中本页专属类（`.requirement-page` / `.spec-grid` / `.dag-*` / `.dependency-list`）**保留未删**，按纪律留待 Phase 11 集中清理。
8. 页面间视觉代差：Requirements 已迁移，`/workflows`、`/deployments`、`/agents`、`/agent-run`、`/mcp` 仍为 legacy 视觉（分阶段推进的预期状态）。

---

**API changed: NO**
**Store changed: NO**
**Router changed: NO**
**styles.css changed: NO**
**Dependencies changed: NO**
**Business behavior changed: NO**

按阶段纪律**在此停止**，不进入 Phase 6-C。
