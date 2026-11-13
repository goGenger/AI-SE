# 199 · N-22（`REPLAN` 是声明过的一等结果，路由却只认 `fixTaskType`）任务书（PL-M25）

> 立项：2026-10-20。发现场：L1-M4n 批次（run 2 致败、run 3 复现）。
> 性质：**实现前设计**（`docs/146` §6 规则 7 允许的第三类文档）。
> **本文件不实施任何代码改动**；实施在下一阶段，且**须等 L1-M4n 批次跑完**（否则 run 3 与 run 1/2 跑在不同平台版本上）。
> 前身：`docs/196`（「replan 不收敛」登记机制不成立）——本文件**不是**翻案，是它 §8 第 1 条**自设触发条件**的兑现。

---

## 0. 为什么现在做这一批

三条独立理由同时成立，缺一条都该继续等：

1. **`docs/196` §8 第 1 条自己写下了触发条件**：

   > 「N-13 修复后（PL-M24 (1)）重跑一批，再普查同样的 13 条形状。若仍不收敛，
   > **那才是新的、未解释的缺陷**，届时须重新立项。」

   本批（L1-M4n）PL-M24 (1) **已确认修好**（§2.3），而链**仍然不收敛**（§2.2）。
   触发条件已满足，且是 `docs/196` 自己预设的判定路径。

2. **`docs/196` §8 第 3 条预先留了候选，当时因「库内没有一条实例把它证成致败点」而不登记**：

   > 「`backend-agent.writePaths` … **不含 `test`/`tests`，也没有 `writeTestFiles`**；
   > 而 `qa-agent` 有 `writeTestFiles: true` 且被要求「report … a **fixTaskType**」。
   > ⇒ 一条 **QA 失败、修法落在测试文件**的链，会被路由到**写不了测试文件**的 agent。
   > **但库内没有一条实例把它证成致败点**——按 [[defect-registration-needs-code-proof]]，
   > **不登记**，只留此条备查；下一批复核时一并看。」

   **本批有两个实例**（run 2 致败、run 3 复现），且都不是 QA 失败——是 **BACKEND 被自己的只读约束卡住**，
   与候选同族但**方向相反**（候选说「QA 的活被派给 BACKEND」，实测是「BACKEND 干不了的活派给 BACKEND」）。
   该候选按 `docs/196` 的原话「下一批复核时一并看」——本文件即该复核。

3. **记忆 [[fix-known-defects-before-batches]]**：花配额前必须清掉所有已知缺陷。
   本批已经用两个 run 换到同一堵墙的两次复现；**再开一批只会买到第三次复现**。

---

## 1. 范围与排除

**在范围内**

- `REPLAN` 作为 agent 结果状态**如何被路由**（当前只经 `fixTaskType` 一条通道，而该通道对非 qa agent **不可达**）。
- `fixTaskType` 的**结构化通道**：schema 声明位置、提示词语义、各 agent 的指令。
- 该失败的**可归因性**：`REPLAN` 结果的失败当前 `errorType` 为空、无 `verification` 记录。

**明确排除**

| 排除项 | 理由 |
| --- | --- |
| N-13 / PL-M24 作用域命令 | **本批已确认修好**（§2.3）；不重开 |
| `docs/` 写范围（第六例） | 本批新现形，**另立项**（`write-scope-family-recurs`），与本条无耦合 |
| 循环守卫（同类任务连续失败 N 次即停） | **本批不做**，见 §7 第 1 项推荐值 |
| L1-M4k 七项同批观察 | `docs/187` §7 第 6 项裁定「只登记、不修」，本文件不动 |
| N-12 / PL-M19 的 `unresolved` 判定 | 本批 0 次（watch item 7），与本条无关 |
| 历史任务记录回填 | `docs/146` §6 规则 7：修前落盘的形状是当时的观测记录，冻结 |

---

## 2. 基线事实（实测）

### 2.1 机制：五个代码锚点

**(1) 结果状态声明了 `REPLAN`，但根上没有 `fixTaskType`** —— `packages/agent-core/src/professional/outcomeSchema.ts:42-73`

```ts
export const SubmitResultSchema = z.object({
  status: z.enum(["SUCCESS", "FAILED", "RETRY", "REPLAN"]),   // :43  REPLAN 是一等值
  summary: z.string(),                                        // :44
  artifacts: …, issues: …, recommendations: …,
  metadata: z.record(z.string(), z.unknown()).default({})     // :73  fixTaskType 只能藏在这里
});
```

