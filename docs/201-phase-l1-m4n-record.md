# 201 · L1-M4n 批次记录（E1×3，第十四次 L1-8 尝试）

> 批次：`packages/eval/scripts/l1-m4n-e1-x3.sh`，2026-10-20 15:22 → 2026-10-21 00:30 CST。
> 承载六项从未在真实批次行使过的修复：**N-18 / N-19 / PL-M24 (1) / N-20 / N-15′ / N-21**。
> 结果目录：`packages/eval/results/l1-m4n/`（run-1 / run-2 / run-3）。
> **L1-8 未达成**（staging 段 **0/3**）。但本批产出了**整个 L1-M4x 系列的第一次 oracle 通过**。

---

## 0. 一屏结论

| run | 到达切片 | oracle | 链完成 | 假阴性 | staging 段（CI / DEPLOY / VERIFY） | 任务 | 耗时 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | slice-3 | 不通过 | 否 | 否 | 未尝试（—/—/—） | 27 SUCCESS / 4 FAILED / 7 PENDING | 2h01m |
| 2 | slice-4 | 不通过 | 否 | 否 | `FAILED` / PENDING / PENDING | 40 SUCCESS / 4 FAILED / 4 PENDING | 2h09m |
| **3** | slice-4 | **通过** | 否 | **是** | `FAILED` / `FAILED` / `FAILED` | 46 SUCCESS / 5 FAILED / 1 WAITING_APPROVAL | 1h43m |

**三项单调推进**：成功任务 **27 → 40 → 46**；oracle **否 → 否 → 是**；交付任务从「未尝试」到「三个都真跑过」。

**六项修复全部确认**（§5）。**两个新缺陷**（N-22 / N-23，任务书 `docs/199` / `docs/200`）。
**staging 段 0/3** ⇒ **L1-8 未达成**。

### 0.1 头条：L1-M4x 系列的第一次 oracle 通过

`run-3.json` 的 `oraclePassed: true`、`falseNegative: true`。

全系列普查（`grep -l '"oraclePassed": true'`，逐目录计数）：

| 目录 | oracle 通过 / 总数 |
| --- | --- |
| `l1-m4` … `l1-m4m`（13 个目录） | **0 / 31** |
| **`l1-m4n`（本批）** | **1 / 3** ← 即 run 3 |

（`g/l4` 系列有 1 次通过，即 `docs/198` §4 记的 `57f98bf9`，10-14。**不在 L1-M4x 系列内**。）

⇒ **本批第一次出现「平台判失败、而交付物满足 E1 验收标准」**。
**含义**：L1-8 的瓶颈已从「链造不出合格产品」收窄到「**交付编排跑不通**」。
**⚠️ 这不等于 L1-8 达标**——L1-8 的判据是 staging 段（CI ∧ staging DEPLOY ∧ staging VERIFY），
本批 0/3。**假阴性不是达标信号，是「产品侧已就绪」的信号**（记忆 [[acceptance-under-claim]]）。

---

## 1. Modified Files

**本批零 `src/` 改动、零依赖改动、零测试改动**（批次只跑评测）。

| 文件 | 动作 |
| --- | --- |
| `packages/eval/results/l1-m4n/run-{1,2,3}.json` / `-summary.md` | **新增**（评测产物） |
| `docs/199-phase-n22-replan-routing-taskbook.md` | **新增**（N-22 任务书） |
| `docs/200-phase-n23-delivery-contract-replan-taskbook.md` | **新增**（N-23 任务书） |
| `docs/201-phase-l1-m4n-record.md` | **新增**（本文件） |
| `docs/146-global-completion-status.md` | 六项修复状态格回填；N-22 / N-23 / 两条记账缺口登记；「replan 不收敛」行改记复核结论 |
| `docs/17-acceptance-checklist.md` / `docs/15` / `docs/18` | 进度更新（§10） |

---

## 2. Implementation

**无。** 本批是评测执行与结果记账，不是实施。

---

## 3. Architecture Changes

**无。**

---

## 4. Dependencies

**无新增、无升级、无删除。**

---

## 5. 六项修复的逐项判定

判定口径：**先按批次脚本的 watch item 查库**，不采信 summary（记忆 [[batch-attribution-needs-db-verification]]）。

