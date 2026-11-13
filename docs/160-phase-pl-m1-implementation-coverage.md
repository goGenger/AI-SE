# 160 · 计划期实现覆盖校验实施记录（PL-M1）

> 日期：2026-10-16 ｜ 类型：**计划器根因修复 · 核心里程碑**（`docs/158` §3 的 PL-M1；用户 2026-10-16「开工 PL-M1」授权）
> 依据：`docs/158`（任务书 + §1.2 缺口 + §1.4 数据 + §6 第 1/3 项推荐值）、`docs/155` M4 追加块（归因正本）、`docs/17`「自治 L1」节（L1-8 判据）、`AGENTS.md` §9。
> 范围：**只做 PL-M1**。**PL-M2 / PL-M3 / PL-M4 未开工**（切片边界绿灯锚点 / 修复任务类型合法性 / 批次复验）。

## Modified Files

**`packages/agent-core/src/planning/`**
- `validateImplementationCoverage.ts`（**新增**）：新校验器——切片范围内每个 Must AC 必须至少被一个实现类任务（BACKEND / FRONTEND / DATABASE）引用。
- `validateImplementationCoverage.test.ts`（**新增**，12 条）：判定矩阵 9 条 + 回归复现 3 条。
- `slice5Run3Fixture.ts`（**新增**）：run 3 slice-5（`e6c513e1`）的**真实计划快照**——15 个任务（type / acKeys / 23 条依赖边）+ E1 全量 30 条 AC，全部为 2026-10-16 平台库实查值。
- `validateTestFirstPlan.ts`：`IMPLEMENTATION_TYPES` 由模块私有改为**导出**（两个校验器共用一份定义，并注明它与 `apps/server` 的 `DEV_TASK_TYPES` 不是同一口径）。
- `PlanningGraph.ts`：接线——新增 `implementationCoverageErrors`，汇入既有 `errors[]`（三处：import、校验调用、`errors` 数组合并）。
- `planningFinalSliceScale.test.ts`（**改**）：`bigPlan()` 5 → 6 任务、`smallPlan()` 3 → 4 任务（各补一个 BACKEND 任务覆盖 AC-24/AC-30）；阈值与规模断言随之由 3 → 4、5 → 6。原因见 §Known Issues 第 2 条。

**文档**：本文件；`docs/158` §9、`docs/146` §3、`docs/127` §9、`docs/155`（追加勘误块）。

## Implementation

### 缺口（`docs/158` §1.2 的代码核对结论）

三个计划期校验器**都不要求实现任务**，错误却汇入同一个数组 `errors[]`（`PlanningGraph.ts`），为空即接受计划：

| 校验器 | 它要求什么 | 为什么放行了缺陷计划 |
| --- | --- | --- |
| `validateAcceptanceCoverage` | 每个 AC 至少被**任意**一个任务的 `acKeys` 引用 | 收集 `referenced` 时**不分任务类型**——TEST 任务算数 |
| `validateMustAcTestCoverage` | 每个 Must AC 至少被一个 **TEST** 任务引用 | 它**只要测试**——这个校验器强化了缺口 |
| `validateTestFirstOrder` | 实现任务与 TEST 任务共享 AC 时，实现任务必须（传递）依赖 TEST 任务 | 只遍历**实现类任务**；没有实现任务时循环不执行，**空转通过** |

**系统主动要求测试任务，却从不要求实现任务。** 而 TEST 任务的验证检查是**红灯检查**（`expectation: "fail"`，`taskVerifierRules.ts:95-100`）——测试确实红了 → 检查通过 → 任务判 SUCCESS。没有实现任务把红灯转绿，切片边界绿灯检查又因无实现锚点而不触发，交付链一路走到 CI 才炸。

### 改动

