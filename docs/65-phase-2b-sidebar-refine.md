# Phase 2-B — Sidebar 精修（实施记录）

> 阶段：Phase 2-B（Sidebar 精修）
> 依据：`docs/design/00-design-system.md`、`02-navigation.md`、`03-page-layout.md`、`04-component-system.md`、`docs/61-phase-0-ui-refactoring-decisions.md`、`docs/ui-reference/ai-se-home.png`、`docs/64-phase-2a-appshell.md`
> 范围：仅 Sidebar 视觉精修；不改菜单/路由/active 判定逻辑、不进入 Header / PageContainer / 业务页面 / UI 组件
> 日期：2026-09-15

---

## 1. 修改 / 新增文件

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| **修改（唯一）** | `apps/web/src/components/layout/AppSidebar.vue` | 模板 class 精修 + scoped 样式注释补全；`<script setup>` 内容（菜单数组、`isActive`）**逐字未变** |
| 新增 | 无 | — |
| 删除 | 无 | — |
| `styles.css` | **未修改**（mtime 仍为 Phase 2-A 的 11:41:13） | 本阶段不需要任何 legacy 调整 |
| `AppHeader.vue` / `AppShell.vue` | 未修改（mtime 仍为 Phase 2-A） | — |

## 2. Sidebar 做了什么

参考图先做了**像素级实测**（不是目测），再按"Design System > UI Reference > styles.css"落值。

### 2.1 参考图实测值（作为精修目标）

| 项 | 实测方法 | 结果 |
| --- | --- | --- |
| 侧栏右分隔线 | 逐列暗线扫描 | x ≈ 179（宽于设计 164，按设计取 164） |
| 菜单文字行 | 逐行暗像素统计 | 8 行，行距（pitch）**≈ 32.9px** |
| active 药丸 | 淡紫像素范围 | y 54–86 → **高 33px**；x 8–167 → 左右内距 **8px**、**半径 ≈ 6–8px** |
| 图标列 | 行内暗像素列范围 | x 22–37 → **左缘 22px、宽 16px** |
| 图标↔文字间距 | 图标右缘到文字左缘 | **≈ 6px** |
| 品牌标记 | 饱和紫色块包围盒 | 26×27px，左缘 x=20、y 8–34（中心 y=21） |
| 品牌文字「AI-SE」 | 暗像素包围盒 | 宽 32px、字高 9px → 约 **12–13px** |
| 品牌区与 Header 关系 | 行扫描 | y=53 的分隔线**不跨越侧栏**；菜单从 y=54 开始 → 品牌区与 Header 同高对齐 |

### 2.2 落地实现（全部 Tailwind + Phase 1-B Token）

```
<aside>  w=var(--app-sidebar-width)=164px · bg-card(=#FFFFFF) · border-r border-border(=#E8EAF0)
├── 品牌区 <div> h=var(--app-header-height)=52px，px-2 → 与 Header 同高分带（新增）
│   └── RouterLink.brand-link（px-3.5）: 标记 size-7(28px) rounded-md bg-primary + 文字 text-secondary(13px)+font-semibold
└── <nav> px-2 py-1，gap-0.5(2px)
    └── 8 × RouterLink.nav-link：px-3.5(14px) py-1.5(6px) rounded-md gap-1.5(6px)
        ├── <Icon> size=16 stroke-width=1.75 shrink-0
        └── <span> text-nav(14px/500) truncate
```

### 2.3 与 Phase 2-A 的差异（本次精修改动）

| 项 | Phase 2-A | Phase 2-B | 依据 |
| --- | --- | --- | --- |
| 品牌区高度 | 无固定高度（仅 asdie py-4 内边距） | **52px 分带**，与 Header 同高对齐 | 参考图实测（品牌与 Header 同带、菜单从 y=54 起） |
| 品牌标记 | 32px（`size-8`） | **28px**（`size-7`），圆角 10px | 参考图实测 26px + 设计圆角体系 |
| 品牌文字 | 14px/600（`text-card-title`） | **13px/600**（`text-secondary` + `font-semibold`） | 参考图实测 ≈12–13px |
| 菜单项高度 | 36.3px | **32.3px**（`py-1.5`） | 参考图实测药丸 33px |
| 菜单项间距 | 4px（`gap-1`） | **2px**（`gap-0.5`） | 参考图实测 pitch 32.9px |
| 菜单项左右内距 | 12px（`px-3`） | **14px**（`px-3.5`）+ nav `px-2` ⇒ 图标左缘 **22px** | 参考图实测图标左缘 22px |
| 图标↔文字间距 | 10px | **6px** | 参考图实测 6px |
| 品牌标记左缘 | 20px | **22px**（与菜单图标同列对齐） | 参考图实测 20 vs 22 → 取对齐 |
| 焦点样式 | 无 | **新增 `focus-visible:ring-2 ring-ring`** | 设计 `02-navigation.md` §11 明确要求「Focus：可见 focus ring」 |
| 判定逻辑 / 菜单 | — | **完全未变** | 阶段硬性要求 |

