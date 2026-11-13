# 124 · 阶段 D 实施记录（安全底线与交付闭环）

> 编号说明：阶段 D 连号 = `docs/123`（任务书）/ 本文件（实施记录）；`docs/111` §1 原定 `D = 118/119`，该区间已被视觉工作流占用（`docs/118`–`docs/122`），按「只增不改、取当前空号」规则顺延为 **123/124**。
> 状态：**D-1…D-6 全部完成**（2026-10-07）。任务书 = `docs/123-phase-d-taskbook-security-and-delivery.md`。
> 来源：`docs/111` §4 D 行 / §3 R6（部署面 API 鉴权）/ §7.3–7.4（部署目标与绑仓形态，本阶段冻结）；`docs/108` §4 P8；`docs/115` §B-1 看护项（CI 裸 pnpm / PATH）。
> 证据目录：`packages/eval/results/d/evidence/`（d1…d6 六份）。

## D-1 沙箱出口策略复核 + 出站阻断自动化证据（**已完成**）

**变更**：`packages/sandbox/src/__tests__/sandbox.test.ts`（+2 真 docker 用例：默认 limits 出站阻断；部分 limits 覆盖下仍阻断）。

**证据**（详 `evidence/d1-sandbox-egress.txt`）：

- 主动出站探针（`node -e fetch('http://1.1.1.1/')`）反向对照：`--network bridge` → exit 0（可达）；`--network none` → exit 3（阻断）——断言非空转。
- 装配路径：全仓 `"bridge"` 仅出现于 sandbox 类型定义（无生产代码设置）；`DockerSandbox` 无 `process.env` 通道；服务端装配 `index.ts:138` 不传 limits。
- 结论：**无白名单需求**（交付链在宿主机执行、沙箱无出网场景）。

**门禁**：sandbox typecheck ✓ lint ✓；测试 4/4 ✓；prettier ✓。

## D-2 注入红队夹具（**已完成**）

**变更**：

- 夹具：`packages/sandbox/src/__tests__/fixtures/injection/`（`POISONED_README.md` 注入文案 + `fake-credentials.env` 凭据形态**假值**）。
- 条款：`packages/agent-core/src/professional/untrustedInput.ts`（新，条款 + 组合函数），两处组合点应用——`ProfessionalAgent.ts`（runner systemPrompt）与 `DeepAgentLLMProvider.ts`（deep-agent systemPrompt）。
- 测试：`DeepAgentLLMProvider.test.ts`（CapturingDeepAgentModel 断言条款到达模型）；`ProfessionalAgent.test.ts`（组合断言）；`apps/server/src/__tests__/injectionRedteam.e2e.test.ts`（真沙箱 + 真 Tool Runtime）。

**证据**（详 `evidence/d2-injection-redteam.txt`）：

- 红队 e2e 2/2：外传尝试被沙箱边界阻断（320ms）；读取输出经共享 sink 后无 `sk-`/`eyJ` 明文（原文含 → 打码后无，证明夹具真实且 sink 有效）。
- 关键机制：工具层 allowlist 只按名称拦 `curl|wget|…`，红队命令用 `node -e fetch` 绕过名称拦截——**实际阻断来自沙箱网络边界**（两层各有测试）。

**门禁**：agent-core 122/122（+2）✓；server typecheck/lint ✓；prettier ✓。

## D-3 脱敏复核 + 审批复核 + 部署面 API 最小 Token 鉴权（**已完成**）

**五条持久化路径盘点与补缺**（详 `evidence/d3-redaction-and-api-token.txt`）：

| 路径                               | 结论                                                               |
| ---------------------------------- | ------------------------------------------------------------------ |
| tool_calls 输入/输出               | 已覆盖（`sanitizeObject`），随 sink 升级增强                       |
| agent_runs.output                  | 已覆盖（同上）                                                     |
| **tasks.output**                   | **缺口 → 已补**（新增 `RedactingWorkflowTaskExecutor` 出口装饰器） |
| workflow_events payload            | 已覆盖（编排器 sink），随升级增强                                  |
| 日志（pino / 部署日志 / 工具日志） | 已覆盖（pino redact + sink 升级）                                  |

**变更**：

