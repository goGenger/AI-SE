# Phase 5.7-5 Failure Recovery — Completion Report

> 项目:AI-SE(Failure Recovery / 统一失败恢复)
> 阶段:Phase 5.7-5(Failure Recovery)
> 状态:**PASS**
> 完成日期:2026-09-13
> 开发模式:ponytail(复用既有 Workflow/Retry/Re-plan/Approval 链,零第二套引擎)+ 以代码为准
> 参考:docs/17 §5.7-5、docs/24、docs/43(5.7-0)、docs/52/53(5.7-1)、docs/54(5.7-2)、docs/55(5.7-3)、docs/56(5.7-4)

---

## 1. Status

**PASS** — 任务书 §2~§10 与 docs/17 §5.7-5 六项全部达成;真实 E2E:

```text
Action Failure
    ↓
Failure Classification(冻结 6 类 + UNKNOWN 安全兜底)
    ↓
Re-observe(复用 5.7-1 观察面 / 5.7-2 MCP 数据快照)
    ↓
Retry / Re-plan(复用 workflow-engine 既有链:retryCount / maxRetries / REPLAN)
    ↓
Continue / Human Intervention(复用 WAITING_APPROVAL;STALLED 语义延续 5.6-5)
```

- Browser 与 External 使用**统一 Failure Recovery 语义**(同一分类器、同一路由表、同一引擎链)。
- 每次重试重新经过 **Action Policy / Permission / Approval / ToolRuntime / Audit**(真实 E2E 锁定)。
- 每轮证据经 **5.7-4 Evidence** 落库;**失败证据永不删除**。
- 全仓四门禁 exit 0(§10)。

```text
Browser / External Action ── ToolRuntime(治理)──▶ ActionResult / ToolResult
        │ 失败
        ▼
ActionRecoveryExecutor: 5.7-4 evidence(before/failure/after/verification)
        │            + re-observe(5.7-1/5.7-2 复用)→ 进度/停滞计数
        ▼
task.output.recovery{failureClass, riskLevel, stateChanged, consecutiveNoProgress, round}
        ▼
WorkflowEngine.failureRouter(=@ai-se/failure-recovery 冻结路由表)
   ├ RETRY  → 既有 retryCount/maxRetries 链(任务重新经 ToolRuntime)
   ├ REPLAN → 既有 REPLAN 链(DEBUG + 重试任务,docs/55/引擎实现零改动复用)
   ├ HUMAN  → 既有 approval 实体 + WAITING_APPROVAL(FAILED→RETRYING→WAITING_APPROVAL)
   └ FAIL   → 终止(取消 / 拒绝 / 已批准恢复仍失败)
```

## 2. Failure Classification(冻结词表)

新包 **`@ai-se/failure-recovery`**(packages/failure-recovery,依赖仅 shared + evidence):

