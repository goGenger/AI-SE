# 168 · N-2「仓库根写权限」修复任务书（PL-M10）

> 状态：**已实施并收尾**（2026-10-17）。用户同日裁定「**都按你的建议，开工 PL-M10**」——即 §7 八项待裁定全部按推荐值接受。**实施记录 `docs/169`**——其中 §2 记录了**对本文档的 5 处更正**（`src/package.json` 的判定、10b 达成的是「同一谓词驱动」而非「单一实现」、`describeWriteScope` 的文本变化超出 10g 的最小要求、`renderScopeEntry` 引入的文件名启发式、跨包一致性用例无法成立），**判据强度以 `docs/169` 为准**。
> 编号：里程碑 **PL-M10**；缺陷沿用既有登记号 **N-2**（`docs/164` §2.5 / `docs/146` §3）。**不新造验收编号**——修的是缺陷，不是新增能力。
> 依据：L1-M4b run 1 实测（工作流 `cbbb7859-2549-4401-b71f-270a5be6bbc0`，2026-10-17 00:13–00:26 CST）、PL-M4 run 1 实测（工作流 `09eca545-e8a4-471b-8f23-443a3afe06ca`，2026-10-16）、代码实查（`AgentRegistry.ts` / `ToolRuntimeBackend.ts` / `writeScopeAudit.ts`）、`docs/159`（PL-M5 先例）、`docs/164` §2.5 N-2 / §7 第 6 项、`docs/146` §3、`AGENTS.md` §7/§9/§10。
> 性质：**本文件是改动方案**，不构成开工授权（`docs/146` §0）。

> **（2026-10-17 追加）§4 裁定 7「不放行根级 `README.md` 给实现类」已被推翻。** 该裁定的前提是「README 属文档类，审计侧 `DOC_PATH` 不在 BACKEND 组内，**两侧一致**判越界，不是漂移，对应 N-3」。L1-M4c run 2（工作流 `370073af-…`，2026-10-17）证明这个前提不成立：根 `README.md` 是 **AC-24（Must）的契约测试**（`test/container-contract.test.js:22-23,127-142` 要求它含 `docker run -p <host>:<port> … /data`）与 **AC-30 的 oracle**（`oracle.mjs:607-609` 读它）共同要求的**交付物**，PRD §二.8 硬性要求，夹具 `packages/eval/fixtures/E1/mutants/*/` 的正解布局也把它放在仓库根；而计划把它派成了 `S4-13`（BACKEND，`acKeys:["AC-30"]`），与 S4-10（根 `Dockerfile`）同类。用户 2026-10-17 裁定按 `docs/170` §4 裁定 5 **放行**给实现类与构建类 agent，已由 **PL-M11** 实施（任务书 `docs/170`、实施记录 `docs/171`）。**本文件 §4 裁定 7 的原文按 `docs/146` §6 规则 7 保留不改**，更正以本追加块为准。**注**：§4 裁定 3 的「文件集合口径＝与审计侧 `CONFIG_PATH` 逐条对齐」**仍然有效**——交付物是**另一类**（口径来源为审计侧 `DEVOPS_PATH`），故 PL-M11 是**并列新增**谓词与标志，不是并入 `writeProjectManifests`（`docs/171` §4 裁定 2）。

## 0. 为什么现在做这一批

1. **N-2 的严重度变了：从「不致败」升级为「第一个任务就致败」。** 登记时的表述是「无任何 agent 能写仓库根，而计划派了『编写 README』任务（`SCOPE_VIOLATION`）……真缺陷，但**未致本次失败**（审计模式 `observe` 只记录不拦）」。L1-M4b run 1 证明：当工程骨架任务排在切片**第一个**时（这正是 PL-M9 9b 想要的形状——提供者先于消费者），它**直接判死整条链**，13 分钟终止，S1 一败六挂起。
2. **它使验收批次完全失效。** 链在 S1-T1 就断，S1-T5 / S1-T6 两个 TEST 任务始终 PENDING，`PLAN_TEST_BEFORE_SCRIPT_PROVIDER` 与 `TASK_CHECK_UNAVAILABLE` 都无从测起——**这批跑到现在，PL-M9 的验证目标一个都没被触及**。按记忆 `fix-known-defects-before-batches`（源自 `docs/162` §0）：验收批次是验证修复的，不是发现缺陷的。
3. **实查发现两份写范围定义互相矛盾**（§2.3）——审计侧早就把根级清单文件当作实现类任务的**合法**写入，强制侧却全部拒绝。这属 `docs/160` 已登记的「重复定义必然漂移」缺陷类型，本次拿到了第一个**致败级**实例。

