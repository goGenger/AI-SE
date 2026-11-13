# 220 · PL-M36 实施记录（N-27：零匹配不再空转通过）

> 阶段：**PL-M36** ｜ 缺陷登记：`docs/146` N-27 ｜ 普查：`docs/209` §4
> 本阶段在**批次运行期间**并行完成（用户 2026-10-22 指令：「在批次期间并行干活」）。
> 改动**不重启平台**，故对 `l1-m4t` run 3 不生效；**批次验证待下一个批次**。

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `apps/server/src/services/taskVerifier.ts` | 修改 | `resolveCheckOutcome` 增 `commandFiltered` 参数；`expectation !== "fail"` 分支改为「作用域 AC 全部出现且全部通过」 |
| `apps/server/src/__tests__/taskVerifier.test.ts` | 修改 | **+2 条用例**（64 → 66） |
| `docs/220-phase-pl-m36-no-vacuous-pass.md` | 新增 | 本文件 |

**零依赖、零 migration、零 schema 改动、零判定词表改动。**

---

## 2. Implementation

### 2.1 缺陷（源码路径可逐步核对）

`resolveCheckOutcome`（`taskVerifier.ts`）在 `planned.expectation !== "fail"` 时：

```ts
return { achieved: result.success, expected: planned.expectation };
```

**只看命令有没有成功。** 而零匹配的 `node --test --test-name-pattern '…'` **退出码是 0**
（TAP `1..0` / `# tests 0` / `# pass 0`）⇒ `result.success = true` ⇒ **空转通过**。

作用域内 AC 的结果只在**命令失败**时才被读取（那条 `if (!result.success && !timedOut && scopeFilter …)`
是 N-26 的放宽），命令一成功就根本不会被看到。

`docs/209` §4 的普查：L1-M4q 三个 run 各复现 **1 次**，**三次全部来自同一个任务 `T1`**
（`acResults` 空 + TAP `1..0` + `exitCode 0` + `passed:true`）。

### 2.2 改动

`expectation !== "fail"` 分支重构为：

```text
if (!timedOut && scopeFilter && acKeys.length > 0) {
  relevant = 作用域内 AC 的解析结果
  if (commandFiltered) {
    relevant 为空                    → 失败，uncoveredAcKeys = 全部作用域 AC   ← N-27 的修复
    全部 passed                      → 通过
    否则                             → 失败，uncoveredAcKeys = 未通过的 AC
  }
  if (!result.success && 全部 passed) → 通过                                    ← N-26 原样保留
}
return { achieved: result.success }
```

**三条不变量逐字保留**：

| 不变量 | 保留方式 |
| --- | --- |
| **超时不算证据**（PL-M20 / N-13） | 整个作用域分支都在 `!timedOut` 之内；超时直接落到 `result.success = false` |
| **兄弟切片的失败不污染本切片**（N-26） | command-filter 下只看作用域 AC，`result.success` 不再参与；result-filter 下原分支逐字保留 |
| **红灯语义不变**（E-0） | `expectation === "fail"` 的分支一行未动 |

### 2.3 为什么不收紧「部分证据（M<N）」

普查里同族还稳定复现了另一种形状：`T4` 的 `scopedAcKeys=["AC-21","AC-22"]` 而 `acResults` 只有
`AC-21`，**AC-22 从未出现仍通过**。看起来应该一并收紧（要求 M == N），但机制上不成立：

1. **AC-22 的测试文件确实存在**（`ai-se-eval/E1/run-1/test/home.render.test.js` 含 `[AC-22] [AC-30]`）；
   它没出现，说明那次运行的输出**被截断了**——而截断的主因正是 **N-34 的 `CHECK_TIMEOUT`**
   （`attempts` 跑满 120s 后被杀，只剩残片）。
2. ⇒ 部分证据是 **N-34 的下游症状**，不是独立缺陷。先修 N-34（PL-M35，`docs/219`），
   再看它是否自然消失；**现在收紧会把一个已被治因的症状当成独立病来治**，
   并且会误伤「测试名不带 `[AC-xx]` 标记」的 runner 约定分歧。

**所以本阶段只收紧「零证据」这一条**——它没有任何可辩护的解释：一条结果都没有，就不是证据。
把 M<N 的处置留给 PL-M35 的批次结果（判据见 `docs/219` §8.2 的 35f）。

---

## 3. Architecture Changes

