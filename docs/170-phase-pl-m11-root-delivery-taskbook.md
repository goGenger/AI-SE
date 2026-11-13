# 170 · 「仓库根交付物写权限」修复任务书（PL-M11 / PL-M12）

> 状态：**已实施并收尾**（2026-10-17）。用户同日裁定「**都按你的建议，开工 PL-M11**」——即 §7 八项待裁定全部按推荐值接受（含裁定 6「PL-M12 同批」，故两个里程碑同批实施）。**实施记录 `docs/171`**——其中 §2 记录了**对本文档的 6 处更正**（两处被钉住的断言因裁定变化而更新；**只做派生不足以达成 12a，必须另加「目录摘要行」规则**；`DEVOPS_PATH` 补 `infrastructure/` 使 `DEPLOY` 变宽；审计侧对根级源码文件由「合法」改判「越界」；交付物变体后缀被放行；`isPathUnderPrefixes` 上移 shared），**判据强度以 `docs/171` 为准**。
> 编号：里程碑 **PL-M11**（仓库根交付物写权限）／**PL-M12**（审计侧路径表与强制侧写范围的漂移收敛）。**不新造验收编号**——修的是缺陷，不是新增能力。缺陷登记号 **N-4**（新登记；N-2 已由 PL-M10 修复，见 `docs/169`）。
> 依据：L1-M4c run 2 实测（工作流 `370073af-71fe-4854-9da4-cb67d4f016c4`，S4-deploy-ui 切片，2026-10-17 02:00–03:37 CST）、`packages/eval/results/l1-m4c/run-2.json`、dev 库只读实查（`tasks` / `workflow_events` / `requirement_acceptance_criteria`）、代码实查（`AgentRegistry.ts` / `ToolRuntimeBackend.ts` / `writeScopeAudit.ts` / `taskVerifier.ts:786-845`）、夹具实查（`packages/eval/fixtures/E1/oracle.mjs` / `template/` / `mutants/`）、`docs/168` / `docs/169`（PL-M10 先例）、`docs/160`（「重复定义必然漂移」）、`docs/146` §6 规则 7/8、`AGENTS.md` §7/§9/§10。

## 0. 为什么现在做这一批

1. **链第一次走到了最终切片，然后死在交付物上。** L1-M4c run 2 把整条链推进到 **S4-deploy-ui（最终切片）**——S1 12/12、S2 9/9、S3 19/19 全部 SUCCESS，S4 前 9 个任务里 8 个 SUCCESS。这是迄今最好的结果，也是第一次真正摸到 L1-8 的判据面。**唯一的失败任务是 S4-10**（BACKEND，「编写 Dockerfile … 保证 `docker build -t taskboard .` 成功」），重试 2 次后 FAILED；S4-11…S4-18 共 8 个任务因此挂起（READY 4 / PENDING 4），`staging 段` 三项全 PENDING。

2. **根因与 N-2 同形，但 PL-M10 的口径没有覆盖它。** PL-M10 放行的是「仓库根的**工程清单/配置**」（`package.json` / `pnpm-lock.yaml` / `tsconfig*.json` / `.gitignore` …，口径逐条对齐审计侧既有的 `CONFIG_PATH`）。而 run 2 缺的是**交付物**：根 `Dockerfile`（AC-24/25/26/29 四条 Must 全依赖它）与根 `README.md`（AC-24 的契约测试与 AC-30 都要求它）。这两类都不在 `CONFIG_PATH` 集合里，故 PL-M10 一字未覆盖。

3. **这是确定性缺陷，不是抖动。** 判据在夹具里是硬的：oracle 的容器段执行 `docker build -t taskboard .`（`cwd = workspace`，`oracle.mjs:626-629`），构建上下文就是仓库根；AC-25/26/29 三条全部挂在 `containerUp` 之下（`oracle.mjs:716-724`）。没有根 `Dockerfile`，容器段**必然**全灭——**多跑几次也一样**。按记忆 `fix-known-defects-before-batches`（源自 `docs/162` §0）：验收批次是验证修复的，不是发现缺陷的。

4. **审计侧的路径表在 run 2 里第一次报出假阳性。** `SCOPE_VIOLATION {"mode":"observe","taskKey":"S4-10","taskType":"BACKEND","violations":["apps/"],"totalChanged":2}`——`apps/` 是本仓库 `AGENTS.md` §2 规定的顶层应用目录，所有实现类 agent 的 `writePaths` 都含 `apps/server` 或 `apps/web`，而审计侧的 `SOURCE_PATH` 正则**根本没有 `apps/`**。这是 `docs/160` 登记的「重复定义必然漂移」的又一实例，与 N-2 同源（N-2 是审计严、强制宽，这次是审计严、强制宽的另一处）。它不阻塞（`observe` 只记录），但会污染批次指标 `scopeViolations`，使下一批的读数不可信。

