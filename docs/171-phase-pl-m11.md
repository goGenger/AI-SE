# 171 · 「仓库根交付物写权限」实施记录（PL-M11 / PL-M12）

> 状态：**已实施并收尾**（2026-10-17）。用户裁定「**都按你的建议，开工 PL-M11**」——即 `docs/170` §7 八项待裁定全部按推荐值接受（含裁定 6「PL-M12 同批」），故本批**两个里程碑同批实施**。实施中据实测提出 §2 的 6 处偏差，**判据强度以本文件为准**。
> 依据：任务书 `docs/170`（§2 基线事实 / §3 判据 / §4 裁定 / §7 待裁定）、L1-M4c run 2 实测（工作流 `370073af-71fe-4854-9da4-cb67d4f016c4`）、代码与夹具实查（`oracle.mjs` / `mutants/` / `writeScopeAudit.ts` / `AgentRegistry.ts`）、`docs/169`（PL-M10 先例）、`docs/146` §6 规则 7/8、`AGENTS.md` §7/§9/§10。
> 性质：**本文件是实施结果正本**。任务书 `docs/170` 的方案部分仍有效，**被本文件 §2 更正的 6 处以其为准**（`docs/146` §6 规则 7：不追改历史记录，更正以追加块形式落在这里）。

## Modified Files

| 文件 | 改动 |
| --- | --- |
| `packages/shared/src/index.ts` | 新增 `ROOT_DELIVERY_ARTIFACT_PATTERNS` 与 `isRootDeliveryArtifactPath`（PL-M11 的**唯一**判据）；新增 `isPathUnderPrefixes`（PL-M12 的**唯一**前缀判据） |
| `packages/shared/src/rootDeliveryArtifactPath.test.ts` | **新增**。交付物 30 例（18 正 / 12 反）+ Windows 分隔符 + `isPathUnderPrefixes` 14 例（含单文件条目、`"."`/`[]`、分隔符归一） |
| `packages/agent-core/src/professional/AgentRegistry.ts` | `AgentPermissions` 新增 `writeRootDeliveryArtifacts?: boolean`；backend / frontend / database / devops 四个 agent 置真；新增并导出 `writePathsForTaskType` |
| `packages/agent-core/src/index.ts` | 导出 `writePathsForTaskType` |
| `packages/agent-core/src/professional/AgentRegistry.test.ts` | +2 例（交付物标志只授实现/构建类；`writePathsForTaskType` 与 registry 同源） |
| `packages/agent-core/src/professional/ToolRuntimeBackend.ts` | `writeAllowed` 新增第三条语义分支；`allowed()` 改为委托 `isPathUnderPrefixes`（语义逐字不变）；`describeWriteScope` 补交付物条款 |
| `packages/agent-core/src/professional/ToolRuntimeBackend.test.ts` | +3 例（交付物放行 / 子目录同名与变体仍拒 / 只读与测试 agent 不放宽）；更新 3 处被钉住的断言（backend 的越界示例由 `README.md` 改为 `docs/guide.md`；PL-M10 的「非清单根文件」例由 `README.md`+`index.js` 收敛为 `index.js`；devops 写侧拒绝消息补交付物条款） |
| `apps/server/src/services/writeScopeAudit.ts` | 删除手抄的 `SOURCE_PATH` 正则表与 `DEVOPS_PATH` 的四条交付物正则；新增 `ROOT_DELIVERY`、`agentScope()`、`IMPLEMENTATION_TASK_TYPES`、`BUILD` 条目、目录摘要行规则 |
| `apps/server/src/__tests__/writeScopeAudit.test.ts` | +3 例（PL-M11 交付物、PL-M12 BUILD 条目、PL-M12 派生与目录摘要行）；更新 2 处被钉住的断言（BACKEND 写 `Dockerfile` 由「越界」改判「合法」；PL-M10 用例中 `README.md` 的两侧判定） |

## Implementation

### 11a / 11b / 11f 强制侧：仓库根交付物放行

写权限判定在 `ToolRuntimeBackend.ts`，现在有三条语义分支（PL-M5 → PL-M10 → PL-M11），**同形**：

```
writeAllowed(relative) = 白名单前缀命中
                       ∨ (writeTestFiles          ∧ isTestFilePath)
                       ∨ (writeProjectManifests   ∧ isProjectManifestPath)          ← PL-M10
                       ∨ (writeRootDeliveryArtifacts ∧ isRootDeliveryArtifactPath)  ← PL-M11
```

