# 188 · PL-M20（N-13：AC 作用域测试命令把不匹配的测试文件挂死）实施记录

> 任务书：**`docs/187`**（2026-10-19 立项，同日裁定「都按你的建议」，八项全部按推荐值落地）。
> 基线：L1-M4k 批次实测（`packages/eval/results/l1-m4k`）、库内逐条实查、工作区实跑复现。
> 状态：**已实施，已在真实批次（L1-M4l）验证——判据 20g 达成**。

---

## Modified Files

| 文件 | 动作 |
| --- | --- |
| `apps/server/src/services/taskVerifierRules.ts` | 改：新增 `acScopedTestTimeoutMs`；`buildAcScopedTestCommand` 增第 4 参数并在命令后追加 `--test-timeout=<N>` |
| `apps/server/src/services/taskVerifier.ts` | 改：`VerificationFailureCode` 追加 `"CHECK_TIMEOUT"` + 导出 `CHECK_TIMEOUT_FAILURE_CODE`；检查结果构造处按「红灯诊断码优先、否则超时」产出 `failureCode`；`slice-boundary` 检查同口径加码；两处调用点传入 `this.timeoutMs` |
| `apps/server/src/__tests__/taskVerifierRules.test.ts` | 改：**+1 例**；import 增两项 |
| `apps/server/src/__tests__/taskVerifier.test.ts` | 改：**+2 例**；**11 处硬编码作用域命令串同步追加 `--test-timeout=100000`** |
| `apps/server/scripts/probe-n13-scoped-test-hang.ts` | **新增**：P0/P1/P2/P3 四变体探针 |
| `packages/eval/src/types.ts` | 改：`verificationFailureCodes` 的注释枚举补上 `CHECK_TIMEOUT`（注释漂移，非行为改动） |
| `packages/eval/results/n13-probe/report.json` | **新增**（探针产物） |
| `docs/187-phase-n13-taskbook.md` | **新增**（任务书，§9 已填裁定与实施结果） |
| `docs/188-phase-pl-m20-record.md` | **新增**（本文件） |
| `docs/146-global-completion-status.md` | 改：头部最近更新、§3 新增 N-13 行、§5 新增 L1-M4k 与 PL-M20 两条 |
| `docs/127-project-status-overview.md` | 改：「最近一次状态」段 |
| `docs/17-acceptance-checklist.md` | 改：L1-8 项**追加** 2026-10-19 块（原结论一字未动） |

---

## Implementation

### 1. 根因（平台侧，非 agent、非夹具）

`buildAcScopedTestCommand` 拼出的 `node --test --test-name-pattern '…'` **只筛测试名，不筛文件**。
某个文件里一条测试都不匹配时，Node 会在 `before` 钩子**还没结束**时就调用 `after`——实测现场：

```text
BEFORE_START
AFTER_RAN server=undefined     ← after 早于 before 结束
BEFORE_END
```

`after` 里 `if (server)` 落空（赋值语句 `server = await startServer()` 还在 await 中），清理不发生；
`before` 随后起的子进程再没人回收，测试进程被它拖着不退出 ⇒ **命令永不返回**。

E1 工作区实测：**带 pattern 5/5 挂死**（>40s，确定性），**不带 pattern 自行退出**。挂死现场：
4 个测试子进程各挂一个存活、`0.0% CPU`、`LISTEN`、`curl /healthz` 返回 **200** 的
`src/server.js`——服务是健康的，是**回收**没发生。

### 2. 修法

```ts
export function acScopedTestTimeoutMs(checkTimeoutMs: number): number {
  return Math.floor((checkTimeoutMs * 5) / 6);
}
// …命令尾部追加：
`${baseCommand} -- --test-name-pattern '${pattern}' --test-timeout=${acScopedTestTimeoutMs(checkTimeoutMs)}`
```

- **超时值随预算走，不写死**：默认预算 120s ⇒ 100s。**必须严格小于整命令预算**，否则整命令
  超时先触发，失败归因不到文件级。
- **为什么不用 `--test-force-exit`**（探针实测，同一最小复现）：

| 开关 | 读数 | 判定 |
| --- | --- | --- |
| `--test-timeout=5000` | `exit 1` / `failureType: 'testTimeoutFailure'` / `pass 0` | **有界失败**，方向安全 |
| `--test-force-exit` | `exit 0` / `pass 1` / `fail 0` | **把挂死静默变成通过**——会关掉红灯门，**否决** |

### 3. 记账：`CHECK_TIMEOUT`

在**既有** `VerificationFailureCode` 枚举上追加一项（不是第二套错误码体系）。
产出规则：**红灯检查自己的诊断码优先**（更具体），没有时再看 `finalAttempt.timedOut`。

