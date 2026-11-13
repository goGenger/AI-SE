# System Architecture

> ## 基线状态（2026-10-15 逐条核实）
>
> 本文写于**平台实现之前**（第一版路线图的总体架构设计），是**实现前设计**，不是 as-built 描述，
> **不构成开工依据**。原文一字未删（保留当初的设计意图），下面是对照现状的核实表：
>
> | 本文条款 | 与当前实现的关系 |
> | --- | --- |
> | 「Final Architecture Boundary」的分层（Vue Console → API Server → Application Services → Domain Workflow → Task Scheduler → Agent Registry → Agent Runtime → Professional Agent / Deep Agents → LangGraph → LangChain / LLM Provider → Tool Runtime → Governance → Native / MCP / Browser → Sandbox → External Systems） | **大部分层有真实模块**：Vue Console = `apps/web/src/`；API Server = `apps/server/src/app.ts` + `routes/`；Application Services = `apps/server/src/services/`；Domain Workflow = `packages/workflow-engine` + 规划在 `packages/agent-core/src/planning/`；Agent Registry = `agent-core/src/professional/AgentRegistry.ts`；Agent Runtime = `agent-core/src/agent/`；LangGraph / LangChain / LLM Provider / Tool Runtime / Sandbox 均如原文。**两处名不副实**：① **「Task Scheduler」不是独立层**（见下行）；② **「Governance」不是单一模块**——权限在 `packages/action-policy`、审批在 DB + `WorkflowEngine`、脱敏在 `packages/observability` |
> | 「Task Engine」/「Task Scheduler」作为独立层（两张图里都有） | **前提不成立，从未存在**。全仓**没有** `TaskEngine` / Task Scheduler 模块；调度是 `packages/workflow-engine/src/scheduler.ts` 里的**三个纯函数**（`readyTaskIds` / `blockedTaskIds` / `validateWorkflowGraph`），且**只被 `WorkflowEngine.ts` 引用**；re-plan 与 rollback 也在 `WorkflowEngine` 内。**引用本文时不要把「Task Engine」当成一个可寻址的层** |
> | 数据层 PostgreSQL「业务实体、Agent Run、Tool Call、Workflow Event、审批、部署等」 | **已实现且覆盖更广**。`packages/database/migrations/` 建了 `users` / `repositories` / `projects` / `audit_logs`（001）、`agent_runs` / `tool_calls` / `workflow_events`（002）、`requirements` / `specifications` / `tasks` / `task_dependencies`（003）、`workflow_runs` / `approvals`（004）、`agent_artifacts`（005）、`deployment_environments` / `ci_runs` / `deployments` / `deployment_logs`（006）、`mcp_servers` / `mcp_tools` / `mcp_tool_bindings`（008）、`evidence_records`（009）、`requirement_slices`（011）、`requirement_acceptance_criteria`（013）。原文列的六类**全部覆盖**，另多出 MCP、证据、切片等 |
> | 数据层 Redis：「**唯一职责 = 跨进程取消 + 健康检查**；与 PostgreSQL 无重叠；保留不删」 | **总体成立，一处细节已过时**。类名 `RedisCancellationStore` ✓、键 `agent-run:<id>:cancel` ✓、TTL 1h ✓（`apps/server/src/services/cancellationStore.ts`）。**「250ms 轮询」不是 Redis 的职责、且各调用点间隔并不一致**——工作流任务 250ms，Agent 运行与规划各 500ms。**「与 PG 无重叠、全仓仅此两用途」经全仓核对成立**（`createClient` / redis 只出现在 `index.ts` 的连接与 `ping()` 和 `cancellationStore.ts`） |
> | 数据层「Object Storage：大型 artifact / build output / report（**后续接入**）」 | **从未接入（原文自己就标了「后续接入」，如实）**：全仓没有 S3 / MinIO / GCS / Azure 客户端，也没有 `@aws-sdk` |
> | 外部系统六项（GitHub、GitHub Actions、Container Registry、Deployment Platform、Observability Stack、LLM Provider） | **三项真实、三项是本地替代或半成品**。GitHub / GitHub Actions ✓（`deliveryAdapters.ts` 真实 `fetch` 到 `api.github.com` 与 workflow dispatch）；LLM Provider ✓。Container Registry **只推导了 `ghcr.io/...` 名、没有 push / auth 客户端**；Deployment Platform **是本地 Docker**（`LocalDockerOperations`）；Observability Stack **是本地 Prometheus 文本端点**（`GET /api/metrics`）+ pino，没有外部栈。`docs/58` 已把 GitHub / GHCR / 生产 / VLM / Figma 记为 **BLOCKED BY EXTERNAL CONFIG** |
> | 「Workflow Engine 管业务生命周期；Agent Runtime / LangGraph 管单次运行」，以及「**禁止把整个 AI-SE 业务生命周期改造成一个巨大 LangGraph**」 | **已实现，禁令守住了**。`WorkflowEngine` 拥有 DAG / 依赖 / 调度 / 重试 / 重规划 / 审批 / 暂停恢复取消 / 事件 / 交付编排；Agent 侧是**两节点的小图**，规划另有一张独立图。**全仓不存在一个巨型图** |
> | MCP 边界 `Agent → Tool Runtime → MCP Adapter → MCP SDK → MCP Server`，以及三条禁止（Agent→MCP Client / Agent→MCP Server / Agent→External API） | **对 Agent 侧有真实守卫，但覆盖范围只到 `agent-core`**。`externalEngineering.e2e.test.ts` 扫 `packages/agent-core/src` 里是否出现 `@ai-se/mcp` / `@octokit` / `node:https` / `node:http` / `fetch(`，断言为空；`browserComputerUse.e2e.test.ts` 同法守 `playwright` / `@ai-se/browser`。**但 MCP client 确实在 Tool Runtime 之外被 import**——`apps/server/src/index.ts`（装配 Stdio / Remote client）与 `packages/database/src/mcpRegistryStore.ts`。扫描只守 agent-core，**不守 server / DB 装配** |
> | 「**所有 MCP Tool Call 都必须产生统一的 Tool Call / Audit 记录**」 | **不成立（本文最需要修正的一条）**。`ToolRuntime.execute` 的记录能力挂在一个**可选**的 `toolCallRecorder` 上；而唯一跑 MCP 工具的生产路径 `MCPAppService.runAction` 在 `apps/server/src/index.ts` 构造时**没有传 recorder**，且伪造 `randomUUID()` 的 `agentRunId`（`mcpAppService.ts`，代码自己在接口注释里承认「接进 `tool_calls` 需要一个真实 agent run id（NOT NULL FK）」）。`audit_logs` 表**全仓没有任何写入方**。**结论：控制台触发的 MCP 调用目前不产生 Tool Call / Audit 记录** |
> | 「Agent 不直接访问外部系统。所有外部操作必须经过 Tool Runtime；所有代码执行必须经过 Sandbox。」 | **对 Agent 成立**（与 `docs/03` 同一条核实）。一处caveat：交付侧 `deliveryAdapters.ts` 用裸 `child_process.spawn` 跑本地 docker / gh，**绕过了沙箱**——但它走的是 Tool Runtime / DeliveryOperations 而非 Agent 代码，所以原则对 Agent 仍成立 |
>
> **结论**：本文的**边界划分（Workflow vs Agent、Agent vs 外部系统）是最有价值的部分，且被完整遵守**——「禁止巨型 LangGraph」这条尤其重要，全仓确实没有。需要修正的是三处：① **「Task Engine」这一层从未存在**，调度是 workflow-engine 内的三个纯函数；② **「所有 MCP Tool Call 都有 Audit 记录」不成立**，控制台触发的 MCP App 调用不落 `tool_calls`，`audit_logs` 全仓无写入方；③ 外部系统里 Container Registry / Deployment Platform / Observability Stack 是**本地替代**，不是原文设想的真实外部系统。
>
> **⚠️ 本文是「混血」文档，不是纯粹的实现前设计**：主体写于实现之前，但**数据层那一段已被改成 as-built**——`docs/108` 第 124 行明确要求在 docs/02 与架构图中写明 Redis 的确切职责（「不删除」），那段现行文字就是照此回填的。所以：**数据层（PostgreSQL / Redis / Object Storage）三行的表述以本文为准**，它比 `docs/08` 里同主题的老话新——见 `docs/08` 基线状态表第 5 行记录的冲突。
> **任务书**：引用本文做新设计前，以 `apps/server/src/index.ts`（组合根）与各 `packages/*/src` 的实际模块为准；本文只作「意图来源」。
> 依据：`AGENTS.md` §9「代码权威于文档；冲突必须报告，禁止默默改任一方来对齐」。

