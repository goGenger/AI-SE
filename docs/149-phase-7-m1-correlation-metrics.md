# 149 · 阶段 7 M1 实施记录：关联 ID 贯通（7-A）· 指标端点（7-B）

> 日期：2026-10-15 ｜ 类型：阶段 7 的 **M1 子阶段**（用户点名「开始阶段 7 的 7-A 和 7-B」）
> 依据：`docs/147`（阶段 7 任务书，§6 五项已裁定）、`docs/146` §6 规则 7/8、`AGENTS.md` §9/§11。
> 承接：`docs/148`（质量门 observe · 自治 L1 定义 · 阶段 7 任务书 · 文档同步）。
> 范围：**只做 M1（7-A + 7-B）**。M2（7-C / 7-E）、7-D 外部栈、自治 L1 一律未开工。

## Modified Files

**代码（新增 5）**
- `apps/server/src/services/workflowCorrelation.ts`：工作流 requestId 解析器（`WORKFLOW_STARTED` 事件为准；查询失败回落）。
- `apps/server/src/services/metricsService.ts`：九项指标的组装（五项复用既有口径，四项来自新聚合）。
- `apps/server/src/services/prometheusText.ts`：Prometheus 文本格式导出器（手写，零依赖）。
- `apps/server/src/routes/metrics.ts`：`GET /metrics` 路由（文本响应，非统一 JSON 信封）。
- `packages/database/src/metricsRepository.ts`：`PgMetricsRepository.aggregate()`（本阶段新增的四项聚合）。

**代码（修改 17）**
- `packages/workflow-engine/src/WorkflowEngine.ts`：`start(id, options?: { requestId? })`，payload 增加 `requestId`。
- `packages/database/src/agentRunStores.ts`：`PgWorkflowEventStore.findWorkflowStartedRequestId()`（窄查询）。
- `packages/database/src/index.ts`：导出新仓储与类型。
- `packages/tool-runtime/src/types.ts`：`ToolExecutionContext` / `ToolAuditInfo` 增加可选 `workflowRunId`。
- `packages/tool-runtime/src/ToolRuntime.ts`：`createAudit` 与失败回落审计带 `workflowRunId`。
- `packages/mcp/src/integration/adapter.ts`：MCP 工具审计带 `workflowRunId`。
- `packages/agent-core/src/agent/AgentContext.ts`：增加可选 `workflowRunId`（经 ToolRuntimeBackend 透传）。
- `packages/agent-core/src/professional/ToolRuntimeBackend.ts`：未授权工具的失败审计带 `workflowRunId`。
- `apps/server/src/services/workflowTaskExecutor.ts`：沿用工作流 requestId（原每次 `randomUUID()`）；Agent 上下文带 `workflowRunId`。
- `apps/server/src/services/deploymentOrchestrator.ts`：`executeReleaseTool` 与 `context()` 沿用工作流 requestId（`context()` 改为异步），工具上下文带 `workflowRunId`。
- `apps/server/src/services/workflowService.ts`：`start(id, options?)` 透传。
- `apps/server/src/services/taskVerifier.ts`：验证检查的工具上下文带 `workflowRunId`（一行）。
- `apps/server/src/services/actionRecoveryExecutor.ts`：恢复动作的工具上下文带 `workflowRunId`（一行）。
- `apps/server/src/routes/workflows.ts`：start 单独成路由，把 `res.locals.requestId` 交给服务。
- `apps/server/src/app.ts`：装配 `metricsService` 与 `/api/metrics` 路由。
- `apps/server/src/index.ts`：构造解析器与新服务，注入执行器 / 编排器 / 应用。

**测试（新增 4）**
- `apps/server/src/__tests__/workflowCorrelation.test.ts`（解析器契约：命中 / 缺省回落 / 查询失败回落）
- `apps/server/src/__tests__/workflowCorrelation.e2e.test.ts`（真库 + 真 HTTP + 脚本化 Agent 走真工具调用）
- `apps/server/src/__tests__/prometheusText.test.ts`（文本格式：最小解析器 + 转义 + NaN + 空家族）
- `apps/server/src/__tests__/metricsEndpoint.e2e.test.ts`（九项 vs 直接 SQL + 凭据形状 + token 门）

**测试（修改 8）**
- `packages/workflow-engine/src/WorkflowEngine.test.ts`、`packages/tool-runtime/src/__tests__/toolRuntime.test.ts`（各自新增 7-A 用例）
- `apps/server/src/__tests__/`：`workflowApi`、`professionalAgents`（×2 处）、`terminationPropagation`、`v1GoldenScenario`（×2 处）、`deliveryLifecycle`、`deliveryApi` —— 前六个补上新依赖 `requestId`；`deliveryApi` 额外加「真实交付 run 的工具日志抽样」断言。

