# 117 · 阶段 C 实施记录（已完成）

> 编号说明：本文件为阶段 C 实施记录（任务书 = `docs/116-phase-c-taskbook-acceptance-chain.md`）。
> 状态：**已完成** —— C-1（T2）/ C-2（N3）/ C-3（T1）/ C-4（N4）/ C-5（N5）/ **C-6（E1 ×3 对比批次）全部完成**（2026-10-06/07）；阶段 C 全部门关闭（见文末「阶段 C 完成报告」）。

## C-1 · T2：submit_result 结构化提交（**已完成**）

### 已完成（agent-core 包，2026-09-30）

- **控制类工具 `submit_result`**：`packages/agent-core/src/professional/submitResult.ts`
  - 入参 schema = `SubmitResultSchema`（JSON-Schema 可表示；见「关键实现决策」#3）；
  - 无外部副作用（`execute` 原样返回校验后的结果）；经 Tool Runtime 校验/审计（唯一执行路径）。
- **终止条件（deepagents 中间件）**：`createSubmitResultTerminationMiddleware`——`beforeModel` + `jumpTo:"end"`：提交被接受后不再多叫一次模型；校验失败正常回到模型自修（计入迭代）。
  - 说明（code-wins-over-docs）：职业 Agent 的真实工具循环在 `deepagents.createDeepAgent` 内（外层 `AgentGraph` 不执行工具），因此「图终止」落在框架中间件层，而不是 `AgentGraph.shouldContinue`。
- **结果捕获与降级**：`ProfessionalAgent` 新增 `outcomeTool` 选项——成功提交优先（`captureSubmittedOutcome`），缺省回落文本解析（`repairNearJson`/`salvageOutcome` 保留）；`metadata.outcomeMode ∈ {tool, text-fallback, text}`（降级率数据）。
- **暴露路径**：`AgentRegistry` 的 `definition()` 助手为全部职业 Agent 追加 `submit_result`（tools + permissions）；`ToolRuntimeBackend.CUSTOM_TOOL_NAMES` 追加（作为自定义工具暴露给模型）。
- **Provider**：`DeepAgentLLMProvider` 接收 `outcomeTool`；提交被接受后以结果摘要回填最终回答（避免空回复重问）。
- **提示词**：`resultInstructions(outcomeTool)` 双模式——工具模式要求「调用 submit_result 提交结果，勿粘贴纯文本 JSON」；`repairPrompt` 同步。

### 验证（已做，构建自由）

- agent-core 全量单测：**97 passed | 3 skipped**（新增 8 个用例：工具校验/捕获/中间件 ×4、Provider 终止 ×1、ProfessionalAgent 集成 ×3）；3 skipped = docker e2e（批次期间避免重负载，收尾补跑）。
- `tsc -p tsconfig.json --noEmit` EXIT=0；`eslint "src/**/*.ts"` EXIT=0；prettier 全净。

### 已完成（server 接线，2026-10-06）

- `apps/server/src/config.ts`：新增 `SUBMIT_RESULT_MODE=tool|text`（默认 **tool**）→ `AppConfig.submitResultMode`。
- `apps/server/src/services/workflowTaskExecutor.ts`：
  - 依赖项新增 `submitResultMode`（缺省 tool）；
  - 工具模式下 `ToolRuntime` 追加 `createSubmitResultTool()`，并向 `ProfessionalAgent` 传 `outcomeTool=SUBMIT_RESULT_TOOL_NAME`；text 模式 = 旧行为（不注册工具、不传 outcomeTool）；
  - agent run `output` 增 `outcomeMode` 字段（降级率数据来源，与既有 `parseRecovery` 并列）。
- `apps/server/src/index.ts`：执行器装配透传 `config.submitResultMode`。
- 测试：`config.test.ts` +1（默认 tool / text 可切 / 非法值拒绝）；`professionalAgents.e2e.test.ts` +1 场景矩阵（scripted）——
  **tool**（step 调 submit_result → `outcomeMode=tool`、摘要回填、tool_calls 记录 `submit_result/succeeded`）；
  **text-fallback**（工具模式开但未提交 → 回落文本解析，`outcomeMode=text-fallback`，无 submit_result 调用记录）；
  **text**（开关关 → 旧路径，`outcomeMode=text`）。旧大场景回归保持通过。

### 门禁（2026-10-06，全绿）

- server 单测 + e2e：**99/99**（23 文件；较上轮 +2）；agent-core：**100/100**（17 文件，含 docker e2e，未设 skip）；
- 全仓 typecheck（串行）EXIT=0；全仓 lint EXIT=0；改动文件 prettier 净；
- **47557 已重启装载 C-1 代码**（新 pid 36091，`SUBMIT_RESULT_MODE=tool`）：health=200、判别路由 400 ✓。

### 实施期发现（转记）

- e2e 断言注意：**运行时任务行与计划模板行分离**——`savePlanningResult` 落的计划行 `requirement_id` 有值但 `workflow_run_id` 为空；引擎执行的是 clone 出的运行时行（`requirement_id=NULL`、经 `workflowRunId` 关联、`planTaskId` 回指）。断言应读 `detail.tasks[].output`（或经 `output.agentRunId` 查 `tool_calls`），不要按 `requirement_id` 直查 `tasks`。

### 收尾（S1 真模型小冒烟，2026-10-06 → **通过**）

- 命令：`EVAL_BASE_URL=http://127.0.0.1:47557 pnpm --filter @ai-se/eval start --fixtures S1 --runs 1 --cleanup --out results/smoke/c1-s1-submit-result.json`
- 结果（`results/smoke/c1-s1-submit-result.json` + `-summary.md`）：**run 1 自报=成功、oracle=通过（10 断言）、假阳性=否**；**任务 10/10 SUCCESS（两切片链完整）**；**`outcomeMode=tool` 10/10**、`text-fallback`/`text` = 0；`errorType` 全空（无 EMPTY_FINAL_ANSWER / INVALID_AGENT_RESULT）；**`parseRecoveryRuns=0`**（对照 B-4 的 76% 降级率 → 0）；重试 0；人工介入 0；token 145,413 / 19,956；耗时 557s。
- 清理：`[eval] S1` 已删（`--cleanup`）。噪声线（对 2026-10-01）：`parseRecoveryRate -0.767`、`trueSuccessRate +0.417`（子目录档案，不参与基线对比）。

