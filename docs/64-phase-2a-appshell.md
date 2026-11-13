# Phase 2-A — AppShell 骨架（实施记录）

> 阶段：Phase 2-A（AppShell 骨架）
> 依据：`docs/design/00-design-system.md`、`02-navigation.md`、`03-page-layout.md`、`docs/ui-reference/ai-se-home.png`、`docs/61-phase-0-ui-refactoring-decisions.md`
> 范围：全局 Shell 骨架；不改业务页面内容、不改 Router/API/Store/ViewModel/SSE/业务逻辑
> 日期：2026-09-15

---

## 1. 新增 / 修改 / 删除文件

### 新增（3）

| 文件 | 说明 |
| --- | --- |
| `apps/web/src/components/layout/AppShell.vue` | 全局骨架：AppSidebar + AppHeader + Main（RouterView） |
| `apps/web/src/components/layout/AppSidebar.vue` | 品牌块 + 8 项一级菜单（含图标与 active 归属） |
| `apps/web/src/components/layout/AppHeader.vue` | 52px 结构骨架（无占位控件，原因见 §3.3） |

### 修改（2）

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/App.vue` | 内联 sidebar（24 行）→ `<AppShell />`（模板 3 行） |
| `apps/web/src/styles.css` | 删除旧 shell 专属 CSS + 对应媒体查询片段（见 §4）；960 行（原 1051 行） |

### 删除（0 个文件）

未删除任何文件；`styles.css` 仅删除已确认零引用的**规则**。

### 依赖（1）

| 包 | 版本 | 位置 | 说明 |
| --- | --- | --- | --- |
| `@lucide/vue` | 1.46.0 | `apps/web` dependencies（精确锁版本） | 仅用于 Sidebar 图标 |

> **包名说明（记录）**：任务书写的是 `lucide/vue-next`。实测：① `@lucide/vue-next` 在 npm **不存在**；② 现存的 `lucide-vue-next@1.0.0` **已被官方标记 deprecated**（registry 元数据原文：*"Package deprecated. Please use @lucide/vue instead."*）。因此按官方指引使用 **`@lucide/vue@1.46.0`**（仍在日更，peer 为 `vue >= 3.0.1`）。这是唯一一处对任务书字面内容的偏离，原因是字面包名不可用/已废弃。

### 依赖安装的连带的非源码变更（记录）

| 文件 | 变化 | 原因 |
| --- | --- | --- |
| `pnpm-lock.yaml` | 新增 `@lucide/vue` 条目 | 安装依赖的必然结果 |
| `pnpm-workspace.yaml` | 自动追加 `minimumReleaseAgeExclude: - '@lucide/vue@1.46.0'` | pnpm 的供应链策略：该包发布时间过新，pnpm 自动登记白名单（非人为修改） |

## 2. AppShell 结构

```
AppShell.vue（<div class="flex min-h-screen bg-background">）
├── AppSidebar.vue      <aside>  w = var(--app-sidebar-width)  → 164px
│   ├── 品牌（AI 标记 + AI-SE）→ RouterLink to="/"
│   └── <nav> 8 × RouterLink（图标 + 文案 + active 归属）
└── <div class="flex min-w-0 flex-1 flex-col">
    ├── AppHeader.vue   <header> h = var(--app-header-height) → 52px
    └── <main class="flex-1 p-[var(--app-main-padding)]"> → 20px 内距
        └── <RouterView />
