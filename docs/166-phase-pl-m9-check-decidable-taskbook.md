# 166 · N-1「检查可判定性」修复任务书（PL-M9）

> 状态：**已实施并收尾**（2026-10-16）。用户同日裁定「**都按你的建议，开工 PL-M9**」——即 §7 八项待裁定全部按推荐值接受。**实施记录 `docs/167`**——其中 §2 记录了**对本文档的 5 处更正**（9a 记录只用 `missingChecks` 一个字段、9a 事件只在 `unavailable` 时发、修复层新增「N4 × 9b 无解冲突」判定、§6 的收尾对象写错、9c 的历史影响面已量化），**判据强度以 `docs/167` 为准**。
> 编号：里程碑 **PL-M9**，三个部分 **9a（门禁侧：可见化与计数）／9b（计划期：脚本提供者守卫）／9c（门禁侧：TEST 任务不可裁决 fail-closed）**。**不新造验收编号**——修的是缺陷，不是新增能力。
> 依据：PL-M4 run 1 的**代码与库实查**（工作流 `09eca545-e8a4-471b-8f23-443a3afe06ca`，2026-10-16 16:5x 复核）、`docs/164` §2.5 N-1 / §7 第 5 项、`docs/165` Known Issues 2、`docs/127` §5 第 11 条、`docs/146` §3、`AGENTS.md` §7/§9/§10。
> 性质：任务书。**实施记录另立 `docs/167`**；本文档的方案部分在被实施记录更正前有效。

## 0. 为什么现在做这一批

1. **用户已裁定另立项**（`docs/164` §7 第 5 项：N-1「不并入本批，另立项」），`docs/165` Known Issues 2 与 `docs/146` §3 均已登记。
2. **用户的批次纪律要求先清缺陷**（记忆 `fix-known-defects-before-batches`，源自 `docs/162` §0）：下一批 E1×3 之前必须清掉所有已知缺陷，包括「已登记为长期限制」的。N-1 是**唯一**尚未处理、且会**系统性削弱整个测试先行保证**的登记缺陷。
3. **本次实查把 N-1 从「登记」推进到「机制已完全证实」，并发现两处登记表述不准确**（§2.4）。按 `AGENTS.md` §9「代码权威于文档，冲突必须报告」，须先立任务书把事实固定下来，再谈修法。

## 1. 范围

| # | 里程碑 | 条目 | 判定 |
| --- | --- | --- | --- |
| 1 | **PL-M9 / 9a** | 门禁侧：把「该类型没有客观检查」与「有客观检查但工作区缺 script」分开；后者发事件、写记录、进批次指标 | **真缺陷**（可见性） |
| 2 | **PL-M9 / 9b** | 计划期：声明式「脚本提供者」+ 守卫「消费者必须（传递）依赖提供者」+ 确定性补边 | **真缺陷**（计划侧，根治） |
| 3 | **PL-M9 / 9c** | 门禁侧：TEST 任务的 `test` 检查**不可裁决**时不得静默通过，按本仓库既有的 fail-closed 教义判 `EVIDENCE_MISSING` | **真缺陷**（门禁强度） |

**明确排除**（本批不动）：

| # | 条目 | 排除理由 |
| --- | --- | --- |
| 4 | DATABASE 任务类型错配（run 1 的 T-06：项目无迁移脚本，却被派为 DATABASE 类型 → 检查永远不可用） | 真问题，但属「任务类型适用性判定」，与本批不同源（§2.5 登记） |
| 5 | 「红灯在『被测对象不存在』时也会亮」这一判据缺口 | run 1 **未证实**（T-11 的红灯是真红灯）；收紧会误伤正当的 TDD 红测试（§2.5 登记） |
| 6 | 执行期/调度期「可判定性就绪门」（§4 方案 D） | 语义最正但需改 `packages/workflow-engine` 的就绪判定（全平台影响面），且就绪探测要在调度点跑命令（昂贵、有竞态）→ 记为长期方案 |
| 7 | `docs/164` §1 排除的 N-2（仓库根写权限）、`docs/162` §1 的第 4/5/6 项 | 维持原裁定 |

## 2. 基线事实（PL-M4 run 1，2026-10-16 代码与库实查）

### 2.1 缺陷的精确机制（三段，互相咬合）