### C-1 验收对照（`docs/116` §T2）

| 验收项 | 结果 |
| --- | --- |
| `EMPTY_FINAL_ANSWER` / `INVALID_AGENT_RESULT` 比例较基线下降 | ✓ 冒烟窗口内均为 0（10/10 正常提交；B-4 期望此比例随工具化下降） |
| 降级率有数据 | ✓ `outcomeMode`（tool/text-fallback/text）随 agent run output 落库；冒烟 10/10 = tool |
| schema 失败→重试与超限→如实 FAILED 有单测 | ✓ agent-core 单测（工具校验 / 捕获 / 中间件）；框架层拒绝回传模型自修、计入迭代 |
| 开关关闭行为与旧版一致 | ✓ e2e `text` 场景：不注册工具、不传 outcomeTool、`outcomeMode=text`、旧文本解析路径 |
| 前置：模型端点工具调用稳定性 | ✓ OpenCode Go `bindTools` 已验（docs/105）+ 本次真模型 10/10 实据 |

### 关键实现决策（供归档）

1. 终止点在 deepagents 中间件（beforeModel + jumpTo end），非外层图——依据：`DeepAgentLLMProvider.invoke` 内 `createDeepAgent` 驱动全部工具循环。
2. 无效参数在**框架层**即被拒（错误回传模型自修、计入迭代），不进入 ToolRuntime 记录；ToolRuntime 的 schema 校验作为第二道闸（单测覆盖）。
3. `z.preprocess`（transform）**无法转 JSON Schema**（框架要把工具 schema 发给模型，实测报错 "Transforms cannot be represented in JSON Schema"）→ schema 拆为：`SubmitResultSchema`（基础、可表示）+ `OutcomeSchema = z.preprocess(normalizeEnums, SubmitResultSchema)`（文本宽松解析）；结构单源，无漂移。
4. `metadata.outcomeMode` 三值语义：tool（提交被接受）/ text-fallback（工具模式开启但降级）/ text（工具模式关闭）。
5. server 接线形态（最小改动）：开关落在 config（env `SUBMIT_RESULT_MODE`），注册与传参都在既有唯一构造点 `workflowTaskExecutor`（全仓仅此一处 `new ProfessionalAgent`）；`outcomeMode` 随 output 落库供降级率统计。
6. 测试断言口径：读 `detail.tasks[].output`（运行时任务行经 workflowRunId 关联，非 requirement_id——见「实施期发现」）。

## C-2 · N3：验收标准提取与结构化（**已完成**）

### 交付物（对照 `docs/116` §N3）

1. **AC 一等记录**：`AcceptanceCriterionSchema`（shared：编号 / 文本 / 优先级 Must|Should / 验证方式 / 是否 smoke + FR 编号集）；迁移 **013** 新表 `requirement_acceptance_criteria`（一 AC 一行 + 归一化文本哈希 + `source: parsed|llm`）；「任务 ↔ AC」映射走 `tasks.input.acKeys`（`TaskPlanItemSchema.acKeys` 可选字段——不动 tasks 表结构）。
2. **提取**：PRD 已带编号（E1 形态）→ **确定性 Markdown 解析**（`parseAcceptanceCriteriaFromPrd`，不调 LLM）；无编号 PRD → 沿用 requirement_analysis 的 LLM 提取串（关口 1 确认既有）并按出现顺序生成 AC-01… 编号。落盘点：`persistSlicePlan`（第一级完成）、`planSlice`（第二级开跑前）、单级 `afterGraph`；`ensureAcceptanceCriteria` **幂等、提取=替换**。
3. **完整性校验**：`verifyAcceptanceCriteriaIntegrity`——入库文本 vs PRD 原文（归一化空白后 sha256 比对）；丢失（双方任一缺失）/改写/重复 → 错误列表。
4. **映射覆盖检查**：`validateAcceptanceCoverage`（确定性；参照 `validateSlicePlan` 模式）——切片 FR 范围内每个 AC 至少被一个任务的 `acKeys` 覆盖、不得引用未知 AC；接入 `taskPlanWithDagRepair` 重做循环（≤2 次；dag+覆盖错误一并注入修复提示词；通过时发 `AC_COVERAGE_VALIDATED`）。
5. **控制台最小展示**：`GET /api/requirements/:id/acceptance-criteria`（记录 + 映射数）；需求页新增「验收标准（AC）」卡片（编号 / 文本 / 优先级 / smoke / 映射数）。

### 验收对照（`docs/116` §N3）

| 验收项 | 结果 |
| --- | --- |
| E1 解析出 9 FR / 30 AC 且与原文完全一致（哈希比对通过） | ✓ 单测（真夹具 `packages/eval/fixtures/E1/prd.md`）+ 开发库实据：E1 `raw_content`（线上真实需求文本）解析 **9 FR / 30 AC、零重复、AC-01…AC-30**，哈希校验通过 |
| 「漏映射一条 AC」反例单测必红 | ✓ `validateAcceptanceCoverage.test.ts` 反例断言精确返回 `AC not covered by any task: AC-02`（另含未知引用 / 切片过滤 / 空集跳过） |
| 迁移 013 + `migrate.test.ts` 清单断言同步 | ✓ 清单 arrayContaining + 长度 13 + 末位文件名断言更新；开发库已应用（`code 013_phaseC_requirement_acceptance_criteria.sql`） |

### 验证（命令与数字）

