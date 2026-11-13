# 207 · L1-M4p 批次记录（PL-M25 + PL-M26 的真实验证批，被上游部分污染）

> 批次：**L1-M4p**，2026-10-21 11:51:14 → 14:50:12 CST。
> 脚本 `packages/eval/scripts/l1-m4p-e1-x3.sh`；结果目录 `packages/eval/results/l1-m4p`。
> 性质：**第十六次 E1×3 尝试**，目的是验证 **PL-M25**（`docs/199`/`docs/200`）与
> **PL-M26**（`docs/204`）。**本批取代被上游中止的 L1-M4o**（`docs/203`）。
> **结论：判据 25e(a)/25e(b)/25f/25g/27a/27b 全部确认；主判据 26d 未触及；staging 段 0/3。**

---

## 0. 结论

**PL-M25 与 PL-M26 的核心判据在真实批次里全部成立**（六条），但**主判据 26d 没验到**——
三次运行**都没走到交付段**（`input.delivery` 任务 0、`ci_runs` 0 行）。

**三次运行的致死原因各不相同，而且没有一个是 PL-M25/PL-M26 的回归**：

| run | 致死原因 | 归属 |
| --- | --- | --- |
| 1 | **N-26**（`command-filter` 作用域不隔离，新登记） | **平台缺陷** |
| 2 | 上游 429 ×4（`LLM_ERROR`） | **外部** |
| 3 | 上游 429 ×2（`LLM_ERROR`），7 分钟即死 | **外部** |

⇒ **本批不能用来判 PL-M25/PL-M26 的验收**（26d 未验），**也不能用来判 L1-8**（staging 0/3）。
**但六条次级判据的确认是有效的**，且 run 1 暴露了一个**新的、有代码证据的**平台缺陷。

---

## 1. 批次配置

| 项 | 值 |
| --- | --- |
| 命令 | `caffeinate -s -d -i bash packages/eval/scripts/l1-m4p-e1-x3.sh` |
| 策略 | `failureStrategy=REPLAN / allowRetry=true / allowReplan=true / autonomyLevel=L1 / deployFailureStrategy=ROLLBACK` |
| run 1 额外参数 | `--replan`（run 2/3 无） |
| 守卫 | 起批时 **333,805,594 / 700,000,000**（用户 2026-10-21 裁定「不用关注 token 限额」） |
| 开批前置 | 上游探针**连续两次 6/6**（11:50:11、11:50:59）；平台 pid 50555（含 PL-M26）；0 RUNNING/PENDING |
| 平台 | `:47558`，`PLANNING_MODE=two-level` / `VERIFICATION_GATE=enforce` / `SUBMIT_RESULT_MODE=tool` |
| 看门狗 | `eval-batch-watchdog.sh --batch-pattern l1-m4p-e1-x3.sh --results-dir packages/eval/results/l1-m4p` |

**开批前的上游状态**：09:37 起降级（`429 Upstream request failed: Endpoint is unavailable`），
探针 09:40 **1/3**、09:51 **1/6**、10:11 **1/6**、10:37 **3/6**、10:58 **0/6**、11:24 **1/6**，
**11:50 连续两次 6/6** ⇒ 判定恢复、开批。**该判定事后被证明过于乐观**（见 §5）。

---

## 2. 逐次运行读数

| run | 工作流 | 切片到达 | 任务状态 | `errorTypes` | 耗时 | token（输入/输出） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `3e08ef4c` **FAILED** | auth-persistence | S10 / F4 / P7 | `VERIFICATION_FAILED` 3、`REPLAN_REQUESTED` 1 | 33 min | 9,563,114 / 160,622 |
| 2 | `54446733` **SUCCESS** → `8e6916d9` **FAILED** | **task-core** | S22 / F9 / P9 / R1 | **`LLM_ERROR` 4**、`VERIFICATION_FAILED` 1、`REPLAN_REQUESTED` 3、`EMPTY_FINAL_ANSWER` 1 | 73 min | 31,685,097 / 374,545 |
| 3 | `ab4d7113` **FAILED** | auth-persistence | S2 / F3 / P14 | **`LLM_ERROR` 2**、`REPLAN_REQUESTED` 1 | 7.5 min | 542,341 / 29,994 |

**合计**：输入 **41,790,552** / 输出 **565,161**；耗时 **113.7 min**。
**staging 段：0/3**（`stagingSegment` 三次全 `null`）。**链完成 0/3**。**假阳性 0**（三次都没有自报成功）。

**批次全量 `errorTypes`**（4 个工作流合并）：

| 码 | 次数 | 归属 |
| --- | --- | --- |
| `LLM_ERROR` | **6** | **上游 429**（外部） |
| `REPLAN_REQUESTED` | 5 | 平台（N-22 新增的码，正常） |
| `VERIFICATION_FAILED` | 4 | 平台 |
| `EMPTY_FINAL_ANSWER` | 1 | 平台（真空答案，见 §3 第 6 条） |

