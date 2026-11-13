# Phase 5.7 Implementation Plan — Agent Computer Use & External Engineering Tools

> Sequencing note: 5.7-0 Computer Use Contract 已有实现，但 Phase 5.7 后续行为开发仍以 Phase 5.6 完整完成 + Global Regression PASS 为前置条件。

> 每次只执行一个 Sub-phase；完成后必须停止。

## Goal

让 Agent 在受控环境中完成真实工程系统操作。

## 5.7-0 Computer Use Contract

统一：

```text
Action
Observation
Screenshot
Result
Evidence
```

Action：

```text
click
type
select
scroll
navigate
keypress
wait
screenshot
```

必须支持 timeout/cancellation。

## 5.7-1 Browser Computer Use

Browser Agent 能够：

- 打开 URL
- 定位元素
- 点击
- 输入
- 选择
- 滚动
- 截图
- 获取 DOM/Accessibility 信息
- 验证结果

所有能力进入 Tool Runtime。

> **2026-09-13 完成状态(docs/52)**:已实现——打开 URL(`browser.action.navigate`)、
> 定位/点击/输入(`browser.observe` 的 ref 可直接作选择器;
> `browser.action.click` / `browser.action.type`)、截图
> (`browser.action.screenshot`,复用 5.6-3 资产管线)、DOM/Accessibility 信息
> (`browser.observe` → 严格 5.7-0 Observation)、验证结果(action 后置观察 +
> ActionResult)。全部经既有 ToolRuntime 治理(权限/审计/超时/取消)。
> **选择(select)/滚动(scroll)** 未含于 5.7-1 任务书验收清单,本阶段未实现
> (最小面原则,避免越域);如需可并入后续小版本。
> browser 33/33、server 51/51、全仓 557/557,四门禁 exit 0。
>
> **2026-09-13 Repair 状态(docs/53,5.7-1 → PASS)**:敏感输入隔离修复完成 ——
> 凭据语义字段(`type=password` / `autocomplete=*password*|one-time-code`)的值
> 结构性屏蔽(永不离开页面;`[value hidden: …; hasValue: …]` 语义标记);无障碍树
> 改为受控派生(结构只读,零表单值,不再消费会明文渲染值的 `page.ariaSnapshot()`);
> 普通 input 值照常可观察;真实 Chromium 安全 E2E 锁定 Observation / ToolResult /
> audit / a11y 树零原文。browser 34/34、server 51/51、全仓 558/558,四门禁 exit 0。
> 已知边界:无凭据信号的任意字符串按普通内容观察(可观察性与不可知秘密的固有边界,
> 见 docs/53 §9)。

## 5.7-2 External Engineering Systems

优先通过 MCP 接入外部系统：

```text
GitHub
Issue / Project
Documentation
Design Collaboration
CI/CD
```

Browser 作为 MCP 不适合或没有结构化 API 时的补充。

> **2026-09-13 完成状态(docs/54)**:已实现 —— `ExternalToolCatalog`
> (`packages/mcp/src/external/catalog.ts`:外部系统身份/分类 + 声明式 tool 清单与
> 平台侧 risk/审批元数据;`resolvePolicy(serverId, toolName)` 单源出策略,远程自报
> 元数据零信任;未声明 tool 一律 DENY)+ `ExternalEngineeringConnector`
> (`external/connector.ts`:连接/发现复用 `MCPToolRegistry` 冻结可见性链;映射复用
> 5.5-2 `MCPToolAdapter`/`toUnifiedToolDefinition`,schema 单源;含 call-time
> 可见性复检与审批门)+ `external/outcome.ts`(外部动作统一输出:严格 5.7-0
> ActionResult + 不受信 result 数据,结构化脱敏;治理级失败<cancel/timeout/权限/审批>
> 仍走 ToolRuntime 封套)。凭据仅 credentialRef 形态(ref→既有 resolver→连接);
> mock 外部工程系统(fake GitHub-like,真实 MCP stdio)+ credentialRef 真实
> Streamable HTTP 注入 E2E;敌意载荷(prompt injection / fake system message /
> malicious markdown / links / fake tool result)以惰性数据通过。
> **GitHub / CI-CD 生产集成未实现**——本阶段只建立统一接入能力(fake/echo harness,
> 任务书边界)。mcp 232/232、server 53/53、全仓 591/591,四门禁 exit 0。

