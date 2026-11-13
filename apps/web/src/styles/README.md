# AI-SE 前端设计与令牌规范

本目录是 `apps/web` **唯一的样式来源**。新页面、新组件一律按本文选值；本文没写的档位就是不存在，需要新档时先改这里和 `app.css`，不要在页面里就地造一个。

- 令牌定义：[`app.css`](./app.css)
- 团队设计规范（意图与取舍）：[`docs/design/00-design-system.md`](../../../../docs/design/00-design-system.md)

---

## 0 · 层序

```
@layer theme, base, components, utilities;
```

1. **theme** — Tailwind 内置变量。
2. **base** — 全局 reset 与元素默认值（盒模型、`body`、链接默认继承颜色、表单控件继承字体）。**基础层只放这些，不放任何组件或页面样式。**
3. **components** — 具名的组件级样式，目前两条：`.detail-row`（「字段名 / 值」详情行）、`.tone-dot`（语义色调点）。判据是**「工具类表达不了」且「多处以同一形态重复」**——两条都满足才往这里加。
4. **utilities** — Tailwind 工具类，能覆盖 base 与 components。

页面的手写 `<style scoped>` 是**未分层**的，按 CSS 级联规则它优先于上面四层。所以：

> **不要把组件/页面的视觉写进 scoped CSS** —— 它会恒压工具类，并且无法被覆盖。能用工具类表达的，一律用工具类。scoped 只留给工具类表达不了的东西（`::before` 装饰、`[data-tone]` 变体、animation keyframes）。

### 本项目**不含** Tailwind preflight —— 原生标签的 UA 外观要自己关

`app.css` 只导入 `tailwindcss/theme.css` 与 `tailwindcss/utilities.css`，**显式排除了 preflight**（见该文件头 1）。`@layer base` 里的 reset 是手写的，只管盒模型、`body`、链接颜色与「表单控件继承字体」。

这意味着一个坑：**直接写 `<button>` 会带上浏览器的默认外观** —— `2px outset` 边框、`#efefef` 底色、`1px 6px` 内距。这不是 bug 而是「不用 preflight」的代价。

`components/ui/` 下的组件一直靠 `appearance-none` 自己规避。**新写原生 `<button>` 时照做**：

```html
<button type="button" class="cursor-pointer appearance-none border-0 bg-transparent p-0 text-inherit …">
```

（`disabled:` 也别忘了 —— UA 的 `cursor` 与不透明度同样不会自己消失。）

---

## 1 · 字体

```css
--font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue",
  "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
```

**系统字体栈，不加载任何外部字体。** 西文与数字走系统 UI 字体（macOS 上是 SF Pro），中文依次回落到苹方 / 微软雅黑 / Noto Sans CJK。

### 为什么换掉 Jost

| 判据 | Jost | 当前系统栈 |
| --- | --- | --- |
| x-height / cap-height | **0.657** | **0.721** |
| 14px 正文的小写字母实际高度 | **6.44 px** | **7.11 px** |

几何展示字体（Jost 源自 Futura）的小写字母比同字号的系统字体**矮 9.4%**。这个界面 90% 的字是 12–14px 的小写文本，这 9.4% 直接表现为「字小、发虚、扫读费劲」——这是 Jost 被换掉的唯一实质原因。

已排除的两条理由（实测，与常见说法相反）：

- **CDN 可达性不是问题**：本机实测 `fonts.googleapis.com` 返回 200，耗时 0.35s。换字体不是为了绕开被墙。
- **`tabular-nums` 在 Jost 下是生效的**：实测十个数字宽度全部为 23.203px（比例 1.000），未启用时比例为 1.333。数字对齐不是错觉。

换成系统栈的真实收益是**确定性**：零网络依赖、零 FOUT、零布局抖动、零字体许可审查，并且小写字形立刻变大 9.4%。

### 等宽数字

数字需要对齐的列（数量、时长、时间戳）**必须**加 `tabular-nums`。

- 当前系统栈实测支持：十个数字宽度完全相等（比例 1.000）。
- 字体栈换掉后要重新实测；换成任何新字体前，先确认它能通过这一项。

---

## 2 · 字号：六档

每档是一个 **字号 / 行高 / 字重** 三元组，用 `text-*` 工具类取用。

