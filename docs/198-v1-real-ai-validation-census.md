# 198 · V1 Real AI Validation 十二项 —— 库内证据普查（离线只读，零配额）

> 立项：2026-10-20。用户指令：「先去比对这 12 项」「落档，然后开一批 E1×3」。
> 普查对象：`docs/17-acceptance-checklist.md` §「V1 Real AI Validation」（12 项，**全部未勾**）。
> 性质：**这不是功能开发阶段，是一次只读普查**——判「这 12 项在真实链路上是否已被行使过」。
> 证据面：`ai-se-postgres-1` 全库（`agent_runs` / `tool_calls` / `tasks` / `deployments` / `requirements` / `workflow_events`）
> ＋ 生产代码路径（`apps/server/src/index.ts`、`packages/agent-core/src/planning/`）。
> 状态：**普查完成。未改任何 `src/`、未跑任何批次、零配额。**

---

## 1. 结论

**12 项全部有真实库内证据。** 其中：

- **10 项判「已行使」**（1 / 2 / 3 / 4 / 5 / 6 / 7 / 8 / 9 / 10）；
- **1 项判「已行使」但带记账缺口**（11 项 recovery 有效，另发现**两条 token 记账缺口**）；
- **1 项判「部分行使」**（12 项 final delivery：**staging 真交付、production 只在演练里成功过**）。

⇒ **这 12 项缺的多半不是能力，而是把已有结论落成勾选与归因**（用户 2026-10-20 的初判成立）。
但**第 12 项要按「部分达成」记**，第 1 / 2 项附带**两条记账缺口**须另立项。

---

## 2. 逐项证据

| # | 项 | 库内读数 | 判定 |
| --- | --- | --- | --- |
| 1 | **Real Planner LLM** | `apps/server/src/index.ts:147-159`：`config.llmProvider === "openai"` ⇒ `LivePlanningModel`，否则 `ScriptedPlanningModel`；`.env` 为 `LLM_PROVIDER=openai`（真实端点 + `deepseek-v4.1-flash`）。**807** 次 `planning-agent` run（`PLANNING_STARTED` 807）；**`TASK_DAG_VALIDATION_FAILED` 1,772 / `PLANNING_REPAIR_REQUESTED` 1,194**——真模型的 schema 才会失败、才需要修（脚本化模型不会）；**782** 份 `specifications`（561 份 > 500 字符） | ✅ **但用量未落账**（§4 缺口 ①） |
| 2 | **Real Agent LLM** | `professional-deep-agent` 共 **2,911** 次 run，其中 **2,753** 次带真实 `token_usage`（`input_tokens` 合理量级）；另 `coding-agent` 1 次带用量 | ✅ **但 `delivery-orchestrator` 未落账**（§4 缺口 ②） |
| 3 | **Real Tool Calling** | **63,213** 次 `tool_calls`、**16** 种工具，成功/失败混合（见 §3 表）；`tool_call_started`/`tool_call_finished` 事件各 54,329 | ✅ |
| 4 | **Real PRD → Planning** | 13 个需求中 **E1 的 `raw_content` = 8,445 字符真 PRD**（`description` 仅 26 字符）；`packages/agent-core/src/planning/PlanningGraph.ts:257` 把 `rawContent` 放进 `inputForStage` ⇒ **确实进了各阶段提示词**；其余 12 个需求 `raw_content` 300–650 字符 | ✅（E1 是真 PRD；其余是短需求陈述） |
| 5 | **Real Planning → Task DAG** | **7,082** 条 `task_dependencies`；`TASK_DAG_VALIDATION_STARTED` 1,921 | ✅ |
| 6 | **Real Multi-Agent execution** | **7** 个职业 agent 各有真实 run：qa 1,087 / backend 985 / planner 444 / reviewer 224 / devops 98 / database 39 / frontend 34 | ✅ |
| 7 | **Real Code generation** | `write_file` **2,054** 成功 + `edit_file` **1,634** 成功；`agent_artifact_created` 21,941 | ✅ |
| 8 | **Real Test execution** | `run_unit_test` **9,475**（6,757 成功 / **2,615 失败**）+ `run_build` 6,276 + `run_lint` 3,362 | ✅ |
| 9 | **Real failure** | **230** 个 FAILED 任务、51 CANCELLED；失败检查 2,615 次单测失败 / 1,588 次构建失败 | ✅ |
| 10 | **Real Dynamic Re-plan** | `origin='DYNAMIC'` **107**；`-REPLAN-` 66 + `-DEBUG-` 61；`creation_reason` 非空 107 | ✅ |
| 11 | **Real recovery** | 54 个任务有 `resolved_by_task_id`；沿链走到头（PL-M19 语义）：**16 条终点 SUCCESS（真救回）**、13 条终点 FAILED（救援失败）、25 条终点 PENDING（中途弃链） | ✅（**16 次真实救回**） |
| 12 | **Real final delivery** | `deployments` 共 8 行：**staging SUCCESS ×5**、staging FAILED ×1、**staging ROLLED_BACK ×1**（回滚链真跑过）、**production SUCCESS ×1**。其中 E1 链贡献 staging SUCCESS 2 次（`716eb98d` = L1-M4m run 2，10-19；`57f98bf9` = **G/L4 系列**，10-14） | ⚠️ **部分行使**（§5） |

