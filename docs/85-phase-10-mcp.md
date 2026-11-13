# Phase 10-B — MCP UI 视觉重构（实施记录）

> 阶段：Phase 10-B（基于 `docs/82-phase-10-mcp-analysis.md` 的实施）
> 依据：`docs/design/*`（含本阶段期间新增的 `docs/design/07-page-layout-patterns.md`：**MCP → Tool Federation Workspace**）、`docs/ui-reference/ai-se-home.png`、`docs/82`
> 结论：**PASS**
> 日期：2026-09-15

---

## 1. 修改文件

| 文件 | 变化 |
| --- | --- |
| `apps/web/src/views/MCPServersView.vue` | 72 → **154 行**（`/mcp` 列表：PageHeader + 说明条 + 服务器卡片列表） |
| `apps/web/src/views/MCPServerDetailView.vue` | 355 → **505 行**（`/mcp/:serverId`：状态摘要 + 三 Tab + 概览三卡 + 工具/绑定 + 创建绑定表单） |
| `apps/web/src/views/MCPAppView.vue` | 198 → **330 行**（`/mcp/:serverId/app`：沙箱说明 + 加载表单 + 可用应用 + 应用框架/桥接日志） |
| `apps/web/src/viewmodels/mcpViewModel.ts` | 80 → **138 行**：**仅新增** `serverStatusTone` / `riskTone` / `approvalTone` / `enabledTone`（+ 4 个 tone 类型）；既有 10 个导出（含 `serverStatusClass` / `riskClass`）**逐字未改** |
| `apps/web/src/__tests__/mcpServersView.test.ts` | 新增（10 例） |
| `apps/web/src/__tests__/mcpServerDetailView.test.ts` | 新增（9 例） |
| `apps/web/src/__tests__/mcpAppView.test.ts` | 新增（5 例） |
| `apps/web/src/__tests__/mcpViewModel.test.ts` | 74 → **103 行**（+2 例 tone 断言，**保留**既有 `serverStatusClass` / `riskClass` 断言） |
| `docs/85-phase-10-mcp.md` | 本文档 |

**未修改**：`viewmodels/mcpAppBridge.ts`（沙箱与 Host Bridge 全文）、`api/mcp.ts`（10 个导出）、`stores/mcp.ts`、`router/index.ts`、`styles.css`（960 行，mtime 11:41 未变）、`components/**`、Sidebar / Header / 其他页面、`package.json`、Design Token、任何 MCP 注册表数据。

## 2. 布局变化（三页）

| 页面 | Phase 10-A（改造前） | Phase 10-B（现在） |
| --- | --- | --- |
| `/mcp` | `section.page`（1180）+ `page-header` + `p.state.mcp-note` + `ul.project-list > li.project-row`（左信息 / 右操作两栏硬排） | `PageHeader`（设置 / MCP 服务器 / **刷新** Button secondary）+ **说明条**（`--muted` 圆角条）+ **服务器卡片列表**（name 16px/600 Primary 链接 → 描述 → 传输·工具数·最近连接；右侧 StatusBadge ×2 + 「打开」） |
| `/mcp/:serverId` | `page-header` + `mcp-summary` + `tab-bar`（三个扁平 tab）+ 单个 `div.panel` 内 h2 段落堆叠 + `compact-list` | `PageHeader`（名称回退「服务器」+ MCP 应用 / 返回列表）+ **状态摘要 Card** + **分段式 Tab**（激活态 Primary）+ **三个独立 Card**（连接 / 元数据 / 传输配置，`dl` 三列）→ 工具 / 绑定面板 → **创建绑定表单 Card** |
| `/mcp/:serverId/app` | `page-header` + `mcp-note` + `stacked-form`（UA 外观输入框）+ `panel/compact-list` + `iframe.mcp-app-frame` + 日志 | `PageHeader`（MCP 应用 / 沙箱化 UI 应用 / 返回服务器）+ **沙箱说明条**（盾牌图标 + `--muted`）+ **加载表单 Card** → **可用应用 Card** → **应用框架 Card**（iframe `min-height 420px` + 桥接日志等宽小字） |

页面宽度：三页均保持 legacy `.page` 的 **1180px** 上限（`max-w-[1180px]`）。

## 3. 视觉变化

