# 182 · N-6「`reasoning_content` 回传 400」**复发**修复实施记录（PL-M17）

> 状态：**已实施，PASS-PARTIAL 收尾**（2026-10-18）。用户裁定「**都按你的建议，开工 PL-M17**」——即任务书 `docs/181` §7 八项待裁定**全部按推荐值接受**。**判据强度以本文件为准**。
> 依据：任务书 `docs/181`、**实探两枚**（`packages/agent-core/scripts/probe-n6-recurrence.ts`、`probe-n6-gateway-rule.ts`，均本批新增；结果 `packages/eval/results/n6-recurrence-probe{,-after}/`、`n6-gateway-rule-probe{,-after}/`）、l1-m4h 三 run 实测、`docs/172` / `docs/173`（PL-M13 正本）、`docs/129` §事故 2、依赖补丁实查。
> 性质：**本文件是实施结果正本**。**不新造验收编号**；本批修的是缺陷（N-6 复发 → PL-M17）。

## Modified Files

| 文件 | 改动 |
| --- | --- |
| `patches/@langchain__openai@1.5.11.patch` | **加第三行**（`.js` / `.cjs` 各一处）：带 `tool_calls` 而没有 `reasoning_content` 的 assistant 消息，补一个空字符串。patch hash `7cc3de24…` → **`66b743ae…`**。**这是本批唯一的生产行为改动** |
| `packages/agent-core/src/__tests__/llmProvider.test.ts` | **新增** 1 个用例（平台侧调用契约）。既有 **10** 个用例一字未动 |
| `packages/agent-core/scripts/probe-n6-recurrence.ts` | **新增**。真实栈 + **规则强制型假网关**，三场景 |
| `packages/agent-core/scripts/probe-n6-gateway-rule.ts` | **新增**。直接问**真实网关**接受哪些消息形状（R0–R7） |
| `packages/eval/results/n6-recurrence-probe/` `…-after/` | **新增**。修复前后的假网关测量（**两份都在，未丢**） |
| `packages/eval/results/n6-gateway-rule-probe/` `…-after/` | **新增**。真网关测量——**两份都是「规则窗口未开」的那次**（R1 全 200）。**第一次那个「窗口开着」的原始测量已被覆盖，见 Known Issues 11** |

**未改动**：`DeepAgentLLMProvider.ts`（PL-M15 / PL-M16 的成果）、`LangChainLLMProvider.ts`（PL-M13 的两处重建点）、`AgentGraph.ts`、`AgentRunner.ts`、`maxIterations` / `recursionLimitFor`、写范围（PL-M5 / PL-M10 / PL-M11）、`packages/eval` 的夹具 / oracle / `EvalPolicy` / L1-8 判据、任何历史 `tasks` / `agent_runs` / `workflow_events` 行。

## Implementation

### 1. 定位（判据 17a）：H-A 成立，且成因不在平台侧的重建点

任务书 §2.2 已逐条排除五个候选（PL-M13 的两处重建点、PL-M16 的 `withoutToolCalls`、依赖补丁、`deepagents` 的三处重建）。剩下的问题是「那条消息从哪来」。

**假网关探针**（`probe-n6-recurrence.ts`）把网关的规则**实现出来**——「请求里存在带 `tool_calls` 而无 `reasoning_content` 的 assistant 消息则拒绝」——并让脚本化的响应**中途停止携带 `reasoning_content`**（复刻间歇性）：

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| **A** 每轮都带 reasoning（对照） | `succeeded`，0 违规 | `succeeded`，0 违规 |
| **B** 中途停止带 reasoning | `succeeded`，0 违规 | `succeeded`，0 违规 |
| **C** 全程不带 reasoning | **`failed` / `LLM_ERROR`，2 次拒绝** | **`succeeded`，0 违规** |

C 的报错与生产**逐字同形**，违规消息也同形：

```
[3] role=assistant tool_calls=Y reasoning=absent   <== RULE PREDICATE
[4] role=tool      ... 1 PROBE_FILE_LINE_ONE 2 PROBE_FILE_LINE_TWO
```

**assistant 带 `tool_calls` 但不带 `reasoning_content`，紧跟一条 `read_file` 的结果**——与 l1-m4h 里 3/5 条失败的最后形态一致。

