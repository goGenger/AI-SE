# 141 · W9 可访问性与韧性（实施记录）

**阶段**：W9（对应审评文档 P9）
**日期**：2026-10-14
**前置**：[132-web-frontend-remediation-plan.md](132-web-frontend-remediation-plan.md)（计划 §W9）、[140-phase-w8-interaction-containers.md](140-phase-w8-interaction-containers.md)（W8）
**性质**：可访问性修正 + 一次配色裁决。**未改任何 store 方法、未改 api、未改业务文案、未改组件结构与容器选择。**

---

## 一、目标与结果

**目标（来自审评 P9）**：把「能用」提到「人人能用」，并对一直挂着的**非文本对比度**作出裁决。

| 指标 | 改造前 | 改造后 |
| --- | --- | --- |
| `<html lang>` | `en`（界面全中文） | **`zh-CN`** |
| favicon | `data:,`（空白，浏览器显示默认图标） | **真实 SVG 图标**（`public/favicon.svg`） |
| 状态传达 | 颜色 + 文字（**2 重**） | **颜色 + 文字 + 图标（3 重）** —— 六个 tone 各一枚形状不同的图标 |
| `--input` 对比度 | 卡片上 **1.54:1**（低于 1.4.11 的 3:1） | **3.41 / 3.14:1**（两套模式，对实际承载面达标） |
| 非文本对比度裁决 | 挂起（W5 起） | **已裁决**：3 项豁免（附 WCAG 条款）、1 项判为真实缺陷并修正 |
| 对比度实测 | 24 组（仅文字） | **28 组 × 2 模式**，含非文本图形 |
| 焦点环 | 未逐元素验证 | **逐元素实测**：仪表盘 15 个可聚焦元素全部有可见指示 |
| `--border-strong` | 声明 + 文档 + 主题映射，**零使用** | **删除**（它正是会让 `--input` 缺陷回潮的那个令牌） |
| 测试 | 430（35 文件） | **443（36 文件）**（+13） |
| CSS 产物 | 27.34 kB | **27.24 kB**（略降 —— 删掉了一个废弃令牌的映射） |

---

## 二、文档层（工作项 1）

| 项 | 改造前 | 改造后 |
| --- | --- | --- |
| `lang` | `en` | `zh-CN` |
| `title` | `AI-SE 控制台`（已合规） | 不变 |
| `favicon` | `<link rel="icon" href="data:," />` | `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` |
| 新增 | — | `<meta name="description">`、`<meta name="color-scheme" content="light dark">` |

`public/favicon.svg` 是新建的：一个圆角方块 + 白色 `>_` 提示符，用主色 `#15756a`。选 `>_` 而不是文字缩写，是因为 16px 下汉字与字母都会糊成一团，而一个提示符形状在 16px 仍然可辨，并且**与侧栏那颗主色圆点同源**（同一个品牌色）。

`color-scheme` 这一条是顺带补的：样式层早就在用 `prefers-color-scheme`，但没有声明 `color-scheme`，于是滚动条、原生下拉、表单默认控件这些**浏览器自己画的部分**在暗色下仍然是亮的。声明之后它们跟着系统走。

---

## 三、状态三重冗余（工作项 2）

`StatusBadge` 增加 `tone → 图标` 映射，**默认显示图标**：

| tone | 图标 | 形状 |
| --- | --- | --- |
| `success` | `CircleCheck` | 圆圈 + 对勾 |
| `running` | `LoaderCircle` | 圆圈 + 弧 |
| `pending` | `CircleDashed` | 虚线圈 |
| `warning` | `TriangleAlert` | 三角 |
| `error` | `CircleX` | 圆圈 + 叉 |
| `neutral` | `CircleMinus` | 圆圈 + 短横 |

**为什么必做**：改造前「已完成」与「失败」两枚徽标除了文字与红/绿之外**没有任何形状差异**。红绿色觉障碍在男性中约占 8%，对这部分用户来说，一眼扫过一列徽标是分不出好坏的。

图标是**装饰性的**（`aria-hidden="true"`）—— 旁边的文字已经朗读过同样的信息，再读一遍是噪音。这条由测试钉住。

配套新增 `showIcon` prop（默认 `true`），给空间实在放不下的场合留出口；**当前 64 处调用里没有一处关掉它**。

