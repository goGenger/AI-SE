# Phase 10-A — MCP UI 重构分析（只读）

> 阶段：Phase 10-A（只读分析；**禁止修改任何业务代码 / 业务数据**）
> 依据：`docs/design/*`、`docs/ui-reference/ai-se-home.png`、`docs/60`–`docs/81`、Phase 3-B / 3-C / 4–9 既有实现
> 结论来自当前代码、CSS 与真实运行环境实测；无数据/不确定处标记 `UNKNOWN`。
> 日期：2026-09-15

> ⚠️ **文件编号说明**：任务书要求 `docs/81-phase-10-mcp-analysis.md`，但 **`docs/81` 已被 Phase 9-B 实施记录 `docs/81-phase-9-deployments.md` 占用**。为避免覆盖既有交付物，本次分析写入下一个连续编号 **`docs/82-phase-10-mcp-analysis.md`**（与 Phase 7-A / 8-A 的处理方式一致）。

---

## 1. 页面 / 路由清单

| 路由 | name | 组件 | 行数 |
| --- | --- | --- | --- |
| `/mcp` | `mcp-servers` | `MCPServersView.vue` | **72** |
| `/mcp/:serverId` | `mcp-server-detail` | `MCPServerDetailView.vue` | **355** |
| `/mcp/:serverId/app` | `mcp-app` | `MCPAppView.vue` | **198** |

- 三条路由均**无** `meta` / 守卫 / 权限 / 懒加载（与其余 10 条路由一致）。
- 侧栏菜单 `{ label: "MCP 服务器", to: "/mcp" }`（`AppSidebar.vue:33`）；详情与 app 路由的 active 归属由 Router 驱动（`AppSidebar.vue:40-41` 注释已列明 `/mcp/:serverId` 与 `/mcp/:serverId/app`）。
- **三个页面是三个独立子流程**（非同一组件的不同视图）：列表（注册表）→ 详情（三内嵌 Tab：概览/工具/绑定）→ 沙箱 App 查看器。
- **不存在** `/mcp` 内的列表 active 态：列表项在 `/mcp` 页，详情在另一路由（页面切换即卸载），**当前实现没有任何 active 高亮**（与 Workflows/Projects 的"左列表+右详情"模式不同）→ 10-B **不需要**新增 active 样式（无对应业务状态）。
- 深链接：`/mcp/:serverId`（路径参数，`computed(() => String(route.params.serverId))`）；detail 与 app 页都**没有** `watch(route.params)`（切换 serverId 需重新进入路由）。

## 2. API 清单及调用关系

`api/mcp.ts`（105 行，**10 个导出，全部在用**，无死代码）：

| 函数 | 请求 | 调用方 |
| --- | --- | --- |
| `listMCPServers()` | `GET /api/mcp/servers` | `MCPServersView.onMounted` + 「刷新」按钮 → store `fetchServers` |
| `getMCPServer(serverId)` | `GET /api/mcp/servers/:serverId` | detail `onMounted` → store `fetchServerDetail`（并行三者之一） |
| `listMCPTools(serverId)` | `GET /api/mcp/servers/:serverId/tools` | 同上 |
| `listMCPBindings(serverId)` | `GET /api/mcp/servers/:serverId/bindings` | 同上 / store `fetchBindings` |
| `createMCPBinding(serverId, input)` | `POST /api/mcp/servers/:serverId/bindings` | detail `submitBinding` → store `createBinding` |
| `updateMCPBinding(bindingId, { enabled })` | `PATCH /api/mcp/bindings/:bindingId` | detail `toggleBinding` → store `setBindingEnabled` |
| `deleteMCPBinding(bindingId)` | `DELETE /api/mcp/bindings/:bindingId` | detail `removeBinding`（**有 `window.confirm`**）→ store `deleteBinding` |
| `listMCPApps(serverId, projectId, agentName)` | `GET /api/mcp/servers/:serverId/ui-apps?projectId=&agentName=` | app 页 `loadApps` |
| `getMCPUiResource(serverId, uri, projectId, agentName)` | `GET /api/mcp/servers/:serverId/ui-resource?uri=&projectId=&agentName=` | app 页 `openApp` |
| `runMCPAppAction(input)` | `POST /api/mcp/apps/actions` | app 页 Host Bridge `onAction`（沙箱内动作唯一出口） |

- 错误契约（冻结）：`{success,data}`；`success === false` → `payload.error.message`；网络失败 → `"网络请求失败：无法连接后端服务"`；非 JSON → `"请求失败（HTTP <status>）"`；store 兜底 `"请求失败"`。
- 服务端 `apps/server/src/routes/mcp.ts` 共 11 个端点（GET ×6 / POST ×2 / PATCH ×1 / DELETE ×1 + 1 个聚合 GET），与上表一致；**控制台侧没有任何"注册服务器"端点** ⇒ 服务器由后端/运行时写入注册表，控制台只读。
- **无 SSE / 无 polling**（`api/mcp.ts` 无 `EventSource`；`stores/mcp.ts` 无定时器）⇒ 三条 MCP 页面**都没有实时通道**。

