# 161 · 切片边界锚点与修复任务类型合法性实施记录（PL-M2 / PL-M3）

> 日期：2026-10-16 ｜ 类型：**计划器根因修复 · 纵深里程碑**（`docs/158` §3 的 PL-M2 / PL-M3；用户 2026-10-16「接着开工 PL-M2 和 PL-M3」授权）
> 依据：`docs/158`（任务书 + §1.2 缺口 + §1.3 锚点 + §1.5 `fixTaskType`）、`docs/160`（PL-M1）、`AGENTS.md` §9/§10。
> 范围：**只做 PL-M2 与 PL-M3**。**PL-M4 未开工**（批次复验 E1×3，需先确认周配额余量）。

## Modified Files

**PL-M2（`apps/server`）**
- `src/services/taskVerifier.ts`：
  - `maybeSliceBoundaryCheck` 的锚点守卫 `isDevTaskType(task.type)` 删除，`sliceDev` 过滤改为**切片全部任务**；
  - 新增模块级 `hasDeliveryBlock(task)`——交付链任务不作锚点；
  - AC 并集改为**切片全部任务**的 `acKeys`（本任务的在前，保持 F1-5 既有顺序语义）；
  - 函数与调用点的注释同步。
- `src/__tests__/taskVerifier.test.ts`（**+3 条**）：只有 TEST 任务的切片触发并判失败；只被 TEST 任务引用的 AC 进入范围；未完成的交付链任务不阻断锚点。

**PL-M3（`packages/workflow-engine`）**
- `src/WorkflowEngine.ts`：
  - 新增 `TASK_TYPE_OPTIONS` / `RUNTIME_ONLY_TARGET_TYPES` / `isUsableTargetType`；
  - `debugTargetType` 由「返回 `Task["type"]`」改为返回 `{ type, rejectedFixTaskType }`，两条来源（`fixTaskType` / `targetTaskType`）都做成员判定；
  - 调用点取 `target.type`，并在 agent 给了不可用值时经既有 `this.event` 通道记 `DEBUG_TARGET_TYPE_FALLBACK`。
- `src/WorkflowEngine.test.ts`（**+3 条**）：`fixTaskType: "IMPLEMENTATION"` 回退且不产出枚举外类型；运行期专属类型 `MONITOR` 同样回退；合法值行为不变且不记回退事件。

**文档**：本文件；`docs/158` §6/§9、`docs/146` §3、`docs/127` §9、`docs/160`（追加后续块）。

## Implementation

### PL-M2 切片边界绿灯锚点

**问题不是「检查没跑」，是「检查跑的范围不对」。** `docs/158` §1.3 记的是「只有 TEST 任务的切片没有实现任务可作锚点 → 永不触发」；核对代码后发现**还有一个更隐蔽的失效面**：AC 并集取自 `[task, ...siblings]`，而 `siblings` 被 `isDevTaskType` 过滤过——**只被 TEST 任务引用的 AC 根本不进范围**。run 3 slice-5 正是这样：边界检查确实跑了，但它只跑 `{AC-19, AC-20, AC-27, AC-28}`（四个 BACKEND 任务的），而 `{AC-24, AC-25, AC-26, AC-29, AC-30}`（只被 TEST / DEPLOY / BUILD 任务引用）**从未被检查过**。

两处放宽：

1. **锚点**：`isDevTaskType(task.type)` 守卫删除，`siblings` 改为切片内**除交付链任务外**的全部任务。
2. **AC 范围**：并集改为切片内**全部任务**（含交付链任务）的 `acKeys`。

**一处对任务书措辞的必要细化（须报告）**：任务书写的是「改为『切片内最后一个任务』」。若**字面**照做（把交付链任务也计入锚点条件），结果是**检查更少触发**——交付链任务由 `DeliveryOrchestrator` 执行（CI / DEPLOY / ROLLBACK / VERIFY），在切片末尾长期 `PENDING`，而它们又**不经过本验证门**。run 3 slice-5 的顺序是 `… → REVIEW(TASK-11) → CI(TASK-12) → DEPLOY(TASK-17/18/19)`：`TASK-11` 完成时后四个全是 `PENDING`，字面实现下**永不触发**——恰好是要消除的失效模式。故锚点条件排除交付链任务；它们的 `acKeys` 仍计入范围（只是可能没有对应测试）。这既满足任务书的出口判据（只有 TEST 任务的切片会触发），也保住「在 CI 之前拦住红灯」的原意。

**红线遵守**：仍是既有的 `slice-boundary` 检查名与既有判定分支（`taskVerifierRules.ts:192-194` 未改），未新增检查种类。

### PL-M3 修复任务类型合法性

`debugTargetType` 原先把 `fixTaskType` 直接 `as Task["type"]`。两条来源都**未经成员判定**：

