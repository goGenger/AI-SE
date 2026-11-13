# Phase 9.5-A — Dashboard 视觉重构分析（只读）

> 阶段：Phase 9.5-A（Dashboard 与参考图的视觉/布局差异分析；**禁止修改任何代码**）
> 依据：`apps/web/src/views/DashboardView.vue`、Dashboard 相关 API/Store/ViewModel、`docs/design/*`、`docs/ui-reference/ai-se-home.png`、`docs/60`–`docs/82`
> 结论来自源码 + 设计文档 + **参考图像素级测量** + **真实运行环境实测**；无数据/不确定处标记 `UNKNOWN`。
> 日期：2026-09-15

> ⚠️ **文件编号说明**：任务书要求 `docs/82-phase-9.5-dashboard-visual-analysis.md`，但 **`docs/82` 已被 `docs/82-phase-10-mcp-analysis.md`（Phase 10-A）占用**，故写入下一个连续编号 **`docs/83-phase-9.5-dashboard-visual-analysis.md`**（与前几阶段的处理一致）。

---

## 1. 当前 Dashboard 结构

| 项 | 事实 |
| --- | --- |
| 文件 | `apps/web/src/views/DashboardView.vue`（**111 行**，Phase 4 迁移后版本） |
| 数据来源 | **仅** `useProjectsStore`（`GET /api/projects`）；`onMounted → fetchProjects()` |
| ViewModel | `latestProjects`（按 `createdAt` 倒序取 5 条）、`projectStatusLabel`、`projectStatusTone`；（`formatProjectDate` 已存在但**本页未使用**） |
| 组件 | `PageHeader`、`Card`、`SectionHeader`、`StatusBadge`、`EmptyState`、`buttonVariants`（RouterLink 借用按钮外观） |
| 结构 | ①`PageHeader`（eyebrow「阶段 0」+ h1「仪表盘」+ 主操作「新建项目」→ `/projects`）② **3 张指标卡**（项目总数 / 启用中的项目 / 基础能力=「就绪」）③ `loading → error → empty → 最新项目 Card`（列表行 = 项目名链接 + 状态徽标，「查看全部」→ `/projects`） |
| legacy 残留 | **0**（Phase 4 已完全脱离，实测 `.page/.metric/.panel/.compact-list` 命中数均为 0） |
| 页宽 | `max-width: none`（Phase 4 依设计 §11「Dashboard 充分利用屏幕」移除 1180 上限） |

**实测基线**（view 1280 / 真实数据 1 个项目）：

```
h1「仪表盘」24px/600；eyebrow「阶段 0」
内容宽 1076px（= 1280 − 侧栏 164 − 主区内距 40），max-width none
指标区 grid-cols-3（348px × 3），卡高 106px，数值 28px/600 → 1 / 1 / 就绪
列表卡：1 行「Mini Todo 启用」，行高 22px（紧凑）
section gap 24px；overflowX 0；console 干净
```

## 2. PNG 结构（参考图）

**测量数据**（`ai-se-home.png`，**1842 × 854**，1x；canvas 像素扫描，卡片描边色检测）：

| 区域 | 位置（px） | 尺寸 |
| --- | --- | --- |
| 侧栏 | x 0 → **180** | 180 宽 |
| 内容区 | x **196 → 1820** | **1624 宽**（左右内距 ≈16 / 22px） |
| 顶栏 | y 0 → **≈52** | ≈52 高（与 `--app-header-height 52px` 一致） |
| **Hero / Welcome Banner** | y ≈52 → **165** | ≈110 高，内容区通栏 |
| **Quick Actions（4 卡）** | y ≈170 → **305** | ≈135 高，4 列通栏 |
| **Statistics / KPI（4 卡）** | y ≈311 → **435** | ≈122 高，4 列通栏 |
| **中部三栏带** | y ≈445 → ≈700 | 列边界 x≈196→970 / **984→1508** / **1518→1820** ⇒ **≈58% / 22% / 20%** |
| **我的项目（表格）** | y ≈710 → 画面底部（被裁切） | 6 列，列边界 x≈196/360/536/…/1676/1820 |
| 页面底色 | `#f6f7fa`（≈ `--background #f6f7fb`） | — |
| Hero 底色 | `#f3f3fe ~ #f6f7fe`（极浅薰衣草紫 ≈ `--primary-soft #f7f5ff`） | — |
| 卡片 | 白底 + 1px 浅灰描边 + 圆角 ≈10–12px + 内距 ≈16–20px，**几乎无阴影** | — |