`fixTaskType` **不是**根字段。它能活下来的唯一位置是 `metadata`（`metadata` 本身是声明过的字段）。

**(2) 提示词把四个状态并列，一个语义都没给** —— `packages/agent-core/src/professional/ProfessionalAgent.ts:47`

> `{"status":"SUCCESS|FAILED|RETRY|REPLAN","summary":"...","artifacts":[],"issues":[],"recommendations":[],"metadata":{}}`

`REPLAN` 与 `FAILED` 在提示词里**完全等价**——没有任何一句话说明两者差别，也没说 `REPLAN` 需要附带什么。

**(3) 只有一个 agent 被要求给 `fixTaskType`** —— `packages/agent-core/src/professional/AgentRegistry.ts:186`（qa-agent）

> "Write tests named with their AC numbers … never modify product code. Run tests and report exact failures **and a `fixTaskType`**."

`backend-agent`（`:128`）、`frontend-agent`、`database-agent` 的指令里**都没有这一句**。

**(4) 执行器把非 SUCCESS 结果一律判失败，且不留错误码** —— `apps/server/src/services/workflowTaskExecutor.ts`

```ts
fixTaskType: string(outcome.metadata.fixTaskType),        // :377  只读 metadata，不读根
…
const status =                                            // :390
  result.status === "succeeded" && outcome.status !== "SUCCESS"
    ? "failed"                                            // :392  REPLAN → failed，无 errorType、无 verification
    : …
```

`string()`（`:87-89`）对空串/非串返回 `undefined` ⇒ 未给 `fixTaskType` 时 `output.fixTaskType` 为 `undefined`。
同处 `errorType: string(outcome.metadata.errorType)`（`:361`）——agent 没填就为空。

**(4b) 平台已知的失败码没有落到任务上（同族，更宽）** —— 实测 run 2 的四个 `TASK_FAILED`：

| `TASK_FAILED` 事件 `errorCode` | 任务 | 任务 `output.errorType` |
| --- | --- | --- |
| `VERIFICATION_FAILED` | `TASK-08`（BACKEND） | `VERIFICATION_FAILED` ✅ |
| **`CI_FAILED`** | **`T7`（BUILD）** | **(空)** ❌ |
| （无） | `T7-REPLAN-1`（BACKEND） | (空) |
| （无） | `T7-REPLAN-1-DEBUG-2`（DEBUG） | (空) |

`packages/eval/src/harness.ts:73-75` 的 `errorTypes` **只收非空** `output.errorType`：

```ts
if (typeof output.errorType === "string" && output.errorType !== "") {
  errorTypes[output.errorType] = (errorTypes[output.errorType] ?? 0) + 1;
}
```

⇒ run 2 的 summary 报 `VERIFICATION_FAILED: 1`，而**实际失败 4 个** ⇒ **3/4 的失败在失败分布里不可见**。
**`CI_FAILED` 这一格尤其要紧**：平台**知道**这个码（事件里有），只是没写到任务上——
即**同一个失败码有两个来源，且它们不一致**。这不是 N-20（那是**多计**），是**漏计 + 双源**。
**修法并入 25e**（同属「让失败可归因」），见 §3。

**(5) 路由只读 `fixTaskType`，读不到就按源任务类型原样重试** —— `packages/workflow-engine/src/WorkflowEngine.ts:63-78`

```ts
function debugTargetType(source, workType) {
  const fixTaskType = source.output?.fixTaskType;
  if (isUsableTargetTaskType(fixTaskType)) return { type: fixTaskType, … };   // :68  第 1 步
  const inherited = source.input.targetTaskType;
  if (source.type === "DEBUG" && isUsableTargetTaskType(inherited)) …          // :74  第 2 步
  return { type: isWorkTaskType(source.type) ? source.type : workType, … };    // :77  第 3 步
}
```

调用点 `:949` `const target = debugTargetType(source, fixWorkTargetType(source, tasks));`，
产物落在 `:984` 的 `type: target.type`。

⇒ **第 1 步是唯一能表达「换一类任务」的入口，而它对非 qa agent 结构性为空**（锚点 1+3）。
第 3 步于是必然命中，产出与源任务**同类**的重试任务。

### 2.2 复现证据（L1-M4n run 2，workflow `a85a6970`）

**起点**：`T7`（BUILD，CI 门）失败——**一条过期断言**：
`src/bearer-auth-middleware.test.js:333` 断言 `GET /` 返回 404（"the home route is still unimplemented"），
而 slice-4 的实现按 AC-21 让它返回 200 `text/html`。