**B 为何没复现（这一条本身是发现）**：查原始 body，B 的第二轮历史里 `assistant tc=n`——**PL-M16 把 provider 交回外层的消息里的 `tool_calls` 剔掉了**，所以违规消息**不跨外层轮次**。⇒ **复现只发生在「单次内层运行之内」**，触发条件收窄为：

> 同一次内层 deep agent 运行里，网关至少有一轮没回 `reasoning_content`，而它下一轮处于 thinking 模式。

与「网关间歇性进入 thinking 模式」（`docs/173` KI 6）吻合，也解释了轮次跨度 17–54 而非固定值。

### 2. 真实网关实测（判据 17a 的证据面）：网关接受空字符串

假网关的规则是**我写的**，不是网关的。所以第二步直接问真网关（`probe-n6-gateway-rule.ts`，`https://opencode.ai/zen/go/v1` + `deepseek-v4.1-flash`）：

| 变体 | 消息形状 | 结果 |
| --- | --- | --- |
| R0 | 仅 user | 200 |
| **R1** | assistant(tool_calls, **无** reasoning) + tool | **400 — 与生产逐字同一条错误** |
| **R2** | assistant(tool_calls, `reasoning_content: ""`) + tool | **200** |
| **R3** | assistant(tool_calls, `reasoning_content: " "`) + tool | **200** |
| R4 | assistant(tool_calls, reasoning="…") + tool | 200 |
| **R5** | 去掉 tool_calls、**保留** tool 结果 | **400 — 另一条规则**：`Messages with role 'tool' must be a response to a preceding message with 'tool_calls'` |
| R6 | tool_calls 与 tool 结果**都**去掉 | 200 |

**三条读数**：① H-A 在真网关上确认；② **规则是「存在」而非「非空」**——空串即可满足，这使修法成为可能；③ **只去 `tool_calls` 不可行**（撞另一条规则），所以候选 3 被否。

### 3. 根因修复（判据 17b）：补丁第三行

```js
if (completionParam.role === "assistant" && Array.isArray(completionParam.tool_calls) && completionParam.tool_calls.length > 0 && typeof completionParam.reasoning_content !== "string") completionParam.reasoning_content = "";
```

沿用**既有补丁的同一文件、同一机制**（`pnpm patch` + `pnpm patch-commit`），`.js` / `.cjs` 各加一行。

**为什么是这个位置**：转换器里 `completionParam.tool_calls` 在 `:589-592` 才被赋值，所以这一行必须排在它之后。**为什么是这个条件**：`typeof … !== "string"` 只在**网关没给过**时才补——已有的真实 reasoning **一个字都不覆盖**（R4 的路径不受影响）。

**为什么不去掉 `tool_calls`**：R5 实测证明那样会撞上网关的另一条规则。**为什么补空串而不是别的**：R2/R3 实测两者都行，空串更小、更不引入噪声。

### 4. 修复后的探针读数

```
--- request #8  scenario=C_no_reasoning_at_all  turn=1  accepted ---
    [3] role=assistant tool_calls=Y reasoning=empty
    [4] role=tool      tool_calls=n reasoning=absent  1 PROBE_FILE_LINE_ONE 2 PROBE_F

A_all_reasoning      succeeded  rejections=0
B_reasoning_stops    succeeded  rejections=0
C_no_reasoning_at_all succeeded  rejections=0     <- 修复前是 failed / LLM_ERROR / 2 次拒绝
```

出站那条消息由 `reasoning=absent` 变为 **`reasoning=empty`**——正是补丁补上的那个空字符串。

### 5. 平台侧调用契约的单测

补丁改的是第三方件，所以单测钉的是**平台侧的契约**（`llmProvider.test.ts`）：从 LangChain 消息对象出发，经 `createOpenAIChatModel` 与**打了补丁的转换器**，出站 body 里那条带 `tool_calls` 的 assistant 消息**必须带 `reasoning_content`**，且 `tool_calls` **仍在**（不去掉它）。用 stub 的 `globalThis.fetch` 捕获出站 body，不碰网络。

**红/绿的证据面在探针上**（C 由 `failed` 变 `succeeded`、body 由 `absent` 变 `empty`），不在这个用例上——**该用例没有做「回退补丁即失败」的验证**（回退补丁要重装依赖，代价与风险都不小）。如实标注。

## Architecture Changes

**无。** 未新增包、未新增顶层目录、未新增依赖。

