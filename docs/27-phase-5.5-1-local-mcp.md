# Phase 5.5-1 / 5.5-2 — Local MCP 与 Tool Runtime Federation（实现说明）

> 状态：✅ 完成。5.5-1 实现真实 stdio 连接；5.5-2 将 MCP Tool 接入现有 Tool Runtime。
> 未接入 Agent Runtime 核心循环 / Workflow Engine；未做持久化、HTTP、OAuth、Console。

## 1. SDK

- 官方 MCP TypeScript SDK：`@modelcontextprotocol/sdk` **1.30.0**（Node >= 18），安装在 `packages/mcp`。
- 不自行实现 MCP Protocol。
- 导入路径（SDK exports map）：`client`、`client/stdio.js`、`server/mcp.js`、`server/stdio.js`、`types.js`。

## 2. 实现内容（packages/mcp/src）

| 文件 | 内容 |
| ---- | ---- |
| `client/MCPClientError.ts` | 携带 declared `MCPErrorCategory` 的客户端错误类型；`classifyMCPError` 直接识别，无需启发式 |
| `client/StdioMCPClient.ts` | 实现 5.5-0 冻结的 `MCPClientPort`：connect（spawn + initialize）、disconnect、listTools、callTool（AbortSignal 透传）；SDK 错误 → 冻结类别归一化；`pidOf()` 供测试/观测 |
| `testing/fake-server-entry.js` | 官方 SDK 版 fake MCP server（CJS 入口，作为真实子进程被 spawn）：echo / slow / failing |
| `testing/fakeMCPServer.ts` | `createFakeMCPServerDefinition()` + 工具名常量，测试与后续 Phase 复用 |

### 客户端语义（冻结）

- `connect`：校验 `MCPServerDefinition`（冻结 credential guard）→ 拒绝 disabled / 重复 id（**双 connect 不产生第二个进程**）→ `StdioClientTransport`（stderr: "pipe" + resume）→ `client.connect()` 完成 initialize。失败统一 `CONNECTION`。
- `disconnect`：`client.close()` + `transport.close()`（清理阶段错误吞掉），并保证 child 进程退出；未连接时抛 `CONNECTION`。
- `callTool`：arguments 必须为对象，非对象输入包装为 `{ input }`；`AbortSignal` 透传给 SDK RequestOptions；`isError` 结果 → 抛 `REMOTE_TOOL`（文本拼接为 message）；进程死亡后由 onclose 清理映射，后续调用抛 `CONNECTION`。
- 成功返回 SDK 的 `CallToolResult` 原始对象（content/structuredContent），5.5-2 决定内容解包。
- SDK 错误映射（`classifyMCPClientError`，纯函数）：`RequestTimeout→TIMEOUT`、`ConnectionClosed→CONNECTION`、`MethodNotFound/InvalidParams/InternalError→REMOTE_TOOL`、其他协议错误→`INTERNAL`、aborted/`AbortError`→`CANCELLED`。随后经 `mapMCPErrorToRuntimeError` 映射到已有 `RuntimeErrorCode`（5.5-0 冻结），不新增 code。

## 3. Fake MCP Server 契约

基于官方 SDK `McpServer` + `StdioServerTransport`，真实 stdio 子进程：

| Tool | inputSchema | 语义 |
| ---- | ----------- | ---- |
| echo | `z.record(z.string(), z.unknown())` | 原样返回输入 JSON（text content 内 JSON 编码） |
| slow | `{ delayMs: number 0..60000 }` | 延迟后返回 `{ delayMs, waitedMs }`；支持客户端取消 |
| failing | `{ message?: string }` | 恒返回 `isError: true`，可预测失败 |

## 4. 测试（vitest，全部真实协议）

- `stdioMCPClient.e2e.test.ts`（12）：connect/initialize、tools/list 目录、echo 往返、slow 延迟返回、failing→REMOTE_TOOL→TOOL_ERROR、未知工具→REMOTE_TOOL、双 connect 单进程、disconnect 后调用拒绝 + 进程退出（pid 轮询）、无效命令→CONNECTION、disabled→CONNECTION、AbortSignal 取消→CANCELLED→CANCELLED_ERROR。
- `thirdPartyMCP.e2e.test.ts`（4）：**第三方真实连通性证明** —— `StdioMCPClient` 直连官方
  `@modelcontextprotocol/server-everything` 参考服务器（devDependency，SDK 仓库自带的
  conformance server，独立实现，非本仓库 mock）：initialize、真实目录（echo/get-sum 等）、
  echo 调用返回 `Echo: ...`、get-sum 计算返回、第三方参数校验失败归一化为 REMOTE_TOOL。
- `clientErrors.test.ts`（8）：SDK McpError 各 code 到冻结类别的纯函数映射。
- 5.5-0 的 47 个契约/可见性/mock 测试全部保持通过（`FakeMCPClient` 夹具不动）。

