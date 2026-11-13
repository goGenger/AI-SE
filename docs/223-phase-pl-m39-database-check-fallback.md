# 223 · PL-M39 实施记录（N-1b：DATABASE 任务在没有迁移概念的项目里回退到 build+test）

> 阶段：**PL-M39** ｜ 缺陷登记：`docs/146` §3 N-1b（2026-10-16 由 PL-M9 登记，当时明确「不并入、只登记」）
> 用户 2026-10-22 指令：「修 N-1b，完全缺失时才回退」。

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `apps/server/src/services/taskVerifierRules.ts` | 修改 | `resolveVerificationChecks` 的 DATABASE 分支：只在**存在迁移脚本**时走迁移口径；完全缺失时落到 BACKEND 候选集 |
| `apps/server/src/__tests__/taskVerifierRules.test.ts` | 修改 | **+1 条用例**（41 → 42）；并更正 1 处旧断言（见 §5） |
| `docs/223-phase-pl-m39-database-check-fallback.md` | 新增 | 本文件 |

**零依赖、零 migration、零新增类型、零调用点改动**——`planVerificationChecks` 本来就委托给
`resolveVerificationChecks`，只有**一处**定义。

---

## 2. Implementation

### 2.1 缺陷

```ts
// 旧：DATABASE 恒走迁移口径
if (checkType === "DATABASE") {
  const up = MIGRATION_UP_SCRIPTS.find(...);   // db:migrate:up / migrate:up
  const down = MIGRATION_DOWN_SCRIPTS.find(...);
  return { plans: up && down ? [...迁移 up/down] : [], missing };
}
```

**没有任何回退。** 一个不涉及 SQL 迁移的项目（实测 E1：`DATA_DIR` 原子 JSON 存储）里，
DATABASE 任务**永远**拿不到一条检查。

**为什么这是洞而不是「本类型没有客观检查」**：DATABASE 在 `DEV_TASK_TYPES` 里——它有防篡改快照、
有写范围审计，是**写生产代码**的任务类型。平台自己的 PL-M9 9a 语义把「有候选检查但跑不起来」
判为**证据面缺失**，与 ANALYSIS / DESIGN / REVIEW 那种「本来就没有客观检查」不同。

**实测规模**：

| 项 | 数据 |
| --- | --- |
| 全库实例 | **22 个 / 21 个 run**（10-17 → 10-22） |
| `l1-m4t` | 三个 run **各 1 次**，全是 `T08「任务仓储层」` |
| 记录形状 | `verdict=unavailable`、`missingChecks=["migrate-up","migrate-down"]` |
| 同一任务的写范围 | `changedPaths` 空或仅 1 条、`deniedAttempts` 1–2（防篡改正常工作） |

### 2.2 改动

```ts
const hasMigrationScript =
  MIGRATION_UP_SCRIPTS.some((name) => available.has(name)) ||
  MIGRATION_DOWN_SCRIPTS.some((name) => available.has(name));

if (checkType === "DATABASE" && hasMigrationScript) {
  …原样保留（成对才可用）…
}

// DATABASE 且完全无迁移脚本 ⇒ 落到 BACKEND 的候选集
const candidates = CHECK_CANDIDATES[checkType === "DATABASE" ? "BACKEND" : checkType] ?? [];
```

**三条边界，逐条对齐用户裁定**：

| 情形 | 行为 |
| --- | --- |
| 两个迁移脚本都**没有** | **回退**到 `build` + `test`（BACKEND 候选集） |
| 只有 `migrate-up` 或只有 `migrate-down` | **不回退**，仍报缺另一半（半套迁移脚本说明这是有 DB 的项目，脚本写了一半） |
| 迁移齐全 | 只跑 `migrate-up`/`migrate-down`，**不掺** `build`/`test` |

**为什么复用 `CHECK_CANDIDATES.BACKEND` 而不是另写一个数组**：DATABASE 任务在没有迁移的项目里，
其客观检查与 BACKEND 完全同构（构建 + 测试）；另立一份数组就是 `docs/160` 记的漂移成因。

**DEBUG→DATABASE 同样受益**（N-15′ 的目标类型路径）：那条路原本也是空计划。

---

## 3. Architecture Changes

**无。** 不改 `VerificationCheckName` 词表、不改 `AcScopingMode`、不改判定规则、
不改 `CHECK_CANDIDATES` 的其它条目。

---

## 4. Dependencies

**无新增、无升级、无删除。**

---

## 5. Tests

**新增 1 条**（`taskVerifierRules.test.ts`，41 → 42），覆盖五种情形：

| 断言 | 意义 |
| --- | --- |
| `{build, test}` ⇒ plans = build+test、`missing: []` | 主判据：回退生效且**不再算证据面缺失** |
| `{db:migrate:up, build, test}` ⇒ plans = `[]`、`missing: ["migrate-down"]` | 缺一半时**严格**，且不掺 build/test |
| 迁移齐全 + build/test ⇒ 只跑两个迁移 | 迁移口径优先 |
| `{test}` ⇒ plans = test、`missing: ["build"]` | 回退后缺 build 仍是证据面缺失（**洞没有被藏起来**） |
| `resolveVerificationChecks("DEBUG", …, "DATABASE")` ⇒ build+test | N-15′ 路径同样生效 |

