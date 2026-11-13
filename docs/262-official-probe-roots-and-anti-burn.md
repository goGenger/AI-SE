# 262 · 官方探测只走正规测试根，同证据不得空烧第二轮修复

> 状态：**已落地**（2026-11-11 Asia/Shanghai）
> 动机：规划 v11 工作流 `2af73768-…`（需求 `d92d5d58-…`）在 `docs/261` 落地并于 14:08 重试后，于 14:48:51 再次失败。docs/261 的路由与「修复任务官方 test 期望通过」均成立：T-10-REPLAN-3/4 的官方 test `expected: "pass"`，智能体自报 SUCCESS 未被当成终局。真正的空烧是：官方 AC 文件探测从工作区根 `walk('.')`，ASCII 顺序先扫到误嵌套的 `Users/shixianbao/Desktop/study/taskflow-vue/tests/**`，再 `slice(0, 20)`，官方命令从未跑到智能体改过的 `tests/quality/**`。两次官方失败共享 `outputDigest` `54a4ae207cb3c61b32e1dad195ffd7fd0c7fcb9359ef39db48fc8f614d74b7f2`，平台仍开了第二轮同类型 TEST（T-10-REPLAN-4）。

相关前文：[docs/255](./255-env-gap-install-and-scoped-test-gates.md)、[docs/257](./257-objective-red-and-stale-repair-leaves.md)、[docs/260](./260-official-full-suite-test-timeout-and-vacuous.md)、[docs/261](./261-stale-env-gap-routing-and-repair-success.md)、后续：[docs/263](./263-official-workspace-error-is-not-unfixable-env-gap.md)、[docs/264](./264-platform-playwright-browser-contract.md)。

---

## 1. 产品（taskflow-vue）

1. 删除产品根下误嵌套的 `Users/shixianbao/Desktop/study/taskflow-vue/` 整树，以及只含过期 `tests/**` 的 `workspace/`。两者都不在根 `vitest.config.ts` 的 include（`tests/{unit,components,views,assembly,quality}`）里，也不是剩余 AC 的依赖。
2. 保留 T-10-REPLAN-3 已经收窄的 t13 合同：`BROWSER_MISSING_CLAIM` 与按行过滤的「单条 `npm run test` 不得记成 PASS」。没有回退 docs/261 的重基线。
3. 保留 T-10-REPLAN-4 新增的 `tests/quality/t10-quality-slice-gate.ac-17-ac-18-ac-19.spec.ts`，视为正当的质量合同（AC 覆盖图、切片边界、报告与磁盘一致、delivery 有 NOT RUN 不得记 PASS）。未再堆新规格。
4. 按实测同步计数，不编造：宿主本机 `./node_modules/.bin/vitest run tests/quality` 于 2026-11-11 14:59:37 Asia/Shanghai 为 **18 文件 / 166 用例全部通过**。unit / components / views+assembly 沿用 T-10 官方沙箱分段（70/650、48/372、32/289）。合计 **168 文件 / 1477 用例**。已写入 `docs/test-report.md`、`docs/delivery-report.md`；`tests/reports/**` 在 REPLAN-4 已是 168/1477，未再加新章节。未改 Vue 组件或可访问名，也未放宽反篡改断言。

---

## 2. 平台

### 2.1 探测只走正规测试根

`buildAcTestFileProbeCommand` / `parseAcTestFileProbe` / `isSafeTestFilePath` / `buildAcScopedTestCommand`（`taskVerifierRules.ts`）：

- 只 walk `tests/`、`test/`、`__tests__/`、`e2e/`。
- 跳过 `node_modules`、`.git`、`dist`、`coverage`、`Users`、`workspace`。
- `isSafeTestFilePath` 拒绝含 `Users` 段或以 `workspace/` 开头的路径；`isCanonicalTestFilePath` 要求第一段是正规根。
- **先过滤，再** `slice(0, MAX_SCOPED_TEST_FILES)`。
- 已探测但过滤后 0 个正规文件 → `buildAcScopedTestCommand` 返回 `null`，不得把嵌套残留塞进官方命令，也不得静默退回全量名称筛选。

### 2.2 探测失败是 CONFIG，不是再派一轮 TEST

`taskVerifier.ts` 增加 `PROBE_FAILURE`：

