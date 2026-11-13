# 142 · W10 终验（验收报告）

**阶段**：W10（对应审评文档 P10，前端可用性改造 W1–W10 的收口）
**日期**：2026-10-14
**前置**：[132-web-frontend-remediation-plan.md](132-web-frontend-remediation-plan.md)（计划 §W10）、docs/133–141（W1–W9 实施记录）
**性质**：终验。**本阶段只做三件事：机械检查、逐条对照、诚实报告 —— 不新增功能、不改视觉。**

---

## 第一步 · 机械检查（命令与原始输出）

### 1. 双样式体系：`styles.css` 已删且无引用

```
$ ls apps/web/src/styles.css
ls: apps/web/src/styles.css: No such file or directory

$ grep -rn "styles.css" apps/web/src apps/web/index.html      # 生产文件
（无输出）
```

**达标。** 样式唯一来源是 `apps/web/src/styles/app.css`（目录内另有 `README.md` 作为规范文档）。

### 2. 没有用于样式覆盖的 `!important`

```
$ grep -rn "!important" apps/web/src --include="*.vue" --include="*.css" | grep -v __tests__
apps/web/src/views/DashboardView.vue:41: * 两处 `!important`（那是给动画做的 prefers-reduced-motion 守卫，动画没了守卫也就不需要）。
```

**达标。** 唯一命中是 `DashboardView` 的注释，说明「W6 删掉了那两处」。生产代码 **0 处**。

### 3. 没有一次性任意值

```
$ grep -rnE "(w|min-w|max-w|h|min-h|max-h|text|rounded|gap|p|m)-\[[0-9]+px\]" \
    apps/web/src/views apps/web/src/components
（无输出）

$ grep -rnE "(min|max)-\[[0-9]+px\]:" apps/web/src/views apps/web/src/components
（无输出）
```

**达标。** `text-[72px]` / `w-[240px]` / `min-[900px]` 这类固定像素的一次性值与任意断点**全部归零**。

剩余的 arbitrary value **只有两类，逐条列明**（都在 `components/`，不在 `views/`）：

| 位置 | 值 | 性质 |
| --- | --- | --- |
| `ui/dialog/Dialog.vue` | `w-[min(560px,92vw)]`、`max-h-[min(85vh,900px)]` | 视口相对钳制 —— 弹层必须「560px 或 92vw，取小者」，具名刻度表达不了 |
| `ui/drawer/Drawer.vue` | `w-[min(720px,92vw)]` | 同上 |
| `layout/CommandPalette.vue` | `w-[min(640px,92vw)]`、`max-h-[70vh]`、`top-[12vh]` | 同上 |
| `ui/select/Select.vue` | `max-h-[min(20rem,var(--reka-select-content-available-height))]` | 跟随原语给出的可用高度 |
| `layout/AppSidebar.vue`、`common/PageContainer.vue` | `w-[var(--app-sidebar-width)]` 等 4 处 | **引用设计令牌**（`var()`），恰恰是规范鼓励的写法 |

### 4. legacy 类名已清除

```
$ grep -rn "page-header\|status-pill\|compact-list\|project-row\|detail-grid\|event-timeline\| \
    tool-call-row\|mcp-detail-grid\|deployment-layout\|tab-bar\|mcp-app-frame\|workflow-checkbox\| \
    nav-link\|agent-link\|mcp-action-link\|requirement-dependencies" \
    apps/web/src/views apps/web/src/components
```

**命中 6 行，全部是注释**（说明「这些是被替掉的旧标记」），**class 属性里 0 处**：

| 命中 | 内容 |
| --- | --- |
| `PageHeader.vue:15` | 注释：「与 legacy `.page-header` 的差异」 |
| `SectionHeader.vue:12` | 注释：举例说明它替掉的旧 markup |
| `MCPAppView.vue:41`、`MCPServerDetailView.vue:53` | 注释：列出该页逐步清掉的 legacy 类 |
| `DeploymentsView.vue:236` | **不是 legacy** —— `SectionHeader.eyebrow` 是活 prop |
| `PageHeader.vue:11`、`SectionHeader.vue:11/14/24/29/39` | `SectionHeader` 的 `eyebrow` prop 定义与绑定（W5 裁定保留） |

