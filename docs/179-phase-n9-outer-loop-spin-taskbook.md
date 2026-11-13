# 179 · N-9「外层循环在 `submit_result` 后空转到守卫」修复任务书（PL-M16）

> 状态：**已裁定并已实施**（2026-10-17）。用户裁定「**都按你的建议，开工 PL-M16**」——§7 八项**全部按推荐值接受**。**实施结果正本见 `docs/180`**。判据 **16a–16g 与 16i 达成**；**16h（真实批次里空转零出现）延期**至下一批 E1×3。
> 编号：里程碑 **PL-M16**；缺陷登记号 **N-9**（接 N-1…N-8 之后）。
> 依据：**L1-M4g run 1 实测**（`packages/eval/results/l1-m4g/`，工作流 `de90fdb0`）、dev 库全量实查（`workflow_events` / `agent_runs` / `tool_calls` 全历史）、代码实查（`DeepAgentLLMProvider.ts` / `AgentGraph.ts` / `submitResult.ts` / `AgentRunner.ts`）、`docs/175`（PL-M14 收尾记录）、`docs/178`（PL-M15 收尾记录）。
> 性质：**修的是缺陷**，不是新增能力；**不新造验收编号**。

## 0. 为什么现在做这一批

1. **它现在是 L1-8 的唯一致败点。** L1-M4g run 1 死在**第一个切片、第一个任务**（`T-DESIGN-S1`），而该任务的 agent **在第 6 轮就已经成功提交了一份合格结果**（`outcome: SUCCESS`）。任务仍判 FAILED，因为 agent run 以 `TOOL_ERROR` 结束。
2. **它是确定性缺陷，且已连续三次同形出现**：L1-M4f run 1、L1-M4f run 2、L1-M4g run 1，全部死在第一个任务、全部 `iter=50` + `Agent reached max iterations`。**确定性意味着再跑多少次都一样**——不修就无法推进 L1-8。
3. **它是一处回归**：2026-10-17 08:25 之前，**每一个** agent run 都在 **1–2 个外层轮**内正常结束；之后 **100% 空转**（见 §2.4）。回归点在 PL-M13 落地时刻附近。
4. **它同时解释了 N-7 的真实成因。** PL-M14 当时被记为「外层图撞 LangGraph 默认上限」的独立缺陷；实测显示那是**同一个空转**被框架的 25 超步提前掐断的形态。PL-M14 移走了提前掐断，空转于是跑到平台守卫。**⇒ N-7 与 N-9 很可能是同一个缺陷的两个阶段**（§2.4，登记为待验证假设）。
5. **它污染记账**：空转的 44 轮里**没有任何模型调用**（见 §2.3），但每轮都写 `agent_action` / `tool_call_started` / `tool_call_finished` 事件，把 `current_iteration` 推到 50。任何按迭代数或事件数判断「agent 干了多少活」的口径都被它污染。

## 1. 范围

| # | 条目 | 判定 |
| --- | --- | --- |
| 1 | **PL-M16**：查明外层循环**为什么**在 `submit_result` 之后继续 | **先探针定位，后定点修** |
| 2 | **PL-M16**：消除空转的根因 | **真缺陷**（控制流面） |
| 3 | **PL-M16**：以**定向探针**验证，不跑完整 E1×3 | 方法面（见 §5） |
| 4 | **PL-M16**：确认 N-7 / PL-M14 的定性是否需要更正 | 记账面（见 §2.4） |

**明确排除**（本批不动）：

