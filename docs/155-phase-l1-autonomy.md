# 155 · 自治 L1 实施记录：策略内自治（Autonomy Level 1）

> 日期：2026-10-15 ｜ 类型：**自治 L1 的实现（M1 – M3）**（用户点名「开始 L1」，任务书 `docs/154`）
> 依据：`docs/154`（任务书 + §6 五项裁定）、`docs/17` 节「自治 L1 · 策略内自治」（验收定义正本）、`docs/147` §8（依赖）、`docs/152`（决策事件契约）、`docs/146` §6 规则 7/8、`AGENTS.md` §9。
> 范围：**只做 M1 – M3**。**M4（E1×3 真实批次）未开工**——它消耗周配额，事前须确认配额余量。
> 承接：`docs/149`（7-A / 7-B）、`docs/150`（7-C）、`docs/151`（验证证据解耦）、`docs/152`（7-E）、`docs/153`（阶段 7 收口）。

## Modified Files

**`packages/shared`（契约层）**
- `src/index.ts`：新增 `AutonomyLevelSchema`（**只定义 `"L1"`**）、`DeployFailureStrategySchema`（**只定义 `"ROLLBACK"`**）；`WorkflowPolicySchema` 新增两个**可选**字段 `autonomyLevel` / `deployFailureStrategy`；新增预设常量 `L1_WORKFLOW_POLICY` 与判据函数 `isAutonomyL1`。**未改任何既有导出，未改默认值。**
- `src/autonomyPolicy.test.ts`（新增，6 条）：L1-7 的载体与默认值不变量。

**`packages/workflow-engine`（决策与失败处置）**
- `src/WorkflowEngine.ts`：
  - `handleFailures`：DEPLOY 任务失败时 `deployFailureStrategy: "ROLLBACK"` **优先于**通用 `failureStrategy`（L1-5）；
  - 四个自治决策事件的**写入方**（L1-6）：`AUTO_APPROVED`（策略判定 staging 无需人工、任务直接进入执行时）、`AUTO_RETRIED`（RETRY 分支）、`AUTO_ROLLED_BACK`（自动回滚建任务后）、`VERIFICATION_ENFORCED_FAILURE`（enforce 判失败时）；
  - 新增私有 `autonomyDecision(...)`（统一写入通道）与模块级 `enforcedVerificationFailure(...)`、私有 `isAutoApprovedStagingDeploy(...)`。
- `src/WorkflowEngine.test.ts`（+6 条）：L1-5 / L1-6 的行为与事件，外加 L1-7 的「未声明 L1 时逐项不变」。

**`apps/server`**
- `src/services/verifyingTaskExecutor.ts`：验证门模式**按工作流取**——L1 一律 `enforce`，非 L1 沿用全局 `VERIFICATION_GATE`（L1-4）。
- `src/services/taskVerifier.ts`：`verify()` 接受可选 `mode`（包装层传入生效模式）——只影响记录的 `mode` 字段，判定分支仍在包装层。
- `src/__tests__/verificationGate.e2e.test.ts`（+2 条）：L1-4 的真沙箱强制；非 L1 仍为 observe。
- `src/__tests__/deliveryApi.e2e.test.ts`（+断言）：L1-1（staging 无审批、自动执行、无审批记录）、L1-2（**批准前 `deployments` 无 production 记录**）。
- `src/__tests__/actionPolicyWorkflow.e2e.test.ts`（+1 条）：L1-3（L1 工作流不能免除 HIGH 风险动作的审批门）。

**文档（新增 1 / 修改 5）**：本文件；`docs/17`（L1 节回填）、`docs/146`（§2.1 / §3 / §4 / §5）、`docs/127`、`docs/154`（§6 裁定与 §9）、`docs/15` / `docs/18`（进度节）。

## Implementation

### M1 回归门（L1-1 / L1-2 / L1-3）——**零生产代码改动**

三条不变量在实现前就已在代码中成立（`docs/154` §1 的基线表逐条给出 `file:line`），本里程碑只把它们固化成回归断言：