这样「作用域内 AC 全过、检查却没返回」在批次账本里不再与「产物质量差」共用同一个裸
`checks failed: test`——本批那 **7 个** AC 全过却判失败的任务，正是被这条掩盖的。

**`slice-boundary` 检查同口径**：它跑的是**同一条**作用域命令，没返回时同样要能命名；
否则账本上只有一半的挂死是可见的。已一并加码并加测试。

---

## Architecture Changes

**无。** 未新增包、未改契约、未改 `failureLayers` 的分层口径（任务级 `errorType` 仍是
`VERIFICATION_FAILED`，`classifyFailureLayer` 未动）。`CHECK_TIMEOUT` 只进既有的
`verificationFailureCodes` 分布（`packages/eval/src/harness.ts` 已按 `check.failureCode` 通用收集）。

---

## Dependencies

**无新增、无升级、无删除。**

---

## Tests

### 单元测试

| 套件 | 结果 |
| --- | --- |
| `apps/server`（全量） | **292 passed / 292**（改动前 288，**+4**） |
| ├ `taskVerifierRules.test.ts` | **+1 例**：命令形状含 `--test-timeout=100000`；空作用域 / 非 `node --test` 仍返回 `null`；`acScopedTestTimeoutMs` 随预算变小（30s → 25s） |
| └ `taskVerifier.test.ts` | **+3 例**：① 检查超时 ⇒ 检查级 `failureCode === "CHECK_TIMEOUT"`，且**反向对照** `acResults` 仍为 `{"AC-04":"passed"}`（证明失败不是测试挂了）；② 未超时的普通失败**不写** `CHECK_TIMEOUT`；③ **切片边界检查**超时同样记 `CHECK_TIMEOUT`（与 `test` 检查同口径） |

**既有断言同步**：`taskVerifier.test.ts` 有 **11 处硬编码**的作用域命令字符串（`AGENTS.md` §7 点名的
「精确断言」），同一改动内一并追加新开关，**未弱化任何一条**。

### 探针（`apps/server/scripts/probe-n13-scoped-test-hang.ts`）

自造夹具（离线、确定性、零配额），驱动**真实** `buildAcScopedTestCommand`。P1 由 P2 **剥掉新开关**
得到，故两者唯一的差异就是修复本身。

| 变体 | 命令 | 读数 | 不变量 |
| --- | --- | --- | --- |
| P0 | `npm run test`（无作用域） | `EXIT 0` | `P0_UNSCOPED_EXITS` ✅ |
| P1 | 旧作用域命令 | **`HANG`** | `N13_REPRODUCED` ✅ |
| P2 | 新作用域命令 | `EXIT 1` | `P2_FIX_EXITS` ✅ |
| P3 | 真正不返回的测试 + 新命令 | `EXIT 1` | `P3_RED_LIGHT_HELD` ✅ |

**四项全绿**，读数落 `packages/eval/results/n13-probe/report.json`。

---

## Lint

`corepack pnpm --filter @ai-se/server lint` **exit 0**；全仓 `corepack pnpm -r run lint` **exit 0**。

---

## Typecheck

`corepack pnpm --filter @ai-se/server typecheck` **exit 0**；全仓 `corepack pnpm -r run typecheck` **exit 0**。

---

## 全仓门槛

`corepack pnpm -r run typecheck && corepack pnpm -r run lint && corepack pnpm -r run test`
**exit 0**——**16 个包、1805 个测试、0 失败**（`apps/server` 292/292，其余 15 包 1513）。

---

## E2E

**真实批次 L1-M4l（E1×3）已执行 3/3、完整跑满**（`packages/eval/results/l1-m4l`，脚本
`l1-m4l-e1-x3.sh` ＋ `l1-m4l-stop.sh`，均新增）。**判据 20g 达成——N-13 的致败签名在整个批次
中一次都没出现。**

### 正对照：修复确实在生产上

开工前先确认陈旧实例已换（`:47558` 原实例起于 10:07:21，**早于**修复文件 mtime 15:31:03 /
15:45:35；重启为 **PID 87280**，加载 `src/index.ts` 而非 dist）。运行期从库内取到的作用域命令：

```text
L1-M4k（旧，死因）: pnpm test -- --test-name-pattern '\[AC-04\]|\[AC-4\]'
L1-M4l（现在）    : pnpm test -- --test-name-pattern '\[AC-04\]|\[AC-4\]' --test-timeout=100000
```

**同一 AC 键、同一模式，只多一个新开关**——与探针 P1/P2 的差异完全同形。

### N-13 的致败签名：全批归零

