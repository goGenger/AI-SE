# 226 · V1 Real AI Validation 三个子节 —— 库内证据普查（离线只读，零配额）

> 立项：2026-10-23。用户指令：「开始普查」。
> 普查对象：`docs/17-acceptance-checklist.md` §「V1 Real AI Validation」下的**三个子节共 17 项**
> ——Dynamic Workflow（6）／AI Decision Validation（5）／External Environment（6）。
> 这三节在 `docs/198` 的普查范围之外，该文件末尾留了收口动作：
> 「另起一次普查（同 `docs/198` 的只读口径）后再勾，**不凭推断补勾**」。
> 性质：**只读普查，零配额、零 `src/` 改动、零数据库写操作**。
> 口径：与 `docs/198` 一致——全库 + 生产代码路径双向核对。

---

## 1. 结论

| 子节 | 项数 | 可勾 | 不勾 | 外部阻塞 |
| --- | --- | --- | --- | --- |
| Dynamic Workflow | 6 | **6** | 0 | 0 |
| AI Decision Validation | 5 | **5** | 0 | 0 |
| External Environment | 6 | **1**（Real LLM） | 5 | 5 |
| **合计** | **17** | **12** | 5 | 5 |

**12 项判「已行使」并勾选**；**5 项维持不勾**，且**全部是外部环境阻塞**（VLM / Figma /
GitHub / GHCR / 远程生产），与 `docs/58` 的 `BLOCKED BY EXTERNAL CONFIG` 判定一致。

**一个附加发现**：`docs/17` 主表第 12 项 `Real final delivery` 的阻塞条件**已经消失**——
`l1-m4u` 三次运行各有一次真实 production 部署（真镜像、真健康检查）。
用户 2026-10-23 裁定**按「审批门被真实走通」口径勾选，并在条目内写明批准主体是 harness**（§5）。

**当前库里总量**（普查分母）：`tasks` 5,711 · `tool_calls` 87,895 · `agent_runs` 4,510 ·
`task_dependencies` 9,203 · `workflow_runs` 401 · `workflow_events` 241,182 · `deployments` 26。

---

## 2. Dynamic Workflow（6 项，全部可勾）

| # | 项 | 库内证据 | 判定 |
| --- | --- | --- | --- |
| 1 | **无人工修改 Task** | 平台**没有任务编辑端点**——全部写操作端点只有：创建项目/需求/工作流、`analyze`、`start`、`policy`、`cancel`、`retry`、审批 approve/reject、环境与部署回滚、MCP binding/apps、模型配置（`apps/server/src/routes/*.ts`）。`tasks` 的每一次变更都由 `WorkflowEngine` / 执行器发起；`workflow_events` 里**不存在**「人工改任务」类事件。**受测窗口（`l1-m4u`，10-22 14:00–23:30 UTC）内的人工动作只有 4 次审批，全部 `APPROVED`** | ✅ |
| 2 | **无人工修改 Workflow** | 同上。人工可用的工作流动作只有 `pause` / `resume` / `cancel` / `retry`——**都不是修改**。全库 `WORKFLOW_PAUSED` 仅 **2** 次（09-29）、`WORKFLOW_RETRIED` **6** 次（09-28/29），**均不在 E1/L1 系列窗口内**；`l1-m4u` 窗口内**零次** | ✅ |
| 3 | **Failure 自动产生新任务** | `origin='DYNAMIC'` **257** 条（`docs/198` 时为 107）：`-DEBUG-` **149**（SUCCESS 91 / FAILED 34 / 未完成 24）、`-REPLAN-` **107**（SUCCESS 51 / FAILED 32 / 未完成 24）、其他 1。运行时注入的依赖边 **552** 条（DYNAMIC 488 + 64 已停用） | ✅ |
| 4 | **Re-plan 改变执行拓扑** | `task_dependencies` 中 **233 条 `active=false`**（DYNAMIC 64 + RUNTIME 169）——由 `applyReplan` 停用原出边；同时插入 **552** 条新边。`REPLAN_STARTED` / `REPLAN_COMPLETED` 各 **128**。**深度有界**：`-REPLAN-1` 128 条、`-REPLAN-2` 24 条，**无第三层** | ✅ |
| 5 | **Retry / Recovery 正常** | 沿 `resolved_by_task_id` 链走到头（PL-M19 语义）算根任务：**65 条终点 SUCCESS**（真救回）、46 条仍在链中、18 条终点 FAILED。更直接的配对证据：**DEBUG SUCCESS + 配套 REPLAN SUCCESS 共 46 对**（诊断做完了、重试也跑成了） | ✅ |
| 6 | **无死循环** | `WORKFLOW_DEADLOCK` 事件 **0** 条（兜底分支从未触发）。replan 最深 2 层（见第 4 项）。嵌套诊断（`workflow_runs.error` 含 `Diagnose Diagnose`）历史 **9** 条，**全部在 10-19/10-20/10-21，N-29 修复（PL-M30，10-21）之后为零** | ✅ |

