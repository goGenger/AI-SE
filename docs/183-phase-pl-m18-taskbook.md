# 183 · L1-M4i 两处新致败点任务书（PL-M18）

> 状态：**待裁定**（2026-10-18）。用户 2026-10-18「**先立项那两个新致败形态**」。**立项 ≠ 开工授权**（`docs/146` §0）——§7 八项须逐条裁定后另起开工令。
> 依据：**L1-M4i 批次实测**（`packages/eval/results/l1-m4i`）、库内 `tasks` / `agent_runs` / `workflow_events` 实查（2026-10-18）、**代码实查**（`apps/server/src/services/taskVerifier.ts` / `taskVerifierRules.ts`、`packages/agent-core/src/professional/ProfessionalAgent.ts`、`packages/agent-core/src/planning/validateImplementationCoverage.ts`、`packages/workflow-engine/src/WorkflowEngine.ts`）。
> 性质：**任务书（实施前设计）**，不是实施记录。**本文件不新造验收编号**——修的是缺陷，判据编号 **18a–18h** 供验收使用。

---

## 0. 为什么现在做这一批

1. **L1-8 仍未达成**：L1-M4i 的 staging 段 **0/2**（判据 ≥ 2/3）。链已走到迄今最深（run 2 首次连过 slice-3、**首次进入 slice-4**），**止步点已经不在控制流缺陷上**。
2. **上一批的「下一堵墙」判断被本批推翻**。L1-M4h 登记的「核心实现切片的 BACKEND 任务过不去」在 L1-M4i **两次被越过**（`checks failed: test` 重试后全部 SUCCESS）。本批两个 run 各死于一个**非 BACKEND 类型**任务：run 1 死于 **TEST**，run 2 死于 **REVIEW**。
3. **纪律要求先清缺陷再花配额**：按「花配额跑验收批次前必须先清掉所有已知缺陷」的口径，这两个是当前**已知的、最可能拦住链的**。在修掉它们之前再跑批次，等于用配额去重新发现同一个东西。
4. **时间窗口正好**：默认纪律「一周最多一个 E1×3 批次」；本批已超发（同一窗口内第 4 个），且周配额 **220,230,542 / 200,000,000 已超止损线**，下一批最早落在 **2026-10-19 07:00 CST**（窗口刷新）之后。这段时间用于修复。

---

## 1. 范围与排除

**范围内**（两项，各自独立修、独立判）：

| 编号 | 名称 | 终止的 run | 类型 |
| --- | --- | --- | --- |
| **N-10** | TEST 任务的**红灯检查范围回退**——无 `acKeys` 锚点时范围放大到「全测试套件里出现的所有 AC」 | L1-M4i **run 1** | 平台侧（验证门） |
| **N-11** | REVIEW 任务判「**不通过**」后**无出路**——诚实负结论被当作任务失败，重试不可能收敛 | L1-M4i **run 2** | 平台侧（控制流 / 既有 FIX 路径从未走通） |

**排除**（本批不做，只登记）：

- **`INVALID_AGENT_RESULT`**（L1-M4i 里属于 `T-S4-R1`，**不是** `T-S4-R2`）——**已自愈**（`retry=1 → SUCCESS`）。登记为观察项，见 §2.5。
- **`EMPTY_FINAL_ANSWER`**（本批 1 条；L1-M4h 5 条）——机制未查明，登记。
- **BACKEND 任务的 `checks failed: test`**——本批两次均**重试后 SUCCESS**，**降级为观察项**（不再是墙）。
- 「重建消息必须保留 `additional_kwargs`」的不变量化（`docs/181` §7 第 6 项）——仍另立议题。
- 便宜档探针的形态 / 频率（自 `docs/177` 挂起）；`T-DESIGN-S1` 计划粒度。

---

## 2. 基线事实（实测）

### 2.1 本批两次 run 的终止点（含对先前报告的更正）

| run | 终止任务 | 类型 | 切片 | retry | 表面标签 |
| --- | --- | --- | --- | --- | --- |
| 1 | `T10` | **TEST** | slice-2 | 2 | `VACUOUS_TEST` ×3 |
| 2 | `T-S4-R2` | **REVIEW** | slice-4 | 2 | agent 自报 `outcome: FAILED`（**不是** `INVALID_AGENT_RESULT`） |

**两处必须更正的先前说法**：

- 我在批次收尾报告里说「**run 1 死在 BACKEND 任务**」——**错**。BACKEND 的 `checks failed: test` 只出现 2 次（run 1 的 `T6` / `T5`），**两次都 `retry=1 → SUCCESS`**。run 1 的终止任务是 **`T10`（TEST）**。
- 我把两处归为「**同属上游产物质量，不是平台控制流缺陷**」——**错**。见 §2.2 / §2.3：**两处都是平台侧**（N-10 是验证门的范围计算；N-11 是既有 FIX 路径在生产上从未走通）。
- `INVALID_AGENT_RESULT` 在 L1-M4i 里属于 **`T-S4-R1`**（REVIEW，slice-4，**另一个任务**），且那个任务 `retry=1 → SUCCESS`。run 2 的终止任务 `T-S4-R2` 的 `outcomeMode` 是 **`tool`**（结构化提交成功），不是解析失败。

### 2.2 N-10 · TEST 红灯检查的「范围回退」

**规则（代码实查）**：

- `apps/server/src/services/taskVerifierRules.ts:119-124`——**每个 TEST 任务的 `test` 检查被无条件标为红灯检查**：
  `expectation: candidate === "test" && taskType === "TEST" ? "fail" : "pass"`。不是规划器选的。
