# 133 · W1 诊断核对与基线归零（实施记录）

**阶段**：W1（对应审评文档 P1）
**日期**：2026-10-14
**前置**：[132-web-frontend-remediation-plan.md](132-web-frontend-remediation-plan.md)（计划与三项冲突裁决）
**性质**：只诊断 + 基线归零。**未开始任何视觉/结构改造。**

---

## 一、本阶段唯一的代码改动

`docs/132` 的冲突 3 裁决为「W1 内先修成绿」。基线 4 个红灯全部是 `PageHeader` 的 `eyebrow` 测试漂移——`PageHeader.vue` 把 `eyebrow` 声明为可选（默认 `""`），**11 个页面无一传它**，测试仍在断言旧页头的 eyebrow 文案。

按 `AGENTS.md` §9「代码权威于文档」的同一原则（实现是权威方），修法是**让测试跟上实现**，而不是把无人使用的 eyebrow 加回 4 个页面。

| 文件 | 删掉的断言 | 保留的断言 |
| --- | --- | --- |
| `__tests__/deploymentsView.test.ts:109` | `toContain("阶段 6")` | `toMatch(/<h1[^>]*>部署/)` 及其余字段断言 |
| `__tests__/projectDetailView.test.ts:108` | `toContain("项目详情")` | `toMatch(/<h1[^>]*>Mini Todo/)`、`href="/projects"`、actions 区断言 |
| `__tests__/mcpServersView.test.ts:93` | `toContain("设置")` | `toMatch(/<h1[^>]*>MCP 服务器/)`、刷新按钮、边界说明逐字断言 |
| `__tests__/mcpAppView.test.ts:63` | `toContain("MCP 应用")` | `toMatch(/<h1[^>]*>沙箱化 UI 应用/)`、返回入口断言 |

同时把 `mcpServersView.test.ts:91` 的用例名从「渲染 PageHeader（沿用既有 eyebrow / 标题）与刷新按钮」改为「渲染 PageHeader（标题）与刷新按钮」——原用例名描述的正是已被移除的 eyebrow，留着会误导。

**没有削弱任何其他断言**：4 个用例各自的标题断言、字段断言、动作区断言、边界文案断言全部原样保留。

**基线对比**

| | 改动前 | 改动后 |
| --- | --- | --- |
| Test Files | 4 failed \| 27 passed (31) | **31 passed (31)** |
| Tests | 4 failed \| 316 passed (320) | **320 passed (320)** |

从此 W2–W10 每个阶段都可以用「全绿」当门槛，不再需要人工比对失败清单。

---

## 二、审评 8 条问题的逐条核对

核对方法：全部以当前代码为准，重新实测，不采信审评给出的计数。结论按「成立 / 部分成立 / 不成立」判定。

### 问题 1 · 双样式体系并存，旧的恒定获胜 —— ✅ **成立**

| 核对项 | 实测 |
| --- | --- |
| `main.ts` 同时引入两个样式文件 | 确认，`main.ts:5-6` `import "./styles/app.css"; import "./styles.css";` |
| `styles.css` 完全未分层 | 确认，全文无 `@layer`，960 行 |
| 对抗补丁数量 | 确认，`grep -rn "text-decoration: none" src/views src/components` 命中 **11 个文件**（`AppSidebar` + 10 个 view；`RequirementsView` 独免） |
| 补丁里点名罪魁祸首的注释 | 确认，`MCPServerDetailView`、`MCPAppView`、`DashboardView`、`MCPServersView`、`AppSidebar` 5 处 |

**审评的诊断是对的，而且我在 W1 里测出了比它更彻底的结论**（见 §三 修正 1）：`styles.css` 的**全部 96 个类选择器都已是零引用死代码**，真正还在生效的只有它的全局元素规则——而那正是全部冲突的来源。

### 问题 2 · 营销落地页的设计语言套在运维控制台上 —— ✅ **成立**

| 核对项 | 实测 |
| --- | --- |
| 仪表盘指标 `text-[72px]` | 确认，`DashboardView.vue:58/64/70`，共 3 处 |
| 流程轨道 + 连线生长 + 数字上升动画 | 确认，`.dashboard-rail` / `.dashboard-dot` / `@keyframes dashboard-rise` / `dashboard-grow` 均在 |
| 段落间距 `gap-14`（56px） | 确认，`DashboardView.vue:43` |
| 字体是从 Google Fonts 加载的 Jost | 确认，`index.html:8-12` |
| 设计文档 §1 Avoid 含「营销落地页式布局」 | 确认，`docs/design/00-design-system.md:31` |
| 设计文档 §4「普通业务页面不要使用超大标题」 | 确认，同文件第 100 行 |
| 绕过 `--text-metric` 令牌 | 确认，令牌是 28px，仪表盘硬编码 72px |

