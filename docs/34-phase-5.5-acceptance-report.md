# Phase 5.5 验收报告 — Global Regression Gate(5.5 → 5.6)

> 报告日期:2026-09-11(CST)
> 门禁性质:Phase 5.5 → Phase 5.6 正式回归门禁(Regression Gate,非开发阶段)
> 结论文栏:

| 结论 | 状态 |
|------|------|
| GLOBAL REGRESSION | **PASS** |
| Phase 5.5 冻结 | **FROZEN** |
| Phase 5.6 就绪 | **READY** |

---

## 1. 执行环境

| 项 | 值 |
|---|---|
| 操作系统 | macOS 26.6.2 |
| Node | v22.22.2(nvm) |
| 包管理 | corepack pnpm 12.3.4 |
| 数据库 | PostgreSQL 16(docker 一次性测试容器,runMigrations 顺跑) |
| 测试框架 | vitest 5.0.0(仓库统一 `pnpm -r run test`) |
| 版本控制 | 仓库无 `.git`,Commit 按 2026-09-11 目录快照记录 |
| 验收执行次数 | 2 次完整执行(16:15 首检、16:27 复检,两次均为全新跑,零结果沿用) |

## 2. 全局质量门禁(两次执行结果一致)

| 门禁 | 命令 | 结果 |
|------|------|------|
| Typecheck | `corepack pnpm -r run typecheck` | PASS(exit 0,10 包,未放宽 strict) |
| Lint | `corepack pnpm -r run lint` | PASS(exit 0,未改规则) |
| Test | `corepack pnpm -r run test` | PASS(exit 0,**394/394**) |
| Build | `corepack pnpm -r run build`(web vite + mcp/server tsc) | PASS(exit 0) |
| 数据库 | migration 001–008 + checksum | PASS(sha256 校验强制,未动 checksum) |

### 2.1 测试明细(Total 394 / Passed 394 / Failed 0 / Skipped 0)

| 包 | 用例数 | 阶段归属 |
|---|---|---|
| packages/observability | 2 | Phase 0 |
| packages/shared | 11 | Phase 0 / 5.5 契约 DTO |
| packages/workflow-engine | 14 | Phase 4 |
| packages/sandbox | 2 | Phase 0 |
| packages/tool-runtime | 11 | Phase 2(Native Tool 边界) |
| packages/agent-core | 27 | Phase 2/3(AgentRunner / LangGraph / Professional Agents) |
| packages/mcp | 201 | Phase 5.5-0 ~ 5.5-7 |
| packages/database | 33 | Phase 2/4/6 持久化 + 5.5-3/4/5(真实 PG) |
| apps/server | 42 | 各阶段 API/生命周期 e2e + 5.5-5/5.5-7 MCP e2e(真实 PG + 双真实 MCP server) |
| apps/web | 51 | Phase 6 前端 + 5.5-5/5.5-7 Console/桥协议 |

### 2.2 Phase ↔ 测试映射

| Phase | 关键测试文件 | 结果 |
|---|---|---|
| Phase 0–5 | tool-runtime 11、agent-core 27、workflow-engine 14、database 运行时、server(workflow/delivery/planning/professional/agentRun e2e)42 | PASS |
| 5.5-0 契约冻结 | `contracts.test`、`mockContract` | PASS |
| 5.5-1 stdio | `stdioMCPClient.e2e`、`clientErrors`、`errors`、`jsonSchemaToZod` | PASS |
| 5.5-2 Federation | `federation.e2e`、`visibility`、`persistentRegistry.test` | PASS |
| 5.5-3 持久化 | database `mcpRegistryStore.test`、`mcpFederation.e2e`(独立真实 PG 容器) | PASS |
| 5.5-4 Remote | `remoteMCPClient.e2e`、`remoteErrors`、`mcpRemoteFederation.e2e` | PASS |
| 5.5-5 Console | server `mcpConsoleApi.e2e`(8) | PASS |
| 5.5-6 Resource/Prompt | `resourcePrompt.e2e`(15)、`resourcePromptSecurity.e2e`(8)、`remoteResourcePrompt.e2e`(7)、`normalize`(8) | PASS |
| 5.5-7 MCP Apps | `mcpApps.e2e`(7)、server `mcpAppsApi.e2e`(15)、web `mcpAppBridge.test`(10)、`mcpSecurity.test`(6) | PASS |

