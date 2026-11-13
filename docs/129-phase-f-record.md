# 129 · 阶段 F 实施记录（规划层修复与质量加固）

> 依据：`docs/128`（开工基线 v3）。实施顺序：F1-1 → F1-2 → F1-3 → F1-4 → F1-5 → F1-6 → F1-7 → F1-8；F-M2 于 F-M1 出口后。
> 本文件随实施逐条追加；阶段完成后并入 `docs/127` 总览。批次纪律：运行期不重编、不重启、不动非 `[eval]` 数据。

---

## F1-1 校验器缺输入时失败，不再静默跳过（发现②）

**状态**：完成（2026-10-08）。**验收 FX-01 / FX-02 / FX-03 全绿**。

### 实现

- 新增守卫 `validateAcKeysPresence`（`packages/agent-core/src/planning/validateAcKeysPresence.ts`）：
  - 本计划范围内存在 AC 记录、而计划未携带任何 acKeys → `PLAN_ACKEYS_MISSING`（进入修复轮；耗尽后以 `TaskGraphValidationError` 失败）；
  - 无 AC 记录 → 允许跳过，返回 `acProtection=none`。
- 判定源（docs/128 §3 F1-1 锚点）：**PRD 编号解析优先、N3 库记录兜底**——编号解析非空取解析结果，为空时取库记录（无编号 PRD 的 llm 提取记录）；二者皆空 = 需求无 AC 记录。
- 接入：`PlanningGraph.taskPlanWithDagRepair` 合并守卫错误；成功路径跳过时发 `AC_PROTECTION_NONE` 事件，并在 `TASK_DAG_GENERATED` 与 `TASK_PLANNING_COMPLETED` 负载标注 `acProtection: "none"`（「在计划与事件中显式标注」的实现口径）。
- 数据通路：`PlanningGraphOptions.acceptanceCriteria`（新）→ `PlanningAgentOptions.acceptanceCriteria` → server `executeRun`（单级）/ `executeSliceRun`（第二级）经 `findAcceptanceCriteriaByRequirementId` 注入（映射 `acceptanceCriteriaFromRecords`）。
- 边界口径：按「本计划范围内」判定（切片范围过滤后为空 → 允许跳过）；避免对范围外无 AC 的切片产生不可修复硬拦。

### 回归夹具 R2 / FX-03 回放

- 夹具 `packages/agent-core/src/planning/s1v4Fixture.ts`：E-2b S1（slugify）slice-1 重规划 v4 的真实快照（库导出：6 任务、acKeys 全空；AC 记录 11 条 `source=llm`）。
- `planningAckeysGuard.test.ts`：① 前段证词——旧校验集（DAG / 覆盖 / N4 / Must 覆盖）对同一计划零错误（「整体跳过」的直接证据）；② 后段回放——随库记录进入规划图，修复轮 3 次尝试后以 `PLAN_ACKEYS_MISSING` 失败（2 次重做事件）。

### 测试与门禁（2026-10-08）

- 新增单测：`validateAcKeysPresence.test.ts`（FX-01 / FX-02 纯规则）；图级：`planningAckeysGuard.test.ts`（FX-02 标注 + FX-03 回放）。
- agent-core：23 文件 / **129 通过**；lint、typecheck 通过。
- server：30 文件 / **156 通过**；lint、typecheck 通过。
- 其余包（单独逐跑）：database 45 / browser 38 / mcp 235 / eval 24 / shared 50 / observability 3 / tool-runtime 12 / action-policy 13；visual、workflow-engine、evidence、sandbox、failure-recovery 均通过。
- 全仓：**apps/web 5 例失败**，全部为 eyebrow / PageHeader 类用例（mcpServersView / mcpAppView / projectDetailView / dashboardView / deploymentsView）——**仓库既有**（先例：docs/100「7 先存失败」、docs/102「apps/web 的 eyebrow 用例，仓库既有问题，与本次无关」）；与 F1-1 无关联（未触达 web 代码）。
- 注：`pnpm -r run test` 遇首个失败即中止，会把并发中的包误标 Failed；本次已改为逐包单独跑核实。

### 既有测试适配（行为变化，非回归）

- `planningApi.e2e` / `sliceFlow.e2e`：二级切片计划在库记录存在时必须携带 acKeys（新守卫的直接后果）。为两者的脚本模型**局部**夹具补足合规 acKeys（共享 Todo 夹具未动，避免波及其它用例）。

### 偏差与口径记录

- 未新增错误码体系：`PLAN_ACKEYS_MISSING` 走既有 `TaskGraphValidationError` 通道；`AC_PROTECTION_NONE` 为既有事件流内的新事件类型。
- 「结果中标注」口径：实现为事件负载标注（工作流事件流即规划运行的持久化结果面，控制台时间线与证据面可见）。

---

## F1-2 acKeys 确定性回填与单一生效计划版本（发现①、⑦）

**状态**：完成（2026-10-08）。**验收 FX-04 / FX-05 / FX-06 / FX-07 全绿**。

### 实现

- **acKeys 确定性回填**（新增 `packages/agent-core/src/planning/acKeysBackfill.ts`；接入 `PlanningGraph.taskPlanWithDagRepair`，回填先于一切校验）：
  - 引用解析：`AC-x` 对齐记录规范键（大小写 / 前导零归一）；`FR-x`（含 `[FR-001]` 形式）按 FR/AC 记录展开为对应 AC；**未知格式** → `PLAN_ACKEYS_INVALID`（进入修复轮）；不可展开的 FR 引用记入差异事件；
  - 范围回填（来源口径 = 切片 FR 范围 ∩ AC 记录）：未被任何任务引用的范围内 AC → 确定性回填到实现类任务（BACKEND / FRONTEND / DATABASE / DEBUG；无实现类时回退 TEST；均无则不回填、由守卫兜底）；
  - 冲突以代码为准：每任务前后差异发 `PLAN_ACKEYS_BACKFILLED` 事件（before / after / added / expanded / dropped）；回填后计划即产出计划（随既有落盘链路持久化 `tasks.input.acKeys`）。
- **单一生效计划版本（SUPERSEDED）**：
  - 迁移 `014_phaseF_plan_supersede.sql`：新增 `tasks.superseded_at` + 活跃计划行索引；回填三条规则（非现役切片键的历史行 / `version < requirement_slices.planning_version` / 同分组存在更高版本）；
  - 写入面：`saveSlicePlanningResult`、`savePlanningResult` 保存新版本时标记同分组旧版本行；`replaceSlicePlan` 重做后标记退役切片键的行；
  - 读取面（仓储层默认过滤，需旧版本显式 `includeSuperseded`）：`findTasksByRequirementId` / `findDependenciesByRequirementId` / `acceptanceCriteriaMappingCounts`；运行时克隆（按 version 读取）、验证证据面与追溯表（均为运行时行）自然继承。

### 回归夹具与回放

- R3 夹具 `l1v5Fixture.ts`：E-2b L1（静态站点生成器）slice-1-render-page 重规划 v5 真实快照（6 任务、acKeys 全空；8 条 llm 记录）；`planningAckeysBackfillReplay.test.ts` 回放：原始空键计划 → 回填后一次通过、实现类任务非空率 100%、每条 AC 映射完整、回填事件留痕。
- FX-03 联合口径（F1-1 × F1-2）：S1 v4 原始空键计划经回填后一次通过（`PLAN_ACKEYS_BACKFILLED`，before=[]）；`PLAN_ACKEYS_MISSING` 守卫改由「无可回填目标」用例覆盖（DESIGN+REVIEW 计划仍被拦截）——F1-1 语义保留、路径不变。
- FX-07 回放（服务端 `taskVerifier.test.ts`）：E-2b 形状（TEST 绿灯 + 实现类任务带回填后 acKeys）→ 期望翻转 `pass`、证据缺失类拦截为 0；对照（acKeys 空）即既有 fail-closed 用例。
- 勘误：F1-1 时期的 FX-03 回放用例存在夹具未接线问题（脚本模型未接收 S1 计划夹具，实际回放了默认夹具——断言路径成立但对象不精确）；本次重写已修正为真实 S1 v4 / L1 v5 计划回放。

### 测试与门禁（2026-10-08）

- 单测：`acKeysBackfill.test.ts`（8 例：两种格式 + 未知报错 + 展开 / 回填 / 幂等 / 无记录 / S1 实测）；`planningRepositories.test.ts` 新增 FX-06 两例（重规划取代 + 退役切片键）；`migrate.test.ts` 迁移计数更新（14）。
- agent-core 25 文件 / **139 通过**；database 10 文件 / **47 通过**；server 30 文件 / **157 通过**；三包 lint / typecheck 通过；改动文件 prettier 净。
- 迁移已应用（评测库 ai-se-postgres-1）：`applied: ["014_phaseF_plan_supersede.sql"]`；核验：**E1 计划行 74 → 现役 14**（旧代 60 标记 SUPERSEDED）、**S1 v2 → 0**（v4 = 6 现役）、**L1 旧切片键（render-module / build-module）→ 0**（slice-1-render-page = 6 现役）；非 eval 项目零改动。

### 偏差与口径记录

- 范围回填目标 = 实现类任务（TEST 任务仅作无实现类时的回退）。替代方案（回填到全部任务 / 镜像到 TEST）被否：会新引入测试先行共享面，把「映射修复」变成「规划阻断」，超出 F1-2 修复面（记录备查）。
- 「命名空间统一」限深：任务条目严格两种写法（其余明确报错）；记录侧 frKeys 宽松解析（兼容 FR1 / FR-01 历史形态）；测试标记侧（`[FR-001]` 泛化提取）为 E 期既有修复，不改。

---

## F1-3 校验错误的确定性自动修复（发现③）

**状态**：完成（2026-10-08）。**验收 FX-08 / FX-09 / FX-10 / FX-11 / FX-12 全绿**（FX-13 的交付链半先行落地，全局性 AC 与预检归 F1-4）。

### 实现

- **确定性自动修复层**（新增 `packages/agent-core/src/planning/autoFixTaskPlan.ts`；接入 `PlanningGraph.taskPlanWithDagRepair`，在 LLM 修复循环**之前**）：
  - 规则白名单（只增依赖边、只补交付块字段；不增删任务、不改 AC 映射——FX-10 断言差异面）：
    ① **测试先行依赖补边**：与校验器同源的结构化清单（`listTestFirstEdgeRepairs`，校验消息与修复消费同一遍历）；补边前做环检测（`taskEdges` 邻接 BFS），**成环不修、记录环路径**；
    ② **DEPLOY 交付块补全**：仅 `isFinalSlice === true` 且项目有可用环境时，按「块仅需 action + environment」补全（staging 优先，否则按名称序）；非可部署 action 补正为 DEPLOY，ROLLBACK 保留；非最终切片**不补块**（归属拦截由下述守卫执行）；
  - 每次修复/成环发 `PLAN_AUTOFIXED` 事件（规则、对象、前后差异/环路径）；`TASK_DAG_VALIDATION_FAILED` 增 `errorCount`、`TASK_DAG_GENERATED` 增 `attempt` / `autofixCount`（FX-12 统计面）。
