# Phase 9-A — Deployments 现状分析（只读）

> 阶段：Phase 9-A（只读分析；**禁止修改任何源码 / 业务数据**）
> 依据：`docs/design/*`、`docs/ui-reference/ai-se-home.png`、`docs/60`–`docs/79`、Phase 3-B / 3-C / 4 / 5 / 6 / 7 / 8 既有实现
> 全部结论来自当前代码、CSS 与**真实运行环境实测**；无数据/不确定处明确标记 `UNKNOWN`。
> 日期：2026-09-15

---

## 1. 当前实现分析

### 1.1 Route / View

| 路由 | name | 组件 | 行数 |
| --- | --- | --- | --- |
| `/deployments` | `deployments` | `DeploymentsView.vue` | **224** |
| `/deployments/:id` | `deployment-detail` | **同一组件** | — |

- **无** `meta` / 守卫 / 权限 / 懒加载（与其余 12 条路由一致，全部静态 import）。
- 侧栏菜单 `{ label: "部署", to: "/deployments" }`；详情路由 active 归属由 Router 驱动（`AppSidebar.vue` 第 40 行注释已列明 `/deployments/:id`）。
- **深链接是路径参数**（区别于 AgentRun 的 query 参数）：`selectedId = route.params.id` → `watch(selectedId)` → `deployments.select(id)`；列表点击 `router.push('/deployments/' + id)`。因是同一组件，**`/deployments/:id → /deployments/:other` 不重挂载**，但 `watch(selectedId)` 存在 ⇒ **切换会重新加载**（与 AgentRun 不同，此处有 watcher）。
- 页面宽度：根元素 `section.page.deployment-page` —— **`.deployment-page` 在全项目 CSS 中不存在**（0 处定义，同 `.workflow-page`），宽度实际来自 `.page` = **1180px**。

### 1.2 API（`api/deployments.ts`，54 行）

| 函数 | 请求 | 参数 / 响应 |
| --- | --- | --- |
| `listDeployments(projectId?)` | `GET /api/deployments[?projectId=]` | `Deployment[]`；`projectId` 经 `encodeURIComponent`，为空则不带 query |
| `getDeployment(id)` | `GET /api/deployments/:id` | `DeploymentDetailView { deployment, logs, ciRun?, environment? }` |
| `listEnvironments(projectId?)` | `GET /api/environments[?projectId=]` | `DeploymentEnvironmentConfig[]` |
| `saveEnvironment(input)` | **`PUT`** `/api/environments` | `DeploymentEnvironmentConfig`（upsert 语义） |
| `rollbackDeployment(id, { reason })` | `POST /api/deployments/:id/rollback` | `Deployment` |

- **未使用 API：无（5/5 全部在用）** —— 与 7-A（4 个未使用）、8-A（2 处死代码）不同，本模块无死代码。
- 错误处理契约（与其余模块一致，冻结）：`{success,data}`；`success === false` → `payload.error.message`；网络失败 → `"网络请求失败：无法连接后端服务"`；非 JSON → `"请求失败（HTTP <status>）"`；store 兜底 → `"部署请求失败"`。
- 服务端路由：`apps/server/src/routes/deployments.ts`（`/deployments`、`/deployments/:id`、`/deployments/:id/rollback`、`PUT /environments`、`GET /environments`）。
- **实测错误路径**：`GET /api/deployments/<不存在的 uuid>` → **HTTP 404**，页面顶部显示后端原文 **`Deployment not found`**（英文，非中文文案）→ 属既有行为，须原样保留。

### 1.3 Store（`stores/deployments.ts`，109 行）

- **state**：`deployments: Deployment[]`、`environments: DeploymentEnvironmentConfig[]`、`current: DeploymentDetailView | null`、`loading`、`acting`、`error`
- **actions**：
  - `load(projectId?)` —— `Promise.all([listDeployments(projectId), listEnvironments(projectId)])`；`loading` 包裹
  - `select(id)` —— `getDeployment(id)` → `current`；**复用同一个 `loading` 标志**（列表「加载中…」条件为 `loading && !deployments.length`，故已有数据时 select 不会显示加载文案）
  - `saveEnvironment(input)` —— `acting` 包裹；成功后**按 `projectId + name` upsert `environments`**（存在则替换、否则 push），**不重新拉取列表**；失败返回 `null`
  - `rollback(reason)` —— 无 `current` 直接 `return null`；成功后 `await load(current.projectId)` → `await select(current?.id ?? rolledBack.id)`（**回滚后仍停留在原部署详情**）
  - `environment(projectId, name)` —— **全项目无调用方（未被页面消费）**