- `packages/observability/src/index.ts`：`sanitizeLogData` 字符串分支升级为「键值形态 + 凭证形态串」双打码（全仓 53 处调用点统一增强；既有两条行为断言未变）。
- `apps/server/src/services/redactingTaskExecutor.ts`（新，18 行）+ `apps/server/src/index.ts` 接线（`Redacting(Routing(delivery, verified))`，单点覆盖 agent/交付/验证门全部执行路径）。
- **API Token**：`config.ts`（`API_TOKEN`，空=未设置）；`http/apiToken.ts`（新中间件：未配置直通；配置后 `/api/*` 需 `Authorization: Bearer <token>`，否则 401 `UNAUTHORIZED`）；`app.ts` 挂载（`/health` `/ready` 天然豁免）；web `src/api/auth.ts`（新）+ 7 个 `requestJson` 注入（`VITE_API_TOKEN`，未设置零行为变化）。
- 审批复核：交付工具 riskLevel + `assertPermission` 生产双闸 + 引擎自动 `approvalRequired`（`WorkflowEngine.ts:915`）——无缺口；D-5 实战审批（APPROVED）复证。

**测试**：observability 3/3（+1 形态打码）；server `redactingTaskExecutor.test.ts` 2/2（含 D-2 同款假值，覆盖「工具输出 → 任务结果」链路）、`apiToken.test.ts` 3/3（默认直通 / 401 双态 / 通过+豁免）、`config.test.ts`（+API Token 组）；web `auth.test.ts` 3/3 + `mcpSecurity.test.ts` 仍绿。

**已知限制**：`EventSource` 无法携带自定义头（token 开启时 SSE 通道不受保护，文档化；不引入 polyfill）；比较为简单字符串比较（最小实现）。

## D-4 E1 绑仓 + 部署环境 + 引导脚本 + 看护项复核（**已完成**）

**动作**（详 `evidence/d4-binding-and-rehearsal.txt`）：

- 演练仓库：bare `ai-se-eval/repos/e1-taskboard.git` + 工作克隆（种子 = reference 副本，首次提交 `420731e`）；**夹具本体零改动**（114 文件、mtime 保持 Sep 29）。
- 绑仓：`PUT /api/projects/f72e8999-…/repository` → `file:///…/e1-taskboard.git`（200）。
- 环境：staging `http://127.0.0.1:18080`（容器 `ai-se-e1-staging`）、production `http://127.0.0.1:18081`（容器 `ai-se-e1-production`）。
- 引导脚本：`apps/server/scripts/e1-delivery-drill.ts`（**落点偏差**：任务书预计 `packages/eval/scripts/`，实测 eval 包无法解析 `@ai-se/database`（`ERR_MODULE_NOT_FOUND`）→ 调整至 server（依赖齐备），不改 eval 依赖树；ASCII 净 + prettier 净）。
- 播种：requirement `616bca59-272c-4cf0-b38d-b752c03027b6`；plan v1 = 4 任务（CI→DEPLOY-STAGING→VERIFY-STAGING→DEPLOY-PRODUCTION）；plan v2 = 2 任务（CI→DEPLOY-STAGING）。
- 受控实例：47557 重启装载 D 代码（pid **50798**；`VERIFICATION_GATE` 缺省 off；日志 `/tmp/d-server-47557.log`）。
- 看护项（`docs/115` §B-1 转记）：服务进程 PATH 探测 → `pnpm 12.3.4` 可解析（node v22）；宿主机六步链复跑 → **SIX_STEPS_OK**（install/lint/typecheck/test 28/28/build/docker build）。

## D-5 交付链闭环演练（好版本）（**已完成**）

**首轮失败与处置（发现 1 的实证）**：workflow `32ac879b-…` 的 DEPLOY-STAGING FAILED（`/health failed`）——容器 crash-loop：`EACCES /data/.secret`（镜像 `VOLUME /data` 匿名卷 root 属主 + 容器以 `node` 运行；平台 `LocalDockerOperations` 无卷/env 支持）。处置：演练仓库补 Dockerfile 修补（`2c4e474`，`RUN mkdir -p /data && chown node:node /data`）→ 复跑为新 workflow。

**复跑（全绿）**：workflow `42b226c1-90a5-43b1-8241-fd1f82470eb3` → **SUCCESS**：

- CI:SUCCESS（六步链 + `docker build` → `ai-se-app:2c4e474…`）；
- DEPLOY-STAGING:SUCCESS（health `{/ready:200, /health:200}`）→ VERIFY-STAGING:SUCCESS；
- DEPLOY-PRODUCTION:WAITING_APPROVAL → 审批 `656ea3d2-…` **APPROVED** → SUCCESS；
- 22 条事件全链留痕（CI_STARTED→…→APPROVAL_REQUIRED→APPROVAL_GRANTED→…→WORKFLOW_COMPLETED）；
- 现场：staging/production 容器 Up、四端点 200、`/healthz {"status":"ok"}`。
- 部署动作全部由平台触发（deployments 行携带 workflowRunId/taskId/agentRunId 链）。

