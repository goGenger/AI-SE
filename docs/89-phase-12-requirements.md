# Phase 12-B — Requirements UI 视觉重构（实施记录）

> 阶段：Phase 12-B（基于 `docs/88-phase-12-requirements-analysis.md` 的实施）
> 依据：`docs/design/*`（`07-page-layout-patterns.md`：Requirements → **Requirement Workspace**）、`docs/88`、`docs/ui-reference/ai-se-home.png`
> 结论：**PASS**
> 日期：2026-09-15

## 1. 修改文件

| 文件 | 变化 |
| --- | --- |
| `apps/web/src/views/RequirementsView.vue` | 393 → **405 行**（左栏顺序互换；指标 3 → 4 卡；PRD 限高滚动块；规格两列网格；依赖区限高滚动） |
| `apps/web/src/__tests__/requirementsView.test.ts` | 268 → **425 行**（12 → 19 例） |
| `docs/89-phase-12-requirements.md` | 本文档 |

**未修改**：`api/requirements.ts`（mtime 9-14）、`stores/requirements.ts`（9-14）、`router/index.ts`（9-11）、`viewmodels/requirementViewModel.ts`（14:59）、`viewmodels/agentRunViewModel.ts`（16:09）、`styles.css`（11:41）、`components/**`、Sidebar/Header、其他页面、`package.json`、Design Token。

> **外部变更提示（非本阶段产物）**：`apps/web/src/views/ProjectsView.vue` 在本阶段进行中被**外部修改**（mtime 19:18:09，277 → 259 行；mtime 与内容均非本阶段操作）。经查其内容仍为 11-B 的 Resource Workspace 结构（PageHeader 通栏 / `<table>` 6 列 / `py-3` / `project-row-repo` max-width 140px），属排版层面的整理。**该文件不在 12-B 允许范围内，我未改动它**；发现后已重跑全部四道门禁，**当前仓库状态全绿**（见 §5）。

## 2. 布局变化

| # | 区域 | 变化 | 依据 |
| --- | --- | --- | --- |
| 1 | 左栏 | **「需求列表」上移到「新建需求」之前**（DOM 顺序真实调换，非 CSS order）；列表交互 / 选中态 / loading/error/empty 四分支与表单行为完全未变 | 任务书 §1 |
| 2 | 指标 | **3 卡 → 4 卡**：状态 / 版本 / **规格**（`currentSpecifications.length`）/ 任务；断点 `md:grid-cols-3` → **`min-[900px]:grid-cols-4`**（修正断点不一致）；数据来源与 `text-metric` 样式未变 | 任务书 §2 |
| 3 | 需求详情 | 描述 / 创建时间保持 `dl` 行；**PRD 改为独立限高滚动块**（`max-h-[220px] overflow-auto whitespace-pre-wrap` + `rounded-lg border border-border bg-muted p-3`，与规格 `<pre>` 同一语言）；**内容一字未删**（仍渲染 `selectedRequirement.rawContent` 全文） | 任务书 §3 |
| 4 | 规格 | 容器由 `grid gap-4`（纵向 + 分割线）改为 **`grid-cols-1 min-[900px]:grid-cols-2`**，每个规格包一层 `rounded-lg border border-border p-3.5`；**7 个规格、类型标签、`vN`、JSON `<pre>`（max-h 220 + 滚动）全部保留** | 任务书 §4 |
| 5 | 任务与依赖 | 任务节点网格**未动**（`minmax(220px,1fr)`）；**依赖区改为限高滚动容器**（`max-h-[180px] overflow-auto` + `bg-muted` + 圆角），「依赖关系」标签移到容器外常驻可见；**73 条依赖全部保留** | 任务书 §5 |
| 6 | 规划事件 | **完全未动**（结构、数据、SSE 逻辑） | 任务书 §6 |

## 3. 视觉变化

- 页面进入「先看资源（列表）→ 再操作（表单）」的 Workspace 节奏；左栏首屏即为需求列表。
- 指标行与 Dashboard / MCP / Projects 统一为 **4 列 + `min-[900px]` 断点**（此前 3 列 + `md:` 是本页独有的不一致）。
- 长内容（PRD、规格 JSON、依赖胶囊）统一为「**限高 + 独立滚动**」的同一视觉语汇（`bg-muted` + `--border` + 12px 圆角 + 12px 内距），页面不再出现单块 1,900px / 3,700px 的连续内容。
- 规格由「纵向长列表」变为**两列卡片网格**，规格之间可横向比较。
- 未使用 `!important`、未新增 Token / 组件 / 依赖、Light only、无渐变或阴影新体系。

