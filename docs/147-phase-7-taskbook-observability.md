# 147 · 阶段 7 任务书：可观测性（Observability）

> 状态：**已收口（2026-10-15）**。M1（7-A / 7-B）与 M2（7-C / 7-E）全部交付，OB-01 … OB-10 全绿，7-D 延期；§6 的五项已全部裁定并落地（见 §6 表）。实施记录与验收见 `docs/149`（M1）、`docs/150`（7-C）、`docs/151`（§6 第 4 项的裁定与实施）、`docs/152`（7-E）；**收口记录 `docs/153`**——§5 的三项收口动作（`docs/17` 六项回填、`docs/12` 基线更新、`docs/146` 同步）均已完成。
> 依据：`docs/12-observability.md`（设计意图来源，文首「基线状态」表）、`docs/17` 节「Phase 7 — Observability（V1 后续增强）」（六项验收清单）、`docs/146` §1 与 §2.1，以及 2026-10-15 对代码与迁移的只读核对（§1 逐条给出 `file:line`）。
> 编号：任务编号 **7-A … 7-E**；验收编号 **OB-nn**（草案内建议编号，审阅轮冻结）。
> 与 Phase 8 的边界：本阶段**不含** incident、告警、诊断、修复（属 `docs/13`，未排期）。

## 1. 为什么这样排：基线事实

| 事项 | 现状（代码核对） | 证据 | 对本阶段的含义 |
| --- | --- | --- | --- |
| 结构化日志 | 已有。`createLogger` 输出 JSON；`sanitizeLogData` / `redactString` 脱敏 | `packages/observability/src/index.ts`；`packages/tool-runtime/src/ToolRuntime.ts:157` | 日志层不重做，只补关联字段 |
| HTTP 请求 ID | 已有。`requestLogger` 读 `x-request-id`、否则生成 UUID；响应体回传 `requestId` | `apps/server/src/http/requestLogger.ts:25`，`apps/server/src/http/response.ts:4` | 关联链的**起点** |
| 请求 ID 进入工作流 | **未贯通**。工作流执行器与部署编排器各自 `randomUUID()` 生成新 ID；`WorkflowEngine.start(id)` 不接收 requestId | `apps/server/src/services/workflowTaskExecutor.ts:199`，`apps/server/src/services/deploymentOrchestrator.ts:624`、`:661`，`packages/workflow-engine/src/WorkflowEngine.ts:87` | 7-A 的主要改动点 |
| 工具审计日志的 ID | 含 `projectId / taskId / agentRunId / toolCallId`，**不含 `workflowRunId`**（`packages/tool-runtime/src` 中无此字段） | `ToolRuntime.ts:157` 的日志字段；grep 无结果 | 从日志反查工作流要多一跳 |
| 持久化事实 | 已有 `workflow_runs`、`tasks`、`agent_runs`（`token_usage`、`estimated_cost`，状态含 `timed_out`）、`tool_calls`（`status`、`duration`）、`workflow_events`（`sequence`、`workflow_run_id`、`agent_run_id`、`event_type`、`payload`）、`deployments` | `packages/database/migrations/002_*.sql`、`004_*.sql` | 指标与追踪可直接由库派生，**不需要先埋点** |
| 聚合指标 | 已有 `GET /api/agents/metrics` → `AgentEvaluationMetrics`（成功率三项，测试 / 评审 / 修复通过率，平均迭代与耗时，token，成本） | `packages/shared/src/index.ts:979`，`apps/server/src/routes/agents.ts:13` | 业务口径已覆盖 docs/12 九项中的 5 项 |
| docs/12 九项缺口 | Agent Run Count、Tool Duration、Workflow Duration、Deployment Success/Failure 不在聚合里；均可由现有表派生 | 同上 | 7-B 补齐，不新增埋点 |
| 时序指标端点 | 无 `/metrics`；无 Prometheus 客户端依赖 | `apps/server/src` 无 `prom-client`、`@opentelemetry` 引用 | 7-B 的主要新增 |
| 端到端追踪 | 无 trace 设施；requestId 不跨层；无 trace / span ID | 同上 | 7-C 从数据库派生，不用 OTel |
| 外部栈 | 无 OTel、Grafana、Loki、Prometheus 服务与 compose；`infrastructure/` 仅 `docker/Dockerfile` | `infrastructure/docker/` | 7-D 需要新基础设施，**须单独裁定** |
| 审计表 | `audit_logs` 由迁移创建，**全仓无写入方**（休眠表） | 迁移清单；grep 无写入 | `AGENTS.md` §10 禁止第二套审计：已裁定本阶段不动（§6 第 3 项） |
| 验证证据的去向 | 验证门（observe / enforce）的记录写入任务 `output.verification`；每个检查的 stdout / stderr 尾部各最多 2000 字符 | `apps/server/src/services/verifyingTaskExecutor.ts`，`apps/server/src/services/taskVerifierRules.ts:277` | 观测证据与 Agent 输入曾耦合；**2026-10-15 已解耦**（§6 第 4 项裁定：记录仍在任务输出里，但不进 Agent 输入，`docs/151`） |
| 质量门默认值 | 2026-10-15 起默认 `observe`（原为 `off`） | `apps/server/src/config.ts:67` | 开发类任务每次都会写入上述记录 |

