# 131 · 阶段 G 实施记录

> 任务书：`docs/130`（v2 开工基线；默认裁决见其 §9，可撤销）。本记录自 G1 起逐项累积；每项含：动作 / 证据 / 结论 / 遗留。末行按 PASS / PASS-PARTIAL / BLOCKED。
> 探针目录（不进仓库）：`~/.hermes/cache/scratch/g1/`。

## G1 · VACUOUS_TEST 判定精化

### G1-A 离线复现与修复方向验证（2026-10-14）✅ PASS

**方法**：只读复现——忠实复刻 `resolveCheckOutcome` 红灯分支判定（`canonicalAcKey` / `taskCoversAc` 语义照抄；保守口径：任务级合并 `acResults`）。数据来源：`tasks` + `workflow_events`（TASK_VERIFICATION）+ 工作区 `ai-se-eval/E1/run-1`；运行时任务集 = `input.requirementId` 过滤（**707 任务**，含跨批次历史）。

**复现结果（当前行为 = 同工作流 + 时间过滤）**：

| 案例 | parsed 键 | 检查时刻同工作流 dev 证据 | 缺覆盖 | 复现判定 | 实际事件对照 |
| --- | --- | --- | --- | --- | --- |
| a `9626ef98`（run2 slice-3 集成验证） | 20（AC-01..18,23,30） | 4（slice-3 实现任务） | 14（AC-01..13,AC-30） | VACUOUS ✓ | acChecked=20 / VACUOUS_TEST（18:09:54）✓ |
| b `51e20dc2`（run3 slice-2 重跑认证测试） | 17（AC-01..13,19,20,27,28） | **0**（兄弟 BACKEND `a18fd73f` 19:22:28 完成，晚于检查 19:15:54；`0aeb6255` 非 SUCCESS） | 17 | VACUOUS ✓ | acChecked=17 / VACUOUS_TEST（19:15:54）✓ |
| c `47d7c85d`（run3 slice-4 PATCH 测试） | 11（AC-01..08,19,20,27,28） | 1（`1c22eccc`，覆盖 AC-20/27/28） | 8（AC-01..08,AC-19） | VACUOUS ✓ | acChecked=11 / VACUOUS_TEST（19:12:49）✓ |

（b/c 的 parsed 键由工作区测试文件 AC 标签重建，与事件 acChecked 计数完全吻合。）

**修复方向验证（同需求全部工作流 + 时间过滤）**：

- 证据面 = 同 `requirement_id` 全部工作流的「SUCCESS + 开发类（BACKEND/FRONTEND/DATABASE/DEBUG）」任务 ∧ `finished_at < 检查时刻`；
- 结果：**a/b/c 全部键覆盖 → 翻转 ✓**（时点前证据 118 / 125 / 124，无一键缺失）；
- 补充方向：**作用域**（任务 `acKeys` ∩ parsed，与 F1-5 result-filter 同族）——缓解并行双链下并发切片测试对 parsed 键的污染。

**机制结论（三案例共性）**：

1. TEST 任务红灯检查跑全量套件（`node --test`，不作用域）→ parsed 键跨切片 / 跨 run；
2. 翻转证据面限「同工作流」→ 跨切片 / 跨 run / 跨批次的实现证据不可见 → **系统性假阳（链停主因）**；
3. 每 run 工作区重置（单提交基线 `eval baseline E1 run-1` + 未提交工作树）→ 实现只可能来自本 run 任务；重跑 / 集成类任务在实现已存在时无法产生红灯（案例 b 的 agent 自报同一结论）。

**修复触点（已勘察）**：

- `apps/server/src/services/taskVerifier.ts`：`resolveCheckOutcome`（~535）/ `acImplementationEvidence`（~597）/ 依赖声明（156）；
- **复用既有** `findRuntimeTasksByRequirementId`（`packages/database/src/planningRepositories.ts:468`，N5 已建：「需求下全部运行时任务（经 workflow_runs 关联；携带 output.verification 证据）」——正是所需通道；`tasks.requirement_id` 列为 NULL、须经 `workflow_runs.requirement_id` 关联）；
- 装配点：`apps/server/src/index.ts:182`（`workflowTasks` loader 处）；
- 测试面：`apps/server/src/__tests__/taskVerifier.test.ts`、`__tests__/verificationGate.e2e.test.ts`。

