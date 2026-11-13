# 152 · 阶段 7 M2 实施记录：自治决策事件契约（7-E）

> 日期：2026-10-15 ｜ 类型：阶段 7 的 **M2 子阶段（后半）**（用户点名「开始阶段 7 的 7-E」）
> 依据：`docs/147`（阶段 7 任务书 §3 7-E、§7 红线、§4 验证分层）、`docs/17`「自治 L1」节（L1-6）、`AGENTS.md` §3/§9/§11。
> 承接：`docs/149`（M1）、`docs/150`（7-C）、`docs/151`（验证证据不进 Agent 输入）。
> 范围：**只做 7-E**。自治 L1 的实现、7-D 外部栈、追踪前端一律未开工。

## Modified Files

**代码（修改 1）**
- `packages/shared/src/index.ts`：新增自治决策事件契约（`AutonomyDecisionEventTypeSchema` 及四个 payload schema、事件名→契约的唯一映射、`parseAutonomyDecisionPayload`）。**未改任何既有导出。**

**测试（新增 1）**
- `packages/shared/src/autonomyContract.test.ts`（7 条，跟随本包既有的 `*Contract.test.ts` 惯例）。

**文档（新增 1 / 修改 7）**：本文件；`docs/147`（§3 7-E 状态、状态行、§9）、`docs/17`（Phase 7 节头与 L1-6 的依赖注记）、`docs/15`、`docs/18`、`docs/127`、`docs/146`（§1/§2.1/§3/§5）、`README.md`（现状说明）。

**未修改**：`workflow_events` 表与迁移、`WorkflowEngine` 的任何事件写入、`apps/server`、`docs/133–151` 等历史记录、`dist/`。

## Implementation

**7-E 只交付契约，不改变任何现有行为**（`docs/147` §3 的字面要求）。

1. **落点**：`packages/shared`（`AGENTS.md` §3：跨包共享的类型/契约放 shared）。事件写进**既有** `workflow_events` 表——`event_type` 取契约的事件名，`payload` 为对应 schema——**不新增表、不新增事件体系、不新增路由**。
2. **四个事件**（沿用任务书 §3 的候选名，见 Known Issues 1）：

   | 事件 | payload 的判别字段 | 契约里钉住的不变量 |
   | --- | --- | --- |
   | `AUTO_APPROVED` | `environment` | **只能是 `"staging"`**——生产审批门不可由策略关闭（L1-9），因此 `production` 在契约层不可表达，而不是靠写入方自觉 |
   | `AUTO_RETRIED` | `attempt` / `maxAttempts` | **`attempt <= maxAttempts`**——L1-5 的「有界」在契约层成立 |
   | `AUTO_ROLLED_BACK` | `deploymentId` / `environment` | 必须指明被回滚的那个部署 |
   | `VERIFICATION_ENFORCED_FAILURE` | `failedChecks` / `gateMode` | `gateMode` 只能是 `"enforce"`；`failedChecks` 非空且**只带检查名，不带输出** |

3. **公共字段**：`policyId`（策略标识）、`reason`（依据）、`workflowRunId`、`taskId`——对应 L1-6 的「含策略标识与依据」与「可按 `workflowRunId` 查询」。四个 schema 一律 `.strict()`：多带的键会被拒（顺带挡住把输出或凭据塞进 payload 的做法）。
4. **唯一映射 + 解析入口**：`AUTONOMY_DECISION_PAYLOAD_SCHEMAS`（事件名 → schema）与 `parseAutonomyDecisionPayload(eventType, payload)`。写入方与审计方共用这一处，避免出现第二份口径。
5. **红线**（`docs/147` §7）：契约不含任何密钥字段；`reason` 是自由文本，其脱敏由**写入方**在落库前走既有路径（`@ai-se/observability` 的 sanitize）——契约不重复实现脱敏，也不新增第二套 Secret 处理（`AGENTS.md` §10）。

