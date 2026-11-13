# 191 · PL-M23（N-19：写权限拒绝不进入任务判定）实施记录

> 立项：2026-10-20。基线：L1-M4m 批次（`packages/eval/results/l1-m4m`）＋ 库内 `tool_calls` 全批普查。
> 依据：`docs/146` §3 的 N-19 行、`docs/190` §1.2 / §6 Known Issue 4、`AGENTS.md` §7 / §10。
> 状态：**已实施、未在真实批次验证**。**未取用户裁定**——见 §2 的说明。

---

## 1. 缺陷

**平台拒绝了 agent 的写入，随后把该任务判成 SUCCESS；声明的交付物从未被创建。**

**现场**（L1-M4m run 2）：`slice-1-task-8-REPLAN-1`（BUILD → devops-agent）

| 记录 | 值 |
| --- | --- |
| 任务描述 | 「新增并运行 `scripts/verify-contract.mjs`…」 |
| `tool_calls.input` | `{"path": "scripts/verify-contract.mjs"}`（**只有 `path`、无 `summary`**） |
| `tool_calls.output` | SQL `NULL` |
| 任务终态 | **SUCCESS**，`verification.verdict = verified`，检查 `build:0` |

对照 `ToolRuntimeBackend.recordDeniedCall`（`:326-405`）：`recordToolCallStarted({input:{path}})` ＋
`recordToolCallFinished({status:"failed", error:{TOOL_ERROR}})`——**这正是被拒留痕的形状**
（成功写入是 `input.summary` ＋ `output.{path,bytes}`）。

### 1.1 机制（两处，均已落到 file:line）

1. **验证层是类型级的**：BUILD 任务的检查是 `build`（`pnpm build`），看的是**项目整体**，
   **不看任务声明的交付物**。`package.json` 的 `build` 指向别处的自检脚本，于是检查通过。
2. **被拒写入对审计结构不可见**：`auditTaskWriteScope` 是 **diff 式**的
   （`git status --porcelain` 前后比对，`taskVerifier.ts:958-970`）——**被拒的写入不产生 diff**。
   实测该任务的 `writeScope.changedPaths = []`、`outcome = passed`。
3. **生产里唯一的「被拦尝试」计数器漏掉了这一类**：`blockedCommandAttempts`
   （`apps/server/src/index.ts:219-225`）按 `error.message.includes("blocked")` 计数，
   而写权限拒绝的消息是 `Path is not writable: …` ⇒ **写权限拒绝一次都没被计过**。
   （两者是**两条不同的通道**：前者是 `… is blocked by script-only policy` 一类策略拦截。）

### 1.2 ❗ 全批普查：**「一刀切判失败」被数据证伪**

登记 N-19 时列的两个候选里，① 是「把被拒写入纳入判定」。**先普查再动手，结果推翻了它的粗暴形态。**

**L1-M4m 全批（7 个工作流）**：**37 个任务、61 次被拒写入**（按 `output IS NULL AND input->>'path' IS NOT NULL`
的形状筛出，此时 `input.denied` 尚不存在）。

| 分桶 | n | 说明 |
| --- | --- | --- |
| `large_tool_results/` | 18 | agent 框架自身的草稿 |
| `test/` | 15 | **实现类 agent 试图写测试**（backend 没有 `writeTestFiles`） |
| 其余 | 21 | **多为计划点名的交付物**：`scripts/selfcheck.mjs` 7 / `scripts/verify-contract.mjs` 5 / `docs/ac-coverage.md` 3 / … |
| `conversation_history/` | 7 | agent 框架自身的草稿 |

**关键读数**：这些被拒写入散落在**大量 SUCCESS 任务**上——例如
`48cd16a5|TASK-008|BACKEND|SUCCESS`（2 次被拒）、`716eb98d|T-09-REPLAN-1|BACKEND|SUCCESS`（3 次被拒）、
`4860c374|slice-1-task-5|SUCCESS`（3 次被拒）。

