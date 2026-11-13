# 失败工作流重试（Retry Failed Workflow）任务书

> 使用方式:复制下方分割线内全部内容,作为本次任务的执行指令。
> 本任务书已按 AGENTS.md 校准(阶段纪律 / 架构不变量 / 报告固定节);编码默认 ponytail(最小 diff)+ 以代码为准。
> 本任务不引入任何新库,不需要 Context7 查询。
> A5 五项决策已按"建议默认值"定稿并冻结为 §二.6 决策表 —— 执行期不得更改;若认为某条不合理,停下报告,不要自行调整。
> 编号说明:本文件取 docs 下一个空号 99,未覆盖任何既有文档;实施记录落 `docs/100-retry-failed-workflow.md`。

---

You are now implementing AI-SE「失败工作流重试」(Retry Failed Workflow)。

唯一目标:让 **FAILED 的工作流**可以人工重试 —— 未解决的失败任务重新排队、被阻塞任务重新评估、工作流回到 RUNNING 并沿**既有**调度/执行链继续跑完;**已完成(SUCCESS)任务一律跳过,不重跑、不新增 AgentRun(不重烧 token)**。

范围边界(本任务不做,详见 §五):不接 5.7-5 `failureRouter`;不做 Agent 运行内重试策略(LLM 调用重试 / durable checkpoint 断点续跑);不做工作区快照与副作用回滚;不新增表 / migration / 依赖 / 状态 / 第二套引擎。

---

### 一、开始实现前必须先阅读

以代码为准;文档与代码冲突时报告冲突,不默默修改任一方。

文档:

1. `docs/05-task-and-state-model.md` — 任务状态表(FAILED / RETRYING / BLOCKED 的既有语义)
2. `docs/04-workflow-engine.md` — 动态能力边界(retry / re-plan / rollback / approval 属 Workflow Engine 职责)
3. `docs/17-acceptance-checklist.md` §V1 Real AI Validation — `Retry / Recovery 正常` 是未勾选项;本任务为它提供人工恢复出口,但不代替该项验收(见 §七)
4. `docs/57-phase-5.7-5-failure-recovery.md` — 既有恢复语义;注意其"人工拒绝即终结"规则与本次 D3 的关系(§二.8)
5. `docs/59-real-ai-validation.md` — 验证期不得为某次实验修改 Workflow;本任务属平台能力建设,不参与该实验
6. `docs/98-agent-result-parse-robustness.md` — 真实失败现场(T2 三次尝试全败 → 工作流钉死、无出口),本任务解决的正是它暴露的缺口

代码(逐处核实真实行为,尤其是 SQL 的 COALESCE 语义与调度器候选集):

1. `packages/workflow-engine/src/stateMachine.ts` — 现有转换表(FAILED: []、BLOCKED: ["CANCELLED"])
2. `packages/workflow-engine/src/WorkflowEngine.ts` — `advanceOnce` / `handleFailures` / `persistTaskResult` / `failWorkflow` / `recover`;注意 `unresolvedFailure` 判定表达式
3. `packages/workflow-engine/src/scheduler.ts` — `readyTaskIds` 只取 PENDING/RETRYING("跳过已完成任务"的依据)
4. `packages/workflow-engine/src/types.ts` — `WorkflowStore` / `WorkflowRunPatch` / `WorkflowTaskPatch`
5. `packages/database/src/workflowRepositories.ts` — `updateTask` / `updateWorkflow` / `claimFailureHandling` / `claimNextTask` 的真实 SQL
6. `apps/server/src/services/workflowService.ts` — 私有错误映射 `runTransition`
7. `apps/server/src/routes/workflows.ts` — 动作路由循环(62 行)
8. `apps/server/src/__tests__/workflowApi.e2e.test.ts` — 必须复用的 e2e harness(`startPostgres` / `plan` / `plannedTask` / `createRequirement` / `createAndStart` / `terminal`)
9. 前端四处 + 对应测试:`apps/web/src/api/workflows.ts`、`stores/workflows.ts`、`viewmodels/workflowViewModel.ts`(含 `workflowEventView` 事件映射)、`views/WorkflowsView.vue`

