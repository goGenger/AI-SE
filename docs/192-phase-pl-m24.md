# 192 · PL-M24（N-13 的修法：把 `--test-timeout` 从「够一个文件」改成「够 N 个文件」）实施记录

> 立项：2026-10-20。用户裁定「按你的推荐，先做 (1)」。
> 基线：**真实 E1 工作区实测**（`~/Desktop/study/ai-se-eval/E1/run-1`，L1-M4m run 3 收尾态）
> ＋ 库内 7 条 `timedOut=true` 检查的命令原文 ＋ `packages/eval/results/n13-e1-probe/`。
> 依据：`docs/188` E2E 段的 2026-10-20 追加块（缺失产物已补齐、机制已定）、`docs/146` §4 的 PL-M20 裁定项。
> 状态：**已实施、已在真实工作区上验证修法**；**未在真实批次验证**。

---

## 1. 缺陷（机制，已实测）

PL-M20 给作用域命令追加了 `--test-timeout`，但取值是**验证器单次预算的 5/6**（120s ⇒ 100s）——
**那是「够一个文件」的余量**。而：

1. `--test-name-pattern` 只筛**测试名**、文件照跑（PL-M20 §1，未变）；
2. 作用域命中 **0 个测试**的文件仍执行**文件级 `before`**（真实 E1 工作区里它 spawn 一个真实的
   `src/server.mjs`），该钩子永不结束 ⇒ **该文件**烧掉**一整个** `--test-timeout`；
3. `--test-timeout` 是**按文件/按钩子**计，不是按整条命令计；
4. 沙箱是 **`--cpus 1`**（`packages/sandbox/src/index.ts:50` 的 `DEFAULT_LIMITS`）⇒ 容器内
   `os.availableParallelism() = 1`（实测；`os.cpus().length` 仍是 10）⇒ Node **串行**跑测试文件；
5. ⇒ **N 个永不结束的文件烧 N × 100s**。实测每个作用域 **N = 3~4**（`[AC-01]`→4、
   `[AC-07/08]`→4、`[AC-02..06]`→3、`[AC-09/12/13]`→3）⇒ **300~400s ≫ 120s 预算** ⇒ `CHECK_TIMEOUT`。

**宿主机 10 核上这些文件并发跑，所以只有 100.5s** ⇒ 探针（合成夹具，且跑在宿主机上）结构上测不到。
这是 `probes-must-match-production` 的又一例：被简化掉的 **1 CPU 串行化**正是缺陷藏身处。

---

## 2. 修法

```ts
export const MAX_NEVER_COMPLETING_TEST_FILES = 5;

export function acScopedTestTimeoutMs(checkTimeoutMs: number): number {
  return Math.floor(checkTimeoutMs / (MAX_NEVER_COMPLETING_TEST_FILES + 1));
}
```

- **取值 = 预算 / (1 + 允许永不结束的文件数)**；允许 5 个 ⇒ 120s 预算下 **20s**。
- **刻意不写死**：仍随预算缩放（30s 预算 ⇒ 5s）。
- **`N ≥ 6` 时退化为今天的现状**（沙箱在 120s 掐掉）——**只会变好，不会引入新的失败形态**。

**代价基线（真实 E1 工作区实测）**：整份**串行**套件 **4,307ms / 106 用例 / 全过**，
**最慢单测 667ms** ⇒ 20s 有约 **30 倍**余量，不会误杀正常测试。

---

## 3. Modified Files