## D-6 冒烟失败回滚演练（坏版本）（**已完成**）

- 坏版本 `fea7e63e`（"drill: broken release"）：仅 `NODE_ENV==="production"` 时三探针 503——宿主机 CI 保持全绿（设计如此）。
- workflow `be913755-719b-49f7-b1d6-c8b4b049800c`（policy **ROLLBACK**）→ **SUCCESS**（收敛）：
  - CI:SUCCESS（坏版本镜像构建成功）→ DEPLOY-STAGING:**FAILED**（health `{/health:503}`）→ 引擎自动建 `DEPLOY-STAGING-ROLLBACK`（事件 **ROLLBACK_TASK_CREATED**）→ ROLLBACK:SUCCESS（version=上一成功 `2c4e474…`，health 200/200）→ 源行 **ROLLED_BACK** → WORKFLOW_COMPLETED（19 条事件）。
  - 收敛现场：staging 容器镜像回到 `ai-se-app:2c4e474…`、端点 200。

## 发现与登记（不顺手修）

1. **平台缺口：LocalDockerOperations 无卷/环境变量支持**——按平台部署语义（无宿主挂载）直接运行 `VOLUME` 型镜像时，匿名卷 root 属主导致非 root 应用不可写（D-5 首轮实证：`EACCES /data/.secret` crash-loop）。处置：演练仓库 Dockerfile 修补（记录在案）；**平台侧登记为待办**（若交付链需承载有状态镜像，需在 adapter 扩 volumes/env 面——独立任务书评审）。
2. **观察**：`checkEndpoint` 失败日志出现 `"/health: [object Object]"`（错误对象字符串化欠佳）。
3. **C-6 遗留结转**：超时泄漏孤儿 / 红灯误杀 / timed_out 记账缺口——维持待办，未动。
4. 既存镜像 `ai-se-app:03e45f23…`（2026-09-10）非本次产生（旧残留）。

## 门禁数字（收口复核，2026-10-07）

**全仓串行门禁**（`pnpm -r --workspace-concurrency=1`）：

- `typecheck`：**全部包通过**（TYPECHECK_ALL_OK）。
- `lint`：**全部包通过**（LINT_ALL_OK）。
- `test`（`--no-bail` 全跑）：**16 个有测试的包、1164 用例：1159 通过 + 5 失败**；5 红全部为 web 既有 eyebrow 族（`dashboardView` / `deploymentsView` / `mcpAppView` / `mcpServersView` / `projectDetailView`，与 C-5 登记一致，非本次引入）。

| 包               | 文件  | 用例                                  |
| ---------------- | ----- | ------------------------------------- |
| eval             | 5     | 22                                    |
| observability    | 1     | 3（+1）                               |
| shared           | 5     | 50                                    |
| sandbox          | 1     | 4（+2）                               |
| web              | 26/31 | 321/326（+3；5 红既有）               |
| evidence         | 1     | 9                                     |
| visual           | 6     | 83                                    |
| workflow-engine  | 3     | 35                                    |
| tool-runtime     | 2     | 12                                    |
| failure-recovery | 1     | 16                                    |
| action-policy    | 1     | 13                                    |
| agent-core       | 20    | 122（+2）                             |
| browser          | 8     | 38                                    |
| mcp              | 24    | 235                                   |
| database         | 10    | 45                                    |
| server           | 30    | 151（+3 文件 / +8 用例，均为 D 新增） |

- **server 全绿**（30/30）——首轮全量时的 `uiStateValidation.e2e` 单红为资源竞争 flake：单跑 3/3 绿 + 本次全量复跑绿，**证伪完成**。
- 变更文件 prettier 全净；`e1-delivery-drill.ts` ASCII 净（`LC_ALL=C grep` 零命中）。
- 夹具零改动复核：`packages/eval/fixtures/E1` 114 文件、reference mtime 保持 Sep 29。

**收尾状态**：

- 演练容器与镜像已清理（`docker rm -fv` ×2 + 镜像删除 ×4）；匿名卷计数 9 → 7（无异常堆积；未做全量 prune）；DB 证据（requirement/workflows/ci_runs/deployments/approvals/events）全部保留。
- 受控实例 47557 保持运行（pid 50798，health 200）；残留检查：无 `ai-se-e1` 容器、无演练镜像标签（仅存既存 `ai-se-app:03e45f23…` 旧镜像）。

## 变更文件清单（阶段 D，按模块）

