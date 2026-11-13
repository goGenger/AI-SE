# 178 · N-8「用量坏值污染周配额守卫」实施记录（PL-M15）

> 状态：**已实施并收尾**（2026-10-17）。用户裁定「**都按你的建议，开工 PL-M15**」——即任务书 `docs/176` §7 七项待裁定**全部按推荐值接受**。**判据强度以本文件为准**。
> 依据：任务书 `docs/176`、诊断记录 `docs/177`、**实探**（`packages/agent-core/scripts/probe-usage-compounding.ts`，本批新增；结果 `packages/eval/results/n8-compounding-probe{,-after}/`）、dev 库全量实查、代码实查（`DeepAgentLLMProvider.ts` / `AgentGraph.ts` / `AgentRunner.ts` / `ToolRuntimeBackend.ts` / `ProfessionalAgent.ts` / `workflowTaskExecutor.ts`）。
> 性质：**本文件是实施结果正本**。**不新造验收编号**；本批修的是缺陷（N-8 → PL-M15）。

## Modified Files

| 文件 | 改动 |
| --- | --- |
| `packages/agent-core/src/professional/DeepAgentLLMProvider.ts` | `agentUsages(value)` → `innerProducedAIMessages(value, carried)`；`invoke` 传 `new Set(messages)` 把调用方回灌的消息剔除。**这是本批唯一的生产行为改动** |
| `packages/agent-core/src/professional/DeepAgentLLMProvider.test.ts` | **新增** 1 个用例（N-8）。既有 6 个用例**一字未动** |
| `packages/agent-core/scripts/probe-usage-compounding.ts` | **新增**。真实 `ChatOpenAI` + 录制型假网关 + 真实 `deepagents` 内层 agent + 真实 `ToolRuntimeBackend` + 真实 `DeepAgentLLMProvider` + 真实 `AgentRunner`；三场景 |
| `packages/eval/src/usageGuard.ts` | **新增**。守卫读取口径的**唯一一份**实现（上界常量 + 判定 + 求和） |
| `packages/eval/src/usageGuardCli.ts` | **新增**。从 stdin 读原始值并输出有界和，供 shell 调用 |
| `packages/eval/src/__tests__/usageGuard.test.ts` | **新增** 6 个用例 |
| `packages/eval/scripts/lib/usage-guard.sh` | **新增**。共享的 `week_tokens()` |
| `packages/eval/scripts/*.sh`（**18 个**） | 本地 `week_tokens()`（16 个）与内联 psql 求和（2 个）统一替换为共享库调用。见 Implementation「守卫口径收敛」 |
| `packages/eval/results/n8-compounding-probe/` | **新增**。修复**前**的三场景测量 |
| `packages/eval/results/n8-compounding-probe-after/` | **新增**。修复**后**的三场景测量 |

**未改动**：`sumTokenUsage` / `estimateCostUsd`（`llm/usage.ts`）、`AgentGraph.ts`、`AgentRunner.ts`、`recursionLimitFor` / `maxIterations` 取值、`packages/eval` 的夹具 / oracle / `EvalPolicy` / L1-8 判据、任何历史 `tasks` / `agent_runs` / `workflow_events` 行。

## Implementation

### 1. 定位（判据 15a / 15b）：坏值产生在 `DeepAgentLLMProvider.invoke` 的「整轮求和」这一环

`docs/176` §2.5 已用脚本化 provider 证明**累加环**（`sumTokenUsage`）是线性的，于是只剩一个未排除环节：`DeepAgentLLMProvider.invoke` 交回的 `usage_metadata` 本身。

本批用**真实栈 + 录制型假网关**（N-6 手法）把它坐实。链路是：

1. 外层图每轮把 provider 上一轮交回的 `AIMessage` 回灌进 `messages`（`AgentGraph.agentNode`：`messages: [response]`，`AgentGraph.ts:293`）。
2. 内层 deep agent 的 `result.messages` 以**同引用**把这条消息带回（探针场景 C 实测：`inputIndex=2`）。
3. `DeepAgentLLMProvider.invoke` 原先对 `result.messages` 里**全部** `AIMessage` 求和——**包括调用方自己带进来的那些**。而它们身上的 `usage_metadata` 是**上一轮的累计值**。

于是上报的不是「本轮用量之和」，而是一条递推：

```
T(1) = U(1)            （正确）
T(n) = U(n) + Σ_{k<n} T(k)      ← 复利：每轮翻倍
```

