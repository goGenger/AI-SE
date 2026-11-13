# 115 · 阶段 B 实施记录：规划改造与预算（N0 / N1 / N2 / T6）

> 对应任务书：`docs/114-phase-b-taskbook-planning-and-budget.md`（阶段 B）。
> 编号说明：**115 = 本实施记录**（114/115 为 B 段连号；不占用 114，不覆盖任何既有文档）。
> 状态：**已完成** —— B-1（N0）/ B-2（N1/N2）/ B-3（T6）/ **B-4（出口验证：两批 + 修复补跑 + E1 ×3 基线）全部完成**；阶段 B 出口基线已冻结（见文末「阶段 B 完成报告」）。

## B-1 · N0 —— E1 夹具建设（**已完成**）

### B-1.1 可构建性验证（关键前置 → **已通过**，两轮）

- 首轮（最小骨架，结论取证）：E1 形态最小骨架在 `/tmp/e1-buildability`（git init + 1 次 commit，`commit=9ba3041`）六步全 exit 0，`node --test` 2/2，镜像 `6343e3aac7ab`。
- 终轮（完整实现 + prettier 重排后重跑）：工作区**重建**（fresh git init + 1 次 commit，`commit=9c73688`），逐命令退出码：

| #   | 命令（`LocalCiOperations` 契约，`deliveryAdapters.ts:136`） | 退出码 | 备注                                                    |
| --- | ----------------------------------------------------------- | ------ | ------------------------------------------------------- |
| 1   | `pnpm install --frozen-lockfile`                            | 0      | pnpm v12.3.4（corepack）                                |
| 2   | `pnpm lint`                                                 | 0      | `check ok`（syntax + hygiene，`scripts/check.mjs`）     |
| 3   | `pnpm typecheck`                                            | 0      | 同上                                                    |
| 4   | `pnpm test`                                                 | 0      | `node --test`：**28/28 通过**（`# pass 28 / # fail 0`） |
| 5   | `pnpm build`                                                | 0      | 同上                                                    |
| 6   | `docker build -t e1-probe:buildability .`                   | 0      | 镜像 `sha256:495e4647…`（本地标签已由终轮覆盖）         |

- 运行形态抽查（首轮，`docker run -v /tmp/e1-probe-data:/data`）：`/healthz` `/health` `/ready` 均 **200**；首页 4 个 `data-testid`（`home-title` `task-list` `search-input` `new-task-button`）齐全；容器内用户 `node`（**uid 1000，非 root**）；卷写入 `write-ok`；日志正常。
- **结论**：E1 工程形态的六步构建契约可在夹具工作区完整跑通（本机直跑验证）；`docs/114` §N0-5 的 BLOCKED 前置解除。
- 工具链与环境坑（转记）：
  - node v22.22.2；pnpm 12.3.4（corepack）。
  - **本机新登录 shell 默认解析到 node v16.16.0**（无全局 `fetch`）——自检/长运行命令必须显式 `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`；`selfcheck.mjs` 已内置 Node ≥ 22 守卫（早期一次全挂即由此坑引起，非业务失败）。
  - pnpm 12.3.4 为**原生二进制版**：corepack 首次使用需一次预热（如 `pnpm --version` 触发二进制下载），否则 shim 可能报 `pnpm.cjs` `MODULE_NOT_FOUND`。
  - 平台 server 进程（pid 13092）实测运行于 node v22 且 PATH 含可用 pnpm —— **B-4 平台侧运行 E1 的前提已核**。
  - 看护项（转记）：CI 的 bare `pnpm` 依赖 PATH（nvm/corepack）——阶段 D（N6）部署链演练时须复核（含以上两条环境坑）。

### B-1.2 参考实现（完成）

`packages/eval/fixtures/E1/reference/`（977 行；零运行时依赖，Node 标准库 + JSON 文件存储）：

| 文件                                                               | 行数 | 说明                                                 |
| ------------------------------------------------------------------ | ---- | ---------------------------------------------------- |
| `src/server.mjs`                                                   | 269  | HTTP 服务 + 路由 + 统一错误封套                      |
| `src/store.mjs`                                                    | 23   | `DATA_DIR/db.json` 持久化（tmp + rename 原子写）     |
| `src/auth.mjs`                                                     | 63   | scrypt 口令哈希 + HMAC-SHA256 签名令牌（取值不保留） |
| `src/validate.mjs`                                                 | 29   | 输入校验规则（用户名/密码/标题/日期）                |
| `src/tasks.mjs`                                                    | 98   | 任务 CRUD + 用户作用域隔离                           |
| `src/pages.mjs`                                                    | 14   | 首页 HTML（4 个 `data-testid`）                      |
| `test/api.test.mjs`                                                | 348  | 24 个行为用例（测试名含对应 AC 编号）                |
| `test/deploy-contract.test.mjs`                                    | 30   | 4 个部署静态契约（AC-24/25/26/29 口径）              |
| `scripts/check.mjs`                                                | 37   | lint/typecheck/build 共用自检（syntax + hygiene）    |
| `Dockerfile`                                                       | 14   | 非 root（uid 1000）+ `VOLUME /data` + stdout 日志    |
| `README.md`                                                        | 39   | 启动/测试/构建/容器命令文档                          |
| `package.json` / `pnpm-lock.yaml` / `.gitignore` / `.dockerignore` | —    | pnpm 工程（`pnpm@12.3.4`），lockfile 随夹具提交      |

- 测试 **28/28**；AC 覆盖 **28/28**（AC-22 为可选 Should；AC-30 由 4 个部署静态契约测试覆盖）。
- 与平台契约一致：`pnpm start` 读 `PORT`；健康端点 `/healthz` + `/health` + `/ready`；`DATA_DIR` 默认 `./data`、容器内 `/data`。
- 安全注记：口令哈希与令牌签名机制齐备；一切凭据/密钥取值不保留（[REDACTED]）。

### B-1.3 隐藏 oracle 与自检（完成）

- **oracle**：`fixtures/E1/oracle.mjs`（774 行；Node + `fetch` 黑盒）。流程：按 PRD 文档化命令启动应用 → 健康探测 → 30 条 AC + 隐藏边界 → 数据文件扫描（宿主 `DATA_DIR` + 容器数据卷）→ 容器段（构建 / 运行 / 重启持久化 / 非 root / 日志脱敏）→ 逐条输出 `E1_RESULTS_JSON`。约定与既有 oracle 一致（`oracle.ts`：cwd = 夹具目录、workspace 作 `argv[2]`、只读工作区、exit 0 = 全部 Must 通过）。
- **对参考实现实跑：30/30 全过（Must 29/29 + Should 1）**（修复后两轮：手工 run4 与 selfcheck 轮）。
- **变异版本 6 个**（`fixtures/E1/mutants/`，`NOTES.md` 记录改动与期望检出点），**全部被检出**：

| 变异                           | 主要改动                         | 检出（Must 失败）               |
| ------------------------------ | -------------------------------- | ------------------------------- |
| `no-data-isolation`            | tasks.mjs 去掉全部 userId 作用域 | AC-28 / AC-23 / AC-27（+AC-30） |
| `no-persistence`               | store.mjs `persist()` 不写盘     | AC-25 / AC-30                   |
| `patch-ignores-unknown-fields` | PATCH 跳过未知字段校验           | AC-19 / AC-30                   |
| `plaintext-passwords`          | auth.mjs 明文存口令              | AC-04 / AC-30                   |
| `title-off-by-one`             | validate.mjs 允许 101 码点       | AC-15 / AC-30                   |
| `wrong-error-codes`            | 重复用户名返回 500               | AC-03 / AC-05 / AC-06 / AC-30   |