**未破坏架构不变量**：未新增第二套错误码 / Approval / Audit；补丁只改出站消息形状，不动 Tool Runtime（`AGENTS.md` §10）。

## Dependencies

无新增运行时依赖。**`@langchain/openai@1.5.11` 的补丁内容有变**（本批唯一动到的第三方件）：由 2 行变 3 行，patch hash `7cc3de24…` → `66b743ae…`。`pnpm-workspace.yaml` 的 `patchedDependencies` 条目不变（同一条目、新内容）。

## Tests

| 层（`docs/181` §5） | 内容 | 结果 |
| --- | --- | --- |
| **第 1 层：探针定位** | `probe-n6-recurrence.ts`（规则强制型假网关，三场景）+ `probe-n6-gateway-rule.ts`（真网关 R0–R7） | **完成**。**如实标注**：`scripts/` 不在 `tsconfig.include` 与 eslint 范围内，两支探针**未被门禁覆盖**（与既有五支探针同一惯例） |
| **第 2 层：单测** | `llmProvider.test.ts` 新增平台侧契约用例 | **完成**（+1）。**未做回退验证**，见 Implementation §5 |
| **第 3 层：回归** | `agent-core` 全量 **246 用例 / 35 文件**（既有 245 + 新增 1）；N-6 的既有 `reasoning_content` 用例、N-8 的 `innerProducedAIMessages` 用例、N-9 的 `tool_calls` 用例**全部仍绿** | **全绿** |
| **第 4 层：真实网关回放** | 单个真实任务经 `:47558` 跑通、探针窗口内 400 零出现 | **未达成**，见 Known Issues 1 |
| 共享夹具核对 | 全树 grep 依赖出站消息形状的精确断言 | **完成**：唯一相关断言是本批新增的那条 |
| A/B 实测（强制） | `apps/server` 的 6 个 agent 相关 e2e：`agentRunPersistence` / `professionalAgents` / `terminationPropagation` / `metricsEndpoint` / `workflowTrace` / `workflowCorrelation` | **6 文件 / 13 用例全绿** |
| 门禁 | `corepack pnpm --filter @ai-se/agent-core run typecheck && lint && test` | **全绿** |

## Lint

- `corepack pnpm --filter @ai-se/agent-core run lint` → 通过
- 全仓 `corepack pnpm -r run lint` → 通过（exit 0）

## Typecheck

- `corepack pnpm --filter @ai-se/agent-core run typecheck` → 通过
- 全仓 `corepack pnpm -r run typecheck` → 通过（exit 0）

## E2E

全仓 `corepack pnpm -r run typecheck && lint && test` → **typecheck exit 0 / lint exit 0**；`test` **1 处 `apps/server` e2e 失败**，判定为**负载偶发，不是本批回归**：

| 项 | 结果 |
| --- | --- |
| 其余 **15 个包** | **全绿**（`agent-core` **246** / `apps/web` 505 / `mcp` 235 / `shared` 168 / `visual` 83 / `eval` 48 / `database` 47 / `workflow-engine` 45 / `browser` 38 / `tool-runtime` 32 / `failure-recovery` 16 / `action-policy` 13 / `evidence` 9 / `sandbox` 8 / `observability` 3） |
| `apps/server` | **1 失败 / 284 通过**——`v1GoldenScenario.e2e.test.ts`「server restart: a fresh engine recovers in-flight work」 |

**判定依据**：**该文件单独跑通过**（1 文件 / 4 用例，退出码 0）。它是**又一个不同的**文件——PL-M15 收尾时两次全仓跑分别失败的是 `terminationPropagation` 与 `v1GoldenScenario`，PL-M16 收尾时是 `planningEscalation`；`pnpm -r` 让 16 个包并行，而 `apps/server` 的重型 e2e（真实 PG + Docker + Chromium + 服务端进程重启）对时序敏感。**该现象在本批之前即存在**（`docs/127` §8 已记口径）。**本批未据此改动任何测试**（不掩盖、不放宽断言）。

**本批不跑 E1×3 真实批次**（任务书 §4 裁定 5）。真实链路验证由两部分承担：两支探针（其中一支直接打真网关）+ `apps/server` 的 6 个 agent 相关 e2e。

## Known Issues

