# 204 · N-24（上游模型调用失败被记成 agent 侧的「空答案」）任务书（PL-M26）

> 立项：2026-10-21。发现场：**L1-M4o 批次的 run 1**（`docs/203` 的中止记录）。
> 性质：**实现前设计**（`docs/146` §6 规则 7 允许的第三类文档）。
> 与 `docs/199`（N-22）/ `docs/200`（N-23）同属**记账与归因**族，但**成因不同**：这两条是**平台自己**的
> 路由/落盘缺口，本条是**把外部故障错记成平台故障**。

---

## 0. 为什么现在做

1. **它有实例，且是刚刚发生的**：L1-M4o run 1 的 5 个任务**全部**带 `agent_runs.error.code = "LLM_ERROR"`
   （`429 Upstream request failed: Endpoint is unavailable`），却**全部**被记成 `EMPTY_FINAL_ANSWER`。
2. **它会让下一批的归因失真**：上游当前**约 5/6 请求被 429**（`docs/203` §2 的独立探针）。
   若上游在下一批仍不稳定，**每一次上游抖动都会被读成「agent 质量下降」**。
3. **平台的失败分层只有三层**（规划 / 验证门 / agent，`packages/eval/src/harness.ts:220-233`），
   没有「环境」层 ⇒ 本条修与不修，这类失败都落在 **agent** 层。**本文件只修「是什么」，
   不修「落在哪层」**（后者的取舍见 §7 第 2 项）。

---

## 1. 范围与排除

**在范围内**

- `ProfessionalAgent` 在**运行本身失败**时的 `errorType` 归类。

**明确排除**

| 排除项 | 理由 |
| --- | --- |
| 失败分层的层数（是否新增「环境」层） | 会改动 eval summary 的 schema 与既有口径，**本批不做**，见 §7 第 2 项 |
| LLM 调用的**重试深度** | 已有有界重试（`AgentGraph.ts:168-185` 的 `invokeWithRetry`）；本条不调它 |
| 上游为何 429 | **外部条件**，不在本仓库可控面内（`docs/203` §5 第 2 条） |
| `EMPTY_FINAL_ANSWER` 的**其他**成因 | 真正的空答案（模型确实什么都没说）**仍然应当**记为该码 |

---

## 2. 基线事实（实测）

### 2.1 机制：分类只分三类，没有「运行本身失败」这一类

`packages/agent-core/src/professional/ProfessionalAgent.ts:494-501`：

```ts
if (!submitted && outcome.metadata.errorType === "INVALID_AGENT_RESULT") {
  const timedOut = result.status === "timed_out" || result.error?.code === "TIMEOUT_ERROR";
  if (timedOut) {
    outcome = timedOutOutcome(result);
  } else if (result.finalAnswer.trim() === "") {
    outcome = emptyFinalOutcome(result.finalAnswer);   // ← 429 落在这里
  } else {
    ...一次修复轮...
  }
}
```

`emptyFinalOutcome`（`:380-397`）固定产出：

```ts
summary: "Agent 未返回结果（连续空回复，重问次数已用尽）。",
metadata: { errorType: "EMPTY_FINAL_ANSWER", answerLength: answer.length }
```

**`result.error?.code` 只被用来判「超时」**（`TIMEOUT_ERROR`），**其余码一律不看**。

### 2.2 `LLM_ERROR` 是运行失败，不是「agent 没说话」

`packages/agent-core/src/graph/AgentGraph.ts:299-302`：

```ts
} catch (error) {
  if (options.signal?.aborted) return cancelledUpdate();
  return failureUpdate("LLM_ERROR", error);
}
```

⇒ 模型调用抛错时，**run 以 `status: "failed"` + `error.code = "LLM_ERROR"` 结束**，
`finalAnswer` 自然为空。

### 2.3 实例（L1-M4o run 1，workflow `ff211882`）

