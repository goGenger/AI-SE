# 209 · L1-M4q 批次记录（PL-M27/N-26 的验证批：主判据未行使，N-27 被系统性观测到）

> 批次：**L1-M4q**，2026-10-21 15:39:21 → 18:17 CST。
> 脚本 `packages/eval/scripts/l1-m4q-e1-x3.sh`；结果目录 `packages/eval/results/l1-m4q`。
> 性质：**第十七次 E1×3 尝试**，目的是验证 **PL-M27（N-26）**，并补验 **PL-M25 的 26d**。
> **结论：staging 0/3；29a 未行使、26d 仍未触及；29b（负控）在真实批次确认；
> N-27（空转通过）被系统性观测到 3 次。**

---

## 0. 结论

**本批没能验证 N-26 的修复。** 判据 **29a** 要求出现「作用域 `test` 检查**非零退出**、
但作用域内 AC **全过**」的实例——三次运行里**一次都没出现**：所有 `command-filter` 检查要么
`exitCode 0`，要么 `exitCode 1` 且**作用域 AC 真的失败**（后者反而确认了负控 **29b**）。

**26d 连续第三批未触及**：三次运行**都没走到交付段**（`input.delivery` 任务 **0**、`ci_runs` **0 行**）。

**本批最有价值的产出不是验证，而是观测**：`docs/208` §7 里我写成「既有、未修、理论上可以」的两个
残留口子，在**三个 run 里全部稳定复现**，其中 **N-27（零测试却判通过）三次全部来自同一个任务 `T1`**。

---

## 1. 批次配置

| 项 | 值 |
| --- | --- |
| 命令 | `caffeinate -s -d -i bash packages/eval/scripts/l1-m4q-e1-x3.sh` |
| 策略 | `failureStrategy=REPLAN / allowRetry=true / allowReplan=true / autonomyLevel=L1 / deployFailureStrategy=ROLLBACK` |
| run 1 额外参数 | `--replan` |
| 守卫 | 起批时 **375,596,146 / 700,000,000**（用户 2026-10-21 裁定「不用关注 token 限额」） |
| 上游探针 | **连续两次 6/6**（15:37:05、15:37:42） |
| **平台重启** | **已重启**：pid 50555 → **35177**。源码 `taskVerifier.ts` 改于 **15:30:24**、服务起于 **15:39** ⇒ **N-26 修复确实被加载**（这是最容易漏的一步） |
| 库 | 开批前 0 RUNNING / 0 PENDING |

---

## 2. 逐次运行读数

| run | 工作流 | 切片到达 | 任务状态 | `errorTypes` | 耗时 | token（输入/输出） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `9faa326e` **FAILED** | S1-foundation-deploy | ok=8 / bad=5 / pend=2 | `REPLAN_REQUESTED` 4、`LLM_ERROR` 1 | 42 min | 5,537,001 / 170,607 |
| 2 | `cfc082e1` **FAILED** | S1-foundation-deploy | ok=2 / bad=3 / pend=5 | `VERIFICATION_FAILED` 1、`REPLAN_REQUESTED` 2 | 14 min | 2,830,932 / 86,855 |
| 3 | `5e7b456a` **SUCCESS** → `77585ba5` **FAILED** | **S2-auth-persistence** | ok=6 / bad=3 / pend=5 | `TOOL_ERROR` 1、`REPLAN_REQUESTED` 2、`VERIFICATION_FAILED` 1 | 46 min | 11,306,860 / 244,025 |

> **⚠️ 更正（2026-10-21 18:33，逐库核对后发现）**：run 3 **有两个工作流**——
> `5e7b456a` 于 **17:56:59 CST 判 SUCCESS**，随后 `77585ba5` 于 18:00 起、18:16 判 FAILED。
> **本记录初稿只写了后一个**（我当时只看了看门狗最后一次心跳里的那个 id）。
> eval summary 的 `workflowIds` 本来就有两条，**是我没逐条核**——正是
> [[batch-attribution-needs-db-verification]] 要防的那种漏记。
> **这个 SUCCESS 是本批唯一的正向信号**：run 3 的第一个工作流**跑完了它负责的范围**，
> 第二个工作流才失败。run 2 的 L1-M4p 也是同一形态（第一个 SUCCESS、第二个 FAILED）。

**合计**：输入 **19,674,793** / 输出 **501,487**；**staging 段 0/3**；**链完成 0/3**；假阳性 0。

**批次全量 `errorTypes`**（12 个 FAILED 任务）：

