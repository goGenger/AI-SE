# 169 · N-2「仓库根写权限」实施记录（PL-M10）

> 状态：**已实施并收尾**（2026-10-17）。用户裁定「**都按你的建议，开工 PL-M10**」——即 `docs/168` §7 八项待裁定全部按推荐值接受；实施中据实测提出 §2 的 5 处偏差，**判据强度以本文件为准**。
> 依据：任务书 `docs/168`（§2 基线事实 / §3 判据 / §4 裁定 / §7 待裁定）、L1-M4b run 1 实测（工作流 `cbbb7859-…`）、PL-M4 run 1 实测（工作流 `09eca545-…`）、`docs/159`（PL-M5 先例）、`docs/146` §6 规则 7/8、`AGENTS.md` §7/§9/§10。
> 性质：**本文件是实施结果正本**。任务书 `docs/168` 的方案部分仍有效，**被本文件 §2 更正的 5 处以其为准**（`docs/146` §6 规则 7：不追改历史记录，更正以追加块形式落在这里）。

## Modified Files

| 文件 | 改动 |
| --- | --- |
| `packages/shared/src/index.ts` | 新增 `ROOT_MANIFEST_PATTERNS` 与 `isProjectManifestPath`（PL-M10 的**唯一**判据，与 `isTestFilePath` 同居 shared） |
| `packages/shared/src/projectManifestPath.test.ts` | **新增**。33 例（清单/配置正例、子目录同名反例、非清单类反例、Windows 分隔符） |
| `packages/agent-core/src/professional/AgentRegistry.ts` | `AgentPermissions` 新增 `writeProjectManifests?: boolean`；backend / frontend / database / devops 四个 agent 置真 |
| `packages/agent-core/src/professional/AgentRegistry.test.ts` | +1 例（只有产出工程骨架的 agent 声明该标志） |
| `packages/agent-core/src/professional/ToolRuntimeBackend.ts` | `writeAllowed` 新增清单分支；新增 `renderScopeEntry` / `renderScopeList`，`describeWriteScope` / `describeReadScope` 改为逐条渲染并补清单条款 |
| `packages/agent-core/src/professional/ToolRuntimeBackend.test.ts` | +4 例（清单放行 / 非清单根文件仍拒 / 只读与测试 agent 不放宽 / 渲染不再是目录）；更新 2 处被钉住的断言；文件头补 PL-M10 |
| `apps/server/src/services/writeScopeAudit.ts` | 删除**第二份定义** `CONFIG_PATH` 正则表，改为共享谓词；新增 `ScopeRule` 联合类型与谓词感知的 `matchesAny` |
| `apps/server/src/__tests__/writeScopeAudit.test.ts` | +1 例（两侧同一谓词；根级 vs 子目录同名；非清单类维持越界） |

## Implementation

### 10a 强制侧：让工程骨架写入放行（`@ai-se/shared` + `@ai-se/agent-core`）

写权限的判定在 `ToolRuntimeBackend.ts`：

```
writeAllowed(relative) = 白名单前缀命中
                       ∨ (writeTestFiles 且 isTestFilePath)          ← PL-M5
                       ∨ (writeProjectManifests 且 isProjectManifestPath)  ← PL-M10
```

新增分支与前一条**同形**——`writePaths` 前缀白名单本身一字未动。这是必要的：`writePaths` 是相对仓库根的**前缀**列表，而仓库根是所有前缀的**父目录**，任何前缀都表达不了「根**本身**」（`allowed()` 里 `"."` 才表示「全部」）。`readPaths` 早就用「裸文件名条目」解决了同一问题（backend 等的 `readPaths` 里都有 `package.json`），写侧此前一条都没有。

### 10b 审计侧：两份定义收敛为一份（`apps/server`）

`writeScopeAudit.ts` 原有一份**独立的** `CONFIG_PATH` 正则表。它早就把根级 `package.json` / `pnpm-lock.yaml` / `tsconfig*.json` / `.gitignore` 判为实现类任务的**合法**写入，而强制侧把它们全部拒绝——同一仓库、同一时刻，一边说合法、一边说不合法。

现将该表整体替换为共享谓词 `isProjectManifestPath`（`CONFIG_PATH: ScopeRule[] = [isProjectManifestPath]`），并引入 `ScopeRule = RegExp | ((path: string) => boolean)` 让其余正则组保持不动。行为**逐字不变**（既有断言全过），变的只是「判据从哪来」。

### 10g 显示：范围列表不再把单文件画成目录

