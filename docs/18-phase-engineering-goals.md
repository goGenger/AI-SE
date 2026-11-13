# Phase 0–8 工程目标与执行规范

本文是给 Vibe Coding / AI Coding Agent 执行的阶段性工程规格。每个阶段只实现当前阶段能力，完成验收后才能进入下一阶段。

> **V1 定义：Phase 0～Phase 6 完成后，AI-SE 即达到第一个完整可用版本。**
>
> Phase 7～Phase 8 属于 V1 后续增强，不作为个人正常使用 V1 的前置条件。

---

# Phase 0：Engineering Foundation

## 目标

建立稳定、可测试、可部署的 Monorepo 工程基础，但不实现 Agent。

## 技术

Vue 3 + TypeScript + Vite + Pinia + Router；Node.js + TypeScript；PostgreSQL；Redis；pnpm workspace；Docker Compose；ESLint/Prettier；Vitest/Jest；结构化日志。

## 目录

```text
apps/web
apps/server
packages/shared
packages/database
packages/observability
infrastructure/docker
```

## 基础表

projects、repositories、users、audit_logs。

## 验收

Docker Compose、Web→Server、PostgreSQL/Redis、Project CRUD、migration、lint/typecheck/test、README 启动说明全部可用。

## 禁止

Agent、LLM、RAG、Tool Calling、Dynamic Workflow、Multi-Agent、CI/CD、Kubernetes、AI SRE。

---

# Phase 1：Coding Agent Runtime

## 目标

让 AI 在受控 Docker Sandbox 中独立完成一个真实 Bug 修复，同时建立正确的 Agent Runtime 分层。

## 固定技术栈

- Node.js + TypeScript
- **LangGraph.js**：Agent graph / state / routing / execution
- **LangChain.js**：LLM / Message / Tool abstraction
- **Zod**：Tool input schema / structured validation
- Docker：Sandbox
- Vitest：测试

**Phase 1 不使用 Deep Agents。**

## 架构

```text
Our Agent Runtime
      ↓
LangGraph.js
      ↓
LangChain.js
      ↓
LLM Provider
```

Tool：

```text
LangGraph
 ↓
LangChain Tool
 ↓
Tool Runtime
 ↓
Policy
 ↓
Docker Sandbox
```

## 核心模块

packages/agent-core、packages/tool-runtime、packages/sandbox。

## Agent 抽象

Agent、AgentContext、AgentState、AgentResult、AgentRunner、LLMProvider。

## Agent Graph

```text
START → agent → tools → agent → END
                  └──────→ END
```

LLM 返回 Tool Call 时进入 Tool Runtime；最终回答时结束。

## Tools

read_file、write_file、edit_file、list_directory、search_code、git_status、git_diff、run_command、run_unit_test、run_lint、run_build。

## Sandbox

CPU、memory、process、timeout、filesystem mount、network policy。默认无网络；禁止 Docker Socket、任意宿主机目录、生产凭据。

## E2E

准备 `examples/coding-agent-test-project`，人为制造 Bug。Agent 必须：定位 → 读取 → 修改 → diff → 测试 → 根据失败继续修改 → 测试通过 → 返回结构化结果。

## 错误分类

LLM_ERROR、TOOL_ERROR、SANDBOX_ERROR、COMMAND_ERROR、TEST_ERROR、TIMEOUT_ERROR、CANCELLED_ERROR、UNKNOWN_ERROR。

## 必须支持

maxIterations、timeout、cancellation、basic retry、error normalization、structured result、structured JSON logs。

## 禁止

Planner、Requirement Agent、Task DAG、Dynamic Workflow、Multi-Agent、CI/CD、Kubernetes、AI SRE、Browser Agent、Computer Use、RAG。

---

# Phase 2：Persistent Agent Runtime

## 目标

将 Phase 1 的一次性 Coding Agent 升级为可持久化、可恢复、可重试、可取消的 Runtime。

## 技术重点

使用 LangGraph 的 checkpoint/persistence 能力，并由 PostgreSQL 保存平台级 Agent Run/Tool Call/Workflow Event；Redis 用于 queue/lock/cache/event buffering。

## 数据

agent_runs、tool_calls、workflow_events。

## Agent Run

id、taskId、status、input、output、currentIteration、retryCount、startedAt、finishedAt、error、tokenUsage、estimatedCost。

## 能力

transient error 分类、retry policy、timeout、cancellation、server restart recovery、SSE、审计。

## 验收

服务重启后可以恢复 Agent Run；Tool Call 可审计；取消真正停止执行；retry 不无限循环；SSE 可展示安全事件。

## 当前实现边界

Server 启动时扫描 created/running/cancelling 的 Agent Run，统一落为 failed，并写入 agent_run_recovered 事件，保证状态可查询、可审计、不会悬挂。完整断点续跑依赖后续 Workflow/Task 持久化，不在 Phase 2 扩展为 Task DAG。

---

# Phase 3：PRD → Task Graph

## 目标

PRD → Requirement → Specification → Task → Dependency DAG。

## Pipeline

```text
PRD
→ Requirement Analysis
→ Functional Requirement
→ Technical Requirement
→ Architecture
→ API Spec
→ DB Spec
→ UI Spec
→ Task Graph
```

## 技术

Structured Output + Zod + LangGraph 编排。

## Agents

Requirement Agent、Planner Agent。

## Specification

必须结构化：functionalRequirements、apiRequirements、databaseRequirements、uiRequirements、constraints、acceptanceCriteria。

## 验收

真实小型 PRD 能生成合法、无循环依赖的 Task DAG，并包含可验证的 Acceptance Criteria。

## 当前实现边界

Phase 3 只生成并持久化 Requirement、Specification、Task DAG；Task 状态保持 PENDING，不调度、不执行、不 re-plan。Planning 进度复用 Phase 2 AgentRun / WorkflowEvent / SSE。

## 禁止

Dynamic Workflow、Multi-Agent 自由协作、CI/CD、AI SRE。

---

# Phase 4：Dynamic Workflow

## 目标

从静态计划升级为：

```text
Plan → Execute → Observe → Decide → Re-plan → Execute
```

## Workflow 状态

CREATED、PLANNING、RUNNING、WAITING_APPROVAL、PAUSED、COMPLETED、FAILED、CANCELLED。

## 能力

create/modify/cancel Task、调整 dependency、选择 Agent/Tool、retry、pause/resume、approval、re-plan。

> Rollback 保留到后续 Delivery 阶段，因为 V1 的真实可回滚外部副作用从 Phase 6 才开始出现。

## 失败恢复

Backend Test Failed → Diagnose → Debug Task → Fix → Test Again，而不是直接 Workflow Failed。

## 高风险

git push、production deploy、DB migration、environment modification、destructive operation 默认进入 WAITING_APPROVAL。

## 验收

构造会失败的原计划，系统能够创建 Debug Task、修改执行计划并最终完成。

## 当前实现

Workflow 创建时复制 Phase 3 静态 Task Plan；Scheduler 使用 PostgreSQL 原子 Claim 并调用现有 AgentRunner。支持 retry、re-plan、dynamic task、approval、pause/resume/cancel、deadlock detection、SSE 和 Task 边界恢复。LangGraph checkpointer 仍为进程内 MemorySaver，因此服务重启恢复到持久化 Task 边界，不承诺 Agent Graph 节点级恢复。

---

# Phase 5：Professional Multi-Agent Coding

## 目标

把单一 Coding Agent 升级为专业角色协作。

## 技术

**Deep Agents + LangGraph + LangChain**。

Deep Agents 用于高级 Coding Agent Harness，例如 planning、filesystem/context management、sub-agent 等高级能力；平台的 Workflow/Task/Policy/Sandbox 仍由本项目控制。

## Agents

Planner、Frontend、Backend、Database、QA、Reviewer、DevOps。

## 协作

所有 Agent 通过 Workflow Engine、Task Engine、Agent Runtime 协作，禁止 Agent 私下绕过平台直接调用另一个 Agent 或生产系统。

## 验收

PRD → Planner → DB → Backend → Frontend → QA → Reviewer → Debug → Retest，最终测试与 Review 通过。

## 生产边界

生产部署仍不自动执行，生产交付属于 Phase 6。

## 当前实现

七个专业 Agent 通过统一 Registry/Resolver 接入 Phase 4 Workflow Engine；Deep Agents backend 全部转发到 Tool Runtime + Docker Sandbox。TaskContext 按角色隔离 Specification、dependency result、attempt 和 artifact。新增 `agent_artifacts`、Agents API/Console、真实 Evaluation 聚合，并完成 QA failure → Backend Fix Task → Retest → Review 的真实 Docker E2E。未实现 Phase 6 CI/CD 或部署。

---

# Phase 6：CI/CD & Delivery — V1

## 目标

打通 AI 开发到真实软件交付的完整闭环。

**Phase 6 完成后，AI-SE V1 视为完成。**

V1 的定位不是企业级 DevOps 平台，而是一个个人可以真实使用的 AI Software Engineer：能够从 PRD 出发完成规划、动态执行、多 Agent 开发、测试、Review，并通过 CI/CD 完成 Staging 到 Production 的受控交付。

## V1 核心闭环

```text
PRD
 ↓
Requirement / Specification
 ↓
Task DAG
 ↓
Dynamic Workflow
 ↓
Multi-Agent Development
 ↓
Testing
 ↓
Code Review
 ↓
Git
 ↓
CI
 ↓
Docker Image
 ↓
Registry
 ↓
Staging
 ↓
E2E
 ↓
Human Approval
 ↓
Production
 ↓
Health Check
 ↓
Release / Rollback
```

## CI

使用 GitHub Actions：

Install → Lint → Typecheck → Unit Test → Build → Docker Build → Push Registry。

## CD

环境：

```text
dev
staging
production
```

第一版不使用 Kubernetes。

优先使用：

```text
Docker
+
Cloud Server / Container Service
+
GitHub Actions
```

## Deployment Orchestrator

建立平台自己的 Deployment Orchestrator。

职责：

- 创建 Deployment
- 选择 environment
- 关联 version / image
- 触发部署
- 等待 health check
- 判断成功 / 失败
- 触发 rollback
- 记录 deployment history
- 向 Workflow Engine 返回 Deployment Result

架构：

```text
Workflow Engine
      ↓
Deployment Task
      ↓
Deployment Orchestrator
      ↓
CI/CD
      ↓
Environment
```

Deployment Orchestrator 不直接替代 GitHub Actions，而是作为 AI-SE 与 CI/CD / 部署环境之间的业务编排层。

## Environment Management

至少支持：

- dev
- staging
- production

必须能够区分：

- environment
- image version
- configuration
- secret reference

禁止把真实 Secret 写入：

- Agent Prompt
- Agent State
- Git Repository
- Application Log

## Deployment

Deployment 至少记录：

- id
- projectId
- version
- environment
- image
- status
- startedAt
- finishedAt
- healthCheck
- rollbackVersion

支持：

- Deployment Status
- Deployment History
- Deployment Logs
- Version
- Rollback

## Release Version Traceability

必须能够回答：

> 生产环境当前运行的版本，是由哪一次 AI Workflow 产生的？

建立：

```text
PRD
 ↓
WorkflowRun
 ↓
Task
 ↓
AgentRun
 ↓
Git Commit / PR
 ↓
CI Run
 ↓
Docker Image
 ↓
Deployment
 ↓
Environment
```

保证一次发布可以追溯到对应的软件工程执行过程。

## Staging

AI 完成开发后：

```text
Build
 ↓
Deploy Staging
 ↓
E2E
 ↓
Verify
```

失败后：

```text
Failure
 ↓
Workflow
 ↓
Fix Task / Re-plan
 ↓
重新验证
```

## Production

Production 必须：

```text
AI 提议发布
 ↓
Human Approval
 ↓
Deploy
```

第一版禁止 AI 无审批直接生产发布。

## Health Check

应用必须提供：

```text
GET /health
GET /ready
```

部署完成后必须进行健康检查。

## Rollback

Rollback 第一次正式出现在 Phase 6，因为此阶段开始产生真实的可回滚外部副作用。

当：

```text
Health Check Failed
```

或部署验证失败时：

```text
Deployment Failed
 ↓
Rollback
 ↓
Previous Version
 ↓
Health Check
```

必须记录：

- 当前版本
- 回滚版本
- 回滚原因
- 回滚时间
- 回滚结果

## Deployment Failure Recovery

部署失败不能只：

```text
Deployment = FAILED
```

必须由 Workflow Engine 根据结果决定：

- Retry
- Rollback
- Fix Task
- Re-plan
- Fail

并保证不会重复部署同一个不可恢复版本。