---

## 3. AI Decision Validation（5 项，全部可勾）

| # | 项 | 库内证据 | 判定 |
| --- | --- | --- | --- |
| 1 | **Planner decision verified** | 规划器的产出**被平台逐条校验**，不是直接接受：`TASK_DAG_VALIDATION_FAILED` **1,789** 次、`PLANNING_REPAIR_REQUESTED` **1,207** 次。拒绝理由**具体到规则与任务**（展开 `validationErrors` 归类）：交付任务结构 **1,719 + 1,713**、**N4 测试先行 207**、越界引用 119、**PL-M1 实现覆盖 63**、全局 AC 归属 9 | ✅ |
| 2 | **Agent tool selection verified** | 各 agent 的工具画像**与其职责一致**，不是同一个通用工具集：backend 读 10,493 / 单测 5,928 / 构建 4,706 / 写 4,440；qa 读 9,186 / 单测 4,856 / 写 1,824；devops 以 `run_build` 676 / `run_lint` 332 为主；**reviewer 与 planner 以只读为主**（reviewer 读 3,270 / 搜索 796，写 **19**；planner 读 2,983 / 列目录 750，写 **28**）。⚠️ **两处如实更正**：初稿按「≥300 次」的阈值筛表，据此写过「reviewer 只读不写 / planner 只读」——**全量核对后两者各有 19 / 28 次写入**，断言改为「以只读为主」 | ✅ |
| 3 | **Agent code modification verified** | `write_file` **3,087** 成功 / 577 失败、`edit_file` **3,304** 成功 / 44 失败 ⇒ 代码确由 agent 写入。且写入之后**过验证门**：`TASK_VERIFICATION` 的 `verdict` 分布 **verified 1,680 / unavailable 484 / failed 199** | ✅ |
| 4 | **Agent failure recovery verified** | 见 §2 第 5 项：**46 对**「诊断任务 SUCCESS + 重试任务 SUCCESS」；其中 DEBUG 由 `targetTaskType` 的 agent 执行、诊断结论以 `fixTaskType` 交接给重试任务（N-29/PL-M30 语义） | ✅ |
| 5 | **3 次独立运行** | 批次 `l1-m4u`（10-22）**三次独立运行**，各自 4 个 `workflow_runs`（一片一个）、**提交互不相同**：`fe8ca24a` / `ab1bbf03` / `d4c6025d`。三次均 `chainCompleted=true`、`oraclePassed=true`、`deliveredSuccess=true`，均到达最终切片 `slice-tasks-crud-isolation` | ✅ |

### 3.1 第 5 项的逐次要读（避免「三次都完美」的误读）

