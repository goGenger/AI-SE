# 139 · W7 表格与数据展示规范（实施记录）

**阶段**：W7（对应审评文档 P7）
**日期**：2026-10-14
**前置**：[132-web-frontend-remediation-plan.md](132-web-frontend-remediation-plan.md)（计划 §W7）、[137-phase-w5-page-skeleton.md](137-phase-w5-page-skeleton.md)（W5）、[138-phase-w6-dashboard.md](138-phase-w6-dashboard.md)（W6）
**性质**：组件契约 + 展示层改造。**未改任何 store 方法、未改 api、未新增后端契约、未改接口分页语义（仍是纯前端切片）。**

---

## 一、目标与结果

**目标（来自审评 P7）**：「随便打开一个列表页，能不能不移动眼球就把一列名称从头扫到尾？」

改造前不能 —— `Table.vue` 的每个单元格都是 `text-center`，每一行的左边缘都在飘。

| 指标 | 改造前 | 改造后 |
| --- | --- | --- |
| 单元格对齐 | 全表 `text-center` | **默认左对齐**；`align:"right"` 的列右对齐 + 自动 `tabular-nums` |
| 表头排序 | 无 | **三态可点排序**（升序 → 降序 → 取消）+ `aria-sort` |
| 分页 | `pageSize` 默认 `0`，5 个页面各自显式传 `:page-size="10"` | **默认 10**；只有 `DashboardView` 摘要表显式传 `0` |
| `AgentRunView` 列数 | 7 列平铺在 `min-w-275`（1100px） | **5 列**，`min-w-240`（960px） |
| 「复制 ID」 | 操作列里的第三个平级按钮（2 处） | **ID 文本本身可点复制**（`CopyableId`），不占按钮位 |
| 截断的文本 | 4 处中 1 处带 `title` | **4 处全部带 `title`**（机器可查） |
| 生产代码原生 `<button>` | — | 新增 2 处，均显式关掉 UA 外观（见 §六） |
| 测试 | 381（32 文件） | **412（34 文件）**（+31） |
| CSS 产物 | 26.88 kB | **27.34 kB**（+0.46，新增排序指示图标与 `CopyableId`） |

---

## 二、列对齐：默认左，只有数字/时间/操作靠右

`Table.vue` 里字面量写死两张映射（Tailwind 只认字面量）：

```ts
const ALIGN_HEAD = { left: "text-left", right: "text-right" };
const ALIGN_CELL = { left: "text-left", right: "text-right tabular-nums" };
```

- **`text-center` 已从组件里移除**（浏览器实测：`table th, table td` 中居中单元格数为 0）。
- `align: "right"` 同时给出 `tabular-nums`，所以调用方不必再叠加 —— §1 要求的「数字列必须等宽」现在是默认行为，不是纪律要求。
- 状态徽标列走 `left`，与文本列共用同一条左边缘。
- **页面里不允许再写对齐**：`cellClass` 只用于列宽，写对齐会同时丢掉自动等宽数字。

**一处刻意的例外**：工作流列表的「进度 3 / 5 · 用时 2 分」**左对齐**。它是一句话而不是一列数字；右对齐只会让两行参差。判据是「这个单元格是不是一个可比较的数值」，不是「里面有没有数字」。

---

## 三、表头排序

`sortable: true` 的列，表头变成 `<button>`，三态循环，并输出 `aria-sort`（`none` / `ascending` / `descending`）。

逻辑下沉到 `components/ui/table/sort.ts`（纯函数，与组件同目录 —— 它是组件库实现细节，不依赖任何业务枚举，所以不进 `viewmodels/`）：

| 函数 | 职责 |
| --- | --- |
| `nextSortState` | 三态机；换列直接进入该列升序，不继承上一列方向 |
| `compareValues` | 两边都是数字按数值；其余 `localeCompare(…, "zh-Hans-CN", { numeric: true })` |
| `sortRows` | 稳定排序；**空值恒在末尾**（不随升降序翻转）；`accessors` 覆盖嵌套字段取值 |

「空值恒在末尾」是个刻意的选择：否则降序时一整列空白会顶到最上面，看起来像排序坏了。

**哪些列开了排序**（能帮人**找一行**的列）：

| 页面 | 可排序列 |
| --- | --- |
| 项目 | 项目名称 / 状态 / 创建时间 |
| 需求 | 标题 / 状态 / 创建时间 |
| 工作流 | 状态 / 需求 / 项目 / 进度（按 `taskProgress.completed`）/ 更新时间 |
| Agent 运行 | 状态 / 任务 / 尝试 · 用时（按实际耗时毫秒） |
| Agent 注册表 | 名称 / 类型 / 状态 |
| 仪表盘摘要表 | **均不可排**（固定 5 条的「最近」摘要，重排它没有意义） |

