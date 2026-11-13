# 失败工作流重试（Retry Failed Workflow）— 实施记录

> 任务书:`docs/99-failure-retry-taskbook.md`(保留原样,未改写)
> 编号说明:本文件取 docs 下一个空号 100,未覆盖任何既有文档。
> 仓库无 git:变更核对以文件清单为准(见 §Modified Files)。
> 本文记录三轮:首轮实现 + 次轮对 docs/99 §四 逐条完成度审计后的补强(见 §完成度审计补强)
>
> - 用户确认后的 docs/15 / docs/18 进度同步(见 §Modified Files 末条)。

---

## Modified Files

**workflow-engine(3 源码 + 2 测试)**

- `packages/workflow-engine/src/stateMachine.ts` — 新增 `WORKFLOW_TRANSITIONS.FAILED = ["RUNNING"]` 与 `TASK_TRANSITIONS.BLOCKED = ["CANCELLED", "PENDING"]`(各带一行用途注释)。
- `packages/workflow-engine/src/types.ts` — `WorkflowRunPatch` 追加 `clearError?` / `clearFinishedAt?` 两个可选布尔。
- `packages/workflow-engine/src/WorkflowEngine.ts` — 新增 `retry(id)`;`start()` 收紧为仅 `PENDING`、`resume()` 收紧为仅 `PAUSED`。
- `packages/workflow-engine/src/stateMachine.test.ts` — 新增"manual-retry edges"用例(FAILED→RUNNING / BLOCKED→PENDING 为真,SUCCESS/CANCELLED→RUNNING 仍为假)。
- `packages/workflow-engine/src/WorkflowEngine.test.ts` — `MemoryStore` 支持 `clearError`/`clearFinishedAt` 并记录 `taskWrites`/`workflowWrites`;新增 `WorkflowEngine retry` describe(7 例)。

**database(1)**

- `packages/database/src/workflowRepositories.ts` — `updateWorkflow` SQL:`error` / `finished_at` 改为 `CASE WHEN $8/$9 THEN NULL ELSE COALESCE(...) END`,参数追加 `patch.clearError ?? false`、`patch.clearFinishedAt ?? false`(其它调用方不传 = 行为不变)。

**server(2 源码 + 1 测试)**

- `apps/server/src/services/workflowService.ts` — 新增 `retry(id)`;`runTransition` 追加四条消息映射(四条中文文案 + `NO_RETRYABLE_TASKS` / `RETRY_BLOCKED_BY_APPROVAL` 两个新 code,状态不合法与竞态复用 `INVALID_WORKFLOW_TRANSITION`)。
- `apps/server/src/routes/workflows.ts` — 动作循环加入 `"retry"`(`POST /api/workflows/:id/retry`)。
- `apps/server/src/__tests__/workflowApi.e2e.test.ts` — 追加 `runCounts` / `clearFailureInjection` helper 与 4 个用例(重试成功+跳过已完成 / 重试仍失败有界 / 守卫 / BLOCKED 恢复)。

**web(4 源码 + 4 测试)**

- `apps/web/src/api/workflows.ts` — `workflowAction` action 联合加 `"retry"`。
- `apps/web/src/stores/workflows.ts` — `act` action 联合加 `"retry"`。
- `apps/web/src/viewmodels/workflowViewModel.ts` — 新增 `canRetry(status)`;`workflowEventView` 追加 `TASK_RETRY_REQUESTED` / `WORKFLOW_RETRIED` 两个展示分支(既有事件零改动)。
- `apps/web/src/views/WorkflowsView.vue` — import `canRetry`;「继续」与「取消」之间新增「重试失败任务」按钮(`v-if="canRetry(status)"`、`disabled=acting`)。
- `apps/web/src/__tests__/workflowViewModel.test.ts` / `apps/web/src/stores/__tests__/workflows.test.ts` / `apps/web/src/__tests__/workflowsView.test.ts` — 各追加 1 个用例(canRetry 映射 / act('retry') 打点 / SSR 按钮可见性)。
- `apps/web/src/api/__tests__/workflows.test.ts`(新增)— api 层断言 `workflowAction(id, "retry")` 的 URL 与 method(stub fetch;store 层测试整体 mock 了 api 模块,URL/method 只能在本层断言)。

