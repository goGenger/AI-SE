# 211 · PL-M29 任务书：链路走不过 S2 ——「诊断任务诚实地报 REPLAN，就把自己的重试饿死了」

> 立项：2026-10-21。**发现场**：L1-M4q 三次运行**全部**止步 S1/S2（`docs/209`）。
> 性质：**机制核实 + 普查 + 修法设计**。**本文件不实施**（见 §9 STOP）。
> **结论：这不是「链不够长」，而是一个结构性饥饿——重试任务在结构上永远拿不到执行机会。**

---

## 1. 结论

**`-REPLAN-N`（重试任务）只有在 `-DEBUG-N`（诊断任务）SUCCESS 时才可能运行。
而诊断任务在「问题不在我这个类型里」时会诚实地返回 `outcome=REPLAN` —— 那被判成 FAILED
⇒ 重试的依赖永远不满足 ⇒ 重试**从不运行**；同时引擎在诊断任务上**再** replan，
嵌套出 `Diagnose Diagnose …`，把 `executionAttempt` 预算烧光后判整个工作流失败。**

⇒ **链走不过 S2，不是因为切片太难，而是因为「诊断」与「重试」之间的依赖方向错了。**

**本批实据**：2026-10-21 的 `-REPLAN-` 任务里 **PENDING 13 个 / 共 28 个**（**46% 的重试从未运行**）。

---

## 2. 机制（六步，逐步指到 `file:line` 与库内实例）

### 第一步：`replan()` 造两个任务，重试**依赖**诊断

`packages/workflow-engine/src/WorkflowEngine.ts:987-1034`：

```ts
tasks: [
  { taskKey: `${source.taskKey}-DEBUG-${attempt}`,  type: "DEBUG", … },   // :993
  { taskKey: `${source.taskKey}-REPLAN-${attempt}`, type: target.type, … } // :1016
],
dependencies: [
  …predecessors → debugId,
  { sourceTaskId: debugId, targetTaskId: retryId },   // :1034  ← 重试依赖诊断
  retryId → downstream
]
```

### 第二步：诊断任务被派给「目标类型」的 agent

`packages/agent-core/src/professional/AgentRegistry.ts:285-288 / :340-342`：
DEBUG 任务的 `effectiveType = debugTarget(task) = input.targetTaskType`，
再查 `TASK_AGENT_TYPES` 找承接 agent。⇒ 诊断任务**由该类型的职业 agent 执行**，
它拿到的唯一指令是「诊断」（`title: "Diagnose ${source.title}"`）。

### 第三步：诊断 agent 诚实地报 `REPLAN`

**它诊断出「问题不在我能修的范围里」**——这是**对的**。库内原文（L1-M4q）：

