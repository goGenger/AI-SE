# 134 · W2 拆除双样式体系（实施记录）

**阶段**：W2（对应审评文档 P2）
**日期**：2026-10-14
**前置**：[132-web-frontend-remediation-plan.md](132-web-frontend-remediation-plan.md)（计划）、[133-web-frontend-diagnosis.md](133-web-frontend-diagnosis.md)（W1 诊断）
**性质**：样式系统架构改造。**未触碰业务逻辑、文案、store / api / viewmodel、路由契约。**

---

## 一、目标与结果

**目标（来自审评 P2）**：让全站只有一套样式来源，彻底消灭优先级冲突。

| 指标 | 改造前 | 改造后 |
| --- | --- | --- |
| 样式文件 | `styles/app.css` + `styles.css`（960 行，未分层） | **仅 `styles/app.css`** |
| 未分层的全局 `a { color }` | 存在，恒定压过 `@layer utilities` | 已删除，改为 `@layer base` 的 `a { color: inherit }` |
| 级联层 | 无（旧文件未分层） | `theme → base → components → utilities` |
| 对抗补丁 | 17 处（11 个页面/布局 + 6 个 UI 组件） | **0 处** |
| 死类选择器 | 96 个 | **0 个**（随文件删除） |
| CSS 产物 | 46.27 kB / gzip 9.20 kB | **32.69 kB / gzip 6.71 kB**（−29%） |

**关键结论：测试断言一处未改。** 计划曾预计「约 10 个测试文件的结构断言会集中变红」——实际没有发生，因为改造全程**保留了所有对测试可见的类名**（`nav-link--active`、`project-row-title`、`mcp-action-link`、`run-link`、`workflow-agent-link`、`agent-link`、`deployment-link` 等），只把它们承载的 `color` / `text-decoration` 从 scoped CSS 换成 Tailwind 工具类。`320/320` 从改造前到改造后始终全绿。

---

## 二、逐项实施

### 2.1 `styles.css` 的处置：先证明「零引用」，再删

W1 已用词元级精确匹配证明 `styles.css` 的 **96 个类选择器无一被真实标记引用**（先剥离块注释 / HTML 注释 / 行注释，再与全部 `.vue` 的 `class=` / `:class=` 词元交叉比对；另确认无单引号 class 属性、无运行时反引号拼接类名、无非 scoped `<style>` 块）。W2 删除前又做了一次非类选择器的穷举：

```
非类选择器: :root / * / body / a / a:hover / button,input,select,textarea
```

**恰好 6 条**，全部迁走。3 个 `@media` 块内只有死类规则。确认无遗漏后删除文件。

### 2.2 迁入 `@layer base` 的 6 条规则

写入 `apps/web/src/styles/app.css` 新的第 2 节：

```css
@layer base {
  * { box-sizing: border-box; }
  :root { color: var(--foreground); background: var(--background); font-family: var(--font-sans); }
  body { margin: 0; }
  a { color: inherit; text-decoration: none; }
  button, input, select, textarea { font: inherit; }
}
```

**关于 `a` 规则的设计决定**——审评要求「不要把『链接一律青绿色 + hover 下划线』这种默认带进新体系；让链接默认继承颜色」，据此：

- `color: inherit` 取代了旧的 `color: #15756a`。旧写法把品牌色强加给每一个 `<a>`，导致导航项、按钮式链接、卡片标题全部变成强调色，才需要 11 处逐页覆盖。
- `text-decoration: none` 保留为默认值，**这是必要的**：本仓库不引入 Tailwind preflight，否则每个 `<a>`（含导航与 `buttonVariants` 包裹的链接）都会带上 UA 默认下划线，相对改造前是可见回退。
- 需要表现为**正文链接**的地方（内容里的跳转）在各自位置显式加 `text-primary hover:underline`。

### 2.3 17 处对抗补丁的清理

