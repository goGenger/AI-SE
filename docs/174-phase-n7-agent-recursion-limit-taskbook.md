# 174 · N-7「外层 AgentGraph 撞 LangGraph 默认递归上限」修复任务书（PL-M14）

> 状态：**已实施并收尾**（2026-10-17）。用户裁定「**都按你的建议，开工 PL-M14**」——即 §7 七项待裁定全部按推荐值接受。**实施记录 `docs/175`**（含 §2 三处补充、以及 §4 裁定 3 的余量由 `+2` 落到 `+4` 的实测依据）。**§0 第 3 项有一处算术勘误**（「判定已锁死」是错的），见该项内的勘误块。
> 编号：里程碑 **PL-M14**；缺陷登记号 **N-7**（接 N-1…N-6 之后）。
> 依据：**L1-M4e run 1 实测**（`packages/eval/results/l1-m4e/`，工作流 `a6914b77-f9ae-4ee7-a907-ba971851611c`）、代码实查（`AgentGraph.ts` / `AgentRunner.ts` / `ProfessionalAgent.ts` / `workflowTaskExecutor.ts`）、**依赖实查**（`@langchain/langgraph@1.4.14` / `deepagents@1.13.3` / `langchain@1.5.10`）、`docs/173`（PL-M13 收尾记录）。
> 性质：**修的是缺陷**，不是新增能力；**不新造验收编号**。

> **〔勘误 2026-10-17，PL-M16 / `docs/180`〕** 本任务书把 N-7 当作**独立缺陷**（「外层 `AgentGraph` 撞 LangGraph 默认递归上限 25」）。实测更正：**那是同一个空转被框架的 25 超步提前掐断的形态**，不是独立缺陷。链路——PL-M13 为修 N-6 而保留 `additional_kwargs`，其中 `tool_calls` 让外层在 `submit_result` 被接受后**每轮重复请求同一个工具调用**，而内层每轮又被终止中间件直接 `jumpTo end`（**零模型调用**）⇒ 空转。**不传 `recursionLimit` 时**该空转在 ~13 轮撞 `Recursion limit of 25`（探针 `scripts/probe-outer-loop-spin.ts` 场景 C，实测 13 轮、13/13 轮请求 `submit_result`、12/13 轮零模型调用）；**传了之后**就在 50 轮撞平台守卫。**PL-M14 的修复本身仍然正确且必要**（让平台自己的守卫成为生效的那一个，`docs/175` 的判据不变），但 **N-7 与 N-9 不是两个缺陷**——N-9 由 PL-M16 修复后，探针场景 C 的 `Recursion limit of 25` **一并消失**。**本任务书正文按历史记录保留不改**（`docs/146` §6 规则 7）。

## 0. 为什么现在做这一批

1. **它是 N-6 修好之后第一个露头的缺陷，而且一直被 N-6 遮着。** L1-M4e run 1 只跑了 **9 分钟**、**80,565** 输入 token 就死在 `S1-01`——**第一个任务**。工作流 FAILED，其余 10 个任务停在 PENDING（`S1 ok=0 bad=1 run=0 pend=10/11`）。
2. **不修它，再开任何 E1×3 都会在第一个需要读文件的任务上以同样方式死掉。** 本批三个 agent run（一次任务 + 两次重试）**全部**是这条错误，跨重试不复现改善。
3. **〔勘误 2026-10-17 17:2x〕本项原文写「L1-8 判定已锁死（run 1 = staging 段「否」→ 最多 1/3 < 2/3）」——这个算术是错的。** 判据是「staging 段 **≥ 2/3**」（`docs/154:104`），run 1 = 否 时 runs 2/3 全过仍为 **2/3，达标**；判定当时**并未锁死**。**停批的正确理由是缺陷的确定性**（同一任务 3/3 次尝试同形撞限），按「先修缺陷再跑批次」纪律停——结论不变，依据更正。该错误源自 L1-M4c / L1-M4d 的正确推理（那两批 run 1 **与** run 2 皆「否」⇒ 最多 1/3）被错误地套到了只有 run 1 失败的 L1-M4e 上。
4. **它把 PL-M13 的效果验证挡在了后面。** PL-M13 修的是「平台重建 `AIMessage` 时丢 `additional_kwargs`」与「tool content 非字符串」，本批**两类 400 均为 0 条**（§2.5）——修复未被证伪，但因为链在第一个任务就断，**修好的那两条路径没被真正走完**。

