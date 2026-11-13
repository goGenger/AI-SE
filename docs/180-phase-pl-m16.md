# 180 · N-9「外层循环在 `submit_result` 后空转到守卫」实施记录（PL-M16）

> 状态：**已实施并收尾**（2026-10-17）。用户裁定「**都按你的建议，开工 PL-M16**」——即任务书 `docs/179` §7 八项待裁定**全部按推荐值接受**。**判据强度以本文件为准**。
> 依据：任务书 `docs/179`、**实探**（`packages/agent-core/scripts/probe-outer-loop-spin.ts`，本批新增；结果 `packages/eval/results/n9-spin-probe{,-after}/`）、L1-M4g run 1 实测（工作流 `de90fdb0`）、dev 库全量实查（`workflow_events` / `agent_runs` / `tool_calls` 全历史）、代码实查（`DeepAgentLLMProvider.ts` / `AgentGraph.ts` / `submitResult.ts` / `AgentRunner.ts`）、`docs/175`（PL-M14）、`docs/178`（PL-M15）。
> 性质：**本文件是实施结果正本**。**不新造验收编号**；本批修的是缺陷（N-9 → PL-M16）。

## Modified Files

| 文件 | 改动 |
| --- | --- |
| `packages/agent-core/src/professional/DeepAgentLLMProvider.ts` | 新增模块内 `withoutToolCalls(additionalKwargs)`；`invoke` 重建返回消息时改用它。**这是本批唯一的生产行为改动** |
| `packages/agent-core/src/professional/DeepAgentLLMProvider.test.ts` | **新增** 1 个用例（N-9）+ 测试模型 `AdditionalKwargsToolCallModel`。既有 **7** 个用例**一字未动** |
| `packages/agent-core/scripts/probe-outer-loop-spin.ts` | **新增**。真实栈 + 录制型假网关，三场景（基线 / 反事实 / 无 `recursionLimit`） |
| `packages/eval/results/n9-spin-probe/` | **新增**。修复**前**的三场景测量 |
| `packages/eval/results/n9-spin-probe-after/` | **新增**。修复**后**的三场景测量 |

**未改动**：`AgentGraph.ts`、`AgentRunner.ts`、`recursionLimitFor` / `maxIterations` 取值、`innerProducedAIMessages`（PL-M15 的成果）、`packages/eval/src/usageGuard.ts` 与批次脚本、`packages/eval` 的夹具 / oracle / `EvalPolicy` / L1-8 判据、任何历史 `tasks` / `agent_runs` / `workflow_events` 行。

## Implementation

### 1. 定位（判据 16a / 16b）：外层循环在提交后每轮重复请求同一个工具调用

探针用**真实栈 + 录制型假网关**（真实 `ChatOpenAI` / 真实 `deepagents` 内层 agent / 真实 `ToolRuntimeBackend` / 真实 `DeepAgentLLMProvider` / 真实 `AgentRunner`，只假掉端点），网关脚本每轮一次普通工具调用 + 一次被接受的 `submit_result`：

**场景 A（修复前，当前代码）**：

```
rounds=49  status=failed  code=TOOL_ERROR  iterations=50
rounds requesting submit_result: 49/49      <- 第 1 轮起每一轮都在请求同一个工具
rounds with ZERO model calls:    48/49      <- 除第 1 轮外，没有任何模型调用
additionalKwargKeys (每轮): function_call,tool_calls
```

与生产实测**同形同量级**（L1-M4g run 1：三次尝试的外层轮数 44 / 44 / 45，请求 `submit_result` 的轮数 44 / 44 / 45（**100%**），全部落在 **1.2 秒**内，每轮零模型调用，`state.iteration` 撞 50 后 `TOOL_ERROR`，而任务自报 `outcome: SUCCESS`）。

**产生环**（逐处代码实查 + 探针实证）：

