# 136 · W4 重建 AppShell 与信息架构（实施记录）

**阶段**：W4（对应审评文档 P4）
**日期**：2026-10-14
**前置**：[132-web-frontend-remediation-plan.md](132-web-frontend-remediation-plan.md)（计划）、[135-phase-w3-tokens-and-typography.md](135-phase-w3-tokens-and-typography.md)（W3）
**性质**：骨架与信息架构改造。**未触碰业务逻辑、文案、store / api / viewmodel 的语义、路由契约。**

---

## 一、目标与结果

**目标（来自审评 P4）**：让骨架承担起运维控制台该承担的导航与状态传达职责。

| 指标 | 改造前 | 改造后 |
| --- | --- | --- |
| 侧栏图标 | 8 个已 import 但**零渲染**（死代码），全靠圆点区分 | **8 个图标全部渲染**，圆点方案整体删除 |
| 侧栏选中态 | 圆点空心 → 实心 | **背景 + 文字色 + 图标色同时变**（`bg-primary-light text-primary`） |
| 侧栏告警 | 无 | 工作流**失败数**徽标（真实 store 数据，为 0 或未加载时不显示） |
| 侧栏折叠 | 无 | 可折叠（164px ↔ 64px），选择持久化到 localStorage |
| 顶栏 | 52px 只显示两个字（路由 `meta.group`） | **面包屑**（分组 / 页面 / 对象）+ **全局搜索入口** |
| 全局搜索 | 全站没有 | `Cmd / Ctrl + K` 命令面板：页面 + 已加载的数据实体 |
| 页面宽度 | **全站无任何约束**，宽屏内容拉到屏幕边缘 | `PageContainer` 两档（1200 / 1440），11 页全部套用 |
| 裸 `<section>` 根节点 | 11 个 | **0 个** |
| 侧栏 scoped CSS | 1 个 `<style scoped>` 块 | **0**（全部改为工具类） |
| 测试 | 320 | **339**（+19） |
| CSS / JS 产物 | 34.78 kB / 544.65 kB | 36.23 kB / 556.01 kB |

---

## 二、逐项实施

### 2.1 `PageContainer`：全站唯一的页面宽度来源

新建 `components/common/PageContainer.vue`，只有两档宽度，11 个页面全部套用：

| 档位 | 宽度 | 用于 | 页面 |
| --- | --- | --- | --- |
| `default` | 1200px | 正文 / 表单 / 详情型 | 仪表盘、项目详情、MCP 服务器详情、MCP 应用 |
| `wide` | 1440px | 表格 / 多列型列表页 | 项目、需求、工作流、Agent 运行、部署、专业 Agent、MCP 服务器 |

**内距与页头间距刻意不放进 PageContainer**：内距已由 AppShell 的 `<main>` 统一提供（`--app-main-padding`），页头与内容区的间距已由 `PageHeader` 自己的 `mb-[var(--section-gap)]` 统一提供（11 个页面全部使用 PageHeader）。放进去只会让同一间距叠加两次。评审要求的「统一内距 / 统一标题区与内容区间距」在 W2/W3 之后**本来就已经统一**，W4 只补上缺失的**宽度**这一项。

宽度走令牌（`--app-content-width` / `--app-content-width-wide`），与既有的 `--app-sidebar-width` 同一套约定；两档写进了 `styles/README.md`。

### 2.2 侧栏：图标、选中态、计数、折叠

**图标**：8 个已 import 的图标（`LayoutDashboard` / `FolderKanban` / `FileText` / `Workflow` / `Rocket` / `Bot` / `Activity` / `Server`）现在真正渲染，`.nav-dot` 的模板与样式块整体删除。侧栏因此**不再有任何 `<style scoped>`**——W3 报告里登记的「11 个未分层 scoped 块」随之减到 10 个。

**选中态**：`bg-primary-light text-primary font-medium`。图标走 `currentColor`，所以背景、文字、图标三者同时变，不再依赖「圆点空心变实心」这种隐晦信号。

