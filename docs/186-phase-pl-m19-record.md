# 186 · N-12（replan 的「已解决」只认一层）实施记录（PL-M19）

> 状态：**已实施**（2026-10-19）。用户裁定链：① 「**立项 N-12**」→ 任务书 `docs/185`；② 「**都按你的建议，开工 PL-M19**」→ §7 八项按推荐值接受（`docs/185` §9）。
> 依据：任务书 `docs/185`（含 §2 基线事实）、**一支探针**（`packages/workflow-engine/scripts/probe-n12-resolution-depth.ts`）、库内与代码实查。
> 性质：**本文件是实施结果正本**。**不新造验收编号**；判据 **19a–19g** 见 `docs/185` §3。

## Modified Files

| 文件 | 改动 |
| --- | --- |
| `packages/workflow-engine/src/resolution.ts` | **新增**。`isFailureResolved`（沿 `resolvedByTaskId` 链走到头）+ `unresolvedFailedTasks` + `hasUnresolvedFailure`，后者**构建在前者之上**，同源可机械验证 |
| `packages/workflow-engine/src/resolution.test.ts` | **新增**，**10 例**（单层 / 两层 / 三层 / 链尽头失败 / 断链 / 无指针 / 成环 / 解析者非 SUCCESS / 两个消费点同源） |
| `packages/workflow-engine/src/WorkflowEngine.ts` | 两处调用点改用共享谓词：`retry()` 的 `successful` 集合 + 过滤 → `unresolvedFailedTasks(tasks)`；`advanceOnce()` 的 `successfulIds` 集合 + `some(...)` → `hasUnresolvedFailure(tasks)`。**判定式本身只此一处** |
| `packages/workflow-engine/src/WorkflowEngine.test.ts` | **+4 例**（新增 describe「PL-M19（N-12）：第二层才救回来的失败也算已解决」）。既有用例**一字未改** |
| `packages/workflow-engine/scripts/probe-n12-resolution-depth.ts` | **新增**。真实 `WorkflowEngine` + 忠实内存 store + 计划驱动假 executor；P0 / P1 / P2 |
| `packages/eval/results/n12-probe/` `n12-probe-after/` | 探针读数（修复前 / 修复后各一份，**都保留**） |
| `docs/185-phase-pl-m19-taskbook.md` | 追加 §9 裁定结果 |
| `docs/99-failure-retry-taskbook.md` `docs/100-retry-failed-workflow.md` | **只追加勘误块**（正文一字未改，`docs/146` §6 规则 7） |

**未改动**：`maxRetries` / `maxIterations` / `recursionLimitFor`；L1 策略字段（`failureStrategy` / `allowReplan` / `allowRetry` / `deployFailureStrategy`）；`packages/eval/src/usageGuard.ts`（守卫）；`patches/@langchain__openai@1.5.11.patch`；`POLICY`（P0 冻结基线）；`packages/eval` 的夹具与 oracle；L1-8 判据口径；任何 `dist/`；任何历史 `tasks` / `agent_runs` / `workflow_events` 行；冻结文档的正文。

## Implementation

### 1. 根因（探针实测，判据 19a）

`WorkflowEngine.ts:532-538` 的终局判定要求 `FAILED` 任务的**直接** `resolvedByTaskId` 命中 `SUCCESS`，而 `replan()`（`:968`）只把源任务的指针指向**下一层**的 retry 任务。retry 任务自己也可能失败、再被重规划一层，于是链是

```
T-05:FAILED -> T-05-REPLAN-1:FAILED -> T-05-REPLAN-1-REPLAN-2:SUCCESS
```

中间节点自身 FAILED，**最上游那层永远「未解决」**。生产实证（工作流 `bb5f0610`，17 个任务 16 个 SUCCESS，`finished_at` 17:18:53 UTC 与 L1-M4j run 2 收尾逐秒吻合）与该链**逐字同形**。

