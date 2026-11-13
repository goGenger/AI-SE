# Phase 0 — UI 重构决策确认（决策记录）

> 类型：只读决策文档。本阶段未修改任何代码、未安装依赖、未改动 API / Router / Store / ViewModel / 业务逻辑，未新增页面或菜单，未删除 Legacy CSS。
> 输入：`docs/design/*`、`docs/60-frontend-refactoring-assessment.md`、`apps/web` 实际代码。
> 本阶段额外完成的两项实证（非推测）：
> 1. **级联层优先级**：MDN 规范明确 —— 未分层（unlayered）的普通声明**恒定优先于**任何 `@layer` 内的普通声明，与特异性、书写顺序无关。实测 `apps/web/src/styles.css` **零 `@layer`**（完全未分层），而 Tailwind v4 的全部输出都在 `@layer theme/base/components/utilities` 内 ⇒ 共存期内 **legacy CSS 无条件压过 Tailwind 工具类**。
> 2. **菜单高亮现状**（在 `vite preview` + 真实浏览器中逐路由实测）：`/workflows` → 「工作流」高亮 ✅；`/agent-run` → 「Agent 运行」高亮 ✅；`/projects/xyz` → **无任何高亮**；`/mcp/xyz` → **无任何高亮**。即 13 条路由中有 5 条详情路由当前不存在菜单激活态。
> 日期：2026-09-15

---

## 1. 当前前端结构结论

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 依赖栈 | Vue 3.5.42 + TypeScript 6.0.3 + vue-router 5.3.1 + Pinia 4.0.3 + Vite 8.2.2；**无 UI 库、无 Tailwind、无图标库** | `apps/web/package.json` |
| 页面层 | 11 个视图文件（2036 行），**互相不引用**，无 props/emits，无子组件 | `apps/web/src/views/*.vue` |
| 共享 UI | `App.vue`（24 行）内含唯一共享结构：内联 sidebar（8 个 RouterLink）+ RouterView | `apps/web/src/App.vue` |
| 样式体系 | **单份全局、完全未分层的** `styles.css`（1051 行）；零 `<style>` 块、零 scoped、零 CSS 变量 token、1 处 `!important` | `apps/web/src/styles.css` |
| 组件目录 | `src/components/`、`composables/`、`types/`、`constants/` **均不存在**（AGENTS.md §5 的规划目录） | 文件系统实测 |
| 数据流 | `views → stores(Pinia) → api(fetch)`；`viewmodels/` 承担纯展示逻辑（标签/格式化/条件判定） | 11 views / 7 stores / 7 api / 8 viewmodels |
| 路由 | 13 条，**无 meta、无守卫、无懒加载**（单 chunk） | `src/router/index.ts` |
| 菜单 | 8 项扁平一级，无二级/三级；设计文档中的 任务管理 / 代码仓库 / 系统设置 **及全部二级项在代码中不存在** | `App.vue:8-17` |
| 实时通道 | 3 个 store 各持模块级 `EventSource` + 2s 轮询单例，靠页面卸载时 `stopRealtime()` 收尾 | `stores/{agentRuns,requirements,workflows}.ts` |
| 权限 | 前端**无**权限体系（无 meta / 无守卫 / 无角色）；真实约束是审批流、MCP App 沙箱、条件动作判定函数 | §15.1 P0-4/P0-6、§8.3 |
| 测试 | 15 文件 / 53 用例，全部为逻辑测试（Vitest `environment: "node"`）；**零组件渲染测试** | `vitest.config.ts`、实测 |
| 门禁 | lint / typecheck / test / build / prettier **全部 PASS**（基线见 `docs/60` §18） | 实测 |

**一句话结论**：视觉层是"一张全局 CSS + 11 个自包含页面"，业务层（api/store/viewmodels/router/SSE）与视觉层**没有交叉**。因此本次重构可以只动"渲染"，但有两条硬约束：**逐页换类**（legacy 未分层必然压过工具类）与**契约冻结**（API/路由/store/SSE/权限）。

---

## 2. 已确认的关键决策

### 2.1 用户已确认（本次消息给定，原样采纳为约束）

