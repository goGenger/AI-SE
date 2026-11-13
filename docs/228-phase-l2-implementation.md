# 228 · 自治 L2 实施记录（关口 1 纳入自治）

> 阶段：**自治 L2** ｜ 任务书 **`docs/227`**（§7 六项已裁定）｜ 用户 2026-10-23「都按推荐值，开工」
> 验收编号：**L2-1 … L2-7**（任务书新立）｜ 验收落点：`docs/17` 新增「自治 L2」节

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `packages/shared/src/index.ts` | 修改 | `AutonomyLevelSchema` 扩为 `["L1","L2"]` 并**前移**到 `CreateRequirementSchema` 之前（模块级 `const` 按声明顺序求值，放后面撞 TDZ）；`isAutonomyL1` → **`isAutonomyAtLeastL1`**（L2 ⊇ L1）；新增 `isAutonomyLevel` 类型守卫；`Requirement.autonomyLevel` 与 `CreateRequirementSchema.autonomyLevel`（可选、无默认）；新增 **`evaluateSlicePlanGate`** 与判据常量；新增 **`GATE1_AUTO_APPROVED`** 事件与 payload 契约 |
| `packages/database/migrations/016_phaseL2_requirement_autonomy.sql` | 新增 | `requirements.autonomy_level VARCHAR(16)`，**可空无默认** ⇒ 存量行 = 现状 |
| `packages/database/src/planningRepositories.ts` | 修改 | 行类型 / 映射 / INSERT 带上 `autonomy_level`；映射时用 `isAutonomyLevel` 收窄，不认识的值不伪造 |
| `apps/server/src/services/planningService.ts` | 修改 | 新增 `maybeAutoApproveGate1`；`approvals` 依赖扩 `decideApproval`（**复用同一个 CAS 决策方法**）；判据未命中时写 `GATE1_GATE_CHECKED` |
| `apps/server/src/services/verifyingTaskExecutor.ts` | 修改 | 谓词改名 |
| `packages/workflow-engine/src/WorkflowEngine.ts` | 修改 | 谓词改名（5 处） |
| `packages/shared/src/autonomyPolicy.test.ts` | 修改 | 「只定义 L1」→「接受 L2、仍拒 L3」；**+1** L2 ⊇ L1 用例 |
| `packages/shared/src/autonomyContract.test.ts` | 修改 | 事件清单 +1；**+1** `GATE1_AUTO_APPROVED` 契约用例（含「不得带 workflowRunId/taskId」） |
| `packages/shared/src/slicePlanGate.test.ts` | 新增 | **8 例**：全满足 + 每条判据的正/反例 + 多判据同时不满足 |
| `packages/database/src/migrate.test.ts` | 修改 | 15 → **16**；文件清单 +1；`at(-1)` 同步 |
| `apps/server/src/__tests__/sliceFlow.e2e.test.ts` | 修改 | **L2-1**：关口 1 未决时 `tasks` 与 `dependencies` 均为空 |
| `apps/server/src/__tests__/gate1Autonomy.e2e.test.ts` | 新增 | **3 例**：L2 全满足 ⇒ 自动批准 + 事件；L2 未满足 ⇒ 停在人工 + 零事件 + 记录判据；**未声明 ⇒ 现状不变** |
| `apps/server/scripts/probe-gate1-predicate.ts` | 新增 | 判据对**现存计划**的离线回放（只读、零配额） |
| `docs/227` / `docs/228` / `docs/17` / `docs/146` | 修改/新增 | 任务书裁定、本记录、验收节、状态表 |

---

## 2. Implementation

### 2.1 三个实施时发现、任务书没写死的问题

**① 需求侧没有策略字段（设计缺口）**
任务书 §2 写「若需求/工作流所属策略为 L2」，但 `requirements` 表**没有任何策略列**，
而关口 1 发生在**任何工作流之前**——工作流级 `policy` 此刻不存在。
⇒ 新增 `requirements.autonomy_level`（可空）。这是本阶段**唯一的结构性新增**，
理由：级别必须有一个在关口 1 时刻就存在的归属。

**② 有一个绕过关口 1 的入口**
`planPendingSlicesInOrder`（`planningService.ts:1389-1398`，F 阶段规划演练）会直接规划全部
PENDING 切片。**L2-1 只约束生产链路**，不断言该入口，也不改它。

