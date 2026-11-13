# Phase 4 — Dashboard Visual Reconstruction（实施记录）

> 阶段：Phase 4（第一个业务页面视觉重构）
> 前置：`docs/70-phase-4-dashboard-analysis.md`（改造前产出的现状分析与功能冻结清单）
> 依据：`docs/design/*`、`docs/ui-reference/ai-se-home.png`、`docs/60`–`docs/69`（Phase 0–3 记录）
> 范围：**仅 Dashboard**（`/`）
> 日期：2026-09-15

---

## 1. 文件变更

### Added Files
| 文件 | 说明 |
| --- | --- |
| `apps/web/src/__tests__/dashboardView.test.ts` | Dashboard 页面契约测试（6 例） |

### Modified Files
| 文件 | 改动 |
| --- | --- |
| `apps/web/src/views/DashboardView.vue` | 视觉层整体迁移（template / class / 组件组合 + scoped 链接色）；业务脚本（store / viewmodel / onMounted）逐行保持 |
| `apps/web/src/viewmodels/projectViewModel.ts` | **仅新增**纯展示映射 `projectStatusTone()` 与 `ProjectStatusTone` 类型；既有 `projectStatusLabel` / `latestProjects` / `formatProjectDate` 一字未改 |
| `apps/web/src/__tests__/projectViewModel.test.ts` | **仅新增** 1 条 `projectStatusTone` 断言 |

### Deleted Files
无。（`styles.css` **零改动**，仍 960 行 / mtime 11:41 = Phase 2-A；未删除任何 legacy 类，因为它们仍被其余 10 个页面使用。）

## 2. Dashboard Functional Inventory（迁移后逐项核对）

| 项 | 迁移后状态 |
| --- | --- |
| API | `GET /projects`（`listProjects()`）—— **unchanged**，未新增/修改任何 endpoint、参数或响应处理 |
| Store | `useProjectsStore`（`projects` / `loading` / `error` + `fetchProjects()`）—— **unchanged**，文件 mtime 仍为 9 月 14 日 |
| Router | 3 处目标路由均未改：`/projects`（新建项目、查看全部）、`/projects/:id`（项目名）；`router/index.ts` mtime 仍为 9 月 11 日 —— **unchanged** |
| SSE | 本页面没有 SSE 通道（项目内 3 处 SSE 位于 agentRuns / requirements / workflows store）—— **unchanged** |
| Interactions | ① `onMounted` → `fetchProjects()` ② 新建项目 → `/projects` ③ 查看全部 → `/projects` ④ 项目名 → `/projects/:id` ⑤ loading / error / empty / list 四分支 —— **全部保留**（真实浏览器逐项验证，见 §5） |
| 数据 | 指标（项目总数 / 启用中的项目 / 基础能力「就绪」）与列表（`latestProjects` 前 5 条 + 状态文案）与迁移前完全一致 —— **unchanged** |

## 3. UI Migration（只列实际发生的）

| Legacy | New | 备注 |
| --- | --- | --- |
| `.page`（max-width 1180） | 移除上限（`<section>` 无 class） | 设计文档 `03-page-layout.md` §11「Dashboard 充分利用屏幕」+ 参考图像素实测（内容左右各约 20px 留白、铺满主区） |
| `.page-header` + `.eyebrow` | `PageHeader`（3-C） | 文案「阶段 0」/「仪表盘」原样；h1 32px → `--text-page-title` 24px/600 |
| `.button.primary`（RouterLink） | `buttonVariants()` + scoped 链接色 | §16 允许的做法，复用 Phase 2-A/3-B 既有手法 |
| `.metric-grid` / `.metric` | `Card`（3-B）+ `md:grid-cols-3` | 标签 14px body、数值 28px `--text-metric`；内距 18px → `--card-padding` 20px |
| `.panel` | `Card` | 语义确为 Card（白底 + border + 圆角 + 内距） |
| `.panel-header` | `SectionHeader`（3-C） | `<h2>`「最新项目」+ actions 插槽放「查看全部」 |
| `.compact-list` | Tailwind `<ul>/<li>`（flex + gap） | 结构过薄，不抽象组件 |
| `.state` / `.state.error` | Tailwind `<p>` + `text-muted-foreground` / `text-danger` | 3-C 未建 LoadingState/ErrorState，且 §18 禁止本阶段新增组件 |
| `.empty` | `EmptyState`（3-C） | 文案「暂无项目。」原样 |
| 状态纯文本 `<span>` | `StatusBadge`（3-C）+ `projectStatusTone()` | 页面原本无状态样式（未使用 `.status`/`.status-pill`）；设计文档 §11 要求状态统一使用 StatusBadge。tone 映射为纯展示函数，放在 Dashboard 既有 viewmodel 中（§11 明确要求） |