| 文件 | 动作 |
| --- | --- |
| `apps/server/src/services/taskVerifierRules.ts` | 改：新增导出常量 `MAX_NEVER_COMPLETING_TEST_FILES = 5`；`acScopedTestTimeoutMs` 由 `floor(budget × 5/6)` 改为 `floor(budget / (N+1))`；两处文档注释重写（记机制、记实测 N、记代价基线） |
| `apps/server/src/__tests__/taskVerifierRules.test.ts` | 改：import 增常量；既有例的 3 处硬编码值同步（`100000`→`20000`、`100_000`→`20_000`、`25_000`→`5_000`）；**新增 1 例**（多文件不变式 ＋ 旧值反向对照） |
| `apps/server/src/__tests__/taskVerifier.test.ts` | 改：**14 处硬编码作用域命令串**同步（`--test-timeout=100000` → `--test-timeout=20000`），**未弱化任何一条** |
| `packages/eval/results/n13-e1-probe/pl-m24-fix-verification.json` | **新增**（修法的 A/B 产物） |
| `packages/eval/results/n13-probe/report.json` | **被覆写**——复跑 `probe-n13-scoped-test-hang.ts` 时它按设计重写了自己的产物，超时值随代码由 `--test-timeout=10000` 变为 `=2000`。**旧读数在 `docs/188` 的勘误块里有逐字引用**（`# duration_ms 10012.078042` / `--test-timeout=10000`），叙述未丢；机器可读的旧文件未留副本。**如实登记**（见 Known Issue 7） |
| `docs/192-phase-pl-m24.md` | **新增**（本文件） |
| `docs/146` / `docs/127` / `docs/17` | 改：台账 |

**未改**：`packages/eval/scripts/l1-m4l-e1-x3.sh` 第 71 行的注释（`Expect --test-timeout=100000`）
与 `l1-m4m-e1-x3.sh` 第 136 行——**它们是那两个已执行批次的记录**，改动会篡改历史；两批都不会续跑
（项目纪律：不续跑旧批次，否则会把修前/修后两个平台版本混进同一批次）。

---

## 4. Implementation

### 4.1 为什么是「除以 N+1」而不是别的

被否掉的两个候选：

| 候选 | 否决理由 |
| --- | --- |
| 提高 `--test-concurrency`（让挂死文件并发烧，N 不再累加） | 沙箱只有 1 个 CPU，强制并发会让工作区里的 `reserveEphemeralPort` **TOCTOU 端口竞争**变多（每个文件都 spawn 真实服务），且拖慢通过项。**引入新的抖动来源，代价高于收益。** |
| 按文件内容预筛（只把含该 AC 键的文件交给 `node --test`） | **数据否决**：`login-contract.test.mjs` 对 `AC-01` 的 grep 命中 **7 次**（全在注释与 `[AC-10]` 一类串里）而**匹配的测试名 0 个** ⇒ 预筛会**原样留下全部挂死文件**。 |

### 4.2 新增的不变式测试

```ts
const budget = 120_000;
const perFile = acScopedTestTimeoutMs(budget);
expect(perFile * MAX_NEVER_COMPLETING_TEST_FILES).toBeLessThan(budget);   // 正向：够 5 个文件

const legacy = Math.floor((budget * 5) / 6);
expect(legacy * 4).toBeGreaterThan(budget);                               // 反向：旧值连 4 个都装不下
```

反向对照把**旧的 5/6 取值钉在「装不下 4 个文件」上**——实测 N=4 正是 L1-M4m run 3 那七次
`CHECK_TIMEOUT` 的成因。

---

## 5. Tests

| 套件 | 结果 |
| --- | --- |
| `@ai-se/server` | **306 用例**（改动前 305，**+1**）——`taskVerifierRules.test.ts` 新增 1 例；14 处硬编码命令串同步 |
| 全仓 `-r run test` | 见 §7 E2E 的如实记录 |

**新增例验过的两件事**：① 正向不变式（5 个文件 × 每文件超时 < 预算）；② 反向对照（旧值 × 4 > 预算）。

**既有 N-13 探针复跑（确认不腐烂）**：`probe-n13-scoped-test-hang.ts` 四项不变量仍全绿——
P0 `EXIT 0` / P1 **`HANG`**（复现）/ P2 `EXIT 1` / P3 `EXIT 1`（红灯仍判失败），
唯一变化是它算出的超时值随代码由 `10000` 变为 `2000`。**产物被覆写一事见 Known Issue 7。**

---

## 6. Lint / Typecheck

- `corepack pnpm --filter @ai-se/server typecheck` **exit 0**
- `corepack pnpm --filter @ai-se/server lint` **exit 0**
- 全仓 `corepack pnpm -r run typecheck` **exit 0**、`corepack pnpm -r run lint` **exit 0**

