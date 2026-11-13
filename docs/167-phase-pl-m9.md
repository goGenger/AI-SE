# 167 · N-1「检查可判定性」实施记录（PL-M9）

> 状态：**已实施并收尾**（2026-10-16）。用户裁定「**都按你的建议，开工 PL-M9**」——即 `docs/166` §7 八项待裁定全部按推荐值接受；实施中据实测提出 §2 的 5 处偏差，**判据强度以本文件为准**。
> 依据：任务书 `docs/166`（§2 基线事实 / §3 判据 / §4 裁定 / §7 待裁定）、PL-M4 run 1 实测（`packages/eval/results/l1-m4/run-1.json` + dev 库只读实查）、`docs/146` §6 规则 7/8、`AGENTS.md` §7/§9/§10。
> 性质：**本文件是实施结果正本**。任务书 `docs/166` 的方案部分仍有效，**被本文件 §2 更正的 5 处以其为准**（`docs/146` §6 规则 7：不追改历史记录，更正以追加块形式落在这里）。

## Modified Files

| 文件 | 改动 |
| --- | --- |
| `packages/shared/src/index.ts` | `TaskPlanItemSchema` 新增可选 `providesScripts?: string[]`（9b 的声明面） |
| `packages/agent-core/src/planning/validateScriptProviders.ts` | **新增**。9b 守卫 `validateScriptProviders` + `listScriptProviders` / `listScriptConsumers` / `isTestFirstMandatedEdge` |
| `packages/agent-core/src/planning/validateScriptProviders.test.ts` | **新增**。11 例（提供者缺省/run 1 形状/直接依赖/传递依赖/别的 script/无消费者/最终切片无关 + N4 冲突判定 4 例） |
| `packages/agent-core/src/planning/planningScriptProviders.test.ts` | **新增**。2 例图级联合验证（run 1 形状 → 自动修复 + 计划通过；无声明 → 规则 3 不介入） |
| `packages/agent-core/src/planning/autoFixTaskPlan.ts` | 新增**规则 3**（脚本提供者先于消费者）；`rule` 与 `blocked.rule` 词表扩展 |
| `packages/agent-core/src/planning/autoFixTaskPlan.test.ts` | +5 例（删倒置边+补边 / 已满足 / 无声明 / N4 冲突记 blocked / 幂等）；`makeTask` 支持 `providesScripts` |
| `packages/agent-core/src/planning/validateTestFirstPlan.ts` | `dependencyClosure` 改为导出并对齐到 `{ id, dependencies }`（9b 守卫复用同一实现，不复制第二份闭包） |
| `packages/agent-core/src/planning/prompts/task-planning.prompt.ts` | 新增「Script providers」约束行（软硬双保险的软侧） |
| `packages/agent-core/src/planning/PlanningGraph.ts` | 接入 9b 守卫（`errors[]` 既有通道）+ 透传 `providesScripts` + `PLAN_AUTOFIXED` 的 `rule` 按实际规则标注 |
| `apps/server/src/services/taskVerifierRules.ts` | 新增 `resolveVerificationChecks`（9a：区分「无候选检查」与「缺 script」）；`planVerificationChecks` 改为其薄包装（**行为逐字不变**） |
| `apps/server/src/services/taskVerifier.ts` | 9a：记录字段 `missingChecks` + 事件 `TASK_CHECK_UNAVAILABLE`；9c：TEST 任务不可裁决 → `failed` + `EVIDENCE_MISSING` |
| `apps/server/src/__tests__/taskVerifierRules.test.ts` | +1 例（9a 两种空计划的区分，含 DATABASE 成对语义与 lint→typecheck 回退） |
| `apps/server/src/__tests__/taskVerifier.test.ts` | +5 例（9c 判定与包装层覆盖 / 9a 事件与记账 / ANALYSIS 不变 / script 存在时逐字不变） |
| `packages/eval/src/types.ts` · `harness.ts` · `metrics.ts` · `report.ts` | 9a：`verificationUnavailable` + `verificationUnavailableByType`（记录级与批次级）与报告行 |
| `packages/eval/src/__tests__/metrics.test.ts` | +1 例（不可判定计数按类型分列；不污染验证分歧与失败码） |