## Full Lifecycle E2E

Phase 6 最重要的验收项不是单独验证 CI 或 Deployment，而是完整跑通一次：

```text
PRD
 ↓
Requirement
 ↓
Specification
 ↓
Task DAG
 ↓
Dynamic Workflow
 ↓
Frontend / Backend / DB Agent
 ↓
QA
 ↓
Reviewer
 ↓
Fix / Retest（如有需要）
 ↓
Git Commit / PR
 ↓
GitHub Actions
 ↓
CI
 ↓
Docker Build
 ↓
Registry
 ↓
Staging
 ↓
E2E
 ↓
Human Approval
 ↓
Production
 ↓
Health Check
```

只有完整链路真实运行成功，Phase 6 才算完成。

## 验收

必须真实验证：

1. GitHub Actions CI 可运行
2. Lint / Typecheck / Test / Build 全部通过
3. Docker Image 可以构建
4. Image 可以推送 Registry
5. 可以部署 Staging
6. Staging E2E 可以执行
7. Workflow 可以等待部署结果
8. Production 发布需要人工 Approval
9. Production Health Check 可验证
10. Deployment History 可查询
11. Release Version 可以追溯到 Workflow / Commit
12. Deployment Failure 可以 Recovery
13. Rollback 可以真实执行
14. Full Lifecycle E2E 可以完整跑通

## 禁止

Phase 6 不实现：

- Kubernetes
- AI SRE
- 自动生产自愈
- 未经审批的生产修改
- 企业级多租户平台
- Service Mesh
- Kafka 等非必要基础设施

## 当前实现边界

Phase 6 已实现 delivery Task metadata、GitHub Actions workflow、CI/Deployment persistence、Tool Runtime delivery tools、Deployment Orchestrator、环境管理、Production Approval、Health Check、Workflow-controlled Rollback、REST API 和 Vue Deployment Console。真实本地 Docker deployment/rollback E2E 已通过。当前目录不是 Git repository，且没有 GitHub、GHCR 和远程 production 配置，因此外部 Full Lifecycle E2E 保持未验收，不视为凭空通过。

---

# Phase 7：Observability

## 目标

建立 Request → Workflow → Task → Agent → Tool → Sandbox → Deployment 的完整可观测性。

## 技术

OpenTelemetry、Prometheus、Grafana、Loki。

## 指标

Agent Run Count、Success Rate、Tool Success Rate、Tool Duration、Workflow Duration、Token Usage、Estimated Cost、Deployment Success/Failure。

## 验收

一次真实 Agent Run 可以从前端/服务入口追踪到具体 Tool 和 Sandbox 执行，并能在 Dashboard 查看关键指标。

> Phase 7 属于 V1 后续增强，不是 V1 可用性的前置条件。

## 当前实现进度（2026-10-15，Phase 7 已收口）

**Phase 7 已于 2026-10-15 收口**（收口记录 `docs/153`）。

**已完成 2 项**：① 关联 ID 贯通（请求 ID 经 `WORKFLOW_STARTED` 落到工作流执行与部署链，工具日志带 `workflowRunId`）+ 指标端点 `GET /api/metrics`（Prometheus 文本格式导出上列九项，与直接 SQL 聚合逐值一致）——`docs/149`；② 端到端追踪 `GET /api/workflows/:id/trace`（由既有事实表派生 `Workflow → Task → AgentRun → ToolCall` 的树，部署挂在其任务下）——`docs/150`。

**另交付**：7-E 自治决策事件契约（四个事件以 zod 定义在 `packages/shared`，写进既有 `workflow_events`，本阶段无写入方）——`docs/152`；验证证据不进 Agent 输入——`docs/151`。

**延期 4 项**：外部栈 OpenTelemetry / Prometheus 服务端 / Grafana / Loki（7-D，**已裁定延期，不引入依赖**）；其中 Prometheus 为「延期（部分替代）」——7-B 的零依赖文本端点即 Prometheus 格式，平台侧抓取契约成立，服务端与抓取未部署。

**本节的验收口径为部分覆盖**（不声称全部达成）：「从前端/服务入口追踪到具体 Tool 和 Sandbox 执行」中，**服务入口**已达成（7-C 的追踪树覆盖 Workflow → Task → AgentRun → ToolCall，部署挂在其任务下；Sandbox 不单独成节点，它是工具执行路径而非事实表）；**前端那一半已于 2026-10-15 达成**（追踪前端阶段，记录 `docs/157`：工作流详情抽屉内呈现同一棵追踪树，可展开到具体工具调用，验收项 TF-01 … TF-07 全部达成）——**Sandbox 那一半维持「不单独成节点」的既有声明，不改口径**。「Dashboard 查看关键指标」沿用既有 `GET /api/agents/metrics` 的业务口径（前端已用），Prometheus 面板属延期的 7-D。

任务书 `docs/147`；逐项处置见 `docs/17` 节「Phase 7 — Observability」与 `docs/153`。

---

# 自治 L1：策略内自治

> 不属于 Phase 0–8 的编号阶段，是 `docs/17` 节「自治 L1 · 策略内自治」定义的增强目标；任务书 `docs/154`，实施记录 `docs/155`。

## 目标

在**策略内**让工程链路自治：staging 与低风险动作自动，**生产与高风险仍必须人工**。

## 当前实现进度（2026-10-15）

**M1 – M3 已实施并通过**：L1-1 / L1-2 / L1-3（回归门——staging 自动执行且无审批记录、生产 DEPLOY 批准前无部署记录、HIGH / CRITICAL 动作的策略门不可被工作流策略关闭）；L1-4（L1 工作流下质量门强制 `enforce`，与全局 `VERIFICATION_GATE` 解耦）；L1-5（重试上限 2，耗尽即 FAILED；staging DEPLOY 失败自动生成并执行回滚任务）；L1-6（`AUTO_APPROVED` / `AUTO_RETRIED` / `AUTO_ROLLED_BACK` / `VERIFICATION_ENFORCED_FAILURE` 写入既有 `workflow_events`）；L1-7（自治级别是**可选**的工作流级策略字段，缺省＝行为与既有版本逐项一致）；L1-9（不变量红线）。

**M4（L1-8 数据门槛）已执行**：staging 段评估指标已建立并随每批记录；E1×3 真实批次自 2026-10-16 起已跑 **33 次 run**（十四批），**staging 段交付率 1/33**（判据 ≥ 2/3），**L1-8 至今未达成**。**因此 L1 整体尚未判「达成」，当前只判「M1 – M3 达成」。** 〔**2026-10-21 更新（原句「M4 未开工，需确认周配额」已过期）**〕**最新一批 L1-M4n（`docs/201`）**：staging 段 **0/3**，但**产出 L1-M4x 系列的第一次 oracle 通过**（run 3，`oraclePassed: true` / `falseNegative: true`——此前十三个目录 31 次 run 全 0）⇒ **瓶颈已从「链造不出合格产品」收窄到「交付编排跑不通」**；六项修复**全部确认真实批次生效**，另**新登记 N-22 / N-23**（任务书 `docs/199` / `docs/200`，**PL-M25 两件同批修**）。**下一步边界**：PL-M25 未开工，**实施前不得再开批次**。

---

# Phase 8：AI SRE

> **2026-11-04 收口**：8-A→8-D 已落地并生效（`docs/243`…`docs/246`；迁移 `020`–`022`）。任务书 **`docs/242`**。设计原文 `docs/13`。
> **不是** Agents UI 的 Phase 8-A/B（`docs/78`/`docs/79`）。
> 8-D：`INCIDENT_AUTO_REMEDIATE` **代码默认关**；本机进程环境可为 `true`（**.env 未写**）。

## 目标

建立受控的自动故障诊断与修复闭环（平台运维/可靠性），复用既有 Tool Runtime / Policy / Approval / Audit / 交付链，**不新建第二套执行体系**。

## 流程

```text
Alert → Incident → Diagnosis → Fix Plan → Branch → Fix → Test → Review → Staging → Approval → Production → Verify
```

## 第一版限制

仅允许白名单故障类型；禁止 arbitrary production shell、删除数据库、Secrets 修改、审批绕过、未经验证的生产修改。

## 验收

构造一个受控故障，Incident Agent 能读取 Metrics/Logs/Traces/Git/Deployment History，给出证据化诊断和修复计划，并完成受控修复闭环。分里程碑验收码见 `docs/242`（8-A…8-D）。

> Phase 8 属于 V1 后续增强，不是 V1 可用性的前置条件。

## Phase 5.5 Final Engineering Contract

Phase 5.5 的唯一目标是把 MCP 纳入已有 Tool Runtime，而不是重新设计 Agent Runtime 或 Workflow Engine。

### Progress

- 5.5-0 Contract Freeze：✅ 完成（冻结契约见 docs/25，报告见 docs/26）。
- 5.5-1 Local MCP：✅ 完成（见 docs/27）。`packages/mcp` 使用官方
  `@modelcontextprotocol/sdk` 1.30.0 实现了真实 stdio 连接：connect/initialize、
  tools/list、tools/call、disconnect、AbortSignal 取消与 SDK 错误归一化；并配套
  官方 SDK 版 fake server（echo/slow/failing）做真实协议 E2E。未接入 Tool Runtime / Agent。
- 5.5-2 Tool Runtime Federation：✅ 完成（见 docs/27）。`MCPToolRegistry`
  - `MCPToolAdapter` + JSON Schema→Zod 转换，把 MCP Tool 映射为现有
    `ToolDefinition` 并进入现有 `ToolRuntime.execute`（复用校验/审计/超时/取消/错误归一化）；
    可见性链（server enabled → project/agent binding → tool → policy，默认 DENY）
    与批准门在 Adapter 前拦截，DENY 时 MCP Server 零请求。真实 stdio E2E 验证。
- 5.5-3 Registry & Persistence：✅ 完成（见 docs/29）。迁移 008
  （mcp_servers/mcp_tools/mcp_tool_bindings，checksum runner + 无 ORM）；
  `MCPRegistryStore` 端口 + `PgMCPRegistryStore` + `PersistentMCPRegistry`；
  服务重启恢复、直接 SQL 变更驱动 stale-authorization 探针（0 请求）、
  AgentPermissions 不被绕过（allowlist AND 语义）。REST API 未实现（后续阶段）。
- 5.5-4 Remote MCP & Auth：✅ 完成（见 docs/30）。官方 SDK Streamable HTTP
  （非旧版 HTTP+SSE session 模型）：`RemoteMCPClient` 实现 MCPClientPort；
  生命周期 CONNECTING→CONNECTED→DEGRADED→RECONNECTING→CONNECTED/DISCONNECTED
  持久化到 Registry；有界重连（指数退避、单飞、可取消、防风暴）；
  credentialRef/authRef 仅引用 + 平台 resolver 受控解析 + 头注入；
  密钥不进入 DB/错误/结果/日志（含 lastError 双重 redaction）；
  ToolRuntime timeout/cancellation/audit 全回归；真实本地 HTTP server E2E +
  第三方 server-everything streamableHttp 互操作。
- 5.5-5 MCP Console：✅ 完成（见 docs/31）。`/api/mcp` 7 个 Console 端点 +
  `/mcp`、`/mcp/:serverId` 页面（Overview / Tools / Bindings）；状态全部来自后端
  Registry；绑定 enable/disable/revoke 立即生效（零请求断言）；源码级“Browser 不直连
  MCP”守护。Server 注册/启停 UI 未实现（严格范围）。
- 5.5-6 Resource & Prompt：✅ 完成（见 docs/32）。`MCPResourceAdapter` /
  `MCPPromptAdapter`（独立、非 ToolDefinition）；官方 SDK 真实 stdio + Streamable
  HTTP；server-scope 绑定行 + 调用时重查 + provider 逐项策略；拒绝零请求（计数
  器/HTTP hit 断言）；timeout/取消/错误归一化/脱敏全部复用既有机制；audit 为
  DI sink（零存储）。
- 5.5-7 MCP Apps：✅ 完成（见 docs/33）。`ui://` 走 5.5-6 资源架构；工具
  `_meta.ui` 归一化为 `MCPToolDefinition.uiResourceUri`；Console 以
  `sandbox="allow-scripts"` + `srcdoc` 渲染，Host Bridge 用共享 zod strict
  schema + source 身份校验；受控动作经 `/api/mcp/apps/actions` →
  ToolRuntime（permission/approval/timeout/cancellation/audit 全复用）；
  拒绝零请求矩阵、凭据隔离（iframe/HTML/URL/postMessage 零凭据）测试通过。

### Contracts