| 档位 | 字号 / 行高 / 字重 | 用途 |
| --- | --- | --- |
| `text-metric` | 28px / 1.2 / 600 | 指标数字。仪表盘等处的关键计数，**一屏内不超过 4 个** |
| `text-page-title` | 24px / 1.35 / 600 | 页面标题。每页**唯一一个** `<h1>` |
| `text-section-title` | 16px / 1.4 / 600 | 区块标题。面板、卡片组、抽屉标题、列表项主名称 |
| `text-body` | 14px / 1.6 / 400 | **正文默认档**。没想清楚用哪档时就用它 |
| `text-secondary` | 13px / 1.55 / 400 | 次级信息。说明文字、元数据、单元格里的辅助行 |
| `text-caption` | 12px / 1.5 / 400 | 最小档。表格表头、标签、键名、时间戳 |

### 新页面怎么选

按「这段文字在页面里排第几重要」从上往下走，**命中即停**：

1. 是这个页面的标题？→ `text-page-title`
2. 是一个数字指标，需要一眼读到？→ `text-metric`
3. 是一个面板 / 区块的标题？→ `text-section-title`
4. 是这条信息的**主体内容**（列表项名称、单元格主值、正文段落）？→ `text-body`
5. 是给主体内容做补充的（说明、时间、计数、单位）？→ `text-secondary`
6. 是表格表头 / 字段名 / 最小号的附注？→ `text-caption`

### 字重

只有 `metric` / `page-title` / `section-title` 三档自带 600。`body` / `secondary` / `caption` **不自带字重**，需要加重时叠加：

```
text-body font-medium      # 500 —— 需要稍微强调
text-body font-semibold    # 600 —— 条目标题、表格里的名称列
```

**注意方向不对称**：`font-medium` / `font-semibold` 能覆盖 `text-body` 的默认字重，但 `font-normal` 覆盖不了 `text-section-title` 的 600。要降权就得换档位，不是加 `font-normal`。

### 已删除的档位

`text-card-title`（→ `text-body font-semibold`）、`text-nav`（→ `text-body font-medium`）、`text-nav-sub`（零使用，直接用 `text-secondary`）。

---

## 3 · 间距与布局

**4px 单一刻度**，直接用 Tailwind 的数字刻度，任意整数即刻度值：

```
p-4 = 16px     gap-6 = 24px     max-h-55 = 220px     min-w-160 = 640px     basis-70 = 280px
```

本仓库的 Tailwind 4 支持任意整数的间距工具类，所以**没有任何理由写 `p-[17px]`** —— 需要 68px 就写 `p-17`。

两个语义别名，也在同一刻度上：

```css
--card-padding: 20px;   /* 卡片 / 面板内距 → p-[var(--card-padding)] */
--section-gap: 24px;    /* 页面内区块之间的纵向间距 → mb-[var(--section-gap)] */
```

> 这两处写成 `var()` 是有意的：它们是「一处改、全站卡片跟着变」的旋钮，不是一次性数值。其余间距直接用数字刻度。

### 布局常量（不产出工具类，由 AppShell / PageContainer 引用）

```text
--app-sidebar-width: 164px              侧栏展开宽度
--app-sidebar-width-collapsed: 64px     侧栏折叠宽度（只留图标）
--app-header-height: 52px               顶栏高度
--app-main-padding: 20px                主内容区内距
--app-content-width: 1200px             页面宽度档 1
--app-content-width-wide: 1440px        页面宽度档 2
```

### 页面宽度只有两档

每个页面的根节点**必须**是 `PageContainer`（不再有裸 `<section>`）。宽度按页面类型二选一：

| 档位 | 宽度 | 用于 | 当前页面 |
| --- | --- | --- | --- |
| `default` | 1200px | 正文 / 表单 / 详情型 | 仪表盘、项目详情、MCP 服务器详情、MCP 应用 |
| `wide` | 1440px | 表格 / 多列型列表页 | 项目、需求、工作流、Agent 运行、部署、专业 Agent、MCP 服务器 |

```html
<PageContainer>…</PageContainer>              <!-- default -->
<PageContainer width="wide">…</PageContainer>
```

**内距与页头间距不在 PageContainer 里**：内距由 AppShell 的 `<main>` 统一提供，页头区与内容区的间距由 `PageHeader` 自己的 `mb-[var(--section-gap)]` 提供。两处都已统一，不要重复叠加。

宽屏（视口 > 内容宽 + 侧栏 + 内距）下内容居中，不再一路拉到屏幕边缘。

---

## 4 · 圆角：三档

| 工具类 | 值 | 用途 |
| --- | --- | --- |
| `rounded-sm` | 6px | 小控件：复选框、下拉项、徽标 |
| `rounded-md` | 10px | 控件：按钮、输入框、Tab、列表项 |
| `rounded-lg` | 12px | 表面：卡片、面板、弹层、代码块 |
| `rounded-full` | — | 只有圆形元素：头像、状态圆点 |