## 3. Store 状态与业务流程

`stores/mcp.ts`（96 行）—— 唯一 store，被三条路由共享：

- **state**：`servers: MCPServerSummary[]`、`selectedServer: MCPServerDetail | null`、`tools: MCPToolSummary[]`、`bindings: MCPBindingSummary[]`、`loading`、`error`
- **actions**：
  - `fetchServers()` —— `loading/error` 包裹，`servers = await listMCPServers()`
  - `fetchServerDetail(serverId)` —— **并行** `Promise.all([getMCPServer, listMCPTools, listMCPBindings])`；失败时**清空** `selectedServer/tools/bindings` 并写 `error`（**详情页 error 分支会同时清空数据**）
  - `fetchBindings(serverId)` —— **不包 `loading`、不写 `error`**（内部刷新用，异常向上抛）
  - `createBinding(serverId, input)` —— 创建 → `await fetchBindings(serverId)` 刷新 → 返回新绑定（异常向上抛，由页面 `formError` 捕获）
  - `setBindingEnabled(bindingId, enabled)` —— PATCH → 有 `selectedServer` 时 `fetchBindings`
  - `deleteBinding(bindingId)` —— DELETE → 有 `selectedServer` 时 `fetchBindings`
- **跨页面共享**：三条 MCP 路由共享同一 store 实例（列表页写入 `servers`，详情页写入 `selectedServer/tools/bindings`）；**不与任何其他业务页共享**；MCP 页面**不使用** `useProjectsStore`（详情页直接调 `listProjects()` API，`.catch(() => [])`）。
- **`loading` 是单标志位**：列表页与详情页共用（列表页 `loading → error → empty → list`；详情页同序）。
- 既有测试 `stores/__tests__/mcp.test.ts`（159 行）：覆盖 `fetchServers` 成功/失败（error 文案）、`fetchServerDetail` 三路并行、失败清空 + `error = "MCP server not found"`。

## 4. Router / 权限分析

- **权限模型：前端无权限守卫**（本项目 13 条路由全部无 `meta`/guard）⇒ "权限"体现在**服务端 + 页面文案**：
  - MCP 工具调用权限 / 策略 / 审批 / 审计**全部在后端 Tool Runtime**（App 沙箱动作也经后端）。
  - 页面文案显式声明边界：「注册表数据由 AI-SE 后端提供。浏览器不会直接连接 MCP 服务器，也不会持有 MCP 凭据。」（列表页）、「仅展示凭据引用。凭据值永远不会到达浏览器。」（详情页）、页面级沙箱说明（app 页）。
- **安全红线（不得被 UI 重构触碰）**：
  1. `MCP_APP_SANDBOX = "allow-scripts"`（**唯一**权限）→ iframe `:sandbox="MCP_APP_SANDBOX"`；
  2. `buildAppDocument()` 把 bootstrap **前置**注入 + 用 `srcdoc`（非 URL）保持不透明源；
  3. Host Bridge 的**来源身份校验** `event.source !== target → 拒绝`；
  4. 入站消息一律经 `MCPAppInboundMessageSchema.safeParse`（未知类型/非法载荷/凭据形状字段直接丢弃）；
  5. 参数体积上限 `MCP_APP_MAX_ARGUMENT_BYTES` → `MCP_APP_ARGUMENTS_TOO_LARGE`；
  6. **严格单工具**：`allowedTools: appMeta.toolName ? [appMeta.toolName] : undefined`（app 只能调用其绑定的那个工具）；
  7. Bridge 自身**不调用工具、不读凭据**，动作一律经 `POST /api/mcp/apps/actions` 交后端治理；
  8. 桥接日志只记录**工具名与拒绝原因码**（`source` / `invalid-message` / `arguments-too-large`），**不含消息内容**。
- 既有测试守护：`__tests__/mcpAppBridge.test.ts`（224 行，锁死上述 1/2/4/5 与"bootstrap 无 fetch/localStorage/sessionStorage/cookie"）、`__tests__/mcpSecurity.test.ts`（98 行，全仓库源码扫描：不引入 `@modelcontextprotocol`/`@ai-se/mcp`、不使用 `MCPClient`/`callTool`/`listTools`/`StreamableHTTP`；且**文件名含 mcp 的生产文件**不得出现 `localStorage|sessionStorage|document.cookie` 或 `access_token|password|api[_-]?key|client[_-]?secret`）。

## 5. 页面结构分析（三页）

### 5.1 `/mcp`（MCPServersView，72 行）

```
section.page（1180px，≤900 → 100%）
├── header.page-header：eyebrow「设置」+ h1「MCP 服务器」+ button.button.subtle「刷新」（:disabled="loading"）
├── p.state.mcp-note（注册表/凭据边界说明）
├── p.state「正在加载 MCP 服务器…」（loading）
├── p.state.error（error）
├── div.empty「暂无已注册的 MCP 服务器。」
└── ul.project-list > li.project-row ×N
    ├── div：RouterLink.project-title → /mcp/:id（server.name）+ p（description ‖ "—"）
    │        + span（transportLabel · toolCount 个工具 · 最近连接 formatMCPTimestamp）
    └── div.row-actions：span.serverStatusClass（status pill，title=serverStatusHint）
                          + span（enabled ? 'status' : 'status mcp-disabled'）
                          + RouterLink.button.subtle「打开」→ /mcp/:id
```

