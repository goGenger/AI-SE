# AI-SE 使用手册

本文适用于 Phase 6 完成后的 AI-SE 本地版本。

AI-SE 当前已经具备从需求、规划、任务 DAG、动态工作流、多 Agent 执行到 CI/CD
与部署回滚的基础闭环。真实 GitHub Actions、GHCR、远程 staging / production
环境需要你提供外部仓库、凭据和部署目标后再验收；本地默认可以先用 mock
模型和本地 Docker 流程熟悉系统。

## 1. 你需要先知道的边界

AI-SE 的主链路是：

```text
Project
→ Requirement / PRD
→ Requirement Analysis
→ Specification
→ Task DAG
→ Workflow
→ Agent Run
→ Tool Runtime
→ Docker Sandbox
→ CI
→ Deployment
→ Approval
→ Production
→ Health Check
→ Rollback
```

当前不要把它当成普通脚手架使用。正确用法是先把需求写入系统，再让系统生成规格和任务，
之后由 Workflow 调度 Agent 和交付任务。

两个运行模式要区分：

- 基础控制台模式：`docker compose up --build`。适合启动 PostgreSQL、Redis、Server、Web，
  查看页面和数据（代码在容器内，改代码不生效）。
- 开发模式：`pnpm dev`。PostgreSQL / Redis 用 Docker，Server 和 Web 在宿主机运行，
  前后端都支持热更新，适合日常开发；真实 Agent Sandbox、本地 CI、本地 Docker 部署和回滚也使用这个模式。

原因是 Compose 中的 Server 不挂载 Docker socket，这是安全边界。需要执行 Docker Sandbox
或本地 Docker deployment 时，请使用宿主机运行 Server 的模式。

## 2. 前置条件

确认本机有：

```bash
nvm use
node -v
pnpm -v
docker --version
docker compose version
```

期望版本：

- Node.js：22.x
- pnpm：12.3.4
- Docker Desktop 或可用 Docker Engine
- Docker Compose

首次安装依赖：

```bash
pnpm install --frozen-lockfile
```

如果你修改了依赖版本，先正常执行 `pnpm install` 更新 lockfile，再提交新的
`pnpm-lock.yaml`。

## 3. 本地启动

### 3.1 基础控制台模式

```bash
cp .env.example .env
nvm use
pnpm install --frozen-lockfile
docker compose up --build
```

打开：

- Web Console：`http://localhost:5173`
- Server API：`http://localhost:3000`

健康检查：

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

停止：

```bash
docker compose down
```

清空 PostgreSQL / Redis 数据卷：

```bash
docker compose down -v
```

`down -v` 会删除本地数据，只在你确定要重置环境时使用。

### 3.2 开发模式（一条命令）

日常开发推荐。先准备好 `.env`（首次）：

```bash
cp .env.example .env
```

然后一条命令启动全部：

```bash
nvm use
pnpm dev
```

`pnpm dev` 会依次完成：

1. `docker compose up -d --wait postgres redis`：启动 PostgreSQL / Redis 并等待健康。
2. `pnpm --filter @ai-se/database migrate`：执行数据库迁移。
3. 并行启动 Server（`tsx watch`，`http://localhost:3000`，后端代码改动自动重启）与 Web
   （Vite dev，`http://localhost:5173`，热更新）。

打开 `http://localhost:5173`。

说明：

- Server / Web 在宿主机运行，因此真实 Agent Sandbox、本地 CI、本地 Docker 部署和回滚都可用。
- 首次启动 Server 前会先构建 workspace 依赖包，大约需要 1 分钟；Web 通常几秒就绪。
- 前后端都是热更新：改 `apps/server/src` 后端自动重启；改 `apps/web/src` 浏览器即时更新。
  注意 Server 依赖 `packages/*` 各包的**构建产物**：改依赖包源码后先重建该包
  （如 `pnpm --filter @ai-se/agent-core build`），重建完成时 Server 也会自动重启。
- Ctrl+C 停止前后端；PostgreSQL / Redis 会继续在后台运行（退出开发时可用
  `docker compose down` 停止，不要用 `down -v`，除非确定要清空数据）。
