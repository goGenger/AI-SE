# Development Roadmap

## Phase 0 — Engineering Foundation

工程骨架稳定可运行。

## Phase 1 — Coding Agent Runtime

LangGraph.js + LangChain.js + Zod + Docker Sandbox，完成真实 Bug Fix Agent。

## Phase 2 — Persistent Agent Runtime

Agent Run 持久化、checkpoint、恢复、重试、取消、SSE。

## Phase 3 — PRD → Task Graph

Requirement → Specification → Task → Dependency DAG。

## Phase 4 — Dynamic Workflow

Plan → Execute → Observe → Decide → Re-plan。

## Phase 5 — Professional Multi-Agent Coding

Deep Agents + LangGraph + LangChain；Planner、Frontend、Backend、Database、QA、Reviewer、DevOps。

---

# Phase 5.5 — MCP Tool Federation

目标：将外部 MCP 工具安全纳入已有 Tool Runtime。

```text
5.5-0 Contract Freeze      ✅（docs/25、docs/26）
→ 5.5-1 Local MCP          ✅（docs/27：官方 SDK 1.30.0，stdio，真实协议 E2E）
→ 5.5-2 Tool Runtime Integration ✅（docs/27：MCPToolRegistry/Adapter，统一 ToolDefinition，默认 DENY）
→ 5.5-3 Registry & Persistence ✅（docs/29：迁移 008、PgMCPRegistryStore、PersistentMCPRegistry、重启恢复、fail-closed 0 请求）
→ 5.5-4 Remote MCP & Auth  ✅（docs/30：Streamable HTTP、生命周期/重连/DEGRADED、credentialRef 引用解析、真实 HTTP E2E）
→ 5.5-5 MCP Console ✅（docs/31：/mcp 列表与详情、状态/Tools/Risk/Binding 管理、Browser 不直连 MCP）
→ 5.5-6 Resource & Prompt ✅（docs/32：独立 Adapter、真实 stdio+HTTP、授权链复用、零请求拒绝）
→ 5.5-7 MCP Apps ✅（docs/33：ui:// 经既有资源架构、sandbox allow-scripts、Host Bridge strict schema、受控动作经 ToolRuntime、凭据隔离）
→ 5.6-0 Visual Contract ✅（docs/35：输入 URI 契约 + VisualInputRecord + UI Spec 四层 + Design Tokens + Component Map，全契约冻结零实现）
→ 5.6-1 Visual Analysis ✅（docs/36：@ai-se/visual 新包、VLMProvider 接口 + 确定性 fake、VisualAnalyzer 规范化管线、VisualAnalysisReport + MD 导出、脱敏单源下沉 observability）
→ 5.6-2 Visual Spec → Frontend Task ✅（docs/37：FrontendTaskDraft 纯数据层、确定性组件匹配 + gap 直通、risk/approval 派生冻结、零第二套 Task 模型/零 migration/零 REST）
→ 5.6-3 Browser Runtime ✅（docs/38：@ai-se/browser 新包、7 ToolDefinition 经 ToolRuntime 冻结面、waitForRender 组合策略（networkidle+3s 硬上限+settled）、真实 Chromium e2e 零外网、screenshot:// record 接缝、凭据零注入）
→ 5.6-4 Visual Evaluation ✅（docs/39：evaluateVisuals 配对门+structural 主体+像素辅助（零依赖 PNG codec）、冻结评分链 PASS/LAYOUT/COMPONENT/STYLE、known-gap 归因通道、半稳态标注、md 脱敏可重放）
→ 5.6-6 Responsive & Interaction ✅（docs/40：RESPONSIVE_VIEWPORTS 冻结矩阵、薄封装全直通 evaluateVisuals、六态翻转取 shared 枚举、跨断点描述性 summary、单 session 双断点真实 @media e2e、零 shared 改动）
→ 5.6-5 Auto Fix / Re-plan ✅（docs/41：visualIssuesFromReport 分类（gap 不进修复候选）、buildFixTaskDrafts 复用 5.6-2 模型（autoSubmitted 恒 false）、determineFixOutcome 三态、FixLoopState 冻结常量推进、serializeFixAuditTrailMd 全链审计串、零 shared 改动）
→ 5.7-0 Computer Use Contract ✅（docs/43：ExternalActionRef 三来源判别联合 + Observation DOM/A11y 双形态（base64不入契约）+ ActionResult 三态不变式（error.code 枚举推迟 5.7-5）、12 契约测试、纯契约零行为）
→ 5.7-1 Browser Computer Use ✅（docs/52：`browser.observe` 产出严格 5.7-0 Observation（DOM 固定脚本 + aria snapshot，观察 ref 可直接作动作选择器），4 个动作工具（navigate / click / type / screenshot）经既有 ToolRuntime 治理、截图复用 5.6-3 资产管线、浏览器上下文零凭据注入；**docs/53 为敏感输入隔离修复**——探针曾证明 password 值经 DOM `value→text` 与 `page.ariaSnapshot()` **双通道泄漏**，修复后 5.7-1 PASS）
→ 5.7-2 External Engineering Systems ✅（docs/54：ExternalToolCatalog 声明外部系统 tool 名单与风险等级，连接器经 MCP client（5.5-1 / 5.5-4 冻结面，**零直连外部 API**），注册进既有 ToolDefinition 复用 schema / permission / risk。**边界：连接器实现为 fake / echo harness，真实外部 API 凭据只注入不实现**）
→ 5.7-3 Action Policy ✅（docs/55：GUI 动作与外部系统动作共用**同一张 LOW / MEDIUM / HIGH 冻结风险表** + verb floor；`approvalRequired` 由风险**派生**并复用既有 WAITING_APPROVAL 链，审计走既有 ToolCallRecorder，零第二套事件体系；不信任动作自报风险）
→ 5.7-4 Evidence & Verification ✅（docs/56：EvidenceRecord 契约、迁移 `009_phase5_evidence.sql` 持久化、关键外部动作前后 Observation 对（before/after 必备）、执行前后一致性判定复用 5.6-4 三态思想、Evidence 查询 API；凭据零明文（`redactCredentialShapedText`，测试反例锁定））
→ 5.7-5 Failure Recovery ✅（docs/57：失败分类冻结表 ELEMENT_MISSING / LOGIN_EXPIRED / NETWORK_FAILED / UI_CHANGED / TIMEOUT / CANCELLED、re-observe、retry 与 re-plan **复用既有链**（不建第二套循环器）、连续失败或 HIGH 风险转人审）
```

