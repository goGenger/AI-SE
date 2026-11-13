# Phase 5.5-0 Contract Freeze — Completion Report

> 项目：AI-SE（MCP Tool Federation）
> 阶段：Phase 5.5-0（Contract Freeze）
> 状态：PASS
> 完成日期：2026-09-10
> 验证环境：Node 22.22.2（nvm）+ pnpm 12.3.4（corepack）

---

## 1. Status

**PASS**

## 2. Current Architecture Analysis

以代码为准的现状（不重复文档假设）：

- **ToolDefinition**（`packages/tool-runtime/src/types.ts`）：`{ name, description, riskLevel, inputSchema: ZodType, execute }`。没有 `source` / `requiresApproval` 字段。
- **Tool Runtime**（`ToolRuntime.ts`）：内存 Map 注册表；execute 链 = audit 记录 → 取消检查 → Zod schema validation → `withTimeout`（timeout + AbortSignal 级联）→ error normalization → audit 收尾。**内部没有集中 Policy 引擎**。
- **Permission**：调用方执行 —— `ToolRuntimeBackend.executeTool` 检查 Agent 工具白名单（`AgentPermissions.tools` + 路径前缀）；delivery 工具内部 `assertPermission` 内联断言。
- **Risk**：`ToolDefinition.riskLevel`（LOW/MEDIUM/HIGH/CRITICAL）声明式。
- **Approval**：Workflow 层（`approvals` 表 + Task `WAITING_APPROVAL` + `context.metadata.approved` 内联检查）。
- **Audit**：`ToolCallRecorder`（started/finished）→ `tool_calls` 表 + workflow events；`ToolAuditInfo` 携带 requestId/projectId/taskId/agentRunId/toolCallId/toolName/riskLevel/actor。
- **ToolResult / ToolExecutionContext**：见 `types.ts`；context 含 `timeoutMs` / `signal` / `sandbox` / `toolCallRecorder`。
- **错误分类**：`RuntimeErrorCode` 仅 8 个（LLM/TOOL/SANDBOX/COMMAND/TEST/TIMEOUT/CANCELLED/UNKNOWN_ERROR）。
- **Secret Redaction**：`@ai-se/observability` 的 `sanitizeLogData`（key 子串匹配）+ pino redact，ToolRuntime 已统一使用。
- **Agent-visible Tool Discovery**：`ToolRuntime.getToolDefinitions()` → `ToolRuntimeBackend.createCustomTools()` 按 `CUSTOM_TOOL_NAMES` + Agent 白名单过滤 → LangChain tool。
- **数据库迁移**：原生 SQL 文件 + checksum runner（`schema_migrations`），无 ORM。
- **测试体系**：vitest per-package；server 为 supertest e2e。
- **MCP SDK**：仓库中不存在（锁定 `@modelcontextprotocol` 零引用）。

### 分析结论

- **当前已有能力**：Zod validation、timeout/cancellation 信号级联、审计记录、统一错误归一化、secret redaction、工具白名单权限、workflow 审批。
- **MCP 可以直接复用**：ToolDefinition / ToolRuntime 执行链 / ToolResult / ToolExecutionContext（signal、timeoutMs、toolCallRecorder）/ RuntimeErrorCode / sanitizeLogData / tool_calls 审计。
- **需要增加 Adapter**：MCPClientPort（协议层）→ MCPToolAdapter（桥接）。
- **需要增加字段**：无（`UnifiedToolMetadata` 作为映射层承载 `source/requiresApproval/mcpServerId/mcpToolName`，不改 Tool Runtime 类型）。
- **不应该重复实现**：Permission / Risk / Approval / Audit / Secret / 第二套 ToolDefinition / 第二套 ErrorCode。

## 3. Contracts Added

全部冻结在 `packages/mcp/src/`（`@ai-se/mcp`）：

