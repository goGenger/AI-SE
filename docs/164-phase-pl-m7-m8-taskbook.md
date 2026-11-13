# 164 · 切片外红测试致败修复任务书（PL-M7 / PL-M8）

> 状态：**PL-M7 / PL-M8 已于 2026-10-16 实施完成**（用户同日裁定「都按你的建议，开工 PL-M7 和 PL-M8」= §7 六项待裁定全部按推荐值接受）。**实施记录 `docs/165`**——其中 §2 记录了**对本文档的 3 处更正**（7b 由硬错误降为观察项、PL-M8 兜底只对无锚点任务生效、`canonicalAcKey` 换家），**判据强度以 `docs/165` 为准**。PL-M4 的 runs 2/3 **未跑**（§7 第 4 项裁定）。
> 编号：里程碑 **PL-M7**（计划期 TEST 任务锚点）／**PL-M8**（门禁判定作用域兜底）。**不新造验收编号**——两项修的都是缺陷，不是新增能力。
> 依据：PL-M4 run 1 实测（`packages/eval/results/l1-m4/run-1.json` + dev 库只读实查）、`docs/126` §7 第 1/2/4 条、`docs/127` §5、`docs/158` / `docs/160` / `docs/161` / `docs/162` / `docs/163`、`docs/146` §6 规则 7/8、`AGENTS.md` §9/§10。
> 性质：**本文件是改动方案**，不构成开工授权（`docs/146` §0）。
> **（2026-10-16 追加）§2.5 N-1 的两处更正**：① 其中「TDD 顺序要求 TEST 任务排在实现任务之前」**不准确**——实查 N4（`validateTestFirstPlan.ts:77-93`）只在「实现任务与 TEST 任务**共享 AC**」时补边，脚手架任务没有 acKeys 因而被整个跳过，那条倒置边是**规划器自己写的**；② 其中「成因未完全证实，只作登记」**已可撤销**——机制已完全证实（计划期倒置 → 验证期 `plan=[]` 落 `unavailable` → `enforce` 下只覆盖 `failed` → 静默通过）。两处更正与处置见 `docs/166` §2.4 与 `docs/167`（**N-1 已由 PL-M9 修复**；N-2 维持登记）。

> **（2026-10-17 追加）§2.5 N-2 的更正与处置**：① §2.5 称 N-2「真缺陷，但**未致本次失败**（审计模式 `observe` 只记录不拦），属独立子阶段」——**「未致本次失败」已不再成立**。L1-M4b run 1（工作流 `cbbb7859-…`，2026-10-17）里工程骨架任务被排在切片**首位**（正是 PL-M9 9b 想要的形状：提供者先于消费者）后，它**在第一个任务上就判死整条链**，13 分钟终止，S1 一败六挂起。② **机制补充（原登记只说「无人能写仓库根」）**：根因是**两份写范围定义互相矛盾**——审计侧 `apps/server/src/services/writeScopeAudit.ts` 的 `CONFIG_PATH` 早已把根级 `package.json` / `pnpm-lock.yaml` / `tsconfig*.json` / `.gitignore` 判为实现类任务的**合法**写入，而强制侧 `packages/agent-core/src/professional/AgentRegistry.ts` 的 `writePaths`（前缀白名单，仓库根是所有前缀的父目录，表达不了「根本身」）把它们全部拒绝。③ **处置**：**已由 PL-M10 修复**（任务书 `docs/168`、实施记录 `docs/169`）——判据上移 `@ai-se/shared`（`isProjectManifestPath`，与 PL-M5 的 `isTestFilePath` 同形）、强制侧新增 `writeProjectManifests` 语义标志、审计侧删除第二份定义、修正范围列表把单文件画成目录的显示缺陷。④ 本文档 §1 排除表第 3 行与 §7 第 6 项的「N-2 不并入本批、另立项」**已由用户 2026-10-17 裁定「停，先修 N-2」取代**。⑤ **注**：N-2 的另一半（BACKEND 任务写根级 `README.md`）**两侧判定一致**（均越界），属 N-3（非最终切片不得安排文档交付物），**维持登记不修**。

## 0. 为什么先做这一批