MVP = 5.5-0 ~ 5.5-3。

核心原则：MCP 不是 Agent Runtime，也不是 Workflow Engine；Agent → Tool Runtime → MCP Adapter → MCP Server。

---

# Phase 5.6 — Visual Engineering & Browser Validation

目标：让 AI-SE 完成“视觉输入 → 分析 → UI Specification → Frontend → Browser → Visual Evaluation → 自动修复 → Responsive / UI State Validation”的视觉工程闭环。

## 5.6-0 Visual Contract

定义并冻结 Visual Input、Visual Reference、UI Specification、Design Tokens、Component Map、Layout/Constraint、Asset Reference 与 Visual Evaluation 基础契约。

## 5.6-1 Visual Analysis

支持 Screenshot / Figma / URL 输入，将视觉内容转换为结构化 Visual Analysis 与 UI Specification。VLM 通过可替换 Provider 接入；真实输入链路必须可验证。

## 5.6-2 UI Specification → Frontend

Frontend Agent 消费 UI Specification，复用现有组件库和 Design Tokens，实际完成页面代码修改，并沿用现有 Agent / ToolRuntime / Sandbox 执行链。

## 5.6-3 Browser Runtime

通过受控 Browser / Playwright 完成导航、Viewport、Screenshot、Console / Network / Runtime Error 采集与证据关联。Browser 必须经过 ToolRuntime。

## 5.6-4 Visual Evaluation

完成 Reference vs Candidate 比较，输出结构化 Visual Score、Visual Issue、Difference 与 Evidence。

## 5.6-5 Auto Fix / Re-plan

将 Visual Issue 转为 Fix Task，由 Frontend Agent 实际修改代码，重新运行 Browser、截图并自动评估；无进展或超过轮次后进入既有人工/Workflow 边界。

## 5.6-6 Responsive & UI State Validation

验证 Desktop / Mobile 等 viewport 以及 Loading、Empty、Error、Disabled、Focus、Active、Hover、Expanded、Modal 等 UI State，并纳入 Visual Evaluation。

## MVP

5.6-0 ~ 5.6-4。

## Full Phase

5.6-0 ~ 5.6-6。

## Current Status

