# 258 · 官方门禁失败项并入修复任务，避免被当成范围外

> 状态：**已落地**（2026-11-10 Asia/Shanghai）
> 动机：`docs/257` 落地后，工作流 `514705b2-…` 的 T-14 已成功，切片末官方 E2E 跑起来了。T-15 正确转到 TEST。第一轮 TEST 修好了 AC-19 夹具标题和 AC-04 默认筛选项，但官方全量 E2E 仍有 4 条 `task-crud`（AC-02/03/14）因选择器精确匹配「编辑 / 删除 / 查看详情」失败——产品可访问名是「编辑任务 <标题>」这类带标题的唯一名称。修复任务只继承了 T-15 的 AC-07/08/09/15/18/19，brief 又是上一轮「不在本任务范围，故未修改」的自报摘要，第二轮继续把这 4 条当成范围外，修复轮次用尽。

---

## 1. 约定

官方门禁（尤其是切片末 E2E）失败后开出的修复任务，必须把**官方失败的检查名、失败用例和 AC 编号**写进任务说明，并把这些 AC **并入且排在** `input.acKeys` 前面。上一轮 Agent 的自报摘要可以保留在后文，但不能再单独充当 brief，也不能因为源任务声明的 AC 列表没包含它们就把官方红项当成范围外。

没有官方 verification、或全部检查已通过时，行为与原来一致。

## 2. 接线

1. `packages/workflow-engine/src/officialGateFailure.ts`：从失败检查的 stdout/stderr 解析 Playwright / Vitest 失败用例与 `[AC-xx]`
2. `WorkflowEngine.replan()`：用上述结果改写修复任务 description，并 `mergeAcKeys`

## 3. 非目标

- 不把切片末官方 E2E 收窄到修复任务自己的 AC 列表；全量 E2E 仍是切片末与 CI 的收口
- 不在本变更中改产品源码的可访问名（选择器应对齐已有的「编辑任务 <标题>」口径）
- 不自动重试工作流 `514705b2-…`（由本轮交付后的重试触发）
- 不切 DeepSeek / 不改 `.env`
- 不放宽 anti-tamper / 生产 DEPLOY

---

后续：内容快照截断导致反篡改误判，见 [docs/259](./259-protected-content-snapshot-and-reports.md)。
