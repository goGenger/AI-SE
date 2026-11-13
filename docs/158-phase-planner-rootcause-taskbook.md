# 158 · 计划器根因修复任务书：红测试必须有实现任务

> 状态：**PL-M5 / PL-M6 已于 2026-10-16 实施完成（`docs/159`）；PL-M1 已于同日实施完成（`docs/160`）；PL-M2 / PL-M3 已于同日实施完成（`docs/161`）；PL-M4 未开工。**（2026-10-16 追加）PL-M4 已执行 1/3 并中止**——run 1 跑完（staging 段 否、链止于 slice-1），暴露**切片外红测试致败**这一确定性缺陷；runs 2/3 经用户裁定**不跑**。该缺陷由 **PL-M7 / PL-M8** 修复，**另立任务书 `docs/164`、记录 `docs/165`**，**不在本任务书范围内**；本任务书至此全部实施完毕，**PL-M4 记「已执行 1/3、因发现确定性缺陷中止」，修完另开一批**。 用户 2026-10-16 裁定「记未达成 + 归因，**修根因另立项**」（`docs/146` §3 已登记为「待立项」），同日质询「沙箱写范围与离线依赖不是更重要吗」→ 复核后接受，把两项并入本任务书为**并列里程碑 PL-M5 / PL-M6**，并授权「把沙箱能力修复好」；同日「开工 PL-M1」授权核心里程碑；同日「接着开工 PL-M2 和 PL-M3」授权两项纵深里程碑。
> 编号：里程碑 **PL-M1 … PL-M6**；本任务书**不新造验收编号**——PL-M1 … PL-M3 修复的是缺陷、PL-M5 / PL-M6 修的是平台边界，都不是新增验收项，L1-8 的判定沿用 `docs/17` 原文。
> 依据：`docs/155` M4 追加块（归因正本）、`docs/154` §5（「不因批次未达而否定 M1–M3」）、`docs/17` 节「自治 L1」（L1-8 判据）、`docs/146` §6 规则 7/8、`AGENTS.md` §9。
> 性质：**本文件是改动方案。** PL-M5 / PL-M6 已获授权实施（见上）；**PL-M1 … PL-M4 仍不构成开工授权**（`docs/146` §0：裁定 ≠ 开工授权）。

## 1. 为什么这样排：基线事实（2026-10-16 代码核对 + 数据核对）

### 1.1 机制：TEST 任务的验证检查是「红灯检查」

| 事项 | 现状（代码核对） | 证据 |
| --- | --- | --- |
| TEST 任务的检查期望 | **期望命令失败**（`expectation: "fail"`）——「写测试后先跑出失败」 | `apps/server/src/services/taskVerifierRules.ts:95-100` |
| 红灯检查「过了」的含义 | 测试确实红了 → 检查通过 → **任务判 SUCCESS** | 同上；`taskVerifierRules.ts:34-43` |
| 红灯检查「空转」的含义 | 测试没红（一写就绿）→ 判 `VACUOUS_TEST` → 任务 FAILED | `apps/server/src/services/taskVerifier.ts:362-371` |
| 各类型候选检查 | `BACKEND:[build,test]`、`FRONTEND:[build,lint]`、`TEST:[test]`、`BUILD:[build]` | `taskVerifierRules.ts:49-54` |

**这条设计本身是对的**（测试先行要求先见红）。它的**隐含前提**是：计划里存在一个后续实现任务，把这个红灯**转绿**。本任务书的根因就是——**没有任何东西保证那个实现任务存在**。

### 1.2 缺口：三个计划期校验器都不要求实现任务

| 校验器 | 它要求什么 | 为什么放行了缺陷计划 |
| --- | --- | --- |
| `validateAcceptanceCoverage` | 每个切片范围内的 AC 至少被**任意**一个任务的 `acKeys` 引用 | `referenced` 集合**不分任务类型**收集（`validateAcceptanceCoverage.ts:28-36`）——TEST 任务算数 |
| `validateMustAcTestCoverage` | 每个 Must AC 至少被一个 **TEST** 任务引用 | 它**只要测试**（`validateTestFirstPlan.ts:100-122`）——这个校验器强化了缺口 |
| `validateTestFirstOrder` | **实现任务**与 TEST 任务覆盖相同 AC 时，实现任务必须（传递）依赖 TEST 任务 | 它只遍历**实现类任务**（`validateTestFirstPlan.ts:72-73`）；没有实现任务时循环不执行，**空转通过** |

三者的错误汇入同一个数组 `errors[]`（`packages/agent-core/src/planning/PlanningGraph.ts:524-532`），为空即接受计划。

**结论：系统**主动要求**测试任务，却**从不要求**实现任务。** 这是「红测试永远红」在计划期的充分条件。

### 1.3 后果：切片的「绿灯保证」也锚在实现任务上