1. 内层 deep agent 调用 `submit_result`，`createSubmitResultTerminationMiddleware` 的 `beforeModel` 钩子在下一次模型调用前 `jumpTo: "end"`，内层循环结束（`submitResult.ts:78-97`）。
2. `DeepAgentLLMProvider.invoke` 重建返回消息时**原样带回 `additional_kwargs`**（`:94`，**PL-M13 为修 N-6 而加**）。生产的 `ChatOpenAI` 把工具调用放在 `additional_kwargs.tool_calls` 里，`@langchain/core` 的 `AIMessage` 由它派生出 `tool_calls`。
3. `AgentGraph.agentNode` 的 `getToolCalls(response)` 因此非空 ⇒ `status = "running"`；`shouldContinue` 返回 `"tools"`（`AgentGraph.ts:394`）。
4. `toolsNode` 再次执行 `submit_result`——**而内层已经执行过它**。
5. 下一轮 `agentNode` 再调 `provider.invoke`。内层 `beforeModel` 看到最后一条是**被接受的 `submit_result` 工具结果**（由第 4 步产生并回灌）⇒ **再次 `jumpTo end`，零模型调用**，`provider.invoke` 立即返回，且交回的消息**仍带 `tool_calls`**（`finalMessage(result)` 取到的正是调用方回灌进来的那条 `AIMessage`）。
6. **回到第 3 步。** 循环到 `state.iteration >= 50`，平台守卫返回 `TOOL_ERROR`（`AgentGraph.ts:229-238`）。

### 2. 复现（判据 16b）与反事实验证（判据 16c）

探针**场景 B** 是候选修法的**反事实**：把 provider 交回的消息重建为**不带 `tool_calls`**（`additional_kwargs` 的其余键保留）。修复前后三场景对照：

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| **A** 真实栈跑到守卫 | **49 轮** / `failed` / `TOOL_ERROR` / `iter=50` | **3 轮** / `succeeded` / `iter=4` |
| **B** 反事实（重建消息去掉 `tool_calls`） | **3 轮** / `succeeded` | 3 轮 / `succeeded` |
| **C** 不传 `recursionLimit`（PL-M14 之前的条件） | **13 轮** / `Recursion limit of 25` | **3 轮** / `succeeded` |

⇒ 修复前的 A **就是**生产形态；B 证明「去掉 `tool_calls`」足以消除空转；**修复后 A 与 B 一致**。

### 3. 根因修复（判据 16c）：交回外层的消息不得再带工具调用

```ts
function withoutToolCalls(additionalKwargs: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!additionalKwargs) return {};
  const { tool_calls: _dropped, ...rest } = additionalKwargs;
  return rest;
}
// invoke:
additional_kwargs: withoutToolCalls(message.additional_kwargs),
```

**只剔除 `tool_calls` 这一个键**：`additional_kwargs` 的其余键**一个不动**——那是 N-6 的 `reasoning_content` 的载体（`docs/172`），`DeepAgentLLMProvider.test.ts` 有钉住它的用例。

**为什么无条件剔除、而不是按 `captureSubmittedOutcome` 是否命中来条件化**（这是对 §4 裁定 3 的一处**收紧**，理由如下）：内层 deep agent 已经通过**同一个** ToolRuntime 执行过它请求的每一个工具，外层 `AgentGraph` 的 tools 节点再执行一次就是**重复执行**——这在语义上就该被禁止，与「本轮是否捕获到提交结果」无关。而条件化会留一个洞：**只要捕获未命中、而响应仍带 `tool_calls`，空转就会继续**——本探针正是这种情形（见 Known Issues 1）。`ProfessionalAgent` 对「捕获未命中」已有降级路径（`parseOutcome(result.finalAnswer)`），因此无条件剔除**不会**让结果丢失。

先写用例再改：新用例在修复前红（`expected 0 to be 1`，`response.tool_calls` 带 1 条 `submit_result`），修复后绿。

### 4. N-7 的定性更正（判据 16i）