## 1. 范围

| # | 条目 | 判定 |
| --- | --- | --- |
| 1 | **PL-M10**：让合法的工程骨架写入（仓库根的清单/配置文件）在**强制侧**被放行，与**审计侧**既有语义对齐 | **真缺陷**（权限面） |
| 2 | **PL-M10**：收敛写范围的两份定义（强制侧前缀白名单 vs 审计侧正则表），消除漂移 | **真缺陷**（一致性） |

**明确排除**（本批不动）：

| # | 条目 | 排除理由 |
| --- | --- | --- |
| 3 | DATABASE 任务类型错配（N-1b，`docs/166` §2.5） | 属「任务类型适用性判定」，与本批不同源 |
| 4 | 红灯判据的语义缺口（N-1c，`docs/166` §2.5） | 未证实；收紧会误伤正当 TDD 红测试 |
| 5 | 「非最终切片不得安排文档/交付类工作」的计划期守卫（N-3，`docs/164` §7 第 2 项） | 维持原裁定「不做，只登记」；本批只修**权限面**，不改计划期选型 |
| 6 | `canonicalAcKey` 在 `apps/server` 的副本 | 独立议题，已登记 |
| 7 | PL-M9 的 9c 收紧范围、7b 收紧 | 维持原裁定，等实测频率 |

## 2. 基线事实（代码与库实查，2026-10-17）

### 2.1 机制：前缀白名单表达不了「仓库根本身」

写权限由 `packages/agent-core/src/professional/AgentRegistry.ts` 的 `AgentPermissions.writePaths` 声明，由 `ToolRuntimeBackend.ts:62-72` 的 `allowed()` 判定：

```ts
function allowed(filePath: string, prefixes: string[]): boolean {
  const relative = relativePath(filePath);
  return prefixes.some((prefix) => {
    const normalizedPrefix = relativePath(prefix);
    return (
      normalizedPrefix === "." ||
      relative === normalizedPrefix ||
      relative.startsWith(`${normalizedPrefix}/`)
    );
  });
}
```

三点关键：

1. `writePaths` 是**相对仓库根的前缀列表**。仓库根是所有这些前缀的**父目录**，任何前缀都无法表达「根**本身**」——除非用 `"."`（那等于放行一切）。
2. `allowed()` **已经支持「单个根文件」条目**（`relative === normalizedPrefix`）。`readPaths` 就是这么用的：backend / frontend / database / devops 的 `readPaths` 里都有裸的 `"package.json"`。**同一机制在写侧一个都没有。**
3. 各 agent 的写范围（`AgentRegistry.ts:57-159`）：

| agent | TaskType | `writePaths` | 能写仓库根？ |
| --- | --- | --- | --- |
| planner-agent | ANALYSIS / DESIGN | `[]`（只读） | 否 |
| frontend-agent | FRONTEND | `["apps/web","web","frontend","src"]` | 否 |
| **backend-agent** | **BACKEND** | **`["apps/server","server","backend","src"]`** | **否** |
| database-agent | DATABASE | `["packages/database","database","migrations","src"]` | 否 |
| qa-agent | TEST | `["test","tests","__tests__"]` + `writeTestFiles: true` | 否 |
| reviewer-agent | REVIEW | `[]`（只读） | 否 |
| devops-agent | BUILD / DEPLOY | `["infrastructure","compose.yaml","Dockerfile"]` | 否 |

**没有任何 agent 能写仓库根。**

### 2.2 实测证据（L1-M4b run 1，与 PL-M4 run 1 对照）

