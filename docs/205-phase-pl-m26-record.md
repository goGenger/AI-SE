# 205 · PL-M26 实施记录（N-24：上游模型失败不再被记成 agent 的空答案）

> 阶段：**PL-M26**，用户 2026-10-20 授权「后面的任务如果没有一定要我确认的你就按照推荐继续跑」。
> 任务书：**`docs/204`**。发现场：**L1-M4o run 1**（批次因上游 429 中止，`docs/203`）。
> **未在真实批次验证 ⇒ 不判「已关闭」。**

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `packages/agent-core/src/professional/ProfessionalAgent.ts` | 修改 | 新增 `failedRunOutcome`；在空答案分支**之前**插入「运行失败」分支 |
| `packages/agent-core/src/professional/ProfessionalAgent.test.ts` | 修改 | 新增 `ThrowingModel` 桩 + 2 个用例（27a 正控 / 27b 负控） |
| `docs/204-phase-n24-provider-failure-attribution-taskbook.md` | 新增 | 任务书 |
| `docs/205-phase-pl-m26-record.md` | 新增 | 本文件 |

**零依赖改动。**

---

## 2. Implementation

```ts
if (!submitted && outcome.metadata.errorType === "INVALID_AGENT_RESULT") {
  const timedOut = result.status === "timed_out" || result.error?.code === "TIMEOUT_ERROR";
  if (timedOut) {
    outcome = timedOutOutcome(result);
  } else if (result.error?.code !== undefined) {
    outcome = failedRunOutcome(result);          // ← N-24 新增，位于空答案分支之前
  } else if (result.finalAnswer.trim() === "") {
    outcome = emptyFinalOutcome(result.finalAnswer);
  } else { ...修复轮... }
}
```

`failedRunOutcome` 的 `errorType` 取 `result.error?.code ?? "LLM_ERROR"`——**既有 `RuntimeErrorCode`，
不新增词汇**；`summary` / `issues.description` 用**固定措辞**，**不回显上游原文**
（外部文本，本包无 sanitize 通道，`AGENTS.md` §10）。

**放在空答案分支之前**的理由：一个 run 若既带错误码、`finalAnswer` 又为空，**根本原因是运行失败**，
空答案只是后果。L1-M4o run 1 的 `S1-01` **只跑了 1 秒**（`01:12:03 → 01:12:04`）却被记成
「agent 连续空回复」——**因果颠倒**。

---

## 3. Architecture Changes

**无。** 不新增错误码、不改失败分层的层数（见任务书 §7 第 2 项）、不改重试深度。

---

## 4. Dependencies

**无新增、无升级、无删除。**

---

## 5. Tests

**新增 2 个用例**：

| 判据 | 用例 | 断言 |
| --- | --- | --- |
| **27a** | `ThrowingModel`（`_generate` 直接抛错） | `result.status === "failed"`；`metadata.errorType === "LLM_ERROR"`；`summary` **不含** `429`；**未启动修复轮** |
| **27b**（负控） | `ScriptedAnswerModel(() => "")`（**无错误码**的真空答案） | 仍记 `EMPTY_FINAL_ANSWER`，`summary` 含「未返回结果」 |

**既有用例保持绿**：超时路径（27c）与修复轮路径（27d）各一条，未被本改动动到。

**包级门禁**：

| 包 | typecheck | lint | test |
| --- | --- | --- | --- |
| `@ai-se/agent-core` | ✅ | ✅ | **257 / 257**（35 文件；由 255 增至 257） |
| `@ai-se/server`（消费方） | ✅（rebuild `agent-core` dist 后 exit 0、零 `error TS`） | — | — |

---

## 6. E2E

**未跑真实批次**——上游 provider 自 2026-10-21 09:37 起处于降级状态
（探针 09:40 **1/3 失败**、09:51 **5/6 失败**），批次已按 `docs/203` 中止。
**本条的判据 27a/27b 在真实批次里的检验，与 PL-M25 的 26d/25f 一并等重开的那一批。**

---

## 7. Known Issues

1. **未在真实批次验证** ⇒ 不判「已关闭」。
2. **失败分层仍是三层**（规划 / 验证门 / agent）。本条让 `errorTypes` 里出现了可分辨的 `LLM_ERROR`，
   但 `classifyFailureLayer`（`packages/eval/src/harness.ts:220-233`）对它**没有匹配规则** ⇒
   **仍归入 agent 层**。是否新增「环境」层已列为 `docs/204` §7 第 2 项的待裁定，**推荐本批不做**。
3. **上游恢复时间未知**（外部条件）。
4. **`EMPTY_FINAL_ANSWER` 的机制登记已补上**（`docs/146` §3 的 N-24 行）：至少 L1-M4o 的 5 次是上游 429。
   **建议**：把「该码的 `agent_runs.error` 是否带 429」写进下一批的 watch item（`docs/204` §7 第 1 项）。

---

## 8. Acceptance Result

**交付物是「一处归因修复 + 2 个用例（含 1 个负控）+ 包级门禁全绿」，已全部给出。**
按仓库记账纪律，判 **「已实施、未在真实批次验证」**，**不判「已关闭」**。

---

## 9. Next Phase Boundary

**未开始事项（STOP）**：

1. **L1-M4o 的重开批次未做**（等上游恢复；`docs/203` §6）——PL-M25 的 26d/25f 与本条的 27a 同批检验。
2. **`docs/203` §6 的重开前置 + 新结果目录批次脚本未建。**
3. **`docs/204` §7 的三项待裁定**（推荐值已给）：watch item 补普查口径 / 是否新增「环境」层 / 是否自动暂停批次。
4. `docs/202` §9 列出的其余各项未动（`docs/17` 的 12 项 V1 勾选、两条 token 记账缺口、
   「两步修复」立项、`docs/` 写范围、`AGENTS.md` §6 归类冲突、全量 server 抖动清单）。
