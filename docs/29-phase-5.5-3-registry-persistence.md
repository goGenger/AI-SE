# Phase 5.5-3 — MCP Registry & Persistence（实现说明）

> 状态：✅ 完成。内存 MCP Registry 已在 PostgreSQL 上持久化；5.5-0/5.5-1/5.5-2 契约未破坏。
> 未实现：REST API、HTTP/OAuth、Console、Resource/Prompt、Apps、Workflow/Agent Runtime 改造。

## 1. 交付物

| 位置 | 内容 |
| ---- | ---- |
| `packages/database/migrations/008_phase5_mcp_registry.sql` | `mcp_servers` / `mcp_tools` / `mcp_tool_bindings` 迁移（既有 SQL + checksum 机制，无 ORM；`set_updated_at` 触发器） |
| `packages/database/src/mcpRegistryStore.ts` | `PgMCPRegistryStore`（`MCPRegistryStore` 端口的 PostgreSQL 实现，raw SQL） |
| `packages/mcp/src/registry/store.ts` | `MCPRegistryStore` 端口（Persistence backend 契约） |
| `packages/mcp/src/registry/inMemoryStore.ts` | `InMemoryMCPRegistryStore`（测试/嵌入式） |
| `packages/mcp/src/registry/persistentRegistry.ts` | `PersistentMCPRegistry`（store-backed Registry） |
| `packages/mcp/src/persistence.ts` | 实体类型扩展（见 §6 偏差） |

## 2. 架构

```
Agent → ToolRuntime（校验/审计/超时/取消/错误归一化）
      → ToolDefinition.execute
      → MCPToolAdapter.execute（canExecute → approvalGate → client.callTool）
      → MCP Client → MCP Server

Registry（发现/授权来源）:
  PersistentMCPRegistry ──► MCPRegistryStore（端口）
                              ├─ InMemoryMCPRegistryStore（测试）
                              └─ PgMCPRegistryStore（生产，PostgreSQL）
```

- **Registry 契约**：`MCPToolRegistry`（5.5-2 内存版）对外契约不变；`PersistentMCPRegistry` 为同一冻结可见链的 store-backed 实现（两实现语义一致，由 parity 场景测试覆盖）。
- **Persistence 只是 backend**：Agent Runtime / Workflow Engine / ToolRuntime 零修改；MCP binding 只是 **Federation/Discovery 关系**，执行仍经过现有 Tool Runtime 边界。

## 3. 数据模型（迁移 008）

- `mcp_servers`：identity/name/description/transport/endpoint/command/args/env/cwd/status/enabled/auth_ref/credential_ref/last_connected_at/last_error/timestamps；`mcp_servers_name_key` 唯一。
- `mcp_tools`：`mcp_server_id` FK（ON DELETE CASCADE）/name/description/input_schema JSONB/enabled/risk_level/requires_approval/timestamps；`(mcp_server_id, name)` 唯一。
- `mcp_tool_bindings`：`project_id` FK → projects / `agent_name`（NULL=项目级授权）/`mcp_server_id` FK/`mcp_tool_id` FK（NULL=整 Server 授权）/enabled/timestamps；`(project_id, agent_name, mcp_server_id, mcp_tool_id) NULLS NOT DISTINCT` 唯一。
- 默认全部 fail-closed：server/tool/binding 新建均为 disabled，需显式启用。

## 4. 安全属性（测试断言）

1. **默认 DENY**：未绑定、未启用一律不可见。
2. **调用时实时重查**：`canExecute` 每次执行都重新读 store —— 甚至**直接 SQL 修改数据库**（模拟外部进程）后，已经构建的 ToolDefinition 也会被 DENY，MCP Server 收到 0 请求。
3. **fail-closed**：server disabled / revoked、tool disabled、binding 缺失或 disabled、policy 返回 undefined、store 读失败（catch → false）——任一失效即 DENY。
4. **AgentPermissions 不被绕过**：`MCPRegistryQuery.agentToolAllowlist` 提供 AND 语义 —— federation 授权只在 agent 自身 allowlist 也允许时才生效（与 `workflowTaskExecutor.ts` 现有 `definition.tools.includes(...)` 组合模式一致）。
5. **重启一致性**：新进程从 PostgreSQL `initialize()` 恢复连接与授权；撤销在重启后仍然生效。
6. **凭据**：`authRef`/`credentialRef` 仅引用；stdio env 凭据形状 key 在 `validateMCPServerDefinition` 被拒。

