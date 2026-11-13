# Phase 11-A — Projects UI 视觉重构分析（只读）

> 阶段：Phase 11-A（只读分析；**禁止修改任何代码 / 业务数据**）
> 依据：`docs/design/*`（含 `07-page-layout-patterns.md`：**Projects → Resource Workspace**）、`docs/ui-reference/ai-se-home.png`、`docs/60-frontend-refactoring-assessment.md`、当前 Projects 实现、已完成的 Dashboard（9.5-B）与 MCP（10-B）重构结果
> 结论来自源码 + 设计文档 + 真实运行环境实测；无法验证处标记 `UNKNOWN`。
> 日期：2026-09-15

---

## 1. 当前页面结构（实测）

### 1.1 `/projects`（`ProjectsView.vue`，170 行｜5-B 迁移后）

```
section（max-w-[1180px]，grid：≥900px → 1fr + 360px，<900px 单列，gap 24）
├── 左列：PageHeader（eyebrow「项目」+ h1「项目」，无 actions）
│    ├── p「正在加载项目…」                       ← loading
│    ├── p.text-danger（store.error）             ← error
│    ├── EmptyState「暂无项目。」
│    └── ul > li ×N：Card 行（flex，692×101 @1280）
│         左：RouterLink.project-row-title（14px，Primary）→ /projects/:id
│             + p.repository + span.创建时间
│         右：StatusBadge（projectStatusTone）+ RouterLink「打开」+ Button destructive「删除/删除中…」
└── 右列：Card（360×409 @1280）= 常驻创建表单（SectionHeader「新建项目」+ 3 字段 + createError + 创建按钮）
```

实测：h1 **24px/600**；行卡 **692×101**（radius 12 / `--border`）；表单字段 Input 36px / Textarea 130px / 13px 圆角 10px；`overflowX = 0`；**legacy 命中 0**（114 个类名与 `styles.css` 交集为空）；console 0。

### 1.2 `/projects/:id`（`ProjectDetailView.vue`，108 行｜5-B 迁移后）

```
section（max-w-[1180px]）
├── PageHeader（eyebrow「项目详情」+ h1 = 项目名 ‖「项目」+ actions：RouterLink「返回」）
├── p「正在加载项目…」 / p.text-danger / EmptyState「未找到该项目。」
└── grid（≥900px → 1fr + 280px）
    ├── Card（772×278 @1280）：dl 五行（状态/仓库/描述/创建时间/更新时间），
    │        每行 grid-cols-[140px_1fr]、行高 55px、divide-y
    └── Card（280×116）：SectionHeader「操作」+ Button destructive「删除项目」
```

实测：h1 = 「Mini Todo」；`dt` 宽 140px；5 行值（启用 / 仓库 URL / 测试最小prd实现 / 2026年9月14日 11:04 ×2）；`overflowX = 0`；**legacy 命中 0**（99 个类名交集为空）；console 0。

## 2. API / Store / Router / ViewModel 清单（全部冻结）

| 层 | 内容 |
| --- | --- |
| **API**（`api/projects.ts`，45 行 / 4 导出） | `listProjects()` GET `/api/projects`｜`getProject(id)` GET `/api/projects/:id`｜`createProject(input)` POST｜`deleteProject(id)` DELETE。错误契约：`{success,data}`；网络失败「网络请求失败：无法连接后端服务」；非 JSON「请求失败（HTTP n）」 |
| **Store**（`stores/projects.ts`，65 行） | state：`projects / selectedProject / loading / error`；actions：`fetchProjects`（loading+error 包裹）、`fetchProject(id)`（失败时 **`selectedProject = null`** + error）、`createProject`（**返回新项目并 `[project, ...]` 头插去重**）、`deleteProject`（本地过滤 + 若为 selected 则置 null） |
| **Router** | `/projects`（`projects`）→ `ProjectsView`；`/projects/:id`（`project-detail`）→ `ProjectDetailView`；**13 条路由均无 meta / 守卫 / 懒加载** |
| **ViewModel**（`viewmodels/projectViewModel.ts`，34 行 / 4 导出） | `projectStatusLabel`（启用/已归档）、`projectStatusTone`（success/neutral）、`latestProjects(projects, limit=5)`（**被 Dashboard 消费**）、`formatProjectDate`（zh-CN，年月日时分）。**无未使用导出** |
| 跨页共享 | `useProjectsStore` 被 **Dashboard（9.5-B）与 Projects 两页**共用；`latestProjects` / `projectStatusLabel` / `projectStatusTone` / `formatProjectDate` 被 Dashboard 与 Projects 共用 ⇒ **语义不可改** |
| 页面本地状态 | `creating` / `createError` / `deletingId`（列表）；`projectId` computed + `watch`（详情，**参数变化即重新拉取**） |

