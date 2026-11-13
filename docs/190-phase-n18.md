# 190 · PL-M22（N-18：计划点名的 `scripts/` 交付物无人可写）实施记录

> 立项：2026-10-20。基线：L1-M4m 批次（`packages/eval/results/l1-m4m`）＋ 库内 `tool_calls` 逐条实查。
> 依据：`docs/146` §3 的 N-18 行、`docs/189` §9.3、`AGENTS.md` §7 / §10。
> 裁定：用户 2026-10-20 直接指令「修 N-18」，并在两个修法候选中选定
> **「对齐两侧 + 派生」**（详见 §2）。
> 状态：**已实施、未在真实批次验证**。

---

## 1. 缺陷（实查，非形状推断）

**计划声明的交付物 `scripts/verify-contract.mjs` 没有任何 agent 可写。**

- `slice-1-task-8`（TEST，标题「验证本地构建契约五步顺序执行」）的 **`description` 原文**：
  「新增并运行 `scripts/verify-contract.mjs`，依次执行 `pnpm install --frozen-lockfile`、
  `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`……」——**路径是计划自己点名的**。
- 该任务 `output.issues` 记下写层原样拒绝：
  `Path is not writable: scripts/verify-contract.mjs (allowed: test/, tests/, …)`。
- **夹具不要求这个路径**：`packages/eval/fixtures/E1/` 全树 grep `verify-contract` **零命中**；
  PRD §二.3 只要求「构建契约（六步全部通过）」。⇒ 路径出自规划器，不是需求。

**机制（代码实查）**：`scripts` **不在任何 agent 的 `writePaths` 里**
（`AgentRegistry.ts:99/124/141/159/194`：frontend / backend / database / qa / devops 五者皆无）；
`ROOT_MANIFEST_PATTERNS`（`packages/shared/src/index.ts:907-914`）与
`ROOT_DELIVERY_ARTIFACT_PATTERNS`（`:962-967`）**都只判仓库根级条目**（带 `/` 的一律为假）；
`isTestFilePath`（`:924`）也不认它。

**影响（两次复现）**：L1-M4m 的 run 1 / run 2 **各有一条完整的 slice-1 TEST 链**死在这里
（run 1 的 4 个 FAILED、run 2 的 2 个 FAILED 全是 `slice-1-task-8*`）。

### 1.1 它属于哪一族

**「重复定义必然漂移」的第五例**（`docs/160` 记为本仓库的缺陷成因类型）。前四例：

| 例 | 漂移的两侧 | 修复 |
| --- | --- | --- |
| PL-M5 | 受保护测试文件的判定（`isTestFilePath`） | 上移 `@ai-se/shared` |
| PL-M10 | 仓库根工程清单 | `writeProjectManifests` + `isProjectManifestPath` |
| PL-M11 | 仓库根交付物 | `writeRootDeliveryArtifacts` + `isRootDeliveryArtifactPath` |
| PL-M12 | 实现类的路径表（手抄 `SOURCE_PATH`） | 改为从 `writePathsForTaskType` 派生 |
| **N-18** | **devops 的构建属地** | **本次：删手抄表，改从 `writePathsForTaskType("BUILD")` 派生** |

**本次的关键证据**：审计侧的 `DEVOPS_PATH`（`writeScopeAudit.ts`）**一直**把
`/^\.github\//` 与 `/^(scripts|bin)\//` 当作 devops 的范围，注释里还写着
「`infrastructure/` … 也是 devops-agent 的写范围之一」——**它以为两侧是一致的**，
而强制侧 `writePaths` 只有 `["infrastructure","compose.yaml","Dockerfile"]`。

### 1.2 附带发现（登记为 N-19，未修）

`slice-1-task-8-REPLAN-1`（run 2，BUILD → devops-agent）**写 `scripts/verify-contract.mjs` 被拒，
任务仍判 SUCCESS / verified**：

| 记录 | 值 | 判读 |
| --- | --- | --- |
| `tool_calls.input` | `{"path": "scripts/verify-contract.mjs"}` | 只有 `path`、无 `summary` |
| `tool_calls.output` | `null` | — |

