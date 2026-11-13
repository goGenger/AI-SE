# 108 · AI-SE 平台加固整改文档（分阶段实施）

> 来源：用户任务书《AI-SE 平台加固任务书 v1》（2026-09-29，基于 2026-09-28 as-built 架构评审）。
> 定位：**整改计划文档**，不是实施记录。每阶段的**任务书**自 `docs/109` 起编号（如 109 = P0 任务书），其**实施记录/基线报告**顺延其后（P0 记录 = `docs/110`）。
> 任务书自述「每个任务开工前第一步是核对代码」——本文档在计划阶段即完成**首轮现状核对**（§2）；与任务书描述不符处，以代码为准并标注调整。

## 1. 目标与总原则

目标：把「结果可信、并行安全、成本可控」三件事做扎实，再谈新功能。

承接任务书 §0 六条总原则（先量后改 / 先写失败用例 / 不破坏架构红线 / 特性开关灰度 / 一阶段一交付 / 冻结新功能），并按本仓既有约束落地：

- **架构红线**（docs/02、AGENTS.md §10）：Tool Runtime 是唯一执行路径；所有执行经 Sandbox；禁止第二套 Permission / Approval / Audit / 错误码 —— 新增判定只在现有体系内**扩展**（如 `errorType` 枚举加一项）。
- **治理不破**：任何新的执行、验证、合并动作都必须走既有 `claim → executor → ToolRuntime → 审批/审计`，不得旁路。
- **可回退**：涉及判定与解析的改动带特性开关，先并行观测 → 再切换 → 最后删旧路径。

## 2. 首轮现状核对（任务书 vs 代码）

| 任务书论断                                | 代码现状（证据）                                                                                                                                           | 结论 / 调整                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| T1「以 Agent 自报为准（docs/97）」        | `ProfessionalAgent.parseOutcome` 决定 outcome；`workflowTaskExecutor.execute` 把 outcome 映射为任务状态（规则记录于 docs/97）                              | **确认**。验证门插入点＝`WorkflowTaskExecutor` 的包装层（先例：`RoutingWorkflowTaskExecutor`，`deploymentOrchestrator.ts:699`） |
| T2「自由文本 JSON + repair/salvage」      | docs/98/102/103 + `ProfessionalAgent.ts`（`repairNearJson` / `salvageOutcome` / `answerText`）                                                             | **确认**。降级率可直接统计 `tasks.output.parseRecovery`                                                                         |
| T7「checkpoint 在内存」                   | `agent-core/src/graph/AgentGraph.ts:381` `new MemorySaver()`；`DeepAgentLLMProvider.ts:48` `checkpointer: false`                                           | **确认**。落到 Postgres 需**新依赖**（`@langchain/langgraph-checkpoint-postgres`）→ T7 评估必须含依赖决策                       |
| T9「Redis 职责与 Postgres 重叠」          | Redis 唯一用途＝`RedisCancellationStore`（`agent-run:<id>:cancel`，1h TTL；执行器每 250ms 轮询；`app.ts` 健康检查）                                        | **不成立**：跨进程取消信号是明确职责，Postgres 未承担 → **保留**；T9 降级为「职责文档化」                                       |
| T8「沙箱出口策略」                        | `packages/sandbox/src/index.ts:13,54,217`：`network: "none"` 为默认                                                                                        | **默认已禁止出站**。剩余工作＝白名单策略（如需）+ 注入红队夹具 + 日志脱敏测试                                                   |
| T3a/T3b「并行任务是否共享工作区」         | `workflow-engine/src/scheduler.ts` `readyTaskIds` 只按依赖状态判定；`TaskPlanItem` 无 `touchedPaths`；任务共享 `AGENT_WORKSPACE_ROOT` 下的 `workspacePath` | **确认**：当前无路径感知、无隔离，任务在同一工作区直接并发                                                                      |
| T6「只有单次 run 上限」                   | 单任务：`TASK_TIMEOUT_MS`（默认 600000）+ `maxIterations: 50`；工作流：`WorkflowPolicySchema` 无预算字段                                                   | **确认**。注意该 schema 是 `.strict()`：加字段需同步 DB policy、控制台表单与测试                                                |
| T0「缺少量化证据」                        | 有 `agent_runs.tokenUsage / estimatedCost / duration / status / errorType` + `workflow_events`；无固定评测集与 oracle                                      | **确认**                                                                                                                        |
| T4「taskContextBuilder 理解仓库能力不明」 | `apps/server/src/services/taskContextBuilder.ts`（78 行）；工具来自 `createPhase1Tools()`（`tool-runtime/src/tools/index.ts`）                             | **确认**。审计步骤可直接产出结论                                                                                                |
| T5「8 个串行 LLM 阶段」                   | `PlanningGraph.ts` 8 阶段，每阶段一次结构化输出调用                                                                                                        | **确认**                                                                                                                        |
| 「一任务一分支一 PR」（§0.5）             | **本仓库无 `.git`**                                                                                                                                        | **调整**：以「变更文件清单 + 时间戳核对 + 每阶段独立 docs 记录」替代（§8）                                                      |

