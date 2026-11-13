# 261 · 过期 ENV_GAP 叙述不再误分流，修复任务不得把仍红 AC 判成成功

> 状态：**已落地**（2026-11-11 Asia/Shanghai）
> 动机：规划 v11 工作流 `2af73768-…`（需求 `d92d5d58-…`，切片 `slice-quality-delivery`）在 `docs/260` 落地并于 09:14 重试后，于 13:25:42 再次失败。失败点不再是 T-01 的 120s 全量超时，而是 T-10 / T-10-REPLAN-1/2：产品侧还剩 4 条质量断言（缺根目录 `.prettierignore`，报告文件数 156 vs 167，另加过期的 t13 合同钉死 `29 BLOCKED` / `browserType.launch` / `failed === 0`），平台却把审查摘要里「报告仍写着 29 BLOCKED and browserType.launch」「ENV_GAP is cleared」误分成当前 `ENV_GAP`，再把显式 CONFIG / DOCUMENTATION 压成 BUILD。BUILD 写不了 `.prettierignore` 与 `tests/reports/**`，两轮修完即 `repair-exhausted`。同期 T-06-REPLAN-3 官方 test 仍是红灯 `expected: "fail"`，套件 exit 1、AC-16 仍红，却被验收成 `verdict=verified`。

相关前文：[docs/255](./255-env-gap-install-and-scoped-test-gates.md)、[docs/257](./257-objective-red-and-stale-repair-leaves.md)、[docs/260](./260-official-full-suite-test-timeout-and-vacuous.md)、后续：[docs/262](./262-official-probe-roots-and-anti-burn.md)、[docs/263](./263-official-workspace-error-is-not-unfixable-env-gap.md)、[docs/264](./264-platform-playwright-browser-contract.md)。

---

## 1. 产品缺口（taskflow-vue）

1. 新增非空根目录 `.prettierignore`（至少 `node_modules`、`dist`、`coverage`、`test-results`、`playwright-report`），用于清除 AC-16 QD-003 两条「文件必须存在」的失败，不断言被改弱。
2. 按 T-10 沙箱分段计数刷新 `tests/reports/test-execution-report.md`（新增 §17，当前权威结论）与 `tests/reports/t21-full-regression-report.md`。刷新前是 167 文件 / 1466 用例 / 1462 通过 / 4 失败；补上 `.prettierignore` 并重基线合同后，报告记录 167 / 1466 / 1466 PASS / 0 FAIL。分段沿用 T-10 官方沙箱：unit 70/650、components 48/372、views+assembly 32/289、quality 17/155。宿主本机 Vitest 不是官方口径（时区与部分组件失败），未拿来改产品可访问名或业务代码。
3. 重基线 `t13-run-report-accuracy` 与 t21 失败清单合同：去掉对过期 `29 BLOCKED`、`browserType.launch`、`未安装`、以及「仍有失败时 `failed === 0`」的锁定；保留反篡改意图，改为当前拟真值（chromium 可用、当前文件/用例计数、失败数与清单一致）。
4. 当时未做可选清理：`workspace/tests/**` 的过期副本、以及误嵌套的 `Users/shixianbao/Desktop/study/taskflow-vue/` 目录（都不在根 `vitest.config.ts` 的 include 里）。这两棵树已在 [docs/262](./262-official-probe-roots-and-anti-burn.md) 删除。

`package.json` 的 `format` 脚本、产品可访问名均未改。

---

## 2. 平台路由与写权限

### 2.1 分类器

`classifyAutonomyFailure` / `matchesPlaywrightMissingBinaryEnvGap` / `matchesBlockedMissingBrowser` 增加「过期或已清除」叙述判断：

- 描述**过期报告**里的 `29 BLOCKED and browserType.launch`（`still declares` / `stale` / `historical` / `上一轮` 等窗口）不再当成当前浏览器缺失。
- 已经写明 `ENV_GAP is cleared`、chromium 已安装/可用、smoke 通过的叙述，不再命中裸 `ENV_GAP` 词或 BLOCKED 窗口。
- 同一证据里若仍有 `Executable doesn't exist` / `Please run npx playwright install` 等当前缺失事实，则仍判 `ENV_GAP`。
- 真实断言失败（缺 `.prettierignore`、156 vs 167 文件数）走 `GATE_FAILURE`（或已有的 CONFIG/DOCS 类），不再去装浏览器。

