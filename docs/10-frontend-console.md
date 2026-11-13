# Frontend Console

> ## 基线状态（2026-10-15 逐条核实）
>
> 本文写于**平台实现之前**（第一版路线图的前端控制台设计），是**实现前设计**，不是 as-built 描述，
> **不构成开工依据**。原文一字未删（保留当初的设计意图），下面是对照现状的核实表：
>
> | 本文条款 | 与当前实现的关系 |
> | --- | --- |
> | 页面清单（Dashboard / Projects / Project Detail / Requirement / **Task Board** / Workflow Run / Agent Run / **Approvals** / Deployments / **Incidents** / Settings） | **8 个存在，3 个从未建**。实际路由 14 条（`apps/web/src/router/index.ts`）。**`Task Board`、`Approvals`、`Incidents` 三个页面不存在**——没有任何路由或视图（Approvals 只作为工作流详情里的一块内嵌区域存在，不是一个独立页面；Incidents 属 Phase 8，未排期）。**本文未列而已建的四页**：`/agents`（Agents）、`/mcp`（MCP Servers）、`/mcp/:serverId`（Server Detail）、`/mcp/:serverId/app`（MCP App） |
> | Phase 1 的 8 个字段（Agent Status / Current Iteration / Tool Calls / Tool Name / Tool Status / Tool Duration / **Test Result** / Final Result） | **7 个有专属呈现，`Test Result` 没有**：它只作为 `TEST_RESULT` 类型的 artifact 标签出现，不是一个独立的展示字段 |
> | 「不展示模型隐藏 Chain-of-Thought。展示 Action、Reason Summary、Tool、Result、Status。」 | **行为上守住了**（前端不渲染任何 reasoning / CoT，后端也没有该字段），**但没有规则或测试把它固定下来**——全仓没有对应的源码扫描或 lint 规则，目前只靠实现者的自觉 |
> | Phase 2 的 7 项（列表 / Detail / 创建 / 取消 / Current Iteration·Retry / Tool Calls / Workflow Events）与「SSE 实时刷新，失败时轮询刷新」 | **全部成立**：SSE 开在 `/stream`，**失败或环境不支持时回落到 2 秒轮询**（`apps/web/src/api/agentRuns.ts`、`stores/agentRuns.ts`） |
> | Phase 3：Requirements 建/列/详、Analyze 启动、Specifications 七类型、Task DAG 只展示不执行 | **全部成立**：七个规格类型（Requirement Analysis / Functional / Technical / Architecture / API / Database / UI）逐一对得上；Task DAG 只渲染节点与依赖边，不触发执行 |
> | Phase 5：Agents 页（Registry / Detail / Capabilities / Tools / Path Permission / 最近 AgentRun 与 Artifact） | **成立**：Path Permission 以「路径 / 模式」（来自 `permissions.pathPrefixes` 与 `readOnly`）呈现 |
> | Phase 5：Workflow Detail 显示 assigned Agent 并可跳到对应 AgentRun | **成立**（跳转走 `/agent-run?run=`） |
> | Phase 5：「**Metrics：展示** Agent、Task、Tool、Test、Review、Repair 的真实成功率；没有数据时显示 Empty State，不伪造数值」 | **数据是真的，位置与空态形态不同**：六项真实成功率都在（`agentRegistryViewModel.ts`），但**没有独立的 Metrics 页面**——它们是 **Agents 页上的卡片**；空态是每张卡片一行「暂无数据」文字，**不是 `EmptyState` 组件**。**「不伪造数值」这条守住了** |
> | Phase 6：Deployments（项目/版本/环境/状态/时间/历史）、Deployment Detail（Workflow / Git Commit / Docker Image / CI / Health Check / 安全日志）、Environment（endpoint + 端口 + Secret Reference）、Rollback（须填原因、显示结果、Production 仍依赖审批） | **全部成立** |
> | 「MCP Console 在 Phase 5.5-5 实现，**属于 Settings 下的管理能力**」 | **位置不成立**：MCP 是**顶层导航分组「运行」下的一等公民**（路由 `/mcp` / `/mcp/:serverId` / `/mcp/:serverId/app`），**不在 Settings 下**——`SettingsView` 里只有模型与凭据配置 |
> | MCP Console 的 7 个用户操作（Register Server / Enable·Disable / Connect·Disconnect / Refresh Tools / 查看 Tool 风险等级 / 查看 Binding / 查看最近连接错误） | **3 个有、4 个没有**。**有**：查看 Tool 风险等级、查看 Binding、查看最近连接错误。**没有**：**注册 Server**（前端 `api/mcp.ts` 连创建端点都没有）、**Server 的启用/停用**（只有 binding 级的启停）、**Connect / Disconnect**、**Refresh Tools**（「刷新」只是重新拉列表，不是让后端重新发现工具） |
> | 「前端只调用 AI-SE API，不直接使用 MCP SDK 或访问 MCP Server。」 | **成立且有测试固定**：`apps/web/src/__tests__/mcpSecurity.test.ts` 逐文件扫描 `.ts` / `.vue`，命中 `@modelcontextprotocol` 导入、MCP 客户端类、浏览器存储用法或 `package.json` 里的 MCP 依赖即失败 |
> | 「MCP Apps 不替换 Vue Console。它是外部 Tool/Resource 在受控 UI 容器中提供的辅助交互能力。」 | **成立**：App 渲染在**只开 `allow-scripts` 的沙箱 iframe** 里（配 `srcdoc`），经 host bridge 通信；同一份安全测试也守这条 |
>
> **结论**：**多数已建能力对得上**——Phase 2 / 3 / 6 与 Agents 页几乎逐条实现，SSE 回落到轮询、DAG 只读、六项真实成功率这几处细节都真做了。需要修正的是三类：① **三个页面从未建**（Task Board / Approvals / Incidents），**四个页面从未在文档里列过**（Agents / MCP 三页）；② **MCP 控制台不在 Settings 下**，而是顶层导航；③ **MCP 的 7 个操作有 4 个没有实现**（注册、启停、连接、重新发现工具）——引用本文讨论"MCP 管理面已完成"之前先看这一条。另有两处口径要留意：**Metrics 没有独立页面**（是 Agents 页的卡片），**空态不是 `EmptyState` 组件**；以及「不展示 Chain-of-Thought」**只靠自觉，没有规则或测试固定**。
> 依据：`AGENTS.md` §9「代码权威于文档；冲突必须报告，禁止默默改任一方来对齐」。