- 修改 `.env` 后重新执行 `pnpm dev` 生效。

### 3.3 宿主机执行模式（手动分步）

与 3.2 相同模式，但手动分步控制，适合单独调试某个进程。

真实执行 Agent、Sandbox、本地 CI 和本地部署时推荐这个模式。

先启动基础依赖：

```bash
docker compose up -d postgres redis
```

导出环境变量并迁移数据库：

```bash
cp .env.example .env
set -a
source .env
set +a
pnpm --filter @ai-se/database migrate
```

启动 Server：

```bash
set -a
source .env
set +a
pnpm --filter @ai-se/server dev
```

另开一个终端启动 Web：

```bash
VITE_API_BASE_URL=http://localhost:3000 pnpm --filter @ai-se/web dev
```

打开 `http://localhost:5173`。

## 4. 常用页面

| 页面       | 地址                               | 用途                                                   |
| ---------- | ---------------------------------- | ------------------------------------------------------ |
| 仪表盘     | `/`                                | 查看平台入口和概览                                     |
| 项目       | `/projects`                        | 创建、查看、删除项目                                   |
| 项目详情   | `/projects/:id`                    | 查看单个项目                                           |
| 需求       | `/requirements`                    | 创建 PRD，执行需求分析，查看规格和 Task DAG            |
| 工作流     | `/workflows`、`/workflows/:id`     | 创建、启动、暂停、恢复、取消、重试失败工作流，处理审批 |
| Agent 运行 | `/agent-run`                       | 单次 Coding Agent 执行、工具调用和事件观察             |
| Agent      | `/agents`                          | 查看专业 Agent 注册表和指标                            |
| 部署       | `/deployments`、`/deployments/:id` | 配置环境、查看部署历史、健康检查、日志和回滚           |

## 5. 第一次使用：跑通需求到工作流

### 5.1 创建 Project

进入「项目」，填写：

- 名称：项目名称
- 仓库地址：仓库 URL，必须是合法 URL
- 描述：项目说明

如果后面要接 GitHub Actions，Repository URL 使用：

```text
https://github.com/<owner>/<repo>
```

### 5.2 创建 Requirement

进入「需求」，点击右上角「新建需求」打开弹窗：

1. 在弹窗中选择项目。
2. 填写标题。
3. 在 PRD 文本框里写需求。
4. 点击「创建」（创建成功后弹窗关闭；表单内容保留，便于继续创建）。

在需求列表（表格）中：

5. 点击该行的「分析」发起需求分析。
6. 点击该行的「详情」，在右侧抽屉中查看详情、规格与 Task DAG。

默认 `LLM_PROVIDER=mock` 时，系统会生成 Todo 示例的需求分析、规格和任务 DAG，
适合先熟悉链路。

启用真实模型时，所有模型 API 统一走 `.env` 配置（planning / 多 Agent / 编码 Agent）：

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=<your-api-key>
OPENAI_MODEL=<model-name>
# 可选：OpenAI 兼容端点（DeepSeek / 自建网关等）
OPENAI_BASE_URL=
# 可选：规划阶段的结构化输出策略 jsonSchema（默认）| functionCalling | jsonMode
OPENAI_STRUCTURED_OUTPUT_METHOD=
```

DeepSeek 示例：

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=<deepseek-api-key>
OPENAI_MODEL=deepseek-flash
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_STRUCTURED_OUTPUT_METHOD=jsonMode
```

DeepSeek 说明：其 API 不支持 `json_schema` 结构化输出，且 thinking 模型会拒绝强制
tool_choice，因此规划阶段请使用 `jsonMode`（系统会自动在提示词中注入 JSON 结构与
json 指令）。

不要把 API Key、Token、Password、Cookie、生产 Secret 写进 PRD。

### 5.3 查看规格和 Task DAG

Requirement 分析完成后，点击该行「详情」，在右侧抽屉中查看：

- 规划事件
- 规格
- 任务 DAG
- 任务依赖

