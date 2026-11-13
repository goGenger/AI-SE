# 251 · 自治失败覆盖扩展实施记录（AFC-M1 … AFC-M5）

> 状态：**已落地**（2026-11-05 Asia/Shanghai）
> 任务书：`docs/250-autonomy-failure-coverage-taskbook.md`
> 用户授权：按推荐冻结 P1–P6 / D1–D5，**全量 M1–M5**（覆盖原 D6「仅 M1」推荐）。
> 约束保持：OpenCode / `LLM_PROVIDER=openai`；`CAPABILITY_PROFILE=frontend-vue`；不改 DeepSeek `.env`；不开 E1 批；生产 DEPLOY 审批不绕过。

---

## 1. 范围

把「工作流内、平台重试后仍失败」统一收敛到既有 `failureRouter` + REPLAN + `TaskVerifier` 链：

| 里程碑 | 内容 |
| --- | --- |
| AFC-M1 | 客观收尾闸：enforce 下自报 SUCCESS + 客观红证据 → 强制 FAILED |
| AFC-M2 | 失败类标签与路由表：`GATE_FAILURE` / `DEPENDENCIES_MISSING` / `AGENT_TIMEOUT` / `INFRA_RETRY_EXHAUSTED` / `SPEC_CONFLICT` |
| AFC-M3 | Agent 超时与瞬时错误映射为可路由码，进入 REPLAN；`maxRetries: 2` 锁死 |
| AFC-M4 | 跨 OS `node_modules`：空 `.bin` / native 不齐必 heal；heal 失败 → `DEPENDENCIES_MISSING` |
| AFC-M5 | 工作流详情展示自治修复轮次 / 失败类 / 一行证据；耗尽可读 |

**不在范围**：生产 DEPLOY 绕过、第二套引擎、E1 过夜评测、关口 1 产品范围。

---

## 2. 决策落地

| # | 冻结值 | 落地 |
| --- | --- | --- |
| D1 | 切片 enforce | `SLICE_WORKFLOW_POLICY` = L1 → `VerifyingWorkflowTaskExecutor.modeFor` enforce |
| D2 | SUCCESS+红 → FAILED+REPLAN | `objectiveClosingOverride` + 既有 `createAutonomyFailureRouter` |
| D3 | 超时进自治，不盲加长 900s | `resolveRunFailureErrorType` → `AGENT_TIMEOUT` → REPLAN |
| D4 | `maxRetries: 2` | 未改；单测锁 `repair-exhausted` |
| D5 | infra → `INFRA_*` + 有限 REPLAN | 分类 + 提示模板；耗尽 FAIL |
| D6 | **全量 M1–M5**（用户覆盖） | 本记录 |

---

## 3. 改动文件

| 文件 | 作用 |
| --- | --- |
| `apps/server/src/services/gateFailureRepair.ts` | 分类、客观红证据、收尾闸、路由 payload（attempt/evidence） |
| `apps/server/src/services/verifyingTaskExecutor.ts` | 接客观收尾闸 |
| `apps/server/src/services/workflowTaskExecutor.ts` | `timed_out`/`TIMEOUT_ERROR` → `AGENT_TIMEOUT` |
| `apps/server/src/services/taskVerifierRules.ts` | `type-check` 别名；lint+typecheck 双跑；`.bin` 探针 |
| `apps/server/src/services/taskVerifier.ts` | heal/缺依赖无 checks 也 fail-closed `DEPENDENCIES_MISSING` |
| `packages/workflow-engine/src/types.ts` | `FailureRoute` 增 `attempt` / `evidenceSummary` / `errorType` |
| `packages/workflow-engine/src/WorkflowEngine.ts` | `FAILURE_ROUTED` 写入上述字段 |
| `apps/web/src/viewmodels/workflowViewModel.ts` | `deriveAutonomyRepairProgress` |
| `apps/web/src/views/WorkflowsView.vue` | 详情自治修复横幅 |
| `apps/server/src/__tests__/gateFailureRepair.test.ts` 等 | AFC-1/2/3/4/5/6/8/9/10 |
| `docs/250-…` / 本文件 | 任务书 + 实施记录 |

---

## 4. 验收 AFC-1 … AFC-10

| ID | 结果 | 证明 |
| --- | --- | --- |
| AFC-1 | ✅ | `objectiveClosingOverride` + `gateFailureRepair.test.ts` SUCCESS+红 → FAILED |
| AFC-2 | ✅ | 全绿摘要不覆盖 |
| AFC-3 | ✅ | Approval withheld → enter REPLAN + evidenceSummary |
| AFC-4 | ✅ | exit 127 / rollup → `DEPENDENCIES_MISSING` + install 提示 |
| AFC-5 | ✅ | `AGENT_TIMEOUT` → REPLAN |
| AFC-6 | ✅ | `executionAttempt >= maxRetries` → `repair-exhausted` / FAIL |
| AFC-7 | ✅ | 空 `.bin` / `binOk:false` → probe false；live 夹具 |
| AFC-8 | ✅ | `deriveAutonomyRepairProgress` + Workflows 横幅 |
| AFC-9 | ✅ | 耗尽文案含 repair-exhausted + 证据 |
| AFC-10 | ✅ | production DEPLOY router `undefined` |

单测（Node 22）：`gateFailureRepair` + `outcomeRouting` + `taskVerifierRules` **109/109**；`workflowViewModel` **28/28**。未开真实整单交付批。

---

