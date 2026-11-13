# AI-SE Design System

> Version: 1.1（2026-10-14 按实现回写 §3 / §4 / §6 / §7）\
> Scope: AI-SE 前端 UI 重构\
> Stack: Vue 3 + TypeScript + Tailwind CSS 4 + shadcn-vue / Reka UI

> **本文与实现的关系**：本文描述**意图与取舍**，具体的令牌取值与用法以
> `apps/web/src/styles/app.css` 与 `apps/web/src/styles/README.md` 为准。
> 两者冲突时，**代码是权威方**（`AGENTS.md` §9），并须报告冲突而不是默默对齐。

## 1. Purpose

本设计系统用于统一 AI-SE（AI Software
Engineer）所有前端页面的视觉语言和基础组件行为。

AI-SE 当前前后端业务已经开发完成，本阶段属于**前端 UI/UX
重构**。首要目标是建立稳定、可复用、适合长期工程使用的企业级 AI SaaS
视觉体系。

### Design Keywords

-   Modern
-   Professional
-   Lightweight
-   Enterprise SaaS
-   AI-native
-   Engineering-oriented
-   Clear information hierarchy

### Avoid

-   过度渐变
-   大面积高饱和紫色
-   Glassmorphism
-   营销落地页式布局
-   过度装饰
-   为单个页面创造独立视觉语言

## 2. Technology Principles

-   Vue 3
-   TypeScript
-   Tailwind CSS 4
-   shadcn-vue
-   Reka UI
-   Lucide Icons

组件层级：

``` text
shadcn-vue / Reka UI
        ↓
AI-SE UI Components
        ↓
AI-SE Common Components
        ↓
Business Components
        ↓
Page Components
```

shadcn-vue 是基础实现来源，不等于 AI-SE 最终设计系统。

## 3. Design Tokens

### Color

通过 Tailwind CSS 主题变量统一管理颜色。业务页面不得硬编码颜色——当前生产代码中
**0 处**硬编码 hex / `rgb()`，保持住。

**当前实现（纸白石墨 + 信号绿，2026-10）**：

``` text
Page Background: #f3f7f6      青绿灰底
Card Background: #ffffff
Muted Surface:   #e9f1ef      内嵌区块 / 行 hover / 只读区

Text Primary:    #1d2b2a      正文
Text Secondary:  #5a6b69      次级信息（含占位符）
Text Disabled:   #b9c7c4      仅禁用态，不承载信息

Border Default:  #dde7e5
Border Strong:   #c5d3d0
Input Border:    #c5d3d0
Focus Ring:      #15756a

Primary:         #15756a      青绿，唯一强调色，兼表「当前 / 选中」
Primary Hover:   #0f5f56
Primary Light:   #e0f2ee      选中项底色
Primary Soft:    已废弃（零使用，已删除）
```

语义色 `success / warning / danger / info / neutral` **每族四档**：墨色（无后缀）、
`-bg`（面）、`-border`（轮廓）、`-foreground`（面上的文字）。徽标 / 提示条用后三档，
需要强对比的单点色（校验态边框、状态圆点）用墨色档。取值与逐项实测对比度见
`apps/web/src/styles/README.md` §9。

**暗色**：跟随系统偏好（`prefers-color-scheme`），`color-scheme` 在 `:root` 声明。
暗色不是亮色的反相——表面抬升靠明度层级，主色抬亮以保证深底上的对比度。
亮暗两套的对比度**都必须**达标。

### 已废弃（保留为历史版本）

以下为 v1.0 的原始取值，**全部不再使用**，任何新代码不得引用：

``` text
Primary:        #6C5CE7     ← 紫色系，从未在实现中落地
Primary Hover:  #5B4BD6
Primary Light:  #F0EDFF
Primary Soft:   #F7F5FF
Page Background: #F6F7FB
Muted Background: #F8F9FC
Text Primary:   #1F2937
Text Secondary: #6B7280
Text Muted:     #9CA3AF
Text Disabled:  #D1D5DB
Border Default: #E8EAF0
Border Strong:  #DDE0E8
```

## 4. Typography

**默认使用系统无衬线字体**——这一条 v1.0 就写对了，实现曾一度偏离（从 Google Fonts
加载 Jost），现已回归本条的意图。

``` css
--font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue",
  "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
```

不加载任何外部字体：零网络依赖、零 FOUT、零布局抖动。西文与数字走系统 UI 字体，
中文依次回落到苹方 / 微软雅黑 / Noto Sans CJK。

> **为什么不用几何展示字体**：实测 Jost 的 x-height / cap-height 为 0.657，系统栈为
> 0.721——14px 正文的小写字母实际高度 6.44px vs 7.11px，矮 9.4%。本界面 90% 的字是
> 12–14px 小写文本，这 9.4% 直接表现为「字小、发虚、扫读费劲」。

### 字号：六档

每档是一个 **字号 / 行高 / 字重** 三元组，各有唯一用途：

``` text
Metric Number:  28px / 1.2  / 600    指标数字，一屏内不超过 4 个
Page Title:     24px / 1.35 / 600    每页唯一一个 h1
Section Title:  16px / 1.4  / 600    面板、卡片组、抽屉标题
Body:           14px / 1.6  / 400    正文默认档
Secondary:      13px / 1.55 / 400    说明、元数据、辅助行
Caption:        12px / 1.5  / 400    表头、标签、键名、时间戳
```