**不可改变的业务行为**（13 条页面契约测试锁定，见 §9）：
① `window.confirm("确定删除该项目吗？")`（两页各一处）；② 删除期间 `deletingId` 控制「删除中…」+ disabled；③ 创建成功后**三字段全部清空**、失败写 `createError`；④ 详情删除成功后 `router.push("/projects")`；⑤ loading → error → empty/未找到 → 内容 四分支顺序与条件；⑥ 表单约束：名称 required+maxlength 120+placeholder「AI-SE」、仓库 required+`type=url`+maxlength 500、描述 maxlength 1000+`rows=5`、三字段均 `v-model.trim`；⑦ 详情「暂无描述。」兜底；⑧ 空项目名时标题回退「项目」。

## 3. 现有真实数据可以展示什么

| 数据 | 真实值（本项目唯一数据） | 来源 |
| --- | --- | --- |
| 项目 | **1 条**：`Mini Todo` / 描述「测试最小prd实现」/ 仓库 `https://github.com/goGenger/Mini-Todo.git` / `active` / createdAt = updatedAt = `2026-09-14T03:04:56.701Z` | `GET /api/projects`（列表页与详情页已消费） |
| 该项目的需求 | **2 条**（`ANALYZED`「Todo 管理系统」、`FAILED`「Todo 管理系统」） | `GET /api/projects/:id/requirements`（**当前 Projects 页面未消费**） |
| 该项目的工作流 | **7 条**（`GET /api/workflows` 全部属于该项目：projectId 取值集 = {b55c87fc…}） | 同上，**未消费** |
| 该项目的 Agent 运行 | **57 条中 47 条属于该项目**（其余 10 条无 projectId） | `GET /api/agent-runs`，**未消费** |
| 部署 / 环境 | **0 / 0 条** | `GET /api/deployments`、`/api/environments` |
| 项目字段本身 | `id / name / description / repository / status(active\|archived) / createdAt / updatedAt`（**无** avatars/labels/owner/进度/任务数等字段） | `packages/shared` `Project` 类型 |

**结论**：**仅凭"零新增数据获取"**，Projects 两页可展示的真实信息 = **项目的 7 个字段**（当前已全部展示）。其余关联数据（需求 / 工作流 / Agent 运行）**存在真实数据但需要新的数据获取**，属"新增业务行为"⇒ 列入 §12 的**需授权项**，默认不做。

## 4. 当前 UI 与 Design System 的差异