`describeWriteScope` / `describeReadScope` 原为 `prefixes.join("/, ") + "/"`——把**单文件条目**也渲染成目录，实测读侧拒绝消息里出现过 `package.json/`。新增 `renderScopeEntry`：末段含 `.` 或属已知无扩展名文件名（`Dockerfile` / `Makefile` / `LICENSE` / `README` / `CHANGELOG` / `Procfile`）者不加尾斜杠。纯目录列表的输出**逐字不变**（`apps/server/, server/, backend/, src/` 保持原样）。

同时给写侧描述补了清单条款，使被拒的 agent 知道它**可以**写根清单——这是 PL-M5 立的项目标「拒绝必须可被发现」的延续。

## Architecture Changes

- **无新增包 / 无新增顶层目录 / 无新增依赖。**
- 唯一跨包契约变更：`AgentPermissions` 新增**可选**字段 `writeProjectManifests`（缺省即既有行为）。
- `isProjectManifestPath` 上移 `@ai-se/shared`，与 `isTestFilePath`（PL-M5）同居——**同一缺陷形状、同一修法**：前缀白名单表达不了语义类别，故把判据抽成两侧共用的一份。
- `apps/server` 的 `canonicalAcKey` 副本仍未动（既有登记）。

## Dependencies

无新增依赖。

## Tests

| 层 | 内容 |
| --- | --- |
| 单测（谓词，`shared`） | 23 个正例（`package.json` / `pnpm-lock.yaml` / `tsconfig.base.json` / `vitest.config.ts` / `.env.local` / `.gitignore` / `Makefile` / `./package.json` 等）+ 11 个反例（`src/package.json` 等子目录同名、`README.md`、`index.js`、`.dockerignore`、`package.json.bak`、空串）+ Windows 分隔符 |
| 单测（强制侧，`agent-core`） | **核心判据 10f**：backend 写 `package.json` / `pnpm-lock.yaml` / `tsconfig.json` / `.gitignore` / `vitest.config.ts` → 放行（沙箱计数 5）；**10c 反向对照**：backend 写 `README.md` / `index.js` → 仍拒；**10e**：reviewer / qa 写 `package.json` → 仍拒、沙箱零调用；**10g**：devops 拒绝消息为 `infrastructure/, compose.yaml, Dockerfile, and project manifests/configs …`（无 `Dockerfile/`、无 `package.json/`） |
| 单测（审计侧，`server`） | 根级清单两侧同判；`src/package.json` 在**谓词**下为假、但在**审计总体作用域**下为真（`SOURCE_PATH` 的 `src/` 前缀规则，两条规则不同源）；`README.md` 两侧一致越界 |
| 回归（PL-M5 不回归） | 既有 `writeTestFiles` 断言与 qa 拒绝消息**逐字未改**，全过 |

## Lint

`--filter @ai-se/shared|agent-core|server lint` → 0；全仓 `corepack pnpm -r run lint` → **exit 0**。

## Typecheck

`--filter @ai-se/shared|agent-core|server` → 0；全仓 `corepack pnpm -r run typecheck` → **exit 0**。

## E2E

全仓 `corepack pnpm -r run typecheck && lint && test` → **exit 0**（第二轮），16 个 workspace 包全部通过：

| 包 | 用例数 | 包 | 用例数 |
| --- | --- | --- | --- |
| **shared** | **123（10 文件）**（原 89/9，+34） | **agent-core** | **234（35 文件）**（原 229，+5） |
| **apps/server** | **282（50 文件）**（原 281，+1） | apps/web | 505 |
| mcp | 235 | database | 47 |
| workflow-engine | 45 | eval | 42 |
| browser | 38 | visual | 83 |
| tool-runtime | 32 | failure-recovery | 16 |
| action-policy | 13 | evidence | 9 |
| sandbox | 8 | observability | 3 |

**A/B 实测（`docs/165` §2 偏差 1 的教训，强制）**：第一轮全仓 test 出现 1 例失败——`apps/server/src/__tests__/failureRecovery.e2e.test.ts` 的「5.7-5 external CANCELLED action is not auto-recovered」（`expected 'SUCCESS' to be 'FAILED'`）。这是**真实 Chromium + 真实 MCP + 真实 PostgreSQL** 的重型 e2e。按 A/B 流程取证两步：**该文件单独复跑 10/10 通过**、**第二轮全仓 test exit 0（server 282/282）** → 判定为 `docs/145` #7 / `docs/146` §5 已登记的**负载敏感抖动**（全量并行时该重型 e2e 超时/串扰），**非本次改动所致**。本次唯一一次非确定性失败，已按上述两步取证。