- **selfcheck**：`fixtures/E1/selfcheck.mjs`（180 行）四项校验——① prd ↔ oracle 的 AC 集合一致（无遗漏、无孤立）；② `fixture.json.requirementText` 与 prd.md 全等；③ 参考实现全 Must 过；④ 6 变异全检出。命令：`cd packages/eval/fixtures/E1 && node selfcheck.mjs`；结果落 `selfcheck-results.json`。
- **本轮结果：PASS**（`pass=true`，`generatedAt=2026-09-29T12:54:11Z`；consistency：prd 30 / oracle 30、missing=0、orphan=0；reference 29/29；变异检出 **6/6**）。
- **不并入常规单测**（依 `docs/114` §N0-3）：自检依赖本机 Docker（容器段）与 pnpm，并入 `pnpm test` 会令门禁对 docker 环境敏感；以 `selfcheck.mjs` 独立执行、结果 JSON 留档。
- 自检期间对 oracle 的两处修正（均已同步 PRD 措辞，最终自检基于修正后版本）：
  1. **AC-04 扫描范围**：初版扫描「工作区」会把参考实现测试文件中的合法测试口令误报为明文泄漏；修正为**数据文件口径**（宿主 `DATA_DIR` + 容器数据卷，且各自必须存在数据文件）——与 PRD「数据文件不得出现明文密码」一致。
  2. **AC-23 恶意字符**：由「全部 200」放宽为「**不产生 5xx**」，避免对合法实现过严。

### B-1.4 AC↔断言对照表（完成）

- `fixtures/E1/ac-map.md`（41 行）：30 条 AC 与 oracle 断言**一一对应**（行序 = PRD 的 FR 分组，与 oracle 执行顺序一致）；脚本校验（selfcheck ①）**无未覆盖 AC、无孤立断言**。

### B-1.5 fixture.json 与 PRD 正文（完成）

- `fixtures/E1/prd.md`（140 行，8,446 字符）：9 个 FR / 30 条 AC（含 FR↔AC 映射速查表）+ 技术约束 + 通用接口约定 + 工程契约 + 附录 A 边界覆盖；为夹具内**唯一需求源**。
- `fixtures/E1/fixture.json`：`requirementText` = prd.md 全等（selfcheck ② 持续校验）；`oracle = { command: "node", args: ["oracle.mjs"] }`；**超时覆盖：oracle ≤ 20 min（1,200,000 ms）、单次 run ≤ 120 min（7,200,000 ms）**。
- `fixtures/E1/template/`（占位 `README.md` + `.gitignore`）：保证 `prepareWorkspace` 的 git init/add/commit 基线可用（`cli.ts:148`–`150`），不含任何实现线索（E1 隔离）。

### B-1.6 评测包最小集成（完成）

- `types.ts`：`Tier` 增字面量 `"E1"`；`EvalFixture` 增可选 `oracleTimeoutMs` / `runTimeoutMs`。
- `cli.ts`：按夹具覆盖透传（`fixture.oracleTimeoutMs ?? 全局`；`runTimeoutMs` 同理）；`harness.ts` 无需改动（超时已是运行参数）。
- `metrics.ts`：档位汇总由固定 `TIERS` 改为 `BASE_TIERS（S/M/L）+ 记录中出现的其它档位动态追加`——旧批次汇总输出保持不变，E1 记录出现时自动入表（新增单测 1 例）。
- `fixtures.test.ts`：9 个夹具清单断言（E1 + 原 8 个）；E1 分支校验 prd 一致性 / reference / mutants / template 占位。
- 门禁：`@ai-se/eval` typecheck ✓、lint ✓、test **18/18**（原 17 + 新增 1）。
- **B-1 验收对照**（`docs/114` §N0 验收）：oracle 对参考实现全 Must 通过 ✓；6/6 变异全检出 ✓；AC↔断言一一对应（无孤立断言）✓；六步构建全过 ✓。—— **B-1 完成，STOP 待令**。

## B-2 · N1 / N2（**已完成**）

### N1 · 180s 处理决策记录（先落笔：N2 的输入）

**证据**（来源：`docs/110` §7.1 实测 + 本轮复核）：

| 维度           | 事实                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 失败性质       | 6 次失败 run 的错误码全部为 `TIMEOUT_ERROR`（墙钟）；事件流**无** `PLANNING_SCHEMA_VALIDATION_FAILED` / 修复风暴 —— 不是校验反复失败 |
| 预算语义       | `PLANNING_TIMEOUT_MS = 180_000`（`planningService.ts:36`，硬编码无 env）是**整个规划运行的总上限**；8 个阶段共用，阶段无独立上限     |
| 单阶段实测耗时 | requirement_analysis 58s；functional_spec 89s；technical_spec **120s**；L2 出现单阶段 >900s 失控样本；L1 二次运行 8 阶段共 150s 通过 |
| 波动性         | 同一需求「一次超时、一次通过」（L1）——预算余量太小，被**个别慢阶段**吃穿是主因                                                       |

**处理决策（冻结默认；N2 按此实现）**：

1. **单一 180s 常量 → 分阶段预算 + 总预算兜底**（config-first，env 可覆盖）：
   - 阶段上限 `PLANNING_STAGE_TIMEOUT_MS`（默认 **150000**；依据：实测最慢阶段 120s + 25% 余量），阶段失败重试 `PLANNING_STAGE_RETRIES`（默认 **1**）；
   - 第一级（analysis + slice_planning）总预算 `PLANNING_LEVEL1_TIMEOUT_MS`（默认 **300000**）；
   - 第二级单切片总预算 `PLANNING_SLICE_TIMEOUT_MS`（默认 **600000**）；
   - `single` 旧路径维持总 180s 与现有语义（常量保留在旧路径上），供 S 档回归。
2. **两级化**：第一级 = requirement_analysis + `slice_planning`（新阶段）；关口 1（复用 approvals）；第二级按切片执行既有 spec 阶段 + `task_planning`——慢阶段不再互相挤占预算。
3. 超时仍走既有 `TIMEOUT_ERROR` / 修复通道，**不新增错误体系**；每阶段的超时/失败发事件留痕。

**与 T6 的分工声明**：N2 管**规划内部**预算（阶段/级别，作用于 planning agent run 的墙钟）；T6 管**工作流整体**预算（`maxCostUsd`/`maxTokens`/`maxWallClockMs`，作用于 workflow run 的 claim 循环）。数据层级不同、无重叠、无第二套。

### N2 · 两级规划 + 分阶段预算（实现完成；S1 冒烟见 N2.6）

#### N2.1 交付清单（按模块）

**迁移 011**（`packages/database/migrations/011_phaseB_two_level_planning.sql`，65 行，追加式）：

- `requirements` CHECK 增 `PLANNING_REVIEW`；新表 `requirement_slices`（`slice_key`/`title`/`goal`/`fr_keys`(jsonb)/`depends_on`(jsonb)/`slice_order`/`involves_ui`/`status`/`planning_version`/`workflow_run_id`）；
- `tasks` 增列 `slice_key`；`approvals`：`task_id`/`workflow_run_id` 放宽可空 + 新增可空 `requirement_id`（部分唯一索引保持任务审批语义不变）；
- `migrate.test.ts` 清单断言 10 → 11。**开发库已应用**：`{"applied":["011_phaseB_two_level_planning.sql"]}`（`pnpm --filter @ai-se/database migrate`）。

**shared 契约**（`packages/shared/src/index.ts`）：`RequirementStatusSchema` + `PLANNING_REVIEW`；`RequirementAnalysisSchema.functionalRequirements`；`SlicePlanItemSchema`（`frKeys ≤ 5`）/`SlicePlanSchema`（含 `milestones`）/`SliceStatusSchema`；`CreateWorkflowSchema.sliceKey`；`Task.sliceKey`；`Approval.{workflowRunId,taskId}` 可选 + `requirementId`；`RequirementSlicesView`。

**agent-core**（`packages/agent-core/src/planning/`）：

