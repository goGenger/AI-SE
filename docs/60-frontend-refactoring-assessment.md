# AI-SE Frontend Refactoring Assessment

> 类型：只读评估报告（Read-only Assessment）
> 范围：`apps/web` 前端 UI/UX 重构可行性、保护边界与迁移计划
> 约束：本次未修改任何代码、未安装任何依赖、未修改 package.json / 配置 / Router / API / Store / 数据库
> 依据：`docs/design/*`（8 份设计文档）+ 仓库实际代码（代码优先于文档，冲突已逐条记录）
> 日期：2026-09-15

---

## 1. Executive Summary

### 1.1 结论

本次前端重构**可以安全推进**，风险集中在“契约”而非“业务逻辑”上：

1. 前端是**干净的弱耦合结构**：`views/ (.vue，无子组件) → stores/ (Pinia) → api/ (fetch)`，`viewmodels/` 承担纯展示逻辑。11 个页面文件、2036 行，没有任何共享组件层需要拆解，也没有任何页面被别的页面引用。
2. 前端**没有权限系统**（无路由 meta、无导航守卫、无角色/权限模块），所以“权限保护”在前端层面实际等于三条具体红线：审批流、MCP App 沙箱、条件动作判定函数（详见 §8）。
3. 前端**没有 UI 组件库、没有 Tailwind、没有图标库**，整个视觉层只有一份全局 `src/styles.css`（1051 行）+ 页面内联标记。所以不存在“Element Plus 样式冲突”“体积庞大的组件库迁移”这类典型风险（设计文档中担心的场景在本仓库**不存在**）。
4. 真正的高危点有三类，且都有代码级证据：
   - **源码扫描安全测试**：`apps/web/src/__tests__/mcpSecurity.test.ts` 会遍历 `src/**/*.{ts,vue}` 原文并断言禁用字面量，同时把 `api/mcp.ts` 的 fetch 写法写死为契约。
   - **中文单语 UI + 测试钉死文案**：14 个测试文件对状态/事件/部署等标签函数做精确字符串断言（53 个用例），改动标签必须同步改测试与 `docs/19-user-manual.md`。
   - **原生表单校验语义**：当前 9 个视图共 22 处依赖 `required / maxlength / min / max / type="url"` 的原生校验，换成 shadcn-vue 受控组件时若丢失这些属性，会静默改变业务校验行为。

### 1.2 规模数字（全部来自当前代码）

| 指标 | 数值 | 证据 |
| --- | --- | --- |
| 页面文件（views） | 11 | `apps/web/src/views/*.vue`（2036 行） |
| 路由 | 13 | `apps/web/src/router/index.ts` |
| 一级菜单 | 8（扁平，无二级/三级） | `apps/web/src/App.vue:8-17` |
| API 模块 / 导出网络函数 | 7 / 47（含 2 个 SSE 入口） | `apps/web/src/api/*.ts` |
| 其中 UI 未引用的导出 | 7 | 见 §6 |
| Pinia store | 7 | `apps/web/src/stores/*.ts` |
| ViewModel（展示逻辑层） | 8 | `apps/web/src/viewmodels/*.ts` |
| 测试文件 / 用例 | 15 / 53 | `vitest run src` 实测 |
| 共享组件目录 | 0（不存在 `src/components/`） | 文件系统实测 |
| 全局样式 | 1 份，1051 行 | `apps/web/src/styles.css` |
| `<style>` 块（scoped 或非 scoped） | 0 | 11 个视图文件实测 |

### 1.3 目标与差距规模（摘要）

设计文档要求：AppShell（Sidebar 164px + Header 52px）、8 个一级菜单（含二级菜单）、Design Token 体系、shadcn-vue 基础组件 + AI-SE 公共组件 + 业务组件分层、Tailwind CSS 4、Lucide 图标、Loading/Empty/Error 统一态、1440/1280/1024 响应式验收。

当前实际：无 AppShell 组件（App.vue 内联 24 行）、无 Header、无 Breadcrumb、主色为 `#1d6fd3`（设计为 `#6C5CE7`）、页面标题 32px（设计 20-24px）、无图标、无 aria/focus 处理、无 Dialog/Drawer/Toast/Table/Pagination/Search。

**三个设计文档要求但代码中不存在的导航项**：`任务管理`、`代码仓库`、`系统设置`（对应二级菜单同样全部不存在）。这属于**产品范围决策**，不是重构任务（见 §20 Q3/Q4）。

### 1.4 建议节奏

先做 3 个“零业务风险”阶段（Baseline 冻结 → Tailwind + Token → AppShell），再做 8 个页面批次（每批一域、一次只改一个业务域），最后 Visual QA + Functional Regression。全程 **47 个 API 函数、13 条路由、7 个 store、3 处实时通道不得改动**。

---

## 2. Current Tech Stack

| 维度 | 当前实现 | 证据 / 说明 |
| --- | --- | --- |
| Vue | **3.5.42** | `apps/web/package.json` dependencies |
| Vue 写法 | `<script setup lang="ts">` + Composition API，11/11 页面一致 | 各 views 首行 |
| TypeScript | **6.0.3**（根 devDependency），`vue-tsc 3.3.11` 做 SFC 类型检查 | 根 `package.json`；`apps/web` script `typecheck` |
| TS 严格度 | 继承根 `tsconfig.base.json`；ESLint 硬性 `@typescript-eslint/no-explicit-any: error` | `apps/web/tsconfig.json`、`eslint.config.mjs:28` |
| Router | **vue-router 5.3.1**，`createWebHistory()`，无 base、无 meta、无守卫 | `src/router/index.ts:14-31` |
| State | **Pinia 4.0.3**，Options API 风格 store（`state` + `actions`），7 个 store | `src/stores/*.ts` |
| CSS 方案 | **单份全局 CSS**：`src/styles.css`（1051 行），仅由 `main.ts:5` 引入；**零 scoped 样式、零 CSS 预处理器、零 CSS Modules、零 `@import`/`url()`/`@font-face`** | 实测 grep |
| UI 组件库 | **无**（`package.json` 依赖仅 `@ai-se/shared`、`pinia`、`vue`、`vue-router`） | `apps/web/package.json` |
| 图标库 | **无**（全仓零 `svg`、零图标字体） | 实测 grep |
| Build Tool | **Vite 8.2.2** + `@vitejs/plugin-vue 6.0.8`；alias 仅 `@ai-se/shared → packages/shared/src/index.ts` | `apps/web/vite.config.ts` |
| Testing | **Vitest 5.0.0**，`environment: "node"`，**无 jsdom / 无 @vue/test-utils → 没有任何组件渲染测试** | `apps/web/vitest.config.ts:11-12` |
| Lint | **ESLint 10.10.0** flat config + typescript-eslint 8.70.0 + eslint-plugin-vue 10.11.0（`flat/recommended`） | `eslint.config.mjs` |
| Formatting | **Prettier 3.3.3**，printWidth 100 / 双引号 / 无尾逗号；`prettier --check` 实测 **PASS** | 根 `package.json`、实测 |
| 运行时 | Node **22.22.2**（`.nvmrc`）、corepack pnpm **12.3.4**、pnpm workspace（`apps/*`、`packages/*`） | `.nvmrc`、`pnpm-workspace.yaml` |
| 后端接口基址 | `import.meta.env.VITE_API_BASE_URL \|\| "http://localhost:3000"`（`.env:26` 设置为 localhost:3000） | 7 个 api 模块各自重复声明 |
| 单测覆盖 | 15 文件 / 53 用例，覆盖 **viewmodels + stores + mcpAppBridge + mcpSecurity**；**零 UI 渲染测试** | 实测 |

---

## 3. Current Frontend Architecture

### 3.1 实际目录（AGENTS.md 中的 4 个“规划目录”尚不存在）

```
apps/web/src/
├── main.ts                 # createApp + pinia + router + styles.css（8 行）
├── App.vue                 # 唯一共享 UI：内联 sidebar（8 个 RouterLink）+ RouterView（24 行）
├── router/index.ts         # 13 条路由，无 meta / 无守卫（33 行）
├── styles.css              # 全局唯一样式表（1051 行）
├── api/        7 文件      # 后端 REST 客户端，按资源一文件
├── stores/     7 + 6 测试  # Pinia store，按资源一文件
├── viewmodels/ 8 文件      # 纯展示逻辑 + 中英标签映射
├── views/      11 文件     # 页面级 SFC（2036 行）
└── __tests__/  9 文件      # viewmodel / bridge / 安全扫描测试
    （不存在：components/、composables/、types/、constants/）
```

### 3.2 数据流（实际）

```
views/*.vue  ──(storeToRefs / 直接 action 调用)──▶  stores/*.ts  ──▶  api/*.ts  ──fetch──▶ 后端 REST :3000
     │                                                  │
     └──(纯函数：标签/格式化/条件判断)──▶  viewmodels/*.ts  └──(EventSource + 2s 轮询)──▶ /stream 接口
```

- 页面**不接收 props、不 emit 自定义事件**——11 个视图全部是自包含页面，没有父子 UI 组合。
- `api/` 层 7 个模块**各自复制了一份 `requestJson` 与 `API_BASE_URL`**（7 份重复实现）。
- 3 个 store 内部各自维护**模块级单例** `EventSource` + `setInterval` 轮询器，并在 `onUnmounted` 调用 `stopRealtime()`（`stores/agentRuns.ts:22-40`、`stores/requirements.ts:34-56`、`stores/workflows.ts:21-29`）。
- 页面卸载顺序/挂载次数一旦被 AppShell 改动（例如引入 `keep-alive`），实时通道将泄漏或重复订阅——**这是 AppShell 阶段最容易被忽略的 P0 风险**。

### 3.3 与设计文档的关键架构冲突（只记录，不修改）

| # | 冲突 | 证据 | 影响 |
| --- | --- | --- | --- |
| C1 | 设计文档要求 `shadcn-vue / Reka UI → AI-SE UI Components → Common → Business → Page` 五层；当前只有 Page 一层 | `docs/design/00-design-system.md:44-56` vs 实测无 `components/` | 前 3 阶段需要“从零建立”组件层，不是迁移 |
| C2 | shadcn-vue 默认要求 `@/*` 路径别名；当前只有 `@ai-se/shared` 别名 | `apps/web/vite.config.ts:7-11` | 需要改 `vite.config.ts` + `tsconfig.json`（配置变更，须授权） |
| C3 | shadcn-vue 默认工具目录为 `@/lib/utils`；AGENTS.md §5 明令禁止 `lib/` 等目录名变体 | `AGENTS.md` §5（web 结构） | **BLOCKER**，需用户裁决 `cn()` 落位（见 §20 Q1） |
| C4 | 设计文档要求 Header 含 Search / System Status / Notification / User；代码中不存在对应数据源或接口 | `docs/design/02-navigation.md:135-152` vs §6 API 清单 | Header 内容需裁剪或以纯静态占位实现，否则等于新增功能 |
| C5 | 设计文档一级菜单含 任务管理 / 代码仓库 / 系统设置；代码中无对应路由与页面 | `docs/design/02-navigation.md:10-19` vs `router/index.ts` | 属新功能开发，超出“Visual Redesign”范围（§20 Q3） |
| C6 | 设计文档以“Figma / Reference Image”为 Visual QA 基准；仓库内无任何参考图 | `docs/design/06-visual-qa.md:11-23` | Visual QA 无法闭环（§20 Q5） |

---

## 4. Route & Menu Inventory

### 4.1 路由清单（`apps/web/src/router/index.ts`，共 13 条）

| # | path | name | component | 参数 / 说明 |
| --- | --- | --- | --- | --- |
| 1 | `/` | `dashboard` | `DashboardView.vue` | — |
| 2 | `/projects` | `projects` | `ProjectsView.vue` | — |
| 3 | `/projects/:id` | `project-detail` | `ProjectDetailView.vue` | 路径参数 `id` |
| 4 | `/requirements` | `requirements` | `RequirementsView.vue` | 无详情路由（主从同页） |
| 5 | `/workflows` | `workflows` | `WorkflowsView.vue` | — |
| 6 | `/workflows/:id` | `workflow-detail` | `WorkflowsView.vue` | **与 5 共用组件** |
| 7 | `/deployments` | `deployments` | `DeploymentsView.vue` | — |
| 8 | `/deployments/:id` | `deployment-detail` | `DeploymentsView.vue` | **与 7 共用组件** |
| 9 | `/agents` | `agents` | `AgentsView.vue` | — |
| 10 | `/agent-run` | `agent-run` | `AgentRunView.vue` | **查询参数 `?run=<id>`**（`AgentRunView.vue:63`） |
| 11 | `/mcp` | `mcp-servers` | `MCPServersView.vue` | — |
| 12 | `/mcp/:serverId` | `mcp-server-detail` | `MCPServerDetailView.vue` | 路径参数 `serverId` |
| 13 | `/mcp/:serverId/app` | `mcp-app` | `MCPAppView.vue` | 路径参数 + 查询参数 `projectId` / `agentName` |

