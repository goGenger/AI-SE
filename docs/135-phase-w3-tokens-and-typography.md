# 135 · W3 重建设计令牌与排版（实施记录）

**阶段**：W3（对应审评文档 P3）
**日期**：2026-10-14
**前置**：[132-web-frontend-remediation-plan.md](132-web-frontend-remediation-plan.md)（计划）、[134-phase-w2-single-stylesheet.md](134-phase-w2-single-stylesheet.md)（W2）
**性质**：令牌体系与排版重建。**未触碰业务逻辑、文案、store / api / viewmodel、路由契约。**

---

## 一、目标与结果

**目标（来自审评 P3）**：建立一套「专业克制」的令牌体系，让全站视觉语言唯一且可推导。

| 指标 | 改造前 | 改造后 |
| --- | --- | --- |
| 字体 | Google Fonts 的 Jost（外部 CDN） | **系统字体栈**，零外部请求 |
| 字号档位 | 9 档（含 3 档语义重叠） | **6 档**，各有唯一用途 |
| 圆角档位 | 4 档（`xl` 零使用） | **3 档** |
| 阴影档位 | 2 档（`subtle` 零使用） | **1 档**（仅供浮层） |
| 语义色 | 5 族 × 2 档（bg + 墨色），无边框档 | **5 族 × 4 档**（墨 / bg / border / foreground） |
| 暗色模式 | 无 | **亮 + 暗两套，各自实测达标** |
| 断点 | 混用 `min-[900px]` / `min-[540px]` / 裸 `@media 900px` | **只用 Tailwind 具名断点**，主用 `lg` |
| 死令牌 | 8 个声明零使用 | **0 个** |
| CSS 产物 | 32.69 kB / gzip 6.71 kB（W2 末） | 34.78 kB / gzip 7.32 kB |
| 测试 | 320/320 | **320/320** |

CSS 产物上涨 2.09 kB，唯一原因是 §2.6 的 `@theme static`——它把全部令牌变量强制输出到 `:root`（详见该节）。相对本次改造起点的 46.27 kB 仍为 **−25%**。

---

## 二、逐项实施

### 2.1 字体：选系统字体栈，并修正审评的两条事实判断

审评给的两条理由我都实测了，**两条都不成立**：

| 审评主张 | 实测 | 判定 |
| --- | --- | --- |
| 「fonts.googleapis.com 经常不可达……等于这个字体很可能在你的环境里根本没生效」 | `curl` 返回 **HTTP 200，耗时 0.35s**；浏览器实测 `document.fonts` 中 Jost 400/500/700 状态均为 `loaded` | ❌ **不成立**（本机） |
| 「Jost 不保证提供 tnum……如果没生效，那些对齐全是错觉」 | 实测十个数字宽度**全部 23.203px**（比例 1.000）；未启用 `tabular-nums` 时为比例 1.333 | ❌ **不成立** |

**但审评的第三条理由是成立的，而且它才是决定性的**：

| 判据 | Jost | 系统栈 | 差 |
| --- | --- | --- | --- |
| x-height / cap-height | **0.657** | **0.721** | −8.9% |
| 14px 正文的小写字母实际高度 | **6.44 px** | **7.11 px** | **−9.4%** |
| cap-height（大写字高） | 70.0 | 70.46 | 持平 |
| 14px 数字宽度 | 8.40 px | 8.49 px | 持平 |

数据说明问题很精确：**Jost 不小，只是小写字母特别小**——这正是几何展示字体（Futura 一系）的特征。这个界面 90% 的字是 12–14px 的小写文本，9.4% 的差距直接表现为「字小、发虚、扫读费劲」。

**决定：方案 (a) 系统字体栈。**

```css
--font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue",
  "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
```

选 (a) 而不是 (b)「自托管字体」的理由：

1. **确定性**。这是一份部署在中文环境的内网控制台，本地回退又是系统字体——中间多一跳外部 CDN，收益（一个更好看的西文字形）抵不上风险（FOUT、布局抖动、离线不可用、字体许可审查）。
2. **小写字形问题只有换字体族才能解**。自托管 Jost 解决不了 0.657 的 x-height；自托管 Inter 能解，但要引入约 100 KB 二进制资产与许可文件，而设计文档 §4 本来就写着「默认使用系统无衬线字体」。
3. **中文占界面多数**，而中文从来不走 Jost（Jost 无 CJK 字形，一直回落苹方）。换字体实际只影响西文与数字，视觉身份损失很小。

