# Phase 12-A — Requirements UI 视觉重构分析（只读）

> 阶段：Phase 12-A（只读分析；**禁止修改任何代码 / 业务数据**）
> 依据：`docs/design/*`（含 `07-page-layout-patterns.md`：Requirements → **Requirement Workspace**）、`docs/ui-reference/ai-se-home.png`、`docs/60`–`docs/87`、`docs/74-phase-6-requirements-analysis.md` + `docs/75-phase-6-requirements.md`
> 说明：任务书提到的 `docs/86-page-layout-patterns.md` 在本仓库不存在；对应的设计文件是 **`docs/design/07-page-layout-patterns.md`**，`docs/86` 是 Phase 11-A 的 Projects 分析文档。二者均已阅读。
> 结论来自源码 + 设计文档 + **真实运行环境实测**；无法验证处标记 `UNKNOWN`。
> 日期：2026-09-15

---

## 1. 当前页面结构（实测）

`/requirements`（`RequirementsView.vue`，**393 行**｜Phase 6-B 迁移后）——单路由、单页面，**左右两栏 + 右栏 4 个纵向面板**：

```
section（max-w-[1320px]｜实测内容宽 1061 @1280）
├── PageHeader（eyebrow「需求规划」+ h1「需求」+ actions：「分析/分析中…」Button，disabled 三条件）
└── grid（≥900px → 360px + 1fr｜<900px 单列）
    ├── aside（左栏 360px）
    │   ├── Card「新建需求」：项目 select（原生）+ 标题 Input + 描述 Input + PRD Textarea(rows=7) + 创建 Button
    │   │   实测卡高 **576px**（表单占满左栏）
    │   └── Card「需求列表」（计数 Badge）：loading → error → empty → 列表项（原生 `<button>`，Card 化；
    │       激活态 = Primary 边框 + primary-light + inset 3px）｜实测卡高 **301px**（2 条）
    └── 右栏（1fr｜实测卡宽 677px）
        ├── detailLoading → 「正在加载需求详情…」 / 「请选择或创建需求。」EmptyState / 内容
        ├── 指标行（3 卡：状态 / 版本 / 任务数；`md:grid-cols-3`）——实测值（ANALYZED 需求）：已分析 / v1 / 33
        └── 纵向 4 面板（顺序 = 详情 → 规划事件 → 规格 → 任务 DAG）：
            ① 「需求详情」 h=**1946px**（描述 / 创建时间 / PRD 全文纯文本）
            ② 「规划事件」 h=**137px**（当前为空态「暂无规划事件。」）
            ③ 「规格」     h=**2031px**（7 个规格，每个 = 类型 + `v1` + `<pre>` JSON 块 max-h 220）
            ④ 「任务 DAG」 h=**3761px**（33 个任务节点网格 + 73 个依赖胶囊 flex-wrap）
```

**实测关键数字**（1280×900，真实数据）：
| 指标 | 值 |
| --- | --- |
| 文档高度 | **8247px**（右栏是一条 ~8,200px 的纵向长链） |
| 右栏 4 面板高度 | 1946 / 137 / 2031 / 3761 |
| 面板标题 | 新建需求、需求列表、需求详情、规划事件、规格、任务 DAG（6 个） |
| `article` 节点数 | 40 = 33 任务节点 + 7 规格块 |
| `<pre>` 数 / 依赖胶囊数 | 7 / 73 |
| 横向溢出 | `overflowX = -15`（无） |
| console | 0 error / 0 warning |

**第二条需求（FAILED）实测**：指标 失败 / v1 / **0**；正文出现 3 个空态（「暂无规划事件。」「尚未生成规格。」「尚未生成任务。」）；0 节点 / 0 `<pre>`；文档高度 **1063px** —— 即失败需求下右栏是"3 张空态卡纵向堆叠"。

## 2. 数据 / API / Store / ViewModel 分析（全部冻结）