- agent-core：**19 文件 / 111 用例全绿**（+2 文件 +11 用例：E1 解析 9/30、完整性反例、覆盖反例、切片过滤等）；
- database：**10 文件 / 44 全绿**（新增 AC 仓储用例：替换语义 / 最新版本映射计数 / 013 建表）；
- server：`sliceFlow.e2e` 单跑 ✓（新断言：AC 端点返回 LLM 路径记录、编号形如 AC-xx、映射数为数字）；
- web：store 用例 **4/4** ✓（新增 N3 用例：加载 AC + 映射数）；RequirementsView 增加 AC 卡片；
- 全仓门禁（串行，2026-10-06 22:17–22:26）：**typecheck EXIT=0、lint EXIT=0**（修复新测试一处未用导入后复跑）、改动文件 prettier 净；
- **16 包测试**：15 绿 + web 既存 5 红（eyebrow 族，非本次引入；317/322 = 上轮 316/321 + 新增 1 用例）——shared 50 / observability 2 / workflow-engine 35 / **agent-core 111**（19 文件）/ tool-runtime 12 / sandbox 2 / mcp 235 / browser 38 / evidence 38 / failure-recovery 16 / action-policy 13 / visual 83 / eval 22 / **database 44**（10 文件）/ **server 99**（23 文件）；
- server 全量首跑 1 红（`v1GoldenScenario` 重启恢复子测试，全量并行运行下偶发）：**单独复跑 4/4 绿 + 全量复跑 23 文件 / 99 全绿**——与 B-4 判例一致（docker/chromium 资源竞争型 flake），非代码回归；
- **47557 已重启装载 N3 代码**（pid 45119）：health=200；`GET /api/requirements/:id/acceptance-criteria` 200（E1 当前 `criteria:[]`——按设计，重规划后填充）。

### 实施期发现（转记）

- **E1 计划跨 run 复用**（切片 PLANNED 后 harness 直接起工作流）：AC 记录与任务 `acKeys` 只在**重规划**时产生——C-6 的 E1 ×3 必须**先触发一次重规划**（`--replan` 或复位切片），否则任务无 `acKeys`、C-5 追溯表无数据。→ 已登记为 C-6 操作项。
- `node-pg` 的**顶层数组参数**会转 PG 数组字面量（非 JSON）→ `fr_keys` 显式 `JSON.stringify` 入库；对象参数不受影响（既有 `input.acceptanceCriteria` 一直正确，勿误改）。
- e2e 判据：无编号 PRD（sliceFlow 场景）走 `source=llm` 落盘路径——证明 LLM 提取串同样成为一等记录。
- **补记（C-3 期间发现并修复）**：计划行落库（`saveSlicePlanningResult` / `savePlanningResult`）原先未把 `acKeys` 写入 `tasks.input` → 映射计数在真实流程中恒 0（单测此前用手工插入行，掩盖了缺口）。已补齐（现真实链路：计划行 → 运行时克隆 `data: planTask.input` 原样复制 → `task.input.acKeys` 可用）；database 新增落库用例（44 → **45**）。C-6 重规划后 E1 映射数可见。

### 关键实现决策（供归档）

1. 解析器落在 agent-core `planning/`（与 `validateSlicePlan` 同域），server 复用同一函数（结构单源、防漂移）。
2. 覆盖检查粒度 = **切片 FR 范围**（AC.frKeys ∩ slice.frKeys ≠ ∅），与两级规划「每片规模上限」一致；全需求覆盖 = FR 全覆盖（既有）+ 各切片 AC 覆盖的传递保证。
3. `acKeys` 为**可选**字段（不设默认 `[]`）：避免既有 11 处计划字面量 churn；缺失即视为未映射（覆盖检查如实报错）。
4. 映射计数口径：**各切片最新版本**的原始计划行（`workflow_run_id IS NULL`）的 `input.acKeys` 去重计数——重规划替换旧版本、计数不翻倍；运行时克隆不参与计数。
5. AC 记录落盘 = 幂等 replace（先例 `replaceSlicePlan`）；`ANALYZED` 早退路径由 `planSlice` 前置兜底（复用计划的 requirement 在下次重规划时补齐记录）。

## C-3 · T1：确定性验证门（**已完成**）

### 交付物（对照 `docs/116` §T1）

1. **TaskVerifier**（server 侧包装层，先例 `RoutingWorkflowTaskExecutor`）：`VerifyingWorkflowTaskExecutor` 包装 agent 执行器（delivery 任务经路由原样直通）；任务自报成功后按其类型执行**可用性优先**的客观检查：
   - backend = build + 单测；frontend = build + lint/类型检查（lint 优先、缺省回退 typecheck）；database = 迁移 up/down（**成对声明**才算可用）；qa（TEST）= 测试执行核对；BUILD = build；
   - planner/reviewer 类（ANALYSIS/DESIGN/REVIEW）与缺脚本场景 → 显式 `verified=false`（verdict=unavailable，带原因；不伪造通过）。
2. **失败覆盖自报（enforce）**：verdict=failed → 任务被覆盖为 `failed` + `error.code=VERIFICATION_FAILED` + `output.errorType=VERIFICATION_FAILED`（errorType 词表扩展：既有 INVALID_AGENT_RESULT / TIMEOUT / EMPTY_FINAL_ANSWER…）+ `output.verification` 证据（命令 / 退出码 / 耗时 / 输出摘要 + sha256 digest，经 `@ai-se/evidence` 单一脱敏 sink）→ 交工作流引擎既有失败策略（policy / failureRouter）处理，不新建机制。
3. **逐条 AC 结果**：测试检查的全量输出按**测试名中的 AC 编号**确定性解析（TAP `ok/not ok N - [AC-xx] …`；兼容 ✓/× 记号；同名合并 fail 优先；AC-1 → AC-01 归一化）→ `verification.acResults`（供 C-5 追溯表）。
4. **flaky 处理**：检查命令失败**重跑一次**，两次都失败才判失败（`attempts[]` + `flaked` 留证）；取消不重试（abort 语义不变）。
5. **开关**：`VERIFICATION_GATE=off|observe|enforce`（config-first；**默认 off** = 不装配包装层、行为与旧版一致；observe = 完整执行检查并记录、不覆盖）。
6. **防篡改（R5）**：dev 类任务（BACKEND/FRONTEND/DATABASE/DEBUG）执行前后对**受保护测试文件**（`*.test.*` / `*.spec.*` / test|tests|__tests__ 目录）做 sha256 快照比对；**既有**受保护文件被修改/删除 → 验证失败（纯验证规则，不新增权限/审批体系）。
7. **执行通道**：全部检查命令经 Tool Runtime 既有检查工具（`run_build` / `run_unit_test` / `run_lint` / `run_command`）→ Sandbox；工具调用经既有 `ToolCallRecorder` 审计（actor=TaskVerifier）。
8. **文档**：本节含验证规则说明；**代码权威于文档**（`docs/108` 的旧引用「docs/97」以实际为准——规则随 C-3 定稿于本记录）。

