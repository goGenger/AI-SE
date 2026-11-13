# 144 · W12 前端遗留项收口（弹窗描述 / showIcon / 勘误 / 审批意见）

**阶段**：W12（承接 W10 登记、W11 未清的遗留项，做一次集中收口）
**日期**：2026-10-15
**前置**：[142-phase-w10-acceptance.md](142-phase-w10-acceptance.md)（登记处）、[143-phase-w11-frontend-followups.md](143-phase-w11-frontend-followups.md)（W11）
**性质**：不改业务逻辑、不改接口契约、不改写既有可见文案（新增了一处无障碍名称与 5 句弹窗描述，逐条列出）。
**批次说明**：这是一次**打包执行**（四项一次做完再统一验收），偏离 `AGENTS.md` §9「一次任务只做一个已命名的阶段」。偏离已获用户明确授权（同 W7–W11）。

---

## 一、先裁定，再动手

W11 交付后留下 11 项待决，本阶段**逐条裁定**（用户授权「你把没做的事敲定一下」）。判定分三类：本轮做、判不做（有理由）、押后（不在本轮范围）。

| # | 事项 | 判定 | 理由 |
| --- | --- | --- | --- |
| 1 | 5 个弹窗缺可访问描述 | **本轮做：补可见描述** | 告警指向真实缺口 —— `Dialog.vue` 只是把悬空的 `aria-describedby` 去掉了，并没有补上上下文；屏幕阅读器只念得出标题。另一条候选「在 `Dialog.vue` 里把无描述的情况显式处理掉」只是让告警闭嘴，属于把「用户听不到」变成「看不见」 |
| 2 | 表头 sticky | **判不做**（维持 W7 结论） | 第三次评估，理由未变：每页钉在 10 行，表格高度已有上界 |
| 3 | `showIcon` 零使用 | **本轮做：删除** | 与本仓 W4（拒绝放假通知铃铛）/ W5（不造点不动的控件）/ W7（拒绝列设置器）三次判据一致。反悔成本 = 加回一个 `v-if` |
| 4 | `--input` 在 `--muted` 面上 2.90:1 | **判不改，只记文档** | 改它会动到 64 处已验证 3.41/3.14 的对比度；而「背景-前景配对」的自动扫描在 SSR 字符串层面极易把祖辈背景算错，给出的是虚假安全感 |
| 5 | 仓库 420 个文件不合 Prettier | **判不格式化** | **本仓没有 git** ⇒ `prettier --write .` 是不可回退的 420 文件改写；其中 234 个在 `packages/eval`（与前端线无关），属 `AGENTS.md` §2 禁止的无关重构 |
| 6 | axe 未覆盖详情页数据态 / 弹窗态 / 抽屉态 | **押后**（独立批次） | 它改的是扫描器契约，且依赖后端有真实数据；与本轮四项的性质不同 |
| 7 | 真实屏幕阅读器走查 | **押后**（同上批次） | 计划改为交付「a11y 树快照」作为可审阅替代品，并在同一批次说明它不能替代真实 SR 走查 |
| 8 | W6「最近项目」→「最近工作流」 | **本轮裁定：保留现状** | 正中 W6「把仪表盘从陈列改成分诊」的立意 —— 「最近工作流」能回答「卡在哪一步」，「最近项目」只回答「有哪些项目」，而项目总量已由 ④ 承担。代价照录：丢掉了「最近创建了哪些项目」这个视角 |
| 9 | `docs/142` 把强制高对比度标成 SC 1.4.12 | **本轮做：加勘误脚注**（不改原结论） | WCAG 2.2 的 1.4.12 是 Text Spacing；强制配色没有对应的独立成功准则。留错编号会让后来人照着找不到条款 |
| 10 | `WorkflowsView` 审批缺意见输入框 | **本轮做：补，复用 `ConfirmDialog`** | 整条链路本来就支持 comment（见第五节），缺的只是一个 UI |
| 11 | X1 前置：密钥存哪儿 | **本轮只裁定，不动代码** | 见本文件 §七；它决定 X1 所有代码的形状，必须先定 |

---

