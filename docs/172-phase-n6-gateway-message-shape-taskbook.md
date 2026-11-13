# 172 · N-6「网关消息形状 400」修复任务书（PL-M13）

> 状态：**已实施并收尾**（2026-10-17）。用户同日裁定「**都按你的建议，开工 PL-M13**」——即 §7 七项待裁定全部按推荐值接受。**实施记录 `docs/173`**——其中 §2 记录了**对本文档的 3 处更正**：① **§2.4 的「丢失点 ②」是错的**（`toAIMessage` 的 chunk 分支在本版本 `@langchain/core` 里**是死代码**——`AIMessageChunk` 继承 `AIMessage`，第一个分支就原样返回）；② **真正的第二处丢失点是 `LangChainLLMProvider.invoke` 挂成本时的重建**；③ **错误 ② 的根因已查明**——不是「未查明」，是 `deepagents` 库的 `read_file` 返回内容块数组。**判据强度以 `docs/173` 为准**。
> 编号：里程碑 **PL-M13**；缺陷登记号 **N-6**（新登记，接 N-1…N-5 之后）。
> 依据：L1-M4d run 1/2/3 实测（`packages/eval/results/l1-m4d/`、工作流 `2af5e078` / `3cf733a9` / `1e436a66`）、**`docs/129` §事故 2（既有诊断，本批的主依据之一）**、dev 库全量实查（`agent_runs` 全历史）、代码实查（`DeepAgentLLMProvider.ts` / `LangChainLLMProvider.ts` / `AgentGraph.ts` / `ToolRuntimeBackend.ts` / `ProfessionalAgent.ts` / `AgentRunner.ts`）、依赖补丁 `patches/@langchain__openai@1.5.11.patch`、`pnpm-workspace.yaml`、`AGENTS.md` §7/§9/§10。
> 性质：修的是缺陷，不是新增能力；**不新造验收编号**。

## 0. 为什么现在做这一批

1. **它是唯一拦住后续所有批次的点。** L1-M4d 三次运行全部死在 agent 层的网关 400：run 1 止于切片 2、run 2 止于切片 1、run 3 在停止前 20 秒也撞上同一个错误（T-02，第 49 轮）。**在它修好之前，再开任何 E1×3 都会以同样方式死掉**——与计划形状、切片划分、任务类型都无关。
2. **PL-M11 / PL-M12 至今一次未被检验。** 三次都没跑到交付切片 `ui-deploy-docs`，根 `Dockerfile` / 根 `README.md` 的任务从未被执行。也就是说，上一批的修复**还没有被验证过**，而验证它必须先越过 N-6。
3. **错误 ① 是复发，不是新缺陷**——但 `docs/129` 把它整体归为「上游间歇性」，**这个归因不完整**（§2.4）：平台侧存在一处可指认的丢失点。按 `docs/146` §6 规则 7，`docs/129` 原文保留不改，更正以追加块落在该文件末尾（§6 收口清单）。
4. **错误 ② 是今天首次出现**，机制**尚未查明**（§2.3）。它可能同源、也可能独立，必须在动手修之前先查明——否则修完 ① 仍会死在 ②。

## 1. 范围

| # | 条目 | 判定 |
| --- | --- | --- |
| 1 | **PL-M13**：消除 `reasoning_content` 回传链路上的平台侧丢失点 | **真缺陷**（协议面） |
| 2 | **PL-M13**：查明 `tool message content must be a string` 的产生点 | **先诊断，后处置**（机制未知） |
| 3 | **PL-M13**：以**定向探针 + 单个真实任务回放**验证，不跑完整 E1×3 | 方法面（见 §5） |

**明确排除**（本批不动）：

| # | 条目 | 排除理由 |
| --- | --- | --- |
| 4 | 启用网关的 `thinking:{type:"disabled"}` 开关 | `docs/129` §事故 2 已明确**未采用**——它会改变与 E-2b / F / G / L1-M4* 全部历史批次的可比语义。仅当 §4 裁定 2 的条件成立才启用，且须按 `docs/146` §6 规则 8 登记口径变化 |
| 5 | 升级 / 更换 `@langchain/openai` | 补丁会失效；新版本行为未知；且现版本是**已打补丁并被真实栈验证过**的版本（`docs/129`） |
| 6 | 读侧放行（PL-M11 KI 1）、根级源码文件、`scripts/`、`test/` | 均维持既有登记（`docs/171` Known Issues 1–4） |
| 7 | N-1b / N-1c / N-3 / 7b / `CHECK_CANDIDATES` | 均维持既有登记 |
| 8 | 启动器静默复用陈旧实例（`docs/169` KI 8） | 属相邻工作；**但它是每批开工前的手工前置动作**，见 §6 |
| 9 | 清理库内孤儿行（68 条 `READY` + `1e436a66` 等 RUNNING 工作流） | 独立议题，需另行裁定（`docs/127` §6 已登记） |