### 5.2 `/mcp/:serverId`（MCPServerDetailView，355 行）

```
section.page
├── header.page-header：eyebrow「MCP 服务器」+ h1 = selectedServer?.name ?? "服务器"
│   + div.row-actions：RouterLink.button.subtle「MCP 应用」→ /mcp/:id/app；RouterLink.button.subtle「返回列表」→ /mcp
├── p.state「正在加载…」（loading）→ p.state.error（error）→ v-else-if="selectedServer"：
│   ├── div.mcp-summary：span.serverStatusClass（状态）+ span.state.mcp-note（状态说明 serverStatusHint）
│   ├── div.tab-bar：button.tab ×3（概览 / 工具（N）/ 绑定（N），`active` 类切换 —— 内嵌 Tab，非路由）
│   ├── Tab「概览」div.panel：h2 连接 + dl.mcp-detail-grid（状态/最近连接/最近错误）
│   │        + h2 元数据 + dl（名称/描述/传输方式/启用状态）
│   │        + h2 传输配置 + dl（stdio → 命令/参数；否则 端点）+ authRef + credentialRef
│   │        + p.state.mcp-note「仅展示凭据引用。凭据值永远不会到达浏览器。」
│   ├── Tab「工具」div.panel：可选提示（status ∈ DEGRADED/DISCONNECTED 时）+ div.empty「尚未发现工具。」
│   │        + ul.compact-list > li：strong(name) + p(description ‖ "—") + span(inputSchemaSummary)
│   │          + div.row-actions：span.riskClass（风险）+ span.status（approvalLabel）+ span（enabled ? 'status' : 'status mcp-disabled'）
│   └── Tab「绑定」div.panel：h2 项目绑定（projectBindings = 无 agentName 的绑定）
│            + div.empty「暂无项目绑定。」/ ul.compact-list（strong=bindingRowLabel，p=projectName ?? projectId，
│              row-actions：enabled pill + button.button.subtle「停用/启用」+ button.button.danger「撤销」）
│            + h2 Agent 绑定（agentBindings = 有 agentName 的绑定）… 同上
│            + form.stacked-form：h2 创建绑定 + 4 个字段（见 §7）+ p.state.error(formError)
│              + button.button.primary「创建绑定 / 创建中…」（:disabled="saving"）
```

### 5.3 `/mcp/:serverId/app`（MCPAppView，198 行）

```
section.page
├── header.page-header：eyebrow「MCP 应用」+ h1「沙箱化 UI 应用」+ RouterLink.button.subtle「返回服务器」→ /mcp/:id
├── p.state.mcp-note（沙箱说明，**含 MCP_APP_SANDBOX 字面值 allow-scripts**）
├── form.stacked-form：label 项目 ID（required, placeholder 项目 UUID）+ label Agent 名称（required, placeholder dev-agent）
│     + button.button.primary「加载应用 / 加载中…」（:disabled="loading"）
├── p.state.error（error）
├── div.panel（v-if apps.length > 0）：h2 可用应用 + ul.compact-list（strong=toolName，p=resourceUri，row-actions：button.button.subtle「打开」）
├── div.empty（v-else-if="!loading && canLoad"）「当前项目 / Agent 下没有可见的 MCP 应用。」
└── div.panel（v-if srcdoc）：h2 应用框架 — {{uri}} + iframe.mcp-app-frame（:sandbox="MCP_APP_SANDBOX" :srcdoc）
      + h3 桥接日志 + ul.compact-list.mcp-app-log（日志行，最多 20 条）
```

## 6. 交互与状态分支

| # | 页面 | 交互 | 行为 |
| --- | --- | --- | --- |
| 1 | `/mcp` | onMounted | `fetchServers()` |
| 2 | `/mcp` | 点击「刷新」 | 再次 `fetchServers()`（`:disabled="loading"`） |
| 3 | `/mcp` | 点击标题/「打开」 | `RouterLink` → `/mcp/:id` |
| 4 | detail | onMounted | `fetchServerDetail(serverId)` → 然后 `listProjects()`（**失败静默为 `[]`**）填 datalist |
| 5 | detail | 切换 Tab | 本地 `activeTab` ref（overview/tools/bindings），**不改变路由、不发请求** |
| 6 | detail | 提交创建绑定 | `saving=true` → 构造 `input`（见 §7）→ `createBinding` → 成功后 **清空 agentName/toolName、保留 projectId**；异常 → `formError` |
| 7 | detail | 点击「停用/启用」 | `busyBindingId=binding.id` → `setBindingEnabled(id, !enabled)` → 成功后 `fetchBindings` 刷新 |
| 8 | detail | 点击「撤销」 | **`window.confirm("确定撤销该绑定吗？撤销后 Agent 调用将立即被拒绝。")`** → 确认后 `deleteBinding` |
| 9 | app | onMounted / onBeforeUnmount | `window.addEventListener("message", onWindowMessage)` / 移除 + `host = null` |
| 10 | app | 提交表单 | `loadApps()`：`canLoad` 不满足 → `error = "需要项目 ID 与 Agent 名称。"`；否则 `listMCPApps` |
| 11 | app | 点击「打开」 | `openApp(link)` → `getMCPUiResource` → 设置 `appHtml`/`appMeta`、`frameKey += 1`、`attachHost()`、记日志 |
| 12 | app | iframe 内 app 发消息 | Host Bridge：来源校验 → schema 校验 → 体积校验 → `runMCPAppAction` → 回投 `host/action-result`；日志最多 20 条（`pushLog` 头插 + `slice(0, 20)`） |