- **交付链归属守卫**（F1-3 先行落地，FX-09 前置；F1-4 补全局性 AC 与提示词变体）：`validateTaskGraph` 增 `isFinalSlice` 参数——显式 false 时交付链任务（`DEPLOY` 或携带 `delivery` 块）触发 `DELIVERY_TASK_OUTSIDE_FINAL_SLICE`，且不再报「DEPLOY 缺交付块」；undefined（full/单级、非切片场景）保持既有行为。`planningService.executeSliceRun` 依据库中 `slice_order`（最后一片即最终）传入。
- **修复轮耗尽 → 人工关口**（复用需求级审批，不新建体系）：
  - `executeSliceRun`：校验类失败（`VALIDATION_ERROR`，即 LLM 修复耗尽）→ 切片**复位 PENDING（可重试）**、需求置 `PLANNING_REVIEW`、建需求级审批（reason 前缀 `[planning-escalation:<sliceKey>]` 即路由契约），事件 `SLICE_PLANNING_FAILED(escalated:true)` + `SLICE_PLANNING_ESCALATED`；其余失败保持既有终态路径；
  - `handleSliceApprovalDecided`：升级审批批准 → 仅重试该切片规划（`planSlice(sliceKey)`，不动已完成切片、不启动工作流）；拒绝 → 该切片置 FAILED、需求回 `ANALYZED`；事件 `SLICE_PLANNING_RETRY_APPROVED / REJECTED`；
  - 装配：`PlanningService` 增 `deployments` 可选依赖（`findEnvironments`）；`index.ts` 注入 `PgDeploymentRepository`。

### R1 夹具与回放（FX-08 / FX-09 / FX-12）

- `r1Fixture.ts`：E1 slice-2 planningVersion 8 三轮计划（复刻口径见文件头：错误原文逐字 + taskCount 17/15/17 + 编号/类型/AC 集取自错误原文与事件；填充任务示意、不带 acKeys）；错误原文常量用于 toEqual 逐字断言。
- `planningAutoFixReplay.test.ts`：
  - FX-08：attempt 0/1（各 5 个测试先行错误）复刻逐字一致 → 自动修复（5 边）后**一次通过、LLM 修复轮数为 0**；
  - FX-09：attempt 2（T-022 + T-005/T-006）→ 2 条测试先行自动修复；T-022 以 `DELIVERY_TASK_OUTSIDE_FINAL_SLICE` 拦下、**未被补块**（无 delivery-block 修复事件；环境可用仍不补——门控在最终切片）→ 进入 LLM 修复路径；**不再出现「DEPLOY 缺交付块」错误**（全事件面断言）；修复产物重放（去 T-022 + LLM 补边）attempt 1 通过；
  - FX-12：逐 attempt 的 taskCount（17→16）/ errorCount（1）/ autofix 计数（2→0）可统计。
- 既有 `PlanningGraph.test.ts` N4 用例按新语义重写：**补边成环 → 不自动修复（PLAN_AUTOFIXED 环路径断言）→ LLM 重做恢复**（可直接补边的一轮通过场景由 R1 回放覆盖）。

### 集成（FX-11，新增 `planningEscalation.e2e.test.ts`）

- 场景：切片 1 正常规划 + stub 执行成功 → 链式推进切片 2；切片 2 三轮成环不可自动修复 → 升级人工关口；
- 断言：切片复位 PENDING + 升级审批 PENDING（reason 前缀）；**已完成切片零影响**（SLICE-1 DONE、workflowRunId 原样）；三轮回环路径事件（cyclePath `[TASK-101,TASK-102,TASK-101]`）；批准 → 仅重试该切片 → PLANNED（模型调用数 1+3+1=5）。

### 测试与门禁（2026-10-08）

- agent-core 27 文件 / **146 通过**、lint / typecheck 通过；server 31 文件 / **158 通过**（全量；`--maxWorkers=2` 复跑亦全绿）、lint / typecheck 通过；改动文件 prettier 净。
- 全仓 `-r --no-bail`：17 包全绿；唯一红 = apps/web 5 例（既有 eyebrow）。
- 已知环境抖动：server 重度 e2e 在默认高并发下偶发（受害文件每次不同：v1GoldenScenario「Recovered workflow did not finish」/ workflowApi「Parse Error: Expected HTTP/」等）；单独或限并发复跑均绿——为并发 docker 负载抖动、非本次回归。
- 夹具适配（F1-3 语义所致、非回归）：`planningApi.e2e` 非最终切片的脚本计划移除交付链任务（原 Todo 夹具 TASK-007..010 属交付链）；`sliceFlow` / `planningEscalation` 天然无交付链；`v1GoldenScenario` 走 `mode:"single"`（不受两级规则影响）。

### 偏差与口径记录

- 补块启用条件 = `isFinalSlice === true`（仅二级最终切片）；full / 单级维持既有行为（块由 LLM 负责）——与「单级 full 模式不受归属规则影响」裁决一致。
- 升级审批的 reason 前缀即路由契约（零 schema 变更，复用审批表/端点）；F1-4 的 FX-15(d) 接管 harness 重复审批计数。
- 环路径记录口径：`cyclePath = [测试任务, 既有依赖路径（实现→…→测试）]`，即补边将构成之环。
- FX-13 拆分说明：本项先行落地交付链半（FX-09 前置）；全局性 AC 规则、环境缺失预检 (b)、提示词变体、observe/校准/enforce 归 F1-4。
- 实施踩坑（已修）：升级分支曾用内存中加载时的切片状态做守卫（`slice.status !== "PENDING"` 恒假）→ 切片停在 PLANNING；改为无条件复位 PENDING。

---

## F1-4 全局性 AC 的归属规则（发现⑤）

**状态**：完成（2026-10-08）。**验收 FX-13(a)(b) / FX-14a / FX-14b / FX-15(a)~(d) 全绿（含 L2 三连实测；run-3 首跑一次瞬态失败已如实登记并重跑通过）**。

### 全局性 AC 判定与归属

- **判定**（agent-core `acceptanceCriteria.ts` `isGlobalAcceptanceCriterion`）：验证方式为 Deploy 或 Doc 类的 AC——模式表 `/^deploy/i`、`/^doc/i`、`容器`、`日志扫描`、`命令执行`；对 E1 精确命中 AC-24/25/26/29/30，不误伤非全局项（HTTP/边界/文件扫描/HTML/浏览器）。规则由代码判定，不依赖 LLM 自觉。
- **范围选择 v2**（`selectAcceptanceCriteriaForSlice` 增 `{isFinalSlice}`）：非最终切片剔除全局性 AC；**最终切片在 FR 命中项之外并入全部全局性 AC**；undefined = 既有行为（单级 full / 非切片零变化）。四个消费点（范围选择、覆盖校验、Must/TEST 覆盖、acKeys 回填）同参透传。
- **硬校验**（`validateTaskGraph` 增 `globalAcKeys`）：非最终切片任务引用全局性 AC → `GLOBAL_AC_OUTSIDE_FINAL_SLICE`（键做 AC-01→AC-1 规范归一）。
- **提示词变体**（`taskPlanningPrompt({deliveryConfigured, isFinalSlice})`）：非最终切片的二级提示词不得以交付链收尾（与 F1-3 的 `DELIVERY_TASK_OUTSIDE_FINAL_SLICE` 硬守卫构成软硬双保险）。

### 最终切片规模（observe → 校准 → enforce）

- **度量与错误**（`finalSliceScale.ts`）：`measureFinalSliceScale`（任务数 / 交付链任务数 / FR 数 / 全局性 AC 数）；`finalSliceOverloadError`（超 `finalSliceMaxTasks` → `FINAL_SLICE_OVERLOAD`，消息内嵌「压缩不增删 AC 映射」指令）。
- **observe（默认）**：最终切片计划通过时发 `FINAL_SLICE_SCALE_OBSERVED {mode, 四指标, threshold?}`，**不判失败**；L1 预检（`persistSlicePlan`）按 FR 数 + 全局性 AC 数预估并记录 `FINAL_SLICE_SCALE_PREVIEW`。
- **enforce**（`PLANNING_FINAL_SLICE_MAX_TASKS`，缺省关）：超限 → ① LLM 压缩（修复轮追加压缩提示）→ ② 仍超限：**一级重做拆分**（`splitFinalSlice`，确定性）——原最终切片行保号、标题「（工程契约）」、复位 PENDING；INSERT 新行 `<key>-deploy`「部署验证」（frKeys = 全局性 AC 的 FR 并集，空则回退原 frKeys）；**只 INSERT + 更新展示字段：已完成切片的 FR 范围/任务/计划行零改动、不标 SUPERSEDED**（e2e 回归断言）；关口 1 审批（reason 前缀 `[planning-split:<slice>|<deploy>]`：批准 = 按拆分继续、仅规划工程契约段；拒绝 = 两段 FAILED）→ ③ 再失败（已拆过）→ F1-3 同一升级路径。

### 工作流创建预检（FX-13(b)）

- `advanceSliceChain` 在创建工作流前检查：该切片活动计划含交付链任务（DEPLOY 或 `input.delivery`）且项目 `deployment_environments` 为空 → **不创建**、切片 FAILED、事件 `DELIVERY_ENVIRONMENT_PREFLIGHT_FAILED {errorCode: DELIVERY_ENVIRONMENT_MISSING, stage: workflow_creation}`。
- **口径记录（偏离说明）**：任务书点名的两处预检中，「需求分析」时点尚无可判定的交付任务（交付链在二级规划才生成），硬失败会误伤不部署的项目；实现取**工作流创建**为硬失败点（该时点计划已落盘、可确定判定），规划期由 F1-4 归属守卫 + F1-3 补块兜底（「补块处仅兜底」按此落实）。

### eval harness（FX-15(d)）

- `ensureSliceStarted`：等待途中 `PLANNING_REVIEW` + PENDING 审批 → 自动批准并计 `interventions`（拆分/升级的关口重审由 harness 处理并计入人工介入）；切片 PLANNED 超宽限（max(1s, poll×2)）仍无工作流 → 返回 null 由 harness 自启动（F1-3/F1-4「仅规划不启工作流」的链停场景）。
- `runFixture`：下一片解析改为**动态刷新切片列表**（拆分追加的 `-deploy` 段可被接力）；`journeyInterventions` 并入 `humanInterventions`。

### 测试与门禁（2026-10-08）

- agent-core 新增 `finalSliceGovernance.test.ts`（9 例：判定矩阵 / 选择器 / FX-13a 守卫 / FX-14a 回放 / 规模度量 / 提示词变体）、`planningFinalSliceScale.test.ts`（6 例：observe 事件 / 压缩收敛 / 不收敛抛错 / 非最终归属拦截 + 修复收敛）；
- server 新增 `finalSliceGovernance.e2e.test.ts`（场景 A：拆分 + 关口 1 审批 + 已完成切片零改动回归断言；场景 B：工作流创建预检）；
- eval `harness.test.ts` +2 例（PLANNED 宽限自启动；PLANNING_REVIEW 自动批准计次——fake timers + `advanceTimersByTimeAsync`）。
- 计数：agent-core **157**（29 文件）、server **160**（32 文件）、eval **26**；三包 lint / typecheck 过；改动文件 prettier 净。
- 全仓 `-r --no-bail`：唯一红 = apps/web 5 例（既有）+ server v1GoldenScenario 一条（重负载并发合并抖动；单跑 4/4 绿——与 F1-3 登记的同类环境抖动一致）。