```ts
interface MCPClientPort {
  connect(server: MCPServerDefinition): Promise<void>;
  disconnect(serverId: string): Promise<void>;
  listTools(serverId: string): Promise<MCPToolDefinition[]>;
  callTool(serverId: string, name: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
}

interface MCPToolAdapter {
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}
```

### Core Invariants

1. Agent 只能通过 Tool Runtime 使用 MCP。
2. MCP Tool 使用与 Native Tool 相同的 Policy / Approval / Audit。
3. Policy DENY 时 MCP Server 收到 0 请求。
4. Credential 只以 reference 形式存在。
5. MCP protocol 使用官方 SDK，不自行实现。
6. Resource / Prompt / Apps 分阶段实现。
7. 每个 Sub-phase 独立可测试、可回滚。
8. 完成一个 Sub-phase 后停止。

### MVP

```text
5.5-0 → 5.5-1 → 5.5-2 → 5.5-3
```

后续能力：

```text
5.5-4 Remote
5.5-5 Console
5.5-6 Resource/Prompt
5.5-7 Apps
```

不得因为后续能力提前修改 MVP 的架构边界。

## Phase 5.6 — Visual Engineering

核心目标：建立真实的视觉工程闭环，而不仅是视觉分析工具集。

```text
Visual Input
→ Visual Analysis
→ UI Specification
→ Frontend Agent
→ Browser Runtime
→ Screenshot
→ Visual Evaluation
→ Visual Issue
→ Fix Task
→ Frontend Agent Fix
→ Re-evaluation
→ Responsive / UI State Validation
```

### 5.6-0 Visual Contract

冻结 Visual Input、Visual Reference、UI Specification、Design Tokens、Component Map、Layout/Constraint、Asset Reference、Visual Evaluation 基础契约。

### 5.6-1 Visual Analysis

支持 Screenshot / Figma / URL 三类输入，输出结构化 Visual Analysis 与 UI Specification。VLM 通过可替换 Provider 接入；Fake Provider 只能用于离线测试，不能作为完整能力验收依据。

### 5.6-2 UI Specification → Frontend

Frontend Agent 必须实际消费 UI Specification 并修改前端代码。Task/Draft 只是中间结构，不等于阶段完成。代码修改继续通过既有 Agent / ToolRuntime / Sandbox。

> **2026-09-12 Repair(docs/46)**:真实执行闭环已实现 —— Frontend Agent 实际接收
> FrontendTask(由 UI Specification 转换,含 Component Map / Design Tokens / Layout /
> Asset),经既有 Agent/ToolRuntime/DockerSandbox 真实修改代码并生成可运行页面,
> Docker E2E 覆盖 build / run / render、组件复用、缺失组件记录、无权限拒绝。
> 5.6-2 移入 ✅(待新一轮 Global Regression 复核)。

### 5.6-3 Browser Runtime

Browser Runtime 负责受控导航、Viewport、Screenshot、Console、Network、Runtime Error、Timeout、Cancellation 与 Evidence。Playwright 只能存在于 Browser Adapter 边界，不得被 Agent 直接调用。

> **2026-09-12 Repair(docs/47)**:Network Error 采集已补齐 —— `requestfailed`
> 真实监听 + HTTP 4xx/5xx 响应监听,三类证据(kind/status/reason/url,脱敏)进入
> 既有 Browser Session 证据链,截图锚点携带 `networkErrorCountSinceLast`;
> 真实 Chromium E2E(loopback HTTP fixture,零外网)覆盖全部网络场景。

### 5.6-4 Visual Evaluation

比较 Reference 与 Candidate，输出结构化 Visual Evaluation、Visual Issue、Difference 与 Evidence。Pixel Diff 仅作为辅助定位，不单独决定视觉结论。

### 5.6-5 Auto Fix / Re-plan

Visual Issue → Fix Task → Frontend Agent → Code Change → Browser → Screenshot → Re-evaluation。必须是真实执行链，而不是只生成 Draft 或维护状态机。连续无进展后进入已有 Human / Workflow 边界。

> **2026-09-12 Repair(docs/48)**:真实执行链已实现(组合根 `visualFixLoop`)——
> 逐轮真实完成「Fix Task 提交 → Agent 改码 → 独立 build/test → Browser 重跑 →
> 截图 → Visual Evaluation → 三态判定」;连续无进展 → STALLED、达上限 →
> MAX_ROUNDS,均以既有 workflow vocabulary(WAITING_APPROVAL/REPLAN)交接人审。
> 真实 Chromium + Docker E2E 覆盖 resolved / new issue / regression / no-progress /
> max iteration / human boundary。

> **2026-09-13 Repair #2(docs/49)**:重评估输入修正 —— Candidate 侧由
> **真实截图字节**驱动(`analyzeCandidateScreenshot`),Reference 与 Candidate
> 两侧真实截图进入 5.6-4 冻结的 evaluateVisuals;不再以 URL/HTML 结构分析
> 替代截图评估;三态判定完全来自截图比较。

### 5.6-6 Responsive & UI State Validation

验证多 viewport 与真实 UI State。UI State Validation 必须基于真实页面状态变化和截图/评估，而不是仅构造状态数据进行纯函数测试。

> **2026-09-13 修复(docs/50)**:真实状态闭环完成 —— 十态(loading/empty/error/
> disabled/hover/focus/active/expanded/modal + default 基线)全部经真实交互触发并
> 产生真实 Chromium 截图,进入冻结 evaluateVisuals;响应式矩阵补齐 tablet/custom,
> 媒体块剥离后仅 sub-600px 视口变化(断点域精确性);状态级回归探测可捕获页面级
> 比较隐形的破坏样式表;docs/40 §7.3 的 "headless hover 限制" 经真实 E2E 证伪。
> shared 契约 / 评估算法 / 工具注册表零改动。

### Current Status

- 5.6-0：✅ 完成
- 5.6-1：🟡 部分完成
- 5.6-2：✅ 完成(2026-09-12 Repair;待新一轮 Global Regression 复核)
- 5.6-3：✅ 完成(2026-09-12 Repair;待新一轮 Global Regression 复核)
- 5.6-4：✅ 完成
- 5.6-5：✅ 完成(2026-09-12 Repair;待新一轮 Global Regression 复核)
- 5.6-6：✅ 完成(2026-09-13 Repair;待新一轮 Global Regression 复核)

Phase 5.6 在全部子阶段通过验收和新的 Global Regression 前，不得宣布 Frozen。

> **2026-09-13 状态(docs/51)**:5.6 → 5.7 Global Regression **PASS** —— **PHASE 5.6: FROZEN;PHASE 5.7: READY**。5.6-1 外部 live e2e(OpenAI / Figma)为 BLOCKED BY EXTERNAL CONFIG,按任务书单独报告,未伪装 PASS。

## Phase 5.7 — Computer Use / External Engineering Tools

> 当前状态：5.7-0 Computer Use Contract 已完成；5.7-1 Browser Computer Use 已完成并通过
> 安全 Repair(敏感输入隔离,2026-09-13,见 docs/52 + docs/53)；5.7-2 External Engineering
> Systems 已完成(2026-09-13,见 docs/54)；5.7-3 Action Policy 已完成(2026-09-13,见 docs/55)；
> 5.7-4 Evidence & Verification 已完成(2026-09-13,见 docs/56)；5.7-5 Failure Recovery 已完成
> (2026-09-13,见 docs/57)——**Phase 5.7 全部子阶段(5.7-0 ~ 5.7-5)完成**。

核心不变量：

```text
Agent
→ Tool Runtime
→ Browser / MCP
→ External System
→ Evidence
→ Verification
```

GUI Action 与 API/MCP Action 使用统一 Permission / Risk / Approval / Audit。

高风险外部动作默认需要人工审批。

> **2026-09-13 5.7-1 完成记录(docs/52)**:`browser.observe`(DOM 固定脚本 +
> aria snapshot → 严格 5.7-0 Observation,观察 ref 可直接作动作选择器)+
> `browser.action.{navigate,click,type,screenshot}`(→ 严格 ActionResult,截图复用
> 5.6-3 资产管线),全部经既有 ToolRuntime 治理(AgentPermissions.tools 权限门、
> ToolCallRecorder 审计、既有 timeout/cancellation 封套);浏览器上下文零凭据注入;
> 观察内容与 actionRef.target 经脱敏单源(含密 data:URL 泄漏路径经 E2E 锁定);
> 真实 Chromium E2E:observe → click/type → observe 全链路 + 治理封套用例。
>
> **2026-09-13 5.7-1 Repair 记录(docs/53)**:观察安全修复 —— 探针证明原实现双通道泄漏
> (DOM `value→text` 原样携带 password 值;`page.ariaSnapshot()` 明文渲染 textbox 值且
> 长值缩写使 regex 失效)。修复:凭据语义字段(type=password / autocomplete=
> _password_|one-time-code)结构化屏蔽,值永不离开页面(节点携 `[value hidden: …;
hasValue: …]` 语义);无障碍树改为受控派生(结构只读、零表单值);普通输入照常可观察;
> `PageLike.ariaSnapshot()` 退出接口。真实 Chromium 安全 E2E(本地 http fixture)锁定
> Observation / ToolResult / audit / a11y 树四出口零原文;browser 34/34、全仓 558/558。
>
> **2026-09-13 5.7-2 完成记录(docs/54)**:External Engineering Systems 统一接入 ——
> `ExternalToolCatalog`(系统身份/分类 + 声明式 tool 清单与平台侧 risk;`resolvePolicy`
> 仅认 (serverId, toolName),远程自报 risk 零信任,未声明 tool 一律 DENY)+
> `ExternalEngineeringConnector`(连接/发现复用 `MCPToolRegistry` 冻结可见性链;映射经
> 5.5-2 MCPToolAdapter,零新传输/零新权限);外部动作统一输出 5.7-0 ActionResult +
> 不受信 result 数据(结构化脱敏);credentialRef→既有 resolver→连接(secret 零进
> 结果/审计);mock 外部工程系统走真实 MCP stdio + credentialRef 真实 Streamable HTTP
> 注入 E2E;敌意外部内容(prompt injection / fake system message / malicious markdown /
> links / fake tool result)全部以惰性数据通过。mcp 232/232、server 53/53、全仓 591/591,
> 四门禁 exit 0。
>
> **2026-09-13 5.7-3 完成记录(docs/55)**:统一 Action Policy —— 新包
> `@ai-se/action-policy`(冻结 LOW/MEDIUM/HIGH 映射表 + 浏览器动作白名单;`resolve` 统一
> 入口;`applyActionPolicy` 组合期执行:未知动作/低于政策声明 DENY;`withApprovalGate`
> 执行期门;`approvalRequiredFor` 派生)。Browser 与 External 同表同语义:浏览器工具风险
> 来源改为政策;外部 catalog 仅是输入、政策为最终决策(误声明 LOW 升为 HIGH+审批并零请求
> 拒绝)。审批复用既有 WAITING_APPROVAL 链(真实 PG E2E:拒绝 → 零 MCP 请求;批准 →
> 真实执行)+ 既有 approval gate / `metadata.approved` 约定;审计复用 ToolCallRecorder +
> ToolResult.audit + 审批事件(toolCallId 关联)。action-policy 13 例、browser 38、
> mcp 235、server 57、全仓 615/615,四门禁 exit 0。
>
> **2026-09-13 5.7-4 完成记录(docs/56)**:统一 Evidence —— 契约块复用 5.7-0
> actionRef/Observation/ActionResult,`screenshot://` 引用锁前缀;migration 009
> `evidence_records`(JSONB + 关联 FK + checksum 机制延续)+ `PgEvidenceRepository` +
> 只读 Evidence API(list/detail;跨项目 403 零载荷);before → action → after → 验证
> (冻结 VERIFIED/FAILED);单一脱敏 sink(既有 redactCredentialShapedText / redactString),
> 记录/DB/API 三层反例锁定零明文。evidence 9 例、全仓 646/646,四门禁 exit 0。
>
> **2026-09-13 5.7-5 完成记录(docs/57)**:统一失败恢复 —— 新包
> `@ai-se/failure-recovery`(冻结 6 类分类器 + UNKNOWN 安全兜底;浏览器交互失败由
> re-observe 细化)接入引擎可选 `failureRouter` 钩子(RETRY/REPLAN 复用既有链;
> HUMAN 复用既有 approval 实体 + WAITING_APPROVAL;默认路径零行为变化);每次重试重新经
> ToolRuntime/Action Policy/审批门/审计;每轮 5.7-4 证据保留、round 可追踪。真实 E2E
> 10/10;failure-recovery 16 例、全仓 677/677,四门禁 exit 0。
>
> **2026-09-13 V1 Final System Acceptance(docs/58)**:全仓四门禁 exit 0
> (111 文件 / 682 测试,0 failed / 0 skipped);migration fresh + checksum 守卫通过;
> Golden Scenario 真实跑通(PRD → Planning → Dynamic Workflow → Multi-Agent → 真实 QA
> 失败 → 动态 Re-plan → Review → CI → Staging → 审批 → Production),并同轮真实验证
> pause/resume、cancel、server-restart recovery。**Technical Regression / Dynamic
> Workflow / Product Usability = PASS;AI-SE V1: ACCEPTED**。VLM / Figma / GitHub /
> GHCR / Production live 验证 = BLOCKED BY EXTERNAL CONFIG(未伪装 PASS)。