| 事项 | 现状 | 证据 |
| --- | --- | --- |
| 切片边界检查 | 该切片**最后一个实现任务**完成时，跑该切片涉及 AC 的全部测试（期望**通过**） | `apps/server/src/services/taskVerifier.ts:819-844` |
| 锚点判定 | `isDevTaskType(task.type)`——只认 `BACKEND` / `FRONTEND` / `DATABASE` / `DEBUG` | `taskVerifier.ts:829`、`taskVerifierRules.ts:46` |

**一个只有 TEST 任务的切片没有实现任务可作锚点 → 边界绿灯检查永不触发。** 交付链因此一路走到 CI 才炸。

### 1.4 数据：run 1 与 run 3 死在同一处，证据到 AC 粒度

E1 的**每个切片是一个独立 workflow run**（链式推进）。两次运行的前四切片全 SUCCESS，**都死在 slice-5**：

| 运行 | slice-1 | slice-2 | slice-3 | slice-4 | **slice-5** |
| --- | --- | --- | --- | --- | --- |
| run 1 | `858a8771` SUCCESS | `252f17db` SUCCESS | `b5a190ad` SUCCESS | `dab6d9b3` SUCCESS | **`e2037844` FAILED** |
| run 3 | `e07771d6` SUCCESS | `8ad8d70f` SUCCESS | `f9ebe026` SUCCESS | `58659e2c` SUCCESS | **`e6c513e1` FAILED** |

run 3 的 slice-5（`e6c513e1`）任务全表（15 个，编号 `TASK-01…19` 中**缺 04 / 05 / 06 / 13**）：

| 任务 | 类型 | 状态 | AC |
| --- | --- | --- | --- |
| TASK-07/08/09/10 | BACKEND | SUCCESS | AC-19/20/27/28 |
| TASK-14 | TEST | SUCCESS | AC-19/20/27/28 |
| **TASK-15** | **TEST** | SUCCESS | **AC-24/25/26/29** |
| **TASK-16** | **TEST** | SUCCESS | **AC-30** |
| TASK-12 | BUILD（CI） | **FAILED** | AC-30 |
| TASK-17/18/19 | DEPLOY | PENDING | AC-24 / AC-25/26/29 / — |

**逐 AC 核对实现覆盖**（实现类 = `BACKEND`/`FRONTEND`/`DATABASE`）：

| AC | TEST 覆盖 | 实现覆盖 | 判定 |
| --- | --- | --- | --- |
| AC-19 / 20 / 27 / 28 | TASK-14 | **TASK-07/08/09/10** | ✅ 正常（TASK-14 与它们共享 AC，`validateTestFirstOrder` 生效） |
| **AC-24 / 25 / 26 / 29** | TASK-15 | **无** | ❌ 只有 DEPLOY 任务（TASK-17/18）——不是实现 |
| **AC-30** | TASK-16 | **无** | ❌ 只有 CI 任务（TASK-12） |

**缺的 `TASK-04/05/06/13` 正是这批 AC 的实现任务**（产出 `Dockerfile` 与真实 `README.md`）。三次运行的规划修复计数为 **自动 0 轮 / LLM 0 轮 / 切片校验失败 0 轮，首轮通过率 100%**（`packages/eval/results/l1-m4/run-3-summary.md:12`）——**计划一次通过校验，修复轮从未被触发**，与 §1.2 的缺口完全吻合。

后果链：红测试在切片内判 SUCCESS → 无实现任务把它转绿 → 切片边界绿灯检查无锚点、不触发 → CI（期望绿灯）在 `pnpm test` 失败（工作区实跑复现 235 测试 / 15 失败 / 退出码 1，`docs/155` M4 块）→ `TASK-12` FAILED → staging DEPLOY 停在 PENDING → **staging 段 = 否**。

### 1.5 附带发现（本次核对新得，`docs/155` 未记）

| 发现 | 事实 | 证据 |
| --- | --- | --- |
| **`fixTaskType` 无类型合法性校验** | `debugTargetType` 把 `fixTaskType` 字符串**直接断言**为 `Task["type"]`（`as Task["type"]`）。而 `TaskType` 枚举里**没有 `IMPLEMENTATION`**（只有 `ANALYSIS/DESIGN/DATABASE/BACKEND/FRONTEND/TEST/REVIEW/DEBUG/BUILD/DEPLOY/MONITOR/INCIDENT`）。若真按此创建修复任务，会落到「无专业 agent」的瞬失败——正是 `validateTaskGraph.ts:22-27` 记录过的那类事故 | `packages/workflow-engine/src/WorkflowEngine.ts:39-49`；`packages/shared/src/index.ts:466-479` |
| **run 2 的根因不是计划缺陷** | run 2 死在 slice-1 的 T2（TEST）。其 `output.issues` 明写：沙箱对该 agent **拒绝全部写入**（`write_file` 返回 `"Path is not writable"`），测试文件建不起来，`outcome: RETRY`、`fixTaskType: ENVIRONMENT_WRITE_ACCESS`，19 轮后放弃。原因是 QA agent 的写范围只含 `test`/`tests`/`__tests__`，而它试的是 `src/test/…` | `packages/agent-core/src/professional/AgentRegistry.ts:104-114`（`writePaths: ["test","tests","__tests__"]`） |
| **写入拒绝不留工具调用记录** | `ToolRuntimeBackend.write()` 在**调用 `executeTool` 之前**就因白名单返回错误，故 `tool_calls` 表**没有行**——本次核对该 agent run 的 14 条文件类工具调用里**零条 `write_file`**，只能靠 `output.issues` 的叙述还原 | `packages/agent-core/src/professional/ToolRuntimeBackend.ts:62-72,139-147` |

