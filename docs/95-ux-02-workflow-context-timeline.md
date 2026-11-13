# UX-02 — Workflow Context & Timeline

> 阶段门任务：只做 Workflow 相关体验（列表上下文 / 筛选 / 进度 / 时间线分页与事件可读性）。
> 不涉及 AgentRun（UX-03）、Workflow Engine 重构、Observability、AI SRE。

## 背景（侦察结论，以代码为准）

- 列表仅显示 `StatusBadge + id.slice(0,8) + v{planningVersion}`，无法识别 Project / 需求 / 进度；
- 时间线直接渲染快照全量 `current.events`（ASC，最旧在前），**无排序保证、无分页、无跳转**；
- 事件行只有 标签 + 任务短 id，失败事件没有 错误类型 / 原因 / Attempt / Recovery 信息；
- `WorkflowRun` 数据模型无 name 字段；`requirementId` 只有 ID。→ 必须做最小 API 扩展。

## 关键决策

| 决策点                   | 结论                                                                                           | 依据                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 列表主识别               | Requirement 名（fallback 需求短 id）；Workflow ID 降级为辅助 metadata + 复制按钮               | 无 name 字段，需求标题即"在做什么"                         |
| Project / Requirement 名 | 服务端 `findMany` LEFT JOIN `projects` / `requirements` 解析                                   | 不在前端维护第二套映射；复用现有实体                       |
| 任务进度                 | SQL 子查询 `count(*)`（total / SUCCESS 计数）                                                  | 不新建 Progress Entity；不改状态计算                       |
| 事件排序                 | **数据层** `ORDER BY created_at DESC, sequence DESC`                                           | `sequence BIGSERIAL` 为同毫秒事件的稳定 tiebreaker         |
| 时间线分页               | `GET /api/workflows/:id/events?page&pageSize`（默认 1/20，上限 100）→ `WorkflowEventPage` 信封 | 复用既有端点；不新增第二套分页模型                         |
| 分页组件                 | 复用 Phase 12-E 的 `components/ui/pagination`（Reka 原语）                                     | 项目已有组件与查询规范                                     |
| 实时策略                 | 第 1 页自动跟进新事件；旧页冻结 + 「回到最新」/ 有新事件时「回到最新（有新事件）」             | 分页状态不被实时刷新破坏；浏览器实测修正过基线比较（见下） |
| Task 跳转                | 页内锚点 `#task-<id>`（任务卡加 `id`）                                                         | **不新增路由**（13 路由冻结）                              |
| AgentRun 跳转            | 复用既有 `/agent-run?run=`；事件缺 `agentRunId` 时回退 `task.output.agentRunId`                | 不新增 ID 体系                                             |
| SSE / 轮询               | **协议不动**：快照仍为 `WorkflowDetailView`；时间线渲染改走分页端点                            | 满足"不得因 UX 改造修改 SSE 协议"                          |

## API 变更（最小扩展）

1. `GET /api/workflows` — 列表项在 `WorkflowRun` 基础上**增量**增加：
   - `projectName: string | null`、`requirementName: string | null`
   - `taskProgress: { total: number; completed: number }`
2. `GET /api/workflows/:id/events` — 由 `WorkflowEvent[]` 改为分页信封：
   ```json
   { "items": [...], "page": 1, "pageSize": 20, "total": 42, "totalPages": 3 }
   ```
   非法 `page` / `pageSize`（`<1` / `>100` / 非整数）→ `400 VALIDATION_ERROR`。
   该端点此前无任何 UI 消费者（`listWorkflowEvents` 未被调用），契约演进记录于此。

## 变更文件