**下一步**：G1-B 实施（证据面扩展 + 时间过滤 + 作用域补充 + 夹具 FG1–FG4）→ 门禁 → 记录。

### G1-B 实施（2026-10-14）✅ PASS（本机门禁；全仓 sweep 结果见节末）

**改动（2 源码 + 2 测试面 + 1 脚本）**：

1. `apps/server/src/services/taskVerifier.ts`：
   - 新增依赖 `requirementTasks(requirementId)`——红灯翻转证据面 = **同需求全部运行时任务**（跨切片 / 跨 run / 跨批次）；
   - `acImplementationEvidence`：证据过滤 = 自引用排除 + SUCCESS + 开发类 + **`finishedAt < 检查时刻`**（时间过滤，保守）；读取 `workflow.requirementId`；通道缺失 / 读取失败 → unavailable（fail-closed，EVIDENCE_MISSING）；
   - `resolveCheckOutcome`：红灯分支新增**作用域键**（`scopedEvidenceKeys` = 任务 `acKeys` ∩ parsed；无声明 / 无交集回退全量）——allPassed 与证据判定均按作用域键（与 F1-5 result-filter 同族）。
2. `apps/server/src/index.ts`：装配 `requirementTasks → planningRepository.findRuntimeTasksByRequirementId`（**N5 既有 finder 复用**，经 `workflow_runs.requirement_id` 关联）。
3. 测试面：`taskVerifier.test.ts`（存量 E-0 / F1-6 用例迁移至新证据面 + 新增 **G1 describe 9 例**：FG1 复现/修复、FG2 作用域/对照、FG3、FG4 真阳保持、时间过滤、跨 run 证据）；`verificationGate.e2e.test.ts`（builder + 红灯用例迁移）。
4. `apps/server/scripts/e0-redlight-replay.ts`：迁移至需求口径（真实 `requirement_id` 从 workflow_runs 读取）；对照运行改为空证据。

**门禁（本机）**：tsc --noEmit ✓ exit 0；eslint ✓ exit 0；taskVerifier 聚焦 **37/37** ✓；服务端全量 **212/212** ✓（首跑 failureRecovery 1 例红 → 单跑 10/10 + 全量复跑 38/38 绿，按既有并行 flake 口径处置并留证）。
**回放脚本实测**：C-6 默认（REPLAY_A_OK / REPLAY_B_OK ✓）+ **L4 案例 a 真实数据**（`0fa3089a` / `final-slice-verification`：**20/20 翻转** + fail-closed 对照 ✓）。

**全仓 sweep（typecheck → lint → test 串行）**：`/tmp/g1b-fullcheck.log` → typecheck ✓ exit 0；lint ✓ exit 0；test：server 1 例红（mcpConsoleApi 并行 flake → 单跑 8/8 + 复跑 38/38 绿）、apps/web 4 例红（F 期 5 例的严格子集——用户侧 10:34 改动后 dashboardView 转绿）→ **无新增失败** ✓（其余包全绿）。

**已知边界（登记）**：任务声明 acKeys 但解析无交集 → 回退全量解析键（保守，与既有语义一致）；证据任务 `finishedAt` 缺失 → 不构成证据（保守）。

## G2 · 规划精简（T5 其余）

### G2-A 确定性跨规格一致性检查（GX-07）✅

- 新增纯模块 `apps/server/src/services/crossSpecConsistency.ts`（零 LLM、零依赖）：① API 路径归属——任务文本中「落在规格前缀下」的路径须匹配某条已声明端点（逐段比较，`{param}` 段容差；文件路径等非规格前缀候选忽略）；② 表使用面——数据库规格中的每张表须被至少一个任务文本提及；产出为「发现列表」（非阻断）。
- 接线：`planningService` 两条持久化路径（单级 / 二级切片）后记录 `CROSS_SPEC_CONSISTENCY_CHECKED` 事件（含 findingCount / findings（截断 20）/ checkedApiPaths / checkedTables）。
- 单测：`apps/server/src/__tests__/crossSpecConsistency.test.ts` 5 例（一致零发现 / `{param}` 容差 / 未知路径 / 未使用表 / 前缀忽略与空输入）✓。

