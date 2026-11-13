# 163 · 批次前缺陷清理实施记录（PL-C1 / PL-C2 / PL-C3）

> 日期：2026-10-16 ｜ 类型：**批次前缺陷清理 · 三项里程碑**（任务书 `docs/162`；用户同日「先清掉这几条，再跑 PL-M4」授权，范围裁定 **1+2+3**）
> 依据：`docs/146` §3（登记账正本）、`docs/159` Known Issue 3、`docs/161` Known Issue 4、`docs/146` §6 规则 7/8、`AGENTS.md` §9/§10。
> 范围：**只做 PL-C1 / PL-C2 / PL-C3**。**PL-M4（批次复验 E1×3）未开工。**

## Modified Files

**`packages/shared/`**
- `src/index.ts`（改）：新增 `RUNTIME_ONLY_TASK_TYPES` / `isRuntimeOnlyTaskType` / `isUsableTargetTaskType`——「运行期专属任务类型」与「可用目标工作类型」的**唯一一份**判定。
- `src/taskTypeClassification.test.ts`（**新增**，8 条）。

**`packages/agent-core/`**
- `src/llm/usage.ts`（**新增**）：用量累加与计价的唯一一份口径——`sumTokenUsage` / `totalTokenUsage` / `ModelPricing` / `estimateCostUsd`。
- `src/__tests__/usage.test.ts`（**新增**，9 条）。
- `src/graph/AgentGraph.ts`（改）：`agentNode` 改为**显式累加** `tokenUsage` 与 `estimatedCost`（此前每轮覆盖式写入，整轮只剩最后一次调用）。
- `src/__tests__/agentGraph.test.ts`（改）：+3 条（跨轮求和 / 成本求和 / 未配置价目不产出）。
- `src/professional/DeepAgentLLMProvider.ts`（改）：新增第 5 个构造参数 `pricing`；返回**内层全部 AIMessage 的用量之和**，并按价目在 `response_metadata.estimatedCostUsd` 上写成本。
- `src/professional/DeepAgentLLMProvider.test.ts`（改）：+2 条。
- `src/professional/ProfessionalAgent.ts`（改）：`ProfessionalAgentOptions.modelPricing` 透传给 provider。
- `src/professional/ProfessionalAgent.test.ts`（改）：+2 条（价目 → `AgentResult.estimatedCost`）。
- `src/professional/ToolRuntimeBackend.ts`（改）：PL-C1——`denyWrite` 抽出 `recordDeniedCall`，新增 `denyRead` 与 `describeReadScope`；`ls` / `read` / `grep` 的读权限拒绝改为**留痕**。
- `src/professional/ToolRuntimeBackend.test.ts`（改）：+3 条。
- `src/professional/AgentRegistry.ts`（改）：PL-C3——`debugTarget` 加成员判定；`resolveTask` 在 DEBUG 派不出去时报**真实原因**。
- `src/professional/AgentRegistry.test.ts`（改）：+2 条。
- `src/planning/validateTaskGraph.ts`（改）：改用 shared 的 `isRuntimeOnlyTaskType`（删除本地副本）。
- `src/index.ts`（改）：导出 `estimateCostUsd` / `sumTokenUsage` / `totalTokenUsage` / `ModelPricing`。

**`packages/workflow-engine/`**
- `src/WorkflowEngine.ts`（改）：删除本地 `TASK_TYPE_OPTIONS` / `RUNTIME_ONLY_TARGET_TYPES` / `isUsableTargetType`，改用 shared 的 `isUsableTargetTaskType`（**行为逐字不变**）。

**`apps/server/`**
- `src/config.ts`（改）：新增 `MODEL_INPUT_PRICE_PER_MTOK` / `MODEL_OUTPUT_PRICE_PER_MTOK`（两个都配才生效）→ `AppConfig.modelPricing`。
- `src/config.test.ts`（改）：+3 条。
- `src/index.ts`（改）：把 `config.modelPricing` 交给执行器与 `LangChainLLMProvider`。
- `src/services/workflowTaskExecutor.ts`（改）：依赖新增 `modelPricing`，透传给 `ProfessionalAgent`。