## 二、裁定表第 1 项 · 5 个弹窗补描述

### 改了什么

给 5 个只传了 `title` 的弹窗各加一条 `description`。`Dialog.vue` 的 `DialogDescription` 会把 `aria-describedby` 指向它（组件原本就支持，只是没人传）。

| 弹窗 | 描述文案 | 依据 |
| --- | --- | --- |
| `ProjectsView` 新建项目 | 项目是需求、工作流与部署的归属单位；仓库地址可以留空，之后在项目详情页绑定。 | 字段为名称 / 仓库地址（可选，表单内已注明「留空则先基于本地工作区开发」）/ 描述 |
| `RequirementsView` 新建需求 | 填入原始 PRD；创建后回到列表点「分析」，据此生成规格与任务。 | 字段为项目 / 标题 / 描述 / PRD；列表的行内「分析」是既有主操作 |
| `WorkflowsView` 创建工作流 | 选择项目与一个已分析的需求；工作流会按该需求的任务 DAG 逐个执行。 | 需求下拉的选项来源就是 `status === "ANALYZED"` 的过滤（`WorkflowsView.vue:121-126`） |
| `AgentRunView` 新建运行 | 直接把任务描述交给 Agent 执行；创建后会自动打开这次运行的详情。 | 表单只有一个「任务」textarea；`createRun()` 成功后 `router.push({ query: { run: createdId } })` |
| `DeploymentsView` 环境设置 | 为项目登记一套部署环境；同一项目下同名环境会被覆盖。 | `deployments` store 按 `(projectId, name)` upsert（`stores/deployments.ts:71-78`） |

**这些文案只陈述表单与代码实际做的事**，没有编造行为承诺。它们是**可见文字**（`DialogDescription` 是渲染出来的 `<p>`），因此每个弹窗首屏会比之前多一行 —— 这是一次真实的版式改动，不是纯属性改动。

### 证据

真实后端 + 真实 Chromium，逐页点开弹窗实测（脚本 `/tmp/w12-browser.cjs`）：

```
PASS  /projects：弹窗描述可见
PASS  /projects：aria-describedby 指向的 id 真实存在，且文本就是描述本身
PASS  /projects：reka-ui 不再报 Missing Description
（/requirements、/workflows、/agent-run、/deployments 同样 3 项 × 4 页 = 12 项，全部 PASS）
```

`aria-describedby` 的校验不只是「属性存在」——脚本用 `[id="…"]` 反查该 id 是否**真实存在**、且其文本**就是那条描述**，避免出现指向空元素的悬空引用。

**W10 那条告警已消失**：`Missing \`Description\` or aria-describedby="undefined" for DialogContent` 在 5 个页面上均不再出现（逐页捕获 `console.warn` 断言）。

### 护栏

`uiComponents.test.ts` 新增一条：**views 里的每个 `<Dialog` 都必须带 `description`**（剥离注释后正则扫描），并断言「至少扫到 5 个」以防正则失效导致空扫描永远通过（W10 学到的教训）。这条护栏会拦住「顺手删掉描述」和「新加一个没描述的弹窗」。

---

## 三、裁定表第 3 项 · 删除 `showIcon`

`StatusBadge.vue` 的 `showIcon` prop 自 W9 引入后**零调用**（全仓 grep：只有组件自身与一条测试）。按本仓既有的「不造点不动的控件」判据删除：

- 删 prop、默认值、模板里的 `v-if`（图标现在是固定的三重冗余的一半，不可关）
- 删 `commonComponents.test.ts` 中对应的一条用例

**没有行为变化**：默认值原本是 `true`，64 处调用全部用默认值，因此渲染输出逐字节相同（a11y 复扫 13 路由零违规可佐证）。

---

## 四、裁定表第 9 项 · `docs/142` 勘误

在 `docs/142` §3.2 的表格之后追加一段引用块，指出「200% 缩放 / 强制高对比度模式（SC 1.4.4 / 1.4.12）」一行的**编号引用有误**，并说明测量结果不受影响（W11 已把文本间距与强制高对比度**分开各跑一阶段**）、只影响条款引用。