| task | summary（节选） | outcome |
| --- | --- | --- |
| `T7-DEBUG-1`（run 1） | 「Root cause … **the task was typed TEST but titled as a docs task**」 | **REPLAN** |
| `T7-data-store-hash-DEBUG-1` | 「the DATABASE deliverable … **is present and healthy, so retrying the DATABASE task would not change the failure**」 | **REPLAN** |
| `T4-DEBUG-1-DEBUG-2` | 「the only failing check … **product code never implements GET /**」 | **REPLAN** |

**对照（唯一收敛的那一条）**：run 3 的 `T7-DEBUG-1` ——「Diagnosed … **and repaired the missing
deliverable**」⇒ **SUCCESS** ⇒ 它的 `T7-REPLAN-1` **SUCCESS**。

⇒ **分水岭不是难度，是「诊断任务有没有顺手把活干了」。**
干了 ⇒ 重试能跑；没干（因为不该它干）⇒ 重试永远跑不了。

### 第四步：`REPLAN` 结果 ⇒ 诊断任务判 FAILED

`apps/server/src/services/workflowTaskExecutor.ts` 的 `resolveOutcomeErrorType`：
`outcome.status === "REPLAN"` ⇒ `errorType = "REPLAN_REQUESTED"`；
任务状态按失败处理（PL-M25 的 N-22 落码）。

### 第五步：重试的依赖永不满足 ⇒ **饥饿**

`-REPLAN-N` 依赖 `-DEBUG-N`（`:1034`）。诊断 FAILED ⇒ 依赖永不满足 ⇒ **重试恒 PENDING**。
**库内**：L1-M4q 的 `T7-REPLAN-1` / `T4-REPLAN-1` / `T7-data-store-hash-REPLAN-1` **全部 PENDING**。

### 第六步：在诊断任务上**再** replan ⇒ 嵌套 ⇒ 预算耗尽 ⇒ 判死

`WorkflowEngine.ts:903-909`：

```ts
if (strategy === "REPLAN" && workflow.policy.allowReplan &&
    asNumber(task.input.executionAttempt, 0) < workflow.policy.maxRetries) {
  await this.replan(workflow, task);   // ← 对**诊断任务自己**再 replan
  continue;
}
…
await this.failWorkflow(workflow.id, "WORKFLOW_TASK_FAILED", `Task failed: ${task.title}`);
```

`replan()` 里 `attempt = asNumber(source.input.executionAttempt, source.retryCount) + 1`
⇒ **每嵌一层 +1**；`maxRetries = 2` ⇒ **0 → 1 → 2 → 判死**。

**库内原文**：三个失败工作流的 `workflow_runs.error` 全部是

```
Task failed: Diagnose Diagnose <原任务标题>
```

**「Diagnose Diagnose」这个叠词就是嵌套的直接证据**——`title` 是 `Diagnose ${source.title}`，
而 `source` 已经是一个 `Diagnose …` 任务。

**完整链条（run 1，`9faa326e`）**：

```
T7 (REVIEW)                    FAILED  REPLAN      attempt 0
├ T7-DEBUG-1 (DEBUG)           FAILED  REPLAN      attempt 1   ← 诊断：问题不在 TEST
│ ├ T7-DEBUG-1-DEBUG-2 (DEBUG) FAILED  REPLAN      attempt 2   ← 又一层诊断
│ │ └ …（attempt 2 已到顶 ⇒ failWorkflow）
│ └ T7-DEBUG-1-REPLAN-2 (TEST) PENDING             ← 从未运行
└ T7-REPLAN-1 (TEST)           PENDING             ← 从未运行
```

**run 2（`cfc082e1`）与 run 3 的第二个工作流（`77585ba5`）同形。**

---

## 3. 普查（零配额只读）

### 3.1 `-REPLAN-` 任务到底有没有跑过

| day | SUCCESS | FAILED | **PENDING** | READY |
| --- | --- | --- | --- | --- |
| 2026-10-21 | 12 | 3 | **13** | — |
| 2026-10-20 | 7 | 3 | 3 | — |
| 2026-10-19 | 14 | 15 | 19 | 6 |
| 2026-10-18 | 7 | 5 | — | — |

**2026-10-21：13 / 28 的重试任务从未运行（46%）。**

### 3.2 诊断任务报 `REPLAN` 是什么时候开始的

| day | DEBUG 任务报 `REPLAN` 的次数 |
| --- | --- |
| 2026-10-21 | **10** |
| 2026-10-20 | 1 |
| 2026-10-19 | 5 |
| 更早 | **0**（全库） |

**⇒ 这个形状从 2026-10-19 才开始。** 那正是 **PL-M18（N-11）把 L1 的失败响应由
`RETRY` 改为 `REPLAN`** 的日期（`docs/184`）。

⇒ **本条是 PL-M18 的溢出**：在 `RETRY` 时代，失败就是「原样再试一次」，**没有诊断任务**，
也就不存在「诊断任务饿死重试」这件事。**改成 REPLAN 之后，诊断环节被引入，
但它的失败语义从未被重新想过。**

### 3.3 为什么不是「链不够长」

三次运行的**原始任务**（S1/S2 的 BACKEND/TEST/REVIEW/DATABASE）里，
`T1`/`T2`/`T3`/`T4`/`T5`/`T6` **大多 SUCCESS**——切片本身**做得动**。
死在链上的全是**动态任务**（`-DEBUG-` / `-REPLAN-`）。
⇒ **加长预算不会解决它**：嵌套会照样把新预算烧光（§2 第六步）。

### 3.4 🔴 方案 A 的**可行性普查**（它决定修法有没有用）

方案 A 要求「诊断任务报 `REPLAN` 时，若它给了可执行的交接信息 ⇒ 按交接处理」。
**这取决于诊断任务到底给没给。** 全库普查 **16 个「DEBUG + `REPLAN`」任务**：

| 读数 | 值 |
| --- | --- |
| DEBUG + REPLAN 任务总数 | **16** |
| 其中 `fixSteps` 非空 | **0**（**从来都是空的**） |
| 其中 `fixTaskType` 是**合法** `TaskType` | **10（62.5%）** |
| 满足「OR 判据」的 | **10（62.5%）** |

**两个结论**：

1. **`fixSteps` 对这条通道完全无用**——16/16 全空。⇒ 方案 A 的 OR 判据**实际上退化为
   「只看 `fixTaskType`」**。这不是坏事，但**不能把它写成「两条路」**。
2. **`fixTaskType` 在这条通道上的有效率是 62.5%，远高于全库的 15.8%**（`docs/210` §3.3）。
   原因不难猜：**DEBUG 任务被明确要求做诊断并交接**，所以它填这个字段的意愿最高。

**更强的一条**：**2026-10-21 今天的 10 个 DEBUG+REPLAN 任务，`fixTaskType` 全部合法**
（`BACKEND` ×5 / `TEST` ×4 / `BACKEND` ×1）⇒ **今天这 10 次全部会被方案 A 放行**。

⇒ **方案 A 不是「理论上能帮」，而是「按今天的实测数据，100% 命中当前正在发生的形状」。**

---

## 4. 修法设计（三个候选）

### 方案 A（**推荐**）：「诊断任务的 `REPLAN` 是**交接**，不是失败」

**规则**：当 `source.type === "DEBUG"` 且它返回 `outcome=REPLAN` 时——
**把该诊断任务记为 SUCCESS**（它完成了它的职责：诊断 + 指出需要的类型），
让**重试**跑起来；重试的类型取 `source.output.fixTaskType`（合法时）或沿用现规则。

**性质**：

- **不新增任务、不新增预算**；
- **只改 DEBUG 源的 REPLAN 语义**——非 DEBUG 源仍然照旧 replan（那里的 REPLAN 确实是
  「我修不了，换人」⇒ 造 DEBUG+重试是对的）；
- **诊断内容不丢**：`source.output.fixSteps` 已经通过 `input.execution.deepAgentSteps`
  传给重试任务（`:1001-1003`）；
- **直接消除 §2 的第五、六步**：重试不再被饿死，也就没有嵌套。

**风险**：诊断任务「没干活」却被记成成功——**但它的产出本来就是「诊断」，不是「修复」**。
需要一条判据把「诚实交接」与「偷懒」分开：**要求 `outcome=REPLAN` 且 `fixTaskType`/`fixSteps`
非空**才按交接处理；两者都空 = 纯喊话 ⇒ 仍判失败。

### 方案 B：重试只依赖诊断**完成**，不依赖它**成功**

改 `:1034` 的依赖语义为「sourceTaskId 已结束（任意状态）」。
**不推荐**：`Dependency` 目前没有「任意状态」这种语义，加它会影响所有依赖判定（一刀切的放松）。

### 方案 C：DEBUG 源的 replan **不再造 DEBUG 子任务**

即 `replan(DEBUG)` 只造一个重试任务。**不推荐**：它不解决饥饿——重试仍需要诊断 SUCCESS；
而且「第二层诊断」在某些情形下是有价值的（run 1 的 `T1-DEBUG-1-DEBUG-2` 就是 SUCCESS 的）。

### 方案 D：不改语义，只**提前判死并说明**

预算耗尽是**正确**的止损；问题在于**它掩盖了真正的原因**。
**建议作为 A 的补充**（不是替代）：把 `failWorkflow` 的 reason 从
`Task failed: Diagnose Diagnose …` 改成能说明「诊断结论是『需要 X 类型』、重试因依赖未满足而未运行」。

---

## 5. 判据（供实施后验收）

| # | 判据 | 形态 |
| --- | --- | --- |
| **31a** | DEBUG 源 + `outcome=REPLAN` + `fixTaskType` 非空 ⇒ 该诊断任务记 **SUCCESS**，其 `-REPLAN-N` **可运行** | **正控**（单测） |
| **31b** | DEBUG 源 + `outcome=REPLAN` 但 `fixTaskType` **与** `fixSteps` **都为空** ⇒ 仍判失败（**不收养懒**） | **负控**（单测） |
| **31c** | **非** DEBUG 源的 `REPLAN` ⇒ 行为**逐字不变**（仍造 DEBUG+重试） | **负控**（回归） |
| **31d** | 嵌套消失：不再出现 `Diagnose Diagnose …` 标题的诊断任务（或出现也**不再是**工作流失败原因） | 回归 |
| **31e** | 真实批次：`-REPLAN-` 任务的 **PENDING 比例显著下降**（2026-10-21 基线 **13/28 = 46%**） | **真实批次可验**（与本批同构） |
| **31f** | 真实批次：切片到达 deeper（S2 之后） | 观察项，非判据 |

---

## 6. 与其它条目的关系

| 条目 | 关系 |
| --- | --- |
| **PL-M18（N-11）** | **本条是它的溢出**：把失败响应从 RETRY 改成 REPLAN，**引入了诊断环节**，但诊断的失败语义从未重新设计。形状从 2026-10-19 开始（§3.2） |
| **N-22（`docs/199`，已修）** | `REPLAN_REQUESTED` 让本条的**证据**变得可见（以前是空 `errorType`）。**没有 N-22，本条几乎无法被看见** |
| **N-28（`docs/210`，两步修复）** | **不同问题**。N-28 是「一个重试装不下两次动作」（交付源，当前**零实例**）；本条是「重试根本没机会运行」（**每个 run 都在发生**）。**优先级：本条远高于 N-28** |
| **N-27（空转通过）** | 无关（验证门 vs replan 路由） |
| **`docs/200` §7.1** | 无关（那是「两步」；本条是「零步」——重试一次都没跑） |

---

## 7. 待裁定项（每条带推荐值）

| # | 待裁定 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | 是否实施 | **实施** | 这是**唯一**有机制解释、且在**每个 run 都发生**的阻断（§3.1 的 46%） |
| 2 | 修法选型 | **方案 A + D** | A 消除饥饿；D 让失败原因说人话。B/C 各有副作用（§4） |
| 3 | 「诚实交接」的判据 | **`fixTaskType` 合法 或 `fixSteps` 非空**（OR，不是 AND） | 保留 OR 语义（将来若 agent 开始填 `fixSteps`，无需再改规则）；但**普查已证 `fixSteps` 16/16 全空**（§3.4）⇒ **当前实际等价于「只看 `fixTaskType`」**，实施时**不要**为 `fixSteps` 写额外逻辑 |
| 4 | 是否同时提高 `maxRetries` | **否** | 嵌套消失后预算自然够用；**提高预算只会让嵌套烧得更久**（§3.3） |

---

## 8. 证据面（可复现）

```sql
-- ③ 诊断任务报 REPLAN 的时间线（§3.2）
SELECT date_trunc('day',created_at)::date AS day, count(*) FROM tasks
WHERE type='DEBUG' AND output->>'outcome'='REPLAN' GROUP BY 1 ORDER BY 1 DESC;

-- ⑤ 重试任务到底跑没跑（§3.1）
SELECT date_trunc('day',created_at)::date AS day, status, count(*) FROM tasks
WHERE task_key LIKE '%-REPLAN-%' GROUP BY 1,2 ORDER BY 1 DESC;

-- ⑥ 嵌套的直接证据（「Diagnose Diagnose」）
SELECT id, left(error->>'message',110) FROM workflow_runs
WHERE created_at >= '2026-10-21 07:39:00+00';
```

**三次运行的完整链**：`docs/209` §0 与 §2；`workflow_runs.error` 的原文见上。

---

## 9. Modified Files

| 文件 | 动作 |
| --- | --- |
| `docs/211-phase-pl-m29-retry-starvation-taskbook.md` | **新增**（本文件） |

**零 `src/` 改动、零测试改动、零依赖改动、零数据库写操作。** 全部核实为只读。

---

## 10. Implementation

**无。** 本文件是任务书。

---

## 11. Architecture Changes

**无。** §4 的改动**尚未落地**。

---

## 12. Dependencies

**无新增、无升级、无删除。**

---

## 13. Tests / 14. Lint / 15. Typecheck / 16. E2E

**均不适用**——零代码改动，未跑批次。§5 的判据供实施后使用。

---

## 17. Known Issues

1. **本条未实施**。
2. ~~**§4 方案 A 的「诚实交接」判据须先确认 `fixSteps` 的实际有值比例**~~ —— **已普查（§3.4），
   结论已落地**：**`fixSteps` 在 16/16 个「DEBUG + REPLAN」任务里全为空**，OR 判据**实际退化为
   「只看 `fixTaskType`」**；而该字段**在这条通道上的有效率是 62.5%**（10/16），
   **今天（2026-10-21）的 10 个更是 100% 合法**。⇒ **方案 A 的预期效果不低，反而正好命中当前形状。**
   **剩下的已知问题**：那 6 个（全部来自 2026-10-19）没有合法类型的仍会失败——
   **方案 A 不解决它们**，但它们是历史数据，当前不再产生。
3. **方案 D 只是措辞改进**，不改变行为。

---

## 18. Acceptance Result

**NOT APPLICABLE（任务书，非实施）。** 交付物是「六步机制 + 三张普查表 + 四个候选 + 六条判据 +
证据面」，已全部给出。

---

## 19. Next Phase Boundary

**未开始事项（STOP）**：

1. **本条未实施**——§4 方案 A+D **一行未写**。
2. **§7 四项待裁定**（推荐值已给：实施 / A+D / OR 判据 / 不提高 `maxRetries`）。
3. ~~**§17 第 2 项的先行普查未做**（`fixSteps` 的实际有值比例）~~ —— **已完成（§3.4）**：
   `fixSteps` **16/16 全空**；`fixTaskType` 在 DEBUG+REPLAN 通道上**有效率 62.5%**、
   **今天的 10 个 100% 合法** ⇒ **方案 A 正好命中当前形状**。
4. **N-28**（两步修复）任务书已立（`docs/210`），**优先级低于本条**。
5. **N-27** 未修；`docs/206`（N-25 用量）按裁定留到 L1-8 验收之后；
   `docs/` 写范围缺致败实例；`AGENTS.md` §6 冲突**未擅自改用户的规则文件**。