**`.env.example`**（改）：新增两个价目变量（含「两个都配或不配」的说明）。

**文档**：本文件；`docs/162`（状态）；`docs/146` §3 / §5；`docs/159`、`docs/161`（各追加勘误块）；`docs/127` §9。

## Implementation

### PL-C1 · 读取侧拒绝留痕

`ToolRuntimeBackend` 的写侧在 PL-M5 已留痕，读侧仍不对称——`ls` / `read` / `readRaw` / `grep` 的权限拒绝**在调用 Tool Runtime 之前**返回，于是 `results` 与 `tool_calls` 两边都拿不到这次尝试。

改法：把 `denyWrite` 的记录体抽成 `recordDeniedCall(toolName, relative, reason)`，两侧各给一个说明性 reason：

| 侧 | reason 形态 | 生效范围来源 |
| --- | --- | --- |
| 写 | `Path is not writable: <path> (allowed: …)` | `describeWriteScope`（PL-M5，含 `writeTestFiles` 语义） |
| 读 | `Path is not readable: <path> (allowed: …)` | `describeReadScope`（**新增**，与写侧对称） |

`readRaw` 委托 `read`，因此自动覆盖。**不新增错误码**（复用 `TOOL_ERROR`），**不新开记录面**（同一条 `onToolEvent` + `ToolCallRecorder` 通道）。

### PL-C2 · agent 用量元数据（累积 + 成本产出方）

**这一项在实施中扩了范围**，原因见 §Known Issues 第 1 条：登记账只写了「`estimatedCost` 无产出方」，但设计修法时在同一条 `metadata` 路径上发现 `tokenUsage` **有产出方却是错的数**。两半必须同批修——只加成本产出而不修累积，产出的会是「最后一次调用的成本」，**比今天的 `null` 更糟**（今天是「未知」，那会是「看起来可信的错值」）。

**(a) 累积**（`docs/162` §2 的新发现）

| 位置 | 改动前 | 改动后 |
| --- | --- | --- |
| `AgentGraph.agentNode` | 每轮写 `{ tokenUsage }`，被 `metadata` 的覆盖式 reducer 逐轮顶掉 | 读 `state.metadata.tokenUsage` 求和后写回；`estimatedCost` 同样累加 |
| `DeepAgentLLMProvider.invoke` | 只把 `finalMessage` 的 `usage_metadata` 交回（内层 90 次调用只留最后一次） | 把 `result.messages` 里**全部** AIMessage 的用量求和 |

累加口径只有一份：`packages/agent-core/src/llm/usage.ts` 的 `sumTokenUsage`（数值字段递归相加，`input_token_details` / `output_token_details` 等嵌套明细一并累加，否则明细与总量对不上）。

**(b) 成本产出方**

链路原本是通的——`AgentRunner` 从 graph state 的 `metadata.estimatedCost` 读、写进 `AgentResult`、落库 `agent_runs.estimated_cost`、再被 `/api/metrics` 的 `ai_se_estimated_cost`、trace 与 eval harness 消费——**只是没有任何写入方**。现在补上：

```
配置（两个 env）→ AppConfig.modelPricing
  → 执行器依赖 → ProfessionalAgentOptions.modelPricing
  → DeepAgentLLMProvider(pricing)  ┐
  → LangChainLLMProvider(pricing)  ┴→ response_metadata.estimatedCostUsd
  → AgentGraph 读取并跨轮累加 → metadata.estimatedCost
  → AgentResult.estimatedCost → agent_runs.estimated_cost → sumRunUsage → maxCostUsd 门
```

**价目由配置注入，代码内不写静态价表**（`docs/162` §4 裁定 2）：部署的模型是**网关别名**（`OPENAI_MODEL=deepseek-v4.1-flash`，`OPENAI_BASE_URL=https://opencode.ai/zen/go/v1`），静态表换模型即失准。**未配置 → 不产出**（`estimated_cost` 维持 `NULL`），宁可留空也不编造数字。

### PL-C3 · `debugTarget` 消费侧校验