- 作用域存在且探测成功返回 `[]`（0 正规文件）时，官方 test / slice-boundary 记 `PROBE_FAILURE`，不再记普通 `AC_SCOPE_UNSUPPORTED`。
- 命令若仍只含非正规测试路径，跑前 fail-closed。
- 跑完若 0 个作用域 AC 覆盖、且命令只点了非正规树，覆盖为 `PROBE_FAILURE`。

`classifyAutonomyFailure` 将 `PROBE_FAILURE` 与「官方失败命令只有 `Users/` / `workspace/` 路径且 0 覆盖」分成 `PROBE_FAILURE`，不再落入会再派同一类型 TEST 的 `GATE_FAILURE`。

### 2.3 反空烧（挂在既有 `decideGateFailureRepair`）

智能体自报 SUCCESS 仍不是官方门禁的替代（docs/261 保持不变）。在此之上：

1. 官方失败后先问：当前任务类型的写范围够不够到红点。不够（探测路径、官方命令没跑到智能体改过的文件、`docs/**` 被拒且红点就是文档）→ 停止或换类型，不得再开一轮同样类型的修复。`PROBE_FAILURE` 是平台探测问题，不派产品 BUILD 去空烧。
2. 同一官方证据（失败检查的 `outputDigest` + `command`）+ 同一任务类型 + 同一写范围：只允许修一轮。再失败必须收口（`repair-exhausted` 或 `unfixable-official-gate`），不得再堆 REPLAN。回归用例即 T-10-REPLAN-3 与 T-10-REPLAN-4 共享 digest `54a4ae207cb3c61b32e1dad195ffd7fd0c7fcb9359ef39db48fc8f614d74b7f2`。
3. 已证明够不到红点的路径不再重试。

接线：`WorkflowEngine.replan()` 把 `extractOfficialEvidenceFingerprint(source.output.verification)` 写入下一轮 `input.priorOfficialEvidence`。路由在 `unfixable-official-gate` 时 `FAIL`，镜像 `unfixable-env-gap`。

---

## 3. 接线

1. `taskVerifierRules.ts`：正规测试根、垃圾路径过滤、探测 walk、空结果 fail-closed
2. `taskVerifier.ts`：`PROBE_FAILURE` 诊断码与官方 test / slice-boundary 分类
3. `gateFailureRepair.ts`：`classifyAutonomyFailure`、`isOfficialRedPointUnreachableByTaskType`、`isRepeatedOfficialEvidence`、`decideGateFailureRepair`、`createAutonomyFailureRouter`
4. `packages/workflow-engine`：`extractOfficialEvidenceFingerprint` / `officialEvidenceFingerprintsEqual`，replan 任务写入 `priorOfficialEvidence`
5. 单测：`taskVerifierRules.test.ts`、`gateFailureRepair.test.ts`、`officialGateFailure.test.ts`

---

## 4. 刻意不做（后续）

- **可选：REVIEW 即便返回 REPLAN，是否仍跑切片末官方门禁**，从而给 T-10 一类任务留下 `TASK_VERIFICATION` 事件。改动面较大，本轮不阻塞落地，仍留作后续（docs/261 §4 同期项未在本轮实施）。
- 后续见 [docs/263](./263-official-workspace-error-is-not-unfixable-env-gap.md)：官方 `packages field missing or empty` 不得收成不可修 ENV_GAP；slice-boundary 仍可能丢掉 `tests/quality`，同样留作后续。Playwright 平台契约与官方 ENV_GAP 反空烧见 [docs/264](./264-platform-playwright-browser-contract.md)。
- 不改 `.env`、不切 LLM 提供方、不改沙箱镜像 `ai-se-sandbox:22-pnpm9`、不改产品可访问名。
- 不处理历史 N-57，也不处理默认 profile 下 BACKEND `makeTask()` 的既有 TaskVerifier 失败。
- 不重写历史 FAILED REPLAN 行。
- 不重建沙箱镜像。

---

## 5. 非目标

- 不把初始 TEST 红灯约定拆掉
- 不放宽 anti-tamper / 生产 DEPLOY
- 官方 E2E 仍只在切片末与 CI
- 宿主本机 Vitest 不是 unit/components/views+assembly 的官方口径