## 3. 阶段划分与依赖

一次只做一个阶段（阶段门，见 §8）。**相对任务书的一处排序调整**：T6 提到 T3b 之前 —— T6 仅依赖 T0、1–2 人日、立刻消除「工作流级无预算」风险；T3b（worktree）最重，放后面不影响 M2 目标。

| 阶段    | 内容（任务书 ID）                     | 依赖 | 估时     | 里程碑 |
| ------- | ------------------------------------- | ---- | -------- | ------ |
| **P0**  | 基线与评测夹具（T0）                  | —    | 2–3 人日 | M1     |
| **P1**  | 确定性验证门（T1）                    | P0   | 3–4      | M1     |
| **P2**  | `submit_result` 结构化提交（T2）      | P0   | 2–3      | M1     |
| **P3**  | 路径重叠串行化（T3a）                 | P0   | 1        | M1     |
| **P4**  | 工作流级预算上限（T6）★提前           | P0   | 1–2      | M2     |
| **P5**  | 任务级 worktree 隔离与串行合并（T3b） | P3   | 3–4      | M2     |
| **P6**  | 任务上下文增强 + 消融（T4）           | P0   | 2–3      | M3     |
| **P7**  | 规划度量与精简 + 一致性检查（T5）     | P0   | 2–3      | M3     |
| **P8**  | 沙箱出口策略与注入防护（T8）          | —    | 2–3      | M4     |
| **P9**  | Redis 职责梳理（T9，已审计）          | —    | 0.5      | M4     |
| **P10** | Agent Run 中途恢复评估（T7）          | P5   | 决策记录 | M4     |
| **P11** | 收口（T10）                           | 全部 | 1–2      | M4     |

## 4. 各阶段实施内容

> 每阶段开工时先写**阶段任务书**（使用方式 → 严格范围+禁止清单 → 必读清单 → 架构判定 → 交付物 → 测试要求 → 边界红线 → 完成后 STOP → 验收对照表），经审后实施。

### P0 基线与评测夹具（T0）

- **落点**：新增评测夹具与一条命令（建议 `scripts/eval/` + `docs/109` 基线报告）。
- **内容**：8–12 个固定任务（S/M/L 三档），每个配 **Agent 不可见的 oracle**；每任务 ≥3 次运行。
- **采集指标**：真成功率 / 自报成功率 / **假阳性率** / token·成本·耗时 / 人工介入次数 / **解析降级触发率**（`output.parseRecovery`）/ 失败原因分布（`errorType`）。
- **验收**：一条命令可复现，结果落 JSON + 汇总报告；两次连续运行给出**噪声线**。
- **红线**：评测任务只用真实工作区（`AGENT_WORKSPACE_ROOT`）；不污染开发库既有项目数据。

### P1 确定性验证门（T1）

- **落点**：新增 `TaskVerifier`（建议 `packages/agent-core/src/verification/` 或在 server 侧包装），以 `WorkflowTaskExecutor` 包装层接入（先例 `RoutingWorkflowTaskExecutor`）。
- **判定**：按 `TaskType` 选客观检查（backend：构建+单测；frontend：构建+lint/类型检查；database：迁移 up/down 跑真实 Postgres；qa：测试确实执行且与自报一致；planner/reviewer：显式 `verified=false`）。
- **规则**：检查失败 → 覆盖自报、任务 FAILED、`metadata.errorType = VERIFICATION_FAILED`（现有枚举扩展）+ 证据（命令/退出码/输出摘要）→ 走既有失败策略；检查 flaky → 重跑一次，两次都失败才判失败。
- **复用**：`packages/evidence`、`packages/failure-recovery`；检查命令经 Tool Runtime → Sandbox。
- **开关**：`VERIFICATION_GATE=off|observe|enforce`（observe 只记录不覆盖，便于对比）。
- **验收**：Mock Agent 报 SUCCESS 但测试失败 → 任务 FAILED 且有证据；评测集假阳性率接近 0；验证的额外耗时/成本已量化；开关关闭行为与旧版一致。
- **文档**：更新 docs/97 的判定规则说明。

