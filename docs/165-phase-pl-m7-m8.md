# 165 · PL-M7 / PL-M8 实施记录

> 状态：**已实施并收尾**（2026-10-16）。用户同日裁定「**都按你的建议，开工 PL-M7 和 PL-M8**」——即 `docs/164` §7 六项待裁定全部按推荐值接受；实施中据实测提出的 §2 偏差 1（7b 由硬错误降为观察项）**经用户 2026-10-16 追加确认「按观察项」**，登记账已按此收尾。
> 依据：`docs/164`（任务书，§2 基线事实 / §3 判据 / §4 裁定 / §7 待裁定）、PL-M4 run 1 实测（`packages/eval/results/l1-m4/run-1.json` + dev 库只读实查）、`docs/126` §7、`docs/127` §5、`docs/146` §6 规则 7/8、`AGENTS.md` §9/§10。
> 性质：**本文件是实施结果正本**；任务书 `docs/164` 的方案部分仍有效，**被本文件 §2 更正的 3 处以其为准**（`docs/146` §6 规则 7：不追改历史记录，更正以追加块形式落在这里）。

## Modified Files

| 文件 | 改动 |
| --- | --- |
| `packages/agent-core/src/planning/validateTaskAnchors.ts` | **新增**。`validateTaskAnchors`（7a 越界引用，硬错误）+ `findUnanchoredTestTasks`（7b 无锚点 TEST 任务，观察项） |
| `packages/agent-core/src/planning/validateTaskAnchors.test.ts` | **新增**。10 例（7a 6 例 / 7b 3 例 / run 1 回归复现） |
| `packages/agent-core/src/planning/planningTaskAnchors.test.ts` | **新增**。2 例图级联合验证（7b 只发事件计划仍通过 / 7a 越界拦截） |
| `packages/agent-core/src/planning/acceptanceCriteria.ts` | 新增导出 `canonicalAcKey`（自 `validateTaskGraph.ts` 移入）与 `canonicalFrKey` |
| `packages/agent-core/src/planning/validateTaskGraph.ts` | 删除本地 `canonicalAcKey`，改为从 `acceptanceCriteria` 导入（**行为逐字不变**） |
| `packages/agent-core/src/planning/PlanningGraph.ts` | 接入 7a 错误（`errors[]` 既有通道）与 7b 观察事件 `PLAN_TEST_TASK_UNANCHORED` |
| `apps/server/src/services/taskVerifier.ts` | PL-M8：新增模块级 `taskAcKeys` / `sliceAcKeys`；`taskTestScope(task, fallbackAcKeys)`；新增 `sliceScopeFallback(workflow, task)`；`maybeSliceBoundaryCheck` 改用 `sliceAcKeys`（口径统一） |
| `apps/server/src/__tests__/taskVerifier.test.ts` | +3 例（PL-M8 兜底生效 / 兜底不可用 / 已声明锚点逐字不变） |

## Implementation

### PL-M7 计划期任务锚点（`packages/agent-core`）

**7a（硬错误）**：非最终切片的任务**声明**的锚点必须落在切片范围内——AC 锚点须在 `selectAcceptanceCriteriaForSlice(criteria, frKeys, {isFinalSlice:false})` 的集合内，FR 锚点须在 `slice.frKeys` 内。这是既有 `GLOBAL_AC_OUTSIDE_FINAL_SLICE` 的**一般化**（后者只拦全局 AC，本条拦全部越界引用）。错误信息 `PLAN_ANCHOR_OUT_OF_SCOPE` **列出范围内清单**，使修复是机械的而非猜测。

**7b（观察项）**：非最终切片里没有声明任何锚点的 TEST 任务 → 发 `PLAN_TEST_TASK_UNANCHORED` 事件（含 `taskId` 与范围内清单），**不产生错误、不阻断计划**。理由见 §2 偏差 1。

**退路口径与既有校验器逐字一致**：`isFinalSlice !== false`（最终切片 / 无切片场景）或 `criteria` 为空（无编号 AC 记录，此时平台整体处于 `acProtection = none`）→ 不校验。

**接入位置**：`PlanningGraph` 既有校验块内、`backfillTaskPlanAcKeys` 与 `autoFixTaskPlan` **之后**（`PlanningGraph.ts:519-540`）——必须对「回填+自动修复之后的计划」判定，否则会对回填前的临时状态报错。

### PL-M8 门禁判定作用域兜底（`apps/server`）

dev 任务（`isDevTaskType`）**未声明** acKeys 时，`test` 检查的作用域回退为**本切片 AC 范围**（同切片全部任务声明的 acKeys 去重并集）。判定语义**逐字复用**既有 `command-filter` / `result-filter`（`taskVerifier.ts:592-604`、`907-914`），未改任何判定规则——缺的本来只是「给无锚点任务一个作用域」。