| # | 项 | 当前实现 | 设计文档 / Dashboard / MCP 现状 | 差异 |
| --- | --- | --- | --- | --- |
| 1 | 列表呈现 | **卡片行**（每行一张 Card，信息左 / 操作右） | `03 §5 List Page`：PageHeader → **DataTable** → Pagination；`07`：Projects = **Resource Workspace**；Dashboard 的「我的项目」已采用**表格**语言 | **主差异**：同类资源用卡片逐行堆叠，密度与扫描性弱于表格 |
| 2 | 列表列信息 | 名称 / 仓库 / 创建时间（**无描述列**） | Dashboard 表格已含**描述列** | 同一资源在两个页面列不一致 |
| 3 | 页面顶部 | `PageHeader`（无 actions） | 列表页模板把 Primary Action 放 PageHeader（搜索/筛选被明令禁止，**不做**） | 当前主操作在右列表单内（可接受：符合 `03 §7 Configuration Page`） |
| 4 | 详情结构 | `PageHeader` + dl 五行 + 独立「操作」Card | `03 §6 Detail Page`：**Breadcrumb → PageHeader → Tabs → Content**；MCP 详情（10-B）已是「状态摘要 + 信息卡 + 分组 dl」 | 详情缺少"资源身份条/信息分组"，且操作以独立 CRUD 卡呈现，**堆叠感**明显 |
| 5 | 详情字段排版 | `dl` 单列（`dt` 固定 140px + `dd`） | MCP 详情用 `dl` **三列自适应**（≥900 三列 / <900 单列） | 两个详情页排版语言不统一 |
| 6 | 状态呈现 | `StatusBadge` + `projectStatusTone` ✅ 已符合 | 设计 §11 要求统一 StatusBadge ✅ | **无差异** |
| 7 | 卡片/间距/排版 | Card 12px 圆角 / `--border` / PageHeader 24px-600 / section-gap 24 ✅ | 与 Dashboard、MCP 一致 ✅ | **无差异** |
| 8 | Breadcrumb | 无 | `02 §8`：详情页可用「项目管理 / Todo 应用 / 项目详情」 | 缺（属可选元素，见 §6） |
| 9 | 响应式 | ≥900 两栏（列表 1fr + 表单 360 / 详情 1fr + 操作 280） | 项目既有约定 ≥900 两栏 | 一致；但 @900 左列被压缩到 **312px / 392px**（见 §8） |
| 10 | 视觉语言 | Token + Tailwind + 3-B/3-C 组件（5-B 已迁移） | 同 ✅ | **无差异**（本次是"布局/信息层级"升级，不是"换组件"） |

**一句话结论**：Projects 两页的**组件与 Token 已达标**，与 Dashboard / MCP 的差距在**布局范式**——列表仍是"卡片行 + CRUD 面板"，详情仍是"字段清单 + 操作卡"，尚未形成 `Resource Workspace`。

## 5. 目标页面信息架构（Resource Workspace）

```
/projects — 资源列表（Resource List）
PageHeader（eyebrow「项目」+ h1「项目」）
Content Card
└── 资源表（表头：项目名称 / 描述 / 仓库 / 状态 / 创建时间 / 操作）
    ├── 行：名称（Primary 链接 → /projects/:id）· 描述（截断/占位「—」）· 仓库（单行截断）
    │        状态（StatusBadge）· 创建时间（formatProjectDate）
    │        操作：打开（secondary 链接按钮）+ 删除（destructive，删除中… + disabled）
    └── 空态：EmptyState「暂无项目。」
右侧（≥900px，360px）Card：新建项目表单（Configuration Page 范式，保持不变）
分支：loading「正在加载项目…」→ error（text-danger）→ EmptyState → 表格（顺序不变）

/projects/:id — 资源详情（Resource Overview）
PageHeader（eyebrow「项目」/「项目详情」+ h1 = 项目名 + actions：返回 + 删除项目）
资源身份条（Card）：名称 + StatusBadge（+ 可选：仓库链接）
信息卡（Card + SectionHeader）：
└── dl 分组（≥900px 三列 / <900px 单列）：仓库 / 描述 / 创建时间 / 更新时间（+ 状态）
分支：loading → error → EmptyState「未找到该项目。」→ 内容（顺序不变）
（可选，需授权）Tabs「概览 / 需求 / 工作流」—— 依赖 §12-A 的授权
```

与 `07-page-layout-patterns.md` 的 **Resource Workspace** 对应关系：资源列表 = 可扫描的资源表；资源详情 = 身份条 + 分组属性；操作（创建 / 删除）保持既有位置与确认语义。

## 6. 列表页布局方案：为什么是「Card 包表（Table）+ 右列表单」而不是纯 Card / 纯 Grid