| run | 提交 | 任务数 | staging 段 | 记录判定 |
| --- | --- | --- | --- | --- |
| 1 | `fe8ca24a` | 51 | CI ✅ / deploy ✅ / verify ✅ | 通过 |
| 2 | `ab1bbf03` | 55 | **CI 记 FAILED** / deploy ✅ / verify ✅ | **N-36 判据缺陷**：CI 失败后 replan 在同一次提交上成功，旧规则读到第一条失败行 |
| 3 | `d4c6025d` | 55 | CI ✅ / deploy ✅ / verify ✅ | 通过 |

⇒ **按 N-36 修正后的规则复算是 3/3**（`docs/224` §2.1 已同时公布两个数字）。
第 2 行**不是能力缺口**，是判据取错了行——该项判「已行使」的依据不受影响。

---

## 4. External Environment（6 项：1 勾 / 5 不勾）

| # | 项 | 证据 | 判定 |
| --- | --- | --- | --- |
| 1 | **Real LLM** | `.env`：`LLM_PROVIDER=openai`、`OPENAI_BASE_URL=https://opencode.ai/zen/go/v1`、`OPENAI_MODEL=deepseek-v4.1-flash`。真实调用量：`professional-deep-agent` **3,611** run（3,438 带用量）、`planning-agent` **842** run、`coding-agent` 1 run | ✅ |
| 2 | **Real VLM** | 生产代码里**没有任何 VLM 调用**；`vlm` 只出现在 `packages/visual` 与 `apps/server/src/services/visualFixLoop.ts`——两者都**未接入生产链路**（README §接线状态） | ❌ **BLOCKED BY EXTERNAL CONFIG** |
| 3 | **Real Figma** | `figma` 只出现在 `packages/visual` 的分析器与 `packages/shared` 的 schema 里，同属未接线子树；无任何 Figma REST 调用记录 | ❌ **BLOCKED** |
| 4 | **Real GitHub** | `CI_PROVIDER=local`（默认值即 local）、`GITHUB_TOKEN` **未配置**；`ci_runs` **18** 条全部由本地适配器产生。代码里有 `github` 分支但从未行使 | ❌ **BLOCKED** |
| 5 | **Real GHCR** | `deployments` **26** 行，镜像**全部是本地 `ai-se-app:<sha>`**，无一条指向 registry | ❌ **BLOCKED** |
| 6 | **Real Production** | **新证据**：`l1-m4u` 三次运行的 production 部署**真实成功**（真镜像、`/health` 与 `/ready` 各 200、有 `deploymentId`，见 §5）。**但目标是本地 Docker（`http://127.0.0.1:18081`）**，不是远程生产环境 | ❌ **不勾**：本地生产环境已跑通，远程生产仍缺目标环境 |

---

## 5. 补充：`Real final delivery`（主表第 12 项）的阻塞条件已消失

`docs/198` §4 当时的判定是「staging 真交付 ✅／production 只在演练里成功过 ⚠️」，
理由是「E1 链最好成绩是 `WAITING_APPROVAL`——走到了生产审批关口，没有跨过去」。

**`l1-m4u` 三次运行都跨过去了**：

| run | workflow | 环境 | 状态 | 镜像 | 健康检查 |
| --- | --- | --- | --- | --- | --- |
| 1 | `88aa62ef` | production | SUCCESS | `ai-se-app:fe8ca24a…` | — |
| 2 | `790253df` | production | SUCCESS | `ai-se-app:ab1bbf03…` | — |
| 3 | `aff03c39` | production | SUCCESS | `ai-se-app:d4c6025d…` | `/health` 200、`/ready` 200 |

任务 `T-13` 的 `output` 里带 `deploymentId`、`ciRunId`、`gitCommit`、`endpoint`——
**不是空转**。

**裁定（用户 2026-10-23）：勾选，并写明批准主体是 harness。** 口径定为
「**审批门被真实走通**」——即平台的生产审批环节确实被行使过（审批实体创建、批准、
状态迁移、可追溯），而不是要求「一个人类坐在屏幕前点击」。