**第一次诊断**（`T7-DEBUG-1`，SUCCESS）与**第一次重试**（`T7-REPLAN-1`，BACKEND）：

| 字段 | 值 |
| --- | --- |
| `agentName` | `backend-agent` |
| `output.outcome` | **`REPLAN`** |
| 任务终态 | **`FAILED`** |
| `output.errorType` | **空** |
| `verification` | **无记录** |

`T7-REPLAN-1` 的 `recommendations` **原文**（平台已落盘）：

> "**Route a TEST-type task** to correct `src/bearer-auth-middleware.test.js` line 333 from 404 to 200
> (keeping the not-401 assertion and all other assertions), then retry this CI task."
>
> "Do not change home page or server behavior: GET / must remain 200 text/html for unauthenticated
> requests per AC-21 …"

`summary` 原文（节选）：

> "… the test gate still fails on exactly one assertion inside a **read-only test file** …
> Sole failure: "[AC-11] only register, login, health and home are exempt from authentication"
> in `src/bearer-auth-middleware.test.js` at line 333 …"

**平台做了什么**：`replan()` 按锚点 5 的第 3 步，把 `T7-REPLAN-1` 判为 BACKEND ⇒
下一个重试任务 **`T7-REPLAN-1-REPLAN-2` 仍是 BACKEND**。

**第二次**（`T7-REPLAN-1-DEBUG-2`，BACKEND）：同样的诊断、同样的 `outcome: "REPLAN"`、
同样 `FAILED` 且无错误码。终态 `T7-REPLAN-1-REPLAN-2` **PENDING** ⇒ 工作流判死，
`T8`/`T10` 两个 DEPLOY **一直 PENDING** ⇒ staging 段**根本没被尝试**。

**run 3 没有复现它——一处必须写明的更正**（本文件初稿写于 run 3 未结束时，当时据
`T7-REPLAN-1` RUNNING 判「同一形状正在复现」；**该判断错误**）：

run 3 的 `T7-REPLAN-1` 最终 **SUCCESS**，自报
「`node --test` **exits 0 with 219 test marks and 0 failures**」——
而 run 2 的同一任务是「171 tests, 169 pass, **1 fail**」。
**两个 run 的工作区不同**（每个 run 一个全新工作区，实现不同：219 个测试 vs 171 个），
**run 3 的 slice-4 根本没有那条过期断言** ⇒ 它**不是绕过了 N-22，而是根本没走到它**。

⇒ 正确的表述是**条件性的**，不是普遍的：
**当失败需要一个 agent 当不了的任务类型时**，链无法收敛（run 2 的实例）。
**不是**「replan 链普遍不收敛」——run 3 与 `TASK-08-REPLAN-1`（BACKEND，SUCCESS，773s）都收敛了。
§2.5 的普遍度因此按**实例数**计，不按「所有链」计。

**run 3 的真实死因是另一个缺陷**（`docs/200`，N-23）：replan 把交付任务的**类型**换掉，
`input.delivery` 契约随之作废。与本条的机制、证据、修法都不同，**须同批修**。

### 2.3 为什么**不是** N-13（PL-M24 本批已确认修好）

N-13 的形状是「作用域命令挂死：`exitCode` 为 `null`、TAP 整个消失」。
本批 watch item 4 的读数（L1-M4n，全部 6 处失败的 `test` 检查）：

| 任务 | exitCode | failureCode | 命令带 `--test-timeout=20000` | TAP 存活 |
| --- | --- | --- | --- | --- |
| `TASK-08` | 1 | （空） | ✅ | ✅ |
| `task-03-implement-create-task` | 1 | （空） | ✅ | ✅ |
| `task-03-implement-create-task-DEBUG-1` | 1 | （空） | ✅ | ✅ |
| `task-03-implement-create-task-DEBUG-1-DEBUG-2` | 1 | （空） | ✅ | ✅ |
| `TASK-08` ×2 | 1 | （空） | ✅ | ✅ |

**每一处都是真实的 `exitCode = 1`、TAP 存活、命令带新值**——没有一处是沙箱杀死的形状。
且 run 2 的 `T7-REPLAN-1` 自报的 `node --test` 读数是 `exit 1: 171 tests, 169 pass, 1 fail`
——**一次普通的断言不符**，不是挂死。

⇒ **归因到 N-13 不成立。**