| 候选 | 评估 |
| --- | --- |
| **纯 Card 列表（现状）** | 优点：与已迁移页面兼容。缺点：同类资源逐行卡片 → 垂直密度低（行高 101px vs 表格 55px）、列信息无法对齐（仓库/时间/状态无法纵向比较）、**与 Dashboard 的「我的项目」表格不一致** |
| 纯 Grid（两列卡片） | 缺点：项目是"条"不是"块"，格网化会放大空白；仍需处理操作区；与 Dashboard 表格更不一致 |
| 混合：**Grid 页面骨架 + Card 包表格** ✅ | 页面骨架沿用现有两栏 grid（列表 1fr + 表单 360px）；列表本体使用**语义 `<table>` 放进 Card**；行高 55px、表头 12px muted、行 hover `--muted`、`overflow-x-auto` + `min-w-[880px]`（窄屏横向滚动，设计 §15 允许） |
| 纯 Table（无 Card） | 缺点：与本项目"卡片语言"（Dashboard/MCP/Deployments 全部 Card 化）不一致 |

**推荐**：**混合方案（Card + 语义 table）**。理由：
1. **一致性**：Dashboard（9.5-B）的「我的项目」已是「Card 包表格 + 55px 行 + hover」——Projects 列表采用同一模式即可让"看板上的项目"与"项目页的项目"形成同一视觉语言；
2. **密度与扫描性**：Resource Workspace 的核心诉求是"可扫描的资源清单"，表格的列对齐（名称/描述/状态/时间）优于卡片行；
3. **零新增能力**：不做搜索/筛选/分页/排序/批量操作；表头仅承载**已有字段**；
4. **零新增组件**：`<table>` + Tailwind（同 Dashboard 9.5-B 已落地的做法），无需 Table 组件（禁止新增）；
5. **业务可保留**：每行「打开 / 删除」两个既有操作原地保留（删除仍走 `window.confirm` 与「删除中…」）。

**列清单（全部来自既有字段，无新数据）**：项目名称（链接）｜描述（`description || "—"`）｜仓库（`repository`，单行截断）｜状态（`StatusBadge` + `projectStatusTone`）｜创建时间（`formatProjectDate(createdAt)`）｜操作（打开 / 删除）。

**明确不做**：FilterBar / Search / Select / Status 筛选 / More Filters / Pagination / 排序 / 列显隐 / 批量操作 / 行内 ⋮ 菜单（设计 §5 的 FilterBar 与 Pagination **一律不实现**，且当前无搜索、筛选、分页 API 与业务）。

## 7. 详情页布局方案

**目标**：从"字段清单 + 操作卡"升级为「资源身份条 + 属性分组」，并与 MCP 详情（10-B）统一。

1. **PageHeader**：`eyebrow` 保留「项目详情」（既有文案）；`h1` = 项目名（回退「项目」）**不变**；actions = 「返回」（既有）+ **「删除项目」**（把独立「操作」Card 的动作收进页头，语义与 `window.confirm` 完全不变）。
2. **资源身份条（Card）**：名称（`--text-section-title`）+ `StatusBadge` +（可选）仓库链接（scoped 链接色，`--break-all`）；与 MCP 详情的"状态摘要卡"同一形态。
3. **信息卡（Card + SectionHeader）**：`dl` 使用**三列自适应**（≥900px 三列 / <900px 单列，`dt` 12px muted + `dd` 14px foreground），字段 = 仓库 / 描述 / 创建时间 / 更新时间（状态已上移身份条，仍在同一卡片语境内）。**字段与兜底文案不变**（「暂无描述。」保留）。
4. **（可选、需授权）Tabs**：设计 §6 的 `Tabs → Content`。若授权消费既有 API（`listRequirements(projectId)` / `listWorkflows()` 等），可呈现「概览 / 需求（2）/ 工作流（7）」；**默认不做**（= 新增数据获取）。
5. **（可选、需授权）Breadcrumb**：「项目 / Mini Todo」——设计 §8 允许；属**新增导航文案**，默认不做（若授权，`eyebrow` 可保留以避免重复）。
6. **不做**：编辑项目（无 API）、归档/恢复（无 API）、复制、更多操作菜单、关联资源的写操作。