`writePaths` 前缀白名单**一字未动**。交付物集合（根级）：

| 正则 | 覆盖 |
| --- | --- |
| `/^Dockerfile(\.[^/]+)?$/i` | `Dockerfile`、`Dockerfile.dev`、`Dockerfile.prod` |
| `/^\.dockerignore$/i` | `.dockerignore` |
| `/^(docker-)?compose(\.[^/]*)?\.ya?ml$/i` | `compose.yaml`、`docker-compose.yml`、`docker-compose.prod.yml` |
| `/^README(\.[^/]+)?$/i` | `README`、`README.md`、`README.rst` |

**为什么必须另开一条而不是并入 `writeProjectManifests`**：两者口径来源不同（审计侧的 `CONFIG_PATH` vs `DEVOPS_PATH`），语义也不同（工程怎么组织 vs 交付出去的东西）。合并会让「清单」这个名字说谎，也失去分别授予的能力。

### 11d / 11e 不回归

`writeTestFiles`（PL-M5）与 `writeProjectManifests`（PL-M10）的语义与既有断言逐字未改；只读 agent（planner / reviewer）与 qa-agent 对交付物仍全拒（有反向对照用例，沙箱零调用）。

### 12c 审计侧：路径来源单一化

`writeScopeAudit.ts` 里两张手抄的表被删除：

- **`SOURCE_PATH`**（实现类的源码前缀）→ 改为 `agentScope(taskType)`，前缀取自 `@ai-se/agent-core` 新导出的 `writePathsForTaskType(taskType)`。
- **`DEVOPS_PATH` 的四条交付物正则** → 改为共用的 `isRootDeliveryArtifactPath`。

`TASK_AGENT_TYPES` 原先在 `AgentRegistry.ts` 里是模块私有的，本批通过 `writePathsForTaskType` 暴露了**唯一需要的那一格**（TaskType → 写路径），而不是把整张映射表公开。

### 12d 审计的信号价值未变

审计的输入仍是 `git status --porcelain` 的前后差集（`taskVerifier.ts:816`），捕得到绕过 `write_file` 工具门的写入（构建脚本、shell、依赖安装）。本批**没有**把审计投影成强制侧——`SCOPE_VIOLATION` 仍可能在强制侧放行的路径上报出（例如同一任务里被 shell 写出的、两个谓词都不覆盖的根级文件）。

### 12a / 12b 实测假阳性的消除

`apps/server` 侧新增的判定：

```
BACKEND  / FRONTEND / DATABASE → agentScope(<自身>) + CONFIG_PATH + ROOT_DELIVERY
DEBUG                          → agentScope(实现类并集) + CONFIG_PATH + ROOT_DELIVERY
BUILD                          → agentScope("BUILD") + DEVOPS_PATH + CONFIG_PATH   ← 新增条目
DEPLOY                         → DEVOPS_PATH + CONFIG_PATH                          （不变）
TEST / ANALYSIS / DESIGN       → 不变
```

**E1 回放（判据 11f / 12a 的核心证据）**：把 run 2 的真实审计输入跑一遍新判定——

```
run2 S4-10 replay   -> {"checked":2,"violations":[]}     ← 修前为 {"violations":["apps/"]}
  write Dockerfile             -> BACKEND scope: true     ← 修前 TOOL_ERROR（三次尝试全拒）
  write Dockerfile.dev         -> BACKEND scope: true
  write dockerfile             -> BACKEND scope: true
  write docker/Dockerfile      -> BACKEND scope: false    ← 反向对照：子目录同名仍拒
  write workspace/Dockerfile   -> BACKEND scope: false
  README.md                    -> BACKEND scope: true     ← S4-13（BACKEND, AC-30）的交付物
  index.js                     -> BACKEND scope: false    ← 反向对照：根级源码仍拒
  docs/guide.md                -> BACKEND scope: false
  .github/workflows/ci.yml     -> BACKEND scope: false
```

## Architecture Changes

