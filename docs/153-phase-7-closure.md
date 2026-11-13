# 153 · 阶段 7 收口记录：可观测性（Observability）

> 日期：2026-10-15 ｜ 类型：**阶段 7 收口动作**（用户点名「开始 Phase 7 收口」）
> 依据：`docs/147` §5（退出条件）、§3（六项与 M3 的处置）、`docs/17` 节「Phase 7 — Observability」、`docs/146` §6 维护规则 1 / 6 / 7 / 8、`AGENTS.md` §9。
> 承接：`docs/149`（M1：7-A / 7-B）、`docs/150`（7-C）、`docs/151`（验证证据解耦）、`docs/152`（7-E）。
> 性质：**本文件是记账与回填，不是新的实现阶段。** 收口**未改任何代码、未改任何测试、未新增依赖**——只回填验收清单、把活文档基线更新到收口时的事实，并落定任务书显式留给收口的一处判定（Prometheus）。

## Modified Files

**代码 / 测试 / 依赖**：**无**。交付物已由 `docs/149`–`docs/152` 落地；本次只做只读复核（逐个确认文件在盘）。

**文档（新增 1 / 修改 10）**

- 新增：本文件 `docs/153-phase-7-closure.md`。
- `docs/17-acceptance-checklist.md`：Phase 7 六项逐项回填（完成 / 替代 / 延期）。
- `docs/12-observability.md`：文首基线表更新到收口时的事实（技术栈行、结论行、任务书行、标题）。
- `docs/146-global-completion-status.md`：§0（新增状态词「已收口」）、§1（总览段 + 表行 7）、§2.1（Phase 7 行）、§3（归位统计行 + Phase 7 行）、§5（门禁记录 + 全仓单次运行的口径改写）。
- `docs/15-development-roadmap.md`：Phase 7 节头状态。
- `docs/18-phase-engineering-goals.md`：Phase 7「当前实现进度」整节重写（含验收口径的部分覆盖声明）。
- `docs/127-project-status-overview.md`：文首「最近更新」+ §0 一句话状态。
- `docs/147-phase-7-taskbook-observability.md`：状态行 + §9 审阅轮记录追加收口条。
- `docs/151` / `docs/152`：各追加一节「后续」（**历史记录不回改，只追加**）。
- `docs/19-user-manual.md`：第 19 节「已知限制」中「没有完整 Phase 7 Observability」一句改为按收口后的事实分述（已交付什么 / 未引入什么）。
- `README.md`：现状说明。

**未修改**：`docs/01–11`、`docs/13`、`docs/14`（实现前设计，本次不重新基线）；`docs/16`；`docs/133–145` 等历史阶段记录正文；任何 `src/`、任何测试、任何 `dist/`。

## Implementation

收口 = `docs/147` §5 的三项条件，逐项如下。

### 1. `docs/17` 的 Phase 7 六项逐项回填

| # | 项 | 处置 | 依据 |
| --- | --- | --- | --- |
| 1 | OpenTelemetry | **延期**（不勾选） | 不引入 `@opentelemetry/*` 依赖与外部栈（`docs/147` §6 第 1 项）。追踪能力由 7-C 以数据库派生的树交付，但**不导出 OTel span**——两者不可互读为同一件事 |
| 2 | Prometheus | **延期（部分替代）**（不勾选） | 平台侧抓取契约已由 7-B 的零依赖文本端点交付（`GET /api/metrics` 即 Prometheus 文本格式）；**服务端与抓取未部署**。不勾选＝栈组件确未引入；其能力面已计入第 6 项 |
| 3 | Grafana | **延期**（不勾选） | 无面板栈；其数据源（Prometheus 服务端 / Loki）同样未引入 |
| 4 | Loki | **延期**（不勾选） | 日志仍为 stdout 结构化 JSON（经 `@ai-se/observability` 脱敏），未引入日志收集栈 |
| 5 | End-to-end trace | **完成**（已勾） | 7-C：`GET /api/workflows/:id/trace`；OB-07 / OB-08（`docs/150`） |
| 6 | Agent/Tool/Workflow metrics | **完成**（已勾） | 7-B：`GET /api/metrics`；OB-04 … OB-06（`docs/149`） |