顺带排除一个陷阱：审评建议「西文优先 Inter 或系统 UI 字体」，但实测本机**未安装 Inter**——写成 `font-family: Inter, …` 会静默回落到下一个。故栈里不放 Inter。

`index.html` 中的 3 个 `<link>`（2 个 preconnect + 1 个 stylesheet）已删除。实测确认：`document.fonts` 已为空集，`font-family: Jost` 的渲染宽度与一个绝不存在的字体完全一致（435.13px），即已彻底回退。

### 2.2 字号：9 档 → 6 档

合并规则是「同字号同字重的重复档合并，字重改为显式叠加」：

| 原档位 | 处置 |
| --- | --- |
| `text-page-title` 24px/600 | 保留 |
| `text-section-title` 16px/600 | 保留 |
| `text-metric` 28px/600 | 保留 |
| `text-body` 14px/400 | 保留，成为正文默认档 |
| `text-secondary` 13px/400 | 保留 |
| `text-caption` 12px/400 | 保留 |
| `text-card-title` 14px/600 | **删除** → `text-body font-semibold`（1 处模板 + 2 处手写 CSS） |
| `text-nav` 14px/500 | **删除** → `text-body font-medium`（2 处） |
| `text-nav-sub` 13px/400 | **删除**——**自始至终零使用**，是纯死令牌 |

**保留了三档的字重声明（600），移除了正文三档的**。原因：`--text-body--font-weight: 400` 会覆盖 `<strong>` 父级的字重，是错的；而且实测确认字重叠加的方向不对称——`font-medium` / `font-semibold` 能覆盖，`font-normal` **不能**把 600 降回 400。这条不对称写进了 README，因为它会实实在在咬人。

### 2.3 圆角 / 阴影 / 语义色

- **圆角 4 档 → 3 档**：删除 `--radius-xl`（14px，零使用）与未被映射的裸 `--radius: 10px`。同时清掉两处一次性圆角值：`rounded-[4px]`（复选框）→ `rounded-sm`；`rounded-[calc(var(--radius-md)-2px)]`（下拉项）→ `rounded-sm`。
- **阴影 2 档 → 1 档**：删除 `--shadow-subtle`（零使用）。设计文档 §7 规定「普通 Card 优先使用 border 而不是明显阴影」，`subtle` 档本就无合法消费者。保留 `--shadow-overlay`（4 处：Dialog / Drawer / Dropdown / Select）。
- **语义色补齐四档**：`success` / `warning` / `danger` / `info` / `neutral` 各补 `-border` 与 `-foreground`。原有 `border-*` 语义工具类为零使用，属新增能力而非迁移。

### 2.4 断点：900px → `lg`（1024px）

`min-[900px]` 共 17 处（7 个视图）、`min-[540px]` 1 处，另有三处手写 `@media (min-width: 900px)` 与三处代码注释提到 900。

选 `lg`（1024）而不是距离更近的 `md`（768），理由是算过的：侧栏 164px + 页面内距 40px 是固定开销。

- 视图 1024 → 内容宽 **820px**：够放「320px 主列 + 500px 从列」或「4 列指标卡」（每列 205px）。
- 视图 768 → 内容宽 **564px**：两栏主从的从列只剩 244px，4 列指标卡每列 141px，都不可用。

**这是一处有意的行为变化**：视口在 900–1024px 之间时，原本并排的布局现在是单列。设计文档 §15 列出的最低支持宽度就是 1024px，所以这是「收紧到规范」，不是回退。已在报告中标注。

### 2.5 清剿任意值

| 类别 | 处数 | 处置 |
| --- | --- | --- |
| 断点 `min-[900px]:` / `min-[540px]:` | 18 | → `lg:` / `sm:` |
| 字号 `text-[72px]` | 3 | → `text-metric`（并去掉与之冲突的 `leading-none` / `font-medium`，回到令牌三元组） |
| 高度 `max-h-[220px]` / `max-h-[180px]` | 5 | → `max-h-55` / `max-h-45`（**像素值完全相同**） |
| 宽度 `w-[240px]` / `w-[200px]` | 3 | → `w-60` / `w-50`（完全相同） |
| 表格最小宽 `min-w-[1100px]` 等 | 7 | → `min-w-275` / `-220` / `-180` / `-160` / `-140`（完全相同） |
| 弹性基准 `basis-[280px]` 等 | 6 | → `basis-70` / `-60` / `-55`（完全相同） |
| 圆角 `rounded-[4px]` / `rounded-[calc(…)]` | 2 | → `rounded-sm` |
| 字号令牌 `text-card-title` | 1 | → `text-body font-semibold` |

