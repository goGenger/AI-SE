# 212 · PL-M30 实施记录（N-29：DEBUG 任务的诚实交接不再饿死自己的重试）

> 阶段：**PL-M30**（任务书 `docs/211`）。用户 2026-10-21 直接指令「开工 N-29」。
> 发现场：**L1-M4q 三次运行全部止步 S1/S2**（`docs/209`）。
> **未在真实批次验证 ⇒ 不判「已关闭」。**

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `apps/server/src/services/workflowTaskExecutor.ts` | 修改 | 新增 `isDebugHandoff` 与 `resolveOutcomeTaskStatus`；`errorType` 与任务状态两处接线 |
| `apps/server/src/__tests__/outcomeRouting.test.ts` | 修改 | **+9 个用例**（8 → 17） |
| `packages/workflow-engine/src/WorkflowEngine.ts` | 修改 | 方案 D：诊断任务失败时在 `reason` 里点明身份 |
| `docs/212-phase-pl-m30-retry-starvation-record.md` | 新增 | 本文件 |

**零依赖改动、零 migration。**

---

## 2. Implementation

### 2.1 判据：`isDebugHandoff`

```ts
export function isDebugHandoff(task: Task, outcome: ProfessionalOutcome): boolean {
  if (task.type !== "DEBUG" || outcome.status !== "REPLAN") return false;
  const fixType = resolveOutcomeFixTaskType(outcome);
  if (fixType !== undefined && isUsableTargetTaskType(fixType)) return true;
  const steps = outcome.metadata.fixSteps;
  return Array.isArray(steps) && steps.length > 0;
}
```

**语义**：DEBUG 任务的 `REPLAN` 是**交接**（「我诊断完了，问题不在我这个类型里」），
不是失败。但**只在它给出了可执行的交接信息时**才算交接——
合法的 `fixTaskType` **或**非空 `fixSteps`；**两者都空 = 纯喊话 ⇒ 仍判失败**（不收养懒）。

**为什么只对 DEBUG 源放宽**：非 DEBUG 任务的 `REPLAN` 确实是「我修不了，换人」，
那里造 `DEBUG + 重试` 是对的 —— **行为逐字不变**。

### 2.2 接线一：任务状态

把原先内联的状态三元式抽成**纯函数**，并把 `handoff` 接进去：

```ts
export function resolveOutcomeTaskStatus(
  runStatus: string,
  outcome: ProfessionalOutcome,
  handoff: boolean
): TaskExecutionResult["status"] {
  if (runStatus === "succeeded") {
    return outcome.status !== "SUCCESS" && !handoff ? "failed" : "succeeded";
  }
  return runStatus === "failed" || runStatus === "cancelled" || runStatus === "timed_out"
    ? runStatus
    : "failed";
}
```

**为什么抽出来**：这是**唯一让修复真正生效的一行**（`&& !handoff`）。
不抽出来的话，把这一行删掉，`isDebugHandoff` 的单测**照样全绿**，而修复被完整退回。
抽成纯函数后有了 4 条接线用例（见 §5）。

### 2.3 接线二：`errorType`

```ts
errorType: handoff ? undefined : resolveOutcomeErrorType(outcome),
```

**交接不是失败，就不该落失败码。** 否则任务虽然记成 SUCCESS，`output.errorType` 仍写着
`REPLAN_REQUESTED` —— 批次归因会把它算进失败分布。

### 2.4 方案 D：让失败原因说人话

`WorkflowEngine.ts` 的 `failWorkflow`：

```ts
`Task failed: ${task.title}${task.type === "DEBUG" ? " (diagnosis task)" : ""}`
```

批次报告里 `Task failed: Diagnose Diagnose …` 的**叠词**是嵌套的直接证据（`docs/211` §2），
加这个后缀让读报告的人不必去猜「这是第几层诊断」。

---

## 3. Architecture Changes

**无。** 不新增任务类型、不新增错误码、不改 `replan()` 的结构或依赖方向。
**改动全部在「结果怎么解读」这一层**，不在「造什么任务」那一层。

---

## 4. Dependencies

**无新增、无升级、无删除。**
`isUsableTargetTaskType` 来自既有的 `@ai-se/shared`（PL-C3 起就是唯一的成员判定来源）。

---

## 5. Tests

**新增 9 个用例**（`outcomeRouting.test.ts`，8 → **17**）：