| # | 决策 |
| --- | --- |
| D1 | 本次只做 UI/UX 重构，不改业务逻辑 |
| D2 | API / Router / Store / ViewModel / 权限 / SSE 保持不变 |
| D3 | 不新增当前不存在的页面、菜单和业务功能 |
| D4 | Tailwind CSS 4 + shadcn-vue 作为后续 UI 技术方案 |
| D5 | `styles.css` 暂时保留，与 Tailwind 渐进式共存 |
| D6 | Design Token 以 `docs/design/00-design-system.md` 为准 |
| D7 | 主色 `#6C5CE7` |
| D8 | 仅 Light Theme，不做 Dark Mode |
| D9 | Header 只实现当前真实存在的数据和功能 |
| D10 | 页面必须分阶段重构，禁止一次性修改全部页面 |

### 2.2 本阶段据此推导并锁定的技术决策（含依据）

| # | 决策 | 依据 |
| --- | --- | --- |
| T1 | **Phase 1-A 不引入 Preflight**：只导入 `theme` + `utilities` 两层 | Tailwind 官方文档明确支持"只导入需要的部分"；Preflight 会把 `h1-h6` 字号重置为 `inherit`，而当前面板 `h2` 完全依赖浏览器默认字号 ⇒ 直接引入会导致**全站面板标题集体变小**，Phase 1 就不再是"零视觉变化" |
| T2 | **共存机制 = 逐页换类，不做层序技巧**：不把 `styles.css` 搬进 `@layer`、不加 `!important`、不给工具类加前缀 | 未分层 legacy 恒定优先，任何"层序调优"都会同时改变 legacy 与 Preflight 的相对优先级，引入不可控视觉回归（见文档头实证 1） |
| T3 | **迁移规则**：同一个元素上**不能**用 Tailwind 工具类去覆盖 legacy 类的同名属性（会失效）；必须在该元素上**移除** legacy 类，改用工具类 | 同上；这是 Phase 4-10 每页验收时最容易踩的坑 |
| T4 | **Preflight 的引入时机后置**：等到最后一个页面迁完、legacy CSS 退役时（Phase 11）再评估 | 与 T1 配套，保证迁移期内任何时刻视觉都可控 |
| T5 | 新增的 Tailwind 组件（Phase 3 起）**禁止复用 legacy 类名**（如 `panel`、`button`、`status`、`empty`） | 避免 T3 的失效陷阱扩散到新组件 |
| T6 | **`cn()` 落位 `apps/web/src/components/ui/utils.ts`** | shadcn-vue 默认要 `@/lib/utils`，而 AGENTS.md §5 明文禁止 `lib/` 等目录名变体；放进已批准的 `components/` 下不新增任何目录、不违反任何规则（文件级新增，不是目录变体） |
| T7 | **shadcn-vue 生成的组件不得覆盖 AI-SE token**：`components.json` 初始化会写入它自己的一套中性色变量，必须人工保留 D6/D7 的值 | 否则 D6/D7 被静默推翻 |
| T8 | **菜单高亮行为需明确定夺**：现状 5 条详情路由无高亮（实证 2）。设计文档 §7 要求"Active 必须由 Router 状态驱动"。建议新增一个纯函数（`viewmodels/navigationViewModel.ts`：`path → 一级菜单项`）并在 `App.vue` 的 Nav 上使用，使 13 条路由全部有确定的高亮归属 | 新增文件、不改任何既有 Router/Store/ViewModel；属**纯展示逻辑**（AGENTS.md §5 明确"可测试的业务判断放进 ViewModel"），且可得单测。**这是一处可见的行为变化（视觉层），需你确认**；若否决，Phase 2 保留现状 |
| T9 | **依赖按阶段分批引入**，不做一次性安装 | 每阶段可独立回滚：1-A/1-B → `tailwindcss` + `@tailwindcss/vite`（仅此两项）；Phase 2 → `@lucide/vue`；Phase 3 → `reka-ui`、`clsx`、`tailwind-merge`、`class-variance-authority`、`tw-animate-css` |
| T10 | **不引入** DataTable / FilterBar / SearchInput / Pagination / Drawer / Toast | 全部为 0 处使用（§13 复用规则：3+ 才建议抽取）；引入即等于新增功能，违反 D3 |
| T11 | **字体保持现状**：保留 `styles.css` 中的 `Inter` 声明不动 | 该声明未加载任何字体文件；若用户本机装有 Inter 则实际生效。删除或替换会造成字体视觉变化，与 D5 冲突，`docs/design/00` §4"默认使用系统无衬线字体"的最终收敛放在 Phase 11 |
| T12 | **浏览器基线 = 现代浏览器**（Chrome / Edge / Safari 最新两个大版本） | Tailwind 4 与 Reka UI 依赖现代特性；当前项目无 `browserslist`/`build.target`，维持现状即为现代浏览器 |
| T13 | **每个阶段的 DoD 都包含契约核对**：`api/`（47 函数）、`router/`（13 条）、`stores/`（7 个）、`viewmodels/`（8 个既有文件）、SSE 三处调用时机、三条权限红线，全部零改动 | D2 的可执行化 |

