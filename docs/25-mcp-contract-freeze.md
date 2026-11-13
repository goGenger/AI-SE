# Phase 5.5-0 — MCP Contract Freeze

> 本文件是 Phase 5.5-0（Contract Freeze）的冻结成果，5.5-1 ~ 5.5-7 在本契约之上实现。
> 代码实现位于 `packages/mcp`（`@ai-se/mcp`）。

## 1. Architecture Position

```text
Agent
  ↓
Agent Runtime
  ↓
Tool Runtime          ← 统一执行链：Schema Validation / Permission / Risk /
  ↓                     Approval / Timeout / Cancellation / Audit / Redaction
MCP Adapter
  ↓
Official MCP SDK      ← 5.5-1 引入，本阶段仅记录依赖决策
  ↓
MCP Server
  ↓
External System
```

禁止路径（冻结）：

```text
Agent → MCP Client
Agent → MCP Server
Agent → External API
```

MCP 只是 Tool Runtime 的一种 Tool Source，不建立第二套 Permission / Risk / Approval /
Audit / Secret Management / Tool Execution Runtime。

## 2. Frozen Contracts（packages/mcp/src）

### 2.1 MCPClientPort

```ts
interface MCPClientPort {
  connect(server: MCPServerDefinition): Promise<void>;
  disconnect(serverId: string): Promise<void>;
  listTools(serverId: string): Promise<MCPToolDefinition[]>;
  callTool(serverId: string, name: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
}
```

只负责 MCP 协议层能力。不负责 Permission、Approval、Audit、Workflow、Task
Scheduling、Agent Planning、Secret Policy。

> **5.5-6 记录**：按 Phase 5.5-6 指令做了一次加法式扩展 —— 新增
> `listResources(serverId)`、`readResource(serverId, uri, signal?)`、
> `listPrompts(serverId)`、`getPrompt(serverId, name, args?, signal?)` 四个
> 协议方法（工具面零改动）。Resource/Prompt 不使用 ToolDefinition 模型，
> 由独立 `MCPResourceAdapter` / `MCPPromptAdapter` 承载（docs/32）。
>
> **5.5-7 记录**：`MCPClientPort` 零改动。加法式扩展仅限：
> `MCPToolDefinition` + 可选 `uiResourceUri`（工具 `_meta.ui` 归一化）、
> `MCPRegistryQuery` + 可选 `serverIds` 过滤、`PersistentMCPRegistry` 新增
> `listVisibleToolUiLinks`（docs/33）。

### 2.2 MCPServerDefinition

```ts
interface MCPServerDefinition {
  id: string;
  name: string;
  description?: string;
  transport: "stdio"; // 5.5-4 才增加 Streamable HTTP
  stdio?: MCPStdioConfig; // transport === "stdio" 时必填
  enabled: boolean;
  authRef?: string; // 引用，禁止明文凭据
  credentialRef?: string; // 引用，禁止明文凭据
}

interface MCPStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}
```

`validateMCPServerDefinition` 以 Zod 冻结校验规则：

- transport 只允许 `stdio`；
- 未知字段一律拒绝（`.strict()`）——不允许出现第二套凭据字段；
- `stdio.env` 的 key 不得是 credential 形状（token/api_key/password/secret…）；
- `authRef` / `credentialRef` 的值不得是 token 形状（JWT、`sk-`、`ghp_`、`Bearer ` …），
  只能是引用（如 `secret:mcp/servers/github`）。启发式检测，5.5-4 接入 Secret
  Provider 后由受控引用解析兜底。

### 2.3 MCPToolDefinition

```ts
interface MCPToolDefinition {
  serverId: string;
  name: string;
  description: string;
  inputSchema: unknown; // MCP JSON Schema；JSON-Schema→Zod 转换属于 5.5-2
}
```

### 2.4 MCPToolAdapter

```ts
interface MCPToolAdapter {
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}
```

Adapter 只负责 `MCP Tool → MCP Client → MCP Server → Result`。schema validation、
permission、risk、approval、timeout、cancellation、audit、secret redaction、error
classification 全部由已有 Tool Runtime 提供，Adapter 不重复实现。

### 2.5 Unified Tool Mapping

