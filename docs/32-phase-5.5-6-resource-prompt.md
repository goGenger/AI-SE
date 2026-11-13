# Phase 5.5-6 — MCP Resource / Prompt（实现说明）

> 状态：✅ 完成。resources/list、resources/read、prompts/list、prompts/get 全部经真实 MCP 协议实现（stdio + Streamable HTTP）；独立 Adapter；权限/策略/审计/错误/超时/取消/脱敏全部复用既有机制。
> 未实现（边界）：Resource/Prompt 持久化、Console 展示、OAuth、MCP Apps、5.5-7。

## 1. 交付物

| 位置 | 内容 |
| ---- | ---- |
| `packages/mcp/src/contracts.ts` | 唯一一次冻结契约扩展：`MCPClientPort` +4 方法（listResources / readResource / listPrompts / getPrompt）；新增稳定结构 `MCPResourceDescriptor / MCPResourceContent / MCPResourceReadResult / MCPPromptDescriptor / MCPPromptArgument / MCPPromptMessage / MCPPromptMessageContent / MCPPromptResult / MCPCapabilityPolicy`。tool 面零改动 |
| `packages/mcp/src/client/normalize.ts` | SDK 对象 → 稳定结构；畸形负载抛已分类的 `MCPClientError`（INTERNAL），MCP SDK 对象永不外泄 |
| `packages/mcp/src/client/StdioMCPClient.ts`、`RemoteMCPClient.ts` | 4 个新方法的真实实现（官方 SDK）；错误经既有分类器；remote 复用 known-secrets 脱敏 |
| `packages/mcp/src/integration/capability.ts` | 共享运行时管线：timeout（与 ToolRuntime.withTimeout 同语义）、取消、错误归一化 + `redactCredentialShapedText`、DI audit sink（零存储） |
| `packages/mcp/src/integration/resourceAdapter.ts` | **独立** `MCPResourceAdapter`（resources/list、resources/read） |
| `packages/mcp/src/integration/promptAdapter.ts` | **独立** `MCPPromptAdapter`（prompts/list、prompts/get） |
| `packages/mcp/src/registry/persistentRegistry.ts` | 追加 `listVisibleResources / readResource / listVisiblePrompts / getPrompt` + `resourcePolicyProvider / promptPolicyProvider`；server-scope 绑定行 + 调用时重查 + fail-closed |
| `packages/mcp/src/testing/fake-capabilities.js`（新） | 两个 fake server 共享的 resources（greeting/binary/slow/malformed/leaky）+ prompts（welcome/code_review/attach）注册 |
| `packages/mcp/src/testing/{fake-server-entry.js, fake-http-server-entry.js}` | 接入上述共享夹具（既有 tools 保持不变） |

**Resource / Prompt 不是 ToolDefinition**：没有执行语义，不进入 Tool Runtime 的 ToolDefinition 模型，也没有任何工具化包装。

## 2. Adapter 设计

```
caller（Registry / 未来 Agent 集成）
  ↓
MCPResourceAdapter / MCPPromptAdapter        ← 独立、无 Tool 耦合
  │  1. assertAccess()  —— 调用时权限重查（默认拒绝；拒绝不触达 client）
  │  2. policy()        —— provider 返回 undefined ⇒ DENY（逐资源/逐 prompt）
  │  3. withCapabilityTimeout(timeoutMs, signal) —— timeout/取消，先于请求生效
  │  4. client.listResources/readResource/listPrompts/getPrompt（真实 SDK）
  │  5. 归一化 → 稳定结构；错误 → 既有 MCPErrorCategory + 脱敏
  │  6. audit sink（DI，无状态；事件含 outcome/分类/耗时）
  ↓
MCPClientPort → StdioMCPClient / RemoteMCPClient → MCP Server
```

- 每次操作都会执行 1–2 两道门；**任意拒绝在任何 MCP 请求之前抛出**（测试以计数器/HTTP hit 数证明为 0）。
- `canAccess`/`policy`/`audit` 全部为依赖注入，与 5.5-2/5.5-3 的 `canExecute`/`policyProvider`/`approvalGate` 同一模式；MCP 层不存储、不管理任何状态。

## 3. 权限 / 策略 / 审计复用