**无。** 不改验证判定词表、不改 `AcScopingMode` 两分法、不改 Tool Runtime。
`uncoveredAcKeys` 是既有字段（PL-M18 / N-10 (c) 引入），本阶段只是把它用在新增的两种失败上，
并改成**按计划原始写法**报告（`AC-01` 而非规范化键 `AC-1`）——诊断要对得上计划。

---

## 4. Dependencies

**无新增、无升级、无删除。**

---

## 5. Tests

**`taskVerifier.test.ts` 新增 2 条**（64 → 66，全绿）：

| 用例 | 断言 |
| --- | --- |
| 零匹配不再空转通过 | `exitCode === 0`、`timedOut === false`、`passed === false`、`verdict === "failed"`、`uncoveredAcKeys === ["AC-01"]` |
| 作用域 AC 未全过时落编号 | `AC-01` 过、`AC-02` 失败 ⇒ `uncoveredAcKeys === ["AC-02"]` |

**第一条的关键断言是 `exitCode === 0`**：证明判失败靠的是「没有本切片 AC 的证据」，
不是「命令失败了」。若哪天有人把这条改回 `result.success`，它会在 exit 0 上立刻红。

**既有 64 条全绿**——特别是 N-26 的三条（含「一条 AC 结果都没解析出来仍然判失败」的负控）
与 N-13 的超时用例，确认放宽与收紧没有互相吃掉。

---

## 6. Lint

`eslint src/services/taskVerifier.ts src/services/taskVerifierRules.ts src/__tests__/taskVerifier.test.ts src/__tests__/taskVerifierRules.test.ts`
→ **exit 0**。

## 7. Typecheck

`tsc -p tsconfig.json --noEmit`（`@ai-se/server`）→ **exit 0**。

**刻意未跑包级 `typecheck` 脚本**：该脚本会先 build 九个依赖包的 `dist/`，而批次正在运行。
批次边界再跑完整门禁。

---

## 8. E2E

**未做批次验证。** 本阶段改动**没有重启平台**，`l1-m4t` run 3 仍跑旧代码。

判据留给下一个批次：

| 判据 | 内容 |
| --- | --- |
| **36a** | 出现「`exitCode=0` + `acResults` 为空 + `passed=false`」的 `test` 检查（这正是旧代码判通过的那种形状） |
| **36b** | 每条这样的检查都带 `uncoveredAcKeys`，且编号与计划里的 AC 写法一致 |
| **36c** | 判失败的 `test` 检查在 `observe` 模式下属「已记录、不拦截」，任务状态不受影响 |
| **36d** | **假阳性率不上升**：`report` 里的 `falsePositiveRate` 保持 0 |

**为什么单列 36d**：本次是**收紧**判定，方向上是「把晚失败提前」——按 `docs/146` 的经验
（`coverage-fixes-look-like-regressions`），收紧后批次数字**可能变差**，这正是门在起作用。
但本阶段只动 `passed` 记号、不动任务状态（`observe` 模式），所以真成功率与真交付率**不应变化**。

---

## 9. Known Issues

1. **`observe` 模式下本修复不改变任务结果**，只改变**记账**（`passed` / `failureCode` / `uncoveredAcKeys`）。
   要它真正拦住任务，需 `VERIFICATION_GATE=enforce`，而那要先看 PL-M35（N-34）的批次结果。
2. **部分证据（M<N）未收紧**，理由见 §2.3。若 PL-M35 落地后仍然稳定复现，则需重新裁定。
3. **result-filter 路径的同形漏洞未修**：非 `node --test` 的项目在主判据成功时仍不看作用域 AC。
   未修的理由是「没有 AC 结果」在那种项目里可能只是测试名没打标记，属约定分歧而非空转——
   收紧会误伤。本条**登记为已知限制**，不进缺陷表。
4. **未跑包级完整门禁**，见 §7。

---

## 10. Acceptance Result

交付物是「1 处判定重构 + 1 个参数 + 2 条用例 + 包内 typecheck/lint 全绿」。

判 **「已实施、单测验证通过、批次验证待下一个批次」**，**不判「已关闭」**。

---

## 11. Next Phase Boundary

**未开始事项（STOP）**：

1. **36a / 36b / 36c / 36d 待下一批次**（需重建 `@ai-se/server` 并重启平台）。
2. **包级完整门禁**未跑——留到批次边界。
3. **N-28（两步修复，任务书 `docs/210`）**未实施：**零实例、潜伏**，不是活跃阻断。
4. **`fixTaskType` 校验**未开工（普查：753 个非空值里仅 119 个合法 `TaskType`）。
5. **`docs/217`（L1-M4t 批次记录）**未写：run 3 仍在跑。
