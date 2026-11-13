# Tool System

> ## 基线状态（2026-10-15 逐条核实）
>
> 本文写于**平台实现之前**（第一版路线图的工具系统设计），是**实现前设计**，不是 as-built 描述，
> **不构成开工依据**。原文一字未删（保留当初的设计意图），下面是对照现状的核实表。
> 注：本文**正文里已经写了两句准确的免责**（「代码中的全部 Permission / Approval 并未集中在 ToolRuntime 内部」「文档不得假设存在尚未实现的集中 Policy Engine」）——**这两句是对的**；但**两张流程图仍把 Policy 画成执行链上的一级**，那部分是错的。
>
> | 本文条款 | 与当前实现的关系 |
> | --- | --- |
> | 架构图 `LangGraph → LangChain Tool → Tool Runtime → **Policy** → Sandbox / External Adapter → Result` 里的 **Policy 一级** | **不成立**：`ToolRuntime.execute` 里**没有 Policy 阶段**，它是 schema 校验 → 超时/取消 → `tool.execute`（`packages/tool-runtime/src/ToolRuntime.ts`），**从不 import action-policy**。策略是在**装配期**施加的（`applyActionPolicy`）与**逐工具包裹**（`withApprovalGate`，`packages/action-policy/src/enforce.ts`） |
> | Tool Runtime 职责 7 项 | **5 项干净、2 项要打折**。(a) Zod/schema validation ✓、(b) timeout ✓、(c) cancellation ✓、(d) audit / `ToolCallRecorder` 接入 ✓、(e) error normalization ✓（`normalizeRuntimeError`）、(f) secret redaction ✓（`sanitizeLogData`）。**(g)「sandbox / external adapter routing」不成立**：Runtime 里**没有路由分支**——每个 `ToolDefinition.execute` 闭包自己决定去哪儿（原生工具调 `context.sandbox.runCommand`，MCP 工具调 adapter）。**Runtime 不是分发器** |
> | 「Permission、Risk、Approval 由现有 Agent/Workflow/Adapter 组合提供执行前门控；后续可统一到平台 Policy」 | **前半句仍成立，后半句已经发生了**：`packages/action-policy` 是后来建成的**统一平台策略**（`ActionPolicy`，5.7-3），为 browser 与 external 动作从平台自有表解析 `{riskLevel, requiresApproval}`。它是 **Action Policy，不是完整的工具门控引擎**——所以「permission/risk/approval 仍靠组合」没错，但本文「不存在集中 Policy Engine」这句**已不再字面成立**，引用时别再照抄 |
> | 「Retry 属于 Workflow / Task 层策略，不作为 MCP 专属 Tool Runtime retry」 | **成立**：`ToolRuntime` 与 MCP adapter 里**零重试**（grep 无命中）；重试在 `packages/workflow-engine`（人工 `retry` 与自动重试的 `retryCount`/`maxRetries`/`allowRetry`）与 `packages/failure-recovery`。一处 caveat：`RemoteMCPClient` 有**连接级**的退避重连，那不是工具调用重试 |
> | Phase 1 Tools 11 个（read_file / write_file / edit_file / list_directory / search_code / git_status / git_diff / run_command / run_unit_test / run_lint / run_build） | **11 个全部逐名存在**：前五个在 `packages/tool-runtime/src/tools/fileTools.ts`，两个 git 在 `gitTools.ts`，四个命令类在 `commandTools.ts`，在 `tools/index.ts` 汇总。另有本文未列的交付工具（`run_ci` / `deploy_release` / `verify_release` / `rollback_release`）与 browser 工具 |
> | `ToolDefinition<TInput, TOutput>` 字段 `name` / `description` / `inputSchema` / `execute` | **字段名对得上，但漏了一个必填字段**：真实接口（`packages/tool-runtime/src/types.ts`）**多一个必填 `riskLevel: ToolRiskLevel`**，且 `inputSchema` 的类型是 `z.ZodType<TInput>`。写新工具时以代码为准 |
> | 风险等级 LOW / MEDIUM / HIGH / CRITICAL，「HIGH/CRITICAL 默认人工审批」 | **已实现**：`ToolRiskLevel` 就是这四个值；默认审批规则由 `requiresApprovalFor`（HIGH/CRITICAL → true）与 `withApprovalGate`（未带 `metadata.approved === true` 即抛）共同落实。**一处保留**：`CRITICAL` 只是**可声明**的等级，策略表从不产出它——别指望现在有 CRITICAL 级的工具 |
> | 「Final Tool Sources」四类：Native / MCP / Browser / Sandbox | **判别字段已定义，但只有三类真的产出**：`UnifiedToolSource = "native" \| "mcp" \| "browser" \| "sandbox"`（`packages/mcp/src/contracts.ts`）确实有四个字面量，但**只有 native / mcp / browser 被产出为 `ToolDefinition`**；`"sandbox"` 只是**声明了但没人用**——原生工具是**在沙箱里跑**，没有 `source:"sandbox"` 的工具 |
> | 统一执行链的顺序（… → Schema Validation → Permission → Risk → Approval → Timeout/Cancellation → Adapter → Result → Audit/Metrics/Redaction） | **顺序与实现不符**。真实顺序（`ToolRuntime.execute`）：构建 audit → recorder started → 取消检查 → **Schema Validation** → **Timeout/Cancellation** → `tool.execute`（adapter）→ Result → Audit/Redaction。**Permission / Risk / Approval 不是 Runtime 的阶段**：risk 在装配期定（`enforce.ts`），approval 在**被包裹的 execute 内部**或 MCP adapter 里触发，位置在 **schema 校验之后**，不是插在校验与超时之间的三道独立闸门 |
> | MCP Adapter 只负责 client lifecycle / initialize / tool discovery / `tools/list` / `tools/call` / transport / 协议错误标准化 / cancellation / connection state；**不负责** workflow scheduling、agent planning、独立 Permission/Approval/Audit 系统、Secret storage、MCP 专属治理引擎 | **成立**：adapter 是一层薄桥，权限与审批来自平台注入的 `guards.canExecute` / `approvalGate`，**从不自成一套系统**；协议面在 client 层；Secret 是**只存引用的** credential resolver，不在 adapter 里 |
> | `UnifiedToolDefinition` 字段（name / description / source / inputSchema / riskLevel / requiresApproval / mcpServerId? / mcpToolName?） | **类型存在但改了名、且少一个字段**：实际叫 **`UnifiedToolMetadata`**（`packages/mcp/src/contracts.ts`），有 `name` / `description` / `source` / `riskLevel` / `requiresApproval` / `mcpServerId?` / `mcpToolName?`，**没有 `inputSchema`** |
> | MCP Permission 链：Server registered → Server enabled → Project binding → Agent binding → Tool enabled → Policy allowed → Agent-visible；「任何未绑定对象默认 DENY」 | **成立**：内存注册表与持久化谓词都要求 serverEnabled + projectBound + agentBound + toolEnabled + policyAllowed 全真，任一为假即 DENY；「未绑定默认 DENY」有测试覆盖 |
> | Security Invariant：「若判定为 DENY，必须保证 MCP Server 收到 **0 个实际请求**」 | **成立且有测试**：`externalActionPolicy.test.ts` 断言「未接审批门」与「审批门返回 false」两种情形下 `client.requestCount(...) === 0`；adapter 的 guards 在 `client.callTool` **之前**跑 |
>
> **结论**：**「Retry 不在工具层」「MCP Adapter 的职责边界」「MCP 权限链默认 DENY」「DENY 即零请求」这四条是本文最有价值的部分，且全部落实并有测试。** 需要修正的是**两张流程图**：① 执行链上**没有 Policy 一级**；② 链上的 **Permission → Risk → Approval 三道闸门的位置与实现不符**（它们不在 Runtime 内，且不是插在校验与超时之间）。另外三处字段漂移（`ToolDefinition` 多一个必填 `riskLevel`；`UnifiedToolDefinition` 实际叫 `UnifiedToolMetadata` 且没有 `inputSchema`；`"sandbox"` 是声明了没人用的 source）。**引用本文的图之前，以 `packages/tool-runtime/src/ToolRuntime.ts` 与 `packages/action-policy/src/enforce.ts` 为准。**
> 依据：`AGENTS.md` §9「代码权威于文档；冲突必须报告，禁止默默改任一方来对齐」。

