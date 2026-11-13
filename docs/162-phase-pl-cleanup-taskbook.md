# 162 · 批次前缺陷清理任务书（PL-C1 / PL-C2 / PL-C3）

> 状态：**PL-C1 / PL-C2 / PL-C3 三项已于 2026-10-16 全部实施完成**（用户同日「先清掉这几条，再跑 PL-M4」授权，范围裁定 **1+2+3**；实施记录 **`docs/163`**）。**PL-M4（批次复验 E1×3）未开工**，需先确认周配额余量。
> 编号：里程碑 **PL-C1 / PL-C2 / PL-C3**（C = cleanup）。**不新造验收编号**——三项修的都是缺陷，不是新增能力。
> 依据：`docs/146` §3（登记账正本）、`docs/159` Known Issue 3、`docs/161` Known Issue 4、`docs/146` §6 规则 7/8、`AGENTS.md` §9/§10。
> 性质：**本文件是改动方案**；实施结果以 **`docs/163`** 为准。**本文件 §2 记录的「新发现的一半」在实施前已向用户说明**（见 §Known Issues 1）。

## 0. 为什么先做这一批

用户 2026-10-16 质询：「不应该是先把存在缺陷的地方都修复好了再跑任务验证测试吗，为什么我看到你是先跑任务之后再修问题呢」——**验收批次是验证修复的，不是发现缺陷的**。核对登记账后确认：M4（E1×3，6.7M 输入 token）跑之前，沙箱写权限缺陷已记在 `docs/115` / `docs/129`、沙箱离线依赖已登记在 `docs/127` §5 #8（2026-10-08，距 M4 七天），**登记了但没修**就跑了批次；M4 的 run 2 因此死在**已知可避免**的缺陷上，三次运行的归因从「三次同因」变成「两次计划器 + 一次已知缺陷」。

本批是这条规则的第一次执行：**跑 PL-M4 之前，把登记账里还剩的缺陷清掉。**

## 1. 范围（用户裁定 1+2+3）

| # | 里程碑 | 条目 | 登记处 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | **PL-C1** | 读取侧拒绝不留痕 | `docs/159` Known Issue 3 | **真缺陷** |
| 2 | **PL-C2** | agent 用量元数据（`tokenUsage` 累积 + `estimatedCost` 产出方） | `docs/146` §3 / `docs/03` / `docs/14` 基线状态表 | **真缺陷**（含本任务书 §2 新发现的一半） |
| 3 | **PL-C3** | `AgentRegistry.debugTarget` 未校验 `as TaskType` | `docs/161` Known Issue 4 | **真缺陷**（与 PL-M3 同类） |

**明确排除**（用户 2026-10-16 裁定范围 1+2+3）：

| # | 条目 | 排除理由 |
| --- | --- | --- |
| 4 | 控制台触发的 MCP 调用不产生 Tool Call / Audit 记录 | 真缺陷，但修它要先裁定 `agentRunId` 口径（现伪造 `randomUUID()`，撞 `tool_calls.agent_run_id` 的 NOT NULL 外键；`MCPAppServiceOptions` 的接口注释已**刻意押后**）。属独立子阶段，**本批不动** |
| 5 | MCP 控制台声称的 7 个操作里有 4 个没有实现 | **不是缺陷**——`docs/17` 节「5.5-5 Console」的验收项**全是只读 / 展示类**，那四个操作**从未被列为验收**（`docs/146` §3 原文）。属未实现的功能面，**本批不动** |
| 6 | 门禁抖动范围比先前记录的更宽 | 独立议题（`docs/161` Known Issue 7），**本批不动** |

## 2. PL-C2 的基线事实（本任务书新发现的一半）

登记账里的第 2 条只写了「`estimatedCost` 全仓无产出方」。**设计修法时在同一条代码路径上发现了更严重的一半**：`tokenUsage` 有产出方，但产出的是**错的数**。

### 2.1 机制