1. **真实网关上的修法验证未完成（本批最重要的未达成项）**。第二次跑 `probe-n6-gateway-rule.ts` 时，**规则窗口没有开**——R1 在 **20 轮里全部 200**，即网关当时不在 thinking 模式。探针**如实报告了这一点**（`rule did NOT fire in 20 rounds - the fix could not be verified against the real gateway in this window`），没有把 R7 的 200 当成功。**第一次跑时窗口是开的**（R1=400 且报错与生产逐字同形），但那一次 R7 还不存在。⇒ **修法在真网关上「已验证」的结论目前拿不出来**；已把探针留在仓库里（`--rounds N`），窗口开启时重跑即可。
2. **`reasoning_content: ""` 的语义影响未评估**。模型会在历史里看到一条「空的思考回显」。R2/R3 实测网关接受，且响应正常（`reply="done"`），但**模型如何解读这个空字段未被测量**。登记为观察项。
3. **补丁是第三方件，升级 `@langchain/openai` 即失效**（与既有两行补丁同一风险面，`docs/173` KI 4）。本批**未新增**缓解机制。
4. **探针在门禁之外**（`scripts/` 不在 `tsconfig.include` 与 eslint 范围）。改动探针后必须手工跑一次。
5. **B 场景在修复前后都 `succeeded`**——它不是复现场景，而是**揭示「违规消息不跨外层轮次」**的对照。判据只认 C。如实标注，避免读者以为 B 也是证据。
6. **口径变化（按 §7 第 4 项登记）**：本批起，出站请求里**带 `tool_calls` 且网关未给过 reasoning 的 assistant 消息会多一个空 `reasoning_content`**。**语义内容未变**（tool_calls 与 tool 结果都在），但送出的字节变了。与历史批次的可比性：**判据口径（L1-8 的 staging 段 ≥2/3）不受影响**，因为该字段不参与任何验收判定；如后续发现模型行为差异，以此条为追溯起点。
7. **l1-m4h 暴露的另两项未动**：「核心实现切片的 BACKEND 任务过不去」（三次复现）与 `EMPTY_FINAL_ANSWER`（5 条）。按 §7 第 7 项**只登记，另行立项**。
8. **前几批的未修项全部维持登记**（读侧放行 / 根级源码文件 / `scripts/` / `test/` / `canonicalAcKey` 副本 / N-1b / N-1c / N-3 / 7b / `CHECK_CANDIDATES` / 启动器陈旧实例 / 库内孤儿行）。
9. **探针消耗**：两支探针合计约 **40 次**极小请求（多数 `max_tokens: 8`）。相对周配额可忽略，但**它花的是真实网关配额**，故在脚本头部注明「刻意运行，不随每次迭代跑」。
10. **全仓 `pnpm -r run test` 存在负载偶发**（非本批引入）：本次全仓跑 1 个 `apps/server` 重型 e2e 失败（`v1GoldenScenario.e2e`「server restart: a fresh engine recovers in-flight work」），**单独复跑即绿**（1 文件 / 4 用例）。PL-M15 收尾时失败的是 `terminationPropagation` 与 `v1GoldenScenario`，PL-M16 收尾时是 `planningEscalation`——**每次都是不同的文件**，符合负载偶发的特征。判定方法与本仓既有记录一致（`docs/127` §8）。**未据此改动任何测试。**
11. **第一次「规则窗口开着」的真网关原始测量被我覆盖了（本批的操作失误，如实登记）**。`probe-n6-gateway-rule.ts` 的默认 `--out` 是 `packages/eval/results/n6-gateway-rule-probe`；**我后来为了验证一处路径修复又跑了一次，没有加 `--out`，于是把第一次那份（R1=400 / R2=200 / R3=200 / R5=400）覆盖成了「窗口未开」的那次（R1 全 200）**。⇒ 盘上现存的两份 `n6-gateway-rule-probe{,-after}/` **都是窗口未开的**。**该次测量的数字仍可追溯**：它们逐字记在本文件 §2 的表格里（写作时读的是实时输出），且 R1 的报错字符串与生产 `agent_runs.error` **逐字相同**、可独立复核。**但原始 JSON 已不在盘上。**
    **两处处置**：① 探针的 `--out` 现在**相对仓库根解析**（原先 `pnpm --filter <pkg> exec` 的 cwd 是**包目录**，相对路径会落到 `packages/agent-core/packages/…`——那个错位的目录已移回并清理）；② **以后每次运行必须显式 `--out` 到带日期/轮次后缀的新目录**，不依赖默认值。**这条登记是为了让下一次不要重犯**：可复现的诊断资产，一旦被自己的重跑覆盖，就等于没有。

