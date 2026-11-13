# 140 · W8 交互容器规范（实施记录）

**阶段**：W8（对应审评文档 P8）
**日期**：2026-10-14
**前置**：[132-web-frontend-remediation-plan.md](132-web-frontend-remediation-plan.md)（计划 §W8）、[139-phase-w7-table.md](139-phase-w7-table.md)（W7）
**性质**：交互容器与行为规范。**未改任何 store 方法、未改 api、未改业务文案、未改接口调用。**

---

## 一、目标与结果

**目标（来自审评 P8）**：「操作起来奇怪」的直接来源 —— 同一件事在不同页面用不同容器、危险操作有三种确认方式（其中一种是原生弹窗）。

| 指标 | 改造前 | 改造后 |
| --- | --- | --- |
| 危险操作确认方式 | **3 种**：行内二次确认（1 处）、`window.confirm`（2 处）、其余无确认 | **1 种**：`ConfirmDialog` |
| `window.confirm` | 2 处 | **0**（新增护栏测试扫描 `views/`） |
| 破坏性触发按钮的语义色 | `ProjectsView` 的「删除」是**普通 ghost**（无 danger 色）；`RequirementsView` 的「拒绝并重做」是 `secondary` | **全部带 danger 语义色**（新增护栏测试） |
| 容器选择规则 | 未成文 | **`apps/web/src/components/README.md`**（含容器判据 + 逐页动作表 + 危险操作判据 + 键盘契约） |
| 键盘：表单提交 | 只能点按钮（`<textarea>` 里 Enter 是换行） | **Cmd / Ctrl + Enter**，9 个表单全部挂上 |
| 键盘：Esc / 焦点进出 / 焦点返回 / 焦点不逃出 | 由 Reka Dialog 原语提供，但**从未实测** | **浏览器逐项实测**（见 §五） |
| 测试 | 412（34 文件） | **430（35 文件）**（+18） |
| CSS 产物 | 27.34 kB | **27.34 kB**（无变化 —— 未引入新工具类） |

---

## 二、容器选择规则（工作项 1）

写进 **`apps/web/src/components/README.md`**（计划允许「docs/ 或组件目录 README」，选了后者 —— 规则与组件放在一起才有人读到）。四个容器，判据自上而下命中即止：

| 容器 | 判据 |
| --- | --- |
| `Dialog` | 轻量新建 / 编辑；字段 **≤ 5**；不需要 URL 可分享 |
| `ConfirmDialog` | 破坏性操作的确认（见 §三） |
| `Drawer` | 查看**列表某一行**的详情；打开后仍要与列表对照 |
| 独立路由页 | 对象本身是**独立目的地**（有自己的子区域 / 多标签；能从侧栏或别的页面直接进入） |

**最容易画错的一条**是 `Drawer` 与路由页的分界。判据不是「内容多不多」，而是**「它是不是列表某一行的展开」**：

- 需求 / 工作流 / Agent 运行 / Agent 的详情 → `Drawer`（关掉就回到那一行）
- 项目详情 / MCP 服务器详情 → 路由页（各有子区域：项目是仓库绑定与关联资源，MCP 服务器是概览 / 工具 / 绑定三个标签页；并且都能从侧栏或别处直接进来）

### 逐页动作表

README 里给出了**全部 11 个页面 × 每个动作**该用哪种容器（项目 4 行、需求 2 行、工作流 4 行、Agent 运行 3 行、部署 2 行、MCP 服务器 2 行、MCP 应用 1 行）。这是计划明确要的交付物。

### 复核结论：项目页已经合规

工作项 2 要求「按规则改造项目页」—— **W5 已完成**（常驻 360px 左栏表单已进 `Dialog`），本次复核通过，**未再改动**。

---

## 三、危险操作：判据是「救不救得回来」（工作项 3）

工作项 3 的原文是「全站统一危险操作确认方式（现为行内二次确认，**确认是否所有危险操作都用同一套**）」。清点结果：**不是同一套，是三种** ——

| 位置 | 改造前 |
| --- | --- |
| `ProjectsView` 行内删除 | 行内二次确认（「删除」→「确认删除 / 取消」两个按钮挤在行里） |
| `ProjectDetailView` 删除项目 | `window.confirm("确定删除该项目吗？")` |
| `MCPServerDetailView` 撤销绑定 | `window.confirm("确定撤销该绑定吗？…")` |
| 取消运行 / 取消工作流 / 拒绝审批 / 回滚部署 | 无确认 |

