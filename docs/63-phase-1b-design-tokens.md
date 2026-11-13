# Phase 1-B — Design Token（实施记录）

> 阶段：Phase 1-B（Design Token 落地）
> 依据：`docs/design/00-design-system.md`、`docs/61-phase-0-ui-refactoring-decisions.md`、`docs/ui-reference/ai-se-home.png`
> 取值优先级：**Design System > UI Reference > 当前 styles.css**
> 范围：仅 Token；不含组件、页面、业务功能
> 日期：2026-09-15

---

## 1. 修改了哪些文件

**仅 1 个文件**：`apps/web/src/styles/app.css`（Phase 1-A 新建的文件，本阶段在其上追加 Token 层）。

未触碰：`views/*`、`components/*`（不存在）、`router/`、`api/`、`stores/`、`viewmodels/`、`styles.css`、`main.ts`、`vite.config.ts`、`package.json`、`tsconfig.json`、锁文件。

文件结构变为三段：① Tailwind 入场（保持不变）→ ② `:root` 原始 Token → ③ `@theme inline` 映射。

## 2. 建立了哪些 Token

### 2.1 Color（29 个变量）

| 组 | 变量 | 值 | 来源 |
| --- | --- | --- | --- |
| 表面 | `--background` / `--card` / `--muted` | `#f6f7fb` / `#ffffff` / `#f8f9fc` | 设计文档 §3 |
| 文本 | `--foreground` / `--muted-foreground` / `--foreground-muted` / `--foreground-disabled` | `#1f2937` / `#6b7280` / `#9ca3af` / `#d1d5db` | 设计文档 §3 |
| 边框 | `--border` / `--border-strong` / `--input` | `#e8eaf0` / `#dde0e8` / `#e8eaf0` | 设计文档 §3 |
| 焦点 | `--ring` | `#6c5ce7` | = Primary |
| 品牌 | `--primary` / `--primary-foreground` / `--primary-hover` / `--primary-light` / `--primary-soft` | `#6c5ce7` / `#ffffff` / `#5b4bd6` / `#f0edff` / `#f7f5ff` | 设计文档 §3 + 决策 D7 |
| 语义 | `--success` / `--warning` / `--danger` / `--info` / `--neutral` | `#059669` / `#d97706` / `#dc2626` / `#2563eb` / `#52525b` | 色相取自 UI 参考图实测（设计文档只要求"低饱和"，未给值） |
| 语义背景 | `--success-bg` / `--warning-bg` / `--danger-bg` / `--info-bg` / `--neutral-bg` | `#ecfdf5` / `#fffbeb` / `#fef2f2` / `#eff6ff` / `#f2f4f7` | 同上（600 级文字 + 50 级背景） |

映射为工具类：`bg-background`、`bg-card`、`bg-muted`、`text-foreground`、`text-muted-foreground`、`text-foreground-muted`、`text-foreground-disabled`、`border-border`、`border-border-strong`、`bg-primary`、`text-primary-foreground`、`bg-primary-hover`、`bg-primary-light`、`bg-primary-soft`、`ring-ring`、`bg-success`/`bg-success-bg`/`text-success`、`bg-warning*`、`bg-danger*`、`bg-info*`、`bg-neutral*`。

### 2.2 Typography（9 组 `--text-*`，每组含 size + line-height + font-weight）

| Token | 值 | 用途 / 来源 |
| --- | --- | --- |
| `--text-page-title` | 24px / 1.35 / 600 | 页面标题（设计 §4：20-24px/600；取上限） |
| `--text-section-title` | 16px / 1.4 / 600 | 区块标题（设计 §4：15-16px/600） |
| `--text-card-title` | 14px / 1.45 / 600 | 卡片标题（设计未单列；UI 参考图补充） |
| `--text-body` | 14px / 1.6 / 400 | 正文（设计 §4：13-14px/400） |
| `--text-secondary` | 13px / 1.55 / 400 | 次要文本（设计 §4：12-13px/400） |
| `--text-caption` | 12px / 1.5 / 400 | 说明/元信息（设计 §4：Caption 12px） |
| `--text-metric` | 28px / 1.2 / 600 | 指标数字（设计 §4：24-28px/600，取上限） |
| `--text-nav` | 14px / 1.45 / 500 | 一级菜单（UI 参考图） |
| `--text-nav-sub` | 13px / 1.45 / 400 | 二级菜单（`02-navigation.md` §4 指定 13px） |