| 项 | L1-M4b run 1（2026-10-17） | PL-M4 run 1（2026-10-16） |
| --- | --- | --- |
| 失败任务 | **S1-T1**（BACKEND，"Scaffold pnpm / Node.js 22 project manifest and required scripts"），retry 2 次 | 同形状任务为 **T-05**，**SUCCESS** |
| 工作流终态 | `cbbb7859…` FAILED（444.9 s），S1 一败六挂起 | `09eca545…` FAILED，链止于 slice-1（T-10 三次验证失败） |
| agent 自陈 | "The sandbox write policy denies every repository-root path, so `package.json` cannot be created at the root… the write policy still allows only `apps/server/`, `server/`, `backend/` and `src/`" | 同左 |
| 工具面实证 | `write_file package.json → TOOL_ERROR: Path is not writable: package.json (allowed: apps/server/, server/, backend/, src/)` | `write_file package.json` / `workspace/package.json` → 同样被拒（15:29:59 / 15:30:41 / 15:31:15） |
| 门禁侧 | 验证门失败码（无）；**检查不可判定 0**；失败分层 规划 0 / 验证门 0 / agent 0 | 同左 |

**两点结论**：

- **不是 PL-M7/M8/M9 的回归。** 写范围由 agent 类型推导，两次运行的任务 `input` 里都**没有** writeScope 字段，两侧完全同构；同样的拒绝在 PL-M4 run 1 就已存在。9a/9c 一次都没触发（`检查不可判定 0`、验证门失败码（无）），失败是 agent 层的 `outcome: REPLAN`。
- **是否致败取决于顺序。** PL-M4 run 1 里脚手架排 T-05（中段），它被拒但 agent 继续提交，链推进到 T-10 才因别的原因失败；L1-M4b 里它排 S1-T1（**第一个**），一被拒整条链即死。

**未解细节（如实标注，本次未证实）**：PL-M4 run 1 的 T-05 最终 `verified`（`checks: build/test 均 exitCode 0`），说明当时工作区里**确实存在**带这两个 script 的根 `package.json`；但我在事件里**定位不到**那次成功的写入——成功的 `write_file` 事件载荷不含路径（只有失败事件带错误消息），`payload LIKE '%package.json%'` 看不到它。故「写入被拒是确定的；是否致败取决于 agent 是否继续提交」这一句成立，而「那次 package.json 是怎么出现的」**尚未证实**，本任务书不据它下结论。

### 2.3 核心发现：两份写范围定义**互相矛盾**

写范围在本仓库有**两份**定义，服务于不同目的：

| | 定义 1（**强制**） | 定义 2（**审计**） |
| --- | --- | --- |
| 位置 | `packages/agent-core/src/professional/AgentRegistry.ts` | `apps/server/src/services/writeScopeAudit.ts:34-41` |
| 形态 | 前缀白名单 `writePaths` | 正则表 `CONFIG_PATH` / `SOURCE_PATH` / … |
| 键 | agent 类型 | TaskType |
| 作用 | `ToolRuntimeBackend` **拒绝**越界写入 | `SCOPE_VIOLATION` 事件（默认 `observe`，只记录） |

**审计侧的 `CONFIG_PATH` 原文**：

```
/^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml)$/i
```

而 `SCOPE_RULES` 里 `BACKEND: [SOURCE_PATH, CONFIG_PATH]`——**审计明确认为「BACKEND 任务写仓库根的 `package.json`」是合法的**。

**强制侧同时把同一个写入拒掉。** 同一个仓库、同一时刻，一边说合法、一边说不合法：

| 路径（BACKEND 任务） | 审计判定 | 强制判定 |
| --- | --- | --- |
| `package.json` | **合法**（CONFIG_PATH） | **拒绝** |
| `pnpm-lock.yaml` | **合法**（CONFIG_PATH） | **拒绝** |
| `tsconfig.json` | **合法**（CONFIG_PATH） | **拒绝** |
| `.gitignore` | **合法**（CONFIG_PATH） | **拒绝** |
| `index.js`（根级源码） | **合法**（SOURCE_PATH 第二条） | **拒绝** |
| `src/...` | 合法 | 放行 |
| `README.md` | 越界（DOC_PATH 不在 BACKEND 组内） | 拒绝（两者一致） |

即：**审计侧早就把「实现类任务可以写工程清单」写进了代码，强制侧从未跟上。** 这不是「要不要放宽」的新设计，而是**让强制侧追上审计侧已经声明的语义**。

### 2.4 影响面

- 任何「先建 manifest 再实现」的项目（E1 的 S1-T1 即此），只要该任务被派给实现类 agent，就必然写不出根清单。
- 九个评测夹具中，**E1 的 S1-T1 已实测致败**；其余夹具是否也派了根清单任务未逐个核对（本批不做）。
- 生产路径同样受影响：平台交付任何新项目都要先有 `package.json`。

### 2.5 伴生发现（登记）

