# Phase 11-B — Projects UI 视觉重构（实施记录）

> 阶段：Phase 11-B（基于 `docs/86-phase-11-projects-analysis.md` 的实施）
> 依据：`docs/design/*`（含 `07-page-layout-patterns.md`：Projects → **Resource Workspace**）、`docs/86`、`docs/ui-reference/ai-se-home.png`
> 结论：**PASS**
> 日期：2026-09-15

## 1. 修改文件

| 文件 | 变化 |
| --- | --- |
| `apps/web/src/views/ProjectsView.vue` | 170 → **277 行**（PageHeader 通栏 + 左「Card 包语义表格」+ 右 360px 表单） |
| `apps/web/src/views/ProjectDetailView.vue` | 108 → **146 行**（身份 Card + 信息 Card；「删除项目」上移页头） |
| `apps/web/src/__tests__/projectsView.test.ts` | 140 → **231 行**（7 → 11 例） |
| `apps/web/src/__tests__/projectDetailView.test.ts` | 112 → **170 行**（6 → 10 例） |
| `docs/87-phase-11-projects.md` | 本文档 |

**未修改**：`api/projects.ts`（4 导出）、`stores/projects.ts`、`router/index.ts`、`viewmodels/projectViewModel.ts`（4 导出，**无需新增纯函数**）、`styles.css`（960 行 / mtime 11:41）、`components/**`、`DashboardView.vue`、Sidebar/Header、其他页面、`package.json`、Design Token。

## 2. 布局变化

### 2.1 `/projects`
| 项 | Phase 5-B（旧） | Phase 11-B（新） |
| --- | --- | --- |
| 页头位置 | 页头在**左列内部**（与右列表单顶边不对齐：实测表卡 y=152 / 表单卡 y=75） | **PageHeader 通栏**（与 Deployments 同一范式），两列同起点（实测 **150 / 150** ✓） |
| 列表 | `ul` + 每行一张 Card（行高 101px，列无法对齐，无描述列） | **Card 包语义 `<table>`**：表头 6 列（项目名称 / 描述 / 仓库 / 状态 / 创建时间 / 操作），行高 **57px**、表头 12px `--muted-foreground`、行 hover `--muted`、`last:border-b-0`（与 Dashboard 表格同一语言） |
| 仓库列 | 完整 URL 折行 | **单行截断**（`max-width: 140px` + ellipsis，避免撑开列宽挤掉「操作」列） |
| 描述列 | 无 | 新增展示（`description || "—"`，与 Dashboard 表格一致） |
| 操作 | 打开（secondary）+ 删除（destructive），同一行 | 同左（未改动语义），`size="sm"` |
| 右列表单 | 360px Card | **不变**（360px；列宽按要求不做调整） |
| 搜索/筛选/排序/分页/批量 | 无 | **仍无**（测试护栏断言） |

### 2.2 `/projects/:id`
| 项 | Phase 5-B（旧） | Phase 11-B（新） |
| --- | --- | --- |
| 结构 | `PageHeader` + dl 5 行（`dt` 固定 140px）+ **独立「操作」Card**（280px 右栏） | `PageHeader`（actions：返回 + **删除项目**）→ **资源身份 Card** → **信息 Card** |
| 身份 Card | — | 项目名称（16px/600）+ 仓库（单行截断）+ `StatusBadge` |
| 信息 Card | — | `dl`：仓库 / 描述 / 创建时间 / 更新时间；**≥900px 三列 / <900px 单列**（与 MCP 详情同一排版语言） |
| 删除项目 | 独立操作卡 | **上移至页头 actions**（`destructive`），confirm 与跳转语义完全不变 |
| 右栏 | 1fr + 280px 两栏 | 取消右栏（单列全宽），消除 280px 窄栏的 CRUD 面板感 |

**有意变更记录**：① 信息卡字段由 5 个（含「状态」标签行）改为 4 个（状态改由身份 Card 的 `StatusBadge` 承载 —— 任务书指定）；② 身份 Card 与页头同时出现项目名称（页头 h1 = 名称，身份卡 = 资源的可视化身份，符合 Design System §6「Breadcrumb → PageHeader → Tabs → Content」中 Content 首块即资源身份的意图）。