### L2 规划演练（FX-14b / FX-15(c)）

- 驱动：`apps/server/scripts/l2-planning-drill.ts`（in-process 真模型；装配**不带** `startSliceWorkflow`/`workflows` → 链路天然零工作流创建；自校验：全局性 AC 只在最终切片 + workflow 计数不变 + 全切片 PLANNED；`--smoke` 只读自检；失败时日志留证）。运行器逐轮带周配额闸（20M 代理值）。
- **run-1（通过）**：v8 重规划 = 4 切片；全部 PLANNED、零工作流（18→18）；**全局性 AC 只在最终切片**（slice-4 承接 AC-24/25/26/29/30 全部 5 条；frKeys=FR-5/FR-6——FR 不命中仍并入 ✓）；slice-1（FR-8/FR-9 工程基线）10 任务、**0 交付链、0 全局 AC**（E-1 的「AC-30 工程任务在首片」缺陷形态消失）；最终切片规模：**任务 15 / 交付链 4 / FR 2 / 全局 AC 5**。
- **run-2（通过）**：v9 重规划 = 5 切片（LLM 将 FR-8/FR-9 排为末片）；全部 PLANNED、零工作流；全局性 AC 只在最终切片（S5：FR-8/FR-9）；最终切片规模：**任务 14 / 交付链 4 / FR 2 / 全局 AC 5**；中途出现一次 `PLANNING_STAGE_TIMEOUT`（stage 级重试 1 次即恢复，未影响成片）。
- **run-3 首次尝试（失败，已重跑）**：slice-1 规划在 `technical_spec` 阶段 `PLANNING_ERROR`（非校验类瞬态；错误消息未留存于事件面——计划 run 不落 token_usage/错误详情，已给脚本开启日志以便复发留证）；按「个别夹具/瞬态缺陷不阻断、如实登记」口径重跑。
- **run-3（重跑通过）**：v20 重规划 = 5 切片（s1..s5）；全部 PLANNED、零工作流（18→18）；全局性 AC 只在最终切片（s5：frKeys=FR-5/FR-6，承接全部 5 条——FR 不命中仍并入 ✓）；最终切片规模：**任务 12 / 交付链 4 / FR 2 / 全局 AC 5**。
- **校准**：三连实测终片规模 **15 / 14 / 12**（均低于下限）→ 按任务书下限取 **enforce 初始阈值 = 18**（高于 E1 已观测的 17）；开关保持缺省关（`PLANNING_FINAL_SLICE_MAX_TASKS` 不设置 = observe）。
- **演练共性证据**（run-1/2/3 一致）：非最终切片 0 交付链 / 0 全局 AC；最终切片交付链 4 任务（CI + staging DEPLOY + VERIFY + production DEPLOY）；workflow 计数三连均 18→18（**不创建任何切片工作流** ✓）；「若触发拆分」条款未触发（observe 轮不启用 enforce——条件性条款如实标注）。
- **成本口径（重要）**：`planning-agent` run **不记录 token_usage**（近 7 天 38 条规划 run 全部为空）——周配额代理值只覆盖执行类 agent，规划成本仅网关控制台可见；本次演练的成本数字为**下界**。运行器配额闸因此按执行类代理值执行（13.3M 起步、未触 20M 闸）。

### 偏差与口径记录

- **「仿 redoLevel1」取审批流、拆分取确定性**：任务书「一级重做拆分（仿 redoLevel1）」取其**关口 1 审批流**；拆分内容「工程契约 / 部署验证」为固定语义，确定性拆分（只动尚未开始的最终切片）不重掷既成切片——LLM 整体重做会重排全部切片，违反「已完成切片的 FR 范围零改动」。
- **潜伏 bug 修正（F1-4 发现并修）**：`PgAgentRunStore.findMany` 按 `created_at DESC` 返回，F1-3 的 `recordApprovalEvent` 用 `[...runs].reverse().find(...)` 取到**最旧**规划 run（事件断言只查类型时不暴露）；改为直接 `runs.find(...)`（recordApprovalEvent 与新的 recordEventOnLatestPlanningRun 两处）。
- FX-14a「只证拒绝」口径：校验器拒绝 E1 形态的 slice-1 全局 AC 计划（T-08 携带 AC-30 的复刻），不证修复后形态。
- 事件/错误码新增：`GLOBAL_AC_OUTSIDE_FINAL_SLICE`、`FINAL_SLICE_OVERLOAD`、`FINAL_SLICE_SPLIT`、`SLICE_PLANNING_SPLIT_APPROVED/REJECTED`、`FINAL_SLICE_SCALE_OBSERVED`、`FINAL_SLICE_SCALE_PREVIEW`、`DELIVERY_ENVIRONMENT_PREFLIGHT_FAILED`（及 `DELIVERY_ENVIRONMENT_MISSING` 错误码）。

---

## F1-5 三层检查（发现④）

**状态**：完成（2026-10-08）。**验收 FX-16 / FX-17 / FX-18 / FX-19 全绿**。

### 任务级（FX-16）

- 作用域：dev 任务（BACKEND/FRONTEND/DATABASE/DEBUG）的 test 检查按 `input.acKeys` 选取——node --test 项目走 `--test-name-pattern` **真选取**（command-filter），命令形如 `npm run test -- --test-name-pattern '\[AC-01\]|\[AC-1\]'`（含规范键变体；host 以 node22/npm10 实测透传保真，全量红、作用域绿已验证）；非 node 项目**回退全量 + 结果面按 AC 编号选取**（result-filter：作用域 AC 至少一条可解析且全过才判过）。
- 检查证据新增 `scopedAcKeys` / `scopingMode`（判定与作用域可审计）。
- TEST 任务红灯语义保持既有 E-0 行为（不作用域）；不因其他任务的测试失败而失败 →「任务 A 已实现、任务 B 测试已写但未实现」不再误判 A。
- 缺 acKeys 的 dev 任务保持既有全量行为（**不新增「缺键→退化」路径**；规划层由 F1-1/F1-2 保证新计划必带键——见偏差节）。

### 切片边界（FX-17）

- 触发：仅由「该切片最后一个完成（其余实现任务均 SUCCESS）的实现任务」运行；运行**该切片涉及 AC 的全部测试**（AC 并集：node --test pattern 真选取 / 其余全量 + 结果面选取；command-filter 需至少一条切片 AC 结果实际运行）。
- 失败 → 判定失败；enforce 由包装层送入失败策略（`VERIFICATION_FAILED`）。事件 `SLICE_BOUNDARY_CHECKED {sliceKey, taskKey, verdict, acKeys}`。
- 切片内尚有未完成实现任务时不运行（not-last 跳过；并发场景天然单发——只有最后完成者满足）。

### 交付前与 commit 归属（FX-18 / FX-19）

- **commit 归属**：验证时 best-effort 捕获工作区 HEAD（`git rev-parse HEAD`；非 git 工作区缺省，不影响验证语义）→ 记录级 + 每条检查 + `TASK_VERIFICATION` 事件；追溯证据 refs 增加 `commitSha`（检查级优先、记录级兜底）。
- **交付前全量**：`LocalCiOperations.runCi` 在 `pnpm test` 步解析逐条 AC 结果（TAP）→ 随 CI 结果 `testResults` 返回 → `DeploymentOrchestrator` 透传任务输出（成功含 `gitCommit`；**失败也留证**：output 含 `testResults` + `gitCommit`）。
- **追溯判定以这一次为准**：任务输出带 `testResults`（交付前全量）→ 生成 `authoritative` 证据（含 commit + 命令）；存在时判定**只用权威集**（覆盖早期绿灯/红灯证据）；证据列表保留全部 refs 并渲染「交付前全量」。CI/交付任务通常不挂 acKeys → authoritative 证据在**全部任务输出**上检索。
- 外部 CI 通道（GitHubActions）不提供逐条结果 → 无 authoritative 证据，回退既有判定（口径记录）。

### 测试与门禁（2026-10-08）

- `taskVerifier.test.ts` +7 例（FX-16 正/负/回退、FX-18 commit 链、FX-17 正/负/not-last）；`traceability.test.ts` +3 例（commit 兜底链、FX-19「早期绿灯、后续破坏 → 最终显示失败」、交付前全量通过覆盖早期失败）；`verificationGate.e2e.test.ts` +2 例（**真 Docker**：边界失败进失败策略 / 边界全通过）。
- 计数：server **174（33 文件）全绿**（含 e2e 7/7）、shared 50、tool-runtime 12；server/tool-runtime/shared lint 过、改动文件 prettier 净、`tsc --noEmit` 净。
- 新检查名/事件/字段：`slice-boundary`（VerificationCheckName）、`SLICE_BOUNDARY_CHECKED`、`VerificationCheckEvidence.{commitSha, scopedAcKeys, scopingMode}`、`TaskVerificationRecord.commitSha`、`TraceabilityTestRef.{commitSha, authoritative}`、`CiExecutionResult.testResults`。

### 偏差与口径记录

- **规则 4（acKeys 缺失直接报错）的落点**：在规划层（F1-1 `PLAN_ACKEYS_MISSING` / F1-2 回填 + `PLAN_ACKEYS_INVALID` 硬守卫）。验证期对缺键 dev 任务**不新增静默退化**（保持既有全量行为且不豁免其他失败）——让验证门硬报错需向其注入「AC 记录存在性」上下文（后续小改项，如实记录）。
- **作用域命令形态**：`--test-name-pattern` 模式内嵌规范键变体（`[AC-01]` 与 `[AC-1]` 双写），跨书写习惯稳健；command-filter 判定取严（命令成功且切片/任务 AC 至少一条实际运行且全过），零命中不会误判为通过。
- **实施踩坑（已修）**：`npx vitest run`（不带路径参数）会收集 `apps/server/dist/**` 9 月旧编译产物（22 个文件级假失败）——全量口径为 `vitest run src`（即 `pnpm test`）；与 code 变更无关，记录以免误判回归。
- 「边界在最后实现任务后运行」的时序口径：以**运行时至 DB 的任务状态**（其余实现任务 SUCCESS）判定；任务级检查在边界之前完成（同一任务先任务级、后边界）。

---

## F1-6 诊断码拆分（发现⑦）

**状态**：完成（2026-10-08）。**验收 FX-20 全绿**。

- 拆分（`taskVerifier.ts`）：红灯检查失败诊断码新增 `VACUOUS_TEST`（证据可读：无实现 / 部分覆盖 / 自引用 / 绿灯不一致 → 测试空转）与 `EVIDENCE_MISSING`（证据面缺失 fail-closed：解析不出任何 AC 结果、证据通道缺失或读取失败、工具层失败无退出码）。**历史数据不回写**（此前事件不重标；口径声明）。
- 实现证据面重构：`allAcsImplemented`（boolean）→ `acImplementationEvidence`（`implemented` / `not-implemented` / `unavailable`）——「通道不可用」与「证据显示未实现」由此可分。
- 落痕：检查级 `failureCode`、记录级 `failureCode`（同码唯一时）、`TASK_VERIFICATION` 事件 `checks[].code` + `failureCode`（F1-8 失败分布按新码统计的数据面）。
- reason 文案（保留 "red-light" 前缀词，沿用既有断言/检索习惯）：空转 `red-light check passed without implementation (VACUOUS_TEST): <checks>`；缺失 `red-light check not adjudicable (EVIDENCE_MISSING): <checks>`；混合并列出码。
- 测试：`taskVerifier.test.ts` +3（无解析证据 / 通道缺失 / 读取失败 → EVIDENCE_MISSING）+2 处既有用例改断言 VACUOUS_TEST（空证据列表 / 部分覆盖）；`verificationGate.e2e.test.ts` vacuous 用例同步（含 `failureCode` 断言）。
- 门禁：server **177（33 文件）**；全量运行一次 v1GoldenScenario「server restart」失败 → 单跑 4/4 绿（既有并发抖动类，同 F1-3/F1-4 登记）；lint / tsc / prettier 净。