| 层 | 内容 |
| --- | --- |
| **API**（`api/requirements.ts`，78 行 / **8 导出**） | `createRequirement(projectId,input)` POST｜`listRequirements(projectId)`｜`getRequirement(id)`｜`analyzeRequirement(id,{regenerate})` POST｜`listRequirementSpecifications(id)`｜`listRequirementTasks(id)`（返回 `{tasks,dependencies}`）｜`getTask(id)`（**死代码**）｜`getTaskDependencies(id)`（**死代码**） |
| **Store**（`stores/requirements.ts`，210 行） | state：`requirements / selectedRequirement / specifications / taskGraph / currentAgentRun / loading / detailLoading / creating / analyzing / error`；actions：`loadRequirements` / `loadRequirement`（失败**清空** selected+specs+taskGraph）/ `loadPlanningArtifacts`（**并行** specs+tasks）/ `createRequirement`（头插 + 随后 `loadRequirement`）/ `analyzeSelectedRequirement(regenerate=false)` / `applyAgentRunSnapshot`（终态 → `stopRealtime` + 重载需求）/ `loadAgentRun` / `startRealtime`（**SSE，失败降级为 2s 轮询**）/ `startPolling` / `stopRealtime` |
| **Router** | `/requirements` 单路由（无 meta/守卫/懒加载）；**无深链接**（选中态是本地 `selectedProjectId` + store 的 `selectedRequirement`，**不反映到 URL**） |
| **ViewModel**（`requirementViewModel.ts`，137 行 / **13 导出**） | 文案：`requirementStatusLabel`（草稿/分析中/已分析/失败）、`specificationTypeLabel`（7 类型）、`taskTypeLabel`（12 类型）、`taskStatusLabel`（9 状态）；tone：`requirementStatusTone`、`taskStatusTone`；派生：`latestSpecifications`（**只取最高版本**）、`latestTasks`（只取最高版本）、`dependencyLabel`（`T-001 -> T-002`）、`taskSourceSummary`（来源规格类型串联） |
| **跨页共享**（不可改） | `taskStatusLabel` / `taskTypeLabel` 被 **Workflows** 共享；`eventLabel` / `eventSummary` / `formatDateTime` 来自 `agentRunViewModel`（**Requirements / Workflows / AgentRun 三页共享**） |
| **页面本地状态** | `selectedProjectId`（默认 `projects[0]?.id`）、`title`/`description`/`rawContent`（**有默认值**：Todo 管理系统 / 阶段 3 规划示例 / DEFAULT_PRD）、`currentSpecifications`、`currentTasks`、`currentDependencies`（按当前版本任务过滤依赖） |
| **交互（10 项，冻结）** | ① mounted → fetchProjects → 默认选第一个项目；② `watch(selectedProjectId)` → `loadRequirements`；③ 创建守卫（项目/标题/PRD 非空）→ `createRequirement`，**成功后不清空表单**；④ 列表项点击 → `loadRequirement`；⑤ 分析按钮 disabled 三条件 + `analyzeSelectedRequirement(false)`；⑥ SSE 实时事件 → `currentAgentRun`；⑦ 终态自动重载需求；⑧ unmount → `stopRealtime`；⑨ 表单无 `required`（仅 maxlength 160/1000/20000 + rows=7 + `v-model.trim`）；⑩ 空态/加载/错误分支顺序 |
| **状态分支（7 处）** | 左栏：loading → error → empty（暂无需求。）→ 列表；右栏：detailLoading（正在加载需求详情…）→ 未选中（请选择或创建需求。）→ 内容；4 面板内 3 处空态（暂无规划事件。/ 尚未生成规格。/ 尚未生成任务。） |

**真实数据（本项目唯一）**：
| 数据集 | 值 |
| --- | --- |
| 需求 | **2 条**：`689801fe` **ANALYZED** v1（Todo 管理系统）、`ffb27b71` **FAILED** v1（Todo 管理系统） |
| 规格（ANALYZED） | **7 条**（v1）：REQUIREMENT_ANALYSIS / FUNCTIONAL / TECHNICAL / ARCHITECTURE / API / DATABASE / UI，content 结构各异（如 API→`endpoints`、ARCHITECTURE→`dataFlow,components`、DATABASE→`tables`、UI→`pages`） |
| 规格 / 任务（FAILED） | **0 / 0** |
| 任务（ANALYZED） | **33 条**（T-001…T-033） |
| 依赖 | **73 条**（`T-00x -> T-00y`） |
| 规划事件 | 当前 **0**（分析已结束；仅在再次「分析」时经 SSE/轮询产生） |
| 部署 / MCP | 0（与本页无关） |