关于刻度值：Tailwind 4 的动态间距刻度接受**任意整数**——`max-h-55` = `calc(0.25rem × 55)` = 220px。所以「需要一个 220px 的框」的正确写法是 `max-h-55`，不是 `max-h-[220px]`。这一点已写进 README，并**在构建产物里逐个核对过**（见 §3.3）。

W10 门槛的三类（`text-[..]` / `min-[..px]` / `w-[..px]`）现已归零。

### 2.6 两个构建层面的发现

**发现 1 · Tailwind 会摇掉未被引用的主题变量。**

首次改造后实测 `--text-metric` 与 `--radius-sm` 在 `:root` 里**不存在**，而 `--text-body` / `--radius-lg` 存在。原因：`@theme inline` 让工具类内联取值（`.text-body{font-size:14px}`），于是「没有任何工具类通过 `var()` 引用」的变量被摇掉；`--text-body` 之所以幸存，是因为手写 scoped CSS 里有一句 `var(--text-body)`，被扫描器看到。

这是个静默陷阱：本仓库大量用 `var(--token)` 手写样式，一旦有人在新页面里写 `var(--text-metric)`，该声明会**无声消失**（不是报错，是整条属性不见）。

处置：`@theme inline` → **`@theme static inline`**。`static` 强制输出全部令牌变量。代价 +2.09 kB（gzip +0.61 kB），换来「`:root` 始终是令牌的完整清单」。核对结果：18 个抽查令牌全部输出，7 个已删除令牌全部不再出现，工具类仍为内联值。

**发现 2 · 新增的 `styles/README.md` 被 Tailwind 当源码扫描了。**

`@source "../"` 覆盖整个 `src/`，README 里的示例类名（`p-17` 等）会被当成真实用法生成 CSS——文档写一句就凭空多一条规则。已加 `@source not "../styles/README.md"` 排除，产物回落 0.77 kB。

### 2.7 交付文档

- **`apps/web/src/styles/README.md`**（用户检查后续改动的依据）：层序与 scoped CSS 的关系、字体选型与依据、六档字号 + 「新页面怎么选」决策树、字重的不对称、间距刻度、圆角 / 边框 / 阴影 / 焦点环、颜色四类、**亮暗两套逐项对比度实测表**、断点、禁止清单、已知偏离。
- **`docs/design/00-design-system.md`**（按 §2 冲突 1 的裁决回写）：§3 颜色表、§4 字体与字号表、§5 间距、§6 圆角、§7 阴影、§15 断点、§16 示例全部改到与实现一致；v1.0 的紫色系取值集中标注 **「已废弃」**并保留为历史版本，不留模糊中间态。文档头补了一句定位：**本文描述意图，取值以 `app.css` 与 `styles/README.md` 为准，冲突时以代码为准**。

---

## 三、验证

### 3.1 门槛命令

```
typecheck ✓   lint ✓   test 320/320 ✓   build ✓
```

### 3.2 对比度实测（浏览器解析后的令牌值，非设计稿估算）

在真实页面上读取 `getComputedStyle(document.documentElement)` 的令牌值，用 WCAG 2.1 相对亮度公式计算。**逐项数值表见 `apps/web/src/styles/README.md` §9。**

| 模式 | 校验组合 | 结果 |
| --- | --- | --- |
| 亮色 | 24 组（正文 4.5:1 阈值 17 组，非文本 3:1 阈值 3 组，其他 4 组） | **24/24 通过** |
| 暗色 | 同上 24 组 | **24/24 通过** |

**顺带修掉了两个既有的 AA 缺陷**（均非本次引入，是 W1 未覆盖的存量问题）：

1. `--warning` 原值 `#a86a0c` 在卡片上仅 **4.44:1**，低于 4.5 —— 改为 `#975c06`（5.46）。
2. 占位符与侧栏分组标题用的 `--foreground-muted`（`#7d8e8b`）在卡片上仅 **3.43:1** —— 该命名与 `--muted-foreground`（5.61）在满足 AA 的前提下无法拉开可辨差异（可用区间只有 4.5–5.2:1），留着只会制造「占位符该用哪一个」的歧义。**已合并到 `--muted-foreground`**，删除该令牌。