**实测（探针场景 B，连续 8 轮，每轮脚本相同）**：

| 轮 | 修复前交回 | 修复后交回 | 本轮「自产」应为 |
| --- | --- | --- | --- |
| 1 | 1,000 | 1,000 | 1,000 |
| 2 | 2,000 | **1,000** | 1,000 |
| 3 | 4,000 | **1,000** | 1,000 |
| 4 | 8,000 | **1,000** | 1,000 |
| 5 | 16,000 | **1,000** | 1,000 |
| 6 | 32,000 | **1,000** | 1,000 |
| 7 | 64,000 | **1,000** | 1,000 |
| 8 | 128,000 | **1,000** | 1,000 |

修复前**精确等于 `2^(n-1) × 1000`**（即上表第 2 列，逐位等于递推 `T(n) = Σ_{k<n} T(k) + 1,000` 的展开）；修复后**恒为 1,000**——即「本轮自产」。第三列是同一递推的**正确值**，修复后逐轮命中它。

> 注：探针第一版把「自产」错估为「网关调用数 × 每次用量」（该脚本每轮 2 次调用，故估 2,000），因此其输出里的 `compoundPred` 列是 2,000 / 3,000 / … 递增——那是**预测器写错**，不是机制。定稿版改为从第 1 轮的实测值推 `own`，结论变为干净的 `N8-LINEAR`（`n8-compounding-probe-after/`）。修复**前**的原始逐轮数据（第 2 列）不受影响，仍是证据。

**场景 C（内层 `result.messages` 逐条）**：

```
 idx  class          role    isAI  inputIndex  usageInputTokens  toolCalls
   0  SystemMessage  system    no            0                  -  -
   1  HumanMessage   human     no            1                  -  -
   2  AIMessage      ai       yes            2              12345  -          <- 调用方的消息，同引用回带
   3  AIMessage      ai       yes           -1               1000  submit_result
   4  ToolMessage    tool      no           -1                  -  -
agentUsages sum=13345   echoed(count=1, sum=12345)   own(sum=1000)
```

⇒ **`echoed` 那一行就是坏值。** 剔除它，剩下的 `own` 才是本轮用量。

### 2. 生产复现（判据 15b）：真实外层循环跑到平台守卫，坏值同量级复现

探针场景 A 按 `ProfessionalAgent.run` 的接线装配（`outcomeTool = submit_result`、`maxIterations = 50`、`maxRetries = 1`），网关脚本每轮一次普通工具调用 + 一次被接受的 `submit_result`（这正是生产里外层循环得以继续的形状）：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 外层轮数 | 49 | 49 |
| 网关调用数 | 98 | 98 |
| `state.iteration` 轨迹 | `2,3,…,50` | `2,3,…,50` |
| 运行结局 | `failed` / `TOOL_ERROR` / `iterations=50` | **同左** |
| **上报 `input_tokens`** | **562,949,953,421,311,000** | **49,000** |

⇒ 修复前**复现了生产的完整故障形态**（`TOOL_ERROR` + `iter=50` + 10¹⁷ 量级坏值），且量级与生产实测的 2.6×10¹⁷–4.1×10¹⁸ 同一档。**修复后同一路径仍正常走到守卫，只是读数回到合理量级**——守卫的**触发行为未被削弱**，被削弱的只有那个假数字。

### 3. 根因修复（判据 15c）：只累计本轮自产的消息

```ts
function innerProducedAIMessages(value: unknown, carried: ReadonlySet<BaseMessage>): AIMessage[] {
  // ... 过滤 AIMessage.isInstance(message) && !carried.has(message)
}
// invoke:
const usage = totalTokenUsage(
  innerProducedAIMessages(result, new Set(messages)).map((message) => message.usage_metadata)
);
```

**按引用剔除**，依据是场景 C 的实测（调用方的消息以同引用回带）。**PL-C2 的意图不变**（「整轮用量 = 内层全部 LLM 调用之和」），变的只是「哪些消息算这一轮」。

先写用例再改：新用例在修复前红（`expected 1000200 to be 100`——回灌的 1,000,000 被多算了一次），修复后绿。

### 4. 守卫健壮化（判据 15d）：合理性上界法，且口径收敛到一处

按 §7 第 3 项裁定，用**可论证上界**而非统计离群：