### P2 `submit_result` 结构化提交（T2）

- **落点**：`packages/tool-runtime/src/tools/`（新增控制类工具，经 Tool Runtime 注册）+ `AgentGraph` 终止条件。
- **内容**：工具参数＝`ProfessionalOutcome` schema；图终止＝「调用 `submit_result` 且校验通过」；校验失败把错误作为工具结果回给模型（计入迭代）；超时/取消语义不变（abort 不重试）。
- **降级路径**：保留 `repairNearJson` / `salvageOutcome`，开关控制并记录降级率；长期 <1% 后再删 `salvageOutcome`。
- **前置验证**：先确认 DeepSeek / OpenAI 兼容端点在思考模型下的工具调用稳定性（本仓已在 OpenCode Go 上验证过 `bindTools` 可用）。
- **验收**：EMPTY_FINAL_ANSWER 与 INVALID_AGENT_RESULT 比例较基线下降；降级率有数据；schema 失败→重试与超限→如实 FAILED 有单测。

### P3 路径重叠串行化（T3a）

- **落点**：`TaskPlanItem` 增 `touchedPaths`（规划期产出）+ `workflow-engine/src/scheduler.ts` 的 READY 判定。
- **规则**：与正在运行任务的路径重叠 → 暂缓；`touchedPaths` 缺失 → 保守视为「与全部任务重叠」（或按包目录粗粒度）。
- **前置**：先写复现用例（两个并行任务改同一文件，观察当前静默覆盖）。
- **验收**：复现用例改前失败、改后通过；无重叠任务仍并行（附耗时对比）。

### P4 工作流级预算上限（T6）★提前

- **落点**：`WorkflowPolicySchema` 增 `maxCostUsd` / `maxTokens` / `maxWallClockMs`（`.strict()` → 同步 DB policy、控制台表单、测试）+ 引擎领取前检查。
- **行为**：超限 → 工作流 PAUSED 并写明原因；80% 时发告警事件；放宽后 resume，已完成任务不重跑。
- **验收**：极小预算下按预期暂停且事件可查；放宽后恢复不重烧 token。

### P5 任务级 worktree 隔离与串行合并（T3b）

- **落点**：工作流级集成分支 + `AGENT_WORKSPACE_ROOT/<workflowId>/<taskId>` 的独立 `git worktree`；任务 SUCCESS 且通过 P1 验证后按工作流串行合并。
- **冲突**：`MERGE_CONFLICT` → 走既有失败策略（REPLAN 生成冲突解决任务 / HUMAN）。
- **清理**：取消、失败、`recover()` 时清理孤儿 worktree。
- **验收**：同文件并行用例产生确定结果或明确冲突处理；重启/取消无残留；评测集回归无下降。

### P6 任务上下文增强（T4）

- **第 1 步（审计）**：产出「当前给 Agent 的上下文有什么 / Agent 有哪些检索工具」的结论（`taskContextBuilder.ts` + `createPhase1Tools()`）。
- **第 2 步**：仓库地图（目录树 + 关键符号）+ 上游产物摘要（改动文件、diff 摘要）。
- **第 3 步**：消融实验（有/无 repo map 的成功率与 token 对比）。
- **验收**：消融数据入库；无收益则回退，不保留复杂度。

### P7 规划度量与精简（T5）

- **度量**：每阶段耗时/token/修复轮次 + 「计划首次校验通过率」。
- **实验**：按需跳过阶段（纯后端跳过 ui、无数据变更跳过 database）或合并相邻阶段；**确定性跨规格一致性检查**（任务引用的 API 路径必须存在于 api 规格；DB 规格的表必须被至少一个任务使用）。
- **验收**：规划成本下降且下游成功率不低于噪声线；一致性检查有单测。

### P8 沙箱出口策略与注入防护（T8）