### 2.2 修复任务类型与写范围

- `normalizeRequestedRepairType`：`CONFIG` → `BUILD`；`DOCUMENTATION` / `DOCS` → `TEST`。
- `resolveRepairFixTaskType`：当前（非过期）`ENV_GAP` 仍强制 BUILD；`DOCS_GAP` 默认 BUILD，但显式 TEST 保留。过期/已清除的 ENV_GAP 叙述不再压过显式 CONFIG / TEST / DOCUMENTATION。
- 根目录 `.prettierignore` 纳入 `isProjectManifestPath`（`writeProjectManifests` 的 BUILD/FRONTEND/BACKEND/DATABASE 可写）。
- TEST（qa-agent）`writePaths` 增加 `.prettierignore`（不开放整个 `writeProjectManifests`，避免 QA 改 `package.json`）。
- BUILD（devops-agent）`writePaths` 增加 `tests/reports`，仍不开放 `writeTestFiles`，不能写 `tests/quality/*.spec.ts`。TEST 本就可写 `tests/**`。

优先把请求派到正确类型，并给该类型补上写路径，而不是只放宽 BUILD。

### 2.3 修复任务的官方 test 红灯约定

`isRepairTaskForOfficialGates`：`origin === "DYNAMIC"`、或有 `sourceTaskId`、或 `taskKey` 含 `REPLAN` 时，官方 test 检查 `expectation` 为 `"pass"`。

初始 TEST 任务（先写失败测试）仍是红灯 `expected: "fail"`。只修「已经在修实现 / 已实现后再跑」的路径，避免 T-06-REPLAN-3 那种「套件 exit 1、AC 仍红，却 verified / SUCCESS」。

---

## 3. 接线

1. `e2eBrowserPreflight`：`isStaleOrClearedPlaywrightEnvGapNarrative`、收紧 BLOCKED 窗口与缺失二进制匹配
2. `gateFailureRepair`：`classifyAutonomyFailure`、`normalizeRequestedRepairType`、`resolveRepairFixTaskType`
3. `packages/shared`：`ROOT_MANIFEST_PATTERNS` 含 `.prettierignore`
4. `AgentRegistry`：QA 可写 `.prettierignore`；DEVOPS 可写 `tests/reports`
5. `taskVerifierRules` / `taskVerifier`：修复任务官方 test 期望通过
6. 单测：`e2eBrowserPreflight.test.ts`、`gateFailureRepair.test.ts`、`taskVerifierRules.test.ts`、`projectManifestPath.test.ts`、`AgentRegistry.test.ts`、`ToolRuntimeBackend.test.ts`、`writeScopeAudit.test.ts`

---

## 4. 刻意不做（后续）

- **可选第 4 项未落地**：REVIEW 即便返回 REPLAN，是否仍跑切片末官方全量门禁，从而给 T-10 一类任务留下 `TASK_VERIFICATION` 事件。改动面较大，本轮不阻塞落地，留作后续（[docs/262](./262-official-probe-roots-and-anti-burn.md) 仍未实施）。
- 不改 `.env`、不切 LLM 提供方、不改沙箱镜像 `ai-se-sandbox:22-pnpm9`、不改产品可访问名。
- 不处理历史 N-57，也不处理默认 profile 下 BACKEND `makeTask()` 的既有 TaskVerifier 失败。
- 不重写历史 T-01-REPLAN / T-10-REPLAN FAILED 行。
- 不在本机以宿主 Vitest 结果为准去「修」产品业务代码。

---

## 5. 非目标

- 不把初始 TEST 红灯约定拆掉
- 不让 BUILD 获得 `writeTestFiles`（规格文件仍由 TEST 写）
- 不放宽 anti-tamper / 生产 DEPLOY
- 官方 E2E 仍只在切片末与 CI
