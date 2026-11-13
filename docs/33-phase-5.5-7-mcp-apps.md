# Phase 5.5-7 — MCP Apps

> 状态：✅ 完成（2026-09-11）。6 项验收目标全部实现，全仓回归通过。
> 前置：5.5-0（契约冻结，docs/25）、5.5-1 ~ 5.5-6（docs/27–32）。

## 1. 验收目标

| # | 目标 | 实现 |
|---|------|------|
| 1 | UI Resource | `ui://` 资源走 5.5-6 既有资源架构（resources/list、resources/read、授权链）；工具 `_meta.ui.resourceUri` 归一化为稳定字段 `MCPToolDefinition.uiResourceUri` |
| 2 | sandboxed iframe | Web Console 通过 `sandbox="allow-scripts"`（无 same-origin/forms/popups/navigation）+ `srcdoc` 渲染，opaque origin，无 cookie/无 parent DOM |
| 3 | Host Bridge | 共享 zod strict schema + source 身份校验（`event.source === contentWindow`）；未知/非法消息一律丢弃，超尺寸参数显式拒绝 |
| 4 | controlled action | iframe → Host Bridge → `/api/mcp/apps/actions` → ToolRuntime → Permission/Policy/Approval → MCPToolAdapter；UI 不能指定任意 server/tool |
| 5 | Tool Runtime governance | 动作全部经现有 ToolRuntime 执行（timeout / cancellation / error normalization / audit / 风险模型复用） |
| 6 | credential isolation | 凭据只在 backend security boundary；iframe/HTML/URL/postMessage/frontend state 全程零凭据（结构化保证 + 测试断言） |

## 2. 架构

```text
Sandboxed iframe (opaque origin, allow-scripts only)
      ↓ postMessage (共享 strict schema, source 校验)
Host Bridge (apps/web/src/mcpAppBridge.ts)
      ↓ REST（浏览器只调用 AI-SE Backend）
/api/mcp/servers/:id/ui-apps | ui-resource | /api/mcp/apps/actions
      ↓
MCPAppService (apps/server/src/services/mcpAppService.ts)
      ↓ listVisibleToolDefinitions（bindings + policy，tool 级重查）
ToolRuntime ── execute ──▶ MCPToolAdapter ──▶ MCPClientPort ──▶ MCP Server
      (permission / approval gate / timeout / cancellation / recorder)
```

- UI Resource 读取走 `PersistentMCPRegistry.readResource`（5.5-6 capability 链），不新增旁路。
- 受控动作不经过 `client.callTool` 直呼：bridge → 后端 → ToolRuntime → adapter。
- `ui-apps` 列表走新增的 `PersistentMCPRegistry.listVisibleToolUiLinks(serverId, query)`：
  capability 门槛（server-scope 绑定）→ 实时 `listTools` → 逐个校验 tool 行 enabled +
  `isToolVisible`（tool 级授权链）→ 仅返回带 `_meta.ui` 的工具。拒绝时零 MCP 请求。

## 3. Host Bridge 协议

- 通道：`channel: "ai-se.mcp-app"`；消息类型：`app/ready`、`app/action`（app→host）；
  `host/init`、`host/action-result`（host→app）。
- 全部消息在两端复用 `@ai-se/shared` 的 zod strict schema：
  未知字段（含 `credentialRef` 之类的凭据形字段）与未知类型直接拒绝。
- 来源校验：只接受 `event.source === iframe.contentWindow`；sandboxed frame 为 opaque
  origin（origin 字符串为 `null`），因此按身份校验而非字符串 origin。
- 参数上限 `MCP_APP_MAX_ARGUMENT_BYTES = 64 KiB`（超限回 `MCP_APP_ARGUMENTS_TOO_LARGE`）。
- bootstrap 注入：`buildAppDocument` 在 app HTML 前插入受控 `<script>`，
  暴露 `window.aiseMcpApp.notifyReady()` / `requestToolCall(toolName, args)`；
  bootstrap 只使用 `postMessage`（无 fetch / storage / cookie）。
- Bridge 不执行 `callTool`：`onAction` 只调用 console REST API；实际执行在后端。

## 4. Controlled Action 授权链

1. `allowedTools`（host 侧从 app 上下文派生，UI 默认“只能调用其关联工具”）先校验；
2. server 由 host 绑定（消息 schema 无 serverId 字段，iframe 无法指定）；
3. tool 行存在且 enabled，`listVisibleToolDefinitions({projectId, agentName, serverIds:[serverId]})`
   产出可执行定义（binding 级拒绝 → 403，零请求）；