**内容区结构（自上而下）**：

```
Hero / Welcome Banner（通栏，薰衣草底）
├── 左：图标块 + 「欢迎使用 AI-SE ✨」+ 副标题 + 4 个能力标签（AI 需求规划 / 自动化测试 / 智能体 / 代码生成）
└── 右：深色面板「Agent Run #102 · 已完成」+ 任务 / 耗时 / 结果 三行  ← 数据面板
Quick Actions（4 列卡）
├── 新建项目（**实心紫卡**，标题+描述+箭头）
├── 启动工作流 / 访问代码仓库 / 查看使用指南（白卡，图标+标题+描述+箭头）
Statistics（4 列 KPI）
└── 项目总数 3 / 进行中 2 / 已完成 12 / 失败任务 1，每卡含图标 + 数值 + 趋势脚注（↑2 本月）
中部三栏带（58% / 22% / 20%）
├── 当前工作流：状态胶囊 + 「查看全部」+ 高亮子面板（标题/副标题/进度条 5/12 · 42%）
│                + 5 步纵向 stepper（需求分析 ✓ / 任务拆解 ✓ / 开发中 ● / 测试 ○ / 部署 ○ + 时间）
├── 最近动态：5 行 feed（彩色圆形图标 + 事件标题 + 描述 + 相对时间）
└── 系统状态（API/数据库/Redis/Docker 各带「正常」徽标）
    + 最近部署（✓/✕ + 版本号 + 环境 chip + 时间）
我的项目（表格）
└── 表头 项目名称 / 描述 / 最新工作流 / 状态 / 创建时间 / 操作；3 行数据；行高 ≈52–56px；操作列为 ⋮ 菜单
```

**与 Design System 的一致性（重要）**：该结构**并非 PNG 独有**，`docs/design` 已明确规定：
- `03-page-layout.md §4`：`Welcome Banner → Quick Actions → Statistics → Main Dashboard Grid → Project Table`，核心区域 = `Current Workflow / Recent Activity / System Status / Recent Deployments`；
- `03-page-layout.md §12`：`Current Workflow: 60-65%`、`Recent Activity: remaining`（实测 PNG 为 58% / 22% / 20%，**吻合**）；
- `06-visual-qa.md §4`：首页检查顺序 `Welcome → Quick Actions → Statistics → Workflow → Recent Activity → System Status → Deployments`；
- `00-design-system.md §15`：`Dashboard Grid 自动换行 / Quick Actions 自动换行 / Table 必要时横向滚动`。
⇒ **PNG 是既有设计规范的视觉化，而不是新规范**；冲突点只在"内容层"（数据源），不在"结构层"。

## 3. 差异矩阵

