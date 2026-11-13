# 156 · 追踪前端任务书：端到端追踪视图的前端呈现

> 状态：**已完成（2026-10-15）**。§6 五项已按推荐值裁定；用户 2026-10-15「现在就开追踪前端」授权开工（`docs/146` §0：裁定 ≠ 开工授权，此即授权）。**TF-01 … TF-07 全部达成**，实施记录 **`docs/157`**，验收已在 `docs/17` 节「追踪前端 · 端到端追踪视图的前端呈现」逐项回勾。本文件自此转为**任务书原件**（当时的改动方案），不再更新。
> 依据：`docs/147` §6 第 5 项（**裁定正本**：追踪视图前端「另立阶段」，Phase 7 只交付 API）、`docs/18` 节「Phase 7：Observability」的验收原文、`docs/150`（7-C 追踪契约与实现）、`docs/153`（Phase 7 收口；Known Issues 1 就地声明了「前端未做」这一半）、`docs/152` / `docs/155`（自治决策事件的去向）、`AGENTS.md` §5/§9。
> 编号：任务编号 **TF-M1 … TF-M4**（里程碑）；验收编号 **TF-01 … TF-07**（**新造**——`docs/17` 无对应节，理由见 §6 第 4 项）。
> 性质：**本文件只是改动方案**。`docs/147` §6 已裁定「另立阶段」，但**裁定 ≠ 开工授权**——缺的正是这一份。

## 1. 为什么需要它：基线事实（2026-10-15 代码核对）

| 事项 | 现状（代码核对） | 证据 |
| --- | --- | --- |
| 追踪 API | **已交付**。`GET /api/workflows/:id/trace`，统一 JSON 信封；不存在 → 404 `WORKFLOW_NOT_FOUND`；`:id` 非 UUID → 400 `VALIDATION_ERROR` | `apps/server/src/routes/workflows.ts:151-157`；`docs/150` |
| 追踪形状 | **树**：`WorkflowTraceView { workflowRunId, requestId?, generatedAt, root, counts }`；`TraceNode { kind, id, label, status, startedAt?, finishedAt?, durationMs?, detail, children }`；`kind ∈ workflow / task / agentRun / toolCall / deployment` | `packages/shared/src/index.ts:942-976` |
| 树的规模 | 真实 run 实测 `counts = { tasks: 19, agentRuns: 16, toolCalls: 503, deployments: 0 }` | `docs/153` §E2E 只读走查 |
| 前端是否已消费 | **零调用**。`apps/web` 全树 grep `trace` 只命中 AgentRun 的执行轨迹（UX-03，另一个东西）与需求的可追溯性表 | 本次核对 |
| 前端 API 层 | `api/workflows.ts` 有 11 个函数，**无** trace | `apps/web/src/api/workflows.ts` |
| 前端 store | `stores/workflows.ts` 有 `loadWorkflow` / `loadEventsPage` 等，**无** trace 状态 | `apps/web/src/stores/workflows.ts` |
| 详情容器 | `/workflows/:id` **复用** `WorkflowsView.vue`（991 行）；详情在 `Drawer` 内，已含「审批」「工作流图」「事件时间线」三块 | `apps/web/src/views/WorkflowsView.vue:628,790,812,870` |
| 既有 trace 渲染先例 | AgentRun 页把「执行轨迹」渲染为**扁平时间升序列表** + 首尾折叠（前 30 + 后 30） | `apps/web/src/viewmodels/agentRunViewModel.ts:492`；`apps/web/src/views/AgentRunView.vue:524` |
| 递归树组件 | **不存在**（`components/` 下无树） | 本次核对 |
| 共享件 | `components/common/` 已有 12 个（`EmptyState` / `ErrorState` / `TableSkeleton` / `StatusBadge` / `CopyableId` / `DetailRow` …） | 目录清单 |
| `types/` / `constants/` | **仍未建立**（`AGENTS.md` §5 明写「规划中」） | 本次核对 |
| 自治决策事件 | 四个事件写进 **`workflow_events`**，**不在追踪树里** | `docs/152`；`docs/155` |
| 事件时间线 | 已读 `/api/workflows/:id/events`——**决策事件前端已经能看到** | `apps/web/src/stores/workflows.ts` `loadEventsPage` |
| Sandbox | **不单独成节点**——它是工具执行路径，不是事实表 | `docs/153` Known Issues 1 |
| a11y 扫描器 | 已建并扩展过（`pnpm --filter @ai-se/web a11y`，14 路由 × 9 阶段零违规） | `docs/143` / `docs/145` |