- `apps/server/src/services/taskVerifier.ts:682-712`（红灯判定）：命令非零退出 → 红灯成立（`achieved: true`）。命令成功时**唯一**的通过路径是
  `:708  if (result.success && allPassed && evidence === "implemented") return { achieved: true, expected: "pass" };`
  否则 `:712` 判 **`VACUOUS_TEST`**。
- `:702` 的作用域来自 `scopedEvidenceKeys(task, parsedKeys)`；`:209-220` 的关键两行：
  ```
  :211  if (!Array.isArray(declared)) return parsedKeys;   // 任务没声明 acKeys
  :217  if (scope.size === 0) return parsedKeys;           // 声明了但是空数组
  ```
  ⇒ **无锚点（或空锚点）时，范围回退为 `parsedKeys`**。
- `parsedKeys` 来自 `parseAcResults`（`taskVerifierRules.ts:269-297`）：从 `stdout + stderr` 的**每一行 TAP / runner 记号**里抽出 AC 编号——即**整个测试套件里出现过的所有 AC**，**跨切片**。
- `acImplementationEvidence`（`:721-`）要求作用域内**每一个** AC 都有「同需求、已成功、开发类（BACKEND / FRONTEND / DATABASE / DEBUG）、且完成于检查时刻之前」的任务覆盖（自引用除外）。

**本批实测**：

| 事实 | 值 |
| --- | --- |
| `T10` 的 `input.acKeys` | **不存在**（`acKeys=NONE`） |
| `T10`（run 1） | `FAILED`，`retry=2`，三次验证失败事件 **03:48:23 / 03:51:17 / 03:52:39**，reason 均为 `red-light check passed without implementation (VACUOUS_TEST): test` |
| `T10`（run 2，**同一个 task_key、同样无 acKeys**） | **`SUCCESS`，`retry=0`**（05:15:24→05:17:05） |
| run 1 的 T10 自报套件规模 | `pnpm test` exit 0，**50 tests**，其中 **25 条**标题带 `[AC-04]` |
| run 2 的 T10 自报套件规模 | `pnpm test` exit 0，**39 tests**，其中 **10 条**标题带 `[AC-04]` |
| 全批 TEST 任务中**有** `acKeys` 的 | **7 个**（`T3` / `T-02` / `T-03` / `T-04` / `T-05` / `T-S4-T1` / `T-S4-T2`）——**全部 `retry=0` SUCCESS** |
| 全批 TEST 任务中**无** `acKeys` 的 | **4 个**（`T-7` / `T-6` / `T4` / `T10`）——`T10` 在 run 1 失败，其余全过 |

**H-10（待探针证实的假设）**：无锚点的 TEST 任务，其红灯作用域被放大到**整个套件**；只要套件里出现**任何一个**其实现证据不齐的 AC（本批是尚未实现的交付类 AC），判定即恒为 `VACUOUS_TEST`——**无论 agent 做什么**。

**为什么这是平台侧**：`T10` 的通过与否**不取决于 agent 的产出质量**，而取决于「此刻套件里恰好出现了哪些 AC」。同一个 task_key、同样无锚点，run 1 失败、run 2 通过。**agent 的产出在两次里都合格**（run 1 的 T10 自报 `pnpm test` exit 0、50/50 全绿、并做了 AC 命名审计）。

**一处诊断缺陷（附带，不单独立项）**：reason 字符串拼的是**检查名**（`taskVerifier.ts:407,412` 的 `check.name`，即 `"test"`），**不是缺证据的 AC 编号**。⇒ 生产日志只能看到 `VACUOUS_TEST: test`，看不到是哪个 AC 把判定拖死——这是本批定位花了额外代价的直接原因。修 N-10 时应一并把 AC 编号写进 reason。

**空锚点本身是已知的**：`docs/126` 记录了 PL-M7 / PL-M8 的回填只保证「每条范围内 AC 至少被某个任务引用」，**不保证每个任务都有锚点**。`scopedEvidenceKeys` 的空锚点回退是**有意设计**（`:211` / `:217` 两行都在），本批暴露的是**这个回退与「实现证据须全数齐备」叠加后的后果**。

### 2.3 N-11 · REVIEW 判「不通过」无出路

**本批实测**：

| 事实 | 值 |
| --- | --- |
| `T-S4-R2` | REVIEW，slice-4，**3 次尝试**（`retry=2`），**全部 FAILED** |
| 最后一次的 `output` | `outcome=FAILED`、`outcomeMode=**tool**`、`iterations=19`、`artifactCount=9`、`agentName=reviewer-agent` |
| 3 个 `agent_runs` | **全部 `succeeded`**，无 `error`，无 `errorType`（顶层与 `metadata` 均无） |
| agent 的自报结论 | **「Result: NOT APPROVED because project-wide `pnpm test` is NOT green」**——145 tests / 144 passed / 1 failed，失败的是 **`FR-9.6 [AC-30]`（`test/contract.test.js:189`，断言每条测试标题都带 FR-x.y / AC-xx 编号）**，被**本切片自己写的两条标题**触发（`test/task-create.test.js:491` / `:515`） |
| `output.metadata` | **空**——**没有 `fixTaskType`** |
| 由它派生的 FIX 任务 | **无**（`source_task_id` 指向它的任务为 0 条） |
| 全库 `FIX-*` 任务 | **0 条**（**历史从未产生过一条**） |