---

## 3. 判据逐条

### 3.1 ✅ 判据 25e(b)：`FAILED` 任务空 `errorType` 降到 ~0 —— **确认（最干净的一条）**

| 工作流 | FAILED 总数 | 空 `errorType` |
| --- | --- | --- |
| `3e08ef4c`（run 1） | 4 | **0** |
| `54446733`（run 2 前段） | 4 | **0** |
| `8e6916d9`（run 2 后段） | 5 | **0** |
| `ab4d7113`（run 3） | 3 | **0** |
| **合计** | **16** | **0** |

**对照修复前**：L1-M4n run 2 是「4 个失败只报出 1 个码」、run 3 是「5 个失败只报出 1 个」
（`docs/202` §2.3 的 `failedTaskOutput` 那一半）。⇒ **16/16 全部落码**。

### 3.2 ✅ 判据 25e(a)：`REPLAN` 结果的失败带 `REPLAN_REQUESTED` —— **确认**

`T-008-DEBUG-1`（run 1）：`type=DEBUG`、`status=FAILED`、`outcome=REPLAN`、
`output.errorType=REPLAN_REQUESTED`。批次内该码共 **5** 次。
**修复前**：这条路径记的是**空 `errorType`**（N-22 的机制：除 qa 外所有 agent 的 `REPLAN` 结构性不可达）。

### 3.3 ✅ 判据 25f（正控）：`REPLAN` + `fixTaskType` 产出指定类型 —— **确认**

`T-010-DEBUG-1`（run 2）：`outcome=REPLAN`、`fixTaskType=BACKEND`
⇒ 其重规划 `T-010-DEBUG-1-REPLAN-2` **就是 BACKEND**（`input.targetTaskType=BACKEND`）。
走的是 `debugTargetType` **第 1 步**——**N-22 开的通道真的被走到了**。

**本批共 6 个任务填了根上的 `fixTaskType`**：`T-003`(TEST)、`T-012`/`T-013`/`T-014`(BACKEND)、
`T-010-DEBUG-1`(BACKEND, REPLAN)、`T-007-DEBUG-1-REPLAN-2`(TEST)。

### 3.4 ✅ 判据 25g（负控）：无 `fixTaskType` 时仍是第 3 步兜底 —— **确认**

`T-007`（TEST）**没有** `fixTaskType` ⇒ 其重规划 `T-007-REPLAN-1` 仍为 **TEST**（第 3 步兜底）。
⇒ **兜底路径本批**确实被走到了（不是「全部点名所以兜底没测」）。

### 3.5 ✅ N-23 的交付类型短路 —— **在 TEST 上确认**

| task | type | 源类型 | 结果 |
| --- | --- | --- | --- |
| `T-007-REPLAN-1` | **TEST** | **TEST** | SUCCESS |
| `T-007-DEBUG-1-REPLAN-2` | **TEST** | DEBUG | SUCCESS（`targetTaskType=TEST`） |

失败的 **TEST** 任务重规划后**仍是 TEST**。**修复前** `debugTargetType` 第 3 步会把它换成工作类型
（N-23 的机制）。**但注意**：这**不是**判据 **26d**——26d 要的是 **BUILD/CI** 保留类型并写下
`ci_runs` 行，而本批 **`ci_runs` = 0 行**。

### 3.6 ✅ 判据 27a（正控）：上游失败记 `LLM_ERROR` —— **确认**

```
T-007  agent_run.status = failed
       agent_run.error.code = LLM_ERROR
       agent_run.error.message = "429 Upstream request failed: Endpoint is unavailable..."
```

**PL-M26 起作用了**：上游 429 **被记成 `LLM_ERROR`**。**修复前**它会落成 `EMPTY_FINAL_ANSWER`
——**外部故障被错记成平台故障**（L1-M4o run 1 的 5 例，`docs/203`）。本批共 6 例，逐条可追到
`agent_runs.error` 里的 429。

### 3.7 ✅ 判据 27b（负控）：真·空答案仍记 `EMPTY_FINAL_ANSWER` —— **确认**

`T-007-DEBUG-1`：`output.errorType=EMPTY_FINAL_ANSWER`，而其 `agent_run`
**`status = succeeded`、无 `error`** ⇒ 这是**真正的空答案**（运行成功但没产出），
分类**正确**。⇒ **正控与负控同时成立**，PL-M26 的两侧都被真实数据覆盖。

### 3.8 ❌ 判据 26d（主判据）：**未触及**

```
delivery_tasks = 0
ci_runs        = 0
```

三次运行**都没走到交付段**（最好的 run 2 只到 `task-core`）。⇒ **26d 未验证**，
**PL-M25 不判「已关闭」**。