- **sandbox**（10-07）：`src/__tests__/sandbox.test.ts`（+2 用例）；`src/__tests__/fixtures/injection/{POISONED_README.md,fake-credentials.env}`（新）。
- **agent-core**（10-07）：`src/professional/untrustedInput.ts`（新）；`src/professional/ProfessionalAgent.ts`、`DeepAgentLLMProvider.ts`（组合点）；测试 `ProfessionalAgent.test.ts`、`DeepAgentLLMProvider.test.ts`。
- **observability**（10-07）：`src/index.ts`（sink 升级）；`src/index.test.ts`（+1 用例）。
- **server**（10-07）：`src/services/redactingTaskExecutor.ts`（新）；`src/http/apiToken.ts`（新）；`src/app.ts`、`src/config.ts`、`src/index.ts`；测试 `src/__tests__/{apiToken.test.ts,redactingTaskExecutor.test.ts,injectionRedteam.e2e.test.ts}`（新）、`src/config.test.ts`；`scripts/e1-delivery-drill.ts`（新，演练工具）。
- **web**（10-07）：`src/api/auth.ts`（新）；`src/api/{agentRuns,agents,deployments,mcp,projects,requirements,workflows}.ts`；`src/api/__tests__/auth.test.ts`（新）。
- **证据/数据**：`packages/eval/results/d/evidence/`（6 份）；演练仓库 `ai-se-eval/repos/`（bare + 克隆，提交 420731e / 2c4e474 / fea7e63e）；DB 行（requirement 616bca59、workflows 32ac879b/42b226c1/be913755、ci_runs ×3、deployments ×3、approval ×1）。

## 完成报告（收尾，2026-10-07）

### 1. 交付总览

| 项          | 内容                                     | 状态       |
| ----------- | ---------------------------------------- | ---------- |
| D-1（T8-a） | 沙箱出口策略复核 + 出站阻断自动化证据    | **已完成** |
| D-2（T8-b） | 注入红队夹具（+ 不可信输入条款）         | **已完成** |
| D-3（T8-c） | 脱敏盘点补缺 + 审批复核 + API Token 鉴权 | **已完成** |
| D-4（N6-a） | E1 绑仓 + 环境 + 引导脚本 + 看护项复核   | **已完成** |
| D-5（N6-b） | 交付链闭环演练（好版本，含审批）         | **已完成** |
| D-6（N6-c） | 冒烟失败回滚演练（坏版本）               | **已完成** |

### 2. 验收对照（`docs/123` 验收对照表逐行）

| 来源要求                                  | 结果                                                            |
| ----------------------------------------- | --------------------------------------------------------------- |
| P8 出站策略自动化测试                     | ✓ D-1（真 docker 用例 + 反向对照）                              |
| P8 红队夹具（无出站、密钥不入日志与结果） | ✓ D-2/D-3（外传阻断 + sink 打码 + 出口装饰器）                  |
| P8 日志脱敏测试                           | ✓ D-3（sink 升级 + 每类路径测试）                               |
| P8 高危动作审批                           | ✓ D-3 复核（无缺口）+ D-5 实战 APPROVED                         |
| R6 部署面 API 最小 Token 鉴权             | ✓ D-3（默认关；3 分支测试；web 可选注入）                       |
| N6 部署闭环                               | ✓ D-4/D-5（真实 CI/镜像/容器/审批，全链 SUCCESS）               |
| N6 冒烟失败回滚演练                       | ✓ D-6（FAILED → ROLLBACK_TASK_CREATED → SUCCESS → ROLLED_BACK） |
| §7.3 部署目标=本机 Docker                 | ✓（远程目标未触达）                                             |
| §7.4 绑仓=本地 bare repo                  | ✓（file://，无凭据面）                                          |
| B 看护项（CI 裸 pnpm / PATH）             | ✓ D-4（PATH 探测 + 六步链复跑）                                 |

### 3. 未完成事项与偏差

- **偏差 1**：引导脚本落点 `apps/server/scripts/`（任务书预计 `packages/eval/scripts/`；原因：eval 包无 workspace 依赖，无法解析 `@ai-se/database`）。
- **偏差 2**：D-5 首轮失败后，演练仓库补一行 Dockerfile 修补（平台缺口登记，见「发现 1」；夹具零改动）。
- **偏差 3**：D-2 提示词条款为英文单行（任务书描述为中文；与既有 systemInstructions 语言一致）。
- **待办**：发现 1（平台卷/env 支持）、发现 2（日志字符串化）、C-6 三项结转——均登记不顺手修。

### 4. STOP

阶段 D 全部完成；**不进入阶段 E**。下一步（阶段 E：N7 端到端验收，`docs/111` §4）等待任务书授权。