**场景 C 证实了 `docs/179` §2.4 的假设**：不传 `recursionLimit` 时，**同一个空转**在 **13 轮**撞 LangGraph 默认的 25 超步（13/13 轮请求 `submit_result`，12/13 轮零模型调用），报 `Recursion limit of 25 reached without hitting a stop condition`。**⇒ N-7 不是独立缺陷，而是同一个控制流缺陷被框架提前掐断的形态。** PL-M14 让平台守卫成为生效的那一个（错误形态由 `UNKNOWN_ERROR` 变为 `TOOL_ERROR`，L1-M4f 已证实）——**它的成果本身仍然正确且必要**，变的只是**归因**。

**修复后场景 C 的 `Recursion limit of 25` 一并消失**（13 轮 → 3 轮 / `succeeded`）。

已按裁定 7 以**追加块**更正 `docs/174` 与 `docs/175`（正文保留不改，`docs/146` §6 规则 7）。

### 5. 回归时间线（`docs/179` §2.4 的实测依据，本批复核）

全库 `workflow_events` 按「单个 agent run 的外层轮数」统计：

| 时间窗 | 空转数（轮数 ≥ 20 且全为 `submit_result`） | 最大外层轮数 |
| --- | --- | --- |
| 09-28 → **10-17 05** | **0** | **1–2** |
| **10-17 08**（L1-M4e `a6914b77`） | 0（但每 run ~13 轮全部 `submit_result`） | ~13 |
| **10-17 09 起** | **100%** | 41–50 |

⇒ 回归点在 10-17 08:25 之前，与 **PL-M13** 落地时刻吻合。

## Architecture Changes

**无。** 未新增包、未新增顶层目录、未新增依赖。

**未破坏架构不变量**：未在 `AgentGraph` 里对工具名特判（方案 F 已否）；终止语义仍由 provider 交回的消息形状表达，没有引入第二套体系（`AGENTS.md` §10）。

## Dependencies

**无。** 未升级 / 更换 `deepagents` / `@langchain/*`（方案 E 已否）。

## Tests

| 层（`docs/179` §5） | 内容 | 结果 |
| --- | --- | --- |
| **第 1 层：探针定位** | `scripts/probe-outer-loop-spin.ts`，三场景；真实栈 + 录制型假网关，离线、零配额 | **完成**，见 Implementation §1–2。**如实标注**：`packages/agent-core/scripts/` **不在** `tsconfig.json` 的 `include` 内，故该探针**未被 `typecheck` / `lint` 覆盖**（与既有三支探针同一惯例） |
| **第 2 层：单测** | `agent-core`：`DeepAgentLLMProvider.test.ts` 新增 N-9 用例（**先红后绿**）+ `AdditionalKwargsToolCallModel`（复现生产形状：工具调用在 `additional_kwargs.tool_calls` 里） | **完成** |
| **第 3 层：回归** | `agent-core` 全量 **245 用例 / 35 文件**（既有 244 + 新增 1）；**N-6 的 `reasoning_content` 用例仍绿**；**N-8 的 `innerProducedAIMessages` 用例仍绿**；全仓 `pnpm -r` 见 Lint / Typecheck（**含一处如实记录的负载偶发**，见该节与 Known Issues 4） | **全绿**（`pnpm -r` 的偶发项已单独复跑证实为绿） |
| **第 4 层：真实批次回放** | 下一批 E1×3 里**空转零出现**（判据 16h） | **延期**——`docs/179` §6 明确「本批不跑 E1×3」 |
| 共享夹具核对 | 全树 grep `tool_calls` / `additional_kwargs` / `outcomeMode`（105 处、33 文件、16 个带断言的测试文件）：**无任何断言依赖「重建的消息仍带 tool_calls」** | **完成** |
| A/B 实测（强制） | 改控制流后跑 `apps/server` 的 agent 相关 e2e：`agentRunPersistence` / `professionalAgents` / `terminationPropagation` / `metricsEndpoint` / `workflowTrace` / `workflowCorrelation` | **6 文件全绿** |
| 门禁 | `corepack pnpm --filter @ai-se/agent-core run typecheck && lint && test` | **全绿** |

## Lint

- `corepack pnpm --filter @ai-se/agent-core run lint` → 通过
- 全仓 `corepack pnpm -r run lint` → 通过

## Typecheck

