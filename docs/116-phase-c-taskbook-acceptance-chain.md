# 116 · 阶段 C 任务书：验收链路（T2 / N3 / T1 / N4 / N5）

> 来源：用户任务书《AI-SE 平台调整后任务规划 v2》§7「阶段 C：验收链路」+ 附录 B 任务映射；`docs/111` §4（阶段总表）与 §3 R4/R5（依赖修正 `T2 ‖ N3 → T1 → N4 → N5`、防篡改归属 T1）；`docs/108` §4 P1/P2（T1/T2 原始条目）+ §5 DoD；`docs/110`（P0 证据：降级率 94.4%、S2 假阴性样本）。
> 编号说明：**116 = 本任务书**（C 段连号 116/117 中的任务书）；实施完成后，记录写入 **`docs/117-phase-c-record.md`**（不占用 116，不覆盖任何既有文档）。
> 定位：**让「交付物可验证地满足 PRD」**。C 五项：**T2**（`submit_result` 结构化提交）、**N3**（验收标准提取与结构化）、**T1**（确定性验证门 + 逐条 AC 结果 + 防篡改）、**N4**（测试先行 + 红灯检查）、**N5**（追溯表）。执行序（`docs/111` R4）：**T2 ‖ N3 → T1 → N4 → N5**；C 出口 = E1 ×3 对比阶段 B 出口基线。
> **开工前置**：阶段 B 已收尾（B-4 两批完成、`docs/115` §B-4 基线入库）——C 出口对比需要改前基线。

## 使用方式

1. 先读本任务书全文，回复「开始实施」或直接指出要改的地方；**未确认前不动任何代码与数据**。
2. 本任务书覆盖五项、体量较大：按 §实施顺序 的 **C-1…C-6 分次实施**，每步可独立停下；任一步发现范围外问题：只登记、不顺手修。
3. 完成后按 §完成后 输出报告并 **STOP**（不自动进入阶段 D）。

## 严格范围

**做（T2/N3/T1/N4/N5 五项 + C-6 出口验证）：**

1. **T2**：`submit_result` 控制类工具（schema 约束）——图终止条件改为「提交且校验通过」，校验失败错误回传自修；旧解析管线保留为降级路径 + 降级率数据。
2. **N3**：AC 成为一等记录（编号/文本/优先级/验证方式/smoke）；E1 形态走**确定性解析**（不调 LLM）；完整性哈希比对；「每 AC ≥1 任务映射」确定性覆盖检查；关口 1 复用（无编号 PRD 的 LLM 提取需人工确认）。
3. **T1**：确定性验证门（按任务类型客观检查；失败覆盖自报 + `VERIFICATION_FAILED` + 证据；flaky 重跑一次；开关灰度）+ **逐条 AC 结果**（按测试名编号）+ **防篡改规则**（开发任务不得改受保护测试文件）。
4. **N4**：切片内任务顺序 = **qa 写测试（名含 AC 编号）→ 红灯检查 → 开发 → 绿灯验证**；空转测试退回重写；reviewer 检查测试↔AC 对应。
5. **N5**：追溯表（FR → AC → 测试 → 执行结果 → 证据），**由代码生成、零 LLM**；控制台最小展示。
6. **C-6 出口验证**：E1 ×3 与阶段 B 出口基线对比（oracle 通过率 / 假阳性 / 额外人工介入 / 成本 / 耗时）。

**禁止：**

- 不破红线：Tool Runtime 唯一执行路径、执行经 Sandbox、**不新建第二套 Permission / Approval / Audit / 错误码**（防篡改作为 T1 的验证规则；`errorType` 沿用现有字面量扩展 `VERIFICATION_FAILED`）。
- **确定性优先**（v2 §4.5）：凡能用代码判定的（覆盖检查、追溯表、验证门、红灯检查、哈希比对），**不交给 LLM**。
- **E1 隔离**：PRD 全文、oracle、参考实现、变异版本不得进入任何工作区、不得进入提示词、不得由被测 Agent 编写或读取（沿用 `docs/109` §架构判定 5）；不放松或改写既有 8 个夹具的 oracle 断言。
- 冻结新功能：不新增 Agent、不新增控制台页面/菜单（N5 仅需求页最小接线）；不做阶段 D（T8/N6）、F、G 的任何内容。
- 不改阶段 A/B 产出（`docs/112`–`docs/115`）；不顺手改控制台其他页面。
- 长任务纪律：C-6 的 E1 ×3 **先给预估、获授权后再跑**；评测只动 `[eval]` 前缀数据，清理前先留证。
- 不伪造、不回填、不外推任何样本；拿不到就写「未取得 + 原因」。