- **无 SSE、无 polling、无快照**：本页是**全项目唯一没有实时通道的业务页面**（Workflows / Requirements / AgentRuns 各有一条独立 SSE + 轮询兜底）。
- **跨页共享**：`useDeploymentsStore` **仅 `DeploymentsView` 使用**；共享的是 `useProjectsStore`（`fetchProjects`）。`environments` 与 `environment()` 不被任何视图消费 —— 即「保存环境」在 UI 上的可见反馈**只有按钮的 `acting` 禁用态**（没有成功提示、列表也不展示环境）。
- 既有冻结测试 `stores/__tests__/deployments.test.ts`（2 例，`vi.mock` 整模块）：`loads, selects, and rolls back a deployment`（断言 `rollbackDeployment("deployment", { reason: "health failed" })`）、`upserts environment configuration without storing a secret value`（**断言 `secretReference` 原样返回**）。

### 1.4 ViewModel（`viewmodels/deploymentViewModel.ts`，49 行，6 个导出，全部在用）

| 导出 | 行为 |
| --- | --- |
| `deploymentStatusLabel(status)` | PENDING 等待中 / RUNNING 进行中 / SUCCESS 成功 / FAILED 失败 / ROLLING_BACK 回滚中 / ROLLED_BACK 已回滚 / ROLLBACK_FAILED 回滚失败 |
| `environmentLabel(env)` | dev 开发 / staging 预发 / production 生产 |
| `ciProviderLabel(provider)` | github → GitHub / local → 本地 / 其他原样 |
| `ciStatusLabel(status)` | QUEUED 排队中 / RUNNING 进行中 / SUCCESS 成功 / FAILED 失败 / CANCELLED 已取消（未命中回退原值） |
| **`canRollback(deployment)`** | `operation === "DEPLOY"` **且** `status ∈ {SUCCESS, FAILED}` —— **操作红线判定** |
| `shortVersion(version)` | `length > 12 ? slice(0, 12) : version` |

- **无跨页共享**（本文件只被 DeploymentsView 使用）→ 与 `requirementViewModel`（跨 2 页）不同，迁移风险更低。
- 既有冻结测试 `__tests__/deploymentViewModel.test.ts`（2 例）：状态/版本格式化、`canRollback` 三态。
- **当前不存在任何 Deployment 状态 tone 映射**（`StatusBadge` tone 已在 4 / 6-B / 7-B / 8-B 为 project / requirement / task / workflow / agentRun / toolCall 建立）。
- **无日志级别 label 函数**：日志行的中列直接渲染 `entry.level` 原值（`info` / `warn` / `error`，英文小写）→ 迁移必须保持原样（不得新增 label）。

### 1.5 UI / 交互（含异常与边界）

```
section.page.deployment-page（1180px；.deployment-page 无样式）
├── header.page-header：eyebrow「阶段 6」+ h1「部署」          ← 无 actions
├── p.error-banner（v-if deployments.error）                   ← 全项目仍未定义该 class
└── div.deployment-layout（320px + 1fr，gap 24；≤900 → 1fr）
    ├── aside.deployment-sidebar（grid，align-content start，gap 12）
    │   ├── form.form-panel.stacked-form（h2「环境」，gap 12，内距 20px）
    │   │   ├── label>select 项目（required；选项来自 projects store，含空值「选择项目」）
    │   │   ├── label>select 环境（dev/staging/production，默认 staging，选项文案「开发（dev）」等）
    │   │   ├── label>input[type=url] 端点（required，默认 http://localhost:18001）
    │   │   ├── label>input[type=number] 主机端口（min 1 / max 65535，默认 18001）
    │   │   ├── label>input[type=number] 容器端口（min 1 / max 65535，默认 3000）
    │   │   ├── label>input[type=text] Secret 引用（可选，placeholder「仅引用，不含明文」）
    │   │   └── button.button.primary「保存」（`:disabled="deployments.acting"`）
    │   └── section.panel.deployment-list：panel-header「历史」
    │       ├── p「加载中…」（`loading && !deployments.length`）
    │       ├── p.empty「暂无部署记录。」（`!deployments.length`）
    │       └── button.deployment-list-item[.active]（强＝`环境 · 状态`；span＝`短版本 · 本地时间`）
    └── main.deployment-detail（v-if deployments.current；grid gap 12）
        ├── panel：panel-header（eyebrow「部署详情」+ h2＝部署 UUID + span.status-pill＝状态文案）
        │        + dl.deployment-metadata（2 列）：环境 / 版本 / Git 提交 / Docker 镜像 /
        │          工作流（RouterLink → `/workflows/:id`）/ 端点（`<a target=_blank rel=noreferrer>`）
        ├── panel「健康检查」：`<pre>{{ JSON.stringify(healthCheck, null, 2) }}</pre>`
        ├── panel「CI」（v-if current.ciRun）：`状态 · 提供方` + 可选 `拉取请求 #N` + 可选 `<a>打开 CI 运行</a>`
        ├── panel「日志」：空态「暂无部署日志。」/ ol.event-timeline（time｜level 原值｜message）
        └── form.form-panel.stacked-form「回滚」（v-if canRollback(current.deployment)）
            ├── label>textarea 原因（rows=3，required，默认「恢复到上一个已知可用版本」）
            ├── p（仅 production 环境）「关联的生产部署任务必须已通过人工审批。」
            └── button.button.danger「回滚」（`:disabled="deployments.acting"`）
    └── div.empty.deployment-empty「请选择部署。」（v-else）