```

- 布局常量全部来自 Phase 1-B Token（`--app-sidebar-width` / `--app-header-height` / `--app-main-padding`），未出现魔法数字。
- AppShell **不持有任何业务数据**（设计文档 §3 要求），不调用 API/Store/ViewModel。
- 页面内容未做任何包装或改动：业务 View 仍渲染在 `<main>` 内，其自身 `.page` / `.page-header` 结构不变。

## 3. Sidebar / Header 实现

### 3.1 Sidebar（164px，Light）

| 元素 | 实现 |
| --- | --- |
| 容器 | `w-[var(--app-sidebar-width)] shrink-0 border-r border-border bg-card px-3 py-4` |
| 品牌 | 32px 圆角方块 `bg-primary` + `text-caption` 的「AI」+ `text-card-title` 的「AI-SE」 |
| 菜单项 | `flex items-center gap-2.5 rounded-md px-3 py-2`，文案 `text-nav`（14px/500） |
| 图标 | Lucide，`size=16`、`stroke-width=1.75`（符合设计 §12「16-20px、stroke 一致」） |
| 默认态 | `text-muted-foreground`，hover `bg-muted` + `text-foreground` |
| 激活态 | `bg-primary-light` + `text-primary`（设计 §3「active 使用 Primary Light」） |
| active 归属 | **Router 状态驱动**：`isActive(to)` 按路径精确匹配或前缀匹配；详情路由归到所属一级菜单（`/` 仅精确匹配） |

**菜单项与重构前完全一致**（文案 / 顺序 / 路由均未变）：
`仪表盘 /` · `项目 /projects` · `需求 /requirements` · `工作流 /workflows` · `部署 /deployments` · `Agent /agents` · `Agent 运行 /agent-run` · `MCP 服务器 /mcp`

### 3.2 关键实现说明：为什么 Sidebar 需要一段 scoped 样式

**实测发现的问题**：首版全部用 Tailwind 工具类实现后，浏览器实测导航文字颜色为 `rgb(29, 79, 145)`（= `styles.css` 里的旧链接蓝 `#1d4f91`），**而不是** Design Token 的 `--primary` / `--muted-foreground`。

**根因**：`styles.css` 中存在两条**未分层（unlayered）**的全局规则 `a { color:#1d4f91; text-decoration:none }` 与 `a:hover { text-decoration: underline }`。按 CSS 级联层规则，**未分层的普通声明恒定优先于任何 `@layer` 内的普通声明（与特异性无关）**，而 Tailwind 的全部工具类都在 `@layer utilities` 内 ⇒ `text-primary` / `text-muted-foreground` / `no-underline` 在 `<a>` 元素上被整体压过。这正是 `docs/61` 决策 **T2/T3** 所预警的迁移期陷阱，本次在真实浏览器中首次复现。

**处置**（未违反任何约束）：全局 `a` 规则被业务页面共用，本阶段不可删改；因此只在 `AppSidebar.vue` 内加一段 **scoped** 样式，仅为导航/品牌链接重新声明 `color` 与 `text-decoration` 两个属性：

```css
.brand-link[data-v-*] { color: var(--foreground); text-decoration: none; }
.nav-link[data-v-*] { color: var(--muted-foreground); text-decoration: none; }
.nav-link[data-v-*]:hover { color: var(--foreground); text-decoration: none; }
.nav-link--active[data-v-*], .nav-link--active[data-v-*]:hover { color: var(--primary); text-decoration: none; }
```

scoped 属性选择器 **[data-v-*]** 提高了特异性且同为未分层，故可稳定胜出；布局/间距/背景/hover 底色等其余样式仍由 Tailwind 工具类承担。

**修复后实测**（真实浏览器计算样式）：

| 元素 | 修复前 | 修复后 | 期望值（Token） |
| --- | --- | --- | --- |
| 品牌链接/文字 | `rgb(29,79,145)` | **`rgb(31,41,55)`** | `--foreground #1f2937` ✓ |
| 品牌标记「AI」 | — | **`rgb(255,255,255)`** | `--primary-foreground` ✓ |
| 非激活项 | `rgb(29,79,145)` | **`rgb(107,114,128)`** | `--muted-foreground #6b7280` ✓ |
| 激活项（含文字/图标） | `rgb(29,79,145)` | **`rgb(108,92,231)`** | `--primary #6c5ce7` ✓ |
| 激活项底色 | `rgb(240,237,255)` | `rgb(240,237,255)` | `--primary-light #f0edff` ✓ |

> ⚠️ **对后续阶段的影响（记录，非本阶段修复项）**：这条全局 `a { color }` 规则会**影响每一次页面迁移**——任何用 Tailwind 给链接类元素设置文字颜色的写法都会静默失效。可选的收口方式：① 逐处使用 scoped/更高特异性规则（本阶段做法）；② Phase 11 退役 legacy CSS 时删除该全局规则并统一改由 Token 控制。建议在 Phase 3 的组件契约里明确写入处理方式。

### 3.3 Header（52px，Light）

实现为 **结构骨架**：`h-[var(--app-header-height)] border-b border-border bg-card px-5`，**内部无任何控件**。

原因（对齐设计文档与 Phase 0 决策 D9「只实现真实存在的数据和功能」）：

