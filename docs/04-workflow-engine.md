# Workflow Engine

> ## 基线状态（2026-10-15 逐条核实）
>
> 本文写于**平台实现之前**，是**实现前设计**，不是 as-built 描述，**不构成开工依据**。原文一字未删，下面是核对结论：
>
> | 本文条款 | 与当前实现的关系 |
> | --- | --- |
> | 工作流状态 `CREATED / PLANNING / RUNNING / WAITING_APPROVAL / PAUSED / COMPLETED / FAILED / CANCELLED` | **命名不一致**：代码的 `WorkflowStatus` 为 `PENDING / RUNNING / PAUSED / WAITING_APPROVAL / SUCCESS / FAILED / CANCELLED`（`packages/shared/src/index.ts:751`）。`CREATED` 对应 `PENDING`，`COMPLETED` 对应 `SUCCESS`；`PLANNING` 不是工作流状态，规划状态属于需求层（`packages/shared/src/index.ts:257`，`PLANNING_REVIEW` 等） |
> | 动态能力：暂停 / 恢复 / 取消、重试、审批、回滚、重规划 | **已实现**：暂停、恢复、取消、重试、审批分别位于 `packages/workflow-engine/src/WorkflowEngine.ts` 的 `pause`、`resume`、`cancel`、`retry`、`approve`；回滚任务由部署失败生成（`rollback`，需工作流策略为 `ROLLBACK`）；**重规划存在但默认关闭**（`DEFAULT_WORKFLOW_POLICY` 中 `allowReplan: false`） |
> | 固定生命周期 REQUIREMENT → DESIGN → DEVELOPMENT → VERIFICATION → DELIVERY → OPERATIONS | **OPERATIONS 段未实现**（见 `docs/13`、`docs/147`）；其余段以阶段划分实现，不以这组命名出现在代码中 |
> | Workflow / Task 变化与关键事件持久化 | **已实现**：`workflow_events`（`packages/database/migrations/004_phase4_dynamic_workflow.sql`）、`tasks`、`agent_runs` |
>
> 依据：`AGENTS.md` §9。

## 目标

采用“固定生命周期骨架 + 动态执行”。

生命周期：

```text
REQUIREMENT → DESIGN → DEVELOPMENT → VERIFICATION → DELIVERY → OPERATIONS
```

## 与 LangGraph 的关系

Workflow Engine 与 Agent Runtime 是两个层级：

```text
Workflow Engine
    ↓
Task Engine
    ↓
Agent Runtime
    ↓
LangGraph
```

LangGraph 负责 Agent 内部执行图；Workflow Engine 负责跨 Task、跨 Agent 的业务流程。

不要把整个业务 Workflow 简化成一个巨大 LangGraph。

## 动态能力

后续 Phase 支持：

- create task
- modify task
- cancel task
- dependency update
- retry
- re-plan
- rollback
- approval
- pause / resume

## Workflow 状态

```text
CREATED
PLANNING
RUNNING
WAITING_APPROVAL
PAUSED
COMPLETED
FAILED
CANCELLED
```

Workflow 状态、Task 变化和关键 Agent/Tool 事件必须持久化。


## MCP 与 Workflow 的关系

MCP 不参与 Workflow 的生命周期建模。它只是 Tool Runtime 的一种外部工具来源。

例如：

```text
Task: Update GitHub PR
    ↓
Frontend/Backend Agent
    ↓
Tool Runtime
    ↓
MCP GitHub Tool
```

Workflow Engine 不应该感知 `tools/call` 等 MCP 协议细节；它只关心 Task 是否成功、失败、等待审批或需要重新规划。

## Final Workflow Boundary

```text
Workflow
  ├── Task A → Agent Run → Native/MCP/Browser Tools
  ├── Task B → Agent Run → Native/MCP/Browser Tools
  └── Task C → Agent Run → Native/MCP/Browser Tools
```

MCP Server 断线、Tool 超时等问题应在 Tool Runtime 归一化为标准错误，再由 Task/Workflow Failure Strategy 决定 retry、re-plan 或人工介入。