```

**交互清单（冻结）**

| # | 交互 | 行为 |
| --- | --- | --- |
| 1 | `onMounted` | `Promise.all([projects.fetchProjects(), deployments.load()])`；有 `:id` 再 `select(id)` |
| 2 | `watch(projectId)` | `deployments.load(id \|\| undefined)`（清空选择时重新加载全部） |
| 3 | `watch(selectedId)` | `if (id) select(id)` |
| 4 | 提交环境表单 | 守卫 `if (!projectId) return;` → `saveEnvironment({ projectId, name, endpoint, adapter: "docker", configuration: { hostPort, containerPort }, secretReference: secretReference \|\| undefined })` |
| 5 | 列表项点击 | `router.push('/deployments/' + item.id)` |
| 6 | 提交回滚 | `deployments.rollback(rollbackReason)`（**无 confirm 确认**） |
| 7 | 详情链接 | 工作流 `RouterLink`（同页跳转）、端点与 CI 为 `target="_blank" rel="noreferrer"` 外链 |

**状态与边界**

- **Loading**：仅列表区一处「加载中…」（`loading && !length`）；`acting` 驱动两个按钮的禁用态；**详情没有独立 loading 文案**。
- **Error**：**仅顶部一条 `.error-banner`**（无独立样式，实测 UA 默认：`margin-top:16px` / `font-size:16px` / 无边框背景）。
- **Empty**：列表「暂无部署记录。」、详情「请选择部署。」、日志「暂无部署日志。」；**CI 面板为纯 `v-if`（无数据即整块不渲染，无空态文案）**。
- **Success**：无 toast、无成功提示（保存环境成功后 UI 无可见变化）。
- **Confirm**：**全页无 confirm / alert / window 调用**。
- **表单校验**（HTML 原生，无 JS 校验）：`项目` select `required`、`端点` `type=url` + `required`、两个端口 `type=number` `min=1 max=65535`、`Secret 引用` 无 required/无 maxlength、回滚 `原因` textarea `rows=3` + `required`。
- **实测初始值**：environment=`staging`、endpoint=`http://localhost:18001`、hostPort=`18001`、containerPort=`3000`、secretReference=`""`、rollbackReason=`恢复到上一个已知可用版本`。

### 1.6 真实数据实测结果（只读，未写入任何业务数据）

| 检查 | 结果 |
| --- | --- |
| `GET /api/deployments` | **`[]`（0 条）** |
| `GET /api/deployments?projectId=b55c87fc-…` | **`[]`** |
| `GET /api/environments` / `?projectId=…` | **`[]`（0 条）** |
| 页面实测 | 列表空态「暂无部署记录。」+ 详情空态「请选择部署。」+ 环境表单完整渲染（项目下拉有真实项目 Mini Todo） |
| 深链接 404 | `/deployments/<不存在 uuid>` → 顶部显示后端原文 `Deployment not found`（`.error-banner` 无样式） |
| API 调用序列 | `/api/projects` → `/api/environments` → `/api/deployments`（真实请求） |
| 控制台 | 0 error / 0 warning |