- **与 Dashboard / 已迁移 8 页统一**：`PageHeader`（24px/600 标题、12px eyebrow）、`Card`（白底 + `--border` + 12px 圆角 + 20px 内距 + 无阴影）、`SectionHeader`（16px/600）、区块间距 `--section-gap` 24px、栅格 gap 12/16px。
- **语义色落地**（首次）：状态 → `StatusBadge` tone：CONNECTED `success` ｜ REGISTERED/CONNECTING `pending` ｜ RECONNECTING `running` ｜ DEGRADED `warning` ｜ DISCONNECTED/REVOKED `neutral`；风险 LOW `success` / MEDIUM `running` / HIGH `warning` / CRITICAL `error`；审批需要 `warning` / 不需要 `neutral`；启用 `success` / 禁用 `neutral`。原先的「`.status` 恒绿胶囊」被语义 tone 取代（**有意视觉变化**，10-A §9.6 已预告）。
- **控件外观**：输入框由 UA 默认（24px 高 / 16px 字 / `rgb(118,118,118)` 边框 / 0 圆角）→ `Input`（36px 高 / 14px / `--input` 边框 / 10px 圆角）；按钮由旧蓝 `#1d6fd3` → `--primary`；危险操作 → `--danger` 实心；链接色统一 Primary（无一处出现全局 `#1d4f91`）。
- **信息层级**：详情页从"一个面板里堆 h2"改为「服务器卡片 → 状态摘要 → Tab → 三张信息卡 → 操作卡片」，并按 `07-page-layout-patterns.md` 的 **Tool Federation Workspace** 定位组织为「注册表 → 工具（风险/审批/启用治理）→ 绑定（项目级 / Agent 级）」。
- 未使用 `!important`、未新增设计 Token、无渐变/阴影新体系、Light only。

## 4. 业务与安全冻结确认

| 项 | 状态 |
| --- | --- |
| API | **未变**（`api/mcp.ts` 10 个导出、endpoint / 方法 / 查询参数不变；实测请求：`GET /servers`、`GET /servers/:id`、`/tools`、`/bindings`、`POST /servers/:id/bindings`、`PATCH /bindings/:id`、`DELETE /bindings/:id`、`GET /ui-apps?projectId&agentName`、`GET /ui-resource?uri&projectId&agentName`、`POST /apps/actions`） |
| Store | **未变**（`fetchServers` / `fetchServerDetail` 三路并行 + 失败清空 / `fetchBindings` / `createBinding`→refresh / `setBindingEnabled` / `deleteBinding`） |
| Router | **未变**（3 条路由、`/mcp/:serverId` 与 `/mcp/:serverId/app` 深链接、`?projectId=&agentName=` 预填保留） |
| 沙箱安全红线 | **逐行未改**：`iframe :sandbox="MCP_APP_SANDBOX"`（实测 `sandbox="allow-scripts"`，且全页仅 1 个 iframe）、`:srcdoc` 不透明源、`buildAppDocument` 调用、`createMCPAppHost`（来源校验/schema/体积）、`window` message 监听与清理、桥接日志只记工具名与拒绝码且上限 20 条。**实测**：合成应用内 `requestToolCall("echo", {message:"hi"})` → `POST /apps/actions`，载荷含 **`allowedTools:["echo"]`**（严格单工具策略经真实 UI 链路成立） |
| 交互 | 12 项全部保留：Tab 本地切换（非路由、不发请求）、`window.confirm("确定撤销该绑定吗？撤销后 Agent 调用将立即被拒绝。")`（**实测**：confirm=false → **0 次 DELETE**；confirm=true → DELETE 发出）、`busyBindingId` 行级禁用、`saving`/`formError`、成功后清空 agent/tool 并**保留 projectId**（实测：提交后 `projectId` 保留、agent/tool 清空）、`canLoad` 守卫与错误文案、`frameKey` 递增、`pushLog` 头插 + `slice(0,20)` |
| 表单语义 | **实测**：提交载荷 `{"projectId":"b55c87fc-…","enabled":true}` —— 输入框内前后空格被 **trim**（`v-model.trim` + `defineModel` 生效，与改造前一致）、纯空格 agentName 与空 toolName 归一化为 **undefined**（字段整体不出现）；`required` / `list="mcp-project-options"` + `datalist`（真实项目 1 条）保留、checkbox 默认 `true` |
| 文案 | 全部业务文案逐字保留（含 7 条状态标签与说明、风险/审批/启用/绑定标签、三处凭据说明、`MCP server not found` 等后端原文、日志文案） |
| 状态分支 | 三页 9 处 loading / error / empty 顺序与条件不变（**实测**：详情 error 分支数据被清空、0 Tab 0 卡片；列表 loading 分支「正在加载 MCP 服务器…」+ 刷新按钮禁用） |
| 业务数据 | **未创建/未修改任何 MCP 服务器、工具、绑定**（`GET /api/mcp/servers` 复核仍为 **0 条**；projects 1 / workflows 7 不变） |

