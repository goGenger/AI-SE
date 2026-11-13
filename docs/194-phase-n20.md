# 194 · N-20：`errorTypes` 双粒度相加（失败原因分布翻倍）

> 立项：2026-10-20。缺陷登记于 `docs/189` §9.3（L1-M4m 归因），本次为修复。
> 基线：`docs/192`（PL-M24 (1)）、`docs/193`（PL-M24 (2) 裁定不做）。
> 状态：**已修复**。包内门禁全绿；**库内数据复算 A/B 成立**；**未在真实批次验证**。

---

## 1. 缺陷与根因（file:line）

**现象**：批次产物 `packages/eval/results/l1-m4m/run-2.json` 报
`errorTypes = {TIMEOUT: 6, VERIFICATION_FAILED: 2}`、`failureLayers.agent = 6`，
而库内真实超时任务只有 **3 个**。这条解释了长期挂账的「eval summary 与库内对不上」。

**根因**：`EvalRunRecord.errorTypes` 把两个**不相交的口径**相加。

| 口径 | 代码位置 | 计数单位 |
| --- | --- | --- |
| 任务级 | `packages/eval/src/harness.ts:73-74` | 每个 `tasks.output.errorType` 非空的任务计 1 |
| run 级 | `packages/eval/src/harness.ts:782`（修复前） | 每个 `agent_runs.output.errorType` 非空的 run 再计 1 |

**而这两级读的是同一份数据**：

```
apps/server/src/services/workflowTaskExecutor.ts:355-389
  const output: JsonObject = { …, errorType: string(outcome.metadata.errorType), … };   // 355-379
  await this.dependencies.agentRuns.update(run.id, { …, output, … });                   // 380-389
  …
  return { status, output, … };                                                         // 396-402
```

同一个 `output` 对象既写进 `agent_runs`，又作为 `TaskExecutionResult` 返回给任务行。
⇒ **同一份 `errorType` 两级各计一次，相加正好翻倍。**

---

## 2. 为什么取「任务级」这个单一口径（而不是 run 级）

三个理由，按重要性排序：

1. **只取 run 级会让 `VERIFICATION_FAILED` 全部消失。**
   `apps/server/src/services/verifyingTaskExecutor.ts:77-87` 在 enforce 且 verdict=failed 时
   **覆盖任务的** `output.errorType = VERIFICATION_FAILED`；agent run 的 output 保留 agent 自己的码
   （通常是空）。全库 **122 次** `VERIFICATION_FAILED` **一次都没出现在 run 级**。
   而 `collectFailureLayers`（`harness.ts:236-249`）的 `verification` 层**唯一来源**就是它
   （`classifyFailureLayer`，`harness.ts:221-233`）⇒ 只取 run 级会让这一层**恒为 0**，
   且是**静默**归零。
2. **run 级计的是「尝试」，不是「任务结果」。** 全库有 **51 个** agent run 带 `errorType`
   而其任务最终是 `SUCCESS`（`TIMEOUT` 27 / `INVALID_AGENT_RESULT` 11 / `EMPTY_FINAL_ANSWER` 10 /
   其余 3）——它们是中途失败后被重试救回来的尝试，不是该 run 的失败原因。
3. **记录本身的任务单位是任务**：`taskStatuses` / `taskCount` / `reportedSuccess` / `falsePositive` /
   `chainCompleted` / `taskVerificationDivergence` 全部按任务计。

> **与 `parseRecoveryRuns` 的口径不同，这是有意的。** 同一段代码上方（`harness.ts:765-766`）
> 写着「降级率只按 **run 级**统计」。两者问的不是同一个问题：降级率问「降级**事件**发生几次」，
> 失败原因分布问「**任务**因何而败」。改动点已就地写明，避免后人误「统一」。

---

## 3. Modified Files

