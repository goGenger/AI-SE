# 184 · L1-M4i 两处新致败点修复实施记录（PL-M18）

> 状态：**已实施**（2026-10-18）。用户裁定链：① 「**先立项那两个新致败形态**」→ 任务书 `docs/183`；② 「**都按你的建议，开工 PL-M18**」→ §7 八项按推荐值接受；③ 「**按 1 走**」→ 解冻 `EvalPolicy`；④ 核实后报告选项 1 描述不完整 → 「**按 1a 走**」；⑤ 探针发现 REPLAN 会再造 REVIEW → 「**按 M1 走**」。
> 依据：任务书 `docs/183`（含 §10 实施期发现）、**两支探针**（`apps/server/scripts/probe-n10-redlight-scope.ts`、`packages/workflow-engine/scripts/probe-n11-review-verdict-path.ts`）、库内与代码实查。
> 性质：**本文件是实施结果正本**。**不新造验收编号**；判据 **18a–18h** 见 `docs/183` §3。

## Modified Files

| 文件 | 改动 |
| --- | --- |
| `apps/server/src/services/taskVerifier.ts` | **N-10**：`scopedEvidenceKeys` 增加**切片回退**（新增 `sliceDeclaredAcKeys`）；`acImplementationEvidence` 拆为 `loadRequirementTasks` + 纯函数 `implementationEvidence`；新增 `uncoveredAcKeys`（检查记录 + `VerificationCheckEvidence` + reason） |
| `apps/server/src/__tests__/taskVerifier.test.ts` | **+3 例**（新增 describe）。既有 **48 例一字未改** |
| `apps/server/scripts/probe-n10-redlight-scope.ts` | **新增**。真实 `TaskVerifier` + 真实 dev 库；V0/V0p/V1/V2/V3 |
| `packages/shared/src/index.ts` | 新增 `WORK_TASK_TYPES` + `isWorkTaskType`（**N-11** 的判定，与 `isUsableTargetTaskType` 同居一处）；`L1_WORKFLOW_POLICY` 改 `failureStrategy: "REPLAN"` + 新增 `allowReplan: true` |
| `packages/shared/src/autonomyPolicy.test.ts` | **1 处策略值断言**由 `"RETRY"` 改 `"REPLAN"`，并新增 `expect(parsed.allowReplan).toBe(true)` |
| `packages/workflow-engine/src/WorkflowEngine.ts` | **N-11**：新增 `fixWorkTargetType`；`debugTargetType` 增加 `workType` 参数、末道兜底由 `source.type` 改为工作类型；`replan()` 的 retry 任务 `type` 由 `source.type` 改为 `target.type` |
| `packages/workflow-engine/src/WorkflowEngine.test.ts` | **+3 例**（新增 describe）。既有 **45 例一字未改** |
| `packages/workflow-engine/scripts/probe-n11-review-verdict-path.ts` | **新增**。真实 `WorkflowEngine` + 忠实内存 store + 假 executor；P0/P1/P2 |
| `packages/eval/src/cli.ts` | `L1_POLICY_OVERRIDE`：`failureStrategy` 改 `"REPLAN"`、新增 `allowReplan: true`（`Pick` 同步加键）。**`POLICY`（P0 冻结基线）一字未动** |
| `packages/eval/results/n10-probe{,-after}/` `n11-probe{,-after}/` | 探针读数（修复前 / 修复后各一份，**都保留**） |

**未改动**：`DEV_TASK_TYPES`、`maxIterations` / `recursionLimitFor`、`packages/eval/src/usageGuard.ts`（守卫）、`patches/@langchain__openai@1.5.11.patch`、任何 `dist/`、任何历史 `tasks` / `agent_runs` / `workflow_events` 行、L1-8 判据口径、`packages/eval` 的夹具与 oracle、**`POLICY`（评测基线）**。

## Implementation

### 1. N-10 · TEST 红灯检查的作用域回退

**根因（探针实测，判据 18a）**：`T10` 的记录里作用域是 `acChecked=5`、**`acFailed=0`** —— 5 个 AC **全部通过**。所以判 `VACUOUS_TEST` 的**唯一**原因在证据面（`acKeys.every(...)` 为假），不是 `allPassed`。逐键归因（真实 dev 库，证据面 285 个任务）：