## 5. AgentPermissions 与 MCP bindings 职责（特别审计结论）

| | AgentPermissions.tools（agent-core） | MCP binding（packages/mcp + mcp_tool_bindings） |
| -- | -- | -- |
| 语义 | Agent 允许调用的工具名 allowlist | MCP Federation/Discovery 授权（project/agent/server/tool 维度） |
| 存储 | 代码定义（AgentRegistry） | 数据库（mcp_tool_bindings） |
| 强制点 | Agent 组合期（现有） | Registry 可见性 + Adapter 调用时重查（本阶段） |
| 关系 | **AND**：两者都允许才可见/可执行 | **AND**（同一） |

- 不会形成绕过：MCP binding 单独允许 ≠ 可执行（还要过 Agent allowlist 与 Tool Runtime）；Agent allowlist 单独允许 ≠ MCP 工具可见（还要过 federation 链）。
- `agentToolAllowlist` 为可选参数：调用方（组合点）传入 AgentPermissions.tools；本阶段**未修改 AgentPermissions**，接线属于后续 Console/组合层工作。
- REST API 未实现（`/api/mcp/*` 属后续阶段；Console 阶段接入时直接包装本 Registry 的 CRUD/绑定方法即可）。

## 6. 与 5.5-0 冻结设计的偏差（已记录）

1. `mcp_tool_bindings.agent_id UUID → agents(id)` → **`agent_name TEXT`**：仓库不存在 `agents` 表（Agent 是 AgentRegistry 代码定义），且 5.5-2 契约以 agentName 寻址；改为 name 保持契约并避免虚构 FK。
2. 新增 `env JSONB` / `cwd TEXT` 列：`MCPServerDefinition.stdio` 携带 env/cwd，重启恢复必须还原定义（env 凭据形状 key 仍在应用层被拒）。
3. 其余（主键/外键/唯一约束/`NULLS NOT DISTINCT`/状态生命周/默认 disabled）与冻结设计一致；PostgreSQL 16（compose + 测试容器）支持 `NULLS NOT DISTINCT`。

## 7. 测试

- `packages/mcp/src/__tests__/persistentRegistry.test.ts`（14）：内存 store + 真实 stdio server；凭据校验、fail-closed 全矩阵、调用时撤销/禁用/策略拒绝（0 请求）、allowlist AND、approval 阻断/放行、重启恢复、tool 级绑定。
- `packages/database/src/mcpRegistryStore.test.ts`（5）：真实 PostgreSQL；迁移幂等、CRUD、唯一约束、patch 清空语义、发现持久化（保留操作员状态）、绑定作用域/唯一/级联、非法绑定拒绝。
- `packages/database/src/mcpFederation.e2e.test.ts`（9）：真实 PostgreSQL + 真实 stdio server + ToolRuntime；**直接 SQL 变更**驱动的 stale-authorization 探针（server/tool/binding 三路）、project/agent 绑定移除、policy 拒绝、重启恢复（含"撤销跨重启生效"）、Native Tool 回归 —— 全部附 0 请求断言。

## 8. 已知限制 / Deferred

- REST CRUD API（`/api/mcp/*`，docs/22）未实现 → 后续阶段（Console 前）。
- `mcp_tools` 对"server 不再上报的工具"保留行（不删除，避免级联删除绑定）；调用会得到 REMOTE_TOOL 错误。
- 跨进程连接 adopt 未处理：`initialize()` 对已被本进程其他 Registry 实例连接的 server 会报 "already connected"（记为 DEGRADED）；部署时 Registry 应为进程单例。
- 政策取值：`policyProvider` 缺省时用持久化行的 risk/approval；提供时全量覆盖（返回 undefined = DENY）。