| 文件 | 原补丁 | 处置 |
| --- | --- | --- |
| `AppSidebar.vue` | `.brand-link` / `.nav-link` / `.nav-link--active` 的 color + decoration | 改为 `text-foreground` / `text-muted-foreground` 工具类；active 态在 `:class` 分支里带 `text-foreground` |
| `DashboardView.vue` | `.dashboard-station` / `.dashboard-link` | 前者加 `text-foreground`；后者两个用法分别依赖 `buttonVariants({variant:'link'})`（本身含 `text-primary hover:underline`）与显式工具类 |
| `ProjectsView.vue` | `.project-row-title` / `.project-row-open` | 前者改为 `text-primary hover:underline`；后者依赖 `buttonVariants({variant:'secondary'})`（本身含 `text-foreground`） |
| `ProjectDetailView.vue` | `.project-detail-back` | 依赖 `buttonVariants({variant:'secondary'})`，补丁整体删除 |
| `MCPServersView.vue` | `.mcp-server-link` / `.mcp-action-link` | 前者改为 `text-primary hover:underline`，保留其真实排版声明（Section Title 档）；后者依赖 `buttonVariants`，补丁整体删除 |
| `MCPServerDetailView.vue` / `MCPAppView.vue` | `.mcp-action-link` | 依赖 `buttonVariants`，补丁整体删除 |
| `AgentsView.vue` | `.agent-link` | 改为 `text-primary hover:underline`；补丁删除后该文件**已无 `<style>` 块** |
| `AgentRunView.vue` | `.run-link`（4 处） | 改为 `text-primary hover:underline ml-2`（原 `margin-left: 8px` → `ml-2`） |
| `WorkflowsView.vue` | `.workflow-agent-link`（3 处） | 改为 `text-primary hover:underline` |
| `DeploymentsView.vue` | `.deployment-link`（3 处） | 改为 `text-primary hover:underline` |
| `ui/table/Table.vue` | `th, td` 排版兜底 | 删除；`td` 补 `text-body` 工具类（`th` 原本已有 `text-caption font-semibold`） |
| `ui/button/Button.vue` | `button { font-size/line-height/font-weight }` | 删除；基础类已含 `text-body font-medium` |
| `ui/input/Input.vue` / `ui/textarea/Textarea.vue` | `input`/`textarea` 同款兜底 | 删除；基础类已含 `text-body` |
| `ui/select/Select.vue` | `[role="combobox"]` 兜底 | 删除；触发器类已含 `text-body` |
| `ui/pagination/Pagination.vue` | `button` 兜底 | 删除；`buttonClass` 原缺 `font-weight: 500`，**补加 `font-medium`** 以保持外观不变 |

`ui/textarea/Textarea.vue` 不在审评与计划的名单里，是实施中顺查发现的同类补丁，一并清理。

### 2.4 同步的更动

- `main.ts`：删除 `import "./styles.css";`
- `ui/button/index.ts`：原注释记载的「legacy CSS 约束（见 docs/61 决策 T2/T3）… Phase 11 清理 legacy CSS 后此问题消失」正是本次清理的对象，改写为现状说明
- 删除 6 处已失效的注释：`AppSidebar`、`AgentRunView`、`AgentsView`、`WorkflowsView`、`DeploymentsView`、`ProjectDetailView`、`MCPAppView`、`MCPServerDetailView`、`MCPServersView`、`Input.vue` 中「为什么需要 scoped 规则」的整段理由，以及 `mcpServersView.test.ts` 的护栏注释
- 两处**陈旧事实**（非本次改动引入，是 W1 发现的设计文档分叉的余波）：
  - `ui/button/index.ts` 注释写 `Primary（#6C5CE7）`，实际是 `--primary`（`#15756a`）→ 改为引用令牌名
  - `AppShell.vue` 注释写 `--background #F6F7FB`，实际是 `#f3f7f6`；且写着「页面最大宽度仍由各业务页面自身的 `.page` 规则决定」——该规则本次已随文件删除，且从来没生效过（11 个页面根节点均为裸 `<section>`）→ 改为陈述现状，并指向 W4 的 PageContainer

---

## 三、验证

### 3.1 机械检查