**docs**

- `docs/100-retry-failed-workflow.md`(本文件,新增)。
- `docs/19-user-manual.md` — §4 页面表工作流一行补「重试失败工作流」;§6 新增「重试失败任务」小节(五条语义)。
- `docs/15-development-roadmap.md` / `docs/18-phase-engineering-goals.md` — 按用户确认补记「Post-V1 Enhancements(V1 后增强)」小节(本任务书 §六 明确非强制,记录完成后经用户确认同步)。

**文件清单核对**(仓库无 git,以 find 为准):`find apps packages -type f -newermt '-30 minutes' -not -path '*/node_modules/*' -not -path '*/dist/*'` 命中 **17 个文件**,与本清单逐项一致,无多余改动;`docs/99`(任务书,本任务创建)与 `docs/19` 为文档改动,`docs/1`~`docs/98` 未改写。

**未触碰**:除本清单列出的文档外,`docs/` 其余历史文档一律未改写(`docs/99` 任务书保留原样);无新依赖、无 migration、无新表。

---

## Implementation

1. **引擎 `retry(id)`**(与任务书 §三.3 一致):仅 `FAILED` 工作流可重试 → 计算"未解决失败"(与 `advanceOnce` 的 `unresolvedFailure` 判定同源:`FAILED && (!resolvedByTaskId || resolvedByTaskId 非 SUCCESS)`)与 `BLOCKED` 任务 → 审批非 APPROVED 则整单拒绝 → 全部未解决失败 `FAILED → RETRYING`(`failureHandled=false`、`clearClaim`,计数不变)并记 `TASK_RETRY_REQUESTED{from:"FAILED"}` → `BLOCKED → PENDING` 并记 `TASK_RETRY_REQUESTED{from:"BLOCKED"}` → 原子翻转 `FAILED → RUNNING`(`clearError`/`clearFinishedAt`,`expectedStatuses` 即双击去重闸门)并记 `WORKFLOW_RETRIED{retriedTaskKeys,requeuedTaskKeys}` → `void advance(id)`。
2. **零新增调度逻辑**:重排后由既有 `readyTaskIds`(只取 PENDING/RETRYING)→ `claimNextTask` → executor → ToolRuntime → 审批/审计 链继续执行;SUCCESS / 已解决失败 / RUNNING / WAITING_APPROVAL 任务一律不触碰。
3. **入口收紧**:`start()` 仅 `PENDING`、`resume()` 仅 `PAUSED`(防止新增的 `FAILED → RUNNING` 边被 `/start`、`/resume` 当作"半恢复"使用)。
4. **前端**:失败态显示「重试失败任务」,点击走既有 `act('retry')` → `POST /api/workflows/:id/retry` → `loadWorkflow`(实时流按既有 `terminal()` 判定自动重启);时间线新增两个事件的中文摘要与明细行。

### 行为矩阵(重排任务再次失败,全部为既有 `handleFailures` 分支)

| `failureStrategy` | 行为                                                               |
| ----------------- | ------------------------------------------------------------------ |
| FAIL_FAST         | 工作流再次 FAILED(可再次手动重试)                                  |
| RETRY             | `retryCount < maxRetries` → 既有自动重试;否则再次 FAILED           |
| REPLAN            | `executionAttempt < maxRetries` → 既有 REPLAN 链;否则 FAILED       |
| CONTINUE          | 失败任务保持 FAILED,工作流继续推进其余任务,最终因未解决失败 FAILED |
| ROLLBACK          | 非 DEPLOY 失败落到终结分支 → 工作流 FAILED                         |

### 决策表(任务书 §二.6,A5 冻结值,已按此实现)

