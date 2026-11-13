# Phase 12-C — 组件库化（Table / Select / Checkbox）+ 操作左 / 展示右

> 触发：用户指出「所有原生组件都要替换成组件库的，比如新封装一个 table 替代原生 table，新增一个下拉选择组件」，
> 并要求「项目展示页面把新建项目放在左侧、项目列表放在右侧；需求页面的需求列表和新建需求上下位置互换；
> 后面的都保证操作内容在左侧，展示在右侧」。
>
> 本阶段是该指示的落地阶段（承接 Phase 12-B）。**未进入 Phase 13。**

---

## 1. 目标

1. 把业务页面里**直接书写的原生表单/表格控件标记**收编到 `components/ui`：
   - 新封装 `Table`（替代原生 `<table>` 标记）
   - 新增 `Select`（下拉选择组件）
   - 新增 `Checkbox`（复选框组件，覆盖「所有原生组件」的剩余部分）
2. 版式统一为 **操作在左 / 展示在右**：
   - `/projects`：新建项目移到左侧，项目列表移到右侧
   - `/requirements`：左栏「新建需求」与「需求列表」上下互换（表单在上）
   - 其余页面按同一约定审计

---

## 2. 改动文件

**新增（组件库，3 个）**

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `src/components/ui/table/Table.vue` | 109 | 语义表格组件：`columns` + `rows` + `#cell-<key>` 列插槽 + 无插槽时的字段回退；外层自带 `overflow-x-auto`；`min-width` 由调用方以 Tailwind 类传入 |
| `src/components/ui/table/index.ts` | 1 | 导出 `Table` / `TableColumn` |
| `src/components/ui/select/Select.vue` | 71 | 下拉选择组件：`options: SelectOption[]` + `v-model`（泛型 `V extends string`）；原生属性（`id` / `required` / `aria-*`）透传 |
| `src/components/ui/select/index.ts` | 1 | 导出 `Select` / `SelectOption` |
| `src/components/ui/checkbox/Checkbox.vue` | 48 | 复选框组件：`v-model: boolean`，选中色 `accent-color: var(--primary)` |
| `src/components/ui/checkbox/index.ts` | 1 | 导出 `Checkbox` |

**修改（页面 6 个）**

| 文件 | 变化 |
| --- | --- |
| `views/ProjectsView.vue` | 两栏方向互换（`[360px_minmax(0,1fr)]`：表单左、表格右）；列表改用 `Table`，页面不再书写 `<table>/<thead>/<tr>/<th>/<td>` |
| `views/RequirementsView.vue` | 左栏「新建需求」上移、「需求列表」下移；原生 `<select>` → `Select`（`projectOptions` computed）；删除 `.requirement-select` scoped 样式 |
| `views/DeploymentsView.vue` | 2 处原生 `<select>` → `Select`（`projectOptions` / `environmentOptions`）；删除 `.deployment-select` scoped 样式 |
| `views/WorkflowsView.vue` | 3 处原生 `<select>` → `Select`（项目 / 需求 / 失败策略）；原生 checkbox → `Checkbox`；删除 `.workflow-select` scoped 样式 |
| `views/MCPServerDetailView.vue` | 绑定表单的原生 checkbox → `Checkbox`（`<datalist>` 保留，见 §7） |
| `views/DashboardView.vue` | 「我的项目」表改用 `Table`（`cellClass: "py-4"` 保持 9.5-B 的 55px 行高） |

**测试（3 个）**

| 文件 | 变化 |
| --- | --- |
| `__tests__/uiComponents.test.ts` | +18 例：`Table`(6) / `Select`(4) / `Checkbox`(2) + **组件库化护栏**(3) + 新增 `Table` 类型断言辅助调整 |
| `__tests__/requirementsView.test.ts` | 2 处断言随新版式更新（下拉由组件库渲染；左栏顺序反转） |
| `__tests__/projectsView.test.ts` | +3 例（两栏栅格、DOM 顺序、表格由组件库渲染） |

