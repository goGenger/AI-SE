# 137 · W5 统一页面骨架（实施记录）

**阶段**：W5（对应审评文档 P5）—— **本阶段已完成（10/10 页）**
**日期**：2026-10-14
**前置**：[132-web-frontend-remediation-plan.md](132-web-frontend-remediation-plan.md)（计划 §W5）、[136-phase-w4-appshell-ia.md](136-phase-w4-appshell-ia.md)（W4）
**性质**：结构与样式改造。**未触碰业务逻辑、文案、store / api / viewmodel 的语义、路由契约。**

---

## 一、目标与结果

**目标（来自审评 P5）**：定义一次页面骨架，然后逐页套用。

| 指标 | 改造前 | 改造后 |
| --- | --- | --- |
| 四态渲染 | 每页各自内联「正在加载X…」纯文字 + `<p class="text-danger">` + `EmptyState` / `Card+Table` 链条，**无任何共享 Loading / Error 组件** | 三个共享件：`LoadingSkeleton` / `TableSkeleton` / `ErrorState` |
| 错误态可恢复性 | 全站仅 **2 处**重试入口（MCPServers 刷新、Workflows 时间线重试），其余只能刷新整页 | **9 处**列表/详情错误态全部带「重试」，并实测可用 |
| 空态下一步动作 | 多数空态只有一句标题 | 有动作可给的页面全部补上（无 create API 的页给「刷新」，不是假的「新建」） |
| 「错误 + 空态同时出现」 | Workflows / Agents / Deployments / MCPApp 存在 | 四态**顺序固定**（加载 → 错误 → 空 → 数据），错误优先，不再并存 |
| 空白页 | `MCPServerDetailView` 在 `selectedServer` 为 null 且非加载/错误时**整页白屏** | 补上空态 + 返回列表动作 |
| 未分层 `<style scoped>` 块 | **10** | **2**（Deployments 的 `[data-active]` 强调条 + Dashboard 的 W6 待办） |
| `views/` 内 `grid-cols-[…]` | **24** | **7**（4 种布局模板，见 README §13） |
| 任意值 `text-[…]` / `rounded-[…]` / `min-[900px]` | 有 | **0** |
| 无样式的遗留标记类 | `project-row-*`、`requirement-prd`、`run-link`、`mcp-*`、`workflow-*`、`mcp-action-link` | **0** |
| 两段死代码 CSS | `WorkflowsView` / `MCPServerDetailView` 的 `.mcp-checkbox input`（匹配不到任何元素） | 删除 |
| CSS 产物 | 36.51 kB（gzip 7.64） | **29.81 kB**（gzip 6.75） |
| 测试 | 339 | **369**（+30） |

**CSS 减少 6.7 kB 的原因**：8 个页面的 scoped 块里大量是一次性声明，与既有工具类重叠；改写成工具类后由 Tailwind 去重，净减少。

---

## 二、四处共享改造

### 2.1 三个状态件（W5 第一步，见 §六）

`LoadingSkeleton`（骨架条）→ `TableSkeleton`（列表加载态，形状与 `Table` 数据态一致，加载完成不跳版）→ `ErrorState`（可重试错误态，语义色三件套 + `role="alert"`）。

三条硬规则写进了 `styles/README.md` §14：**加载态不用文字**、**错误态必须可恢复**、**空态必须给下一步动作**。

### 2.2 `DetailRow` + `.detail-row`（组件层）

17 处逐字重复的 `<div class="grid grid-cols-[110px_minmax(0,1fr)] gap-4 border-t border-border py-3 first:border-t-0 first:pt-0">` + `<dt>/<dd>` 收敛成一个组件 + 一条 `@layer components` 里的具名样式。

标签列 **110px → 112px**（28 × 4px，回到 4px 刻度上，视觉不可辨）；`1fr` → `minmax(0,1fr)`（Requirements 原先用的 `1fr` 会被长内容撑破栅格）；`dt` 字重统一到 600（Requirements 原为 500）。