路由级事实：
- **零 `meta` 字段、零 `beforeEach` / `beforeEnter` 守卫**（实测 grep）。
- **零路由级懒加载**：13 条路由全部静态 `import`，打进单一 chunk（构建产物只有 1 个 JS chunk：271.44 kB / gzip 86.75 kB）。
- 站内链接方式：`RouterLink` 共 28 处；跨页跳转依赖写死的字符串路径（`WorkflowsView.vue:269` → `/agent-run?run=`，`DeploymentsView.vue:153` → `/workflows/:id`）。

### 4.2 菜单清单（`App.vue:8-17`，共 8 项，**单层扁平**）

| 顺序 | 菜单文案 | 目标路由 | 图标 | 二级菜单 |
| --- | --- | --- | --- | --- |
| 1 | 仪表盘 | `/` | 无 | 无 |
| 2 | 项目 | `/projects` | 无 | 无 |
| 3 | 需求 | `/requirements` | 无 | 无 |
| 4 | 工作流 | `/workflows` | 无 | 无 |
| 5 | 部署 | `/deployments` | 无 | 无 |
| 6 | Agent | `/agents` | 无 | 无 |
| 7 | Agent 运行 | `/agent-run` | 无 | 无 |
| 8 | MCP 服务器 | `/mcp` | 无 | 无 |

- **二级菜单：0；三级菜单：0。** 设计文档列出的全部二级项（项目列表/项目模板/项目归档、工作流列表/运行/模板、任务列表/执行记录/失败任务、Agent 列表/运行/配置、环境管理/部署记录/发布管理）在当前代码中**均不存在**。
- 菜单未覆盖的 5 条路由（项目详情、工作流详情、部署详情、MCP 详情、MCP 应用）仅能通过页面内跳转到达——重构后必须保持这一事实，不得“顺手”加菜单项。
- **菜单文案与 `docs/19-user-manual.md` §4「常用页面」表格一一对应**（该表还额外记录了 `/mcp` 之外的页面用途），任何菜单文案变更需同步该文档（见 §15 P1 风险第 7 条）。

---

## 5. Page Inventory

### 5.1 页面清单（11 个视图文件）

| 页面 | 路由 | 类型 | 行数 | 依赖 store | 直接调用 api | 实时通道 | 表单 | 危险操作 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DashboardView | `/` | Dashboard（只读概览） | 56 | projects | — | — | — | — |
| ProjectsView | `/projects` | 列表 + 内联创建表单 | 121 | projects | — | — | 3 字段 | 删除项目 |
| ProjectDetailView | `/projects/:id` | 详情 | 74 | projects | — | — | — | 删除项目 |
| RequirementsView | `/requirements` | 主从 + 列表 + 详情 + 规格 + Task DAG | 281 | projects, requirements | — | ✅ SSE + 轮询 | 4 字段 | 触发分析 |
| WorkflowsView | `/workflows`、`/workflows/:id` | 列表 + 创建表单 + 详情 + DAG 图 + 审批 | 292 | projects, workflows | `listRequirements` | ✅ SSE + 轮询 | 7 字段 | 取消工作流、拒绝审批 |
| DeploymentsView | `/deployments`、`/deployments/:id` | 配置表单 + 列表 + 详情 + 回滚 | 224 | projects, deployments | — | — | 6 字段 | 回滚部署 |
| AgentsView | `/agents` | 注册表列表 + 详情 | 130 | agents | — | — | — | — |
| AgentRunView | `/agent-run` | 列表 + 创建 + 详情（工具调用/事件/结果） | 233 | agentRuns | — | ✅ SSE + 轮询 | 1 字段 | 取消运行 |
| MCPServersView | `/mcp` | 列表 | 72 | mcp | — | — | — | — |
| MCPServerDetailView | `/mcp/:serverId` | 详情（自研 Tabs：概览/工具/绑定）+ 绑定 CRUD 表单 | 355 | mcp | `listProjects` | — | 4 字段 | 撤销绑定、停用绑定 |
| MCPAppView | `/mcp/:serverId/app` | 沙箱 iframe 应用容器 + 加载表单 | 198 | — | `listMCPApps`、`getMCPUiResource`、`runMCPAppAction` | — | 2 字段 | 经沙箱触发的工具调用 |

### 5.2 按类型统计（依实际代码，不猜测）

| 类型 | 数量 | 页面 |
| --- | --- | --- |
| Dashboard | 1 | DashboardView |
| 列表页 | 7 | Projects、MCPServers 为独立列表页；Requirements（左栏列表）、Workflows（左栏列表）、Deployments（左栏历史）、Agents（左栏注册表）、AgentRun（左栏运行列表）为**主从页面的左栏**而非独立列表页 |
| 详情页 | 6 | ProjectDetail、MCPServerDetail 为独立详情页；Requirements 右栏、Workflows 右栏、Deployments 右栏、Agents 右栏为主从页面的详情区 |
| 配置页 | 3 | DeploymentsView（环境配置表单）、MCPServerDetailView（绑定表单）、MCPAppView（应用加载表单） |
| Workflow 专用 | 1 | WorkflowsView（含工作流图 + 审批面板 + 事件时间线） |
| Agent 专用 | 2 | AgentsView（注册表 + 运行 + 产出物）、AgentRunView（迭代/重试/工具调用/事件/结果） |
| Deployment 专用 | 1 | DeploymentsView（环境、历史、健康检查、CI、日志、回滚） |
| **任务管理页** | **0** | 设计文档要求，代码中不存在（任务仅出现在需求 DAG 与工作流图中） |
| **代码仓库页** | **0** | 设计文档要求，代码中不存在（仓库地址仅为 Project 的字段） |
| **系统设置页** | **0** | 设计文档要求，代码中不存在（MCP 服务器页由 `docs/10-frontend-console.md:62-66` 定义为 Settings 下能力，但菜单文案是「MCP 服务器」且为一级项） |

### 5.3 页面级 UI 事实（决定重构工作量的关键）

- 页面标题统一是 `page-header` + `eyebrow` + `h1` 结构（11/11 页面），但 `eyebrow` 内容多为内部阶段号：`阶段 0`（Dashboard）、`阶段 4`（Workflows）、`阶段 5`（Agents）、`阶段 6`（Deployments）——**面向最终用户暴露了内部阶段编号**，属内容层面待决项（记录，不在此阶段修）。
- 面板结构统一是 `panel` + `panel-header`（h2 + 右侧计数/操作），无 Card 组件。
- 状态展示为 `<span class="status">` 圆角标签 + MCP 专用 `mcp-status-*` / `mcp-risk-*` 变体（共 11 种视觉状态）。
- 空态统一为 `class="empty"`（26 处），加载态为内联 `<p class="state">正在加载…</p>`（10 个视图），错误态为 `.state.error`（10 处）+ `.error-banner`（3 处，**该 class 在 `styles.css` 中根本没有定义**，当前实际渲染为无样式文本）。

---

## 6. API Protection Boundary

### 6.1 API 模块清单（`apps/web/src/api/`，7 个模块 / 47 个导出函数）

| 模块 | 导出函数 | 被谁消费 | 行数 |
| --- | --- | --- | --- |
| `projects.ts` | listProjects / getProject / createProject / deleteProject | stores/projects、MCPServerDetailView（`listProjects`） | 45 |
| `requirements.ts` | createRequirement / listRequirements / getRequirement / analyzeRequirement / listRequirementSpecifications / listRequirementTasks / getTask / getTaskDependencies | stores/requirements、WorkflowsView（`listRequirements`） | 78 |
| `workflows.ts` | createWorkflow / listWorkflows / getWorkflow / workflowAction / listWorkflowTasks / listWorkflowEvents / getWorkflowGraph / listWorkflowApprovals / decideApproval / **openWorkflowStream（SSE）** | stores/workflows | 89 |
| `agentRuns.ts` | createAgentRun / listAgentRuns / getAgentRun / cancelAgentRun / listAgentRunEvents / **openAgentRunStream（SSE）** / runCodingAgentDemo | stores/agentRuns、stores/requirements | 77 |
| `agents.ts` | listAgents / getAgent / getAgentMetrics | stores/agents | 31 |
| `deployments.ts` | listDeployments / getDeployment / listEnvironments / saveEnvironment / rollbackDeployment | stores/deployments | 54 |
| `mcp.ts` | listMCPServers / getMCPServer / listMCPTools / listMCPBindings / createMCPBinding / updateMCPBinding / deleteMCPBinding / listMCPApps / getMCPUiResource / runMCPAppAction | stores/mcp、MCPAppView | 105 |

### 6.2 Protected（重构期间禁止改动）

| 保护对象 | 具体内容 |
| --- | --- |
| 全部 `src/api/**` | 47 个导出函数的签名、路径、方法、请求体形状 |
| 错误语义 | `requestJson` 的 3 类中文错误（`网络请求失败：无法连接后端服务` / `请求失败（HTTP …）` / 后端 `payload.error.message` 原样透出）；这些字符串会出现在页面错误态中 |
| SSE 契约 | `openWorkflowStream` / `openAgentRunStream` 的 `snapshot` 事件名与 JSON 解析 |
| 环境变量 | `VITE_API_BASE_URL`（默认 `http://localhost:3000`，`.env:26`） |
| 源码扫描契约 | `mcpSecurity.test.ts:91-97` 断言 `api/mcp.ts` 必须包含字面量 `/api/mcp/servers` 且必须使用 `` fetch(`${API_BASE_URL}…`) `` —— **任何“统一 requestJson 抽取”都会先破坏该测试** |

### 6.3 记录项（不修复）

- **7 个导出函数在 UI 中零引用**：`getTask`、`getTaskDependencies`、`getWorkflowGraph`、`listWorkflowTasks`、`listWorkflowEvents`、`listWorkflowApprovals`、`listAgentRunEvents`（实测 `stores/`、`views/`、`viewmodels/` 内 0 引用）。属既有死导出面，**本阶段不删除**（规则：不删除现有代码、不做无关重构）。
- `requestJson` 在 7 个模块中重复实现（含同一份中文错误映射），未来可收敛，但属于 API 层改动，**不在 UI 重构范围**。

---

## 7. Store Protection Boundary

### 7.1 Store 清单（7 个，全部 Options API 风格）

| Store | 业务状态 | UI 状态字段 | 动作数 | 单例副作用 | 测试 |
| --- | --- | --- | --- | --- | --- |
| `projects` | projects[]、selectedProject | loading、error | 4 | — | — |
| `requirements` | requirements[]、selectedRequirement、specifications[]、taskGraph、currentAgentRun | loading、detailLoading、creating、analyzing、error | 8 | EventSource + poller | ✅ |
| `workflows` | workflows[]、current | loading、creating、acting、error | 8 | EventSource + poller | ✅ |
| `deployments` | deployments[]、environments[]、current | loading、acting、error | 5 | — | ✅ |
| `agents` | agents[]、current、metrics | loading、error | 2 | — | ✅ |
| `agentRuns` | runs[]、currentRun | loading、detailLoading、creating、cancelling、error | 8 | EventSource + poller | ✅ |
| `mcp` | servers[]、selectedServer、tools[]、bindings[] | loading、error | 5 | — | ✅（含 `__tests__/mcp.test.ts` 160 行） |

### 7.2 分类结论

| 分类 | 内容 | 重构中如何处理 |
| --- | --- | --- |
| **业务状态（Protected）** | 上述所有实体集合、`current/selected*`、`taskGraph`、`specifications`、`bindings`、`metrics` | 只读消费，禁止改字段名/形状/写入时机 |
| **UI 状态（可复用，但本轮不动）** | `loading / detailLoading / creating / acting / analyzing / cancelling / error` 直接内嵌在业务 store 中 | **建议原样复用**；把它们拆到独立 UI store 会改动 7 个 store + 6 个 store 测试，收益低于风险（设计文档 §7 的 “Existing Store → View Adapter → New UI” 已经由 `viewmodels/` 满足） |
| **模块级副作用（Protected）** | 3 个 store 内的 `EventSource` / `setInterval` 单例与 `stopRealtime()` | 禁止移动或改名；新 UI 必须在同样时机调用 `stopRealtime()`（页面卸载） |
| **Store 测试契约** | 6 个测试文件对 action 调用序列、错误文案做断言 | 改 store 前必须先看对应测试（`stores/__tests__/*.test.ts`） |