## 3. 当前视觉问题（按严重度）

| # | 问题 | 实测证据 | 影响 |
| --- | --- | --- | --- |
| **P1** | **右栏是一条 ~8,200px 的纵向长链**：4 个面板各自"整块"堆叠 | 文档高 8247；面板 1946 / 137 / 2031 / 3761 | 「PRD → 分析 → 规格 → 任务」的**层级存在但不可感知**；用户需要滚动约 8 个视口才能看完一次规划结果 |
| **P2** | **需求详情面板 1946px**：PRD 全文以纯文本 `dd` 展开（无高度上限、无滚动） | 面板高 1946 | 一块 1,946px 的连续文字把后续面板全部推到屏幕之外；与 ③ 规格的 `<pre>`（max-h 220 + 滚动）**呈现不一致** |
| **P3** | **规格面板 2031px**：7 个规格纵向单列，每个 = 类型行 + JSON `<pre>`；**7 块 JSON 形成"代码墙"** | 2031 / 7 ≈ 290px/项 | 规格之间无法横向比较；类型（API / 架构 / 数据库 / UI…）没有形成视觉分组 |
| **P4** | **任务 DAG 面板 3761px**：33 节点网格 + **73 个依赖胶囊**平铺在 flex-wrap 里 | 3761 | 依赖关系是一面"胶囊墙"，占位最大且几乎不可读；节点的 `auto-fit minmax(220px)` 在 677px 宽度下只剩 2~3 列 |
| **P5** | 指标行只有 3 张卡（状态 / 版本 / 任务数），**规格数缺失**，且断点是 `md:`(768px) 而非全局约定 `min-[900px]` | `md:grid-cols-3`；badges 里 7 是规格计数（在面板标题里） | 与 Dashboard/MCP/Projects 的"指标行 4 列 + `min-[900px]`"不一致 |
| **P6** | **FAILED 需求下 3 张空态卡纵向堆叠** | 文档高 1063 中 3 个空态 | 失败需求页显得"什么都没有但很长"；三个"未生成"信息可压缩为一行/一块 |
| **P7** | 左栏「新建需求」卡高 576px（PRD `rows=7` 固定），与 301px 的列表卡并排 | 576 / 301 | 左栏上方长期占据半屏；列表（真正的高频入口）被推到下方 |
| **P8** | 页宽 `max-w-[1320px]` 与其余页面（1180 / 1280）不统一 | 1061（1280 视口下未被限制） | 属 6-B 记录在案的有意保留，跨页一致性上仍是差异项 |

## 4. PNG / Design System 差异

| 项 | 设计 / PNG | 当前实现 | 差异 |
| --- | --- | --- | --- |
| 页面范式 | `07`：Requirements → **Requirement Workspace**；`03 §4/§5`：Workspace = 左资源列表 + 右内容 | 已是「左栏（新建 + 列表）+ 右栏内容」✅ | **结构方向正确** |
| 信息流 | PNG 无需求页原型；设计 `03 §8` 给出 Workflow 页的生命周期：`REQUIREMENT → DESIGN → DEVELOPMENT → VERIFICATION → DELIVERY → OPERATIONS` | 右栏顺序 = 详情 → 规划事件 → 规格 → 任务 | 顺序已符合"PRD → 分析 → 规格 → 任务"，**问题在密度不在顺序** |
| 卡片语言 | Card（白底 + `--border` + 12px 圆角 + 20px 内距）、SectionHeader、StatusBadge | ✅ 已使用 | 无差异 |
| 指标 | PNG：4 列 KPI + 图标块 + 28px 数值 | 3 列 + 无图标块（28px ✅） | 少一列、无图标块、断点不一致 |
| 列表呈现 | PNG 的「我的项目」= **表格**；Projects（11-B）= Card 包表格 | Requirements 左栏 = 卡片式 `<button>` 列表 | 有意差异（列表项是"可选中"的交互元素，非纯资源表）——**建议保留**，但可引入更明确的行内次级信息 |
| 图表 / DAG | 设计未规定 DAG 视觉；PNG 无 DAG 参考 | 节点网格 + 依赖胶囊 | 无参考可依；**禁止引入图库**（+0 依赖），12-B 只能做"网格 + 紧凑列表"的密度优化 |
| 滚动容器 | 设计 §15：允许对长内容使用限高 + 滚动 | 仅规格 `<pre>` 使用 | 12-B 可把同一手法扩展到 PRD / 依赖区（**呈现层**，不改内容） |