## Implementation

### 9a 门禁侧：可见化与计数（`apps/server` + `packages/eval`）

`planVerificationChecks` 返回空计划有**两种完全不同的成因**，此前被记成同一件事：

- **该类型没有候选检查**（`CHECK_CANDIDATES` 无此项：ANALYSIS / DESIGN / REVIEW / MONITOR / INCIDENT / DEBUG）→ `unavailable` 是**正确语义**；
- **该类型有候选检查、但工作区缺对应 script**（TEST / BACKEND / FRONTEND / BUILD / DATABASE）→ 这是**证据面缺失**——检查本该存在、只是跑不起来。

新增 `resolveVerificationChecks(taskType, scripts): { plans, missing }` 把两者分开；`planVerificationChecks` 改为 `resolveVerificationChecks(...).plans` 的薄包装，**既有调用方行为逐字不变**（`taskVerifierRules.test.ts` 原有断言全过）。

`missing.length > 0` 时：验证记录新增 `missingChecks`；`verdict === "unavailable"` 时另发 `TASK_CHECK_UNAVAILABLE` 事件（payload 只含 `stage/taskKey/taskType/sliceKey/missing`，**不含 `errorCode`**，故不被 `collectFailureLayers` 误计入失败层——同 PL-M7 7b）。批次侧新增 `verificationUnavailable` 与 `verificationUnavailableByType`，报告新增一行。

**9a 不改任何判定**：`verdict` 与 `verified` 逐字不变。

### 9b 计划期：脚本提供者守卫与确定性补边（`packages/agent-core`）

`TaskPlanItemSchema` 新增可选 `providesScripts`；规划器据此声明「本任务创建哪些 npm script」。守卫：**切片内存在声明了 `test` 的提供者时，每个 TEST 任务必须（传递）依赖某个提供者**，否则报 `PLAN_TEST_BEFORE_SCRIPT_PROVIDER`（错误信息列出提供者与可操作修法）。

**修复层规则 3**（`autoFixTaskPlan`）——run 1 的实测形状是**倒置边**（提供者 `T-05` 依赖消费者 `T-04`），只增边必然成环，故规则需要删边：

1. 逐个断开依赖图下游方向「消费者 → … → 提供者」路径的**首边**（`adjacency` 是「被依赖方 → 依赖方」；`taskEdges` 的 `source` = 被依赖方、`target` = 依赖方）；
2. 补「消费者 → 提供者」边。

**删除边不可能造环**（可证），因此「先断后补」不会引入环。规则 3 排在规则 1 **之后**：规则 1 补的「实现 → 测试」边是 N4 强制的，若反序会先补「测试 → 提供者」再被规则 1 补回反向边而成环。

**N4 无解冲突的显式处理**（实施中发现，任务书未涵盖）：若待断的边恰是 N4 强制的「实现任务 → 测试任务（共享 AC）」边，则 9b 与 N4 同时成立、计划无解——**不删边**，记 `blocked`（`rule: "script-provider-edge"`）交既有 LLM 修复轮，避免修复循环。

**退路口径**：切片内无提供者声明 → 守卫无输入（与 PL-M7 7a 同一退路），兜底由 9a 的观察事件承担。

### 9c 门禁侧：TEST 任务不可裁决 fail-closed（`apps/server`）

TEST 任务、候选检查为 `test`、工作区无 `test` script → `verdict: failed` + `failureCode: EVIDENCE_MISSING`，reason 指明缺失的 script 与可操作修法。**依据是本仓库既有的 fail-closed 教义**（`taskVerifier.ts` 的 `resolveCheckOutcome` 注释：「不可裁决一律 fail-closed 标 `EVIDENCE_MISSING`」）——红灯检查是 TEST 任务存在的全部理由，跑不起来即等于什么都没验证。

范围**只限 TEST**（`docs/166` §4 裁定 5）：其余类型维持 `unavailable` + 仅由 9a 计数。「类型无候选检查」维持 `unavailable`。`observe` 模式只记录不覆盖（既有语义，`verifyingTaskExecutor.ts:77`）。

## Architecture Changes