### G2-B database_spec 按需跳过（GX-06）✅（含真实模型实测）

- 机制：`PlanningGraph` 支持 `skipStages: ["database_spec"]`（与 `ui_spec` 同构：节点省略 + `SLICE_STAGE_SKIPPED` 事件 + 完整性/规格数适配 + 校验输入可选化）。
- 触发：新切片字段 `involvesData`（planner 声明；缺省/undefined = 涉及 → **零行为变化**）；落链：共享 schema（`.optional()`）+ 迁移 `015_phaseG_involves_data.sql` + 仓储映射/插入 + 切片规划提示词 + `planningService` skipStages 合成。
- **实测（真实模型演练，scratch 需求 `305fc0e4`，2026-10-14）**：
  - 规划器自然声明 3 切片 `involvesUi=false / involvesData=false`（新提示词生效，无需人工置位）；
  - slice-1 二级规划事件链：`SLICE_STAGE_SKIPPED{database_spec, reason="slice introduces no data-layer changes"}` ✓、**无** `DATABASE_SPEC_GENERATION_STARTED` ✓、规格落盘 **4 件**（无 DATABASE/UI；DB 核验）✓；
  - 阶段耗时（after，真实模型）：functional 14.7s / technical 10.8s / architecture 8.7s / api 1.3s / task_planning 47.0s；
  - before 基准（L4 实测均值，4 次切片规划）：**database_spec 14.2s/切片**（functional 33.4 / technical 26.8 / architecture 19.9 / api 10.8 / task 102.6）→ 每跳过一片节省 ≈ 一次 LLM 阶段（~14s + 调用链开销）；
  - 一致性检查联动：`CROSS_SPEC_CONSISTENCY_CHECKED{findingCount:0, checkedApiPaths:0, checkedTables:0}` ✓（端到端）。
- 图/校验单测：agent-core `PlanningGraph.test.ts` 新增跳过用例（含事件与规格缺省断言）✓。
- 合并相邻阶段（可选实验）：**不做**（裁决⑤——无度量收益证据）。
- 下游成功率：结构性零变化（仅 planner 显式声明无数据层变更的切片受影响）→ 以出口批次为准（G-M3）。

## G3 · 长任务超时策略（GX-09/10）

- **勘察（数据）**：近 7 天 15 例 timed_out（BACKEND×8 / TEST×3 / REVIEW×1 等，cx 2~7 混杂）；E1 链停任务 T-02（cx=4）超时 run 工具画像 = run_build×31 / write_file×16（命令密集循环，非挂起）；run3 同任务 ~6min 完成（方差大）。覆盖链既有：`workflowTaskExecutor` 读取任务输入 `execution.timeoutMs` → 全局 `TASK_TIMEOUT_MS`（600s）。
- **实施**：新增 `TASK_TIMEOUT_MS_BY_TYPE`（JSON 对象；缺省/空串 = 未配置 → **零行为变化**）；解析顺序 = **任务输入 > 按类型表 > 全局默认（120s 兜底）**；非法 JSON / 未知类型 / 非正整数值 → **启动即失败**。
- **边界单测**：`taskTimeoutBudget.test.ts` 9 例（解析顺序 4 + FG5 run1 `5ae5163e` 参照 1 + 配置解析 4）✓。
- **出口批次配置**：`TASK_TIMEOUT_MS_BY_TYPE='{"BACKEND":900000,"TEST":900000}'`（已写入受控实例守护式启动脚本 `/tmp/g-server-launch.sh`；实例 env 已核验）。
- **任务拆分提示**：不做（数据不支持——同任务 2/3 run 在 600s 内成功，方差源于 agent 效率而非粒度）——登记。
- **E1 复测无同类链停归因**：待 G-M3 出口批次验证。

## G4 · 链推进前序完整性（GX-11/12）