| 层       | 文件                                            | 变更                                                                                                                                                                       |
| -------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared   | `packages/shared/src/index.ts`                  | 新增 `WorkflowSummary`、`WorkflowEventPage`                                                                                                                                |
| database | `packages/database/src/workflowRepositories.ts` | `findMany` 改富查询（LEFT JOIN + 计数）；新增 `findEventsPage`（DESC + total）                                                                                             |
| server   | `apps/server/src/services/workflowService.ts`   | `list()` → `WorkflowSummary[]`；新增 `getEventsPage()`（信封成型）                                                                                                         |
| server   | `apps/server/src/routes/workflows.ts`           | `/events` 解析 `page`/`pageSize`（zod，默认 1/20）                                                                                                                         |
| web      | `apps/web/src/api/workflows.ts`                 | `listWorkflows` 返回 Summary；`listWorkflowEvents(id, page, pageSize)`                                                                                                     |
| web      | `apps/web/src/stores/workflows.ts`              | 时间线状态（`events/eventsPage/eventsLoading/eventsError/hasNewEvents`）+ `loadEventsPage` / `jumpToLatest`；快照合并保留 Summary 字段；第 1 页自动跟进 / 旧页提示         |
| web      | `apps/web/src/viewmodels/workflowViewModel.ts`  | 新增 `workflowProgressLabel` / `workflowTimeLabel` / `eventTimeLabel` / `workflowDurationLabel` / `filterWorkflows` / `workflowEventView`（事件 → 摘要 + 失败详情 + 跳转） |
| web      | `apps/web/src/views/WorkflowsView.vue`          | 列表业务上下文 + Project/Status 筛选 + 复制 ID；详情 项目/需求/任务进度 + 任务锚点；时间线重做（分页 / 摘要 / 失败详情 / 跳转 / 回到最新）                                 |

## 测试

| 套件                                                                                   | 结果                                                                                                                            |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database` — workflowRepositories（新增 UX-02 用例，真实 PostgreSQL）         | 5/5 ✔                                                                                                                          |
| `apps/server` — workflowApi.e2e（含新增 UX-02 用例，真实 PostgreSQL + 真实工作流执行） | 6/6 ✔                                                                                                                          |
| `apps/web` — workflowsView / workflowViewModel / stores·workflows / uiComponents       | 86/86 ✔                                                                                                                        |
| `apps/web` — 全量套件                                                                  | 276 例：268 通过；8 个失败为**先存 eyebrow 断言**（非 UX-02 引入，用户已定「先别动」；UX-02 重写 workflowsView 测试后由 9 → 8） |

新增用例覆盖：列表 DTO 名称与进度、事件分页（DESC / total / 越界页）、非法分页参数 400、
时间线渲染（摘要 / 失败详情 / datetime / 跳转链接 / 页码 / 回到最新 / 空态 / 错误态）、
筛选谓词、store 时间线状态机（第 1 页跟进、旧页基线与「有新事件」只在真新时提示、jumpToLatest）。

**全包补充数字（两段门禁合并，无重叠）**：`packages/database` 10 文件 / 42 例 ✔；`apps/server`
21 文件 / 89 例 ✔；`packages/agent-core` / `mcp` / `browser` 各 55 / 235 / 38 例 ✔。
全仓合计 **127 文件 / 938 例 / 930 通过 / 8 先存失败**（详见「门禁」）。

## 验收对照

| 验收项                                | 结果           | 证据                                                              |
| ------------------------------------- | -------------- | ----------------------------------------------------------------- |
| 列表可直接识别 Project                | ✅             | 列表项渲染 `projectName`（服务端解析）+ e2e 断言                  |
| 列表可直接识别 Requirement / 工作内容 | ✅             | `requirementName` 为主识别行                                      |
| Workflow ID 不再是主要业务信息        | ✅             | ID 仅出现在底部 meta + 复制按钮                                   |
| Project Filter 可用                   | ✅             | 「全部项目」下拉（复用 projects store）                           |
| Status Filter 保持正常                | ✅             | 「全部状态」下拉 + 既有状态徽标逻辑不变                           |
| Progress 正确                         | ✅             | 列表用服务端计数；详情由实时任务推导（同源 Task 数据）            |
| Timeline 最新事件在顶部               | ✅             | 渲染顺序 = `items` 顺序（服务端 DESC）                            |
| 排序在数据层                          | ✅             | `ORDER BY created_at DESC, sequence DESC`（SQL）                  |
| 分页                                  | ✅             | `WorkflowEventPage` + Pagination 组件 + 「共 N 条 · 第 X / Y 页」 |
| Jump to latest                        | ✅             | 旧页 / 有新事件时显示「回到最新（有新事件）」                     |
| Event Summary                         | ✅             | `workflowEventView`：一句话业务描述（含 Agent / 任务名）          |
| Event 识别 Task / Agent               | ✅             | `taskTitle` / `agentName` 行 + 「查看任务」锚点                   |
| Failure Event 说明失败原因            | ✅             | 错误类型 / 原因 / Attempt（`retryCount / maxRetries`）            |
| Event → Task / AgentRun 跳转          | ✅             | `#task-<id>` 锚点；`/agent-run?run=`                              |
| SSE / Polling 正常                    | ✅（行为保持） | 快照协议未动；store 单测覆盖跟进策略；浏览器实测见下              |
| typecheck / lint / test / build       | 见"门禁"       | —                                                                 |

