# Phase 12-D-0 — shadcn-vue / Reka UI Select 接入验证

> 触发：用户询问「所以我现在系统是没用到 shadcn-vue 组件库吗」→ 确认 `reka-ui` 已安装但零引用 →
> 用户下 **Phase 12-D-0** 指令：只验证把 `components/ui/select/Select.vue` 迁移为真正的
> shadcn-vue / Reka UI Select，不动其它组件、不动调用方、不进入 12-D。
>
> 本阶段**未**进行其他基础组件迁移，**未**进入 Phase 12-D。

---

## 1. 结论：是否成功接入

**是。** `Select.vue` 现在是 `reka-ui@2.10.4` 的 Select 原语封装（不再是原生 `<select>`）：

- 页面 DOM 中**原生 `<select>` 数量 = 0**（Requirements / Workflows / Deployments 实测）。
- 触发器为 `<button role="combobox" aria-expanded aria-required data-state>`；浮层为 Teleport 到 body 的 `[role="listbox"]` + `[role="option"]`。
- 依赖零新增：`reka-ui` 早在 `package.json` 中（2.10.4），本阶段首次引用。

## 2. 使用的 Primitive（全部来自 `reka-ui`）

| Primitive | 用途 |
| --- | --- |
| `SelectRoot` | `v-model` 值、`required` / `disabled` / `name`（表单语义） |
| `SelectTrigger` | 触发器（`id` / `aria-*` 落到此处 → `<label for>` 关联保持） |
| `SelectValue` | 触发器内显示选中项文案（用其默认插槽渲染由 `v-model` + `options` 推导的 label） |
| `SelectIcon` | 下拉箭头（`as-child` + lucide `ChevronDown`） |
| `SelectPortal` + `SelectContent` | 浮层（`position="popper"`、`side-offset=4`，宽度取 `--reka-select-trigger-width`） |
| `SelectViewport` | 浮层内滚动容器 |
| `SelectItem` + `SelectItemText` + `SelectItemIndicator` | 选项行 + 文本 + 选中勾（lucide `Check`） |

内部辅助：`ConfigProvider`/`useDirection` 由 reka 自行处理；`BubbleSelect`（reka 内部的隐藏原生 select）由 `SelectRoot` 自动渲染，用于表单语义。

## 3. 原有 API 兼容性

**完全兼容**（5 处调用零改动：Requirements ×1 / Deployments ×2 / Workflows ×3 —— 实测 `<Select` 使用处未变）。

| API | 状态 |
| --- | --- |
| `v-model`（泛型 `V extends string`） | ✅ 保持，联合类型（`DeliveryEnvironment`、`WorkflowFailureStrategy`）仍可直接绑定，无需断言 |
| `options: SelectOption[]`（`{value,label,disabled?}`） | ✅ 保持 |
| `id` | ✅ 落到触发器（`<label for="requirement-project">` 关联实测有效） |
| `aria-*` | ✅ 透传到触发器（`aria-label` 实测在位）；`required` 额外产生 `aria-required="true"` |
| `required` | ✅ 保持（透传 `SelectRoot` + 触发器 `aria-required`）——**但**见 §7 R2 |
| `disabled` | ✅ 保持（`SelectRoot` + 触发器 `disabled` / `data-disabled`） |
| `class` | ✅ 合并到触发器 |

**唯一内部适配（调用方无感）——空值选项**：reka-ui 的 `SelectItem` 源码明确禁止 `value === ""`
（`if (props.value === "") throw new Error("A <SelectItem /> must have a value prop that is not an empty string…")`，
空串在 Radix/Reka 语义中＝"清空选择 + 显示 placeholder"），而本仓库 5 处调用都把 `""` 当作**可见选项**
（「选择项目」/「选择已分析的需求」）且 `v-model` 初值就是 `""`。组件内部把 `""` 映射为私有哨兵
`__ai_se_empty__`，回传时还原为 `""`：

- 触发器显示该选项 label（与迁移前原生 `<select>` 一致）；
- 选中它 → emit `""` → **实测 Requirements「创建」按钮随即 `disabled=true`**（业务门禁跟随）；
- 调用方把 `v-model` 设为 `""` → 触发器显示该选项 label；
- **哨兵不会泄漏到 DOM**（组件契约测试断言 `not.toContain("__ai_se_empty__")`）。

> 若调用方将来传 `name`（本仓库当前无人传），reka 的隐藏原生 select 会带出哨兵而非 `""` —— 已在组件注释中标注。

## 4. 修改文件