- **L1-1**：`deliveryApi.e2e.test.ts` 在审批点断言 staging 任务 `approvalRequired === false`、状态 `SUCCESS`、下游 `E2E` 也已 `SUCCESS`、**全链只有 production 那一个审批记录**。
- **L1-2**：同一用例断言**批准之前** `GET /api/deployments` 只有 staging 一条——人工门确实拦住了生产部署。
- **L1-3**：`actionPolicyWorkflow.e2e.test.ts` 新增用例：工作流策略声明 `approvalRequired: false` **并**声明 `autonomyLevel: "L1"`，HIGH 风险动作仍然 `WAITING_APPROVAL`、`approvalRequired === true`、批准前零执行。审批要求由 Action Policy 从风险派生（`packages/action-policy/src/policy.ts:62`），工作流策略无从关闭它。

### M2 策略载体（L1-7）

- `autonomyLevel` 与 `deployFailureStrategy` 都是**可选**字段，**不进 `DEFAULT_WORKFLOW_POLICY`**：缺省即「非 L1」，行为与既有版本逐项一致。
- `L1_WORKFLOW_POLICY` 是**预设**，不是隐藏默认：调用方把它并进 policy 才得到 L1 行为。各字段沿用既有语义（`failureStrategy` / `maxRetries` / `allowRetry`），L1 **不新增第二套失败或重试机制**。
- 预设**不含 `approvalRequired`**——生产与高风险的人工门不由策略关闭（L1-9），有用例钉住这一点。
- `WorkflowPolicySchema` 的 `.strict()` 未被削弱：新字段是**已知可选键**，旧 payload 原样继续通过（有用例）。

### M3 强制执行与可审计

- **L1-4**：门模式由全局配置改为**按工作流取**。`VerifyingWorkflowTaskExecutor` 已收到 `workflow`，读 `isAutonomyL1(workflow.policy)` 即得生效模式；记录里的 `mode` 同步为生效值（否则审计面会出现「记 observe 却判失败」的自相矛盾）。
- **L1-5**：`deployFailureStrategy: "ROLLBACK"` 只在**显式声明**时生效，且只对 `type === "DEPLOY"` 的任务生效；未声明时完全走既有 `failureStrategy`。回滚任务由引擎**既有实现**创建（`<taskKey>-ROLLBACK`），**production 的回滚任务仍带审批**（既有行为，未被 L1 触碰）。有界性由既有 `retryCount < maxRetries` 保证，L1 预设把它声明为 2。
- **L1-6**：四个事件全部走引擎既有的 `event(...)` 通道写进既有 `workflow_events`，`policyId` 固定为 `"L1"`。分工按 §6 第 2 项裁定：`TASK_RETRYING` 是机械事实、`AUTO_RETRIED` 是策略决策，**两者都写，既有事件形状不改**。

**一处刻意的设计取舍（写入方不做运行期校验）**：`autonomyDecision(...)` 的 payload 由 `AutonomyDecisionPayload` **类型**在编译期约束，**不在写入前跑 zod 校验**。原因是 `docs/147` §7 的「观测只读」红线——观测路径不得因任何异常让工作流失败，而运行期 `parse` 抛错会正好造成这一点。契约的一致性改由**测试**保证：引擎用例对每条写出的决策事件都断言 `parseAutonomyDecisionPayload` 能通过。另有一个细节体现了同一原则：回滚时若拿不到被回滚部署的 id，**不写** `AUTO_ROLLED_BACK`，而不是编一个假 uuid 去凑契约。

## Architecture Changes

- `packages/shared` 新增两个枚举 schema、两个可选策略字段、一个预设常量、一个判据函数。**既有导出与默认值一个都没动**。
- `packages/workflow-engine` 的失败处置多了一条**声明式**分支（`deployFailureStrategy`），未引入第二套失败体系；四个自治决策事件复用既有事件通道。
- `apps/server` 的验证门模式从「构造期定死」变为「按工作流取」。
- **未改**：状态机、审批语义、Tool Runtime 唯一执行路径、错误码体系、迁移、包边界、任何既有事件类型与 payload。

## Dependencies

无新增（含 devDependencies）。

## Tests