已删除 `rounded-xl`（14px，零使用）。**不要写 `rounded-[4px]` 这类一次性的圆角值。**

---

## 5 · 边框：两档

| 工具类 | 亮色 | 暗色 | 用途 |
| --- | --- | --- | --- |
| `border-border` | `#dde7e5` | `#26332f` | 日常分隔：卡片、表格行、区块边界。**装饰性** |
| `border-input` | `#848d8b` | `#626d69` | 表单控件边界。**承载识别功能** |

### 为什么 `input` 比 `border` 重得多，而且必须这样

`--border` 与 `--input` 承担的是两件不同的事，W9 把它们分开定值：

- **`--border` 是装饰性的**：卡片与表格行靠「表面 + 留白」就能被认出来，那条线只是让人读得快一点。WCAG 1.4.11（非文本对比度）约束的是「**识别**组件所**必需**的视觉信息」，装饰性分隔线不在其内 —— 它维持 1.17–1.40:1 的极轻观感。
- **`--input` 承载识别功能**：输入框与它所在的面**同色**（亮色下都是 `--card`），于是那条边框是**唯一**能告诉人「这里可以输入」的东西。它此前是 `#c5d3d0`，在卡片上只有 **1.54:1**，远低于 1.4.11 要求的 3:1 —— 「输入框几乎看不见边界」是一个真实的缺陷。

W9 把它调到 **3.14–3.64:1**（对 `--card` 与 `--background` 两个实际承载面都达标），代价是表单控件比卡片分隔线明显。**这个不对称是有意的**：控件该被看见，分隔线不该抢眼。

> 已删除 `--border-strong`（W9）。它与旧 `--input` 同值、**零使用**，留着只会让人把它当表单边界用，从而把上面这个缺陷带回来。这与 W1–W3 删除零使用的 `rounded-xl` / `--shadow-subtle` 是同一条做法。

---

## 6 · 阴影：一档

```css
--shadow-overlay   /* 仅供 Dialog / Drawer / Dropdown 等浮层 */
```

**普通卡片一律用边框，不用阴影**（设计文档 §7）。已删除 `--shadow-subtle`（零使用）。

---

## 7 · 焦点环：一档

全站唯一一档，交互控件统一用（当前 9 处完整采用这一组）：

```
focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
```

- 环色 = `--ring`，实测对比度见 §9，最差场景 4.83:1，高于 WCAG 1.4.11 要求的 3:1。
- 手写 CSS 里的等价写法是 `outline: none; box-shadow: 0 0 0 2px var(--ring);`。
- **不要发明第二种焦点样式**，也不要为了视觉统一去掉它。

---

## 8 · 颜色

### 表面

| 令牌 | 用途 |
| --- | --- |
| `--background` | 页面底 |
| `--card` | 卡片 / 面板 / 弹层表面 |
| `--muted` | 次级表面：内嵌区块、行 hover、只读区 |

### 文本：三档

| 工具类 | 用途 |
| --- | --- |
| `text-foreground` | 正文与标题 |
| `text-muted-foreground` | 次级信息：说明、元数据、**占位符** |
| `text-foreground-disabled` | 禁用态。**不承载信息**，仅表示不可用 |

> 已删除 `text-foreground-muted`。它与 `text-muted-foreground` 在满足 AA 的前提下无法拉开可辨差异（可用的取值区间只有 4.5–5.2:1），留着只会制造「这个占位符该用哪一个」的歧义。

### 主色

`--primary` 是唯一强调色，同时表示「当前 / 选中」。

| 工具类 | 用途 |
| --- | --- |
| `bg-primary text-primary-foreground` | 主操作按钮（同页只保留一个） |
| `text-primary` | 正文链接（配 `hover:underline`） |
| `bg-primary-light` | 选中项底色（Tab 激活、列表项激活） |

### 语义色：五族，每族四档

`success` / `warning` / `danger` / `info` / `neutral`，命名规则固定：

| 档 | 工具类 | 用途 |
| --- | --- | --- |
| 墨色 | `text-success` / `border-success` / `bg-success` | 文字、图标、实心填充、需要强对比的边框 |
| 面 | `bg-success-bg` | 徽标与提示条的底色 |
| 轮廓 | `border-success-border` | 面的边框 |
| 面上的文字 | `text-success-foreground` | `-bg` 之上的文字 |

**怎么选**：徽标 / 提示条 → `bg-{名}-bg` + `border-{名}-border` + `text-{名}-foreground` 三件套；需要强对比的单点色（表单校验态边框、状态圆点）→ 用无后缀的墨色档。

**不要**用 `text-danger` 之类的语义色做装饰；语义色只表达状态。

---

## 9 · 对比度实测