### 验证规则说明（T1）

- verdict 判定顺序：**检查失败 > 防篡改失败 > 无可用检查（unavailable）> verified**。
- 检查矩阵（可用性优先，脚本来自工作区 package.json scripts；命令一律 `npm run <script>`——沙箱镜像无 pnpm，沿用 B 段 L1 发现）：

| 任务类型 | 检查 | 工具 |
| --- | --- | --- |
| BACKEND | build + test | run_build / run_unit_test |
| FRONTEND | build +（lint 优先，回退 typecheck） | run_build / run_lint |
| DATABASE | migrate up/down（成对声明） | run_command |
| TEST | test（核对自报） | run_unit_test |
| BUILD | build | run_build |
| 其他（ANALYSIS/DESIGN/REVIEW/…） | 无 → verified=false | — |

- 证据形状（`task.output.verification`）：`{mode, verdict, verified, taskType, reason?, checks[{name, command, passed, exitCode, timedOut, attempts[], flaked, outputDigest, stdoutTail, stderrTail, durationMs, acResults?}], acResults?, acSummary?, antiTamper{verdict, changed?, reason?}, durationMs, startedAt, finishedAt}`；落库前整体过 evidence 脱敏 sink。
- **量化口径**：记录级 `durationMs` + 检查级 `durationMs` + 每任务一条 `TASK_VERIFICATION` 工作流事件（含 checks 摘要）——C-6 汇总每任务验证额外耗时；检查在沙箱内执行，**零 LLM 成本**。

### 验收对照（`docs/116` §T1）

| 验收项 | 结果 |
| --- | --- |
| Mock「自报成功但测试失败 → FAILED」单测 | ✓ 假沙箱单测（两次失败→failed+`VERIFICATION_FAILED`）+ **Docker e2e**：真沙箱 `npm run test` 退出 1 → 覆盖为 failed（退出码/尝试数/AC 明细齐全） |
| 防篡改单测 | ✓ 单测（快照差异→failed，含无可用检查时同样 failed）+ **Docker e2e**（inner 改写 `test/api.test.mjs` → `changed=["test/api.test.mjs"]`） |
| E1 假阳性率较 B 基线下降（C-6 验证） | 待 C-6（enforce 模式批次） |
| 验证额外耗时/成本量化 | ✓ 记录级+检查级 `durationMs`、`TASK_VERIFICATION` 事件（C-6 聚合）；纯沙箱执行、无 LLM 成本 |
| 开关关闭行为与旧版一致 | ✓ 默认 off（config 单测）+ off 不装配包装层（wiring 分支）；全量回归见下 |

### 验证（命令与数字）

- server：**24 文件 / 全绿**（新增 `taskVerifierRules` 11 + `taskVerifier` 11 + `verificationGate.e2e` 3，`config` +1）；
- `tsc --noEmit` ✓、eslint ✓、prettier 净；
- Docker e2e 实测（真沙箱→Tool Runtime→检查工具）：通过场景 acResults `{AC-01: passed, AC-02: passed}`、失败场景两次尝试覆盖自报、防篡改命中；
- 全仓门禁（串行，2026-10-06 22:58–23:02）：**typecheck / lint / prettier 全 0**；16 包测试 15 绿 + web 既存 5 红（同 C-2）——server **26 文件 / 132 全绿**（另一次全量含 1 次 `failureRecovery.e2e` flake：单跑 10/10 + 全量复跑即绿，与 B-4 资源竞争判例一致）、database **45**（含 C-2 补记新增落库用例）、agent-core 111、shared 50、mcp 235、visual 83、browser 38、evidence 38、workflow-engine 35、eval 22、tool-runtime 12、其余全绿；
- **47557 已重启装载 C-3 代码**（pid 99078；`VERIFICATION_GATE` 缺省 `off`——enforce 由 C-6 批次显式开启）：health=200、AC 端点 200。

### 实施期发现（转记）

- 验证门默认 off → 既有 15 包与全部 e2e（含 v1GoldenScenario）行为零变化（回归证明）；server 套件在新增 3 个文件（含 1 个 docker e2e）后并行运行，`failureRecovery`/`v1GoldenScenario` 各出现过一次单点 flake，均经「单跑 + 全量复跑」证伪，非代码回归。

### 关键实现决策（供归档）

1. 检查命令统一 `npm run <script>`（沙箱 node:22-bookworm 有 npm、无 pnpm）；脚本存在性经**沙箱探针**读取（不直读宿主文件，保持路径校验与执行通道单源）。
2. 仅对"自报成功"的任务做验证：内层结果非 succeeded（含取消/超时）原样透传、零额外开销；防篡改快照只对 dev 类任务付费。
3. 证据只落摘要：全量输出仅用于 AC 解析；落库为 digest + 2k 尾部（脱敏后），避免大输出入库。
4. 逐条 AC 取**末次尝试**输出（flaky 时记录最终判定）；`TASK_VERIFICATION` 单事件承载 C-6 聚合字段。

## C-4 · N4：测试先行 + 红灯检查（**已完成**）

### 交付物（对照 `docs/116` §N4）