## 必读清单

**文档**：v2 §7（T2/T1/N3/N4/N5 与出口）+ §12（DoD）+ §14（风险）+ 附录 A（E1 oracle 要点）；`docs/111`（§3 R4/R5、§4 阶段总表）；`docs/108`（§4 P1/P2、§5 DoD）；`docs/109`（P0 冻结口径与 E1 隔离）；`docs/110`（§6.1 降级率 94.4% 与 S2 假阴性样本、§7 规划发现）；`docs/115`（B 段：N2 两级/关口 1、T6 预算、B-4 基线与噪声线）；`docs/105`（opencode-go 网关合规——T2 前置）。

**代码（实施前逐项核对，代码权威于文档）**：

- **T2**：`packages/agent-core/src/professional/ProfessionalAgent.ts`（`repairNearJson :188`、`salvageOutcome :293`、`parseOutcome :321`、errorType 字面量 `INVALID_AGENT_RESULT :356` / `TIMEOUT :395` / `EMPTY_FINAL_ANSWER :413`）；`packages/agent-core/src/graph/AgentGraph.ts`（`shouldContinue :361` 终止条件）；`packages/tool-runtime/src/tools/`（工具注册先例）与 Tool Runtime 注册/审计通道；`apps/server/src/services/workflowTaskExecutor.ts`（outcome → 任务状态映射）。
- **N3**：`packages/shared/src/index.ts`（`acceptanceCriteria :304/:330/:529` 三处 strict `string[]`、`RequirementAnalysisSchema`、`TaskPlanItemSchema`）；`packages/agent-core/src/planning/prompts/{requirement-analysis,task-planning}.prompt.ts`；`validatePlanningOutput.ts` + `validateSlicePlan.ts`（确定性覆盖检查先例）；`packages/database/migrations/`（当前末位 012 → 新迁移 013）；`apps/web/src/views/RequirementsView.vue`。
- **T1**：`apps/server/src/services/deploymentOrchestrator.ts:699`（`RoutingWorkflowTaskExecutor` 包装先例）、`actionRecoveryExecutor.ts:80`、`workflowTaskExecutor.ts:167`；`packages/evidence/src/{capture,verify,redact}.ts`（证据采集/校验/脱敏）；`packages/failure-recovery`（既有失败策略）；Sandbox/Tool Runtime 执行通道；`packages/workflow-engine`（任务失败 → 既有策略分支）。
- **N4**：`task-planning.prompt.ts`（qa 任务与顺序约束）；T1 验证规则位（红灯执行、防篡改）；`packages/eval/fixtures/E1/prd.md`（AC 编号与 smoke 标记）。
- **N5**：`packages/evidence`；`packages/database/src/planningRepositories.ts`（规格/任务读）；`apps/server/src/routes/planning.ts`（API 先例）；`apps/web` 需求页 + `viewmodels/requirementViewModel.ts`。
- **评测**：`packages/eval/src/{harness,cli,types}.ts`（关口 1 自动处理、E1 超时覆盖）；`packages/eval/fixtures/E1/{fixture.json,prd.md,ac-map.md}`。

## 实施顺序（C-1…C-6，可独立停下）

| 步骤 | 内容                             | 依赖     | 说明                                        |
| ---- | -------------------------------- | -------- | ------------------------------------------- |
| C-1  | **T2** 结构化提交                | —        | 与 C-2 独立（R4：`T2 ‖ N3`）；先做哪个可调  |
| C-2  | **N3** AC 提取与结构化           | —        | 独立；T1 的 AC 维度依赖它（R4）             |
| C-3  | **T1** 验证门（+AC 结果+防篡改） | C-2      | R5：防篡改落在 T1 规则位                    |
| C-4  | **N4** 测试先行 + 红灯检查       | C-3      | 红灯/防篡改复用 T1 规则位                   |
| C-5  | **N5** 追溯表                    | C-2、C-3 | 汇总 FR→AC→测试→证据                        |
| C-6  | **阶段 C 出口验证**              | C-1…C-5  | E1 ×3 对比 B 出口基线；**长运行，逐批授权** |