## 2. 基线事实（代码、库、依赖三方实查，2026-10-17）

### 2.1 错误 ①：`reasoning_content` —— **复发**，且既有归因不完整

**错误原文**（`agent_runs.error`，逐字）：

```
400 Upstream request failed: [invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API. (request_id: 18a7a8f6-…)
```

**既有诊断**（`docs/129` §事故 2，2026-10-09）：判定为**上游网关间歇性行为**，非代码退步；根因链为「`@langchain/openai@1.5.11` 响应解析把 `reasoning_content` 存入 `additional_kwargs`，而请求方向转换 `convertMessagesToCompletionsMessageParams` 不回传该字段」；修法是 **pnpm 补丁**（`patches/@langchain__openai@1.5.11.patch`，.js/.cjs 各一行）。

**实查（本次）**：

- 补丁**已声明且已应用**：`pnpm-workspace.yaml:25-26` 有 `patchedDependencies`；已安装包目录名带 patch hash；`dist/converters/completions.js:588` 存在补丁行：
  ```js
  if (typeof message.additional_kwargs.reasoning_content === "string" && message.additional_kwargs.reasoning_content.length > 0 && completionParam.role === "assistant") completionParam.reasoning_content = message.additional_kwargs.reasoning_content;
  ```
  响应侧亦已填充（同文件 `:160` / `:175` / `:263`）。
- **补丁生效的前提是「消息自身携带非空 `additional_kwargs.reasoning_content`」。** 因此凡是**重建过** `AIMessage` 的地方，都会把该字段丢掉，补丁随之失效。
- **平台代码里 `additional_kwargs` 一次都没出现**（全树 grep：`packages/agent-core/src/**`、`apps/server/src/**` 命中 0，生产代码）。**没有任何一处保留它。**
- 已定位**两处**重建点（§2.4）。故 `docs/129` 的「上游间歇性」归因**不完整**：上游确实要求回传，但**平台侧存在可指认的丢失点**使其无法回传——这解释了「打了补丁仍复发」。

### 2.2 错误 ②：`tool message content must be a string` —— **今天首次出现，机制未查明**

**错误原文**（逐字，注意末尾的 `on the gRPC path`）：

```
400 Upstream request failed: [invalid_request_error] tool message content must be a string on the gRPC path (request_id: gw-275c2fc21cdf-57388)
```

**实查结论（含已排除项，逐条列出以免重复推演）**：

| 候选来源 | 结论 |
| --- | --- |
| 平台自己的 `new ToolMessage` | **排除**。全树只有 2 处（`abortTermination.ts:26` 字符串字面量、`AgentGraph.ts:363` 的 `JSON.stringify(...)`），均为字符串 |
| `sanitizeLogData` 返回 `undefined` | **排除**。对 record 恒返回 `Object.fromEntries(...)` |
| `deepagents` 库的 ToolMessage | **排除**。整包 dist 共 14 处 `new ToolMessage`（含 `ToolMessage$1` 别名），逐处读过，content 表达式全部产出字符串 |
| 自定义工具的返回值包装 | **排除**。`ToolRuntimeBackend.createCustomTools()` 返回 `JSON.stringify(sanitizeLogData(await this.executeTool(...)))`，字符串 |
| `AgentGraph` 的 tools 节点 | **排除为「唯一来源」**，但不排除其参与（见下） |

**未查明**。剩余候选：`@langchain/core` 的工具返回值包装（工具返回非字符串时如何构造 `ToolMessage`）、`@langchain/openai` 的请求序列化、或上游网关自身。

**必须承认的一点**：本错误与错误 ① 共享 `request_id` 前缀 `gw-275c2fc21cdf`（run 1 与 run 2 各一条），即**同一网关节点**；两者都出现在**今天**。存在「网关今天切到更严格的 gRPC 后端、同时开始强制两条规则」的可能，但**这是推测，本任务书不据它下结论**。

### 2.3 两次错误的全库分布（`agent_runs` 全历史，按日）