| 文件                    | 职责                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/classification.ts` | 冻结 6 类 + `UNKNOWN` 兜底:`ELEMENT_MISSING / LOGIN_EXPIRED / NETWORK_FAILED / UI_CHANGED / TIMEOUT / CANCELLED`;信号全部来自真实产物(浏览器错误码 5.6-3/5.7-1、MCP client 类别 5.5-2、ToolRuntime 错误码、ActionResult.error) |
| `src/routing.ts`        | 冻结路由表(`decideRecovery`)+ `RECOVERY_STALL_THRESHOLD = 2`(镜像 5.6-5 `FIX_LOOP_STALL_THRESHOLD`)                                                                                                                            |
| `src/reobserve.ts`      | `reobserveAfterFailure`:真实观察 + `snapshotsDiffer`(5.7-4 内容投影)进度判定 + 连续无进展计数                                                                                                                                  |
| `src/router.ts`         | `createRecoveryRouter`:引擎侧唯一决策点(只读 task 行 / policy / approvals;**undefined = 非动作失败 → 引擎默认行为**)                                                                                                           |

分类要点(测试锁定):

- 浏览器交互失败只有一个重载码 `BROWSER_NAV_FAILED`(click/type/hover/focus 共用),由 **re-observe 结果细化**:
  凭据语义字段可见 → `LOGIN_EXPIRED`(登录墙);本次尝试状态已变 → `UI_CHANGED`;否则 → `ELEMENT_MISSING`。
- `TIMEOUT` 来自 ToolRuntime 真实超时(TIMEOUT*ERROR / BROWSER_TIMEOUT / BROWSER_RENDER_TIMEOUT / 消息 timed out);
  `CANCELLED` 来自真实中止(aborted / CANCELLED_ERROR / MCP CANCELLED);`NETWORK_FAILED` 来自真实传输信号
  (MCP CONNECTION、navigation failed、net::ERR*_、ECONN_);认证类信号(MCP PERMISSION_DENIED / 401 / 403 / login)
  → `LOGIN_EXPIRED`。
- **未知错误 → UNKNOWN,永不当成功**:路由按有界重试处理(→ 最终人工边界),不静默通过、不静默丢弃。

## 3. Re-observe(复用 5.7-1 / 5.7-2,零新观察系统)

- Browser:失败后经 **5.7-1 `browser.observe`** 重新观察真实 DOM;
- External:失败后用 **5.7-2 MCP 数据快照**(issues.list 经真实协议)对比;
- 对比沿用 **5.7-4 `snapshotsDiffer` 内容投影**(身份/时间戳不参与),产出 `stateChanged` 与连续无进展计数;
- **re-observe 失败是显式事实,不得伪造**:执行器捕获异常后跳过该轮 evidence(记录 `reobserveFailed: true`),
  绝不把 before 冒充 after;失败分类在无观察上下文时按安全默认(交互类 → ELEMENT_MISSING)继续。
  (E2E 实证:导航刚失败时 `page.evaluate` 与导航 teardown 存在竞态 → 修复为执行器兜底 + 观察回调一次 settle 重试。)

## 4. Retry(复用 workflow-engine 既有语义)

- 预算仍是 `task.retryCount < workflow.policy.maxRetries`(引擎既有分支,零重写);
- RETRY 路由 → 任务 `RETRYING` → `READY` → 重新 claim → **再次经过完整 ToolRuntime / Action Policy / 审批门 / 审计**;
- E2E:每次尝试都会话经由同一 runtime 重新执行(recorder started 逐次留痕),重试轮 `toolCallId` 可追踪;
- 无进度连续轮 → 按 stall 阈值提前交人(不烧完预算)。

## 5. Re-plan(复用既有 REPLAN 链,零新循环器)

- 路由 `REPLAN` → 引擎**既有 `replan()`**:创建 `DEBUG`(诊断,本阶段 stub 执行器)+ `REPLAN-<n>` 重试任务,
  依赖图重接(`applyReplan`),事件 `REPLAN_STARTED / TASK_CREATED×2 / REPLAN_COMPLETED` 全为既有事件;
- 里程碑词汇与 **5.6-5 `FixLoopState` 同构**:round / stallThreshold / STALLED 状态语义延续
  (工作流侧以 WAITING_APPROVAL 停放 + reason=stalled 表达,不新增状态机);
- E2E:外部 always-fail 动作 → RETRY 耗尽 → REPLAN(新任务创建,source.resolvedByTaskId 指向重试任务)
  → 重试任务再次耗尽 → **re-plan 失败 → 人工边界**(路由表终结项)。

## 6. Human boundary(复用 WAITING_APPROVAL / STALLED 语义)

路由表冻结的人审触发(全部真实 E2E 覆盖):

| 触发                     | 行为                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `LOGIN_EXPIRED`          | 立即 HUMAN(零自动重试)                                               |
| HIGH risk(工具审计风险)  | 立即 HUMAN——高风险动作失败不自动重试                                 |
| 连续 N 轮无进展(STALLED) | HUMAN,`stalled: true`,reason 含 stalled;**预算未耗尽也交人**         |
| retry 耗尽               | HUMAN(reason=exhausted);`allowReplan` 时先走 REPLAN                  |
| re-plan 失败             | HUMAN(终结)                                                          |
| 人工已批准但恢复仍失败   | FAIL(不循环边界)                                                     |
| 人工拒绝                 | FAIL(即使 task output 被 reject() 覆盖,只要存在 REJECTED 记录即终结) |
| `CANCELLED`              | FAIL(取消不自动恢复,一次尝试即停)                                    |

- 机制零新造:引擎 `requestHumanIntervention` 复用**既有 approval 实体**与**既有状态机路径**
  (`FAILED → RETRYING → WAITING_APPROVAL`),工作流 `RUNNING → WAITING_APPROVAL`(均为冻结合法转换);
  批准 → `READY` → 重新执行(再次全治理);拒绝 → `FAILED` → 路由终结 → 工作流 FAILED;
- 新事件仅追加观测性:`FAILURE_ROUTED`(每次失败分类+策略+reason+stalled)、`FAILURE_HUMAN_REQUIRED`;
  审批侧继续发既有 `APPROVAL_REQUIRED`。

## 7. Evidence(5.7-4 复用,失败不删除)

- 每次尝试(含失败/被治理拒绝的尝试)都经 `buildEvidenceDraft` 落 5.7-4 EvidenceRecord
  (before/failure/after/verification;治理拒绝产生无 ActionResult 时由**真实 ToolResult.error 合成**失败结果,与浏览器工具同类做法);
- task.output.recovery 携带 `round = retryCount + 1`,轮次可追踪;E2E 断言同任务 ≥2 条记录、失败记录保留到工作流终结之后;
- reject 覆盖 task output 属既有语义(证据与事件不受影响,测试注释锁定)。

## 8. Policy / Security(每次重试重新治理)

- 执行器只走既有 `ToolRuntime.execute`,上下文携带 `metadata.approved`(来自**已批准的** approval 记录)——批准后的重试才能通过 HIGH 动作的政策门;
- E2E 实证:HIGH 动作首次尝试被政策门拒绝 → **零 MCP 请求**;批准后同一任务重跑 → 通过门 → 真实执行 1 次;
  拒绝路径永远零请求;重试轮不消费 retry 预算(边界与预算正交);
- 凭据纪律延续:所有进出证据/结果文本仍过既有脱敏(5.7-4 sink + 5.7-2 数据脱敏),本阶段零新增凭据面。

## 9. 测试与回归

| 套件                                                                                                 | 结果                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failureRecovery.e2e.test.ts`(server,真实 Chromium + 真实 MCP stdio + 真实 PG + 真实 WorkflowEngine) | **10/10** — ELEMENT_MISSING 耗尽→人审→拒绝;NETWORK 重试成功;UI_CHANGED→停滞→STALLED;LOGIN_EXPIRED 立即人审;TIMEOUT 重试耗尽;外部 UNKNOWN 重试成功;外部 REPLAN→re-plan 失败→人审;HIGH 批准执行/拒绝零请求;CANCELLED 单次失败;轮次可追踪 |
| `failureRecovery.test.ts`(failure-recovery 包)                                                       | 16/16 — 分类词表(6 类+兜底+细化)/ 路由表(全部规则)/ re-observe 计数 / 路由器边界(undefined / 拒绝 / 已批准)                                                                                                                            |
| `WorkflowEngine.test.ts`(workflow-engine,+5 例)                                                      | 19/19 — 路由 RETRY 覆盖 FAIL_FAST 政策 / HUMAN 停放与批准恢复 / 拒绝终止零执行 / FAIL 与"已批准仍失败"终结 / 无路由时默认行为不变                                                                                                      |
| 5.7-1 ~ 5.7-4 回归                                                                                   | browser 38、mcp 235、action-policy 13、evidence 9、database 37、shared 46、server 78(含 5.7-3/5.7-4 E2E)                                                                                                                               |
| 全仓四门禁                                                                                           | `pnpm -r typecheck / lint / test / build` 全部 exit 0;测试 **677/677,0 failed**                                                                                                                                                        |