## 1. 范围

| # | 里程碑 | 条目 | 判定 |
| --- | --- | --- | --- |
| 1 | **PL-M11** | 让实现类与构建类 agent 能写**仓库根交付物**（`Dockerfile` / `Dockerfile.*` / `.dockerignore` / `compose.y*ml` / `docker-compose*.y*ml` / `README.md`） | **真缺陷**（权限面，致败级） |
| 2 | **PL-M11** | 该判据由 `@ai-se/shared` 的**单一谓词**驱动，强制侧与审计侧共用（与 PL-M10 同形） | **真缺陷**（一致性） |
| 3 | **PL-M12** | 审计侧 `SCOPE_RULES` 的路径表与强制侧 `writePaths` 漂移收敛（含 `BUILD` 类型无条目） | **真缺陷**（一致性；已实测假阳性） |

**明确排除**（本批不动）：

| # | 条目 | 排除理由 |
| --- | --- | --- |
| 4 | DATABASE 任务类型错配（N-1b，`docs/166` §2.5） | 属「任务类型适用性判定」，与本批不同源；PL-M9 已使其可见（run 2 实测 1 条 `TASK_CHECK_UNAVAILABLE`），维持登记 |
| 5 | 红灯判据的语义缺口（N-1c，`docs/166` §2.5） | 未证实；收紧会误伤正当 TDD 红测试 |
| 6 | 「非最终切片不得安排文档/交付类工作」的计划期守卫（N-3，`docs/164` §7 第 2 项） | 维持原裁定「不做，只登记」。**注**：N-3 讲的是**切片错置**，与本批的**权限面**是两回事——本批只修后者 |
| 7 | 根级**源码**文件（`index.js` 等）仍不可写（`docs/169` Known Issues 1） | 维持登记。E1 的入口点在 `src/`，未实测致败；放行根级任意源码等于放开写范围 |
| 8 | `scripts/` 目录不在任何 agent 写范围内（本批新发现） | 只登记。PRD §二.2 只说 lint/typecheck/build「允许为轻量自检脚本」，**未强制目录**；E1 run 2 的 S4-01 已在无 `scripts/` 的情况下 SUCCESS |
| 9 | `test/` 不在实现类 agent 写范围内（`docs/169` Known Issues 2） | 维持登记，非阻塞（测试归 qa-agent） |
| 10 | `canonicalAcKey` 在 `apps/server` 的副本、`CHECK_CANDIDATES` 未上移 `@ai-se/shared`、7b 未收紧 | 均维持既有登记 |
| 11 | 启动器 `l1-m4-server-launch.sh` 静默复用陈旧实例（`docs/169` Known Issues 8） | 属相邻工作（`AGENTS.md` §9）。**但它是下一批开工前的手工前置动作**，见 §6 |

## 2. 基线事实（代码、夹具、库三方实查，2026-10-17）

### 2.1 两个硬阻塞

**阻塞一：根 `Dockerfile`。** S4-10 的任务描述本身就点名了它：

> 编写 Dockerfile：基于 `node:22-alpine`；构建阶段执行 `pnpm install --frozen-lockfile`；COPY 应用代码；EXPOSE 应用端口；ENV `DATA_DIR=/data`；`VOLUME /data`；创建/复用非 root 用户并将其设为 `USER`，且 `/data` 与应用目录归属该非 root 用户可写；CMD/ENTRYPOINT 使用 `pnpm start` 且不做任何文件重定向，**保证 `docker build -t taskboard .` 成功**、`docker run` 后健康端点可达。

agent 的三次尝试全部被拒（`workflow_events`，`tool_call_finished`）：

| 迭代 | 工具 | 结果 |
| --- | --- | --- |
| 26 | `write_file` | `TOOL_ERROR: Path is not writable: Dockerfile (allowed: apps/server/, server/, backend/, src/, and project manifests/configs at the repository root (…))` |
| 30 | `write_file` | 同左，路径 `docker/Dockerfile` |
| 35 | `write_file` | 同左，路径 `Dockerfile.dev` / `dockerfile` |
| 38 | `write_file` | 同左，路径 `Dockerfile` |
| 49 | `write_file` | 同左，路径 `workspace/Dockerfile` |
| 15 | `read_file` | `TOOL_ERROR: Path is not readable: Dockerfile (allowed: apps/server/, server/, backend/, packages/shared/, src/, test/, package.json)` |

