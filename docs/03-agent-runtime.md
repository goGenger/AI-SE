# Agent Runtime

> ## 基线状态（2026-10-15 逐条核实）
>
> 本文写于**平台实现之前**（第一版路线图的 Agent Runtime 设计），是**实现前设计**，不是 as-built 描述，
> **不构成开工依据**。原文一字未删（保留当初的设计意图），下面是对照现状的核实表：
>
> | 本文条款 | 与当前实现的关系 |
> | --- | --- |
> | 「基于 LangGraph.js 构建，而不是从零编写自己的 Agent Framework」 | **已实现**：`@langchain/langgraph ^1.4.14`（`packages/agent-core/package.json`），`StateGraph` / `START` / `END` / `Annotation` 用于 `packages/agent-core/src/graph/AgentGraph.ts` 与 `src/planning/PlanningGraph.ts` |
> | 分层 Agent Runtime → LangGraph.js → LangChain.js → LLM Provider | **三层都在**：LangGraph 见上行；LangChain 经 `@langchain/core`（`messages` / `tools`）与 `@langchain/openai` 使用，**没有被砍掉**；LLM Provider 是平台自己的抽象（见下行） |
> | 核心抽象 `Agent` / `AgentContext` / `AgentState` / `AgentResult` / `AgentRunner` / `LLMProvider` | **六个全部存在，名称逐字一致**：`src/agent/Agent.ts`、`AgentContext.ts`、`AgentState.ts`、`AgentResult.ts`、`AgentRunner.ts`、`src/llm/LLMProvider.ts` |
> | Agent State「建议至少包含」10 个字段（messages / projectId / taskId / agentRunId / iteration / status / lastToolCall / lastToolResult / error / metadata） | **已实现且逐字一致**（`src/agent/AgentState.ts`），另加了 `toolResults: ToolResult[]`。图侧的状态注解与之一一对应（`AgentGraph.ts` 的 Annotation）。**「不要把整个数据库对象 / Repository / 无界日志放进 Graph State」这条也守住了** |
> | Agent Loop「START → Agent Node → Tool Call? → Tool Node → Tool Runtime → Result → Agent Node / END」 | **已实现为真正的 StateGraph**：`agent` / `tools` 两个节点，`START→agent`、`agent` 条件路由到 `tools` 或 `END`、`tools→agent`（`AgentGraph.ts`） |
> | 「禁止最终实现为一个业务层裸 `while(true)` 循环绕过 LangGraph」 | **守住了**。全仓唯一的 `while (true)` 是**工作流层**的任务认领循环（`packages/workflow-engine/src/WorkflowEngine.ts`，取不到任务即 break），与 Agent 执行路径无关；LLM 重试用的是有界 `while (attempt <= maxRetries)` |
> | LLM Provider 抽象；「具体实现可使用 LangChain Chat Model，例如 ChatOpenAI」 | **已实现**：`LLMProvider` 是手写接口（`invoke` / `stream` / `bindTools`），实现 `LangChainLLMProvider` 包的是 LangChain 的 `ChatOpenAI`，并支持经 `baseUrl` 接 OpenAI 兼容端点。另有 `DeepAgentLLMProvider`（deepagents harness）与两个**评测用脚本 provider**（`ScriptedCodingLLMProvider` / `ScriptedWorkflowTaskLLMProvider`）。**Agent Runtime 不直接依赖某一厂商模型类**——这条守住了 |
> | Phase 1「必须支持：max iterations、timeout、cancellation、错误标准化、结构化结果」 | **五项全部已实现**：max iterations 在 `AgentGraph.ts`；timeout / cancellation 在 `AgentRunner.ts`；错误标准化为 `normalizeRuntimeError`；结构化结果为 `AgentResult` |
> | Phase 2「持久化、checkpoint 边界、run recovery boundary、retry policy、SSE、token/cost 记录」 | **五项达成，两项有保留**。持久化 ✓（`PgAgentRunStore`，经 lifecycle hooks 写入）；run recovery boundary ✓（`recoverInterruptedRuns`，启动时调用）；retry policy ✓（`AgentRunner` 的 `maxRetries` + `packages/failure-recovery` 的路由）；token ✓（从 `usage_metadata` 取）。**保留一：checkpoint 边界虽已接入，但用的是 `MemorySaver`——内存态、不持久**，真正的持久化靠 DB lifecycle hooks 而不是 checkpointer。**保留二：SSE 在服务端 API 层**（工作流事件与 Agent 运行事件各一条流），**不在 Agent Runtime 内核**。**保留三：`estimatedCost` 链路是通的但恒为 `undefined`**——`AgentRunner` 从 graph state 的 `metadata.estimatedCost` 读、写进 `AgentResult`、落库、被 trace / metrics 消费，但**全仓没有任何写入方** |
> | Phase 2 实现要点（四条） | **(a) ✓** `AgentRunner` 用 `lifecycle.onRunStarted / onIteration / onRunFinished / onRetry` 驱动写入；**(b) ✓** `ToolCallRecorder` 确有其名（`packages/tool-runtime/src/types.ts`）；**(c) ✓** 事件只带安全摘要并过 `sanitizeLogData`，另有明写的「不暴露 hidden reasoning」约束；**(d) ✓** `thread_id = agentRunId` 且 `compile({ checkpointer })` 确实接了（但见上行的 `MemorySaver` 保留） |
> | Phase 5：`AgentRegistry` 按 Task Type / Capability 解析 | **已实现**：`AgentRegistry` 同时按 capability 与 task type 解析（`src/professional/AgentRegistry.ts`） |
> | Phase 5：`ProfessionalAgent` 复用 `AgentRunner` lifecycle | **已实现**：`ProfessionalAgent implements Agent`，内部构造 `AgentRunner` 并接 lifecycle |
> | Phase 5：Deep Agents 内置 filesystem backend 替换为 `ToolRuntimeBackend` | **已实现**：`deepagents ^1.13.3` 为真实依赖，`ToolRuntimeBackend` 实现 `SandboxBackendProtocolV2` 并**禁用 `execute` / `delete` / `glob`**、路径走白名单 |
> | Phase 5：「Agent 返回统一结构化 outcome；Tool failure、Task failure、Test failure 和 Review failure 分开处理」 | **部分达成**：统一 outcome 类型存在，工具失败也与结论分开记录；但**「Task / Test / Review failure 分开处理」不是 agent-core 的概念**——失败分类在**工作流层**（`packages/failure-recovery/src/classification.ts`），评审 Agent 只置 `approved: false` |
> | 安全：「Agent 不允许直接调用 `fs`、`child_process`、Docker API 或宿主机 Git。必须通过 Tool Runtime。」 | **边界成立，但守卫方式与字面不同**。**没有**针对这四个原语的 ESLint `no-restricted-imports` 规则；现有两处源码扫描只守 **MCP / 外部 API** 与 **Playwright / browser**，且**只扫 `packages/agent-core/src`**。真正的边界是**运行时**的：deepagents 的 backend 被换成 `ToolRuntimeBackend`（`execute`/`delete`/`glob` 直接禁用、路径白名单、工具需授权），`ToolRuntime.execute` 拒绝未注册工具 |
>
> **结论**：**本文是 `docs/01–14` 里落地最实的一份**——六个核心抽象名称逐字对上，Phase 1 五项、Phase 2 的实现要点、Phase 5 的三条全部落地，「不用裸 `while(true)` 绕过 LangGraph」这条也守住了。引用时要注意三处：① **checkpoint 是内存态**，别以为它承担了恢复职责；② **`estimatedCost` 恒为 `undefined`**，任何依赖成本数字的功能都还没数据；③ **安全边界靠运行时而非静态守卫**，源码扫描只覆盖 agent-core 的两个方向。
> 依据：`AGENTS.md` §9「代码权威于文档；冲突必须报告，禁止默默改任一方来对齐」。

