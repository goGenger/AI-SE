# Phase 3-C — AI-SE Common Components（实施记录）

> 阶段：Phase 3-C（业务无关公共 UI 组件）
> 依据：`docs/design/00-design-system.md`、`01-refactoring-rules.md`、`02-navigation.md`、`03-page-layout.md`、`04-component-system.md`、`05-interaction.md`、`06-visual-qa.md`、`docs/60-frontend-refactoring-assessment.md`、`docs/61`（Phase 0）、`docs/62`–`66`（Phase 1/2）、`docs/67`（Phase 3-A）、`docs/68`（Phase 3-B）
> 范围：仅公共组件；不修改任何业务页面
> 日期：2026-09-15

---

## 0. 阅读记录中的一处例外

任务书要求阅读 `docs/ui-reference/README.md` —— **该文件不存在**。`docs/ui-reference/` 目录中实际只有 1 个文件：`ai-se-home.png`（1,070,934 字节，1842×854）。本阶段按任务书要求回到 PNG 本身核对（间距 / 层级 / 字体 / 圆角 / 边框 / 状态颜色 / 视觉密度 / 页面标题结构），并已在此前阶段完成像素级测量。**标记为 Unknown，未凭空补写 README。**

## 1. 实现前置证据（不假设场景存在，全部实测）

按任务书要求，先核对当前代码中这四类场景是否真实存在：

| 场景 | 实测证据 | 结论 |
| --- | --- | --- |
| Page title | **11 / 11 个 View** 都有 `<header class="page-header">` + `<h1>`；结构统一为 `eyebrow(<p class="eyebrow">) + h1` + 右侧可选操作 | 存在 ✓（11 处） |
| Section title | 6 个 View 使用 `.panel-header`（AgentRun 5、Agents 4、Deployments 5、Requirements 5、Workflows 5、Dashboard 1），`<h2>` 出现在 10 个 View | 存在 ✓（约 20 处） |
| 状态标签 | `.status`（固定绿色 + `.status-error` 红）与 `.status-pill`（无颜色描边胶囊）。真实状态枚举来自 7 个业务域：Project / Workflow / Deployment / Requirement / Task / AgentRun / MCPServer | 存在 ✓（5 个页面在用） |
| Empty state | `.empty` 在 **11 个 View 共约 25 处**，形态统一：白底卡片 + 1px 边框 + 8px 圆角 + 居中灰字；另有 `.compact-empty`（仅内距更小） | 存在 ✓（约 25 处） |

其他实测结论：

- **11 个页面的 h1 之后都没有 description 段落**（仅 eyebrow + h1）→ `description` 仍按设计文档 §3 保留为可选，但当前无使用者。
- `.eyebrow` 现状：13px / 700 / uppercase / `margin: 0 0 4px`。
- `.page-header` 现状：flex + space-between + gap 16px + `margin-bottom: 24px`；h1 **32px**（设计文档 §4 规定 20-24px）。
- `.panel-header` 现状：flex + space-between + `margin-bottom: 14px`。
- `.empty` 现状：`padding: 28px` + `color: #65758a`；`.compact-empty` = `padding: 18px`。
- **当前状态展示没有任何 tone 体系**（`.status-pill` 对所有状态都是同一种灰色描边胶囊）→ 本阶段补齐 tone → 视觉映射（纯视觉变化，不改状态语义）。

## 2. 交付物

新增 6 个文件，**全部位于 `apps/web/src/components/common/`**（设计文档 §1 的 "AI-SE Common Components" 层；`components/ui/` 继续只放 shadcn 原语）：

| 文件 | 说明 |
| --- | --- |
| `components/common/PageHeader.vue` | eyebrow + Title + Description + Actions |
| `components/common/SectionHeader.vue` | eyebrow + Title（`level` 决定 h2/h3/h4）+ Actions |
| `components/common/StatusBadge.vue` | 6 个 tone → 语义 Token 的视觉映射 |
| `components/common/EmptyState.vue` | Icon + Title + Description + Action，`size` = default / compact |
| `components/common/index.ts` | 统一导出（含"本批未实现组件"的说明） |
| `src/__tests__/commonComponents.test.ts` | 组件契约测试（17 例） |