| 读数 | L1-M4k（3 run） | **L1-M4l（3 run）** |
| --- | --- | --- |
| 检查级 `timedOut: true` | **16** | **0** |
| `test` 检查失败数 | 16（其中 7 个作用域 AC 全过） | **0**（跑 10 次，全过） |
| `verificationFailureCodes` | `{}` | `{}` |
| 失败分层 `verification` | **7 / 8 / 3** | **1 / 3 / 3** |
| 失败分层 `agent` | 0 / 0 / 4 | 4 / 0 / 0 |
| 检查不可判定 | 0 / 0 / 0 | 1 / 2 / 1 |

全批 **18 个检查**（`build` 7 / `test` 10 / `slice-boundary` 1）**全部通过，零失败、零超时**。
L1-M4k 里「作用域 AC 全过、检查却判失败」那 **7 个任务**的形态**一个都没复现**。

> ### 🔴 勘误（2026-10-20，L1-M4m 批次实测后追加）
>
> **上面这一节与判据 20g 已被推翻。** 原文保留不改（`docs/146` §6 规则 7：历史记录冻结，
> 勘误只以追加块形式）。**本文件其余部分（§1 根因、§2 修法、§3 记账码）仍然成立**——
> 被推翻的只有「修法在生产上有效」这一条。
>
> #### 实测：开关在场，检查照样超时
>
> L1-M4m run 3（工作流 `8b4b1811-145d-4a68-944d-1084cd2231c8`，2026-10-19 19:30–20:36 UTC）
> 25 个检查里 **7 个 `timedOut: true` / `failureCode = CHECK_TIMEOUT`**：
>
> | task_key | 检查 | timedOut | failureCode | exitCode |
> | --- | --- | --- | --- | --- |
> | `TASK-007-REPLAN-1` / `-REPLAN-2` | `test` | **true** | `CHECK_TIMEOUT` | — |
> | `TASK-008` / `-REPLAN-1` | `test` | **true** | `CHECK_TIMEOUT` | — |
> | `TASK-009-REPLAN-1` | `test` | **true** | `CHECK_TIMEOUT` | — |
> | `TASK-010` / `-REPLAN-1` | `test` | **true** | `CHECK_TIMEOUT` | — |
>
> **七个检查的命令全部带 `--test-timeout=100000`**（逐条读
> `tasks.output->'verification'->'checks'->>'command'` 原文；命令长度 75–248 字符，
> **未做 `left()` 截断**——第一次查询时我用 `left(command,130)` 把 `=100000` 切成了
> `=1000`，差点据此登记一个不存在的缺陷）。
>
> ⇒ **「把「不返回」变成有界的失败」在生产取值上不成立。**
>
> #### L1-M4l 的「0 超时」是**未观测**，不是**已验证**
>
> 全批 18 个检查里 `test` 检查只跑了 **10 次**，**每一次都正常返回**
> （BACKEND 的 `T1`/`T4`/`T5` 全 `exitCode = 0`，TEST 的 `T2` `exitCode = 1`）——
> **挂死路径一次都没被走到**。同一台机器、同一份代码，L1-M4m run 3 走到了，就 7 次全挂。
> 一个从未触发该路径的批次，其「零超时」对这道修法**没有判别力**。
>
> #### 与探针的差异：探针从未在 E1 工作区上验过
>
> `packages/eval/results/n13-probe/report.json` 是**唯一**的 N-13 证据产物，而它跑的是探针自造的
> **合成夹具**（`probe-n13-scoped-test-hang.ts` 的 `HOOK_FIXTURE`，落在 `mkdtempSync` 临时目录里）。
> **「E1 工作区实跑亦退出」这句（判据 20c）在 `packages/eval/results/` 下没有任何对应产物**——
> `n13-probe/` 里只有 `report.json` 一个文件。§1 那次「E1 工作区 5/5 挂死」同样只有文字、没有产物。
>
> 探针自己的读数把这个缺口照得很清楚：
>
> | 变体 | 命令 | 结果 | 产物里的耗时 |
> | --- | --- | --- | --- |
> | P1（旧形状） | `… --test-name-pattern '\[AC-99\]'` | **HANG**（40 s 窗口内不退出） | — |
> | P2（新形状） | `… --test-name-pattern '\[AC-99\]' --test-timeout=10000` | `EXIT 1` | **`# duration_ms 10012.078042`** |
>
> ⇒ **超时在 10 000 ms 触发，整条命令 12 ms 后就退出了。** 探针夹具在超时之后的收尾是**瞬时**的，
> 所以 `--test-timeout` 的 2 s 余量绰绰有余。**探针复现了触发条件（零匹配的钩子挂死），
> 但没有复现生产上的收尾行为**——这是 `probes-must-match-production` 的又一例。
> 探针的预算常量 `CHECK_TIMEOUT_MS = 12_000` 只用来**算**那个 `--test-timeout` 值
> （`acScopedTestTimeoutMs(12_000) = 10_000`，与生产同比例），它的实际判据窗口是
> `PROBE_WINDOW_MS = 40_000`——**「40 s 内退出」这个判据本身就宽于生产的 120 s 预算**。
>
> 另注：探针 P2 的 TAP 是 `# fail 0 / # cancelled 1`（文件被记成 **cancelled**，不是失败），
> 与 Known Issue 2 的「超时后该文件里的测试会被记成失败」措辞不符；退出码仍是 1，检查仍判失败。
>
> #### 机制未定——只登记，不宣称
>
> 候选有三，**都未被证明**：
>
> 1. **E1 工作区与合成夹具的差异**：探针的挂死是自造的一个子进程；生产现场是**真实的
>    `src/server.js`**（§1 记：4 个测试子进程各挂一个存活、`LISTEN`、`healthz=200` 的服务）。
>    真实的 Node 服务进程被杀与回收所需的时间，与探针那个 `setInterval` 空进程不是一回事。
> 2. **多个挂死文件累加**：`--test-timeout` 是**按测试 / 按文件**计的。若作用域命令下**多个**文件
>    各自挂死，则每个各烧一个 `--test-timeout`，总和越过整检查预算。§1 记的「4 个子进程」与此相容，
>    但**没有任何读数**能判定它们是并发还是串行。
> 3. **余量不足**：20 s 收尾余量不够——**但探针的 12 ms 收尾使这条最不被支持**。
>
> **下一步的判据应是补上那个缺失的产物**：在**真实 E1 工作区**上跑一次带 `--test-timeout` 的作用域
> 命令，记下**退出码与耗时**。它同时能分辨候选 1 与候选 2/3（耗时 ≈ 100 s 还是 ≈ N × 100 s）。
> **在拿到该读数之前，不得登记新的修法**——先改余量会把候选 2 的读数一起改掉，届时无法归因。
>
> #### 一处仍然有效的收获
>
> **`CHECK_TIMEOUT` 记账码本身是有效的**——L1-M4m run 3 的 summary 正是靠它读出
> `验证门失败码：CHECK_TIMEOUT×7`，把「AC 全过却判失败」与「产物质量差」分了开。
> **失效的是「有界失败」这个保证，不是这个码。** 另注：**任务级** `reason`
> 仍写 `checks failed: test`（`verification.failureCode` 在任务级为空），
> 分口径只在**检查级**与**批次汇总**两处可见。