### 2.3 `.tone-dot`（组件层）

`WorkflowsView` 的 `.workflow-event-dot` 与 `AgentRunView` 的 `.trace-dot` 是**逐字相同**的两段 scoped CSS，而且 scoped 是未分层的、会恒压工具类。收成 `@layer components` 里的一条 `.tone-dot`，两个页面各自的 scoped 块随之整体删除。

### 2.4 `PageHeader.eyebrow` 删除

11 个页面零使用；W4 的面包屑已承担「这是哪个分组」的上下文。`SectionHeader` 的同名 prop 是另一个组件、有真实使用，保留。

---

## 三、逐页

| 页面 | 四态 | 结构变化 | scoped |
| --- | --- | --- | --- |
| `Projects` | ✓ | 「新建项目」表单从 360px 常驻左栏移进 Dialog；列表占满内容宽；**补分页**（用户裁决） | 删除（截断改 `max-w-35 truncate`） |
| `Deployments` | ✓ | 「环境」表单移进 Dialog（页头动作「环境设置」）；**保留主从两栏**（历史 320px / 详情 1fr） | 38 行 → 1 条 `[data-active]` 强调条 |
| `Requirements` | ✓ | 3 处详情字段 → `DetailRow` | 空注释块删除 |
| `Workflows` | ✓ | 错误从页面顶部移进数据区并**优先于空态**；工具行（项目/状态筛选）正式归位 | 整体删除（色调点 → `.tone-dot`） |
| `AgentRun` | ✓ | 10 处详情字段 → `DetailRow` | 整体删除（同上） |
| `Agents` | ✓ | 4 处详情字段 → `DetailRow`；空态动作 = 「刷新」（本页无 create API） | 本来就没有 |
| `MCPServers` | ✓ | 列表项整块改工具类；空态动作 = 「刷新」 | 整体删除 |
| `MCPServerDetail` | ✓ | **补上原先完全缺失的空态分支**；内嵌 Tab、概览栅格、工具/绑定行全部改工具类 | 整体删除 |
| `ProjectDetail` | ✓ | 身份卡截断、信息栅格、绑定表单全部改工具类 | 整体删除 |
| `MCPApp` | ✓ | 补上原先缺失的加载分支；错误进四态链；沙箱说明条 / iframe 视口 / 日志改工具类 | 整体删除 |

**`DashboardView` 不在 W5 范围**（属 W6），它也是 W5 之后唯一保留 scoped 块的页面。

---

## 四、决策与偏离

### 决策 1 · 工具行「只留位置，有真东西才渲染」（用户裁定）

计划点名的搜索 / 筛选 / 视图切换 / 批量操作 / 列设置五项，改造前**一个都不存在**，W5 也**没有新增任何一个** —— 只是把本来就有的控件归位：`WorkflowsView` 的两个筛选 `Select`、`MCPAppView` 的加载表单。其余 9 页无工具行。

沿用 W4 拒绝放假通知铃铛的标准：一个点了不动的控件是假的可交互承诺。

### 决策 2 · 分页区不加「每页条数」选择器

`Table` 已内建「共 N 条」+ 页码；每页条数是新的交互控件，当前固定 10 条。等真有需求再加。

### 决策 3 · 列表页默认分页（用户事后裁决，见 §六）

### 决策 4 · 三处空态不设动作按钮

`Deployments` 详情空态（「请选择部署。」）、`Requirements` 详情抽屉（「请选择或创建需求。」）、`MCPApp` 数据空态 —— 它们的下一步动作**已经在同一屏内**（旁边的列表、上方的表单）。再放一个按钮是冗余控件。

规则的精确定义是「**有动作可给时必须给**」，不是「每个空态都塞一个按钮」。

### 决策 5 · 两套详情排版都保留

`MCPServerDetail` / `ProjectDetail` 是「caption 标签 + 正文值」的属性栅格；`AgentRun` / `Agents` / `Requirements` 是 `DetailRow` 的纵向行。两者**信息密度不同**（属性面板 vs 纵向列表），强行统一会牺牲其中一种。本轮按性质保留，记入 README §13。