以下数值由浏览器在真实页面上读取**解析后**的令牌值计算（WCAG 2.1 相对亮度公式），**不是设计时的估算**。W9 重新实测了一遍（含非文本图形），两套模式各 **28 组**。

阈值：正文 4.5:1；大字与非文本图形 3:1（SC 1.4.11）。

### 亮色

| 组合 | 实测 | 组合 | 实测 |
| --- | --- | --- | --- |
| foreground / background | 13.59 | primary / background | 5.14 |
| foreground / card | 14.67 | primary / card | 5.55 |
| muted-foreground / background | 5.20 | primary / primary-light | 4.78 |
| muted-foreground / card | 5.61 | primary-foreground / primary | 5.55 |
| muted-foreground / muted | 4.89 | foreground / primary-light | 12.65 |
| ring / background | 5.14 | ring / card | 5.55 |
| ring / muted | 4.83 | primary-foreground / danger | 5.63 |
| success / card | 5.36 | warning / card | 5.46 |
| danger / card | 5.63 | info / card | 5.22 |
| neutral / card | 5.61 | **input / card** | **3.41** |
| success-foreground / success-bg | 8.68 | warning-foreground / warning-bg | 7.99 |
| danger-foreground / danger-bg | 7.15 | info-foreground / info-bg | 7.01 |
| neutral-foreground / neutral-bg | 7.70 | | |

**25 组达标。** 另有 3 组按 WCAG 豁免，逐条理由见下。

### 暗色

| 组合 | 实测 | 组合 | 实测 |
| --- | --- | --- | --- |
| foreground / background | 15.26 | primary / background | 9.90 |
| foreground / card | 14.01 | primary / card | 9.09 |
| muted-foreground / background | 8.12 | primary / primary-light | 7.33 |
| muted-foreground / card | 7.45 | primary-foreground / primary | 8.95 |
| muted-foreground / muted | 6.88 | foreground / primary-light | 11.29 |
| ring / background | 9.90 | ring / card | 9.09 |
| ring / muted | 8.39 | primary-foreground / danger | 6.32 |
| success / card | 9.06 | warning / card | 8.59 |
| danger / card | 6.42 | info / card | 7.60 |
| neutral / card | 7.45 | **input / card** | **3.14** |
| success-foreground / success-bg | 10.28 | warning-foreground / warning-bg | 10.47 |
| danger-foreground / danger-bg | 10.37 | info-foreground / info-bg | 10.05 |
| neutral-foreground / neutral-bg | 10.87 | | |

**25 组达标**，同样 3 组豁免。

### 三组按 WCAG 豁免的组合（不是「没测」，是「测了并裁定豁免」）

| 组合 | 亮色 | 暗色 | 豁免理由 |
| --- | --- | --- | --- |
| `foreground-disabled` / `card` | 1.75 | 2.03 | SC 1.4.3 与 1.4.11 **明确豁免**「停用状态的用户界面组件」。`--foreground-disabled` 的存在意义就是「看起来不可用」，且按 §8 它**不承载信息** |
| `border` / `background` | 1.17 | 1.40 | 1.4.11 只约束「**识别**组件所**必需**的视觉信息」。卡片与表格行靠表面 + 留白即可识别，这条线是装饰性分隔，不是识别依据 |
| `border` / `card` | 1.26 | 1.28 | 同上 |

**`input` 不在这张豁免表里，这是一次真实的修正。** W9 前它在卡片上只有 1.54:1 —— 而输入框与所在面同色，那条边框是**唯一**的识别依据，属于 1.4.11 正面约束的范围。W9 把它调到 3.41 / 3.14，详见 §5。

### 本轮修正的历史缺陷（W3 与 W9 合计）

| 项 | 原值 | 问题 | 现值 |
| --- | --- | --- | --- |
| `--warning` | `#a86a0c` | 卡片上仅 **4.44:1**，低于 AA | `#975c06`（5.46:1，W3） |
| 占位符 / 侧栏分组标题 | `--foreground-muted` `#7d8e8b` | 卡片上仅 **3.43:1** | 并入 `--muted-foreground`（5.61:1，W3） |
| `--input` | `#c5d3d0` | 卡片上仅 **1.54:1**，低于非文本 3:1 | `#848d8b` / `#626d69`（3.41 / 3.14，W9） |

---

## 10 · 暗色模式

跟随系统偏好，无需开关：

```css
:root { color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; --…: …; } }
```

暗色**不是亮色的反相**：