任务 DAG 里会包含数据库、后端、前端、测试、评审、构建、部署等任务类型
（对应 DATABASE、BACKEND、FRONTEND、TEST、REVIEW、BUILD、DEPLOY 枚举）。
带 `delivery` 信息的任务会交给 Deployment Orchestrator。

## 6. Workflow 使用

进入「工作流」——列表为表格 + 分页，点击行内「详情」在右侧抽屉查看详情：

- 工作流列表以表格展示（状态 / 需求 / 项目 / 进度 / 更新时间），可按「全部项目」「全部状态」筛选，分页每页 10 条。
- 行内操作：「详情」（打开右侧抽屉）、状态主操作（开始 / 暂停 / 继续 / 重试失败任务，条件与详情一致）、「复制 ID」。

创建新工作流：点击页头「新建工作流」打开弹窗：

1. 选择项目。
2. 选择已经 `ANALYZED` 的需求。
3. （可选）填写「目标仓库路径」——真实 Agent Sandbox / 本地 CI 的目标 Git 仓库绝对路径。
4. 设置最大并发。
5. 设置最大重试次数。
6. 选择失败策略与预算（可空）。
7. 点击「创建」（创建成功后自动进入该工作流详情抽屉）。
8. 在详情抽屉中点击「开始」。

常用失败策略（新建工作流时界面默认选中 `FAIL_FAST`，即失败即停、不自动重试；需要自动恢复时请显式选择其它策略）：

- `FAIL_FAST`：任一关键任务失败后停止。
- `RETRY`：失败后按 max retries 重试。
- `REPLAN`：失败后创建动态修复任务。
- `ROLLBACK`：部署失败时创建动态回滚任务。
- `CONTINUE`：允许失败后继续后续可执行任务。

Workflow 详情（右侧抽屉）会实时显示：

- 工作流图
- Task 状态
- 执行 Agent
- 审批
- 事件时间线
- Agent Run 链接

Production deploy task 会自动要求人工审批。出现审批面板后，需要你点击
「批准」或「拒绝」。

### 重试失败任务

工作流失败后（状态为「失败」），列表行内与详情抽屉中会显示「重试失败任务」按钮：

- 只重新排队**未解决的失败任务**与被阻塞（BLOCKED）的任务；已完成（成功）的
  任务一律跳过，不会重跑、不会重新消耗模型 token。
- 重试在**当前工作区现状**上重跑，不回滚已经产生的文件改动（平台不做工作区快照）。
- 手动重试不消耗也不重置「最大重试次数」预算：重排后的任务再次失败时仍按当前
  失败策略处理（例如 `FAIL_FAST` 会再次失败，可再次点击重试）。
- 若失败任务的审批已被「拒绝」，该工作流不支持重试（审批按任务唯一，无法重新
  发起），需要新建工作流。
- 重试后工作流回到「运行中」，尚未执行的任务会继续执行直到完成。

## 7. Agent Run 使用

进入「Agent 运行」——列表为表格 + 分页，点击行内「详情」在右侧抽屉查看详情：

- 运行列表以表格展示（状态 / 任务 / Agent / 项目 / 工作流 / 尝试 · 用时），分页每页 10 条。
- 行内操作：「详情」（打开右侧抽屉）、「取消」（仅活动运行）、「复制 ID」。

创建新运行：点击页头「新建运行」打开弹窗。默认任务是：

```text
修复项目中的测试失败问题，并确保所有测试通过。
```

这个入口会复制 `examples/coding-agent-test-project` 到临时目录，然后通过 Coding Agent、
Tool Runtime 和 Docker Sandbox 执行修复。详情抽屉可以看到：

- 状态
- 当前迭代
- 重试
- 工具调用
- 工作流事件
- 最终结果

运行中可以点击「取消」（列表行内或详情抽屉中均可）。取消状态通过 Redis cancellation flag 传递。

注意：这个页面是单次 Agent Run 观察入口，不等同于完整 PRD 到交付链路。
完整链路请从 Requirement 和 Workflow 开始。

## 8. Environment 配置

进入「部署」页面左侧的「环境」表单，先配置项目环境。

字段说明：