- `PlanningGraph.ts`：`PlanningGraphOptions`（`pipeline`/`slice`/`skipStages`/`seedAnalysis`/`sliceFeedback`/`stageTimeoutMs`/`stageRetries`）；`STAGE_EVENTS` + `slice_planning`；`DEFAULT_STAGE_TIMEOUT_MS=150_000` / `DEFAULT_STAGE_RETRIES=1`；`stageWithBudget`（阶段级超时+重试+切片作用域注入）；`slicePlanningWithCoverageRepair`（覆盖不过**自动重做，上限 2 次**；首轮注入关口 1 反馈）；`runLevel1PlanningGraph`（analysis → slice_planning）；level2 变体（START → functional_spec 直入；skipUi 时 `database_spec → task_planning`）；**指令式条件构图**（langgraph 可达性校验要求按变体裁剪节点）。
- `PlanningState.ts`：9 阶段常量 + `PlanningSliceScope` + `PlanningLevel1Result`；`PlanningAgent.ts`：三管道 + `afterSlicePlan` 钩子；`validateSlicePlan.ts`（79 行，确定性覆盖检查：漏 FR / 虚构 FR / 重复 id / 顺序唯一 / dependsOn 合法）；`prompts/slice-planning.prompt.ts`；`ScriptedPlanningModel` 夹具（SLICE-1/2 + FR-001..004）。

**workflow-engine**：`WorkflowEngineOptions.onTerminal`（终态回调，供切片链）；`approve` 需求级守卫（非任务审批不误入任务路径）；`failWorkflow`/`cancel` 触发 `onTerminal`。

**server**：`config.ts`（`PLANNING_MODE=single|two-level` 默认 two-level + 四项预算 150s/1/300s/600s）；`planningService.ts`（两级执行：level1 → analysis 规格 + 切片计划落盘 → `PLANNING_REVIEW` + 关口 1 审批；`handleSliceApprovalDecided`：批准 → 后台规划首片、拒绝 → 重做第一级上限 2 次；`planSlice` 第二级；`handleSliceWorkflowCreated`；`handleWorkflowTerminal` → `advanceSliceChain`（前片 SUCCESS → 规划并启动下一片；失败不自动前进）；`getRequirementSlices`）；`workflowService.ts`（`sliceHooks` + 需求级 approve/reject 分支）；`routes/planning.ts`（`GET /api/requirements/:id/slices`）；`index.ts`（`workflowServiceRef` 闭包解耦 + sliceHooks 装配）。

**控制台**（`apps/web`，最小接线）：`requirementStatusLabel`/`Tone` 增「规划待确认」（warning）；`sliceStatusLabel`/`Tone`；`listRequirementSlices`；store `slices` + `decideSliceApproval`；需求页「切片计划（关口 1）」卡片（切片列表 + 待确认时批准/拒绝+修改意见）。

**评测包**（`packages/eval`）：harness 过关口 1（`PLANNING_REVIEW` → `POST /api/approvals/:id/approve`，计 1 次人工介入）；逐切片执行（首片 harness 启动 → 后续优先链式接管 → 已 `DONE` 切片重跑时 harness 自驱）；跨工作流聚合度量（记录增 `workflowIds`）。

#### N2.2 关键实现决策（与红线核对）

- 关口 1 **复用** approvals（无第二套审批）；切片推进**复用** `WorkflowService.create/start`（不新建调度器）；超时/失败走既有 `TIMEOUT_ERROR`/事件通道（无新错误体系）。
- 第一级产物落盘：analysis 规格（独立版本占位）+ 切片计划（事务整体替换）；第二级仅写 6 类 scoped 规格（不重复写 analysis）——需求总规格数 = 1 + 6×已规划切片。
- 事件（新增，均沿既有通道）：`SLICE_PLANNING_STARTED/COMPLETED/FAILED/PERSISTED`、`SLICE_PLAN_GENERATED/VALIDATION_FAILED/REDO_REQUESTED/REJECTED_FINAL`、`SLICE_STAGE_SKIPPED`、`SLICE_PLAN_READY`、需求级 `approval_requested/approval_approved/approval_rejected`。

#### N2.3 验证证据（命令 + 结果）

| 验证                  | 命令                                                    | 结果                                                                                                        |
| --------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| agent-core 单测       | `pnpm --filter @ai-se/agent-core test`                  | **92/92**（16 文件；含覆盖检查反例必红、level1/level2 图、skip-ui 变体）                                    |
| database 单测         | `pnpm --filter @ai-se/database test`                    | **43/43**（10 文件）                                                                                        |
| workflow-engine 单测  | `pnpm --filter @ai-se/workflow-engine test`             | **28/28**（3 文件）                                                                                         |
| server 单测 + e2e     | `pnpm --filter @ai-se/server test`                      | **96/96**（22 文件；含新 `sliceFlow.e2e`、改造后 `planningApi.e2e`、`v1GoldenScenario` 锁 `mode:"single"`） |
| 全量门禁链            | database + workflow-engine + agent-core + server `test` | **EXIT=0**                                                                                                  |
| 全仓 typecheck / lint | `pnpm -r run typecheck` / `pnpm -r run lint`            | **EXIT=0 / EXIT=0**                                                                                         |
| eval 包               | typecheck / lint / test                                 | ✓ / ✓ / **18/18**                                                                                           |
| web 包                | typecheck / lint / test                                 | ✓ / ✓ / **292/299**（7 红为既有 eyebrow 断言族，见 N2.5）                                                   |
| 格式                  | 改动文件 `prettier --check`                             | 9 文件 `--write` 后全净                                                                                     |
| 开发库迁移            | `pnpm --filter @ai-se/database migrate`                 | `{"applied":["011_phaseB_two_level_planning.sql"]}`                                                         |

关键 e2e 流程（`sliceFlow.e2e`，独立 docker postgres 库）：analyze → 第一级 → `PLANNING_REVIEW` + 待确认审批 → 批准 → 切片 1 `PLANNED`（v2）→ harness 启动切片 1 工作流（带 `sliceKey`+`planningVersion`）→ 平台链式编排自动规划并启动切片 2 → 双切片 `DONE`；两条工作流任务 `sliceKey` 全部正确、链式工作流复用同一 `workspacePath`。

#### N2.4 实施期发现与修复（转记）

1. **pg 数组 → JSONB 序列化**：`replaceSlicePlan` 直接传 JS 数组会被 node-postgres 编成 Postgres array 字面量 → `invalid input syntax for type json`。修复：`JSON.stringify`（与既有对象序列化一致）。首现症状：planningApi e2e「run failed」。
2. **langgraph 可达性校验**：仅按变体改边不够——level2 下 `analyzeRequirement`（及 skipUi 下 `uiSpecNode`）不可达导致 compile 失败。修复：指令式条件构图按变体**增删节点**；`StateGraph` 节点名泛型放宽为 `string`（否则指令式 `addNode` 后类型联合不累积、`addEdge` 拒绝字符串）。
3. **第一级必须落盘 analysis**：第二级种子 `findLatestAnalysis` 依赖规格表；首版 level1 只落切片 → 切片规划直接 `FAILED`（e2e 卡在 `PLANNED` 前）。修复：`persistSlicePlan` 先写 analysis 规格（独立版本占位），切片保存不再重复写。
4. **运行时任务克隆带 `slice_key`**：`insertRuntimeTask`（create/applyReplan）原先未写 `slice_key` → 工作流任务切片归属丢失。修复：克隆随计划任务携带切片归属。
5. **后台 shell 的 corepack 路径坑**：后台任务里 `corepack pnpm` 解析到 `~/.node/corepack`（node v16 环境）报 `pnpm.cjs MODULE_NOT_FOUND`。修复：后台任务一律显式 `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`（与 B-1 环境坑同源，转记 N6 看护）。

#### N2.5 登记项与已知限制

- **web 既有红项（非 N2 引入，登记不修）**：`agentsView`/`dashboardView`/`deploymentsView`/`mcpAppView`/`mcpServersView`/`projectDetailView`/`requirementsView` 共 **7 个用例**断言旧 eyebrow 文案（如「阶段 5」「需求规划」），当前视图不再渲染该文案（`PageHeader` 未传 `eyebrow`）；`agentsView.test.ts` 单独运行即红，与 N2 改动无交集。全套数字：292/299 通过，7 红即此族。留待控制台后续任务处理。
- 控制台工作流表单未加「切片选择」控件（任务书 §N2-7 未列；harness 已携带 `sliceKey`）。
- 重跑语义：两级模式下第 2/3 次运行由 harness 对已 `DONE` 切片逐片重启（等价「同计划重跑」）；平台链式编排仅在存在 `PENDING` 切片时推进（不重跑已完成切片）。
- `single` 旧路径保留总 180s 常量与语义（N1 决策），仅由 `PLANNING_MODE=single` 启用。

