# Phase 2-C — Header + Main/PageContainer 精修（实施记录）

> 阶段：Phase 2-C（Header 与 Main/PageContainer 视觉精修）
> 依据：`docs/design/00-design-system.md`、`02-navigation.md`、`03-page-layout.md`、`docs/61-phase-0-ui-refactoring-decisions.md`、`docs/ui-reference/ai-se-home.png`、`docs/64`、`docs/65`
> 范围：仅 AppHeader 与 Main/PageContainer；不进入业务页面与 UI 组件
> 日期：2026-09-15

---

## 1. 修改 / 新增文件

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| **修改** | `apps/web/src/components/layout/AppHeader.vue` | 水平内距改为共用页面内距 Token、移除无意义的 `gap-4`、补全设计依据注释；结构仍为 52px 空骨架 |
| **修改** | `apps/web/src/components/layout/AppShell.vue` | Main 增加 `min-w-0` 与显式 `bg-background`；补全"Main = PageContainer 职责"的说明 |
| **新增** | **无** | 按"优先调整现有结构"的要求**未新建 `PageContainer.vue`**（理由见 §3） |
| 删除 | 无 | — |
| 未改 | `AppSidebar.vue`（11:53:54，Phase 2-B）、`styles.css`（11:41:13，Phase 2-A）、`main.ts`、`vite.config.ts`、`package.json`、`styles/app.css` | — |

## 2. Header 做了什么

### 2.1 落地结构（全部 Tailwind + Phase 1-B Token）

```html
<header class="flex h-[var(--app-header-height)] shrink-0 items-center
               border-b border-border bg-card px-[var(--app-main-padding)]"></header>
```

| 项 | 实现 | 依据 |
| --- | --- | --- |
| 高度 | `h-[var(--app-header-height)]` = **52px** | 设计 §8 / `02-navigation.md` §9；参考图实测下边框位于 y≈53 |
| 下边框 | `border-b border-border` = 1px `#E8EAF0` | 同上；参考图实测边框亮度与 `--border` 同量级 |
| 背景 | `bg-card` = `#FFFFFF` | 设计 §9「Background: white」 |
| 左右内距 | **`px-[var(--app-main-padding)]` = 20px**（原为 `px-5`，数值相同但改为 Token） | 使 Header 内容与页面内容共用同一条左边界；参考图实测 Header 内容左缘 ≈25px、页面内容左缘 ≈20px，按「Design System > UI Reference」统一取 20px |
| 其他 | 移除 `gap-4`（空 flex 行中无意义） | — |
| 内容 | **保持简洁空状态**（实测 `header.children.length === 0`） | 见 §2.3 |

### 2.2 与 Sidebar 品牌分带的视觉关系（真实浏览器实测）

| 检查 | 实测 | 结论 |
| --- | --- | --- |
| Header 高度 vs 品牌分带高度 | 52px vs 52px | **等高等宽** ✓ |
| Header 下边线 y vs 品牌分带下边线 y | 52 vs 52（`bordersAligned: true`） | **两条下边线对齐** ✓ |
| Header 左缘 vs Sidebar 右缘 | 164 vs 164（`headerLeftEqualsSidebarRight: true`） | Header 从 Sidebar 右侧开始，**其下边框不跨越 Sidebar** ✓（与参考图实测一致：y=53 的分隔线在 Sidebar 区域内不存在） |

### 2.3 为什么 Header 仍然是空的

设计文档规定 Header 内容为 Search / System Status / Notification / User，当前系统四项**均无数据源**（无搜索接口；后端有 `/health`、`/ready` 但前端 `api/` 无对应模块，新增即改动 API 层；无通知系统；无用户体系）。按"只实现真实存在的数据和功能、不新增假数据"的要求，**未放**搜索框 / 通知铃铛 / 用户头像 / "系统正常" / 占位按钮；该判断与理由已写入组件注释，便于后续有数据源时补齐。

## 3. Main / PageContainer 做了什么

### 3.1 决策：不新建 PageContainer.vue

设计文档 `03-page-layout.md` 给 PageContainer 规定 4 项职责，现有 `<main>` 已全部覆盖：