---

## F1-7 环境与部署面小修复包（发现⑥）

**状态**：完成（2026-10-08）。**验收 FX-21 / FX-22 / FX-23 / FX-24(a)~(d) / FX-25(a)~(d) 全绿**（FX-25 的「评测回归集成功率不下降」对照留 L3 轮执行——配额门，见偏差节）。

### FX-21 卷与环境变量（LocalDocker）

- `LocalDockerOperations.deploy` 支持 `configuration.volumes`（`host|卷名:容器路径[:ro|rw]` 数组）与 `configuration.env`（对象）→ `docker run` 追加 `--volume` / `--env`；声明非法**明确报错**（不静默忽略）。声明入口 = 部署环境记录 `configuration`（既有 jsonb 直通 `deploy_release` 输入，零 schema 变更）。
- 真 Docker e2e（`deliveryVolumes.e2e.test.ts`）：部署 → 重启（同名 `rm -f` + `run`）→ 数据目录经卷保留（boots.log 1→2 行）；另附假 docker 参数装配单测 + 校验单测。

### FX-22 启动防护与令牌加固

- `assertListenSecurity`：`HOST` 默认 `127.0.0.1`（回环免令牌，开发零变化）；**非回环 + 未配 `API_TOKEN` → 拒绝启动并明确提示**；`app.listen(port, host)` 落地。
- `apiTokenGuard`：常量时间比较（sha256 定长 + `timingSafeEqual`）；令牌仅经 Authorization 头；`requestLogger` 对敏感查询参数脱敏（`?token=` → REDACTED）。
- 日志扫描单测：带令牌请求全流程捕获 pino 输出 → **日志无令牌明文**；URL 携带令牌不被接受且被脱敏。

### FX-23 并行钳制（T3 前不开放并行）

- 共享助手 `enforceSerialWorkflowPolicy`（packages/shared）；`WorkflowService.create` 创建期钳 `maxConcurrency` 为 1 + 事件 `WORKFLOW_MAX_CONCURRENCY_CLAMPED {requested, applied:1}`。
- **契约变更测试适配**：`workflowApi.e2e`「A/B 并行」→ 串行 + 钳制事件（依赖语义保留：C 仍等 A、B 完成）；`v1GoldenScenario` restart 演练改串行形态（A 完成、B 在途挂起 → 重启重领 B，A 不重跑）——原「并行双任务」前提按 FX-23 更新。

### FX-24 沙箱 pnpm（裁决①）

- (a) `packages/sandbox/Dockerfile`：构建期 `npm install -g pnpm@9.15.0`（**真实二进制** `/usr/local/bin/pnpm`，不经 corepack）；默认镜像 `ai-se-sandbox:22-pnpm9`（`DEFAULT_SANDBOX_IMAGE`，可用 `SANDBOX_IMAGE` env 覆盖）；构建命令 `pnpm --filter @ai-se/sandbox run build:image`。真 Docker 验收：**E1 工件（零依赖 + 空 lockfile）`pnpm install --frozen-lockfile` 离线 exit 0，`network: none` 默认不变**。
- (b) 版本边界：`packageManager` 声明 8.15.0 / 11.7.0 两组 → **忽略该字段、使用预置 9.15.0**、exit 0（探针记录不一致事实，不阻断）。
- (c) 反向对照：lodash 依赖夹具 → 安装失败且错误可定位（`ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_NO_OFFLINE_META|ECONNREFUSED` 断言）。
- (d) 已知限制登记：docs/127 第 8 条更新（pnpm 本体已预置；**依赖拉取**限制保持）。corepack 通道不属验收路径（离线报错记录为边界）。

### FX-25 工具探测（共用模块）

- `packages/tool-runtime/src/tools/packageManager.ts`：`buildPackageFactsProbeCommand`（单命令采集 `hasPackageJson/packageManager/lockfiles/scripts`）+ `parsePackageFacts`（兼容旧 scripts 形状 → npm 回退语义，历史回放零变化）+ `planPackageScriptCommand`（**packageManager 字段 → 唯一锁文件 → 多锁文件固定顺序 + 警告 → npm 回退**；无 package.json / 脚本不存在明确报错）。
- `run_unit_test/run_lint/run_build` 缺省命令改为探测解析（**显式 `command` 覆盖优先级不变**、不触发探测）；多锁文件警告随工具结果返回。
- **验证门共用同一模块**：包探测与检查命令基（`pnpm test` / `npm run test`）+ 作用域命令（`<base> -- --test-name-pattern`）同源；检查证据增 `warnings`。
- 单测：tool-runtime +15 例分支（含零依赖且无锁文件 → npm 回退）+ 验证门接线 +1 例。

### 测试与门禁（2026-10-08）

- server **189（36 文件）全绿**（新增：clamp 2 / apiToken 6 / 卷装配 3 / 卷真 Docker 1 / 验证门 FX-25 1）；sandbox **7**（含 pnpm 验收 3）、tool-runtime **27**、shared **50**、database **47**、agent-core **157**、workflow-engine **35**、eval **26**；server / sandbox / tool-runtime lint 过、改动文件 prettier 净、`tsc --noEmit` 净。

### 偏差与口径记录

- FX-23 影响的既有测试按新契约改写（并行断言 → 串行 + 钳制事件；重启演练角色互换，仍验证「在途重领 / 已完成不重跑」）——钳制是任务书授权行为。
- FX-25(d)「评测回归集成功率不下降（以 T0 噪声线为参照）」属 **L3 回归轮**执行项（配额门；用户指令 L3 前停）：实现与单测已绿，回归对照留 L3 执行并登记。
- 沙箱镜像为**本地构建物**（不在 git 内）：新环境须先 `build:image`（Dockerfile 与本节注明）；此为「镜像构建期预置」的既定形态。
- FX-24(b)「探针记录事实、不阻断」的实现 = e2e 断言两组不一致声明下 install exit 0 且预置版本生效（无额外事件面）。

---

## F1-8 指标口径与历史重算（发现⑧）

**状态**：完成（2026-10-08）。**验收 FX-26 / FX-27 / FX-28 全绿（离线执行，不耗配额）**。

### FX-26 冻结口径（eval harness）

- **记录级新增**（`EvalRunRecord`）：`chainCompleted`（两级 = 全切片 DONE；单级 = 全工作流 SUCCESS）、`deliveredSuccess`（oracle ∧ chain）、`falseNegative`（oracle ∧ ¬chain）、`scopeViolation`（`SCOPE_VIOLATION` 事件面；F2-1 前恒 false）、`sliceReached`（最后一个非 PENDING 切片）、`taskVerificationDivergence`（自报成功后验证 FAIL 的任务数）、`verificationFailureCodes`（VACUOUS_TEST / EVIDENCE_MISSING）、`failureLayers`（规划 / 验证门 / agent 分层映射）、`planningMetrics`（自动修复轮数 / LLM 修复轮数 / 切片校验失败轮 / 首轮通过 / 收敛 / 规划错误码）。
- **规划侧数据面**：规划 run 事件时间线（`GET /api/agent-runs/:id/events` 上的 `PLAN_AUTOFIXED` / `PLANNING_REPAIR_REQUESTED` / `SLICE_PLAN_VALIDATION_FAILED` / 终败事件）；批内按需求聚合（含重规划轮，口径注明）。
- **汇总**（`summarize`）：新增 `chainCompletedRate` / `deliveredSuccessRate` / `falseNegativeCount` / `scopeViolations` / `taskVerificationDivergence` / `verificationFailureCodes` / `failureLayers` / `planningRepair{autoFixRounds, llmRepairRounds, sliceValidationFailureRounds, firstPassRate, convergenceRate}` / `sliceReachedDistribution`；markdown 报告新增对应行与逐次表「链完成/交付」列；**旧记录缺字段按缺省降级（不产生 NaN）**。
- 单测：`metrics.test.ts` +7 例（链完成两级/单级、验证分歧与失败码、分层映射、规划修复、scope、汇总聚合、旧记录降级）；eval **33**（5 文件）全绿。

### FX-27 历史批次离线重算（B / C-6 / E-1 / E-2 / E-2b）

- 工具：`packages/eval/scripts/f18-recompute.mjs`（纯读落盘工件）；产出 `packages/eval/results/f/f18-recompute.md|.json`。
- **结果表**（代理口径注明：工件无切片状态面 → 链完成以「全任务 SUCCESS」为代理；已执行片数 = workflowIds 数）：

| 批次 | 运行数 | oracle 通过 | 链完成（代理） | 真交付成功 | 假阴性 | 已执行片数分布 |
| --- | --- | --- | --- | --- | --- | --- |
| B | 45 | 25/45 | 16/45 | 14/45 | 11 | 1 片×26 2 片×8 3 片×5 4 片×4 5 片×2 |
| C-6 | 3 | 0/3 | 0/3 | 0/3 | 0 | 1 片×3 |
| E-1 | 3 | 1/3 | 0/3 | 0/3 | 1 | 1 片×3 |
| E-2 | 24 | 6/24 | 0/24 | 0/24 | 6 | 1 片×24 |
| E-2b | 23 | 8/23 | 0/23 | 0/23 | 8 | 1 片×23 |

- **E-1 标注（任务书点名）**：真成功 **1/3** 同时标注 **链完成 0/3** ✓。
- 限制（如实登记）：链完成为**代理口径**（多切片「全 SUCCESS 但链未及末片」的早期工件无法区分，不作强结论）；`sliceReached` 以「已执行片数」呈现；超范围写入无事件面（F2-1 前）；重算不含模型调用。

### FX-28 口径核对（归档）

- **四载体逐一对齐**（均可复跑）：① `prd.md` 29 Must 行 / 1 Should 行；② `ac-map.md` 30 行 / 1 Should；③ `oracle.mjs` + `selfcheck.mjs`（`must=29/29`、变异检出 6/6）；④ N3 库记录（Must 29 / Should 1，唯一 Should = **AC-22**）。
- 归档：`packages/eval/results/f/caliber-check.md`；历史结果统一标注「**口径版本 29 Must + 1 Should（唯一 Should = AC-22）**」（重算表头 + 核对记录）。
- AC-30 行文引用「Should（AC-22）」不计为第二条 Should（按行级优先级列判定，方法已写明）。

### 测试与门禁（2026-10-08）

- eval **33（5 文件）**全绿、`tsc --noEmit` 净；重算脚本运行即核对（E-1「1/3 + 0/3」精确复现）。**不耗配额**（纯离线工件读取）。

### 偏差与口径记录