---

## 7. E2E

### 7.1 修法的真实工作区验证（本项的判据 24c）

在**真实 E1 工作区**上按**沙箱条件**（`--test-concurrency=1`，因为宿主机 10 核不会自己串行化）
跑同一条作用域命令，只改 `--test-timeout` 的取值：

| | **V_old** `--test-timeout=100000` | **V_new** `--test-timeout=20000` |
| --- | --- | --- |
| 退出 | **否**（130s 窗口内不退出） | **是** |
| 耗时 | ≥ 130,000ms | **81,707ms** |
| 退出码 | — | 1 |
| TAP | —（被窗口掐掉） | `# tests 29 / pass 25 / **fail 0** / cancelled 4` |
| 对 120s 预算 | **超** | **余 38s** |

⇒ **旧值在生产取值下必然超时（复现 L1-M4m 的形态）；新值落在预算内并保住 TAP。**
产物：`packages/eval/results/n13-e1-probe/pl-m24-fix-verification.json`。

算术自洽：N=4 × 20s = 80s，加通过项收尾 ⇒ 81.7s。

### 7.2 全仓 `-r run test`（如实记录，**不做单侧断言**）

跑了 **4 次**，`apps/server` 的失败数依次为 **2 / 2 / 0 / 1**，**每次点名的文件都不同**：

| 次数 | 失败文件 | 隔离复跑 |
| --- | --- | --- |
| 1 | `deliveryApi.e2e`、`v1GoldenScenario.e2e`（server restart） | **2/2、4/4 通过** |
| 2 | （未逐条抓名）2 例 | — |
| 3 | **无失败——16 包全绿** | — |
| 4 | `sliceFlow.e2e` | **2/2 ×2 通过** |

另单跑 `@ai-se/server` 一次失败的是 `failureRecovery.e2e`，**隔离复跑 10/10 ×3 通过**。

**判定**：**五次点名、五个不同文件、每一个隔离复跑都通过** ⇒ `docs/145` #7 同族的**负载敏感抖动**
（PL-M10 / M11 / M13 / M14 / M16 / M17 / M22 / M23 撞到的是同一族，但**具体文件每次不同**）。
本次改动只把生成命令里的一个数字从 `100000` 换成 `20000`，**与上述任何一个文件都无因果**
（它们都不读该常量、不跑作用域命令）。**未据此改动任何测试。**

---

## 8. Architecture Changes

**无。** 未新增包、未改契约、未新增错误码、未改 `failureLayers` 的分层口径。
改动的是**既有**纯函数的一个取值与一条导出常量。

**口径变更（须登记）**：作用域命令里的 `--test-timeout` 由 **100000** 变为 **20000**（默认 120s 预算下）。
**与既往批次的 `command` 字段不再逐字相同**；但**判定口径未变**（`CHECK_TIMEOUT` 的产出条件一字未动），
故 `verificationFailureCodes` 的**可比性不受影响**。

---

## 9. Dependencies

**无新增、无升级、无删除。**

---

## 10. Known Issues

1. **本项买到的是「有界 + 可归因」，不是解冻。** 新值下检查仍然 `exit 1`、任务仍判 **FAILED**——
   V_new 的 `# fail 0 / # cancelled 4` 只是**让账本能看见**「作用域内 AC 全过、只是文件挂了」，
   而不再是被沙箱掐掉、什么都不剩。**单靠本项，L1-8 不会达标。**
2. **`N ≥ 6` 仍会超预算**，退化为今天的现状（沙箱 120s 掐掉）。实测 N = 3~4，余量为 1~2 个文件。
   若某个工作区出现更多挂死文件，本条会再次触发——**届时的读数应是「TAP 又不见了」**。
3. **20s 对更慢的夹具是未经检验的**。代价基线只在 E1 上量过（最慢单测 667ms）。其余夹具
   （S1/M1/L1/L2/M2/M3/S2/S3）的测试都更小，但**没有逐个实测**。
