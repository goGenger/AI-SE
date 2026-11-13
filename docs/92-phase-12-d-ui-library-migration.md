# Phase 12-D — UI 基础组件全量组件库化

> **编号说明**：本阶段任务书指定输出 `docs/90-phase-12-d-ui-library-migration.md`，
> 但 `docs/90` 已被 **Phase 12-C**（`docs/90-phase-12c.md`）占用，`docs/91` 为 **Phase 12-D-0**。
> 按「文档编号只增不覆盖」规则，本记录顺延为 **`docs/92`**，**未覆盖** `docs/90` / `docs/91`。

---

## 1. 迁移组件清单

`src/components/ui/` 下共 10 个组件目录 + `utils.ts`。逐项判定与处置：

| # | 组件 | 迁移前实现 | 处置 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | **Button** | 硬编码 `<button>` + cva | ✅ **迁移** → `reka-ui` `Primitive` 根节点（shadcn-vue 官方结构），新增 `as` / `as-child` | 交互组件须用 Reka |
| 2 | **Label** | 硬编码 `<label>` | ✅ **迁移** → `reka-ui` `Label` 原语（shadcn-vue 官方 `Label.vue` 同构） | 展示组件须用 shadcn-vue 标准实现 |
| 3 | **Separator** | 硬编码 `<div role="separator">` | ✅ **迁移** → `reka-ui` `Separator` 原语 | 同上 |
| 4 | **Checkbox** | 原生 `<input type="checkbox">` + `accent-color` | ✅ **迁移** → `reka-ui` `CheckboxRoot` + `CheckboxIndicator` + lucide `Check` | 交互组件须用 Reka |
| 5 | **Select** | — | ⏸ **保持**（Phase 12-D-0 已完成 Reka 迁移，本阶段不重复重构；按要求回归验证） | 任务书第 8 条 |
| 6 | **Input** | 原生 `<input>` + Token 类 | ⏸ **无需迁移**：shadcn-vue 官方 `Input.vue` 本身就是「原生 `<input>` + 类」（Reka 无文本输入原语） | 与官方实现同构 |
| 7 | **Textarea** | 原生 `<textarea>` + Token 类 | ⏸ **无需迁移**：同上（shadcn-vue 官方 `Textarea.vue` 结构一致） | 同上 |
| 8 | **Card**（含 Header/Title/Description/Content/Footer） | 原生 `<div>` + Token 类 | ⏸ **无需迁移**：与 shadcn-vue 官方 `Card.vue` 结构一致（官方亦为纯 `<div>` + 类） | 展示组件已达标 |
| 9 | **Badge** | 原生 `<span>` + cva | ⏸ **无需迁移**：与官方 `Badge.vue` 一致（cva 变体 + 单一元素 + `class` 合并） | 同上 |
| 10 | **Table** | 语义 `<table>` + Tailwind（组件内） | ⏸ **保持**：任务书明确「保留语义化 HTML Table」 | 任务书「Table」节 |

**未创建**：`Dialog` / `AlertDialog` / `Tabs` / `Tooltip` / `Popover`。
理由：这 5 个在 `components/ui` 中**此前不存在**，且本阶段**禁止修改业务页面** ⇒ 创建后必然是无调用方的死代码；
任务书同时要求「不为组件库化强行引入不存在或不必要的 primitive」与「不新增业务功能」。
（建议单开阶段接入：`AlertDialog` 替掉 `window.confirm` 删除确认、`Tabs` 替掉 MCP 详情页手写 Tab、`Tooltip/Popover` 视需求启用。）

## 2. 每个组件采用的实现

| 组件 | Primitive / 实现 | 关键点 |
| --- | --- | --- |
| Button | `Primitive`（reka-ui） | `withDefaults`：`as: "button"`；`as-child` 可把样式/行为合并到 `<a>`/`<RouterLink>`；`buttonVariants`（cva）与全部类字符串**逐字未改** |
| Label | `Label`（reka-ui） → shadcn-vue `Label.vue` 结构 | `for` / `as` / `as-child` 透传；类字符串逐字未改 |
| Separator | `Separator`（reka-ui） → shadcn-vue `Separator.vue` 结构 | **`decorative` 默认 false**（官方默认 true）：官方默认会输出 `role="none"`，会丢掉迁移前已有的 `role="separator"` + 垂直 `aria-orientation`（既有契约测试锁定）→ 保留原语义，仍可显式覆盖 |
| Checkbox | `CheckboxRoot` + `CheckboxIndicator`（reka-ui） + lucide `Check` | 适配 `v-model: boolean`（原语类型含 `'indeterminate'`，本适配层不产出）；选中态 `data-[state=checked]:bg-primary / text-primary-foreground`；`size-4` + `rounded-[4px]` + `border-input` + `focus-visible:ring-2` |