PL-M4 run 1 于 2026-10-16 15:11–15:54 跑完，**staging 段 否（-/-/-）**，链止于 **slice-1**，T-10 三次验证全败后工作流 FAILED。归因（§2）指向一个**确定性**缺陷：一个属于后续切片的红测试，把本切片的实现任务判死。

按 `docs/162` §0 已确立的规则——**验收批次是验证修复的，不是发现缺陷的**——继续跑 runs 2/3 只会复现同一类失败。故先立本任务书，修完再谈批次（批次完整性另有裁定，见 §7 第 4 项）。

## 1. 范围（用户 2026-10-16 指令 1+2）

| # | 里程碑 | 条目 | 判定 |
| --- | --- | --- | --- |
| 1 | **PL-M7** | 计划期拦住「非最终切片的 TEST 任务引用本切片范围外的 AC」 | **真缺陷**（计划侧） |
| 2 | **PL-M8** | 验证门：dev 任务的 `test` 检查不得被**本切片范围外**的红测试拖垮 | **真缺陷**（门禁侧） |

**明确排除**（本批不动）：

| # | 条目 | 排除理由 |
| --- | --- | --- |
| 3 | 无任何 agent 能写仓库根，而计划派了「编写 README」任务（`SCOPE_VIOLATION`） | 真缺陷，但**未致本次失败**（审计模式 `observe` 只记录不拦），属独立子阶段 |
| 4 | slice-1 三个 TEST 任务全部 `unavailable`，红灯检查一次未跑 | 真缺陷（§2.5 N-1），**需先裁定**是否并入本批（§7 第 5 项） |
| 5 | `docs/162` §1 排除的第 4/5/6 项（MCP 记录面、MCP 控制台未实现操作、门禁抖动） | 维持原裁定，本批不动 |

## 2. 基线事实（PL-M4 run 1 实测，2026-10-16 代码与库实查）

### 2.1 失败链

工作流 `09eca545-e8a4-471b-8f23-443a3afe06ca`，12 个任务（version 47），其中 10 SUCCESS / 1 FAILED / 1 PENDING。

| 步骤 | 事实 | 证据 |
| --- | --- | --- |
| ① 计划 | slice-1 的 `fr_keys = ["FR-9","FR-7"]`；该范围内**编号 AC 只有两条**：AC-04（`FR-7`）与 AC-30（`FR-9`），而 AC-30 是全局性 AC（`verification = 命令执行 + 测试名解析`，命中 `isGlobalAcceptanceCriterion` 的 `/命令执行/`），按 F1-4 归属最终切片 | 库：`requirement_slices` / `requirement_acceptance_criteria` |
| ② 计划 | **slice-1 的范围内 AC 集合 = {AC-04}**（`selectAcceptanceCriteriaForSlice(criteria, ["FR-9","FR-7"], {isFinalSlice:false})`） | `acceptanceCriteria.ts:151-178` |
| ③ 计划 | 计划里出现 **T-11（TEST，slice-1，`acKeys` 空）**，标题「集成测试：重启后数据保留」、描述「写入用户与任务数据，模拟进程重启后读取，断言数据完整保留」——**这正是 AC-25 的题目**；AC-25 的 `fr_keys = ["FR-8"]`（属 **slice-2**）且 `verification = 容器运行`（全局性）→ **双重越界** | 库：`tasks`（T-11 行）；`requirement_acceptance_criteria`（AC-25） |
| ④ 执行 | T-11 的 agent 按计划写出 `test/ac-25-restart-persistence.integration.test.mjs`，文件抬头即 `// [AC-25] 集成测试：重启后数据保留（用户与任务）`，并自陈「当前 `src/index.js` 仅有健康端点与首页骨架，业务路由尚未实现，因此该用例预期「先失败」」 | eval 工作区 `/Users/shixianbao/Desktop/study/ai-se-eval/E1/run-1/test/ac-25-restart-persistence.integration.test.mjs` |
| ⑤ 执行 | T-11 自身**通过**：TEST 任务的 `test` 检查是**红灯检查**（`expectation: "fail"`，`taskVerifierRules.ts:95-100`），套件因它自己而红 → 红灯已亮 → `achieved` | 库：`TASK_VERIFICATION`（T-11：`test passed=true`） |
| ⑥ 门禁 | **T-10（BACKEND，slice-1，`acKeys` 空）** 的 `test` 检查 = 全量 `pnpm test`，必须绿；套件 19 个测试 18 过 1 败（败者即 AC-25）→ `exitCode 1` → **失败**；重试 3 次全败 | 库：`TASK_VERIFICATION`（T-10 ×3，`checks failed: test`）；`run-1.json` `errorTypes.VERIFICATION_FAILED = 1` |
| ⑦ 结果 | 工作流 FAILED；`sliceReached: slice-1`；`stagingSegment` 三项全 `null`；`taskVerificationDivergence: 1`（agent 自报成功 vs 门判失败） | `packages/eval/results/l1-m4/run-1.json` |