> ### 🟢 追加（2026-10-20）：**缺失的产物已补齐，机制已定**
>
> 上一块指定的收口条件已执行：在**真实 E1 工作区**上跑带 `--test-timeout` 的作用域命令，
> 记退出码与耗时。产物落 **`packages/eval/results/n13-e1-probe/`**
> （`report.json` ＋ `A1.txt` / `A2.txt` / `full.txt` 三份原始输出）。
>
> **工作区来源**：`~/Desktop/study/ai-se-eval/E1/run-1`——**L1-M4m run 3 收尾时的真实工作区**
> （mtime 2026-10-20 04:42 CST，17 个 `src/tests/*.test.mjs` ＋ `src/server.mjs`）。
> 测量在副本上进行，原工作区未改动。**命令取自库内原文**（`workflow 8b4b1811` 的 7 条
> `timedOut=true` 检查），不是重写的等价物。
>
> #### 读数
>
> | 变体 | 命令 | 结果 |
> | --- | --- | --- |
> | **A1** 生产形状 | `node --test --test-name-pattern '\[AC-01\]\|\[AC-1\]' --test-timeout=100000` | **退出，exit 1，100,478 ms**；`# tests 29 / pass 25 / **fail 0** / cancelled 4` |
> | **A2** 剥掉新开关 | 同上去掉 `--test-timeout` | **130 s 窗口内不退出（挂死）** |
>
> A1/A2 的**唯一变量就是修复本身** ⇒ 「`--test-timeout` 把挂死变成有界失败」在**真实工作区上成立**。
> **但 A1 是在 10 核宿主机上跑的，100.5 s < 120 s 预算。** 四个 `not ok` 条目是
> `login-contract` / `register-concurrency` / `register-contract` / `token-integrity` 四个**文件**，
> 各记 **100,006 / 100,006 / 100,004 / 100,002 ms**，而**总耗时只有 100,434 ms**
> ⇒ 它们**并发**跑。
>
> #### 机制（实测，非推断）
>
> **沙箱是 `--cpus 1`**（`packages/sandbox/src/index.ts:50` 的 `DEFAULT_LIMITS`），
> 实测容器内 `os.availableParallelism() = 1`（`os.cpus().length` 仍是 10）。
> ⇒ Node 的测试运行器**串行**跑测试文件 ⇒ **每个挂死文件各烧掉一整个 `--test-timeout`**。
>
> 串行化的直接证据（同一工作区、同一命令，只改并发度）：
>
> | | `--test-timeout=5000`，默认并发 | 同，`--test-concurrency=1` |
> | --- | --- | --- |
> | 耗时 | **5,537 ms** | **21,784 ms**（比值 **3.93 ≈ 4**） |
>
> 按生产取值外推：**N 个挂死文件 × 100 s**。实测每个作用域 **N = 3~4**
> （`[AC-01]`→4、`[AC-07/08]`→4、`[AC-02..06]`→3、`[AC-09/12/13]`→3）
> ⇒ **300~400 s ≫ 120 s 预算** ⇒ `CHECK_TIMEOUT`——与库内那 7 次逐一对上。
>
> **宿主机 10 核上这些文件并发跑，所以只有 100.5 s** ⇒ 探针（合成夹具，且跑在宿主机上）
> 与 §1 的「E1 工作区 5/5 挂死」**结构上都测不到生产失败**。这是
> `probes-must-match-production` 的又一例：被简化掉的那一环（**1 CPU 的串行化**）正是缺陷藏身处。
>
> #### 三个候选的判定
>
> | 候选 | 判定 |
> | --- | --- |
> | ① E1 工作区与合成夹具的差异 | **部分成立**——真实工作区有 **3~4** 个挂死文件，探针夹具只有 1 个 |
> | ② 多个挂死文件累加 | **✅ 确认**，且累加的**原因是沙箱 1 CPU 造成的串行化** |
> | ③ 余量不足 | 空闲多核宿主上**证伪**（100.5 s < 120 s）；在 1 CPU 串行下与 ② 合流 |
>
> #### 一个被数据否决的候选修法（记下来，免得再想一次）
>
> 「按文件内容预筛，只把含该 AC 键的文件交给 `node --test`」——**否决**。
> 实测 `login-contract.test.mjs` 对 `AC-01` 的 grep 命中 **7 次**（全在注释与
> `[AC-10]` 一类串里），而**匹配的测试名 0 个**：预筛会**原样留下全部挂死文件**。
>
> #### 正常测试的代价基线（用于给修法定尺寸）
>
> 真实工作区整份**串行**套件 **4,307 ms / 106 用例 / 全过**，**最慢单测 667 ms**。
> ⇒ 把每文件超时压到 20 s 仍有约 30 倍余量。
>
> #### 本块**不**登记修法——理由
>
> 读数指向的修法有两个半边，而**只有一半是安全的**：
>
> - **(1) 缩小每文件超时**（如 `budget/6` = 20 s ⇒ 容纳 5 个永不结束的文件）：安全、可测，
>   但**不会让检查通过**——A1 的 exit code 仍是 1，任务仍判 FAILED。
>   它买到的是**有界 + 可归因**（保住 TAP 里的 `# fail 0 / # cancelled N`，而不是被沙箱掐掉、什么都不剩）。
> - **(2) 判「只有挂死、没有真实失败」为通过**：**这一条才会让 L1-8 解冻**，但它离
>   `--test-force-exit` 那个「把挂死静默变成通过」的陷阱只有一步之遥，**需要用户裁定**。
>
> ⇒ **PL-M20 的状态由「实施完成、待重新验证」推进为「机制已定、修法待裁定」。**
> 裁定项与推荐值见 `docs/146` §4。