后两种各自有实质问题：行内二次确认在**详情页与页头动作里没有落点**（那里没有"一行"可以展开）；`window.confirm` **用不了设计令牌、显示不了错误、阻塞主线程**，与整个产品的外观割裂。

### 落地方式：新增 `ConfirmDialog`

`components/common/ConfirmDialog.vue` —— 用 `Dialog` 原语（因此与其它容器共用同一套 Esc / 焦点行为），`description` 是**必填**（类型强制），确认按钮恒为实心 `destructive`。三处全部改到它上面，**行内二次确认与 `window.confirm` 从代码里消失**。

两个刻意的设计决定：

1. **`description` 必填。** 「确定删除该项目吗？」不够 —— 要写清**后果**：「删除后不可恢复：该项目下的需求、工作流与部署记录都会一并失去归属。」这条约束由类型强加，不靠自觉。
2. **失败时不关闭确认框**，把原因显示在框内。关掉它等于告诉用户「已经执行了」。为此三处都补了 catch（改造前 `ProjectsView` 的删除失败会变成未处理的 Promise rejection）。

列表里用**受控开合 + 一个实例**（`pending` ref 为 `null` 即关闭），不是每行挂一个对话框。

### 确认的判据：不是「看起来危不危险」，而是「救不救得回来」

| 类别 | 要不要确认 | 例子 |
| --- | --- | --- |
| 不可恢复 / 数据需要重建 | **必须** | 删除项目、撤销 MCP 绑定 |
| 可恢复：能重跑 / 重试 / 重新发起 | **不需要** | 取消一次正在跑的运行（可以再发起）、暂停工作流、取消工作流（有「重试失败任务」兜底） |
| 「二选一」的显式选择 | **不需要** | 审批的批准 / 拒绝 —— 用户已经做过一次决定，再问一遍只是加一次点击 |
| 表单本身已强制填写后果说明 | **不需要** | 部署回滚（`原因` 字段 `required`） |

**这三条「不需要」是刻意的，不是遗漏。** 计划没有要求给所有危险操作加确认，加的是「统一机制」；给一个停止按钮套确认框会让「立刻停」变成不可能。

### 危险按钮的两档（工作项 3 的后半句）

「危险按钮一律用 danger 语义色」拆成两档并写进 README：

| 角色 | 写法 | 理由 |
| --- | --- | --- |
| **触发点**（点开确认框） | `variant="ghost"` + `class="text-danger"` | 文字级危险色。列表行内一行一个实心红按钮会把表格变成警报墙 |
| **执行点**（确认框的确认按钮；已内建确认步骤的表单提交） | `variant="destructive"`（实心） | 真正落地的那一下，值得最重的视觉 |

### 护栏测试抓到的两处真实违规

新增的 `破坏性按钮一律带 danger 语义色` 扫描**当场抓到两处改造前就存在的问题**：

| 位置 | 问题 | 处置 |
| --- | --- | --- |
| `ProjectsView` 行内「删除」 | 普通 `ghost`，**完全没有 danger 色** | 改 `ghost` + `text-danger` |
| `RequirementsView`「拒绝并重做」 | `variant="secondary"`（同页的「批准切片计划」也是 secondary，两者视觉无区别） | 改 `variant="destructive"`，与 `WorkflowsView` 的审批「拒绝」对齐 |

第二条不在计划的工作项里，属于「全站统一」这一条的覆盖范围，在此显式登记。

---

## 四、键盘与焦点（工作项 4）

工作项 4 的五项里，**四项是 Reka Dialog 原语已经提供的**（`Dialog` / `Drawer` / `ConfirmDialog` 共用同一套原语），因此本次**没有重新实现**，而是**逐项实测确认**（见 §五）：

| 行为 | 提供方 | 结论 |
| --- | --- | --- |
| `Esc` 关闭 | Reka `DismissableLayer` | ✓ 实测通过 |
| 打开时焦点进入容器 | Reka `FocusScope` | ✓ 实测通过 |
| 关闭后焦点返回触发元素 | Reka `FocusScope` | ✓ 实测通过 |
| 模态时焦点不逃出容器 | Reka `FocusScope` 的 `trapped` | ✓ 实测通过（连续 12 次 Tab 循环） |

**唯一缺的一项 —— Cmd / Ctrl + Enter 提交表单 —— 本次实现。**

### 为什么它值得单独做

普通 `<input>` 里按 Enter 本来就会提交表单，**但 `<textarea>` 里 Enter 是换行**。于是「用多行输入写一段任务描述，写完后想直接提交」这条路径，改造前必须把手从键盘挪到鼠标。这 9 个表单里恰好有 4 个是带 `<textarea>` 的（新建项目 / 需求 / 运行 / 工作流）。