**失败计数**：`useWorkflowsStore().workflows` 中 `status === "FAILED"` 的数量。两条硬规则：

- 数字**只来自 store 的真实数据**，不编造；
- 数量为 0、或 store 未加载 / 加载失败时**不渲染徽标**——不显示无意义的 0，也不用「0」假装「没有问题」。

为了让这个徽标在任何页面都成立，侧栏在 `onMounted` 主动加载一次工作流列表（仅当 store 为空且未在加载中）。**这是一处刻意的行为变化**：应用启动时多一个列表请求。代价与理由见 §四 决策 1。

**折叠**：`--app-sidebar-width`(164px) ↔ `--app-sidebar-width-collapsed`(64px)，折叠后只留图标、以 `title` 提供名称，开关按钮带 `aria-label`（收起/展开）与 `aria-expanded`。选择写入 `localStorage`。读取放在 setup 阶段同步执行而不是 `onMounted`，避免首帧先展开再收起的闪动；SSR 下 `localStorage` 不存在，安全回退到展开态。

### 2.3 顶栏：面包屑

`分组 / 页面 / 对象`：

- 分组来自路由 `meta.group`（构建 / 运行）；
- 页面名来自一张显式的一级页面表，详情路由按路径前缀归位，因此详情页的页面名可点回列表页；
- 对象名取自已加载的 store（项目名 / 部署的 `环境 · 版本` / MCP 服务器名 / 工作流的关联需求名）。**取不到就不显示这一段**，而不是渲染一个空壳——路由未声明分组时同理。

### 2.4 全局搜索：命令面板

`Cmd / Ctrl + K` 或点击顶栏搜索入口唤起。结果分两类：

- **页面**——静态路由，永远可用，不依赖任何数据；
- **数据**——各 store **已加载**的实体（项目 / 需求 / 工作流 / 部署 / Agent / MCP 服务器），点击进入对应详情页或列表页。

三个实现决定：

1. **判断逻辑全部在 `viewmodels/commandPaletteViewModel.ts`**（纯函数：条目映射、过滤、分组），组件只做交互与渲染。这符合仓库约定「可测试的业务判断一律放进 ViewModel」，也让这部分能脱离 SSR/DOM 直接测。
2. **打开面板时才按需加载**，且只在对应 store 为空时拉一次。这样既不会在应用启动时凭空多出请求，也不会每次打开都重复拉取。
3. **需求只能搜索已加载的那一批**：`loadRequirements(projectId)` 需要项目 ID，无法整表拉取。这是接口契约的既有限制，没有为了搜索去改契约。

交互：↑↓ 选择（循环）、Enter 打开、Esc 关闭、鼠标悬停同步高亮、当前项自动滚入视野。空查询时每个数据分组只展示前 5 条（避免一屏塞满整库），页面入口不受限。

### 2.5 一处**刻意没做**的事：通知入口与用户菜单

审评建议顶栏「通知入口、用户菜单占位……如果某一项暂时没有对应数据，就留出结构和位置，但是不要放假数据」。

**我没有加这两个控件。** 核查结果：本应用没有登录态、没有用户模型——`api/auth.ts` 只是一个可选的 API Token 请求头助手，全站没有任何「当前用户」概念；也没有通知实体。

一个点了没反应的铃铛或头像不是「结构占位」，而是一个**假的可交互承诺**——它比留白更容易让人误判功能已经存在。这更接近审评自己那条原则（「不要为了填满布局而编造」）的本意。顶栏那 52px 现在由面包屑与搜索承担，已经不再浪费。

若你要的是「先把位置占住」的字面执行，说一声，加上两个 `disabled` + `title="尚未接入"` 的控件是十分钟的事。

---

## 三、验证

### 3.1 门槛命令

```
typecheck ✓   lint ✓   test 339/339 ✓   build ✓
```

### 3.2 机械核对