## 10. Known limitations

1. **re-observe 竞态**:导航刚失败时页面 teardown 会让观察抛出(执行器已兜底为显式事实;
   观察回调可在接线层加 settle 重试,本 E2E 即如此)。该轮若无观察则无 5.7-4 记录(避免伪造 after)。
2. **failCalls 型 fixture 参数**(`failUntilCall`)依赖进程内绝对调用序;本文件内按序使用并注释,跨文件互不影响(fresh 子进程)。
3. **DEBUG 任务执行器为 stub**(诊断输出),真实 re-plan 的"诊断-修复"内容生成属后续能力;
   本阶段锁定的是**链路语义**(既有 REPLAN 链 + 证据 + 治理)。
4. **生产接线点已备但未挂载**:`WorkflowService({ failureRouter })` 为可选注入;当前 index.ts 未启用
   (生产工作流仍为交付动作;浏览器/外部动作执行器接线留待真实场景)。
5. STALLED 以 reason 词汇 + `stalled` 标记延续(不新增任务/工作流状态);如需 STALLED 实体状态需另立任务。

## 11. 修改/新增文件

- 新包:`packages/failure-recovery/{package.json,tsconfig.json}`、`src/{classification.ts,routing.ts,reobserve.ts,router.ts,index.ts}`、`src/__tests__/failureRecovery.test.ts`
- 复用面:`packages/evidence/src/verify.ts`(+`snapshotsDiffer` 导出)、`packages/mcp/src/testing/external-system-entry.js`(`issues.fail.failUntilCall` 可选参数,默认行为不变)
- 引擎:`packages/workflow-engine/src/{types.ts,WorkflowEngine.ts,index.ts}`(failureRouter 钩子 + HUMAN 边界;默认路径零行为变化)
- 服务端:`apps/server/src/services/actionRecoveryExecutor.ts`(新)、`services/workflowService.ts`(failureRouter 透传)、`__tests__/failureRecovery.e2e.test.ts`(新)、`package.json`
- 零改动红线:5.7-0 ~ 5.7-4 历史报告与核心实现未改;无新 Retry/Workflow/Approval/Evidence/Action Policy/Browser Runtime/MCP Transport。

**完 —— Phase 5.7 全部子阶段(5.7-0 ~ 5.7-5)结束,STOP。**
