# Database Design

> ## 基线状态（2026-10-15 逐条核实）
>
> 本文写于**平台实现之前**（第一版路线图的数据库设计），是**实现前设计**，不是 as-built 描述，
> **不构成开工依据**。原文一字未删（保留当初的设计意图），下面是对照现状的核实表：
>
> | 本文条款 | 与当前实现的关系 |
> | --- | --- |
> | 「核心表」16 张（projects / repositories / requirements / specifications / tasks / task_dependencies / agent_runs / tool_calls / workflow_runs / workflow_events / artifacts / test_runs / deployments / incidents / approvals / audit_logs） | **13 张逐名存在，1 张改名，2 张从未建**。实际共 **24 张表**（`packages/database/migrations/001–015`）。`artifacts` 实际叫 **`agent_artifacts`**；**`test_runs` 与 `incidents` 从未建**——`incidents` 属 Phase 8 AI SRE（未排期，全仓无 incident 表 / 路由 / 服务），`test_runs` 的职责由 `agent_artifacts` 的 Test Result 与 `evidence_records` 承担。**本文未列而已建的 11 张**：`users`、`agent_artifacts`、`deployment_environments`、`ci_runs`、`deployment_logs`、`mcp_servers`、`mcp_tools`、`mcp_tool_bindings`、`evidence_records`、`requirement_slices`、`requirement_acceptance_criteria` |
> | Agent Run 16 列 | **逐字一致**：`packages/database/migrations/002_phase2_persistent_agent_runtime.sql` 的 `agent_runs` 就是这 16 列，顺序也相同 |
> | Tool Call 13 列 | **逐字一致**：同迁移的 `tool_calls`，13 列一字不差，另有 `UNIQUE (agent_run_id, tool_call_id)` |
> | Workflow Events 用途（audit / recovery / debugging / replay / timeline） | **已实现**：`workflow_events` 表存在，统一承载 Workflow / Task / Agent 事件（`workflow_run_id` / `task_id` / `agent_run_id` 可关联） |
> | Phase 2 的 10 个事件类型（agent_run_created / agent_run_started / agent_action / agent_final / llm_retry / tool_call_started / tool_call_finished / agent_run_finished / agent_run_cancel_requested / agent_run_recovered） | **10 个全部在用**（逐个在生产代码里出现）。实际另有一个本文未列的 **`tool_call_requested`** |
> | Redis「用于 queue、distributed lock、cache、temporary state、event buffering」 | **已过时，且与 `docs/02` 直接冲突**。全仓核对：Redis **只**用于跨进程取消（`RedisCancellationStore`，键 `agent-run:<id>:cancel`，1h TTL）与健康检查，**没有** queue / lock / cache / 事件缓冲。**`docs/02` 的现行表述（「唯一职责 = 跨进程取消 + 健康检查；与 PostgreSQL 无重叠」）才是对的，两份文档冲突时以 `docs/02` 为准。** 本文这句是**实现前设计**，不要据它去假设平台有 Redis 队列 |
> | Phase 3：requirements 状态 DRAFT / ANALYZING / ANALYZED / FAILED | **已实现**（`RequirementStatusSchema`） |
> | Phase 3：specifications 按 requirement/type/version 保留历史 | **已实现**：`INSERT INTO specifications (project_id, requirement_id, type, version, status, content)`，version 由 `MAX(version)` 递增 |
> | Phase 3：tasks 含 task_key、type、status、priority、input traceability metadata 和 version | **已实现**（字段名与 `Task` 接口一致，见 `docs/05` 的基线状态表） |
> | Phase 3：task_dependencies 有唯一约束防重复边 | **已实现**；运行时另有 `active` 标志，**被 re-plan 替换的边是停用而非删除** |
> | Phase 3：「Specification + Task DAG 写入使用同一个 transaction；失败时不留下半成品 DAG」 | **已实现**：`packages/database/src/planningRepositories.ts` 的 `savePlanningResult` 在一个 `BEGIN … COMMIT` 里依次写 `specifications`、`tasks`、`task_dependencies`（切片路径的 `saveSlicePlanningResult` 同构） |
> | Phase 4：`workflow_runs` / `tasks` 复制为 RUNTIME / DYNAMIC / `task_dependencies` 关联 `workflow_run_id` 且可停用 / `approvals` / `workflow_events` 统一承载 | **已实现**：`Task.origin` 就是 `"ORIGINAL" \| "RUNTIME" \| "DYNAMIC"`；`TaskDependency` 有 `origin` 与 `active` |
> | Phase 4：「Task Claim 使用 workflow row lock、当前 RUNNING 数量和 `FOR UPDATE SKIP LOCKED` 在同一 transaction 内完成」 | **逐字实现**：`packages/database/src/workflowRepositories.ts` 的 `claimNextTask` —— `SELECT … FROM workflow_runs WHERE id = $1 FOR UPDATE` → 数 `status='RUNNING'` 的任务并与 `max_concurrency` 比较 → `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` → `UPDATE … SET status='RUNNING'`，全部在一个事务里 |
> | Phase 5：`agent_artifacts` 关联 project / task / agent_run / agent_name，保存各类产物 | **已实现**：列为 `id, project_id, task_id, agent_run_id, agent_name, type, name, content, metadata, created_at`；本文列的六类产物（Code Diff / Test Result / Review Result / Build Result / Documentation / Generated File）由 `type` 区分 |
> | Phase 5：「Agent Definition 保持代码注册表，避免为静态配置增加同步复杂度」 | **已实现**：`packages/agent-core/src/professional/AgentRegistry.ts` 是代码注册表，**全仓没有 `agents` 表** |
> | Phase 5：Agent 选择写 `tasks.assigned_agent`、Agent 类型写 `agent_runs.input` | **已实现**（`Task.assignedAgent` 为可选字符串） |
> | Phase 6：`deployment_environments` / `ci_runs` / `deployments` / `deployment_logs` 四张表 | **全部已建**（006 迁移），另有一张 007 的 PR traceability |
> | Phase 6：「Production Runtime Task 在复制时自动设置 `approval_required=true`」 | **已实现**：`packages/workflow-engine/src/WorkflowEngine.ts` 复制交付任务时置 `approvalRequired: delivery.environment === "production"` |
> | MCP Addendum：`mcp_servers` 建议字段 | **已建，且多两列**：实际多了 `env` 与 `cwd`；本文列的 `credential_ref` / `auth_ref` 只存引用的约定**成立** |
> | MCP Addendum：`mcp_tools` 建议字段 | **逐字一致**（含 `risk_level` / `requires_approval`） |
> | MCP Addendum：`mcp_tool_bindings` 建议字段含 `agent_id` | **已建，但字段名不同**：实际是 **`agent_name`**（字符串），不是 `agent_id`。这与「Agent Definition 是代码注册表、没有 agents 表」一致——**没有可外键指向的 agent 行**，所以只能存名字 |
> | MCP Addendum：「不提前建表：Resource、Prompt、MCP Apps 在对应 Sub-phase 实现之前不新增专用持久化模型」 | **守住了**：全仓只有 `mcp_servers` / `mcp_tools` / `mcp_tool_bindings` 三张 MCP 表，没有 resource / prompt / app 专用表 |
> | MCP Addendum：「MCP 调用复用现有 `tool_calls` / `audit_logs`，不建立第二套 MCP Audit 系统」 | **后半句成立（确实没有第二套系统），前半句当前不成立**：控制台触发的 MCP 调用**不产生 `tool_calls` 记录**，且 `audit_logs` 全仓无写入方。已登记于 `docs/146` §3，证据见 `docs/02` 基线状态表 |
>
> **结论**：**表结构与列定义这部分落地度很高**——Agent Run / Tool Call 两张核心表逐字一致，Phase 3 到 Phase 6 的设计几乎逐条实现，Phase 4 的 Task Claim 事务写法连细节都对得上。需要修正三处：① **Redis 那一句已过时且与 `docs/02` 冲突**（本文说它做 queue/lock/cache，实际只有取消与健康检查），**以 `docs/02` 为准**；② **`test_runs` 与 `incidents` 从未建**，`artifacts` 实际叫 `agent_artifacts`；③ **`mcp_tool_bindings` 是 `agent_name` 不是 `agent_id`**，且「MCP 调用复用 `tool_calls`」当前不成立。
> 依据：`AGENTS.md` §9「代码权威于文档；冲突必须报告，禁止默默改任一方来对齐」。