### 3.3 构建产物核对

| 检查 | 结果 |
| --- | --- |
| 动态刻度类是否真的生成 | `max-h-55` / `-45`、`w-60` / `-50`、`min-w-275` / `-220` / `-180` / `-160` / `-140`、`basis-70` / `-60` / `-55` 全部生成；对照用的未使用类 `basis-44` 未生成 —— 证明检查本身有效 |
| 令牌变量是否全部输出 | 18 个抽查令牌全部在产物中 |
| 已删令牌是否残留 | 7 个（`--text-card-title`、`--text-nav`、`--text-nav-sub`、`--foreground-muted`、`--primary-soft`、`--radius-xl`、`--shadow-subtle`）全部为 0 |
| 工具类是否仍内联取值 | `.text-body{font-size:14px}`、`.rounded-sm{border-radius:6px}` —— `static` 未破坏 `inline` |

### 3.4 浏览器实测

| 检查 | 实测 | 判定 |
| --- | --- | --- |
| `index.html` 中 Google Fonts `<link>` | 0 个 | ✓ |
| `document.fonts` 条目 | 空集 | ✓ Jost 已彻底移除 |
| `font-family: Jost` 渲染宽度 vs 不存在字体 | 435.13px vs 435.13px | ✓ 已回退 |
| `html` 计算 `font-family` | 系统栈完整命中 | ✓ |
| `html` 计算背景 / 文字（亮色） | `rgb(243,247,246)` / `rgb(29,43,42)` | ✓ |
| 级联层顺序 | `theme, base, components, utilities` | ✓ |
| `color-scheme`（亮 / 暗） | `light` / `dark`，`html` 背景随之切换 | ✓ |
| 工具类 → 计算色抽查 | `text-primary` = `rgb(21,117,106)`；`bg-primary text-primary-foreground` = `rgb(21,117,106)` / `rgb(255,255,255)`；`bg-success-bg` = `rgb(227,245,239)` | ✓ |
| 真实页面截图（亮 + 暗） | 侧栏、顶栏、卡片、表单、按钮、错误态渲染正常；暗色下表面层级与对比度成立 | ✓ |

**一条更正**：`document.fonts.check("14px Jost")` 返回 `true` 并不可靠——在字体已完全移除的情况下它仍返回 `true`。判断字体是否生效必须用「渲染宽度与不存在字体对比」，不能用这个 API。这条记在报告里，避免后续误判。

### 3.5 未使用的验证手段（诚实说明）

- **`prefers-reduced-motion` 未实测**：浏览器工具不支持模拟该媒体特性；W3 未触碰相关代码（那 2 处 `!important` 原样保留在 `DashboardView`）。
- **900–1024px 区间的布局变化未逐页目视**：断点从 900 移到 1024 的后果是「该区间内单列」，这是算术结论（§2.4），未逐页截图确认观感。视觉确认放在 W5 统一页面骨架时。
- **`format:check`**：与 W2 相同，全仓不通过是基线既有状态，不在门禁内（`AGENTS.md` §7 规定的是 `typecheck && lint && test`）。

---

## 四、偏离、保留与新发现

### 偏离 1 · 26 处 `grid-cols-[…]` 保留为任意值

典型是 `grid-cols-[110px_minmax(0,1fr)]`（14 处，同一套「字段名 / 值」栅格）与 `grid-cols-[320px_minmax(0,1fr)]`（两栏主从）。

它们**不是一次性尺寸，是布局模板**——Tailwind 没有对应的具名刻度，抽取为语义工具类需要引入 `@utility` 这一新概念。而这些栅格正是 W5「统一页面骨架」要重构的对象，现在抽出来会在下一阶段被推翻。**故本轮不动，计入 W5。**

W10 的门槛 grep（`text-[..]` / `min-[..px]` / `w-[..px]`）不含此类，不受影响。

### 偏离 2 · 非文本对比度未强行达标

`--border` 在 `--background` 上为 **1.17:1**，`--input` 在 `--card` 上为 **1.54:1**，低于 WCAG 1.4.11 对非文本图形要求的 3:1。