| 检查 | 结果 |
| --- | --- |
| `grep -rn 'import ".*styles\.css"' src/` | ✓ 0 |
| `src/styles.css` 文件存在性 | ✓ 已删除 |
| `grep -rn "text-decoration" src/views src/components` | ✓ **0**（W10 门槛项提前达成） |
| 生产代码中的硬编码 hex（排除令牌定义文件） | ✓ 0（仅 2 处注释提及，其中 1 处已修正） |
| `grep -rn "styles\.css" src/` | ✓ 仅剩 `app.css` 自身的历史说明注释 |
| `!important` | ⚠️ **剩 2 处**，见 §四 偏离 1 |

### 3.2 门槛命令

```
typecheck ✓   lint ✓   test 320/320 ✓   build ✓
```

### 3.3 浏览器实测（真实 Chrome，dev server + 注入 fetch mock 提供数据）

CSS 架构改造的风险点在「静默失效」——工具类没生成、变量解析不出来、层序写反，都不会报错但会悄悄改变外观。因此逐项在浏览器里量了计算样式，**与改造前删除的 scoped 规则逐项对齐**：

**基础层与字体**

| 测量项 | 结果 | 判定 |
| --- | --- | --- |
| `--font-sans` 是否被 `@theme inline` 输出 | 非空（`Jost, ui-sans-serif, …`） | ✓ **此前不确定，实测确认会输出** |
| `body` 计算 `font-family` | `Jost, ui-sans-serif, system-ui, -apple-system, "PingFang SC", …` | ✓ Jost 仍生效，无字体回退 |
| `html` 计算 `background` / `color` | `rgb(243,247,246)` / `rgb(29,43,42)` | ✓ = `#f3f7f6` / `#1d2b2a` |
| `box-sizing` / `body margin` | `border-box` / `0px` | ✓ |
| 页面上处于 underline 的 `<a>` 数量 | **0** | ✓ 无 UA 下划线泄漏 |
| 级联层顺序 | `theme, base, components, utilities` | ✓ 工具类能覆盖基础层 |
| `.text-primary` / `.hover\:underline:hover` / `a` 规则是否生成 | 三者均存在 | ✓ |

**逐元素计算样式（与删除的 scoped 规则对照）**

| 元素 | 实测值 | 改造前 scoped 规则声明的值 | 判定 |
| --- | --- | --- | --- |
| 侧栏品牌链接 | `rgb(29,43,42)` | `--foreground` | ✓ 一致 |
| 侧栏普通导航项 | `rgb(90,107,105)` | `--muted-foreground` | ✓ 一致 |
| 侧栏当前项 | `rgb(29,43,42)`，无下划线 | `--foreground` | ✓ 一致 |
| 表格 `th` | 12px / 18px / 600 | `--text-caption`（12px / 1.5 / 600） | ✓ 一致 |
| 表格 `td` | 14px / 22.4px / 400 | `--text-body`（14px / 1.6 / 400） | ✓ 一致 |
| `a.project-row-title` | `rgb(21,117,106)` | `--primary`（`#15756a`） | ✓ 一致 |
| `a.project-row-open` | 底色 `rgb(233,241,239)`，文字 `rgb(29,43,42)` | `--muted` + `--foreground` | ✓ 一致 |

结论：**外观零变化**，改造只改变了样式的来源与层序，没有改变渲染结果。

### 3.4 未使用的验证手段（诚实说明）

- **`prefers-reduced-motion` 下的表现未实测**：浏览器工具不支持模拟该媒体特性，且改动未触碰相关代码。
- **`format:check` 未通过，但这不是本次引入的**：`corepack pnpm exec prettier --check "apps/web/src/**/*.{ts,vue,css}"` 报 23 个文件不合规，其中包含**本次完全未触碰**的 `EmptyState.vue`、`PageHeader.vue`、`SectionHeader.vue`、`router/index.ts`。即 `format:check` 不在本仓库门禁内（`AGENTS.md` §7 规定的门槛是 `typecheck && lint && test`）。核对我改动的 `app.css`，prettier 输出**零差异**。故未做全仓格式化（那属于无关重构）。

---

## 四、偏离与保留

### 偏离 1 · `!important` 未清零（2 处保留）

计划 W2 的验收写的是「`grep !important` → 0」，实际剩 2 处，均在 `DashboardView.vue` 的 `@media (prefers-reduced-motion: reduce)` 块内：

```css
animation: none !important;
transition: none !important;
```