## 8. 可复用现有组件与纯函数

| 需要 | 复用 | 说明 |
| --- | --- | --- |
| 页头 | `PageHeader`（`#actions` slot） | 列表/详情均已有；详情新增"删除项目"进 slot |
| 卡片 / 分组 | `Card` + `SectionHeader` | 现有 |
| 状态 | `StatusBadge` + `projectStatusTone` | 现有，**无需新增 tone** |
| 表格 | **原生 `<table>` + Tailwind**（同 Dashboard 9.5-B） | 不新增 Table 组件 |
| 表单 | `Label` / `Input` / `Textarea` / `Button` | 现有（新建项目表单保持原样） |
| 空态 / 错误 / 加载 | `EmptyState` / `text-danger` / `text-muted-foreground` | 现有，文案不变 |
| 链接色级联 | 页面 scoped 类（`.project-*`） | 沿用 5-B 既有手法（全局 `a{color:#1d4f91}` 未分层） |
| 日期 / 标签 | `formatProjectDate` / `projectStatusLabel` | 现有 |

**需要新增的纯视觉 ViewModel / tone：无。** `projectStatusTone` 已覆盖两种状态；列表/详情不需要任何新的派生统计（项目数 1 个数字无需 KPI 卡；不做趋势/计数聚合以避免"无来源统计"）。
（若 §12-A 授权被批准，`requirementStatusTone` / `workflowStatusTone` 已存在于各自的 viewmodel，可直接复用，**同样无需新增**。）

## 9. Responsive 方案

| 断点 | 列表页 | 详情页 |
| --- | --- | --- |
| ≥1280 | 1fr + 360（现状 692/360 @1280） | 单列 + 信息卡内 `dl` 三列 |
| 900–1279 | 同上；表格列宽自适应 | 同上 |
| **900（边界）** | 两栏；**已知问题**：左列被压到 312px（`min-[900px]` 含边界） | 两栏时左卡 392px；改为单列后无此问题 |
| **899 / <900** | 单列：表格在前、表单在后（现状顺序不变）；表格外层 `overflow-x-auto` + `min-w-[880px]`，页面 `overflowX = 0` | 单列；`dl` 单列；页头 actions 换行 |
| 700 | 同上（实测当前 496px 宽无溢出） | 同上 |

- 沿用 `min-[900px]`，**不新增断点**（与 5-B/6-B/7-B/8-B/9-B/9.5-B/10-B 一致）。
- **待裁定项**：@900 左列仅 312px（legacy 断点语义）。11-B 可二选一：① 保持现状（记录为已知边界）；② 把右列表单列宽从 360 调整到 320（**仅视觉**，不影响任何业务）；建议 ②（Detail 页改用单列后不再有同类问题）。
- 表格在 <900 允许横向滚动（设计 §15：Table 必要时横向滚动）✓。

## 10. Business Freeze（Phase 11-B）