---

## 四、非文本对比度裁决（工作项 4/6 的核心）

这一项从 W5 起一直挂着「等 W9 裁决」。W9 做了实测，并把结论拆成三件**不同**的事 —— 而不是笼统地「都改」或「都不改」。

### 实测（浏览器读取解析后的令牌值，WCAG 2.1 相对亮度公式）

**亮色**：实测 28 组，**25 组达标**、3 组豁免、**0 组未达标**。
**暗色**：实测 28 组，**25 组达标**、3 组豁免、**0 组未达标**。

20 组文字组合两套模式全部达标，最低的是 `--muted-foreground / --muted`（4.89 / 6.88），仍高于 4.5。

### 裁决一：`--input` 是**真实缺陷**，已修

| | 亮色 | 暗色 |
| --- | --- | --- |
| 改前（对 `--card`） | **1.54:1** | 1.65:1 |
| 改后（对 `--card`） | **3.41:1** | **3.14:1** |
| 改后（对 `--background`） | 3.15:1 | 3.42:1 |

**判据**：WCAG 1.4.11 约束的是「**识别**组件所**必需**的视觉信息」。输入框与它所在的面**同色**（亮色下都是 `--card`），于是那条边框是唯一能告诉人「这里可以输入」的东西 —— 它落在 1.4.11 正面约束的范围里，1.54:1 是真缺陷。

新值由脚本在原始色相上朝黑色/白色逐级混合搜索得到，取**第一个满足 3.15:1** 的值（留一点余量）。代价是表单控件比卡片分隔线明显得多 —— **这个不对称是有意的**：控件该被看见，分隔线不该抢眼。

### 裁决二与三：`--border` 与 `--foreground-disabled` **豁免**，维持原值

| 组合 | 亮色 | 暗色 | 豁免依据 |
| --- | --- | --- | --- |
| `foreground-disabled` / `card` | 1.75 | 2.03 | SC 1.4.3 与 1.4.11 **明确豁免**「停用状态的用户界面组件」。且按 README §8 该令牌**不承载信息**，只表示「不可用」 |
| `border` / `background` | 1.17 | 1.40 | 卡片与表格行靠「表面 + 留白」即可识别，那条线是**装饰性分隔**，不是识别依据 |
| `border` / `card` | 1.26 | 1.28 | 同上 |

**这 3 组是「测了并裁定豁免」，不是「没测」。** 设计文档 §13「不使用过重边框」的设计语言因此**保留** —— 变重的只有表单控件的边界。

### 顺带删除：`--border-strong`

它与旧 `--input` **同值**（`#c5d3d0` / `#36443f`）、**零使用**（全仓只有声明、主题映射与一行文档）。README §5 把它描述为「需要明确轮廓处：弹层、选中态」—— 也就是**恰好是表单边界那个用途**。留着它，下一个人就会用它给输入框描边，把刚修好的缺陷带回来。

删除范围：两处声明 + `--color-border-strong` 映射 + README 表格行。与 W1–W3 删除零使用的 `rounded-xl` / `--shadow-subtle` 同一条做法。

> 这一条超出了「可访问性」的严格边界，属于「顺手清理」，在此显式登记为**对最小改动原则的偏离**，理由是它直接保护了本次的修正不被回退。

---

## 五、其余工作项

| 工作项 | 状态 | 依据 |
| --- | --- | --- |
| 3. 加载态统一换骨架屏 | **W5 已完成，本次复核通过** | 页面级加载态已全部是 `TableSkeleton` / `LoadingSkeleton`。剩余唯一的「加载中…」是 `MCPAppView` 提交按钮的忙碌文案，那是**按钮状态**不是页面加载态 |
| 5. 每个可交互元素都要有可见焦点环 | **已实测** | 浏览器逐个 Tab 前进，仪表盘上 15 个可聚焦元素**全部**有可见指示（outline 或 box-shadow）；全站统一一档 `focus-visible:ring-2 focus-visible:ring-ring` |
| 6. 落地暗色模式，两模式对比度都达标 | **已实测** | 两套模式各 28 组全部达标或豁免；状态徽标取暗色令牌 |
| 7. icon-only 按钮补 `aria-label`；装饰性图标加 `aria-hidden` | **已核对 + 护栏测试** | 仪表盘上无名可交互元素数为 **0**；`size="icon"` 的 `<Button>` 全部带名字（源码扫描）；`StatusBadge` 的图标 `aria-hidden` |
| 8. 表格语义 `<th scope="col">` + `aria-sort` | **W7 已完成，本次复核通过** | 浏览器实测：表头全部 `scope="col"`，可排序列全部带 `aria-sort` |
| 9. 全局搜索键盘可完整操作 | **已实测** | `Cmd/Ctrl + K` 打开命令面板、输入可筛选、**方向键可移动高亮项**、`Esc` 关闭 |