| 键 | 覆盖 | 曾被本需求任何任务声明 |
| --- | --- | --- |
| `AC-04` | 有 | 是 |
| `AC-29` | 有 | 是 |
| `AC-30` | 有 | 是 |
| **`FR-06`** | **（无）** | **否** |
| `TR-03` | 有（实测记录） | 否 |

⇒ **唯一阻塞键是 `FR-06`**：`BRACKETED_MARKER_PATTERN`（`/\[([A-Za-z]{2,})-(\d+)\]/g`）把测试标题里的 **FR 编号**当成 AC 键，而本需求没有任何任务声明过它 ⇒ 恒不可满足。而仓库自己的 **AC-30 契约测试要求标题带 `FR-x.y/AC-xx` 记号**——两条规则互相打架。

**修法（裁定 4 候选 (a)，由探针在 (a)/(b) 间选定）**：`scopedEvidenceKeys` 在**无可用锚点**时，作用域由「全量解析键」改为「**本任务所在切片声明过的 AC** ∩ 解析键」。切片键取自同需求、同 `sliceKey` 的任务（新增 `sliceDeclaredAcKeys`）。**该回退只在任务确实带 `sliceKey` 时启用**，故无切片信息时行为与改动前**逐字相同**。

**为什么不做 (b)**（无锚点且范围不可定时判 `EVIDENCE_MISSING`）：探针证明 (a) 足以翻转，而 (b) 会改动无切片信息时的既有判定——`FG1` 对照用例正是那个形状，18g 要求既有断言逐字不变。⇒ **两候选间选了 (a)**。

**(c) 诊断**：`uncoveredAcKeys` 现在落进检查记录、任务 `output.verification` 与 reason——生产日志由 `VACUOUS_TEST: test` 变为 `… (uncovered: FR-06)`。这是本批定位花了额外代价的直接原因，故一并修。

**A/B（同一个真实任务 `T10`，工作流 `a0434bc9`）**：

| 变体 | 修复前 | 修复后 |
| --- | --- | --- |
| **V0** 生产形状（真实 `sliceKey=slice-2`） | `failed` / `VACUOUS_TEST` | **`verified` / `expected=pass`** |
| **V0p** 修复前模拟（剥掉 `sliceKey`） | — | `failed` / `VACUOUS_TEST`（复现证据保留） |
| **V1** 显式切片 `acKeys` | `verified` | `verified` |
| **V2** 反向对照（同切片，空证据面） | `VACUOUS_TEST` | **`VACUOUS_TEST`**（**红灯门未被放松**） |
| **V3** 声明了但为空 `acKeys` | `VACUOUS_TEST` | `verified` |

### 2. N-11 · REVIEW 判「不通过」后的出路

**根因（两处，缺一不可）**：

1. **策略层**：批次策略是 `failureStrategy: "RETRY"` + `allowReplan: false`（`packages/eval/src/cli.ts`）。`WorkflowEngine.ts:772` 的 `strategy = deployOverride ?? routed?.strategy ?? workflow.policy.failureStrategy`，而 `routed` 来自**可选注入**的 `failureRouter`——**生产未接线**（全仓只有 `__tests__` 注入过）⇒ `strategy` 就是 `failureStrategy`。REPLAN 分支的闸门是 `strategy === "REPLAN" && workflow.policy.allowReplan` ⇒ **两个字段必须同时改**。这解释了 **全库 `FIX-*` = 0 条**。
2. **代码层**（探针发现，`docs/183` §10.4）：`replan()` 的 retry 任务 `type: source.type`、DEBUG 任务的目标类型末道兜底也是 `source.type` ⇒ **REVIEW 的 replan 就是一个新的 REVIEW**，同一诚实负结论必然重现，逐层嵌套撞深度守卫。

**修法**：