```text
MCPToolDefinition → MCP Adapter → Unified ToolDefinition → Existing Tool Runtime
```

`toUnifiedToolMetadata(tool, policy)` 冻结映射层：`name`、`description` 来自 MCP
Tool；`source: "mcp"`；`riskLevel` / `requiresApproval` 由平台 Policy 决定，**绝不
信任 MCP Server 自报信息**；`mcpServerId` / `mcpToolName` 保留来源坐标。

5.5-2 组装完整 `ToolDefinition`（Zod 转换后的 inputSchema + Adapter 支持的
execute）。当前 `ToolDefinition`（packages/tool-runtime/src/types.ts）没有
`source` / `requiresApproval` 字段，因此 `UnifiedToolMetadata` 作为映射层承载这些
扩展字段，不修改 Tool Runtime 现有类型（见 §7 冲突记录）。

### 2.6 Error Contract

`classifyMCPError` 把 MCP 层失败归类为 `MCPErrorCategory`：

```text
VALIDATION | PERMISSION_DENIED | APPROVAL_REQUIRED | TIMEOUT | CANCELLED |
CONNECTION | REMOTE_TOOL | RATE_LIMITED | INTERNAL
```

`mapMCPErrorToRuntimeError` 将 category 映射到**已有** RuntimeErrorCode：

| MCPErrorCategory  | RuntimeErrorCode（已有，不新增） | 说明                                    |
| ----------------- | -------------------------------- | --------------------------------------- |
| TIMEOUT           | TIMEOUT_ERROR                    |                                         |
| CANCELLED         | CANCELLED_ERROR                  |                                         |
| VALIDATION        | TOOL_ERROR                       | 正常由 Tool Runtime 在 Adapter 之前拦截 |
| PERMISSION_DENIED | TOOL_ERROR                       | 权限决策属于平台层，MCP 无权决策        |
| APPROVAL_REQUIRED | TOOL_ERROR                       | 审批属于 Workflow 层                    |
| CONNECTION        | TOOL_ERROR                       | details.mcpErrorCategory 保留类别       |
| REMOTE_TOOL       | TOOL_ERROR                       |                                         |
| RATE_LIMITED      | TOOL_ERROR                       |                                         |
| INTERNAL          | TOOL_ERROR                       |                                         |

类别通过 `details.mcpErrorCategory` 传递，不创建第二套 ErrorCode。Workflow/Task 层
只消费统一错误。

### 2.7 Mock MCP Server Contract

测试夹具 `packages/mcp/src/__tests__/fixtures/fakeMCPClient.ts` 冻结三个 Tool 的语义：

| Tool    | 语义                                  | 用途                                         |
| ------- | ------------------------------------- | -------------------------------------------- |
| echo    | 输入任意 JSON，原样返回               | 成功路径                                     |
| slow    | 延迟 delayMs 后返回，尊重 AbortSignal | timeout / cancellation                       |
| failing | 主动返回可预测、可分类的错误          | error normalization / failure classification |

`FakeMCPClient.requestCount` 只统计真正派发到 Server 的 call，`listTools` 与失败的
查找不计入——5.5-2 用它断言 “Policy DENY ⇒ MCP Server 收到 0 请求”。

## 3. Persistence Contract（设计冻结，5.5-3 实现迁移）

ORM 决策：项目使用原生 SQL migration（packages/database/migrations + schema_migrations
checksum runner），**不引入 Prisma/TypeORM/Drizzle**。

> **5.5-3 实现记录**：迁移已落地为 `008_phase5_mcp_registry.sql`（含 `set_updated_at`
> 触发器）。两处偏差（均已写入 docs/29 §6）：
> 1. `mcp_tool_bindings.agent_id UUID → agents(id)` 改为 **`agent_name TEXT`** ——
>    仓库不存在 `agents` 表（Agent 为 AgentRegistry 代码定义），且 5.5-2 契约以
>    agentName 寻址；
> 2. `mcp_servers` 新增 `env JSONB` / `cwd TEXT` —— 重启恢复必须还原
>    `MCPServerDefinition.stdio` 的完整定义（env 凭据形状 key 仍在应用层拒绝）。

### 3.1 mcp_servers

