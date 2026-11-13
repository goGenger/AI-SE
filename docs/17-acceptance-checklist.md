# Acceptance Checklist

> **读法**：本文件是**全量勾选清单**（原始计分板）。每条未勾项的归类与原因（未排期 / 外部阻塞 / 部分达成 / 已登记 / 待裁决）见 **`docs/146`（全局完成度总表）**——**未勾 ≠ 漏做**；审查请从 `docs/146` 读起，再回本文件核对细节。

## Phase 0 — 已完成

- [x] Monorepo
- [x] Vue
- [x] Node
- [x] PostgreSQL
- [x] Redis
- [x] Docker
- [x] Tests
- [x] Logging
- [x] Health
- [x] Project CRUD

## Phase 1 — Coding Agent

- [x] LangGraph.js 接入
- [x] LangChain.js 接入
- [x] Zod Tool Schema
- [x] Agent State
- [x] Agent Graph
- [x] LLMProvider
- [x] Tool Runtime
- [x] File Tools
- [x] Search
- [x] Git Status/Diff
- [x] Shell/Command
- [x] Test/Lint/Build
- [x] Docker Sandbox
- [x] Timeout
- [x] Cancellation
- [x] Max Iterations
- [x] Error Classification
- [x] Bug Fix E2E
- [x] 前端 Agent Run 页面

## Phase 2 — Persistent Runtime

- [x] Agent Run Persistence
- [x] Tool Call Persistence
- [x] Workflow Event Persistence
- [x] LangGraph Checkpoint/Persistence
- [x] Retry Policy
- [x] Timeout
- [x] Cancellation
- [x] Run Recovery Boundary
- [x] Server Restart Recovery Boundary
- [x] SSE

## Phase 3 — Planning

- [x] Requirement
- [x] Specification
- [x] Structured Output
- [x] Task
- [x] Dependency
- [x] DAG
- [x] Acceptance Criteria

## Phase 4 — Dynamic Workflow

- [x] Persistent WorkflowRun
- [x] Task Scheduler / Dependency Resolution
- [x] Parallel Task / maxConcurrency
- [x] Atomic Task Claim / Duplicate Protection
- [x] Retry / Failure Strategy
- [x] Re-plan / Dynamic Task
- [x] Failure Recovery / Deadlock Detection
- [x] Approval
- [x] Pause/Resume/Cancel
- [x] Workflow Events / SSE
- [x] Workflow Console
- [ ] Rollback（保留到具有可回滚外部副作用的后续交付阶段）

## Phase 5 — Multi-Agent

- [x] Deep Agents
- [x] LangGraph integration
- [x] Planner
- [x] Frontend Agent
- [x] Backend Agent
- [x] DB Agent
- [x] QA Agent
- [x] Reviewer
- [x] DevOps Agent
- [x] Context isolation
- [x] Agent collaboration via Workflow/Task Engine

## Phase 6 — Delivery / V1（实现完成，外部验收待配置）

- [x] GitHub Actions workflow
- [x] CI adapter / status persistence
- [x] Docker Image local build
- [ ] Remote Registry push verification（需要 GitHub/GHCR）
- [x] Deployment Orchestrator
- [x] Environment Management（dev / staging / production）
- [x] Local Staging deployment
- [x] Local delivery E2E
- [x] Approval integration
- [ ] Real Production deployment（需要目标环境）
- [x] Health Check
- [x] Rollback
- [x] Deployment Status / History
- [x] Release Version Traceability
- [x] Deployment Failure Recovery
- [ ] Full external lifecycle E2E（需要 GitHub/GHCR/production）

> Phase 6 完成后，AI-SE V1 视为完成。
>
> V1 核心闭环：
>
> PRD → Planning → Dynamic Workflow → Multi-Agent Development → Testing → Review → CI/CD → Staging → E2E → Approval → Production → Health Check / Rollback

## Phase 7 — Observability（V1 后续增强）

> **已收口（2026-10-15）**：任务书 `docs/147`（2026-10-15 已裁定）；实施记录 `docs/149`（M1：7-A 关联 ID 贯通 / 7-B 指标端点）、`docs/150`（7-C 端到端追踪）、`docs/151`（验证证据不进 Agent 输入）、`docs/152`（7-E 决策事件契约）；**收口记录 `docs/153`**。六项处置：**完成 2 项**（端到端 trace、Agent/Tool/Workflow metrics）、**延期 4 项**（外部栈 OpenTelemetry / Prometheus / Grafana / Loki —— 不引入依赖与基础设施，`docs/147` §6 第 1 项）。M3（7-D 外部栈）按 §3 裁定处理，**不作为收口条件**。

- [ ] OpenTelemetry —— **延期**：不引入 `@opentelemetry/*` 依赖与外部栈。追踪能力由 7-C 以数据库派生的树交付（见下），但**不导出 OTel span**，两者不可互读为同一件事。
- [ ] Prometheus —— **延期（部分替代）**：平台侧的抓取契约已由 7-B 的零依赖文本端点交付（任何 Prometheus 服务端可直接抓取 `/api/metrics`），但**服务端与抓取未部署**。此处不勾选（栈组件确未引入）；能力面的覆盖已计入下方 `Agent/Tool/Workflow metrics` 一项。
- [ ] Grafana —— **延期**：无面板栈；其数据源（Prometheus 服务端 / Loki）同样未引入。
- [ ] Loki —— **延期**：日志仍为 stdout 结构化 JSON（经 `@ai-se/observability` 脱敏），未引入日志收集栈。
- [x] End-to-end trace —— 2026-10-15 由 7-C 交付：`GET /api/workflows/:id/trace`（数据库派生的 `Workflow → Task → AgentRun → ToolCall` 树，部署挂在其任务下；不引入 span 与外部依赖），节点数与库中行数逐类一致（`apps/server/src/__tests__/workflowTrace.e2e.test.ts`，OB-07 / OB-08，`docs/150`）
- [x] Agent/Tool/Workflow metrics —— 2026-10-15 由 7-B 交付：`GET /api/metrics`（Prometheus 文本格式）导出 `docs/12` 九项，与直接 SQL 聚合逐值一致（`apps/server/src/__tests__/metricsEndpoint.e2e.test.ts`）

## Phase 8 — AI SRE（V1 后续增强）

> **收口（2026-11-04）**：8-A→8-D 已勾选并生效。任务书 `docs/242`；记录 8-A=`docs/243` / 8-B=`docs/244` / 8-C=`docs/245` / 8-D=`docs/246`。不是 Agents UI Phase 8。
> 实机：迁移 `020`/`021`/`022` 已应用；server 已加载。8-D **代码默认关**；本机当前进程环境可为 `INCIDENT_AUTO_REMEDIATE=true`（**.env 未写**）。

- [x] Alert ingestion —— 8-A：`POST /api/alerts` + fingerprint 幂等（SRE-01；`docs/243`）
- [x] Incident —— 8-A：`incidents` 表 + `GET /api/incidents` + 只读控制台（SRE-02…04；`docs/243`）
- [x] Diagnosis（8-B 只读；`docs/244`；SRE-05…08）
- [x] Evidence collection —— 8-B：`IncidentEvidenceCollector`（metrics/trace/deploy/workflow/alert）
- [x] Fix Plan —— 8-B 诊断输出 `fixPlan`；8-C 白名单开 staging 绑定交付计划（`docs/245`；SRE-09…12）
- [x] Automated branch/fix（可选自动 start）—— 8-D：`INCIDENT_AUTO_REMEDIATE` **代码默认关**；打开后白名单可自动 start 到 staging VERIFY；完整编码仍走既有 Agent 工作流；**非**自动生产（`docs/246`）
- [x] Test / Staging / Approval / Production / Verify（结构）—— 8-C 复用 CI→staging DEPLOY→VERIFY→production+`WAITING_APPROVAL`；VERIFY 失败不升生产
- [x] 8-D 白名单自动跑完 staging VERIFY（可选；**代码默认关闭**；`INCIDENT_AUTO_REMEDIATE`；`docs/246`；SRE-13…15）

## Phase 5.5 — MCP Tool Federation

### 5.5-0 Contract Freeze

- [x] MCPClientPort defined
- [x] MCPToolAdapter defined
- [x] MCP Server / Tool / Binding model defined
- [x] Mock echo/slow/failing contract exists
- [x] No real HTTP/OAuth/Resource/Apps implemented

### 5.5-1 Local MCP

- [x] stdio transport
- [x] initialize
- [x] tools/list
- [x] tools/call
- [x] disconnect
- [x] cancellation
- [x] error normalization
- [x] unit/integration tests

### 5.5-2 Tool Runtime Integration

- [x] MCP Tool uses existing Tool Runtime
- [x] schema validation
- [x] permission
- [x] risk
- [x] approval
- [x] timeout
- [x] cancellation
- [x] audit
- [x] secret redaction
- [x] DENY causes 0 MCP Server requests
- [x] native tool regression passes

### 5.5-3 Registry & Persistence

- [x] mcp_servers
- [x] mcp_tools
- [x] mcp_tool_bindings
- [x] server CRUD
- [x] enable/disable
- [x] connect/disconnect
- [x] refresh discovery
- [x] project binding
- [x] agent binding
- [x] visibility filtering
- [x] deny by default

### 5.5-4 Remote MCP

- [x] Streamable HTTP
- [x] connection lifecycle
- [x] reconnect
- [x] degraded state
- [x] credentialRef/authRef
- [x] secret isolation
- [x] timeout/cancellation

### 5.5-5 Console

### Phase 5.5-5 — MCP Console

- [x] MCP Server list - server name - transport - enabled - connection status - tool count

- [x] MCP Server detail - metadata - transport configuration summary - endpoint/command summary - credentialRef/authRef（仅显示引用）- connection status - lastConnectedAt - lastError（已脱敏）- tools - bindings

- [x] Connection status - CONNECTING - CONNECTED - DEGRADED - RECONNECTING - DISCONNECTED - REVOKED - UI 状态必须来自后端 Registry

- [x] Tool list - name - description - enabled - risk - requiresApproval - input schema 摘要 - 不允许浏览器直接调用 MCP Tool

- [x] Risk display - 使用现有 UnifiedToolMetadata / Tool Runtime 风险 - 不信任 MCP Server 自报 risk - 不创建新的风险体系

- [x] Binding management - Project Binding - Agent Binding - enable / disable / revoke - 默认 deny - binding 修改后立即影响 Tool visibility

- [x] No browser direct MCP connection - Browser 不直接连接 MCP Server - Browser 不持有 MCP credential - Browser 不调用 MCP SDK - MCP Tool execution 仍必须经过 ToolRuntime

### 5.5-6 Resource / Prompt

- [x] resources/list
- [x] resources/read
- [x] prompts/list
- [x] prompts/get
- [x] separate adapters
- [x] existing policy/audit reused

### 5.5-7 MCP Apps

- [x] UI Resource
- [x] sandboxed iframe
- [x] Host Bridge
- [x] controlled action
- [x] Tool Runtime governance
- [x] credential isolation

## Global Regression

- [x] Phase 0–5 existing tests pass
- [x] Native Tool path unchanged
- [x] Agent Runtime unchanged except required adapter integration
- [x] Workflow Engine unchanged except required result/error integration
- [x] No direct Agent → MCP path
- [x] No direct Browser → MCP path
- [x] No plaintext credential in state/log/result
- [x] No duplicate Permission / Approval / Audit system

## Phase 5.6 — Visual Engineering

> 当前状态：**PHASE 5.6: FROZEN；PHASE 5.7: 已完成**（2026-09-13 5.6 → 5.7 Global Regression PASS,见 docs/51。**「PHASE 5.7: READY」是当时的就绪标记，不是终态——5.7 此后已全部完成，见本文件下节 `5.7-0`…`5.7-5` 全勾与记录 `docs/43`、`docs/52`–`docs/57`；2026-10-19 更正**）。5.6-0~5.6-6 全部完成;5.6-1 实现 PASS,仅外部 live 凭据 e2e 为 BLOCKED BY EXTERNAL CONFIG(未伪装 PASS)。

### 5.6-0 Visual Contract

- [x] Visual 输入 URI 契约
- [x] VisualInputRecord 数据结构与校验
- [x] UI Specification 结构
- [x] Design Tokens 结构
- [x] Component Map
- [x] 契约测试
- [x] 边界冻结：不实现解析 / 采集 / 浏览器行为

### 5.6-1 Visual Analysis

- [x] 截图输入契约与基础分析管线
- [x] 页面结构 / 几何 / 样式 / 状态 / 资源结构化模型
- [x] VLMProvider 可替换接口
- [x] VisualAnalysisReport
- [x] Fake VLM / 离线测试
- [x] 至少一个真实 VLM Provider（OpenAIWireVLMProvider 已实现;live 外网调用 BLOCKED BY EXTERNAL CONFIG）
- [x] Screenshot → Visual Analysis 真实 E2E（真实 HTTP 回路,本地 mock server;外部 live BLOCKED）
- [x] Figma 输入真实 E2E（FigmaVLMProvider REST,本地 mock;外部 live BLOCKED）
- [x] URL 输入真实 E2E（allowlist + 确定性解析,真实 HTTP 回路,无需外部凭据）
- [x] Screenshot / Figma / URL 统一进入 Visual Specification 的完整链路

### 5.6-2 UI Specification → Frontend

- [x] UI Specification → Frontend Task / Draft
- [x] Component Map 匹配规则
- [x] Design Token / Layout / Asset 信息转换
- [x] 复用现有 Task / Agent 模型的设计
- [x] Frontend Agent 实际接收 UI Specification / Frontend Task
- [x] Frontend Agent 实际修改代码
- [x] 代码修改经过现有 Agent / ToolRuntime / Sandbox
- [x] 真实页面生成 E2E
- [x] 生成页面成功 build / run / render

> **2026-09-12 Repair(docs/46)**:真实执行闭环已实现并通过 Docker E2E 验证 ——
> `VisualSpecification → FrontendTaskDraft(+styleTokens) → buildFrontendAgentTask
→ frontend-agent(ProfessionalAgent)→ ToolRuntime → DockerSandbox → 真实页面模块
→ 真实 node build + node --test + render`。组件复用(Button)、缺失组件记录(Icon)、
> 设计 token(var(--…))、布局(data-section-id/data-rect)、资产(logo.svg)全部经
> 真实工具链进入实现;无写权限时被拒绝且磁盘零变更。

### 5.6-3 Browser Runtime

- [x] `@ai-se/browser` 包与 Playwright 集成
- [x] Browser 生命周期
- [x] Navigation
- [x] Viewport
- [x] Screenshot
- [x] Console error detection
- [x] Runtime error detection
- [x] Page load failure detection
- [x] Timeout / Cancellation
- [x] Browser 操作经 ToolRuntime
- [x] 凭据不注入 Browser context
- [x] `requestfailed` 真实采集
- [x] Network error 与 Browser Evidence / Screenshot 正确关联

> **2026-09-12 Repair(docs/47)**:`requestfailed` 监听已真实挂载(`net::ERR_ABORTED`
> 客户端取消按约定过滤,避免与 4xx/5xx 双重计数);`response` 监听采集 HTTP 4xx
> (`http_4xx`)/5xx(`http_5xx`),含主文档导航;三类网络证据进入既有
> `NetworkErrorEntry`(session seq 共享、URL/reason 脱敏),截图锚点新增
> `networkErrorCountSinceLast`。真实 Chromium E2E:本地 loopback HTTP fixture
> (zero 外网)覆盖成功不误报 / 4xx / 5xx / requestfailed / 区分 / 脱敏 /
> 截图关联 / 导航级 404-500;Timeout 语义未变。

### 5.6-4 Visual Evaluation

- [x] Reference / Candidate 配对
- [x] Viewport / dimension normalization
- [x] Structural comparison
- [x] Pixel auxiliary diff
- [x] Layout / spacing / typography / color / component / asset comparison
- [x] Difference severity
- [x] Visual Score
- [x] VisualEvaluationReport
- [x] Evaluation Evidence

### 5.6-5 Auto Fix / Re-plan

- [x] Visual Issue Schema
- [x] Visual Issue 分类
- [x] Visual Issue → Fix Task Draft
- [x] Fix acceptance criteria
- [x] Fix Loop 状态模型
- [x] maxRounds / stall detection
- [x] Re-plan 状态信号
- [x] Fix Task 实际提交给 Frontend Agent
- [x] Frontend Agent 实际修改代码
- [x] 修改经过现有 Agent / ToolRuntime / Sandbox
- [x] 修复后自动重新运行 Browser
- [x] 自动重新截图
- [x] 自动重新 Visual Evaluation
- [x] 真实 resolved / new issue / regression 判定
- [x] STALLED 后接入既有 human / workflow boundary