| # | 修复 | 判据 | 本批读数（库内） | 判定 |
| --- | --- | --- | --- | --- |
| 1 | **N-18**（PL-M22，`scripts/` 可写 + 审计侧派生） | `scripts/` 的写拒绝归零 | L1-M4m 的 `scripts/selfcheck.mjs ×7` 等**全部消失**；本批 `scripts/` **零拒绝** | ✅ **确认** |
| 2 | **N-19**（PL-M23，拒绝结构化） | `tool_calls.input.denied` + `WriteScopeAudit.deniedAttempts` | `denied='write'` 结构化写入；**112/112** 带 `writeScope` 的任务都有 `deniedAttempts` | ✅ **确认** |
| 3 | **PL-M24 (1)**（N-13 有界失败） | 无「沙箱杀死」形状（`exitCode` null / 无 TAP） | 全部 6 处失败的 `test` 检查：**`exitCode=1`、TAP 存活、命令带 `--test-timeout=20000`**；`CHECK_TIMEOUT` 零次 | ✅ **确认**（**未被压到边界**，见 §9 第 3 条） |
| 4 | **N-20**（计数不双计） | summary `errorTypes` = 任务级 | run 1：**4 = 4**；run 2：**1 = 1**；run 3：**1 = 1** | ✅ **确认** |
| 5 | **N-15′**（DEBUG 取 `targetTaskType` 的检查） | 旧 reason 归零 | `no available checks for task type DEBUG` **= 0**；8 个 DEBUG 任务**全部** `has_checks = t`（除当时未终结的） | ✅ **确认** |
| 6 | **N-21**（墙钟 600s → 900s） | 无 600s 死亡 + 正控 | 本批 `TIMEOUT_ERROR = 0`、`reached max iterations = 0`；**正控：`TASK-08-REPLAN-1`（BACKEND）SUCCESS @ 773s** | ✅ **确认** |

**第 6 项的正控是本批最干净的一条**：773s 的成功 run 在旧 600s 默认值下会被截断——
正是 `docs/197` §11「600s 会把本来做得完的任务截断成超时」那句论断的实测复现。

### 5.1 「必须缺席」家族（全部缺席）

| 项 | 读数 |
| --- | --- |
| N-6 `reasoning_content` | 0 |
| N-7 `Recursion limit of 25` | 0 |
| N-8 `input_tokens > 10M` | 0 |
| N-9 `tool_call_requested` | 0 |
| N-10 `VACUOUS_TEST` / `EVIDENCE_MISSING` | 0 / 0 |
| `EMPTY_FINAL_ANSWER` | 0 |
| N-12 `unresolved`（PL-M19） | 0（**仍未在真实批次被行使**） |
| `scopeViolations`（PL-M12） | 112 行**全空** ✅ |

---

## 6. Tests / 7. Lint / 8. Typecheck

**不适用**（零 `src/` 改动，未跑门禁）。

## 9. E2E

**即本批本身**：三次真实 E1 全链运行，真实 LLM、真实工具调用、真实沙箱、真实 Docker 宿主机。

---

## 10. Known Issues

### 10.1 两个新缺陷（已登记 + 任务书）

**N-22**（`docs/199`）——`REPLAN` 是 `SubmitResultSchema` 里声明过的一等结果（`outcomeSchema.ts:43`），
但**根上没有 `fixTaskType`**、提示词**不给任何语义**（`ProfessionalAgent.ts:47`）、
**只有 qa-agent** 被要求填（`AgentRegistry.ts:186`）⇒ `debugTargetType` 第 1 步**结构性不可达**。

> **实测（run 2）**：`T7` 因过期断言失败；`T7-REPLAN-1`（backend-agent）报 `outcome=REPLAN`，
> `recommendations` **原文**要求「**Route a TEST-type task** to correct `src/bearer-auth-middleware.test.js`
> line 333 … then retry this CI task」——平台给了它**又一个 BACKEND**。
> 该失败**无 `errorType`、无 `verification` 记录**。

**N-23**（`docs/200`）——**run 3 的实际致败点，PL-M18 的溢出**。
`WORK_TASK_TYPES` 只有 `["BACKEND","FRONTEND","DATABASE"]`（`packages/shared/src/index.ts:519`），
BUILD/DEPLOY/TEST 都不在其中 ⇒ `debugTargetType` 第 3 步把**交付任务**的类型换成工作类型，
而 `DeliveryOrchestrator.canHandle` 按 **`task.type`** 分派（`deploymentOrchestrator.ts:76-84`）
⇒ **`input.delivery` 契约悄悄作废**。

> **实测（run 3）**：`T7`（**BUILD**/CI，runtime `delivery-orchestrator`）→ `T7-REPLAN-1`（**BACKEND**，
> runtime `professional-deep-agent`），继承了 CI 契约却**没写下任何 `ci_runs`**，却自报 **SUCCESS**
> ⇒ `T8`（DEPLOY）在 agent 之前即失败于 `CI_RELEASE_NOT_FOUND`；
> 同形第二次：`T8-REPLAN-1`（**BACKEND** 扛 DEPLOY 契约）。
> **级联**：`T8` 失败 → `T9` REVIEW 审一次**根本没发生的部署**、正确地判 not approved → `T10` 停在
> 生产关口。**run 3 交付段的整条失败可完整追溯到本条。**