### 2.1 工具调用全表（第 3 / 7 / 8 项的证据面）

| 工具 | 调用 | 成功 | 失败 |
| --- | --- | --- | --- |
| `read_file` | 19,337 | 18,731 | 606 |
| `run_unit_test` | 9,475 | 6,757 | 2,615 |
| `run_build` | 6,276 | 4,671 | 1,588 |
| `run_command` | 5,744 | 5,718 | 26 |
| `list_directory` | 5,205 | 4,670 | 535 |
| `git_status` | 3,488 | 3,446 | 42 |
| `run_lint` | 3,362 | 2,943 | 417 |
| `search_code` | 2,567 | 2,368 | 199 |
| `write_file` | 2,290 | 2,054 | 236 |
| `submit_result` | 1,968 | 1,968 | 0 |
| `git_diff` | 1,821 | 1,818 | 3 |
| `edit_file` | 1,654 | 1,634 | 20 |
| `run_ci` | 11 | 11 | 0 |
| `deploy_release` | 7 | 7 | 0 |
| `verify_release` | 7 | 7 | 0 |
| `rollback_release` | 1 | 1 | 0 |

---

## 3. 两条 token 记账缺口（**新发现，建议另立项**）

```sql
SELECT input->>'runtime' AS runtime, count(*) AS runs,
       count(*) FILTER (WHERE token_usage ? 'input_tokens') AS with_usage
FROM agent_runs WHERE input->>'runtime' IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;
```

| runtime | runs | 带用量 |
| --- | --- | --- |
| `professional-deep-agent` | 2,911 | **2,753** |
| **`planning-agent`** | **807** | **0** |
| **`delivery-orchestrator`** | **23** | **0** |
| `coding-agent` | 1 | 1 |

**缺口 ①（规划阶段）**：规划器**是真模型**（§2 第 1 项已由代码路径确证），但 **807 次 run 的 `token_usage` 全部为空**
⇒ **规划阶段的成本在库里完全不可见**。而规划恰恰是全流程里**提示词最长**的一段（E1 的 PRD 8,445 字符 × 多阶段）。
`PlanningAgent` 的 `onRunStarted` 只传 `maxIterations: PLANNING_STAGES.length`，**没有用量回写**。

**缺口 ②（交付编排）**：`delivery-orchestrator` 23 次 run 同样零用量（量小，但同类）。