- **M-1｜`describeWriteScope` / `describeReadScope` 的尾斜杠渲染 bug。** `ToolRuntimeBackend.ts:80` 与 `:91` 都是 `prefixes.join("/, ") + "/"`——把**单文件条目**也渲染成目录，于是消息里出现 `package.json/`（实测：PL-M4 run 1 的读侧拒绝消息原文 `allowed: apps/server/, server/, backend/, packages/shared/, src/, test/, package.json/`）。判定逻辑本身正确（`allowed()` 走 `relative === normalizedPrefix`），**纯显示缺陷**。但它直接削弱 PL-M5 立的项目标——「拒绝必须可被发现」（`ToolRuntimeBackend.ts:76` 注释）：agent 看到 `package.json/` 会以为要写成目录。

## 3. 判据

| 判据 | 期望 |
| --- | --- |
| 10a：实现类 agent 可写仓库根的**工程清单/配置文件**（与审计 `CONFIG_PATH` 同集） | 新增。`package.json` / `pnpm-lock.yaml` / `tsconfig*.json` / `.gitignore` 等 |
| 10b：写范围的**两份定义收敛为一份**（或至少由同一谓词驱动） | 新增。消除 §2.3 的漂移；「重复定义必然漂移」已由 `docs/160` 记为本仓库的缺陷成因类型 |
| 10c：**非**清单类根文件的判定**逐字不变**（如 BACKEND 写 `README.md` 仍越界） | 保持。放宽只限清单/配置类 |
| 10d：`writeTestFiles`（PL-M5）语义与既有测试**逐字不变** | 保持。PL-M5 不回归 |
| 10e：只读 agent（planner / reviewer）**仍不能写任何文件** | 保持 |
| 10f：E1 回放——S1-T1 形状（BACKEND 任务写 `package.json`）→ 修前拒绝、修后放行 | 新增（本里程碑的核心判据） |
| 10g：`describeWriteScope` 不再把单文件条目渲染成目录（`package.json` 而非 `package.json/`） | 新增（§2.5 M-1；是否并入本批见 §7 第 5 项） |

## 4. 设计裁定（本任务书的推荐值）

| # | 事项 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | 修法的形态 | **在 `@ai-se/shared` 增一个根级工程清单谓词（如 `isProjectManifestPath`），强制侧与审计侧共用** | ① **本仓库已有完全同形的先例**：PL-M5 把 `isTestFilePath` 上移 `@ai-se/shared`（现 `packages/shared/src/index.ts:889`），正是为了「强制侧与审计侧共用一份判据」——N-2 是同一个缺陷形状（前缀白名单表达不了语义类别），修法应当同形；② 一次解决 10a 与 10b；③ 符合 `AGENTS.md` §3「跨包共享的类型/契约放 `packages/shared`」 |
| 2 | 授予哪些 agent | **实现类（backend / frontend / database）+ devops**；qa 维持 `writeTestFiles` 不变；planner / reviewer 维持只读 | 工程清单是**实现类与构建类**的合法产物；qa 的职责是测试文件（PL-M5 已解决），reviewer/planner 无写入职责（10e） |
| 3 | 文件集合口径 | **与审计侧 `CONFIG_PATH` 逐条对齐**（含 `*.config.*`、`.env*`、`.gitignore|.eslintrc*|.prettierrc*|.npmrc|.nvmrc`、`Makefile` 等） | 审计侧是**既有**语义，本批是「让强制侧追上」而非新设计；口径若另立一套就会立刻产生第三份定义 |
| 4 | 是否同批收敛两份定义 | **同批**（10b） | 只修强制侧、不动审计侧，等于把「两份定义」变成「两份不一致的定义」——漂移照旧 |
| 5 | 是否同批修 `describeWriteScope` 显示 bug（M-1） | **同批**（10g） | 同一文件、纯显示、且直接削弱 PL-M5 的项目标（拒绝必须可被发现）；改动可测（断言消息字符串） |
| 6 | 是否加**计划期守卫**（计划派了必须写仓库根的任务、却没有 agent 能写 → 计划期报错） | **不做** | 与 PL-M7 §4 裁定 2 同理：判据只能靠标题/描述文本匹配，脆弱且易误伤。**先把权限侧修对**，守卫的必要性会随之消失 |
| 7 | 是否顺带把根级 `README.md` 也放行给实现类 | **不做**（只登记） | README 属**文档类**，审计侧 `DOC_PATH` 明确不在 BACKEND 组内——两侧**一致**（§2.3 末行），不是漂移。它对应的是 N-3（非最终切片不得安排文档交付物），维持原裁定「不做，只登记」 |
| 8 | 是否改 `packages/eval` 夹具（如在模板里预置 `package.json`） | **不做** | 红线：不改 `packages/eval` 的夹具与 oracle（`docs/166` §6）。且在模板里预置等于**回避**缺陷：真实项目里平台仍写不出根清单 |