4. **「只有挂死、无真实失败 ⇒ 通过」是另一条判定口径，本项刻意不做。** 它才会解冻 L1-8，
   但离 `--test-force-exit` 的「把挂死静默变成通过」只有一步。若要做，判据必须**可机械验证**
   （仅当 `# fail 0` 且**全部取消条目都是「零匹配测试的文件级条目」**时放行，并留 `hangOnly` 证据字段）。
5. **未在真实批次验证** ⇒ **PL-M24 不判「已关闭」**。关闭条件＝下一批 E1×3 里
   作用域检查**不再出现「被沙箱掐掉、无 TAP」的 `CHECK_TIMEOUT`**。
6. **探针仍未入库。** 本次的测量靠临时脚本（`/tmp/n13-e1/runner.mjs`）驱动，产物已留档但**脚本未入仓**。
   若要让它成为可复跑的验收工具（下一批验证本项时要用），须落成
   `apps/server/scripts/probe-n13-e1-workspace.ts`（接受工作区路径参数，工作区缺失时 SKIP）。
   **本批未做**——留到需要它的时候再落，避免为一个尚未复跑的探针先造结构。
7. **既有探针的产物被覆写（如实登记）。** 收尾时复跑了 `probe-n13-scoped-test-hang.ts` 以确认它不因
   本次改动而腐烂（**四项不变量仍全绿**：P0 `EXIT 0` / P1 `HANG` / P2 `EXIT 1` / P3 `EXIT 1`，
   只是超时值随之变成 `--test-timeout=2000`）。但该探针**按设计重写自己的产物**
   `packages/eval/results/n13-probe/report.json`，**旧的那份（`--test-timeout=10000`）没有留副本**。
   旧读数在 `docs/188` 的勘误块里有**逐字引用**（`# duration_ms 10012.078042`），叙述未丢。
   **教训**：探针产物若已被文档引用，复跑前应先另存旧件——本批没做，故如实登记。

---

## 11. Acceptance Result

**PASS（判据 24a–24f 达成、24g 不适用）。**

| 判据 | 结果 |
| --- | --- |
| 24a 取值按「文件数」定，不再按「单文件」 | ✅ `floor(budget / (N+1))`，`N = MAX_NEVER_COMPLETING_TEST_FILES = 5` |
| 24b 不变式有测试钉住（含反向对照） | ✅ 新增例：正向 `perFile × N < budget`；反向 `legacy × 4 > budget` |
| 24c 真实工作区验证 | ✅ A/B：V_old **130s 内不退出**；V_new **81,707ms 退出**，TAP 保住，余量 38s |
| 24d 全仓门槛 | ✅ `-r typecheck` / `-r lint` exit 0；`-r test` 见 §7.2（**未声称一次全绿**） |
| 24e 不误杀正常测试 | ✅ 代价基线：整份串行套件 4.3s、最慢单测 0.67s ⇒ 30 倍余量 |
| 24f 既有探针不腐烂 | ✅ 复跑 `probe-n13-scoped-test-hang.ts`，四项不变量全绿（P1 仍复现挂死、P3 红灯仍判失败） |
| 24g 未跑真实批次 | ✅ 未跑 |

**⚠️ 本项不改变任务的结局**（检查仍 FAILED）——见 Known Issue 1。**未在真实批次验证 ⇒ 不判「已关闭」。**

---

## 12. Next Phase Boundary

**未开始事项（STOP）**：

- **「只有挂死、无真实失败 ⇒ 通过」未做**（Known Issue 4）——**它是让 L1-8 解冻的那一半**，
  须另行裁定，且判据要可机械验证。
- **探针未入库**（Known Issue 6）——下一批验证本项前须落成 `probe-n13-e1-workspace.ts`。
- **N-15′**（DEBUG 无类型级检查）、**agent 600s 墙上超时**、**replan 不收敛**、
  **`errorTypes` 双粒度相加** —— **四项未修**。
- **N-18 / N-19 / PL-M24 均未在真实批次验证**。
- **未跑任何批次**；下一批开工前仍须先停掉并重启 `:47558` 实例（本批改了 `apps/server` 的源码与 dist），
  且**先跑 `deniedPaths` 普查查询**。