- `fixTaskType` 来自 **agent 输出**（`source.output.fixTaskType`），`docs/155` M4 记录里 agent 真的产出过 `fixTaskType: IMPLEMENTATION`——而 `TaskType` 枚举里**没有 `IMPLEMENTATION`**；
- `targetTaskType` 来自既有任务输入，同样是未校验的 `as`。

消费方 `AgentRegistry.debugTarget` 也是 `as TaskType` 后查 `TASK_AGENT_TYPES`，查不到即「无专业 agent」→ 任务瞬失败（`validateTaskGraph.ts:22-27` 记录过同类真实事故）。

改法：新增 `isUsableTargetType`——**既在 `TaskTypeSchema.options` 内，又不是运行期专属类型**。两条来源都过它；不可用则回退到源任务的工作类型（既有分支）。

**一处范围细化（须报告）**：任务书只提「不在枚举内」。我把 `DEBUG` / `MONITOR` / `INCIDENT` 三个**运行期专属类型**一并排除——它们在枚举内，但与 `DEBUG` 有**完全相同**的后果（无专业 agent、瞬失败），而原代码只挡了 `DEBUG` 一个。与 `validateTaskGraph.ts` 的 `RUNTIME_ONLY_TASK_TYPES` 同义，**刻意不引跨包常量**（那份管计划项、这份管运行期目标类型），已在注释写明。

**事件**：经**既有** `this.event` 通道记 `DEBUG_TARGET_TYPE_FALLBACK`（新事件**类型**、既有通道与既有 payload 风格；`docs/152` OB-10 禁止的是改既有类型与既有 payload 形状）。**不回显原始值**——它来自 agent 输出的自由文本，本包没有 `@ai-se/observability` 依赖、无 sanitize 通道，`AGENTS.md` §10 要求敏感日志走 sanitize；故 payload 只带 `sourceTaskId` / `sourceTaskKey` / `debugTaskId` / `fallbackTaskType` / 固定 `reason`。

## Architecture Changes

- 切片边界检查的**锚点语义**从「最后一个实现任务」变为「最后一个经验证门的任务」；**AC 范围**从「实现任务的 AC」变为「切片全部任务的 AC」。二者合起来才使该检查真正覆盖切片。
- 「谁可作为切片收尾锚点」在 `apps/server` 内有了显式判据（`hasDeliveryBlock`），与 `DeliveryOrchestrator.canHandle` 的执行面划分对齐。
- `debugTargetType` 从「宽松断言 + 单一 `DEBUG` 特例」变为「成员判定 + 回退」，并把「发生了回退」这一事实显式返回给调用方。
- **未新增**检查种类、错误码、事件体系或权限面。

## Dependencies

无新增（含 devDependencies）。**刻意未给 `@ai-se/workflow-engine` 添加 `@ai-se/observability` 依赖**（只为一条日志引一条包依赖不划算，代价是 payload 不回显原始值，见上）。

## Tests

| 范围 | 结果 |
| --- | --- |
| `@ai-se/workflow-engine` test | **45/45 通过（3 文件）**（改动前 42，+3） |
| `apps/server` test（全量，两次运行） | **269 条**：一次 `267 passed / 2 failed`、一次 `268 passed / 1 failed`——失败均为既有抖动，见下 |
| `apps/server` 定向 `taskVerifier.test.ts` | **40/40 通过**（改动前 37，+3） |
| 全仓 `corepack pnpm -r run typecheck` | **通过（exit 0）** |
| 全仓 `corepack pnpm -r run lint` | **通过（exit 0）** |
| 全仓 `corepack pnpm -r --no-bail run test` | 16 包中 15 包全绿；`apps/server` 见下 |

**门禁抖动如实记录（本次新增观测，重要）**：`apps/server` 全量在本阶段**四次运行四次都未全绿**，且**失败文件与失败形态每次都在漂移**：

| 运行 | 失败文件 | 失败形态 | 单独复跑 |
| --- | --- | --- | --- |
| 1（PL-M1 阶段） | `workflowTrace.e2e.test.ts` | 整个文件 Failed Suite，无断言失败 | 1/1 通过 |
| 2（PL-M1 阶段） | `v1GoldenScenario.e2e.test.ts` | `Error: waitFor timed out` | 4/4 通过 |
| 3（PL-M1 阶段，`--no-bail`） | — | **全绿** | — |
| 4（本阶段） | `v1GoldenScenario` + `workflowApi.e2e.test.ts` | `waitFor timed out` / `expected 200, got 404`（`POST /workflows/:id/start`） | 4/4、11/11 通过 |
| 5（本阶段） | `v1GoldenScenario` | `waitFor timed out` | 4/4 通过 |
| 6（本阶段） | `finalSliceGovernance.e2e.test.ts` | `Error: read ECONNRESET` | 2/2 通过 |