- 项目：选择项目。
- 环境：`dev`、`staging`、`production`。
- 端点：部署后用于健康检查的地址，例如 `http://localhost:18001`。
- 主机端口：宿主机端口。
- 容器端口：容器内部服务端口。
- Secret 引用：只保存引用，例如 `secret://production/app`，不要填写 Secret 明文。

本地 staging 示例：

```text
Environment: staging
Endpoint: http://localhost:18001
Host port: 18001
Container port: 3000
Secret reference: secret://local/staging
```

Production 示例：

```text
Environment: production
Endpoint: http://localhost:18002
Host port: 18002
Container port: 3000
Secret reference: secret://production/app
```

当前 adapter 是 `docker`。它会在执行部署时运行 Docker container，并检查：

- `GET /health`
- `GET /ready`

两者都成功才算 Deployment `SUCCESS`。

## 9. CI 与镜像

### 9.1 Local CI

默认：

```bash
CI_PROVIDER=local
```

Local CI 会在 Workflow 的 `workspacePath` 中执行：

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker build -t <image>:<gitCommit> .
```

要求：

- `workspacePath` 必须是一个 Git 仓库。
- 仓库至少有一个 commit。
- 仓库根目录有可用 `package.json`、`pnpm-lock.yaml` 和 Dockerfile。
- 运行 Server 的宿主机可以执行 Docker。

创建 Workflow 时在表单里填写「目标仓库路径」（可选，绝对路径）：填上后 Agent Sandbox
和 Local CI 会在该仓库中工作；留空则使用服务端默认工作区。也可以用 API 创建
Workflow（示例见第 14 节）。

创建时会立即校验：路径必须是**以 `/` 开头的本机绝对路径**且**目录已存在**（控制台会
自动把拖拽/粘贴产生的 `file://` 链接转成普通路径）。另外，该目录必须位于
`AGENT_WORKSPACE_ROOT`（`.env`，默认 `.` = Server 启动目录）范围内，否则任务运行时会报
`Workspace path is outside the sandbox allowlist`——把 `AGENT_WORKSPACE_ROOT` 设为包含你
所有项目的父目录（例如 `/Users/你的用户名/Desktop/projects`）并**完整重启 `pnpm dev`**。

### 9.2 GitHub Actions + GHCR

启用 GitHub CI：

```bash
CI_PROVIDER=github
GITHUB_TOKEN=<token-that-can-dispatch-and-read-actions>
GITHUB_API_URL=https://api.github.com
```

项目仓库必须是：

```text
https://github.com/<owner>/<repo>
```

仓库里需要存在：

```text
.github/workflows/ci.yml
```

当前 workflow 会执行：

```text
install
lint
typecheck
test
build
docker build
push ghcr.io/<owner>/<repo>:<git-sha>
```

如果 GHCR 是私有包，部署机器需要提前完成 `docker login ghcr.io`。不要把 GHCR token
写进 AI-SE 项目代码、PRD、Agent prompt 或日志；只在系统凭据管理或 Docker
credential store 中保存。

## 10. Staging 发布

完整 staging 流程：

```text
Requirement analyzed
→ Workflow created
→ BUILD task runs CI
→ DEPLOY task deploys staging
→ TEST task verifies staging
→ Deployment status recorded
```

操作步骤：

1. 在「部署」配好 staging environment。
2. 在「工作流」创建 Workflow。
3. 推荐失败策略选择 `ROLLBACK` 或 `RETRY`。
4. 点击「开始」。
5. 在工作流详情观察 BUILD、DEPLOY、VERIFY 任务。
6. 在「部署」查看部署记录、CI、健康检查和日志。

Staging 失败时，Workflow Engine 会根据 policy 决定 retry、rollback、re-plan 或 fail。
Deployment Orchestrator 只返回部署结果，不直接决定整个 Workflow。

## 11. Production 发布与审批

Production 流程：

```text
Staging SUCCESS
→ Production DEPLOY task WAITING_APPROVAL
→ Human Approve
→ Deployment
→ Health Check
→ SUCCESS / FAILED
```

操作步骤：