**没有「通知」入口可以验**：W4 已裁定顶栏不放通知铃铛（没有真实数据源）。因此工作项 9 里「通知等新增交互」这一半不适用，只有全局搜索这一半。

---

## 六、验证

### 6.1 门槛命令

```
typecheck ✓   lint ✓   test 443/443 ✓   build ✓
```

### 6.2 浏览器实测（真实 Chromium，Playwright 1.61 驱动 dev server + 页面内注入 fetch mock）

**W9 自身 18/18 通过**，并回归跑通了 W7（27/27）与 W8（21/21）两套，确认配色与徽标改动没有破坏前两阶段的结论。

| 分组 | 检查 | 实测 |
| --- | --- | --- |
| 文档 | `html lang = zh-CN` | ✓ |
| 文档 | title 有意义 | ✓ |
| 文档 | favicon 指向 `/favicon.svg` 且 **HTTP 200** | ✓ |
| 状态 | 徽标渲染图标 | ✓ |
| 状态 | 图标 `aria-hidden="true"` | ✓ |
| 状态 | 不同状态用**不同**图标（去色后可分辨） | ✓ |
| 表格 | 表头全部 `<th scope="col">` | ✓ |
| 表格 | 可排序列全部带 `aria-sort` | ✓ |
| 名称 | 仪表盘上无名可交互元素数为 0 | ✓ |
| 焦点 | 15 个可聚焦元素全部有可见焦点指示 | ✓ |
| 键盘 | `Cmd/Ctrl+K` 打开命令面板 | ✓ |
| 键盘 | 方向键可移动高亮项 | ✓ |
| 键盘 | `Esc` 关闭 | ✓ |
| 对比度 | 亮色 28 组：25 达标 / 3 豁免 / 0 未达标 | ✓ |
| 对比度 | 暗色 28 组：25 达标 / 3 豁免 / 0 未达标 | ✓ |
| 暗色 | 徽标取暗色令牌 | ✓ |
| 全局 | 亮色模式控制台无错误 | ✓ |

原始测量值落在 `/tmp/w9-contrast.json`（临时产物），整理后的表已写进 `styles/README.md` §9。

### 6.3 未验证的部分（诚实说明）

- **未跑自动化 a11y 扫描器（axe / pa11y）**：仓库里没有这类依赖，本次没有为了这个而新增依赖。逐项实测覆盖了计划点名的九条，但**不等于**全量 WCAG 审计 —— 「已符合 WCAG」这句话本次**不声称**。
- **未用真实屏幕阅读器（VoiceOver / NVDA）走查**：只做了结构与属性的静态核对（`aria-label` / `aria-hidden` / `scope` / `aria-sort` / `role=alert` / `aria-describedby`）。朗读顺序与虚拟光标行为**未经真人验证**。
- **未做 200% 缩放 / 高对比度模式测试**（SC 1.4.4 / 1.4.12）：不在计划的工作项里，未做。
- **`format:check`**：与 W2–W8 相同，全仓不通过是基线既有状态，不在门禁内。

### 6.4 机械核对

| 检查 | 结果 |
| --- | --- |
| `index.html` 的 `lang` | `zh-CN` |
| `data:,` | **0** |
| `--border-strong` | **0**（已删） |
| 真实 `<style scoped>` 块 | **1**（仍是 Deployments 的 `[data-active]`） |

---

## 七、阶段报告

### Modified Files

**新增**
- `apps/web/public/favicon.svg` — 真实站点图标（`apps/web/public/` 首次建立）
- `apps/web/src/__tests__/accessibility.test.ts` — 9 条静态契约
- `docs/141-phase-w9-accessibility.md`（本文件）