## Acceptance Result

**PASS-PARTIAL。** 按任务书 `docs/181` §3 逐条判定：

| 判据 | 期望 | 结果 |
| --- | --- | --- |
| **17a** | 复发的**产生点被指认**——抓到实际载荷，指出哪条消息、由谁构造 | **达成**——假网关探针 C 复现并指认（Implementation §1）；**真网关 R1 逐字复现同一错误**（§2） |
| **17b** | **真实栈探针**证明修复有效 | **达成**——C 由 `failed`/`LLM_ERROR`/2 次拒绝 → `succeeded`/0 违规；出站消息由 `reasoning=absent` → `reasoning=empty` |
| **17c** | 补做 PL-M13 未做的**真实网关回放** | **未达成**——Known Issues 1。规则窗口在验证时未开，20 轮零触发；探针如实报告，未冒认 |
| **17d** | **不引入语义漂移**——不启用 `thinking:{type:"disabled"}`；不改 temperature / model / 网关头 | **达成**——均未动 |
| **17e** | PL-M13 的成果**逐字不变** | **达成**——两处重建点仍在；补丁原两个 hunk 逐字保留（新行是**追加**） |
| **17f** | N-9 / N-8 的既有断言逐字不变且全绿 | **达成**——`agent-core` 246 用例全绿 |
| **17g** | 既有 LLM 层 / 图层测试断言逐字不变 | **达成**——`llmProvider.test.ts` 既有 10 例一字未改 |
| **17h** | 若查明为网关侧、平台无可修点则不阻塞 | **不适用**——已查明平台侧**可修**（补空串），且修法经假网关证明有效 |

**⇒ 17a / 17b / 17d–17g 达成；17c 未达成；17h 不适用。**

**为什么是 PASS-PARTIAL 而不是 PASS**：17c 没做到。我不想把「假网关探针通过 + 真网关确认了规则形状」说成「真实链路验证通过」——**两者差一次规则窗口开启**。按「边界项宁标延期也不勾选」的口径，如实标为未达成。

**另需如实标注**：本批**尚未证明**这次修复能让真实批次里 N-6 不再出现。真正的检验是下一批 E1×3。

## Next Phase Boundary

**未开始事项（STOP）**：

- **未跑任何真实批次**，未做单任务真实回放。判据 **17c 未取证据**。下一批何时开、以什么形态开，见任务书 `docs/181` §7 第 5 项：**另开一批 E1×3**（新结果目录），**不续跑 l1-m4h**。开工前三件事：① 确认周配额余量；② 先停 `:47558` 上的陈旧实例再重启（`l1-m4-server-launch.sh` 只要端口有应答就**静默复用**）；③ harness 后台任务 + **立即** arm 看门狗（`--heartbeat-min 30 --stall-min 25`），停机**必须** cancel 服务端工作流。
- **下一批的头号观察项**：① `reasoning_content` 400 是否**零出现**（本批修复的唯一真实检验）；② 能否越过 slice-3——run 3 已首次到达；③ 「核心实现切片的 BACKEND 任务」那堵墙是否仍在（**这是下一批最可能拦住链的**）；④ `EMPTY_FINAL_ANSWER` 频率。
- **未做**：未追查 `EMPTY_FINAL_ANSWER`；未追查 BACKEND 任务那堵墙；未做「重建消息必须保留 `additional_kwargs`」的不变量化（§7 第 6 项，另立议题）；未评估空 `reasoning_content` 的语义影响（Known Issues 2）；**未保住第一次真网关测量的原始产物**（Known Issues 11）。
- **重跑 17c 时请注意**：`probe-n6-gateway-rule.ts --rounds N --out packages/eval/results/n6-gateway-rule-probe-<日期>`——**必须显式指定 `--out`**，否则会覆盖上一次的产物（Known Issues 11）。判据是「**R1 被拒（400）** 的那个窗口里 **R7 = 200**」；R1 全 200 的窗口**证明不了任何事**。
- **未裁定**：便宜档探针的形态 / 频率（自 `docs/177` 挂起）；`T-DESIGN-S1` 计划粒度；`src/scaffold.test.js` 的归属（l1-m4h run 1 开放项）。
- **不变量**：不改 `packages/eval` 的夹具与 oracle；不改 `EvalPolicy`；不改 L1-8 判据口径；不修改任何 `dist/`（除各包正常 `build` 产物）；不修改历史 `tasks` / `agent_runs` / `workflow_events` 行。
- 收口时同步登记账：`docs/181`（§7 裁定结果 + 状态行）、`docs/146` §3（N-6 行**追加复发记录**）/ §4（PL-M17 行）/ §5、`docs/173` 末尾追加勘误块（KI 6 / KI 7 的状态更新）、`docs/127` §0 / §6 / §9。

