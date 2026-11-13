# 257 · 收口误判红收紧 + E2E 断言分流 TEST + 过时修复叶不再挡切片末门禁

> 状态：**已落地**（2026-11-10 Asia/Shanghai）
> 动机：`docs/256` 落地后，工作流 `514705b2-…` 在 16:53 再次失败。T-13 已成功，官方 `npm run build` 三次都绿，但 T-14 及其两次 BUILD 重试被收口门禁判红并空烧轮次。真正的 7 条 E2E 断言失败被误分成 ENV_GAP / DOCS_GAP；旧的 T-13-REPLAN 失败行加上 T-15 PENDING，切片末官方 E2E 也没跑成。


后续：[docs/262](./262-official-probe-roots-and-anti-burn.md)（同官方证据不得再空烧一轮同样类型的修复）。
---

## 1. 收口门禁不再把交付报告四态表当成客观红证据

自报 SUCCESS 时的 `OBJECTIVE_RED_PATTERNS` 原先用

`docs/delivery-report.*(fail|missing|not)|(?:fail|missing|not).*docs/delivery-report`

匹配。诚实的 BUILD 交付报告只要同时写了 `docs/delivery-report.md` 和四态 `PASS/FAIL/NOT RUN/BLOCKED`（或前文出现过 `FAIL` / `NOT RUN`），就会把官方构建已绿的任务翻成 `OBJECTIVE_EVIDENCE_FAILED`。

现只在交付报告**文件缺失**或**针对该文件的断言未满足**时判红（`missing` / `not found` / `not met` / `assertion fail`）。四态表、`0 FAIL`、`未声称未执行的检查通过` 不再单独触发收口覆盖。

裸的 `/opt/ms-playwright`、`browserType.launch` 也不再作为收口红证据（与 `docs/256` 对缺失二进制的收紧一致）；`Executable doesn't exist` 与显式 `ENV_GAP` 仍算。

## 2. ENV_GAP / DOCS_GAP 误判收紧，E2E 断言失败分流到 TEST

| 证据 | 旧行为 | 新行为 |
| --- | --- | --- |
| `24 passed, 7 failed, 0 BLOCKED` 后文再出现 `Playwright 配置` / `playwright.config.ts` | `BLOCKED` + 后文 Playwright 跨整段命中 ENV_GAP，开 BUILD | 不算缺失浏览器。`0 BLOCKED` / `不再 BLOCKED` 不计入 |
| 交付报告提到 `docs/delivery-report`、`README`、`项目介绍`、`目录结构` | DOCS_GAP，再开 BUILD | 仅文档断言（如 `readme.ac18`、README 缺少约定段落、`Path is not writable: docs/`）才是 DOCS_GAP |
| `Expected` / `Received`、`Timeout 30000ms exceeded`、非零 `FAIL` 计数 | 常被 ENV_GAP / DOCS_GAP / `timed out`→AGENT_TIMEOUT 吃掉 | `GATE_FAILURE`，修复任务类型为 **TEST**（必要时再由 TEST 转 FRONTEND），不开 BUILD |

真实的「N 条 E2E BLOCKED — playwright chromium missing」以及 `Executable doesn't exist` 仍走 ENV_GAP→BUILD（或已证明不可修时的 `unfixable-env-gap`）。

## 3. 已成功根任务下的旧失败修复行不再挡住切片末门禁

`isFailureResolved` / `isSupersededBySuccessfulPredecessor` 原先只沿 `resolvedByTaskId` 链（或 SUCCESS 前驱仍指向下游修复层）判定。人工重试把计划根（如 T-13）跑成 SUCCESS 后，旧的 `T-13-REPLAN-N` 仍可能是 FAILED 且指针为空，切片末 `siblings-unfinished` 会跳过官方 E2E，终局也会把这些叶子当成未解决失败。

现约定：任务 key 带 `-REPLAN-N` / `-DEBUG-N` 动态后缀时，若同计划根（`replanRootTaskKey`）已经 SUCCESS（验证期含 `pendingSuccessId`），则该修复叶视为已被接替。计划根自己仍是 FAILED 时（如 T-14 + T-14-REPLAN-2），不按此规则放行。

判定仍只有这一处，切片末门禁、进度计数、重试范围与终局共用。

## 4. 接线

1. `e2eBrowserPreflight`：BLOCKED 与 Playwright/Chromium 只在同一短窗口内匹配，并排除 `0 BLOCKED` / `不再 BLOCKED`
2. `gateFailureRepair`：收紧 `OBJECTIVE_RED` 与 DOCS_GAP；断言失败先于 timeout / 文档类；`resolveRepairFixTaskType` 可按 `evidenceText` 派 TEST
3. `workflow-engine` `resolution.ts`：成功根下的过时修复叶视为已解决

## 5. 非目标

- 不自动重试工作流 `514705b2-…`（需本变更验证后再由人决定）
- 不改 taskflow-vue 产品代码（7 条 E2E 断言失败留给之后的 TEST / FRONTEND 修复）
- 不切 DeepSeek / 不改 `.env`
- 不放宽 anti-tamper / 生产 DEPLOY
- 不把「嘴上成功、细节留坑」的收口闸拆掉：官方门禁红、文件缺失、断言未满足仍会覆盖自报 SUCCESS

后续：官方门禁失败项并入修复任务，见 [docs/258](./258-official-gate-failures-on-repair.md)。过期「29 BLOCKED / browserType.launch」叙述与修复任务红灯误判，见 [docs/261](./261-stale-env-gap-routing-and-repair-success.md)。
