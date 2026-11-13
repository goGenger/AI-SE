# 210 · PL-M28 任务书：「两步修复」——交付任务需要「先修、再重跑」

> 立项：2026-10-21。**登记来源**：`docs/200` §7.1（N-23 任务书的「必须说清的交互」）。
> 性质：**登记 + 机制核实 + 普查 + 修法设计**。**本文件不实施**（见 §8 STOP）。
> **⚠️ 先说清楚一件事**：本条**不是** L1-8 当前的阻断点。普查证明它在 **2026-10-21 之后零实例**
> （见 §3），而 L1-M4q 三次致死时 `input.delivery` 任务数为 **0** ⇒ **那三次与本条无关**。
> 我在 2026-10-21 18:36 的汇报里把两者混为一谈，**在此更正**（§7）。

---

## 0. 结论

**「一个 retry 任务装不下两次动作」是一个真实的结构性限制，但它当前是潜伏的，不是活跃阻断。**

- **机制成立**（§2，四处 `file:line`）：`replan()` 造的 DEBUG 任务与 retry 任务**共用同一个类型**，
  而「谁去修」与「重跑什么」本来是两件事。
- **但实例已经归零**（§3）：`2026-10-21` 起**交付源任务的 replan 实例 = 0**——PL-M25 的 N-23
  修复把「交付类型被换掉」那条路堵死之后，**能触发本条的入口也随之关闭**。
- **普查顺带发现一件更值得注意的事**（§3.3）：N-22 新增的 `fixTaskType` 通道**有效率只有 15.8%**
  （753 个非空值里 **119** 个是合法 `TaskType`）。⇒ **「agent 点名类型」这条通道大部分时候是哑的**，
  平台每次都静默回退到第 3 步兜底。

⇒ **建议实施优先级：低于「为什么链走不过 S2」**（§7 裁定 1）。

---

## 1. 问题复述（`docs/200` §7.1 原文的表）

「CI 任务因**过期测试**失败」这个形状，两个修复方向各自只能走一半：

| 方案 | retry 的 type | 结果 |
| --- | --- | --- |
| 只修 N-23（保住交付类型） | **BUILD/CI** | CI 重新跑一次，但测试**仍是过期的** ⇒ 再失败 ⇒ 再 replan ⇒ 预算耗尽 |
| 只修 N-22（听 agent 的） | **TEST** | 测试被改对了，但 **CI 从未重跑** ⇒ `ci_runs` 仍无成功行 ⇒ 下游 `T8` 依旧 `CI_RELEASE_NOT_FOUND` |

**正确形状需要两步：先改测试，再重跑 CI。** 而 `replan()` 只造**一个** retry 任务。

---

## 2. 机制（四处 `file:line`）

| # | 位置 | 事实 |
| --- | --- | --- |
| 1 | `packages/workflow-engine/src/WorkflowEngine.ts:981` | `const target = debugTargetType(source, fixWorkTargetType(source, tasks));` —— **一个**类型 |
| 2 | 同文件 `:1000` | `-DEBUG-N` 的 `input.targetTaskType: target.type` —— **派发键**（`AgentRegistry.resolveTask` 按它找 agent） |
| 3 | 同文件 `:1021` | `-REPLAN-N` 的 `type: target.type` —— **契约键**（`DeliveryOrchestrator.canHandle` 按它分派） |
| 4 | 同文件 `:106`（N-23） | 交付类型短路：`if (isDeliveryTaskType(source.type)) return { type: source.type, … }` |

**关键**：`target.type` 被**同时**喂给两个**语义相反**的消费者。

- **派发键**要的是「**有承接 agent 的类型**」——`BUILD`→DEVOPS、`TEST`→QA 都行，
  但**修测试这件事该由 QA 做，不是 DEVOPS**；
- **契约键**要的是「**保住 `input.delivery`**」——必须是源任务的交付类型。

⇒ **两件事被一个变量绑死了。** N-22 想用 `fixTaskType` 表达「该谁来修」，但那条值同时改了契约键
⇒ 修复任务变成 TEST，CI 再也不会重跑。

---

## 3. 普查（零配额只读）

### 3.1 交付源任务失败后的 replan 去向

```sql
SELECT date_trunc('day',src.created_at)::date AS day, src.type,
       src.input->'delivery'->>'action' AS action,
       coalesce(t.type,'(no replan)') AS retry_type, count(*)
FROM tasks src LEFT JOIN tasks t ON t.source_task_id=src.id AND t.task_key LIKE '%-REPLAN-%'
WHERE src.input ? 'delivery' AND src.status='FAILED' GROUP BY 1,2,3,4 ORDER BY 1 DESC;
```

| day | 源类型 | action | retry 类型 | 次数 |
| --- | --- | --- | --- | --- |
| 2026-10-20 | BUILD | CI | **BACKEND** | 2 |
| 2026-10-20 | BACKEND | CI | BACKEND | 1 |
| 2026-10-20 | BACKEND | CI | DEBUG | 1 |
| 2026-10-20 | BACKEND | DEPLOY | BACKEND | 1 |
| 2026-10-20 | BACKEND | DEPLOY | DEBUG | 1 |
| 2026-10-20 | DEPLOY | DEPLOY | **BACKEND** | 1 |
| 2026-10-20 | REVIEW | VERIFY | BACKEND | 1 |
| 2026-10-15 | BUILD | CI | （无 replan） | 2 |
| 2026-10-07 | DEPLOY | DEPLOY | （无 replan） | 2 |

