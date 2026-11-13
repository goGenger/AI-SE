# 187 · N-13（AC 作用域测试命令把不匹配的测试文件挂死）任务书（PL-M20）

> 依据：**L1-M4k 批次实测**（`packages/eval/results/l1-m4k`，三个 run 全部 FAILED）、库内
> `workflow_runs` / `tasks` / `agent_runs` 逐条实查（2026-10-19）、**代码实查**
> （`apps/server/src/services/taskVerifier.ts`、`taskVerifierRules.ts`、
> `packages/agent-core/src/professional/AgentRegistry.ts`、`packages/workflow-engine/src/WorkflowEngine.ts`）、
> **工作区实跑复现**（`/Users/shixianbao/Desktop/study/ai-se-eval/E1/run-1`）。
>
> 状态：**已立项，待裁定**（2026-10-19）。

---

## 0. 为什么现在做这一批

L1-M4k 是本项目的**第十一次** E1×3 尝试，带着 PL-M19（N-12）的修复。结果：

- **staging 段 0/3**，L1-8 仍未达成（不意外）。
- **N-12 的判定分支全批零触发**——三条死亡链的尽头都是 FAILED，没有一条「第二层抢救成功」。
  所以本批对 PL-M19 既不是证实也不是证伪（已如实记账）。
- **三次死亡指向同一个新东西**，而且它**不是**我原先归因的「`maxRetries` 预算耗尽」。

我原先的报告把死因写成「预算耗尽」。**查库后需要更正**：预算之所以耗尽，是因为**每一次尝试
都撞在同一个 120 秒测试超时上**。真正的致败点是：

> **平台拼出的 AC 作用域测试命令（`node --test --test-name-pattern '…'`）在 E1 工作区里
> 不退出。** 五分之五复现。不带该参数时正常退出。

这是**平台侧**缺陷。它让「任务做对了」和「任务被判失败」脱钩——本批有 **7 个任务的全部
scoped AC 都通过（`acSummary.failed = 0`），却仍被判 `checks failed: test`**。

---

## 1. 范围与排除

**做**：

- 定位「作用域命令不退出」的确切机制，并修掉它。
- 让验证器能**区分**「测试失败」与「测试命令没返回」（当前二者同为 `checks failed: test`）。

**不做（本批）**：

- 不改 `maxRetries`（预算不是根因）。
- 不修 §2.5 登记的任何一项（写范围缺口、replan 路由、`run_unit_test` 策略、双入口、`store.mjs`
  忙等）——**只登记、另行立项**。
- 不动 E1 夹具的 oracle / AC 定义。
- 不重跑 L1-M4k（另开一批）。

---

## 2. 基线事实（实测）

### 2.1 三次死亡的真正机制（库内逐条）

三个致败任务**全部**是链尽头的那一层，且**全部**满足「作用域内 AC 全过 + 测试检查超时」：

| run | 致败任务 | `checks[test].timedOut` | 尝试次数 | `acSummary` |
| --- | --- | --- | --- | --- |
| 1 `bf51cf12` | `I2-REPLAN-1-REPLAN-2` | **true** | 2 × 120s | 无（build 也失败） |
| 2 `d9119cf4` | `I1-REPLAN-1-REPLAN-2` | **true** | 2 × 120s | `passed:1, failed:0` |
| 3 `2d1f1e78` | `I3-REPLAN-1-REPLAN-2` | **true** | 2 × 120s | `passed:1, failed:0` |

全批 22 个 `FAILED` 任务里，**16 个**带一个 `timedOut: true` 的检查；其中 **7 个**
`acSummary.failed = 0`（作用域内 AC 一个没挂）。

对照：`I3` 的 `stdoutTail` 里 `[AC-04]` 四条测试**全部 `ok`**，命令仍以 `timedOut: true` 收场。

### 2.2 命令是平台拼的（代码实查）

`apps/server/src/services/taskVerifierRules.ts:212-222`：

