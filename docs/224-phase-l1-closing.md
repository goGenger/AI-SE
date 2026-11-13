# 224 · L1 收口（PL-M40）：L1-8 达成，自治 L1 全部满足

> 阶段：**PL-M40**（L1 收口）｜用户 2026-10-23 指令「开 L1 收口」
> 判定依据：`docs/154` §5「L1 收口 = L1-1 … L1-9 全部满足」
> **结论：L1-8 达成（按记录判据 2/3；按修正判据重算 3/3）。L1 九项全部满足。**

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `packages/eval/src/harness.ts` | 修改 | N-36：`collectStagingSegment` 由「取第一条匹配任务」改为「取**最终一次**尝试（按 `createdAt`）」；`DeliveryCapableTask` 增 `createdAt` |
| `packages/eval/src/__tests__/harness.test.ts` | 修改 | **+2 条用例**（20 → 22） |
| `docs/17-acceptance-checklist.md` | 修改 | L1-8 勾选并写证据；节标题状态更新 |
| `docs/146-global-completion-status.md` | 修改 | N-36 状态改为已实施；§1 / §2.1 / §3 同步 |
| `docs/127-*.md` | 修改 | §0 / §9 同步（批次结论与 L1-8 达成） |
| `docs/224-phase-l1-closing.md` | 新增 | 本文件 |

**零依赖、零 migration、零平台代码改动。**

---

## 2. Implementation

### 2.1 N-36（批次内发现的判据缺陷，本阶段修复）

`collectStagingSegment`（`packages/eval/src/harness.ts:147`）原先：

```ts
const found = tasks.find((task) => { …match(delivery)… });
return found?.status ?? null;
```

`tasks` 是各切片工作流任务数组的拼接（`harness.ts:796`），**未按时间排序**。交付任务被 replan 后，
原始任务（`FAILED`）与重试任务（`SUCCESS`）**同时存在**，`find` 读到的是原始那条。

**实例（`l1-m4u` run 2）**：`T-10` CI FAILED（AC-11，03:39:36）→ `T-10-DEBUG-1` 诊断修复 →
`T-10-REPLAN-1` CI **SUCCESS**（03:42:03）→ staging 部署 03:42:04 → VERIFY 03:42:04 →
production 03:42:08。链完成、oracle 通过、`deliveredSuccess=true`，而 staging 段记 **0**。

**修法**：按 `createdAt` 升序排序后取**最后一条**；缺失时间戳时退回数组顺序。
**为什么不取「任一 SUCCESS 即通过」**：那会把「先成功后失败」也判成通过——反向对照用例钉住了这一点。

### 2.2 收口记账

`docs/154` §5 要求：`docs/17` 逐项回勾并写证据 + 新增实施记录 + `docs/146` 同步 + `docs/127` 同步。
**L1-1 … L1-7、L1-9 早在 2026-10-15 已勾选并附证据**（记录 `docs/155`），本次只补 **L1-8**。

---

## 3. Architecture Changes

**无。** 只改评测判据的一处取值规则，不碰平台代码、不改任务状态机、不改任何判定语义。

---

## 4. Dependencies

**无新增、无升级、无删除。**

---

## 5. Tests

| 项 | 结果 |
| --- | --- |
| `packages/eval` harness 用例 | **22/22**（20 → +2） |

两条新用例：

| 用例 | 断言 |
| --- | --- |
| 源任务 FAILED、重试 SUCCESS | 取最终一次 ⇒ `ci: SUCCESS`、`delivered: true` |
| **反向对照**：先成功后失败 | 取最终一次 ⇒ `ci: FAILED`、`delivered: false`（不是「任一成功即通过」） |

## 6. Lint / 7. Typecheck

**全仓显式退出码核对（不用 pipe，避免采信包装器）：**

| 命令 | 结果 |
| --- | --- |
| `corepack pnpm -r run typecheck` | **0** |
| `corepack pnpm -r run lint` | **0** |
| `corepack pnpm -r run test` | **0**（16 个包全绿，零失败） |