**这是本次改造中证据链最完整的一条**：实现违背的是项目自己写下的规范，不是审评者的偏好。

### 问题 3 · 重构停在半路，legacy class 残留 —— ⚠️ **部分成立，但计数严重失实**

审评说 6 个页面残留 45 处：

| 审评主张 | 实测（词元级精确匹配） |
| --- | --- |
| MCPServerDetailView 21 处 | **0 处** |
| MCPAppView 7 处 | **0 处** |
| MCPServersView、WorkflowsView 各 5 处 | **0 处** |
| AgentRunView 4 处 | **0 处** |
| ProjectsView 3 处 | **0 处** |
| 合计 | **0 处** |

**误报的三种成因**（我逐条查证）：

1. **把注释当成了使用**。`MCPServerDetailView.vue:43-45` 有一行注释写着「legacy 类（page / panel / tab-bar / compact-list / mcp-detail-grid / mcp-status-\* / mcp-risk-\* / mcp-note / status）**全部停用**」——审评把这段**枚举停顿名单的注释**计成了 21 处残留。这是"21 处"的来源。
2. **把前缀类当成了 legacy 类**。`ProjectsView.vue` 里的 `project-row-title` / `project-row-repo` / `project-row-open` 是以 legacy 名开头的新 scoped 类，不是 `.project-row` 本身。
3. **把新类名当成了旧类名**。`mcp-detail-list`（新）被当成 `mcp-detail-grid`（旧）。

**问题 3 中唯一成立的部分**：`styles.css` 里确实积累了成片零引用死类——而且比审评列的更多，是**全部 96 个类选择器无一被引用**。这条对 W2 有实际价值，见 §三修正 1。

### 问题 4 · 同一个动作三种容器 —— ✅ **成立**

| 动作 | 实测 |
| --- | --- |
| 新建 | Requirements / Workflows / AgentRun 用 `Dialog`；**Projects 无 Dialog** |
| 详情 | Requirements / Workflows / AgentRun / Agents 用 `Drawer`；**Projects 无 Drawer**，走 `<RouterLink>` 整页跳转 |

`ProjectsView` 是唯一两者都例外的页面，审评判断准确。`DeploymentsView`、`MCPServersView` 两者都不用（各自是列表+详情双栏布局，属另一种形态，不在审评的对照表内）。

### 问题 5 · 表格能力不足 —— ✅ **成立，且比审评说的更严重**

| 核对项 | 实测 |
| --- | --- |
| 所有 `td` 居中 | 确认，`Table.vue:112` `cn('p-3 align-middle text-center', column.cellClass)` |
| 分页 opt-in（`pageSize` 默认 `0`） | 确认，`Table.vue` `pageSize: 0` 默认 |
| 传了 `:page-size="10"` 的页面 | 确认 **4 个**：`AgentsView:93`、`AgentRunView:305`、`RequirementsView:258`、`WorkflowsView:489` |
| 用了 Table 但没分页 | 确认 **2 个**：`ProjectsView`、`DashboardView` |
| `AgentRunView` 7 列塞进 `min-w-[1100px]` | 确认，`AgentRunView.vue:306` |
| 排序 / 列宽 / 列显隐 / 固定表头 / 行选择 / 批量操作 / 密度切换 / 虚拟滚动 | 全部缺失，确认 |
| 复制 ID 做成每行按钮 | 确认，`AgentRunView` 操作列 |

**一处修正**：审评说「项目列表、仪表盘、部署页都没有分页」——`DeploymentsView` **根本没有使用 `Table` 组件**（它是自有的列表+详情布局），所以它不在"该有分页却没有"的范围内。真正的问题是 `ProjectsView` 与 `DashboardView` 这两个用了 Table、却没传 `pageSize` 的页面。

### 问题 6 · 信息架构缺件 —— ✅ **成立**

| 核对项 | 实测 |
| --- | --- |
| 顶栏只显示两个字 | 确认，`AppHeader.vue` 只渲染 `route.meta.group ?? title` |
| 侧栏 7 项无图标、图标是死代码 | 确认，且**实际 import 8 个**（含 `Workflow`），`NavItem.icon` 已声明，模板只渲染 `nav-dot` |
| 无面包屑 | 确认，`grep -rn "breadcrumb" src/` 仅在 2 个测试文件里出现（且是作为"不应出现"的守卫） |
| 无全局搜索 / Cmd+K | 确认，全 src 零命中 |
| 无通知、无用户菜单 | 确认 |
| 侧栏无分组计数、不可折叠 | 确认 |