**结论**：**API 侧一行不用改**，本阶段是**纯前端**。真正要新写的是三样：一个递归可折叠树组件、一组树相关的纯逻辑（`viewmodels/`）、以及 `api/` + `stores/` 的 trace 通道。规模问题（503 个 toolCall）是本阶段的主要设计约束，不是可选优化。

**`docs/18` 验收原文的缺口**（收口时已就地声明，`docs/153` Known Issues 1）：原文要求「一次真实 Agent Run 可以**从前端**/服务入口追踪到具体 Tool 和 **Sandbox** 执行」。**服务入口**已达成；**前端**是本阶段要补的那一半。**Sandbox 那一半不补**——理由见 §6 第 2 项。

## 2. 范围与里程碑

| 里程碑 | 内容 | 出口 | 依赖 |
| --- | --- | --- | --- |
| **TF-M1 数据通道**（无 UI） | `api/workflows.ts` 加 `getWorkflowTrace`；`stores/workflows.ts` 加 trace 状态与四态；`viewmodels/` 加树相关纯函数 | 纯函数单测全绿；无任何 `.vue` 改动 | 7-C 端点（**已交付**） |
| **TF-M2 树组件** | 递归可折叠树组件（`components/`），含默认折叠策略与节点计数校验 | 组件测试全绿（SSR 断言，跟随既有模式） | TF-M1 |
| **TF-M3 接入与四态** | 接进工作流详情；加载 / 失败可重试 / 空 / 有数据四态；404 文案 | 真实后端只读走查通过 | TF-M2 |
| **TF-M4 收口** | a11y 扫描扩展；`docs/17` 新增「追踪前端」节并回勾；`docs/146` 同步；阶段记录 | 全部验收项有证据 | TF-M3 |

**本阶段不做**（边界）：

- **不碰 `apps/server`、不碰 `packages/*`**（红线，§7）。追踪 API 已交付，前端不需要后端配合。
- **不改 `/trace` 端点**：不往里加决策事件、不加 Sandbox 节点、不加工具输入/输出（见 §6 第 2 项）。
- **不做**需求页 / AgentRun 页到追踪的反向跳转（§6 第 5 项）。
- **不做**追踪的筛选 / 搜索 / 导出（无真实需求；沿用 W5 的同一标准：不造点不动的控件）。
- **不动** `DashboardView` 的指标口径（那是 Phase 7 已收口的既有实现）。
- **不引入**任何新依赖（树渲染手写递归组件即可，不需要第三方树库）。

## 3. 任务明细

> 组织方式：按验收项逐条给改动。验收编号为新造（§6 第 4 项）。

### TF-M1 数据通道

**TF-01 追踪可达（从工作流详情看到 tool 级）**
- **目标**：在工作流详情里，能从一次 run 追到具体的工具调用（`docs/18` 验收原文的前端那一半）。
- **改动**：`api/workflows.ts` 加 `getWorkflowTrace(id): Promise<WorkflowTraceView>`；`stores/workflows.ts` 加 `trace` 状态与 `loadTrace(id)`；在详情加载路径上按需拉取（**不**并入 `loadWorkflow`，避免每次打开详情都拉 500+ 节点）。
- **判据**：真实 run 上能展开到 `toolCall` 节点，节点 `label` 是真实工具名。

**TF-02 层级与计数正确**
- **目标**：前端呈现的层级与 `Workflow → Task → AgentRun → ToolCall`（deployment 挂在产生它的任务下）一致；**不重排、不丢节点**。
- **改动**：`viewmodels/` 加纯函数（树的遍历 / 折叠展开 / 计数校验）。计数校验直接对着 `view.counts`（后端由遍历组装好的树得出，`docs/150` §Implementation 8）——**前端不再自算一份**，避免两处口径。
- **判据**：单测用固定树断言遍历顺序与计数；真实 run 上页面显示的节点数与 `counts` 逐类一致。

**TF-03 规模可控**
- **目标**：500+ 节点不淹没页面、不卡顿。
- **改动**：**默认折叠策略**——`workflow` 与 `task` 展开，`agentRun` 折叠，`toolCall` 默认收起；节点展开是本地状态，不触发重新请求。
- **判据**：在 `toolCalls: 503` 的真实 run 上，首屏渲染的节点数有上界（默认折叠下），展开操作不引发网络请求。

