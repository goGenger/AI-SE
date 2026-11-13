# 263 · 官方 pnpm workspace 错误不得收成不可修 ENV_GAP

> 状态：**已落地**（2026-11-11 Asia/Shanghai）
> 动机：规划 v11 工作流 `2af73768-…`（需求 `d92d5d58-…`）在 `docs/262` 落地并于 15:15:04 重试后，于 15:30:55 再次失败。docs/262 的探测根限制已生效：官方 slice-boundary 命令点的是真实 `tests/assembly/**` 与 `tests/components/**`，不再出现 `Users/shixianbao/...`。真正让官方门立刻退出的是 `ERROR  packages field missing or empty`（`pnpm build` / `pnpm test` / `pnpm test:e2e` 均约 1.2s、exit 1）。产品根在 15:00:28 留下了误生成的 `pnpm-workspace.yaml`（只有 `allowBuilds: esbuild: set this to true or false`，没有 `packages`）和 `pnpm-lock.yaml`；官方 `LOCKFILE_ORDER` 在双锁文件时优先 pnpm，命令从历史的 `npm run` 被切走。智能体同一沙箱里用 `npm run` 仍绿。路由却把智能体摘要里的 `test:e2e:install` / `EAI_AGAIN cdn.playwright.dev` / `browserType.launch` 当成「BUILD 已证明装不了浏览器」，以 `unfixable-env-gap` 关停工作流。官方 stderr 从未提到 Playwright。

相关前文：[docs/255](./255-env-gap-install-and-scoped-test-gates.md)、[docs/256](./256-sandbox-e2e-limits-and-slice-end-gates.md)、[docs/261](./261-stale-env-gap-routing-and-repair-success.md)、[docs/262](./262-official-probe-roots-and-anti-burn.md)、后续：[docs/264](./264-platform-playwright-browser-contract.md)。

---

## 1. 产品（taskflow-vue）

1. 删除误生成的 `pnpm-workspace.yaml` 与 `pnpm-lock.yaml`（均 2026-11-11 15:00:28 Asia/Shanghai）。保留原有 `package-lock.json`（2026-11-05），让官方锁文件顺序回到 `npm run`。
2. 保留 T-10-REPLAN-5 已写入的 README / `docs/test-report.md` / `docs/delivery-report.md`（168/1477，quality 18/166 PASS，E2E 如实 BLOCKED）。不回退，不把 E2E 改写成 PASS。
3. 不改 Vue 组件或可访问名，不新增规格。此后在产品树里验证本机质量用例时，只用 `./node_modules/.bin/vitest` 或 `npm run`，避免再次写出 pnpm 残留文件。

---

## 2. 平台

### 2.1 官方检查文本优先于智能体叙述

`classifyAutonomyFailure` 先看官方失败检查的 command / stderr / stdout：

- 官方失败是 `packages field missing or empty`，且官方 e2e/install 并未出现当前浏览器/安装证据 → `GATE_FAILURE`（workspace/CONFIG），即使摘要里写了 `ENV_GAP`、`browserType.launch`、`test:e2e:install`、`EAI_AGAIN`。
- 已有官方检查时，当前 `ENV_GAP` 必须来自官方 e2e/install 检查本身。
- 尚无官方检查时（例如 REVIEW 自报），仍可用叙述分类，以免挡住「先派 BUILD 去装浏览器」的既有路径。

此类 workspace 失败在 `resolveRepairFixTaskType` 中派给 BUILD（可写清单与锁文件），不派 FRONTEND。

### 2.2 `isProvenUnfixableEnvGap` 必须有官方 e2e/install 证据

- 官方失败若只是 pnpm workspace 配置错误，直接返回 false。
- 「已尝试安装」与「安装不可能」（缺二进制、`EAI_AGAIN`、超时、只读根等）必须出现在官方 e2e/install 检查的 command/stderr/stdout 里，不能只用智能体摘要。
- 资源限额杀死浏览器（docs/256）同样要求官方 e2e 证据；没有官方检查时，才退回用叙述（保持既有无门禁证据的用例）。

官方 e2e 若在恢复 `npm run` 之后仍撞上本沙箱缺失的 chromium-1254 / 无网络安装，应如实记为 BLOCKED；只有此时、且具备官方 e2e 证据，才可再走不可修 ENV_GAP。不得为了绿灯改报告或断言。

### 2.3 双锁文件时不要静默优先残缺的 pnpm workspace

`packageManager` 探测增加 `pnpmWorkspace`（是否存在 `pnpm-workspace.yaml`、是否声明了非空 `packages`）。若 `pnpm-lock.yaml` 与 `package-lock.json` 并存，且 workspace yaml 缺失或没有 `packages` 字段，官方 runner 使用 npm，不因 `LOCKFILE_ORDER` 切到 `pnpm build`。未带 `pnpmWorkspace` 的旧探测结果保持历史顺序，以免打坏既有夹具。

---

## 3. 接线

1. 产品：删除 `pnpm-workspace.yaml`、`pnpm-lock.yaml`
2. `packages/tool-runtime`：`PackageFacts.pnpmWorkspace`、`pnpmWorkspaceHasPackagesField`、`resolveRunner` 双锁文件回退 npm
3. `gateFailureRepair.ts`：`officialLooksLikePackageWorkspaceFailure`、`officialLooksLikeCurrentEnvGap`、`classifyAutonomyFailure`、`isProvenUnfixableEnvGap`、`decideGateFailureRepair`、`resolveRepairFixTaskType`
4. 单测：`gateFailureRepair.test.ts`、`packageManager.test.ts`

---

## 4. 刻意不做（后续）

- **REVIEW 即便返回 REPLAN，是否仍跑切片末官方门禁**，从而给 T-10 留下 `TASK_VERIFICATION`。本轮仍未实施。
- **slice-boundary `slice(0, 20)` 仍可能丢掉 `tests/quality`**（本轮官方命令按 walk 顺序取了 assembly + components）。本轮官方失败发生在 pnpm 启动阶段，此项不阻塞落地，留作后续。
- 后续见 [docs/264](./264-platform-playwright-browser-contract.md)：把 Playwright / 浏览器收成平台契约，钉回镜像已有的 1.64.1 / chromium-1248，并补上官方 ENV_GAP 分流与反空烧漏洞。
- 不改 `.env`、不切 LLM 提供方、不改沙箱镜像 `ai-se-sandbox:22-pnpm9`、不改产品可访问名。
- 不处理历史 N-57，也不处理默认 profile 下 BACKEND `makeTask()` 的既有 TaskVerifier 失败。
- 不重写历史 FAILED REPLAN 行，不重建沙箱镜像，不把 E2E 改写成 PASS。

---

## 5. 非目标

- 不把初始 TEST 红灯约定拆掉
- 不放宽 anti-tamper / 生产 DEPLOY
- 官方 E2E 仍只在切片末与 CI
- 不把本沙箱里真实的 chromium-1254 缺失假装成已修复