| 日期 | `reasoning_content` | `tool message content` | 当日 LLM_ERROR 总数 |
| --- | --- | --- | --- |
| 2026-09-29 | 0 | 0 | 3 |
| 2026-10-07 | **3** | 0 | 3 |
| 2026-10-09 | **7** | 0 | 7 |
| 2026-10-13 | 0 | 0 | 7 |
| 2026-10-14 | **3** | 0 | 3 |
| 2026-10-16 | 0 | 0 | 1 |
| **2026-10-17** | **3** | **6** | 9 |

**逐条明细（2026-10-17，本批）**：

| 任务 | 类型 | 外层轮次 | 时刻（UTC） | 种类 | 属于 |
| --- | --- | --- | --- | --- | --- |
| T-07 | TEST | 17 / 10 / 9 | 05:14:27 / 05:14:53 / 05:15:06 | tool content | run 1 |
| T-05 | TEST | 26 / 23 / 33 | 05:51:24 / 05:52:06 / 05:55:57 | reasoning | run 2 |
| T-06 | TEST | 12 | 05:52:45 | tool content | run 2 |
| T-07 | BACKEND | 15 | 05:55:27 | tool content | run 2 |
| **T-02** | **BACKEND** | **49** | **06:28:40** | **tool content** | **run 3（停止前 20 秒）** |

**三点读数**：① 两类错误**跨任务类型**（TEST / BACKEND / REVIEW）复发，不是某个任务的特性；② 出现轮次跨度大（9–49），**不是固定轮次阈值**；③ `reasoning_content` 在 10-07 / 10-09 / 10-14 均有记录。**与 `docs/129` 的计数有一处不符，如实标出**：`docs/129` §事故 2 记「10-09 6 次、10-07 3 次」，本次全库实查为 **10-09 7 次、10-07 3 次**（10-09 多 1 条）。差异原因未查（可能是 `docs/129` 写作时点之后的补录，或计数口径不同）；**本文件一律以本次全库实查的 §2.3 表为准**。

### 2.4 架构层级与两处丢失点（实查，本批最重要的技术发现）

**层级**（实查 `ProfessionalAgent.ts:464` / `AgentRunner.ts:121`）：

```
ProfessionalAgent
  └─ new DeepAgentLLMProvider(...)          ← 内层：第三方 deepagents 的 createDeepAgent 全循环
       └─ 交给 AgentRunner
            └─ createAgentGraph({ llmProvider, ... })   ← 外层：自己的 agent ↔ tools 循环
                 └─ agentNode: messages = [SystemMessage(prompt), ...state.messages]
                      → invokeLLMWithRetry(llmWithTools, messages, ...)
```

即：**外层每次「LLM 调用」= 一次完整的内层 deep agent 运行**；外层把内层返回的消息累积进 `state.messages` 并再次送入内层。

**丢失点 ①**：`DeepAgentLLMProvider.invoke` 的返回（`DeepAgentLLMProvider.ts:89-98`）——

```ts
return new AIMessage({
  content: submitted ? submitted.summary : message.content,
  usage_metadata: (usage ?? message.usage_metadata) as AIMessage["usage_metadata"],
  response_metadata: { ...message.response_metadata, agentIterations: ..., ... }
});
```

**只复制 `content` / `usage_metadata` / `response_metadata`，不复制 `additional_kwargs`** → 内层最后一条 AIMessage 上的 `reasoning_content` 在此处被丢弃。

**丢失点 ②**：`LangChainLLMProvider.toAIMessage`（`LangChainLLMProvider.ts:84-98`）——`AIMessageChunk` → `AIMessage` 的重建同样只带 `content` / `tool_calls` / `invalid_tool_calls` / `usage_metadata`，**不复制 `additional_kwargs`**（流式路径）。

**这两处都只是「已定位」，尚未被探针证明是本次 400 的直接成因**（见 §5 第 1 层）。本任务书如实标注这个区别。

### 2.5 影响面

- **E1 夹具**：任何切片、任何任务类型都可能被拦（§2.3 已跨 TEST / BACKEND / REVIEW 复发），**链深度不再取决于计划质量**。
- **其余八个夹具**：同源，同样受影响（错误在 agent 层，与夹具无关）。
- **生产路径**：任何经该网关的 agent 运行都受影响。

## 3. 判据