**读侧也拒**：backend-agent 的 `readPaths` 里没有 `Dockerfile`（有 `package.json`，那是 PL-M10 之前就有的单文件条目）。

agent 的绕行与自陈（`tasks.output.issues`，`outcome: REPLAN`）：

> **`Dockerfile`｜HIGH**：Repository-root Dockerfile cannot be written under this run's write policy. The graded suites resolve `ROOT=/workspace` and read `/workspace/Dockerfile` (and `docker/Dockerfile`), so `docker build -t taskboard .` has no build-context file and **AC-24 x4, AC-25 x2, AC-26 x5, AC-29 x3 cannot pass**.
> **recommendation**：Grant this deployment task repository-root write scope for `Dockerfile`, or map `backend/` to the repository root during assembly…

它随后把同一份 Dockerfile 逐字节写到 **`backend/Dockerfile`、`server/Dockerfile`、`apps/server/Dockerfile`**（三份都命中 backend-agent 的写范围），并在 `src/Dockerfile` 留了一个指针注释——**但没有一份落在仓库根**。

**夹具侧的确证**（`packages/eval/fixtures/E1/oracle.mjs`）：

- `:626-629` 容器段执行 `docker build -t taskboard .`，`cwd: workspace` —— 构建上下文即仓库根，**根 `Dockerfile` 是硬要求**。
- `:661` AC-24 断言 `build.code === 0 && containerUp`。
- `:720-722` `containerUp` 为假时 `AC-25` / `AC-26` / `AC-29` 一律 `record(…, false, …)` —— **四条 Must AC 共享同一个前置**。

**阻塞二：根 `README.md`。** 两处独立要求它：

- **AC-24 的契约测试**（qa-agent 在 S4-03 写下的 `test/container-contract.test.js`，`:22-23` 钉死 `DOCKERFILE_PATH = ROOT/Dockerfile`、`README_PATH = ROOT/README.md`）：`:127-142` 断言 `README.md` 存在、含 `docker run` 命令、该命令映射主机端口（`-p host:container`）且引用 `DATA_DIR=/data` 或 `:/data`。
- **AC-30 的 oracle**（`oracle.mjs:607-609`）：`existsSync(join(workspace,"README.md"))` 且 `readme.length > 50`。
- **PRD §二.8**（`fixture.json` 原文）：「README：文档化「安装 / 启动 / 测试 / 构建镜像 / 运行镜像」全部命令。」

**模板里的 `README.md` 是个 189 字节的占位文件**（原文：「这是评测工作区的占位文件（保证 git 基线可提交）。请在**当前目录**按任务描述从零完成实现；**不要读取或依赖任何评测侧资产**。」）——它恰好通过 oracle 的 `length > 50`，但**不含** `docker run -p … /data`，故 AC-24 的 README 用例必然红。而计划把这件事派给了 **S4-13（BACKEND，`acKeys:["AC-30"]`）**：

> 编写 README：文档化安装（`pnpm install --frozen-lockfile`）、启动（`pnpm start`，PORT/DATA_DIR 说明）、测试（`pnpm test`）、构建镜像（`docker build -t taskboard .`）、运行镜像（`docker run -p <host>:<port> -v <volume>:/data -e DATA_DIR=/data taskboard`）全部命令…

**结论**：根 `README.md` 不是「文档类的可选交付物」，而是 **AC-24（Must）的测试与 AC-30（Must）的 oracle 共同要求的交付物**。这一点**推翻了** `docs/168` §4 裁定 7 的前提（该裁定认为「README 两侧一致判越界，不是漂移，对应 N-3」——当时不知道 AC-24 的契约测试会读它）。按 `docs/146` §6 规则 8，此项**裁定变化须登记**。

### 2.2 机制：PL-M10 放行的是「清单/配置」，交付物是另一类

| | PL-M10 已覆盖 | 本批缺口 |
| --- | --- | --- |
| 集合 | `isProjectManifestPath`：`package.json` / `pnpm-lock.yaml` / `tsconfig*.json` / `.env*` / `.gitignore` / `*.config.*` / `Makefile` | `Dockerfile` / `.dockerignore` / `compose.y*ml` / `README.md` |
| 口径来源 | 逐条对齐审计侧既有的 `CONFIG_PATH` | 审计侧 `DEVOPS_PATH`（**但只挂在 `DEPLOY` 上**） |
| run 2 实测 | S1-T1 形状与 S4-01（根 `package.json`）**均 SUCCESS** | S4-10（根 `Dockerfile`）**FAILED** |

