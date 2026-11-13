# 107 · 交付链任务与项目交付能力不匹配（REPOSITORY_NOT_CONFIGURED）+ 规划期守卫

## 现象
工作流在 T10「CI 构建与制品验证」连续 3 次失败，错误 `REPOSITORY_NOT_CONFIGURED / Project has no repository configured`，整条工作流 FAILED。

## 根因（代码 + 数据）
1. 规划提示词**无条件**要求「以 CI BUILD → staging DEPLOY → staging VERIFY → production DEPLOY 收尾」→ 本次规划生成 T10(CI)/T11(staging)/T12(VERIFY)/T13(production)，均带 `input.delivery`。
2. `RoutingWorkflowTaskExecutor` 按 `canHandle()` 把 `BUILD+CI` / `DEPLOY+DEPLOY|ROLLBACK` / `TEST+VERIFY` 交给 `DeploymentOrchestrator`（不是专业 Agent）。
3. `runCi()` 第一件事就要求 `project.repository`；项目 `75f28c0c「画个自行车」` 的 `repository_id` 为 NULL（`repositories` 表 0 行）→ 直接失败。
4. 即便绑定仓库也过不去：`CI_PROVIDER=local` 的本地 CI 在工作区里执行 `git rev-parse` + `pnpm install/lint/typecheck/test/build` + `docker build`，对静态交付项目不适用。
→ 结论：**计划与项目交付能力不匹配**，属「计划期可执行性」问题（与 docs/104 同类）。

## 改动（防复发：规划期守卫）
- `packages/agent-core/src/planning/prompts/task-planning.prompt.ts`：改为 `taskPlanningPrompt({ deliveryConfigured })`；`false` 时以 `NO_REPOSITORY_LINE` 取代「以交付链收尾」的要求；`TASK_PLANNING_PROMPT` 保留为默认常量（具备交付能力）。
- `packages/agent-core/src/planning/validateTaskGraph.ts`：`validateTaskGraph(plan, { deliveryConfigured })`；显式 `false` 时拒绝任何带 `delivery` 的计划项 → 交给规划器修复轮重规划；`undefined` 不校验（保持既有行为）。
- `PlanningGraph` / `PlanningAgent`：新增并透传 `deliveryConfigured`。
- `apps/server/src/services/planningService.ts`：`deliveryConfigured: Boolean(project?.repository)`。

## 验证
- agent-core **83/83**（+5：未绑定仓库时拒绝交付项 / 已绑定与未指定不误伤 / 规划图层面拦截并切换提示词 / 已绑定时保留交付链要求）、apps/server **95/95**；typecheck / lint 全绿；dist 已重建、服务已重启（11:42:56，`/health` 200）。
- 规划图层面实测：默认 Todo 夹具本身以 CI/DEPLOY/VERIFY/DEPLOY 收尾（正是运行期必然失败的形状）→ `deliveryConfigured: false` 时被守卫拦下，事件 `TASK_DAG_VALIDATION_FAILED` + `PLANNING_REPAIR_REQUESTED`。

## 数据调整（用户已批准）
工作流 `49a6cd7d` 摘除 T10–T13（外键全 CASCADE：11 条事件、0 产物、0 审批），计划回到 T1–T9（全部 SUCCESS），工作流收敛为 **SUCCESS**（`WORKFLOW_COMPLETED`，taskCount=9）。

## 已知缺口（本次绕过，未修）
`WorkflowEngine.retry()` 在 `failed.length === 0 && blocked.length === 0` 时抛 `No retryable tasks`（409）——摘除失败任务后，该入口无法再把工作流翻回 RUNNING。本次用状态机既有边（FAILED→RUNNING，即 retry 内部使用的那条）+ `pause`/`resume`（resume 会触发 advance）收敛：`WORKFLOW_PAUSED → WORKFLOW_RESUMED → WORKFLOW_COMPLETED SUCCESS`。引擎是**事件驱动**推进（start/resume/retry/approval/任务完成回调 + 启动 `recover()`），无轮询循环。