## 5. 信息架构建议

**现状心智模型（真实数据）**：
```
项目（Mini Todo）
└── 需求（2 条）            ← 左栏列表（选中态，无 URL 深链接）
    ├── 需求元数据（状态 / 版本 / 标题 / 描述 / 创建时间）
    ├── PRD（rawContent，长文本）
    ├── 规划事件（Agent 运行事件流，SSE；当前为空）
    ├── 规格 Specification（7 条，各自 vN，content 为 JSON）
    └── 任务 Task（33 条，vN）+ 依赖（73 条，T-00x -> T-00y）
```

**建议的页面信息架构（Requirement Workspace）**：
```
PageHeader（需求规划 / 需求 / 分析）
└── [左栏 360px]                         └── [右栏 1fr]
    ① 需求列表（高频入口，**上移**）          ① 指标条（状态 / 版本 / 规格数 / 任务数 —— 4 卡，28px 数值）
    ② 新建需求（表单，**下移**）              ② 需求详情（描述 / 创建时间 / PRD 限高滚动）
                                            ③ 规划事件（实时分析过程）
                                            ④ 规格（≥900px 两列网格；每项 类型 + vN + JSON 限高）
                                            ⑤ 任务与依赖（节点网格 + 依赖紧凑滚动区）
```
- **左栏顺序调整**：把「需求列表」放到「新建需求」之上 —— 列表是主入口、表单是低频操作；这是**纯布局调整**（不改任何表单/列表行为与文案）。
  ⚠️ 该调整会改变 DOM 顺序（测试中断言顺序的地方需同步，属允许修改的测试文件）。
- **右栏顺序保持**：详情 → 规划事件 → 规格 → 任务（= PRD → Analysis → Specification → DAG ✓ 与设计 §8 的生命周期一致）。
- **密度策略（12-B 的实质工作）**：不改内容、不删信息、不新增功能，只做三件事 —— ① **限高 + 滚动**（PRD、依赖区）；② **多列网格**（规格 ≥900px 两列；指标 4 卡）；③ **分组**（规格按类型；依赖按来源任务分组或压缩为紧凑列表）。
- **不引入**：Tabs（虽与设计 §6 模板一致，但当前页面**无 Tab 业务**，且任务书明令禁止）、Breadcrumb、搜索/筛选/排序/分页、DAG 图库、虚拟滚动、折叠面板（Accordion = 新增交互）。

## 6. Phase 12-B 布局方案

改动范围：**仅右栏与左栏的呈现结构**（`RequirementsView.vue` template + scoped 样式），`<script setup>` 仅允许调整 **imports 与呈现层绑定**（规格计数直接用既有的 `currentSpecifications.length`，**无需新增任何 computed**）。