| # | 区域 | 当前 Dashboard | PNG / 设计规范 | 差异等级 | 可实施性 |
| --- | --- | --- | --- | --- | --- |
| 1 | 页面顶部 | `PageHeader`（eyebrow+h1+主操作） | **Welcome Banner**（无独立 PageHeader；主操作「新建项目」并入 Quick Actions 首卡） | 布局（中） | ✅ 可实施（纯视觉重排；h1 文案保留） |
| 2 | Hero 左侧 | 不存在 | 欢迎标题 + 副标题 + 4 能力标签 | 结构（高） | ⚠️ 结构可做；**副标题/标签为新增静态文案 → 需授权** |
| 3 | Hero 右侧 | 不存在 | 深色「Agent Run #102」数据面板 | 结构（高） | ❌ **数据不可得**（Dashboard 无 agent run 数据源） |
| 4 | Quick Actions | 不存在（只有页头 1 个入口） | 4 张快捷入口卡（含 1 张实心紫卡） | 结构（高） | ✅ 可实施（**导航入口**；目标路由已存在，用现有菜单标签即可） |
| 5 | Statistics | **3 列**普通卡，无图标、无趋势 | **4 列** KPI（图标块 + 大数值 + 趋势脚注） | 布局（中） | ⚠️ 4 列可做（项目总数/启用中/已归档/基础能力）；**趋势脚注无数据 → 不做** |
| 6 | 中部三栏带 | 不存在 | 当前工作流(58%) + 最近动态(22%) + 系统状态/最近部署(20%) | 结构（高） | ❌ **三块均无数据源**（详见 §6） |
| 7 | 我的项目 | 「最新项目」**列表卡**（行高 22px、2 列信息） | **6 列表格**（名称/描述/最新工作流/状态/创建时间/操作，行高 52–56px） | 布局（高） | ⚠️ 可升级为 **4 列真表格**（名称/描述/状态/创建时间）；「最新工作流」「操作」列无数据/无组件 → 不做 |
| 8 | 卡片视觉 | `Card`（白底 + `--border` + 12px 圆角 + 20px 内距），无阴影 | 同（白底 + ≈10–12px 圆角 + 16–20px 内距，几乎无阴影） | 一致 | ✅ 无需改动（现组件已符合） |
| 9 | 信息密度 | 首屏仅 3 卡 + 1 列表（垂直使用 <400px） | 首屏 5 个区块（hero + 快捷 + KPI + 三栏带 + 表格），信息密度高 | 密度（高） | ⚠️ 只能部分达成（受 §6 数据限制） |
| 10 | 顶栏（Shell） | 空骨架（Search/Status/Notification/User 未实现） | 搜索框 / 系统运行正常 / 通知铃 / 用户簇 | — | ❌ **Phase 2-C 已决策不实现**（无数据源），不在本阶段范围 |
| 11 | 侧栏宽度 | 164px（`--app-sidebar-width`） | 实测 **180px** | 差异（16px） | ❌ **Phase 2-B 已冻结**（依据同图精确测量 + Token），不在本阶段范围 |
| 12 | 页宽 | `max-width: none`（充分利用屏幕） | 通栏 | 一致 | ✅ 无需改动 |

## 4. 新 Dashboard 布局草图（基于 §1–§3 的可实施上限）

> 目标：在不新增数据源、不新增业务功能的前提下，把**结构**推进到设计规范/PNG 的形态；无数据区块**明确不实现**（不占位、不伪造）。

```
┌────────────────────────────────────────────────────────────────────────┐
│ Welcome Banner（Card，通栏，bg-primary-soft 浅紫底）                      │
│  ┌── 图标块（primary）  ┌── eyebrow「阶段 0」（caption，muted）            │
│  │                     ├── h1「仪表盘」24px/600（保留既有标题）            │
│  │                     └── 副标题（可选，静态文案 → 需授权）               │
│  │  ┌ 能力标签 ×4（可选，静态文案 → 需授权）                              │
│  └─ 右侧：主操作 Button「新建项目」→ /projects（原 PageHeader 的 actions）  │
├────────────────────────────────────────────────────────────────────────┤
│ Quick Actions（4 列卡；≥1440 4 列 / ≥900 2 列 / <900 1 列）               │
│  [项目管理(实心 primary)]  [需求]  [工作流]  [部署管理]                    │
│   ↑ 标签与路由沿用既有侧栏菜单，不新增文案/路由                             │
├────────────────────────────────────────────────────────────────────────┤
│ Statistics / 项目数据概览（4 列 KPI 卡；图标块用现有 tone 背景 Token）      │
│  [项目总数 N]   [启用中的项目 N]   [已归档项目 N]   [基础能力 / 就绪]        │
│   ↑ 全部由已获取的 projects 派生或既有静态项；无趋势脚注                     │
├────────────────────────────────────────────────────────────────────────┤
│ 我的项目（Card + SectionHeader「我的项目 · 共 N 个项目」+「查看全部」→/projects）│
│  ┌ 语义 <table>（Tailwind 样式；<900 外层 overflow-x-auto）               │
│  │ 项目名称 | 描述 | 状态 | 创建时间                                       │
│  │ Mini Todo | 测试最小prd实现 | [启用] | 2026年9月14日 11:04              │
│  └ 数据 = latestProjects(projects)（上限 5，沿用既有）                     │
├────────────────────────────────────────────────────────────────────────┤
│ Loading / Error / Empty 分支（沿用既有文案与顺序）                          │
└────────────────────────────────────────────────────────────────────────┘

【明确不实现（无数据源，禁止伪造）】
  · Hero 右侧「Agent Run #102」深色数据面板
  · 中部三栏带：当前工作流（进度条 + stepper）/ 最近动态（feed）/ 系统状态 / 最近部署
  · KPI 趋势脚注（↑2 本月）
  · 表格「最新工作流」列与「操作」⋮ 菜单
  · 顶栏搜索 / 系统健康 / 通知 / 用户簇（Phase 2-C 已决策）
```