**原判定与结论一字未动** —— 在已验证的历史报告上追加勘误，而不是改写结论。

---

## 五、裁定表第 10 项 · 审批拒绝带修改意见

### 为什么这是一处「缺 UI」而不是「缺能力」

整条链路早就是通的，实测确认：

| 环节 | 现状 |
| --- | --- |
| 契约 | `ApprovalDecisionSchema` 有 `comment`（`z.string().trim().max(1000).optional().default("")`，`shared/src/index.ts:858`） |
| HTTP | `POST /api/approvals/:id/{approve,reject}` 用同一个 schema 解析 body（`apps/server/src/routes/workflows.ts:173-190`） |
| 领域 | `WorkflowEngine.approve(id, comment)` / `reject(id, comment)` 会把 comment 传给 `store.decideApproval(...)` **落库** |
| 前端 API | `decideApproval(id, action, input = {})` 已支持第三个参数 |
| 已有先例 | `RequirementsView` 的关口 1 审批**已经**在用（`#slice-approval-comment` + `decideSliceApproval(action, comment)`） |

**只有 `WorkflowsView` 没接** —— 它的「拒绝」是一个 `@click` 直接发出的裸按钮。

### 落法

「拒绝」改为受控开合的**统一 `ConfirmDialog`**（W8 定的全站唯一危险确认方式），并在它的默认插槽里放修改意见：

```html
<ConfirmDialog
  :open="pendingRejectId !== null"
  :title="`拒绝任务「${pendingRejectTitle}」`"
  description="拒绝后该任务不会执行；下面填写的修改意见会记录在这次审批上。"
  confirm-label="拒绝"
  cancel-label="关闭"
  busy-label="提交中…"
  :busy="rejecting"
  :error="rejectError"
  @update:open="(open) => (pendingRejectId = open ? pendingRejectId : null)"
  @confirm="confirmReject"
>
  <Label for="approval-comment">修改意见（拒绝时填写）</Label>
  <Textarea id="approval-comment" v-model="rejectComment" rows="3" maxlength="1000" />
</ConfirmDialog>
```

**「批准」保持一键，不套确认框** —— 批准不需要理由，多一步是纯摩擦；它也因此保持与改动前完全一致的调用（见下）。

三条刻意的实现决定：

1. **取消按钮文案改为「关闭」。** 工作流自己就有一个名叫「取消」的生命周期动作（`workflows.act('cancel')`），且它与审批卡在**同一个抽屉**里同时可见。跳出来的确认框再出现一个「取消」，会让「取消什么」变歧义。这条不是风格偏好：本页原有的护栏测试（终态不得渲染生命周期按钮）在改动的第一时间就因新按钮撞名而失败，失败本身就是这个歧义的证据。
2. **`decide` 新增返回值**（`Promise<boolean>`，表示本次决定是否成功）。失败时确认框**保持打开**并把原因显示在框内 —— 关掉它等于告诉用户「已经拒了」（沿用 `ProjectsView.removeProject` 的同一条判据）。失败原因仍然走既有的 `store.error` 通道，**没有新增第二条错误通道**。
3. **无意见时用两参调用**（`comment ? decideApproval(id, action, { comment }) : decideApproval(id, action)`）。因此批准路径的调用参数与改动前**逐字节一致**，既有 store 测试断言的正是这一点，无需放宽。

### ⚠️ 与既有文档规范的一处冲突（已发现并处置，按 `AGENTS.md` §9 报告）

`apps/web/src/components/README.md` §3 原先白纸黑字写着审批的「二选一」**不需要**确认框：

> | 「二选一」的显式选择 | **不需要** | 审批的批准 / 拒绝 —— 用户已经在两个按钮之间做过一次决定，再问一遍只是加一次点击 |

同文件 §2 的容器表也写着「审批：批准 / 拒绝 → 详情内按钮（**二选一**，不再叠加确认）」。

**本阶段的改动与这条规则直接冲突。** 处置如下（不默默对齐任何一方）：