**① 计划期：计划可以合法地把「创建 `package.json` 与其 scripts 的任务」排在「需要该 script 的 TEST 任务」之后，甚至让前者依赖后者。**

run 1 的 slice-1 依赖边（库：`task_dependencies`）：

```
T-01 → T-02, T-03, T-04      (DESIGN → 三个 TEST)
T-04 → T-05                  (TEST「脚手架契约测试」 → BACKEND「搭建 pnpm 工程脚手架」)   ← 倒置
T-02 → T-07                  (TEST → BACKEND，N4 要求的边，二者共享 AC-04)
T-05 → T-09, T-10
T-06 → T-11, T-08, T-09
```

T-05 的描述原文是「创建 `package.json`（dependencies 为空，engines.node 为 22），定义 start/test/lint/typecheck/build 脚本……」，T-04 的描述是「断言 `package.json` 的 dependencies 为空、scripts 包含 start/test/lint/typecheck/build……并执行 `pnpm lint/typecheck/build` 断言退出码 0」。

**即：T-04 测的正是 T-05 造的东西，而 T-05 被排在 T-04 之后。** DAG 无环、`validateTaskGraph` 全过、`validateTestFirstOrder` 全过。

**为什么既有校验器都无感**：

| 校验器 | 位置 | 为什么无感 |
| --- | --- | --- |
| N4 测试先行顺序 | `validateTestFirstPlan.ts:77-93` | 只在「实现任务与测试任务**共享 AC**」时才要求补边（`acKeys.size === 0 → continue`）。T-05 **一条 acKeys 都没声明** → 整个 T-05 被跳过。**N4 并不要求「TEST 任务排在实现任务之前」**（见 §2.4 更正 1） |
| PL-M1 实现覆盖 | `validateImplementationCoverage.ts:18-40` | 只管「范围内 Must AC 有无实现任务引用」，与顺序无关 |
| 任务图结构校验 | `validateTaskGraph.ts:119-220` | 只管重号/缺边/自环/环；T-04→T-05 完全合法 |

**没有任何守卫表达「检查的可判定性」这一语义。** 计划期根本不知道「T-04 的检查需要 `package.json` 里有一个 `test` script」——`CHECK_CANDIDATES`（`apps/server/src/services/taskVerifierRules.ts:49-54`）住在 `apps/server`，规划器看不见。

**② 验证期：检查计划为空被当成「本类型没有客观检查」，于是静默通过。**

`TaskVerifier.verify` 先探工作区、再算检查计划（`taskVerifier.ts:321-324`）：

```
facts = await probePackageFacts(...)        // 读 package.json 的 scripts
plan  = planVerificationChecks(task.type, facts.scripts)
```

`planVerificationChecks`（`taskVerifierRules.ts:63-104`）对 TEST 的候选是 `["test"]`，**只有当 `scripts.test` 是字符串时**才产出 `{name:"test", expectation:"fail"}`。脚本不存在 → 返回 `[]` → 落到 `taskVerifier.ts:423-425`：

```
} else if (plan.length === 0) {
  verdict = "unavailable";
  reason = `no available checks for task type ${task.type}`;
```

而 `unavailable` 在 `enforce` 下**不判失败**——`verifyingTaskExecutor.ts:77` 只在 `verdict === "failed"` 时覆盖自报：

```
if (mode === "enforce" && record.verdict === "failed") { ... }
return { ...result, output };   // unavailable → 原样返回 succeeded
```

**「该类型没有客观检查」（DESIGN/REVIEW/ANALYSIS）与「有客观检查但工作区缺 script」（TEST/BACKEND/FRONTEND/BUILD/DATABASE）是两件完全不同的事，平台把它们记成了同一件事。**

**③ 度量期：`unavailable` 在批次报告里完全不出现。**

`collectVerificationMetrics`（`packages/eval/src/harness.ts:151-176`）只统计 `verification.verdict === "failed"`；`unavailable` 不进任何计数。run 1 的报告因此显示 `验证门失败码：（无）`——**红灯检查整片缺席这件事，在批次层面是不可见的**。

### 2.2 库实测：run 1 的 12 个任务（按真实执行时序）

