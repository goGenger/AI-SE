# CI/CD and Deployment

> ## 基线状态（2026-10-15 逐条核实）
>
> 本文写于**平台实现之前**（第一版路线图的 CI/CD 设计）。**正文前半是设计、末尾「当前 Phase 6 实现」一节是有意保留的 as-built 附录**——那一节**六条全部核实为真**。下面是对照现状的核实表：
>
> | 本文条款 | 与当前实现的关系 |
> | --- | --- |
> | CI 流水线「Install → Lint → Typecheck → Unit Test → Build → Docker Build → Push Registry」 | **已实现且逐步对上**：`.github/workflows/ci.yml` 依次跑 `pnpm install --frozen-lockfile` → `lint` → `typecheck` → `test` → `build`，随后 buildx 构建镜像并在非 PR 时推送。**没有缺项也没有多余步骤** |
> | CD 链「dev → **staging → E2E → approval** → production」 | **不成立**。**没有 `E2E` 这个环境**——环境取值只有 `dev` / `staging` / `production`（`DeliveryEnvironmentSchema`，DDL 里也有 CHECK 约束）。**也不存在 `dev→staging→E2E→production` 的自动编排**。真实存在的门是：**production 的 DEPLOY / rollback 需要人工批准，staging DEPLOY 自动批准** |
> | 「第一版不使用 Kubernetes」 | **成立**：k8s 只出现在两处——被阻断的命令正则，以及一条**告诉 Agent 不要引入 Kubernetes** 的提示词。没有 manifest、没有 client、没有部署路径 |
> | Deployment 记录 10 个字段 | **全部存在，且已大幅扩张**。10 个字段一个不缺；另有 `workflowRunId` / `taskId` / `agentRunId` / `ciRunId` / `gitCommit` / `operation` / `endpoint` / `rollbackDeploymentId` / `rollbackReason` / `rollbackAt` / `error` / `idempotencyKey` / `createdAt` / `updatedAt`。TS 侧 camelCase、SQL 侧 snake_case |
> | 「应用提供 `GET /health` 与 `GET /ready`」 | **两个都真实现了，不是占位**：`/health` 返回 `{status:"ok"}`；**`/ready` 真的探 DB 与 Redis，任一下线即 503** |
> | 部署失败流「Health Check Failed → Deployment Failed → Rollback Previous Version → Health Check」 | **流程真实，但是有条件的**：health check 失败 → deployment 置 `FAILED` → 生成回滚任务 → 回滚后重跑 `/health` + `/ready`。**自动回滚只在工作流声明 `deployFailureStrategy: "ROLLBACK"` 时触发**——默认策略是 `FAIL_FAST`，不声明就不会自动回滚。有端到端测试覆盖（断言 `ROLLBACK_TASK_CREATED` 与回滚成功） |
> | 「Production 默认需要人工批准」 | **成立，且在编排器里硬拦**（不只是策略字段）：production 的 DEPLOY 与 production 的 rollback 在没有 APPROVED 审批时直接拒绝（`PRODUCTION_APPROVAL_REQUIRED`）。**这道门独立于 `approvalRequired`**（后者默认 false） |
> | 「当前 Phase 6 实现」六条 | **六条全部为真**，逐条核对：① `ci.yml` 用 Node 22 / pnpm 12.3.4 / GHCR 不可变 SHA tag ✓；② `DeploymentOrchestrator` 经 Tool Runtime 调 `run_ci` / `deploy_release` / `verify_release` / `rollback_release`，适配器为 GitHub Actions / 本地 CI + 本地 Docker ✓；③ CI Run / Environment / Deployment / Log 与回滚关联均落 PG，重复 deploy/rollback 经 `ON CONFLICT (idempotency_key)` 返回既有记录 ✓；④ `/health` 与 `/ready` 都过才判 SUCCESS ✓；⑤ `ROLLBACK` 策略为失败 DEPLOY 建 Dynamic Rollback Task，由引擎决策调度 ✓；⑥ 工作区没有 Git 仓库 / token / registry login / 远程环境，外部 GitHub / GHCR / production E2E **未执行**，而**本地真实 Docker 交付与回滚 E2E 已执行**（`apps/server/src/__tests__/deliveryLifecycle.e2e.test.ts`，真调 `docker`）✓ |
>
> **⚠️ 两处读起来像已接线、实际没接线的地方**（本文最容易误导人的部分）：
> 1. **「Push Registry」在本工作区是空的**。平台自己的本地 CI 路径**只跑 `docker build`，没有 `docker push`**；`imageRepository` 只是**算出**一个 `ghcr.io/...` 名字。真正的 GHCR 推送只存在于**从未执行过**的 GitHub workflow 里（本工作区无 Git 仓库）。
> 2. **「production」目前是个标签，不是真实的远程目标**。唯一的部署适配器是 `LocalDockerOperations`——部署到**本机 Docker** 的 18000 端口；环境表还把 `adapter` 硬约束为 `IN ('docker')`。
>
> **结论**：**末尾的 as-built 附录比正文前半更可信**——六条全真。正文前半里 **CD 链那条是错的**（没有 E2E 阶段），**失败自动回滚是有条件的**（要声明 `ROLLBACK`），而 **registry 推送与生产部署是「文档里有、本工作区没接线」**。引用本文讨论交付能力时，以 `apps/server/src/services/deploymentOrchestrator.ts` 与 `deliveryAdapters.ts` 为准。
> 依据：`AGENTS.md` §9「代码权威于文档；冲突必须报告，禁止默默改任一方来对齐」。

## CI

推荐 GitHub Actions：

```text
Install
→ Lint
→ Typecheck
→ Unit Test
→ Build
→ Docker Build
→ Push Registry
```

## CD

```text
dev → staging → E2E → approval → production
```

第一版不使用 Kubernetes，可使用 Docker + 云服务器或 Container Service。

## Deployment

记录：

```text
id
projectId
version
environment
image
status
startedAt
finishedAt
healthCheck
rollbackVersion
```

应用提供：

```text
GET /health
GET /ready
```

部署失败：

```text
Health Check Failed
→ Deployment Failed
→ Rollback Previous Version
→ Health Check
```

Production 默认需要人工批准。

## 当前 Phase 6 实现

- `.github/workflows/ci.yml` 使用 Node 22、pnpm 12.3.4、GHCR immutable SHA tag。
- `DeploymentOrchestrator` 通过 Tool Runtime 调用 GitHub Actions 或本地 CI adapter，以及 Docker deployment adapter。
- PostgreSQL 保存 CI Run、Environment、Deployment、Log 和 rollback 关联；重复 deploy/rollback 使用 idempotency key 返回已有记录。
- `/health` 与 `/ready` 均通过后才判定 Deployment SUCCESS。
- `ROLLBACK` Workflow policy 会为失败的 DEPLOY 创建 Dynamic Rollback Task，由 Workflow Engine 决策和调度。
- 当前工作区没有 Git repository、GitHub token、Registry login 或远程环境，因此外部 GitHub/GHCR/production E2E 未执行；本地真实 Docker delivery/rollback E2E 已执行。
