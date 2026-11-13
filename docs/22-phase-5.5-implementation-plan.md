# Phase 5.5 Implementation Plan

> 本文是给 Coding Agent / AI Coding Agent 使用的实施规格。
>
> **每次只执行一个 Sub-phase。完成后必须停止，不得自动进入下一阶段。**

## 0. Global Rules

### Architecture

必须遵守：

```text
Agent
 ↓
AI-SE Tool Runtime
 ↓
MCP Adapter
 ↓
MCP SDK
 ↓
MCP Server
```

禁止：

```text
Agent → MCP Client
Agent → MCP Server
Agent → External API
```

### Reuse

必须复用已有：

- ToolDefinition
- Tool Registry
- Tool Runtime
- Permission
- Risk
- Approval
- Audit
- Timeout
- Cancellation
- Error Classification
- Secret Redaction
- Sandbox

禁止建立平行系统。

### Execution Discipline

每个 Sub-phase：

1. 阅读现有代码。
2. 阅读本阶段相关 docs。
3. 找到已有能力。
4. 做最小实现。
5. 编写测试。
6. 运行 lint。
7. 运行 typecheck。
8. 运行 unit/integration test。
9. 运行必要 regression。
10. 输出报告。
11. **停止。**

不得自动开始下一个 Sub-phase。

---

# 5.5-0 Contract Freeze

## Goal

冻结 MCP 接入边界，不实现真实 MCP 网络能力。

## Inspect

必须先找到：

```text
ToolDefinition
Tool Registry
Tool Runtime
Permission
Approval
Audit
Agent-visible Tool Discovery
ToolExecutionContext
```

## Define

```ts
interface MCPClientPort {
  connect(server: MCPServerDefinition): Promise<void>;
  disconnect(serverId: string): Promise<void>;
  listTools(serverId: string): Promise<MCPToolDefinition[]>;
  callTool(
    serverId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<unknown>;
}

interface MCPToolAdapter {
  execute(
    input: unknown,
    context: ToolExecutionContext
  ): Promise<ToolResult>;
}
```

## Data Model Design

只设计：

```text
mcp_servers
mcp_tools
mcp_tool_bindings
```

## Test Contract

准备可控 Mock MCP Server：

```text
echo
slow
failing
```

用于后续测试。

## Forbidden

- HTTP
- OAuth
- Resource
- Prompt
- MCP Apps
- Console
- Agent direct integration
- 第二套 Tool Runtime

---

# 5.5-1 Local MCP Tool

## Goal

只实现本地 stdio MCP。

## Implement

必须完成：

1. MCP Client lifecycle
2. initialize
3. tools/list
4. tools/call
5. disconnect
6. error normalization
7. cancellation

使用官方 MCP SDK，不自行实现 MCP protocol。

## Mock Server

```text
echo(input) → input
slow() → delayed response
failing() → controlled error
```

## Tests

至少：

```text
connect
initialize
listTools
callTool success
callTool error
disconnect
cancellation
```

## Forbidden

- Tool Runtime integration
- DB persistence
- HTTP
- OAuth
- Resource
- Prompt
- Apps
- Console
- Agent integration

---

# 5.5-2 Tool Runtime Integration

## Goal

让 MCP Tool 成为现有 Tool Runtime 的一种 Tool Source。

## Required Path

```text
Agent
 ↓
Tool Runtime
 ↓
Schema Validation
 ↓
Permission
 ↓
Risk
 ↓
Approval
 ↓
Timeout / Cancellation
 ↓
MCP Adapter
 ↓
MCP Server
 ↓
Result
 ↓
Audit
```

## Critical Tests

### Success

MCP Server 正常收到 call。

### DENY

```text
Tool Runtime → DENY
```

必须断言：

```text
MCP Server request count === 0
```

### Approval

HIGH/CRITICAL Tool：

```text
WAITING_APPROVAL
```

批准后才允许请求。

### Timeout

slow tool 超时后：

- Tool Call 状态正确
- 请求被取消/终止
- 错误归类为 TIMEOUT

### Cancellation

AbortSignal 必须能够贯穿 Tool Runtime → MCP Adapter。

### Audit

必须记录：

```text
toolCallId
mcpServerId
mcpToolName
transport
riskLevel
status
duration
errorType
```

### Forbidden

- Registry
- DB
- Remote HTTP
- OAuth
- Console
- Resource
- Prompt
- Apps

---

# 5.5-3 Registry & Persistence

## Goal

把 MCP Server / Tool / Binding 纳入平台持久化。

## Tables

### mcp_servers

```text
id
name
description
transport
endpoint
command
args
status
enabled
auth_ref
credential_ref
created_at
updated_at
last_connected_at
last_error
```