- **无新增包 / 无新增顶层目录 / 无新增依赖。**
- 唯一跨包契约变更：`AgentPermissions` 新增**可选**字段 `writeRootDeliveryArtifacts`（缺省即既有行为）。
- `@ai-se/shared` 新增两个导出：`isRootDeliveryArtifactPath`（与 `isTestFilePath` / `isProjectManifestPath` 同居）与 `isPathUnderPrefixes`（前缀判定的唯一实现）。
- `@ai-se/agent-core` 新增一个导出：`writePathsForTaskType`。`apps/server` 的审计侧从它取前缀，不再有第二份定义。
- `ToolRuntimeBackend.allowed()` 改为委托 `isPathUnderPrefixes`——**前缀语义现在也只有一份实现**（原先「前缀匹配」这件事在强制侧与审计侧各写了一遍）。

## Dependencies

无新增依赖。

## Tests

| 层 | 内容 |
| --- | --- |
| 单测（谓词，`shared`） | `isRootDeliveryArtifactPath`：18 个正例（`Dockerfile` / `Dockerfile.dev` / `.dockerignore` / `compose.yaml` / `compose.yml` / `docker-compose.prod.yml` / `README` / `README.rst` / `Dockerfile.bak` / `./Dockerfile`）+ 12 个反例（`docker/Dockerfile` / `infrastructure/Dockerfile` / `package.json` / `index.js` / `compose.yaml.bak` / `notes.txt` / `docs/guide.md` / 空串）+ Windows 分隔符。`isPathUnderPrefixes`：段边界（`src` 不覆盖 `srcx/`）、单文件条目（`compose.yaml` 是、`compose.yaml.bak` 不是）、`"."` 全通过、`[]` 全拒、分隔符与绝对路径归一 |
| 单测（强制侧，`agent-core`） | **11a 核心**：backend 写 `Dockerfile` / `Dockerfile.dev` / `.dockerignore` / `compose.yaml` / `docker-compose.prod.yml` / `README.md` → 放行（沙箱计数 6）；**11c 反向对照**：`docker/Dockerfile` / `docs/guide.md` / `compose.yaml.bak` / `notes.txt` → 仍拒；**11d**：reviewer / qa 写 `Dockerfile` → 仍拒、沙箱零调用；`writePaths` 数组与 PL-M10 / PL-M5 断言逐字未改 |
| 单测（审计侧，`server`） | **12a**：`apps/server/**`、`backend/**`、`server/**`、`src/**` 对 BACKEND 不再越界，`packages/database/**`、`database/**` 对 DATABASE 不再越界；跨类型仍越界（`apps/web/**` 对 BACKEND 为假、`apps/server/**` 对 FRONTEND 为假）；**12b**：`BUILD` 写 `Dockerfile` / `compose.yaml` / `infrastructure/main.tf` / `package.json` → 零越界；**目录摘要行**：`?? apps/` / `?? test/` / `?? docs/` 不算越界，同批的文件行照常判定 |
| 回归（PL-M10 / PL-M5 不回归） | PL-M10 的清单断言、PL-M5 的 qa 断言与拒绝消息全部逐字保留；仅两处**因本批裁定变化**而更新（见 §2 偏差 1） |
| 共享夹具核对（`AGENTS.md` §7） | 全树 grep 了 `isPathInWriteScope` / `auditWriteScope` / `writeScopeAudit` / `isProjectManifestPath` / `isTestFilePath` / `writeProjectManifests` 的全部消费方；钉住写范围消息的两条断言（`ToolRuntimeBackend.test.ts` 的 backend 与 devops 拒绝消息）同一提交内更新 |
| 门禁 | 三包（`shared` / `agent-core` / `server`）`typecheck && lint && test` 全绿；收尾前全仓 `corepack pnpm -r run typecheck && lint && test` |
| A/B 实测（强制） | 见 E2E 节 |

## Lint

`--filter @ai-se/shared|agent-core|server lint` → 0；全仓 `corepack pnpm -r run lint` → **exit 0**。

## Typecheck

`--filter @ai-se/shared|agent-core|server` → 0；全仓 `corepack pnpm -r run typecheck` → **exit 0**。

## E2E

全仓 `corepack pnpm -r run typecheck && lint && test` → **exit 0**（第二轮），16 个 workspace 包全部通过：

| 包 | 用例数 | 包 | 用例数 |
| --- | --- | --- | --- |
| **shared** | **168（11 文件）**（原 123/10，+45） | **agent-core** | **239（35 文件）**（原 234，+5） |
| **apps/server** | **285（50 文件）**（原 282，+3） | apps/web | 505 |
| mcp | 235 | database | 47 |
| workflow-engine | 45 | eval | 42 |
| browser | 38 | visual | 83 |
| tool-runtime | 32 | failure-recovery | 16 |
| action-policy | 13 | evidence | 9 |
| sandbox | 8 | observability | 3 |

