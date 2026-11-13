# 200 · N-23（重规划把交付任务的**类型**换掉，`input.delivery` 契约随之作废）任务书（PL-M25 第二件）

> 立项：2026-10-20。发现场：L1-M4n run 3（`ce294d85`），**该批实际致败点**。
> 性质：**实现前设计**（`docs/146` §6 规则 7 允许的第三类文档）。
> **本文件不实施任何代码改动**；实施在下一阶段，且**须等 L1-M4n 批次跑完**。
> 姊妹件：`docs/199`（N-22：`REPLAN` 结果没有结构化通道）。**两者同批修，缺一不可**（§6）。

---

## 0. 为什么现在做这一批

**这是 L1-M4n run 3 的真实死因，且是 PL-M18 的溢出。**

PL-M18（N-11）为避免「REVIEW 的 replan 又是一个 REVIEW、负结论必然重现」，
把 `debugTargetType` 的第 3 步兜底从 `source.type` 改成 `workType`
（`WorkflowEngine.ts:77` / `:989`，注释明写「retry 任务改取**解析后的目标工作类型**，不再继承源任务类型」）。

**那个理由是 REVIEW 特有的**——REVIEW 的 type 不承载平台行为，它只是一个「谁来做」的标签。
但 **BUILD / DEPLOY / TEST 的 type 不是标签，是平台契约**：
`DeliveryOrchestrator.canHandle` 就是按 `task.type` 分派的（`deploymentOrchestrator.ts:76-84`）。
把交付任务的 type 换成工作类型，等于**把契约悄悄作废**，而任务照跑、还能报 SUCCESS。

⇒ run 3 因此走到了 E1 链史上**最深的一步**（第一次真正执行部署任务），
然后在「CI 发布不存在」上死掉——**死因是上游两个任务之前被换掉类型**。

---

## 1. 范围与排除

**在范围内**

- `debugTargetType` 第 3 步对**交付任务类型**（BUILD / DEPLOY / TEST）的处置。
- 交付契约 `input.delivery` 在 replan 后的**有效性**。
- 该失败的**可归因性**：`CI_RELEASE_NOT_FOUND` 已存在，却没有落到任务的 `errorType`。

**明确排除**

| 排除项 | 理由 |
| --- | --- |
| N-22（`REPLAN` 结果无结构化通道） | 姊妹件，**同批修**（`docs/199`）；本文件不重复 |
| `T7` 那条过期断言本身 | 那是**真实的 CI 红灯**（`src/bearer-auth-middleware.test.js:333` 在 run 2 的工作区里过期了）；本文件不碰测试内容 |
| `docs/` 写范围（第六例） | 另立项 |
| REVIEW / DESIGN / ANALYSIS 的 replan | **PL-M18 对它们是对的**，不动（§4 的判据 26e 是它的不回归护栏） |
| ROLLBACK 路径 | `WorkflowEngine.ts:866` 的 ROLLBACK 分支自带 `DeliveryTaskSchema.safeParse` 守卫，本次不动 |
| 历史任务记录回填 | `docs/146` §6 规则 7 |

---

## 2. 基线事实（实测）

### 2.1 机制：三个代码锚点

**(1) 工作类型只有三个** —— `packages/shared/src/index.ts:519`

```ts
export const WORK_TASK_TYPES: readonly TaskType[] = ["BACKEND", "FRONTEND", "DATABASE"];
export function isWorkTaskType(value: unknown): value is TaskType { … }   // :521
```

**BUILD / DEPLOY / TEST / REVIEW / DESIGN / ANALYSIS 全都不在其中。**

**(2) 第 3 步于是对交付任务必然落到 `workType`** —— `packages/workflow-engine/src/WorkflowEngine.ts:63-78`

```ts
return { type: isWorkTaskType(source.type) ? source.type : workType, rejectedFixTaskType };  // :77
```

对 `source.type === "BUILD"`：`isWorkTaskType("BUILD")` = **false** ⇒ 返回 `workType`
（由 `fixWorkTargetType` 取切片里出现最多的工作类型 ⇒ 实测为 **BACKEND**）。

**(3) 该类型直接成为重试任务的 `type`** —— `WorkflowEngine.ts:989`