### 批次结果（供记账）

| | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| 到达切片（**以库为准**） | **S2**（S1 SUCCESS → S2 FAILED） | **S1**（FAILED） | **S1**（FAILED） |
| 输入 / 输出 | 7,194,118 / 172,830 | 4,617,985 / 110,505 | 5,217,840 / 130,118 |
| 失败分层 | planning 0 / verification 1 / agent 4 | 0 / 3 / 0 | 0 / 3 / 0 |

全批输入 **17,029,943** / 输出 413,453；`agent_runs` 24 succeeded / 2 timed_out；周配额
34,351,875 → **51,381,818**（增量与三 run 之和逐位相等）。**staging 段 0/3**，全批**零交付任务**
（`input->'delivery'` 无一行）⇒ 交付段从未开始。红线：超范围写入 0、假阳性 0、假阴性 0。

**🔴 新的唯一致败点：anti-tamper。** 全批 9 个 FAILED 任务里 **7 个**的死因是同一句
`protected test files modified: <路径>`（另 2 个是 run 1 的 agent 600s 超时，且都是 anti-tamper
死亡的上游）。**三个 run 的终止全部落在它上面**，且**每一次检查都通过了**。它属 `docs/187` §2.5
已登记、按裁定未修的那一类（写范围 / replan 路由 vs 测试文件），但**触发的是另一道门**——
不是写范围门，是**反篡改门**。

---

## Known Issues