`eyebrow` 的情况在**上表以外**单独说明：`PageHeader.eyebrow` 已在 W5 删除；命中的是**另一个组件** `SectionHeader` 的同名 prop，有 1 处真实使用（`DeploymentsView:236`）。这与 W5 的裁定一致（计划原话：「`SectionHeader.eyebrow` 是另一个组件、有真实使用，保留」）。

> **W10 额外查出 5 个不在点名清单里的死类名**（无 CSS 规则，靠「产物 CSS 里找不到规则」扫出来的）：`nav-link`、`nav-link--active`、`agent-link`、`mcp-action-link`、`requirement-dependencies`。全部删除，并把依赖它们的测试改用真实语义定位（`aria-current="page"`、`href`、`<nav>` 作用域）。

### 5. 视图与组件里没有 `text-decoration: none`

```
$ grep -rn "text-decoration: none" apps/web/src/views apps/web/src/components
（无输出）
```

**达标。** W2 之前 11 个文件靠这个覆盖全局 `a`；现在基础层就是 `a { color: inherit; text-decoration: none; }`，页面侧零补丁。

### 6. 门槛命令全绿

```
$ corepack pnpm --filter @ai-se/web typecheck
$ tsc -p tsconfig.json                                   # 通过，无输出

$ corepack pnpm --filter @ai-se/web lint
$ eslint "src/**/*.{ts,vue}"                             # 通过，无输出

$ corepack pnpm --filter @ai-se/web test
 Test Files  36 passed (36)
      Tests  446 passed (446)

$ corepack pnpm --filter @ai-se/web build
dist/index.html                   0.71 kB │ gzip:   0.48 kB
dist/assets/index-BXMSerkq.css   27.24 kB │ gzip:   6.29 kB
dist/assets/index-BNhaGWaz.js   569.62 kB │ gzip: 172.07 kB
✓ built in 542ms
```

**全仓**（计划 §5.2 的全局门槛）：

```
$ corepack pnpm -r run typecheck     # 16 个包全部 Done
$ corepack pnpm -r run lint          # 16 个包全部 Done，exit=0
$ corepack pnpm -r run test          # exit=0
  16 个包 / 175 个测试文件 / 1434 个测试用例，全部通过
```

### 附加清理：`.taste-skill/`

```
$ ls -d .taste-skill
ls: .taste-skill: No such file or directory
```

**已移出仓库。** 该目录（`direction.json` 24KB + `inspect/` 7 张截图，共 188KB）是上一轮 `design-taste-frontend` 的产物，其内容正是审评 P6 要求删除的那套设计语言（`one-motif` 方向、圆点轨道、入场动画）。

**没有直接 `rm`，而是移到 `/tmp/ai-se-taste-skill-archived/.taste-skill`。** 本仓库没有 git，删除不可恢复；移出仓库同样达成「全站只有一套设计来源」，同时留了一条回退路径。确认不再需要时删掉那个目录即可。

---

## 第二步 · 逐条对照 8 条原始问题

