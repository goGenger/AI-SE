# Phase 12-E — Input / Textarea / Table 接入组件库 + Table 内置分页

> 触发：用户指出「input / table / textarea 还是原生实现，也改为组件库的；table 内加分页组件，后续会用到；
> 实现后把现有页面用到这些组件的地方测试一遍并报告」。
>
> 承接 Phase 12-D（`docs/92`）。本阶段**只**处理 Input / Textarea / Table + 新增 Pagination，未动其他组件与页面。

---

## 1. 关键事实：这三者的「组件库实现」到底是什么

| 组件 | Reka UI / shadcn-vue 是否存在对应 primitive | 本阶段处置 |
| --- | --- | --- |
| **Input** | ❌ 不存在纯文本输入 primitive（官方 `Input.vue` 本身就是「原生 `<input>` + 类名」；Reka 只有 TagsInput / PinInput / NumberField / Editable 等**不同语义**控件） | 保留原生语义载体，**渲染路径改走 Reka `Primitive`（`as-child`）**，与 Button/Label/Select 同源 |
| **Textarea** | ❌ 同上（官方 `Textarea.vue` 同为原生 + 类名） | 同上 |
| **Table** | ❌ Reka 无 Table primitive（官方 shadcn-vue 的 Table 也是语义 HTML + 类名） | 保持语义 `<table>`（不引入不存在的 primitive），**新增内置分页** |
| **Pagination** | ✅ `PaginationRoot` / `PaginationList` / `PaginationListItem` / `PaginationFirst` / `PaginationPrev` / `PaginationNext` / `PaginationLast` / `PaginationEllipsis` | **新增组件** `components/ui/pagination/` |

> 因此本阶段对 Input / Textarea 的改动是「渲染路径统一到组件库原语」，而不是把它们换成不存在的 primitive；
> 强行替换只会变成"自己重设计一套"，正是禁止项。

## 2. Modified Files

| 文件 | 变化 |
| --- | --- |
| `src/components/ui/input/Input.vue` | 渲染路径包一层 Reka `Primitive as-child`（属性/事件合并）；`v-model` 仍直接绑原生 `<input>`；注释更新 |
| `src/components/ui/textarea/Textarea.vue` | 同上（原生 `<textarea>`） |
| `src/components/ui/table/Table.vue` | **新增内置分页**：`pageSize`（默认 0 = 不分页）、`v-model:page` / 内部页码、`siblingCount`；分页脚（`共 N 条` + Pagination）；数据变少时页码自动收敛 |
| `src/components/ui/pagination/Pagination.vue` | **新增**：Reka Pagination 原语封装（Token 化样式、`v-model:page`、`showEdges`、`siblingCount`、`disabled`） |
| `src/components/ui/pagination/index.ts` | **新增**：导出 `Pagination` |
| `src/__tests__/uiComponents.test.ts` | +9 例：Input/Textarea 渲染路径（2）、Pagination（4）、Table 内置分页（3） |

**未修改**：`api/*`、`stores/*`、`viewmodels/*`、`router/index.ts`、`styles.css`、`styles/app.css`、`components/ui/utils.ts`、`components/common/*`、`components/layout/*`、其他 UI 组件、**全部业务页面（0 diff）**、`package.json` / `pnpm-lock.yaml`。

## 3. Implementation

### 3.1 Input / Textarea

```vue
<Primitive as-child>
  <input v-model="model" :class="cn(<既有 Token 类>, props.class)" />
</Primitive>
```

- **行为零变化**：`v-model` 仍绑在原生元素上 ⇒ IME 组合输入、`.trim` / `.number` 修饰符、原生校验、聚焦语义与迁移前一致。
- 无额外包裹节点（HTTP 实测：`input.parentElement` 仍是页面原容器）。

### 3.2 Table 内置分页

```vue
<Table :columns="…" :rows="…" :row-key="…" :page-size="10" v-model:page="page" />
```

- `page-size` 默认 `0` ⇒ **不分页**：DOM 与既有调用方行为完全不变（既有页面 0 diff）。
- `page-size > 0` 时：按页切片渲染 + 分页脚（`共 N 条` + `Pagination`）。
- 页码越界自动收敛（末页数据被删/筛选变少时不会卡在空页）。
- 分页 UI 由 `components/ui/pagination` 提供（Reka 原语），当前页高亮用原语自带的 `data-selected="true"` + `aria-current="page"`，不重复维护状态。

### 3.3 Pagination

Reka 原语封装（与 shadcn-vue 官方 `Pagination` 同构）：首/上/下/末 + 页码 + 省略号；
样式全部 Design Token（`h-8` 小号、`--radius-md`、`--border`、`--card`、hover `--muted`、
选中 `--primary`、`focus-visible: ring`）。

## 4. Architecture Changes

- `components/ui` 内新增第 11 个组件目录 `pagination/`；`table/` 由"纯展示"升级为"展示 + 分页"，
  但仍不访问 API / Store / Router（分页只对传入的 `rows` 切片，不在组件内取数）。
- 其余架构不变：无新依赖、无新全局样式、无 legacy 类名。

## 5. Dependencies

**无变化**。`reka-ui@2.10.4` 已在 `package.json`；本阶段首次引用 `Primitive`（Input/Textarea）与
Pagination 原语族。未改 `package.json` / `pnpm-lock.yaml`。

## 6. Tests

| 项 | 结果 |
| --- | --- |
| `test` | ✅ **28 files / 258 tests**（249 → 258） |

新增用例：
1. Input 输出仍是单个原生 `input`（无包裹节点）、`id/placeholder/type/min` 透传、类名不变。
2. Textarea 输出仍是单个原生 `textarea`、`rows` / `maxlength` 透传。
3. Pagination：页码/选中态（`aria-current` + `data-selected`）、首/上/下/末按钮与 Token 类、
   `show-edges` 时首末页常驻、`class` 合并。