### 问题 7 · 可访问性与韧性 —— ✅ **成立**

| 核对项 | 实测 |
| --- | --- |
| `<html lang="en">` | 确认，`index.html:2` |
| favicon 是 `data:,` | 确认，`index.html:4` |
| 状态只靠颜色 + 文案 | 确认，`StatusBadge.vue` 只做 `tone → 视觉` 映射，无图标维度 |
| 字体依赖 Google Fonts CDN | 确认，`index.html:8-12`（Asia/Shanghai 环境可达性存疑） |
| 无暗色模式、未声明 `color-scheme` | 确认，`app.css` + `styles.css` 零命中 |
| 加载态是纯文字 | 确认，`src/views` 里 **9 处**「正在加载」 |
| 无骨架屏 | 确认，零命中（`grep -i "skeleton"` 只命中「页面骨架」这类词） |
| `tabular-nums` 依赖 Jost 提供 `tnum` | **未实测**，列为待验证项（W3 字体定案时一并验证） |

### 问题 8 · 改样式会打断 23 个测试文件 —— ✅ **成立，但审评漏报了基线本来就红**

- 23 个测试文件、`uiComponents.test.ts` 61 处 `classes(`、`commonComponents.test.ts` 13 处：**确认**。
- **漏报**：审评说「你做任何视觉改造，测试套件都会变红」，但没提**套件此刻已经不绿**——4 failed / 316 passed。这一条已在本阶段修掉（§一）。

---

## 三、对审评文档的三条修正

`AGENTS.md` §9：文档与代码冲突必须报告。以下三条是审评结论与代码实测不一致之处，均已在本文件内纠正，**不修改审评文档原文**（它是外部输入的审评意见，不是本仓库产物）。

### 修正 1 · Problem 3 的 legacy class 计数全部失实，但结论方向正确

- **失实**：45 处残留 → 实际 **0 处**。成因见 §二 问题 3。
- **更重要的是**：审评因此把 W2 描述成"要把散落各页的 legacy class 逐个收拾干净"，实际不是。真实情况是——

  > **`styles.css` 的 96 个类选择器，无一被真实标记引用。整个文件的类规则层是 100% 死代码。**

  我用的测法是把 `styles.css` 的选择器全集与全部 `.vue` 里的 `class="…"` / `:class="…"` 词元做交叉比对（先剥离块注释、HTML 注释、行注释），并已用「Tailwind 工具类是否正常命中」验证测法本身有效（采集 2360 个词元 / 325 个不同类名 / `flex`、`bg-card`、`text-body` 等全部命中；另确认无单引号 class 属性、无运行时反引号拼接类名、无非 scoped `<style>` 块，排除漏测）。

- **对 W2 的影响**：W2 从"逐页清理残留"变成"整体删除死文件 + 迁移 6 类全局元素规则"。工作量比审评预估的小，但**必要性不变**——因为 `styles.css` 里真正还在生效的恰恰是最有害的那部分：

  仅存的全局元素规则：`:root`（`color` / `background` / `font-family`）、`*`（`box-sizing`）、`body`（`margin`）、`a`（`color` / `text-decoration`）、`a:hover`、`button, input, select, textarea`（`font: inherit`）。

  其中 `a { color: #15756a }` 未分层且带元素选择器，恒定压过 `@layer utilities` 里的 `text-*` 工具类——这就是 11 处对抗补丁存在的唯一原因，也是「配色怎么改都不对」的机制。

### 修正 2 · 审评漏报「基线本来就是红的」

已在 §一 处理，基线归零。

### 修正 3 · 侧栏图标数量

审评写「导入了 Activity、Bot、FileText、FolderKanban、LayoutDashboard、Rocket、Server」（7 个）；实际 import **8 个**，多一个 `Workflow`（用于「工作流」菜单项）。结论（图标是死代码）不变，只是数量修正。W4 实现时要渲染的是 8 个。

---

## 四、投入产出比最高的 3 个改动

按「改动成本 ÷ 消除的用户可感知问题」排序。

### 1️⃣ `Table.vue:112` 去掉 `text-center`（成本：一行）

**为什么第一**：这是唯一一处**改一行就同时改善 6 个页面**的改动。`ProjectsView`、`DashboardView`、`RequirementsView`、`WorkflowsView`、`AgentRunView`、`AgentsView` 全部经由这一个 `td` 渲染单元格，而所有文本列现在都在居中对齐——项目名、任务标题、仓库 URL 全部居中，**长列表无法纵向扫读**。这直接对应审评的第三条主观标准（"能不能不移动眼球把一列名称从头扫到尾"）。