| # | 问题 | 判定 | 证据 |
| --- | --- | --- | --- |
| 1 | 双样式体系是否拆除，全站是否只有一套样式来源 | **已解决** | `styles.css` 已删；`main.ts` 只有 `import "./styles/app.css"`；全仓 `styles.css` 引用为 0。层序固定为 `theme → base → components → utilities`（`styles/README.md` §0） |
| 2 | 是否消除营销落地页式视觉语言，是否符合 `00-design-system.md` | **已解决**（含文档回写） | `text-[72px]` → `--text-metric` 28px；Jost → 系统字体栈；圆点轨道 + 4 段入场动画删除；`@keyframes` 全仓 **0**。**设计文档已在 W3 回写**：§3 现为 `Primary: #15756a`（与实现一致），旧的 `#6C5CE7` 只作为「从未在实现中落地」的历史注记保留；§4 明确「系统无衬线字体这一条 v1.0 就写对了，实现曾一度偏离（Jost），现已回归」 |
| 3 | 是否清除全部 legacy class 残留 | **已解决** | 点名 13 个 + 额外查出 5 个死类名，**class 属性里 0 处**（命中全在注释里）；新增护栏测试自动扫描所有 `class="…"`（剥离注释后），防止回潮 |
| 4 | 新建 / 详情 / 删除的容器是否跨页一致 | **已解决** | 新建：5 页统一 `Dialog`；详情：4 页 `Drawer`（工作流页与运行页同步 URL）+ 2 个独立目的地用路由页（判据成文）；删除：3 处统一 `ConfirmDialog`，`window.confirm` 归零。规则与逐页动作表见 `components/README.md` |
| 5 | 表格是否可正常扫读（列对齐、排序、分页、**表头固定**） | **部分解决** | 列对齐 ✓（默认左、数字/时间/操作右 + 等宽数字，居中单元格实测为 0）；表头三态排序 + `aria-sort` ✓；分页默认打开 ✓；**表头固定未做** —— W7 评估后判定「每页钉在 10 行 ⇒ 表格高度已有上界，做 sticky 需要在页面里再套一层内部滚动区」，理由记入 `styles/README.md` §15 |
| 6 | 侧栏是否已有图标与计数，顶栏是否有面包屑与全局搜索 | **已解决** | 浏览器实测：侧栏 8 个导航项 **8/8 渲染图标**、失败计数徽标按 `badgeFor()` 渲染；顶栏有 `nav[aria-label="面包屑"]`（含对象名段）与全局搜索入口（`Cmd/Ctrl+K`） |
| 7 | 可访问性（lang / 对比度 / 焦点 / 状态冗余 / 暗色）是否解决 | **已解决**（范围有明确边界） | `lang="zh-CN"`、真实 favicon；对比度 **28 组 × 2 模式**实测，各 25 组达标 + 3 组按 WCAG 条款豁免 + 0 组未达标；焦点环逐元素实测（仪表盘 15/15）；状态徽标**三重冗余**（色 + 字 + 图标）；暗色两套模式色值齐全。**注意**：未跑自动化扫描器、未用真实屏幕阅读器，因此**不声称「全站符合 WCAG」**，见第三步 |
| 8 | 测试断言是否同步更新，测试是否全绿 | **已解决** | 全仓 16 包 / 175 文件 / **1434 用例全绿**；`apps/web` 从 32 文件 381 用例增至 **36 文件 446 用例**；每一次改断言都在同一次改动内完成（AGENTS.md §7），无一次「改代码不改测试」的遗留 |

---

## 第三步 · 诚实报告

### 3.1 三条主观标准的实测结果（计划 §5.1 —— 计划自己说这三条「比任何清单都准」）

| # | 标准 | 判定 | 实测 |
| --- | --- | --- | --- |
| 1 | 1440 宽屏首屏能否同时看到「有没有东西卡住了」和**至少 5 条**最近动态 | **部分解决** | 1440×900 下：「需要处理」整块可见（顶边 177px）✓；「最近工作流」的**第 5 行底边在 915px**，视口 900px ⇒ **第 5 行有 15px 落在折线以下**，卡片整体溢出 28px |
| 2 | 在需求页学会的操作方式，到项目页能不能直接用 | **已解决** | 两页同构（`<h1>` + 页头唯一主操作 + `Card` + `Table` + 分页）；页头动作同为「新建 X」；新建都开 `Dialog`、详情都在 `Drawer`/独立页、删除都开 `ConfirmDialog` |
| 3 | 随便打开一个列表页，能不能不移动眼球就把一列名称从头扫到尾 | **已解决** | 项目页首列所有行的左边缘**完全相同**（唯一值集合大小为 1）；全表居中单元格数为 0 |

**标准 1 差 15px 这件事必须说清楚，而且它没有被"修"**：