## 1. 范围

| # | 条目 | 判定 |
| --- | --- | --- |
| 1 | **PL-M14**：让外层 `AgentGraph` 的步数上限**由平台自己决定**，不再受 LangGraph 默认值支配 | **真缺陷**（协议面／框架配置面） |
| 2 | **PL-M14**：以内层 deep agent 是否同样暴露在默认上限下为**观察面**，先诊断后处置 | 诊断面 |
| 3 | **PL-M14**：以**定向探针 + 单个真实任务回放**验证，不跑完整 E1×3 | 方法面（见 §5） |

**明确排除**（本批不动）：

| # | 条目 | 排除理由 |
| --- | --- | --- |
| 4 | 调整 `maxIterations` 的**取值**（50 → 别的数） | `maxIterations` 是**迭代**上限，语义正确；缺陷在**超步上限**没跟它对齐。调小它等于把守卫迁就框架默认值（§4 方案 A） |
| 5 | 升级 / 更换 `@langchain/langgraph` | 与 N-6 同因：现版本是**已打补丁并被真实栈验证过**的（`patches/@langchain__openai@1.5.11.patch` 虽属 `@langchain/openai`，但 `langgraph` 与 `core` 同属一条链）；且升级会牵动 `deepagents` / `langchain` 的 peer 约束 |
| 6 | 给**内层** deep agent 也设上限 | 内层当前未观测到撞限（§2.6）。改了会扩大改动面且无法用真实批次验证 |
| 7 | 启用网关的 `thinking:{type:"disabled"}` | `docs/129` §事故 2 已明确未采用——会改变与全部历史批次的可比语义 |
| 8 | 读侧放行（PL-M11 KI 1）、根级源码文件、`scripts/`、`test/` | 均维持既有登记（`docs/171` Known Issues 1–4） |
| 9 | N-1b / N-1c / N-3 / 7b / `CHECK_CANDIDATES` | 均维持既有登记 |
| 10 | 清理库内孤儿行（`READY` 任务、`WAITING_APPROVAL` 工作流 `57f98bf9`） | 独立议题，需另行裁定（`docs/127` §6 已登记） |
| 11 | 启动器静默复用陈旧实例（`docs/169` KI 8） | 属相邻工作；**但它是每批开工前的手工前置动作**，见 §6 |

## 2. 基线事实（代码、依赖、库三方实查，2026-10-17）

### 2.1 错误原文（`agent_runs.error`，逐字）

```
{"code": "UNKNOWN_ERROR", "message": "Recursion limit of 25 reached without hitting a stop condition.
 You can increase the limit by setting the \"recursionLimit\" config key.\n\n
 Troubleshooting URL: https://docs.langchain.com/oss/javascript/langgraph/GRAPH_RECURSION_LIMIT/\n"}
```

**3 条**，全部属于任务 `S1-01`（DESIGN，「设计仓库布局与脚本契约映射」），时间 08:25:19 / 08:26:47 / 08:28:10（UTC）。

### 2.2 全库分布：**今天首次出现，此前 14 天全为 0**

| 日期 | `Recursion limit` | 当日 agent_run 总数 |
| --- | --- | --- |
| 2026-09-28 … 2026-10-16（共 14 天） | **0** | 3,234 |
| **2026-10-17** | **3** | 64 |

### 2.3 定层：撞的是**外层** `AgentGraph`，不是内层 deep agent

| # | 事实 | 出处（实查） |
| --- | --- | --- |
| 1 | `recursionLimit` 在平台 `src/` 与 `dist/` 中**一次都不出现** | 全树 grep（`packages/*/src`、`apps/*/src`、`packages/*/dist`、`apps/*/dist`） |
| 2 | 外层图是**两节点环**：`START → agent → (conditional) → tools → agent → …` | `AgentGraph.ts:397-403` |
| 3 | `AgentGraph` 编译：`.compile({ checkpointer: new MemorySaver() })`——**不带上限** | `AgentGraph.ts:403` |
| 4 | `AgentRunner` 调用：`graph.invoke(state, { configurable: { thread_id } })`——**不带 `recursionLimit`** | `AgentRunner.ts:158-160` |
| 5 | `@langchain/langgraph@1.4.14`：`DEFAULT_RECURSION_LIMIT = 25` | `dist/pregel/utils/config.js:36`（应用点 `:140`） |
| 6 | 抛错点是 **Pregel 循环自身**（`loop.status === "out_of_steps"`），不是任何节点 | `dist/pregel/index.js:1222-1226` |
| 7 | **`agentNode` 的 catch → `failureUpdate("LLM_ERROR", error)`** | `AgentGraph.ts:302` |
| 8 | **`AgentRunner` 的外层 catch → `normalizeRuntimeError(error, "UNKNOWN_ERROR")`** | `AgentRunner.ts:212-214` |
| 9 | **DB 里的码是 `UNKNOWN_ERROR`** | `agent_runs.error->>'code'`，3/3 条 |