1. **切片内任务顺序（规划提示词 + 确定性校验）**：
   - 提示词（`taskPlanWithDagRepair` 的 acHint，编号 PRD 时注入）：TEST 任务须以 AC 编号命名其测试（如 `[AC-01]`）并先于实现；实现类任务（BACKEND/FRONTEND/DATABASE）须**直接或传递依赖**覆盖同 AC 的 TEST 任务；每个 Must AC 必须有 TEST 任务。
   - 确定性校验（agent-core `planning/validateTestFirstPlan.ts`，随任务图重做循环注入修复提示词）：
     - `validateTestFirstOrder`：实现任务与 TEST 任务共享 AC 且无依赖路径 → 报错重做；
     - `validateMustAcTestCoverage`：切片范围内 Must AC 无 TEST 任务映射 → 报错重做。
2. **红灯检查（复用 T1 规则位）**：TEST（qa）任务的测试检查期望 = **失败**——
   - 命令以非零退出码失败 = 红灯已亮 → 通过（含逐条 AC 结果：失败 AC 正是红灯证据）；
   - 命令成功 = **空转测试** → 验证失败（reason：`red-light check passed without implementation (vacuous tests)`），经既有失败策略退回重写；
   - 未达预期（给出绿灯）/超时重跑一次（flaky 留证）；取消不重试。
3. **qa 写测试能力**（N4 前置收口，B-4 §B-4.0f L1 发现的修复）：qa-agent 增写工具与测试目录写权限（`writePaths: ["test","tests","__tests__"]`）；指令改为「先写 AC 编号测试并展示红灯，不得改产品代码」。
4. **reviewer 对应关系检查**：reviewer-agent 指令增强（复核每个 Must AC 都有 AC 编号测试）+ Must 覆盖的确定性校验（计划期，见 1）。
5. **防篡改**：复用 C-3（T1 规则位）——单测与 Docker e2e 已覆盖。
6. **局限（写明）**：LLM 写的测试也可能有误；红灯/绿灯语义以测试实际执行为准，最终仍以独立 oracle 为准。

### 验收对照（`docs/116` §N4）

| 验收项 | 结果 |
| --- | --- |
| 空转测试被红灯检查拦下（单测） | ✓ 单测（绿灯两次 → failed + red-light 原因）+ **Docker e2e**（真沙箱全绿套件 → TEST 任务判空转、覆盖为 FAILED）；反例：失败套件一次即通过（红灯已亮） |
| 开发任务修改测试文件判失败（单测） | ✓ C-3 防篡改（单测 + Docker e2e，原样成立） |
| 计划期顺序保障 | ✓ 图级集成测试：实现任务漏依赖 → 校验红 → 修复提示词注入 → 重做后依赖补齐（`taskPlanAttempts≈2`） |
| E1 中全部 Must AC 均有 AC 编号测试（C-6 统计） | 机制就位（Must 覆盖校验 + AC 命名提示词 + AC 结果解析）；数字由 C-6 批次统计 |

### 验证（命令与数字）

- agent-core：**20 文件 / 120 全绿**（+1 文件 +9 用例：校验器 8 + 图级修复循环集成 1）；
- server：**26 文件 / 137 全绿**（+5：红灯单测 3 + 红灯 Docker e2e 2）；
- agent-core / server lint ✓、改动文件 prettier 净；
- 全仓门禁（串行，2026-10-06 23:08–23:13）：**typecheck / lint / prettier 全 0**；16 包测试 15 绿 + web 既存 5 红——server **26 文件 / 137 全绿**、agent-core **20 文件 / 120 全绿**、database 45、shared 50、mcp 235、visual 83、browser 38、evidence 38、workflow-engine 35、eval 22、tool-runtime 12、其余全绿；
- **47557 已重启装载 C-4 代码**（缺省 `VERIFICATION_GATE=off` 不变）：health=200、pid 22369。

### 关键实现决策（供归档）

1. 红灯 = **同一验证门的位置**（TEST 任务测试检查的期望翻转），不新增检查类型/体系；`expected` 字段随证据落盘，供 C-5/C-6 区分红/绿语义。
2. 空转判定 = 「命令以退出码 0 成功」；无退出码的通道错误（SANDBOX_ERROR 等）不算红灯证据（重试后仍无 → 判失败，不冒充红灯）。
3. 顺序校验只看**依赖可达性**（直接或传递），实现任务与多个 TEST 任务相交时逐个核对；无编号 AC（criteria 空）时全部跳过（既有行为不变）。
4. qa 写权限收窄到测试目录（不放开产品代码）；writePaths 匹配语义为前缀目录（`test/…`、`tests/…`、`__tests__/…`）。

## C-5 · N5：追溯表（**已完成**）

### 交付物（对照 `docs/116` §N5）

1. **确定性生成器（零 LLM）**：`apps/server/src/services/traceability.ts` 纯函数 `buildRequirementTraceability`——FR → AC → 测试 → 执行结果 → 证据（命令/退出码/输出摘要+时间）；每条 AC 状态 ∈ {通过 / 失败 / 未验证 / 无测试覆盖}；另有 `renderTraceabilityMarkdown` 按需导出。
2. **数据源**：N3 的 AC 一等记录 + 任务映射（`tasks.input.acKeys`，计划行与运行时克隆）+ T1/N4 的逐条 AC 结果与证据（`task.output.verification.checks[].acResults`）。
3. **输出**：`GET /api/requirements/:id/traceability`（JSON；`?format=markdown` 按需导出）+ 需求页「追溯表」卡片（状态徽标 + 测试/证据行）；数据库只读方法 `findRuntimeTasksByRequirementId`（经 workflow_runs 关联）。
4. **判定口径（确定性）**：绿灯证据（`expected=pass` 检查的 acResults）优先——任一失败 → **失败**；否则任一通过 → **通过**；否则无 TEST 任务映射 → **无测试覆盖**；否则 → **未验证**。同一计划任务的多次执行取**最新**（重跑覆盖旧证据）。红灯证据（`expected=fail`）不参与最终判定。

### 验收对照（`docs/116` §N5）