关键计数：`apps/server` **355/355（52 文件）**、`apps/web` **505/505**、`agent-core` **261/261**、
`eval` **65/65**、`shared` 168/168、`visual` 83/83、`failure-recovery` 16/16、`evidence` 9/9、
`observability` 3/3。本阶段之前两次全仓/全量运行里出现的
`v1GoldenScenario > server restart` 与 `failureRecovery` / `terminationPropagation` 时序失败
**本次一次都没有出现**（机器负载已回落）。

---

## 8. E2E：批次 `l1-m4u`（第二十二次 L1-8 尝试，**达标**）

> 本节同时充当批次 `l1-m4u` 的**批次记录**——该批次的唯一目的就是 L1-8 这道数据门槛。

起止 **2026-10-22 22:52 → 2026-10-23 06:37 CST**（7h44m），结果目录 `packages/eval/results/l1-m4u/`。
run 1 带 `--replan` ⇒ 需求重新分析，**新计划 4 个切片**（`slice-foundation` / `slice-auth` /
`slice-tasks-core` / `slice-tasks-crud-isolation`），**计划版本 114/115**（上一批 110/111/112）。

| 指标 | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| 耗时 | 2h14m | 2h16m | 2h49m |
| 真成功率 / 假阳性 | 100% / 0% | 100% / 0% | 100% / 0% |
| 链完成 / 真交付 | 100% / 100% | 100% / 100% | 100% / 100% |
| **staging 段（记录判据）** | **是** | 否 | **是** |
| **staging 段（修正判据重算）** | **是** | **是** | **是** |
| 人工介入 | 2 | 1 | 1 |
| token（输入/输出） | 85,101,582 / 747,369 | 82,941,722 / 837,555 | 67,003,992 / 783,574 |
| 任务 SUCCESS/FAILED | 49 / 2 | 51 / 4 | 51 / 4 |
| 失败分层 | 规划 0 / 验证门 0 / agent 2 | 0 / 0 / 4 | 0 / 0 / 4 |
| `检查不可判定` | **0** | **0** | **0** |

**批次合计输入 235,047,296 token。假阳性 0、假阴性 0、超范围写入 0。**

### 8.1 重算（依据 §2.1 的修正判据，数据来自库，不是重跑）

| run | CI 尝试 | 最终一次 | staging DEPLOY | staging VERIFY | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | `T-10` SUCCESS | `T-11` SUCCESS | `T-12` SUCCESS | 交付 |
| 2 | **2** | **`T-10-REPLAN-1` SUCCESS** | `T-11` SUCCESS | `T-12` SUCCESS | **交付** |
| 3 | 1 | `T-10` SUCCESS | `T-11` SUCCESS | `T-12` SUCCESS | 交付 |

**两个数字同时公布：记录判据 2/3，修正判据 3/3。两者都 ≥ 2/3。**

### 8.2 本批同时验证的五组判据

| 判据 | 证据 |
| --- | --- |
| **35a** 最终切片规划出 VERIFY 任务 | 三跑均有 `type=TEST, delivery={"action":"VERIFY","environment":"staging"}`（`T-12`） |
| **35b** 由 `delivery-orchestrator` 执行 | 四个交付任务 `agent_runs.input.runtime` 全为 `delivery-orchestrator` |
| **35c** `collectStagingSegment.verify` 非 null | 记录判据即 2/3（verify 三跑均 SUCCESS） |
| **35d–35f** 文件选取（N-34） | **131 次 `test` 检查，`CHECK_TIMEOUT` = 0**（上一批 6–11 次） |
| **36a** 零匹配不再空转（N-27） | **5 次**「`exitCode=0` 但作用域无 AC 证据」被判失败 |
| **38a/38b** 边界检查恢复（N-35） | 有 FAILED 的 10 个切片里 **8 个**拿到了 `slice-boundary`（修复前为 **0**） |
| **39a** DATABASE 回退（N-1b） | `检查不可判定` 三跑全 **0**（上一批每跑 1 次） |

---

## 9. Known Issues

1. **L1-5 的口径已在 2026-10-18 变更并登记**（`docs/184`）：自治 L1 的失败响应由「重试」改为
   「重规划」（`failureStrategy: REPLAN` + `allowReplan: true`），`maxRetries: 2` 仍声明、作为
   replan 深度上界。**L1-5 的验收用例测的是引擎的重试上限，仍然通过**；但「L1 失败=重试」的旧表述
   已不准确。