5.6-0：✅
5.6-1：✅ 实现完成(三链路 + 真实 VLM Provider + 统一链路);外部 live 凭据 e2e BLOCKED BY EXTERNAL CONFIG(见 docs/45/51)
5.6-2：✅ 完成(2026-09-12 Repair,见 docs/46)
5.6-3：✅ 完成(2026-09-12 Repair,见 docs/47)
5.6-4：✅
5.6-5：✅ 完成(2026-09-12 Repair,见 docs/48/49)
5.6-6：✅ 完成(2026-09-13 Repair,见 docs/50)

> **2026-09-13**:5.6 → 5.7 Global Regression **PASS**(docs/51)——PHASE 5.6: FROZEN;PHASE 5.7: READY(5.6-1 外部 live e2e BLOCKED BY EXTERNAL CONFIG,未伪装 PASS)。

> **2026-10-19 状态更正**：上一条写于 5.7 **开工之前**，其中的「PHASE 5.7: READY」是**当时**的就绪标记，**不是终态**。**5.7 此后已全部完成**——`5.7-0` … `5.7-5` 六项在 `docs/17` 节「Phase 5.7 — Computer Use / External Engineering Tools」**全部勾选**，记录 `docs/43`、`docs/52`–`docs/57`，账本 `docs/146` 记「已完成」。**唯一保留的边界**：`5.7-2` 的连接器是 **fake / echo harness**（真实外部 API 凭据只注入不实现），`5.6-1` 的外部 live 凭据 e2e 仍为 `BLOCKED BY EXTERNAL CONFIG`（未伪装 PASS）。本节上方链条此前只列到 `5.7-0`，本次一并补齐。

# Phase 6 — CI/CD & Delivery — V1

GitHub Actions → Docker Image → Registry → Staging → E2E → Human Approval → Production → Health Check → Rollback。

Phase 6 完成后 AI-SE V1 核心版本完成。

完整链路：

```text
PRD
→ Requirement / Specification
→ Task DAG
→ Dynamic Workflow
→ Multi-Agent Development
→ QA / Review
→ Git
→ CI
→ Docker
→ Staging
→ E2E
→ Approval
→ Production
→ Health Check / Rollback
```

---

# Phase 7 — Observability

> 任务书：`docs/147`（2026-10-15 已裁定）。**Phase 7 已于 2026-10-15 收口**：M1（7-A / 7-B）与 M2（7-C / 7-E）全部交付，OB-01 … OB-10 全绿；`docs/17` 六项回填为**完成 2 项 / 延期 4 项**；记录 `docs/149` / `docs/150` / `docs/151` / `docs/152`，**收口记录 `docs/153`**。下面是路线图的设计口径；分期与交付范围以任务书为准。其中外部栈（OpenTelemetry、Prometheus 服务端、Grafana、Loki）**已裁定延期**（不引入依赖与基础设施，`docs/147` §6 第 1 项）；Prometheus 一项为「**延期（部分替代）**」——平台侧的 Prometheus 文本端点已由 7-B 交付，服务端与抓取未部署。

OpenTelemetry + Prometheus + Grafana + Loki。

建立：

```text
Request
→ Workflow
→ Task
→ Agent
→ Tool
→ Sandbox
→ Deployment
```

完整 trace、metrics、logs 和成本/成功率等指标。

---

# 自治 L1 — 策略内自治（Phase 0–8 之外的增强目标）

> 任务书 `docs/154`，实施记录 `docs/155`；验收定义见 `docs/17` 节「自治 L1 · 策略内自治」。**M1 – M3 已于 2026-10-15 实施并通过**；**L1-8 已于 2026-10-23 按 `l1-m4u` 达成并收口**（`docs/224`）。历史长串复验批次与致败点仍见 `docs/17` L1 节追加块与 `docs/127`。
> **（2026-11-04）复验任务书待审**：在 F1 round20 + 门禁 P1 + Phase 8 落地后的当前平台上，再跑一轮严格 L1 实机复验——**`docs/247-l1-revalidation-taskbook.md`**（建议批次 `l1-rv1`，E1×3 + `--autonomy-l1`；出口含 staging≥2/3 **与** `AUTO_APPROVED` 记账）。**先审后跑**；未批准前不开批、不改 `.env`。

策略内自治：staging 与低风险动作自动，生产与高风险仍必须人工。不新增第二套 Approval / Audit，全部复用既有抽象。