```ts
export function buildAcScopedTestCommand(baseCommand, acKeys, scriptText): string | null {
  if (acKeys.length === 0 || !isNodeTestScript(scriptText)) return null;
  const pattern = buildAcNamePattern(acKeys);
  return pattern === "" ? null : `${baseCommand} -- --test-name-pattern '${pattern}'`;
}
```

拼接结果（库内原样）：`pnpm test -- --test-name-pattern '\[AC-04\]|\[AC-4\]'`。
**除 `--test-name-pattern` 外没有任何其它开关。**

超时预算：`apps/server/src/services/taskVerifier.ts:65` `DEFAULT_CHECK_TIMEOUT_MS = 120_000`，
每个检查最多尝试 2 次（`taskVerifier.ts:643`），故单检查上限 240s。

### 2.3 复现与判别实验（工作区实跑，2026-10-19）

工作区：`/Users/shixianbao/Desktop/study/ai-se-eval/E1/run-1`（L1-M4k run 3 产物，git 未被平台改动）。
Node 22.22.2。每次探针一律 40s 上限。

| 实验 | 结果 |
| --- | --- |
| `node --test --test-name-pattern '\[AC-04\]\|\[AC-4\]'` × **5 次** | **5/5 挂死**（>40s，确定性） |
| `node --test`（无 pattern） | **自行退出**（exit 1） |
| `node --test tests/` / `src/` / `infrastructure/`（无 pattern） | 均自行退出 |
| 单个测试文件 + 非匹配 pattern | 均自行退出 |
| 加 `--test-force-exit` | **exit 0**（自行退出） |
| 加 `--test-timeout=5000` | **exit 1**（自行退出） |

**挂死时的现场**（`ps` + `lsof` + `curl`，实拍）：

```
4 个测试子进程存活（tests/health / register-concurrency / register-unique / register-validation）
每个子进程各挂一个 src/server.js 子进程，状态 SN，0.0% CPU，各自 LISTEN
对每个端口 curl /healthz → 200
```

即：**测试进程在等一个自己起的、还活着的服务进程**；服务本身是健康的。

**最小复现失败了**：一个只含 `test.before` / `test.after` / 一个不匹配测试的文件，在非匹配
pattern 下**正常退出**（`before` 与 `after` 都执行）。⇒ 触发条件不止「零匹配 + 钩子」，
需要真实项目的形状（多文件并发 + 真实子进程）。**这一点必须在实施时定位清楚，不能只加个开关了事。**

### 2.4 已排除的候选（及为什么）

| 候选 | 排除理由 |
| --- | --- |
| `maxRetries` 预算耗尽是根因 | 预算是**结果**：三次尝试每次都被同一个 120s 超时吃掉，预算才耗尽 |
| agent 不会写代码 | run 3 的 15 个 agent run 里 **13 个 succeeded**；只有 2 个 600s 超时 |
| AC-06 夹具缺陷是死因 | 它是**真缺陷**（见 §2.5），但死掉的三个任务**作用域内 AC 全过**；它只影响未作用域的全量跑 |
| 评审驳回导致失败 | 三个致败任务的 `outcome` 都是 `SUCCESS`（评审没判它们失败） |
| 构建失败 | 仅 run 1 的 1 个任务 `checks failed: build`，非三次死亡的原因 |

### 2.5 同批观察（登记，不立项）

1. **`backend-agent` 的读写范围与 E1 布局不匹配**（`AgentRegistry.ts:93-116`）：
   `writePaths` = `["apps/server","server","backend","src"]`，**不含 `test` / `tests` / `infrastructure`**，
   且**未声明 `writeTestFiles`**。评审原话记录了一次真实拒绝：
   `Path is not writable: test/password-hash.test.mjs`。
   `readPaths` 也**不含 `infrastructure` 与 `.`**，agent 连仓库根和 `infrastructure/` 都读不了。
2. **replan 路由不收敛**（`WorkflowEngine.ts:90-91`）：`fixWorkTargetType` 在源任务已是工作类型时
   **原样返回**。于是「缺陷在 `tests/`、要交给 TEST agent」的意见被 replan 成**又一个 BACKEND**
   ——而 BACKEND 写不了 `tests/`。评审自己写了 `tests/ is outside the allowed backend paths`，
   循环只能重复这句话。