> **2026-09-12 Repair(docs/48)**:真实 Auto Fix 闭环已实现 —— 组合根
> `apps/server` 的 `visualFixLoop` 串联既有组件:`Visual Issue → Fix Task
(buildFixTaskDrafts,提交副本 autoSubmitted=true)→ frontend-agent →
ToolRuntime → DockerSandbox → 真实代码修改 → 独立 build/test → Browser
重导航 → Screenshot → 候选 spec → 5.6-4 evaluateVisuals
→ RESOLVED / NEW_ISSUE / REGRESSED`(候选 spec 的生成方式已由下方
> Repair #2 改为截图驱动)。真实 Chromium + Docker E2E 四场景:
> resolved / new-issue→resolved / 连续无进展→STALLED / regression+maxRounds;
> handoff 复用既有 vocabulary(WAITING_APPROVAL + REPLAN)。

> **2026-09-13 Repair #2(docs/49)**:视觉重评估输入修正 —— Candidate 侧改为
> **只从真实截图字节**生成(`analyzeCandidateScreenshot` 注入点;生产 = 5.6-1
> 截图分析链 + 真实 VLM),不再使用 URL/HTML 解析替代截图;Reference 与
> Candidate 两侧均为真实截图(`evaluateVisuals(reference, candidate)` 的
> candidateSource == 会话捕获的 screenshot:// 资产,逐轮记录可查);三态判定
> 完全来自该次截图评估(pixel + structural)。E2E 同步改为截图驱动(真实
> Chromium 截图 → 确定性截图分析替身 → 5.6-1 后处理 → 5.6-4 冻结评估),
> 四场景全绿。

### 5.6-6 Responsive & UI State Validation

- [x] Desktop / Tablet / Mobile / Custom viewport matrix
- [x] Responsive breakpoint validation（真实 Chromium 截图 + 评估;断点域精确性:600px 上下界）
- [x] Cross-viewport summary
- [x] 结果复用 VisualEvaluationReport
- [x] Browser Session 可重入
- [x] 真实 UI State validation
- [x] Loading / Empty / Error
- [x] Disabled / Focus / Active
- [x] Hover
- [x] Expanded / Modal / Overlay
- [x] State screenshot + Visual Evaluation
- [x] UI State regression detection

> **2026-09-13 修复(docs/50)**:真实状态闭环完成 —— 十个 UI 状态全部由真实交互
> 触发(click/type/hover/focus/press-and-hold),真实 Chromium 截图进入冻结
> evaluateVisuals;九态实测像素差异(modal 84.59%,hover 2.32%,focus 0.12%…),
> 稳定对照 diffRatio===0;状态级回归探测在页面级比较隐形的破坏样式表上正确报
> `missingChange`。响应式矩阵补齐 tablet/custom,媒体块剥离后仅 sub-600px 视口
> 变化(desktop/tablet 逐像素一致)。docs/40 §7.3 的 "headless hover 限制" 经
> 真实 E2E 证伪并永久锁定。shared 契约与评估算法零改动。

### Phase 5.6 Gate

- [x] 5.6-0 Contract 基础完成
- [x] 5.6-4 Evaluation 基础完成
- [x] 5.6-1 完整完成（实现 PASS;外部 live E2E BLOCKED BY EXTERNAL CONFIG —— 见 docs/45 + docs/51）
- [x] 5.6-2 完整完成（2026-09-12 Repair，见 docs/46；待 Global Regression 复核）
- [x] 5.6-3 完整完成（2026-09-12 Repair，见 docs/47；待 Global Regression 复核）
- [x] 5.6-5 完整完成（2026-09-12 Repair，见 docs/48 + docs/49 Repair #2；待 Global Regression 复核）
- [x] 5.6-6 完整完成（2026-09-13 修复，见 docs/50；待 Global Regression 复核）
- [x] Global Regression 通过（2026-09-13，见 docs/51）
- [x] Phase 5.7 READY（2026-09-13，见 docs/51）

> **2026-09-13 Global Regression(5.6 → 5.7,docs/51)**:全仓四门禁 exit 0
> (543/543,0 failed/0 skipped);架构/安全/bundle 扫描全干净;数据库 migration 与
> checksum 真实执行;零残留容器。**GLOBAL REGRESSION: PASS —— PHASE 5.6: FROZEN;
> PHASE 5.7: READY**。5.6-1 外部 live E2E(OpenAI / Figma)为 BLOCKED BY EXTERNAL
> CONFIG,按任务书单独报告,未伪装 PASS。
>
> **〔2026-10-19 追加〕本段是 2026-09-13 的验收快照，按历史记录保留不改。** 其中「Phase 5.7 READY」当时的含义是「5.7 **就绪待开工**」，不是终态；**5.7 此后已全部完成**——`5.7-0`…`5.7-5` 见本文件「Phase 5.7 — Computer Use / External Engineering Tools」节**全勾**，记录 `docs/43`、`docs/52`–`docs/57`。**唯一保留的边界**：`5.7-2` 的连接器是 fake / echo harness（真实外部 API 凭据只注入不实现）。

### Phase 5.6 Status

- [x] 5.6-0 Visual Contract
- [x] 5.6-1 Visual Analysis
- [x] 5.6-2 UI Specification → Frontend
- [x] 5.6-3 Browser Runtime
- [x] 5.6-4 Visual Evaluation
- [x] 5.6-5 Auto Fix / Re-plan
- [x] 5.6-6 Responsive & UI State Validation

> Phase 5.6 Implementation: PASS / FROZEN
>
> External validation:
>
> - OpenAI-compatible VLM live E2E: BLOCKED BY EXTERNAL CONFIG
> - Figma live E2E: BLOCKED BY EXTERNAL CONFIG
>
> 外部验证不阻塞当前阶段冻结；待真实环境凭据配置后补充验证。

## Phase 5.7 — Computer Use / External Engineering Tools

> 阶段顺序：
> 5.7-0 Computer Use Contract
> → 5.7-1 Browser Computer Use / 5.7-2 External Engineering Systems
> → 5.7-3 Action Policy
> → 5.7-4 Evidence & Verification
> → 5.7-5 Failure Recovery
>
> 5.7-1 与 5.7-2 可并行。
> MVP = 5.7-0 ~ 5.7-4。
>
> 边界不变量：
> Computer Use 只能在受控 Browser / Sandbox / ToolRuntime 内运行；
> 不做通用 RPA，不允许任意宿主机 GUI 控制；
> 外部工程系统统一经 MCP；
> 凭据只通过 credentialRef；
> Permission / Risk / Approval / Audit / Timeout / Cancellation / Error
> 继续复用现有平台能力，不建立第二套治理系统。

### 5.7-0 Computer Use Contract(契约冻结)

- [x] GUI Action / Browser Action / Observation / Screenshot / ActionResult / Cancellation / Timeout 契约(shared 加法式冻结)
- [x] ExternalActionRef(browser / mcp / sandbox 三来源 discriminated union,统一动作身份)
- [x] Observation 数据结构(DOM / Accessibility 双形态 + screenshotRef 关联,base64 由调用方传入)
- [x] ActionResult(success / failed / cancelled;evidence 关联归 5.7-4,本阶段不加字段)
- [x] 契约测试(zod strict + fixture;零行为实现)
- [x] 边界冻结:不实现任何采集 / 执行 / 持久化行为

### 5.7-1 Browser Computer Use

- [x] `browser.observe`：DOM / Accessibility Snapshot → Observation
- [x] Browser Action → ActionResult
  - [x] click
  - [x] type
  - [x] navigate
  - [x] screenshot
- [x] Screenshot Action 复用 5.6-3 截图资产管线
- [x] Agent 不直接依赖 Playwright
- [x] Browser Runtime 仍是唯一 Playwright 边界
- [x] Browser Context 不注入凭据
- [x] 所有 Browser Action 经 ToolRuntime
- [x] 真实 Chromium E2E：observe → action → observe

> **2026-09-13 完成(docs/52)**:适配层映射完成 —— `browser.observe` 产出严格
> 5.7-0 Observation(DOM 固定脚本 + aria snapshot;观察 ref 可直接作动作选择器);
> 4 个动作工具经既有 ToolRuntime 治理(权限走 AgentPermissions.tools、审计走
> ToolCallRecorder、超时/取消为既有封套),截图复用 5.6-3 资产管线(screenshot://,
> base64 不进契约);浏览器上下文零凭据注入;观察与 actionRef.target 经脱敏单源
> (E2E 锁定含密 data:URL 的泄漏路径)。browser 33/33、server 51/51、全仓 557/557。
>
> **2026-09-13 Repair(docs/53,5.7-1 → PASS)**:敏感输入隔离修复 —— 探针证明原实现
> 双通道泄漏(password 值经 DOM `value→text` 原样进入观察;`page.ariaSnapshot()` 更将
> textbox 值明文渲染且长值缩写使 regex 失效)。修复:凭据语义字段(type=password /
> autocomplete=_password_|one-time-code)**结构化**屏蔽(value 永不离开页面,节点携
> `[value hidden: …; hasValue: …]` 语义);无障碍树改为受控派生(结构只读、零表单值);
> 普通输入照常可观察;`PageLike.ariaSnapshot()` 退出接口。真实 Chromium 安全 E2E
> (本地 http fixture):password/OTP/new-password/凭据形状内容在 Observation、
> ToolResult、audit、a11y 树中零原文;browser 34/34、server 51/51、全仓 558/558。

### 5.7-2 External Engineering Systems(MCP 通道)

- [x] ExternalToolCatalog(声明外部系统 tool 名单 / 风险等级:GitHub / Issue / Project / 文档 / CI-CD 等)
- [x] 连接器经 MCP client(5.5-1/5.5-4 冻结面,零直连外部 API)
- [x] ExternalToolDefinition 注册进 ToolDefinition(经 ToolRuntime,复用 schema/permission/risk)
- [x] 动作输出为 ActionResult(与 5.7-1 同构)
- [x] 本阶段连接器实现 fake / echo harness(真实外部 API 凭据 credentialRef,只注入不实现)
- [x] 边界:不新增 MCP 之外的直连面;不信任外部系统自报 risk(沿用 5.5-5 Risk display 原则)

> **2026-09-13 完成(docs/54)**:统一外部接入落地 —— `ExternalToolCatalog`(外部系统
> 身份/分类/声明式 tool 清单 + 平台侧 risk,`resolvePolicy` 只认 (serverId,toolName)、
> 对远程自报元数据零信任;未知 tool 一律 DENY)+ `ExternalEngineeringConnector`
> (连接/发现走既有 `MCPToolRegistry` 冻结可见性链;映射经 5.5-2 `MCPToolAdapter` +
> `toUnifiedToolDefinition`,schema 单源、权限门/审批门/零请求语义全部复用);
> 外部动作统一输出 5.7-0 ActionResult + 不受信 result 数据(结构化脱敏);凭据只以
> credentialRef 存在(ref→既有 resolver→连接,secret 零进结果/审计);mock 外部工程
> 系统(真实 MCP stdio)+ credentialRef 真实 Streamable HTTP 注入 E2E;prompt
> injection / hostile markdown / fake system message 等敌意载荷全部以惰性数据通过。
> mcp 232/232、server 53/53、全仓 591/591,四门禁 exit 0。

### 5.7-3 Action Policy(统一风险策略)

- [x] 统一风险映射表(GUI 动作 + 外部系统动作在同一词表:LOW/MEDIUM/HIGH 冻结表,测试锁定)
- [x] approvalRequired 派生(复用 workflow-engine WAITING_APPROVAL 链,不建第二套审批)
- [x] 审计(audit 走 ToolCallRecorder 现状;零第二套事件体系)
- [x] 风险策略不信任动作自报(与 5.5-5 原则一致)
- [x] 高风险动作(发布 / 提交 / 删除)默认 HIGH + 需人审

> **2026-09-13 完成(docs/55)**:统一 Action Policy 落地 —— 新包 `@ai-se/action-policy`
> (唯一政策引擎:冻结 verb floors 表 LOW/MEDIUM/HIGH + 浏览器动作白名单;`resolve` 统一入口;
> `applyActionPolicy` 组合期执行 + `withApprovalGate` 执行期门;`approvalRequiredFor` 派生)。
> Browser 与 External 动作同表同语义:浏览器风险来源改为政策(未知动作拒建);外部侧
> catalog 仅是输入,政策为最终决策(误声明 LOW 被升至 HIGH+审批,零请求拒绝)。审批零第二套:
> 派生 approvalRequired → 既有 workflow-engine WAITING_APPROVAL 链(真实 PG E2E:拒绝零 MCP
> 请求 / 批准真实执行);动作级复用既有 approval gate 与 `metadata.approved` 约定。审计零第二套:
> ToolCallRecorder + ToolResult.audit(risk 来自政策)+ 审批事件,toolCallId 可关联。
> action-policy 13 例、browser 38、mcp 235、server 57、全仓 615/615,四门禁 exit 0。

### 5.7-4 Evidence & Verification

- [x] EvidenceRecord 契约(action / target / before / after / result / screenshotRef / externalId)
- [x] Evidence 持久化(database migration 009,对照 phase5 惯例:checksum)
- [x] 关键外部动作前后 Observation 对(before/after 必备)
- [x] 外部动作验证(执行前后一致性判定:复用 5.6-4 三态思想,不新建评分体系)
- [x] Evidence 查询 API(server 路由,最小 REST 面)
- [x] 凭据零明文(Evidence 内容过 redactCredentialShapedText;测试反例锁定)

> **2026-09-13 完成(docs/56)**:统一 Evidence 落地 —— 契约块全部复用既有定义
> (actionRef / Observation / ActionResult 为 5.7-0 原样;`screenshot://` 引用锁前缀,
> 大图零内联;workflowRun / task / agentRun / toolCall 既有 id 关联)。持久化:
> migration 009 `evidence_records`(JSONB + 关联 FK + checksum 机制延续),
> `PgEvidenceRepository` create/read + 过滤。捕获链(browser / external 同一模型):
> before 真实观察 → ToolRuntime 动作 → after 真实观察(→ 5.6-3 截图引用)→ 验证
> (冻结 VERIFIED/FAILED + findings,不新建评分)→ EvidenceRecord;失败动作 / 期望
> 未达成均保留失败事实。API 最小只读面(list/detail;跨项目 403 零载荷)。凭据:
> 单一脱敏 sink(既有 redactCredentialShapedText / redactString),记录 / 数据库 /
> API 三层反例锁定零明文。evidence 9 例、shared 46、database 37、server 68、
> 全仓 646/646,四门禁 exit 0。

### 5.7-5 Failure Recovery

- [x] 失败分类冻结表(ELEMENT_MISSING / LOGIN_EXPIRED / NETWORK_FAILED / UI_CHANGED / TIMEOUT / CANCELLED)
- [x] re-observe(失败后重新观察,复用 5.7-1 观察面)
- [x] retry(复用 workflow-engine 现有 retry 链:retryCount / policy.maxRetries,不建第二套)
- [x] re-plan(失败重规划:milestone 映射 5.6-5 FixLoopState 同构,不建新循环器)
- [x] human intervention boundary(连续 N 轮失败或 HIGH 风险 → 转人审批,STALLED 语义延续)
- [x] 失败测试(harness 触发各失败类 → 分类正确 → 状态面推进锁定)

> **2026-09-13 完成(docs/57)**:统一失败恢复落地 —— 新包 `@ai-se/failure-recovery`
> (冻结 6 类分类器 + UNKNOWN 安全兜底;浏览器交互失败由 re-observe 细化:登录墙/UI 漂移/元素缺失;
> 冻结路由表 RETRY/REPLAN/HUMAN/FAIL + 停滞阈值镜像 5.6-5)。引擎新增可选 `failureRouter` 钩子
> (默认路径零行为变化):RETRY/REPLAN 走既有链;HUMAN 复用既有 approval 实体 + WAITING_APPROVAL
> (`FAILED→RETRYING→WAITING_APPROVAL`);每次重试重新经 ToolRuntime/Action Policy/审批门/审计;
> 每轮 5.7-4 证据落库、失败不删除、round 可追踪;re-observe 失败=显式事实(不伪造 after)。
> 真实 E2E 10/10(Chromium + MCP stdio + PG + WorkflowEngine:六类分类 / 重试成功 / 耗尽 / 停滞 /
> REPLAN 成功与失败 / HIGH 批准执行与拒绝零请求 / CANCELLED 单次)。failure-recovery 16 例、
> workflow-engine 19、server 78、全仓 677/677,四门禁 exit 0。

## V1 Final System Acceptance（2026-09-13）

> **AI-SE V1: ACCEPTED（docs/58）**
>
> - Full Quality Gate:typecheck / lint / test / build 全部 exit 0;全仓 **111 文件 / 682 测试,
>   0 failed / 0 skipped**;migration fresh environment + checksum 守卫(应用/幂等/篡改拒绝)
>   真实通过;真实 PostgreSQL / Docker Sandbox / Chromium / MCP stdio+HTTP。
> - Golden Scenario(真实执行):PRD → Planning → Specifications → Task DAG → Dynamic Workflow
>   → Multi-Agent 开发 → 真实 QA 失败 → 动态 Re-plan(DEBUG + RETRY)→ Review → CI(local 真实)
>   → Staging(真实容器 + 健康检查)→ 人工审批 → Production;同轮真实验证 pause/resume、
>   cancel、server-restart recovery;SSE / Agent Registry / 浏览器截图资产均在链路内验证。
> - 判定:**Technical Regression = PASS / Dynamic Workflow = PASS / Product Usability = PASS**;
>   无阻塞架构问题、无阻塞安全问题。
> - 外部验证(单独标记,不阻塞):VLM / Figma / GitHub / GHCR / Production =
>   **BLOCKED BY EXTERNAL CONFIG**(凭据/目标环境缺失,复查确认;未伪装 PASS)。
> - Usability 发现与 Technical Debt(TD-1 ~ TD-17)见 docs/58 §8/§9(只记录,不隐藏)。

## V1 Real AI Validation

> 本阶段不是功能开发阶段，而是对 AI-SE V1 的真实 AI 决策能力进行黑盒验收。
>
> **勾选依据**：`docs/198-v1-real-ai-validation-census.md`（2026-10-20 全库只读普查，零配额）。
> 下方 12 项即该普查的对象。
> **三个子节的普查已完成**：`docs/226-phase-v1-real-ai-validation-census-2.md`（2026-10-23，
> 同口径、零配额）——17 项中 **12 项已勾**，5 项因外部环境阻塞维持不勾（见各子节与节末 STOP）。

- [x] Real Planner LLM —— 807 次 `planning-agent` run（`PLANNING_STARTED` 807）；真模型路径
      `apps/server/src/index.ts:147-159`；**用量未落账**（`docs/198` §16.4）
- [x] Real Agent LLM —— `professional-deep-agent` 2,911 次 run，其中 2,753 次带真实 `token_usage`
- [x] Real Tool Calling —— 63,213 次 `tool_calls` / 16 种工具，成功与失败混合
- [x] Real PRD → Planning —— E1 的 `raw_content` 8,445 字符真 PRD；`PlanningGraph.ts:257`
      把它放进 `inputForStage` ⇒ 确实进了各阶段提示词
- [x] Real Planning → Task DAG —— 7,082 条 `task_dependencies`；`TASK_DAG_VALIDATION_STARTED` 1,921
- [x] Real Multi-Agent execution —— 7 个职业 agent 各有真实 run（qa 1,087 / backend 985 / planner 444 / …）
- [x] Real Code generation —— `write_file` 2,054 成功 + `edit_file` 1,634 成功；`agent_artifact_created` 21,941
- [x] Real Test execution —— `run_unit_test` 9,475（6,757 成功 / 2,615 失败）+ `run_build` 6,276
- [x] Real failure —— 230 个 FAILED 任务、51 CANCELLED
- [x] Real Dynamic Re-plan —— `origin='DYNAMIC'` 107 条（`-REPLAN-` 66 + `-DEBUG-` 61）
- [x] Real recovery —— 沿链走到头：16 条终点 SUCCESS（真救回，PL-M19 语义）
- [x] Real final delivery —— 批次 `l1-m4u`（10-22）**三次运行各有一次真实 production 部署**：
      `88aa62ef` / `790253df` / `aff03c39`，镜像 `ai-se-app:fe8ca24a…` / `ab1bbf03…` / `d4c6025d…`，
      `deployment` 行 SUCCESS，任务 `output` 带 `deploymentId` / `ciRunId` / `gitCommit` / `endpoint`，
      第三跑的 `/health` 与 `/ready` 各 200。
      **批准主体＝eval harness**（PL-M33 / `docs/216`：harness 代行评测里的那个「人」，每次计入
      `humanInterventions`），**不是真人点击**——本项判「已行使」，按此口径（用户 2026-10-23 裁定）。
      staging 段同批按 N-36 修正规则复算 **3/3**；历史 staging 真交付另有 `716eb98d`（10-19）/
      `57f98bf9`（10-14）。

### Dynamic Workflow

- [x] 无人工修改 Task —— 平台**没有任务编辑端点**（写操作端点仅 create/analyze/start/policy/
      cancel/retry/approve/reject/rollback）；`l1-m4u` 受测窗口内人工动作只有 4 次审批，全 `APPROVED`
- [x] 无人工修改 Workflow —— 人工动作只有 pause/resume/cancel/retry，**都不是修改**；
      `WORKFLOW_PAUSED` 全库仅 2 次、`WORKFLOW_RETRIED` 6 次，均不在 E1/L1 窗口内
- [x] Failure 自动产生新任务 —— `origin='DYNAMIC'` **257** 条（`-DEBUG-` 149 / `-REPLAN-` 107）；
      运行时注入依赖边 **552** 条
- [x] Re-plan 改变执行拓扑 —— `task_dependencies` 中 **233 条 `active=false`**（replan 停用原出边）
      ＋ 552 条新边；`REPLAN_STARTED/COMPLETED` 各 128；**深度有界**（最深 2 层）
- [x] Retry / Recovery 正常 —— 沿 `resolved_by_task_id` 链走到头：**65 条终点 SUCCESS**（真救回）；
      更直接的配对：**DEBUG SUCCESS + 配套 REPLAN SUCCESS 共 46 对**
- [x] 无死循环 —— `WORKFLOW_DEADLOCK` **0** 条；replan 最深 2 层；嵌套诊断 9 条**全部早于**
      N-29 修复（PL-M30，10-21），之后为零

### AI Decision Validation

- [x] Planner decision verified —— 规划产出被逐条校验：`TASK_DAG_VALIDATION_FAILED` **1,789**、
      `PLANNING_REPAIR_REQUESTED` **1,207**；拒绝理由具体到规则（交付结构 1,719+1,713 / N4 207 /
      越界 119 / PL-M1 63 / 全局 AC 9）
- [x] Agent tool selection verified —— 工具画像与职责一致：backend 读 10,493 + 单测 5,928 + 写 4,440；
      qa 读 9,186 + 单测 4,856；devops 以 build/lint 为主；**reviewer 与 planner 以只读为主**
      （reviewer 写 19 / 读 3,270；planner 写 28 / 读 2,983——**不是「零写入」**，见 `docs/226` §3）
- [x] Agent code modification verified —— `write_file` **3,087** 成功 / `edit_file` **3,304** 成功；
      写入之后过验证门：`verdict` **verified 1,680** / unavailable 484 / failed 199
- [x] Agent failure recovery verified —— 46 对「诊断 SUCCESS + 重试 SUCCESS」；诊断结论以
      `fixTaskType` 交接给重试任务（N-29 语义）
- [x] 3 次独立运行 —— 批次 `l1-m4u` 三次运行、各 4 个 `workflow_runs`、**提交互不相同**
      （`fe8ca24a` / `ab1bbf03` / `d4c6025d`），三次均 `chainCompleted` + `oraclePassed` + `deliveredSuccess`

### External Environment

- [x] Real LLM —— `.env`：`LLM_PROVIDER=openai`（`deepseek-v4.1-flash`）；
      `professional-deep-agent` **3,611** run（3,438 带用量）、`planning-agent` **842** run
- [ ] Real VLM —— **BLOCKED BY EXTERNAL CONFIG**：生产代码无 VLM 调用；`vlm` 只出现在**未接线**的
      `packages/visual` 与 `visualFixLoop.ts`
- [ ] Real Figma —— **BLOCKED**：只在未接线子树的 schema / 分析器里出现，无任何 REST 调用记录
- [ ] Real GitHub —— **BLOCKED**：`CI_PROVIDER=local`、`GITHUB_TOKEN` 未配置；`ci_runs` 18 条全为本地适配器
- [ ] Real GHCR —— **BLOCKED**：`deployments` 26 行镜像**全为本地 `ai-se-app:<sha>`**
- [ ] Real Production —— **不勾**：`l1-m4u` 三次 production 部署**真实成功**（真镜像、
      `/health` 与 `/ready` 各 200、有 `deploymentId`），但目标是**本地 Docker**（`127.0.0.1:18081`），
      远程生产仍缺目标环境

> **未开始事项（STOP）**：三个子节的普查**已完成**（`docs/226`）。剩余 5 项不勾，
> **全部是外部环境阻塞**（VLM / Figma / GitHub / GHCR / 远程生产），与 `docs/58` 的
> `BLOCKED BY EXTERNAL CONFIG` 一致——**不是平台侧工作**。
> 另：主表第 12 项 `Real final delivery` 的阻塞条件**已消失**（`l1-m4u` 三次 production 部署成功），
> 用户 2026-10-23 裁定**按「审批门被真实走通」口径勾选**，并在条目内写明**批准主体是 harness**
> 而非真人（`docs/226` §5）。

## Post-V1 Enhancements — 前端可用性改造（W1–W10）

> 任务书 docs/132；实施记录 docs/133–142。本节是 `apps/web` 改造的**唯一验收落点**。
> 每个阶段独立验收、独立停机（`AGENTS.md` §9）；未完成的阶段必须留空并写明 STOP。

### 通用门槛（每阶段收尾必跑）

- [x] `typecheck` exit 0
- [x] `lint` exit 0
- [x] `test` 全绿（W1 起 320/320；W1 修复了开工前既有的 4 个失败）
- [x] `build` exit 0

### W1 · 诊断核对与基线归零（docs/133）

- [x] 逐条复核审评的 8 条问题，给出成立 / 不成立 + 文件行号证据
- [x] 补上审评未覆盖的问题（测试基线本就是红的）
- [x] 精确匹配重算 legacy 类与死 CSS 的真实引用数
- [x] 基线红灯修复（4 处 `PageHeader` eyebrow 断言漂移）
- [x] 给出投入产出比最高的 3 个改动

### W2 · 拆除双样式体系（docs/134）

- [x] `styles.css` 逐条清点三类归置（迁移 / 删除 / 进 base）
- [x] 零引用的死类精确确认后删除（96 个类选择器全部零引用）
- [x] 全局 `a` 规则改为默认继承颜色，不把品牌色强加给所有链接
- [x] 删除 `styles.css` 本体与 `main.ts` 的引入
- [x] 17 处对抗补丁全部删除
- [x] 层级顺序建立（base → components → utilities）
- [x] 测试断言同步（本次实际为 0 处改动，已说明原因）
- [x] 外观零变化经浏览器计算样式逐项实测

### W3 · 重建设计令牌与排版（docs/135）

- [x] 字体裁决并落地（系统字体栈），数字等宽实测
- [x] 间距 4px 单一刻度
- [x] 字号收敛到 6 档，每档明确字号 / 行高 / 字重与用途
- [x] 圆角 3 档 / 边框 2 档 / 阴影 1 档 / 焦点环统一 1 档
- [x] 语义色 5 族 × bg / border / foreground + 墨色，逐项实测对比度
- [x] 亮色 + 暗色两套，`:root` 声明 `color-scheme`
- [x] 断点统一为 Tailwind 具名档，任意断点清零
- [x] 一次性任意值清剿（W10 门槛三类归零）
- [x] 交付 `apps/web/src/styles/README.md`
- [x] `docs/design/00-design-system.md` 回写并标注已废弃项

### W4 · 重建 AppShell 与信息架构（docs/136）

- [x] 侧栏 8 个图标真正渲染（消除死代码），并加防回潮断言
- [x] 选中态改为背景 + 文字色 + 图标色同时变
- [x] 分组计数取 store 真实数据（工作流失败数）；为 0 / 未加载时不显示
- [x] 侧栏可折叠并持久化（164 ↔ 64px，localStorage）
- [x] 顶栏面包屑（分组 / 页面 / 对象，取不到则不显示该段）
- [x] 全局搜索入口（Cmd / Ctrl + K 命令面板，页面 + 已加载实体）
- [x] `PageContainer` 两档宽度（1200 / 1440），11 页全部套用，裸 `<section>` 归零
- [x] 侧栏保持 sticky 固定（`appShell.test.ts` 断言原样保留）
- [x] 命令面板判断逻辑下沉到 `viewmodels/` 并可单测
- [x] 通知入口 / 用户菜单占位 —— **裁定不做，本项关闭**（2026-10-15 用户）：应用无用户模型与通知数据源，理由见 docs/136 §2.5。后续清单不再列它

### W5 · 统一页面骨架（docs/137）—— 已完成（10/10 页）

- [x] 定义「列表页标准骨架」并写下（`apps/web/src/styles/README.md` §14）
- [x] 定义四种状态并给出共享件：`LoadingSkeleton` / `TableSkeleton` / `ErrorState`（空态沿用 `EmptyState`）
- [x] `PageHeader.eyebrow` 删除（11 页零使用；`SectionHeader` 的同名 prop 保留）
- [x] 参考实现 `ProjectsView`：收敛到 Dialog、四态统一、scoped 块归零、任意栅格消除
- [x] 列表页默认分页定为标准（README §14）；`ProjectsView` 已补 `v-model:page` + `:page-size="10"`（**W7 起由组件默认值承担，页面不再传参**）
- [x] 逐页套用 **10/10**：Projects / Deployments / Requirements / Workflows / AgentRun / Agents / MCPServers / MCPServerDetail / ProjectDetail / MCPApp
- [x] 未分层 scoped 块 10 → **2**（Deployments 的 `[data-active]` 强调条 + Dashboard 的 W6 待办）
- [x] 24 处 `grid-cols-[…]` 消除 17 处（14 + 3 收敛进 `DetailRow`），剩 7 处 4 种布局模板并记录理由
- [x] `MCPServerDetailView` 补空态分支（原先白屏）、`MCPAppView` 补加载分支
- [x] `@layer components` 从空层补上两条跨页复用样式：`.detail-row` / `.tone-dot`
- [x] 删除 2 段死代码 CSS（`.mcp-checkbox input`，匹配不到任何元素）与 9 个无样式标记类
- [x] 任意值 `text-[…]` / `rounded-[…]` / `min-[900px]` 全部归零

### W6 · 仪表盘去海报化（docs/138）—— 已完成

- [x] 指标数字复核为 `--text-metric`（28px / 600）
- [x] 删除交付流水线圆点轨道（`nav.dashboard-rail` + `.dashboard-dot` + 连线）
- [x] 删除整套入场动画（4 段 `@keyframes` + 逐项 delay）
- [x] 连带删除 2 处 `!important`（动画的 `prefers-reduced-motion` 守卫）—— 生产代码归零
- [x] 四块信息各自包 `Card`，建立表面层级
- [x] 首屏按「用户会问的问题」重排：① 需要处理 → ② 正在运行 → ③ 最近的动态 → ④ 总量统计
- [x] 数字的颜色只在非 0 时使用状态色；① 全为 0 时换成一句平静的话
- [x] 口径写进 `workflowViewModel` 并有单测：关注 = FAILED+WAITING_APPROVAL+PAUSED，推进 = RUNNING+PENDING
- [x] 工作流三块共享一个加载/错误 gate（错误不再重复三遍）
- [x] 补 `PageHeader`（仪表盘原是全站唯一没有 `<h1>` 的页面）
- [x] `DashboardView` 的 scoped 块删除 → 全仓未分层 scoped 块 **1 个**
- [x] `gap-14`（56px）改用统一的 `--section-gap`
- [x] 「最近项目」表已替换为「最近工作流」（**2026-10-15 用户裁定保留现状**，见 docs/138 §三）

### W7 · 表格与数据展示规范（docs/139）—— 已完成

- [x] 列对齐规则落地并写进组件注释：文本左 / 数字·时间·时长右 + 等宽数字 / 状态徽标统一 / 操作右
- [x] `Table.vue` 的 `text-center` 移除（浏览器实测居中单元格为 **0**）
- [x] `align: "right"` 自动附带 `tabular-nums`；页面不再自己写对齐（`cellClass` 只用于列宽）
- [x] 点击表头排序（三态：升序 → 降序 → 取消）+ `aria-sort`；逻辑下沉 `components/ui/table/sort.ts` 并有 16 条单测
- [x] 排序取值默认 `row[key]`，嵌套字段用 `sortValue`；空值恒排末尾；不改入参、稳定排序
- [x] **分页默认打开**：`Table` 的 `pageSize` 默认 `0` → **10**；5 个列表页删除显式传参
- [x] 摘要表（`DashboardView` 最近工作流）显式 `:page-size="0"` —— 全站唯一传参处
- [x] `AgentRunView` 7 列 → **5 列**（状态 / 任务 / 来源 / 尝试·用时 / 操作），`min-w-275` → `min-w-240`
- [x] 操作列 3 个平级按钮 → 2 个（详情 + 条件渲染的取消）；**未采用「更多菜单」**并记录理由
- [x] 「复制 ID」改为 ID 文本本身可点复制（新组件 `CopyableId` + `composables/useCopyToClipboard`）
- [x] `composables/` 目录首次建立（AGENTS §5 规划的四个目录全部落位）
- [x] `TableColumn` 泛型化（`TableColumn<T>`），6 个调用点标注行类型
- [x] 长文本规则写明：主标识换行 / 次要字段截断 **且必须带 `title`**（4 处截断全部补齐）
- [x] 虚拟滚动、固定表头、行选择 + 批量操作、列显示隐藏、每页条数切换 —— 逐项评估并给出「不做」的理由
- [x] 发现并记录「不含 Tailwind preflight ⇒ 原生 `<button>` 带 UA 外观」这一坑，两处新按钮显式规避 + 护栏测试 + README §0 说明
- [x] 测试 381 → **412**（+31）；CSS 26.88 → 27.34 kB
- [x] `styles/README.md` 新增 §15「表格：对齐、排序与长文本」
- [ ] 排序状态不持久、不进 URL（记录为已知项，未做）
- [ ] 状态列按枚举字符串排序，**不是**业务优先级（记录为已知项，未做）

### W8 · 交互容器规范（docs/140）—— 已完成

- [x] 容器选择规则成文（`apps/web/src/components/README.md`）：`Dialog` / `ConfirmDialog` / `Drawer` / 独立路由页 的判据
- [x] 「Drawer 还是路由页」的分界写明：判据是「是不是列表某一行的展开」，不是「内容多不多」
- [x] 给出**逐页动作表**（11 个页面 × 每个动作该用哪种容器）
- [x] 项目页复核：W5 已把常驻 360px 左栏表单收进 `Dialog`，本次通过、未再改动
- [x] 新增 `ConfirmDialog`（`description` 类型必填；确认按钮实心 danger；失败不关闭并把原因显示在框内）
- [x] **三种确认机制收敛为一种**：行内二次确认（1 处）+ `window.confirm`（2 处）→ 全部 `ConfirmDialog`
- [x] `views/` 内 `window.confirm` 归零（新增护栏测试扫描）
- [x] 危险操作确认判据成文：**不是「看起来危不危险」，而是「救不救得回来」**（含三条刻意不确认的类别与理由）
- [x] 危险按钮两档语义色：触发点 `ghost` + `text-danger`；执行点 `destructive`；新增护栏测试扫描全部 `<Button>` 开标签
- [x] 护栏测试**当场抓到 2 处既有违规**并修正：`ProjectsView` 的「删除」无 danger 色、`RequirementsView` 的「拒绝并重做」是 secondary
- [x] 键盘四项（Esc 关闭 / 焦点进入 / 焦点返回触发元素 / 模态不逃出）由 Reka Dialog 原语提供，**浏览器逐项实测确认**
- [x] **Cmd / Ctrl + Enter 提交表单**：新增 `composables/useModEnterSubmit`，走 `requestSubmit()` 以保留原生校验；**9 / 9 表单全部挂上**
- [x] 测试 412 → **430**（+18）；CSS 27.34 kB 无变化（未引入新工具类）
- [ ] `RequirementsView` / `AgentsView` 的详情抽屉未同步 URL（规则已写，标注待补，**未修**）
- [ ] 未给「取消运行 / 取消工作流」加确认（判据判为「可恢复」，记录为已知项）

### W9 · 可访问性与韧性（docs/141）—— 已完成

- [x] `index.html`：`lang="en"` → **`zh-CN`**；title 复核（原本已合规，未改）
- [x] favicon：`data:,` → **真实 SVG 图标**（新建 `apps/web/public/favicon.svg`，主色 + `>_` 提示符）
- [x] 补 `<meta name="description">` 与 `<meta name="color-scheme" content="light dark">`（后者修掉「滚动条/原生控件在暗色下仍是亮的」）
- [x] **状态三重冗余**：`StatusBadge` 六个 tone 各一枚**形状不同**的图标（对勾 / 弧 / 虚线圈 / 三角 / 叉 / 短横）；图标 `aria-hidden`
- [x] 隐藏 `showIcon` 出口（默认显示；当前 64 处调用无一关掉）
- [x] 加载态复核：W5 已完成，页面级加载态全部是骨架屏（剩余唯一的「加载中…」是按钮忙碌态）
- [x] **对比度实测 28 组 × 2 模式**：各 25 组达标、3 组按 WCAG 条款豁免、**0 组未达标**；数值写进 `styles/README.md` §9
- [x] **非文本对比度裁决**：`--input` 判为真实缺陷并修正（1.54 → **3.41 / 3.14:1**）；`--border`（装饰性）与 `--foreground-disabled`（SC 1.4.3/1.4.11 明确豁免）维持原值并附条款
- [x] 删除零使用的 `--border-strong`（它与旧 `--input` 同值，留着会让本次缺陷回潮）
- [x] **焦点环逐元素实测**：仪表盘 15 个可聚焦元素全部有可见指示
- [x] 暗色模式：两套模式对比度全部达标或豁免；状态徽标取暗色令牌
- [x] icon-only 按钮全部有可访问名称（浏览器实测无名元素为 0 + 源码护栏测试）
- [x] 表格语义 `<th scope="col">` + `aria-sort`（W7 已完成，本次浏览器复核通过）
- [x] 全局搜索键盘可完整操作：`Cmd/Ctrl+K` 打开、方向键移动高亮、`Esc` 关闭
- [x] 测试 430 → **443**（+13，新增 `accessibility.test.ts`）；CSS 27.34 → **27.24 kB**
- [ ] **未跑自动化 a11y 扫描器、未用真实屏幕阅读器**（未新增依赖；只做了结构与属性静态核对）
- [ ] **不声称「全站符合 WCAG」** —— 结论限定为「计划点名的九项逐项实测通过」
- [ ] 未做 200% 缩放 / 强制高对比度模式测试（SC 1.4.4 / 1.4.12，不在工作项内）
- [ ] `--input` 在 `--muted` 面上仍为 2.90–2.97:1（当前无表单控件落在该面）

### W10 · 终验（docs/142）—— 已完成

**第一步 · 6 项机械检查**

- [x] ① `styles.css` 文件已删 + 生产文件零引用
- [x] ② 生产代码 `!important` **0 处**（唯一 grep 命中是注释）
- [x] ③ 固定像素一次性值（`w-[240px]` / `text-[72px]` / `rounded-[4px]`…）与任意断点（`min-[900px]:`）**归零**；剩余 arbitrary value 只有「视口钳制」与 `var(--token)` 两类，逐条列明
- [x] ④ legacy 类名 **class 属性里 0 处**（点名 13 + 额外反查 5）；命中全在注释；`eyebrow` 仅剩 `SectionHeader` 的活 prop
- [x] ⑤ `text-decoration: none` 在 `views` / `components` 中 **0**
- [x] ⑥ 四条门槛命令全绿 + 全仓 16 包 typecheck / lint / test 全绿

**第二步 · 逐条对照 8 条原始问题**

- [x] 1 双样式体系已拆 → **已解决**
- [x] 2 营销落地页视觉语言 → **已解决**（含 `00-design-system.md` 已在 W3 回写）
- [x] 3 legacy class 残留 → **已解决**
- [x] 4 新建/详情/删除容器跨页一致 → **已解决**
- [ ] 5 表格扫读 → **部分解决**（列对齐/排序/分页 ✓；**表头固定未做**，评估理由记 README §15）
- [x] 6 侧栏图标与计数、顶栏面包屑与全局搜索 → **已解决**（浏览器实测）
- [x] 7 可访问性（lang/对比度/焦点/状态冗余/暗色）→ **已解决**（范围有边界，不声称全站 WCAG）
- [x] 8 测试断言同步、测试全绿 → **已解决**

**第三步 · 诚实报告**

- [x] 三条主观标准实测：标准 2、3 **已解决**；**标准 1 部分解决**（1440×900 下第 5 行底边 915px vs 视口 900px，**差 15px**；未在验收阶段改版式，附 3 条候选修法）
- [x] 未解决 / 部分解决项、偏离计划处、只属推测未实测的结论——三张表逐条列明
- [x] W1–W10 累计变化表（scoped 块 11→1、`grid-cols-[` 24→7、`!important` 2→0、CSS 36.51→27.24 kB、测试 23 文件→36 文件/446 用例）
- [x] 附加清理：`.taste-skill/` **移出仓库**（到 `/tmp/ai-se-taste-skill-archived/`，非删除——无 git，留回退路径）

**W10 额外清剿的 5 个死类名**（不在计划点名清单里，靠「产物 CSS 里找不到规则」反查得出）

- [x] `nav-link` / `nav-link--active`（侧栏）→ 删除，测试改用 `aria-current="page"`
- [x] `agent-link`（Agent 页）→ 删除，测试改用 `href`
- [x] `mcp-action-link` ×2（MCP 详情页，与 `buttonVariants` 完全重复）→ 删除
- [x] `requirement-dependencies`（需求页）→ 删除
- [x] 新增自动化护栏：剥离注释后扫描全部 `class="…"`（18 个类名）

**收口状态**：W1–W10 全部完成。计划 §6 的边界自始至终未越过（未改后端 / 未改接口契约 / 未改写文案 / 未新增运行时依赖 / 未动 `dist/`）。

**待你确认的两项**

1. W6 把仪表盘的「最近项目」表换成了「最近工作流」（见 docs/138 §三）。
2. **5 个「新建」类弹窗没有可访问描述**（终验时从 dev server 日志里发现，此前一直被 `console.warn` 过滤掉）：项目 / 需求 / 运行 / 工作流的新建框 + 部署的环境设置框，只传了 `title` 没传 `description`。不是错误（属性被移除而非留悬空引用），但屏幕阅读器只能读到标题。修法二选一：给这五个弹窗补说明文案（属内容变更，待你定）/ 在 `Dialog.vue` 里显式处理（只让告警闭嘴，不补描述）。见 docs/142 Known Issues 4。

### W11 · 前端收尾（路由分割 / 抽屉深链接 / 无障碍扫描器）

**W10 登记的遗留项，本轮清了四项**

- [x] 路由级代码分割 —— 13 条路由改动态 import，入口 chunk 569.62 → 65.94 kB，build 警告消失
- [x] `RequirementsView` / `AgentsView` 详情抽屉同步 URL（`?requirement=` / `?agent=`）—— 四个抽屉现已全部同步
- [x] 200% 缩放（SC 1.4.4）/ 强制高对比度 / 文本间距（SC 1.4.12）三阶段实测 —— 13 条路由零违规、零水平溢出
- [x] 接入 axe 自动扫描器（`pnpm --filter @ai-se/web a11y`）—— 13 路由 × 4 阶段

**扫描器首轮查出的两条真实违规（W1–W10 全程未发现），均已修复并复扫全绿**

- [x] `WorkflowsView` 两个筛选下拉无无障碍名称（axe `button-name`，critical）—— `combobox` 不支持 name from content，补 `aria-label`
- [x] 顶栏搜索按钮 `aria-label` 与可见文字不符（axe `label-content-name-mismatch`，serious / SC 2.5.3）—— 删 `aria-label` + `sr-only sm:not-sr-only`，顺带修掉窄屏下按钮无名

**W10 遗留的版式项**

- [x] 仪表盘 1440×900 首屏第 5 行差 15px —— 采纳候选①（①② 指标卡并排），实测 5 行全部完整可见

**本轮仍未做（明确登记，不假装做了）**

- [ ] 5 个「新建」类弹窗没有可访问描述（**需你先定**：补文案 / 让告警闭嘴）
- [ ] 表头 sticky（W7 评估后判不做，理由见 `styles/README.md` §15）
- [ ] `showIcon` prop 零使用
- [ ] `--input` 在 `--muted` 面上的 2.90:1（当前无控件落在该面）
- [ ] 首屏 LCP / 压缩后传输量（本轮只测了未压缩字节数）
- [ ] axe 未覆盖详情页的数据态、弹窗与抽屉打开态（扫的是示例参数，落的错误态）
- [ ] 真实屏幕阅读器走查（VoiceOver / NVDA）

**边界**：未改后端、未改接口契约、未改写可见文案、未新增运行时依赖、未动 `dist/`。

**待你确认的一项**：W6 把仪表盘的「最近项目」表换成了「最近工作流」（见 docs/138 §三）—— W11 未回退，默认保留。

### W12 · 前端遗留项收口（弹窗描述 / showIcon / 勘误 / 审批意见）

**W10 登记、W11 未清的四项，本轮清了四项**

- [x] 5 个弹窗补可访问描述（项目 / 需求 / 工作流 / 运行的新建框 + 部署的环境设置框）—— 5 页 × 3 项真实浏览器实测全 PASS，reka-ui 的 `Missing Description` 告警在 5 个页面消失；`uiComponents.test.ts` 新增「每个 `<Dialog` 都必须带 description」护栏（含防空扫描计数）
- [x] 删除零使用的 `showIcon` prop（`StatusBadge`）—— 默认值本就是 `true`、64 处调用全用默认值，渲染输出不变；随 prop 删掉对应用例
- [x] `docs/142` SC 编号勘误 —— 「强制高对比度」被标为 SC 1.4.12，而 1.4.12 是 Text Spacing；在 §3.2 表格后追加勘误引用块，**原判定与结论一字未动**
- [x] `WorkflowsView` 审批「拒绝」补修改意见 —— 改走统一 `ConfirmDialog`（默认插槽装 textarea），`decide` 增 `comment` 参数与 `Promise<boolean>` 返回值；**批准保持一键不套确认框**

**本阶段逐条裁定的其余 7 项**

- [x] W6「最近项目」→「最近工作流」—— **裁定保留现状**（正中 W6「从陈列改成分诊」的立意，项目视角由 ④ 承担）
- [x] `--input` 在 `--muted` 面上 2.90:1 —— **判不改**，只记文档（改它会动 64 处已验证对比度；自动配对扫描会给出虚假安全感）
- [x] 表头 sticky —— **维持 W7 的不做判定**（第三次评估，理由未变）
- [x] 仓库 420 文件不合 Prettier —— **判不格式化**（本仓无 git ⇒ 不可回退；234/420 在 `packages/eval`，属无关重构）
- [ ] axe 覆盖详情页数据态 / 弹窗态 / 抽屉态 —— **押后**（独立批次，改的是扫描器契约）
- [ ] 真实屏幕阅读器走查（VoiceOver / NVDA）—— **押后**（同一批次，计划以 a11y 树快照作可审阅替代品）
- [ ] X1 前置「密钥存哪儿」—— **已裁定但未实施**：`MCPCredentialResolver` 经核实是**零实现、零接线**的接口，`docs/15` 说的「复用既有 Secret Provider」无从复用。裁定走**内存态运行时覆盖**（不落库 / 不落盘 / 不进日志），并先交付 `envCredentialResolver` + 组合根注入，见 docs/144 §七

**门槛**：`apps/web` typecheck ✓ / lint ✓ / **test 450/450** ✓ / build ✓ / **a11y 零违规** ✓；全仓 typecheck ✓ / lint ✓ / test **1438/1438**（16 包 / 175 文件，1436 → 1438）✓；真实后端 + 真实 Chromium 走查 **30/30** ✓。

> 一条保留：全仓 `-r run test` 的**单次调用**出现过两次「一条时序敏感的服务端 e2e 失败」，两次是不同文件、单独复跑都通过（机器负载所致，本阶段未碰 `apps/server`）。1438 来自按包复核。见 docs/144 Known Issues 9。

**边界**：未改后端、未改接口契约、未新增运行时依赖、未新增 migration、未动 `dist/`。**新增了 6 句可见文案**（5 句弹窗描述 + 1 句确认框描述），已逐条列出待过目。

**仍待你确认的一项**：W12 下裁定保留的 W6 仪表盘内容变更（「最近项目」→「最近工作流」）—— 若你要回退，说一声即可。

> 上面三项押后项的处置：axe 覆盖扩展与 X1 前置 **已在 W13 完成**；真实屏幕阅读器走查 **W13 以「朗读转录」作可审阅替代品，并随后由用户裁定不再安排人耳走查**（本项就此关闭，见 docs/145 §三）。见下节。

### W13 · 无障碍扫描器扩展 / 屏幕朗读转录 / X1 模型与凭据配置

**W12 押后的两项 + X1，一批做完**

- [x] **axe 扫描器扩展 4 个阶段** —— `axe/data`（参数化路由改用运行时发现的**真实 id**；此前每个详情页都是在错误态下被扫的）、`axe/dialog-open`、`axe/drawer-open`、`axe/reject-confirm`。14 路由 × 9 阶段**零违规、零水平溢出**；各阶段实扫计数 `5/5/1/1` 证明真扫到
- [x] **拒绝确认框阶段绝不提交决定** —— 只点开（抽屉里的「拒绝」）、扫描、Esc 关，再用**只读 GET 前后比对**三重断言没有提交：确认框已隐藏 / 抽屉里的「拒绝」仍在 / 待审批集合不变。那是用户的**真实**待审批记录
- [x] **发现失败不冒充数据态** —— 后端不可达或响应形状不符时退回占位符并明确标注 `placeholder (未见真实数据)`，同时打印发现失败；该分支单独验过
- [x] **屏幕朗读转录** —— 新增 `a11yTree.mjs`（CDP `Accessibility.getFullAXTree`；`page.accessibility.snapshot()` 在 Playwright 1.61 已不存在）。10 个状态（7 列表 + 1 真实数据详情 + 1 弹窗 + 1 抽屉）的线性朗读顺序，「命名问题」全部为 0；产物见 `docs/145-a11y-transcript.txt`
- [x] **X1-a：让「既有 Secret Provider」第一次真实存在** —— `envCredentialResolver` + 组合根注入；`secret:mcp/servers/github` → `MCP_SECRET_MCP_SERVERS_GITHUB`，映射恒带前缀所以引用无法点名任意环境变量；未配置走既有 fail-closed 路径
- [x] **X1-b：模型配置运行时可改** —— 活配置对象（就地改写，因为工作流任务路径每个任务才现构造 provider）+ `LiveLLMProvider`/`LivePlanningModel` 覆盖两条只在启动时构造一次的路径；**三条模型路径行为一致**
- [x] **X1-c：设置页** —— `/settings` + 侧栏「系统」组 + 命令面板条目；密钥框**只写不读**，只发送真的改了的字段，未加载完不渲染表单

**本阶段的两条自我约束**

- [x] 读回对象**没有 `apiKey` 字段**（只有 `apiKeyConfigured` 布尔），校验失败**不回显请求体**（`flatten()` 会把密钥的形状带回响应与日志），密钥不落库 / 不落盘 / 不进日志 —— 三条都有测试断言
- [x] `provider` 保持**只读**：部署级选择，改它要重新装配整条模型链路，不是一次表单保存能承担的事

**裁定关闭的一项（2026-10-15，用户）**

- [x] 真实屏幕阅读器走查（VoiceOver / NVDA）—— **裁定不做，本项关闭**（不是「押后」，后续清单不再列它）。放弃的覆盖面照录：念出来顺不顺耳、动态内容有没有被播报、焦点走向、不使用眼睛能否走完任务。其中「表单错误提示不是 live region」在本仓有**具体候选**（`ProjectsView` / `SettingsView` / `ProjectDetailView` / `MCPServerDetailView`），**该项不修**——它不属于 WCAG A/AA 失败项，且验收手段正是被关闭的这一项。**因此本仓不声称「全站对屏幕阅读器可用」**，只声称 axe 的零违规与无障碍树结构可审阅。见 docs/145 §三

**门槛**：16 包 typecheck ✓ / lint ✓；`apps/web` test **473/473** ✓（450 → 473）、build ✓、**a11y 14 路由 × 9 阶段零违规** ✓；`apps/server` test **244/244** ✓（227 → 244）；真实后端设置页只读走查 **20/20** ✓（并用 API 复核未改动其配置）。

> 一条保留：全仓 `-r run test` 的单次调用反复出现「一条时序敏感的服务端 e2e 失败」，**三轮七个文件全部不同**、逐个单独复跑都通过（机器负载所致）。数字来自按包复核，不声称「一次 `-r` 跑通」。见 docs/145 Known Issues 7。

**边界**：未改既有接口契约（`/api/model-config` 是新增路径）、未新增运行时依赖、未新增 migration、未动 `dist/`、未回改 W11/W12 的历史报告。

**设置页「保存」往返**：已在 W13 收尾时补验（用户授权一次可回滚的写入）—— 浏览器填三处 → 保存 → 清除覆盖 → 复核回落 `env`，**18/18** 通过，收尾状态与开工前逐字段一致。见 `docs/145` #1。

### X1 · 模型与凭据配置

- [x] 模型 / Base URL / API Key 的运行时可配置（`GET` + `PUT /api/model-config`）
- [x] 凭据走既有 Secret Provider 引用，**未新增明文存储**（`ModelConfigService` 不持久化；MCP 凭据只读进程环境变量）
- [x] 审批意见输入框（`WorkflowsView` 任务审批缺 comment 入口）—— **已在 W12 提前完成**
- [x] **前置**：「密钥存哪儿」已裁定并落地（内存态运行时覆盖），见 docs/145 §4.2
- [ ] 已知限制（非缺陷，明写进页面文案）：**重启后端后运行时覆盖失效**，回落到环境变量

### 自治 L1 · 策略内自治（**已达成（2026-10-23）**；M1–M3 见 `docs/155`，M4 与 L1-8 见 **`docs/224`**）

> **（2026-11-04）复验（不重开勾选）**：F1 / 门禁 P1 / Phase 8 之后，为让策略内自治在真链上被再次行使并记账，另立任务书 **`docs/247-l1-revalidation-taskbook.md`**（待审；先审后跑）。复验未达不自动回退本节已勾项，除非用户书面要求。
>
> **裁定来源**：2026-10-15 用户裁定「先把第一种定义成可验收的目标」。第一种 = **策略内自治：staging 与低风险自动，生产仍人工**。本节只定义验收，**不构成开工**；实现排在阶段 7 任务书（`docs/147` §8）之后——自治决策必须可审计、可度量。

**现状基线（2026-10-15 代码核对）**：
- staging DEPLOY 不要求审批；LOW / MEDIUM 工具动作自动执行。生产 DEPLOY 强制审批（`packages/database/src/workflowRepositories.ts:413`）；HIGH / CRITICAL 工具动作强制审批（`packages/action-policy/src/policy.ts:62`）。
- E1 的最终切片交付链是「CI → staging DEPLOY → VERIFY → production DEPLOY」（`docs/129`）。0/3 的归因是 **production 审批**，不是 staging。
- 未成立的是：质量门全局默认仍为 `observe`（**不满足 L1-4**）；失败默认 `FAIL_FAST`（无自动恢复）；自治决策没有专门事件。

**范围边界**：L1 只管「执行与 staging 交付」。**关口 1（切片计划人工确认）不纳入 L1**——2026-10-15 已裁定（下方「裁定结果」第 1 项）。

验收项（全部满足才算达成）：

- [x] **L1-1 staging 自动（回归门）**：staging DEPLOY 不产生审批记录，自动执行并进入 VERIFY。**通过（2026-10-15）**：`apps/server/src/__tests__/deliveryApi.e2e.test.ts` 断言 staging 任务无审批、`SUCCESS`、下游 `E2E` 亦 `SUCCESS`，且全链只有 production 一个审批记录（`docs/155`）。
- [x] **L1-2 生产人工（回归门）**：production DEPLOY 进入 `WAITING_APPROVAL`；批准前 `deployments` 无 RUNNING / SUCCESS 记录。**通过（2026-10-15）**：同文件新增「批准前 `GET /api/deployments` 只有 staging 一条」的断言。
- [x] **L1-3 高风险人工（回归门）**：HIGH / CRITICAL 工具动作仍需审批；策略不得关闭该门。**通过（2026-10-15）**：`apps/server/src/__tests__/actionPolicyWorkflow.e2e.test.ts` 新增用例——策略声明 `approvalRequired: false` **且** `autonomyLevel: "L1"`，HIGH 动作仍停在审批门、批准前零 MCP 请求。
- [x] **L1-4 质量门在 L1 下强制**：L1 工作流中 verdict=failed → 任务 FAILED（`VERIFICATION_FAILED`），不得被后续当作成功。**通过（2026-10-15）**：门模式改为按工作流取（L1 → `enforce`）；`verificationGate.e2e.test.ts` 在真沙箱上用 `observe` 构造执行器 + L1 工作流，结果仍被强制为 `failed`。
- [x] **L1-5 失败自动恢复有界**：RETRY 次数由策略声明（**上限 2**）；耗尽后工作流 FAILED，原因可读，不静默成功、不无限重试。staging DEPLOY 失败自动生成 ROLLBACK 任务并执行。**通过（2026-10-15）**：`packages/workflow-engine/src/WorkflowEngine.test.ts` 断言重试恰为 2 次后 FAILED（无第 4 次执行），以及 `-ROLLBACK` 任务被自动创建并执行；`deployFailureStrategy` 只在显式声明时对 DEPLOY 任务生效。
- [x] **L1-6 自治决策可审计**：每次自动批准 staging、自动重试、自动回滚都写入 `workflow_events`（含策略标识与依据），可按 `workflowRunId` 查询。只写日志不算。**通过（2026-10-15）**：四个事件的写入方已接（`AUTO_APPROVED` / `AUTO_RETRIED` / `AUTO_ROLLED_BACK` / `VERIFICATION_ENFORCED_FAILURE`），`policyId` 固定 `"L1"`；用例逐条断言 payload 能通过 `parseAutonomyDecisionPayload`。
- [x] **L1-7 策略载体与默认值**：自治级别是工作流级策略字段；**未显式选择 L1 时，行为与现状逐项一致**。**通过（2026-10-15）**：`autonomyLevel` / `deployFailureStrategy` 为可选字段、不进默认策略；`packages/shared/src/autonomyPolicy.test.ts` 与引擎用例断言「未声明 L1 → 零决策事件、行为不变」，且旧策略 payload 原样通过。
- [x] **L1-8 数据门槛（staging 段）**：L1 策略下 E1×3 批次，**staging 交付（含 VERIFY）成功 ≥ 2/3**，附归因。**不用 `deliveredSuccess`**：它包含 production 审批，结构上不可达（`docs/127` §9；2026-10-15 已裁定弃用）。**未达成——M4 已执行（2026-10-16）**：staging 段 **0/3**，判据为 ≥ 2/3。三次归因：run 1 / run 3 同形——slice-5 计划含 TDD 红测试任务（要求 `Dockerfile` 与真实 `README.md`）却**从未创建对应的实现任务**（`TASK-04/05/06/13` 全库不存在），故 CI 的 `pnpm test` 在未转绿的红测试上失败（工作区实跑：235 测试 / 15 失败 / 退出码 1）；run 2 为同类红测试任务连续失败 3 次拖垮工作流（**经查为稳定复现，非环境异常轮**）。**L1 自治特性本批次从未被触发**（`AUTO_APPROVED` / `AUTO_ROLLBACK` 各 0 次）——阻塞在上游，不在自治层。`docs/154` §3 M4、**`docs/155` 的 M4 追加块**。**（2026-10-16 追加，PL-M4）根因修复后的复验批次 PL-M4 已启动并中止**：run 1 于 15:11–15:54 执行完毕（**staging 段 否**、链止于 slice-1、5.16M 输入 token），暴露出**另一个确定性缺陷**（切片外的红测试把本切片的实现任务判死）；用户裁定 **runs 2/3 不跑**（先修缺陷，否则会把修前/修后两个平台版本混进同一批次）。**PL-M4 记「已执行 1/3、因发现确定性缺陷中止」**；缺陷已由 **PL-M7 / PL-M8** 修复（`docs/164` / `docs/165`），**修完另开一批 E1×3**（受周配额纪律约束，落在下周窗口）。**L1-8 维持「未达成」**——本项不因修好工具链而改变。**（2026-10-18 追加）** 此后又跑了 **六批 E1×3**（L1-M4b → L1-M4c → L1-M4d → L1-M4e → L1-M4f → L1-M4g → L1-M4h），**staging 段仍 0/3**，L1-8 **维持「未达成」**；逐批见 `docs/127` §0/§6/§9 与 `docs/146` §5。**十六次 E1 run 的致败点依次为**：切片外红测试（PL-M4）→ 仓库根清单写不出（N-2 / PL-M10）→ 仓库根交付物写不出（N-4、N-5 / PL-M11、PL-M12）→ 网关消息形状 400（N-6 / PL-M13）→ 外层撞框架递归上限 25（N-7 / PL-M14）→ 用量坏值污染周配额守卫（N-8 / PL-M15）→ 外层在 `submit_result` 后空转到守卫（N-9 / PL-M16）→ **网关 `reasoning_content` 回传 400 复发（N-6 / PL-M17）**。**每修好一个，链就往深走一层**：**L1-M4h run 3 首次清掉 slice-2（10/10 全绿）并首次到达 slice-3**（L1-M4c run 2 曾到过最终切片，但其计划只有 3 个切片，与 5 切片的批次不可直接比）。**判据 16h 已于 L1-M4h 达成**（全批 64 个 agent run，外层请求工具零条）⇒ **N-9 判关闭**；**N-8 零新增**。**当前已知的、下一批最可能拦住链的不是已修的缺陷，而是「核心实现切片的 BACKEND 任务过不去」**（L1-M4h 三次复现；形态为 test 检查挂死 + agent 越权改受保护测试文件，**anti-tamper 拦对了**）——它是**上游产物质量**问题，与已修的七类控制流缺陷不同源，**尚未立项**。**本项不因上述任何修复而改变勾选状态。** **（2026-10-18 追加，L1-M4i 批次）** 又跑了**第七批 E1×3（L1-M4i，执行 2/3、因配额中止）**，**staging 段 0/2**，L1-8 **维持「未达成」**。**十八次 E1 run 的致败点再添两处**：**`T10`（TEST 任务的三次 `VACUOUS_TEST`——红测试未经实现即通过）** 与 **`T-S4-R2`（REVIEW 任务的三次 `INVALID_AGENT_RESULT`）**。**同时更正上一批的归因**：L1-M4h 登记的「核心实现切片的 BACKEND 任务过不去」那堵墙，**本批两次被越过**（`checks failed: test` 重试后 SUCCESS），故下一批最可能拦住链的**不是**它，而是**非 BACKEND 类型任务上的产物质量**（TEST / REVIEW 的产物不合格）。**〔2026-10-18 同日更正〕** 上句**已被 `docs/183` 的调查推翻**——两处**都是平台侧**：TEST 的 **N-10 红灯检查作用域回退**（无 `acKeys` 锚点时作用域放大到全测试套件里出现的所有 AC，通过与否取决于「此刻套件里恰好有哪些 AC」）与 REVIEW 的 **N-11 判「不通过」后无出路**（诚实的负结论被当作任务失败，重试不可能收敛；既有 FIX 路径全库 0 条）。**已立项 PL-M18（任务书 `docs/183`，八项待裁定）。** 同时更正更前一句：**「BACKEND 任务那堵墙」已下调**——L1-M4i 里 `checks failed: test` 两次**重试后全部 SUCCESS**，它**不是**下一批的拦路者。**（2026-10-18 追加：PL-M18 已实施）** 两处新致败点**均已修复**（任务书 `docs/183`、记录 **`docs/184`**）：**N-10**（TEST 红灯检查的作用域回退）——无锚点时作用域收回本切片，探针 A/B 对真实任务由 `VACUOUS_TEST` 翻为 `verified`，反向对照仍拦住；**N-11**（REVIEW 判「不通过」无出路）——**策略**（L1 的 `failureStrategy` `RETRY` → `REPLAN` + `allowReplan: true`，两处定义同步）+ **代码**（修复任务落到工作类型，不再继承源任务类型）。**判据 18a–18g 达成、18h 不适用**。**⚠️ 本项口径受影响**：L1 的失败响应由「重试」改为「重规划」，**本项与既往 18 次 E1 run 不再严格可比**；修复**尚未在真实批次验证**。**L1-8 维持「未达成」**。**（2026-10-19 追加，L1-M4j 批次）** 又跑了**第九批 E1×3（L1-M4j，已执行 3/3、完整跑满）**，**staging 段 0/3**，L1-8 **维持「未达成」**。逐 run：run 1 → slice-2、run 2 → slice-1、run 3 → slice-2。**PL-M18 的两半都被真实链路检验**：**N-11** 的修复**被大量使用**（18 个动态任务，改动前全库 `FIX-*` = 0；3 个失败被 replan 干净救回；工作类型回退每次都生效）；**N-10** 的 `VACUOUS_TEST` **全批 0 次**（**弱证据**）。**但暴露新缺陷 N-12**——**replan 的「已解决」只认一层**，run 2 纯因此致死；**该缺陷已于 2026-10-19 修复（PL-M19，记录 `docs/186`）**：判定改为**沿 `resolvedByTaskId` 链走到头**，两个消费点合并为一处；探针 A/B 中**第二层抢救由 `FAILED` 翻为 `SUCCESS`**，而单层对照与「链尽头仍失败」两个不变量**未动**。**注意：修的是记账，不是救援能力——L1-8 不会因此达标**。**二十一次 E1 run，staging 段成功 0 次。** `docs/127` §0/§9、`docs/146` §3/§5、`docs/184` 勘误块。**链走到迄今最深**：run 2 首次连过 slice-3 并**首次进入 slice-4**（9/10）。**N-6 零出现**（76 个 agent run 全 succeeded）——PL-M17 的修复在真实链路上未被推翻，**但判据 17c 仍延期**（网关 thinking 规则间歇，批次期间未连续探测，不能断言条件被行使过）。`docs/127` §0/§6/§9、`docs/146` §5。**（2026-10-19 追加，L1-M4k 批次 + PL-M20）** 又跑了**一批 E1×3（L1-M4k，已执行 3/3、完整跑满）**，**staging 段 0/3**，L1-8 **维持「未达成」**。逐 run：**三个 run 全部止步 slice-1**（oracle Must **7 / 11 / 10**（共 29）；输入合计 **34,351,875**）。**❌ 本批对 PL-M19 零判别力**：`error->>'message' LIKE '%unresolved%'` 全批 **0 行**，三条死亡链（`I2-REPLAN-1-REPLAN-2` / `I1-REPLAN-1-REPLAN-2` / `I3-REPLAN-1-REPLAN-2`）**尽头全是 FAILED**——**没有一条「第二层抢救成功」**，故 N-12 的修复**既未被证伪、也未被检验**。**🔴 新缺陷 N-13（AC 作用域测试命令把不匹配的测试文件挂死）**：**三次死亡全部由此造成**。**一处归因更正（重要）**：最初把死因写成「`maxRetries` 预算耗尽」**是错的**——三个致败任务的**作用域内 AC 全过**（`acSummary.failed = 0`），检查却 `timedOut: true`（2 × 120s）；**预算是结果，不是原因**。全批 22 个 FAILED 里 **16 个**带超时检查、**7 个** AC 全过。**已修（PL-M20，记录 `docs/188`）**：作用域命令追加 `--test-timeout`（**不用**会把挂死静默变成通过的 `--test-force-exit`），并新增检查级诊断码 `CHECK_TIMEOUT`。**二十四次 E1 run，staging 段成功 0 次。** `docs/127` §0/§9、`docs/146` §3/§5、任务书 `docs/187`。**（2026-10-19 追加，L1-M4l 批次 = PL-M20 的真实检验）** 又跑了**一批 E1×3（L1-M4l，已执行 3/3、完整跑满）**，**staging 段 0/3**，L1-8 **维持「未达成」**。**✅ 判据 20g 达成——N-13 的致败签名全批归零**：全批 **18 个检查（`build` 7 / `test` 10 / `slice-boundary` 1）零失败、零超时**；L1-M4k 的 **16 个超时检查**与 **7 个「AC 全过却判失败」** **一个都没复现**。**正对照**：作用域命令现为 `… --test-name-pattern '…' --test-timeout=100000`（同一 AC 键、同一模式，只多一个新开关）。**失败分层随之迁移**：`verification` 由 L1-M4k 的 7 / 8 / 3 降为 **1 / 3 / 3**，`agent` 由 0 / 0 / 4 升为 **4 / 0 / 0**。**🔴 新的唯一致败点＝anti-tamper（N-14）**：9 个 FAILED 任务里 **7 个**死于同一句 `protected test files modified: <路径>`，**三个 run 的终止全部落在它上面**，而**每一次检查都通过了**——**失败与产物质量无关**。**以库为准的到达切片**：run 1 → **S2**、run 2 → **S1**、run 3 → **S1**（eval summary 对 run 2 / run 3 报「到达 S2」，是 `sliceReached` **跨 run 串味**的记账缺陷 **N-16**，不是事实）。**N-12 仍未被行使**（本批同样零触发）⇒ **PL-M19 既未被证伪、也未被检验**。**二十七次 E1 run，staging 段成功 0 次。** `docs/127` §0/§9、`docs/146` §3/§5、记录 `docs/188`。**（2026-10-20 追加，L1-M4m 批次 = PL-M21 四项修复的真实检验场）** 又跑了**一批 E1×3（L1-M4m，已执行 3/3、完整跑满）**，**staging 段 1/3**，L1-8 **维持「未达成」**（判据 ≥ 2/3）。**🔴 但这是三十次 E1 run 里第一次 staging 段成功**：**run 2 的链第一次连过四个切片**（`4860c374` → `48cd16a5` → `f45b6eb9` → `716eb98d`），**CI / staging DEPLOY / staging VERIFY 三段全绿**。逐 run：run 1 → slice-1-foundation（staging 否）、**run 2 → slice-4-runtime-ui（staging 是，77,874,028 输入）**、run 3 → slice-2-auth（staging 否，26,056,003 输入）。全批输入 **108,915,700** / 输出 1,631,967；111 个 agent run（108 succeeded / 3 timed_out）；**假阳性 0、超范围写入 0**。**四项修复的线上结论**：**N-14 (A) ✅ 确认**（run 2 的 `slice-1-task-8-DEBUG-1-DEBUG-2` 记 `verdict=passed` + `changed` 非空 + **无 `weakened`**，任务 SUCCESS——**正是 L1-M4l 的假阳性形状**，旧门下必判死）；**N-16 ✅ 确认**（run 1/2/3 记 slice-1 / slice-4 / slice-2，与 `workflowIds` 的 1 / 4 / 2 条逐一对上）；**噪声线 ✅ 确认**（run 2 的 `humanInterventions: -1` 对 run 1 的 1、run 3 的 `0` 对 run 2 的 0）；**N-14 (C) ⚠️ 未检验**（全批 0 行带 `weakened`）、**N-17 ⚠️ 未证实**（replan 仍反复撞同一处失败）。**🔴 上一块的判读已被本批推翻（勘误）**：**「判据 20g 达成——N-13 的致败签名全批归零」不成立**——**L1-M4l 的「0 超时」是未观测**（全批 10 个 `test` 检查**每一次都正常返回**，挂死路径一次没被走到），而 **L1-M4m run 3 走到了：7 个带 `--test-timeout=100000` 的检查仍然超时**（`CHECK_TIMEOUT×7`，命令逐条实查未截断）⇒ **「把「不返回」变成有界的失败」在生产取值上不成立；PL-M20 不判「已收口」**（探针 P2 的产物记 `# duration_ms 10012`——超时后 12 ms 退出，**合成夹具**；「E1 工作区实跑亦退出」这句在 `packages/eval/results/` 下**没有产物**）。**🔴 新登记四项**：**N-18**（**计划点名的 `scripts/verify-contract.mjs` 没有任何 agent 可写**——`scripts` 不在五个 agent 的 `writePaths` 里，两个根级判据都只认仓库根条目；run 1/2 **各有一条完整 slice-1 TEST 链死在这里**；**是 PL-M10/11/12 修掉的同族缺陷的第五例**）、**agent 600s 墙上超时**（run 2 三次，真实工作非空转）、**replan 不收敛**、**`errorTypes` 双粒度相加**（run 2 报 `TIMEOUT: 6` 而库内真实超时任务只有 3——**解释了此前挂账的「eval summary 与库内对不上」**）。**anti-tamper 已不再是致败点**（本批零判死）。**三十次 E1 run，staging 段成功 1 次（首次）。** `docs/127` §0/§9、`docs/146` §3/§5、`docs/189` §9.3、`docs/188` 的勘误块。**（2026-10-20 追加，PL-M24 = N-13 的修法）** 用户裁定「**按你的推荐，先做 (1)**」⇒ **缺失的产物已补齐、机制已定**：在**真实 E1 工作区**（`~/Desktop/study/ai-se-eval/E1/run-1`，L1-M4m run 3 收尾态）上跑库内**原文**的作用域命令——**机制**＝`--test-timeout` **按文件**计，而沙箱 **`--cpus 1`**（`packages/sandbox/src/index.ts:50`；容器内实测 `availableParallelism()=1` 而 `cpus().length=10`）使 Node **串行**跑测试文件 ⇒ **N 个永不结束的文件烧 N × 100s**（实测每作用域 **N = 3~4**）⇒ **300~400s ≫ 120s 预算** ⇒ `CHECK_TIMEOUT`；**宿主机 10 核上并发跑只有 100.5s**，故探针与「E1 工作区实跑」**结构上都测不到**。**已修（PL-M24，记录 `docs/192`）**：`acScopedTestTimeoutMs` 由 `floor(budget × 5/6)`（**只够一个文件**）改为 `floor(budget / (1 + MAX_NEVER_COMPLETING_TEST_FILES))`，`N = 5` ⇒ 120s 预算下 **20s**。**真实工作区 A/B（沙箱条件 `--test-concurrency=1`）**：旧值 **130s 窗口内不退出**（复现生产形态）、新值 **81,707ms 退出**且 TAP 保住（`# tests 29 / pass 25 / fail 0 / cancelled 4`，**余量 38s**）——产物 `packages/eval/results/n13-e1-probe/pl-m24-fix-verification.json`。**代价基线**：真实工作区整份**串行**套件 **4,307ms / 106 用例 / 全过**、**最慢单测 667ms** ⇒ 20s 有约 30 倍余量。**⚠️ 本项不改变任务结局**：检查仍 `exit 1`、任务仍 FAILED——它买到的是**有界 + 可归因**（保住 TAP 的 `# fail 0 / # cancelled N`），**不是解冻**；**「只有挂死、无真实失败 ⇒ 判通过」是另一半，仍未裁定**。**⚠️ 口径变更**：作用域命令里的 `--test-timeout` 由 `100000` 变为 `20000`（默认预算下），**`command` 字段与既往批次不再逐字相同**（**判定口径一字未动**）。**未在真实批次验证 ⇒ 不判「已关闭」。** **L1-8 维持「未达成」**——本项不改变勾选状态。**（2026-10-20 追加，PL-M24 (2) 可行性判定——「不可安全实现」，不实施）** 用户指令「做 (2)」（把「作用域命令只有挂死、无真实失败」判为**通过**）。**它的前提**是把两件事机械分开：**A** 文件里**零个**测试匹配、其文件级钩子挂死（应通过）；**B** **匹配到的**测试自己挂死（必须失败）。**实测：Node 的 TAP 对两者给出同形证据**——A（真实工作区 `src/tests/login-contract.test.mjs`，pattern `[AC-99]`）：`not ok 1 - <path>` / `duration 5003.7` / `testTimeoutFailure` / `1..1` / `fail 0 / cancelled 1`；B（合成夹具 `test("[AC-01] … never returns")` ＋ `setInterval`）：`not ok 1 - hang.test.mjs` / `duration 5008.3` / **同** `failureType` / **同** `1..1` / **同** `fail 0 / cancelled 1`。**两者都不带 AC 标记**——B 里那个测试的名字就叫 `[AC-01] …`，**Node 根本没有把它报出来，报的是文件**。⇒ 设计出的判据在 B 下**同样成立**；只要同一任务还有另一个通过的作用域测试，**B 就会被判通过**——**正是 `--test-force-exit` 被否掉的那扇门**（`docs/187` §4 判据 20d）。**四个候选区分信号逐一实测被否**：`failureType`（同）、`duration`（同≈超时）、计划行 `1..N`（**是根计划**、非每文件计划）、按文件内容 grep 预筛（`login-contract.test.mjs` 对 `AC-01` 命中 7 次而匹配测试名 0 个）。**对照（不构成反例）**：同一真实文件换有匹配的 pattern → `pass 1 / cancelled 0`、199 ms 正常退出 ⇒ 挂死确由「零匹配 + 文件级钩子」触发（PL-M20 根因仍成立），**但根因成立不等于后果可分**。**交付物是「(2) 不可安全实现的判定与证据」，不是实现**——零 `src/` 改动、零门禁；记录 **`docs/193`**，产物 `packages/eval/results/n13-hang-only/`。**剩余安全出路只在工作区侧**（让 agent 写的测试别在文件级 `before` 里无界 spawn 子进程），属**行为塑造、无法机械验证**。**⇒ L1-8 仍被这一族卡住。**〔**2026-10-20 裁定：用户答「按你的推荐，不落地 (2)」，本项关闭，不做。**〕 **L1-8 维持「未达成」。** **（2026-10-21 追加，L1-M4n 批次 = 六项修复的真实检验场）** 又跑了**一批 E1×3（L1-M4n，已执行 3/3、完整跑满）**，**staging 段 0/3**，L1-8 **维持「未达成」**（判据 ≥ 2/3）。逐 run：run 1 → slice-3、run 2 → slice-4（`a85a6970`）、**run 3 → slice-4 且终态 `WAITING_APPROVAL`**（`ce294d85`，**生产关口**——与 L1-M4m 的 `716eb98d` **同一归宿**，非回归）。全批 token 输入 **170,974,107**（46,607,927 + 52,991,749 + 71,374,431）/ 输出 **2,000,116**。**🟢 本批的实质推进（单调，可复核）**：成功任务 **27 → 40 → 46**；oracle **否 → 否 → 是**；交付任务从「未尝试」到「三个都真跑过」。**🟢 并且产出 L1-M4x 系列的第一次 oracle 通过**——**run 3 的 `oraclePassed: true` / `falseNegative: true`**。全系列普查（`grep -l '"oraclePassed": true'` 逐目录计数）：**`l1-m4` 至 `l1-m4m` 十三个目录、三十一次 run，全 0**；`l1-m4n` **1/3**。（`g/l4` 系列有 1 次，即 `docs/198` §4 的 `57f98bf9`，**不在 L1-M4x 系列内**。）**含义**：**L1-8 的瓶颈已从「链造不出合格产品」收窄到「交付编排跑不通」**。**⚠️ 但假阴性不是达标信号**——L1-8 的判据是 staging 段，本批 0/3（`stagingSegment.ci = FAILED`、`deploy = FAILED`、`verify = FAILED`）。**✅ 六项修复全部确认真实批次生效**（逐项证据见 `docs/201` §5）：**N-18**（`scripts/` 拒绝归零——L1-M4m 的 `selfcheck.mjs ×7` / `verify-contract.mjs ×5` / `lint.mjs ×4` / `typecheck.mjs ×3` / `build.mjs ×2` **全消失**，且 `scopeViolations` 仍全空）、**N-19**（`denied` 结构化，**112/112** 带 `deniedAttempts`）、**PL-M24 (1)**（全部 6 处失败的 `test` 检查都是**真 `exitCode=1` + TAP 存活 + 命令带 `--test-timeout=20000`**，`CHECK_TIMEOUT` **零次**——**⚠️ 弱证据**：本批未被逼到超时那一刻）、**N-20**（summary 与库内任务级**逐 run 相等**：**4=4 / 1=1 / 1=1**，无双计）、**N-15′**（`no available checks for task type DEBUG` **= 0**，8 个 DEBUG 任务全拿到真 checks）、**N-21**（**决定性正控**：`TASK-08-REPLAN-1`（BACKEND）**SUCCESS @ 773s**，旧 600s 默认值会截断它；本批 `TIMEOUT_ERROR = 0`、`reached max iterations = 0`）。**「必须缺席」家族全缺席**：N-6 / N-7 / N-8 / N-9 / N-10 / `EMPTY_FINAL_ANSWER` / `scopeViolations` 全 0；**N-12 第四次未被行使**（PL-M19 既未证伪、也未检验）。**🔴 新登记两个缺陷**：**N-22**（**`REPLAN` 是 `SubmitResultSchema` 里声明过的一等结果，路由却只认 `fixTaskType`**，而该字段对非 qa agent **结构性不可达**——run 2 的 `T7-REPLAN-1`（backend-agent）报 `outcome=REPLAN`，`recommendations` **原文要求**「**Route a TEST-type task** to correct `src/bearer-auth-middleware.test.js` line 333 … then retry this CI task」，平台给了它**又一个 BACKEND**；该失败**无 `errorType`、无 `verification`**；任务书 `docs/199`）、**N-23**（**PL-M18 的溢出，run 3 的实际致败点**：`WORK_TASK_TYPES` 只有 `["BACKEND","FRONTEND","DATABASE"]` ⇒ `debugTargetType` 第 3 步把**交付任务**的类型换成工作类型，而 `DeliveryOrchestrator.canHandle` 按 **`task.type`** 分派 ⇒ **`input.delivery` 契约悄悄作废**——run 3 的 `T7`（**BUILD**/CI，runtime `delivery-orchestrator`）→ `T7-REPLAN-1`（**BACKEND**，runtime `professional-deep-agent`）**没写下任何 `ci_runs`** 却自报 **SUCCESS** ⇒ `T8`（DEPLOY）在 agent 之前即失败于 **`CI_RELEASE_NOT_FOUND`**，且同形第二次（`T8-REPLAN-1` 是 BACKEND 扛 DEPLOY 契约）；**级联**：`T8` 失败 → `T9` REVIEW 审一次**根本没发生的部署**、正确地判 not approved → `T10` 停在生产关口；**run 3 交付段的整条失败可完整追溯到本条**；任务书 `docs/200`）。**两件须同批修（PL-M25）**，但**「一起修」不等于 run 2 那条链会收敛**——「CI 因过期测试失败」需要一次**两步修复**，是第三个问题，**已登记、不立项**（`docs/200` §7.1）。**⚠️ 一处对开批前预测的更正**：预测的 `docs/` 那堵墙**出现了但没拦住**（`DESIGN-TOKEN-AUTH-CONTRACT` 写 `docs/design/token-auth-contract.md` 被拒，但该任务在多个 run 里仍 SUCCESS，agent 改道把设计写在结果里）⇒ 按 [[defect-registration-needs-code-proof]] **不登记为缺陷**。**⚠️ 一处记账缺口**：`errorTypes` 只收非空值 ⇒ run 2 的 4 个失败只报出 1 个、run 3 的 5 个只报出 1 个（run 2 的 `T7` 事件带 `CI_FAILED` 而任务 `output.errorType` 为空——**同一失败码两个来源不一致**），已并入 N-22 判据 25e。**三十三次 E1 run，staging 段成功 1 次。** `docs/127` §0/§9、`docs/146` §3/§5、记录 **`docs/201`**。**下一阶段边界：PL-M25 未开工，实施前不得再开批次**（[[fix-known-defects-before-batches]]）。**L1-8 维持「未达成」。** **（2026-10-21 追加，L1-M4p 批次 = PL-M25 + PL-M26 的真实检验场）** 又跑了**一批 E1×3（L1-M4p，已执行 3/3、完整跑满）**，**staging 段 0/3**，L1-8 **维持「未达成」**（判据 ≥ 2/3）。逐 run：**run 1 → auth-persistence（切片 1，33 分钟，死于新缺陷 N-26）**、**run 2 → task-core（切片 2，73 分钟，死于上游 429 ×4）**、**run 3 → auth-persistence（切片 1，7 分钟即死，死于上游 429 ×2）**。**三次都没走到交付段**（`input.delivery` 任务 **0**、`ci_runs` **0 行**）⇒ **主判据 26d 未验，PL-M25 不判「已关闭」**。**🟢 但六条次级判据全部在真实批次确认**：**25e(b)** 四个工作流合计 **16 个 FAILED 任务、空 `errorType` 0 个**（修复前 L1-M4n 是「4 个失败只报 1 个码」「5 个失败只报 1 个码」）；**25e(a)** `REPLAN_REQUESTED` 落码 5 次；**25f**（正控）`T-010-DEBUG-1` 报 `REPLAN` 且点名 `fixTaskType=BACKEND` ⇒ 其重规划任务**就是 BACKEND**——**N-22 的第 1 步通道真被走到**（本批共 **6** 个任务填了根字段）；**25g**（负控）`T-007` 无 `fixTaskType` ⇒ 兜底仍给 **TEST**（**兜底路径也被走到**）；**27a** 上游 429 记 `LLM_ERROR`（**修复前会落成 `EMPTY_FINAL_ANSWER`**）；**27b** 真空答案（run `succeeded`、无 `error`）仍记 `EMPTY_FINAL_ANSWER` ⇒ **正控负控同时成立**。**N-23 的交付类型短路在 TEST 上确认**（失败的 TEST 任务重规划后仍是 TEST）。**🔴 新登记 N-26**（**`command-filter` 作用域不隔离**：`taskVerifierRules.ts:301-324` 的注释已知「`--test-name-pattern` 只筛**测试名**、文件照跑」，而 `taskVerifier.ts:1174-1176` 的判定是 `command-filter ? last.success && allRelevantPassed : …`——**要求整条命令成功** ⇒ **兄弟切片**的 QA 测试文件钩子失败（`ERR_SERVER_NOT_RUNNING`）就让**本切片 AC 全过也判失败**；`result-filter` 用 `||`、**免疫**；run 1 的 `T-008`（`scopedAcKeys=["AC-01"]`）读数 `# tests 10 / pass 7 / fail 3` 而 **AC-01 自己全过**，同链 DEBUG 任务用**全 AC 模式**则 `56/56 全过`；**缺陷本身是旧的**（10-16 起有，10-19 有 25 例，但**来自别的夹具**），**E1 上今天首次成为致死点**；**「为什么本批才绑定」未解**）。**⚠️ 上游污染（口径开批前声明）**：`LLM_ERROR` 且 `agent_runs.error` 为 429 的一律剔除，本批 **6 个全是 429** ⇒ **平台自身失败 10 个**；**run 3 实质无效**（7 分钟内 2/3 失败是上游）。**⚠️ 开批时「连续两次 6/6」的恢复判定事后证明过于乐观**（批中探针 **6/8**，低于 `docs/203` §6 的 ≥5/6 门）。**为什么不中止**：`docs/203` 中止是因为上游故障**被错记成平台故障、读数分不出来**，而 **PL-M26 修的正是这件事** ⇒ 污染现在**可见可剔除**。token 输入 **41,790,552** / 输出 **565,161**。**三十三次 E1 run，staging 段成功 1 次。** `docs/127` §0/§9、`docs/146` §3/§5、记录 **`docs/207`**。**L1-8 维持「未达成」。** **（2026-10-21 追加，L1-M4q 批次 = PL-M27 的验证批）** 又跑了**一批 E1×3（L1-M4q，已执行 3/3、完整跑满）**，**staging 段 0/3**，L1-8 **维持「未达成」**（**连续第四批**）。逐 run：run 1 → `S1-foundation-deploy`（42 min）、run 2 → `S1-foundation-deploy`（14 min）、**run 3 → `S2-auth-persistence`（46 min，本批最远）**。**❌ 判据 29a（PL-M27 主判据）未行使**：三次运行的**全部** `command-filter` 检查要么 `exitCode 0`、要么 `exitCode 1` 且**作用域 AC 真的失败**——**「非零退出但作用域 AC 全过」一次都没出现**（要出现须有**兄弟切片**的测试文件钩子失败，那需要更靠后的切片）⇒ **PL-M27 不判「已关闭」**。**✅ 判据 29b（负控）在真实批次确认**：`T4`（run 2）`exitCode 1`、`scopedAcKeys=["AC-21","AC-22"]`、`acResults={"AC-21":"failed"}` ⇒ 检查判 `passed:false`、任务 `VERIFICATION_FAILED` ⇒ **修复没有把规则放水**。**❌ 26d 连续第三批未触及**（`input.delivery` 任务 **0**、`ci_runs` **0 行**）⇒ **PL-M25 仍不判「已关闭」**。**25e(b) 回归抽查仍成立**（**12 个 FAILED、空 `errorType` 0 个**）。**上游仅 1 次 429**（对照 L1-M4p 的 6 次）⇒ 本批读数基本干净。**🟢 本批最有价值的产出是观测而非验证**：`docs/208` §7 写成「既有、未修、理论上可以」的两个残留口子**三个 run 全部稳定复现**——**N-27（空转通过）3 次、且三次全部来自同一任务 `T1`**（`acResults` 空 + TAP `1..0 / # tests 0` + `exitCode 0` + `passed:true`）⇒ 已从「理论上可以」**升级为「每个 run 都在发生的稳定形状」**（已登记 `docs/146` §3）；「部分证据 M<N」也在 `T4` 稳定复现（`scopedAcKeys=["AC-21","AC-22"]` 而 `acResults` 只有 `AC-21`，**AC-22 从未出现仍通过**）。**三次死因全部是「REPLAN 链到底仍失败」**（run 1 `T7` REVIEW 反复 `REPLAN_REQUESTED`、run 2 `T4` 真失败、run 3 `T7-data-store-hash` `TOOL_ERROR`）——**正是 `docs/200` §7.1「两步修复」那一族，仍无修法**。**⚠️ 下一批的前提不是「再修一个判据」，而是「弄清为什么链走不过 S2」**——三次都止步 S1/S2，29a 与 26d 都要求更深的链。token 输入 **19,674,793** / 输出 **501,487**。`docs/127` §0/§9、`docs/146` §3/§5、记录 **`docs/209`**。**L1-8 维持「未达成」。** **（2026-10-22 追加，L1-M4t）** 第二十一批 E1×3 跑满 3/3：**链完成 3/3、真交付 3/3（oracle Must 29/29）、假阳性 0、假阴性 0**——平台**首次在整批尺度跑完全链**（此前最好成绩是部分 run 到达最终切片）。**staging 段仍 0/3**，三次都是 `ci=SUCCESS deploy=SUCCESS verify=-`：最终切片的「验证 staging 环境」任务被规划成 `type=DEPLOY, delivery.action="DEPLOY"`（**计划里根本没有 VERIFY 这一格**），属**计划契约**缺陷、不是实现质量；该形状由 **N-33 / PL-M34** 修（提示词逐条写明四个交付块），已由**规划探针**（PL-M37，`docs/221`）在同一批真实输入下单独证明有效（`task-3-17 = TEST + {action:"VERIFY"}`，`VERIFY-PRESENT`），但**本批一次都没验到**——三个 run 共用 run 1 在修复落地前生成的同一份计划（`docs/218` §12）。**失败分层：规划 0 / 验证门 0 / agent 9**（8×`REPLAN_REQUESTED` + 1×`TIMEOUT`），replan 链**全部收敛、深度 ≤ 2**，6 个 DEBUG 任务 6/6 SUCCESS。批次记录 **`docs/217`**。**L1-8 维持「未达成」。** **（2026-10-23 达成）** 批次 **`l1-m4u`**（E1×3，第二十二次尝试，22:52 → 06:37 CST，输入 235,047,296 token）：**staging 段记录判据 2/3、修正判据重算 3/3**，两者均 ≥ 判据 2/3。三跑真成功率 100%、假阳性 0、链完成 100%、真交付 100%；失败分层均为「规划 0 / 验证门 0 / agent N」。staging 段之所以首次成立：**N-33 / PL-M34**（提示词写明四个交付块）让最终切片规划出 `type=TEST, delivery={action:"VERIFY"}` 的任务，**N-31 / PL-M32**（按契约分派）让该任务由 `delivery-orchestrator` 执行。run 2 的记录判据为 0 是 **N-36**（staging 判据取「第一条匹配任务」，读到已被 replan 救回的原始 FAILED）——已修（`docs/224` §2.1），按修正判据重算为交付。记录 **`docs/224`**。
- [x] **L1-9 不变量（红线）**：不绕过 Tool Runtime 与 Policy；不新增第二套 Approval / Audit；生产与高风险人工门不可由策略关闭。

**裁定结果（2026-10-15 用户「都按你的建议」，本节的开工条件已清空）**：
1. 关口 1 是否纳入 L1？**不纳入**（切片计划的人工确认是人设定范围的地方；纳入即等于 L2）。
2. L1-5 的 RETRY 上限默认值：**2**。

**实施状态（2026-10-15 立；2026-10-16 M4 执行后更新）**：任务书 `docs/154`；§6 五项已由用户按推荐值裁定。**M1 – M3 已实施并通过**（记录 `docs/155`）：L1-1 … L1-7 与 L1-9 达成。**M4 已于 2026-10-16 执行完毕**（记录见 `docs/155` 的 M4 追加块）：E1×3 三次批次跑满、周配额守卫未触发（合计 6.7M 输入 token），但 **staging 段 0/3，L1-8 未达成**——三次都断在交付链的 CI 之前，**L1 自治特性一次都没被触发**（`AUTO_APPROVED` / `AUTO_ROLLBACK` 各 0 次），根因是计划器不生成「红测试」对应的实现任务。**因此 L1 整体仍不判「达成」：M1 – M3 与 L1-9 通过，L1-8 未达成。** 根因修复已由用户裁定另立项。**（2026-10-16 追加）** 根因修复的 PL-M 系列已全部实施（`docs/159` / `docs/160` / `docs/161`），并先清掉三项登记缺陷（`docs/163`）；**PL-M4 复验批次已执行 1/3 并中止**（run 1 staging 段 否，暴露切片外红测试致败的确定性缺陷），缺陷由 **PL-M7 / PL-M8** 修复（`docs/164` / `docs/165`），**下一步是另开一批 E1×3**。

### 自治 L2 · 关口 1 纳入自治（**部分达成（2026-10-23）**；任务书 `docs/227`，实施 `docs/228`）

> **裁定来源**：`docs/146` §4（2026-10-15）「关口 1 不纳入 L1；**纳入即等于 L2**」；
> 用户 2026-10-23 裁定任务书 §7 六项全部按推荐值，并授权开工。
> **本次定义**（任务书 §2 判据 B）：L2 = **阈值化自动批准 + 人工兜底**——
> 平台用四条确定性判据检查切片计划，全满足则自动批准并记决策事件，否则必须人工。
> **L2 ⊇ L1**：声明 L2 的工作流逐项继承 L1 的全部行为。
> **基线事实**：关口 1 的机制早已完整实现（`planningService.ts:615-619`）；
> 缺的是自治表达——且 gate-1 审批全库 **86 条、全部 APPROVED、零 REJECTED**，
> 该门在实践中是橡皮图章，这正是 L2 要改的东西。

- [x] **L2-1 关口 1 阻塞第二级**：需求处于 `PLANNING_REVIEW` 且审批未决时，**不产生任何第二级规划**。
      **通过**：`sliceFlow.e2e.test.ts` 断言 `tasks` 与 `dependencies` 均为空。
      **已知例外**：`planPendingSlicesInOrder`（F 阶段演练入口）设计上绕过，本项不覆盖。
- [ ] **L2-2 拒绝 → 重做有界**：拒绝（带 comment）触发第一级重做；第 3 次拒绝判需求 FAILED
      （＝最多 2 次重做）。**未新增断言**——该行为是 Phase B 既有实现，
      且**生产读数仍为 0 次拒绝**（`docs/228` Known Issue 2）。
- [x] **L2-3 控制台入口**：需求页在 `PLANNING_REVIEW` 时展示切片计划与批准/拒绝入口（既有实现，既有用例覆盖）。
- [x] **L2-4 自治级别表达 L2**：`AutonomyLevelSchema` 扩为 `["L1","L2"]`；`isAutonomyAtLeastL1`
      对两者均为真（**L2 ⊇ L1**）；未声明时行为与现状逐项一致。
- [x] **L2-5 判据纯函数**：`evaluateSlicePlanGate` 四条判据（FR 覆盖 / 范围可控 / 依赖健康 /
      最终切片不超规模），**8 例**正反例；未命中时返回判据名，不返回布尔了事。
- [x] **L2-6 自动批准与决策事件**：判据全满足 ⇒ 走**既有** `approvals` CAS 路径批准，
      写 `GATE1_AUTO_APPROVED`；未满足 ⇒ 保持 PENDING 并写 `GATE1_GATE_CHECKED{unmet}`；
      未声明 L2 ⇒ 零事件、行为不变。`gate1Autonomy.e2e.test.ts` **3 例**覆盖三条分支。
- [ ] **L2-7 数据门槛**：L2 策略下 E1×3，gate-1 判定三个 run 都被记录 **且** staging 段 ≥ 2/3。
      **离线回放已完成**（零配额）：现存 **10** 份计划 → **7 自动批 / 3 送人工**，
      3 份全部卡在 `slice-scope`（`apps/server/scripts/probe-gate1-predicate.ts`）。
      **批次未跑** ⇒ 本项不勾。

> **未开始事项（STOP）**：L2-7 的批次未跑；L2-2 未新增断言。本阶段判 **PASS-PARTIAL**，
> **不判「已关闭」**（`docs/228` §10）。

### 文档入口 · PRD 与技术需求文档以文件进入系统（**部分达成（2026-10-23）**；任务书 `docs/229`，实施 `docs/230`）

> **用户口径（2026-10-23）**：「用户如果上传了技术需求文档**一定是规划好了的**，你需要提取内容并进行规划。」
> 由此定死三条语义：① 技术文档是**权威输入**，不是参考材料；② 仍然要做规划（切片/任务分解），只是受文档约束；
> ③ 文档与 PRD 冲突必须**上报**，不得静默择一。
> **硬规则**：技术文档**绝不拼进 `rawContent`**——它是 AC/FR 解析器的唯一输入（`PlanningGraph.ts:387`）。

- [x] **D1-1 三种格式上传抽取**：`.md` / `.txt` / `.docx` 都能抽出可读文本；二进制改名伪装、坏 docx、空文档均被拒且原因可读。
      **通过**：`documentExtraction.test.ts` 7 例，其中 docx 用例用手搓的真实 ZIP + OOXML 走通全链。
- [x] **D1-2 文件 PRD 落 `raw_content`**：上传 PRD 文件后，`requirements.raw_content` 被替换为抽取文本，AC 解析器看到的仍是同一处文本。
- [x] **D1-3 技术文档不进 `raw_content`**：规划每个阶段的输入都携带 `providedTechnicalDocs`，且 `requirement` 序列化后不含文档正文（**反向对照断言**）。
- [x] **D1-4 超长按声明规则截断并显性告知**：上限 200,000 字符，落库 `truncated`，列表与规划输入都可见。
- [ ] **D1-5 规划输入包含技术文档且标为权威**：输入通道与提示词约束已接（`providedTechnicalDocs` + 统一约束句），
      **但未用真实模型跑过一次**——模型是否照文档规划没有读数。
- [ ] **D1-6 冲突上报**：`technicalDocumentConflicts` 契约、`TECHNICAL_DOCUMENT_CONFLICTS` 事件、页面展示齐备，
      **同样缺一次真实模型验证**（模型是否真的产出冲突项）。
- [x] **D1-7 已分析后加文档 ⇒ 规划过期**：`documents_changed_at` 与 `latestAnalysisAt` 比较得出 `planningStale`，详情页显性提示需重新分析。
- [x] **D1-8 存量行为不变 + 全仓门禁**：无文档的需求走原有路径；全仓 `typecheck` / `lint` / `test` 通过（见 `docs/230` §8）。

### 追踪前端 · 端到端追踪视图的前端呈现（任务书 `docs/156`；**已完成**，记录 `docs/157`）

> **裁定来源**：`docs/147` §6 第 5 项（2026-10-15 用户裁定「追踪视图前端**另立阶段**」——Phase 7 只交付 API）；任务书 `docs/156`（2026-10-15 草案，§6 五项已按推荐值裁定）。本节只定义验收，**不构成开工**。
> **它补的是什么**：`docs/18` 节「Phase 7：Observability」的验收原文要求「一次真实 Agent Run 可以**从前端**/服务入口追踪到具体 Tool 和 **Sandbox** 执行」。**服务入口**已由 7-C 达成（`docs/150`）；**前端那一半**是本节要补的。**Sandbox 那一半不补**——沙箱是工具执行路径、不是事实表，不单独成节点（`docs/153` Known Issues 1）。

**现状基线（2026-10-15 代码核对）**：
- 追踪 API **已交付**：`GET /api/workflows/:id/trace`（`apps/server/src/routes/workflows.ts:151`；`docs/150`）。
- 树类型 **已在 `packages/shared`**：`WorkflowTraceView { workflowRunId, requestId?, generatedAt, root, counts }`、`TraceNode { kind, id, label, status, startedAt?, finishedAt?, durationMs?, detail, children }`（`packages/shared/src/index.ts:942-976`）。
- 前端**零调用**：`apps/web` 全树无 trace 消费方；`api/workflows.ts`、`stores/workflows.ts` 均无 trace 通道。
- 树的规模（真实 run 实测）：`counts = { tasks: 19, agentRuns: 16, toolCalls: 503, deployments: 0 }`（`docs/153` §E2E 只读走查）——**折叠策略是硬需求**。
- 既有先例：AgentRun 页的「执行轨迹」是**扁平时间升序列表** + 首尾折叠（`apps/web/src/viewmodels/agentRunViewModel.ts:492`），与 7-C 的**树**形态不同。
- 自治决策事件写进 **`workflow_events`**，**不在追踪树里**；事件时间线**已能显示**它们。

**范围边界**：本阶段**只改 `apps/web/`**——不改 `/trace` 端点、不加 Sandbox 节点、不把决策事件塞进树、不做跨页反向跳转。**不引入新依赖**。

验收项（全部满足才算达成）：

- [x] **TF-01 追踪可达**：在工作流详情里能从一次 run 追踪到**具体工具调用**（`docs/18` 验收原文的前端那一半）。判据：真实 run 上能展开到 `toolCall` 节点，`label` 是真实工具名。
- [x] **TF-02 层级与计数正确**：呈现的层级与 `Workflow → Task → AgentRun → ToolCall`（deployment 挂在产生它的任务下）一致，**不重排、不丢节点**；节点计数以 `view.counts` 为准，**前端不自算第二份口径**。
- [x] **TF-03 规模可控**：`toolCalls: 503` 的真实 run 上首屏渲染节点数有上界（默认折叠：`workflow`/`task` 展开、`agentRun` 折叠、`toolCall` 收起）；展开操作**不触发网络请求**。
- [x] **TF-04 四态与错误**：加载中 / 失败可重试 / 空 / 有数据四态齐备且顺序固定（W5 骨架口径）；`WORKFLOW_NOT_FOUND`（404）与网络失败**文案可区分**。
- [x] **TF-05 只读与脱敏边界**：前端**只呈现**后端已给的东西——**不额外请求** `tool_calls` / `agent_runs` 明细来补工具输入输出（那正是 7-C 刻意剥掉的，`docs/150` §Implementation 7）。无任何修改追踪内容的动作。
- [x] **TF-06 可访问性**：折叠控件用真实 `<button>` + `aria-expanded`；`pnpm --filter @ai-se/web a11y` 在**工作流详情页的追踪展开态**下零违规。
- [x] **TF-07 零后端改动**：变更文件清单**不含** `apps/server/**` 与 `packages/**`（`AGENTS.md` §1：本仓无 git，以文件清单核对）。

**裁定结果（2026-10-15 用户「都按推荐」，本节的开工条件已清空）**：
1. 追踪区放哪儿？**既有工作流详情 `Drawer` 内新增「追踪」区**（与「工作流图」「事件时间线」并列）；树组件外置到 `components/`，不往 991 行的 `WorkflowsView.vue` 里堆。
2. 是否碰 `/trace` 端点？**不碰**——决策事件由既有事件时间线承载，Sandbox 不补节点。
3. 树的渲染形态？**递归可折叠树**（不用扁平列表）。
4. 验收编号？**新造 TF-01 … TF-07 并在本节登记**（本节的由来）。
5. 范围边界？**只做工作流详情内的追踪**，不做需求页 / AgentRun 页的反向跳转。

**实施状态（2026-10-15）**：任务书 `docs/156`；用户 2026-10-15「现在就开追踪前端」授权开工，**TF-01 … TF-07 全部达成**（记录 `docs/157`）。改动**全部落在 `apps/web/`**（TF-07 已按文件清单核对）。

**证据摘要**：① 真实运行上树深 4 抵达 `toolCall`（`label = list_directory`，真实工具名）；② 真实运行 `counts = { tasks: 11, agentRuns: 13, toolCalls: 222, deployments: 0 }` 与遍历树得到的逐类节点数**完全一致**；③ 默认折叠下 `docs/153` 的真实规模（19/16/503/0）首屏 36 个节点；④ a11y 新增阶段 `axe/trace-open` 零 WCAG A/AA 违规；⑤ `apps/web` 全量 **505/505**，lint / typecheck / build 全绿。

**本阶段与 L1-M4 批次并行**（只改 `apps/web`，不重启批次实例 `:47558`，不改它依赖的代码）。

**已知遗留**：`docs/157` Known Issues 1 —— `components/README.md` §1 的「两处以上复用才进 `components/`」判据与本次裁定 1「树组件外置到 `components/`」冲突；本次按裁定放置并已报告，**未自行改 README**，待裁定。

---

### 功能清点 T1 · 移除 `failure-recovery` 半成品（清点表 `docs/231`；**已完成**，记录 `docs/232`）

> **裁定来源**：`docs/231` §10 第 1 项（用户 2026-10-23「都按推荐值，从 T0 备份开始」）——**移除**，
> 理由是该包是死代码且构成第二套失败体系（违反 `AGENTS.md` §10）。用户 2026-10-23 另发「开始 T1」授权开工。
> **本节是追加块**：上文 2026-09-13 / 2026-10 的历史条目按 `docs/146` §6 规则 7 **冻结不改**，
> 它们记的是「当时交付了什么」，本节记的是「现在移除了什么」，两条都成立。

**做了什么**：删除 `packages/failure-recovery/`（生产 381 + 测试 363 行）、
`apps/server/src/services/actionRecoveryExecutor.ts`（292 行）、
`apps/server/src/__tests__/failureRecovery.e2e.test.ts`（1,034 行），合计 **2,070 行**；
摘除 `apps/server/package.json` 的 `build` / `typecheck` 链与 `workspace:*` 依赖；
清理 `apps/server/dist` 里三处指向已删源文件的陈旧产物。

**关键边界**：`WorkflowEngine.failureRouter` 的类型 `FailureRouter` 定义在
`packages/workflow-engine/src/types.ts:146`，**是引擎自己的扩展点**，删包不动引擎——
爆炸半径被限定在「接缝的一个实现者」。

验收项（全部满足才算达成）：

- [x] **T1-01 源码零残留**：全树 grep `@ai-se/failure-recovery` / `ActionRecoveryExecutor` / `createRecoveryRouter`（排除 `docs`、`node_modules`、`dist`）**零命中**。
- [x] **T1-02 依赖与锁文件干净**：`pnpm install --no-frozen-lockfile` 后 `pnpm-lock.yaml` 零残留，`apps/server/node_modules/@ai-se/` 不含该包。
- [x] **T1-03 构建产物无指向不存在包的引用**：`grep -rl failure-recovery apps/server/dist` 零命中；`tsc` 不清理陈旧输出的问题已手工处理。
- [x] **T1-04 全仓门禁**：`-r typecheck` 0、`-r lint` 0、`-r test` **1922/1922 通过，15 个包全绿**。
- [x] **T1-05 读数变化已预先声明**：1944 → 1922（**−26 删除 + 4 记账差**），**没有一条用例从通过变成失败**。
- [x] **T1-06 平台可运行且重启晚于构建**：子进程 `17:08:08` > 最后产物 `17:02:46`，`/health` 200。
- [x] **T1-07 口径改写**：`README.md`「接线状态」表删行并追加说明；`docs/18` / `docs/146` 逐条登记。

**e2e 抖动逐次记录**（现行口径）：第 1 次全仓 1 例超时（`evidenceApi` 5009ms，单独复跑 5/5 过）；
单包复跑 3 例 `socket hang up`（因重建 dist 触发 `tsx watch` 在测试开跑前 12 秒重启平台，
三文件单独复跑 15/15 过）；静置后第 3 次全仓 **1922/1922 全绿**，采纳为 T1 读数。

**已知遗留**：`pnpm-workspace.yaml` 用 `packages/*` 通配，删目录即摘除，**无需改配置**；
但本仓**没有 git**，还原只能靠 `docs/232` §T0 的归档。

---

### 功能清点 T2 · MCP 工具联邦接入（清点表 `docs/231` §3；**已完成（代码与注入层）**，记录 `docs/232`）

> **裁定来源**：`docs/231` §3.3 三条（用户 2026-10-23「都按推荐值」）+ 同日后补的第 1 条修正
> （点号命名被模型 API 拒绝，改为双下划线）。开工授权：用户 2026-10-23「开始 T2」。

**做了什么**：控制台第一次拥有创建服务器的能力（`POST /api/mcp/servers` + 前端对话框）；
发现的工具第一次拥有启停入口（`PATCH /api/mcp/servers/:serverId/tools/:toolId` + 详情页按钮）；
agent 任务第一次真正拿到 MCP 工具（`MCPTaskToolSource` 快照 → 命名空间 `mcp__<server>__<tool>` →
上限 20 → 并入同一个 `ToolRuntime`）。

验收项（全部满足才算达成）：

- [x] **T2-01 注册入口**：`POST /api/mcp/servers` 可用；stdio 缺 command 被冻结契约拒绝（400 `MCP_SERVER_INVALID`）；未知字段（含 `env`）被拒（400 `VALIDATION_ERROR`）；端点上带账号密码被拒。
- [x] **T2-02 连接与发现**：创建即连接并 `tools/list`；连不上仍 201，状态 `DEGRADED`、原因落 `lastError`（不让用户重试出重复行）。
- [x] **T2-03 工具开关**：`mcp_tools.enabled` 默认 FALSE（既有语义，不改），提供唯一的启用入口；界面写明「工具已启用 + 项目级绑定 + Agent 绑定」三件同时成立才可见。
- [x] **T2-04 命名空间**：`mcp__<别名>__<工具>`，全名匹配 `^[a-zA-Z0-9_-]+$`（模型 API 的硬约束，点号实测 400）；同名服务器按 id 顺序得到 `-2`、`-3`，同批内不撞名。
- [x] **T2-05 上限与截断**：每任务最多 20 个；超出时「点名了具体工具」的绑定优先，再按名称稳定排序截断；发 `mcp_tools_truncated` 事件并带截断前总数。
- [x] **T2-06 任务开始快照**：每任务只取一次；任务期间不重算；掉线工具的调用由 `canExecute` 逐次判定并 DENY。
- [x] **T2-07 失败不阻断**：取不到工具时任务照常执行，发 `mcp_tools_unavailable` 事件留痕。
- [x] **T2-08 前端**：列表页有「添加服务器」对话框；空态动作改为「添加服务器」；详情页工具可启停。
- [x] **T2-09 测试**：server 侧 5 + 11 例（真实 registry + 内存 store，仅 MCP 客户端为假）、web 侧 8 例。
- [ ] **T2-10 运行中链路实测**：**未做**——既有边界是「只读走查可以、写接口不行」，添加服务器是写操作。留到 T5。

**已知遗留**：① `env` 字段不开放（明文凭据不落库，`AGENTS.md` §10）——需要 env 的 stdio 服务器走带外注册；
② 端到端（页面点添加 → 真实 discovery → agent 真调到工具）未跑，见 T2-10。

---

### 功能清点 T3 · 浏览器取证（清点表 `docs/231` §4；**部分完成**，记录 `docs/232`）

> **裁定来源**：`docs/231` §4.2 a/b/c（用户 2026-10-23「都按推荐值」）。开工授权：用户 2026-10-23「开始 T3」。
> **本阶段最重要的一句**：视觉修复闭环缺的不是 VLM（网关实测接受图片，HTTP 200），
> 是**参照侧（设计稿）**——产品没有上传入口，`VisualSpecification` 在生产代码里零产出。
> 硬接会得到一条永远在「比较」这一步失败的路径，因此只接取证那一半。

验收项：

- [x] **T3-01 运行时依赖**：`playwright@1.61.0` 从 devDependencies 移入 dependencies（`@playwright/test` 留 dev）；锁文件已核对。
- [x] **T3-02 触发点**：仅当任务 `SUCCESS` 且本任务写过 `.html/.vue/.tsx/.jsx/.css` 时取证一次。
- [x] **T3-03 取证内容**：真实 Chromium 以 `file:` 打开入口页（该会话 allowlist 只有 `file`）→ 等渲染稳定 → 截图 + 控制台/网络错误计数 + 视口。
- [x] **T3-04 证据落库**：`agent_artifacts`（`type = GENERATED_FILE`，`metadata.kind = "ui_screenshot"`）+ `visual_evidence_captured` 事件。**不新增 type**（迁移 005 的 CHECK 是封闭集合，不为一条证据行加迁移）。
- [x] **T3-05 降级口径**：无 UI 交付物 / 无入口页 / 浏览器起不来 → `visual_evidence_unavailable` + 原因，**不判任务失败、不静默通过**。
- [x] **T3-06 不改变判据**：截图不进验证门；`verify` 段判据一字未动。
- [x] **T3-07 测试**：`apps/server` **15 例**（其中 1 例用**真实 Chromium** 渲染临时页面并截出非空 PNG、6 例基线比较纯函数）+ `packages/database` **3 例**（真 postgres：基线查询的 kind 过滤、取最近一条、按项目隔离）。
- [x] **T3-08 基线回归（用户 2026-10-23 裁定 ②）**：同一入口页的首次截图即基线，之后比「是否比上次更糟」；信号为 `render-no-longer-settles` / `console-errors-increased` / `network-errors-increased` / `screenshot-empty`，上发 `visual_regression_detected`。
- [ ] **T3-09 回归 → 自动修复任务**：**未接**。触发修复的唯一通道是「任务失败 → REPLAN/DEBUG」，把已成功的任务翻成失败会污染成功率读数并可能形成修复循环；本阶段只做可观测信号。
- [ ] **T3-10 DOM 断言**：未做（需要一个消费它的校验规则；当前只落截图与错误计数）。

**已知遗留**：参照侧从哪来待裁定（`docs/232` §10：①上传设计稿 ②基线回归 ③不做）。

---

### 功能清点 T4 · 三条缺陷（清点表 `docs/231` §8；**已完成**，记录 `docs/232`）

> 开工授权：用户 2026-10-23「然后开始 T4」。三条都是「读数不可信」类，修法都尽量小。

验收项：

- [x] **N-37 崩溃恢复过状态机**：任务状态机新增**显式**的 `RUNNING → RETRYING` 崩溃恢复边；`WorkflowEngine.recover()` 对每个 `RUNNING` 任务调用 `assertTaskTransition` 再落库——不再有绕过状态机的写入。
- [x] **N-37 消耗重试预算**：`recoverRunningTasks` 同时 `retry_count = retry_count + 1`（真 PG 用例断言恢复后 `retryCount === 1`）。
- [x] **N-39 口径可运行时读取**：`/health` 返回 `verificationGate`（未配置则字段缺席，不编造）。
- [x] **N-39 起跑前断言**：`l1-m4v-e1-x3.sh` 在健康检查之后断言 `verificationGate == $EXPECTED_GATE`（默认 `enforce`），不符 `exit 5`，不花配额；脚本 `bash -n` 通过且 ASCII-only。
- [x] **N-40 编号进提示词**：`taskAcKeys` / `sliceAcKeys` 上移到 `@ai-se/shared`（唯一口径，实现未改）；`TaskContextBuilder.acceptanceScope` 给出本任务的 AC 编号；执行器把它们写进任务提示词并要求测试名带 `[AC-xx]` 标记。
- [x] **测试**：`shared` +5、`workflow-engine` +2、`database` +1（真 PG）、`server` +6。
- [ ] **N-39 的覆盖面**：只在批次脚本里断言；`/health` 报的是**全局默认**，L1/L2 策略仍会强制 enforce，那一层读不到。
- [ ] **N-40 的效果**：只保证编号进了提示词；模型是否据此写标记、门是否因此转绿，要等一次真实运行。
- [ ] **N-37 的真实崩溃**：恢复边在真实 `kill -9` 下的行为未实测。
- [x] **N-41 规划器：非最终切片的交付任务**（回归检查时发现，用户裁定按 ① 修）：`autoFixTaskPlan` 新增确定性规则 `non-final-slice-delivery`，`isFinalSlice === false` 时把 `DEPLOY` / 带交付块的任务剔出本切片并清掉悬空依赖；三处旧断言同步更新（回放录像现在同轮通过）。
- [x] **N-40b eval harness 盲复用失败需求**（回归检查时发现）：按标题复用需求前剔除 `FAILED`/`CANCELLED`，避免项目里遗留的旧失败需求让每次重跑都 60 秒即判失败。
- [x] **N-42 批次 preflight 未断言模型 provider**（回归检查时发现）：实例若在 mock provider 上运行，整批任务「成功」但零产物，读数毫无意义。修法同 N-39：跑批前断言 `/api/model-config` 的 `provider != "mock"`。**已落地**：`l1-m4v-e1-x3.sh` 在 gate 断言之后增加 provider 断言（`mock`/空 → `exit 6`），`bash -n` 与 ASCII 校验通过；上一批失败读数已归档至 `results/l1-m4v/prev-20261023-n40/`。
- [x] **N-43 骨架先行契约（规划期）**（用户 2026-10-23：「先加骨架约束，再重跑回归」）：首个切片的骨架任务必须**真正实现**它声明的每个脚本，而不只是把脚本名写进 `package.json`。实测机制：`S1-T01`（BUILD）的 7 条 AC 全部只描述清单字段 → agent 只写 1 个文件 → 门按 BUILD 跑 `pnpm build` → `Cannot find module /workspace/scripts/build.js`（脚本由 5 个任务之后的 `S1-T06` 创建）→ 首任务在计划层面就不可能通过。落地：`validateSkeletonPlan.ts` 确定性补齐「`pnpm run <s>` 必须真实实现且退出码 0」的 AC（`PLAN_AUTOFIXED` / `skeleton-script-ac`），并对「同一脚本两个提供者」报 `SKELETON_SCRIPT_MULTIPLE_PROVIDERS`；`isFirstSlice` 由 `slice_order` 判定；提示词同步写明契约。只在第一个切片生效，单级/后续切片行为不变。
- [x] **N-43 的效果**（2026-10-24 回归实测）：首个切片不再自相矛盾——骨架任务 `T1` **SUCCESS**，工作区落盘 `package.json` / `pnpm-lock.yaml` / `README.md` / `src/server.js` / `src/scripts/*` / `test/*`（上一轮只有 `package.json`）；五片全部跑完，oracle **Must 25/29**（上一轮 0/29）。剩余 4 条未过 AC（AC-24/25/26/29）是**同一条 Dockerfile 缺陷**：`corepack enable` 后再 `npm install -g pnpm` → `/usr/local/bin/pnpm` `EEXIST`（宿主机复现确认，非偶发）。真成功率仍为 0%（slice-5 有 5 次验证门失败，见 N-44），交付链未执行。
- [x] **N-44 命令过滤器对整串（含引号内参数）做正则，把含 `docker` 的文件名判成 docker 命令**（`docs/232` §9.5，2026-10-24 归因并修复）：`commandTools.ts` 的黑名单改为**引号感知分词 + 精确匹配**——命令头按 basename 比对，其余未加引号 token 必须与黑名单完全相等才拦；引号内是数据，唯解释器 `-c/-e` 载荷仍按旧口径整串匹配（堵 `sh -c "docker …"`）。`commandPolicy.test.ts` 5 例；`tool-runtime` 37/37。第二次回归里 verifier 侧被拦 **0 次**（上一轮 10 次）。
- [x] **N-45 本地 CI 把平台自己的环境变量带进工作区测试**（`docs/232` §9.7/§9.8，2026-10-24 归因并修复）：`deliveryAdapters.ts` 新增 `ciEnvironment()` 白名单（PATH/HOME/本地化/代理/DOCKER_* 等），`runCi` 的 `git rev-parse` 与六步契约全部走它；`deliveryAdapterEnv.test.ts` 3 例 + `deliveryLifecycle.e2e` 通过，server typecheck/lint 全绿。**端到端未验证**：交付链这一轮被规划在 slice-5，而 slice-5 死在规划阶段（见 N-46），CI 根本没跑。
- [x] **N-46 交付切片的「测试先行」在规划期无解**（`docs/232` §9.9/§9.10，2026-10-24 归因并修复）：规则 1 补边成环时先断开环上「TEST 依赖实现（共享 AC）」的倒置边再补正边，判定复用 `isTestFirstMandatedEdge`；无可断倒置边时口径不变。`agent-core` 283/283。**实测生效**：第四次回归 **0 次 cycle-blocked**（上一轮 11 次），切片规划恢复正常。
- [x] **N-47 没有 acKeys 的任务被整片的测试判死**（`docs/232` §9.11/§9.12，2026-10-25「按 ② 修」）：dev 任务自身无 acKeys、却能经 PL-M8 兜底拿到切片 AC 并集时，**不跑**逐任务绿灯 `test` 检查（绿灯交给 `build` + 切片边界），并以 `skippedChecks: [{name:"test",reason:"NO_AC_SCOPE"}]` 留痕；切片内无 AC 记录时维持旧口径，DEBUG 指向 TEST 的红灯检查不跳过。`server` 69/69 + 全仓门绿。**实测生效**（第六次回归）：slice-1/2 的所有 BACKEND 任务全部 SUCCESS，上一轮那种「仓库层任务被 API 任务的测试判死」的形状没有再出现；slice-2 的失败点转移到了 REVIEW→DEBUG(target=TEST) 上。
- [x] **N-48 jsonb 存不下 U+0000，一次写入就让整片倒下**（`docs/232` §9.12/§9.13，2026-10-25 归因并修复）：第五次回归里 `T-06`/`T-07` 及 DEBUG 共 5 个任务以 `LLM_ERROR: unsupported Unicode escape sequence` 失败。**第一次归因错了**（曾判为网关的未配对代理项），查库实测：`select '"\u0000"'::jsonb` 报的正是这句，而 `'"\ud83d"'` 报的是另一句——是 **Postgres 拒绝 jsonb 里的 NUL**。落地：`packages/database/src/jsonbSafe.ts` 在持久化前深度去掉 U+0000，覆盖 `agent_runs.input/output/error/token_usage`、`tool_calls.input/output/error`、`tasks.input/output`、`workflow_runs.output`、`workflow_events.payload`；`jsonbSafe.test.ts` 5 例，`database` 61/61。**实测生效**：第六次回归里该错误 **0 次**（上一轮 5 次）。
- [x] **N-49 门看不见「路由没挂」——只有 oracle 这个黑盒能看见**（`docs/232` §9.13/§9.14，2026-10-25 归因并修复）：第六次回归 slice-1 判 DONE、项目自己的 136 条测试 135 条绿，而 oracle 打 `/api/register` 得到 **404**（`src/server.js` 里根本没有 `/api` 或 `routes` 的挂载）。逐任务检查与切片边界检查跑的都是项目自己的测试，**没人启动过一次真实服务**。落地：切片边界新增独立检查 `server-smoke`——用项目声明的 `start` 脚本起真实进程，再按本切片验收标准里**点名**的路由打一遍 HTTP；业务路由全部 404 判 `SURFACE_UNMOUNTED`，起不来判 `BOOT_FAILED`，健康端点/占位符路由/环境类启动失败不参与判定并记 `smokeSkipped`。`serverSmoke.test.ts` 18 例（含两例真实进程）+ `taskVerifier.test.ts` 2 例接线；真实沙箱容器（`--network none`）两个方向已手工核对。**第八次回归的读数**：`server-smoke` **执行 2 次、通过 2 次**（slice-2 / slice-3 的最后一个任务），另有 1 次以 `no-routes` 留痕跳过；**反向（拦住 `SURFACE_UNMOUNTED`）第一次出现在第十次回归，但那是误判**（把 Docker 卷路径 `/data` 当成了 `GET /data`，见 N-53）——真正的反向案例仍未出现（`docs/232` §9.18/§9.25）。
- [x] **N-50 切片最后一个任务是失败任务的解决者时，边界检查恒不触发**（`docs/232` §9.16/§9.17，2026-10-25 归因并修复）：`S1`（工作流 SUCCESS）里 `S1-T5`(REVIEW) 失败→`S1-T5-REPLAN-1` 成功，而验证 `S1-T5-REPLAN-1` 时它自己还是 `RUNNING`，`isFailureResolved` 沿 `resolvedByTaskId` 走到它、见「非 SUCCESS」即判源任务未解决 ⇒ `siblings-unfinished:S1-T5:FAILED` ⇒ 边界检查不触发。这是 N-35 同族缺陷的自引用残留。落地：`isFailureResolved` 增加可选 `pendingSuccessId`，切片边界判定传入当前任务（判定仍只有一处，`docs/160`）；`resolution.test.ts` +3、`taskVerifier.test.ts` +2。**第八次回归里三个收敛切片都拿到了边界检查，但最后一个任务都是原始任务**，这条修复的具体形状仍未在真实批次复现。

- [x] **N-51 规划超时没有重试——唯一被重试的失败类别恰好不是瞬态的那一类**（`docs/232` §9.19/§9.20/§9.21，2026-10-26 归因并修复）：`planningService.ts:1248` 只在 `errorCode === "VALIDATION_ERROR"` 时走升级人工关口/重试（上限 2 轮，`harness.ts:427-451` 会自动批准），其余一律落到 `:1313` 把切片置 FAILED 终态。超时（`TIMEOUT_ERROR`）与 JSON 解析失败（`PLANNING_ERROR`）因此永不重试——今天四次规划失败全部死在规划、每次让前面已完成的切片白跑。**三个伴生问题**：(F2) 阶段级重试（150s×2）会吃掉外层 600s 预算，实证 15:58:10 `willRetry=true` → 15:58:39 同一 run 被 abort；(F3) 近 30 天成功切片规划 avg 174s / **max 591s**（194 样本），600s 几乎零余量；(F4) 阶段超时被记成 `PLANNING_ERROR`，与 JSON 解析失败同码。普查：近 30 天 15 条终态规划失败（TIMEOUT 9、JSON 3、阶段超时 2、其它 1）没有一条走到升级路径。**落地**：F4 新增 `PlanningStageTimeoutError` 并统一记 `TIMEOUT_ERROR`；F1 新增 `isEscalatablePlanningFailure`（校验失败**或**超时）复用现成升级机制；F3 单切片预算 600s→**900s**（服务与 config 两处）。`planningStageTimeout.test.ts` 2 例 + `planningApprovalReasons.test.ts` +2 + `planningEscalation.e2e` 2/2。**实测生效**（第九次回归）：slice-2 规划超时三次，每次都记成 `TIMED_OUT`/`TIMEOUT_ERROR`（旧代码是 `PLANNING_ERROR`），前两次自动建升级审批并重试、被 harness 自动批准——**修复前第一次超时就会把整轮掐死**。第三次触到 2 轮上限转终态，符合设计。**900s 未成为约束**：三次 run 分别 435/426/424s，真正的卡点是 `task_planning` 阶段预算 150s×2（`docs/232` §9.22）。

- [x] **N-52 `task_planning` 阶段预算与实测规模不匹配**（`docs/232` §9.22/§9.23，2026-10-26 归因并修复）：第九次回归里同一个切片的 `task_planning` **六次尝试全部卡在 150s**（3 个 run × 2 次重试），而三次 run 总时长只有 424–435s——瓶颈不是外层预算（900s），是这一阶段本身（要产出整片任务的 DAG）。落地：`task_planning` 单独一档 **300s**，其余阶段维持 150s；取值规则抽成纯函数 `stageBudgetMs` 使其可测；`PLANNING_TASK_PLANNING_TIMEOUT_MS` 可配。`planningStageTimeout.test.ts` +2、`config.test.ts` +1。**端到端效果待第十次回归**；若仍卡在 300s，说明它不是「慢」而是「挂住」，该换重试策略而不是继续加预算。

- [x] **N-53 `server-smoke` 把容器数据卷路径当成 HTTP 路由（自伤）**（`docs/232` §9.25，2026-10-26 归因并修复）：第十次回归 slice-4 的 `T-12`(REVIEW) 与 `T-12-REPLAN-1` 均以 `checks failed: server-smoke` 失败，证据写 `SURFACE_UNMOUNTED`、探针 `GET /data -> 404`；而 `/data` 来自 `VOLUME /data`、`DATA_DIR=/data`、`挂载 /data 数据卷` 这些**数据卷路径** AC，不是 HTTP 路由。因为该切片 AC 恒定含 `/data`，切片不可能收敛，故人工停批。落地：带方法的路径直接信任，**裸路径只认 `/api…` 与健康端点**；并补上全角标点作为分隔符（`注册点，/api/tasks` 此前根本没被抽出）。用真实 AC 文本核对：slice-2/3 仍产出业务路由，slice-4 变为 `NO_ROUTES` 跳过（正确收紧）。`serverSmoke.test.ts` 22/22。

- [x] **N-54 裸 `/api` 挂载点与 `/api/*` 通配被当成端点（自伤，普查发现）**（`docs/232` §9.26，2026-10-26 归因并修复）：按用户「跑前自检、别让小问题浪费轮次」的要求，把 `extractHttpRoutes` 喂进**全库 1901 条含路径的 AC 文本**（133 个切片）做普查——不复制正则，直接 import 生产函数。两个误判入口：`/api/*` 的 `*` 不在字符类里被截成 `/api/` → 去尾斜杠 → `/api`；而「未实现健康端点、首页 HTML 与 `/api` 路由（留待后续切片）」这类**否定句**同样产出 `GET /api`。逐切片复算发现 `S1-foundation` 的业务路由**只有 `GET /api` 一条**——一条 404 就能判死整个切片。落地：含 `*` 的路径在 `normalizePath` 直接拒掉；裸路径要求 `/api/` 之后还有一段（显式方法的 `GET /api` 仍信任）。A/B：不同路由 24 → 23、抽出业务路由的切片 65 → 64、含 `GET /api` 的切片 5 → 0，**真实路由一条没丢**。`serverSmoke.test.ts` 22 → 26 例（新增四例用普查命中的原文）。本轮 slice-1 预测为 `no-routes` 跳过（已按真实 AC 复算）。

- [x] **N-55 AC 覆盖判定建立在被截断的 stdout 上（第十一次回归的假阴性根因，2026-10-26 归因并修复）**（`docs/232` §9.27/§9.28）：第十一次回归 oracle **29/29 全过**、自报失败、假阴性 1，唯一阻塞是 slice-3 `T7` 连败 3 次，证据为 `uncoveredAcKeys=[AC-24,AC-25,AC-26,AC-29]`，而同一检查 **exitCode 0、258/258 用例全绿**。机制：`packages/sandbox/src/index.ts:69-76` 的 `appendLimited` 只保留**最后 96,000 字节**（`:97` 默认，服务端未覆盖），`taskVerifier.ts:870` 在这段已截断文本上调 `parseAcResults`。A/B（生产解析函数，同一份真实输出）：完整 137KB 解析到 **30 个 AC**，截断后只剩 **15 个**，丢掉的正是排在前面的 AC-01/02/03/05/06/07/08/11/21/22/**24/25/26/29**/30。**次级缺陷 N-55b**：`taskVerifierRules.ts:366` 把 `--test-name-pattern` 追加在脚本命令之后，最小实验证明 `node --test file --test-name-pattern X` **不筛选**（2 条全跑）、`node --test --test-name-pattern X file` 才筛选（1 条）。**落地**：(a) 新增 `detectTestOutputTruncation`，用 TAP 的 `# tests N` 与实际结果行数比对（不依赖沙箱常量）；被截断时**不判「未覆盖」**，按退出码裁决并记 `coverageTruncated: true`；零匹配（`# tests 0`）不算截断，N-27 不变。(b) 脚本自带位置参数时**改写调用**，标志排到位置参数之前，并用探测到的文件**替换** glob（否则兄弟切片文件钩子会把命令拖到 60s、19 cancelled）。**真实工作区 A/B**：258 用例/137KB → **25 用例/5.7KB、25/25 通过、exit 0、10.5s**，四个 AC 全部可解析。测试 +6；门禁 typecheck 0 / lint 0 / server **60/60 文件通过**；构建 18:50:59 → 重启 18:51:32 → 第十二次回归 18:52:17 启动（§9.28）。

- [x] **N-56 「自报成功率」把已恢复的失败祖先算成当前失败（记账口径，2026-10-27 归因并修复）**（`docs/232` §9.29/§9.30）：第十二次回归五个切片全 DONE、交付链 100%、oracle 29/29，summary 却报「自报成功率 **0%**」——`collectTaskMetrics`（`packages/eval/src/harness.ts:78`）的规则是「所有任务行都 SUCCESS」，而 `T-001`/`T6`/`T4` 三行 FAILED 都是**已被 replan 成功替代的祖先**。落地：判自报成功时沿 `resolvedByTaskId` 走到成功后继的失败行不计入（多跳、链断/解决者未成功一律按失败计，fail-closed），`taskStatuses` 普查口径不变。**真实数据 A/B**（把第十二次回归五个工作流的 tasks 从 `/api/workflows/:id` 原样取回喂生产函数）：54 行（SUCCESS 50 / FAILED 4），旧规则 **false** → 新规则 **true**；四条失败链逐条核对均直达成功后继。API 已确认返回 `resolvedByTaskId`。测试 +3，`@ai-se/eval` 68/68 通过、typecheck/lint 干净。按要求**未跑新回归**，批次级读数留待下次。

**已知遗留**：三条缺陷的「代码已改」与「效果已验证」之间隔着一次真实运行，随 T5。

## F1 — 前端端到端验收（2026-10-27 起；**正式验收通过**，2026-11-03 / 04）

> 阶段定义与通过条件：**`docs/233` §6.2**（五条，缺一不可）。缺陷账本：`docs/232` §10（N-57 起）。
> 逐轮读数：`packages/eval/results/f1-frontend/round*/`。阶段状态入口：`docs/146` §1.1。
> 正式验收轮：**round20**（归档 `packages/eval/results/f1-frontend/round20/`）。
>
> **口径提示**：§6.2 条件 5 原文写「4 个切片」；N-68 修复（AC 按 FR 归属）之后实际按 FR 切，
> 常见是 **5 片**。该条件按「**每个切片走通**」读，不按固定片数读。
>
> **运行约束（as-built）**：F1 批次走 **OpenCode**（`.env` 保持 `opencode.ai` + 既定模型，**勿改 DeepSeek 直连**）；
> 停批用 `packages/eval/scripts/f1-frontend-stop.sh`。**单工作流 retry / 冒烟 ≠ 正式 F1 分数**——正式分数只认
> `f1-frontend-x3.sh`（或同形 harness）写出的 `run-1.json` / `run-1-summary.md`。

- [x] **条件 1–4（夹具与 oracle）**：reference oracle **24/24 × 3 轮、0 条 AC 翻转**；template
  **19 条 Must 失败**（判据 ≥15）；`empty-shell` 命中 `SURFACE_MISSING` 且 oracle 失败；
  `no-console-clean` 只让 AC-20 失败（`docs/233` §6.2、`docs/235` §6.4 本机读数）。
  **注**：条件 3 / 4 是 N-71 改 ui-smoke（起 mock 再探页面）**之前**的读数，改后尚未复测。
- [x] **端到端批次跑到链尾**：round 12（2026-11-01）五片全 SUCCESS、**SUCCESS×37 零失败任务**、
  链完成率 100%、真成功率 100%、自报成功率 100%、假阴性 0、oracle **24/24**；
  **round20（正式验收，2026-11-03 15:03→17:51 上海时区）**再确认：SUCCESS×41、oracle **24/24**、
  链完成 / 真交付 / staging 段均为 100%、假阳/假阴 0。
- [x] **逐任务门不产生 Node 契约类假失败**：N-57 / N-61 / N-62 / N-64 / N-65 / N-66 / N-67
  修复之后，rounds 8–15 与 round20 的 Node 契约类失败为 **0**。
- [x] **交付链被规划出来**（N-73，2026-11-02）：最终切片排出 `CI` / `DEPLOY(staging)` /
  `VERIFY(staging)` 三个交付任务（`{"action":"CI"}` 等已落库），且**不含 production**。
- [x] **CI + staging deploy + staging verify 三段走通**（**round20 正式达成**）：
  `stagingSegment = SUCCESS/SUCCESS/SUCCESS`；汇总「是（SUCCESS/SUCCESS/SUCCESS）」；
  真交付 100%、假阳性 0、假阴性 0；墙钟约 **168 分钟**（`durationMs≈10088745`）；
  人工介入 1；归档 `packages/eval/results/f1-frontend/round20/`
  （`run-1.json` / `run-1-summary.md` / `round20-20261103-150307.log`）。
  此前 round 15 曾在交付前人工停止；round19 到达 slice-5 但 staging 段失败（对照）。
- [ ] **连续稳定读数（加固项，非 §6.2 五条之一）**：round20 已给出正式全绿，但 round19 仍失败；
  「连续多轮全链完成 + 假阴性 0」尚未形成。**不阻塞 F1 正式验收收口**，也不阻塞进入阶段 8。

### F1 门禁补记（矛盾期望 + 门禁 P1）

- [x] **矛盾测试期望门禁**（round18 根因族）：`CONTRADICTORY_TEST_EXPECTATIONS`——在 Local CI 跑
  `pnpm test` **之前**静态扫描 `*.{spec,test}.{ts,tsx,js,jsx,mjs,cjs}`；同一用例体内按
  `STATE_BOUNDARY_RE`（含 `await` / click / `setValue` / **`.value=`** / **`setXxx(`** 等）切段，
  同段内同一 `expect(subject)` 出现互斥 `toEqual` / `toStrictEqual` / `toHaveLength` 则早停。
  实现：`apps/server/src/services/contradictoryTestExpectations.ts`；接入
  `deliveryAdapters.ts` / `deploymentOrchestrator.ts`；单测
  `apps/server/src/__tests__/contradictoryTestExpectations.test.ts`。
- [x] **门禁 P1（REPLAN 改测路径，2026-11-03 落地；2026-11-04 09:06 上海时区重启 server 加载）**：
  CI 命中矛盾期望时写出 `fixTaskType=TEST` + `errorType=CONTRADICTORY_TEST_EXPECTATIONS`
  （`contradictoryCiReplanHint`）；REPLAN = **DEBUG(改测, target=TEST) → 同契约 CI retry**，
  不再对同一坏测盲目重跑。关键路径：`contradictoryTestExpectations.ts`、
  `deploymentOrchestrator.ts`、`packages/workflow-engine/src/WorkflowEngine.ts`（`replan` 拆派发键/契约键）；
  单测含 workflow-engine「门禁P1」用例与 server `contradictoryCiReplanHint` 用例。
  **生效条件**：改完须**重启平台 server**（本次已于 2026-11-04 09:06 上海时区重启，PID 93705 一带）。