`workflowApi` 的 `re-plans failure into Debug -> Retry -> Success` 落在 PL-M3 改动的 REPLAN 路径上，故**额外复跑 3 次：11/11、11/11、11/11 全部通过**；且失败点是 `/start` 的 404（工作流行未找到，发生在任何任务执行之前），与 PL-M3 无关。该用例的断言用 `expect.arrayContaining`，新增事件类型不会使其失败。

**结论**：这是 `docs/145` #7 / `docs/146` §5 已登记的负载敏感抖动，本阶段观测到它**比先前记录的更宽**——不仅 `v1GoldenScenario`，`workflowTrace` / `workflowApi` / `finalSliceGovernance` 都会在不同运行中失败，形态含断言超时、整文件 Failed Suite、`ECONNRESET`、共享 DB 状态导致的 404。**未修，如实记录**（修它属独立的门禁稳定性议题，不在本里程碑范围）。

## Lint

`@ai-se/workflow-engine` / `@ai-se/server` 均退出码 0；全仓 `-r run lint` 16 包全绿（exit 0）。

## Typecheck

两个改动包均退出码 0；全仓 `-r run typecheck` 通过（exit 0）。

## E2E

**PL-M2（三条注入式用例）**：

1. **只有 TEST 任务的切片也触发边界检查**（`docs/158` §3 的出口判据）：切片 `S9` 两个 TEST 任务、红灯未转绿 → 任务级红灯检查**通过**（测试确实红了），边界检查 `expected: "pass"` 而 `passed: false` → `verdict: "failed"`，`SLICE_BOUNDARY_CHECKED` 记 `verdict: "failed"`。
2. **只被 TEST 任务引用的 AC 进入范围**（run 3 slice-5 缺口的单元级复现）：当前任务（BACKEND）覆盖 AC-01、同切片 TEST 任务覆盖 AC-02 → 边界命令的 `--test-name-pattern` **含 AC-02**、`scopedAcKeys === ["AC-01","AC-02"]`，且因 AC-02 红而判失败。修复前 `AC-02` 不进范围。
3. **未完成的交付链任务不阻断锚点**：同切片有一个 `PENDING` 的 DEPLOY（带 `delivery` 块）→ 边界检查**仍然触发**且通过；`scopedAcKeys === ["AC-01","AC-02","AC-03"]`（AC-03 只被该 DEPLOY 任务引用，证明范围取的是切片全部任务）。

**PL-M3（三条用例）**：`fixTaskType: "IMPLEMENTATION"` → `targetTaskType` 回退为 `BACKEND`、**遍历全部任务断言 `type` 均在 `TaskTypeSchema.options` 内**、`DEBUG_TARGET_TYPE_FALLBACK` 事件含 `fallbackTaskType: "BACKEND"`；`fixTaskType: "MONITOR"`（枚举内但运行期专属）→ 同样回退到 `FRONTEND`；`fixTaskType: "FRONTEND"`（合法）→ 直接采用且**不记**回退事件。

## Known Issues

1. **PL-M2 只把检查搬到正确的锚点与范围，不改判据本身**。若某切片确实没有测试可跑（`facts.scripts.test` 为空、或切片内无人引用任何 AC），检查仍静默跳过（`return null`）——与既有行为一致，**未改**。
2. **PL-M2 会让边界检查更频繁地运行**：锚点从「最后一个实现任务」变为「最后一个经验证门的任务」，每切片仍只跑一次，但可能落在 REVIEW / TEST 任务上，并多一次 `run_unit_test` 沙箱调用。**代价已知、未测**（真实批次的耗时影响属 PL-M4 的观测面）。
3. **PL-M2 的注入式用例是单元级**，未走真实沙箱与真实 `workflowTasks` 读取。真实链路上的效果**只有 PL-M4 能验**——特别是「run 3 slice-5 若重跑，边界检查会不会真的在 CI 之前拦下」。**本阶段不作承诺。**
4. **PL-M3 的第二个未校验断言仍在**：`AgentRegistry.debugTarget` 依旧把 `input.targetTaskType` 直接 `as TaskType`。PL-M3 让**生产者**不再写入不可用值，但消费者侧的宽松断言**未改**（不在本里程碑范围）。若日后有别的生产者写入该字段，同一失效面会重现。
5. **`DEBUG_TARGET_TYPE_FALLBACK` 是新增事件类型**，不在任何既有事件契约清单里。当前无消费方（`packages/eval` 的指标聚合按已知事件名取数，未知事件被忽略）；若日后要纳入观测口径，需按 `docs/152` 的契约流程补类型。
6. **回退事件不回显原始值**（刻意，`AGENTS.md` §10）。运营侧若要查 agent 到底给了什么，只能从 `tasks.output` 或 agent run 记录里找。
7. **门禁抖动的既有口径不变**（`docs/146` §5），但本阶段观测到它的**范围比先前记录的更宽**（见 Tests 节的六次运行表）。未修。
8. **未做（红线）**：未新增检查种类 / 错误码 / 权限面；未改 L1-8 判据口径；未改提示词；未动 `packages/eval`；未修改任何 `dist/`。