### 7.3 记录项（不修复）

- 各页面存在**局部 UI 状态与 store UI 状态混用**：例如 `MCPServerDetailView.vue:30-32` 自建 `saving / formError / busyBindingId`，而 `ProjectsView.vue:10-12` 自建 `creating / createError / deletingId`，同时 `workflows`/`requirements` 却把同类状态放在 store 内。这是既有不一致，属 UI 状态落位问题，**重构时保持现状**（若迁移需单独立项）。
- `mcp` store 缺少 `creating` 标志（与其它 store 不一致）；`agentRuns` store 额外暴露 `runDemo`（`stores/agentRuns.ts:169-180`），当前视图未使用。

---

## 8. Permission Protection Boundary

### 8.1 前端权限体系：不存在（实测）

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 路由 meta / 权限元数据 | 无 | `router/index.ts` 13 条路由均无 `meta` |
| 全局守卫 / 路由守卫 | 无 | 全仓无 `beforeEach` / `beforeEnter` |
| 菜单权限过滤 | 无 | `App.vue:8-17` 为静态 8 项 |
| 按钮权限 / 操作权限（前端） | 无 | 全仓无 `permission` / `role` / `auth` 模块 |
| 登录态 / Token | 无（`localStorage` / `cookie` 在 MCP 相关文件中被测试**禁止出现**） | `mcpSecurity.test.ts:55-61` |

唯一的 “permission” 字样是**数据展示字段**：Agent 定义的 `permissions.pathPrefixes` / `permissions.readOnly`（`AgentsView.vue:78-84`）与 MCP App 的 `allowedTools`。

### 8.2 后端权限边界（不在本次范围，但决定了前端红线）

`apps/server/src/app.ts:56-61` 只挂载了 `cors` + `express.json` + `requestLogger`——**控制台没有认证中间件**。权限/审批的真实执行点在 Tool Runtime 与 MCP capability gate（服务端），前端只是“发起方”。

### 8.3 因此，前端“权限保护”= 以下 3 条硬红线

1. **审批流不可旁路**：`WorkflowsView.vue:229-246` 的审批面板必须继续经 `workflows.decide(approvalId, 'approve'|'reject')` 调用 `decideApproval`；`DeploymentsView.vue:214-216` 的“生产部署需已通过人工审批”提示属业务约束，不得因视觉简化删除。
2. **MCP App 沙箱不可放宽**：`MCPAppView.vue:184-191` 的 `:sandbox="MCP_APP_SANDBOX"`（值为 `"allow-scripts"`，定义于 `viewmodels/mcpAppBridge.ts:28`）与 `:srcdoc="srcdoc"` 形态被 `mcpSecurity.test.ts:72-89` 逐字断言；`MCPAppView.vue:63-64` 的 `allowedTools: [appMeta.toolName]` 严格单工具默认值不得放宽为 `undefined`。
3. **条件动作判定函数语义不可变**：`canStart / canPause / canResume`（`viewmodels/workflowViewModel.ts:35-45`）、`canRollback`（`viewmodels/deploymentViewModel.ts:43-45`）、`isActiveRun`（`viewmodels/agentRunViewModel.ts:25-27`）是前端唯一的“操作权限”表达，被单测钉死；新 UI 只能改渲染方式，不能改判定条件。

**Unknown**：仓库代码与文档中均未发现“未来将引入登录/角色/权限体系”的任何痕迹，故本次无法评估前端权限体系的新增需求。

---

## 9. Current UI System

### 9.1 现状定性

- **UI 组件库：无。共享组件：无。** `src/components/` 不存在；11 个视图互不引用。
- **唯一的共享 UI 资产 = 一份全局 CSS 类契约**（`styles.css`，1051 行，全部非 scoped、全部全局有效）。
- **无 Design Token**：颜色全部为硬编码十六进制；无 CSS 变量（`:root` 内只有 `color/background/font-family` 三项）。
- **无图标体系**，**无 aria/role 属性（11 个视图实测 0 处）**，**无 `:focus` 样式规则**（`styles.css` 实测 0 条）。

### 9.2 事实上的“基础组件”（CSS 类契约）

| 类名 | 语义 | 使用次数 | 定义行 |
| --- | --- | --- | --- |
| `.button` + `.primary` / `.subtle` / `.danger` | 按钮三态 | 13 / 10 / 8 | `styles.css:123-158` |
| `.status` + `.status-error` + `mcp-status-*`(7) + `mcp-risk-*`(4) | 状态标签 | 15 处裸用 + 16 个变体类 | `styles.css:568-578, 938-984` |
| `.panel` / `.form-panel` / `.panel-header` | 卡片与表单容器 | 54 / 6 / 25 | `styles.css:167-238` |
| `.empty` / `.compact-empty` | 空态 | 26 | `styles.css:592-596, 580-582` |
| `.state` / `.state.error` | 加载/错误文本 | 9 / 10 | `styles.css:584-590` |
| `.metric` / `.metric-grid` | 指标卡 | 10 / 4 页 | `styles.css:160-190` |
| `.page-header` / `.eyebrow` / `.page` | 页头与页容器 | 11 / 14 / 6 | `styles.css:93-121` |
| `.detail-list` / `.compact-detail-list` | 键值详情表（`dl`） | 4 页 | `styles.css:604-630, 699-706` |
| `.run-list` / `.run-list-item` / `.workflow-list-item` / `.deployment-list-item` | 可选列表项 | 2 / 2 / 2 / 1 | `styles.css:280-299, 344-358, 656-693` |
| `.event-list` / `.event-row` / `.event-timeline` / `.tool-call-list` / `.tool-call-row` | 时间线与行列表 | 3 / 3 / 2 / 2 / 2 | `styles.css:451-478, 708-780` |
| `.workflow-node[data-status]` | 工作流节点状态色（左描边） | 1 | `styles.css:417-438` |
| `.tab-bar` / `.tab` | 自研 Tabs（仅 MCP 详情） | 1 页 | `styles.css:986-1006` |
| `.mcp-app-frame` / `.mcp-app-log` | 沙箱 iframe 与桥接日志 | 1 页 | `styles.css:1039-1051` |
| `.error-banner` | **未定义**（3 处使用，无样式） | 3 | — |

### 9.3 现状色彩/字体/间距（与设计 Token 的差异基线）

- 主色：`.button.primary` = `#1d6fd3`；选中态描边同为 `#1d6fd3`；链接色 `#1d4f91`。**设计主色为 `#6C5CE7`（紫）**。
- Sidebar：`#102033` 深蓝底 + `#d9f275` 亮绿 brand mark（`styles.css:44-70`）；**设计为白底 + 1px 边框、宽 164px**（当前 240px）。
- 页面背景：`#f7f9fb`（设计 `#F6F7FB`，接近）；边框族 `#dde5ee / #d8e1ea / #ccd7e2 / #e2e8ef / #edf1f5`（设计 `#E8EAF0 / #DDE0E8`）。
- 字体：`Inter` 声明但**未加载任何字体文件**（无 `@font-face`、无外部字体链接），实际回退到系统字体。
- 标题：`.page-header h1 { font-size: 32px }`，**设计为 20-24px/600**。
- 间距：以 4px 为基但大量非 4 倍数（`padding: 18px / 14px / 28px / 32px / 24px`，`margin-top: 36px`）——与设计“不要随意产生 17px、19px、23px 等间距”的精神一致但未成体系。
- 圆角：6px / 8px 为主（设计 6 / 8-10 / 12 / 14）。
- 阴影：仅选中态 `inset 3px 0 #1d6fd3`（设计：Card 优先 border 而非阴影，方向一致）。
- 响应式：`@media (max-width: 900px)` **在 `styles.css` 中出现两次**（`:486-534` 与 `:862-901`），且两处规则部分冲突（前者 `.app-shell{display:block}`，后者 `grid-template-columns:1fr`）；另有 `@media (max-width: 800px)`（`:919-923`）。**记录，不修复。**

---

## 10. Design System Gap Analysis

对照 `docs/design/00-design-system.md`、`02-navigation.md`、`03-page-layout.md`、`04-component-system.md`。

| 维度 | Current（现状） | Target（设计） | Gap | Recommended Action | Risk |
| --- | --- | --- | --- | --- | --- |
| **Layout** | `App.vue` 内联 2 列 grid（`240px 1fr`），`.content{padding:32px}`，`max-width:1180px` | AppShell（Sidebar 164px + Header 52px + Main）+ PageContainer（padding 20px，bg #F6F7FB，无固定高度） | **High** | Phase 2 建立 AppShell / PageContainer；页面仅消费，不各自造壳 | Medium（重排 DOM 可能触发实时订阅生命周期问题） |
| **Sidebar** | 深色 `#102033`、240px、8 项无图标、无 hover 规则、无折叠 | 白底、164px、图标+文字统一高度/hover/active（Primary Light 背景 + Primary 文字）、可折叠、Tooltip | **High** | Phase 2 重写为 `AppSidebar`；active 由 Router 状态驱动（`router-link-active` 已是 Router 驱动，方向正确） | Medium（164px 对「MCP 服务器」「Agent 运行」等中文标签偏窄，需参考图确认） |
| **Header** | **不存在** | 52px、白底、下边框；含 Search / System Status / Notification / User | **High（且无数据源）** | 需裁剪到有数据支撑的内容；Search/Notification 属新功能（§20 Q6） | High（若强行补齐则为新功能开发，违反本次范围） |
| **Navigation** | 8 项扁平；无二级/三级；无 Breadcrumb | 8 个一级（含 任务管理/代码仓库/系统设置）+ 二级菜单 + 详情页 Breadcrumb | **High（含产品缺口）** | Phase 2 保持现有 8 项与路由不变；Breadcrumb 仅在详情页新增；二级菜单待 Q3/Q4 决策 | High（菜单项与路由必须 1:1，新增菜单=新增功能） |
| **Typography** | h1 32px；body 14px 基线；`eyebrow` 13px/700/大写；无 type scale | Page Title 20-24/600；Section 15-16/600；Body 13-14/400；Caption 12；Metric 24-28/600 | **Medium** | Phase 1 定义 type scale token；Phase 3 起统一 `PageHeader`/`Card` 标题 | Low（纯视觉） |
| **Color** | 硬编码 hex；主色蓝 `#1d6fd3`；侧栏深蓝+亮绿；无 token | Primary `#6C5CE7` 系列 + 文本/边框/背景语义色 + 低饱和状态色 | **High** | Phase 1 用 Tailwind `@theme` 落地 token；品牌色切换需一次确认（蓝→紫属视觉决策） | Low（视觉）/ Medium（若同时引入 Tailwind 与旧 CSS，需保证旧样式仍生效） |
| **Spacing** | 4px 基础但非体系化（14/18/28/32px 等） | 4/8/12/16/20/24/32/40/48；Page 20、Card 16-20、Section 20-24 | **Medium** | Phase 1 定义间距 token，Phase 3 起在公共组件内统一 | Low |
| **Card** | `.panel` / `.form-panel` 共 54 处，border 8px 圆角，padding 20px | Card：白底 + 1px border + 12px 圆角，无渐变 | **Medium** | Phase 3 建 `Card`（含 `CardHeader`），页面批量替换 | Low（仅结构替换） |
| **Button** | 3 个变体靠 CSS 类；31 处使用；无 icon 支持；无 size | 统一 shadcn-vue Button + AI-SE token；Primary/Secondary/Destructive；同页仅一个 Primary | **Medium** | Phase 3 建 `Button` 包装层；旧 `.button` 类保留到最后一个页面迁完 | Medium（`disabled` 与 loading 文案切换逻辑必须保留，见 §15 P1） |
| **Form** | 原生 `input/select/textarea` + `label>span` 结构；22 处原生校验属性；7 个文件用 `.stacked-form` | Label 清晰、必填明确、错误紧邻字段、提交按钮统一、**不改变业务校验规则** | **Medium** | Phase 3 建 `FormField`/`Input`/`Select` 包装并**透传 required/maxlength/min/max/type** | **High**（丢属性=静默改变校验行为） |
| **Table** | **完全不存在 `<table>`**；列表用 `ul/li` + `dl` | DataTable（列/行/排序/选择/loading/empty/分页钩子）；表头弱化、行高稳定、操作列靠右、长文本 ellipsis | **High（但需先决策）** | 建议**不引入 DataTable 基础组件**（0 处使用，改造成表格=结构重写）；保留列表语义，仅统一列表项样式 | High（若强行表格化，回归面覆盖 6 个主页面） |
| **Dialog** | **无 Dialog 组件**；3 处 `window.confirm`（ProjectsView:44、ProjectDetailView:23、MCPServerDetailView:88） | 统一 Dialog，危险操作用 destructive variant，按钮文案「取消 / 确认删除」 | **Medium** | Phase 3 建 `ConfirmDialog`，替代 `window.confirm`（注意：`window.confirm` 为同步阻塞，替换为异步后须保持原有 await 流程语义） | Medium |
| **Drawer** | **不存在** | 任务详情 / Agent Run / Tool Call / 执行日志 / 项目快速详情 | **High（新能力）** | 建议**暂不引入**（当前详情均已在页内呈现，引入 Drawer 属交互重构而非视觉重构）；如需则单独立项 | High |
| **Status** | 15 处裸 `.status` + 16 个 MCP 变体类，映射逻辑散落 viewmodels | 统一 `StatusBadge`，负责 status → visual mapping，覆盖 success/running/pending/warning/error/disabled | **Medium** | Phase 3 建 `StatusBadge`，输入为语义状态 + 文案；**标签文案继续来自 viewmodels**（不得在组件内重写映射） | Medium（标签映射是测试钉死区） |
| **Loading** | 内联 `<p class="state">正在加载…</p>`（10 个视图）；按钮用 `xxxing ? "创建中…" : "创建"` | 首屏优先 Skeleton；按钮 Loading + Disabled；长任务显示状态/阶段/进度/日志/停止 | **Medium** | Phase 3 建 `LoadingState`（Skeleton 变体可选）；按钮 loading 形态在 `Button` 内统一 | Low |
| **Empty** | `class="empty"` 26 处，纯文本（多为「暂无 X。」） | Icon + Title + Description + Action | **Medium** | Phase 3 建 `EmptyState`；**不得为凑 UI 添加原本没有的操作按钮** | Low |
| **Error** | `.state.error` 10 处 + 未定义的 `.error-banner` 3 处 | 清晰可懂、不泄露敏感信息、适用时提供重试 | **Medium** | Phase 3 建 `ErrorState`（可选重试回调）；修复 `.error-banner` 无定义问题（属视觉缺陷修复，非业务变更） | Low |
| **Responsive** | 两个冲突的 900px 媒体查询 + 一个 800px；设计目标为 1440/1280/1024 | 桌面优先；Dashboard Grid 自动换行；Table 横向滚动；Sidebar 可折叠；禁止大量 absolute | **Medium** | Phase 2 在 AppShell 内重建断点体系，页面逐步替换；删除旧媒体查询必须等最后一个消费页面迁完 | Medium（断点交叉期可能出现双重样式） |
| **Icons** | **零图标** | Lucide（线性、16-20px、单一图标体系、stroke 一致） | **High（从零建立）** | Phase 1 引入 `@lucide/vue`；Phase 2/3 在 Sidebar、Button、EmptyState、StatusBadge 中首次落地 | Low |