**A/B 实测（`docs/165` §2 偏差 1 的教训，强制）**：第一轮全仓 test 出现 1 例失败——`apps/server/src/__tests__/failureRecovery.e2e.test.ts` 的「external CANCELLED action is not auto-recovered: one attempt, workflow fails, evidence kept」（`expected +0 to be 1`）。这是**真实 Chromium + 真实 MCP + 真实 PostgreSQL** 的重型 e2e，也是 PL-M10 撞到的**同一例**。按 A/B 流程取证两步：**该文件单独复跑 5 轮 × 10/10 通过**、**第二轮全仓 test exit 0（server 285/285）** → 判定为 `docs/145` #7 / `docs/146` §5 已登记的**负载敏感抖动**，**非本次改动所致**。

## §2 对 `docs/170` 的更正（6 处，均据实测）

### 偏差 1：两处被钉住的断言因**裁定变化**而更新（不是回归）

- `writeScopeAudit.test.ts` 原断言「BACKEND 写 `Dockerfile` 被检出」→ 本批改判为合法。这正是 PL-M11 的目的（`docs/170` §4 裁定 5 已声明要推翻 `docs/168` §4 裁定 7）。
- `ToolRuntimeBackend.test.ts` 原用 `README.md` 当 backend 的越界示例 → 改为 `docs/guide.md`。
- PL-M10 的「非清单根文件仍拒」用例原含 `README.md` + `index.js` → 收敛为 `index.js`。

三处均在同一提交内更新（`AGENTS.md` §7）。

### 偏差 2：**12c 的派生本身不足以达成 12a**——必须另加「目录摘要行」规则

这是本批最重要的更正。任务书 §7 裁定 7 推荐「实现类组的路径取自对应 agent 的 `writePaths`」，并以 12a（`apps/` 不再误报）为目标。**实测发现两者不是同一件事**：

run 2 报出的越界项是 `"apps/"`——**一个带尾斜杠的目录**，不是文件路径。它来自 `git status --porcelain` 的**折叠**：整片未跟踪目录被报成一行 `?? apps/`。而 backend-agent 的 `writePaths` 是 `["apps/server", …]`，**没有任何前缀能匹配 `apps/` 这个字符串**（`"apps/".startsWith("apps/server/")` 为假）。所以**只做派生，`apps/` 照旧误报**。

据此新增一条规则（`writeScopeAudit.ts`）：

```
git porcelain 把整片未跟踪目录折叠成一行（?? apps/）。该行是**摘要**，不是一次写入——
它只说明「这个目录是新的」，对「里面写了什么」零信息（里面的文件 git 根本没列出来，
审计本来也看不到）。把它算作越界是纯粹的假阳性。
```

**语义**：`path.endsWith("/")` 的条目不计入越界；同批里的文件行照常判定。**代价**：如果某个任务把不该写的东西整片写进一个全新目录，而该目录被 git 折叠成一行，审计看不见——但**它本来也看不见**（折叠意味着里面的文件根本没被列出来），故这不是本批引入的盲区。

### 偏差 3：`DEVOPS_PATH` 补了 `infrastructure/`，`DEPLOY` 的行为因此**变宽**

任务书 §3 判据 12e 写「`TEST` / `DEPLOY` / `ANALYSIS` / `DESIGN` 四组的既有行为逐字不变（`DEVOPS_PATH` 的条款只增不减语义）」。实测发现 `DEVOPS_PATH` **从来没有** `infrastructure/`——它列了 `scripts/`、`bin/`、`.github/`，却漏了 `AGENTS.md` §2 规定的部署/基础设施目录，而 `infrastructure` 正是 devops-agent 的写范围之一（**同一处漂移的第三格**，`docs/170` §2.4 表里未单列）。本批补上，故 `DEPLOY` 的判定**变宽**（少一类假阳性），不违反「只增不减」。

### 偏差 4：审计侧对**根级源码文件**由「合法」改判为「越界」

删除 `SOURCE_PATH` 时，其第二条正则 `/^[^/]+\.(js|mjs|cjs|ts|…)$/i`（允许实现类任务写**仓库根级源码文件**）随之消失。后果：`index.js` 这类路径在审计侧从「合法」变为「越界」。