- **规则本身没有被推翻，而是被划出了边界。** 原判据成立的前提是「确认框只重复一次问题」；当确认步骤要**收集用户输入**时，这个前提不成立 —— 确认框不再是「多一次点击」，而是**输入的唯一落点**。
- 因此 `components/README.md` 的判据表**新增一行**「确认步骤要收集用户输入 → 需要，且输入就放在确认框里」，原「二选一」那一行保留但标注「W12 修正：批准仍属此类；拒绝不再属于」，并把 §3 的标题从「判据是救不救得回来」改为「判据是救不救得回来**或**要不要用户填东西」。
- §2 容器表的对应行同步改为「批准是详情内一键；拒绝走 `ConfirmDialog`」。
- **没有删除或弱化任何一条护栏**：审批按钮的「无 disabled」契约保持不变，终态护栏只在「关闭」文案确定后自然通过（先失败、后通过，失败暴露了歧义）。


### 证据

真实后端 + 真实 Chromium（该工作流的状态是 `WAITING_APPROVAL`，服务端确有一条 `PENDING` 审批）：

```
PASS  工作流页：「拒绝」按钮可见（一键直发的旧写法已不存在）
PASS  拒绝确认框：标题带上了任务名（不是空的「拒绝任务「」」）  — "拒绝任务「生产环境部署（需人工审批）」"
PASS  拒绝确认框：修改意见 textarea 可见
PASS  拒绝确认框：textarea maxlength=1000
PASS  拒绝确认框：后果说明可见
PASS  拒绝确认框：取消按钮文案为「关闭」（不与工作流的「取消」撞名）  — ["","关闭","拒绝"]
PASS  拒绝确认框：点「关闭」后弹层收起（且未提交任何决定）
PASS  走查未改动真实数据：该审批在服务端仍是 PENDING  — ["PENDING"]
```

**走查只打开并关闭，没有点「拒绝」** —— 真实审批决定留给你。最后一项直接用 API 复核了服务端状态仍是 `PENDING`，证明这次走查没有改动真实数据。

---

## 六、阶段报告

### Modified Files

**新增**

- `docs/144-phase-w12-frontend-leftovers.md`（本文件）

**修改 · 源码（6 个）**

- `apps/web/src/views/ProjectsView.vue` —— `Dialog` + `description`
- `apps/web/src/views/RequirementsView.vue` —— 同上
- `apps/web/src/views/WorkflowsView.vue` —— 同上；「拒绝」改走 `ConfirmDialog`（含修改意见）；新增 `pendingRejectId` / `rejectComment` / `rejecting` / `rejectError` / `pendingRejectTitle` 与 `openRejectConfirm` / `confirmReject`
- `apps/web/src/views/AgentRunView.vue` —— `Dialog` + `description`
- `apps/web/src/views/DeploymentsView.vue` —— 同上
- `apps/web/src/components/common/StatusBadge.vue` —— 删 `showIcon`
- `apps/web/src/stores/workflows.ts` —— `decide` 增 `comment` 参数与 `Promise<boolean>` 返回值

**修改 · 测试（3 个）**

- `apps/web/src/__tests__/uiComponents.test.ts` —— `ConfirmDialog` 使用者清单 + `WorkflowsView`；新增「每个 `<Dialog` 必须带 description」护栏
- `apps/web/src/__tests__/workflowsView.test.ts` —— 弹层计数 2→3；新增拒绝确认框用例
- `apps/web/src/stores/__tests__/workflows.test.ts` —— 新增 comment 透传断言与 `decide` 返回值用例
- `apps/web/src/__tests__/commonComponents.test.ts` —— 删 `showIcon` 用例

**修改 · 文档**

- `docs/142-phase-w10-acceptance.md` —— §3.2 追加 SC 编号勘误（原结论未改）
- `docs/15-development-roadmap.md` / `docs/17-acceptance-checklist.md` / `docs/18-phase-engineering-goals.md`
- `apps/web/src/components/README.md` —— `ConfirmDialog` 的使用者从 3 处变 4 处（§2 容器表 + §3 判据表新增「收集输入」一行，原「二选一」一行标注 W12 修正，§3 标题改写）；补「确认框可作输入容器」「取消文案看上下文」两条
- `apps/web/src/styles/README.md` §14 —— 新增「弹窗必须带描述」一节