**结论**：docs/12 的「Phase 2」部分已实现并超出；日志已实现。**从未开工的**是：请求 ID 贯通、时序指标暴露、端到端追踪、外部栈。其中大部分可以**先用既有数据库事实派生**，不必先引入依赖。

## 2. 范围与里程碑

| 里程碑 | 内容 | 出口 |
| --- | --- | --- |
| **M1 底座**（零新增依赖） | 7-A 关联 ID 贯通；7-B 指标端点（文本导出） | OB-01 … OB-06 全绿 |
| **M2 追踪与契约**（零新增依赖） | 7-C 追踪视图（数据库派生）；7-E 决策事件契约 | OB-07 … OB-10 全绿 |
| **M3 外部栈**（条件性） | 7-D OpenTelemetry、Prometheus 抓取、Loki、Grafana | **已裁定延期**（§6 第 1 项）；`docs/17` 对应三项注明「延期（依赖与基础设施未批准）」，不勾选 |

**本阶段不做**：incident、告警、诊断、修复（Phase 8）；任何 `incidentId` 字段、表或路由（前提不存在）；基于指标的自动优化器（未排期，属「持续优化」的另一段设计）；追踪的前端页面（已裁定另立阶段，§6 第 5 项）；把 `verification` 证据迁出 `output`（§6 第 4 项已裁定**不迁**——改为不进 Agent 输入，见 `docs/151`）。

## 3. 任务明细

### 7-A 关联 ID 贯通（M1）

**目标**：一次工作流运行的所有持久化事实与日志行，都能用同一组 ID 关联回发起它的 HTTP 请求。

**改动（草案）**：
1. `WorkflowEngine.start` 接收触发请求的 `requestId`，写入 `WORKFLOW_STARTED` 事件的 payload（不改表结构）。
2. `ToolExecutionContext` 增加可选 `workflowRunId`，工具审计日志带上它。
3. `WorkflowTaskExecutor` 与 `DeploymentOrchestrator` 不再为每次执行新生成 requestId，改为沿用工作流的 requestId；任务与 Agent Run 的 ID 照常保留。

**验收（OB-01 … OB-03）**：
- OB-01 对一次本地交付 run，抽样的工具日志行均含 `workflowRunId`，且能与 `tool_calls` 行一一对齐（脚本核对）。
- OB-02 `WORKFLOW_STARTED` 事件 payload 含 `requestId`，与触发该请求的 HTTP 响应体中的 `requestId` 相同。
- OB-03 既有 API 响应形状不变（既有测试不回归）；日志仍经 `sanitizeLogData`。

**不做**：不引入 OTel；不改日志格式；不新增表。

### 7-B 指标端点（M1）