**`2026-10-21` 起：0 行**（专项查询 `src.input ? 'delivery' AND t.created_at >= '2026-10-21'` ⇒ **0**）。

⇒ **N-23 修复之后，交付任务的 replan 一律保住交付类型**（这是修复的目的），
**「retry 类型 ≠ 源交付类型」这个入口随之关闭** ⇒ **本条当前零实例**。

### 3.2 本条的实例（全部是修复前的）

只有 **L1-M4n**（`docs/200` §2.5 / `docs/201`）：
`T7`（**BUILD**/CI）→ `T7-REPLAN-1`（**BACKEND**）—— 修复前的形状。
其中「agent 点名 TEST」那一列**从来没有在库里出现过**（§3.3 解释了原因）。

### 3.3 🔴 普查的意外发现：`fixTaskType` 的**有效率只有 15.8%**

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE output->>'fixTaskType' IN
         ('BACKEND','FRONTEND','DATABASE','TEST','BUILD','DEPLOY','REVIEW','DESIGN','ANALYSIS')) AS valid
FROM tasks WHERE output->>'fixTaskType' IS NOT NULL;
```

**total = 753，valid = 119（15.8%）。**

最常见的**非法**取值：`IMPLEMENTATION` 202、`NONE` 193、`IMPLEMENT` 122、`none` 50、
`FEATURE` 9、`DOCUMENTATION` 4、`FEATURE_IMPLEMENTATION` 4 …

⇒ `isUsableTargetTaskType`（`packages/shared/src/index.ts:500`）把它们**全部拒绝**，
**静默回退**到 `debugTargetType` 的第 2/3 步。

**这不是缺陷**（成员判定 + 回退正是 PL-M3 的设计），**但它的后果是**：

- 「agent 点名修复类型」这条 N-22 通道**大部分时候是哑的**；
- **§1 表格里「只修 N-22 ⇒ retry 变 TEST」那一列，在库里从未发生过**——
  agent 说的是 `TEST_FIX` / `IMPLEMENTATION`，不是 `TEST`；
- ⇒ **本条描述的失败模式目前是「两个入口都关着」**：一个被 N-23 关（契约键固定），
  一个被 `fixTaskType` 的低有效率关（派发键很少被真正指定）。

---

## 4. 设计（三个候选，推荐 A）

### 方案 A（**推荐**）：拆开两个消费者——派发键与契约键分开算

`replan()` 里算**两个**类型，而不是一个：

```ts
const retryType = /* 契约键 */ ;
const repairType = /* 派发键 */ ;
```

- **契约键**：源是交付类型 ⇒ `source.type`（N-23 的规则，**不变**）；否则沿用现有
  `debugTargetType(...)` 的结果。
- **派发键**：源有**合法的** `fixTaskType` ⇒ 用它；否则等于契约键。

⇒ `-DEBUG-N.targetTaskType = repairType`（谁去修），`-REPLAN-N.type = retryType`（重跑什么）。

**性质**：

- **不新增任务数**——`replan()` 本来就造两个任务，只是让它们**各司其职**；
- **两类型相同时行为逐字不变**（这是绝大多数情形）⇒ 风险面很小；
- 「先修、再重跑」由**既有的 `debugId → retryId` 依赖**（`:1034`）保证顺序——**不需要新机制**。

**这一条最重要的性质**：它把 §3.3 那个「通道哑掉」的问题**同时**缓解了——
`fixTaskType` 不再需要「正好是合法 TaskType 且同时是对的契约」，
它只需要表达「谁来修」，契约由源任务决定。

### 方案 B：加第三个任务（repair → re-run）

链从 DEBUG+retry 变成 DEBUG+repair+retry。**不推荐**：所有 replan 链的形状都变，
`-REPLAN-N` 的命名语义、深度守卫、既有产物全部受影响；收益与 A 相同。

### 方案 C：让 retry 任务自己「两步」

在 retry 任务的 prompt 里要求「先修测试再跑 CI」。**不推荐**：这是**行为塑造**，
无法机械验证——`docs/193` 已经就同一类问题给出过结论（剩余出路只能在行为侧，无法验证）。

---

## 5. 判据（供实施后验收）

| # | 判据 | 形态 |
| --- | --- | --- |
| **30a** | 交付源 + **合法** `fixTaskType` ≠ 源类型 ⇒ `-DEBUG-N.targetTaskType` = fixTaskType，`-REPLAN-N.type` = 源交付类型 | **正控**（单测） |
| **30b** | 交付源 + **无/非法** `fixTaskType` ⇒ 两个类型**都等于源类型**，`-REPLAN-N.type` 不变 | **负控**（单测，防回退） |
| **30c** | 非交付源 ⇒ **行为逐字不变**（比对既有单测断言） | **负控**（回归） |
| **30d** | 依赖顺序不变：`predecessors → debug → retry → downstream` | 回归 |
| **30e** | 真实批次：出现「DEBUG(QA) 改了受保护测试 → retry(BUILD) 重跑 CI → `ci_runs` 写入成功行」的链 | **只有在形状复现时才可验**；不出现就如实记「未行使」，**不得拿 30a 顶替** |

---

## 6. 与其它条目的关系

| 条目 | 关系 |
| --- | --- |
| **N-23**（`docs/200`，已修 PL-M25） | 本条是它的**溢出**：N-23 让契约键固定，于是派发键再也没有独立表达的空间 |
| **N-22**（`docs/199`，已修 PL-M25） | 本条要**改变** N-22 那个字段的用途——从「同时决定契约与派发」收窄为「只决定派发」 |
| **N-27**（空转通过，`docs/146` §3） | **无关**。N-27 在验证门，本条在 replan 路由 |
| **`docs/200` §7.1** | 本条就是那一节正式立项 |

---

## 7. 待裁定项（每条带推荐值）

| # | 待裁定 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | **实施优先级** | **低于「弄清为什么链走不过 S2」** | 本条**当前零实例**（§3.1），而 L1-M4q 三次致死**都不是这个形状**。**先修一个潜伏问题、放着活跃阻断不管**是错的顺序 |
| 2 | 修法选型 | **方案 A**（拆开两个消费者） | 不新增任务数、两类型相同时行为逐字不变、且顺带缓解 §3.3 的通道哑化 |
| 3 | 是否顺带**收紧** `fixTaskType` 的提示词（减少 `IMPLEMENTATION` 这类非法值） | **本项不做，另记** | 那是一次**提示词**改动，效果无法机械验证；且方案 A 之后，「非法值只是回退到契约类型」**不再产生错误契约**，危害已下降 |
| 4 | 是否给「非法 `fixTaskType`」加一个可观测计数 | **建议加**（成本低） | 现在它是**静默回退**；加计数才能回答「N-22 的通道到底有多哑」。可作为方案 A 的附带项 |

---

## 8. 边界（**必须先读这一段**）

### 8.1 本条**不解决** L1-M4q 的三次致死

L1-M4q 三次运行**都没有交付任务**（`input.delivery` = **0**），死因分别是：

| run | 死因 | 是不是本条 |
| --- | --- | --- |
| 1 | `T7`（**REVIEW**）反复报 `REPLAN_REQUESTED`，链耗尽 | **不是** |
| 2 | `T4`（**BACKEND**）验证失败（AC-21 真失败）⇒ DEBUG → REPLAN → DEBUG-2 ⇒ 链耗尽 | **不是** |
| 3 | `T7-data-store-hash`（**DATABASE**）`TOOL_ERROR` ⇒ DEBUG(`REPLAN`) → DEBUG-2(`VERIFICATION_FAILED`) | **不是** |

⇒ **「为什么链走不过 S2」是另一个问题**，而它目前**只有现象、没有机制**——
需要先对那三次的 replan 链做逐环普查（每个 DEBUG 任务给出了什么、下一个为什么还是失败）。
**这应该是下一个任务书的主题，不是本条。**

### 8.2 本条当前**不可在真实批次验证**

`30e` 要求形状复现，而形状当前**零实例**。⇒ 实施后只能验 `30a–30d`（单测 + 回归），
真实批次层**必然未行使**。**不得因此判「已关闭」。**

---

## 9. Modified Files

| 文件 | 动作 |
| --- | --- |
| `docs/210-phase-pl-m28-two-step-fix-taskbook.md` | **新增**（本文件） |

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

## 13. Tests

**不适用**（零代码改动）。§5 的判据供实施后使用。

---

## 14. Lint / 15. Typecheck / 16. E2E

**均不适用**——零代码改动，未跑批次。

---

## 17. Known Issues

1. **本条未实施**，且**当前零实例**（§3.1）。
2. **`fixTaskType` 有效率 15.8%**（§3.3）——**已在本文件记录**，建议加可观测计数（§7 裁定 4）。
3. **§8.1 的那个问题（链走不过 S2）没有任何机制解释**——本条不覆盖它。

---

## 18. Acceptance Result

**NOT APPLICABLE（任务书，非实施）。** 交付物是「机制 + 普查 + 三个候选设计 + 判据 + 边界」，已全部给出。

---

## 19. Next Phase Boundary

**未开始事项（STOP）**：

1. **本条未实施**——§4 方案 A **一行未写**。
2. **§7 四项待裁定**（推荐值已给）。
3. **§8.1 的「链走不过 S2」未立项**——**我认为它才是当前该做的下一件事**。
4. `docs/206`（N-25 规划段用量）按裁定留到 L1-8 验收批次之后；
   **N-27** 未修（修前须先普查那 41 次「无 AC 标记」的形态）；
   `docs/` 写范围缺致败实例；`AGENTS.md` §6 冲突**未擅自改用户的规则文件**。