### TF-M2 树组件

**TF-04 四态与错误**
- **目标**：加载中 / 失败可重试 / 空 / 有数据，四态齐备且顺序固定（沿用 W5 立的标准骨架）。
- **改动**：新组件用既有 `LoadingSkeleton` / `ErrorState`（带重试）/ `EmptyState`；404（`WORKFLOW_NOT_FOUND`）给明确文案，不复用通用错误文案。
- **判据**：组件测试覆盖四态；404 与网络失败文案可区分。

### TF-M3 接入与四态

**TF-05 只读与脱敏边界**
- **目标**：前端**只呈现**后端已给的东西，不"充实"页面。
- **改动**：**不额外请求** `tool_calls` 明细 / `agent_runs` 明细来补工具输入输出——那正是 7-C 刻意剥掉的东西（`docs/150` §Implementation 7：工具调用的 `input`/`output` 一律不进树）。
- **判据**：新增代码里没有任何对工具输入 / 输出的请求或渲染；`detail` 按后端给的白名单标量原样呈现。

**TF-06 可访问性**
- **目标**：新增 UI 不引入新的 a11y 违规。
- **改动**：折叠控件用真实的 `<button>` + `aria-expanded`；树用嵌套列表语义（`role="tree"` / `treeitem"` 或语义化列表二选一，实施时按实测决定并报告）。
- **判据**：`pnpm --filter @ai-se/web a11y` 在**工作流详情页的追踪展开态**下零违规（扩展既有阶段清单）。

**TF-07 零后端改动**
- **目标**：本阶段的改动**全部落在 `apps/web/`**。
- **判据**：变更文件清单不含 `apps/server/**` 与 `packages/**`（`AGENTS.md` §1：本仓无 git，以文件清单核对）。

## 4. 验证分层

| 层 | 内容 | 位置（`AGENTS.md` §5） |
| --- | --- | --- |
| 单元 | 树遍历 / 折叠 / 计数校验纯函数；`api` 的 trace 调用 | `apps/web/src/__tests__/`（**测试一律放 `__tests__/`**） |
| 组件 | 树组件渲染、四态、404 文案（SSR `renderToString`，跟随既有断言模式） | 同上 |
| 走查 | 对**真实后端**的只读走查：真实 run 的树、404、展开折叠 | 后端在 tsx watch 下；**只读**走查可以，写接口不行 |
| a11y | axe 扫描扩展（新增追踪展开态） | `pnpm --filter @ai-se/web a11y` |

**门禁**：`corepack pnpm --filter @ai-se/web typecheck && lint && test`，外加 `build`。

> **与 M4 批次并行时的附加约束**：`apps/web` 的改动与 L1-M4 批次**零接触面**（批次跑在专用实例 47558 上，前端改动不重启它）。但**门禁只跑 `--filter @ai-se/web`**——不跑全仓 `-r`，避免重负载给批次引入偶发失败，也避免重建 `packages/*/dist` 造成中途换代码。

## 5. 退出条件

本阶段收口 =

- TF-01 … TF-07 全部达成，逐项有证据；
- `docs/17` 新增「追踪前端」节并逐项回勾（形态同「自治 L1」节，见 §6 第 4 项）；
- `docs/146` §1 / §2.1 / §3 同步；`docs/127` 同步；
- `docs/18` 节「Phase 7：Observability」的**验收口径更新**——前端那一半由「未做」改为已达成（**Sandbox 那一半维持「不单独成节点」的既有声明，不改口径**）；
- 新增一份实施记录 `docs/157`（形态同 `docs/155`）。

**未达时的处置**：如实记录 PASS-PARTIAL 并归因，不伪装、不因部分达成而否定已达成项。

## 6. 待裁定项（每条带推荐值，等你一句话）