「描述」这类长文本列**不开** —— 开了没人点。**状态列按枚举字符串排序**，即按字母序把同状态的聚在一起，**不是**业务优先级；要按优先级排就得在 viewmodel 里定义 rank 映射，当前没做（见 §七 Known Issues 2）。

---

## 四、分页默认打开

`Table` 的 `pageSize` 默认值由 `0` 改为 `10`。5 个列表页删掉了 `:page-size="10"`，其中 `AgentsView` / `ProjectsView` / `AgentRunView` 连 `v-model:page` 与本地 `listPage` 一并删掉（它们从来没在别处用过这个 ref）；`RequirementsView` / `WorkflowsView` 保留，因为它们在切筛选时要回到第 1 页。

**唯一需要显式传参的地方**是 `DashboardView` 的「最近工作流」摘要表：`:page-size="0"`。这是 W6 阶段就预告过的冲突（[138](138-phase-w6-dashboard.md) Next Phase Boundary），已按预期处理 —— 摘要表不是列表页。

接口契约未动：分页仍是 `Table` 内的纯前端切片。

---

## 五、`AgentRunView` 7 列 → 5 列

| 改造前 | 改造后 |
| --- | --- |
| 状态 / 任务 / Agent / 项目 / 工作流 / 尝试 · 用时 / 操作 | 状态 / **任务** / **来源** / 尝试 · 用时 / 操作 |

- **Agent 与项目**并进「任务」列的次行 —— 它们是同一条运行的执行上下文，不该各占一列。
- **工作流 + 任务键**合并为「来源」列。
- 主列只剩一个可扫的名字（`任务`），`min-w-275`(1100px) → `min-w-240`(960px)。
- **操作列从 3 个平级按钮降到 2 个**：详情 +（仅活动运行的）取消。

计划原文写的是「操作列收敛为「主操作 + 一个更多菜单」」。**未采用菜单**，理由：删掉「复制 ID」后操作列最多只剩 2 个按钮（且第二个是条件渲染的破坏性操作），为 1 个条目再套一层下拉菜单是增加点击成本而不是减少。这是对计划的一处**有意偏离**，在此登记。

---

## 六、两处新增原生 `<button>` 踩到的既有坑（重要）

**`apps/web` 不含 Tailwind preflight**（`app.css` 只导入 `theme.css` + `utilities.css`，见该文件头，是 W2 的有意决定）。因此直接写 `<button>` 会带上浏览器的默认外观：`2px outset` 边框、`#efefef` 底色、`1px 6px` 内距。

浏览器实测第一版就是这个样子 —— 排序表头渲染成了三个带边框的灰色小按钮（截图确认）。`components/ui/` 下的既有组件（Button / Pagination / Checkbox）一直靠 `appearance-none` 自己规避，新写的两处照做了：

```html
class="cursor-pointer appearance-none border-0 bg-transparent p-0 text-inherit"
```

并补了两条**护栏测试**钉住（`uiComponents` 的排序表头、`commonComponents` 的 `CopyableId`），README §0 新增一节说明这个坑。

> 这一条是 W7 才发现并记录下来的：它不属于表格问题，而是「不用 preflight」这个全局决定的一个未登记代价。

---

## 七、未采用的能力（计划 §W7 工作项 2 的其余四项 + 工作项 6）

计划写的是「**按优先级**补能力」，即在候选清单里按价值取。W7 逐个评估后**只做了排序**，其余四项明确不做并给出理由：

| 能力 | 结论 | 理由 |
| --- | --- | --- |
| 点击表头排序 | **做** | 见 §三 |
| 固定表头 | 不做 | 每页钉在 10 行 ⇒ 表格高度有上界（约 560px + 表头 + 页脚），低于常见视口。真要做 sticky，外层横向滚动容器必须同时给出纵向高度上限，等于在页面里再套一个内部滚动区 —— 为「表头已经在屏幕里」这个几乎不发生的场景多一层滚动，不划算 |
| 行选择 + 批量操作 | 不做 | 全站**没有任何批量操作**可以施加于选中行。加一列勾选框而没有可用动作，就是 W4 拒绝的「顶栏放假的通知铃铛」，也是 W5 拒绝的「点不动的工具行」 |
| 列显示 / 隐藏 | 不做 | 最宽的列表页只有 6 列（Agent 运行已降到 5 列），没有任何一列需要默认藏起来 |
| 每页条数切换 | 不做 | W5 已裁定（README §14），本次维持 |
| 虚拟滚动（工作项 6 要求给结论） | **不需要** | 见下 |

