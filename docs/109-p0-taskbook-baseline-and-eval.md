# 109 · P0 阶段任务书：基线与评测夹具（T0）

> 来源：《AI-SE 平台加固任务书 v1》T0 + `docs/108-hardening-remediation-plan.md` §4 P0。
> 编号说明：**109 = 本任务书**；实施完成后，实施记录与基线报告写入 **`docs/110-p0-baseline-record.md`**（不占用 109，也不覆盖任何既有文档）。

## 使用方式

1. 先读本任务书全文，再回复「开始实施」或直接指出要改的地方；**未确认前不动代码**。
2. 实施期间发现范围外问题：只登记、不顺手修。
3. 实施完成后按 §完成后 输出报告并 **STOP**（不自动进入 P1）。

## 严格范围

**做：**

1. 一个可复用的评测执行器（harness）：一条命令跑完整个评测集，产出 JSON 结果 + 汇总报告。
2. 首版 **8 个固定评测夹具**（S 档 3 个、M 档 3 个、L 档 2 个），每个夹具 = 工作区模板 + 需求文案 + **Agent 不可见的 oracle**。
3. 指标采集与汇总：真成功率 / 自报成功率 / **假阳性率** / token·成本·耗时 / 人工介入次数 / **解析降级率** / 失败原因分布。
4. 连续两次完整评测的**噪声线**记录。

**禁止：**

- 不改平台任何生产代码（`apps/server`、`packages/*` 的非评测部分、`apps/web`）——本阶段只**新增**评测能力，不修被测对象。
- 不新增依赖（harness 只用 Node 标准库 + HTTP + `tsx`；夹具工作区零依赖）。
- 不新增顶层目录、不改动 `docs/1`–`docs/108`。
- 不绕过既有入口：评测必须经 **REST API**（`/api/*`）驱动，不得直连数据库写入、不得调用内部函数构造状态。
- 不触碰开发库既有项目数据（只创建带 `[eval]` 前缀的项目；清理只允许删自己创建的）。

## 必读清单

**文档**：`docs/108`（本计划 §2 现状核对、§4 P0）、`docs/19-user-manual.md`（控制台流程语义）、`docs/17`（验收清单口径）、`docs/101`–`docs/107`（近期失败语义与守卫，决定指标字段含义）。

**代码（落点与契约）**：

- `apps/server/src/routes/{projects,planning,workflows}.ts` —— 评测驱动面：`POST /api/projects`、`GET /api/projects`、`DELETE /api/projects/:id`、`POST /api/projects/:projectId/requirements`、`POST /api/requirements/:id/analyze`、`GET /api/requirements/:id`、`GET /api/requirements/:id/tasks`、`POST /api/workflows`、`POST /api/workflows/:id/start`（action 路由）、`GET /api/workflows/:id`、`GET /api/workflows/:id/tasks`。
- `packages/shared/src/index.ts` —— `CreateWorkflowSchema`（含 `planningVersion`，`.strict()`）、`WorkflowPolicySchema`（maxConcurrency / maxRetries / failureStrategy / allowRetry / allowReplan / approvalRequired）。
- `packages/tool-runtime/src/tools/commandTools.ts` —— `run_unit_test` 默认 `pnpm test`、`run_build` 默认 `pnpm build`：**夹具脚本必须提供 `test` / `build` / `lint`，且零依赖可跑**。
- `packages/agent-core/src/professional/ProfessionalAgent.ts` —— `answerLength` / `answerHead` / `answerTail` / `answerText` / `parseRecovery` / `errorType` 的来源（降级率与失败分布的判据）。
- `apps/server/src/services/workflowTaskExecutor.ts` —— 任务 `output` 白名单（指标字段以实际落盘为准）。
- `AGENTS.md` §2/§3/§5（目录与测试规则）、§10（架构红线）。

## 架构判定（默认已定，可逐条否决）

