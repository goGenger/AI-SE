# 215 · PL-M32 实施记录（N-31：交付分派改由 `input.delivery` 决定）

> 阶段：**PL-M32** ｜ 发现场：批次 `l1-m4s` run 1 / run 2（`docs/216` 待写）
> 用户 2026-10-22 直接指令「修 N-31」。
> **未在真实批次验证 ⇒ 不判「已关闭」。**

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `apps/server/src/services/deploymentOrchestrator.ts` | 修改 | `canHandle` 改为**只按 `input.delivery` 是否合法**判定，删除 `task.type` 三元配对 |
| `packages/workflow-engine/src/WorkflowEngine.ts` | 修改 | `isAutoApprovedStagingDeploy` 同步去掉 `task.type !== "DEPLOY"` 前提 |
| `apps/server/src/__tests__/deliveryRouting.test.ts` | 新增 | **5 个用例**，直接守住 `canHandle` 的接线 |
| `docs/215-phase-pl-m32-delivery-dispatch-by-contract.md` | 新增 | 本文件 |

**零依赖改动、零 migration、零新错误码。**

---

## 2. Implementation

### 2.1 缺陷（库内实证，不是形状推断）

批次 `l1-m4s` 的最终切片（`slice-5-ui-deploy`）规划出：

```
TP-12   type=REVIEW   input.delivery = { action: "VERIFY", environment: "staging" }
```

旧的 `canHandle` 要求 `TEST` + `VERIFY` 配对 ⇒ 返回 **false**。查库确认执行者：

| 任务 | 类型 | delivery | 执行者 runtime |
| --- | --- | --- | --- |
| TP-10 | BUILD | CI | `delivery-orchestrator` |
| TP-11 | DEPLOY | DEPLOY/staging | `delivery-orchestrator` |
| **TP-12** | **REVIEW** | **VERIFY/staging** | **`professional-deep-agent`** |
| TP-13 | DEPLOY | DEPLOY/production | `delivery-orchestrator` |

`TP-12` 的 agent 自述原文：「Reviewed the staging slice for AC-21, AC-24, AC-25, AC-26 and AC-29
**without modifying any file**」——**一次代码评审，不是一次验证**。

**危害不是失败，是假成功**：任务记 SUCCESS，而 `packages/eval/src/harness.ts:150-160` 的
`collectStagingSegment` **只看任务状态与 `input.delivery`、不看类型、也不核对执行者** ⇒
staging 段的 `verify` 读数变成 SUCCESS。**L1-8 的 staging 判据会因此永久不可信。**

`l1-m4s` 里 **run 1 与 run 2 各出现一次**（2/2），不是偶发。

### 2.2 改动

```ts
// before
canHandle(task: Task): boolean {
  const delivery = DeliveryTaskSchema.safeParse(task.input.delivery);
  return (
    delivery.success &&
    ((task.type === "BUILD" && delivery.data.action === "CI") ||
      (task.type === "DEPLOY" && ["DEPLOY", "ROLLBACK"].includes(delivery.data.action)) ||
      (task.type === "TEST" && delivery.data.action === "VERIFY"))
  );
}

// after
canHandle(task: Task): boolean {
  return DeliveryTaskSchema.safeParse(task.input.delivery).success;
}
```

**依据**：`DeliveryTaskSchema`（`packages/shared/src/index.ts:563-579`）已经把 `action` 限死在
`CI|DEPLOY|VERIFY|ROLLBACK`、并且非 CI 必须带 `environment`、且是 `.strict()`。**通过它就是一份
合法的交付契约**——`task.type` 在这件事上从不是语义来源。

这与 N-23 的裁定同源（`docs/200`）：`input.delivery` 是**契约**，不能因为 `type` 变化而**悄悄作废**。
N-23 修的是 replan 侧把 `type` 换掉；本条修的是**分派侧**从不看契约。

### 2.3 为什么顺带改 `isAutoApprovedStagingDeploy`

```ts
// before: if (task.type !== "DEPLOY") return false;
// after : 只看 parsed.data.action === "DEPLOY" && environment === "staging"
```

**不是顺手优化，是必须同步。** 改完 `canHandle` 之后，一个挂在别的类型上的 staging DEPLOY
会**由编排器执行**，却仍因类型不匹配**等一个人审**——那正是 N-31 的同类失效（契约与判定面不同源）。
两处现在都以 `input.delivery` 为唯一依据。

**production 的审批门没有动**（L1-9 红线）。

---

## 3. Architecture Changes

「谁是交付任务」的判定面从 **`task.type` 配对** 收敛到 **`input.delivery` 契约**，在两处
（执行分派、staging 自动放行）统一。

**没有**新增第二套判定：仍是 `DeliveryTaskSchema` 一份定义。

---

## 4. Dependencies