#### N2.6 S1 冒烟（single 开关回归，N2 验收项 → **通过**）

- 受控实例：`PORT=47556` + `PLANNING_MODE=single`（独立进程，3000 上的 dev 服务未受影响）；开发库已应用迁移 011。
- 命令：`EVAL_BASE_URL=http://127.0.0.1:47556 pnpm --filter @ai-se/eval start --fixtures S1 --runs 1 --cleanup --out packages/eval/results/smoke/n2-s1-single-smoke.json`
- 结果（`results/smoke/n2-s1-single-smoke.json`，`generatedAt=2026-09-29T14:07:27Z`）：**run 1 自报=成功、oracle=通过（10 断言）、假阳性=否**；任务 SUCCESS×4；token 85,614 / 6,975；耗时 324s；人工介入 0；`failures=[]`。harness 走**单级回退路径**（日志「切片 0」、`workflowIds` 仅 1 条），确认 `single` 开关回归通过。
- 清理：`[eval] S1` 项目已删除（`--cleanup`）；结果留档于 `results/smoke/`（子目录，不参与噪声线对比）。

## B-3 · T6 —— 工作流级预算上限（**已完成**）

#### T6.1 交付清单（按模块）

- **迁移 012**（`packages/database/migrations/012_phaseB_workflow_budget_limits.sql`）：`workflow_runs` 增三列 `max_cost_usd NUMERIC(14,6)` / `max_tokens BIGINT` / `max_wall_clock_ms BIGINT`（均 `CHECK (> 0)`；NULL = 不限制）；`migrate.test` 清单断言 11 → 12。**开发库已应用**：`{"applied":["012_phaseB_workflow_budget_limits.sql"]}`。
- **shared 契约**：`WorkflowPolicySchema`（strict）增可选 `maxCostUsd / maxTokens / maxWallClockMs`（正数；缺省 = 不限制）；新增 `UpdateWorkflowPolicySchema`（PATCH 输入：`null` = 清除、缺省 = 不变、未知键拒绝）。
- **workflow-engine**：`WorkflowStore` 增两个窄读方法 `sumRunUsage`（按工作流聚合 token/成本）与 `findEvents`（既有事件读）；`computeBudgetWallClockMs`（冻结口径：`startedAt → now` 扣 PAUSED 段、未闭合段计至 now、recovery 的 RESUMED 自然忽略）；`WorkflowEngine.enforceBudget`——claim 循环前检查：超限 → 复用既有 PAUSED 边 + `error.code = BUDGET_EXCEEDED`（details 含超限项/limits/usage）+ `WORKFLOW_PAUSED` 事件；任一侧限首次越过 80% → 发一次 `WORKFLOW_BUDGET_WARNING`（以既有事件查询去重）；**未设限零查询、零干预**。
- **database**：`PgWorkflowRepository` — policy 三列读写（`create`/`mapWorkflow`）、`updateWorkflowPolicy`（SQL 层仅 RUNNING/PAUSED）、`sumRunUsage`（`agent_runs` 按 `input->>'workflowRunId'` 聚合；`COUNT(estimated_cost)` 判定成本数据可得性；**不新表**）。
- **server**：`WorkflowService.updatePolicy`（404 / 409 守卫 + policy 合并 helper）；`PATCH /api/workflows/:id/policy` 路由（zod 校验）。
- **控制台**：`api/workflows.updateWorkflowPolicy`；store `updatePolicy`；`WorkflowsView` — 创建表单三个预算输入（可空）、详情「预算」行 + 「调整预算」区（仅 RUNNING/PAUSED 显示；空 = 清除；提示超限暂停后走既有「继续」）。

#### T6.2 关键口径（对齐任务书 §T6 与架构判定 9）

- 检查点在 `advanceOnce` 的 claim 循环**前**；超限复用既有 PAUSED 状态机边与事件通道（无第二套暂停/错误体系；`BUDGET_EXCEEDED` 为工作流 error 码，任务书指定）。
- 恢复 = `PATCH policy`（仅 RUNNING/PAUSED）→ 既有 `resume`；已完成任务不重跑（claim 只取 PENDING/RETRYING，e2e 以执行次数断言）。
- wallClock 口径：`startedAt → now` 扣 PAUSED 段（PAUSED/RESUMED 事件对；未闭合段计至 now）。
- `maxCostUsd` 仅在存在成本数据时参与判定（平台未回填 `estimated_cost` 时按 token/时间执行，不写「零成本」）。
- `maxTokens` 口径 = `input + output` 合计。
- 80% 告警「事件 + 日志」：引擎无独立 logger 注入点，告警以**既有事件通道**留痕（`WORKFLOW_BUDGET_WARNING`，事件时间线可见、查询去重）。

#### T6.3 验证证据（命令 + 结果）

| 验证                  | 命令                                        | 结果                                                                                                                                                 |
| --------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared 单测           | `pnpm --filter @ai-se/shared test`          | **50/50**（+2：策略/补丁 schema）                                                                                                                    |
| workflow-engine 单测  | `pnpm --filter @ai-se/workflow-engine test` | **35/35**（+7：wallClock 口径 ×2、超限暂停、80% 一次告警、成本数据门、未设限零查询、放宽恢复不重跑）                                                 |
| database 单测         | `pnpm --filter @ai-se/database test`        | **43/43**（迁移 012 断言：12 个文件、末位 012）                                                                                                      |
| server 单测 + e2e     | `pnpm --filter @ai-se/server test`          | **97/97**（23 文件；新 `budgetApi.e2e`：极小 wallClock → BUDGET_EXCEEDED 暂停 → PATCH 放宽 → resume → SUCCESS 且任务不重跑；终态 409；未设限零干预） |
| web 包                | typecheck / lint / test                     | ✓ / ✓ / **293/300**（7 红为既有 eyebrow 断言族，见 N2.5）                                                                                            |
| 全仓 typecheck / lint | `pnpm -r run typecheck` / `lint`            | **EXIT=0 / EXIT=0**                                                                                                                                  |
| 格式                  | 改动文件 `prettier --check`                 | 4 文件 `--write` 后全净                                                                                                                              |
| 开发库迁移            | `pnpm --filter @ai-se/database migrate`     | `{"applied":["012_phaseB_workflow_budget_limits.sql"]}`                                                                                              |

#### T6.4 登记与限制

- 预算调整入口仅 RUNNING/PAUSED 可见（与 PATCH 守卫一致）；PENDING 工作流在创建时设定预算。
- `WORKFLOW_BUDGET_WARNING` 的「日志」以既有事件通道留痕（见 T6.2）。
- 超限暂停后未调整预算直接 resume：下一周期检查会再次暂停（自然行为，不额外防护）。

## B-4 · 阶段 B 出口验证（**已完成**）

#### B-4.0 授权与启动（2026-09-30）

- **预估（跑前已给，用户授权）**：第一批（全量两遍 = 48 runs）典型 **8–12 小时**、输入约 **6–8M tokens**；M/L 为**首次执行段运行**（P0 无样本），时长按任务图规模外推。授权结果：**连跑两遍（按任务书）**。
- **启动方式**：平台 3000（新代码 two-level，已核 `slices` 路由 400 判别）；`caffeinate -i` 防休眠；两遍背靠背（第二遍尾带 `--cleanup`）；日志 `/tmp/b4-pass12.log`；结果自动落 `packages/eval/results/`（两文件 + 噪声线）。
- **夹具执行顺序**（CLI 按目录名排序）：L1 → L2 → M1 → M2 → M3 → S1 → S2 → S3，各 ×3。
- **运行期纪律**：批次运行期间**不做任何构建/重编**（避免 tsx watch 重启打断在跑工作流）；只读观测（日志/API）。
- **首个观测**：L1 真实模型规划完成 → `PLANNING_REVIEW` → **harness 自动批准关口 1**（首个真实关口 1 样本）；随后进入切片链执行。
- 第二批（E1 ×3）预估与授权：**待第一批结束后另行给出**（逐批授权）。

