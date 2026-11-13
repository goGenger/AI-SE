# Phase 9.5-B — Dashboard 视觉重构（实施记录）

> 阶段：Phase 9.5-B（基于 `docs/83-phase-9.5-dashboard-visual-analysis.md` 的实施）
> 依据：`docs/design/*`、`docs/ui-reference/ai-se-home.png`、`docs/83`
> 结论：**PASS**
> 日期：2026-09-15

> **文件编号说明**：9.5-A 分析实际写入 `docs/83`（`docs/82` 被 Phase 10-A 的 MCP 分析占用），故本阶段实施记录顺延为 `docs/84`。

---

## 1. 修改文件（仅 3 个，全部在任务书允许范围内）

| 文件 | 变化 |
| --- | --- |
| `apps/web/src/views/DashboardView.vue` | 111 → **257 行**（template 重排 + 页面 scoped 样式；`<script setup>` 仅新增 `quickActions` 常量与 3 个图标 import，业务调用逐行未改） |
| `apps/web/src/__tests__/dashboardView.test.ts` | 120 → **234 行**，6 → **14 例**（新增 Hero / Quick Actions / KPI / 表格 / 顺序 / 无虚构数据护栏） |
| `docs/84-phase-9.5-dashboard.md` | 本文档 |

**未修改**：`viewmodels/projectViewModel.ts`（`latestProjects` / `projectStatusLabel` / `projectStatusTone` / `formatProjectDate` **原样复用**，无需新增纯函数）、`api/*`、`stores/*`、`router/*`、`styles.css`、`components/**`、Sidebar/Header、其他任何页面、`package.json`、Design Token、`dist`。

## 2. 布局变化（Phase 4 旧版 → 9.5-B）

| 区域 | Phase 4（旧） | Phase 9.5-B（新） |
| --- | --- | --- |
| 页面顶部 | `PageHeader`（eyebrow + h1 + 主操作，独立一行块） | **Welcome Banner**（浅紫通栏 Card：图标块 + eyebrow + h1 + 主操作右置；≥900 横向 / <900 纵向） |
| 快捷入口 | 无 | **快速开始**：4 列卡（第一张 Primary 实心），≥900 四列 / <900 单列 |
| 指标 | **3 列**普通卡（标签在左、数值在下，无图标） | **4 列 KPI**（图标块在上 + 标签 + 28px 数值）：项目总数 / 启用中的项目 / 已归档项目 / 基础能力·就绪 |
| 项目区 | 「最新项目」**列表卡**（2 列信息、行高 22px） | 「我的项目」**语义 `<table>`**：项目名称 / 描述 / 状态 / 创建时间，行高 **55px**，外层 `overflow-x-auto`（`min-w-[640px]`） |
| 分区标题 | 无（只有 Card 内 SectionHeader） | 「快速开始」「项目数据概览」「我的项目」三级节奏（16px/600） |
| 页面宽度 | 无上限（充分利用屏幕） | **不变**（无上限） |

实测区块几何（视图 1842×854，**与参考图同尺寸**）：

```
Welcome Banner  y=72  h=108  w=1638（bg rgb(247,245,255) = --primary-soft，radius 12，内距 28/20）
快速开始        卡片 398×70，四列 gap 16
项目数据概览    KPI 卡 398×148（flex-column：图标块 40×40 + 标签 + 28px 数值）
我的项目        卡片 y=547 h=187；表头 + 1 行（行高 55，td padding 16px）
内容底部        y=734；页底留白 120px = 视口 14%
```

## 3. 视觉变化

1. **Hero**：`--primary-soft` 浅紫底 + `--border` + `--radius-lg` + 图标块（`--primary-light` 底 / Primary 图标）；h1 仍 24px/600 `--foreground`，eyebrow 12px `--muted-foreground`；主操作仍为 Primary 实心按钮（36px 高）。
2. **Quick Actions**：首卡 `--primary` 实心 + 白字 + 白色图标（对齐参考图实心紫卡），其余白卡 + `--border`；hover `--muted`；focus-visible 2px Primary ring；卡内左图标 / 中标签 / 右箭头（`@lucide/vue` 既有依赖）。
3. **KPI**：图标块 40×40 / 10px 圆角，底色分别用 **既有** tone Token（`--primary-light` / `--success-bg` / `--neutral-bg` / `--info-bg`）；标签 13px muted，数值 `text-metric` **28px/600**；**无趋势脚注**（无数据源）。
4. **表格**：表头 12px `--muted-foreground` + 下边框；数据行 55px、行间 `--border`、hover `--muted`；项目名为 Primary 链接、状态为 `StatusBadge`（active→success / archived→neutral）、时间为 `formatProjectDate` 输出、空描述显示占位符「—」。
5. **刻意保持**：无阴影、无渐变、无新 Token、无 Dark Mode、无 `!important`、无全局规则改动。