| 范围 | 结果 |
| --- | --- |
| `@ai-se/shared` test | **63/63 通过（7 个文件）**（改动前 57，+6） |
| `@ai-se/workflow-engine` test | **42/42 通过（3 个文件）**（改动前 36，+6） |
| `apps/server` 定向 e2e（verificationGate / deliveryApi） | **11/11 通过** |
| `apps/server` 定向 e2e（actionPolicyWorkflow） | **5/5 通过** |
| 全仓 `corepack pnpm -r run typecheck` | **通过**（退出码 0） |
| 全仓 `corepack pnpm -r run lint` | **通过**（退出码 0） |
| 全仓 `corepack pnpm -r run test`（第 1 次） | 15 个包全绿；`apps/server` **265/266**（50 个文件）——一条失败见下 |
| `apps/server` 单独复跑 `v1GoldenScenario.e2e.test.ts` | **4/4 通过** |
| 全仓 `-r run test`（第 2 次） | 15 个包全绿；`apps/server` **265/266**——失败的又是**另一个**文件（`planningEscalation.e2e.test.ts` 的「升级重试达上限 → 终态失败」），**单独复跑 2/2 通过** |

**两次全仓运行各失败一条、且文件互不相同**（`docs/145` #7 的典型形态）。两条都**不可能是本阶段引入**：① `v1GoldenScenario` 的重启用例在 `docs/149` 已以同样方式出现过；② `planningEscalation.e2e.test.ts` **不含 `autonomyLevel` / `deployFailureStrategy`**（已 grep 核实），而本阶段的两个行为分支都以这两个字段为条件——它在改动路径之外。**均未修，如实记录。**

**第 1 次的那条失败（如实记录，不修、不掩盖）**：`v1GoldenScenario.e2e.test.ts` 的「server restart: a fresh engine recovers in-flight work and continues the workflow」。**同一文件、同一用例**在 `docs/149` 的 M1 全量运行中已以同样方式出现过一次（`docs/149` §5），单独复跑通过——属 `docs/145` #7 / `docs/146` §5 已登记的**负载敏感抖动**，非本阶段引入。

## Lint

- `@ai-se/shared` / `@ai-se/workflow-engine` / `@ai-se/server` 的 `lint`：均通过（退出码 0）。
- 全仓 `corepack pnpm -r run lint`：通过（退出码 0）。

## Typecheck

- 三个改动包的 `typecheck`：均通过（退出码 0）。
- 全仓 `corepack pnpm -r run typecheck`：通过（退出码 0）。该命令会重建相关包的 `dist`（构建产物，未读取）。

## E2E

- **真沙箱 + 真 Tool Runtime**：`verificationGate.e2e.test.ts` 的 L1-4 用例在一个**客观检查必然失败**的工作区上，用 `observe` 模式构造执行器、给一个声明了 L1 的工作流——结果仍被强制为 `failed` + `VERIFICATION_FAILED`，且记录里 `mode` 是 `enforce`。反向用例证明非 L1 工作流保持 `observe`（自报成功不被覆盖）。
- **真 postgres:16 + 真 HTTP**：`deliveryApi.e2e.test.ts` 的本地交付链（CI → staging DEPLOY → VERIFY → 审批 → production DEPLOY）新增 L1-1 / L1-2 断言。
- **真外部进程**：`actionPolicyWorkflow.e2e.test.ts` 的 L1-3 用例起假 MCP 服务进程，断言 L1 策略下 HIGH 动作仍停在审批门、批准前零 MCP 请求。
- **未做**：M4 的真实模型批次（见下）。

## Known Issues