**状态分支清单（三页共 9 处）**：列表 loading / error / empty；详情 loading / error（清空数据）/+ Tab 内 2 处 empty（工具、绑定 ×2 组）；app error / 空应用提示 / 面板 v-if。**无 success 提示、无 toast**。

## 7. 表单约束

| 位置 | 字段 | 约束 / 默认值 |
| --- | --- | --- |
| detail 创建绑定 | 项目 | `<input v-model.trim>` + **`list="mcp-project-options"`（datalist）+ `required`** + placeholder「项目 UUID」（**自由文本 + 建议列表，非 select**） |
| detail 创建绑定 | Agent（可选 — 留空为项目级） | `<input v-model.trim>`，placeholder `dev-agent` |
| detail 创建绑定 | 工具（可选 — 留空为全部工具） | `<input v-model.trim>`，placeholder `echo` |
| detail 创建绑定 | 启用 | `<input type="checkbox" v-model>`（label.checkbox，默认 `true`） |
| detail 创建绑定 | 提交 | `button.button.primary`，`:disabled="saving"`，文案 `创建绑定 / 创建中…` |
| app 加载 | 项目 ID | `<input v-model.trim required>` + placeholder「项目 UUID」 |
| app 加载 | Agent 名称 | `<input v-model.trim required>` + placeholder `dev-agent` |
| app 加载 | 提交 | `canLoad = projectId.trim() !== "" && agentName.trim() !== ""`；`:disabled="loading"` |

- **提交时归一化（冻结）**：`agentName: form.agentName.trim() === "" ? undefined : form.agentName.trim()`、`toolName` 同理（**空串转 `undefined`**，即"项目级/全部工具"语义）。
- **URL 预填（app 页）**：`projectId: String(route.query.projectId ?? "")`、`agentName: String(route.query.agentName ?? "")` —— **app 页支持 `?projectId=&agentName=` 查询参数预填**（既有能力，10-B 必须保留）。
- **两组本地状态（非 store）**：detail 页 `saving` / `formError` / `busyBindingId`；app 页 `loading` / `error` / `log`。
- 详情页表单**不显示 loading 文案**，只有按钮 `disabled`；`formError` 仅出现在创建绑定表单下方（`p.state.error`）。

## 8. MCP App / Tool 流程（安全关键，明确范围）

```
后端注册表/运行时 → GET /api/mcp/servers（列表）
                    GET /servers/:id + /tools + /bindings（详情三路并行）
绑定治理：POST /servers/:id/bindings → PATCH /bindings/:id → DELETE /bindings/:id（撤销前有 window.confirm）
App 流程：GET /servers/:id/ui-apps?projectId&agentName（可见应用）
        → GET /servers/:id/ui-resource?uri&projectId&agentName（HTML 资源，capability-gated）
        → iframe srcdoc + sandbox="allow-scripts"（不透明源）
        → app 内 window.aiseMcpApp.requestToolCall(toolName, args) → postMessage
        → Host Bridge 校验（来源/schema/体积）→ 携带 allowedTools=[绑定工具] → POST /api/mcp/apps/actions
        → 后端 Tool Runtime（权限/策略/审批/审计）→ 回投结果 → app 消费
```

**是否属于本阶段视觉重构范围（明确结论）**：
- **属于视觉层、可改**：三页的页面骨架（PageHeader / Card / SectionHeader / EmptyState / StatusBadge）、原生控件外观（Input / Textarea / Button / 原生 select 若有）、列表与信息块排版、颜色/圆角/间距、`mcp-note` 的**呈现方式**（文字内容一字不改）。
- **不属于视觉层、不得改**：`mcpAppBridge.ts` **整体**（`MCP_APP_SANDBOX`、bootstrap 脚本、`buildAppDocument`、`createMCPAppHost` 的校验顺序与错误码、参数体积上限）、`iframe` 的 `:sandbox` 与 `:srcdoc` 绑定、`allowedTools` 单工具策略、`window.addEventListener("message")` 的接线与 `onBeforeUnmount` 清理、`runMCPAppAction` 的入参构造、日志只记工具名/拒绝码的约定、`serverStatusClass`/`riskClass` 的**返回值语义**（若保留）。
- **UNKNOWN**：iframe 的 `title="MCP 应用"`、`min-height: 420px` 等是否属"视觉"可调 —— 建议 10-B **原样保留**（无明确收益）。