1. **新校验器只报错，不自动造任务**（`docs/158` §6 第 3 项裁定 A）。它与 `validateMustAcTestCoverage` **严格对称**：同样的 `selectAcceptanceCriteriaForSlice` 作用域、同样的「criteria 为空则跳过」退路、同样的 `isFinalSlice` 处理，错误句式也同构（`Must acceptance criterion X has no implementation task coverage.`）。两条合起来才闭环：一条管「Must AC 有测试覆盖」，一条管「Must AC 有实现覆盖」。
2. **粒度 = 每个 Must AC**（`docs/158` §6 第 1 项裁定 A）。Should / Could 不设硬门，报错面不过宽。
3. **不新建第二套校验通道**：错误汇入既有 `errors[]`，交给既有 LLM 修复轮（`REPAIR_PROMPT` + `PLANNING_REPAIR_REQUESTED`）重规划。`autoFixTaskPlan` 的白名单明确「不增删任务、不改 AC 映射」，确定性层不越界。
4. **共用一份实现类类型表**：`IMPLEMENTATION_TYPES` 从 `validateTestFirstPlan.ts` 导出。两个校验器各自复制一份必然漂移，而漂移正是本仓库 PL-M5 那类缺陷的成因类型。

## Architecture Changes

- 计划期校验从「**测试覆盖**单侧」变为「**测试覆盖 + 实现覆盖**双侧闭环」。
- 「谁是实现类任务」在 `agent-core/src/planning/` 内成为**单一导出定义**，由测试先行校验与实现覆盖校验共用。**注意它与 `apps/server` 的 `DEV_TASK_TYPES`（多一个 `DEBUG`）不是同一口径**：后者是切片边界绿灯的锚点判定（计划外修复任务也算），前者是计划期「谁负责把红灯转绿」——已在代码注释中写明，避免日后被误当成重复定义而合并。
- 未新增校验通道、未新增错误码、未改提示词。

## Dependencies

无新增（含 devDependencies）。新夹具是纯 TypeScript 常量，不引入数据库依赖。

## Tests

| 范围 | 结果 |
| --- | --- |
| `@ai-se/agent-core` test | **178/178 通过（30 文件）**（改动前 177，其中 3 条失败；净 +1 条） |
| 全仓 `corepack pnpm -r --no-bail run test` | **16 个包全绿，退出码 0**（`apps/server` 266/266、`apps/web` 505/505、`packages/mcp` 235/235、`packages/agent-core` 178/178，余同） |
| 全仓 `corepack pnpm -r run typecheck` | **通过** |
| 全仓 `corepack pnpm -r run lint` | **通过** |

**门禁抖动如实记录**：`apps/server` 全量在三次运行中两次失败、一次全绿——第一次是 `workflowTrace.e2e.test.ts`（**整个文件** Failed Suite，无断言失败），第二次是 `v1GoldenScenario.e2e.test.ts` 的「server restart」用例（`Error: waitFor timed out`，即 `docs/149` / `docs/155` 记录过的同名抖动），第三次 `--no-bail` 全量 **266/266 通过**。两个文件**单独复跑均通过**。属 `docs/145` #7 / `docs/146` §5 已登记的负载敏感抖动，**本次未修，如实记录**；注意**抖动的文件会在不同运行间漂移**（本次新观察到 `workflowTrace` 也会抖），这一点此前未登记。

## Lint

`@ai-se/agent-core` 退出码 0；全仓 `-r run lint` 16 个包全部 Done。

## Typecheck

`@ai-se/agent-core` 退出码 0；全仓 `-r run typecheck` 通过（该命令会重建相关包的 `dist`，构建产物未读取）。

## E2E

**回归复现（PL-M1 的核心判据，`docs/158` §3）**——把 run 3 slice-5 的真实计划喂给校验链：

| | 结果 |
| --- | --- |
| **修前**：`validateAcceptanceCoverage` / `validateTestFirstOrder` / `validateMustAcTestCoverage` | **三条全部返回空**——这正是该计划首轮通过、修复轮 0 轮的原因 |
| **修后**：`validateImplementationCoverage` | **报出 5 条**：AC-24 / AC-25 / AC-26 / AC-29 / AC-30 无实现覆盖 |

夹具为库中实值（2026-10-16 实查）：`tasks` 15 行（编号 `TASK-01…19`，**缺 04 / 05 / 06 / 13**，与 `docs/155` 的归因逐字一致）、`task_dependencies` 23 条边、`requirement_acceptance_criteria` 30 条（AC-24/25/26/29/30 全为 **Must**，验证方式分别为容器运行 / 容器运行 / 容器检查 / 日志扫描 / 命令执行+测试名解析——**全部命中全局性 AC 判定**，故在最终切片范围内）。四个实现任务（TASK-07/08/09/10）的 AC 覆盖并集恰为 `{AC-19, AC-20, AC-27, AC-28}`。