| 设计文档规定的内容 | 当前系统是否有数据源 | 结论 |
| --- | --- | --- |
| Search | 无搜索接口 | 不实现 |
| System Status | 后端有 `/health`、`/ready`，但前端 `api/` 层无对应模块；新增模块=改动 API 层（本阶段禁止） | 不实现 |
| Notification | 无通知系统 | 不实现 |
| User | 无用户/登录体系（前端无权限体系，见 `docs/60` §8） | 不实现 |

按"不新增假数据"的要求，未放置任何占位按钮/头像/输入框。若后续授权，可用**真实**数据源（如 `/health`）补齐状态区——需单独批准 API 层改动。

## 4. Legacy CSS 删除情况

**删除原则**：只删除已用 grep 确认**零引用**的旧 shell 规则；无法确认的一律保留。

| 删除的类 | 引用核查 | 位置 |
| --- | --- | --- |
| `.app-shell` | 仅 `App.vue`（已改为 AppShell） | 基础规则 + 2 处媒体查询 |
| `.sidebar` | 仅 `App.vue` | 基础规则 + 2 处媒体查询 |
| `.brand` / `.brand:hover` / `.brand-mark` | 仅 `App.vue` | 基础规则 |
| `.nav` / `.nav a` / `.nav a.router-link-active` | 仅 `App.vue` | 基础规则 + 2 处媒体查询 |
| `.content` | 仅 `App.vue`（`class="content"` 全仓仅 1 处） | 基础规则 + 2 处媒体查询 |

**保留（易误删项，已确认仍被业务页面使用）**：`.page`、`.page-header`、`.eyebrow`、`.metric*`、`.panel*`、`.two-column`、`.main-column`、`.detail-grid`、`.run-layout`、`.tool-call-*`、`.event-*`、`.deployment-*`、`.workflow-*`、`.project-*`、`.empty`、`.state`、`.status*`、`.button*`、`.form-panel`、`.stacked-form`、`.mcp-*`、`.tab*` —— **全部未改动**。特别地，`.deployment-sidebar` / `.workflow-sidebar` 是**不同**的类，未被误删。

删除量：`styles.css` 1051 → 960 行（−91 行），全部为旧 shell 规则及其媒体查询片段；两个 `@media (max-width:900px)` 块中的**非** shell 规则（`.page`、`.metric-grid`、`.two-column`、`.detail-grid`、`.run-layout`、`.page-header`、`.project-row`、`.row-actions`、`.tool-call-row`、`.event-row`、`.tool-call-meta`）均保留。

**已知行为变化（记录）**：旧 shell 在 ≤900px 时会把侧栏堆叠到内容上方（`.app-shell{display:block}` 等），该规则随旧类一并移除。现在 ≤900px 时侧栏保持 164px 侧向布局。设计文档的 QA 视口矩阵为 ≥1024px，且侧栏「折叠」属 Phase 2-B 范围，故本阶段不新增断点逻辑。

## 5. 是否修改业务 / API / Router / Store / ViewModel

**全部为「否」**：

| 对象 | 结论 | 证据 |
| --- | --- | --- |
| 业务 View（11 个） | 未改动 | mtime 全部为 9 月 14 日或更早 |
| Router | 未改动 | mtime 9 月 11 日 |
| API（7 模块 / 47 函数） | 未改动 | mtime 9 月 11–14 日 |
| Stores（7 个） | 未改动 | mtime 9 月 14 日 |
| ViewModels（8 个） | 未改动 | mtime 9 月 14 日 |
| SSE / 实时通道 | 未改动 | 3 个 store 未触碰 |
| 权限 / 业务逻辑 | 未改动 | 审批、沙箱常量、条件判定函数均未触碰 |
| Token 层（`styles/app.css`） | 未改动 | mtime 仍为 Phase 1-B 的 11:33:41 |
| 菜单 / 路由 / 页面 | 未新增、未删除、未改名 | 8 项菜单与 13 条路由逐项核对一致 |

## 6. 四项门禁

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| Type Check | `corepack pnpm --filter @ai-se/web typecheck` | **PASS**（exit 0） |
| Lint | `corepack pnpm --filter @ai-se/web lint` | **PASS**（exit 0） |
| Test | `corepack pnpm --filter @ai-se/web test` | **PASS**：15 files / 53 tests |
| Build | `corepack pnpm --filter @ai-se/web build` | **PASS**（exit 0；产物 `index-CwzmSDHF.css` 14.69 kB / `index-BI1nq71J.js` 277.24 kB） |