- 5 行确实都渲染了（`tbody tr` = 5），前 4 行完全可见，第 5 行只差 15px；
- 高度是被 ①「需要处理」与 ②「正在运行」两张指标卡吃掉的 —— 它们各自约 140px，标签在上、数字在下，中间是大片留白；
- **没有在 W10 改它**：W10 的职责是终验，而「把 ① ② 并排」是一次真实的版式改动，改完需要重新走一遍验证。在验收阶段为一张 mock 截图临时改版式，属于最该避免的那种改动。
- 候选修法（供裁决，任选其一）：把 ① ② 并排成一行（省约 150px，最彻底）；或把 ③ 的摘要从 5 条降到 4 条（省约 57px，但会牺牲标准原文要求的「至少 5 条」）；或压缩指标卡的上下内距。

### 3.2 未解决 / 部分解决的项与原因

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 表头固定（sticky header） | **未解决** | W7 评估后判定不做：每页钉在 10 行，表格高度已有上界；真做需要在页面里再套一层内部滚动区，为「表头已经在屏幕里」这个几乎不发生的场景多一层滚动 |
| 仪表盘首屏 5 行差 15px | **部分解决** | 见 §3.1；未在验收阶段改版式 |
| `RequirementsView` / `AgentsView` 的详情抽屉未同步 URL | **未解决** | W8 登记。规则已写进 `components/README.md` 并标注这两个页面待补；加 `?requirement=` / `?agent=` 是独立的一次改动（动 `openDetail` + `onMounted` + `watch` + 补测试），不属于 W8 的工作项 |
| 取消运行 / 取消工作流没有确认框 | **刻意不做** | W8 的判据：「能重跑 / 重试 / 重新发起」的动作不加确认。给一个「立刻停」的按钮套确认框，会让停止变得不可能 |
| `showIcon` prop 零使用 | **未解决（低危）** | W9 为「空间实在放不下」留的出口，当前 64 处调用全部用默认值。属于「留了但没用上」 |
| `--input` 在 `--muted` 面上 2.90–2.97:1 | **未解决（当前无影响）** | `--muted` 是行 hover / 内嵌区块 / 只读区，没有任何表单控件落在它上面 |
| 200% 缩放 / 强制高对比度模式（SC 1.4.4 / 1.4.12） | **未测** | 不在计划的工作项里 |
| 自动化 a11y 扫描器（axe / pa11y） | **未跑** | 仓库无此依赖，本次没有为它新增依赖 |
| 真实屏幕阅读器走查（VoiceOver / NVDA） | **未做** | 只做了结构与属性的静态核对 |
| LCP / 首屏性能指标 | **未测** | 不在这份计划的范围内（计划的 P0–P10 没有性能项） |
| 前端路由级代码分割 | **未做** | `build` 会警告单个 chunk > 500 kB（569 kB / gzip 172 kB）。计划 §6「不新增运行时依赖」并不禁止拆分，但拆分不在 P0–P10 的任何一条里 —— 这是**一个独立的性能议题**，不是可用性缺陷 |