### 2.4 交互状态（全部实测）

| 状态 | 实现 | 浏览器实测值 |
| --- | --- | --- |
| 默认（非激活） | `text-muted-foreground` | `rgb(107,114,128)` = `--muted-foreground #6B7280` ✓ |
| hover | `hover:bg-muted` + scoped `color: var(--foreground)` | `bg rgb(248,249,252)` = `--muted #F8F9FC`、`color rgb(31,41,55)` = `--foreground #1F2937`、`text-decoration: none`（**真实鼠标悬停**经 CDP 触发，`a.matches(':hover') === true`） |
| active | `bg-primary-light` + scoped `color: var(--primary)` | 底色 `rgb(240,237,255)` = `--primary-light #F0EDFF`、链接/文字/图标 `rgb(108,92,231)` = `--primary #6C5CE7` ✓ |
| focus-visible | `focus-visible:ring-2 ring-ring` | `:focus-visible` 命中，box-shadow = `rgb(108,92,231) 0 0 0 2px`，`outline-style: none` ✓ |
| 图标 | Lucide，统一 16px / stroke 1.75 | 8/8 图标一致，`stroke-width="1.75"` ✓ |

### 2.5 关于 scoped 样式

保留 Phase 2-A 引入的 scoped 规则（仅为 `.brand-link` / `.nav-link` / `.nav-link--active` 声明 `color` 与 `text-decoration`），原因仍是 `styles.css` 中未分层的全局 `a { color:#1d4f91 }` 与 `a:hover{text-decoration:underline}` 恒压过 `@layer utilities` 里的 Tailwind 文字色。**未使用 `!important`，未引入 layering hack，未修改任何全局 legacy 规则**；其余样式（布局/间距/背景/圆角/焦点环）全部由 Tailwind 工具类承担，符合阶段约束。

## 3. 是否修改 Legacy CSS

**否。** `apps/web/src/styles.css` 本阶段**零改动**（mtime 仍为 Phase 2-A 的 11:41:13，行数仍为 960）。侧栏所需的一切样式都由 Tailwind + Token 与组件内 scoped 规则完成。

## 4. 是否修改业务 / API / Router / Store / ViewModel / SSE

**全部为「否」**：

| 对象 | 状态 | 证据（mtime） |
| --- | --- | --- |
| Router | 未改动 | 9 月 11 日 |
| API（7 模块） | 未改动 | 9 月 11–14 日 |
| Stores（7 个） | 未改动 | 9 月 14 日 |
| ViewModels（8 个） | 未改动 | 9 月 14 日 |
| SSE / 实时通道 | 未改动 | 未触碰 3 个 store |
| 业务 View（11 个） | 未改动 | 9 月 14 日或更早 |
| App.vue / AppHeader.vue / AppShell.vue / main.ts / vite.config.ts / package.json / styles/app.css | 未改动 | 均为前序阶段时间戳 |
| 菜单（8 项）/ 顺序 / 文案 / route / active 判定 | 未改动 | `navItems` 与 `isActive` 逐字对比一致 |

## 5. typecheck / lint / test / build

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `corepack pnpm --filter @ai-se/web typecheck` | **PASS**（exit 0） |
| lint | `corepack pnpm --filter @ai-se/web lint` | **PASS**（exit 0） |
| test | `corepack pnpm --filter @ai-se/web test` | **PASS**：15 files / 53 tests |
| build | `corepack pnpm --filter @ai-se/web build` | **PASS**（`index-CuFat2lW.css` 16.81 kB / `index-Cw5exa_s.js` 277.42 kB） |

## 6. 浏览器验证结果

在真实浏览器中对**构建产物**（`vite preview`，端口 5173 = 后端 `CORS_ORIGIN`，走真实 API）验证：

### 6.1 八条一级路由

| 路由 | 挂载 | 侧栏宽 | 菜单项 | active | 页面 h1 | 错误态 |
| --- | --- | --- | --- | --- | --- | --- |
| `/` | ✓ | 164px | 8 | 仪表盘 | 仪表盘 | 无 |
| `/projects` | ✓ | 164px | 8 | 项目 | 项目 | 无 |
| `/requirements` | ✓ | 164px | 8 | 需求 | 需求 | 无 |
| `/workflows` | ✓ | 164px | 8 | 工作流 | 工作流 | 无 |
| `/deployments` | ✓ | 164px | 8 | 部署 | 部署 | 无 |
| `/agents` | ✓ | 164px | 8 | Agent | 专业 Agent | 无 |
| `/agent-run` | ✓ | 164px | 8 | Agent 运行 | Agent 运行 | 无 |
| `/mcp` | ✓ | 164px | 8 | MCP 服务器 | MCP 服务器 | 无 |