**未修改。** 把输入框边框提到 3:1 需要接近 `#8fa39f` 的深灰，会与设计文档 §13「不使用过重边框」和「专业克制」的既定方向正面冲突，且是全站观感级的改动。这是设计语言取舍，不是遗漏——已在 README §13 与本文登记为**已知偏离**，留给 W9 可访问性阶段连同其它非文本项一起裁决。

### 保留 1 · `!important` 仍是 2 处

与 W2 相同，均在 `DashboardView` 的 `@media (prefers-reduced-motion: reduce)` 内，属无障碍降级守卫，W6 重写仪表盘时一并消失。**W3 未新增任何 `!important`**（产物核对：5 处命中中 2 处是实际代码，2 处是注释里「未使用 !important」的说明，1 处是 README 的禁止清单）。

### 新发现 1 · scoped CSS 是未分层的，优先于全部四层

Vue SFC 的 `<style scoped>` 编译后**不属于任何 `@layer`**。按 CSS 级联规则，未分层声明优先于所有分层声明——也就是说：

> **页面里任何一条 scoped 规则，都恒压工具类。**

这正是 W2 拆掉 `styles.css` 时消灭的那个机制，只是它还残留在 11 个 `.vue` 文件的 `<style>` 块里（W2 只删了其中的对抗补丁，块本身还在）。

**本轮未动它**，原因与偏离 1 相同：这些块的正确归宿是 W5 的骨架统一（要么改写成工具类，要么用 `@layer components { }` 包起来）。现在动会在下一阶段被推翻。

但它值得单独记一笔，因为它是「改了样式不生效」的**残余成因**，而 W2 的报告曾声称该机制已清除。README §0 已就此写下规则：**不要把组件/页面的视觉写进 scoped CSS。**

### 新发现 2 · 流程文档的错位（需用户裁决）

`AGENTS.md` §9 要求「每完成一个阶段：勾选 `docs/17-acceptance-checklist.md`、更新 `docs/15-development-roadmap.md` 与 `docs/18-phase-engineering-goals.md` 的进度」。

核查结果：这三个文档追踪的是**产品 Phase 1–8 / V1 / Post-V1 增强**这条线，最后状态停在 Phase 6 与 5.7。本次的前端改造（W1–W10）是**另一条线**，有自己的编号文档流（132 计划 + 133/134/135 阶段报告），与 docs/118–122 那批前端改造记录同类。

W1、W2 都**没有**更新这三个文档。我本轮**同样没有改**，理由有二：(1) 未经确认就去改三个冻结的产品路线文档，风险大于收益；(2) `docs/15` 的「Post-V1 Enhancements」表本身已有「更早的增强未在本文件登记，以其编号文档为准」的豁免先例。

**需要你裁决**：是保持现状（W 线只用自己的编号文档），还是把 W1–W10 登记进 `docs/15` 的 Post-V1 增强表？在你答复前我不动这三个文件。

---

## 五、阶段报告

### Modified Files

**新增**
- `apps/web/src/styles/README.md`
- `docs/135-phase-w3-tokens-and-typography.md`（本文件）

**生产代码**
- `apps/web/src/styles/app.css` — 令牌全量重写；新增暗色块与 `@layer base` 说明；`@theme inline` → `@theme static inline`；新增 `@source not` 排除 README
- `apps/web/index.html` — 删除 3 个 Google Fonts `<link>`
- `apps/web/src/components/layout/AppSidebar.vue` — `text-nav` → `text-body font-medium`（2 处）；`text-foreground-muted` → `text-muted-foreground`
- `apps/web/src/components/ui/input/Input.vue` — 占位符色令牌
- `apps/web/src/components/ui/textarea/Textarea.vue` — 同上
- `apps/web/src/components/ui/checkbox/Checkbox.vue` — `rounded-[4px]` → `rounded-sm`
- `apps/web/src/components/ui/select/Select.vue` — 下拉项圆角 → `rounded-sm`；`min-w-[8rem]` → `min-w-32`
- `apps/web/src/components/ui/table/Table.vue` — 默认 `minWidth` → `min-w-160`
- `apps/web/src/views/DashboardView.vue` — 3 处指标的 72px 硬编码 → `text-metric`；断点；`min-w-[560px]` → `min-w-140`；手写 CSS 断点
- `apps/web/src/views/RequirementsView.vue` — 断点 ×4；`text-card-title` → `text-body font-semibold`；`max-h` ×3；`w-60`
- `apps/web/src/views/AgentsView.vue` — 断点 ×3；`min-w-[720px]` → `min-w-180`
- `apps/web/src/views/DeploymentsView.vue` — 断点 ×3；注释更新
- `apps/web/src/views/WorkflowsView.vue` — 断点 ×2；`w-[240px]`/`w-[200px]`；`min-w-[880px]`
- `apps/web/src/views/ProjectsView.vue` — 断点；`min-w-[640px]`；注释更新
- `apps/web/src/views/AgentRunView.vue` — 断点；`min-w-[1100px]`；`max-h` ×2
- `apps/web/src/views/ProjectDetailView.vue` — `basis-[240px]` → `basis-60`
- `apps/web/src/views/MCPServersView.vue` — `basis-[280px]` → `basis-70`
- `apps/web/src/views/MCPServerDetailView.vue` — `text-card-title` 令牌 → `text-body` + 600（手写 CSS）；`basis` ×3；手写 CSS 断点
- `apps/web/src/views/MCPAppView.vue` — 同上；等宽字体栈 → `var(--font-mono)`；`basis-[280px]`