**第 7/8/9 条合起来是决定性的**：若撞限的是内层 deep agent，异常会在 `DeepAgentLLMProvider.invoke` 内抛出 → 经 `invokeLLMWithRetry` 重抛 → 被 `agentNode` 的 catch 接住 → 码为 **`LLM_ERROR`**。实测为 **`UNKNOWN_ERROR`**，说明异常**逃出了节点**，由 Pregel 循环抛出后一路穿到 `AgentRunner` 的外层 catch。**⇒ 外层图。**

### 2.4 机制：平台的 `maxIterations` 守卫**够不到**

外层图每循环一次 = **2 个超步**（`agent` + `tools`）。25 超步 ⇒ **约 12 次循环**。

而平台自己的守卫在 `AgentGraph.ts:229`：

```ts
if (state.iteration >= options.maxIterations) {
  return { status: "failed", error: { code: "TOOL_ERROR",
    message: "Agent reached max iterations", details: { maxIterations: options.maxIterations } } };
}
```

`maxIterations` 的实际取值（实查）：

| 位置 | 值 |
| --- | --- |
| `ProfessionalAgent.ts:475` | `defaultMaxIterations: 50` |
| `workflowTaskExecutor.ts:217` / `:302` | `maxIterations: 50` |
| `AgentRunner.ts:91` | 兜底 `?? 12` |

**⇒ 在 50 这条路径上，平台打算跑 50 轮，实际约 12 轮就被框架掐断，且报的是框架的 `UNKNOWN_ERROR` 而不是平台的 `TOOL_ERROR`。**「12」这个兜底值**恰好接近**真实上限，所以问题长期没暴露；「50」这个值**是虚的**。

### 2.5 为什么今天才出现：**被 N-6 遮蔽**

`S1-01` 在失败前调用了 **9 次 `read_file`**（同任务工具调用全量：`read_file` 9 / `submit_result` 6 / `list_directory` 5 / `git_status` 4）。

`read_file` **正是 N-6 错误 ② 的那个工具**——`deepagents` 的 `read_file` 返回 `[{type:"text", …}]`，`@langchain/core` 把它原样放进 `ToolMessage.content`，`@langchain/openai` 转换器原样发出 → 网关 400 `tool message content must be a string on the gRPC path`。

**修 N-6 之前，读文件的任务先死在 400 上，根本走不到第 25 个超步。** PL-M13 把这条路修通之后，agent 能真的读文件并继续推进——于是第一次够到了框架默认上限。**N-7 不是 N-6 造成的，是被 N-6 掩盖的。**

**本批 N-6 两类 400 均为 0 条**（08:20 UTC 之后 `agent_runs`：`reasoning_content` 0、`tool message content` 0）。**PL-M13 未被证伪**——但注意本跑只 9 分钟，**那两条路径没有被真正走完**，这不是一次有效的效果验证。

### 2.6 内层 deep agent 的同类风险（**观察面，未观测到撞限**）

`deepagents@1.13.3` 与 `langchain@1.5.10` 的 `createAgent` **都不设 `recursionLimit`**（全 dist grep，只命中文档注释）。`DeepAgentLLMProvider.invoke` 调用 `agent.invoke(messages, { signal, configurable: { thread_id } })` 同样不传。

**⇒ 内层理论上也跑在默认 25 下。** 但本批与历史批次**均未观测到内层撞限**（若撞了，码会是 `LLM_ERROR`，全历史 0 条）。**本批不改内层，只登记**（§7 第 4 项）。

### 2.7 影响面

- **所有 `maxIterations > ~12` 的 agent 运行**——即 `ProfessionalAgent`（50）与 `workflowTaskExecutor`（50）这两条**生产路径**。
- **E1 夹具**：第一个需要读文件的 DESIGN 任务即死。**其余八个夹具**同源，同样受影响。
- **生产路径**：任何经 `AgentRunner` 的 agent 运行都受影响，且**只在其任务需要读文件时**才暴露——这正是它长期隐身的原因。