**修改**
- `apps/web/index.html` — `lang="zh-CN"`、真实 favicon、`description`、`color-scheme`
- `apps/web/src/components/common/StatusBadge.vue` — `tone → 图标` 映射（三重冗余）+ `showIcon` prop
- `apps/web/src/styles/app.css` — `--input` 提亮/加深至 3:1 达标；删除 `--border-strong` 声明 ×2 与主题映射 ×1
- `apps/web/src/styles/README.md` — §5 边框两档重写（含「为什么 input 更重」）、§9 对比度实测重写（28 组 ×2 模式 + 豁免条款）、§13 非文本对比度裁决落地
- `apps/web/src/__tests__/commonComponents.test.ts` — `StatusBadge` 三重冗余 4 条
- `docs/15-development-roadmap.md` / `docs/17-acceptance-checklist.md` / `docs/18-phase-engineering-goals.md`

### Implementation

见 §二～§五。

### Architecture Changes

**1. 状态传达第一次做到三重冗余。** 六个 tone 各有一枚形状不同的图标，去掉颜色后一列徽标仍然可读。这是本阶段唯一影响全站 64 处展示的改动。

**2. 非文本对比度从「一个待办」变成「一条有条款依据的判据」。** 原记录只写「`--border` 与 `--input` 低于 3:1，等 W9 裁决」。W9 把它拆成「承载识别功能的（必须达标）」与「装饰性的 / 规范明确豁免的（维持原值）」，并把 WCAG 条款写进 README —— 于是下一个遇到同类问题的人有判据可用，而不是再攒一个待办。

**3. 删掉一个会把缺陷带回来的令牌。** `--border-strong` 零使用、且与旧 `--input` 同值，文档还把它描述成本来就该用于「明确轮廓」的场合 —— 它留在那里，本次的修正迟早被回退。

**4. 站点图标从「没有」变成「有品牌含义的」。** `public/` 目录首次建立。

### Dependencies

无新增 npm 依赖。新增 6 个 `@lucide/vue` 图标引用（`CircleCheck` / `LoaderCircle` / `CircleDashed` / `TriangleAlert` / `CircleX` / `CircleMinus`）。

### Tests

```
Test Files  36 passed (36)
     Tests  443 passed (443)
```

**+13 条**（430 → 443）：

| 文件 | 变化 | 覆盖 |
| --- | --- | --- |
| `accessibility.test.ts` | +9（新） | `index.html` 的 lang / title / favicon / color-scheme；favicon 文件本体是 SVG；icon-only 按钮全部有名字（含「扫描确实覆盖到内容」的反向护栏与一处抽样确认）；`StatusBadge` 的六 tone 图标映射 + `aria-hidden` |
| `commonComponents.test.ts` | +4 | 六个 tone 的图标**互不相同**；图标装饰性；`showIcon=false` 时不渲染图标；`gap-1` 分隔 |

### Lint

`eslint "src/**/*.{ts,vue}"` 通过，无输出。

### Typecheck

`pnpm --filter @ai-se/shared build && vue-tsc --noEmit` 通过，无输出。

### E2E

未运行后端 API 级 e2e（未改后端）。前端以真实 Chromium 实测替代，见 §6.2。

### Known Issues

1. **未跑自动化 a11y 扫描器、未用真实屏幕阅读器**（§6.3）。本次的结论是「计划点名的九项逐项实测通过」，**不是**「全站符合 WCAG」。
2. **`--input` 在 `--muted` 面上仍为 2.90–2.97:1**。`--muted` 是行 hover / 内嵌区块 / 只读区，当前**没有任何表单控件落在它上面**，因此未纳入目标。若将来有控件落在 muted 面上，需要重新取值。
3. **`showIcon` prop 无一处关掉**（64 处调用全部用默认值）。它是为「实在放不下」留的出口，当前没有这样的场合 —— 属于「留了但没用上」，若长期无使用应在后续阶段删除。
4. **未做 200% 缩放与强制高对比度模式**测试（SC 1.4.4 / 1.4.12），不在计划工作项内。
5. **`RequirementsView` / `AgentsView` 的详情抽屉未同步 URL**（W8 登记），仍未修。
6. **`.taste-skill/` 目录仍在**，推迟到 W10 清理。
7. **`AgentsView` 的 `agent-link` legacy 类名**（W7 登记）仍未核查，留给 W10。
8. **`format:check` 全仓不通过**，基线既有状态，不在门禁内。
9. **Vite 依赖预构建缓存过期会导致整屏空白**（`504 Outdated Optimize Dep`）。本阶段新增 6 个图标引用**必然**触发一次。解决：停 dev server → 清 `node_modules/.vite/deps` → 重启。

