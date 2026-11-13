# 148 · 批次记录：质量门默认 observe · 自治 L1 验收定义 · 阶段 7 任务书 · 文档同步

> 日期：2026-10-15 ｜ 类型：批次（四件已命名事项，用户授权打包执行；偏离 `AGENTS.md` §9「一次一个阶段」，偏离已获明确授权）
> 依据：用户指示——「可以把质量门设为 observe」「先把第一种定义成可验收的目标」「不用关注」（指 JavaScript 版本项）「做阶段 7 任务书，把 docs 不对的地方同步改了」。
> 承接：`docs/145`（W13 / X1）、`docs/146`（全局账本）。

## Modified Files

**代码（2 个文件）**
- `apps/server/src/config.ts`：`VERIFICATION_GATE` 默认值 `off` → `observe`（第 67 行）；第 66、116 行注释同步。
- `apps/server/src/config.test.ts`：默认值断言改为 `observe`，并补 `off` 分支断言。

**文档（新增 2）**
- `docs/147-phase-7-taskbook-observability.md`：阶段 7 任务书（草案 v1，待审阅，未开工）。
- `docs/148-batch-observe-gate-autonomy-target-phase7-taskbook.md`：本文件。

**文档（修改）**
- `docs/17-acceptance-checklist.md`：Phase 7 节加任务书指针；末尾新增「自治 L1 · 策略内自治（目标，未开工）」节（L1-1 … L1-9）。
- `docs/146-global-completion-status.md`：§0 增「任务书待审（未开工）」；§1 口径①修正（原文称「从第一版路线图起就标为 V1 后续增强」，实际出处是 `docs/17` 的节标题与依赖链）；§1、§2.1 的 Phase 7 状态改为任务书待审；§3 的 30 处 `docs/17` 行号引用改为节标题（行号已全部漂移）；§4 增待裁决 4–6 与「本批裁定」；§5 增门禁记录；§6 增规则 8。
- `docs/12-observability.md`：基线表新增「请求 ID 贯通」行；Trace 行补可派生的关联键；Metrics 九项的覆盖精确化（5/9）；文首改为指向 `docs/147`。
- `docs/13-ai-sre.md`：新增「基线状态」表（原文未动）。
- `docs/04-workflow-engine.md`：新增「基线状态」表（原文未动）。核对出的差异：状态名与代码不一致（`CREATED` / `COMPLETED` 对应代码的 `PENDING` / `SUCCESS`）；重规划默认关闭；OPERATIONS 段未实现。
- `docs/01-product-requirements.md`：新增基线头（原文未动）。「核心原则」仍有效；「核心能力」清单是目标，不是完成度声明。
- `docs/15-development-roadmap.md`：Phase 7 节加任务书指针，并注明外部栈为条件性交付。
- `docs/127-project-status-overview.md`：「最近更新」行。
- `docs/19-user-manual.md`：失败策略处注明界面默认选中 `FAIL_FAST`。
- `README.md`：「最终目标」流程图之后加「现状说明」。
- `AGENTS.md`：三处事实修正（见 Implementation 第 4 条）。

**未修改**：历史阶段记录（`docs/133–145`、`docs/58`）；`docs/02、03、05–11、14`（未逐条核对，见 Known Issues 8）；任何 `dist/`。

## Implementation

1. **质量门默认 observe**：配置默认值改为 `observe`。组合根 `apps/server/src/index.ts` 的装配规则不变（`off` 时不装配包装层，否则装配 `VerifyingWorkflowTaskExecutor`）。因此默认行为从「不装配」变为「装配、只记录」。`observe` 不改变任务结果；`enforce` 行为不变；评测脚本显式设置 `enforce`，不受影响。
2. **自治 L1 验收定义**：写入 `docs/17`。方向为用户选定的第一种；关口 1 默认不纳入 L1。L1-1 … L1-3 是回归门（代码已成立，回归断言待补）；L1-4 … L1-8 未成立，需实现。
3. **阶段 7 任务书**：`docs/147`。依据是 `docs/12` 基线与本日代码核对。分 7-A … 7-E（M1 / M2 零新增依赖）与 7-D（外部栈，条件性）。五项待裁定。
4. **文档同步**：按 `docs/146` §6 规则 7 分三类处理。活文档修事实错误：AGENTS（① `repositories/` 目录已不存在；② `components/`、`composables/` 已建立，`types/`、`constants/` 仍未建；③ 样式入口为 `styles/app.css`，不是 `styles.css`）、README（现状说明）、docs/19（默认策略）、docs/146（账本）、docs/127、docs/15、docs/17、docs/12 的基线表。实现前设计加基线头、不删原文：docs/01、04、12、13。历史记录不改。
5. **运行中的后端**：保存配置触发 `tsx watch` 重启。监听进程启动于 13:51:09，晚于 `config.ts` 修改时间 13:48:44。重启前核对：工作流 146 FAILED / 133 SUCCESS / 1 WAITING_APPROVAL / 5 CANCELLED，无 RUNNING；agent runs 3034 条全部为终态。