## 3. 判据

| 判据 | 期望 |
| --- | --- |
| 14a：外层 `AgentGraph` 的**超步上限由平台自己决定**（与 `maxIterations` 对齐），不再受 LangGraph 默认值支配 | 新增。**前提是先由 14b 探针指认**——不许「先把 `recursionLimit` 调大就当修好」 |
| 14b：**探针证明**——脚本化 provider 持续返回 `tool_calls`，在 `maxIterations = 50` 下能**跑到第 50 轮**并得到平台的 `TOOL_ERROR: Agent reached max iterations`（**而不是** `UNKNOWN_ERROR: Recursion limit of 25`） | 新增。这是 14a 的**证据**，不是可选 |
| 14c：`recursionLimit` 与 `maxIterations` 的换算关系有**单一出处**（不在两处各写一遍——`docs/160` 的缺陷成因类型） | 新增 |
| 14d：**不引入语义漂移**——不改任何既有迭代语义、事件类型、状态码、生命周期回调时机 | 保持 |
| 14e：既有断言**逐字不变**（`AgentGraph` / `AgentRunner` 的现有测试全绿） | 保持。本批**不得**顺带改动写范围、提示词或计划逻辑 |
| 14f：**真实批次里 N-7 零出现**，且链能越过 `S1-01` 推进到至少切片 2 | 新增（本批的验收载体，见 §5） |

## 4. 设计裁定（本任务书的推荐值）

| # | 事项 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | 修法形态 | **先探针定位（14b），再定点修**；不预设改动面 | §2.3 的定层是**静态推断**（码是 `UNKNOWN_ERROR` ⇒ 外层）。探针要把「跑到第 50 轮」变成实测，并顺带测出**每次循环实际消耗几个超步**——换算式的余量靠它定 |
| 2 | 修复落点 | **`AgentRunner` 里、解析出 `maxIterations` 的同一处**，把 `recursionLimit` 一并算出来传进 `graph.invoke` | §14c：`maxIterations` 的唯一出处就是 `AgentRunner.ts:91`；换算放在同一行旁边，才叫「单一出处」。放在 `createAgentGraph` 里会变成第二处 |
| 3 | 换算式的形状 | `recursionLimit = maxIterations * 2 + 2`（**余量待探针实测后定，可能是 +4**） | 每循环 2 超步是**下界**（`agent` + `tools`）；`+2` 覆盖 `START` 与终态写入。**注意 `state.iteration` 由内层 `agentIterations` 驱动**（`AgentGraph.ts:155-160` 的 `responseIteration`），可能一次跳多格——所以这是**上界式**，宁可宽不可窄 |
| 4 | 是否给内层也设 | **不设**，只登记为观察项 | §2.6：内层撞限从未被观测到（码会是 `LLM_ERROR`，全历史 0 条）。改了无法用真实批次验证，且扩大改动面 |
| 5 | `maxIterations` 的取值 | **不动** | 它是**迭代**上限、语义正确；缺陷是超步上限没跟它对齐。调小它是把守卫迁就框架默认值 |
| 6 | 是否顺带改 `packages/eval` 夹具 / oracle / `EvalPolicy` / L1-8 判据 | **不做** | 红线（`docs/166` §6） |
| 7 | 探针是否入库 | **是**，落 `packages/agent-core/scripts/`（与 N-6 探针同处） | `packages/eval` 不依赖 `@ai-se/agent-core` / `@langchain/*`，裸导入解析不到（`docs/173` 已记该偏离）；`packages/agent-core/scripts/` 有先例 |

**被否掉的方案（记录，避免重复推演）**：