**更正 1 处旧断言**：`resolveVerificationChecks("DATABASE", {})` 的 `missing` 由
`["migrate-up","migrate-down"]` 改为 `["build","test"]`。这不是「改测试让它变绿」——
是**语义变更的直接后果**：既然完全缺失时回退到 BACKEND 候选集，那么「什么都没声明」缺的就是
build / test。判定（`plans` 为空 ⇒ 仍判失败）**没有变**。

### 5.1 全量 `apps/server`（52 文件 / 355 条）——**按事实记录，不做单侧断言**

| 次 | 结果 | 失败用例 |
| --- | --- | --- |
| 第 1 次 | **353/355** | `failureRecovery.e2e` 的 CANCELLED 用例、`v1GoldenScenario.e2e` 的 `server restart` |
| 两文件单跑 | **14/14 通过** | — |
| 第 2 次 | **353/355** | `terminationPropagation.e2e` 的 FX-36、`v1GoldenScenario.e2e` 的 `server restart`（**换了一条**） |

**两组失败的第二条每次都不同、单跑全过** —— 典型的时序敏感 flake（`docs/145` #7 同一形态）。

**已查明环境原因**：`uptime` 1 分钟负载 **38.45**（10 核机器，约 4 倍超载），
`ps -r` 显示前 10 名 CPU 占用**全部是桌面应用**（WindowServer 59%、Claude 渲染进程 40%、
Finder 35%、Spotlight `mds` 30%、ToDesk 25%、Stats 19%、微信 18%），**没有测试残留进程**
（`docker ps` 仅 4 个：E1 staging / E1 production / postgres / redis）。
⇒ **在这个负载下这两条 e2e 的结果不可用作判据，也不构成回归信号。**

**未改任何测试、未放宽任何断言。**

---

## 6. Lint

`eslint src/services/taskVerifierRules.ts src/__tests__/taskVerifierRules.test.ts` → **exit 0**。

## 7. Typecheck

`tsc -p tsconfig.json --noEmit`（`@ai-se/server`）→ **exit 0**。

---

## 8. E2E

**未做批次验证**（下一批要等配额窗口 2026-10-25 23:00 UTC）。

### 8.1 预先声明的记账变化

| 指标 | 预期变化 |
| --- | --- |
| **`检查不可判定`** | E1 应从 **1（DATABASE×1）** 降到 **0** |
| **DATABASE 任务的 `verification.verdict`** | 由 `unavailable` 变为 `verified` 或 `failed` |
| **`任务级验证分歧`** | **可能上升**——DATABASE 任务现在会被 build/test 真判，失败会记进分歧 |
| **`假阳性率`** | 应保持 **0**：本改动只加检查，不改任何 `passed` 判定规则 |
| **链完成率 / 真交付率** | 应不变（`observe` 模式下验证失败不拦任务） |

按 `docs/146` 的经验（`coverage-fixes-look-like-regressions`）：**收紧后数字可能变差，这正是门在起作用**。

### 8.2 判据

| 判据 | 内容 |
| --- | --- |
| **39a** | E1 的 `检查不可判定` = **0** |
| **39b** | DATABASE 任务的检查记录里出现 `build` / `test`（而不是空） |
| **39c** | `假阳性率` 保持 0 |
| **39d** | 若 DATABASE 的测试真失败，任务仍照 `observe` 记录、不拦工作流 |

---

## 9. Known Issues

1. **回退目标是 BACKEND 的候选集**。若将来出现「无迁移但有别的客观检查」的存储形态
   （例如只声明了 `db:seed`），需要再评估——但**现在没有实例**。
2. **不回退「缺一半」是刻意的**：那会让「有 DB 但脚本写了一半」的项目静默降级成 build/test。
   用户已裁定。
3. **N-1c（红灯语义缺口）仍未修**：`resolveCheckOutcome` 把「命令非零退出」一律当作「红灯已亮」，
   无法区分「尚未实现」与「根本没有可测之物」。与本条同族但不同机制，`docs/146` 已登记（未证实）。
4. **N-35 的第二个缺口已查清**（`docs/222` §9 第 2 条）：13 个「无失败却无边界检查」的工作流
   **全部**可归因为「早于该特性 / 任务无 `acKeys` / 工作区无 `test` 脚本 / 任务无验证记录」，
   **10-19 之后没有新实例**，不是活跃洞。本改动不涉及它。

---

## 10. Acceptance Result

交付物是「1 处条件 + 1 处候选集回退 + 1 条用例（覆盖 5 种情形）+ 1 处断言更正 + 包级门禁」。
全量 `apps/server` 见 §5 之下的门禁记录。

判 **「已实施、单测验证通过、批次验证待下一批」**，**不判「已关闭」**。

---

## 11. Next Phase Boundary

**未开始事项（STOP）**：

1. **39a–39d 待下一批**（需重启平台；本阶段结束前会重启）。
2. **N-1c（红灯语义缺口）**未修、未证实。
3. **13 个「无失败却无边界检查」的工作流已查清**（`docs/222` §9 第 2 条），无活跃洞。
4. **全仓 `-r` 门禁**在本阶段收尾前重跑。
