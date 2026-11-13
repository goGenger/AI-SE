# round 15 快照（**已人工停止**，2026-11-02 14:35）

批次在 slice-5 进行中被人工停止（用户决定，避免继续消耗）。停止方式是
`f1-frontend-stop.sh`：先杀 harness 角色，再调 `/api/workflows/<id>/cancel`，
最后按库复核——**0 个 RUNNING/PENDING/WAITING_APPROVAL**，`568a7cfa` 返回 http=200。
这份快照记录**已经落地、不会因停止而消失**的读数，供后续对账。

## 已完成的切片（全部 SUCCESS，逐任务门零失败）

| 切片 | 工作流 | 任务 | 通过 | 失败 | 起止（UTC） |
| --- | --- | --- | --- | --- | --- |
| slice-1-foundation-list | `7ce531b1` | 4 | 4 | 0 | 04:27 → 04:38（11m28s） |
| slice-2-new-task-flow | `0825f71c` | 8 | 8 | 0 | 04:40 → 05:01（20m22s） |
| slice-3-search-filter | `3967239f` | 6 | 6 | 0 | 05:02 → 05:28（25m52s） |
| slice-4-completion-deletion-resilience | `333e8324` | 5 | 5 | 0 | 05:31 → 05:59（28m16s） |

## 最终切片 slice-5-usability-polish（`568a7cfa`，进行中）

**交付链第一次被排出来**（这也是本次接线唯一的验收点）：

| 任务 | 类型 | delivery 块 |
| --- | --- | --- |
| TASK-11 | BUILD | `{"action":"CI"}` |
| TASK-12 | DEPLOY | `{"action":"DEPLOY","environment":"staging"}` |
| TASK-13 | TEST | `{"action":"VERIFY","environment":"staging"}` |

三个任务都在 DAG 尾端（排在实现与评审之后），没有 production 部署——staging-only 提示词变体生效。

**N-63 第一次被走到**：`预算：13 个任务 × 8 min = 104 min（下界 90 min）`。修前是 6 分钟（13×6=78，
取下界 90），预算不会随任务数增长。

**当前进度**（截至 14:30）：3 SUCCESS、1 FAILED、其余排队。失败的是 `TASK-06`（FRONTEND）：

```
Agent 运行超时（900s），未返回结果。iterations=38，artifacts=14，outcomeMode=text-fallback
```

注意这是**单个 agent 运行**的 900 秒上限，不是切片预算；切片预算是 104 分钟，两者不是一回事。

## 断线后的重跑语义（已核对代码）

- `runFixture` 每轮开头都会 `prepareWorkspace(fixture, runIndex)`——**`rm -rf` 工作区并从模板重建**
  （`packages/eval/src/cli.ts` 的 `prepareWorkspace`）。因此「只重跑 slice-5」不成立：已 DONE 的
  切片会被跳过，而 slice-5 会跑在一个**空模板**上，读数没有意义。
- run 1 带 `--replan`，`ensurePlanning` 会用 `regenerate: true` 重新规划，切片状态重新开始。
- **结论**：重跑只能是整轮重跑（约 3–4 小时）；库里的记录不会因此清零，可以按
  `workflow_run_id` 对账。

## 这一轮已确认的修复

| 编号 | 判据 | 本轮证据 |
| --- | --- | --- |
| N-73 | 最终切片排出 CI / staging DEPLOY / staging VERIFY | 三个 delivery 块已落库 |
| N-63 | 任务数 ≥12 的切片预算超过 90 分钟下界 | 13×8=104 min |
| N-72 | TEST 任务跑红后提交 SUCCESS | slice-1..4 无「TEST 任务自报失败」记录 |