```ts
// PL-M18（N-11）：retry 任务改取**解析后的目标工作类型**，不再继承源任务类型——
// 否则 REVIEW 的 replan 就是一个新的 REVIEW，负结论必然重现。
type: target.type,
```

**而 `input` 是继承的**（`:991` `input: { ...source.input, executionAttempt: attempt }`）
⇒ `input.delivery` **还在**，只是**没人再读它**。

### 2.2 契约是按 `task.type` 分派的 —— `apps/server/src/services/deploymentOrchestrator.ts:76-84`

```ts
canHandle(task: Task): boolean {
  const delivery = DeliveryTaskSchema.safeParse(task.input.delivery);
  return (
    delivery.success &&
    ((task.type === "BUILD"  && delivery.data.action === "CI") ||
     (task.type === "DEPLOY" && ["DEPLOY","ROLLBACK"].includes(delivery.data.action)) ||
     (task.type === "TEST"   && delivery.data.action === "VERIFY"))
  );
}
```

`delivery` 解析成功**不够**——`task.type` 必须同时匹配。
type 一旦被换成 BACKEND，`canHandle` 恒 false，任务落到 `professional-deep-agent`。

### 2.3 复现证据（L1-M4n run 3，workflow `ce294d85`）

**`T7`（CI 门）失败**：一条过期断言（与 run 2 同类）。平台记录：

| 任务 | type | `input.delivery` | `agent_runs.input.runtime` |
| --- | --- | --- | --- |
| `T7` | **BUILD** | `{"action":"CI","workflowFile":".github/workflows/ci.yml"}` | **`delivery-orchestrator`** |
| `T7-REPLAN-1` | **BACKEND** | `{"action":"CI","workflowFile":".github/workflows/ci.yml"}` | **`professional-deep-agent`** |

`T7-REPLAN-1` 由 **backend-agent** 执行（不是 DeliveryOrchestrator），
它的 `summary` 自报：`node --test` **exits 0 with 219 test marks and 0 failures** ⇒ **`outcome: SUCCESS`**。

**它没有写下任何 `ci_runs` 记录。** 该工作流全库只有一条：

```
ci_runs: c1cc39be  workflow=ce294d85  task=T7  status=FAILED  14:47:27Z
```

**`T8`（DEPLOY）随即失败**：

```
T8  DEPLOY  FAILED  errorType=(none)  error="No successful CI release found"
```

`T8` **没有 agent run**——`runDeployment` 在 agent 之前就返回了：

```ts
const ci = await this.dependencies.deployments.findLatestSuccessfulCi(workflow.id);   // :392
if (!ci?.image || !ci.gitCommit) {
  return { status: "failed", error: apiError("CI_RELEASE_NOT_FOUND", "No successful CI release found") };
}
```

`findLatestSuccessfulCi`（`packages/database/src/deploymentRepository.ts:261-269`）
按 `workflow_run_id` 查 `ci_runs WHERE status='SUCCESS'` ⇒ **查不到**。

**排除「别的任务本该提供 CI 记录」**：该工作流的 BUILD 任务共三个——
`T1` / `T4` 都 SUCCESS 但 **`input.delivery` 不存在**（普通构建，非 CI），`T7` 是唯一 CI 任务。
⇒ 记录缺失**完全**由 `T7-REPLAN-1` 的类型被换掉造成。

**同形第二次**：`T8`（DEPLOY，`delivery.action = DEPLOY`）的 replan 产出
**`T8-REPLAN-1`（BACKEND）**，`input.delivery` 仍在、type 已换 ⇒ 同一个缺陷的第二个实例，
它同样永远无法部署。

**终局**：`T9`（REVIEW）、`T10`（DEPLOY）一直 **PENDING** ⇒ 工作流判死 ⇒
**staging 段根本未被尝试**。

### 2.4 为什么这是 PL-M18 的溢出，不是「本来就这样」

PL-M18 之前，第 3 步是 `source.type` ⇒ BUILD 的 replan 仍是 **BUILD** ⇒ 契约保得住。
PL-M18 的**理由**（REVIEW → REVIEW 无出路）**只对不承载平台行为的类型成立**。
它对 REVIEW 是对的，对 BUILD/DEPLOY/TEST 是**过界**。