- **语义定稿**（选项 a/c 合成）：严格前序——SUCCESS 回调仅当**更早切片全部 DONE** 时推进到首个 PENDING 切片；存在更早未完成（FAILED / PLANNING / PLANNED / RUNNING）切片时**挂起**并记录 `SLICE_CHAIN_HELD_BY_EARLIER_SLICE`（payload: sliceKey / blockedBy{sliceKey,status}）。
- **单测（FG6 状态矩阵，真实 Postgres e2e）**：`sliceFlow.e2e.test.ts` 新增用例——[DONE,FAILED,PENDING] 挂起 ✓、[DONE,RUNNING,PENDING]（run3 双链形状）挂起 ✓、解除阻塞（复位 PENDING）后链继续直至三切片全 DONE ✓；既有 [DONE,PENDING] 正常推进与重跑登记用例保持全绿 ✓。
- **与 harness 重启语义的交互（文档化）**：harness 对「运行前已 FAILED」切片自重启（self-start）→ 该切片置 RUNNING → 平台侧因更早未完成而挂起、**不跳推** → 切片成功终态后链恢复推进。run3 的「平台跳 slice-4 + harness 重启 slice-2」双链并行缺陷由此消除（单驱动）。
- **正常路径零行为变化**：全 DONE → 无操作；[DONE,DONE,PENDING] → 正常推进（既有回归全绿）。

## G5 · T9 Redis 职责文档化（GX-13）✅

- `docs/02-system-architecture.md` 数据层：Redis 描述更新为「**唯一职责 = 跨进程取消**（`RedisCancellationStore`：`agent-run:<id>:cancel`，1h TTL，250ms 轮询）+ 健康检查；与 PostgreSQL 无重叠；保留不删（评测在 PG + Redis 组合下通过）」。
- `docs/ai-se-architecture.html`：数据层 Redis 盒 SVG 注记更新（「跨进程取消 · 健康检查 / agent-run cancel · 1h TTL · 250ms 轮询」）+ 「数据与外部依赖」卡片条目同步；几何校验通过（文本区间 [942,1118] ⊂ 盒 [856,1204]，无越界）；残留文案（queue · lock · cache / 临时状态）已清零。

## G6 · T7 Agent Run 中途恢复评估（决策记录，GX-14）✅

**结论：不做**（维持「干净 worktree 重跑」语义）。依据数字化：

1. **重跑代价（实测）**：参照任务 T-02 三 run——run1 600s×2 超时失败 → run2 600s 超时后重试成功 → run3 ~6min 直接成功；单任务最坏重跑 ≈ 20min，成功路径 6–10min；全 run 重跑（E1×3）≈ 3h07m（L4 实测）。
2. **恢复机制收益上限**：单任务剩余预算 ≤ 900s（G3 后 BACKEND/TEST 上限）；且 **run 内重试已天然继承工作区进度**（run2 的 attempt2 依赖 attempt1 产物成功）——跨 run 才需 checkpointer。
3. **瓶颈归因**：阶段 G 前的全部 E1 链停**无一例由「进程崩溃丢进度」造成**（判定语义 G1 / 链推进 G4 / 超时 G3，已修）；resume 解决的故障类在此项目未见。
4. **成本与反噬**：引入 Postgres checkpointer = 新依赖（langgraph checkpoint 系）+ 表结构 + 恢复语义 + 独立评审流程；且与评测口径冲突——每 run 干净基线（单提交重置）正是可比性来源，跨 run 续跑会破坏该口径。
5. **干净 worktree 前提（P5/T3b）**：未实施；其缺口与恢复机制正交，不改变结论。
6. **默认路径**：若未来生产化（非评测）需要长任务续跑，重开评估（本记录为默认路径）。无新依赖引入 ✓（不做路径）。

## G-M1 / G-M2 终版复核（2026-10-14 全仓 sweep 终版）

- **typecheck**：全包 ✓ exit 0（含依赖包 build 链）。
- **lint**：全包 ✓ exit 0。
- **test**（串行，`--no-bail`）：server **40 文件 / 227 用例全绿** ✓、agent-core 29/160 ✓、database 10/47 ✓、shared 5/50 ✓、其余包全绿 ✓；唯一红 = **apps/web 4 例**（PageHeader/eyebrow 既有类；F 期 5 例的严格子集）→ **无新增失败** ✓。
- 日志：`/tmp/gm2-fullcheck.log`。
- **夹具状态**：FG1–FG4（G1，单测 + 真实数据回放 ✓）、FG5（G3 ✓）、FG6（G4 ✓）、FG7（G2 一致性 ✓）——全绿。
- **GX 核对**：GX-01..05 ✓（G1）；GX-06..08 ✓（G2；下游成功率以 G-M3 为准）；GX-09 ✓ / GX-10 待 G-M3；GX-11..12 ✓；GX-13 ✓；GX-14 ✓。
- **结论：G-M1 / G-M2 硬指标全过；进入 G-M3（出口批次，已排期 2026-10-19）。**