- **API**：`api/projects.ts` 4 个导出、endpoint / 方法 / 入参 / 错误契约全部不变；**不新增任何数据获取**（列表仍只 `fetchProjects`，详情仍只 `fetchProject`，且 `watch(projectId)` 行为不变）。
- **Store**：`stores/projects.ts` 全文不变（含 `createProject` 头插去重、`deleteProject` 本地过滤 + selected 置空、`fetchProject` 失败清空 + error 文案）。
- **Router**：2 条路由、`/projects/:id` 深链接与 `watch` 重取行为不变；详情删除后 `router.push("/projects")` 不变。
- **ViewModel**：4 个导出逐字不变（`latestProjects` 被 Dashboard 消费 ⇒ 尤其不得改）。
- **交互**：`window.confirm("确定删除该项目吗？")` 文案与位置不变（**不替换为 Dialog**）；`deletingId` 的「删除中…」+ disabled；`creating` 的「创建中…」+ disabled；创建成功后三字段清空；`createError` 位置（表单内）不变。
- **表单约束**：required / `type="url"` / maxlength 120·500·1000 / `rows=5` / `v-model.trim` / 三个 id（`project-name`、`project-repository`、`project-description`）与 `for` 关联不变。
- **文案**：h1「项目」/「项目详情」、eyebrow、`暂无项目。`、`未找到该项目。`、`暂无描述。`、`正在加载项目…`、按钮「创建 / 创建中… / 打开 / 删除 / 删除中… / 返回 / 删除项目」、字段标签「名称 / 仓库地址 / 描述」全部逐字保留。
- **分支**：loading → error → empty/未找到 → 内容 的顺序与判定条件不变。
- **禁止**：新增页面/路由/API/Store/SSE/polling；新增 Dialog / Toast / Table / Tabs / Drawer / Pagination / Search 组件；修改 `styles.css`、Sidebar、Header、其他页面；新增依赖或 Design Token；为视觉效果增加无数据来源的统计、搜索、筛选或操作；创建任何业务数据。

## 11. 允许 / 禁止修改文件（Phase 11-B）

**允许**
1. `apps/web/src/views/ProjectsView.vue`（template + 页面 scoped 样式；`<script setup>` 仅限 imports 与必要的呈现层绑定）
2. `apps/web/src/views/ProjectDetailView.vue`（同上）
3. `apps/web/src/__tests__/projectsView.test.ts`、`apps/web/src/__tests__/projectDetailView.test.ts`（更新/扩展页面契约测试）
4. `docs/87-phase-11-projects.md`（实施记录）

**禁止**：`api/projects.ts`、`stores/projects.ts`、`router/index.ts`、`viewmodels/projectViewModel.ts`（**除非**分析证明必须新增纯函数 —— 本分析结论：**不需要**）、`styles.css`、`components/**`、`App.vue` / Sidebar / Header、`DashboardView.vue` 及其他任何页面、`package.json`、`pnpm-workspace.yaml`、Design Token（`styles/app.css`）。

## 12. 需授权项（默认不做）

**A. 详情页 Tabs 与关联资源（= 新增数据获取）**
`listRequirements(projectId)` 已存在且是项目级接口（**实测该项目 2 条需求**）；`listWorkflows()` 返回 **7 条且全部属于该项目**；`listAgentRuns()` 57 条中 **47 条属于该项目**。若授权，可在详情页呈现「概览 / 需求（2）/ 工作流（7）」三个 Tab（复用既有 API + 既有 tone 纯函数，仍不改 Store/Router/API）。**未授权则一律不实现**（禁止伪造计数与列表）。

**B. Breadcrumb（新增导航文案）**：`项目 / <项目名>`。

**C. 右列表单列宽 360 → 320（纯视觉）**：用于缓解 @900 左列仅 312px 的挤压。

## 13. 风险与无法验证项

| # | 风险 | 影响 | 应对 |
| --- | --- | --- | --- |
| R1 | **真实数据仅 1 个项目、0 个已归档项目** ⇒ 表格多行、archived tone、长描述截断无法用真实数据验证 | 中 | SSR 契约测试注入多行/长字段；浏览器验证可用 10-B 同款「请求级测试替身」（不落库）或仅验证单行真实数据；**不创建测试数据** |
| R2 | @900 左列压到 312px（legacy 断点语义） | 低 | §9 待裁定项（建议列宽 320）；不新增断点 |
| R3 | 表格化后被质疑"信息密度下降"或"改名换壳" | 低 | 交付说明列清单与理由（§6）；浏览器截图对比 |
| R4 | 误把设计 §5 的 FilterBar / Pagination 一起实现（无 API、无业务） | 中 | §6 明确"不做"清单 + 测试断言页面**不含**搜索/筛选/分页控件 |
| R5 | 误改 Dashboard 依赖的共享 ViewModel（`latestProjects` 等）造成 Dashboard 回归 | 中 | ViewModel 冻结；11-B 结束跑 Dashboard 契约测试 + 浏览器回归 |
| R6 | 删除动作的 confirm 文案/顺序被"顺手优化" | 中 | 冻结 §10；测试断言 `window.confirm` 调用参数（可在测试中注入 stub） |
| R7 | 全局 `a{color:#1d4f91}` 未分层级联 | 低 | 页面 scoped 链接色（5-B 先例） |
| R8 | 表格在窄屏的横向滚动引发"页面横向溢出"误判 | 低 | 断言页面 `overflowX = 0` 且表格外层 `scrollWidth > clientWidth` |
| UNKNOWN | 后端是否有项目级"更新/归档"接口（用于未来的编辑能力） | —— | 本次不涉及；`apps/server/src/routes/projects.ts` 现有 4 个端点（POST 创建 / GET 列表 / GET 详情 / DELETE），**无 PATCH/PUT** ⇒ 无编辑能力 |