- `corepack pnpm --filter @ai-se/agent-core run typecheck` → 通过
- 全仓 `corepack pnpm -r run typecheck` → 通过（exit 0）
- 全仓 `corepack pnpm -r run lint` → 通过（exit 0）

**全仓测试（`corepack pnpm -r run test`）——如实记录，1 处 `apps/server` e2e 失败**：

| 包 | 结果 |
| --- | --- |
| 其余 **14 个包** | **全绿**（`agent-core` **245** / `eval` 48 / `web` 505 / `mcp` 235 / `shared` 168 / `visual` 83 / `database` 47 / `workflow-engine` 45 / `browser` 38 / `tool-runtime` 32 / `failure-recovery` 16 / `action-policy` 13 / `evidence` 9 / `sandbox` 8 / `observability` 3） |
| `apps/server` | **1 失败 / 284 通过**——`planningEscalation.e2e.test.ts`「升级重试达上限 → 终态失败」 |

**判定为负载偶发，不是本批回归**，依据两条：

1. **该文件单独跑通过**：1 文件 / 2 用例，退出码 0。
2. 它是**又一个不同的**文件——PL-M15 收尾时两次全仓跑分别失败的是 `terminationPropagation` 与 `v1GoldenScenario`；`pnpm -r` 让 15 个包并行，而 `apps/server` 的重型 e2e（真实 PG + Docker + Chromium + 服务端进程重启）对时序敏感。**该现象在本批之前即存在**（`docs/127` §8 已记口径）。**本批未据此改动任何测试**（不掩盖、不放宽断言）。

（过程中修掉一处自查出来的类型错误：测试模型的 `additional_kwargs.tool_calls[].id` 需为 `string`，`call.id` 可为 `undefined`——已用 `call.id ?? \`call-${index}\`` 兜住。**这是本批唯一一次 typecheck 失败，出现在新增的测试代码里，已修**。）

## E2E

本批**不跑 E1×3 真实批次**（`docs/179` §6）。真实链路验证由两部分承担：

1. 探针场景 A（真实 `AgentRunner` + 真实 `DeepAgentLLMProvider` + 真实内层 deep agent + 真实 `ToolRuntimeBackend`，只假掉端点）；
2. `apps/server` 的 6 个 agent 相关 e2e 文件。

## Known Issues

1. **探针的一处保真缺口（如实登记，不掩盖）**：本探针里**内层 agent 从未派发 `submit_result`**——`backend.toolResults` 始终只有 `read_file`，因此 `captureSubmittedOutcome` 返回 `undefined`、provider 的 `content` 为空。**生产里它是走通的**（L1-M4g run 1 三次运行的 `agent_runs.output->>'outcomeMode'` 全是 **`tool`**）。**本批所修的「外层机制」被完整复现**（外层响应带 `additional_kwargs.tool_calls`、循环重复执行、零模型调用、撞守卫），但**内层为何不派发未被查明**。单测用 `AdditionalKwargsToolCallModel` **复现了生产条件**（backend 确实执行并接受了提交，`content` 是提交摘要），因此**修复本身在两种情形下都经过验证**。**该缺口登记为开放项。**
2. **修法无条件剔除 `tool_calls`**（不按捕获是否命中来条件化）——见 Implementation §3 的理由。这是对 §4 裁定 3 的一处**收紧**，已在此记录。
3. **探针未被门禁覆盖**（`scripts/` 不在 tsconfig include），与既有三支探针同一惯例。
4. **全仓 `pnpm -r run test` 存在负载偶发**（非本批引入）：本次全仓跑 1 个 `apps/server` 重型 e2e 失败（`planningEscalation.e2e`「升级重试达上限 → 终态失败」），**单独复跑即绿**（1 文件 / 2 用例）。PL-M15 收尾时两次全仓跑分别失败的是 `terminationPropagation` 与 `v1GoldenScenario`——**每次都是不同的文件**，符合负载偶发的特征。判定方法与本仓既有记录一致（`docs/127` §8）。**未据此改动任何测试。**
5. **本批未跑真实 E1×3**，因此**判据 16h 未取得证据**——它由下一批承担，见 Next Phase Boundary。
6. **`T-DESIGN-S1` 的设计产出质量 / 计划粒度**：`docs/179` §1 第 5 项明确排除，本批未动。
7. **守卫未动**（PL-M15 的成果），**`maxIterations` / `recursionLimitFor` 未动**。
8. 前几批的未修项全部维持登记（读侧放行 / 根级源码文件 / `scripts/` / `test/` / `canonicalAcKey` 副本 / N-1b / N-1c / N-3 / 7b / `CHECK_CANDIDATES` / 启动器陈旧实例 / 库内孤儿行）。