> ⚠️ **关键约束：本页当前没有任何真实业务数据**（部署记录与环境记录均为 0）。因此以下路径**无法用真实数据验证**（标记 `UNKNOWN`，且任务书禁止修改真实业务数据 ⇒ 本阶段**未创建**任何部署或环境记录）：
> 列表项渲染与 `.active` 态、详情 6 项元数据、健康检查 `<pre>`、CI 面板（含 PR/链接）、日志时间线（含 ≤900 折叠）、回滚表单（`canRollback` 为真时）、`status-pill`、`shortVersion` 的截断显示。
> 这些仅能通过**单元测试 / 浏览器层存根**在 9-B 覆盖，或在获得授权后创建一条真实部署记录。

## 2. Legacy CSS 风险

### 2.1 本页使用的 legacy 类与归属

| 类 | 定义要点（实测） | 归属 |
| --- | --- | --- |
| `page` | `max-width:1180px`；≤900 → `100%` | 4 个未迁移页面共享（Deployments + 3 个 MCP 页） |
| `deployment-page` | **无定义**（纯语义） | **仅本页** |
| `page-header` / `eyebrow` | flex 两端 / 小号强调字 | 4 页共享 |
| `deployment-layout` | `320px minmax(0,1fr)`，gap 24；≤900 → `1fr` | **仅本页** |
| `deployment-sidebar` / `deployment-detail` / `deployment-list` | `grid; align-content:start; gap:12px` | **仅本页** |
| `deployment-list-item`(+`.active`) | 白底、`1px #d8e1ea`、radius 6、padding 12、gap 4；**.active 边框+`inset 3px 0` 旧蓝 `#1d6fd3`** | **仅本页** |
| `deployment-list-item span` | `color:#65758a; font-size:13px` ← **复合选择器陷阱** | **仅本页** |
| `deployment-metadata` | `repeat(2,minmax(0,1fr))` gap 14；dt 12px `#65758a`；dd `margin:4px 0 0` + `overflow-wrap:anywhere`；**无媒体查询** | **仅本页** |
| `deployment-detail pre` | `overflow:auto; margin:0`（**无 max-height**） | **仅本页** |
| `deployment-empty` | **无定义**（纯语义，样式全部来自 `.empty`） | **仅本页** |
| `form-panel` | 白底 `1px #dde5ee` radius 8 padding 20、`align-self:start` | **仅本页**（8-B 后 AgentRun 已脱离） |
| `stacked-form` | `grid; gap:12px` | 3 页共享（Deployments + MCPApp + MCPServerDetail） |
| `panel` / `panel-header` | 白底 `1px #dde5ee` radius 8 padding 20 / flex 两端 + `margin-bottom:14px` | panel：3 页；**panel-header：仅本页（5 处）** |
| `empty` | `color:#65758a; padding:28px; text-align:center` + 白底 `1px #dde5ee` radius 8 | 4 页共享 |
| `status-pill` | `1px #b8c8d8`、`#31465c`、12px/700、padding 5px 9px、radius 999（**无颜色语义**） | **仅本页**（7-B 后 Workflows 已脱离） |
| `event-timeline` | `100px minmax(0,1fr) 90px`、`border-top #e4eaf0`、padding 10px 0；`time/span` 13px `#65758a`；**≤900 → `80px minmax(0,1fr)` 且 `span{grid-column:2}`** | **仅本页**（7-B 后 Workflows 已脱离） |
| `button`（`primary` / `danger`） | base：`1px #ccd6e0` radius 8 min-height 38 padding 8/14；**`.primary` = 旧蓝 `#1d6fd3`**；`.danger` = 浅红 `#fff5f5` / `#f2b6b6` / `#b3261e` | 3 个 MCP 页 + 本页 |
| `error-banner` | **全项目未定义** | **仅本页**（8-B 后 Agents 已脱离） |

### 2.2 已确认的全局级联风险（实测）

