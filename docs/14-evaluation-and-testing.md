# Evaluation and Testing

> ## 基线状态（2026-10-15 逐条核实）
>
> 本文写于**平台实现之前**（第一版路线图的评测与测试设计），是**实现前设计**，不是 as-built 描述，
> **不构成开工依据**。原文一字未删（保留当初的设计意图），下面是对照现状的核实表：
>
> | 本文条款 | 与当前实现的关系 |
> | --- | --- |
> | Unit 覆盖 9 项（Agent State / Agent Runner / **LangGraph routing** / Tool Runtime / Permission / **Retry Policy** / Timeout / **Cancellation** / **Error normalization**） | **4 项有专属测试文件，4 项只被内联覆盖，1 项偏弱**。Agent State ✓、Agent Runner ✓、Tool Runtime ✓、Permission ✓、Timeout ✓ 各有专属文件。**Retry Policy / Cancellation 只在 `agentRunner.test.ts` 里内联断言**，没有专属文件。**Error normalization**：MCP 侧的错误映射有专属测试，但**Agent 侧的 `normalizeRuntimeError` 没有专属测试**。**LangGraph routing 偏弱**：`agentGraph.test.ts` 只断言工具暴露与循环，**真正的条件边没被直接断言** |
> | Integration：PostgreSQL | **成立且是真容器**：`packages/database/src/testPostgresContainer.ts` 真的 `docker run` 起 postgres，被各 DB 测试复用 |
> | Integration：Redis | **不成立**：`RedisCancellationStore` 存在，但**没有任何测试连真实 Redis**——e2e 里它被注入成 `checkRedis: async () => undefined` 这样的桩 |
> | Integration：Docker Sandbox | **成立且是真 Docker**：`packages/sandbox` 的测试用真实 `DockerSandbox`（条件跳过） |
> | Integration：LLM provider adapter（可用受控测试 double） | **成立**：`FakeChatModel` 用于单测，e2e 用脚本化的 provider double |
> | E2E「固定 Bug Repository：定位 → 修改 → diff → 测试 → 失败分析 → 再修改 → 通过」 | **逐环节都在**：夹具是 `examples/coding-agent-test-project`，循环在 `packages/agent-core/src/__tests__/codingAgent.e2e.test.ts`——真实 Docker 沙箱 + ToolRuntime，`list_directory`/`search_code` 定位 → 编辑 → `git_diff` → 跑失败的 `run_unit_test` → 再改 → 跑通 |
> | 「**核心 E2E 不允许通过 Mock 假装 Agent 完成代码修改和执行**」 | **这条守住了，但有一处要说明**。**没有任何 E2E 伪造文件写入或命令执行**——写入是真的，断言到磁盘字节。**但被 mock 的是「Agent 的决策层（LLM）」**：e2e 一律使用脚本化的 provider double（`ScriptedCodingLLMProvider` / `ScriptedDeepAgentModel`），`v1GoldenScenario` 的注释也自己写明「live LLM agent execution is BLOCKED BY EXTERNAL CONFIG」。**结论：没有一条 E2E 证明过「活 LLM 驱动的 Agent 能完成闭环」**——这条与「真实 AI 验证」在 `docs/17` 里仍记为部分达成是同一件事 |
> | Evaluation Metrics 11 项 | **名称与实现不符，且三项名不副实**。真实情况：**Task Success Rate ✓ / Tool Success Rate ✓ / Duration ✓ / Token Usage ✓**；**Test Pass Rate、Repair Success Rate、Iterations 三项在 DB 层算了但没有导出**；**`Estimated Cost` 名不副实**——指标位存在，但 `estimated_cost` **全仓没有任何产出方**，恒为空（与 `docs/03` 基线状态表同一发现）；**`Visual Similarity / Dimension Scores` 不成立**——没有 similarity 数字，只有评分枚举 + diffRatio；**`Visual Issue Resolution Rate` 不成立**——只有逐轮 `resolvedIssues`，没有比率指标；**`Browser Runtime Error Rate` 部分**——只有逐轮的原始错误计数，没有比率。另：文档给的名字与代码里的指标名并不一致 |
> | 「回归数据放在 `examples/evals`」 | **路径不存在**：真实位置是 `packages/eval/fixtures/`（夹具）与 `packages/eval/results/`（结果 JSON 与 `*-summary.md`） |
> | Phase 5「临时 Todo 全栈仓库」E2E（Database/Backend/Frontend/DevOps/QA/Reviewer 经 Workflow Engine 执行；QA 首次真实测试失败后生成 Backend Fix Task，随后重测与 Review 通过；指标直接从 PG 的 AgentRun/Task/ToolCall/Artifact 聚合） | **整条成立**：`apps/server/src/__tests__/v1GoldenScenario.e2e.test.ts` 就是这个场景——QA 真实测试失败后以 `REPLAN` 策略创建动态修复任务（含 `fixTaskType: "BACKEND"` 的修复卡），重测通过后走 review → CI → staging → 审批；指标用裸 SQL 直接从 PG 聚合 |
> | Phase 5.6「不以单一 similarity 数字作为结论，至少结合结构差异、像素辅助差异和视觉问题列表；Visual Issue 必须可追溯到 Reference / Candidate / Viewport / Evidence」 | **差异比对部分成立，VLM 观测部分未上线**。结构差异 + 像素辅助差异 + 问题列表都是真的，报告里也带 `referenceSource` / `candidateSource` / `viewport` 溯源。**但 VLM 路径不是活的**：provider 在缺 key 时明写「requires an injected apiKey (**refusing to fake PASS**)」，e2e 用的是确定性的截图分析替身。**所以「截图 → 规格」这一环是替身，其余是真的** |
> | Visual Engineering E2E 链 `Visual Input → UI Specification → Frontend Agent → Browser → Screenshot → Visual Evaluation → Fix Task → Re-evaluation` | **八个环节都在**（浏览器是真 Playwright、截图是真截图、评测是真评测、修复任务是自动提交的），**唯独截图之后的 VLM 分析是替身**——与上一行同源 |
>
> **结论**：**「E2E 是真的」这一条整体守住了**——固定 Bug 仓库的闭环、Todo 全栈场景、视觉修复链都是真 Docker / 真浏览器 / 真磁盘断言，没有用 mock 假装代码被改了。需要修正三类：① **11 项指标里有 3 项根本没有产出方或没有比率**（`Estimated Cost` 恒为空、`Visual Similarity` 没有这个数字、`Visual Issue Resolution Rate` 没有比率），另有 3 项算了但没导出；② **`examples/evals` 路径不存在**，回归数据在 `packages/eval/`；③ **Redis 的集成测试是桩不是真连接**。另有一处必须说清的边界：**所有 e2e 的 Agent 决策层都是脚本化替身，没有任何一条 E2E 证明过活 LLM 的闭环**——这与 `docs/17`「V1 真实 AI 验证」仍记部分达成是同一条事实，两处不要互相读成已达成。
> 依据：`AGENTS.md` §9「代码权威于文档；冲突必须报告，禁止默默改任一方来对齐」。