#### B-4.0a 中断事故与重启（2026-09-30）

- **中断**：**09:21:16** harness 进程被 SIGTERM 终止（Hermes 记录 `exit_code=-15`、`completion_reason="killed"`、`termination_source="agent_close"`；`agent.log` 同秒有 `agent_close` 生命周期事件）。**根因：启动命令未加 `persist_on_release=true`**——该模式下长任务会被 Hermes 例行生命周期事件回收（教训：长任务必须显式持久化；重启命令已修复）。
- **服务器侧余波**：harness 死后，服务器侧切片链仍自行完成 L2 run1 全部 4 切片——`persistence-core` / `app-persistence-integration` / `new-api-endpoints` **SUCCESS**、末片 `quality-gates` **FAILED**（2/8）→ 链终止（无第二遍）。
- **已完成观察（中断批次，不计入正式样本）**：L1 3/3 runs 真实失败（~9–11min/run，切片 1 内 6/8 任务，oracle 同步不通过）；L2 run1 链 78min（3/4 切片成功、末片失败）。M/S 未开始。
- **留证**：`packages/eval/results/salvage/20260930-interrupted/`（L1 run-1..3 + L2 run-1 工作区、`batch.log`、工作流/切片快照 JSON、README）。
- **实测时长修正**：L2 单 run（4 切片）≈ **78min**；L1 失败 run ≈10min。**两遍实际预计 ~15–25h**（M 档无样本、不确定性大）——已向用户更新，重启方案与遍数待确认。
- **重启要件（已定位）**：`persist_on_release=true` + 完成通知；可选受控实例（非 watch）以解耦后续构建；加看门狗（进程消失即通知）。

#### B-4.0b 重启执行（2026-09-30，用户授权）

- **用户决策**：① 受控实例 **47557** 重启（非 watch；解耦 C 阶段构建）；② **先全量一遍**（S1,S2,S3,M1,M2,M3,L1,L2 ×3 = 24 runs），看数据再定第二遍。
- **受控实例**：`PORT=47557 PLANNING_MODE=two-level corepack pnpm --filter @ai-se/server exec tsx src/index.ts`（**非 watch**；`persist_on_release=true`）；日志 `/tmp/b4-server-47557.log`；就绪核验 health=200、`slices(not-a-uuid)=400`（新代码）✓。进程 `proc_6f429a16f617`。
- **批次**：11:06:1x 启动；`EVAL_BASE_URL=http://127.0.0.1:47557` + `caffeinate -i` + **`persist_on_release=true`** + 完成通知；**不带 `--cleanup`**（保留数据供第二遍决策与复查）；日志 `/tmp/b4-relaunch-pass1.log`。进程 `proc_1cd6fa25a0bb`。
- **看门狗**：独立后台（`persist_on_release=true` + 通知）——批次进程消失即通知，并判别正常结束（`PASS1_EXIT`）或异常终止。进程 `proc_ef300d983ff1`。
- **复用行为（重要）**：`ensurePlanning` 幂等——L1/L2 复用中断批次的既有需求与已批准计划（v2），直接进入执行；M/S 无既有需求将新建+规划。复跑语义已核对：**每个 run 按切片顺序完整重跑全部切片**（DONE 切片由 harness 自驱重启；后续切片链式接管优先）。

#### B-4.0c 重跑缺陷（B-4 暴露）与处置（2026-09-30 12:15）

- **缺陷 1（平台侧，`planningService.ts`）**：`handleSliceWorkflowCreated` 仅在切片状态 = `PLANNED` 时登记新工作流 → 重跑（复用既有需求）的 `FAILED`/`DONE` 切片不登记 → 切片行仍指向旧工作流 → `advanceSliceChain` 的 `findSliceByWorkflowRunId` 匹配失败 → **链不推进**。实况：L1 run2 切片 1 成功（`1e29f3bf`）但切片 2（`build-module`，PENDING）未被启动 → 30min 等待超时判失败；run3（`24a07bb8`）同型。
- **缺陷 2（harness 侧，`ensureSliceStarted`）**：上一轮遗留的 `FAILED` 切片被直接抛错（重跑场景应为可重启）→ L2 的 3 次 run 预计在第 4 片（`quality-gates`，旧链 FAILED）失败。
- **影响范围（17:00 修正，实测扩大）**：不止 L1/L2——**凡「切片重跑需要服务器链推进」的场景都受影响**：L1 run2/3、L2 run1（末片 `quality-gates` FAILED 直接抛错）、**M1 run2/3、M2 run2/3**（首片重跑成功后第二片 PENDING 未被链式启动）——共 **7 个 run**；M3 与 S1 未受影响（其切片状态为 DONE，走 harness 自驱路径 ✓）。**补跑范围相应扩大为 L1、L2、M1、M2**。
- **同期真实结果（非缺陷，供 §B-4 汇总）**：L2 run2/run3 与 M3 run2 出现**假阴性**（链在中间切片失败、自报=失败，但 oracle 全部断言通过——交付物实际完整）；迄今**无假阳性**（所有"假阳性=否"）。
- **用户决策（12:2x）**：**批次继续**（L1/L2 按缺陷如实记录；M/S 正常跑）；**之后修复 + 补跑 L1/L2**。
- **修复方案（待批次结束后应用）**：
  - 平台侧：`handleSliceWorkflowCreated` 登记条件 `status === "PLANNED"` → `status !== "RUNNING"`；补 e2e：重跑切片成功后链推进断言（扩 `sliceFlow.e2e`）。
  - harness 侧：run 开始时快照切片状态；`ensureSliceStarted` 对「上一轮遗留 FAILED」返回 `workflowId=null`（自驱重启），本轮链中途转 FAILED 仍抛错；补单测。
  - 应用顺序：批次结束 → 修复 + 全仓门禁（构建自由）→ 重启 47557（新代码）→ **补跑 L1,L2**（同参数：`EVAL_BASE_URL=47557`、persist、看门狗、不带 cleanup）。

#### B-4.0d 修复应用（2026-09-30 20:3x，批次结束后）

- **平台侧已修**：`planningService.handleSliceWorkflowCreated` → 登记条件改为 `slice.status !== "RUNNING"`（重跑登记）；回归 e2e：`sliceFlow.e2e` 追加「切片 2 复位 PENDING → 切片 1 重跑 → 登记 + 链推进」断言，**通过**。
- **harness 侧已修**：`ensureSliceStarted` 新增 `preRunFailed` 快照参数（上一轮遗留 FAILED → 自驱重启；本轮中途转 FAILED → 仍抛错）；新增单测 `__tests__/harness.test.ts` ×4，**通过**（eval 22/22）。
- **门禁**：agent-core（含 docker e2e）+ server 全量 + 全仓 typecheck/lint 见 /tmp/closeout-gates.log；prettier 已净。
- **补跑范围**：用户授权 **L1,L2,M1,M2 ×3 + E1 ×3** 一并执行（text 模式，与第一遍行为一致）。

#### B-4.0e 收尾批次事故：合盖睡眠毒化（2026-10-01 凌晨）

- **事实**：收尾批次 21:31 启动（补跑 `L1,L2,M1,M2 ×3` + `E1 ×3`），02:53 结束（exit 0）。**21:59:46 机器进入 Clamshell Sleep（合盖）**，此后整夜为「睡眠 + 每 ~15 分钟 10–220s DarkWake」循环；`pmset` 日志可证。
- **影响判定（按机器清醒期切分）**：
  - **21:31–21:59（清醒）：L1 ×3 = 有效数据**——3 个 run 全部真实失败，失败点在任务层：T7（run1/3）/ T6（run2）`TEST` 任务 FAILED（而其 agent_run 显示 succeeded——任务层验收未过）。任务 output 实录原因：① 沙箱无 `pnpm`（`sh: pnpm: not found`，agent 改用 npm 兜底）；② T6 报 `Path is not writable`（对 `/test/render.test.mjs`、`/tmp/render.test.mjs` 的写入被拒）；③ `buildSite` stub 未实现导致验收红（疑夹具内设计）。
  - **22:00 后（睡眠）：L2/M1/M2 全部毒化**——`TIMEOUT_ERROR`（600s 墙钟，×18）、`fetch failed`（harness 轮询）；E1 规划 `Planning run cancelled`（02:03）。**此段数据无效，需重跑**。
  - 全程：**假阳性 0**；无遗留 RUNNING agent_run。