该规则在 PL-M18 之前不可达（REPLAN 分支关着），是 PL-M18 把 REPLAN 变成 L1 默认失败响应才让它落在默认路径上。

### 2. 修法（裁定 3，探针在 (a)/(b) 间选定 (a)）

**传递式判定**：沿 `resolvedByTaskId` 链走到头，**尽头是 SUCCESS** 才算已解决。纯读侧、**零状态写入**。

```ts
export function isFailureResolved(task: Task, byId: ReadonlyMap<string, Task>): boolean {
  const seen = new Set<string>();
  let next = task.resolvedByTaskId;
  while (next && !seen.has(next)) {
    seen.add(next);
    const resolver = byId.get(next);
    if (!resolver) return false;
    if (resolver.status === "SUCCESS") return true;
    next = resolver.resolvedByTaskId;
  }
  return false;
}
```

- **不写死层数**（深度由策略 `maxRetries` 界定，那是会变的值）；**visited 集合防环**——结构上 `replan()` 只创建新任务、指针只向前，环不可能，但判定式不静默依赖这条不变量。
- **fail-closed**：断链（指针指向不存在的任务）与成环都判「未解决」。
- **为什么不做 (b) 回写传播**：那要**写已终结的任务行**，多一套并发面与写冲突可能；而解析链本可以在读侧算出来，无需落库。探针也确认 (a) 足以翻转。

### 3. 两个消费点同源（裁定 4）

改动前，同一谓词在 `retry()`（`:278-282`）与 `advanceOnce()`（`:532-538`）各写了一遍，只靠一行注释声明「同源」——**这正是 N-12 能悄悄长出来的土壤**。现在两处都调 `./resolution`：

| 调用点 | 改动 |
| --- | --- |
| `retry()` | `const successful = new Set(...)` + 过滤 → `unresolvedFailedTasks(tasks)` |
| `advanceOnce()` | `const successfulIds = new Set(...)` + `some(...)` → `hasUnresolvedFailure(tasks)` |

`hasUnresolvedFailure` 构建在 `unresolvedFailedTasks` 之上（`BLOCKED` / `CANCELLED` 仍一律算未解决），故两者**不可能再漂移**。

**判定式全仓只此一处**：`traceService.ts:231` 仅透传展示，`packages/failure-recovery` 无此逻辑，`apps/web` 无此字段。

### 4. A/B（同一支探针，修复前 / 修复后）

策略＝**已裁定的 L1 策略**（`failureStrategy: "REPLAN"`、`allowReplan: true`、`maxRetries: 2`）。

| 变体 | 形状 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| **P0** 单层抢救（对照） | `T-01` 失败 → `T-01-REPLAN-1` 成功 | `SUCCESS` / 3 尝试 | `SUCCESS` / 3 尝试（**未动**） |
| **P1** 第二层抢救（**生产形态**） | `T-01` 与 `T-01-REPLAN-1` 失败 → `-REPLAN-2` 成功 | **`FAILED`** / 5 尝试 | **`SUCCESS`** / 5 尝试 |
| **P2** 链尽头仍失败（**反向对照**） | 三层全失败 | `FAILED` / 5 尝试 | `FAILED` / 5 尝试（**未动**） |

修复后探针自报 `N12_REPRODUCED=false`；P0 与 P2 两个不变量都成立 ⇒ **红灯门未被放松**（判据 19c）。

### 5. 一处必须留档的教训：N-11 探针的 store 不忠实

`packages/workflow-engine/scripts/probe-n11-review-verdict-path.ts` 的 `MemoryStore.applyReplan` **把源任务置成 `SUCCESS`**，而真实实现（`packages/database/src/workflowRepositories.ts:821-824`）是

```sql
UPDATE tasks SET resolved_by_task_id = $2, failure_handled = true WHERE id = $1
```

——**源任务保持 FAILED**。（`WorkflowEngine.test.ts` 里的 store 是忠实的；探针那份不是。）

