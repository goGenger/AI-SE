# 150 · 阶段 7 M2 实施记录：端到端追踪视图（7-C）

> 日期：2026-10-15 ｜ 类型：阶段 7 的 **M2 子阶段（前半）**（用户点名「开始阶段 7 的 7-C」）
> 依据：`docs/147`（阶段 7 任务书 §3 7-C、§7 红线、§4 验证分层）、`AGENTS.md` §4/§7/§9/§11。
> 承接：`docs/149`（M1：7-A 关联 ID 贯通 / 7-B 指标端点）。
> 范围：**只做 7-C**。7-E（决策事件契约）、7-D 外部栈、自治 L1、追踪前端一律未开工。

## Modified Files

**代码（新增 1）**
- `apps/server/src/services/traceService.ts`：追踪树组装（只读派生；`TraceSources` 窄接口 + 树节点构造 + 逐类计数）。

**代码（修改 7）**
- `packages/shared/src/index.ts`：新增 `TraceNodeKind` / `TraceNode` / `WorkflowTraceCounts` / `WorkflowTraceView`（`WorkflowStreamPayload` 之后）。
- `packages/database/src/agentRunStores.ts`：`PgAgentRunStore.findByTaskIds()`、`PgToolCallStore.findByAgentRunIds()`（窄查询，空数组不发查询）。
- `packages/database/src/deploymentRepository.ts`：`PgDeploymentRepository.findByWorkflowRunId()`（窄查询）。
- `apps/server/src/routes/workflows.ts`：`createWorkflowsRouter(service, traceService?)` + `GET /workflows/:id/trace`（未注入时不注册该路由）。
- `apps/server/src/app.ts`：可选依赖 `traceService`，传给工作流路由。
- `apps/server/src/index.ts`：构造 `TraceService`（六个只读来源接到既有仓储）并注入应用。

**测试（新增 2）**
- `apps/server/src/__tests__/traceService.test.ts`（6 条：树形与挂载、执行顺序、耗时计算与回落、凭据形状脱敏与「不含工具输入输出」、requestId 缺失/查询失败、运行不存在）。
- `apps/server/src/__tests__/workflowTrace.e2e.test.ts`（真库 + 真 HTTP + 本地交付链：OB-07 / OB-08）。

**文档（新增 1 / 修改 9）**：本文件；`docs/09`（API 清单）、`docs/12`（基线表 Trace 行与结论）、`docs/15`、`docs/17`（Phase 7 节，`End-to-end trace` 已勾）、`docs/18`（Phase 7 实现进度）、`docs/127`（最近更新）、`docs/146`（§1/§2.1/§3/§5）、`docs/147`（状态行与 §9）、`README.md`（API 清单与现状说明）。

> **顺带修正的活文档事实错误**（`docs/146` §6 规则 7：活文档必须与代码一致）：`docs/09` 与 `README.md` 的 API 清单都漏了 `POST /api/workflows/:id/retry`（`routes/workflows.ts` 的 action 循环里一直在注册），`docs/09` 另漏 `PATCH /api/workflows/:id/policy`，`README.md` 另漏 M1 交付的 `GET /api/metrics`。本批按代码补齐，未改任何行为。

**未修改**：`docs/133–149` 等历史阶段记录（`docs/149` 属 M1 记录，未回改）；`dist/`；前端（追踪前端已裁定另立阶段）。

## Implementation

1. **一个只读端点**：`GET /api/workflows/:id/trace`。运行不存在 → 404 `WORKFLOW_NOT_FOUND`；`:id` 非 UUID → 400 `VALIDATION_ERROR`（沿用既有 `idFrom`）。响应是统一 JSON 信封（`sendSuccess`），**不是** 7-B 那种裸文本。
2. **树的形状**（`docs/147` §3 7-C 的字面要求）：

   ```text
   workflow (状态/起止/耗时/项目·需求·计划版本)
   └─ task（按执行顺序 started_at 升序；未开始的排最后）
      ├─ agentRun（agentName / agentType / 迭代 / 重试 / token / 成本）
      │  └─ toolCall（toolName / iteration / toolCallId）
      └─ deployment（environment + operation / version / image / gitCommit / ciRunId）
   ```

   节点统一带 `kind` / `id` / `label` / `status` / `startedAt` / `finishedAt` / `durationMs` / `detail` / `children`。