审计侧的 `DEVOPS_PATH`（`writeScopeAudit.ts:45-54`）原文含 `/^Dockerfile/i`、`/^docker-compose[^/]*\.(ya?ml)$/i`、`/^\.dockerignore$/i`、`/^(scripts|bin)\//`、`/^README(\.|$)/i`、`/^\.github\//`。**审计早就把根 `Dockerfile` 与根 `README.md` 认作交付物**——只是它把这份认定只给了 `DEPLOY`，而计划把这两件事派成了 `BACKEND`。

### 2.3 夹具的意图布局（mutants 实证）

`packages/eval/fixtures/E1/mutants/*/` 的六份变体（`no-data-isolation` / `no-persistence` / `plaintext-passwords` / `title-off-by-one` / `wrong-error-codes` / `patch-ignores-unknown-fields`）布局完全一致：

```
Dockerfile          ← 仓库根
package.json        ← 仓库根（PL-M10 已覆盖）
pnpm-lock.yaml      ← 仓库根（PL-M10 已覆盖）
README.md           ← 仓库根（本批缺口）
scripts/check.mjs
src/{server,auth,tasks,store,pages,validate}.mjs
test/{api,deploy-contract}.test.mjs
```

即：**夹具作者认定的交付形态就是「根清单 + 根 Dockerfile + 根 README + `src/` + `test/` + `scripts/`」**。这不是我们的推测，是夹具自带的正解。

### 2.4 审计侧路径表漂移（六行）

写范围在本仓库仍有**两份**定义（N-2 时发现，PL-M10 只收敛了 `CONFIG_PATH` 那一格）：强制侧 `AgentRegistry.writePaths`（前缀白名单，按 agent），审计侧 `writeScopeAudit.ts` 的 `SCOPE_RULES`（正则，按 TaskType）。逐类型比对：

| TaskType | 审计 `SCOPE_RULES` | 强制侧对应 agent 的 `writePaths` | 分歧方向 |
| --- | --- | --- | --- |
| ANALYSIS / DESIGN | `DOC_PATH` + `CONFIG_PATH` | planner-agent：`[]`（只读） | 审计宽、强制严（无害） |
| DATABASE | `SOURCE_PATH` + `CONFIG_PATH` | database-agent：`packages/database` / `database` / `migrations` / `src` | `packages/database/` 审计判越界（假阳性） |
| **BACKEND** | `SOURCE_PATH` + `CONFIG_PATH` | backend-agent：`apps/server` / `server` / `backend` / `src` | **`apps/`、`backend/` 审计判越界——run 2 实测** |
| FRONTEND | `SOURCE_PATH` + `CONFIG_PATH` | frontend-agent：`apps/web` / `web` / `frontend` / `src` | `apps/`、`frontend/` 假阳性 |
| TEST | `TEST_PATH` | qa-agent：`test` / `tests` / `__tests__` + `writeTestFiles` | 基本一致 |
| REVIEW | **无条目** → 落默认组 | reviewer-agent：`[]`（只读） | 审计宽、强制严（无害） |
| **BUILD** | **无条目** → 落默认组 | devops-agent：`infrastructure` / `compose.yaml` / `Dockerfile` | **`Dockerfile`、`infrastructure/` 假阳性** |
| DEPLOY | `DEVOPS_PATH` + `CONFIG_PATH` | **无 agent**（`TASK_AGENT_TYPES` 无 `DEPLOY`） | 交付链另行处理，两侧不可比 |

**根因**：`SOURCE_PATH`（`writeScopeAudit.ts:30-33`）是 `/^(src|app|lib|server|pages|components|api|public|static|assets|styles|data|migrations?|db)\//`——它描述的是 **`app/`（单数）、`pages/`、`lib/`、`components/` 这类 Web 框架布局**，而本仓库 `AGENTS.md` §2 规定的顶层是 **`apps/`（复数）与 `packages/`**。**这张表描述的是一个并不存在的项目布局。** 所以它对真实的 `apps/` 与 `packages/database/` 一律报越界。

**关键性质（必须在改动中保住）**：审计**不是**强制侧的同义反复。`auditWriteScope` 的输入 `changedPaths` 来自 `git status --porcelain` 的前后差集（`taskVerifier.ts:816`），即**任务期间文件系统的全部变化**，包括绕过 `write_file` 工具门（构建脚本、shell、依赖安装）产生的写入。故它捕得到强制侧捕不到的东西。**修表必须保住这一点**，不能把审计改成 `writePaths` 的投影。

### 2.5 影响面