| 判据 | 期望 |
| --- | --- |
| 13a：`reasoning_content` 回传链路上的**平台侧丢失点被消除**（所有重建 `AIMessage` 的位置都保留 `additional_kwargs`） | 新增。**前提是先由 13b 探针指认**——不许「先把两处都改了就当修好」 |
| 13b：**真实栈探针**证明修复有效——外层循环第 N 轮请求的 assistant 消息**确实带 `reasoning_content`**（复刻 `docs/129` 的 `has_reasoning` 手法） | 新增。这是 13a 的**证据**，不是可选 |
| 13c：错误 ② 的**产生点被查明**（抓到实际请求载荷，指出哪条 tool 消息的 content 不是字符串、它由谁构造） | 新增。**未查明即不得宣称修复** |
| 13d：错误 ② 被修复；**或**证明其在平台侧无可修点（此时须给出证据并另立处置，不得默认收工） | 新增 |
| 13e：**不引入语义漂移**——不启用 `thinking:{type:"disabled"}`，除非 13c/13d 证明必须（若必须，按 `docs/146` §6 规则 8 登记口径变化，并说明与历史批次的可比性后果） | 保持 |
| 13f：`writeTestFiles` / `writeProjectManifests` / `writeRootDeliveryArtifacts`（PL-M5 / PL-M10 / PL-M11）语义与既有断言**逐字不变** | 保持。本批**不得**顺带改动写范围 |
| 13g：既有 LLM 层断言逐字不变（`LangChainLLMProvider` / `DeepAgentLLMProvider` 的现有测试全绿） | 保持 |
| 13h：**定向探针窗口内两类 400 零出现**，且**单个真实任务**（非完整 E1×3）端到端跑通 | 新增（本批的验收载体，见 §5） |

## 4. 设计裁定（本任务书的推荐值）

| # | 事项 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | 修法形态 | **先探针定位（13c / 13b），再定点修**；不预设改动面 | 错误 ② 机制未知；错误 ① 的两处丢失点**也只是候选**。先改后验会把「碰巧好了」当成「修好了」 |
| 2 | 是否启用 `thinking:{type:"disabled"}` | **不启用** | `docs/129` 已明确未采用，理由是**保持与 E-2b / F / G / L1-M4* 全部历史批次的可比语义**。它是「关掉思考模式」——一旦启用，此前所有 staging 段读数与新读数不可比，L1-8 的 ≥2/3 判据也就失去了历史基线。**仅当 13c/13d 证明平台侧确实无可修点**时才回到这一项，且须走 §7 第 2 项 |
| 3 | 修复落点 | **以「所有重建 `AIMessage` 的位置都保留 `additional_kwargs`」为不变量**，而非只补 `DeepAgentLLMProvider` 一处 | §2.4 已定位两处；只补一处，另一处会在流式路径上复发（同一缺陷形状：**同一语义在多处各写一遍必然漂移**，`docs/160`） |
| 4 | 错误 ② 的诊断手段 | **抓实际请求载荷**（探针拦截 fetch，落盘出站 body） | 静态分析已穷尽（§2.2 五条排除）。`docs/129` 的 10-09 探针正是同一手法（`probe-stack-reasoning.ts`，**该文件已不在**，需重写） |
| 5 | 验证载体 | **定向探针 + 单个真实任务回放**，不跑完整 E1×3 | 本批要验的是「400 是否消失」，一个真实任务即可证伪；跑 E1×3 要花 ~25M 且判定（L1-8）与本次修复无直接因果。**验收批次留给修完之后的下一批** |
| 6 | 是否顺带改 `packages/eval` 夹具 / oracle / `EvalPolicy` / L1-8 判据 | **不做** | 红线（`docs/166` §6） |
| 7 | 探针是否入库 | **是**，落在 `packages/eval/scripts/`（与既有批次脚本同处），而非 `~/.hermes/cache/scratch/` | 10-09 的探针放在 scratch 里，**今天已经找不到**——同一诊断下次还得重写。可复现的诊断资产应随仓库走 |

**被否掉的方案（记录，避免重复推演）**：