**未创建**：MetricCard / FormField / DataTable / FilterBar / SearchInput / Pagination / Dialog / Drawer / Sheet / DropdownMenu / Select / Tabs / Tooltip / Popover / Toast / Form / Calendar / ErrorState / LoadingState / 任何业务组件。
**未新增依赖**，未新建 `lib/` `shared/` `helpers/` `widgets/` `business-components/` 等目录。

## 3. 组件契约

### PageHeader
```vue
<PageHeader title="项目" eyebrow="项目" description?="…">
  <template #actions><Button>新建项目</Button></template>
</PageHeader>
```
- 渲染：`<header>`（flex + wrap + gap 4 + `mb-[var(--section-gap)]`）→ 左侧 `eyebrow(<p>) / <h1> / description(<p>)`，右侧 actions 容器（**未传插槽时不渲染该容器**）
- 排版：h1 = `--text-page-title`（24px / 600，设计文档 §4 上限）；eyebrow = `text-caption`（12px）+ `font-semibold` + `uppercase`；description = `text-secondary`（13px）+ `text-muted-foreground`
- 未启用 Preflight，故 h1 / p 显式 `m-0`
- 与 legacy 的有意差异：**h1 32px → 24px**（这是本阶段唯一明显的视觉变化，回归设计文档），其余（flex、space-between、16px gap、24px 底部间距）保持一致

### SectionHeader
- 渲染：`<div>`（flex + wrap + gap 3 + `mb-4`）→ 左侧 eyebrow（可选）+ 标题，右侧 actions 容器（同样按插槽按需渲染）
- `level?: 2 | 3 | 4`（默认 2）→ 动态渲染 `h2/h3/h4`，保持标题层级语义（卡片内可用 h3）
- 与 legacy 的有意差异：底部间距 14px → `mb-4`（16px，回到设计文档 §5 的 4px 刻度）

### StatusBadge
| tone | 视觉（全部为既有语义 Token） | 设计文档 §11 对应示例 |
| --- | --- | --- |
| `success` | `bg-success-bg` / `text-success` | 已完成 / 成功 |
| `running` | `bg-info-bg` / `text-info` | 运行中 |
| `pending` | `bg-neutral-bg` / `text-neutral` | 待执行 / 未开始 |
| `warning` | `bg-warning-bg` / `text-warning` | 等待审批 |
| `error` | `bg-danger-bg` / `text-danger` | 失败 |
| `neutral` | `bg-muted` / `text-muted-foreground` | 已停止 / 已取消 |

- 默认 tone = `neutral`；文案一律来自默认插槽；**组件内不存在任何业务枚举或业务文案**（有专门测试断言这一点）
- 组件只做 `tone → 视觉`；业务状态（如 `WAITING_APPROVAL`、`ROLLED_BACK`）到 tone 的映射属于业务层，留待 Phase 4+ 页面迁移时提供 → 见 §7 风险 1

### EmptyState
- 渲染：卡片容器（`rounded-lg` 12px + `border-border` + `bg-card` + `text-center`；`size="compact"` → `p-4`，默认 `p-6`）
- `icon?: Component` 由调用方传入（如 `@lucide/vue`），组件不内置任何图标；图标 20px（设计文档 §12 的 16-20px 区间上限）+ `text-foreground-disabled`
- `title`（14px `text-foreground`）/ `description`（13px `text-muted-foreground`，仅在有 title 时加 4px 上间距）/ `actions` 插槽（居中）
- 与 legacy 的有意差异：圆角 8px → 12px（设计文档 §9 的 Card 规范）、内距 28px → 24px、`.compact-empty` 18px → 16px