**测试**（12 处断言，见 Tests 节）
- `apps/web/src/__tests__/requirementsView.test.ts`
- `apps/web/src/__tests__/deploymentsView.test.ts`
- `apps/web/src/__tests__/projectsView.test.ts`
- `apps/web/src/__tests__/agentRunView.test.ts`
- `apps/web/src/__tests__/uiComponents.test.ts`

**文档**
- `docs/design/00-design-system.md` — §3 / §4 / §5 / §6 / §7 / §15 / §16 回写到与实现一致，v1.0 取值标注「已废弃」

### Implementation

见 §二。

### Architecture Changes

**令牌从「能跑的一组值」变成「有唯一来源、可推导、可被任意位置引用的系统」。**

三处结构变化：

1. **字体成为确定性依赖。** 从「外部 CDN + 本地回退」变成纯系统栈。不再有 FOUT、布局抖动、离线不可用这三种失败模式。
2. **令牌变量成为完整清单。** `@theme static` 保证 `:root` 永远持有全部令牌，手写 CSS 与工具类消费同一批变量。此前 Tailwind 的摇树让「变量是否存在」取决于「有没有别处引用过」——一个无法从代码推断的条件。
3. **双模式成为一等公民。** `color-scheme` + `prefers-color-scheme` 两套令牌，且两套都经过逐项对比度实测，而不是「先定义暗色以后再验」。

**未解决的结构问题（交给 W5）**：11 个 `.vue` 文件的 `<style scoped>` 是未分层的，恒压全部四层。这是「改了样式不生效」的残余成因，详见 §四 新发现 1。

### Dependencies

无新增 npm 依赖。**删除**了对 `fonts.googleapis.com` / `fonts.gstatic.com` 的运行时依赖。

### Tests

```
Test Files  31 passed (31)
     Tests  320 passed (320)
```

**断开言总数 1461 处，改动前后一致**——只改断言里的类名字符串，没有增删任何断言。逐条：

| 文件 | 改动 | 处数 |
| --- | --- | --- |
| `requirementsView.test.ts` | `min-[900px]:` → `lg:` | 3 |
| | `max-h-[220px]` → `max-h-55` | 2 |
| | `max-h-[180px]` → `max-h-45` | 1 |
| `deploymentsView.test.ts` | `min-[900px]:` → `lg:` | 2 |
| | `max-h-[220px]` → `max-h-55` | 1 |
| `projectsView.test.ts` | `min-[900px]:` → `lg:`；测试标题 `<900px` → `lg 以下` | 2 |
| `agentRunView.test.ts` | `max-h-[220px]` → `max-h-55` | 1 |
| `uiComponents.test.ts` | `placeholder:text-foreground-muted` → `placeholder:text-muted-foreground` | 1 |
| | `min-w-[640px]` → `min-w-160` | 1 |

### Lint

`eslint "src/**/*.{ts,vue}"` 通过，无输出。

### Typecheck

`pnpm --filter @ai-se/shared build && vue-tsc --noEmit` 通过，无输出。

### E2E