**③ 需求的级别不会自动传播到工作流策略（边界，不是缺陷）**
第一个切片的工作流由外部创建（控制台 / harness 的 `POST /api/workflows`），
后续切片继承前一个工作流的 `policy`（`planningService.ts:997`）。
⇒ **需求的 `autonomyLevel` 只治理关口 1**；执行侧自治仍由工作流策略声明。
**L2 批次必须两处都声明**，否则会出现「关口 1 自动批了、执行却不是自治」的组合。

### 2.2 判据（`evaluateSlicePlanGate`，纯函数）

四条全部满足才自动批准，否则返回**未命中的判据名**：

| 判据 | 含义 | 常量 |
| --- | --- | --- |
| `fr-coverage` | 各切片 `frKeys` 并集**恰好**等于权威 FR 集合（权威集为空 = 不可判定 = 不满足） | — |
| `slice-scope` | 切片数 ∈ [1, 5]，每片 FR ≤ 3 | `SLICE_PLAN_GATE_MAX_SLICES` / `..._MAX_FR_PER_SLICE` |
| `slice-dependencies` | `dependsOn` 只指向**更小 order** 的切片且都存在（无悬空即无环） | — |
| `final-slice-scale` | 最终切片预估任务数 ≤ 阈值（默认 18，可被 `finalSliceMaxTasks` 覆盖） | `..._MAX_FINAL_SLICE_TASKS` |

### 2.3 自动批准的路径（不新增第二套审批）

```text
persistSlicePlan（需求置 PLANNING_REVIEW + 建 PENDING 审批）
  └─ maybeAutoApproveGate1
       ├─ 需求未声明 L2 或没有审批 → 直接返回（现状，零行为变化）
       ├─ 判据未全满足 → 写 GATE1_GATE_CHECKED{unmet[]}，保持 PENDING（交人工）
       └─ 判据全满足 → decideApproval(id,"APPROVED")   ← 同一个 CAS（WHERE status='PENDING'）
                       → 写 GATE1_AUTO_APPROVED
                       → handleSliceApprovalDecided(decided)   ← 既有续跑钩子
```

`decideApproval` 返回 `null`（并发下已被人决策）时**直接让位**，不重复推进。

### 2.4 SDK 契约：`GATE1_AUTO_APPROVED` 为什么是新事件

`AUTO_APPROVED` **结构上不可复用**，两条硬理由：① 它把 `environment` 锁死为 `"staging"`，
而关口 1 与部署环境无关；② 它的公共字段要求 `workflowRunId` 与 `taskId` 两个 uuid，
**关口 1 时这两者都还不存在**。新事件自带 `requirementId` 归属。

---

## 3. Architecture Changes

- **新增一个需求级策略字段**（`requirements.autonomy_level`）——自治级别的归属从「工作流」上移到「需求」的**那一部分**（仅关口 1），执行侧仍留在工作流。
- **新增一个自治决策事件类型**（只增不改，沿用既有 `workflow_events`）。
- **不新增**表、审批体系、错误码体系；批准复用既有 `approvals` 与既有续跑钩子。

---

## 4. Dependencies

**无新增、无升级、无删除。**

---

## 5. Tests

| 包 | 结果 |
| --- | --- |
| `packages/shared` | **178/178**（改动前 168，**+10**：判据 8 + 契约 1 + L2⊇L1 1） |
| `packages/database` | **47/47**（迁移用例含真 postgres:16：16 个迁移各应用一次、幂等、篡改校验） |
| `apps/server` | **358/358（53 文件）**（改动前 355，**+3**：`gate1Autonomy.e2e`） |

**M1 的三条回归断言**：L2-1 落在 `sliceFlow.e2e`（关口 1 未决时零任务）；
L2-2 的拒绝路径**已有实现且已有覆盖**（本次未新增断言，见 §9 Known Issues 2）；
L2-3 控制台入口由既有 `requirementViewModel` 用例覆盖。

**实施中的两次自我更正**（都先红后绿）：
1. 正控用例最初等的是 `/slices` 的 `approval.status === "APPROVED"`——**该视图只暴露待决审批**，
   批准后为 `null`，断言永远不成立。改为等库内事件。
2. 断言「所有审批都是 APPROVED」时发现同一需求下还有**第二条 PENDING**——那是切片规划升级
   新建的审批。改为只锁定关口 1 那一条（按 comment 前缀）。

---

## 6. Lint / 7. Typecheck

- `--filter @ai-se/shared` typecheck / lint / build → **exit 0**
- `--filter @ai-se/database` typecheck / build → **exit 0**
- `--filter @ai-se/workflow-engine` typecheck → **exit 0**
- `--filter @ai-se/server` `tsc --noEmit` / lint → **exit 0**
- 迁移已应用到开发库：`{"applied":["016_phaseL2_requirement_autonomy.sql"]}`