## Post-V1 — Real AI Validation

### Goal

证明 AI-SE 不仅具备工作流基础设施，
还能够被真实 LLM 驱动完成软件工程任务。

### Acceptance

Real LLM
→ Requirement
→ Planning
→ Dynamic Task Graph
→ Multi-Agent
→ ToolRuntime
→ Code
→ Test
→ Failure
→ Re-plan
→ Recovery
→ Delivery

该阶段不新增 Runtime / Workflow / Agent / Tool 系统。

## Post-V1 Enhancements(V1 后增强)

### Progress

> **2026-09-28 失败工作流重试(docs/99 任务书 / docs/100 实施记录)**:FAILED 工作流新增人工重试出口
> (`WorkflowEngine.retry` + `POST /api/workflows/:id/retry` + 控制台「重试失败任务」按钮):只重排
> 未解决失败任务(`failureHandled` 复位)与 BLOCKED(派生态重置),SUCCESS / 已解决失败一律跳过
> (不新增 AgentRun = 不重烧 token);工作流 `FAILED → RUNNING` 并清 `error` / `finished_at`,随后完全
> 沿既有 `claimNextTask → executor → ToolRuntime → 审批 / 审计` 链继续执行。状态机新增
> `FAILED → RUNNING` 与 `BLOCKED → PENDING` 两条边;`start()` 收紧为仅 PENDING、`resume()` 仅 PAUSED
> (防止新增边被两个入口当作"半恢复")。零新表 / migration / 依赖 / 状态。真实 E2E(真实 PostgreSQL):
> 重试成功 + 跳过已完成(`agent_runs` 计数 A 不变 / B+1 / C+1)、重试仍失败有界、SUCCESS / RUNNING
> 守卫 409、CONTINUE 造 BLOCKED 后恢复;全仓 979 例 972 通过(7 个先存 eyebrow 失败),
> typecheck / lint / build exit 0。

> **2026-10-14 前端可用性改造 W1–W3(docs/132 任务书 / docs/133–135 实施记录)**:`apps/web` 的
> 系统性重构,把审评文档的 P0–P10 映射成 10 个命名阶段(W1–W10),每阶段独立验收、独立停机。
> 工程目标与"不做的事":**不动业务逻辑、文案、store / api / viewmodel 与路由契约**;收益全部
> 落在"改样式真的会生效"与"视觉语言可推导"上。
>
> - **W1(docs/133)** 诊断核对 + 基线归零:逐条复核审评的 8 条问题(几乎全部成立),补上审评未
>   发现的第 9 条——测试套件本就是红的(4 failed / 316 passed,全为 `PageHeader` eyebrow 断言
>   漂移),先修成绿再开工。
> - **W2(docs/134)** 拆除双样式体系:删除 960 行未分层的 `styles.css`(96 个类选择器**全部**
>   零引用,这是比审评主张更强的结论),把仍在生效的 6 条全局元素规则迁进 `@layer base`,清掉
>   17 处对抗补丁。CSS 46.27 kB → 32.69 kB。**测试断言一处未改**(刻意保留全部对测试可见的类名),
>   外观零变化由浏览器逐项计算样式实测确认。
> - **W3(docs/135)** 重建设计令牌与排版:字号 9 → 6 档、圆角 4 → 3、阴影 2 → 1、语义色补到
>   5 族 × 4 档、断点由 `min-[900px]` 收敛到具名 `lg`、8 个零使用令牌清除、亮暗两套落地并各
>   24 组对比度实测全过(顺带修掉两个既有 AA 缺陷)。字体由外部 CDN 的 Jost 换成系统字体栈——
>   依据是实测 x-height/cap 0.657 vs 0.721(14px 小写字母矮 9.4%),同时**修正了审评的两条事实
>   误判**(CDN 实测可达;`tabular-nums` 在 Jost 下实测生效)。
> - 交付 `apps/web/src/styles/README.md`(令牌用法 + 新页面决策树,供后续改动自查),并把
>   `docs/design/00-design-system.md` 回写到与实现一致、v1.0 取值标注「已废弃」。
> - 每阶段门槛:该包 `typecheck && lint && test` 全绿,末阶段加 `build`;W1–W3 结束时 320/320。
>   两处未做并已登记理由:非文本对比度(`--border` / `--input` 低于 3:1)留 W9 裁决;26 处
>   `grid-cols-[…]` 与 11 个 scoped CSS 块留给 W5 统一页面骨架。
>
> **W4–W10 未开始**(AppShell/信息架构、页面骨架、仪表盘、表格、交互容器、可访问性、终验)。

> **2026-10-14 前端可用性改造 W4(docs/136 实施记录)**:重建 AppShell 与信息架构。三处实质变化:
> ① **侧栏从「纯导航」变成「导航 + 告知」**——8 个已 import 却零渲染的图标(死代码)真正渲染,选中态
> 改为背景 + 文字色 + 图标色同时变,新增工作流失败数徽标(取真实 store 数据,为 0 或未加载时不显示
> 无意义的 0);侧栏因此**删掉最后一个 scoped CSS 块**。② **顶栏从一行装饰文字变成入口**——面包屑
>(分组 / 页面 / 对象,取不到就不显示该段)+ 全局搜索:新增 `Cmd/Ctrl+K` 命令面板,搜索页面与各
> store **已加载**的实体,判断逻辑下沉到 `viewmodels/commandPaletteViewModel.ts` 并可单测;面板
> 打开时才按需加载,不在应用启动时凭空多出请求。③ **页面宽度有了唯一来源**——新建 `PageContainer`,
> 只有 1200 / 1440 两档,11 个页面全部套用,裸 `<section>` 根节点归零(改造前全站无任何内容宽度约束,
> 宽屏内容一路拉到屏幕边缘)。
>
> 一处**刻意未做**:审评建议顶栏留「通知入口 / 用户菜单占位」,但本应用没有登录态、没有用户模型
>(`api/auth.ts` 只是可选的 API Token 头)、也没有通知实体——加一个点了没反应的控件是假的可交互
> 承诺,按审评自己「不要为了填满布局而编造」的原则不放。已在 docs/136 §2.5 登记,等你裁决是否
> 要 disabled 占位。
>
> 门槛:typecheck / lint / test **339/339** / build 全绿(+19 条测试:appShell 加严并新增 7 条,
> 命令面板 viewmodel 新增 12 条)。10 个未分层 scoped CSS 块、`grid-cols-[…]`、非文本对比度
> 按计划留给 W5/W9。

> **2026-10-14 前端可用性改造 W5 完成(docs/137 实施记录)**:统一页面骨架,**10/10 页全部收敛**。
> 四处共享改造:
> ① **四种状态第一次有统一渲染方式**——新增 `LoadingSkeleton` / `TableSkeleton` / `ErrorState`
> 三个共享件 + 一条固定顺序(加载 → 错误 → 空 → 数据)。改造前每页各写「正在加载X…」纯文字与
> `<p class="text-danger">`,全站仅 2 处能重试;现在 **9 处**错误态可恢复,并消除四处「错误与空态
> 同时出现」的假象,补上 `MCPServerDetailView` 原先的**整页白屏**与 `MCPAppView` 缺失的加载分支。
> ② **`DetailRow` + `.detail-row`**——17 处逐字重复的 `grid-cols-[110px_minmax(0,1fr)]` 详情行
> 收敛成组件 + 一条 `@layer components` 具名样式(标签列 110→112px 回到 4px 刻度,`1fr`→`minmax(0,1fr)`
> 防撑破)。③ **`.tone-dot`**——Workflows 与 AgentRun 两段**逐字相同**的 scoped 色调点 CSS 收成一条,
> 两页 scoped 块整体删除。④ **`PageHeader.eyebrow` 删除**(11 页零使用)。
>
> 逐页结构变化:`Projects` 表单进 Dialog + 补分页;`Deployments`「环境」表单进 Dialog 但**保留主从两栏**;
> `Workflows` / `Agents` / `Deployments` / `MCPApp` 的错误移进四态链并优先于空态;`MCPServers` /
> `MCPServerDetail` / `ProjectDetail` / `MCPApp` 的 scoped 块改写为工具类;`MCPApp` 的加载表单与
> `Workflows` 的两个筛选被正式认定为「工具行」。
>
> 三处**刻意未做**:工具行里计划点名的五项搜索/筛选/批量/列设置 W5 仍**一个新控件都没造**(只把本来就有的
> 控件归位);分页的「每页条数」选择器;三处「动作已在同一屏内」的空态不塞按钮。
>
> 门槛:typecheck / lint / test **369/369** / build 全绿(+30 条)。**CSS 产物 36.51 → 29.81 kB**
> (scoped 里的一次性声明改写为工具类后由 Tailwind 去重)。**未分层 scoped 块 10 → 2**(Deployments 的
> `[data-active]` + Dashboard 的 W6 待办);**`grid-cols-[…]` 24 → 7**(剩 4 种布局模板,理由记 README §13);
> 任意值 `text-[…]` / `rounded-[…]` / `min-[900px]` **归零**。另删除 **2 段死代码 CSS**(`.mcp-checkbox input`,
> 复选框早已迁到渲染 `<button>` 的 reka-ui Checkbox,那些 `input` 选择器匹配不到任何元素)。
>
> **2026-10-14 前端可用性改造 W6 完成(docs/138 实施记录)**:仪表盘去海报化。四处实质变化:
> ① **首屏从「陈列」变成「分诊」**——按「用户会问的问题」重排为 ① 需要处理(失败/等待审批/已暂停,
> 状态色 + 数量) → ② 正在运行(运行中/等待中) → ③ 最近的动态 → ④ 总量统计(项目规模)。改造前是
> 流水线圆点 → 三个数字 → 最近项目。② **删掉海报式装饰**——交付流水线圆点轨道(`.dashboard-rail` +
> `.dashboard-dot` + 连线)与整套入场动画(4 段 keyframes + 逐项 delay)全部删除,**连带删掉全仓最后
> 2 处 `!important`**(那是给动画做的 prefers-reduced-motion 守卫),生产代码 `!important` 归零;
> 56px 的 `gap-14` 改用统一的 `--section-gap`。③ **表面层级**——四块信息各自包 `Card`(改造前三组
> 信息全是裸的);补 `PageHeader`(仪表盘原是全站唯一没有 `<h1>` 的页面)。④ **口径从模板搬进 viewmodel**
> ——「关注 = FAILED+WAITING_APPROVAL+PAUSED / 推进 = RUNNING+PENDING」是两个有单测锁住的常量;
> 数字的颜色**只在非 0 时**用状态色(「失败 0」不该看起来像告警),① 全为 0 时换成一句平静的话。
>
> 一处**计划内部矛盾已报告并请用户裁决**:工作项 5 说「等现有 store」,约束却说「store 调用不变」,
> 而按优先级 ①② 用项目数据推不出来(项目只有 active/archived)。用户裁定 **projects + workflows** ——
> 侧栏已全站加载 workflows,故本页读它**不增加任何实际请求**。
>
> 一处**内容变化待确认**:仪表盘的「最近项目」表已替换为「最近工作流」(理由:①② 都是工作流视角,
> ③ 回到项目视角会自相矛盾;项目列表有独立页面与独立侧栏入口)。若需保留,加回来很快。
>
> 门槛:typecheck / lint / test **381/381** / build 全绿(+12 条)。**CSS 产物 29.81 → 26.88 kB**。
> **全仓未分层 scoped 块 2 → 1**(只剩 Deployments 的 `[data-active]` 强调条,W2 时是 11 个)。
> **W7–W10 仍未开始**;非文本对比度留 W9。排在 W 线之后的 **X1 · 模型与凭据配置** 已裁定立项(见 docs/17)。