## 4. 未实现清单（参考图存在但**无真实数据源**，按约束不占位、不造假）

Hero 右侧「Agent Run #102」数据面板 ｜ 中部三栏带（当前工作流进度/stepper、最近动态、系统状态、最近部署）｜ KPI 趋势脚注 ｜ 表格「最新工作流」列 ｜ 表格「操作」⋮ 菜单 ｜ 顶栏搜索/系统健康/通知/用户簇（Phase 2-C 已冻结）。测试中以护栏断言（`最近动态 / 系统状态 / 最近部署 / 当前工作流 / Agent Run / 已完成 / 失败任务 / 本月 / 进度` 均不得出现）防回归。

## 5. 业务冻结确认

| 项 | 状态 |
| --- | --- |
| API | **未变**（`api/projects.ts` 未改；页面仍**只**调用 `fetchProjects()` → `GET /projects`，实测仅 1 次请求） |
| Store | **未变**（`stores/projects.ts` 未改；`projects / loading / error` 语义不变） |
| Router | **未变**（无新增路由；链接目标 `/projects`、`/projects/:id`、`/requirements`、`/workflows`、`/deployments` 全部为既有路由） |
| ViewModel | **未变**（4 个导出逐字未改，`formatProjectDate` 由此页首次消费） |
| SSE / Polling | **无**（本页原本就没有，未新增） |
| 文案 | 既有业务文案逐字保留：「阶段 0」「仪表盘」「新建项目」「项目总数」「启用中的项目」「基础能力」「就绪」「查看全部」「正在加载项目…」「暂无项目。」「错误原文」；新增的仅为**区块标题**（快速开始 / 项目数据概览 / 我的项目，任务书指定）与表头（项目名称/描述/状态/创建时间） |
| 分支 | `loading → error → empty → 表格` **顺序与优先级不变**（浏览器实测：阻断 `GET /projects` 后显示 store 原文「网络请求失败：无法连接后端服务」`text-danger`，且不渲染 EmptyState/表格） |
| latestProjects 上限 | **5 条不变**（测试断言 7 条数据只渲染 5 行） |
| 业务数据 | **未创建任何测试/业务数据**（全程只有既有的 1 个真实项目 `Mini Todo`） |

## 6. 测试结果

```
typecheck  PASS（vue-tsc + shared build）
lint       PASS（eslint src/**/*.{ts,vue}）
test       PASS  25 files / 180 tests（172 → 180，Dashboard 6 → 14 例）
build      PASS  dist/assets/index-D1lsZBP3.css 33.71 kB (gzip 6.77)
                 dist/assets/index-C19S4Vf7.js  336.60 kB (gzip 103.98)
```

体积变化（相对 9-B 基线）：CSS 32.62 → **33.71 kB（+1.09）**；JS 332.24 → **336.60 kB（+4.36）**。

新增测试覆盖：Hero 取代 PageHeader 与文案继承 ｜ 4 张 Quick Action 卡的目标路由 ｜ 唯一 Primary 卡 ｜ 4 列 KPI 文案与 `text-metric`×4 ｜ 无数据时 0/0/0/就绪（不伪造数字）｜ 按 store 数据统计 3/2/1 ｜ 语义表 4 列 + 无「最新工作流/操作」列 ｜ 行内真实字段（描述/徽标 tone/格式化时间/占位符）｜ 上限 5 条 ｜ empty/loading/error 三分支 ｜ **区块顺序** ｜ **无虚构数据护栏**。

## 7. 浏览器验证结果（开发服务器 :5173，真实 API 与真实数据；构建产物另经 `vite preview` 复核）