⇒ **若「任何一次被拒写入 ⇒ 任务 FAILED」，本批会有几十个任务翻成 FAILED**，其中大量是
agent 改道后确实完成了工作、或框架自身的草稿路径。**这是一台误报机器，候选 ① 的粗暴形态据此否决。**

---

## 2. 修法（**未取用户裁定**——说明与理由）

用户 2026-10-20 的指令是「修 N-19」。**我没有再发一次待裁定问题**，理由是 §1.2 的普查
**已经排除了登记时两个候选里唯一会引起行为变化的那一个**（① 的粗暴形态），剩下的可选集很窄。
**但这是一次由我作出的判断，须请你复核**：

| 候选 | 判定 |
| --- | --- |
| ① 「本次任务内存在被拒写入 ⇒ 任务 FAILED」 | **❌ 被 §1.2 的数据否决**（几十个 SUCCESS 任务会翻成 FAILED，含框架草稿路径） |
| ①′ 平台侧**记录**被拒写入（不改判） | ✅ **采纳** |
| ② agent 收到拒绝时必须报告 | ✅ **采纳，但收窄**：只要求**如实说明**，**不要求判失败**（强制失败会把「改道后确实完成」的任务一并打成 FAILED，而 replan 目前并不收敛） |

**为什么没有更细的靶子**：平台**分不出**「任务声明的交付物」与「agent 顺手写的东西」——
`TaskPlanItemSchema` 是 `.strict()` 且**没有结构化的交付物字段**，路径只存在于自由文本
`description` 里（`docs/190` §2 已确认）。**没有这个字段，任何「只在交付物被拒时判死」的规则
都只能靠对自由文本做正则**，那正是本仓库反复吃亏的手法。

⇒ **本次只做「让它可见 + 让 agent 如实说」，不改判。**

---

## 3. Modified Files

| 文件 | 动作 |
| --- | --- |
| `packages/agent-core/src/professional/ToolRuntimeBackend.ts` | 改：`recordDeniedCall` 增 `kind: "read" \| "write"` 参数，写进记录的 `input.denied`（**结构化标记**，不再靠消息子串） |
| `apps/server/src/services/writeScopeAudit.ts` | 改：`WriteScopeAudit` 增 `deniedAttempts` / `deniedPaths`（**必填**，缺省记 0） |
| `apps/server/src/services/taskVerifier.ts` | 改：`writeScope` 依赖增 `deniedWriteAttempts`；新增私有 `collectDeniedWrites`（try/catch 失败安全）；`auditTaskWriteScope` **三处返回**都带上（含两条 `skipped` 早退——**非 git 工作区同样读得到**） |
| `apps/server/src/index.ts` | 改：实现 `deniedWriteAttempts`——按 `input.denied === "write"` 结构化检索 `tool_calls`，去重排序后返回 `{attempts, paths}` |
| `packages/agent-core/src/professional/AgentRegistry.ts` | 改：新增 `WRITE_DENIAL_CONSTRAINT`，接到**五个会写交付物的 agent**（frontend / backend / database / qa / devops）的 `systemInstructions` |
| `packages/agent-core/src/professional/ToolRuntimeBackend.test.ts` | 改：**新增 1 例**（被拒调用带结构化标记） |
| `packages/agent-core/src/professional/AgentRegistry.test.ts` | 改：**新增 1 例**（五个写 agent 带该约束 + 只读 agent 反向对照） |
| `apps/server/src/__tests__/writeScopeAudit.test.ts` | 改：**新增 3 例**（进记录不改判 / 非 git 工作区仍可读 / 取数抛错按 0 计不作废验证） |
| `docs/191-phase-n19.md` | **新增**（本文件） |
| `docs/146` / `docs/127` / `docs/189` | 改：台账 |

---

## 4. Implementation

### 4.1 结构化标记（`ToolRuntimeBackend`）

```ts
input: { path: relative, denied: kind }   // kind: "read" | "write"
```

