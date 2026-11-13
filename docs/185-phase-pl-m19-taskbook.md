# 185 · N-12（replan 的「已解决」只认一层）任务书（PL-M19）

> 状态：**待裁定**（2026-10-19）。用户 2026-10-19「**立项 N-12**」。**立项 ≠ 开工授权**（`docs/146` §0）——§7 七项须逐条裁定后另起开工令。
> 依据：**L1-M4j 批次实测**（`packages/eval/results/l1-m4j`）、库内 `workflow_runs` / `tasks` 实查（2026-10-19）、**代码实查**（`packages/workflow-engine/src/WorkflowEngine.ts` 全文相关段、`packages/database/src/workflowRepositories.ts`、`apps/server/src/services/traceService.ts`）。
> 性质：**任务书（实施前设计）**，不是实施记录。**本文件不新造验收编号**——修的是缺陷，判据编号 **19a–19g** 供验收使用。
> 上游：`docs/183`（PL-M18 任务书）、`docs/184`（PL-M18 实施记录 + 真实批次验证勘误块，**N-12 即在该勘误块中首次登记**）。

---

## 0. 为什么现在做这一批

1. **它已被证实能单独致死一条 run**。L1-M4j **run 2**（工作流 `bb5f0610`）**纯因它而死**：17 个任务里 **16 个 SUCCESS**，唯一判「未解决」的那条链**最终是成功的**。工作流被判 `FAILED` 是**错的**——不是「救不回来」，是**记账没跟上**。
2. **它是 PL-M18 解锁出来的**。`replan` 分支的闸门是 `strategy === "REPLAN" && allowReplan`，而 PL-M18 之前 L1 的策略是 `RETRY` + `allowReplan: false` ⇒ **这条规则此前不可达**。PL-M18 把 REPLAN 变成 L1 的**默认失败响应**，于是「深度 2 的抢救」由不可能变成常态——**这条缺陷的触发概率随之上升**，且它现在就写在默认路径上。
3. **纪律要求先清缺陷再花配额**（`docs/183` §0 第 3 条同一口径）：已知、已定位、已能复现的缺陷不修掉，再跑批次等于用配额重新发现同一个东西。**当前登记在册的、已定位的平台侧缺陷只剩它一条**（N-10 / N-11 已修，N-1…N-9 均已闭环）。
4. **它是本批三条 FAILED 里唯一可修的那条**。另外两条（run 1 的 `32e4d903`、run 3 的 `8b92fc3e`）叶子任务**自身失败且无解析者**——那是 `maxRetries: 2` 预算耗尽的**正确**判定，不是缺陷（见 §2.3）。**如实标注**：修掉 N-12 **不会**让 L1-8 达标——run 1 / run 3 的死因与它无关。修它的理由是**它错了**，不是「修完就能过」。
5. **窗口**：周配额 **274,208,057**（上限已被用户授权抬到 **400,000,000**），窗口 **2026-10-19 07:00 CST** 刷新。修复期正好落在窗口交替处。

---

## 1. 范围与排除

**范围内**（一项）：

| 编号 | 名称 | 终止的 run | 类型 |
| --- | --- | --- | --- |
| **N-12** | **replan 的「已解决」只认一层**——`FAILED` 任务只在**直接** `resolvedByTaskId` 指向 `SUCCESS` 时才算已解决；抢救发生在**第二层**时，最上游那层仍判「未解决」⇒ `WORKFLOW_TASK_FAILED` | L1-M4j **run 2** | 平台侧（控制流记账） |

**排除**（本批不做，只登记）：