**与 N-20 的关系**：N-20 是**多计**（两级相加翻倍），本条是**不记**——**方向相反、同属记账口径**。
**影响**：批次的 `week_tokens()` 守卫与 `tokenUsage` 指标**都只统计了 agent 段**；
规划段与交付段的花费**不进守卫**。⇒ 守卫并非 fail-open（它不会放行坏值），
但它**看不见的这两段**是**结构性漏统计**。**建议立项，不阻塞 L1-8。**

---

## 4. 第 12 项为什么判「部分行使」

```
staging     SUCCESS     Delivery drill (D-4/N6)   42b226c1  10-07 04:59
production  SUCCESS     Delivery drill (D-4/N6)   42b226c1  10-07 04:59   ← 唯一的 production
staging     SUCCESS     E1                        57f98bf9  10-14 11:13   ← G/L4 系列
staging     SUCCESS     E1                        716eb98d  10-19 17:50   ← L1-M4m run 2
```

- **staging：真交付 ✅**——E1 链两次把 staging 段跑通（含 CI / staging DEPLOY / staging VERIFY）。
- **production：只在演练里成功过 ⚠️**——唯一的 production SUCCESS 属于需求
  **「Delivery drill (D-4/N6)」**（2026-10-07），**不是任何 E1 批次链**。
  E1 链的最好成绩是 **`WAITING_APPROVAL`**（`716eb98d` 与 `57f98bf9` 都停在这里）——
  即**走到了生产审批关口**，但没有跨过去。
- **回滚链 ✅**：`staging ROLLED_BACK ×1` + 一次 `rollback_release` 工具调用 ⇒ L1-5 的回滚路径真跑过。

⇒ 建议记法：**「staging 已行使；production 仅在演练中行使；审批关口已到达、未跨越」**。

---

## 5. 一处精度更正（不影响任何结论）

E1 这个需求**也被 G/L4 批次系列驱动过**：`57f98bf9`（10-14）出自
`packages/eval/results/g/l4/run-3.json`，**不是 L1-M4x 系列**。
⇒ 台账「三十次 E1 run 里第一次 staging 段成功」（`docs/17` §自治 L1 · L1-8 行）**结论不受影响**，
但「三十次」是**按 L1-M4x 系列计**的；**跨系列合计，E1 的 staging 成功是 2 次**。

---

## 6. Modified Files

| 文件 | 动作 |
| --- | --- |
| `docs/198-v1-real-ai-validation-census.md` | **新增**（本文件） |

**零 `src/` 改动、零测试改动、零依赖改动、零数据库写操作。** 全部查询为只读 `SELECT`。

---

## 7. Implementation

**无。** 本文件是普查记录，不是实施。

---

## 8. Architecture Changes

**无。**

---

## 9. Dependencies

**无新增、无升级、无删除。**

---

## 10. Tests

**不适用**——零代码改动。普查的可复现命令见各节 SQL 块。

---

## 11. Lint

**不适用**（同上）。

---

## 12. Typecheck

**不适用**（同上）。

---

## 13. E2E

**不适用**（同上）。**未跑任何批次**——本文件是开批**之前**的离线读数。

---

## 14. Known Issues

1. **这 12 项仍未在 `docs/17` 上勾选**——本文件只给证据，**勾选动作应在下一批判定时一并做**
   （第 12 项按「部分行使」记）。
2. **两条 token 记账缺口未修**（§3）——建议另立项，**不阻塞 L1-8**。
3. **第 12 项的 production 缺口**：E1 链从未跨过生产审批关口。这**不是缺陷**（L1 策略下生产需人工审批，
   而批次不代人批准），但**「Real final delivery」若要完整勾选，需要一次带人工批准的端到端**。
4. **本普查是快照**：读数取 2026-10-20 全库现状。**下一批跑完后须重跑**（尤其第 10 / 11 / 12 项会变）。
5. **第 11 项的 25 条 PENDING 链**未逐条追因——它们多为批次中止或工作流判死时留下的半截链。
   **不构成「恢复失败」的证据**（PL-M19 的判定只对走到头的链负责）。

---