## 4. Business Safety

- API contract: **unchanged**
- Store: **unchanged**
- Router: **unchanged**（含 route meta / 权限 —— 全项目本就无 meta 与守卫）
- SSE: **unchanged**
- Business logic: **unchanged**（新增的 `projectStatusTone` 是纯展示映射，不参与任何业务判断）
- Permissions: **unchanged**
- Mock data: **none**（无任何假 metric / 假 activity / 假状态；参考图中的 Banner / Quick Start / Activity / System Status / AI Assistant 等区域因无真实数据来源一律未实现）
- 新增组件: **none**（全部复用 3-B primitives + 3-C common components）

## 5. Visual QA（真实浏览器 + 真实 API）

服务：后端 `:3000`（`/health` = 200，真实项目 Mini Todo）+ `vite preview` `:5173`。

### 5.1 排版（全页面逐元素实测，全部落到 Token）

| 元素 | 实测 | Token |
| --- | --- | --- |
| 阶段 0（eyebrow） | 12px / 600 / `#6B7280` | `--text-caption` + muted-foreground |
| 仪表盘（h1） | **24px / 600** / `#1F2937` / margin 0 | `--text-page-title` |
| 新建项目 | 14px / 500 / `#FFFFFF` | `--text-body` + `--primary-foreground` |
| 指标标签 ×3 | 14px / 400 / `#6B7280` | `--text-body` |
| 指标数值 ×3 | **28px / 600** / `#1F2937` | `--text-metric` |
| 最新项目（h2） | **16px / 600** | `--text-section-title` |
| 查看全部 | 14px / 500 / `#6C5CE7` | link variant + primary |
| 项目名 | 14px / 400 / `#6C5CE7` | `--text-body` + primary |
| 启用（StatusBadge） | 12px / 500 / `#059669` on `#ECFDF5` | `--text-caption` + success 语义色 |

> 迁移过程发现并修正：项目名链接最初为 16px（继承根字号，非 Token 值）→ 按设计文档 §4「Body 13-14px」补 `text-body`，复检后全页面无任何非 Token 字号。

### 5.2 结构 / 间距 / Token

- Card：`bg #FFFFFF` / `border 1px #E8EAF0` / `radius 12px` / `padding 20px`（= `--card-padding`）；Dashboard 共 4 个 Card（3 指标 + 1 列表）
- Sidebar **164px** / Header **52px** / Main padding **20px** / Primary **`#6C5CE7`**（实测值）
- 指标区 `mb-[var(--section-gap)]` = 24px；指标列间距 16px
- 列表行高 22px，`li` 使用 flex + `justify-between` + gap 12px

### 5.3 1024 / 1280 / 1440

| 视口 | 横向溢出 | 指标列数 | 内容右边界 | 主区右边界−20px | 名称/徽标字号 |
| --- | --- | --- | --- | --- | --- |
| 1024 | **0** | 3 | 1004 | 对齐 ✓ | 14px / 12px |
| 1280 | **0** | 3 | 1260 | 对齐 ✓ | 14px / 12px |
| 1440 | **0** | 3 | 1420 | 对齐 ✓ | 14px / 12px |

内容区铺满主区（左右各 20px），与参考图一致。

### 5.4 状态分支（全部真实浏览器验证）

| 分支 | 手段 | 实测 |
| --- | --- | --- |
| 正常（真实 API） | 真实 `GET /api/projects` | 指标 1 / 1 / 就绪；列表 1 条 Mini Todo（真实 id）；徽标「启用」success tone |
| loading | CDP 对真实 API 注入 1.5s 延迟后重新挂载 | 「正在加载项目…」`#6B7280` 14px，列表不渲染；延迟恢复后回到真实数据 |
| error | CDP 阻断 `*/api/projects*` | 「网络请求失败：无法连接后端服务」`#DC2626` 14px，空状态不出现（分支优先级正确） |
| empty | 浏览器侧 `fetch` 返回空列表（补充验证；权威验证为真实 API） | `EmptyState`「暂无项目。」白底 / 1px `#E8EAF0` / 12px 圆角 / 24px 内距 / 居中；指标 0 / 0 / 就绪；列表不渲染 |