PL-M3 只让**生产者**（`WorkflowEngine.debugTargetType`）不再写入不可用值；消费者侧 `AgentRegistry.debugTarget` 仍把 `input.targetTaskType` 直接 `as TaskType`。失效面：非法值让 `TASK_AGENT_TYPES` 查空，最终抛出一条**误报 `task type DEBUG`** 的错误——真实原因是目标类型不可用。

改法：`debugTarget` 改用 `isUsableTargetTaskType`；`resolveTask` 在 DEBUG 派不出去时报 `its target task type is missing or unusable`，**不回显目标值**（它可能来自 agent 输出，`AGENTS.md` §10；与 PL-M3 的回退事件同一口径）。

## Architecture Changes

1. **「运行期专属任务类型」判定上移到 `packages/shared`。** 此前有两份同义副本（`agent-core/src/planning/validateTaskGraph.ts` 与 `workflow-engine/src/WorkflowEngine.ts`，后者注释自陈「同义，故刻意不引跨包常量」），PL-C3 正要引入第三份。`AGENTS.md` §3「跨包共享的类型/契约放 `packages/shared`」；`docs/160` 已把「重复定义必然漂移」记为本仓库的缺陷成因类型。三处消费方（计划期拦截 / 修复路由回退 / 任务派发）现共用一份。
2. **用量累加与计价有唯一一份口径**（`agent-core/src/llm/usage.ts`），外层图与内层 provider 共用。
3. **成本是 provider 的产物**：provider 按价目算出成本挂在 `response_metadata.estimatedCostUsd` 上，与既有的 `response_metadata.agentIterations` 同一手法；`AgentGraph` 只负责读取与累加。
4. 未新增错误码、未新建第二套 Permission / Approval / Audit 体系、未新增包、未改任何 `dist/`。

## Dependencies

无新增（含 devDependencies）。

## Tests

| 范围 | 结果 |
| --- | --- |
| `@ai-se/shared` test | **89/89（9 文件）**，本批 **+8** |
| `@ai-se/agent-core` test | **199/199（31 文件）**，本批 **+21**（其中 `usage.test.ts` 新文件 9 条） |
| `@ai-se/workflow-engine` test | **45/45（3 文件）**，**逐条不变**——PL-C3 在该包是等价重构（PL-M3 的 3 条 PL-M3 用例原样通过） |
| `apps/server` test | **272/272（50 文件）**（单次运行 271/272，见下），本批 **+3** |
| 全仓 `corepack pnpm -r run typecheck` | **通过** |
| 全仓 `corepack pnpm -r run lint` | **通过** |
| 全仓 `corepack pnpm -r --no-bail run test` | **15 个包全绿**；`apps/server` **271/272** |

**门禁抖动如实记录**（`docs/145` #7 / `docs/146` §5 已登记的负载敏感抖动，**未修**）：

| 次序 | 失败文件 / 用例 | 单独复跑 |
| --- | --- | --- |
| `--filter @ai-se/server` 全量 | `v1GoldenScenario.e2e.test.ts` 的「server restart」用例（`Error: waitFor timed out`） | **4/4 通过** |
| 全仓 `-r --no-bail` | `failureRecovery.e2e.test.ts` 的「external CANCELLED action…」用例 | **10/10 通过** |

两次失败**文件互不相同**，且都是 `docs/149` / `docs/146` §5 已点名的同名用例——再次印证 `docs/160` Known Issue 6 的观察：**抖动的文件会在不同运行间漂移**。**不声称一次全量通过**。

## Lint

受影响包（`shared` / `agent-core` / `workflow-engine` / `server`）与全仓 `-r run lint` 退出码 0。

## Typecheck

受影响包与全仓 `-r run typecheck` 通过（该命令会重建相关包的 `dist`，构建产物未读取）。

## E2E

本批**不含交付链级别的 E2E**（三项都是平台内部缺陷，与 E1 交付链无关）。关键回归以单元/集成用例钉住：

