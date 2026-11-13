# MCP Integration

## 1. Purpose

MCP（Model Context Protocol）在 AI-SE 中用于统一接入外部工具与能力。它是 Tool Federation Layer，不是 Agent Runtime、Workflow Engine 或权限系统。

## 2. Architecture

```text
Agent
  ↓
ToolRuntime
  ↓
MCP Adapter
  ↓
MCPClientPort
  ├── StdioMCPClient
  └── RemoteMCPClient
       ↓
MCP Server
```

Browser / MCP Apps 也只能通过 AI-SE Backend 进入受控执行链。

## 3. MCP Tool

MCP Tool 通过 Adapter 映射到现有 ToolDefinition。当前代码以现有 `ToolDefinition` 为执行契约，并使用映射元数据承载 source / server / tool 等 MCP 信息；不得在文档中假设存在一个独立且已经实现的第二套 `UnifiedToolDefinition` runtime。

## 4. Permission / Risk / Approval

当前平台没有一个完全集中的 Tool Policy Engine。

MCP 使用现有 Federation Binding、Agent allowlist、policy provider 和 approval gate 形成执行前授权；这些能力不能发展成独立的 MCP Permission / Approval 系统。

默认：

```text
Server enabled
→ Project binding
→ Agent binding
→ Tool enabled
→ Policy allowed
→ Agent-visible
```

执行时仍需重查授权；DENY 必须在 MCP 请求发出前发生。

## 5. Error

MCP 当前拥有自己的 `MCPErrorCategory`，但最终必须映射到既有 RuntimeErrorCode。当前 RuntimeErrorCode 集合保持平台既有定义，不在 MCP 层新增第二套最终错误码。

## 6. Remote MCP

5.5-4 已实现 Streamable HTTP、连接生命周期、有限重连、DEGRADED、credentialRef/authRef、Secret isolation、Timeout/Cancellation。

Remote MCP 使用官方 SDK；不以旧 HTTP+SSE / Mcp-Session-Id 模型作为目标实现。

## 7. Resource / Prompt

5.5-6 使用独立：

- MCPResourceAdapter
- MCPPromptAdapter

支持：

```text
resources/list
resources/read
prompts/list
prompts/get
```

Resource / Prompt 不转换成 ToolDefinition。

## 8. MCP Apps

5.5-7：

```text
UI Resource
  ↓
Sandboxed iframe
  ↓
Host Bridge
  ↓
AI-SE Backend
  ↓
ToolRuntime
  ↓
MCP Adapter
```

iframe 不得获得 MCP credential、宿主机权限或直接 MCP Transport。

## 9. Persistence

当前 MCP Registry 使用：

```text
mcp_servers
mcp_tools
mcp_tool_bindings
```

当前 Agent Registry 仍为代码注册，因此 Binding 使用 `agent_name`，不存在数据库 `agents` 外键。

## 10. Non-goals

不自研 MCP Protocol / SDK，不建立第二套 Permission / Approval / Audit / Secret Store，不把 MCP 做成 Workflow Engine 或 Agent Runtime。
