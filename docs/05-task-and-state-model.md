# Task and State Model

> ## 基线状态（2026-10-15 逐条核实）
>
> 本文写于**平台实现之前**（第一版路线图的核心设计：Task 与状态模型），是**实现前设计**，不是 as-built 描述，
> **不构成开工依据**。原文一字未删（保留当初的设计意图），下面是对照现状的核实表：
>
> | 本文条款 | 与当前实现的关系 |
> | --- | --- |
> | Task 字段表（16 项：id / projectId / workflowRunId / title / description / type / status / priority / dependencies / assignedAgent / input / output / retryCount / createdAt / startedAt / finishedAt） | **已实现且已显著扩张**。16 项里 15 项在 `packages/shared/src/index.ts` 的 `Task` 接口中逐字存在；**`dependencies` 不在其中**——依赖是**独立关系**而非 Task 字段（见下行）。原文未列、现已存在的还有：`taskKey`、`version`、`updatedAt`、`requirementId`，动态任务与切片的一整套（`origin` / `creationReason` / `sourceTaskId` / `resolvedByTaskId` / `sliceKey` / `planTaskId`），以及认领与失败处置（`claimToken` / `claimedAt` / `failureHandled` / `approvalRequired`） |
> | `dependencies` 作为 Task 的字段 | **前提已变**：依赖独立成表/独立类型 `TaskDependency { id, sourceTaskId, targetTaskId, workflowRunId?, origin?, active?, createdAt }`，读模型是 `TaskDependencyView extends TaskDependency { sourceTaskKey, targetTaskKey }`（`packages/shared/src/index.ts`）。`active` 是后加的——**失效的依赖边不参与调度**（`scheduler.ts` 的 `activeDependencies`） |
> | Task Type（12 项：ANALYSIS / DESIGN / DATABASE / BACKEND / FRONTEND / TEST / REVIEW / DEBUG / BUILD / DEPLOY / MONITOR / INCIDENT） | **逐字一致**：`TaskTypeSchema` 就是这 12 个值，顺序也相同（`packages/shared/src/index.ts`） |
> | Status（8 项：PENDING / READY / RUNNING / WAITING_APPROVAL / SUCCESS / FAILED / BLOCKED / CANCELLED） | **已扩张为 9 项**：`TaskStatusSchema` 多了 **`RETRYING`**（插在 `FAILED` 与 `BLOCKED` 之间），原文漏了它。状态迁移另有白名单 `assertTaskTransition`（`packages/workflow-engine/src/stateMachine.ts`），不是任意迁移 |
> | `priority` 字段 | **已实现且在起作用**：`TaskPrioritySchema = LOW / MEDIUM / HIGH`；认领任务时按 `HIGH → MEDIUM → LOW` 再按 `created_at` 排序（`packages/database/src/workflowRepositories.ts` 的 `claimNextTask`）。原文只列了字段，没说它参与调度 |
> | Scheduler「根据 dependency 计算 READY Task」 | **已实现**：`readyTaskIds`（`packages/workflow-engine/src/scheduler.ts`）——自身 `PENDING`/`RETRYING` 且**所有入边的源任务都 SUCCESS** 才算就绪；另有 `blockedTaskIds` 处理「入边有 FAILED / BLOCKED / CANCELLED」的情形 |
> | Scheduler「检测循环依赖」 | **已实现且更严**：`validateWorkflowGraph` 用 Kahn 拓扑排序判环，同时报出**引用不存在的任务 / 自依赖 / 重复边**三类错误 |
> | Scheduler「识别可以并行执行的 Task」 | **机制已实现，但生产被刻意关掉**。机制：`claimNextTask` 用 `SELECT … FOR UPDATE SKIP LOCKED` 认领，并在事务内检查「本工作流 `status='RUNNING'` 的任务数 ≥ `max_concurrency` 就拒绝」；引擎的认领循环对每个认领到的任务 `void executeTask(...)`，因此天然可并发。**但工作流创建期 `enforceSerialWorkflowPolicy` 把 `maxConcurrency` 钳为 1 并写 `WORKFLOW_MAX_CONCURRENCY_CLAMPED` 事件留痕**（`packages/shared/src/index.ts`、`apps/server/src/services/workflowService.ts`；F1-7 / FX-23：T3 并行执行器完成前不开放并行）。**结论：「识别」成立，「实际并行执行」当前不开放** |
> | 「Agent State 与 Task State 的边界：不要把 Task/Workflow 的全部字段复制到 LangGraph State」 | **已实现**：Agent 侧状态（`packages/agent-core/src/agent/AgentState.ts`）只有单次运行所需的 10 个字段 + `toolResults`，**不含任何 Task / Workflow 全量字段**；Task 的持久化在 PG（`packages/database`），两者不互相复制。详见 `docs/03` 的基线状态表 |
>
> **结论**：本文的**枚举与字段骨架基本被采纳**（Task Type 逐字一致、状态多一个 `RETRYING`、`dependencies` 从字段改成独立关系），**调度器三项全部实现且比原文更严**。唯一需要提醒后人的是**并行**：原文说调度器「识别可以并行执行的 Task」，机制确实存在且并发安全，但**平台当前刻意把并发钳为 1**——引用本文时不要据此以为平台在并行跑任务。**动工前以 `packages/shared` 的 schema 与 `packages/workflow-engine` 的调度器为准。**
> 依据：`AGENTS.md` §9「代码权威于文档；冲突必须报告，禁止默默改任一方来对齐」。

## Task

```text
id
projectId
workflowRunId
title
description
type
status
priority
dependencies
assignedAgent
input
output
retryCount
createdAt
startedAt
finishedAt
```

## Task Type

```text
ANALYSIS
DESIGN
DATABASE
BACKEND
FRONTEND
TEST
REVIEW
DEBUG
BUILD
DEPLOY
MONITOR
INCIDENT
```

## Status

```text
PENDING
READY
RUNNING
WAITING_APPROVAL
SUCCESS
FAILED
BLOCKED
CANCELLED
```

## Scheduler

Scheduler 根据 dependency 计算 READY Task，检测循环依赖，并识别可以并行执行的 Task。

## Agent State 与 Task State 的边界

Agent State 是一次 Agent 执行需要的短期上下文；Task State 是平台级持久化业务状态。不要把 Task/Workflow 的全部字段复制到 LangGraph State。
