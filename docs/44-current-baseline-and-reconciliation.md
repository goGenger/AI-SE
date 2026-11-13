# Current Documentation & Implementation Baseline

> 这是当前 AI-SE 文档的权威状态说明。历史 Completion Report 保留用于记录当时实现过程，但其 PASS 结论不能覆盖本文件与 `docs/17-acceptance-checklist.md` 当前验收标准。

## 1. Overall Status

```text
Phase 0–5:       ✅
Phase 5.5:       ✅ FROZEN
Phase 5.6:       ✅ FROZEN(docs/51;5.6-1 外部 live BLOCKED BY EXTERNAL CONFIG)
Phase 5.7-0:     ✅ Contract frozen(docs/43)
Phase 5.7-1:     ✅ 完成 + 观察安全 Repair(docs/52/53)
Phase 5.7-2:     ✅ 完成(docs/54)
Phase 5.7-3:     ✅ 完成(docs/55)
Phase 5.7-4:     ✅ 完成(docs/56)
Phase 5.7-5:     ✅ 完成(docs/57)
V1 Final Acceptance: ✅ ACCEPTED(docs/58;2026-09-13)
```

## 2. Confirmed Completed

### V1 Final System Acceptance（2026-09-13，docs/58）

**AI-SE V1: ACCEPTED** —— 全仓四门禁 exit 0（111 文件 / 682 测试，0 failed / 0 skipped）；migration
fresh + checksum 守卫通过；Golden Scenario 真实跑通（PRD → Planning → Dynamic Workflow →
Multi-Agent → 真实 QA 失败 → 动态 Re-plan → Review → CI → Staging → 审批 → Production），
pause/resume、cancel、server-restart recovery 同轮真实验证；架构/安全扫描全部干净。
VLM / Figma / GitHub / GHCR / Production = BLOCKED BY EXTERNAL CONFIG（未伪装 PASS）。

### Phase 5.5

5.5-0 ~ 5.5-7 均已完成并通过原 Global Regression：

- MCP stdio
- MCP Tool Federation
- Registry / PostgreSQL
- Streamable HTTP
- MCP Console
- Resource / Prompt
- MCP Apps
- security / governance boundaries

  5.5 已正式冻结。

### Phase 5.6

已可靠完成：

- 5.6-0 Visual Contract 基础契约
- 5.6-4 Visual Evaluation 基础能力
- **（2026-09-11）5.6-1 三输入真实链路代码 + 真实 VLM Provider 完成（见 docs/45）；
  live 外部凭据 e2e BLOCKED 待配置**

### Phase 5.7

5.7-0 Computer Use Contract 已存在，但只作为契约产物，不代表 5.7 readiness。

## 3. Phase 5.6 Deviations

### 5.6-1 Visual Analysis

**2026-09-11 修复更新(docs/45)**:三输入链路真实已实现 ——
Screenshot(`OpenAIWireVLMProvider`,OpenAI 兼容 vision,key 注入 fail-fast)、
Figma(`FigmaVLMProvider`,REST /v1/files 确定性节点树映射,token 注入)、
URL(`UrlFetchVLMProvider`,allowlist 先于网络 I/O 的确定性 HTML 解析),
统一入口 `analyzeUnifiedInput` → 同一 analyzer 管线 → frozen 5.6-0 schema;
Fake VLM 保留(测试通过);provider 可替换(接口未动)。
visual 76/76;集成测试用本地 mock HTTP(零外网)。
**live 外部 e2e:BLOCKED(OpenAI/Figma 凭据环境未配)** —— 凭据到位后
(provider 参数化,零代码改动)跑 live 验证即可提升为 PASS。
付费(未付)凭据不进入仓库、不进 prompt/state/log,全部注入口径不变。

原评估(deviation 描述)保持记录以便审计:

目标要求：

```text
Screenshot / Figma / URL
→ Visual Analysis
→ UI Specification
```

当前实现：

```text
Provider abstraction
+ Fake Provider
+ deterministic analyzer
```

缺口：真实 VLM、多源真实 E2E。

结论：PARTIAL。

### 5.6-2 UI Specification → Frontend