## 5. Phase 5.5-2：Tool Runtime Federation

### 调用链（冻结）

```
Agent → ToolRuntime.execute（Zod 校验 / audit / timeout / cancellation / 错误归一化）
      → ToolDefinition.execute
      → MCPToolAdapter.execute（canExecute → approvalGate → MCPClient.callTool）
      → 官方 SDK → MCP Server
```

### 新模块（packages/mcp/src/integration/）

| 文件 | 内容 |
| ---- | ---- |
| `jsonSchemaToZod.ts` | 最小可靠 JSON Schema → Zod：object/properties/required/additionalProperties、string/number/integer/boolean/array/items、enum/const、min/max(length/items)。不支持的关键字显式抛 `JSONSchemaConversionError`，绝不 silently 放宽。`additionalProperties` 缺省 = true（JSON Schema 语义）→ passthrough |
| `adapter.ts` | `createMCPToolAdapter`（冻结 MCPToolAdapterFactory 契约）+ `toUnifiedToolDefinition` + `mcpCallToolResultToData`（CallToolResult → 纯数据，structuredContent 优先，协议对象不外泄） |
| `registry.ts` | `MCPToolRegistry`：registerServer / connect / refreshTools(tools/list) / bindProject / bindAgent / `listVisibleToolDefinitions(query)` |

### 安全边界

- 可见性链（默认 DENY，全部满足才可见）：server registered → enabled → project binding → agent binding → tool allowlist → policy（policyProvider 返回 undefined = DENY）。
- **调用时二次校验**：Adapter 的 `canExecute` 在发送任何请求前重新执行可见性链 —— 绑定被撤销后，即使 ToolDefinition 已进入 ToolRuntime，MCP Server 也收不到请求（E2E 用 requestCount 断言 = 0）。
- **Approval**：policy.requiresApproval 时走平台 `approvalGate`；无 gate 即 fail-closed（APPROVAL_REQUIRED）。
- **Risk**：`ToolDefinition.riskLevel` 只来自平台 policy，不信 MCP Server 自报；随 audit 记录。
- **Audit**：MCP 调用进入现有 ToolRuntime 的 `ToolCallRecorder`（started/finished/tool_calls），无第二套 Audit。
- **Timeout / Cancellation / 校验**：全部由现有 ToolRuntime 提供（withTimeout、AbortSignal、inputSchema.safeParse）。
- **错误**：`mapMCPErrorToRuntimeError` 只产出已有 RuntimeErrorCode（TOOL_ERROR/TIMEOUT_ERROR/CANCELLED_ERROR），MCP 类别进 `details.mcpErrorCategory`。

### 测试（federation.e2e.test.ts，真实 stdio server，15 用例）

注册/发现、默认 DENY、disabled server、绑定可见性（风险来自 policy）、echo 成功 + audit 记录、
failing→TOOL_ERROR(REMOTE_TOOL)、Zod 校验失败零请求、撤销绑定后调用时 DENY 零请求、
agent toolNames 白名单 + policy 拒绝、approval 阻断/放行（零请求 vs 放行）、
timeout→TIMEOUT_ERROR（recorder timed_out）、外部取消→CANCELLED_ERROR、
杀掉 server 进程→统一错误、Native Tool（createPhase1Tools）不受影响、CallToolResult 数据转换。
另 `jsonSchemaToZod.test.ts` 12 用例。

## 6. 边界（5.5-2 仍未做）

- 持久化 / migration / CRUD / API（5.5-3）：registry 为内存实现，语义与 5.5-0 冻结的
  `isMCPToolVisible` 一致，5.5-3 可换数据库后端而不改契约。
- HTTP / OAuth / Secret Provider / Console / Resource / Prompt / Apps（5.5-4 ~ 5.5-7）。
- Agent Runtime 核心循环、Workflow Engine、ToolRuntime 契约：零修改。
  Agent 侧发现 = 现有 `createLangChainTools(runtime.getToolDefinitions())` 的组成过滤。

## 7. 已知限制

- `failing` 的 isError 结果只能携带文本 message，类别默认为 REMOTE_TOOL（服务端可分类错误通道属后续扩展）。
- `fake-server-entry.js` 为纯 CJS 脚本，测试经 `__dirname` 定位 src 路径；dist 构建不复制该文件（当前无 dist 消费方）。
- 工具级 Approval 门是本阶段在 MCP 层新增的可插拔钩子；仓库既有 Approval 实体（shared）是任务/工作流级，5.5-3+ 可将 approvalGate 接回它们。
- 同名工具冲突（两个 MCP server 暴露同名 tool，或与 Native 同名）由 ToolRuntime 既有的 duplicate check 显式报错，不做隐式改名。
