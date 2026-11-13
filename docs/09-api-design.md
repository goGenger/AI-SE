# API Design

采用 REST + SSE。

## Project

```text
POST /api/projects
GET /api/projects
GET /api/projects/:id
PUT /api/projects/:id/repository
DELETE /api/projects/:id
```

`PUT /api/projects/:id/repository`（UX-01）：绑定或替换既有项目的 Git 仓库。请求体是 `{ repository }`（`.strict()` 信封，`repository` 为必填的合法 URL，最长 500）——**没有 null 解绑形式**。之所以单开这条接口，是因为创建时 `repository` 是可选的（项目可以先工作区起手，见 `CreateProjectSchema`）。

## Workflow

```text
POST /api/workflows
GET /api/workflows
GET /api/workflows/:id
POST /api/workflows/:id/start
POST /api/workflows/:id/pause
POST /api/workflows/:id/cancel
POST /api/workflows/:id/resume
POST /api/workflows/:id/retry
PATCH /api/workflows/:id/policy
GET /api/workflows/:id/tasks
GET /api/workflows/:id/events
GET /api/workflows/:id/graph
GET /api/workflows/:id/approvals
GET /api/workflows/:id/trace
GET /api/workflows/:id/stream
```

`GET /api/workflows/:id/trace` 是阶段 7 的 7-C（`docs/150`）：只读派生
`Workflow → Task → AgentRun → ToolCall`（部署挂在其任务下），响应是统一 JSON 信封。

## Agent Run

```text
POST /api/agent-runs
GET /api/agent-runs
POST /api/agent-runs/coding-demo
GET /api/agent-runs/:id
POST /api/agent-runs/:id/cancel
GET /api/agent-runs/:id/events
GET /api/agent-runs/:id/stream
```

`POST /api/agent-runs/coding-demo`（`RunCodingAgentSchema`）：演示用的快捷入口，用一个内置任务文本起一次 Coding Agent 运行。它不是通用创建路径——常规运行由工作流任务驱动。

## Requirement Planning

```text
POST /api/projects/:projectId/requirements
GET /api/projects/:projectId/requirements
GET /api/requirements/:id
POST /api/requirements/:id/analyze
GET /api/requirements/:id/specifications
GET /api/requirements/:id/tasks
GET /api/requirements/:id/slices
GET /api/requirements/:id/acceptance-criteria
GET /api/requirements/:id/traceability
GET /api/tasks/:id
GET /api/tasks/:id/dependencies
```

`POST /api/requirements/:id/analyze` 异步返回 202，并通过已有 Agent Run / Workflow Event / SSE 机制观察进度。

`GET /api/requirements/:id/slices`（N2）：需求页的切片视图——切片列表 + 待确认的关口 1 审批。`GET /api/requirements/:id/acceptance-criteria`：验收标准视图。两者都走统一 JSON 信封，需求不存在时 404 `REQUIREMENT_NOT_FOUND`。

`GET /api/requirements/:id/traceability`（C-5 / N5）：追溯表。**默认走统一 JSON 信封；`?format=markdown`（或 `md`）时改回 `text/markdown`**——与 `/api/metrics` 同类，是少数不走 JSON 信封的端点之一。

## Approval

```text
POST /api/approvals/:id/approve
POST /api/approvals/:id/reject
```

## Professional Agents

```text
GET /api/agents
GET /api/agents/metrics
GET /api/agents/:name
```

返回 Registry Definition、权限摘要、最近 AgentRun、Artifact 和从真实持久化数据聚合的 Evaluation 指标。

## Observability

```text
GET /api/metrics
```

Prometheus 文本格式（`text/plain; version=0.0.4`）——**不是**统一 JSON 信封；挂在 `/api` 之下，继承 `apiTokenGuard`。导出 `docs/12` 的九项指标（五项复用 `AgentEvaluationMetrics` 的口径，四项由聚合查询派生）。实现与验收见 `docs/149`。

## Delivery

```text
GET /api/deployments
GET /api/deployments/:id
POST /api/deployments/:id/rollback
GET /api/environments
PUT /api/environments
```

Deployment 创建由 Workflow 的 delivery Task 触发；Controller 不直接执行 Docker。Production DEPLOY 必须先通过现有 Approval API。

API 层只负责鉴权、参数验证、调用 Application Service 和事件流，不把 Agent Loop 写在 Controller 中。

## Evidence

```text
GET /api/evidence
GET /api/evidence/:id
```

只读的证据存档（`evidence_records`）。列表接受可选过滤 `projectId` / `workflowRunId` / `taskId` / `toolCallId` 与 `limit`（1–200）；详情接受可选 `projectId` 作为项目范围限定。两者都走统一 JSON 信封，参数不合法时为 400 `VALIDATION_ERROR`。证据正文在写入侧已脱敏（`packages/evidence` 的 redact）。

## MCP API Addendum

### 当前 Console API（5.5-5）

5.5-5 只暴露查询与 Binding 管理面：

```text
GET    /api/mcp/servers
GET    /api/mcp/servers/:serverId
GET    /api/mcp/servers/:serverId/tools
GET    /api/mcp/servers/:serverId/bindings
POST   /api/mcp/servers/:serverId/bindings
PATCH  /api/mcp/bindings/:bindingId
DELETE /api/mcp/bindings/:bindingId
```

后端 Registry 本身具备 Server 注册、启停、connect/disconnect、refresh 等能力，但这些不全部属于 5.5-5 Console UI/API 验收范围。

### MCP Apps（5.5-7）

```text
GET  /api/mcp/servers/:serverId/ui-apps
GET  /api/mcp/servers/:serverId/ui-resource
POST /api/mcp/apps/actions
```

### Boundary

```text
Vue Console / MCP App iframe
        ↓
AI-SE Backend API
        ↓
Application Service / MCP Registry
        ↓
ToolRuntime
        ↓
MCP Adapter
        ↓
MCP Server
```

禁止：

```text
Browser → MCP Server
Browser → MCP SDK
Agent → MCP Server
Agent → MCPClientPort
```

不存在 MCP JSON-RPC / `tools/call` 浏览器代理端点。

## Model & Credential Configuration（W13 / X1）

```text
GET    /api/model-config    读回当前模型配置（**不含密钥值**，只有 apiKeyConfigured 布尔）
PUT    /api/model-config    写入运行时覆盖；字段传 null = 清除该字段的覆盖、回落到环境变量
```

读回对象**没有** `apiKey` 字段 —— 明文密钥不得进入 Response / Log / State（AGENTS.md §10），
所以「读回」这条路径不存在一个可以放它的位置。运行时覆盖只活在进程内存里：不落库、不落盘、
不进日志，重启后端后回落到环境变量。`provider`（`mock` / `openai`）是部署级选择，不在可改
字段之列 —— 改它要重新装配整条模型链路，不是一次表单保存能承担的事。

凭据侧还有一处接线：`RemoteMCPClient` 现在注入了 `envCredentialResolver`（`packages/mcp`
的 `MCPCredentialResolver` 在此之前**只有类型、零实现**）。它把 `secret:mcp/servers/github`
这类引用映射到环境变量 `MCP_SECRET_MCP_SERVERS_GITHUB`；解出来的值只交给构建请求头的代码，
不进日志、不进 State、不回显，未配置时由客户端既有的 fail-closed 路径抛 CONNECTION 错。
它**不读进程环境变量以外的地方**：没有表、没有文件、没有第二套密钥体系。