---

# Phase 8 — AI SRE

> **状态（2026-11-04）**：F1 正式验收已通过；Phase 7 已收口；**Phase 8 AI SRE（8-A→8-D）已收口并生效**（`docs/243`…`docs/246`；迁移 `020`–`022`）。
> 任务书：**`docs/242-phase-8-ai-sre-taskbook.md`**。设计原文：`docs/13`。**勿与** Agents UI Phase 8（`docs/78`/`docs/79`）混淆。
> 8-D：代码默认 `INCIDENT_AUTO_REMEDIATE=false`；本机当前进程环境可为 `true`（**.env 未写**）。

```text
Alert
→ Incident
→ Diagnosis
→ Evidence
→ Fix Plan
→ Branch
→ Fix
→ Test
→ Review
→ Staging
→ Approval
→ Production
→ Verify
```

生产环境中的高风险动作必须继续经过 Tool Runtime、Policy、Approval、Audit。
第一版只允许白名单故障类型；禁止任意生产 shell、删库、改 Secrets、绕过审批、未验证的自动生产修复。

建议里程碑（细节与验收码见 `docs/242`）：**8-A 告警摄入与 Incident 对象** → **8-B 只读诊断** →
**8-C 受控修复计划（止于 staging+审批）** → **8-D 白名单自动修复闭环（可选）**。

---

# Overall Dependency

```text
Phase 5
  ↓
Phase 5.5 MCP
  ↓
Phase 5.6 Visual Engineering
  ↓
Phase 5.7 Computer Use / External Tools
  ↓
Phase 6 Delivery
  ↓
Phase 7 Observability
  ↓
Phase 8 AI SRE
```

5.5、5.6、5.7 是 Phase 5 Multi-Agent 到完整 Software Engineer 能力之间的工程增强层，不应破坏已经完成的 Agent Runtime / Workflow / Tool Runtime。

每个 Sub-phase 独立验收、独立提交、独立回滚；完成后才进入下一 Sub-phase。

## Post-V1 Validation

V1 完成功能建设后进入 Real AI Validation。

该阶段不新增平台能力，仅验证：

PRD
→ Real LLM
→ Planning
→ Dynamic Workflow
→ Multi-Agent
→ Code
→ Test
→ Recovery
→ Delivery

## Post-V1 Enhancements(V1 后增强)

V1 验收后按"一次一个任务、独立验收、独立回滚"追加的可用性 / 工程增强:不改变已冻结的 Runtime /
Workflow / Agent / Tool 契约,每个任务有独立任务书与实施记录。