4. ToolRuntime.execute 时再次 `canExecute` 重查（revoke 后 stale 定义立即失效）；
5. requiresApproval → 现有 `approvalGate`（未配置时 fail-closed）。
6. timeout（默认 30s，可 100–60000 显式指定）、cancellation（路由 `res.on("close")` →
   `AbortController` → context.signal）、audit（ToolRuntime `result.audit` +
   可选 DI `ToolCallRecorder`）、错误归一化与脱敏（对外消息经
   `redactCredentialShapedText`）。
- 错误映射：PERMISSION_DENIED→403、APPROVAL_REQUIRED→403、TIMEOUT→504、
  CANCELLED→408、其余→502（消息脱敏），未知 tool→404。

## 5. API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/mcp/servers/:serverId/ui-apps?projectId&agentName` | 工具 `_meta.ui` 链接列表 |
| GET | `/api/mcp/servers/:serverId/ui-resource?uri&projectId&agentName` | `ui://` 文档（text/html 校验 + 1MB 上限），供 srcdoc |
| POST | `/api/mcp/apps/actions` | 受控动作（strict schema 校验） |

## 6. 测试

- `packages/mcp`：`mcpApps.e2e.test.ts`（真实 stdio + Streamable HTTP：`_meta.ui`
  归一化、`ui://` 清单/读取、SDK 对象零泄漏、app 链接可见性 + revoke 零请求）；
  `normalize.test.ts` 增加 `_meta.ui` 畸形输入用例。
- `apps/server`：`mcpAppsApi.e2e.test.ts`（真实 PG + 两个真实 MCP server，15 例）：
  ui-apps 授权/未授权（零 tools 调用）、ui-resource 授权/未授权（零 read）、
  非 `ui://` 400、未知资源 404、动作 allow（stdio + HTTP hit 计数）、未授权项目 /
  allowlist / 未知 tool / disabled tool / revoke 全部 403/404 且零请求、
  approval gate deny（零请求）/approve、timeout 504、cancellation 408（零请求）、
  recorder audit、失败消息脱敏 `[REDACTED]`、strict payload 校验 400 零请求。
- `apps/web`：`mcpAppBridge.test.ts`（10 例：sandbox 常量、bootstrap 注入、
  ready→init、action→result 转发、错误来源丢弃、未知/非法消息丢弃、超尺寸拒绝、
  委托异常降级、frame 消失）；`mcpSecurity.test.ts` 增加源码级守护
  （生产代码不得出现 `allow-same-origin` 等 token；app 视图必须用共享常量
  `:sandbox` + `:srcdoc`）。
- 计数基线：mcp 201、server 42、web 51（详见最终报告）。

## 7. 对冻结契约的影响（全部加法式）

- `MCPToolDefinition` + 可选 `uiResourceUri?: string`（工具面既有行为零变化；
  未携带 `_meta.ui` 的工具该字段为 undefined）。
- `MCPRegistryQuery` + 可选 `serverIds?: string[]` 过滤（既有调用方零影响）。
- `PersistentMCPRegistry` + 新方法 `listVisibleToolUiLinks`（新能力，不改旧方法）。
- `MCPClientPort` **零改动**（5.5-6 扩展后的 9 个方法原样）。
- `MCPToolAdapter` / `ToolRuntime` / 既有错误类别与审批语义零改动。

## 8. 已知限制

1. `tool_calls` 表 `agent_run_id` 有真实外键，独立 app 动作暂不写 `tool_calls`
   （recorder 为 DI；接入 agent run 后可直接复用）。audit 以 ToolRuntime
   `result.audit` + 可选 recorder 呈现。
2. `_meta.ui` 仅识别 `{ ui: { resourceUri: string } }` 形（当前协议/SDK 透传面）；
   其他扩展字段不解析、不猜。
3. App 页面需要手工输入 projectId / agentName（Console 无登录态；与 5.5-5 绑定
   表单同一约定）。UI 默认把 `allowedTools` 限制为 app 关联的那一个工具。
4. `ui://` 文档以字符串形式经后端转发进 `srcdoc`；未做 HTML 净化 —— 安全边界
   完全依赖 iframe sandbox（这也是设计选择：不信任、不解析 app HTML）。
5. MCP Apps Marketplace、OAuth、Resource/Prompt 持久化、Apps 管理后台、Browser
   Automation / Visual Evaluation（5.6/5.7）均未实现（严格边界）。