未运行后端 API 级 e2e（针对 `apps/server`，与前端令牌改动无关）。前端以浏览器实测替代，见 §3.4。**本轮未启动后端**——W2 那次启动后端意外恢复了一个运行中的工作流，本轮改用页面内注入 `fetch` mock 提供数据，不需要后端。

### Known Issues

1. **26 处 `grid-cols-[…]` 仍是任意值**（§四 偏离 1），留给 W5。
2. **非文本对比度未达标**：`--border` 1.17:1、`--input` 1.54:1（§四 偏离 2），留给 W9 裁决。
3. **11 个文件的 scoped CSS 未分层**，恒压工具类（§四 新发现 1），留给 W5。
4. **900–1024px 区间的布局变化未逐页目视**（§3.5）。
5. **`!important` 仍剩 2 处**（`DashboardView` 的无障碍守卫），W6 消除。
6. **8 处手写 CSS 的非 4px 刻度值**（`padding: 14px 16px` 等），随 W5 重写 `mcp-*` 块归位。
7. **`prefers-reduced-motion` 未实测**（工具不支持模拟）。
8. **`docs/15` / `17` / `18` 未更新**（§四 新发现 2），等用户裁决。
9. **`format:check` 全仓不通过**，基线既有状态，不在门禁内。

### Acceptance Result

**通过。** 审评 P3 的 5 项交付（字体、令牌刻度、语义色 + 对比度、亮暗两套、断点 + 任意值）与计划的 7 项工作项全部完成，四项门槛命令全绿：

```
typecheck ✓   lint ✓   test 320/320 ✓   build ✓
```

对照审评的验收要求：

| 要求 | 结果 |
| --- | --- |
| 字体二选一并说明理由 | ✓ 系统字体栈，理由与实测数据见 §2.1 |
| 数字必须真等宽 | ✓ 实测比例 1.000（且修正了审评对 Jost 的误判） |
| 间距 4px 单一刻度 | ✓ 任意值已清剿，刻度值可用任意整数 |
| 字号 6–7 档 + 用途 | ✓ 6 档 + README 决策树 |
| 圆角 3–4 档 / 边框两档 / 阴影极轻 / 焦点环一档 | ✓ 3 / 2 / 1 / 1 |
| 语义色 5 族 × bg/border/foreground + 实测对比度 | ✓ 4 档/族，亮暗各 24 组全通过 |
| 亮 + 暗两套 + `color-scheme` | ✓ 已落地并实测 |
| 断点统一成具名档 | ✓ 只用 sm/md/lg/xl，主用 lg |
| 清剿任意值 | ✓ W10 三类归零；`grid-cols-[…]` 按 §四偏离 1 保留并说明 |
| 交付 `styles/README.md` | ✓ |
| 更新 `docs/design/00-design-system.md` §3/§4 | ✓ 并扩到 §5/§6/§7/§15/§16，废弃项明确标注 |

### Next Phase Boundary（W4 · AppShell 与信息架构）

**STOP。本阶段到此为止，不自动进入 W4。**

W4 的范围（据计划 §W4）：

1. 侧栏：把已 import 的 8 个图标真正渲染出来；选中态改为背景 + 文字色 + 图标色同时变；分组计数取 store 真实数据；折叠与持久化。
2. 顶栏：面包屑、全局搜索入口（Cmd+K）、通知入口、用户菜单占位。无数据就留结构占位，**禁止放假数据**。
3. 新建 `PageContainer` 组件：最大内容宽度**只两档**（写进 README）、统一内距、统一标题区与内容区间距；11 个页面全部套用，不允许再有裸 `<section>` 根节点。
4. 约束：侧栏保持 `sticky + h-screen`；若改实现方式须同步更新 `appShell.test.ts`。

**W4 开工前需要你确认的两件事**（都在本报告中登记）：

- §四 偏离 2：非文本对比度（`--border` / `--input` 低于 3:1）是在 W4 的 PageContainer 阶段处理，还是留到 W9？
- §四 新发现 2：是否把 W1–W10 登记进 `docs/15-development-roadmap.md` 的 Post-V1 增强表？

**未开始事项（STOP）**：W4–W10 全部未开始。`PageHeader` 的 `eyebrow` prop 去留推迟到 W5。`.taste-skill/` 目录推迟到 W10 清理。26 处 `grid-cols-[…]`、11 个 scoped CSS 块、8 处非刻度间距值均推迟到 W5。