## Acceptance Result

| 里程碑（`docs/158` §3） | 判定 | 证据 |
| --- | --- | --- |
| **PL-M2** 只有 TEST 任务的切片也触发边界检查 | **达成** | 用例 1：TEST-only 切片触发且判失败 |
| **PL-M2** 边界检查因红灯未转绿而判失败 | **达成** | 用例 1：`expected: "pass"` / `passed: false` / `verdict: "failed"` |
| **PL-M2** AC 取值来源放宽到切片全部任务 | **达成** | 用例 2：只被 TEST 任务引用的 AC-02 进入 `--test-name-pattern` 与 `scopedAcKeys` |
| **PL-M2** 仍是既有 `slice-boundary` 检查名与既有判定分支 | **达成** | `taskVerifierRules.ts` 的 `isSliceBoundaryName` / `VerificationCheckName` 未改 |
| **PL-M3** 非法 `fixTaskType` 回退、不产出枚举外类型 | **达成** | 用例 1：回退为 BACKEND；遍历全部任务断言 `type` ∈ `TaskTypeSchema.options` |
| **PL-M3** 合法值行为不变 | **达成** | 用例 3：`FRONTEND` 直接采用、不记回退事件 |
| **PL-M3** 回退原因经既有通道留痕 | **达成** | 用例 1：`DEBUG_TARGET_TYPE_FALLBACK` 含 `fallbackTaskType` |

**阶段判定：PL-M2 与 PL-M3 达成。** `docs/158` 的 **PL-M4 未开工**。

## Next Phase Boundary

**本子阶段结束（STOP）。未开始事项**：

- **PL-M4 批次复验（E1×3）**——`docs/158` §3；**未开工**；**开工前须确认周配额余量**（M4 实测单批约 6.7M 输入 token）。这是**唯一能验证 PL-M1 / PL-M2 / PL-M3 是否真的把 E1 推到 staging 段**的一项。
- **带第三方依赖的评测夹具**（`docs/158` §6 第 7 项，推荐另立阶段）——PL-M6 的能力仍无交付链级别验证。
- **读取侧拒绝留痕**（`docs/159` Known Issue 3）——未修。
- **`AgentRegistry.debugTarget` 的未校验断言**（本文件 Known Issue 4）——未修。
- **门禁抖动的范围比先前记录更宽**（本文件 Known Issue 7 / Tests 节）——未修，属独立议题。
- **`docs/158` §6 第 4 / 5 / 7 项**仍待裁定。

**需要你回答**：是否现在开工 **PL-M4**（会消耗真实配额，量级 ~6.7M 输入 token/批 × 3 批）。

---

# 后续块：Known Issue 4（`debugTarget` 未校验断言）已修复（2026-10-16 追加）

> **本块是 2026-10-16 追加，不改动上文任何一行。** 上文「`AgentRegistry.debugTarget` 的未校验断言——未修」等表述**以本块为准**。

- 用户同日授权「先清掉这几条，再跑 PL-M4」（范围裁定 1+2+3）。**本文件 Known Issue 4 是其中第 3 条**，已作为 **PL-C3** 实施完成。
- 做法：`AgentRegistry.debugTarget` 改用 `isUsableTargetTaskType`；`resolveTask` 在 DEBUG 派不出去时报**真实原因**（`its target task type is missing or unusable`），不再误报「task type DEBUG」。**不回显目标值**——它可能来自 agent 输出，与 PL-M3 的回退事件同一口径（`AGENTS.md` §10）。
- **顺带消除了重复定义**：「运行期专属任务类型」判定上移到 `packages/shared`（`RUNTIME_ONLY_TASK_TYPES` / `isRuntimeOnlyTaskType` / `isUsableTargetTaskType`）。此前有两份同义副本（`agent-core/src/planning/validateTaskGraph.ts` 与 `workflow-engine/src/WorkflowEngine.ts`，后者注释自陈「同义，故刻意不引跨包常量」），PL-C3 正要引入第三份。**本文件 Known Issue 5**（`DEBUG_TARGET_TYPE_FALLBACK` 是新增事件类型）**未受影响**，仍成立。
- **仍未根治**：`DEPLOY` 是合法枚举成员却无职业 agent，本批按最小改动只让报错说实话（`docs/163` Known Issue 8）——根治需先裁定「DEPLOY 算不算可派发的工作类型」。
- 实施记录 **`docs/163`**（任务书 `docs/162`）。