```
上界 = maxIterations × 单轮请求上下文上界 = 50 × 1,000,000 = 50,000,000  →  取整 1e8
```

- 历史正常最大值 **2,999,834**（33 倍余量）；
- 坏值最低 **4.7×10¹⁴**（低 6 个数量级）。

**口径收敛**：原先 18 个批次脚本各自持有一份求和（15 个逐字节相同的 `week_tokens()` + 2 个内联 psql + 1 个探针脚本的本地 `$SANE_MAX`）。本批把判定搬进 `packages/eval/src/usageGuard.ts`（**唯一一份**），shell 只做「取原始值 → 管道 → CLI」，18 个脚本统一 `source packages/eval/scripts/lib/usage-guard.sh`。

**失败模式必须保持 fail-closed**：库在取不到数据时**打印空串**，调用方原有的 `case "$used" in ''|*[!0-9]*) … exit 3` 兜底照旧——**守卫绝不能 fail open**。

**真实库验收**（同一周窗口）：

| 口径 | 读数 |
| --- | --- |
| 旧（全部行求和） | 6,387,822,413,269,715,877 |
| **新（有界和）** | **121,129,829** |
| 止损线 | 200,000,000 |

⇒ 旧口径下**任何**止损线都会被一条坏值顶穿；新口径回到止损线以下。读数与 `docs/177` 的有界值逐位一致。

### 5. 历史行零改动（判据 15e）

本批**未对数据库做任何写操作**。收尾实查：

| 项 | 值 |
| --- | --- |
| `input_tokens > 10M` 的行 | **11**（与 `docs/177` 相同） |
| `iter = 50` 且 `Agent reached max iterations` 的行 | **11** |
| `agent_runs` 总行数 | 3,323 |
| 合理行最大 `input_tokens` | 2,999,834 |

## Architecture Changes

**无。** 未新增包、未新增顶层目录、未新增依赖。新增的 `packages/eval/scripts/lib/` 是既有 `scripts/` 下的子目录。

**未破坏架构不变量**：未新增第二套 Permission / Approval / Audit / 错误码体系；未绕过 Tool Runtime。

## Dependencies

**无。** 未升级 / 更换 `deepagents` / `@langchain/*`（方案 E 已被否，且实测证明坏值来自平台侧，与依赖版本无关）。

## Tests

| 层（`docs/176` §5） | 内容 | 结果 |
| --- | --- | --- |
| **第 1 层：探针定位** | `scripts/probe-usage-compounding.ts`，三场景；真实栈 + 录制型假网关，离线、零配额 | **完成**，见 Implementation §1–2。**如实标注**：`packages/agent-core/scripts/` **不在** `tsconfig.json` 的 `include`（`["src/**/*.ts"]`）内，故该探针**未被 `typecheck` / `lint` 覆盖**——与既有 `probe-usage-accounting.ts` / `probe-gateway-message-shape.ts` 同一惯例；它以 `tsx` 实际跑通（三场景均产出完整结果） |
| **第 2 层：单测** | `agent-core`：`DeepAgentLLMProvider.test.ts` 新增 N-8 用例（先红后绿）；`eval`：`usageGuard.test.ts` 6 用例（先红后绿，红态实测 `470000003716139` vs 期望 `3716139`） | **完成** |
| **第 3 层：回归** | `agent-core` 全量 **244 用例 / 35 文件**；`eval` 全量 **48 用例 / 6 文件**；`apps/server` 全量 **285 用例 / 50 文件**；全仓 `pnpm -r` 见 Lint / Typecheck（**含一处如实记录的负载偶发**，见该节与 Known Issues 9） | **全绿**（`pnpm -r` 的偶发项已单独复跑证实为绿） |
| **第 4 层：真实批次回放** | 下一批 E1×3 里坏值零出现（判据 15h） | **延期**——`docs/176` §6 明确「本批不跑 E1×3 批次」 |
| 共享夹具核对 | 全树 grep `tokenUsage` / `token_usage` / `usage_metadata`（97 处、31 文件）：**无任何断言依赖「回灌消息被计入」这一旧行为**；`agentGraph.test.ts` 的断言测的是 `AgentGraph` 自身的累加，未被本批触碰 | **完成** |
| A/B 实测（强制） | 改记账层后跑 `apps/server` 的 agent 相关 e2e：`agentRunPersistence` / `professionalAgents` / `terminationPropagation` / `metricsEndpoint`，**4 文件 / 10 用例全绿**（「后」侧为绿 ⇒ 无需回退取基线） | **完成** |