**虚拟滚动的结论**：渲染行数由分页钉死在 10 行，DOM 规模与数据总量**无关**（浏览器实测：12 条数据只渲染 10 个 `<tr>`）。**什么规模才需要**：如果将来出现「不分页且可能上万行」的表（例如日志流视图），或把每页条数提到 100+。届时先考虑继续调分页，而不是引入虚拟滚动。

---

## 八、长文本规则（工作项 5）

| 策略 | 用在哪 | 写法 |
| --- | --- | --- |
| **换行** | 主标识（任务名、需求标题、项目名） | `break-words` —— 这是用户要找的东西，压成省略号等于把最重要的信息藏起来 |
| **截断** | 长度不可控的**次要**字段（仓库 URL、版本号、任务标识） | `truncate` + 给出全文的 `title` |

**硬规则：只要 `truncate` 就必须带 `title`。** 截断本身没错，截断了拿不到全文才是。

本次补齐的 3 处（`ProjectsView` 的仓库列在 W5 已补）：`AgentsView` 的运行任务标识、`ProjectDetailView` 的仓库、`DeploymentsView` 的历史行副标题。侧栏 / 顶栏 / 命令面板的 `truncate` 是导航标签，内容本来就已知，不加 `title`。

---

## 九、验证

### 9.1 门槛命令

```
typecheck ✓   lint ✓   test 412/412 ✓   build ✓
```

### 9.2 浏览器实测（真实 Chromium，Playwright 1.61 驱动 dev server + 页面内注入 fetch mock）

**27/27 通过。**

| 分组 | 检查 | 实测 |
| --- | --- | --- |
| 对齐 | 创建时间列 `text-align: right` 且 `font-variant-numeric` 含 `tabular-nums` | ✓ |
| 对齐 | 操作列右对齐；名称/描述/仓库/状态左对齐 | ✓ |
| 对齐 | `table th, table td` 中居中单元格数 | **0** |
| 分页 | 12 条数据不传任何参数 → 只渲染 10 行 + 「共 12 条」+ 页码 | ✓ |
| 分页 | 仪表盘摘要表 → 无「共 N 条」、无页码控件 | ✓ |
| 排序 | 3 个可排序表头；未排序 `aria-sort="none"` | ✓ |
| 排序 | 点「创建时间」→ 首行改变、`aria-sort="ascending"`、**全列时间单调不减** | ✓ |
| 排序 | 再点 → `descending` + 全列单调不增；第三次点 → 回到 `none` **且恢复原顺序** | ✓ |
| 复制 | 操作列无「复制」按钮；任务列 ID 文本显示前 8 位 | ✓ |
| 复制 | `aria-label` 与 `title` 给出**完整** ID | ✓ |
| 复制 | 点击后按钮变「已复制」，**剪贴板内容 === 完整 ID**，1.5s 后自动复位 | ✓ |
| 工作流 | 操作列只剩详情 + 状态主操作；需求列有可点 ID | ✓ |
| 全局 | 控制台无错误、无 pageerror | ✓ |

截图（`/tmp/w7-*.png`，临时产物，未入库）确认了：表头不再有 UA 按钮外观、右对齐列的时间戳右边缘齐平、Agent 运行列表主列扫读连贯。

### 9.3 未验证的部分（诚实说明）

- **未启动真实后端**：全部由 fetch mock 提供数据。因此「排序结果与后端返回顺序的真实交互」「分页在真实大数据量下的表现」未验证。
- **未测键盘操作表头**：表头是可聚焦的 `<button>` 且带 `focus-visible` 环，但「Tab 到表头再按 Enter 触发排序」只做了结构断言，未在浏览器里实际按键验证。
- **`format:check`**：与 W2–W6 相同，全仓不通过是基线既有状态，不在门禁内。

### 9.4 机械核对

| 检查 | 结果 |
| --- | --- |
| `Table.vue` 内 `text-center` | **0**（仅注释里提到旧版行为） |
| 显式 `page-size` 传参 | **1 处**（`DashboardView` 的 `0`） |
| `min-w-275`（1100px） | **0** |
| 真实 `<style scoped>` 块 | **1**（仍是 Deployments 的 `[data-active]`） |
| `grid-cols-[` | **7**（与 W6 相同，本阶段未动） |

---

## 十、阶段报告

### Modified Files

