# 260 · 官方全量 test 加长超时，超时不得写成 VACUOUS_TEST

> 状态：**已落地**（2026-11-11 Asia/Shanghai）
> 动机：规划 v11 工作流 `2af73768-…`（需求 `d92d5d58-…`，切片 `slice-quality-delivery`）在 T-01 加两轮 TEST 修复后失败。官方门禁命令是未过滤的 `npm run test -- --reporter=verbose`，超时只有 120s；本仓库全量 Vitest 约 3–4 分钟（components 单段已约 113s，分段合计 quality+views/assembly ~77s + unit ~50s + components ~113s）。两轮都在约 120s 超时。第二轮验收项已全绿，分段套件也跑通，但单条全量命令仍过不了门禁。平台还把这次超时写成「red-light check passed without implementation (VACUOUS_TEST): test」——TEST 修复任务的官方 test 是红灯约定 `expected: "fail"`，命令超时（exitCode null、passed false、检查级 `CHECK_TIMEOUT`）却被总原因归进空转桶。`docs/255` 已规定 120s 全量超时不得打成 `EVIDENCE_MISSING`，但归因路径仍把「不是 EVIDENCE_MISSING」的红灯一律叙述成 `VACUOUS_TEST`。


后续：[docs/261](./261-stale-env-gap-routing-and-repair-success.md)、[docs/262](./262-official-probe-roots-and-anti-burn.md)。
---

## 1. 约定

1. 官方**全量**（未带 `--test-name-pattern` / `--testNamePattern` / `--grep` / 作用域文件 glob）`test` 检查使用专用超时 `FULL_SUITE_TEST_TIMEOUT_MS = 480_000`（8 分钟）。取值约 2 倍于实测 3–4 分钟墙钟，给单 CPU 沙箱和 verbose reporter 留余量，仍短于官方 E2E 的 10 分钟。做法与官方 E2E 相同：超时放在运行时 context，**不写**工具入参，避开 zod `timeoutMs.max(120_000)`。
2. **不**抬默认检查超时：lint / typecheck / build 仍是 `DEFAULT_CHECK_TIMEOUT_MS`（120s）。作用域 AC / `--test-name-pattern` / 文件 glob 的 test 命令仍按 `acScopedTestTimeoutMs` 在 120s（或调用方传入的作用域预算）内分摊。
3. **不**抬 agent 面向的工具超时上限，schema 仍是 120s，agent 不能借此把任意命令拖到 8 分钟。
4. 官方 `test` 检查一旦超时，检查级与记录级诊断码都必须是 `CHECK_TIMEOUT`，reason / 判定叙述不得写成 `VACUOUS_TEST` 或「red-light check passed without implementation」。真正的空转（红灯命令实际 exit 0，且没有实现证据）仍判 `VACUOUS_TEST`。anti-tamper 与断言意图保护不放宽。`docs/255` 的「超时不是 EVIDENCE_MISSING」与全量超时豁免仍然有效。

## 2. 接线

1. `taskVerifier`：`FULL_SUITE_TEST_TIMEOUT_MS`、`officialTestCheckTimeoutMs`、`summarizeRedLightFailures`；`runCheckWithRetry` 对全量官方 test 把超时放进 `runTool` context
2. 红灯失败分组：只把真正的 `VACUOUS_TEST`（或未打码且未超时的红灯）放进空转桶；`CHECK_TIMEOUT` 单独叙述
3. 单测：`taskVerifier.test.ts`「docs/260」组——全量超时加长、lint/typecheck 不加长、红灯超时不是 VACUOUS_TEST、真空转仍是 VACUOUS_TEST

## 3. 非目标

- 不改 taskflow-vue 产品代码，不改可访问名
- 不处理产品侧 AC-14 / AC-17 等磁盘上可能仍在的已知问题（留给工作流重试后的官方门禁）
- 不把历史默认 profile 下 BACKEND `makeTask()` 失败或 N-57 纳入本变更
- 不切 DeepSeek / 不改 `.env`
- 不重建沙箱镜像
- 不放宽 anti-tamper / 生产 DEPLOY

---

后续：本条为当时官方 test 门禁超时与超时归因的收口。v11 在本条落地后的下一轮失败（过期 ENV_GAP 叙述误分流、修复任务仍红却 verified）见 [docs/261](./261-stale-env-gap-routing-and-repair-success.md)。