- **策略**：`L1_POLICY_OVERRIDE` → `failureStrategy: "REPLAN"` + `allowReplan: true`；平台侧 `L1_WORKFLOW_POLICY`（`@ai-se/shared`）**同步改动**（两处定义被注释声明为「保持一致」，漂移是本仓反复出现的缺陷类型）。
- **代码（裁定 5(a) 的后半句）**：新增 `fixWorkTargetType(source, workflowTasks)`——源任务已是工作类型则原样；否则取**源任务所在切片**里出现最多的工作类型（同工作流；带 `sliceKey` 时只算同切片），切片内没有则回退 `BACKEND`。`debugTargetType` 的末道兜底与 retry 任务的 `type` 都改用它。`WORK_TASK_TYPES = ["BACKEND","FRONTEND","DATABASE"]` 放 `@ai-se/shared`（**避免第三份定义**）。

**探针 A/B（真实 `WorkflowEngine`）**：

| 变体 | 修复前 | 修复后 |
| --- | --- | --- |
| **P0** 旧策略（`RETRY` + `allowReplan:false`） | `FAILED` / 3 尝试 / **0 FIX 任务** | 同左（对照有效） |
| **P1** 新策略（`REPLAN` + `allowReplan:true`） | `FAILED` / 5 尝试 / 4 FIX 任务（**逐层嵌套 `-REPLAN-2`**） | **`SUCCESS` / 3 尝试 / 2 FIX 任务**（`T-S4-R2-DEBUG-1` + `T-S4-R2-REPLAN-1`，无嵌套） |
| **P2** 对照（REVIEW 成功） | `SUCCESS` / 1 尝试 / 0 | 同左 |

⇒ **判据 18d 达成**（P0 实测「无出路」）；**18e 达成**（P1 给出出路，且只复用既有 FIX 机制，未新增第二套状态机）。

## Architecture Changes

**无新增包、无新增顶层目录、无新增依赖。**

**一处需要登记的口径变化**（`docs/146` §6 规则 8）：**自治 L1 的失败响应由「重试」改为「重规划」**。影响面不止 REVIEW——**任何**任务失败现在都会走 REPLAN：造一个 `DEBUG` 诊断任务 + 一个落在工作类型上的 retry 任务。既往 18 次 E1 run 全部在 `RETRY` 下取得，**与此后批次不再严格可比**（如实登记，不粉饰）。`deployFailureStrategy: "ROLLBACK"` 与 L1-5/L1-6/L1-9 的既有语义**不受影响**（DEPLOY 的 ROLLBACK 在 `failureStrategy` 之前判定）。

**未破坏架构不变量**：未新增第二套 Permission / Approval / Audit / Secret / 错误码；Tool Runtime 仍是唯一执行路径；`WORK_TASK_TYPES` 的判定上移 `@ai-se/shared` 供各消费方共用一份。

## Dependencies

无新增运行时依赖。

## Tests

| 层（`docs/183` §5） | 内容 | 结果 |
| --- | --- | --- |
| **第 1 层：探针定位** | `probe-n10-redlight-scope.ts`（真实 `TaskVerifier` + 真实 dev 库）、`probe-n11-review-verdict-path.ts`（真实 `WorkflowEngine`） | **完成**。**如实标注**：`scripts/` 不在 `tsconfig.include` 与 eslint 范围内，两支探针**未被门禁覆盖**（与既有七支探针同一惯例） |
| **第 2 层：单测** | `taskVerifier.test.ts` **+3**、`WorkflowEngine.test.ts` **+3** | **完成**（各 +3）。**既有断言一字未改** |
| **第 3 层：回归** | `apps/server` **288 用例 / 50 文件**；`workflow-engine` **48 用例 / 3 文件**；`shared` **168 用例**；`eval` **48 用例** | **全绿** |
| **第 4 层：真实批次** | 下一批 E1×3 | **未做**（见 Next Phase Boundary） |
| 共享夹具核对 | 全树 grep 依赖 `L1_WORKFLOW_POLICY` / 出站消息形状的精确断言 | **完成**：`L1_WORKFLOW_POLICY` 的消费方只有 `autonomyPolicy.test.ts`（已同步）与一处注释；**生产无消费者** |
| 门禁 | 各包的 `typecheck && lint && test` | **全绿**（见下） |