**这一批是它第一次被行使**：L1-M4m run 2 的交付段（CI + staging DEPLOY + staging VERIFY）全绿，
没有交付任务需要 replan；L1-M4n 是第一次有交付任务**失败并被 replan**。

### 2.5 普遍度普查（全库，只读）

```sql
SELECT t.type, t.input->'delivery'->>'action' AS action, t.status, count(*)
FROM tasks t
WHERE t.input ? 'delivery' AND t.type NOT IN ('BUILD','DEPLOY','TEST')
GROUP BY 1,2,3 ORDER BY 4 DESC;
```

| task_key | type | action | status | 日期 |
| --- | --- | --- | --- | --- |
| `T7-REPLAN-1` | **BACKEND** | **CI** | FAILED | 10-20（run 2） |
| `T7-REPLAN-1-REPLAN-2` | **BACKEND** | **CI** | PENDING | 10-20（run 2） |
| `T7-REPLAN-1` | **BACKEND** | **CI** | **SUCCESS** | 10-20（run 3） |
| `T8-REPLAN-1` | **BACKEND** | **DEPLOY** | RUNNING | 10-20（run 3） |

⇒ **本缺陷的实例共 4 个，全部落在 L1-M4n 一个批次内**，且**全是 `BACKEND` 扛着 `CI`/`DEPLOY` 契约**。
与 §2.4 一致：L1-M4m 的交付段全绿、没有交付任务需要 replan；L1-M4n 是第一次有交付任务失败。

**一个必须与本条分开的既有形状**：`T-17`（10-19，REVIEW + VERIFY，一 PENDING 一 SUCCESS）与
`T9`（10-20，REVIEW + VERIFY，3 行）。它们**不是 replan 产物**（键里没有 `-REPLAN-`），
type 也不是被换掉的——是**规划侧**把 VERIFY 交付挂在了 REVIEW 任务上。
**不属本条**，也不在本次范围内；仅记录，供后续普查时分辨（否则本表的 9 行会被误读成 9 个实例）。

### 2.7 下游级联：run 3 交付段的整条失败都追溯到本条

`T9`（REVIEW，`delivery.action=VERIFY`）由 `reviewer-agent` 判 **`FAILED`／not approved**。
**它的负结论是正确的**——它审的是**一次根本没发生的 staging 部署**：

> "What blocks: **this environment has no Docker daemon**, so no image was built and no live
> staging probe … was executed"

**对照组（L1-M4m run 2 的 `716eb98d`，同位置同形状）**：

| | L1-M4m `716eb98d` | L1-M4n run 3 `ce294d85` |
| --- | --- | --- |
| CI（BUILD+CI） | `T-15` **SUCCESS** | `T7` **FAILED** → replan 成 BACKEND |
| staging DEPLOY | `T-16` **SUCCESS**（endpoint `:18080`，`/ready=200`） | `T8` **FAILED**（`CI_RELEASE_NOT_FOUND`） |
| REVIEW | `T-17` **SUCCESS**（approved） | `T9` **FAILED**（not approved） |
| 下一 DEPLOY | `T-18` `WAITING_APPROVAL`（走到生产关口） | `T10` **PENDING**（没走到） |

L1-M4m 的 `T-17` **明确承认同一局限却不当作阻断**：

> "**the residual gap is that some staging container-level evidence (uid/restart/log scan) exists
> only as static contract tests and is not recorded in the deploy artifact.**"

⇒ **差异不在能力，在有没有东西可审。** L1-M4m 有真实 staging 部署可依；run 3 没有（`T8` 已死）。
⇒ **run 3 交付段（`T8` → `T9` → `T10`）的整条失败可完整追溯到本条**：
`T7` 的 CI 记录缺失是**唯一**的上游因，其余全是它的下游后果。
**这不是 N-11（评审标准/负结论无出路）**——那条在本批**没有**被行使：`T9` 的负结论是对的。

### 2.8 一处附带的记账缺口

`CI_RELEASE_NOT_FOUND` 这个错误码**是存在的**（`deploymentOrchestrator.ts:396`），
但 `T8` 的 `output.errorType` 是**空**。⇒ 该失败在批次归因里**看不见**。
（与 `docs/199` §2.1 锚点 4 是同一族的可归因性问题，但**位置不同**，故另列判据。）

