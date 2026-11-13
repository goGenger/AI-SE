# 154 · 自治 L1 任务书：策略内自治（Autonomy Level 1）

> 状态：**§6 五项已按推荐值裁定；M1 – M3 已实施并通过（2026-10-15，记录 `docs/155`）；M4（L1-8 的 E1×3 批次）未开工。** 用户 2026-10-15 点名「开始 L1」——按阶段纪律先出任务书（`docs/127` §8：先任务书 → 审 → 实施 → 门禁 → 记录 → STOP）。
> 依据：`docs/17` 节「自治 L1 · 策略内自治」（**验收定义正本**，八项 + 一条红线）、`docs/147` §8（与阶段 7 的依赖）、`docs/152`（决策事件契约）、`docs/151`（验证证据不进 Agent 输入）、`docs/146` §4（2026-10-15 裁定）。
> 编号：任务编号 **L1-M1 … L1-M4**（里程碑）；验收编号**沿用 `docs/17` 的 L1-1 … L1-9**，本任务书不新造编号，只把验收项落成改动。
> 性质：**本文件只是改动方案**。`docs/17` 的 L1 节明确写「本节只定义验收，不构成开工」——缺的正是这一份。

## 1. 为什么这样排：基线事实（2026-10-15 代码核对）

| 事项 | 现状（代码核对） | 证据 | 对 L1 的含义 |
| --- | --- | --- | --- |
| staging DEPLOY 是否要审批 | **不要**。`approvalRequired` 仅在「policy 要求 / 在 approvalTaskKeys 里 / DEPLOY 且 `environment === "production"`」时为真 | `packages/database/src/workflowRepositories.ts:413` | **L1-1 的代码已成立**，只差断言 |
| production DEPLOY 是否要审批 | **强制要** | 同上 | **L1-2 的代码已成立**，只差断言 |
| HIGH / CRITICAL 工具动作是否要审批 | **强制要**（`risk === "HIGH" \|\| risk === "CRITICAL"`），且策略无从关闭 | `packages/action-policy/src/policy.ts:62` | **L1-3 的代码已成立**，只差断言 |
| 失败策略的形状 | **单个枚举** `failureStrategy`（`FAIL_FAST` 默认）+ `allowRetry` + `maxRetries`（默认 1） | `packages/shared/src/index.ts:771-795` | **单枚举表达不了「普通任务 RETRY + DEPLOY 失败 ROLLBACK」**——见 §6 第 1 项 |
| 失败处置的分派点 | `handleFailures`：`strategy = routed?.strategy ?? workflow.policy.failureStrategy` | `packages/workflow-engine/src/WorkflowEngine.ts:652` | L1-5 的落点 |
| RETRY 分支 | 要求 `allowRetry && task.retryCount < policy.maxRetries`；写 `TASK_RETRYING` 事件 | 同上 `:673-694` | 有界性已存在，L1 只需给对默认值 |
| ROLLBACK 分支 | 要求 `task.type === "DEPLOY"` 且 delivery 合法；`rollback()` 建 `<taskKey>-ROLLBACK` 任务并执行 | 同上 `:696-703`、`:883-954` | L1-5 的「staging DEPLOY 失败自动回滚」**已有实现**，只需让它被选中 |
| 失败路由钩子 `failureRouter` | **既有钩子，但生产未接线**——`apps/server/src/index.ts` 构造 `WorkflowService` 时未传，只有测试传 | `apps/server/src/services/workflowService.ts:70,90`；`apps/server/src/index.ts:250` | 见 §6 第 1 项 |
| 质量门模式 | **全局配置** `VERIFICATION_GATE`（`off` / `observe` / `enforce`，**默认 `observe`**） | `apps/server/src/config.ts:67` | **不是工作流级**——L1-4 要求「L1 工作流中」强制，必须改成按工作流取模式 |
| 门失败的效果 | `enforce` 且 `verdict === "failed"` → 任务 `failed` + `errorType = VERIFICATION_FAILED`，走既有失败策略 | `apps/server/src/services/verifyingTaskExecutor.ts:69` | L1-4 的落点 |
| 验证记录的去向 | 写进任务 `output.verification`；**不进 Agent 输入**（`dependencyResults` 剥掉它） | `docs/151` | L1 不得把它重新耦合回提示词 |
| 决策事件契约 | **已就绪、无写入方**：四事件 + `policyId` / `reason` / `workflowRunId` / `taskId`，写进既有 `workflow_events` | `packages/shared/src/index.ts`（`AUTONOMY_DECISION_PAYLOAD_SCHEMAS`）；`docs/152` | L1-6 的落点 |
| 追踪视图 | **已就绪**：`GET /api/workflows/:id/trace`，数据库派生的树 | `docs/150` | L1-6 的「可按 workflowRunId 查询」已有查询面 |
| 指标端点 | **已就绪**：`GET /api/metrics`（Prometheus 文本格式九项） | `docs/149` | L1-8 的观测面 |
| 交付链形状 | CI → staging DEPLOY → VERIFY → production DEPLOY；**VERIFY 是 `TEST` 型任务 + `delivery.action === "VERIFY"`**，由部署编排器执行 | `apps/server/src/services/deploymentOrchestrator.ts:82,109` | L1-8 的「staging 段」= CI + staging DEPLOY + VERIFY |
| 评估判据 | `deliveredSuccess = oracle.passed && chain.chainCompleted`；`chainCompleted` = **全部切片 DONE** | `packages/eval/src/harness.ts:790`、`:113` | 生产审批门使其**结构上不可达**——2026-10-15 用户已裁定**弃用**（`docs/131` 后续块、`docs/146` §4） |