---

## 3. Phase 1-A 最小修改范围（Tailwind CSS 4 基础设施）

**净改动：4 个既有文件 + 1 个新文件；零页面文件；零业务文件。**

| # | 文件 | 改动 | 说明 |
| --- | --- | --- | --- |
| 1 | `apps/web/package.json` | devDependencies += `tailwindcss@^4.3.3`、`@tailwindcss/vite@^4.3.3` | 仅此两项；`@tailwindcss/vite` 的 peer 为 `vite ^5.2 \|\| ^6 \|\| ^7 \|\| ^8`，本仓 Vite 8.2.2 受支持（已核实） |
| 2 | `apps/web/vite.config.ts` | ① `plugins: [vue(), tailwindcss()]`；② `resolve.alias` 增加 `"@" → src` | 别名放在 1-A（而不是 Phase 3），使 Phase 3 生成 shadcn 组件时**无需二次改配置**；风险为零（别名不改变任何现有导入） |
| 3 | `apps/web/tsconfig.json` | `compilerOptions` 增加 `baseUrl: "."`、`paths: { "@/*": ["./src/*"] }` | 与 ① 配套，供 `vue-tsc` 解析；根 `tsconfig.base.json` 无 `baseUrl`/`paths`，不存在覆盖冲突（已核实） |
| 4 | `apps/web/src/main.ts` | `import "./styles/app.css";` 放在 `import "./styles.css";` **之前** | 顺序契约（对正常声明影响被 T2 覆盖，但保持"legacy 在后"的直观约定，避免后续误判） |
| 5 | `apps/web/src/styles/app.css`（**新建**） | 仅 Tailwind 基础设施：<br>`@layer theme, base, components, utilities;`<br>`@import "tailwindcss/theme.css" layer(theme);`<br>`@import "tailwindcss/utilities.css" layer(utilities);`<br>+ 显式扫描范围声明 | **不含 token**（token 属 1-B）；**不含 preflight**（T1）；显式限定扫描范围以避免扫描 `dist/`——本仓库**没有 `.git`**，Tailwind 的自动内容探测失去 `.gitignore` 依据，需用 `@source` 指令显式限定为 `./src`（实施时先验证该指令在当前版本可用；不可用则退回自动探测并在报告中记录） |

**1-A 不做**：不写任何 token；不写任何工具类到页面；不改 `styles.css`；不改路由/store/api/viewmodel；不安装 shadcn-vue 依赖；不新增组件。

**1-A 验收**：
```
corepack pnpm --filter @ai-se/web typecheck   # PASS
corepack pnpm --filter @ai-se/web lint        # PASS
corepack pnpm --filter @ai-se/web test        # 15 文件 / 53 用例 PASS（含 mcpSecurity.test.ts）
corepack pnpm --filter @ai-se/web build       # PASS
```
外加：11 个页面在 1440/1280/1024 三档下与基线截图**逐页一致**（视觉零变化）；构建产物 CSS 体积变化仅来自 Tailwind 基础设施本身（无 preflight ⇒ 增量极小）。

---

## 4. Phase 1-B 最小修改范围（Design Token 落地）

**净改动：同一个新建文件（`app.css`）；零页面文件。**

### 4.1 落地方式

```css
:root { /* 原始值（D6 给的十六进制 + 语义状态色） */ }
@theme inline { /* 映射为 Tailwind 命名空间，产出工具类 */ }
```

- **分两段写**：`:root` 存原始值（供 JS/内联/非 Tailwind 场景读取），`@theme inline` 做映射（供工具类与 shadcn-vue 组件读取）。
- **变量名与 shadcn-vue 约定对齐**：这样 Phase 3 生成的组件**无需改一行**即可吃到 AI-SE 配色（`bg-background`、`bg-card`、`bg-primary`、`text-foreground`、`text-muted-foreground`、`border-border` 正好也是 `docs/design/04-component-system.md` §18 要求的类名）。
- **只有 Light Theme**（D8）：不写 `.dark` 块、不写 `@custom-variant dark`。
- **不覆盖 shadcn 的调色板**（T7）：`components.json` 生成结构，但 `:root` 的值以本文档表格为准。