| #   | 决策点         | 实现结果                                                                  |
| --- | -------------- | ------------------------------------------------------------------------- |
| D1  | 重试计数       | 不修改 `retryCount` / `input.executionAttempt`(单测断言重排前后相等)      |
| D2  | stale 字段     | 翻转时清空 `error` / `finished_at`(单测 + e2e 断言)                       |
| D3  | 审批被拒绝任务 | 整单拒绝:409 `RETRY_BLOCKED_BY_APPROVAL`,工作流与任务零改动(单测断言零写) |
| D4  | 重试范围       | 仅 `FAILED` 工作流;DEPLOY 不特判,回滚语义由"已解决失败"规则承接           |
| D5  | 工作区语义     | 不回滚副作用;语义写入 `docs/19` 用户手册                                  |

---

## Architecture Changes

1. **状态机两条边**(本任务唯一契约级改动):`FAILED → RUNNING`(唯一用途 = `retry()`)、`BLOCKED → PENDING`(派生态重置,幂等)。未新增状态、未新增实体、未新增引擎。
2. **`WorkflowRunPatch` 加法式扩展**(两个可选布尔,默认不传行为不变)—— 复用既有 `updateWorkflow` 通道,未新建 store 方法。
3. **入口前置显式化**(行为收紧,见 Known Issues):`start()`/`resume()` 不再依赖"转换表里恰好有 RUNNING"。
4. **零第二套**:无新表 / migration / 依赖 / 审批 / 审计 / 错误码体系;新事件类型仅 2 个(观测性,不改变既有事件语义)。

---

## Dependencies

无新增依赖(`package.json` 未改动)。

---

## Tests