## 5. 测试结果

```
typecheck  PASS
lint       PASS
test       PASS  28 files / 206 tests（180 → 206：+3 文件、+26 例）
build      PASS  dist/assets/index-b6lY1hI-.css 39.49 kB (gzip 7.48)
                 dist/assets/index-D3krWgLB.js  341.49 kB (gzip 104.78)
```

体积变化（相对 9.5-B 基线）：CSS 33.71 → **39.49 kB（+5.78）**；JS 336.60 → **341.49 kB（+4.89）**。
安全不变量测试 `mcpAppBridge.test.ts` 与 `mcpSecurity.test.ts` **同时通过**（源码扫描未引入 MCP SDK / 存储调用 / 凭据字面量 ✓）。

新增页面契约测试覆盖：页头与入口链接、四/三分支状态、真实字段绑定、tone 映射、目标链接、`?projectId=&agentName=` 预填、未加载时无 iframe、以及**"不得再出现任何 legacy 类名"护栏**（三页各自断言 20 个 legacy 类名 token）。

## 6. 浏览器验证结果（:5173 真实后端 ; :3000）

### 6.1 真实注册表（0 台服务器）
| 页面 | 实测 |
| --- | --- |
| `/mcp` | h1 **24px/600**「MCP 服务器」+ eyebrow「设置」；说明条 13px / `--muted` 底 / `--border` / 12px 圆角；「刷新」Button secondary 36px 且未禁用；`EmptyState` 1076×107「暂无已注册的 MCP 服务器。」；`overflowX = 0`；console 空 |
| `/mcp/<不存在的 uuid>` | 标题回退「服务器」；后端原文「MCP server not found」`rgb(220,38,38)`；页头两链接（MCP 应用 → `/mcp/<id>/app`、返回列表 → `/mcp`）36px、`rgb(31,41,55)` + `--muted` 底（**非**旧链接蓝）；0 Tab / 0 卡片（error 分支）；`overflowX = 0` |
| `/mcp/<uuid>/app` | 沙箱说明条渲染出 `allow-scripts` 与「无 Cookie、无父页面 DOM、无凭据。」；两个输入 required + 占位符 + **查询参数预填生效**（36px / 14px / `--input` / 10px 圆角）；「加载应用」Primary `rgb(108,92,231)`；`overflowX = 0` |

### 6.2 请求级测试替身（合成的 `/api/mcp/**` 响应，**未落库、未创建业务数据**）
| 验证项 | 实测 |
| --- | --- |
| 列表（2 台） | 2 行卡片 1076×97、`--border`/12px 圆角/白底；名称 16px Primary；meta「stdio · 2 个工具 · 最近连接 2026年9月10日 10:30」；徽标 已连接(`#ECFDF5`/`#059669`) + 已启用、降级(`#FFFBEB`/`#D97706`) + 已禁用；`title` 挂后端状态说明原文；仅 1 次 `GET /servers` |
| 详情 · 概览 | Tab「概览（激活）/ 工具（2）/ 绑定（2）」，36px/14px；状态摘要；三张卡（连接 / 元数据 / 传输配置），`dl` 三列（@1280 → 899 起单列）；11 个字段真实值（含 `authRef` / `credentialRef`）；凭据说明存在；**恰好 3 次并行 GET**（server/tools/bindings） |
| 详情 · 工具 | 2 行：`echo`（低/无需审批/已启用）与 `delete_file`（**严重 `#FEF2F2`/`#DC2626`** / 需要审批 / 已禁用），schema 摘要与描述完整 |
| 详情 · 绑定 | 三张卡（项目绑定 / Agent 绑定 / 创建绑定）；行标题「项目级 · 全部工具」「Agent: dev-agent · echo」；项目名 Mini Todo；徽标 + 停用/启用 + 撤销；表单 4 字段（项目必填、datalist 含真实项目 UUID、复选框默认勾选） |
| 绑定 CRUD 链路 | `POST /bindings`（载荷 trim/undefined 语义正确）→ 自动 `GET /bindings` 刷新；`PATCH /bindings/b1 {"enabled":false}` → 刷新；`DELETE /bindings/b1` 仅在 `confirm()===true` 时发出 |
| App 全链路 | `GET /ui-apps?projectId=…&agentName=dev-agent` → 1 条（echo / `ui://echo/app.html`）→「打开」→ `GET /ui-resource?uri=…`；iframe **sandbox="allow-scripts"**、`title="MCP 应用"`、srcdoc 非空、`min-height 420px`、仅 1 个；合成应用内动作 → `POST /apps/actions` 含 **`allowedTools:["echo"]`**；日志「应用已加载：ui://echo/app.html」「动作成功：echo」（等宽 12px、头插） |
| 加载态 | 人为延迟响应 + 刷新 → 「正在加载 MCP 服务器…」出现且刷新按钮 **disabled**；响应返回后 2 行渲染、按钮恢复 |
| hover / focus | 列表行 hover `rgb(248,249,252)`（`--muted`）；Tab / 按钮 focus-visible 2px Primary ring |
| 响应式 | `/mcp` @1280/900/899/700：`overflowX = 0`（根宽 1076 / 696 / 695 / 496；@700 行内操作换行、行高 97 → 141）；详情 @900 `dl` 三列、@899/700 单列，`overflowX = 0`；工具/绑定面板 @700 行内换行（行高 90/124、114）且 `overflowX = 0`（子元素最右 644 < 700）；App 页输入框随容器收缩，`overflowX = 0` |
| console | 全部轮次 **0 error / 0 warning** |
| **legacy 审计（双通道）** | `/mcp`、`/mcp/:id`、`/mcp/:id/app` 三页 DOM 类名（95 / 93 / 93 个）∩ `styles.css` 全部类选择器 = **`[]`**；`styles.css` 未改动 |