## 15. Acceptance Result

**NOT APPLICABLE（普查，非实施）。** 交付物是「12 项的库内证据与判定」，已全部给出。

---

## 16. Next Phase Boundary

**未开始事项（STOP）**：

- **`docs/17` 的 12 项未勾选**——留待下一批判定时一并处理。
- **两条记账缺口未立项**（§3）。
- **下一批（E1×3）开工前的三项前置**（本文件写完后逐项执行，**执行记录见本节下方的追加块**）：
  ① `probe-n13-e1-workspace.ts` 入库（`docs/192` Known Issue 6）；
  ② 停并重启 `:47558`（本会话改过 `apps/server/src/config.ts`）；
  ③ 先跑 `deniedPaths` 普查。

### 16.1 前置执行追加块（2026-10-20）

**① 探针已入库** —— `apps/server/scripts/probe-n13-e1-workspace.ts`。相对临时脚本的三处改进：
接受工作区路径参数、工作区缺失时 **SKIP（exit 0）**；**泄漏检测不再自匹配**（旧脚本按 `n13-e1` 过滤，
会匹配到探针自己的命令行）；新增 **`--serial`** 以模拟沙箱（`--test-concurrency=1`），
因为**宿主机多核会并发跑测试文件、把生产形态的缺陷藏起来**（`probes-must-match-production` 又一例），
产物里记 `concurrency` 字段标明本次是哪种模式。

**② `:47558` 已停并重启**（旧进程 18h32m，内存里仍是 600s）。重启前确认库内 `RUNNING`/`PENDING` 工作流为 **0**。
新进程加载 `config.ts:57` 的 `900_000`。

**③ `deniedPaths` 普查已跑**（限 `write_file`/`edit_file` 失败，L1-M4m 窗口）：
`scripts/selfcheck.mjs` 7 / `scripts/verify-contract.mjs` 5 / `scripts/lint.mjs` 4 / `scripts/typecheck.mjs` 3 /
`scripts/build.mjs` 2 —— **全部由 N-18 处理**；`docs/ac-coverage.md` 3 / `docs/S2-architecture.md` 1 ——
**没有任何 agent 能写**（`docs` 不在五类 agent 的 `writePaths` 里）⇒ **预测下一堵墙是 `docs/`**，
同族第六例。该预测已写进本批脚本的 watch item 3。

### 16.2 探针读数（2026-10-20，`packages/eval/results/n13-e1-probe/e1-workspace-ab.json`）

工作区 `~/Desktop/study/ai-se-eval/E1/run-1`，`--ac AC-01`，生产预算 120s：

| 模式 | A1（生产形态） | A2（剥掉 `--test-timeout`） |
| --- | --- | --- |
| **宿主机默认（并发）** | 退出 / `code 1` / **20,714 ms** / TAP `tests 29 pass 25 fail 0 cancelled 4` | **挂死**（180s 窗口耗尽，TAP 空） |
| **`--serial`（模拟沙箱 `--cpus 1`）** | 退出 / `code 1` / **82,057 ms** / TAP 同上 | **挂死**（同上） |

**两个读数一起看才有意义**：串行 **82,057 ms ≈ 4 个挂死文件 × 20s**，正是 PL-M24 的机制
（`--test-timeout` 按文件计 × 沙箱串行），且**落在 120s 预算内**（余量 38s）——
与 `docs/192` 记录的 81,707 ms 吻合。宿主机默认模式的 **20,714 ms** 是并发跑出来的，
**如果只跑默认模式就会得出「余量很大」的错误结论**（`probes-must-match-production` 又一例）
⇒ 故探针把 `concurrency` 写进产物，`--serial` 是复现生产形态的必要开关。

### 16.3 批次已开（2026-10-20 15:22 CST）