产出工具类：`text-page-title` / `text-section-title` / `text-card-title` / `text-body` / `text-secondary` / `text-caption` / `text-metric` / `text-nav` / `text-nav-sub`（**实测每个类同时输出 font-size + line-height + font-weight**，见 §5）。

### 2.3 Radius（5 个）

`--radius-sm: 6px`、`--radius-md: 10px`、`--radius-lg: 12px`、`--radius-xl: 14px`（设计 §6 的 6 / 8-10 / 12 / 14）；另有 shadcn 锚点 `--radius: 12px`（= Card 圆角，`calc(var(--radius) - 2px)` 得 10px，仍在设计区间内）。产出 `rounded-sm/md/lg/xl`；**Card 使用 `rounded-lg`（12px）**。

### 2.4 Shadow（2 个）

`--shadow-subtle`（`0 1px 2px rgb(16 24 40 / .04), 0 1px 3px rgb(16 24 40 / .06)`）、`--shadow-overlay`（`0 4px 12px rgb(16 24 40 / .08), 0 2px 4px rgb(16 24 40 / .04)`）。
设计 §7 要求"普通 Card 优先使用 border，而不是明显阴影" ⇒ **Card 不使用阴影**，`--shadow-overlay` 仅供后续 Dialog / Dropdown / Toast。数值风格取自 UI 参考图的极轻投影。

### 2.5 Layout / Spacing（5 个常量）

`--app-sidebar-width: 164px`、`--app-header-height: 52px`、`--app-main-padding: 20px`（设计 §8 / `03-page-layout.md` §2）、`--card-padding: 20px`、`--section-gap: 24px`（设计 §5 区间的上限）。由 AppShell / 公共组件以 `var()` 引用，不产出工具类。

### 2.6 有意"不建立"的 Token

| 未建立 | 原因 |
| --- | --- |
| 字体族 `--font-sans` | Tailwind 默认值（`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto…`）即设计 §4 要求的"系统无衬线字体"，覆写无收益 |
| 间距刻度 `--spacing-*` | Tailwind 默认 `--spacing: 0.25rem`（4px 体系）与设计 §5 的 4/8/12/16/20/24/32/40/48 **完全一致**，无需覆写 |
| 组件级颜色（Button/Card/Badge 专用色） | 属 Phase 3 组件层，Token 只管语义 |
| 深色模式变量（`.dark`） | 决策 D8：仅 Light Theme |

## 3. UI Reference 对 Token 的影响

对 `ai-se-home.png` 做了**像素级实测**（不是目测）：全图按 4-bit 量化统计色彩频率 + 逐列/逐行暗线扫描定位布局分隔线。

### 3.1 被参考图**改变**的 Token（3 处）

| Token | 参考图实测 | 采用值 | 说明 |
| --- | --- | --- | --- |
| 语义状态色（success / warning / danger） | 色相实测：绿 ≈158°、红 ≈359°、琥珀 ≈42°（像素很少，仅为小圆点/徽标） | `#059669` / `#dc2626` / `#d97706`（+ 50 级背景） | 设计文档只说"低饱和"未给值；**参考图色相被采纳**，同时**不采用** `styles.css` 里更灰的旧语义色（`#16633D/#B3261E/#8A6116`） |
| `--text-card-title`（14px/600）、`--text-nav`（14px/500） | 卡片标题与一级菜单的文字规格 | 采纳 | 设计文档未定义这两个槽位，由参考图补足 |
| 阴影风格 | 极轻双层投影 | `--shadow-subtle` / `--shadow-overlay` | 设计 §7 只约束"Card 不加明显阴影"，未给数值 |

### 3.2 参考图**佐证但未改变**设计文档的 Token（2 处，关键）

| 项 | 参考图实测 | 设计文档 | 结论 |
| --- | --- | --- | --- |
| 主色 | **`#6450F8`**（hue 247°、sat 0.68） | `#6C5CE7`（hue **247°**、sat 0.60） | **同色相**，参考图饱和度略高 ⇒ 按优先级采用设计值 `#6C5CE7`；参考图的作用是**验证色相无误** |
| 侧栏宽 / Header 高 | 分隔线实测 x≈**179** / y≈**53** | 164px / 52px | 同一量级 ⇒ 采用设计值；两者共同说明**当前代码的 240px 侧栏与"无 Header"是偏离项** |