| 任务                                  | 任务书  | 实施记录 | 一句话结果                                                                                                                                                                                                         |
| ------------------------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 失败工作流重试(Retry Failed Workflow) | docs/99 | docs/100 | FAILED 工作流可人工重试:只重排未解决失败任务与 BLOCKED,已完成(SUCCESS)任务跳过、不重烧 token,重试后沿既有调度/执行链继续跑完;状态机新增 `FAILED → RUNNING` 与 `BLOCKED → PENDING` 两条边,`start`/`resume` 前置收紧 |
| 前端可用性改造(W1–W10)                | docs/132 | docs/133–142 | 控制台前端的系统性重构,按 P0–P10 审评拆成 10 个命名阶段:拆双样式体系 → 重建设计令牌与排版 → AppShell/信息架构 → 页面骨架 → 仪表盘 → 表格 → 交互容器 → 可访问性 → 终验。**W1–W10 全部完成**(docs/133–142),该线已收口。W5 把 10 个页面收敛到同一骨架(四态共享件、`DetailRow`、scoped 块 10→2、`grid-cols-[…]` 24→7);W6 把仪表盘从陈列改成分诊(删轨道与入场动画、`!important` 归零、scoped 块 2→1);W7 立表格规范(全表去 `text-center`、默认左对齐 + 数字列右对齐带等宽数字、表头三态排序 + `aria-sort`、分页默认打开、AgentRun 7 列→5 列、「复制 ID」改为 ID 文本可点复制);W8 立交互容器规范(容器判据成文、三种危险确认机制收敛为 `ConfirmDialog`、`window.confirm` 归零、Cmd/Ctrl+Enter 提交 9 个表单);W9 做可访问性与一次配色裁决(`lang=zh-CN` + 真实 favicon、状态徽标加图标成三重冗余、28 组×2 模式对比度实测、`--input` 1.54→3.41/3.14 修正、`--border`/`--foreground-disabled` 按 WCAG 条款豁免、删零使用的 `--border-strong`);W10 终验(6 条机械检查全达标、8 条原始问题 7 条已解决 1 条部分解决、`apps/web` 36 文件/446 用例全绿、全仓 16 包/175 文件/1434 用例全绿、死类名再清 5 个、`.taste-skill/` 移出仓库) |
| 模型与凭据配置(Model & Credential Config, X1) | docs/144 §七 | docs/145 | **已完成**(与 W13 同一批)。三件事:①**让「既有 Secret Provider」第一次真实存在** —— 新增 `envCredentialResolver` 并在组合根注入 `RemoteMCPClient`(`packages/mcp` 的 `MCPCredentialResolver` 此前**只有类型、零实现、零接线**,后果是任何带 `credentialRef`/`authRef` 的服务器连接时直接抛 CONNECTION);`secret:mcp/servers/github` → `MCP_SECRET_MCP_SERVERS_GITHUB`,映射恒带 `MCP_SECRET_` 前缀所以引用无法点名任意环境变量,全空白视为未配置,未配置走既有 fail-closed 路径。②**模型配置运行时可改** —— `ModelConfigService` 持有**就地改写**的活配置对象(工作流任务路径每个任务才现构造 provider,换新对象就等于改动不生效),启动时只构造一次的两条路径(planning 模型 / AgentRun provider)用 `LiveLLMProvider`/`LivePlanningModel` 按配置版本号重建,**三条路径行为一致**;③**设置页** `/settings` + 侧栏「系统」组 + 命令面板条目。凭据规则守住:读回对象**没有 `apiKey` 字段**(只有 `apiKeyConfigured` 布尔),校验失败**不回显请求体**,密钥不落库/不落盘/不进日志。`provider` 保持只读(部署级选择,改它要重新装配模型链路)。**不新增 migration、不新增依赖**;「重启即失效」是已知限制并明写进页面文案。真实后端只读走查 **20/20**,并用 API 复核未改动其配置 |
| 无障碍扫描器扩展 / 屏幕朗读转录(W13)           | docs/144 | docs/145 | 承接 W12 押后的两项,与 X1 一批做完:①**axe 扫描器扩展 4 个阶段** —— `axe/data`(参数化路由改用**运行时发现**的真实 id;此前每个详情页都是在错误态下被扫的)、`axe/dialog-open`、`axe/drawer-open`、`axe/reject-confirm`(只点开确认框、Esc 关,并用**只读 GET 前后比对**三重硬断言没有提交审批决定 —— 那是用户的真实待审批记录)。14 路由 × 9 阶段**零违规、零水平溢出**,各阶段实扫计数 `5/5/1/1` 证明真扫到(阶段失败会硬报错,不留「扫了 0 条却报通过」的假绿灯)。发现失败时退回占位符并**明确标注** `placeholder (未见真实数据)`,不冒充数据态。②**屏幕朗读转录** `a11yTree.mjs`(CDP `Accessibility.getFullAXTree` —— `page.accessibility.snapshot()` 在 Playwright 1.61 已不存在):10 个状态的线性朗读顺序,「命名问题」全 0;W12 补的弹窗描述首次以 `describedby=… // desc: …` 的形式在树里被观察到。**明确说明转录替代不了人耳**。另**发现一处文档与代码不一致**:工作流页的弹窗触发按钮是「新建工作流」、弹窗标题才是「创建工作流」,已按代码取词并把两者分开。**另:真实屏幕阅读器走查经用户裁定不做,本项关闭**(W11 起承接两轮,现不再列为未做项;放弃的覆盖面见 docs/145 §三) |
| 前端收尾(W11)                          | docs/142 | docs/143 | 清理 W10 终验登记的遗留项,四项一次做完:①**路由级代码分割**(13 条路由静态 import → 动态,入口 chunk 569.62 kB → 65.94 kB,build 的「> 500 kB」警告消失,首屏实测 309.9 kB 未压缩);②**两个详情抽屉同步 URL**(`?requirement=` / `?agent=`,四个抽屉现已全部同步,URL 为唯一真源;需求页因 `loadRequirement` 扇出 6 个请求而加了按 id 去重的 `ensureRequirementLoaded`);③**200% 缩放 / 强制高对比度 / 文本间距三阶段实测**(13 条路由零违规、零水平溢出);④**接入 axe 扫描器**(`axe-core@4.14.0` + `playwright@1.61.0` devDependency,`pnpm --filter @ai-se/web a11y`,13 路由 × 4 阶段,路由清单从 router 反向提取并断言非空)。**首轮扫描查出 2 条 W1–W10 都没发现的真实违规**:`WorkflowsView` 两个筛选下拉因 `combobox` 不支持 name from content 而无名(critical,补 `aria-label`)、顶栏搜索按钮 `aria-label` 与可见文字不符(serious SC 2.5.3,删掉 `aria-label` 并改 `sr-only sm:not-sr-only`,顺带修掉窄屏下按钮原本无名)。另采纳 W10 候选①:仪表盘 ①② 指标卡并排,1440×900 首屏 5 行不再差 15px。**首次把前端改动对着真实后端验证**(18/18) |
| 前端遗留项收口(W12)                    | docs/143 | docs/144 | 承接 W10 登记、W11 未清的遗留项,先逐条裁定再动手,四项一次做完:①**5 个弹窗补可访问描述**(项目/需求/工作流/运行的新建框 + 部署的环境设置框;`DialogDescription` 会把 `aria-describedby` 指过去,reka-ui 的 `Missing Description` 告警在 5 页实测消失,并加「每个 `<Dialog` 必须带 description」护栏);②**删除零使用的 `showIcon`**(默认值本就是 true、64 处调用全用默认值,渲染输出不变);③**`docs/142` SC 编号勘误**(「强制高对比度」被标成 SC 1.4.12,而 1.4.12 是 Text Spacing;追加勘误块,**原结论一字未动**);④**审批拒绝带修改意见**(`WorkflowsView` 的「拒绝」改走统一 `ConfirmDialog`,`decide` 增 `comment` 参数与 `Promise<boolean>`;批准保持一键)。另裁定 7 项:**W6「最近项目→最近工作流」保留现状**、`--input` 在 `--muted` 面**不改只记文档**、表头 sticky **维持不做**、420 文件 Prettier **不格式化**(本仓无 git,不可回退)、axe 覆盖面扩展与真实屏幕阅读器走查**押后**、X1 前置**已裁定**(见 X1 行)。**新增 6 句可见文案**(5 句弹窗描述 + 1 句确认框描述,待用户过目)。真实后端浏览器走查 **30/30**,并用 API 复核审批仍为 `PENDING`(走查未改动真实数据) |