1. **`--test-timeout` 是「有界失败」，不是「根因修复」。** 挂死的**成因**在 Node 的钩子时序
   （`after` 早于 `before` 结束），平台改不了；平台能保证的是**它不再吃掉整个验证预算**。
   若上游 Node 改掉这个时序，这个开关仍然是无害的上界。
2. **归因仍不完美**：超时后该文件里的测试会被记成失败。这是刻意的取舍——`CHECK_TIMEOUT` 让
   「检查没返回」在账本上可见，但**不声称**那些测试真的失败了。
3. **探针不入 `tsconfig`**：`apps/server/tsconfig.json` 只 `include: ["src/**/*.ts"]`，故
   `scripts/` 下的探针不被包门禁类型检查。这与既有的 `probe-n10-redlight-scope.ts` 一致
   （仓库既有惯例），但探针本身因此**只能靠实跑来保证不腐烂**。
4. **L1-M4k 的同批七项观察一项未修**（写范围缺口 / replan 路由不收敛 / `run_unit_test`
   script-only 策略 / 双服务入口 / `store.mjs` 同步忙等 / AC-06 夹具写错 / ——），见 `docs/187` §2.5。
5. **`docs/187` §2.5 第 6 项「验证超时留下孤儿进程」已更正**：那是**我在宿主机手工复现**时留下的，
   批次内命令跑在 `/workspace` 容器里、超时走 `sandbox` 的 `child.kill("SIGKILL")` +
   `forceRemoveContainer`，**没有批次证据**。

### L1-M4l 批次新登记的观察（本阶段不修）

6. **🔴 anti-tamper 是新的唯一致败点**（**已上升为下一阶段的首要候选**）：全批 9 个 FAILED 里
   **7 个**死于 `protected test files modified: <路径>`，**三个 run 的终止全部落在它上面**，而
   **每一次检查都通过了**。受影响的路径：`src/test/{scaffold,schema,store}.test.js`、
   `src/tests/{store,schema-migration}.test.js`。它与 `docs/187` §2.5 第 1/2 项同族（agent 需要
   动测试文件），但**拦它的是反篡改门，不是写范围门**——两者是不同的机制，修法也不同。

   **机制（2026-10-19 专项查证）**：门在 `apps/server/src/services/taskVerifier.ts:425-444`
   （前后 sha256 快照比对）与 `:488-490`（产出理由），独立于 `checks`（故 `checks: []`）。
   「受保护」= `isTestFilePath`（`packages/shared/src/index.ts:924`）：`*.test.*` / `*.spec.*`
   **或任一路径段**为 `test` / `tests` / `__tests__`。`DEV_TASK_TYPES = ["BACKEND","FRONTEND","DATABASE","DEBUG"]`
   （`taskVerifierRules.ts:46`，**TEST 被刻意排除**）。
   **真正的碰撞**：database-agent 的指令**明确要求它写数据库测试**、`writePaths` 含 `src`
   ⇒ **写层允许**；但反篡改门**只看 `task.type`，从不查 `writeTestFiles`** ⇒ 改既有测试文件即判死。
   `writeTestFiles: true` 只挂在 qa-agent（`AgentRegistry.ts:144`），**且无 env/config 开关**。
   **agent 并没有作弊**——各 summary 都是在**新增**测试（TDD 加固），而 sha256 只知「变了」，
   分不出「加了一条」与「删弱了一条」。

   > **勘误（2026-10-19，`docs/189` §2.2 逐条读 `edit_file` 的 `search`/`replace` 后追加）**：
   > 上面加粗那句**是错的**，本行保留不改（`docs/146` §6 规则 7：历史记录冻结，勘误另附）。
   > **两类改动混在同一道门里**：
   > - `T-02-DEBUG-1-DEBUG-2` → `src/test/scaffold.test.js` 把
   >   `assert.throws(() => parseAuthSecret('short'), …)`（短密钥必须被拒）
   >   **换成了** `assert.equal(parseAuthSecret('short')…, 'short', 'no minimum length is imposed…')`
   >   （短密钥被接受）——**这是红灯门的经典绕法，门拦对了**。
   > - `T3-DEBUG-1` → `src/test/schema.test.js` 只给 import 表补了两个新导出——**纯增量，门拦错了**。
   >
   > ⇒ 缺陷**不是**「门判错」，而是**门无法区分「加测试」与「改弱测试」**
   > （`changedProtectedFiles` 只比对 sha256）。修法见 `docs/189` §4.1 候选 (A)。
   > 同批另一项更正：该行原判断所依据的「agent 自述」本身不可采信——
   > 自述说的是**意图**，`edit_file` 的 `search`/`replace` 才是**事实**。