**为什么是"重新布局"而非"替换组件"**：① 页面主标题从「页头行」迁移到「Hero 区块」，主操作从页头迁移到 Hero 右侧/Quick Actions（信息层级改变）；② 指标区 3 → 4 列且引入图标块与信息分组；③ 列表卡 → 语义表格（列结构、行高、对齐方式全变）；④ 新增两个结构性区块（Hero、Quick Actions）。仅替换组件无法达成。

## 5. 每个区域的数据来源

| 区域 | 数据 | 来源 | 状态 |
| --- | --- | --- | --- |
| Hero：h1 / eyebrow | 「仪表盘」「阶段 0」 | 既有页面文案（Phase 4 冻结） | ✅ 现有 |
| Hero：主操作 | 「新建项目」→ `/projects` | 既有链接目标 | ✅ 现有 |
| Hero：副标题 / 能力标签 | 静态文案 | **当前代码中不存在** | ⚠️ 需授权（纯视觉/静态文案） |
| Quick Actions | 4 个导航入口 | `AppSidebar` 既有菜单标签 + 既有路由 | ✅ 现有（无需新数据） |
| KPI 1 项目总数 | `projects.length` | projects store | ✅ 现有 |
| KPI 2 启用中的项目 | `projects.filter(status === 'active').length` | projects store | ✅ 现有（既有实现） |
| KPI 3 已归档项目 | `projects.filter(status === 'archived').length` | projects store | ⚠️ 同源派生（与 KPI 2 同性质，需确认是否新增） |
| KPI 4 基础能力 | 静态「就绪」 | **既有代码中已存在**（无数据源） | ✅ 保留（不做假数据化） |
| 我的项目：名称/描述/状态/创建时间 | `name / description / status / createdAt` | projects store（`Project` 类型字段） | ✅ 现有（`formatProjectDate` 已存在） |
| 我的项目：最新工作流 | 真实工作流进度 | 需 workflows API（Dashboard 当前未获取） | ❌ 本阶段不做（= 新增数据获取） |
| 我的项目：操作 ⋮ | 行内菜单 | 无组件、无 Dashboard 行内操作 | ❌ 本阶段不做 |
| 中部三栏带 / Hero 右侧 / 趋势脚注 | 见 §6 | — | ❌ 不做 |

## 6. 可实现 / 不可实现内容

**A. 可直接实施（不新增数据源与业务功能）**
1. Hero/Welcome Banner 区块（页头信息迁移 + 浅紫底 + 主操作右置）
2. Quick Actions 4 列导航卡（目标路由已存在）
3. Statistics 由 3 列改 4 列（项目总数 / 启用中 / 已归档 / 基础能力）
4. 「我的项目」由列表卡升级为 4 列语义表格（名称/描述/状态/创建时间），上限仍 5 条
5. 全部既有状态分支（loading/error/empty）与文案
6. 响应式：KPI/Quick Actions 4→2→1 列、Hero 在窄屏纵向堆叠、表格横向滚动