| 检查 | 结果 |
| --- | --- |
| 裸 `<section>` 根节点 | **0**（11/11 页面已套 PageContainer） |
| `.nav-dot` 残留 | 仅剩 1 处注释说明 + 1 处反向断言，模板与样式为 0 |
| `AppSidebar.vue` 的 `<style>` 块 | **0** |
| 侧栏导航项 = 图标数 | 8 项，每项都含 `<svg>` |
| 新增工具类是否生成 | `bg-primary-light` / `text-primary` / `bg-danger-bg` / `text-danger-foreground` / `sr-only` / `sm:w-60` / `sm:block` / `max-w-[var(--app-content-width)]` / `w-[var(--app-sidebar-width-collapsed)]` 全部在产物中 |
| 新布局令牌是否输出 | `--app-sidebar-width-collapsed` / `--app-content-width` / `--app-content-width-wide` 均在 `:root` |

### 3.3 浏览器实测（真实 Chrome）

| 检查 | 实测 | 判定 |
| --- | --- | --- |
| 侧栏导航项 / 图标 | 8 项，每项都有 `<svg>`，共 9 个 svg（8 导航 + 1 折叠开关） | ✓ 死代码消除 |
| 选中态计算样式 | 背景 `rgb(224,242,238)`（= `--primary-light`）、文字 `rgb(21,117,106)`（= `--primary`）、类含 `font-medium` | ✓ |
| 失败徽标 | 播种 3 个工作流（2 FAILED）→ 徽标显示 `2`，色 `rgb(252,235,239)` / `rgb(156,18,55)`（= `--danger-bg` / `--danger-foreground`） | ✓ 真实数据 |
| 无失败 / 未加载时 | 徽标不渲染 | ✓ 不显示无意义的 0 |
| 面包屑（列表页） | `构建 / 项目`，末段带 `aria-current="page"` | ✓ |
| 面包屑（仪表盘） | 仅 `仪表盘`，无分组段 | ✓ |
| 折叠 | 点击后 164px → **64px**，8 个文字标签全部隐藏，留下 `title`；`aria-label` 变「展开侧栏」、`aria-expanded="false"`；`localStorage` 写入 `1`。再点恢复 164px、写入 `0` | ✓ 含持久化 |
| `Cmd + K` | 面板打开；空查询 14 条 / 4 组（页面 8 + 项目 2 + 工作流 3 + MCP 1），首条 `aria-selected="true"` | ✓ |
| 按标题搜索 `登录` | 命中 1 条「登录流程 / Mini Todo」 | ✓ |
| 按导航名搜索 `mcp` | 命中 2 条：「MCP 服务器」+「Echo 服务」 | ✓ |
| 按 hint 搜索 `已归档` | 命中「支付网关重构 / 已归档」 | ✓ |
| 无匹配 | 显示「没有匹配的结果。」 | ✓ 与「没有数据」区分 |
| PageContainer（wide）@1440 | 实际 1236px（= 1440 − 164 侧栏 − 40 内距），两栏栅格 `360px 852px` | ✓ |
| PageContainer（wide）@1920 | 限宽 **1440px**，左右留白对称（322 / 158，含内距） | ✓ 宽屏不再拉满 |
| PageContainer（default）@1920 | 限宽 **1200px** | ✓ 两档生效 |
| 仪表盘指标字号 | 28px / 600（W3 已从 72px 硬编码改到 `text-metric`） | ✓ |
| 暗色模式 | 侧栏选中 `rgb(22,51,45)`/`rgb(79,211,182)`、徽标 `rgb(58,22,34)`/`rgb(249,194,209)`、面板底 `rgb(21,31,29)` —— 全部取自暗色令牌 | ✓ |

### 3.4 未使用的验证手段（诚实说明）