## Lint

- `--filter @ai-se/shared` / `@ai-se/workflow-engine` / `@ai-se/eval` / `@ai-se/server` 各自 `lint` → 通过
- 全仓 `corepack pnpm -r run lint` → **通过**（exit 0）

## Typecheck

- 上述四个包各自 `typecheck` → 通过
- 全仓 `corepack pnpm -r run typecheck` → **通过**（exit 0）

## E2E

全仓 `corepack pnpm -r run test`：**1 处 `apps/server` e2e 失败**，判定为**负载偶发，不是本批回归**：

| 项 | 结果 |
| --- | --- |
| 其余 **15 个包** | **全绿**（`agent-core` 246 / `apps/web` 505 / `mcp` 235 / `shared` 168 / `visual` 83 / `eval` 48 / `database` 47 / `workflow-engine` **48** / `browser` 38 / `tool-runtime` 32 / `failure-recovery` 16 / `action-policy` 13 / `evidence` 9 / `sandbox` 8 / `observability` 3） |
| `apps/server` | **1 失败 / 287 通过**——`sliceFlow.e2e.test.ts`「analyze → 切片 → 批准 → 切片 1 工作流 → 自动推进切片 2 → 双切片完成」（`expected 200 "OK", got 404 "Not Found"`） |

**判定依据（实测，不是推断）**：

1. **单独复跑通过**（1 文件 / 2 用例，退出码 0）；
2. **整个 `apps/server` 套件复跑 288/288 全绿**；
3. **该测试走的是成功路径**（分析 → 切片 → 批准 → 双切片完成），**不进入失败响应路径**，而本批的引擎改动**只在失败路径上**（`failureStrategy` / `allowReplan` 与 `replan()` 的类型解析）——对该测试**惰性**；
4. 该现象在本批之前即存在（`docs/127` §8 已记口径；PL-M15 / PL-M16 / PL-M17 收尾时各失败过**不同的**文件）。

**本批未据此改动任何测试**（不掩盖、不放宽断言）。

## Known Issues

1. **口径变化（最重要的一条）**：自治 L1 的 `failureStrategy` 由 `RETRY` 改为 `REPLAN`。**任何**任务失败都改走重规划（造 DEBUG + retry 两个任务）。**L1-8 与既往 18 次 E1 run 不再严格可比**——登记，不粉饰。若要恢复可比性，需要回退本批的策略改动（那会让 N-11 重新无解）。
2. **成本影响未测量**：失败一次现在多两个动态任务；下一批要观察单 run 输入 token 与动态任务数。
3. **`allowRetry: true` 在 REPLAN 下不再可达**（RETRY 分支要求 `strategy === "RETRY"`）。保留它记录重试预算语义；**未**顺手删。`maxRetries: 2` 仍在用（REPLAN 的深度守卫）。
4. **两处 L1 策略定义必须成对维护**（`packages/shared` 与 `packages/eval`），**没有自动一致性检查**；跨包类型/契约的既有分工（`packages/eval` 不导入 workspace 包）使这处重复无法自动消除。已在两处注释互相指认。
5. **「工作类型」概念现在有三处**：本批新增的 `WORK_TASK_TYPES`（shared）、`packages/agent-core` 的 `IMPLEMENTATION_TYPES`（计划期）、`apps/server` 的 `isDevTaskType`（验证门，含 `DEBUG`）。**三处语义不同**（计划期不含 DEBUG、验证门含、本批只用真正交付产品代码的三个），**本批未合并**——登记为后续议题。
6. **N-10 的修复有明确边界**：仅在「任务带 `sliceKey` **且** 无可用 `acKeys`」时生效。带锚点的任务行为与改动前逐字相同。
7. **`FR-06` 那一类根因未单独修**：`parseAcResults` 仍把标题里的 `FR-nn` / `TR-nn` 当 AC 键。本批靠「作用域收窄」绕过了它的后果，**没有**改解析规则（改它会动到 `AC-29`/`AC-30` 这类合法的跨切片作用域）。登记。
8. **探针在门禁之外**（`scripts/` 不在 `tsconfig.include` 与 eslint 范围）。改动探针后必须手工跑一次。
9. **N-11 的修复未在真实批次验证**——探针用的是假 executor。真实链路要等下一批 E1×3。
10. **两项观察维持登记**：`INVALID_AGENT_RESULT` 于 `T-S4-R1`、`EMPTY_FINAL_ANSWER`（判据 18 的 §2.5 四项）。本批**一条都没顺手修**。
11. **N-10 的修复**对本批之前的历史数据**不回写**（`tasks.output.verification` 里的 `VACUOUS_TEST` 原样保留）。
12. **全仓 `pnpm -r run test` 的负载偶发仍然存在**（非本批引入）：本次全仓跑 1 个 `apps/server` e2e 失败（`sliceFlow.e2e`），**单独复跑 2/2 通过、整套复跑 288/288 全绿**，且该用例不进入本批改动的失败路径。判定方法与本仓既有记录一致（`docs/127` §8）。**未据此改动任何测试。**