## 3. 视觉变化

- 与 Dashboard（9.5-B）/ MCP（10-B）统一：`PageHeader`（24px/600 + 12px eyebrow）、`Card`（白底 + `--border` + 12px 圆角 + 20px 内距、无阴影）、`SectionHeader`、区块间距 `--section-gap`、栅格 gap 24px。
- 表格：表头 12px/600 `--muted-foreground`、行高 57px、`--border` 行分隔、hover `--muted`、名称 Primary 链接（scoped 色，实测 `rgb(108,92,231)`）、仓库「—」/截断占位、`StatusBadge` 语义色（启用 `#ECFDF5/#059669`、已归档 `neutral`）。
- 未使用 `!important`、未新增 Token、无渐变/阴影新体系、Light only。

## 4. 业务冻结确认

| 项 | 状态 |
| --- | --- |
| API / Store / Router / ViewModel | **零改动**（mtime 核对：`api/projects.ts` 9-14、`stores/projects.ts` 9-14、`router/index.ts` 9-11、`projectViewModel.ts` 14:11） |
| 数据获取 | **未新增**：列表仍只 `fetchProjects()`，详情仍只 `fetchProject(id)` + `watch(projectId)`；未消费 Requirements / Workflows / Agent Runs |
| 删除语义 | **实测**：`confirm=false` → `confirm` 收到原文「确定删除该项目吗？」且 **0 次 DELETE**；`confirm=true` → `DELETE /api/projects/:id`（列表页与详情页各验证一次）；详情删除后 `path` = `/projects` ✓ |
| 创建语义 | **实测**：`POST /api/projects` 载荷 `{"name":"新项目 X","description":"描述内容","repository":"https://github.com/example/x.git"}`（三项 **trim** 生效）、成功后三字段清空、新行出现在列表**首行**（`createProject` 头插） |
| 分支 | `loading → error → empty/未找到 → 内容` 顺序与文案不变（测试 + 浏览器双向验证） |
| 表单约束 | required / `type="url"` / maxlength 120·500·1000 / `rows=5` / 三个 id 与 `for` 关联 / `v-model.trim` **全部保留**（测试断言） |
| 未新增 | 搜索 / 筛选 / 排序 / 分页 / 批量操作 / Tabs / Breadcrumb / Dialog / Toast / 新组件 / 新依赖 / 新 Token / SSE / polling |
| 业务数据 | **未创建、未删除任何真实数据**：CRUD 行为验证使用**请求级测试替身**（浏览器内拦 `fetch`，仅返回合成响应，不落库）；验证前后 `GET /api/projects` 均为 **1 条**（Mini Todo）✓ |

## 5. 测试结果

```
typecheck  PASS
lint       PASS
test       PASS  28 files / 214 tests（206 → 214；Projects 两页 13 → 21 例）
build      PASS  dist/assets/index-F3fDny7o.css 40.33 kB (gzip 7.57)
                 dist/assets/index-2ZmQ_XSr.js  341.83 kB (gzip 104.95)
```

体积变化（相对 10-B 基线）：CSS 39.49 → **40.33 kB（+0.84）**；JS 341.49 → **341.83 kB（+0.34）**。

新增/更新断言覆盖：6 列表头、多行渲染（7 行全渲染、无分页）、描述占位、仓库截断类、状态 tone、目标链接、行操作计数、四分支顺序与 `not.toContain("<table")`、表单约束、**无搜索/筛选/排序/批量控件**、**无 Tabs/Breadcrumb**、**legacy 类名护栏**（两页各 11 个 token）、详情页头同时含「返回」与「删除项目」且位于 `<header>` 内、`dl` 单一结构、三列 scoped 结构。

## 6. 浏览器验证结果（:5173 真实后端）