**文档（新增 1 / 修改 9）**：本文件；`README.md`（现状说明）、`docs/09`（API 清单加 `GET /api/metrics`）、`docs/12`（基线表两行）、`docs/15`、`docs/17`（Phase 7 节）、`docs/18`（Phase 7 实现进度）、`docs/127`、`docs/146`（§1/§2.1/§3/§5）、`docs/147`（状态与 §9）。

**未修改**：`docs/133–145` 等历史阶段记录；`dist/`；`packages/eval` 的评测脚本（其显式设 `VERIFICATION_GATE=enforce`，本批未碰）。

## Implementation

1. **7-A · 关联 ID 贯通**
   - **起点**：`POST /api/workflows/:id/start` 的请求 ID（`requestLogger` 的 `res.locals.requestId`）经路由 → `WorkflowService.start` → `WorkflowEngine.start`，写入 `WORKFLOW_STARTED` 事件 payload 的 `requestId`（**不改表结构**）。
   - **读取**：`PgWorkflowEventStore.findWorkflowStartedRequestId()` 窄查询（`payload->>'requestId'`，取最早一条）；`createWorkflowRequestIdResolver` 把「事件优先、缺失/失败回落新 ID」这条策略收在一处（`docs/147` §7 红线：观测层异常不得让任务失败，因此查询异常被吸收并 warn）。
   - **沿用**：工作流任务执行器（原 `workflowTaskExecutor.ts:199` 每次 `randomUUID()`）与部署编排器（原 `deploymentOrchestrator.ts:624`/`:661`）改为调用解析器；任务 ID 与 Agent Run ID 照常保留。
   - **落地字段**：`ToolExecutionContext` / `ToolAuditInfo` / `AgentContext` 增加可选 `workflowRunId`，由执行器与编排器的工具上下文写入；因此工具日志的 `audit` 里同时有 `workflowRunId` + `agentRunId` + `toolCallId`（与 `tool_calls` 行一一对齐的三个键）。
   - **验证检查**：`TaskVerifier` 的工具上下文补 `workflowRunId`（一行，取自 `task.workflowRunId`）——否则验证类工具调用是唯一的无关联日志面。
2. **7-B · 指标端点**
   - **口径复用**：成功率三项、token、成本直接取 `PgAgentArtifactRepository.metrics()`（既有 `AgentEvaluationMetrics` 的同一查询），**没有第二份实现**；`GET /api/agents/metrics` 的 JSON 形状不变。
   - **新增聚合**：`PgMetricsRepository.aggregate()` 一次查询返回 Agent 运行按状态计数（口径与成功率分母一致：`input ? 'agentName'`）、工具调用按状态计数、部署按状态计数、工具与工作流耗时的 sum / 样本数。
   - **导出**：`prometheusText.ts` 手写（`# HELP` / `# TYPE` / 样本行；标签值转义；非有限值不写样本；毫秒 → 秒）。
   - **标签约束**：只允许有限集合，当前只有 `status`（取值来自库里的 CHECK 约束枚举）；禁止 `requestId` / `taskId` / `workflowRunId` 作标签。
   - **挂载**：`GET /api/metrics` 挂在 `/api` 之下，**继承既有 `apiTokenGuard`**；响应是 `text/plain; version=0.0.4`，不套统一 JSON 信封。

## Architecture Changes

- 三处**可选字段的附加**（`ToolExecutionContext` / `ToolAuditInfo` / `AgentContext`）与一个**可选参数**（`WorkflowEngine.start`）。既有调用方无需改动，语义不变。
- 新增一个 HTTP 端点 `GET /api/metrics`，是仓库里**第一个非 JSON 信封**的 API 响应（Prometheus 文本）。
- 新增一个数据访问类 `PgMetricsRepository`（`packages/database`，未新建包）。
- **未改**：状态机、审批语义、Tool Runtime 唯一执行路径、错误码体系、迁移、包边界。

## Dependencies

无新增依赖（含 devDependencies）。7-B 的文本导出器手写，未引入 `prom-client`；7-D 的 OTel / Loki / Grafana / Prometheus 服务端按裁定**不引入**。

## Tests