⇒ **N-11 探针对 N-12 结构性失明**：它把「救援成功」直接写在源任务状态上，于是永远看不到「指针只走一层」这条记账规则。它的结论（深度 1 的抢救 ⇒ `SUCCESS`）与生产**碰巧一致**，故当时没有被发现。

**本批的探针在这一点上忠实**（`applyReplan` 逐字复刻上述 SQL 语义），这是它能看到 N-12 的前提。**被简化掉的那一环，正是缺陷藏身处。**

## Architecture Changes

**无新增包、无新增顶层目录、无新增依赖。**

**一处需要登记的语义更正**（`docs/146` §6 规则 7 意义上）：**「失败已被解决」的判定由「直接指针命中 SUCCESS」更正为「沿解析链走到头是 SUCCESS」**。

- 这条旧语义**是写下来的**：`docs/99` §二.3（原文即「`FAILED && (!resolvedByTaskId || resolvedByTaskId 不是 SUCCESS)`」）与 `docs/100` §… 复述同一句。**代码与文档一致**，故**不是 CONTRACT CONFLICT**——是一次**对已写下的语义的更正**。
- 两份文档都是**历史记录（冻结，永不改写）**⇒ 只追加勘误块。
- **影响面**：只影响「解析链长 ≥ 2」的情形。链长 0（无指针）与链长 1（直接命中 SUCCESS / 直接命中 FAILED）的行为**逐字不变**。

**未破坏架构不变量**：未新增第二套 Permission / Approval / Audit / Secret / 错误码；Tool Runtime 仍是唯一执行路径。

## Dependencies

无新增运行时依赖。

## Tests

| 层（`docs/185` §5） | 内容 | 结果 |
| --- | --- | --- |
| **第 1 层：探针定位** | `probe-n12-resolution-depth.ts`（真实 `WorkflowEngine` + 忠实内存 store + 计划驱动假 executor），P0 / P1 / P2 | **完成**。**如实标注**：`scripts/` 不在 `tsconfig.include` 与 eslint 范围内，探针**未被门禁覆盖**（与既有八支探针同一惯例） |
| **第 2 层：单测** | `resolution.test.ts` **+10**；`WorkflowEngine.test.ts` **+4** | **完成**（各 +10 / +4）。**既有断言一字未改** |
| **第 3 层：回归** | `packages/workflow-engine` **62 用例 / 4 文件**（改动前 48 / 3）；`apps/server` **288 用例 / 50 文件**；全仓 `-r` | **全绿**（`apps/server` 单独跑 288/288，在改动已就位的情况下） |
| **第 4 层：真实批次** | 下一批 E1×3 | **未做**（见 Next Phase Boundary） |
| 共享夹具核对 | 全树 grep `resolvedByTaskId` 的消费方 | **完成**：判定式仅两处（已合并）；`traceService.ts:231` 透传展示；`packages/failure-recovery` / `apps/web` 无 |
| 门禁 | 各包的 `typecheck && lint && test` | **全绿**（见下） |

## Lint

- `--filter @ai-se/workflow-engine` / `@ai-se/server` 各自 `lint` → 通过
- 全仓 `corepack pnpm -r run lint` → **通过**（exit 0）

## Typecheck

- 上述两个包各自 `typecheck` → 通过
- 全仓 `corepack pnpm -r run typecheck` → **通过**（exit 0）

## E2E

全仓 `corepack pnpm -r run test` 跑了**两次**，各 **2 处 `apps/server` e2e 失败**，**两次是不同的一对文件**：

| 次 | 失败文件 | 单独复跑 |
| --- | --- | --- |
| 第 1 次 | `failureRecovery.e2e.test.ts`（CANCELLED 用例）、`v1GoldenScenario.e2e.test.ts`（重启恢复用例） | **10/10 通过**、**4/4 通过** |
| 第 2 次 | `agentRunPersistence.e2e.test.ts`、`uiStateValidation.e2e.test.ts` | **4/4 通过**（两个文件合跑） |