## T2 —— `submit_result` 结构化提交（C-1）

**交付物**：

1. **控制类工具 `submit_result`**：参数 = `ProfessionalOutcome` schema；**无外部副作用**——不经 Sandbox 执行外部命令，仅经 Tool Runtime 的注册/审计/结果通道；文档写明它与「Tool Runtime 唯一执行路径」的关系（作为注册在 Tool Runtime 的控制工具，事件与审计照常）。
2. **图终止条件**：AgentGraph 终止 = 「调用 `submit_result` 且 schema 校验通过」；校验失败把 zod 错误**作为工具结果回传模型自修**（计入迭代）；超时/取消语义不变（abort 不重试）。
3. **降级路径**：保留 `repairNearJson` / `salvageOutcome`，开关控制并记录降级率（run 级 `parseRecovery` 指标已有）；长期 <1% 后再删（**本期不删**）。
4. **前置验证**：确认当前模型端点的工具调用稳定性（本仓已在 OpenCode Go 验证 `bindTools` 可用；对照 `docs/105`）。

**验收**：`EMPTY_FINAL_ANSWER` / `INVALID_AGENT_RESULT` 比例较基线下降（对照 B-4 数据）；降级率有数据；schema 失败→重试与超限→如实 FAILED 有单测；开关关闭行为与旧版一致。

## N3 —— 验收标准提取与结构化（C-2）

**交付物**：

1. **AC 一等记录**：`AcceptanceCriterionSchema`（编号 / 文本 / 优先级 Must|Should / 验证方式 / 是否 smoke）+ 需求级关联（FR 编号集）；持久化默认 = **迁移 013 新表 `requirement_acceptance_criteria`**（一 AC 一行，含文本哈希）；「任务 ↔ AC」映射默认走 `tasks.input.acKeys`（不动 tasks 表结构）——均可否决。
2. **提取**：PRD 已带编号（E1 形态）→ **确定性 Markdown 解析**（不调 LLM）；无编号 PRD → LLM 提取并在**关口 1** 交人确认（复用既有 approvals）。
3. **完整性校验**：入库 AC 文本与 PRD 原文一致（归一化空白后**哈希比对**）；丢失或被改写 → 失败。
4. **映射覆盖检查**：每个 AC 至少映射到一个任务（确定性检查，参照 `validateSlicePlan` 模式；不过 → 自动重做，上限沿用既有 2 次）。
5. **控制台最小展示**：需求页 AC 列表（编号/文本/优先级/映射数）。

**验收**：E1 解析出 **9 FR / 30 AC** 且与原文完全一致（哈希比对通过）；「漏映射一条 AC」反例单测必红；迁移 013 + `migrate.test.ts` 清单断言同步。

## T1 —— 确定性验证门（C-3）

**交付物**：

1. **`TaskVerifier`**（默认落点：server 侧 `WorkflowTaskExecutor` 包装层，先例 `RoutingWorkflowTaskExecutor`；可改）——按任务类型客观检查：backend = 构建 + 单测；frontend = 构建 + lint/类型检查；database = 迁移 up/down（真实 Postgres）；qa = 测试确实执行且与自报一致；planner/reviewer = 显式 `verified=false`。
2. **失败覆盖自报**：任务 FAILED + `errorType=VERIFICATION_FAILED`（现有字面量枚举扩展）+ **证据**（命令/退出码/输出摘要，经 `packages/evidence` 采集与脱敏）→ 走既有失败策略；无可用检查 → 显式 `verified=false`。
3. **逐条 AC 结果**（v2 新增）：验证门的测试执行按**测试名中的 AC 编号**汇总逐条 AC 的通过/失败（确定性解析，供 N5）。
4. **flaky 处理**：失败重跑一次，两次都失败才判失败。
5. **开关**：`VERIFICATION_GATE=off|observe|enforce`（config-first；observe 只记录不覆盖，便于对比）。
6. **防篡改**（R5）：开发任务 diff 触及**受保护测试文件** → 验证规则判失败（不新建权限体系）。
7. **执行通道**：检查命令经 Tool Runtime → Sandbox（红线）。
8. **文档同步**：验证规则说明文档（位置开工时核对；代码权威于文档，`docs/108` 的旧引用「docs/97」以实际为准）。