| 验收项 | 结果 |
| --- | --- |
| E1 一次运行后追溯表覆盖全部 30 条 AC | 机制就位；数字由 C-6 批次统计（E1 需先重规划 + enforce 运行才有执行证据） |
| 「无测试覆盖」数为 0 或明确列出 | ✓ 输出含 `noTest` 计数 + 每条 `status=no-test` 明确列出（单测覆盖） |
| 生成过程**零 LLM 调用**（可断言） | ✓ 纯函数（输入仅既有记录/任务输出，无模型依赖；单测直接以普通数据构建） |
| 有单测 | ✓ server `traceability.test.ts` 6 用例（passed / failed / 红灯不判定 / no-test / unverified / 最新执行去重 / Markdown 导出） |

### 验证（命令与数字）

- server：**27 文件 / 143 全绿**（+1 文件 +6 用例；sliceFlow.e2e 增追溯端点断言：状态枚举、条目数对齐 AC 视图）；
- web：store 用例 **5/5**（+1 N5 用例）；web lint ✓（含 .vue）、改动文件 prettier 净；server typecheck ✓；
- 全仓门禁（串行，2026-10-06 23:19–23:33）：**typecheck / lint / prettier 全 0**——首轮 typecheck 暴露并修复 web 一处 `status` 类型引用错误（`.vue` 变更 vitest 不查类型，以 vue-tsc 为准；已记入技能）；16 包测试：除 web 既存 5 红外全绿——server **27 文件 / 143 全绿**（并行负载下偶发单文件 flake：agentsApi ×1、failureRecovery ×2 次复现，均经「单跑绿 + 全量复跑 143 全绿」证伪，属 B-4 记载的资源竞争家族）、agent-core 120、database 45、shared 50、mcp 235、visual 83、browser 38、evidence 38、workflow-engine 35、eval 22 等；
- **47557 已重启装载 C-5 代码**：health=200、pid 92368；`GET /api/requirements/:id/traceability` 已上线（E1 当前 `total:0`，重规划后填充）。

### 关键实现决策（供归档）

1. 「无测试覆盖」= 无 TEST 任务映射（且无绿灯证据）；红灯不判最终状态——红灯是流程要求（测试先行），不是验收结果。
2. 证据口径 = **检查级 acResults**（逐 AC 归因，含红灯/绿灯 expected 语义），而非记录级合并值。
3. 重跑/多切片场景：同一 `plan_task_id` 仅取最新执行（`finishedAt` 降序）；不聚合历史，避免旧失败污染最新状态。
4. 导出为按需生成（API 参数），不自动落盘（符合「默认按需生成、可选导出」）。

## C-6 · E1 ×3：验收链路对比批次（**已完成**）

### 运行方法（2026-10-07，3h31m 墙钟）

1. **开跑前**：配额快照（周窗口 10-04 23:00 UTC 起 5,809,657 in）；E1 触发重规划（`POST /analyze {regenerate:true}` → level-1 v6 → 关口 1 批准 → slice-1 规划 v7；**规划期真实触发 1 次校验红 + 修复重做后通过**（N3/N4 校验器在真实流程首次生效）；AC 一等记录 **30 条**；slices 2–5 待链路推进）。
2. **受控实例 47557**：装载全部 C 代码 + `VERIFICATION_GATE=enforce`（`SUBMIT_RESULT_MODE=tool`、`PLANNING_MODE=two-level`；非 watch、persist）。
3. **批次脚本** `packages/eval/scripts/e1-c6-split.sh`（与基线同法：逐 run 调用 + 30 分钟冷却 + 20M 输入护栏 + health 前置检查；ASCII 校验 + `bash -n`）＋独立看门狗 `e1-c6-watchdog.sh`（睡眠哨兵 + 批次死亡检测）＋ `caffeinate -s -d -i`（`pmset` 断言核验 PreventSystemSleep=1）。
4. 窗口：**07:47:32 → 11:18:13**（无睡眠事件；看门狗 `WATCHDOG-DONE batch complete`）。

### 三 run 数据（对照 B 基线，`docs/115` §B-4）

| 项 | B 基线 ×3（改前） | C-6 run-1 | C-6 run-2 | C-6 run-3 |
| --- | --- | --- | --- | --- |
| oracle 真通过 | **1/3**（33.3%） | ✗（Must 5/29） | ✗（Must 7/29） | ✗（Must 28/29） |
| 自报成功 | 0/3 | 0/1 | 0/1 | 0/1 |
| **假阳性** | 0/3 | 0 | 0 | 0 |
| 解析降级率 | ~79%（run-1 实测 50/63=79.4%） | **0%** | **0%** | **0%** |
| 人工介入 | 0 | 0 | 0 | 0 |
| 输入/输出 token | 5.63M / 0.19M | 848,588 / 40,684 | 894,595 / 50,592 | 72,487 / 9,650 |
| 时长 | 4h06m+1h42m+1h11m | 57m08s | 69m23s | 24m09s |
| 终止机制 | 单任务 600s 超时×2 → 链停 | T-13 红灯检查覆盖失败（**误杀**，见发现 1） | T-13 QA **自我判失败**（诚实自报，见发现 4） | T-08 超时×2 → FAILED |

- 三 run 均「复用计划 v7」；工作区 = `/Users/shixianbao/Desktop/study/ai-se-eval/E1/run-1`（`--runs 1` 拆分调用下逐 run 全量重建——与基线同一方法）。
- **验证门活体数据**：run-1/run-2 各 **8 个 dev 任务 verdict=verified**（经沙箱真实执行 npm scripts 全绿）；ANALYSIS/DESIGN/REVIEW/TEST 无可用检查 → `unavailable`（诚实不伪造，符合 C-3 设计）。
- run-1 T-13 的检查产物：`expected=fail` 红灯检查、`acResults` 8/8 通过（AC-01/21/22/24/25/26/29/30）——即**套件真实可用**（见发现 1）。
- 批次后总周用量：5,809,657 → 7,625,327（**已记录** +1,815,670；幽灵部分未记录，见发现 3）。