**判定为负载偶发，不是本批回归**，依据（实测，不是推断）：

1. **`apps/server` 单独跑 288/288 全绿**——且这是**在本批改动已就位之后**跑的；
2. **两次全仓跑的失败文件完全不同**（数量相同、身份不同），这正是 `docs/127` §8 记录的特征；
3. **四个文件单独复跑全部通过**；
4. **机制上不可能**：新判定与旧判定只在**解析链长 ≥ 2** 时不同；这四条用例都不产生 replan 链（`failureRecovery` 那条是 CANCELLED → `strategy: FAIL` 的路径）；
5. `failureRecovery.e2e` 的 CANCELLED 用例与 `v1GoldenScenario` 的重启用例**在本批之前即被记录为抖动**（`docs/145` #7、`docs/153`、`docs/127` §8）。

**本批未据此改动任何测试**（不掩盖、不放宽断言）。

## Known Issues

1. **修的是记账，不是救援能力**：N-12 的修复**不会**让 L1-8 达标。L1-M4j 的 run 1 / run 3 死于 `maxRetries` 预算耗尽（`T-08-REPLAN-1-REPLAN-2` 自身 FAILED、无解析者）——那是**正确**判定，本批**未动**。它的价值是**让记账正确**。
2. **判定改了，数据没改**：历史 `tasks.resolved_by_task_id` 指针**不回写**；已判 FAILED 的历史工作流**不重判**（不修改历史行）。
3. **`docs/99` / `docs/100` 的正文仍写着旧语义**——只追加了勘误块。读那两份文档时须连带读勘误块。
4. **深度上界依赖策略 `maxRetries`**：本批不写死层数，故策略若被调大，判定自动跟随；visited 集合保证成环不会挂死。
5. **N-12 的修复未在真实批次验证**——探针用的是假 executor。真实链路要等下一批 E1×3。
6. **N-11 探针的 store 不忠实**（见 Implementation §5）——已留档；**未**回头修那支探针（它属 PL-M18 的历史产物，改它要另立议题）。
7. **四项观察维持登记**：BACKEND 的 `checks failed: test`（L1-M4j 唯一反复出现的致败类型，5 次）、`EMPTY_FINAL_ANSWER`、`INVALID_AGENT_RESULT`（于 `T-S4-R1`，已自愈）、三处「工作类型」概念。本批**一条都没顺手修**。
8. **探针在门禁之外**（`scripts/` 不在 `tsconfig.include` 与 eslint 范围）。改动探针后必须手工跑一次。

## Acceptance Result

按 `docs/185` §3 逐条判定：

| 判据 | 期望 | 结果 |
| --- | --- | --- |
| **19a** | N-12 的产生点被指认（实测，非推断），逐条列出非 SUCCESS 行及解析者状态 | **达成**——生产 `bb5f0610` 的 `T-05` / `T-05-REPLAN-1` / `T-05-REPLAN-1-REPLAN-2` 三行逐条查证；`finished_at` 与 run 2 收尾逐秒吻合 |
| **19b** | 探针复现 N-12，且能**分别**复现两种子情形 | **达成**——P1 修复前 `FAILED`（链与生产**逐字同形**）；P2 独立复现「链尽头失败」 |
| **19c** | 修复后①转绿，②仍判 FAILED，`BLOCKED`/`CANCELLED` 判定不变 | **达成**——P1 `FAILED` → `SUCCESS`；**P2 仍 `FAILED`**；P0 未动；`resolution.test.ts` 直测 `BLOCKED`/`CANCELLED` 解析者不算已解决 |
| **19d** | 两个消费点同源，且**可机械验证** | **达成**——两处都调 `./resolution`；`hasUnresolvedFailure` 构建在 `unresolvedFailedTasks` 之上，同源由**代码结构**保证，不靠注释 |
| **19e** | 既有断言逐字不变且全绿 | **达成**——`WorkflowEngine.test.ts` 既有 **48** 例一字未改（改后 62 = 48 + 14）；`failureRecovery.e2e.test.ts:876` 那条「replan 写指针」断言未动且单独复跑通过 |
| **19f** | 不引入语义漂移 | **达成**——`maxRetries` / `maxIterations` / `recursionLimitFor` / L1 策略字段 / 守卫 / PL-M17 补丁 / `POLICY` / L1-8 口径均未动 |
| **19g** | 若为上游产物质量、平台无可修点 → 不阻塞 | **不适用**——产生点在平台侧记账谓词上，**已修** |