对照 `ToolRuntimeBackend.recordDeniedCall`（`:326-390`）：`recordToolCallStarted({input:{path}})` ＋
`recordToolCallFinished({status:"failed", error:{TOOL_ERROR}})`——**这正是被拒留痕的形状**
（成功写入是 `input.summary` ＋ `output.{path,bytes}`；同批 `-DEBUG-1-DEBUG-2` 写
`infrastructure/scripts/verify-contract.mjs` 即记 `output={"path":…,"bytes":4664}`）。
该任务的检查是 `build:0`（`package.json` 的 `build` 指向别处的自检脚本），故判 `verified`。

⇒ **平台拒绝了这次写入，随后宣告该任务成功；声明的交付物从未创建。** 详见 §6 Known Issues 4。

---

## 2. 修法（用户 2026-10-20 裁定）

两个候选，用户选定 **「对齐两侧 + 派生」**：

| 候选 | 内容 | 裁定 |
| --- | --- | --- |
| **(A) 对齐两侧 + 派生** | ① devops-agent 的读写范围补齐 `scripts` / `bin` / `.github`；② 删掉审计侧手抄的 `DEVOPS_PATH`，改为从 `writePathsForTaskType("BUILD")` 派生 | **✅ 采纳** |
| (B) 只补 `scripts`，最小改动 | 审计侧不动 ⇒ `.github/` 与 `bin/` 的漂移仍在，换个路径就复发 | ❌ |
| (C) 不动权限，改规划侧 | `TaskPlanItemSchema` 是 `.strict()` 且**没有结构化交付物字段**（路径只存在于自由文本 `description`），守卫无法可靠实现 | ❌ |
| (D) 只登记不改 | — | ❌ |

**为什么取 (A)**：这一族缺陷已复现五次，每次都在「允许」侧打补丁（PL-M10 / PL-M11）。
**本次把审计侧的手抄表删掉**，使「审计判在范围内」与「写层确实放行」由**同一个函数**决定
（PL-M12 的做法），从根上消灭这一格；devops 的属地则一次性补全。

---

## 3. Modified Files

| 文件 | 动作 |
| --- | --- |
| `packages/agent-core/src/professional/AgentRegistry.ts` | 改：devops-agent 的 `readPaths` / `writePaths` 补 `scripts` / `bin` / `.github` / `Makefile`（读写两侧同步，原先连读都读不到） |
| `apps/server/src/services/writeScopeAudit.ts` | 改：**删除**手抄的 `DEVOPS_PATH`；新增 `DEVOPS_SCOPE = agentScope("BUILD")`；`BUILD` / `DEPLOY` 两组改用它并显式并入 `ROOT_DELIVERY` |
| `packages/shared/src/index.ts` | 改：一处注释更正（`DEVOPS_PATH` 已删除，属本次改动造成的文档腐烂） |
| `packages/agent-core/src/professional/ToolRuntimeBackend.test.ts` | 改：**2 处精确断言同步**（`describeWriteScope` 的拒绝串）+ **新增 2 例**（N-18 正例 / 反向对照） |
| `packages/agent-core/src/professional/AgentRegistry.test.ts` | 改：**新增 1 例**（devops 构建属地必须在自己的 `writePaths` 里 + 反向对照） |
| `apps/server/src/__tests__/writeScopeAudit.test.ts` | 改：**新增 1 例**（审计与强制同源）+ 2 个 import |
| `docs/190-phase-n18.md` | **新增**（本文件） |
| `docs/146` / `docs/127` / `docs/189` | 改：台账（N-18 已修 / 新登记 N-19 / 批次与状态） |

---

## 4. Implementation

### 4.1 强制侧（`AgentRegistry.ts`）

devops-agent 的范围由

```ts
readPaths:  ["infrastructure", "compose.yaml", "Dockerfile", "package.json"]
writePaths: ["infrastructure", "compose.yaml", "Dockerfile"]
```

改为

```ts
readPaths:  ["infrastructure", "scripts", "bin", ".github", "compose.yaml", "Dockerfile", "Makefile", "package.json"]
writePaths: ["infrastructure", "scripts", "bin", ".github", "compose.yaml", "Dockerfile", "Makefile"]
```