**目标**：`docs/12` 的九项指标以 Prometheus 文本格式只读暴露，数据源为数据库聚合。

**改动（草案）**：
1. 新增 `apps/server/src/routes/metrics.ts` 与 `apps/server/src/services/metricsService.ts`（`AGENTS.md` §4：一资源一文件）。
2. 聚合查询与 `AgentEvaluationMetrics` **复用同一查询函数**，不另写一份口径，避免两套数字。
3. 文本导出器手写（约 100 行，零依赖）——**已裁定**（§6 第 1 项）。
4. 路由挂在 `/api` 之下，继承既有 `apiTokenGuard`——**已裁定**（§6 第 2 项）。

**标签约束**：只允许有限集合（`status`、`agent_type`、`tool_name`、`environment`）。**禁止** `requestId`、`taskId`、`workflowRunId` 作标签（高基数）。

**验收（OB-04 … OB-06）**：
- OB-04 输出可被最小 Prometheus 文本解析器解析（单测断言 `# TYPE` 行与样本行格式）。
- OB-05 九项数值与直接 SQL 聚合一致（e2e，误差为 0）。
- OB-06 输出不含 credential / token 形状的字符串（用 `redactCredentialShapedText` 的样本做断言）。

### 7-C 端到端追踪视图（M2）

**目标**：给定 `workflowRunId`，返回 `Workflow → Task → AgentRun → ToolCall`（以及 `Deployment`）的树，节点含状态、耗时、时间戳。

**改动（草案）**：`GET /api/workflows/:id/trace`；新增 `apps/server/src/services/traceService.ts`。数据全部来自 `workflow_events`、`tasks`、`agent_runs`、`tool_calls`、`deployments`，**不引入 span 概念**。

**验收（OB-07 … OB-08）**：
- OB-07 树的节点数与数据库行数一致（e2e）。
- OB-08 交付链四节点（CI → staging DEPLOY → VERIFY → production DEPLOY）可见；production DEPLOY 处于等待审批时显示 `WAITING_APPROVAL`（与 `docs/127` §9 的 E1 归因一致）。

### 7-E 决策事件契约（M2，为自治 L1 服务）

> **已完成（2026-10-15）**：实施记录与验收见 `docs/152`。事件名沿用下方候选值（原标「名称待审」）；两条不变量在契约层成立——`AUTO_APPROVED` 只收 staging、`AUTO_RETRIED` 的 `attempt <= maxAttempts`。本阶段只有契约、无写入方。

**目标**：在 `packages/shared` 定义自治决策事件的类型与 payload 契约，**不改变任何现有行为**，供 `docs/17` 的「自治 L1」验收项 L1-6 使用。

**候选事件**（名称待审）：`AUTO_APPROVED`（仅限 staging）、`AUTO_RETRIED`、`AUTO_ROLLED_BACK`、`VERIFICATION_ENFORCED_FAILURE`。每个事件的 payload 含 `policyId`、`reason`、`workflowRunId`、`taskId`，不含任何密钥。

**验收（OB-09 … OB-10）**：
- OB-09 契约以 zod 定义，单测覆盖合法与非法 payload。
- OB-10 现有事件类型与既有 payload 不变（既有测试不回归）。

### 7-D 外部栈（M3，条件性）

**已裁定延期（§6 第 1 项，2026-10-15）**：OpenTelemetry SDK 导出（由 7-C 的树映射为 span）；Prometheus 抓取 7-B 端点；Loki 收集 stdout 的 JSON 日志；Grafana 面板。

- 需要：新增依赖（`@opentelemetry/*`，可选 `prom-client`）+ 新基础设施（compose 放 `infrastructure/`）。**两项均未获批准。**
- 处置：**延期**。`docs/17` 中对应三项（OpenTelemetry / Grafana / Loki）注明「延期（依赖与基础设施未批准）」，**不勾选**；Prometheus 一项的实际覆盖范围（7-B 的文本端点，无 Prometheus 服务端）在收口时按 §5 判定为「替代」或「延期」。