> **对 `docs/155` M4 块的更正**：该块把 run 2 记为「稳定复现的失败」并计入分母——**结论（计入分母、不作废）不变**，但**成因描述需补**：它不是计划缺陷，也不是瞬时抖动，而是**确定性的沙箱写权限拒绝**。本任务书 §1.5 是更正依据，`docs/155` 按「历史记录冻结、勘误只追加」处理（`docs/146` §6 规则 7）。

### 1.6 沙箱边界（PL-M5 / PL-M6 的基线事实，2026-10-16 代码核对）

| 事项 | 现状（代码核对） | 证据 |
| --- | --- | --- |
| agent 的写入落在哪 | **沙箱内执行**——`write_file` 拼一条 shell 命令交给 `context.sandbox.runCommand`；工作区是宿主机目录挂进容器 | `packages/tool-runtime/src/tools/fileTools.ts:73-85` |
| agent 的测试运行落在哪 | **沙箱内**——`run_unit_test` 走 `runSandboxCommand` | `packages/tool-runtime/src/tools/commandTools.ts:152-157` |
| 沙箱默认网络 | **`network: "none"`**，且**没有配置开关**（`config.ts` 只有 `SANDBOX_IMAGE`） | `packages/sandbox/src/index.ts:49-55`、`apps/server/src/config.ts:27-29` |
| 镜像里有什么 | 只有**真实 pnpm 9.15.0 二进制**（构建期 `npm i -g`）；**无 registry、无离线 store** | `packages/sandbox/Dockerfile` |
| 交付链的 CI 落在哪 | **宿主机 `spawn` + `process.env`，不经沙箱**——CI 那一步**有宿主网络** | `apps/server/src/services/deliveryAdapters.ts:13-36,151` |
| QA agent 的写范围 | `["test", "tests", "__tests__"]`——**相对仓库根的前缀匹配** | `packages/agent-core/src/professional/AgentRegistry.ts:104-114` |
| 前缀匹配语义 | `relative === prefix \|\| relative.startsWith(prefix + "/")` | `packages/agent-core/src/professional/ToolRuntimeBackend.ts:62-72` |

**两条边界的准确表述**（比我先前的说法更窄，也更准）：

- **PL-M5**：`allowed("src/__tests__/x.test.ts", ["test","tests","__tests__"]) === false`。**本仓库自己的规范**就是测试放 `apps/web/src/__tests__/`、`packages/*/src/__tests__/`（`AGENTS.md` §5/§6）——**平台交付不出「按它自己规范布局的项目」**。E1 把测试放根目录 `test/`，恰好躲过。既有测试只覆盖了 code-writing 三个职业（`AgentRegistry.test.ts:48-56`），**qa-agent 这一格没覆盖**。
- **PL-M6**：agent 与**验证门**都在沙箱内跑测试，沙箱无 registry 且无离线 store → 带第三方依赖的项目**装不上、测不了**。注意 CI 那一步在宿主机、**能联网**——所以缺的不是「整条链不能装依赖」，而是**agent 与验证门不能**；结果仍是交付链失败，但定位不同。

**九个评测夹具全部零依赖**（`E1/L1/L2/M1/M2/M3/S1/S2/S3` 的 `dependencies` 均为空），E1 的 PRD 第 1 条更**明写要求零依赖**（「仅用 Node 标准库，零运行时依赖」）。因此：① 平台今天能交付的上限是标准库项目；② **评测体系测不出这条边界**——修好 PL-M6 之后，也**没有任何夹具能验证它**（见 §3 PL-M6 的验收办法）。

## 2. 范围与里程碑