**边界（如实）**：本夹具只喂**计划期 AC 覆盖/顺序**这四条校验器（它们共用 `TestFirstTask` 形态）。`validateTaskGraph` / `validateAcKeysPresence` 需要完整 `TaskPlanItem` 形态，不在本夹具范围内——该计划在真实运行中已通过它们（`docs/158` §1.4：计划首轮通过、任务 49/53 SUCCESS）。

## Known Issues

1. **修复轮的收敛性未验证**。PL-M1 让缺陷在**计划期可发现**，但「LLM 修复轮能否据此补出实现任务」只有真实批次能测。若修复轮不收敛，计划的结局从「CI 失败」变成「规划失败」——**层级更对，但 staging 段仍不会是「是」**。`REPAIR_PROMPT` 的措辞是「fix the named fields or DAG problems only」，本阶段**未改提示词**（`docs/158` §2 明确「重写计划器提示词」不在范围内）。**这是 PL-M4 要测的东西，本阶段不作承诺。**
2. **两个既有夹具编码了同一缺陷，本次一并修正**。`planningFinalSliceScale.test.ts` 的 `bigPlan()` / `smallPlan()` 原先只让 TEST / BUILD 任务引用全局性 AC-24/AC-30，**没有任何实现类任务覆盖它们**——与 run 3 slice-5 是同一个缺口。新校验器上线后这两个夹具立即报错（这正是它该做的）。按「夹具是错的、不是校验器过严」处理：各补一个 BACKEND 任务（`T-106`，AC-24/AC-30，依赖 TEST 任务 `T-104`，满足测试先行），`taskCount` 5 → 6、3 → 4，enforce 阈值 3 → 4。**这是本次唯一的既有断言改动，如实记录。** 同批的 `nonFinalPlan()`（非最终切片）与 `PlanningGraph.test.ts` 全部原样通过。
3. **`validateTestFirstOrder` 未传 `isFinalSlice`（既有不对称，未改）**。`PlanningGraph.ts` 里 `coverageErrors` 与 `mustCoverageErrors` 都传了 `isFinalSlice`，`testFirstErrors` 只传 `frKeys`。新校验器按对称要求**照 `mustCoverageErrors` 处理（传 `isFinalSlice`）**。该不对称先于本次改动存在，**未修**——修它会改变既有计划的报错面，属独立判断。
4. **只覆盖 Must**。Should / Could 的 AC 无实现覆盖不报错（`docs/158` §6 第 1 项裁定 A）。AC-22（Should）在 run 3 slice-5 中同样无实现覆盖，**新校验器不会报它**——这是刻意的。
5. **`IMPLEMENTATION_TYPES` 与 `DEV_TASK_TYPES` 口径不同，是刻意的**（见 Architecture Changes）。若日后有人把两处「统一」，会让切片边界锚点接受计划外的 `DEBUG` 任务作为实现锚点，或反过来让计划期拒绝 `DEBUG`——两种后果都是缺陷。
6. **门禁抖动的既有口径不变**（`docs/146` §5）；本次新观察到**抖动文件会漂移**（`workflowTrace` 亦会），已记入 Tests 节。
7. **未做（红线）**：未新建第二套校验/修复通道；未改 L1-8 判据口径；未改提示词；未动 `packages/eval`；未修改任何 `dist/`。
8. **一处文档与代码的既存出入（如实报告，未改文档）**：`AGENTS.md` §6 把 `agent-core` 列为「集中式测试的包（测试放 `src/__tests__/`）」，但 `src/planning/` 的实际惯例是**测试与源码同目录**（`validateAcceptanceCoverage.test.ts` / `validateTestFirstPlan.test.ts` / `PlanningGraph.test.ts` 等 10 余份皆然；`src/__tests__/` 里放的是 e2e）。按 §1「代码优先」与 §6「新文件跟随所在包的既存惯例」，新测试跟随**同目录惯例**——这也正是 `docs/158` §4 验证分层指定的位置。**`AGENTS.md` §6 该句与代码不符，本次未改该文件。**

## Acceptance Result