## 14. 验收标准（Phase 11-B）

**代码与契约**
1. `typecheck` / `lint` / `test` / `build` 四道门禁全绿（基线：28 files / 206 tests）。
2. `git diff` 层面仅 3 个允许文件被改（2 view + 2 test）＋ 新增 1 篇文档；`api` / `store` / `router` / `viewmodel` / `styles.css` / 组件层 mtime 不变。
3. 页面契约测试新增覆盖：表格结构（表头 6 列）、多行渲染、描述占位、状态 tone、链接目标、行操作、四分支顺序、表单约束、**无搜索/筛选/分页控件**、**无 legacy 类名**。
4. 既有 13 条 Projects 契约测试语义不被削弱（可更新断言细节，但不得删除对业务行为的断言）。

**浏览器（真实后端 + 真实数据）**
5. 1280 / 900 / 899 / 700 四档：`overflowX = 0`；`console` **0 error / 0 warning**。
6. 列表页：表格渲染真实项目 1 行（名称/描述/仓库/状态/创建时间/操作），行高 ≈55px，hover `--muted`；「打开」跳转 `/projects/:id`；「删除」在 `confirm=false` 时**不发请求**、`confirm=true` 时发 DELETE 并移除该行。
7. 详情页：身份条 + 信息卡字段与兜底文案一致；「删除项目」在页头且 confirm 语义不变；删除成功后跳回 `/projects`。
8. 表单：创建成功清空三字段并出现在列表首行（`createProject` 头插）；错误时显示后端原文。
9. **legacy 双通道审计**：两页 DOM 类名 ∩ `styles.css` = `[]`。
10. **回归**：Dashboard 页面（消费同一 store/viewmodel）正常、无 console 报错、`overflowX = 0`。
11. **业务数据零变化**：验证前后 `GET /api/projects` 仍为 1 条（若验证中创建/删除项目，须在报告中如实说明并复原）。

**交付**
12. 输出：修改文件 / 布局变化 / 视觉变化 / 业务冻结确认 / 测试结果 / 浏览器验证结果 / PASS|PARTIAL|FAIL，并落 `docs/87-phase-11-projects.md`。

## 15. 结论

**PASS**（分析完成，可指导 11-B）

- 当前实现：两页结构、4 个 API、1 个 store、2 条路由、4 个 ViewModel 导出、13 条既有契约测试已清点并实测；**component/token 已达标，差距在布局范式**（卡片行 + CRUD 面板 → Resource Workspace）。
- 真实数据边界清晰：**仅项目 7 个字段可在零新增数据获取下展示**；需求 2 / 工作流 7 / Agent 运行 47 存在但需授权（§12-A）。
- 已给出列表（Card + 语义 table 混合，含理由与"不做"清单）与详情（身份条 + 信息分组 + 操作上移）两套方案、组件复用清单、**无需新增 tone/纯函数**的结论、响应式方案、冻结清单、允许/禁止文件、风险与验收标准。

**Code changed: NONE ｜ API / Store / Router / ViewModel / CSS / Dependencies / Business data: NONE**

按阶段纪律**在此停止**，不进入 Phase 11-B。