**被否掉的方案（记录，避免重复推演）**：

| 方案 | 否决理由 |
| --- | --- |
| **A｜直接把根文件加进各 agent 的 `writePaths`** | 可行（`allowed()` 支持单文件条目），但**留下两份定义**：审计侧的 `CONFIG_PATH` 正则仍在，二者会再次漂移——正是本缺陷的成因。若要选它，必须同时执行裁定 4 |
| **B｜新增 `writeRootManifests?: boolean` 语义标志**（与 `writeTestFiles` 对称） | 与 PL-M5 同形、改动局部，但**判据仍要写一遍**（谓词放哪？）。若谓词放 `@ai-se/shared`（推荐值 1），则标志本身只是开关，价值不如直接共用谓词；若谓词留 `agent-core`，审计侧仍无法复用 → 10b 达不成 |
| **C｜把工程骨架任务改派 DEVOPS / 扩 devops 写范围** | 改的是**计划期的任务类型选择**，属 N-1b 邻域；且 BUILD/DEPLOY 类型在切片里的语义是「构建与部署」，用它承担「建工程骨架」会让 `SCOPE_RULES` 的 DEVOPS_PATH 与 CONFIG_PATH 又生歧义 |
| **D｜把 `"."` 加进 `writePaths`**（全放开） | 等于取消写范围约束，直接违反 `AGENTS.md` §10 的权限不变量 |
| **E｜改 `packages/eval` 模板预置 `package.json`** | 回避缺陷（见裁定 8）；且只对 E1 生效，生产路径照旧 |

## 5. 验证分层

| 层 | 位置（`AGENTS.md` §6 / §7） |
| --- | --- |
| 单测（谓词） | `packages/shared` 同目录混放惯例：`isProjectManifestPath` 正反例（清单类 vs 非清单类；根级 vs 子目录同名文件） |
| 单测（强制侧） | `packages/agent-core/src/professional/AgentRegistry.test.ts` 更新范围断言；`ToolRuntimeBackend.test.ts` 放行/拒绝正反例（**含 10c 的反向对照**：BACKEND 写 `README.md` 仍拒） |
| 单测（审计侧） | `apps/server` 的 `writeScopeAudit.test.ts`：根级清单判定与强制侧**一致**（同一谓词驱动） |
| 单测（显示） | `ToolRuntimeBackend.test.ts`：`describeWriteScope` 消息不含 `package.json/` |
| 回归 | 注入式用例（10f）：BACKEND 任务 + 写 `package.json` → 修前 `Path is not writable`，修后放行 |
| 共享夹具核对 | 全树 grep 钉住范围的精确断言（`AGENTS.md` §7）：已知 `ToolRuntimeBackend.test.ts:86` 钉了 `allowed: apps/server/, server/, backend/, src/`、`:129` 钉了 `allowed: none`、`AgentRegistry.test.ts:98-112` 钉了 qa 的 `writePaths` 与 `writeTestFiles`。**同一提交内同步更新**，否则失败会被误读为回归 |
| 门禁 | 受影响包（`shared` / `agent-core` / `server`）`typecheck && lint && test`；收尾前全仓 `corepack pnpm -r run typecheck && lint && test` |
| A/B 实测（强制） | `docs/165` §2 偏差 1 的教训：7b 曾被硬错误化并静默打断 `planningApi.e2e`。改权限面后**必须先跑** `apps/server` 的 `writeScopeAudit` / `externalEngineering.e2e` / `v1GoldenScenario.e2e` 三例做改前基线对比 |

## 6. 边界与红线