| # | task | 类型 | 标题 | 执行时段（UTC） | verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | T-01 | DESIGN | 设计模块接口与目录结构 | 07:23:40–07:24:42 | `unavailable`（类型无候选检查，正常） |
| 2 | **T-02** | **TEST** | 编写 AC-04 测试：密码哈希不落盘明文 | 07:24:42–07:26:32 | **`unavailable`** |
| 3 | **T-03** | **TEST** | 编写 DATA_DIR 持久化测试（FR-7-1） | 07:26:32–07:27:36 | **`unavailable`** |
| 4 | **T-04** | **TEST** | 编写工程脚手架契约测试（FR-9-1） | 07:27:36–07:28:28 | **`unavailable`** |
| 5 | T-05 | BACKEND | **搭建 pnpm 工程脚手架**（创建 `package.json` 与 scripts） | 07:28:28–07:34:34 | `verified` |
| 6 | T-07 | BACKEND | 实现密码哈希模块 | 07:34:34–07:36:31 | `verified` |
| 7 | T-06 | DATABASE | 实现 DATA_DIR 配置解析与 JSON 文件存储层 | 07:36:31–07:38:21 | `unavailable`（§2.5） |
| 8 | T-08 | BACKEND | 实现用户凭证持久化 | 07:38:21–07:43:18 | `verified` |
| 9 | T-09 | BACKEND | 实现服务入口 src/index.js | 07:43:18–07:46:21 | `verified` |
| 10 | T-11 | TEST | 集成测试：重启后数据保留 | 07:46:21–07:49:22 | **`verified`**（脚本已存在 → 红灯检查真的跑了） |
| 11 | T-10 | BACKEND | 编写 README | 07:49:22–07:54:02 | **`failed`**（PL-M8 修的缺陷） |
| 12 | T-12 | REVIEW | 代码审查与验收确认 | — | （未执行） |

T-02/T-03/T-04 的 `TASK_VERIFICATION` 载荷（原文）：

```json
{"mode":"enforce","checks":[],"verdict":"unavailable",
 "reason":"no available checks for task type TEST","taskType":"TEST",
 "acChecked":0,"acFailed":0}   // 节选（原载荷另含 commitSha / durationMs / writeScope）
```

注意 `mode` 是 **`enforce`**——门禁确实开着，仍然放行。

**T-11 是反证**：它排在 T-05 之后，`test` script 已存在 → 红灯检查真的跑了。所以本缺陷不是「TEST 类型永远不可用」，而是**纯粹的顺序依赖**。

**严重度校准（如实）**：slice-1 的红灯**流程**整片缺席；但 AC-04 的绿灯**结果**被 T-07/T-08 的 BACKEND 全量套件检查（当时套件是绿的）顺带观察到了。另外，切片边界绿灯检查（`maybeSliceBoundaryCheck`，`taskVerifier.ts:888-955`）在 run 1 **一次都没触发**——它要求同切片其余任务全部 SUCCESS（`:913`）且 `test` script 存在（`:899-900`），而 T-10 最终 FAILED。**即：slice-1 在流程层没有任何一处证明过「红灯曾经亮过」。**

### 2.3 全库量级（dev 库全量统计，非仅 run 1）

| 任务类型 | `unavailable` 次数 | 成因 |
| --- | --- | --- |
| DESIGN | 97 | 类型无候选检查（**正常**） |
| REVIEW | 97 | 同上 |
| ANALYSIS | 82 | 同上 |
| **TEST** | **25** | **本缺陷**（分布在 10-06 / 10-07 / 10-13 / 10-14 / 10-16 五天） |
| **BACKEND** | **14** | 同类（`build`/`test` script 缺失时） |
| **DATABASE** | **14** | 同类 + 类型错配（§2.5） |

**276 次 DESIGN/REVIEW/ANALYSIS 是正确语义**（这几类本就没有客观检查）；**53 次 TEST/BACKEND/DATABASE 是本缺陷**。缺陷是**跨批次反复发生**的，不是 run 1 的偶发。

### 2.4 对既有文档的两处更正（据实查）

**更正 1（重要）：`docs/127` §5 第 11 条与 `docs/164` §2.5 N-1 的归因不准确。**