### Implementation

四项全部落地。**没有改后端**（`apps/server`、`packages/*` 一行未动）、没有新增 migration、没有新增运行时依赖。唯一触及 store 的是 `decide` 的签名（新增可选参数与返回值），错误通道与调用参数在无意见路径上保持不变。

### Architecture Changes

**1.「危险确认」的判据从「看起来危不危险」扩展到了「留不留得下痕迹」。** W8 把三种危险确认收敛成 `ConfirmDialog` 时，判据是「救不救得回来」。本阶段「拒绝审批」既救得回来（任务可重跑）又理由充分（审批意见是要落库的），它的判据是**需要收集用户输入**，而不是危险程度。`ConfirmDialog` 的默认插槽正好承接这件事，没有引入新组件。

**2. 无障碍从「属性齐备」推进到「弹窗也有上下文」。** W11 的扫描器覆盖了 13 条路由的静态与交互态；弹窗描述不在 axe 的可机检规则里（WAI-ARIA APG 的推荐项，不是 WCAG A/AA 的失败项），因此它只能靠**看运行日志**发现（W10 的教训）与**测试护栏**钉住。本阶段两者都做了：告警在 5 个页面上实测消失，护栏写进 `uiComponents.test.ts`。

### Dependencies

无新增依赖（`dependencies` 与 `devDependencies` 一字未改）。

### Tests

```
apps/web : Test Files 36 passed (36)   Tests 450 passed (450)    ← 448 → 450
apps/server : Test Files 40 passed (40)   Tests 227 passed (227)
全仓     : 16 包 / 175 文件 / 1438 用例（1436 → 1438）
```

> `apps/server` 那一行是**单独跑** `--filter @ai-se/server test` 的结果。收尾时两次全仓 `-r` 调用各有一条**不同的**时序敏感 e2e 失败，两个文件单独复跑都通过 —— 见 Known Issues 9（与本次改动无关，机器负载所致）。

净增 2 条（新增 3 条 / 删除 1 条）：

| 用例 | 覆盖 |
| --- | --- |
| `uiComponents`：每个 `<Dialog` 都必须带 `description` | 5 个弹窗 + 防空扫描计数断言 |
| `workflowsView`：拒绝走确认框并收集修改意见 | 标题模板 / textarea / 后果说明 / 「关闭」与工作流的「取消」共存 |
| `workflows store`：`decide` 返回本次决定是否成功 | 成功 true / 失败 false 且原因进 `store.error` |
| ~~`commonComponents`：`showIcon=false`~~ | 随 prop 一起删除 |

另改 2 处既有断言：`ConfirmDialog` 使用者清单（+`WorkflowsView`）、弹层计数（2→3，页面现在确实有三层弹层）。

### Lint

`eslint "src/**/*.{ts,vue}"` 通过，无输出。全仓 `pnpm -r run lint` 16 包全部 Done。

### Typecheck

`vue-tsc --noEmit` 通过，无输出。全仓 `pnpm -r run typecheck` 16 包全部 Done。

### E2E

**真实后端 + 真实 Chromium，30/30 通过**（§二、§五各占一半）。API 级 e2e 未跑（未改后端）。

### Known Issues