- **E1 夹具**：`S4-deploy-ui` 整片（18 任务）依赖根 `Dockerfile`；`AC-24` / `AC-25` / `AC-26` / `AC-29` / `AC-30` 五条 Must 全部受影响。
- **其余八个夹具**（`L1` / `L2` / `M1` / `M2` / `M3` / `S1` / `S2` / `S3`）：实查**均不含 `Dockerfile` 要求**（`grep -rl Dockerfile` 命中 0），本批不改它们，但也**不会被本批破坏**（放行是放宽）。
- **生产路径**：任何交付容器镜像的项目都要在仓库根写 `Dockerfile`；任何交付文档的项目都要在仓库根写 `README.md`。当前平台在这两件事上**结构性做不到**。

## 3. 判据

### PL-M11 仓库根交付物写权限

| 判据 | 期望 |
| --- | --- |
| 11a：实现类（backend / frontend / database）与构建类（devops）agent 可写**仓库根的交付物** | 新增。`Dockerfile` / `Dockerfile.*` / `.dockerignore` / `compose.y*ml` / `docker-compose*.y*ml` / `README.md` |
| 11b：判据由 `@ai-se/shared` 的**单一谓词**（`isRootDeliveryArtifactPath`）驱动，强制侧与审计侧共用 | 新增（与 PL-M10 的 `isProjectManifestPath` 同形） |
| 11c：**非交付物**根文件的判定**逐字不变** | 保持。根 `index.js` 仍拒（`docs/169` KI 1）；子目录同名（`src/README.md`）不因本谓词放行 |
| 11d：只读 agent（planner / reviewer）与 qa-agent **仍不能**写这些路径 | 保持 |
| 11e：`writeTestFiles`（PL-M5）与 `writeProjectManifests`（PL-M10）的语义与既有断言**逐字不变** | 保持 |
| 11f：E1 回放——S4-10 形状（BACKEND 写根 `Dockerfile`）与 S4-13 形状（BACKEND 写根 `README.md`）→ 修前拒绝、修后放行 | 新增（本里程碑的核心判据） |

### PL-M12 审计侧路径表漂移收敛

| 判据 | 期望 |
| --- | --- |
| 12a：审计侧不再对本仓库**实际布局**（`apps/`、`backend/`、`frontend/`、`packages/database/`）报假阳性 | 新增 |
| 12b：`BUILD` 类型有**明确条目**（含 devops 的 `infrastructure` / `compose.yaml` / `Dockerfile`），不再落默认组 | 新增 |
| 12c：收敛方式为**单一来源**（实现类组的路径取自对应 agent 的 `writePaths`），而非再手抄一份表 | 新增。`docs/160`：重复定义必然漂移 |
| 12d：**审计的信号价值不变**——它仍由 `git status --porcelain` 差集驱动，能捕获绕过工具门的写入；不得退化为强制侧的投影 | 新增（须有测试钉住，见 §5） |
| 12e：`TEST` / `DEPLOY` / `ANALYSIS` / `DESIGN` 四组的既有行为**逐字不变**（`DEVOPS_PATH` 的 `README` / `scripts` / `.github` 条款只增不减语义） | 保持 |

## 4. 设计裁定（本任务书的推荐值）