**新增**
- `apps/web/src/components/ui/table/sort.ts` — 排序比较器与三态机（纯函数）
- `apps/web/src/components/common/CopyableId.vue` — ID 文本本身可点复制
- `apps/web/src/composables/useCopyToClipboard.ts` — 剪贴板写入 + 短暂成功反馈（`composables/` 首次建立）
- `apps/web/src/__tests__/tableSort.test.ts`、`apps/web/src/__tests__/copyToClipboard.test.ts`
- `docs/139-phase-w7-table.md`（本文件）

**重写**
- `apps/web/src/components/ui/table/Table.vue` — 对齐映射、排序、`pageSize` 默认 10、`TableColumn<T>` 泛型化

**修改**
- `apps/web/src/components/common/index.ts` — 导出 `CopyableId`
- `apps/web/src/components/ui/table/index.ts` — 导出 `TableAlign`
- `apps/web/src/views/AgentRunView.vue` — 7 列 → 5 列、删本地复制 helper、详情页 ID 用 `CopyableId display="full"`
- `apps/web/src/views/ProjectsView.vue` / `AgentsView.vue` / `RequirementsView.vue` / `WorkflowsView.vue` / `DashboardView.vue` — 列对齐 + 排序声明 + 分页参数收敛
- `apps/web/src/views/AgentsView.vue` / `ProjectDetailView.vue` / `DeploymentsView.vue` — 截断处补 `title`
- `apps/web/src/styles/README.md` — 新增 §15「表格：对齐、排序与长文本」；§0 新增 preflight 缺失一节；§14 分页区重写
- `apps/web/src/__tests__/uiComponents.test.ts` / `commonComponents.test.ts` / `agentRunView.test.ts` / `workflowsView.test.ts`
- `docs/15-development-roadmap.md` / `docs/17-acceptance-checklist.md` / `docs/18-phase-engineering-goals.md`

### Implementation

见 §二～§八。

### Architecture Changes

**1. 对齐与排序从「每个页面各自处理」变成组件契约。** 页面现在只声明「这一列是文本还是数字、能不能排序」，不再有机会写错。`text-center` 从组件里消失，想写回来得改 `Table.vue`。

**2. `composables/` 目录首次建立。** `AGENTS.md` §5 规划的四个目录里最后一个空目录落位（`components/` 在 W5 已有内容）。判据与 §5 一致：跨组件复用的响应式逻辑放这里，剪贴板实现可注入，因此能在 Node 环境下单测。

**3. `TableColumn` 泛型化（`TableColumn<T>`）。** 之前 `columns` 不参与 `T` 的推断，`sortValue` 无法类型化。现在 6 个调用点都写 `TableColumn<行类型>`，`sortValue` 的入参有类型。

**4. 「复制 ID」从动作变成文本属性。** 一个 ID 的复制是辅助动作，不该和「详情 / 取消」并排。三种入口（工作流列表、运行列表、运行详情）收敛到一个组件；复制的始终是完整 ID。

### Dependencies

无新增 npm 依赖。新增 4 个 `@lucide/vue` 图标引用（`ArrowUp` / `ArrowDown` / `ChevronsUpDown` / `Copy`，`Check` 此前已用）。

### Tests

```
Test Files  34 passed (34)
     Tests  412 passed (412)
```

**+31 条**（381 → 412）：

| 文件 | 变化 | 覆盖 |
| --- | --- | --- |
| `tableSort.test.ts` | +16（新） | 三态机 4 条、`compareValues` 4 条、`sortRows` 6 条（含空值恒末尾、稳定性、不改入参） |
| `copyToClipboard.test.ts` | +4（新） | 成功写剪贴板、反馈超时清空、连点重置计时器、失败静默 |
| `uiComponents.test.ts` | +7 | 对齐映射、无 `text-center`、排序表头与 `aria-sort`、未点击不重排、默认每页 10 条、显式 `0` 关闭分页、表头按钮关 UA 外观 |
| `commonComponents.test.ts` | +6 | `CopyableId` 的显示/复制/属性/图标/类合并/UA 外观护栏 |
| `agentRunView.test.ts` | -0/+0 | 7 列断言改 5 列、复制断言改 `aria-label` + `title`、「复制」按钮数为 0 |
| `workflowsView.test.ts` | -0/+0 | 同上（ID 改为可点文本） |

### Lint

`eslint "src/**/*.{ts,vue}"` 通过，无输出。

### Typecheck

`pnpm --filter @ai-se/shared build && vue-tsc --noEmit` 通过，无输出。

### E2E

未运行后端 API 级 e2e（未改后端）。前端以真实 Chromium 实测替代，见 §9.2。

### Known Issues