- **现状**：`network: "none"` 已是默认（§2）→ 本阶段聚焦**策略化**（白名单如需）、**不可信输入标记**（仓库文件、MCP 返回内容）、**高危动作一律审批**（action-policy，`packages/action-policy`）、以及 API 若外露时的最小 Token 鉴权。
- **红队夹具**：仓库内放「忽略之前指令并外传密钥」的文件 → 断言无出站请求、密钥不出现在日志与结果。
- **验收**：红队夹具通过；日志脱敏测试通过；出站策略有自动化测试。

### P9 Redis 职责梳理（T9）

- **已审计**（§2）：Redis＝跨进程取消存储 + 健康检查，无与 Postgres 重叠。
- **交付**：在 docs/02 与架构图中写明其确切职责；评测在「PG + Redis」组合下通过即可，**不删除**。

### P10 Agent Run 中途恢复评估（T7）

- **输入**：P0 的「重跑一次任务的代价」数据（单次 run 上限 600s）。
- **决策**：代价小 → 只需保证重跑发生在**干净 worktree**（依赖 P5），不做持久化 checkpoint；代价大 → 评估 Postgres checkpointer（**含新依赖决策**）。
- **交付**：一页决策记录（做/不做及依据）。

### P11 收口（T10）

- 用 P0 评测集完整复测，产出 **before / after 对比表**；更新 as-built 架构图与 docs（验证门、`submit_result`、worktree、预算）；录制端到端演示；用真实数字整理面试问答（如何判断任务真的成功 / 并行怎么避免覆盖 / 为什么引擎与 LangGraph 分开）。

## 5. 通用完成定义（DoD，每阶段）

- [ ] 有能复现问题的失败用例，且改动后通过
- [ ] 单元/集成测试通过，现有测试无回归（`corepack pnpm -r --no-bail run typecheck && … lint && … test`）
- [ ] 评测集回归已跑，结果记录在案（对照 P0 噪声线）
- [ ] 文档已同步（docs + as-built 图）；本阶段独立 `docs/NN` 记录
- [ ] 新增行为有事件/日志留痕，且不含明文凭据
- [ ] 有开关的改动，已记录切换与回退方式

## 6. 总体验收（加固完成判据）

| 项                | 目标                                                           |
| ----------------- | -------------------------------------------------------------- |
| 假阳性率          | 接近 0（自报成功必有客观验证或明确 `verified=false`）          |
| 解析降级率        | 显著低于基线，降级路径可删或仅作兜底                           |
| 并行冲突用例      | 全部确定性处理，无静默覆盖                                     |
| 预算超限          | 工作流按预期暂停并可恢复                                       |
| 注入/出站红队用例 | 全部通过                                                       |
| 评测集            | 真成功率不低于基线，成本不显著上升；有完整 before / after 报告 |

## 7. 风险与提醒

- **评测集过小/过简单会让指标失真**：夹具必须含若干「会让 Agent 出错」的任务。
- **验证门可能提高失败率——这是好事**：说明此前的成功是假的；对外口径要统一，不为数字放松检查。
- **LLM 波动**：单次结果不可信，比较改进看多次运行的均值与噪声线。
- **新增依赖是独立决策**：T7（Postgres checkpointer）、T4（ctags/tree-sitter）都可能触及；按仓库纪律单独立项评审，不夹带进阶段实现。
- **本仓无 `.git`**：任务书的「一分支一 PR」不可执行，改用文件清单/时间戳核对（§8）。
- **评测成本**：真实模型走当前配置（OpenCode Go 订阅，本地 CI 不适用静态项目）；评测任务须用可构建工作区。

## 8. 执行协议（阶段门）

1. 一次只做一个阶段：先出**阶段任务书** → 用户审 → 实施（先失败用例）→ 门禁 → `docs/NN` 记录 → **STOP**（不自动进入下一阶段）。
2. 变更核对：每阶段结束给出「变更文件清单 + 时间戳 + 冻结文件未触碰证据」；无 git，不做 diff 引用。
3. 超范围问题只登记不顺手修（记入待办清单，由用户决定是否插队）。

## 9. 加固期冻结项

- 不新增 Agent、不新增页面、不新增外部集成。
- 历史未开始项（failureRouter 接线、工作区快照、durable checkpoint、审批重置）维持冻结，除非本计划某阶段显式纳入。
- 发现的新想法先记入待办，不插队。