**结论**：L1 的**回归门三项（L1-1 / L1-2 / L1-3）代码已全部成立**，工作量在断言；真正要写代码的是 **L1-4（把门模式从全局改为按工作流）、L1-5（让 DEPLOY 失败被路由到 ROLLBACK）、L1-6（写决策事件）、L1-7（自治级别这个载体）**；L1-8 是**新的评估指标 + 一次真实批次**。

## 2. 范围与里程碑

| 里程碑 | 内容 | 出口 | 依赖 |
| --- | --- | --- | --- |
| **M1 回归门**（零行为变更） | L1-1 / L1-2 / L1-3：把三条既有不变量固化成回归断言 | 三条断言全绿，且**生产代码一行未改** | 无 |
| **M2 策略载体**（零行为变更） | L1-7：`autonomyLevel` 成为工作流级策略字段；**缺省时行为与现状逐项一致** | 既有测试不回归（这是 L1-7 的判据本身） | 无 |
| **M3 强制执行与可审计** | L1-4（门强制）/ L1-5（有界自动恢复 + 自动回滚）/ L1-6（决策事件落库） | 三条验收的注入式 E2E 全绿 | M2（要读自治级别）；L1-6 依赖 `docs/152` 契约（**已交付**） |
| **M4 数据门槛** | L1-8：新增 staging 段指标 + E1×3 批次 | staging 交付（含 VERIFY）成功 **≥ 2/3**，附归因 | M3；`docs/149` 指标端点（**已交付**） |

**本阶段不做**：L2 / L3（未定义）；关口 1（切片计划人工确认）——**已裁定不纳入 L1**；生产与高风险的人工门——**红线，不得由策略关闭**（L1-9）；任何第二套 Approval / Audit 体系；把验证记录重新塞回 Agent 输入。

**M4 的批次成本**：E1×3 是真实模型批次（历史量级 0.94M–11.4M token/批，`docs/127` §4）。**排在最后**，不构成 M1–M3 的开工阻塞。

## 3. 任务明细

> 组织方式：按 `docs/17` 的验收项编号逐条给改动，不新造编号。

### M1 回归门（零行为变更，只加断言）

**L1-1 staging 自动（回归门）**
- **目标**：证明 staging DEPLOY 不产生审批记录、自动执行并进入 VERIFY。
- **改动**：**无生产代码**。在既有交付链 e2e 上补断言：staging DEPLOY 任务从 READY 直接进 RUNNING/SUCCESS；`approvals` 表中**不存在**指向该任务的记录。
- **落点**：`apps/server/src/__tests__/deliveryApi.e2e.test.ts`（既有本地交付链用例）。

**L1-2 生产人工（回归门）**
- **目标**：production DEPLOY 进入 `WAITING_APPROVAL`；**批准前 `deployments` 无 RUNNING / SUCCESS 记录**。
- **改动**：**无生产代码**。进入 `WAITING_APPROVAL` 的断言**已存在**（`deliveryApi.e2e.test.ts:301`）；补「批准前无部署记录」一条。
- **落点**：同上。

**L1-3 高风险人工（回归门）**
- **目标**：HIGH / CRITICAL 工具动作仍需审批，策略不得关闭该门。
- **改动**：**无生产代码**。补断言：对 HIGH/CRITICAL 动作，即便工作流策略声明自治，仍生成审批且未批准前不执行。
- **落点**：`packages/action-policy/src/__tests__/`（策略判定）+ `apps/server/src/__tests__/`（端到端一次真实 DENY/WAITING）。

### M2 策略载体（零行为变更）