## 4. 业务冻结确认（均为实测）

| 项 | 结果 |
| --- | --- |
| API / Store / Router | **零改动**（mtime 核对：`api/requirements.ts` 9-14、`stores/requirements.ts` 9-14、`router/index.ts` 9-11） |
| ViewModel（含共享） | **零改动**（`requirementViewModel.ts` 14:59、`agentRunViewModel.ts` 16:09）；未新增任何 computed（规格计数直接用既有 `currentSpecifications.length`） |
| 数据获取 | **未新增**：仍为 `GET /projects` → `GET /projects/:id/requirements` → `GET /requirements/:id` + `/specifications` + `/tasks` |
| SSE / polling | **未触碰**：`startRealtime` / 2s 轮询降级 / 终态 `stopRealtime` + 重载 / `onUnmounted` 清理全部原样 |
| 「分析」按钮 | **全程未点击**（沿用 6-B 纪律）；仅验证 disabled 状态：未选需求 → `disabled` ✓（实测） |
| 表单行为 | 约束（maxlength 160/1000/20000、`rows=7`、无 `required`）、默认值、`v-model.trim`、创建按钮 disabled 三条件全部未变（测试断言保留并通过） |
| 分支与文案 | 左栏 4 分支 + 右栏 2 分支 + 3 处面板空态的顺序、条件与逐字文案未变（FAILED 需求实测：3 处空态文案全部存在） |
| 内容完整性 | PRD 全文、7 个规格 JSON、33 个任务节点、**73 条依赖**均完整渲染（未删除、未隐藏） |
| 业务数据 | **未创建、未修改任何数据**：验证前后 `requirements` **2 条**（ANALYZED + FAILED）、`specifications` **7**、`tasks` **33**、`dependencies` **73** 完全一致 |

## 5. 测试结果

```
typecheck  PASS
lint       PASS
test       PASS  28 files / 221 tests（214 → 221；Requirements 视图 12 → 19 例）
build      PASS  dist/assets/index-CLJ_5Er_.css 40.36 kB (gzip 7.56)
                 dist/assets/index-s0gKakjM.js  342.34 kB (gzip 105.02)
```

体积变化（相对 12-A 基线）：CSS 40.33 → **40.36 kB（+0.03）**；JS 341.83 → **342.34 kB（+0.51）**。

新增 7 例覆盖：左栏顺序（`需求列表` 先于 `新建需求`）、指标 4 卡 + `min-[900px]:grid-cols-4`（且不含 `md:grid-cols-3`）+ 4 个 `text-metric` + 真实值、PRD 限高滚动块（`requirement-prd` / `max-h-[220px]` / `overflow-auto` / `whitespace-pre-wrap` / 内容保留 / 描述与创建时间字段仍在）、规格两列网格 + 7 个 `<pre>` + 7 个规格容器 + 7 个类型标签 + JSON 内容、依赖区限高滚动 + **73 条依赖全量渲染** + 「73 条依赖」计数 + 任务网格 `minmax(220px,1fr)` 未变、无 Tabs/Breadcrumb/搜索/筛选/排序/分页/Accordion、**无 legacy 类名**（19 个 token）。既有 12 例的断言全部保留并通过。

## 6. 浏览器验证结果（:5173 真实后端 :3000 + 真实数据；仅 GET 请求）