| 方案 | 否决理由 |
| --- | --- |
| **A｜把 `maxIterations` 调小到 ~12，让两者「一致」** | 掩盖症状。50 是有意设置的（生产路径两处都是 50）；把守卫迁就框架默认值等于承认框架的默认值是设计上限——它不是 |
| **B｜只把 `recursionLimit` 设成一个很大的数（如 10000）** | 去掉的正是**唯一的真实上限**：`state.iteration >= maxIterations` 这条守卫依赖内层 `agentIterations` 推进，而它**可能停滞**（`Math.max(fallback, value)`，若内层恒报小值则靠 fallback 每次 +1）。设很大 = 让一个停滞的任务跑到超时为止 |
| **C｜给内层 deep agent 也设上限** | §2.6：内层从未撞限。这是**没有观测证据的预防性改动**，且无法用真实批次验证 |
| **D｜升级 / 更换 `@langchain/langgraph`** | 与 N-6 方案 B 同因：现版本是被真实栈验证过的；升级牵动 `deepagents` / `langchain` 的 peer 约束，且默认值**未必**变得更合适 |
| **E｜改 `AgentGraph` 结构，把 `agent` / `tools` 并成一个节点** | 超步数减半能绕过 25，但会改动图语义、事件时机与检查点形状——远超本缺陷所需 |
| **F｜把 `GraphRecursionError` 当可重试错误吞掉** | 掩盖症状。且重试已经在发生（本批 3 次全失败），框架上限是**确定性**的，重试不会自愈 |
| **G｜直接重跑批次看是否自愈** | 与记忆 `fix-known-defects-before-batches` 相悖：验收批次是**验证修复**的，不是发现缺陷的。且本批 3/3 次同一错误，**不自愈** |

## 5. 验证分层

| 层 | 位置（`AGENTS.md` §6 / §7） |
| --- | --- |
| **第 1 层：探针定位（先做，决定换算式的余量）** | 新建 `packages/agent-core/scripts/probe-agent-recursion-limit.ts`。用 `createAgentGraph` + 脚本化 `LLMProvider`（**永远返回带 `tool_calls` 的 `AIMessage`**，即永不收敛），在 `maxIterations = 50` 下调用，断言：**修前**抛 `GraphRecursionError: Recursion limit of 25`；**修后**跑到第 50 轮并返回 `TOOL_ERROR: Agent reached max iterations`。顺带**实测每次循环消耗的超步数**，据此定余量。**离线、可复现、零配额、不需要 Docker** |
| 第 2 层：单测 | `agent-core`：`AgentRunner` 把 `maxIterations` 换算成 `recursionLimit` 的断言（含兜底值 12 的路径）。**先写会失败的用例**，再改 |
| 第 3 层：回归 | 既有 `AgentGraph` / `AgentRunner` / `Agent` 测试全绿；`agent-core` 全量 |
| 第 4 层：真实栈回放 | 单个真实任务（非完整 E1×3）经 `:47558` 实例跑通，**N-7 零出现**且链越过 `S1-01` |
| 共享夹具核对 | 全树 grep 依赖 `maxIterations` / 迭代计数 / `TOOL_ERROR` 的精确断言（`AGENTS.md` §7） |
| 门禁 | 受影响包 `typecheck && lint && test`；收尾前全仓 `corepack pnpm -r run typecheck && lint && test` |
| A/B 实测（强制） | `docs/165` §2 偏差 1 的教训：改 agent 层后**必须先跑** `apps/server` 的 agent 相关 e2e 做改前基线对比 |

## 6. 边界与红线

- **不新增第二套 Permission / Approval / Audit / 错误码体系**（`AGENTS.md` §10）。**`TOOL_ERROR` 与 `UNKNOWN_ERROR` 都是既有码**，本批只改「哪一个该出现」。
- **不改 `packages/eval` 的夹具与 oracle**；**不改 `EvalPolicy`**；**不改 L1-8 判据口径**。
- **不改写范围**（PL-M5 / PL-M10 / PL-M11 的语义与断言逐字不变）。
- **不改 `maxIterations` 的取值与语义**。
- **不启用 `thinking:{type:"disabled"}`**。
- 不修改历史 `tasks` / `agent_runs` / `workflow_events` 行。
- 不修改任何 `dist/`（除各包正常的 `build` 产物）。
- **本批不跑 E1×3 批次**；下一批何时开、以什么形态开，见 §7 第 5 项。
- 收口时同步登记账：`docs/146` §3（**新增 N-7 行**）、§4（本任务书 §7 的裁定行）、§5（批次记录）、`docs/127` §5/§6。

## 7. 待裁定项（每条带推荐值）