## 9. Legacy CSS 风险

### 9.1 三页使用的 legacy 类（含共享范围）

| 类 | 关键值（实测/源码） | 现在谁在用 |
| --- | --- | --- |
| `page` / `page-header` / `eyebrow` | 1180px；≤900 → 100% + `flex-direction: column` | **仅这 3 页**（其余 8 页已迁移） |
| `panel` | 白底 + `1px #dde5ee` + radius 8 + padding 20 | 3 页 |
| `empty` | 白底 + `1px #dde5ee` + radius 8 + `padding:28px` + `color:#65758a` + 居中 | 3 页 |
| `state` / `state.error` | `margin:12px 0` / `color:#b3261e` | 3 页 |
| `button` / `.primary` / `.subtle` / `.danger` | base：`1px #ccd6e0`、radius 8、min-height 38、padding 8/14；**`.primary` 旧蓝 `#1d6fd3`**；`.subtle` `#edf3f8`；`.danger` 浅红 | 3 页 |
| `project-list` / `project-row` / `project-title` / `row-actions` | `grid gap 12 / list-style:none`；白卡；标题 18px/700 `#162331`；row-actions flex gap 10（**≤900 变 column**） | **仅 `/mcp` 列表页**（ProjectsView 已在 5-B 脱离，其 `project-row-*` 为新类） |
| `compact-list` / `compact-list li` | `grid gap 12 / none`；li = `flex; space-between; align-items:center` | detail + app（**无 ≤900 规则**） |
| `stacked-form` / `label.checkbox` | `grid gap 12`；checkbox 行 `flex gap 8` + `input{width:auto}` | detail + app（**注意：无 `.form-panel` 包裹 ⇒ 输入控件完全没有外观样式**，见 §9.3） |
| `tab-bar` / `tab` / `tab.active` | flex wrap gap 8 + `margin:16px 0 12px`；tab：透明底、`1px transparent`、radius 8、`#31465c`、600、padding 6/12、**font-size 16px（UA）**；active：底 `#eef4ff` + 边框 `#b8c8d8` | detail |
| `mcp-note` | `color:#5b6b7c` | 3 页（共 5 处） |
| `mcp-summary` | flex wrap gap 10 baseline | detail |
| `mcp-detail-grid` | `repeat(auto-fit, minmax(220px,1fr))` gap 12；dt 12px 大写 `#5b6b7c`；dd `margin:2px 0 0` | detail（3 处） |
| `mcp-status-*`（7 个） | connected `#e8f6ef/#16633d`；registered/connecting `#eef4ff/#31465c`；reconnecting `#eef4ff/#2b4c8c`；degraded `#fff8e6/#8a6116`；disconnected/revoked/disabled `#f2f4f7/#52525b` | 3 页（**由 `serverStatusClass()` 拼字符串**） |
| `mcp-risk-*`（4 个） | low 绿 / medium 蓝 / high 琥珀 / critical 红（`#fff5f5`+`#b3261e`） | detail（**由 `riskClass()` 拼字符串**） |
| `status` | **恒绿胶囊**（`#e8f6ef/#16633d`，radius 999，padding 4/10） | 3 页（计数/审批/启用态都用它） |
| `mcp-app-frame` | 白底 + `1px #b8c8d8` + radius 8 + `min-height:420px` + `width:100%` | app |
| `mcp-app-log` | 等宽字体 12px | app |

### 9.2 级联与陷阱

1. **全局未分层 `a { color:#1d4f91 }`**：MCP 三页的 RouterLink 共 5 处（`打开`、`MCP 应用`、`返回列表`、`返回服务器`、列表标题）——当前**列表标题**会被改写为旧链接蓝（`.project-title` 有 `color:#162331` 类规则，优先级高于 `a` ⇒ 实际不生效，**实测为 #162331**）；`.button.subtle` 链接也不生效（类规则胜出，实测 `#1e2b38`）。⇒ 10-B 后 RouterLink 需按 5 页先例做 scoped 链接色。
2. **未分层 `button,input,select,textarea { font: inherit }`**：MCP 页控件**没有任何类规则兜底**（无 `.form-panel`）⇒ 实测 detail/app 的输入框为 **UA 外观**（height 24px、border `rgb(118,118,118)`、radius 0、font 16px）。
3. **`!important`：全项目仅 1 处**（`.checkbox-row`，Workflows 专用）⇒ **MCP 三页不受任何 `!important` 影响**。
4. **复合选择器陷阱**：`.compact-list li`、`.mcp-detail-grid dt/dd`、`.project-title`、`.tab.active`、`.stacked-form label.checkbox input` 均为"结构型"选择器 ⇒ 新 markup 一旦复用这些类名/结构，legacy 规则会**继续生效并压过工具类**。**结论：新 markup 不复用任何 legacy 类名**。
5. **`serverStatusClass()` / `riskClass()` 的字符串契约**：现有测试 `mcpViewModel.test.ts` **断言** `serverStatusClass(status) === "status mcp-status-<lowercase>"` ⇒ 只要模板继续调用它们，legacy 类就会出现（无法达成"legacy 命中 0"）。
6. 值域偏差（迁移必然产生视觉变化）：panel 边框 `#dde5ee` vs `--border #e8eaf0`、圆角 8 vs 12；`empty`/`mcp-note`/`mcp-detail-grid dt` 文字色 `#65758a`/`#5b6b7c` vs `--muted-foreground #6b7280`；`.button.primary` 旧蓝 vs `--primary`；h1 32px/700 vs 24px/600；`status` 恒绿 vs 语义 tone。