| 文件 | 动作 |
| --- | --- |
| `packages/eval/src/harness.ts` | 改：删除 `:782` 的 run 级累加；`errorTypes` 改为直接引用任务级结果并就地写明口径理由；`extractRunUsage` 去掉 `errorType` 字段（它只为那行累加存在） |
| `packages/eval/src/__tests__/metrics.test.ts` | 改：两处 `extractRunUsage` 断言去掉 `errorType`；**新增反向断言**「不再暴露 run 级 errorType」防回潮 |
| `packages/eval/scripts/verify-error-types-granularity.mjs` | **新增**：库内数据复算脚本（离线、零配额、不连库，SQL 由调用方给） |
| `packages/eval/results/n24-error-types-granularity/{census.sql,tasks-l1-m4m-run2.json,replay.json,report.json}` | **新增**：普查 SQL、复算输入、复算输出、判定记录 |
| `docs/189-phase-n14-n16-n17-taskbook.md` | 改：登记行与 STOP 行追加修复标记（沿用该文件既有的 `~~…~~〔已修〕` 体例） |
| `docs/194-phase-n20.md` | **新增**（本文件） |
| `docs/146` / `docs/127` | 改：台账 |

**未改动**：`apps/server/src/**`（服务端写入路径一行未动）、`packages/eval/src/{metrics,report,types}.ts`
（`EvalRunRecord` 形状不变，汇总与打印逻辑不变）、`packages/eval/dist/**`（重新构建产物，非手改）、
`docs/17-acceptance-checklist.md`（**本项不涉及任何验收条目**，L1-8 状态不受影响）。

---

## 4. Implementation

**改动本体是「删一行」**：

```ts
// 修复前
const errorTypes = { ...metrics.errorTypes };
for (const summaryRun of runs) {
  …
  if (usage.errorType) errorTypes[usage.errorType] = (errorTypes[usage.errorType] ?? 0) + 1;  // ← 删除
}

// 修复后
const errorTypes = metrics.errorTypes;   // 只按任务级，理由见该行注释
```

配套：`extractRunUsage` 的返回类型去掉 `errorType`，其文档注释写明「不抽 `output.errorType`，
理由见 `collectTaskMetrics` 的调用点」。**不留死字段**——留着就是给下一个人重新叠 run 级的机会。

---

## 5. Architecture Changes

**无。** 不改数据模型、不改服务端写入路径、不改跨包契约；`EvalRunRecord` / `EvalSummary`
的字段与类型一字未变，只是 `errorTypes` 的**取值口径**从「两级相加」改为「任务级」。

---

## 6. Dependencies

**无新增、无升级、无删除。**

---

## 7. Tests

### 7.1 包内单测

`corepack pnpm --filter @ai-se/eval test` → **6 files / 59 tests 全通过**（改动前 58）。

新增/修改的断言：

- `extractRunUsage` 两处 `toEqual` 去掉 `errorType`（原本就在断言这个字段）。
- **新增反向断言**：`expect(usage).not.toHaveProperty("errorType")` —— run 级 `errorType`
  一旦重新暴露，调用点就会再叠一次，把分布重新翻倍。这是**结构性防回潮**，
  而不是「跑一遍看数字对不对」（`docs/145` #7 的教训：计数类断言在负载下会假红）。
- `collectTaskMetrics` / `collectFailureLayers` 的既有断言未动——它们的语义本次未变。

**`runEval` 主循环本身没有单测**（既有事实，非本次引入）：该循环要真起 HTTP + oracle，
包内测试全部落在抽出的纯函数上。因此本次的端到端证据**不靠单测**，靠 §7.2 的库内复算。

### 7.2 库内复算（A/B，离线、零配额）

**方法**：把 l1-m4m run-2 那 4 个 workflow run 的**任务行**从库里取出，喂给**修复后的真实代码**
（`collectTaskMetrics` + `collectFailureLayers`），与修复前落盘的批次产物逐项对比。

```bash
set -a; source .env; set +a
docker exec -i ai-se-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "
WITH wf AS (SELECT unnest(ARRAY['4860c374-…','48cd16a5-…','f45b6eb9-…','716eb98d-…'])::uuid AS id)
SELECT json_agg(json_build_object('status',t.status,'errorType',NULLIF(t.output->>'errorType','')))
FROM tasks t JOIN wf ON wf.id=t.workflow_run_id;" > /tmp/tasks.json

node packages/eval/scripts/verify-error-types-granularity.mjs /tmp/tasks.json
```

**同一状态校验**：复算得到的 `taskStatuses = SUCCESS 63 / FAILED 7 / WAITING_APPROVAL 1`（71 个任务），
与 `run-2.json` 里的同名字段**逐项相同** ⇒ 库内状态即批次当时状态，复算可信。