**形状**：REVIEW agent **正确地**发现了本切片的一个**真实缺陷**（本切片的 TEST 任务写了不带 AC 编号的标题，触发了仓库自己的 AC-30 契约测试），于是**诚实地判了「不通过」**。平台的语义把 agent 的 `outcome: FAILED` 读成「**这个任务失败了**」→ 重试 → agent 再查一遍、**再得出同一个结论** → 重试耗尽 → 任务 FAILED → 链停在 slice-4。

**为什么重试不可能收敛**：缺陷是**确定性的**（标题就长那样），而 **REVIEW 不是开发类任务**（`DEV_TASK_TYPES = BACKEND / FRONTEND / DATABASE / DEBUG`，不含 REVIEW），所以 reviewer **既不能改测试也不能改实现**——它能做的只有「报告」。同一个确定性缺陷，重试 N 次得到 N 次同样的诚实结论。

**为什么 FIX 路径没接住**：引擎里**有** FIX 机制（`WorkflowEngine` 会派生 `FIX-DEBUG-n` / `FIX-REPLAN-n`，`workflowTaskExecutor.ts:377` 从 `outcome.metadata.fixTaskType` 取值）。但 **`fixTaskType` 来自 agent 输出**，`T-S4-R2` 的 `metadata` 是空的 ⇒ 没有 FIX 任务。**全库 `FIX-*` = 0 条**说明这条路**在生产上从来没有走通过**。

**H-11（待探针证实的假设）**：REVIEW 的**负向结论**（「我审查了，切片不合格，理由是 X」）与**任务失败**（「我没能完成任务」）在平台里**是同一条路径**，于是「诚实的拒绝」被当成「执行失败」处理，而唯一能消费这个信息的机制（FIX 任务）依赖 agent 主动填 `fixTaskType`——**它没填，机制也没兜底**。

**为什么这是平台侧**：agent 的产出**是合格的**（结构化的 AC 覆盖矩阵 + 9 个 artifact + 明确的阻断项与建议）。不合格的是**平台对「负结论」的处理**。

### 2.4 已排除的候选

| 候选 | 排除依据 |
| --- | --- |
| 「TEST 任务的红灯门本身就不可满足」（agent 在 `T10` 输出里的自述） | **部分不成立**：`:708` 明确允许「命令成功 + 作用域 AC 全绿 + 实现证据齐备」直接判过。run 2 的同一个 `T10` 就过了。⇒ 不可满足的是**无锚点时的作用域**，不是红灯门本身 |
| 「agent 没跑测试 / 跑了假测试」 | 反证：run 1 的 `T10` 自报 `pnpm test` exit 0、50/50 全绿，并做了 25 条 `[AC-04]` 命名审计。**产出合格** |
| 「`T-S4-R2` 是解析失败（`INVALID_AGENT_RESULT`）」 | 反证：`outcomeMode=**tool**`、`metadata` 无 `errorType`、3 个 agent run 全 `succeeded`。`INVALID_AGENT_RESULT` 在本批属于**另一个任务** `T-S4-R1`（且它自愈了） |
| 「REVIEW 任务整体过不去」 | 反证：本批 **7 个 REVIEW 任务，只有 `T-S4-R2` 失败**；同切片的 `T-S4-R1` 也 SUCCESS |
| 「BACKEND 的 `test` 检查是墙」 | 反证：本批 2 次 `checks failed: test` 全部重试后 SUCCESS |
| 「网关 / N-6 相关」 | 反证：本批 `reasoning_content` 400 **零条**（76 个 agent run 全 succeeded） |

### 2.5 同批观察（登记，不立项）

1. **`INVALID_AGENT_RESULT` 于 `T-S4-R1`**（REVIEW，slice-4）：1 个 agent run `outcome=FAILED`、`outcomeMode=**text-fallback**`、`iterations=75`、输入 716,501 token，`summary` = 「Professional Agent returned an invalid structured result.」——即**跑了 75 轮、最终没有交出可解析的结构化结果**。该任务 `retry=1 → SUCCESS`。**已自愈，登记。**
2. **`EMPTY_FINAL_ANSWER` 1 条**（`cc10a9e4`，DESIGN 任务，`iter=7`，`outcomeMode=text-fallback`，「连续空回复，重问次数已用尽」）。L1-M4h 是 5 条。机制仍未查明。
3. **BACKEND 的 `checks failed: test`**（run 1 的 `T6` / `T5`，run 2 slice-2 一处）：**重试后全部 SUCCESS**。从「墙」降级为「可重试越过」。
4. **`T10` 的一次 `EVIDENCE_MISSING`**（03:13:58，slice-1 的 TEST）：同批另一种红灯诊断码，**未致败**。

---

## 3. 判据（18a–18h）