---

## 11. Tailwind CSS Integration Assessment

### 11.1 现状

**未接入**：全仓（排除 `node_modules`）无 `tailwind.config.*`、无 `postcss.config.*`、无 `components.json`；`apps/web/package.json` 无 tailwind 相关依赖。**本次未安装任何依赖。**

### 11.2 接入可行性（已用 registry 元数据核实，非推测）

| 依赖 | 版本（latest） | 与现状兼容性 |
| --- | --- | --- |
| `tailwindcss` | **4.3.3** | 设计文档要求 Tailwind 4，一致 |
| `@tailwindcss/vite` | **4.3.3** | peerDependencies: `vite: ^5.2.0 \|\| ^6 \|\| ^7 \|\| ^8` → **本仓库 Vite 8.2.2 受支持**（已核实，非猜测） |

Tailwind 4 为 CSS-first：**不需要** `tailwind.config.js`，也**不需要** `postcss.config.js`；token 通过 CSS `@theme` 定义。因此接入面很小：vite 插件 + CSS 入口 + 路径别名。

### 11.3 需要改动的文件（Phase 1 提案，本次未改）

| 文件 | 改动 | 风险 |
| --- | --- | --- |
| `apps/web/package.json` | 新增 devDependencies：`tailwindcss`、`@tailwindcss/vite`（版本与仓库 pin 风格一致） | Low |
| `apps/web/vite.config.ts` | 增加 `@tailwindcss/vite` 插件；增加 `@ → src` 别名 | Medium（别名解析影响全部导入） |
| `apps/web/tsconfig.json` | 增加 `baseUrl` + `paths`（`@/*`）以匹配别名 | Low |
| `apps/web/src/styles/app.css`（新建） | `@import "tailwindcss";` + `@theme` 定义 AI-SE token | Low |
| `apps/web/src/main.ts` | **导入顺序**：先 `styles/app.css`（Tailwind），后 `styles.css`（旧样式） | **Medium——顺序决定谁胜出** |
| 页面文件 | **本阶段零改动** | — |

### 11.4 冲突分析（逐项核实）

| # | 冲突类型 | 实际情况 | 结论 |
| --- | --- | --- | --- |
| 1 | 全局 CSS 冲突 | `styles.css` 的全局规则仅 4 条：`*{box-sizing}`、`body{margin:0}`、`a{color;text-decoration}`、`button,input,select,textarea{font:inherit}` | Tailwind Preflight 也做同样重置，语义兼容；唯一分歧是 `a` 的颜色（Preflight 设为 `inherit`），靠**导入顺序**解决（旧 CSS 在后，继续胜出） |
| 2 | 类名冲突 | 实测旧类名集合（panel / empty / state / status / button / page / content / nav / sidebar / brand / metric / eyebrow / tab / run-layout / detail-list …）与 Tailwind 工具类名**零重叠** | 无冲突。可安全共存 |
| 3 | scoped / unscoped 冲突 | 当前**零 scoped 样式**（11 个视图均无 `<style>` 块），全部全局 | 不存在 scoped 冲突；新组件建议用 Tailwind 原子类而非新增全局类 |
| 4 | Element Plus 等 UI 框架冲突 | **仓库中不存在任何第三方 UI 组件库**（唯一样式表就是 `styles.css`，且 `main.ts` 只导入这一份 CSS） | 该风险在本仓库不适用 |
| 5 | **Preflight 会改变现有渲染的地方（真实风险）** | Preflight 会把 `h1-h6` 的 font-size/weight 重置为 `inherit`。当前 `.panel-header h2`、`.agent-detail-column h2`、`.mcp-summary + h2` 等**依赖 UA 默认字号**（`styles.css` 只写了 `margin: 0`，未定义字号）→ 启用 Preflight 后所有面板标题会突然变小变细 | **必须处理**：在 Phase 1 为面板 h2 补显式字号/字重（属视觉补偿，不是业务变更），或先以 `layer` 隔离 Preflight |
| 6 | 列表/表单元素重置 | Preflight 移除 `ul/ol` 的 list-style 与 margin、移除 `pre`/`blockquote` margin、移除按钮默认样式。实测：所有 `ul/ol` 已显式 `list-style:none`；`.button`/`.tab`/`*-list-item` 均已显式定义 background/border | 无实际破坏（仅 `.mcp-app-log` 等少数字号需复核） |
| 7 | 样式泄漏 | 旧体系全部全局；新体系为原子类（天然全局但语义唯一） | 泄漏风险 Low；禁止在新组件里写新的全局类选择器 |
| 8 | 浏览器支持面 | Tailwind 4 依赖现代浏览器特性（`@property`、`color-mix()` 等） | **Unknown**：需确认目标浏览器基线（当前 `index.html` 无 browserslist/target 声明） |

### 11.5 共存判定与迁移策略

**判定：Tailwind 4 + shadcn-vue + 现有 CSS 体系可以共存**，前提是遵守：

1. **单一导入顺序契约**：`app.css`（Tailwind + token）在前，`styles.css`（遗留）在后 → 迁移期遗留样式永远胜出，页面视觉不会“突然变化”。
2. **逐页迁移、逐页删除**：只在某个页面完成重构且验证通过后，才允许删除该页面专用的遗留类；全局类（`.button`/`.status`/`.panel`…）必须等**最后一个消费者**迁完再删（Phase 11）。
3. **不做大爆炸重写**（违反 `01-refactoring-rules.md` §11）。
4. Preflight 影响面必须先修（第 5 项），否则 Phase 1 就会出现“全站面板标题变小”的视觉回归。

---

## 12. shadcn-vue Integration Assessment

### 12.1 现状与接入前置

- 仓库中**没有任何** shadcn-vue / Reka UI 组件；也没可复用的自有组件（`components/` 不存在）。
- 接入所需（依据 shadcn-vue 官方 Vite 安装流程与 registry 元数据核实）：

| 依赖 | 版本 | 兼容性 |
| --- | --- | --- |
| `reka-ui` | 2.10.4 | peer `vue: >= 3.4.0`；本仓库 Vue 3.5.42 ✅ |
| `@lucide/vue` | 1.46.0 | peer `vue: >= 3.0.1` ✅（注意：旧包名 `lucide-vue-next` 现也发布为 1.0.0，需二选一并统一） |
| `tailwind-merge` | 3.7.0 | 无 peer 限制 ✅ |
| `clsx` | 2.1.1 | ✅ |
| `class-variance-authority` | 0.7.1 | ✅ |
| `tw-animate-css` | 1.4.0 | ✅ |
| `shadcn-vue`（CLI） | 2.8.2 | 仅用于生成组件源码，**不是运行时依赖** |

- 需要 `components.json` 与 `@/*` 别名（当前**不存在** `@` 别名）。
- shadcn-vue 组件是**复制进源码**（copy-in），因此组件本身会被 `mcpSecurity.test.ts` 的全文扫描覆盖——需确认生成组件不含被禁字面量（`allow-same-origin`、`callTool(` 等）；预判风险 Low（生成组件为纯 UI），但**必须在 Phase 1 跑一次 `test` 验证**。
- shadcn-vue 组件集齐全（含 Sidebar / Data Table / Sheet / Sonner / Breadcrumb / Empty / Spinner / Field / Pagination），覆盖设计文档 §2 要求的全部 primitive。

### 12.2 BLOCKER：默认目录与 AGENTS.md 冲突

shadcn-vue 默认把工具函数放在 `aliases.utils = "@/lib/utils"`；AGENTS.md §5 明文禁止为规避目录缺失而另立 `shared/`、`lib/`、`helpers/` 等名目。**因此 `cn()` 的落位必须先由用户裁决**（§20 Q1），否则 `shadcn-vue init` 会直接生成一个违反仓库结构规则的目录。

### 12.3 逐组件建议（Reuse / Wrap / Replace）

现状为“**零现成组件**”，所以不存在“复用旧组件”的选项；真正的决策是**旧 CSS 类契约如何退场**。

| 需求组件 | 现状实现 | 建议 | 具体做法 | 风险 |
| --- | --- | --- | --- | --- |
| Button | `.button`(.primary/.subtle/.danger)，31 处 | **Replace（新建 primitive）；旧类 Wrap 保留** | 新建 `components/ui/button` 包装 shadcn-vue Button；迁移期旧页面继续用 `.button` 类；`Button` 内置 loading+disabled 形态（替换 `xxxing ? "…中" : "…"` 模式） | Medium |
| Input | 原生 `input`（`.form-panel input` 样式） | **Replace + 属性透传** | `components/ui/input` 必须透传 `required / maxlength / type / placeholder / v-model` | **High**（校验语义） |
| Select | 原生 `select`（7 个视图，含 `<option>` 枚举） | **Wrap（倾向保留原生）** | 首选 "Native Select" primitive（shadcn-vue 提供）以避免下拉行为变化；非必要不换成 Reka Select | Medium |
| Dialog | 无（3 处 `window.confirm`） | **Replace** | `ConfirmDialog`（基于 shadcn-vue Dialog）；保留原确认文案与「危险操作」语义 | Medium |
| Drawer | 无 | **Not now** | 当前无 Drawer 场景；引入即交互重构，建议延后单独立项 | High |
| Tabs | 自研 `.tab-bar/.tab`（仅 MCPServerDetailView） | **Wrap** | 用 shadcn-vue Tabs 替换该页自研实现（1 处使用，不建公共层） | Low |
| Dropdown | 无 | **Not now** | 无场景（无行内操作菜单） | Low |
| Tooltip | 无（`title` 属性 1 处：MCPServersView:61） | **Wrap（按需）** | 仅在 Sidebar 折叠态（设计要求 Tooltip 显示菜单名）与截断文本处使用 | Low |
| Table | **不存在**（列表用 `ul/li`） | **Not now** | 见 §10 Table 行；不建议把 6 个列表页改造成表格 | High |
| Badge/StatusBadge | `.status` + 16 个 MCP 变体类 | **Replace** | `StatusBadge` 负责 status→visual，文案仍由 viewmodels 提供 | Medium |
| Skeleton | 无（纯文本加载态） | **Replace（可选）** | 首屏用 Skeleton；长任务保留文本阶段显示 | Low |
| Card | `.panel`（54 处） | **Replace** | `Card`/`CardHeader`；与 `.panel` 并存至最后一页迁完 | Low |
| Breadcrumb | 无 | **New（设计要求）** | 仅详情页（项目/工作流/部署/MCP 详情）使用，链接目标必须是已存在路由 | Low |
| Toast | 无（错误内联在页面） | **Evaluate** | 设计要求保存/删除/部署成功用 Toast；引入需新增全局容器（不涉业务逻辑）。建议**延后到 Phase 12 视觉 QA 前评估** | Medium |
| Pagination / SearchInput / FilterBar | **完全不存在** | **Not now** | 0 处使用；按 1/2/3 复用规则不应预先抽象（设计要求的分页/筛选属新功能） | High（若强行引入=新功能） |

