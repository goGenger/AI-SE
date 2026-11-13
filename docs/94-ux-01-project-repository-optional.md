# UX-01 — Project Repository Optional（实施记录与验收报告）

日期：2026-09-16 ｜ 范围：仅 UX-01（Project 创建与配置流程中 Git Repository 改为可选）。
未进入 UX-02。

## Modified Files

| 文件                                                                    | 变更                                                                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/database/migrations/010_ux01_project_repository_optional.sql` | 新增迁移：`projects.repository_id DROP NOT NULL`                                                                      |
| `packages/database/src/projectRepository.ts`                            | create 支持无仓库；findMany/findById 改 LEFT JOIN；新增 `attachRepository`                                            |
| `packages/database/src/projectRepository.test.ts`                       | 新增（真实 PG 容器）：无仓库创建可见性 / 原行为不变 / 后续绑定                                                        |
| `packages/database/src/migrate.test.ts`                                 | 迁移清单 + 计数（9→10）同步                                                                                           |
| `packages/shared/src/index.ts`                                          | `CreateProjectSchema.repository` 改为可选；`Project.repository: string \| null`；新增 `AttachProjectRepositorySchema` |
| `apps/server/src/routes/projects.ts`                                    | 新增 `PUT /api/projects/:id/repository`（绑定/替换仓库）                                                              |
| `apps/server/src/services/deploymentOrchestrator.ts`                    | 无仓库时 CI/交付以 `REPOSITORY_NOT_CONFIGURED` 明确失败（不再隐式假设）                                               |
| `apps/server/src/__tests__/projects.test.ts`                            | 内存仓库补 `attachRepository`；新增「无仓库创建 + 后续绑定」用例                                                      |
| `apps/web/src/viewmodels/projectViewModel.ts`                           | 新增 `repositoryLabel`（未配置兜底）、`normalizeRepository`（空输入省略字段）                                         |
| `apps/web/src/api/projects.ts`                                          | 新增 `attachProjectRepository`                                                                                        |
| `apps/web/src/stores/projects.ts`                                       | 新增 `attachRepository` action（同步 selectedProject 与列表）                                                         |
| `apps/web/src/views/ProjectsView.vue`                                   | 仓库改为「（可选）」；空输入不提交该字段；列表列兜底「未配置」                                                        |
| `apps/web/src/views/ProjectDetailView.vue`                              | 详情展示「未配置」；未配置时提供绑定表单入口                                                                          |
| `apps/web/src/__tests__/projectViewModel.test.ts`                       | +2 例（repositoryLabel / normalizeRepository）                                                                        |
| `apps/web/src/__tests__/projectsView.test.ts`                           | +1 例（未配置兜底）；required 断言按新契约更新（2→1）                                                                 |
| `apps/web/src/__tests__/projectDetailView.test.ts`                      | +2 例（未配置展示 + 绑定入口 / 已配置不显示表单）                                                                     |

## Implementation

- **数据模型（不凭假设）**：实际代码中 `projects.repository_id` 为 `NOT NULL REFERENCES repositories(id)`，
  `repositories` 实体（url UNIQUE, upsert by url）早已存在——本任务仅放开可空并复用既有实体与关联关系，
  未把 Git URL 扩散进 Project 业务逻辑（读取仍经 `LEFT JOIN repositories` 得到 url）。
- **创建**：`repository` 省略时 `repository_id = NULL`；提供时保持原 upsert 语义（不变）。
- **可见性**：`findMany` / `findById` 由 INNER JOIN 改 LEFT JOIN——否则未配置仓库的项目会被静默过滤。
- **后续绑定**：`PUT /api/projects/:id/repository`（复用统一响应信封与既有错误码：`VALIDATION_ERROR` /
  `PROJECT_NOT_FOUND`）；Web 在项目详情未配置时展示绑定表单，成功后同步 store 中选中项与列表项。
- **明确边界**：CI/交付（`runCi`）需要仓库——未配置仓库的项目进入交付任务时以
  `REPOSITORY_NOT_CONFIGURED` 失败；Workflow 创建、Workspace Path、既有 API/Route/Store 语义均未改变。

## Architecture Changes

- `projects.repository_id`：NOT NULL → 可空（迁移 010）。
- 新增一条项目子资源路由（绑定仓库），未新增任何第二套错误/存储/状态体系；未修改 Workflow / AgentRun。

## Dependencies

无新增依赖。

## Tests

| 套件                                                                                                | 结果                                                                    |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/database` — 目标文件（projectRepository.test.ts + migrate.test.ts，真实 PostgreSQL 容器） | 6/6 ✔                                                                  |
| `apps/server`（projects.test.ts，含新增 UX-01 用例）                                                | 6/6 ✔                                                                  |
| `apps/web` 目标套件（projectViewModel / projectsView / projectDetailView / workflowViewModel）      | 38 例中 37 ✔ 通过；1 个失败为**先存失败**（见 Known Issues，非本任务） |
| `packages/shared`                                                                                   | 46/46 ✔                                                                |