## 页面

Dashboard、Projects、Project Detail、Requirement、Task Board、Workflow Run、Agent Run、Approvals、Deployments、Incidents、Settings。

## Phase 1

重点实现 Coding Agent Run：

- Agent Status
- Current Iteration
- Tool Calls
- Tool Name
- Tool Status
- Tool Duration
- Test Result
- Final Result

不展示模型隐藏 Chain-of-Thought。展示 Action、Reason Summary、Tool、Result、Status。

## Phase 2

Agent Run 控制台升级为：

- Agent Run 列表
- Agent Run Detail
- 创建 Agent Run
- 取消运行中 Agent Run
- Current Iteration / Retry
- Tool Calls
- Workflow Events
- SSE 实时刷新，失败时轮询刷新

仍然不展示模型隐藏 Chain-of-Thought 或私有 reasoning；只展示 Action、Reason Summary、Tool、Result Summary、Status、Error Summary。

## Phase 3+

Task DAG、Specification、Workflow Timeline、Approval、Deployment、Incident。

## Phase 3

- Requirements：创建 Requirement、查看列表和详情。
- Analyze：启动 Planning Agent，并通过 Agent Run 事件查看阶段进度。
- Specifications：展示 Requirement Analysis、Functional、Technical、Architecture、API、Database、UI。
- Task DAG：展示 Task 节点和 dependency 边，不执行 Task。

## Phase 5

- Agents：Registry、Agent Detail、Capabilities、Tools、Path Permission、最近 AgentRun 和 Artifact。
- Workflow Detail：Task 显示 assigned Agent，并可跳转到对应 AgentRun。
- Metrics：展示 Agent、Task、Tool、Test、Review、Repair 的真实成功率；没有数据时显示 Empty State，不伪造数值。

## Phase 6

- Deployments：项目、版本、环境、状态、时间和历史。
- Deployment Detail：Workflow、Git Commit、Docker Image、CI、Health Check 和安全日志。
- Environment：dev/staging/production endpoint、端口配置和 Secret Reference。
- Rollback：明确原因并显示结果；Production 仍依赖 Workflow Approval。


## MCP Console Addendum

MCP Console 在 Phase 5.5-5 实现，属于 Settings 下的管理能力。

### MVP 页面

```text
Settings
  └── MCP Servers
       ├── Server List
       ├── Server Detail
       ├── Connection Status
       ├── Discovered Tools
       └── Project / Agent Bindings
```

### 用户操作

- Register Server
- Enable / Disable
- Connect / Disconnect
- Refresh Tools
- 查看 Tool 风险等级
- 查看 Binding
- 查看最近连接错误

前端只调用 AI-SE API，不直接使用 MCP SDK 或访问 MCP Server。

### MCP Apps

MCP Apps 不替换 Vue Console。它是外部 Tool/Resource 在受控 UI 容器中提供的辅助交互能力。