| # | 事项 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | 修法形态 | **在 `@ai-se/shared` 新增根交付物谓词（`isRootDeliveryArtifactPath`），强制侧与审计侧共用** | ① PL-M5 / PL-M10 已有两次完全同形的先例；② 一次解决 11a + 11b；③ 符合 `AGENTS.md` §3「跨包共享的类型/契约放 `packages/shared`」 |
| 2 | 与 PL-M10 的关系 | **并列新增，不并入 `writeProjectManifests`** | 两者语义不同（工程清单/配置 vs 交付物），口径来源也不同（`CONFIG_PATH` vs `DEVOPS_PATH`）；合并会让「清单」这个名字说谎，也失去分别授予的能力 |
| 3 | 授予哪些 agent | **backend / frontend / database / devops**（与 PL-M10 同集）；qa / planner / reviewer 不变 | 与 PL-M10 裁定 2 同理：交付物是实现类与构建类的合法产物 |
| 4 | 文件集合口径 | **逐条对齐审计侧 `DEVOPS_PATH` 中的交付物条款**：`Dockerfile` / `Dockerfile.*` / `.dockerignore` / `compose.y*ml` / `docker-compose*.y*ml` / `README.md`（**仅根级**）。`scripts/`、`bin/`、`.github/` **不并入** | 「让强制侧追上审计侧已经声明的语义」（PL-M10 的同一原则）。`scripts/` 与 `.github/` 属目录类，本批只登记（§1 第 8 行） |
| 5 | 根 `README.md` 是否放行 | **放行**（**推翻** `docs/168` §4 裁定 7） | §2.1 阻塞二：AC-24 的 qa 契约测试与 AC-30 的 oracle 都要求根 README，PRD §二.8 硬性要求，夹具 mutants 把它放在根。原裁定的前提（「两侧一致判越界，属文档类」）**已被实测推翻**；按 `docs/146` §6 规则 8 登记裁定变化 |
| 6 | PL-M12 是否同批 | **同批** | 只修 PL-M11 会把假阳性留在批次读数里，下一批的 `scopeViolations` 仍不可信；且两者同属「两份写范围定义」这一个缺陷类 |
| 7 | PL-M12 的收敛方式 | **实现类组的路径取自对应 agent 的 `writePaths`**（单一来源），语义附加组（`DOC_PATH` / `DEVOPS_PATH` / `TEST_PATH`）保留 | 12c。可行性已核实：`apps/server` 已依赖 `@ai-se/agent-core`（`package.json:17`），`AgentRegistry` 与 `PROFESSIONAL_AGENT_DEFINITIONS` 均已导出；缺的是把 `TaskType → agent` 的映射暴露出来（现为模块私有 `TASK_AGENT_TYPES`） |
| 8 | 是否加**计划期守卫**（计划派了必须写根交付物的任务、却没人能写 → 计划期报错） | **不做** | 与 PL-M7 §4 裁定 6 / PL-M10 §4 裁定 6 同理：判据只能靠标题/描述文本匹配，脆弱且易误伤。**先把权限侧修对**，守卫的必要性会随之消失 |
| 9 | 是否顺带放行 `scripts/` / `.github/` | **不做**，只登记 | PRD 未强制 `scripts/`；E1 run 2 的 S4-01 已在无 `scripts/` 时 SUCCESS。放行目录类路径会实质扩大写范围，超出本缺陷范围 |
| 10 | 是否改 `packages/eval` 夹具（在模板里预置 `Dockerfile` / `README.md`） | **不做** | 红线（`docs/166` §6）；且预置等于**回避**缺陷——真实项目里平台仍写不出根交付物 |

**被否掉的方案（记录，避免重复推演）**：

| 方案 | 否决理由 |
| --- | --- |
| **A｜把根文件加进各 agent 的 `writePaths`** | 可行（`allowed()` 支持单文件条目），但**留下两份定义**：审计侧 `DEVOPS_PATH` 仍在，二者会再次漂移——正是本缺陷的成因 |
| **B｜把 S4-10 类任务改派 `BUILD`（→ devops-agent）** | 语义错。提示词把 `BUILD` 定义为 **CI 步骤**（「End delivery-ready plans with CI BUILD…」），实查 S4-15 的 `BUILD` 任务描述正是「在 CI 中执行完整构建契约…`docker build`」；且**非最终切片禁止计划 `BUILD`**，而根 `Dockerfile` 可能在任何切片被需要。属计划期选型（N-1b 邻域），不是本批 |
| **C｜加计划期守卫** | 见裁定 8 |
| **D｜改夹具模板预置根 `Dockerfile` / `README.md`** | 见裁定 10 |
| **E｜只做 PL-M11，不做 PL-M12** | 假阳性信号留着，下一批 `scopeViolations` 仍不可信；且 `BUILD` 类型的默认组会继续在每次 CI 任务上误报 |
| **F｜把审计改成 `writePaths` 的投影（彻底消除第二份定义）** | **会摧毁审计的信号价值**（§2.4 末段）：审计的输入是 `git status` 差集，捕得到绕过工具门的写入；投影化后它永远不可能报出强制侧没拦下的东西，等于删除该组件。故取裁定 7 的折中：**路径来源单一化，判据仍独立** |

## 5. 验证分层