**B. 需先授权（否则不做）**
1. Hero 副标题与 4 个能力标签（新增静态文案）
2. Hero 右侧数据面板 / 中部三栏带 / 趋势脚注 —— 需要**新增 Dashboard 数据获取**（复用既有 API：`workflows`(7 条真实)、`deployments`(**0 条**)、`agent-runs`(57 条)），属**新增业务行为**，与"不新增业务功能"约束冲突；单列 TODO 供裁定
3. 将「已归档项目」计入 KPI（同源派生，需确认是否视为新增逻辑）
4. 表格列扩展（「最新工作流」需工作流数据；「操作」需新组件）

**C. 不可实现（无数据源且禁止伪造）**
1. **最近动态**：无任何活动/事件流 API（`UNKNOWN`：是否存在可复用的审计接口 —— 未在 `api/*` 中发现）
2. **系统状态（API/数据库/Redis/Docker）**：控制台未暴露健康检查 API（后端有 `/health`，但接入 = 新增业务行为）
3. **当前工作流进度/stepper**：Dashboard 未获取工作流数据；进度语义（5/12 · 42%）需任务级数据
4. **最近部署**：`GET /api/deployments` 实测 **0 条**（即使获授权也无内容可渲染）
5. **KPI「已完成 12 / 失败任务 1」**：需任务/部署聚合数据（本项目 `ProjectStatus` 仅有 `active|archived`）
6. **表格「操作」⋮ 菜单**：无行内操作业务、无 DropdownMenu 组件（禁止新增）
7. **顶栏 4 项控件**（Phase 2-C 已决策不实现）

**纯视觉元素（不承载数据，可自由实现）**：Hero 底色/圆角/内距、图标块（`@lucide/vue` 既有依赖）、Quick Actions 首卡实心 Primary、KPI 图标类型、卡片分组与间距、表格表头样式、hover/focus 态。

## 7. 组件复用方案

| 需要 | 复用 | 说明 |
| --- | --- | --- |
| Hero 容器 | `Card` | 用 `bg-primary-soft` 覆盖背景（Token 已存在，**不新增 Token**） |
| 区块标题 | `SectionHeader` | 「快速开始」「项目数据概览」「我的项目」 |
| 页标题（Hero 内） | 直接使用 h1 + eyebrow 排版类 | `PageHeader` 在 Dashboard 被 Hero 取代（Dashboard 专属，符合设计 §4）；**其他页面继续用 PageHeader** |
| Quick Actions 卡 | 原生 `<RouterLink>` + Tailwind（首卡 `bg-primary`） | 项目无 `as-child` 能力 ⇒ 保留 RouterLink 语义（同 5-B/9-B 既有做法），**不新增组件** |
| KPI 卡 | `Card` + `text-metric` + `Badge`/图标块 | 不新增 MetricCard（与 6-B/7-B/8-B/9-B 一致） |
| 状态徽标 | `StatusBadge` + `projectStatusTone` | 既有 |
| 表格 | **原生 `<table>` + Tailwind 类**（外层 `overflow-x-auto`） | 项目无 Table 组件；设计 §15 允许"Table 必要时横向滚动"；**不新增组件** |
| 链接色 | 页面 scoped 类（`.dashboard-*`） | 沿用 Phase 4 既有手法对抗全局 `a{color}` |
| 空/错误/加载 | `EmptyState` + Tailwind 文本行 | 既有 |

## 8. 视觉细节改造点

