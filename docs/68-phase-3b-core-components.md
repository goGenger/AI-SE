# Phase 3-B — Core Visual Components（实施记录）

> 阶段：Phase 3-B（第一批核心视觉组件）
> 依据：`docs/design/00-design-system.md`、`04-component-system.md`、`01-refactoring-rules.md`、`docs/61-phase-0-ui-refactoring-decisions.md`、`docs/64`/`65`/`66`（Phase 2）、`docs/67`（Phase 3-A）、`docs/ui-reference/ai-se-home.png`
> 范围：仅组件基础设施；不迁移任何业务页面
> 日期：2026-09-15

---

## 1. 交付物总览

7 个基础组件、19 个文件，全部位于 `apps/web/src/components/ui/`：

| 组件 | 文件 |
| --- | --- |
| Button | `button/Button.vue` + `button/index.ts`（导出 `Button` / `buttonVariants` / `ButtonVariants`） |
| Card | `card/{Card,CardHeader,CardTitle,CardDescription,CardContent,CardFooter}.vue` + `card/index.ts` |
| Badge | `badge/Badge.vue` + `badge/index.ts`（导出 `Badge` / `badgeVariants` / `BadgeVariants`） |
| Input | `input/Input.vue` + `input/index.ts` |
| Textarea | `textarea/Textarea.vue` + `textarea/index.ts` |
| Label | `label/Label.vue` + `label/index.ts` |
| Separator | `separator/Separator.vue` + `separator/index.ts` |

约束遵守：未创建 `lib/` `shared/` `helpers/` `widgets/` `business-components/`；未创建任何业务组件；未生成 Dialog / Drawer / Sheet / DropdownMenu / Select / Tabs / Tooltip / Popover / Table / DataTable / Pagination / Toast / Form / Calendar。

## 2. 修改文件（3 个）

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `apps/web/src/styles/app.css` | **移除** Phase 3-A 加入的 4 组 shadcn 颜色别名（`--popover*` / `--secondary*` / `--accent*` / `--destructive*` 及其 `@theme inline` 映射） | 见 §6.1：`--color-secondary` 与排版 Token `--text-secondary` 发生命名空间冲突，导致 `text-secondary` 字号工具类**完全不生成**；且这 4 组别名与既有 Token 语义重复（违反本阶段 §4）。移除后 app.css 回到 Phase 1-B 的 Token 集合 |
| `apps/web/src/components/ui/utils.ts` | `cn()` 扩展 `extendTailwindMerge`，把 9 个排版 Token 登记进 **font-size 分组** | 见 §6.2：tailwind-merge 默认把未知 `text-*` 当作颜色类，会静默吞掉字号类 |
| `apps/web/vitest.config.ts` | 加入 `@vitejs/plugin-vue` | 见 §6.3：组件契约测试需渲染 `.vue`；插件已在 devDependencies（`vite.config.ts` 在用），**未新增依赖** |

未新增任何依赖；`package.json` 未修改。

## 3. 组件契约

### Button
- variants：`default`（Primary `#6C5CE7`）/ `secondary`（`bg-muted` + `hover:bg-border`）/ `destructive`（`bg-danger`，白字）/ `outline`（`border-border` + `bg-card`）/ `ghost`（透明 + hover muted）/ `link`（Primary 文字 + hover 下划线）
- sizes：`default` 36px / `sm` 32px / `lg` 40px / `icon` 36×36
- 状态：`disabled`（原生属性 → pointer-events-none + opacity 0.6）、`focus-visible`（2px Primary ring）、`hover`、`active`、`appearance-none` + `cursor-pointer`
- 导出 `buttonVariants()`，供后续业务页面为 `<a>` / `<RouterLink>` 复用样式（但注意 §7 的 legacy `a{color}` 陷阱）

### Card
- `Card`：白底 + `border-border` + `rounded-lg`(12px) + **无阴影**（设计 §7 优先 border）
- `CardHeader` / `CardContent` / `CardFooter`：内距取 `--card-padding`（20px），Content/Footer `pt-0`
- `CardTitle`（`<h3>`，`text-section-title`）/ `CardDescription`（`<p>`，`text-secondary` + `text-muted-foreground`）
- **未启用 Preflight 的补偿**：Title / Description 显式 `m-0`，避免 UA 默认外边距