**保留理由**：这两处不是「用 `!important` 压样式体系」——审评原文的门槛是「没有任何地方用 `!important` **来压样式**」，即对抗级联层的那种用法。这里是标准的无障碍降级守卫，且被覆盖的是动画与过渡，不参与本次拆除的层序冲突。W6 重写仪表盘时会连同整段入场动画一起删除。

计划里我把这条验收简写成「→ 0」是不够精确的，此处更正。

### 偏离 2 · `RequirementsView.vue` 的空 `<style scoped>` 块未删

该文件的 style 块只剩一段说明「本页面不再持有任何原生控件样式」的注释，无实际规则。它不是对抗补丁（该页面是 11 个页面里唯一没有补丁的），删与不删都不影响层序。保留原状，交由 W5 统一页面骨架时决定。

### 保留 1 · `Textarea.vue` 是计划外增补

不在审评的问题清单与计划 W2 的名单里，是实施中顺查同类 `font: inherit` 兜底时发现的。一并清理，理由与其它 5 个 UI 组件完全相同。

---

## 五、阶段报告

### Modified Files

**新增**
- `docs/134-phase-w2-single-stylesheet.md`（本文件）

**删除**
- `apps/web/src/styles.css`（960 行）

**生产代码**
- `apps/web/src/styles/app.css` — 文件头重写；新增第 2 节 `@layer base`
- `apps/web/src/main.ts` — 删除 `styles.css` 的 import
- `apps/web/src/components/layout/AppSidebar.vue`
- `apps/web/src/components/layout/AppShell.vue` — 仅修正 2 处陈旧注释
- `apps/web/src/components/ui/table/Table.vue`
- `apps/web/src/components/ui/button/Button.vue`
- `apps/web/src/components/ui/button/index.ts`
- `apps/web/src/components/ui/input/Input.vue`
- `apps/web/src/components/ui/textarea/Textarea.vue`
- `apps/web/src/components/ui/select/Select.vue`
- `apps/web/src/components/ui/pagination/Pagination.vue`
- `apps/web/src/views/DashboardView.vue`
- `apps/web/src/views/ProjectsView.vue`
- `apps/web/src/views/ProjectDetailView.vue`
- `apps/web/src/views/RequirementsView.vue` — **未改动**（列出以便对照）
- `apps/web/src/views/AgentsView.vue`
- `apps/web/src/views/AgentRunView.vue`
- `apps/web/src/views/WorkflowsView.vue`
- `apps/web/src/views/DeploymentsView.vue`
- `apps/web/src/views/MCPServersView.vue`
- `apps/web/src/views/MCPServerDetailView.vue`
- `apps/web/src/views/MCPAppView.vue`

**测试**
- `apps/web/src/__tests__/mcpServersView.test.ts` — 仅修正 1 处护栏注释的措辞，**无断言变更**

### Implementation

见 §二。

### Architecture Changes

**样式系统从「两套并存、旧者恒定获胜」收敛为单一来源 + 明确层序。**

改造前：`styles.css` 完全未分层，其普通声明按 CSS 级联规则恒定优先于 `@layer` 内的工具类。因此 `styles/app.css` 里定义的 Design Token 在链接、表单控件、表格单元格这几类元素上无法生效，团队只能逐个写 scoped 覆盖，且每新增一个页面就复制一遍这个补丁。

改造后：唯一来源是 `styles/app.css`，层级为 `theme → base → components → utilities`。基础层只放 reset 与元素默认值，工具类能覆盖它。新页面不再需要为「压过全局规则」而写任何覆盖。

**这是后续 W3–W9 的前提**：只要旧文件还在，W3 定义的令牌与字号刻度都会被它按优先级覆盖，改一行不生效一行。现在这层阻塞已经清除。

### Dependencies

无新增依赖。**删除**了对 `src/styles.css` 的隐式依赖。

### Tests

```
Test Files  31 passed (31)
     Tests  320 passed (320)
```

改造前后完全一致，**未修改任何断言**。计划曾预计约 10 个文件的结构断言会变红，实际未发生——原因是本次改造刻意保留了所有对测试可见的类名。唯一改动是 `mcpServersView.test.ts` 里一行注释的措辞。