| 方案 | 否决理由 |
| --- | --- |
| **A｜启用 `thinking:{type:"disabled"}` 一关了之** | 见裁定 2。它绕过症状而非修缺陷，且**摧毁与全部历史批次的可比性**——L1-8 的判据是「staging 段 ≥ 2/3」，历史基线是 E-2b/F/G 一路攒下来的 |
| **B｜升级 `@langchain/openai`** | 补丁是 `pnpm patch` 形式，升级即失效；且新版本是否仍把 `reasoning_content` 放进 `additional_kwargs` 未知。**当前版本是被真实栈验证过的**（`docs/129` §事故 2 的探针） |
| **C｜只改 `DeepAgentLLMProvider` 一处** | §2.4 已定位**两处**重建点。只补一处等于把「一份语义两处各写」留着——正是 `docs/160` 登记的缺陷成因类型 |
| **D｜把 400 当可重试错误吞掉 / 加更大重试** | 掩盖症状。且重试已在发生（本批 `llm_retry` 事件 6 条），400 是**确定性协议错误**，重试不会自愈 |
| **E｜改夹具 / oracle 绕开** | 红线；且错误在 agent 层，与夹具无关 |
| **F｜直接重跑批次看是否自愈** | 与记忆 `fix-known-defects-before-batches` 相悖：验收批次是**验证修复**的，不是发现缺陷的。且 §2.3 显示该错误 10-07 起反复出现，**不自愈** |
| **G｜把 `docs/129` 的「上游间歇性」结论照抄沿用** | §2.1 已证该归因**不完整**：平台侧存在可指认的丢失点。照抄会让缺陷继续被当作「运气问题」 |

## 5. 验证分层

| 层 | 位置（`AGENTS.md` §6 / §7） |
| --- | --- |
| **第 1 层：探针定位（先做，决定改动面）** | 重写 10-09 的探针（`docs/129` §事故 2），落 `packages/eval/scripts/`。拦截出站 fetch，落盘每次请求的 body；对**错误 ①** 断言「外层第 N 轮请求里 assistant 消息带 `reasoning_content`」（`has_reasoning`）；对**错误 ②** 逐条扫描 body 里 `role:"tool"` 的消息，打印其 `content` 的类型与实际值 |
| 第 2 层：单测（丢失点） | `agent-core`：重建 `AIMessage` 的位置保留 `additional_kwargs` 的断言（含 `toAIMessage` 的 chunk 路径）。**先写会失败的用例**，再改 |
| 第 3 层：回归 | 既有 `LangChainLLMProvider` / `DeepAgentLLMProvider` / `AgentGraph` 测试全绿；`agent-core` 全量 |
| 第 4 层：真实栈回放 | 单个真实任务（非完整 E1×3）经 `:47558` 实例跑通，探针窗口内两类 400 **零出现** |
| 共享夹具核对 | 全树 grep 依赖 `additional_kwargs` / 消息形状的精确断言（`AGENTS.md` §7）。本批**不动**写范围相关断言 |
| 门禁 | 受影响包 `typecheck && lint && test`；收尾前全仓 `corepack pnpm -r run typecheck && lint && test` |
| A/B 实测（强制） | `docs/165` §2 偏差 1 的教训：改 LLM 层后**必须先跑** `apps/server` 的 agent 相关 e2e 做改前基线对比 |

## 6. 边界与红线

- **不新增第二套 Permission / Approval / Audit / 错误码体系**（`AGENTS.md` §10）。
- **不改 `packages/eval` 的夹具与 oracle**；**不改 `EvalPolicy`**；**不改 L1-8 判据口径**。
- **不启用 `thinking:{type:"disabled"}`**（除非 §7 第 2 项另行裁定）。
- **不改写范围**（PL-M5 / PL-M10 / PL-M11 的语义与断言逐字不变）。
- 不修改历史 `tasks` / `agent_runs` / `workflow_events` 行。
- 不修改任何 `dist/`（除各包正常的 `build` 产物）。
- **本批不跑 E1×3 批次**；下一批何时开、以什么形态开，见 §7 第 4 项。
- **`docs/129` 的更正以追加块落在该文件末尾**（`docs/146` §6 规则 7：不追改历史记录）。
- 收口时同步登记账：`docs/146` §3（**新增 N-6 行**）、§4（本任务书 §7 的裁定行）、§5（下一批开工门槛）、`docs/127` §5/§6、`docs/129` 末尾追加勘误块。

## 7. 待裁定项（每条带推荐值）