| 里程碑 | 内容 | 出口 | 依赖 |
| --- | --- | --- | --- |
| **PL-M5 沙箱写范围**（平台边界） | QA 类 agent 必须能写**项目实际放测试的地方**；拒绝必须可发现、可审计 | 真沙箱用例：QA agent 能写 `src/__tests__/x.test.ts`；写非测试文件仍被拒；每次拒绝留一条工具调用记录 | 无 |
| **PL-M6 沙箱离线依赖 store**（平台边界） | 镜像构建期预热 pnpm store，使**带第三方依赖**的项目能在 `network: none` 下 `pnpm install` | 现有反向对照用例（`sandboxPnpm.e2e.test.ts` 用例 c）**翻转为通过** | 无（与 PL-M5 并行） |
| **PL-M1 计划期实现覆盖校验**（核心） | 新增校验器：切片范围内的 AC **不能只被 TEST 任务覆盖**，必须有实现类任务引用它 | 用 run 3 的 slice-5 计划**离线复现**：新校验器报出 AC-24/25/26/29/30 无实现覆盖；修前的三个校验器对该计划零报错 | 无 |
| **PL-M2 切片边界绿灯锚点** | 把 `maybeSliceBoundaryCheck` 的锚点从「最后一个实现任务」放宽为「切片最后一个任务」，使**只有 TEST 任务的切片**也触发边界绿灯检查 | 注入式用例：一个只有 TEST 任务的切片，边界检查触发并因红灯未转绿而判失败 | 无（与 PL-M1 互为纵深） |
| **PL-M3 修复任务类型合法性** | `debugTargetType` 不得把任意字符串当 `Task["type"]`；非法值回退到源任务的工作类型并记事件 | 用例：`fixTaskType: "IMPLEMENTATION"` 不再产出无 agent 的任务 | 无 |
| **PL-M4 批次复验** | E1×3 重跑，判据沿用 `docs/17` L1-8（staging 段 ≥ 2/3） | 见 §5 | PL-M1 … PL-M3；**需配额确认** |

**执行顺序（2026-10-16 用户裁定）**：**PL-M5 → PL-M6 → PL-M1 → PL-M2 → PL-M3 → PL-M4**。理由：PL-M5 / PL-M6 是**平台边界**（决定这平台能交付什么），用户判定其优先于交付链堵点；PL-M1 / PL-M2 / PL-M3 是让现有窄路真正跑通；PL-M4 消耗真实配额，排最后。**PL-M5 与 PL-M6 互不依赖，可同批实施。**

**本阶段不做**：L1-8 的判据口径（不改，沿用 `docs/17`）；L2 / L3；重写计划器提示词；引入第二套校验/修复体系；`deliveredSuccess`（已裁定弃用）。

**PL-M4 的成本**：E1×3 是真实模型批次（M4 实测 **6,677,325 输入 token**）。**排在最后**，不构成 PL-M1 … PL-M3 的开工阻塞。

## 3. 任务明细

> 组织方式：PL-M1 … PL-M3 按 `docs/17` 的验收项编号逐条给改动，不新造编号；**PL-M5 / PL-M6 是平台边界修复**（不属 `docs/17` 任何验收项），自带出口判据。

### PL-M5 沙箱写范围（平台边界）

- **目标**：以写测试为职责的 agent，必须能写**项目实际放测试的地方**；被拒时必须**知道为什么被拒、能往哪写**，且拒绝**留痕**。
- **改动**：
  1. `packages/shared/src/index.ts` 新增 `isTestFilePath(relPath): boolean`——**唯一**的「这是不是测试文件」判据：文件名匹配 `*.test.*` / `*.spec.*`，或路径中出现 `test` / `tests` / `__tests__` 段（排除 `node_modules` / `.git` / `dist` / `coverage` / `.next`）。**该判据已存在于 `apps/server/src/services/taskVerifierRules.ts:106-120`（`isProtectedTestPath`），本次把它上移到 shared、`apps/server` 改为消费它**——两份定义必然漂移，而漂移正是本缺陷的成因类型。
  2. `packages/agent-core/src/professional/AgentRegistry.ts` 的 `AgentPermissions` 新增**可选** `writeTestFiles?: boolean`；`qa-agent` 置为 `true`。**其余 agent 一律不置**——缺省即现状。
  3. `packages/agent-core/src/professional/ToolRuntimeBackend.ts` 的 `write` / `edit`：放行条件改为 `allowed(path, writePaths) || (writeTestFiles && isTestFilePath(path))`。
  4. **拒绝可发现**：拒绝信息带上允许的范围（如 `Path is not writable (allowed: test/, tests/, __tests__/, and test files anywhere)`）。
  5. **拒绝留痕**：拒绝走与 `executeTool` 同一条记录通道——发同样的 `tool_call_started` / `tool_call_finished` 事件、push 一条失败的 `ToolResult` 进 `results`、并调 `toolCallRecorder` 落 `tool_calls`。
- **落点**：`packages/shared/src/index.ts` + `testFilePath.test.ts`；`packages/agent-core/src/professional/{AgentRegistry,ToolRuntimeBackend}.ts` + 各自测试；`apps/server/src/services/taskVerifierRules.ts`（改为消费 shared 版）。
- **判据**：
  - QA agent 能写 `src/__tests__/x.test.ts`、`apps/web/src/__tests__/y.test.ts`、根 `test/z.test.js`；
  - QA agent **仍不能**写 `src/server.ts`、`probe.txt`（非测试文件）——**不放宽到「可写任意路径」**；
  - 非 QA agent（如 backend-agent）行为**逐项不变**（`writeTestFiles` 缺省为假）；
  - 拒绝时：错误信息含允许范围；`results` 与 `tool_calls` 各多一条失败记录。
- **红线**：**不得放宽任何 agent 的 `writePaths` 白名单**；本项只增加一条**语义化**放行条件（「测试文件」），且只对显式声明的 agent 生效。QA 的 `writePaths` 原值保留不动。

