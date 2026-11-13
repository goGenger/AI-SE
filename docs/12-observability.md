# Observability

> ## 基线状态（2026-10-15 逐条核实；2026-10-15 Phase 7 收口时复核）
>
> 本文写于**平台实现之前**（第一版路线图的 Phase 7 设计），是**实现前设计**，不是 as-built 描述，
> **不构成开工依据**。原文一字未删（保留当初的设计意图），下面是对照现状的核实表：
>
> | 本文条款 | 与当前实现的关系 |
> | --- | --- |
> | 技术栈 OTel / Prometheus / Grafana / Loki | **四项均未引入**（7-D 外部栈已裁定延期，`docs/147` §6 第 1 项；收口时逐项回填见 `docs/17` 节「Phase 7 — Observability」）。其中 **Prometheus 为「延期（部分替代）」**：7-B 以零依赖方式交付了 Prometheus 文本格式的指标端点（见下行），平台侧抓取契约成立，但服务端与抓取未部署。OTel / Grafana / Loki 无替代方案 |
> | Correlation IDs 里的 `incidentId` | **前提错误**：全仓没有任何 incident 表 / 路由 / 服务（AI SRE 属 Phase 8，未排期）。动工时应**剔除**该 ID，或先有 incident 这个概念 |
> | Trace（Request → Workflow → Task → Agent → Tool → Sandbox） | **已实现（7-C，2026-10-15）**：`GET /api/workflows/:id/trace` 由既有事实表**派生** `Workflow → Task → AgentRun → ToolCall`（部署挂在其任务下），节点含状态、耗时、时间戳，**不引入 span 概念**、无新增埋点。Request 层经 7-A 的 `requestId` 可见（仅限经 HTTP 启动的运行）；Sandbox 层不单独成节点（沙箱是工具执行路径，不是事实表）。记录 `docs/150` |
> | 请求 ID 贯通（Correlation IDs 的起点） | **已实现（7-A，2026-10-15）**：`POST /api/workflows/:id/start` 的 requestId 写进 `WORKFLOW_STARTED` payload；工作流执行器与部署编排器改为**沿用**该 ID（`createWorkflowRequestIdResolver`）；工具审计与日志带 `workflowRunId`。验证检查（`TaskVerifier`）的工具日志带 `workflowRunId`，但其 requestId 仍是每次新生成（见 `docs/149` Known Issues） |
> | Metrics 九项 | **已实现（7-B，2026-10-15）**：`GET /api/metrics` 以 Prometheus 文本格式只读导出九项（五项复用 `AgentEvaluationMetrics` 的口径，四项由 `PgMetricsRepository.aggregate()` 派生）。`GET /api/agents/metrics` 的**业务口径** JSON 不变（前端仍用它）。Prometheus 服务端 / 抓取仍属 7-D，已裁定延期。细节见 `docs/147` §3 与 `docs/149` |
> | Logs：结构化 JSON、禁记密钥 | **已实现**：`@ai-se/observability` 的 `createLogger` + `sanitizeLogData` + `redactString` / `redactCredentialShapedText` |
> | §Phase 2 第 1 条：Agent Run 状态 / iteration / retry / error / token·cost 落 PG | **已实现**：`packages/database/migrations/002_phase2_persistent_agent_runtime.sql` |
> | §Phase 2 第 2 条：Tool Call 记 agentRunId / iteration / toolCallId / toolName / input·output / status / error / duration | **已实现**，逐字段对得上（含 `duration`、`started_at` / `finished_at`） |
> | §Phase 2 第 3 条：Workflow Event 摘要 + SSE | **已实现** |
> | §Phase 2 第 4 条：Redis 存 cancellation flag、不作事实来源 | **已实现**：`RedisCancellationStore` |
>
> **结论**：整个 §Phase 2 已实现并超出；`incidentId` 是错误前提；**请求 ID 贯通与九项指标已于 2026-10-15 由 7-A / 7-B 落地，端到端追踪由 7-C 落地，自治决策事件契约由 7-E 落地**；外部栈（本文「技术栈」四项）**四项均未引入**，已裁定延期，其中 Prometheus 一项为「延期（部分替代）」。Phase 7 已于 2026-10-15 **收口**（`docs/153`）。
> **任务书**：`docs/147`（2026-10-15 已裁定：零依赖、`/api/metrics`、7-D 外部栈延期）。**Phase 7 已于 2026-10-15 收口**：M1（7-A / 7-B）与 M2（7-C / 7-E）全部交付，OB-01 … OB-10 全绿，六项验收逐项回填见 `docs/17`；实施记录 `docs/149`（M1）、`docs/150`（7-C）、`docs/151`（验证证据解耦）、`docs/152`（7-E），**收口记录 `docs/153`**。7-D 外部栈维持延期，不作为收口条件。任务书以**现有代码**为准，本文只作「意图来源」被引用。
> 依据：`AGENTS.md` §9「代码权威于文档；冲突必须报告，禁止默默改任一方来对齐」。

## 技术栈

- OpenTelemetry
- Prometheus
- Grafana
- Loki

## Correlation IDs

```text
requestId
projectId
workflowRunId
taskId
agentRunId
toolCallId
deploymentId
incidentId
```

Trace：

```text
Request
→ Workflow
→ Task
→ Agent
→ Tool
→ Sandbox
```

## Metrics

- Agent Run Count
- Agent Success Rate
- Task Success Rate
- Tool Success Rate
- Tool Duration
- Workflow Duration
- Token Usage
- Estimated Cost
- Deployment Success/Failure

## Logs

结构化 JSON 日志。禁止记录 API Key、Token、Password、Cookie、Secrets。

## Phase 2

- Agent Run 状态、iteration、retry、error、token/cost metadata 落 PostgreSQL。
- Tool Call 记录 agentRunId、iteration、toolCallId、toolName、input/output summary、status、error、duration。
- Workflow Event 记录安全事件摘要，并通过 SSE 输出给前端。
- Redis 保存 Agent Run cancellation flag，不作为事实来源。