| 编号 | 判据 |
| --- | --- |
| **18a** | **N-10 的产生点被指认**——抓到实际数据，指出是哪一行、哪个条件把 `T10` 判成 `VACUOUS_TEST`，并**区分**两种可能：① 作用域放大（`scopedEvidenceKeys` 回退到全量 `parsedKeys`）；② `allPassed` 为假（套件里有失败测试）。**只认实测，不认推断** |
| **18b** | **探针复现 N-10**——离线、确定性、零网关配额；复现出的失败形态与生产**同形**（同判定码、同触发条件） |
| **18c** | **修复后探针转绿**，**且不放松红灯门的本意**：真正的空转测试（无实现即通过）**仍然被拦**——修复不得把 `VACUOUS_TEST` 变成一条死码 |
| **18d** | **N-11 的「无出路」被指认**——用实测说明「REVIEW 负结论 → 任务 FAILED → 重试」这条路径为什么**不可能收敛**，以及**既有 FIX 路径为什么没接住**（`fixTaskType` 缺失 / 无兜底） |
| **18e** | **N-11 的修复给出一条出路**，且该出路**复用既有机制**（FIX 路径或既有的切片级信号），**不新增第二套** Permission / Approval / Audit / 错误码（`AGENTS.md` §10） |
| **18f** | **不引入语义漂移**——不改 `DEV_TASK_TYPES` 的构成；不改 `maxIterations` / `recursionLimitFor`；不动守卫；不动 PL-M17 的 `@langchain/openai` 补丁；不改 `EvalPolicy` 与 L1-8 判据口径 |
| **18g** | **既有断言逐字不变且全绿**——`taskVerifier.test.ts` 里既有的 `VACUOUS_TEST` / `EVIDENCE_MISSING` 用例、`WorkflowEngine.test.ts` 里既有的 `fixTaskType` 用例，**一字不改**且全绿 |
| **18h** | **若查明为上游产物质量、平台无可修点 → 不阻塞**：立观察项 + 留证据，如实标注，不硬凑修复 |

**红线**（任何一条被触发即本批判负）：

- N-6（`reasoning_content` 400）、N-8（`input_tokens > 10M`）、N-9（外层 `tool_call_requested`）**均不得复发**。
- 不得为了让链走通而**弱化**红灯检查、anti-tamper、写范围审计或守卫中的任何一个。
- 不得修改历史 `tasks` / `agent_runs` / `workflow_events` 行。

---

## 4. 设计裁定（推荐）

1. **修法＝先探针定位，再定点修**——与 PL-M13 / PL-M16 / PL-M17 同形。**不先猜再改**。
2. **探针形态**：两项各一支，都要求**真实栈**（不是全 mock）：
   - **N-10**：真实 `taskVerifier` + 真实 PG（复用 `packages/database/src/testPostgresContainer.ts`）+ 构造好的 `tasks` / `agent_runs` / `workflow_events` 行，**离线、确定性、零网关配额**。必须能**分别**复现「作用域放大」与「`allPassed` 为假」两种子情形，以便 18a 的区分。
   - **N-11**：真实 `WorkflowEngine` + 假 executor（喂入一个「REVIEW 判 FAILED 且不带 `fixTaskType`」的结果），观察引擎实际做了什么。既有 `WorkflowEngine.test.ts` 已有 FIX 路径的用例骨架，可对齐。
3. **N-10 的候选修法（探针定，候选集限于）**：
   - **(a) 作用域收窄**：无锚点时不再回退到全量 `parsedKeys`，而是回退到**本任务所在切片的 AC 集**——`packages/agent-core` 已有 `selectAcceptanceCriteriaForSlice`（`validateImplementationCoverage.ts:2` 在用），**复用既有谓词，不新造定义**。
   - **(b) 诊断码纠正**：当任务**无锚点且切片范围也确定不了**时，判 **`EVIDENCE_MISSING`（不可裁决）** 而非 `VACUOUS_TEST`——「空转」是平台**支持不了**的断言，fail-closed 但诊断诚实。
   - **(c) reason 可诊断**：把**缺证据的 AC 编号**写进 reason（现在只有检查名 `"test"`）。
   - **明确不做**：不把 TEST 任务的 `expectation` 改成 `pass`（那会整体取消红灯门，属放松红线）；不强制要求规划器给每个 TEST 任务填锚点（PL-M7 / PL-M8 已证明回填做不到，且 `docs/158` §6 第 3 项裁定过「确定性层不增删任务」）。
4. **N-11 的候选修法（探针定，候选集限于）**：
   - **(a) 复用既有 FIX 路径**：让 REVIEW 的负向结论**必然**产生一个可执行的后续动作——`fixTaskType` 缺失时按既有回退规则（`WorkflowEngine.ts:57-62`）落到**被审查切片的工作类型**上，而不是落回 REVIEW 自身。
   - **(b) 把负结论升级为切片级信号**：REVIEW 判不通过 ⇒ 该切片未完成，回到该切片的重规划 / 重执行，而不是把 REVIEW 任务本身判死。
   - **明确不做**：不让 REVIEW agent 获得写权限（`DEV_TASK_TYPES` 不动）；不新增「REVIEW 特例」的第二套状态机；不把 agent 的 `outcome: FAILED` 直接当成功（那会掩盖真实失败）。
5. **修完另开一批 E1×3**（**新结果目录**，**不续跑 l1-m4i**）——修复改的是平台版本，续跑会把两个版本混进同一批次（`docs/164` §7 第 4 项、`docs/168` §7 第 7 项、`docs/170` §7 第 8 项、`docs/179` §7 第 5 项同一口径）。**l1-m4i 记「已执行 2/3、因配额中止」，其 run 3 不补跑。**
6. **§2.5 的四项只登记、另行立项**（`INVALID_AGENT_RESULT` 于 `T-S4-R1`、`EMPTY_FINAL_ANSWER`、BACKEND 的 `checks failed: test`、`EVIDENCE_MISSING`）。
7. **探针入库**（`packages/agent-core/scripts/` 或 `apps/server/scripts/`，按所属包定），并在头部注明「刻意运行，不随每次迭代跑」。
8. **「重建消息必须保留 `additional_kwargs`」的不变量化本批不做**，维持 `docs/181` §7 第 6 项的另立议题。

---

## 5. 验证分层