### Lint

`eslint "src/**/*.{ts,vue}"` 通过，无输出。

### Typecheck

`pnpm --filter @ai-se/shared build && vue-tsc --noEmit` 通过，无输出。

### E2E

未运行后端 API 级 e2e（针对 `apps/server`，与本次纯前端样式改动无关）。前端以浏览器实测替代，见 §3.3。

### Known Issues

1. **`!important` 剩 2 处**（`DashboardView` 的 reduced-motion 守卫），保留理由见 §四 偏离 1；W6 重写仪表盘时一并消失。
2. **`prefers-reduced-motion` 未实测**（浏览器工具不支持模拟），改动未触碰该代码。
3. **全站仍无内容宽度约束**：`.page`/`.agent-run-page`/`.requirement-page` 三档宽度随 `styles.css` 一并删除，而它们本来就零引用。11 个页面根节点仍是裸 `<section>`，宽屏下内容会被拉到屏幕边缘——这是 W4 的 PageContainer 要解决的问题，W2 只负责不让「已废弃的宽度定义」继续留在代码里。
4. **`format:check` 全仓不通过**（23 个文件，含未触碰的文件），系基线既有状态，不在门禁内；本次未做全仓格式化。

### Acceptance Result

**通过。** 审评 P2 的 5 项交付全部完成，四项门槛命令全绿：

```
typecheck ✓   lint ✓   test 320/320 ✓   build ✓
```

机械检查 6 项中 5 项达标，`!important` 一项按 §四 偏离 1 保留 2 处并说明理由。

### 实施过程中的一个副作用（需用户知晓）

为做浏览器实测，我启动了 `apps/server` 的后端 dev server。**它启动后自动恢复了一个此前处于运行中状态的工作流**，并开始真实执行 Agent 工具调用（`list_directory` / `git_diff`，在沙箱容器内），伴随真实的 LLM 调用。发现后我立即停止了后端进程。

- 影响范围：该工作流的少量 LLM 调用与容器执行；
- 已恢复：后端进程已停止（3000 端口空闲），数据库中的工作流状态未被我修改；
- 如需继续/取消该工作流，由你决定。

后续若还需连后端做验证，建议先用 `CORS_ORIGIN` 与前端端口对齐（`.env` 里是 `http://localhost:5173`，而 `vite.config.ts` 配的是 4399），或直接在页面内注入 fetch mock（本次最终采用的方式，不需要后端）。

### Next Phase Boundary（W3 · 重建设计令牌与排版）

**STOP。本阶段到此为止，不自动进入 W3。**

W3 的范围：

1. **字体先裁决**：Jost 的两个问题（几何展示字体在 12–14px 密集界面可读性差；从 Google Fonts CDN 加载，在华环境可达性存疑）二选一——系统字体栈，或自托管到 `apps/web/public/fonts/`。并且**必须实测 `tabular-nums` 是否真生效**（Jost 不保证提供 `tnum`，W1 已登记为待验证项）。
2. 重写 `app.css` 令牌：间距单一 4px 刻度、字号 6–7 档（含用途定义）、圆角 3–4 档、边框两档、极轻阴影、统一焦点环。
3. 语义色 success/warning/danger/info/neutral 各给 bg/border/foreground 三档，**实测对比度**（正文 4.5:1、大字与图形 3:1）并写进报告。
4. 亮色 + 暗色两套，`:root` 声明 `color-scheme`。
5. 断点统一（当前混用 `min-[900px]` / `min-[800px]` / `min-[540px]` / 1180px；实测 `min-[Npx]` 18 处、`text-[Npx]` 3 处、`w-[Npx]` 9 处，分布在 8 个文件）。
6. 清剿任意值，并交付 `apps/web/src/styles/README.md`（每档用途 + 新页面怎么选）。
7. 按 §2 冲突 1 的裁决，把 `docs/design/00-design-system.md` 更新到与实现一致（§3 颜色表、§4 字体表述），废弃部分明确标注「已废弃」。

**未开始事项（STOP）**：W3–W10 全部未开始。`PageHeader` 的 `eyebrow` prop 去留推迟到 W5。`.taste-skill/` 目录推迟到 W10 清理。