### Badge（胶囊，`text-caption`）
- `default`（Primary）/ `secondary`（`bg-muted`）/ `success`（`bg-success-bg` `text-success`）/ `warning`（`bg-warning-bg` `text-warning`）/ `destructive`（`bg-danger-bg` `text-danger`）
- 状态色**全部复用既有语义 Token**，未新增任何状态色

### Input / Textarea
- 状态：`normal` / `focus-visible`（2px Primary ring）/ `disabled`（原生属性 → cursor-not-allowed + opacity 0.6）/ `invalid`（`aria-invalid="true"` → `border-danger`）
- 边框/底色/文字色全部取自 Token（`border-input` / `bg-card` / `text-foreground` / `placeholder:text-foreground-muted`）
- `v-model` 可用（`defineModel`，默认值 `""`）；组件不施加 `.trim` / `.lazy` 修饰符（已在组件注释中说明）

### Label
- 原生 `<label>`，`for` 经 $attrs 透传，由浏览器完成与控件的关联（点击聚焦 + 屏幕阅读器），无需额外运行时依赖

### Separator
- `orientation="horizontal"`（默认，`h-px w-full`）/ `"vertical"`（`w-px h-full` + `aria-orientation`）；`role="separator"`

### 通用
- 全部 Vue 3 + TypeScript + `<script setup>` + Tailwind utility + `cn()`
- **未使用 Reka UI**：本批 7 个组件均为原生元素即可达成，`reka-ui` 保持已安装但未引用（留给后续 Dialog/Select 等浮层组件）；未引入新的 icon package，也未使用任何图标
- 无业务依赖：不访问 API / Store / Router / 业务状态，不写死业务文案或业务数据，不设置默认 `type`

## 4. 测试（`apps/web/src/__tests__/uiComponents.test.ts`）

方法：用 **Vue 官方 SSR 渲染**（`vue/server-renderer`）在 Node 环境下断言真实 DOM 输出 —— 无需 jsdom / @vue/test-utils，未新增测试依赖，未改动现有测试环境配置。

| 覆盖项 | 断言要点 |
| --- | --- |
| Button variant | 6 个 variant 各自映射到既有 Token（含 `bg-muted` / `bg-danger` / `bg-transparent` / `hover:bg-*`） |
| Button size | 32 / 36 / 40 / 36（icon） |
| Button disabled | 原生 `disabled` + `disabled:pointer-events-none` + `disabled:opacity-60` |
| Button 原生外观屏蔽 | `appearance-none` / `cursor-pointer` / `border-transparent` |
| Button focus-visible | `focus-visible:ring-2` + `focus-visible:ring-ring` |
| Button class 合并 | 传入 `h-12 w-full` 时 `h-9` 被消解 |
| Button 属性透传 | `type="submit"` / `data-*` 原样落到 `<button>` |
| Card 组合 | Header+Title+Description+Content+Footer 组合渲染；`<h3>` / `<p>` 标签正确；**断言不含 shadow** |
| Card class 合并 | 含 `m-0`（未启用 Preflight 的 UA 外边距归零）与 `pt-0` |
| Badge variant | 5 个 variant；状态色 = success / warning / danger Token |
| Input / Textarea | 默认 Token 类、`disabled`、`aria-invalid="true"`、`placeholder`、`focus-visible`、class 合并 |
| Label | `for` 透传 + 与 Input `id` 成对出现 |
| Separator | horizontal（`h-px`，无 `aria-orientation`）/ vertical（`w-px` + `aria-orientation="vertical"`）/ class 合并 |
| cn() 回归 | 字号 Token 与颜色类共存时**都保留**；同组冲突仍按后写覆盖 |

结果：`16 files / 74 tests passed`（基线 15 / 53 + 本阶段 21 个用例，**基线用例零减少、零修改**）。

