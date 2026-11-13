# Phase 5.5-5 — MCP Console（实现说明）

> 状态：✅ 完成。7 项验收目标全部实现；5.5-0 ~ 5.5-4 契约未修改。
> 未实现（按本阶段边界）：Server 注册/启停/连接管理 UI、Schema 编辑器、Resource/Prompt、OAuth、MCP Apps、REST CRUD 之外的平台能力。

## 1. 交付物

| 位置 | 内容 |
| ---- | ---- |
| `apps/server/src/services/mcpService.ts` | `MCPConsoleService`：Console 读模型 + 绑定行 CRUD + boot `initialize()` + `shutdown()`；按 server transport 选择 stdio / streamable-http 的 `PersistentMCPRegistry` |
| `apps/server/src/routes/mcp.ts` | Console REST API（7 端点，复用既有 envelope / AppError / zod 校验风格） |
| `apps/server/src/app.ts` | 可选依赖 `mcpService` → 挂载 `/api/mcp` |
| `apps/server/src/index.ts` | 生产组装：`PgMCPRegistryStore` + `StdioMCPClient` / `RemoteMCPClient`（`onStateChange → applyConnectionState`）+ 启动恢复 + 停机断开 |
| `packages/mcp/src/registry/store.ts` | **加法式**扩展：`MCPBindingRowInput`、`MCPRegistryStoreError`（DUPLICATE_BINDING / UNKNOWN_TOOL / UNKNOWN_PROJECT / UNKNOWN_SERVER）、`createBinding / updateBinding / deleteBinding` |
| `packages/mcp/src/registry/inMemoryStore.ts`、`packages/database/src/mcpRegistryStore.ts` | 两个 backend 的行级 CRUD 实现（语义一致；PG 用唯一索引 + FK 错误码兜底） |
| `packages/shared/src/index.ts` | Console DTO（`MCPServerSummary/Detail`、`MCPToolSummary`、`MCPBindingSummary`）+ `CreateMCPBindingSchema` / `UpdateMCPBindingSchema` |
| `apps/web/src/api/mcp.ts`、`stores/mcp.ts`、`mcpViewModel.ts` | Console 前端数据层（REST only） |
| `apps/web/src/views/MCPServersView.vue`、`MCPServerDetailView.vue`、router、App.vue、styles.css | 页面 `/mcp`、`/mcp/:serverId`（Overview / Tools / Bindings 三个 Tab） |

## 2. 架构（Browser 永不直连 MCP）

```
Browser (Vue Console)
  ↓  REST only
AI-SE Backend /api/mcp
  ↓
MCPConsoleService → MCPRegistryStore (PostgreSQL)
  ↓ (仅后端进程内)
PersistentMCPRegistry → StdioMCPClient / RemoteMCPClient → MCP Server
```

- 浏览器不含 MCP SDK / MCP Client / `callTool` / `tools/list`（源码级守护测试）。
- Console 只读 registry/persistence 数据；状态一律来自后端（`REGISTERED → CONNECTING → CONNECTED → DEGRADED → RECONNECTING → …` 生命周期由 5.5-3/5.5-4 已实现的后端负责）。
- 绑定是 Federation 授权行；每次可见性读取（含调用时重查）都直接读 store，Console 变更**无需重启/刷新缓存**即刻生效。

## 3. API（新增，全部复用既有约定）

| Method | Path | 说明 |
| ------ | ---- | ---- |
| GET | `/api/mcp/servers` | 列表：name/transport/enabled/status/toolCount/lastConnectedAt（按名称排序） |
| GET | `/api/mcp/servers/:serverId` | 详情：元数据 + connection（status/lastConnectedAt/lastError）+ transport 配置（stdio: command/args；http: endpoint）+ `authRef`/`credentialRef`（仅引用） |
| GET | `/api/mcp/servers/:serverId/tools` | Tool 列表：name/description/enabled/riskLevel/requiresApproval/inputSchemaSummary |
| GET | `/api/mcp/servers/:serverId/bindings` | 绑定列表（含 projectName/serverName/toolName 解析） |
| POST | `/api/mcp/servers/:serverId/bindings` | 创建绑定行（`{projectId, agentName?, toolName?, enabled?}`）；409 `MCP_BINDING_EXISTS` / 400 `MCP_TOOL_NOT_FOUND` / 400 `MCP_PROJECT_NOT_FOUND` / 404 `MCP_SERVER_NOT_FOUND` |
| PATCH | `/api/mcp/bindings/:bindingId` | `{enabled}` 启用/禁用单行；404 `MCP_BINDING_NOT_FOUND` |
| DELETE | `/api/mcp/bindings/:bindingId` | 撤销单行；404 同上 |

