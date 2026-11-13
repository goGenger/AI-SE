# 213 · L1-M4r 批次记录（N-29 真实验证 + N-30 发现）

> 批次：`packages/eval/scripts/l1-m4r-e1-x3.sh` ｜ 结果目录：`packages/eval/results/l1-m4r/`
> 日期：2026-10-21 ｜ 夹具：E1（TaskBoard，PRD 级端到端），autonomy L1
> 目的：在真实批次里验证 **N-29 / PL-M30**（DEBUG 任务的诚实交接不再饿死重试，`docs/212`）

---

## 1. 前置条件（已核对，不是假设）

| 项 | 事实 |
| --- | --- |
| 探针 | 19:02:12、19:02:42 各 **6/6** |
| 构建 | `packages/workflow-engine` dist 于 **19:02:45** 重建，含 PL-M30 的 `diagnosis task` 措辞 |
| 重启 | 平台服务 **19:03:48** 重启（pid 26934），在构建之后 |
| 生效证据 | 库内 `workflow_runs.error` 出现 `Task failed: … (diagnosis task)` —— 方案 D 的措辞确实在跑 |

**记账口径（批次启动前已声明，不是事后解释）**：DEBUG 交接任务不再落
`REPLAN_REQUESTED` ⇒ `errorTypes` 分布与 `FAILED` 总数**会下降**，这**不是失败变少了**。

---

## 2. 逐次运行

| run | 起止（CST） | 结果 | 切片到达 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | 19:04:13 → 19:28:27 | 切片 2 失败（**无工作流**） | slice-1 SUCCESS | `d06665eb` ok=11 bad=1 pend=0/12 |
| 2 | 19:58:28 → 20:23:13 | 工作流 FAILED | **只到 slice-1** | `ce596365` ok=9 bad=3 pend=1/14 |
| 3 | 20:53:13 → 22:36:34 | **切片 3 规划失败** | **slice-1 + slice-2 双双 SUCCESS** | `dc6a955e`（37 min）+ `03af8b16`（47 min） |

### 2.1 真实 token（按 `workflow_runs` 窗口从库内求和，非 summary 代理值）

| run | 工作流 | 切片 | 状态 | agent run 数 | 输入 token | 输出 token |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `d06665eb` | slice-1 | SUCCESS | 12 | 6,982,917 | 188,678 |
| 2 | `ce596365` | slice-1 | FAILED | 12 | 8,073,807 | 174,882 |
| 3 | `dc6a955e` | slice-1 | SUCCESS | 18 | 8,880,037 | 235,716 |
| 3 | `03af8b16` | slice-2 | SUCCESS | 16 | 15,698,887 | 217,652 |

**run 3 合计 24.58M 输入 / 453K 输出。** eval summary 的「运行数 0 / token 0」是因为夹具未完成时
它不计账——真实消耗必须从库里取，这是本仓库已登记的记账口径缺陷（`docs/209`）。

---

## 3. 判据对照

| 判据 | 预期 | 实测 | 结论 |
| --- | --- | --- | --- |
| **31a** 诚实交接不再判失败 | DEBUG + `REPLAN` + 合法 `fixTaskType` ⇒ 任务 SUCCESS、`errorType` 空 | run 2 `T10-DEBUG-1`、run 3 `T6-REPLAN-1-DEBUG-2`，两条均 DEBUG + `REPLAN` + `fix=TEST` ⇒ **SUCCESS / err 空** | **确认** |
| **31b** 不收养懒 | DEBUG + `REPLAN` 但无可执行交接信息 ⇒ 仍判失败 | run 2 `T10-REPLAN-1-DEBUG-2`：`fix=DOCUMENTATION`（非 `TaskType` 成员）+ 0 条 `fixSteps` ⇒ **FAILED** | **确认（野外首次）** |
| **31c** 非 DEBUG 语义不变 | 非 DEBUG 的 `REPLAN` 仍落 `REPLAN_REQUESTED` | run 2 `T10`(REVIEW)、run 3 `T9`(DESIGN) 均为 FAILED + `REPLAN_REQUESTED` | **确认** |
| **31e** 重试不再饿死 | `-REPLAN-` 的 PENDING 比例显著低于基线 **13/28** | run 1：1 个 SUCCESS、**0 PENDING**；run 2：跑过；run 3：`T8-REPLAN-1`、`T9-REPLAN-1`、`T6-REPLAN-1-REPLAN-2` **全部 SUCCESS**，切片内 **0 PENDING** | **确认** |
| **31f** 到达更深切片 | 有任何一次 run 走过 S2 | run 3 连续两个切片 SUCCESS | **确认** |

### 3.1 最有力的一条链（run 3）

```
T6-REPLAN-1-DEBUG-2   DEBUG  REPLAN  fix=TEST   → SUCCESS（交接）
T6-REPLAN-1-REPLAN-2  TEST                       → SUCCESS
```

`T6-REPLAN-1-REPLAN-2` **依赖**那个 DEBUG 任务。N-29 之前，DEBUG 被判失败 ⇒ 这条 TEST 重试
**永远 PENDING**。本 run 里它跑完并成功——**这是修复产生真实任务成功的直接证据**，不是计数变化。

---

## 4. N-29 判定

**判据 31a / 31b / 31c / 31e / 31f 全部在真实批次确认。**

按仓库纪律，N-29 由「已实施、未在真实批次验证」（`docs/212` §10）改为
**「已实施 + 已在真实批次验证」**。仍保留的限制见 §6。

---

## 5. 新发现：N-30（最终切片规划围墙）—— 本批次最重要的结论

### 5.1 现象

run 3 连过两个切片后，在最终切片 `slice-3-tasks` 的**规划阶段**失败，两轮升级、每轮 3 次尝试，
每轮都报同一组错误：