## G-M3 出口批次（排期与就绪状态，2026-10-14 备妥）

- **窗口**：2026-10-18 23:00 UTC（= 10-19 07:00 CST）新窗口；L3 回归 + E1×3。
- **脚本（已入仓，ASCII + `bash -n` 校验通过）**：
  - `packages/eval/scripts/g-m3-l3.sh`（S/M/L×3 = 24 run；run1 `--replan`；120s 冷却；周护栏 20M；resume-capable；WEEK_START=2026-10-18 23:00 UTC）；
  - `packages/eval/scripts/g-m3-e1-x3.sh`（E1×3；run1 `--replan`；1800s 冷却；同护栏）；
  - `packages/eval/scripts/g-m3-batch.sh`（L3 → E1×3 串联，caffeinate 会话内）。
- **自动排期（cron，deliver=all）**：启动 `7dbbab918565`（10-19 07:10 CST）→ 补启（保险）`bfbda6400708`（12:00）→ 验收核查 `cf3e386efea7`（21:30，只读汇总 E1×3 deliveredSuccess 与 F 期对比）。启动器 `~/.hermes/scripts/g-m3-launch.sh`（窗口 UTC 自检 + 实例健康 + 防重入；异常即退出报警）。
- **运行环境**：受控实例 47557（新代码 + `TASK_TIMEOUT_MS_BY_TYPE={"BACKEND":900000,"TEST":900000}`，env 已核验；守护式启动，ppid 链至 launchd）；迁移 015 已应用。
- **结果落位**：`packages/eval/results/g/l3/`（24 件）与 `packages/eval/results/g/l4/`（run-1..3.json）；日志 `/tmp/g-m3-batch.log`。
- **出口判定**：L3 ≥ T0 噪声线；E1×3 `deliveredSuccess ≥ 2/3` → PASS；< 2/3 → PASS-PARTIAL（附归因）。批次后核验：睡眠日志（`pmset -g log`）+ 幽灵工具调用泄漏检测——沿用 F 期口径。
- **备注**：cron 交付依赖已连接通道（历史任务显示 weixin 会话需用户先向 bot 发消息；`deliver=all` 于触发时解析）；结果本身始终落盘，人工会话复核不受交付通道影响。
- **2026-10-14 run-now 批次（用户明示：现在就跑 + 不需要冷却 / token 充足）**：今日变体 `packages/eval/scripts/g-m3-now.sh`（**E1×3 优先 → L3**；**零冷却**；护栏 **30M** 按本窗计数（起跑时 12.83M→v3 起跑时 14.55M）；默认值集中 wrapper；启动器 `/tmp/g-m3-launch-now.sh`（追加日志））。因启动器 env 未透传（冷却/护栏未生效）+ 一次 pgrep 自匹配误杀脚本，经两次干净重启（kill 全角色 + 取消在途工作流 ebb2e0e6）后，**v3 于 16:02:06 起跑**（run-2 自启动 FAILED 切片，工作流 3f88b145）。**事故无损**：run-1 工件（json/md）完整（日志被 v1 `>` 截断一次，仅日志行；工件不受影响）；新增清场脚本 `packages/eval/scripts/g-m3-stop.sh`。预期：E1×3 今晚完成；L3 全量续跑至明晨。看门狗（批次退出即通知）；10-19 cron 保留（resume 兜底）。
- **run-2 异常轮登记与替代轮（2026-10-14，用户裁决：口径修正 + 替代轮，不改代码）**：run-2（16:02–16:28，oracle 0/29）判定为**环境异常轮（作废）**，不计入 E1×3。根因链（代码级）：
  1. 每 run 工作区由 harness 全新重建（`packages/eval/src/cli.ts:136-151`：rm + 模板复制 + 基线提交；模板 `fixtures/E1/template/` 仅 README.md）→ 根级工程文件须 run 内创建；
  2. backend-agent 文件工具写范围 = `apps/server|server|backend|src`（`AgentRegistry.ts:84`）→ 根级文件不可直接 write_file（"Path is not writable"）；
  3. 命令工具 script-only policy（仅接受 `npm run <script>` / `node --test <file>` 等；通用命令被 TOOL_ERROR 拒绝），且 agent 无 run_command；
  4. 合规路径 = 引导脚本（文件先写 `src/` 下 → 复制脚本经 `node --test` 沙箱执行 → 根级落盘）。run-1（`src/_bootstrap/copy.test.mjs`，14:31:54 ✓）与 run-3（`src/tools/bootstrap.js`，16:39:44 ✓）均找到；run-2 未找到（命令尝试全被 policy 拒；`node src/scripts/build.js` 因缺根级工件失败）→ 自报 CRITICAL 阻塞 → 任务失败（`WORKFLOW_TASK_FAILED: 初始化 pnpm 工程与构建契约脚本`）→ 链停。**属 agent 能力方差，非 G 回归**（守卫/策略/模板均为 F 期既有设计，G 未触碰）。
  - **处置**：替代轮 **run-2b** 于批次（run-3 + L3）完成后以相同条件独立执行（脚本 `packages/eval/scripts/g-m3-e1-run2b.sh`：归档旧工件 `run-2.invalid-env-*` → 复用 e1-x3 只跑缺的 run-2 → `run-2.json`）；出口线判定用 **run-1 + run-2b + run-3**。
  - **已知问题登记（不改代码）**：「写范围/交付物窄门」——任务声明的根级交付物与 agent 写范围不匹配，使此类任务依赖 agent 自行发现引导脚本路径（3 次 1 败）；建议后续阶段评估（交付物→写范围对齐）。