## 核心原则

Tool 是 Agent 与外部世界交互的统一入口。当前 ToolRuntime 是统一执行边界，但代码中的全部 Permission / Approval 并未集中在 ToolRuntime 内部。文档必须以当前实现为准。

但需要区分：

- LangChain Tool：给模型看的 Tool schema / invocation abstraction。
- Tool Runtime：平台真正的工具执行边界；治理能力由 Runtime 与现有 Permission / Policy / Approval / Audit 机制共同组成。

架构：

```text
LangGraph
   ↓
LangChain Tool
   ↓
Tool Runtime
   ↓
Policy
   ↓
Sandbox / External Adapter
   ↓
Result
```

## Tool Runtime 职责

Tool Runtime 是统一执行入口和治理边界，但当前代码中部分治理能力仍由调用方/Adapter 提供执行时门控。文档不得假设存在尚未实现的集中 Policy Engine。

当前核心职责：

- Zod/schema validation
- timeout
- cancellation
- audit / ToolCallRecorder 接入
- error normalization
- secret redaction
- sandbox / external adapter routing

Permission、Risk、Approval：由现有 Agent/Workflow/Adapter 组合提供执行前门控；后续可统一到平台 Policy，但不得重复建设。

Retry 属于 Workflow / Task 层策略，不作为 MCP 专属 Tool Runtime retry。