**验收**：Mock「自报成功但测试失败 → FAILED」单测；防篡改单测；E1 运行假阳性率较 B 基线明显下降（C-6 验证）；验证的额外耗时/成本已量化；开关关闭行为与旧版一致。

## N4 —— 测试先行 + 红灯检查（C-4）

**交付物**：

1. **切片内任务顺序**：qa 依据 AC 编写测试（**测试名含 AC 编号**）→ **红灯检查** → 开发 → **绿灯验证**（规划提示词 + 任务图约束；顺序由确定性校验保证）。
2. **红灯检查**：在尚无实现时运行测试，**必须失败**；能通过 = 空转测试 → 退回重写（执行复用 T1 规则位；事件留痕）。
3. **防篡改**：复用 C-3 的 T1 规则（开发任务改受保护测试文件 → 失败）。
4. **reviewer 检查**「测试与 AC 的对应关系」（提示词 + 确定性校验：Must AC 无对应测试 → 重做）。
5. **局限写明**：LLM 写的测试也可能有误 → 最终仍以独立 oracle 为准。

**验收**：空转测试被红灯检查拦下（单测）；开发任务修改测试文件判失败（单测）；E1 运行中全部 Must AC 都有名称含 AC 编号的测试（C-6 统计）。

## N5 —— 追溯表（C-5）

**交付物**：

1. **确定性生成器**（零 LLM）：汇总 FR → AC → 测试用例 → 执行结果 → 证据（命令/退出码/输出摘要）→ Markdown/JSON 产物；每条 AC 状态 ∈ {通过 / 失败 / 未验证 / 无测试覆盖}。
2. **数据源**：N3 的 AC 记录 + T1/N4 的逐条 AC 结果与证据（`packages/evidence`）。
3. **输出**：`GET /api/requirements/:id/traceability`（或并入需求详情）+ 控制台需求页追溯表卡片 + 产物落盘（默认按需生成、可选导出；位置可否决）。

**验收**：E1 一次运行后追溯表覆盖全部 30 条 AC；「无测试覆盖」数为 0 或明确列出；生成过程**零 LLM 调用**（可断言）；有单测。

## C-6 —— 阶段 C 出口验证（长运行，逐批授权）

1. 再跑 **E1 ×3**，与**阶段 B 出口基线**（`docs/115` §B-4：oracle 通过率 / 假阳性率 / 额外人工介入 / 成本 / 耗时）对比。
2. 回归抽查：S/M/L 至少 1 次冒烟（视预算；不下降为准）。
3. 跑前给预估、获授权；结果落 `packages/eval/results/`，汇总入 `docs/117`。

## 测试要求（汇总）

- 每包门禁：`corepack pnpm --filter @ai-se/<pkg> typecheck && lint && test`；全仓 `corepack pnpm -r run typecheck/lint`；改动文件 `prettier --check`（docs 可 `--write` 并说明）。
- 新迁移 013 遵循仓库风格（`CREATE TABLE IF NOT EXISTS`、`gen_random_uuid()`、`set_updated_at()` 触发器、PG16），并扩展 `packages/database/src/migrate.test.ts` 文件清单断言。
- 每项交付**先写失败用例**（v2 §12）；e2e 沿用既有 server e2e 模式（docker Postgres 容器）。
- 阶段 A/B 冻结断言：既有 8 个夹具 oracle 与 S/M/L 行为零改动（仅新增 E1 相关项与开关默认值）。

## 边界红线

- **复用即红线**：Tool Runtime（T2 工具注册、T1 检查执行）、Sandbox、`packages/evidence`（证据）、`packages/failure-recovery`（失败策略）、既有 approvals（N3 关口 1 确认）、既有 `errorType` 字面量扩展（`VERIFICATION_FAILED`）——**不新增平行体系**。
- **E1 隔离**（同 B 段口径）：PRD/oracle/参考实现/变异版本不入工作区、不入提示词。
- 长任务授权纪律；评测只动 `[eval]` 数据；凭据（API key/连接串）不入结果 JSON、日志与文档。
- **不做**：T8/N6（阶段 D）、T3a/T3b/T4（阶段 F）、T5 其余/T7/T9（阶段 G）；控制台不新增页面（N5 仅需求页卡片）。