1. **全局未分层 `a { color:#1d4f91 }` + `a:hover{text-decoration:underline}`** —— 本页有 **3 个链接**（工作流 `RouterLink`、端点外链、CI 外链），当前均为旧链接蓝；迁移需页面 scoped 处理（同 5 个已迁移页先例）。
2. **未分层 `button,input,select,textarea { font: inherit }`** —— 本页有 2 select + 4 input + 1 textarea + 2 button；移除 `form-panel`/`stacked-form` 后必须显式声明字号（项目已具备 `Input` / `Textarea` / `Button` 组件，可覆盖）；**select 无组件**（沿用 6-B/7-B 的 scoped 显式样式手法）。
3. **`!important`：全项目仅 1 处**（`styles.css:282` = `.checkbox-row { grid-template-columns: auto 1fr !important }`，Workflows 专用、7-B 后已无页面使用）—— **本页不受任何 `!important` 影响**。
4. **复合选择器穿透**：`.deployment-list-item span { color:#65758a; font-size:13px }` —— 若迁移后复用该类名，列表项内任何 `<span>` 的语义色/字号都会被静默改写（与 7-B 发现的 P1 同源）。**结论：新 markup 一律不得复用该名。**
5. **值域偏差（迁移必然产生视觉变化）**：`.panel` 边框 `#dde5ee` vs Token `--border #e8eaf0`；面板圆角 8px vs `--radius-lg 12px`；`.empty`/列表次行文字 `#65758a` vs `--muted-foreground #6b7280`；`.primary` 旧蓝 `#1d6fd3` vs `--primary #6c5ce7`；h1 32px/700 vs `--text-page-title` 24px/600；select 42px/16px vs 36px/14px；input 40px/16px vs 36px/14px。
6. **Tailwind 冲突面**：本页全部 legacy 类均为**未分层**（`styles.css` 零 `@layer`），恒定优先于 `@layer utilities` ⇒ 迁移必须**移除 legacy 类**而非叠加工具类（Phase 5-B 已确立的结论）。

## 3. Component Gap

| 需求 | 现有组件（3-B / 3-C） | 结论 |
| --- | --- | --- |
| 页头（无 actions） | ✅ `PageHeader` | 够用 |
| 4 个面板容器 + 标题 | ✅ `Card` + `SectionHeader`（含 `#actions`） | 够用 |
| 保存 / 回滚按钮 | ✅ `Button`（`default` = Primary；`variant="destructive"` 对应 legacy `.danger`） | 够用 |
| 部署状态（列表项 + 详情） | ⚠️ `StatusBadge` 存在，**缺 DeploymentStatus → tone 映射** | **需裁定**（见 §6 建议） |
| 列表项 | ✅ 原生 `<button>` + 页面 scoped 类（6-B/7-B/8-B 已验证模式） | 够用 |
| 环境表单（2 select + 4 input + 1 textarea） | ⚠️ `Input` / `Textarea` / `Label` 齐备；**无 Select 组件** | 原生 select + scoped 显式样式（同 6-B/7-B 先例）；**不新增组件** |
| 元数据（2 列 dl） | ✅ `dl` + Tailwind grid（6-B/7-B/8-B 已验证） | 够用（**保留恒 2 列**，legacy 无断点） |
| 健康检查 / CI 内容 | ✅ `<pre>` + Tailwind；`<a>` 外链 + scoped 链接色 | 够用 |
| 日志时间线 | ✅ Tailwind grid（复现 3 列 + ≤900 折叠） | 够用 |
| error / empty | ✅ `EmptyState`；error 用 Tailwind `text-danger` 文本行 | 够用 |
| Dialog / Toast / Skeleton / Table / Tabs / Pagination / Drawer / Form | ❌ 均无 | 本页**不需要**：无 confirm、无 toast、无表格、无分页、详情无 loading 文案 ⇒ **不得新增** |

**结论：不需要新增任何组件**；唯一需要新增代码的是（待裁定的）`deploymentStatusTone()` 纯函数与页面内 scoped 样式。

## 4. Responsive 分析

| 断点 | legacy 行为（实测/源码） | 迁移建议 |
| --- | --- | --- |
| `max-width: 900px` | `.deployment-layout` → 单列；`.page` → `max-width:100%`（内容不再受 1180 限制） | 用 `min-[900px]:grid-cols-[320px_minmax(0,1fr)]` 复现「≥900 两栏」（与已迁移 5 页语义一致）；页宽用 `max-w-[1180px]`（内容自然不超过视口，`100%` 行为等价） |
| `max-width: 900px`（事件时间线） | `.event-timeline li` → `80px minmax(0,1fr)`，`span`（第 3 个）换行到第 2 列 | 迁移时同步复现：`min-[900px]:grid-cols-[100px_minmax(0,1fr)_90px]`，默认 `80px minmax(0,1fr)` + 第 3 单元 `min-[900px]:col-auto col-start-2` |
| 无断点 | `.deployment-metadata` 恒 2 列；列表项、表单、panel 无响应式规则 | 原样保留（不新增断点） |

**实测几何**：@1440 → 容器 1180px、列 `320px + 836px`；@1280 → `320px + 717px`；**@900 / @899 → 单列 681px / 680px，`max-width` 变 `100%`**；四档均 `overflowX = 0`。