**2026-09-12 修复更新(docs/46)**:真实执行闭环已实现并通过 Docker E2E ——
`VisualSpecification → FrontendTaskDraft(+styleTokens 由 5.6-1 token findings 填充)
→ buildFrontendAgentTask → frontend-agent(既有 ProfessionalAgent)→ ToolRuntime →
DockerSandbox → 真实页面模块 → 真实 node build / node --test / render`。
组件复用、缺失组件显式记录、Design Token/Layout/Asset 进入实现;
无写权限时拒绝且磁盘零变更。draft 层未新增任务系统(Task/Delivery 模型未动)。
**结论:PASS**(待新一轮 Global Regression 复核后落定)。

原评估(deviation 描述)保持记录以便审计:

目标要求真实 Frontend Agent 执行。

当前实现停留在：

```text
UI Specification
→ FrontendTaskDraft
```

尚未完成：

```text
FrontendTask
→ Frontend Agent
→ Code Change
→ Build / Run / Render
```

结论：PARTIAL，且当前原阶段标题 `Spec → Frontend Task` 与正式目标存在偏差，应恢复为 `UI Specification → Frontend`。

### 5.6-3 Browser Runtime

**2026-09-12 修复更新(docs/47)**:Network Error 采集补齐并通过真实 Chromium E2E ——
`requestfailed` 真实监听(过滤 `net::ERR_ABORTED` 客户端取消,避免与响应级错误
双重计数)+ `response` 监听采集 HTTP 4xx(`http_4xx`)/5xx(`http_5xx`,含主文档);
三类证据进入既有 `NetworkErrorEntry`(与 console 共用一个 session seq、URL/reason
过脱敏);截图锚点新增 `networkErrorCountSinceLast`。测试:本地 loopback HTTP
fixture(零外网)真实浏览器覆盖「成功不误报 / 4xx / 5xx / requestfailed / 区分 /
脱敏 / 截图关联 / 导航级 404-500」;Timeout/Cancellation 语义未变。
**结论:PASS**(待新一轮 Global Regression 复核后落定)。

原评估(deviation 描述)保持记录以便审计:

基础 Browser Runtime / Playwright / screenshot / console 已完成。

但 `requestfailed` listener 尚未真正挂载，Network error detection 因此不能标记为完整 PASS。

结论：PARTIAL。

### 5.6-4 Visual Evaluation

Reference/Candidate comparison、structural diff、pixel auxiliary diff、score、issue/evidence 基础能力已完成。

结论：PASS。

### 5.6-5 Auto Fix / Re-plan

**2026-09-12 修复更新(docs/48)**:真实 Auto Fix 闭环已实现并通过
Chromium + Docker E2E —— 组合根 `apps/server/src/services/visualFixLoop.ts`
逐轮真实执行:`Visual Issue → Fix Task(buildFixTaskDrafts,提交副本
autoSubmitted=true)→ frontend-agent(ProfessionalAgent)→ ToolRuntime →
DockerSandbox → 真实代码修改 → 独立 build/test(ToolRuntime)→ Browser 重导航
→ Screenshot → 5.6-1 URL 分析(候选 spec)→ evaluateVisuals → RESOLVED /
NEW_ISSUE / REGRESSED`;连续无进展 → STALLED、达 maxRounds → MAX_ROUNDS,
handoff 复用既有 vocabulary(WAITING_APPROVAL + REPLAN)。四场景 E2E 全绿
(resolved / new-issue→resolved / STALLED / regression+max-rounds);成功判定
只来自重新评估,不依赖 Agent 自报。
**结论:PASS**(待新一轮 Global Regression 复核后落定)。

**2026-09-13 修复更新 #2(docs/49)**:重评估输入修正 —— 上一版候选侧由 URL
分析(HTML 结构)生成,未明确证明 Candidate Screenshot 本身进入 5.6-4 评估。
本版改为:`analyzeCandidateScreenshot` 注入点消费**真实截图字节**(base64),
Reference 与 Candidate 双侧真实截图进入冻结的 `evaluateVisuals`;候选侧来源
逐轮记录(`evaluation.candidateSource == browser.assetRef`,`screenshot://`
资产),`referenceSource` 同侧配对可查;三态完全来自该次截图评估;URL/HTML
分析不再替代截图。E2E 同步重写为截图驱动(真实 Chromium → 截图字节解码 →
确定性截图分析替身 → 5.6-1 后处理管线 → 5.6-4 冻结评估),四场景全绿。

原评估(deviation 描述)保持记录以便审计:

当前实现完成：

- issue classification
- fix task draft
- fix loop state
- outcome calculation
- stall/max-round logic
- audit serialization