---

## 13. Component Refactoring Opportunities

扫描依据：11 个视图的实际 class 使用计数（实测 grep）。遵循 `1 处 → 页面局部；2 处 → 评估；3+ 处 → 强烈建议抽取`。

| Component | Existing Locations（实测计数） | Duplication Level | Recommended New Shared Component | Migration Difficulty |
| --- | --- | --- | --- | --- |
| **PageHeader** | 11/11 视图（`class="page-header"` 每页 1 处；`eyebrow` 14 处） | **Very High（11）** | ✅ `PageHeader`（Title + Description + Actions + 可选 Breadcrumb） | Low（纯标记替换） |
| **Card / Panel** | `class="panel` 54 处 / 9 文件（含 `panel-header` 25 处 / 6 文件） | **Very High（54）** | ✅ `Card` + `CardHeader`（替代 `.panel`/`.panel-header`） | Low |
| **EmptyState** | `class="empty"` 26 处 / 11 文件（含 `compact-empty` 10 处） | **Very High（26）** | ✅ `EmptyState`（Icon + Title + Description；**不新增原没有的操作按钮**） | Low |
| **StatusBadge** | 裸 `.status` 15 处 / 7 文件 + `mcp-status-*` 7 种 + `mcp-risk-*` 4 种 | **Very High（15+）** | ✅ `StatusBadge`（语义色映射；文案继续由 viewmodels 提供） | Medium（映射被测试钉死） |
| **ErrorState** | `.state.error` 10 处 / 8 文件 + `.error-banner` 3 处 / 3 文件（**后者无 CSS 定义**） | **High（13）** | ✅ `ErrorState`（含可选 retry） | Low |
| **LoadingState** | 内联加载文案 10 个视图（`正在加载…` / `加载中…`） | **High（10）** | ✅ `LoadingState`（文本 + 可选 Skeleton 变体） | Low |
| **MetricCard** | `class="metric"` 10 处 / 4 文件（Dashboard、Requirements、AgentRun、Agents） | **High（10）** | ✅ `MetricCard`（label + value） | Low |
| **Button** | `.button` 31 处（primary 13 / subtle 10 / danger 8）/ 10 文件 | **High（31）** | ✅ `Button`（包装 shadcn-vue，保留 loading+disabled 语义） | Medium |
| **FormField** | `<label>` 结构 28 处 / 7 文件（`.form-panel` 5 文件、`.stacked-form` 6 文件） | **High（28）** | ✅ `FormField`（label + 必填标记 + 错误位，**透传原生校验属性**） | **High**（校验语义） |
| **ConfirmDialog** | `window.confirm` 3 处（ProjectsView:44、ProjectDetailView:23、MCPServerDetailView:88） | Medium（3） | ✅ `ConfirmDialog` | Medium（同步→异步流程） |
| **DetailList** | `class="detail-list"` 4 处 / 4 文件（Project/Agent/AgentRun/Requirements） | Medium（4） | ✅ `DetailList`（`dl` 键值对，紧凑变体） | Low |
| **Split/MasterDetail 布局** | 8 文件各有一套 grid（`two-column` / `run-layout` / `workflow-layout` / `deployment-layout` / `agent-registry-layout` / `detail-grid`） | Medium（8，但列宽各不相同） | ⚠️ 评估：先建 `PageLayout` 双栏容器（可配置列宽），**不强行统一列宽** | Medium |
| **ListSelectItem** | `workflow-list-item`（2 页）、`run-list-item`（2 页）、`deployment-list-item`（1 页）——同一模式 5 处 | Medium（5） | ⚠️ 评估：可建 `ListSelectItem`（active 描边 + 主副文本） | Medium |
| **EventRow / TimelineRow** | `event-row` 3 页、`tool-call-row` 2 页、`event-timeline li` 2 页 | Medium（7，结构相近但字段不同） | ⚠️ 评估：先不抽象；若 Phase 6-8 出现第 4 个消费者再做 | Medium |
| **TabBar** | 1 页（MCPServerDetailView） | Low（1） | ❌ 页面局部（或直接用 shadcn-vue Tabs） | Low |
| **DataTable** | **0 处**（无 `<table>`） | None | ❌ **不建**（按 1/2/3 规则，0 处更不该建；且改造=结构重写） | High |
| **FilterBar / SearchInput / Pagination** | **0 处**（全仓无搜索框、无分页控件） | None | ❌ **不建**（属新功能） | High |
| **Breadcrumb** | 0 处（设计要求） | None | ✅ 新建（仅详情页；链接必须指向已存在路由） | Low |

**不为了抽象而抽象的结论**：必须建的是 PageHeader、Card、EmptyState、StatusBadge、ErrorState、LoadingState、MetricCard、Button、FormField、ConfirmDialog、DetailList（均 ≥3 处）；Bundle 类（Split 布局、ListSelectItem、EventRow）建议先做 1 个消费者、观察后再抽；DataTable / FilterBar / SearchInput / Pagination **明确不建**。

---

## 14. Page Refactoring Priority

评分维度：Business Importance（业务重要性）、Visual Importance（视觉重要性）、Component Reuse（可复用产出）、Implementation Difficulty（实现难度，越高越难）、Regression Risk（回归风险）。优先级按“**先建立可复用底座 → 再拿低风险页面校准视觉 → 最后碰高危流程**”排序。

| 优先级 | 页面 / 对象 | Business | Visual | Reuse | Difficulty | Regression Risk | 排序理由 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **P0** | **AppShell（App.vue + 新 Sidebar/Header/Container）** | 高（全站外壳） | 极高（设计第一验收项） | 极高（所有页面依赖） | 低（24 行现有实现） | 中（涉及实时订阅生命周期与滚动容器） | 一切页面的前置；不先做则后续每页都要重复造壳 |
| **P0** | **DashboardView（`/`）** | 中（只读概览，仅 1 个 store） | 极高（首屏第一印象） | 高（MetricCard/EmptyState/Card 首选落地页） | 低（56 行、无表单、无危险操作） | **低**（只读 + 1 个跳转链接） | 视觉校准的理想靶（零业务风险） |
| **P1** | **ProjectsView + ProjectDetailView（`/projects`、`/projects/:id`）** | 高（唯一完整 CRUD） | 高（列表页模板） | 极高（List 模板 + Form + ConfirmDialog 首用） | 中 | 中（创建/删除） | 一旦定稿即为其余列表页模板 |
| **P1** | **WorkflowsView（`/workflows`、`/workflows/:id`）** | **极高（平台核心）** | 高（工作流图 + 审批） | 高（节点卡/时间线/动作条） | High（292 行、SSE+轮询、7 字段表单、3 类动作、审批） | **High** | 核心流程，必须在公共组件与列表模板稳定后再动 |
| **P1** | **RequirementsView（`/requirements`）** | 高（PRD→分析→规格→DAG 主链路） | 中 | 高（主从布局 + 规格/ DAG 展示） | High（281 行、SSE、4 个面板） | High | 与 Workflows 同属核心链路，两者择一先做；建议先 Workflows（复用面更广） |
| **P2** | **AgentRunView（`/agent-run`）** | 高（Agent 执行可观测） | 中高 | 中（工具调用行/事件行） | 中高（233 行、SSE、取消动作） | 中 | 依赖 Agent 与工作流的视觉语言先定 |
| **P2** | **AgentsView（`/agents`）** | 中 | 中 | 中（注册表列表 + 指标 + 运行/产出物列表） | 低（130 行，只读） | **低** | 低风险，可作为“只读页”第二次校准 |
| **P2** | **DeploymentsView（`/deployments`、`/deployments/:id`）** | 高（交付与回滚） | 中高 | 中（环境表单 + 历史列表 + 日志时间线） | High（224 行、6 字段表单、回滚、生产审批提示） | **High** | 回滚属不可逆操作，需最后一批处理 |
| **P3** | **MCPServerDetailView（`/mcp/:serverId`）** | 中（治理能力） | 中 | 中（Tabs 首用 + 绑定 CRUD） | 中高（355 行、3 个 Tab、绑定增删改） | 中 | 绑定撤销会影响 Agent 调用权限，需谨慎 |
| **P3** | **MCPServersView（`/mcp`）** | 低 | 低 | 低（纯列表） | 低（72 行） | **低** | 最低优先级，可随时穿插 |
| **P3** | **MCPAppView（`/mcp/:serverId/app`）** | 中（沙箱应用容器） | 低（iframe 为主） | 低 | 中（198 行、postMessage 桥） | **High（安全契约）** | 视觉收益最小、安全契约最敏感 → **最后一个动**（或经评估后保持现状，仅统一外框样式） |

**不建议的排序**：不要从“工作流/部署”这类核心高危页面开始（对齐 `01-refactoring-rules.md` §11 的逐域推进要求）。

---

## 15. Risk Assessment

### 15.1 P0 Risk（可能导致业务不可用）

| # | 风险 | 证据 | 触发条件 | 缓解 |
| --- | --- | --- | --- | --- |
| P0-1 | **API 契约破坏** | 47 个导出函数横跨 7 模块；页面错误文案直接来自 `requestJson`（`api/*.ts` 各一份） | 任何“顺手”统一 `requestJson`、改路径/参数/返回处理 | 冻结 `src/api/**`；`mcpSecurity.test.ts:91-97` 已钉死 `api/mcp.ts` 的 fetch 形态 |
| P0-2 | **路由破坏** | 13 条路由 + 路由名/路径被站内硬编码引用（`WorkflowsView.vue:269` → `/agent-run?run=`；`DeploymentsView.vue:153` → `/workflows/:id`；`/mcp/:serverId/app?projectId&agentName`） | 重命名路由、改参数结构、引入懒加载时改写组件导入路径 | 路径/名称/参数一律冻结；只允许改 `component` 的视觉实现 |
| P0-3 | **实时通道泄漏/重复订阅** | 3 个 store 各持模块级 `EventSource` + 2s 轮询器，靠页面 `onUnmounted` 调用 `stopRealtime()`（`AgentRunView.vue:66-68`、`RequirementsView.vue:91-93`、`WorkflowsView.vue:71`） | AppShell 引入 `keep-alive`、路由过渡、或拆分组件使卸载时机变化 | Phase 2 明确禁止 `keep-alive`；每页迁移后回归验证「离开页面 3 秒内不再有新请求」 |
| P0-4 | **权限/审批被绕过** | 审批面板 `WorkflowsView.vue:229-246`；生产审批提示 `DeploymentsView.vue:214-216`；MCP App `allowedTools` 严格默认 `MCPAppView.vue:63-64` | 重排/美化时删掉“多余”的条件判断或提示文案 | 见 §8 三条红线；MCP App 相关改动必须跑 `mcpSecurity.test.ts` |
| P0-5 | **Store 契约破坏** | 6 个 store 测试文件断言 action 行为与错误文案 | 顺手重构 store（改名/合并 UI 状态/搬移实时逻辑） | Store 只读消费；改动前先读对应 `stores/__tests__/*.test.ts` |
| P0-6 | **MCP App 沙箱弱化** | `mcpSecurity.test.ts:72-89` 逐字断言 `:sandbox="MCP_APP_SANDBOX"`、`:srcdoc="srcdoc"`、`MCP_APP_SANDBOX = "allow-scripts"`，并禁止 `allow-same-origin` / `allow-top-navigation` / `allow-popups` 出现在生产文件 | 用新 Dialog/Drawer/美观 iframe 包装时放宽 sandbox | 保持常量与绑定形态不变；Phase 10 验证时完整跑安全测试 |

### 15.2 P1 Risk（可能导致页面功能异常）