> **2026-10-14 前端可用性改造 W7 完成(docs/139 实施记录)**:立表格与数据展示规范。四处实质变化:
> ① **列对齐从「每页各自处理」变成组件契约**——`Table.vue` 里写死两张对齐映射(默认左;`align:"right"`
> 的列右对齐**并自动带 `tabular-nums`**),`text-center` 从组件中移除(浏览器实测居中单元格为 **0**)。
> 改造前全表居中,这正是「随便打开一个列表页,一列名称从头扫到尾」扫不动的原因:每一行的左边缘都在飘。
> ② **表头三态排序**——`sortable: true` 的列表头变 `<button>`,升序 → 降序 → 取消,输出 `aria-sort`;
> 比较器与状态机下沉到 `components/ui/table/sort.ts`(纯函数,16 条单测),**空值恒排末尾**(否则降序时
> 一整列空白会顶到最上面)。③ **分页默认打开**——`Table` 的 `pageSize` 默认 `0` → **10**,5 个列表页
> 删掉显式传参;`DashboardView` 的摘要表是全站**唯一**传参处(显式 `0`)。④ **`AgentRunView` 7 列 → 5 列**,
> 「Agent / 项目」并进「任务」列次行、「工作流 / 任务键」合成「来源」列,操作列 3 个平级按钮 → 2 个。
>
> **「复制 ID」从动作变成文本属性**:新组件 `CopyableId` 让 ID 文本本身可点复制(悬停提示完整 ID、
> 复制成功有「文字 + 图标 + 语义色」三重反馈),替代列表里占按钮位的第三个按钮;剪贴板逻辑抽到
> `composables/useCopyToClipboard`(**`composables/` 目录首次建立**,AGENTS §5 规划的四个目录至此全部落位),
> 剪贴板实现可注入,故可在 Node 环境下单测。
>
> **五项能力经评估后明确不做**并给出理由:固定表头(每页 10 行 ⇒ 表格高度有上界,做 sticky 反而要在页面里
> 多套一层内部滚动区)、行选择 + 批量操作(全站没有任何批量操作可施加)、列显示隐藏(最宽只有 6 列)、
> 每页条数切换(W5 已裁定)、虚拟滚动(**不需要**——渲染行数由分页钉死在 10,DOM 规模与数据总量无关;
> 触发条件是「不分页且上万行」或每页 100+)。计划原文的「操作列收为主操作 + 更多菜单」**未采用**:
> 删掉复制按钮后操作列最多只剩 2 个按钮,为 1 个条目套下拉菜单是增加点击成本。
>
> **发现并记录一处全局坑**:`apps/web` **不含 Tailwind preflight**(W2 的有意决定),因此直接写 `<button>`
> 会带上浏览器默认外观(`2px outset` 边框 + 灰底 + 内距)—— 浏览器实测第一版排序表头就渲染成了三个带边框的
> 灰色小按钮。两处新按钮照 `components/ui/` 既有惯例显式 `appearance-none border-0 bg-transparent p-0`,
> 补两条护栏测试钉住,README §0 新增一节说明。
>
> 门槛:typecheck / lint / test **412/412** / build 全绿(+31 条,新增 `tableSort.test.ts` 与
> `copyToClipboard.test.ts` 两个文件)。**CSS 产物 26.88 → 27.34 kB**(新增排序指示图标与 `CopyableId`)。
> 浏览器实测(真实 Chromium + Playwright 驱动 dev server + 页面内注入 fetch mock)**27/27 通过**,
> 含「点表头后全列时间单调不减 / 不增」「剪贴板内容 === 完整 ID 且 1.5s 后复位」。
> **W8–W10 仍未开始**;非文本对比度留 W9。排在 W 线之后的 **X1 · 模型与凭据配置** 已裁定立项(见 docs/17)。

> **2026-10-14 前端可用性改造 W8 完成(docs/140 实施记录)**:交互容器规范。四处实质变化:
> ① **容器选择第一次成文**——`apps/web/src/components/README.md` 给出四类容器的判据(`Dialog` 轻量新建/编辑
> ≤5 字段 → `ConfirmDialog` 危险确认 → `Drawer` 查看列表某一行的详情 → 独立路由页 对象本身是独立目的地)、
> **11 个页面每个动作该用哪种容器**的逐页表,以及最容易画错的一条分界:「Drawer 还是路由页」的判据是
> **「它是不是列表某一行的展开」**,不是「内容多不多」。② **三种危险确认机制收敛为一种**——清点发现不是
> 「都用同一套」而是三种:行内二次确认(`ProjectsView`)、`window.confirm`(`ProjectDetailView` /
> `MCPServerDetailView`)、以及若干完全没有确认。两种旧机制各有实质问题:行内二次确认在详情页与页头动作里
> **没有落点**(那里没有「一行」可以展开),`window.confirm` 用不了设计令牌、显示不了错误、阻塞主线程。
> 新增 `ConfirmDialog`(用 Dialog 原语,因此与其它容器共用同一套 Esc/焦点行为;`description` **类型必填**,
> 「确定删除吗?」不够、要写清后果;失败**不关闭**确认框并把原因显示在框内),三处全部改到它上面。
> ③ **确认判据成文**:不是「看起来危不危险」而是**「救不救得回来」**——不可恢复的必须确认,能重跑/重试的
> 不确认(取消运行、暂停工作流),「二选一」的显式选择不确认(批准/拒绝),表单本身已强制填写后果说明的
> 不确认(回滚的 `原因` 是 `required`)。这三条「不需要」是刻意的。④ **Cmd/Ctrl + Enter 提交表单**——
> 普通输入框 Enter 本来就会提交,但 **`<textarea>` 里 Enter 是换行**,于是「写完一段任务描述直接提交」
> 这条路径改造前必须把手挪到鼠标;新增 `composables/useModEnterSubmit`,走 `requestSubmit()` 以保留原生
> `required` 校验,**9/9 表单全部挂上**。Esc/焦点进入/焦点返回/模态不逃出四项由 Reka Dialog 原语提供,
> 本次**未重写而是逐项浏览器实测**。
>
> **新增的护栏测试当场抓到 2 处既有违规**:`ProjectsView` 行内的「删除」是普通 `ghost`、**完全没有
> danger 色**;`RequirementsView` 的「拒绝并重做」是 `secondary`(与同页的「批准切片计划」视觉无区别)。
> 两处都已修正:「危险按钮一律用 danger 语义色」拆成两档——**触发点** `ghost` + `text-danger`(列表行内
> 一行一个实心红按钮会把表格变成警报墙)、**执行点**实心 `destructive`。
>
> 门槛:typecheck / lint / test **430/430** / build 全绿(+18 条,新增 `modEnterSubmit.test.ts` 与 3 条
> 跨页面护栏)。**CSS 产物 27.34 kB 无变化**(未引入新工具类)。浏览器实测(真实 Chromium + Playwright)
> **21/21 通过**,含「连续 12 次 Tab 焦点不逃出容器」「关闭后焦点返回触发元素」「焦点在 textarea 上按
> Ctrl/Cmd+Enter 真的发出 POST」「点取消不发 DELETE、点确认发一次 DELETE」。
> **W9–W10 仍未开始**;非文本对比度留 W9。排在 W 线之后的 **X1 · 模型与凭据配置** 已裁定立项(见 docs/17)。

> **2026-10-14 前端可用性改造 W9 完成(docs/141 实施记录)**:可访问性与一次配色裁决。四处实质变化:
> ① **状态第一次做到三重冗余**——`StatusBadge` 六个 tone 各配一枚**形状不同**的图标(对勾/弧/虚线圈/
> 三角/叉/短横),改造前「已完成」与「失败」除文字与红绿之外**没有任何形状差异**,红绿色觉障碍(男性约 8%)
> 一眼扫过一列徽标分不出好坏;图标是装饰性的(`aria-hidden`),文字已朗读过同样信息。② **非文本对比度
> 从「一个待办」变成「一条有条款依据的判据」**——原记录只写「`--border` 1.17:1 / `--input` 1.54:1 低于
> 3:1,等 W9 裁决」;W9 实测 28 组 × 2 模式后拆成三件不同的事:**`--input` 判为真实缺陷并修正**
> (1.54 → 3.41/3.14:1,因为输入框与所在面同色、边框是唯一识别依据,落在 1.4.11 正面约束内),
> **`--border`(装饰性分隔)与 `--foreground-disabled`(SC 1.4.3/1.4.11 明确豁免停用组件)维持原值**并把
> 条款写进 README §9。设计文档「不使用过重边框」的设计语言因此保留——变重的只有表单控件边界。
> ③ **文档层**——`lang="en"` → `zh-CN`、favicon 从 `data:,` 换成真实 SVG(`apps/web/public/` 首次建立,
> 主色 + `>_` 提示符,16px 下仍可辨且与侧栏圆点同源)、补 `color-scheme`(修掉滚动条与原生控件在暗色下
> 仍亮的问题)。④ **删除零使用的 `--border-strong`**——它与旧 `--input` 同值、文档还说它「用于明确轮廓处」,
> 留着只会让人拿它给输入框描边从而把刚修好的缺陷带回来。
>
> **实测覆盖**:焦点环逐元素 Tab(仪表盘 15/15 有可见指示)、icon-only 按钮可访问名称(无名元素数为 0)、
> 表格语义(`th[scope=col]` + 可排序列 `aria-sort`,W7 成果复核)、命令面板键盘(`Cmd/Ctrl+K` 打开、
> 方向键移动高亮、`Esc` 关闭)、暗色模式徽标取暗色令牌。**W9 自身 18/18 通过**,并回归跑通 W7(27/27)
> 与 W8(21/21),确认配色与徽标改动没有破坏前两阶段的结论。
>
> 门槛:typecheck / lint / test **443/443** / build 全绿(+13 条,新增 `accessibility.test.ts` 9 条 +
> `StatusBadge` 三重冗余 4 条)。**CSS 产物 27.34 → 27.24 kB**(删掉废弃令牌的映射)。**诚实边界**:
> 未跑自动化 a11y 扫描器、未用真实屏幕阅读器,因此**不声称「全站符合 WCAG」**——结论限定为
> 「计划点名的九项逐项实测通过」。
> **W10 未开始**;排在 W 线之后的 **X1 · 模型与凭据配置** 已裁定立项(见 docs/17)。

> **2026-10-14 前端可用性改造 W10 完成(docs/142 终验报告)——W1–W10 全线收口**:终验只做三件事:
> 机械检查、逐条对照、诚实报告。**6 项机械检查全部达标**:`styles.css` 已删且零引用;生产代码
> `!important` **0**;固定像素一次性值与任意断点**归零**(剩余 arbitrary value 只有「视口钳制」
> 与 `var(--token)` 两类,逐条列明);legacy 类名**在 class 属性里 0 处**(命中全在注释);
> `text-decoration: none` **0**;四条门槛 + 全仓 16 包全绿。**8 条原始问题 7 条已解决、1 条部分解决**
> (表格的「表头固定」W7 评估后判定不做并有理由)。**三条主观标准 2 条已解决、1 条部分解决**——
> 1440×900 下仪表盘「最近工作流」第 5 行底边在 **915px**、视口 900px,**差 15px**;高度被 ① ② 两张
> 指标卡吃掉,未在验收阶段改版式(附三条候选修法待裁决)。
>
> **W10 额外查出 5 个不在点名清单里的死类名**并清剿:`nav-link` / `nav-link--active` / `agent-link` /
> `mcp-action-link` ×2 / `requirement-dependencies`。做法从「照单核对」升级为**「按产物反查」**——
> 把全部 class token 与构建产物 CSS 对账,凡在 CSS 里找不到规则的即死类名;并顺手把依赖它们做 DOM
> 断言的测试改成依赖**真实语义**(`aria-current="page"` / `href` / `<nav>` 作用域)。新增自动化护栏
> (剥离注释后只扫 `class="…"`),从此不会回潮。`.taste-skill/` **移出仓库**到
> `/tmp/ai-se-taste-skill-archived/`(无 git,删除不可恢复,移出同样达成目标且留了回退路径)。
>
> 门槛:`apps/web` **446/446** 全绿(+3 条护栏),CSS **27.24 kB**;**全仓 16 包 / 175 文件 /
> 1434 用例全绿**。**W1–W10 累计**:未分层 scoped 块 **11 → 1**、`grid-cols-[…]` **24 → 7**、
> `!important` **2 → 0**、CSS 产物 **36.51 → 27.24 kB**(−25%)、`apps/web` 测试 **23 文件(4 个红灯)
> → 36 文件 / 446 用例全绿**、设计文档与实际从分叉回到一致(W3 回写)。
> **诚实边界**:未跑自动化 a11y 扫描器、未用真实屏幕阅读器,因此**不声称「全站符合 WCAG」**;
> 未测 200% 缩放与强制高对比度;未做路由级代码分割(build 有单 chunk > 500 kB 警告,属独立性能议题)。
> 排在 W 线之后的 **X1 · 模型与凭据配置** 已裁定立项(见 docs/17)。