---

## 4. run 1 暴露的新缺陷 **N-26**（已登记 `docs/146` §3）

**`command-filter` 作用域不隔离**：**兄弟切片**的测试文件钩子失败会把本切片判失败。

**机制**＝两处 `file:line` **各自都已知，但没人把它们的合取连起来**：

1. `apps/server/src/services/taskVerifierRules.ts:301-324` 生成
   `--test-name-pattern '<AC 标记>' --test-timeout=…`，其**注释已写明**
   「`--test-name-pattern` 只筛**测试名**，**文件照跑**」⇒ `node --test` 仍会加载 `test/` 下
   **每个**文件并执行其顶层钩子；
2. `apps/server/src/services/taskVerifier.ts:1174-1176` 的判定是
   `scopedCommand ? last.success && allRelevantPassed : last.success || allRelevantPassed`
   ——**`command-filter` 要求整条命令成功**，于是**任何兄弟文件的钩子失败**都让
   `last.success=false` ⇒ **本切片 AC 全过也判失败**。

**`result-filter` 那一侧免疫**（用 `||`，注释原文「不受其他切片失败影响」）⇒
**只有 `command-filter` 不隔离**。

**实测（run 1，`3e08ef4c`）**：`T-008`（BACKEND，`scopedAcKeys=["AC-01"]`，
`scopingMode=command-filter`）读数 `# tests 10 / pass 7 / fail 3`，而 **AC-01 自己全过**
（`ok 1 - [AC-01] health endpoints`、`acResults:{AC-01:"passed"}`）。3 个失败是：

```
not ok 3 - /workspace/test/login.ac09-10.test.js
  failureType: 'hookFailed'  error: 'Server is not running.'  code: 'ERR_SERVER_NOT_RUNNING'
not ok 5 - /workspace/test/register.ac02-03-05-06-07-08.test.js   ← 同形
```

那两个文件是**兄弟切片**的 QA 任务（`T-006`，TEST→QA，`writePaths` 含 `test`）在 12:01
**合法**写入的，其所需接口当时尚未实现 ⇒ 钩子起不来。
⇒ `T-008` 重规划三次（`T-008-REPLAN-1` / `…-REPLAN-2`）**同因失败**，链耗尽，
工作流 FAILED、停在切片 1。

**决定性对照**：同一条链上的 DEBUG 任务用的是**全 AC 模式**，读数
`# tests 56 / pass 56 / fail 0`、`verified: true`、13/13 ⇒ **作用域一缩小就挂、放到全量就过**。

**普遍度**：该形状全库 **10-16 起就有**（10-17 有 2、10-18 有 6、10-19 有 25），但
**那些来自别的夹具**（`I1`/`I2`/`I3`）且**无钩子失败**；**E1 上的 `ERR_SERVER_NOT_RUNNING`
子形态今天之前为 0**（10-20 的 L1-M4n 全程 0）⇒ **缺陷本身是旧的，今天第一次在 E1 上成为致死点**。
**为什么本批才绑定：未解**，不编理由。

### 4.1 两处**已撤回**的候选缺陷（查代码后不成立）

| 候选 | 结论 |
| --- | --- |
| **`test/` 写拒绝是缺陷** | **不成立**：`test/tests/__tests__` 归 **QA**（`AgentRegistry.ts:198`）；`T-006` 是 **TEST→QA**，写得**合法**；`T-002`/`T-008` 是 BACKEND，被拒是**正确执法**（`:159` 的 `writePaths` 不含 `test`）。**不是缺陷** |
| **N-23 修复引入「DEBUG 任务 targetTaskType=DEPLOY 派不出去」** | **不成立**：`deployFailureStrategy` 优先于通用 `failureStrategy`（`WorkflowEngine.ts:826-832`），`strategy` 被**无条件**改写为 `ROLLBACK`（连 `routed?.strategy` 都被压过）⇒ 失败 DEPLOY 走**回滚分支**（`:895-899`），**`replan()` 根本不执行**；且 `debugTargetType` 全仓**只有一个调用点**（`:981`）。详见 `docs/200` §7.2 |

---

## 5. 上游污染（**预先声明的记账口径**）

**开批时的「连续两次 6/6」判定过于乐观。** 批中上游持续抖动：

| 时刻（CST） | 事件 |
| --- | --- |
| 13:18 | `T-007` 429（68s） |
| 14:01 | `T-06` 429（11s）、`T-02` 429（13s） |
| 14:10 | `T-06-DEBUG-1-DEBUG-2` 429（110s） |
| 13:32 / 14:13 探针 | **6/6** / **6/8**（75%，低于 `docs/203` §6 的 ≥5/6 门） |
| 14:42 起的 run 3 | 7 分钟即死，`LLM_ERROR` 2 |