T-10 的 agent 三次都在自报里写明了原因（原话）：`node --test is 18/19; the only failure is the pre-existing TDD integration test [AC-25] which expects POST /api/register to return 201 but gets 404 because the auth/task business routes belong to later slices, unrelated to and outside the scope of this README task.`——**agent 的判断是对的，门的判定是错的。**

### 2.2 五道既有守卫为什么同时隐形

| 守卫 | 位置 | 为什么对 T-11 / T-10 无感 |
| --- | --- | --- |
| `GLOBAL_AC_OUTSIDE_FINAL_SLICE` | `validateTaskGraph.ts:79-91` | 判据是 `task.acKeys` 里有没有全局 AC。T-11 **一条都没声明** → 无输入 |
| N4 测试先行顺序 | `validateTestFirstPlan.ts:101` | 只在「实现任务与测试任务**共享 AC**」时要求补边。T-11 无 AC → 无共享 → 无输入 |
| PL-M1 实现覆盖 | `validateImplementationCoverage.ts:18-40` | 只在「范围内 Must AC 无实现任务引用」时报错。slice-1 范围内只有 AC-04，而 AC-04 被 T-07/T-08 引用 → **满足**（**该里程碑在 run 1 未报错，但也几乎没有约束力**——见 §2.3） |
| F1-5 门禁作用域 | `taskVerifier.ts:457-462` | `taskTestScope` 要求 `acKeys.length > 0` 才返回作用域。T-10 无 AC → 返回 `{}` → **不作用域** → 退回全量套件 |
| `PLAN_ACKEYS_MISSING` | `validateAcKeysPresence.ts:26` | 判据是**计划级** `tasks.some(task => acKeys.length > 0)`。T-02/T-07/T-08 有 AC → 计划级通过 |

**共同点：五道守卫全部以「任务已声明 acKeys」为前置条件。** run 1 的 12 个任务里 **8 个 `acKeys` 为空**（T-01、T-03、T-04、T-05、T-06、T-09、T-10、T-11），于是五道守卫对它们同时隐形。

### 2.3 登记账更正（本任务书的核心发现）

`docs/126` §7 的第 1（acKeys 缺口）、2（N4 校验器仅在 acKeys 存在时生效）、4（BACKEND 全量套件检查过宽）三条，在 `docs/127` §5 的「F 期处置注记」里被记为 **「已修复（F1-2 / F1-3 / F1-5）」**。

**run 1 证明这三条修复都带着同一个未消除的前置条件**：

- F1-2 的确定性回填（`acKeysBackfill.ts`）只保证「**每条范围内 AC 至少被某个任务引用**」，**不保证「每个任务都有锚点」**。slice-1 范围内只有 AC-04，而 AC-04 已被 T-07/T-08 引用 → 回填无物可填 → 其余 8 个任务保持空。run 1 期间**没有任何 `PLAN_ACKEYS_BACKFILLED` 事件**（库实查），与此一致。
- F1-3 / F1-5 的生效条件就是「任务带 acKeys」，因此对那 8 个任务整体空转。

**结论：第 1/2/4 条不应停留在「已修复」**——准确表述是「**修复已落地，但在真实计划上被空 acKeys 整体短路**」。`docs/146` §3 与 `docs/127` §5 需按此改写（收口时同步，`docs/146` §6 规则 8）。

**同时更正我上一轮的口头归因**：我说「PL-M1 真的生效了」——**不准确**。准确说法是「PL-M1 在 run 1 未报错，且计划里确实出现了 T-05…T-10 六个实现任务」；但 slice-1 的范围内 AC 只有一条且已被覆盖，**PL-M1 的实际约束力比 `docs/160` 的表述要弱得多**，不能据此宣称「根因已修」。