真实浏览器的 hover / focus-visible / 布局验证不在单元测试内，见 §5。

## 5. 浏览器验证（真实浏览器 + 真实级联环境）

用临时 playground（`apps/web/playground.html` + `apps/web/src/playground.ts`，**验证后已删除**，未注册路由、未改 Router/AppShell、构建入口仍为 `index.html`），以 `vite dev` 打开，`app.css` 与 legacy `styles.css` 同时加载，即真实共存环境。

### 5.1 Token 落地（实测值）

| 项目 | 实测 | 期望 |
| --- | --- | --- |
| Button default 底色 | `rgb(108, 92, 231)` | `--primary #6C5CE7` ✓ |
| Button 文字/高度/圆角/排版 | `#fff` / 36px / 10px / **14px 500**（行高 22.4px = 14×1.6） | Token ✓ |
| Button sizes | 32 / 36 / 40 / 36 | ✓ |
| Button outline 边框 | `1px solid rgb(232, 234, 240)` | `--border` ✓ |
| Button ghost / link 底色 | `rgba(0,0,0,0)` | 透明（未被 UA `buttonface` 污染）✓ |
| Button disabled | opacity 0.6 + 原生 disabled | ✓ |
| Badge 排版/状态色 | 12px；success `rgb(236,253,245)`/`rgb(5,150,105)`、warning `rgb(217,119,6)`、destructive `rgb(220,38,38)` | Token ✓ |
| Card | 白底 / `1px rgb(232,234,240)` / 12px / **box-shadow: none** | 设计 §7 ✓ |
| CardTitle / CardDescription | 16px 600 `rgb(31,41,55)` / 13px `rgb(107,114,128)`，margin 0 | Token ✓ |
| Input | 36px / `1px rgb(232,234,240)` / 白底 / **14px 400** / 圆角 10px | Token ✓ |
| Input disabled / invalid | opacity 0.6 / `rgb(220,38,38)` | Token ✓ |
| Textarea | min-height 80px / **14px** / invalid `rgb(220,38,38)` | Token ✓ |
| Label | **13px 500 `rgb(31,41,55)`** | Token ✓ |
| Separator | 水平 1px `rgb(232,234,240)`；垂直 1px + `aria-orientation=vertical` + `role=separator` | ✓ |
| 横向溢出 | `scrollWidth 1265 ≤ innerWidth 1280` | 无溢出 ✓ |
| 按钮外观 | `appearance: none`、`cursor: pointer`、边框 1px 实线（非 UA `2px outset`） | ✓ |

### 5.2 交互实测（真实事件，非样式声明检查）

| 交互 | 手段 | 实测 |
| --- | --- | --- |
| Primary hover | CDP 真实鼠标移动 | `rgb(91, 75, 214)` = `--primary-hover` ✓ |
| secondary hover | 同上 | `rgb(232, 234, 240)` = `--border` ✓ |
| outline / ghost hover | 同上 | `rgb(248, 249, 252)` = `--muted` ✓ |
| link hover | 同上 | `text-decoration: underline` ✓ |
| focus-visible（Button） | CDP 真实键盘 Tab | `:focus-visible` 匹配；`box-shadow` 含 `rgb(108, 92, 231) 0 0 0 2px` = Primary ring，`outline: none` ✓ |

### 5.3 控制台

`window.onerror` / `unhandledrejection` 记录为空；页面无 `[Vue warn]`。业务应用（`vite preview`）8 条一级路由 + 1 条详情路由复测：侧栏 164px、Header 52px、Main 内距 20px、8 项菜单、active 正确（`/projects/:id` 详情高亮「项目」，`bg-primary-light`）、真实 API 正常（详情页显示真实项目 Mini Todo）、无横向溢出、`--primary` 仍为 `#6c5ce7`。

## 6. 本阶段发现并修复的真实缺陷