- **修复有效性确认**：修复后 L1 的 3 个 run 均能走完整切片链（此前会卡死）——B-4 两处缺陷修复有效 ✓。
- **重跑计划**：`L1,L2,M1,M2 ×3` + `E1 ×3`；机器保持清醒（开盖）+ `caffeinate -s -d -i` + 批后睡眠事件核对；期间不合盖。

#### B-4.0f 附录：L1 三个新发现诊断（2026-10-01 上午，只读排查）

> 方法：只读（源码 + 开发库 + 47557 日志 + 实时工作流），未打扰运行中的批次。结论均落到代码/证据。

**发现 1：沙箱无 `pnpm` —— 平台默认命令与镜像能力不一致**
- 机制：沙箱 = **每条命令一个 `docker run --rm` 容器**，默认镜像 `node:22-bookworm`（`packages/sandbox/src/index.ts`），仅挂载工作区、`--network none`；该镜像有 node+npm、**无 pnpm**。
- 而 `run_unit_test / run_lint / run_build` 的**默认命令是 `pnpm test / pnpm lint / pnpm build`**（`packages/tool-runtime/src/tools/commandTools.ts`）→ 默认调用在沙箱内必然 127（`sh: pnpm: not found`；本日志 49 次）。夹具要求文本同样写 `pnpm test/build/lint`。
- Agent 用**命令覆盖**（`npm test` 等）兜底成功。判定：**平台侧一致性问题**；修复方向（批次后定）：镜像加 corepack/pnpm、或默认命令改为镜像实际能力、或夹具文本中立化（三选一，需走任务书）。

**发现 2：`Path is not writable` = 写权限模型 + 计划分派错位（非沙箱缺陷）**
- 机制：harness 内置 `write_file/edit_file` → `ToolRuntimeBackend.write/edit`（`agent-core/.../ToolRuntimeBackend.ts`）→ 按 **Agent 定义 `permissions.writePaths` 前缀白名单**校验，不匹配即拒。
- 关键事实：① `qa-agent / reviewer-agent / planner-agent` 的 `writePaths: []`（只读）；② 其余 Agent 的 writePaths 为**仓库形状**（`apps/server`、`apps/web`、`packages/database`、`infrastructure`），**与 L1 通用工作区（`src/`、`test/`）全不匹配**——即该工作区内 `write_file/edit_file` 对全部职业 Agent 不可用。
- 实际写文件走**另一条通道**：`run_unit_test` 等工具接受**可选 `command` 覆盖**（仅封禁 curl/wget/ssh/scp/docker/kubectl/nc/telnet）→ Agent 用 `cat > … <<'EOF'`、`node -e` 等 **shell 写入**（实时日志可证，如 `cat > /tmp/t4.mjs <<'EOF'`）；沙箱把命令关在工作区容器内。
- 因此 T6（run2）失败链 = 计划把**写任务分派给只读的 qa-agent** + 该次 Agent 未改用 shell 写入（run1 与今日同任务均以 shell 成功）→ FAILED。判定：**计划分派质量 + 权限模型表达不一致**（writePaths 名义存在、被 shell 通道绕过）。修复方向（批次后定）：分派规则避免「写任务→只读 Agent」；明确 shell 写通道的正式语义（保留=按能力测量 or 收紧）。

**发现 3：`buildSite` stub 未实现 → T7 验收必红（计划-验证耦合）**
- 夹具设计：模板自带 `src/build.mjs`（抛「buildSite 尚未实现」）+ `test/build.test.mjs`（对应红测）；要求文本「完成后 pnpm test 必须全部通过」。
- 计划：切片 1 `render-module` → 切片 2 `build-module`（顺序）。切片 1 内 T7 =「运行完整测试、lint 与构建验证」（qa-agent，编辑范围仅 `src/render.mjs`）——**在 build-module 完成前全量测试必然红**（build.test.mjs 依赖 buildSite）。
- 结果：T7 FAILED（Agent 如实报告：唯一红测来自范围外的 build.mjs stub）→ 链停 → 切片 FAILED → run 失败 → oracle 不通过；pass-1 与本次三次 run 复现一致。
- 判定：**平台把「全量验证」放进无法满足的切片**（验证未按切片范围收敛、未感知跨切片依赖）——C 阶段（验收/验证）同类问题的高价值样本。

#### B-4.0g 收尾批次（第二次）事故：E1 段被显式停止（2026-10-01 18:48）

- **事实**：批次 `proc_292f1e7cd7c9` 于 08:41 启动；**补跑段（L1,L2,M1,M2 ×3）14:56 完成、数据有效**（结果 `2026-10-01T06-55-50-089Z.json`：真成功率 58.3%、自报 16.7%、假阳性 1 例 8.3%、降级率 76.7%）。E1 段 run1 进行中，**18:48:40 被显式停止**（Hermes 日志：`Escalated to SIGKILL …` + `Interrupt requested (hard): explicit stop requested`；批次 + 看门狗 + 睡眠守卫三个 persist 进程全部被 kill，`termination_source=process.kill`）——操作者待确认。
- **中断点状态**：E1 run1 链：s1 DONE（16:44）→ s2 DONE（17:47）→ s3 RUNNING（17:49 起，9/12 任务 SUCCESS）→ s4 PENDING；平台侧 47557 存活，链会自主继续（无 harness 驱动 → 无 oracle 判定、无结果记录，**run1 不计为有效 run**）。run-1 工作区完整（Dockerfile/src/test 等），可留证。
- **校准**：E1 单 run 实测 ≈ **4–5h**（s1 1h45m + s2 1h03m + s3 …）→ E1 ×3 ≈ **12–15h**（此前估 5–8h 偏低）。
- **睡眠核对**：本次批次全程**零睡眠事件**（`caffeinate -s -d -i` 生效；睡眠守卫确认「未检测到新增睡眠事件」）——与上夜合盖事故形成对照。
- **恢复计划**：待 s3/s4 自主跑完（避免与新 harness 争同一需求）→ **E1 ×3 重跑**（DONE/FAILED 切片由修复后的 harness 自驱重启）；重启时机待用户确认。
- **周一形态定案（10-01 晚，用户批准）**：**拆分版 ×3**——3 个单-run 调用（`--fixtures E1 --runs 1 --out results/e1-baseline/run-N.json`），每 run 独立落盘/通知；**预算护栏**（每 run 前查本周 token 总量，≥20M 自动停；批前同查）；run 间 **30 分钟冷却**；`caffeinate -s -d -i` + persist + 看门狗。脚本：`packages/eval/scripts/e1-baseline-split.sh`。口径维持 **×3**（理由：E1 方差最大、C-6 比「率」、与 S/M/L 协议一致；备选 ×2/跨周已记录）。harness 零改动（保持与 B 基线同版本量具）。**等待期（至周一）不开发**（用户指示：不开工 N3）。

#### B-4.0h 配额约束与排期（2026-10-01 晚）

- **网关限额（OpenCode Go，按美元）**：5h $12 / **周 $30** / 月 $60；无公开查询 API（console: opencode.ai/workspace）。命中即静默阻断——**批次撞墙会毒化数据**。
- **实测校准**：本窗（09-28 起）已烧 17.9M in / 1.25M out（808 runs）→ 周预算 ≈ **24M in 等效**；**E1 单 run ≈ 4.3M in / 0.13M out（≈4–5h）→ E1 ×3 ≈ 13M ≈ 半个周预算**（L/M 单 run ≈ 0.46M）。
- **排期规则**：① 一周最多一个 E1 ×3 批次；② 批次前 console 快照 + 预估；③ run 间检查点（周余量 <30% 喊停）；④ 逐批授权。
- **本周**（余 25% ≈ 6M，10-05 周一 ~07:00 重置）：不跑评测；做 C-1…C-5 开发。
- **10-05 重置后**：E1 ×3 重跑（B-4 收尾基线）；**C-6 的 E1 ×3** 排再下一个周窗口。
- 注：E1 run1（被停）计 3.82M in，作废但作校准用；s4 已 FAILED、链已停，无持续消耗。

