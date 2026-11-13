# 264 · 把 Playwright / 浏览器收成平台契约

> 状态：**已落地**（2026-11-11 Asia/Shanghai）
> 动机：规划 v11 工作流 `2af73768-…`（需求 `d92d5d58-…`）在 `docs/263` 落地后，于 16:01:43 再次失败在 T-10-REPLAN-7。官方命令已改回 `npm run`，构建和切片边界都过了。官方 E2E `npm run test:e2e -- --workers=2` 在沙箱里缺 `/opt/ms-playwright/chromium_headless_shell-1254`，外网也装不上。产品 lockfile 仍是 playwright@1.64.1（对应镜像已预置的 chromium-1248，v10 官方 E2E 已在此版本通过），但切片里把 `node_modules` 升到了 1.65.0（要 1254）。`isProvenUnfixableEnvGap` 仍要求官方检查文本里出现安装命令（切片末根本不会跑）；截断后的 stdout 尾巴丢掉了 launch-error 正文；`outputDigest` 带了耗时，于是 REPLAN-6 与 REPLAN-7 被当成新证据，又空烧了一轮同样的 BUILD。官方 E2E 在产品报告里仍如实记为 BLOCKED，没有被改成 PASS。

相关前文：[docs/255](./255-env-gap-install-and-scoped-test-gates.md)、[docs/256](./256-sandbox-e2e-limits-and-slice-end-gates.md)、[docs/261](./261-stale-env-gap-routing-and-repair-success.md)、[docs/262](./262-official-probe-roots-and-anti-burn.md)、[docs/263](./263-official-workspace-error-is-not-unfixable-env-gap.md)。

---

## 1. 根因与契约

根因不是「每个新项目都要改平台或重打镜像」，而是产品 Playwright 被当成普通依赖上浮后，要的 Chromium revision 已经不在镜像里，运行时又没有外网安装。稳定做法是：**由平台托管 Playwright 与浏览器，产品跟平台走**。

已核实（不得臆测未核对的版本）：

| 来源 | Playwright | Chromium revision |
| --- | --- | --- |
| 镜像 `ai-se-sandbox:22-pnpm9` `/opt/ms-playwright` | 全局 1.61.0（uiSmoke） | 1228 |
| 同一镜像为产品预置（Dockerfile `PLAYWRIGHT_PRODUCT_VERSION`） | **1.64.1** | **1248** |
| taskflow-vue `package-lock.json`（钉回前/后） | 1.64.1 | 1248 |
| 切片中被抬升的 `node_modules` / `.pnpm`（失败现场） | 1.65.0 | 1254（镜像没有） |

本轮**不重建**沙箱镜像。产品钉回 1.64.1，官方 E2E 继续作为阻塞门禁。

---

## 2. 产品（taskflow-vue）

1. 将 `playwright` 与 `@playwright/test` 从 `^1.51.0`（可上浮到 1.65.0）钉成精确版本 `1.64.1`。
2. 用 npm（Node 22，不是 pnpm）刷新 `package-lock.json`。未生成 `pnpm-lock.yaml` / `pnpm-workspace.yaml`。`package-lock.json` 保留。安装后 `playwright-core` 的 `browsers.json` 为 chromium / chromium-headless-shell **1248**。
3. 不改 Vue 组件或可访问名，不把 E2E 报告从 BLOCKED 改写成 PASS。此后在产品树里只用 `npm` 或 `./node_modules/.bin/vitest`。

---

## 3. 平台

### 3.1 平台所有权与预检

`packages/sandbox/src/playwrightContract.ts` 声明平台钉：`@playwright/test` / `playwright@1.64.1` → chromium-1248。新产品模板见 `packages/sandbox/templates/product-playwright/`。官方 E2E 与切片末预检在跑套件前先检查工作区 Playwright：若产品要的 revision 不在镜像已预置集合 `{1228, 1248}` 中，记 `PLAYWRIGHT_CONTRACT_MISMATCH` / `ENV_GAP` 并立刻失败，**禁止**在沙箱里执行 `playwright install`，也不得因此开 BUILD 安装环。声明范围已包含 1.64.1 时，可把清单自动对齐到精确钉；范围不含该钉则 fail-fast。