**L1-7 策略载体与默认值**
- **目标**：自治级别是**工作流级策略字段**；**未显式选择 L1 时，行为与现状逐项一致**。
- **改动**：
  1. `packages/shared/src/index.ts` 的 `WorkflowPolicySchema` 新增 `autonomyLevel`（可选，取值见 §6 第 4 项），**不设默认值**——缺省即「非 L1」。
  2. 工作流创建路径透传（`CreateWorkflowSchema` 已有 `policy` 字段，`.strict()` 需同步允许新键）。
  3. `DEFAULT_WORKFLOW_POLICY` **不加**该字段（缺省＝现状）。
- **判据**：默认策略下既有测试**逐项不回归**（全量门禁）。
- **风险**：`WorkflowPolicySchema` 是 `.strict()`，新增字段会被已存库的旧 payload 校验影响——须核实**读取路径不做 schema 校验**（只在写入路径校验）。实施前先核实，冲突则报告。

### M3 强制执行与可审计

**L1-4 质量门在 L1 下强制**
- **目标**：L1 工作流中 `verdict = failed` → 任务 FAILED（`VERIFICATION_FAILED`），不得被后续当作成功。
- **改动**：把门模式从**全局配置**改为**按工作流取**：`verifyingTaskExecutor` 已收到 `workflow`，可读 `workflow.policy.autonomyLevel`；L1 → `enforce`，非 L1 → 沿用全局 `VERIFICATION_GATE`（见 §6 第 5 项）。
- **判据**：注入失败的 E2E——构造一个客观检查必然失败的任务，断言任务终态 `FAILED` 且 `output.errorType === "VERIFICATION_FAILED"`，且下游不把它当成功。
- **红线**：验证记录仍**只进** `output.verification`，**不得**因此回到 Agent 输入（`docs/151`）。

**L1-5 失败自动恢复有界**
- **目标**：RETRY 次数由策略声明（**默认上限 2**）；耗尽后工作流 FAILED、原因可读、不静默成功、不无限重试；**staging DEPLOY 失败自动生成 ROLLBACK 任务并执行**。
- **改动**：见 §6 第 1 项选定载体后实施。L1 策略下：普通任务失败 → `RETRY`（`maxRetries: 2`）；DEPLOY 任务失败 → `ROLLBACK`（引擎既有实现，`WorkflowEngine.ts:696`）。**耗尽后的终态**沿用既有 `failWorkflow`（`WORKFLOW_TASK_FAILED`，带可读原因）。
- **判据**：注入失败的 E2E 两条——① 普通任务连续失败到上限，断言重试次数恰为 2、终态 FAILED、无第 3 次；② staging DEPLOY 失败，断言自动生成 `<taskKey>-ROLLBACK` 任务且执行成功。
- **红线**：production 的 ROLLBACK 任务**仍带审批**（既有实现 `WorkflowEngine.ts:919` 已如此），不得由 L1 关闭。

**L1-6 自治决策可审计**
- **目标**：每次自动批准 staging、自动重试、自动回滚都写入 `workflow_events`（含策略标识与依据），可按 `workflowRunId` 查询。**只写日志不算。**
- **改动**：给 `docs/152` 已定义的四个事件**接上写入方**——`AUTO_APPROVED`（跳过审批执行 staging DEPLOY 时）、`AUTO_RETRIED`（`handleFailures` 的 RETRY 分支）、`AUTO_ROLLED_BACK`（`rollback()` 成功建任务后）、`VERIFICATION_ENFORCED_FAILURE`（`verifyingTaskExecutor` 在 enforce 下把任务判 FAILED 时）。全部走既有 `this.event(...)` 写入通道，`policyId` 固定为级别名（见 §6 第 4 项）。
- **判据**：E2E 断言四个事件各至少出现一次，payload 通过 `parseAutonomyDecisionPayload`，且能按 `workflowRunId` 从 `GET /api/workflows/:id/events` 与 `/trace` 查到。
- **分工**：`AUTO_RETRIED` 与既有 `TASK_RETRYING` 的关系见 §6 第 2 项。

### M4 数据门槛

**L1-8 数据门槛（staging 段）**
- **目标**：L1 策略下 E1×3 批次，**staging 交付（含 VERIFY）成功 ≥ 2/3**，附归因。
- **改动**：
  1. `packages/eval` 新增 staging 段判据（字段名待定，如 `stagingDelivered`）＝ CI 成功 **且** staging DEPLOY 成功 **且** 其后的 VERIFY 成功。**不用 `deliveredSuccess`**（已裁定弃用，`docs/131` 后续块）。
  2. 汇总与报告同步（`packages/eval/src/metrics.ts` / `report.ts`）。
  3. 跑一次 E1×3 真实批次并归档（`packages/eval/results/`）。