| 层 | 位置（`AGENTS.md` §6 / §7） |
| --- | --- |
| 单测（谓词） | `packages/shared` 同目录混放惯例：`isRootDeliveryArtifactPath` 正反例（`Dockerfile` / `Dockerfile.dev` / `.dockerignore` / `compose.yaml` / `docker-compose.yml` / `README.md` 为真；`src/Dockerfile` / `docs/README.md` / `README.txt` / `Dockerfile.bak` / `index.js` / 空串为假）+ Windows 分隔符 |
| 单测（强制侧） | `packages/agent-core/src/professional/AgentRegistry.test.ts` 更新范围断言；`ToolRuntimeBackend.test.ts` 放行/拒绝正反例（**含 11c 的反向对照**：BACKEND 写根 `index.js` 仍拒） |
| 单测（审计侧） | `apps/server` 的 `writeScopeAudit.test.ts`：`apps/` / `backend/` / `packages/database/` 不再越界；`BUILD` 类型不再落默认组；根交付物两侧同判 |
| 单测（审计信号，**12d**） | 一条**性质测试**：构造一条「`changedPaths` 含强制侧绝不会放行的路径」→ 审计仍报越界。**这条用例是本批防止审计退化为投影的闸门** |
| 回归（注入式） | 11f：BACKEND 任务 + 写根 `Dockerfile` / 根 `README.md` → 修前 `Path is not writable`，修后放行 |
| 共享夹具核对 | 全树 grep 钉住范围的精确断言（`AGENTS.md` §7）。已知受影响的断言：`ToolRuntimeBackend.test.ts` 中 backend 的 `README.md` 拒绝消息与 devops 的写侧拒绝消息（PL-M10 刚改过，本批会**再次**改——同一提交内同步）、`AgentRegistry.test.ts` 的 `writeProjectManifests` 断言（本批新增并列断言，**不改既有那条**） |
| 门禁 | 受影响包（`shared` / `agent-core` / `server`）`typecheck && lint && test`；收尾前全仓 `corepack pnpm -r run typecheck && lint && test` |
| A/B 实测（强制） | `docs/165` §2 偏差 1 的教训：改权限面后**必须先跑** `apps/server` 的 `writeScopeAudit` / `externalEngineering.e2e` / `v1GoldenScenario.e2e` 三例做改前基线对比 |

## 6. 边界与红线

- **不新增第二套 Permission / Approval / Audit / 错误码体系**（`AGENTS.md` §10）；复用既有 `AgentPermissions` 与 `SCOPE_RULES`。
- **不放开任意根写入**：放宽严格限定为「根级交付物」，且只对实现类与构建类 agent。
- 不改 `packages/eval` 的夹具与 oracle；不改 `EvalPolicy`；不改 L1-8 判据口径。
- 不改计划期的任务类型选择与切片划分（N-1b / N-3 均维持登记）。
- 不修改历史 `tasks` / `agent_runs` / `workflow_events` 行；不回溯改写 run 2 的库数据。
- 不修改任何 `dist/`。
- **本批不跑 E1×3 批次。** L1-M4c 记「已执行 2/3、因判定已定且缺陷已定位而中止」（§8）。
- 收口时同步登记账：`docs/146` §3（**新增 N-4 行**；N-2 行的「README 属文档类、维持不修」一句须追加勘误）、`docs/146` §4（本任务书 §7 的裁定行）、`docs/146` §5（下一批开工门槛）、`docs/168`（§4 裁定 7 的**裁定变化**，按 `docs/146` §6 规则 7 以追加块形式记）、`docs/127` §6 运行环境快照、`docs/127` §5 第 11 条。

## 7. 待裁定项（每条带推荐值）

| # | 事项 | 推荐值 | 理由 |
| --- | --- | --- | --- |
| 1 | 修法形态（§4 裁定 1 的 A / F） | **共享谓词**（`@ai-se/shared` 的 `isRootDeliveryArtifactPath`，两侧共用） | 见 §4 裁定 1；与 PL-M5 / PL-M10 同形，一次解决 11a + 11b |
| 2 | 是否并入 PL-M10 的 `writeProjectManifests` | **不并入**，并列新增 | 见 §4 裁定 2：语义与口径来源都不同 |
| 3 | 授予哪些 agent | **backend / frontend / database / devops**；qa 与只读 agent 不变 | 见 §4 裁定 3 |
| 4 | 文件集合口径 | **`Dockerfile` / `Dockerfile.*` / `.dockerignore` / `compose.y*ml` / `docker-compose*.y*ml` / `README.md`（仅根级）**；不含 `scripts/` / `.github/` | 见 §4 裁定 4：逐条对齐审计侧 `DEVOPS_PATH` 的交付物条款 |
| 5 | 根 `README.md` 是否放行 | **放行**（**推翻** `docs/168` §4 裁定 7） | 见 §4 裁定 5；实测证据：AC-24 的 qa 契约测试 + AC-30 的 oracle + PRD §二.8 + 夹具 mutants |
| 6 | PL-M12 是否同批 | **同批** | 见 §4 裁定 6 |
| 7 | PL-M12 的收敛方式 | **实现类组的路径取自对应 agent 的 `writePaths`**（单一来源），语义附加组保留；**不得**把审计投影成强制侧 | 见 §4 裁定 7 与 §2.4 末段；12d 是硬闸门 |
| 8 | **L1-M4c 批次怎么记账、何时续跑** | **记「已执行 2/3、中止」**（run 1 规划阶段失败、run 2 S4 失败）；本批收尾后**另开一批** E1×3（不续跑原批，理由同 `docs/164` §7 第 4 项：避免修前/修后混批） | L1-8 判据是 staging 段 ≥ 2/3，而 run 1 / run 2 都是「否」——**run 3 最好也只有 1/3，判定已不可能翻盘**；且 run 3 走 `replan:false` 会复用同一份计划（v52），大概率在同一处再失败一次，代价约 32M 代理值（周护栏的 16%）。受周配额纪律约束（`docs/127` §8），落在下周窗口 |