`Makefile` 一并补入：审计表原本就有它，且它是构建产物。
`compose.yaml` / `Dockerfile` 两条**保留不动**——它们与 `writeRootDeliveryArtifacts`
有重叠，但删除会改变既有的拒绝消息形状，超出本次范围。

### 4.2 审计侧（`writeScopeAudit.ts`）

```ts
const DEVOPS_SCOPE: ScopeRule[] = agentScope("BUILD");

BUILD:  [DEVOPS_SCOPE, CONFIG_PATH, ROOT_DELIVERY],
DEPLOY: [DEVOPS_SCOPE, CONFIG_PATH, ROOT_DELIVERY],
```

`DEPLOY` **没有承接 agent**（`writePathsForTaskType("DEPLOY")` 返回 `undefined`，`TASK_AGENT_TYPES`
无该条目），但交付链与构建链动的是同一套文件，故两者共用 `DEVOPS_SCOPE`。

**两处刻意收窄**（原手抄表比强制侧**更宽**，本身就是漂移，会漏报越界）：

| 原表条目 | 处置 | 理由 |
| --- | --- | --- |
| `/^[^/]*\.ya?ml$/i`（根级 `*.yaml`） | **退出审计范围** | 强制侧从来不放行（`pnpm-lock.yaml` 由 `CONFIG_PATH` 覆盖；`pnpm-workspace.yaml` 无人可写）。审计说合法而写层拒绝 = 漏报 |
| `/^Makefile$/i` | **改由 `writePaths` 承载** | 语义不变；且 `Makefile` 本就是 `isProjectManifestPath` 的一部分，实现类一直可写 |

---

## 5. Tests / Lint / Typecheck / E2E

**判据**

| 编号 | 判据 | 结果 |
| --- | --- | --- |
| 22a | devops 可写 `scripts/` / `bin/` / `.github/` / `Makefile` | ✅ `ToolRuntimeBackend.test.ts` 新增例：6 条路径**全部触达沙箱**（`counter.n === 6`） |
| 22b | 反向对照：实现类与测试类**不得**写这些路径 | ✅ 4 个 agent × 2 条路径全部 `Path is not writable`（沙箱零触达） |
| 22c | 审计与强制**同源** | ✅ `writeScopeAudit.test.ts` 新增例：对 6 条路径同时断言 `isPathUnderPrefixes(p, writePathsForTaskType("BUILD"))` 与 `isPathInWriteScope("BUILD"/"DEPLOY", p)` 为真 |
| 22d | `DEVOPS_PATH` 已无残留 | ✅ 全树 grep：仅剩注释中的历史引用，**无活代码** |
| 22e | 全仓门槛 | ✅ `-r typecheck` **exit 0**、`-r lint` **exit 0**；`-r test` 16 包全绿，`apps/server` 2 例重 e2e 抖动（见下） |
| 22f | 未跑真实批次 | ✅ 未跑 |

**包门禁**

| 包 | typecheck | lint | test |
| --- | --- | --- | --- |
| `@ai-se/agent-core` | ✅ | ✅ | **249 / 249**（改动前 246，**+3**） |
| `@ai-se/server` | ✅ | ✅ | **302 / 302**（改动前 301，**+1**） |

**既有精确断言同步（`AGENTS.md` §7）**：`ToolRuntimeBackend.test.ts` 有 **2 处**硬编码的
`describeWriteScope` 拒绝串（`:237` 写侧 / `:290` 读侧），随 `writePaths` 一并更新，
**未弱化任何一条**（新串把 6 条条目逐字列出）。全树 grep 确认无第三处依赖该串。

**全仓 `-r test` 的抖动（如实记录）**：`apps/server` 2 例失败——
`v1GoldenScenario.e2e`（server restart）与 `failureRecovery.e2e`（external CANCELLED
not auto-recovered）。**隔离复跑 14/14 通过**，且两者与写范围无因果关系（前者验工作流重启用，
后者验取消恢复）。判为 `docs/145` #7 同类**负载敏感抖动**——与 PL-M10 / PL-M11 / PL-M13 /
PL-M14 / PL-M16 / PL-M17 撞到的是同一族，**未据此改动任何测试**。

---