| 码 | 次数 | 归属 |
| --- | --- | --- |
| `REPLAN_REQUESTED` | 8 | 平台（N-22 新增的码，正常） |
| `VERIFICATION_FAILED` | 2 | 平台 |
| `LLM_ERROR` | **1** | **上游 429**（外部） |
| `TOOL_ERROR` | 1 | 平台（`T7-data-store-hash`，DATABASE） |

**上游**：全批**只有 1 次 429**（15:42），远好于 L1-M4p 的 6 次 ⇒ **本批读数基本不受上游污染**。

---

## 3. 判据逐条

### 3.1 ❌ 判据 29a（PL-M27 主判据）：**未行使**

**要求**：一个 `command-filter` 检查 `exitCode != 0`、而 `acResults` 里**每个作用域 AC 都是 `passed`**、
任务仍 SUCCESS/`verified`。

**本批全部 `command-filter` 检查的读数**（三次运行合计）：

| run | task | `passed` | `exitCode` | `acResults` | `# tests 0` | 兄弟钩子失败 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `T4` | true | **0** | `{AC-21: passed}` | 否 | 否 |
| 1 | `T1-REPLAN-1` | true | **0** | 空 | 否 | 否 |
| 1 | `T1-DEBUG-1-DEBUG-2` | true | **0** | 空 | 否 | 否 |
| 1 | `T1-DEBUG-1-REPLAN-2` | true | **0** | 空 | 否 | 否 |
| 2 | `T1` | true | **0** | 空 | **是** | 否 |
| 2 | `T4` | **false** | **1** | **`{AC-21: failed}`** | 否 | 否 |
| 3 | `T1` | true | 0 | 空 | **是** | 否 |
| 3 | `T4` | true | 0 | `{AC-21: passed}` | 否 | 否 |
| 3 | `T7-DEBUG-1` | true | 0 | 两个都 passed | 否 | 否 |
| 3 | `T7-REPLAN-1` | true | 0 | 两个都 passed | 否 | 否 |
| 3 | `T1-scaffold` | true | 0 | 空（13 个 AC） | 否 | 否 |

⇒ **`exitCode != 0` 只有一例（run 2 的 `T4`），而它的作用域 AC 是真的失败了** ⇒ **29a 未行使**。
**要行使它，必须有兄弟切片的测试文件钩子失败**——那需要更靠后的切片（本批最远只到 S2）。

### 3.2 ✅ 判据 29b（负控）：作用域 AC 真失败仍判失败 —— **确认**

`T4`（run 2）：`exitCode 1`、`scopedAcKeys=["AC-21","AC-22"]`、
`acResults={"AC-21":"failed"}` ⇒ 检查 `passed: false`、任务 `VERIFICATION_FAILED`。

⇒ **PL-M27 没有把规则放水**——这是**真实批次**的判别力证据，不是单测里造的。

### 3.3 ❌ 判据 26d：**连续第三批未触及**

```
delivery_tasks = 0
ci_runs        = 0
```

三次运行**都没走到交付段**（最远的 run 3 只到 `S2-auth-persistence`）⇒ **26d 未验证**，
**PL-M25 仍不判「已关闭」**。

### 3.4 ✅ 判据 25e(b) 回归抽查：`FAILED` 任务空 `errorType` —— **仍为 0**

本批 **12 个 FAILED 任务、空 `errorType` 0 个**。⇒ PL-M25 的 `failedTaskOutput` 那一半持续有效。

---

## 4. 本批的**主要产出**：N-27 与「部分证据」被系统性观测到

**这不是本批的目标，是本批的副产品，但它比目标更有信息量。**

`docs/208` §7 我把两个残留口子写成「既有、未修、理论上可以」。
**三个 run 里它们全部稳定复现**：

| 形状 | 实例 | 读数 |
| --- | --- | --- |
| **N-27 空转通过** | `T1`（**run 1、2、3 各一次**） | `scopedAcKeys=["AC-21","AC-22"]`、`acResults` **空**、TAP **`1..0 / # tests 0`**、`exitCode 0`、`passed: true` |
| **部分证据（M<N）** | `T4`（run 1、3） | `scopedAcKeys=["AC-21","AC-22"]`，`acResults` 只有 `AC-21`，**AC-22 从未出现**，仍通过 |
| **作用域失效（测试跑了但无 AC 标记）** | `T1-scaffold`（run 3） | 13 个 AC、`acResults` 空、TAP 非零测试、通过 |

**关键判断**：`T1` 的 `# tests 0` **在每个 run 都出现**，来自**同一个任务**——
这不是偶发，而是**结构性空转**：该任务的 AC 在当时没有任何匹配的测试，检查却判通过。