1. **M4（L1-8 数据门槛）未开工，L1-8 因此未勾**。它要求 L1 策略下 E1×3 批次、staging 段（含 VERIFY）成功 ≥ 2/3，需要新增评估指标并消耗周配额。**开工前须向用户确认配额余量**（`docs/154` §3 M4）。
2. **`VERIFICATION_ENFORCED_FAILURE` 的判据是推断而非显式信号**：引擎判定「任务失败 + `output.verification.verdict === "failed"`」。这个推断成立，因为 `verifyingTaskExecutor` 只在 `enforce` 下覆盖任务结果（`observe` 不会）。之所以不引显式的错误码常量，是为了避免把 `apps/server` 的常量搬进 `@ai-se/workflow-engine` 而形成跨包耦合。`failedChecks` 在没有失败检查（防篡改 / 写范围违规）时用**门组件名**（`anti-tamper` / `write-scope`），不编造检查名——有专门用例。
3. **未声明 `autonomyLevel` 的工作流完全不写自治决策事件**，这正是 L1-7 要求的，但也意味着**非 L1 工作流的「人为审批」没有对应的决策事件**。若日后要让审计面覆盖全部工作流，须另立契约（不能悄悄扩大 L1 事件的适用面）。
4. **L1 的预算是固定值，不是默认值**：`L1_WORKFLOW_POLICY` 把 `maxRetries` 定为 2（`docs/17` L1-5 的裁定值）。当前**没有**「L1 但换一个重试上限」的表达方式——调用方若显式写了别的 `maxRetries`，预设里的 2 会覆盖它。本阶段无此需求，如实记录。
5. **`AUTO_APPROVED` 的语义是「策略判定无需人工」，不是「批准了一个审批」**（staging 根本不产生审批记录）。字段名沿用 `docs/152` 的契约，已在契约注释与写入点注释里写明语义。
6. **L1 是"能力已就绪"，不是"平台已在自治"**：`L1_WORKFLOW_POLICY` 目前**没有生产调用方**——要让某个工作流跑在 L1 下，必须在创建时显式声明 `autonomyLevel: "L1"`（这是 L1-7 的设计：缺省＝现状）。因此**当前没有任何在跑的工作流是 L1**，L1-8 的批次也必须显式用 L1 策略启动。
7. **门禁抖动的既有口径**（`docs/146` §5）不因本阶段改变：全仓单次 `-r test` 既可能一次跑通，也可能出现时序敏感偶发失败；如实记录，不修不掩盖。
8. **未做（红线）**：L2 / L3；关口 1（切片计划人工确认）；关闭生产或高风险的人工门；`docs/154` §2 列出的其余非范围事项。

## Acceptance Result

| 验收项（`docs/17`「自治 L1」节） | 判定 | 证据 |
| --- | --- | --- |
| **L1-1** staging 自动（回归门） | **通过** | `deliveryApi.e2e.test.ts`：staging 无审批记录、自动执行、下游 VERIFY 成功 |
| **L1-2** 生产人工（回归门） | **通过** | 同上：「批准前 `deployments` 无 production 记录」 |
| **L1-3** 高风险人工（回归门） | **通过** | `actionPolicyWorkflow.e2e.test.ts` 新增用例：L1 不能免除 HIGH 动作的审批门 |
| **L1-4** 质量门在 L1 下强制 | **通过** | `verificationGate.e2e.test.ts`：真沙箱注入失败 → `VERIFICATION_FAILED`，且记录 `mode` 为 enforce |
| **L1-5** 失败自动恢复有界 | **通过** | `WorkflowEngine.test.ts`：重试恰为 2 次后 FAILED（无第 4 次执行）、原因可读；staging DEPLOY 失败自动生成并执行 `-ROLLBACK` 任务 |
| **L1-6** 自治决策可审计 | **通过** | 四个事件各有 `WorkflowEngine.test.ts` 用例，且每条写出的 payload 都断言能通过 `parseAutonomyDecisionPayload` |
| **L1-7** 策略载体与默认值 | **通过** | `autonomyPolicy.test.ts` + `WorkflowEngine.test.ts` 的「未声明 L1 → 零决策事件、行为不变」用例；全仓既有测试不回归 |
| **L1-8** 数据门槛（staging 段） | **未达成（未开工）** | M4 未执行，需配额确认。**如实不勾** |
| **L1-9** 不变量（红线） | **遵守** | 未绕过 Tool Runtime / Policy；未新增第二套 Approval / Audit；生产与高风险人工门未被策略触碰（有 L1-2 / L1-3 用例）。一条性质用例用于钉住「预设不含 `approvalRequired`」 |

**阶段判定：M1 – M3 全部达成；L1-8 未开工 ⇒ 整个 L1 尚不能判「达成」**。按 `docs/154` §5，M4 未执行时不勾 L1-8、**不因批次未达而否定 M1–M3**，也不伪装。

## Next Phase Boundary

**本子阶段结束（STOP）。未开始事项**：

- **M4 / L1-8**：staging 段指标 + E1×3 批次。**需先确认周配额余量**。
- **追踪前端**：已裁定另立阶段。
- **7-D 外部栈**：已裁定延期。
- **Phase 8 AI SRE**：从未进入任何任务书。
- **`provider` 运行时切换**、**`audit_logs` 处置**、**`docs/01–11 / 13 / 14` 重新基线**：未开工。

