# Phase 5-A — Projects 现状分析（只读）

> 阶段：Phase 5-A（Projects 分析；**禁止修改代码**）
> 依据：`docs/design/*`、`docs/ui-reference/ai-se-home.png`、`docs/60`–`docs/71`（Phase 0–4 记录）
> 结论全部来自对当前代码的实测，未使用推测；无法确定处标记 `Unknown`。
> 日期：2026-09-15

---

## 1. 页面 / 路由

| 路由 | name | View 文件 | 行数 |
| --- | --- | --- | --- |
| `/projects` | `projects` | `apps/web/src/views/ProjectsView.vue` | 121 |
| `/projects/:id` | `project-detail` | `apps/web/src/views/ProjectDetailView.vue` | 74 |

- **不存在其他 Projects 相关前端路由**（`router/index.ts` 全文仅这两条含 project）。
- 两条路由均**无** `meta`、无守卫、无权限、无懒加载（与全项目 13 条路由一致）。
- 服务端对应路由（`apps/server/src/routes/projects.ts`，挂载于 `/api/projects`）有 4 个动词：`POST /`、`GET /`、`GET /:id`、`DELETE /:id` —— **没有 PATCH / PUT，即不存在「编辑项目」接口** → 前端也不可能存在编辑功能（与 `docs/60` 评估一致）。
- 后端不存在 projects 子资源路由（无 `/api/projects/:id/tasks` 之类）。`GET /` 也不接受任何 query 参数（无分页 / 搜索 / 过滤）。

## 2. API / Store / ViewModel

### 2.1 API（`apps/web/src/api/projects.ts`，46 行 —— 冻结）

| 函数 | 调用 | 用途 |
| --- | --- | --- |
| `listProjects()` | `GET /api/projects` | ProjectsView 列表 |
| `getProject(id)` | `GET /api/projects/:id` | ProjectDetailView 详情 |
| `createProject(input)` | `POST /api/projects`（JSON body） | ProjectsView 创建表单 |
| `deleteProject(id)` | `DELETE /api/projects/:id` | 两页的删除 |

统一响应契约（`requestJson`）：`{ success, data }`；`success === false` 时抛出 `payload.error.message`；网络失败 → `"网络请求失败：无法连接后端服务"`；响应非 JSON → `"请求失败（HTTP <status>）"`。**这些错误文案是既有行为，Phase 5-B 必须原样保留。**

### 2.2 Store（`apps/web/src/stores/projects.ts`，65 行 —— 全文冻结）

- state：`projects: Project[]`、`selectedProject: Project | null`、`loading: boolean`、`error: string`
- actions：`fetchProjects()`（成功覆盖 `projects`；失败写 `error`）、`fetchProject(id)`（成功写 `selectedProject`，失败**置空** `selectedProject` 并写 `error`）、`createProject(input)`（**前置插入**新项目并去重，返回 project）、`deleteProject(id)`（过滤 `projects`，若删的是当前选中项则清空 `selectedProject`）—— 全部为业务逻辑，**冻结**。
- `createProject` / `deleteProject` **不设置 loading / error**；错误由调用方（页面）自行 catch —— 这决定了页面里存在页面级局部状态。

### 2.3 ViewModel（`apps/web/src/viewmodels/projectViewModel.ts`）

| 函数 | 是否被 Projects 使用 | 说明 |
| --- | --- | --- |
| `projectStatusLabel(status)` | ✅ 两页都用 | `active` → 「启用」，其余 → 「已归档」 |
| `formatProjectDate(value)` | ✅ 两页都用 | `Intl.DateTimeFormat("zh-CN", {year, month:"short", day:"2-digit", hour:"2-digit", minute:"2-digit"})` —— 输出格式冻结 |
| `projectStatusTone(status)` | ❌ 尚未使用 | **Phase 4 已建立**（`active`→`success`，`archived`→`neutral`）→ Phase 5-B 必须**复用**，不得重复创建 |
| `latestProjects(projects, limit)` | ❌ 不使用 | 仅 Dashboard 使用 |

### 2.4 表单校验契约（后端 zod + 前端 HTML 双向约束，均冻结）

| 字段 | 后端 `CreateProjectSchema` | 前端当前 HTML |
| --- | --- | --- |
| `name` | `string().trim().min(1).max(120)` | `required` `maxlength="120"` `v-model.trim` |
| `repository` | `string().trim().url().max(500)` | `required` `type="url"` `maxlength="500"` `v-model.trim` |
| `description` | `string().trim().max(1000).optional().default("")` | `maxlength="1000"` `rows="5"` `v-model.trim` |
| `status` | 可选，默认 `"active"` | 表单不提交该字段 |