**边界差异提示**：legacy 的 `max-width:900px` 在**恰好 900px** 时即折叠为单列；若 9-B 采用 `min-[900px]`，则恰好 900px 为两栏（1px 语义差，与 5-B / 6-B / 7-B / 8-B 已建立的「≥N 两栏」约定一致，已在各阶段报告中记录）。

## 5. Business Freeze

- **API**：`api/deployments.ts` 5 个导出（**无死代码**）、endpoint 与参数形态（`?projectId=` 过滤、`PUT /api/environments` 的 upsert 语义）、响应结构（`Deployment` / `DeploymentDetailView` / `DeploymentEnvironmentConfig`）、4 条错误文案 + store 兜底「部署请求失败」、**404 时展示后端原文**（`Deployment not found`）
- **Store**：`stores/deployments.ts` 全文（`load` 的并行拉取、`select` 复用 `loading`、`saveEnvironment` 的 upsert 且**不重载列表**、`rollback` 的 `load(projectId)` → `select(原 id)` 链、`environment()` 保留）
- **既有 store 测试契约**：`deployments.test.ts` 2 例（含 `secretReference` 原样返回、`rollback` 入参）
- **Router**：2 条路由（同组件）、路径参数深链接、`watch(selectedId)` 行为、列表点击 `push`
- **权限 / 操作红线**：`canRollback(deployment)`（`operation === "DEPLOY"` 且 `SUCCESS|FAILED`）—— **回滚表单的渲染 gate，不得改动**
- **SSE / polling**：**本页无实时通道**（不得为了"对齐"新增任何 SSE/轮询）
- **ViewModel 输出**：`deploymentStatusLabel` / `environmentLabel` / `ciProviderLabel` / `ciStatusLabel` / `shortVersion` 逐字冻结（无跨页共享，改动风险仅在页面内）
- **状态枚举**：`DeploymentStatus`(7)、`DeliveryEnvironment`(3)、`operation: DEPLOY|ROLLBACK`、`CiRunStatus`(5)、`DeploymentLog.level`（页面直接渲染原值）
- **文案**：全部业务文案（含 `阶段 6` / `部署` / `环境` / `历史` / `部署详情` / `健康检查` / `CI` / `日志` / `回滚` / `暂无部署记录。` / `请选择部署。` / `暂无部署日志。` / `加载中…` / `选择项目` / `开发（dev）` 等 3 个环境选项 / `仅引用，不含明文` / `恢复到上一个已知可用版本` / **`关联的生产部署任务必须已通过人工审批。`**）
- **表单约束**：`required`（项目、端点、回滚原因）、`type=url`、端口 `type=number min=1 max=65535`、`rows=3`、默认值（staging / 18001 / 3000 / 空 / 默认原因）、`v-model.number`（端口）与 `v-model`（其余）
- **环境保存语义**：`adapter` 硬编码 `"docker"`、`configuration: { hostPort, containerPort }`、`secretReference || undefined`（**仅引用、不含明文**的既有安全语义不得改变）
- **Confirm**：**无**（不得新增 Dialog/confirm）
- **Loading / Error / Empty 分支**：列表「加载中…」条件、单一顶部 error、三处 empty、CI 面板 `v-if`（无空态）、详情**无独立 loading**
- **交互**：7 项（见 §1.5），含两个表单提交、列表点击、3 个链接
- **数据结构关系**：`Deployment { deployment, logs, ciRun?, environment? }`；`DeploymentLog.level` 原值展示；`healthCheck` 以 `JSON.stringify(value, null, 2)` 原样输出

## 6. Legacy → 新组件迁移映射（Phase 9-B 计划，不实施）