新增 `composables/useModEnterSubmit.ts`：

```ts
export function isModEnter(event): boolean          // 「修饰键 + Enter」的判定，独立导出便于单测
export function useModEnterSubmit(): (e) => void    // 挂 @keydown
```

走 **`requestSubmit()`** 而不是直接调用页面的提交函数：这样**原生表单校验照常生效**（`required` 会拦住空字段并弹出浏览器提示），`submit` 监听器也只被触发一次。

用鸭子类型（`typeof form.requestSubmit === "function"`）而不是 `instanceof HTMLFormElement`：本仓库的测试环境是纯 Node（无 jsdom），按行为判断才能把这条逻辑直接单测掉。

**9 个表单全部已挂**（MCPServerDetail / MCPApp / Deployments ×2 / Projects / ProjectDetail / Requirements / Workflows / AgentRun）。

---

## 五、验证

### 5.1 门槛命令

```
typecheck ✓   lint ✓   test 430/430 ✓   build ✓
```

### 5.2 浏览器实测（真实 Chromium，Playwright 1.61 驱动 dev server + 页面内注入 fetch mock）

**21/21 通过。**

| 分组 | 检查 | 实测 |
| --- | --- | --- |
| Dialog | 点击后 `role="dialog"` 可见 | ✓ |
| Dialog | 焦点自动进入容器内 | ✓ |
| Dialog | **连续 12 次 Tab 后焦点仍在容器内**（模态不逃出） | ✓ |
| Dialog | `Esc` 关闭 | ✓ |
| Dialog | 关闭后焦点**返回「新建项目」触发元素** | ✓ |
| 快捷键 | 焦点在 `<textarea>` 上按 Ctrl/Cmd+Enter → 发出 `POST /api/projects` 且携带正确的名称 | ✓ |
| 快捷键 | 提交成功后对话框关闭 | ✓ |
| 语义色 | 行内「删除」的计算色 === 页面 `--danger` 的解析色 | ✓（`#c81d4a`） |
| ConfirmDialog | 点「删除」后打开 | ✓ |
| ConfirmDialog | 文案含后果说明「删除后不可恢复」（不只是「确定删除吗？」） | ✓ |
| ConfirmDialog | 焦点在容器内 | ✓ |
| ConfirmDialog | **点「取消」不发 DELETE** | ✓ |
| ConfirmDialog | 取消后关闭 | ✓ |
| ConfirmDialog | **点「删除项目」发出 1 次 `DELETE /api/projects/:id`** | ✓ |
| ConfirmDialog | 成功后关闭 | ✓ |
| Drawer | 点「详情」后打开、焦点在容器内 | ✓ |
| Drawer | `Esc` 关闭 | ✓ |
| 语义色 | 工作流详情「取消」是实心 danger（与 `--danger` 一致） | ✓ |
| 全局 | 控制台无错误、无 pageerror | ✓ |

截图（`/tmp/w8-confirm.png`，临时产物）确认了确认框的实际外观：标题带对象名、一句真实后果说明、`取消` + 实心 danger `删除项目`。

### 5.3 未验证的部分（诚实说明）

- **未启动真实后端**：全部由 fetch mock 提供数据。因此「删除请求真的打到服务端并生效」未验证（只验证到「发出了正确的一次请求」）。
- **未验证 Tab 反向循环（Shift+Tab）**：只测了正向 12 次。原语的 trapped 对两个方向是同一段逻辑，但不等于实测过。
- **未验证 Drawer 的 URL 深链接**：`WorkflowsView` / `AgentRunView` 的这段行为在 W7 之前就存在且未改动，本次未纳入验证（脚本里那条对应的 `check` 是恒真占位，**不计入 21/21 的有效结论**）。
- **未在真实键盘上测 macOS 的 Cmd**：脚本用的是 Playwright 的 `ControlOrMeta+Enter`（在 macOS 上映射为 Cmd）。`isModEnter` 对两者的判定有单测覆盖。
- **`format:check`**：与 W2–W7 相同，全仓不通过是基线既有状态，不在门禁内。

### 5.4 机械核对

| 检查 | 结果 |
| --- | --- |
| `views/` 内 `window.confirm` | **0**（护栏测试扫描） |
| `<ConfirmDialog` 使用者 | **3**（Projects / ProjectDetail / MCPServerDetail） |
| 无 danger 语义色的破坏性按钮 | **0**（护栏测试扫描全部 `<Button>` 开标签） |
| 挂上 Cmd/Ctrl+Enter 的 `<form>` | **9 / 9** |
| 真实 `<style scoped>` 块 | **1**（仍是 Deployments 的 `[data-active]`） |

