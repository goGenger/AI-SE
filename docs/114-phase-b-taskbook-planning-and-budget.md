# 114 · 阶段 B 任务书：规划改造与预算（N0 / N1 / N2 / T6）

> 来源：`docs/111-task-plan-v2.md` §4（阶段 B 行）、§5（N0）、§3 R1/R2/R7 + 用户任务书《AI-SE 平台调整后任务规划 v2》§6「阶段 B：规划改造与预算」与附录 A。
> 编号说明：**114 = 本任务书**（B 段连号 114/115 中的任务书）；实施完成后，记录写入 **`docs/115-phase-b-record.md`**（不占用 114，不覆盖任何既有文档）。
> 定位：让 **PRD 级输入能规划、成本可控**。B 四项：**N0**（E1 夹具与隐藏 oracle）、**N1**（180s 决策记录）、**N2**（两级规划 + 分阶段预算）、**T6**（工作流级预算上限）。B 是阶段 C/D/E 的前置；其中 **N0 与可构建性验证是最关键的前置**（不通过则 BLOCKED，见 §N0-5）。

## 使用方式

1. 先读本任务书全文，回复「开始实施」或直接指出要改的地方；**未确认前不动任何代码与数据**。
2. 本任务书覆盖四项、体量较大：按 §实施顺序 的 **B-1…B-4 分次实施**，每步可独立停下；任一步发现范围外问题：只登记、不顺手修。
3. 完成后按 §完成后 输出报告并 **STOP**（不自动进入阶段 C）。

## 严格范围

**做（N0/N1/N2/T6 四项 + B 出口验证 B-4）：**

1. **N0**：E1 夹具建设——PRD 正文（9 FR / 30 AC）、隐藏 oracle、oracle 自检（参考实现 + 5–6 变异版本）、可构建性验证、评测包最小集成。
2. **N1**：180s 处理**决策记录**（不写代码）。
3. **N2**：两级规划（切片计划 → 关口 1 → 第二级）+ 分阶段预算与重试 + 旧路径开关。
4. **T6**：工作流级预算上限（`maxCostUsd` / `maxTokens` / `maxWallClockMs`）。
5. **B 出口验证**（B-4）：全量评测两遍（噪声线）+ E1 ×3 改前基线（长运行，逐批授权）。

**禁止：**

- 不破红线：Tool Runtime 唯一执行路径、执行经 Sandbox；**不新建第二套 Permission / Approval / Audit / 错误码**（关口 1 复用既有 approvals 机制，T6 复用既有 PAUSED / resume / 事件通道）。
- **E1 隔离**：PRD 全文、oracle、参考实现、变异版本**不得进入任何工作区、不得进入提示词、不得由被测 Agent 编写或读取**（沿用 `docs/109` §架构判定 5 的隔离约定）；不放松或改写既有 8 个夹具的 oracle 断言。
- 不删除旧的一次性规划路径（留在开关后面，供 S 档回归）。
- 不做 N3–N7 的内容（AC 结构化、测试先行、追溯表、部署闭环、端到端验收、并行化）；不顺手改控制台其他页面。
- 不伪造、不回填、不外推任何样本；拿不到就写「未取得 + 原因」。
- 长任务纪律：全量评测、E1 ×3 等**先给预估、获授权后再跑**（沿用 P0 硬要求）；评测只动 `[eval]` 前缀数据，清理前先留证。
- 不改阶段 A 产出（`docs/112`/`docs/113`）与 `docs/1`–`docs/113` 历史文档（`docs/110` 仅按 B-4 结果补写）。

## 必读清单

**文档**：`docs/111`（§3 R1/R2/R7、§4、§5、§7.1）、`docs/110`（§7.1 规划超时证据链）、`docs/109`（P0 冻结口径：策略、指标、oracle 隔离）、`docs/108`（§4 P4/P7 原始条目）、`docs/112`/`docs/113`（阶段 A 现场与口径）、用户任务书 v2（§6 阶段 B + 附录 A）。

**代码（实施前逐项核对，代码权威于文档）**：