| Legacy | New（仅复用现有组件） |
| --- | --- |
| `.page.deployment-page` | `max-w-[1180px]`（`.deployment-page` 本无样式，直接退役） |
| `.page-header` + `.eyebrow` + `<h1>` | `PageHeader eyebrow="阶段 6" title="部署"`（无 actions；h1 由 32px/700 → 24px/600，Design System 对齐） |
| `p.error-banner` | 同分支 + `text-body text-danger`（首次上色，同 7-B/8-B 先例） |
| `.deployment-layout` | `grid grid-cols-1 gap-6 min-[900px]:grid-cols-[320px_minmax(0,1fr)]` |
| `.deployment-sidebar` | `grid content-start gap-3`（12px，同 legacy） |
| `.form-panel.stacked-form`（环境） | `Card` + `SectionHeader title="环境"` + `form` grid gap-3；2 个原生 `<select class="deployment-select">`（scoped 显式样式）+ `Label` + `Input`（url/text/number）+ `Button`（`:disabled="deployments.acting"`） |
| `.panel.deployment-list` + `.panel-header` | `Card` + `SectionHeader title="历史"` + 「加载中…」`<p>` + `EmptyState size="compact"` + 原生 `<button class="deployment-item">`（**新类名**，active → Primary） |
| `.deployment-detail` | `grid content-start gap-3` |
| `.status-pill` | `StatusBadge` + `deploymentStatusTone()`（**待裁定**；未授权则保持纯文本） |
| `.deployment-metadata` | `dl` + `grid grid-cols-2 gap-3.5`（保留恒 2 列）+ `dt` `text-caption text-muted-foreground` + `dd` `mt-1 break-words`（字段顺序不变） |
| 工作流 `RouterLink` / 端点 `<a>` / CI `<a>` | 保留原标签 + 页面 scoped 链接色（对抗全局 `a{color}`）；外链保留 `target="_blank" rel="noreferrer"` |
| 健康检查 `<pre>` | `<pre>` + `overflow-auto m-0 rounded-lg border border-border bg-muted p-3 text-body`（**不引入 max-height**，legacy 无此限制） |
| `.panel`「CI」 | `Card` + `SectionHeader title="CI"`（仍为纯 `v-if`，不加空态） |
| `.panel`「日志」+ `.event-timeline` | `Card` + `SectionHeader title="日志"` + `EmptyState` / `<ol>` grid：默认 `80px minmax(0,1fr)` 且第 3 单元 `col-start-2`，`min-[900px]:grid-cols-[100px_minmax(0,1fr)_90px]` + 第 3 单元 `col-auto`（复现 legacy 折叠） |
| 回滚 `form.form-panel.stacked-form` | `Card` + `SectionHeader title="回滚"`（`v-if="canRollback(...)"` 不变）+ `Textarea rows="3" required` + production 提示 `<p>` + `Button variant="destructive"` |
| `.empty.deployment-empty` | `EmptyState title="请选择部署。"` |
| `.button.primary` / `.button.danger` | `Button`（default = Primary `#6C5CE7`）/ `Button variant="destructive"` |

**不做**：不新增组件/路由/依赖、不加 confirm/Dialog/Toast、不引入 SSE、不改 API/Store/Router/文案/表单约束、不删除 `styles.css` 与死代码。

## 7. Phase 9-B 实施建议

1. **允许范围**：`apps/web/src/views/DeploymentsView.vue`、`viewmodels/deploymentViewModel.ts`（**仅新增** tone 纯函数）、对应测试文件（新增 `__tests__/deploymentsView.test.ts`）。
2. **先做**：把 6 个既有函数与全部文案在测试里锁死（当前 viewmodel 测试仅覆盖 2 个函数），再动模板。
3. **tone 裁定**（建议值，需确认）：`PENDING→pending`、`RUNNING→running`、`SUCCESS→success`、`FAILED→error`、`ROLLING_BACK→warning`、`ROLLED_BACK→neutral`、`ROLLBACK_FAILED→error`。
4. **元素选择**：`Input`（url/text/number）、`Textarea`、`Label`、`Button`；**原生 `<select>` 保留**并加 scoped 显式样式（同 6-B/7-B）。
5. **类名纪律**：新 markup 一律不复用 legacy 名（`deployment-item` / `deployment-select` 等新名），并在测试中断言「不得出现 legacy 类」，避免 `.deployment-list-item span` 一类复合选择器穿透。
6. **验证受限提醒**：本页**无真实数据** ⇒ 9-B 浏览器验证只能覆盖空态、表单、404 深链接与响应式；列表项/详情/CI/日志/回滚表单需靠**页面契约测试（SSR 注入 store）**覆盖；若需真实验证，请在 9-B 任务书中明确是否授权「创建一条测试部署/环境记录」（本阶段未创建）。

## 8. 风险矩阵

