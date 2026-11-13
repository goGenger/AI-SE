# Phase 5.5-4 — Remote MCP（Streamable HTTP）实现说明

> 状态：✅ 完成。stdio client 行为不变；5.5-0 ~ 5.5-3 契约未破坏。
> 未实现：OAuth authorization-code flow、MCP Console、REST API、Resource/Prompt、Apps。

## 1. 交付物

| 位置 | 内容 |
| ---- | ---- |
| `packages/mcp/src/client/RemoteMCPClient.ts` | 实现 `MCPClientPort` 的 Remote MCP 客户端：官方 SDK Streamable HTTP、生命周期、有界重连、状态事件、credential 注入、错误分类 |
| `packages/mcp/src/security/credentials.ts` | `MCPCredentialResolver` 接口（引用解析，仅接口不建 Secret Store）+ `redactCredentialShapedText` |
| `packages/mcp/src/contracts.ts` | `MCPTransport = "stdio" \| "streamable-http"`；`MCPServerDefinition.endpoint`；endpoint URL/凭据内嵌校验 |
| `packages/mcp/src/persistence.ts` | `MCPServerStatus` 增加 `RECONNECTING` |
| `packages/mcp/src/registry/persistentRegistry.ts` | streamable-http 定义构建/更新；`applyConnectionState`（客户端状态 → mcp_servers.status/lastError） |
| `packages/mcp/src/testing/fake-http-server-entry.js` + `fakeHTTPServer.ts` | 官方 SDK Streamable HTTP 的本地真实 HTTP fixture（JSON/SSE 模式、auth、hit counter、可 kill/restart） |

## 2. 执行链（未变）

```text
Agent → ToolRuntime（校验/审计/超时/取消/错误归一化）
      → MCPToolAdapter（canExecute → approvalGate → callTool）
      → MCPClientPort
         ├── StdioMCPClient（5.5-1，行为不变）
         └── RemoteMCPClient（5.5-4）
               → 官方 SDK Streamable HTTP → Remote MCP Server
```

Remote MCP 只是新的 Transport/Client 实现，未改动 Adapter / Tool Runtime 职责边界。

## 3. Streamable HTTP

- 官方 SDK `StreamableHTTPClientTransport`（`@modelcontextprotocol/sdk@1.30.0`），**非旧版 HTTP+SSE session 模型**：HTTP POST + JSON 响应或 request-scoped SSE 响应；协议版本在 initialize 协商。
- 双响应模式均以真实服务器验证：`enableJsonResponse: true`（JSON）与 SSE（`text/event-stream`）。
- 第三方互操作：`@modelcontextprotocol/server-everything streamableHttp`（有状态、express）连接、tools/list、echo/get-sum 全部真实通过。
- GET SSE（server-initiated stream）由 SDK 处理；服务器返回 405 属预期路径（SDK 忽略）。

## 4. Connection Lifecycle & Reconnect

```text
CONNECTING → CONNECTED → DEGRADED → RECONNECTING → CONNECTED（恢复）
                                     └── 耗尽 → DISCONNECTED
```

- 状态经 `onStateChange` 事件 → `PersistentMCPRegistry.applyConnectionState` 持久化到 `mcp_servers.status / last_connected_at / last_error`；REVOKED 仍为终态。
- **有界重连**：`maxAttempts` + 指数退避（初始延迟 × factorⁿ，上限 maxDelayMs）；
  **单飞**（并发 reconnect 共享同一 cycle）；**可取消**（`cancelReconnect`，disconnect 亦会取消）；
  **防风暴**（同一 server 任何时刻最多一个 cycle；耗尽后停止）。
- 无状态 HTTP 没有常驻连接：连接丢失信号 = 请求失败（CONNECTION 类）或 transport onclose；
  两者都会触发 DEGRADED + 有界重连。connect() 失败不自动重连（由调用方/Registry 显式重试），避免风暴。
- **DEGRADED 语义**：已发现 Tool 不删除；refreshTools 在不可用时失败（不得把不可用 Tool 当健康）；
  执行返回统一 RuntimeError（TOOL_ERROR + details.mcpErrorCategory=CONNECTION），不绕过 ToolRuntime；
  恢复后 `refreshTools` 重新 tools/list 刷新 metadata。

## 5. credentialRef / authRef 与 Secret 隔离

- 引用优先级 `credentialRef ?? authRef`；**只存引用**（5.5-0 既有校验继续生效）。
- 解析：平台注入的 `MCPCredentialResolver({serverId, kind, reference})`，返回
  `string`（Bearer）或 `{headers}`；**不建立第二套 Secret Store / OAuth**。
- Fail-closed：无 resolver / 返回 undefined / resolver 抛错 → CONNECTION（消息只含引用名，不含内部细节）。
- 401/403 → `PERMISSION_DENIED` 分类（→ TOOL_ERROR），不重试、不泄漏。
- **Secret 不进入**：DB（mcp_* 全表扫描断言）、错误消息、ToolResult、状态事件、lastError
  （客户端 `redactCredentialShapedText` + Registry `applyConnectionState` 二次 redaction）。

## 6. Timeout / Cancellation

- ToolRuntime timeout → AbortSignal → HTTP 请求中止 → `TIMEOUT_ERROR`（外层计时器优先，5.5-2 语义不变）。
- AbortSignal 取消 → fetch abort → `CANCELLED_ERROR`。
- 连接超时（`connectionTimeoutMs`）→ 主动 close transport → `TIMEOUT` 分类。
- 未新增 RuntimeErrorCode；映射仍为 TOOL_ERROR / TIMEOUT_ERROR / CANCELLED_ERROR + `details.mcpErrorCategory`。

## 7. 数据库

- **无需迁移扩展**：`mcp_servers.endpoint` 与 `transport` 列在迁移 008 已预留；
  `status` 为 TEXT，`RECONNECTING` 直接写入（chemas/迁移未改）。
- `PgMCPRegistryStore.createServer` 已在 5.5-3 持久化 endpoint；本次验证
  （transport=streamable-http、endpoint、CONNECTED/lastConnectedAt/DEGRADED/lastError 均为 DB 断言）。

## 8. 安全测试矩阵（全部真实 HTTP + 真实进程）

invalid endpoint / unavailable server / authentication failure（401）/ credential missing /
resolution failure / malformed response / 404 endpoint / connection timeout / tool timeout /
cancellation / reconnect exhaustion / reconnect single-flight / reconnect cancel /
DEGRADED 状态持久化 / recovery → CONNECTED / 恢复后刷新 metadata /
DENY（binding/tool/server/policy）⇒ **服务端 hit counter 0 增量** / audit / native regression /
stdio regression（既有 152 用例含 5.5-1 全套）/ 第三方互操作 / secret 全链路隔离。

## 9. 已知限制 / Deferred

- OAuth authorization-code / consent / refresh lifecycle（SDK authProvider 接口未启用）→ 后续。
- 每个 Remote server 无独立并发限流（HTTP 层面未加 rate limit）→ Console/后续阶段按需。
- Resource/Prompt/MCP Apps/Console/REST API 均未实现（5.5-5 ~ 5.5-7）。