- 评测包：`packages/eval/src/{cli,harness,oracle,types}.ts`、`packages/eval/fixtures/S1/{fixture.json,oracle.mjs,template/}`。
- 规划链路：`apps/server/src/services/planningService.ts`（`PLANNING_TIMEOUT_MS :36`，`:310` `defaultTimeoutMs` 与 `:345` `timeoutMs`，`savePlanningResult` 接线 `:313`）；`packages/agent-core/src/planning/{PlanningGraph,PlanningAgent,PlanningState,validatePlanningOutput,validateTaskGraph}.ts` 与 `prompts/`（8 个阶段提示词 + `repair.prompt.ts`）；`packages/database/src/planningRepositories.ts`（`savePlanningResult`，`:504` 置 `ANALYZED`）。
- 工作流引擎：`packages/workflow-engine/src/{WorkflowEngine,stateMachine,types}.ts`（`advanceOnce` `:277`–`:354`；审批分支 `:301`–`:332`；`pause/resume` `:71`–`:93`；`approve/reject` `:192`–`:246`；claim 循环 `:341`）。
- 数据/契约：`packages/shared/src/index.ts`（`RequirementStatusSchema :253`、`WorkflowPolicySchema :612`（**strict**）、`CreateWorkflowSchema :624`、`Approval* :660`）；`packages/database/migrations/003`（requirements CHECK、tasks 表）、`004`（workflow_runs、approvals DDL `:91`–`:114`）；`packages/database/src/workflowRepositories.ts`（计划任务绑定 `:324`–`:382`，`approvalTaskKeys` `:382`）。
- 服务/路由：`apps/server/src/routes/{workflows,planning}.ts`（`/workflows/:id/approvals` `:109`、`/approvals/:id/{approve|reject}` `:153`）；`apps/server/src/services/workflowService.ts`；`apps/server/src/config.ts`（config-first）。
- 交付链（可构建性验证的契约方）：`apps/server/src/services/deliveryAdapters.ts`（`LocalCiOperations` `:136`：`pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build` → `docker build`；健康检查 `checkEndpoint` 探测 `/health` 与 `/ready`）；`apps/server/src/index.ts`（`:147`/`:148` 注入）。
- 控制台：`apps/web/src/views/WorkflowsView.vue`（审批面板 `:489`–`:501`）、`apps/web/src/stores/workflows.ts`（`decide :200`）、`apps/web/src/api/workflows.ts`（`decideApproval :74`）、`apps/web/src/views/RequirementsView.vue`（分析入口）、`viewmodels/requirementViewModel.ts`。

## 实施顺序（B-1…B-4，可独立停下）

| 步骤 | 内容                     | 依赖    | 依赖产出/说明                                          |
| ---- | ------------------------ | ------- | ------------------------------------------------------ |
| B-1  | **N0** E1 夹具建设       | —       | 先做**可构建性验证**；不通过 → BLOCKED，不进入后续     |
| B-2  | **N1** 决策记录 → **N2** | —       | 内部顺序：N1 先落笔（`docs/115` §N1），再按决策实现 N2 |
| B-3  | **T6** 预算上限          | —       | 与 B-2 可并行、可后置                                  |
| B-4  | **阶段 B 出口验证**      | B-1/2/3 | 全量评测两遍 + E1 ×3；**两批长运行逐批授权**           |

## N0 —— E1 夹具建设（B-1）

**问题**：阶段 B 出口、C 出口对比、D/E 的验收全部以 E1 为输入，但 E1 的 PRD、隐藏 oracle、oracle 自检**均不存在**（全仓 0 命中，`docs/111` §2 行 9）。

**交付物**：