| 事项 | 现状（代码核对） | 证据 |
| --- | --- | --- |
| 外层图的 `metadata` reducer | **覆盖式**合并——`(left, right) => ({ ...left, ...right })` | `packages/agent-core/src/graph/AgentGraph.ts:79-82` |
| `agentNode` 每轮的写入 | `metadata: usageMetadata(response) ? { tokenUsage: usageMetadata(response) } : {}` | `AgentGraph.ts:274` |
| 生产路径的 provider | `DeepAgentLLMProvider.invoke` 在内部跑完整个 deep agent 循环，只把**最后一条消息**的 `usage_metadata` 交回 | `packages/agent-core/src/professional/DeepAgentLLMProvider.ts:69-75` |
| 迭代数的来源 | `response_metadata.agentIterations = backend.iterations`（内层循环次数），**不是**外层图轮数 | `DeepAgentLLMProvider.ts:72-74` |

**合起来**：一次 agent run 内层可能跑 90 次 LLM 调用，落库的 `token_usage` 只是**第 90 次那一次调用**的用量。

### 2.2 证据

**探针（决定性）**——用真实 `AgentRunner` + 一个按队列返回 `usage_metadata` 的 provider，两次调用分别 `100/10` 与 `200/20`：

```
PROBE tokenUsage = {"input_tokens":200,"output_tokens":20,"total_tokens":220}
```

记录的是**最后一次**（200/20）。累加应为 300/30。**探针为一次性文件，跑完即删**（`packages/agent-core/src/__tests__/__probe-tokenusage.test.ts`，已删除）。

**库中佐证**（2026-10-16 只读实查）：

| 观测 | 值 |
| --- | --- |
| `current_iteration = 90` 且 `tool_calls = 90` 的那一行 | `input_tokens = 66,323`（其中 `cache_read = 65,536`——**正是一次调用的形状**） |
| 全库 `max(input_tokens)` | **165,794**（而最大迭代数为 90；若为整轮累计，量级应是百万） |
| 全库 `max(current_iteration)` | 202 |

**为什么一直没被发现**：**全仓没有任何测试断言 `tokenUsage`**（`grep tokenUsage --include="*.test.ts"` 零命中）；`ScriptedCodingLLMProvider` 不产出 `usage_metadata`，故这条路径从未被测过。

### 2.3 后果

- **工作流级 `maxTokens` 预算门比对的不是整轮用量**——`sumRunUsage`（`packages/database/src/workflowRepositories.ts:866-890`）把每个 run 的「单次调用」当「整轮」求和，`WorkflowEngine` 再用它与 `policy.maxTokens` 比较（`WorkflowEngine.ts:559`）。**该门因此形同虚设。**
- `/api/metrics` 的 `ai_se_estimated_cost` / token 指标、`/api/workflows/:id/trace` 的用量、eval 的用量口径**全部偏低**。
- **更正**：`docs/146` §3 第 2 条登记写的「实际生效的预算上限只有 token 与墙钟两项」**不准确**——**只有墙钟一项可靠**。本任务书据实更正，登记账在收口时同步。

### 2.4 为什么与 `estimatedCost` 必须同批修

`estimatedCost` 要落在**同一条** `metadata` 路径上。若只加产出、不修累积，产出的是「最后一次调用的成本」而不是「整轮成本」——**那是看起来可信的错值，比今天的 `null`（「未知」）更糟**。故 PL-C2 的两半必须一起做。

## 3. 各里程碑的判据

### PL-C1 读取侧拒绝留痕

| 判据 | 期望 |
| --- | --- |
| `ls` / `read` / `readRaw` / `grep` 被读权限拒绝时，**沙箱零调用** | 保持（拒绝仍发生在调用 Tool Runtime 之前） |
| 同一次拒绝**落一条** `results` 条目 + **一条** `tool_calls`（failed） | 新增（此前两边都没有） |
| 拒绝信息含**生效的读范围** | 新增（与 PL-M5 的写侧对称：`describeReadScope`） |
| 不新增错误码 | 复用 `TOOL_ERROR`（`AGENTS.md` §10） |
| 未声明 `readPaths` 之外的 agent 行为不变 | 保持 |

### PL-C2 agent 用量元数据