- **MCPClientPort**（contracts.ts）：`connect/disconnect/listTools/callTool(serverId, name, input, signal?)`，只负责协议层，不负责 Permission/Approval/Audit/Workflow/Scheduling/Secret Policy。
- **MCPServerDefinition + MCPStdioConfig**（contracts.ts）：`transport: "stdio"`（唯一冻结 transport）、`authRef/credentialRef` 仅引用；`validateMCPServerDefinition`（Zod strict）拒绝明文凭据字段、credential 形状的 key 与 token 形状的引用值。
- **MCPToolDefinition**（contracts.ts）：`{ serverId, name, description, inputSchema }`（inputSchema 为 MCP JSON Schema，Zod 转换属 5.5-2）。
- **MCPToolAdapter**（contracts.ts）：`execute(input, context): Promise<ToolResult>` + `MCPToolAdapterFactory` 类型（5.5-2 实现）。
- **Unified Tool Mapping**：`toUnifiedToolMetadata(tool, policy)` → `UnifiedToolMetadata`（source/riskLevel/requiresApproval/mcpServerId/mcpToolName），risk/approval 只来自平台 Policy，绝不信任 Server 自报。
- **Error Contract**（errors.ts）：`MCPErrorCategory`（9 类）+ `classifyMCPError` + `mapMCPErrorToRuntimeError` —— 只产出已有 RuntimeErrorCode（TIMEOUT_ERROR / CANCELLED_ERROR / TOOL_ERROR），类别进 `details.mcpErrorCategory`，不创建第二套 ErrorCode。
- **Security Contract**：credential 不得进入 Prompt/State/Task/Event/Result/Log/Git；Adapter 只能通过受控引用取凭据（接口边界，本阶段不实现 OAuth/HTTP/Secret Provider）。
- **Mock 契约**：`FakeMCPClient`（echo/slow/failing）+ `requestCount`（只计派发到 Server 的调用，供 5.5-2 断言 DENY ⇒ 0 请求）。

## 4. Database Design

冻结在 `packages/mcp/src/persistence.ts` + `docs/25-mcp-contract-freeze.md` §3（实体类型 + DDL 设计，**未创建迁移文件** —— 5.5-3 实现；沿用现有原生 SQL 体系，不引入 ORM）：

### mcp_servers

- 字段：id(PK) / name(UNIQUE) / description / transport / endpoint(NULL，5.5-4 预留) / command / args(JSONB) / status / enabled(默认 FALSE) / auth_ref / credential_ref(仅引用) / last_connected_at / last_error / created_at / updated_at
- status 生命周期：`REGISTERED → CONNECTING → CONNECTED → DEGRADED → DISCONNECTED → REVOKED`

### mcp_tools

- 字段：id(PK) / mcp_server_id(FK→mcp_servers, CASCADE) / name / description / input_schema(JSONB) / enabled(默认 FALSE) / risk_level / requires_approval / created_at / updated_at
- 唯一约束：UNIQUE(mcp_server_id, name)；索引：mcp_server_id
- 只存静态 metadata，不混入运行时状态

### mcp_tool_bindings

- 字段：id(PK) / project_id(FK, CASCADE) / agent_id(NULL=项目级授权) / mcp_server_id(FK) / mcp_tool_id(NULL=整 Server) / enabled(默认 FALSE) / created_at / updated_at
- 唯一约束：UNIQUE(project_id, agent_id, mcp_server_id, mcp_tool_id) NULLS NOT DISTINCT
- 索引：project_id / agent_id / mcp_server_id

### 可见性链（`isMCPToolVisible`）

```text
MCP Server registered → Server enabled → Project binding → Agent binding
    → Tool enabled → Policy allowed → Agent-visible
```

任何一环不满足 = DENY；未绑定 = DENY。

### 审计复用

不建第二套审计，复用 `tool_calls` / `audit_logs`。

## 5. Files Changed

- `docs/17-acceptance-checklist.md` —— 勾选 5.5-0 五项验收（唯一被修改的既有文件）
- `pnpm-lock.yaml` —— 注册新 workspace 包（`pnpm install` 自动更新）

## 6. Files Created

- `packages/mcp/package.json`
- `packages/mcp/tsconfig.json`
- `packages/mcp/src/contracts.ts`
- `packages/mcp/src/errors.ts`
- `packages/mcp/src/persistence.ts`
- `packages/mcp/src/index.ts`
- `packages/mcp/src/__tests__/contracts.test.ts`
- `packages/mcp/src/__tests__/errors.test.ts`
- `packages/mcp/src/__tests__/visibility.test.ts`
- `packages/mcp/src/__tests__/mockContract.test.ts`
- `packages/mcp/src/__tests__/index.test.ts`
- `packages/mcp/src/__tests__/fixtures/fakeMCPClient.ts`
- `docs/25-mcp-contract-freeze.md`