| # | 区域 | 12-B 方案 | 高度影响（实测基线 → 预估） |
| --- | --- | --- | --- |
| 1 | 指标条 | 3 卡 → **4 卡**（状态 / 版本 / **规格** / 任务），`md:grid-cols-3` → `min-[900px]:grid-cols-4`；数值仍 `text-metric`；补图标块（Lucide，与 Dashboard/MCP 一致）可选 | 72 → 72（不变高，横向补齐） |
| 2 | 需求详情 | 描述 / 创建时间保持 `dl`；**PRD 改为限高滚动块**（`max-h-[220px] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted p-3 text-secondary`，与规格 `<pre>` **完全同一语言**） | **1946 → ~420** |
| 3 | 规划事件 | 保持（空态 compact） | 137（不变） |
| 4 | 规格 | `grid grid-cols-1 min-[900px]:grid-cols-2 gap-4`（≥900 两列）；每项 = 类型 + `vN` + `<pre>` 限高 220（保持不变） | **2031 → ~1,150** |
| 5 | 任务与依赖 | ① 节点网格保持 `auto-fit minmax(220px,1fr)`；② **依赖区改为限高滚动**（`max-h-[180px] overflow-auto`）+ 保留 `T-00x -> T-00y` 胶囊与「依赖关系」标签；③ 面板计数 Badge 保留「73 条依赖」 | **3761 → ~2,400** |
| 6 | 左栏 | 「需求列表」Card 与「新建需求」Card **互换顺序**（列表在上）；其余不变 | 合计不变（877） |
| 7 | 页宽 | 保留 `max-w-[1320px]`（6-B 记录在案），**本阶段不动** | — |
| 8 | FAILED 需求 | 3 处空态保留文案与语义；因规格/任务面板本就在网格内，空态天然缩短 | 1063 → ~900 |

**预估结果**：文档高度 **8247 → ~4,300px**（≈ -48%），首屏（900px）内可见：指标条 + 需求详情主体 ✓。

**明确不做（禁止新增）**：Tabs / Breadcrumb / 搜索 / 筛选 / 排序 / 分页 / Accordion / Drawer / Toast / Dialog / DAG 图库 / SVG 拓扑图 / 虚拟滚动 / 新路由 / 深链接 / 自动选中需求 / 新 API / 新数据获取 / SSE 变更 / 轮询变更。

## 7. 组件复用方案

| 需要 | 复用（**全部现有，无需新增**） |
| --- | --- |
| 页头 / 面板 | `PageHeader`（含 actions 分析按钮）、`Card`、`SectionHeader`（含 `#actions` 计数徽标） |
| 徽标 | `Badge variant="secondary"`（计数 / 类型 / 来源 / 依赖）、`StatusBadge` + `requirementStatusTone` / `taskStatusTone` |
| 表单 | `Label` / `Input` / `Textarea` / `Button` + **原生 `<select>`（scoped 样式，保持）** |
| 列表项 | 原生 `<button class="requirement-list-item">`（保持；scoped 激活态） |
| 空态 / 错误 / 加载 | `EmptyState`（`size="compact"`）/ `text-danger` / `text-muted-foreground`（文案逐字保留） |
| 长文本块 | `<pre class="… max-h-[220px] overflow-auto …">`（**已存在**，PRD 与依赖区复用同一类 Tailwind 组合） |
| 图标（可选） | `@lucide/vue`（既有依赖，Dashboard/MCP 已在用） |

**需要新增的纯视觉 ViewModel / tone：无。** `requirementStatusTone` / `taskStatusTone` 已存在；规格计数用 `currentSpecifications.length`；不新增派生统计（避免"无来源数据"）。

## 8. 响应式方案

| 断点 | 布局 |
| --- | --- |
| ≥900px | 两栏 `360px + 1fr`（不变）；指标 **4 列**；规格 **2 列**；任务节点 `auto-fit minmax(220px,1fr)`（约 2~3 列）；事件行 `[minmax(0,1fr)_180px]`（不变） |
| <900px（含 899） | **单列**：左栏（列表 → 表单）在上，右栏内容在下；指标按 `min-[900px]` 复原为单列；规格单列；任务节点单列；事件行折叠为单列（不变） |
| 700px | 同上；所有长文本块 `overflow-wrap: anywhere` / `break-words` 保持；**页面 `overflowX = 0`** |
| 断点约定 | 统一使用 `min-[900px]`（修正现有 `md:grid-cols-3` 的不一致）；**不新增断点** |

## 9. 业务冻结边界