- **判据**：≥ 2/3 即达成；未达则**如实记录 PASS-PARTIAL 并归因**（沿用 `docs/127` §9 的做法），不伪装。
- **成本**：真实模型批次，消耗周配额。**开工前向用户确认配额余量。**

## 4. 验证分层

| 层 | 内容 | 位置（`AGENTS.md` §4 / §6 / §7） |
| --- | --- | --- |
| 单元 | 策略 schema、自治级别取值、决策事件的写入条件 | `packages/shared/src/*.test.ts`（同目录惯例）、`packages/workflow-engine/src/*.test.ts` |
| 集成 | 失败路由与重试上限、门模式按工作流取 | `packages/workflow-engine/src/WorkflowEngine.test.ts`、`apps/server/src/__tests__/*.test.ts` |
| E2E | 交付链审批行为（L1-1/2/3）、注入失败的强制门（L1-4）、有界重试与自动回滚（L1-5）、决策事件落库（L1-6） | `apps/server/src/__tests__/*.e2e.test.ts`（真 postgres:16 + 真 HTTP） |
| 批次 | staging 段成功率 | `packages/eval`，产物落 `packages/eval/results/` |

门禁：`corepack pnpm --filter @ai-se/server typecheck && lint && test`（改动涉及 `shared` / `workflow-engine` / `action-policy` 时各包同样跑）；收尾跑全仓 `-r`。**按事实逐次记录全仓 `-r test` 结果**（`docs/146` §5 现行口径：既可能出现一次跑通，也可能出现时序敏感偶发失败）。

## 5. 退出条件

L1 收口 = **L1-1 … L1-9 全部满足**（L1-9 是不变量红线，须全程守住），外加：

- `docs/17` 的「自治 L1」节逐项回勾，并写明每条的证据；
- 新增一份实施记录 `docs/155`（形态同 `docs/153`）；
- `docs/146` §1 / §2.1 / §3 同步；`docs/127` §0 / §9 同步；
- **M4 未达 ≥ 2/3 时**：不勾 L1-8，按 PASS-PARTIAL 记录并归因——**不因批次未达而否定 M1–M3**，也不伪装。

## 6. 待裁定项（每条带推荐值，等你一句话）

| # | 事项 | 选项 | 推荐 |
| --- | --- | --- | --- |
| 1 | **L1-5 的失败路由载体**：单个 `failureStrategy` 枚举表达不了「普通任务 RETRY + DEPLOY 失败 ROLLBACK」 | A. 接线既有 `failureRouter`（`@ai-se/failure-recovery`，**现仅测试接线**），L1 返回 RETRY/ROLLBACK、非 L1 返回 `undefined`；B. 在 `WorkflowPolicy` 新增 `deployFailureStrategy` 字段，引擎内分支 | **B**。理由：L1 的本质是一个**策略**，语义应写在策略里（可声明、可测试、可审计）；`failureRouter` 是为 5.7-5 的失败分类与停滞检测设计的另一个抽象，接到生产会让**所有**工作流都过它，而 L1-7 要求非 L1 逐项不变。B 只影响声明了 L1 的工作流 |
| 2 | **`AUTO_RETRIED` 与既有 `TASK_RETRYING` 的分工**（`docs/152` Known Issue 3 挂账） | A. 两者都写：`TASK_RETRYING` 是引擎的**机械事实**（既有，形状不改），`AUTO_RETRIED` 是**策略决策**（带 `policyId` / `reason`）；B. 只写 `AUTO_RETRIED`；C. 把决策字段并进 `TASK_RETRYING` | **A**。两者回答不同问题（状态机发生了什么 / 策略为什么这么决定）。**明确否决 C**：改既有事件形状会违反 7-E 的 OB-10（既有 payload 不变） |
| 3 | **`AUTO_APPROVED` 的触发点**：staging DEPLOY 根本不产生审批记录（L1-1），「自动批准」在什么时刻写？ | A. 在**策略判定无需人工、任务从 READY 直接进入执行**的那一刻写，语义＝「策略判定无需人工审批」；B. 不写该事件 | **A**。否则 L1-6 的「每次自动批准 staging」没有记录面。契约里 `environment` 已锁死 `"staging"`，生产不可表达 |
| 4 | **自治级别的取值空间与 `policyId` 取值**（`docs/152` Known Issue 4 挂账） | A. 只定义 `"L1"`，`policyId` 固定为 `"L1"`；B. 预留 `"L2"` / `"L3"` 空壳 | **A**。L2 / L3 未定义，加进去就是空壳字段；日后要加是一次向后兼容的枚举扩展 |
| 5 | **L1-4 的门模式与全局 `VERIFICATION_GATE` 的关系** | A. L1 工作流一律 `enforce`（不论全局值），非 L1 沿用全局值；B. L1 只在全局值为 `enforce` 时强制 | **A**。L1-4 的判据是「**L1 工作流中** verdict=failed → 任务 FAILED」，与全局配置无关；否则「L1 是否强制」取决于一个全局开关，验收项就不成立了。全局默认仍为 `observe`（`docs/148` 的裁定不动） |