**这条边界必须留在条目里**：批准由 eval harness 代行（PL-M33 / `docs/216` 明写
「harness 就是评测里的那个『人』，且每次都记账」）。把主体写清楚、而不是让读者自己猜 ——
**这是本条唯一诚实的勾法**。

因此 `docs/17` 该条记为已勾，条目内包含：三次 production 部署的 workflow id 与镜像、
健康检查读数、`output` 里的 `deploymentId` / `ciRunId` / `gitCommit`，以及**批准主体＝harness**。

---

## 6. 两处观察（**不是缺陷主张**）

1. **规划段用量仍为 0**：`planning-agent` 842 次 run、带用量 **0**。这是**预期内的**——
   N-25 / PL-M41 今天（10-23）才落地，而库里最后一次规划 run 早于平台重启（09:47）。
   **下一批 `l1-m4v` 是本项的第一个检验场**（判据 28a）。
2. **校验错误文本里有 9 条被脱敏成 `…ta[REDACTED]`**：形如
   `Implementation task backend-ta[REDACTED] must depend on test task test-ta[REDACTED]`。
   脱敏规则 `CREDENTIAL_SHAPED_PATTERN`（`packages/observability/src/index.ts:55-56`）
   **不能直接解释**这个位置的截断，可能是 `knownSecrets` 子串匹配所致，**成因未查**。
   影响：**只降低可读性，不影响任何判定**。**未登记为缺陷**——按纪律，指不到机制就不入账。

---

## 7. Modified Files

| 文件 | 动作 |
| --- | --- |
| `docs/226-phase-v1-real-ai-validation-census-2.md` | **新增**（本文件） |
| `docs/17-acceptance-checklist.md` | 勾选 12 项、为不勾的 5 项补写原因、更新该节 STOP 段 |

**零 `src/` 改动、零测试改动、零依赖改动、零数据库写操作。全部查询为只读 `SELECT`。**

---

## 8. Implementation

**无。** 本文件是普查记录。

---

## 9. Architecture Changes

**无。**

---

## 10. Dependencies

**无新增、无升级、无删除。**

---

## 11. Tests

**不适用**——零代码改动。全部结论来自只读 SQL 与代码实查。

---

## 12. Lint / 13. Typecheck / 14. E2E

**不适用**——同上。

---

## 15. Known Issues

1. **`Real final delivery` 已按「审批门被真实走通」口径勾选，批准主体是 harness 而非真人**（§5）
   ——这是**明写的边界**，不是缺陷。若日后要求「真人点击」，该条须改回不勾。
2. **`Real Production` 与第 12 项的关系**：production 部署在**本地 Docker** 上真实发生过，
   但「Real Production」按外部环境口径仍判阻塞。两项**不可互相兑换**。
3. **第 2 项「无人工修改 Workflow」的证据是「能力面 + 事件面」的否定式**（没有编辑端点、
   没有编辑事件），不是对每一次变更的溯源。若日后新增任务编辑端点，本项须重新普查。
4. **脱敏截断（§6 第 2 条）成因未查**。

---

## 16. Acceptance Result

**三个子节 17 项中 12 项判「已行使」并已勾选，5 项维持不勾且原因明确（全部外部阻塞）。**
另**主表第 12 项 `Real final delivery` 同批翻为已勾**（用户 2026-10-23 裁定，批准主体注明为 harness）
⇒ 本次普查共落 **13 个勾**，`docs/17` 未勾项 **58 → 45**。
`docs/198` 留下的收口动作**已执行完毕**——三个子节不再有「未普查」的空白。

---

## 17. Next Phase Boundary

**未开始事项（STOP）**：

1. **五个外部阻塞项**（VLM / Figma / GitHub / GHCR / 远程生产）——需要凭据与目标环境，
   不是平台侧工作。
2. **批次 `l1-m4v`** 仍未起跑（用户选择手动、晚间）；它同时是 N-25 判据 28a–28e 的检验场。
3. **N-37**（崩溃恢复绕过状态机）已登记未修。