## 5. Known Issues

1. **需求详情页**未直接嵌工作流修复横幅（工作流详情已有）；切片卡仍靠「打开工作流」查看轮次。
2. **客观红证据**依赖自报正文关键词（TASK-06 类）；纯沉默 SUCCESS 且 verifier 跳过 test（N-47 无 acKeys）仍可能漏——M1 已用 type-check 双跑与 SUCCESS 正文闸补一刀，未取消 N-47。
3. **frontend-vue** 无 `BACKEND` checks：DATABASE 无迁移回退在该 profile 下为空计划；测试已显式传 `BACKEND_NODE_PROFILE`。
4. ~~未提高 900s 单次超时（D3）~~ **已提高**：`TASK_TIMEOUT_MS` 默认 **1800s**（2026-11-06，taskflow-vue v8）；超时仍进自治（AGENT_TIMEOUT → REPLAN），加长不替代自治。
5b. **DEBUG 收尾观察态**：诊断任务跑检查只记证据，不以产品 test/type-check 红覆盖诊断 SUCCESS（避免卡住 `-REPLAN-N` 依赖边）。

5c. **fixTaskType 驱动 REPLAN 类型**（2026-11-06，taskflow-vue v8）：诊断/REPLAN_REQUESTED 给出的能力面允许的 `fixTaskType`（如 FRONTEND）决定动态修复任务类型，不再克隆 TEST；DEBUG 交接可 `REPLAN_TYPE_RETARGETED` 纠正兄弟 REPLAN；耗尽时若尚未 `typeSwitchUsed` 且推荐类型不同，允许一次类型切换而不立即 `repair-exhausted`。越权类型（frontend-vue 下 BACKEND/DATABASE）忽略并回退 `fixFallback`。
5d. **thrash fix：重试不再叠跑已成功修复链**（2026-11-07，taskflow-vue v8）：
   - `resolution.isSupersededBySuccessfulPredecessor` + `retryableFailedTasks`：若 REPLAN-1 已 SUCCESS 仍指向后续 REPLAN-2，则 REPLAN-2（FAILED/CANCELLED）视为已被接替；人工 `retry()` 只重排每条链最上游未解决失败，避免 T-05 + REPLAN-1 + REPLAN-2 同轮空烧。
   - `AgentGraph` 在 `iteration >= maxIterations - 2` 时注入一次 `budget_conclude_nudge`（同形空回复重问），要求立刻 `submit_result`/结果 JSON。**DeepAgent** 常在单次 `invoke` 内跑完内层循环，外层看不到逐步 iteration，此 nudge 主要覆盖经典图路径；生产 FRONTEND 仍以 DeepAgent 为主——叠跑修复靠上条调度修复止血。
   - 工作流 `d30eeea0` 现为 **CANCELLED**：`retry()` 仅接受 FAILED，**不能**对 CANCELLED 重试；产品代码已绿时请新开切片工作流，勿指望对本 CANCELLED 点重试。

5e. **夹具写权限与失败子类 `TEST_FIXTURE_GAP`**（2026-11-09，taskflow-vue v9 AC-15）：
   - 根因：FRONTEND `writeTestFiles` 可写测试，但 `readPaths` 缺 `tests/`，且指令写「Existing test files are read-only」——装配测缺 `createPinia()` 时自治读不到/不敢改夹具，只能空烧产品代码；anti-tamper 只拦断言改弱，本不拦加 Pinia。
   - 落地：FRONTEND/BACKEND/DATABASE `readPaths` 含 `test`/`tests`/`__tests__`；`writeTestFiles` 时读侧对称放行测试路径；指令允许修装配/夹具 harness，仍禁改弱断言；`classifyAutonomyFailure` 识别 getActivePinia 等 → `TEST_FIXTURE_GAP`，同类型 REPLAN + fixture hint；`writeScopeAudit` 实现类并入 `TEST_PATH`（与强制写权限对齐）。生产 DEPLOY 审批与 anti-tamper 不变。


5. 旧 `FAIL_FAST` 切片仍靠 router 升级；新切片默认 `SLICE_WORKFLOW_POLICY`。

6. **WorkflowEngine 缺省回退测试**：产品默认 `frontend-vue` 后，缺省 `fixFallback` 为 `FRONTEND`；已对齐 `WorkflowEngine.test.ts` 中仍写 BACKEND 的过时断言（非行为回退）。

---

## 6. Risks

- 客观红关键词过宽可能误杀「提到失败但已修好」的 SUCCESS → 已用更严 `OBJECTIVE_RED_PATTERNS`（相对 `hasActionableFailureEvidence`）。
- lint+type-check 双跑增加门禁耗时（通常可接受）。
- `FAILURE_ROUTED` 新字段对旧 UI 只读忽略，兼容。

---

## 7. 用户如何低成本验证

1. 硬刷新 `http://localhost:4399/workflows`，打开任一带历史 `FAILURE_ROUTED` 的工作流，应见修复横幅或事件里的失败类/轮次/证据。
2. 跑单测：`pnpm --filter @ai-se/server exec vitest run src/__tests__/gateFailureRepair.test.ts`（勿开过夜 F1）。
3. 新开切片工作流：故意让 Agent 超时或门禁红 → 应出现 `FAILURE_ROUTED` + `*-DEBUG-*`/`*-REPLAN-*`，而不是整单直接死掉后等人点重试。
4. 生产 DEPLOY 审批路径不变（单测 AFC-10）。