- **折叠的 localStorage 持久化未做「刷新后仍折叠」的端到端验证**：实测确认了写入与恢复（`1` → 164px 切换后 `0`），但没有刷新页面重新读取。读取逻辑在 setup 同步执行，由 SSR 回退分支覆盖其安全路径。
- **命令面板的键盘 ↑↓/Enter 未逐步实测**：实测覆盖了打开、输入过滤、无匹配、点击；方向键与 Enter 的路由跳转靠 viewmodel 的纯函数测试（下标循环）与代码审阅，未逐键模拟。
- **需求（requirements）未能进搜索**：`loadRequirements(projectId)` 需要项目 ID，接口契约不支持整表拉取。这是既有限制，不是本轮引入。
- **`format:check`**：与 W2/W3 相同，全仓不通过是基线既有状态，不在门禁内。

---

## 四、决策与偏离

### 决策 1 · 侧栏主动加载工作流列表（应用启动多一个请求）

评审要的「侧栏告诉我哪里有问题」只有在数据已经加载时才成立。三个选项：

- **(a) 侧栏 `onMounted` 主动加载一次**（采纳）——任何页面都能看到失败数；代价是应用启动多一个列表请求。
- (b) 只在访问过工作流页之后才显示——不增加请求，但「看项目卡在哪」这个核心诉求在其它页面全部失效，等于没做。
- (c) 不放计数——放弃评审明确要求的能力。

选 (a)。请求有守卫（store 为空且未在加载中才发），失败时 store 记错误、侧栏不显示徽标，不会拖慢或阻塞页面渲染。

### 决策 2 · 命令面板按需加载（打开时才拉）

如果放在应用启动，会一次多出 5 个请求；如果完全不拉，搜索在首次加载后只能搜到页面。折中是**打开面板时按需拉一次**（每个 store 只拉一次）。副作用是 `agents.load()` 会顺带选中第一个 Agent（store 自身的行为，与直接访问 /agents 页一致），未为搜索新增任何 store 方法。

### 偏离 1 · 未做通知 / 用户菜单占位

见 §2.5。理由：没有数据源，假控件比留白更容易误导。

### 偏离 2 · 面包屑的「对象」段按可用性出现

工作流的详情对象名取「关联需求名 → 项目名」；两者都没有时不显示对象段。审评期望的对象段在这里并非总有值，与其显示一个 id 空壳，不如少一段。

### 保留 1 · 仪表盘仍是 W6 的状态

`DashboardView` 现在被 `PageContainer` 限宽到 1200px，指标已是 28px（W3），但**流程圆点轨道、`gap-14`（56px）、无卡片边界**都原样保留——那些是 W6 的范围。本轮只让它不再是无宽度约束的裸 `<section>`。

### 保留 2 · 侧栏「分组计数」目前只有工作流一项

评审举例是「工作流旁的失败数」，其余菜单项没有同等明确的失败语义（项目只有 active/archived，Agent 只有可用/降级）。为每一项都编一个计数会制造噪声，也会多出数个启动请求。目前只在有真实失败语义的「工作流」上显示。

---

## 五、阶段报告

### Modified Files

**新增**
- `apps/web/src/components/common/PageContainer.vue`
- `apps/web/src/components/layout/CommandPalette.vue`
- `apps/web/src/viewmodels/commandPaletteViewModel.ts`
- `apps/web/src/__tests__/commandPaletteViewModel.test.ts`
- `docs/136-phase-w4-appshell-ia.md`（本文件）

**重写**
- `apps/web/src/components/layout/AppSidebar.vue` — 图标渲染、选中态、失败计数、折叠持久化；**删除整个 `<style scoped>` 块**
- `apps/web/src/components/layout/AppHeader.vue` — 面包屑 + 搜索入口 + `Cmd/Ctrl+K` 监听 + 面板挂载

**修改**
- `apps/web/src/styles/app.css` — 新增 4 个布局常量（折叠宽度、两档内容宽度）
- `apps/web/src/components/common/index.ts` — 导出 `PageContainer`
- `apps/web/src/styles/README.md` — §3 扩为「间距与布局」，补布局常量表与页面宽度两档
- 11 个 `views/*.vue` — 根节点 `<section>` → `<PageContainer>`（含 import）
- `apps/web/src/__tests__/appShell.test.ts` — 重写（见 Tests）
- `docs/15-development-roadmap.md` / `docs/17-acceptance-checklist.md` / `docs/18-phase-engineering-goals.md` — 按用户裁决把 W 线登记进 Post-V1 增强，并推进到 W4