- **预算线放开 + 自动接力（2026-10-14 深夜，用户明示：不考虑 token 剩余，足够用）**：护栏提至 **200M**（实际不触发；批次自带 30M 线触发后自动切换）。接力链 `g-m3-continue.sh`（守护式，已布设）：批次退出 → L3 余量（200M 线）→ **run-2b** 替代轮 → `G_M3_ALL_DONE`；新看门狗 `/tmp/g-m3-watch2.sh` 覆盖全流程（完成或异常即通知）。**预计全部完成：10-15 上午 ~11:00-14:00**（L3 余 ~19 轮 ≈ 8.5-11.5h + run-2b ≈ 2.5-4h；按 F 期时长 × G 期偏慢系数外推）。

---

## G-M3 出口批次 · 终版结果（2026-10-14 13:53 → 10-15 08:33，`G_M3_ALL_DONE`）

### 批次时间线
- 13:53 提前执行（用户「现在就跑」+「不需要冷却」；两次干净重启后 v3 于 16:02:06 起跑：零冷却 / 30M 护栏 / 本窗计数）。
- E1：run-1（13:53–15:38）/ run-2（16:02–16:28，**环境异常轮→作废**）/ run-3（16:28–20:38）。
- L3：20:38:12 起跑 → 10-15 **02:54:37 触及 30M 护栏自动停** → **接力链 02:55:03 自动接续**（200M 线，30 秒空档）→ **07:09:37 L3 全 24 轮完成**（`G_M3_L3_ALL_COMPLETE`）。
- **run-2b 替代轮：07:09:37–08:33:15**（旧工件归档 `run-2.invalid-env-20261015-070937.*`）。
- 全程零 429、零系统睡眠（caffeinate 断言保持）；本窗用量 12.83M → **41.76M**（护栏外，用户明示不设限）。

### E1×3 结果（口径：run-1 + run-2b + run-3）
| 轮 | 时长 | oracle | Must | 链完成 | 交付 | 到达切片 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| run-1 | 90.2 min | 不通过 | 10/29 | 否 | 否 | slice-auth | auth 任务 anti-tamper 真命中（F 期已知类） |
| run-2b | 83.4 min | 不通过 | 16/29 | 否 | 否 | slice-auth（字段=deploy-ui 残留态） | AUTH-BE-06 验证门失败 ×2（VERIFICATION_FAILED） |
| run-3 | 120.5 min | **通过** | **29/29** | 否 | 否 | **slice-deploy-ui** | 卡 DEPLOY 任务 T-25 审批门（WAITING_APPROVAL） |