两处都写「**TDD 顺序要求 TEST 任务排在实现任务之前**——计划顺序与检查可用性相互矛盾」。实查（`validateTestFirstPlan.ts:77-93`）表明：**N4 并不要求 TEST 任务排在实现任务之前**；它只在「实现任务与 TEST 任务**共享 AC**」时要求补一条「实现 → 测试」边。run 1 的倒置边 `T-04 → T-05` 是**规划器自己写的**（它的 TDD 直觉：先写测试，再搭工程），不是任何校验器强制的。

准确表述：**规划器可以把「创建 manifest 的任务」排在「需要该 manifest 的 TEST 任务」之后；N4 只按 AC 共享关系补边，而脚手架任务没有 acKeys，因此对它完全无感；平台在计划期没有任何手段表达「检查的可判定性」。**

**更正 2：`docs/164` §2.5 称「成因（空转通过的具体机制）未完全证实，只作登记，不作为结论」。** 现已完全证实：`plan = []` → `taskVerifier.ts:423-425` → `verdict = "unavailable"` → `verifyingTaskExecutor.ts:77` 只覆盖 `failed` → 任务保持 `succeeded`（§2.1 ②）。**该保留意见可以撤销。**

两处按 `docs/146` §6 规则 7 处理：`docs/127`（活文档）就地更正；`docs/126` 类历史记录只追加勘误块。

### 2.5 伴生发现（登记，本批范围外）

- **N-1b｜DATABASE 类型错配。** run 1 的 T-06 标题「实现 DATA_DIR 配置解析与 JSON 文件存储层」被派为 `DATABASE`，而 `CHECK_CANDIDATES.DATABASE` 要求 `db:migrate:up` 与 `db:migrate:down` **成对声明**（`taskVerifierRules.ts:68-78`）。E1 夹具的 build contract 里没有迁移脚本 → 该检查**永远**不可用。这是「任务类型选择」问题，不是顺序问题。
- **N-1c｜红灯判据的语义缺口（未证实）。** `resolveCheckOutcome`（`taskVerifier.ts:657-660`）把「命令非零退出」一律当作「红灯已亮」。当**被测对象根本不存在**（而非「尚未实现」）时，红灯同样会亮，二者不可区分。run 1 **未**证实此缺口（T-11 的红灯是真红灯：业务路由确实属于后续切片）。**只作登记，不作为结论**——收紧它会误伤正当的 TDD 红测试。
- **N-1d｜本仓库自身的 fail-closed 教义与 `unavailable` 冲突。** `taskVerifier.ts:661-664` 的注释明写「不可裁决一律 fail-closed 标 `EVIDENCE_MISSING`」，`:626` 亦写「证据不全……时保守保持红灯（fail-closed）」。而「TEST 任务的检查不可裁决」走的却是**非失败**的 `unavailable`——**与代码自己声明的教义相矛盾**。这是 9c 的立项理由。

## 3. 各部分的判据

### 9a 门禁侧：可见化与计数

| 判据 | 期望 |
| --- | --- |
| 把「类型无候选检查」与「有候选但 script 缺失」**分开** | 新增。前者维持 `unavailable`（今日语义，逐字不变）；后者是**证据面缺失** |
| 后者发专门事件 `TASK_CHECK_UNAVAILABLE`，payload 只含 `taskKey/taskType/missing/sliceKey`，**不含 `errorCode`** | 新增（避免被 `collectFailureLayers` 误计——同 PL-M7 7b 的处置） |
| 后者写入验证记录（新增字段，如 `unavailableReason: "scripts-missing"` + `missingChecks: [...]`） | 新增 |
| **`verdict` 与 `verified` 逐字不变**（9a 不改判定） | 保持 |
| 批次指标新增 `verificationUnavailable`（按任务类型分列）并进报告 | 新增 |
| 既有调用方（`planVerificationChecks` 的返回形状）行为逐字不变 | 保持（只增伴生信息） |

### 9b 计划期：脚本提供者守卫