### 5.5 交互回归（真实鼠标事件）

| 交互 | 实测 |
| --- | --- |
| hover 新建项目 | `#FFFFFF` 文字、无下划线（scoped 规则稳定胜过 legacy 未分层 `a:hover`） |
| hover 查看全部 / 项目名 | 文字 `#6C5CE7`，hover 出现下划线 |
| 点击项目名 | → `/projects/b55c87fc-…`，详情页 h1 = Mini Todo（真实数据）；`history.back()` 返回 `/` 且数据恢复 |
| 新建项目 / 查看全部 | `href="/projects"` 正确 |

### 5.6 控制台

`window.onerror` / `unhandledrejection` **无记录**，无 `[Vue warn]`。

### 5.7 legacy 依赖解除

Dashboard 中 `.page` `.page-header` `.eyebrow` `.metric-grid` `.metric` `.panel` `.panel-header` `.compact-list` `.state` `.empty` `.button` `.status` `.status-pill` **残留 0 个**；其余 10 个页面复测仍为 legacy 结构（`.page-header` 存在、h1 32px、`.page` 存在）—— 未受影响。

## 6. Tests

- before：**17 files / 91 tests**
- after：**18 files / 98 tests**（+7：`projectViewModel.test.ts` +1、`dashboardView.test.ts` +6；既有 91 例全部保留且未修改断言）

## 7. Gate

| 门禁 | 结果 |
| --- | --- |
| typecheck | **PASS**（exit 0） |
| lint | **PASS**（exit 0，0 problem） |
| test | **PASS**（18 files / 98 tests） |
| build | **PASS**（`index-nzJj7JMw.css` 22.44 kB / `index-cFXm-Nwe.js` 312.67 kB） |
| browser | **PASS**（真实 API + 三档视口 + 四分支 + 交互回归 + 无 console error / Vue warning） |

> JS 体积 277.46 → 312.67 kB：Dashboard 是第一个真正 import 组件层的业务页面，属预期变化（非新增依赖）。

## 8. Known Risks（只记录，未擅自处理）

1. **legacy 全局 `a { color:#1d4f91 }` 仍在**：任何业务页面用 `<RouterLink>` + Tailwind 文字色都会踩到；本次按 §16 用 scoped 规则处理（与 AppSidebar 同手法），根治仍在 Phase 11。
2. **`--text-*` 与 legacy 未分层 `font: inherit` 的冲突**（仅影响 button/input/select/textarea）：Dashboard 未使用这些元素，故本页面无影响；后续迁移表单页面时按 Phase 3-B 既有方案处理。
3. **`.error-banner` 未定义**（3 个页面在用，`styles.css` 中始终没有该类）：与 Dashboard 无关，未处理。
4. **其余 10 个页面仍是 32px h1 + legacy 视觉**：本次只重构 Dashboard，页面之间会存在视觉代差，直到 Phase 5+ 逐个迁移。
5. **`projectStatusTone` 目前只有 project 一个域**：Workflow / Deployment / AgentRun / MCP 等状态到 tone 的映射将在各自页面阶段补充（不在本阶段扩大范围）。
6. **测试用 SSR 渲染 + 注入 store 状态**：覆盖结构与分支契约，但不覆盖真实网络路径；真实 API 由本阶段的浏览器验证承担。

## 9. Definition of Done

✅ Dashboard 完成视觉迁移 ｜ ✅ 无新增业务功能 ｜ ✅ 无 mock 业务数据 ｜ ✅ API contract 未改 ｜ ✅ Store 未改 ｜ ✅ Router 未改 ｜ ✅ SSE 未改 ｜ ✅ 权限未改 ｜ ✅ 使用既有 Design Token（实测无任何非 Token 字号/颜色） ｜ ✅ 使用 Phase 3-B primitives ｜ ✅ 使用 Phase 3-C common components ｜ ✅ legacy CSS 未被全局破坏（styles.css 零改动） ｜ ✅ 原有功能全部保留 ｜ ✅ 真实 API 验证通过 ｜ ✅ 1024/1280/1440 通过 ｜ ✅ 无横向溢出 ｜ ✅ 无 console error ｜ ✅ 无 Vue warning ｜ ✅ typecheck / lint / test / build 全 PASS

**Phase 4 PASS**

---

按阶段纪律**在此停止**：不进入 Projects / Requirements / Workflows / Agents / Agent Run / Deployments / MCP，不做 Legacy CSS Cleanup / Visual Regression / Functional QA。