## 7. 与 Dashboard 视觉语言一致性

同一套 `PageHeader` / `Card` / `SectionHeader` / `StatusBadge` / `EmptyState` / `Button` / `Input` / `Label` + Tailwind Token 类；相同的 24/16/14/13/12px 排版阶梯、12px 圆角、`--border` 描边、24px 区块间距与 16px 栅格 gap；同样以「卡片 + 状态徽标 + 次级操作」替代传统后台的表格/行按钮堆叠；`serverStatusTone` 等 tone 纯函数与 Dashboard 的 `projectStatusTone`、9-B 的 `deploymentStatusTone` 完全同一模式。

## 8. 风险与验证限制

| # | 项 | 说明 |
| --- | --- | --- |
| R1 | **MCP 注册表真实为空** | 详情三 Tab、工具、绑定、CRUD、可用应用、iframe 沙箱与桥接日志**无法用真实数据端到端验证**。本阶段采用**请求级测试替身**（仅在浏览器内拦 `fetch`，不写库、不创建业务数据）完成覆盖；**未创建任何测试服务器** |
| R2 | 替身验证的效力边界 | 替身验证的是「页面 ↔ 契约 ↔ 交互」链路（含 `allowedTools` 单工具、confirm 门禁、trim→undefined），**不能**替代真实 Tool Runtime 的权限/审批/审计验证（那属于后端职责，届时用真实注册表复核） |
| R3 | `serverStatusClass` / `riskClass` 保留但模板停用 | 既有测试契约未破坏；两个函数成为未被模板调用的兼容导出（**记录为后续可清理项**，本阶段不删） |
| R4 | 有意视觉差异 | 状态/风险由「恒绿 + 自定义色」改为语义 tone；圆角 8 → 12px；边框 `#dde5ee` → `--border`；标题 32/700 → 24/600；输入框由 UA → `Input`；危险按钮由浅红 → `--danger` 实心（均为 10-A §9.6 / §15 预告项） |
| R5 | 900px 边界 | 详情 `dl` 单列切换发生在 `min-[900px]`（≥900 三列、<900 单列），与既有阶段一致的边界语义 |
| R6 | 未验证项 | 触屏/真实移动端未验证；`?projectId=&agentName=` 之外无其他深链接形态 |

## 9. 结论

**PASS**

三条 MCP 路由完成结构性重构（页面骨架 + 信息层级 + 卡片语言），与 Dashboard 及已迁移页面统一；`Tool Federation Workspace` 定位落地为「注册表 → 工具治理 → 绑定」三层；业务、接口、Store、Router、沙箱安全红线与全部文案零改动；四道门禁全绿；三页 **legacy 命中 0**；`overflowX = 0` / console 0。

**Code changed: ONLY `MCPServersView.vue` + `MCPServerDetailView.vue` + `MCPAppView.vue` + `mcpViewModel.ts`（仅新增 4 个 tone 函数）+ 4 个测试文件（+ 本文档）**
**API / Store / Router / mcpAppBridge / styles.css / Dependencies / Business data: NONE**

按阶段纪律**在此停止**，不进入 Phase 11。