- **无新增包 / 无新增顶层目录**。唯一跨包契约变更是 `TaskPlanItemSchema` 新增**可选**字段 `providesScripts`（缺省即既有行为，既有夹具不受影响）。
- **新增事件类型** `TASK_CHECK_UNAVAILABLE`，走既有 `workflow_events` 通道——**不新增表、不新增错误码体系**（`AGENTS.md` §10）。9c 复用既有 `VerificationFailureCode = "VACUOUS_TEST" | "EVIDENCE_MISSING"`。
- **同包内复用**：`dependencyClosure` 由 `validateTestFirstPlan.ts` 导出并对齐到 `{ id, dependencies }`，9b 守卫与 N4 共用同一份闭包实现（不复制第二份——`docs/160` 已把「重复定义必然漂移」记为本仓库的缺陷成因类型）。
- **`CHECK_CANDIDATES` 未上移 `@ai-se/shared`**（`docs/166` §4 裁定 8）：9b 只需知道 `test`，避免与 `canonicalAcKey` 合并议题捆绑。
- **`apps/server` 的 `canonicalAcKey` 副本仍未动**（既有登记，见 Known Issues 4）。

## Dependencies

无新增依赖。

## Tests

| 层 | 内容 |
| --- | --- |
| 单测（9a 规则） | `resolveVerificationChecks`：TEST 缺 test → `missing:["test"]`；BACKEND 缺两者 → `["build","test"]`；部分缺失；FRONTEND 的 lint→typecheck 回退（有 typecheck 时 lint 不算缺失）；DATABASE 成对语义（缺一个只报那一个）；ANALYSIS/DESIGN/REVIEW → `missing: []`；script 存在时 `plans` 与 `planVerificationChecks` 逐字一致 |
| 单测（9a 门禁） | 非 TEST 类型缺 script → 维持 `unavailable` + 发 `TASK_CHECK_UNAVAILABLE`（payload 含 taskKey/taskType/missing，**无 errorCode**）；无候选检查类型 → 不发事件、无 `missingChecks` |
| 单测（9c） | TEST + 空脚本 → `failed` + `EVIDENCE_MISSING` + `missingChecks:["test"]` + `checks: []` + **一条 `npm run` 都没执行**；经 `VerifyingWorkflowTaskExecutor`（enforce）→ 覆盖自报成功、`errorType=VERIFICATION_FAILED`；script 存在时 TEST 仍走红灯检查（判定逐字不变） |
| 单测（9b 守卫） | 提供者缺省 → 零报错；run 1 形状 → 三个 TEST 逐个报错并列出提供者；直接/传递依赖 → 满足；声明别的 script 不算提供者；无 TEST 任务 → 无消费者；与切片是否最终无关 |
| 单测（9b × N4 冲突） | 实现类提供者与 TEST 共享 AC → 是 N4 强制边；不共享 AC（run 1 的 `T-05 → T-04`）→ 不是；目标非 TEST / 源非实现类 → 不是 |
| 单测（9b 修复） | **核心判据**：run 1 形状 → 断倒置边 + 三个 TEST 都补上「依赖提供者」、提供者成为根；已满足 → 不动；无声明 → 不介入；N4 冲突 → 不删边、记 blocked；幂等（重复运行无新 fix） |
| 图级联合（9b） | 走 `runPlanningGraph` + `s1v4Fixture`：run 1 形状 → 发 3 条 `PLAN_AUTOFIXED(rule=script-provider-edge)`、**计划通过**（无 `TASK_DAG_VALIDATION_FAILED`）、结果计划的 `T-05` 无依赖且 `T-02/03/04` 均依赖它；无声明 → 规则 3 零介入 |
| 指标（9a） | `verificationUnavailable=2`、`ByType={TEST:1,BACKEND:1}`；「本类型无客观检查」不计入；不污染 `taskVerificationDivergence` 与 `verificationFailureCodes` |

## Lint

`--filter @ai-se/agent-core|server|eval|shared lint` → 0；全仓 `corepack pnpm -r run lint` → **exit 0**。

## Typecheck

`--filter @ai-se/agent-core|server` → 0；全仓 `corepack pnpm -r run typecheck` → **exit 0**。

## E2E

全仓 `corepack pnpm -r run typecheck && lint && test` → **exit 0**，16 个 workspace 包全部通过：

