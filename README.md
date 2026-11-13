# AI-SE：AI Software Engineer

> 一个面向 AI 软件工程的智能体平台。
>
> 目标是让 AI 能够从 PRD / 需求出发，完成需求分析、技术设计、任务拆解、代码开发、测试、代码审查、CI/CD、部署、监控，并最终扩展到 AI SRE，实现从需求到生产运维的完整软件工程闭环。

---

## 一、项目目标

AI-SE（AI Software Engineer）不是一个简单的 AI Coding Agent，而是一个完整的 AI 软件工程平台。

最终目标：

```text
PRD / Requirement
        ↓
Requirement Analysis
        ↓
Technical Design
        ↓
Task Planning
        ↓
Development
        ↓
Testing
        ↓
Code Review
        ↓
CI/CD
        ↓
Deployment
        ↓
Observability
        ↓
Operations
        ↓
AI SRE
        ↓
Incident Diagnosis
        ↓
Automatic Fix
        ↓
Verification
```

> **现状说明**：上图是目标流程，不是现状。Phase 0–5 与本地交付链（Phase 6）已完成；Observability（Phase 7）**已于 2026-10-15 收口**——M1（关联 ID 贯通 + `GET /api/metrics`）与 M2（`GET /api/workflows/:id/trace` 端到端追踪 + 自治决策事件契约）交付，六项验收为**完成 2 项 / 延期 4 项**（外部栈 OTel / Prometheus 服务端 / Grafana / Loki 不引入依赖）；**自治 L1**（staging 与低风险自动、生产仍人工）的 M1–M3 已实施（`docs/155`），真实批次门槛未跑；AI SRE（Phase 8）未开工。逐项状态见 `docs/146`，收口记录 `docs/153`。

## 当前阶段

- Phase 0：Engineering Foundation 已完成。
- Phase 1：Coding Agent Runtime 基础版已完成。
- Phase 2：Persistent Agent Runtime 已完成。
- Phase 3：Requirement Understanding & Task Planning 已完成。
- Phase 4：Dynamic Workflow Engine 已完成。
- Phase 5：Professional Multi-Agent 已完成。
- Phase 6：CI/CD & Delivery 已实现本地交付链；真实 GitHub Actions、GHCR 和远程生产验收需要配置外部仓库与凭据。

## 接线状态（已实现但未接入生产主链路）

下表列出**代码已存在、但生产主链路走不到**的能力。它们**不计入任何验收与评测读数**，也不是待办清单——每一项都评估过并有意保持现状。

| 能力 | 实际状态 | 为什么不接 |
| --- | --- | --- |
| `audit_logs` 表 | 建表，**全仓无写入方** | 工具调用已记在 `tool_calls`（含输入、结果、审计字段）；本项目不主张合规审计能力 |
| 视觉修复闭环 | `runVisualFixLoop`（`apps/server/src/services/visualFixLoop.ts:182`）**无生产调用者** | 卡在**参照侧**：闭环要比对「候选截图 vs 参照截图」，而产品没有上传设计参照的入口。浏览器取证那一半已接入（见下） |
| 并行调度 | `maxConcurrency` 在创建期被 `enforceSerialWorkflowPolicy` 钳为 1（`packages/shared/src/index.ts:1035-1045`）；调度器本身支持并行 | 单实例、无租约，解钳会引入新的并发缺陷；当前缺的是稳定性不是吞吐 |
| 用户体系 / 鉴权 | `users` 表零引用；鉴权只有一个可选静态 Bearer Token | 没有用户模型，也没有多租户 |

> **2026-10-23**：本表按 `docs/231` 逐项清点（执行记录 `docs/232`）。`failure-recovery` 包已按清点结论**移除**（T1）；
> **MCP 工具联邦已接入**（T2）：控制台可添加服务器、可启停工具，绑定即授权，
> 工具以 `mcp__<server>__<tool>` 进入任务工具集（每任务快照、上限 20）。两行都从本表移除。

> 因此这个仓库**不是**「企业级平台」。它的定位是**一个带自有评测实验室的、PRD 级自动化交付平台原型**——亮点在验证门、防篡改与可度量的假阳性率，不在企业周边。