3. **数据来源全部是既有事实表**，无新增埋点、无 span 概念、无新表、无迁移：`workflow_runs`（根）、`tasks`（`findTasks`）、`agent_runs`（按任务 ID 批量）、`tool_calls`（按 Agent Run ID 批量）、`deployments`（按运行 ID）、`workflow_events`（只取 `WORKFLOW_STARTED` 的 requestId，沿用 7-A 的窄查询）。
4. **三个新的窄查询**：都按索引列（`task_id` / `agent_run_id` / `workflow_run_id`）批量取，一次一查（不是每任务一查）。空 ID 数组直接返回空，不发 SQL。
5. **任务节点的排序**：按 `started_at` 升序，未开始的排最后。理由（实测发现）：同一事务里克隆出来的运行时任务 `created_at` 是**同一个值**，直接沿用仓储顺序会退化成 `task_key` 字母序——交付链会读成 CI → E2E → PRODUCTION → STAGING。执行顺序才是追踪视图要看的东西。
6. **耗时**：`finishedAt - startedAt`（两端齐全且非负）；工具调用缺时间戳时回落到记录的 `duration` 列。
7. **脱敏与最小暴露**（`docs/147` §7 红线）：
   - `label` 与 `detail` 的每个字符串都过 `redactCredentialShapedText`；
   - `detail` **只收白名单标量**，不递归、不搬运 JSON 载荷；
   - **工具调用的 `input` / `output` 一律不进树**（那是载荷，不是结构）；
   - `deployment.endpoint` 与 `healthCheck` 不进树（只留 environment / operation / version / image / gitCommit / ciRunId / 回滚字段）；
   - requestId 的查询异常被吸收（`.catch(() => undefined)`）——关联信息读不到不影响树的其余部分。
8. **计数**：`counts` 由**遍历组装好的树**得出，而不是由查询结果长度得出——组装漏挂节点会在这里显形（OB-07 的断言因此不是同义反复）。

## Architecture Changes

- 新增一个 HTTP 端点 `GET /api/workflows/:id/trace`（挂在既有 `/api` 之下，继承 `apiTokenGuard`）。
- 新增一个服务 `TraceService`（`AGENTS.md` §4：一资源一文件），其依赖是**窄接口** `TraceSources`（六个只读方法），由组合根接到既有仓储；因此树的组装逻辑可脱离数据库单测。
- 新增三个仓储只读方法（`PgAgentRunStore.findByTaskIds` / `PgToolCallStore.findByAgentRunIds` / `PgDeploymentRepository.findByWorkflowRunId`）。
- **未改**：状态机、审批语义、Tool Runtime 唯一执行路径、错误码体系、迁移、包边界、`output.verification` 的内容与去向。

## Dependencies

无新增依赖（含 devDependencies）。树由既有表派生，未引入 OTel 或任何追踪 SDK（7-D 已裁定延期）。

## Tests

| 命令 / 范围 | 结果 |
| --- | --- |
| `@ai-se/server` test（全量，1 次） | **261/261 通过（49 个文件）**，无失败、无抖动 |
| 其中新增 | `traceService.test.ts` 6/6；`workflowTrace.e2e.test.ts` 1/1（含 OB-07、OB-08） |
| 增量核对 | M1 收口时为 254 条；本次 +7 = 261 ✓ |
| 全仓 `pnpm -r run test`（收尾门禁，单次） | 15 个包全绿（observability 3、eval 35、shared 50、evidence 9、visual 83、failure-recovery 16、workflow-engine 36、web 473、sandbox 7、tool-runtime 32、action-policy 13、browser 38、agent-core 160、mcp 235、database 47）；**`apps/server` 259/261** —— 失败两条：`failureRecovery.e2e`（CANCELLED 用例）与 `terminationPropagation.e2e`（FX-35 取消用例），**与 `docs/145` #7 同类**，单独复跑该两文件 **15/15 通过**。**不声称「一次全仓跑通」** |