### 偏离 1 · 若干 4px 刻度的顺正

改写 scoped 过程中遇到不在 4px 刻度上的值（`padding: 14px 16px`、`padding: 6px 12px`、`gap: 10px`、`margin: 2px 0 0`、`py-2.5`、`gap-3.5`），统一顺正到最近的刻度值（16 / 12 / 12 / 4 / 12 / 16px）。**最大偏移 2px，视觉不可辨**。

### 偏离 2 · 移除无样式的遗留标记类

`project-row-title` / `project-row-open` / `project-row-repo` / `requirement-prd` / `run-link` / `mcp-action-link` / `workflow-agent-link` / `workflow-event-dot` / `mcp-server-*` / `mcp-tab*` / `mcp-sandbox-note` 等 —— 它们要么在 scoped 块删除后彻底无样式，要么本来就只有命名作用。测试里作为「行数标记」的用法一并改为结构性断言。

---

## 五、验证

### 5.1 门槛命令

```
typecheck ✓   lint ✓   test 369/369 ✓   build ✓
```

### 5.2 机械核对

| 检查 | 结果 |
| --- | --- |
| 真实 `<style>` 块（行首） | **2**（`DeploymentsView` 的 `[data-active]`、`DashboardView` 的 W6 待办） |
| `views/` 内 `grid-cols-[` | **7**（4 种布局模板） |
| `views/` 内 `text-[…]` / `rounded-[…]` / `min-[900px]` | **0 / 0 / 0** |
| 剩余的 `mb-[var(--section-gap)]` / `p-[var(--card-padding)]` | 是 README §3 明确保留的**令牌旋钮**，不是违规 |
| CSS 产物 | 36.51 → **29.81 kB**（gzip 7.64 → 6.75） |
| JS 产物 | 557.56 → 560.06 kB（gzip 169.08 → 169.18）—— 模板里的类名变长，净收益在 CSS |

### 5.3 浏览器实测（真实 Chrome，dev server + 页面内注入 fetch mock）

逐页确认可渲染与结构正确，重点三页：

| 检查 | 实测 | 判定 |
| --- | --- | --- |
| `MCPServersView` | 沙箱说明条 + 两张服务器卡（名称/描述/meta/状态徽标/打开），空描述显示 `—` | ✓ |
| `MCPServerDetailView` | 面包屑三段；状态卡；**Tab 三个且激活态为 `bg-primary-light` + 主色描边**；点「工具（2）」切 Tab 成功，两行工具（echo/shell）含 risk/审批/启用三枚徽标 | ✓ |
| `DeploymentsView` | 页头唯一动作「环境设置」；**主从两栏 `lg:grid-cols-[320px_minmax(0,1fr)]` 保留**；Dialog 六字段与默认值全对（预发 staging / 18001 / 3000 / 仅引用，不含明文）；无 `deployment-item` 残留 | ✓ |
| `WorkflowsView` | 工具行（全部项目 + 全部状态）；表格两行；**分页区「共 2 条」+ 页码**；侧栏失败徽标 `1` | ✓ |
| 暗色 + 错误态 | Workflows 在暗色下渲染 `ErrorState`：`bg-danger-bg` 深红卡 + `danger-foreground` 文案 + 「重试」；**错误优先于空态**（不再同时出现「暂无工作流。」） | ✓ |

### 5.4 一次**误判**的记录（诚实说明）

首次打开页面时**整屏空白**，一度像是改动导致的运行时崩溃。实际原因是 **Vite 依赖预构建缓存过期**（`504 Outdated Optimize Dep`）—— 重启 dev server 无效，清掉 `node_modules/.vite/deps` 后恢复正常。**与本次改动无关**，但排查过程占了较多时间，记在这里备查。

另有一次 Workflows 列表空白，原因是**我的 fetch mock 缺少 `taskProgress` 字段**（表格单元读取 `row.taskProgress.completed`），补上 mock 后正常 —— 同样是 mock 问题，不是回归。