| 层 | 内容 |
| --- | --- |
| **第 1 层：探针定位** | N-10 一支（真实 `taskVerifier` + 真实 PG）、N-11 一支（真实 `WorkflowEngine` + 假 executor）。**离线、确定性、零网关配额** |
| **第 2 层：单测** | `apps/server/src/__tests__/taskVerifier.test.ts` 与 `packages/workflow-engine/src/WorkflowEngine.test.ts` 的邻域新增用例；**既有用例一字不改** |
| **第 3 层：回归** | `apps/server` 全量 e2e（含 `verificationGate.e2e.test.ts`）+ `workflow-engine` 全量；再跑全仓 `pnpm -r run typecheck && lint && test` |
| **第 4 层：真实批次** | 下一批 E1×3（**验收载体**，不是本批） |

**A/B 实测（强制）**：`apps/server` 的验证门相关 e2e（至少 `verificationGate.e2e.test.ts`、`taskVerifier.test.ts`）与 `workflow-engine` 的 FIX 路径用例。

---

## 6. 边界与红线

- **不改**：`packages/eval` 的夹具 / oracle / `EvalPolicy` / L1-8 判据口径；`DEV_TASK_TYPES` 的构成；`maxIterations` / `recursionLimitFor`；守卫（`packages/eval/src/usageGuard.ts`）；PL-M17 的 `@langchain/openai` 补丁；任何 `dist/`（除各包正常 `build` 产物）。
- **不新增**：包、顶层目录、第二套 Permission / Approval / Audit / Secret / 错误码。
- **不修改**历史 `tasks` / `agent_runs` / `workflow_events` 行。
- **不弱化**：红灯检查、anti-tamper、写范围审计、守卫——**四者一个都不许为了「让链走通」而放宽**。
- 跨包共享的类型 / 谓词放 `packages/shared`；**已有谓词优先复用**（`selectAcceptanceCriteriaForSlice` / `canonicalAcKey` / `isTestFilePath` 的先例）。
- 每个包改动跑 `corepack pnpm --filter @ai-se/<pkg> typecheck && lint && test`；阶段收尾前跑全仓。

---

## 7. 待裁定项（每条带推荐值）

| # | 待裁定 | 推荐值 |
| --- | --- | --- |
| 1 | 修法总原则 | **先探针定位再定点修**，不先猜再改（PL-M13 / M16 / M17 同一口径） |
| 2 | 探针形态 | **真实栈**：N-10 用真实 `taskVerifier` + 真实 PG 容器；N-11 用真实 `WorkflowEngine` + 假 executor。**两支都离线、确定性、零配额** |
| 3 | 两项是否合为一批 | **合为一批（PL-M18）**，但 **N-10 / N-11 各自独立修、独立判**——两者机制无关，一个修好不代表另一个修好。先例：`docs/162` 一次覆盖 PL-C1 / C2 / C3 |
| 4 | N-10 的修法 | **候选集限 (a) 作用域收窄到本切片 AC + (b) 无锚点且范围不可定时判 `EVIDENCE_MISSING` + (c) reason 写入缺证据的 AC 编号**；由探针在 (a)/(b) 之间定。**不做**：改 `expectation`、强制规划器填锚点 |
| 5 | N-11 的修法 | **候选集限 (a) 复用既有 FIX 路径（`fixTaskType` 缺失时落到被审查切片的工作类型）+ (b) 负结论升级为切片级信号**；由探针在两者间定。**不做**：给 REVIEW 写权限、新增第二套状态机、把 `FAILED` 当成功 |
| 6 | 若查明为上游产物质量、平台无可修点 | **不阻塞**：立观察项 + 留证据，如实标注，**不硬凑修复**（判据 18h） |
| 7 | 修完的批次安排 | **另开一批 E1×3**（新结果目录），**不续跑 l1-m4i**；**l1-m4i 记「已执行 2/3、因配额中止」，run 3 不补跑** |
| 8 | §2.5 的四项观察 | **只登记、另行立项**；本批一条都不顺手修 |

---

## 8. 本批已发生的事实（供记账，非判据）

1. **用户 2026-10-18 说「先立项那两个新致败形态」** ⇒ 本任务书成立，**里程碑 PL-M18**，缺陷编号 **N-10 / N-11**（此前最高为 N-9）。
2. **L1-M4i 批次已收尾**：脚本 `packages/eval/scripts/l1-m4i-e1-x3.sh`、停机脚本 `l1-m4i-stop.sh`，结果目录 `packages/eval/results/l1-m4i`。**记「已执行 2/3、因配额中止」**（守卫按设计挡下 run 3，退出码 2）。**本任务书不改动这条记账。**
3. **本任务书是立项动作**：**未改任何代码、未跑任何门禁、未跑任何探针**。全部事实来自库内实查与代码实查，命令与读数见 §2 各行。
4. **一处需同步更正的登记账**：L1-M4i 的账本条目里「两处致败点同属上游产物质量、不是平台控制流缺陷」这句**已被本次调查推翻**，须按 §2.1 更正为「**两处都是平台侧**」。涉及 `docs/127` §0 / §9、`docs/146` §5、`docs/17` 的 L1-8 行。

---

## 9. §7 裁定结果

**（2026-10-18，用户「**都按你的建议，开工 PL-M18**」——§7 八项全部按推荐值接受，并授权开工。）**