| # | 条目 | 排除理由 |
| --- | --- | --- |
| 5 | **`T-DESIGN-S1` 的设计质量 / 计划粒度 / 提示词** | 那是「设计任务该产出什么」的问题，与空转无关。本批只修**控制流** |
| 6 | **`maxIterations`（50）与 `recursionLimitFor` 的取值** | PL-M14 的成果，且**改了就是「换个数字的同一个缺陷」**。空转修好后它们自然不再被触发 |
| 7 | **改任何历史 `tasks` / `agent_runs` / `workflow_events` 行** | `AGENTS.md` §6 红线。11 条 N-8 坏值同样原样保留 |
| 8 | **N-8 / PL-M15 的任何再改动** | 已收尾（`docs/178`）。本批**不得**动 `innerProducedAIMessages` |
| 9 | **`reasoning_content` 的回传（N-6 / PL-M13）** | **必须保住**——见 §6 红线。本批若需动 `additional_kwargs`，**不得**让 N-6 复发 |
| 10 | 读侧放行（PL-M11 KI 1）、根级源码文件、`scripts/`、`test/` | 均维持既有登记（`docs/171` Known Issues 1–4） |
| 11 | N-1b / N-1c / N-3 / 7b / `CHECK_CANDIDATES` / 库内孤儿行 | 均维持既有登记 |
| 12 | **`docs/178` Known Issue 1**（探针里「2 次调用只留 1 条带用量的 AIMessage」） | 已在 L1-M4g run 1 上被实测**证伪**（守卫增量与三 run 之和逐位相等，`docs/178` 已记），无需再查 |

## 2. 基线事实（L1-M4g run 1 实测 + 库全量实查，2026-10-17）

### 2.1 失败形状

工作流 `de90fdb0`（`[eval] E1`），14:51:24 → 14:56:54 UTC（**297.9 s**），**FAILED**：

| 项 | 值 |
| --- | --- |
| 任务状态 | `FAILED×1` + `PENDING×10` |
| 切片到达 | **S1×1**（死在第一个切片） |
| 自报 / oracle / 假阳性 | 失败 / 不通过 / 否 |
| 链完成 / 交付 / **staging 段** | 否 / 否 / **否（`-/-/-`）** |
| 人工介入 | 1（切片计划审批，自动 APPROVED） |
| token | 输入 **6,703,146** / 输出 1,437,707 |

**失败任务**：`T-DESIGN-S1`（`DESIGN`，由 `planner-agent` 执行），`retry_count = 2`（**3 次尝试**）。

### 2.2 任务**自报成功**，却判 FAILED

该任务的 `output`：

```
{"outcome": "SUCCESS",
 "summary": "S1 design specification delivered (engineering structure, route dispatch,
             container run contract). No business code written. The workspace is read-only
             for this agent, so the design is returned inline as a DOCUMENTATION artifact...",
 "issues": [{"file": "docs/design/S1-skeleton.md", "severity": "LOW",
             "description": "The workspace is read-only for this agent, so the S1 design could not
                             be persisted... and is instead delivered inline...",
             "recommendation": "A write-capable downstream task should persist this design verbatim..."}]}
```

⇒ **agent 交付了一份合格结果，只留一条 LOW 的「工作区只读」说明。任务仍判 FAILED**——因为 agent run 以 `TOOL_ERROR` 结束。**这与 L1-M4f run 2 的 `T-01` 同形**（`docs/176` §2.6 已登记，当时被 PL-M15 明确排除）。

### 2.3 机制：**44 轮里没有一次模型调用**

`b2171888`（尝试 1）的 `tool_calls` 序列：

```
iteration : 1 git_status | 2 list_directory | 3 read_file | 4 read_file | 5 read_file
            | 6 submit_result (succeeded) | 50 submit_result (succeeded)
```

`workflow_events` 给出的外层逐轮记录：

```
14:51:25.03  agent_run_started
14:51:28.49  tool_call_started  1        <- 真实工作
14:53:57.99  tool_call_finished 6
14:53:58.00  agent_action 7   tool_call_requested ["submit_result"]
14:53:58.01  tool_call_started  7 / tool_call_finished 7
14:53:58.03  agent_action 8   tool_call_requested ["submit_result"]
14:53:58.04  tool_call_started  8 / tool_call_finished 8
   ... 一路到 ...
14:53:59.15  tool_call_started 50 / tool_call_finished 50
14:53:59.19  agent_run_finished  code=TOOL_ERROR
14:53:59.20  TASK_FAILED         code=TOOL_ERROR
```

**第 7 轮到第 50 轮共 44 轮，全部落在 `14:53:58.00 → 14:53:59.21` 这 1.2 秒内**——**每轮没有任何模型调用**。

三次尝试的签名完全一致：

| agent run | 外层总轮数 | 其中请求 `submit_result` 的轮数 |
| --- | --- | --- |
| `b2171888` | 44 | **44（100%）** |
| `f7e39be7` | 44 | **44（100%）** |
| `5af85bb7` | 45 | **45（100%）** |