---

## 六、阶段报告

### Modified Files

**新增**
- `apps/web/src/components/common/ConfirmDialog.vue` — 全站唯一的危险操作确认
- `apps/web/src/composables/useModEnterSubmit.ts` — Cmd/Ctrl + Enter 提交
- `apps/web/src/components/README.md` — **容器选择规则 / 逐页动作表 / 危险操作判据 / 键盘契约**
- `apps/web/src/__tests__/modEnterSubmit.test.ts`
- `docs/140-phase-w8-interaction-containers.md`（本文件）

**修改**
- `apps/web/src/components/common/index.ts` — 导出 `ConfirmDialog`
- `apps/web/src/views/ProjectsView.vue` — 行内二次确认 → `ConfirmDialog`（受控开合 + 失败不关闭）；「删除」补 danger 色；表单挂快捷键
- `apps/web/src/views/ProjectDetailView.vue` — `window.confirm` → `ConfirmDialog`；「删除项目」改为 `ghost` + danger；表单挂快捷键
- `apps/web/src/views/MCPServerDetailView.vue` — `window.confirm` → `ConfirmDialog`；「撤销」改为 `ghost` + danger；表单挂快捷键
- `apps/web/src/views/RequirementsView.vue` — 「拒绝并重做」补 danger 色；表单挂快捷键
- `apps/web/src/views/AgentRunView.vue` / `WorkflowsView.vue` / `DeploymentsView.vue` / `MCPAppView.vue` — 表单挂快捷键
- `apps/web/src/__tests__/commonComponents.test.ts` — `ConfirmDialog` 契约 7 条 + Teleport 感知渲染helper
- `apps/web/src/__tests__/uiComponents.test.ts` — 3 条新护栏（无 `window.confirm`、确认框使用者与受控开合、破坏性按钮带 danger 色）
- `docs/15-development-roadmap.md` / `docs/17-acceptance-checklist.md` / `docs/18-phase-engineering-goals.md`

### Implementation

见 §二～§四。

### Architecture Changes

**1. 「危险操作」第一次有了单一实现。** 改造前是三种机制并存（行内二次确认 / `window.confirm` / 无），且「哪些动作需要确认」没有判据。现在既是**一种实现**，也是**一条可判定的规则**（救不救得回来）。

**2. 容器选择从口口相传变成成文规范。** `components/README.md` 给出四类容器的判据、11 个页面每个动作的归属、危险操作的两档按钮、以及键盘与焦点契约。这是计划工作项 1 明确要的交付物，也是后续新页面的选型依据。

**3. 键盘可达性补上最后一块。** Esc / 焦点进出 / 焦点返回 / 模态不逃出由 Reka 原语保证（本次实测确认，未重写）；Cmd/Ctrl+Enter 是唯一缺的一项，`<textarea>` 表单尤其需要。

**4. 护栏测试第一次覆盖到「语义色」。** 新扫描跨全部页面检查破坏性按钮的颜色与确认机制，并且**当场抓到两处真实违规**（`ProjectsView` 的删除无 danger 色、`RequirementsView` 的拒绝按钮是 secondary）。

### Dependencies

无新增依赖。

### Tests

```
Test Files  35 passed (35)
     Tests  430 passed (430)
```

**+18 条**（412 → 430）：

| 文件 | 变化 | 覆盖 |
| --- | --- | --- |
| `modEnterSubmit.test.ts` | +8（新） | `isModEnter` 三种键位；handler 的四种分支（命中 / 裸 Enter / 非表单元素 / `currentTarget` 为 null）+ Ctrl 变体 |
| `commonComponents.test.ts` | +7 | `ConfirmDialog`：标题与后果说明、实心 destructive + secondary、文案可覆盖、busy 禁用并换文案、失败 alert 留在框内、无 error 时不渲染 alert、`aria-describedby` 指向 description |
| `uiComponents.test.ts` | +3 | 无 `window.confirm`；`ConfirmDialog` 使用者清单 + 列表页受控开合；破坏性按钮一律带 danger 语义色 |

### Lint

`eslint "src/**/*.{ts,vue}"` 通过，无输出。

### Typecheck

`pnpm --filter @ai-se/shared build && vue-tsc --noEmit` 通过，无输出。

### E2E