## 10. 现有组件复用映射（能否覆盖）

| 需要 | 现有组件 | 结论 |
| --- | --- | --- |
| 三页页头（含 1~2 个操作） | ✅ `PageHeader`（`#actions` slot） | 够用（刷新/返回/打开等用 slot） |
| 面板 / 信息块 | ✅ `Card` + `SectionHeader` | 够用（detail 概览的「连接/元数据/传输配置」三组信息可用 3 个 Card 或 1 Card + 3 个 SectionHeader） |
| 状态/风险/审批/启用 展示 | ⚠️ `StatusBadge` 存在，**缺 `MCPServerStatus` / `MCPToolRisk` / 审批 / 启用的 tone 映射** | **需新增纯函数**（见 §15 建议） |
| 列表项（服务器、工具、绑定、应用） | ✅ 原生 `<button>` / `<li>` + Tailwind（6-B/7-B/8-B/9-B 已验证模式） | 够用 |
| 表单控件 | ✅ `Input` / `Textarea` / `Label` / `Button` | 够用（**当前 MCP 表单是 UA 外观，迁移会显著改善**） |
| datalist 建议列表 | ⚠️ 无组件；**原生 `<input list>` + `<datalist>` 保留** | 保留原生（不得改成 Select —— 会改变输入语义） |
| 内嵌 Tab（概览/工具/绑定） | ⚠️ 无 Tabs 组件；任务书禁止新增 | 用现有 `Button`/原生 `<button>` + Tailwind 复现（激活态改 Primary）；**不得引入路由化或新组件** |
| 空态 | ✅ `EmptyState`（三页共 5 处空态） | 够用 |
| error 行 | ✅ Tailwind `text-danger`（3 页 5 处） | 够用（首次上色，同 7-B/8-B/9-B 先例） |
| iframe 沙箱容器 | ⚠️ 无组件；**保留原生 `<iframe>` + scoped 样式** | 保留（安全属性不可动） |
| Dialog / Toast / Skeleton / Table / Search / Filter / Pagination / Drawer | ❌ 均无 | **本阶段不需要，且禁止新增**（撤销走 `window.confirm`，无 success 提示，无搜索/筛选） |

**结论：不需要新增任何组件**；唯一需要新增代码的是（待授权的）tone 纯函数与页面内 scoped 样式。

## 11. 响应式分析

| 断点 | legacy 行为 | 影响的 MCP 页面 |
| --- | --- | --- |
| `max-width: 900px` | `.page { max-width: 100% }`；`.page-header / .project-row / .row-actions` → `flex-direction: column; grid-template-columns: 1fr; align-items: stretch` | `/mcp`（页头+行+操作区堆叠）、detail/app（页头与 `row-actions` 堆叠） |
| 无断点 | `mcp-detail-grid` = `repeat(auto-fit, minmax(220px,1fr))`（自适应列数）；`mcp-summary`/`tab-bar` flex-wrap；`compact-list` 无响应式规则（窄屏不堆叠）；`mcp-app-frame` `width:100%` + `min-height:420px` | detail / app |

**实测**：`/mcp` @1440/@1280 → `max-width: 1180px` + 页头 `row`；**@900 / @899 → `max-width: 100%` + 页头 `column`**；四档 `overflowX = 0`。（detail/app 页的 `row-actions` 与 `mcp-detail-grid` 需在 10-B 后用浏览器复核，或由 SSR 断言类名。）

## 12. 测试现状与缺口

| 文件 | 行数 | 覆盖 | 缺口 |
| --- | --- | --- | --- |
| `__tests__/mcpViewModel.test.ts` | 74 | 7 状态文案、**`serverStatusClass` 字符串契约**、hint 文案、transport、risk/approval/binding/enabled 标签、时间格式化 | 无 tone 映射（尚不存在） |
| `__tests__/mcpAppBridge.test.ts` | 224 | 沙箱权限唯一性、bootstrap 前置、无 fetch/存储、schema 拒绝、体积上限、来源校验等 | —— |
| `__tests__/mcpSecurity.test.ts` | 98 | 源码级：无 MCP SDK/客户端/协议操作；mcp 命名生产文件无存储调用与凭据字面量 | —— |
| `stores/__tests__/mcp.test.ts` | 159 | `fetchServers`、`fetchServerDetail`（成功/失败清空） | 绑定 CRUD（create/toggle/delete）**未覆盖** |
| 三页视图 | **无** | —— | 页面契约测试**完全缺失**（7-A/8-A/9-A 同类缺口） |

## 13. 浏览器验证结果（只读）