> **2026-10-14 前端收尾 W11 完成(docs/143)——W10 登记的遗留项清掉四项,并首次接入自动化 a11y 工具**:
> ①**路由级代码分割**:13 条路由静态 import → 动态,入口 chunk **569.62 → 65.94 kB**,build 的
> 「单 chunk > 500 kB」警告消失;首屏实测 **309.9 kB**(未压缩,`vite preview` 计响应体,非估算)。
> ②**两个详情抽屉同步 URL**(`?requirement=` / `?agent=`)——四个抽屉现已**全部**同步,「URL 是唯一真源」
> 从两页推广到四页;需求页因 `loadRequirement` 一次扇出 6 个请求,加了按 id 去重的 `ensureRequirementLoaded`。
> ③**200% 缩放(SC 1.4.4)/ 强制高对比度 / 文本间距(SC 1.4.12)三阶段实测**,13 条路由零违规、零水平溢出。
> ④**接入 axe 扫描器**(`axe-core@4.14.0` + `playwright@1.61.0` 两个 devDependency,
> `pnpm --filter @ai-se/web a11y`,13 路由 × 4 阶段;路由清单**从 router 反向提取**并断言 >= 10 条,
> 防「空扫描 = 永远通过」)。另采纳 W10 候选①:仪表盘 ①② 指标卡并排,1440×900 首屏 5 行不再差 15px。
>
> **扫描器首轮就查出 2 条 W1–W10 全程没发现的真实违规**——这是本阶段最主要的产出:
> `WorkflowsView` 两个筛选下拉是**无名控件**(axe `button-name`,**critical**):触发器是
> `<button role="combobox">`,而 ARIA 规定 combobox 的名称**只能来自 author**(不支持 name from content),
> 里头的「全部项目」根本不参与命名;顶栏搜索按钮的 `aria-label="全局搜索"` 与可见文字「搜索… ⌘K」
> 不符(axe `label-content-name-mismatch`,serious / SC 2.5.3),修法是**删掉 `aria-label`**、
> 让名称取自可见文字,再把该文字从 `hidden` 改成 `sr-only sm:not-sr-only` —— **顺带修掉一个更严重的
> 既有缺陷:原来那段文字在 `<640px` 是 `hidden`,窄屏下这个按钮根本没有名称**(实测确认),
> 是那个手写的 `aria-label` 一直在替它兜底。修复后复扫全绿。
>
> 门槛:`apps/web` **448/448** 全绿(+2 条深链接用例)、`a11y` 零违规、`build` 无警告;
> 全仓 typecheck / lint / test 全部 exit 0(**16 包 / 175 文件 / 1436 用例**,1434 → 1436)。
> **本阶段第一次把前端改动对着真实后端 + 真实浏览器验证**
> (W1–W10 全部用页面内注入的 `fetch` mock),18/18 通过。
> **诚实边界**:未测首屏 LCP 与压缩后传输量(因此不能说「首屏变快了」,只能说字节变少了);
> axe 未覆盖详情页数据态与弹窗/抽屉打开态(扫的是示例参数,落的错误态);未用真实屏幕阅读器走查;
> `docs/142` 把强制高对比度标为 SC 1.4.12 是**引用错误**(1.4.12 是 Text Spacing),本轮分开跑但未回改历史报告。
> **X1 的前置**:`packages/mcp/src/security/credentials.ts` 是 resolver 接口**而非 secret store**,
> 且只服务 MCP 作用域;LLM 的 API Key 仍是 `apps/server/src/config.ts:12` 的明文环境变量 ——
> **「密钥存在哪儿」必须在 X1 开工前先裁定**。

> **2026-10-15 前端遗留项收口 W12 完成(docs/144)——先逐条裁定,再四项一次做完**:
> **裁定是这一步的主要产出**(用户授权「把没做的事敲定一下」):W11 交付后留下 11 项待决,逐条判定为
> 「本轮做 4 项 / 判不做 3 项(附理由)/ 押后 2 项 / X1 前置 1 项(只裁定不动代码)」,裁定表见 docs/144 §一。
>
> **本轮做的四项**:①**5 个弹窗补可访问描述**(项目/需求/工作流/运行的新建框 + 部署的环境设置框):
> W10 只在 dev server 日志里发现 reka-ui 的 `Missing Description` 告警,当时留了两条候选;
> 本轮选「**补可见描述**」而不是「让告警闭嘴」——后者只是把「用户听不到上下文」变成「看不见」。
> 5 页 × 3 项真实浏览器实测全 PASS(含用 `[id="…"]` 反查 `aria-describedby` 指向的元素**真实存在**
> 且文本就是那条描述),告警在 5 个页面实测消失;`uiComponents.test.ts` 加护栏钉住
> 「每个 `<Dialog` 都必须带 description」+ 防空扫描计数断言。
> ②**删除零使用的 `showIcon`**(`StatusBadge`;默认值本就是 `true`、64 处调用全用默认值,
> 渲染输出逐字节不变)——与本仓 W4/W5/W7 三次「不造点不动的控件」同一判据。
> ③**`docs/142` SC 编号勘误**:「强制高对比度」被标成 SC 1.4.12,而 **1.4.12 是 Text Spacing**;
> 在 §3.2 表格后追加勘误引用块,**原判定与结论一字未动**(在已验证的历史报告上追加勘误,而不是改写结论)。
> ④**审批拒绝带修改意见**:核实后发现这**不是缺能力而是缺 UI** —— `ApprovalDecisionSchema` 有 `comment`、
> `WorkflowEngine.approve/reject(id, comment)` 会**落库**、`RequirementsView` 的关口 1 早就在用,
> 只有 `WorkflowsView` 的「拒绝」是裸的 `@click`。改走统一 `ConfirmDialog`(默认插槽装 textarea),
> `decide` 增 `comment` 参数与 `Promise<boolean>` 返回值;失败时**不关闭确认框**并把原因显示在框内
> (关掉它等于告诉用户「已经拒了」),而失败原因仍走既有的 `store.error` 通道,**没有新增第二条错误通道**。
> **批准保持一键不套确认框** —— 批准不需要理由,多一步纯摩擦。
> 三条刻意决定:「取消」按钮文案改「**关闭**」(工作流自己就有一个叫「取消」的生命周期动作,
> 与审批卡在同一个抽屉里同时可见,跳出来的确认框再来一个「取消」会让「取消什么」变歧义 ——
> 本页原有的护栏测试在改动的第一时间就因撞名而失败,**失败本身就是这个歧义的证据**);
> 无意见时用**两参调用**,因此批准路径的调用参数与改前逐字节一致,既有测试无需放宽;
> 待拒绝的审批**只存 id**,标题由 taskId 反查,不另存一份可能过期的副本。
>
> **本轮判不做的三项**:W6「最近项目→最近工作流」**保留现状**(正中 W6「从陈列改成分诊」的立意);
> `--input` 在 `--muted` 面 2.90:1 **不改只记文档**(改它会动 64 处已验证对比度,而自动配对扫描
> 会把祖辈背景算错,给的是虚假安全感);**420 个文件不合 Prettier 不做全量格式化** ——
> 决定性理由是**本仓没有 git**,`prettier --write .` 是不可回退的 420 文件改写,且 234 个在
> `packages/eval`(与前端线无关),属 `AGENTS.md` §2 禁止的无关重构。
>
> 门槛:`apps/web` **450/450** 全绿、`a11y` 零违规、`build` 通过;
> 全仓 typecheck / lint 全部 exit 0,test 按包复核 **16 包 / 175 文件 / 1438 用例**(1436 → 1438)。
> **一条保留**:全仓 `-r run test` 的**单次调用**出现过两次「一条时序敏感的服务端 e2e 失败」
> (两次是**不同的**文件:终止传播 FX-35、规划升级),两个文件单独复跑都通过、按包跑 227/227 ——
> 机器负载(你的后端正在跑真实任务)下的时序抖动,本阶段一行未碰 `apps/server` 与 `packages/*`,
> 但**没有去修它**(等待窗口是既有设计,调它属后端线,`AGENTS.md` §9 越界),留给后端线登记。
> 真实后端 + 真实 Chromium 走查 **30/30**;**走查只打开并关闭拒绝确认框,没有点「拒绝」**,
> 并用 API 复核该审批在服务端**仍是 `PENDING`**(证明未改动真实数据)。
> **诚实边界**:新增 6 句可见文案(5 句弹窗描述 + 1 句确认框描述)属内容变更,已逐条列出待过目;
> 弹窗首屏各多一行,是真实版式改动(小视口未量);拒绝的**失败态**未在浏览器里走查(造 500 需打断后端);
> `cancel-label="关闭"` 与 `Dialog` 的 X 按钮 `aria-label="关闭"` 同名,登记待判;
> axe 覆盖面扩展(数据态/弹窗态/抽屉态)与真实屏幕阅读器走查**押后**为独立批次。
>
> **X1 前置已裁定(docs/144 §七)**:核实确认 `docs/15` 说的「复用既有 Secret Provider」**无从复用** ——
> `MCPCredentialResolver` **零实现、零接线**,不接线的后果是 `RemoteMCPClient.ts:474` 对任何带
> `credentialRef` 的 server 直接抛 CONNECTION 错(fail-closed,行为正确);迁移里也**没有 secrets 表**。
> 三选一中推荐 **C · 内存态运行时覆盖**(env 提供默认值,控制台写入的 key 只活进程内存,
> 不落库/不落盘/不进日志,重启即失效)——它是唯一同时满足「运行时可改」与 §10「不得新增明文存储」的方案,
> 因为它根本不存储。建议 X1 拆三件事:先写 `envCredentialResolver` 并在组合根注入(让「既有 Secret Provider」
> 第一次真实存在)、再让 LLM 走同一条 resolver 契约、最后做前端设置页;**不新增 migration**。