### PL-M6 沙箱离线依赖 store（平台边界）

- **目标**：带第三方依赖的项目，能在 `network: "none"` 下完成 `pnpm install`。
- **改动**：
  1. `packages/sandbox/Dockerfile`：构建期**预热 pnpm store**（构建期**有网**，运行期无网）。预热清单用 `ARG PREWARM_PACKAGES`（见 §6 第 6 项），默认一组常用包；`pnpm config set store-dir` 指向镜像内固定路径。
  2. `packages/sandbox/package.json` 的 `build:image` 脚本透传该 build arg。
  3. `packages/sandbox/src/__tests__/sandboxPnpm.e2e.test.ts`：**把现有反向对照用例 (c) 翻转为通过**（它已断言「带 lodash 的夹具离线安装失败」——修好后应成功），并**新增**一条「未预热的包仍失败」的对照，证明边界仍在、不是把网络打开了。
- **落点**：`packages/sandbox/Dockerfile`、`packages/sandbox/package.json`、`packages/sandbox/src/__tests__/sandboxPnpm.e2e.test.ts`。
- **判据**：
  - 预热清单内的依赖：`pnpm install --frozen-lockfile` 在 `network: none` 下 exit 0，且 `node_modules` 里确有该包；
  - 预热清单**外**的依赖：仍失败（证明是 store 生效，不是网络被打开）；
  - 沙箱默认 `network` **仍是 `"none"`**（`DEFAULT_LIMITS` 不改）。
- **不做（本阶段边界）**：**不新增带第三方依赖的评测夹具**。E1 级夹具需要 PRD + oracle + 参考实现 + mutants，本身是一个独立阶段；本项只交付**镜像能力**与真 Docker 验收。**新夹具另立项**（§6 第 7 项）。
- **红线**：不把沙箱默认网络从 `none` 改成 `bridge`；不引入运行时 registry 代理。

### PL-M1 计划期实现覆盖校验（核心）

- **目标**：计划期就拦下「红测试没有实现任务」的计划，交给既有修复轮重规划。
- **改动**：
  1. 新增 `packages/agent-core/src/planning/validateImplementationCoverage.ts`：对切片范围内的 AC（粒度见 §6 第 1 项），要求至少一个 `BACKEND`/`FRONTEND`/`DATABASE` 任务引用它。与 `validateMustAcTestCoverage` **同构**（同样的 `selectAcceptanceCriteriaForSlice` 作用域、同样的「criteria 为空则跳过」退路）。
  2. 错误汇入 `PlanningGraph.ts:524-532` 的 `errors[]`——**不新建第二套校验通道**。
  3. 新校验器**只报错、不自动造任务**（见 §6 第 3 项）。
- **落点**：`packages/agent-core/src/planning/validateImplementationCoverage.ts` + `.test.ts`；`PlanningGraph.ts` 接线。
- **判据**：
  - 单测：AC 仅被 TEST 覆盖 → 报错；AC 被 TEST + 实现覆盖 → 不报错；`criteria` 为空 → 不报错（保持既有行为）；非最终切片/最终切片的全局 AC 归属规则沿用既有 `selectAcceptanceCriteriaForSlice` 语义。
  - **回归复现**：把 run 3 的 slice-5 计划（15 个任务、含 TASK-15/16 的 acKeys）作为 fixture 喂给校验链，断言**修前零报错、修后报出 AC-24/25/26/29/30**。
- **风险**：新校验会让**一部分既有计划**开始报错（这是目的），但若报错面过宽会拖垮修复轮。缓解：先只对 **Must AC** 生效（§6 第 1 项推荐值），并用全仓既有 planning 测试核对不回归。

### PL-M2 切片边界绿灯锚点

- **目标**：即使某个切片只有 TEST 任务，也要在切片收尾时证明「该切片涉及的测试已转绿」。
- **改动**：`taskVerifier.ts:829` 的 `isDevTaskType(task.type)` 守卫与 `:839-844` 的 `sliceDev` 过滤，改为「切片内最后一个任务」而非「最后一个实现任务」；AC 取值来源相应放宽（现在只从 dev 任务取 `input.acKeys`，`taskVerifier.ts:846-857`）。
- **判据**：注入式用例——构造一个只有 TEST 任务的切片，断言边界检查**触发**，且因测试仍红而判失败（`expectation: "pass"`）。
- **红线**：该检查仍是**既有**的 `slice-boundary` 检查名与既有判定分支，不新增检查种类（`taskVerifierRules.ts:199-201`）。

### PL-M3 修复任务类型合法性

- **目标**：修复任务的类型必须落在 `TaskType` 枚举内，否则会创建无人可执行的任务。
- **改动**：`WorkflowEngine.ts:39-49` 的 `debugTargetType`——`fixTaskType` 先对 `TaskTypeSchema.options` 做成员判定，非法值**回退到源任务的工作类型**（既有 `source.input.targetTaskType` 分支），并写一条既有通道的事件说明回退原因。
- **判据**：用例——`fixTaskType: "IMPLEMENTATION"` → 回退，且不产生 `type` 不在枚举内的任务；合法值（如 `"BACKEND"`）行为不变。
- **注**：`docs/155` M4 块记录的「产出摘要明写 `fixTaskType: IMPLEMENTATION`」正是这个非法值。**它当时没造成事故**，因为那三个 TEST 任务被判 SUCCESS、没走失败分支——**但这是运气，不是设计**。