| # | 裁定 |
| --- | --- |
| 1 | **先探针定位再定点修**，不先猜再改 |
| 2 | **探针形态＝真实栈**：N-10 用真实 `taskVerifier` + 真实 PG 容器；N-11 用真实 `WorkflowEngine` + 假 executor。两支都**离线、确定性、零配额** |
| 3 | **合为一批 PL-M18**，但 **N-10 / N-11 各自独立修、独立判** |
| 4 | **N-10 修法候选集限 (a) 作用域收窄到本切片 AC + (b) 无锚点且范围不可定时判 `EVIDENCE_MISSING` + (c) reason 写入缺证据的 AC 编号**；由探针在 (a)/(b) 之间定。**不做**：改 `expectation`、强制规划器填锚点 |
| 5 | **N-11 修法候选集限 (a) 复用既有 FIX 路径（`fixTaskType` 缺失时落到被审查切片的工作类型）+ (b) 负结论升级为切片级信号**；由探针在两者间定。**不做**：给 REVIEW 写权限、新增第二套状态机、把 `FAILED` 当成功 |
| 6 | 若查明为上游产物质量、平台无可修点 → **不阻塞**，立观察项 + 留证据，**不硬凑修复** |
| 7 | **修完另开一批 E1×3**（新结果目录），**不续跑 l1-m4i**；**l1-m4i 记「已执行 2/3、因配额中止」，run 3 不补跑** |
| 8 | §2.5 的四项观察 **只登记、另行立项**，本批一条都不顺手修 |

**红线（裁定同时确认）**：N-6 / N-8 / N-9 **均不得复发**；不改 `DEV_TASK_TYPES` / `maxIterations` / `recursionLimitFor` / 守卫 / PL-M17 补丁；**不弱化**红灯检查、anti-tamper、写范围审计、守卫中的任何一个；不修改历史 `tasks` / `agent_runs` / `workflow_events` 行。

**性质**：本裁定是**开工授权**。实施记录另立 `docs/184`。

**后续裁定链（同日，逐次）**：

| 次序 | 用户裁定 | 触发 |
| --- | --- | --- |
| ① | 「先立项那两个新致败形态」 | 立案 |
| ② | 「都按你的建议，开工 PL-M18」 | §7 八项全部按推荐值接受 |
| ③ | 「**按 1 走**」 | 选 §10.2 出路 1：解冻 `EvalPolicy` |
| ④ | 「**按 1a 走**」 | 实施前核实发现「只开 `allowReplan`」**不生效**（`failureRouter` 生产未接线 ⇒ `strategy` 取自 `failureStrategy`），需**两个字段**同时改 |
| ⑤ | 「**按 M1 走**」 | 探针实测发现 REPLAN 会**再造一个 REVIEW**（`replan()` 的 retry 继承源任务类型），故除策略外还需**代码修复**；机制形态选 M1（按工作类型解析，覆盖所有非工作类型源） |

**⇒ 全部裁定已落，实施见 `docs/184`。**

---

## 10. 实施期发现（2026-10-18，探针定位阶段）

### 10.1 N-10：根因已由探针钉死（判据 18a / 18b 达成，18c 预验证通过）

新增探针 `apps/server/scripts/probe-n10-redlight-scope.ts`（真实 `TaskVerifier` + 真实 dev 库 + 真实 `findRuntimeTasksByRequirementId`；沙箱输出由**该任务自己记录的** `output.verification.acResults` 重建，非臆造）。对 L1-M4i run 1 的 `T10`（工作流 `a0434bc9`）实测：

| 变体 | 结果 |
| --- | --- |
| **V0 生产形状**（无 `acKeys`） | `failed` / **`VACUOUS_TEST`**，`acSummary={total:5, passed:5, failed:0}` —— **与生产读数逐字相同** |
| **V1 候选 (a)**：作用域收窄到本切片 AC | **`verified` / `expected=pass` / `passed=true`** —— **翻转** |
| **V2 反向对照**：同样的收窄 + 空证据面 | `failed` / `VACUOUS_TEST` —— **红灯门没有被放松** |
| **V3** 候选 (b) 观察：声明了但为空的 `acKeys` | 仍 `VACUOUS_TEST`（`:217` 的空数组回退生效） |

**逐键归因（`acChecked=5`，全部 passed ⇒ 判失败不是 `allPassed` 造成的）**：

| 键 | 覆盖它的证据任务 | 是否曾被本需求任何任务声明 |
| --- | --- | --- |
| `AC-04` | 有 | 是 |
| `AC-29` | 有 | 是 |
| `AC-30` | 有 | 是 |
| **`FR-06`** | **（无）** | **否** |
| `TR-03` | 有（T9/T5/T6/T7 的 `acResults`） | 否 |

⇒ **唯一的阻塞键是 `FR-06`。** 它是 `BRACKETED_MARKER_PATTERN`（`/\[([A-Za-z]{2,})-(\d+)\]/g`）从测试标题里抽出来的 **FR 编号**，而**本需求没有任何任务声明过它**，`taskCoversAc` 也匹配不到实测记录 ⇒ `acKeys.every(...)` 恒为假 ⇒ **`VACUOUS_TEST` 恒成立，与 agent 产出无关**。

**附带的结构性矛盾（本批不单独立项，随 N-10 一并说明）**：仓库自己的 **AC-30 契约测试要求每条测试标题都带 `FR-x.y/AC-xx` 编号**，而 `parseAcResults` 又把 `FR-nn` 当成 AC 键去要实现证据——**两条规则互相打架**。

### 10.2 N-11：**CONTRACT CONFLICT（停下来报告，未擅自绕开）**

机制已在代码层确认（判据 18d 的**代码证据**，**尚未取得探针实测**）：