**裁定结果（2026-10-15 用户「都按推荐」——五项全部按上表推荐值落定）**：

1. L1-5 的失败路由载体＝**在 `WorkflowPolicy` 新增 `deployFailureStrategy`**（不接线 `failureRouter`）。
2. `AUTO_RETRIED` 与 `TASK_RETRYING` ＝**两者都写**（机械事实 + 策略决策），**不改既有事件形状**。
3. `AUTO_APPROVED` 的触发点＝**策略判定无需人工、任务直接进入执行的那一刻**。
4. 自治级别取值空间＝**只定义 `"L1"`**；`policyId` 固定为 `"L1"`。
5. L1-4 的门模式＝**L1 工作流一律 `enforce`**（不论全局 `VERIFICATION_GATE`），非 L1 沿用全局值。

**未决项：无。** 五项已全部裁定，M1–M3 的开工条件已清空（M4 另需配额确认）。

## 7. 红线（沿用 `docs/17` L1-9 + `docs/147` §7）

- **生产与高风险的人工门不可由策略关闭**：production DEPLOY 强制审批、HIGH / CRITICAL 工具动作强制审批——L1 只能让 **staging 与低风险**自动。
- Tool Runtime 是唯一执行路径；**不新增第二套** Permission / Approval / Audit / 错误码体系。
- 明文 credential / token 不进 Prompt、State、Task、Log、Result；决策事件的 `reason` 是自由文本，落库前走 `@ai-se/observability` 的既有 sanitize（`docs/152` Known Issue 5）。
- 验证记录仍只进 `output.verification`，**不得**回到 Agent 输入（`docs/151` 的裁定不回退）。
- 观测与决策记录**只增不改**：不修改既有事件类型与既有 payload 形状。
- 不修改任何 `dist/`；不做运行期重启实验（沿用 `docs/145` 的后端边界）。

## 8. 与其它阶段的关系

| 依赖 | 状态 |
| --- | --- |
| `docs/147` 7-A（关联 ID 贯通）→ L1-5 的重试与回滚能关联回工作流 | **已交付**（`docs/149`） |
| `docs/147` 7-B（指标端点）→ L1-8 的批次期可读指标 | **已交付**（`docs/149`） |
| `docs/147` 7-C（追踪视图）→ L1-6 的可审计面 | **已交付**（`docs/150`） |
| `docs/147` 7-E（决策事件契约）→ L1-6 的事件形状 | **已交付**（`docs/152`） |
| `docs/151`（验证证据不进 Agent 输入）→ L1-4 的前置 | **已落地** |

**四项依赖全部就绪**——这是 L1 现在可以开工的依据（`docs/147` §8）。

## 9. 审阅轮记录

- 2026-10-15 草案 v1：待审阅。**未开工**。§6 五项待裁定（均带推荐值）。
- 2026-10-15 同日：用户已裁定 `docs/146` §4 的三项历史待裁决（仪表盘保留现状 / 占位不做 / 弃用 `deliveredSuccess`），其中第三项直接影响 L1-8 的判据口径——**本任务书已按弃用口径写**。
- 2026-10-15 裁定：用户「都按推荐」——**§6 五项全部按推荐值落定**（见 §6 末尾「裁定结果」）。开工条件清空，按 M1 → M3 实施（M4 待配额确认）。
- 2026-10-15 实施：**M1 – M3 已完成**（L1-1 … L1-7 与 L1-9 达成），实施记录 **`docs/155`**。实施中的两处设计细化：① 自治决策的 payload 由**类型**在编译期约束、写入前**不做运行期校验**（运行期抛错会让观测路径反过来压垮工作流，违反 `docs/147` §7 的观测只读红线；契约一致性改由测试断言 `parseAutonomyDecisionPayload` 保证）；② 验证门记录里的 `mode` 必须同步为**生效值**，否则审计面会出现「记 observe 却判失败」的自相矛盾。**M4 未开工。**