**这是修正，不是回归**：强制侧一直拒绝它（`docs/169` Known Issues 1 记的正是「审计判合法、强制侧仍拒」这一分歧）。本批把两侧**拉齐到「都拒」**，分歧消失。E1 回放里 `.dbg.cjs` 这类根级脚本因此进入 T08 回放的越界集合——既有断言用 `arrayContaining`，未受影响。

### 偏差 5：交付物的**变体后缀**被放行（`Dockerfile.bak` / `README.bak`）

谓词写作 `/^Dockerfile(\.[^/]+)?$/i` 与 `/^README(\.[^/]+)?$/i`，因此 `Dockerfile.bak`、`README.bak` 为真。这是**有意的**：审计侧原正则 `^Dockerfile` 与 `^README(\.|$)` 同样命中它们，本判据逐条沿用既有语义（收窄只会再造一处两侧分歧）。判据管的是「属不属于交付物这一族」，不是「是不是那一份」。我最初把这两条写成了反例，被测试抓出后改正（`docs/169` 偏差 1 的同类自查）。

### 偏差 6：`isPathUnderPrefixes` 上移 `shared`，`allowed()` 改为委托

任务书 §4 裁定 7 只说要「实现类组的路径取自对应 agent 的 `writePaths`」。实施中把**前缀匹配语义本身**也收敛了：`ToolRuntimeBackend.allowed()` 原先自己写了一遍（`normalizedPrefix === "."` / `relative === normalizedPrefix` / `startsWith(prefix + "/")`），审计侧若要按前缀判定就得再写一遍——那会立刻产生第四份定义。故新增 `isPathUnderPrefixes` 于 `@ai-se/shared`，强制侧委托它（调用前仍先走 `relativePath()` 归一化，**语义逐字不变**）。

## Known Issues

1. **读侧未同步放行（本批有意不做）。** run 2 里 backend-agent 的 `read_file Dockerfile` 被拒（`Path is not readable: Dockerfile (allowed: apps/server/, server/, backend/, packages/shared/, src/, test/, package.json)`），**本批未改 `readPaths`**。理由：① `docs/170` 的判据 11a–11f 全部针对**写**侧；② 该拒绝不阻塞（agent 不读也能写，run 2 的 agent 也确实继续走了下去）；③ 要修就得要么在各 agent 的 `readPaths` 里再手抄一份交付物清单（**第四份定义**，正是本批要消灭的东西），要么新增一个只服务读侧的语义标志（超出已裁定的范围）。**登记为下一批的候选**：若要修，形态应与写侧同源（同一个谓词）。
2. **根级源码文件仍不可写（`docs/169` KI 1，本批未动）。** 若计划把服务入口点放在仓库根（而非 `src/`），N-2 同形的致败会复发。本批后两侧**一致**判越界，故至少不会再出现「审计说合法、强制侧拒」的误导。
3. **`scripts/` 目录不在任何 agent 的写范围内**（`docs/170` §1 第 8 行）。PRD 未强制该目录，E1 run 2 的 S4-01 在无 `scripts/` 时已 SUCCESS；但夹具 `mutants/` 的正解布局里用了 `scripts/check.mjs`。维持登记。
4. **`test/` 目录不在实现类 agent 的写范围内**（`docs/169` KI 2）。非阻塞（测试归 qa-agent）。维持登记。
5. **`renderScopeEntry` 的文件名启发式**（`docs/169` KI 3）：含点号的目录名会被误渲染为文件。未动。
6. **`canonicalAcKey` 在 `apps/server` 仍有一份副本**（既有登记，本次未动）。
7. **N-1b（DATABASE 类型错配）/ N-1c（红灯语义缺口）/ N-3（非最终切片的文档交付物）/ 7b 未收紧 / `CHECK_CANDIDATES` 未上移** 维持登记，本批未动。
8. **全仓门禁的既知抖动**：`failureRecovery.e2e` 在全量并行下失败一次，隔离 5 轮 × 10/10 通过、第二轮全仓 exit 0（见 E2E 节）。与 `docs/145` #7 同类。
9. **启动器会静默复用陈旧实例**（`docs/169` KI 8，本次未修）。`:47558` 上的受控实例**仍是 PL-M10 之前的代码**；本批改了 `packages/shared` / `agent-core` 并已重建 `dist`，故**下一批开工前必须再次手工停掉并重启**，否则整批会在旧代码上跑而毫无提示。