- 表面抬升的明度关系反转 —— 亮色下 `card` 比 `background` 亮，暗色下 `card` 比 `background` **亮**（`#151f1d` vs `#0e1614`），靠「谁更靠近前景」而不是「谁更白」建立层级。
- 主色抬亮（`#15756a` → `#4fd3b6`），保证在深底上仍然醒目。
- 两套的对比度都必须达标，见 §9。

新加颜色时**两套都要给值并各自实测**，只改亮色会让暗色下出现不可读的文字。

---

## 11 · 断点

只用 Tailwind 具名断点，**不写 `min-[900px]` 这类任意断点**：

| 断点 | 宽度 | 本项目用法 |
| --- | --- | --- |
| `sm` | 640px | 自适应卡片栅格开始多列 |
| `md` | 768px | 暂未使用 |
| `lg` | 1024px | **主用**：单列 → 多列 / 两栏主从布局 / 详情字段横排 |
| `xl` | 1280px | 暂未使用 |

**为什么主用 `lg`**：侧栏 164px + 页面内距 40px 是固定开销，视口 1024px 时可用的内容宽度是 820px —— 正好够放「320px 主列 + 500px 从列」或「4 列指标卡」。设计文档 §15 列出的最低支持宽度也是 1024px。原先混用的 900px 是一个不对应任何真实设备档位的值。

---

## 12 · 禁止清单

- 写一次性数值：`p-[17px]`、`text-[72px]`、`min-[900px]`、`w-[240px]`、`rounded-[4px]`。需要就写刻度值（`p-17`、`min-w-160`），或先往 `app.css` 加档。
- 在组件里硬编码颜色（hex / `rgb()` / `bg-white`）。颜色只能来自令牌——目前生产代码里 **0 处**硬编码颜色，保持住。
- 用 `!important` 压样式。**当前生产代码 0 处**（最后 2 处是 `DashboardView` 给入场动画做的 `prefers-reduced-motion` 守卫，W6 删掉动画后一并消失）。
- 为单个页面造新的视觉语言（新的间距档、新的圆角、新的强调色）。
- 往 `@layer base` 里加组件或页面样式。

---

## 13 · 当前已知偏离

诚实记录，避免后续被当成「规范」照抄。

### 仍然存在的任意栅格（7 处，4 种布局模板）

W5 从 `views/` 内消除了 17 处（24 → 7），剩下的都**不是一次性尺寸而是布局模板**，Tailwind 无法用具名刻度表达：

| 模式 | 处数 | 位置 | 为什么保留 |
| --- | --- | --- | --- |
| `grid-cols-[minmax(0,1fr)_180px]` | 3 | Agents 运行记录 / 产出物、Requirements 规划事件 | 「内容 + 右对齐元信息」的行模板，条目类型各异，抽成组件会逼着三条不同的内容套同一个壳 |
| `grid-cols-[320px_minmax(0,1fr)]` | 1 | Deployments 主从布局 | 主从的唯一一处，抽具名类属于为单一用途造抽象 |
| `grid-cols-[80px_minmax(0,1fr)]` + `lg:grid-cols-[100px_minmax(0,1fr)_90px]` | 1 | Deployments 日志行 | 时间 / 级别 / 消息三列，窄屏折叠成两列 |
| `grid-cols-[repeat(auto-fit,minmax(220px,1fr))]` | 1 | Requirements 任务 DAG 卡片 | 自适应铺列，本质上不是固定模板 |

**已消除的 17 处**：14 处 `grid-cols-[110px_minmax(0,1fr)]` + 3 处 `grid-cols-[110px_1fr]`，全部收敛进 `DetailRow`（`.detail-row`）；`Projects` 的 2 栏与 `Deployments` 的表单栏随 Dialog 收敛一并消失。

### 非文本对比度（W9 已裁决，不再是待办）

原记录：「`--border` 在 `--background` 上为 1.17:1，`--input` 在 `--card` 上为 1.54:1，低于 WCAG 1.4.11 对非文本图形要求的 3:1。」

W9 的裁决把它拆成三件不同的事：

| 项 | 结论 |
| --- | --- |
| `--input`（表单控件边界） | **判为真实缺陷，已修** —— 控件与所在面同色，边框是唯一的识别依据。调到 3.41 / 3.14:1 |
| 其余所有文字组合 | 已达标（§9），无需改动 |
| `--border`（卡片 / 表格分隔线）与 `--foreground-disabled`（禁用态） | **判为 WCAG 豁免，维持原值** —— 理由与条款见 §9 |

「不使用过重边框」（设计文档 §13）这条设计语言因此**保留**：变重的只有表单控件的边界，卡片与表格行仍是极轻的分隔线。

### 手写 scoped CSS

**全仓只剩 1 个** scoped 块（W2 时是 11 个）：