**第 2 项是本收口唯一的判定**，且是任务书自己留给收口的（`docs/147`:100「在收口时按 §5 判定为『替代』或『延期』」）。判为「延期（部分替代）」而非勾选，理由是：清单里这一项写的是**栈组件**，勾选会被读成「引入了 Prometheus」——实际没有；而它要服务的能力（指标可被标准抓取器读取）已经成立，并已在第 6 项计分。用户 2026-10-15 采纳此判定。

M3（7-D 外部栈）按 §3 裁定处理：**延期**，不作为收口条件，已在 `docs/17` 中显式标注（上表 1–4 行）。

### 2. `docs/12` 基线表更新到收口时的事实

- 「技术栈 OTel / Prometheus / Grafana / Loki」行：由「**未实现**：四个依赖一个都没有」改为「**四项均未引入**……其中 Prometheus 为『延期（部分替代）』」。
- 「结论」行：删去「技术栈与外部栈从未开工」这一已被部分覆盖的旧结论，改为逐项事实 + 收口标记。
- 「任务书」行：由「只剩收口动作」改为「**已于 2026-10-15 收口**」，并补收口记录编号。
- 文首标题：标注「2026-10-15 Phase 7 收口时复核」。

### 3. `docs/146` 同步

§0 新增状态词「**已收口**」（并写明它与「部分达成」的区别：前者是**经裁定不做**，后者是**判据未达到**）；§1 总览段与表行 7；§2.1 的 Phase 7 行；§3 归位统计（Phase 7 的 4 项外部栈由「部分达成」改记「已收口（延期）」，合计仍 73；**其余分布数字未重算**，该处已注明本次只做这一处移动）；§5 追加本次门禁记录。

### 4. 其余活文档（`AGENTS.md` §9 的阶段收尾要求）

`docs/15` 节头、`docs/18` 进度节、`docs/127` 文首与 §0、`docs/19` 已知限制一句、`README.md` 现状说明、`docs/147` 状态行与 §9。`docs/151` / `docs/152` 属历史记录，**只追加不回改**（`docs/146` §6 规则 7）。

## Architecture Changes

无。本收口不改任何架构、接口、状态机、包边界或依赖。

## Dependencies

无新增（含 devDependencies）。Phase 7 全程零新增依赖（`docs/147` §6 第 1 项裁定）。

## Tests

本收口**未改代码与测试**，因此不产生新的用例。作为收口证据，重跑全仓门禁（`docs/147` §4 的口径：收尾跑全仓 `-r`），并逐项复核 OB-01 … OB-10 的落点仍在盘：

| OB | 判据 | 落点（本次复核在盘） |
| --- | --- | --- |
| OB-01 | 工具日志带 `workflowRunId`，与 `tool_calls` 行一一对齐 | `apps/server/src/__tests__/workflowCorrelation.e2e.test.ts`；`deliveryApi.e2e.test.ts` |
| OB-02 | `WORKFLOW_STARTED` 的 requestId == HTTP 响应 requestId | 同上；`packages/workflow-engine/src/WorkflowEngine.test.ts` |
| OB-03 | 既有 API 响应形状不变、日志仍经脱敏 | 全量既有 API 契约用例（不回归） |
| OB-04 | 输出可被最小 Prometheus 解析器解析 | `apps/server/src/__tests__/prometheusText.test.ts` |
| OB-05 | 九项数值与直接 SQL 聚合一致（误差 0） | `apps/server/src/__tests__/metricsEndpoint.e2e.test.ts` |
| OB-06 | 输出不含凭据形状字符串 | 同上 |
| OB-07 | 追踪树的节点数与数据库行数一致 | `apps/server/src/__tests__/workflowTrace.e2e.test.ts` |
| OB-08 | 交付链四节点可见；production DEPLOY 待审时显示 `WAITING_APPROVAL` | 同上 |
| OB-09 | 契约以 zod 定义，单测覆盖合法与非法 payload | `packages/shared/src/autonomyContract.test.ts` |
| OB-10 | 现有事件类型与既有 payload 不变 | 既有事件用例不回归（全仓门禁） |

门禁结果（`docs/147` §4 的口径）：