1. **层级**：h1 由「页头行」迁入 Hero（24px/600 不变）；Hero 内 eyebrow 12px muted；区块标题统一 `--text-section-title` 16px/600。
2. **KPI**：图标块 40×40 + 12px 圆角，背景用现有 tone Token（`--primary-light` / `--info-bg` / `--neutral-bg`）；数值 `text-metric` 28px/600；标签 `--text-secondary` 13px muted。
3. **Quick Actions**：首卡 `bg-primary` + 白字（对齐 PNG 的实心紫卡）；其余 `Card` + hover `--muted`；卡内左图标 + 标题 + 箭头（`ChevronRight`，`@lucide/vue` 既有依赖）。
4. **Hero**：底 `--primary-soft`、1px `--border`、`--radius-lg`、内距 `--card-padding`；主操作使用 `Button`（default）。
5. **表格**：表头 `--text-caption` 12px muted + 下边框；行高 ≥48px（`py-3`）、行间 `border-t border-border`、hover `bg-muted`；首列项目名为 Primary 链接（scoped 色）。
6. **间距**：区块间 `--section-gap` 24px；卡内 20px；栅格 gap 16px（与 PNG 的 16–20px 一致）。
7. **禁止**：新增设计 Token、渐变/阴影新体系、页面自建 Header/Sidebar/Card 变体（设计 §15 约束）。

## 9. 响应式方案

| 断点 | Hero | Quick Actions | KPI | 表格 |
| --- | --- | --- | --- | --- |
| ≥1440 | 左信息 + 右操作同排 | `grid-cols-4` | `grid-cols-4` | 全列显示 |
| 1280 / 1024 | 同上 | `grid-cols-4` | `grid-cols-4` | 全列显示 |
| ≥900（设计下限） | 同排（紧凑） | `grid-cols-2` | `grid-cols-2` | 全列显示 |
| <900 | 纵向堆叠（信息 → 操作） | `grid-cols-1` | `grid-cols-1` | 外层 `overflow-x-auto` + `min-w-[720px]`（设计 §15 允许横向滚动） |

- 依据：`00-design-system.md §15`（Dashboard Grid 自动换行 / Quick Actions 自动换行 / Table 必要时横向滚动）与既有 5 个已迁移页的「≥900 / <900」约定保持一致。
- 沿用既有断点写法 `min-[900px]:…`；**不引入新断点**。

## 10. 业务冻结边界（Phase 9.5-B）

- **API**：`api/projects.ts` 不变；**不新增任何 API 调用**（Dashboard 仍只 `fetchProjects`）
- **Store**：`stores/projects.ts` 不变（`projects / loading / error` + `fetchProjects`）
- **Router**：不新增路由；既有链接目标不变（`/projects`、`/projects/:id`）
- **ViewModel**：`latestProjects`（**上限 5 与排序不变**）、`projectStatusLabel`、`projectStatusTone` 语义不变；如新增派生计数须为**纯函数且不改既有函数**
- **分支**：`loading → error → empty` 顺序与三处文案（「正在加载项目…」「暂无项目。」+ 错误原文）逐字不变
- **文案**：既有业务文案逐字保留（含「阶段 0」「仪表盘」「项目总数」「启用中的项目」「基础能力」「就绪」「最新项目」/「查看全部」；若采用 PNG 区块名「我的项目」属**页面文案**变更 → 需授权）
- **不新增**：功能、开关、搜索/筛选、Dialog/Toast/Skeleton/Tabs/Dropdown/Table 组件、SSE、polling、依赖、设计 Token
- **不创建**：任何测试业务数据（当前真实数据 = 1 个项目，KPI 将显示 1 / 1 / 0 / 就绪）

## 11. Phase 9.5-B 修改范围（建议）

**允许**
1. `apps/web/src/views/DashboardView.vue`（template + 页面 scoped 样式；`<script setup>` 仅允许调整 **imports** 与必要的行内派生计数）
2. `apps/web/src/__tests__/dashboardView.test.ts`（更新/扩展：Hero、Quick Actions、KPI 4 列、表格 4 列、链接目标、分支、冻结文案）
3. 如经授权需要新的纯展示函数：`viewmodels/projectViewModel.ts` **仅新增**（例如 `projectCounts`），既有 4 个导出不改

**禁止**：其他任何文件（含 `styles.css`、`components/**`、其他页面）、任何 API/Store/Router 改动、任何新组件/依赖/Token。