`CreateProjectSchema` 为 `.strict()`：多余字段会被拒绝。表单提交时只发送 `{ name, description, repository }`（与当前实现一致，必须保持）。

## 3. UI 与交互

### 3.1 ProjectsView（列表 + 常驻创建表单，两栏布局）

根结构：`<section class="page two-column">` → 左 `.main-column`（列表）/ 右 `<form class="form-panel">`（创建）。两栏比例 `1fr / 360px`，gap 24px。

| 区域 | 当前实现 |
| --- | --- |
| PageHeader | `.page-header` + `.eyebrow`「项目」+ `<h1>`「项目」—— **没有任何 actions 按钮** |
| Loading | `<p class="state">正在加载项目…</p>` |
| Error | `<p class="state error">{{ error }}</p>`（store error） |
| Empty | `<div class="empty">暂无项目。</div>` |
| List | `<ul class="project-list">` → `<li class="project-row">`：左列=项目名 `<RouterLink class="project-title">`（18px/700）、`<p>` 仓库地址、`<span>` 创建时间；右列 `.row-actions` = `.<span class="status">`状态 + `<RouterLink class="button subtle">打开` + `<button class="button danger">删除/删除中…` |
| 删除按钮 disabled | 跟随局部状态 `deletingId === project.id` |
| Form | `.form-panel`：`<h2>`新建项目 + 3 组 `<label><span>标签</span><input/textarea></label>` + `createError` + `<button class="button primary" type="submit">`创建/创建中… |
| 表单控件属性 | `name`：`required maxlength=120`；`repository`：`required type=url maxlength=500`；`description`：`maxlength=1000 rows=5` |

局部状态（都属于「允许重构视觉、不可改行为」的既有实现）：`creating`、`createError`、`deletingId`、`form`（reactive）。

### 3.2 ProjectDetailView（详情）

根结构：`<section class="page">` → `.page-header` → `.detail-grid`（`1fr / 280px`）。

| 区域 | 当前实现 |
| --- | --- |
| PageHeader | `.eyebrow`「项目详情」+ `<h1>{{ selectedProject?.name \|\| "项目" }}</h1>` + 右侧 `<RouterLink class="button subtle">返回` |
| Loading / Error | 同列表页（`.state` / `.state.error`） |
| Empty | `<div class="empty">未找到该项目。</div>`（`!selectedProject`） |
| 详情 | `<dl class="detail-list">` 5 行：状态（`projectStatusLabel`）、仓库、描述（空值 → 「暂无描述。」）、创建时间、更新时间（均 `formatProjectDate`） |
| 操作 | `<div class="panel action-panel">` + `<h2>操作` + `<button class="button danger">删除项目`（**无 disabled / loading 态**） |

### 3.3 交互清单（全部冻结）

| # | 页面 | 交互 | 行为 |
| --- | --- | --- | --- |
| 1 | 列表 | `onMounted` | `fetchProjects()` |
| 2 | 列表 | 提交表单 | `submitProject()` → `createProject({name, description, repository})`；成功后**清空三个字段**；失败写 `createError` |
| 3 | 列表 | 点击「打开」 | 跳转 `/projects/:id` |
| 4 | 列表 | 点击项目名 | 跳转 `/projects/:id` |
| 5 | 列表 | 点击「删除」 | `window.confirm("确定删除该项目吗？")` → 取消则中止；确认则 `deleteProject(id)`，期间按钮文案变「删除中…」且 disabled |
| 6 | 详情 | `onMounted` | `fetchProject(id)` |
| 7 | 详情 | `watch(projectId)` | 路由参数变化时重新 `fetchProject` |
| 8 | 详情 | 点击「返回」 | 跳转 `/projects` |
| 9 | 详情 | 点击「删除项目」 | `window.confirm` → `deleteProject` → `router.push("/projects")` |

## 4. Loading / Error / Empty / Success

