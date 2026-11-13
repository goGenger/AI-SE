# 253 · DOCS_GAP：README/docs 门禁失败分流与写权限

> 状态：**已落地**（2026-11-09 Asia/Shanghai）
> 动机：taskflow-vue v9 在 `T-11-REPLAN-5`（FRONTEND）上空烧自治轮次——切片 AC 已绿，剩余全是 README/文档断言；FRONTEND 不宜扛 docs 修复，`T-14` BUILD 又写不进 `docs/delivery-report.md`。

---

## 1. 失败类

| 类 | 信号（摘） | 修复任务类型 |
| --- | --- | --- |
| `DOCS_GAP` | `readme.ac*`、`README.md` + 断言失败、`工程 gates`×README、`项目介绍` / `目录结构` / `不在本次交付范围`、`docs/delivery-report`、`Path is not writable: docs/` | **BUILD**（优先于 agent 误报的 FRONTEND） |

`repairHintForFailureClass("DOCS_GAP")`：改 README/docs 满足字面量；**不**改弱测试（anti-tamper 仍拦测试文件）。

## 2. 写权限绑定

| 任务类型 | README.md | docs/** | 说明 |
| --- | --- | --- | --- |
| **BUILD**（devops-agent） | ✅（`writeRootDeliveryArtifacts`） | ✅（`writePaths` 含 `docs`） | DOCS_GAP 修复主责 |
| FRONTEND | ✅（PL-M11 根交付物，历史行为） | ❌ | 产品代码修复；**不**广开 docs |
| TEST / REVIEW | ❌ / 只读 | ❌ | 不变 |
| 生产 DEPLOY 审批 | — | — | **不**绕过 |

强制侧：`AgentRegistry` devops `writePaths`/`readPaths`；审计侧：`writeScopeAudit` 的 BUILD 组并入 `docs/` 前缀（README 仍走 `ROOT_DELIVERY`）。

## 3. 接线

1. `classifyAutonomyFailure` → `DOCS_GAP`
2. `resolveRepairFixTaskType`：`DOCS_GAP` **先于** explicit，返回 `BUILD`
3. `VerifyingWorkflowTaskExecutor`：失败/门禁红补齐 `failureClass` + `fixTaskType`
4. `createAutonomyFailureRouter` → `FailureRoute.fixTaskType`
5. `WorkflowEngine.replan`：采用 router 的 `fixTaskType`

## 4. 非目标

- 不自动点「重试失败工作流」
- 不改 taskflow-vue 产品 README 内容（由后续 BUILD 修复任务或人工改）
- 不放宽 anti-tamper / 生产 DEPLOY

## 5. 用户下一步

server 吃到新 dist 后：对 FAILED 的 v9 **可再点一次「重试失败」**（应开 BUILD 修 README/docs）；或人工先补 README / `docs/delivery-report.md`。本变更本身不代为点击重试。