**链路**（逐处代码实查）：

1. 第 7 轮，内层 deep agent 调用 `submit_result`；`createSubmitResultTerminationMiddleware` 的 `beforeModel` 钩子在下一次模型调用前 `jumpTo: "end"`，内层循环结束（`submitResult.ts:78-97`）。
2. `DeepAgentLLMProvider.invoke` 重建返回消息时**原样带回 `additional_kwargs`**（`DeepAgentLLMProvider.ts:94`，**PL-M13 为修 N-6 而加**）。而内层最后一条 `AIMessage` 的 `additional_kwargs.tool_calls` 正是那次 `submit_result` 请求 —— `@langchain/core` 的 `AIMessage` 会把它解析成 `tool_calls`。
3. `AgentGraph.agentNode` 的 `getToolCalls(response)` 因此非空（`AgentGraph.ts:249`）⇒ `status = "running"`；`shouldContinue` 看到最后一条消息带 tool_calls ⇒ 返回 `"tools"`（`AgentGraph.ts:394`）。
4. `toolsNode` 再次执行 `submit_result`（纯回显工具，必然成功）。
5. 下一轮 `agentNode` 再调 `provider.invoke`。内层 `beforeModel` 看到最后一条是**被接受的 `submit_result` 工具结果** ⇒ **再次 `jumpTo end`，零模型调用**，`provider.invoke` 立即返回。而它交回的消息**仍然带着 `tool_calls: [submit_result]`**（`finalMessage(result)` 取到的是**调用方回灌进来的那条** `AIMessage`）。
6. **回到第 3 步。** 循环直到 `state.iteration >= 50`，平台守卫返回 `TOOL_ERROR`（`AgentGraph.ts:229-238`）。

⇒ **agent 早在第 7 轮就干完了；此后 44 轮纯粹是平台在自问自答。**

### 2.4 **回归时间线**（全库实查，`workflow_events`）

按「单个 agent run 的外层轮数」统计全历史：

| 时间窗 | agent run 数 | 空转数（轮数 ≥ 20 且全为 `submit_result`） | 最大外层轮数 |
| --- | --- | --- | --- |
| 09-28 → **10-17 05** | 各 1–2 | **0** | **1–2** |
| **10-17 08**（`a6914b77`，= **L1-M4e run 1**） | 3 | 0 | **~13** |
| **10-17 09**（`1c9739df` / `bc33a3c1`，= L1-M4f） | 7 | **7（100%）** | 43 / 138 |
| **10-17 10**（`3987886f` / `986ae8a6`，= 便宜档探针） | 4 | **4（100%）** | 130 / 154 |
| **10-17 14**（`de90fdb0`，= L1-M4g run 1） | 3 | **3（100%）** | 133 |

**⇒ 回归点在 2026-10-17 08:25 之前，与 PL-M13（N-6 修复）落地时刻吻合。** 10-17 08 那一档是**过渡态**：空转已经发生，但每 run 只跑到 ~13 轮——正好是 LangGraph 默认 25 超步（每轮 2 超步）掐断的位置，报出来的是框架的 `Recursion limit of 25`。

> **待验证假设（不得当作结论）**：**N-7 不是独立缺陷，而是同一个空转被框架提前掐断的形态。** PL-M13 引入了空转；PL-M14 把框架的提前掐断移走，空转于是跑到平台守卫（50），失败形态由 `UNKNOWN_ERROR` / `Recursion limit of 25` 变为 `TOOL_ERROR` / `Agent reached max iterations`。**支持证据**：① 10-17 05 之前零空转、每 run 1–2 轮；② 10-17 08（L1-M4e）每 run ~13 轮、全部 `submit_result`、被 25 超步掐断；③ 10-17 09 之后每 run 41–50 轮、全部 `submit_result`、被平台守卫掐断。**§5 第 1 层探针必须证实或证伪它**——若成立，`docs/174` / `docs/175` 关于 N-7 的定性需以追加块更正。

### 2.5 与 PL-M15 的边界（**本批不得混淆**）

L1-M4g run 1 同时给出了 PL-M15 的验收证据，两者**互不冲突**：