### mcp_tools

```text
id
mcp_server_id
name
description
input_schema
enabled
risk_level
requires_approval
created_at
updated_at
```

### mcp_tool_bindings

```text
id
project_id
agent_id
mcp_server_id
mcp_tool_id
enabled
created_at
updated_at
```

## APIs

```text
GET    /api/mcp/servers
POST   /api/mcp/servers
GET    /api/mcp/servers/:id
PATCH  /api/mcp/servers/:id
DELETE /api/mcp/servers/:id
POST   /api/mcp/servers/:id/connect
POST   /api/mcp/servers/:id/disconnect
POST   /api/mcp/servers/:id/refresh
GET    /api/mcp/servers/:id/tools
PATCH  /api/mcp/tools/:id

GET    /api/projects/:projectId/mcp-bindings
POST   /api/projects/:projectId/mcp-bindings
DELETE /api/projects/:projectId/mcp-bindings/:id
```

## Visibility

只有满足：

```text
Server enabled
+ Project binding
+ Agent binding
+ Tool enabled
+ Policy allowed
```

的 Tool 才能进入 Agent-visible Tool List。

## Tests

- CRUD
- enable/disable
- connect/disconnect
- discovery persistence
- binding
- visibility filtering
- duplicate protection
- deny-by-default

---

# 5.5-4 Remote MCP & Auth

## Goal

增加 Streamable HTTP Remote MCP。

## Implement

- HTTPS transport
- connection lifecycle
- reconnect
- degraded state
- timeout
- cancellation
- authRef
- credentialRef
- Secret Provider integration

## Security

凭据不得进入：

```text
Prompt
Agent State
Task
Workflow Event
Tool Result
Logs
Git
```

## Forbidden

- 自建 OAuth Provider
- marketplace
- auto-install
- arbitrary credential forwarding

---

# 5.5-5 MCP Console

## Goal

增加最小可用 MCP 管理界面。

## Pages

```text
Settings
  └── MCP Servers
       ├── List
       ├── Detail
       ├── Connection Status
       ├── Tools
       └── Bindings
```

## Actions

- register
- enable/disable
- connect/disconnect
- refresh
- view tools
- view risk
- manage bindings
- view last error

## Boundary

```text
Vue
 ↓
AI-SE API
 ↓
MCP Service
 ↓
Tool Runtime
 ↓
MCP Adapter
```

Browser 不得直接连接 MCP Server。

---

# 5.5-6 Resource & Prompt

## Resource

实现：

```text
resources/list
resources/read
```

## Prompt

实现：

```text
prompts/list
prompts/get
```

Resource / Prompt 使用独立 Adapter。

禁止：

```text
Resource → ToolDefinition
Prompt → ToolDefinition
```

除非平台明确建立语义转换层。

权限、审计和 secret policy 仍然复用平台已有治理。

---

# 5.5-7 MCP Apps

## Goal

实验性接入 MCP UI Resource。

## Architecture

```text
MCP UI Resource
      ↓
Sandboxed iframe
      ↓
Host Bridge
      ↓
AI-SE Controlled Action
      ↓
Tool Runtime
```

## Security

MCP App 不得：

- 访问 host filesystem
- 获取 host credential
- 任意调用 MCP Server
- 绕过 Tool Runtime
- 直接执行 host command

## Acceptance

至少验证：

- UI 能加载
- iframe 隔离
- Host Bridge action
- Tool Runtime permission
- audit
- credential isolation

---

# 5.5 MVP Gate

MVP 只要求：

```text
5.5-0
  ↓
5.5-1
  ↓
5.5-2
  ↓
5.5-3
```

必须完成：

```text
MCP Server
 ↓
tools/list
 ↓
Tool Registry
 ↓
Project/Agent Binding
 ↓
Agent-visible Tool
 ↓
Tool Runtime
 ↓
Policy
 ↓
Approval if required
 ↓
MCP Tool Call
 ↓
Audit
```

并通过：

- success
- deny with zero remote requests
- approval
- timeout
- cancellation
- audit
- secret redaction
- existing Native Tool regression

---

# Final Coding Agent Report

完成每个 Sub-phase 后必须输出：

```text
Sub-phase:
Status:

Modified Files:
- ...

Architecture Changes:
- ...

New Dependencies:
- ...

Database Changes:
- ...

API Changes:
- ...

Tests:
- Unit:
- Integration:
- E2E:

Lint:
Typecheck:

Regression:
- Native Tool:
- Agent Runtime:
- Workflow:
- Existing tests:

Acceptance:
- [x] ...
- [ ] ...

Known Issues:
- ...

Deferred:
- ...

STOP:
Do not continue to next Sub-phase.
```