环境(每次会话先做一次):

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
corepack pnpm --version   # 只用 corepack pnpm
```

仓库无 git:变更核对用文件清单(`find apps packages -type f -newermt '-N minutes' -not -path '*/node_modules/*' -not -path '*/dist/*'`),报告 Risks 注明。server e2e 需要本地 Docker(postgres:16-alpine 测试容器,`--tmpfs` 已内建在既有 harness)。

---

### 二、先做架构分析,再动手(报告须逐条确认)

1. **复用面(零新增调度逻辑)**:任务状态机已有 `FAILED → RETRYING` 与 `RETRYING → READY`;调度器候选集 = PENDING/RETRYING。因此"重试后跳过已完成任务、继续执行剩余任务"完全由既有链实现 —— `retry()` 只负责**重新排队**,不接管调度。
2. **失败一次性闸门**:`failure_handled` 是引擎"该失败已处理"的标记(`claimFailureHandling` 置 true),`handleFailures` 只处理 `FAILED && failureHandled !== true`。重排必须复位 `failureHandled=false`,否则该任务再次失败时永远不会被引擎接管。**复位只发生在手动重试路径**,自动路径零改动。
3. **未解决失败判定复用引擎权威定义**:`FAILED && (!resolvedByTaskId || resolvedByTaskId 不是 SUCCESS)`(见 `advanceOnce` 内的 `unresolvedFailure` 表达式)。重排范围 = 该表达式 + `BLOCKED`。**由此天然承接 ROLLBACK 语义**:被成功回滚任务解决的失败(`resolvedByTaskId` 指向 SUCCESS)属于"已解决失败",不重排 —— 不新增 DEPLOY 特判。
4. **状态机两条新边 + 入口前置显式化**:新增 `WORKFLOW_TRANSITIONS.FAILED = ["RUNNING"]` 与 `TASK_TRANSITIONS.BLOCKED = ["CANCELLED", "PENDING"]`。**连带必须收紧 `start()`(仅 PENDING)与 `resume()`(仅 PAUSED)**:否则新增边会让 `POST /start`、`POST /resume` 在 FAILED 工作流上"半恢复"(翻成 RUNNING 但不重排任务)。这是本任务唯一的行为收紧,须在报告 Known Issues 中列明并加测试。
5. **执行顺序**:先重排任务(FAILED→RETRYING、BLOCKED→PENDING,幂等)→ 再原子翻转工作流(`updateWorkflow(id, ["FAILED"], {status:"RUNNING", clearError:true, clearFinishedAt:true})`,`expectedStatuses` 即双击去重闸门;返回 null 说明状态已变 → 抛错)→ 最后 `void this.advance(id)`。翻转前任何一步失败都不改变工作流状态。
6. **决策表(A5 冻结值,执行期不得更改)**:

| #   | 决策点         | 冻结值                                                                                                                                                                                                                                                  |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 重试计数       | **不修改** `task.retryCount`、**不修改** `task.input.executionAttempt`。手动重试 = "把失败任务重新排队一次";重排任务再次失败时完全按既有策略处理(§二.7 行为矩阵)。                                                                                      |
| D2  | stale 字段     | 翻转时清空工作流 `error` 与 `finished_at`(给 `WorkflowRunPatch` 加 `clearError` / `clearFinishedAt` 可选布尔;SQL 用 `CASE WHEN`,不传时行为不变)。否则列表"用时"会停留在上次失败时刻。                                                                   |
| D3  | 审批被拒绝任务 | v1 **整单拒绝重试**:任一待重排任务存在非 APPROVED 的审批记录 → 抛错 → 409,工作流与任务零改动。理由:`approvals` 按 `task_id` 唯一且 `approve()` 只认 PENDING,重排后会被停在 WAITING_APPROVAL 且永远批不了。"审批重置回 PENDING"列为可延期项,不在本任务。 |
| D4  | 重试范围       | 仅 `status === "FAILED"` 的工作流可重试;SUCCESS / CANCELLED / RUNNING 一律 409。DEPLOY 类失败任务不特判(回滚语义由 §二.3 的"已解决失败"规则承接)。                                                                                                      |
| D5  | 工作区语义     | 重试在**当前工作区现状**上重跑,副作用不回滚(平台无快照);不实现快照 / 断点续跑。该语义写入 docs/19 用户手册。                                                                                                                                            |

7. **重排任务再次失败时的行为矩阵(全部为既有 `handleFailures` 分支,不新增分支;写进文档即可)**:

| `workflow.policy.failureStrategy` | 重排任务再次失败时的行为                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| FAIL_FAST                         | 工作流再次 FAILED(可再次手动重试)                                                                 |
| RETRY                             | `retryCount < maxRetries` → 引擎按剩余预算自动重试;否则再次 FAILED                                |
| REPLAN                            | `input.executionAttempt < maxRetries` → 再次进入既有 REPLAN 链(新建 DEBUG + REPLAN-n);否则 FAILED |
| CONTINUE                          | 该任务保持 FAILED(failure_handled=true),工作流继续推进其余任务,最终因未解决失败 FAILED            |
| ROLLBACK                          | 非 DEPLOY 失败落到终结分支 → 工作流 FAILED                                                        |

8. **审批面**:审批被拒任务按 D3 拒绝整单;`WAITING_APPROVAL` 任务**无需特殊处理**(不在重排范围;重试后由既有审批流继续:`approve()` 置 READY,工作流已是 RUNNING 时后续 `advance` 正常调度)。
9. **零第二套**:无新表、无 migration、无新状态、无第二套引擎/审批/审计;新增物 = 引擎一个方法 + 两个事件类型 + 两个 AppError code + 一处复用 SQL 开关。
10. **事件与审计**:`TASK_RETRY_REQUESTED`(每任务一条)+ `WORKFLOW_RETRIED`;历史 `WORKFLOW_FAILED` / `TASK_FAILED` 事件不删除(失败证据保留)。
11. **并发边界**:工作流 FAILED 时可能仍有并发任务处于 RUNNING(maxConcurrency>1 的既有行为);重排不触碰 RUNNING 任务,其完成回调照常 `persistTaskResult + advance`,并发由既有 `advancing` / `rerun` 守卫串联,不新增锁。

---

### 三、交付物定义

**1. `packages/workflow-engine/src/stateMachine.ts`(仅两处表改动 + 注释)**

```ts
const WORKFLOW_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  PENDING: ["RUNNING", "CANCELLED"],
  RUNNING: ["PAUSED", "WAITING_APPROVAL", "SUCCESS", "FAILED", "CANCELLED"],
  PAUSED: ["RUNNING", "CANCELLED"],
  WAITING_APPROVAL: ["RUNNING", "PAUSED", "FAILED", "CANCELLED"],
  SUCCESS: [],
  // 唯一用途 = WorkflowEngine.retry(人工重试出口);start()/resume() 已显式收紧,不能走这条边。
  FAILED: ["RUNNING"],
  CANCELLED: []
};