### 6.1 命名空间冲突：`--color-secondary` 吞掉 `text-secondary` 字号（P1）
- **现象**：Label / CardDescription 在浏览器中字号为 16px（应为 13px），且文字色变成 `rgb(248,249,252)`（几乎不可见）。
- **根因**：Phase 3-A 为 shadcn 兼容而加入的 `@theme inline --color-secondary` 与 Phase 1-B 的排版 Token `--text-secondary` **同名**。Tailwind 对 `text-*` 的命名空间解析因此只产出颜色工具类：产物中只有 `.text-secondary{color:var(--secondary)}`，`.text-secondary{font-size:13px}` **完全未生成**。
- **修复**：移除 Phase 3-A 的 4 组重复语义颜色别名，app.css 回到 Phase 1-B Token 集合；Button `secondary` 改用 `bg-muted`、Badge `secondary` 改用 `bg-muted text-muted-foreground`、Button `destructive` 文字改用 `--primary-foreground`（白）。修复后产物中 `.text-secondary{font-size:13px;…}` 正常生成，浏览器实测 13px ✓。
- **教训**：向 `@theme` 增补 `--color-*` 别名前，必须检查是否与既有 `--text-*` / `--radius-*` 等命名空间同名。

### 6.2 tailwind-merge 把自定义排版 Token 误判为颜色（P1）
- **现象**：`cn("text-caption", "text-success")` → `"text-success"`，`cn("text-body", "text-primary-foreground")` → `"text-primary-foreground"`：字号类被静默删除（Badge 会从 12px 变成 14px，Button 字号丢失）。
- **根因**：tailwind-merge 不认识项目自定义的 `--text-*` 名称，把任何未知 `text-*` 视为文字颜色，与真正的颜色类视为同组冲突。
- **修复**：`cn()` 用 `extendTailwindMerge` 将 9 个排版 Token（`page-title` / `section-title` / `card-title` / `body` / `secondary` / `caption` / `metric` / `nav` / `nav-sub`）登记进 `font-size` 分组，并补回归测试（§4 最后一行）。
- **影响面**：所有后续使用 `text-{token}` 的组件与页面，属于基础设施级修复。

### 6.3 未启用 Preflight 带来的 UA 原生控件外观泄漏（P2）
- **现象**：非 outline 变体的按钮带 `border: 2px outset`，ghost / link 按钮底色为 `rgb(239,239,239)`（`buttonface`）；`cursor` 为 `default`。
- **根因**：Preflight 被刻意关闭（Phase 0 决策 T1），UA 对 `<button>` 的原生外观未被重置。
- **修复**：Button 基类加入 `appearance-none cursor-pointer border border-transparent`；`ghost` / `link` 显式 `bg-transparent`。实测按钮外观已完全由 Token 控制 ✓。

### 6.4 legacy 未分层 `font: inherit` 压过排版工具类（P2）
- **现象**：Button / Input / Textarea 的 `text-body` / `font-medium` 无效，浏览器中为 16px / 400（继承值）。
- **根因**：`styles.css:31-36` 存在**未分层**的 `button, input, select, textarea { font: inherit }`。按既有结论（Phase 0 T2/T3：未分层声明恒定优先于任何 `@layer` 内声明），它会吃掉 `@layer utilities` 里的所有字体相关工具类。
- **修复**：按既有共存规则（"必要时使用 scoped 样式"，Phase 2-A 处理 `a{color}` 的同款手法），在 Button / Input / Textarea 内加 **scoped 样式**重新声明字号/行高/字重，取值全部来自 Token（`var(--text-body)` / `var(--text-body--line-height)` / `var(--font-weight-medium)`），**未使用 `!important`、未新增全局规则、未修改 styles.css**。实测 14px / 500（Button）、14px / 400（Input / Textarea）✓。
- **已知副作用（记录）**：该 scoped 规则未分层，因此使用方传入的 `text-*` 工具类**无法**再覆盖这三个组件的字号（需在组件外层容器设置）。Phase 11 清理 legacy CSS 后应回退为纯工具类方案。