11. **N-17：`withoutVerification` 剥掉失败理由**（`apps/server/src/services/taskContextBuilder.ts:22`）——
    构造依赖任务上下文时**去掉 `verification` 段**。后果：被 replan 出来的修复任务**看不到上游为什么
    失败**。N-14 那 7 次死亡里，每次重试的 agent 都在**不知道**「我上次因为改了测试文件被判死」的
    情况下重做同一件事。**这不是 N-14 的成因，是它重复三次的成因**；修掉 N-14 之后它仍会拖慢其他
    类型的失败收敛。
12. **`findPreviousResults` 读错目录**（`packages/eval/src/cli.ts:258-267`）——它取 `results/` **根目录**
    下最新的 `.json`，**不是批次子目录**。后果：**run 2 的「噪声线（本次 - 上次）」比的是 10 月 1 日的
    批次，不是 run 1**。与 N-16 同族（都是 eval 读侧的范围错误），但成因独立。
7. ~~**replan 的兄弟分支指针跟错**（run 2）~~ **❌ 已撤回——登记错误（2026-10-19 专项查证）。**
   **我按「形状」登记了一个不存在的缺陷。** 全仓实查：`resolved_by_task_id` **只有两处写入**
   （`WorkflowEngine.ts:953` 的 `replan()` 与 `:1088` 的 `rollback()`，均走 `store.applyReplan`）；
   `replan()` **每次只造一对**（一个 `-DEBUG-n` ＋ 一个 `-REPLAN-n`），**指针恒为 retry**——
   `packages/workflow-engine/src/resolution.ts:6-8` 与 `docs/99:78` 都写明「解析者＝重试，不是诊断」，
   **没有「兄弟选择」这回事**。`T3-DEBUG-1-DEBUG-2` 的 `SUCCESS` 是**验证假象**（DEBUG 无类型级
   检查 ⇒ `unavailable`，`verifyingTaskExecutor` 不翻成 FAILED）。工作流的 FAILED **不出自解析规则**，
   而是 `handleFailures` 里 `executionAttempt < maxRetries` 为假 ⇒ 直接 `failWorkflow("Task failed: …")`，
   错误串与任务标题逐字吻合。**判定正确。** 该形状**仅见于 `b66e2e54` 一个工作流**。
7′. **N-15′：DEBUG 任务不可验证，却在做真实工作**（替代上一条，**真实**）：DEBUG **没有类型级检查**
   ⇒ verdict 恒为 `unavailable`；但 DEBUG 任务**派发到目标类型的 agent**（`AgentRegistry.ts:257`），
   `T3-DEBUG-1-DEBUG-2` 实际跑的是 database agent、改了 `src/schema.js` / `src/migrations.js`，
   **这些改动全程未被任何检查看过**。⇒ **一个会写生产代码的任务类型没有验证门。**
8. **N-12 / PL-M19 仍未被行使**（L1-M4k 与本批**都是零触发**）。本批 run 2 的工作流错误是
   `Task failed: Retry …` / `WORKFLOW_TASK_FAILED`（**重试预算路径**），**不是**
   `Workflow contains unresolved failed tasks` 那条路径；解析链尽头确实是 FAILED，判定正确。
9. **`DEBUG` 任务没有可用检查**：`no available checks for task type DEBUG`。与 `DATABASE` 同因，
   是「检查不可判定」从 0 变为非零的来源。**这是「跑得更远才看得见」的副产物，不是变坏**——
   L1-M4k 三个 run 都没跑完一个切片，从未产生过该值。
10. **`sliceReached` 会跨 run 串味**（记账缺陷，**以库为准可避免**）：`requirement_slices` 是
    **按计划版本**存的，三个 run 共用 v81。run 1 把 S2 置成 FAILED 后，run 2 / run 3 **从没创建过
    S2 工作流**，却因 `sliceReached` = 「最后一个非 PENDING 的切片」而被记成「到达 S2」。
    **库内真相：run 1 → S2，run 2 → S1，run 3 → S1。** 与 [[batch-attribution-needs-db-verification]]
    同一类问题。

---

## Acceptance Result

**PASS（判据 20a–20g 全部达成）。**

| 判据 | 结果 |
| --- | --- |
| 20a 确定性复现 | ✅ 探针 P0 退出 / P1 挂死；工作区 5/5 复现 |
| 20b 定位到确切机制 | ✅ `after` 早于 `before` 结束 + 赋值在 `await` 之后（最小复现可证） |
| 20c 修复后自行退出 | ✅ 探针 P2；E1 工作区实跑亦退出 |
| 20d 红灯门不放松 | ✅ 探针 P3；`--test-force-exit` 作为反例被否 |
| 20e AC 作用域不变 | ✅ `scopedAcKeys` / `scopingMode` 断言全绿 |
| 20f 全仓门槛 | ✅ `-r typecheck && -r lint && -r test` **exit 0**：16 包 / **1805 测试 / 0 失败** |
| 20g 真实批次检验 | ✅ **达成**——L1-M4l（E1×3）全批 **0 个检查超时、0 个 `test` 检查失败**（L1-M4k 是 16 / 16）；正对照确认作用域命令带 `--test-timeout=100000` |