| | 旧口径（`run-2.json` 落盘值） | 新口径（修复后代码复算） |
| --- | --- | --- |
| `taskStatuses` | SUCCESS 63 / FAILED 7 / WAITING_APPROVAL 1 | **逐项相同** |
| `errorTypes` | `TIMEOUT: 6`、`VERIFICATION_FAILED: 2` | **`TIMEOUT: 3`**、`VERIFICATION_FAILED: 2` |
| `failureLayers` | planning 0 / verification 2 / **agent 6** | planning 0 / verification 2 / **agent 3** |

**读法**：旧口径的 `agent` 层 6 = 任务级 3 + run 级 3，**正好翻倍**；
`verification` 层 2 之所以旧新一致，是因为 `VERIFICATION_FAILED` 只在任务级（§2 理由 1）。

**全库普查**（`census.sql` ②③，只读）：

- 任务级：`FAILED|VERIFICATION_FAILED` 122、`FAILED|TIMEOUT` 25、`READY|VERIFICATION_FAILED` 11、
  `FAILED|EMPTY_FINAL_ANSWER` 10、`READY|EMPTY_FINAL_ANSWER` 7、`READY|TIMEOUT` 3、
  `FAILED|INVALID_AGENT_RESULT` 2、`CANCELLED|VERIFICATION_FAILED` 2。
- run 级：落在 `SUCCESS` 任务上的有 **51** 条（见 §2 理由 2 的分桶）。

---

## 8. Lint

`corepack pnpm --filter @ai-se/eval lint` → **通过**（`eslint "src/**/*.ts"`）。
全仓 `corepack pnpm -r run lint` → **exit 0**。

---

## 9. Typecheck

`corepack pnpm --filter @ai-se/eval typecheck` → **通过**。
全仓 `corepack pnpm -r run typecheck` → **exit 0**。
`corepack pnpm --filter @ai-se/eval build` → **通过**（§7.2 的复算脚本从 `dist/` 导入真实代码，
**不 build 就会读到旧产物、结论会假**）。

---

## 10. E2E

**不适用。** 本改动是 eval 包的记账口径，不涉及 HTTP 路由、UI 或跨进程链路；
端到端等价物是 §7.2 的库内复算。

全仓 `corepack pnpm -r run test` 的结果见 §11 Known Issue 6（按事实记录，不做单侧断言）。

---

## 11. Known Issues

1. **未在真实批次验证。** 本项只做到「包内门禁 + 库内数据复算」，**下一次 E1×3 批次的
   `run-*.json` 才能确认**。按纪律，**不判「已关闭」**。
2. **`collectTaskMetrics` 对任意任务状态计数**（本次**未改**，留待裁定）：它统计 `output.errorType`
   非空的**任何**任务，含 `READY`（全库 21 条）与 `CANCELLED`（2 条）。
   一个「验证失败后被排队重试、但 run 预算用尽没跑成」的任务，当前会被计入失败原因分布。
   **是否应限定 `status = FAILED`，是口径判断不是 bug。**
   我的读法倾向**维持现状**（见 §13）：`READY` / `CANCELLED` 上带 `errorType` 的任务
   **正是这个 run 的拦路者**——它们确实失败了一项检查，只是还没（或没能）走完重试。
   限定成 `FAILED` 会把 21 + 2 条真实成因**藏起来**，与「失败原因分布」的用途相反。
   **须显式裁定，不默认改。**
3. **`errorTypes` 与 `taskStatuses.FAILED` 本来就不会对齐**，且**不是** issue 2 造成的：
   run-2 有 7 个 `FAILED` 任务而失败原因合计 5——差额是 **2 个 `FAILED` 任务 `errorType` 为空**
   （失败路径未产出 `outcome.metadata.errorType`）。两个字段问的不是同一个问题：
   `taskStatuses` 是**结局普查**，`errorTypes` 是**成因普查**。**修复后已无任何重复计数。**
4. **`docs/189` §9.3 登记行已就地追加修复标记**，原文保留（该文件的既有体例是 `~~…~~〔已修〕`，
   与 N-18 一致）。历史批次产物 `l1-m4m/run-*.json` **不回填**——它们是修复前落盘的观测记录，
   按 `docs/146` §6 规则 7，历史记录冻结，勘误只以追加块登记（本文件即该追加块）。
5. **复算脚本依赖 `dist/`**：`verify-error-types-granularity.mjs` 从 `packages/eval/dist/harness.js`
   导入。**先 `pnpm --filter @ai-se/eval build` 再跑**，否则读到旧产物、结论会假。