### 4.2 颜色 Token（值全部来自 `docs/design/00-design-system.md` §3）

| 设计名 | 值 | 变量 | 产出的工具类 |
| --- | --- | --- | --- |
| Primary | `#6C5CE7` | `--primary` | `bg-primary` `text-primary` `border-primary` |
| Primary Hover | `#5B4BD6` | `--primary-hover` | `bg-primary-hover` |
| Primary Light | `#F0EDFF` | `--primary-light` | `bg-primary-light`（Sidebar/Menu active 背景） |
| Primary Soft | `#F7F5FF` | `--primary-soft` | `bg-primary-soft` |
| — | `#FFFFFF` | `--primary-foreground` | `text-primary-foreground`（Primary 按钮文字） |
| Page Background | `#F6F7FB` | `--background` | `bg-background` |
| Card Background | `#FFFFFF` | `--card` | `bg-card` |
| — | `#1F2937` | `--card-foreground` | `text-card-foreground` |
| Muted Background | `#F8F9FC` | `--muted` | `bg-muted` |
| Text Primary | `#1F2937` | `--foreground` | `text-foreground` |
| Text Secondary | `#6B7280` | `--muted-foreground` | `text-muted-foreground` |
| Text Muted | `#9CA3AF` | `--foreground-muted` | `text-foreground-muted` |
| Text Disabled | `#D1D5DB` | `--foreground-disabled` | `text-foreground-disabled` |
| Border Default | `#E8EAF0` | `--border` / `--input` | `border-border` |
| Border Strong | `#DDE0E8` | `--border-strong` | `border-border-strong` |
| — | `#6C5CE7` | `--ring` | `ring-ring`（focus ring） |

**状态色（设计文档只要求"低饱和的 Success / Warning / Error / Info"，未给具体值）**：直接沿用代码中**已在用**的 MCP 语义色对，保证语义与现状一致、且已经是低饱和：

| 语义 | 文字 | 背景 | 现有出处 |
| --- | --- | --- | --- |
| success | `#16633D` | `#E8F6EF` | `styles.css:568-573`、`:938-941` |
| warning | `#8A6116` | `#FFF8E6` | `styles.css:954-957`、`:976-979` |
| danger | `#B3261E` | `#FFF5F5` | `styles.css:575-578`、`:981-984` |
| info | `#31465C` | `#EEF4FF` | `styles.css:943-947` |
| neutral / disabled | `#52525B` | `#F2F4F7` | `styles.css:959-964` |

⇒ 变量：`--success / --success-bg / --warning / --warning-bg / --danger / --danger-bg / --info / --info-bg / --neutral / --neutral-bg`。

### 4.3 排版 / 圆角 / 布局 Token

| 类别 | 设计值 | Token | 说明 |
| --- | --- | --- | --- |
| Page Title | 20-24px / 600 | `--text-page-title`（取 22px/600，行高 1.3） | 具体像素待参考图定稿，不影响 1-B 落地（此刻无消费者） |
| Section Title | 15-16px / 600 | `--text-section-title`（16px/600） | 对应现 `.panel h2` |
| Body | 13-14px / 400 | `--text-body`（14px/400） | |
| Secondary | 12-13px / 400 | `--text-secondary`（13px/400） | |
| Caption | 12px | `--text-caption`（12px） | |
| Metric Number | 24-28px / 600 | `--text-metric`（26px/600） | 对应现 `.metric strong` |
| Radius | 6 / 8-10 / 12 / 14 | `--radius-sm: 6px` `--radius-md: 10px` `--radius-lg: 12px` `--radius-xl: 14px` + shadcn 的 `--radius: 12px` | Card = 12px 对齐设计 §9；shadcn 的 `rounded-md = calc(--radius - 2px) = 10px`、`rounded-sm = 8px`，落在设计区间内 |
| Spacing | 4/8/12/16/20/24/32/40/48 | 沿用 Tailwind 默认 4px 体系，**不新增** | 设计 §5 与 Tailwind 默认刻度一致 |
| Layout | Sidebar 164px / Header 52px / Main padding 20px | `--app-sidebar-width: 164px`、`--app-header-height: 52px`、`--app-main-padding: 20px` | 仅 Phase 2 的 AppShell 消费 |
| Shadow | 普通 Card 优先 border | 不定义 elevation token，仅保留 Tailwind 默认 | 对齐设计 §7 |