| 项 | 结果 |
| --- | --- |
| **N-8 坏值（`input_tokens > 10M`）** | **新增 0 条**（全库仍 11 条）——**PL-M15 成立** |
| 3 个 agent run 的 `input_tokens` | 2,364,736 / 2,516,360 / 1,822,050（正常量级） |
| 守卫增量 vs 三 run 之和 | **6,703,146 = 6,703,146**（逐位相等）⇒ `docs/178` KI 1 的「少算」观察**证伪** |
| N-7 / N-6 签名 | 0 / 0 / 0 |

⇒ **空转是 N-8 的「触发器」而不是「同源」**：正是空转把 `state.iteration` 推到 50、反复走守卫路径，才让 N-8 大量暴露。**修好 N-9 之后，守卫路径本身仍应保持可用**（它是唯一的花费控制），所以 N-9 的修复**不得**顺手削弱守卫。

### 2.6 影响面

- **L1-8**：`T-DESIGN-S1` 这类任务必然判 FAILED ⇒ staging 段永远到不了 ⇒ **L1-8 不可能达成**。
- **记账**：`current_iteration` 被空转推到 50；`workflow_events` 每 run 多出 ~44 组 `agent_action` / `tool_call_*`。任何按迭代数判断「agent 干了多少活」的口径失真。
- **成本**：空转本身**不花 token**（无模型调用），所以它**不是**成本问题——它是**判定**问题。这一点必须说清楚，免得被当成省钱任务。
- **`docs/176` §2.6 / `docs/146` §3**：`T-01` / `T-DESIGN-S1` 的「提交得太晚」这一表述**不准确**——实测是**提交得很早（第 6–7 轮），是平台此后不认账**。

## 3. 判据

| 判据 | 期望 |
| --- | --- |
| 16a：空转的**产生环被查明**（指出是哪一环、什么条件下产生，并有实测证据） | 新增。**未查明即不得宣称修复** |
| 16b：**探针证明**——用**真实栈**复现「内层提交成功后外层继续循环」，并逐轮打印外层看到的消息与 tool_calls；空转可复现 **或** 证明该环不产生空转（后者须给出证据并另立处置） | 新增。这是 16a 的**证据**，不是可选 |
| 16c：空转的**根因被消除**（任务在 agent 提交后**当轮结束**，不再空转） | 新增 |
| 16d：**N-6 不得复发**——`reasoning_content` 仍原样回传 | **红线**（见 §6） |
| 16e：**N-8 不得复发**——`innerProducedAIMessages` 的语义与断言不变 | **红线** |
| 16f：**不改 `maxIterations` 与 `recursionLimitFor` 的取值** | 保持 |
| 16g：既有断言**逐字不变** | 保持 |
| 16h：**真实批次里空转零出现**（`agent_action` 全为 `submit_result` 的 run 数 = 0），且 `T-DESIGN-S1` 这类任务**当轮结束** | 新增（本批的验收载体，见 §5） |
| 16i：**N-7 的定性被证实或证伪**，并据此在 `docs/174` / `docs/175` 以追加块更正 | 新增（§2.4 的假设） |

## 4. 设计裁定（本任务书的推荐值）

| # | 事项 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | 修法形态 | **先探针定位（16b），再定点修**；不预设改动面 | PL-M15 的教训：起草时的离线判断被实测推翻。§2.3 的链路是**读代码推出来的**，必须由探针在真实栈上坐实 |
| 2 | 探针手段 | **复用 PL-M15 的手法**：真实 `ChatOpenAI` + **录制型假网关** + 真实内层 `deepagents` agent + 真实 `ToolRuntimeBackend` + 真实 `DeepAgentLLMProvider` + 真实 `AgentRunner`（`packages/agent-core/scripts/probe-usage-compounding.ts` 已有骨架，**扩展成新场景**或新开一支） | 这是唯一能同时满足「真实内层 agent」与「零配额」的手段，且 PL-M15 已验证可用 |
| 3 | **候选修法（待探针确认后择一，不得预设）** | 优先考虑：**`DeepAgentLLMProvider.invoke` 交回的消息在「已捕获提交结果」时不得再带 `tool_calls`**——`captureSubmittedOutcome` 命中时，外层已无事可做，返回的消息应让 `shouldContinue` 走到 END | 这是 §2.3 链路里**唯一的平台侧可控点**；且它**不依赖**去猜 `@langchain/core` 的解析行为 |
| 4 | 是否用「清空 `additional_kwargs.tool_calls`」实现 | **不推荐单独使用**：`additional_kwargs` 是 N-6 的载体，整块丢弃会让 `reasoning_content` 一起丢。若确需动它，**必须**只剔除 `tool_calls` 键并保留其余键，且**必须**有新单测钉住 N-6 | 见 §6 红线。方案 G 的教训（`docs/176` §4）：「看起来相关其实无关」的改动不要做 |
| 5 | 守卫是否同批调整 | **不动**。空转不花 token，与守卫无关 | 守卫是唯一的花费控制（PL-M15 刚修好），本批不得顺手改 |
| 6 | 是否顺带修 `T-DESIGN-S1` 的设计产出质量 | **不做** | §1 第 5 项：不同源，混批会让归因变糊 |
| 7 | 探针是否入库 | **是**，落 `packages/agent-core/scripts/` | N-6 / N-7 / N-8 的先例 |