> ### 🔴 勘误（2026-10-20）：**20g 由「✅ 达成」降级为「⚠️ 未证伪」，PL-M20 不判「已收口」**
>
> 理由见本文件 E2E 段的勘误块。一句话：**L1-M4l 的「0 超时」是未观测**——全批 10 个 `test`
> 检查**每一次都正常返回**，挂死路径一次都没被走到；而 L1-M4m run 3 走到了，**7 个带
> `--test-timeout=100000` 的检查仍然超时**。
>
> **20a–20f 不受影响**：它们验的是命令形状、探针不变量、红灯门与门禁，**都与批次无关**。
> 但 **20c 的第二个分句「E1 工作区实跑亦退出」应视为未验证**——它在 `packages/eval/results/`
> 下没有产物（`n13-probe/` 里只有合成夹具的 `report.json`）。
>
> **仍然有效**：§1 的根因（`--test-name-pattern` 只筛测试名、文件照跑）、§2 的 `--test-timeout`
> 选型（**否决 `--test-force-exit` 的理由依然成立**——它把挂死静默变成通过）、§3 的
> `CHECK_TIMEOUT` 记账码（L1-M4m 的 `验证门失败码：CHECK_TIMEOUT×7` 正是靠它读出来的）。
> **失效的只有一条**：「把「不返回」变成有界的失败」这个**保证**在生产取值上不成立。
>
> **状态**：PL-M20 **回到「实施完成、待重新验证」**。收口条件＝在**真实 E1 工作区**上取得
> 带 `--test-timeout` 的作用域命令的**退出码与耗时**，并据此判定候选机制（见 E2E 段勘误块）。

---

## Next Phase Boundary

**PL-M20 已收口（判据 20a–20g 全部达成）。**

> **🔴 勘误（2026-10-20）：上面这句已被推翻，本文件其余正文按历史记录保留不改。**
>
> **PL-M20 的状态是「实施完成、待重新验证」，不是「已收口」。** 判据 **20g 由「✅ 达成」降级为
> 「⚠️ 未证伪」**（20a–20f 不受影响）；**20c 的第二个分句「E1 工作区实跑亦退出」应视为未验证**
> （在 `packages/eval/results/` 下没有产物）。
>
> **L1-M4m 批次（E1×3，3/3 完整跑满）是本文件 §1/§2/§3 之外的第一个反证**：run 3 有
> **7 个检查超时**，而它们的命令**都带 `--test-timeout=100000`**。**「把「不返回」变成有界的失败」
> 这个保证在生产取值上不成立**；**L1-M4l 的「0 超时」是未观测**（10 个 `test` 检查每一次都正常
> 返回，挂死路径一次没被走到）。
>
> **收口条件**（与上方 Acceptance Result 勘误块一致）：在**真实 E1 工作区**上取得带
> `--test-timeout` 的作用域命令的**退出码与耗时**，并据此判定 E2E 段勘误块里列的三个候选机制。
> **在此之前不得登记新修法。** 完整记账见 `docs/189` §9.3、`docs/146` §3 / §5、`docs/127` §0 / §9。

**未开始事项（STOP）**：

- **`docs/187` §2.5 七项观察一项未修**——按 §7 第 6 项「只登记，本批一项都不修」。
- **L1-M4l 新登记的四项观察一项未修**（见 Known Issues 6–10）——**其中第 6 项 anti-tamper 是
  下一阶段的首要候选**：它是全批**唯一**的致败点，三个 run 的终止全落在它上面。
- **N-12 / PL-M19 仍未被行使**（L1-M4k 与本批皆零触发）⇒ 它仍是**未被证伪、也未被检验**的状态。
- **staging 段 0/3 ⇒ L1-8 仍未达成**；全批**零交付任务**，交付段从未开始。
- **下一批开工前仍须先停掉并重启 `:47558` 实例**——任何改动 `apps/server` 的修复都会让现存实例陈旧
  （`l1-m4-server-launch.sh` 只要端口有应答就静默复用，不会自己发现）。
- **〔2026-10-20 追加〕N-13 的挂死问题仍未解决**（L1-M4m run 3 七次 `CHECK_TIMEOUT`）；
  **PL-M20 回到「实施完成、待重新验证」**。同批新登记 **N-18**（计划点名的 `scripts/` 交付物无人可写）、
  **agent 600s 超时**、**replan 不收敛**、**`errorTypes` 双粒度相加**——逐条见 `docs/189` §9.3。