### 6.5 其他
- Separator 模板中的嵌套双引号（`:aria-orientation="orientation === "vertical" …"`）导致 Vite 无法解析 SFC —— 由组件测试在接入 `@vitejs/plugin-vue` 后立即暴露，已改为单引号。
- lint 新增 5 条 `vue/require-default-prop` 警告（`class` / `modelValue` 无默认值），已通过补默认值（`class: ""`、`defineModel({ default: "" })`）消除，`lint` 恢复 0 problem。

## 7. 已知风险与遗留问题（只记录，本阶段不修）

1. **legacy `a { color: #1d4f91 }`（未分层）仍然会压过一切链接类工具类**。浏览器实测：playground 中 `<a class="text-primary">` 计算色为 `rgb(29, 79, 145)`（legacy 蓝），而非 `--primary`。影响：`buttonVariants()` 若用于 `<a>` / `<RouterLink>`（后续页面迁移中的常见写法），文字色会被 legacy 规则覆盖。`<Button>` 本身渲染 `<button>`，不受影响。需在 Phase 4+ 页面迁移时用（与 Phase 2-A 相同的）scoped 规则或改用具名类处理；根治留待 Phase 11。
2. **Button / Input / Textarea 的字号不可由使用方用工具类覆盖**（§6.4 副作用）。
3. **`.trim` / `.lazy` 组件修饰符不生效**：`Input` / `Textarea` 使用 `defineModel`，不处理组件修饰符；页面迁移时如依赖 `v-model.trim` 需在页面侧 trim。
4. **按钮无默认 `type`**：与原生按钮一致，`<form>` 内默认 submit。页面迁移时需继续显式声明 `type`（现有 11 个业务页面均如此）。
5. **未使用 Reka UI**：本批 7 个组件均为原生元素实现；`reka-ui` 仍为"已安装未引用"状态，将在后续浮层组件（Dialog / Select / Tabs…）阶段首次使用。
6. **`tw-animate-css` 仍未安装**：本批组件不需要动画，未引入（符合本阶段 §14）。
7. **CSS 体积**：Tailwind 按 `@source` 扫描源码生成工具类，因此构建产物已包含这些组件用到的工具类（CSS 17.01 → 20.79 kB），即使业务页面尚未引用；JS 体积不变（277.46 kB，组件未被业务代码 import）。
8. **无渲染测试框架**：本阶段用 SSR 渲染做契约测试（零依赖）；真实交互（hover / focus / 布局）依赖人工浏览器验证，未纳入 CI。

## 8. Gate

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `corepack pnpm --filter @ai-se/web typecheck` | **PASS**（exit 0） |
| lint | `corepack pnpm --filter @ai-se/web lint` | **PASS**（exit 0，0 problem） |
| test | `corepack pnpm --filter @ai-se/web test` | **PASS**：16 files / 74 tests（基线 15 / 53 全数保留） |
| build | `corepack pnpm --filter @ai-se/web build` | **PASS**（`index-BoDNK6Uy.css` 20.79 kB / `index-BxriTABW.js` 277.46 kB） |

## 9. 业务影响

- API：unchanged
- Router：unchanged（`router/index.ts` mtime 仍为 9 月 11 日）
- Store：unchanged
- ViewModel：unchanged
- SSE：unchanged
- Business Views：unchanged（11 个 View 全部未改）
- AppShell / AppSidebar / AppHeader：unchanged
- `styles.css`：unchanged（仍为 Phase 2-A 后的 960 行）
- Design Token：**数值零变更**；app.css 中移除的是 Phase 3-A 新增的重复语义别名，Token 集合回到 Phase 1-B 状态

## 10. 结论

**PASS**。7 个基础组件（Button / Card / Badge / Input / Textarea / Label / Separator）已完成，全部基于既有 Design Token，零业务依赖，契约测试 21 例，真实浏览器验证通过（Token / hover / focus-visible / disabled / invalid / border / radius / typography / 无横向溢出），四项门禁全绿，业务与既有契约零改动。同时修复了 4 个只有在真实渲染环境才会暴露的基础设施缺陷（§6）。

按阶段纪律**在此停止**，不进入 Phase 3-C，不开始 Dashboard / Projects / Requirements，不迁移任何现有页面。