1. **状态列按枚举字符串排序，不是业务优先级。** `FAILED` 排在 `PENDING` 前只是字母序。要按「失败优先」排就得在 viewmodel 里定义 rank 映射 —— 那是一个独立决定（会引入一份新的业务优先级定义），本阶段未做。
2. **排序状态不持久、不进 URL。** 离开页面再回来会回到默认顺序。对一个纯前端客户端排序来说是合理的默认，但如果将来要做「分享一个排好序的列表」，需要把排序状态放进 query。
3. **`Table` 的排序是「取当前页切片之前」排序**，因此翻页时顺序保持一致 —— 这点已由「切片作用于 sortedRows 之后」的顺序保证。空值恒末尾会让「先按空值排」无法实现（当前不支持）。
4. **`.taste-skill/` 目录仍在**，按计划推迟到 W10 清理。
5. **非文本对比度**（`--border` 1.17:1 / `--input` 1.54:1）未处理，等 W9。
6. **`format:check` 全仓不通过**，基线既有状态，不在门禁内。
7. **发现一处 legacy class**：`AgentsView.vue` 的 `class="agent-link …"` —— `agent-link` 不在计划 §W10 的 grep 清单里，且当前无对应 CSS 规则（死类名）。留给 W10 一并核查。
8. **Vite 依赖预构建缓存过期会导致整屏空白**（`504 Outdated Optimize Dep`）。本阶段新增 4 个图标引用**必然**触发一次。解决：停 dev server → 清 `node_modules/.vite/deps` → 重启。与代码无关。

### Acceptance Result

**通过。** 计划 §W7 的六项工作项全部有结论，四项门槛命令全绿：

```
typecheck ✓   lint ✓   test 412/412 ✓   build ✓
```

| 要求 | 结果 |
| --- | --- |
| 1. 列对齐规则落地并写进组件注释 | ✓ 见 §二；`text-center` 已从组件移除，浏览器实测居中单元格为 0 |
| 2. 按优先级补能力 + **分页默认打开** | ✓ 排序已做（§三），分页默认 10（§四）；其余四项经评估不做并给理由（§七） |
| 3. 重构 `AgentRunView` 列 | ✓ 7 → 5 列，`min-w-275` → `min-w-240`；操作列 3 → 2 个按钮（§五） |
| 4. 「复制 ID」改为 ID 文本可点复制 | ✓ `CopyableId`，hover 提示 + 复制成功三重反馈，浏览器实测剪贴板内容正确 |
| 5. 长文本规则明确 + 截断必须给全文 | ✓ 见 §八；4 处截断全部带 `title` |
| 6. 虚拟滚动给结论 | ✓ **不需要**，判据与触发条件见 §七 |
| 约束：分页仍是纯前端切片，不改接口契约 | ✓ 未改 `api/`、`stores/`、`server` |

### Next Phase Boundary（W8 · 交互容器规范）

**STOP。W7 到此为止，不自动进入 W8。**

W8 的范围（计划 §W8）：

1. 写下并落地**容器选择规则**，并给出「每个页面的每个动作该用哪种容器」的表：`Dialog` → 轻量新建/编辑（字段 ≤5、不需 URL 可分享）；`Drawer` → 查看对象详情（需与列表保持上下文对照）；独立路由页 → 复杂、多步、需 URL 可分享。
2. 按规则改造项目页（**W5 已完成**：常驻左栏 360px 表单已进 Dialog），本次复核。
3. **全站统一危险操作确认方式** —— 现在是行内二次确认（`ProjectsView`），需要确认其余危险操作是否同一套；**危险按钮一律用 danger 语义色**（当前 `ProjectsView` 的「删除」是 `variant="ghost"`）。
4. 补齐键盘与焦点行为：Esc 关闭、打开时焦点进入容器、关闭后焦点返回触发元素、模态时焦点不逃出、**Cmd/Ctrl + Enter 提交表单**。

**W8 开工前需一并处理的 W7 遗留**：`AgentRunView` 与 `WorkflowsView` 的行内主操作是「先加载再执行」的两步动作（`handleRowAction` / `handleRowCancel`），改造容器时要保证这两步的失败路径仍然不误伤错误目标。

**未开始事项（STOP）**：W8–W10 全部未开始。`.taste-skill/` 目录推迟到 W10 清理。非文本对比度推迟到 W9。

**X1 · 模型与凭据配置**（已裁定立项，排 W 线之后）：控制台内配置 LLM 模型与 API Key，**凭据必须复用既有 Secret Provider 引用，不得新增明文存储**；附带补 `WorkflowsView` 任务审批缺失的意见输入框。