1. **E1 PRD 正文**（写入 `packages/eval/fixtures/E1/fixture.json` 的 `requirementText`，夹具内为唯一源）：
   - TaskBoard 应用需求：**9 个 FR / 30 条 AC**；每条 AC 含：编号（`AC-01`…`AC-30`）、文本、优先级（Must/Should）、验证方式、是否 smoke；并含 FR↔AC 映射表。
   - 类别覆盖（对齐 v2 附录 A）：API 类（AC-01–20、23、27、28）、数据类（AC-04）、页面类（AC-21、22）、部署类（AC-24–26、29）、工程类（AC-30）；**并覆盖附录 A 的隐藏边界检查**：`title` 恰好 100 / 101 字符、含中文/emoji/首尾空格、非法 `dueDate`（`2026-02-30`、`2026-13-01`）、用户名大小写冲突（`Alice`/`alice`）、并发注册同一用户名恰好一次成功、令牌被篡改/截断、搜索关键字含引号/分号/SQL 片段不得 500、用户 B 用用户 A 的任务 ID 查询/修改/删除。
   - 工程契约（写进 PRD、可被脚本直接执行）：pnpm 工程；`pnpm install --frozen-lockfile` → `lint` → `typecheck` → `test` → `build` → `docker build` **六步全过**（与 `LocalCiOperations` 契约一致）；`pnpm start` 起服务、端口读 `PORT`、健康端点 `/healthz`（另提供 `/health`、`/ready` 供平台部署链 `checkEndpoint`）；`Dockerfile`（非 root 用户、数据卷持久化、日志输出 stdout）；README 文档化启动/测试/构建命令；`test` 用 `node --test`，**每个 Must AC 至少一个测试且测试名含对应 AC 编号**（为阶段 C 的 N4/追溯表预留契约）。
   - 判定粒度：所有 Must AC 均可被黑盒 oracle 客观判定，不得依赖主观描述。
2. **隐藏 oracle**：`packages/eval/fixtures/E1/oracle.mjs`（Node + `fetch` 黑盒）：按 PRD 文档化命令启动应用 → 等待健康端点 → 逐条执行 30 条 AC 与边界检查 → 输出**逐条 AC 的 JSON 结果**到 stdout；`exit 0` = 全部 Must 通过。与既有 oracle 同约定（`oracle.ts`：exitCode 0 判定、cwd=夹具目录、workspace 路径作 `argv[2]`、只读工作区）。
3. **oracle 自检**（必须做）：
   - **参考实现** `packages/eval/fixtures/E1/reference/`：oracle 对其**全 Must 通过**；
   - **5–6 个变异版本** `packages/eval/fixtures/E1/mutants/`：必须**全部被检出**（例：去掉数据隔离、明文存密码、错误码写错、`PATCH` 忽略未知字段、重启后丢数据）；
   - 自检脚本（`fixtures/E1/selfcheck.mjs` 或等效）产出「逐变异检出」结果表；**不并入常规单测**（docker 依赖，避免门禁失稳；理由记入 `docs/115`）。
4. **AC↔断言对照表** `packages/eval/fixtures/E1/ac-map.md`：30 条 AC × oracle 断言 id 一一对应；脚本校验**无孤立断言、无未覆盖 AC**。
5. **可构建性验证**（关键前置）：用 E1 形态的最小骨架在夹具工作区走通平台构建段——git 仓库（含一次 commit）+ `pnpm install --frozen-lockfile`/`lint`/`typecheck`/`test`/`build`/`docker build`（`LocalCiOperations` 契约）；结果（命令 + 退出码）记入 `docs/115`；**不通过则 BLOCKED 报告，不进入 N2 及后续**。
6. **评测包最小集成**（`packages/eval` 内）：`Tier` 增字面量 `"E1"`（`types.ts:5`）；fixture 增可选 `oracleTimeoutMs` / `runTimeoutMs` 覆盖（E1 建议 oracle ≤ 20 min、单次 run ≤ 120 min；S/M/L 维持 60 s / 45 min 不变）；`cli.ts`/`harness.ts` 按覆盖值运行；`template/` 留最小占位文件，确保 `prepareWorkspace` 的 git init/add/commit 流程可用（`cli.ts:148`–`150`）。

**验收**：oracle 对参考实现全 Must 通过；5–6 个变异版本全部被检出；AC↔断言一一对应（无孤立断言）；六步构建全过。

## N1 —— 180s 决策记录（B-2，不写代码）

**交付物**：`docs/115` §N1「180s 处理决策记录」——含①分阶段耗时表（来源：`docs/110` §7.1 实测 + B 实施时新证据）；②处理决策（冻结默认）：把单一 `PLANNING_TIMEOUT_MS = 180_000` 常量改为**分阶段预算 + 可配置（config-first）+ 总预算兜底**，实现落在 N2；③与 T6 的分工声明：N2 管**规划内部**预算，T6 管**工作流整体**预算。