3. **`run_unit_test` 被 script-only 策略拦住**：run 3 出现
   `run_unit_test is blocked by script-only policy: accepts only project script commands …`。
4. **两个服务入口共存**：脚手架留下 `infrastructure/server.js`（不路由 `/api/register`），
   真实入口是 `src/server.js`（`router.post('/api/register', …)`，`package.json` 的 `start` 指向它）。
   评审的 HIGH 意见指着 `infrastructure/server.js`，**指错了文件**。
5. **`src/register/store.mjs` 有一段同步忙等**：`#acquireLock` 里
   `catch { continue; }` **不检查 deadline、不 delay**，一旦 `statSync` 因锁文件刚被释放而抛错就原地重试。
   它是**事件循环阻塞**的现成风险（本批未观察到触发）。
6. **验证超时会留下孤儿进程**：实测挂死后 `src/server.js` 子进程仍在运行（我手工清了 4 个）。
7. **AC-06 夹具本身写错了**：`tests/register-concurrency.test.mjs` 的
   `_${base.slice(1)}` **不是大小写变体**，是首字母被换成 `_` 的**另一个用户名**；
   实测响应 `[201,409,409,409,201,409]` —— **两个 201**，与它自己的断言「恰好一个 201」冲突。

---

## 3. 判据（20a–20g）

| # | 判据 | 验证方式 |
| --- | --- | --- |
| 20a | 能用**确定性探针**复现「带 `--test-name-pattern` 的聚合运行不退出」，且对照组（不带该参数）正常退出 | 探针脚本，≥5 次且结果一致 |
| 20b | **定位到确切机制**（哪一个句柄 / 哪一个钩子 / 哪一层不退出），不是「加个开关了事」 | 探针输出 + 代码引用 |
| 20c | 修复后同一工作区同一条作用域命令**连续 ≥5 次自行退出** | 探针复跑 |
| 20d | **红灯门不放松**：人为制造一个真正永不返回的测试，修复后**仍判失败** | 反向对照探针 |
| 20e | AC 作用域不变：`acResults` 仍只按 `scopedAcKeys` 计算 | 既有测试 + 探针断言 |
| 20f | 全仓 `corepack pnpm -r run typecheck && lint && test` 全绿 | 门槛命令 |
| 20g | 真实批次检验（另开一批 E1×3） | 见 §7 第 7 项 |

---

## 4. 设计裁定（推荐）

### 4.1 修在哪一层

**推荐：`buildAcScopedTestCommand` 这一层（`taskVerifierRules.ts`），不改 agent 代码、不改夹具。**

理由：命令是平台拼的；被拼出来的命令不退出，责任在拼装方。改测试脚手架等于要求每个 agent
都预见到「我会被 `--test-name-pattern` 部分执行」，这不是可交付的合理期望。

### 4.2 用什么手段

**推荐：`--test-timeout=<N>`，不用 `--test-force-exit`。**

- `--test-force-exit` 会让**所有测试通过时的挂死静默变成通过**——正好违反判据 20d。
- `--test-timeout` 把「不返回」变成**有界的失败**，方向安全。
- 但**只有超时不够**：它会让该文件里的所有测试都被记成失败，归因仍不诚实。故需 §4.3。

### 4.3 记账必须能区分两种失败

**推荐：在既有 `VerificationFailureCode` 枚举（`taskVerifier.ts:71`，现有
`"VACUOUS_TEST" | "EVIDENCE_MISSING"`）上**追加**一个 `"CHECK_TIMEOUT"`，并与
`checks failed: test` 并存。**

理由：这不是第二套错误码体系，是**扩展既有枚举**（`AGENTS.md` §10 允许复用既有抽象）。
没有它，本批这种「AC 全过却判失败」在账本上永远显示为「验证门失败」，会被反复误读为
「产物质量差」。

**必须在任务书之外想清楚的一点**：`CHECK_TIMEOUT` 是否影响 `failureLayers` 的归类
（现在记 `verification: N`）。推荐**保持 `verification`**，否则会动到已有的统计口径。