#### B-4.0i E1 基线执行结果（2026-10-05 夜 → 10-06 凌晨，拆分 ×3 前两跑）

- **时间线**：run 1 `20:25:32 → 00:31:29`（4h06m）→ 冷却 30min → run 2 `01:01:29 → 02:43:21`（1h42m）→ 哨兵 02:44:11 按用户规则停止（**未启动 run 3**）✓。
- **run 1（`results/e1-baseline/run-1.json`）= E1 首个通过样本**：**oracle 100% 通过**；真成功率 100%、自报 0%（**假阴性**）、假阳性 0；60 任务 56 SUCCESS / 1 FAILED / 3 PENDING（链停在失败任务，交付物仍过 oracle）；降级率 79.4%（50/63）；输入 3.59M / 输出 0.115M；TIMEOUT×5。
- **run 2（`run-2.json`）= 失败样本**：oracle 不通过；链停在切片 1 内（21 任务 18 SUCCESS / 1 FAILED / 2 PENDING）；1h42m；输入 1.17M / 输出 0.04M；TIMEOUT×4。
- **基线进度**：2/3 样本（1 通过 / 1 失败）；**run 3 待跑**（另一晚，预算剩余充足：本周已耗 ≈4.8M / ~24M 等效）。
- **执行保障复盘**：拆分（每 run 独立落盘）+ 预算护栏 + 哨兵（gate 06:55 / cutoff 07:20）全部按设计工作；全程零睡眠事件；两 run 详情待 3 样本齐后一并汇入 §B-4 汇总。
- **run 3 首次尝试（10-06 19:41）**：被我方截止哨兵的**跨日计算 bug**误杀（`end=2026-10-06 07:20` 已过 → 立即 kill）。处置：守卫日志留证（`RUN3_CUTOFF_KILL 19:42:18`）→ 取消其工作流 `aaa16381`（平台自动置 `s1=FAILED`，无需手工 SQL）→ 修 bug（未来时刻 +86400 滚动）后 19:5x 重启 run 3。**教训：脚本中的「未来时刻」必须做 +86400 滚动；已记技能。**
- **run 3 完成（10-06 19:44→20:55，1h11m）= 失败样本**：链停在切片 1（S1-T12「Bearer 鉴权中间件」agent 超时 600s×2 → FAILED → 链停）；oracle Must 0/29；输入 0.87M / 输出 0.035M；TIMEOUT×3。
- **E1 ×3 基线终数（10-05/06 夜）**：**真成功率 1/3 = 33.3%**（仅 run 1 通过）｜**假阳性 0/3**｜自报 0/3（含 run 1 假阴性 1 例）｜三 run tokens 合计 ≈ 5.63M 输入 / 0.19M 输出（4h06m + 1h42m + 1h11m）。**失败机制**：run 2（S1-T19 构建自检）、run 3（S1-T12 鉴权中间件）均为**单任务 agent 600s 超时×2 → 链停 → 交付物不完整**；run 1 的 s4 亦有 1 任务失败（8/12 后停）但交付物仍全过 oracle。**基线采集完成 ✓**

## B-4 结果汇总（终稿：两批 + 修复补跑 + E1 ×3 基线）

> 结果文件：① 第一遍 `packages/eval/results/2026-09-30T12-17-53-138Z.json`（17 有效 run；7 run 缺陷隔离，见 §B-4.0c）；② 修复补跑 `2026-10-01T06-55-50-089Z.json`（L1/L2/M1/M2 ×3 = 12 runs）；③ E1 基线 `results/e1-baseline/run-{1,2,3}.json`（拆分 ×3，见 §B-4.0i）。平台 = 受控实例 47557（two-level）；全过程事故与处置见 §B-4.0a/0e/0g/0i。

### 汇总 A：第一遍（2026-09-30，缺陷暴露前）

- 规划成功率 **8/8 夹具**（P0 曾有 6 次 TIMEOUT 规划失败——B 段主目标达成）。
- 真成功率 70.6%（12/17）｜自报 52.9%｜**假阳性 0/17**｜假阴性 3（L2×2、M3×1）。
- 降级率 76.1%（124/163）；tokens 3,066,373 / 366,163；时长 3.20h。
- 7 run 因切片链缺陷隔离（L1 run2/3、L2 run1、M1 run2/3、M2 run2/3）→ 修复后补跑。

### 汇总 B：修复补跑（2026-10-01，两处缺陷修复后）

- 12/12 runs 有效：真成功率 **58.3%**（7/12）｜自报 16.7%｜**假阳性 1 例（8.3%）**｜降级率 76.7%；tokens 5,460,985 / 404,579；TIMEOUT×8。
- 分档：M 6 runs 50.0%（假阳性 16.7% = 1/6）；L 6 runs 66.7%（假阳性 0）。
- **修复有效性**：L1 ×3 均走完整切片链（修复前必卡死）——平台侧 + harness 侧修复验证通过。

### 汇总 C：E1 ×3 改前基线（2026-10-05/06，拆分 ×3）

| run | 结果 | 时长 | tokens(入/出) | 停点 |
| --- | --- | --- | --- | --- |
| 1 | ✅ 通过（oracle 100%；假阴性 1 例） | 4h06m | 3.59M / 0.115M | s4 有 1 任务失败、交付物仍全过 oracle |
| 2 | ❌ 失败 | 1h42m | 1.17M / 0.04M | s1：S1-T19 超时×2 |
| 3 | ❌ 失败 | 1h11m | 0.87M / 0.035M | s1：S1-T12 超时×2 |

- **口径**：真成功率 **1/3 = 33.3%**｜**假阳性 0/3**｜自报 0/3（含假阴性 1 例）；tokens ≈ 5.63M 入 / 0.19M 出。
- 失败机制：**单任务 agent 600s 超时×2 → 链停 → 交付物不完整**（run2/3）——局部失败放大为整体失败 = C 段（验证/恢复/红灯）的直接动机。

### 跨批口径与对比基准（冻结）

- S/M/L 规范样本 = 第一遍（S×9、M3×3）∪ 补跑（L1/L2/M1/M2 ×3）；第一遍的缺陷 run 隔离不计入。
- **C 段改前基线（C-6 对比基准）**：E1 真成功率 33.3% / 假阳性 0% / 降级率 ~79% / E1 tokens 5.63M÷3 runs；S/M/L 见汇总 A+B。
- 各批噪声线仅在各 summary 内存档；跨批对比以 C-6（同 harness/夹具版本）为准。

## 阶段 B 完成报告（收尾，2026-10-06）

> 对应任务书 `docs/114` §完成后；实施窗口 2026-09-29 → 2026-10-06。**状态：已完成；STOP（不进入阶段 C）。**

### 1. 交付总览

| 项 | 任务书要求 | 结果 |
| --- | --- | --- |
| N0 | E1 夹具（PRD 30 AC / 隐藏 oracle / 参考实现 / 5–6 变异 / 自检 / 评测包最小集成） | ✓ 完成（自检 PASS、变异 6/6 全检出） |
| N1 | 180s 决策记录（不写代码） | ✓ 完成（先落笔：分阶段预算 + 两级化；见 §B-2 N1） |
| N2 | 两级规划 + 分阶段预算 + 旧路径开关 | ✓ 完成（规划不再 TIMEOUT：B-4 规划成功率 8/8 夹具；迁移 011） |
| T6 | 工作流级预算上限（maxCostUsd / maxTokens / maxWallClockMs） | ✓ 完成（迁移 012；引擎 enforce + PATCH + 控制台） |
| B-4 | 全量两遍（噪声线）+ E1 ×3 改前基线 | ✓ 完成（第一遍 17 有效 run；修复补跑 12；E1 ×3 = 1 通过/2 失败；噪声线按批存档） |

