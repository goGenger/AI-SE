# 前端组件与交互容器规范

本目录（`apps/web/src/components/`）是**跨页面复用 UI 的唯一来源**。新写交互前先在这里选容器；本文没写的组合就是需要先讨论的，不要就地发明第三种。

- 视觉与令牌：`../styles/README.md`
- 页面骨架与四种状态：`../styles/README.md` §14
- 表格规范：`../styles/README.md` §15

---

## 1 · 三层结构

```
components/ui       shadcn-vue 镜像的原语（Button / Dialog / Drawer / Table / Select / Checkbox / …）
components/common   AI-SE 语义组件（PageHeader / StatusBadge / EmptyState / ConfirmDialog / CopyableId / …）
components/layout   AppShell 的三块（AppSidebar / AppHeader / CommandPalette）
```

依赖方向单向：`layout` 与页面可以引用 `common` 与 `ui`；`common` 可以引用 `ui`；**`ui` 不引用任何上层**。`ui` 里的单字命名（`Button` / `Card`）是 shadcn 镜像，不要改名；`common` / `layout` 用多词 PascalCase。

**判据**：能被两个以上页面以同一形态复用的 UI 片段才进本目录。只被一处用到的结构留在页面里 —— 提前抽象会把两条不同的内容逼进同一个壳。

---

## 2 · 交互容器选择规则（W8）

同一件事在 11 个页面里必须用同一种容器。四个选择，判据如下：

| 容器 | 什么时候用 | 判据（命中即止，从上往下） |
| --- | --- | --- |
| **`Dialog`** | 轻量新建 / 编辑 | 字段 **≤ 5**；完成后回到原来那一屏；**不需要** URL 可分享 |
| **`ConfirmDialog`** | 破坏性操作的确认 | 见 §3。**全站唯一的危险确认方式** |
| **`Drawer`** | 查看**列表某一行**的详情 | 打开后仍要与列表对照；不需要深链接（若需要，把 id 同步进 URL，见下） |
| **独立路由页** | 对象本身是**独立目的地** | 有自己的子区域 / 多段内容（如多标签页）；或能从侧栏、别的页面直接进来 |

### `Drawer` 还是路由页？这条线画在哪

这是唯一容易画错的一条。判据是**「它是不是列表某一行的展开」**，不是「内容多不多」：

- **需求 / 工作流 / Agent 运行 / Agent 的详情 → `Drawer`**。它们都是「点开列表里的一行」，关掉就回到那一行；列表始终在背景里。
- **项目详情 / MCP 服务器详情 → 路由页**。它们各自有子区域（项目：仓库绑定与关联资源；MCP 服务器：概览 / 工具 / 绑定三个标签页），并且是能从侧栏或别的页面**直接进入**的目的地，不是「列表某一行的展开」。

**Drawer 也要可深链接**：`WorkflowsView` / `AgentRunView` 打开详情时把 id 同步进 URL（`/workflows/:id`、`?run=`），于是刷新与前进后退都成立。**新加 Drawer 时必须照做** —— 一个打不开分享链接的详情抽屉，是这一层最常见的退步。

> **W11 已补齐（原 W8 登记的待补项）**：`RequirementsView` 的 `?requirement=` 与 `AgentsView` 的 `?agent=` 都已加上，4 个详情抽屉现在**全部**同步 URL —— 可分享、可刷新、前进后退都能正确开合。
>
> 两页的落法与另外两页一致：**URL 是唯一真源**。行内的「详情」按钮只 `router.push`，开抽屉与取数由一处 `watch(选中的 id)` 承担（再把「关抽屉 → 清掉 query」接上），因此深链接、前进后退、行内按钮走的是同一条路径，不会各写一套。
>
> `RequirementsView` 多做了一件事：`loadRequirement` 一次会扇出 6 个并行请求，所以取数收口到一个 `ensureRequirementLoaded(id)`，按 id 去重一次在途请求 —— 否则「watch(URL)」与行内「分析」会各发一遍。

### 全站的容器现状（W8 复核）

| 页面 | 动作 | 容器 |
| --- | --- | --- |
| 项目 | 新建项目 | `Dialog` |
| 项目 | 打开某一项目 | 路由页 `/projects/:id` |
| 项目详情 | 绑定仓库 | 页内表单（单字段，就地完成，套弹层只会多两次点击） |
| 项目详情 | 删除项目 | `ConfirmDialog` |
| 需求 | 新建需求 / 详情 + 分析 | `Dialog` / `Drawer` |
| 工作流 | 创建工作流 / 详情 | `Dialog` / `Drawer`（`/workflows/:id`） |
| 工作流 | 行内主操作（开始 / 暂停 / 继续 / 重试失败任务） | 行内按钮（见 §3 的「不需要确认」） |
| 工作流 | 审批：批准 / 拒绝 | 批准是详情内一键；**拒绝走 `ConfirmDialog`**（W12 起，在其中收集修改意见，见 §3） |
| Agent 运行 | 新建运行 / 详情 | `Dialog` / `Drawer`（`?run=`） |
| Agent 运行 | 取消 | 行内按钮（可重新发起，见 §3） |
| 部署 | 环境设置 | `Dialog` |
| 部署 | 部署 / 回滚 | 主从布局右栏的页内表单 |
| MCP 服务器 | 新建绑定 | 页内表单 |
| MCP 服务器 | 撤销绑定 | `ConfirmDialog` |
| MCP 应用 | 加载应用 | 工具行表单（它是唯一能驱动数据的控件） |

---

