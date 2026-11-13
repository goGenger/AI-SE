# 216 · PL-M33 实施记录（N-32：harness 放行任务级审批）

> 阶段：**PL-M33** ｜ 发现场：批次 `l1-m4s` run 2（`docs/213` 之后的批次记录待写）
> 用户 2026-10-22 指令「修 harness 生产审批」。
> **未在真实批次验证 ⇒ 不判「已关闭」。**

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `packages/eval/src/harness.ts` | 修改 | 新增 `approvePendingTaskApprovals`；`waitWorkflowTerminal` 返回 `{status, interventions}` 并在 `WAITING_APPROVAL` 时逐次放行；两处调用点累加介入数 |
| `packages/eval/src/__tests__/taskApprovals.test.ts` | 新增 | **4 个用例**（接线级） |
| `docs/216-phase-pl-m33-harness-task-approval.md` | 新增 | 本文件 |

**零平台代码改动、零依赖、零 migration。**

---

## 2. Implementation

### 2.1 缺口

`waitWorkflowTerminal` 轮询到工作流进入终态（`SUCCESS` / `FAILED` / `CANCELLED`）为止，超时返回
`TIMEOUT`。而 harness **只批准规划类审批**（`approvePendingPlanningReview`，作用于
`/api/requirements/:id/slices` 的关口），**任务级审批无人处理**。

最终切片的交付链里有 `production DEPLOY`（提示词明确要求「Production deployment must be
human-approved by the Workflow Engine」，L1-9 红线）⇒ 工作流停在 `WAITING_APPROVAL`
⇒ harness 一直等到 E1 的 `runTimeoutMs`。

**实测**：

| 现场 | 结果 |
| --- | --- |
| `l1-m4s` run 1（`3e8785a3`） | 停 67 分钟；由我**手动** `POST /api/approvals/:id/approve` 才收口 |
| `l1-m4s` run 2（`6a7da6ee`） | 停下后无人处理，**跑满 2 小时**（`runTimeoutMs = 7200000`）判 TIMEOUT |
| 更早的遗留 | 库里还留着 `57f98bf9`（10-14，**卡 7 天**）、`716eb98d`（10-19，2 天）、`ce294d85`（10-20，1 天）——**已清理** |

**为什么以前没发现**：L1-M4x 系列此前**从未有一次走到最终切片**（那一堵墙是 N-30）。这是
N-30 修好之后才暴露出来的第二层问题。

### 2.2 改动

**新增** `approvePendingTaskApprovals(deps, workflowId)`：读
`GET /api/workflows/:id/approvals`，对每个 `status === "PENDING"` 的审批
`POST /api/approvals/:id/approve`，返回批准次数。

**`waitWorkflowTerminal`**：

```ts
while (!TERMINAL_WORKFLOW.has(detail.workflow?.status ?? "")) {
  if (Date.now() > deadline) return { status: "TIMEOUT", interventions };
  if (detail.workflow?.status === "WAITING_APPROVAL") {
    interventions += await approvePendingTaskApprovals(deps, workflowId);
  }
  await deps.sleep(options.pollIntervalMs);
  detail = await deps.http.get(...);
}
return { status: detail.workflow?.status ?? "", interventions };
```

签名由 `Promise<string>` 改为 `Promise<{ status; interventions }>`，两处调用点
（无切片分支与按切片分支）分别把 `interventions` 累加进 `journeyInterventions`。

### 2.3 为什么这**不是**绕过审批

- **审批门仍然开启**：平台的 production 审批策略（L1-9 红线）**一个字符都没改**。
- **仍然需要一个「人」**：harness 就是这个「人」——它本来就是评测里的操作者，此前已在关口 1
  与规划升级时扮演同一角色（`approvePendingPlanningReview`）。
- **每次都记账**：批准次数计入 `humanInterventions`，与既有口径一致；不是隐身操作。

---

## 3. Architecture Changes

**无。** 不改平台行为、不改审批策略、不新增接口；只补上评测侧缺的那一个动作。

---

## 4. Dependencies

**无新增、无升级、无删除。**

---

## 5. Tests

**新增 `packages/eval/src/__tests__/taskApprovals.test.ts`（4 条，接线级）**：

| 用例 | 断言 |
| --- | --- |
| `WAITING_APPROVAL` + `PENDING` 审批 | 批准一次；`interventions === 1`；随后读到 `SUCCESS` |
| 审批已是 `APPROVED`（别人批过） | **不重复批准**、`interventions === 0` |
| 没有审批记录 | 不凭空计数、不发批准请求 |
| 不是 `WAITING_APPROVAL` | **完全不碰审批接口**（证明只在需要时才动作） |

**门禁**：`@ai-se/eval` typecheck ✅ exit 0 ｜ lint ✅ exit 0 ｜ test **63 / 63**（由 59 增至 63）。

---

## 6. Lint / 7. Typecheck

见 §5：均 **exit 0**。

---

## 8. E2E

**未跑真实批次。** 判据：

| 判据 | 内容 |
| --- | --- |
| **34a** | 最终切片的生产部署**由 harness 自动批准**，工作流不再停在 `WAITING_APPROVAL` |
| **34b** | 记录的 `humanInterventions` **包含**该次批准（不为 0） |
| **34c** | 单元耗时不再出现「停在审批上等 2 小时」的形状 |

---

## 9. Known Issues

1. **未在真实批次验证** ⇒ 不判「已关闭」。
2. **口径变更（必须预先声明）**：此前停在 `WAITING_APPROVAL` 的运行会**跑满超时并记 TIMEOUT**；
   修改后它们会**继续跑完**。因此：
   - 单次运行**时长会变长**（多跑了生产部署那一段），不再有 2 小时空转；
   - `humanInterventions` **会上升**（每次生产部署 +1）；
   - `chainCompleted` / `staging 段` 的读数**不受影响**（那两段的判定面是任务状态，不是工作流终态）。
   **不要把「时长变长」读成退步，也不要把「介入数上升」读成平台更爱找人。**
3. **不解决生产部署本身是否该被自动放行**——那是产品策略（L1-9 明确要人审）；这里只是让**评测里的
   那个人**真的做决定。
4. **不解决 AC-20 / AC-27 / `CHECK_TIMEOUT` × 11**。

---

## 10. Acceptance Result

**交付物是「1 个审批放行函数 + 1 处等待逻辑 + 2 处调用点 + 4 条接线用例 + 包级门禁全绿」。**

按仓库记账纪律判 **「已实施、未在真实批次验证」**，**不判「已关闭」**。

---

## 11. Next Phase Boundary

**未开始事项（STOP）**：

1. **34a / 34b / 34c 的真实批次验证**。
2. **AC-20 / AC-27**（真交付的最后两格）未查、未修。
3. **`CHECK_TIMEOUT` × 11**（240 秒，`observe` 模式下被记录但不拦截）未查。
4. **N-27 / N-28 / `fixTaskType` 校验**未开工。
5. **N-31 的 33a/33b**（交付按契约分派）同样待批次验证。
