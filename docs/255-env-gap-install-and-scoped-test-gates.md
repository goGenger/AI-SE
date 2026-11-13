# 255 · ENV_GAP 安装硬化 + TEST 门禁按 AC 分段

> 状态：**已落地**（2026-11-10 Asia/Shanghai）
> 动机：`docs/254` 把 T-13 正确分流到 BUILD 后，仍被两处平台缺口空烧：
> 1) `npm run test:e2e:install` / `playwright install` 仍受 **120s** 工具上限，沙箱无 CDN、镜像只有 chromium-**1228**，产品锁要 **1248**；BUILD 装不了却再开一轮同类 BUILD。
> 2) 官方 TEST 门 `npm run test -- --reporter=verbose` 全量套件在 120s 超时 → `EVIDENCE_MISSING`，而分段 Vitest + 18/18 AC 已绿。


后续：[docs/261](./261-stale-env-gap-routing-and-repair-success.md)、[docs/262](./262-official-probe-roots-and-anti-burn.md)（官方探测不得再扫嵌套残留测试树）、[docs/264](./264-platform-playwright-browser-contract.md)（Playwright / 浏览器收成平台契约）。
---

## 1. ENV_GAP / BUILD 安装

| 项 | 行为 |
| --- | --- |
| 超时 | `ENV_GAP_INSTALL_TIMEOUT_MS = 900_000`（15 分钟）。`run_command` / `run_lint` 等识别到 Playwright 浏览器安装命令时，**实际沙箱超时**抬到该值（不受 zod 入参 `max(120_000)` 限制）。 |
| 镜像预置 | `packages/sandbox/Dockerfile`：全局 `playwright@1.61.0`（1228）之外，再 `npx playwright@1.64.1 install chromium`（**1248**）。 |
| 宿主缓存 | 默认 `~/.cache/ai-se/ms-playwright`（**不是** Darwin `Library/Caches/ms-playwright`）。种源成功后挂到容器 `/opt/ms-playwright`。空目录不挂，以免盖住镜像内浏览器。 |
| 平台补装 | `provisionPlaywrightBrowsers`：有网辅助容器（非 agent 沙箱）装产品锁版本。agent 命令仍是 `network: none` / `registry`，打不到 Playwright CDN。 |
| 写/读范围 | devops：`run_command`；`readWorkspaceRoot`；可读 `tests/`、`playwright.config.*`；**不可写**测试文件。 |
| 不可再修 | BUILD 已尝试 `playwright install` / `test:e2e:install` 且证据证明不可能 → `unfixable-env-gap` → **FAIL**，不再开同类 BUILD。遵循既有 repair hint：E2E 非阻断 + ENV_GAP 证据。 |

## 2. TEST 门禁分段

| 项 | 行为 |
| --- | --- |
| 有 AC | 官方 test 检查（含 **TEST 红灯**）一律 `buildAcScopedTestCommand`（`--test-name-pattern` / 文件选取）。禁止「有 AC 仍跑全量 `npm run test`」。 |
| 超时归因 | 套件超时 → `CHECK_TIMEOUT`，**不是** `EVIDENCE_MISSING`，也**不是** `VACUOUS_TEST`（见 `docs/260`）。 |
| 全量超时预算 | 未过滤的官方 `test` 命令用 `FULL_SUITE_TEST_TIMEOUT_MS`（8 分钟）；lint / typecheck / build 与作用域 test 仍是 120s。见 `docs/260`。 |
| 全量超时豁免 | 全量命令超时，但作用域/分段 AC 结果已绿 → 忽略该次全量超时（全库回归留给切片收尾 / CI）。anti-tamper **不变**。 |
| 预检 | 官方命令 / `scripts.test` 是 vitest 时，不因 sibling `test:e2e` 或根 `playwright.config.*` 把单测门 fail-closed。 |

## 3. 接线

1. `@ai-se/sandbox`：`playwrightBrowserCache.ts`、`DockerSandbox` 挂载、Dockerfile ARG `PLAYWRIGHT_PRODUCT_VERSION`
2. `@ai-se/tool-runtime`：`isPlaywrightBrowserInstallCommand` + 长超时 / registry 授予
3. `@ai-se/agent-core`：devops `run_command`、`readWorkspaceRoot`、tests 只读
4. `gateFailureRepair`：`isProvenUnfixableEnvGap`
5. `taskVerifier`：TEST 作用域、`waiveFullSuiteTimeoutIfScopedAcsGreen`、`DEFAULT_CHECK_TIMEOUT_MS` 导出
6. `e2eBrowserPreflight`：跨平台缓存、按命令判定是否需要浏览器

## 4. 残留 / 运维

- **重建沙箱镜像**后产品 rev 1248 才进镜像：`pnpm --filter @ai-se/sandbox run build:image`（耗时长、约数 GB）。未重建时：依赖宿主缓存挂载 + 平台 `provisionPlaywrightBrowsers`（需本机 Docker 能出网）。
- agent 沙箱默认无 CDN：仅靠镜像/缓存；超时加长**不能**单独修好离线环境。
- server 若用 `tsx src/index.ts` 直接跑源码，改完相关包 dist / tsx 热加载后需确认；纯 `node dist` 必须重建 server dist。

## 5. 非目标

- 不自动重试工作流 `514705b2-…`
- 不改 taskflow-vue 产品代码
- 不切 DeepSeek / 不改 `.env`
- 不放宽 anti-tamper / 生产 DEPLOY

后续：`docs/256-sandbox-e2e-limits-and-slice-end-gates.md`（默认 pids 1024、E2E 2GB、worker 封顶 2、资源限额不再误开安装 BUILD、官方 E2E 只在切片末与 CI）。官方全量 test 加长超时、超时不得写成 VACUOUS_TEST，见 [docs/260](./260-official-full-suite-test-timeout-and-vacuous.md)。过期 ENV_GAP 叙述不得再分流去装浏览器，以及修复任务不得把仍红 AC 判成成功，见 [docs/261](./261-stale-env-gap-routing-and-repair-success.md)。