| # | 风险 | 证据 | 缓解 |
| --- | --- | --- | --- |
| P1-1 | **表单校验行为改变** | 22 处原生校验属性：`ProjectsView`(5)、`RequirementsView`(3)、`WorkflowsView`(5)、`DeploymentsView`(5，含 `min=1 max=65535`)、`MCPAppView`(2)、`MCPServerDetailView`(1)、`AgentRunView`(1) | 新 `Input`/`Select`/`FormField` 必须 `v-bind="$attrs"` 透传 `required/maxlength/min/max/type/step`；每页回归时逐字段核对 |
| P1-2 | **按钮可用性语义丢失** | 大量 `:disabled="creating \| acting \| analyzing \| saving \| busyBindingId === …"`；文案切换 `xxxing ? "…中" : "…"` | `Button` 组件内置 `loading` + `disabled`，禁止页面自行用 CSS 模拟禁用 |
| P1-3 | **确认流程改变** | 3 处同步 `window.confirm`（含 MCPServerDetailView 的安全文案「撤销后 Agent 调用将立即被拒绝」） | `ConfirmDialog` 必须 async/await 语义等价；文案原样保留 |
| P1-4 | **标签文案漂移（中文单语 UI）** | 8 个 viewmodel 提供中英映射；14 个测试文件对文案做精确断言；`docs/19-user-manual.md` 与菜单文案镜像 | 组件内部**不得**重新实现标签映射；改文案必须同步改对应测试 + 用户手册 |
| P1-5 | **列表/滚动容器行为变化** | `.result-block{max-height:220px;overflow:auto}`、`.mcp-app-frame{min-height:420px}`、工作流图 `auto-fill minmax(210px,1fr)` | 布局容器保持可滚动/自适应；不使用固定高度（设计要求亦禁止固定高度） |
| P1-6 | **长任务可观测性退化** | AgentRun/Workflow 依赖「状态 + 迭代 + 重试 + 工具调用 + 事件」密集信息 | 视觉重构不得删减字段（设计要求 §10 明确列出这些必须有） |
| P1-7 | **文档-UI 不一致** | `docs/19-user-manual.md:188-195` 页面表 + §5+ 操作步骤（含按钮名「批准」「拒绝」「目标仓库路径」） | 任何可见文案变更同步更新该文档 |
| P1-8 | **源码扫描测试被自我污染** | `mcpSecurity.test.ts:34-36` 只按**文件名含 mcp** 过滤生产文件；新增 `components/` 文件若命名含 `mcp` 会被纳入“禁止 localStorage/cookie/credential 字样”的扫描 | 新增组件避免在文件名/注释中出现被禁字面量 |

### 15.3 P2 Risk（视觉问题）

| # | 风险 | 证据 | 缓解 |
| --- | --- | --- | --- |
| P2-1 | **Preflight 全局重置** | 面板 `h2` 依赖 UA 默认字号（`styles.css:105-109` 仅设 `margin:0`） | Phase 1 先补齐显式字号再启用 Preflight（§11.4 #5） |
| P2-2 | **双重媒体查询交叉期** | `styles.css` 内两个冲突的 `900px` 块（`:486-534`、`:862-901`）+ 一个 `800px` 块 | 逐页迁移时按页面删除旧规则；删除前 grep 确认零引用 |
| P2-3 | **响应式回归** | 当前仅验过 800/900px 两档；设计要 1440/1280/1024 | Phase 12 三档截图核对（无横向溢出、Grid 换行、Dialog 可用、按钮不被遮挡） |
| P2-4 | **样式泄漏** | 旧体系全全局 | 新组件禁用全局元素选择器；新增样式一律 Tailwind 原子类 |
| P2-5 | **色彩切换的观感断层** | 主色由蓝 `#1d6fd3` 变紫 `#6C5CE7`，Sidebar 由深色变白 | 需一次性确认（§20 Q7）；交叉期不同页面主色不一致是**预期内**现象，Phase 12 统一收口 |
| P2-6 | **字体未真正生效** | 声明 `Inter` 但无字体文件/链接 | Phase 1 决策：加载 Inter（新增静态资源）或改用系统字体栈（与设计「默认使用系统无衬线字体」一致 → 建议后者） |

---

## 16. Recommended Target Architecture

### 16.1 对提案架构的评估

设计文档/任务书中提出的分层：

```
Existing Business Layer (API / Store / Router / Business Logic)
        ↓ Adapter / Composable
        ↓ AI-SE Components
        ↓ shadcn-vue / Reka UI
        ↓ Tailwind CSS
```

**结论：结构方向正确，但本仓库有一处需要修正——不要新增第二套 “Adapter” 层。**

理由（代码事实）：

- `viewmodels/*.ts` **已经是** Adapter/ViewModel 层：8 个文件提供标签映射、格式化、条件判定、工作流路径归一化，并被 9 个测试文件覆盖（`docs/design/04-component-system.md` §17 的 “Page → Composable/Store → API” 实际已由 `views → viewmodels/stores → api` 满足）。
- 再引入一层 “Adapter/Composable” 会与 AGENTS.md §5 的既定分层（`components/`、`composables/`、`viewmodels/`）产生职责重叠，并诱发对 store 的重复包装（P0-5 风险）。

### 16.2 建议的目标结构（Minimum Change）

```
apps/web/src/
  api/            （冻结，不改）
  stores/         （冻结，不改）
  viewmodels/     （= 现有 Adapter/ViewModel 层；仅在确有必要时新增纯展示函数，并带测试）
  views/          （页面；逐页重构，保持每页一个入口文件）
  components/
    ui/           （shadcn-vue primitives 的薄包装：Button/Input/Select/Dialog/Tabs/Tooltip/Badge/Skeleton…）
    shell/        （AppShell / AppSidebar / AppHeader / PageContainer）
    common/       （AI-SE 公共组件：PageHeader / Card / StatusBadge / EmptyState / LoadingState / ErrorState /
                    MetricCard / ConfirmDialog / DetailList / FormField / Breadcrumb）
    business/     （可选，仅当 2+ 页面复用：WorkflowNode / AgentRunRow / DeploymentHistoryItem 等）
  composables/    （仅 UI 壳层逻辑：useSidebarCollapsed / useToast / useConfirm；不承载业务规则）
  types/ constants/（被 2+ 处引用才迁入，见 AGENTS.md §5）
  styles/
    app.css       （Tailwind 入口 + @theme tokens）
  styles.css      （遗留样式，逐页退役，Phase 11 收口）
```

数据流（重构后保持不变的部分用实线说明）：

```
views/*.vue ──▶ stores/*.ts ──▶ api/*.ts ──▶ 后端 REST            （完全不变）
views/*.vue ──▶ viewmodels/*.ts                                   （不变，仍是唯一展示逻辑层）
views/*.vue ──▶ components/common|ui ──▶ shadcn-vue/Reka ──▶ Tailwind（新增，仅渲染层）
```

### 16.3 明确不做（Do Not）

1. 不引入第二套状态管理/Adapter/Permission/错误码体系。
2. 不改 `api/`、`stores/`、`router/` 的对外契约。
3. 不引入 DataTable/FilterBar/Pagination/Drawer 等**当前零使用**的新功能型组件。
4. 不新增菜单项、路由、页面（除非用户明确授权产品范围变更）。
5. 不删除既有 CSS 类，直到其最后一个消费者迁完。
6. 不使用 `keep-alive` 或任何改变视图挂载/卸载时机的路由机制。

---

## 17. Migration Plan

阶段划分依据实际代码调整（**原提案的 任务管理 / 代码仓库 / 系统设置 三个阶段被移除**，因为对应页面不存在；MCP 三页合并为一阶段；新增“遗留 CSS 退役”收口阶段）。

### Phase 0 — Baseline Freeze

- **Goal**：冻结本次评估测得的基线作为后续每阶段回归的比较基准。
- **Files**：`docs/60-frontend-refactoring-assessment.md`（本报告，仅新增文档）；代码 **0 改动**。
- **Components**：无。
- **Dependencies**：无。
- **API Impact**：无。**Route Impact**：无。**Store Impact**：无。**Permission Impact**：无。
- **Risk**：Low（纯记录）。
- **Validation**：`corepack pnpm --filter @ai-se/web typecheck && lint && test && build`；记录 15 文件/53 用例、13 路由、11 页面、8 菜单、47 API、7 store。
- **Definition of Done**：基线数字写入文档，且与本次实测一致。

### Phase 1 — Tailwind CSS 4 + Design Token

- **Goal**：建立 Tailwind 4 + AI-SE token 层，**不改任何页面**；确保接入后视觉与当前完全一致（Preflight 补偿到位）。
- **Files**：`apps/web/package.json`、`apps/web/vite.config.ts`、`apps/web/tsconfig.json`、新建 `apps/web/src/styles/app.css`、`apps/web/src/main.ts`（导入顺序）。0 个 `views/*.vue`。
- **Components**：无（仅 token 与工具函数 `cn()`）。
- **Dependencies**：`tailwindcss@4`、`@tailwindcss/vite@4`；`cn()` 落位需先决（§20 Q1）。
- **API Impact**：无。**Route Impact**：无。**Store Impact**：无。**Permission Impact**：无。
- **Risk**：Medium（Preflight 全局重置；导入顺序决定旧样式是否继续胜出）。
- **Validation**：`typecheck` / `lint` / `test`（含 `mcpSecurity.test.ts`）/ `build` 全绿 + 三档视口人工比对接入前后截图一致。
- **Definition of Done**：无任何页面文件被改动；构建产物正常；token（color/typography/spacing/radius）在 `@theme` 中可用；`docs/` 记录导入顺序契约。

### Phase 2 — AppShell

- **Goal**：把 `App.vue` 内联 sidebar 替换为 `AppShell + AppSidebar + AppHeader + PageContainer`；菜单仍为现有 8 项、路由不变；Header 内容按 Q6 决策裁剪。
- **Files**：`App.vue`、新建 `components/shell/*`（3-4 文件）、`styles.css`（仅追加/不改旧类）。
- **Components**：AppShell、AppSidebar、AppHeader、PageContainer、Breadcrumb（详情页按需）。
- **Dependencies**：Phase 1（Tailwind + 图标）。
- **API Impact**：无。**Route Impact**：**路径与名称零变更**；仅 `router-link-active` 驱动的菜单高亮逻辑保持。**Store Impact**：无。
- **Permission Impact**：无（禁 `keep-alive`）。
- **Risk**：Medium（实时订阅生命周期、滚动容器变化）。
- **Validation**：8 项菜单逐项点击可达；离开工作流/需求/AgentRun 后确认无新请求（实时通道已停止）；`lint/typecheck/test` 全绿。
- **Definition of Done**：11 个页面在新壳下均可正常渲染与跳转，无第二 Sidebar、无页面自带 Header。

### Phase 3 — Common Components

- **Goal**：建立公共组件层（**先建后用**，本轮不接入页面）。
- **Files**：新建 `components/common/*`（PageHeader、Card、StatusBadge、EmptyState、LoadingState、ErrorState、MetricCard、ConfirmDialog、DetailList、FormField、Breadcrumb）+ `components/ui/*` 基础 primitive。
- **Components**：上列 11 个 + Button/Input/Select/Badge/Skeleton 薄包装。
- **Dependencies**：Phase 1（token）、shadcn-vue 依赖集合。
- **API Impact**：无。**Route Impact**：无。**Store Impact**：无。**Permission Impact**：无（组件不得调用任何 API/store）。
- **Risk**：Low（尚未被页面消费）。
- **Validation**：`typecheck`/`lint` 通过；纯逻辑部分（如 status→variant 映射）补 `__tests__/` 测试；确认组件内不出现任何 `fetch`/store 调用。
- **Definition of Done**：组件具备明确 Props/Emits 类型、无隐式 any、无硬编码页面专用文案。

### Phase 4 — Dashboard

- **Goal**：用新壳 + 公共组件重构首页（Welcome/Quick Actions/Statistics/Grid 结构只在有数据支撑时落地）。
- **Files**：`views/DashboardView.vue`。
- **Components**：PageHeader、MetricCard、Card、EmptyState、LoadingState、ErrorState。
- **Dependencies**：Phase 2、Phase 3。
- **API Impact**：无（继续用 `projectsStore.fetchProjects()`）。**Route Impact**：无（保留「新建项目」跳转 `/projects`）。
- **Store Impact**：无。**Permission Impact**：无。
- **Risk**：**Low**（只读页面）。
- **Validation**：Visual QA（对照设计文档；无参考图则对照 Design System）+ Functional QA（加载/空态/错误态三态）+ 三档视口。
- **Definition of Done**：Visual + Functional + typecheck/lint/test 全 PASS；无 API/路由/Store 变更。