### 2.4 为什么**不是** `docs/196` 已否证的那条

`docs/196` §2.3 否证的是这个命题：「第 3 步 `isWorkTaskType(source.type) ? source.type : …`
会**覆盖** agent 明确给出的 `fixTaskType`」。该否证**正确**——第 1 步在第 3 步之前。

**本文件说的是另一件事**：**第 1 步没有值可读**，不是被覆盖。
`docs/196` §2.3 自己也观察到「`fixTaskType` **空**」（它列了 `8b4b1811` 里全部 15 个任务），
但把它读成「第 1、2 步都没命中，走的是第 3 步；**这恰恰是 `fixWorkTargetType` 注释里写明的有意行为**」。

**「第 3 步是有意行为」与「第 1 步应当有值」并不矛盾。**
第 3 步确实是有意的兜底——**当 agent 什么都没说的时候**。
而 run 2 的 agent **说了**（用自由文本 `recommendations`），只是**平台没有通道接住它**。

⇒ 缺陷不在第 3 步，在**第 1 步结构性不可达**。这与 `docs/196` 的结论不冲突，是它未覆盖的一层。

### 2.5 普遍度

- 全库 `REPLAN` 结果共 **36** 次：`backend-agent` **19** / `qa-agent` **16** / `devops-agent` 1。
- **19 次来自「从未被要求给 `fixTaskType`」的 backend-agent**——即 §2.1 锚点 3 的直接后果。
- 本批新增两个实例，**都在 run 2**：`T7-REPLAN-1` 与 `T7-REPLAN-1-DEBUG-2`（各一次 `outcome=REPLAN`）
  ——第二个说明缺陷会**穿过 DEBUG 任务**继续传播。
- **run 3 未产生实例**（§2.2 的更正）。**本条的实例数因此是 2，不是 3。**

---

## 3. 判据（25a–25g）

| # | 判据 | 判法 |
| --- | --- | --- |
| **25a** | `SubmitResultSchema` 在**根**声明可选的 `fixTaskType: z.string()` | 读 `outcomeSchema.ts`；`metadata.fixTaskType` **仍被容忍**（不收紧 `metadata`） |
| **25b** | 提示词为四个 status 各给**一行语义**；`REPLAN` 那行**明确要求** `fixTaskType` | 读 `ProfessionalAgent.ts`；断言提示词含 `REPLAN` 的语义句 |
| **25c** | **每一个会报 `REPLAN` 的 agent** 都被要求在报 `REPLAN` 时给 `fixTaskType` | 读 `AgentRegistry.ts`；断言不再是 qa 独有。**范围（2026-10-21 实施时定为六个）**：backend / frontend / database / qa / reviewer / devops——**不只是「工作类」四个**。理由：`reviewer-agent` 与 `devops-agent` 同样会报 `REPLAN`（普查里 devops 有 1 次），只补四个等于把同一个洞留在另两处。`planner-agent` 不做工作、不改文件，**不背**（有反向对照断言） |
| **25d** | 执行器读**根** `outcome.fixTaskType`，回落 `metadata.fixTaskType` | 读 `workflowTaskExecutor.ts:377`；两路都测 |
| **25e** | **失败码不再有第二个来源**：`REPLAN` 结果的失败带 `errorType`（推荐 `REPLAN_REQUESTED`）；且**凡 `TASK_FAILED` 事件带 `errorCode` 的任务，其 `output.errorType` 必须同值**（覆盖 `CI_FAILED` 这类既有的不一致） | 库内：该形状的失败任务 `output.errorType` **非空**；且对任一批次，`tasks` 里 `status='FAILED'` 且 `output.errorType` 为空的行数 **= 0**（或与 `TASK_FAILED` 无码事件数相等，须逐条解释） |
| **25f** | **正控**：一个 BACKEND 任务报 `REPLAN` 且给 `fixTaskType: "TEST"` ⇒ replan 产出 **`TEST`** 任务，且落到 **qa-agent** | 单测 + 库内下一批 |
| **25g** | **负控**：一个报 `REPLAN` 但**不给** `fixTaskType` 的任务 ⇒ 行为**不变**（仍走第 3 步） | 单测；防「顺手改了兜底」 |

**判据 25f 是这一批的**唯一**目的**：让 §2.2 那条链下一次能收敛。
其余六条是它的必要组成部分与不回归护栏。

---

## 4. 设计裁定（推荐）

**推荐：五处最小改动，全部在同一批内完成——缺任何一处都不成立。**