---

## 3. 判据（26a–26f）

| # | 判据 | 判法 |
| --- | --- | --- |
| **26a** | `debugTargetType` 第 3 步对 **BUILD / DEPLOY / TEST** 返回 `source.type` 本身 | 单测：三种类型各断言 target === source.type |
| **26b** | **REVIEW / DESIGN / ANALYSIS** 的 replan 行为**不变**（仍落到工作类型） | 单测：`source.type="REVIEW"` ⇒ target 仍是工作类型（PL-M18 不回归） |
| **26c** | replan 出的交付任务**仍被 `DeliveryOrchestrator` 接管** | 单测：`canHandle(replannedTask)` === true |
| **26d** | **正控**：一个失败的 CI 任务 replan 后，其重试任务**写下 `ci_runs` 记录** | 真实批次：`ci_runs` 里出现该 replan 任务的 `SUCCESS` 行 |
| **26e** | **负控**：工作类任务（BACKEND/FRONTEND/DATABASE）的 replan 行为**不变** | 单测：PL-M18 的既有断言全绿 |
| **26f** | 交付前置失败（`CI_RELEASE_NOT_FOUND` 等）落到任务 `errorType` | 库内：该形状的失败任务 `output.errorType` **非空** |

**判据 26d 是这一批的目的**：让 run 3 那条链下一次能把 staging 段跑起来。

---

## 4. 设计裁定（推荐）

**推荐：一处判定 + 一处可归因，全部在同一批内完成。**

| # | 位置 | 改动 | 为什么 |
| --- | --- | --- | --- |
| ① | `packages/workflow-engine/src/WorkflowEngine.ts:77` | 第 3 步改为：**先判「是不是交付任务类型」**（`BUILD`/`DEPLOY`/`TEST`），是则**原样返回**；否则维持 PL-M18 的 `workType` 兜底 | 交付任务的 type 是平台契约，不是标签 |
| ② | `apps/server/src/services/workflowTaskExecutor.ts` | 交付前置失败的 `errorType` 落到任务输出 | 让这类失败在批次归因里可见（26f） |

**为什么不改成「按 `input.delivery` 的存在与否判定」**：
`input.delivery` 在 replan 后**仍在**（§2.1 锚点 3），所以用它当判据**分不出**「交付任务」与
「被换掉类型的交付任务」——正是缺陷本身。判据必须来自**未被污染的字段**（`source.type`）。

**为什么不干脆让 `canHandle` 也认 `input.delivery`**：
那会让一个 type 是 BACKEND 的任务去做部署——把「类型」和「契约」两套语义混起来，
且 `DeliveryOrchestrator` 之外还有按 type 分派的地方（如 `taskVerifierRules` 的 `effectiveCheckType`）。
**修在源头（类型不被换掉），而不是修在下游的每个读取点。**

**交付任务类型常量放哪**：`packages/shared/src/index.ts` 已导出 `WORK_TASK_TYPES`
（`:519`）⇒ 同处新增 `DELIVERY_TASK_TYPES: readonly TaskType[] = ["BUILD","DEPLOY","TEST"]`
与 `isDeliveryTaskType`，**跨包共享类型归 `packages/shared`**（`AGENTS.md` §3）。

---

## 5. 验证分层

**第 1 层 · 单测（必做，不需配额）**

- `debugTargetType`（26a/26b/26e）：BUILD/DEPLOY/TEST ⇒ 原样；REVIEW/DESIGN/ANALYSIS ⇒ 工作类型；
  BACKEND/FRONTEND/DATABASE ⇒ 原样。
- `DeliveryOrchestrator.canHandle`（26c）：对 replan 出的 BUILD+CI 任务返回 true。
- `workflowTaskExecutor`（26f）：`CI_RELEASE_NOT_FOUND` ⇒ 任务 `output.errorType` 非空。
- **不回归**：PL-M18 的既有单测全绿（`fixWorkTargetType` 未改）。

**第 2 层 · 包级门禁**