## PostgreSQL

核心表：

```text
projects
repositories
requirements
specifications
tasks
task_dependencies
agent_runs
tool_calls
workflow_runs
workflow_events
artifacts
test_runs
deployments
incidents
approvals
audit_logs
```

Phase 0 已建立基础业务表；后续 Phase 按需迁移新增表。

## Agent Run

至少：

```text
id
project_id
task_id
status
input
output
current_iteration
max_iterations
retry_count
started_at
finished_at
error
token_usage
estimated_cost
created_at
updated_at
```

## Tool Call

```text
id
agent_run_id
iteration
tool_call_id
tool_name
input
output
status
error
duration
started_at
finished_at
created_at
```

## Workflow Events

用于：

- audit
- recovery
- debugging
- replay
- timeline

Phase 2 至少记录：agent_run_created、agent_run_started、agent_action、agent_final、llm_retry、tool_call_started、tool_call_finished、agent_run_finished、agent_run_cancel_requested、agent_run_recovered。

## Redis

用于 queue、distributed lock、cache、temporary state、event buffering。Redis 不作为唯一事实来源；关键业务状态必须落 PostgreSQL。

## Phase 3

Phase 3 新增：

- requirements：保存 PRD / Requirement，状态为 DRAFT、ANALYZING、ANALYZED、FAILED。
- specifications：保存经过 Zod 和 Domain Validation 的结构化规格，按 requirement/type/version 保留历史。
- tasks：保存由 Requirement 生成的静态工程 Task，包含 task_key、type、status、priority、input traceability metadata 和 version。
- task_dependencies：保存 source_task_id → target_task_id 依赖边，并使用唯一约束防止重复边。