**验收**：记录完整（耗时表 + 决策 + 分工）；**N2 开工前先落笔**（该记录作为 N2 的输入）。

## N2 —— 两级规划 + 分阶段预算（B-2 核心）

**交付物**：

1. **第一级：切片计划**。新增规划阶段 `slice_planning`（`PlanningState.ts` 的 `PLANNING_STAGES` 扩展 + 新提示词 `prompts/slice-planning.prompt.ts` + 新 schema `SlicePlanSchema`，落 `packages/shared`）：输入 = `requirement_analysis` 的 FR 集；输出 = 切片列表（每片：`id`、目标、涵盖 FR 编号集、依赖、顺序）+ 里程碑；**每片规模上限 3–5 个 FR**；持久化为新表 `requirement_slices`（迁移 011，repo 风格）。
2. **确定性覆盖检查**（代码，非 LLM）：每个 FR 至少被一个切片涵盖；切片不得引用 FR 集之外的编号（无虚构）；不通过 → 自动重做第一级（上限 2 次），仍失败 → 需求 `FAILED` + 事件。
3. **关口 1**（复用既有 approvals；见 §架构判定 5）：需求新增状态 `PLANNING_REVIEW`（同步 `shared` 枚举、requirements CHECK、控制台标签、harness 处理）；切片计划产出后创建切片审批（PENDING）；控制台需求页展示切片计划 + 批准/拒绝（复用 `WorkflowsView.vue:489`–`501` 的审批交互模式与 `/api/approvals/:id/{approve|reject}`）；**批准 → 进入第二级**；**拒绝（comment = 修改意见）→ 重做第一级**（上限 2 次）。v1 的「修改」= 拒绝并重做，不做在线编辑（记已知限制）。
4. **第二级：切片 → 任务**。进入某切片时，才对它执行既有 spec 阶段 + `task_planning`：**各阶段独立超时与重试**（`PlanningGraph` 的 `stageNode`/`generateWithRepair` 外包 per-stage timeout/retry；阶段预算内置默认值 + env 覆盖，替代单一 180s，保留总预算兜底）；**按需跳过不适用的阶段**（如纯后端切片跳过 `ui_spec`；跳过发事件、记入 115）；任务计划仅覆盖该切片，`tasks` 增列 `slice_key`（迁移 011）关联切片。
5. **切片顺序执行**：同一需求的切片默认不并行；前一片工作流 `SUCCESS` 后创建并启动下一片工作流（轻量编排挂在既有工作流完成路径；复用 `WorkflowService.create`/`start`，不新建调度器）；失败按既有失败策略处理、不自动前进。
6. **旧路径开关**：`PLANNING_MODE=single|two-level`（`config.ts`，config-first；**默认 `two-level`**；`single` = 旧一次性 8 阶段路径，供 S 档回归）。
7. **API / 控制台 / 评测集成（最小）**：`GET /api/requirements/:id/slices`（或并入需求详情）；`CreateWorkflowSchema` 增可选 `sliceKey`（工作流仅绑定该切片的计划任务，见 `workflowRepositories.ts:324`–`:382` 绑定链路）；需求页切片展示与确认入口；`requirementStatusLabel` 等标签函数同步（控制台中文规则）；**harness 过关口 1**：requirement 处于 `PLANNING_REVIEW` 时，harness 调用确认接口继续（模拟关口 1，计 1 次人工介入；`countHumanInterventions` 计数既有 `approval_*` 事件）。

**验收**：覆盖检查单测（漏 FR、虚构 FR 两反例必红）；两级规划图/阶段跳过单测；关口 1 流程 e2e（analyze → 切片 → 待确认 → 批准 → 第二级 → 工作流）；`single` 开关回归（S1 冒烟 ×1 过一次）；E1 的切片计划 3/3 次过覆盖检查（样本计入 B-4）。

## T6 —— 工作流级预算上限（B-3）

**交付物**：