| 任务 | `agent_runs.status` | `error.code` | 任务 `output.errorType` |
| --- | --- | --- | --- |
| `S1-01` | failed | **LLM_ERROR** | `EMPTY_FINAL_ANSWER` |
| `S1-07` | failed | **LLM_ERROR** | `EMPTY_FINAL_ANSWER` |
| `S1-08` | failed | **LLM_ERROR** | `EMPTY_FINAL_ANSWER` |
| `S1-07-DEBUG-1` | failed | **LLM_ERROR** | `EMPTY_FINAL_ANSWER` |
| `S1-07-DEBUG-1-DEBUG-2` | failed | **LLM_ERROR** | `EMPTY_FINAL_ANSWER` |

**5/5**：`agent_runs` 手里有 `LLM_ERROR`，任务输出里却是 `EMPTY_FINAL_ANSWER`。
其中 `S1-01` 的 run 只跑了 **1 秒**（`01:12:03 → 01:12:04`）——**1 秒不可能产生一次空答案**，
但它被记成「agent 连续空回复」。**这个读数本身就证伪了那条归因。**

### 2.4 对照：`tool` 模式正常

同一批次的 `S1-01-DEBUG-1` 以 `outcomeMode = tool` 正常提交并拿到真 `VERIFICATION_FAILED`
⇒ 本条**不是**提交通道的问题，只在**运行失败 + 复盘路径**上。

### 2.5 已知的前身

`docs/201` / `l1-m4n` 脚本 watch item 14 记着「`EMPTY_FINAL_ANSWER` 频率（L1-M4h 5 次 /
L1-M4i 1 次 / L1-M4j 1 次；**机制未知**）」。**本文件把机制补上**：至少 L1-M4o 这 5 次是上游 429。

---

## 3. 判据（27a–27d）

| # | 判据 | 判法 |
| --- | --- | --- |
| **27a** | run 带 `error.code` 且非 `TIMEOUT_ERROR` ⇒ 结果的 `errorType` **取该码**，不再固定为 `EMPTY_FINAL_ANSWER` | 单测：`LLM_ERROR` 的 run ⇒ `metadata.errorType === "LLM_ERROR"` |
| **27b** | **真**空答案（run 无 `error.code`、`finalAnswer` 为空）⇒ **仍记 `EMPTY_FINAL_ANSWER`** | 单测（**这是本条的负控**，防「顺手把这一支删了」） |
| **27c** | 超时路径**不变**（`TIMEOUT_ERROR` ⇒ `timedOutOutcome`） | 既有单测保持绿 |
| **27d** | 修复轮路径**不变**（有内容但不可解析 ⇒ 一次修复轮） | 既有单测保持绿 |

**措辞约束**：`summary` / `issues.description` **不得回显上游的原始错误文本**——
它来自外部网关，本包没有 sanitize 通道（`AGENTS.md` §10）。用固定措辞，`errorType` 只放**枚举码**。

---

## 4. 设计裁定（推荐）

**推荐：在空答案分支**之前**插入一支「运行失败」分支，`errorType` 取 `result.error.code`。**

```ts
} else if (result.error?.code !== undefined) {
  outcome = failedRunOutcome(result);          // 新增
} else if (result.finalAnswer.trim() === "") {
  outcome = emptyFinalOutcome(result.finalAnswer);
} else { ...修复轮... }
```

`failedRunOutcome`（新增，紧邻 `timedOutOutcome`）用**固定措辞**，只把**枚举码**放进 metadata：

```ts
function failedRunOutcome(result: AgentResult): ProfessionalOutcome {
  return {
    status: "FAILED",
    summary: "Agent run failed before returning a result (the model call failed).",
    artifacts: [],
    issues: [{
      severity: "HIGH",
      description: "The model call failed; the agent never produced an answer.",
      recommendation: "Retry the task; if it recurs, check the model provider."
    }],
    recommendations: [],
    metadata: { errorType: result.error?.code ?? "LLM_ERROR" }
  };
}
```

**为什么放在空答案分支之前**：一个 run 若**同时**「带错误码」且「答案为空」，
**根本原因是运行失败**（2.3 的 1 秒实例即证）；空答案只是它的后果。
把它记成「agent 连续空回复」是把**因果颠倒**。