- **BACKEND 的 `checks failed: test`**——L1-M4j 里 **5 次**验证门失败全是它，是**唯一反复出现的致败类型**；但 replan 救回了 3 次，另外 2 次是预算耗尽（见 §2.3）。**登记为下一批头号观察项**，本批不动。
- **`EMPTY_FINAL_ANSWER`**、**`INVALID_AGENT_RESULT`**（于 `T-S4-R1`，**已自愈**）——机制未查明，登记。
- **三处「工作类型」概念合并**（`docs/184` Known Issues 5）——登记为后续议题。
- **`parseAcResults` 仍把 `FR-nn` / `TR-nn` 当 AC 键**（`docs/184` Known Issues 7）——N-10 靠作用域收窄绕过了后果，解析规则本身未改。登记。
- 便宜档探针的形态 / 频率（自 `docs/177` 挂起）；`T-DESIGN-S1` 计划粒度。

---

## 2. 基线事实（实测）

### 2.1 N-12 的实测链条（库内逐条，2026-10-19 实查）

工作流 **`bb5f0610-eee4-443c-9145-27d221438ed5`**（`created_at` 2026-10-18 16:29:58 UTC，`finished_at` **17:18:53 UTC = 01:18 CST**——与 L1-M4j **run 2 的收尾时刻逐秒吻合**，故归因为 run 2；run 2 只产出**这一条**工作流）。

`error`：

```json
{"code": "WORKFLOW_TASK_FAILED", "message": "Workflow contains unresolved failed tasks"}
```

该工作流共 **17 个任务**，其中 **16 个 SUCCESS**。全部非 SUCCESS 行如下：

| `task_key` | `status` | `type` | `resolved_by_task_id` → | 解析者状态 |
| --- | --- | --- | --- | --- |
| `T-05` | **FAILED** | BACKEND | `T-05-REPLAN-1` | **FAILED** |
| `T-05-REPLAN-1` | **FAILED** | BACKEND | `T-05-REPLAN-1-REPLAN-2` | **SUCCESS** |
| `T-05-REPLAN-1-REPLAN-2` | **SUCCESS** | BACKEND | （无） | — |

`T-05-DEBUG-1`（SUCCESS，DEBUG）与 `T-05-REPLAN-1-DEBUG-2`（SUCCESS，DEBUG）为伴生诊断任务，不影响判定。

**⇒ 链条是 `T-05` → `T-05-REPLAN-1` → `T-05-REPLAN-1-REPLAN-2`(SUCCESS)：工作**已经做完了**。工作流却判 `FAILED`，唯一原因是最上游那层的**直接**指针停在一个 FAILED 的中间节点上。

### 2.2 判定式在代码里的位置与消费方（代码实查）

| 位置 | 内容 |
| --- | --- |
| `WorkflowEngine.ts:532-538` | `advanceOnce` 的 `unresolvedFailure`：`task.status === "FAILED" && (!task.resolvedByTaskId \|\| !successfulIds.has(task.resolvedByTaskId))` |
| `WorkflowEngine.ts:278-282` | `retry()` 的**同一谓词**（注释在 :277 行明写「与 `advanceOnce` 的 `unresolvedFailure` 判定同源」） |
| `WorkflowEngine.ts:968` | **写入方**：`replan()` 把源任务的 `resolvedByTaskId` 指向 `retryId`（**只下一层**） |
| `WorkflowEngine.ts:1103` | **写入方**：`rollback()` 把源任务的 `resolvedByTaskId` 指向 `rollbackId`（单层） |
| `apps/server/src/services/traceService.ts:231` | 仅**透传展示**该字段，无判定 |
| `packages/failure-recovery/src/*` | **无**此逻辑 |
| `apps/web/src` | **无**此字段 |

**⇒ 改动面 = 一个谓词、两个调用点**。全仓再无第三处消费方。

### 2.3 负对照：本批另外两条 FAILED 是**真的**救不回来（修完必须仍判 FAILED）

| 工作流 | 归属 | 链 | 叶子 |
| --- | --- | --- | --- |
| `32e4d903` | run 1 slice-2 | `T-08` → `T-08-REPLAN-1` → `T-08-REPLAN-1-REPLAN-2` | **FAILED，无解析者** |
| `8b92fc3e` | run 3 slice-2 | 同上；另 `T-10` → `T-10-REPLAN-1`(**SUCCESS**，该任务**已**被正确判为已解决) | **FAILED，无解析者** |