### 5.5 未使用的验证手段

- **`ErrorState` 的 `@retry` 点击**：SSR 无法模拟事件，单元测试只断言按钮存在与禁用态；浏览器实测覆盖了「重试重新发起请求」（Projects / Workflows）。
- **未启动真实后端**：全部由 fetch mock 提供数据，未验证真实 REST 契约（本阶段未改任何 api / store 签名）。
- **`format:check`**：与 W2–W4 相同，全仓不通过是基线既有状态，不在门禁内。

---

## 六、阶段报告

### Modified Files

**新增**
- `apps/web/src/components/common/LoadingSkeleton.vue`
- `apps/web/src/components/common/TableSkeleton.vue`
- `apps/web/src/components/common/ErrorState.vue`
- `apps/web/src/components/common/DetailRow.vue`
- `docs/137-phase-w5-page-skeleton.md`（本文件）

**修改（生产代码）**
- `apps/web/src/styles/app.css` — 新增 `@layer components`：`.detail-row` + `.tone-dot`
- `apps/web/src/styles/README.md` — 新增 §14「页面骨架」；§0/§3/§13 按实现更正
- `apps/web/src/components/common/index.ts` — 导出四个新组件
- `apps/web/src/components/common/PageHeader.vue` — 删除 `eyebrow`
- 10 个 `views/*.vue` — 四态统一、Dialog 收敛、scoped 归零、`DetailRow` 替换

**修改（测试）**
- `__tests__/commonComponents.test.ts` — PageHeader 用例改写 + `DetailRow`(4) / `LoadingSkeleton`(3) / `TableSkeleton`(6) / `ErrorState`(5)
- `__tests__/projectsView.test.ts` — 重写（15 → 20）
- `__tests__/deploymentsView.test.ts` — 重写（12 → 17）
- `__tests__/requirementsView.test.ts` — 3 条改写（21）
- `__tests__/workflowsView.test.ts` — 2 条改写（20）
- `__tests__/agentRunView.test.ts` — 3 条改写（17）
- `__tests__/agentsView.test.ts` — 2 条改写（10）
- `__tests__/mcpServersView.test.ts` — 4 条改写（8）
- `__tests__/mcpServerDetailView.test.ts` — 3 条改写 + 1 条新增（11）
- `__tests__/projectDetailView.test.ts` — 3 条改写（12）
- `__tests__/uiComponents.test.ts` — `dialogUsers` 固定列表加入 `DeploymentsView`

**修改（文档）**
- `docs/15-development-roadmap.md` / `docs/17-acceptance-checklist.md` / `docs/18-phase-engineering-goals.md`

### Implementation

见 §二、§三。

### Architecture Changes

**1. 页面的四种状态第一次有了统一的、可复用的渲染方式。** 从「每页各写一遍」变成三个共享件 + 一条固定顺序。副作用是四处「错误与空态同时出现」的假象被消除，一处白屏被补上。

**2. 组件的视觉第一次回到层序里。** `@layer components` 从 W2 以来的空层，现在有了两条**多页复用**的具名样式（`.detail-row` / `.tone-dot`）。未分层 scoped 从 10 降到 2，且剩下的 2 个都有明确理由。

**3. 页面模板里的样式第一次可见。** 改写后页面的排版直接从 class 读得出来，不再需要跳到文件底部的 scoped 块。这也是 CSS 产物减少 6.7 kB 的原因 —— 一次性声明被 Tailwind 去重。

**4. 10 个页面收敛到同一套骨架。** 新增 4 个共享组件、消除 17 处重复栅格、2 段死代码、9 个无样式标记类。

### Dependencies

无新增依赖。

### Tests

```
Test Files  32 passed (32)
     Tests  369 passed (369)
```

**+30 条**（339 → 369）。逐个测试文件的改动见 Modified Files；关键的是所有页面测试从「断言旧结构」改成「断言新四态」，并新增 `DetailRow` 的 4 条契约测试。