**需要你回答**：是否现在做 M4。它要跑一次真实模型批次（E1×3），消耗周配额；也可以先停在这里，等需要真实数据时再跑。

---

# M4：L1-8 数据门槛（2026-10-16 追加块）

> **本块是 2026-10-16 追加，不改动上文任何一行。** 上文「M4 未开工」「L1-8 未达成（未开工）」等表述**以本块为准**——M4 已执行完毕，L1-8 的判定随之从「未开工」变为「**已执行、未达成**」。
> 授权：用户 2026-10-15「先跑 m4」授权执行 M4；2026-10-16 用户裁定「记未达成 + 归因，修根因另立项」。

## Modified Files

| 文件 | 改动 |
| --- | --- |
| `packages/eval/src/types.ts` | 新增 `EvalAutonomyLevel` / `EvalDeployFailureStrategy` 本地字面量、`EvalPolicy` 的可选 `autonomyLevel` / `deployFailureStrategy`、`StagingSegmentView`、记录与汇总上的 `stagingSegment` / `stagingDeliveryRate` |
| `packages/eval/src/harness.ts` | 新增 `collectStagingSegment(tasks)`（CI ∧ staging DEPLOY ∧ staging VERIFY），接入记录与逐次运行日志 |
| `packages/eval/src/metrics.ts` | 汇总新增 `stagingDeliveryRate` |
| `packages/eval/src/report.ts` | 汇总行与逐次运行表新增 staging 段 |
| `packages/eval/src/cli.ts` | 新增 `--autonomy-l1`（**不修改** P0 冻结的 `POLICY`，改为在其上叠加 L1 覆盖层并打印生效策略） |
| `packages/eval/src/__tests__/harness.test.ts` | 新增 `collectStagingSegment` 的 6 个用例 |
| `packages/eval/scripts/l1-m4-server-launch.sh` | **新增**：专用实例 `:47558` 的守护式启动脚本 |
| `packages/eval/scripts/l1-m4-e1-x3.sh` | **新增**：E1×3 批次脚本（每轮检查点、周配额守卫、冷却、可续跑） |

## Implementation

**判据指标**：`staging 段 = CI 成功 ∧ staging DEPLOY 成功 ∧ staging VERIFY 成功`。用户 2026-10-15 已裁定**不用 `deliveredSuccess`**——它在结构上不可达（production 审批门必然挡住），故本批次以 staging 段为准。

**L1 策略以 CLI 叠加层注入**，而非改写 `cli.ts` 里 P0 冻结的 `POLICY`：`--autonomy-l1` 时 `{...POLICY, ...L1_POLICY_OVERRIDE}`，生效策略打印进日志并写入每份结果 JSON，保证与基线可比、且符合 `docs/146` §6 规则 8 对默认值变更的登记要求。

**专用实例**：批次跑在 `:47558` 的守护式实例上（`PLANNING_MODE=two-level`、`VERIFICATION_GATE=enforce`、`SUBMIT_RESULT_MODE=tool`，与 G-M3 受控实例一致）。**不复用 `:47557`**——那个实例启动于 2026-10-14，早于 L1 代码落地，不带 L1。启动脚本有一处已修的坑：`.env` 里 `PORT=3000` 会覆盖先赋值的端口变量，故 `PORT` 必须在 `source .env` **之后**再赋值。

## Architecture Changes

**无。** 评估包按自身约束**不导入任何 workspace 包**（评测只经 REST 驱动平台），故 L1 的策略取值在包内以本地字面量声明，不引 `@ai-se/shared`。

## Dependencies

**无新增。**

## Tests

`packages/eval` **41/41（5 个文件）**，改动前 35（+6）。

## Lint

`corepack pnpm --filter @ai-se/eval lint` 退出码 0。

## Typecheck

`corepack pnpm --filter @ai-se/eval typecheck` 退出码 0。

## E2E

**批次执行**：2026-10-15 18:00 → 2026-10-16 00:46，三次 E1 全链运行（run 1 带 `--replan`），每轮之间 30 分钟冷却，**跑满 3 次，无中止**（周配额守卫 200M 未触发）。