### 4.4 1-B 验收

四道门禁全绿 + 三档视口**视觉零变化**（token 此刻没有任何消费者，只增加产物 CSS 中的变量声明）。

---

## 5. Phase 2 / Phase 3 实施顺序

### Phase 2 — AppShell（依赖 1-A + 1-B）

| 项 | 内容 |
| --- | --- |
| 新增文件 | `src/components/shell/AppShell.vue`、`AppSidebar.vue`、`AppHeader.vue`、`PageContainer.vue` |
| 修改文件 | `src/App.vue`（内联 sidebar → `<AppShell>` + `<RouterView />`）；`src/styles.css` **仅删除已确认零引用的 shell 专属规则**（`.app-shell/.sidebar/.brand/.brand-mark/.nav/.content`，删前逐条 grep） |
| 依赖 | `@lucide/vue`（设计 §12 要求统一图标体系） |
| 菜单 | **仍是现有 8 项、同一组路由、同一顺序**；不做二级菜单（D3） |
| Header（D9） | 只放有真实数据支撑的内容：页面标题/面包屑容器（纯路由信息，无网络请求）。**不实现** Search / Notification / User / System Status——后端虽有 `/health`、`/ready`，但前端 `api/` 没有对应模块，新增模块=改动 API 层（违反 D2）；如需要，单独批准后做 |
| 高亮 | 按 T8（可测试纯函数 + 单测），或保留现状——待你定夺 |
| 明确禁止 | `keep-alive`、路由懒加载改造、任何路由/参数/名称变更 |
| 风险 | 中：视图挂载/卸载时机变化会影响 3 处实时通道（页面离开必须停止 SSE/轮询） |
| 验收 | 8 项菜单逐条点击可达；13 条路由渲染正常；离开 `/workflows/:id`、`/requirements`、`/agent-run` 后 3 秒内不再有新请求；四道门禁全绿；三档视口无横向溢出 |

### Phase 3 — 基础 UI 组件（依赖 Phase 2，且**不接入任何页面**）

| 项 | 内容 |
| --- | --- |
| 依赖 | `reka-ui`、`clsx`、`tailwind-merge`、`class-variance-authority`、`tw-animate-css`（+ 已在 2 阶段引入的 `@lucide/vue`） |
| 新增配置 | `apps/web/components.json`（`aliases.components = @/components`、`aliases.utils = @/components/ui/utils`（T6）、`aliases.ui = @/components/ui`；**保留 1-B 的 token，不接受 CLI 写入的中性调色板（T7）**） |
| 新增文件（基础层） | `src/components/ui/utils.ts`（`cn()`）、`src/components/ui/{button,input,native-select,badge,card,dialog,tabs,tooltip,skeleton}.vue`（按 shadcn-vue 生成后按 AI-SE token 收敛变体） |
| 新增文件（AI-SE 公共层） | `src/components/common/{PageHeader,AppCard,StatusBadge,EmptyState,LoadingState,ErrorState,MetricCard,ConfirmDialog,DetailList,FormField}.vue` |
| 组件契约（硬性） | ① `Input/Select/FormField` 必须 `v-bind="$attrs"` 透传 `required/maxlength/min/max/type/step`（22 处原生校验不可失效）；② `Button` 内建 loading + disabled 与文案切换；③ `StatusBadge` 只做 status→视觉映射，**文案继续由 `viewmodels/` 提供**；④ 组件内**不得**调用任何 API/store |
| 测试 | 纯逻辑部分（如 status→variant 映射）放 `src/__tests__/`；组件不做渲染测试（项目无 jsdom/test-utils，本阶段不新增测试基建） |
| 明确禁止 | 不改页面文件；不改 `viewmodels/` 既有映射；不引入 Toast/Drawer/DataTable/FilterBar/Pagination（T10） |
| 风险 | 中：shadcn-vue CLI 需要联网从 registry 拉取组件源码（离线时改为手工落地源码并在报告说明） |