## Lint

- `corepack pnpm --filter @ai-se/agent-core run lint` → 通过
- `corepack pnpm --filter @ai-se/eval run lint` → 通过
- **全仓 `corepack pnpm -r run lint`** → 通过（逐包 Done，零告警）

## Typecheck

- `corepack pnpm --filter @ai-se/agent-core run typecheck` → 通过
- `corepack pnpm --filter @ai-se/eval run typecheck` → 通过
- **全仓 `corepack pnpm -r run typecheck`** → 通过（逐包 Done）

**全仓测试（`corepack pnpm -r run test`）**——**如实记录，两次跑各失败一个不同的 `apps/server` e2e**：

| 跑次 | `apps/server` 结果 | 其余包 |
| --- | --- | --- |
| 第 1 次 | **2 失败 / 283 通过**——`terminationPropagation.e2e` FX-36（`assertNoGhostCalls` 的 `expect(atAnchor).toBeGreaterThan(0)`）+ 另 1 个 | 全绿（agent-core 244 / eval 48 / web 505 / mcp 235 / shared 168 / …） |
| 第 2 次 | **1 失败 / 284 通过**——`v1GoldenScenario.e2e` 的「server restart 恢复在途工作流」（`expected 'FAILED' to be 'SUCCESS'`） | 全绿（同上） |

**判定为负载偶发，不是本批回归**，依据三条：

1. **两次失败的用例不同**（第 1 次 `terminationPropagation`，第 2 次 `v1GoldenScenario`）——确定性回归不会换着花样失败。
2. **`apps/server` 单独跑全量通过**：50 文件 / **285 用例**，退出码 0。
3. **两个失败文件单独跑通过**：2 文件 / 9 用例，退出码 0。

`pnpm -r` 让 15 个包并行，而 `apps/server` 的重型 e2e（真实 PG + Docker + Chromium + 本地交付 + **服务端进程重启**）对时序敏感；这两条用例与用量记账**无因果关系**（一条断言工具调用计数、一条断言重启后工作流终态）。**该现象在本批之前即存在**（`docs/127` §8 已记「后端忙时服务端 e2e 偶发失败」的口径）。**本批未据此改动任何测试**。

## E2E

本批**不跑 E1×3 真实批次**（`docs/176` §6 红线）。真实链路验证由两部分承担：

1. 探针场景 A 的真实外层循环（真实 `AgentRunner` + 真实 `DeepAgentLLMProvider` + 真实内层 deep agent + 真实 `ToolRuntimeBackend`，只假掉端点）；
2. `apps/server` 的 4 个 agent 相关 e2e 文件。

## Known Issues

1. **一条**未追查的观察（**方向与 N-8 相反**，不属本批范围）：探针场景 C 里网关服务了 2 次模型调用，但 `result.messages` 中只出现 **1** 条带 `usage_metadata` 的 `AIMessage`。在该探针脚本下，本轮上报量因此**低于**实际调用量。**这是否对生产的轮次形状成立，本轮未测定**；它是「少算」而非 N-8 的「多算」，本批不修，**登记为开放项**。
2. **`sm-tier-probe.sh` 的口径被收敛**：它原先用探针本地的 `SANE_MAX=10000000`（`docs/177` Known Issue 3 声明「只在探测脚本里」），现改用共享的 1e8 上界。这是**有意的收敛**，但若重跑该脚本，读数会与 `docs/177` 略有出入。**该脚本的既有结果不受影响**。
3. **修复依赖「调用方消息以同引用回带」**：已在当前 `deepagents` 版本上实测成立（场景 C）。若将来该行为改变（改为拷贝），修复会**静默退化**回复利——**15d 的合理性上界正是为这种情形留的安全网**（这也是 §7 第 2 项把两件事分开裁定的原因）。
4. **10-15 的 E1 异常仍未解决**（`docs/177` Known Issues 2）：外层轮数从库里测不出来，`docs/174` §2.5 那条「PL-M14 之前框架先掐断」的子断言无法用库数据校验。维持开放项。
5. **`T-01` 为什么烧满 50 轮**：`docs/176` §1 第 6 项明确排除，本批未动。
6. **便宜档作为常规发现仪器**：`docs/177` 的结论（可作仪器，但 N-8 必须先修）现已具备前提，但**形态 / 频率 / 与 E1×3 的分工需另行裁定**，本批不推进。
7. 前几批的未修项全部维持登记（读侧放行 / 根级源码文件 / `scripts/` / `test/` / `canonicalAcKey` 副本 / N-1b / N-1c / N-3 / 7b / `CHECK_CANDIDATES` / 启动器陈旧实例 / 库内孤儿行 / 内层 deep agent 撞 LangGraph 默认上限）。
8. **本批未跑真实 E1×3**，因此**判据 15h 未取得证据**——它由下一批承担，见 Next Phase Boundary。
9. **全仓 `pnpm -r run test` 存在负载偶发**（非本批引入）：两次跑各失败一个**不同**的 `apps/server` 重型 e2e（`terminationPropagation` FX-36 / `v1GoldenScenario` 重启恢复），而 `apps/server` 单跑 **285/285 全绿**、两个失败文件单独跑也**全绿**。判定与依据见 Lint / Typecheck 一节。**未据此改动任何测试**（不掩盖、不放宽断言）。

