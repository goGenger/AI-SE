# Phase 5.6-5 Repair — Auto Fix / Re-plan(真实自动修复闭环)

> 任务书:用户提供的 "Phase 5.6-5 Repair" 指令(仅修 5.6-5,禁入 5.6-6)
> 状态:**PASS** — 真实执行闭环实现并经 Chromium + Docker E2E 四场景验证
> 完成日期:2026-09-12
> 开发模式:ponytail(组合既有组件,零新运行时)+ Context7 核实(deepagents/Playwright 契约沿用)

---

## 1. Status

**PASS** — docs/17 §5.6-5 全部打勾。真实闭环:
`Visual Issue → Fix Task → Frontend Agent → ToolRuntime → DockerSandbox →
Code Change → Build/Test → Browser → Screenshot → Visual Evaluation →
RESOLVED / NEW_ISSUE / REGRESSED`,无进展/上限检测与既有 human/workflow
boundary 交接;全部走真实 Chromium + Docker sandbox 路径(LLM 为仓库既定的
确定性测试替身,任务书明确允许)。

## 2. 修改 / 新增文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `apps/server/src/services/visualFixLoop.ts` | **新增** | 组合根 runner:逐轮 Fix Task 提交 → Agent → 独立 build/test → Browser → 截图 → 重评估 → 三态判定 → 循环推进 → handoff;每轮完整 FixRoundRecord + 既有 serializer 的 audit md |
| `apps/server/src/__tests__/visualFixLoop.e2e.test.ts` | **新增** | 4 场景真实 E2E(Chromium + Docker;见 §5) |
| `examples/visual-fix-test-project/**` | **新增** | 修复 E2E 工程:live 页面模块(初始缺 Body 段)+ `reference/design.body.html` 设计基准 + 零依赖 dev server(`/` 服务实时页面、`/reference.html` 同壳输出)+ 最小 sanity 测试 |
| `packages/visual/src/autoFix.ts` | 修改(2 处) | `autoSubmitted: false` 字面量 → `boolean`(runner 记录真实提交;产出默认仍 false,既有测试锁定不变);模块头注释更新 |
| `packages/visual/src/index.ts` | 修改 | barrel 追加 `type EvaluationSide` 导出 |
| `packages/browser/tsconfig.json` | 修改 | 打开 `declaration: true`(组合根消费 browser 类型需要 dist/*.d.ts) |
| `apps/server/vitest.config.mjs` | 修改 | `fileParallelism: false` —— server 包的 docker/postgres/chromium 重 e2e 文件改为串行:并行争用曾导致**三个不同文件**在不同批次里分别失败(单跑均通过);串行后全量批次确定性通过 |
| `apps/server/package.json` | 修改 | 依赖追加 `@ai-se/visual` / `@ai-se/browser`(组合根,单向无环) |
| `docs/17` / `docs/18` / `docs/23` / `docs/44` | 修改 | 状态与注记 |

**未触碰**:5.6-2/5.6-3/5.6-6 产物、workflow-engine、mcp、ToolRuntime/沙箱核心、
shared 契约(零修改)、历史报告 docs/41(未修改)。

## 3. 真实 Fix 执行链(每轮实录)

```text
previousIssues (上一轮评估的三态输入)
→ buildFixTaskDrafts(issues, specifications=[reference spec])   # 5.6-5 纯函数
→ FixTaskDraft(提交副本 autoSubmitted=true)
→ buildFrontendAgentTask(draft, conventions)                    # 5.6-2 composer
→ ProfessionalAgent(frontend-agent) + ToolRuntime               # 真实权限/审计边界
→ DockerSandbox: read_file → write_file/edit_file → run_build → run_unit_test
→ 独立验证: ToolRuntime.run_build + run_unit_test(loop 自持,不信 Agent 自报)
→ BrowserSession.goto(pageUrl) → waitForRender → screenshot(真实 Chromium)
→ 候选 spec: 5.6-1 URL 分析链(analyzeUnifiedInput + fromUrlProvider)
→ evaluateVisuals(reference, candidate)                         # 5.6-4 冻结入口
→ determineFixOutcome(before, after)                            # 三态
→ advanceFixLoop(state, round) → RUNNING / DONE / STALLED / MAX_ROUNDS
```

- 权限/治理:全部沿用 frontend-agent definition(readPaths/writePaths apps/web、
  tools 白名单);未新增 Visual 专用治理;错误经既有 normalization 冒泡。
- 目标性修复:composer 指示仅改目标页文件;E2E 断言 codeChanges 恰为
  `write_file apps/web/src/pages/fixture-page.js`。
- 候选规格由**当前页面真实 HTML**经既有 5.6-1 URL 链生成(确定性 DOM-less 解析);
  生产可替换为真实 VLM 截图分析(依赖注入点 `analyzeCandidatePage`)。

## 4. 三态 / 循环结果(四场景,真实证据)

| 场景 | 轮次 body | 结果 | 断言要点 |
|---|---|---|---|
| A resolved | 1 轮:实现设计正文 | `RESOLVED` → `DONE` | 初始 issue `issue:desktop:section:body:2`;round1 score PASS、resolvedIssues 含该 issue;磁盘文件 == 设计正文;audit 含 `outcome: RESOLVED` + `autoSubmitted: true` |
| B new issue | 错段(Footer) → 正段 | `NEW_ISSUE` → `RESOLVED` → `DONE` | round1 newIssues 含 `issue:desktop:section:footer:2` 且 score≠PASS;round2 基于 round1 遗留 issues 驱动、score PASS |
| D no progress | 同一错段 ×2 | `STALLED`(2 轮,未达上限) | round2 unchangedIssues=body+footer、newIssues=[]、resolvedIssues=[];handoff `WAITING_APPROVAL/REPLAN`,reason 含 "no visual progress" |
| E regression | 错段 → 巨块 → 巨块 | `NEW_ISSUE` → `REGRESSED` → `NEW_ISSUE` → `MAX_ROUNDS` | round2 severity 升为 LAYOUT(严格更差)且 newIssues=[];3 轮达上限;handoff reason 含 "maxRounds";audits=3 |

- 「不得只根据 Agent 自报」:每轮 build/test 由 loop 通过 ToolRuntime 独立执行;
  三态判定只来自 `evaluateVisuals` 的重新评估结果。
- 「重复问题检测」:unchangedIssues(issue id 级)跨轮跟踪,场景 D 断言。
- 「最大修复次数」:FIX_LOOP_MAX_ROUNDS=3(冻结常量),场景 E 断言。

## 5. 测试结果

- server:**46/46**(42 基线 + 4 新增 E2E 场景);
- visual:**78/78**(autoSubmitted 开放为 boolean 无回归;既有 `toBe(false)` 锁定保持);
- browser:**18/18**(回归);
- E2E 使用真实 Chromium(headless shell v1228)与真实 Docker sandbox
  (node:22-bookworm, network none);fixture dev server 为 loopback,零外网。

## 6. Regression

见 §8 门禁批次输出。5.6-0~5.6-4 产物全部零触碰;工具链/权限/审计边界未改。

## 7. 已知限制

1. 候选规格生成使用 5.6-1 URL 分析链(确定性);真实 VLM 截图分析已留注入点
   (`analyzeCandidatePage`),生产切换零代码改动。
2. Fix Task 的 styleTokens 未在本 runner 中填充(参考 spec 无 token findings 时
   为空;attachDesignTokens 可注入,未启用——避免不必要的越域)。
3. handoff 为**信号**(既有 workflow vocabulary:WAITING_APPROVAL + REPLAN),
   真正的人审动作/工单由既有 workflow 链执行(5.6-5 原始边界决策保持一致)。
4. 每轮修复对象为单页面的首个可行 draft(section 级);多草稿并发提交不在范围。
5. 测试基础设施:apps/server 的 docker e2e 文件在并行下存在**既有 flake**
   (两次全量批次分别命中 deliveryApi / agentRunPersistence / deliveryLifecycle,
   单跑全部通过;5.7-0 批次亦有同类记录)。本次以 `fileParallelism: false` 将
   server 包文件串行化,消除争用;属测试基础设施修复,不改任何产品语义。

## 8. 全仓回归

批次(proc_6f10bfc272d2):`TYPECHECK_EXIT=0 LINT_EXIT=0 TEST_EXIT=0 BUILD_EXIT=0`,
TOTAL 与分包数值见最终交付报告。