**无新增、无升级、无删除。**

---

## 5. Tests

**新增 `apps/server/src/__tests__/deliveryRouting.test.ts`（5 条）**：

| 用例 | 断言 |
| --- | --- |
| **REVIEW + VERIFY/staging**（现场形状） | `canHandle === true` |
| 既有配对不变（TEST+VERIFY / BUILD+CI / DEPLOY+DEPLOY） | `true` |
| **类型不参与判定**：BACKEND/FRONTEND/DATABASE/ANALYSIS/DESIGN + VERIFY 或 DEPLOY | `true` |
| 无交付块（BUILD/TEST/REVIEW） | `false` |
| 交付块不合法（缺 environment / 未知 action / 多余字段） | `false` |

**为什么测 `canHandle` 本身而不是抽出来的纯函数**：PL-M30 的教训——抽出的判定函数全绿而接线
被完整退回。这里直接构造 `DeploymentOrchestrator` 调 `canHandle`，**退回旧实现就会红**。

**门禁**：

| 包 | typecheck | lint | test |
| --- | --- | --- | --- |
| `@ai-se/workflow-engine` | ✅ exit 0 | ✅ exit 0 | **68 / 68** |
| `@ai-se/server` | ✅ exit 0 | ✅ exit 0 | **344 / 344**（由 339 增至 344，即 +5） |

**⚠️ 抖动如实记录（`docs/145` #7 / `docs/155` / `docs/160` 既有清单）**：全量 server **第 1 轮**
`v1GoldenScenario.e2e.test.ts` 的「server restart」用例失败（`Error: waitFor timed out`——与
`docs/160` 记录的同名抖动逐字相同）。**隔离复跑 4/4 通过**；**第 2 轮全量 344/344 全绿**。
**未弱化任何测试。** 该用例不经过交付路由判定，判为负载敏感抖动。

---

## 6. Lint / 7. Typecheck

见 §5 表：两包均 **exit 0**。

---

## 8. E2E

**未跑真实批次。** 判据（下一批验证）：

| 判据 | 内容 |
| --- | --- |
| **33a** | 最终切片的 `VERIFY` 任务执行者 runtime 是 **`delivery-orchestrator`**（不是 `professional-deep-agent`） |
| **33b** | staging 段的 `verify` 只有在**真实验证**发生时才为 SUCCESS |
| 回归 | 既有 `BUILD+CI` / `DEPLOY+staging` 仍由编排器执行（`l1-m4s` 已确认这两段是真的） |

**注意**：`packages/workflow-engine` 已重建 dist，平台服务**必须重启**才会加载（实测该进程不会
因 dist 变更自动重载）。

---

## 9. Known Issues

1. **未在真实批次验证** ⇒ 不判「已关闭」。
2. **相邻但未改的一处（有意）**：`WorkflowEngine.ts:833` 的 `deployOverride` 仍以
   `task.type === "DEPLOY"` 为条件，`:901` 的 `rollback()` 同理。**目前没有实例**——规划器对
   `action=DEPLOY` 仍一律给 `type=DEPLOY`（`TP-11`/`TP-13` 均如此），历史全库也只见过
   `REVIEW`+`VERIFY` 这一种错配。**若将来出现「`action=DEPLOY` 挂在非 DEPLOY 类型上」，本条会
   立刻生效**：那种任务现在会被编排器执行，但失败时**不会**走 `deployFailureStrategy: ROLLBACK`。
   按 `[[defect-registration-needs-code-proof]]`（无实例不改）**本次不改**，在此登记激活条件。
3. **不解决 AC-20 / AC-27**（真交付的最后两格，两次运行稳定失败的两条 Must AC）。
4. **不解决 `CHECK_TIMEOUT` × 11**（240 秒超时，`observe` 模式下被记录但不拦截）。

---

## 10. Acceptance Result

**交付物是「1 处分派判定 + 1 处同步 + 5 个接线用例 + 两包门禁全绿」。**

按仓库记账纪律判 **「已实施、未在真实批次验证」**，**不判「已关闭」**。

---

## 11. Next Phase Boundary

**未开始事项（STOP）**：

1. **`33a` / `33b` 的真实批次验证**——须重启平台后开批。
2. **harness 生产审批缺口未修**：harness 只批准**规划**类审批，最终切片的生产部署会停在
   `WAITING_APPROVAL` 直到 E1 的 `runTimeoutMs`（**2 小时**）超时。`l1-m4s` run 2 就是这样白等；
   库里还留着 3 个更早的同类遗留（10-14 / 10-19 / 10-20，已清理）。
3. **AC-20 / AC-27** 未查、未修——这是「真交付成功率 0/3」的直接原因。
4. **`CHECK_TIMEOUT` × 11** 未查。
5. **N-27 / N-28 / `fixTaskType` 校验**均未开工。