## 总体架构

```text
Vue Console
    ↓
API Server
    ↓
Workflow Engine
    ↓
Task Engine
    ↓
Our Agent Runtime
    ↓
Professional Agent / Deep Agents
    ↓
LangGraph.js
    ↓
LangChain.js / LLM Provider
    ↓
Tool Runtime
    ↓
Policy
    ↓
Sandbox / External Services
```

## Agent Runtime 边界

Our Agent Runtime 负责：

- Agent 生命周期
- AgentContext / AgentState / AgentResult
- 业务级 Agent Run
- Tool Runtime 调度
- 权限与策略
- 业务事件
- token/cost metadata
- 错误分类

LangGraph 负责：

- StateGraph
- Node / Edge
- Conditional Routing
- Agent execution loop
- Streaming
- Checkpoint integration（在后续 Phase 使用）

LangChain 负责：

- Chat Model abstraction
- Tool abstraction
- Message abstraction
- Structured output / model integration

Deep Agents 负责 Phase 5 单个专业 Coding Agent 内的 planning、context management 和工具 harness。它不负责跨 Task 调度；所有 filesystem/tool 操作通过 AI-SE Tool Runtime backend 适配器进入 Policy 与 Sandbox。

## 数据层

- PostgreSQL：业务实体、Agent Run、Tool Call、Workflow Event、审批、部署等持久化数据。
- Redis：**唯一职责 = 跨进程取消（`RedisCancellationStore`：`agent-run:<id>:cancel`，1h TTL，250ms 轮询）+ 健康检查**；与 PostgreSQL 无重叠；保留不删（评测在 PG + Redis 组合下通过）。
- Object Storage：大型 artifact / build output / report（后续接入）。