新增用例合计 9 个（database 3、server 1、web 5）。

**全仓覆盖（两段合并、无重叠；`pnpm -r` 在 web 处 bail，剩余五包以逐包循环补跑）**：
127 文件 / 923 例 / **914 通过 / 9 个先存失败**（全部为先存 eyebrow 断言，见 Known Issues）——
database 41（10 文件）、agent-core 55、mcp 235、browser 38、server 88、web 263 及其余 9 包全绿。

## Lint

- `pnpm -r run lint` = 0（apps/web / server / packages 全绿；见门禁记录）。

## Typecheck

- `pnpm -r run typecheck` = 0（含 shared 类型变更后的全仓复查）。

## E2E

- 数据库层：真实 PostgreSQL 容器上验证「无仓库创建 → findMany/findById 可见 → 绑定 → 再绑定替换 → 未知 id 返回 null」。
- API 层：supertest 走真实 Express 应用验证创建（无仓库 201 + `repository: null`）、列表、绑定（200 + url）、
  未知项目 404、非法 URL 400。
- Web 层：SSR 契约测试验证「未配置」兜底、绑定入口渲染、已配置时不出现绑定表单。
- 未做浏览器手工交互验证（如需可在开发环境补做）。

## Known Issues

- **先存失败（非本任务引入，用户已决定暂不处理）**：`apps/web` 有 **9 个**测试失败，原因为
  2026-09-16 13:55–14:10 的一批视图改动（各页面头移除 eyebrow 副标题文案，如「阶段 4/5/6」
  「需求规划」「项目详情」「MCP 应用」「设置」「Agent 运行时」「阶段 0」），而相应测试（9-15 ~ 9-16 上午）
  仍在断言这些旧文案。证据：受影响文件时间线（视图晚于测试）+ 逐条失败信息（首个断言均为旧 eyebrow 文案）。
  经确认，那批视图改动可能未定稿——本次**未修改这 9 个测试**，待确认后再处理。
  失败清单：agentRunView、agentsView、dashboardView、deploymentsView、mcpAppView、mcpServersView、
  projectDetailView（仅「项目详情」eyebrow 断言一条）、requirementsView、workflowsView。
- 绑定入口仅在「项目详情」页（未配置时）；列表页仅展示「未配置」（按任务范围的最小实现）。

## Acceptance Result

| 验收项                                   | 结果    | 证据                                                                                                          |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| Git Repository 可以为空                  | ✔      | schema optional + 迁移 010 + DB/API 测试                                                                      |
| 不配置 Git 可以成功创建 Project          | ✔      | server 测试：POST 201 且 `repository: null`；DB 测试                                                          |
| 不配置 Git 的 Project 可正常进入后续流程 | ✔      | 列表/详情 API 可见（LEFT JOIN）；workflow 创建链路只依赖 projectId，未受影响                                  |
| 已配置 Git 的 Project 行为不变           | ✔      | 原创建/列表/详情用例保持通过；DB 测试验证 url 语义不变                                                        |
| Project Detail 区分已配置 / 未配置       | ✔      | `repositoryLabel` 兜底 + 详情测试（未配置/已配置各一例）                                                      |
| 后续可以绑定 Git Repository              | ✔      | PUT 路由 + store/api + 详情绑定表单 + 测试                                                                    |
| typecheck PASS                           | ✔      | `pnpm -r run typecheck` = 0                                                                                   |
| lint PASS                                | ✔      | `pnpm -r run lint` = 0                                                                                        |
| test PASS                                | ⚠️ 限定 | UX-01 相关用例全部通过；全仓 923 例中 914 通过，9 个失败为**先存失败**（见 Known Issues，用户已决定暂不处理） |
| build PASS                               | ✔      | `pnpm -r run build` = 0                                                                                       |

## Next Phase Boundary（STOP）

- 未开始：**UX-02**（按任务要求完成上述验收后停止）。
- 待办（由用户决定）：先存 9 个 eyebrow 测试的同步。