用例覆盖：树形与逐层挂载（含部署挂在产生它的任务下）、执行顺序与「未开始排最后」、耗时计算与工具调用回落、凭据形状脱敏、**断言序列化后的树不含 `input`/`output`**、requestId 缺失与查询异常被吸收、运行不存在返回 `null`；e2e 另覆盖计数与直接 SQL 逐类相等、交付链四节点可见、审批门的 `WAITING_APPROVAL`、审批后 production 部署落树、`redactCredentialShapedText(JSON) === JSON`。

## Lint

- `@ai-se/shared` / `@ai-se/database` / `@ai-se/server` 三个改动包 `lint` 全部通过（退出码 0）。
- 全仓 `corepack pnpm -r run lint`：通过。

## Typecheck

- 三个改动包 `typecheck` 全部通过（退出码 0）。
- 全仓 `corepack pnpm -r run typecheck`：通过。
- 该命令会重建相关包的 `dist`（构建产物，未读取）。

## E2E

- **真库 + 真 HTTP**（`workflowTrace.e2e.test.ts`）：postgres:16 容器 → 建项目 / 需求 / 四节点交付计划（CI → staging DEPLOY → VERIFY → production DEPLOY）→ `POST /api/workflows/:id/start`（带 `x-request-id`）→ 等待 `WAITING_APPROVAL` → `GET /api/workflows/:id/trace` 断言四节点与状态、计数与直接 SQL 逐类相等、`requestId` 等于触发请求 → 审批 → 等待 `SUCCESS` → 再取树断言 production 部署落树。
- **运行中的实例（只读）**：`GET /api/workflows/:id/trace` 对两个真实运行返回 200——一个 21 任务运行（`counts` = `{tasks: 21, agentRuns: 21, toolCalls: 405, deployments: 0}`，根耗时 1,043,997 ms，子节点为 `qa-agent` 等真实 Agent 与其工具调用）；一个交付运行（`{tasks: 14, agentRuns: 12, toolCalls: 335, deployments: 2}`，`staging DEPLOY` 挂在 T-23 / T-24 下，T-25 显示 `WAITING_APPROVAL`、未开始的 T-21 排在最后）。未知 ID → 404 `WORKFLOW_NOT_FOUND`；非 UUID → 400 `VALIDATION_ERROR`。**未触发任何任务、未写任何表**。
- 该实例的 `requestId` 为 `undefined`：该运行启动于 7-A 之前（`WORKFLOW_STARTED` payload 无 `requestId`），属 `docs/149` Known Issue 1 的既定行为。

## Known Issues

1. **`requestId` 只对 7-A 之后经 HTTP 启动的运行可见**（沿用 `docs/149` #1）：旧运行、服务层启动、恢复与人工重试的运行在树上没有 `requestId`，其余关联键（`workflowRunId` / `taskId` / `agentRunId` / `toolCallId`）不受影响。
2. **树里没有事件层**：`workflow_events` 只用于取 requestId。事件时间线已有独立端点（`GET /api/workflows/:id/events`），本阶段不重复搬运；若日后要在树上叠加事件，属新决定。
3. **没有 `ci_runs` 节点**：CI 记录挂在部署的 `ciRunId` 字段上，未单独成节点（`docs/147` 7-C 点名的来源表不含 `ci_runs`）。
4. **失败任务的错误文本**：任务表本身不存 error，失败原因在 Agent Run 的 `error` 上——树上因此是「任务 FAILED + 其 Agent Run 的 errorCode/errorMessage」。
5. **追踪前端未做**（已裁定另立阶段）：本阶段只交付 API，无页面消费它。
6. **树是「当前状态」快照，不是事件重放**：任务状态会被后续重试覆盖（同一任务多次执行时，Agent Run 是多个子节点）。这是既有数据模型的事实，非本阶段的取舍。
7. **`detail` 是白名单，不是全量**：字段取舍见 Implementation 第 7 条；需要更多字段时应显式加白名单，不要改成透传。
8. **全量测试时序抖动**（既有登记 `docs/145` #7）：本批 `apps/server` 全量单跑 261/261 一次通过；全仓单次 `-r test` 仍有两条偶发失败（`failureRecovery.e2e` 的 CANCELLED 用例、`terminationPropagation.e2e` 的 FX-35 取消用例），单独复跑通过。与本次改动无关（两条都不经过 `TraceService` 或工作流路由），**不声称「一次全仓跑通」**。
9. **未做的 7-C 之外事项**（红线，不得误读为已完成）：7-E 决策事件契约、7-D 外部栈、`audit_logs` 处置、验证证据迁出提示词、自治 L1、追踪前端。

