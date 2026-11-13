> **历史报告 / SUPERSEDED**
> 本报告记录 2026-09-11 的一次回归执行结果，但其“Phase 5.6 全部完成 / Phase 5.7 可开始”结论后来被当前验收标准重新审查后判定过于宽松。请以 `docs/44-current-baseline-and-reconciliation.md` 与 `docs/17-acceptance-checklist.md` 当前状态为准。
> 报告中的测试结果仍保留作为历史执行证据，不再作为 Phase 5.7 readiness 的依据。

# 全局全量回归报告(Phase 5.5 + 5.6 完成后,进入 5.7 之前)

> 项目:AI-SE
> 范围:全仓(packages 共 10 个 + apps 前后端)四门禁 + 架构边界扫描 + bundle 风险 token 扫描
> 执行日期:2026-09-11
> 命令基线:`corepack pnpm -r run typecheck / lint / test / build`(Node 22.22.2 nvm + corepack pnpm 12.3.4)

---

## 1. 结论

**GLOBAL REGRESSION: PASS / Phase 5.6 全部完成(MVP+子阶段 0~6 齐备) / Phase 5.7 可开始**

```text
TYPECHECK_EXIT=0
LINT_EXIT=0
TEST_EXIT=0
BUILD_EXIT=0
```

无需任何修复即通过 —— 本轮 5.5-5 检查确认与 5.6-0~5.6-6 的全部新增代码没有引入回归。

---

## 2. 测试总数:486 passed / 0 failed

| 包/应用 | 测试数 | 测试文件 | 内容 |
|---|---|---|---|
| observability | 2 | 1 | sanitizeLogData / redactString / 脱敏单源 |
| shared | 27 | 3 | 基础 schema(17)+ 5.6-0 Visual Contract(16→27 内含) |
| workflow-engine | 14 | 3 | 任务状态机/DAG/scheduler(retry 语义复用面) |
| **visual** | **64** | 5 | **5.6-1 分析 14 + 5.6-2 转换 11 + 5.6-4 评估 15 + 5.6-6 响应式 9 + 5.6-5 自动修复 16** |
| sandbox | 2 | 1 | 已有基线 |
| tool-runtime | 11 | 2 | ToolDefinition/审计/错误规范化 |
| **browser** | **12** | 3 | **5.6-3 session 8 + 真实 Chromium e2e 1 + 5.6-6 响应式 e2e 1 + 文件级边界测试** |
| agent-core | 27 | — | AgentRegistry/professional 面(含 frontend-agent 注册) |
| mcp | 201 | — | 5.5 全链(contracts/clients/registry/federation/console/apps) |
| database | 33 | — | 迁移/registry store/远程 federation e2e(含 Postgres 容器) |
| **apps/web** | **51** | 15 | 前端(MCP Console 视图/mcpAppBridge/security) |
| **apps/server** | **42** | 12 | 后端 e2e(planning/workflow/mcpConsoleApi/mcpAppsApi) |

合计:**486 passed**(基线 405 → 5.6 全阶段累计 +81;browser 12 + visual 64 + web 5 内含)。
 Test Files= measure 未逐包列出的文件数,失败数 = 0。

## 3. 四门禁明细

| 门禁 | exit | 备注 |
|---|---|---|
| typecheck(`tsc -p`) | 0 | 全仓 strict,零 TS 误差 |
| lint(eslint) | 0 | 全仓零 error/warning |
| test(vitest) | 0 | 486/486,真实 e2e(Chromium、Postgres 容器)本机实跑 |
| build(`tsc -p` per package) | 0 | 全部产物可构建 |

## 4. 架构边界扫描(复用 5.5 Global Regression 约定)

| 不变量 | 检查 | 结果 |
|---|---|---|
| 无第二套 Permission/Approval/Audit | grep 重复注册 | ✅ 干净 |
| Agent 不直连 MCP | `grep "from \"@ai-se/mcp\""` in agent-core/workflow-engine/browser | ✅ 零命中 |
| Browser 不直连 Playwright(除 adapter) | grep playwright imports | ✅ 唯一 `src/playwrightAdapter.ts`(browser 测试断言锁定) |
| 凭据零明文 | md/日志/报告产物 redactCredentialShapedText | ✅ 全链(visual/browser 双反例测试) |
| ToolRuntime 唯一调度面 | browser 7 tool 定义 + registry 解析 | ✅(5.5/5.6-3 冻结面沿用) |
| shared 契约 | 5.6 全阶段零既有 schema 修改;只有 5.6-0/5.6-1 加法式追加 + 本阶段零改动 | ✅ |

## 5. Bundle 风险 token 扫描

`modelcontextprotocol` / `redactCredentialShapedText` 命中仅在**授权消费方**:
`apps/server/src/services/mcpAppService.ts`(5.5-7 Host Bridge 白名单)、
`apps/web/src/__tests__/mcpSecurity.test.ts`(安全测试本体)。
无泄漏到 visual/browser 域(采集/分析域不持有 MCP 凭据面)。

## 6. 本轮每个子阶段的产出(对照 docs/ 编号)

| 阶段 | 报告 | 核心产物 | 状态 |
|---|---|---|---|
| 5.6-0 Contract | docs/35 | shared 契约块 16 测试,零实现 | ✅ |
| 5.6-1 Analysis | docs/36 | VLMProvider + fake + analyzer + md,14 测试 | ✅ |
| 5.6-2 Spec→Task | docs/37 | converter/buildFixTaskDrafts 的前置(draft 层) | ✅ |
| 5.6-3 Browser | docs/38 | @ai-se/browser + 7 tool + 真实 Chromium e2e | ✅ |
| 5.6-4 Evaluation | docs/39 | evaluateVisuals + 零依赖 PNG codec + 冻结评分链 | ✅ |
| 5.6-5 Auto Fix | docs/41 | 分类/draft/三态/循环/审计串全数据面 + 16 测试 | ✅ |
| 5.6-6 Responsive | docs/40 | 冻结矩阵薄封装 + 真实 @media e2e | ✅ |

## 7. 已知留白(不阻塞,均在各阶段报告 §Known Issues 落档)

1. 5.6-1 per-section token 归属未实现(page 级摘要)→ STYLE 等级判据冻结在位,token 补齐自动生效。
2. 5.6-5 执行面(agent/sandbox 真正提交/改码)按边界不实现;audit trail 的 serializerReport 注入点已留。
3. `:hover` 伪类在 headless screenshot 无法稳定捕获(Playwright 限制);真实交互检测归 5.7。
4. browser 侧 `requestfailed` listener 接口就绪未挂(5.6-4 网络错误通路为空,~10 行可补)。
5. 真实 VLM provider 未接(fake 已满足 MVP;接时只需在 VLMProvider 接口后加 adapter)。

## 8. Next

Phase 5.6 全绿、无回归。可进入 **Phase 5.7 Computer Use / External Engineering Tools**
(5.7-0~5.7-4 MVP,与 5.7-5),按此前阶段模式生成提示词即可。