| 位置 | 内容 | 性质 |
| --- | --- | --- |
| `DeploymentsView.vue` | 选中态的左侧强调条（`[data-active="true"]` 的 inset 阴影） | README §0 的例外条款（`[data-*]` 变体） |

W5/W6 删掉的 scoped 规则里，能变工具类的都变了工具类，真正复用的收敛进 `@layer components`（`.detail-row` / `.tone-dot`）。其中**发现两段死代码**：`WorkflowsView` 与 `MCPServerDetailView` 的 `.mcp-checkbox input` 系列 —— 复选框早已迁到 reka-ui 的 `Checkbox`（渲染 `<button>` 而非 `<input>`），那些 `input` 选择器匹配不到任何元素。

### 详情字段排版仍是两套

`MCPServerDetail` / `ProjectDetail` 用「caption 标签 + 正文值」的自适应栅格；`AgentRun` / `Agents` / `Requirements` 用 `DetailRow` 的「110px 标签 + 值」行。两者是**不同的信息密度**（前者是属性面板，后者是纵向列表），本轮按性质保留，未强行统一。若日后要统一，应先决定详情页到底用哪一种。

---

## 14 · 页面骨架

新页面照这一节搭，不要另起一套。W5 定稿，11 个页面按此逐页收敛。

### 列表页

```text
PageContainer width="wide"
├─ PageHeader          标题 + 一句话说明(description) + 唯一主操作(#actions 插槽)
├─ [工具行]            可选，见下
├─ 数据区              四种状态四选一，顺序固定
└─ 分页区              Table 内建（默认每页 10 条），列表页默认有
```

### 详情页

```text
PageContainer（默认宽度）
├─ PageHeader          标题 = 对象名 + #actions（返回 / 操作）
└─ 数据区              同样的四种状态；有数据时用 grid gap-[var(--section-gap)] 分区
```

宽度档位见 §3「页面宽度只有两档」。

### 四种状态

**必须按这个顺序判定**，顺序错了会出现「错误时还显示空状态」这类假象：

| 状态 | 渲染 | 组件 |
| --- | --- | --- |
| 加载中 | 骨架屏，形状与数据态一致 | `TableSkeleton`（列表）/ `LoadingSkeleton`（其它） |
| 错误 | 可重试错误态 + 重试按钮 | `ErrorState` |
| 空 | `EmptyState`，**必须给出下一步动作** | `EmptyState` + `#actions` |
| 有数据 | 正常渲染 | 页面自己的业务结构 |

三条硬规则：

1. **加载态不用文字。** 「正在加载项目…」这类纯文字一律换成骨架屏 —— 骨架屏让加载完成的瞬间不发生布局跳动。
2. **错误态必须可恢复。** 调 `ErrorState` 时把 `@retry` 接到页面既有的取数方法上（就是 `onMounted` 里调的那一个，store 内部会重置 `loading` / `error`）。
3. **空态必须给动作。** 只说「暂无项目。」而不告诉用户下一步做什么，等于把用户留在一个死胡同里。

### 工具行

位置固定在页头与数据区之间，**但只在页面真有控件时才渲染**。

计划里点名的 搜索 / 筛选 / 视图切换 / 批量操作 / 列设置 五项，改造前一个都不存在；**W5 之后也没有新增任何一个** —— 只是把**本来就有的**控件归到了这一行：

| 页面 | 工具行内容 |
| --- | --- |
| `WorkflowsView` | 项目筛选 + 状态筛选（两个 `Select`，改造前就在，只是没被当作「工具行」看） |
| `MCPAppView` | 项目 ID + Agent 名称的加载表单（它是唯一能驱动数据的控件） |
| 其余 9 个页面 | **无工具行** |

不要为了「骨架完整」造出点不动的控件 —— 那和顶栏放假的通知铃铛是同一类问题。

**工具行里的控件必须有无障碍名称（W11 起）。** `Select` 的触发器是 `<button role="combobox">`，
而 ARIA 规定 `combobox` 的名称**只能来自 author**（它不支持 name from content）—— 里头的「全部项目」
不会被当作名称。所以工具行里没有配可见 `<Label>` 的下拉**必须自带 `aria-label`**
（W11 给工作流页两个筛选补上了，此前一直是「无名控件」）。

同一个坑的另一面：**有可见文字的按钮不要再写一个不含该文字的 `aria-label`**。SC 2.5.3（Label in Name）
要求无障碍名称包含可见文字，否则 axe 报 `label-content-name-mismatch` —— 见 `AppHeader.vue`
搜索按钮上的注释（那里最后是**删掉** `aria-label`、让名称取自可见文字，再用 `sr-only sm:not-sr-only`
保证窄屏下名称不丢）。

