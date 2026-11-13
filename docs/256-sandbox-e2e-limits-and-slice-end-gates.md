# 256 · 沙箱 E2E 限额 + 资源限额分流 + 切片末官方 E2E

> 状态：**已落地**（2026-11-10 Asia/Shanghai）
> 动机：`docs/255` 把 Chromium 1248 打进镜像、安装超时加到 15 分钟之后，工作流 `514705b2-…` 仍在 T-13 失败。浏览器已经装上并能启动，杀进程的是默认沙箱限额（1 CPU / 512MB / **pids 128**）。Docker `--pids-limit` 把线程也算进去：1 个空 Chromium 约 65 个 pid，2 个正好顶到 128。容器里 `os.cpus()` 仍能看到宿主核数，Playwright 按约一半核数开工（本机 10 核 → 5 个 worker）。平台还把这类崩溃误判成「浏览器缺失」，继续开 BUILD 安装。


后续：[docs/263](./263-official-workspace-error-is-not-unfixable-env-gap.md)（官方检查文本优先于智能体叙述；不可修 ENV_GAP 须有官方 e2e/install 证据）。
---

## 1. 沙箱限额

| 项 | 行为 |
| --- | --- |
| 默认 pids | 所有沙箱构造默认 `pidsLimit = 1024`（含 `DockerSandbox` 默认值与 `agentRunService`）。不再使用 128。 |
| 默认内存 | 普通任务仍是 **512m**。 |
| E2E 内存 | 识别为 Playwright 测试的命令（`playwright test` / `test:e2e` / `e2e`）在**命令级**抬到 **2g**，加固 tmpfs **1g**。不另起一套沙箱。 |
| Worker 封顶 | 平台在执行这类命令时把 `--workers` 封顶为 **2**；已有更小的值（如 `--workers=1`）不抬高。不改产品 `playwright.config.*`。 |
| 超时 | Playwright 测试沙箱超时 `E2E_TEST_TIMEOUT_MS = 600_000`（10 分钟）。工具入参 `timeoutMs` 上限仍是 120s（防 agent 乱填）；官方 E2E 把 10 分钟放在运行时 context 与 commandTools 的抬升里，不走该 schema。安装命令仍走 `ENV_GAP_INSTALL_TIMEOUT_MS`。 |
| CPU | 仍是 1；靠 worker 封顶避免按宿主核数放大。 |

不能保证以后所有套件（Firefox+WebKit、更大并行）永不撞限额。撞了应报**资源 ENV_GAP**，而不是「缺浏览器 → BUILD 安装」。

## 2. 分流：缺失二进制 vs 资源限额

| 证据 | 分类 | 自治动作 |
| --- | --- | --- |
| `Executable doesn't exist` / `Please run npx playwright install` / chromium missing | 缺失二进制 ENV_GAP | 仍可开 **BUILD** 安装（除非已证明不可修）。 |
| `pthread_create` / `Resource temporarily unavailable` / `Target crashed` / pids-limit / OOM+browser | 资源限额 ENV_GAP | **`unfixable-env-gap`，不开 BUILD 安装**。可把日常门禁 E2E 标成非阻断并留下证据；切片末与 CI 仍应给出完整浏览器结论。 |

裸的 `chromium_headless_shell`、`browserType.launch`、`/opt/ms-playwright` 不再单独视为「二进制缺失」——这些字样也会出现在「已经装上、进程被杀掉」的日志里。

## 3. 官方 E2E 时机

- **只在切片边界锚点**（切片最后一个经验证门的任务，即既有 `maybeSliceBoundaryCheck`）跑官方 `test:e2e` / `e2e`，命令带 `--workers=2`。
- 中间 FRONTEND / 测试先行 TEST / BUILD 的官方检查**不**跑全量浏览器套件；它们继续用分段单测（vitest / `node --test`）。
- 开发过程中的正确门禁是组件/单测；整仓回归留给切片末与预合并 CI。
- 日常门禁在环境不足时可把 E2E 标成非阻断并附客观证据；切片交付与 CI 在限额够用时应给出完整浏览器结论。

## 4. 接线

1. `@ai-se/sandbox`：`playwrightLimits.ts`；`DEFAULT_LIMITS.pidsLimit = 1024`；`SandboxCommand` 支持命令级 `memory` / `tmpfsSize`
2. `@ai-se/tool-runtime`：`run_command` / `run_unit_test` 等对 Playwright 测试命令封顶 worker、加 2g、加长超时
3. `e2eBrowserPreflight`：`matchesPlaywrightMissingBinaryEnvGap` / `matchesPlaywrightResourceEnvGap`
4. `gateFailureRepair`：资源限额 → `unfixable-env-gap`，不再开同类 BUILD
5. `taskVerifier`：切片末检查名 `e2e`；`E2E_CHECK_TIMEOUT_MS`

## 5. 非目标

- 不自动重试工作流 `514705b2-…`（需本变更验证后再由人决定）
- 不改 taskflow-vue 产品代码，不改产品 `playwright.config`
- 不切 DeepSeek / 不改 `.env`
- 不放宽 anti-tamper / 生产 DEPLOY
- 不保证任意未来浏览器套件永不撞限额

后续：`docs/257-objective-red-and-stale-repair-leaves.md`（收口误判红收紧、E2E 断言分流 TEST、成功根下旧失败修复行不再挡切片末门禁）。