体积：CSS 12.29 → 14.69 kB、JS 271.44 → 277.24 kB（新增 Lucide 图标 + 3 个 shell 组件）。

## 7. 浏览器验证结果

在真实浏览器中对**构建产物**（`vite preview`，端口 5173 = 后端 `CORS_ORIGIN`，因此走真实 API）逐路由实测：

### 7.1 八个一级路由

| 路由 | 挂载 | 菜单项 | 图标 | active | 页面 h1 | 错误态 | 侧栏宽 | Header 高 | Main 内距 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/` | ✓ | 8 | 8 | 仪表盘 | 仪表盘 | 无 | 164px | 52px | 20px |
| `/projects` | ✓ | 8 | 8 | 项目 | 项目 | 无 | 164px | 52px | 20px |
| `/requirements` | ✓ | 8 | 8 | 需求 | 需求 | 无 | 164px | 52px | 20px |
| `/workflows` | ✓ | 8 | 8 | 工作流 | 工作流 | 无 | 164px | 52px | 20px |
| `/deployments` | ✓ | 8 | 8 | 部署 | 部署 | 无 | 164px | 52px | 20px |
| `/agents` | ✓ | 8 | 8 | Agent | 专业 Agent | 无 | 164px | 52px | 20px |
| `/agent-run` | ✓ | 8 | 8 | Agent 运行 | Agent 运行 | 无 | 164px | 52px | 20px |
| `/mcp` | ✓ | 8 | 8 | MCP 服务器 | MCP 服务器 | 无 | 164px | 52px | 20px |

菜单 `href` 序列实测为 `/ , /projects , /requirements , /workflows , /deployments , /agents , /agent-run , /mcp` —— 与重构前完全一致。

### 7.2 详情路由（深链 = 刷新验证）

| 路由 | 直接打开（等同刷新） | 所属菜单高亮 |
| --- | --- | --- |
| `/projects/:id` | ✓ 正常挂载并加载真实数据（Mini Todo） | **项目** ✓ |
| `/workflows/:id` | ✓ | **工作流** ✓ |
| `/deployments/:id` | ✓ | **部署** ✓ |
| `/mcp/:serverId` | ✓ | **MCP 服务器** ✓ |

> 这是 Phase 0 决策 **T8** 的实施结果：此前（重构前实测）这 5 条详情路由**没有任何菜单高亮**，现在归到所属一级菜单。属**纯视觉行为变化**，如不需要可一行回退（把 `isActive` 还原为 `router-link-active`）。

### 7.3 交互与业务功能

- **点击导航**：从 `/` 点击「工作流」→ URL 变为 `/workflows`、h1 变为「工作流」、active 变为「工作流」 ✓
- **业务功能未改变**（以 `/projects` 为例）：`.page-header` 存在、h1=「项目」、双栏 grid 正常（`692px 360px`）、项目行 1 条（Mini Todo）、创建表单与「创建」/「删除」按钮均在、主内容宽度 1116px ✓
- **真实数据链路**：Dashboard / Projects / Requirements / Workflows / Deployments / Agents / AgentRun / MCP 全部无错误态（说明 47 个 API 调用与 3 处 SSE 通道未受影响）✓

### 7.4 记录项（非本阶段修复）

`/mcp/<不存在的 id>` 直接访问时页面显示后端返回的 `Internal server error`（MCP 详情接口对未知 id 的既有响应形态）。属**后端既有行为**，与本次 shell 改动无关；按"不顺手修复"要求仅记录。

## 8. 最终结论

**PASS**

- 四项门禁全绿；8 个一级路由 + 4 类详情路由在真实浏览器中全部正常，菜单/路由/业务功能零改动。
- AppShell 骨架按设计文档落地：侧栏 164px、Header 52px、Main 内距 20px，全部取自 Phase 1-B Token。
- Legacy CSS 仅删除已确认零引用的旧 shell 规则（−91 行），业务页面使用的类全部保留。
- 过程中发现并修复了级联层陷阱（旧全局 `a { color }` 压过 Tailwind 文字色），已记录对后续阶段的影响与两种收口方式。

按阶段纪律**在此停止**，不自动进入 Phase 2-B。