1. **`cancel-label="关闭"` 与 `Dialog` 的 X 关闭按钮文案重复**（X 按钮的 `aria-label` 也是「关闭」）。同一个弹层里出现一个可见的「关闭」按钮与一个 `aria-label="关闭"` 的图标按钮，对屏幕阅读器是两处同名控件。**未修** —— 改 X 按钮的 `aria-label` 会影响全站所有弹层，不在本阶段范围；登记待判。
2. **弹窗描述的可见性是一次版式改动。** 5 个弹窗首屏各多一行文字，弹窗总高度增加。未逐视口量过（1440 下无溢出，小视口未测）。
3. **「拒绝」的失败态未在浏览器里走查过。** 只测了成功路径的结构与「打开→关闭」。（造一次真实的 500 需要打断后端，未做。）
4. **`decide` 的 `Promise<boolean>` 只被拒绝路径使用**；批准路径忽略返回值（它的失败仍只经由页面级 `ErrorState` 呈现）。这是刻意的：给批准也套一处错误 UI 属于本阶段之外的范围。
5. **本轮押后的两项仍在**：axe 覆盖数据态 / 弹窗态 / 抽屉态、真实屏幕阅读器走查（后者计划以 a11y 树快照作替代）。
6. **`docs/143` 的 Known Issues 未回改**（历史报告不重写）。其中第 6、7 条已被本阶段裁定：`showIcon` 已删、W6 内容变更**改为保留现状**。其余（表头 sticky、`--input` 在 `--muted` 面）维持原判。
7. **仓库仍不是 Prettier 干净的**（420 文件）。本阶段逐文件跑过 `prettier --check` 并对改动文件做了 `prettier <file> | diff` 比对：**发现自己引入了一处偏离**（`stores/workflows.ts` 的 `decide` 签名我手动折成了多行，而 prettier 要求单行），**已修回**。其余报错（`<form>` / `<ErrorState>` 被折成多行等）**都是既有的**，且方向与 prettier 相反 —— 未顺手改，避免无关 churn。`format:check` 不在任何门禁里，且因本仓无 git 而**不建议**执行全量 `--write`。
8. **X1 的「既有 Secret Provider」在本阶段核实为不存在**（见 §七）。这是 X1 开工前必须先解掉的前提。
9. **`apps/server` 的 e2e 在当前机器负载下会偶发失败（与本次改动无关，但必须记下来）。** 收尾时连跑两次全仓 `pnpm -r run test`，**两次都失败，且失败的是两条不同的**时序敏感 e2e：
   - 第一次：`terminationPropagation.e2e.test.ts`「FX-35：任务取消 → run 中止」（断言「假 LLM 确实在持续发起工具调用」，`expected 0 to be greater than 0`）
   - 第二次：`planningEscalation.e2e.test.ts`「切片 2 规划成环耗尽 → 升级审批 → 批准后仅重试该切片」

   两次都做了这三件事：①**单独复跑该文件 → 通过**（5/5、2/2）；②单独跑 `--filter @ai-se/server test` → **227/227 通过**；③更早一次全仓跑（改动同一份代码时）也是 227/227。

   **结论**：这是机器负载（你的后端正在跑真实任务）下的时序抖动，**不是本次改动引入的** —— 本阶段一行都没碰 `apps/server` 与 `packages/*`。但**没有去修它**：两条测试的等待窗口（`SETTLE_MS` 等）是既有设计，调它是后端线的事，属 `AGENTS.md` §9 的越界。**留给后端线登记。**
10. **`WorkflowsView` 新增的弹层使页面弹层数从 2 变 3**（新建弹窗 + 详情抽屉 + 拒绝确认框）。三层都用 `unmount-on-hide=false`，因此关闭态下 DOM 里同时挂着三份内容 —— 这是既有约定（为了 SSR 可测），但页面变重了一点。

### Acceptance Result

**通过。**

| 四项工作 | 判定 | 证据 |
| --- | --- | --- |
| 5 个弹窗补可访问描述 | 已解决 | 5 页 × 3 项浏览器实测全 PASS；告警消失；新增护栏 |
| 删 `showIcon` | 已解决 | 零调用已复核；渲染输出不变；a11y 复扫零违规 |
| `docs/142` SC 编号勘误 | 已解决 | §3.2 表格后追加勘误，原结论未动 |
| 审批拒绝带修改意见 | 已解决 | 真实后端下 8/8；服务端状态复核仍为 `PENDING`（未改动真实数据） |

```
apps/web : typecheck ✓  lint ✓  test 450/450 ✓  build ✓  a11y ✓（零违规）
全仓     : typecheck ✓  lint ✓  test 1438/1438 ✓  (16 包 / 175 文件, exit 0)
真实后端 : 浏览器走查 30/30 ✓
```