### Acceptance Result

**通过。** 计划 §W9 的九项工作项全部有结论，四项门槛命令全绿：

```
typecheck ✓   lint ✓   test 443/443 ✓   build ✓
```

| 要求 | 结果 |
| --- | --- |
| 1. `lang` → `zh-CN`；有意义 title；真实 favicon | ✓ 三项全部落地，favicon 为新建的 `public/favicon.svg` |
| 2. 状态三重冗余（颜色 + 文字 + 图标） | ✓ `StatusBadge` 六 tone 各一枚**形状不同**的图标，`aria-hidden`，浏览器实测 |
| 3. 加载态统一换骨架屏 | ✓ W5 已完成，本次复核通过（剩余唯一的「加载中…」是按钮忙碌态） |
| 4. 全部颜色组合实测对比度，实测值写进报告 | ✓ 28 组 × 2 模式，数值写进 `styles/README.md` §9 与本报告 §四 |
| 5. 每个可交互元素都要有可见焦点环 | ✓ 逐元素 Tab 实测，仪表盘 15/15 有可见指示 |
| 6. 落地暗色模式，两模式都达标 | ✓ 两套模式各 28 组全部达标或豁免 |
| 7. icon-only 按钮补 `aria-label`；装饰性图标加 `aria-hidden` | ✓ 无名可交互元素数为 0；源码护栏测试钉住 |
| 8. 表格语义 `<th scope="col">` + `aria-sort` | ✓ W7 已完成，本次浏览器复核通过 |
| 9. 全局搜索键盘可完整操作 | ✓ `Cmd/Ctrl+K` 打开、方向键移动高亮、`Esc` 关闭（通知入口不适用 —— W4 已裁） |
| 验收方式：浏览器实际验证，不只声称「已符合 WCAG」 | ✓ 逐项实测；**并明确不声称全站符合 WCAG**（见 §6.3） |

### Next Phase Boundary（W10 · 终验）

**STOP。W9 到此为止，不自动进入 W10。**

W10 的范围（计划 §W10）：

1. **机械检查（贴出命令与输出）**：① 不存在 `import "styles.css"` 且文件本体已删；② 无用于覆盖样式的 `!important`；③ `views/` 与 `components/` 内无 `text-[..]` / `min-[..px]` / `w-[..px]` 一次性任意值；④ 无 legacy 类名（`page-header` `eyebrow` `status-pill` `compact-list` `project-row` `detail-grid` `event-timeline` `tool-call-row` `mcp-detail-grid` `deployment-layout` `tab-bar` `mcp-app-frame` `workflow-checkbox`）；⑤ `grep -rn "text-decoration: none" apps/web/src/views apps/web/src/components` → **0**；⑥ 四项门槛命令全绿。
2. **逐条对照 8 条原始问题**，每条回答「已解决 / 部分解决 / 未解决」+ 证据。
3. **诚实报告**：未解决 / 部分解决的项与原因、偏离要求处与原因、只属推测未实测的结论。
4. **附加清理**：`.taste-skill/` 目录。

**W10 开工前要一并处理的 W7/W8/W9 遗留**：

- `AgentsView` 的 `agent-link` legacy 类名（不在计划的 grep 清单里，需单独核查）
- `RequirementsView` / `AgentsView` 的详情抽屉未同步 URL
- `showIcon` prop 零使用
- `--input` 在 `--muted` 面上 2.90–2.97:1（当前无控件落在该面）

**未开始事项（STOP）**：W10 未开始。`.taste-skill/` 目录待 W10 清理。

**X1 · 模型与凭据配置**（已裁定立项，排 W 线之后）：控制台内配置 LLM 模型与 API Key，**凭据必须复用既有 Secret Provider 引用，不得新增明文存储**；附带补 `WorkflowsView` 任务审批缺失的意见输入框。