> **2026-10-15 无障碍扫描器扩展 / 屏幕朗读转录 / X1 模型与凭据配置 W13 完成(docs/145)——把 W12 押后的两项与 X1 一批做完**:
>
> **动手前先核实的一件环境事实**:后端跑在 `tsx watch` 下(端口 3000 是 watch 进程的子进程),
> 这意味着改 `apps/server/src/**`、甚至只跑 `--filter @ai-se/server typecheck`(它会重建
> `packages/*/dist`)都会**自动重启你的真实后端**。当场核实:285 条工作流、3034 次运行**全部处于终态**
> (仅 1 条 `WAITING_APPROVAL`,那是等人不是等进程),重启不会打断任何执行;就此单独问过一次,
> 用户裁定「三项全做,允许重启」。
>
> **①axe 扫描器扩展 4 个阶段**:此前扫描器把每条 `:id` 换成全零 UUID,于是**每个详情页都是在错误态下被扫的** ——
> 真实渲染出来的表格行、详情字段、时间线、审批卡、抽屉,从来没见过扫描器。新增 `axe/data`(参数化路由改用
> **运行时发现**的真实 id,只读 GET,偏好挑 `WAITING_APPROVAL` 的工作流)、`axe/dialog-open`、`axe/drawer-open`、
> `axe/reject-confirm`;原有 5 个阶段的相位名/输出格式/退出码/反空扫断言**一字未动**。14 路由 × 9 阶段
> **零违规、零水平溢出**,各阶段实扫计数 `5/5/1/1` 就是证据本身(阶段失败会硬报错,不留「扫了 0 条却报通过」的假绿灯)。
> 两条关键自律:**发现失败不冒充数据态**(后端不可达时退回占位符并明确标注 `placeholder (未见真实数据)`,
> 该分支单独验过);**拒绝确认框阶段绝不提交决定**(只点抽屉里的「拒绝」打开确认框、扫、Esc 关,
> 再用只读 GET 前后比对三重断言 —— 确认框已隐藏 / 抽屉「拒绝」仍在 / 待审批集合不变 —— 那是用户的**真实**记录)。
>
> **②屏幕朗读转录**:新增 `a11yTree.mjs`(`corepack pnpm --filter @ai-se/web a11y:tree`)。
> `page.accessibility.snapshot()` 在 Playwright 1.61 里已不存在,改走 CDP `Accessibility.getFullAXTree`。
> 10 个状态(7 列表 + 1 真实数据详情 + 1 弹窗 + 1 抽屉)输出线性朗读顺序,并单独列出交互控件里
> 「名字为空 / 名字来自 placeholder」的项 —— **10 个状态的「命名问题」全部为 0**(检测器本身单独验过:
> 给它一个只有 placeholder 的 `<input>` 和一个无名 `<button>`,它确实报得出来,不是恒真的空扫描)。
> 一个具体的跨阶段收获:W12 补的弹窗描述**第一次以屏幕阅读器会念出来的形式被观察到** ——
> 树里是 `dialog "新建项目" (describedby=reka-dialog-description-v-2)` 紧跟
> `// desc: "项目是需求、工作流与部署的归属单位;仓库地址可以留空,之后在项目详情页绑定。"`。
> **必须说清楚**:转录是从无障碍树推导的,不是 VoiceOver/NVDA 的录音,**替代不了人耳** ——
> 它能证明「树是对的」,证明不了「念出来是顺的」。
>
> **③X1 的三件事**:先核实 `docs/15` 要求复用的「既有 Secret Provider」**仍然不存在**
> (`MCPCredentialResolver` 零实现、零接线),于是第一件事是**把它造出来**。
> **X1-a**:新增 `envCredentialResolver` 并在组合根注入 `RemoteMCPClient`
> (`secret:mcp/servers/github` → `MCP_SECRET_MCP_SERVERS_GITHUB`);映射结果**恒带 `MCP_SECRET_` 前缀**,
> 所以一个引用**无法点名任意环境变量**(`secret:../etc/passwd` 只会被压成同前缀的名字);
> 非 `secret:` 前缀一律不解析;全空白视为未配置(配错成空格比没配更隐蔽),有内容时**原样**返回不 trim
> (静默改掉一个密钥的值比让它失败更糟);未配置走既有 fail-closed 路径。它**只读进程环境变量**:
> 没有表、没有文件、没有第二套密钥体系。
> **X1-b**:新增 `ModelConfigService` 持有运行时可改的配置。**这里最容易踩空** ——
> `PersistentWorkflowTaskExecutor` 是**每个任务开始时**才 `createOpenAIChatModel({ ...llmOptions, sessionId })`,
> 它持有的是那个**引用**:返回新对象等于换掉引用,控制台改完配置也不会生效。所以服务改的是**同一个对象本身**,
> 有一条测试专门钉这个不变量。另外两条路径(planning 的模型、`AgentRunService` 的 provider)**只在启动时构造一次**,
> 用 `LiveLLMProvider`/`LivePlanningModel` 按配置版本号惰性重建;选包装器而不是把依赖改成工厂函数,
> 是为了**不改那两个服务的契约、也不动它们既有的测试**(`planningService` 的 `model` 依赖在 6 处测试里被构造),
> 且与组合根既有的装饰器文化一致。判据是「配置变更后**三条**模型路径行为一致」——
> 「有时候管用」比「完全不管用」更难排查。
> **X1-c**:新增 `/settings`(api + store + viewmodel + view)+ 侧栏「系统」组 + 命令面板条目
> (命令面板有一份显式页面清单,不补就与侧栏不一致)。四处刻意取舍:密钥框**永远是空的**
> (服务端从不回显,留空 = 不改动而非清除);**只发送真的改了的字段**(否则「打开页面→直接保存」
> 会把环境变量里的值原样写成运行时覆盖:值没变、来源却变成 `runtime`,一个看不见的假改动);
> 表单是**「未编辑时直接呈现服务端当前值」**而不是「ref + watch 回填」——后者在配置读回来之前表单是空的,
> 而空表单会被判定成「全改过」,手快一点就会把几个字段一起写成 `null` 等于清掉覆盖,加载完成前**只渲染骨架**;
> `provider` **保持只读**(部署级选择,改它要重新装配模型链路),且是 mock 时页面**明说**「改动要等切到 openai 才生效」。
>
> **凭据规则(§10)守住的四条**:读回对象**没有 `apiKey` 字段**(只有 `apiKeyConfigured` 布尔,有测试断言整个响应
> 文本里不含密钥值);校验失败**不返回** `parsed.error.flatten()`(请求体里可能有明文密钥,校验明细会把它的形状
> 带回响应与错误日志);密钥不落库/不落盘/不进日志;`ModelConfigService` 不持久化任何东西。
> **一处如实记录**:`apiTokenGuard` 默认是**关**的(本地 localhost 开发),所以 `PUT /api/model-config` 在默认
> 配置下**无需鉴权** —— 这是既有设计,本阶段沿用,没有为单个端点另造一套鉴权。
>
> 门槛:16 包 typecheck ✓ / lint ✓;`apps/web` **473/473** ✓(450 → 473)、`build` ✓、
> a11y **14 路由 × 9 阶段零违规** ✓;`apps/server` **244/244** ✓(227 → 244);
> 真实后端设置页只读走查 **20/20** ✓,并用 API 复核结束状态仍是 `source=env, overridden=[]`
> (证明这次走查**没有改动你的后端配置**);设置页另做独立 axe 检查,明/暗 × 1440/390 四个组合
> **零违规、零水平溢出**(顺带补上了 W12 登记过的「小视口未测」的其中一页)。
>
> **一条保留**:全仓 `-r run test` 的单次调用反复出现「一条时序敏感的服务端 e2e 失败」,
> **三轮七个文件全部不同**(finalSliceGovernance FX-13b、terminationPropagation FX-35、failureRecovery
> external CANCELLED、projects coding agent demo、mcpAppsApi TIMEOUT、workflowApi 两条 retry…),
> 逐个单独复跑**全部通过**(7/7、6/6、10/10、26/26)。三轮下来没有一个是重复的 —— 这是负载抖动的典型形态,
> 不是回归。**没有去修**:等待窗口是既有设计,调它属后端线(`AGENTS.md` §9 越界),留给后端线登记。
>
> **诚实边界**:①**浏览器 → API 的「保存」往返未在真实后端验过** —— 按既定边界走查是只读的
> (只验到 UI 的禁用条件、渲染与读路径);写路径本身由 supertest API 级测试覆盖(真实 Express 应用、
> 真实 zod 校验、真实错误处理),缺的只是「浏览器的那一次 fetch」;要补需要一次**可回滚的写入**
> (PUT 之后立刻 PUT 回 `null` 并复核 `source=env`),等用户发话。
> ②`apps/web` 的 lint 只覆盖 `src/**/*.{ts,vue}`,**不含 `scripts/`** —— 新增的两个脚本只跑了 prettier;
> 这是既有状况,本阶段**没有**扩大 lint 门禁(那是一次会影响所有人的配置改动)。
> ③MCP 凭据只能来自环境变量,设置页不管它;且库里 0 个 MCP server,所以它对真实数据的表现未被验证过。
> ④`/settings` 的移动端独立验过,但**弹窗描述的版式在窄视口下仍未量过**(W12 Known Issue 2 的延续)。
> ⑤转录是**快照**,含真实数据,数据一变就过时,不是门禁。
> ⑥**发现一处文档与代码不一致**:工作流页的弹窗触发按钮是「新建工作流」、弹窗标题才是「创建工作流」,
> 已按**代码**取词并把两者在脚本里分开(照字面点会得到永久的假失败「触发器缺失」)。
>
> **裁定关闭一项(2026-10-15,用户「不做这个」)**:真实屏幕阅读器走查(VoiceOver / NVDA)。
> 本项自 W11 起以「未做 / 押后」的形式被承接了两轮,现**关闭**,不是「押后」——
> 后续阶段的「未做事项」清单不再列它。放弃的覆盖面照录:转录能证明「无障碍树结构正确、
> 每个控件都有像样的名字」,证明不了 ①念出来顺不顺耳、有没有歧义;②动态插入的内容
> (**尤其是表单提交失败的提示**)有没有被播报;③焦点走向(开弹层后落在哪、关掉后回哪、报错后跑哪);
> ④不使用眼睛能否真的走完任务。其中 ② 在本仓有**具体候选**:`ProjectsView` / `SettingsView` /
> `ProjectDetailView` / `MCPServerDetailView` 的表单错误提示是普通 `<p class="text-danger">`,
> **不是 live region**,提交失败时很可能什么都听不到。**该项不修** —— 它不属于 WCAG A/AA 的失败项,
> 且验收手段正是被关闭的这一项。**因此本仓不声称「全站对屏幕阅读器可用」**,只声称
> 「axe 在 14 路由 × 9 阶段零 WCAG A/AA 违规」与「无障碍树结构可审阅」(与 W9/W10 的限定口径一致)。

---

> **2026-10-23 功能清点 T1（`docs/231` 清点表，执行记录 `docs/232`）**：用户「都按推荐值，从 T0 备份开始」
> 完成 T0（8.3 MB 全仓归档 + 还原演练逐字节一致），再「开始 T1」完成移除。
> **改动 3 个包**：删除 `packages/failure-recovery`（生产 381 + 测试 363 行）、
> `apps/server` 的 `actionRecoveryExecutor.ts`（292 行）与 `failureRecovery.e2e.test.ts`（1,034 行），
> 合计 **2,070 行**；`apps/server/package.json` 摘除三条引用；清理三处陈旧 `dist` 产物；README 口径改写。
> **关键边界**：`FailureRouter` 是 `workflow-engine/src/types.ts:146` 自己的类型，删包**不动引擎**——
> 只删掉这个接缝的一个实现者，爆炸半径最小。
> **门禁**：全仓 `typecheck` 0 / `lint` 0 / `test` **1922/1922 通过，15 个包全绿**（包数 16 → 15）。
> **读数变化已预先声明**：1944 → 1922 = **−26 删除 + 4 记账差**（`docs/230` §8 记的 `web` 505 早于
> `fileDropzone.test.ts` 的 4 例，现为 509），**无一条用例从通过转为失败**。
> **抖动**：三次 e2e 失败均已逐次定位（超时 / `socket hang up`），单独复跑全过，静置后全仓全绿。
> **平台**：重启 `17:08:08` 晚于最后产物 `17:02:46`，`/health` 200。

---

> **2026-10-23 功能清点 T2（MCP 工具联邦接入；清点表 `docs/231` §3，执行记录 `docs/232`）**：用户「开始 T2」。
> **两条前提被实测推翻，先纠后做**：①`docs/231` §3.3 裁定的 `mcp.<server>.<tool>` 在模型 API 上直接 400
> （`^[a-zA-Z0-9_-]+$` 硬约束，点号实测失败、双下划线实测通过）→ 用户再裁定改为 **`mcp__<server>__<tool>`**；
> ②`mcp_tools.enabled` 建表默认 FALSE 且**全仓没有启停入口**，可见性又是
> `serverEnabled && projectBound && agentBound && toolEnabled && policyAllowed` 的 AND
> —— 不补开关，接上注入点也永远调不到工具。
> **改动 4 个包**：`packages/shared`（`CreateMCPServerSchema` / `UpdateMCPToolSchema`）、
> `apps/server`（`mcpService.createServer` / `setToolEnabled`、`POST /api/mcp/servers`、
> `PATCH /api/mcp/servers/:id/tools/:toolId`、**新增** `mcpTaskToolSource.ts`、执行器 `mcpTools` 依赖与快照注入、
> 组合根 MCP 装配上移）、`apps/web`（添加服务器对话框、工具启停、表单 ViewModel）。
> **注入语义**：每任务一次快照、命名空间、上限 20（超出按「点名具体工具」优先排序后截断并发事件）、
> 取不到工具不阻断任务但发 `mcp_tools_unavailable`。
> **测试**：server +16 例（真实 registry + 内存 store，仅 MCP 客户端为假）、web +8 例。
> **未做**：运行中的端到端（添加服务器是写操作，超出既有只读边界），留到 T5。

---

> **2026-10-23 功能清点 T3（浏览器取证；清点表 `docs/231` §4，执行记录 `docs/232`）**：用户「开始 T3」。
> **硬阻塞已解**：`playwright@1.61.0` 从 `@ai-se/browser` 的 devDependencies 移入 dependencies
> （`@playwright/test` 留 dev），锁文件已核对。
> **关键发现**：视觉修复闭环缺的不是 VLM（网关实测接受图片输入，HTTP 200），是**参照侧（设计稿）**
> —— 产品没有上传入口，`VisualSpecification` 在生产代码里零产出。硬接会得到一条永远卡在「比较」的路径。
> **因此只接取证那一半**：`visualEvidenceService` 在任务 SUCCESS 且写过 UI 文件时，
> 用真实 Chromium 以 `file:` 打开入口页（该会话 allowlist 只有 `file`），等渲染稳定后截图，
> 连同控制台/网络错误计数落进 `agent_artifacts`（`GENERATED_FILE` + `metadata.kind = "ui_screenshot"`，
> 不为一条证据行加迁移），并发 `visual_evidence_captured` / `visual_evidence_unavailable` 事件。
> **降级口径**：无 UI 交付物 / 无入口页 / 浏览器起不来 ⇒ `unavailable`，不判失败也不静默通过；
> 截图是附加证据，验证门判据一字未动。
> **测试**：9 例，其中 1 例用真实 Chromium 渲染临时页面并截出非空 PNG。
> **未做**：视觉修复闭环（缺参照侧，待裁定）、DOM 断言、运行中端到端。