字重只在前三档声明；`Body` / `Secondary` / `Caption` 需要加重时叠加
`font-medium`（500）/ `font-semibold`（600）。注意方向不对称：加重可以覆盖，
`font-normal` **不能**把 600 降回 400，降权要换档位。

**普通业务页面不要使用超大标题。** 指标数字同样受此约束：它是「一眼读完」而不是
「占满屏幕」——`Metric Number` 档就是 28px，不存在更大的档位。

### 已废弃

`Card Title`（14px/1.45/600 → 改用 `text-body font-semibold`）、
`Nav`（14px/500 → 改用 `text-body font-medium`）、
`Nav Sub`（13px/400，零使用 → 改用 `text-secondary`）。

## 5. Spacing

使用 4px 基础间距，**单一刻度**：

``` text
4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 …
```

实现上直接取 Tailwind 的数字刻度，**任意整数即刻度值**（`p-17` = 68px、
`max-h-55` = 220px、`min-w-160` = 640px）。因此没有任何理由写 `p-[17px]` 这类
一次性任意值。

常用（取值已固定，不再是区间）：

``` text
Page padding: 20px        --app-main-padding
Card padding: 20px        --card-padding
Section gap:  24px        --section-gap
Component gap: 8-16px     直接用数字刻度
```

**不要随意产生 17px、19px、23px 等间距**——需要非 4 倍数值时，先确认是不是
真的需要一个新档。

## 6. Border Radius

三档，全站只用这三档（外加 `rounded-full` 给圆形元素）：

``` text
Small:   6px    小控件：复选框、下拉项、徽标
Default: 10px   控件：按钮、输入框、Tab、列表项
Card:    12px   表面：卡片、面板、弹层、代码块
```

`Large: 14px` 已废弃（零使用，已删除）。不要写 `rounded-[4px]` 这类一次性圆角值。

## 7. Shadow

普通 Card 优先使用 border，而不是明显阴影。

实现上**只有一档阴影** `--shadow-overlay`，仅供 Dialog / Drawer / Dropdown 等浮层
使用；卡片一律描边不投影。

## 8. Global Layout

``` text
Sidebar: 164px
Header: 52px
Main padding: 20px
```

Sidebar 和 Header 必须由 AppShell 统一提供。

## 9. Card

``` text
background: white
border: 1px solid border
border-radius: 12px
```

不要为了装饰加入复杂渐变。

## 10. Buttons

Primary 用于创建、保存、启动、部署等核心操作。

Secondary 用于查看、返回、取消等次要操作。

Destructive 仅用于删除、停止、回滚等危险操作。

同一页面尽量只保留一个视觉权重最高的 Primary Action。

## 11. Status

所有业务状态统一使用 `StatusBadge` 或等价组件。

示例：

``` text
运行中
已完成
失败
待执行
已停止
未开始
```

## 12. Icons

统一使用 Lucide Icons 或项目已经确定的单一图标体系。

-   线性图标
-   16-20px
-   stroke 风格一致
-   不混用多个图标库

## 13. Tables

-   表头弱化
-   行高稳定
-   操作列靠右
-   状态使用 StatusBadge
-   不使用过重边框
-   Hover 轻量
-   长文本 ellipsis
-   必要时 Tooltip

## 14. Forms

-   Label 清晰
-   必填项明确
-   错误信息紧邻字段
-   Loading 状态明确
-   提交按钮统一
-   不改变原有业务校验规则

## 15. Responsive

桌面端优先，至少保证：

``` text
>= 1440px
1280px
1024px
```

**断点只用具名档，不写任意断点**：

``` text
sm  640px    自适应卡片栅格开始多列
md  768px    暂未使用
lg  1024px   主用：单列 → 多列 / 两栏主从布局 / 详情字段横排
xl  1280px   暂未使用
```

主用 `lg` 的理由：侧栏 164px + 页面内距 40px 是固定开销，视口 1024px 时可用内容
宽度为 820px，正好够「320px 主列 + 500px 从列」或「4 列指标卡」。原先混用的 900px
不对应任何真实设备档位，已废弃。

窄屏：

-   Dashboard Grid 自动换行
-   Quick Actions 自动换行
-   Table 必要时横向滚动
-   Sidebar 可以折叠

禁止用大量 absolute positioning 解决响应式。

## 16. Tailwind Rules

推荐：

``` html
<div class="rounded-lg border border-border bg-card p-[var(--card-padding)]">
```

避免：

``` html
<div class="rounded-[13px] mt-[17px] bg-[#15756a] p-[22px]">
```

优先使用 Design Token 与刻度值。特殊值必须有明确视觉原因——并且这个原因要写在
代码注释里，否则下一个人会把它当成规范照抄。

## 17. AI Coding Rule

如果设计图与已有组件冲突：

1.  优先复用已有 AI-SE 组件。
2.  必要时调整基础组件。
3.  不为单个页面复制基础组件。
4.  不为单个页面创建新的颜色体系。