### 通用
- 全部 Vue 3 + TypeScript + `<script setup>` + Tailwind utility + `cn()`（复用 `@/components/ui/utils`，未新建任何合并工具）
- Props 类型显式声明、无 `any`、无 `emits`（纯展示，不修改父状态）、无 API / Store / Router 访问
- 新增样式全部為工具类 + 既有 Token，**未新增任何颜色值、未使用 `!important`、未新增全局 CSS**

## 4. 测试

`src/__tests__/commonComponents.test.ts`（17 例，与 Phase 3-B 相同的 SSR 渲染方法，零新增测试依赖）：

| 组件 | 覆盖 |
| --- | --- |
| PageHeader | `<header>` + `<h1>` 标签、`text-page-title`、eyebrow/description 缺省时不渲染多余 `<p>`、`m-0`、actions 插槽存在性、class 合并（`mb-0` 覆盖 `mb-[var(--section-gap)]`） |
| SectionHeader | 默认 `<h2>` + `text-section-title`、`level` 3/4 → `<h3>`/`<h4>`、未传 level 时不出现 h3、eyebrow 可选、actions 插槽可放 StatusBadge、class 合并 |
| StatusBadge | 6 个 tone 全部命中语义 Token、默认 tone = neutral、`<span>` + `text-caption` + `rounded-full`、**断言不含任何业务状态枚举**、class 合并 |
| EmptyState | 卡片 Token（bg-card / border-border / rounded-lg / 居中）、size 变体（p-6 vs p-4）、description 仅在同时有 title 时加 `mt-1`、icon 由外部传入（未传则不渲染 `<svg>`）、actions 插槽、class 合并 |

结果：`17 files / 91 tests passed`（Phase 3-B 基线 16 / 74 全数保留，本阶段新增 17 例）。

## 5. 浏览器验证（真实浏览器 + 真实级联环境）

临时 playground（`apps/web/playground.html` + `src/playground.ts`，**验证后已删除**；未注册路由、未改 Router/AppShell）在 `vite dev` 下与 legacy `styles.css` 同时加载，即真实共存环境。

### 5.1 Token 与排版实测

| 组件 | 实测值 | 期望 |
| --- | --- | --- |
| PageHeader | `H1` = **24px / 600**、`margin: 0`、色 `rgb(31,41,55)` | `--text-page-title` ✓（对比 legacy h1 同页实测 **32px**） |
| PageHeader eyebrow | 12px / 600 / `text-transform: uppercase` / `margin-bottom: 4px` | `--text-caption` ✓ |
| PageHeader 容器 | `display: flex`、`gap: 16px`、`margin-bottom: 24px` | `--section-gap` ✓ |
| SectionHeader | `H2` = **16px / 600**、`margin-bottom: 16px` | `--text-section-title` ✓ |
| StatusBadge 6 tone | success `rgb(236,253,245)`/`rgb(5,150,105)`、running `rgb(239,246,255)`/`rgb(37,99,235)`、pending `rgb(242,244,247)`/`rgb(82,82,91)`、warning `rgb(255,251,235)`/`rgb(217,119,6)`、error `rgb(254,242,242)`/`rgb(220,38,38)`、neutral `rgb(248,249,252)`/`rgb(107,114,128)`；默认 tone = neutral；12px；`rounded-full` | 全部 = 既有语义 Token ✓ |
| EmptyState | 白底、`1px rgb(232,234,240)`、圆角 12px、内距 24px、居中；compact 内距 16px；标题 14px `rgb(31,41,55)`；图标 20×20 `rgb(209,213,219)` | Token ✓ |

### 5.2 结构 / 响应式 / 控制台

- 插槽渲染：PageHeader action「新建项目」、SectionHeader 内嵌 StatusBadge「成功」、EmptyState action「刷新」全部正常
- **1024px**：`flex-wrap: wrap` 生效、无横向溢出（`scrollWidth - innerWidth = -15`）、action 仍在可见区域；**1280px** 同样无溢出
- 控制台：`window.onerror` / `unhandledrejection` 为空，无 `[Vue warn]`
- 临时文件与进程**已全部清理**（无残留 `playground.*`，5179 端口已释放）