### 3.3 被参考图**推翻/收敛**的取值（1 处，优先级规则的体现）

| 项 | 参考图实测 | 采用值 | 理由 |
| --- | --- | --- | --- |
| 指标数字 | ≈32px（更大的数字体重） | `--text-metric: 28px` | 设计 §4 上限为 28px，**Design System > UI Reference**；同时符合设计 §4"普通业务页面不要使用超大标题"的意图 |

### 3.4 参考图中**明确不采纳**的内容

一级菜单（首页/项目管理/工作流/任务管理/智能体/部署管理/代码仓库/系统设置）、欢迎横幅、快速开始、项目数据概览、当前工作流、最近动态、系统状态、"我的项目"表格、AI 助手卡、搜索/通知/用户区 —— 这些**均不在本阶段落地**（不新增业务功能、路由、菜单、数据）。仅有其**视觉语言**（颜色、字号、圆角、阴影、间距节奏）被提取为 Token。

## 4. 四项门禁结果

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| Type Check | `corepack pnpm --filter @ai-se/web typecheck` | **PASS**（exit 0） |
| Lint | `corepack pnpm --filter @ai-se/web lint` | **PASS**（exit 0） |
| Test | `corepack pnpm --filter @ai-se/web test` | **PASS**：Test Files 15 passed (15) / Tests 53 passed (53) |
| Build | `corepack pnpm --filter @ai-se/web build` | **PASS**（exit 0，两次构建产物哈希一致 = `index-B773izRz.css`） |

## 5. 验证证据（除门禁外的实测）

1. **映射正确性（临时探针构建）**：把项目外探针文件登记为 `@source`，构建产物中出现
   `.bg-background{background-color:var(--background)}`、`.border-border{border-color:var(--border)}`、
   `.rounded-lg{border-radius:12px}`、`.rounded-xl{border-radius:14px}`、
   `.text-page-title{font-size:24px;line-height:var(--tw-leading,1.35);font-weight:var(--tw-font-weight,600)}`
   ⇒ 颜色按引用输出、圆角/字号按设计值输出、**`--text-*--font-weight` 在本版本受支持**。验证后探针已移除并重建（`app.css` 内探针引用数 = 0）。
2. **Token 运行时可用（真实浏览器）**：读取根元素计算样式得 `--primary: #6c5ce7`、`--app-sidebar-width: 164px` ⇒ Token 在浏览器中真实生效，不只是写在源码里。
3. **产物内容**：构建产物含 `:root{--background:#f6f7fb; … --app-sidebar-width:164px; …}`（Token 原样落地）。
4. **视觉零变化**：与 Phase 1-A 基线逐项一致 —— `.sidebar` 背景 `rgb(16,32,51)`、`.page-header h1` 32px/700、`.metric strong` 28px、`.button.primary` 背景 `rgb(29,111,211)`、`.nav a.router-link-active` 背景 `rgb(33,57,82)`、`body` margin 0；注入探针 `h2` = 24px、`ul` = `disc` ⇒ **Preflight 仍未引入**。
5. **体积**：产物 CSS 11.60 kB → 12.29 kB（+0.69 kB，全部为 Token 声明，无任何新样式规则）；JS 271.44 kB 不变。

## 6. 是否修改了业务 / API / Router / Store / View

**全部为"否"**：

| 对象 | 是否改动 |
| --- | --- |
| Views（11 个） | 否（mtime 均 ≤ 9 月 14 日） |
| Components | 否（目录仍不存在） |
| Router | 否（mtime 9 月 11 日） |
| API（7 模块 / 47 函数） | 否 |
| Stores（7 个） | 否 |
| ViewModels（8 个） | 否 |
| `styles.css` | 否（mtime 9 月 11 日，未触碰） |
| `main.ts` / `vite.config.ts` / `package.json` / 锁文件 | 否（均为 Phase 1-A 的时间戳，本阶段未再改动） |
| 业务逻辑 / SSE / 权限 | 否 |

## 7. 结论

**PASS** —— Design Token 已按"Design System > UI Reference > styles.css"的优先级落地，四项门禁全绿，业务/API/Router/Store/View 零改动，视觉零变化。

下一步：**Phase 2（AppShell）** —— 按阶段纪律此处停止，等待指令，不自动推进。