| 命令 | 结果 |
| --- | --- |
| 全仓 `corepack pnpm -r run typecheck` | **通过**（退出码 0） |
| 全仓 `corepack pnpm -r run lint` | **通过**（退出码 0） |
| 全仓 `corepack pnpm -r run test`（第 1 次） | **261/263 通过**（50 个文件：48 passed / 2 failed） |
| 全仓 `corepack pnpm -r run test`（第 2 次） | **16 个包全绿、无失败、无抖动**（合计 **1507** 条）：`apps/server` **263/263**（50 文件）、`apps/web` 473/473、`mcp` 235/235、`agent-core` 160/160、`visual` 83/83、`shared` 57/57、`database` 47/47、`browser` 38/38、`workflow-engine` 36/36、`eval` 35/35、`tool-runtime` 32/32、`failure-recovery` 16/16、`action-policy` 13/13、`evidence` 9/9、`sandbox` 7/7、`observability` 3/3 |
| `apps/server` 单独复跑 `failureRecovery.e2e.test.ts` | **10/10 通过** |
| `apps/server` 单独复跑 `projects.test.ts` | **6/6 通过** |

**两条失败的性质（如实记录；不修、不掩盖、不据此扣减收口判定）**：

1. `failureRecovery.e2e.test.ts` 的「external CANCELLED action is not auto-recovered」——断言 `workflow.status === "FAILED"`，实得 `SUCCESS`。**同一文件、同一用例**在 `docs/149` 与 `docs/150` 的全量运行中已两次以同样方式失败，每次单独复跑均通过（本次 10/10）：属 `docs/145` #7 / `docs/146` §5 已登记的**负载敏感抖动**，非本阶段引入。
2. `projects.test.ts` 的「creates a project without a repository and binds one later (UX-01)」——`Test timed out in 5000ms`；该用例单独复跑耗时 **3.65s**（6/6 通过），即全量并发下越过了 5s 上限，同属资源竞争类抖动。

两条都**不涉及本阶段改动**（本收口零代码改动），故不改变收口判定。**第 2 次单次全仓运行 16 个包全绿**，与 `docs/152` 记录的那次一次通过同口径——两条失败据此确认为抖动，而非回归。

## Lint

- 全仓 `corepack pnpm -r run lint`：**通过**（退出码 0，16 个包全部 `Done`）。
- 本收口未改代码，因此 lint 通过是**对收口前状态的复核**，不是新代码的验证。

## Typecheck

- 全仓 `corepack pnpm -r run typecheck`：**通过**（退出码 0）。
- 同上：该命令会重建相关包的 `dist`（构建产物，未读取），并触发 `tsx watch` 下的后端重启——本次未做运行期实验，只做只读走查（见 §E2E）。

## E2E

- **本收口不产生新的 e2e**（无代码改动）。OB-07 / OB-08 的 e2e（`workflowTrace.e2e.test.ts`，真 postgres:16 容器 + 真 HTTP + 本地交付链）与 OB-01 / OB-02 的 e2e（`workflowCorrelation.e2e.test.ts`）在全仓门禁中一并跑，结果见上表。
- **只读走查**（2026-10-15，收口时对运行中的实例；不触发任务、不写数据）：

  | 请求 | 结果 |
  | --- | --- |
  | `GET /health` | `200` |
  | `GET /api/metrics` | `200`，Prometheus 文本格式（`# HELP` / `# TYPE` 行 + 样本行，如 `ai_se_agent_runs{status="succeeded"} 2164`） |
  | `GET /api/workflows/<不存在的 uuid>/trace` | `404` + `{"success":false,"error":{"code":"WORKFLOW_NOT_FOUND",…},"requestId":"…"}`——路由已注册、错误封套与 7-A 的 `requestId` 回传均成立 |
  | `GET /api/workflows/<真实 run id>/trace` | `200`，树真实完整：`counts` = `{"tasks":19,"agentRuns":16,"toolCalls":503,"deployments":0}`；根为 `workflow`（`FAILED`，含 `errorCode` / `errorMessage` / 耗时 2612313ms），其下逐层 `task → agentRun → toolCall`（如 `AUTH-ANL-01 → planner-agent → list_directory / read_file / submit_result`） |

  该走查是**只读**的：仅 `GET`，未启动任何工作流、未写任何行，符合 `docs/147` §7 的「观测只读」红线。

## Known Issues