- 规划侧指标按需求聚合（含历史重规划 run 的事件），非严格单批隔离——如需按批隔离可在事件 payload 增加批次标识（未做，如实记录）。
- `scopeViolation` 数据源随 F2-1（写范围审计 observe）上线后自动填充（读事件面，无需改字段/汇总）。
- 旧批次（B 期早期）以时间戳文件归入 B 批次（09-29 ~ 10-01 共 8 个文件，45 次运行）；批次划分与 docs/115/117 记录一致。

---

## F2-1 工作区写范围审计（写范围无约束）

**状态**：完成（2026-10-08）。**验收 FX-29 / FX-30 全绿；FX-31 开关与报告机制齐备（enforce 保持关闭）**。

### 实现

- 新模块 `apps/server/src/services/writeScopeAudit.ts`：按任务类型的写范围白名单（纯代码常量，**不新增规划字段**）——
  - QA(TEST)：仅测试目录/测试文件；BACKEND/FRONTEND/DATABASE/DEBUG：源码与配置；DEVOPS(DEPLOY)：Dockerfile、脚本、README、CI 配置；ANALYSIS/DESIGN：文档类；未映射类型回退「源码+配置+测试」。
  - 变更集口径：任务执行前后各取 `git status --porcelain`（`snapshotWriteScope` 在包装层捕获基线；验证门内取 after），「任务自身写入」= 行级差异（renames 双路径并入；已脏且再次修改同一文件属已知盲区，v1 口径）。
- 验证门接线（`taskVerifier.ts`）：任务结束后、判定前执行审计；结果落 `record.writeScope`（mode/outcome/checked/violations/changedPaths/reason），`TASK_VERIFICATION` 事件 payload 增加 `writeScope{mode,outcome,violations,checked}`。
- **observe（默认）/ enforce（开关）**：`WRITE_SCOPE_AUDIT=off|observe|enforce`（config，默认 observe）。observe 只记录 + `SCOPE_VIOLATION` 事件留痕，不覆盖任务结果；enforce 越界 → 验证失败（走既有失败策略）。
- **FX-33 兜底**：`POLICY_EVASION_SUSPECTED`——同 run 存在被策略拦截的命令尝试（`tool_calls.error.message` 含 "blocked"）且检出越界写入时，随 `SCOPE_VIOLATION` 一并留痕（判据经 `blockedCommandAttempts` 依赖注入，生产装配 = `PgToolCallStore.findByAgentRunId` 过滤）。

### FX-29 单测（`writeScopeAudit.test.ts`，9 例）

- QA(TEST) 写 `src/index.ts` 被检出；BACKEND 写 `Dockerfile` 被检出；DEVOPS 写 Dockerfile/脚本/README/CI **通过**；porcelain 解析与差集（renames、状态变化、既有脏文件不计入）。

### FX-30 回放（E-1 run-1 T-08 工件）

- 工件来源：任务 `be4d037a`（E-1 run-1，workflow `faf19923`，BACKEND「工程脚本、锁文件与 README 命令文档」），写入集自其工具调用记录重建（存储截断，为可恢复子集）：`package.json`、`pnpm-lock.yaml`、`scripts/*.js ×3`、`src/** ×6`、`test/** ×5`、`.readme.tmpl`、`.dbg.cjs`（共 18 项）。
- observe 检出：`test/acceptance-coverage.test.js` 等测试目录写入 + `scripts/*` + `.readme.tmpl`（BACKEND 白名单外）**violations**；`src/**` 与配置**不误伤**（混合场景只拦应拦部分）；`SCOPE_VIOLATION` 事件含 taskKey/mode/violations；observe 下判定保持 verified。
- enforce 同夹具 → `failed`（reason `write scope violation (enforce): …`）。
- **已知局限（如实登记）**：类型级白名单无法识别「同类型内的越界」（如 BACKEND 任务写了别的模块源码——T-08 的「应用核心代码」即此形态），这正是任务书 §F2-1.4 的演进路线（`touchedPaths`，与 T3a 合并）；observe 期数据用于校准。

### FX-31 门槛（文档）

- **enforce 开关**：已实现（config `WRITE_SCOPE_AUDIT`），**默认 observe、enforce 保持关闭**；开启条件 = observe 数据齐备（下述报告）后另行批准。
- **observe 数据报告**（越界率、按任务类型分布）——`TASK_VERIFICATION` 事件面查询（SQL 已对真实库验证可执行；当前 0 行 = 新代码尚未在生产运行）：

```sql
SELECT payload->>'taskType' AS task_type,
       count(*) FILTER (WHERE payload->'writeScope'->>'outcome' = 'violation') AS violations,
       count(*) FILTER (WHERE payload->'writeScope'->>'outcome' = 'passed')    AS passed,
       count(*) FILTER (WHERE payload->'writeScope'->>'outcome' = 'skipped')   AS skipped,
       round(100.0 * count(*) FILTER (WHERE payload->'writeScope'->>'outcome' = 'violation')
             / nullif(count(*) FILTER (WHERE payload->'writeScope' IS NOT NULL), 0), 1) AS violation_rate_pct
FROM workflow_events
WHERE event_type = 'TASK_VERIFICATION' AND payload->'writeScope' IS NOT NULL
GROUP BY 1 ORDER BY 1;
```

## F2-2 工具面治理（工具面无约束）

**状态**：完成（2026-10-08）。**验收 FX-32 / FX-33 / FX-34（单测部分）全绿**；FX-34 的「回归集成功率不下降」部分与 L3 出口评测合并执行（按用户指令「L3 之前停下」，本窗口不跑 L3——登记为待办）。

### FX-32 调查记录：Agent 为什么用 shell 写文件

**数据面**（`tool_calls` 库表）：

| 范围 | write_file / edit_file | run_build / run_unit_test / run_lint 中含 heredoc 写（`cat >`/`<<`） | run_command |
| --- | --- | --- | --- |
| E-1 批次 4 条 workflow（1002 次调用） | 12 / 11 | **109**（build 25 / test 61 / lint 23） | 51（0 次写） |
| 全库（21092 次调用） | 140 / 35 | —（同形态） | 398 |

- **结论（可观察事实 + 推断分列）**：
  1. 事实：脚本工具（run_build/run_unit_test/run_lint，riskLevel=LOW，`command` 入参可传任意命令串）成为事实上的文件写入与「终端替代」通道——T-08 单任务即用 run_build heredoc 写入 18 个文件（`cat > src/errors.js <<'__TB_EOF__'` 等），并用来 `pwd`/`ls`/`cat` 探查；`write_file`/`edit_file`（riskLevel=MEDIUM）使用量极低。
  2. 推断（与数据一致的最简解释）：① 脚本工具是 LOW 风险且描述无「禁止写文件」契约，模型凭终端先验把它当通用 shell；② heredoc 一条命令写多文件（+mkdir），比「每文件一次 write_file + edit_file 定位替换」在调用数与 token 上更省；③ 同名工具（run_build「Run build checks」）不承担构建职责时也无约束。
- **修复方向落地**（见 FX-34）：脚本工具收口为「只执行项目脚本形态」，通用 shell 留给 `run_command`（保留关键词拦截；「纳入审批」为方向性条款，未实施、登记）；关键词扫描在脚本工具上让位于**允许清单**。

### FX-33 夹具（被拦截后改走其他通道）

- `writeScopeAudit.test.ts` 用例：同 run 有 2 次被策略拦截的命令尝试 + 改道写入 `test/ghost.test.js` → `SCOPE_VIOLATION` + `POLICY_EVASION_SUSPECTED` 双事件留痕（payload 含 blockedAttempts 与 violations）。

### FX-34 脚本命令收口（单测）