> 兼容层结构（任务书示例的落地方式）：`业务页面 → <Checkbox v-model> → AI-SE Checkbox 适配层 → Reka CheckboxRoot`。

## 3. API 兼容情况（5 处调用零改动）

| 组件 | 调用点 | 兼容结论 |
| --- | --- | --- |
| Button | 12 处（6 个页面 + common） | ✅ `variant` / `size` / `class` / `disabled` / `type` / `@click` 全部保持；**新增** `as` / `as-child` |
| Label | 26 处 | ✅ `for` 关联实测有效（点 label → 输入框获焦）；`class` 合并不变 |
| Separator | 0 处（仅组件测试） | ✅ `orientation` / `class` 保持；`role="separator"` + `aria-orientation` 语义保持 |
| Checkbox | 2 处（Workflows「需要人工审批」、MCP 绑定「启用」） | ✅ `v-model`(boolean) / `class` / `id` / `disabled` / `required` 保持；DOM 由 `<input type=checkbox>` 变为 `<button role="checkbox">`（见 §6 R1） |
| Select | 6 处 | ✅ 回归验证通过（打开/选项/v-model/键盘/外部关闭） |

## 4. 特殊适配

1. **Checkbox `v-model` 类型桥接**：Reka 的 `modelValue` 为 `AcceptableValue`（含 `'indeterminate'`），适配层对外保持 `boolean`，回写时 `value === true`。
2. **Checkbox 的 label 点击**：页面现有写法是 `<label><Checkbox/><span>文案</span></label>`。Reka 根节点渲染为 `<button role="checkbox">`，属 HTML「可标记元素」，浏览器会把 label 点击**转发**给该 button ⇒ 实测「点文案即可切换」**行为未回归**（Workflows 与 MCP 各连续两次点击 = 两次正确切换，每次恰好 1 个 trusted click）。
3. **属性透传策略**：Checkbox / Label / Separator 的根节点**就是** Reka 组件，故 `$attrs` 直接透传（`id`/`disabled`/`required`/`aria-*`）；Button 经 `Primitive` 透传；Select 沿用 12-D-0 的「`id`→触发器、`required`→SelectRoot」分发（本次未改）。
4. **Preflight 未启用**：组件内显式保留 UA 兜底类（`appearance-none` / `size-4` / `shrink-0` / `border` 等）。
5. **legacy 未分层规则兜底**：Button 的 scoped `button { font-size/line-height/font-weight }` 保留（`styles.css` 未分层 `font: inherit` 仍会压过工具类）。

## 5. 修改文件

| 文件 | 变化 |
| --- | --- |
| `src/components/ui/button/Button.vue` | 47 → 72 行：`Primitive` 根节点 + `as`/`as-child` |
| `src/components/ui/label/Label.vue` | 25 → 38 行：`reka-ui` `Label` 原语 |
| `src/components/ui/separator/Separator.vue` | 30 → 45 行：`reka-ui` `Separator` 原语（`decorative` 默认 false） |
| `src/components/ui/checkbox/Checkbox.vue` | 47 → 60 行：`CheckboxRoot` + `CheckboxIndicator` + `Check` |
| `src/__tests__/uiComponents.test.ts` | 新增/改写 6 例：Button `as-child`/`as`、Label `as-child`、Separator 原语输出、Checkbox 4 例（原 2 例改写） |
| `src/__tests__/workflowsView.test.ts` | 1 处断言：`type="checkbox"` → `role="checkbox"` |

**未修改**：`api/*`、`stores/*`、`viewmodels/*`、`router/index.ts`、`styles.css`、`styles/app.css`、`components/ui/utils.ts`、`components/common/*`、`components/layout/*`、`components/ui/{select,table,input,textarea,card,badge}`、全部业务页面（0 处 diff）、`package.json` / `pnpm-lock.yaml`。

## 6. 依赖与体积变化

- **依赖变化：无**（`reka-ui@2.10.4` 早在 `package.json` 中；本阶段首次引用 `Primitive` / `Label` / `Separator` / `Checkbox` 四个模块）。
- 体积（构建产物）：

| 阶段 | CSS | JS |
| --- | --- | --- |
| 12-C 结束 | 39.61 kB | 343.21 kB |
| 12-D-0 结束（Select） | 40.66 kB | 465.81 kB |
| **12-D 结束（本阶段）** | **`index-B0jf8os8.css` 40.95 kB**（+0.29） | **`index-Bolk9bBO.js` 474.15 kB**（**+8.34**） |

## 7. typecheck / lint / test / build

| 门禁 | 结果 |
| --- | --- |
| `typecheck` | ✅ PASS |
| `lint` | ✅ PASS（过程中修掉 1 处 `no-unused-vars`：`defineEmits` 声明未使用 → 移除） |
| `test` | ✅ **28 files / 249 tests**（245 → 249；全程未出现失败遗留） |
| `build` | ✅ `index-B0jf8os8.css` 40.95 kB / `index-Bolk9bBO.js` 474.15 kB |