传输层真实性:stdio 与 Streamable HTTP 均为官方 `@modelcontextprotocol/sdk` 真实协议进程/HTTP fixture,并含第三方 server(`@modelcontextprotocol/server-everything`)互操作用例。

## 3. 数据库回归

- [x] 全新环境 migration 001→008 顺跑(共享 helper 起真实 PG16 容器)
- [x] `008_phase5_mcp_registry.sql` 应用成功(mcp_servers / mcp_tools / mcp_tool_bindings)
- [x] Migration checksum(sha256)校验强制通过,未修改任何 checksum
- [x] 既有表无计划外结构变更(migrate 断言 + 各 repository 测试)
- [x] Agent Run / Task / Tool Call / Workflow Run / Workflow Event persistence 全通过(`agentRunStores.test`、`workflowRepositories.test`、`agentRunPersistence.e2e` 等)
- [x] MCP registry / server 状态 / tool 状态 / binding 状态重启存活:"restores state after a restart and keeps revocations revoked" 通过
- 结论:**Database PASS**

## 4. 架构边界回归(源码级扫描实证)

### 4.1 边界保持

```text
Workflow Engine(域工作流层)
  → Task / Agent Run
  → Agent Runtime(执行层)
  → ToolRuntime(治理边界)
  → Native Tool / MCPToolAdapter
  → MCPClientPort(stdio / Streamable HTTP)
  → External System
```

- [x] agent-core / workflow-engine 源码零 `@ai-se/mcp`、零 `MCPClientPort` / `MCPRegistry` 引用(本次扫描零命中)
- [x] AgentRunner / AgentGraph / LangGraph / Professional Agents 零修改、零 MCP 分支,测试全绿
- [x] MCP 严格位于 ToolRuntime 边界之下;MCP 包无 workflow / task / retry / approval 生命周期实现
- [x] Native Tool 路径、风险模型、审批、超时、取消、错误归一化、审计语义全部 unchanged

### 4.2 Browser → MCP 边界(web 生产 bundle 扫描)

| Token(bundle) | 命中 |
|---|---|
| `modelcontextprotocol` | 0 |
| `MCPClientPort` | 0 |
| `StdioMCPClient` / `RemoteMCPClient` | 0 |
| `tools/call` / `listTools` | 0 |
| `ai-se.mcp-app`(应用侧桥常量,合法) | 1 |

- [x] web 源码/依赖零 `@modelcontextprotocol`、零 `@ai-se/mcp`(`mcpSecurity.test` 守护)
- [x] Browser 仅经 AI-SE Backend REST;App iframe 仅经 Host Bridge
- [x] server 路由无 JSON-RPC / tools/call 代理端点(5.5-5 断言保留)
- 结论:**Browser 不是 MCP Client**

## 5. 安全回归

### 5.1 治理体系(无双系统)

| 能力 | 判定 | 证据 |
|------|------|------|
| Permission | 复用,无第二套 | 引擎类扫描(AcceptancePermission/…Engine)零命中;Mcp action 走运行时可见性链 |
| Approval | 复用,失败关闭 | 既有 gate;拒绝零请求 |
| Audit | ToolRuntime audit + DI recorder | 无独立存档引擎 |
| 限时 | ToolRuntime 复用 | 504 路径 |
| Cancellation | ToolRuntime signal 复用 | 408 + 零请求断言 |
| Error 归一化 | MCP 9 类 → 既有 RuntimeErrorCode | 映射未改 |
| Secret 脱敏 | 单一 `redactCredentialShapedText` | 无第二套 |

### 5.2 凭据隔离

- [x] 所有 MCP e2e 响应原始 JSON 断言:零 env 标记 / `Bearer ` / token 文本
- [x] 错误消息脱敏实证:`sk-live…` → `[REDACTED]`;DTO 仅含 `credentialRef` / `authRef` 引用
- [x] iframe HTML / URL / postMessage / frontend state 结构化零凭据(schema 层禁止凭据形字段)
- [x] 未授权 / disable / revoke / policy / approval 拒绝 → **在 MCP Server 收到请求前失败**(stdio 计数器 + HTTP `__hits` 双重零请求断言)
- 结论:**Security PASS**

## 6. MCP Apps 专项回归(5.5-7 首次纳入门禁)

### 6.1 浏览器侧

- [x] iframe `sandbox="allow-scripts"` 独此一项(生产代码零 `allow-same-origin` / forms / popups / navigation 命中;唯一命中在守护测试自身的禁止列表)
- [x] `srcdoc` 渲染 → opaque origin:无法访问父级 DOM、cookie、后端凭据
- [x] srcdoc 安全文档无 HTML/净化的弃守(由孤岛式运行 sandbox 承担)