const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ["READY", "WAITING_APPROVAL", "BLOCKED", "CANCELLED"],
  READY: ["RUNNING", "WAITING_APPROVAL", "CANCELLED"],
  RUNNING: ["SUCCESS", "FAILED", "CANCELLED"],
  WAITING_APPROVAL: ["READY", "FAILED", "CANCELLED"],
  SUCCESS: [],
  FAILED: ["RETRYING"],
  RETRYING: ["READY", "WAITING_APPROVAL", "BLOCKED", "CANCELLED"],
  // 新增 PENDING:BLOCKED 是派生态,重试时重置后由调度器重算(幂等)。
  BLOCKED: ["CANCELLED", "PENDING"],
  CANCELLED: []
};
```

**2. `packages/workflow-engine/src/types.ts`(`WorkflowRunPatch` 追加两个可选字段)**

```ts
export interface WorkflowRunPatch {
  status?: WorkflowStatus;
  output?: JsonObject;
  error?: ApiErrorBody;
  startedAt?: string;
  finishedAt?: string;
  /** retry 翻转 FAILED → RUNNING 时置 true:清空 error(否则 COALESCE 保留上次失败原因)。 */
  clearError?: boolean;
  /** retry 翻转时置 true:清空 finished_at(否则列表"用时"停留在上次失败时刻)。 */
  clearFinishedAt?: boolean;
}
```

**3. `packages/workflow-engine/src/WorkflowEngine.ts` — 新增 `retry(id)`;`start()` / `resume()` 收紧前置**

```ts
/**
 * 人工重试失败工作流:未解决失败任务 FAILED → RETRYING(复位 failure_handled)、
 * BLOCKED → PENDING、工作流 FAILED → RUNNING,随后交既有 advance() 继续。
 * SUCCESS / 已解决失败 / RUNNING / WAITING_APPROVAL 任务一律不触碰(范围见 D4 与 §二.3)。
 */