**被否掉的方案（记录，避免重复推演）**：

| 方案 | 否决理由 |
| --- | --- |
| **A｜把 `maxIterations` 调小** | 治标不治本：空转仍在，只是更早报错。且 `maxIterations` 是 PL-M14 的成果，改它就是「换个数字的同一个缺陷」 |
| **B｜外层图遇到 `submit_result` 就无条件 END** | 方向可能对，但**必须由探针确认**「何时算提交完成」——`captureSubmittedOutcome` 只认**被接受**的提交，外层 `shouldContinue` 现在看不到这个信息。先改后验会把「碰巧好了」当成「修好了」（N-6 / N-7 / N-8 三次都证明了这一点） |
| **C｜让 `submit_result` 不可被外层重复执行（幂等/一次性）** | 会在 Tool Runtime 层引入第二套语义（`AGENTS.md` §10 禁止第二套体系）；且治的是症状 |
| **D｜回到 PL-M13 之前（丢掉 `additional_kwargs`）** | 会让 **N-6 立刻复发**（网关 thinking 模式 400）。**红线** |
| **E｜升级 / 更换 `deepagents` / `langchain`** | 与 N-6 方案 B、N-7 方案 D 同因：现版本是被真实栈验证过的；且**尚未证明**空转来自这些库——§2.3 的链路指向平台自己的重建逻辑 |
| **F｜在 `AgentGraph` 里对 `submit_result` 特判** | 让图知道某个工具名，是把工具语义漏进图层；`AgentGraph` 目前只认「有没有 tool_calls」。若要做，应通过**已有的**终止语义（provider 交回的消息形状）表达，而不是在图里写工具名 |

## 5. 验证分层

| 层 | 位置（`AGENTS.md` §6 / §7） |
| --- | --- |
| **第 1 层：探针定位（先做，决定改动面）** | 扩展 `packages/agent-core/scripts/` 的探针：真实栈 + 录制型假网关，脚本化内层 agent 走「真实工作 → `submit_result` 被接受 → 内层终止」的路径，**逐轮落盘外层看到的 `response.tool_calls` / `additional_kwargs` / `result.messages`**。**必须同时证实或证伪 §2.4 的 N-7 假设**（可在探针里对比「带 `additional_kwargs` / 不带」两种 provider 行为）。**离线、可复现、零配额** |
| 第 2 层：单测 | `agent-core`：`DeepAgentLLMProvider.test.ts` 加「提交被接受后交回的消息不再带 tool_calls」用例（**先写会失败的用例，再改**）；**同时**保留并复核 N-6 的 `reasoning_content` 用例与 N-8 的 `innerProducedAIMessages` 用例 |
| 第 3 层：回归 | 既有 `DeepAgentLLMProvider` / `agentGraph` / `agentRunner` / `submitResult` 断言全绿；受影响包全量 |
| 第 4 层：真实批次回放 | 下一批 E1×3 里**空转零出现**，且链能**越过第一个任务** |
| 共享夹具核对 | 全树 grep 依赖 `tool_calls` / `additional_kwargs` / `outcomeMode` / `current_iteration` 的精确断言 |
| 门禁 | 受影响包 `typecheck && lint && test`；收尾前全仓 `corepack pnpm -r run typecheck && lint && test` |
| A/B 实测（强制） | `docs/165` §2 偏差 1 的教训：改控制流后**必须先跑** `apps/server` 的 agent 相关 e2e 做改前基线对比 |