| # | 风险 | 影响 | 可能性 | 应对 |
| --- | --- | --- | --- | --- |
| R1 | **无真实数据** ⇒ 详情/列表/CI/日志/回滚路径无法端到端验证 | 高（覆盖盲区） | **必然** | SSR 契约测试全覆盖 + 明确记录；如需真实数据须单独授权 |
| R2 | `.deployment-list-item span` 复合选择器穿透语义色/字号 | 中 | 中（若复用类名） | 一律使用新类名 + 测试断言 + 浏览器 leaks 审计 |
| R3 | `canRollback` 被误改（回滚入口红线） | 高（业务） | 低 | `canRollback` 逐字不动 + 既有 2 例测试保留 + 新增页面 gate 断言 |
| R4 | `saveEnvironment` 的 `secretReference` 语义被改（引入明文） | 高（安全） | 低 | 保留 `secretReference \|\| undefined` 与 placeholder 文案；store 测试既有断言不动 |
| R5 | 表单约束（`required` / `type=url` / `min/max` / `rows=3`）在迁移中丢失 | 中 | 中 | 逐项对照 §5 并在测试中断言属性 |
| R6 | 全局 `a{color}` 覆盖 3 个链接 | 低 | 高 | 页面 scoped 链接色（5 个已迁移页先例） |
| R7 | `font: inherit` 压过控件排版工具类 | 中 | 高 | 组件自带 scoped 兜底 + select/textarea scoped 显式字号 |
| R8 | 日志时间线 3 列语义被改（message 在窄列、level 居中） | 低 | 中 | 按 §6 精确复现列定义与 ≤900 折叠 |
| R9 | 误改其他页面 / `styles.css` | 高 | 低 | 严格文件范围 + mtime 核对 |
| R10 | 900px 边界语义差（恰好 900 两栏 vs legacy 单列） | 低 | 中 | 按既有 5 页约定统一并在报告中记录 |
| R11 | 迁移后 h1 / 面板圆角 / 边框色变化被误读为缺陷 | 低 | 高 | 在 9-B 报告中列为「有意视觉对齐」 |
| R12 | 环境保存后 UI 无可见反馈被"顺手"加 toast | 中 | 中 | 冻结「success 无提示」；不得新增 Toast |

## 9. 验收标准（Phase 9-B）

**功能与冻结**
- [ ] `canRollback`、`deploymentStatusLabel`、`environmentLabel`、`ciProviderLabel`、`ciStatusLabel`、`shortVersion` **逐字未改**；既有 2 + 2 例测试全绿
- [ ] `stores/deployments.ts`、`api/deployments.ts`、`router/index.ts`、`styles.css` **零改动**（mtime 核对）
- [ ] 表单约束齐全：`required` ×3、`type=url`、`type=number min=1 max=65535` ×2、`rows=3`、`required` 文本域、默认值不变
- [ ] `adapter: "docker"`、`configuration: { hostPort, containerPort }`、`secretReference || undefined` 原样
- [ ] 分支顺序：列表 `loading → empty → list`；详情 `current ? 详情 : 请选择部署。`；CI 面板纯 `v-if`；日志 `empty → list`
- [ ] **无** confirm / Dialog / Toast / Skeleton / SSE / 新组件 / 新路由 / 新依赖
- [ ] 无 `!important`、未修改全局 CSS

**Legacy 退出**
- [ ] 页面内 legacy 类命中数 **0**（含 `deployment-*`、`form-panel`、`stacked-form`、`panel(-header)`、`status-pill`、`event-timeline`、`error-banner`、`button`、`empty`、`page(-header)`、`eyebrow`）
- [ ] 浏览器内逐条 legacy 选择器审计 **leaks = 0**

**门禁与构建**
- [ ] `typecheck` / `lint` / `test` / `build` 全绿；测试数 ≥ 当前 158 + 新增；build 体积记录在案

**浏览器实测（受 R1 限制）**
- [ ] `/deployments` 空态 + 表单渲染 + 真实 API 调用（projects / environments / deployments）
- [ ] `/deployments/<不存在 uuid>` → 顶部 danger 错误行（后端原文保留）
- [ ] 响应式：1280 / 1440 两栏，899 / 900 单列/两栏按约定；`overflowX = 0`；0 console error/warning
- [ ] 通过 SSR 契约测试覆盖：列表项渲染与 active、详情 6 项元数据、健康检查 pre、CI 面板（含 PR/链接）、日志时间线与 ≤900 折叠、回滚表单 gate 与默认原因、生产环境提示文案、三处 empty 文案
- [ ] 其他 7 条路由回归无异常；后端业务数据零变化

---

**Code changed: NONE**
**API changed: NONE**
**Store changed: NONE**
**Router changed: NONE**
**CSS changed: NONE**
**Dependencies changed: NONE**
**Business data changed: NONE**（未创建/修改任何部署或环境记录）

（本阶段只新增本文档 `docs/80-phase-9-deployments-analysis.md`。）

按阶段纪律**在此停止**，不进入 Phase 9-B。