### 5.3 业务页面未受影响（回归对照）

`vite preview` 复测 8 条一级路由：侧栏 164px、Header 52px、Main 内距 20px、8 项菜单全部正常，真实 API 正常；**业务页面仍在用 legacy 结构**（`.page-header` 存在、h1 实测 **32px**、`.empty` / `.status-pill` 原样），即本阶段未触碰任何业务页面 ✓。

## 6. 业务影响

- API：unchanged ｜ Router：unchanged（`router/index.ts` mtime 仍为 **9 月 11 日**）｜ Store：unchanged ｜ ViewModel：unchanged ｜ SSE：unchanged
- Business Views：unchanged（11 个 View mtime 全部为 **9 月 14 日**，未改）
- AppShell / AppSidebar / AppHeader / PageContainer：unchanged
- `styles.css`：unchanged（仍 960 行，mtime 11:41 = Phase 2-A）
- **Design Token：数值零变更、零新增**；未新增任何颜色值；仍 Light only；Preflight 仍关闭

## 7. 已知风险 / 限制（只记录）

1. **业务状态 → tone 的映射层尚不存在**：StatusBadge 只做 `tone → 视觉`，而 7 个业务域的枚举（`PENDING` / `WAITING_APPROVAL` / `ROLLED_BACK` / `DEGRADED` …）到 tone 的映射需要业务层函数。按阶段纪律本阶段**不能**修改 `viewmodels/`，故映射留待 Phase 4+ 页面迁移时补齐（建议放页面本地或新增纯函数 viewmodel，并配单测）。
2. **组件尚未被任何页面使用**：本阶段禁止改业务页面，因此这批组件对实际界面暂无视觉影响；真正生效在 Phase 4+（CSS 体积已因 Tailwind 扫描源码增长到 21.77 kB，JS 不变 277.46 kB）。
3. **legacy `a { color: #1d4f91 }` 陷阱仍在**：PageHeader 的 actions 插槽若放 `<RouterLink>`（legacy 各页面当前正是 `<RouterLink class="button primary">`），文字颜色会被该未分层规则压过。`<Button>` 渲染 `<button>` 不受影响；迁移时需按 Phase 2-A 的 scoped 规则处理。
4. **eyebrow 与 legacy 存在轻微视觉差异**：13px/700 → 12px/600（改用 `--text-caption` Token；设计文档未规定 eyebrow 具体规格）。
5. **EmptyState 沿用 legacy 的嵌套边框行为**：legacy `.empty` 本身即带边框，因此它出现在 `.panel` 内时今天就是"边框套边框"；本组件保持一致（未擅自发明"无边框变体"）。
6. **本阶段不含 ErrorState / LoadingState**：页面中的 `.state`（加载中/错误文字）与 `.error-banner`（3 个页面在用但 **styles.css 中始终未定义**）维持现状，未在本阶段处理。
7. **`docs/ui-reference/README.md` 缺失**（见 §0）。

## 8. Gate

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `corepack pnpm --filter @ai-se/web typecheck` | **PASS**（exit 0） |
| lint | `corepack pnpm --filter @ai-se/web lint` | **PASS**（exit 0，0 problem） |
| test | `corepack pnpm --filter @ai-se/web test` | **PASS**：17 files / 91 tests |
| build | `corepack pnpm --filter @ai-se/web build` | **PASS**（`index-BiNDNBiz.css` 21.77 kB / `index-ZsnE-N6X.js` 277.46 kB） |

## 9. 结论

**PASS**。4 组业务无关公共组件（PageHeader / SectionHeader / StatusBadge / EmptyState）已建立，结构与命名全部来自对现有 11 个页面的实测证据（而非设计文档的推测），视觉全部复用既有 Design Token，零业务依赖、零新增依赖、零业务页面改动；17 例组件契约测试 + 真实浏览器验证（Token / 层级语义 / 响应式 / 无溢出 / 无 console error）通过，四项门禁全绿。

按阶段纪律**在此停止**：不进入 Phase 4，不迁移任何现有页面。