## 6. 边界与红线

- **N-6 不得复发**：`additional_kwargs` 里 `reasoning_content` 的回传是 PL-M13 的成果，`docs/172` 的探针与 `DeepAgentLLMProvider.test.ts` 的既有用例都钉着它。**任何改动都必须让那些用例原样通过。**
- **N-8 不得复发**：`innerProducedAIMessages` 与 `packages/eval/src/usageGuard.ts` 本批**不得改动**。
- **不改 `maxIterations`（50）与 `recursionLimitFor`**（PL-M14 的成果）。
- **不改 `packages/eval` 的夹具与 oracle**；**不改 `EvalPolicy`**；**不改 L1-8 判据口径**。
- **不新增第二套 Permission / Approval / Audit / 错误码 / 终止语义体系**（`AGENTS.md` §10）。
- **不修改任何历史 `tasks` / `agent_runs` / `workflow_events` 行**（`AGENTS.md` §6）。
- 不修改任何 `dist/`（除各包正常的 `build` 产物）。
- **本批不跑 E1×3 批次**；下一批何时开、以什么形态开，见 §7 第 5 项。
- 收口时同步登记账：`docs/146` §3（N-9 行）、§4（本任务书 §7 的裁定行）、§5（本批记录）、`docs/127` §6。

## 7. 待裁定项（每条带推荐值）

| # | 事项 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | 修法形态 | **先探针定位，再定点修**；不预设改动面 | 见 §4 裁定 1 |
| 2 | 探针手段 | **真实栈 + 录制型假网关**，扩展 `scripts/probe-usage-compounding.ts` 的骨架 | 见 §4 裁定 2 |
| 3 | 候选修法 | **`captureSubmittedOutcome` 命中时，provider 交回的消息不再带 `tool_calls`**（让外层走到 END） | 见 §4 裁定 3。**但必须先由探针确认** |
| 4 | 若探针查明空转来自第三方库、平台侧无可修点 | **不阻塞**：立观察项 + 记录证据，并把「上游修好前的应对」落到**平台侧的消息形状**上（平台总能把交回的消息重建成不带 tool_calls 的形态） | 与 N-6 §7 第 3 项同一口径：**必须留下证据**，不许「查不出就当没有」 |
| 5 | 修完之后下一批怎么开 | **另开一批 E1×3**（新结果目录），**不续跑 L1-M4g** | 与 `docs/164` §7 第 4 项 / `docs/170` §7 第 8 项 / `docs/172` §7 第 4 项 / `docs/174` §7 第 5 项 / `docs/176` §7 第 5 项同一口径。**开工前三件事不变**：① 确认周配额余量；② 先停 `:47558` 上的陈旧实例再重启（`l1-m4-server-launch.sh` 只要端口有应答就**静默复用**）；③ harness 追踪的后台任务 + **立即** arm 看门狗，停机走 `*-stop.sh` 形态的脚本（**必须 cancel 服务端工作流**） |
| 6 | L1-M4g 批次怎么记账 | **记「已执行 1/3、因发现确定性缺陷中止」**（用户裁定停批） | 与 L1-M4b / L1-M4e 同一口径。**注意**：run 1 = 否**并不**锁死判定（run 1 否 + runs 2/3 是 = 2/3 = 达标），停批的理由是**空转是确定性的、run 2 必然同形失败**，不是算术锁死 |
| 7 | 是否更正 N-7 的定性 | **以追加块更正** `docs/174` / `docs/175`，**不改原正文**（历史记录冻结，勘误以追加块形式） | `docs/146` §6 规则 7。**更正的前提是 §5 第 1 层探针证实 §2.4 的假设** |
| 8 | 探针脚本是否入库 | **入库**，落 `packages/agent-core/scripts/` | 见 §4 裁定 7 |