> 说明:更早的 V1 后增强(如 UX-01~03,docs/94–97)当时未在本文件登记,以其编号文档为准;
> 自本任务起,Post-V1 增强统一登记在本节。
>
> **前端改造是一条独立的编号流**:docs/118–122(布局改造)、docs/132–142(W1–W10 审评改造)
> 同属 `apps/web` 的可用性工程,各自以编号文档为准;本表只登记其入口与进度。

> **F1 — 前端端到端验收：正式通过（2026-11-03 round20）**。设计 `docs/233`、缺陷账本
> `docs/232` §10（N-57 起）、逐轮读数 `packages/eval/results/f1-frontend/`（正式归档
> `round20/`）。在 `frontend-vue` profile 下，纯前端夹具把「需求 → 切片 → 逐任务门 → 交付链」整链走通：
> oracle **24/24**、staging **CI/DEPLOY/VERIFY 全 SUCCESS**、真交付 100%、假阳/假阴 0、约 168 分钟。
> 矛盾期望门禁 + 门禁 P1（命中后 `fixTaskType=TEST`，REPLAN=DEBUG 改测→同契约 CI）已落地，
> 2026-11-04 09:06 上海时区重启 server 加载。运行约束：OpenCode（`.env` 勿改 DeepSeek 直连）；
> 停批 `f1-frontend-stop.sh`；工作流 retry 冒烟 ≠ 正式 F1 分数。勾选见 `docs/17` F1 节。
>
> **Phase 8 — AI SRE 已收口（8-A→8-D）**：任务书 `docs/242`，记录 `docs/243`…`docs/246`；**不是** Agents UI 的
> Phase 8-A/B（`docs/78`/`docs/79`）。设计基线仍见 `docs/13`。
> **下一步（待审）**：自治 L1 复验 **`docs/247`**（先审后跑；非自动推进）。