---

> **2026-10-23 功能清点 T4（三条缺陷，`docs/231` §8 / `docs/232`）**：用户「然后开始 T4」。
> **N-37**：任务状态机新增显式的 `RUNNING → RETRYING` **崩溃恢复边**；`WorkflowEngine.recover()`
> 现在对每个 RUNNING 任务先 `assertTaskTransition` 再落库（此前是全仓唯一绕过状态机的写入）；
> `recoverRunningTasks` 同时 `retry_count + 1`——进程反复崩溃不再能无上限地重新排队。
> **N-39**：`/health` 暴露运行时 `verificationGate`；`l1-m4v-e1-x3.sh` 起跑前断言它与
> `EXPECTED_GATE`（默认 enforce）一致，不符 `exit 5` 且不花配额。
> **N-40**：`taskAcKeys` / `sliceAcKeys` 上移到 `@ai-se/shared`（唯一口径）；
> `TaskContextBuilder.acceptanceScope` + 执行器提示词把本任务的 AC 编号交给 agent——
> 此前门按 `[AC-xx]` 选测试、编号却从没告诉过 agent，选取恒为零。
> **测试**：`shared` +5、`workflow-engine` +2、`database` +1（真 PG）、`server` +6。
> **未验证**：N-40 的效果（模型是否据此写标记）与 N-37 的真实崩溃行为，都随 T5 的真实运行。

---

> **2026-10-23 N-43 · 骨架先行契约（用户「先加骨架约束，再重跑回归」）**：
> 第三次回归的失败在库里有一个确定性形状——`S1-T01`（BUILD）的 7 条 AC 全部只描述 `package.json`
> 字段，agent 就只写了 `package.json` 一个文件；门按 BUILD 跑 `pnpm build`，而 `scripts/build.js`
> 属于五个任务之后的 `S1-T06`，于是首任务**在计划层面就不可能通过**，两轮 DEBUG 也补不回来。
> **契约**：首个切片的骨架任务必须**真正实现**它声明的每个脚本，而不只是声明名字。落地为
> `validateSkeletonPlan.ts`：确定性补齐「`pnpm run <s>` 真实实现且退出码 0」的 AC
> （`PLAN_AUTOFIXED` / `skeleton-script-ac`，不改任务图、不改 AC 编号映射），并拦「同一脚本两个
> 提供者」（`SKELETON_SCRIPT_MULTIPLE_PROVIDERS`）；`isFirstSlice` 由 `slice_order` 判定，
> 单级规划与后续切片行为逐字不变。提示词同步写明契约。
> **边界**：约束只保证「计划不再自相矛盾」，agent 是否据此补齐产物，要靠这一轮回归的读数。

---

> **2026-10-25 N-49 · 切片边界补真实进程冒烟（用户「修 N-49，修完再跑一遍回归」）**：
> 第六次回归里 slice-auth-persistence 判 DONE、边界检查 `passed`（作用域 AC-01..AC-13），同一时刻
> `GET /api/register` 是 404——交付的是「模块 + 单元测试」，没人把路由挂进服务器；项目自己的 136 条
> 测试里 135 条是绿的（它们直接调 handler，不启动服务），只有 oracle 这个黑盒能看见。
> **机制**：切片边界新增独立检查 `server-smoke`——用项目声明的 `start` 脚本起真实进程，再按本切片
> 验收标准里**点名**的路由打一遍 HTTP；业务路由全部 404 判 `SURFACE_UNMOUNTED`，进程起不来判
> `BOOT_FAILED`。健康端点只证明进程活着、带占位符的路由对未知资源 404 合法、缺依赖/无网属环境问题
> ——三者都不参与判定，连同探针自身出错一并记进 `verification.smokeSkipped`，不静默。
> **取舍**：路由只从 AC 文本抽，不按 FR 编号猜 REST 形状（猜出来的路由会把门的假设变成失败依据）；
> 起进程与探测必须在同一条沙箱命令内完成（每条命令都是新容器）。
> **测试**：`serverSmoke.test.ts` 18 例（含两例真实进程）、`taskVerifier.test.ts` +2 接线；
> 真实 `ai-se-sandbox:22-pnpm9`（`--network none`）两个方向手工核对。
> **未验证**：效果要靠第七次回归的读数。

---

> **2026-10-25 N-50 · 边界检查的自引用盲区（第七次回归后归因，未修）**：
> 第七次回归 oracle 从 2/29 升到 **16/29**（认证切片 AC-01..AC-13 全绿，S1 真的把注册/登录/令牌挂上了），
> 但 N-49 的 `server-smoke` 一次没跑：`SLICE_BOUNDARY_CHECKED` 0 条、`ai-se-smoke` 工具调用 0 次。
> **S2** 是工作流 FAILED、切片未收敛（按设计跳过，不算缺陷）；**S1 工作流 SUCCESS 却同样没跑**，这是缺陷：
> `S1-T5`(REVIEW) 失败 → `S1-T5-REPLAN-1` 成为解决者并成功，而验证这个解决者时它自己还是 `RUNNING`，
> `isFailureResolved` 沿 `resolvedByTaskId` 走到它、见「非 SUCCESS」即判源任务未解决，于是
> `pendingSiblings` 非空、边界检查不触发。这是 N-35 同族缺陷的自引用残留。
> **普查**：近 20 天 126 个切片拿到边界检查，9 个因这条原因没拿到。
> **影响**：`server-smoke` 与边界检查共用触发点 ⇒ N-49 的端到端验证被它挡住。修法待开工授权。

---

> **2026-10-25/26 N-49 + N-50 的实测读数（第八次回归）**：
> 三次尝试后取第三次：slice-1 / slice-2 / slice-3 **连续 DONE**（此前最多两个，且 slice-1 从未完成过），
> slice-4 卡在**任务规划 600s 超时**，夹具中止 —— 因此**没有 oracle 读数**。
> **N-49 正向成立**：`server-smoke` 第一次在真实批次执行，两个切片各跑一次、**都通过**，没有误判；
> 另一个切片因计划没把业务路由写进 AC 而以 `no-routes` 留痕跳过（设计内）。
> **N-50 仍未在真实批次复现其形状**：三个收敛切片的最后一个任务都是原始任务，不是「失败任务的解决者」。
> **观察（未归因）**：今天切片任务规划连续四次卡住（三次超时、一次模型输出非法 JSON），每次都会
> 中止整个夹具、前面的切片白跑。下一步查「超时后有没有重试」与「600s 预算从哪来」。

---

> **2026-10-26 N-51 的实测读数（第九次回归）**：slice-1 **DONE、9/9 全绿**（`server-smoke` 与边界检查
> 都跑过并通过），slice-2 规划**超时三次**后转终态、夹具中止。
> **三个修复各自得到读数**：F4 —— 三次失败都记成 `timed_out`/`TIMEOUT_ERROR`（旧代码是 `PLANNING_ERROR`）；
> F1 —— 前两次超时自动建升级审批并重试（harness 自动批准），**修复前第一次超时就会掐掉整轮**；
> F3 —— 三次 run 只有 424–435s，900s 不是约束，**真正的卡点是 `task_planning` 阶段预算 150s×2**，
> 同一阶段六次尝试全部卡在 150s。
> **下一个卡点（未修）**：建议给 `task_planning` 单独一档预算（如 300s），其余阶段维持 150s。

> **2026-10-26 跑前自检的读数（全库普查，`docs/232` §9.26）**：判死规则 `SURFACE_UNMOUNTED` 的输入
> 来自对 AC 自然语言的抽取，此前只用一批切片的样本验过——把生产抽取函数喂进**全库 1901 条含路径的
> AC 文本 / 133 个切片**后，抽出 **24 条不同路由，形状全部像真路由**（非 `/api` 的 10 条全是显式方法
> 写法），但发现一个真误判：裸 `/api`（挂载点）与 `/api/*`（通配）都被当成端点，`S1-foundation`
> 切片的业务路由因此**只有 `GET /api` 一条**，一条 404 即可判死整个切片。修法（N-54）后：不同路由
> 24 → 23、抽出业务路由的切片 65 → 64、含 `GET /api` 的切片 5 → 0，**真实路由一条没丢**。
> 结论：**这类缺陷只有普查能发现，样本测试发现不了**；后续每轮开跑前按 §9.26 的清单第 3 条对本轮
> 真实 AC 复算一次。

> **2026-10-26 第十一次回归的读数（`docs/232` §9.27）**：**oracle E1 29/29 全过**——第七次回归之后
> 第一次拿到端到端读数，且是满分；slice-1/2 均 DONE（13/13、10/10），slice-3 因 `T7` 连败 3 次 FAILED。
> 判定为 **假阴性 1**（自报失败、oracle 通过）。根因 **N-55**：验证门在**被沙箱截断到最后 96KB** 的
> stdout 上判 AC 覆盖——完整输出 137KB 能解析到 30 个 AC，截断后只剩 15 个，排在前面的 AC-24/25/26/29
> 被判「未覆盖」，而同一条检查 `exitCode 0`、258/258 全绿。**产品侧不欠账，门侧欠一次修复。**

> **2026-10-26 N-55 修复的读数（`docs/232` §9.28）**：两处一起改——(a) 覆盖判定先问「输出是否被截断」
> （TAP 的 `# tests N` 对比实际结果行数，不依赖沙箱常量），被截断时按退出码裁决并记
> `coverageTruncated`；(b) 脚本自带位置参数时改写调用，标志排到位置参数之前，并用探测到的文件替换 glob。
> **真实 E1 工作区 A/B**：258 用例 / 137KB（被截断到 96KB、只能解析 15/30 个 AC）→ **25 用例 / 5.7KB、
> 25/25 通过、exit 0、0 cancelled、10.5s**，四个作用域 AC 全部可解析。只修标志而不换文件时实测
> **19 个兄弟文件钩子超时、命令 60s**——这一半不能省。

> **2026-10-26 第十二次回归的读数（`docs/232` §9.29）——本阶段第一次走完整条链**：五个切片 **全 DONE**、
> oracle **29/29**、**链完成率 100%**、**真交付成功率 100%**、**staging 段 100%**（`ci_runs` 22:00:00
> SUCCESS；`deployments` staging 22:00:09 / production 22:00:19 SUCCESS）。N-55 修复实测通过：全轮零
> `uncoveredAcKeys`、零 `coverageTruncated`。
> **同时暴露一个记账口径问题（待裁定）**：summary 的「自报成功率 0%」与「五片全 DONE」矛盾——
> `collectTaskMetrics`（`packages/eval/src/harness.ts:78`）把**已被 replan 替代的失败祖先行**也算进去；
> 而 `falseNegative` 定义是 `oracle.passed && !chainCompleted`（`:971`），本轮链完成故为 0，自洽。

> **2026-10-27 N-56 修复（`docs/232` §9.30）**：判自报成功时沿 `resolvedByTaskId` 走到成功后继的失败行
> 不计入（多跳；链断或解决者未成功仍按失败计）。**真实数据 A/B**（第十二次回归五个工作流 54 行：
> SUCCESS 50 / FAILED 4）旧规则 **false** → 新规则 **true**，四条失败链均直达成功后继；API 已确认
> 返回 `resolvedByTaskId`。eval 门禁 68/68。按要求未跑新回归。

> **2026-11-02 F1 阶段边界（历史；2026-11-04 round20 已正式通过，见 `docs/17` F1 / `docs/242`）**：当时本阶段只做「前端端到端验收」，不扩后端能力面、不做多框架、不做
> mock↔真实后端的 conformance。**已达成**：五条通过条件里的 1–4（夹具与 oracle 的判真判假能力）
> 与「切片走通」（round 12：五片全绿、零失败任务、oracle 24/24）。**未达成**：CI / staging deploy /
> staging verify 三段走通（`stagingSegment` 仍为 `-/-/-`）、连续多轮全链完成的稳定读数。
> **阶段内缺陷** N-57 … N-73 全部已修，其中 N-63 / N-67 / N-70 / N-72 / N-73 的批次级读数待一轮
> 完整回归（判据逐条见 `docs/232` §10）。**下一阶段的开工条件**：交付三段跑绿 + 至少两轮连续
> 全链完成且假阴性为 0。
