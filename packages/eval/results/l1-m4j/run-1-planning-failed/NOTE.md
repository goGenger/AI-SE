# run 1 作废原因（2026-10-18 22:24:56 CST）

这两个文件是 L1-M4j 批次**第一次尝试**的 run 1 结果。它**没有产出任何运行**，故把一个 run 槽重开了一次。

## 发生了什么

- 22:20:38 批次启动，run 1 开始。
- 22:21:09 规划阶段失败（约 4 分钟），工作流**从未创建**（`workflow_runs` 无对应行）。
- 22:24:56 harness 收尾，写出 `run-1.json` / `run-1-summary.md`，内容为 **0 个运行**、
  `failures: [{fixtureId: "E1", stage: "planning", message: "规划失败：a30f30cc-…"}]`。
- 22:26 停批（库内无 `RUNNING` / `PENDING`，无需 cancel），归档本目录，22:27:04 重启批次。

## 失败内容

规划 agent run `df197775`（`status=failed`、`iter=0`、`in=0`）报：

```
VALIDATION_ERROR: Task DAG validation failed:
  Task T10 carries global acceptance criteria (AC-30) that must be delivered by the final slice
    (GLOBAL_AC_OUTSIDE_FINAL_SLICE); ...
  Task T11 carries global acceptance criteria (AC-30) ... (GLOBAL_AC_OUTSIDE_FINAL_SLICE); ...
  PLAN_ANCHOR_OUT_OF_SCOPE: Task T9 references AC-1, which is outside this slice's scope ...
```

两个校验器都在 `packages/agent-core/src/planning/`（`validateTaskGraph.ts` / `validateTaskAnchors.ts`）。

## 为什么不算 PL-M18 的回归

1. 该错误**跨多日复现**：`agent_runs` 里 `Task DAG validation failed` 的分布为 10-07(1) /
   10-09(570) / 10-14(1) / 10-15(2) / 10-16(3) / 10-18(1，即本条)。
2. 两个校验器所在的包（`agent-core/src/planning`）**本批一字未动**；PL-M18 的改动只落在
   `apps/server/src/services/taskVerifier.ts`、`workflow-engine`、`shared`、`eval`，且后两者的改动
   都在**失败响应路径**上，规划期不经过。
3. 触发点是**规划器的 LLM 产出**（首轮计划把全局 AC 挂到了非最终切片），**间歇性**——L1-M4i 的
   run 1 / run 2 都顺利过了规划期。

## 为什么移到这里而不是让它留着

批次脚本的跳过逻辑是 `if [ -f "$OUT_DIR/run-$n.json" ]`。若留着这个 `run-1.json`，**run 1 会被永久
跳过**，批次就只剩 2 个有效槽——而 L1-8 判据是 staging 段 **≥ 2/3**，等于把该条件变成「runs 2/3
必须全部交付」。移走后 run 1 槽可重跑一次。

**归档而非删除**，且重跑**限定一次**：若重跑的 run 1 仍撞同一处，则接受该槽作废并记入批次账。

## 成本

`in=0`（规划期 agent run 不记录用量，见 `docs/127` §5）——**规划期的真实 token 花费读不出来**，
所以**周配额守卫的读数不会反映这次作废**。如实标注。