「错误态 = 无」同时说明**真实 API 链路正常**（47 个 API 调用与 3 处 SSE 通道路径未受影响）。

### 6.2 详情路由（深链 = 刷新验证）

| 路由 | 挂载 | active 归属 | 期望 |
| --- | --- | --- | --- |
| `/projects/<真实 id>` | ✓（渲染真实数据） | 项目 | 项目 ✓ |
| `/workflows/abc` | ✓ | 工作流 | 工作流 ✓ |
| `/deployments/abc` | ✓ | 部署 | 部署 ✓ |
| `/mcp/abc` | ✓ | MCP 服务器 | MCP 服务器 ✓ |
| `/mcp/abc/app` | ✓ | MCP 服务器 | MCP 服务器 ✓ |

### 6.3 尺寸/样式实测汇总

侧栏宽 **164px**、底色 `rgb(255,255,255)`、右边框 `1px rgb(232,234,240)`；品牌分带 **52px**、标记 **28px**（左缘 **22px**）、品牌文字 **13px/600 `#1F2937`**；菜单项 **32.3px 高 × 147px 宽**、圆角 10px、内距 `6px 14px`、行距 **34.3px**；图标 **16px**、左缘 **22px**、stroke **1.75**、图标↔文字 **6px**；文字 **14px/500**；Main 内距 **20px**。

## 7. 视觉差异与遗留问题

### 7.1 与参考图的有意差异（均按"Design System > UI Reference"取舍）

| 项 | 参考图 | 实现 | 原因 |
| --- | --- | --- | --- |
| 侧栏宽度 | ≈179px | **164px** | 设计文档 §8 明确 164px（优先级更高） |
| 菜单项行距 | ≈32.9px | **34.3px** | 项高取参考图 32.3px，另留 2px 间隔；164px 宽下紧贴会导致 hover 底色视觉粘连 |
| 药丸圆角 | ≈6–8px | **10px** | 设计圆角体系里 10px 属 "Default 8-10px" 段（不新造 8px token） |
| 品牌标记 | 26px | **28px** | 设计无该尺寸规定；28px 兼顾参考图与 `size-7` 标准刻度 |
| 品牌分带 | 品牌中心 y=21 | 52px 分带内居中（中心 y=26） | 用 Token `--app-header-height` 对齐 Header，避免引入无来源的 42px 魔数 |
| 底部「AI 助手」卡片 | 有 | **不实现** | 该功能在当前系统不存在（不新增业务功能/假数据） |
| 图标字形 | 各自风格 | 8 个 Lucide 语义化图标 | 参考图图标无法逐像素比对；按设计 §12「统一 16-20px / 单一图标体系 / stroke 一致」执行 |

### 7.2 遗留问题（记录，非本阶段修复）

1. **全局 `a { color }` 陷阱仍在**：侧栏已用 scoped 规则隔离开，但该未分层规则仍会影响**后续所有页面迁移**中"给链接类元素设文字色"的 Tailwind 写法。收口方式二选一：逐处 scoped，或 Phase 11 退役 legacy CSS 时删除该全局规则。
2. **窄屏行为**：≤900px 时侧栏保持 164px 侧向布局（旧 shell 的堆叠规则已随 Phase 2-A 删除）。设计 §6 的 Sidebar 折叠属后续阶段，本阶段未新增断点逻辑。
3. **Header 仍为空骨架**：设计规定的 Search / System Status / Notification / User 四项在当前系统无数据源（详见 `docs/64` §3.3），Phase 2-B 未涉及。
4. **active 判定为纯视觉行为变化**：详情路由高亮所属一级菜单（Phase 0 决策 T8），重构前这 5 条路由无任何高亮；如需回到原行为，只需把 `isActive` 换回 RouterLink 默认 class。

## 8. 结论

**PASS**

Sidebar 精修完成：宽度 164px、Light Theme、`border-right`、品牌分带与 Header 对齐、菜单项 32.3px/行距 34.3px、图标 16px/1.75 统一、active/hover/focus 三态均经真实浏览器实测符合 Token 值；菜单、顺序、文案、route、active 判定逻辑与所有业务/API/Router/Store/ViewModel/SSE **零改动**；Legacy CSS **零改动**；四项门禁全绿。

按阶段纪律**在此停止**，不自动进入 Phase 2-C。