将来真要做搜索 / 筛选时：控件放这一行，判断逻辑放 `viewmodels/`（纯函数、可单独测），不要堆在 `.vue` 里。

### 弹窗必须带描述（W12 起）

`Dialog` / `ConfirmDialog` 的 `description` **不是可选项**，它承担两件事：屏幕阅读器的
`aria-describedby` 目标，以及给视觉用户的一行上下文。`ConfirmDialog` 早就用类型强制了它；
W12 起 `Dialog` 也一律要传（5 个只传 `title` 的弹窗已补上）。

不传的后果不是报错 —— `Dialog.vue` 会把 `aria-describedby` 置为 `null`，属性被移除而非留下悬空引用；
真正的后果是**屏幕阅读器只念得出标题**。而且它不会以任何方式打扰你，只在 dev server 日志里留一条
`Warning: Missing \`Description\`…`（W10 正是在**关掉 dev server 时**才看到它的）。

> **护栏**：`uiComponents.test.ts` 会扫描全部 `views/`，每个 `<Dialog` 不带 `description` 即失败
> （并断言至少扫到 5 个，防正则失效导致空扫描永远通过）。
>
> **写什么**：只写这个表单**实际做的事**，不要编造行为承诺；也不要写成「确定要新建项目吗？」这类
> 把标题复述一遍的话。可参照 `DeploymentsView` 的「为项目登记一套部署环境；同一项目下同名环境会被覆盖。」
> —— 后半句是表单里看不出来的信息。

### 纵向节奏：一档

| 区间 | 间距 | 谁提供 |
| --- | --- | --- |
| 页头 ↔ 内容 | `--section-gap` (24px) | `PageHeader` 自带 `mb-[var(--section-gap)]` |
| 内容区内部 区块 ↔ 区块 | `--section-gap` | `grid gap-[var(--section-gap)]` |
| 工具行 ↔ 数据区 | `--section-gap` | 同上 |

**不要重复叠加**：页头间距已由 `PageHeader` 提供，调用方不要再包一层 `mb-*`。

### 分页区

**列表页默认分页。** `Table` 的 `page-size` 默认值就是 10（W7 起），**列表页什么都不用传**：

```html
<Table :columns="…" :rows="…" :row-key="…" min-width="min-w-200" />
```

需要「切筛选时回到第 1 页」的页面才绑页码：

```html
const listPage = ref(1);   // watch(filters, () => (listPage.value = 1))
<Table v-model:page="listPage" … />
```

这是 `Table` 内建的**客户端**分页（全量已在内存里切片），不新增请求、不改 api。

> 改造前只有 `Requirements` / `Workflows` / `AgentRun` / `Agents` 四个列表页分了页，`Projects` 等没回填 —— 那是历史遗留的不一致，不是有意的区别。W5 起以「列表页默认分页」为准，W7 把默认值收进组件，调用方不必再记着传参。

**但不加「每页条数」选择器** —— 那是一个新的交互控件，而当前固定用 10 条。等真有需求再加。

**三处不适用**（不要为了「统一」硬套）：

| 页面 | 为什么不分页 |
| --- | --- |
| `MCPServersView` | 列表项是**卡片**而非 `Card + Table`；且 MCP 服务器注册表由运维配置、数量有界（不像运行/工作流/部署那样持续累积），给它套分页器只会多出一个永远点不动的控件 |
| `DeploymentsView` | 它是**主从布局**（历史列表 320px + 详情 1fr），「历史」是详情的**主列表**而非独立列表页；主列表要始终可见，分页会打断主从关系 |
| `DashboardView` 的「最近工作流」 | 它是**摘要**，固定 5 条，不是列表页 —— 显式传 `:page-size="0"` 关掉分页 |

这是全站**唯一**需要显式传 `page-size` 的地方。

---

## 15 · 表格：对齐、排序与长文本

W7 定稿。规则在 `Table` 组件内部落地，**页面只声明，不要自己写对齐**。

### 列对齐：只有两个方向

| 列的内容 | `align` | 说明 |
| --- | --- | --- |
| 名称、描述、任务、来源… | 不写（默认 `left`） | 文本一律左对齐 |
| 数量、时间、时长 | `"right"` | 右对齐 + **自动带 `tabular-nums`**，所以调用方不必再叠加 |
| 状态徽标 | 不写（默认 `left`） | 全站统一左对齐，与文本列共用同一条左边缘 |
| 操作 | `"right"` | 右对齐 |

