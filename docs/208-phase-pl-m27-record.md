# 208 · PL-M27 实施记录（N-26：作用域判定不再被兄弟切片的钩子失败污染）

> 阶段：**PL-M27**。用户 2026-10-21 直接指令「**修 N-26**」。
> 发现场：**L1-M4p run 1**（`docs/207` §4），工作流 `3e08ef4c` 的实际致死点。
> **未在真实批次验证 ⇒ 不判「已关闭」。**

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `apps/server/src/services/taskVerifier.ts` | 修改 | 两处判定统一 + 超时反向边界（详见 §2） |
| `apps/server/src/__tests__/taskVerifier.test.ts` | 修改 | 新增 4 个用例（主判据 / 2 个负控 / 切片边界同形） |
| `docs/208-phase-pl-m27-record.md` | 新增 | 本文件 |

**零依赖改动、零新包、零新文件（除本记录）。**

---

## 2. Implementation

### 2.1 缺陷的一句话复述

`command-filter` 自称「**真选取**」，但 `--test-name-pattern` **只筛测试名**——
`node --test` 仍会加载 `test/` 下的**每个**文件并执行其顶层钩子
（`taskVerifierRules.ts:301` 的注释**早已写明**这一点）。于是：

- **兄弟切片**的测试文件钩子一失败（典型：它要的接口还没实现 ⇒ `ERR_SERVER_NOT_RUNNING`），
- 整条命令以非零码退出，
- 而**本切片的 AC 全过**——
- 旧判定 `last.success && allRelevantPassed`（切片边界）与
  `return { achieved: result.success }`（任务级 test 检查）就把**本切片判失败**。

**两处代码各自的事实都写在注释里，但没人把它们的合取连起来。**

### 2.2 三处改动

**(1) 任务级 `test` 检查：作用域判定的输入扩到两种模式**

```ts
// 改前
const resultFilter = scoping && !scopedCommand ? { acKeys: scoping.acKeys } : undefined;
// 改后
const scopeFilter = scoping ? { acKeys: scoping.acKeys } : undefined;
```

变量改名 `resultFilter → scopeFilter`：它**不再只服务于 result-filter**。

**(2) `resolveCheckOutcome`：放宽条件加上「未超时」**

```ts
const timedOut =
  outputField(result, "timedOut") === true || result.error?.code === "TIMEOUT_ERROR";
if (!result.success && !timedOut && scopeFilter && scopeFilter.acKeys.length > 0) {
  // …作用域内 AC 全过 ⇒ achieved
}
```

**(3) 切片边界检查：去掉对整条命令成功的额外要求**

```ts
// 改前
const achieved = scopedCommand ? last.success && allRelevantPassed : last.success || allRelevantPassed;
// 改后
const achieved = scopedCommand ? !timedOut && allRelevantPassed : last.success || allRelevantPassed;
```

### 2.3 为什么区分因子是 `timedOut` 而不是 `success`

**这是本次唯一一次差点改错的地方，值得写下来。**

第一版只把 `last.success &&` 去掉，结果**打挂了一个既有用例**：

```
TaskVerifier（PL-M20 / N-13）> 检查超时 → 检查级 CHECK_TIMEOUT
expected 'verified' to be 'failed'
```

那个用例的形状（其注释原文）是「**测试跑过了、作用域内 AC 也过了，命令却没有返回**」，
断言 `failureCode === "CHECK_TIMEOUT"`。⇒ **「命令没成功」有两种性质完全不同的成因**：

| 成因 | 证据是否可信 | 应判 |
| --- | --- | --- |
| 兄弟文件的钩子失败（命令**返回了**，只是 exit 1） | **可信**——本切片的 AC 结果是真的 | **通过** |
| 命令**超时没返回** | **不可信**——输出只是残片 | **失败**（`CHECK_TIMEOUT`） |

⇒ 放宽必须挂在 `!timedOut` 上。**超时那条（PL-M20 / N-13）一个字没动。**

### 2.4 空转防线（N-10）未放松

两处都保留 `relevant.length > 0` 的前置条件 ⇒ **一条 AC 结果都没解析出来仍然判失败**。
`command-filter` 侧比 `result-filter` 更严：它不再接受「命令成功」作为通过理由。

---

## 3. Architecture Changes

**无。** 不新增判定层、不新增错误码、不改 `AcScopingMode` 的取值。作用域**命令**本身
（`buildAcScopedTestCommand`）**一行未动**——改的只是**怎么读它的结果**。