两者的终止消息是 `Task failed: Retry Retry …`（`WorkflowEngine.ts:897`），即 `executionAttempt >= maxRetries` 后**预算耗尽**落到终局分支——**正确**。

**⇒ 判据 19c 的核心**：N-12 的修复**不得**把这两条翻成 SUCCESS。「链走到头是 FAILED」与「链走到头是 SUCCESS」必须**继续被区分开**。这两条工作流同时是修复的**反向对照**。

### 2.4 已排除的候选（及为什么）

| 候选 | 排除理由 |
| --- | --- |
| 调大 `maxRetries` | 不修根因，只是把墙往后推一层；且 `32e4d903` / `8b92fc3e` 那种**是真的失败**，多给预算也救不回来 |
| **回写传播**（最深那层成功时，回写祖先的 `resolvedByTaskId`） | 要**写已终结的任务行**，多一套并发面与写冲突可能；而「解析链」本可以在**读侧**算出来，无需落库 |
| 让 `replan()` 直接把源任务的指针指向「未来的最终 retry」 | 计划期不可能知道未来；第二层 replan 是否会发生取决于尚未执行的任务 |
| 把 `BLOCKED` / `CANCELLED` 也纳入「可被传递解析」 | 会让被阻塞 / 被取消的任务被误判为已解决，**放松**判定——违反红线 |

### 2.5 同批观察（登记，不立项）

1. **BACKEND 的 `checks failed: test`**——本批 5 次，唯一反复出现的致败类型。
2. **`EMPTY_FINAL_ANSWER`**——L1-M4j 1 条（L1-M4h 5 条）。
3. **`INVALID_AGENT_RESULT`**——L1-M4j 属 `T-S4-R1`，**已自愈**。
4. 三处「工作类型」概念（`docs/184` Known Issues 5）；`parseAcResults` 的 FR/TR 解析（同 Known Issues 7）。

---

## 3. 判据（19a–19g）

| 编号 | 判据 |
| --- | --- |
| **19a** | **N-12 的产生点被指认**——抓到实际数据，指出是哪一行、哪个条件把 `T-05` 判成「未解决」，并**逐条列出**该工作流全部非 SUCCESS 行及其解析者状态。**只认实测，不认推断** |
| **19b** | **探针复现 N-12**——离线、确定性、零网关配额；复现出的失败形态与生产**同形**（同判定码、同触发条件）。探针必须能**分别**复现两种子情形：① 抢救发生在**第二层且成功**；② 链走到头**自身失败** |
| **19c** | **修复后转绿，且不放松判定**——子情形① 转 `SUCCESS`；子情形② **仍判 `FAILED`**（`WORKFLOW_TASK_FAILED`）。`BLOCKED` / `CANCELLED` 的未解决判定**逐字不变** |
| **19d** | **两个消费点同源**——`retry()` 与 `advanceOnce` 的判定由**同一处**提供，不得只改一处；且该同源关系**可被机械验证**（不是靠注释声明） |
| **19e** | **既有断言逐字不变且全绿**——`WorkflowEngine.test.ts` 里既有的 `resolvedByTaskId` 用例（第 738 / 796 行那两条「**直接**指向 SUCCESS」形状）**一字不改**；`apps/server/src/__tests__/failureRecovery.e2e.test.ts:876` 那条「replan 写指针」的断言**一字不改** |
| **19f** | **不引入语义漂移**——不改 `maxRetries` / `maxIterations` / `recursionLimitFor`；不改 L1 策略字段（`failureStrategy` / `allowReplan` / `allowRetry` / `deployFailureStrategy`）；不动守卫（`packages/eval/src/usageGuard.ts`）；不动 PL-M17 的 `@langchain/openai` 补丁；不改 `EvalPolicy`（P0 冻结基线）与 L1-8 判据口径 |
| **19g** | **若查明为上游产物质量、平台无可修点 → 不阻塞**：立观察项 + 留证据，如实标注，不硬凑修复。**预期不适用**——§2.1 已把产生点钉死在平台侧的记账谓词上 |