async retry(id: string): Promise<WorkflowRun> {
  const workflow = await this.requiredWorkflow(id);
  if (workflow.status !== "FAILED") throw new Error("Workflow is not failed");
  const tasks = await this.options.store.findTasks(id);
  const approvals = await this.options.store.findApprovals(id);
  const successful = new Set(tasks.filter((t) => t.status === "SUCCESS").map((t) => t.id));
  const failed = tasks.filter(
    (t) => t.status === "FAILED" && (!t.resolvedByTaskId || !successful.has(t.resolvedByTaskId))
  );
  const blocked = tasks.filter((t) => t.status === "BLOCKED");
  const approvalBlocked = failed.filter((t) =>
    approvals.some((a) => a.taskId === t.id && a.status !== "APPROVED")
  );
  if (approvalBlocked.length > 0) {
    throw new Error(
      `Retry blocked by rejected approval: ${approvalBlocked.map((t) => t.taskKey).join(", ")}`
    );
  }
  if (failed.length === 0 && blocked.length === 0) throw new Error("No retryable tasks");

  for (const task of failed) {
    assertTaskTransition(task.status, "RETRYING");
    const updated = await this.options.store.updateTask(task.id, ["FAILED"], {
      status: "RETRYING",
      failureHandled: false,
      clearClaim: true
    });
    if (!updated) throw new Error("Task state changed before retry");
    await this.event(
      id,
      "TASK_RETRY_REQUESTED",
      { taskId: task.id, taskKey: task.taskKey, from: "FAILED" },
      task.id
    );
  }
  for (const task of blocked) {
    assertTaskTransition(task.status, "PENDING");
    const updated = await this.options.store.updateTask(task.id, ["BLOCKED"], { status: "PENDING" });
    if (!updated) throw new Error("Task state changed before retry");
    await this.event(
      id,
      "TASK_RETRY_REQUESTED",
      { taskId: task.id, taskKey: task.taskKey, from: "BLOCKED" },
      task.id
    );
  }

  assertWorkflowTransition(workflow.status, "RUNNING");
  const updated = await this.options.store.updateWorkflow(id, ["FAILED"], {
    status: "RUNNING",
    clearError: true,
    clearFinishedAt: true
  });
  if (!updated) throw new Error("Workflow state changed before retry");
  await this.event(id, "WORKFLOW_RETRIED", {
    retriedTaskKeys: failed.map((t) => t.taskKey),
    requeuedTaskKeys: blocked.map((t) => t.taskKey)
  });
  void this.advance(id);
  return updated;
}
```

`start()` / `resume()` 前置收紧(各自在 `requiredWorkflow` 之后立刻判断):

```ts
if (workflow.status !== "PENDING") throw new Error("Workflow is not pending"); // start()
if (workflow.status !== "PAUSED") throw new Error("Workflow is not paused"); // resume()
```

**4. `packages/database/src/workflowRepositories.ts` — `updateWorkflow` SQL 支持两个 clear 开关**

```sql
UPDATE workflow_runs SET
  status = COALESCE($3, status), output = COALESCE($4, output),
  error = CASE WHEN $12 THEN NULL ELSE COALESCE($5, error) END,
  started_at = COALESCE($6, started_at),
  finished_at = CASE WHEN $13 THEN NULL ELSE COALESCE($7, finished_at) END