## 完成后

1. 输出报告（中文，按 `docs/113`/`docs/115` 同款结构）：变更文件清单 + 时间戳；T2/N3/T1/N4/N5 逐项结果与证据锚点（命令 + 退出码/HTTP 状态 + 关键 ID + 文件路径）；C-6 对比表；门禁数字；未完成事项与偏差；**STOP**（不进入阶段 D）。
2. 写 `docs/117-phase-c-record.md`。
3. **STOP**：等用户指令（阶段 D 的 T8/N6 另行任务书）。

## 验收对照表

| 来源要求                                   | 本任务书对应 | 当前可达性                                                                                         |
| ------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------- |
| v2 §7 T2：结构化提交 + 降级路径 + 文档说明 | §T2          | `ProfessionalAgent` 解析管线与 `AgentGraph` 终止条件已核对；OpenCode Go 工具调用已验证（docs/105） |
| v2 §7 T1：验证门 + 逐条 AC 结果 + 防篡改   | §T1          | 包装层先例存在（`RoutingWorkflowTaskExecutor`）；evidence/failure-recovery 已存在                  |
| v2 §7 N3：AC 一等记录 + 确定性解析 + 哈希  | §N3          | 现状为 strict `string[]`（三处）；需迁移 013 + 提示词/控制台同步（`docs/111` §2 行 7）             |
| v2 §7 N4：测试先行 + 红灯 + 防篡改         | §N4          | 依赖 T1 规则位；E1 PRD 已含 AC 编号与 smoke 标记                                                   |
| v2 §7 N5：追溯表（零 LLM）                 | §N5          | `packages/evidence` 齐备；AC 数据来自 N3 + T1                                                      |
| v2 §7 阶段 C 出口：E1 ×3 对比              | §C-6         | 基线 = `docs/115` §B-4（B-4 进行中）；长运行逐批授权                                               |
| `docs/111` R4：执行序修正                  | §实施顺序    | `T2 ‖ N3 → T1 → N4 → N5`                                                                           |
| `docs/111` R5：防篡改归属                  | §T1-6        | 作为 T1 验证规则，不建权限体系                                                                     |

## 架构判定（默认已定，可逐条否决）

1. **T2 工具形态**：控制类工具、无外部副作用；图终止 = `submit_result` 校验通过；降级路径保留 + 开关 + 降级率；**本期不删** `salvageOutcome`。
2. **N3 持久化**：迁移 013 新表 `requirement_acceptance_criteria`（一 AC 一行 + 文本哈希）；任务↔AC 映射走 `tasks.input.acKeys`（不动 tasks 表）。
3. **T1 落点**：server 侧 Executor 包装（先例 `RoutingWorkflowTaskExecutor`）；开关 `VERIFICATION_GATE=off|observe|enforce`；检查经 Tool Runtime → Sandbox。
4. **防篡改归属**：T1 规则（R5）。
5. **N4 顺序**：qa → 红灯 → 开发 → 绿灯；规划提示词 + 确定性校验双保证；红灯执行复用 T1 规则位。
6. **N5 产物**：确定性生成（零 LLM）；API + 需求页卡片；JSON/MD 落盘可选。
7. **C 出口口径**：E1 ×3 对比 B 基线；S/M/L 冒烟按预算；对比须同 harness/夹具版本。

## 已知限制与注意事项

1. **验证门会让失败率先上升**（v2 §14）：说明此前成功有一部分是假的——**不为数字放松检查**。
2. **E1 改后对比受 B-4 基线质量影响**：B-4 若暴露夹具缺陷，按「如实记录 + 修夹具、不放松断言」处理（沿用 B 段先例）。
3. **T2 降级删除线是长期项**（<1% 后）；本期只做「保留 + 开关 + 数据」。
4. **N3 对无编号 PRD 的 LLM 提取**质量依赖关口 1 人工确认（本期最小实现）。
5. **N4 的测试可能本身有误** → 最终以独立 oracle 为准（写进文档）。
6. **成本**：C-6 的 E1 ×3 是最大成本项，**逐批授权**；PRD 级运行务必在 T6 就位后（已就位）。