| 文件 | 变化 |
| --- | --- |
| `apps/web/src/components/ui/select/Select.vue` | 70 → **158 行**：替换为 Reka UI Primitive 实现（含空值哨兵、`inheritAttrs:false` 后的显式属性分发、Token 化的浮层/选项样式、`[role=combobox]` 排版兜底） |
| `apps/web/src/__tests__/uiComponents.test.ts` | Select 契约 4 → **8 例**（触发器/组合框语义、空值哨兵不泄漏、选中回显、placeholder 兜底、属性透传、disabled、视觉刻度、class 合并） |
| `apps/web/src/__tests__/requirementsView.test.ts` | 1 处断言：`<select id="requirement-project">` → `not.toContain("<select")` + `id` + `role="combobox"` |
| `apps/web/src/__tests__/deploymentsView.test.ts` | 1 处断言：原生 `<select required>` → `aria-required="true"`；环境默认值断言改为回显 label「预发（staging）」（选项列表在浮层内，改由浏览器验证） |
| `apps/web/src/__tests__/workflowsView.test.ts` | 2 处断言：`required` 计数 → `aria-required="true"` 计数；失败策略 5 个选项文案 → 回显 label「快速失败」 |

**未修改**：`api/*`、`stores/*`、`viewmodels/*`、`router/index.ts`、5 个业务页面、其它 UI 组件（Button/Card/Input/Table/Checkbox/…）、`styles.css`、`styles/app.css`、`package.json`、`pnpm-lock.yaml`、Design Token。

## 5. 测试与门禁

| 门禁 | 结果 |
| --- | --- |
| `typecheck` | ✅ PASS |
| `lint` | ✅ PASS |
| `test` | ✅ **28 files / 243 tests**（239 → 243） |
| `build` | ✅ `index-BZ0_iEZu.css` **40.66 kB**（+1.05）/ `index-G9f5FgnE.js` **465.81 kB**（**+122.60 raw / +43.49 gzip**） |

> SSR 限制（写进测试注释）：浮层在 Teleport + 打开态内，SSR 只渲染触发器 → 选项列表由真实浏览器验证。

## 6. 浏览器验证（真实后端 :3000 + 真实数据，只读；1280/900/899/700）

| 项 | 结果 |
| --- | --- |
| 触发器 | `button[role=combobox]`，318×36px，`font-size 14px / line-height 22.4px`，`radius 10px`，`border #E8EAF0`，`bg #fff`，`color #1F2937`（= `--foreground`，未被 `data-placeholder` 染灰） |
| 打开 | 真实鼠标点击 → `aria-expanded=true`、`data-state=open`、浮层出现 |
| 浮层 | 318×79（宽 = 触发器 `--reka-select-trigger-width`），位置在触发器下方 (205,278)；`bg #fff`、`border #E8EAF0`、`radius 10px`、`box-shadow rgba(16,24,40,.08) 0 4px 12px + rgba(16,24,40,.04) 0 2px 4px`（= `--shadow-overlay`）、`z-index 50`、Teleport 至 body |
| 选项 | Requirements：`["选择项目","Mini Todo"]`；Workflows 项目：`["选择项目","Mini Todo"]`、需求：`["选择已分析的需求","Todo 管理系统"]`、策略：5 项；Deployments 环境：`["开发（dev）","预发（staging）","生产（production）"]` |
| 选项样式 | `14px / 22.4px`、`padding 6px 8px 6px 32px`、`radius 8px`、`color #1F2937`、`cursor pointer`；选中项 `data-state=checked` + 1 个勾选 SVG |
| **v-model** | 选「选择项目」→ 触发器文案变「选择项目」（emit `""`）→ **Requirements「创建」按钮 `disabled=true`**；再选「Mini Todo」→ `disabled=false` |
| **级联（业务）** | Workflows 选项目「Mini Todo」→ 需求下拉随即变为 `["选择已分析的需求","Todo 管理系统"]`（store watch 由 Reka 的 update 事件驱动） |
| **键盘** | 触发器可聚焦；`ArrowDown` 打开浮层；`ArrowDown` + `Enter` 选中 → 文案更新、浮层关闭、门禁跟随 |
| **点击外部** | 打开后点击页面其它位置 → `aria-expanded=false`、`role=listbox` 消失 |
| required | Workflows 项目/需求、Deployments 项目：触发器 `aria-required="true"`（策略/环境为 `null`，正确） |
| 窄屏浮层 | @700：浮层 439×79 落在视口内（`inViewport: true`），`overflowX = 0` |
| overflowX | Requirements / Workflows / Deployments × 1280 / 900 / 899 / 700 = **0** |
| console | 三页 **0 error / 0 warning** |
| legacy 双通道 | `styles.css` 101 个类选择器 ∩ 三页 DOM 类名（142 / 122 / 111，含打开状态的浮层）= **`[]`** |
| 业务数据 | 仍为 **1 项目 / 2 需求 / 7 规格 / 33 任务 / 73 依赖**（全程只读，未创建数据） |