| 命令 / 范围 | 结果 |
| --- | --- |
| `@ai-se/tool-runtime` test | **32/32 通过**（含新增 7-A 审计用例 2 条） |
| `@ai-se/agent-core` test | **160/160 通过** |
| `@ai-se/mcp` test | **235/235 通过** |
| `@ai-se/database` test | **47/47 通过** |
| `@ai-se/workflow-engine` test | **36/36 通过**（含新增 `start` payload 用例） |
| `@ai-se/server` test（全量，共 4 次） | **254/254、253/254、253/254、254/254**。两次失败各一条、文件互不相同（`failureRecovery.e2e` 的 CANCELLED 用例 / `v1GoldenScenario.e2e` 的重启用例），**单独复跑均通过**（10/10、4/4）。最终代码状态下的那次为 **254/254** |
| 全仓 `pnpm -r run test`（收尾门禁，单次） | 15 个包全绿（observability 3、eval 35、shared 50、evidence 9、visual 83、failure-recovery 16、sandbox 7、action-policy 13、browser 38、workflow-engine 36、tool-runtime 32、agent-core 160、mcp 235、database 47、web 473）；**`apps/server` 252/254** —— 失败的两条是 `failureRecovery.e2e`（CANCELLED 用例）与 `v1GoldenScenario.e2e`（重启用例），**与 `docs/145` #7 同类**，单独复跑均通过（分别为 10/10 与 4/4）。不声称「一次全仓跑通」 |

新增/修改的用例覆盖：解析器三条路径；`WORKFLOW_STARTED` 事件里的 requestId 与 HTTP 响应一致；执行器与编排器沿用同一 ID；工具日志的 `workflowRunId` 与 `tool_calls` 的对齐键；文本格式可被最小解析器解析、标签转义、非有限值处理；九项与直接 SQL 聚合**逐值相等**；输出无凭据形状；`/api/metrics` 继承 token 门。

## Lint

- 改动包逐个 `lint`：`tool-runtime` / `agent-core` / `mcp` / `database` / `workflow-engine` / `server` 全部通过（退出码 0）。
- 全仓 `corepack pnpm -r run lint`：通过。

## Typecheck

- 改动包逐个 `typecheck`：全部通过。
- 全仓 `corepack pnpm -r run typecheck`：通过。
- 该命令会重建相关包的 `dist`（构建产物，未读取）。

## E2E

- **真库 + 真 HTTP**：`workflowCorrelation.e2e.test.ts` 起 postgres:16 容器 → 建项目 / 需求 / 任务（注入脚本化工具步）→ `POST /api/workflows/:id/start`（带 `x-request-id`）→ 断言：响应体 `requestId` 与 `WORKFLOW_STARTED` payload 一致；执行器日志沿用同一 ID；**每个 `tool_calls` 行都能按 (agentRunId, toolCallId) 找到对应的工具日志行，且该行带 `workflowRunId`**。
- **真实交付 run**：`deliveryApi.e2e.test.ts` 的本地交付链（CI → staging → 审批 → production）新增断言：`run_ci` / `deploy_release` / `verify_release` 的每条工具日志带 `workflowRunId` 与触发请求的 `requestId`，且 `toolCallId` 在 `tool_calls` 表中存在。
- **运行中的实例（只读）**：`GET /api/metrics` 返回 200 与 Prometheus 文本（`ai_se_agent_runs` 2164 / 30 / 68 / 7、成功率 0.9537、工具耗时均值 0.485 s、token 82,897,307、部署 5 / 1 / 1 等，取自本机真实库）；`GET /health` 200。**未触发任何任务，未运行真实模型工作流**（未获授权，也不属本批范围）。
- `ai_se_estimated_cost` 在该库中**只声明家族不写样本**：库里 `estimated_cost` 全为 NULL，属「无数据」的正常表现（见 Known Issues 4）。

## Known Issues