**整表居中已删除。** W7 之前 `Table.vue` 的每个单元格都是 `text-center`，这是「随便打开一个列表页，一列名称从头扫到尾」扫不动的原因：居中让每一行的左边缘都在飘。现在**默认左对齐**，右对齐只用于那些「一列数字要对齐小数点」的列。

**`align: "right"` 不要写在 `cellClass` 里** —— 会同时丢掉自动的等宽数字，并且让「哪些列右对齐」这件事散在插槽里看不出来。

「一列里既有文字又有数字」（如工作流列表的「进度 3 / 5 · 用时 2 分」）**按文本处理、左对齐**：它是一句话，不是一列数字；右对齐只会让两行参差。

### 表头排序：点一下就会用

声明 `sortable: true` 的列，表头变成可点按钮，**三态循环**：升序 → 降序 → 取消。未排序时显示一个半透明的上下箭头（提示「这里可以点」），排序后换成明确的 ↑ / ↓，并输出 `aria-sort`。

```ts
{ key: "createdAt", label: "创建时间", align: "right", sortable: true }
{ key: "progress", label: "进度", sortable: true, sortValue: (row) => row.taskProgress.completed }
```

- 取值默认 `row[key]`；嵌套字段或需要归一化时用 `sortValue` 覆盖。
- 数字列按**数值**排，其余按语言敏感字符串序（`numeric: true`，所以「第 2 版」在「第 10 版」之前；ISO 时间串按字典序即时间序）。
- **空值恒定排在末尾**，不随升降序翻转 —— 否则降序时一整列空白会顶到最上面。
- 比较器与三态机在 `components/ui/table/sort.ts`（纯函数，有单测）。

哪些列该开：能帮人**找一行**的列（名称、时间、状态、进度）。「描述」这种长文本列开了没人点，别开。

**状态列按枚举字符串排序**（`PENDING` < `RUNNING` < `SUCCESS` …），即按字母序把同状态的聚在一起，**不是**业务优先级。要按优先级排就得在 viewmodel 里定一个 rank 映射 —— 当前没做。

### 分页打开后，表头固定与虚拟滚动都不需要

W7 评估过这两项，结论是**都不做**：

| 能力 | 结论 | 理由 |
| --- | --- | --- |
| 固定表头（sticky） | 不做 | 每页固定 10 行 ⇒ 表格高度有上界（约 560px + 表头 + 页脚），低于常见视口。真要做 sticky，外层横向滚动容器必须同时给出**纵向**高度上限，也就是在页面里再套一个内部滚动区 —— 多一层滚动换来「表头已经在屏幕里」这一个几乎不发生的场景，不划算 |
| 虚拟滚动 | 不需要 | 渲染的行数由分页钉死在 10 行，DOM 规模与数据总量无关。**什么时候才需要**：如果将来出现「不分页且可能上万行」的表（例如日志流视图），或者把每页条数提到 100+。届时先考虑继续调分页，而不是引入虚拟滚动 |
| 行选择 + 批量操作 | 不做 | 全站**没有任何批量操作**可以施加于选中行。加一列勾选框而没有一个动作可用，就是 W4 拒绝的「顶栏放假的通知铃铛」 |
| 列显示 / 隐藏 | 不做 | 最宽的列表页只有 6 列（Agent 运行已从 7 列收敛到 5 列），没有任何一列需要默认藏起来。为 6 列配一套列设置菜单是纯增负担 |
| 每页条数选择器 | 不做 | 见 §14 |

### 长文本：先决定「换行还是截断」，截断必须给全文

| 策略 | 用在哪 | 写法 |
| --- | --- | --- |
| **换行** | 主标识（任务名、需求标题、项目名） | `break-words`。这是用户要找的东西，压成省略号等于把最重要的信息藏起来 |
| **截断** | 长度不可控的**次要**字段（仓库 URL、版本号、描述片段） | `truncate` + 一个能给出全文的 `title` |

**硬规则：只要是 `truncate`，就必须带 `title`（或等价的 tooltip）。** 截断本身没错，截断了却拿不到全文才是。

`ProjectsView` 的仓库列是范本：

```html
<span class="block max-w-35 truncate …" :title="repositoryLabel(row.repository)">
  {{ repositoryLabel(row.repository) }}
</span>
```

`max-w-35` = 140px，在 4px 刻度上（§3）——**不要**回到 `max-width: 140px` 的 scoped CSS。

### 页头不设 eyebrow

`PageHeader` 只有 `title` / `description` / `#actions` 三个入口。原先的 `eyebrow` prop 已在 W5 删除：它在 11 个页面零使用，且顶栏面包屑已经承担了「这是哪个分组」的上下文。

（`SectionHeader` 也有一个 `eyebrow` prop，那是另一个组件、有真实使用，保留。）