## Acceptance Result

按 `docs/183` §3 逐条判定：

| 判据 | 期望 | 结果 |
| --- | --- | --- |
| **18a** | N-10 的产生点被指认，且**区分**作用域放大与 `allPassed` 为假 | **达成**——实测 `acFailed=0`（⇒ 不是 `allPassed`），逐键归因指出唯一阻塞键 `FR-06` |
| **18b** | 探针复现 N-10（离线、确定性、零配额、同形） | **达成**——V0 的 `failed`/`VACUOUS_TEST`/`{total:5,passed:5,failed:0}` 与生产读数**逐字相同** |
| **18c** | 修复后转绿，**且不放松红灯门** | **达成**——V0 修复后 `verified`；**V2 反向对照仍判 `VACUOUS_TEST`**；单测第 3 例同断言 |
| **18d** | N-11 的「无出路」被**实测**指认 | **达成**——P0：`FAILED` / 3 尝试 / **0 FIX 任务** / 事件链无 REPLAN |
| **18e** | N-11 的修复给出一条出路，且**复用既有机制** | **达成**——P1：`SUCCESS` / 2 FIX 任务；只改策略 + 复用既有 FIX/REPLAN 机制，**未新增第二套状态机** |
| **18f** | 不引入语义漂移 | **达成**——`DEV_TASK_TYPES` / `maxIterations` / `recursionLimitFor` / 守卫 / PL-M17 补丁 / `POLICY` 均未动；`deployFailureStrategy` 与 L1-5/6/9 语义不变 |
| **18g** | 既有断言逐字不变且全绿 | **达成**——`taskVerifier.test.ts` 既有 **48** 例、`WorkflowEngine.test.ts` 既有 **45** 例一字未改且全绿。**例外一处并如实标注**：`shared/src/autonomyPolicy.test.ts` 的 `failureStrategy` 断言随策略值同步更新（那是**策略值**断言，不是缺陷行为断言，且不在 18g 列举的两个文件内） |
| **18h** | 若为上游产物质量、平台无可修点 → 不阻塞 | **不适用**——两处**均可修**且已修 |

**⇒ 18a–18g 达成；18h 不适用。**

**红线核对**：N-6（`reasoning_content`）/ N-8（`input_tokens > 10M`）/ N-9（外层 `tool_call_requested`）本批**未触碰相关代码**，其既有断言全绿。**红灯检查 / anti-tamper / 写范围审计 / 守卫四者一个都没弱化**（N-10 的 V2 反向对照即为证据）。

**另需如实标注**：**本批的修复尚未在真实批次验证**。真正的检验是下一批 E1×3。

## Next Phase Boundary

**未开始事项（STOP）**：