1. **requestId 只对「带 requestId 启动」的运行贯通。** 服务层启动（`workflowService.start(id)` 无 options）、恢复（`recover`）、人工重试、以及本改动之前启动的旧 run，其 `WORKFLOW_STARTED` payload 没有 `requestId`，解析器**每次调用回落一个新 ID**——与旧行为一致，但同一 run 内不同任务/部署的 `requestId` 不相同。**关联能力不受影响**（日志与工具审计都带 `workflowRunId`）。若要彻底统一，需让引擎在缺省时生成一个「运行级关联 ID」并落库，属后续决定。
2. **验证器与恢复执行器的工具日志带 `workflowRunId`，但 `requestId` 仍是每检查/每轮新生成**（`taskVerifier.ts` 的 `runTool`、`actionRecoveryExecutor.ts` 的工具上下文）。改它们要给这两个组件加 requestId 解析依赖，而全仓有 44 处 `new TaskVerifier(...)` 构造点，本批未做。
3. **`visualFixLoop` 的验证上下文用合成 ID**（`fix-loop-round-N`，无 `workflowRunId`）。属 Phase 5.6 视觉修复路径，不在 7-A 命名范围内。
4. **`ai_se_estimated_cost` 在数据缺失时不写样本**：设计如此（无数据优于 NaN），家族仍声明。
5. **响应头参数顺序**：实测 `Content-Type: text/plain; charset=utf-8; version=0.0.4`（Express 归一化后的顺序）。RFC 参数无序，Prometheus 的媒体类型解析可接受；未与框架对抗。
6. **指标端点目前无人抓取**：Prometheus 服务端与抓取属 7-D，已裁定延期。端点的鉴权继承 `/api`（配了 `API_TOKEN` 时需 Bearer）。
7. **`ai_se_agent_runs` 的口径是「有 `agentName` 的运行」**（与成功率分母一致，HELP 里写明）；单次 `POST /api/agent-runs`（coding agent 观察入口）的运行**不计入**该指标。
8. **全量测试时序抖动**（既有登记 `docs/145` #7）：本批 `apps/server` 全量两次均一次通过；但全仓单次 `-r test` 仍需按该口径对待，不声称「一次全仓跑通」。
9. **M1 未做的事**（红线，不得误读为已完成）：7-C 端到端追踪、7-E 决策事件契约、追踪前端、`audit_logs` 处置、验证证据迁出提示词、Prometheus 服务端、自治 L1 任何实现。
10. **脚本化步骤的选择有坑**（写给后续写测试的人）：本批判 7-A 用例时发现，脚本化的 `read_file` 步骤**不产生任何工具调用记录**（Agent 一次迭代即收尾、`tool_calls` 零行），换成 `git_diff` / `run_unit_test` 才有行。原因未深究（属 `deepagents` 宿主行为），已在用例注释里写明「换步骤前先确认 `tool_calls` 有行」。

## Acceptance Result

| 验收项（`docs/147` §3） | 判定 | 证据 |
| --- | --- | --- |
| OB-01 工具日志带 `workflowRunId` 且与 `tool_calls` 一一对齐 | **通过** | `workflowCorrelation.e2e.test.ts`（真库 + 真 run）；`deliveryApi.e2e.test.ts`（真实交付 run 抽样） |
| OB-02 `WORKFLOW_STARTED` 的 requestId == HTTP 响应 requestId | **通过** | `workflowCorrelation.e2e.test.ts`；`WorkflowEngine.test.ts` |
| OB-03 既有 API 响应形状不变、日志仍经脱敏 | **通过** | 全量 254/254（含 delivery / golden / workflowApi 等既有 API 契约用例）；工具日志仍走 `sanitizeLogData` |
| OB-04 输出可被最小 Prometheus 解析器解析 | **通过** | `prometheusText.test.ts`（内置最小解析器） |
| OB-05 九项数值与直接 SQL 聚合一致（误差 0） | **通过** | `metricsEndpoint.e2e.test.ts`（逐值 `toBe`，非近似） |
| OB-06 输出不含凭据形状字符串 | **通过** | 同文件：`redactCredentialShapedText(text) === text` + 标签键集合只允许 `status` |
| 依赖策略＝零依赖（§6 第 1 项） | **遵守** | 无新增依赖（package.json 未变） |
| 端点路径＝`/api/metrics`（§6 第 2 项） | **遵守** | `app.ts` 挂载在 `/api` 下；token 门用例 401/200 |
| `audit_logs` 不动（§6 第 3 项） | **遵守** | 未改迁移与任何写路径 |

## Next Phase Boundary

**本子阶段结束（STOP）。未开始事项**：
- **M2（7-C 端到端追踪 / 7-E 决策事件契约）**：未开工。7-E 开工前必须回答 `docs/147` §6 第 4 项（验证证据是否迁出下游提示词）。
- **7-D 外部栈**（OTel / Prometheus 服务端 / Loki / Grafana）：已裁定延期。
- **自治 L1 实现**（L1-4 … L1-8）：未开工，排在 M2 之后；L1-1 … L1-3 的回归断言也未补。
- **`provider` 运行时切换**：未开工（沿用 `docs/145` 边界）。
- 本批记录未做的事见 Known Issues 9。

**需要你回答（唯一）**：`docs/147` §6 第 4 项——`output.verification` 是否改为观测通道（事件或表）存放。它会改变 Agent 的输入，需要单独批准；不回答则 M2 只能做 7-C，不能做 7-E。

---

## 后续（2026-10-15 同日追加；上文一字未改）

上面那一项**已回答**：存放位置**不动**，改为**不进 Agent 输入**（`dependencyResults[].output` 剥掉 `verification`）。裁定依据、实施与验收见 **`docs/151`**；7-E 的开工前置因此清空。本记录其余内容不受影响。