| 包 | 用例数 | 包 | 用例数 |
| --- | --- | --- | --- |
| **agent-core** | **229（35 文件）** | apps/server | **281（50 文件）** |
| **eval** | **42（5 文件）** | apps/web | 505（41 文件） |
| shared | 89（9 文件） | mcp | 235（24 文件） |
| database | 47（10 文件） | visual | 83（6 文件） |
| browser | 38（8 文件） | tool-runtime | 32（3 文件） |
| workflow-engine | 45（3 文件） | failure-recovery | 16 |
| action-policy | 13 | evidence | 9 |
| sandbox | 8 | observability | 3 |

**A/B 实测（`docs/165` §2 偏差 1 的教训，本次强制执行）**：首轮全量 `apps/server` test 出现 1 例失败——`v1GoldenScenario.e2e.test.ts`「server restart: a fresh engine recovers in-flight work」`waitFor timed out`。按 A/B 流程取证：**隔离复跑该文件 4/4 通过**，**第二轮全量 281/281 通过** → 判定为 `docs/145` #7 / `docs/146` §5 已登记的**负载敏感抖动**（全量并行时该重型 e2e 超时），**非本次改动所致**。这是本次唯一一次非确定性失败，已按上述两步取证。

## §2 对 `docs/166` 的更正（5 处，均据实测）

### 偏差 1：9a 的验证记录只用**一个**字段

任务书 §3 写「新增字段，如 `unavailableReason: "scripts-missing"` + `missingChecks: [...]`」。实施只用 `missingChecks?: VerificationCheckName[]`——它自描述（列出缺哪些检查），一个字段即可表达，无需再加一个枚举标记。

### 偏差 2：9a 的事件只在 `verdict === "unavailable"` 时发出

任务书未明确 9c 的失败情形是否也发 `TASK_CHECK_UNAVAILABLE`。实施中**收窄为只发 `unavailable` 情形**：9c 的失败已由既有 `TASK_VERIFICATION` 事件的 `failureCode: EVIDENCE_MISSING` 承载，再发一个「UNAVAILABLE」事件会让事件语义自相矛盾。`missingChecks` 字段则在两种情形下都写（记录面统一）。

### 偏差 3：9b 修复层新增「N4 无解冲突」判定（任务书未涵盖）

任务书 §4 裁定 4 只说「先删倒置边再补边」。实施中发现一个任务书未讨论的形状：**待删的边恰是 N4 强制的「实现任务 → 测试任务（共享 AC）」边**——此时 N4 要求 `P → C`、9b 要求 `C → P`，两个要求同时成立即**计划无解**。若不处理，修复层会删掉 N4 的边、N4 校验器随即报错、LLM 修复轮补回、修复层再删——**修复循环**。

处置：`isTestFirstMandatedEdge` 判定该边是否 N4 强制；是则**不删边**，记 `blocked`（复用既有 `TaskPlanAutoFixBlocked` 形状 + 新增 `rule` 字段）交 LLM 修复轮。该扩展有 4 例专门单测钉住。

### 偏差 4：任务书 §6 的收尾对象有误

任务书 §6 写「`docs/164` §2.5 的更正以**追加块**落 `docs/126`（规则 7）」。**实查：`docs/126` §7 不含 N-1 的任何表述**——N-1 是 PL-M4 run 1（2026-10-16）的附带发现，登记在 `docs/146` §3 与 `docs/127` §5 第 11 条；`docs/164` §2.5 是任务书正文。故本次勘误落在 **`docs/127`（活文档，就地更正）** 与 **`docs/164`（状态行追加）**，**不动 `docs/126`**。

### 偏差 5：把 9c 的历史影响面量化了（任务书 §3 未要求）

9c 是**收紧**，任务书只给了判据、没给量级。实施中据 dev 库全量实查补测：

```
type=TEST 且 verdict=unavailable 的任务，其工作流最终状态：
  FAILED    17
  SUCCESS    7      ← 这 7 个会被 9c 判失败
  CANCELLED  1
```