`corepack pnpm --filter @ai-se/workflow-engine typecheck && lint && test`
`corepack pnpm --filter @ai-se/shared …`、`corepack pnpm --filter @ai-se/server …`

**第 3 层 · 真实批次（下一批）**

- **主判据（26d）**：CI 任务失败 → replan 后重试任务**写下 `ci_runs`**，
  `T8` 那类 DEPLOY 不再报 `CI_RELEASE_NOT_FOUND`。
- **推进读数**：链第一次跨过 `T8`/`T10` ⇒ **staging 段被尝试**（L1-8 的实质门槛）。
- **不回归**：`scopeViolations = 0`、N-6/7/8/9/10 缺席、N-12 未被行使、`docs/199` 的 25g。

---

## 6. 边界与红线

- **不改** `fixWorkTargetType`（PL-M18 的正身）——只改第 3 步的**前置判定**。
- **不改** `canHandle` 的分派语义（下游读取点不动）。
- **不新增**错误码体系：`CI_RELEASE_NOT_FOUND` 已存在，本次只是把它**落到任务上**（`AGENTS.md` §10）。
- **不碰** `T7` 那条过期断言的内容——它是真实的 CI 红灯，修不修是 agent 的事。
- **历史任务记录不回填**（`docs/146` §6 规则 7）。
- **与 `docs/199` 同批实施**：N-22 修好但 N-23 不修 ⇒ 交付任务仍被换类型；
  N-23 修好但 N-22 不修 ⇒ 工作类任务报 `REPLAN` 仍无处可去。**两者必须一起。**
  **⚠️ 但「一起修」不等于「run 2 那条链就会收敛」**——见 §7.1，那个形状还需要一次「两步修复」，
  是第三个问题，**本次不立项**。

---

## 7. 待裁定项（每条带推荐值）

| # | 待裁定 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | 交付任务类型常量放 `packages/shared` 还是 `workflow-engine` 内 | **`packages/shared`** | 跨包共享类型归 shared（`AGENTS.md` §3）；`WORK_TASK_TYPES` 已在那儿 |
| 2 | `TEST` 是否算交付任务类型 | **算** | `canHandle` 认 `TEST + VERIFY`（`deploymentOrchestrator.ts:82`）；换掉 type 同样作废 VERIFY 契约 |
| 3 | 是否顺带让 `T8` 的失败**带 agent run**（当前无 run，批次里看不见） | **不做** | 那是 `runDeployment` 的前置返回路径，属可观测性改造，与本条无耦合；26f 已覆盖归因 |
| 4 | 是否同时加「交付任务 replan 上限」守卫 | **不加** | 同 `docs/199` §7 第 1 项：**先修路由，再普查是否还循环**（[[verdict-rules-need-a-census]]） |
| 5 | **交付任务失败时，agent 的 `fixTaskType`（`docs/199`）与「保留交付类型」（本条）谁优先** | **agent 的显式请求优先**：交付类型短路放在**第 3 步之前、第 1 步之后** | 〔**2026-10-21 实施时更正**：本项初稿写「本条优先」，**实施时改为 agent 优先**。理由：若交付类型覆盖 agent 的显式 `fixTaskType`，**N-22 刚开的通道会被本条立刻无视**——两个修复互相打架。放在第 1 步之后，本条的保证范围是「**agent 没说话时保留契约**」，正是两个实例的形状（`T7-REPLAN-1` / `T8-REPLAN-1` 的 `fixTaskType` 都是空）。**已知代价**：agent 若为一个 CI 任务指定 `TEST`，交付契约仍会被放弃——那是 §7.1 的「两步修复」问题，**本批不解决**〕 |

### 7.1 一个必须说清的交互（不解决，只登记）

**N-22 与本条在「CI 任务因过期测试失败」这个形状上会互相拉扯**，两件一起修**仍不足以**让 run 2 那条链收敛：

| 方案 | retry 的 type | 结果 |
| --- | --- | --- |
| 只修本条 | **BUILD/CI** | CI 重新跑一次，但测试**仍是过期的** ⇒ 再失败 ⇒ 再 replan ⇒ 预算耗尽 |
| 只修 N-22 | **TEST**（听 agent 的） | 测试被改对了，但 **CI 从未重跑** ⇒ `ci_runs` 仍无成功行 ⇒ `T8` 依旧 `CI_RELEASE_NOT_FOUND` |