## 4. 验证分层

| 层 | 内容 | 位置（`AGENTS.md` §4 / §6 / §7） |
| --- | --- | --- |
| 单元 | 文本导出器、契约 zod、ID 沿用 | `apps/server/src/__tests__/*.test.ts` |
| 集成 | 指标聚合与直接 SQL 比对 | 复用 `packages/database/src/testPostgresContainer.ts` |
| E2E | 工作流 run → 追踪树 / 指标端点 / 关联 ID | `apps/server/src/__tests__/*.e2e.test.ts` |
| 手工 | 对运行中的实例做只读 `curl`（不触发任务） | 记入实施记录，不计入门禁 |

门禁：`corepack pnpm --filter @ai-se/server typecheck && lint && test`；收尾跑全仓 `-r`。**不声称单次全仓一次通过**：凡偶发失败，须单独复跑并记录（沿用 `docs/145` Known Issue 7）。

## 5. 退出条件

Phase 7 收口 = **M1 + M2 全绿**（OB-01 … OB-10），外加：

- `docs/17` 的 Phase 7 六项逐项回填：完成 / 替代（写明替代方案）/ 延期（写明理由）；
- `docs/12` 基线表更新到收口时的事实；
- `docs/146` §1、§2.1、§3 同步。

M3 按 §3 的裁定结果处理，**不作为 Phase 7 收口的必要条件**，但必须在 `docs/17` 中显式标注。

## 6. 裁定结果（2026-10-15 用户：全部按建议值）

| # | 事项 | 裁定 | 对任务书的影响 |
| --- | --- | --- | --- |
| 1 | 依赖策略 | **手写文本导出，零依赖**；7-D 外部栈（OTel / Loki / Grafana / Prometheus 服务）**不引入** | 7-B 按 §3 第 3 条实施；7-D **延期**，`docs/17` 对应三项注明延期 |
| 2 | 指标端点路径 | **`/api/metrics`** | 继承既有 `apiTokenGuard`；不新增根路径鉴权 |
| 3 | `audit_logs` 休眠表 | **本阶段不动** | 维持休眠；`AGENTS.md` §10 的红线照旧（不另起第二套审计）。启用或删除**均未裁定**，日后单独立项 |
| 4 | 验证证据去向 | **留在任务输出里（存放位置不动），但不进 Agent 输入**：`dependencyResults[].output` 剥掉 `verification`（2026-10-15 用户裁定，实施记录 `docs/151`）。存储侧与两个生产读取方（AC 覆盖判定、追溯表）一律不动 | 7-E 的前置**已清空**；`observe` 模式从此只观测、不改变 Agent 输入 |
| 5 | 追踪视图前端 | **另立阶段** | 本任务书只交付 API（7-C）；前端页面不属 Phase 7 |

**未决项：无。** §6 五项全部裁定并落地。第 4 项（验证证据去向）已于 2026-10-15 裁定为「留在任务输出里、不进 Agent 输入」，实施记录 `docs/151`；7-E 的开工前置因此清空。

## 7. 红线（沿用 `docs/130` §8 + 本阶段增补）

- **观测只读**：不改变任务结果、状态机与审批语义；观测层的任何异常必须被吸收，不得使任务失败（沿用 `verifyingTaskExecutor` 中「验证异常 → unavailable」的语义）。
- Tool Runtime 唯一执行路径；不新增第二套 Permission / Approval / Audit / Secret / 错误码体系（`audit_logs` 的处理见 §6 第 3 项）。
- 明文 credential / token 不进入日志、指标标签、追踪树（经 `@ai-se/observability` 脱敏）。
- 不引入 `incidentId`，不为它建空字段、空表或空路由。
- 指标标签基数受控（见 §3 的 7-B）。
- 不修改任何 `dist/`；运行期不做重启实验（沿用 `docs/145` 的后端边界）。

## 8. 与自治 L1 的依赖