此预检看的是产品树与平台已核实的镜像内容，不把宿主 cache 缺 1248 误判成镜像缺浏览器（官方 E2E 跑在沙箱镜像里）。

### 3.2 官方分流与反空烧（docs/263 之后的漏洞）

- `isProvenUnfixableEnvGap`：BUILD 之后，官方 e2e 已盖上 `failureCode=ENV_GAP`（缺二进制或契约不一致）即足够收口。不再要求官方检查文本里出现切片末不会跑的安装命令。
- `officialLooksLikeCurrentEnvGap`：承认官方 e2e/install 检查或记录上已盖的 `failureCode=ENV_GAP`，不只看可能被截断的 stdout/stderr 尾巴。官方若只是 `packages field missing or empty`，仍按 docs/263 不得收成 ENV_GAP。
- 官方证据指纹同时比较 `command` + `failureCode`，并对输出去掉耗时后再比；同一官方 e2e `ENV_GAP` 不因 12s vs 18s 就被当成新证据。

### 3.3 智能体不得把 Playwright 当普通升级

- 指令与 frontend-vue skills：钉死 1.64.1，禁止 `playwright install` / 上浮版本。
- `assertCommandAllowed` 拒绝沙箱内的浏览器安装命令，以及未钉 1.64.1 的 `npm`/`pnpm` Playwright 升级。
- 写/改 `package.json` 时，Playwright 字段必须是精确的 `1.64.1`。

DEVOPS 不再被要求在沙箱里执行 `npx playwright install`。

---

## 4. 接线

1. 产品：`package.json` / `package-lock.json` 钉回 1.64.1
2. `packages/sandbox`：`playwrightContract.ts`、模板、Dockerfile 注释、既有 `SANDBOX_PLAYWRIGHT_PRODUCT_*` 改为契约别名
3. `taskVerifier.ts`：官方 test（确认为 E2E 时）与切片末 e2e 增加契约预检
4. `gateFailureRepair.ts`：`officialLooksLikeCurrentEnvGap`、`isProvenUnfixableEnvGap`、`decideGateFailureRepair`
5. `packages/workflow-engine`：`extractOfficialEvidenceFingerprint` / `officialEvidenceFingerprintsEqual`
6. `packages/tool-runtime`：`assertCommandAllowed`、`write_file` / `edit_file`
7. `packages/agent-core`：职业指令与 vue-implement / vue-debug-repair skills
8. 单测：`playwrightContract.test.ts`、`officialGateFailure.test.ts`、`gateFailureRepair.test.ts`、`commandPolicy.test.ts`、`AgentRegistry.test.ts`

---

## 5. 刻意不做（后续）

- **REVIEW 即便返回 REPLAN，是否仍跑切片末官方门禁**，从而给 T-10 留下 `TASK_VERIFICATION`。本轮仍未实施。
- **slice-boundary `slice(0, 20)` 仍可能丢掉 `tests/quality`**。本轮不阻塞落地，留作后续。
- 不改 `.env`、不切 LLM 提供方、**不重建**沙箱镜像 `ai-se-sandbox:22-pnpm9`、不改产品可访问名。
- 不把官方 E2E 改成非阻塞，不把报告从 BLOCKED 改写成 PASS。

---

## 6. 非目标

- 不把初始 TEST 红灯约定拆掉
- 不放宽 anti-tamper / 生产 DEPLOY
- 官方 E2E 仍只在切片末与 CI，并且仍是阻塞门禁
- 以后若要升级浏览器，走正式的镜像与模板发布，而不是项目失败后再救