环境：:5173（当前源码构建产物）、真实后端 :3000、**注册表无数据**；应用加载前注入 console hook。

| 页面 | 实测 |
| --- | --- |
| `/mcp` | h1 **32px/700**「MCP 服务器」+ eyebrow「设置」；「刷新」`.button.subtle`（h 40、底 `#edf3f8`、未禁用）；`mcp-note` 16px `#5b6b7c`；**空态**「暂无已注册的 MCP 服务器。」（padding 28 / 文字 `#65758a` / 边框 `#dde5ee`）；`.project-row` **0 条**；API `GET /api/mcp/servers` → `[]`；console 干净 |
| `/mcp/<不存在 uuid>` | h1 回退「**服务器**」；页头两个 RouterLink（`MCP 应用` → `/mcp/<id>/app`、`返回列表` → `/mcp`，实测色 `#1e2b38`）；错误行「**MCP server not found**」（`#b3261e`）；**面板 0 / Tab 0**（`v-else-if="selectedServer"` 未满足）；API 三路并行（server/tools/bindings）；console 干净 |
| `/mcp/<id>/app` | h1「沙箱化 UI 应用」+ eyebrow「MCP 应用」；「返回服务器」链接；`mcp-note` 实测渲染出 **`allow-scripts`** 字面值；表单 label「项目 ID」「Agent 名称」，**两个 input 均 `required` 且为 UA 外观**（h 24 / fs 16 / 边框 `rgb(118,118,118)` / 圆角 0）；「加载应用」按钮旧蓝 `#1d6fd3` h 40；**只读提交**（GET `/ui-apps`）→ 后端返回 `Query is invalid` 显示于错误行 + 空态「当前项目 / Agent 下没有可见的 MCP 应用。」；console 干净 |
| 响应式 | 见 §11（@900/@899 页头转列、页面宽度放开、无横向溢出） |

> **验证限制**：注册表为空（`GET /api/mcp/servers` = `[]`）⇒ **列表项 / 详情三 Tab / 工具 / 绑定 / 绑定 CRUD / 可用应用 / iframe 沙箱 / 桥接日志** 在浏览器中**无真实样本**，未创建任何测试数据。这些路径只能靠 **SSR 页面契约测试**覆盖；沙箱与桥接的安全不变量已由 `mcpAppBridge.test.ts` + `mcpSecurity.test.ts` 守护。

## 14. 业务冻结清单（Phase 10-B）

- **API**：`api/mcp.ts` 10 个导出、endpoint / 查询参数 / 方法、错误契约 4 条 + store 兜底「请求失败」、后端原文透传（`MCP server not found`、`Query is invalid`）
- **Store**：`stores/mcp.ts` 全文（`fetchServers` / `fetchServerDetail` 三路并行 + 失败清空 / `fetchBindings` **不包 loading 不写 error** / `createBinding`→refresh / `setBindingEnabled` / `deleteBinding`）；共享实例跨三页
- **Router**：3 条路由、`/mcp/:serverId` 与 `/mcp/:serverId/app` 深链接、`?projectId=&agentName=` 查询预填（app 页）
- **安全红线**：§4 的 8 条（sandbox=allow-scripts、srcdoc+bootstrap 前置、来源校验、严格 schema、体积上限、allowedTools 单工具、不直连/不持凭据、日志不含消息内容）+ `mcpSecurity` 扫描约束
- **凭据展示语义**：仅展示 `authRef` / `credentialRef` 引用；三处说明文案逐字保留
- **交互**：12 项（§6），含 Tab 本地切换、`window.confirm` 撤销、`busyBindingId` 行级禁用、`saving`/`formError` 本地状态、表单成功后清空 agent/tool 但保留 projectId、`loadApps` 的 `canLoad` 守卫与错误文案、`openApp` 的 `frameKey` 递增与 `attachHost`、消息监听注册/清理、日志 `slice(0,20)`
- **表单约束**：§7 全部（含 datalist + required、trim→undefined、checkbox 默认 true、两个 required 的 app 表单）
- **ViewModel 输出**：`serverStatusLabel` / `serverStatusHint` / `transportLabel` / `riskLabel` / `approvalLabel` / `bindingScopeLabel` / `bindingTargetLabel` / `enabledLabel` / `formatMCPTimestamp` 逐字保留；**`serverStatusClass` / `riskClass` 的返回值语义**按 §15 决策处理
- **状态分支**：三页 9 处 loading/error/empty 的顺序与条件（详情 error 时**数据被清空**、app 页空态依赖 `canLoad`）
- **文案**：全部业务文案逐字保留（含 7 条状态文案与 7 条状态说明、风险/审批/启用/绑定标签、三处凭据说明、错误文案）
- **禁止新增**：Search / Filter / Dialog / Toast / Skeleton / Tabs 组件 / SSE / polling / 新路由 / 新依赖

## 15. Phase 10-B 建议修改范围