## §2 对 `docs/168` 的更正（5 处，均据实测）

### 偏差 1：`src/package.json` 的判定——我自己的测试断言写错了

`docs/168` §5 未涉及此例。我在 `writeScopeAudit.test.ts` 里先写了 `expect(isPathInWriteScope("BACKEND","src/package.json")).toBe(false)`，实测为 **true**：审计的**总体**作用域另有 `SOURCE_PATH` 的 `src/` 前缀规则，而「根清单谓词」只判仓库根级——**两条规则不同源**。已改正为「谓词下为假、审计作用域下为真」并如实钉住这一区分（这正是本仓库「重复定义必然漂移」的又一个切面，登记于 Known Issues）。

### 偏差 2：10b 达成的是「同一谓词驱动」，不是「单一实现」

任务书 §3 判据 10b 写「两份定义**收敛为一份**（或至少由同一谓词驱动）」。实施取的是后半句：只把 `CONFIG_PATH` 换成共享谓词，`SOURCE_PATH` / `DEVOPS_PATH` / `DOC_PATH` / `TEST_PATH` 四组正则**保持不动**（它们不与强制侧的前缀白名单一一对应，强行合并会改变审计行为）。故**残余分歧仍在**，且已由测试钉住（见 Known Issues 1）。

### 偏差 3：`describeWriteScope` 的文本变化超出 10g 的最小要求

判据 10g 只要求「不再把单文件条目渲染成目录」。实施中除修渲染外，还给**写侧**描述补了一句清单条款（让被拒的 agent 知道它可写根清单）。后果：`ToolRuntimeBackend.test.ts` 里 backend 的 `README.md` 拒绝消息断言从 `allowed: apps/server/, server/, backend/, src/` 变为带清单条款的长串——已按 `AGENTS.md` §7「共享断言同一提交内同步更新」处理。**这一条是主动扩大，不是判据要求**，如需回退请裁定。

### 偏差 4：`renderScopeEntry` 引入了文件名启发式（任务书未提）

任务书只说「不再把单文件条目渲染成目录」，没说怎么判「单文件」。实施取「末段含 `.`，或属已知无扩展名文件名集合」。这是**显示层的启发式**，不是权限判据（权限仍走 `allowed()` 的精确匹配）。它对当前所有条目都正确，但若将来出现「含点号的目录名」会误判——已登记（Known Issues 3）。

### 偏差 5：`docs/168` §5 说的「跨包一致性用例」无法成立

任务书 §5 写「单测（审计侧）：根级清单判定与强制侧**一致**（同一谓词驱动）」。跨包测试在本仓库不成立（`agent-core` 不依赖 `apps/server`，`AGENTS.md` §3 亦禁止反向依赖）。实施改为：**共享谓词单测**（`shared`）+ **两侧各自的行为钉住**（`agent-core` 的放行/拒绝、`server` 的 `isPathInWriteScope`）。一致性由「同一份实现」保证，而非由一条跨包用例保证。

## Known Issues

1. **残余分歧：根级源码文件。** 审计侧 `SOURCE_PATH` 的第二条正则 `/^[^/]+\.(js|mjs|cjs|ts|…)$/i` 允许实现类任务写**仓库根级的源码文件**（如 `index.js`），而强制侧仍拒——本批口径只覆盖工程清单/配置（`docs/168` §4 裁定 3）。已由测试如实钉住。**这是下一批的风险点**：若计划把服务入口点放在仓库根（而非 `src/`），同样的致败会复发。
2. **`test/` 目录不在任何实现类 agent 的写范围内。** L1-M4b run 1 的 S1-T1 agent 报告里把「`test/` 可读不可写」列为 HIGH。**实查其 AC 只有三条**（根 `package.json` / `pnpm-lock.yaml` / `test` script 调 `node --test`），**均不要求 `test/`**——测试文件归 qa-agent 的 S1-T5/S1-T6。故非阻塞，但登记：工程骨架任务若要建 `test/` 目录骨架（PL-M4 run 1 的 T-05 AC 里就有「创建 `src/`、`test/`、`data/` 目录骨架」），仍会受阻。
3. **`renderScopeEntry` 的文件名启发式**（偏差 4）：含点号的目录名会被误渲染为文件。
4. **PL-M4 run 1 的 T-05「为何最终 `verified`」仍未证实**（`docs/168` §2.2）：成功的 `write_file` 事件载荷不含路径，无法从事件流定位那次成功的写入。本批未据它下任何结论。
5. **`canonicalAcKey` 在 `apps/server` 仍有一份副本**（既有登记，本次未动）。
6. **全仓门禁的既知抖动**：`failureRecovery.e2e` 在全量并行下曾失败一次，隔离 10/10 通过、第二轮全仓 exit 0（见 E2E 节）。与 `docs/145` #7 同类。
7. **N-1b（DATABASE 类型错配）/ N-1c（红灯语义缺口）/ 7b 未收紧** 维持登记，本批未动。
8. **启动器会静默复用陈旧实例（本次的近失事故）。** `packages/eval/scripts/l1-m4-server-launch.sh` 的健康检查是 `if health == 200 then echo SERVER_ALREADY_UP; exit 0`——**只要端口上有人应答就不重启**，而受控实例是 `tsx`（**非 watch**）启动的，不会随 `packages/*/dist` 重建自更新。L1-M4b 开工前实查发现 `:47558` 跑的正是 PL-M7/M8/M9 **之前**的代码（pid 92979 启动于 10-16 15:10:50，早于 23:29 的 dist 重建）——**若不手工先 kill 再启动，整批会在旧代码上跑而毫无提示**。本批是手工停掉旧实例后重启的（pid 5934）。**现状**：该实例又已是「PL-M10 之前」的代码（PL-M10 的 dist 重建于 10-17 00:47 之后），**下一批开工前必须再次重启**。本批**未修启动器**（属相邻工作，`AGENTS.md` §9）。