## Architecture Changes

- `packages/shared` 新增一组导出（4 个 payload schema、1 个事件名 enum、1 个映射常量、1 个解析函数、5 个类型）。**既有导出与既有事件一个都没动**。
- 无运行时行为变化：本阶段没有写入方，没有任何代码路径会产出这四个事件。
- **未改**：状态机、审批语义、Tool Runtime 唯一执行路径、错误码体系、迁移、包边界。

## Dependencies

无新增依赖（含 devDependencies）。契约用本包既有的 `zod`。

## Tests

| 命令 / 范围 | 结果 |
| --- | --- |
| `@ai-se/shared` test | **57/57 通过（6 个文件）**（本阶段前为 50，+7） |
| 其中新增 | `autonomyContract.test.ts` **7/7** |
| `@ai-se/shared` typecheck / lint | 均通过（退出码 0） |
| 全仓 `corepack pnpm -r run typecheck` | **通过**（退出码 0） |
| 全仓 `corepack pnpm -r run lint` | **通过**（退出码 0） |
| 全仓 `corepack pnpm -r run test`（单次） | **16 个包全绿，无失败、无抖动**：observability 3、eval 35、shared 57、evidence 9、visual 83、workflow-engine 36、failure-recovery 16、web 473、sandbox 7、tool-runtime 32、action-policy 13、browser 38、agent-core 160、mcp 235、database 47、**apps/server 263** |

用例覆盖（OB-09）：事件名与 schema 一一对应（集合相等）；`AUTO_APPROVED` 收 staging、拒 production / dev；`AUTO_RETRIED` 的 `attempt <= maxAttempts` 边界（含 0、非整数）；`AUTO_ROLLED_BACK` 必须有合法 `deploymentId`；`VERIFICATION_ENFORCED_FAILURE` 的 `failedChecks` 非空、`gateMode` 只收 `enforce`、把 `stdoutTail` 塞进来会被 `.strict()` 拒；缺公共字段 / 空 `policyId` / 非 UUID / 多带 `token` 键一律拒；`parseAutonomyDecisionPayload` 的通过路径与抛错路径。

## Lint

- `corepack pnpm --filter @ai-se/shared lint`：通过（退出码 0）。
- 全仓 `corepack pnpm -r run lint`：通过（退出码 0）。

## Typecheck

- `corepack pnpm --filter @ai-se/shared typecheck`：通过（退出码 0）。
- 全仓 `corepack pnpm -r run typecheck`：通过（退出码 0）。该命令会重建相关包的 `dist`（构建产物，未读取）。

## E2E

- **本阶段没有可 e2e 的运行时路径**：契约没有写入方，不产生事件、不改任何既有事件，因此没有"真实跑一次"的对象。**不声称做过 e2e**。
- OB-10（现有事件类型与既有 payload 不变）以**既有测试不回归**为准：`@ai-se/workflow-engine` 的事件 payload 用例、`apps/server` 的事件/工作流/交付用例在全仓门禁中一并跑（结果见上表）。
- 运行中的实例：本次改动落在 `packages/shared`（重建 `dist` 会让后端重启），未做任何只读走查——契约没有任何可观察的运行时表现。

## Known Issues