**未改动**：`api/*`、`stores/*`、`viewmodels/*`、`router/index.ts`、`components/layout/*`、`components/common/*`、`styles/app.css`、**`styles.css`（mtime 仍为 11:41）**、`package.json`（**未新增依赖**，`reka-ui` 保持未使用）。

---

## 3. 组件库新增件的契约

### 3.1 `Table`

```vue
<Table :columns="projectColumns" :rows="projects" :row-key="(row) => row.id" min-width="min-w-[640px]">
  <template #cell-name="{ row }"> … </template>
</Table>
```

- 渲染 `<table>` + `<thead>` + `<th scope="col">` + `<tbody>` + `<tr>/<td>`：语义结构不变，**只是把标记从页面搬进组件**。
- 列定义 `{ key, label, headClass?, cellClass? }`；插槽名 `cell-<key>`；无插槽时回退为 `String(row[key])`。
- 行/表头视觉为组件内默认：表头 `text-caption text-muted-foreground`、行 `border-b border-border last:border-b-0 hover:bg-muted`、单元格 `py-3`（可被 `cellClass` 覆盖）。
- 泛型 `generic="T extends object"`：`rows` 与插槽 `row` 类型随调用方推断（页面侧保持类型安全）。
- 空 `rows` 仍渲染表头；业务上的空态仍由页面用 `EmptyState` 短路（不变）。

### 3.2 `Select`

```vue
<Select id="deployment-project" v-model="projectId" :options="projectOptions" required />
```

- **实现载体是原生 `<select>`**（有意为之）：5 处业务下拉都依赖原生表单语义（`required` 参与原生校验、`<label for>` 关联、键盘/移动端原生选择器）。
  组件把**用法与外观**收敛：调用方只传 `options`，页面不再出现 `<select>/<option>` 标记。
- 未使用 `appearance-none`：保留系统下拉箭头（与迁移前视觉一致），避免额外绘制箭头图标。
- 泛型 `V extends string`：`DeliveryEnvironment`、`WorkflowFailureStrategy` 这类字符串联合类型可直接 `v-model`，无需在页面里做类型断言。

### 3.3 `Checkbox`

- 原生 checkbox 语义 + `accent-color: var(--primary)`（实测 `rgb(108, 92, 231)`）。未使用 `appearance:none`（会丢失勾选图形）。
- 因未启用 Preflight，组件内显式补 `box-sizing` / `margin: 0` 兜底。

---

## 4. 版式变化（操作左 / 展示右）

### `/projects`

| | 改动前（11-B） | 改动后（12-C） |
| --- | --- | --- |
| 栅格 | `min-[900px]:grid-cols-[1fr_360px]` | **`min-[900px]:grid-cols-[360px_minmax(0,1fr)]`** |
| 左栏 | 项目列表 | **新建项目表单（360px）** |
| 右栏 | 新建项目表单（360px） | **项目列表** |
| 行高 | 57px | 57px（不变） |
| @1280 实测 | 列表 x=184 w=692 / 表单 x=892 | 表单 x=184 w=360 / 列表 x=568 w=692（两卡顶边齐平 y=150） |

### `/requirements`

| | 改动前（12-B） | 改动后（12-C） |
| --- | --- | --- |
| 左栏顺序 | 需求列表 → 新建需求 | **新建需求（y=150 h=576）→ 需求列表（y=742 h=301）** |
| 下拉 | 原生 `<select class="requirement-select">` | 组件库 `Select`（宽 318 / 高 36 / 圆角 10px，与迁移前一致） |

### 其余页面审计（同一约定）