### PL-M4 批次复验

- **目标**：修复后重跑 E1×3，判据 `docs/17` L1-8（staging 段含 VERIFY 成功 **≥ 2/3**）。
- **改动**：无代码改动（`packages/eval` 的 staging 段指标已在 M4 交付）；跑批次并归档。
- **判据**：≥ 2/3 即达成；未达则**如实记录并归因**，不伪装。
- **成本**：真实模型批次，**开工前向用户确认配额余量**。
- **前提**：§6 第 2 项——**若不修 run 2 那类缺陷，重跑仍可能在 slice-1 死**。

## 4. 验证分层

| 层 | 内容 | 位置（`AGENTS.md` §6 / §7） |
| --- | --- | --- |
| 单元 | 新校验器的判定矩阵、`debugTargetType` 的类型合法性 | `packages/agent-core/src/planning/*.test.ts`（同目录惯例）、`packages/workflow-engine/src/WorkflowEngine.test.ts` |
| 回归复现 | run 3 slice-5 计划 fixture 走完整校验链 | `packages/agent-core/src/planning/`（fixture 形态参照既有 `r1Fixture.ts` / `s1v4Fixture.ts`） |
| 集成 | 切片边界锚点、修复任务类型 | `apps/server/src/__tests__/*.test.ts` |
| 批次 | staging 段成功率 | `packages/eval`，产物落 `packages/eval/results/` |

门禁：`corepack pnpm --filter @ai-se/agent-core typecheck && lint && test`（涉及 `workflow-engine` / `server` 时各包同样跑）；收尾跑全仓 `-r`。**按事实逐次记录全仓 `-r test` 结果**（`docs/146` §5 现行口径：既可能一次跑通，也可能出现时序敏感偶发失败）。

## 5. 退出条件

- **PL-M5 / PL-M6 全绿**（判据见 §3 各自条目），且沙箱默认 `network` 仍为 `"none"`；
- PL-M1 … PL-M3 全绿，且**回归复现**用例在修前/修后行为相反（这是 PL-M1 的核心判据）；
- PL-M4 执行完毕，`docs/17` 的 L1-8 **按实测结果**回填（达成才勾）；
- 新增一份实施记录（形态同 `docs/155`）；
- `docs/155` 追加**勘误块**（§1.5 对 run 2 成因的更正；按 `docs/146` §6 规则 7「历史记录冻结、勘误只追加」）；
- `docs/146` §3 的「待立项」改为「已立项 `docs/158`」；**沙箱离线依赖那行由「已登记（长期限制）」按实测结果改写**；§1 / §5 同步；`docs/127` §0 / §5 #8 / §9 同步（#8 那条长期限制**必须按 PL-M6 的实测边界重写**，不能停留在旧表述）；
- **PL-M4 未达 ≥ 2/3 时**：如实记录 PASS-PARTIAL 并归因，不伪装，也不因批次未达而否定 PL-M1 … PL-M3。

## 6. 待裁定项（每条带推荐值）