### 6.2 Host Bridge 拒绝矩阵(全部“丢弃 + 零执行”)

- [x] 共享 `@ai-se/shared` zod strict schema(两端同一份)
- [x] `event.source !== contentWindow` → 丢弃
- [x] 未知类型 / 非法负载 / 缺 `id` / 凭据形字段(`credentialRef`) → 丢弃
- [x] 超过 64 KiB 参数 → `MCP_APP_ARGUMENTS_TOO_LARGE`
- [x] 桥不执行 `callTool`;bootstrap 仅 postMessage(无 fetch/storage/cookie)

### 6.3 Controlled Action 授权链(11 级)

`allowedTools` → host 绑定 serverId(schema 无 serverId,iframe 无法指定)→ tool enabled → visibility 链 → ToolRuntime `canExecute` 调用时重查 → approvalGate → 执行 → adapter → client port。

- [x] 关联工具放行;任意 tool/server 拒绝;disabled / revoked 拒绝
- [x] HTTP 映射实测:403(权限)、403(approval)、404(未知 tool)、504(超时)、408(取消)、502(其余)、400(strict payload) — 全部零 MCP 请求
- [x] stdio 与 Streamable HTTP 双通道动作执行可行
- [x] audit:ToolRuntime `result.audit` + DI ToolCallRecorder(started/finished 记录)

## 7. 失败项

- **No regression found / No code changes required**(两次门禁执行均 0 代码改动、0 测试修改、0 策略放宽)
- 过程备注(非回归):`pnpm --filter @ai-se/server exec vitest run`(不带 `src`)会误扫 build 产物 `dist/**` 报 Vitest CommonJS 导入错误;仓库统一 script `vitest run src` 正常(12/12 文件、42/42)。属调用方式,无需修复。

## 8. 技术债务(既有记录,本次零新增,均不阻塞 Phase 5.6)

| 编号 | 项 | 来源 |
|---|---|---|
| TD-1 | 3 条 ARCHITECTURE WARNING(平台统一化缺口,非 MCP 重复建设) | docs/28 |
| TD-2 | 独立 MCP App action 暂不写 `tool_calls`(FK 需真实 agent_run_id;recorder 为 DI,接入 agent run 后直接复用) | docs/33 |
| TD-3 | `_meta.ui` 仅识别 `{ ui: { resourceUri } }` 稳定结构 | docs/33 |
| TD-4 | App 页面手工输入 projectId / agentName(Console 无登录态,与 5.5-5 绑定表单同约定) | docs/33 |
| TD-5 | `ui://` HTML 无净洗 —— 安全边界完全依赖 iframe sandbox(设计选择) | docs/33 |
| TD-6 | Marketplace / OAuth / Resource-Prompt 持久化 / Apps 管理后台未实现(严格边界) | docs/31/32/33 |
| TD-7 | agent 绑定用 agent_name(无 agents 表,5.5-2 契约即 agentName)+ env/cwd 有据偏差 | docs/29 |

## 9. Phase 5.6 就绪声明

1. **Phase 5.5 是否可以 Frozen?** — 可以。17 项验收标准(Phase 0–5、5.5-0~7、typecheck、lint、build、database、integration、e2e、security、architecture)全部 PASS,冻结契约(MCPClientPort 9 方法、MCPErrorCategory 9 类、RuntimeErrorCode 8 类、ToolDefinition 模型)无任何修改。
2. **是否存在阻塞 Phase 5.6 的问题?** — 无。
3. **是否存在需要记录但暂不处理的技术债务?** — 有,§8 TD-1~TD-7 全部为既有记录、无新增,均不阻塞。
4. **本次是否实现了任何 Phase 5.6 功能?** — 没有。Visual Contract / Visual Analysis / UI Specification / Browser Runtime / Screenshot / Visual Diff / Auto Fix / Auto Re-plan / Responsive Evaluation / Interaction Validation 零触碰。

---

## 最终结论

```
GLOBAL REGRESSION: PASS
PHASE 5.5: FROZEN
PHASE 5.6: READY
```

*本报告基于 2026-09-11 两次完整全局回归(全 typecheck / lint / test / build / 数据库 migration / 架构与安全静态扫描)的实际工具输出,未沿用任何历史结果;所有断言数字可由 `/tmp/gate2-*.log` 复查。*