6. **全仓 `-r test` 两次都没跑绿，但两次失败与本次改动无关，且隔离复跑全过**（如实记录，不做单侧断言）：

   | 次 | 结果 | 失败点 | 隔离复跑 |
   | --- | --- | --- | --- |
   | 1（12:05） | `packages/browser` **1 failed / 37 passed**（38）⇒ `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` **递归中止**，`apps/server` / `packages/mcp` / `packages/agent-core` / `packages/database` **未运行** | `browser.e2e.test.ts > 5.6-3 REAL Chromium e2e`：`Test timed out in 5000ms`（真实 Chromium 冷启动在并发负载下超 5s） | `--filter @ai-se/browser test` → **8 files / 38 tests 全过**（4.62s） |
   | 2（12:08） | 16 包里 **15 包全绿**（`browser` 本轮 38/38 通过），`apps/server` **1 failed / 305 passed**（306） | `sliceFlow.e2e.test.ts > G4（GX-11）`：`expected 200 "OK", got 404`，发生在 `waitFor` 轮询里 | `vitest run src/__tests__/sliceFlow.e2e.test.ts` → **2/2 通过**（8.11s） |

   两次各点名**不同包**、隔离复跑**全过** ⇒ 与 `docs/144` #9 / `docs/145` #7 同族（负载下时序敏感，不同文件、单独复跑通过）。**没有弱化任何测试。**
   `packages/eval` 两次都是 **6 files / 59 tests 全过**。
7. **`--filter @ai-se/eval build` 会刷新 `dist/`**，若服务端正在 `tsx watch` 下运行且依赖该 dist，
   会触发重启（`docs/127` 的既有现象）。本次改动**只碰 `packages/eval`**，
   与 `:47558` 服务端的运行时代码无关；且**无任何包依赖 `@ai-se/eval`**（已按 `package.json` 核对）。

---

## 12. Acceptance Result

**PASS（限定范围）**——判据是「失败原因分布不再把同一份 `errorType` 计两次」，判据达成且可复算：

- 包内门禁全绿（typecheck / lint / test 59 项 / build）；全仓 `-r typecheck` / `-r lint` **exit 0**。
- 库内复算 A/B 成立：`TIMEOUT: 6 → 3`、`agent 层 6 → 3`，`verification` 层保持 2。
- 同一状态校验通过（`taskStatuses` 与批次产物逐项相同）。

**不判「已关闭」**：**未在真实批次验证**（Known Issue 1）。
按 [[acceptance-under-claim]]，边界项不预支。

**全仓门禁的实际读数**（逐次如实记录，`docs/146` §5 口径）：`-r typecheck` **exit 0**、
`-r lint` **exit 0**；`-r test` 跑 **2 次均未跑绿**，但两次失败分别落在 `packages/browser`
与 `apps/server` 的**既有抖动用例**上，**隔离复跑全过**（详见 §11 Known Issue 6）。
`packages/eval` 两次都 **59/59 全过**。

---

## 13. Next Phase Boundary

**未开始事项（STOP）**：

- **N-20 未在真实批次验证**；下一批 `run-*.json` 才能确认。
- **本次登记但未修的 3 项**：**N-15′**（DEBUG 无类型级检查）、**agent 600s 墙上超时**、
  **replan 不收敛**。
- **新登记待裁定 1 项**：**`errorTypes` 是否应限定 `status = FAILED`**（Known Issue 2）。
  **推荐值：维持现状（不限定）**——`READY` / `CANCELLED` 上带 `errorType` 的任务正是该 run 的
  拦路者，限定成 `FAILED` 会把全库 21 + 2 条真实成因藏起来，与「失败原因分布」的用途相反；
  且 `errorTypes` 与 `taskStatuses.FAILED` 本就不同问（成因普查 vs 结局普查），限定后也不会对齐
  （run-2 仍有 2 个 `FAILED` 任务无 `errorType`）。**裁定 ≠ 开工授权**，等用户一句话。
- **N-18 / N-19 / PL-M24 (1) / N-20 均未在真实批次验证。**
- **PL-M24 (1) 的探针仍未入库**（`docs/192` Known Issue 6）：`/tmp/n13-e1/runner.mjs` 须先落为
  `apps/server/scripts/probe-n13-e1-workspace.ts`，再开下一批。
- **未跑任何批次**；下一批开工前仍须先**停并重启 `:47558`**，并先跑 `deniedPaths` 普查。