| 判据 | 期望 |
| --- | --- |
| `TaskPlanItemSchema` 新增**可选**字段 `providesScripts?: string[]`（声明本任务在工作区创建的 npm script 名） | 新增（`.strict()` 下必须显式声明） |
| 提示词 `task-planning.prompt.ts` 增加一条：项目骨架任务必须声明它创建的 script，并**先于**需要这些 script 的任务 | 新增（软硬双保险的软侧） |
| 守卫：切片内存在声明了 `test` 的提供者 P 时，**每个 TEST 任务必须（传递）依赖 P**；否则报错，错误信息**列出提供者与缺失的边** | 新增。这是 PL-M7 裁定 2 的同一条思路——**只要求 TEST 任务**，不外扩到 BACKEND/FRONTEND（避免误伤与修复轮负担） |
| `autoFixTaskPlan` 规则 3：补「TEST → P」边；若 P **（传递）依赖**该 TEST 任务（run 1 的倒置形状），先删除该倒置边再补边；仍成环 → `blocked` 交 LLM 修复轮 | 新增 |
| 退路口径：切片内**无**提供者声明 → 守卫无输入（与 PL-M7 7a 同一退路） | 新增 |
| 与 `criteria` 无关（本守卫不依赖 AC 记录），无编号 AC 的项目同样生效 | 新增 |
| run 1 回放：库中实值计划 + 给 T-05 声明 `providesScripts:["test"]` → 补边后 T-05 排到 T-02/T-03/T-04 之前，三个 TEST 任务的检查计划**非空** | 新增（本里程碑的核心判据） |

### 9c 门禁侧：TEST 任务不可裁决 fail-closed

| 判据 | 期望 |
| --- | --- |
| TEST 任务、候选检查为 `test`、工作区**无** `test` script → `verdict: failed` + `failureCode: EVIDENCE_MISSING`，reason 指明缺失的 script 与可操作修法 | 新增 |
| 「类型无候选检查」（ANALYSIS/DESIGN/REVIEW/MONITOR/INCIDENT）维持 `unavailable` | 保持 |
| 非 TEST 类型（BACKEND/FRONTEND/BUILD/DATABASE）维持 `unavailable`（仅由 9a 计数） | 保持 |
| `observe` 模式：只记录不覆盖（既有语义，`verifyingTaskExecutor.ts:77`） | 保持 |
| 既有单测 `taskVerifier.test.ts:202-216`（用 `ANALYSIS`）逐字不变 | 保持 |

## 4. 设计裁定（本任务书的推荐值）

| # | 事项 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | 三段是否同批 | **同批**（9a + 9b + 9c） | 9a 单独**不改变任何结果**（洞只是变可见）；9c 单独会**把静默的洞换成硬停**——run 1 里 T-02/T-03/T-04 会直接 FAILED，而 run 1 的策略是 `allowReplan: false`（`run-1.json`），没有自动重规划，工作流仍在 slice-1 止步；**9b 是让 9c 不产生净损失的前提**。三者互补而非重叠 |
| 2 | 9b 的声明形态 | **`providesScripts?: string[]`**（声明创建的 npm script 名） | ① 直接与 `CHECK_CANDIDATES` 的语义对齐，守卫可以按「需要哪个 script」精确配对；② 比 `bootstraps: true` 更自证；③ 不需要把 `CHECK_CANDIDATES` 上移 `@ai-se/shared`（守卫只关心 `test`，不需要候选表），**省掉一次跨包契约变更** |
| 3 | 9b 的守卫只覆盖 TEST 还是全部消费者 | **只覆盖 TEST** | 与 PL-M7 裁定 2 同一理由：TEST 是唯一「检查即任务本质」的类型（红灯检查是它存在的全部理由），也是本次实测中唯一被系统性削弱的类型。外扩到 BACKEND/FRONTEND/BUILD 需要把候选表上移 shared，属后续 |
| 4 | 修复层是否允许**删除倒置边** | **允许，且严格限定为「提供者（传递）依赖其消费者」这一种倒置** | ① run 1 的倒置边 `T-04→T-05` 使补边必然成环——只增边则只能 `blocked`，需要一轮 LLM 修复才能收敛，而 run 1 的规划已经两度 `SLICE_PLANNING_FAILED`；② **删除边不可能造环**（这是可证的性质）；③ 代价：`autoFixTaskPlan` 的「只增依赖边」白名单扩为「只增边 + 删除提供者→消费者倒置边」，头注释须同步，且该扩展必须在测试里被钉住 |
| 5 | 9c 的收紧范围 | **只对 TEST 类型** fail-closed | 见 #3。其余类型先只由 9a 计数——把范围扩大要先有对每个类型的提供者守卫 |
| 6 | 9b 守卫的接入位置 | `PlanningGraph` 既有校验块内（`coverageErrors` / `testFirstErrors` / `anchorErrors` 同一段，`PlanningGraph.ts:490-563`），**在 `backfillTaskPlanAcKeys`（`:427`）与 `autoFixTaskPlan`（`:448`）之后** | 与 PL-M7 同一位置约束：必须对「回填 + 自动修复之后的计划」判定，否则会对修复前的临时状态报错 |
| 7 | 9a 的事件是否计入 `failureLayers` | **不计入**（payload 不含 `errorCode`） | 同 PL-M7 7b：这是观察事件，不是失败层。计入会把「规划失败 6 层」这类既有归因搞脏 |
| 8 | 是否顺带把 `CHECK_CANDIDATES` 上移 `@ai-se/shared` | **不做**（本批） | 9b 只需知道 `test`；上移是「消除重复定义」的独立议题（`docs/146` §3 已有 `canonicalAcKey` 同类登记）。**避免把两件事捆在一起** |