## 8. 本批已发生的事实（供记账，非判据）

### 8.1 L1-M4c 批次（已执行 2/3、中止）

- 批次脚本 `packages/eval/scripts/l1-m4c-e1-x3.sh`（新增），结果目录 `packages/eval/results/l1-m4c`。合同与 `l1-m4b-e1-x3.sh` 逐字一致（`--fixtures E1 --runs 1 --autonomy-l1`，run 1 带 `--replan`，30 分钟冷却，200M 代理值止损，可续跑）。
- **run 1**：规划阶段失败（6 分钟，0 工作流，token 0）。
- **run 2**（2026-10-17 02:00–03:37，FAILED，6000270 ms）：真成功 0 / 假阳性 0 / 链完成 否 / **staging 段 否（PENDING/PENDING/-）** / 检查不可判定 2（DATABASE×2）/ 失败分层 规划 0 / 验证门 1 / agent 1 / 任务级验证分歧 1 / 规划修复 自动 22 轮、LLM 3 轮 / **输入 token 32,295,611** / 超范围写入 1。切片到达分布：`S4-deploy-ui ×1`。
- **run 2 的四条工作流**：`dc47181d`（S1-foundation）SUCCESS 12 / `c601a002`（S2-auth）SUCCESS 9 / `24be60f8`（S3-task-crud）SUCCESS 19 / **`370073af`（S4-deploy-ui）FAILED**（18 任务：SUCCESS 8 / FAILED 1 / READY 4 / PENDING 4，加前三个切片共 SUCCESS 47）。
- **run 3 未执行**（用户裁定前即中止，理由见 §7 第 8 项）。
- **PL-M10 / PL-M9 的实测结论**：PL-M10 生效（S1 12/12 SUCCESS，脚手架任务写根 `package.json` 成功——L1-M4b 的「第一个任务就判死」消失）；PL-M9 9a 生效（恰好 1 条 `TASK_CHECK_UNAVAILABLE`，载荷 `{"missing":["migrate-up","migrate-down"],"taskKey":"T-08","taskType":"DATABASE"}`，指标 `检查不可判定 2（DATABASE×2）`）；9c **未触发**且**无净损失**（4 个 TEST 任务全部 `verified`，红灯检查真的跑了）；9b **零条** `PLAN_TEST_BEFORE_SCRIPT_PROVIDER`（规划器仍未声明 `providesScripts`，本批顺序恰好正确故无碍——**仍是下一批的观察项**）。
- 周配额代理值：**86,595,149 / 200,000,000**（run 2 单轮消耗 32.3M）。

### 8.2 本批新登记的两项缺陷

- **N-4｜仓库根交付物无写权限**（本任务书的主项）：根 `Dockerfile` 与根 `README.md` 在计划里是 `BACKEND` 任务（S4-10 / S4-13）的交付物，而没有任何 agent 能写它们。机制与 N-2 同形（前缀白名单表达不了仓库根），但 PL-M10 的口径只覆盖「工程清单/配置」。
- **N-5｜审计侧路径表描述了一个不存在的布局**：`SOURCE_PATH` 列的是 `app/`（单数）/ `pages/` / `lib/` / `components/`，而本仓库顶层是 `apps/` / `packages/`。run 2 实测 `violations:["apps/"]`。不阻塞（`observe`），但污染批次指标。

### 8.3 一处口头归因的更正（自查）

我在向用户口头汇报 run 2 时把越界项说成了 `backend/`。**实查 `workflow_events` 的原文是 `apps/`**：

```
{"mode": "observe", "taskKey": "S4-10", "taskType": "BACKEND", "violations": ["apps/"], "totalChanged": 2}
```

`backend/` 从未被审计报出（backend-agent 的 `writePaths` 本来就含 `backend`，而审计的 `SOURCE_PATH` 也不含它——那是 §2.4 表里的另一格）。**结论方向不变，具体路径以本文件为准。**