## 勘误追加块（2026-10-18，L1-M4i 批次收尾后）

**本块只更正状态，正文按历史记录保留不改**（`docs/146` §6 规则 7）。

**被本块更正的两处原文**：

1. **Known Issues 1** 与 **Acceptance Result** 里的判据 **17c**——原文写「真实网关上的修法验证未完成……窗口开启时重跑即可」，并注明「**本批尚未证明这次修复能让真实批次里 N-6 不再出现。真正的检验是下一批 E1×3**」。
2. **Next Phase Boundary** 里「下一批的头号观察项」第 ① 条（`reasoning_content` 400 是否零出现）。

**现状（L1-M4i 批次，`packages/eval/results/l1-m4i`）**：

- **该批次已跑（E1×3 执行 2/3、因配额中止）**，它就是原文所说的「下一批 E1×3」——run 1 10:59:56→11:52:42、run 2 12:22:44→14:27:27，run 3 于 14:57:28 被守卫按设计挡下（退出码 2）。
- **✅ N-6 零出现**：全批 **76 个 agent run（全部 succeeded）**，`error LIKE '%reasoning_content%'` **零条**（全库仍 **22** 条，未增）；另一条 N-6（`tool message content`）**零条**。⇒ 原文那句「本批尚未证明……真正的检验是下一批 E1×3」**已取得结果：真实链路上未被推翻**。
- **🔴 但 17c 维持「未达成」。** 批次期间**没有连续探测**网关的 thinking 规则；该规则是**间歇**的（批前 10:05 实测 R1=400、10:25 实测 R1=200，分钟级翻转），故**不能断言条件在这 3.5 小时里一定被行使过**。76 run 零出现与修复生效**一致**，但**不是「条件被行使」的证明**——与 Known Issues 1 的诚实口径一致。**重跑 17c 的要求不变**（Known Issues 11：必须显式 `--out`；判据是「R1 被拒（400）的那个窗口里 R7 = 200」）。
- **⇒ N-6 不判「已关闭」。**
- **一处归因更正（不在本批范围，但与本批同期发现）**：原文 Next Phase Boundary 把「核心实现切片的 BACKEND 任务」列为**下一批最可能拦住链的墙**。**L1-M4i 证明这一定性偏高**——`checks failed: test` 只在两个 BACKEND 任务上各出现一次（run 1 的 `T6` / `T5`，run 2 slice-2 一处），**重试后全部 SUCCESS**。本批真正的致败点是两个**非 BACKEND** 类型的任务：`T10`（**TEST**，三次 `VACUOUS_TEST`）与 `T-S4-R2`（**REVIEW**，三次 `INVALID_AGENT_RESULT`）。**〔同日更正，见 `docs/183`〕** 后半句**是错的**：`INVALID_AGENT_RESULT` 在 L1-M4i 里属于**另一个任务** `T-S4-R1`（且 `retry=1 → SUCCESS` 自愈）；`T-S4-R2` 的 `outcomeMode` 是 **`tool`**、`outcome=FAILED`，是 **agent 诚实的负结论**。两处致败点**均为平台侧**（N-10 红灯检查作用域回退 / N-11 REVIEW 负结论无出路），**不是「产物质量」**——**已立项 PL-M18，任务书 `docs/183`（八项待裁定）。**该更正的正本在 `docs/127` §0 / §9 与 `docs/146` §5。
- **本批链走到迄今最深**：run 2 首次连过 slice-3、**首次进入 slice-4**（9/10）；**staging 段 0/2 ⇒ L1-8 仍未达成**。**本批未改动任何生产文件**（`docs/182` 记录的那处补丁是本批之前落地的）。
