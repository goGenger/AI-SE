# 219 · PL-M35 实施记录（N-34：作用域测试按文件选取）

> 阶段：**PL-M35** ｜ 缺陷登记：`docs/146` N-34 ｜ 发现场：批次 `l1-m4t` run 1（`T11`）
> 本阶段在**批次运行期间**并行完成（用户 2026-10-22 指令：「在批次期间并行干活」）。
> 改动**不重启平台**，故对 `l1-m4t` run 3 不生效；**生产同构验证在下一个批次**。

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `apps/server/src/services/taskVerifierRules.ts` | 修改 | 新增 `acMarkerKeys` / `isBareNodeTestScript` / `buildAcTestFileProbeCommand` / `parseAcTestFileProbe` / `MAX_SCOPED_TEST_FILES`；`acScopedTestTimeoutMs` 增 `fileCount` 参数；`buildAcScopedTestCommand` 增 `testFiles` 参数 |
| `apps/server/src/services/taskVerifier.ts` | 修改 | 新增 `probeAcTestFiles`；两处调用点（`runCheckWithRetry` / 切片边界检查）先探测文件再拼命令 |
| `apps/server/src/__tests__/taskVerifierRules.test.ts` | 修改 | **+5 条用例**（36 → 41） |
| `docs/219-phase-pl-m35-file-scoped-tests.md` | 新增 | 本文件 |

**零依赖、零 migration、零 schema 改动。**

---

## 2. Implementation

### 2.1 缺陷（库内 + 源码实证）

`--test-name-pattern` 只筛**测试名**，`node --test` 仍会**加载 `test/` 下的每个文件**并执行其文件级钩子。
沙箱是 `--cpus 1`（`packages/sandbox/src/index.ts`）⇒ 容器内 `availableParallelism() = 1`
⇒ Node **串行**跑测试文件 ⇒ 兄弟切片的每个挂死文件各烧掉**一整个** `--test-timeout`。

`MAX_NEVER_COMPLETING_TEST_FILES = 5` 这条校准（PL-M24）基于**参考实现只有 2 个测试文件**。
实测代理写出的 E1 工作区（`ai-se-eval/E1/run-1/test/`，2026-10-22 17:2x 实读）有 **9 个**：

```text
test/auth.global.test.js          [AC-11] [AC-12] [AC-13]
test/deploy-contract.test.js      [AC-24] [AC-25] [AC-26] [AC-29]
test/health.test.js               [AC-01]
test/home.render.test.js          [AC-22] [AC-30]
test/home.test.js                 [AC-21]
test/login.credentials.test.js    [AC-09] [AC-10]
test/persistence.password.test.js [AC-04]
test/register.uniqueness.test.js  [AC-02] [AC-03] [AC-05] [AC-06]
test/register.validation.test.js  [AC-07] [AC-08]
```

后果：5 个挂死文件 × 20s = 100s，加上正常文件即吃满 **120s** 单次预算 × 2 次尝试 ⇒ `CHECK_TIMEOUT`。
证据（批次 `l1-m4t` run 1 的 `T11`）：`attempts = [120019ms, 120030ms]`，
`stdoutTail`（2001 字符）内 **5 条** `testTimeoutFailure`。同批 run 2 有 6 次、run 1 有 11 次。

**这不是「测试太慢」，是「跑了不该跑的文件」。** 上表已经证明每个 AC 只落在 1~2 个文件里，
一次域内检查真正需要跑的文件数是 **1~3**，不是 9。

### 2.2 改动

**（a）探测：新增一次 `run_command`**

```text
node -e "…walk('.');process.stdout.write(JSON.stringify({files:out}))"
```

与 `buildPackageFactsProbeCommand` **同一范式**（`packages/tool-runtime/src/tools/packageManager.ts:53`）：
`node -e` 单命令 + 输出 JSON + 纯函数解析。

**为什么必须是另一次工具调用**：`run_unit_test` 走 `isScriptOnlyCommand`
（`packageManager.ts:275`），`$(grep …)` 一类 shell 组合会被直接拒绝；
`assertCommandAllowed` 也是黑名单式。命令里**不能**做替换。

**（b）挑选：只在「裸 `node --test`」上做**

```ts
export function isBareNodeTestScript(scriptText: string): boolean {
  return /^node\s+--test(\s+--[A-Za-z0-9][A-Za-z0-9-]*(=\S+)?)*$/.test(scriptText.trim());
}
```