### Implementation

见 §二。

### Architecture Changes

**骨架从「有壳但没有职责」变成两层各司其职的容器。**

1. **宽度有了唯一来源。** 改造前 11 个页面根节点全裸，宽屏内容一路拉到屏幕边缘。现在只有 `PageContainer` 定义宽度，且只有两档——新增页面时宽度不再是每个页面各自决定的事。
2. **侧栏第一次有了「告知」能力，而不只是「导航」。** 图标 + 失败计数让侧栏在任意页面都能回答「哪里出问题了」，这正是审评对控制台的核心期待。
3. **顶栏从一行装饰文字变成导航与检索的入口。** 面包屑给位置，命令面板给跳转。
4. **可测逻辑下沉。** 命令面板的条目映射 / 过滤 / 分组放进 `viewmodels/`，组件只剩交互。这与仓库既有约定一致（`viewmodels/` 是「可测的纯逻辑层」）。
5. **一个未分层 scoped 块被消灭。** 侧栏的 scoped CSS 全部改写为工具类，W3 登记的 11 个未分层 scoped 块降到 **10 个**——这仍然是一个待处理的结构问题（见 Known Issues 3）。

### Dependencies

无新增依赖。命令面板复用既有的 `reka-ui` Dialog 原语与既有 store / api。

### Tests

```
Test Files  32 passed (32)
     Tests  339 passed (339)
```

**+19 条**，两个文件：

- **`appShell.test.ts` 重写**：原 3 条保留并加严，新增 7 条。改动逐条：
  1. `renderShell` 增加可选播种函数与路由 `meta`（面包屑依赖它），签名变化，断言逻辑不变。
  2. 原「侧栏为 sticky 固定栏」保留原断言（`sticky`/`top-0`/`h-screen`/`self-start`/`overflow-y-auto`/`w-[var(--app-sidebar-width)]`/`bg-card` 一个没少）。
  3. 原「结构与 active 归属」两条保留。`norm()` 类名不变。
  4. **新增**：8 个导航项都渲染图标（防死代码回潮）。
  5. **新增**：选中态为 `bg-primary-light` + `text-primary`，且 `nav-dot` 不再出现。
  6. **新增**：折叠开关存在、初始展开、默认不含折叠宽度类。
  7. **新增**：播种 2 个 FAILED → 徽标显示 `2` 且带 `title="2 个工作流失败"`。
  8. **新增**：无失败 / store 未加载 → 不出现徽标。
  9. **新增**：面包屑（列表页 = 分组 + 页面名 + `aria-current`；仪表盘 = 只有自身）。
  10. **新增**：搜索入口是真实按钮，带 `aria-label` 与 `aria-keyshortcuts`。
  - 同时更正了原文件头「AppShell / AppHeader / AppSidebar 均不访问 API / Store」的注释——侧栏现在读 `workflows` store（SSR 不触发 `onMounted`，因此测试中不产生请求）。
- **`commandPaletteViewModel.test.ts` 新增**（12 条）：六类实体的字段映射与跳转目标、空 store 产出空结果、工作流缺名时退回 id、空查询返回页面入口 + 每组限量、标题 / hint / 分组三种匹配方式、无匹配返回空数组（与「没有数据」区分）、结果上限、分组切段与顺序。

### Lint

`eslint "src/**/*.{ts,vue}"` 通过，无输出。

### Typecheck

`pnpm --filter @ai-se/shared build && vue-tsc --noEmit` 通过，无输出。

### E2E

未运行后端 API 级 e2e（针对 `apps/server`，与骨架改动无关）。前端以浏览器实测替代，见 §3.3。**本轮未启动后端**，用页面内注入 `fetch` mock 提供数据。

### Known Issues