- **不新增第二套 Permission / Approval / Audit / 错误码体系**（`AGENTS.md` §10）；复用既有 `AgentPermissions` 与 `SCOPE_RULES`。
- **不放开任意根写入**：放宽严格限定为「工程清单/配置文件」，且只对实现类与构建类 agent。
- 不改 `packages/eval` 的夹具与 oracle；不改 `EvalPolicy`；不改 L1-8 判据口径。
- 不改计划期的任务类型选择与切片划分（N-1b / N-3 均维持登记）。
- 不修改历史 `tasks` / `agent_runs` / `workflow_events` 行；不回溯改写 run 1 的库数据。
- 不修改任何 `dist/`。
- **本批不跑 E1×3 批次**；L1-M4b 的续跑口径见 §7 第 7 项。
- 收口时同步登记账：`docs/146` §3（N-2 行改为「已修（PL-M10）」）、`docs/127` §5 第 11 条（② 的处置更新）、`docs/164` §2.5 N-2 以**追加块**记更正（`docs/146` §6 规则 7）、`docs/127` §6 运行环境快照更新。

## 7. 待裁定项（每条带推荐值）

| # | 事项 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | 修法形态（§4 裁定 1 的 A/B/C） | **共享谓词**（`@ai-se/shared` 的 `isProjectManifestPath`，两侧共用） | 见 §4 裁定 1；与 PL-M5 同形，一次解决 10a + 10b |
| 2 | 授予哪些 agent | **backend / frontend / database / devops**；qa 与只读 agent 不变 | 见 §4 裁定 2 |
| 3 | 文件集合口径 | **与审计侧 `CONFIG_PATH` 逐条对齐** | 见 §4 裁定 3 |
| 4 | 是否同批收敛两份定义 | **同批** | 见 §4 裁定 4 |
| 5 | 是否同批修 `describeWriteScope` 显示 bug（M-1） | **同批** | 见 §4 裁定 5 |
| 6 | 是否加计划期守卫 | **不做** | 见 §4 裁定 6 |
| 7 | **L1-M4b 批次怎么记账、何时续跑** | **记「已执行 1/3，因用户裁定先修 N-2 中止」**；PL-M10 收尾后**另开一批** E1×3（不续跑原批，理由同 `docs/164` §7 第 4 项：避免修前/修后混批） | 续跑会把修前（run-1）与修后（runs 2/3）两个平台版本混进同一批次，使三次运行不可比。受周配额纪律约束（`docs/127` §8），落在下周窗口；**开工前须确认周配额余量** |
| 8 | 本批是否顺带放行根级 `README.md` 给实现类 | **不做**，只登记（对应 N-3） | 见 §4 裁定 7：两侧一致，不是漂移 |

## 8. 本批已发生的事实（供记账，非判据）

- **L1-M4b 批次**：`packages/eval/scripts/l1-m4b-e1-x3.sh`（新增），结果目录 `packages/eval/results/l1-m4b`。run 1 于 2026-10-17 00:13:09 启动、00:26:29 结束（FAILED，真成功 0 / 假阳性 0 / staging 段 否 / 检查不可判定 0）。**runs 2/3 未执行**（用户裁定中止）。
- **受控实例已重启**：`:47558` 原实例（pid 92979，2026-10-16 15:10:50 启动）跑的是 PL-M7/M8/M9 **之前**的代码且为 `tsx`（非 watch）不会自更新；已停掉并以 `l1-m4-server-launch.sh` 重启为 pid 5934（2026-10-17 00:12:04），晚于 10-16 23:29 的 `dist` 重建。
- **看门狗缺陷已修**：`packages/eval/scripts/eval-batch-watchdog.sh` 的停滞判定基线原取「工作区树最新文件的绝对 mtime」，而重跑复用同一工作区路径（`E1/run-1`），上一批遗留文件会使其在 arm 后**立即误报停滞**（实测 arm 后 38 秒报「停滞 503 分钟」）。已改为**从 arm 时刻起算**。另注：默认 `--heartbeat-min 10` < `--stall-min 15` 且停滞判定排在心跳之前，**默认参数下停滞判定是死代码**。
- **口径冲突（未改文档）**：`docs/127` §6/§8 写「周配额护栏 20M」，而批次脚本的止损线是 **200M 代理值**（注释记为「user ruling 2026-10-14」）。按「代码权威于文档」，20M 为过期表述；但网关控制台在外部、本机读不到（`.env` 只有 `OPENAI_BASE_URL`，`docs/105` 无配额端点）。本批实测代理值：启动时 53,589,620 / 200,000,000。**留到 PL-M10 收尾时与其余登记账一次性更正。**