**全仓门禁（阶段收尾，显式退出码）**：

| 命令 | 结果 |
| --- | --- |
| `-r run typecheck` | **TYPECHECK_EXIT=0** |
| `-r run lint` | **LINT_EXIT=0** |
| `-r run test` | **TEST_EXIT=1** — **1923/1924 通过**，唯一失败是 `v1GoldenScenario > server restart`（`docs/148`/`149`/`153`/`224` 反复登记的负载敏感 flake），**隔离复跑 4/4 通过**，**未改任何测试** |

各包读数：`shared` **178**、`database` **47**、`server` **357/358**、`workflow-engine` **68**、
`agent-core` **266**、`apps/web` **505**、`mcp` **235**、`eval` **65** 等。

---

## 8. E2E

### 8.1 L2-7 的离线回放（零配额，已完成）

`apps/server/scripts/probe-gate1-predicate.ts` 对库里**现存** 10 份切片计划跑判据：

```
{"requirements":10,"wouldAutoApprove":7,"wouldEscalateToHuman":3,
 "maxFinalSliceTasksThreshold":18,"unmetDistribution":{"slice-scope":3}}
```

**读法**：7 自动批 / 3 送人工，**3 份全部卡在 `slice-scope`**（每片 FR 数 > 3）。
既不是「全部拒绝」（判据没写崩），也不是「全部放行」（判据在起作用）。
⚠️ **它不是批次**：切片计划不留历史（`replaceSlicePlan` 先删后插），样本只有当前计划，
且「自动批」只是判决，**没有真的批准任何东西**。

### 8.2 L2-7 的批次：**未跑**

需要另起一次 E1×3（声明 `autonomyLevel: "L2"` 的需求 + L2 工作流策略），
成本与 L1-8 同量级（`l1-m4u` 实测 235M 输入 token）。**未开工**。

---

## 9. Known Issues

1. **L2-7 批次未跑** ⇒ 本阶段判 **PASS-PARTIAL**，不判「已关闭」。
2. **L2-2（拒绝 → 重做有界）没有新增断言**：该行为是 Phase B 的既有实现，
   本次只在 `gate1Autonomy` 里覆盖了「不满足 ⇒ 停在人工」。**拒绝路径的生产读数仍是 0 次**
   （全库 86 条 gate-1 审批全部 APPROVED）——这是 §2 判据 B 的存在理由，也是它尚未被行使的证据。
3. **阈值可能偏严**：离线回放里 3/10 卡在「每片 FR ≤ 3」。是否校准，等批次读数再定
   （`docs/227` §7 第 2 项允许用回放分布先看，再调阈值）。
4. **需求级 L2 不传播到工作流策略**（§2.1 ③）——有意为之，但**批次脚本必须两处都声明**。
5. **演练入口 `planPendingSlicesInOrder` 不受 L2 约束**（§2.1 ②），有意为之。

---

## 10. Acceptance Result

| 判据 | 结果 |
| --- | --- |
| L2-1 关口 1 阻塞第二级 | ✅ `sliceFlow.e2e` 断言 |
| L2-2 拒绝 → 重做有界 | ⚠️ 既有实现，本次未新增断言（Known Issue 2） |
| L2-3 控制台入口 | ✅ 既有用例覆盖 |
| L2-4 自治级别表达 L2 | ✅ 枚举扩展 + L2 ⊇ L1 谓词 + 用例 |
| L2-5 判据纯函数 | ✅ 8 例正/反例 |
| L2-6 自动批准与决策事件 | ✅ 3 例 E2E（含未声明的回归控制） |
| L2-7 数据门槛 | ⚠️ 离线回放完成；**批次未跑** |

**判「已实施、单测与全量门禁通过、批次验证待跑」，不判「已关闭」。**

---

## 11. Next Phase Boundary

**未开始事项（STOP）**：

1. **L2-7 的批次**（E1×3，L2 策略）——需配额确认后另开，不续跑既有批次。
2. **`docs/17` 的「自治 L2」节**已建（本批），L2-7 未达故不勾。
3. **阈值校准**（每片 FR ≤ 3、最终切片 ≤ 18）——等批次读数。
4. **`VERIFICATION_GATE=enforce` 全面切换评估**，`W11/W12/W13` 未勾项，**N-37**——均未开工。