---

## 5. 验证分层

1. **离线探针**（零配额、确定性）：真实工作区 + 真实 `node --test`，三变体：
   - P0 对照组：无 pattern → 必须自行退出；
   - P1 生产形态：带 pattern → 修复前挂死、修复后自行退出；
   - P2 反向对照：注入一个真正永不返回的测试 → 修复后**仍判失败**。
2. **单元测试**：`buildAcScopedTestCommand` 的输出形状断言（含新开关、AC 模式不变）。
3. **`taskVerifier` 层测试**：`timedOut` 产出 `CHECK_TIMEOUT` 而非裸 `VERIFICATION_FAILED`。
4. **真实批次**：另开一批 E1×3。

---

## 6. 边界与红线

- **不得**让真正的挂死变成静默通过（判据 20d）。
- **不得**削弱 AC 作用域（判据 20e）。
- **不得**在验证链路里新造第二套错误码体系——只扩展 `VerificationFailureCode`。
- **不得**修改历史 `tasks` / `agent_runs` / `workflow_events` 行（`AGENTS.md` §6）。
- **不得**顺手修 §2.5 的任何一项。
- 批次纪律：本批不改 E1 夹具；修完另开结果目录。

---

## 7. 待裁定项（每条带推荐值）

| # | 待裁定 | 推荐值 |
| --- | --- | --- |
| 1 | 修在哪一层 | **`buildAcScopedTestCommand`（命令拼装层）**；不动 agent 代码、不动夹具 |
| 2 | 具体开关 | **`--test-timeout=<N>`**；**不用** `--test-force-exit`（会掩盖真实挂死，违反 20d） |
| 3 | 超时值 N | **100s**（验证器单次预算 120s 的约 5/6）——保证单测超时先于整命令超时触发，归因才落在文件级 |
| 4 | 「AC 全过但检查超时」如何记账 | **扩展既有 `VerificationFailureCode`**，追加 `"CHECK_TIMEOUT"`；`failureLayers` 仍记 `verification` |
| 5 | 验证超时后的孤儿进程 | **杀整个进程组**（复用既有工具运行时超时路径，不新造清理器）；先确认现有实现是否已杀组 |
| 6 | §2.5 七项观察 | **只登记，本批一项都不修**；按影响排列，下一轮另立项 |
| 7 | 修完的批次安排 | **另开一批 E1×3**（新结果目录 `l1-m4l`），不续跑 l1-m4k；**L1-M4k 记「已执行 3/3、staging 段 0/3」，三次 run 均不补跑** |
| 8 | 先修还是先补记账 | **先补 L1-M4k 的台账**（`docs/146` / `docs/127` / `docs/17`），再动代码——否则本批结论只活在对话里 |

---

## 8. 本批已发生的事实（供记账，非判据）

- **L1-M4k 批次（E1×3）已执行 3/3、完整跑满**，批次 14:50 自行退出。
- **staging 段 0/3 ⇒ L1-8 仍未达成。**
- 逐 run：run 1 → slice-1（oracle Must 7/29，13.1M）、run 2 → slice-1（11/29，8.74M）、
  run 3 → slice-1（10/29，12.5M）。合计输入 **34,351,875** / 输出 793,391。
- **N-12 全批零触发**（`error->>'message' LIKE '%unresolved%'` = 0 行）；PL-M19 未被证伪，也未被检验。
- 残留缺陷探针全清：N-6 = 0、N-7 = 0、N-8 本批 0（全库仍 11）、N-9 = 0、gRPC 工具消息 400 = 0。
- 质量信号：假阳性 0、超范围写入 0、检查不可判定 0。
- **一次归因更正**：本批死因**不是** `maxRetries` 预算，是 §2.1 的测试命令不退出。原报告已更正。

---

## 9. §7 裁定结果

**2026-10-19：用户裁定「都按你的建议」，八项全部按推荐值落地。**