| 判据 | 期望 |
| --- | --- |
| 多轮 LLM 调用 → `tokenUsage` 是**累计值** | 新增（探针的两次调用应得 300/30） |
| `DeepAgentLLMProvider` 返回**内层全部 AIMessage 的用量之和** | 新增 |
| 配置了价目 → `agent_runs.estimated_cost` 落值；未配置 → 维持 `NULL`（**不编造**） | 新增 |
| `sumRunUsage` 的 `estimatedCostUsd` 在配置价目后**非 null** → `maxCostUsd` 门可触发 | 新增 |
| 历史数据不变 | 已落库的行**不回溯修改**（口径变更点登记在案） |

### PL-C3 `debugTarget` 消费侧校验

| 判据 | 期望 |
| --- | --- |
| `input.targetTaskType` 非 `TaskType` 成员 → 不接受 | 新增 |
| 值落在运行期专属类型（`DEBUG` / `MONITOR` / `INCIDENT`）→ 不接受 | 新增（与 PL-M3 同口径） |
| 不可用时 `resolveTask` 的报错**指明真实原因**，不再误报 `task type DEBUG` | 新增 |
| 合法值行为**逐字不变** | 保持 |
| 判定只有**一份**定义（不再新增第三份副本） | 见 §4 裁定 3 |

## 4. 设计裁定（本任务书的推荐值）

| # | 事项 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | `tokenUsage` 的累积位置 | **在 `agentNode` 显式累加**（读 `state.metadata.tokenUsage` 求和后写回），**不改** `metadata` 的通用 reducer | reducer 是 `Record<string, unknown>` 的通用合并，为单个键改它会波及全部 metadata 字段 |
| 2 | 成本价目从哪来 | **配置注入**（`apps/server` 新增两个可选 env），**不写代码内静态价表** | 部署的模型是**网关别名**（`OPENAI_MODEL=deepseek-v4.1-flash`，`OPENAI_BASE_URL=https://opencode.ai/zen/go/v1`），静态表换模型即失准。未配置 → 不产出（维持 `null`），**不编造数字** |
| 3 | 「运行期专属任务类型」的判定放哪 | **上移到 `packages/shared`**，三处消费方共用一份 | 现状已有**两份**副本（`agent-core/src/planning/validateTaskGraph.ts:27`、`workflow-engine/src/WorkflowEngine.ts:41`，后者注释自陈「同义」）；PL-C3 会引入第三份。`AGENTS.md` §3「跨包共享的类型/契约放 `packages/shared`」；`docs/160` 已把「重复定义必然漂移」记为本仓库的缺陷成因类型。**本项是唯一一处超出「最小改动」的架构调整，如实报告。** |
| 4 | 拒绝留痕的通道 | 复用 `denyWrite` 既有的那条（`onToolEvent` + `ToolCallRecorder`），**不新开记录面** | `AGENTS.md` §10：禁止第二套 Audit 体系 |

## 5. 验证分层

| 层 | 位置 |
| --- | --- |
| 单测 | `packages/agent-core/src/__tests__/`（C1 读侧拒绝、C2 累积与内层求和）、`packages/agent-core/src/professional/` 同目录（C3）、`packages/shared` 同目录（裁定 3 的判定函数） |
| 回归 | `apps/server/src/__tests__/`（C2：价目配置 → `estimated_cost` 落库 → `sumRunUsage` 非 null） |
| 门禁 | 受影响包 `typecheck && lint && test`；收尾前全仓 `-r run typecheck && lint && test` |

## 6. 边界与红线

- 不新增错误码 / 不新建第二套 Permission / Approval / Audit 体系。
- 不回溯修改历史 `agent_runs` 行。
- 不改 `EvalPolicy`（P0 冻结基线，`docs/109` §架构判定 6）。
- 不改 L1-8 判据口径、不改提示词、不动 `packages/eval` 的夹具。
- 不修改任何 `dist/`。
- **PL-M4 仍未开工**；本批完成后**需先确认周配额余量**（M4 实测单批约 6.7M 输入 token × 3 批）。