| # | 位置 | 改动 | 为什么缺它不行 |
| --- | --- | --- | --- |
| ① | `packages/agent-core/src/professional/outcomeSchema.ts:42-73` | 根上新增可选 `fixTaskType: z.string().optional()` | 没有它，agent 说的类型**活不到执行器**（`metadata` 里的能活，但没人告诉 agent 放那儿） |
| ② | `packages/agent-core/src/professional/ProfessionalAgent.ts:47` | 为四个 status 各加一行语义；`REPLAN` 一行写明「**必须**给出 `fixTaskType`，指明应当创建的任务类型」 | 没有它，agent 不知道 `REPLAN` 与 `FAILED` 的差别（现状两者在提示词里完全等价） |
| ③ | `packages/agent-core/src/professional/AgentRegistry.ts`（六处） | 新增共享常量 `REPLAN_CONSTRAINT`，接到**六个会报 `REPLAN` 的 agent** 上（backend / frontend / database / qa / reviewer / devops）；qa 原有的那句「and a fixTaskType」**改用共享常量**，避免两份措辞漂移 | 没有它，19/36 的 backend REPLAN 依旧无值——本批的两个实例正是 backend。**范围比初稿宽**：`reviewer` / `devops` 同样会报 `REPLAN`（见判据 25c） |
| ④ | `apps/server/src/services/workflowTaskExecutor.ts:377` | 改为 `string(outcome.fixTaskType) ?? string(outcome.metadata.fixTaskType)` | 没有它，①③ 写的值读不出来（现在只读 `metadata`） |
| ⑤ | `apps/server/src/services/workflowTaskExecutor.ts:390-395` | `REPLAN` 结果的失败补 `errorType`（推荐 `REPLAN_REQUESTED`） | 没有它，这类失败**依旧无痕**——本批两个实例的 `errorType` 都是空，批次归因看不见它们 |

**为什么不改 `WorkflowEngine.debugTargetType`**：它已经正确（第 1 步优先）。
本批的修法是**让第 1 步有值**，不是改判定顺序。改判定顺序会同时动到 PL-M3 / PL-M18 的既有语义，爆炸半径大得多。

**为什么不改 `fixWorkTargetType`**：它同样正确且是 `docs/196` 认可的**有意兜底**（§2.4）。25g 就是它的不回归护栏。

**为什么 `fixTaskType` 放根而不是继续放 `metadata`**：
`metadata` 是 `z.record(z.string(), z.unknown())`——**无契约、无文档、无校验**。
`docs/196` §2.3 之所以能观察到「`fixTaskType` 空」，恰恰因为它藏在 `metadata` 里、
只有 qa 被口头要求填。放根是让它成为**契约**。

---

## 5. 验证分层

**第 1 层 · 单测（必做，不需配额）**

- `outcomeSchema`：根 `fixTaskType` 通过校验；缺省时仍通过；`metadata.fixTaskType` 仍被接受。
- `workflowTaskExecutor`：`outcome.fixTaskType = "TEST"` ⇒ `output.fixTaskType = "TEST"`；
  仅 `metadata.fixTaskType = "TEST"` ⇒ 同样得 `"TEST"`；两者都有 ⇒ 根优先。
- `workflowTaskExecutor`：`outcome.status = "REPLAN"` ⇒ 任务 `failed` **且** `errorType = "REPLAN_REQUESTED"`。
- `WorkflowEngine.debugTargetType`（25f/25g）：源 BACKEND + `fixTaskType: "TEST"` ⇒ target `TEST`；
  源 BACKEND + 无 `fixTaskType` ⇒ target **仍是 BACKEND**（不回归）。
- `AgentRegistry`：断言四个工作类 agent 的 `systemInstructions` 都含 `fixTaskType` 指令。

**第 2 层 · 包级门禁**

`corepack pnpm --filter @ai-se/agent-core typecheck && lint && test`
`corepack pnpm --filter @ai-se/workflow-engine …`
`corepack pnpm --filter @ai-se/server …`

**第 3 层 · 真实批次（下一批）**

- **主判据**：`T7` 那类「失败在只读测试文件」的链，replan 后产出 **`TEST`** 任务并**收敛**
  （`resolvedByTaskId` 链走到头是 SUCCESS）。
- **可归因性**：库内该形状的失败任务 `errorType` 非空。
- **不回归**：staging 段之外的既有读数（N-6/7/8/9/10 缺席、scopeViolations=0、N-12 未被行使）不变。