`denyWrite` 传 `"write"`、`denyRead` 传 `"read"`。记录通道的 `input` 是 `JsonObject`
（`ToolCallStartedRecord.input` / `CreateToolCallRecord.input`），**加一个键不需要改任何类型**；
全树 grep 确认**没有任何测试断言被拒记录的 `input` 形状**（只断言返回的 `error` 串）。

### 4.2 记录面（`taskVerifier` / `writeScopeAudit`）

`WriteScopeAudit` 增两个**必填**字段，使「0 次被拒」也是一个明确读数：

```ts
deniedAttempts: number;
deniedPaths: string[];
```

取数**先于 git 检查**，故两条 `skipped` 早退（无 before 快照 / 非 git 工作区）**同样带上**——
这正是修复的一处独立价值：diff 面整个不可用时，被拒写入仍然可读。

失败安全：`collectDeniedWrites` 自带宽 try/catch（`ToolRuntime` 无 catch，抛出去会 void 掉整次验证），
取不到即按 0 计——**它只记录、不参与判定，读失败绝不能让验证作废**。

### 4.3 指令侧（`AgentRegistry`）

```ts
const WRITE_DENIAL_CONSTRAINT =
  " If the write policy rejects a path that your task description names as a deliverable, say so " +
  "explicitly in your result (which path, and what you did instead). Never silently write the " +
  "deliverable somewhere else and report success without mentioning it.";
```

接给 frontend / backend / database（与既有的 `TEST_FILE_CONSTRAINT` 并列）、qa、devops。
**措辞刻意只要求如实说明、不要求判失败**——理由见 §2。

---

## 5. Tests / Lint / Typecheck / E2E

| 编号 | 判据 | 结果 |
| --- | --- | --- |
| 23a | 被拒调用带**结构化**标记（读/写可区分） | ✅ `ToolRuntimeBackend.test.ts` 新增例：`[{path, denied:"write"}, {path, denied:"read"}]` |
| 23b | 被拒写入进记录，**且不改变 outcome / verdict** | ✅ 新增例：`deniedAttempts: 2` / `deniedPaths` 有序，同时 `violations: []`、`writeScope.outcome: "passed"`、`verdict: "verified"` |
| 23c | **非 git 工作区**（审计 `skipped`）仍读得到 | ✅ 新增例：`outcome: "skipped"` 而 `deniedAttempts: 1` |
| 23d | 取数抛错按 0 计，**不作废整次验证** | ✅ 新增例：`deniedAttempts: 0`、`verdict: "verified"` |
| 23e | 五个写 agent 带该约束、只读 agent 不带 | ✅ `AgentRegistry.test.ts` 新增例（正反两侧） |
| 23f | 全仓门槛 | ✅ `-r typecheck` **exit 0**、`-r lint` **exit 0**；`-r test` 16 包全绿（见下） |
| 23g | 未跑真实批次 | ✅ 未跑 |

**包门禁**

| 包 | typecheck | lint | test |
| --- | --- | --- | --- |
| `@ai-se/agent-core` | ✅ | ✅ | **251 / 251**（改动前 249，**+2**） |
| `@ai-se/server` | ✅ | ✅ | **305 / 305**（改动前 302，**+3**） |

**全仓 `-r test` 的抖动（如实记录）**：`apps/server` 2 例失败——`terminationPropagation.e2e`
（FX-35 CANCELLED）与 `v1GoldenScenario.e2e`（server restart）。**隔离复跑 9/9 通过**，
且两者与写权限/审计无因果关系。判为 `docs/145` #7 同类**负载敏感抖动**（PL-M10 / M11 / M13 /
M14 / M16 / M17 / M22 撞到的是同一族）。**未据此改动任何测试。**

---

## 6. Known Issues

1. **「交付物被拒」不会让任务失败——这是裁定，不是遗漏。** 本次只做到**可见**。理由是 §1.2 的普查与 §2 的
   「没有结构化交付物字段」——**这是一个政策问题，不是实现问题**。
   我的推荐值：**维持现状（只记录、不判死）**，理由是数据。
   **〔2026-10-20 用户裁定〕** 用户答「按你的推荐继续」⇒ **按推荐值落定：维持现状。本项不再是待复核项。**