---

## 4. Dependencies

**无新增、无升级、无删除。**

---

## 5. Tests

**新增 4 个用例**（`taskVerifier.test.ts`，60 → **64**）：

| 判据 | 用例 | 断言 |
| --- | --- | --- |
| **29a**（主判据） | 命令 `exitCode 1`，TAP 里 AC-01 `ok`、兄弟文件 `not ok … hookFailed` | `verdict === "verified"`；`passed === true`；**`exitCode === 1`**（命令确实失败）；`attempts` 长度 1；无 `failureCode` |
| **29b**（负控） | 同一形状但 **AC-01 `not ok`** | `verdict === "failed"`；`attempts` 长度 2 |
| **29c**（负控） | 只有兄弟文件钩子失败、**零 AC 结果** | `verdict === "failed"`（空转防线不放松） |
| **29d**（切片边界同形） | 边界命令 `exitCode 1`，两条切片 AC 都 `ok` + 兄弟钩子失败 | `slice-boundary` 的 `passed === true` 且 **`exitCode === 1`** |

**既有用例保持绿**：超时路径（`CHECK_TIMEOUT`，§2.3 提到的那个）**未被弱化**，
它正是逼出 `!timedOut` 的用例；`FX-16 / FX-17` 的作用域选取用例全部原样通过。

**包级门禁**：

| 项 | 结果 |
| --- | --- |
| `typecheck` | ✅ exit 0（零 `error TS`） |
| `lint` | ✅ exit 0 |
| `test`（第 1 次） | **329 / 330**——`workflowApi.e2e.test.ts > retry guards` 失败 |
| `test`（该文件隔离复跑） | ✅ **11 / 11 通过** |
| `test`（第 2 次全量） | ✅ **330 / 330**，exit 0 |

**抖动判定**：失败的文件**在 `docs/145` #7 的既有抖动清单里**（原文即点名
「`workflowApi`（两条 retry）」），隔离复跑全过、第二次全量全绿 ⇒ **负载敏感抖动，非本条引入**。
**未弱化任何测试。**

---

## 6. E2E

**未跑真实批次。** 上游自本批结束起仍在抖动（L1-M4p 批中探针 6/8，`docs/207` §5）。
**29a–29d 在真实批次里的检验，等下一次能走到切片 1 之后的批次。**

---

## 7. Known Issues

1. **未在真实批次验证** ⇒ **不判「已关闭」**。
2. **残留口子（既有，本次未扩大范围去修）**：若作用域有 N 个 AC、而 TAP 里只出现 M < N 个
   （其余所在文件的钩子失败 ⇒ 那个测试**根本没跑**），`relevant.length > 0 && every passed`
   **仍会通过**。`result-filter` 一直是这个行为，**本次不单方面改它**——
   改法应是「要求作用域内**每个** AC 都出现且为 passed」，但那会让「某些 AC 本来就没有测试」
   的合法情形翻红，须先普查再定（[[verdict-rules-need-a-census]]）。
3. **第二个残留口子（既有）**：`command-filter` 下**命令成功**时，任务级检查走
   `return { achieved: result.success }`，**不检验作用域 AC 是否真的跑过** ⇒ 理论上可以
   「命令成功但一条作用域 AC 都没跑」而通过。这是 F1-5 的原形态，**本次未动**
   （本次只碰失败路径）。
4. **上游恢复时间未知**（外部条件）。

---

## 8. Acceptance Result

**交付物是「两处判定统一 + 1 个超时反向边界 + 4 个用例（含 2 个负控）+ 包级门禁全绿」，
已全部给出。** 按仓库记账纪律，判 **「已实施、未在真实批次验证」**，**不判「已关闭」**。

**判据对照**：29a / 29b / 29c / 29d **在单测层达成**；真实批次层**未验**。

---

## 9. Next Phase Boundary

**未开始事项（STOP）**：

1. **N-26 的真实批次检验未做**——须等上游恢复且**能走到切片 1 之后**的批次。
2. **§7 第 2、3 项的残留口子未修**（均已定性，均需先普查）。
3. **26d 仍未验**（PL-M25 的主判据）⇒ 下一批必须**走到交付段**。
4. `docs/206`（N-25 规划段用量）按裁定留到 L1-8 验收批次之后；
   「两步修复」未设计；`docs/` 写范围缺致败实例；`AGENTS.md` §6 冲突**未擅自改用户的规则文件**。
