# 221 · PL-M37 探针记录（N-33 最终切片计划：`action:"VERIFY"` 是否产出）

> 阶段：**PL-M37** ｜ 探针脚本：`apps/server/scripts/probe-n33-final-slice-plan.ts`
> 用户 2026-10-22 指令「做规划探针」。
> **结论：`VERIFY-PRESENT`** —— 新提示词确实让最终切片计划产出 `type=TEST + delivery.action="VERIFY"`。
> **不判 N-33「已关闭」**：探针不等于批次（见 §6）。

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `apps/server/scripts/probe-n33-final-slice-plan.ts` | 新增 | 只读规划探针（生产同构输入 + 真实 `runPlanningGraph(level2)`） |
| `packages/eval/results/n33-plan-probe/plan-slice-3-tasks-1792666817394.json` | 新增（产物） | 完整 18 任务计划 + 4 个交付块 |
| `docs/221-phase-pl-m37-final-slice-plan-probe.md` | 新增 | 本文件 |

**零生产代码改动、零依赖、零 migration。** 探针不写任何需求/切片/任务行。

---

## 2. 为什么需要这个探针

`docs/218` §12 的勘误：`l1-m4t` 三个 run 共用 run 1 生成的**同一份计划**，而 run 1 规划于 N-33 落地之前
⇒ **该批次一次都没验到 N-33**。正常验证路径是「下一批的 run 1 带 `--replan`」，但**周配额窗口
2026-10-25 23:00 UTC 才重置**（run 3 起跑时已用 694.8M / 700M）。

等三天只为回答一个是/否问题不值得，所以把**规划这一步单独拿出来测**。

**关键设计约束（探针必须与生产同构）**：如果手写一份提示词去问模型「你会怎么规划」，
测到的是我写的提示词，不是平台的行为。因此探针**复用批次最终切片的真实输入**，
只让提示词随代码版本变化：

| 生产路径（`planningService.executeSliceRun`） | 探针 |
| --- | --- |
| `getRequirement(requirementId)` | `PgPlanningRepository.findRequirementById` |
| `findLatestAnalysis` → `seedAnalysis` | 同一方法 |
| `findAcceptanceCriteriaByRequirementId` → `acceptanceCriteria` | 同一方法（同一字段映射） |
| `findSlicesByRequirementId` → 取最后一片即最终切片 | 同一规则 |
| `deliveryConfigured = Boolean(project.repository)` | 同一表达式 |
| `deliveryEnvironment = staging 优先` | 同一优先序 |
| `skipStages` = 按 `involvesUi` / `involvesData` | 同一表达式 |
| `model = new LivePlanningModel(modelConfig, () => new LangChainPlanningModel({...}))` | 逐字照抄 `index.ts:147-158` |
| `runPlanningGraph({ pipeline: "level2", … })` | 同一函数、同一参数 |
| **`afterGraph` 持久化** | **刻意不提供**（保持只读） |

---

## 3. 输入（实测，非构造）

```text
requirement : a30f30cc-64f5-4b31-9bbb-9b3d5bbaba53 (E1)
slice       : slice-3-tasks — 任务 CRUD、搜索与多用户数据隔离 (final=true)
analysis    : a30f30cc-…（库中持久化的 requirement_analysis，作为 seed）
AC records  : 30
git bound   : true   env: staging
```

---

## 4. 结果

**`tasks: 18   delivery blocks: 4   183 455 ms`**

四个交付块**逐字符合**提示词契约：

| 任务 | 类型 | 标题 | `delivery` |
| --- | --- | --- | --- |
| `task-3-15` | **BUILD** | CI：安装、lint、typecheck、测试与构建流水线 | `{"action":"CI"}` |
| `task-3-16` | **DEPLOY** | 部署：Staging 环境部署（DATA_DIR 数据卷持久化） | `{"action":"DEPLOY","environment":"staging"}` |
| **`task-3-17`** | **TEST** | **验证：Staging 环境端到端冒烟验证** | **`{"action":"VERIFY","environment":"staging"}`** |
| `task-3-18` | **DEPLOY** | 部署：Production 环境发布（人工审批） | `{"action":"DEPLOY","environment":"production"}` |

**判 `VERIFY-PRESENT`。**

这正是 run 1/run 2 里 `T18`（`type=DEPLOY, action=DEPLOY, 标题=验证 staging 环境`）缺失的那一格：
**标题相同、契约从「再次部署」变成了「验证」。**

---

## 5. 由此确定的三件事

1. **提示词路线有效**，不需要上确定性兜底（`docs/218` §9 已知问题 1 不再需要）。
2. **N-33 的机制诊断成立**：缺陷确实在「生产者从没被告知 `delivery.action`」这一侧，
   而不是模型理解不了「验证」这个词。
3. **规划探针是可复用的批次前置烟测**：183 秒、一次规划开销、只读。
   规划侧改动以后都应先过它，再花一整批去验。

---

## 6. 这个探针**不能**证明什么（不判 N-33「已关闭」）

| 未证明 | 为什么 | 谁来证明 |
| --- | --- | --- |
| 真实批次的 run 1 也会这样规划 | 探针只跑规划，不跑 `PlanningService` 的持久化与校验重试链 | 下一批（run 1 带 `--replan`） |
| **35b**：该任务由 `delivery-orchestrator` 执行 | 那是运行期分派，N-31 改的是 `canHandle` | 下一批（运行期 `agent_runs`） |
| **35c**：`collectStagingSegment.verify` 非 null | 需真实 CI + staging DEPLOY + VERIFY 三段都成功 | 下一批 |
| L1-8 ≥ 2/3 | 需要整整一批三个 run | 下一批（配额窗口重置后） |

**探针证明的是「计划里会有这一格」，不是「这一格会跑通并被记账」。**

---

## 7. 已知限制

1. **单次采样**：一次规划 = 一个样本。模型是随机的，理论上换一次可能不给 VERIFY。
   这是**提示词路线**的固有性质（非确定性），也正是 §9 兜底曾经存在的理由。
   **建议**：把它当烟测而非验收；若下一批 run 1 又没给，说明单靠提示词不够稳。
2. **不覆盖校验/修复轮**：生产在 `afterGraph` 之后还有校验与修复，探针在 `runPlanningGraph` 返回即停
   （`maxValidationRetries: 2` 仍传入，图内修复照跑）。
3. **不写库**：这是特性不是缺陷——它让探针能在批次运行中途安全执行。

---

## 8. Acceptance Result

交付物是「1 个只读探针脚本 + 1 份计划产物 + 本次记录」。

判 **「探针通过：`VERIFY-PRESENT`」**；**N-33 维持「已实施、待批次验证」**。

---

## 9. Next Phase Boundary

**未开始事项（STOP）**：

1. **下一批 E1×3**：run 1 带 `--replan`，须复核 `requirement_slices.planning_version` 确实递增
   （否则新提示词仍不会被读到——`docs/218` §12）。配额窗口 2026-10-25 23:00 UTC 重置。
2. **35a / 35b / 35c 待下一批**。
3. **`l1-m4t` run 3 仍在跑**（slice-3），跑完后写 `docs/217` 批次记录。
4. **`docs/217`（L1-M4t 批次记录）未写。**