## Acceptance Result

**PASS**。`docs/168` §3 的判据全部达成：

- **10a**：实现类 agent（backend / frontend / database / devops）可写仓库根的工程清单/配置文件；`writePaths` 前缀白名单一字未动。
- **10b**：`CONFIG_PATH` 的判据上移 `@ai-se/shared`，两侧共用同一份实现（达成的是「同一谓词驱动」，见偏差 2）。
- **10c**：非清单类根文件判定逐字不变（`README.md` / `index.js` 仍拒，有反向对照用例）。
- **10d**：`writeTestFiles`（PL-M5）语义与既有断言逐字不变。
- **10e**：只读 agent（planner / reviewer）与 qa-agent 仍不能写 `package.json`（沙箱零调用）。
- **10f**：E1 回放——S1-T1 形状（BACKEND 写 `package.json`）修前拒绝、修后放行（核心判据）。
- **10g**：`describeWriteScope` / `describeReadScope` 不再把单文件条目渲染成目录。

三包（`shared` / `agent-core` / `server`）与全仓 `typecheck` / `lint` / `test` 全绿（全仓 exit 0，第二轮）。**§2 的 5 处偏差已如实记录**，其中偏差 1 是我自己写错的断言（已改正），偏差 3 是主动扩大（可回退）。

## Next Phase Boundary

**未开始事项（STOP）**：

- **本批未跑任何批次**。下一步维持 `docs/168` §7 第 7 项的裁定：**另开一批 E1×3**（L1-M4b 记「已执行 1/3，因用户裁定先修 N-2 中止」），受周配额纪律约束（默认一周最多一个 E1×3 批次，`docs/127` §8）→ 落在下周窗口。**开工前三件事**：① **确认周配额余量**；② **先停掉 `:47558` 上的陈旧实例再重启**（`l1-m4-server-launch.sh` 只要端口有应答就报 `SERVER_ALREADY_UP` 并**静默复用**，见 Known Issues 8）——现实例是 PL-M10 之前的代码；③ 用 harness 追踪的后台任务启动 + **立即** arm 看门狗（`packages/eval/scripts/eval-batch-watchdog.sh`，注意默认 `--heartbeat-min 10` < `--stall-min 15` 使停滞判定成为死代码，宜用 30/25）。
- **下一批的头号观察项（新增）**：Known Issues 1 的**根级源码文件**残余分歧——若计划把服务入口点放在仓库根，同样的致败会复发。其次仍是 PL-M9 的 `PLAN_TEST_BEFORE_SCRIPT_PROVIDER` / `TASK_CHECK_UNAVAILABLE` 频率（L1-M4b run 1 因首个任务即失败而**从未触及**）。
- 不处理 N-1b / N-1c / N-3，不合并 `canonicalAcKey` 副本，不上移 `CHECK_CANDIDATES`，不收紧 7b（均维持登记）。
- 不放行根级 `README.md` 给实现类（`docs/168` §4 裁定 7，对应 N-3）。
- 不修改 `packages/eval` 的夹具与 oracle；不改 `EvalPolicy`。