1. 在「部署」配好 production environment。
2. 确认 staging 已成功。
3. 在工作流详情找到审批面板。
4. 点击「批准」。
5. 等待 production deployment 运行。
6. 到「部署」查看 production 记录和健康检查。

如果点击「拒绝」，对应生产发布任务会失败，Workflow 进入失败策略处理。

AI-SE 当前禁止未经审批直接生产部署。

## 12. 回滚

### 12.1 自动回滚

Workflow policy 使用 `ROLLBACK` 时，DEPLOY 失败会触发：

```text
Deployment FAILED
→ Workflow Engine creates dynamic ROLLBACK task
→ Deployment Orchestrator restores previous successful version
→ Health Check
→ Workflow continues or fails
```

回滚只会选择同一 Project、同一 Environment 中上一个成功版本。

### 12.2 手动回滚

进入「部署」：

1. 选择一条 `DEPLOY` 且状态为 `SUCCESS` 或 `FAILED` 的记录。
2. 在详情页填写回滚原因。
3. 点击「回滚」。

Production rollback 仍然要求关联的生产部署任务已经人工审批。

回滚是幂等的：重复点击不会创建重复执行。

## 13. 追溯版本来源

要回答“当前 production 版本来自哪一次 AI 执行”，从部署详情看：

- Workflow：`workflowRunId`
- Task：`taskId`
- AgentRun：`agentRunId`
- CI：`ciRun`
- Git commit：`gitCommit`
- Docker image：`image`
- Environment：`environment`
- Health check：`healthCheck`

然后可以回到：

- 「工作流」查看任务 DAG 和审批记录。
- 「Agent 运行」查看工具调用、事件和执行摘要。
- 「部署」查看部署日志和回滚记录。

数据库中相关表：

- `projects`
- `requirements`
- `specifications`
- `tasks`
- `workflow_runs`
- `approvals`
- `agent_runs`
- `tool_calls`
- `workflow_events`
- `agent_artifacts`
- `deployment_environments`
- `ci_runs`
- `deployments`
- `deployment_logs`

## 14. API 快速示例

所有 API 返回统一结构：

```json
{
  "success": true,
  "data": {},
  "requestId": "..."
}
```

创建 Project：

```bash
curl -X POST http://localhost:3000/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"Todo App","description":"Demo project","repository":"https://github.com/example/todo-app"}'
```

创建 Requirement：

```bash
curl -X POST http://localhost:3000/api/projects/<projectId>/requirements \
  -H "Content-Type: application/json" \
  -d '{"title":"Todo 管理系统","description":"Demo","rawContent":"创建一个简单的 Todo 管理系统，支持创建、查看、修改和删除 Todo。"}'
```

分析 Requirement：

```bash
curl -X POST http://localhost:3000/api/requirements/<requirementId>/analyze \
  -H "Content-Type: application/json" \
  -d '{"regenerate":false}'
```

配置 staging 环境：

```bash
curl -X PUT http://localhost:3000/api/environments \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<projectId>","name":"staging","endpoint":"http://localhost:18001","adapter":"docker","configuration":{"hostPort":18001,"containerPort":3000},"secretReference":"secret://local/staging"}'
```

创建带本地 workspacePath 的 Workflow：

```bash
curl -X POST http://localhost:3000/api/workflows \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<projectId>","requirementId":"<requirementId>","workspacePath":"/absolute/path/to/your/repo","policy":{"maxConcurrency":2,"maxRetries":1,"failureStrategy":"ROLLBACK","allowRetry":true,"allowReplan":false,"approvalRequired":false}}'
```

启动 Workflow：

```bash
curl -X POST http://localhost:3000/api/workflows/<workflowId>/start
```

审批：

```bash
curl -X POST http://localhost:3000/api/approvals/<approvalId>/approve \
  -H "Content-Type: application/json" \
  -d '{"comment":"Approved for production release"}'
```

回滚：

```bash
curl -X POST http://localhost:3000/api/deployments/<deploymentId>/rollback \
  -H "Content-Type: application/json" \
  -d '{"reason":"Restore previous known-good version"}'
```

## 15. 日常使用 SOP

每次开发一个新需求，按这个顺序走：