### Phase 5 — Projects（列表 + 详情）

- **Goal**：定稿“列表页 + 内联创建表单 + 详情页”模板。
- **Files**：`views/ProjectsView.vue`、`views/ProjectDetailView.vue`。
- **Components**：PageHeader、Card、Button（loading/disabled）、FormField、ConfirmDialog、EmptyState/ErrorState/LoadingState、DetailList。
- **Dependencies**：Phase 3。
- **API Impact**：无（`createProject`/`deleteProject`/`listProjects`/`getProject` 调用不变）。**Route Impact**：无（`/projects`、`/projects/:id` 保持；跳转链不变）。
- **Store Impact**：无（`projectsStore` 的 4 个 action 原样调用）。**Permission Impact**：无。
- **Risk**：Medium（创建/删除）。
- **Validation**：创建（含必填/URL 格式/长度上限）、删除（确认流）、空态、错误态；`required/maxlength/type=url` 行为逐项核对。
- **Definition of Done**：功能等价清单（01-refactoring-rules §10）逐条通过。

### Phase 6 — Requirements

- **Goal**：重构需求主从页（创建 → 分析 → 规格 → Task DAG）。
- **Files**：`views/RequirementsView.vue`。
- **Components**：PageHeader、Card、FormField、MetricCard、DetailList、EmptyState、Button，以及 DAG 节点/依赖列表样式。
- **Dependencies**：Phase 3、Phase 5（列表模板）。
- **API Impact**：无（`createRequirement`/`analyzeRequirement`/`listRequirement*` 等不变）。**Route Impact**：无。
- **Store Impact**：无（含 SSE `startRealtime` / `stopRealtime` 调用时机不变）。**Permission Impact**：无。
- **Risk**：High（SSE + 4 面板 + 分析动作）。
- **Validation**：创建→分析→事件流实时刷新→规格/ DAG 渲染；卸载后无残留请求；三档视口。
- **Definition of Done**：分析与实时事件链路行为与重构前一致。

### Phase 7 — Workflows（列表 + 详情 + 审批）

- **Goal**：重构平台核心页：创建工作流表单、工作流图、审批面板、事件时间线。
- **Files**：`views/WorkflowsView.vue`。
- **Components**：PageHeader、Card、Button（含 danger）、FormField、StatusBadge、Breadcrumb、列表选择项、时间线行。
- **Dependencies**：Phase 3、Phase 5/6 的列表模板。
- **API Impact**：无（`createWorkflow`/`workflowAction`/`decideApproval`/`listRequirements` 不变）。**Route Impact**：`/workflows`、`/workflows/:id` 及 `/agent-run?run=` 跳转不变。
- **Store Impact**：无（含实时通道）。**Permission Impact**：**审批面板与 approve/reject 语义必须保持**（§8 红线 1）。
- **Risk**：**High**（核心流程 + 审批 + SSE + 动态任务展示）。
- **Validation**：创建→启动→暂停→恢复→取消全链路；审批批准/拒绝；工作流图节点状态色；`workspacePath` 归一化输入；事件时间线。
- **Definition of Done**：7 个表单字段与 4 类动作行为完全等价；审批不可旁路。

### Phase 8 — Agents + AgentRun

- **Goal**：重构 Agent 注册表页与 Agent 运行页（迭代/重试/工具调用/事件/结果）。
- **Files**：`views/AgentsView.vue`、`views/AgentRunView.vue`。
- **Components**：PageHeader、MetricCard、Card、StatusBadge、DetailList、EmptyState、工具调用行/事件行、Button(danger)。
- **Dependencies**：Phase 3、Phase 7（事件行视觉复用）。
- **API Impact**：无。**Route Impact**：`/agents`、`/agent-run?run=` 不变（含深链）。
- **Store Impact**：无（`agentsStore` 2 action、`agentRunsStore` 8 action 与实时通道不变）。**Permission Impact**：`isActiveRun` 判定不变（取消按钮显示条件）。
- **Risk**：Medium。
- **Validation**：注册表指标、运行创建/取消、工具调用审计展示、事件流、深链 `?run=` 打开。
- **Definition of Done**：`agentStatusLabel`/`toolStatusLabel`/`eventLabel` 文案与展示一致（不得在组件内重写映射）。

### Phase 9 — Deployments

- **Goal**：重构环境配置表单、部署历史、详情（健康检查/CI/日志）与回滚。
- **Files**：`views/DeploymentsView.vue`。
- **Components**：PageHeader、Card、FormField、StatusBadge、Breadcrumb、时间线行、Button(danger)。
- **Dependencies**：Phase 3、Phase 5 模板。
- **API Impact**：无（`saveEnvironment`/`rollbackDeployment` 等不变）。**Route Impact**：`/deployments`、`/deployments/:id` 不变。
- **Store Impact**：无。**Permission Impact**：**生产环境回滚需审批的提示与 `canRollback` 判定必须保留**。
- **Risk**：**High**（回滚不可逆）。
- **Validation**：环境保存（端口 1-65535 校验）、历史列表、回滚原因必填、健康检查/日志展示。
- **Definition of Done**：回滚链路在重构前后行为一致（含失败分支的错误展示）。

### Phase 10 — MCP（列表 + 详情 + 应用容器）

- **Goal**：重构 MCP 服务器列表、详情（概览/工具/绑定 三 Tab）与沙箱应用容器外框。
- **Files**：`views/MCPServersView.vue`、`views/MCPServerDetailView.vue`、`views/MCPAppView.vue`。
- **Components**：PageHeader、Card、StatusBadge、Tabs（shadcn-vue 替换自研 tab-bar）、FormField（含 checkbox）、ConfirmDialog。
- **Dependencies**：Phase 3。
- **API Impact**：无（`listMCPServers`…`runMCPAppAction` 不变）。**Route Impact**：`/mcp`、`/mcp/:serverId`、`/mcp/:serverId/app` 不变（含查询参数 `projectId`/`agentName`）。
- **Store Impact**：无。**Permission Impact**：**沙箱常量、`:srcdoc`、`allowedTools` 严格默认、绑定撤销确认与提示文案必须原样保留**。
- **Risk**：**High（安全契约）**。
- **Validation**：`mcpSecurity.test.ts` 必须绿；绑定创建/停用/撤销；工具列表风险等级与审批标记；iframe 加载与桥接日志。
- **Definition of Done**：安全扫描测试 0 失败；绑定变更的权限效果不减弱。

### Phase 11 — 遗留 CSS 退役（收口）

- **Goal**：在**所有**消费者迁完后删除遗留 CSS 类，消除双重样式体系。
- **Files**：`apps/web/src/styles.css`（收缩）、可能少量页面残留类。
- **Components**：无新增。
- **Dependencies**：Phase 4-10 全部完成。
- **API Impact**：无。**Route Impact**：无。**Store Impact**：无。**Permission Impact**：无。
- **Risk**：Medium（误删仍被引用的类）。
- **Validation**：对每个候选类执行全仓 grep 确认零引用后再删；删完跑三档视口比对 + 全量测试。
- **Definition of Done**：`styles.css` 仅保留确有用途的规则（或整体退役），构建产物 CSS 体积下降且无视觉回归。

### Phase 12 — Global Visual QA

- **Goal**：跨页面一致性验收（Sidebar / Header / PageHeader / Button / Card / Table(列表) / StatusBadge / Dialog / Spacing / Typography / Colors）。
- **Files**：0 代码改动（仅产出 QA 记录）。
- **Components**：全部公共组件。
- **Dependencies**：Phase 4-11。
- **API Impact**：无。**Route Impact**：无。**Store Impact**：无。**Permission Impact**：无。
- **Risk**：Medium（跨页漂移）。
- **Validation**：按 `06-visual-qa.md` §3 维度逐页核对；1440×900 / 1280×800 / 1024×768 三档；参考图缺失时以 Design System 作为唯一基准（§20 Q5）。
- **Definition of Done**：8 个页面视觉一致；差异清单按 P0-P3 分级并收敛。

### Phase 13 — Functional Regression

- **Goal**：全链路功能回归，证明“功能等价”。
- **Files**：0 代码改动（仅记录）。
- **Components**：全部。
- **Dependencies**：Phase 4-12。
- **API Impact**：无。**Route Impact**：无。**Store Impact**：无。**Permission Impact**：无（验证其未被破坏）。
- **Risk**：High（若前面任一处引入回归，此处暴露）。
- **Validation**：9 条关键用户流程——(1) 项目 CRUD；(2) PRD→分析→规格/DAG；(3) 工作流创建→启动→暂停→恢复→取消；(4) 审批批准/拒绝；(5) Agent Run 创建/取消/深链；(6) 部署环境保存→部署详情→回滚；(7) MCP 绑定 CRUD；(8) MCP App 加载并触发动作（沙箱内）；(9) 菜单/路由/深链可达性。执行 `typecheck && lint && test`（含 `mcpSecurity.test.ts`）+ `build`。
- **Definition of Done**：9 条流程全部通过；无未声明的 API/Route/Store/Permission 变更；STOP（不进入后续产品功能开发）。

---

## 18. Baseline Results

### 18.1 门禁实测结果（本次实际执行，非推测）

| 门禁 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| Lint | `corepack pnpm --filter @ai-se/web lint` | **PASS（exit 0）** | `eslint "src/**/*.{ts,vue}"` 无输出 |
| Type Check | `corepack pnpm --filter @ai-se/web typecheck` | **PASS（exit 0）** | `pnpm --filter @ai-se/shared build && vue-tsc --noEmit` |
| Test | `corepack pnpm --filter @ai-se/web test` | **PASS（15 文件 / 53 用例，756ms）** | `vitest run src` |
| Build | `corepack pnpm --filter @ai-se/web build` | **PASS（335ms，163 模块）** | `dist/index.html 0.43 kB`、`dist/assets/index-*.css 11.50 kB`、`dist/assets/index-*.js 271.44 kB (gzip 86.75 kB)` |
| Format | `corepack pnpm exec prettier --check` | **PASS** | All matched files use Prettier code style |

**当前状态汇总**：可以正常启动 ✅（后端实测在 :3000 监听，`/health` 与 `/ready` 均 ok，Postgres/Redis 容器 healthy）；可以正常 Build ✅；**不存在 TypeScript Error**；**不存在 Lint Error**；**不存在 Test Failure**。Web 开发服务器（:5173）当前未运行；`pnpm dev` 可一键启动（`.env` 已存在）。

### 18.2 Baseline 清单（设计文档 §9 要求的 9 项）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| Build | ✅ Configured | `vite build` |
| Type Check | ✅ Configured | `vue-tsc --noEmit -p tsconfig.json` |
| Lint | ✅ Configured | ESLint flat config（`no-explicit-any: error` 已生效） |
| Test | ✅ Configured | Vitest（**node 环境：无 DOM，无组件渲染测试**） |
| Format | ✅ Configured | Prettier（根级 `format:check`） |
| Route | ✅ 13 条 | §4.1 |
| Menu | ✅ 8 项（扁平） | §4.2 |
| Page | ✅ 11 个视图 | §5.1 |
| API | ✅ 7 模块 / 47 函数（7 个未被 UI 引用） | §6 |
| Store | ✅ 7 个（6 个有测试） | §7 |

### 18.3 Not Configured（当前未配置，本次**未新增**任何配置）

| 能力 | 状态 | 影响 |
| --- | --- | --- |
| 组件/渲染测试（jsdom、@vue/test-utils） | **Not Configured** | UI 重构**没有**自动化渲染回归网；只能靠人工 Visual/Functional QA |
| 端到端浏览器测试（app 级） | **Not Configured** | 关键流程回归需人工执行（服务端有 e2e 套件，但不对前端 UI 断言） |
| 视觉回归 / 截图比对 | **Not Configured** | 无法自动发现像素漂移 |
| 可访问性检查（axe / eslint-plugin-vuejs-accessibility） | **Not Configured** | 当前 11 个视图 **0 个 aria/role 属性**，需要人工补齐 |
| Storybook / 组件预览 | **Not Configured** | 组件需在页面内验证 |
| 覆盖率统计 | **Not Configured** | 无 coverage 脚本 |
| Tailwind / PostCSS / components.json | **Not Configured** | Phase 1 目标 |
| 浏览器目标声明（browserslist / build.target） | **Not Configured** | Tailwind 4 的浏览器基线需确认（§20 Q8） |
| i18n 框架 | **Not Configured**（且**不应引入**） | 中文单语为既定产品规则 |

### 18.4 Baseline 附带的既存问题（**仅记录，不修复**）

