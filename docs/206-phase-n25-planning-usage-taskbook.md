# 206 · N-25 任务书：规划段的 token 用量从未被采集

> 立项：2026-10-21。**登记来源**：`docs/198` §3 缺口 ①，经 §16.4 勘误后**收窄为一条**
> （交付编排那条已撤回——该编排器不调用语言模型，无 token 可记）。
> 性质：**登记 + 机制核实 + 修法设计**。**本文件不实施**（见 §7 STOP）。
> **未阻塞 L1-8**：本项不影响自治 L1 的验收，只影响**成本可见性**。

---

## 1. 结论

**规划阶段是真模型，但它的用量在库里完全不可见。** 807 次 `planning-agent` run 的
`token_usage` **全部为空**。这不是「偶尔没记上」，而是**整条规划流水线从未采集过用量**——
从模型接口到落盘路径，**四层里三层缺位**。

**影响面（两条，都指向「守卫与指标看不见规划段」）**：

1. **批次的周用量守卫**（`packages/eval/scripts/lib/usage-guard.sh`）只求和
   `agent_runs.token_usage` ⇒ **规划段的花费不进守卫**；
2. **eval 的 `tokenUsage` 指标**同理，只统计 agent 段。

**守卫不会 fail-open**（它不会放行坏值），但它**看不见这一段**——这是**结构性漏统计**，
不是「偶尔少记」。而规划恰恰是全流程里**提示词最长**的一段（E1 的 PRD 8,445 字符 × 多阶段）。

---

## 2. 机制（四层，逐层指到 `file:line`）

按 [[defect-registration-needs-code-proof]]：**形状只是假设**，所以下面每一层都指到代码，
并说明它**在实例里真的被走到**。

| # | 层 | 位置 | 现状 |
| --- | --- | --- | --- |
| 1 | **模型接口** | `packages/agent-core/src/planning/PlanningModel.ts:14-18` | `generateStructured<T>(request): Promise<unknown>` ——**返回值就是解析后的对象本身**，**没有用量信封**。接口层面就把它丢掉了 |
| 2 | **真实实现** | `LangChainPlanningModel.ts:53-84` | 走 `this.model.withStructuredOutput<T>(schema, …)`，再 `structured.invoke(messages, { signal })`。**LangChain 这个调用路径只返回解析值**；用量挂在底层 `AIMessage.usage_metadata` 上，**被这一行丢弃** |
| 3 | **结果类型** | `PlanningAgent.ts:67-77` | `PlanningAgentResult` **没有用量字段**（`agentRunId` / `requirementId` / `status` / `output` / `error` / `currentIteration` / `startedAt` / `finishedAt` / `duration`） |
| 4 | **落盘调用** | `PlanningAgent.ts:215`（成功）/ `:256`（失败） | 两处 `onRunFinished` **都没有传 `tokenUsage`** |

**关键对照（证明「问题在上游没有值，不在落盘侧」）**：

- 记录类型**是支持**用量的：`packages/agent-core/src/agent/AgentLifecycle.ts:30`
  ——`tokenUsage?: JsonObject;`（同一接口上还有 `estimatedCost?: number;`）；
- 消费方**是会写**的：`apps/server/src/services/agentRunService.ts:498`
  ——`tokenUsage: record.tokenUsage,`。

⇒ 落盘通道**一直在**，只是**从来没有人往里送值**。**所以修法不是「补一行回写」**。

### 2.1 为什么这不是「形状倒推」

`docs/198` §3 的登记**有两处**，其中「交付编排」那处在 §16.4 被**撤回**：该编排器
（`apps/server/src/services/deploymentOrchestrator.ts`）里 `ChatModel` / `createOpenAI` / `invoke(`
的出现次数 **= 0**——**它不调用语言模型**，所以零用量是**正确的**。