## 本地环境

- Node.js：22.22.2（见 `.nvmrc` / `.node-version`）
- pnpm：12.3.4
- Docker / Docker Compose
- PostgreSQL：Docker Compose
- Redis：Docker Compose

```bash
nvm use
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose up --build   # 全栈容器模式（查看页面和数据）
pnpm dev                    # 开发模式：Docker Postgres/Redis + 迁移 + Server(:3000) + Web(:5173) 一条命令
```

使用步骤见：[AI-SE 使用手册](docs/19-user-manual.md)。

## Phase 1 模块

```text
packages/agent-core      Agent / AgentRunner / AgentState / LangGraph loop / LLMProvider
                         Professional Agent Registry / Resolver / Deep Agents adapter
packages/workflow-engine Workflow lifecycle / scheduler / retry / re-plan / approval
packages/tool-runtime    Tool schema validation / execution / audit / error normalization
packages/sandbox         Docker Sandbox command execution and resource limits
packages/database        PostgreSQL migrations / Project store / Agent Run stores
examples/coding-agent-test-project
```

Agent 执行链：

```text
Agent Runtime
  -> LangGraph StateGraph
  -> LangChain message/tool abstraction
  -> Tool Runtime
  -> Docker Sandbox
```

## API

- `GET /health`
- `GET /ready`
- `POST /api/projects`
- `GET /api/projects`
- `GET /api/projects/:id`
- `DELETE /api/projects/:id`
- `POST /api/agent-runs`
- `GET /api/agent-runs`
- `GET /api/agent-runs/:id`
- `POST /api/agent-runs/:id/cancel`
- `GET /api/agent-runs/:id/events`
- `GET /api/agent-runs/:id/stream`
- `POST /api/agent-runs/coding-demo`
- `POST /api/projects/:projectId/requirements`
- `GET /api/projects/:projectId/requirements`
- `GET /api/requirements/:id`
- `POST /api/requirements/:id/analyze`
- `GET /api/requirements/:id/specifications`
- `GET /api/requirements/:id/tasks`
- `GET /api/tasks/:id`
- `GET /api/tasks/:id/dependencies`
- `POST /api/workflows`
- `GET /api/workflows`
- `GET /api/workflows/:id`
- `POST /api/workflows/:id/start`
- `POST /api/workflows/:id/pause`
- `POST /api/workflows/:id/resume`
- `POST /api/workflows/:id/cancel`
- `POST /api/workflows/:id/retry`
- `GET /api/workflows/:id/tasks`
- `GET /api/workflows/:id/events`
- `GET /api/workflows/:id/graph`
- `GET /api/workflows/:id/approvals`
- `GET /api/workflows/:id/trace`
- `GET /api/workflows/:id/stream`
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/reject`
- `GET /api/agents`
- `GET /api/agents/metrics`
- `GET /api/agents/:name`
- `GET /api/metrics`
- `GET /api/deployments`
- `GET /api/deployments/:id`
- `POST /api/deployments/:id/rollback`
- `GET /api/environments`
- `PUT /api/environments`

`/api/agent-runs` 会复制 `examples/coding-agent-test-project` 到临时目录，并通过 Coding Agent、Tool Runtime 和 Docker Sandbox 修复示例 bug。Agent Run、Tool Call、Workflow Event 会持久化到 PostgreSQL。`/api/agent-runs/coding-demo` 保留为 Phase 1 兼容入口。

## Frontend

- Dashboard：`/`
- Projects：`/projects`
- Project Detail：`/projects/:id`
- Requirements：`/requirements`
- Agent Runs：`/agent-run`
- Workflows：`/workflows`、`/workflows/:id`
- Agents：`/agents`
- Deployments：`/deployments`、`/deployments/:id`

## Phase 6 交付

- GitHub Actions：Node 22 + pnpm frozen install + lint/typecheck/test/build + Docker build + GHCR push。
- Deployment Orchestrator：CI、Docker deployment、health/readiness、history、logs、rollback。
- Environment：项目级 dev/staging/production，配置与 Secret Reference 分离。
- Workflow：delivery Task 继续由 Workflow Engine 调度；Production DEPLOY 自动进入现有 Approval。
- Traceability：WorkflowRun → Task → AgentRun → Git Commit / PR → CI Run → Image → Deployment。
- 本地真实 E2E：健康版本部署成功；坏版本 health check 失败后创建 Workflow rollback task，并恢复上一镜像。
- Server 在 Docker Compose 内仍不挂载 Docker socket；本地 Docker deployment 需在宿主机运行 Server，或使用受控远程 adapter。

## Phase 2 持久化

- PostgreSQL：`agent_runs`、`tool_calls`、`workflow_events`。
- Redis：Agent Run cancellation flag。
- LangGraph：`MemorySaver` checkpointer + `thread_id = agentRunId` 的运行边界。
- Server restart recovery boundary：启动时将上次进程中断的 in-progress Agent Run 落为 failed，并写入 recovery event。

## Phase 3 需求规划

- PostgreSQL：`requirements`、`specifications`、`tasks`、`task_dependencies`。
- Planning Agent：基于 LangGraph 顺序图执行 Requirement Analysis、Spec 生成、Task Planning、DAG Validation。
- Structured Output：每个 Planning 阶段使用 Zod schema 校验；默认测试使用 `ScriptedPlanningModel`，真实模型适配器使用 LangChain `withStructuredOutput`。
- LLM Provider：默认 `LLM_PROVIDER=mock`；设置 `LLM_PROVIDER=openai` 且提供模型凭据后使用 LangChain structured output。
- Domain Validation：Specification 检查重复 ID / endpoint / table；Task DAG 检查唯一 Task ID、缺失依赖、自依赖、循环、重复依赖、Root/Leaf。
- Persistence：Specification + Task DAG 在一个 PostgreSQL transaction 中写入；Task `input` 保存 requirement/specification traceability metadata。
- Frontend：Requirements 页面支持创建 Requirement、启动 Analyze、查看 Planning Events、Specification 和 Task DAG。

## Phase 4 动态工作流

- PostgreSQL：`workflow_runs`、`approvals`，并扩展 runtime tasks、dependencies 和 workflow events。
- Scheduler：根据依赖计算 READY Task，使用 PostgreSQL transaction、workflow row lock 和 `SKIP LOCKED` 防止重复 Claim。
- Execution：每个 Runtime Task 通过单一 Agent Resolver 进入现有 AgentRunner/LangGraph，并写入独立 AgentRun。
- Policy：支持 `FAIL_FAST`、`RETRY`、`CONTINUE`、`REPLAN`、maxConcurrency 和 maxRetries。
- Dynamic Re-plan：失败后创建 Debug 与 Retry Dynamic Task，运行时重连下游依赖，原始 Phase 3 Task Plan 不变。
- Human Approval：支持 WAITING_APPROVAL、approve 和 reject。
- Recovery：PostgreSQL 是 Source of Truth；服务重启后在 Task 边界恢复 RUNNING Workflow。
- Frontend：Workflow List、Detail、Graph、Event Timeline、Approval 和 SSE。

## Phase 5 专业多 Agent

- Registry：Planner、Frontend、Backend、Database、QA、Reviewer、DevOps 使用统一 Definition / Registry / Resolver。
- Deep Agents：作为专业 Agent harness；系统级调度继续由 Workflow Engine 负责。
- Security：Deep Agents filesystem backend 全部转发到现有 Tool Runtime，再进入 Docker Sandbox；禁用自由 sub-agent、delete、glob 和任意 execute。
- Context：按 Agent 类型过滤 Specification，并限制 dependency result、previous attempt、test/review artifact 数量。
- Persistence：复用 AgentRun、ToolCall、WorkflowEvent，新增 `agent_artifacts`。
- Failure：QA/Review failure 可指定 `fixTaskType`，Workflow 创建对应专业 Fix Task 后再测试或 Review；re-plan 受 `maxRetries` 限制。
- Frontend：Agents Registry、Agent Detail、实际 Evaluation 指标，以及 Workflow Task 到 AgentRun 的追踪。