**两件必须同批修**（PL-M25），但**「一起修」不等于 run 2 那条链会收敛**——
「CI 因过期测试失败」需要一次**两步修复**，是第三个问题，已登记、**不立项**（`docs/200` §7.1）。

### 10.2 记账缺口（同族，已并入 N-22 的判据 25e）

`errorTypes` 只收**非空**的 `output.errorType`（`harness.ts:73-75`），而平台**已知**的失败码
有时只落在事件上、不落任务上：

| run | 失败任务数 | summary 报出 | 差异 |
| --- | --- | --- | --- |
| 1 | 4 | 4 | 0 |
| 2 | 4 | 1 | **3 不可见** |
| 3 | 5 | 1 | **4 不可见** |

run 2 的 `T7` 事件带 **`CI_FAILED`**、任务 `output.errorType` **为空** ⇒ **同一个失败码有两个来源且不一致**。

### 10.3 对开批前预测的一处更正：`docs/` 的墙「出现了但没拦住」

`docs/198` §16.1 预测下一堵墙是 `docs/`（`write-scope-family-recurs` 第六例）。
本批**确实出现了**：`DESIGN-TOKEN-AUTH-CONTRACT`（type `DESIGN`）写
`docs/design/token-auth-contract.md` **被拒**（`denied='write'`）。

**但它没有成为致败点**——该 DESIGN 任务在多个 run 里是 **SUCCESS**，agent 改道把设计写在结果里了。
⇒ **预测命中了现象，没命中致败性。** 按 [[defect-registration-needs-code-proof]]，
**不登记为缺陷**（缺「成为致败点」的实例），只记此条供下次普查。

### 10.4 其余

1. **staging 段仍 0/3**——L1-M4m 的 1/3 未被超越。
2. **`verificationUnavailable` = 1（DATABASE×1）**，三个 run 各一次，**成因未查**。
3. **PL-M24 (1) 未被压到边界**：本批无 `CHECK_TIMEOUT`，所以「有界失败」的**保证**只被间接确认
   （失败检查的 TAP 都存活），**没有被逼到超时那一刻**。**弱证据，如实标注。**
4. **N-12（PL-M19）第四次未被行使**（L1-M4k/l/m/n 皆 0 条 `unresolved`）。
5. **历史任务记录不回填**（`docs/146` §6 规则 7）。
6. **run 3 的终态是 `WAITING_APPROVAL`**：与 L1-M4m 的 `716eb98d` **同一归宿**——
   E1 链到达生产关口后的正常终态，**不是回归**；harness 的 `runTimeoutMs`（2h）到期后记 TIMEOUT。
   生产审批**本批不代批**（L1 策略下生产需人工审批，批次不代人批准）。

---

## 11. Acceptance Result

**L1-8 未达成。**

判据（`docs/154` §3 M4）：E1×3 批次，staging 段交付率 **≥ 2/3**。
本批实测 **0/3**（`stagingSegment.ci = FAILED`、`deploy = FAILED`、`verify = FAILED`）。

**但本批的推进是实质的**：
- **L1-M4x 系列第一次 oracle 通过**（run 3）——产品侧已就绪；
- 交付任务**第一次真正执行**（run 3 的 `T8` 真 RUN 过，而非停在 PENDING）；
- 六项修复**全部确认**，且**没有引入回归**（「必须缺席」家族全缺席、`scopeViolations = 0`）。

**瓶颈已收窄到一处**：N-23。**修它的效果可预测且可验证**——
`T7-REPLAN-1` 保持 BUILD/CI ⇒ `runCi` 真跑 ⇒ 写下 `ci_runs` SUCCESS 行 ⇒ `T8` 不再 `CI_RELEASE_NOT_FOUND`。

---

## 12. Next Phase Boundary

**未开始事项（STOP）**：

1. **PL-M25 未开工**——`docs/199`（N-22）+ `docs/200`（N-23）**两件同批**。
   **实施前不得再开批次**（记忆 [[fix-known-defects-before-batches]]）。
2. **`docs/17` 的 12 项 V1 Real AI Validation 未勾选**（`docs/198` §14 第 1 项）。
3. **两条 token 记账缺口未修**（`docs/146` §3 已登记）。
4. **「两步修复」问题未立项**（`docs/200` §7.1）。
5. **`docs/` 写范围未立项**（§10.3，缺致败实例）。
6. **`docs/` 上仍有真开着的行**：`读侧未随写侧放行`（2026-10-17 登记，有意不做）。
7. **未做**：本批的 `docs/146` §5 数据基线更新（§1 已列出，逐项见 `docs/146`）。