**红线**（任何一条被触发即本批判负）：

- N-6（`reasoning_content` 400）、N-8（`input_tokens > 10M`）、N-9（外层 `tool_call_requested`）**均不得复发**。
- 不得为了让链走通而**弱化**红灯检查、anti-tamper、写范围审计或守卫中的任何一个。
- 不得修改历史 `tasks` / `agent_runs` / `workflow_events` 行。
- **不得把 `32e4d903` / `8b92fc3e` 那两条形态翻成 SUCCESS**（§2.3）。

---

## 4. 设计裁定（推荐）

1. **修法＝先探针定位，再定点修**——与 PL-M13 / PL-M16 / PL-M17 / PL-M18 同形。**不先猜再改**。
2. **探针形态**：真实 `WorkflowEngine` + **忠实内存 store**（先例：`packages/workflow-engine/scripts/probe-n11-review-verdict-path.ts`，它实现了全部约 20 个 `WorkflowStore` 方法），假 executor 让**指定任务**失败。**离线、确定性、零配额**。变体至少三支：
   - **P0**：单层抢救（源 FAILED → retry SUCCESS）——对照，修复前后都应 `SUCCESS`。
   - **P1**：**第二层抢救**（源 FAILED → retry FAILED → retry-retry SUCCESS）——修复前 `FAILED`，修复后 `SUCCESS`。**这就是生产形态**。
   - **P2**：**链走到头自身失败**（第三层失败 / 无解析者）——修复前后都应 `FAILED`。**反向对照**。
3. **修法候选集（限两条）**：
   - **(a) 传递式判定**：把 `successfulIds.has(task.resolvedByTaskId)` 换成「沿 `resolvedByTaskId` 链走到头，**尽头是 SUCCESS** 才算已解决」。**纯读侧、零状态写入**。
   - **(b) 回写传播**：最深那层成功时回写祖先指针。**不推荐**（见 §2.4）。
   - **明确不做**：调 `maxRetries`；把 `BLOCKED` / `CANCELLED` 纳入传递；让 `replan()` 预写未来指针。
   - **推荐 (a)**，由探针在 (a)/(b) 间确认（**预期 (a)**）。
4. **两个消费点必须同源，且同源要可机械验证**：抽出一个**共享谓词**供 `retry()` 与 `advanceOnce` 共同调用。位置＝**`packages/workflow-engine/src/` 内的模块局部函数**（新文件 `resolution.ts` + `resolution.test.ts`，跟随该包「同目录混放测试」的惯例）。**不放 `packages/shared`**——这是引擎内部逻辑，不是跨包契约（`AGENTS.md` §3）。既有的「注释声明同源」（`:277`）**不足以防止再次漂移**，这正是 N-12 能悄悄长出来的土壤。
5. **深度上界与防环**：`executionAttempt < maxRetries`（=2）⇒ 从原始任务出发的链长 **≤ 2 跳**。实现**不得**把 2 写死（那是策略值，会变）；用 **visited 集合**防环。结构上 `replan()` 只创建**新**任务、指针只向前，环不可能——但**不该把这条不变量静默依赖**在判定式里。
6. **文档处置（重要）**：`docs/99`（任务书）§二.3 与 `docs/100`（实施记录）§… **把「一层」写成了既定语义**（`docs/99:59` 原文即「`FAILED && (!resolvedByTaskId || resolvedByTaskId 不是 SUCCESS)`」，`docs/100:55` 复述同一句）。二者都是**历史记录（冻结，永不改写）**（`docs/146` §6 规则 7）⇒ **只追加勘误块，正文一字不改**。
   **⇒ 所以这不是 CONTRACT CONFLICT**（代码与文档**一致**），而是一次**对已写下的语义的更正**——必须在实施记录里说清「改的是哪一条既定语义、为什么它错」。活文档（`docs/127` / `docs/146` / `docs/17`）按规则正常更新。