**本条（规划段）与它的区别**：规划段**有真模型**，且这一点**独立于用量读数**已经成立——
`apps/server/src/index.ts:147-159` 在 `config.llmProvider === "openai"` 时构造
`LivePlanningModel`（否则 `ScriptedPlanningModel`），而 `.env` 是 `LLM_PROVIDER=openai`；
另有 807 次 `PLANNING_STARTED` 与 **1,772 次 `TASK_DAG_VALIDATION_FAILED` / 1,194 次
`PLANNING_REPAIR_REQUESTED`**——**脚本化模型不会 schema 失败、也不需要修**。
⇒ **「有真模型」是独立证据，「用量为空」是缺口**，两者不是同一个推断。

---

## 3. 修法设计（**本文件不实施**）

### 3.1 必须改的四层（**这是一次跨包的接口改动**）

1. **模型接口**：`PlanningModel.generateStructured` 的返回类型从 `Promise<unknown>`
   改为带用量的信封（例如 `Promise<{ value: unknown; tokenUsage?: JsonObject }>`）
   ⇒ **两个实现 + 全部调用点**都要改。
2. **`LangChainPlanningModel`**：改用 LangChain 的 `includeRaw: true`
   （`withStructuredOutput(schema, { includeRaw: true })` 返回 `{ raw, parsed }`），
   从 `raw.usage_metadata` 取 `input_tokens` / `output_tokens`。
   **注意**：`STRUCTURED_OUTPUT_ATTEMPTS` 的**重采样循环**（`:74-83`）意味着**一次逻辑调用可能
   对应多次模型调用**——用量必须**累加**，不能只取最后一次。
3. **规划图**：逐阶段的用量**聚合**（阶段数 = `PLANNING_STAGES.length`）。
4. **`PlanningAgent`**：`PlanningAgentResult` 加字段；**两处** `onRunFinished` 都传
   `tokenUsage`（成功与失败**都要**——失败也花了钱）。

### 3.2 不必改的

- **`ScriptedPlanningModel`**：它不调用模型，**返回空用量是正确的**——不要为了「统一」给它
  造一个假值。这与 §16.4 撤回交付编排那条是**同一条判据**。
- **落盘侧**：`agentRunService.ts:498` 已经在写；**不要动**。
- **不要新增 token 记账的第二套字段**（`AGENTS.md` §10：禁止第二套体系）——
  沿用既有 `tokenUsage`。

---

## 4. 判据（供实施后验收）

| # | 判据 | 正控 / 负控 |
| --- | --- | --- |
| **28a** | 一次真实规划 run 的 `agent_runs.token_usage` **非空**，且 `input_tokens` 量级与提示词长度相称 | **正控** |
| **28b** | **失败的**规划 run 也带用量（走到 `:256` 的那条路径） | **正控** |
| **28c** | 一次触发了 `STRUCTURED_OUTPUT_ATTEMPTS` 重采样的规划，其用量是**累加值**而非单次值 | **正控**（须构造或从库内找一个多轮样本） |
| **28d** | `ScriptedPlanningModel` 的 run **仍然没有用量**（不造假值） | **负控** |
| **28e** | `week_tokens()` 的读数在改造前后**只增不减**（守卫此前看不见这一段 ⇒ 改造后应**变大**） | **口径变化须预先声明**（[[coverage-fixes-look-like-regressions]]） |

> **⚠️ 28e 的预先声明**：修完之后，**同样的批次会报出更高的周用量**。
> 这**不是回归**，是**守卫终于能看见规划段**。这与 [[coverage-fixes-look-like-regressions]]
> 描述的情形同型——**加门会让数字变差，而那正是门在起作用**。
> 该读数变化**必须写进改造后第一批的脚本头**，否则会被误读成「用量暴涨」。

---

## 5. 与其它条目的关系

- **与 N-20 方向相反、同属记账口径**：N-20 是**多计**（两级相加翻倍），本条是**不记**。
- **与 `docs/198` §16.4 的关系**：§16.4 是**勘误**（撤回一条），本条是把**剩下那条**
  升级为**可实施的任务书**。