**被否掉的方案（记录，避免重复推演）**：

| 方案 | 否决理由（实测） |
| --- | --- |
| **B2｜计划期推断**：「实现类任务不得依赖与其不共享 AC 的 TEST 任务」 | **误报率不可接受**。全库实查：`task_dependencies` 中「实现类 → TEST」的**直接边共 636 条**，其中**至少一侧 acKeys 为空的有 366 条**，而多数边的两侧 AC 并不相同（如 `T-03[AC-08] → T-04[AC-09]`）。该判据会大面积误报，且这些边在既有计划里大多是**合法**的（规划器习惯把测试成批排在实现之前） |
| **B3｜计划期推断**：「绿色地（工作区无 manifest）时，任何工作类任务不得依赖 TEST 任务」 | **必然误报**：N4 自己要求的「实现 → 测试」边就是「工作类任务依赖 TEST 任务」，且绿色地切片恰恰是 N4 的主场 |
| **B4｜计划期推断**：「每个 TEST 任务必须（传递）依赖至少一个工作类任务」 | **修不了 run 1**：run 1 的 T-02/T-03/T-04 已经依赖 T-01（DESIGN）；补一条「TEST → 某个工作类任务」不会改变 `T-04 → T-05` 这个**倒置**边，T-04 仍排在脚手架之前 |
| **D｜执行期就绪门**（TEST 任务在其检查脚本不存在时不视为就绪，延后到脚本出现） | 语义最正、且**不依赖任何声明**，但要改 `packages/workflow-engine` 的就绪判定（全平台影响面），且就绪探测必须在调度点跑命令（昂贵、有竞态），还要处理「无人创建脚本」的死锁退路 → **记为长期方案**，本批不做 |

## 5. 验证分层

| 层 | 位置（`AGENTS.md` §6 / §7） |
| --- | --- |
| 单测（9a） | `apps/server/src/__tests__/taskVerifierRules.test.ts`（两种空计划分开）+ `taskVerifier.test.ts`（事件与记录字段） |
| 单测（9b 守卫） | `packages/agent-core/src/planning/validateScriptProviders.test.ts`（新增，与源码同目录——该包既有惯例）：提供者缺失/存在、TEST 未依赖、已依赖、退路、最终切片不特殊 |
| 单测（9b 修复） | `packages/agent-core/src/planning/autoFixTaskPlan.test.ts` 追加：补边 / 删倒置边 / 成环 `blocked` |
| 回归（9b） | **新增 run 1 slice-1 计划夹具**（含倒置边 `T-04→T-05` 与三个无锚点 TEST 任务），断言「补边前 T-05 在 TEST 之后、补边后 T-05 在 TEST 之前」 |
| 单测（9c） | `taskVerifier.test.ts` 新例：TEST + 无 `test` script → `failed` + `EVIDENCE_MISSING`；**反向断言** ANALYSIS 仍为 `unavailable` |
| 指标（9a） | `packages/eval/src/__tests__/metrics.test.ts` 追加 `verificationUnavailable` 计数 |
| **A/B 实测（强制）** | 改前先取基线：`--filter @ai-se/server test` 的 `verificationGate.e2e` / `sliceFlow.e2e` / `planningApi.e2e` 三例；改后逐例对比。**这是 `docs/165` §2 偏差 1 的教训**——7b 曾被硬错误化并静默打断了 `planningApi.e2e`，只有 A/B 才定位到 |
| 门禁 | 受影响包 `typecheck && lint && test`（`agent-core` / `server` / `eval`）；收尾前全仓 `corepack pnpm -r run typecheck && lint && test` |
| 共享夹具核对 | 新增 `providesScripts` 后**全树 grep** 精确断言（`AGENTS.md` §7 的共享 fixture 规则）——`ScriptedPlanningModel` 的 todo 夹具与 `s1v4Fixture` / `l1v5Fixture` / `r1Fixture` / `slice5Run3Fixture` 都可能受影响 |