### 新发现（真实运行暴露，均为 C-6 的产出物）

1. **红灯检查对「回归型 TEST 任务」误杀（设计口径缺陷）**：run-1 T-13（构建契约与端到端回归）在实现完成、套件**合法全绿**（8/8 AC 断言通过、19 测试 18 过 1 跳）时，被红灯规则判为「vacuous tests」→ 覆盖 FAILED → 链停。**红灯语义须区分「实现前的 TEST（期望红）」与「回归/收尾 TEST（期望绿）」**——建议修复方向：当该 TEST 任务覆盖的 AC 已有 verified 实现证据时不施加红学期望（或红灯仅限先于实现的任务序位）。
2. **超时 ≠ 终止（超时泄漏，执行层缺陷）**：四个 `timed_out` run 的工具调用全部越过记录死亡时间——T-10 **+4min**（53 次调用）、T-14 **+2min**、T-08#1 **+23min（捕获时仍活）**、T-08#2 **+10min**（54 次）；幽灵在「死后」持续写工作区、持续烧配额。证据：`results/e1-c6/evidence/ghosts.txt`（工具调用时间戳跨度）；已通过重启受控实例终止孤儿（冻结验证：重启后工具调用零新增）。
3. **timed_out run 的 token 计为 0（记账缺口）**：四个超时 run 全部 0 token → C-6 成本数字为**下界**（幽灵燃烧未记录、未计入周窗口）。
4. **QA 自我诚实失败样本（正向）**：run-2 T-13 的 issues 明确指出「transport-only 断言在业务缺失时仍全绿（假绿）」并给出修复建议，`outcome=FAILED` 由 QA 自身判定——N4 语义在「自我判定」路径上的正向样本。
5. **E1 夹具沙箱环境缺口复现**（`docs/115` §B-4.0f L1#1）：沙箱无 pnpm、无网络——5 步构建链第 1 步（`pnpm install --frozen-lockfile`）不可执行（步骤 2–5 exit 0）。
6. run-3 的 oracle（Must 28/29）打在 T-08#1 幽灵**进行时**的工作区上（幽灵 03:01–03:04 写入完整 `src/**`（931 行），随后 25 分钟持续自测）；**该数字不能作为「验收链路可达 28/29」的证据**。

### 验收对照（`docs/116` §C-6）

| 验收项 | 结果 |
| --- | --- |
| E1 ×3 完整对比数据（真成功率/假阳性/介入/成本/耗时/失败机制） | ✓ 见上表；真成功 **0/3**（基线 1/3） |
| 假阳性不升高 | ✓ 0/3 = 0/3；且原本可能的「静默假成功」路径被两道机制拦截（红灯检查 + QA 自我判定） |
| 真成功率下降如实报告、**不放松检查** | ✓ 如实记录；下降主因 = 发现 1 误杀 + 发现 2 超时链停；未修改任何检查口径 |
| 逐 run 检查点 + 配额护栏 | ✓ 每 run 边界核对（5.81M → 6.66M → 7.55M → 7.63M）；20M 护栏未触发 |
| 降级率（C-1 目标） | ✓ **0%**（对照参照 76.7%，`outcomeMode=tool` 全量生效） |

### 局限（写明）

- 三 run 均止步切片 1（共 5 切片）——「E1 全量通过」需要全链推进，任何单点失败即止；当前阻碍 = 发现 1（run-1）/ 发现 2 家族（run-3）。
- run-3 的 28/29 为幽灵进行时快照（见发现 6）；真正待验证的是修复发现 1/2 后链路能否完整跑完 5 切片。
- C-6 成本数字为下界（发现 3）。

### 结论

- C-6 完成：数据、证据、缺陷全部捕获（产物：`packages/eval/results/e1-c6/run-{1,2,3}.json`、`run-{1,2,3}-summary.md`、`evidence/preflight.txt`、`evidence/ghosts.txt`、`COMPARISON.md`）。
- **阶段 C 全部完成（C-1…C-6）**。出口对比：假阳性维持 0；**降级率 0%（vs ~79% 基线）为 C-1 的明确收益**；真成功率 0/3（vs 1/3）如实呈报，主因是两个**新暴露的缺陷**（发现 1 规则口径、发现 2/3 执行层）——按任务书「不为数字放松检查」执行。
- 待办（独立立项，不属 C）：① 红灯语义细分（发现 1）；② 超时终止传播 + timed_out token 记账（发现 2/3）；③ E1 沙箱 pnpm/网络（既有 L1#1）。

## 阶段 C 完成报告（收尾，2026-10-07）

### 1. 交付总览

| 项 | 内容 | 状态 |
| --- | --- | --- |
| C-1（T2） | `submit_result` 结构化提交（`SUBMIT_RESULT_MODE`，默认 tool） | **已完成**（§C-1） |
| C-2（N3） | 验收标准一等记录（解析/落库/映射/端点/web） | **已完成**（§C-2） |
| C-3（T1） | 确定性验证门（`VERIFICATION_GATE` off/observe/enforce） | **已完成**（§C-3） |
| C-4（N4） | 测试先行校验 + 红灯检查 + qa 写测试 | **已完成**（§C-4） |
| C-5（N5） | 追溯表（确定性生成 + 端点 + web 卡片） | **已完成**（§C-5） |
| C-6 | E1 ×3 对比批次（重规划 → enforce → 3 run） | **已完成**（§C-6） |

### 2. 变更文件清单（按模块；时间戳 = 实施日期）