## Architecture Changes

无。未改接口契约、状态机、审批语义或包边界。质量门的装配条件未变，只变了默认值。

## Dependencies

无新增依赖。

## Tests

| 命令 / 范围 | 结果 |
| --- | --- |
| `vitest run src/config.test.ts src/__tests__/taskVerifier.test.ts` | **46/46 通过** |
| `apps/server` 全量 `test`（第 1 次） | 243/244。失败：`v1GoldenScenario.e2e` 的「服务重启后恢复」用例（期望 SUCCESS，得到 FAILED） |
| `apps/server` 全量 `test`（第 2 次） | 243/244。失败：`terminationPropagation.e2e` 的 FX-35「取消 → 零新增 tool_calls」用例 |
| 两个失败文件单独复跑 | **均通过**：golden 4/4；terminationPropagation 5/5 |

两个失败用例都不经过 `loadConfig` 或 `VerifyingWorkflowTaskExecutor`（已核对文件内容），与默认值变更无直接路径。二者属 `docs/145` Known Issue 7 同类的负载抖动。**本批不声称全量一次通过。**

## Lint

`corepack pnpm --filter @ai-se/server lint`：通过（退出码 0）。

## Typecheck

`corepack pnpm --filter @ai-se/server typecheck`：通过（退出码 0）。该命令会重建相关包的 `dist`，属构建产物，未读取。

## E2E

- 运行中后端：`GET /health` 返回 200；进程环境中没有 `VERIFICATION_GATE`，代码默认 `observe` 生效。
- **未执行真实工作流**：本批未获授权运行任务（会消耗 token 与沙箱时间）。observe 的真实行为（`output.verification` 的内容与耗时）待下一次真实运行时观察。

## Known Issues

1. **observe 的时间成本未测**。开发类任务（`BACKEND` / `FRONTEND` / `DATABASE` / `DEBUG`）在任务结束后于沙箱执行检查（`build` / `test` / `lint` / `typecheck` 中的候选项）；任务开始前对它们做受保护测试文件快照。所有任务还会做写范围快照（`git status --porcelain`，`WRITE_SCOPE_AUDIT` 默认即为 observe）。耗时未实测；首次真实运行后可从 `output.verification.durationMs` 读取。
2. **验证记录进入下游上下文（行为变化，需你裁定）**。`output.verification` 随任务输出经 `dependencyResults` 进入下游提示词（`apps/server/src/services/taskContextBuilder.ts:58`）。每个检查的 `stdoutTail` / `stderrTail` 各取尾部至多 2000 字符（`apps/server/src/services/taskVerifierRules.ts:277`）。RETRY 策略下还进入重试上下文（`previousAttempts.output`）。**observe 不改变任务结果，但改变了 Agent 的输入。** 见 `docs/147` §6 第 4 项。
3. **观测层异常路径**。写范围快照的 `gitStatusPorcelain` 自带 try/catch。`snapshotProtectedFiles` 没有外层 try，但它经 `ToolRuntime.execute` 调用，后者把异常收敛为失败结果（`packages/tool-runtime/src/ToolRuntime.ts`），因此未加防御代码。若 Tool Runtime 的收敛行为改变，需复核。
4. **全量测试抖动**（见 Tests）。未修，属后端线（`docs/145` Known Issue 7）。
5. **`audit_logs` 休眠**。迁移创建、全仓无写入方。`AGENTS.md` §10 禁止第二套审计，去留见 `docs/147` §6 第 3 项。
6. **`.env.example` 未列 `VERIFICATION_GATE`**。该文件本就不完整（未列 `WRITE_SCOPE_AUDIT` 等键），本批未补；默认值以 `config.ts` 为准。
7. **自治 L1 未开工**。L1-1 … L1-3 代码已成立，回归断言待补：`deliveryLifecycle.e2e.test.ts` 没有直接断言「staging 免审批」；`deliveryApi.e2e.test.ts:301` 只断言进入 `WAITING_APPROVAL`。
8. **未逐条核对的设计文档**：`docs/02、03、05、06、07、08、10、11、14`，以及 `docs/09` 中非活文档部分。按 `docs/146` §6 规则 7，**用前先基线**；本批不预先批量处理。
9. **审计子代理中途停止**。本批曾派一个只读审计子代理核对文档与代码，运行约 18 分钟、输出无进展后停止，其部分结果未作为结论使用。本批的文档核对改为人工逐条完成，范围以 Modified Files 所列为限。

## Acceptance Result