但 `autoSubmitted=false`，没有真正执行 Frontend Agent 改码，也没有真实 Browser → Screenshot → Re-evaluation 闭环。

结论：PARTIAL。

### 5.6-6 Responsive & UI State Validation

**2026-09-13 修复更新(docs/50)**:真实状态闭环完成 —— 响应式矩阵补齐
desktop/tablet/mobile/custom,媒体块剥离后仅 sub-600px 视口变化(断点域精确性,
desktop/tablet 逐像素一致);十个 UI 状态(loading/empty/error/disabled/hover/
focus/active/expanded/modal + default 基线)全部经真实交互触发并产生真实
Chromium 截图,进入冻结 evaluateVisuals;九态实测像素差异(modal 84.59%、
active 2.86%、hover 2.32%、focus 0.12%…),稳定对照 diffRatio===0;新增状态级
回归探测(detectStateRegressions,仅读冻结像素证据)捕获页面级比较隐形的破坏
样式表;docs/40 §7.3 的 "headless hover 限制" 经真实 E2E 证伪并永久锁定。
shared 契约 / 5.6-4 评估算法 / Browser 7 工具注册表零改动。
**结论:PASS**(待新一轮 Global Regression 复核后落定)。

原评估(deviation 描述)保持记录以便审计:

Responsive viewport matrix 与真实 desktop/mobile screenshot 已完成。

但 UI State 验证目前主要依赖结构化数据/fixture，不能证明真实页面状态都已经验证；hover 也存在 headless limitation。

结论：PARTIAL。

## 4. Architecture Warning

### Warning A — Visual-local risk/approval derivation

5.6-2 / 5.6-5 存在 visual package 内自行派生 `approvalRequired/submissionRisk` 的规则。

如果后续进入真实自动执行，这些规则不得成为第二套 Policy / Approval Engine。

必须改为：

```text
Visual Issue
→ Fix Task
→ Existing platform governance
→ Agent / ToolRuntime
```

Visual 层可以提供建议 metadata，但最终风险与审批由平台治理决定。

### Warning B — Historical docs overstate completion

`docs/36~42` 中部分 PASS 结论来自“基础框架完成”，不是当前完整业务目标完成。

当前以 `docs/17` + 本文件为准。

## 5. Documentation Corrections

必须保持：

- 5.6-2 正式名称 = UI Specification → Frontend
- 5.6-5 必须包含真实 Agent 修复与自动重新评估
- 5.6-6 必须包含真实 UI State Validation
- 5.6-3 必须包含真实 Network Error Detection
- 5.6-1 必须完成 Screenshot / Figma / URL 的实际输入链路

## 6. Current Gate

```text
5.6-0 ✅
5.6-1 ✅(实现完成;外部 live 凭据 e2e BLOCKED BY EXTERNAL CONFIG,未伪装)
5.6-2 ✅(2026-09-12 Repair)
5.6-3 ✅(2026-09-12 Repair)
5.6-4 ✅
5.6-5 ✅(2026-09-12 Repair)
5.6-6 ✅(2026-09-13 修复)

Phase 5.7: READY
```

> **2026-09-13 回归更新(docs/51)**:5.6 → 5.7 Global Regression **PASS** —— 全仓
> 543/543(四门禁 exit 0)、架构/安全/bundle 扫描全干净、数据库 migration/checksum
> 真实执行、零残留容器;零修复通过。**PHASE 5.6: FROZEN;PHASE 5.7: READY**。
> 5.6-1 外部 live E2E(OpenAI / Figma)BLOCKED BY EXTERNAL CONFIG,单独报告。

> **2026-09-13 5.7-1 完成(docs/52)**:Browser Computer Use 适配层落地 ——
> `browser.observe`(DOM 固定脚本 + aria snapshot → 严格 5.7-0 Observation;
> 观察 ref 直接可作动作选择器)+ `browser.action.{navigate,click,type,screenshot}`
> (→ 严格 ActionResult;截图复用 5.6-3 资产管线,base64 不进契约);全部经既有
> ToolRuntime 治理(AgentPermissions.tools 权限门 / ToolCallRecorder 审计 /
> 既有 timeout+cancellation 封套);浏览器上下文零凭据注入;观察内容与
> actionRef.target 经脱敏单源(含密 data:URL 泄漏路径经真实 E2E 锁定)。
> 既有 5.6 Browser Tool 注册表与 Playwright 适配边界零改动。
> browser 33/33、server 51/51、全仓 **557/557**,四门禁 exit 0。