**为什么不新造一个码**：`LLM_ERROR` 是既有的 `RuntimeErrorCode`（`AGENTS.md` §10：禁止第二套错误码体系），
且它比任何新名字都更精确。**本改动不新增词汇，只让既有的码不再被覆盖。**

**为什么不动 `classifyFailureLayer`**：见 §7 第 2 项——那是分类法的取舍，不是本条的归因错误。

---

## 5. 验证分层

**第 1 层 · 单测（必做，不需配额）**

- `ProfessionalAgent`：`LLM_ERROR` + 空答案 ⇒ `errorType === "LLM_ERROR"`（27a）。
- 真空答案（无 error.code）⇒ `EMPTY_FINAL_ANSWER`（27b）。
- 既有超时/修复轮用例保持绿（27c/27d）。

**第 2 层 · 包级门禁**：`corepack pnpm --filter @ai-se/agent-core typecheck && lint && test`
（`agent-core` 消费方 `apps/server` 一并跑）。

**第 3 层 · 真实批次**：下一批若上游再抖动，`errorTypes` 里应出现 `LLM_ERROR` 而**不是**
`EMPTY_FINAL_ANSWER`；且 `agent_runs.error.code` 与任务 `output.errorType` **取值一致**。

---

## 6. 边界与红线

- **不改** `classifyFailureLayer` 的层数（§7 第 2 项）。
- **不改** `invokeWithRetry` 的重试深度。
- **不新增**错误码词汇；只用既有 `RuntimeErrorCode`。
- **不回显**上游原始错误文本（§3 措辞约束）。
- **不删**空答案分支——27b 是它的护栏。
- **历史任务记录不回填**（`docs/146` §6 规则 7）。

---

## 7. 待裁定项（每条带推荐值）—— **已裁定（2026-10-21）**

> 裁定依据：用户 2026-10-20「后面的任务如果没有一定要我确认的你就按照推荐继续跑」⇒
> **三条一律按推荐值执行**（[[decision-style]]）。执行落点见「落点」列。

| # | 待裁定 | 裁定 | 理由 | 落点 |
| --- | --- | --- | --- | --- |
| 1 | 顺带把 `EMPTY_FINAL_ANSWER` 的普查口径（是否带 429）写进下一批 watch item | ✅ **写** | `docs/203` §5 第 3 条；否则这条会被再次误读成平台缺陷 | 重开批次的脚本头 watch item（`l1-m4p-e1-x3.sh`） |
| 2 | 是否给失败分层新增「环境」层（provider / sandbox / Docker） | ✅ **本批不做，另记** | 会改动 eval summary 的 schema 与既往批次口径；且「哪些码算环境」需要一次普查才定得下来（[[verdict-rules-need-a-census]]）。修完本条后，`errorTypes` 里已有 `LLM_ERROR` 这个可分辨的信号，**分类法可以等有了读数再定** | 记在 `docs/205` §7 第 2 项，**保持三层** |
| 3 | 上游 429 时是否让批次**自动暂停**（而不是把 run 跑完） | ✅ **不做自动暂停**，人工判断 | 自动暂停需要一个「多少 429 算不可用」的阈值，而阈值本身要普查；本次由人判（`docs/203`） | 不加自动暂停逻辑；改用「开批前探针 ≥ 5/6」作为**事前门**（`docs/203` §6） |

**三条均为「不新增机制」的裁定**——第 2、3 条都卡在同一个前提上：**阈值/分类需要先普查**。
⇒ 在普查之前，用**已有的可分辨信号**（`LLM_ERROR`）＋**人工判断**代替新机制，是当前最小改动。


---

## 8. 本批已发生的事实（供记账，非判据）

- **L1-M4o 批次**因上游 429 于 run 1 后**人工中止**（`docs/203`）：run 1 止于 slice-1、
  16 次 agent run 里 **5 次 429**、输入仅 2.53M token、staging 段未尝试。
- **上游探针**（直连网关、最小请求）：09:40 CST **1/3 失败**、09:51 CST **5/6 失败** ⇒ **未恢复**。
- **本条的 5 个实例全部来自这一次中止**——它是「上游不可用」这一外部条件的**直接产物**。