- **API**：`api/requirements.ts` 8 导出、endpoint / 参数 / 方法 / 错误契约不变；**不新增任何数据获取**（仍为 `fetchProjects` → `listRequirements` → `getRequirement` + `specifications` + `tasks`；`analyzeRequirement` 仅在用户点击时触发）。
- **Store**：`stores/requirements.ts` 全文不变（含 SSE `startRealtime` / 2s 轮询降级 / 终态 `stopRealtime` + 重载 / 失败清空三组数据）。
- **Router**：单路由、无深链接；不新增路由或 query 参数。
- **ViewModel**：13 个导出逐字不变（`taskStatusLabel` / `taskTypeLabel` 被 Workflows 共享；`eventLabel` / `eventSummary` / `formatDateTime` 被三页共享）。
- **交互**：§2 的 10 项全部保留（含"创建成功后不清空表单"、"列表点击加载详情"、分析按钮 disabled 三条件、unmount 清理）。
- **表单约束**：maxlength 160 / 1000 / 20000、`rows=7`、三处 `v-model.trim`、**无 `required`**、默认值（Todo 管理系统 / 阶段 3 规划示例 / DEFAULT_PRD）全部保留。
- **分支与文案**：左栏 4 分支 + 右栏 2 分支 + 3 处面板空态的顺序、条件与**逐字文案**不变。
- **数据源引用**：仅 `useProjectsStore` + `useRequirementsStore`；不消费其他 store（Workflows / AgentRuns / Deployments / MCP）。
- **禁止**：Tabs / Breadcrumb / 搜索 / 筛选 / 排序 / 分页 / 折叠交互 / 图表库 / 新组件 / 新依赖 / 新 Token / SSE 或轮询变更 / 修改 `styles.css` / Sidebar / Header / 其他页面 / 创建或修改业务数据。

## 10. 允许 / 禁止修改文件（Phase 12-B）

**允许**
1. `apps/web/src/views/RequirementsView.vue`（template + scoped 样式；`<script setup>` 仅限 imports 与呈现层绑定）
2. `apps/web/src/__tests__/requirementsView.test.ts`（更新/扩展；断言可细化，但**不得删除**对业务行为的断言）
3. `docs/89-phase-12-requirements.md`（实施记录）

**禁止**：`api/requirements.ts`、`stores/requirements.ts`、`router/index.ts`、`viewmodels/requirementViewModel.ts`、`viewmodels/agentRunViewModel.ts`、`styles.css`、`components/**`、`App.vue` / Sidebar / Header、`DashboardView.vue` / `WorkflowsView.vue` 及其他页面、`package.json`、`pnpm-workspace.yaml`、Design Token（`styles/app.css`）。

## 11. 风险与验证方案

| # | 风险 | 影响 | 应对 / 验证 |
| --- | --- | --- | --- |
| R1 | PRD / 依赖区改为**限高滚动**被质疑"隐藏业务内容" | 中 | 明确定位为**呈现层**（与既有规格 `<pre>` 同一手法）；报告记录为有意变化；如需全文可用 `max-h` 调大 |
| R2 | 左栏顺序调整（列表上移）与既有测试断言冲突 | 低 | 同步更新允许修改的测试文件；业务行为（点击/创建）不变 |
| R3 | 真实数据只有 1 个 ANALYZED + 1 个 FAILED 需求 ⇒ 多需求、ANALYZING/DRAFT 状态、非空规划事件**无法端到端验证** | 高 | SSR 契约测试注入多需求/多事件；**不创建测试数据**；必要时用 10-B/11-B 同款**请求级替身**（仅浏览器内，不落库） |
| R4 | 分析按钮一按会触发外部 Agent/LLM（不可逆） | 高 | **本阶段与 12-B 验证均不点击**（沿用 6-B 的纪律）；仅断言 `disabled` 状态 |
| R5 | 33 节点 + 73 依赖的渲染规模 | 中 | 保持纯 CSS 网格 + 限高滚动；**不引入虚拟滚动**；验证 33/73 全量渲染 |
| R6 | 误改共享 ViewModel 造成 Workflows 回归 | 中 | ViewModel 冻结；12-B 结束跑全量测试 + 浏览器复核 `/workflows` 与 `/agent-run` |
| R7 | `overflowX` 回归（限高滚动块引入横向滚动条） | 中 | 浏览器断言 `overflowX = 0`（含页面与各滚动块内部 `scrollWidth` 语义） |
| R8 | 高度预估偏差（-48%） | 低 | 12-B 以**实测文档高度**为验收项（目标 ≤ 5,000px @1280 真实数据） |