| 页面 | 左栏 | 右栏 | 结论 |
| --- | --- | --- | --- |
| `/workflows` | 创建工作流表单 + 工作流列表（`[320px_1fr]`） | 工作流详情 | ✅ 操作在左且表单在列表之上 |
| `/deployments` | 环境表单（`[320px_1fr]`） | 部署历史 / 详情 | ✅ 操作在左 |
| `/agent-run` | 新建运行 + 运行列表（`[360px_1fr]`） | 运行详情 | ✅ 操作在左且表单在列表之上 |
| `/agents` | Agent 注册表 | Agent 详情 | ⚪ 页面无操作块（展示 / 展示），约定不适用 |
| `/mcp` | 服务器卡片列表 | — | ⚪ 无操作块 |
| `/mcp/:id` | — | 创建绑定表单在「绑定」Tab 面板内 | ⚠️ 见 §7 待裁定 |
| `/` | Hero（CTA 在 Hero 右侧）+ KPI + 表格 | — | ⚠️ 见 §7 待裁定 |
| 详情页头 actions（`/projects/:id` 删除、`/requirements` 分析） | 页头右侧 | — | ⚪ 按「页头 actions」语义处理，未移动 |

---

## 5. 业务冻结确认

- **API / Store / Router / ViewModel 零改动**（mtime 核对：`api/*`、`stores/*`、`viewmodels/*`、`router/index.ts` 均未触碰）。
- **未新增数据获取**：仍为各页既有 GET/POST；`Table` / `Select` / `Checkbox` 均**不请求 API、不读 Store、不写业务文案**（`Table` 的列 label、`Select` 的 options 全部由页面传入）。
- **未新增依赖、未新增 Token**：复用既有 93 条 Token 与既有 `cva` / `cn()` 基建；`package.json` 未改。
- 真实交互回归（真实后端 + 真实数据，只读）：
  - `/workflows` 选中项目 → 需求下拉级联加载真实 ANALYZED 需求「Todo 管理系统」（`change` → store watch 生效）。
  - `/requirements` 清空项目 → 「创建」按钮 → `disabled=true`；重新选中 → `disabled=false`。
  - `/projects` 创建流程（**请求级替身，不落库**）：POST 载荷 `{"name":"临时校验","description":"替身","repository":"https://github.com/example/x"}`（trim 生效）→ 成功后表单清空 → 列表内存头插 1 行。
- **未创建/修改真实业务数据**：复核后 `GET /api/projects` 仍为 **1 条（Mini Todo）**；Requirements 页面实测仍为 **2 需求 / 7 规格 / 33 任务 / 73 依赖**。
- 未点击真实「分析」按钮；`window.confirm` 语义未动；`<datalist>` 输入语义保留。

---

## 6. 测试与门禁

| 门禁 | 结果 |
| --- | --- |
| `typecheck` | ✅ PASS |
| `lint` | ✅ PASS |
| `test` | ✅ **28 files / 239 tests**（221 → 239，+18） |
| `build` | ✅ `index-ZB5041CO.css` **39.61 kB** / `index-D3NwIzHY.js` **343.21 kB**（CSS 减小：两页 scoped 下拉样式收敛进组件；JS +0.87 kB：3 个新组件） |

新增护栏（`uiComponents.test.ts`）：

1. 语义结构（`table/thead/th[scope=col]/tbody/tr`、`overflow-x-auto`、`min-w-[640px]`）。
2. 列插槽优先、无插槽回退字段文本。
3. `Select` 选项渲染 / 原生属性透传（`id`/`required`/`aria-label`）/ 不抹除系统箭头。
4. `Checkbox` 原生语义 + Token 选中色。
5. **组件库化护栏（源码级）**：`src/views/*.vue` 剥离注释后不得出现 `<select` / `<table` / `<input type="checkbox"`；并断言 `Table` 仅被 Dashboard / Projects 使用、`Select` 仅被 Deployments / Requirements / Workflows 使用。

---

## 7. 遗留与待裁定

