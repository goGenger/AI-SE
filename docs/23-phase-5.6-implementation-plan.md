# Phase 5.6 Implementation Plan — Visual Engineering

> 每次只执行一个 Sub-phase；完成后必须停止。所有实现以当前代码和 `docs/17` 当前验收项为准。

## Global Rules

1. 不重写 Agent Runtime / Workflow Engine / ToolRuntime。
2. Browser 必须通过 ToolRuntime。
3. Visual Contract 是领域契约，不绑定具体 VLM 或 Browser 实现。
4. 优先复用 Artifact、Task、Agent、Sandbox、Browser、MCP 等已有能力。
5. 不建立第二套 Permission / Approval / Audit / Retry / Secret 系统。
6. 任何已完成阶段的 Contract 不因下一阶段而被无理由改写。

## 5.6-0 Visual Contract

定义并冻结 Visual Input、Visual Reference、UI Specification、Design Tokens、Component Map、Layout/Constraint、Asset Reference、Visual Evaluation 基础结构和校验。

不实现真实解析、VLM、Playwright 或视觉评估。

## 5.6-1 Visual Analysis

输入：Screenshot / Figma / URL。

输出：Visual Analysis + Visual Specification。

必须具备可替换 VLM Provider，并至少有一个真实输入链路通过真实 Provider；Fake Provider 只用于测试。

不实现 Frontend Agent、Browser Runtime 或 Visual Evaluation。

> **2026-09-11 修复状态(docs/45)**:三输入链路真实 adapters 已实现
> (OpenAIWire/Figma REST/URL fetch,统一 `analyzeUnifiedInput` → 同一
> analyzer 管线);visual 76/76;live 外部凭据 e2e **BLOCKED**(凭据未配置,
> 不伪造 PASS)。见 docs/44 §5.6-1 的修复更新注记。

## 5.6-2 UI Specification → Frontend

Frontend Agent 消费 UI Specification / Frontend Task，实际修改页面代码。

要求：

- 复用现有组件库
- 复用 Design Tokens
- 复用现有 Agent / ToolRuntime / Sandbox
- 生成页面并完成 build / run / render
- 不直接修改文件绕过 Agent / ToolRuntime

FrontendTaskDraft 只是中间数据，不视为最终完成。

> **2026-09-12 修复状态(docs/46)**:真实执行闭环已实现 ——
> `FrontendTaskDraft(+styleTokens) → buildFrontendAgentTask → frontend-agent →
> ToolRuntime → DockerSandbox → 真实页面 → build/run/render`,Docker E2E 覆盖
> 组件复用、缺失组件记录、token/layout/asset 落码与无权限拒绝。见 docs/44 §5.6-2。

## 5.6-3 Browser Runtime

实现受控 Browser Runtime / Playwright：

- launch
- navigate
- viewport
- wait for render
- screenshot
- console error
- network error / requestfailed
- runtime error
- timeout
- cancellation
- cleanup

Browser 操作必须作为 ToolDefinition 进入 ToolRuntime。

> **2026-09-12 修复状态(docs/47)**:Network Error 采集已补齐 —— `requestfailed`
> 真实监听(过滤 `net::ERR_ABORTED` 客户端取消)+ HTTP 4xx/5xx 响应监听,证据进入
> 既有 `NetworkErrorEntry`/`getErrors` 链,截图携带 `networkErrorCountSinceLast`;
> 真实 Chromium E2E 零外网覆盖全部网络场景。见 docs/44 §5.6-3。

## 5.6-4 Visual Evaluation

输入：Reference + Candidate + UI Specification + viewport。

输出：

- Visual Score
- Dimension scores
- Differences
- Visual Issues
- Evidence

Pixel diff 仅作为辅助定位，不替代结构化评估。

## 5.6-5 Auto Fix / Re-plan

必须形成真实闭环：

Visual Issue
→ Fix Task
→ Frontend Agent
→ Code Change
→ Browser
→ Screenshot
→ Re-evaluation

要求：

- 使用现有 Task / Agent / Sandbox / ToolRuntime
- 有 max rounds
- 有 no-progress / loop detection
- 有 regression detection
- STALLED 时转既有 human/workflow boundary

只生成 Draft 或纯维护 FixLoopState 不算完整完成。

> **2026-09-12 修复状态(docs/48)**:真实执行闭环已实现(组合根
> `apps/server/src/services/visualFixLoop.ts`):Fix Task 提交 → Agent 改码 →
> 独立 build/test → Browser 重跑 → 截图 → Visual Evaluation → 三态判定;
> STALLED / MAX_ROUNDS 以既有 workflow vocabulary(WAITING_APPROVAL + REPLAN)
> 交接人审。四场景 Chromium + Docker E2E 全绿。见 docs/44 §5.6-5。
>
> **2026-09-13 修复状态 #2(docs/49)**:重评估输入修正 —— Candidate 侧由真实
> 截图字节生成(`analyzeCandidateScreenshot`;生产 = 5.6-1 截图分析链 + 真实
> VLM),Reference/Candidate 双侧真实截图进入 5.6-4 evaluateVisuals;URL/HTML
> 分析不再作为截图的替代(仅可作辅助结构信息,本 runner 未使用)。

## 5.6-6 Responsive & UI State Validation

验证：

- desktop / mobile 至少两种 viewport
- responsive breakpoint behavior
- loading / empty / error
- disabled / focus / active
- hover
- expanded / modal / overlay

必须基于真实页面状态和 Browser Runtime 产生 screenshot，再调用既有 Visual Evaluation。

不得仅通过构造状态 JSON 来宣称 UI State Validation 完成。

> **2026-09-13 修复状态(docs/50)**:真实状态闭环完成 —— viewport 矩阵补齐
> desktop/tablet/mobile/custom;十个 UI 状态全部由真实交互触发(click/type/hover/
> focus/press-and-hold)并产生真实 Chromium 截图,进入冻结 evaluateVisuals;九态
> 实测像素差异(modal 84.59%、active 2.86%、hover 2.32%、focus 0.12%…),稳定
> 对照 diffRatio===0;状态级回归探测捕获页面级比较隐形的破坏样式表;docs/40
> §7.3 的 "headless hover 限制" 经真实 E2E 证伪。shared 契约 / 评估算法 /
> Browser 工具注册表零改动。

## Acceptance

MVP：5.6-0 ~ 5.6-4。

Full Phase：5.6-0 ~ 5.6-6。

Full Phase 完成要求：

- Screenshot / Figma / URL input
- Visual Analysis
- UI Specification
- Frontend Agent 实际实现
- Browser Runtime
- Screenshot
- Console / Network error detection
- Visual Evaluation
- Visual Issue → Fix Task
- Frontend Agent 自动修复
- Automatic Re-evaluation
- Responsive validation
- UI State validation
- Phase 0–5.5 regression

完成后必须运行全仓 typecheck / lint / test / build，并执行新的 5.6 → 5.7 Global Regression。

> **2026-09-13**:上述全部门禁与 5.6 → 5.7 Global Regression 已执行并 **PASS**
> (543/543,四门禁 exit 0;见 docs/51)。PHASE 5.6: FROZEN;PHASE 5.7: READY。