1. 确认目标代码仓库是 Git 仓库，并有可构建的 Dockerfile。
2. 启动 AI-SE 宿主机执行模式。
3. 在「项目」创建或选择项目。
4. 在「需求」写入 PRD。
5. 点击「分析」，检查规格和 Task DAG。
6. 在「部署」配置 staging，必要时配置 production。
7. 在「工作流」创建 Workflow（可选填写目标仓库路径 `workspacePath`）。
8. 点击「开始」。
9. 查看工作流图、Agent Run、工具调用和事件。
10. Staging 成功后处理 production Approval。
11. 在「部署」查看版本、镜像、健康检查、日志。
12. 如果失败，根据 Workflow 策略 retry、re-plan 或 rollback。

## 16. 常用验证命令

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose config --quiet
```

只跑 Phase 6 本地交付 E2E：

```bash
pnpm --filter @ai-se/server test -- src/__tests__/deliveryLifecycle.e2e.test.ts
```

查看数据库：

```bash
docker compose exec postgres psql -U aise -d aise
```

常用查询：

```sql
SELECT id, name, repository, status FROM projects;
SELECT id, status, planning_version FROM workflow_runs ORDER BY created_at DESC;
SELECT id, environment, status, version, image FROM deployments ORDER BY created_at DESC;
SELECT level, message, created_at FROM deployment_logs WHERE deployment_id = '<deploymentId>';
```

## 17. 排障

| 现象                                                                      | 常见原因                                                                                             | 处理                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `nvm use` 失败                                                            | 本机没有 Node 22                                                                                     | `nvm install 22` 后重试                                                       |
| `/ready` 返回 503                                                         | PostgreSQL 或 Redis 未就绪                                                                           | 等待健康检查，或重启 `docker compose up -d postgres redis`                    |
| Web 请求失败                                                              | API 地址或 CORS 不一致                                                                               | 检查 `VITE_API_BASE_URL` 和 `CORS_ORIGIN`                                     |
| Agent Run 在 Compose 中失败                                               | Server 容器不能访问宿主机 Docker                                                                     | 改用宿主机执行模式                                                            |
| Local CI 报 `Cannot resolve Git commit`                                   | `workspacePath` 不是 Git 仓库或没有 commit                                                           | 初始化 Git 并提交一次，或修正 `workspacePath`                                 |
| Docker deployment failed                                                  | Docker 不可用、镜像不存在、端口占用                                                                  | 确认宿主机 Docker 可用，检查 image 和 hostPort                                |
| `ENVIRONMENT_NOT_CONFIGURED`                                              | 没有配置目标环境                                                                                     | 到「部署」保存对应 dev/staging/production                                     |
| `PRODUCTION_APPROVAL_REQUIRED`                                            | 生产部署或回滚缺少审批                                                                               | 在 Workflow Approval 面板审批                                                 |
| GHCR pull denied                                                          | 部署机器未登录 GHCR 或包不可访问                                                                     | 在部署机器配置 Docker registry 凭据                                           |
| Workflow 卡在 `WAITING_APPROVAL`                                          | 有待处理审批                                                                                         | 到工作流详情点击 批准 或 拒绝                                                 |
| 工作流任务失败：`git_status` / `git_diff` 报失败                          | 工作区不是 Git 仓库（Agent 会先检查 git 状态）                                                       | 用「目标仓库路径」指向本机已 `git clone` 的项目                               |
| 任务失败且 `agent_runs.error` 含 `INVALID_AGENT_RESULT`                   | 模型回答不是结果 JSON（系统已自动补问一次）                                                          | 查看错误里的 `answerHead` / `answerTail` 定位；偶发可直接重跑                 |
| 工具报 `cwd must stay inside the workspace`                               | `cwd` 指向了**工作区之外**的绝对路径（`/`、`/workspace`、`/workspace/…` 已自动映射为工作区相对路径） | 其余情况请用工作区相对路径（留空即工作区根）                                  |
| 工具报 `ENOENT … realpath 'file:///…'`                                    | 表单里粘进了 `file://` URL（拖拽文件夹 / 复制地址栏）                                                | 重填为纯本地绝对路径（新版控制台会自动把 `file://` 转成路径）                 |
| 创建 Workflow 时报「目标仓库路径必须是本机绝对路径」/「不存在或不是目录」 | 创建时校验：路径没以 `/` 开头、或目录不存在                                                          | 按提示改为本机绝对路径（例如 `/Users/你的用户名/projects/my-repo`）后重新创建 |
| 工具报 `Workspace path is outside the sandbox allowlist`                  | 目标仓库路径不在 `AGENT_WORKSPACE_ROOT` 范围内                                                       | 把 `AGENT_WORKSPACE_ROOT` 设成包含项目的父目录，重启 `pnpm dev`               |