## Acceptance Result

**本批是缺陷修复，不新造验收编号。** 按 `docs/176` §3 逐条判定：

| 判据 | 期望 | 结果 |
| --- | --- | --- |
| **15a** | 坏值的**产生环被查明**（指出哪一环、什么条件、有实测证据） | **达成**——`DeepAgentLLMProvider.invoke` 对回灌消息重复计数；条件＝外层循环第二轮起（Implementation §1） |
| **15b** | **探针证明**：真实 `DeepAgentLLMProvider` 跑到平台守卫，逐轮打印交回的 `usage_metadata` | **达成**——场景 A 复现生产故障形态且量级同档；场景 B 给出精确递推（Implementation §2） |
| **15c** | 根因被消除（在平台侧） | **达成**——修复后同一路径读数由 5.6×10¹⁷ 降至 49,000，递推消失（Implementation §3） |
| **15d** | 配额守卫不再被单条异常值废掉 | **达成**——真实库读数由 6.4×10¹⁸ 降至 121,129,829（Implementation §4） |
| **15e** | 不改任何历史 `agent_runs` 行 | **达成**——本批零数据库写操作；11 条坏值原样（Implementation §5） |
| **15f** | 不引入语义漂移 | **达成**——`sumTokenUsage` / `estimateCostUsd` / `maxIterations` / `recursionLimitFor` 均未动 |
| **15g** | 既有断言逐字不变 | **达成**——`DeepAgentLLMProvider.test.ts` 既有 6 用例一字未改且全绿；全仓门禁绿 |
| **15h** | **真实批次里坏值零出现**，守卫读数回到合理量级 | **延期**——本批按 §6 不跑 E1×3；守卫读数一侧已单独验收（15d） |

**⇒ 15a–15g 达成；15h 延期至下一批。本批不判「N-8 已关闭」——按 [[acceptance-under-claim]] 的口径，只有真实批次里坏值零出现才关闭。**

## Next Phase Boundary

**未开始事项（STOP）**：

- **未跑任何真实批次**（E1×3 或便宜档）。判据 **15h 未取证据**。下一批何时开、以什么形态开，见 `docs/176` §7 第 5 项：**另开一批 E1×3**（新结果目录），**不续跑 L1-M4f**；开工前三件事（确认周配额余量 / 先停 `:47558` 上的陈旧实例再重启 / harness 后台任务 + **立即** arm 看门狗，停机必须 cancel 服务端工作流）。
- **未做**：未升级或更换任何依赖；未清理库内孤儿行；未动 `T-01`；未追查 Known Issues 1 的那条「少算」观察；未测 L 档。
- **未裁定**：便宜档作为常规发现手段的形态 / 频率 / 与 E1×3 的分工。
- **已登记但未开工**：`docs/176` §1 的其余排除项（读侧放行、根级源码文件、`scripts/`、`test/`、N-1b / N-1c / N-3 / 7b / `CHECK_CANDIDATES`）。
- **不变量**：不改 `packages/eval` 的夹具与 oracle；不改 `EvalPolicy`；不改 L1-8 判据口径；不修改任何 `dist/`（除各包正常 `build` 产物）；不修改历史 `tasks` / `agent_runs` / `workflow_events` 行。
- 收口时同步登记账：`docs/176`（§7 裁定结果 + 状态行）、`docs/146` §3 / §4 / §5、`docs/127` §6。