- **deliveredSuccess 0/3 < 2/3 → 出口线未达**；假阳性 0/3；假阴性 1（run-3）；超范围写入 1×3；任务级验证分歧 1/2/0。
- **归因**：① 交付链审批门（DEPLOY 任务需人工审批——设计行为；评估环境无人批准 → 链无法终态，交付恒否）；② run-2b AUTH-BE-06 验证门 2 处失败；③ run-1 anti-tamper 真命中；④ oracle 显著进步：**10 → 16 → 29/29**（run-3 首次全 Must 通过）。
- 机制注：harness 每轮**全链从 slice-1 重驱**（"同计划重跑"，工作区逐轮重建）——四轮同口径；G4 的 `SLICE_CHAIN_HELD_BY_EARLIER_SLICE` 在平台自动推进被残留切片态阻塞时触发（正常行为，harness 手动驱动链）。

### L3 回归（24 轮，对照 F 期 / T0）
| 指标 | G 期 | F 期 | 判定 |
| --- | --- | --- | --- |
| oracle 真成功率 | **16/24 = 66.7%** | 15/24 = 62.5% | **≥ T0 58.3% ✓** |
| 链完成 / 真交付 | **11/24** | 2/24 | 大幅提升（G4 修复生效） |
| 假阳性 | **0/24** | 1 | ✓（关键安全线） |
| 假阴性 | 5 | 13 | 改善 |
| 超范围写入 | 0 | 1 | ✓ |

- 分档：S 8/9、M 3/9（M1 0/3、M2 0/3、M3 3/3）、L 5/6（L1 2/3、L2 3/3）。
- 时长：24 轮 10h31m（均 26 min/轮）；M1-run1/run2 `durationMs` 缺失（登记）。

### 出口判定（docs/130 §9-①）
- 目标线：E1×3 deliveredSuccess ≥ 2/3 **且** L3 ≥ T0 噪声线 → ① L3 ✓（66.7% ≥ 58.3%）；② E1 ✗（0/3）→ **PASS-PARTIAL（附归因）**。

### 已知问题登记（交后续处理）
1. **交付链审批门**：DEPLOY 任务 WAITING_APPROVAL（设计行为）使评估环境 deliveredSuccess 存在结构上限——需裁决（评估模式自动审批 / 人工批准口径 / 接受上限）。
2. **AUTH-BE-06 验证门失败**（run-2b，HMAC-SHA256 令牌任务，"checks failed: test"）。
3. **根级工程文件窄门**：F 期（docs/129 事故 3）修复覆盖 `src/`（其测试断言 README.md 仍不可写=设计边界）；根级工程文件需"引导脚本"绕行——run-2 异常轮即该边界 + agent 方差所致。
4. **字段缺陷**：M1-run1/run2 `durationMs` null；run-2b `sliceReached` 受残留切片态影响（=deploy-ui 而非实际 auth）。
5. **假阴性 6 例**（E1 1 + L3 5）——自报校准。
6. **run-2 环境异常轮**（已作废登记，见上文）。

### 工件索引
- E1：`packages/eval/results/g/l4/`（run-1/2/3 + run-2.invalid-env-*）；L3：`packages/eval/results/g/l3/`（24×2 件）。
- 日志：`/tmp/g-m3-batch.log`（批次）、`/tmp/g-m3-continue.log`（接力）、`/tmp/g-m3-watch2.log`（看门狗）。

## 后续（2026-10-15，追加）

本文件为**历史记录**（`docs/146` §6 规则 7），正文不回改。追加：**已知问题 1（交付链审批门 → `deliveredSuccess` 结构上限）已由用户裁定**——**不用 `deliveredSuccess`**，评估判据改以 **staging 段（含 VERIFY）** 为准。裁定登记见 `docs/146` §4「本批裁定」，据此口径的验收项见 `docs/17` 节「自治 L1 · 策略内自治」的 L1-8（原文即此口径）。

**因此：G-M3 出口批次的 E1×3 `deliveredSuccess 0/3` 这一项，不再作为交付能力的判据**；它度量的是「含生产审批门的整链交付」，而该口径被裁定弃用。PASS-PARTIAL 的原判定不回改（记录当时怎么判的），但后续阶段引用时应改用 staging 段口径。其余 5 项已知问题维持登记。