## 18. 安全使用要求

不要把以下内容写入代码、PRD、Agent task、日志或数据库明文字段：

- API Key
- Token
- Password
- Cookie
- Private key
- Production Secret

生产配置只保存 Secret Reference，例如：

```text
secret://production/app
```

真实 Secret 应放在 GitHub Secrets、部署机器凭据管理、Docker credential store
或你后续接入的 Secret Manager 中。

生产部署和生产回滚必须经过 Human Approval。

## 19. 当前限制

当前已经完成 Phase 6 的本地交付能力，但仍有这些边界：

- 当前项目目录本身如果不是 Git 仓库，Local CI 无法拿到 commit。
- Web 创建 Workflow 已支持可选的「目标仓库路径」（`workspacePath`）；留空时使用服务端默认工作区。
- 工作流中的 Agent 在 `workspacePath`（或服务端默认工作区）内执行；该目录不是 Git 仓库时
  `git_status`/`git_diff` 会失败，并可能按工作流策略直接判任务失败——请指向本机已 clone 的项目。
- Compose 中的 Server 不挂载 Docker socket，真实 Agent Sandbox 和本地 deployment
  建议在宿主机运行 Server。
- GitHub Actions、GHCR push、远程 staging、真实 production 需要你提供 GitHub 仓库、token、
  registry 权限和部署目标。
- 当前没有 Kubernetes、复杂云编排、AI SRE 或自动生产自愈。可观测性侧，Phase 7 已于
  2026-10-15 收口（端到端追踪 `GET /api/workflows/:id/trace` 与指标端点 `GET /api/metrics`
  已交付），但**外部栈（OpenTelemetry / Prometheus 服务端 / Grafana / Loki）未引入**，
  因此本机没有完整的可观测性栈，也没有追踪前端页面。

## 20. 推荐下一步

先用 mock 模式跑熟：

```text
项目
→ 需求
→ 分析
→ 工作流
→ Agent 运行
```

然后准备一个真实小项目，满足：

- Git 仓库已有 commit
- `pnpm install --frozen-lockfile` 可执行
- `pnpm lint` / `typecheck` / `test` / `build` 可执行
- Dockerfile 能构建镜像
- 应用提供 `/health` 和 `/ready`

再切到宿主机执行模式，配置 staging environment，执行完整交付链。

## MCP Usage

完成 Phase 5.5 后，管理员可以在「设置 → MCP 服务器」查看 MCP Server、Tool、连接状态和绑定；当前 5.5-5 Console 不提供 Server 注册/连接控制按钮，这些仍通过后端 Registry/API 或后续阶段使用。

推荐使用流程：

```text
Open MCP Console
    ↓
Review Server / Status / Tools
    ↓
Manage Project / Agent Binding
    ↓
Review Tool Risk
    ↓
Agent uses Tool
    ↓
Tool Runtime Policy
    ↓
MCP Server
```

如果 Tool 未绑定、未启用或 Policy 不允许，Agent 不会获得该 Tool。

### Visual UI Reproduction

Visual Engineering 目标为支持 Screenshot/Figma/URL 驱动的 UI 还原。当前 Phase 5.6 仍处于 PARTIAL：视觉契约、分析基础、Browser、Evaluation 和 FixLoop 数据模型已存在，但真实 Frontend Agent 改码、完整自动修复、真实多源输入和完整 UI State Validation 尚未全部完成。