逐条核对那 7 个：全部为 `[eval] E1` 的 slice-1 / slice-foundation TEST 任务（如「编写 [AC-04] DATA_DIR 明文密码扫描测试」「健康端点 HTTP 契约测试」），且**全部处于 `enforce` 模式**（实查 `verification.mode`）。

**结论：这 7 个是「真阳性」而非误伤**——它们的红灯检查确实一次都没跑，工作流却在测试先行保证失效的情况下报 SUCCESS。这正是本缺陷的定义。9c 的作用是让这类「假成功」不再出现；9b 的作用是让它们的**成因**（提供者被排在消费者之后）被自动修复，从而不把静默的洞换成硬停（`docs/166` §4 裁定 1）。

## Known Issues

1. **9c 的收紧依赖 9b 的声明——下一批的头号观察项。** 规划器若不声明 `providesScripts`，9b 无输入、9c 会把「静默的洞」变成 slice-1 硬停。需在下一批 E1×3 实测 `PLAN_TEST_BEFORE_SCRIPT_PROVIDER` 与 `TASK_CHECK_UNAVAILABLE` 的出现频率；若前者为 0 而后者非 0，说明规划器未按提示词声明，需收紧提示词或改判定。
2. **N-1b（DATABASE 类型错配）未修**：项目无迁移脚本却被派 DATABASE 任务 → 检查永远不可用。仍登记（`docs/166` §2.5）。
3. **N-1c（红灯语义缺口）未修**：`resolveCheckOutcome` 把「命令非零退出」一律当作「红灯已亮」，无法区分「尚未实现」与「根本没有可测之物」。run 1 未证实；收紧会误伤正当的 TDD 红测试。仍登记。
4. **`canonicalAcKey` 在 `apps/server` 仍有一份副本**（`taskVerifier.ts:173`）。既有登记（`docs/146` §3），本次未动。
5. **全仓门禁的既知抖动**：`v1GoldenScenario.e2e` 在全量并行下曾超时一次，隔离 4/4 通过、第二轮全量 281/281 通过（见 E2E 节）。与 `docs/145` #7 同类。

## Acceptance Result

**PASS**。`docs/166` §3 的三组判据全部达成：

- **9a**：两种空计划成因可区分；`unavailable` 情形发事件并计入批次指标；`verdict`/`verified` 逐字不变。
- **9b**：run 1 形状（含倒置边）在图级回放中被自动修复——三个 TEST 任务都排到提供者之后、提供者成为根、计划通过；无声明时零介入；N4 冲突记 blocked 不成环。
- **9c**：TEST 任务不可裁决 → `failed` + `EVIDENCE_MISSING`，一条检查都没跑；非 TEST 类型与「无候选检查」类型行为逐字不变。

三包（`agent-core` / `server` / `eval`）与全仓 `typecheck` / `lint` / `test` 全绿（全仓 exit 0）。**§2 的 5 处偏差已如实记录**，其中偏差 3 是实施中发现的真实设计缺口（N4 × 9b 无解冲突），偏差 5 量化了收紧的历史影响面（7 个真阳性）。

## Next Phase Boundary

**未开始事项（STOP）**：

- **未跑任何批次**。批次安排维持 `docs/165` 的 Next Phase Boundary：另开一批 E1×3（PL-M4 记「已执行 1/3、因发现确定性缺陷中止」），受周配额纪律约束（默认一周最多一个 E1×3 批次，`docs/127` §8），自然落在下周窗口。**开工前须确认周配额余量**；开工时按约定用 harness 追踪的后台任务启动 + 立即 arm 看门狗（`packages/eval/scripts/eval-batch-watchdog.sh`，退出即通知）。
- 不处理 N-1b（DATABASE 类型错配）与 N-1c（红灯语义缺口）——已登记（`docs/166` §2.5 / 本文件 Known Issues 2、3）。
- 不合并 `apps/server` 的 `canonicalAcKey` 副本（Known Issues 4）。
- 不把 `CHECK_CANDIDATES` 上移 `@ai-se/shared`（`docs/166` §4 裁定 8）。
- 不收紧 7b（等 `PLAN_TEST_TASK_UNANCHORED` 事件的实测频率，`docs/165` Known Issues 1）。
- 不修改 `packages/eval` 的夹具与 oracle；不改 `EvalPolicy`。