1. **harness 落点**：新增 workspace 包 `packages/eval`（按仓库新包配方：mirror `packages/tool-runtime/{package.json,tsconfig.json}` + `corepack pnpm install --no-frozen-lockfile`）。理由：长生命周期工具、需要单元测试与门禁纳入、与产品包隔离。**备选**：`apps/server/src/eval/`（零新包，但会进入 server 构建产物）。
2. **驱动方式**：只走 REST（`EVAL_BASE_URL`，默认 `http://127.0.0.1:3000`）。不导入任何 workspace 包、不直连数据库。
3. **固定计划**：每个夹具的规划**只跑一次**（`POST /analyze`），记录 `planningVersion` 并在 3 次运行中复用；`--replan` 才重新规划。理由：规划是 LLM 非确定性来源，评测要评「执行」而不是每次重规划。夹具项目**不绑定 Git 仓库**（因此规划期守卫会自动排除 CI/部署链，见 docs/107）。
4. **夹具工作区**：模板存于 `packages/eval/fixtures/<id>/template/`；运行时复制到 `<EVAL_WORKSPACE_ROOT>/<fixtureId>/run-<n>`（默认 `EVAL_WORKSPACE_ROOT=$HOME/Desktop/study/ai-se-eval`，**必须落在平台 `AGENT_WORKSPACE_ROOT` 允许范围内**），复制后 `git init` + 初始提交（Agent 工具依赖 git 仓库，否则 `git_status` 必然失败）。
5. **oracle 不可见**：oracle 脚本放在 harness 包内，运行时以「工作区外 cwd + 工作区路径参数」执行，不复制进工作区、不出现在任务提示词中。判据：oracle 退出码为 0。
6. **评测策略冻结**：`{ maxConcurrency: 1, maxRetries: 1, failureStrategy: "RETRY", allowRetry: true, allowReplan: false, approvalRequired: false }`。理由：P0 只测执行基线，并发/重规划变量留给 T3/T1 之后的阶段；`maxConcurrency: 1` 规避 docs/108 §2 指出的共享工作区冲突。
7. **指标定义（冻结）**：
   - 真成功率＝oracle 退出码 0；自报成功率＝任务 `status=SUCCESS`；
   - **假阳性率＝自报成功且 oracle 失败**；
   - 解析降级率＝`task.output.parseRecovery` 非空的 run 占比；
   - 人工介入次数＝工作流事件中 `FAILURE_HUMAN_REQUIRED` / 审批类事件计数；
   - 失败原因分布＝`task.output.errorType` 计数（TIMEOUT / EMPTY_FINAL_ANSWER / INVALID_AGENT_RESULT / VERIFICATION_FAILED / 其它）；
   - 成本/耗时＝`agent_runs.tokenUsage` / `estimatedCost` / `duration` 汇总。
8. **夹具依赖**：零依赖（`node --test`、`node --check`），`package.json` 只写脚本，不需要 `pnpm install`。L 档不做真实前端构建（无 bundler），以「跨 3+ 文件的服务/CLI 功能 + 端到端脚本」表达复杂度——这是刻意简化，写进记录。

## 交付物

1. `packages/eval/`：`package.json`（`start`/`test`/`lint`/`typecheck`/`build`）、`tsconfig.json`、`src/cli.ts`、`src/harness.ts`、`src/metrics.ts`、`src/oracle.ts`、`src/report.ts`、`src/types.ts`。
2. 夹具：`packages/eval/fixtures/<id>/{fixture.json,template/**,oracle.mjs}`，首版 8 个（S3/M3/L2）。`fixture.json` 形如：
   ```json
   {
     "id": "S1",
     "tier": "S",
     "title": "补全 slugify 函数",
     "requirementText": "……（提交给平台的需求原文）",
     "oracle": { "command": "node", "args": ["oracle.mjs"] }
   }
   ```
   oracle 调用约定（冻结）：harness 以 `cwd = packages/eval/fixtures/<id>`（夹具目录，与工作区完全隔离）启动 `command args…`，并**追加一个参数**：目标工作区绝对路径（oracle 读 `process.argv[2]`）。oracle 只读工作区、不修改它。