```
Must acceptance criterion AC-24 has no implementation task coverage.
（AC-25 / AC-26 / AC-29 / AC-30 同）
```

| 轮 | attempt 0 | attempt 1 | attempt 2 | 结果 |
| --- | --- | --- | --- | --- |
| 第一轮 | 5 条（taskCount 19） | 5 条（19） | 5 条（27） | `PLANNING_FAILED` → 升级 → 批准 → 从头重规划 |
| 第二轮 | 3 条 | 5 条 | 4 条 | `SLICE_PLANNING_FAILED` → 运行终止 |

**任务数从 19 涨到 27，那 5 条始终覆盖不上。**

### 5.2 机制（file:line）

| 环节 | 位置 | 事实 |
| --- | --- | --- |
| 覆盖规则 | `validateImplementationCoverage.ts:32` | 每个 Must AC 必须被 **BACKEND / FRONTEND / DATABASE** 任务引用 |
| 类型白名单 | `validateTestFirstPlan.ts:32` | `IMPLEMENTATION_TYPES = ["BACKEND","FRONTEND","DATABASE"]` |
| 那 5 条 AC | 库内实值 | AC-24 `docker build`/`docker run`、AC-25 容器重启数据保留、AC-26 非 root、AC-29 容器日志无明文密钥、AC-30 README + `pnpm test` |
| 只进最终切片 | `acceptanceCriteria.ts:184-192` | 全局性 AC **只归入最终切片** |
| **规则从未下达** | `PlanningGraph.ts` 的 `acHint` | 只说「每个 AC 至少被**某个**任务的 `acKeys` 引用」+「每个 Must AC 要有 TEST 任务」，**从未说覆盖者必须是实现类** |

**结论**：规划器把容器类 AC 挂到 `DEPLOY`/`BUILD`/`TEST` 上是**正确**的（那才是它们的归属），
但覆盖规则只认 BACKEND/FRONTEND/DATABASE。**这是一条模型无从得知的规则**，因此三次修复轮
只能靠猜，猜不中就整次运行止步。

### 5.3 为什么这是「围墙」而不是偶发

- 切片 1、2 **不含**这 5 条（全局性 AC 只进最终切片）⇒ 它们一次就过。
- 所以**任何**走到最终切片的 run 都必然撞上它；走到之前就死的 run 只是没机会撞。
- 历史上同一形状反复出现（`workflow_events` 实查）：`slice-3-tasks`（本次）、`slice-2-auth`、
  `slice-4-runtime-deployment-docs`（10-20）、`slice-1`×3（10-16）、`slice-3-login-tokens` 与
  `slice-4-create-list-search`（10-15）、`S2`（10-14）。
- **这解释了 L1-M4x 系列为何从未有一次到达交付段**——不是流程走不稳，是最后一道门打不开。

### 5.4 处置

已开工 **PL-M31**（`docs/214`）：把这条规则写进 `acHint`。**不动校验器**——PL-M1（`docs/160`）
当初就是要报这 5 条，规则本身是对的；缺的是**把规则告诉模型**。

---

## 6. Known Issues（本批次暴露、未在本阶段修）

1. **`fixTaskType` 合法率低**：全库 `REPLAN` 结果普查 45 条——`BACKEND` 10、`TEST` 7（合法 **17/45 = 38%**）；
   `DOCUMENTATION` 2、`REORDER_TASKS` / `REPLAN` / `none` / `ENV_FIX` / `IMPLEMENTATION` / `INFRA` /
   一段自由文本各 1（**非法 9/45 = 20%**）；其余 19 条为空。`DOCUMENTATION` **不是 `TaskTypeSchema`
   成员**。run 2 正是死在这里（31b 判失败是对的，但代价是一整条链）。
   **未登记为缺陷**：尚未指到「应当在何处校验并反馈」的 file:line。
2. **上游 429 仍在打断任务**：run 3 切片 2 的 `TASK-009` 在第 21 轮被
   `429 Upstream request failed: Endpoint is unavailable.` 打断（供应商侧，非平台缺陷）。
3. **规划失败会重生成全部规格**：升级重试从 api/database/ui spec 重新开始，代价高。

---

## 7. 撤回一条此前的误判

批次进行中我曾把 20 条 `workflow_run_id IS NULL` 且 `PENDING` 的任务报成「未解释的孤儿任务」。
**该判断错误，撤回**：`workflowRepositories.ts:384-399` 每次启动工作流时**主动按
`workflow_run_id IS NULL` 读出计划任务**，再插入 `origin=RUNTIME`、`plan_task_id` 指向它们的
运行期副本。那 20 条是**计划本身的持久化记录**，保持 PENDING 正常。已核实 run 2 的 10 个
RUNTIME 任务 `plan_task_id` 全部非空。

---

## 8. Acceptance Result

**N-29 判「已在真实批次验证」**（31a/31b/31c/31e/31f 全确认）。

**L1-8 验收距离未缩短**：三个 run 的 `真成功率` 与 `staging 段交付率` 仍为 **0.0%**，CI / DEPLOY /
VERIFY **一次都没启动过**。本批次买到的是：链路第一次连过两个切片 + 找到了那道确定性的门（N-30）。

---

## 9. Next Phase Boundary

**未开始事项（STOP）**：

1. **PL-M31 的批次验证**——已在 `l1-m4s` 批次里跑（本记录写作时进行中）。
2. **交付段（CI / DEPLOY / VERIFY）零覆盖**——至今没有任何一次运行进入过。
3. **`fixTaskType` 校验**（§6 第 1 项）未登记、未修。
4. **N-27**（空转通过）未修；**N-28**（两步修复）任务书已立、未实施；**N-25** 按裁定留到 L1-8 之后。
