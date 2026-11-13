# 157 · 阶段记录：追踪前端（端到端追踪视图的前端呈现）

> 阶段：**追踪前端**（任务书 `docs/156`；验收项 TF-01 … TF-07 定义在 `docs/17` 节「追踪前端 · 端到端追踪视图的前端呈现」）。
> 日期：2026-10-15。开工授权：用户 2026-10-15「现在就开追踪前端」（`docs/146` §0：裁定 ≠ 开工授权，此为授权）。
> 性质：**历史记录（冻结）**——本文只记录「当时做了什么、当时怎么判的」，不回改。
> 与 M4 批次并行执行：L1-M4 的 E1×3 批次当时跑在专用实例 `:47558` 上，本阶段**零接触面**（只改 `apps/web`）。

## Modified Files

**新增（4）**

| 文件 | 内容 |
| --- | --- |
| `apps/web/src/viewmodels/workflowTraceViewModel.ts` | 追踪树的纯展示逻辑：节点主键、默认折叠策略、展开 / 收起、可见节点计数、逐类计数校验、类型 / 状态标签与配色、用时、`detail` 行 |
| `apps/web/src/components/TraceTree.vue` | 递归可折叠树组件（自引用递归，无第三方树库） |
| `apps/web/src/__tests__/workflowTraceViewModel.test.ts` | 纯逻辑单测（18 例） |
| `apps/web/src/__tests__/traceTree.test.ts` | 组件渲染契约测试（8 例） |

