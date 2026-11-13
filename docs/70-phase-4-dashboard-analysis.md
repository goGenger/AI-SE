# Phase 4 — Dashboard 现状分析与业务功能冻结清单

> 本文件在**修改任何代码之前**产出（Phase 4 第 3、4 节要求）。
> 所有结论均来自对当前代码的实测，未使用推测。

---

## 1. 页面定位

| 项目 | 实测值 |
| --- | --- |
| View 文件 | `apps/web/src/views/DashboardView.vue`（56 行，1810 字节） |
| Route | `{ path: "/", name: "dashboard", component: DashboardView }`（`router/index.ts:17`） |
| route meta | **无**（全项目 13 条路由都没有 meta / 守卫 / 懒加载） |
| Store | `useProjectsStore`（`stores/projects.ts`，Pinia options API） |
| ViewModel | `viewmodels/projectViewModel.ts` |
| Composable | **无**（项目内不存在 `composables/` 目录） |
| 组件 | **无**（迁移前该页面不使用任何子组件） |

## 2. 数据（全部为真实数据，无 mock）

| 来源 | 内容 |
| --- | --- |
| API | `GET /projects` → `api/projects.ts` 的 `listProjects()` |
| 调用路径 | `onMounted` → `projectsStore.fetchProjects()` → `listProjects()` → `projects[]` |
| Store 状态 | `projects`、`loading`、`error`（经 `storeToRefs` 解构） |
| ViewModel | `latestProjects(projects, limit = 5)`（按 `createdAt` 倒序取前 5）、`projectStatusLabel(status)`（`active` → 启用，其余 → 已归档） |
| computed | **无**（页面没有 `computed`，筛选在模板内联完成） |
| props | **无** |
| local state | **无**（没有 `ref` / `reactive`） |

> 备注：`projectViewModel.ts` 还导出 `formatProjectDate`，但 **Dashboard 未使用**（本次迁移也不引入）。

## 3. 当前 UI 元素清单

| 类别 | 实测存在 | 具体内容 |
| --- | --- | --- |
| page header | ✓ | `<header class="page-header">` + `.eyebrow`「阶段 0」+ `<h1>`「仪表盘」+ 右侧 `<RouterLink class="button primary" to="/projects">`「新建项目」 |
| metric | ✓ | `.metric-grid` 内 3 个 `.metric`（`<span>` 标签 + `<strong>` 数值）：项目总数 = `projects.length`；启用中的项目 = `projects.filter(status === "active").length`；基础能力 = 固定文案「就绪」 |
| section | ✓ | 1 个 `.panel-header`：`<h2>`「最新项目」+ 右侧 `<RouterLink to="/projects">`「查看全部」 |
| card | ✓ | `.panel`（白底 + 1px 边框 + 8px 圆角 + 20px 内距） |
| list | ✓ | `.compact-list` 的 `<ul>`，每项 `<li>` = 项目名 `<RouterLink :to="/projects/:id">` + 状态 `<span>` 文本 |
| status | ✗ **页面未使用 `.status` / `.status-error` / `.status-pill`** | 状态是**纯文本** `<span>{{ projectStatusLabel(project.status) }}</span>`（无任何状态样式） |
| empty state | ✓ | `<div class="empty">暂无项目。</div>` |
| loading | ✓ | `<p class="state">正在加载项目…</p>` |
| error | ✓ | `<p class="state error">{{ error }}</p>`（`error` 来自 Store） |
| button | ✗ | 页面内**没有 `<button>`**；两个操作都是 `<RouterLink>`（沿用 legacy `.button` 类） |
| link | ✓ | 3 处：新建项目、查看全部、每个项目名 |
| 其它交互元素 | ✗ | 无表格、无分页、无弹窗、无下拉、无搜索、无 Tab |

## 4. 现有交互（全部必须保留）

1. `onMounted` 时触发一次 `projectsStore.fetchProjects()`（页面加载即拉取真实数据）
2. 点击「新建项目」→ 跳转 `/projects`
3. 点击「查看全部」→ 跳转 `/projects`
4. 点击任一项目名 → 跳转 `/projects/:id`（详情路由）
5. 加载中 / 失败 / 空数据三种分支的展示

> Dashboard **没有**创建、删除、刷新按钮（这些操作在 `/projects` 页面上），迁移时不新增。

## 5. 业务功能冻结清单（Freeze）

