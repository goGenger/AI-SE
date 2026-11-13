# 计划期可执行性守卫 — 计划项不得使用运行时专属任务类型

> 来源：真实运行中工作流在最后一个任务失败（`Task failed: Fix any issues found during testing or review`）。
> 侦察确认与解析层无关：**计划项 `T8` 的 `type=DEBUG`，执行期 `AgentRegistry.resolveTask` 找不到 agent**，50ms 内瞬失败 3 次。
> 本修复只在**规划校验**加守卫（计划期拦下并交给规划器修复轮重规划），不动执行器、不改类型枚举、不新增依赖。

## 侦察结论（真实数据，2026-09-28 12:50 UTC）

| 证据                 | 值                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 工作流               | `9ed0eb96`：T1–T7 全 SUCCESS（**T2 由 docs/103 的锚点抢救救回**），T8 FAILED                                                                                                                                 |
| T8                   | `type=DEBUG`、`origin=RUNTIME`、`plan_task_id` 指向计划项（计划里就是 DEBUG）、`retry_count=2`、`input` 无 `targetTaskType`                                                                                  |
| `tasks.output.error` | **`No professional agent for task type DEBUG`**                                                                                                                                                              |
| 事件                 | `TASK_STARTED → TASK_FAILED`（`TASK_EXECUTION_ERROR`）连续 3 次，**无任何 agent_run**（失败在"能起 agent 之前"）                                                                                             |
| 根因                 | `AgentRegistry.resolveTask`：DEBUG 任务靠 `task.input.targetTaskType` 解析（**运行时 REPLAN 链**才会写入该提示，见 `WorkflowEngine.debugTargetType`）；计划项没有该提示 → `TASK_AGENT_TYPES` 无 DEBUG → 抛错 |
| 面                   | `TaskPlanItemSchema.type` 允许全部 12 种类型，可执行的只有 8 种 agent 类型 + 走 delivery 编排的 DEPLOY（需带 `delivery` 块）；**规划期无任何可执行性校验**                                                   |

按仓库设计（docs/58），`DEBUG` 是**运行时 replan 专属**类型（origin=DYNAMIC，带 target）；计划项里出现它属于越界，应在规划期拦下。

## 修复

| #   | 文件                                                               | 变更                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/agent-core/src/planning/validateTaskGraph.ts`            | 新增计划项**可执行性校验**：`DEBUG` / `MONITOR` / `INCIDENT` → 报错（`runtime-only type …`）；`DEPLOY` 且 `delivery.action` 不在 `{DEPLOY, ROLLBACK}` → 报错（否则会落到 agent 执行器且无对应 agent）。错误进入 `TaskGraphValidationError` → 规划器**修复轮**自动重规划 |
| 2   | `packages/agent-core/src/planning/prompts/task-planning.prompt.ts` | 提示词补可规划类型清单：`ANALYSIS / DESIGN / DATABASE / BACKEND / FRONTEND / TEST / REVIEW / BUILD / DEPLOY`；明确 DEBUG / MONITOR / INCIDENT 为运行时专属、不得规划；DEPLOY 必须带 `delivery`（action DEPLOY + environment）                                           |
| 3   | 数据解锁（如实记录）                                               | `UPDATE tasks SET type='FRONTEND' WHERE workflow_run_id='9ed0eb96-…' AND task_key='T8'` —— 让**当前**工作流可继续（标题/描述保留，修复语义由标题承载）；新建工作流不受影响                                                                                              |

## 测试

| 用例                                                                          | 结果 |
| ----------------------------------------------------------------------------- | ---- |
| `rejects runtime-only task types (DEBUG / MONITOR / INCIDENT)`                | 通过 |
| `rejects a DEPLOY task without a deployable delivery block`（含 action 错配） | 通过 |
| `accepts a DEPLOY task with a delivery block`（不误伤合法交付计划项）         | 通过 |
| 既有 71 例（含 docs/98 / 102 / 103 全部解析用例）不回归                       | 通过 |

`packages/agent-core`：**74/74 通过**。

## 门禁（本轮）

- `apps/server`：**21 文件 / 95 例全过**；全仓 `typecheck / lint / build` 全 exit 0；`prettier --check` 全绿。
- 服务随 dist 重建自动重启（21:27:41，`/health` 200），新逻辑即时生效。

## 边界与已知问题

1. 守卫只约束**新规划**；已存在的计划/工作流不受影响（本次用数据解锁处理）。
2. `MONITOR` / `INCIDENT` 一并列入禁规划（同属运行时专属、当前无对应 agent）；未来若实现对应 agent，需同步从禁列移除。
3. `BUILD` 计划项若带非 CI 的 delivery 会走 agent 路径（DEVOPS agent 可执行），因此**未**设为错误（保持最小改动）。
4. 计划期守卫依赖规划器的修复轮：若模型连续 3 次仍规划出 DEBUG，规划会失败（这是既有失败语义，不新增机制）。

**完 —— 等待下一条指令。**