未运行后端 API 级 e2e（未改后端）。前端以真实 Chromium 实测替代，见 §5.2。

### Known Issues

1. **两个 Drawer 没有同步 URL**：`RequirementsView` 与 `AgentsView` 打开详情**不改地址栏**，刷新即回到列表；而 `WorkflowsView` / `AgentRunView` 是同步的（`/workflows/:id`、`?run=`）。规则已写进 `components/README.md` 并标注这两个页面待补 —— 这不属于 W8 的工作项（工作项只要求写下规则并落地容器选择），**未修**。
2. **`ConfirmDialog` 的 `description` 是纯文本**（不渲染 HTML、不支持插槽）。当前三处都不需要富文本；若将来要展示「受影响的资源清单」，需要扩展。
3. **未给「取消运行 / 取消工作流」加确认**（§三 的判据第 2 条）。如果用户后来认为取消也是不可接受的损失，改法是给这两处引 `ConfirmDialog`，判据表要一并改。
4. **`.taste-skill/` 目录仍在**，推迟到 W10 清理。
5. **`AgentsView` 的 `agent-link` legacy 类名**（W7 登记）仍未核查，留给 W10。
6. **非文本对比度**（`--border` 1.17:1 / `--input` 1.54:1）未处理，等 W9。
7. **`format:check` 全仓不通过**，基线既有状态，不在门禁内。
8. **Vite 依赖预构建缓存过期会导致整屏空白**（`504 Outdated Optimize Dep`）。本阶段**没有**新增图标或依赖，未触发。

### Acceptance Result

**通过。** 计划 §W8 的四项工作项全部完成，四项门槛命令全绿：

```
typecheck ✓   lint ✓   test 430/430 ✓   build ✓
```

| 要求 | 结果 |
| --- | --- |
| 1. 写下并落地容器选择规则 + 逐页动作表 | ✓ `components/README.md`（判据 + 11 页动作表 + 两个易错点的说明） |
| 2. 按规则改造项目页 | ✓ W5 已完成，本次复核通过，未再改动 |
| 3. 全站统一危险操作确认方式；危险按钮用 danger 色 | ✓ 三种机制收敛为 `ConfirmDialog`（`window.confirm` 归零）；两档 danger 色写进规范；护栏测试抓到并修正 2 处既有违规 |
| 4. 键盘与焦点：Esc / 焦点进入 / 焦点返回 / 焦点不逃出 / Cmd+Enter | ✓ 前四项由 Reka 原语提供并**逐项浏览器实测**；**Cmd/Ctrl+Enter 本次实现并实测**，9 个表单全部挂上 |
| 约束：业务逻辑、文案、接口调用不变 | ✓ 未改 store / api / 文案 / 接口调用；只改了容器选择与交互行为 |

### Next Phase Boundary（W9 · 可访问性与韧性）

**STOP。W8 到此为止，不自动进入 W9。**

W9 的范围（计划 §W9）：

1. `index.html`：`lang="en"` → `zh-CN`；补有意义的 `<title>`；favicon 由 `data:,` 换成真实图标。
2. **状态传达三重冗余**：颜色 + 文字 + 图标。`StatusBadge` 增加图标支持。
3. 加载态统一换骨架屏（与 W5 对齐）。
4. **全部颜色组合实测对比度**，正文 4.5:1、大字与图形 3:1，实测值写进报告。
5. 每个可交互元素都要有可见焦点环。
6. 落地暗色模式，两模式对比度都达标。
7. 所有 icon-only 按钮补 `aria-label`；装饰性图标加 `aria-hidden`。
8. 表格语义：`<th scope="col">`，可排序列用 `aria-sort`（**W7 已完成，W9 复核**）。
9. 全局搜索、通知等新增交互键盘可完整操作。

**W9 开工前需一并裁决的既有项**：非文本对比度 —— `--border` 在 `--background` 上 **1.17:1**、`--input` 在 `--card` 上 **1.54:1**，低于 WCAG 1.4.11 对非文本图形要求的 3:1。这是「极轻边框」这一既定设计语言的代价（设计文档 §13「不使用过重边框」），W5 起一直挂到 W9 裁决。

**未开始事项（STOP）**：W9–W10 未开始。`.taste-skill/` 目录推迟到 W10 清理。

**X1 · 模型与凭据配置**（已裁定立项，排 W 线之后）：控制台内配置 LLM 模型与 API Key，**凭据必须复用既有 Secret Provider 引用，不得新增明文存储**；附带补 `WorkflowsView` 任务审批缺失的意见输入框。