## 外部系统

GitHub、GitHub Actions、Container Registry、Deployment Platform、Observability Stack、LLM Provider。

## 核心原则

Agent 不直接访问外部系统。所有外部操作必须经过 Tool Runtime；所有代码执行必须经过 Sandbox。


## Final Architecture Boundary

### Complete Runtime

```text
Vue Console
    ↓
API Server
    ↓
Application Services
    ↓
AI-SE Domain Workflow
    ↓
Task Scheduler / Dependency / Re-plan
    ↓
Agent Registry / Resolver
    ↓
Agent Runtime
    ↓
Professional Agent / Deep Agents
    ↓
LangGraph.js
    ↓
LangChain.js / LLM Provider
    ↓
Tool Runtime
    ↓
Governance: Permission / Policy / Approval / Audit / Redaction
    ↓
┌──────────────┬──────────────┬──────────────┐
│ Native Tools │ MCP Adapter  │ Browser      │
└──────────────┴──────────────┴──────────────┘
                    ↓
                 Sandbox
                    ↓
             External Systems
```

### Workflow 与 Agent 的最终边界

**AI-SE Workflow Engine** 管理：

- Requirement → Specification → Task DAG
- Task dependency
- scheduling / parallelism
- retry / failure recovery
- dynamic task creation
- re-plan
- approval / pause / resume / cancel
- workflow-level events
- delivery orchestration

**Agent Runtime / LangGraph** 管理：

- 单次 Agent Run
- Agent State
- model invocation
- tool loop
- conditional routing
- checkpoint
- Agent 内部 planning/context

因此禁止把整个 AI-SE 业务生命周期改造成一个巨大 LangGraph。

### MCP 边界

```text
Agent → Tool Runtime → MCP Adapter → MCP SDK → MCP Server
```

禁止：

```text
Agent → MCP Client
Agent → MCP Server
Agent → External API
```

所有 MCP Tool Call 都必须产生统一的 Tool Call / Audit 记录。