**顺序理由**：1-A/1-B 是零消费者改动（可独立回滚）→ Phase 2 建立"所有页面共享的外壳"（每页都被它影响，必须先稳）→ Phase 3 建立被后续所有页面复用的组件底座 → Phase 4 起才可逐页迁移，且**每次只迁移一个业务域**（D10）。

---

## 6. 已知问题优先级（必须现在处理 / 可后置）

### P0 —— 必须在 Phase 1 开工前作为约束固化（不是现在改代码）

| # | 问题 | 处置 |
| --- | --- | --- |
| P0-1 | 契约冻结：`api/`(47) / `router/`(13) / `stores/`(7) / `viewmodels/`(8 既有) / 3 处 SSE / 3 条权限红线 | 写入每个阶段的 DoD，每阶段收尾逐项核对（T13） |
| P0-2 | Preflight 会全局重置 `h1-h6` 字号 ⇒ 面板标题集体变小 | 决策 T1：1-A 只导入 theme + utilities（官方支持的关闭方式，已验证）；Preflight 后置到 Phase 11（T4） |
| P0-3 | legacy 未分层 ⇒ 工具类压不过 legacy 类 | 决策 T2/T3/T5：逐页换类，禁止用工具类覆盖 legacy 属性，新组件禁用 legacy 类名 |
| P0-4 | 配置文件改动授权（4 个文件） | 见 §7 开工前确认项 1 |
| P0-5 | `cn()` 落位与 AGENTS.md §5 的 `lib/` 禁令冲突 | 决策 T6：`src/components/ui/utils.ts` |
| P0-6 | `mcpSecurity.test.ts` 会扫描 `src/**/*.{ts,vue}` 全部新文件，且对 `api/mcp.ts` 的 fetch 写法与 MCP App 沙箱做逐字断言 | 新组件命名/注释不得含禁词；每阶段必跑 `test` |

### P1 —— Phase 2 / Phase 3 内处理

| # | 问题 | 处置 |
| --- | --- | --- |
| P1-1 | 5 条详情路由当前无菜单高亮（实证） | Phase 2 按 T8 决策（默认建议新增纯函数 + 单测） |
| P1-2 | `.error-banner` 被 3 页使用但**从未定义** | Phase 3 由 `ErrorState` 承接（属视觉缺陷修复，不改业务） |
| P1-3 | 22 处原生校验属性（`required/maxlength/min/max/type=url`） | Phase 3 组件契约强制透传；各页回归时逐字段核对 |
| P1-4 | 3 处同步 `window.confirm`（含"撤销后 Agent 调用将立即被拒绝"安全文案） | Phase 3 `ConfirmDialog`，保持 await 语义等价与原文案 |
| P1-5 | 中文单语 UI 文案被 14 个测试文件钉死，且 `docs/19-user-manual.md` 与菜单文案镜像 | 任何可见文案变更 → 同步改测试 + 用户手册（每阶段 DoD） |
| P1-6 | shadcn-vue 组件自带英文 aria/默认文案 | Phase 3 生成后统一中文化（不得回写 `viewmodels` 映射） |

### P2 —— 可后置（逐页迁移时顺带 / Phase 11 收口）

| # | 问题 | 处置 |
| --- | --- | --- |
| P2-1 | `styles.css` 内两个互相冲突的 `max-width:900px` 块 + 一个 `800px` 块 | 逐页迁移时按页删；Phase 11 统一清理 |
| P2-2 | 页面 `eyebrow` 暴露内部阶段号（阶段 0/4/5/6） | 属**文案决策**，待你定稿后一次性改（需同步 `docs/19`） |
| P2-3 | `Inter` 声明未加载任何字体文件 | 保持不动（T11）；Phase 11 评估是否收敛为系统字体 |
| P2-4 | `index.html` 的 `lang="en"` 与中文界面不符 | Phase 11 或视觉 QA 阶段修正 |
| P2-5 | 无 `aria-*` / 无 `:focus` 样式 | Phase 3 组件内建键盘/focus 行为；Phase 12 QA 检查项 |
| P2-6 | 7 个 API 导出零引用（`getTask`/`getTaskDependencies`/`getWorkflowGraph`/`listWorkflowTasks`/`listWorkflowEvents`/`listWorkflowApprovals`/`listAgentRunEvents`） | **只记录，本次重构永不处理**（属 API 层） |
| P2-7 | `requestJson` 在 7 个 api 模块中重复 | 同上，不在本次范围 |
| P2-8 | Toast / Drawer / DataTable / FilterBar / SearchInput / Pagination 不存在 | **不引入**（T10，新增即违反 D3） |