⇒ **N-27 从「理论上可以」升级为「每个 run 都在发生的稳定形状」**。
**但仍不据此修**：那 41 次「测试跑了但无 AC 标记」的形态（`T1-scaffold` 是一个）尚未普查，
而修法「要求每个 AC 都出现且 passed」会让它们翻红。**须先普查再定**（[[verdict-rules-need-a-census]]）。

---

## 5. 三次运行各自的死因（**都不是 N-26 / N-27**）

| run | 死因 |
| --- | --- |
| 1 | `T7`（REVIEW）反复报 `REPLAN_REQUESTED`（`T7` → `T7-DEBUG-1` → `T7-DEBUG-1-DEBUG-2` 全 REPLAN）⇒ 链耗尽；另有 `T1` 一次 429 |
| 2 | `T4`（BACKEND）`VERIFICATION_FAILED`（AC-21 真失败）⇒ DEBUG → REPLAN → DEBUG-2 → REPLAN ⇒ 链耗尽 |
| 3 | `T7-data-store-hash`（DATABASE）`TOOL_ERROR` ⇒ DEBUG(`REPLAN_REQUESTED`) → DEBUG-2(`VERIFICATION_FAILED`) ⇒ 链耗尽 |

**共性：三次都是「REPLAN 链走到底仍失败」**——这正是 `docs/200` §7.1 登记的「两步修复」那一族，
**仍未设计修法**。

---

## 6. Modified Files

| 文件 | 动作 |
| --- | --- |
| `docs/209-phase-l1-m4q-record.md` | **新增**（本文件） |
| `packages/eval/scripts/l1-m4q-e1-x3.sh` | 新增（开批前建） |
| `packages/eval/scripts/l1-m4q-stop.sh` | 新增（开批前建） |

**零 `src/` 改动**（PL-M27 的改动发生在本批**之前**，记录在 `docs/208`）。批中只做只读查询。

---

## 7. Implementation

**无代码实施。** 本批是验证批次。

---

## 8. Architecture Changes

**无。**

---

## 9. Dependencies

**无新增、无升级、无删除。**

---

## 10. Tests

**不适用**（零代码改动）。PL-M27 的 4 个新用例见 `docs/208` §5。

---

## 11. Lint

**不适用**（同上）。

---

## 12. Typecheck

**不适用**（同上）。

---

## 13. E2E

**已跑**：E1 × 3。**staging 段 0/3**、链完成 0/3、假阳性 0、超范围写入 0。
三次均未到达交付段。最远到达 **S2-auth-persistence**。

---

## 14. Known Issues

1. **29a 未行使** ⇒ **PL-M27 不判「已关闭」**。
2. **26d 连续第三批未触及** ⇒ PL-M25 仍不判「已关闭」。
3. **N-27 已登记未修**（`docs/146` §3），且本批三次复现——**但它不是本批的致死原因**。
4. **三次致死全部是「REPLAN 链到底仍失败」**——`docs/200` §7.1 的「两步修复」未设计。
5. **上游只 1 次 429**，本批读数基本干净（与 L1-M4p 的 6 次形成对照）。
6. **`TOOL_ERROR` 1 例**（`T7-data-store-hash`，DATABASE）——**未追因**，任务 `output.error` 为空；
   若要定性须单独查该 run 的 `tool_calls`。

---

## 15. Acceptance Result

**本批不判任何「已关闭」。** 交付物是「主判据未行使的如实记录 + 负控在真实批次确认 +
N-27 的系统性复现证据」，已全部给出。

- **PL-M27（N-26）**：**29b 确认、29a 未行使** ⇒ **不判「已关闭」**。
- **PL-M25**：**26d 仍未触及** ⇒ **不判「已关闭」**。
- **PL-M26**：本批 1 次 429 记 `LLM_ERROR`，与 L1-M4p 的 6 次一致，**回归上无异常**。
- **L1-8**：**未达成**（staging 0/3，**连续第四批未达**）。

---

## 16. Next Phase Boundary

**未开始事项（STOP）**：

1. **29a 与 26d 都要求链走到更深处**——而三次都止步 S1/S2。⇒ **下一批的前提不是再修一个判据，
   而是弄清「为什么链走不过 S2」**（三次死因都是 REPLAN 链到底失败）。
2. **N-27 未修**；修前须先普查那 41 次「无 AC 标记」的形态。
3. **「两步修复」未设计**（`docs/200` §7.1）——它现在是**三次致死的共同形状**，优先级应上调。
4. **`TOOL_ERROR` 那 1 例未追因**（§14 第 6 项）。
5. `docs/206`（N-25 规划段用量）按裁定留到 L1-8 验收批次之后；
   `docs/` 写范围缺致败实例；`AGENTS.md` §6 冲突**未擅自改用户的规则文件**。