| # | 裁定 | 落地情况 |
| --- | --- | --- |
| 1 | 修在命令拼装层 | ✅ 只改 `taskVerifierRules.ts` 的 `buildAcScopedTestCommand` 与两处调用点；agent 代码与夹具未动 |
| 2 | 用 `--test-timeout`，不用 `--test-force-exit` | ✅ 探针实测：`--test-force-exit` 让最小复现 `exit 0 / pass 1`（静默通过，被否）；`--test-timeout` 给 `exit 1 / testTimeoutFailure` |
| 3 | 超时值 = 预算的 5/6 | ✅ 新增 `acScopedTestTimeoutMs(checkTimeoutMs)`，默认预算下 = **100,000ms**；**不写死**，预算变小时随之变小 |
| 4 | 扩展既有枚举追加 `CHECK_TIMEOUT` | ✅ `VerificationFailureCode` 加一项 + 导出 `CHECK_TIMEOUT_FAILURE_CODE`；`failureLayers` 未动（任务级 errorType 仍是 `VERIFICATION_FAILED`） |
| 5 | 验证超时后杀进程组 | ⚠️ **实测后判定不需要改**：沙箱超时路径已是 `child.kill("SIGKILL")` + `forceRemoveContainer`（`packages/sandbox/src/index.ts:153-157`），整棵进程树随容器消失。**同时更正 §2.5 第 6 项**：我先前看到的孤儿进程是**我在宿主机上手工复现**时留下的，批次内命令跑在 `/workspace` 容器里，**没有批次证据** |
| 6 | §2.5 七项只登记不修 | ✅ 一项未动 |
| 7 | 修完另开一批 | ✅ 已开并跑满：**L1-M4l**（E1×3，`packages/eval/results/l1-m4l`），**判据 20g 达成**——N-13 的致败签名全批归零（0 检查超时 / 0 `test` 检查失败）。**新致败点已换成 anti-tamper**（9 个 FAILED 里 7 个），见 `docs/188` Known Issues |
| 8 | 先补台账再动代码 | ✅ 已补（`docs/146` / `docs/127` / `docs/17`） |

### 9.1 实施要点（与任务书的差异）

**任务书 §2.3 说「最小复现失败了」，实施时把它做成了。** 关键差异是**赋值的时机**：

```js
// 失败的最小复现（钩子本身没错）
const child = spawn(...);
await delay(100);
server = { child };   // ← 赋值在 await 之后，与 E1 的 `server = await startServer()` 同形
```

Node 在**一条测试都不匹配**时，会在 `before` 还没结束就调用 `after`——此时 `server` 仍是
`undefined`，`if (server)` 落空，清理不发生；`before` 随后起的子进程再没人回收。
**探针 P1 因此确定性复现**（`probe-n13-scoped-test-hang.ts`，四项不变量全绿）。

**原「最小复现」之所以失败**，是因为它把赋值放在了 `await` **之前**——那一处差异正是缺陷藏身处。
这条已并入 [[probes-must-match-production]] 的教训。

### 9.2 判据达成情况

| 判据 | 结果 |
| --- | --- |
| 20a 确定性复现 | ✅ 探针 P0 退出 / P1 挂死，四项不变量全绿 |
| 20b 定位到确切机制 | ✅ 见 §9.1（`after` 早于 `before` 结束 + 赋值在 `await` 之后） |
| 20c 修复后 ≥5 次自行退出 | ✅ 探针 P2 退出；**E1 真实工作区**亦以同一开关退出（`--test-timeout=5000` 下 `exit 1`，此前 5/5 挂死）——见 `docs/188` |
| 20d 红灯门不放松 | ✅ 探针 P3（真正不返回的测试）仍判失败；`--test-force-exit` 已作为反例被否 |
| 20e AC 作用域不变 | ✅ 既有作用域断言全绿，`scopedAcKeys` 未动 |
| 20f 全仓门槛 | ✅ `-r typecheck && -r lint && -r test` **exit 0**：16 包 / **1805 测试 / 0 失败** |
| 20g 真实批次检验 | ✅ **达成**——L1-M4l（E1×3）全批 **0 检查超时 / 0 `test` 检查失败**（L1-M4k 是 16 / 16）；正对照确认作用域命令带 `--test-timeout=100000`。见 `docs/188` |