**严格放宽（可证）**：已声明 acKeys 的任务路径**逐字不变**（`taskTestScope` 早返回自身键，`kind: "task"`），只有无锚点任务新增了作用域来源；判定式 `achieved = result.success ∨ (范围内 AC 结果非空且全过)` 中 `result.success` 不变，故**通过集只增不减**。切片范围为空（无 AC 记录的项目）→ 维持不作用域（全量套件），即今日行为。

**「切片范围」只有一份定义**：`sliceAcKeys` 同时被 `sliceScopeFallback`（PL-M8）与 `maybeSliceBoundaryCheck`（F1-5/PL-M2 边界绿灯）使用，后者原地的并集构造已删除。

**「全量套件全绿」的归属**：交还 **AC-30**（全局 AC，最终切片；隐藏 oracle 判 `pnpm test` 全绿，`packages/eval/fixtures/E1/oracle.mjs:605-622`），门禁不重复承担。

## Architecture Changes

- **无新增包 / 无新增顶层目录 / 无跨包契约变更**（未动 `packages/shared`）。
- **新增事件类型** `PLAN_TEST_TASK_UNANCHORED`，走既有 `workflow_events` 通道——**不新增表、不新增错误码体系**（`AGENTS.md` §10）。payload 只含 `stage/attempt/taskId/inScope`，**不含 `errorCode`**，因此不会被 `collectFailureLayers` 误计入规划失败层。
- **同包内换家**：`canonicalAcKey` 从 `validateTaskGraph.ts` 移入 `acceptanceCriteria.ts`（AC 域），行为逐字不变。
- **已知重复未处理**：`apps/server/src/services/taskVerifier.ts:173` 仍有**自己的一份** `canonicalAcKey`。跨包合并（上移 `@ai-se/shared`）属独立议题，本次按「最小改动」未动——**如实登记，见 Known Issues 3**。

## Dependencies

无新增依赖。

## Tests

| 层 | 内容 |
| --- | --- |
| 单测（PL-M7 7a） | 越界 AC 锚点（T-11/AC-25、T-05/AC-30 双越界）→ 2 错；范围内锚点四种写法（`AC-04` / `FR-7` / `[FR-009]` / `ac-4`）→ 0 错；越界 FR 锚点（`FR-8`）→ 1 错；无声明不报；最终切片与无切片模式不变；`criteria` 为空跳过；范围为空跳过 |
| 单测（PL-M7 7b） | run 1 slice-1 形状（T-10 BACKEND 忽略、T-11 TEST 报出）；已锚定不报；仅含不可解析条目（`FR-7-1`）视为无锚点；最终切片 / 无编号 AC → 静默 |
| 单测（PL-M8） | **核心判据**：无锚点 BACKEND + 切片内他人声明 `AC-04` → 命令作用域化（`command-filter`，`scopedAcKeys=["AC-04"]`），**全量 `npm run test` 从未执行**，verdict `verified`（修前为 `failed`）；兜底不可用 → 维持全量判定（`failed`）；已声明锚点任务作用域 `["AC-01"]` 不并入切片并集 |
| 图级联合（PL-M7） | 走 `runPlanningGraph` + `s1v4Fixture`：无锚点 TEST 任务 → 发 `PLAN_TEST_TASK_UNANCHORED` 且**计划仍通过**（无 `TASK_DAG_VALIDATION_FAILED`）；声明 `AC-99`（属 FR-99，范围外）→ `PLAN_ANCHOR_OUT_OF_SCOPE` 进入 `TASK_DAG_VALIDATION_FAILED` 载荷并最终失败 |
| 回归 | `planningApi.e2e` / `sliceFlow.e2e` 全绿（见 §2 偏差 1 的 A/B 实测）；run 1 slice-1 实值计划回放（见 §2 补充证据） |

## Lint

`corepack pnpm --filter @ai-se/agent-core lint` → 0；`--filter @ai-se/server lint` → 0；全仓 `corepack pnpm -r run lint` → **0**。

## Typecheck

`corepack pnpm --filter @ai-se/agent-core typecheck` → 0；`--filter @ai-se/server typecheck` → 0；全仓 `corepack pnpm -r run typecheck` → **0**。

## E2E