**冻结（不得改动）**：API endpoint（`GET /projects`）、请求参数、响应处理、Pinia store（`stores/projects.ts` 全文）、route / route meta / 权限、SSE、business state、computed business logic（`latestProjects`、`projectStatusLabel` 的既有语义）、上述 5 项交互、导航行为、后端状态枚举（`ProjectStatus`）。

**本阶段允许改动**：template、class、layout、visual structure、component composition，以及**纯视觉的 view helper**。

## 6. Legacy CSS 依赖与删除边界（§14/§15）

Dashboard 使用的 legacy 类**全部仍被其它页面使用**，因此 `styles.css` 本阶段**零改动**：

| legacy 类 | 除 Dashboard 外的使用者 | 能否删除 |
| --- | --- | --- |
| `.page` | 其余 10 个 View | ✗ 不能 |
| `.page-header` / `.eyebrow` | 其余 10 个 View | ✗ 不能 |
| `.metric-grid` / `.metric` | AgentRun、Agents、Requirements | ✗ 不能 |
| `.panel` / `.panel-header` | 其余 8–9 个 View | ✗ 不能 |
| `.empty` | 其余 10 个 View | ✗ 不能 |
| `.state` | 其余 8 个 View | ✗ 不能 |
| `.compact-list` | MCPApp、MCPServerDetail | ✗ 不能 |

**结论**：本阶段只让 Dashboard 脱离这些类，不做任何全局删除。`styles.css` 保持 960 行不变。

## 7. 参考图与本页面的关系（§5/§20）

对 `docs/ui-reference/ai-se-home.png`（1842×854）做像素实测：

- 侧栏分隔线 x = **178**；主内容左边界 x = **198** → 主区内距 **20px**（= `--app-main-padding` ✓）
- 卡片右边界出现在 x ≈ **1817**，即右侧留白同样约 20px → **参考图的主内容区没有任何 max-width 上限，铺满整个主区**
- 同一行同时存在 3–4 个并排卡片（x ≈ 198–595 / 617–983 / 1001–1384 / 1522+），列间距约 16–24px

→ 因此 Dashboard 迁移时移除 legacy `.page { max-width: 1180px }` 有据可依（设计文档 `03-page-layout.md` §11「Dashboard 充分利用屏幕」+ 参考图实测），并**不是**引入新的数值体系。

参考图中大量区域（欢迎 Banner、Quick Start、Activity、System Status、AI Assistant 等）**在当前 Dashboard 没有真实数据来源**，按 §5 一律**不实现**。

## 8. 迁移映射（本阶段实际会发生的）

| Legacy | New | 说明 |
| --- | --- | --- |
| `.page-header` + `.eyebrow` | `PageHeader`（3-C） | 文案「阶段 0」/「仪表盘」原样保留 |
| `.button.primary`（RouterLink） | `buttonVariants()` + scoped 链接色（3-B + 2-A 手法） | §16 允许；legacy 未分层 `a{color}` 需 scoped 规则 |
| `.metric-grid` / `.metric` | Card（3-B）+ Tailwind grid | 数值与标签文案不变 |
| `.panel` | `Card` | 语义确为 Card（白底 + 边框 + 圆角 + 内距） |
| `.panel-header` | `SectionHeader`（3-C） | `<h2>` → `SectionHeader` 的 `h2`；「查看全部」进 actions |
| `.compact-list` | Tailwind `<ul>` | 无对应组件（结构过薄，不抽象） |
| `.state` / `.state.error` | Tailwind `<p>` | 3-C 未建 LoadingState / ErrorState，且 §18 禁止新增组件 |
| `.empty` | `EmptyState`（3-C） | 文案「暂无项目。」原样保留 |
| 状态纯文本 `<span>` | `StatusBadge`（3-C）+ 新增纯函数 `projectStatusTone()` | 页面原本无状态样式；设计文档 §11 要求状态统一使用 StatusBadge |

## 9. 组件缺口检查（§18）

Dashboard 迁移所需组件：PageHeader ✓（3-C）、SectionHeader ✓（3-C）、StatusBadge ✓（3-C）、EmptyState ✓（3-C）、Card ✓（3-B）、Button variants ✓（3-B）。
**不需要** DataTable / Dialog / Dropdown / Tabs / Form / Pagination / FilterBar / Toast → **无需新增组件，无需停止**。