### 2.4 为什么 1 与 2 必须同批

两者各自只堵一半，且**互补而非重叠**：

| 只做 | 后果 |
| --- | --- |
| 只做 PL-M7 | T-11 会被迫声明锚点（或改写成范围内测试）→ 本次失败**可能**消失；但**无锚点的实现任务（T-10）仍然被全量套件判定**，任何来源的切片外红测试（包括 agent 自己多写的测试文件）都能再次把它判死 |
| 只做 PL-M8 | 本次失败消失（T-10 按 slice-1 范围判定 → AC-04 已过 → 通过）；但计划**仍然**在 slice-1 里安排了 AC-25 的交付物——切片边界错置、agent 工时浪费，且最终切片还要面对 slice-1 留下的（可能错误的）AC-25 测试 |

### 2.5 附带发现（登记，本批范围外）

- **N-1｜slice-1 的三个 TEST 任务全部 `unavailable`。** T-02/T-03/T-04 的验证记录是 `no available checks for task type TEST`——因为 `test` 脚本由 T-05 创建，而测试先行顺序要求 TEST 任务排在实现任务之前。**结果：slice-1 的红灯检查一次都没跑**，`VACUOUS_TEST` / `EVIDENCE_MISSING` 保护整片缺席。
  - 佐证：T-05 的 `test` 检查 `exitCode 0`（**套件当时是绿的**），而 AC-04 的测试文件此时已存在——即 slice-1 当时并不处于「红灯」状态。成因（空转通过的具体机制）未完全证实，**只作登记，不作为结论**。
- **N-2｜仓库根无写权限。** T-10 的 `SCOPE_VIOLATION {mode:"observe", taskKey:"T-10", violations:["README.md"]}`——backend agent 的写范围是 `apps/server|server|backend|src`，devops 是 `infrastructure|compose.yaml|Dockerfile`，**没有任何 agent 能写仓库根**，而计划派了「编写 README」。本次未致失败（`observe` 只记录）。
- **N-3｜计划在 slice-1 安排了文档交付物。** `task-planning.prompt.ts:25` 已明写「**the final slice owns the delivery chain and verifies deployment/documentation acceptance**」——T-10「编写 README」与 T-11（AC-25 容器运行类）**都违反该条款**。即：**提示词已有禁令，缺的是确定性守卫**；而守卫的输入（acKeys）恰好为空。这正是 PL-M7 的立项理由。

## 3. 各里程碑的判据

### PL-M7 非最终切片的任务锚点

| 判据 | 期望 |
| --- | --- |
| 7a：非最终切片的任务**声明**的 acKeys 必须落在切片范围内（AC-x 需在范围内 AC 集；FR-x 需在 `slice.frKeys`） | 新增。这是既有 `GLOBAL_AC_OUTSIDE_FINAL_SLICE` 的一般化——后者只拦全局 AC，本条拦全部越界引用 |
| 7b：非最终切片的 **TEST 任务必须至少声明一个锚点**（AC-x 或 FR-x） | 新增。**7b 是 7a 的前置输入**——没有 7b，7a 对「什么都不声明」的任务仍然无感（这正是 run 1 的情形） |
| 错误信息**列出本切片范围内的 AC/FR 清单**，使修复轮可机械对齐 | 新增 |
| 范围内既无 AC 也无 FR 时**跳过**（保持既有行为） | 保持（与 PL-M1 / `validateMustAcTestCoverage` 同一退路口径） |
| 最终切片行为逐字不变 | 保持 |
| 只报错、不自动造任务；错误汇入既有 `errors[]` → 既有 LLM 修复轮 | 保持（`docs/158` §6 第 3 项裁定 A） |
| 不新增错误码体系 | 复用既有消息前缀风格（`PLAN_*`，同 `PLAN_ACKEYS_MISSING`） |

### PL-M8 门禁判定作用域兜底