7. **修完另开一批 E1×3**（**新结果目录**，**不续跑 l1-m4j**）——修复改的是平台版本，续跑会把两个版本混进同一批次（`docs/164` §7 第 4 项起的同一口径）。**l1-m4j 记「已执行 3/3、staging 段 0/3」，其三次 run 均不补跑。**
8. **§2.5 的四项只登记、另行立项**。

---

## 5. 验证分层

| 层 | 内容 |
| --- | --- |
| **第 1 层：探针定位** | 一支（真实 `WorkflowEngine` + 忠实内存 store + 假 executor），三变体 P0 / P1 / P2。**离线、确定性、零网关配额** |
| **第 2 层：单测** | `packages/workflow-engine/src/resolution.test.ts`（共享谓词直测：单层 / 多层 / 断链 / 环 / `BLOCKED`·`CANCELLED` 不参与）+ `WorkflowEngine.test.ts` 邻域新增（第二层救回转 SUCCESS、链尽头失败仍 FAILED）。**既有用例一字不改** |
| **第 3 层：回归** | `packages/workflow-engine` 全量；`apps/server` 全量 e2e（含 `failureRecovery.e2e.test.ts`）；再跑全仓 `pnpm -r run typecheck && lint && test` |
| **第 4 层：真实批次** | 下一批 E1×3（**验收载体**，不是本批） |

**A/B 实测（强制）**：探针三变体在修复前后的读数必须**逐条留档**（修复前 / 修复后各一份，**都保留**，与 N-10 / N-11 探针同一惯例）。

---

## 6. 边界与红线

- **不改**：`packages/eval` 的夹具 / oracle / `POLICY`（P0 冻结基线）/ L1-8 判据口径；L1 策略字段；`maxRetries` / `maxIterations` / `recursionLimitFor`；守卫；PL-M17 的 `@langchain/openai` 补丁；任何 `dist/`（除各包正常 `build` 产物）。
- **不新增**：包、顶层目录、第二套 Permission / Approval / Audit / Secret / 错误码。
- **不修改**历史 `tasks` / `agent_runs` / `workflow_events` 行。
- **不改写**冻结文档（`docs/99` / `docs/100`）的正文——只追加勘误块。
- **不弱化**：红灯检查、anti-tamper、写范围审计、守卫——四者一个都不许为了「让链走通」而放宽。
- **不放松**「真的救不回来就必须 FAILED」这一判定（§2.3 是本批的固定反向对照）。
- 共享谓词放 `packages/workflow-engine/src/`（**模块局部**）；跨包共享才放 `packages/shared`。
- 每个包改动跑 `corepack pnpm --filter @ai-se/<pkg> typecheck && lint && test`；阶段收尾前跑全仓。

---

## 7. 待裁定项（每条带推荐值）

| # | 待裁定 | 推荐值 |
| --- | --- | --- |
| 1 | 修法总原则 | **先探针定位再定点修**，不先猜再改（PL-M13 / M16 / M17 / M18 同一口径） |
| 2 | 探针形态 | **真实 `WorkflowEngine` + 忠实内存 store + 假 executor**，三变体 P0 / P1 / P2；**离线、确定性、零配额**；修复前后读数**都留档** |
| 3 | 修法 | **候选集限 (a) 传递式判定 + (b) 回写传播**；由探针在两者间定，**预期 (a)**（纯读侧、零状态写入）。**不做**：调 `maxRetries`、把 `BLOCKED`/`CANCELLED` 纳入传递、预写未来指针 |
| 4 | 两个消费点 | **`retry()` 与 `advanceOnce` 必须同源**，抽出共享谓词（`packages/workflow-engine/src/` 模块局部，新文件 `resolution.ts`）；同源关系**可机械验证**，不靠注释 |
| 5 | 深度上界 / 防环 | **不写死 2**（那是策略值）；用 **visited 集合**防环，不静默依赖「指针只向前」这条结构不变量 |
| 6 | 冻结文档的处置 | `docs/99` / `docs/100` **只追加勘误块，正文一字不改**（`docs/146` §6 规则 7）；**本项不是 CONTRACT CONFLICT**（代码与文档一致），是一次**语义更正** |
| 7 | 修完的批次安排 | **另开一批 E1×3**（新结果目录），**不续跑 l1-m4j**；**l1-m4j 记「已执行 3/3、staging 段 0/3」，三次 run 均不补跑** |
| 8 | §2.5 的四项观察 | **只登记、另行立项**；本批一条都不顺手修 |