- **分支顺序（两页一致）**：loading → error → empty → content（`v-if / v-else-if / v-else-if / v-else`）。
- **Success**：无 toast、无成功提示 —— 关闭/清空表单 + 列表随 store 更新即为成功反馈。
- 列表页 empty 判定 `projects.length === 0`；详情页 empty 判定 `!selectedProject`（`fetchProject` 失败时 store 会置空 `selectedProject`，因此**错误状态优先于空状态**显示）。
- **创建失败**是页面局部 `createError`（`.state error`），与 store `error` 是两条独立路径。
- 无 Skeleton / 骨架屏；无「部分数据」态。

## 5. Legacy CSS

### 5.1 两个页面实际使用的 legacy 类

`page`、`two-column`、`main-column`、`page-header`、`eyebrow`、`state`、`state error`、`empty`、`project-list`、`project-row`、`project-title`、`row-actions`、`status`、`button primary`、`button subtle`、`button danger`、`form-panel`、`detail-grid`、`detail-list`、`action-panel`、`panel`

### 5.2 仍被其他页面使用（**Phase 5-B 不得删除任何一个**）

| legacy 类 | 除 Projects 外的使用者 |
| --- | --- |
| `.page` / `.page-header` / `.eyebrow` | 其余 9–10 个 View |
| `.two-column` | **仅 ProjectsView**（唯一使用者） |
| `.main-column` | AgentRun、Requirements |
| `.project-list` / `.project-row` / `.project-title` | MCPServersView |
| `.row-actions` | MCPApp、MCPServerDetail、MCPServers |
| `.form-panel` | AgentRun、Deployments、Requirements、Workflows |
| `.detail-grid` | MCPServerDetail |
| `.detail-list` | AgentRun、Agents、Requirements |
| `.action-panel` | **仅 ProjectDetailView**（唯一使用者） |
| `.state` | 其余 8 个 View |
| `.empty` | 其余 10 个 View |
| `.status` | Dashboards、Agents、AgentRun、Requirements、MCPServerDetail |
| `.button` 三变体 | 其余多个 View |
| `.panel` | 其余 8 个 View |

→ 结论：**`styles.css` 本阶段与 Phase 5-B 都不应删除任何内容**（`.two-column` / `.action-panel` 虽为唯一使用者，但保留无害，且删除属于 Phase 11 集中清理范围）。

### 5.3 与 Design Token 的偏差（迁移时需要对齐的点）

| legacy 取值 | 设计 / Token |
| --- | --- |
| `.project-title` 18px / 700 / `#162331` | 设计 §4：Section 15-16 / Card Title 14 → 应取 `--text-section-title`（16/600）或 `--text-card-title`（14/600） |
| `.project-row` 圆角 8px / 边框 `#dde5ee` / 内距 16px | Card：12px / `--border #E8EAF0` / `--card-padding 20px` |
| `.form-panel` 输入框：边框 `#cbd5df` / 圆角 8px / 内距 10px 12px | Input 组件：`--input #E8EAF0` / 10px / `px-3 py-1` + `h-9` |
| `.status` 固定绿（`#e8f6ef` / `#16633d`） | 设计 §11：状态统一用 StatusBadge（按 tone 取语义色） |
| `.detail-list` 行内距 16px 18px、分隔线 `#edf1f5` | 设计 §5 间距刻度 16/20 + `--border` |
| `.button.primary` 蓝 `#1d6fd3` | Primary `#6C5CE7` |
| `.button.danger`（浅红底 + 红边 + 红字） | Button `destructive`（实心 `--danger`）—— 视觉变化需在 5-B 明确记录 |
| `.button.subtle`（`#edf3f8`） | Button `secondary`（`bg-muted`，hover `bg-border`） |

### 5.4 级联风险（Phase 5-B 必须处理）

1. **未分层的 `.form-panel input/select/textarea`**：只要表单容器仍带 `form-panel` 类，这些规则会压过 Input/Textarea 组件的 Tailwind 工具类（未分层恒定优先）。**移除该类即同时消除该规则的影响** —— 这是 5-B 的推荐路径。
2. **全局未分层 `a { color:#1d4f91 }`**：`.project-title`、以及所有被当作按钮用的 `<RouterLink>`（打开 / 返回）都会踩到 → 需按既有手法（AppSidebar / Dashboard 的 scoped 规则）处理，禁用 `!important`。
3. `button, input, select, textarea { font: inherit }`：Phase 3-B 已在 Button/Input/Textarea 组件内用 scoped 规则解决，**复用即可，不要重新发明**。

## 6. Component Gap（只记录，不在本阶段实现）