| PageContainer 职责（设计文档） | 现有实现 | 是否需新增组件 |
| --- | --- | --- |
| padding: 20px | `p-[var(--app-main-padding)]` | 不需要 |
| background: #F6F7FB | `bg-background`（= `--background #F6F7FB`） | 不需要 |
| min-height: calc(100vh - Header) | 根节点 `min-h-screen` + main `flex-1`（等价效果） | 不需要 |
| 内容区域不要使用固定高度 | 未使用任何固定高度 | 不需要 |
| 页面最大宽度 | 仍由各业务页面自身的 `.page` 等 legacy 规则决定（**本阶段不改业务页面**） | 不应由 PageContainer 接管 |

按阶段要求"如果当前 AppShell 已经存在适合的 Main 容器结构：优先直接调整现有结构，只有在确实有必要时才新增" ⇒ **不新增文件**，直接精修现有 `<main>`。

### 3.2 落地改动

```html
<!-- Phase 2-A -->
<main class="flex-1 p-[var(--app-main-padding)]">

<!-- Phase 2-C -->
<main class="min-w-0 flex-1 bg-background p-[var(--app-main-padding)]">
```

| 改动 | 原因 |
| --- | --- |
| `min-w-0` | 阶段明确要求 "Main 使用 flex-1、min-width: 0"；为宽内容（如工作流图、长表格行）提供水平收缩保护，避免撑破外壳布局 |
| `bg-background` | 阶段明确要求"主内容区域背景使用 Design Token"；原先依赖根节点继承，现显式声明（渲染结果不变，`rgb(246,247,251)`） |
| `flex-1` / `p-[var(--app-main-padding)]` / `<RouterView />` | **保持不变**，RouterView 渲染方式未做任何改动 |

## 4. 是否修改 Legacy CSS

**否。** `apps/web/src/styles.css` 本阶段零改动（mtime 仍为 Phase 2-A 的 11:41:13，仍 960 行）。未使用 `!important`、未做 layering hack、未修改任何业务页面的 legacy class。

关于 `a { color: #1d4f91 }` 对 Tailwind 的影响：本阶段**无新增影响**（Header 无链接、Main 未新增链接），该问题已记录在 `docs/64` §3.2 与 `docs/65` §7.2，并按阶段要求留待后续处理。

## 5. 是否修改业务 / API / Router / Store / ViewModel / SSE

**全部为「否」**：

| 对象 | 状态 | 证据（mtime） |
| --- | --- | --- |
| Router | 未改动 | 9 月 11 日 |
| API（7 模块 47 函数） | 未改动 | 9 月 11–14 日 |
| Stores（7 个） | 未改动 | 9 月 14 日 |
| ViewModels（8 个） | 未改动 | 9 月 14 日 |
| SSE / 实时通道 | 未改动 | 未触碰 3 个 store |
| 业务 View（11 个） | 未改动 | 9 月 14 日或更早（例：`ProjectsView.vue` 9月14日 10:40） |
| 菜单（8 项）/ 页面 / 路由 / 数据 | 未新增、未删除、未改名 | — |
| Sidebar | 未改动 | 11:53:54（Phase 2-B） |

## 6. typecheck / lint / test / build

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `corepack pnpm --filter @ai-se/web typecheck` | **PASS**（exit 0） |
| lint | `corepack pnpm --filter @ai-se/web lint` | **PASS**（exit 0） |
| test | `corepack pnpm --filter @ai-se/web test` | **PASS**：15 files / 53 tests |
| build | `corepack pnpm --filter @ai-se/web build` | **PASS**（`index-KlgiLWCh.css` 16.80 kB / `index-BPuOCvrV.js` 277.46 kB） |

## 7. 浏览器验证结果

真实浏览器 + 构建产物（`vite preview` :5173 = 后端 `CORS_ORIGIN`，走真实 API）。

### 7.1 外壳几何与对齐（实测）

| 项 | 实测 |
| --- | --- |
| Sidebar | 宽 **164px**（右缘 164） |
| Header | 高 **52px**、左缘 164、下缘 52、下边框 `1px rgb(232,234,240)`（= `--border`）、背景 `rgb(255,255,255)`（= `--card`）、内距 `0px 20px`（= `--app-main-padding`）、子元素 **0** |
| Sidebar 品牌分带 | 高 52px、下缘 52 → **与 Header 下边线对齐** |
| Main | 左缘 164、内距 **20px**、背景 `rgb(246,247,251)`（= `--background`）、`min-width: 0px`、`flex-grow: 1` |
| 页面内容左边界 | 与 Main 内距**精确一致**（20px） |
| Header 左缘 vs Sidebar 右缘 | 完全贴合 ⇒ 下边框不跨越 Sidebar |