- `corepack pnpm --filter @ai-se/agent-core test` → **211/211 通过（33 文件）**
- `corepack pnpm --filter @ai-se/server test` → **275/275 通过（50 文件）**
- 全仓 `corepack pnpm -r run typecheck && lint && test`：typecheck ✓ / lint ✓；test 首轮 `apps/server` 有 1 例失败——`deliveryApi.e2e.test.ts`「runs CI, staging, E2E, approval, production, and traceability」**超时**。**隔离复跑该文件 2/2 通过**，且 `--filter @ai-se/server test` 单包全量 275/275 通过 → 属 `docs/145` #7 / `docs/146` §5 已登记的**负载敏感抖动**（全仓并行时该长链 e2e 超时），**非本次改动所致**。**第二轮全仓 `-r run test` → exit 0，全部 16 个 workspace 包通过**（agent-core 211/33、apps/server 275/50、apps/web 505/41、mcp 235/24、shared 89/9、database 47/10、visual 83/6、eval 41、browser 38/8、tool-runtime 32/3、failure-recovery 16、action-policy 13、evidence 9、sandbox 8、workflow-engine 45/3）。
- 关键回归：`planningApi.e2e` / `sliceFlow.e2e` 均全绿（见 §2 偏差 1 的 A/B 实测）。

## §3 收尾核对

- 全仓 `-r run typecheck` → **0**
- 全仓 `-r run lint` → **0**
- 全仓 `-r run test` → **0**（第二轮；首轮唯一失败为已登记抖动，隔离复跑通过）
- 登记账更新：**已完成**（2026-10-16 收尾）
  - `docs/146`（正本）：§3 的「计划器不生成实现任务」行追加 ①–⑥ 更新块（含对 `docs/160` 表述的更正）、新增**三行**登记（PL-M4 run 1 的两项附带发现 / PL-M7 7b 的残余风险 / `canonicalAcKey` 跨包两份副本）、§2.2 新增「PL 系列」行并更正「登记发现处置」行的「6 修复」措辞、§3 归位说明补记、§4 新增「本批裁定（2026-10-16）」表（六项 + 7b 严重度 + 看门狗工具）、§5 新增本次门禁与用例数基线、§1 一屏总览补记、文首日期。
  - `docs/127`（活文档）：文首日期、§0 一句话状态、§5 新增第 10 / 11 条登记并**就地更正** F 期处置注记的第 1/2/4 条措辞、§9 下一步。
  - `docs/126`（历史记录，**冻结**）：**只追加**「勘误块（2026-10-16）」，原文一字未改（`docs/146` §6 规则 7）。
  - `docs/17`（清单）：自治 L1 节的标题行、L1-8 行、实施状态块各追加 PL-M4 / PL-M7 / PL-M8 记账；**L1-8 维持未勾**（不因工具链修好而改变）。
  - `docs/158`（PL 系列任务书）：状态行标注 PL-M4 中止 + 本批另立任务书。
  - `docs/164` / 本文件：状态行与判据强度标注。

## §2 对 `docs/164` 的更正（3 处，均据实测）

### 偏差 1：7b 从**硬错误**降为**观察项**（重要）

`docs/164` §3 把 7b（TEST 任务必须带锚点）定为硬错误。实施时按 A/B 实测发现该设定**会拒掉合法计划**：

| 步骤 | 结果 |
| --- | --- |
| 接上 7b 硬错误 → 重建 `agent-core` → 跑 `apps/server/src/__tests__/planningApi.e2e.test.ts` | **失败**（`expected false to be true`：关口 1 批准后需求 30s 内到不了 `ANALYZED`） |
| 摘掉 PL-M7 接线（临时，仅做实验）→ 重建 → 同一测试 | **通过** |
| 复接线（7b 降为观察项）→ 重建 → 同一测试 | **通过** |

根因：`ScriptedPlanningModel` 的 todo 夹具（`packages/agent-core/src/planning/ScriptedPlanningModel.ts` 的 `task_planning`）里，`TASK-005`（TEST）**没有 `acKeys`**。该夹具是有编号 AC 记录的，故 7b 生效 → 计划被判失败 → 修复轮耗尽 → 需求永远不到 `ANALYZED`。

**这不是夹具不真实，而是「TEST 任务不逐条枚举 AC」是常见形状**：PL-M4 run 1 的 slice-1 三个 TEST 任务里 **2 个**无锚点。把 7b 做成硬错误的代价是**把「链死在 slice-1」换成「计划根本出不来」**——而 run 1 的规划已两次 `SLICE_PLANNING_FAILED` 才勉强收敛，后者是更差的失效模式。

**处置**：7b 以 `PLAN_TEST_TASK_UNANCHORED` 事件形式**只观察、不阻断**，先积累实测证据（每个非最终切片、每次尝试都记），再据实测裁定是否收紧。7a 维持硬错误（零误报：锚点是规划器自己写的）。

**残余风险（如实登记）**：无锚点的 TEST 任务仍可能把切片外的交付物写进本切片（run 1 的 T-11 即此）。PL-M8 已保证它**不再把本切片的任务判死**；但那个切片外的测试文件会留在工作区，直到最终切片的 AC-30（`pnpm test` 全绿）由 oracle 判定时才可能暴露。

**补充证据（决定性，实测）**：把 run 1 slice-1 的**库中实值计划**（12 个任务的 `type` / `input.acKeys`，AC 记录取 AC-04 / AC-25 / AC-30）直接喂给已构建的校验器：