**⇒ 19a–19f 达成；19g 不适用。**

**红线核对**：N-6 / N-8 / N-9 本批**未触碰相关代码**；红灯检查 / anti-tamper / 写范围审计 / 守卫**四者一个都没弱化**（P2 反向对照即为证据）；**未修改**任何历史 `tasks` / `agent_runs` / `workflow_events` 行；**未改写**冻结文档正文。

**另需如实标注**：**本批的修复尚未在真实批次验证**。真正的检验是下一批 E1×3。

## Next Phase Boundary

**未开始事项（STOP）**：

- **未跑真实批次**。判据 19 的「第 4 层」未取证据。开工前三件事不变：① 确认周配额余量（窗口 **2026-10-19 07:00 CST** 刷新）；② 先停 `:47558` 上的陈旧实例再重启（`l1-m4-server-launch.sh` 只要端口有应答就**静默复用**）——**本批改了 `workflow-engine`，`:47558` 上现载的实例已陈旧**；③ harness 后台任务 + **立即** arm 看门狗（`--heartbeat-min 30 --stall-min 25`），停机**必须** `POST /api/workflows/<id>/cancel`。
- **下一批的批次形态**：**另开一批 E1×3**（新结果目录），**不续跑 l1-m4j**。**l1-m4j 记「已执行 3/3、staging 段 0/3」，三次 run 均不补跑。**
- **下一批的头号观察项**：① **BACKEND 的 `checks failed: test`**（L1-M4j 唯一反复出现的致败类型）；② **`maxRetries` 预算耗尽**是否仍是主要致死点（run 1 / run 3 的死因，本批未动）；③ N-12 的修复在真实链路是否生效（第二层抢救是否真的转绿）；④ `EMPTY_FINAL_ANSWER` 频率。
- **未做**：未合并三处「工作类型」概念；未改 `parseAcResults` 的 FR/TR 解析；未追查 `EMPTY_FINAL_ANSWER` 与 `INVALID_AGENT_RESULT`；未回头修 N-11 探针的不忠实 store（Known Issues 6）。
- **未裁定**：便宜档探针的形态 / 频率（自 `docs/177` 挂起）；`T-DESIGN-S1` 计划粒度。
- **不变量**：不改 `packages/eval` 的夹具与 oracle；不改 `POLICY`（P0 冻结基线）；不改 L1-8 判据口径；不修改任何 `dist/`（除各包正常 `build` 产物）；不修改历史 `tasks` / `agent_runs` / `workflow_events` 行；不改写冻结文档正文。
- 收口时同步登记账：`docs/185`（§9 裁定链）、`docs/146` §3 / §4 / §5、`docs/127` §0、`docs/99` 与 `docs/100` 的勘误块。

## 全仓门禁补记

- `corepack pnpm -r run typecheck` → **exit 0**
- `corepack pnpm -r run lint` → **exit 0**
- `corepack pnpm -r run test` → 跑了两次，各 **2 处 `apps/server` e2e 偶发失败**（详见上节：两次文件不同、四个文件单独复跑全通过、`apps/server` 单独跑 288/288 全绿、机制上不经过本批改动的路径）。**未据此改动任何测试。**