---

## 6. 边界与红线

- **不改** `WorkflowEngine.debugTargetType` 的判定顺序，**不改** `fixWorkTargetType` 的兜底语义。
- **不收紧** `SubmitResultSchema` 的根（不加 `.strict()`）——历史上依赖「多余字段被忽略」的行为；
  本次只**新增**一个可选字段。
- **不新增**第二套错误码体系：`REPLAN_REQUESTED` 走既有 `errorType` 通道（`AGENTS.md` §10）。
- **不把** agent 的自由文本（`summary` / `recommendations`）解析成 `fixTaskType`——
  那是「用提示词当接口」，且需要 sanitize 通道（`AGENTS.md` §10）。
  本修法是**加一条结构化字段**，不是解析文本。
- **历史任务记录不回填**（`docs/146` §6 规则 7）。
- **实施前必须等 L1-M4n 批次结束**：改动横跨 `packages/agent-core`、`packages/workflow-engine`、`apps/server`，
  重建 `dist/` 会重启 `:47558`（记忆 [[frontend-validation-boundary]]），run 3 会跑在不同平台版本上。

---

## 7. 待裁定项（每条带推荐值）

| # | 待裁定 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | 是否**同时**加循环守卫（同类任务连续失败 N 次即停） | **不加** | 按 [[verdict-rules-need-a-census]]：**先修路由，再普查是否还循环**。路由修好前加守卫，只会把一个可解释的循环变成不可解释的停止 |
| 2 | `REPLAN` 结果的失败是否维持 `failed` | **维持 `failed`**，只补 `errorType` | 引擎的 `REPLAN` 策略分支（`WorkflowEngine.ts:873`）**以任务失败为触发**；改状态会同时动到 `advanceOnce` 的推进逻辑。本修法只需可归因 |
| 3 | `fixTaskType` 是否**必填**（当 `status === "REPLAN"`） | **不设必填** | 设必填会让旧提示词下的 agent 校验失败（`docs/196` §2.3 的 15 个历史任务是空值）；且缺省时第 3 步兜底仍正确。**用 25g 守住兜底** |
| 4 | `errorType` 取什么值 | **`REPLAN_REQUESTED`** | 与既有 `VERIFICATION_FAILED` / `TIMEOUT_ERROR` 同一命名族（大写下划线）；直说「这是 agent 主动请求重规划」 |
| 5 | 是否顺带修 `docs/` 写范围（第六例） | **不修，另立项** | 两件事无耦合；本批一次只做一个命名缺陷（`AGENTS.md` §9） |

---

## 8. 本批已发生的事实（供记账，非判据）

- **L1-M4n run 2**（`a85a6970`）：`T7` 因只读测试文件的过期断言失败；`T7-REPLAN-1` 与
  `T7-REPLAN-1-DEBUG-2` 双双 `outcome=REPLAN` → `FAILED`（无 `errorType`、无 `verification`）；
  replan 产出仍是 BACKEND；`T8`/`T10` 两个 DEPLOY 一直 PENDING ⇒ **staging 段未被尝试**。
- **L1-M4n run 3**（`ce294d85`）：**没有复现 N-22**（§2.2 的更正）。它走到了 E1 链史上最深的一步
  （第一次真正执行交付任务），死因是 **N-23**（`docs/200`）。**截至本文件落盘，run 3 未结束。**
- 本批 `REPLAN` 任务里另有一条 **SUCCESS**（`TASK-08-REPLAN-1`，BACKEND，**773s**）——
  说明**报 SUCCESS 的 replan 任务可以正常完成**，缺陷只在 agent 报 `REPLAN` 时触发。
  该 773s 同时是 **N-21 的决定性正控**（旧 600s 默认会截断它）。
- **本批 watch item 读数**（截至 run 3 未结束）：N-21 ✅（0 超时、最长 773s SUCCESS）；
  N-15′ ✅（`no available checks for task type DEBUG` = 0）；PL-M24(1) ✅（6 处失败全为真 exitCode、TAP 存活）；
  N-18 ✅（`scripts/` 拒绝归零）；N-19 ✅（`denied` 结构化，112/112 带 `deniedAttempts`）；
  N-6/7/8/9/10/EMPTY_FINAL_ANSWER 全 0；scopeViolations 全空；N-12 未被行使（0）；
  **`docs/` 预测兑现**（`docs/design/token-auth-contract.md` 被拒 ×1）。