- **未跑真实批次**。判据 18 的「第 4 层」未取证据。开工前三件事不变：① 确认周配额余量（当前 **220,230,542 / 200,000,000**，窗口 **2026-10-19 07:00 CST** 刷新）；② 先停 `:47558` 上的陈旧实例再重启（`l1-m4-server-launch.sh` 只要端口有应答就**静默复用**）；③ harness 后台任务 + **立即** arm 看门狗（`--heartbeat-min 30 --stall-min 25`），停机**必须** `POST /api/workflows/<id>/cancel`。
- **下一批的批次形态**：**另开一批 E1×3**（新结果目录），**不续跑 l1-m4i**（平台版本已变；`docs/164` §7 第 4 项口径）。**l1-m4i 记「已执行 2/3、因配额中止」，run 3 不补跑。**
- **下一批的头号观察项**：① **失败响应改为 REPLAN 后的成本**（动态任务数、单 run 输入 token）；② REVIEW 的负结论能否真的被 FIX 任务消费（探针用的是假 executor）；③ `VACUOUS_TEST` 是否零出现；④ **原「BACKEND 墙」与本次两处是否都清掉**；⑤ `EMPTY_FINAL_ANSWER` 频率。
- **未做**：未合并三处「工作类型」概念（Known Issues 5）；未改 `parseAcResults` 的 FR/TR 解析（Known Issues 7）；未追查 `EMPTY_FINAL_ANSWER` 与 `INVALID_AGENT_RESULT`（Known Issues 10）；未评估空 `reasoning_content` 的语义影响（`docs/182` KI 2）；未做「重建消息必须保留 `additional_kwargs`」的不变量化。
- **未裁定**：便宜档探针的形态 / 频率（自 `docs/177` 挂起）；`T-DESIGN-S1` 计划粒度。
- **不变量**：不改 `packages/eval` 的夹具与 oracle；不改 `POLICY`（P0 冻结基线）；不改 L1-8 判据口径；不修改任何 `dist/`（除各包正常 `build` 产物）；不修改历史 `tasks` / `agent_runs` / `workflow_events` 行。
- 收口时同步登记账：`docs/183`（§10 实施进度 + §9 裁定链）、`docs/146` §4（PL-M18 行）/ §5、`docs/127` §0 / §6 / §9、`docs/17` 的 L1-8 行。

## 全仓门禁补记

- `corepack pnpm -r run typecheck` → **exit 0**
- `corepack pnpm -r run lint` → **exit 0**
- `corepack pnpm -r run test` → **1 处 `apps/server` e2e 偶发失败**（详见上节：单独复跑 2/2 通过、整套复跑 288/288 全绿、且该用例不进入本批改动的失败路径）。**未据此改动任何测试。**

---

## 勘误追加块（真实批次验证，2026-10-19）

**本块只追加验证结果，正文按历史记录保留不改**（`docs/146` §6 规则 7）。

**被本块回应的原文**：Acceptance Result 末句「**本批的修复尚未在真实批次验证**。真正的检验是下一批 E1×3」，以及 Next Phase Boundary 的第 4 层。

**该批次已跑完**：**L1-M4j**（`packages/eval/results/l1-m4j`），脚本 `l1-m4j-e1-x3.sh`。**已执行 3/3**（run 1 23:59、run 2 01:18、run 3 03:14 收尾，批次 03:44:34 自行退出）。**staging 段 0/3 ⇒ L1-8 仍未达成。**

`run-1.json` 之前还有**一次规划期作废**（22:24:56，`in=0`），产物归档在 `packages/eval/results/l1-m4j/run-1-planning-failed/`（含 `NOTE.md`）；run 1 槽**重开过一次**。

### N-10 / N-11 的真实链路验证

| 项 | 结果 |
| --- | --- |
| **N-11 的修复被真实使用** | **是**——本批产出 **18 个动态任务**（9 `DEBUG` + 9 `BACKEND`），而**改动前全库 `FIX-*` = 0 条**。11 个 `FAILED` 任务里 **3 个被 replan 干净救回**（`T-01` / `T-05` / `T-10` 的 `-REPLAN-1` 均 SUCCESS） |
| **M1 的工作类型回退生效** | **是**——**每一个** replan retry 任务都是 `BACKEND`；其中 `T-01` 源任务类型是 `DESIGN`（非工作类型），其 retry 仍落在 `BACKEND` |
| **N-10 的 headline** | **`VACUOUS_TEST` 事件 0 次、`EVIDENCE_MISSING` 事件 0 次**（78 个 agent run）。**如实标注：这是弱证据**——只能说本批没有触发该判定，不能证明修复在「条件被行使」时正确（那要探针，本批没跑） |
| **红线四项** | **一个都没松**——红灯检查、anti-tamper、写范围审计、守卫的既有断言全绿，且批次数值无异常 |
| N-6 / N-7 / N-9 | **全批零**（`reasoning_content` 0、`Recursion limit` 0、`tool_call_requested` 0） |
| N-8 | **未增**（`>10M` 仍 11 条；本批单 run 最大 **5,039,859**） |