### 7.2 三档视口 × 八条一级路由

| 视口 | 结果 |
| --- | --- |
| **1024px** | 8/8 路由：侧栏 164、Header 52、Main 内距 20px、**横向溢出 0**、active 正确、无错误态 |
| **1280px** | 同上 8/8 全部通过 |
| **1440px** | 同上 8/8 全部通过 |

（横向溢出按 `document.documentElement.scrollWidth - window.innerWidth` 判定，三档视口下全部为 0 或负值 ⇒ **无横向溢出**。）

### 7.3 详情路由（深链 = 刷新）

| 路由 | 挂载 | RouterView | active | Header 对齐 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `/projects/<真实 id>` | ✓ | ✓ | 项目 | ✓ | 渲染真实数据（Mini Todo），无错误态 |
| `/workflows/abc` | ✓ | ✓ | 工作流 | ✓ | 后端返回 `Workflow id must be a UUID`（假 id 的既有校验响应） |
| `/deployments/abc` | ✓ | ✓ | 部署 | ✓ | 后端返回 `Id must be a UUID`（同上） |
| `/mcp/abc` | ✓ | ✓ | MCP 服务器 | ✓ | 后端返回 `Internal server error`（同上） |
| `/mcp/abc/app` | ✓ | ✓ | MCP 服务器 | ✓ | 沙箱说明文案正常渲染 |

> 上述三处错误文本来自**后端对不存在/非法 id 的既有响应**，与本次外壳改动无关，按"不顺手修复"要求仅记录。

## 8. 视觉差异与遗留问题

### 8.1 与参考图的有意差异（按优先级取舍）

| 项 | 参考图 | 实现 | 原因 |
| --- | --- | --- | --- |
| Header 内容左缘 | ≈25px | **20px** | 设计 §5「Page padding: 20px」优先级更高；统一 Header 与页面内容的左边界 |
| Main 内容左缘 | ≈20px | 20px | 一致 ✓ |
| Header 内容 | 搜索框 / 状态 / 通知 / 用户 | **空** | 四项在当前系统均无数据源（不新增假数据） |
| Header 下边框跨 Sidebar？ | 不跨（实测） | 不跨 ✓ | 结构上 Header 位于主内容列内 |

### 8.2 遗留问题（记录，非本阶段修复）

1. **Sidebar 未固定**：设计 `02-navigation.md` §2 要求 fixed/sticky；当前 Sidebar 随页面滚动（长度超过一屏时侧栏一起滚动）。属 Sidebar 范畴（Phase 2-B 已结束），本阶段未处理。
2. **全局 `a { color }` 陷阱仍在**：仍会影响后续页面迁移中"给链接类元素设文字色"的 Tailwind 写法；收口方式见 `docs/64` §3.2。
3. **窄屏（<900px）无折叠/堆叠**：Sidebar 保持 164px 侧向布局；设计 §6 的折叠属后续阶段。
4. **页面最大宽度仍由 legacy 规则决定**：`.page` 1180px / `.agent-run-page` 1280px / `.requirement-page` 1320px 并存（既有不一致），本阶段按要求未改业务页面。若要统一宽度，需在业务页面迁移阶段处理。

## 9. 结论

**PASS**

Header 与 Main/PageContainer 精修完成：Header 52px + `border-bottom` + `bg-card` + Token 内距，与 Sidebar 品牌分带等高等宽、下边线对齐且不跨越 Sidebar；Main 补 `min-w-0` 与显式 `bg-background`，内距 20px、背景 `#F6F7FB`、RouterView 渲染方式未变；按"优先调整现有结构"未新增 `PageContainer.vue`。三档视口（1024/1280/1440）× 八条一级路由 + 五条详情路由全部通过、无横向溢出、真实 API 正常；业务/API/Router/Store/ViewModel/SSE 与 Legacy CSS **零改动**；四项门禁全绿。

按阶段纪律**在此停止**，不自动进入 Phase 3。