> **〔2026-10-17 裁定并实施〕** 用户裁定「**都按你的建议，开工 PL-M16**」——**上表八项全部按推荐值接受**。实施结果正本见 **`docs/180`**：
>
> - **第 1/2 项（先探针定位 / 真实栈 + 录制型假网关）** → 新增 `packages/agent-core/scripts/probe-outer-loop-spin.ts`，三场景。定位结果：`additional_kwargs.tool_calls` 被原样带回 ⇒ `AIMessage` 派生出 `tool_calls` ⇒ `shouldContinue` 回到 tools 节点重复执行，而内层每轮被终止中间件 `jumpTo end`（零模型调用）⇒ 空转。**改动面因此只有一行**（重建消息时剔除 `tool_calls`），未触碰 `AgentGraph` / `AgentRunner` / `maxIterations`。
> - **第 3 项（候选修法）** → 已按此实现，但**收紧为无条件剔除**（不按 `captureSubmittedOutcome` 是否命中来条件化）——理由见 `docs/180` Implementation §3：内层已通过同一个 ToolRuntime 执行过每一个工具，外层再执行就是重复执行，与捕获是否命中无关；条件化会留下「捕获未命中而响应仍带 `tool_calls`」的洞。**探针实测：修复后场景 A 由 49 轮空转 → 3 轮 / `succeeded`。**
> - **第 4 项（若空转来自第三方库）** → **未触发**：产生环在平台自己的重建逻辑上。
> - **第 5 项（修完另开一批 E1×3）** → **未开工**；判据 **16h 因此延期**。
> - **第 6 项（L1-M4g 记账）** → 维持「**已执行 1/3、因发现确定性缺陷中止**」。
> - **第 7 项（更正 N-7 定性）** → **已执行**：探针场景 C 证实「N-7 是同一个空转被框架的 25 超步提前掐断的形态」，已以**追加块**更正 `docs/174` / `docs/175`（正文保留不改）。
> - **第 8 项（探针入库）** → 已入库 `packages/agent-core/scripts/`。
>
> **判据小结（`docs/180`）**：**16a–16g 与 16i 达成**；**16h 延期**。**N-9 不判「已关闭」**——关闭条件＝真实批次里空转零出现。
>
> **红线核对**：**N-6（`reasoning_content`）与 N-8（`innerProducedAIMessages`）均未复发**（两者各有既有用例钉住，均绿）。

## 8. 本批已发生的事实（供记账，非判据）

- **L1-M4g 批次**：脚本 `packages/eval/scripts/l1-m4g-e1-x3.sh`（本批新增），停机脚本 `l1-m4g-stop.sh`（本批新增），结果目录 `packages/eval/results/l1-m4g`。合同与 `l1-m4f-e1-x3.sh` 逐字一致。
- **run 1**（14:51:24 → 14:56:54 UTC，**297.9 s**）：工作流 `de90fdb0` **FAILED**（`S1 ok=0 bad=1 run=0 pend=10/11`）／自报=失败 / 链完成=否 / **staging 段=否（`-/-/-`）**／oracle 不通过／假阳性 否／人工介入 1（切片计划审批自动 APPROVED）／切片到达 **S1×1**／token 输入 **6,703,146** / 输出 1,437,707。
- **✅ PL-M15 被真实批次证实（判据 15h 的证据）**：3 个 agent run 全部走在守卫路径上（`iter=50` + `Agent reached max iterations`），`input_tokens` = **2,364,736 / 2,516,360 / 1,822,050**（正常量级），**坏值零新增**（全库仍 **11** 条）。
- **✅ 守卫读数被独立核对**：守卫增量 **6,703,146** = 三个 run 之和 **6,703,146**（逐位相等）⇒ `docs/178` Known Issue 1 的「少算」观察**在生产轮次上不成立**，守卫绝对读数可信。
- **✅ N-7 / N-6 全程零出现**：`Recursion limit of 25` **0**、`reasoning_content` **0**、`tool message content` **0**。
- **❌ 链仍止于第一个任务**：`T-DESIGN-S1` 三次尝试全部空转到 50 轮、`TOOL_ERROR`；任务自报 `outcome: SUCCESS` 仍判 FAILED。
- **🛑 批次已停**（用户裁定）：`l1-m4g-stop.sh` 实查角色已杀、**服务端无 `RUNNING`/`PENDING` 工作流**。停机**可逆**——脚本跳过已存在的 `run-1.json`，重启即从 run 2 续。
- **成本**：run 1 花 **6,703,146** 输入 token；守卫现值 **127,832,975 / 200,000,000**（余量 72.2M）。