脚本自带路径参数（如 `node --test test/`）时追加文件只会取**并集**，反而跑得更多 ⇒ 退回名称筛选。
实测生产脚本形态是裸的（`ai-se-eval/E1/run-1/package.json` → `"test": "node --test"`），故选取生效。

**（c）拼命令：文件列表 + 名称筛选并用**

```text
npm run test -- 'test/health.test.js' 'test/register.validation.test.js' \
  --test-name-pattern '\[AC-01\]|\[AC-1\]|\[AC-07\]|\[AC-7\]' --test-timeout=40000
```

- **文件层面**不再加载兄弟切片的文件（这才是 N-34 的正题）；
- **文件内**仍按 AC 名称筛选（沿用 F1-5 语义，不额外跑同文件里别人的用例）。

**（d）超时按实际文件数分摊**

旧：`预算 / (5 + 1)`，固定 20s。新：`预算 / (实际文件数 + 1)`。
2 个文件 ⇒ 40s；10 个 ⇒ 10.9s。**总和仍严格小于预算**（这是 PL-M24 的原意）。

### 2.3 三个刻意的「不变化」

| 情形 | 行为 |
| --- | --- |
| 脚本非裸 `node --test` | 退回名称筛选，**命令逐字不变** |
| 探测失败 / 输出不可解析 | `undefined` ⇒ 视为「未探测」⇒ 名称筛选，**命令逐字不变** |
| 探测到 0 个文件，或 > 20 个 | 退回名称筛选，**命令逐字不变** |

第三条的含义要写明：**0 个文件 = 本切片的 AC 没有任何测试文件提到**，此时退回全量运行、
由结果面判定「无相关结果 ⇒ 不通过」。这是既有语义（`result-filter`），本阶段不改判定规则，
只改「跑哪条命令」。

---

## 3. Architecture Changes

**无。** 不改验证判定规则（N-26 的「本切片 AC 全过即通过」逐字保留），
不改 `AcScopingMode` 的两分法，不改 Tool Runtime、不加权限、不加审计。

`VerificationCheckName` 未扩展：探测走 `runTool(..., { checkName: "ac-test-file-probe" })`，
该字段在 `runTool` 选项里本就是 `string`（`taskVerifier.ts:1261`）。

---

## 4. Dependencies

**无新增、无升级、无删除。**

---

## 5. Tests

**`taskVerifierRules.test.ts` 新增 5 条**（36 → 41，全绿）：

| 用例 | 断言 |
| --- | --- |
| 文件列表拼进命令、超时按实际文件数分摊 | 命令逐字；`acScopedTestTimeoutMs(120_000, 2) = 40_000`、`(…, 10) = 10_909` 且 ×10 < 预算；不传文件数仍为 `20_000` |
| 非裸脚本 / 空列表 / 超上限 / 未探测 | 四种情形都退回**同一个**名称筛选命令串 |
| `isBareNodeTestScript` | 放行 `--flag` / `--flag=value`；拒绝 `test/`、`vitest run`、`; rm -rf /` |
| 探测器命令 | `node -e "…"` 头；键去重含规范变体；**不含 `$` 与反引号**（`sh -lc` 会展开）；可注入的键被丢 |
| 探测器输出解析 | `./test/x` 归一化；`../` / 绝对路径 / 空格 / `;` 一律丢弃；不可解析 → `null` |

**为什么单独测「不含 `$`」**：命令经 `docker run … sh -lc`（`packages/sandbox/src/index.ts:241`）执行。
第一版探测器用了 `/\.(test|spec)\.[cm]?[jt]s$/`，其中 `$` 会被 shell 当参数展开；改为
`suffixes.some(s => name.endsWith(s))` 后无 `$`。

**同一处还修掉了一个自己写出来的 bug**：第一版用 `new RegExp('\\['+k+'\\]')`，
但字符串字面量里的 `\[` 会被 JS 吃掉反斜杠 ⇒ 正则退化成**字符类** `[AC-01]`，
匹配任意一个字符。改 `includes('['+k+']')` 后无转义问题。

---

## 6. Lint

`eslint src/services/taskVerifierRules.ts src/services/taskVerifier.ts src/__tests__/taskVerifierRules.test.ts`
→ **exit 0**。

## 7. Typecheck

`tsc -p tsconfig.json --noEmit`（`@ai-se/server`）→ **exit 0**。

**刻意未跑包级 `typecheck` 脚本**：该脚本会先 build 九个依赖包的 `dist/`，而批次正在运行。
批次边界再跑完整门禁。

---

## 8. E2E