## 6. Known Issues

1. **`.github` 在拒绝消息里渲染成文件形状。** `renderScopeEntry` 按「最后一段是否含 `.`」
   判目录，`.github` 含点 ⇒ 渲染为 `.github`（而非 `.github/`）。**未修**：改判定会误伤
   `.env` 这类点号开头的**文件**；且这纯属消息措辞，不影响判定。
2. **根级非 compose 的 `*.yaml` 从审计范围退出**（见 §4.2）——这是**修正**，不是收窄权限：
   强制侧从来不放行，退出后审计与写层一致。
3. **`packages/shared/src/rootDeliveryArtifactPath.test.ts:91` 的 `const devops = […]` 未改。**
   它是**示意用的局部副本**（与同文件的 `const backend` 同类），断言的是 `isPathUnderPrefixes`
   的语义，**不依赖真实 agent 表**。全树 grep 确认无第二处依赖 devops 的真实 `writePaths`。
4. **🔴 N-19（新登记，未修）：写权限拒绝不进入任务判定。** 见 §1.2——平台拒绝了写入，随后把
   任务判成 SUCCESS。与 N-15′（DEBUG 无类型级检查 ⇒ `unavailable`）同族（「任务被判成功/不可判定，
   而它声明的工作实际没做成」），但**不是同一处代码**：N-15′ 是「没有检查」，N-19 是
   「有检查，但检查看的是项目整体、不看任务声明的交付物」。**修法未定，需先裁定**
   （候选：把「本次任务内是否存在被拒写入」纳入判定；或要求 agent 收到拒绝时必须报告失败）。
5. **未在真实批次验证。** 本批按裁定不跑 E1×3（判据 22f）。⇒ **N-18 不判「已关闭」**，
   关闭条件＝真实批次里 `scripts/` 一类的交付物**不再被拒**。

---

## 7. Architecture Changes

**无。** 未新增包、未改契约、未新增第二套 Permission 体系（`AGENTS.md` §10）——
本次改的是**既有**权限表的取值，以及审计侧与强制侧的**同源化**。

**口径变更登记（`docs/146` §6 规则 8 的邻类：权限范围变更）**

| 变更 | 修前 | 修后 |
| --- | --- | --- |
| devops-agent 可写 | `infrastructure` / `compose.yaml` / `Dockerfile` ＋ 根清单 ＋ 根交付物 | **再加** `scripts` / `bin` / `.github` / `Makefile` |
| devops-agent 可读 | `infrastructure` / `compose.yaml` / `Dockerfile` / `package.json` | **再加** `scripts` / `bin` / `.github` / `Makefile` |
| 审计侧 devops 范围 | 手抄正则表 `DEVOPS_PATH` | 从 `writePathsForTaskType("BUILD")` **派生** |

⇒ **`BUILD` / `DEPLOY` 任务的越界判定口径本批起变化**：`scripts/` / `bin/` / `.github/` 由
「越界」变为「在范围内」，根级非 compose `*.yaml` 由「在范围内」变为「越界」。
**与既往批次的 `scopeViolations` 数字不再严格可比。**

---

## 8. Dependencies

**无新增、无升级、无删除。**

---

## 9. Acceptance Result

**PASS（判据 22a–22e 达成；22f 不适用——本批不跑批次）。**

**未在真实批次验证 ⇒ N-18 不判「已关闭」。**

---

## 10. Next Phase Boundary

**未开始事项（STOP）**：

- **N-19 只登记、未修**（§6 Known Issue 4）——需先裁定修法。
- **N-15′**（DEBUG 无类型级检查）**未修**。
- **PL-M20 的挂死问题仍未解决**（L1-M4m run 3 七次 `CHECK_TIMEOUT`），**PL-M20 状态为
  「实施完成、待重新验证」**——须先补上「真实 E1 工作区 + `--test-timeout`」那个缺失的产物。
- **agent 600s 墙上超时**、**replan 不收敛**、**`errorTypes` 双粒度相加** **均未修**。
- **未跑任何批次**；下一批开工前仍须先停掉并重启 `:47558` 实例（本次改了 `apps/server`
  与 `packages/agent-core` 的 `dist`）。