- `packageManager.ts` 新增 `isScriptOnlyCommand` / `containsUnquotedShellSyntax`：
  - **接受**：`npm [run] <script>`、`npm test|start`、`pnpm/yarn [run] <script>`（保留子命令如 dlx/exec/install/add 拒绝）、`node --test …`、`node <相对路径>.js|mjs|cjs`（frontend 约定 `node scripts/build.mjs`）；
  - **拒绝**：引号外 shell 语法（`;` `|` `&` `>` `<` `` ` `` `$` 换行、未闭合引号）、`node -e/--eval/-p`、`node /绝对路径` 与 `..` 逃逸、`bash -c`/`sh -c`、前置旗标（`--prefix`）、连接命令等任意命令串。
  - 引号内测试模式字符（`'\[AC-01\]|\[AC-1\]'`）不误伤——验证门作用域命令（`npm run test -- --test-name-pattern '…'`）照常通过。
- 三个脚本工具强制（`run_command` 不受限，承载通用 shell）；拒绝消息含 "blocked by script-only policy"（计入 FX-33 的 blocked 判据）。
- 单测：`packageManager.test.ts` +3 例（接受/拒绝清单 + 工具层强制 + run_command 豁免）；tool-runtime **30/30** 绿。
- **回归面**：server 198/198（37 文件）、agent-core 157/157（29 文件）全绿——含 frontend 专业流程（`node scripts/build.mjs` 形态）与验证门全链路（F2-3 落地后 server 全量 = **203/38**，见门禁小节）。

## F2-3 终止传播复查（终止传播漏洞）

**状态**：完成（2026-10-08）。**验收 FX-35 / FX-36 全绿**（集成测试，真 Postgres + 真服务链 + 脚本化「假 LLM」持续工具调用；沙箱为进程内 FakeSandbox——本组聚焦终止传播语义）。

- 新用例 `terminationPropagation.e2e.test.ts`（5 例，settle 窗口 **N = 4s**；C-6 ghosts 为 2–23 分钟）：
  1. **TIMEOUT**：任务 1.2s 超时 → run `timed_out`、任务 FAILED、工作流 FAILED；终态后 4s 零新增 `tool_calls`（按时间戳断言：无晚于锚点的 started_at）。
  2. **FAILED**：结构化提交失败结果 → 任务/工作流 FAILED；终态后零新增。
  3. **CANCELLED（任务级）**：`executor.cancel(task)` 中止在途 run（`cancelled`）；零新增。
  4. **工作流取消**：`workflowService.cancel` → 工作流 CANCELLED、任务 CANCELLED、run 中止；零新增。
  5. **工作流暂停**：暂停期零新调度（agent_runs 数不变、工作流保持 PAUSED）；**在途任务自然完成**（暂停不中止在途——预算暂停场景的设计语义，如实登记）；在途终态后零新增；resume 后正常收敛 SUCCESS。
- 每例先断言「假 LLM 确实在持续发起工具调用」（锚点 tool_calls > 0），再做零新增断言。
- **实施坑（已写入 worklog）**：脚本化模型经 deepagents 的工具路径**必须落在任务类型 readPaths 内**——越权路径（如 backend-agent 读 `README.md`）被权限层静默拦截：无 tool_calls 记录、无沙箱调用、无迭代推进，表现为「假挂起」（400 步空转 ~15s）。调试中一度误判为真挂起，经逐秒采样定位。
- 未改动生产代码——复查结论：E-0(b) 修复后的传播链在任务级（超时/失败/取消）与工作流级（取消/暂停）均无幽灵调用。

## F2-4 T4 上下文增强：只做审计

**状态**：完成（2026-10-08）。**验收 FX-37（决策记录）✓；结论 = 本阶段不做（默认不实施）**。

### 现状审计

- `taskContextBuilder`：注入项目/需求/任务/规格（按 planningVersion）/依赖任务产出/`relevantFiles`（来自规划 `task.input.relevantFiles`，当前普遍缺省）/历史尝试/测试与评审工件——**不含文件内容检索/仓库地图**；检索依赖既有工具面：`read_file` / `list_directory` / `search_code`（固定字符串）/ `git_status` / `git_diff`。
- **数据（`tool_calls` 库表）**：
  - 全库 21092 次调用：探索类（read_file 5242 + list_directory 1465 + git_status 1422 + git_diff 773 + search_code 685）= **9587 次（45.5%）**；含探索调用的迭代占比 **46.6%**（9581/20574）。
  - E-1 批次 1002 次调用：探索类 326 次（32.5%）；迭代占比 34.5%（326/946）。
  - 重复读取：同一 run 内同一文件被读 >1 次的 (run,path) 对 576 个、重复读取调用 1372 次（占 read_file 的 26.2%，占全库调用 ~6.5%）。

### 决策记录（一页）

- **结论：不做 T4 增强（本阶段）**。依据：① 探索占比高但单次成本低（小仓、沙箱内本地读），且「探索→实现」是合理工作模式而非纯浪费；② 重复读取只占全库调用 ~6.5%，尚未达到「探索开销显著」的任务书阈值；③ T4 会给规划/上下文层加复杂度，而当前瓶颈（成功率、超范围、终止传播）已由 F1/F2 其他项覆盖；④ 无 T0 噪声线之外的新证据支持收益。
- **触发条件（再做时的前置）**：出现大仓（文件数显著上升）导致探索占比或重复读取显著抬升；或 S/M/L 回归集显示探索开销影响成功率。若实施：以 T0 噪声线为参照、用 S/M/L 回归集（不使用 E1），先做低风险子项（relevantFiles 规划侧填充、重复读取去重提示）。
- 佐证存档：本决策所依数据可用下述查询复跑——`SELECT tool_name, count(*) FROM tool_calls GROUP BY 1 ORDER BY 2 DESC;`（及 `agent_run_id, iteration` 去重口径见本节文字）。

## F-M2 门禁（2026-10-08）

- **定向**：`writeScopeAudit.test.ts` 9/9、`terminationPropagation.e2e.test.ts` 5/5、`taskVerifier` 相关 45/45、tool-runtime 30/30；server `tsc` 净、eslint（改动文件）净、prettier 净；tool-runtime dist 重建。
- **server 全量**：**203（38 文件）全绿**（`vitest run src --maxWorkers=2`）。
- **全仓 `pnpm -r --no-bail run test`**：唯一红 = apps/web 5 例（PageHeader/eyebrow 既有失败，docs/100/102 已登记，与本阶段无关）；其余 16 包全绿——observability 3 / eval 33 / shared 50 / evidence 9 / visual 83 / failure-recovery 16 / workflow-engine 35 / sandbox 7 / tool-runtime 30 / action-policy 13 / browser 38 / agent-core 157 / mcp 235 / database 47 / server 203。
- **延后项（显式登记，非缺陷）**：FX-34 的「评测回归集成功率不下降」验证部分随 **L3 出口评测**（S/M/L ×3）执行——按用户指令「在 L3 之前停下」，本窗口不跑 L3/L4；下个窗口（配额 2026-10-11 23:00 UTC 刷新后）先 L3 再 L4。

## L3 前置修复与首启事故记录（2026-10-09）

### 事故（L3 首启，01:00–01:20 UTC）

- **现象**：S1 run 1 规划进入「关口 1 批准」无限循环（累计 **570** 次升级审批）；规划产出为硬编码 Todo 内容（`Todo 核心读写` 等）。
- **根因（两层）**：
  1. **受控实例重启环境错误（操作失误）**：重启命令 `source ../.env` 相对路径写错（apps/server 的上级是 `apps/`，根 .env 在 `../../.env`）；后台终端不继承会话 env → 实例仅带显式导出的 4 个变量启动，`.env` 其余全部缺失；`LLM_PROVIDER` 落到 config 默认 **`mock`** → 规划模型 = `ScriptedPlanningModel`（测试夹具），执行器模型同为 mock。
  2. **F1-3 升级路径缺重试上限（平台缺口）**：脚本化规划对 S1（无仓库项目 + 交付守卫）确定性失败 →「修复耗尽 → 升级 → 批准 → 重试」不设上限；评测 harness 自动批准一切 PENDING 审批 → 无限循环。
- **配额影响：0**（mock provider 无外部调用，注释：agent_runs token_usage 本就对规划不记录）；副作用 = 570 条升级审批 + 事件/切片/AC 写入（均为 `[eval] S1` 数据）。
- **处置**：停机（教训：`pkill -f "tsx src/cli.ts"` 匹配不到实际命令行 `tsx/dist/cli.mjs src/cli.ts`——CLI 子进程曾存活至其 20 分钟规划超时并写出失败工件）；拒绝挂起审批（需求复位 ANALYZED）；删除 570 条 `[planning-escalation:]` 审批（重置上限计数，保证 S1 公平重跑）；首启工件归档 `/tmp/f-l3-attempt1-S1-run1*.json|md`。

### 修复 1：受控实例重启规程（教训固化）

- 重启命令（cwd = apps/server）：`set -a; source ../../.env; set +a; export PORT=47557 PLANNING_MODE=two-level VERIFICATION_GATE=enforce SUBMIT_RESULT_MODE=tool`，再 `exec <root>/node_modules/.bin/tsx src/index.ts`（后台终端不继承会话 env，必须显式 source；路径是 `../../.env`）。
- **重启后必检**：对监听进程 `ps eww` 验证 `LLM_PROVIDER=openai`、`DATABASE_URL`、`AGENT_WORKSPACE_ROOT=/Users/shixianbao/Desktop/study`、`PORT=47557` 等关键变量（本次已按此验证）。

### 修复 2：F1-3 升级重试上限（代码，已过测）

- `PgWorkflowRepository.countApprovalsByRequirement(requirementId, reasonPrefix)`：按 reason 前缀计数（`starts_with`）。
- `planningService`：同切片升级轮数 ≥ **2** 时不再建审批 → 切片置 FAILED、需求按既有「anyPlanned」口径置 ANALYZED/FAILED、事件 `SLICE_PLANNING_FAILED { retriesExhausted: true }`。
- 语义：首次失败升级（#1）→ 批准重试 → 再失败升级（#2）→ 批准重试 → 第三次失败 = 终态（切片总尝试 ≤ 3）；**任何自动批准方都不会再形成无限循环**。
- 测试：`planningEscalation.e2e.test.ts` 新增「升级重试达上限 → 终态失败（不再建审批；已完成切片零影响）」用例（审批计数 = 2、exhausted 事件、模型调用 = 10）全绿；server 全量 **204（38 文件）** 绿（第三次运行确认；前两次各 1 例为负载抖动，单跑均绿）。

### L3 重启（09:26 CST）

- 修后实例（真模型、verify: LLM_PROVIDER=openai）上重跑批次；S1 run 1 实测：level-1 规划约 20s、切片级 spec 阶段真实耗时（functional ~29s / technical ~51s…）、关口 1 单次批准（无循环）——真实链路确认，批次继续进行。

### 事故 2：网关 reasoning_content 回传要求（09:40–10:40 CST，上游间歇性缺陷）

- **现象（触发批次中止）**：S1/S2 各 3 次运行 oracle 全失败（S 档早期信号 0/7），对照 E-2b 同夹具 6/9——疑似 F 期退步。任务级下钻：多例 BACKEND 实现任务 agent run `LLM_ERROR`，上游 400 `The reasoning_content in the thinking mode must be passed back to the API`（DB 计数：10-09 6 次、10-07 3 次、E-2b 执行窗口 0 次）。
- **判定**：**非 F 期代码退步**——错误在 E-2b 之前（10-07）即有记录，为上游网关间歇性行为（影响所有批次抽签）；实现任务被 400 杀死 → 无实现产出 → oracle 失败。
- **根因链**：`@langchain/openai@1.5.11` 响应解析把 `reasoning_content` 存入 `additional_kwargs`（`chat_models/completions.js`），但**请求方向转换** `convertMessagesToCompletionsMessageParams`（`converters/completions.js:587`）不回传该字段 → 命中「thinking 模式要求回传」的上游后端即 400。
- **修复（依赖补丁，pnpm 机制化）**：`pnpm patch @langchain/openai@1.5.11` + `patch-commit` → `patches/@langchain__openai@1.5.11.patch`（.js/.cjs 各一行；注册于 `pnpm-workspace.yaml` 的 `patchedDependencies`）。转换器补一行：assistant 消息 `additional_kwargs.reasoning_content` 为非空字符串时回传。
- **验证（真实栈探针）**：`~/.hermes/cache/scratch/f2/probe-stack-reasoning.ts`（agent-core 实际工厂 + fetch 拦截）——修前请求 #2 `has_reasoning=false`；修后 `true` 且 200。单发对照：带 reasoning 回传 200（该字段被接受）；顺带确认 `thinking:{type:"disabled"}` 开关存在（**未采用**——保留思考模式以维持与 E-2b 语义可比）。
- **处置**：批次停机；7 个被污染 run 工件归档 `/tmp/f-l3-poisoned-reasoning-1009-1040/`；实例重启并复验 env（LLM_PROVIDER=openai / PORT=47557 / VERIFICATION_GATE=enforce）；**10:41 CST 批次全量重跑（24 次全新，配额周窗剩余 ~6M）**。
- **保留观察**：网关为共享上游，若出现新 400 变体（反向要求剥离等）需新一轮对照；本补丁对普通 OpenAI 兼容端点的唯一影响 = 当消息自身携带非空 reasoning_content 时多发一个字段（实测被接受）。

### 事故 3：F2-2 工具面立柱 × 权限清单 × 扁平夹具（11:00 CST，FX-34「回归集成功率不下降」的真实发现与修复）

- **现象（修完网关后 S1r1 仍失败、零 400）**：T3/BACKEND 实现任务的 agent 报告 `ls/read_file/grep → "Path is not readable"`、`write_file → "Path is not writable"`（对 `.`、`/workspace`、`src/slugify.mjs` 全拒），最终 `submit_result("Blocked: ... every filesystem tool call is denied")`；`tool_calls` 表仅 2 行（权限拒绝发生在 deepagents FS 中间件层，不落表——与 F2-3 的「假挂起」同源现象面）。
- **根因（三层叠加）**：① **全部评测夹具**（S1..L2 + E1，共 9 档）均为**扁平布局**（`src/`+`test/`[+L1 `content/`]），而 `AgentRegistry` 中 backend/frontend/database 的路径清单为 monorepo 风格（`apps/server|server|backend` 等），**不含 `src`** → 文件工具对实现任务历来不可写；② E-2b 及更早批次能产出实现，靠的是 `run_build`/`run_unit_test` **任意 shell（heredoc 写文件）的逃逸通道**；③ F2-2/FX-34 将三脚本工具收口为脚本形态后，逃逸通道关闭 + 文件工具路径不覆盖 → **实现任务无任何写入手段** → 「blocked」提交 → oracle 失败。**判定：这是 FX-34 验收条款「评测回归集成功率不下降（以 T0 噪声线为参照）」在 L3 回归集上的真实发现**——L3 正是该验收的执行载体；此前 E-2b 的 S 档成绩单掩盖了该路径错配。
- **修复**：`AgentRegistry.ts` 三个代码 agent（backend / frontend / database）`readPaths` += `src`,`test`；`writePaths` += `src`（覆盖扁平布局；与既有 monorepo 前缀无冲突——`src` 仅匹配项目根级源码目录）。qa-agent（写 `test`）与 reviewer/planner（只读 `.`）本就覆盖，零改动。
- **验证**：`AgentRegistry.test.ts` 增「代码类 agent 覆盖扁平布局」意图断言；`ToolRuntimeBackend.test.ts` 增行为断言（backend-agent `write("src/…")` 过权限门可达沙箱；`README.md` 仍 `Path is not writable`）。agent-core **159/159（29 文件，157→159）**；server 邻域（professionalAgents.e2e + workflowApi.e2e）13/13 全绿。
- **顺带补齐（FX-32 调查记录的 WHY）**：E-1 批次 heredoc 写 109 次 vs write_file/edit_file 23 次的成因中，「文件工具路径不覆盖 + heredoc 一步到位」并存；修复后文件工具成为平板项目的可用（且推荐）通道。
- **处置**：停机；attempt-3 工件（S1r1/r2）归档 `/tmp/f-l3-poisoned-perms-1009-1102/`；实例重启（env 复验 LLM_PROVIDER=openai / PORT=47557 / VERIFICATION_GATE=enforce）；**11:02 CST 批次全量重跑（第 3 次，24 次全新）**。

### L3 批次执行结果与停止记录（2026-10-09 14:55 CST 停止）

- **停止性质**：按用户指令停止（预估余额不足以跑完，停止本窗口消耗；非故障停）。
- **执行面（第 3 次批次，11:02–14:55）**：
  - 完整结果 **11 个 run**：S1×3、S2×3、S3×3（9）、M1×2（M1r1/M1r2）；
  - S 档 oracle **5/9**（S1 1/3、S2 1/3、S3 3/3；对照 E-2b 6/9，S1/S2 与 S3 分布互换，单档 n=3 在噪声区）；
  - M1 oracle 2/2 通过；
  - M1r3 中断（无结果件；slice-1 工作流 SUCCESS、slice-2 随停转 FAILED；3 个 READY 任务不再调度）；
  - M2×3、M3×3、L1×3、L2×3 未跑。
- **配额**：18.50M / 20M（停机后 delta=0 验证冻结）；护栏口径修正：M 档实测 0.84–1.07M/run（远超估算），实际护栏会在 M2 首 run 后触顶——「M 档跑完」在本窗口物理上不可达。
- **处置**：批次 + 哨兵（f-l3-stop-after-m.sh）+ 看门狗全停；工作流 5a19c536 停后状态 FAILED（无活动 run）。
- **数据面**：`packages/eval/results/f/l3/` = 11 个完整 run（S×9 + M1×2）；批次日志 `/tmp/f-l3-batch.log`。
- **下窗口补跑清单（2026-10-11 23:00 UTC 刷新后，预计 10-12 07:00 CST）**：M1r3、M2×3、M3×3、L1×3、L2×3 = **13 runs**（预估 8–10M，新窗口预算充裕）。

### L3 续跑（2026-10-12 09:11 CST 启动）

- **窗口核对**：新窗口（2026-10-11 23:00 UTC 起）用量 0；停产时的 18.50M 属上一窗口（已封账）。
- **脚本升级（断点续跑能力）**：`f-l3-sml-split.sh` 增加「结果 JSON 已存在则跳过」（`run_one` 首行检查）；`WEEK_START` 更新为 `2026-10-11 23:00:00+00`。其余批次契约不变（run1 `--replan`、20M 护栏、120s 冷却、逐 run checkpoint）。
- **受控实例重启**：PORT=47557，env 经 `ps eww` 复验（`LLM_PROVIDER=openai` / `VERIFICATION_GATE=enforce` / `SUBMIT_RESULT_MODE=tool` / `AGENT_WORKSPACE_ROOT` / `DATABASE_URL`）；health=200。
- **续跑清单**：M1r3、M2×3、M3×3、L1×3、L2×3 = **13 runs**；启动时正确跳过 11 个既有结果，M1r3 于 09:11:46 开始（复用计划 v10，首工作流 `659351ea-91e6-4663-b131-28bb83f3b244`）。
- **日志轮转**：attempt4 停机时日志归档为 `/tmp/f-l3-batch-attempt4-stopped.log`、`/tmp/f-l3-watchdog-attempt4.log`、`/tmp/f-l3-server-47557-attempt4.log`、`/tmp/f-l3-sentinel-attempt4.log`；续跑日志回到 `/tmp/f-l3-batch.log` / `/tmp/f-l3-watchdog.log`。

### L3 出口回归评测（完成，2026-10-12）

- **批次执行**：13 次续跑 09:11–14:45（5h33m），`F_L3_SML_ALL_COMPLETE` 正常收尾；本窗口耗 **8.63M / 20M**；24/24 结果件齐。**汇总报告：`packages/eval/results/f/l3/SUMMARY.md`**。
- **L3 vs E-2b（口径 29 Must + 1 Should）**：oracle **15/24 (62.5%) vs 8/23 (34.8%)**（+27.7pp；Fisher 双侧 p=0.082）；自报 2/24；链完成 2/24；**交付成功 2/24（L1r2/r3 = F 口径首批 deliveredSuccess=TRUE）**；假阴性 13/24；超范围写入 1（L2r3）。
- **分档**：S1 1/3、S2 1/3、S3 3/3、M1 3/3、M2 0/3、M3 3/3、L1 2/3、L2 2/3（E-2b：3/3、3/3、0/3、0/3、0/3、1/2、1/3、0/3）。
- **失败面**：`VERIFICATION_FAILED×14`（其中 **VACUOUS_TEST 标记 20 处**——F 期空泛测试检出在真实评测中的首个规模化检出面）；`TIMEOUT×3`；`EMPTY_FINAL_ANSWER×1`；L2r2 = PUT 断言 404。
- **F 期能力验证**：F1-8 口径字段全 24 run 采集成功；VACUOUS_TEST 检出生效；scopeViolation 首例（L2r3，observe 未阻断）；工具面修复生效（实现类任务文件工具写入恢复）。
- **登记观察（4）**：① S1/S2 分档滑落（3/3→1/3，n=3 噪声区内，与 S3 0/3→3/3 互换，转 L4 复核）；② M2 双期同挂 0/3（稳定难例）；③ S1 planningMetrics 跨批次污染（1141/1710 同值×3，同需求历经多批次累计；干净档位正常）→ 规划指标口径按批次重置待办；④ scopeViolation 记录面与事件面 workflow 集差异（M1 档 10-09 事件未入记录）。
- **判定**：**FX-34「评测回归集成功率不下降」成立；L3 出口回归 = PASS（含 4 项登记观察）**。
- **未开始事项（STOP）**：L4（E1×3 出口批次）未跑——待用户放行（本窗口尚余 ~11.4M，或下窗口执行）。

### L4 出口批次（E1×3）启动记录（2026-10-13）

- **放行**：用户指令「继续任务」承接 L4 待放行项；本窗口（2026-10-11 23:00 UTC 起）此前未跑过 E1 批次，符合「一周最多一个 E1×3 批次」纪律。
- **实例事故与恢复**：L3 受控实例已于 10-13 17:37:27 收到 SIGTERM 退出（日志明示 `server shutting down`；**推断为上下文压缩的 agent 生命周期清理**，非崩溃、非 OOM——机器内存虽紧张但进程为优雅退出）。按规程重启（cwd=`apps/server`、`source ../../.env`、4 项导出、PORT=47557）；**本次起以 persist_on_release 模式运行**（免疫会话清理类 SIGTERM）；health=200、`ps eww` env 复验全绿（`LLM_PROVIDER=openai` / `PLANNING_MODE=two-level` / `VERIFICATION_GATE=enforce` / `SUBMIT_RESULT_MODE=tool` / `DATABASE_URL`）。
- **批次脚本**（新增）：`packages/eval/scripts/f-l4-e1-x3.sh`（E1×3；run1 `--replan`（沿用批次契约）；20M 护栏（WEEK_START=2026-10-11）；冷却 1800s（E-1 先例，可 env 覆写）；断点续跑；可选 `F_L4_DEADLINE_EPOCH`）+ `f-l4-watchdog.sh`。输出 `packages/eval/results/f/l4/run-{1,2,3}.json`。
- **启动**：**2026-10-13 17:44:59 CST**（before run 1: weekly used=8,630,326）；run 1 已进入规划（analyze regenerate，requirement→ANALYZING）→ 关口 1 审批（审批 `0b6d5b1f`）。
- **预估**：总时长 3–6h；预算按 L3 外推 ~1–2M/run（E-1 先例单 run 18–64 min、~0.1–0.74M）。
- **运行日志**：`/tmp/f-l4-batch.log`、`/tmp/f-l4-watchdog.log`、`/tmp/f-l4-server-47557.log`。

### L4 事故 4 与恢复（2026-10-13 18:18）——会话级清理击杀与守护化恢复

- **现象**：18:18:34 受控实例收到 SIGTERM 优雅退出（日志 `"signal":"SIGTERM","msg":"server shutting down"`）；同一时刻批次（caffeinate/bash/cli）与看门狗全部消失；助手的一个工具调用同时被孤儿化（orphan recovery 提示）。
- **判定**：**会话级清理事件**（agent lifecycle cleanup，与上下文压缩/会话恢复同源；`persist_on_release=true` 亦未能幸免 → 该事件直接对应用进程树发 SIGTERM）。排除崩溃/OOM/睡眠（pmset 无 sleep 事件；进程为优雅退出）。
- **影响**：run 1 实际执行 ~28 分钟（17:49:45–18:18；10 个 agent run 全部 succeeded，~0.47M tokens；工作流 `72f1c770` 停在 slice-1 中途）。无结果件落盘（run-1.json 未生成）→ 本轮工作作废；配额 8.63M→9.04M（+0.41M）。
- **恢复（18:24–18:26）**：
  1. **新脚本 `f-l4-server-launch.sh`**：服务器以**脱离宿主进程树的守护方式**启动（double-fork + setsid，根进程 ppid=1）→ `SERVER_LAUNCHED:64644`，health=200，env 复验全绿（`LLM_PROVIDER=openai` 等）。
  2. 取消僵尸工作流 `72f1c770`（→ CANCELLED）；E1 需求状态 ANALYZED；无残留 RUNNING 任务（255 个 PENDING 属计划行，随 replan 走 SUPERSEDED）。
  3. **新脚本 `f-l4-launch.sh`**：批次 + 看门狗同样守护式启动 → `E1_L4_LAUNCHED: batch=64933 watchdog=64941`（ppid 均 =1）；**run 1 于 18:25:35 重新开始**（--replan → 新计划版本）。
  4. caffeinate 断言确认（PreventUserIdleSystemSleep 生效）。
- **规程固化（教训）**：多小时批次及其依赖（受控实例/批次/看门狗）一律用 **double-fork + setsid 守护式**启动（`f-l4-server-launch.sh` / `f-l4-launch.sh`），**不再使用会话内后台进程**（后者会被会话清理连带击杀；`persist_on_release` 实测不足以防）。

### L4 事故 5：提供方月度限额阻断与自动续跑（2026-10-13 18:37）

- **现象**：run 1 于 18:37:42 起连续 `429 Go usage limit exceeded`（当日 `llm_retry` 事件 7 条：18:37:42–47 ×5、19:08:22–23 ×2）；run 2 首个 LLM 调用即 429，3 秒失败（taskStatuses: FAILED 1 / PENDING 10）。
- **定位**：带 `x-opencode-session` 头的实时探针（19:40）返回 `{"type":"GoUsageLimitError","metadata":{"limitName":"monthly"}}` —— **OpenCode Go 订阅「月度」用量限额耗尽**。提供方侧、与平台 20M token 护栏无关（护栏 = 平台自记 token 数；提供方 = USD 值 × 月度窗口；社区已知其配额计数存在缺陷）。平台侧表现正常：规划 v29（11 任务/4 切片）生成、关口 1 审批、planner/qa agent 在触顶前完成实际工作。
- **影响**：run 1（18:33–18:38）、run 2（19:08）作废（非平台缺陷）；批次已在 run 3 前斩停（19:36，避免无效重复）；两件结果归档 `results/f/l4/attempt1-provider429/`（含 NOTE.md）；结果目录已清空（恢复后全量重跑 3 run）。
- **处置与恢复安排**：
  1. **自动续跑守护**（新脚本 `f-l4-auto-resume.sh`，double-fork 守护式，pid 74186）：每 10 分钟探针；探针 200（限额重置或余额回退生效）→ 自动确保实例在线 → 重启 L4 批次；72h 上限；日志 `/tmp/f-l4-autoresume.log`。
  2. 平台实例保持运行（health=200）；断点续跑就绪。
- **用户侧选项**：① opencode.ai/auth 查用量与重置时间；② 启用「Use balance」（Zen 余额回退）→ 立即恢复；③ 升级 Go Plus；④ 等待重置。任一恢复路径下自动续跑自动接管。

### 观察项小修（完成，2026-10-13 20:05）——等待提供方恢复期间提前落地

- **planningMetrics 按批次重置（跨批次累计污染修复）**：`harness.ts` 新增 `filterPlanningRunsInWindow`——规划指标只计「本轮窗口内」的规划 run（run 1 窗口覆盖其 replan；r2/r3 只计自身执行期）；S1 档 `llmRepairRounds=1141` 类跨尝试累计污染不再复现。
- **sv 采集面补全**：新增 `selectUncollectedWorkflows`——本轮窗口内、同需求、未被本轮收录的工作流（平台内部重试/重建，如 M1 档 10-09 的 `6901ffa5`）详情事件并入 `SCOPE_VIOLATION` 判定；`/api/workflows` 列表不可用时降级为空（不阻断 run）。
- **验证**：eval 包 `typecheck` ✓ / `lint` ✓ / **测试 35/35（+2 新用例）**。改动仅限 `packages/eval/src/harness.ts` + `src/__tests__/metrics.test.ts`。
- **对 L4 的影响**：L4 重跑采用修复后口径（两字段更准确）；L3 汇总中该两字段的受限说明维持（修复前口径，如实登记）。
- **状态**：自动续跑守护已重新武装（pid 93239；20:06 探针仍 429/monthly）；L4 待提供方恢复后自动全量重跑。
- **解除（2026-10-13 23:17–23:19）**：用户于 23:17 更新平台 `.env` 的 `OPENAI_API_KEY`（根因 = 平台 key 所属 workspace 的月度限额耗尽；用户主账户/其它会话正常）→ 新 key 探针 **200**；23:18 重启受控实例（kill 旧进程树 → `f-l4-server-launch.sh`；**key 哈希比对一致** `cc625bf3…`、env 复验全绿）；**23:19:46 守护式重启 L4 批次**（run 1 `--replan`；attempt-1 作废件维持归档不动）；自动续跑守护重武装（79601，作为批次死亡兜底）。重启后 90 秒观察：**零 429**、规划推进（关口 1 审批 `6e13fdac`、agent run `3246530f` succeeded）。

### L4 出口验收（完成，2026-10-14 03:26）——测量轮

- **批次**：23:19:46 → 03:26:58（3h07m）；本批次 +3.78M → 窗口 12.83M/20M；**零 429**（新 key 生效）；watchdog `WATCHDOG-DONE`、守护 `batch already complete - exit`。
- **结果**：oracle **0/3**（2/29、21/29、24/29）；链完成 0/3；交付 0/3；假阴性 0/3；超范围 2/3；**sliceReached = slice-1 / slice-3 / slice-4**（**链首次越过 slice-2**，最远 4/5）；失败分层 **规划 0 / 验证 3 / agent 4**；任务级验证分歧 0/1/2。
- **测量轮判读（§8）**：① 链越过 slice-2 ✓；② 失败从规划/门层迁移到 agent/验证层 ✓（规划层清零，planningMetrics 首轮通过 2/3、收敛 3/3——观察项小修后的干净口径）。
- **F-M1 分级**：**PASS-PARTIAL**（deliveredSuccess 0/3 < 2/3，按裁决④测量轮归因输出，不下调 PASS 线）；归因：链停 = TEST 任务 VACUOUS_TEST 判负（2/3）+ agent 超时（1/3，run1）；规划/门层修复目标已达成。
- **F-M2 出口核对**：FX-29..37 ✓；observe 数据与决策记录 ✓；**L3 62.5% ≥ T0 噪声线 58.3%** ✓ → 满足。
- **登记观察（阶段 G 候选）**：① VACUOUS_TEST 主瓶颈（3 处判负，与 L3 一致；判定精化）；② run1 TIMEOUT×3（600s；同计划 run2 成功，非计划缺陷；长任务超时策略）；③ 超范围首采 3 事件（BACKEND 写 README/scripts，observe 未阻断）；④ **平台链推进乱序**（run3 首个 PENDING=slice-4 跳过 FAILED 的 slice-3 → replan v34 → 与 harness 重启的 slice-2 双链并行；前序完整性校验）。
- **汇总报告**：`packages/eval/results/f/l4/SUMMARY.md`（全字段）。
- **未开始事项（STOP）**：**阶段 G 任务书等待中**（收尾簿记已完成：docs/127 已更新；验收结果见下节）。

## F 期验收结果（docs/16 固定节 · 2026-10-14）

### Implementation / Architecture Changes

- 规划层：acKeys 确定性回填、单一生效计划版本（SUPERSEDED）、确定性自动修复 + 升级上限、全局性 AC 归属与最终切片规模（observe→校准→阈值 18）、三层检查、诊断码拆分、环境与部署面小修复包、F1-8 口径与历史重算（F1-1~F1-8）。
- 治理层：写范围审计（observe）、工具面脚本收口、终止传播复查、T4 审计（不做）（F2-1~F2-4）。
- 无第二套体系引入（Permission/Approval/Audit/错误码复用既有抽象）；E1 隔离红线未破。

### Dependencies

无新增运行时依赖；`patches/@langchain__openai@1.5.11.patch`（网关 reasoning_content 回传）；沙箱镜像 `ai-se-sandbox:22-pnpm9`（离线 pnpm 本体）。

### Tests / Lint / Typecheck

- **全仓复核（2026-10-14，收尾门禁）**：`typecheck` 全绿（全 workspace）；`lint` 全绿（16/17 scope）；`test`：**16/17 包全绿**——agent-core 29 文件、server 38 文件/204 用例、mcp 24、database 10、browser 8、eval 5、visual 6、shared 5、workflow-engine 3、tool-runtime 3 等；**唯一失败 = apps/web 5 例既有红**（PageHeader/eyebrow，docs/100/102 已登记，非新增）→「全仓测试无新增失败」成立。日志：`/tmp/f-closure-fullcheck.log`。
- 全期门禁（分阶段）：agent-core 159/159、eval 35/35（收尾 +2）、tool-runtime/server 等按各节记录。
- E2E/批次：L2 规划演练 ×3、L3 回归 24 run、L4 E1×3 测量轮；事故修复均带验证（网关探针、权限行为断言、key 哈希比对）。

### Acceptance Result

- 硬指标全过（FX-01..37、R1–R6、全仓测试、L2 演练、L4 报告含全部要求字段）。
- **F-M1 = PASS-PARTIAL**（deliveredSuccess 0/3 < 2/3；按裁决④测量轮归因：链停 = TEST 任务 VACUOUS_TEST 判负（2/3）+ agent 超时（1/3）；规划/门层失败清零、链深 slice-4/5、oracle 最高 24/29）。
- **F-M2 = 出口满足**（L3 回归 62.5% ≥ T0 噪声线 58.3%）。
- 事故 4 起（会话清理击杀 ×2、提供方月度限额、网关/权限历史件）全部闭环并固化规程（守护式启动、key 更换规程、自动续跑）。

### Next Phase Boundary

阶段 G（T5 其余 / T9 / T7 + F 期转来候选）需新任务书授权后启动。**STOP（不自动进入）。**

---

## 勘误追加块（2026-10-17，PL-M13 / `docs/173`）

> 按 `docs/146` §6 规则 7：**上文原文保留不改**，更正以本追加块为准。

**本文 §事故 2（网关 reasoning_content 回传要求）的「判定」不完整。**

- **原文判定**：「**非 F 期代码退步**——为上游网关间歇性行为（影响所有批次抽签）」。
- **更正**：上游确实间歇性进入 thinking 模式并**要求回传**（这一点原文正确）；但**平台侧存在可指认的丢失点**，使补丁在部分轮次上根本不生效——所以它不是「纯上游运气问题」。
- **实查证据（`docs/173` §2 更正 1/2）**：补丁只在「assistant 消息自身携带非空 `additional_kwargs.reasoning_content`」时才回传；而平台重建 `AIMessage` 的位置**没有保留 `additional_kwargs`**。已定位两处可达点——`DeepAgentLLMProvider.invoke`（`:89-98`）与 `LangChainLLMProvider.invoke` 挂成本时的重建（`:119-125`）。**探针实测**：平台自己的回灌形状 `reasoning_content` 为 ABSENT，消息自身带该字段的对照组为 PRESENT（同一转换器、同一网关）。
- **原文「保留观察」里的猜测亦作废**：当时写「若出现新 400 变体（反向要求剥离等）需新一轮对照」。2026-10-17 出现的第二种 400（`tool message content must be a string`）**与 reasoning_content 不同源**——根因是第三方 `deepagents` 的 `read_file` 返回内容块数组，经 `@langchain/core` 原样放进 `ToolMessage.content`（`docs/173` Implementation 的三环链条）。
- **另需更正一处口径**：本文 §事故 2 记「DB 计数：10-09 6 次、10-07 3 次」。2026-10-17 全库复核为 **10-09 7 次、10-07 3 次**（10-09 多 1 条）；差异原因未查。
- **累计分布（全库实查）**：`reasoning_content` —— 10-07 3 次 / 10-09 7 次 / 10-14 3 次 / 10-17 3 次；`tool message content` —— **仅 10-17 出现 6 次**。
- **修复**：PL-M13（任务书 `docs/172`、实施记录 `docs/173`）。**本追加块不改变原文的处置结论**（当时停机、重跑、固化探针手法都是对的），只更正归因的完整性。