- `apps/server/src/services/workflowTaskExecutor.ts:391`——`result.status === "succeeded" && outcome.status !== "SUCCESS"` ⇒ **任务判 `failed`**。即 **REVIEW agent 诚实的负结论被记成「任务失败」**。
- `packages/workflow-engine/src/WorkflowEngine.ts:844-854`——失败任务的出路**只有四条**：`ROLLBACK`（限 DEPLOY）、**`REPLAN && workflow.policy.allowReplan`**、`CONTINUE`、否则 `failWorkflow("WORKFLOW_TASK_FAILED")`。RETRY 分支在其上方。
- `packages/eval/src/cli.ts:17-20`——批次策略是 **`failureStrategy: "RETRY"`、`allowRetry: true`、`maxRetries: 1/2`、`allowReplan: false`**。

⇒ **`allowReplan: false` 使 REPLAN 分支不可达**，而 FIX 任务（`FIX-DEBUG-n` / `FIX-REPLAN-n`）**只在 `replan()` 内部创建**。这解释了 **全库 `FIX-*` = 0 条**。REVIEW 的负结论因此只有「重试到耗尽 → 工作流失败」一条路，**不可能收敛**。

**冲突点**：裁定 5 授权两个候选修法——**(a) 复用既有 FIX 路径**、**(b) 负结论升级为切片级信号**。但在本引擎里 **(a) 与 (b) 都落在同一道闸门 `allowReplan` 上**；而 §6 / 裁定同时**冻结 `EvalPolicy`**、并禁止新增第二套机制（`AGENTS.md` §10）。⇒ **授权候选集在冻结条件下为空**，本项**无法按原裁定开工**。

**三个可选出路（需再裁定）**：

| # | 出路 | 代价 |
| --- | --- | --- |
| **1（推荐）** | **解冻 `EvalPolicy` 的 `allowReplan`（仅此一项，设为 `true`）**，复用既有 FIX 路径 | L1-8 场景与既往 **18 次 E1 run 不再严格可比**（须如实登记）；且 `replan` 是否真能消费 REVIEW 的 `fixSteps` 仍需探针证明 |
| 2 | **维持冻结，N-11 判「本批不可修」**——立观察项 + 留证据（判据 **18h** 的路径），N-10 单独修完先跑下一批 | L1-8 的下一次尝试仍会被同一处拦住 |
| 3 | 新增机制 | **§6 / `AGENTS.md` §10 禁止**，不推荐 |

**当前状态（已被 §10.4 / §10.5 取代，保留以记录当时的判断）**：N-11 当时**未开工**；其探针的形态取决于本表的裁定（因为「复现无出路」与「复现 FIX 路径可用」需要不同的探针设置）。**⇒ 实际走向：裁定「按 1 走」→ 核实后「按 1a 走」→ §10.4 探针发现 REPLAN 会再造 REVIEW → 裁定「按 M1 走」→ §10.5 收官。**

### 10.3 实施进度（2026-10-18）

**用户裁定「按 1 走」**（解冻 `EvalPolicy` 的 `allowReplan`）。但实施前核实发现**选项 1 的描述不完整**：

> `WorkflowEngine.ts:772` 的 `strategy = deployOverride ?? routed?.strategy ?? workflow.policy.failureStrategy`，
> 而 `routed` 来自**可选注入**的 `options.failureRouter`——**生产未接线**（全仓只有 `__tests__` 注入过；
> `apps/server/src/services/workflowService.ts:90` 透传依赖，`index.ts` 未提供）。⇒ `strategy` 就是
> `workflow.policy.failureStrategy` = **`"RETRY"`**，而 REPLAN 分支要求 `strategy === "REPLAN"`。
> **⇒ 只把 `allowReplan` 设为 `true` 进不了 REPLAN 分支；还需要 `failureStrategy: "REPLAN"`（第二个字段）。**

该第二处改动**超出「仅此一项」的授权范围**（它改变的是**每一次任务失败**的响应方式，不只 REVIEW），**故暂停 N-11，等待更正后的裁定**。

**N-10 已完成（不依赖该裁定）**：

| 项 | 结果 |
| --- | --- |
| 改动 | `apps/server/src/services/taskVerifier.ts`——`scopedEvidenceKeys` 增加**切片回退**（仅在任务确实带 `sliceKey` 时启用；`sliceDeclaredAcKeys` 收集同需求同切片的声明键）；`acImplementationEvidence` 拆为 `loadRequirementTasks` + 纯函数 `implementationEvidence`（任务集一次性载入，避免同一检查读两次库）；**新增 (c)**：`uncoveredAcKeys` 落进检查记录与 reason（`… (uncovered: FR-06)`） |
| **A/B（同一真实任务 `T10`）** | **修复前** `failed`/`VACUOUS_TEST` → **修复后** `verified`/`expected=pass`；剥掉 `sliceKey` 的修复前模拟仍 `VACUOUS_TEST`（复现证据保留）；反向对照（本切片 AC 无实现证据）**仍判 `VACUOUS_TEST`**（红灯门未被放松） |
| 探针 | `apps/server/scripts/probe-n10-redlight-scope.ts`（V0/V0p/V1/V2/V3 全部符合预期）；读数落 `packages/eval/results/n10-probe{,-after}/` |
| 单测 | `apps/server/src/__tests__/taskVerifier.test.ts` **+3 例**（翻转 / 无切片时逐字不变 + reason 点名 AC / 反向对照）；**既有 48 例一字未改** |
| 门禁 | `--filter @ai-se/server`：typecheck ✓ / lint ✓ / **test 288 用例 50 文件全绿** |
| 全仓门禁 | **未跑**（留到阶段收尾；本批只动了 `apps/server` 一处） |

### 10.4 N-11 探针实测：**1a 单独不够——REPLAN 会再造一个 REVIEW**