| 判据 | 期望 |
| --- | --- |
| dev 任务（`isDevTaskType`）**未声明 acKeys** 时，`test` 检查的作用域回退为**本切片全部任务的 acKeys 并集** | 新增 |
| 该任务声明的 acKeys 非空时，作用域 = 自身 acKeys ∪ 切片并集（仍是放宽，不是收紧） | 新增 |
| 判定语义**逐字复用**既有 `command-filter` / `result-filter`（`taskVerifier.ts:592-604`、`907-914`），**不改判定规则** | 保持 |
| **严格放宽**：任何在改动前通过的任务，改动后仍通过 | 新增（可测性质，见 §4 裁定 3） |
| 切片并集为空（无 AC 记录的项目）时，退回今日行为（全量套件） | 保持 |
| 「全量套件全绿」的职责交还 **AC-30**（全局 AC，最终切片，由隐藏 oracle 判定 `pnpm test` 全绿） | 保持（`packages/eval/fixtures/E1/oracle.mjs:605-622`） |
| run 1 复现：注入「T-10 无锚点 + 存在切片外红测试」→ 修前 `failed`，修后 `verified` | 新增（本里程碑的核心判据） |

## 4. 设计裁定（本任务书的推荐值）

| # | 事项 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | PL-M7 的锚点命名空间 | **AC-x 与 FR-x 都接受** | slice-1 的范围内**编号 AC 只有 AC-04 一条**，而 T-03/T-04 的正当工作是 FR-7-1 / FR-9-1 这类 FR 子项。只认 AC-x 会逼规划器把「持久化契约测试」谎报成 AC-04，属**制造假锚点**。FR-x 是切片范围（`fr_keys`）的本位表达，且既有 `acKeysBackfill` 已支持 FR→AC 展开 |
| 2 | PL-M7 是否扩大到所有工作类任务 | **只要求 TEST 任务带锚点；7a 的越界检查对所有任务生效** | TEST 是**唯一**验证检查为红灯（`expectation: "fail"`）的类型，即**唯一能种下「切片外红测试」的类型**。把「必须带锚点」扩大到 8/12 个任务会显著抬高修复轮负担，且有**成环风险**：任务共享同一 AC 会让 N4 强制补「实现→测试」边——run 1 已出现 6 次 `PLAN_AUTOFIXED … cycle-blocked`。宁可窄而准 |
| 3 | PL-M8 的兜底作用域取「切片并集」还是「任务自身」 | **切片并集**（并证明它是严格放宽） | ① **严格放宽可证**：判定式是 `achieved = result.success ∨ (范围内 AC 结果非空且全过)`（`taskVerifier.ts:592-604`），改动只把 `resultFilter` 从「有」变成「更多时候有」，`result.success` 不变 → 通过集只增不减，**不存在把原先通过的任务判死的情形**。② 语义自洽：既有代码注释已写明「**作用域外失败不参与本任务判定**」，本条只是让无锚点任务也拿到一个作用域。③ 取「任务自身」对无锚点任务无意义（作用域仍为空） |
| 4 | 兜底作用域的来源 | **复用 `maybeSliceBoundaryCheck` 已在用的同一集合**（`taskVerifier.ts:863-880`：同 `sliceKey` 全部任务的 `input.acKeys` 去重并集） | 切片边界绿灯检查已经用这个集合；两处口径统一，避免出现「切片范围」的第二个定义（`docs/160` 已把「重复定义必然漂移」记为本仓库的缺陷成因类型） |
| 5 | 「全量套件必须全绿」的归属 | **交还 AC-30（全局 AC，最终切片，隐藏 oracle 判定）**，门禁不重复承担 | AC-30 的口径原文即「`pnpm test` 全绿」（oracle `:605-622`）。让每个 dev 任务都重复承担它，正是本次缺陷的来源；在**非最终**切片上它还与「测试先行」自相矛盾 |
| 6 | 修复位置的顺序 | PL-M7 的新校验器放在 `PlanningGraph` 既有校验块内（`coverageErrors` / `testFirstErrors` 同一段，`PlanningGraph.ts:504-531`），**在 `backfillTaskPlanAcKeys` 与 `autoFixTaskPlan` 之后** | 必须对「回填+自动修复之后的计划」判定，否则会对回填前的临时状态报错 |

## 5. 验证分层