| 机制 | 复用方式 |
| ---- | ---- |
| Permission | 同一 store-backed 授权链（5.5-3）：Server enabled → Project binding → Agent binding，调用时重查，revoke 立即生效。Resource/Prompt 使用 **server-scope 绑定行**（`mcp_tool_id IS NULL`）；tool 级绑定行绝不授权 capability。不新增权限实体、不改 AgentPermissions（其 allowlist 仅治理 tool） |
| Policy | 同一 provider 模式：`resourcePolicyProvider` / `promptPolicyProvider` 返回 `undefined` ⇒ DENY（fail-closed）；缺省时被授予的资源/prompt 记 `riskLevel: LOW`。不采信 MCP Server 自报 |
| Audit | **DI sink**（`MCPCapabilityAuditEvent`：capability/serverId/target/outcome/duration/errorCategory）。MCP 层零存储、零引擎 —— 事件由平台侧接入既有审计/事件通道（与 approvalGate 同为纯 DI）。拒绝/失败同样出事件 |
| Timeout / Cancellation | `withCapabilityTimeout` 与 `ToolRuntime.withTimeout` 同语义（外部 signal + 计时器 → abort 内部请求），拒绝分类 TIMEOUT / CANCELLED |
| Error | 只使用既有 `MCPErrorCategory`（9 类）与 `mapMCPErrorToRuntimeError` → 既有 RuntimeErrorCode；不新增错误码 |
| Secret Redaction | `redactCredentialShapedText` 应用于所有可能外泄的错误消息（含 remote known-secrets）；测试用 leaky 资源（真实 server 返回 token 形态文本）验证 `[REDACTED]` |

## 4. 测试（192/192 通过，mcp 包）

| 文件 | 数量 | 覆盖 |
| ---- | ---- | ---- |
| `normalize.test.ts` | 6 | text/blob/mixed、descriptor/参数元数据、prompt 消息四类内容、全部畸形负载 |
| `resourcePrompt.e2e.test.ts`（真实 stdio） | 15 | list/read（text+blob+mimeType/uri）、字段白名单、未知资源/未知 prompt/非法参数（REMOTE_TOOL）、malformed（INTERNAL）、prompt 参数传递、embedded resource 转换、工具面回归、timeout、取消（pre/mid）、audit 事件（成功/拒绝/失败）、脱敏 |
| `resourcePromptSecurity.e2e.test.ts`（真实 stdio + 计数 client） | 8 | 无授权→零请求、project-only→拒绝、tool 级绑不定授权、双绑定放行、revoke 后立即零请求、已构建 adapter 调用时重查零请求、disabled/REVOKED→零请求、policy 逐项拒绝→零请求 |
| `remoteResourcePrompt.e2e.test.ts`（真实 Streamable HTTP） | 7 | list/read/blob、prompts+参数、错误分类、拒绝→HTTP hit=0、policy 拒绝→hit=0、脱敏、工具面回归 |
| `contracts.test.ts`（更新） | +4 断言 | 端口新方法冻结 |

**Regression**：5.5-0 ~ 5.5-5 全部既有测试保持通过（见全仓验证）。

## 5. 契约影响（如实汇报）

- `MCPClientPort` 按本阶段指令做了唯一一次**加法式**扩展（4 方法）；全部既有实现（2 个真实 client + 4 个测试替身 + 夹具）同步更新，`listTools/callTool` 行为与测试零变化。
- `PersistentMCPRegistry` 仅新增方法/可选 provider（既有方法与工具链语义未动）。
- `MCPRegistryStore`、migration 008、Console API、ToolRuntime、Agent Runtime：**零改动**。
- 无 CONTRACT CONFLICT / ARCHITECTURE CONFLICT。

## 6. 已知限制

1. Resource/Prompt 无持久化（按边界要求）：发现/读取实时经 MCP Client；逐资源授权完全依赖 provider（无 provider 时被授予 server 的全部资源可见）。
2. Capability 授权复用 server-scope 绑定行（无独立 capability 授权表）：tool 级绑定不授权 capability；若未来需要资源级持久化授权，需另行设计（本阶段明确不做）。
3. Agent 集成（把 resource/prompt 暴露给 Agent 组合层）不在本阶段；适配器与 Registry 方法已就绪。
4. list 操作不携带 AbortSignal（按冻结端口签名），timeout 仅覆盖 read/get。
5. leaky 等夹具错误在 client 层携带原文（协议层不脱敏），适配器层（对外边界）脱敏 —— 5.5-1 冻结行为未改动。