| # | 事项 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | 修法形态（§4 裁定 1 的 C / G） | **先探针定位，再定点修**；以「重建 AIMessage 必须保留 `additional_kwargs`」为不变量 | 见 §4 裁定 1 / 3；错误 ② 机制未知，错误 ① 的两处丢失点也只是候选 |
| 2 | 是否启用 `thinking:{type:"disabled"}` | **不启用** | 见 §4 裁定 2：会摧毁与全部历史批次的可比性，L1-8 的历史基线随之作废 |
| 3 | 错误 ② 若查明为**网关侧、平台无可修点** | **不阻塞**：立观察项 + 记录证据，并把「网关侧严格化的应对」另立议题（可能选项：换模型 / 换端点 / 接受间歇性失败并按 §2.3 的频率评估批次可行性） | 本任务书不预设结论；但**必须留下证据**，不许「查不出就当没有」 |
| 4 | 修完之后下一批怎么开 | **另开一批 E1×3**（新结果目录），**不续跑 L1-M4d** | 与 `docs/164` §7 第 4 项 / `docs/168` §7 第 7 项 / `docs/170` §7 第 8 项同一口径：避免修前/修后混批。**开工前三件事不变**：① 确认周配额余量；② 先停掉 `:47558` 上的陈旧实例再重启（`l1-m4-server-launch.sh` 只要端口有应答就**静默复用**）；③ harness 追踪的后台任务启动 + **立即** arm 看门狗（`--heartbeat-min 30 --stall-min 25`） |
| 5 | L1-M4d 批次怎么记账 | **记「已执行 2/3、中止」**（用户 2026-10-17 14:29 裁定停止；run 3 未产出结果文件） | 已在 `docs/127` §6 落账；本批收口时并入 `docs/146` §5 |
| 6 | 是否顺带修读侧放行（PL-M11 KI 1）等未修项 | **不做**，维持登记 | 与 N-6 不同源；混批会让归因变糊 |
| 7 | 探针脚本是否入库 | **入库**，落 `packages/eval/scripts/` | 见 §4 裁定 7：10-09 的探针放在 scratch，今天已找不到 |

## 8. 本批已发生的事实（供记账，非判据）

- **L1-M4d 批次**：脚本 `packages/eval/scripts/l1-m4d-e1-x3.sh`（本批新增），结果目录 `packages/eval/results/l1-m4d`。三次运行共耗 **26.8M 输入 token**（run 1 = 24.98M / run 2 = 1.79M / run 3 ≈ 0.04M）。停批时配额 **113,409,420 / 200,000,000**（窗口 10-11 23:00 UTC 起，**10-18 23:00 UTC 刷新**）。
  > **【勘误 2026-10-17 16:20，正本 `docs/173` §3】** 本行数字**已被取代**：实测 run 1 = **15,661,690**（原值把**批前单跑** `876616fb` 的 9,322,557 误并了进来）、run 2 = **1,790,090**、run 3 = **7,607,635**，合计 **25,059,415**（非 26.8M）。原「run 3 ≈ 0.04M」只取了停批那一刻的首行 39,934——**用户 14:29 裁定停止后批次并未停止**，工作流 `1e436a66` 继续跑到 **06:55:47** 才 FAILED，另耗 7.61M。
- **本批是同一周窗口内的第二个 E1×3 批次**——用户 2026-10-17 明确授权（默认纪律为「一周最多一个」，`docs/127` §8）。
- **受控实例已按前置要求重启**：旧实例 pid 46431（01:05 启动）早于 `packages/shared` / `packages/agent-core` 的 `dist` 重建（10-17 **08:35**），实查确认后停掉；新实例 **pid 40906，12:00:30 启动**，载有 PL-M11 / PL-M12 代码。
- **计划形状**：`requirement_slices` 显示 3 个切片——`foundation-auth`（15 任务）→ `task-crud`（22 任务）→ **`ui-deploy-docs`（「首页 UI、容器化部署与工程文档」，从未执行）**。三次运行都没跑到第三个切片。
- **PL-M10 / PL-M9 在本批被跑通**（根 `package.json` 写入成功；`TASK_CHECK_UNAVAILABLE ×2`，DATABASE）；**PL-M11 / PL-M12 一次未被检验**。
- **停批后库内孤儿行**：工作流 `1e436a66`（run 3）留在 `RUNNING`（1 RUNNING / 1 SUCCESS / 13 PENDING）；另有累积的 `READY` 孤儿任务与 1 条 `WAITING_APPROVAL` 工作流（`57f98bf9…`，2026-10-14）。**已登记，未清理**。
- **一处自查更正**：我在向用户口头汇报时曾称这两种 400「历史上从未出现过」。**这是错的**——我把 SQL 输出的列读错了。准确计数见 §2.3：`reasoning_content` 在 10-07 / 10-09 / 10-14 均有记录；**只有 `tool message content` 是今天首次出现**。结论方向不变，但依据以本节为准。