| 检查 | 实测 |
| --- | --- |
| `/projects` @1280（真实 1 行） | 表头 6 列 / 12px `rgb(107,114,128)` / 600；**行高 57px**；单元格：`Mini Todo` / `测试最小prd实现` / 仓库（220→140px 截断，`clipped: true`）/ 启用 / `2026年9月14日 11:04` / 打开+删除；名称链接 `rgb(108,92,231)`；行 hover `rgb(248,249,252)`；表头与表卡 y 均 **150**（与表单卡对齐）；**表格内不出现滚动**（client 690 = scroll 690，「操作」列与按钮可见）；页面 `overflowX = 0` |
| @900 / @899 / @700 | 页面 `overflowX = 0`；@900 两栏（312+360）、@899/700 单列；表格外层 `overflow-x: auto` 生效（client 310/693/494 < scroll 640），**页面不横向溢出** |
| 2 行替身 | 行分隔线 1px（首行）/0（末行，`last:border-b-0` 设计）；行高 57/57；空描述「—」 |
| `/projects/:id` @1280/900/899/700 | `dl` **≥900 三列 / <900 单列**；字段 = 仓库/描述/创建时间/更新时间；身份卡 = 名称+仓库+启用；页头 actions = 返回 + 删除项目；`overflowX = 0`；两页各 2 张 Card |
| 创建链路 | POST 载荷 trim 正确、字段清空、新行首行可见 |
| 删除链路 | confirm=false → 0 DELETE；confirm=true → DELETE + 行移除；详情删除 → `path=/projects` |
| Dashboard 回归 | `/` h1「仪表盘」、KPI `1/1/0/就绪`、表格 1 行真实数据、`overflowX = 0`、console 空（共享 store/viewmodel 无回归） |
| legacy 审计（双通道） | `/projects` 120 个 DOM 类名、`/projects/:id` 90 个 → 与 `styles.css` 全部类选择器交集 = **`[]`**；`styles.css` 未改动 |
| console | 全部轮次 **0 error / 0 warning** |

**修复的两处真实缺陷（浏览器实测发现）**：① 初版表格 `min-w-[880px]` 在 1280 下超出左列（690px），导致**「操作」列被滚动出可视区**；改为 `min-w-[640px]` + 仓库截断 140px + 单元格 `pr-3` 后，1280 下 6 列全部可见且无内滚动。② 初版页头仍在左列内，右列表单顶边高于表格卡（75 vs 152）→ 页头改通栏后两卡对齐（150/150）。

## 7. 风险与验证限制

| # | 项 | 说明 |
| --- | --- | --- |
| R1 | 真实数据仅 **1 个项目、0 个已归档项目** | 多行、archived tone、空描述行只能由 SSR 契约测试与**请求级替身**验证；**未创建任何测试数据** |
| R2 | @900 左列仅 312px（legacy 断点语义，任务书要求表单保持 360px） | 表格在该宽度下横向滚动（`overflow-x: auto`），页面 `overflowX = 0` ✓；如需消除可后续调整列宽（本阶段按要求不动） |
| R3 | 视口高于内容时底部留白 | 内容高度由数据量决定（1 行表格 + 445px 表单）；未以占位内容填充 |
| R4 | `last:border-b-0` 使单行时无行下边框 | 与 Dashboard 表格完全一致（同一模式），非缺陷 |
| 限制 | 未验证项 | 触屏/真实移动端；>5 行时的表格滚动与列宽表现（仅 2 行替身验证过）；项目详情删除后列表重新加载的竞态（浏览器实测正常） |

## 8. 结论

**PASS** —— Projects 两页完成 Resource Workspace 结构性重构（列表 = Card 包 6 列资源表 + 360px 配置表单；详情 = 身份卡 + 信息卡，操作上移页头）；与 Dashboard / MCP 视觉语言统一；API / Store / Router / ViewModel / 业务规则 / 文案 / confirm 语义零改动；未新增任何数据获取或组件；四道门禁全绿；浏览器 1280/900/899/700 全部 `overflowX = 0`、console 0；**legacy 命中 0**；Dashboard 回归正常；真实业务数据未被人为改动（CRUD 行为经请求级替身验证）。

**Code changed: ONLY `ProjectsView.vue` + `ProjectDetailView.vue` + 2 个测试文件（+ 本文档）**
**API / Store / Router / ViewModel / CSS / Dependencies / Business data: NONE**

按阶段纪律**在此停止**，不进入 Phase 12。