```sql
CREATE TABLE mcp_servers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  transport         TEXT NOT NULL DEFAULT 'stdio',
  endpoint          TEXT,               -- 5.5-4 Streamable HTTP 预留，stdio 为 NULL
  command           TEXT,               -- stdio 启动命令
  args              JSONB NOT NULL DEFAULT '[]'::jsonb,
  status            TEXT NOT NULL DEFAULT 'REGISTERED',
  enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  auth_ref          TEXT,               -- 引用，禁止明文凭据
  credential_ref    TEXT,               -- 引用，禁止明文凭据
  last_connected_at TIMESTAMPTZ,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mcp_servers_name_key ON mcp_servers (name);
```

- status 生命周期：`REGISTERED → CONNECTING → CONNECTED → DEGRADED → DISCONNECTED → REVOKED`。
- 默认 `enabled = FALSE`：未启用的 Server 不产生任何连接。
- `auth_ref` / `credential_ref` 只保存引用，明文凭据禁止入表。

### 3.2 mcp_tools

```sql
CREATE TABLE mcp_tools (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mcp_server_id     UUID NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  input_schema      JSONB NOT NULL,
  enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  risk_level        TEXT NOT NULL,      -- LOW | MEDIUM | HIGH | CRITICAL（平台决定）
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mcp_tools_server_name_key ON mcp_tools (mcp_server_id, name);
CREATE INDEX mcp_tools_server_idx ON mcp_tools (mcp_server_id);
```

- 只存 Discovery 后的静态 metadata；运行时状态（连接、调用）不入此表。
- `risk_level` / `requires_approval` 是平台 Policy 结果，不直接信任 Server 自报。
- 默认 `enabled = FALSE`：新发现的 Tool 不可用，需显式启用。

### 3.3 mcp_tool_bindings

```sql
CREATE TABLE mcp_tool_bindings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  agent_id        UUID REFERENCES agents (id) ON DELETE CASCADE,  -- NULL = 项目级授权
  mcp_server_id   UUID NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
  mcp_tool_id     UUID REFERENCES mcp_tools (id) ON DELETE CASCADE, -- NULL = 整 Server 授权
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mcp_tool_bindings_scope_key
  ON mcp_tool_bindings (project_id, agent_id, mcp_server_id, mcp_tool_id)
  NULLS NOT DISTINCT;

CREATE INDEX mcp_tool_bindings_project_idx ON mcp_tool_bindings (project_id);
CREATE INDEX mcp_tool_bindings_agent_idx ON mcp_tool_bindings (agent_id);
CREATE INDEX mcp_tool_bindings_server_idx ON mcp_tool_bindings (mcp_server_id);
```

- `agent_id IS NULL` = 项目级授权；`mcp_tool_id IS NULL` = 对该 Server 全部 Tool 授权。
- 唯一约束用 `NULLS NOT DISTINCT`（PostgreSQL 15+）防止重复授权行。
- 默认 `enabled = FALSE`。

### 3.4 Visibility Chain（冻结，`isMCPToolVisible`）

```text
MCP Server registered
        ↓
Server enabled
        ↓
Project binding
        ↓
Agent binding
        ↓
Tool enabled
        ↓
Policy allowed
        ↓
Agent-visible
```

任何一环不满足 = DENY；未绑定 = DENY。Policy DENY 时 MCP Server 必须收到 0 个请求。

### 3.5 复用已有审计

MCP Tool Call 复用 `tool_calls` / `audit_logs`（ToolCallRecorder），不建第二套审计。
5.5-2 的审计字段扩展为：`toolCallId, mcpServerId, mcpToolName, transport, riskLevel,
status, duration, errorType`。

## 4. Dependency Decision

- 仓库原本**没有** MCP SDK。
- 5.5-1 已接入官方 MCP TypeScript SDK：**`@modelcontextprotocol/sdk` 1.30.0**
  （`packages/mcp`，Node >= 18），不自行实现 MCP Protocol。
- 5.5-0 冻结阶段只记录决策、不安装 SDK；SDK 集成与真实 stdio 能力见 docs/27。

## 5. Phase Boundaries（冻结）