| | 工作流 | 切片覆盖 | 工作流内任务 | staging 段 | oracle(Must) | 耗时 | 人工介入 | 输入/输出 token |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| run 1 | `858a8771`… | **5/5** | 53（SUCCESS 49 / FAILED 1 / PENDING 3） | **否** `{ci: FAILED, deploy: PENDING, verify: null}` | 0/29 | 2h02m32s | 3 | 2,548,820 / 150,941 |
| run 2 | `7b9c027c` | **1/5** | 9（SUCCESS 1 / FAILED 1 / PENDING 7） | **否** `{null, null, null}` | — | 16m41s | 0 | 181,942 / 19,553 |
| run 3 | `e07771d6`… | **5/5** | 53（SUCCESS 49 / FAILED 1 / PENDING 3） | **否** `{ci: FAILED, deploy: PENDING, verify: null}` | **24/29** | 2h38m57s | 0 | 3,946,563 / 164,656 |

**合计 6,677,325 输入 token**；周窗口累计 **48.4M / 200M**（守卫未触发）。

**staging 段交付率：0/3 = 0.0%**，判据为 ≥ 2/3 ⇒ **未达成**。

### 归因（run 1 与 run 3 同形）

两轮的交付链死在**同一处**，且拿到了直接证据：

1. slice-5 的计划含三个 **TDD 红测试任务**（TASK-14 / 15 / 16），其中 TASK-15（部署静态契约）与 TASK-16（可追溯性契约）断言工作区**必须存在 `Dockerfile` 与真实 `README.md`**，并在产出摘要里明写 `fixTaskType: IMPLEMENTATION`——「剩下一件事是**一个部署实现任务**来补这两样」。
2. **那个实现任务从未被创建**：slice-5 的任务编号是 `TASK-01…TASK-19`，**`TASK-04` / `05` / `06` / `13` 四个编号在本批次全库不存在**。
3. 故 CI 时工作区状态为：**无 `Dockerfile`**；`README.md` 仍是夹具占位文件（原文：「这是评测工作区的占位文件……请在当前目录按任务描述从零完成实现」）。
4. CI 步骤为 `pnpm install --frozen-lockfile → lint → typecheck → test → build → docker build`，卡在 **`pnpm test`**。在该工作区实跑复现：**235 个测试 / 219 通过 / 15 失败 / 1 跳过，`node --test` 退出码 1**。
5. → `TASK-12`（BUILD / delivery=CI）`FAILED`，`ci_runs` 记 `{"code":"CI_FAILED","message":"pnpm failed with exit code 1"}` → staging DEPLOY 停在 `PENDING` → **staging 段 = 否**。

**这是计划缺陷，不是随机波动**：计划器生成了「测试这些产物存在」的任务，却没生成「把产物做出来」的任务。

### run 2 不是环境异常轮（更正先前的猜测）

run 2 的链断在 slice-1 的 `T2`（标题「Write AC-numbered foundation contract tests: home page HTML hooks and health endpoints [AC-21]」）。工作流事件显示它**连续失败 3 次**（`retryCount` 0 / 1 / 2 全部 `TASK_FAILED`）后写 `WORKFLOW_FAILED`（`WORKFLOW_TASK_FAILED`）。**这是稳定复现的失败**，因此 run 2 计入分母，**不作废、不补跑**。

### L1 自治特性在本批次**从未被触发**

- `AUTO_APPROVED`：**0 次**（staging 自动批准从未发生——staging DEPLOY 未执行）
- `AUTO_ROLLBACK`：**0 次**（无 DEPLOY 失败）
- 唯一触发过的自治相关事件是 `TASK_RETRYING`（12 次，run 1 的 slice-2）
- staging DEPLOY 任务的 `approval_required = false`，production DEPLOY 为 `true`（**L1-9 红线在数据上守住**，但也没走到那一步）

**结论：L1-8 未达成不是自治层出错，而是交付链在 CI 就断了，自治特性没有机会运行。阻塞在上游。**

## Known Issues