- **shared**（10-06）：`packages/shared/src/index.ts`（`AcceptanceCriterionSchema` / `RequirementAcceptanceCriteriaView`、`Traceability*`、`TaskSchema.acKeys?`）。
- **agent-core**（10-06）：`src/planning/acceptanceCriteria.ts`（新，158 行）、`src/planning/validateAcceptanceCoverage.ts`（新，43 行）、`src/planning/validateTestFirstPlan.ts`（新，99 行）、`src/planning/PlanningGraph.ts`（acHint 注入）、`src/professional/AgentRegistry.ts`（qa 写测试权限 `writePaths:["test","tests","__tests__"]` + reviewer 指令）、`src/index.ts`（导出）；测试：`acceptanceCriteria.test.ts`、`validateAcceptanceCoverage.test.ts`、`validateTestFirstPlan.test.ts`（140 行）、`PlanningGraph.test.ts`。
- **database**（10-06）：`migrations/013_phaseC_requirement_acceptance_criteria.sql`（新，31 行）、`src/planningRepositories.ts`（AC 替换/映射计数 + **acKeys 落库修复**）、`src/migrate.test.ts`（12→13）、`src/planningRepositories.test.ts`。
- **server**（10-06）：`src/config.ts`（`SUBMIT_RESULT_MODE`、`VERIFICATION_GATE`）、`src/index.ts`（验证门装配）、`src/services/workflowTaskExecutor.ts`（工具提交接线）、`src/services/planningService.ts`（`ensureAcceptanceCriteria` / `getRequirementAcceptanceCriteria` / `getRequirementTraceability`）、`src/services/taskVerifierRules.ts`（新）、`src/services/taskVerifier.ts`（新）、`src/services/verifyingTaskExecutor.ts`（新，74 行）、`src/services/traceability.ts`（新，168 行）、`src/routes/planning.ts`（2 端点）；测试：`__tests__/taskVerifierRules.test.ts`（165 行）、`taskVerifier.test.ts`（396 行）、`verificationGate.e2e.test.ts`（真沙箱 5 用例）、`traceability.test.ts`、`sliceFlow.e2e.test.ts`、`config.test.ts`、`professionalAgents.e2e.test.ts`。
- **web**（10-06）：`src/api/requirements.ts`、`src/stores/requirements.ts`、`src/views/RequirementsView.vue`、`src/stores/__tests__/requirements.test.ts`。
- **eval / scripts**（10-07）：`packages/eval/scripts/e1-c6-split.sh`（新）、`e1-c6-watchdog.sh`（新）；结果档案 `packages/eval/results/e1-c6/**`。
- **docs**（10-07）：`docs/117-phase-c-record.md`（本记录，定稿）。

### 3. 逐项结果与证据锚点（T2 / N3 / T1 / N4 / N5 / C-6）

1. **T2**：S1 真模型冒烟（`results/smoke/c1-s1-submit-result.json`）——**自报成功、oracle 10/10 断言通过、任务 10/10 SUCCESS、`outcomeMode=tool` 10/10**、`parseRecoveryRuns=0`；C-6 复证：三 run `parseRecovery 0/3`（对照 B-4 的 ~79% 降级率）。
2. **N3**：E1 开发库实据 **9 FR / 30 AC、零重复、AC-01…AC-30**（哈希校验）；迁移 013 已应用；`GET /api/requirements/:id/acceptance-criteria` live（C-6 时计数 30）；`acKeys` 落库修复复证（v7 任务行 `input.acKeys` 非空，database 45/45）。
3. **T1**：`VERIFICATION_GATE` 默认 off（15 包与全部 e2e 零变化）→ enforce 活体：**run-1/run-2 各 8 个 dev 任务 verdict=verified**（沙箱真实执行 npm scripts 全绿）；verdict 优先级（检查失败 > 防篡改 > unavailable > verified）有单测+真沙箱 e2e 覆盖。
4. **N4**：`validateTestFirstPlan`（顺序+Must 覆盖）在重规划中**真实拦截 1 次并修复重做通过**；红灯检查活体触发（run-1 T-13——暴露误杀缺陷，见 §5）；qa 写测试活体（`test/health.test.js` 落工作区）。
5. **N5**：`buildRequirementTraceability` 纯函数（零 LLM，6 用例）；`GET /api/requirements/:id/traceability`（JSON + `?format=markdown`）live；web 追溯表卡片；数据源 = AC 记录 + 任务映射 + 检查级 acResults。
6. **C-6**：对比表见 §C-6——**真成功 0/3（基线 1/3）、假阳性 0/3、降级率 0%（vs ~79%）、tokens 1.82M 记录（下界）**；失败机制：红灯误杀（run-1）、QA 诚实自判（run-2）、T-08 超时链停（run-3）；三个新发现（见 §C-6 发现 1–3）。

### 4. 门禁数字（C 收尾复核）

- 全仓门禁（串行）：**typecheck / lint / prettier 全 0**（2026-10-06 23:19–23:33 终次）。
- 测试：server **27 文件 / 143 全绿**；agent-core 20 文件 / 120；database 45；shared 50；mcp 235；visual 83；browser 38；evidence 38；workflow-engine 35；eval 22；tool-runtime 12；**web 321/322（5 红 = 既有 eyebrow 族，非本次引入）**；其余包全绿。并行 flake 家族（v1GoldenScenario / failureRecovery / agentsApi）均经「单跑绿 + 全量复跑」证伪，与 B-4 判例一致。
- C-6 批次运行期零代码改动（enforce 门为配置切换），门禁数字维持 C-5 末值。

### 5. 未完成事项与偏差（如实记录）

1. **红灯语义误杀回归型 TEST**（C-6 发现 1）——待独立修复（修复方向已记 §C-6）。
2. **超时 ≠ 终止 + timed_out token=0**（C-6 发现 2/3）——执行层缺陷，待独立修复；C-6 成本数字为下界。
3. **E1 沙箱 pnpm/网络缺口**（L1#1 复现）——夹具环境限制，非代码缺陷。
4. **B 段结转未清**：310 孤儿 PENDING 任务（无害）、web 5 红（既有）、E1 超时放大机制样本。
5. **偏差**：C-6 预估 10–15h，实际 3h31m（链提前终止 + 幽灵机制）；三 run 均止步切片 1（共 5）；真成功率 0/3 如实呈报、未放松任何检查。

### 6. STOP

阶段 C 全部完成；**不进入阶段 D**。下一步（阶段 D：部署与安全，T8+N6）等待任务书授权。
