# 254 · ENV_GAP：Playwright/浏览器缺失分流与 E2E 预检

> 状态：**已落地**（2026-11-10 Asia/Shanghai）
> 动机：新 v9（`514705b2…`）在 `T-13` → `T-13-REPLAN-1/2`（FRONTEND）上空烧自治轮次——切片 AC 已绿，E2E 因沙箱缺 Chromium（`/opt/ms-playwright/...`，`browserType.launch` / Executable doesn't exist）全部 BLOCKED；FRONTEND 改不了环境。

---

## 1. 失败类

| 类 | 信号（摘） | 修复任务类型 |
| --- | --- | --- |
| `ENV_GAP` | `ENV_GAP`、`/opt/ms-playwright`、`chromium_headless_shell`、`browserType.launch`、`Executable doesn't exist`、`npx playwright install`、E2E×BLOCKED×browser/playwright | **BUILD**（优先于 agent 误报的 FRONTEND） |

`repairHintForFailureClass("ENV_GAP")`：`npx playwright install chromium`（或恢复镜像浏览器）；装不了则 **显式** 将 E2E 标非阻断/跳过并留 ENV_GAP 证据；**禁止** FRONTEND REPLAN。

分类顺序：`ENV_GAP` **先于** `DEPENDENCIES_MISSING`（避免被 `not found` 误收成 npm 依赖缺口再落到 FRONTEND fixFallback）。

## 2. 绑定矩阵

| 任务类型 | 浏览器安装（shell） | 产品 `src/` | 说明 |
| --- | --- | --- | --- |
| **BUILD**（devops-agent） | ✅（既有 run/shell 工具；缓存目录在 writePaths 外） | ❌ | ENV_GAP 修复主责 |
| FRONTEND | ❌（不应派） | ✅（产品） | 不得用 FRONTEND 空烧修环境 |
| TEST / REVIEW | — | — | 不变 |
| 生产 DEPLOY 审批 | — | — | **不**绕过 |

## 3. 预检行为（减少晚到的 T-13 thrash）

1. **`e2eBrowserPreflight`**（`apps/server/src/services/e2eBrowserPreflight.ts`）  
   - 工作区像 E2E（`playwright`/`e2e` 脚本，或根目录 `playwright.config.*`）时，探针 `PLAYWRIGHT_BROWSERS_PATH` / `/opt/ms-playwright` / 主机 `ms-playwright` 缓存是否含 `chromium*`。  
   - 缺失 → 测试门 **fail-closed**，`failureCode: ENV_GAP`，**不跑**整套 E2E。  
   - 不像 E2E 的纯 vitest 单测脚本 → **跳过预检**（返回 null）。
2. **反应式**：测试已跑完但 stdout/stderr 命中 ENV_GAP 信号 → 检查/记录失败码覆盖为 `ENV_GAP`。
3. **自治路由**：`classifyAutonomyFailure` → `ENV_GAP` → `resolveRepairFixTaskType` → **BUILD**（与 DOCS_GAP 同级，压过 explicit FRONTEND）。

## 4. 接线

1. `classifyAutonomyFailure` / `repairHintForFailureClass` / `resolveRepairFixTaskType`
2. `TaskVerifier`：`VerificationFailureCode` 含 `ENV_GAP`；`runCheck` 预检 + 输出归因
3. `VerifyingWorkflowTaskExecutor`：既有 enrich 路径自动带上 `failureClass` + `fixTaskType`
4. devops-agent 指令补充 ENV_GAP 安装/声明跳过（shell-only，不放宽 FRONTEND writePaths）
5. `vue-debug-repair` 一行：Playwright missing → ENV_GAP/BUILD

## 5. 后续（docs/255）

安装超时、镜像预置 Chromium 1248、不可再修的 ENV_GAP、TEST 分段门禁：见 `docs/255-env-gap-install-and-scoped-test-gates.md`。

## 6. 非目标

- 不自动点「重试失败工作流」
- 不改 taskflow-vue 产品代码
- 不在本变更里替沙箱装浏览器（由 BUILD 修复任务或运维镜像完成）
- 不放宽 anti-tamper / 生产 DEPLOY / DOCS_GAP / TEST_FIXTURE_GAP / SPEC_CONFLICT

## 7. 用户下一步

server 吃到新 dist 后：先保证执行环境有 Playwright Chromium（或接受 E2E 非阻断策略），再对新 FAILED 单点「重试失败」——应开 **BUILD** 而不是 FRONTEND。本变更本身不代为点击重试。