4. Table 分页：**默认 `pageSize=0` 不分页（全部行、无分页脚）**、`pageSize>0` 只渲染当前页切片并渲染计数与分页控件、
   `page` 受控切片正确、页码越界收敛到末页。

> 验证过程中的临时探针测试文件（`src/__tests__/_probe.test.ts`）已在验证后删除。

## 7. Lint / Typecheck / Build

| 门禁 | 结果 |
| --- | --- |
| `typecheck` | ✅ PASS |
| `lint` | ✅ PASS（过程中修掉 1 处 `vue/no-dupe-keys`：`page` 同时作为 prop 与 model 名 → 移除重复的 props 声明） |
| `build` | ✅ `index-DFAYPtv_.css` **41.55 kB** / `index-v4wEKX4z.js` **482.32 kB** |

体积轨迹：12-C `39.61 / 343.21` → 12-D-0 `40.66 / 465.81` → 12-D `40.95 / 474.15` → **12-E `41.55 / 482.32`**（本阶段 +0.60 CSS / +8.17 JS）。

## 8. E2E（真实后端 + 真实数据，只读）

**现有页面用到这三个组件的地方（逐页实测）**

| 页面 | 用到的组件 | 结果 |
| --- | --- | --- |
| `/` Dashboard | Table | 4 列（项目名称/描述/状态/创建时间）、1 行、行高 **56px**、单元格 14px、**无分页脚**（默认不分页 ⇒ 行为不变）、`overflowX 0`、console 0 |
| `/projects` | Table + Input×2 + Textarea | 表格 6 列/1 行；两个 input（text/url）**36px、14px/22.4px、圆角 10px、边框 `#E8EAF0`**；textarea 130px/rows5/maxlength1000；**input 父节点仍是页面容器**（无包裹层）；`overflowX 0`、console 0 |
| `/requirements` | Input + Textarea + Select | **v-model 联动实证**：清空「标题」→「创建」`disabled=true`；真实键入 → `false`；清空 PRD（textarea）→ `true`；真实键入 → `false`。`overflowX 0`、console 0 |
| `/workflows` | Input×3 + Select×3 + Checkbox | 3 个 input（36px）、无包裹层、`overflowX 0`、console 0 |
| `/deployments` | Input×4 + Select×2 | 4 个 input（36px）、无包裹层、`overflowX 0`、console 0 |
| `/agents` · `/agent-run` | — / Textarea | textarea 130px、`overflowX 0`、console 0 |
| `/mcp/<id>`（请求级替身） | Input×3 + Checkbox | 3 个 input（36px，`datalist` 关联保留）、Checkbox=Reka（原生 checkbox 0 个）、console 0 |

**Table 内置分页的真实验证（临时探针页，23 行探针数据，验证后删除）**

| 操作 | 结果 |
| --- | --- |
| 初始 | 渲染 10 行（探针行 1–10）、`共 23 条`、页码 `[1,2,3]`、`aria-current` 在 1 |
| 点第 2 页 | 渲染 11–20、`aria-current` 在 2 |
| 点「末页」 | 渲染 21–23（3 行）、`aria-current` 在 3 |
| 点「首页」 | 回到 1–10、`aria-current` 在 1 |
| 全程 | `overflowX = 0` |

**legacy 双通道审计**（`styles.css` 101 个类选择器 ∩ 6 个页面状态 DOM 类名 139/128/125/125/111/128）= **`[]`**。

**业务数据**：仍为 **1 项目 / 2 需求 / 7 规格 / 33 任务 / 73 依赖**；全程只读（浏览器内输入仅改组件内存状态，未提交、未写入）。

**清理**：探针页 `probe.html` / `probe.ts` 与 `_probe.test.ts` 已删除；5173 / 5199 端口已释放；浏览器标签已关闭。

## 9. Known Issues

| # | 事项 | 说明 |
| --- | --- | --- |
| R1 | Input / Textarea 仍是原生元素作为语义载体 | 这是 shadcn-vue 官方的实现形态（无纯文本输入 primitive）；本阶段已把渲染路径统一到 Reka `Primitive`。若需要"真 primitive"输入，只能换成不同语义的组件（TagsInput / NumberField 等），不属于本次范围。 |
| R2 | 分页目前无业务页面启用 | 按要求「后续会用到」——接口已就绪（`:page-size` / `v-model:page`），组件测试 + 探针页已实测通过。页面启用属于页面改动，需单独授权。 |
| R3 | 分页脚计数文案为通用中文（`共 N 条`） | 不含业务语义；若需自定义，可后续加插槽（本阶段未加，避免过度设计）。 |
| R4 | 表格仍为语义 HTML | Reka 无 Table primitive，官方 shadcn-vue 亦然；强行换库（如 TanStack Table）会新增依赖并改变调用方 API。 |

## 10. Acceptance Result

**PASS** —— Input / Textarea 渲染路径接入 Reka `Primitive`、Table 内置分页（Reka Pagination）、
四道门禁全绿（28 files / 258 tests），六个页面实测无回归（含 v-model 联动实证）、
`overflowX = 0`、console 0、legacy 命中 `[]`、业务数据未变、业务页面 0 diff、无新增依赖。

## 11. Next Phase Boundary（未开始事项 STOP）

- 未在其他组件继续做库化（Button/Label/Separator/Checkbox/Select/Table/Input/Textarea 之外无改动）。
- 未在业务页面启用分页（`page-size` 未加到任何页面）。
- 未接入 Dialog / AlertDialog / Tabs / Tooltip / Popover（仍为不存在状态）。
- 未修改任何页面布局、API、Store、Router、ViewModel、SSE/Polling。