## Unit

- Agent State
- Agent Runner
- LangGraph routing
- Tool Runtime
- Permission
- Retry Policy
- Timeout
- Cancellation
- Error normalization

## Integration

- PostgreSQL
- Redis
- Docker Sandbox
- LLM provider adapter（可使用受控测试 double，但不得替代核心 E2E）

## E2E

固定 Bug Repository：

```text
定位 → 修改 → diff → 测试 → 失败分析 → 再修改 → 通过
```

核心 E2E 不允许通过 Mock 假装 Agent 完成代码修改和执行。

## Evaluation Metrics

- Task Success Rate
- Tool Success Rate
- Test Pass Rate
- Repair Success Rate
- Iterations
- Duration
- Token Usage
- Estimated Cost
- Visual Similarity / Dimension Scores
- Visual Issue Resolution Rate
- Browser Runtime Error Rate

回归数据放在 `examples/evals`。

Phase 5 E2E 使用临时 Todo 全栈仓库：Database/Backend/Frontend/DevOps/QA/Reviewer 通过 Workflow Engine 执行；QA 首次真实测试失败后生成 Backend Fix Task，随后重测和 Review 通过。指标直接从 PostgreSQL 的 AgentRun、Task、ToolCall 和 Artifact 聚合。

## Phase 5.6 Visual Evaluation

Visual Evaluation 不以单一 similarity 数字作为结论，至少结合结构差异、像素辅助差异和视觉问题列表。Visual Issue 必须可以追溯到 Reference、Candidate、Viewport 和相关 Evidence。

## Visual Engineering E2E

完整验证链：

```text
Visual Input → UI Specification → Frontend Agent → Browser → Screenshot → Visual Evaluation → Fix Task → Re-evaluation
```