## Acceptance Result

**PASS**。`docs/170` §3 的判据全部达成：

**PL-M11**

- **11a**：实现类（backend / frontend / database）与构建类（devops）可写仓库根的 `Dockerfile` / `Dockerfile.*` / `.dockerignore` / `compose.y*ml` / `docker-compose*.y*ml` / `README.md`；`writePaths` 前缀白名单一字未动。
- **11b**：判据由 `@ai-se/shared` 的 `isRootDeliveryArtifactPath` 驱动，强制侧与审计侧共用同一份实现。
- **11c**：非交付物根文件判定不变（`index.js` / `docs/guide.md` / `notes.txt` 仍拒，有反向对照用例）。
- **11d**：只读 agent（planner / reviewer）与 qa-agent 仍不能写交付物（沙箱零调用）。
- **11e**：`writeTestFiles`（PL-M5）与 `writeProjectManifests`（PL-M10）语义与既有断言逐字不变。
- **11f**：E1 回放——S4-10 形状（BACKEND 写根 `Dockerfile`）修前 `TOOL_ERROR`、修后放行；S4-13 形状（BACKEND 写根 `README.md`）同理（见 Implementation 的回放输出）。

**PL-M12**

- **12a**：审计侧不再对 `apps/` / `backend/` / `frontend/` / `packages/database/` 报假阳性（含 run 2 实测的 `apps/` 目录摘要行，见偏差 2）。
- **12b**：`BUILD` 有明确条目，不再落默认组。
- **12c**：实现类组的路径取自 `writePathsForTaskType`（单一来源），`SOURCE_PATH` 与 `DEVOPS_PATH` 的四条交付物正则已删除。
- **12d**：审计仍由 `git status --porcelain` 差集驱动，未退化为强制侧的投影。
- **12e**：`TEST` / `ANALYSIS` / `DESIGN` 逐字不变；`DEPLOY` 的 `DEVOPS_PATH` 为「只增不减」（补 `infrastructure/`，见偏差 3）。

三包（`shared` / `agent-core` / `server`）与全仓 `typecheck` / `lint` / `test` 全绿（全仓 exit 0，第二轮）。**§2 的 6 处偏差已如实记录**，其中偏差 2 是对任务书推荐手段的实质更正，偏差 4 是方向为「收紧」的行为变化。

## Next Phase Boundary

**未开始事项（STOP）**：

- **本批未跑任何批次**。下一步维持 `docs/170` §7 第 8 项的裁定：**另开一批 E1×3**（L1-M4c 记「已执行 2/3、中止」），受周配额纪律约束（默认一周最多一个 E1×3 批次，`docs/127` §8）。**开工前三件事**：① **确认周配额余量**（本批收尾时代理值 86,595,149 / 200,000,000）；② **先停掉 `:47558` 上的陈旧实例再重启**（`l1-m4-server-launch.sh` 只要端口有应答就报 `SERVER_ALREADY_UP` 并**静默复用**，见 Known Issues 9）——现实例是 PL-M10 之前的代码；③ 用 harness 追踪的后台任务启动 + **立即** arm 看门狗（`packages/eval/scripts/eval-batch-watchdog.sh`，宜用 `--heartbeat-min 30 --stall-min 25`——默认 10/15 使停滞判定成为死代码）。
- **下一批的头号观察项**：S4-deploy-ui 整片能否走完（本批正是为它清障）——特别是 S4-10 / S4-13 两个交付物任务，以及 S4-15（BUILD）/ S4-16…18（DEPLOY）能否抵达 `staging 段`。其次是 PL-M9 的 `PLAN_TEST_BEFORE_SCRIPT_PROVIDER` / `TASK_CHECK_UNAVAILABLE` 频率（run 2 里前者 0 条、后者 1 条）。
- **未修项（均维持登记）**：读侧放行（Known Issues 1）、根级源码文件（2）、`scripts/`（3）、`test/`（4）、`canonicalAcKey` 副本（6）、N-1b / N-1c / N-3 / 7b / `CHECK_CANDIDATES`（7）、启动器陈旧实例（9）。
- 不改 `packages/eval` 的夹具与 oracle；不改 `EvalPolicy`；不改 L1-8 判据口径；不修改任何 `dist/`。