Specification + Task DAG 写入使用同一个 transaction；失败时不留下半成品 DAG。

## Phase 4

- `workflow_runs`：保存 Workflow 状态、Planning Version、并发与失败策略、输出和错误。
- `tasks`：Phase 3 原始 Task 保持不变；Workflow 创建时复制为 `RUNTIME` Task，动态 re-plan 创建 `DYNAMIC` Task。
- `task_dependencies`：运行时依赖关联 `workflow_run_id`，支持停用被 re-plan 替换的边。
- `approvals`：保存 Task 审批请求和 APPROVED / REJECTED 决策。
- `workflow_events`：可关联 workflow_run_id、task_id、agent_run_id，统一承载 Workflow、Task 和 Agent 事件。

Task Claim 使用 workflow row lock、当前 RUNNING 数量和 `FOR UPDATE SKIP LOCKED` 在同一 transaction 内完成。

## Phase 5

- `agent_artifacts`：关联 project、task、agent_run、agent_name，保存 Code Diff、Test Result、Review Result、Build Result、Documentation 和 Generated File。
- Agent Definition 保持代码注册表，避免为静态配置增加同步复杂度。
- Agent 选择写入 `tasks.assigned_agent`，Agent 类型写入 `agent_runs.input`，继续复用 Phase 2 审计表。

## Phase 6

- `deployment_environments`：项目级 dev/staging/production endpoint、非敏感配置和 Secret Reference。
- `ci_runs`：Workflow/Task/AgentRun、Git Commit、PR、CI provider run、immutable image 和结果。
- `deployments`：版本、环境、镜像、Commit、health check、rollback metadata 和 idempotency key。
- `deployment_logs`：安全裁剪后的部署过程日志。
- Production Runtime Task 在复制时自动设置 `approval_required=true`。


## MCP Persistence Addendum

Phase 5.5 MVP 增加三张核心表：

### mcp_servers

用于保存 Server 注册信息和连接状态。

建议字段：

```text
id
name
description
transport
endpoint
command
args
status
enabled
auth_ref
credential_ref
created_at
updated_at
last_connected_at
last_error
```

其中 `credential_ref` / `auth_ref` 只保存引用，不保存明文凭据。

### mcp_tools

保存 MCP Server Discovery 得到的 Tool 元数据：

```text
id
mcp_server_id
name
description
input_schema
enabled
risk_level
requires_approval
created_at
updated_at
```

### mcp_tool_bindings

表示 Project / Agent 对 MCP Server / Tool 的显式授权：

```text
id
project_id
agent_id
mcp_server_id
mcp_tool_id
enabled
created_at
updated_at
```

### 不提前建表

Resource、Prompt、MCP Apps 在对应 Sub-phase 实现之前不新增专用持久化模型，避免过早设计。

### Existing Audit

MCP 调用复用现有：

- `tool_calls`
- `audit_logs`

不建立第二套 MCP Audit 系统。