```
PL-M7 7a errors = []
PL-M7 7b unanchored TEST tasks = [T-03, T-04, T-11]   (inScope: AC-4; FR-9, FR-7)
```

即：**PL-M7 对 run 1 的计划零报错**——因为 T-11 什么都没声明，7a 无输入可判。**PL-M7 单独并不能阻止 run 1 的失败；真正修好它的是 PL-M8。** PL-M7 的价值是预防性的（拦住**已声明**的越界引用，以及用事件积累「无锚点 TEST 任务」的实测频率），不应被表述为「已堵住 run 1 的根因」。

### 偏差 2：PL-M8 的兜底**只在任务未声明 acKeys 时**生效

`docs/164` §3 有一行写「该任务声明的 acKeys 非空时，作用域 = 自身 acKeys ∪ 切片并集」。**那一行会收紧而非放宽**：在 `command-filter` 模式下作用域变大会让命令跑更多测试，`last.success` 更易为假 → 可能把**改动前通过**的任务判死，破坏 §4 裁定 3 所依赖的「严格放宽」性质。且该职责与切片边界绿灯检查（F1-5/PL-M2）重复。

**处置**：只保留兜底。已声明锚点的任务**逐字不变**（`taskVerifier.test.ts` 新增第 3 例专门钉住这一点）。

### 偏差 3：`canonicalAcKey` 换家

为让 PL-M7 复用 AC 键规范化的**唯一**一份实现，把它从 `validateTaskGraph.ts` 移到 `acceptanceCriteria.ts`（AC 域，同包）。行为逐字不变（现有测试覆盖）。`apps/server` 的那一份**未动**（见 Known Issues 3）。

## Known Issues

1. **7b 未阻断（偏差 1 的代价）**：切片外的 TEST 任务仍可能被写进非最终切片，只是不再判死本切片的任务。收紧与否需实测证据（事件已开始积累）。
2. **PL-M4 run 1 的两项附带发现未处理**（用户裁定另立项）：N-1（slice-1 三个 TEST 任务全部 `unavailable`，红灯检查一次未跑）、N-2（无任何 agent 能写仓库根，计划却派了「编写 README」任务）。
3. **`canonicalAcKey` 在 `apps/server` 仍有一份副本**（`taskVerifier.ts:173`）。与 `agent-core` 的同名实现并存——`docs/160` 已把「重复定义必然漂移」记为本仓库的缺陷成因类型。上移 `@ai-se/shared` 属独立议题。
4. **PL-M4 记账**：runs 2/3 **未跑**（用户裁定）。PL-M4 记为「已执行 1/3，因发现确定性缺陷中止」，修完后**另开一批** E1×3（受周配额纪律约束，落在下周窗口）。`docs/17` 的 L1-8 维持「未达成」。
5. **全仓门禁的既知抖动**：`apps/server` 的 `*.e2e.test.ts` 存在负载敏感的间歇失败（`docs/145` #7 / `docs/146` §5）。本次实测到 `budgetApi.e2e` 在全量运行时失败、隔离运行通过（抖动），而 `planningApi.e2e` / `sliceFlow.e2e` 隔离**也**失败（真回归，已由偏差 1 修复）。

## Acceptance Result

**PASS**。`docs/164` §3 的两条核心判据均达成：PL-M8 的注入式复现用例（修前 `failed` → 修后 `verified`）与 PL-M7 的 run 1 slice-1 回归复现用例均通过；两包与全仓 `typecheck` / `lint` / `test` 全绿（全仓 test 第二轮 exit 0）。**§2 的 3 处偏差已如实记录**，其中偏差 1（7b 降为观察项）改变了 `docs/164` 的判据强度——**用户 2026-10-16 追加确认「按观察项」**，登记账已按此收尾。

## Next Phase Boundary

**未开始事项（STOP）**：

- **不跑 PL-M4 的 runs 2/3**（用户裁定）。**下一步是另开一批 E1×3**（PL-M4 记「已执行 1/3、因发现确定性缺陷中止」），受周配额纪律约束（默认一周最多一个 E1×3 批次，`docs/127` §8）→ 自然落在下周窗口。**开工前须确认周配额余量。**
- 不处理 PL-M4 run 1 的两项附带发现（N-1 测试任务验证不可用 / N-2 仓库根无写权限）——用户裁定另立项，已登记于 `docs/146` §3。
- 不合并 `apps/server` 的 `canonicalAcKey` 副本（已登记于 `docs/146` §3，见本文 Known Issues 3）。
- **不收紧 7b**（等 `PLAN_TEST_TASK_UNANCHORED` 事件的实测频率）。
- 不修改 `packages/eval` 的夹具与 oracle；不改提示词。