> **2026-09-13 5.7-1 Repair(docs/53)**:观察安全修复(敏感输入结构化隔离)——
> 凭据语义字段(`type=password` / `autocomplete=*password*|one-time-code`)值永不离开
> 页面;无障碍树改受控派生(零表单值);真实 Chromium 安全 E2E 锁定四出口零原文。
> browser 34/34、server 51/51、全仓 **558/558**,四门禁 exit 0。

> **2026-09-13 5.7-2 完成(docs/54)**:External Engineering Systems 统一接入 ——
> `ExternalToolCatalog`(外部系统身份/分类 + 声明式 tool 清单与平台侧 risk;
> `resolvePolicy` 仅认 (serverId,toolName),远程自报元数据零信任;未声明 tool DENY)+
> `ExternalEngineeringConnector`(连接/发现复用 `MCPToolRegistry` 冻结可见性链;
> 映射经 5.5-2 `MCPToolAdapter`/`toUnifiedToolDefinition`,schema 单源,零新传输/
> 零新权限/零直连外部 API)+ `external/outcome.ts`(外部动作统一输出严格 5.7-0
> ActionResult + 不受信 result 数据,结构化脱敏;治理级失败仍走 ToolRuntime 封套)。
> 凭据仅 credentialRef(ref→既有 5.5-4 resolver→连接;secret 零进结果/审计);
> mock 外部工程系统(fake GitHub-like,真实 MCP stdio)+ credentialRef 真实
> Streamable HTTP 注入 E2E;敌意载荷全部以惰性数据通过;未授权 → 零 MCP 请求。
> mcp **232/232**、server 53/53、全仓 **591/591**,四门禁 exit 0。

> **2026-09-13 5.7-3 完成(docs/55)**:统一 Action Policy —— 新包 `@ai-se/action-policy`
> (冻结 LOW/MEDIUM/HIGH 映射表 + 浏览器白名单;`resolve` 统一入口;组合期 `applyActionPolicy`
> 与执行期 `withApprovalGate`;`approvalRequiredFor` 派生)。Browser 工具风险来源改为政策;
> 外部 catalog 仅为输入、政策为最终决策(误声明 LOW → 升 HIGH+审批、零请求拒绝);
> 审批复用既有 WAITING_APPROVAL 链(真实 PG E2E:拒绝 → 零 MCP 请求;批准 → 真实执行)
> 与既有 approval gate / `metadata.approved` 约定;审计复用 ToolCallRecorder +
> ToolResult.audit + 审批事件。action-policy **13**、browser 38、mcp 235、server 57、
> 全仓 **615/615**,四门禁 exit 0。

## 7. Next Development Order

仅补当前缺口，不重做已经通过的基础设施：

1. 5.6-1 真实输入 / VLM（已完成:实现 PASS + 本地真实回路 e2e;外部 live BLOCKED，见 docs/45）
2. 5.6-2 Frontend Agent 实际执行（已完成，见 docs/46）
3. 5.6-3 Network Error Detection（已完成，见 docs/47）
4. 5.6-5 Auto Fix 实际执行闭环（已完成，见 docs/48/49）
5. 5.6-6 真实 UI State Validation（已完成，见 docs/50）
6. Global Regression 5.6 → 5.7（已完成 2026-09-13:PASS，见 docs/51）
7. Phase 5.7-1（已完成 2026-09-13，见 docs/52；安全 Repair 见 docs/53）
8. Phase 5.7-2（已完成 2026-09-13，见 docs/54）
9. Phase 5.7-3（已完成 2026-09-13，见 docs/55）
10. Phase 5.7-4 Evidence & Verification（已完成 2026-09-13，见 docs/56）
11. Phase 5.7-5 Failure Recovery（已完成 2026-09-13，见 docs/57）
12. V1 Final System Acceptance（已完成 2026-09-13：**ACCEPTED**，见 docs/58）

## 8. Source Code Verification Boundary

本基线基于当前 docs、阶段实现报告和回归报告进行 reconciliation。
当前上传资料不包含项目源代码，因此本文件对“实现缺口”可以给出高置信度判断，但不能声称已经对具体源代码逐行审计。若后续提供 source repository，应再次执行 code-level verification。