3. 结果产物：`packages/eval/results/<timestamp>.json`（含每次运行记录与汇总）+ `docs/110-p0-baseline-record.md`（基线报告 + 噪声线）。
4. 根 `package.json` 增一条 `"eval": "pnpm --filter @ai-se/eval start"`。

**运行记录形状（冻结，供后续阶段复用）**：

```ts
interface EvalRunRecord {
  fixtureId: string;
  tier: "S" | "M" | "L";
  runIndex: number;
  workflowId: string;
  workspacePath: string;
  taskCount: number;
  taskStatuses: Record<string, number>;
  reportedSuccess: boolean;
  oraclePassed: boolean;
  falsePositive: boolean;
  parseRecoveryRuns: number;
  humanInterventions: number;
  tokenUsage: { input: number; output: number } | null;
  estimatedCostUsd: number | null;
  durationMs: number | null;
  errorTypes: Record<string, number>;
  failureSummary: string | null;
}
```

## 测试要求

1. **单元测试**（`packages/eval/src/__tests__/`，集中式约定）：指标计算（假阳性/降级率/失败分布）、oracle 判定（退出码 0/非 0）、报告汇总与噪声线（两次结果差值）、夹具清单校验（8 个夹具齐备、template 存在、oracle 存在）。
2. **harness 可注入**：HTTP 与进程执行通过参数注入（便于单测用假实现），真实运行走默认实现。
3. **一次真实冒烟**（集成证据，必须做）：`pnpm eval -- --fixtures S1 --runs 1` 跑通，产出 JSON；把「真实跑过」的证据（workflowId、oracle 退出码、指标值）写进 docs/110。
4. **两次完整评测**：`pnpm eval`（8 夹具 × 3 次）连跑两遍，记录指标波动 = 噪声线。
5. 门禁：`corepack pnpm --filter @ai-se/eval typecheck && lint && test`；全仓 `pnpm -r --no-bail run test` 无新增失败；变更文件 `prettier --check` 干净。

## 边界红线

- Tool Runtime 唯一执行路径、执行经 Sandbox、禁止第二套 Permission/Approval/Audit —— 本阶段不新增任何执行路径（评测只经 REST 触发既有链路）。
- 任何凭据（API key / 连接串）不得写入结果 JSON、日志或 docs。
- 评测运行会真实消耗模型额度（OpenCode Go 订阅）：首版预计 8 夹具 ×（1 次规划 + 3 次执行）≈ 单次全量成本可观测，运行前在记录中写明预估。
- 不修改开发库既有项目；只创建/清理 `[eval]` 前缀项目。
- 超时保护：单次运行有全局上限（建议 20 分钟/夹具），超时记为 `timeout` 而不中断整批。

## 完成后

1. 输出报告（中文）：变更文件清单 + 时间戳、8 夹具指标总表、噪声线、一次真实冒烟的原始证据、门禁结果、已知限制。
2. 写 `docs/110-p0-baseline-record.md`（实施记录 + 基线报告）。
3. **STOP**：不进入 P1（确定性验证门）；等用户指令。

## 验收对照表（docs/108 §4 P0 → 本任务书）

| docs/108 P0 要求                                   | 本任务书对应                                               |
| -------------------------------------------------- | ---------------------------------------------------------- |
| 8–12 个固定任务（S/M/L 三档）                      | §严格范围 2、§交付物 2、§架构判定 8（首版 8 个：S3/M3/L2） |
| 每个任务配 Agent 不可见的 oracle                   | §架构判定 5、§测试要求 1                                   |
| 每任务跑 3 次以上                                  | §交付物 3、§测试要求 4                                     |
| 七项指标（真/自报/假阳性/成本/介入/降级/失败分布） | §架构判定 7（冻结定义）                                    |
| 一条命令跑完整评测，结果 JSON + 汇总报告           | §交付物 1/3/4、§测试要求 3                                 |
| 两次连续评测的噪声线                               | §测试要求 4、§交付物 3                                     |
| 不污染开发库既有数据                               | §严格范围禁止项、§边界红线                                 |