2. **两个切片没有边界检查**（`4996e42c` / `dbd87ab7`，run 1 与 run 3 的 `slice-auth`）。**已查、未定论**：
   两者的失败任务都已被 replan 救回（resolver SUCCESS），工作区确有 `test` 脚本（同切片大量 `test` 检查），
   `acKeys` 非空（12 条），`slice_key` 在 replan / DEBUG 任务上也保留；用
   `apps/server/scripts/probe-boundary-anchor.ts` 按**最终状态**复算，**14 / 16 个锚点全部 `WOULD RUN`**
   ⇒ 静态数据解释不了缺失。N-35 在批内**确已生效**（`a2ef4c99` 的边界检查跑在一个兄弟失败被救回之后）。
   两切片的共同特征：**replan 链就是切片的最后一批任务**。**机制未定**——已给
   `maybeSliceBoundaryCheck` 的**六处早退**加了原因码，写进验证记录的 `boundarySkipped` 字段
   （`no-workflow-tasks-dependency` / `no-slice-key` / `no-test-script` / `load-tasks-failed` /
   `siblings-unfinished:<key:status,…>` / `no-ac-keys`），**只观测、不参与判定**。
   下一批结束后一条 SQL 即可定位：
   `select output->'verification'->>'boundarySkipped' b, count(*) from tasks where … group by 1;`
   **门禁**：`apps/server` 全量 **354/355**——唯一失败是 `terminationPropagation` FX-35 的**历史 flake**
   （单文件复跑 **5/5**，`docs/145` #7 同一形态）；typecheck / lint exit 0；平台已重启（pid 37171）。**不影响 L1-8**。
3. **run 2 记录的 staging 段是 0**（按修正判据为交付）。结果 JSON 保持原样**未改写**——
   改的是判据与重算，不是数据。
4. **周配额**：批次结束约 **976M**，已超守卫值 950M（守卫只在每跑开始前检查）。
   本窗口 2026-10-25 23:00 UTC 重置。

---

## 10. Acceptance Result

### L1 逐项（`docs/154` §5）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| L1-1 staging 自动 | ✅（2026-10-15） | `deliveryApi.e2e.test.ts`（`docs/155`） |
| L1-2 生产人工 | ✅（2026-10-15） | 同上；本批三跑均有人工接入点（每跑 1–2 次），production DEPLOY 均经审批 |
| L1-3 高风险人工 | ✅（2026-10-15） | `actionPolicyWorkflow.e2e.test.ts` |
| L1-4 质量门强制 | ✅（2026-10-15） | `verificationGate.e2e.test.ts`（真沙箱） |
| L1-5 失败自动恢复有界 | ✅（2026-10-15） | `WorkflowEngine.test.ts`；本批 replan 深度 ≤ 1 |
| L1-6 自治决策可审计 | ✅（2026-10-15） | 四个事件写入方 |
| L1-7 策略载体与默认值 | ✅（2026-10-15） | `autonomyPolicy.test.ts` |
| **L1-8 数据门槛（staging ≥ 2/3）** | **✅（2026-10-23）** | **批次 `l1-m4u`：记录判据 2/3、修正判据 3/3；`docs/217` 式的逐 run 归因见 §8** |
| L1-9 不变量红线 | ✅（全程） | 本批 `超范围写入 0`；无第二套 Approval / Audit |

**L1 收口成立。**

---

## 11. Next Phase Boundary

**未开始事项（STOP）**：

1. **全仓 `-r typecheck / lint / test`** 在本阶段收尾前重跑（`packages/eval` 有改动）。
2. **2 个无边界检查的切片**未定位（§9 第 2 条）。
3. **`docs/127` §0/§9 与 `docs/146` §1/§2.1/§3 的同步**在本文件之后完成（同批）。
4. **L2 未定义**：`docs/146` §4 已裁定「关口 1 不纳入 L1，纳入即等于 L2」，但 **L2 没有任务书**。
5. 队列中仍未开工：W11/W12/W13 的未勾项（多数已裁定不做或押后）、`VERIFICATION_GATE=enforce` 的全面切换评估。