**建议任务书明确裁定 4 项**：① Hero 是否取代 PageHeader（推荐：是，h1 保留「仪表盘」）；② 是否允许新增静态文案（欢迎副标题 / 能力标签 / 区块名「快速开始」「项目数据概览」「我的项目」）；③ Quick Actions 的 4 个入口取哪 4 条（推荐：项目管理 / 需求 / 工作流 / 部署管理，标签沿用侧栏）；④ KPI 第 3 张是否使用「已归档项目」（同源派生）；⑤ 表格是否改为语义 `<table>`（推荐：是）。

## 12. 风险与验证限制

| # | 风险 | 影响 | 应对 |
| --- | --- | --- | --- |
| R1 | **真实数据仅 1 个项目**（workflows 7 / deployments 0 / agent-runs 57 均未被 Dashboard 使用）⇒ 首屏多数区块只能呈现空/单行 | 高 | 明确记录；SSR 契约测试注入多项目造数（测试内，不落库） |
| R2 | 参考图大量内容**无数据源**，若为"还原度"而加占位/假数据 | **极高（违规）** | §6 明确"不实现清单"；9.5-B 验收断言"页面不得出现未在 §6-A 列出的区块" |
| R3 | 页头改 Hero 影响 a11y（h1 位置/层级）与全站一致性 | 中 | Hero 内保留 `h1`（唯一）+ eyebrow；其他页面不动 |
| R4 | Quick Actions 与侧栏菜单语义重复（可能被视为"新增功能"） | 中 | 仅做**导航**，标签/目标完全沿用既有菜单，不新增文案或路由 |
| R5 | 表格化后行高/密度改动引发"信息密度不足"的复核意见 | 低 | 表格固定 4 列 + 行高 ≥48px；与 PNG 一致 |
| R6 | 全局 `a{color}` 级联（Hero 主操作、Quick Actions、表格行） | 低 | 页面 scoped 色（Phase 4 既有手法） |
| R7 | 「基础能力 = 就绪」是无数据源的静态项 | 低 | 原样保留（不美化、不删除、不伪造） |
| R8 | 与 Design System 冲突：Dashboard 是否仍需 `PageHeader` | 中 | 设计 §4 明确 Dashboard 以 Banner 起首 ⇒ 属规范内差异；在 9.5-B 报告中记录 |
| R9 | 侧栏宽度差异（PNG 180 vs Token 164） | 低 | 已冻结（Phase 2-B），本阶段仅记录 |
| R10 | SSR 测试无法覆盖真实交互（hover/focus/横向滚动） | 中 | 9.5-B 浏览器复核 + 渲染探针（同 9-B 手法） |

**验证限制（明确）**：本阶段未创建任何业务数据；9.5-A 的所有结论基于 1 条真实项目 + 7 条真实工作流等**既有数据规模**；PNG 内容区中 **约 45%（按面积）的区域无数据源**，其视觉呈现**不可能在本项目当前数据条件下验证**。

## 13. 结论

**PASS**

- 已产出：当前结构（源码 + 实测）、PNG 结构（视觉解析 + **像素级测量**）、差异矩阵（12 项）、新布局草图、逐区域数据来源、可实现/需授权/不可实现三级清单、组件复用方案、视觉细节改造点、响应式方案、业务冻结边界、9.5-B 范围与需裁定项、风险矩阵与验证限制。
- 关键结论：**结构层可对齐设计规范/PNG（Hero + Quick Actions + 4 列 KPI + 表格），内容层受"无数据源"硬约束**；凡无数据源区域一律不实现、不伪造；9.5-B 可在**不新增任何数据获取**的前提下显著提升首屏结构与信息层级。
- 待用户裁定 5 项（§11）后即可进入 9.5-B。

**Code changed: NONE** ｜ **API changed: NONE** ｜ **Store changed: NONE** ｜ **Router changed: NONE** ｜ **CSS changed: NONE** ｜ **Dependencies changed: NONE** ｜ **Business data changed: NONE**

（本阶段只新增本文档 `docs/83-phase-9.5-dashboard-visual-analysis.md`。）

按阶段纪律**在此停止**，不进入 Phase 9.5-B。