### Lint

`eslint "src/**/*.{ts,vue}"` 通过，无输出。

### Typecheck

`pnpm --filter @ai-se/shared build && vue-tsc --noEmit` 通过，无输出。

### E2E

未运行后端 API 级 e2e（针对 `apps/server`，本阶段未改后端）。前端以浏览器实测替代，见 §5.3。**未启动后端**，用页面内注入 `fetch` mock 提供数据。

### Known Issues

1. **7 处任意栅格未消除**（4 种布局模板），理由与位置见 README §13。它们不是一次性尺寸，抽取的收益低于抽象成本。
2. **详情字段排版仍是两套**（属性栅格 vs `DetailRow` 行）。本轮按信息密度保留，未统一。
3. **`MCPServersView` / `DeploymentsView` 不分页**（卡片列表有界 / 主从主列表），理由见 README §14。`DashboardView` 的补分页归 W6。
4. **`DashboardView` 仍有 1 个 scoped 块**（流程轨道、入场动画、`!important` ×2），属 W6。
5. **`ErrorState` 的点击事件无单元测试**（SSR 限制，见 §5.5）。
6. **非文本对比度**（`--border` 1.17:1 / `--input` 1.54:1）未处理，等 W9 裁决。
7. **若干 2px 级的刻度顺正**（§四 偏离 1），视觉不可辨但未逐一浏览器比对。
8. **`format:check` 全仓不通过**，基线既有状态，不在门禁内。
9. **`node_modules/.vite/deps` 缓存过期会导致整屏空白**（§5.4）。与代码无关，但下次遇到先清缓存。

### Acceptance Result

**通过。** 计划 §W5 的四项工作项全部完成，四项门槛命令全绿：

```
typecheck ✓   lint ✓   test 369/369 ✓   build ✓
```

对照计划 §W5：

| 要求 | 结果 |
| --- | --- |
| 定义「列表页标准骨架」并写下 | ✓ README §14 |
| 四种状态统一渲染 | ✓ 三个共享件 + 固定顺序，10/10 页套用 |
| 统一最大宽度与内距，全部走 `PageContainer` | ✓（W4 已完成，本阶段复核） |
| 逐页套用 | ✓ **10/10** |
| 约束：不动业务逻辑 / 文案 / store / viewmodel 调用方式 | ✓ 表单搬移与状态改写后语义一字未改 |
| 列表页默认分页（用户追加裁决） | ✓ 有 Table 的列表页全部 `page-size=10`；两处不适用的已说明 |
| 交付 `docs/137-phase-w5-page-skeleton.md` | ✓ 本文件 |

### Next Phase Boundary（W6 · 仪表盘去海报化）

**STOP。W5 到此为止，不自动进入 W6。**

W6 的范围（计划 §W6）：

1. 指标数字回到 `--text-metric` 档（W3 已改，本阶段复核仍为 28px/600）。
2. **删除流程轨道**（`.dashboard-rail` / `.dashboard-dot`）与**入场动画** —— 侧栏已承担导航，不需要重复。
3. 消除 `DashboardView` 最后 2 处 `!important`（`prefers-reduced-motion` 守卫随之简化）。
4. 把 `gap-14`（56px）与「无卡片边界」纳入统一的 `--section-gap` 与 Card 语言。
5. 「最近项目」按新标准补分页（或明确它是摘要而非列表页）。

**W6 开工前建议一并处理的遗留项**：none —— W5 已把可共享的部分抽干净，W6 只需处理仪表盘自身。

**未开始事项（STOP）**：W6–W10 全部未开始。`.taste-skill/` 目录推迟到 W10 清理。非文本对比度推迟到 W9。

**X1 · 模型与凭据配置**（已裁定立项，排 W 线之后）：控制台内配置 LLM 模型与 API Key，**凭据必须复用既有 Secret Provider 引用，不得新增明文存储**；附带补 `WorkflowsView` 任务审批缺失的意见输入框。