| 检查 | 结果 |
| --- | --- |
| **1280×900** | Hero 108px（`flexDirection: row`）、Quick 4 卡 257×70（`grid-template-columns` 四列，gap 16）、KPI 4 卡 257×96 值与真实数据一致 `1 / 1 / 0 / 就绪`、表格 1034×85、行高 47（调整前）→ 复测 55、`overflowX = 0` |
| **≥900 边界** | @900：Hero row、Quick 4 列、KPI 4 列、`overflowX 0` |
| **<900** | @899：Hero **column**（680 宽、CTA 满宽）、Quick/KPI **单列（680）**、表格外层 `scrollWidth 640 > clientWidth 638`（可横向滚动）、页面 `overflowX = -15`（无横向溢出） |
| **更窄（700）** | 表格外层 `overflow-x: auto` 生效（439 vs 640 可滚动），页面 `overflowX = -15`、Quick/KPI 单列 |
| **hover / focus** | Quick 卡 hover → `rgb(248,249,252)`（`--muted`）；表格行 hover → `--muted` + 下边框 `--border`；`focus-visible` → **2px Primary ring**（`rgb(108,92,231) 0 0 0 2px`，`--tw-ring-color: #6c5ce7`，无 UA 双描边） |
| **链接色级联** | 全部 `<a>` 实测：CTA 白字、Quick 首卡白字、其余卡 `rgb(31,41,55)`、`查看全部`/`Mini Todo` `rgb(108,92,231)`（Primary）——**无一处出现全局 `#1d4f91`**；`text-decoration: none` 生效，仅 hover 下划线 |
| **console** | **0 error / 0 warning**（多轮视口切换、hover、focus、阻断 API、恢复后均为空数组） |
| **error 分支** | 阻断 `GET /projects` → hero/Quick/KPI 保留（0/0/0/就绪）、**不渲染表格与 EmptyState**、显示 store 原文 `text-danger` 14px；解除阻断后恢复真实数据 |
| **legacy 审计（双通道）** | 静态：新 markup 与 `styles.css` 的全部类选择器取交集 = **`[]`**（119 个 DOM 类名中 119 个为 Tailwind/新命名，无 legacy 命中）；`styles.css` 960 行 **mtime 11:41 未变** |
| **构建路径采集** | `vite preview`（:5180，读 dist）实测：Hero 浅紫底、4 列栅格、Primary 首卡、4 KPI 全部正确 → Tailwind `@source` 在 build 路径同样采集到新类（该预览端口因 `CORS_ORIGIN` 只允许 :5173 而取不到数据，属既定配置、未修改） |
| **真实数据** | 表格 1 行：`Mini Todo / 测试最小prd实现 / 启用 / 2026年9月14日 11:04`（与 `GET /projects` 完全一致） |

## 8. 与参考图的量化对照

| 区块 | 参考图 | 本次实现 | 说明 |
| --- | --- | --- | --- |
| Banner | y52→165（≈110px），内容区通栏 | 108px，通栏 | ✅ 一致 |
| Quick Actions | 4 卡，≈135px | 4 卡 70px | 卡片更扁（参考图卡内有标题+描述两行；描述文案无授权来源，未添加） |
| KPI | 4 卡，≈122px | 4 卡 148px | 略高：参考图高度含趋势脚注，本实现以 Token 内距(20px)+40px 图标块替代，未加趋势 |
| 中部三栏带 | 58%/22%/20%，≈260px | **不实现** | 无数据源（禁止伪造） |
| 表格 | 6 列，行高 ≈52–56px | 4 列，行高 55px | ✅ 行高一致；「最新工作流」「操作」列无数据/无组件 |
| 页底留白 | 内容溢出视口（无留白） | 视口 14%（854）/ 18%（900） | 差异来自缺失的中部三栏带；已通过 Banner 108 / KPI 148 / 行高 55 压缩（原 27% → 14%） |

## 9. 风险与验证限制

| # | 项 | 说明 |
| --- | --- | --- |
| R1 | 真实数据量决定观感 | 仅 1 个真实项目 ⇒ 指标 `1/1/0/就绪`、表格 1 行，页面偏空。**未创建任何测试数据**；数据增长后观感自然改善 |
| R2 | 高视口留白 | 内容高度约 734px：视口越高底部留白越大（900→18%，1080 约 32%）。属"无数据源区块不实现"的直接结果，未以占位块填充 |
| R3 | Quick Actions 与侧栏重复 | 仅导航入口，标签与目标路由完全沿用既有菜单，未新增功能/文案 |
| R4 | 表格横向滚动 | <720px 起外层滚动（`min-w-[640px]`）；设计 §15 允许，页面本身无横向溢出 |
| R5 | Hero 取代 PageHeader | Dashboard 专属（设计 §4 规定以 Banner 起首）；其他 10 个页面继续使用 PageHeader，未改动 |
| 限制 | 未验证项 | 未在真实移动设备/触屏验证；未验证超大量项目（>5 行上限外的数据）在表格中的表现；`:5180` 预览因既有限制无法取数据（不影响构建路径类采集结论） |

## 10. 结论

**PASS** —— Hero / Quick Actions / 4 列 KPI / 语义表格四区块全部落地，视觉结构明显区别于 Phase 4 的旧列表式布局；无任何虚构业务数据；既有链接、分支与文案不变；四道门禁 + 浏览器（1280 / 900 / 899 / 700）+ legacy 审计 + 双构建路径验证全部通过；`overflowX = 0`、console 0 / 0。

**Code changed: ONLY `DashboardView.vue` + `dashboardView.test.ts`（+ 本文件）** ｜ **API / Store / Router / ViewModel / CSS / Dependencies / Business data: NONE**

按阶段纪律**在此停止**，不进入 Phase 10。