## 6. 边界与红线

- **不新增错误码体系**：9c 复用既有 `VerificationFailureCode = "VACUOUS_TEST" | "EVIDENCE_MISSING"`（`taskVerifier.ts:71`）；不新建第二套 Permission / Approval / Audit（`AGENTS.md` §10）。
- **不改判定规则本身**：9a/9c 只改「检查计划为空」这一分支的**分类与后果**；`command-filter` / `result-filter` / 红灯翻转判定（`resolveCheckOutcome`）逐字不动。
- 不改 `EvalPolicy`（P0 冻结基线）；不改 `packages/eval/fixtures` 与 oracle；不改 L1-8 判据口径。
- 不改 `acKeysBackfill` 的「范围回填」策略（F1-2 既有行为）。
- 不修改历史 `tasks` / `agent_runs` / `workflow_events` 行；不回溯改写 run 1 的库数据。
- 不修改任何 `dist/`。
- **本批不跑 E1×3 批次**。批次安排维持 `docs/165` 的 Next Phase Boundary（另开一批，下周配额窗口，开工前确认余量）。
- 收口时同步登记账：`docs/146` §3（N-1 行改为「已修（PL-M9）」）、`docs/127` §5 第 11 条（就地更正 + 处置）、`docs/164` §2.5 的更正以**追加块**落 `docs/126`（规则 7）、`docs/165` Known Issues 2 标注已处理。

## 7. 待裁定项（每条带推荐值）

| # | 事项 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | 9a / 9b / 9c 是否同批 | **同批** | 见 §4 裁定 1。若只做 9a（纯观察），本批**不产生任何行为改变**，只是把洞变成可量化——可接受但不够；若做 9a + 9c 而不做 9b，则是**净损失**（把静默的洞换成 slice-1 硬停，且无重规划） |
| 2 | 9b 的声明形态 | **`providesScripts?: string[]`** | 见 §4 裁定 2。备选：`bootstraps?: boolean`（更粗，但无法区分「提供哪个 script」）；或**只改提示词、不新增字段**（零契约变更，但**没有确定性守卫**，重演「提示词有禁令、缺的是守卫」的老形状） |
| 3 | 9b 修复层是否允许删除倒置边 | **允许**（严格限定形状） | 见 §4 裁定 4。备选：不删边，成环即 `blocked` 交 LLM 修复轮——run 1 需要一轮 LLM 修复才能收敛，而 run 1 的规划已经两度 `SLICE_PLANNING_FAILED`，代价更高 |
| 4 | 9c 是否只对 TEST 收紧 | **只对 TEST** | 见 §4 裁定 5 |
| 5 | DATABASE 类型错配（N-1b）是否并入 | **不并入**，只登记 | 属「任务类型适用性判定」，修法涉及「项目有无迁移脚本」的判定，与本批不同源 |
| 6 | 红灯判据的语义缺口（N-1c）是否并入 | **不并入**，只登记 | run 1 未证实；收紧会误伤正当的 TDD 红测试（「先红后绿」正是 TDD 的定义）。需要先有实测样本 |
| 7 | 是否把 `CHECK_CANDIDATES` 上移 `@ai-se/shared` | **不做**（本批） | 见 §4 裁定 8。避免与 `canonicalAcKey` 合并议题捆绑 |
| 8 | 本批完成后是否立即跑 E1×3 | **不立即**，维持 `docs/165` 的批次安排 | 周配额纪律（默认一周最多一个 E1×3 批次，`docs/127` §8）；开工前须确认周配额余量 |