> **勘误（2026-10-15 补记；原判定与结论一字未动）**：上表「200% 缩放 / 强制高对比度模式（SC 1.4.4 / 1.4.12）」一行的**编号引用有误** —— WCAG 2.2 的 **1.4.12 是 Text Spacing（文本间距）**，而**强制配色（forced-colors）没有对应的独立成功准则**。W11 已把这两件事**分开实测**（文本间距与强制高对比度各一阶段，13 条路由零违规），因此**测量结果不受影响，受影响的只是条款编号的引用**。详见 [docs/143 §六 Known Issue #5](143-phase-w11-frontend-followups.md)。

### 3.3 偏离计划要求处与原因

| 偏离 | 原因 | 登记位置 |
| --- | --- | --- |
| W5 未新增任何搜索 / 筛选 / 批量 / 列设置控件 | 计划点名的五项在代码里一个都不存在；W4/W5 的标准是「不造点不动的控件」 | docs/137 |
| W7 的「操作列收敛为主操作 + 更多菜单」未采用 | 删掉「复制 ID」后操作列最多只剩 2 个按钮，为 1 个条目套下拉菜单是增加点击成本 | docs/139 §五 |
| W7 的固定表头 / 行选择 / 列显示隐藏 / 每页条数选择器未做 | 逐项评估后判定不做，理由见 `styles/README.md` §15 | docs/139 §七 |
| W8 给三个动作**不**加确认框 | 判据是「救不救得回来」，不是「看起来危不危险」 | docs/140 §三 |
| W9 删除零使用的 `--border-strong` | 与旧 `--input` 同值、文档还把它描述为「明确轮廓」用途 —— 留着会让本次的缺陷回潮。属对最小改动原则的偏离 | docs/141 §四 |
| W10 把 `.taste-skill/` **移出**而不是删除 | 无 git，删除不可恢复；移出同样达成目标且留了回退路径 | 本文件第一步 |

### 3.4 只属推测、未实测的结论

- **真实后端下的行为**：W5–W9 的浏览器验证全部用页面内注入的 `fetch` mock 提供数据。因此「删除真的落到数据库」「分页在真实大数据量下的表现」「SSE 实时更新」等**未验证**（每次报告都单独列了 `未启动真实后端`）。
- **未触发过的状态分支**：`DeploymentsView` 的主从布局、`MCPAppView` 的 iframe / Bridge 日志、`WorkflowsView` 的事件时间线分页，在本次 W7–W9 的验证脚本里没有覆盖（它们在 W5 是被结构断言覆盖的）。这是「这些分支的**外观**在 W8/W9 的令牌改动后是否仍然正确」的一个缺口 —— 令牌改动影响的是颜色，逻辑上应当是安全的，但**没有逐页截图确认**。
- **暗色模式的逐页走查**：只对工作流页与项目表单做了暗色截图，其余 9 个页面未逐页确认。
- **`localStorage` / 深链接的往返**：未做。

---

## 第四步 · 阶段报告

### Modified Files

**新增**
- `docs/142-phase-w10-acceptance.md`（本文件）

**修改**
- `apps/web/src/views/AgentsView.vue` — 删死类名 `agent-link`
- `apps/web/src/views/RequirementsView.vue` — 删死类名 `requirement-dependencies`
- `apps/web/src/views/MCPServerDetailView.vue` — 删死类名 `mcp-action-link` ×2（与 `buttonVariants` 完全重复）
- `apps/web/src/components/layout/AppSidebar.vue` — 删死类名 `nav-link` ×2 与 `nav-link--active` ×2（同处已由 vue-router 输出 `aria-current="page"`）
- `apps/web/src/__tests__/appShell.test.ts` / `agentsView.test.ts` / `requirementsView.test.ts` / `mcpServerDetailView.test.ts` — 断言改用真实语义定位
- `apps/web/src/__tests__/uiComponents.test.ts` — 新增 3 条 W10 护栏（legacy 类名清剿、扫描覆盖度、`eyebrow` 归属）
- `docs/15-development-roadmap.md` / `docs/17-acceptance-checklist.md` / `docs/18-phase-engineering-goals.md`

**移出仓库**
- `.taste-skill/` → `/tmp/ai-se-taste-skill-archived/.taste-skill`

### Implementation

本阶段没有实现任何功能。四件工作是：机械检查（第一步）、逐条对照 8 条问题（第二步）、实测三条主观标准（§3.1）、清剿 5 个额外查出的死类名。

### Architecture Changes

**1. 死类名清剿的做法从「照单核对」升级为「按产物反查」。** 计划点名了 13 个 legacy 类名，但真正的判据是「这个类名有没有 CSS 规则」。W10 用「把全部 class token 与构建产物 CSS 对账」的办法又查出 5 个点名的清单里没有的死类名，并顺手把依赖它们做 DOM 断言的测试改成依赖**真实语义**（`aria-current="page"` / `href` / `<nav>` 作用域）—— 测试从「依赖一个无意义的标记」变成「依赖一条真实的无障碍属性」。

**2. 机械检查从「人工跑一遍」变成「测试里钉住」。** legacy 类名清剿新增了一条自动扫描（剥离注释后只扫 `class="…"`，因此 `SectionHeader.eyebrow` 这个活 prop 与注释里的历史说明不会造成误报），从此不会再回潮。

### Dependencies

无新增依赖。

### Tests

```
Test Files  36 passed (36)
     Tests  446 passed (446)
```

**+3 条**（443 → 446），全部在 `uiComponents.test.ts` 的 `W10 · legacy 类名清剿`：

| 用例 | 覆盖 |
| --- | --- |
| 生产文件的 class 属性里不再出现任何 legacy 类名 | 18 个类名（点名 13 + 额外查出 5）× 全部 `views/` 与 `components/` |
| 扫描覆盖到内容 | 防止 glob 失效导致「空扫描 = 永远通过」 |
| `eyebrow` 仍只作为 `SectionHeader` 的 prop 存在 | 剥离注释后断言：`SectionHeader` 有、`PageHeader` 没有 |

另有 4 个既有测试文件的**定位方式**改写（断言内容不变，只是换了锚点）。

### Lint

`eslint "src/**/*.{ts,vue}"` 通过，无输出。全仓 `pnpm -r run lint` 16 包全部 Done。

### Typecheck

`vue-tsc --noEmit` 通过，无输出。全仓 `pnpm -r run typecheck` 16 包全部 Done。

### E2E

未运行后端 API 级 e2e（未改后端）。前端以真实 Chromium 实测，见 §3.1 与前三阶段的 `docs/139 §9.2`、`docs/140 §5.2`、`docs/141 §6.2`。

### Known Issues

见 §3.2 的完整表。最需要你注意的三条：

1. **仪表盘首屏第 5 行差 15px**（§3.1 标准 1）—— 未修，附三条候选修法。
2. **未跑自动化 a11y 扫描器、未用真实屏幕阅读器** —— 因此本轮**不声称「全站符合 WCAG」**，结论限定为「计划点名的九项逐项实测通过」。
3. **`build` 警告单个 chunk > 500 kB**（569 kB / gzip 172 kB）—— 前端路由级代码分割未做，这是独立的性能议题、不在 P0–P10 范围内。

其余：表头固定（评估后不做）、两个抽屉未同步 URL、`showIcon` 零使用、`--input` 在 `--muted` 面 2.90:1、200% 缩放未测、`.taste-skill/` 现位于 `/tmp/ai-se-taste-skill-archived/`。

**4. 5 个「新建」类 Dialog 没有可访问描述（终验时从 dev server 日志里发现的）。**

停掉 dev server 时，终端上留着一条一直被我忽略的告警：

```
[vite] (client) [console.warn] Warning: Missing `Description` or `aria-describedby="undefined"` for DialogContent.
```

这是 reka-ui 的提示：`DialogContent` 既没有 `Description`，`aria-describedby` 也不是一个有效 id。触发它的是**只传了 `title`、没传 `description`** 的五个弹窗 —— 项目 / 需求 / 运行 / 工作流的新建框，以及部署的环境设置框（`ConfirmDialog` 因为是 `description` 必填，不在其中）。

- **不是错误**：`Dialog.vue` 在这种情况下把 `aria-describedby` 置为 `null`，属性被移除而不是留下悬空引用（这一条是组件刻意做的，注释里写明了）。屏幕阅读器会朗读标题，只是没有补充说明。
- **没有在 W10 修**：修法有两条 —— ① 给这五个弹窗补一句说明文案（需要写新文案，而计划 §6 的约束是「不改写业务文案」；补新文案属于内容变更，应当由你决定）；② 在 `Dialog.vue` 里把无描述的情况显式处理掉（但那只是让告警闭嘴，并没有真的补上描述）。**两条都留给你裁决。**
- **这一条的价值在于**：它是 W1–W10 唯一一个「在终验收尾时才被发现」的问题，来源是**留下了运行日志**而不是关掉它。之前的每一次验证脚本都只断言 `console.error` 与 `pageerror`，`console.warn` 一直被过滤掉了。

### Acceptance Result

**通过（附一条主观标准未完全达成）。**

计划 §W10 的三步全部完成，第一条 6 项机械检查**全部达标**，§2 三条门槛命令与 §5.2 全仓门槛全绿：

```
apps/web : typecheck ✓  lint ✓  test 446/446 ✓  build ✓
全仓     : typecheck ✓  lint ✓  test 1434/1434 ✓  (16 包 / 175 文件)
```

| 8 条原始问题 | 判定 |
| --- | --- |
| 1 双样式体系 | 已解决 |
| 2 营销落地页视觉语言 | 已解决（含设计文档回写） |
| 3 legacy class 残留 | 已解决 |
| 4 新建/详情/删除容器一致 | 已解决 |
| 5 表格扫读 | **部分解决**（表头固定未做，有理由） |
| 6 侧栏 / 顶栏 | 已解决 |
| 7 可访问性 | 已解决（有明确边界，不声称全站 WCAG） |
| 8 测试同步与全绿 | 已解决 |

| 三条主观标准 | 判定 |
| --- | --- |
| 1 首屏看到「卡住的」+ 至少 5 条动态 | **部分解决**（第 5 行差 15px） |
| 2 需求页学会的能直接用在项目页 | 已解决 |
| 3 一列名称不移动眼球扫到尾 | 已解决 |

### W1–W10 累计变化

| 指标 | 起点（W1 诊断时） | 现在 |
| --- | --- | --- |
| 样式来源 | 两套（`styles.css` 未分层 + `app.css`） | **一套**（`app.css`，层序固定） |
| 未分层 `<style scoped>` 块 | 11 | **1**（Deployments 的 `[data-active]` 强调条） |
| `grid-cols-[…]` 任意栅格 | 24 | **7**（4 种布局模板，逐条有理由） |
| `!important` | 2 | **0** |
| 一次性任意值（`text-[…]` / `rounded-[…]` / `min-[900px]`） | 多处 | **0** |
| 硬编码颜色 | — | **0** |
| 页面宽度约束 | 无（11 页裸 `<section>`） | **两档** `PageContainer`（1200 / 1440） |
| 页面骨架 | 各写各的 | **一套**（页头 + 四态 + 工具行 + 分页） |
| 危险操作确认 | 3 种机制 | **1 种**（`ConfirmDialog`） |
| 状态传达 | 颜色 + 文字 | **颜色 + 文字 + 图标** |
| 非文本对比度 | `--input` 1.54:1 | **3.41 / 3.14:1**；其余 3 组按 WCAG 条款豁免 |
| 测试（`apps/web`） | 23 文件（4 个红灯） | **36 文件 / 446 用例，全绿** |
| CSS 产物 | 36.51 kB | **27.24 kB**（−25%） |
| 设计文档与实际的一致 | 分叉（紫 vs 青绿、Jost vs 系统字体） | **一致**（W3 回写） |

### Next Phase Boundary

**W1–W10 全部完成，前端可用性改造线到此结束。**

计划 §6「明确不做 / 超出本次范围」的边界自始至终没有被越过：

- **未改后端**：`apps/server`、`packages/*` 一行未动。
- **未改接口契约**：`api/`、`stores/`、`viewmodels/`、路由 `path`/`name` 的语义未变；W7 的排序与分页都是纯前端。
- **未改写业务文案**：只挪位置与字号，未改写、未翻译（唯一的内容变化是 W6 的「最近项目」→「最近工作流」，已单独登记待确认）。
- **未新增运行时依赖**：W1–W10 全程没有新增任何 npm 依赖。
- **未动 `dist/`**。

**验收提示**：W6 有一处**内容变化**仍待你确认 —— 仪表盘的「最近项目」表已被替换为「最近工作流」（理由与代价见 [docs/138 §三](138-phase-w6-dashboard.md)）。

**排在 W 线之后的 X1 · 模型与凭据配置**（已裁定立项）：控制台内配置 LLM 模型与 API Key，**凭据必须复用既有 Secret Provider 引用，不得新增明文存储**（AGENTS.md §10 禁第二套 Secret 体系）；附带补 `WorkflowsView` 任务审批缺失的意见输入框。
