# Phase 5.5-2 Architecture Audit Report

> 状态：只读审计，未修改任何代码。
> 审计对象：`packages/mcp` 的 5.5-2 Tool Runtime Federation 实现（integration/adapter.ts、integration/registry.ts、integration/jsonSchemaToZod.ts）及其与 `packages/tool-runtime`、`packages/agent-core` 的边界。
> 审计日期：2026-09-10

## 结论

**PASS**（3 项 ARCHITECTURE WARNING，0 项 CONTRACT CONFLICT）

---

## 1. MCP Tool 实际执行链 ✅ PASS

以代码实测（`adapter.ts:92-146`、`ToolRuntime.ts:80-173`）为据：

```text
Agent (AgentGraph.toolsNode)
 → ToolRuntime.execute
    ├─ audit started（ToolCallRecorder）
    ├─ AbortSignal 预检
    ├─ Zod safeParse（ToolRuntime 内）
    ├─ withTimeout（timeoutMs → controller）
    └─ ToolDefinition.execute（toUnifiedToolDefinition 包装）
        → MCPToolAdapter.execute
           ├─ canExecute()（权限/绑定重查）← 拒绝即 throw，零网络
           ├─ approvalGate()（仅当 policy.requiresApproval）← 拒绝即 throw，零网络
           └─ client.callTool() → 官方 SDK → stdio → MCP Server
```

严格成立：Permission/Approval 检查全部发生在 `MCPClient.callTool` **之前**，与任务书要求的链序一致。DENY 路径抛出 `ToolExecutionError`，由 ToolRuntime 统一归一化并记录 audit。

## 2. Permission / Risk / Approval 是否有 MCP 层重复实现 ⚠️ WARNING

- **Permission**：`MCPToolRegistry` 的 project/agent bindings 是 5.5-0 冻结的 `mcp_tool_bindings` 授权模型的内存前身，不是第二套权限引擎。**但**它与 agent-core 既有的 `AgentPermissions.tools` 白名单互不相通（registry 里 agentName 是自由字符串，未与 AgentRegistry 身份对接）。两套授权输入并存 → WARNING，5.5-3 落库时必须打通。
- **Risk**：复用 `ToolDefinition.riskLevel` 同一字段流入 audit，零重复 ✅。
- **Approval**：MCP 层**零状态、零实体、零流转**。仅有一个布尔决策钩子。且与既有 native 模式同构——`deliveryTools.ts:63-78` 的 `assertPermission(actor 检查 + context.metadata.approved 标志)` 就是平台现有工具级批准模式（内联、无引擎）。MCP 用回调实现同形状的执行点，不算第二套 Approval，但两条通道未统一 → WARNING（可延期）。

## 3. policyProvider / canExecute 是否为 MCP-specific authorization ⚠️ WARNING

**是 MCP-specific**，但有正当性：`MCPToolPolicy` 本身是 5.5-0 冻结产物（"risk/approval 由平台决定，不信 server 自报"）。仓库**本来就不存在统一 Platform Tool Policy 引擎**（5.5-0 已核实），所以这不是"第二套 policy"，而是"目前唯一一套工具级 policy 接口，作用域限 MCP"。需标记：未来平台统一 policy 出现时，`MCPToolPolicy` 必须并入，不得长期并存。

另注意 `canExecute` 闭包捕获组成期 query（projectId/agentName）快照——已文档化，且与 ToolDefinition 不携带调用者身份的既有形状一致。

## 4. approvalGate 是否只是 DI 接口 ✅ PASS（无 CONFLICT）

`approvalGate: (context) => boolean | Promise<boolean>`（registry.ts:35）——纯依赖注入。MCP 层：

- 不创建、不存储、不流转任何 Approval 状态；
- 不引用 shared 的 Approval 实体（PENDING/APPROVED/REJECTED）；
- 未配 gate 时 fail-closed。

批准"状态管理"完全留给平台（5.5-3+ 可接回 shared Approval）。**非 ARCHITECTURE CONFLICT**。

## 5. 绑定撤销 → 执行前 DENY + requestCount = 0 ✅ PASS

- 代码路径：`adapter.ts:96-105` 每次执行重查 `isToolVisible`（registry.ts:181-208 全链重算）。
- 实证：`federation.e2e.test.ts` 15/15 PASS，其中 "DENIES at call time after a binding is revoked (zero MCP requests)" 用真实 stdio server + CountingMCPClient 断言撤销后 `requestCount("echo")` 不变（0 请求到达 MCP 层）。

## 6. Native 与 MCP 共享 ToolRuntime 能力矩阵

| 能力 | 共享情况 | 判定 |
| ---- | ---- | ---- |
| timeout | 同一 `withTimeout` 路径 | ✅ 真共享 |
| cancellation | 同一 `context.signal` 路径 | ✅ 真共享 |
| audit | 同一 `recordStarted/Finished` | ✅ 真共享 |
| error normalization | 同一 `normalizeRuntimeError` | ✅ 真共享 |
| risk | 同一 `ToolDefinition.riskLevel` → audit | ✅ 真共享 |
| permission | ToolRuntime 内部**两者都没有**；native 在 ToolRuntimeBackend/组成期，MCP 在 registry+adapter | ⚠️ 机制不同（现状一致） |
| approval | native 仅 delivery 工具内联 `assertPermission`；MCP 走 gate | ⚠️ 不对称（MCP 覆盖更全） |

结论：5 项运行时能力真共享；permission/approval 属"ToolRuntime 边界外的执行点"，两侧形状不同是本阶段可见的平台级统一缺口，非回归。

## 7. Agent Runtime 是否只依赖统一 ToolDefinition ✅ PASS

`grep @ai-se/mcp|MCPTool|mcpServer packages/agent-core` → **0 命中**。AgentGraph 只消费 `runtime.getToolDefinitions()` 的 name/description/inputSchema 并调 `toolRuntime.execute`。MCP 协议对象无泄漏（adapter 的 `mcpCallToolResultToData` 丢弃 `_meta`/`isError`，返回纯数据）。

## 8. Adapter 是否越权 ✅ PASS（1 处轻度冗余）

承担内容：协议调用、结果转纯数据、错误分类→`ToolExecutionError`、两门执行点——全部在 5.5-0 冻结的职责描述内。政策**定义**（bindings、policyProvider、gate 本体）都在 registry/平台侧，adapter 只消费。

轻度冗余：adapter 自行构造 `ToolAuditInfo`（adapter.ts:62-77）与 ToolRuntime.createAudit 形状重复，是 `ToolResult` 契约要求 audit 字段所致（成功路径会被 ToolRuntime 覆盖）。**可延期清理**，不构成越权。

---

## 汇总

- **必须修复项**：无（无 CONTRACT CONFLICT；按指令未做任何重构）。
- **可延期项**（建议挂 5.5-3）：
  1. bindings 落库并与 `AgentPermissions.tools` 身份打通（消除双授权输入）；
  2. `MCPToolPolicy` 并入未来平台统一 Tool Policy（若平台建立）；
  3. approvalGate 接回 shared Approval 实体（PENDING/APPROVED/REJECTED 流转）；
  4. adapter 的 audit 组装与 ToolRuntime.createAudit 的重复形状清理。
- **ARCHITECTURE WARNING**：第 2、3、6 节三条，均为"平台统一化缺口"，非 MCP 层自行管理状态或重复建设。