**建议允许**：
1. `apps/web/src/views/MCPServersView.vue`、`MCPServerDetailView.vue`、`MCPAppView.vue`（**仅 template + 页面 scoped 样式**；`<script setup>` 逐行不动，除新增组件/tone 导入）
2. `apps/web/src/viewmodels/mcpViewModel.ts` —— **仅新增**纯展示映射：`serverStatusTone(status)`、`riskTone(risk)`、`approvalTone(requiresApproval)`、`enabledTone(enabled)`（**保留** `serverStatusClass` / `riskClass` 导出与语义，供既有测试与兼容使用；模板不再调用它们）
3. 对应测试：新增 `__tests__/mcpServersView.test.ts`（列表）、`__tests__/mcpServerDetailView.test.ts`（详情）、`__tests__/mcpAppView.test.ts`（app），并在 `mcpViewModel.test.ts` 追加 tone 断言（**不删除**既有 `serverStatusClass` 断言）

**建议明确禁止**：修改 `mcpAppBridge.ts`、`api/mcp.ts`、`stores/mcp.ts`、`router/index.ts`、`styles.css`、`package.json`；替换 `window.confirm`；把 datalist 改成 select；引入 Tabs/Dialog/Toast；修改 iframe 的 `sandbox`/`srcdoc`；改动 `allowedTools` 逻辑；让桥接日志记录消息内容。

**tone 建议映射**（待授权）：
- `serverStatusTone`：CONNECTED → `success`；REGISTERED / CONNECTING → `pending`；RECONNECTING → `running`；DEGRADED → `warning`；DISCONNECTED / REVOKED → `neutral`
- `riskTone`：LOW → `success`；MEDIUM → `running`；HIGH → `warning`；CRITICAL → `error`
- `approvalTone`：需要审批 → `warning`；无需审批 → `neutral`
- `enabledTone`：已启用 → `success`；已禁用 → `neutral`

## 16. 风险与已知验证限制

| # | 风险 | 影响 | 应对 |
| --- | --- | --- | --- |
| R1 | **MCP 注册表无真实数据**（0 服务器）⇒ 详情/工具/绑定/应用/沙箱/日志无法端到端验证 | 高（覆盖盲区） | SSR 页面契约测试全覆盖；沙箱不变量已由既有测试守护；如需真实验证须单独授权注册测试服务器 |
| R2 | **`serverStatusClass`/`riskClass` 的测试契约与"legacy 命中 0"目标冲突** | 中（流程冲突） | §15 建议：保留函数 + 模板停用 + 新增 tone 函数（需授权） |
| R3 | **误触安全红线**（sandbox/allowedTools/来源校验） | **极高** | 10-B 明令不改 `mcpAppBridge.ts` 与 iframe 绑定；改动后必须复跑 `mcpAppBridge.test.ts` + `mcpSecurity.test.ts` |
| R4 | `mcpSecurity` 扫描：三页文件名含 `mcp` ⇒ 新源码不得出现 `localStorage/sessionStorage/document.cookie/access_token/password/api_key/client_secret` | 中 | 新文案/注释避免这些字面量（既有文案已安全） |
| R5 | 误把 datalist 改成 select、或"优化"为搜索框 | 中 | 明确冻结 §7；禁止新增 Search/Filter |
| R6 | 误删 `window.confirm` 或替换为 Dialog | 中 | 冻结 §6-8；禁止新增 Dialog |
| R7 | Tab 迁移后 Tab 语义丢失（改路由/改请求） | 中 | 保持本地 `activeTab` ref + 三块面板条件渲染，断言三类面板标题 |
| R8 | 全局 `a{color}` / `font:inherit` 级联 | 低 | scoped 处理（5 页先例）+ Input/Button 组件自带兜底 |
| R9 | 900px 边界语义（legacy `max-width:900` 含边界折叠） | 低 | 沿用既有「≥900」约定并记录 |
| R10 | 详情页 error 时清空数据的行为被"顺手"改成保留旧数据 | 低 | 冻结（第 3 节 store 语义） |

## 17. 结论

**PASS**

判定依据：① 三页、10 个 API、1 个 store、3 条路由、10 个 ViewModel 导出、12 项交互、8 条安全红线、9 处状态分支、全部表单约束与文案已完成清点；② legacy CSS（23 类 + `!important` 结论 + 复合陷阱）与响应式行为已实测记录；③ 组件复用可行性确认（**无需新增组件**，仅需 tone 纯函数 + scoped 样式）；④ 测试现状与缺口明确（视图层零覆盖）；⑤ 浏览器实测完成（列表空态 / 详情 404 错误 / app 表单与只读提交 / 响应式 / console 干净），并明确记录"**注册表无数据**"导致的验证限制；⑥ 已明确区分视觉层与安全/架构层（§8），并列出 10-B 建议范围。

---

**Code changed: NONE**
**API changed: NONE**
**Store changed: NONE**
**Router changed: NONE**
**CSS changed: NONE**
**Dependencies changed: NONE**
**Business data changed: NONE**（未注册/修改任何 MCP 服务器、工具、绑定）

（本阶段只新增本文档 `docs/82-phase-10-mcp-analysis.md`；`docs/81-phase-9-deployments.md` 等既有文档与全部源码、配置未改动。）

按阶段纪律**在此停止**，不进入 Phase 10-B。