1. **验收口径是部分覆盖，不声称全部达成。** `docs/18` 的 Phase 7 验收原文为「一次真实 Agent Run 可以**从前端/服务入口**追踪到具体 Tool 和 Sandbox 执行，并能在 **Dashboard** 查看关键指标」。收口后的实际覆盖：**服务入口达成**（7-C 的树覆盖 `Workflow → Task → AgentRun → ToolCall`，部署挂在其任务下）；**前端未做**（追踪前端已裁定另立阶段，`docs/147` §6 第 5 项）；**Sandbox 不单独成节点**（沙箱是工具执行路径，不是事实表——见 `docs/150`）；「Dashboard 查看指标」沿用既有 `GET /api/agents/metrics` 的业务口径（前端已用），Prometheus 面板属延期的 7-D。此声明已就地写入 `docs/18`。
2. **4 项延期不等于「不需要」。** OTel / Grafana / Loki 的缺口是真实的：没有 span 导出、没有日志收集栈、没有面板。它们不是「用别的方式做到了」，而是**经裁定不做**（依赖与基础设施两项均未获批准）。日后若要引入，须按 `docs/130` 的形态另写任务书，不构成对本次收口的追认。
3. **第 2 项（Prometheus）的判定可一句话翻转。** 若日后认为「平台侧抓取契约成立」即算达成，只需把 `docs/17` 该项勾上、`docs/146` §3 改记「已闭环」——只涉及这三处措辞，不涉及代码。
4. **`docs/12` 的 `incidentId` 仍是错误前提，本次未处理**：Phase 8（AI SRE）未排期，全仓仍无 incident 表 / 路由 / 服务。基线表中「动工时应剔除该 ID」的判断继续有效。
5. **未做（红线，不得误读为已完成）**：自治 L1 的任何实现（L1-4 … L1-8）与 L1-1 … L1-3 的回归断言；7-D 外部栈；追踪前端；`provider` 运行时切换；`audit_logs` 的处置（仍为休眠表，`docs/147` §6 第 3 项）。
6. **门禁抖动的口径已按事实改写**（`docs/145` #7 / `docs/146` §5）：全仓单次 `-r test` 既出现过**一次跑通**（本次第 2 次、`docs/152`），也出现过**偶发一两条 e2e 失败**（本次第 1 次）。`docs/146` §5 原有的单侧口径（「不声称一次跑通」）已改为**逐次如实记录、不做单侧断言**。两条失败均**未修**——非本阶段引入，且单独复跑通过。

## Acceptance Result

| 收口条件（`docs/147` §5） | 判定 | 证据 |
| --- | --- | --- |
| M1 + M2 全绿（OB-01 … OB-10） | **通过** | 逐项落点见上表；`docs/149`（OB-01…OB-06）、`docs/150`（OB-07/08）、`docs/152`（OB-09/10） |
| `docs/17` 的 Phase 7 六项逐项回填（完成 / 替代 / 延期） | **通过** | `docs/17` 节「Phase 7 — Observability」；本文件 §Implementation 1 |
| `docs/12` 基线表更新到收口时的事实 | **通过** | `docs/12` 文首基线表 |
| `docs/146` §1 / §2.1 / §3 同步 | **通过** | `docs/146` §0 / §1 / §2.1 / §3 / §5 |
| M3（7-D 外部栈）按裁定显式标注 | **通过** | `docs/17` 四项延期注记；`docs/147` §3 7-D |
| 未引入新依赖 / 未新增第二套体系（`docs/147` §7 红线） | **遵守** | 本收口零代码改动；Phase 7 全程零新增依赖；事件写进既有 `workflow_events`，脱敏复用既有 sanitize |
| 观测只读（不改任务结果、状态机、审批语义） | **遵守** | 7-C 的 trace 与 7-B 的 metrics 均为只读查询；`docs/151` 的改动是**移除** Agent 输入里的一项，不是新增行为 |

## Next Phase Boundary

**阶段 7 结束（STOP）。未开始事项**：

- **自治 L1 的实现**（L1-4 … L1-8）与 L1-1 … L1-3 的回归断言：**未开工**。其验收定义已完成、两项待裁定已清空、三项依赖（7-A / 7-B / 7-C + 7-E）已全部就绪——**这是 Phase 7 之后最有依据的下一步**，但仍需用户点名。
- **7-D 外部栈**（OpenTelemetry / Prometheus 服务端 / Loki / Grafana）：已裁定延期，需依赖与基础设施两项批准。
- **追踪前端**：已裁定另立阶段。
- **Phase 8 AI SRE**（12 项）：从未进入任何任务书（v1 建设、硬化 A–G、前端 W 线均不含）。
- **`provider` 运行时切换**、**`audit_logs` 处置**、**`docs/01–11 / 13 / 14` 的重新基线**：未开工，沿用既有边界。

**需要你回答**：无。Phase 7 的收口条件已全部满足；下一阶段由你点名。