## 浏览器验证（真实数据，2026-09-16）

环境：本地 `pnpm dev`（web :5173 + server :3000，**重建后的新服务进程**；旧进程为孤儿且运行 9/14 旧代码，已清理）。

| 检查项                | 实测结果                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 列表业务上下文        | 7 条真实工作流全部渲染「需求名（Todo 管理系统）· 项目名（Mini Todo）· 进度 X / Y · 开始/更新时间 · 用时（55s / 1m 18s / 进行中）」；ID 降级为 `ID 99975877` + 复制按钮                                                     |
| Project / Status 筛选 | 状态=失败 → 7 → **6** 条；状态=成功 → **0** 条 + 「没有符合筛选条件的工作流。」；恢复全部 → 7 条                                                                                                                           |
| 时间线分页            | 926 条事件 / **47 页**；第 1 页最新事件 09/14 18:53:41 在顶；下一页 → 第 2 / 47 页首条变为 18:52:28（服务端 DESC）；首页按钮回第 1 页                                                                                      |
| 回到最新              | 第 2 页显示「回到最新」；点击回到第 1 页；第 1 页不显示该按钮                                                                                                                                                              |
| 事件可读性            | 真实事件以业务句渲染：「工具 run_build 调用失败 / 状态 failed / 原因 run_build failed / 错误码 COMMAND_ERROR / 耗时 50324ms / 迭代 151」；「调用工具 run_build」；Agent 与任务上下文 + 「查看任务」「查看 Agent 运行」链接 |
| 复制 ID               | 点击无报错（无权限/非安全上下文时静默保持「复制 ID」）                                                                                                                                                                     |

**浏览器实测发现并修复的问题**：旧页比较基线错误 —— 原实现用「快照最新事件 vs 当前页第一条」判断是否有新事件，在 page>1 恒为真（页首本就是旧事件），导致第 2 页无条件显示「有新事件」。修正为在每次取页时记录基线 `eventsLatestId`（取页时刻的快照最新事件 id），只有真正出现更新的才提示；同一批事件重复到达不再误报（store 测试同步覆盖）。

## 门禁

全仓四门禁（`pnpm -r run <gate>`，2026-09-16）：

- **typecheck=0 / lint=0 / build=0**
- **test=1** —— 唯一失败是 apps/web 的 8 个先存 eyebrow 断言（非 UX-02 引入）；`pnpm -r` 在 web 处
  首败 bail，跳过的 database / agent-core / mcp / browser / server 已逐包补跑，全部为 0：
  database 42、agent-core 55、mcp 235、browser 38、server 89。
- **合计：127 文件 / 938 例 / 930 通过 / 8 失败（全部为先存失败）**。

## 已知问题 / 边界

1. SSE / 轮询快照仍包含全量 `events`（协议冻结，未裁剪）；时间线渲染已不再使用该字段。
2. 列表筛选在客户端对已加载列表做谓词过滤（列表本身无分页）；时间线分页在服务端 —— 两者边界清晰。
3. 「复制 ID」依赖安全上下文（localhost / https）的剪贴板 API；不可用时静默（不影响主流程）。
4. 任务跳转为页内锚点（无独立 Task 详情路由，路由表冻结）；如未来新增路由再升级。
5. 浏览器未实测项：真实运行中的工作流「回到最新」行为（需真实后端）—— 静态契约 + store 单测已覆盖逻辑分支。

## 停止

完成验收后停止；未进入 **UX-03（AgentRun）**。