| # | 事项 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | 修法形态 | **先探针定位，再定点修**；以「外层图的超步上限由平台自己决定」为不变量 | 见 §4 裁定 1。定层是静态推断，须由探针转成实测；余量也要实测 |
| 2 | 换算式的形状与余量 | `recursionLimit = maxIterations * 2 + 2`，**余量以探针实测的超步消耗为准**（可能落到 `+4`） | 见 §4 裁定 3。宁可宽不可窄——窄了会退化成「换个数字的同一个缺陷」 |
| 3 | 是否给内层 deep agent 也设上限 | **不设**，登记为观察项 | 见 §4 裁定 4 / §2.6：无观测证据，且无法用真实批次验证 |
| 4 | 内层 25 的风险如何处置 | **立观察项**：若修完外层后真实批次出现 `LLM_ERROR` 形态的撞限，再单独立项 | 与 N-6 §7 第 3 项同一口径：**必须留下证据**，不许「查不出就当没有」 |
| 5 | 修完之后下一批怎么开 | **另开一批 E1×3**（新结果目录），**不续跑 L1-M4e** | 与 `docs/164` §7 第 4 项 / `docs/170` §7 第 8 项 / `docs/172` §7 第 4 项同一口径：避免修前/修后混批。**开工前三件事不变**：① 确认周配额余量；② 先停掉 `:47558` 上的陈旧实例再重启（`l1-m4-server-launch.sh` 只要端口有应答就**静默复用**）；③ harness 追踪的后台任务启动 + **立即** arm 看门狗（`--heartbeat-min 30 --stall-min 25`） |
| 6 | L1-M4e 批次怎么记账 | **记「已执行 1/3、因发现确定性缺陷中止」**（用户 2026-10-17 裁定停批；run 1 已产出结果文件，runs 2/3 未跑） | 与 PL-M4 / L1-M4b / L1-M4c / L1-M4d 同一口径 |
| 7 | 探针脚本是否入库 | **入库**，落 `packages/agent-core/scripts/` | 见 §4 裁定 7；N-6 探针已验证该位置可用 |

## 8. 本批已发生的事实（供记账，非判据）

- **L1-M4e 批次**：脚本 `packages/eval/scripts/l1-m4e-e1-x3.sh`（本批新增），停机脚本 `packages/eval/scripts/l1-m4e-stop.sh`（本批新增），结果目录 `packages/eval/results/l1-m4e`。**run 1 于 16:20:30 启动、16:29:51 结束**（239,541 ms），耗 **80,565 输入 / 14,293 输出 token**（估算成本 $0）。**runs 2/3 未执行**（用户裁定停批）。
- **停机脚本是本次新补的**：L1-M4d 停批时只杀了 harness，服务端工作流继续跑了 27 分钟、另耗 7.61M（`docs/173` §3 勘误）。本批停批时 `l1-m4e-stop.sh` 实查**服务端无 `RUNNING`/`PENDING` 工作流**——这次没有泄漏。
- **开批配额代理值 120,977,121 / 200,000,000**（窗口 10-11 23:00 UTC 起，**10-18 23:00 UTC 刷新**）。
- **受控实例**：旧 pid 40906（12:00:30 启动，早于 `dist` 重建 14:55）已停；新 **pid 11525，16:19 启动**，`health=200`，载有 PL-M13 代码与扩展后的 `@langchain/openai` 补丁。
- **run 1 的形状**：计划 **v60**、**6 个切片**，S1 有 **11 个任务**（`S1-01`…`S1-11`）。工作流 `a6914b77` FAILED（`S1 ok=0 bad=1 run=0 pend=10/11`）。oracle **Must 0/29**。切片到达分布 `S1×1`。自报=失败 / oracle=不通过 / 假阳性=否 / 链完成=否 / staging 段=否（`-/-/-`）/ 超范围写入 0 / 任务级验证分歧 0 / 验证门失败码（无）/ 检查不可判定 0。规划修复：自动 4 轮 / LLM 1 轮 / 首轮通过率 0.0% / 收敛率 100.0%。**人工介入 1**（切片计划审批 `edad5f85`，16:21:42 自动 APPROVED）。
- **本批的观察项读数**：**N-6 两类 400 均为 0 条**（`reasoning_content` 0、`tool message content` 0）——PL-M13 未被证伪，但本跑仅 9 分钟，**那两条路径未被走完**。`scopeViolations` 0（PL-M12 未被证伪）。**PL-M11 / PL-M12 仍然一次未被检验**（链在第一个任务就断，从未接近交付切片 `ui-deploy-docs`）。
- **一处如实标注**：本批**没有**产出任何关于 PL-M11 / PL-M12 / PL-M13 的**有效效果验证**。三个修复至今都只经过了单元测试与离线探针，**没有一个经过真实链路的完整检验**。