| 检查 | 实测 |
| --- | --- |
| 初始状态 | 「请选择或创建需求。」空态 + 分析按钮 `disabled`；面板标题顺序 = 需求列表 → 新建需求 → 需求详情 → 规划事件 → 规格 → 任务 DAG ✓ |
| **ANALYZED 需求** | 指标 **已分析 / v1 / 7 / 33**（4 列）；`<pre>` **7**；任务节点 **33**；依赖胶囊 **73** + 「依赖关系」标签 + 「73 条依赖」计数 ✓ |
| **PRD 滚动块** | `max-height: 220px` / `overflow-y: auto` / **`scrollHeight > clientHeight = true`**（可独立滚动）✓ 内容为真实 PRD 全文 ✓ |
| **依赖区滚动块** | `max-height: 180px` / `overflow-y: auto` / **可独立滚动** ✓ 高度 180px ✓ |
| **布局栅格**（@1280） | 指标 **4 列** ✓ ／ 规格 **2 列** ✓ ／ 任务节点 2 列（`minmax(220px,1fr)` 未变）✓ |
| **面板高度变化** | 需求详情 **1946 → 419** ／ 规划事件 137（未变）／ 规格 **2031 → 1250** ／ 任务 DAG **3761 → 3499** |
| **文档高度** | **8,247 → 5,677px（-31%）**；其中「任务 DAG」仍占 3,499px（33 个节点在 677px 列宽下只能排 2 列 ≈ 17 行）—— **未为达标而删减业务内容**（任务书允许 >5,000px） |
| **FAILED 需求** | 指标 **失败 / v1 / 0 / 0**；3 处原有空态文案（暂无规划事件。/尚未生成规格。/尚未生成任务。）全部存在 ✓；文档高度 1,063px（与改造前一致）✓ |
| **响应式** | @900：两栏（360px + 297px）+ 指标 4 列 + 规格 2 列 ✓；@899 / @700：**单列** + 指标 1 列 + 规格 1 列 ✓；依赖区在四档均可滚动 ✓；**四档 `overflowX` 均为 -15（= 0，无横向溢出）** ✓ |
| console | 全部轮次 **0 error / 0 warning** ✓ |
| **legacy 审计（双通道）** | 页面 DOM 类名 **137** 个 ∩ `styles.css` 全部类选择器 = **`[]`** ✓；`styles.css` 未改动 |
| **回归** | `/`（仪表盘，表格 1 行真实数据、`overflowX 0`、console 0）✓；`/workflows`（工作流，console 0、无溢出）✓；`/projects`（项目，表格 1 行、`overflowX 0`、console 0）✓ |
| 数据不变 | 验证前后：requirements **2**（ANALYZED + FAILED）／ specifications **7** ／ tasks **33** ／ dependencies **73** ✓ |

## 7. 风险与限制

| # | 项 | 说明 |
| --- | --- | --- |
| R1 | **未达到分析中的 ≤5,000px 目标**（实测 5,677px） | 原因：33 个任务节点在右栏 677px 宽下只能排 2 列（≈17 行，占 3,499px）。任务书已明确"**不强制通过牺牲业务内容达到 ≤5000px**"，因此**未隐藏/删减任何节点或依赖**；如需进一步压缩，需要新交互（折叠/分页/虚拟滚动）—— 三者均在本阶段禁止之列 |
| R2 | PRD / 依赖区改为限高滚动 | 定位为**呈现层**（与既有规格 `<pre>` 同一手法），内容一字未删，可独立滚动查看全文 |
| R3 | 左栏 DOM 顺序调整 | 真实调换 DOM（非 CSS order），键盘 Tab 顺序与视觉顺序一致；既有测试断言未受影响 |
| R4 | 真实数据只有 1 ANALYZED + 1 FAILED | 多需求列表、ANALYZING/DRAFT 状态、非空规划事件流（SSE）**未在浏览器端到端验证**（SSR 契约测试覆盖结构；**未创建测试数据**） |
| R5 | 「分析」流程未验证 | 按纪律**未点击分析按钮**（会触发外部 Agent/LLM）；SSE 与轮询链路本身未改动 |
| R6 | 外部并行修改 | 见 §1 提示：`ProjectsView.vue` 在本阶段进行中被外部改动（非本阶段产物）；发现后重跑门禁确认全绿 |

## 8. 结论

**PASS**

六项实施要求全部落地（左栏顺序、指标 4 卡、PRD 限高滚动、规格两列、依赖区限高滚动、规划事件保持）；业务、接口、Store、Router、ViewModel、SSE/轮询、表单约束、全部分支与文案零改动；内容完整（7 规格 / 33 任务 / 73 依赖 / PRD 全文）；四道门禁全绿；浏览器四档 `overflowX = 0`、console 0、**legacy 命中 0**；Dashboard / Workflows / Projects 回归正常；文档高度 8,247 → **5,677px**（-31%，未牺牲业务内容）。

**Code changed: ONLY `RequirementsView.vue` + `requirementsView.test.ts`（+ 本文档）**
**API / Store / Router / ViewModel / CSS / Dependencies / Business data: NONE**

按阶段纪律**在此停止**，不进入 Phase 13。