WHERE id = $1 AND status = ANY($2::text[])
RETURNING *
```

参数追加 `patch.clearError ?? false`、`patch.clearFinishedAt ?? false`。**其它调用方不传 = 行为完全不变。**

**5. `apps/server/src/services/workflowService.ts`**

```ts
async retry(id: string): Promise<WorkflowRun> {
  return await this.runTransition(() => this.engine.retry(id));
}
```

`runTransition` 追加四条消息映射(在既有分支之后):

```ts
if (message === "Workflow is not failed")
  throw new AppError(409, "INVALID_WORKFLOW_TRANSITION", "当前工作流不是失败状态，无法重试");
if (message === "No retryable tasks")
  throw new AppError(409, "NO_RETRYABLE_TASKS", "没有可重试的失败任务");
if (
  message === "Workflow state changed before retry" ||
  message === "Task state changed before retry"
)
  throw new AppError(409, "INVALID_WORKFLOW_TRANSITION", "工作流状态已变化，本次重试未执行");
if (message.startsWith("Retry blocked by rejected approval"))
  throw new AppError(
    409,
    "RETRY_BLOCKED_BY_APPROVAL",
    `以下任务的审批已被拒绝，无法重试：${message.split(":").slice(1).join(":").trim()}；请新建工作流或重新发起审批`
  );
```

**6. `apps/server/src/routes/workflows.ts` — 动作循环加一个成员**

```ts
for (const action of ["start", "pause", "resume", "cancel", "retry"] as const) { ... }
```

**7. 前端四处(加法式,不重写既有逻辑)**

```ts
// api/workflows.ts
export function workflowAction(
  id: string,
  action: "start" | "pause" | "resume" | "cancel" | "retry"
): Promise<WorkflowRun>

// stores/workflows.ts
async act(action: "start" | "pause" | "resume" | "cancel" | "retry")

// viewmodels/workflowViewModel.ts
/** FAILED 工作流的人工重试出口；仅状态判定，不参与业务逻辑（与 canStart/canPause/canResume 同族）。 */
export function canRetry(status: WorkflowStatus): boolean {
  return status === "FAILED";
}

// views/WorkflowsView.vue：import 列表加 canRetry（保持字母序），按钮插在「继续」之后、「取消」之前
<Button
  v-if="canRetry(workflows.current.workflow.status)"
  :disabled="workflows.acting"
  @click="workflows.act('retry')"
>
  重试失败任务