**记账口径（按 `docs/204` §7 裁定 3「不自动暂停、人工判断」，开批前即声明）**：

- 凡 `errorType='LLM_ERROR'` 且其 `agent_runs.error` 为 **429** 的，**从平台失败数里剔除**，
  另列「上游」；
- 本批 **6 个 `LLM_ERROR` 全部是 429** ⇒ **平台自身造成的 `FAILED` 是 10 个**
  （`REPLAN_REQUESTED` 5 + `VERIFICATION_FAILED` 4 + `EMPTY_FINAL_ANSWER` 1）。

**为什么这次不中止批次**（与 `docs/203` 的区别）：`docs/203` 中止是因为上游故障
**被错记成平台故障**（`EMPTY_FINAL_ANSWER`），**读数分不出来**；**PL-M26 修的正是这件事**，
现在污染**可见且可剔除**。⇒ 降级不再使整批读数失效。**run 3 是例外**——它 7 分钟内 3 个失败里
2 个是 429，**实质是无效运行**。

---

## 6. Modified Files

| 文件 | 动作 |
| --- | --- |
| `docs/207-phase-l1-m4p-record.md` | **新增**（本文件） |
| `packages/eval/scripts/l1-m4p-e1-x3.sh` | 新增（批次脚本，开批前建） |
| `packages/eval/scripts/l1-m4p-stop.sh` | 新增（停止脚本，开批前建） |

**零 `src/` 改动、零测试改动、零依赖改动。** 批中只做只读查询（`SELECT`）。

---

## 7. Implementation

**无代码实施。** 本批是**验证批次**，不是实施批次。

---

## 8. Architecture Changes

**无。**

---

## 9. Dependencies

**无新增、无升级、无删除。**

---

## 10. Tests

**不适用**（零代码改动）。本批跑的是 E1 端到端夹具，读数见 §2/§3。

---

## 11. Lint

**不适用**（同上）。

---

## 12. Typecheck

**不适用**（同上）。

---

## 13. E2E

**已跑**：E1 × 3（`--autonomy-l1`，run 1 带 `--replan`）。**staging 段 0/3**、
**链完成 0/3**、**假阳性 0/3**、**超范围写入 0**。三次均未到达交付段。

---

## 14. Known Issues

1. **26d 未验证** ⇒ **PL-M25 不判「已关闭」**；**PL-M26 的 27a/27b 已在真实批次确认**，
   但按仓库记账纪律仍应连同下一批一起收口。
2. **N-26 未修**（新登记，修法未设计）。
3. **run 3 实质无效**（7 分钟内 2/3 失败是上游 429）。
4. **「为什么 N-26 本批才绑定」未解**。
5. **`docs/204` §7 裁定 2 的「环境」层仍未新增** ⇒ 6 个上游 429 在 `failureLayers` 里
   **仍落在 agent 层**（run 3 的 `failureLayers.agent = 3` 全是上游造成的）。这是**已知的**
   分层局限，不是新问题。
6. **run 2 的第一个工作流判 SUCCESS**（`54446733`），其 4 个失败任务被 replan 链救回
   （`T-010-REPLAN-1` / `T-007-REPLAN-1` 都 SUCCESS）——**恢复机制在真实批次里又工作了一次**。

---

## 15. Acceptance Result

**本批不判任何「已关闭」。** 交付物是「六条次级判据的真实批次确认 + 一个带代码证据的新缺陷 +
一个预先声明的污染口径」，已全部给出。

- **PL-M25**：判据 25e(a)/25e(b)/25f/25g **确认**；**26d 未验** ⇒ **不判「已关闭」**。
- **PL-M26**：判据 27a/27b **确认**（正控与负控同时成立）⇒ 可判「已在真实批次验证」，
  但**建议与下一批一并收口**。
- **L1-8**：**未达成**（staging 0/3，第三次连续未达）。

---

## 16. Next Phase Boundary

**未开始事项（STOP）**：

1. **N-26 未修**——修法登记了两条方向（判定改看作用域内 AC 的实际结果 / 命令真正只加载本切片
   的测试文件），**均未设计**。
2. **26d 未验** ⇒ 需要**再一次批次**，且该批次必须**走到交付段**。
3. **`docs/204` §7 三项裁定**已落（不新增「环境」层 / 不自动暂停 / watch item 补 429 口径）；
   §14 第 5 条的后果（上游失败仍归 agent 层）**已如实记录**。
4. **`docs/202` §9 剩余**：`docs/206`（N-25 规划段用量）待 L1-8 验收批次之后实施；
   `docs/200` §7.1 的「两步修复」未设计；`docs/` 写范围缺致败实例；
   `AGENTS.md` §6 的 agent-core 归类冲突未裁定（**未擅自改用户的规则文件**）。
5. **上游是否恢复**——本批结束时仍在抖动（探针 6/8、run 3 被 429 掐死）。
