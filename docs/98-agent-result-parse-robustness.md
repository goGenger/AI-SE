# Agent 结果解析健壮化 — 空回复重问与结构化结果容错

> 来源：真实使用中 Agent 任务失败，失败原因显示
> 「Professional Agent returned an invalid structured result.」
> 本修复只做 Agent 结果产生与解析链路的容错，不改 Workflow Engine / 任务判定策略。

## 侦察结论（真实数据，2026-09-28）

失败任务 **T2（FRONTEND，workflow `9ed0eb96`，项目「画个自行车」）** 的 run 数据揭示**两种**失败形态：

| 形态         | 证据                                                                                                                                                        | 机制                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 空回复    | run `ecfca7a3`：`issues[0].description = "No result returned"`（= 最终答案为空串）；33 迭代、40 次工具调用、22 个产出物后以**空内容、无工具调用**的消息结束 | `AgentGraph.agentNode` 把「无工具调用」直接判定为 `succeeded` 最终答案；空答案 → `parseOutcome("")` 必然 INVALID                                |
| B. JSON 被拒 | run `c0b0bea5`（T1 首轮）：`issues[0].description` 是**形如合法 JSON** 的 `{"status":"SUCCESS","summary":"Design complete…"}`，但仍被拒                     | `OutcomeSchema.strict()`：模型附带额外字段即整体拒绝；另：长文本 summary 中的**未转义原始换行/制表符**会让 `JSON.parse` 失败（chatty 模型常见） |

历史链路：T1 首轮 INVALID → 重试（新 run）产生合法 JSON → 成功；T2 三次尝试（1 次空回复 + 2 次超时）全部无法产出可解析结果 → 任务 FAILED。

## 修复

| #   | 层              | 文件                                | 变更                                                                                                                                                                                                                                                                                                                                       |
| --- | --------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | agent-core 图   | `graph/AgentGraph.ts`               | **空回复重问**：响应为「空内容 + 无工具调用」时不再当作最终答案——追加提示消息（"Your previous reply contained no text. Reply with your final answer now."）继续循环，最多 `MAX_EMPTY_FINAL_NUDGES = 2` 次；事件记为 `agent_action / empty_reply_retry`（不再误报 `agent_final`）。`shouldContinue` 允许提示消息经 tools 节点空转回到 agent |
| 2   | agent-core 解析 | `professional/ProfessionalAgent.ts` | **结果解析容错**：① 根对象去掉 `.strict()`——多余字段被剥离而不是整体拒绝；② 枚举大小写归一（`"success"`→`SUCCESS`，severity/artifact type 同）；③ 新增 `escapeControlCharsInStrings`：字符串字面量内的原始控制字符（`\n`/`\r`/`\t`/其它 <0x20）转义后重试 `JSON.parse`                                                                     |
| 3   | server          | `services/workflowTaskExecutor.ts`  | 任务输出持久化解析诊断：`answerLength`、`answerTail`（配合已有 `errorType`），后续同类失败可直接从任务输出定位原因                                                                                                                                                                                                                         |

修复轮（repair turn）不变：结果仍不可解析时才触发、仍为单次；但由于空回复重问发生在**图内**，修复轮本身也会享受同样的重问保护。

## 测试

| 套件                                                                                                                      | 结果     |
| ------------------------------------------------------------------------------------------------------------------------- | -------- |
| `packages/agent-core` — agentGraph（新增「空回复重问」2 用例：重问后保留真实答案；连续空回复最多重问 2 次后按原行为结束） | 通过 ✔  |
| `packages/agent-core` — ProfessionalAgent parseOutcome（新增 3 用例：多余字段被接受；小写枚举归一；原始换行恢复）         | 通过 ✔  |
| `packages/agent-core` 全量                                                                                                | 63/63 ✔ |
| `apps/server` — workflowApi.e2e + professionalAgents.e2e（真实 PostgreSQL + 真实工作流/脚本模型）                         | 8/8 ✔   |
| 全仓门禁（final12）                                                                                                       | 见文末   |

## 门禁（final12，全仓）

`typecheck=0 / lint=0 / test=1 / build=0`（`test=1` = apps/web 7 个先存 eyebrow 用例）；
补跑 database **43/43** · agent-core **63/63** · mcp **235/235** · browser **38/38** ·
server **90/90**；全仓合计 **127 文件 / 962 例 / 955 通过 / 7 失败（全部先存）**。
修复后 live server 已重载（`/health` 200），下一次工作流运行即使用新逻辑。

## 边界与已知问题

1. 空回复重问上限 2 次：模型连续 3 次空回复仍会以上游 INVALID 处理（此时任务输出带 `answerTail` 诊断）。
2. 截断（模型输出被 max_tokens 截断）无法通过解析修复；修复轮与重问提供两次重新生成机会，仍失败则按 INVALID 记录。
3. 本修复不改变「任务判定以 Agent 自报结果为准」的策略（docs/97 已记录）。
4. 历史失败记录保持原样（不重写）。