## Acceptance Result

**本批是缺陷修复，不新造验收编号。** 按 `docs/179` §3 逐条判定：

| 判据 | 期望 | 结果 |
| --- | --- | --- |
| **16a** | 空转的**产生环被查明** | **达成**——`additional_kwargs.tool_calls` 被原样带回 ⇒ `shouldContinue` 回到 tools 节点（Implementation §1） |
| **16b** | **探针证明**：真实栈复现 + 逐轮打印外层看到的消息与 tool_calls | **达成**——场景 A 49 轮 / 49-49 请求 `submit_result` / 48-49 轮零模型调用 / `TOOL_ERROR`（Implementation §1–2） |
| **16c** | 空转的**根因被消除** | **达成**——修复后场景 A 由 49 轮空转 → **3 轮 / `succeeded`**（Implementation §2–3） |
| **16d** | **N-6 不得复发**（`reasoning_content`） | **达成**——该用例一字未改且绿 |
| **16e** | **N-8 不得复发**（`innerProducedAIMessages`） | **达成**——未改动；`agent-core` 全量 245 用例绿 |
| **16f** | 不改 `maxIterations` 与 `recursionLimitFor` 取值 | **达成** |
| **16g** | 既有断言**逐字不变** | **达成**——`DeepAgentLLMProvider.test.ts` 既有 7 例一字未改 |
| **16h** | **真实批次里空转零出现**，且 `T-DESIGN-S1` 这类任务**当轮结束** | **延期**——本批按 §6 不跑 E1×3 |
| **16i** | **N-7 的定性被证实或证伪**，并以追加块更正 | **达成**——场景 C 证实「同一空转被框架掐断」；`docs/174` / `docs/175` 已加勘误块（Implementation §4） |

**⇒ 16a–16g 与 16i 达成；16h 延期至下一批。本批不判「N-9 已关闭」——按「边界项宁标延期也不勾选」的口径，只有真实批次里空转零出现才关闭。**

## Next Phase Boundary

**未开始事项（STOP）**：

- **未跑任何真实批次**。判据 **16h 未取证据**。下一批何时开、以什么形态开，见 `docs/179` §7 第 5 项：**另开一批 E1×3**（新结果目录），**不续跑 L1-M4g**；开工前三件事（确认周配额余量 / 先停 `:47558` 上的陈旧实例再重启 / harness 后台任务 + **立即** arm 看门狗，停机必须 cancel 服务端工作流）。
- **未做**：未追查 Known Issues 1 的探针保真缺口；未动 `T-DESIGN-S1` 的设计产出质量 / 计划粒度；未升级或更换任何依赖；未清理库内孤儿行。
- **未裁定**：便宜档作为常规发现手段的形态 / 频率 / 与 E1×3 的分工（自 `docs/177` 起挂起）。
- **已登记但未开工**：`docs/179` §1 的其余排除项。
- **不变量**：不改 `packages/eval` 的夹具与 oracle；不改 `EvalPolicy`；不改 L1-8 判据口径；不修改任何 `dist/`（除各包正常 `build` 产物）；不修改历史 `tasks` / `agent_runs` / `workflow_events` 行。
- 收口时同步登记账：`docs/179`（§7 裁定结果 + 状态行）、`docs/146` §3 / §4 / §5、`docs/127` §0 / §6 / §9、`docs/174` / `docs/175`（N-7 勘误块）。