1. **根因未修**：计划器不会为「TDD 红测试任务」生成对应的实现任务，导致红测试在 CI 时仍未转绿。用户 2026-10-16 裁定**另立项处理**，已登记 `docs/146` §3。**在修掉之前重跑批次极可能同样失败**，不建议先重跑。
2. **`VERIFICATION_GATE=enforce` 与「TDD 红测试」相互拉扯**：本批次为与 G-M3 基线可比而固定 `enforce`。红测试任务在该模式下是否应判失败，run 1/3（同类任务判 SUCCESS）与 run 2（同类任务判 FAILED 并拖垮工作流）给出了**不一致的结果**——本阶段未深究，属根因立项的范围。
3. **两次 agent 运行超出迭代上限**：run 3 有两次 `timed_out`，记录为 `current_iteration` **69/50** 与 **89/50**；run 2 亦有一次 `52/50`。`max_iterations` 与实际迭代数不一致的成因未查。
4. **`ci_runs` 不保存 CI 日志**：失败只留 `{"code":"CI_FAILED","message":"pnpm failed with exit code 1"}`，逐步骤日志（`LocalCiOperations` 会收集 `logs`）未落库。本次归因靠**在工作区重跑测试套件**复现，而非读库内日志。
5. **M4 不改变 M1–M3 的任何结论**：`docs/154` §5 明写「不因批次未达而否定 M1–M3」，本块照办。

## Acceptance Result

| 验收项 | 判定 | 证据 |
| --- | --- | --- |
| **L1-8** 数据门槛（staging 段 ≥ 2/3） | **未达成** | staging 段 **0/3**（判据 ≥ 2/3）。三次归因见上；run 2 经查为稳定复现失败，计入分母 |

**阶段判定更新：L1-1 … L1-7、L1-9 通过；L1-8 已执行但未达成 ⇒ L1 整体仍不判「达成」。** 如实记录，不勾选、不伪装，也不因数据未达而否定已通过的 M1–M3。

## Next Phase Boundary

**M4 结束（STOP）。未开始事项**：

- **根因修复**：计划器不生成实现任务 / `enforce` 与红测试的拉扯。用户已裁定**另立项**（`docs/146` §3 已登记）。
- **追踪前端**：**已完成**（`docs/157`），不属本阶段。
- **`docs/01–14` 重新基线**：**已完成**（13 份加基线状态节；`docs/09` 按活文档补正文），不属本阶段。
- **7-D 外部栈**：已裁定延期。
- **Phase 8 AI SRE**：从未进入任何任务书。
- **`provider` 运行时切换**、**`audit_logs` 处置**：未开工。

---

# 勘误块：run 2 的成因更正（2026-10-16 追加）

> **本块是 2026-10-16 追加，不改动上文任何一行。** 依据：`docs/158` §1.5（起草该任务书时的代码与数据核对所得，**非本文件原文**）。
> 处置口径按 `docs/146` §6 规则 7「历史记录冻结、勘误只追加」。

上文 §「run 2 不是环境异常轮（更正先前的猜测）」的**结论不变**（run 2 是**稳定复现**的失败，**计入分母、不作废、不补跑**），但**成因描述需补**：

- **它不是计划缺陷，也不是瞬时抖动，而是确定性的沙箱写权限拒绝。** run 2 死在 slice-1 的 `T2`（TEST）：该 agent 的 `output.issues` 明写 `write_file` 全部返回 `"Path is not writable"`（试的是 `src/test/ac-21-foundation.test.js`、`/probe-ac21.txt`、`/src/probe-ac21.txt`），测试文件建不起来，`outcome: RETRY`、`fixTaskType: ENVIRONMENT_WRITE_ACCESS`，19 轮后放弃。原因是 QA agent 的写范围只有 `test` / `tests` / `__tests__`，**写不进 `src/__tests__/`——也就是本仓库自己的测试规范**。
- **该缺陷已在 PL-M5 修复**（`docs/158` §3 / 实施记录 `docs/159`）。它不是新缺陷，是**复发三次**的旧缺陷：`docs/115`（阶段 B）「发现 2：`Path is not writable` = 写权限模型 + 计划分派错位」、`docs/129`（阶段 F）「**权限拒绝发生在 deepagents FS 中间件层，不落表**」，以及本文件 M4 的 run 2。
- **上文 Known Issues 第 2 条（`enforce` 与红测试相互拉扯）的观测随之更精确**：run 1/3 判 SUCCESS、run 2 判 FAILED 的不一致，**至少有一部分来自写权限拒绝**（任务根本没能产出测试文件），而非纯粹的模式拉扯。该条仍**未深究**，属 PL-M1 … PL-M3 与 PL-M4 的范围。