## Acceptance Result

| 验收项（`docs/147` §3 7-C） | 判定 | 证据 |
| --- | --- | --- |
| OB-07 树的节点数与数据库行数一致 | **通过** | `workflowTrace.e2e.test.ts`：`counts` 与直接 SQL 的 tasks / agent_runs / tool_calls / deployments 逐类 `toEqual`；`counts` 由遍历树得出，非查询结果长度 |
| OB-08 交付链四节点可见；production DEPLOY 等待审批时显示 `WAITING_APPROVAL` | **通过** | 同文件：任务节点标签为 `CI / STAGING / E2E / PRODUCTION`，状态为 `SUCCESS / SUCCESS / SUCCESS / WAITING_APPROVAL`；审批后 production 部署出现在 PRODUCTION 任务下 |
| 零新增依赖（§6 第 1 项） | **遵守** | `package.json` 未变 |
| 观测只读（§7） | **遵守** | 服务不写任何表；异常被吸收（requestId 查询）；`/api/workflows/:id/trace` 为 GET |
| 明文凭据不进追踪树（§7） | **遵守** | `traceService.test.ts`（脱敏 + 无 input/output）与 e2e（`redactCredentialShapedText(JSON) === JSON`） |
| 不引入 span 概念、不新增埋点（§3 7-C） | **遵守** | 数据全部来自既有表；无迁移、无新表 |

## Next Phase Boundary

**本子阶段结束（STOP）。未开始事项**：
- **7-E 决策事件契约**：未开工。开工前必须回答 `docs/147` §6 第 4 项（`output.verification` 是否迁出下游提示词）。
- **7-D 外部栈**（OTel / Prometheus 服务端 / Loki / Grafana）：已裁定延期。
- **追踪前端**：已裁定另立阶段。
- **自治 L1 实现**（L1-4 … L1-8）与 L1-1 … L1-3 的回归断言：未开工。
- **`provider` 运行时切换**：未开工（沿用 `docs/145` 边界）。

**需要你回答（唯一，仍是这一项）**：`docs/147` §6 第 4 项——`output.verification` 是否改为观测通道（事件或表）存放。它改变 Agent 的输入，需单独批准；不回答则 7-E 不能开工（M2 只剩它）。

---

## 后续（2026-10-15 同日追加；上文一字未改）

上面「需要你回答」的那一项**已回答**：`output.verification` **不迁存放位置**，改为**不进 Agent 输入**——`taskContextBuilder` 组装 `dependencyResults` 时剥掉 `verification`，存储侧与两个生产读取方（AC 覆盖判定、追溯表）一律不动。裁定依据（实测：1186 个任务带验证记录、平均 2.9 KB、53% 是原始 stdout/stderr、读取方从不读尾部、`dependencyResults` 只有一进一出）、实施与验收见 **`docs/151`**。`docs/147` §6 第 4 项与 §9、`docs/146` §4 已同步。

**7-E 的开工前置因此清空**：`docs/147` §6 五项至此全部落地，M2 只剩 7-E 一件未开工的事。