| # | 事项 | 现状 |
| --- | --- | --- |
| R1 | **`<datalist>`（MCP 绑定表单的项目字段）** | 保留原生：它是「自由文本 + 建议值」，换成 `Select` 会改变输入语义（可输入任意 UUID）。Phase 10-A 已裁定，本阶段沿用。 |
| R2 | **`window.confirm`（删除确认）** | 保留（非原生表单控件；替换需新增 Dialog 组件与交互）。 |
| R3 | **完全自定义下拉浮层** | 现 `Select` 的下拉**浮层**仍是系统原生（只有触发器外观被 Token 化）。若需要自定义浮层（reka-ui 已在依赖中但未使用），可在 `Select.vue` 内部替换实现而不影响调用方 —— 需要授权后实施。 |
| R4 | **`/mcp/:id` 创建绑定表单位置** | 位于「绑定」Tab 面板内，「操作左 / 展示右」在 Tab 语义下不直接适用；未擅自移动。 |
| R5 | **Dashboard Hero 的「新建项目」CTA** | 位于 Hero 右侧（横幅语义）；未移动。 |
| R6 | **`views/` 之外的原生控件** | `components/ui/*` 内部本身就是原生元素的封装（`Button`→`button`、`Input`→`input`…）；`components/common/*`、`components/layout/*` 无原生表单控件。 |
| R7 | 既有全局遗留（未分层 `a` 样式、`font: inherit` 压缩排版类） | 仍在 8 个页面以 scoped 规避；根治留后续阶段。 |

---

## 8. 浏览器验证（真实后端 :3000 + 真实数据，仅 GET；替身处已注明）

- `/projects`（1280）：表单 x=184 w=360、表格 x=568 w=692、两卡 y=150 齐平；6 列（项目名称 / 描述 / 仓库 / 状态 / 创建时间 / 操作）全可见（`clientWidth 690 = scrollWidth 690`）；行高 57px；无横向溢出。
- `/projects` 响应式：**900**（两栏 360 + 312，右侧表格内滚动 640）/**899**（单列：表单 y=150、表格 y=625）/**700**（单列）→ 四档 `overflowX = 0`。
- `/requirements`：左栏顺序 = 新建需求 → 需求列表；`Select` 选项 `["选择项目","Mini Todo"]`、高 36 / 圆角 10px / 字号 14px；4 指标 = 已分析 / v1 / **7** / **33**；`<pre>` **7**；依赖容器 **73** 项且可独立滚动；PRD 可独立滚动；规格 2 列（309.5px × 2）。
- `/workflows`：3 个 `Select`（项目 2 选项 / 需求 1+级联 / 失败策略 5 项）+ 1 个 `Checkbox`（`size-4 … accent-[var(--primary)]`）。
- `/deployments`：2 个 `Select`（项目 `required` / 环境默认 `staging` 且 3 选项）。
- `/`：表格 4 列、行高 **56px**、KPI 4 卡（1 / 1 / 0 / 就绪）。
- `/mcp/<id>`（请求级替身，`{success,data}` 信封）：绑定面板「创建绑定」表单渲染；`Checkbox` 实测 `accent-color: rgb(108, 92, 231)`、16×16、checked；`<datalist id="mcp-project-options">` 保留。
- 六页 **console 0 error / 0 warning**；六页 `overflowX = 0`。
- **legacy 双通道审计**：`styles.css` 101 个类选择器 ∩ 五页 DOM 类名（139/128/145/120/108）= **`[]`**。
- 数据复核：项目 1（Mini Todo）、需求 2、规格 7、任务 33、依赖 73 —— 与本阶段开始时一致。
- 清理：CDP 注入脚本已移除、`Emulation` 已复位、浏览器标签已关闭、preview 进程已停止。

---

## 9. 结论

**PASS**

- 新封装 `Table` 替代原生 `<table>`（Dashboard / Projects）；新增 `Select` 替代 6 处原生 `<select>`（Requirements 1 / Deployments 2 / Workflows 3）；新增 `Checkbox`（Workflows / MCP 绑定各 1）。
- `/projects` 与 `/requirements` 的版式已按指示互换，其余页面按同一约定审计（§4）。
- API / Store / Router / ViewModel / CSS / 依赖 / 业务数据零改动；四道门禁全绿（28 files / 239 tests）。
- 待裁定项见 §7（R1–R5），本阶段未擅自扩大范围。