1. **契约**：`WorkflowPolicySchema`（`shared:612`，**strict**）增可选 `maxCostUsd` / `maxTokens` / `maxWallClockMs`（正数；`undefined` = 不限制；`CreateWorkflowSchema` 默认对象不变）；控制台工作流表单增三个输入（最小接线）。
2. **检查点与数据**：`WorkflowEngine.advanceOnce`（`:277`）在 claim 循环（`:341`）前检查；花费 = 按 `agent_runs.input->>'workflowRunId'` 聚合 `tokenUsage` / `estimatedCost`（engine store 增窄读方法，如 `sumRunUsage(workflowRunId)`，Pg 实现；**不新表**）。`maxCostUsd` 仅在存在成本数据时生效（平台未回填 `estimatedCost` 时按 token/时间执行，措辞不得写「零成本」）。
3. **超限与恢复**：超限 → 工作流置 `PAUSED`（复用既有状态机边）+ 原因（`WORKFLOW_PAUSED` 事件 payload + 工作流 `error` 写明 `BUDGET_EXCEEDED` 与超限项）；恢复 = 调整预算（新增 `PATCH /api/workflows/:id/policy`，仅 RUNNING/PAUSED 可改 + 控制台入口）后走既有 `resume`（`:82`）；已完成任务不重跑（天然：claim 只取 PENDING/RETRYING）。
4. **80% 告警**：任一侧限首次越过 80% 时发**一次** `WORKFLOW_BUDGET_WARNING` 事件 + 日志（以既有事件查询去重，不刷屏）。
5. **wallClock 口径（冻结默认）**：`startedAt → now` 扣除 PAUSED 段（由 `WORKFLOW_PAUSED`/`WORKFLOW_RESUMED` 事件对推导；未闭合段计至 now）。
6. **测试**：极小预算触发暂停；80% 告警仅一次；放宽后恢复且不重复已完成任务；未设限零干预；schema/控制台/迁移同步测试；e2e 沿用既有 server e2e 模式（`docs/99`/`docs/100` 的注入式失败模式可参考）。

## B-4 —— 阶段 B 出口验证（长运行，逐批授权）

1. **全量评测（噪声线）**：S/M/L 共 8 个夹具 ×3 次、连跑两遍 → 补齐 `docs/110`；记录规划成功率（相对 P0 基线）、成本、耗时。
2. **E1 ×3 改前基线**：自报成功率 / oracle 通过率 / 假阳性 / 逐条 AC 结果（此轮为阶段 C 对比的「改前」）；harness 按 §N2-7 过关口 1。
3. 两批运行**跑前各给预估并获授权**；结果落 `packages/eval/results/`，汇总入 `docs/115`。

## 测试要求（汇总）

- 每包门禁：`corepack pnpm --filter @ai-se/<pkg> typecheck && lint && test`；全仓 `corepack pnpm -r run typecheck/lint/test`（`-r run` 会首个失败即停——有预期红项时用 `--no-bail` 或逐包循环并说明）；改动文件 `prettier --check`（docs 可 `--write`，说明为格式重排）。
- 新增 SQL 迁移 011（requirements CHECK + `requirement_slices` + `tasks.slice_key` + approvals 扩展）遵循仓库风格，并扩展 `packages/database/src/migrate.test.ts` 文件清单断言。
- 阶段 A 冻结现行断言：**既有 8 个夹具 oracle 与 S/M/L 行为零改动**（仅新增 E1 覆盖项与开关默认值）。
- 新增行为一律留事件/日志（不含明文凭据）。

## 边界红线

- 复用即红线：approvals（关口 1）、PAUSED/resume 与事件通道（T6）、`StageNode`/`generateWithRepair`（分阶段预算）——**不新增平行体系**。
- E1 隔离（见 §严格范围）；参考实现与变异版本只存在于 `packages/eval/fixtures/E1/`，绝不进入 `template/`。
- 长任务授权纪律；评测只动 `[eval]` 数据；凭据（API key/连接串）不入结果 JSON、日志与文档。
- 超时保护：S/M/L 沿用 60 s / 45 min；E1 覆盖值须在 115 说明依据。

## 完成后