新增探针 `packages/workflow-engine/scripts/probe-n11-review-verdict-path.ts`（**真实 `WorkflowEngine`** + 忠实内存 store + 假 executor；executor 只让 `type === "REVIEW"` 的任务失败，其余正常完成——即生产里 `workflowTaskExecutor.ts:391` 交给引擎的形状）。读数落 `packages/eval/results/n11-probe/`。

| 变体 | 工作流 | 尝试数 | FIX 任务 | 事件 |
| --- | --- | --- | --- | --- |
| **P0** 现策略（`RETRY` + `allowReplan:false`） | **FAILED** | 3 | **0** | `…TASK_FAILED → TASK_RETRYING → TASK_READY → WORKFLOW_FAILED` |
| **P1** 裁定 1a（`REPLAN` + `allowReplan:true`） | **FAILED** | 5 | **4** | `…TASK_FAILED → REPLAN_STARTED → TASK_CREATED → REPLAN_COMPLETED → TASK_COMPLETED → WORKFLOW_FAILED` |
| **P2** 对照（REVIEW 成功） | SUCCESS | 1 | 0 | `…TASK_COMPLETED → WORKFLOW_COMPLETED` |

**⇒ P0 证实「无出路」（判据 18d 达成）。但 P1 也没出路**：REPLAN 分支确实被激活、确实造了 FIX 任务，然后**仍然 FAILED**。P1 的任务键暴露了原因：

```
T-S4-R2:SUCCESS  T-S4-R2-DEBUG-1:SUCCESS  T-S4-R2-REPLAN-1:SUCCESS
T-S4-R2-REPLAN-1-DEBUG-2:SUCCESS  T-S4-R2-REPLAN-1-REPLAN-2:FAILED   <- 逐层嵌套，仍 REVIEW
```

**机制**（`WorkflowEngine.ts:930-965`，`replan()`）：

- `:936` DEBUG 任务 `type: "DEBUG"`、`input.targetTaskType = debugTargetType(source).type`；
  而 `debugTargetType` 的**最终兜底是 `source.type`**（`:67`）⇒ REVIEW 的 DEBUG 任务**目标类型是 REVIEW**。
- `:959` **retry 任务 `type: source.type`** ⇒ **REVIEW 的 replan 就是一个新的 REVIEW**，必然得出同一个诚实负结论 ⇒ 再 replan ⇒ 撞深度守卫 ⇒ FAILED。

**⇒ N-11 需要两部分，缺一不可**：

1. **策略**（已授权为 1a）：`failureStrategy: "REPLAN"` + `allowReplan: true`——让 REPLAN 分支可达；
2. **代码**（裁定 5(a) 的后半句**恰好授权了这个方向**：「`fixTaskType` 缺失时……落到**被审查切片的工作类型**上，而**不是落回 REVIEW 自身**」）：让修复任务落到**工作类型**，而不是继承源任务类型。

**两者必须一起落**：只落 1 会**只增成本不增出路**（多的那两个 REVIEW + 两个 DEBUG 全是白跑），故**暂不落 1**。

**待裁定（机制形态，最后一处）**：

| # | 机制 | 范围 |
| --- | --- | --- |
| **M1（推荐）** | 源任务类型**不是工作类型**（BACKEND / FRONTEND / DATABASE）时，DEBUG 的 `targetTaskType` **与** retry 任务的 `type` 一律解析为「**源任务所在切片的工作类型**」（同工作流、同 `sliceKey` 的任务里最常见的开发类类型；切片内没有则回退 `BACKEND`） | 覆盖**所有**非工作类型源（DESIGN / TEST / REVIEW / BUILD …）——语义上「修复任务必须是可执行的工作」，正是 FIX 路径本来的目的 |
| M2（保守） | 同上，但**只在 `source.type === "REVIEW"` 时生效** | 爆炸半径最小；但把 REVIEW 做成特例，与「不做 REVIEW 特例」的口径有张力 |

### 10.5 收官（2026-10-18）

**用户裁定「按 M1 走」后全部落定。** N-10 与 N-11 **均已实施**，实施记录 **`docs/184`**。

| 项 | 结果 |
| --- | --- |
| N-10 | `apps/server/src/services/taskVerifier.ts`：`scopedEvidenceKeys` 切片回退 + `uncoveredAcKeys` 诊断；**+3 单测**；探针 A/B 由 `VACUOUS_TEST` 翻为 `verified`，反向对照仍拦住 |
| N-11 | **策略**（`packages/eval` 的 `L1_POLICY_OVERRIDE` 与 `packages/shared` 的 `L1_WORKFLOW_POLICY` **同步**：`REPLAN` + `allowReplan: true`）+ **代码**（`WorkflowEngine` 新增 `fixWorkTargetType`，`debugTargetType` 末道兜底与 retry 任务 `type` 改用工作类型）；**+3 单测**；探针由 `FAILED`/5 尝试/4 FIX 任务（嵌套）变为 **`SUCCESS`/3 尝试/2 FIX 任务** |
| 新增共享谓词 | `@ai-se/shared` 的 `WORK_TASK_TYPES` + `isWorkTaskType`（避免第三份「工作类型」定义） |
| 门禁 | 四个包各自 `typecheck && lint && test` 全绿；全仓 `typecheck` / `lint` **exit 0**；全仓 `test` 见 `docs/184` |
| 判据 | **18a–18g 达成、18h 不适用** |
| 未达成 | **未在真实批次验证**（N-11 探针用假 executor）；**口径变化须登记**（L1 失败响应「重试」→「重规划」，与既往 18 次 run 不再严格可比） |