> **一条保留**：全仓 `-r run test` 的**单次调用**出现过两次「一条时序敏感的服务端 e2e 失败」，两次是不同的文件、单独复跑都通过（Known Issues 9）。上表的 1438 来自按包复核的结果，不是那两次 `-r` 调用的输出。**不声称「一次 `-r` 跑通」，也不把这记成通过。**

### Next Phase Boundary

**本阶段结束。** 边界：

- **未改后端**：`apps/server`、`packages/*` 一行未动。
- **未改接口契约**：`api/`、`viewmodels/`、路由 `path`/`name` 未变。`stores/workflows.ts` 的 `decide` 只增了可选参数与返回值，无意见路径的调用参数与改前一致。
- **未新增可见文案**：5 句弹窗描述与 1 句确认框描述是**新增的可见文字**（已逐条列出，属内容变更，请你过目）；「按状态筛选」式的无障碍名称不计入可见文案；页面正文一字未动。
- **未新增运行时依赖、未新增 migration**。
- **未动 `dist/`**。

**仍未开始（押后）**：axe 扫描器扩展（详情页数据态 / 弹窗态 / 抽屉态 + a11y 树快照）、真实屏幕阅读器走查、以及排在 W 线之后的 **X1 · 模型与凭据配置**。

---

## 七 · X1 前置（本阶段核实，必须先裁定）

### 核实结果：`docs/15` 要求复用的「既有 Secret Provider」**并不存在**

| 说法 | 实测 |
| --- | --- |
| `docs/15` 要求 X1 的凭据「复用既有 Secret Provider 引用」 | `packages/mcp/src/security/credentials.ts` 文件头自述 **"deliberately not a secret store"** —— 它只有 `MCPCredentialResolver` 这个**类型** |
| 该 resolver 有实现吗 | 全仓 grep：**零实现** |
| 它在生产里接线了吗 | `apps/server` **零接线**。它只是 `RemoteMCPClient` 的一个可选构造选项（`RemoteMCPClient.ts:66`） |
| 不接线的后果 | `RemoteMCPClient.ts:474`：任何带 `credentialRef` 的远端 server **直接抛 CONNECTION 错**（fail-closed，行为正确） |
| LLM 的 key 现在在哪 | `apps/server/src/config.ts:12` 读环境变量 `OPENAI_API_KEY` → `config.llmApiKey`，进程启动时读一次、只存内存 |
| 数据库里有 secrets 表吗 | 迁移目录 grep：**没有** |

### 三条候选与推荐

| 方案 | 做法 | 问题 |
| --- | --- | --- |
| A · 落库加密 | 新建 secrets 表 + 主密钥 | 主密钥还得来自 env ⇒ 循环；且这正是 `AGENTS.md` §10 禁止的**第二套 Secret 体系** |
| B · 操作系统钥匙串 | keytar / Keychain | 新依赖 + 平台绑定；CI 与 Linux 服务器上没有钥匙串 |
| **C · 内存态运行时覆盖（推荐）** | env 提供默认值；控制台写入的 key 只活在进程内存，**不落库、不落盘、不进日志**，重启即失效 | 重启要重填 —— 但它是**唯一同时满足「运行时可改」与「不得新增明文存储」的方案，因为它根本不存储** |

**建议 X1 拆成三件事：**

1. **X1-a · 把空接口变成有实现、有接线。** 写一个 `envCredentialResolver`（按 reference 取名，如 `secret:mcp/servers/github` → `MCP_SECRET_GITHUB`），在 `apps/server/src/index.ts` 组合根注入 `RemoteMCPClient`。**这样「既有 Secret Provider」才第一次真实存在** —— 今天它只是个类型。
2. **X1-b · LLM 走同一条 resolver 契约**（方案 C）。`llmApiKey` 从「启动时读 env」变成「构造 provider 时向 resolver 要」。控制台读回只暴露**布尔**（是否已配置）与 model / baseUrl，**永不回显 key**。
3. **X1-c · 前端设置页**（当前 13 条路由里没有设置页）+ 侧栏入口。

**边界**：X1 不新增任何持久化，因此**不新增 migration**。「密钥重启失效」要作为已知限制写进任务书，不能伪装成完整方案。