## 7. Tests

| test | purpose | result |
| --- | --- | --- |
| contracts.test.ts（14） | Port/Adapter 类型契约、ServerDefinition 校验（credentialRef 拒绝 token 形状、env 拒绝 credential key、strict 拒绝未知字段）、Unified 映射、与 ToolDefinition 核心字段的可赋值性 | PASS |
| errors.test.ts（12） | 分类启发式、仅产出已有 RuntimeErrorCode、类别元数据传递 | PASS |
| visibility.test.ts（7） | 全链可见 / 单环缺失 DENY / 默认 DENY | PASS |
| mockContract.test.ts（13） | echo 原样返回、slow 延迟 + AbortSignal 取消、failing 可预测可分类、requestCount 语义、connect/disconnect 生命周期 | PASS |
| index.test.ts（2） | 导出面完整性 | PASS |

## 8. Validation

- Typecheck（全仓 `pnpm -r run typecheck`）: **PASS**
- Lint（全仓 `pnpm -r run lint`）: **PASS**
- Unit / Contract / Schema（`@ai-se/mcp` 48/48）: **PASS**
- Regression（全仓 `pnpm -r run test`，exit 0）: **PASS**
  - shared 11、observability 2、sandbox 2、workflow-engine 14、web 25、tool-runtime 11、database 12、agent-core 27、server 19、mcp 48

## 9. Architecture Impact

- Agent Runtime：**未修改**
- Workflow Engine：**未修改**
- Tool Runtime：**未修改**（新增包仅类型依赖它）
- Database：**未修改**（仅设计冻结，无迁移文件）
- API：**未修改**
- Frontend：**未修改**

## 10. Deferred

- **5.5-1**：未安装官方 MCP SDK、未实现 initialize / tools/list / tools/call / disconnect、无任何 transport
- **5.5-2**：未实现 Adapter 工厂、未把 MCP Tool 接入 Tool Runtime、未扩展审计字段
- **5.5-3**：未创建迁移文件、未实现 Repository / CRUD API / Binding 查询
- **5.5-4**：未实现 HTTP transport / OAuth / Secret Provider / 连接恢复
- **5.5-5**：未实现 Console
- **5.5-6**：未实现 Resource / Prompt Adapter
- **5.5-7**：未实现 MCP Apps

## 11. Risks / Conflicts

1. **UnifiedToolDefinition（docs 06/21）≠ 当前 ToolDefinition**：文档定义含 `source/requiresApproval/mcpServerId/mcpToolName` 且 `inputSchema: unknown`；代码无这些字段且 schema 为 Zod。按“代码优先”处理：新增 `UnifiedToolMetadata` 映射层，不改 Tool Runtime 类型；5.5-2 组装完整 ToolDefinition 时再决定是否扩展。
2. **ErrorCode 集合不一致**：文档的 `VALIDATION_ERROR/PERMISSION_DENIED/...` 不存在于代码（代码仅 8 个 code）。按“复用已有 ErrorCode”处理：分类作为 `details.mcpErrorCategory` 元数据，映射到 TOOL_ERROR / TIMEOUT_ERROR / CANCELLED_ERROR。
3. **无集中 Policy/Approval 模块**：权限在白名单调用方、审批在 Workflow 层、risk 声明式。MCP 必须复用这些既有机制，禁止新建平行 Policy —— 已写入冻结文档 §7 供 5.5-2 遵循。
4. **docs 08 的 `endpoint` 字段**：Remote-only，设计中保留 NULL 列但 stdio 阶段不读写。
5. **环境**：目录无 .git（无法 diff 验证，仅按文件清单核对）；Node 需 22.22.2（nvm）+ corepack pnpm 12.3.4。

## 12. STOP

Phase 5.5-0（Contract Freeze）已完成并全部验证通过。

未开始 Phase 5.5-1。未实现真实 MCP Client。未实现 stdio / HTTP / OAuth / MCP Console / Resource / Prompt / Apps。未修改 Workflow Engine、Agent Runtime、LangGraph 架构或 Tool Runtime。