| 事项 | 判定 | 证据 |
| --- | --- | --- |
| 质量门默认 observe | **已执行**（配置层）；**行为验收待首次真实运行** | `config.test.ts` 与 `taskVerifier.test.ts` 共 46/46；运行中后端无覆盖环境变量 |
| 自治 L1 验收定义 | **已完成**（定义，未开工） | `docs/17`「自治 L1」节，9 项验收 |
| 阶段 7 任务书 | **已完成**（草案，待审） | `docs/147`；未开工 |
| 文档同步 | **已完成**（列表见 Modified Files） | 逐文件修改；历史记录未改 |

## Next Phase Boundary

**本批次结束（STOP）。未开始事项**：
- 阶段 7 实施（7-A … 7-E）：未开工，等待 `docs/147` §6 的五项裁定。
- 自治 L1 实现：未开工，等待 `docs/17` 待裁定 1–2 与阶段 7 的前置。
- 7-D 外部栈：未裁定，默认延期。
- `provider` 运行时切换：未开工（沿用 `docs/145` 边界）。
- `docs/02、03、05–11、14` 的基线核对：未做（按需基线）。
- JavaScript 版本项：按用户指示不关注。

**需要你回答**（`docs/146` §4 第 4–6 项）：
1. 自治 L1：关口 1 是否纳入（默认不纳入）。
2. 自治 L1：L1-5 的 RETRY 上限（建议 2）。
3. 阶段 7 任务书五项：依赖策略、指标端点路径、`audit_logs` 去留、验证证据去向、追踪前端（建议值见 `docs/147` §6）。

---

## 后续：上述问题的回答（2026-10-15 同日追加；本节以上原文未改）

用户回答：**「都按你的建议」**。六项全部按建议值落定，落点如下：

| 问题 | 裁定值 | 落点 |
| --- | --- | --- |
| 自治 L1：关口 1 是否纳入 | **不纳入** | `docs/17`「自治 L1」节 · 裁定结果 1；`docs/146` §4 本批裁定 |
| 自治 L1：L1-5 的 RETRY 上限 | **2** | `docs/17`「自治 L1」节 · L1-5 与裁定结果 2 |
| 阶段 7：依赖策略 | **零依赖**（手写文本导出）；7-D 外部栈**延期** | `docs/147` §6 第 1 项、§3 7-D |
| 阶段 7：指标端点路径 | **`/api/metrics`** | `docs/147` §6 第 2 项 |
| 阶段 7：`audit_logs` 去留 | **本阶段不动** | `docs/147` §6 第 3 项 |
| 阶段 7：验证证据去向 | **留到 7-E 开工前单独裁定**（本次不预先改） | `docs/147` §6 第 4 项 |
| 阶段 7：追踪前端 | **另立阶段**（本阶段只交付 API） | `docs/147` §6 第 5 项 |

**状态影响**：`docs/146` §0 新增状态词「已裁定（未开工）」；§1 行 7、§2.1、§3 的 Phase 7 行由「任务书待审」改为「已裁定（未开工）」；§3 末行新增「自治 L1」节归位（该节 8 项**不在**原 73 的计数内）；§4 原第 4–6 项移入「本批裁定」。

**仍未开工**：本裁定**不构成开工授权**。Phase 7 的 7-A … 7-E 与自治 L1 的实现均未开始；唯一未决项是上表第 4 行（7-E 的前置，不阻塞 M1）。

---

## 勘误（2026-10-15 追加，上文一字未改）

**Known Issues 2 的第三句有误**：「RETRY 策略下还进入重试上下文（`previousAttempts.output`）」不成立。

核对（`docs/149` 期间发现）：`previousAttempts` 取自 **Agent Run**（`apps/server/src/services/taskContextBuilder.ts:65` 的 `agentRuns.findByTaskId`），而 `verification` 只写在**任务输出**上（`verifyingTaskExecutor.ts:64`）。实库核验：`agent_runs` 中带 `verification` 的行为 **0**，`tasks` 中为 1186。因此 `output.verification` 的提示词通道**只有** `dependencyResults`（下游任务），不含重试上下文。

正确的完整表述见 `docs/149`（含实测体积：任务记录平均 2.7 KB、最大 7.4 KB；事件里的 `TASK_VERIFICATION` 摘要平均 364 B、最大 599 B）。

---

## 勘误二（2026-10-15 追加，上文一字未改）

**Known Issues 2 的最后一句已过时**：「observe 不改变任务结果，但**改变了 Agent 的输入**」。

同日裁定并落地（`docs/151`）：`output.verification` **不再进入 Agent 输入**——`taskContextBuilder` 组装 `dependencyResults` 时剥掉 `verification`，存储侧（AC 覆盖判定、追溯表的事实来源）不动。因此自 2026-10-15 起：

- `observe` **只写证据**：不改任务结果，也不改 Agent 的输入（该模式的行为耦合已消除）；
- Known Issues 2 的其余事实仍然成立（写入位置、尾部长度上限、`previousAttempts` 不含它）。

裁定依据为实测（1186 个任务带验证记录、平均 2.9 KB、其中 53% 是原始 stdout/stderr、两个生产读取方从不读尾部），详见 `docs/151`。