现有可用：**3-B** Button（default/secondary/destructive/outline/ghost/link × sm/default/lg/icon）、Card（含 6 个子组件）、Badge、Input、Textarea、Label、Separator；**3-C** PageHeader、SectionHeader、StatusBadge、EmptyState。

| 迁移需求 | 现有组件是否够用 | 结论 |
| --- | --- | --- |
| 页面标题 / eyebrow | ✅ PageHeader | 够用（无 actions） |
| 字段列表标题（新建项目 / 操作） | ✅ SectionHeader（level 2） | 够用 |
| 项目行 / 详情信息卡 | ✅ Card | 够用 |
| 状态展示 | ✅ StatusBadge + `projectStatusTone()` | 够用（复用 Phase 4 函数） |
| 空状态 | ✅ EmptyState | 够用 |
| 创建 / 打开 / 返回 / 删除按钮 | ✅ Button 四变体 | 够用 |
| 表单字段 | ✅ Label + Input + Textarea | 够用（需决定 label 关联方式，见 §8） |
| **确认删除对话框** | ❌ 无 Dialog / ConfirmDialog | **仅记录**。当前用原生 `window.confirm` → Phase 5-B **保持原样**，不得新建组件 |
| **Toast / 成功提示** | ❌ 无 | 仅记录；当前无此功能，不得新增 |
| **DataTable** | ❌ 无 | 仅记录。设计 `03-page-layout.md` §5 的 List Page 模板提到 DataTable，但当前列表是卡片行且无列排序/选择需求 → **默认保持卡片列表** |
| **FilterBar / SearchInput / Pagination** | ❌ 无 | 仅记录。后端 `GET /api/projects` 无任何查询参数，前端也无过滤/分页状态 → **不应发明** |
| **Tabs（详情页）** | ❌ 无 | 仅记录。详情页只有一份信息 + 一个操作，无多 tab 数据 |
| **Skeleton** | ❌ 无 | 仅记录。当前 loading 为文字，Phase 5-B 沿用文字（3-C 亦未建 LoadingState） |
| **Form / FormField 容器** | ❌ 无 | 仅记录。用 Card + SectionHeader + Label/Input/Textarea 组合即可覆盖 |

→ **不需要新增任何组件即可完成 Phase 5-B**；`Dialog / DataTable / FilterBar / Pagination / Tabs / Toast / Skeleton / Form` 全部只记录不实现。

## 7. Business Freeze（Phase 5-B 冻结清单）

冻结：
- **API contract**：4 个 endpoint、请求体字段（只发 `name`/`description`/`repository`）、响应结构 `{success,data}`、三条错误文案语义
- **Store**：`stores/projects.ts` 全文（state / actions / 前置插入去重 / 删除后清空选中项）
- **Router**：`/projects`、`/projects/:id` 两条路由、name、导航行为；不新增子路由、不新增 meta
- **权限**：无（也不得新增）
- **业务状态**：`ProjectStatus = "active" | "archived"`（不得改枚举、不得改文案）
- **业务规则**：zod 校验约束（含 `.strict()`）、表单成功后清空、删除前 `window.confirm`、详情页 `watch` 重新拉取、删除后跳回 `/projects`、`fetchProject` 失败置空选中项导致「错误优先于空态」
- **现有交互**：§3.3 的 9 项交互
- **导航行为**：Dashboard ↔ `/projects` ↔ `/projects/:id` 的跳转与返回
- **`formatProjectDate` / `projectStatusLabel` 的输出文案与格式**

允许改动（Phase 5-B）：template、class、layout、视觉结构、组件组合、纯视觉 view helper（**不得**新建 viewmodel 函数 —— `projectStatusTone()` 已存在）。

## 8. Phase 5-B Migration Mapping（计划，未执行）