## Phase 1 Tools

```text
read_file
write_file
edit_file
list_directory
search_code
git_status
git_diff
run_command
run_unit_test
run_lint
run_build
```

## Tool Interface

```ts
interface ToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: ZodSchema<TInput>;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}
```

## 风险等级

LOW：read/search/test

MEDIUM：write/commit/build

HIGH：push/deploy/environment change

CRITICAL：破坏性 Shell/DB 操作

HIGH/CRITICAL 默认人工审批。


## Final Tool Sources

Tool Runtime 统一管理以下 Tool Source：

```text
Native Tool
MCP Tool
Browser Tool
Sandbox Tool
```

统一执行链：

```text
Agent
  ↓
Tool Definition
  ↓
Tool Runtime
  ↓
Schema Validation
  ↓
Permission
  ↓
Risk
  ↓
Approval
  ↓
Timeout / Cancellation
  ↓
Adapter
  ↓
Result
  ↓
Audit / Metrics / Redaction
```

### MCP Adapter

MCP Adapter 只负责：

- MCP Client lifecycle
- `initialize`
- tool discovery
- `tools/list`
- `tools/call`
- transport handling
- protocol error normalization
- cancellation
- connection state

MCP Adapter 不负责：

- Workflow scheduling
- Agent planning
- 独立 Permission / Approval / Audit 系统
- Secret storage
- MCP-specific governance engine

### MCP Tool Normalization

```ts
interface UnifiedToolDefinition {
  name: string;
  description: string;
  source: "native" | "mcp" | "browser" | "sandbox";
  inputSchema: unknown;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  requiresApproval: boolean;
  mcpServerId?: string;
  mcpToolName?: string;
}
```

MCP Tool 经过统一 Tool Runtime 后，Agent 无需知道其底层是否来自 MCP。

### MCP Permission

默认：

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

任何未绑定对象默认 DENY。

### Security Invariant

若 MCP 的执行前授权判定为 DENY：

```text
Agent → Tool Runtime / governance gate → DENY
```

必须保证 MCP Server 收到 **0 个实际请求**。