| 层 | 位置（`AGENTS.md` §6 / §7） |
| --- | --- |
| 单测（PL-M7） | `packages/agent-core/src/planning/` 同目录：`validateTaskAnchors.test.ts`（7a/7b 各正反例；范围内/越界/空锚点/无范围退路/最终切片不变） |
| 回归（PL-M7） | 复用既有夹具 `slice5Run3Fixture.ts`（库中实值计划）；**新增 run 1 的 slice-1 计划夹具**（T-11 空锚点 + AC-25 越界）作为反向用例——修前零报错、修后报出 |
| 单测（PL-M8） | `apps/server/src/services/` 同目录：`taskVerifier` 既有测试文件补「无锚点 dev 任务 → 作用域取切片并集」正反例；**严格放宽性质测试**：对一组构造用例断言「修后通过集 ⊇ 修前通过集」 |
| 回归（PL-M8） | 注入式用例：切片外红测试 + 无锚点 dev 任务 → 修前 `verdict: failed`，修后 `verdict: verified`（本里程碑的核心判据） |
| 门禁 | 受影响包 `typecheck && lint && test`；收尾前全仓 `corepack pnpm -r run typecheck && lint && test` |

## 6. 边界与红线

- 不新增错误码 / 不新建第二套 Permission / Approval / Audit 体系（`AGENTS.md` §10）。
- 不改 `EvalPolicy`（P0 冻结基线）；不改 L1-8 判据口径；不改 `packages/eval` 的夹具与 oracle。
- **不改提示词**：N-3 显示 `task-planning.prompt.ts:25` 已有禁令，缺的是确定性守卫；本批只补守卫。
- 不改 `acKeysBackfill` 的「范围回填」策略（F1-2 既有行为，本批不动）。
- 不修改任何 `dist/`；不回溯修改历史 `agent_runs` / `tasks` 行。
- **PL-M4 的 runs 2/3 仍处暂停**；本批完成后是否跑、以什么口径记账，见 §7 第 4 项。
- 收口时同步登记账：`docs/146` §3、`docs/127` §5（§2.3 的更正）、`docs/126` §7 的措辞按「历史记录冻结、勘误只追加」处理（`docs/146` §6 规则 7）。

## 7. 待裁定项（每条带推荐值）

| # | 事项 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | PL-M7 的两半是否都做（7a 越界检查 + 7b 锚点必需） | **都做** | 只做 7a 对 run 1 的 T-11 无效（它什么都没声明）；只做 7b 则任务可以「声明一个越界锚点」绕过。两半是一对 |
| 2 | PL-M7 是否把「非最终切片不得安排文档/交付类工作」也做成确定性守卫 | **不做**，只登记（N-3） | T-10 的「文档类」性质只能靠标题/描述文本匹配判定，脆弱且易误伤（BACKEND 类型下合法的 `docs/` 写入是可能的）。先靠 PL-M8 消除它的**后果**，计划侧错置另立项 |
| 3 | PL-M8 是否同时把「无可用检查」的 dev 任务从 `unavailable` 收紧 | **不收紧** | `unavailable` 在 `enforce` 下**不判失败**（`verifyingTaskExecutor.ts:77` 只在 `verdict === "failed"` 时覆盖）。收紧会改变全平台的门禁强度，超出本次缺陷范围 |
| 4 | **runs 2/3 还跑不跑**（批次完整性） | **不跑**。PL-M4 记「已执行 1/3，因发现确定性缺陷中止」，修完后**另开一批** E1×3 | 跑 runs 2/3 意味着「明知缺陷未修还烧配额」，且会把**修前/修后两个平台版本混进同一批次**，使 3 次运行不可比。另开批次受周配额纪律约束（默认一周最多一个 E1×3 批次，`docs/127` §8）→ 自然落在下周窗口 |
| 5 | 附带发现 N-1（TEST 任务 `unavailable`）是否并入本批 | **不并入**，另立项 | 它是**计划顺序与检查可用性的矛盾**（TDD 要求测试先行，但测试运行器由脚手架任务创建），修法涉及任务排序或检查降级，与本批两处缺陷不同源。**但它显著影响 run 1 的归因**，建议在 PL-M4 的记录里作为独立条目写明 |
| 6 | 附带发现 N-2（仓库根写权限）是否并入本批 | **不并入**，另立项 | 本次未致失败；且涉及「谁有仓库根写权限」的产品判定，不是缺陷修补 |