| 套件                                                                                                                                                             | 结果                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/workflow-engine`(stateMachine / scheduler / WorkflowEngine)                                                                                            | **28/28 通过**(新增 8 例:状态机新边 1 + retry 7;含重排范围、已解决失败不重排、计数不变、`failureHandled` 复位、零写拒绝、双击竞态、策略回退、start/resume 收紧)                         |
| `packages/database`                                                                                                                                              | **43/43 通过**(`updateWorkflow` 的 clear 语义由 server e2e 断言)                                                                                                                        |
| `apps/server`                                                                                                                                                    | **94/94 通过**(新增 4 例 e2e,基线 90;真实 Docker PostgreSQL + 脚本模型)                                                                                                                 |
| `apps/web`                                                                                                                                                       | **286 通过 / 293**(7 个失败为**先存** eyebrow 用例:agentsView / dashboardView / deploymentsView / mcpAppView / mcpServersView / projectDetailView / requirementsView;新增 api 层用例 1) |
| 其余包(observability 2、shared 48、evidence 9、visual 83、sandbox 2、failure-recovery 16、tool-runtime 12、action-policy 13、browser 38、agent-core 63、mcp 235) | 全部通过                                                                                                                                                                                |
| **全仓合计**                                                                                                                                                     | **979 例:972 通过 / 7 失败(全部先存,与本任务无关)**                                                                                                                                     |

### 完成度审计补强(对 docs/99 §四 逐条核对后)

1. §四.2「事件序列:…→ 之后 advance 产生的 `TASK_READY` / `TASK_STARTED`」→ 在 T1 补断言:`WORKFLOW_RETRIED` 的下标 < 首个 `TASK_READY` 下标,且存在 `TASK_STARTED`。
2. §四.2「`retryCount` 与 `input.executionAttempt` 重排前后相等」→ T1 的 B 任务改为携带 `input: { executionAttempt: 1 }` 并断言保持(原先只断言 `input` 为空对象);另补 A / C 的"状态未变"断言(原先只断言写调用为零)。
3. §四.3-R1「B 恰好 +1 且成功;C 恰好 +1 且成功」→ e2e R1 补 B / C 的 `status === "SUCCESS"` 显式断言。
4. §四.4「断言 URL 与 method」→ 新增 api 层测试文件(见 Modified Files);store 层测试保持 `act("retry") → workflowAction("workflow-1","retry") + 刷新详情`。
5. 复跑门禁:全仓 typecheck / lint / build exit 0;全仓测试 **979 例:972 通过 / 7 先存失败**;全部改动文件(含三份 docs)`prettier --check` 通过。

---

## Lint

`corepack pnpm -r run lint` → **exit 0**(0 error;含改动包与全仓)。

---

## Typecheck

`corepack pnpm -r run typecheck` → **exit 0**(0 个 `error TS`)。

---

## E2E

真实链路(非 mock):

1. `apps/server/src/__tests__/workflowApi.e2e.test.ts`(真实 PostgreSQL 容器 + 真实 WorkflowEngine + 脚本模型):**11/11 通过**(原 7 + 新增 4):
   - **R1 重试成功 + 跳过已完成**:A→B→C 计划,B 注入 `failuresBeforeSuccess:1` → 工作流 FAILED(B=FAILED,C=PENDING);`runCounts` 基线 `{A:1,B:1}`;移除注入 → `POST /retry` 返回 200 且状态 RUNNING → 终态 SUCCESS(B / C 显式断言 `SUCCESS`);**`runCounts` = `{A:1,B:2,C:1}`(A 不重跑 = 不重烧 token 的直接证据)**;`error`/`finishedAt` 已被清空;事件含 `TASK_RETRY_REQUESTED` + `WORKFLOW_RETRIED`。
   - **R2 重试仍失败有界**:不修注入 → retry → 再次 FAILED,TEST 的 run 数 1 → 2(无自动循环)。
   - **R3 守卫**:SUCCESS 工作流 retry → 409 `INVALID_WORKFLOW_TRANSITION`;RUNNING 工作流 retry → 409。
   - **R4 BLOCKED 恢复**:`CONTINUE` 策略下 B 失败 → C=BLOCKED、工作流 FAILED;移除注入 → retry → C 恢复执行、工作流 SUCCESS。
2. **live 路由烟测(只读,零数据影响)**:对运行中的服务(:3000,PID 3479,19:09:41 自动重启已加载新 dist)执行 `POST /api/workflows/<随机 UUID>/retry` → `HTTP 404 {"code":"WORKFLOW_NOT_FOUND"}` —— 证明新路由已在运行实例上挂载。
3. **未做**:真实浏览器点击「重试失败任务」的端到端走查(需在用户开发库上创建/失败一个真实工作流;前端由 SSR 契约测试 + store/viewmodel 测试覆盖,接口由真实 PG e2e 覆盖)。

---

## Known Issues

1. **行为收紧(必读)**:`start()` 现在仅接受 `PENDING`、`resume()` 仅接受 `PAUSED`。此前 `resume` 在 `PENDING`/`WAITING_APPROVAL` 上、`start` 在 `PAUSED`/`WAITING_APPROVAL` 上会因转换表"恰好允许 RUNNING"而意外成功;收紧是新增 `FAILED → RUNNING` 边的必要配套(否则两个入口都能在失败工作流上"半恢复")。既有测试仅对 `PAUSED` 调用过 `resume`,未改动任何既有断言。
2. **审批被拒绝的工作流不可重试**(D3):`approvals` 按 `task_id` 唯一且 `approve()` 只认 `PENDING`,重排后会被停在 `WAITING_APPROVAL` 且永远批不了;v1 选择整单拒绝并给出中文文案。若要支持,需要"审批重置回 PENDING"的独立任务。
3. **手动重试不刷新自动预算**(D1):重排后的任务再次失败时按当前策略处理 —— `FAIL_FAST` 下每次点击重试 = 一次新尝试;`RETRY` 下按剩余预算自动重试;`retryCount` 不回退(任务行"尝试 N 次"保持真实历史,轮次历史完整保留在 `workflow_events` 与 `agent_runs`)。
4. **副作用不回滚**(D5):重试在当前工作区现状上重跑,平台无工作区快照;非幂等动作(DEPLOY / Git)仍走既有交付编排与审批门,本任务未新增回滚语义。
5. **`finishedAt`/`startedAt` 语义**:工作流重开后 `finished_at` 被清空,成功完成时重写;任务行的 `finishedAt` 保留旧值直到该任务再次完成(可接受,未额外清理)。
6. **前端 prettier 基线**:`apps/web` 的 `.vue` 与测试文件不在本仓 prettier 门禁内(仓库既有基线);`src/viewmodels/*.ts` 与本次改动的 server/engine/database 文件已过 `prettier --check`。`docs/17-acceptance-checklist.md` 存在先存 prettier 告警(非本任务引入,未处理)。
7. **`docs/17` 未勾选/未新增条目**:本任务属 V1 后增强(与 UX-01~03 同族),不在其章节范围内;对照关系见任务书 §七。
8. **实时烟测范围**:未在用户开发库上创建真实失败工作流做浏览器走查(避免污染真实数据);如需,可在获得授权后进行。

---

## Acceptance Result

**PASS** —— 任务书 §三交付物全部落地;§四测试要求全部执行(引擎/数据库/server/web + 全仓四门禁);

核心验收点均有真实证据:

- 失败工作流可重试并继续执行(e2e R1/R4,真实 PG)。
- **已完成任务跳过、不重烧 token**(e2e R1:`runCounts` 中 A 的计数不变)。
- 重试仍失败时有界、无自动循环(R2)。
- 守卫完备(非 FAILED 拒绝、双击竞态、审批被拒零改动:R3 + 引擎单测)。
- 治理不破(重排任务经 `claimNextTask → executor → ToolRuntime`,无旁路)。
- 全仓 `typecheck` / `lint` / `build` exit 0;测试 **972/979**(7 个失败全部为先存 eyebrow 用例);改动文件(含 docs)`prettier --check` 通过。

---

## Next Phase Boundary(STOP)

**未开始、且不在本任务范围**:

1. 5.7-5 `failureRouter` 生产接线(失败 → 人工审批边界)。
2. 工作区快照 / 副作用回滚;durable checkpoint(LangGraph 持久化)与 run 内断点续跑。
3. Agent 侧重试策略(LLM 调用级分类+退避、失败分类门控、重试上下文注入)。
4. 审批重置(支持被拒审批任务的重试)。
5. 对 `SUCCESS` / `CANCELLED` / `RUNNING` 工作流的重试(明确不支持,非遗漏)。
6. `docs/15` / `docs/18` 的进度同步(按任务书约定不强制;如需另行执行)。

**STOP —— 本任务到此结束,等待下一条指令。**

---

## 勘误追加块（2026-10-19，PL-M19）

**本块只追加更正，正文按历史记录保留不改**（`docs/146` §6 规则 7）。

**被本块更正的原文**：第 55 行「计算"未解决失败"(与 `advanceOnce` 的 `unresolvedFailure` 判定同源:`FAILED && (!resolvedByTaskId || resolvedByTaskId 非 SUCCESS)`)」。

**更正**：该判定**只认直接指针**，会把「第二层才救回来」的失败误判为未解决（缺陷编号 **N-12**）。PL-M19 已改为**沿 `resolvedByTaskId` 链走到头**，判定实现于 `packages/workflow-engine/src/resolution.ts`，两个调用点（`retry()` 与 `advanceOnce()`）现在**共用同一处**——本文写作时那句「同源」只是注释里的声明，没有任何机制保证。

**行为变化面**：只影响**解析链长 ≥ 2** 的情形。链长 0（无指针）与链长 1（直接命中 `SUCCESS` / 直接命中 `FAILED`）的判定**逐字不变**——本文的 D4、§二.3 与全部验收结论因此**不受影响**。

**另需登记**：本文描述的重试机制本身（`FAILED → RETRYING`、`BLOCKED → PENDING`、零新增调度逻辑、SUCCESS 零触碰）**一字未变**。勘误只涉及「未解决失败」的**判定口径**。详见 `docs/185`（任务书）与 `docs/186`（实施记录）。