## 3 · 危险操作：一律 `ConfirmDialog`，判据是「救不救得回来」或「要不要用户填东西」

**判据不是「看起来危不危险」，而是「这一步之后能不能救回来」。**

| 类别 | 要不要确认 | 例子 |
| --- | --- | --- |
| 不可恢复 / 数据需要重建 | **必须** `ConfirmDialog` | 删除项目、撤销 MCP 绑定 |
| 可恢复：能重跑 / 重试 / 重新发起 | **不需要** | 取消一次正在跑的 Agent 运行（可以再发起）、暂停工作流（可以继续）、取消工作流（有「重试失败任务」兜底） |
| 「二选一」的显式选择 | **不需要** | ~~审批的批准 / 拒绝~~ —— 用户已经在两个按钮之间做过一次决定，再问一遍只是加一次点击。**W12 修正**：批准仍属此类（一键不套确认框）；拒绝**不再属于**，因为它要**收集输入**（修改意见），见下一行 |
| 确认步骤要**收集用户输入** | **需要**，且输入就放在确认框里 | 审批的「拒绝」（`description` 说明后果 + 默认插槽装「修改意见」textarea）。判据不是「危不危险」，而是「这一步要用户提供信息」—— 此时确认框不是多一次点击，而是**输入的唯一落点** |
| 表单本身已经强制填写后果说明 | **不需要** | 部署回滚（`原因` 字段 `required`）—— 写下原因比点一下「确定」是更重的人为步骤 |

**同一件事只确认一次。** 不要「确认框里的确认按钮再弹一个确认框」。

### `ConfirmDialog` 的强制项

`description` 是**必填**（由类型强加，不靠自觉）。「确定删除该项目吗？」不够 —— 要写清**后果**：「删除后不可恢复：该项目下的需求、工作流与部署记录都会一并失去归属。」

失败时**不关闭确认框**，把原因显示在框内（`error` prop）。关掉它等于告诉用户「已经执行了」。

**W12 补充两条：**

1. **确认框可以作为「收集输入」的容器**（`ConfirmDialog` 有默认插槽）。第一个这样的用法是审批的「拒绝」：框内放「修改意见」textarea，提交后随决定一起落库。
2. **取消按钮的文案看上下文，默认的「取消」不总是对的。** 拒绝审批的确认框把 `cancel-label` 改成了**「关闭」** —— 因为工作流页自己就有一个名叫「取消」的生命周期动作，而审批卡与它**在同一个抽屉里同时可见**；跳出来的确认框再出现一个「取消」，会让「取消什么」变歧义。
   > 这不是风格偏好：本页原有的护栏（终态不得渲染生命周期按钮）在改动落地的第一时间就因为新按钮撞名而失败 —— **护栏失败本身就是这个歧义的证据**。改文案后护栏保持原样。

```html
<ConfirmDialog
  :open="pending !== null"
  title="删除该项目"
  description="删除后不可恢复：…"
  confirm-label="删除项目"
  busy-label="删除中…"
  :busy="deleting"
  :error="deleteError"
  @update:open="(open) => (pending = open ? pending : null)"
  @confirm="remove"
/>
```

列表里用**受控开合 + 一个实例**（`pending` ref 为 `null` 即关闭），不要每行挂一个对话框。

### 危险按钮的两档

**触发点**（点开确认框的那个按钮）与**执行点**（确认框里的确认按钮、或已内建确认步骤的表单提交）视觉不同：

| 角色 | 写法 | 理由 |
| --- | --- | --- |
| 触发点 | `variant="ghost"` + `class="text-danger"` | 文字级危险色。列表行内一行一个实心红按钮会把表格变成警报墙 |
| 执行点 | `variant="destructive"`（实心） | 真正落地的那一下，值得最重的视觉 |

**没有任何一个破坏性按钮可以不是 danger 语义色。**

---

## 4 · 键盘与焦点契约

四个容器（`Dialog` / `Drawer` / `ConfirmDialog`，以及路由页）共用同一套 Reka Dialog 原语，因此下面这些是**组件提供的**，页面不必重复实现：

| 行为 | 提供方 |
| --- | --- |
| `Esc` 关闭 | Reka `DismissableLayer` |
| 打开时焦点进入容器 | Reka `FocusScope`（自动聚焦第一个可聚焦元素） |
| 关闭后焦点返回触发元素 | Reka `FocusScope`（记录并恢复） |
| 模态时焦点不逃出容器 | Reka `FocusScope` 的 `trapped` |
| 点击遮罩关闭 | Reka `DismissableLayer` |

**页面要负责的只有一件**：表单的 **Cmd / Ctrl + Enter 提交**。

```ts
import { useModEnterSubmit } from "../composables/useModEnterSubmit";

const onFormKeydown = useModEnterSubmit();
```

```html
<form
  class="grid gap-4"
  @submit.prevent="submit"
  @keydown="onFormKeydown"
>
```

为什么需要：普通 `<input>` 里按 Enter 本来就会提交，但 **`<textarea>` 里 Enter 是换行** —— 「写一段任务描述然后直接提交」这条路径，没有这个绑定就得把手挪到鼠标。走 `requestSubmit()` 而非直接调用提交函数，因此原生校验（`required`）照常生效。

**每个 `<form>` 都要挂。** 当前 9 个表单全部已挂（W8）。

### 焦点环

所有可交互元素统一用 `styles/README.md` §7 的那一档（`focus-visible:ring-2 focus-visible:ring-ring`）。**不要发明第二种焦点样式。**