- 未知 server 的 tools/bindings 子资源一律 404；错误体沿用 `{success:false,error:{code,message}}` envelope。
- **不存在任何 MCP 协议端点**（无 JSON-RPC / tools-call 代理），测试断言 `POST …/tools/call` → 404。

## 4. 安全属性（测试实证）

1. **No browser direct MCP**：`apps/web` 依赖无 `@modelcontextprotocol/*`、无 `@ai-se/mcp`；全源码扫描无 MCP SDK/客户端/协议调用；MCP 数据无浏览器存储使用。
2. **Secret isolation**：DTO 只含 `authRef`/`credentialRef` 引用；`env` 值永不出现在任何响应（marker 断言）；原始 JSON 无 `Bearer`/token 形态；DB 层凭据形状 env key 在 5.5-0 校验已拒绝。
3. **绑定即时生效 + 零请求**：Console PATCH 禁用（或 DELETE 撤销）已绑定 agent 的 grant 后，**此前构建好的 ToolDefinition** 立即 `PERMISSION_DENIED`，stdio MCP server 计数器零增长；重新启用后恢复可调用。
4. **Fail-closed 保持**：默认 disabled（server/tool/新发现 tool）、未绑定 DENY、DEGRADED 不删 Tool 但执行链校验不变、REVOKED 为终态展示。
5. **AgentPermissions 不被绕过**：绑定只是 Federation 授权；`agentToolAllowlist` AND 语义（5.5-3）不变，本阶段未修改 AgentPermissions。

## 5. 测试

- `apps/server/src/__tests__/mcpConsoleApi.e2e.test.ts`（8）：真实 PG（迁移 008）+ 真实 stdio 服务器 + 真实 Streamable HTTP fixture + supertest；list/detail/status/toolCount、tools（risk/approval/schema 摘要 + 新发现 tool 默认 disabled）、未知资源与协议端点 404、绑定列表、创建/重复/非法引用矩阵、**禁用/启用/撤销的零请求断言**、DEGRADED/REVOKED 展示。
- `packages/mcp/src/__tests__/bindingRowStore.test.ts`（4）：行级 CRUD、重复与未知工具错误、行授权驱动可见性即时反转。
- `packages/database/src/mcpRegistryStore.test.ts`（+1，共 6）：PG 行级 CRUD 与 4 类 typed error（含 FK 约束映射）。
- `apps/web`：`mcpViewModel.test.ts`（6）、`stores/mcp.test.ts`（4）、`mcpSecurity.test.ts`（5，源码级安全守护）。

回归：5.5-1 stdio、5.5-2 federation、5.5-3 persistence、5.5-4 remote、Native ToolRuntime 全部保持通过（见全仓验证）。

## 6. 与冻结设计的偏差 / 已知限制

1. **绑定行级 CRUD**：`MCPRegistryStore` 增加 3 个加法式方法（行级 create/update/delete + typed errors）。原 replace-scope 方法（`replaceProjectBinding` 等）语义不变 —— Console 以行为管理单位，不能把 scope 替换语义暴露给 UI。
2. **不提供 Server 注册/启停/连接按钮**：按本阶段严格范围（7 项验收）未做；后端 registry 的 CRUD/connect/disconnect 能力（5.5-3/5.5-4）保持可用，后续阶段可直接包装。
3. **状态刷新为手动 Refresh + 进入页面拉取**：未引入 SSE/轮询基础设施（按任务指引）；如需实时可复用现有 SSE 机制另行评估。
4. **DEGRADED 展示依赖后端真实状态流转**：Console 只展示持久化状态，不自行判断健康。
5. tool 行对"server 不再上报的工具"保留（5.5-3 决策），Console 照实展示。