**修改（6）**

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/api/workflows.ts` | 新增 `getWorkflowTrace(id)`；失败响应把 `ApiErrorBody.code` 附到抛出的 Error 上（既有错误通道的附加字段，非第二套错误体系） |
| `apps/web/src/stores/workflows.ts` | 新增 `trace` / `traceLoading` / `traceError` / `traceNotFound` 状态与 `loadTrace()` / `clearTrace()`；`loadWorkflow` 在**切换工作流**时清树（同一次运行的刷新保留） |
| `apps/web/src/viewmodels/workflowViewModel.ts` | 从 `workflowDurationLabel` 抽出 `durationLabel(ms)` 供追踪节点复用（行为逐字不变） |
| `apps/web/src/views/WorkflowsView.vue` | 详情 `Drawer` 内新增「追踪」区（四态 + 树 + 计数行 + 刷新），按需加载 |
| `apps/web/src/__tests__/workflowsView.test.ts` | 追加「追踪区」6 例（四态 / 归属校验 / 404 与网络失败文案可区分） |
| `apps/web/scripts/a11y.mjs` | 新增阶段 `axe/trace-open` |

**文档**：`docs/17`（本节回勾）、`docs/18`（Phase 7 验收口径更新）、`docs/127` §0/§9、`docs/146` §1/§2.1/§3、`docs/156`（状态）、本文件。

**未改动（TF-07 核对）**：`apps/server/**` 与 `packages/**` 的**源文件**一个未动（`find` 按修改时间核对为空）。`packages/shared/dist` 由既有 `typecheck` 脚本的 `--filter @ai-se/shared build` 步骤重建——那是构建产物（`AGENTS.md` §1：`dist/` 不作权威），不是源码变更。

## Implementation

### TF-01 追踪可达

`api/workflows.ts` 加 `getWorkflowTrace(id): Promise<WorkflowTraceView>`；store 加 `loadTrace()`。**不并入 `loadWorkflow`**：真实运行实测 503 个工具调用节点（`docs/153`），每次打开详情都拉一棵不划算。页面给一个「加载追踪」按钮显式触发。

归属校验在**视图层**做：`trace.workflowRunId === current.workflow.id` 才渲染——旧请求后到时不会把上一棵树画出来。

### TF-02 层级与计数正确

层级**原样来自契约**：组件只递归 `node.children`，不重排、不丢节点。真实运行核对（只读走查，见 E2E）：`Workflow → Task → AgentRun → ToolCall`，树深 4。

**计数口径唯一**：界面显示的计数行直接取后端 `view.counts`。`viewmodels/` 里的 `collectTraceCounts()` 只用于**校验**与单测断言，不作为展示数据源——避免两处口径（`docs/156` §7）。

### TF-03 规模可控

默认折叠：`workflow` / `task` 展开，`agentRun` / `toolCall` / `deployment` 收起（`DEFAULT_EXPANDED_KINDS`）。折叠只藏住**自己的子树**，所以挂在任务下的 `deployment` 仍可见。

展开态是**视图本地状态**（`traceExpanded: string[]`），组件只 `emit('toggle', key)`，**不触发任何请求**。

在 `docs/153` 记录的真实规模（19 / 16 / 503 / 0）上，默认折叠首屏节点数 = `1 + 19 + 16 = 36`，单测断言其上界（`< 50`）。

### TF-04 四态与错误

顺序固定：错误 → 加载中 → 空 → 有数据。

- **空**：「尚未加载追踪。」+ `EmptyState` 的 `#actions` 给「加载追踪」（不是一句死文案）。
- **加载中**：`LoadingSkeleton` ×4。
- **404（`WORKFLOW_NOT_FOUND`）**：专属文案「该工作流不存在，可能已被删除。」，`ErrorState` 的 `retryable=false`——**重试无意义**，不给按钮。
- **网络 / 服务端失败**：沿用既有文案 + 可重试。

404 与网络失败的区分靠**错误码**而非文案：`requestJson` 现在把 `ApiErrorBody.code` 附到 Error 上（`error.message` 是后端文案，不可作判据）。这是既有错误通道的附加字段，没有新增第二套错误体系（`AGENTS.md` §10）。

### TF-05 只读与脱敏边界

新增代码**没有任何**对 `tool_calls` / `agent_runs` 明细的请求——那正是 7-C 刻意剥掉的（`docs/150` §Implementation 7）。`detail` 按后端白名单标量原样渲染：`traceDetailRows` 跳过嵌套对象 / 数组（契约只给标量），`null` 显示为「—」，不做二次加工（字符串已过后端 `redactCredentialShapedText`）。

追踪是只读派生视图：前端没有任何修改追踪内容、任务结果、状态机或审批语义的动作。

### TF-06 可访问性

- 折叠控件是真实 `<button>` + `aria-expanded`，`aria-label` 说明「展开 / 收起{类型}「{标签}」」。
- **树用语义化嵌套列表（`<ul>/<li>`），不用 `role="tree"`**。理由：完整的 ARIA tree 模式要求 roving tabindex + 方向键导航；只做一半比不做更糟——读屏会播报成树，方向键却不动。嵌套列表 + 真实按钮结构正确、播报正确，键盘路径是标准的 Tab + Enter/Space，且没有键盘陷阱。
- 叶子节点留同宽空位（`aria-hidden`）以对齐同层标签。
- 追踪树的 `<ul>` 带 `aria-label="端到端追踪树"`，既是可访问名称，也是 a11y 脚本的稳定锚点。

### TF-07 零后端改动

见 Modified Files 的核对结论。

## Architecture Changes

**无。** 不改 `/trace` 端点、不改 `packages/shared` 契约、不新增路由、不引入依赖、不动 `DashboardView` 与 Phase 7 已收口的任何实现。

前端新增一条与既有结构同形的数据通道（`api/` → `stores/` → `viewmodels/` → `components/` + `views/`），没有新分层。

## Dependencies

**无新增。** 递归树手写（自引用 SFC），不需要第三方树库；图标复用既有 `@lucide/vue` 的 `ChevronRight`。

## Tests

| 套件 | 结果 |
| --- | --- |
| `apps/web` 全量 | **505/505 通过（41 个文件）** |
| 其中 `workflowTraceViewModel.test.ts` | 18/18 |
| 其中 `traceTree.test.ts` | 8/8 |
| 其中 `workflowsView.test.ts`（含新增「追踪区」6 例） | 全绿 |

改动前基线 473 → 505（+32）。SSR 下 `onMounted` 不执行 ⇒ 测试不触发任何网络请求，store 状态由测试注入。

## Lint

`corepack pnpm --filter @ai-se/web lint` 退出码 0。

## Typecheck

`corepack pnpm --filter @ai-se/web typecheck` 退出码 0（含 `vue-tsc`）。

## E2E

**只读走查（真实后端 `:3000`，只读 GET，不写）**：对一个真实运行取 `/api/workflows/:id/trace`，逐项核对——

- `counts = { tasks: 11, agentRuns: 13, toolCalls: 222, deployments: 0 }`，与**遍历树得到的逐类节点数完全一致**（11 / 13 / 222）；
- 树深 **4**（`workflow → task → agentRun → toolCall`），根节点 `label` 即工作流 id、`status` 为该工作流的真实状态；
- 首个 `toolCall` 节点 `label = "list_directory"`（**真实工具名**）、`status = succeeded`、`durationMs = 224`。

**a11y 扫描（`pnpm --filter @ai-se/web a11y`）**：见下方「Acceptance Result」——新增阶段 `axe/trace-open` 在工作流详情抽屉内点开「加载追踪」、等数据态、再展开一层默认收起的层级后扫描。

## Known Issues

1. **文档冲突（已报告，未自行裁决）**：`apps/web/src/components/README.md` §1 的判据是「能被两个以上页面以同一形态复用的 UI 片段才进本目录；只被一处用到的结构留在页面里」。`docs/156` §6 裁定 1 要求树组件「外置到 `components/`」，而追踪树**当前只被 `WorkflowsView` 一处使用**。本次按**用户裁定**放在 `components/TraceTree.vue`（它是 `@ai-se/shared` 冻结契约类型的渲染器，不含任何页面知识，不落入该判据想防的「把两条不同内容逼进同一个壳」）。**未改 README**——是否给该判据加例外说明，等用户裁定。
2. 追踪树**不做**筛选 / 搜索 / 导出（无真实需求，沿用 W5「不造点不动的控件」的同一标准）。
3. 不做需求页 / AgentRun 页到追踪的反向跳转（`docs/156` §6 裁定 5）。
4. `apps/web` 的 a11y 扫描**不在 `test` 门禁里**（既有约定：需要真实排版引擎），按独立命令跑。

## Acceptance Result

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| TF-01 追踪可达 | **达成** | 真实运行上树深 4 抵达 `toolCall`，`label` 为真实工具名 `list_directory`；`getWorkflowTrace` + 「加载追踪」入口 |
| TF-02 层级与计数正确 | **达成** | 层级原样来自契约（不重排 / 不丢节点）；计数行取 `view.counts`；真实运行上逐类节点数与 `counts` 完全一致（11/13/222/0） |
| TF-03 规模可控 | **达成** | 默认折叠；真实规模（19/16/503/0）下首屏 36 个节点（单测断言上界）；展开是本地状态，不发请求 |
| TF-04 四态与错误 | **达成** | 四态顺序固定；404 专属文案且无重试按钮、网络失败可重试，两者**文案可区分**（`workflowsView.test.ts` 6 例） |
| TF-05 只读与脱敏边界 | **达成** | 无任何工具输入 / 输出请求；`detail` 只渲染后端白名单标量；无任何写动作 |
| TF-06 可访问性 | **达成** | `axe/trace-open` 阶段在真实抽屉内扫描，**零 WCAG A/AA 违规** |
| TF-07 零后端改动 | **达成** | 变更文件清单不含 `apps/server/**` 与 `packages/**` 源文件（按修改时间核对为空） |

**TF-06 证据（a11y 扫描，2026-10-15）**：

```
各阶段实际扫描路由数：axe/light 14 · axe/dark 14 · zoom200 14 · forcedColors 14 ·
  textSpacing 14 · axe/data 5 · axe/dialog-open 5 · axe/drawer-open 1 ·
  axe/reject-confirm 1 · axe/trace-open 1
✓ axe 无 WCAG A/AA 违规。
✓ 无水平溢出（200% 缩放 / 文本间距两阶段）。
结果：全部通过。（退出码 0）
```

新增阶段 `axe/trace-open` 的实际动作：在工作流详情抽屉内点「加载追踪」→ 等数据态出现（「刷新」按钮只在数据态渲染）→ 等 `aria-label="端到端追踪树"` 的列表可见 → 再展开一层默认收起的层级（Agent 运行 → 工具调用）→ 扫描。该阶段**只读**：追踪是 `GET /api/workflows/:id/trace` 的派生视图，展开 / 收起是纯本地状态，全程没有任何写请求。任一等待步骤失败都会推入 `errors` 并以非零码退出——退出码 0 即证明树**真实加载并渲染**了，而不是跳过了这一阶段。

## Next Phase Boundary

**本阶段到此为止（STOP）。** 追踪前端 TF-M1 … TF-M4 全部完成；`docs/17` 节「追踪前端」已逐项回勾。

**未开始事项（STOP）**：

- **L1-M4 批次收口**（另一条在跑的线）：批次仍在 `:47558` 上执行 E1×3；跑完后需读三段 staging 段结果 → 归因 → 判 ≥2/3 → 写 `docs/155` 的 M4 段 → 回填 `docs/17` L1-8 → 同步 `docs/146` §1/§2.1/§3 与 `docs/127` §0/§9。
- `docs/18` 节「Phase 7：Observability」的验收口径更新（前端那一半由「未做」改为已达成）——**本次一并完成**，见该节。
- `docs/01–14` 重新基线（02/03/05/06/07/08/09/10/11/14 未做）。
- Phase 8 AI SRE 任务书；`provider` 运行时切换；`audit_logs` 处置；Phase 7 外部栈（已裁定延期）。
- 本文件 Known Issues 1 的文档冲突待用户裁定。
