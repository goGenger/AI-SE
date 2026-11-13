# 218 · PL-M34 实施记录（N-33：交付动作写进提示词）

> 阶段：**PL-M34** ｜ 发现场：批次 `l1-m4t` run 1 / run 2
> 用户 2026-10-22 指令「跑完修 VERIFY 规划」。
> **run 3 起用新提示词 ⇒ 未完成三 run 验证，不判「已关闭」。**

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `packages/agent-core/src/planning/prompts/task-planning.prompt.ts` | 修改 | `DELIVERY_READY_LINE` 由「四个任务名」改为**逐条给出四个交付块的动作与类型** |
| `packages/agent-core/src/planning/taskPlanningPrompt.test.ts` | 新增 | **3 个用例** |
| `docs/218-phase-pl-m34-delivery-action-prompt.md` | 新增 | 本文件 |

**零依赖、零 migration、零校验器改动。**

---

## 2. Implementation

### 2.1 缺陷（库内实证）

批次 `l1-m4t` 的最终切片（`slice-3-tasks`）规划出的交付链：

| 任务 | 类型 | 标题 | `input.delivery` |
| --- | --- | --- | --- |
| T16 | BUILD | CI 构建与全量校验 | `{action:"CI"}` |
| T17 | DEPLOY | 部署 staging 环境 | `{action:"DEPLOY", environment:"staging"}` |
| **T18** | **DEPLOY** | **验证 staging 环境** | **`{action:"DEPLOY", environment:"staging"}`** |
| T19 | DEPLOY | 部署 production 环境 | `{action:"DEPLOY", environment:"production"}` |

**T18 的标题是「验证」，契约却是「部署」。** run 1 与 run 2 连续两次同一形状。

后果链：

1. `DeliveryOrchestrator.canHandle` 认 `DEPLOY`+`action:DEPLOY` ⇒ 由编排器**再部署一次**；
2. `packages/eval/src/harness.ts:150-160` 的 `collectStagingSegment` 找的是 **`action === "VERIFY"`** ⇒ 找不到 ⇒ `verify = null`；
3. ⇒ **staging 段恒为 0**。

**两个 run 的真交付率都是 100%（oracle 29/29 全过）**，唯一不达标的就是这一段——所以它不是「做不出来」，是**契约里从来没有 VERIFY 这个动作**。

### 2.2 根因

`task-planning.prompt.ts` 的 `DELIVERY_READY_LINE` 原文：

> End delivery-ready plans with CI BUILD, staging DEPLOY, staging VERIFY, and production DEPLOY tasks.

**只点名四个任务名，从没说过 `delivery.action` 该填什么、也没说过 staging VERIFY 该挂在哪个类型上。** 规划器照语义做了个「验证 staging 环境」的 DEPLOY 任务——语义对、契约错。

`autoFixTaskPlan` 对缺交付块的 DEPLOY 任务默认填 `action: "DEPLOY"`，进一步把错误固定。

这与 N-30 同一类：**规则只在消费侧执行，从没下达给生产者。**

### 2.3 改动

```text
(1) CI:                type BUILD,  delivery {"action":"CI"}
(2) Staging deploy:    type DEPLOY, delivery {"action":"DEPLOY","environment":"staging"}
(3) Staging verify:    type TEST,   delivery {"action":"VERIFY","environment":"staging"}
    - the action MUST be "VERIFY", not "DEPLOY";
      a DEPLOY action here deploys staging again instead of verifying it
(4) Production deploy: type DEPLOY, delivery {"action":"DEPLOY","environment":"production"}
    (human-approved by the Workflow Engine)
```

**为什么给「该填什么」而不只给「别填错」**：规划器需要知道 VERIFY 该挂在 `TEST` 上——仅说「不要用 DEPLOY」它仍不知道正确的形状。

**动词为什么用 `MUST`**：这是平台契约（`DeliveryTaskSchema` 的 action 枚举），不是风格建议。

---

## 3. Architecture Changes

**无。** 只改提示词文案。校验器、`canHandle`、`DeliveryTaskSchema`、`autoFixTaskPlan` 全未动。

---

## 4. Dependencies

**无新增、无升级、无删除。**

---

## 5. Tests

**新增 `taskPlanningPrompt.test.ts`（3 条）**：

| 用例 | 断言 |
| --- | --- |
| 逐条给出四个交付块 | 四条 `(1)…(4)` 的 `type` 与 `action` 均在提示词里 |
| 点名 VERIFY 不是 DEPLOY | 含 `the action MUST be "VERIFY", not "DEPLOY"` 与「DEPLOY 会再部署一次」的说明 |
| 禁止变体不变 | `deliveryConfigured:false` 仍含 `NO Git repository bound`；`isFinalSlice:false` 仍含 `This is NOT the final slice`，且**不含** `Staging verify` |

**为什么测提示词本身**：这条规则的**唯一载体就是这段字符串**。删掉它，所有计划期校验器测试照样全绿，而缺陷完整回归。

**门禁**：`@ai-se/agent-core` typecheck ✅ ｜ lint ✅ ｜ test **261 / 261**（由 258 增至 261）。

---