| # | 事项 | 选项 | 推荐 |
| --- | --- | --- | --- |
| 1 | **新校验器的粒度**：要求实现覆盖的是哪些 AC？ | A. 切片范围内**每个 Must AC**；B. 切片范围内**每个 AC**（含 Should/Could）；C. 只要求「每个 TEST 任务至少有一个实现任务与它共享 AC」 | **A**。与 `validateMustAcTestCoverage` **严格对称**（它管 Must 的测试覆盖，新校验器管 Must 的实现覆盖），两条合起来才闭环；B 会把 Should/Could 也变成硬门，报错面过宽；C 只堵住「红测试」这一条路径，而 AC 无实现覆盖本身就是缺陷（哪怕没有对应 TEST 任务）。**已按 A 落地（PL-M1，`docs/160`）** |
| 2 | **run 2 那类缺陷（QA agent 写范围）是否纳入本阶段？** | A. 纳入；B. 只登记，另立项；C. 不做 | **A —— 已裁定纳入，并**扩大**为 PL-M5**（2026-10-16 用户「把 1/2 补进 docs/158 作为并列里程碑」）。**范围比最初设想大**：原推荐只改错误信息 + 落一条记录；核对代码后发现**白名单本身就不对**——QA 只能写根目录 `test/`，写不进 `src/__tests__/`，而后者正是本仓库自己的规范。故 PL-M5 同时修「能不能写」与「拒绝可不可见」 |
| 3 | **PL-M1 报错后怎么办**：自动补任务 vs 交修复轮？ | A. 只报错，交给既有 **LLM 修复轮**重规划；B. 在 `autoFixTaskPlan` 里确定性补出缺失的实现任务 | **A**。`autoFixTaskPlan` 的白名单明确写着「**不增删任务**、不改 AC 映射」（`PlanningGraph.ts:443-445`）——确定性层凭空造出一个实现任务，等于让机械层做内容生成，越界；而修复轮本就是为这类重规划存在的（`prompts/repair.prompt.ts`）。**已按 A 落地（PL-M1，`docs/160`）；修复轮的收敛性属 PL-M4 的观测面** |
| 4 | **`fixTaskType` 非法值的处置** | A. 回退到源任务的工作类型 + 记事件；B. 直接让任务失败 | **A**。B 会把一个**可恢复**的类型标注错误升级成任务失败，而 `debugTargetType` 的既有回退分支（`source.input.targetTaskType`）已经是同一个思路，A 只是把它扩到「非法值」这一类。**已按 A 落地（PL-M3，`docs/161`）；范围细化为「枚举外 + 运行期专属类型（DEBUG/MONITOR/INCIDENT）」都回退** |
| 5 | **PL-M4 是否与 PL-M1 … PL-M3 同批开工** | A. 前三项先做完、门禁全绿后再确认配额跑批次；B. 一起排 | **A**。批次消耗真实配额且历史量级 6.7M 输入 token，没有理由在修复未验证前先花 |
| 6 | **PL-M6 的预热清单**（镜像里预置哪些包） | A. 固定一组常用包（如 `lodash`、`express`、`zod`、`vitest`），用 `ARG PREWARM_PACKAGES` 可覆盖；B. 只预置验收要用的那一个（`lodash`），其余按需重建镜像；C. 不预置，改为运行期联网 | **A**。B 会让镜像「为了通过测试而通过测试」，能力名不副实；C 直接违反 `docs/127` 已定的「默认断网」方向。A 的代价是镜像变大，但**清单显式声明、可覆盖、可审计**，且构建期有网、运行期无网的分工不变 |
| 7 | **带第三方依赖的评测夹具**（PL-M6 建好能力后，谁来验它） | A. 另立一个阶段专门做（PRD + oracle + 参考实现 + mutants）；B. 本阶段顺手加一个最小夹具；C. 不做，只留沙箱级验收 | **A**。本阶段只交付**镜像能力** + 真 Docker 验收（`sandboxPnpm.e2e.test.ts`），这已足够证明能力成立；而 E1 级夹具是**一个独立阶段的量级**，顺手做出来的东西既验不了交付链也进不了评测口径。**注意这是本任务书唯一一处「修了能力但评测面仍覆盖不到」的缺口，必须如实对外** |

**未决项：§6 第 5、7 项待裁定**（第 1、3 项已按推荐值 A 落地于 PL-M1，见 `docs/160`；第 2 项已于 2026-10-16 裁定为「纳入」，落地形态见 PL-M5；第 4 项已按推荐值 A 落地于 PL-M3，见 `docs/161`；第 6 项已按推荐值 A 落地于 PL-M6）。裁定后才具备开工条件。

**2026-10-16 用户裁定**：①「把 1/2 补进 docs/158 作为并列里程碑」——PL-M5 / PL-M6 已并入本任务书，执行顺序见 §2；②「然后把沙箱能力修复好」——**授权实施 PL-M5 与 PL-M6**（已完成，`docs/159`）；③「开工 PL-M1」——**授权实施核心里程碑 PL-M1**（已完成，`docs/160`）；④「接着开工 PL-M2 和 PL-M3」——**授权实施两项纵深里程碑**（已完成，`docs/161`；其中 §6 第 4 项按推荐值 A 落地）。**PL-M4 仍不构成开工授权**（`docs/146` §0：裁定 ≠ 开工授权），且**开工前须确认周配额余量**。

## 7. 红线

- **不改 L1-8 的判据口径**：staging 段 = CI 成功 ∧ staging DEPLOY 成功 ∧ staging VERIFY 成功，≥ 2/3（`docs/17` + 2026-10-15 裁定弃用 `deliveredSuccess`）。
- **不放宽任何权限白名单**：PL-M5 只增加一条**语义化**放行条件（「测试文件」）且只对显式声明 `writeTestFiles` 的 agent 生效；**不得**扩大任何 agent 的 `writePaths` 数组。
- **不把沙箱默认网络打开**：`DEFAULT_LIMITS.network` 保持 `"none"`；PL-M6 靠**镜像内预热 store**，不靠运行期联网。
- Tool Runtime 是唯一执行路径；**不新增第二套** Permission / Approval / Audit / 错误码体系——PL-M5 的「拒绝留痕」必须走**既有**的 `onToolEvent` + `ToolCallRecorder` 通道，不新开记录面。
- **不新建第二套校验/修复通道**：新校验器必须汇入既有 `errors[]`（`PlanningGraph.ts:524`）。
- 观测与决策记录**只增不改**：不修改既有事件类型与既有 payload 形状（`docs/152` OB-10）。
- **历史记录冻结**：`docs/155` 的 M4 块**不重写任何一行**，更正只以追加勘误块的形式落。
- 不修改任何 `dist/`；不做运行期重启实验（沿用 `docs/145` 的后端边界）。