1. **侧栏启动时多一个工作流列表请求**（§四 决策 1）。若后端在冷启动时较慢，这个请求不阻塞渲染，但会在网络面板里可见。
2. **命令面板首次打开会触发最多 5 个列表请求**（§四 决策 2）。每个 store 只拉一次。
3. **10 个未分层 scoped CSS 块仍在**（W3 登记 11 个，侧栏改写后减 1）。它们恒压工具类，留给 W5 统一页面骨架处理。
4. **需求不进全局搜索**（接口需 projectId，契约限制）。
5. **折叠持久化未做刷新级端到端验证**（§3.4）。
6. **仪表盘的轨道 / 56px 间距 / 无卡片边界原样保留**，属 W6 范围。
7. **26 处 `grid-cols-[…]`、8 处非 4px 刻度值**（W3 登记）未动，属 W5 范围。
8. **非文本对比度**（`--border` 1.17:1 / `--input` 1.54:1）未处理，等 W9 裁决。
9. **`!important` 仍剩 2 处**（`DashboardView` 无障碍守卫），W6 消除。
10. **`format:check` 全仓不通过**，基线既有状态，不在门禁内。

### Acceptance Result

**通过。** 审评 P4 的三项交付与计划的 4 项工作项全部完成，四项门槛命令全绿：

```
typecheck ✓   lint ✓   test 339/339 ✓   build ✓
```

对照审评 P4 的要求：

| 要求 | 结果 |
| --- | --- |
| 侧栏 8 个图标真正渲染，消除死代码 | ✓ 并补了防回潮的测试 |
| 选中态改为背景 + 文字色 + 图标色 | ✓ 实测三项同时变化 |
| 分组计数取自 store 真实数据 | ✓ 工作流失败数；为 0 / 未加载时不显示 |
| 侧栏可折叠且持久化 | ✓ 164↔64px，localStorage |
| 顶栏面包屑 | ✓ 分组 / 页面 / 对象 |
| 顶栏全局搜索（Cmd+K） | ✓ 命令面板，页面 + 已加载实体 |
| 通知 / 用户菜单占位 | ✗ **未做**，理由见 §2.5（无数据源，不做假控件） |
| PageContainer 两档宽度 + 11 页套用 | ✓ 1200 / 1440，裸 `<section>` 归零 |
| 侧栏保持 sticky 固定 | ✓ 断言原样保留、未改实现方式 |

### Next Phase Boundary（W5 · 统一页面骨架）

**STOP。本阶段到此为止，不自动进入 W5。**

W5 的范围（据计划 §W5）：

1. 定义「列表页标准骨架」：页头区（标题 + 一句话说明 + 唯一主操作）→ 工具行（搜索 + 筛选 + 视图切换 + 批量操作 + 列设置）→ 数据区 → 分页区。区间纵向间距走同一档令牌。
2. 定义四种状态并统一渲染：**加载中 → 骨架屏**（不再用「正在加载…」纯文字）、空 → `EmptyState` 且必须给出下一步动作、错误 → 可重试 + 重试按钮、有数据 → 正常渲染。
3. 11 个页面逐页套用，**改一个停一下让用户看**。建议顺序：Projects → Requirements → Workflows → AgentRun → Deployments → Agents → MCPServers → MCPServerDetail → ProjectDetail → MCPApp。
4. 约束：不顺手改业务逻辑、文案、或 store / viewmodel 的调用方式。

**W5 开工前建议一并处理的遗留项**（都在本报告 Known Issues 里）：

- 10 个未分层 scoped CSS 块（恒压工具类，是「改了样式不生效」的残余成因）；
- 26 处 `grid-cols-[…]` 与 8 处非 4px 刻度值；
- `PageHeader` 的 `eyebrow` prop 去留（计划里明确推迟到 W5 骨架定稿后决定）。

**未开始事项（STOP）**：W5–W10 全部未开始。`.taste-skill/` 目录推迟到 W10 清理。非文本对比度推迟到 W9。