2. **被拒写入不进任何 `workflow_events`。** 只落在 `tasks.output.verification.writeScope`
   （与 `violations` 同一面）。加事件会新增事件类型，本批刻意没做。
3. **指令侧不可验证。** `WRITE_DENIAL_CONSTRAINT` 是行为塑造，**没有任何测试能断言 agent 遵守它**
   （与 N-14 (C) 同类，`docs/189` §9.3 记为「未检验」）。
4. **`blockedCommandAttempts` 未动。** 它与本项是**两条不同的通道**（策略拦截 vs 写权限拒绝），
   合并会让 `POLICY_EVASION_SUSPECTED` 在框架草稿路径上疯狂误报。**这是刻意的，不是遗漏。**
5. **未在真实批次验证。** ⇒ **N-19 不判「已关闭」**，关闭条件＝真实批次里 `writeScope.deniedPaths`
   能如实反映现场。
6. **一处口径提示**：§1.2 的普查用的是**形状筛**（`output IS NULL AND input->>'path' IS NOT NULL`），
   本批之后应改用 `input.denied = 'write'`——**旧批次的数据不会有这个键**，跨批次比较时注意。

---

## 7. Architecture Changes

**无。** 未新增包、未改契约（`input` 是 `JsonObject`，加键不改类型）、未新增事件类型、
未新增第二套 Permission / Audit 体系（`AGENTS.md` §10）。改动的是**既有**记录面多带两个字段。

**口径变更登记**：`tool_calls.input` 对**被拒调用**从此多一个 `denied` 键。
**历史行零改动**（本批零数据库写操作）。

---

## 8. Dependencies

**无新增、无升级、无删除。**

---

## 9. Acceptance Result

**PASS-PARTIAL。** 判据 23a–23e 达成、23g 不适用（本批不跑批次）；
**23f 达成**（全仓 typecheck / lint exit 0，test 16 包全绿、2 例已登记抖动隔离复跑通过）。

**部分**：登记的 N-19 是「拒绝**不进入判定**」，本次只做到**进入记录**——
**「是否应当因此判失败」未修，且我的判断是「不该」**（§2、§6 Known Issue 1）。**须你复核。**

**未在真实批次验证 ⇒ N-19 不判「已关闭」。**

---

## 10. Next Phase Boundary

**未开始事项（STOP）**：

- **N-19 的「是否判失败」已裁定＝否**（用户 2026-10-20「按你的推荐继续」⇒ 维持现状，
  只记录、不判死；理由见 §1.2 / §2）。**本项不再是待复核项。**
- **N-15′**（DEBUG 无类型级检查）**未修**。
- **PL-M20 的挂死问题仍未解决**（L1-M4m run 3 七次 `CHECK_TIMEOUT`），**PL-M20 状态为
  「实施完成、待重新验证」**——须先补上「真实 E1 工作区 + `--test-timeout`」那个缺失的产物。
- **agent 600s 墙上超时**、**replan 不收敛**、**`errorTypes` 双粒度相加** **均未修**。
- **未跑任何批次**；下一批开工前仍须先停掉并重启 `:47558` 实例。

### 本批的一个副产物（供下一批用）

`deniedPaths` 把「**计划点名了一个没人能写的路径**」这一族（已复现五次：PL-M5 / M10 / M11 / M12 / N-18）
从**事后人工翻库**变成了**一次查询**：

```sql
SELECT t.task_key, tc.input->>'path'
FROM tasks t JOIN agent_runs ar ON ar.task_id = t.id JOIN tool_calls tc ON tc.agent_run_id = ar.id
WHERE tc.input->>'denied' = 'write' AND t.workflow_run_id = '<本批>';
```

L1-M4m 的同一查询（形状筛）当场给出了 `scripts/selfcheck.mjs` ×7、`scripts/verify-contract.mjs` ×5、
`docs/ac-coverage.md` ×3 等——**下一批开工前应先跑它**，能提前看见下一堵墙。