配合 W7 的列对齐规则（文本左 / 数字右 + 等宽 / 状态统一 / 操作右），一行改动即可让全站表格观感回到正常。

### 2️⃣ 删掉 `styles.css`（成本：一次整体迁移，风险中等但可控）

**为什么第二**：它是**根因**，不是症状。只要它还在，W3 定义的所有令牌都会被它的全局规则按优先级覆盖——**W3 之后的每一步视觉改动都会"改了不生效"**。反过来，删掉它之后，11 处对抗补丁（`AppSidebar` + 10 个 view + `Table.vue` 的排版兜底）也必须一并消失，代码里会立刻少掉一层"为什么这里要重复声明 color"的困惑。

前面实测已证明它 100% 是死类 + 6 类全局元素规则，所以删除的**爆炸半径比审评预估的小得多**：没有别的地方引用它，只有 `main.ts:6` 一行。

### 3️⃣ 把 `ProjectsView` 改成和其它页一致的容器（成本：一个页面）

**为什么第三**：这是"操作起来比较奇怪"的**唯一具体来源**。用户的肌肉记忆在需求页学会的是「点行看抽屉、点右上角新建」，到项目页这两条全部失效（点行整页跳走、新建是常驻 360px 左栏表单占掉四分之一屏）。同一套动作跨页不一致，消耗的是每次切换页面的认知成本。

三个改动里它最小，但它是用户**当场能感觉到**的那个。

---

## 五、阶段报告

### Modified Files

- `apps/web/src/__tests__/deploymentsView.test.ts` — 删除 1 条 eyebrow 断言
- `apps/web/src/__tests__/projectDetailView.test.ts` — 删除 1 条 eyebrow 断言
- `apps/web/src/__tests__/mcpServersView.test.ts` — 删除 1 条 eyebrow 断言 + 修正 1 处用例名
- `apps/web/src/__tests__/mcpAppView.test.ts` — 删除 1 条 eyebrow 断言
- `docs/132-web-frontend-remediation-plan.md` — 记录三项冲突裁决结果
- `docs/133-web-frontend-diagnosis.md` — 本文件

**没有改动任何生产代码**（`src/views/`、`src/components/`、`src/styles*` 全部未动）。

### Implementation

诊断与基线归零。详细核对见 §二。

### Architecture Changes

无。本阶段不涉及架构。

### Dependencies

无新增依赖。

### Tests

```
Test Files  31 passed (31)
     Tests  320 passed (320)
```

改动前为 4 failed | 316 passed。4 条被删断言的性质与理由见 §一。

### Lint

`eslint "src/**/*.{ts,vue}"` 通过，无输出。

### Typecheck

`pnpm --filter @ai-se/shared build && vue-tsc --noEmit` 通过，无输出。

### E2E

未运行。本阶段未改生产代码，且仓库的 API 级 e2e 针对后端，与本次前端改动无关。

### Known Issues

1. `tabular-nums` 是否真的生效**未实测**——Jost 不保证提供 `tnum` 特性。W3 字体定案时必须验证，若无效则换字体（审评问题 7 已提出，本阶段只登记不处理）。
2. `apps/web` 在 390px 宽度下的移动端表现未评估（侧栏固定 164px）。属于 W4/W9 范围。
3. 审评文档是外部输入，本文件对其三处失实做了修正记录，但**未修改审评原文**。

### Acceptance Result

**通过。** W1 的两项交付（诊断核对、基线归零）均完成，四项门槛命令全绿：

```
typecheck ✓   lint ✓   test 320/320 ✓   build ✓
```

### Next Phase Boundary（W2 · 拆除双样式体系）

**STOP。本阶段到此为止，不自动进入 W2。**

W2 的范围（依据本阶段实测修正后的口径）：

1. 删除 `styles.css` 本体与 `main.ts:6` 的引入（96 个类选择器已确认全部零引用）
2. 把 6 类全局元素规则迁进 `app.css` 的 `@layer base`：`:root`、`*`、`body`、`a`、`button/input/select/textarea`
3. **重新设计链接默认色**：不把「链接一律青绿 + hover 下划线」带进新体系，改为默认继承颜色
4. 删除 11 个文件里的对抗补丁（`AppSidebar` + 10 个 view + `Table.vue` 的排版兜底）
5. 建立 `@layer base → components → utilities` 层级，确保工具类能覆盖组件层
6. 同步更新 `__tests__/` 里受影响的结构断言，逐条报告

**未开始事项（STOP）**：W3–W10 全部未开始。`eyebrow` prop 的去留推迟到 W5 决定。`.taste-skill/` 目录推迟到 W10 清理。