| 判据（`docs/158` §3 PL-M1） | 判定 | 证据 |
| --- | --- | --- |
| AC 仅被 TEST 覆盖 → 报错 | **达成** | 单测：TEST-only / 完全无覆盖 / BUILD·DEPLOY·REVIEW·DEBUG·ANALYSIS·DESIGN 六类非实现类型均报错 |
| AC 被 TEST + 实现覆盖 → 不报错 | **达成** | 单测：BACKEND / FRONTEND / DATABASE 三类各自通过；TEST + BACKEND 组合通过 |
| `criteria` 为空 → 不报错（保持既有行为） | **达成** | 单测 |
| 切片范围 / 最终切片全局性 AC 归属沿用既有语义 | **达成** | 单测：`frKeys` 作用域 + `isFinalSlice` 真/假两向 |
| Should AC 不设硬门 | **达成** | 单测 |
| **回归复现：修前零报错、修后报出 AC-24/25/26/29/30** | **达成** | E2E 节两条，均以 run 3 真实计划为夹具 |
| 错误汇入既有 `errors[]`（不新建通道） | **达成** | `PlanningGraph.ts` 仅三处改动：import / 校验调用 / 数组展开 |
| 只报错、不自动造任务 | **达成** | 未改 `autoFixTaskPlan`；`docs/158` §6 第 3 项裁定 A |

**阶段判定：PL-M1 达成。** `docs/158` 的 **PL-M2 / PL-M3 / PL-M4 未开工**。

## Next Phase Boundary

**本子阶段结束（STOP）。未开始事项**：

- **PL-M2 切片边界绿灯锚点**（`docs/158` §3）——把 `maybeSliceBoundaryCheck` 的锚点从「最后一个实现任务」放宽为「切片最后一个任务」，使只有 TEST 任务的切片也触发边界绿灯检查。**未开工。**
- **PL-M3 修复任务类型合法性**（`docs/158` §3）——`debugTargetType` 不得把任意字符串当 `Task["type"]`；非法值回退到源任务的工作类型。**未开工。**
- **PL-M4 批次复验（E1×3）**——**未开工**；**需先确认周配额余量**（M4 实测单批约 6.7M 输入 token）。
- **带第三方依赖的评测夹具**（`docs/158` §6 第 7 项，推荐另立阶段）——PL-M6 的能力仍无交付链级别验证。
- **读取侧拒绝留痕**（`docs/159` Known Issue 3）——未修。
- **`docs/158` §6 第 1 / 3 / 4 / 5 / 7 项**：第 1、3 项已按推荐值 A 落地于本阶段；第 4、5、7 项仍待裁定。

**需要你回答**：是否继续开工 **PL-M2 / PL-M3**（两者都不消耗配额，可与 PL-M1 同批收尾），还是先停在此处。

---

# 后续块：PL-M2 / PL-M3 已完成（2026-10-16 追加）

> **本块是 2026-10-16 追加，不改动上文任何一行。** 上文「PL-M2 / PL-M3 未开工」等表述**以本块为准**。
> 用户同日授权「接着开工 PL-M2 和 PL-M3」，两项已实施完成，实施记录 **`docs/161`**。

- **PL-M2**：切片边界绿灯检查的**锚点**放宽为「最后一个经验证门的任务」、**AC 范围**放宽为「切片全部任务的 AC」。核对代码时发现上文 §1.2 记的缺口之外还有一个更隐蔽的失效面——**AC 并集取自被 `isDevTaskType` 过滤过的任务集，只被 TEST 任务引用的 AC 根本不进范围**（run 3 slice-5 的 AC-24/25/26/29/30 从未被检查过）。锚点条件**排除交付链任务**（必要细化：它们由 `DeliveryOrchestrator` 执行、在切片末尾长期 PENDING，字面照做会让检查永不触发）。
- **PL-M3**：`debugTargetType` 的两条来源（`fixTaskType` / `targetTaskType`）加类型成员判定，不可用则回退并记 `DEBUG_TARGET_TYPE_FALLBACK`。范围细化为「枚举外 **+** 运行期专属类型（DEBUG/MONITOR/INCIDENT）」都回退——原代码只挡了 `DEBUG` 一个，`MONITOR` / `INCIDENT` 是同一后果的敞口。

**仍未开工：PL-M4 批次复验（E1×3），需先确认周配额余量。** 本文件上述三条判据与结论均未受影响。