1. `.error-banner` 被 3 个视图使用（`WorkflowsView.vue:83`、`DeploymentsView.vue:60`、`AgentsView.vue:28`），但 `styles.css` **从未定义该类** → 目前以无样式文本呈现。
2. `styles.css` 存在**两个 `@media (max-width:900px)` 块**且规则部分冲突（`:486-534` vs `:862-901`）。
3. 7 个 API 导出函数在 UI 中零引用（§6.3）。
4. 页面 `eyebrow` 暴露内部阶段号（「阶段 0/4/5/6」）。
5. `Inter` 字体被声明但未加载任何字体资源。
6. `index.html` 的 `lang="en"` 与中文单语 UI 不一致。
7. 视图层零 `aria-*`/`role`、`styles.css` 零 `:focus` 规则。
8. `requestJson` 在 7 个 API 模块中重复存在（含同一份中文错误映射）。

---

## 19. Recommended First Implementation Task

**推荐第一个实施任务 = Phase 1：Tailwind CSS 4 + AI-SE Design Token 接入（零页面改动）**

### 19.1 为什么是它

- 它是所有后续阶段的**唯一前置**：没有 token 与 Tailwind，就无法建立 AppShell 与公共组件。
- 它**不触碰任何页面、API、路由、Store、Permission**，回归面最小（唯一需要盯的是 Preflight 的全局重置）。
- 它的失败模式完全可观测：构建/类型/测试/业务三态只要一项变红即可回滚。

### 19.2 任务边界（Allowed / Forbidden）

| 允许 | 禁止 |
| --- | --- |
| 新增 Tailwind 4 相关 devDependencies | 安装任何 UI 组件库（shadcn-vue 相关依赖留到 Phase 3） |
| 修改 `vite.config.ts`（插件 + `@` 别名）、`tsconfig.json`（paths）、`main.ts`（导入顺序） | 修改 `router/`、`api/`、`stores/`、`viewmodels/`、任何 `views/*.vue` |
| 新建 `src/styles/app.css`（`@import "tailwindcss"` + `@theme` token） | 删除或重写 `styles.css` |
| 为 Preflight 做**最小视觉补偿**（面板 `h2` 显式字号/字重） | 顺手美化任何现有页面 |

### 19.3 交付物

1. `apps/web/src/styles/app.css`：`@import "tailwindcss";` + AI-SE token（Color：Primary `#6C5CE7` 系列、page/card/muted 背景、文本三级、边框两级；Typography：20-24/15-16/13-14/12/24-28；Spacing 4px 体系；Radius 6/8/10/12/14；状态语义色）——**token 定义依据 `docs/design/00-design-system.md` §3-§7**。
2. `cn()` 工具函数（落位取决于 §20 Q1 决策）+ 最小依赖 `clsx`、`tailwind-merge`。
3. 导入顺序契约：`app.css` 先、`styles.css` 后（写入注释 + 文档）。
4. Preflight 补偿清单（仅面板标题类，逐条列出改动）。

### 19.4 验证与 Definition of Done

```
corepack pnpm --filter @ai-se/web typecheck   # 期望 PASS
corepack pnpm --filter @ai-se/web lint        # 期望 PASS
corepack pnpm --filter @ai-se/web test        # 期望 15 files / 53 tests PASS（含 mcpSecurity.test.ts）
corepack pnpm --filter @ai-se/web build       # 期望 PASS
```

外加：三档视口（1440/1280/1024）人工比对“接入前 vs 接入后”截图，11 个页面**视觉零差异**（除已声明的 Preflight 补偿项）。

**DoD**：0 个 `views/*.vue` 被修改；4 个门禁全绿；token 在页面中可被 Tailwind 类消费（自证：临时在一个未使用的空白测试页用一次 token 类，验证后删除——或直接以构建产物 CSS 中存在 token 变量为证）。

---

## 20. Questions / Blockers

按阻塞程度排序。**Q1-Q5 为 BLOCKER，未决前不得进入对应 Phase。**

| # | 问题 | 为什么阻塞 | 可选方案 | 建议 |
| --- | --- | --- | --- | --- |
| **Q1** | `cn()` 工具函数放哪里？shadcn-vue 默认 `@/lib/utils`，而 AGENTS.md §5 明确禁止 `lib/`、`shared/`、`helpers/` 等目录名变体 | 阻塞 Phase 1（`shadcn-vue init` 会直接生成违规目录） | (a) 放 `src/components/ui/utils.ts`（与 primitive 同层，零新目录）；(b) 放 `src/composables/utils.ts`（复用已规划目录，但与 `useXxx` 命名约定不符）；(c) 正式批准新增 `src/lib/` 并在 AGENTS.md §5 登记 | **(a)**：不新增目录、不违反 §5、与 shadcn-vue 组件同层便于维护 |
| **Q2** | 是否批准修改 `vite.config.ts` / `tsconfig.json` / `main.ts`（新增 `@` 别名、插件、导入顺序）？ | 这是 Phase 1 的必要改动；任务书当前禁止修改配置文件 | (a) 批准（限定这三个文件）；(b) 不引入 `@` 别名，改用相对路径导入 shadcn 组件（放弃 CLI 默认产物，维护成本高） | **(a)** |
| **Q3** | 设计文档的一级菜单含「任务管理 / 代码仓库 / 系统设置」，代码中**均无对应页面与路由**。如何处理？ | 阻塞 Phase 2（菜单需定稿）。若按设计文档补齐 = **新功能开发**，违反 `01-refactoring-rules.md`（Visual Redesign ≠ Business Rewrite） | (a) 保持现有 8 项菜单与路由不变，仅做视觉重构（推荐）；(b) 仅重命名现有菜单文案（需同步 `docs/19-user-manual.md`）；(c) 明确授权新增 3 个页面（独立立项，不属于本次重构） | **(a)**，并在报告/文档中记录该差异 |
| **Q4** | 设计文档的全部二级菜单项（项目模板/项目归档/工作流模板/执行记录/失败任务/Agent 配置/环境管理/发布管理等）在代码中不存在。是否要建二级菜单结构？ | 阻塞 Phase 2 的 Sidebar 设计（有无二级/折叠/展开） | (a) 不做二级菜单（无对应页面，做了也是死链接）；(b) 用二级菜单重组**现有**页面（例如把 MCP 归入「设置」下）；(c) 授权新增页面 | **(a)** 或 **(b)**（若 (b)，需明确一级项与二级项的映射表与文案） |
| **Q5** | Figma / Reference Image 在哪里？仓库内无任何参考设计图 | 阻塞 Phase 12 Visual QA（`06-visual-qa.md` 的截图比对流程无基准） | (a) 提供参考图/链接；(b) 以 `docs/design/00-design-system.md` 作为唯一视觉基准（无像素级比对，只做设计系统一致性验收） | **(b) 作为过渡**，同时索取 (a) |
| **Q6** | Header 内容如何裁剪？设计要求 Search / System Status / Notification / User，但代码中**没有**对应数据源（无搜索接口、无系统状态接口、无通知、无用户体系） | 阻塞 Phase 2（Header 是 AppShell 的一部分） | (a) Header 仅放有数据支撑的内容（如面包屑/页面标题区），其余不实现；(b) 用**纯静态占位**（不可交互）实现视觉形态；(c) 明确授权新增后端接口（超出本次范围） | **(a)**；若必须还原视觉，(b) 需显式许可并标注为“非功能元素” |
| **Q7** | 主色从蓝 `#1d6fd3` 切到设计紫 `#6C5CE7`、Sidebar 从深色切到白底——是否确认整体品牌色变更？ | 影响 Phase 1 的 token 定义 | (a) 按设计文档切换为紫色体系；(b) 保留现有蓝色（与设计文档冲突，需记录） | **(a)**（设计文档为本次约束来源），但需显式确认——这是全站最显眼的视觉变更 |
| **Q8** | 浏览器支持基线？Tailwind 4 依赖现代浏览器特性，当前项目无 `browserslist` / `build.target` 声明 | 影响 Phase 1（构建 target 与降级策略） | (a) 与现状一致（现代浏览器，Chrome/Edge 最新两个大版本）；(b) 显式声明基线（如需兼容旧内核则需评估 PostCSS 降级） | **(a)**，并在 `docs/` 记录基线 |
| **Q9** | Store 内的 UI 状态（loading/creating/error 等）在重构中是否保持原样？ | 影响 Phase 3-10 的组件契约设计 | (a) 保持原样（推荐，0 改动 + 6 个 store 测试不动）；(b) 迁移到独立 UI store（改动面大、收益低） | **(a)** |
| **Q10** | 是否引入 Toast（设计要求保存/删除/部署成功用 Toast）？ | 影响 Phase 3 组件清单 | (a) 不引入（当前错误内联展示，成功依赖列表刷新）；(b) 引入全局 Toast 容器（新增 `composables/useToast` + 容器组件，属交互增强） | **(a)** 先行；如需 (b) 建议作为独立小批次在 Phase 12 前评估 |
| **Q11** | 是否需要暗色模式？设计 token 仅给出亮色值 | 影响 Phase 1 token 结构（是否需要 `.dark` 变量组） | (a) 仅亮色（与设计文档一致）；(b) 预留 `.dark` 变量但本轮不实现 | **(a)** |
| **Q12** | Phase 验收是否必须跑真实后端链路（Docker sandbox / CI / 部署回滚），还是允许以“接口可达 + UI 行为正确”为验收口径？ | 影响 Phase 5/7/9/13 的 DoD 判定成本 | (a) UI 层验收即可（接口调用是否被正确触发由网络面板证明）；(b) 全链路真实验收（需 Docker、可构建仓库、审批流） | **(a) 每页必做 + (b) 在 Phase 13 做一次**（当前后端/DB/Redis 均在线，具备条件） |

---

## 附录 A：证据索引（关键结论 → 代码位置）

| 结论 | 位置 |
| --- | --- |
| 8 项菜单、扁平、无图标 | `apps/web/src/App.vue:8-17` |
| 13 条路由、无 meta、无守卫、无懒加载 | `apps/web/src/router/index.ts:14-31` |
| 全局唯一样式表、1051 行、随 main.ts 引入 | `apps/web/src/main.ts:5`、`apps/web/src/styles.css` |
| 视图零 `<style>` 块 | 11 个 `views/*.vue` |
| 无 components/composables/types/constants | 文件系统实测 |
| 7 个 API 模块重复 `requestJson` | `api/projects.ts:5-24` 等 7 处 |
| `mcpSecurity.test.ts` 全文扫描契约 | `src/__tests__/mcpSecurity.test.ts:17-32, 34-36, 72-97` |
| 3 处 `window.confirm` | `views/ProjectsView.vue:44`、`views/ProjectDetailView.vue:23`、`views/MCPServerDetailView.vue:88` |
| 3 个 store 的实时通道单例 | `stores/agentRuns.ts:22-40`、`stores/requirements.ts:34-56`、`stores/workflows.ts:21-29` |
| 条件动作判定（唯一前端“权限”） | `viewmodels/workflowViewModel.ts:35-45`、`viewmodels/deploymentViewModel.ts:43-45`、`viewmodels/agentRunViewModel.ts:25-27` |
| MCP App 沙箱契约 | `views/MCPAppView.vue:184-191`、`viewmodels/mcpAppBridge.ts:28` |
| 审批面板 | `views/WorkflowsView.vue:229-246` |
| 生产回滚审批提示 | `views/DeploymentsView.vue:214-216` |
| 后端无认证中间件 | `apps/server/src/app.ts:56-61` |
| `.error-banner` 未定义 | `styles.css`（grep 零命中）vs `views/WorkflowsView.vue:83` 等 3 处 |
| 双重 900px 媒体查询 | `styles.css:486-534`、`styles.css:862-901` |

## 附录 B：本次任务实际执行的操作（可复核）

1. 阅读 `docs/design/` 全部 8 份文档 + `docs/10-frontend-console.md` + `docs/19-user-manual.md`（§4 菜单表）。
2. 通读 `apps/web` 全部源码：11 个 views、7 个 api、7 个 stores、8 个 viewmodels、`App.vue`、`main.ts`、`router/index.ts`、`styles.css`、配置与测试文件。
3. 运行 5 个门禁（lint / typecheck / test / build / prettier --check）并记录原始输出。
4. 通过 grep 实测统计：class 使用次数、API 导出与引用数、aria/focus/图标/表格/搜索/分页/对话框 的存在性。
5. 通过 npm registry 元数据核实 Tailwind 4 与 Vite 8 的兼容性，以及 shadcn-vue 依赖链版本与 Vue 3.5 的兼容性。
6. **未执行**：任何文件写入（除本报告）、依赖安装、配置修改、`git` 操作（该目录无 git）。