1. 输出报告（中文，按 `docs/112` 同款结构）：变更文件清单 + 时间戳；N0/N1/N2/T6 逐项结果与证据锚点（命令 + 退出码/HTTP 状态 + 关键 ID + 文件路径）；B-4 两批运行结果；门禁数字；`docs/110` 补写点；未完成事项与偏差；**STOP**（不进入阶段 C）。
2. 写 `docs/115-phase-b-record.md`。
3. **STOP**：等用户指令（阶段 C 的 N3/T1… 另行任务书）。

## 验收对照表

| 来源要求                                                     | 本任务书对应        | 当前可达性                                                       |
| ------------------------------------------------------------ | ------------------- | ---------------------------------------------------------------- |
| `docs/111` §5 N0：PRD + 隐藏 oracle + 自检 + 可构建性        | §N0                 | 从零建；**可构建性验证是前置**，不通过即 BLOCKED                 |
| v2 §6 N1：180s 三问                                          | §N1                 | 三问已有答案（`docs/110` §7.1）→ 只产决策记录；先落笔、再实现 N2 |
| v2 §6 N2：切片计划 / 确定性覆盖检查 / 关口 1 / 第二级 / 开关 | §N2 1–7             | 依赖 N1；schema+DB+console+harness 同步面已列                    |
| v2 §6 T6：预算上限 / 超限暂停 / 80% 告警 / 放宽恢复不重复    | §T6                 | `WorkflowPolicySchema` 为 strict → 同步 DB/console/测试          |
| v2 §6 阶段 B 出口：全量两遍噪声线 + E1 ×3 改前基线           | §B-4                | **长运行逐批授权**；S2 样本视阶段 A 结果                         |
| `docs/111` §7.1：E1 PRD 归属                                 | §架构判定 1（默认） | 夹具内为唯一源、AI 起草；可否决                                  |

## 架构判定（默认已定，可逐条否决）

1. **E1 PRD 位置**：`packages/eval/fixtures/E1/` 夹具内为唯一源（`fixture.json.requirementText`），由 AI 起草；**不设 `docs/` 副本**（防双源漂移）。若你要摘要版，评审时提。
2. **E1 工程契约**：pnpm 工程 + 六步命令（同 `LocalCiOperations`）+ `/healthz`（另供 `/health`、`/ready`）+ Dockerfile（非 root、卷持久化、stdout 日志）+ 测试名含 AC 编号。
3. **E1 运行上限**：fixture 级覆盖（oracle ≤ 20 min、run ≤ 120 min）；S/M/L 不变；oracle 输出 = 逐条 AC 的 JSON（stdout）。
4. **自检不入门禁**：oracle 自检为脚本 + 归档证据，不并入常规单测。
5. **关口 1**：复用 approvals 的**最小扩展**——迁移放宽 `task_id`/`workflow_run_id` 为可空、新增可空 `requirement_id`、部分唯一索引保持任务审批语义不变；engine 既有任务审批路径零改动（用既有回归测试核对）；「修改」= 拒绝重做，不做在线编辑。
6. **切片推进**：顺序执行；前片 `SUCCESS` → 自动创建并启动后片（轻量编排，挂既有完成路径）。
7. **开关**：`PLANNING_MODE`（默认 `two-level`；`single` 保回归）。
8. **分阶段预算**：阶段默认值 + env 覆盖 + 总兜底；单一 180s 常量废弃（N2 落地）。
9. **T6 口径**：claim 前检查；PAUSED + 原因；`PATCH policy` + 既有 resume 恢复；80% 一次告警；wallClock = 运行累计（扣 PAUSED）。
10. **评测集成**：harness 自动过关口 1（计 1 次人工介入）；`Tier` 增 `"E1"`。

## 已知限制与注意事项

1. **E1 首轮迭代可能抓出夹具/参考解缺陷**（P0 已有先例）：正常现象，如实记录并修夹具，**不放松断言**。
2. **规划耗时波动仍在**：分阶段预算降低撞线概率，但同一需求波动不消除；M/L 仍可能失败，如实记录。
3. **关口 1 的「修改」**在 v1 为拒绝重做；切片在线编辑属后续增强。
4. **`maxCostUsd`** 依赖平台成本回填数据可得性；当前以 token/时间为主口径。
5. **B-4 运行量级**：全量两遍与 E1 ×3 为本阶段最大成本项，务必按授权纪律与 T6 就位后再跑。