### 2. 变更文件清单（按模块；时间戳 = 实施日期）

- **database**（09-29）：`migrations/011_phaseB_two_level_planning.sql`、`migrations/012_phaseB_workflow_budget_limits.sql`、`migrate.test.ts`（清单断言 10→11→12）。
- **shared**（09-29）：`src/index.ts` —— `PLANNING_REVIEW`、`SlicePlanItem/SlicePlan/SliceStatus`、`Task.sliceKey`、`CreateWorkflowSchema.sliceKey`、`WorkflowPolicySchema` 预算三字段、`UpdateWorkflowPolicySchema`、`RequirementSlicesView`、`Approval` 需求级字段。
- **agent-core**（09-29）：`src/planning/{PlanningGraph,PlanningState,PlanningAgent,validateSlicePlan,ScriptedPlanningModel}.ts`、`src/planning/prompts/slice-planning.prompt.ts`、`src/index.ts` + 对应测试（覆盖检查反例、level1/level2、skip-ui 变体）。
- **workflow-engine**（09-29）：`WorkflowEngine`（onTerminal / 需求级 approve 守卫 / failWorkflow·cancel 联动 / enforceBudget / computeBudgetWallClockMs）、`WorkflowStore` 窄读接口（sumRunUsage / findEvents）+ 测试。
- **server**（09-29；B-4 修复 10-01）：`config.ts`（PLANNING_MODE + 四项预算）、`services/planningService.ts`（两级 + 切片链 + 重跑登记条件）、`services/workflowService.ts`（sliceHooks、updatePolicy）、`routes/planning.ts`（GET slices）、`routes/workflows.ts`（PATCH policy）、`index.ts`（装配）；测试 `sliceFlow.e2e`（含重跑回归）、`planningApi.e2e`、`budgetApi.e2e`、`v1GoldenScenario.e2e`。
- **web**（09-29）：需求页「切片计划（关口 1）」卡片（切片列表 / 批准·拒绝）、store 接线（slices / decideSliceApproval / updatePolicy）、工作流页预算表单与「调整预算」区、`api` 封装 + 相关测试。
- **eval**（09-29；修复 10-01；脚本 10-05）：`src/{types,cli,metrics,harness}.ts`、`src/__tests__/{fixtures,harness}.test.ts`、`fixtures/E1/**`（prd.md / oracle.mjs / reference 977 行 / mutants×6 / selfcheck.mjs / ac-map.md / template / fixture.json）、`scripts/e1-baseline-split.sh`（45 行纯 ASCII）。
- （精确到文件的明细以 §B-1.1、§B-1.6、§B-2.1、§T6.1 各节为准。）

### 3. N0/N1/N2/T6 逐项结果与证据锚点

| 项 | 结果 | 证据锚点（命令 / 退出码 / ID / 路径） |
| --- | --- | --- |
| N0 | 自检 PASS；变异 6/6；六步构建全过 | `node selfcheck.mjs` → `pass=true`（`selfcheck-results.json`，`2026-09-29T12:54:11Z`；一致性 30/30、参考 29/29）；六步逐命令 exit 0（§B-1.1 表；commit 9c73688）；探针镜像 `sha256:495e4647…` |
| N1 | 决策 = 分阶段预算（150s/1/300s/600s）+ 两级化 + 旧路径保留 | §B-2 N1（依据 `docs/110` §7.1：6 次失败全为 `TIMEOUT_ERROR`、慢阶段 89–120s、同需求成败不稳） |
| N2 | 迁移 011 已应用；S1 冒烟通过；双切片 e2e 通过 | `migrate` → `{"applied":["011_…"]}`；`results/smoke/n2-s1-single-smoke.json`（自报成功 / oracle 通过 / 假阳性否；单级回退路径）；`sliceFlow.e2e`：PLANNING_REVIEW → 批准 → 切片 1/2 DONE（链式复用同一 workspacePath） |
| T6 | 迁移 012 已应用；超限暂停→放宽→恢复不重跑 e2e 通过 | `migrate` → `{"applied":["012_…"]}`；`budgetApi.e2e`：极小 wallClock → `BUDGET_EXCEEDED` 暂停 → `PATCH /api/workflows/:id/policy` 放宽 → resume → SUCCESS（执行次数断言不重跑）；终态 409 |
| B-4 | 见 §4 | 结果文件：`2026-09-30T12-17-53-138Z.json`、`2026-10-01T06-55-50-089Z.json`、`results/e1-baseline/run-{1,2,3}.json` |

### 4. B-4 两批运行结果

- 【第一遍】2026-09-30：8 夹具 ×3 = 24 runs，其中 **17 有效**（7 因切片链缺陷隔离，见 §B-4.0c）；真成功率 70.6%、假阳性 0、假阴性 3；降级率 76.1%；3.07M/0.37M tokens。
- 【第二批 = 修复补跑 + E1 ×3】：
  - 补跑（10-01，L1/L2/M1/M2 ×3）：12/12 有效；真成功率 58.3%、假阳性 1 例、降级率 76.7%；5.46M/0.40M。
  - E1 ×3 改前基线（10-05/06，拆分 ×3）：**1 通过 / 2 失败（真成功率 33.3%、假阳性 0）**；5.63M/0.19M；失败机制 = 单任务 600s 超时 ×2 → 链停（S1-T19 / S1-T12）。
- 汇总与对比基准见「B-4 结果汇总（终稿）」；噪声线按批存档（两批夹具集不同，不可跨批比较——如实记录）。

### 5. 门禁数字（2026-10-06 收尾复核）

- 全仓 **lint EXIT=0**；全仓 **typecheck EXIT=0**（串行复核；并行首跑遇 `shared` 构建竞态 `TS2306`，属环境竞态非代码问题——单包确定性复核 agent-core EXIT=0 + 串行全仓 EXIT=0 双证）。
- 单测（15 包，2026-10-06 复核）：shared 50/50、observability 2/2、database 43/43、workflow-engine 35/35、**agent-core 100/100**（含 docker e2e）、tool-runtime 12/12、sandbox 2/2、mcp 235/235、browser 38/38、evidence 9/9、failure-recovery 16/16、action-policy 13/13、visual 83/83、eval 22/22、**server 97/97**（首跑遇并发资源竞争 2 文件红，独立复跑 97/97 全绿）；**web 316/321（5 红 = 既有 eyebrow 断言族，非 B 引入，登记不修）**。
- 开发库迁移 011 + 012 已应用；`[eval]` 数据按规范保留。

### 6. docs/110 补写点

- 已补：§6 顶部指针（全量基线已在 B-4 完成；E1 ×3 已完成 —— 2026-10-06 更新）。
- 说明：§6.2「L1 三次样本不计入（夹具缺陷）」——B-4 已修正后补跑（见汇总 B）；§7.1/§7.2 的 T5/T6 建议已由 N1/N2 落地（决策见 §B-2 N1）。docs/110 其余保留 P0 原貌。

### 7. 未完成事项与偏差（如实记录）

- **偏差（事故，均已处置留证）**：① 切片链缺陷 → 7 run 隔离 + 修复 + 补跑（§B-4.0c/0d）；② 合盖睡眠毒化 1 段（§B-4.0e）；③ 配额停止 1 次 + E1 单 run 超预估 → 拆分 ×3 + 冷却（§B-4.0g/0h）；④ run 3 首启被我方哨兵跨日 bug 误杀（§B-4.0i）。
- **未完成（转 C 段）**：C-1 的 server 侧接线（agent-core 核心已完成）；L1 三发现的修复方向（§B-4.0f）；E1 失败机制（超时放大 → 链停）作为 C 段样本。
- **缓办（既有、非 B）**：web 5 红（eyebrow 族）；孤儿 PENDING 任务（无害；最近盘点 305，C 段收口时再点）。
- **口径如实**：任务书要求的「两遍噪声线」因两批夹具集不同改为按批存档（不可跨批比较）；跨批对比以 C-6（同版本量具）为准。

### 8. STOP

阶段 B 全部完成、出口基线冻结（S/M/L 全量 + E1 ×3）。**不进入阶段 C**——等待用户指令。