1. **事件名沿用任务书候选值**。`docs/147` §3 把四个名字标为「名称待审」；本次按候选值落定，未另起名字。改名只影响契约常量与测试（无写入方、无历史数据），成本极低——若要改，现在是最便宜的时候。
2. **没有写入方**（设计如此）：L1-6 的实现要按本契约写事件。在那之前，`AUTONOMY_DECISION_PAYLOAD_SCHEMAS` 没有任何生产调用点。
3. **`AUTO_RETRIED` 与既有 `TASK_RETRYING` 的分工需在实现时定死**：后者是引擎的机械事实（`packages/workflow-engine/src/WorkflowEngine.ts:686`），前者是**策略决策**（带 `policyId` / `reason`）。两者可能同时成立；实现 L1 时要明确是「决策事件另写一条」还是「只写决策事件」，避免同一件事两条事件口径不一。
4. **`policyId` 的取值约定待定**：L1-7 的「自治级别是工作流级策略字段」尚未实现，契约里它是 1–64 字符的非空串，约定用级别名（如 `"L1"`）。策略载体落地后应把约定固定下来（或在契约里收紧为枚举）。
5. **`reason` 的脱敏是写入方责任**：契约不扫描凭据形状串（`shared` 处于依赖图底部，扫描实现属 `@ai-se/observability`，在这里重写会形成第二套）。写入方须走既有 sanitize 路径。
6. **`AUTO_ROLLED_BACK` 未在契约层限制环境**：L1 只自动回滚 staging（`docs/17` L1-5），但 L2 可能允许更多，故契约只要求 `environment` 合法，不写死为 staging。与 `AUTO_APPROVED` 的处理不同——那条是红线（生产审批门），这条不是。
7. **未做的 7-E 之外事项**（红线，不得误读为已完成）：自治 L1 的任何实现、L1-1 … L1-3 的回归断言、7-D 外部栈、追踪前端、`audit_logs` 处置。

## Acceptance Result

| 验收项（`docs/147` §3 7-E） | 判定 | 证据 |
| --- | --- | --- |
| OB-09 契约以 zod 定义，单测覆盖合法与非法 payload | **通过** | `packages/shared/src/autonomyContract.test.ts` 7/7；四个事件各有合法/非法两侧断言 |
| OB-10 现有事件类型与既有 payload 不变（既有测试不回归） | **通过** | 未改任何既有导出与事件写入点；全仓 `-r test` **16 包全绿、apps/server 263/263**（含 workflow-engine 的事件 payload 用例） |
| 不改变任何现有行为（§3 7-E 的目标句） | **遵守** | 无写入方、无运行时路径；仅新增导出 |
| 不新增第二套 Audit / Secret 体系（§7、`AGENTS.md` §10） | **遵守** | 事件写进既有 `workflow_events`；脱敏复用既有 sanitize，契约不另实现 |
| payload 不含密钥 | **遵守** | 四个 schema 均 `.strict()` 且无密钥字段；`token` 等多余键被拒（有用例） |

## Next Phase Boundary

**本子阶段结束（STOP）。未开始事项**：
- **Phase 7 收口**：`docs/147` §5 的收口条件现已**全部满足**（M1 + M2 全绿、OB-01 … OB-10 全绿），只差把 `docs/17` 的 Phase 7 六项逐项回填、`docs/12` 基线更新到收口时的事实。**这是一步独立的、已命名的收口动作，未执行。**
- **自治 L1 的实现**（L1-4 … L1-8）与 L1-1 … L1-3 的回归断言：未开工。其前置（7-C / 7-E / 7-B）已全部就绪。
- **7-D 外部栈**（OTel / Prometheus 服务端 / Loki / Grafana）：已裁定延期。
- **追踪前端**：已裁定另立阶段。
- **`provider` 运行时切换**：未开工（沿用 `docs/145` 边界）。

**需要你回答**：无。`docs/147` §6 五项已全部落地，Phase 7 的 M1 + M2 均已交付。

## 后续（2026-10-15，追加）

本文件为**历史记录**（`docs/146` §6 规则 7），正文不回改。追加：**Phase 7 已于 2026-10-15 收口**（收口记录 `docs/153`）——本文件「Next Phase Boundary」所列的收口动作已执行：`docs/17` 的 Phase 7 六项逐项回填（完成 2 项 / 延期 4 项）、`docs/12` 基线表更新到收口时的事实、`docs/146` 同步。本文件 Known Issues 1（事件名）与 4（`policyId` 取值约定）仍在自治 L1 实现时定死，未变。