## 12. Phase 12-B 验收标准

**代码与契约**
1. `typecheck` / `lint` / `test` / `build` 四道门禁全绿（当前基线：28 files / 214 tests）。
2. 仅 2 个允许文件 + 1 篇文档被改动；`api` / `store` / `router` / 两个 viewmodel / `styles.css` / 组件层 mtime 不变。
3. 既有 12 条 Requirements 契约测试的业务断言不被削弱；新增覆盖：指标 4 卡、PRD 限高滚动块存在、规格 ≥900px 两列、依赖区限高滚动、左栏顺序（列表在表单之前）、分支与文案不变、**无 Tabs/Breadcrumb/搜索/筛选/排序/分页**、**无 legacy 类名**。

**浏览器（真实后端 + 真实数据）**
4. 1280 / 900 / 899 / 700 四档：`overflowX = 0`；console **0 error / 0 warning**。
5. 真实 ANALYZED 需求：指标 已分析 / v1 / 7 / 33；规格 7 块、任务 33 节点、依赖 73 条**全部渲染**；PRD 与依赖区为限高可滚动块（`scrollHeight > clientHeight`）。
6. 真实 FAILED 需求：3 处空态文案不变；文档高度明显低于 ANALYZED 场景。
7. **文档高度**（1280×900，ANALYZED 需求）：从 **8,247px** 降到 **≤ 5,000px**（记录实测值）。
8. 交互回归：列表点击切换详情、创建按钮 disabled 三条件、**分析按钮全程不点击**（仅验证 disabled 状态）、离开页面后无残留定时器/SSE。
9. 响应式：≥900 两栏 + 规格 2 列 + 指标 4 列；<900 单列。
10. **legacy 双通道审计**：页面 DOM 类名 ∩ `styles.css` = `[]`。
11. **回归**：`/`（Dashboard）、`/workflows`（共享 ViewModel）、`/projects`（11-B）页面正常、console 0、`overflowX = 0`。
12. **业务数据零变化**：`GET /api/projects/<id>/requirements` 仍为 **2 条**，规格 **7**、任务 **33**、依赖 **73** 不变。

**交付**
13. 输出：修改文件 / 布局变化 / 视觉变化 / 业务冻结确认 / 测试结果 / 浏览器验证结果（含前后文档高度对比）/ PASS|PARTIAL|FAIL，并落 `docs/89-phase-12-requirements.md`。

## 13. 结论

**PASS**（分析完成，可指导 12-B）

- 已完成：当前结构（实测 8,247px 长链与 4 面板高度）、8 个 API / 210 行 store（含 SSE + 轮询）/ 13 个 ViewModel 导出 / 10 项交互 / 7 处分支的清点、真实数据（2 需求 / 7 规格 / 33 任务 / 73 依赖 / 0 事件）核实、8 条视觉问题（P1–P8）与 6 条设计差异。
- 核心判断：**信息架构（左列表 + 右内容、PRD → 分析 → 规格 → 任务）方向正确，问题是"密度"**——12-B 的实质工作是"限高滚动 + 多列网格 + 分组"三件呈现层改造，预估可将文档高度从 8,247px 压到 **~4,300px**。
- 冻结边界、允许/禁止文件、风险与 13 条验收标准已明确；无需新增任何 ViewModel 纯函数或组件。

**Code changed: NONE ｜ API / Store / Router / ViewModel / CSS / Dependencies / Business data: NONE**

按阶段纪律**在此停止**，不进入 Phase 12-B。