## 7. 发现的问题与风险

| # | 事项 | 说明 |
| --- | --- | --- |
| **R1** | **包体积 +122.60 kB raw / +43.49 kB gzip**（JS 343.21 → 465.81 kB） | Reka 的 Select 族会带入 floating-ui（popper 定位）+ DismissableLayer/FocusScope + 集合注册。结论：**每多接一个 Reka 原语族，体积都会再涨**；后续迁移必须先评估收益/体积比。 |
| **R2** | **`required` 的原生校验气泡消失** | 触发器是 `<button>`，不再是可校验的表单控件；reka 的隐藏原生 select 因内部值为哨兵（非空）不会触发 `required` 拦截。各页面既有的 JS 守卫（`create()` / `saveEnvironment()` 空值早退）**保持不变**，实际提交仍被拦下 —— 但用户不再看到浏览器气泡（这是所有自定义下拉的固有限制）。若要恢复可视化提示，需要在页面层加内联错误文案（本阶段范围外）。 |
| **R3** | 空值哨兵与 `name`（表单提交） | 仅当调用方传 `name` 时，隐藏原生 select 会提交哨兵而非 `""`。本仓库当前 5 处调用均未传 `name`，无影响；已在组件注释标注。 |
| **R4** | reka 的 `data-placeholder` 不可依赖 | `SelectValue` 的内部 label 解析依赖"已渲染的 item"，SSR/未打开时为空 → 触发器可能永远带 `data-placeholder`。故**未**使用 `data-[placeholder]:text-foreground-muted`（否则文案会被染灰），触发器文案统一 `--foreground`（与迁移前一致）；显示文案改由 `v-model + options` 推导后写入 `SelectValue` 插槽。 |
| **R5** | SSR 无法断言选项列表 | 选项位于 Teleport + 打开态内；SSR 测试只覆盖触发器/语义/属性，选项文案改由真实浏览器覆盖（已在测试注释与 §6 说明）。 |
| **R6** | 交互验证手法 | Reka 的触发器/选项响应**真实指针事件**：`.click()` 与合成 `PointerEvent` 无法打开（实测失败），须用真实点击（`click_at_xy` / CDP `Input.dispatchMouseEvent`）；键盘须用 CDP `Input.dispatchKeyEvent`。另：harness 的 CDP 偶发超时 → 交互与断言应放在同一次调用内完成。 |

## 8. 是否建议继续迁移其他基础组件

**建议继续，但要"按需 + 先评估体积"**，优先级：

1. **Checkbox / Switch** —— 体积增量小（Reka 的 Checkbox 不带 floating-ui），能立即拿到 `indeterminate`、更好的键盘与 a11y，收益/成本比最好。当前 `Checkbox` 是原生 `accent-color` 封装。
2. **Dialog / AlertDialog** —— 目前删除确认用的是 `window.confirm`（浏览器原生弹窗，与设计系统不一致）；换成 Reka 的 Dialog 能同时解决「删除确认 UI」与「Dialog 组件缺失」。体积中等。
3. **Tabs** —— MCP 详情页现有 Tab 是手写状态切换；Reka 的 Tabs 提供 `aria-selected`/roving focus，体积小。但会触及 MCP 页面结构，建议单独阶段。
4. **Tooltip / Popover** —— 目前无使用场景，暂不迁移。
5. **Table** —— **不建议**接 Reka（Reka 无 Table 原语，`Table` 本就是纯展示封装，无需行为原语）。
6. **Input / Textarea / Button / Badge / Card** —— **不建议**迁移（原生元素 + Token 已完全够用，迁移只会增加体积与行为面）。

> 若同意，建议一步一个原语族、每步都跑本阶段的同一套验证（真实指针/键盘 + 1280/900/899/700 + console 0 + overflowX 0 + 体积对比）。

---

**PASS**（本阶段为验证阶段：迁移完成、门禁全绿、真实浏览器行为与业务冻结均实测通过；R1/R2 为需你裁决的取舍项，未擅自扩散到其他组件）