`caffeinate -s -d -i bash packages/eval/scripts/l1-m4n-e1-x3.sh`，run 1 带 `--replan`。
生效策略：`failureStrategy=REPLAN / allowReplan=true / autonomyLevel=L1 / deployFailureStrategy=ROLLBACK`。
开批时周用量 **160,297,518 / 400,000,000**（窗口 2026-10-18 23:00 UTC）。
看门狗 `eval-batch-watchdog.sh --batch-pattern l1-m4n-e1-x3.sh --results-dir packages/eval/results/l1-m4n` 已挂。

---

### 16.4 勘误（2026-10-21）：§3 的「缺口 ②（交付编排）」**不成立**

**结论：`delivery-orchestrator` 零 `token_usage` 是正确的，不是记账缺口。** §3 把它登记为缺口是**错的**。

**核实（代码，不是形状）**：`apps/server/src/services/deploymentOrchestrator.ts` 中
`ChatModel` / `createOpenAI` / `invoke(` 的出现次数 **= 0**——该编排器

- 只构造 `new ToolRuntime({ tools: createDeliveryTools(...) })`（`:71`），
- 只执行交付类工具（CI / 部署 / 验证），
- **从不调用语言模型**。

⇒ 它没有 token 可记。§3 原文写「（量小，但同类）」——**「同类」这个前提从未被核实**，
是从「零用量」这个库内形状**倒推**出来的（正是 [[defect-registration-needs-code-proof]] 要防的那种推断：
形状只是假设，登记前必须指到 `file:line` **并证明它在实例里真的被走到**）。

**缺口 ①（规划阶段）经复核仍然成立，且比原文更严重**：`PlanningAgent` 用的是**真模型**
（`LivePlanningModel`），但

- `PlanningAgentResult`（`packages/agent-core/src/planning/PlanningAgent.ts:67-77`）**没有用量字段**；
- `PlanningGraph.ts` 里 `usage` / `tokenUsage` 的出现次数 **= 0**——**整条规划流水线从未采集用量**；
- 两处 `onRunFinished`（`:215` 成功 / `:256` 失败）**都没有传 `tokenUsage`**，
  而消费方 `agentRunService.ts:491-501` 的 `onRunFinished` **是会写 `tokenUsage` 的**
  ——所以问题在**上游没有值**，不在落盘侧。

⇒ **缺口 ①的修法不是「补一行回写」，而是把用量贯穿整条规划流水线**（每个阶段的模型调用 → 聚合 →
`PlanningAgentResult` → `onRunFinished`）⇒ **属大改动**，须单独立项与裁定，**不在本文件的普查范围内**。

**对 §3 结论的影响**：§3 的**方向**（守卫看不见规划段）仍然成立，但**范围收窄为一段**（只有规划段，
没有交付段）。守卫的漏统计比原文说的**少一半**。

---

### 16.5 勾选已落（2026-10-21）：§14 Known Issue 1 关闭

按本文件的普查结论，`docs/17-acceptance-checklist.md` §「V1 Real AI Validation」的 12 项**已勾选**：

- **第 1–11 项 → `[x]`**，每项附本文件的具体读数与 `file:line`；
- **第 12 项（Real final delivery）→ 保持 `[ ]`**，标注「**部分行使**：staging 真交付 ✅ /
  production 仅在演练中成功 / E1 链止于 `WAITING_APPROVAL`」——
  按 [[acceptance-under-claim]]（边界项宁标「延期/部分替代」也不勾选）**不勾**。

**同一次动作里发现的口径缺口**：该节的**三个子节**
（Dynamic Workflow 6 项 / AI Decision Validation 5 项 / External Environment 6 项）
**不在本文件普查范围内**，因此**一律留空**，并在节末写明 STOP——
不凭推断补勾（[[verdict-rules-need-a-census]]）。其中 `External Environment` 的
VLM / Figma / GitHub / GHCR / Production 已在 `docs/58` 判为 **BLOCKED BY EXTERNAL CONFIG**。

⇒ §14 Known Issue 1 关闭；**新增一条**：三个子节的普查待另起（见 `docs/202` §9）。