| 判据 | 证据 |
| --- | --- |
| **PL-C2 的核心回归**：跨轮求和 | `agentGraph.test.ts`：两次调用 100/10 与 200/20 → 断言得到 `300/30`（**修复前实测为 `200/20`**，见下） |
| 内层求和 | `DeepAgentLLMProvider.test.ts`：内层多次调用 → provider 交回的是**和**，且明确断言与**最后一次**不同 |
| 成本链路 | `ProfessionalAgent.test.ts`：价目 `$3/$15` + 1M/1M 用量 → `estimatedCost === 18`；未配置 → `undefined` |
| 计价边界 | `usage.test.ts`：未配置价目 / 零用量 / 非对象 → `undefined`（不编造） |
| **PL-C1** | `ToolRuntimeBackend.test.ts`：`devops-agent` 读 `src/index.ts` 被拒 → 沙箱**零调用** + `results` 一条 failed + `tool_calls` started/finished 各一条 + 消息含生效读范围；`ls` / `grep` 同覆盖；放行路径仍到达沙箱 |
| **PL-C3** | `AgentRegistry.test.ts`：5 种不可用目标（枚举外 / 运行期专属 / 缺失 / 非字符串）→ 报「target task type is missing or unusable」且**不含**「for task type DEBUG」、**不回显**目标值；6 种合法目标逐项解析不变 |

**修复前行为是实测的，不是推断的**：实施期间用一个一次性探针（真实 `AgentRunner` + 按队列返回 `usage_metadata` 的 provider）跑出 `{"input_tokens":200,"output_tokens":20,...}`——即**最后一次**调用。探针文件跑完即删（`packages/agent-core/src/__tests__/__probe-tokenusage.test.ts`，已不存在）。库中佐证：`current_iteration=90` / `tool_calls=90` 的那一行只记 `input_tokens=66,323`（其中 `cache_read=65,536`），全库 `max(input_tokens)=165,794`。

## Known Issues

1. **PL-C2 的范围在实施中扩大，如实记录。** 登记账（`docs/146` §3）只写了「`estimatedCost` 无产出方」。实施时在同一条 `metadata` 路径上发现 `tokenUsage` **有产出方但产出的是错的数**（只落一次调用），且**没有任何测试断言过 `tokenUsage`**（`grep tokenUsage --include="*.test.ts"` 零命中），`ScriptedCodingLLMProvider` 也不产出 `usage_metadata`——所以这条路径从未被测过。两半必须同批修（理由见 Implementation）。**范围扩大经用户在实施前的对话中知悉**（「我按你给的规则把它并进第 2 条」），任务书 `docs/162` §2 记录了新发现的一半。
2. **对 PL-M4 的影响：无。** 批次的成本由**网关配额**度量，不读 `agent_runs.estimated_cost`；`EvalPolicy` 也没有 cost/token 字段（`packages/eval/src/types.ts:29-40` 已核实）。本项不是 PL-M4 的阻塞项，是第 2 条的**正确性前提**。
3. **更正一条已登记的表述**：`docs/146` §3 第 2 条写的「实际生效的预算上限只有 token 与墙钟两项」**不准确**——`maxTokens` 门比对的 `sumRunUsage` 读的是同一列，此前同样被低估。**只有墙钟一项可靠**。已在本批同步更正登记账。
4. **历史数据不回溯**：已落库的 `agent_runs.token_usage` / `estimated_cost` 保持原值。**口径变更点在本批**——此前的批次数值（含 M4 的 6.7M 输入 token）与本批之后的不可直接比较，`docs/146` §6 规则 8 已在 §5 登记。
5. **缓存折扣未建模**：`estimateCostUsd` 按 `input_tokens` 原价计（真实 `usage_metadata` 里 `cache_read` 常占九成以上），故成本是**上界估计**。要精确需按 `input_token_details.cache_read` 分档定价——本批不做，登记待办。
6. **`tokenUsage` 的语义变更影响下游**：`/api/metrics` 的 token 指标、`/api/workflows/:id/trace` 的用量、工作流级 `maxTokens` 门从此得到的是**整轮**数字（此前是单次调用）。这**不是回归**，但会让同一条工作流在变更前后显示不同的 token 数——已在 §5 登记。
7. **`AgentRegistry.resolveTask` 的错误文案变更**：DEBUG 派不出去时的报错从 `No professional agent for task type DEBUG` 改为 `No professional agent for DEBUG task: its target task type is missing or unusable`。既有断言只匹配 `"No professional agent"` 子串，未受影响（已核对全树，仅 `AgentRegistry.test.ts:41` 一处）。
8. **`DEPLOY` 作为 DEBUG 目标仍无 agent**：`isUsableTargetTaskType("DEPLOY")` 为 `true`（它是合法枚举成员、也不是运行期专属类型），但 `TASK_AGENT_TYPES` 没有 `DEPLOY` → 仍会抛错。**本批按「最小改动」处理**：不收紧 shared 判定（那会改变 PL-M3 刚交付的行为），只让报错**说实话**。若要根治，需先裁定「DEPLOY 算不算可派发的工作类型」。
9. **PL-C1 的触发面仍然很窄**：当前各 agent 的 `readPaths` 都是 `["."]`（`devops-agent` 除外），实际不易触发读拒绝。本项的价值是**对称性与可审计性**，不是修复一个高频故障。
10. **未做（红线）**：未新建第二套 Permission / Approval / Audit / 错误码体系；未改 L1-8 判据口径；未改提示词；未动 `packages/eval` 的夹具与 `EvalPolicy`；未修改任何 `dist/`；**未回溯修改历史数据**。