## 8. 浏览器验证结果（真实后端 + 真实数据，只读；1280/900/899/700）

| 项 | 结果 |
| --- | --- |
| Checkbox 渲染 | Workflows / MCP 详情：`<button role="checkbox" aria-checked data-state>`，16×16px、`border-radius 4px`、`border #E8EAF0`；**原生 `input[type=checkbox]` 数量 = 0** |
| Checkbox 交互 | 点击 **label 文案** → 切换（Workflows：false→true→false；MCP：checked→unchecked→checked，每次 1 个 trusted click）；键盘 `Space` → 切换；选中态出现勾选 SVG |
| Checkbox 焦点 | `:focus-visible` 命中，ring = `rgb(108, 92, 231) 0 0 0 2px`（= `--primary`） |
| Label | 点 `label[for="requirement-title"]` → `document.activeElement.id === "requirement-title"` |
| Button | 键盘 Tab 可达；`创建` 按钮 `:focus-visible` ring = `rgb(108,92,231) 0 0 0 2px`、高 36px、圆角 10px；Tab 顺序未变（侧栏链接 → Select 触发器 → 输入框 → 文本域 → 按钮） |
| Select 回归 | `/requirements`：打开 → 选项 `["选择项目","Mini Todo"]` → 选中 → 触发器文案更新、浮层关闭；原生 `<select>` = 0 |
| 页面 console | Requirements / Workflows / Deployments：**0 error / 0 warning** |
| 横向溢出 | 三页 × 1280/900/899/700：**overflowX = 0** |
| legacy 双通道 | `styles.css` 101 个类选择器 ∩ 三页 DOM 类名（125/125/111）= **`[]`** |
| 业务数据 | 仍为 **1 项目 / 2 需求 / 7 规格 / 33 任务 / 73 依赖**（全程只读，未创建数据） |

### 静态扫描（任务书要求的三项）

1. **组件库内是否仍有旧实现**：`components/ui` 中以原生元素为根的文件仅剩 `Input.vue` / `Textarea.vue`（shadcn-vue 官方即原生实现）与 `table/`（任务书要求保留）；`Checkbox` / `Select` / `Label` / `Separator` / `Button` 已全部由 Reka 原语承载（`grep reka-ui` 命中 5 个组件）。
2. **业务页面是否绕过 `components/ui`**：`<input>` / `<textarea>` / `<select>` / `<table>` 在 `views/*.vue` 中 = **0**（12-C/12-D 的源码级护栏测试持续生效）。剩余 12 行原生 `<button>` 均为**语义列表项**（`.requirement-list-item` / `.workflow-item` / `.deployment-item` / agent 项 / MCP 绑定「撤销」），属页面级列表行而非常规基础按钮，本阶段未动（避免改页面视觉）。
3. **是否新增 legacy CSS 依赖**：无 —— 三页 DOM 类名与 `styles.css` 交集为 `[]`；本阶段未新增任何 legacy 类名引用。

## 9. 遗留风险

| # | 风险 | 说明 / 建议 |
| --- | --- | --- |
| R1 | **Checkbox 的 DOM 语义变化** | 由原生 `<input type=checkbox>` → `<button role="checkbox">`。表单原生提交语义（`name/value` 随表单提交）不再由浏览器自动提供；当前 2 处调用都不提交该字段（Workflows 走 JS 组装 payload、MCP 走 `form.enabled`），故无影响。若将来需要原生表单提交，可传 `name`（Reka 会渲染隐藏 input）。 |
| R2 | **`Dialog`/`AlertDialog`/`Tabs`/`Tooltip`/`Popover` 未接入** | 见 §1 说明；建议单独阶段（会涉及业务页面改动）。 |
| R3 | 体积继续增长 | 本阶段 +8.34 kB（JS），总计自 12-C 起 +131 kB。后续每接一个原语族都需评估。 |
| R4 | `Separator` 无业务使用 | 仅组件测试覆盖；`decorative` 默认 false 是刻意的语义保留，若将来按 shadcn-vue 习惯要 `role="none"`，需同步改契约测试。 |
| R5 | Button 换根节点后的排版兜底 | scoped `button { … }` 仅在默认 `as="button"` 时生效；若调用方使用 `as` / `as-child`，需自行声明排版（已在组件注释标注）。 |

---

**PASS** —— 基础组件已全量组件库化（5 个由 Reka 原语承载，5 个与 shadcn-vue 官方实现同构而无需改动），门禁四道全绿，业务页面 0 diff，真实浏览器行为/无障碍/令牌/无溢出/无 console 错误均实测通过。