| 自治 L1 验收项（`docs/17`「自治 L1」节） | 依赖的阶段 7 产出 |
| --- | --- |
| L1-5 失败自动恢复有界 | 7-A（重试与回滚必须能关联回工作流） |
| L1-6 自治决策可审计 | 7-E（事件契约）+ 7-C（追踪可见） |
| L1-8 数据门槛 | 7-B（批次期间可读指标） |

**因此 L1 的实现排在 M2 之后。** L1 的**定义**（验收项）不依赖本阶段，可以先行。

## 9. 审阅轮记录

- 2026-10-15 草案 v1：待审阅。未开工。
- 2026-10-15 裁定：用户「都按你的建议」——§6 五项全部按建议值落定（零依赖 / `/api/metrics` / `audit_logs` 不动 / 验证证据去向留到 7-E 前 / 前端另立）。7-D 延期。
- 2026-10-15 实施 M1：**7-A 与 7-B 已完成**（OB-01 … OB-06 全绿）。实施记录与验收见 `docs/149`；`docs/12` 基线表、`docs/17` 的 Phase 7 节、`docs/146` 已同步。
- 2026-10-15 实施 7-C：**端到端追踪已完成**（OB-07 / OB-08 全绿）。实施记录与验收见 `docs/150`；`docs/09`（API 清单）、`docs/12` 基线表、`docs/17` 的 Phase 7 节（`End-to-end trace` 已勾）、`docs/146` 已同步。实施中的两处设计细化：任务节点按 `started_at` 排序（同一事务克隆的任务 `created_at` 相同，沿用仓储顺序会退化成字母序）；`detail` 为白名单标量，工具调用的 `input`/`output` 不进树。
- 2026-10-15 裁定 §6 第 4 项：**验证证据留在任务输出里（存放位置不动），但不进 Agent 输入**（`dependencyResults[].output` 剥掉 `verification`）。用户答「如果这个很有必要的话，就改为观测通道存放」；实测（1186 个任务带验证记录、平均 2.9 KB、其中 53% 是原始 stdout/stderr、两个生产读取方从不读尾部、`dependencyResults` 只有一进一出）表明**迁存储零收益且要动验收路径上的读取方**，真正的问题是提示词耦合；据此给出推荐值，用户选择「整个拿掉」。实施记录 `docs/151`。**§6 五项至此全部落地，7-E 的开工前置清空。**
- 2026-10-15 实施 7-E：**自治决策事件契约已完成**（OB-09 / OB-10 全绿）。四个事件（`AUTO_APPROVED` / `AUTO_RETRIED` / `AUTO_ROLLED_BACK` / `VERIFICATION_ENFORCED_FAILURE`）在 `packages/shared` 以 zod 定义，写进**既有** `workflow_events` 表，无写入方、不改任何现有行为。实施记录见 `docs/152`；`docs/17` 的 L1-6 依赖注记、`docs/146` 已同步。
- **M2 完成，Phase 7 只剩收口动作**（`docs/147` §5 的条件已满足：M1 + M2 全绿、OB-01 … OB-10 全绿；未执行的是 `docs/17` 六项回填与 `docs/12` 基线更新）。7-D 维持延期。
- 2026-10-15 **Phase 7 收口**：§5 的三项收口动作全部完成——① `docs/17` 的 Phase 7 六项逐项回填：**完成 2 项**（端到端 trace、Agent/Tool/Workflow metrics）、**延期 4 项**（OpenTelemetry / Grafana / Loki 无替代；**Prometheus 为「延期（部分替代）」**——7-B 的零依赖文本端点即 Prometheus 格式，平台侧抓取契约成立，服务端与抓取未部署，故**不勾选**而其能力面已计入指标一项）；② `docs/12` 基线表更新到收口时的事实；③ `docs/146` §0（新增状态词「已收口」）/ §1 / §2.1 / §3 / §5 同步。同步更新的活文档另有 `docs/15`、`docs/18`、`docs/127`、`README.md`。**收口记录 `docs/153`**。7-D 维持延期，不作为收口条件。