## Acceptance Result

| 判据（`docs/162` §3） | 判定 | 证据 |
| --- | --- | --- |
| **C1** 读拒绝沙箱零调用 | **达成** | `ToolRuntimeBackend.test.ts` 计数器为 0 |
| **C1** 读拒绝落 `results` + `tool_calls` 各一条 | **达成** | 同上：`started:read_file:src/index.ts` / `finished:failed`，`toolResults` 长度 1 |
| **C1** 拒绝信息含生效读范围 | **达成** | 断言完整消息串（含 `allowed: infrastructure/, …`） |
| **C1** `ls` / `grep` 同样覆盖 | **达成** | 同上第 2 条用例 |
| **C2** 多轮调用 → `tokenUsage` 为累计值 | **达成** | `agentGraph.test.ts` 断言 `300/30` |
| **C2** 内层全部 AIMessage 用量求和 | **达成** | `DeepAgentLLMProvider.test.ts` |
| **C2** 配置价目 → `estimatedCost` 落值；未配置 → 不产出 | **达成** | `ProfessionalAgent.test.ts`（18 / undefined）+ `usage.test.ts` + `config.test.ts` |
| **C2** 历史数据不变 | **达成** | 未执行任何 `UPDATE`/迁移（改动仅代码与配置） |
| **C3** 非枚举 / 运行期专属目标不接受 | **达成** | `AgentRegistry.test.ts` 5 种输入 |
| **C3** 报错指明真实原因 | **达成** | 断言**不含**「for task type DEBUG」 |
| **C3** 合法值行为逐字不变 | **达成** | 6 种合法目标逐项断言；`workflow-engine` 45/45 不变 |
| **C3** 判定只有一份定义 | **达成** | 三处消费方均从 `@ai-se/shared` 导入；两处本地副本已删 |

**阶段判定：PL-C1 / PL-C2 / PL-C3 全部达成。**

## Next Phase Boundary

**本子阶段结束（STOP）。未开始事项**：

- **PL-M4 批次复验（E1×3）**——**未开工**；**需先确认周配额余量**（M4 实测单批约 6.7M 输入 token，历史上跑 3 批）。
- **缓存折扣建模**（本文件 Known Issue 5）——未做，登记待办。
- **`DEPLOY` 作为目标类型的归属裁定**（本文件 Known Issue 8）——未做，需先裁定。
- **控制台触发的 MCP 调用不产生 Tool Call / Audit 记录**（`docs/146` §3）——本批按用户裁定的范围 **1+2+3** 排除；修它要先裁定 `agentRunId` 口径。
- **MCP 控制台 4 个未实现的操作**、**门禁抖动范围更宽**——同上，本批排除。
- **带第三方依赖的评测夹具**（`docs/158` §6 第 7 项）——仍未立项。
- **`docs/158` §6 第 5 / 7 项**——仍待裁定。

**需要你回答**：是否现在开工 **PL-M4**（会消耗真实配额，量级 ~6.7M 输入 token/批 × 3 批）。