## 8. 与其它阶段的关系

| 依赖 | 状态 |
| --- | --- |
| `docs/155` M4 追加块（归因正本）→ 本任务书的 §1.4 | **已交付** |
| `packages/eval` staging 段指标（M4 交付）→ PL-M4 的判据面 | **已交付** |
| `docs/146` §3「待立项」登记 → 本任务书是其立项文件 | **已登记** |
| `docs/17` L1-8（判据正本） | 不变 |
| 沙箱离线依赖（`docs/146` §3「已登记（长期限制）」；`docs/127` §5 #8） | **本任务书 PL-M6 处理它**——修完须按实测边界重写那两处登记，不能停留在「只能交付零依赖项目」的旧表述 |

## 9. 审阅轮记录

- 2026-10-16 草案 v1：待审阅。**未开工。** §6 五项待裁定（均带推荐值）。
- 2026-10-16 立项依据：用户裁定「记未达成 + 归因，修根因另立项」（`docs/155` M4 块）。
- 2026-10-16 本次核对新增的三条事实（§1.5）：`fixTaskType` 无类型合法性校验、run 2 的真实成因（沙箱写拒绝）、写入拒绝不留工具调用记录——**均系本任务书起草时的代码与数据核对所得，非 `docs/155` 原文**。
- 2026-10-16 用户质询「沙箱写范围与离线依赖不是更重要吗」→ 复核后**接受该判断**：① 写范围**不只是错误信息问题**，白名单本身与本仓库规范冲突（§1.6），故由原 PL-M3b 扩大为 **PL-M5**；② 离线依赖**九个夹具全部零依赖、E1 的 PRD 明写要求零依赖**，平台可交付上限被压到标准库项目，故立 **PL-M6**。两项并入本任务书为并列里程碑，**执行顺序提到最前**（§2）。
- 2026-10-16 用户裁定：**「把 1/2 补进 docs/158 作为并列里程碑，然后把沙箱能力修复好」** → PL-M5 / PL-M6 已并入并**授权实施**；§6 第 6、7 项为本轮新增待裁定项（预热清单、新夹具归属），推荐值见该表。
- 2026-10-16 **PL-M5 / PL-M6 实施完成**（实施记录 **`docs/159`**）：PL-M5 判据上移 `@ai-se/shared`（`isTestFilePath`）、QA agent 新增可选 `writeTestFiles`、拒绝可发现且留痕；PL-M6 镜像构建期预热 pnpm store（`ARG PREWARM_PACKAGES`），真 Docker 实测清单内依赖离线可装、清单外仍失败。**实施中的两处细化**：① `frontendTask.e2e.test.ts:283` 的既有断言「被拒的写入不产生 Tool Call 记录」与 PL-M5 **直接冲突**，按**原意图**（「没有任何一次写入成功执行」+ 磁盘未变）改写；② §6 第 6 项的预热清单按推荐值 A 落地（固定一组常用包，可覆盖）。
- 2026-10-16 **PL-M1 实施完成**（实施记录 **`docs/160`**）：新增 `validateImplementationCoverage`（切片范围内每个 Must AC 必须有实现类任务引用），汇入既有 `errors[]`、只报错不造任务；`IMPLEMENTATION_TYPES` 由 `validateTestFirstPlan.ts` 导出共用。**核心判据达成**：run 3 slice-5 真实计划（新增夹具 `slice5Run3Fixture.ts`，库中实值）**修前三个既有校验器零报错、修后报出 AC-24/25/26/29/30**。**实施中的一处既有断言改动**：`planningFinalSliceScale.test.ts` 的 `bigPlan()` / `smallPlan()` **编码了与 run 3 同一个缺口**（全局性 AC 只被 TEST/BUILD 引用、无实现任务），新校验器上线即拦下——按「夹具是错的」处理，各补一个 BACKEND 任务，规模断言随之 5→6、3→4。
- 2026-10-16 **PL-M2 / PL-M3 实施完成**（实施记录 **`docs/161`**）：PL-M2 把切片边界检查的**锚点**从「最后一个实现任务」放宽为「最后一个经验证门的任务」、**AC 范围**从「实现任务的 AC」放宽为「切片全部任务的 AC」——核对代码后发现真正的失效面是**后者**（只被 TEST 任务引用的 AC 根本不进范围，run 3 slice-5 的 AC-24/25/26/29/30 从未被检查过）。**一处必要细化**：锚点条件排除**交付链任务**（它们由 `DeliveryOrchestrator` 执行、在切片末尾长期 PENDING），字面照做会让检查**永不触发**。PL-M3 给 `debugTargetType` 的两条来源（`fixTaskType` / `targetTaskType`）加成员判定，不可用则回退并记 `DEBUG_TARGET_TYPE_FALLBACK`；**范围细化为「枚举外 + 运行期专属类型」都回退**（原代码只挡了 `DEBUG` 一个）。**PL-M4 未开工**（需先确认周配额余量）。