⇒ **该形状需要一次「两步修复」（先改测试、再重跑 CI），而 `replan()` 只造一个 retry 任务。**
这是**独立于本条与 N-22 的第三个问题**，**本次不立项、不实施**，仅在此登记（按
[[defect-registration-needs-code-proof]]，机制已由本表两列说清，但**修法未设计**）。

**本条对 run 3 的效果不受此影响**：run 3 的测试**不过期**（`T7-REPLAN-1` 自报 219 个测试 0 失败），
所以「保留 BUILD/CI ⇒ `runCi` 真跑 ⇒ 写下 `ci_runs` SUCCESS 行 ⇒ `T8` 可继续」是成立的。
**本条能救的是 run 3 那类链，不是 run 2 那类链。** 这一点不得在批次报告里含糊。

### 7.2 一个被核查并**否定**的邻接假设（2026-10-21，**不登记为缺陷**）

**本条让交付类型被保留，会自然引出这个问题**：`TASK_AGENT_TYPES`
（`AgentRegistry.ts:269-278`）里**只有 `BUILD→DEVOPS`、`TEST→QA`，没有 `DEPLOY`**
⇒ 失败 DEPLOY 的 replan 会造出 `targetTaskType="DEPLOY"` 的 `-DEBUG-` 任务
（`WorkflowEngine.ts:1000`），而 `AgentRegistry.resolveTask`（`:338-352`）按它查
`TASK_AGENT_TYPES` 落空 ⇒ **抛「No professional agent for DEBUG task」**。
**看起来是本条修复引入的新故障模式。**

**核查结论：这条路径走不到，假设不成立。** 两条证据：

1. **失败 DEPLOY 进不了 `replan()`**：`deployFailureStrategy` **优先于**通用 `failureStrategy`
   （`WorkflowEngine.ts:826-832`）——`task.type === "DEPLOY" && policy.deployFailureStrategy ===
   "ROLLBACK"` 时 `strategy` **被无条件改写为 `ROLLBACK`**（连 `routed?.strategy` 都被压过），
   于是走的是**回滚分支**（`:895-899`），**`replan()` 根本不执行**。L1 策略正是
   `deployFailureStrategy: "ROLLBACK"`（`packages/shared/src/index.ts:904`）。
2. **`debugTargetType` 全仓只有一个调用点**：`WorkflowEngine.ts:981`，就在 `replan()` 内
   ⇒ 该形状**没有第二条产生路径**。

**为什么仍然写下来**（[[defect-registration-needs-code-proof]] 的正向用法）：
这是「**库内形状成立 ≠ 实例里被走到**」的典型——**只差 `:832` 那一行**，结论就会从
「不成立」翻成「真缺陷」。**未来若有人去掉该策略声明、或新增一个不带 `deployFailureStrategy`
的策略，本条会立刻生效。** 届时的修法方向：`-DEBUG-` 的 `targetTaskType` 是**派发键**
（须有承接 agent），而 retry 的 `type` 是**契约键**（须保住 `input.delivery`）——
两者对交付类型的要求相反，`replan()` 目前用同一个 `target.type` 同时喂给两者。

---

## 8. 本批已发生的事实（供记账，非判据）

- **L1-M4n run 3**（`ce294d85`）**走到了 E1 链史上最深的一步**：第一次真正执行交付任务
  （`T8` DEPLOY 已 RUN 并判失败，而非停在 PENDING）。死因是 §2.3 的链。
- **`T7-REPLAN-1` 的 `SUCCESS` 是一次「契约已作废的成功」**：agent 确实把沙箱里能跑的都跑绿了
  （219 个测试 0 失败），但任务的 `input.delivery` 要求的是 CI，而 CI 记录没产生。
  ⇒ **任务成功 ≠ 任务目的达成**；这条对批次记账有意义，故记此。
- 该工作流 `ci_runs` 共 **1** 条（`T7`，FAILED）；`deployments` 共 **0** 行。
- 本批 `ci_runs` 共 **2** 条，**两条都是 `T7` FAILED**（run 2 的 `a85a6970` 与 run 3 的 `ce294d85`）。