## 目标

构建一个基于 LangGraph.js 的可扩展 Agent Runtime，而不是从零编写自己的 Agent Framework。

## 分层

```text
Agent Application
      ↓
Our Agent Runtime
      ↓
LangGraph.js
      ↓
LangChain.js
      ↓
LLM Provider
```

## 核心抽象

```text
Agent
AgentContext
AgentState
AgentResult
AgentRunner
LLMProvider
```

这些是平台自己的业务抽象；底层执行图由 LangGraph 提供。

## Agent State

建议至少包含：

- messages
- projectId
- taskId
- agentRunId
- iteration
- status
- lastToolCall
- lastToolResult
- error
- metadata

不要把整个数据库对象、整个 Repository 或无界日志直接放入 Graph State。

## Agent Loop

```text
START
  ↓
Agent Node
  ↓
Tool Call?
 ├─ Yes → Tool Node → Tool Runtime → Result → Agent Node
 └─ No  → END
```

禁止最终实现为一个业务层裸 `while(true)` 循环绕过 LangGraph。

## LLM Provider

Agent Runtime 依赖抽象：

```text
LLMProvider
```

具体实现可使用 LangChain Chat Model，例如 ChatOpenAI 或其他 provider adapter。Agent Runtime 不直接依赖某一个厂商模型类。

## 必须支持

Phase 1：max iterations、timeout、cancellation、错误标准化、结构化结果。

Phase 2：持久化、checkpoint 边界、run recovery boundary、retry policy、SSE、token/cost 记录。

Phase 2 实现要点：

- AgentRunner 通过 lifecycle hooks 写入 Agent Run 状态。
- Tool Runtime 通过 ToolCallRecorder 写入工具调用审计。
- Workflow Event 只保存安全摘要，不保存 hidden chain-of-thought。
- LangGraph invoke 使用 `thread_id = agentRunId`，graph compile 接入 checkpointer。

后续：streaming、human-in-the-loop、dynamic routing、multi-agent。

## Phase 5

- `AgentRegistry` 按 Task Type / Capability 解析专业 Agent，不随机选择。
- `ProfessionalAgent` 复用 `AgentRunner` lifecycle，并把 Deep Agents 作为 LLM/Tool harness 接入现有 LangGraph 运行边界。
- Deep Agents 内置 filesystem backend 被替换为 `ToolRuntimeBackend`；读写、测试、构建和 Git 查询仍由 Tool Runtime 审计并通过 Docker Sandbox 执行。
- Agent 返回统一结构化 outcome；Tool failure、Task failure、Test failure 和 Review failure 分开处理。

## 安全

Agent 不允许直接调用 `fs`、`child_process`、Docker API 或宿主机 Git。必须通过 Tool Runtime。