| Legacy | New | 备注 |
| --- | --- | --- |
| `.page` + `.two-column` + `.main-column` | Tailwind grid（`minmax(0,1fr)` + 360px，gap 24px） | 需保留 ≤900px 折叠为单列的响应式行为（legacy 媒体查询）—— 5-B 需明确用断点类还是接受设计文档的 1024 断点 |
| `.page-header` + `.eyebrow` | `PageHeader`（eyebrow「项目」/ title「项目」，无 actions） | 文案原样 |
| `.state` / `.state.error` | Tailwind `<p>`（`text-muted-foreground` / `text-danger`） | 3-C 无 LoadingState/ErrorState |
| `.empty` | `EmptyState` | 「暂无项目。」/「未找到该项目。」原样 |
| `.project-list` + `.project-row` | Card（或 Tailwind `<ul>/<li>` + border） | 需按设计 §9 使用 12px 圆角 + `--border` + `--card-padding` |
| `.project-title`（18/700） | `--text-section-title`(16/600) 或 `--text-card-title`(14/600) | 明确记录为**设计对齐导致的有意视觉变化** |
| `.row-actions` | Tailwind flex + gap | |
| `.status` | `StatusBadge :tone="projectStatusTone(project.status)"` | 复用现有函数，不重复创建 |
| `.button.subtle`（打开 / 返回） | `Button variant="secondary"`（或 outline） | `<RouterLink>` 用法需 scoped 链接色 |
| `.button.danger`（删除 / 删除项目） | `Button variant="destructive"` | 由浅红描边变为实心红 —— 有意变化 |
| `.button.primary`（创建） | `Button variant="default"` + `type="submit"` | 保持 submit 语义与 loading 文案 |
| `.form-panel` | `Card` + `SectionHeader title="新建项目"` + `Label`/`Input`/`Textarea` + `Button` | 移除 `form-panel` 类可同时解除 §5.4 第 1 条级联风险 |
| 表单 label 关联 | 方案 A：保持 `<Label>` 包裹控件（组件渲染的就是 `<label>`）；方案 B：`for`/`id` | 两者都可行，5-B 需择一并说明（推荐 B，配合 3-C Label 的契约测试） |
| `.detail-grid` + `.detail-list` + `.panel.action-panel` | Card + CardHeader/Title/Content（或 SectionHeader）+ `<dl>` grid 保留 140px/1fr | `dt/dd` 结构与文案原样 |
| `window.confirm` | **保持原生 confirm** | 无 Dialog 组件，且本阶段禁止新增 |

## 9. Risks / Unknowns

**Risks**
1. **级联**：未分层的 `.form-panel input/select/textarea`、`a{color}`、`font:inherit` 三条 legacy 规则会与 Tailwind/组件样式冲突 —— 处理方式见 §5.4；禁用 `!important` 与全局修改。
2. **隐式契约**：`apps/web/src/__tests__/mcpSecurity.test.ts` 会全文扫描 `src/**/*.{ts,vue}`，禁止出现 `localStorage` / `sessionStorage` / `document.cookie` 以及 `access_token` / `password` / `api_key` / `client_secret`（大小写不敏感）等字样 → Phase 5-B 新增代码（含 placeholder、注释）不得引入这些字符串。
3. **无既有页面测试**：目前**没有任何测试覆盖 `ProjectsView` / `ProjectDetailView`**（`grep` 确认）。Phase 5-B 需按 `dashboardView.test.ts` 的方式补页面契约测试；既有 98 例必须全绿。
4. **删除确认的语义**：`window.confirm` 是阻塞式原生弹窗，改动其交互（如换 Dialog）属于行为变化 → 5-B 不换。
5. **响应式断点不一致**：legacy 在 ≤900px 折叠两栏，而设计文档的目标宽度是 ≥1024 —— 需在 5-B 明确取舍（推荐保留折叠行为，避免功能退化）。
6. **按钮视觉变化较大**：`.button.danger`（浅红描边）→ `destructive`（实心红）；`.project-title` 18/700 → 16/600。属设计对齐的有意变化，必须写入 5-B 记录。

**Unknowns**
1. 设计是否要求把该列表改为 DataTable / 是否要求分页 —— 参考图只有首页；后端也无分页参数。**默认：保持卡片列表 + 无分页**。
2. 详情页是否需要 Tabs（设计 §6 模板提到）—— 当前无多 tab 数据源。**默认：不实现**。
3. 创建成功后是否需要 Toast —— 当前无。**默认：不新增**。
4. 是否要在 PageHeader 放置「新建项目」Primary Action（设计 §5 模板建议 PageHeader 带 Primary Action）—— 但当前页面已有常驻创建表单，若再加一个按钮属于**新增交互**。**默认：不加**，保留现有表单位置（此项若需变更，应由下一次阶段指令明确裁定）。

---

**Code changed: NONE**
**API/Store/Router changed: NONE**
**CSS changed: NONE**
**Dependencies changed: NONE**

（本阶段只新增本文档 `docs/72-phase-5-projects-analysis.md`，未触碰任何源码、配置或 `styles.css`。）

按阶段纪律**在此停止**，不进入 Phase 5-B。