### 8.1 已做（宿主机、真实工作区、真实命令）

| 步骤 | 结果 |
| --- | --- |
| 构建器真实产出（`tsx` 调用，非手抄） | 见 §2.2(c) 的命令串 |
| `sh -lc "<探测命令>"` 在 `ai-se-eval/E1/run-1/` | `{"files":["test/health.test.js","test/register.validation.test.js"]}` —— AC-01→health、AC-07→register.validation、AC-99→无 |
| 同一命令形态在**工作区副本**上跑 | **18 通过 / 303ms**（此前同域检查是 `120019ms` 超时） |
| **真实 DockerSandbox e2e**（`verificationGate.e2e.test.ts`，`DockerSandbox` + 真实 Tool Runtime） | 探测返回 `{"files":["test/api.test.mjs"]}`；实际执行 `npm run test -- 'test/api.test.mjs' --test-name-pattern '\[AC-01\]\|\[AC-1\]' --test-timeout=60000` → **2 通过 / 42ms** |

**第三行是新增证据（2026-10-22 批次边界跑全仓门禁时取得）**：旧断言只看命令里有没有 `--test-name-pattern`，
新形态命令仍满足该断言，而日志证明**文件选取在真实沙箱里生效**（探针 173ms、运行 299ms）。
这条比宿主机验证强——它走的是真实的 `DockerSandbox` + Tool Runtime + `TaskVerifier` 全链路。

### 8.2 未做（下一个批次）

**沙箱内（`ai-se-sandbox:22-pnpm9`、`--cpus 1`、`network none`）的端到端验证尚未进行。**
本阶段的改动**没有重启平台**，`l1-m4t` run 3 仍跑旧代码。判据留给下一个批次：

| 判据 | 内容 |
| --- | --- |
| **35d** | 域内 `test` 检查的命令里出现显式文件列表与 `--test-timeout` ≤ 40s |
| **35e** | 同一次检查的 `attempts` 时长从 `120xxx ms` 降到个位数秒 |
| **35f** | `CHECK_TIMEOUT` 计数显著下降（对照：run 1 = 11、run 2 = 6），且域内 AC 判定结果不变 |

---

## 9. Known Issues

1. **多一次容器启动**：每次域内检查多一次 `run_command`。沙箱 `runCommand` 是 `docker run --rm`
   逐次起容器（`packages/sandbox/src/index.ts:241`），故每次检查多约 1s。一个 run 的域内检查约 30 次
   ⇒ 约 +30s / run，相对 2~3 小时的 run 可忽略。
2. **文件数上限 20**：超过即退回名称筛选（回到旧的超时风险）。当前实测 9 个、参考实现 2 个，
   20 是 2 倍余量。若将来域内文件数常态超过 20，需要改成「分批跑 + 合并结果」。
3. **探测只认 `[AC-xx]` 方括号形态**。参考实现 `packages/eval/fixtures/E1/reference/test/*.mjs`
   用的是**无方括号**的 `apiTest("AC-01 …")`，与生产代理写出的形态（`[AC-01]`）不同。
   本探测对参考实现会选中 0 个文件 ⇒ 退回名称筛选（不会误判，但也不提速）。
   **这是既有口径分歧，不是本阶段引入**：F1-5 的名称模式 `buildAcNamePattern` 同样只认方括号。
4. **不改判定规则**：N-26 的「本切片 AC 全过即通过」逐字保留。文件选取只改「跑什么」。
5. **`VERIFICATION_GATE=enforce` 仍不开**：需先看 35e/35f 的真实下降幅度。

---

## 10. Acceptance Result

交付物是「1 条探测命令 + 2 个纯函数 + 1 个构造器改动 + 2 处调用点 + 5 条用例 + 包内 typecheck/lint 全绿」。

判 **「已实施、宿主机验证通过、沙箱与批次验证待下一个批次」**，**不判「已关闭」**。

---

## 11. Next Phase Boundary

**未开始事项（STOP）**：

1. **35d / 35e / 35f 待下一批次**（需重建 `@ai-se/server` 并重启平台；`dist` 不热重载）。
2. **包级完整门禁**（`--filter @ai-se/server typecheck && lint && test`）未跑——刻意留到批次边界。
3. **参考实现的 AC 标记形态分歧**（方括号 vs 无方括号，§9 第 3 条）未处理，需单独裁定是否统一。
4. **`docs/217`（L1-M4t 批次记录）**未写：run 3 仍在跑。
5. **N-27 / N-28 / `fixTaskType` 校验**未开工。