- **与 [[batch-attribution-needs-db-verification]] 的关系**：本条正是「记账口径缺陷」的又一例，
  修法同样是**证同源 `file:line` + 库内复算 A/B**（见 §4 判据 28a–28e）。

---

## 6. 风险

| 风险 | 说明 | 处置 |
| --- | --- | --- |
| **跨包接口改动** | `PlanningModel` 被两个实现 + 规划图消费；改返回类型会波及所有调用点 | 编译期即可全量暴露（TS 严格模式）；**不引入兼容 shim**（`AGENTS.md`：不留向后兼容层） |
| **重采样累加** | 若只取最后一次调用，会**低报** | 判据 **28c** 专测这一条 |
| **用量口径不一** | LangChain 的 `usage_metadata` 字段名（`input_tokens` / `output_tokens`）须与既有 `agent_runs.token_usage` 的键**一致**，否则守卫的求和会漏 | 实施时**先读** agent 段落的键名再对齐 |
| **改造与批次耦合** | 在验收批次**开批前**改这个，会让该批的用量读数与 `errorTypes` 一并变化，**归因变难** | **不在批次前实施**（见 §7） |

---

## 7. 待裁定项（每条带推荐值）

| # | 待裁定 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | **何时实施** | **L1-8 验收批次跑完之后** | 本条**不阻塞 L1-8**；在批次前改会污染该批的用量读数与归因（§6 末行）。当前上游降级、批次本身就在等，**更不该在这个窗口插入跨包改动** |
| 2 | 是否顺带给 `estimatedCost` 也补上（`AgentLifecycle.ts:31` 已有该字段） | **本项不做** | 需要单价表（模型 × 每百万 token），是**另一个数据源**，与本条的「采集」不是一回事。先让用量可见，成本换算等有需求再说 |
| 3 | 是否给 `ScriptedPlanningModel` 的 run 加一个「零用量是预期的」标记 | **不加** | 它本来就是脚本化模型；加标记是为**已知为真**的事情造一个字段（`AGENTS.md`：不为不会发生的场景加防御） |

---

## 8. Modified Files

| 文件 | 动作 |
| --- | --- |
| `docs/206-phase-n25-planning-usage-taskbook.md` | **新增**（本文件） |

**零 `src/` 改动、零测试改动、零依赖改动、零数据库写操作。** 全部核实为只读。

---

## 9. Implementation

**无。** 本文件是任务书（登记 + 机制 + 修法设计），**不是实施记录**。

---

## 10. Architecture Changes

**无。** §3 设计的接口改动**尚未落地**。

---

## 11. Dependencies

**无新增、无升级、无删除。**

---

## 12. Tests

**不适用**（零代码改动）。§4 的判据 28a–28e 是**供实施后**验收用的。

---

## 13. Lint

**不适用**（同上）。

---

## 14. Typecheck

**不适用**（同上）。

---

## 15. E2E

**不适用**（同上）。**未跑任何批次。**

---

## 16. Known Issues

1. **本条未实施**（§7 裁定 1：留到 L1-8 验收批次之后）。
2. **`estimatedCost` 同样为空**——但那是**另一个数据源**（单价表），不在本条范围（§7 裁定 2）。
3. **判据 28c 需要一个多轮重采样样本**——库里是否有这样的规划 run **尚未普查**；
   若没有，实施时须**构造**一个（否则累加逻辑未被验证）。

---

## 17. Acceptance Result

**NOT APPLICABLE（任务书，非实施）。** 交付物是「机制核实 + 修法设计 + 判据」，已全部给出。

---

## 18. Next Phase Boundary

**未开始事项（STOP）**：

1. **本条未实施**——§3 的四层改动**一行未写**。
2. **§7 三项待裁定**（推荐值已给：批次后实施 / 不补 `estimatedCost` / 不加标记）。
3. **判据 28c 的重采样样本未普查**（§16 第 3 项）。
4. **L1-M4p 批次未开**（等上游恢复；`docs/203` §6）——PL-M25 的 26d/25f 与 PL-M26 的 27a 同批检验。