### 但暴露了一个**新缺陷：N-12**（replan 的「已解决」只认一层，未立项）

`WorkflowEngine.ts:532-538` 要求 `FAILED` 任务的**直接** `resolvedByTaskId` 指向 `SUCCESS`。本批实测：

- **5 个 FAILED 任务的直接解析者不是 SUCCESS**（未解决）——例如 `T-05`（run 2）的解析者是 `T-05-REPLAN-1`(FAILED)，而**更深一层**的 `T-05-REPLAN-1-REPLAN-2` 是 **SUCCESS**。
- **run 2 是纯 N-12 致死**：抢救在第二层成功，但 `T-05` 判「未解决」⇒ `WORKFLOW_TASK_FAILED: "Workflow contains unresolved failed tasks"` ⇒ 链停在 slice-1。
- runs 1/3 里最深那层本身就失败（终态 `T-08-REPLAN-1-REPLAN-2`，无解析者）——workflow 无论如何会失败，但 `T-08` / `T-08-REPLAN-1` 的「未解决」是**同一条缺陷**。

**这条规则此前不可达**（REPLAN 分支在 PL-M18 之前关着），是 PL-M18 解锁它才露出来的。**判据 18a–18g 的达成结论不受影响**——18e 只要求「给出一条出路」，而实测它确实给出了（3 次干净救回），N-12 是这条路**走到第二层时**的记账缺陷。

### 成本（口径变化的第一份实测）

| 项 | 值 |
| --- | --- |
| 全批 | 输入 **53,977,515** / 输出 1,195,046；78 个 agent run |
| 逐 run | run 1 23,827,508 · run 2 11,703,597 · run 3 18,446,410 |
| 对照 L1-M4i | run 1 **13.9M** → 本批 run 1 **23.8M**（**+71%**；运行也更长，83 vs 51 分钟） |
| 周配额 | 收尾 **274,208,057**（= 220,230,542 + 53,977,515，**逐位吻合**）——**上限被用户授权抬到 400,000,000**，**原 200M 止损线已越过** |
| 未计部分 | 那次**规划期作废**（`in=0`）——规划 token 不进取守读数，**偏差未量化** |

**⇒ Known Issues 1（口径变化）与 2（成本影响未测量）都已取到第一份实测**：口径变化被真实承载体现在「失败即 replan」上，成本确实上升，且**新增了一层「replan 记账只有一层」的缺陷（N-12）**。


---

## 勘误追加块（N-12 已修，2026-10-19）

**本块只追加状态更新，上文按历史记录保留不改**（`docs/146` §6 规则 7）。

**被本块回应的原文**：上一块的小节标题「但暴露了一个**新缺陷：N-12**（replan 的「已解决」只认一层，**未立项**）」。

**N-12 已于 2026-10-19 立项并修复**：任务书 **`docs/185`**（里程碑 PL-M19）、实施记录 **`docs/186`**。判定改为**沿 `resolvedByTaskId` 链走到头、尽头是 SUCCESS 才算已解决**，`retry()` 与 `advanceOnce()` 合并为同一处谓词（`packages/workflow-engine/src/resolution.ts`）。探针 A/B：**第二层抢救（生产形态）`FAILED` → `SUCCESS`**，而单层对照与「链尽头仍失败」两个不变量**未动**。

**⚠️ 与本块上文的一致性**：上一块把 N-12 记作「当前最可能拦住链的一处」——**该判断随修复失效**；且**修的是记账，不是救援能力**，L1-8 不会因此达标（run 1 / run 3 死于 `maxRetries` 预算耗尽，与 N-12 无关）。