## 6. Lint / 7. Typecheck

见 §5：均 **exit 0**。

---

## 8. E2E

**批次内验证（部分）**：改动在 `l1-m4t` 的 **run 2 结束、run 3 开始之前**落地并重启平台。
⇒ **该批三个 run 的代码版本不再相同**：

| run | 规划提示词 |
| --- | --- |
| 1、2 | 旧 |
| 3 | **新** |

这是**预先声明的口径变化**，不是同条件对比。

判据：

| 判据 | 内容 |
| --- | --- |
| **35a** | 最终切片出现 `type=TEST` 且 `delivery.action="VERIFY"` 的任务 |
| **35b** | 该任务的执行者 runtime 是 `delivery-orchestrator`（同时验证 N-31 的 33a） |
| **35c** | `collectStagingSegment` 的 `verify` 不再是 `null` ⇒ staging 段可判 |

**注意**：`packages/agent-core` 已重建 dist，平台服务已重启（**dist 不会热重载**）。

---

## 9. Known Issues

1. **提示词不是确定性保证**：模型可能仍不产出 VERIFY 任务。若 run 3 仍无，下一步应做**确定性兜底**——例如在 `autoFixTaskPlan` 里为最终切片补齐缺失的 delivery 动作（那会推翻它「不增删任务」的既有白名单，属设计变更，须单独裁定）。
2. **不解决 `CHECK_TIMEOUT`**（`l1-m4t` run 1 有 11 次、run 2 有 6 次，240 秒超时，`observe` 模式下被记录但不拦截）。
3. **不改变 staging 段判据本身**：它对 `task.type` 不设限（只看 `input.delivery`），这一点是对的。

---

## 10. Acceptance Result

**交付物是「1 段提示词 + 3 条用例 + 包级门禁全绿 + 重建重启」。**

判 **「已实施、部分批次验证（仅 run 3）」**，**不判「已关闭」**。

---

## 11. Next Phase Boundary

**未开始事项（STOP）**：

1. **35a / 35b / 35c 待 run 3 结果**。
2. **`CHECK_TIMEOUT` 未查**——它让验证在 `observe` 模式下被记录却不拦截，是 `VERIFICATION_GATE=enforce` 的前置条件。
3. **N-27 / N-28 / `fixTaskType` 校验**未开工。
4. **周配额**：run 3 起跑时已用约 695M / 700M，可能在中途吃 429。

---

## 12. 追加块（2026-10-22 18:35，**勘误**：35a 在本批次**不可测**）

**上文 §8 的口径声明是错的。** 原文写「该批 run 1/2 用旧提示词、run 3 用新提示词」，
据此把 35a 挂到 run 3 上。**实测推翻**：

| 证据 | 内容 |
| --- | --- |
| `requirement_slices` | 三个切片的 `planning_version` 110/111/112，**`created_at` 全部是 `10-22 09:44`**（run 1 起跑时刻） |
| 计划任务的 `created_at` | run 3 切片 3 的 `T16`–`T19` 指向的**计划任务**生成于 **`10-22 11:02:49`**（run 1 的切片 3 开始时刻） |
| 批次脚本 | `l1-m4t-e1-x3.sh:88`：`if [ "$n" = "1" ]; then EXTRA="--replan"; fi` —— **只有 run 1 强制重规划** |
| `harness.ts:122-128` | 文件内已写明：「`requirement_slices` 是按**需求（计划版本）**存的，**一批多个 run 共用同一份**」 |
| `harness.ts:609` | 「已 `ANALYZED` 的需求需 `regenerate=true` 才会强制重规划（否则服务端早退复用旧计划）」 |

⇒ **`l1-m4t` 的三个 run 共用 run 1 生成的同一份计划，而 run 1 跑在 N-33 落地之前。**
N-33 改的是**规划提示词**，只在该计划生成时被读取一次 ⇒ **本次改动对本批次零作用**，
run 3 的 `T18`（`type=DEPLOY, delivery.action="DEPLOY"`）与 run 1/run 2 **逐字相同**，
因为它是**同一行数据**。

**正确表述**：本批次**完全没验到 N-33**。35a / 35b / 35c 全部不可测——
没有 `action:"VERIFY"` 任务，`DeliveryOrchestrator` 就无从分派，staging 段照旧 0/3。

**对记账的影响**：§8 的「口径变化声明」**撤回**。本批次实为**同代码、同计划**的完整对照，
三个 run 可比性反而比原以为的更好（此前以为混了两个提示词版本）。

**下一个批次的条件**：run 1 带 `--replan` ⇒ 需求重新分析、计划版本递增 ⇒
**切片任务计划按新版本重新生成，新提示词才会被读到**。这是验证 N-33 的最小充分条件，
不是「再跑一批就行」——必须确认计划版本确实递增。

**待决策**：若下一批新计划仍产出 `action:"DEPLOY"` 的「验证」任务，则提示词路线判失败，
转 §9 已知问题 1 的**确定性兜底**（在 `autoFixTaskPlan` 里为最终切片补齐 VERIFY），
那会推翻它「不增删任务」的既有白名单，属设计变更，须单独裁定。