</Button>
```

`workflowEventView` 追加两个事件分支(既有事件行为零改动;不加则时间线只会显示"已记录"):

```ts
case "TASK_RETRY_REQUESTED": {
  summary = `${taskRef || "任务"}已重新排队`;
  tone = "warning";
  push("来源", payloadString(payload, "from") === "BLOCKED" ? "解除阻塞" : "失败重试");
  break;
}
case "WORKFLOW_RETRIED": {
  const retried = Array.isArray(payload.retriedTaskKeys) ? payload.retriedTaskKeys.length : 0;
  const requeued = Array.isArray(payload.requeuedTaskKeys) ? payload.requeuedTaskKeys.length : 0;
  summary = `工作流已重试（失败任务 ${retried} 个 / 解除阻塞 ${requeued} 个）`;
  tone = "warning";
  break;
}
```

**8. 文档**

- 新增 `docs/100-retry-failed-workflow.md`(实施记录:节序按 docs/16 固定节,另含"行为变更清单"与"已知限制")
- 更新 `docs/19-user-manual.md`:在「§6 Workflow 使用」补「重试失败任务」按钮说明(已完成任务跳过;在当前工作区现状上重跑,副作用不回滚;审批被拒绝时不可用;不消耗也不重置自动重试预算);§4 页面表的工作流一行同步提及「重试」

---

### 四、测试要求

新增业务逻辑必须同批带测试;**不得弱化任何既有断言**。

**1. `packages/workflow-engine/src/stateMachine.test.ts`(追加)**
`canTransitionWorkflow("FAILED","RUNNING") === true`;`canTransitionTask("BLOCKED","PENDING") === true`;既有 `SUCCESS → RUNNING === false` 断言原样保留。

**2. `packages/workflow-engine/src/WorkflowEngine.test.ts`(追加;`MemoryStore` 需同步支持 `clearError` / `clearFinishedAt`,并记录写调用以便断言"未被触碰")**

- retry 只重排"未解决失败 + BLOCKED";`SUCCESS` 任务零触碰(状态与写调用都断言)
- 已解决失败(`resolvedByTaskId` 指向 SUCCESS)不重排
- `retryCount` 与 `input.executionAttempt` 重排前后**相等**(D1)
- `failureHandled` 被复位为 false
- 非 FAILED 工作流 → 抛 `"Workflow is not failed"`;无可重试任务 → 抛 `"No retryable tasks"`
- 存在非 APPROVED 审批 → 抛 `"Retry blocked by rejected approval: …"`,且工作流与任务**零改动**(断言 store 未收到任何写调用)
- 双击竞态:第二次 retry 在状态已 RUNNING 时抛 `"Workflow is not failed"`
- 事件序列:`TASK_RETRY_REQUESTED`(×N) → `WORKFLOW_RETRIED` → 之后 advance 产生的 `TASK_READY` / `TASK_STARTED`
- `clearError` / `clearFinishedAt` 生效(翻转后 workflow.error / finishedAt 为空)
- `start()` 仅 PENDING、`resume()` 仅 PAUSED(其它状态抛错)

**3. `apps/server/src/__tests__/workflowApi.e2e.test.ts`(优先在同一文件追加,复用其 harness;若追加后明显过大可拆 `workflowRetry.e2e.test.ts` 并在报告说明,但 setup 必须镜像同款)**

- **R1 重试成功 + 跳过已完成(核心用例)**
  1. `plan([A, B(←A), C(←B)])`;`createRequirement(plan, "B")`(既有 harness 会 SQL 注入 `execution.failuresBeforeSuccess: 1`);`createAndStart(requirementId, { failureStrategy: "FAIL_FAST" })`
  2. `terminal()` 断言:工作流 FAILED、B = FAILED、C = PENDING;记录 A / B / C 各自 `agent_runs` 计数基线(`SELECT count(*) ... WHERE input->>'workflowRunId' = $1 AND input->>'taskKey' = $2`)
  3. 移除注入(模拟"外部原因已修复"):`UPDATE tasks SET input = input || '{"execution":{}}'::jsonb WHERE workflow_run_id = $1 AND task_key = 'B'`
  4. `POST /api/workflows/:id/retry` → 200
  5. `terminal()` 断言:工作流 SUCCESS;**A 的 run 数 = 基线(不重跑 = 不重烧 token 的直接证据)**;B 恰好 +1 且成功;C 恰好 +1 且成功;events 含 `TASK_RETRY_REQUESTED` 与 `WORKFLOW_RETRIED`
  6. 另断言:retry 前 `workflow.error` / `finishedAt` 非空,retry 后两者已被清空(D2)
- **R2 重试仍失败(无循环)**:不修注入 → retry → 再次 FAILED;该任务 run 数 = 基线 +1(有界,无自动循环)
- **R3 守卫**:对 SUCCESS 工作流 retry → 409 `INVALID_WORKFLOW_TRANSITION`;对 RUNNING 工作流 retry → 409
- **R4 BLOCKED 恢复**:`failureStrategy: "CONTINUE"` + B 注入失败 → 断言 C = BLOCKED、工作流 FAILED;移除注入 → retry → C 恢复执行、工作流最终 SUCCESS

**4. 前端测试**

- `apps/web/src/__tests__/workflowViewModel.test.ts`:`canRetry("FAILED") === true`,其余 6 个状态 false;`workflowEventView` 对两个新事件各一条断言
- `apps/web/src/stores/__tests__/workflows.test.ts`:`act("retry")` → `POST /api/workflows/:id/retry`(断言 URL 与 method)+ 之后刷新详情
- `apps/web/src/__tests__/workflowsView.test.ts`:SSR —— FAILED 详情渲染「重试失败任务」;RUNNING 不渲染(沿用既有 SSR 断言风格)

**5. 门禁**

```bash
corepack pnpm --filter @ai-se/workflow-engine typecheck && corepack pnpm --filter @ai-se/workflow-engine lint && corepack pnpm --filter @ai-se/workflow-engine test
corepack pnpm --filter @ai-se/database typecheck && corepack pnpm --filter @ai-se/database lint && corepack pnpm --filter @ai-se/database test
corepack pnpm --filter @ai-se/server typecheck && corepack pnpm --filter @ai-se/server lint && corepack pnpm --filter @ai-se/server test
corepack pnpm --filter @ai-se/web typecheck && corepack pnpm --filter @ai-se/web lint && corepack pnpm --filter @ai-se/web test && corepack pnpm --filter @ai-se/web build
corepack pnpm -r run typecheck && corepack pnpm -r run lint && corepack pnpm -r run test && corepack pnpm -r run build   # 全仓回归
```

改动文件过 `prettier --check`(printWidth 100 / 双引号 / 无尾逗号;web 的 `.vue` 不在 prettier 门禁内,保持现状)。e2e 需真实 Docker PG;不要并行跑两套门禁。

---

### 五、边界与红线

1. **零第二套**:不加表、不加 migration、不加依赖、不加状态、不加第二套调度/审批/审计/错误码体系;新 AppError code 仅 `NO_RETRYABLE_TASKS`、`RETRY_BLOCKED_BY_APPROVAL`(+ 复用 `INVALID_WORKFLOW_TRANSITION`)。
2. **不改任务定义**:重试不修改 `task.input`、不改 type/依赖/计划(这是 `无人工修改 Workflow` 红线的下限);D1 明确不动 `retryCount` / `executionAttempt`。
3. **不重跑已完成任务**:SUCCESS 任务不重排、不新建 AgentRun;已解决失败(含回滚解决)不重排。
4. **治理不可旁路**:重排任务必须经既有 `claimNextTask → executor → ToolRuntime → 审批/审计` 执行;禁止为"省事"直接改任务状态绕过执行链(唯一允许的直接状态写 = `retry()` 内的重排/翻转)。
5. **不接 5.7-5 `failureRouter`**:生产接线不在本任务;不修改 `handleFailures` 的既有自动分支。
6. **不做运行内恢复**:不引入 durable checkpoint、不做 Agent 图内重试策略、不改 `AgentGraph` / `ProfessionalAgent`。
7. **不做工作区快照/回滚**:重试在当前工作区现状上重跑(D5),该语义写入用户手册。
8. **不开放 SUCCESS / CANCELLED / RUNNING 工作流的重试**;不做"整工作流重跑"。
9. **前端只改 §三.7 点名的文件与位置**:不新增路由/页面,不改 13 条路由,不改 `styles.css`,不重写既有 viewmodel 逻辑(只加 `canRetry` 与两个事件分支)。
10. **不覆盖历史文档**:`docs/1`~`docs/99` 一律不改写(本任务书自身也保留原样);新增文档只用 100。
11. **不弱化既有测试断言**;若因 §二.4 的收紧导致某条既有断言需要调整,必须在报告中单列(改了什么、为什么),禁止直接删除断言。
12. **报告不得美化**:未运行的检查标注"未运行";外部依赖缺失按 BLOCKED 处理,不伪装 PASS。

---

### 六、完成后

- 输出完成报告(节序按 docs/16 固定节):Modified Files、Implementation、Architecture Changes、Dependencies、Tests、Lint、Typecheck、E2E、Known Issues、Acceptance Result、Next Phase Boundary;**Known Issues 必须含 §二.4 的 start/resume 行为收紧**与 D3 的审批限制。
- 实施记录落 `docs/100-retry-failed-workflow.md`(含行为矩阵 §二.7、e2e 证据、文件清单核对;仓库无 git)。
- 更新 `docs/19-user-manual.md`(按钮说明)。
- `docs/17` 不新增/不勾选条目(本任务不在其章节范围内,属 V1 后增强;对照关系见 §七);`docs/15` / `docs/18` 不强制更新。
- **完成后立即 STOP**:不接 failureRouter、不做工作区快照、不做 durable checkpoint、不做 Agent 侧重试策略(L1~L5 属后续独立任务),不顺手改相邻功能。

---

### 七、验收对照(本任务验收项 → 任务书节 → docs/17 关系)

| 本任务验收项                                 | 对应节         | docs/17 关系                                                                            |
| -------------------------------------------- | -------------- | --------------------------------------------------------------------------------------- |
| 失败工作流可人工重试并恢复执行               | 三.3 + 三.6    | 为 §V1 Real AI Validation 的 `Retry / Recovery 正常`(未勾选)提供人工出口;不代替该项验收 |
| 已完成任务跳过(不重跑、不新增 AgentRun)      | 三.3 + 四.3-R1 | 与 `无人工修改 Task / Workflow`(未勾选)一致:不改任务定义、依赖、策略                    |
| 重试后继续执行剩余任务并最终 SUCCESS         | 四.3-R1 / R4   | 同上                                                                                    |
| 重试仍失败时有界、无自动循环                 | 二.6-D1 + 二.7 | 支撑 `无死循环`(未勾选)                                                                 |
| 治理不破(ToolRuntime / 审批 / 审计全经过)    | 二.9 + 五.4    | AGENTS.md §10 架构不变量                                                                |
| 守卫完备(非 FAILED 拒绝、双击竞态、审批被拒) | 四.2 / 四.3-R3 | 本任务自定验收项                                                                        |
| 行为收紧有据可查(start / resume 前置显式化)  | 二.4 + 五.11   | 本任务自定验收项;报告 Known Issues 列明                                                 |

**STOP —— 本任务书到此结束。执行完成后立即停止,等待下一条指令。**

---

## 勘误追加块（2026-10-19，PL-M19）

**本块只追加更正，正文按历史记录保留不改**（`docs/146` §6 规则 7）。

**被本块更正的原文**：§二.3 第 3 条「**未解决失败判定复用引擎权威定义**：`FAILED && (!resolvedByTaskId || resolvedByTaskId 不是 SUCCESS)`」——以及全文各处把该表达式当作「引擎权威定义」的引用。

**为什么它需要更正**：该表达式只认**直接**指针。而 `replan()` 只把源任务的 `resolvedByTaskId` 指向**下一层**的 retry 任务，retry 任务自己也可能失败、再被重规划一层，于是链是 `T → T-REPLAN-1 → T-REPLAN-1-REPLAN-2`，**中间节点自身都是 FAILED**。只认直接指针会把「第二层才救回来」误判为未解决，让**工作全部做完**的工作流报 `WORKFLOW_TASK_FAILED`（缺陷编号 **N-12**，L1-M4j run 2 / 工作流 `bb5f0610` 实证）。

该缺陷在本文写作时**不可达**（当时的 L1 策略是 `RETRY`，REPLAN 分支关着），是后来 PL-M18 把 REPLAN 改成 L1 的默认失败响应才让它落到默认路径上。

**更正后的语义**（PL-M19 实施，`docs/185` / `docs/186`）：

> 一个 `FAILED` 任务「已被解决」⟺ 沿其 `resolvedByTaskId` 链走到头，**尽头是 `SUCCESS`**。
> 链尽头是 `FAILED`、断链、成环 ⇒ **未解决**（fail-closed）。`BLOCKED` / `CANCELLED` 一律未解决。

判定实现于 `packages/workflow-engine/src/resolution.ts`，`retry()` 与 `advanceOnce()` **共用同一处**（本文写作时两处各写了一遍、只靠注释声明同源）。§二.3 的其余结论（重排范围＝未解决失败 + `BLOCKED`；DEPLOY 回滚语义由「已解决失败」承接）**不受影响**。