| 判据 | 用例 | 断言 |
| --- | --- | --- |
| **31a** | DEBUG + REPLAN + 合法 `fixTaskType` | `isDebugHandoff === true` |
| **31a** | DEBUG + REPLAN + 非空 `fixSteps`（无 `fixTaskType`） | `true` |
| **31b** | DEBUG + REPLAN，无合法类型**且**无步骤 / 类型是 `IMPLEMENTATION` / `fixSteps: []` | **`false`**（不收养懒） |
| **31c** | **BACKEND** + REPLAN + 合法 `fixTaskType` | **`false`**（非 DEBUG 语义不变） |
| — | 非 REPLAN 结果 | `false` |
| **接线** | `resolveOutcomeTaskStatus("succeeded", REPLAN, true)` | **`"succeeded"`** |
| **接线** | `("succeeded", REPLAN, false)` | `"failed"`（既有行为不变） |
| **接线** | `("succeeded", SUCCESS, false)` | `"succeeded"` |
| **接线** | `("failed"/"cancelled"/"timed_out", …, true)` | 原样透传 |

**包级门禁**：

| 包 | typecheck | lint | test |
| --- | --- | --- | --- |
| `@ai-se/workflow-engine` | ✅ exit 0 | ✅ exit 0 | **68 / 68** |
| `@ai-se/server` | ✅ exit 0 | ✅ exit 0 | **339 / 339**（由 330 增至 339，即 +9） |

**⚠️ 如实记录的抖动（`docs/145` #7 同族，**未弱化任何测试**）**：
全量 server 套件**第 1、2 轮各挂 1–2 例**，点名的都是既有抖动文件——
`failureRecovery.e2e`（external CANCELLED 用例，两轮都挂）与 `workflowApi.e2e`（第 2 轮）。
**隔离复跑**：`failureRecovery` **连跑 3 次 × 10/10 全过**、`workflowApi` **11/11 全过**；
**第 3、4 轮全量 335/335、339/339 全绿**（第 4 轮含本次 +4 接线用例）。
两条失败**都不在本改动的路径上**（一条是 MCP CANCELLED 的调用计数、一条是工作区路径校验返回
404 而非 400——都不经过 REPLAN 结果解读），判为负载敏感抖动。

---

## 6. Lint / 7. Typecheck

见 §5 表：两包均 **exit 0**。

---

## 8. E2E

**未跑真实批次。** 判据 **31e**（`-REPLAN-` 任务的 PENDING 比例显著下降，基线
**2026-10-21 的 13/28 = 46%**）与 **31f**（切片到达更深）**只能在下一次批次验证**。

---

## 9. Known Issues

1. **未在真实批次验证** ⇒ **不判「已关闭」**。
2. **⚠️ 口径变更（必须预先声明）**：DEBUG 交接任务**不再落 `REPLAN_REQUESTED`**
   ⇒ 下一批的 `errorTypes` 分布里 **`REPLAN_REQUESTED` 会下降**、`FAILED` 总数也会下降。
   **这不是「失败变少了」，是「交接不再被记成失败」。** 按 [[coverage-fixes-look-like-regressions]]：
   **数字变好同样是口径变化，必须对照 `-REPLAN-` 任务的实际运行情况读，不能只看计数。**
3. **`fixSteps` 全库 16/16 为空**（`docs/211` §3.4）⇒ 判据里的 `fixSteps` 分支**当前从不触发**；
   保留它只是为了将来 agent 开始填时无需再改规则。**本次未为它写额外逻辑。**
4. **不解决那 6 个没有合法类型的实例**（全部来自 2026-10-19，历史数据，当前不再产生）。
5. **方案 D 只是措辞**，不改变行为。

---

## 10. Acceptance Result

**交付物是「1 个判据 + 2 处接线 + 1 处措辞 + 9 个用例（含 4 条接线回归）+ 两包门禁全绿」，
已全部给出。**

按仓库记账纪律，判 **「已实施、未在真实批次验证」**，**不判「已关闭」**。

**判据对照**：**31a / 31b / 31c / 31d（单测层）达成**；**31e / 31f 未行使**（需真实批次）。

---

## 11. Next Phase Boundary

**未开始事项（STOP）**：

1. **N-29 的真实批次检验未做**——须等上游恢复后开一批，看 **`-REPLAN-` 的 PENDING 比例**
   （基线 13/28）与**切片到达**。
2. **§9 第 2 项的 `errorTypes` 口径变化**须写进下一批的脚本头，否则会被误读成回归。
3. **N-28**（`docs/210`）任务书已立，**优先级低于本条**，未实施。
4. **N-27**（空转通过）未修；`docs/206`（N-25 用量）按裁定留到 L1-8 验收之后；
   `docs/` 写范围缺致败实例；`AGENTS.md` §6 冲突**未擅自改用户的规则文件**。