## 5.7-3 Action Policy

风险：

```text
read/search/list → LOW
create/update → MEDIUM
write/push/merge → HIGH
deploy/destructive/production → CRITICAL
```

高风险必须 Approval。

> **2026-09-13 完成状态(docs/55)**:已实现 —— 新包 `@ai-se/action-policy`:
> 冻结风险映射表(read/search/list → LOW;create/update/click/type → MEDIUM;
> publish/commit/push/merge/delete/deploy/deployment/release/rollback/write → HIGH;
> 词表 LOW/MEDIUM/HIGH,CRITICAL 保留为可声明级别按 ≥HIGH 处理)+ 浏览器动作白名单
> (observe/navigate/screenshot LOW;click/type MEDIUM)+ `resolveBrowser`/`resolveExternal`/
> `resolve`/`approvalRequiredFor`。**风险非自报**:浏览器 metadata 无声明通道;外部 catalog
> 声明仅作输入,verb floor 只升不降;未声明/未知 → DENY;工具参数不能携带 risk(严格 schema)。
> **Approval 复用**:派生 approvalRequired → 既有 workflow-engine WAITING_APPROVAL 链;
> 动作级复用既有 approval gate + `metadata.approved` 约定;未批准 → 零外部请求。
> **Audit 复用**:ToolCallRecorder + ToolResult.audit(policy risk)+ 审批事件,零第二套。
> 接线:Browser 工具风险来源改为政策;mcp connector 的 policyProvider/decisions 全经政策
> (catalog 保持输入角色,职责未扩张)。全仓 615/615,四门禁 exit 0。

## 5.7-4 Evidence

关键操作记录：

```text
action
target
before
after
result
screenshot
externalId
toolCallId
```

Evidence 必须可关联到 Task/AgentRun/WorkflowRun。

> **2026-09-13 完成(docs/56)**:EvidenceRecord 契约(`@ai-se/shared` 追加块:actionRef /
> Observation / ActionResult 全部复用 5.7-0,`screenshotRef` 锁 `screenshot://` 前缀,
> id/timestamp 归持久化)+ migration 009 `evidence_records` + `@ai-se/evidence`
> before→action→after→screenshot 捕获链 + 冻结 VERIFIED/FAILED 验证(不新建评分)+
> 最小只读 API(list/detail;跨项目 403)。Browser 与 External 同一模型,失败事实保留。

## 5.7-5 Failure Recovery

分类：

```text
ELEMENT_NOT_FOUND
PAGE_CHANGED
AUTH_EXPIRED
NETWORK_ERROR
TIMEOUT
ACTION_REJECTED
REMOTE_ERROR
```

根据错误进入：

```text
retry
re-observe
re-plan
approval
failure
```

> **2026-09-13 完成(docs/57)**:统一失败恢复落地 —— 冻结分类词表以任务书 / docs/17 §5.7-5 为准
> (ELEMENT_MISSING / LOGIN_EXPIRED / NETWORK_FAILED / UI_CHANGED / TIMEOUT / CANCELLED + UNKNOWN 兜底,
> 本文件早期列表为规划稿)。`@ai-se/failure-recovery`(分类器 + 冻结路由表 + re-observe 进度)+
> workflow-engine 可选 `failureRouter` 钩子:RETRY/REPLAN 复用既有链,HUMAN 复用既有 approval 实体 +
> WAITING_APPROVAL,每轮重试重新经 ToolRuntime/Action Policy/审批门/审计,每轮 5.7-4 证据保留。

## Acceptance

必须真实完成至少一个外部工程闭环：

```text
Agent
→ Browser/MCP
→ External System
→ Action
→ Evidence
→ Verification
```

且失败时不绕过 Tool Runtime。