| Sub-phase                      | 内容                                                                                                          | 本阶段未做                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 5.5-1 Local MCP / stdio        | initialize、tools/list、tools/call、disconnect、error normalization、cancellation；官方 SDK                   | ✅ 已实现（docs/27）                      |
| 5.5-2 Tool Runtime Integration | MCP Tool 成为 Tool Runtime 的 Tool Source；Permission/Risk/Approval/Timeout/Cancellation/Audit；DENY ⇒ 0 请求 | ✅ 已实现（docs/27） |
| 5.5-3 Registry & Persistence   | mcp_servers/mcp_tools/mcp_tool_bindings 迁移、Repository、CRUD API、Binding、visibility 过滤                  | ✅ 已实现（docs/29）；REST CRUD API 未实现（后续阶段） |
| 5.5-4 Remote MCP & Auth        | Streamable HTTP、credentialRef/authRef 解析、连接恢复                                                         | ✅ 已实现（docs/30）；OAuth authorization-code flow 仍留后续 |
| 5.5-5 MCP Console              | Settings → MCP Servers 管理界面                                                                               | ✅ 已实现（docs/31）；Server 注册/启停 UI 未实现（严格范围） |
| 5.5-6 Resource / Prompt        | resources/list、resources/read、prompts/list、prompts/get 独立 Adapter                                        | ✅ 已实现（docs/32）；无 Resource/Prompt 持久化（按边界） |
| 5.5-7 MCP Apps                 | Sandboxed iframe + Host Bridge                                                                                | ✅ 已实现（docs/33）；受控动作经 ToolRuntime，凭据隔离 |

## 6. Security Contract（冻结）

- Agent 不接触 MCP credentials。
- credential 禁止进入：Prompt、Agent State、Task Input/Output、Workflow Event、
  Tool Result、Logs、Git。
- MCP Adapter 只能通过受控 credential reference 获取连接凭据（5.5-4 接入 Secret Provider）。
- 本阶段不实现 OAuth、Remote HTTP、Secret Provider，只冻结接口边界。
- 已有 `@ai-se/observability` 的 `sanitizeLogData` / pino redact 继续作为统一脱敏边界。

## 7. 文档与代码冲突记录

1. **UnifiedToolDefinition（docs 06/21）≠ 当前 ToolDefinition（代码）**：文档中
   `UnifiedToolDefinition` 含 `source` / `requiresApproval` / `mcpServerId` /
   `mcpToolName`，且 `inputSchema: unknown`；当前代码 `ToolDefinition` 只有
   `name/description/riskLevel/inputSchema(Zod)/execute`。处理：以代码为准，
   `UnifiedToolMetadata` 作为映射层承载扩展字段，不修改 Tool Runtime 现有类型；
   5.5-2 决定是否扩展 `ToolDefinition` 本身。
2. **ErrorCode 集合不一致**：文档列举 `VALIDATION_ERROR/PERMISSION_DENIED/...`；
   当前代码只有 8 个 RuntimeErrorCode。处理：复用现有 code，`MCPErrorCategory`
   仅作分类元数据进入 `details`，不创建第二套 ErrorCode。
3. **Permission / Approval / Policy 位置**：Tool Runtime 内部没有集中的 Policy 引擎；
   permission 由调用方（ToolRuntimeBackend 的工具白名单 + 路径前缀、deliveryTools
   的内联断言）执行，approval 在 Workflow 层（approvals 表 + WAITING_APPROVAL +
   context.metadata.approved）。MCP 接入必须复用这些既有机制，禁止新建平行 Policy
   模块——5.5-2 按此边界实现。
4. **docs 08 的 mcp_servers 含 `endpoint`**：Remote-only 字段，设计中保留为 NULL 列
   （5.5-4 使用），stdio 阶段不读写。

## 8. Tests

| Test 文件            | 目的                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------- |
| contracts.test.ts    | Port/Adapter 类型契约、ServerDefinition 校验（含 credentialRef 拒绝明文凭据）、Unified 映射 |
| errors.test.ts       | 错误分类启发式、映射到已有 RuntimeErrorCode、类别元数据传递                                 |
| visibility.test.ts   | 可见性链全部 / 单环缺失 / 默认 DENY                                                         |
| mockContract.test.ts | echo/slow/failing 语义、requestCount、取消、分类错误                                        |
| index.test.ts        | 导出面完整性                                                                                |