| # | 事项 | 选项 | 推荐 |
| --- | --- | --- | --- |
| 1 | **追踪区放哪儿** | ① 既有工作流详情 `Drawer` 内新增「追踪」区（与「工作流图」「事件时间线」并列）；② 独立路由 `/workflows/:id/trace`；③ `Drawer` 内加 Tab 切换 | **①**——与既有信息架构一致、最小改动；③ 会把「工作流图 / 事件时间线」也拖进 Tab 重构，超出本阶段范围。代价：`WorkflowsView.vue` 已 991 行，实施时树组件必须外置到 `components/`，不往该文件里堆 |
| 2 | **是否碰 `/trace` 端点** | ① 不碰，决策事件由既有事件时间线承载、Sandbox 不补节点；② 给 `/trace` 加决策事件；③ 给 `/trace` 加 Sandbox 节点 | **①**——四个自治决策事件写的是 `workflow_events`，而事件时间线**已经**能显示它们，加进树是重复呈现；Sandbox 不是事实表，凭空造节点违反「只读派生」（`docs/153` 已就地声明）。选 ① 的额外好处：本阶段**完全不碰 `apps/server`**，可与 M4 批次安全并行 |
| 3 | **树的渲染形态** | ① 递归可折叠树（缩进 + `aria-expanded`）；② 扁平缩进列表 + 首尾折叠（复用 AgentRun 页的既有手法） | **①**——7-C 返回的是真树，② 会把层级压平；且 ② 的首尾折叠是为"线性阅读顺序"设计的，套到分层结构上会让父子关系不可读 |
| 4 | **验收编号与新 `docs/17` 节** | ① 新造 TF-01 … TF-07 并在 `docs/17` 新增「追踪前端」节；② 不新增节，只在 `docs/156` 内定义 | **①**——`docs/17` 已有为「自治 L1」新开节的先例；验收项不进清单就等于没有计分板，`docs/146` §3 也无处归位 |
| 5 | **范围边界：跨页跳转** | ① 只做工作流详情内的追踪；② 另加需求页 / AgentRun 页到追踪的反向跳转 | **①**——② 要动 `RequirementsView` / `AgentRunView` 的路由与 URL 同步（W11 立过 `?requirement=` / `?agent=` 的规则），是另一个范围；且当前没有真实需求提出它 |

**未决项**：无。五项已全部裁定，开工条件已清空（**但未开工**）。

**裁定结果（2026-10-15 用户「都按推荐」）**：

| # | 裁定值 |
| --- | --- |
| 1 | 追踪区放**既有工作流详情 `Drawer` 内**（与「工作流图」「事件时间线」并列）；树组件外置到 `components/` |
| 2 | **不碰 `/trace` 端点**——决策事件由既有事件时间线承载，Sandbox 不补节点 |
| 3 | **递归可折叠树**（不用扁平列表） |
| 4 | **新造 TF-01 … TF-07**，并在 `docs/17` 新增「追踪前端 · 端到端追踪视图的前端呈现」节（已登记） |
| 5 | **只做工作流详情内的追踪**，不做需求页 / AgentRun 页的反向跳转 |

## 7. 红线（不得违反）

- **`AGENTS.md` §10 架构不变量**：追踪是**只读派生**——前端不得出现任何修改追踪内容、任务结果、状态机或审批语义的动作。
- **凭据零外泄**：树里的 `detail` 已由后端脱敏（`redactCredentialShapedText` + 白名单标量）；前端**不得**为"看得更全"而额外请求工具输入 / 输出。
- **不新增第二套口径**：节点计数以 `view.counts` 为准，前端不自算第二份。
- **不碰后端**（TF-07）：本阶段变更文件全部落在 `apps/web/`。
- **不引入新依赖**。
- **不动** `DashboardView`、不动 Phase 7 已收口的任何实现。

## 8. 依赖

| 依赖 | 状态 |
| --- | --- |
| `GET /api/workflows/:id/trace`（7-C） | **已交付**（`docs/150`） |
| `TraceNode` / `WorkflowTraceView` 类型（`packages/shared`） | **已交付**（跨包类型只来自 `@ai-se/shared`，前端不自造） |
| 前端骨架与共享件（W1–W13） | **已收口**（`docs/133–145`） |
| a11y 扫描器 | **已建**（`docs/143`，`docs/145` 扩展过） |
| 事件时间线（承载自治决策事件） | **已交付** |
| 新依赖 | **无** |

## 9. 与其它在途事项的关系

- **L1-M4 批次（进行中）**：本阶段与它**零接触面**——批次跑在专用实例 47558 上，本阶段只改 `apps/web`，既不重启它，也不改它依赖的代码。两者可并行。
- **`docs/01–14` 重新基线**：无关系，互不影响。
- **Phase 8 AI SRE**：**无依赖**。Phase 8 的「诊断数据源」若日后要用追踪树，消费的正是本阶段呈现的同一份 API，但那是 Phase 8 自己的事。