---

## 7. 风险与阻塞项

### 7.1 开工前需要你点一次头（3 项，均已给出建议答案）

| # | 事项 | 我的建议 | 影响面 |
| --- | --- | --- | --- |
| 1 | 授权修改 4 个既有文件：`apps/web/{package.json, vite.config.ts, tsconfig.json}` 与 `src/main.ts` | 批准（这是 Tailwind 接入的最小必要集，且不触碰任何业务文件） | 不批准则 Phase 1 无法开工 |
| 2 | `cn()` 落位 `src/components/ui/utils.ts`（而非 shadcn 默认的 `lib/`） | 采纳（避免与 AGENTS.md §5 冲突，且不新增目录） | 若坚持 `lib/`，需先修改 AGENTS.md §5 |
| 3 | 菜单高亮：是否允许"详情页也高亮所属一级菜单"（新增一个纯函数 + 单测，属视觉层） | 采纳（设计 §7 要求 Router 驱动；现状 5/13 路由无高亮） | 否决则 Phase 2 保留现状，验收口径相应调整 |

### 7.2 已消除的阻塞（本轮已实证）

| 项 | 结论 |
| --- | --- |
| Tailwind 4 × Vite 8 兼容性 | 已核实：`@tailwindcss/vite@4.3.3` peer = `vite ^5.2 \|\| ^6 \|\| ^7 \|\| ^8` |
| Preflight 造成的全局视觉回归 | 已有官方关闭方式（只导入 theme + utilities），Phase 1 采用 |
| "Tailwind 与现有 CSS 能否共存" | 能：legacy 未分层恒定优先 ⇒ 迁移期视觉可控；代价是必须逐页换类（已写成规则 T3） |
| 设计文档要求但代码不存在的页面/菜单 | D3 已明确不新增，不构成阻塞 |

### 7.3 持续存在的风险（需在每个阶段内管理）

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 无参考图 | 仓库内无 Figma / 截图 | Visual QA 以 Design System 为唯一基准（D6）；一旦提供参考图再补逐页比对 |
| 无组件渲染测试 | Vitest 为 node 环境，53 个用例全是逻辑测试 | 每页人工 Visual + Functional QA；不在本次新增测试基建 |
| 无 `.git` | 变更核对只能靠文件清单（AGENTS.md §1） | 每阶段报告列出 Modified/New 文件清单；Tailwind 扫描范围需显式限定（见 1-A 第 5 项） |
| 三种实时通道 | 3 个 store 的 SSE/轮询单例靠页面卸载收尾 | Phase 2 禁 `keep-alive`；每页迁移后验证离开页面后无新请求 |
| 迁移期主色/壳层观感不一致 | 未迁移页面仍是旧蓝/深色侧栏 | 预期内现象，Phase 12 统一收口；不追求"中途全站一致" |
| CLI 依赖网络（Phase 3） | shadcn-vue 需要从 registry 拉取组件源码 | 离线时手工落地组件源码并在报告中说明来源 |

### 7.4 仍未决但**不阻塞**开工的事项（可在对应阶段前答复）

浏览器基线（建议：现代浏览器，T12）；Toast 是否引入（建议：不引入）；`Inter` 字体是否收敛为系统字体（建议：Phase 11 再定）；`eyebrow` 阶段号文案定稿（建议：Phase 12 前给）；参考图是否提供（建议：提供后补做像素级比对）。

---

## 8. 最终回答

**READY**

- Phase 1-A 与 1-B 的改动范围已收敛到 **4 个既有文件 + 1 个新建 CSS 文件**，零页面、零业务文件。
- 两个最可能毁掉"零视觉变化"的技术陷阱（Preflight 全局重置、legacy 未分层优先）均已定位到机制层面，并已给出官方支持的处置方式。
- 契约边界（API 47 / 路由 13 / Store 7 / ViewModel 8 / SSE 3 / 权限 3 红线）已全部量化，可作为每阶段验收清单。
- 剩余 3 项均为**授权类**确认（§7.1），不涉及方案不确定性；收到确认即可开始 Phase 1-A。
- 本阶段严格遵守硬性限制：未修改代码、未安装依赖、未改动 API/Router/Store/ViewModel/业务逻辑、未新增页面或菜单、未删除 Legacy CSS。