---

## 8. 本批已发生的事实（供记账，非判据）

1. **用户 2026-10-19 说「立项 N-12」** ⇒ 本任务书成立，**里程碑 PL-M19**，缺陷编号 **N-12**（此前最高为 N-11）。
2. **N-12 是 L1-M4j 批次暴露的**，首次登记在 `docs/184` 的**勘误追加块**（2026-10-19）与 `docs/146` §3。登记时状态为「**未立项**」；本任务书把状态推进为「**已立项，待裁定**」；**2026-10-19 当日裁定并实施完成**（§9），实施记录 `docs/186`。
3. **L1-M4j 批次已收尾**：脚本 `packages/eval/scripts/l1-m4j-e1-x3.sh`、停机脚本 `l1-m4j-stop.sh`，结果目录 `packages/eval/results/l1-m4j`。**已执行 3/3、staging 段 0/3 ⇒ L1-8 仍未达成**。**本任务书不改动这条记账。**
4. **本任务书是立项动作**：**未改任何代码、未跑任何门禁、未跑任何探针**。全部事实来自库内实查与代码实查，命令与读数见 §2 各行。
5. **一处需要如实标注的期望管理**：修掉 N-12 **不会**让 L1-8 达标——run 1 / run 3 的死因是 `maxRetries` 预算耗尽（§2.3），与它无关。它的价值是**让记账正确**：现在会把「已经做完的工作」判成失败，且这个判定在 PL-M18 之后**落在默认路径上**。
6. **开工前三件事**（沿用既有口径）：① 确认周配额余量（当前 **274,208,057 / 400,000,000**，窗口 **2026-10-19 07:00 CST** 刷新）；② 先停 `:47558` 上的陈旧实例再重启（`l1-m4-server-launch.sh` 只要端口有应答就**静默复用**）；③ harness 后台任务 + **立即** arm 看门狗（`--heartbeat-min 30 --stall-min 25`），停机**必须** `POST /api/workflows/<id>/cancel`。

---

## 9. §7 裁定结果

**（2026-10-19，用户「**都按你的建议，开工 PL-M19**」——§7 八项全部按推荐值接受，并授权开工。）**

| # | 裁定 |
| --- | --- |
| 1 | **先探针定位再定点修**——不先猜再改 |
| 2 | **真实 `WorkflowEngine` + 忠实内存 store + 假 executor**，三变体 P0 / P1 / P2；离线、确定性、零配额；修复前后读数都留档 |
| 3 | **候选集限 (a) 传递式判定 + (b) 回写传播**；由探针在两者间定。**探针选定 (a)**——P1 在 (a) 下由 `FAILED` 翻为 `SUCCESS`，而 (b) 需要写已终结的任务行，无必要 |
| 4 | **`retry()` 与 `advanceOnce` 同源**，抽共享谓词（`packages/workflow-engine/src/resolution.ts`）；同源关系可机械验证 |
| 5 | **不写死 2**（那是策略值）；用 **visited 集合**防环 |
| 6 | `docs/99` / `docs/100` **只追加勘误块，正文一字不改**；**本项不是 CONTRACT CONFLICT**，是一次语义更正 |
| 7 | 修完**另开一批 E1×3**（新结果目录），**不续跑 l1-m4j** |
| 8 | §2.5 四项观察**只登记、另行立项** |

**实施记录**：`docs/186`。
