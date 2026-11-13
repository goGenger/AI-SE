# 235 · 能力面收拢：Capability Profile 设计（"只做前端"的架构前提）

> **产品默认（2026-11-04）**：`DEFAULT_CAPABILITY_PROFILE` 与 server 缺省 `CAPABILITY_PROFILE` 已切为 **`frontend-vue`**（平台不做后端开发任务）。
> 显式 `CAPABILITY_PROFILE=backend-node` 仍可选（遗留 E1）。下文 §6 历史步骤里「默认仍是 backend-node / 零行为变化」是**迁移当时**的口径，以本注与代码为准。
> 关联：`docs/247` l1-rv1 因产品方向中止；F1 + `frontend-vue` 为主线。

> **文档性质**：架构设计，**不含实现**。按 `AGENTS.md` §9，本文只定义「能力面」如何收拢、迁移顺序与
> 判据；实现另立命名阶段，需另行授权。
>
> **上游**：用户 2026-10-27 的判断（平台只做前端动态工作流，不覆盖后端栈多样性）；
> `docs/233`（前端夹具与浏览器验收）、`docs/234`（离线构建探针）。

---

## 1. 结论

**架构不需要重写，但需要一次「能力面收拢」。**

平台的执行内核（Tool Runtime、工作流引擎、审批/审计/证据、沙箱、浏览器）与业务形态无关，**一行都不用为
「只做前端」改动**。需要动的是「平台能做什么」这件事**表达在哪里**——它今天散在五类接缝、八处代码里，
每一处都是写死的常量或提示词字符串。

如果只是删掉后端的代码，这五处会各自长出一个 `if`，「只做前端」就会以散落分支的方式渗进引擎——
那才是这次转向最贵的架构债。

**做法**：引入一份**声明式能力 profile**，让「能规划什么、谁来写、怎么验、边界门是哪种、交付到哪一段」
由配置表达；引擎只读 profile，不再读常量。

---

## 2. 先分离两层（最容易被混淆）

| 层                       | 组成                                                         | 转向后                             |
| ------------------------ | ------------------------------------------------------------ | ---------------------------------- |
| **平台自身的后端**       | `apps/server`、`packages/database`、Postgres、审计/审批/证据 | **完全不变**：它是宿主，不是生成物 |
| **平台生成与验证的后端** | BACKEND/DATABASE 任务、迁移检查、`serverSmoke`、九个后端夹具 | **收拢/退役对象**                  |

> 「刨除后端能力」= 不再**生成与验证**后端产物，**不是**「拆掉平台自己的后端」。

---

## 3. 接缝清单（现状，逐处 file:line）

| 类别           | 位置                                                                         | 现在写死了什么                                                            |
| -------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| ① 任务类型     | `packages/shared/src/index.ts:541` `TaskTypeSchema`                          | 含 BACKEND / DATABASE                                                     |
|                | `packages/shared/src/index.ts:614` `WORK_TASK_TYPES`                         | 写范围/防篡改/修复选址的工作类型集合                                      |
| ② 工作类型回退 | `packages/workflow-engine/src/WorkflowEngine.ts:136`                         | `fixWorkTargetType` **回退 `"BACKEND"`**                                  |
| ③ 智能体       | `packages/shared/src/index.ts:1531` `AgentTypeSchema`                        | 含 BACKEND / DATABASE                                                     |
|                | `packages/agent-core/src/professional/AgentRegistry.ts:122-260`              | 注册七个 agent（含 backend/database）                                     |
|                | `apps/server/src/services/workflowTaskExecutor.ts:310`                       | `registry.resolveTask(task)` 按类型选 agent                               |
| ④ 验证契约     | `apps/server/src/services/taskVerifierRules.ts:50` `CHECK_CANDIDATES`        | BACKEND→[build,test]、**FRONTEND→[build,lint]**、TEST→[test]              |
|                | 同上 `:57` `MIGRATION_UP/DOWN_SCRIPTS`                                       | DATABASE 迁移检查                                                         |
|                | 同上 `:47` `DEV_TASK_TYPES`                                                  | 含 BACKEND/DATABASE                                                       |
| ⑤ 边界门       | `apps/server/src/services/serverSmoke.ts`（N-49/53/54）                      | 起进程 + 探 **HTTP 路由**                                                 |
| ⑥ 规划提示词   | `packages/agent-core/src/planning/prompts/task-planning.prompt.ts:5`         | 「Plannable task types: … DATABASE, BACKEND, FRONTEND …」**硬编码字符串** |
|                | 同上 `:7`                                                                    | 「project manifest and its npm scripts」                                  |
|                | 同上 `DELIVERY_READY_LINE`                                                   | 交付链固定为 CI → staging DEPLOY → staging VERIFY → production DEPLOY     |
| ⑦ 规格类型     | `packages/shared/src/index.ts:535` `SpecificationTypeSchema`                 | 含 DATABASE / API（当作生成物）                                           |
| ⑧ 度量面       | `packages/eval/fixtures/`（9 个夹具）、`packages/eval/src/types.ts:5` `Tier` | 全部后端；tier 无前端档                                                   |

---

## 4. Capability Profile：契约定义

### 4.1 形状（声明式，不含可执行逻辑）

```ts
interface CapabilityProfile {
  id: string; // "frontend-vue" | "backend-node"（现状等价物）
  version: string; // 写入 tasks.input.profile，便于回溯读数属于哪套口径

  taskTypes: {
    plannable: TaskType[]; // 规划器可用的类型（取代提示词里的硬编码清单）
    work: TaskType[]; // 有写范围 / 防篡改 / 可作为修复目标的类型（取代 WORK_TASK_TYPES）
    fixFallback: TaskType; // 失败修复任务的回退类型（取代硬编码 "BACKEND"）
  };

  agents: AgentType[]; // registry 只解析这些类型
  specs: {
    generate: SpecificationType[]; // 本 profile 会产出的规格
    consume: SpecificationType[]; // 由外部提供、平台只读的规格（如 API 契约）
  };

  checks: Partial<Record<TaskType, VerificationCheckName[]>>; // 取代 CHECK_CANDIDATES
  testParser: "node-tap" | "vitest" | "surefire-xml";
  boundaryCheck: "ui" | "server" | "none";

  delivery: { chain: DeliveryAction[] }; // 交付尾段（CI/DEPLOY/VERIFY/ROLLBACK 的子集）
  fixtureTier: string; // "F1" | "E1" | …
}
```

### 4.2 三条硬规则（防止 profile 变成第二套系统）

1. **profile 是声明，不是插件**：不得携带可执行代码、不得注册新的工具或执行路径。
   Tool Runtime 仍是唯一执行路径（`AGENTS.md` §10）。
2. **profile 不得引入新的 Permission / Approval / Audit / 错误码**：它只决定「选哪个已存在的检查/门/智能体」。
3. **运行期以任务自身字段为准**：历史 `tasks` 行里已有 `type`，profile 只影响**新规划**与**新检查**；
   不得因切 profile 而回写历史行（`AGENTS.md` §6 红线）。

### 4.3 谁读 profile

| 读方                 | 读什么                                           | 取代什么                                                                                                                                                                              |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 规划器（提示词构造） | `taskTypes.plannable`、`specs`、`delivery.chain` | 硬编码类型清单与交付链文案                                                                                                                                                            |
| 工作流引擎           | `taskTypes.work`、`taskTypes.fixFallback`        | `WORK_TASK_TYPES` 与 `"BACKEND"` 回退                                                                                                                                                 |
| Agent 注册表         | `agents`                                         | 全量注册七个定义之后按需解析；**不属于任何启用 profile 的类型必须 fail-closed**（§5.2 层 2）。注册表页面 / `GET /agents` 也按同一份 `agents` 过滤展示（`docs/266`），目录与实现仍保留 |
| 任务验证器           | `checks`、`testParser`                           | `CHECK_CANDIDATES`、`parseAcResults` 的 Node 形状                                                                                                                                     |
| 切片边界检查         | `boundaryCheck`                                  | `serverSmoke` 的无条件启用                                                                                                                                                            |
| 评测                 | `fixtureTier`                                    | tier 枚举手写                                                                                                                                                                         |

---

## 5. `frontend-vue` profile 的取值（"只做前端" 的完整表达）

| 字段                    | 取值                                                            | 说明                                            |
| ----------------------- | --------------------------------------------------------------- | ----------------------------------------------- |
| `taskTypes.plannable`   | ANALYSIS, DESIGN, FRONTEND, TEST, REVIEW, BUILD, DEPLOY         | 不含 BACKEND / DATABASE                         |
| `taskTypes.work`        | FRONTEND                                                        | 写范围与防篡改只对前端产物生效                  |
| `taskTypes.fixFallback` | FRONTEND                                                        | **修正 §3 ② 的回退陷阱**                        |
| `agents`                | PLANNER, FRONTEND, QA, REVIEWER, DEVOPS                         | backend-agent / database-agent 退役             |
| `specs.generate`        | REQUIREMENT_ANALYSIS, FUNCTIONAL, UI, TECHNICAL                 |                                                 |
| `specs.consume`         | API                                                             | 后端契约由用户提供，平台只读（`docs/233` §1.3）。**消费不是跳过**：`api_spec` 阶段仍会运行，用来规划前端封装（`docs/269`） |
| `checks`                | FRONTEND: **[build, lint, test]**；TEST: [test]；BUILD: [build] | **新增 `test`**，理由见 §5.1                    |
| `testParser`            | `vitest`                                                        |                                                 |
| `boundaryCheck`         | `ui`                                                            | `uiSmoke`（`docs/233` §5.2）                    |
| `delivery.chain`        | CI, DEPLOY(staging), VERIFY(staging)                            | production 不在链上                             |
| `fixtureTier`           | `F1`                                                            | `docs/233` §3                                   |

> **2026-11-12 澄清（`docs/269`）**：`specs.consume: ["API"]` 的意思是「不要生成一份后端接口规格，也不要排出 BACKEND 任务」，不是「不要规划 API 层」。产品主路径上的 `api_spec` 阶段在 `frontend-vue` 下仍然运行：TRD / 已提供的 API 契约 / 封装示例是权威输入，规划的是前端接口封装和页面对接。没有契约时记下缺口，不得虚构服务端端点。

### 5.1 一个必须点明的现状缺口

`CHECK_CANDIDATES.FRONTEND = ["build", "lint"]`（`taskVerifierRules.ts:52`）——**前端任务今天没有测试检查**。
在纯前端平台里，这意味着每个前端任务的逐任务门只看「能编译、能过 lint」，UI 行为要等到 oracle 才被验一次。
profile 里给 FRONTEND 加 `test` 是这次转向的**必选项**，不是优化项。

### 5.2 退役对象：`database-agent` / `backend-agent` 的三层处置（用户 2026-10-27）

**先定性：这不是「精简范围」，是关掉一个静默通过的洞。** 不可验证的类型不会让门报错，它让门
`unavailable`——N-1b 实测：无迁移脚本的项目里 DATABASE 检查候选为空，任务照判 **SUCCESS**（全库 22 个实例）。

但「从能力里去掉」与「从代码里删掉」是两件事。分三层，**每层的处置不同**：

| 层                      | 处置                                                     | 理由                                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1 · 可规划 / 可选中** | **移除**（profile 的 `taskTypes.plannable` 与 `agents`） | 安全修复本身：规划器不再产出不可验证任务                                                                                                                                                               |
| **2 · 注册表定义**      | **保留，但不可达；展示层按当前 profile 过滤**            | 历史有 114 条 DATABASE、2340 条 BACKEND 任务；`recover()` 会恢复正在跑的任务，删定义会让恢复路径直接崩。定义与实现留在目录里；注册表页面 / `GET /agents` 只列出当前 profile 启用的 agent（`docs/266`） |
| **3 · 检查路径**        | **删除**                                                 | 这才是会**误导判决**的部分，与「有没有 agent」无关                                                                                                                                                     |

**层 2 必须配一条强制要求**：`AgentRegistry.resolveTask` 对「**不属于任何已启用 profile 的类型**」必须
**fail-closed**（明确报错 + 落审计），不得静默挑一个 agent。否则「保留但不可达」会退化成「保留且随时可达」。
注册表**展示 / 页面所用 API**（`listEnabled()` → `GET /agents`）同样跟随当前 capability profile，不把未启用的 agent 标成「可用」；定义、提示词与实现类仍留在目录中，切换到启用它们的 profile 后会重新出现（`docs/266`）。

#### 耦合清单（七处）

| #   | 耦合项                                             | 位置                                | 处置                                              |
| --- | -------------------------------------------------- | ----------------------------------- | ------------------------------------------------- |
| 1   | agent 定义（`backend-agent` / `database-agent`）   | `AgentRegistry.ts:122-260`          | **保留**（层 2），不注册到任何启用 profile        |
| 2   | `AgentTypeSchema` 的 `BACKEND` / `DATABASE`        | `packages/shared/src/index.ts:1531` | 保留枚举值，标 `@deprecated`                      |
| 3   | `CHECK_CANDIDATES.DATABASE` 与迁移分支             | `taskVerifierRules.ts:50`           | **删除**（层 3）                                  |
| 4   | `MIGRATION_UP/DOWN_SCRIPTS` + `hasMigrationScript` | `taskVerifierRules.ts:57,126`       | **删除**（层 3）                                  |
| 5   | `DEV_TASK_TYPES` 中的 `DATABASE`                   | `taskVerifierRules.ts:47`           | **移除**（层 3）                                  |
| 6   | `WORK_TASK_TYPES` 中的 `BACKEND` / `DATABASE`      | `packages/shared/src/index.ts:614`  | 由 profile 的 `taskTypes.work` 取代后移除（层 1） |
| 7   | `SpecificationTypeSchema` 的 `DATABASE`            | `packages/shared/src/index.ts:535`  | 停止生成（`specs.generate` 不含它），枚举保留     |

#### 为什么枚举值保留、只停用

库内已有 **114 条 DATABASE 任务**（65 条由 `database-agent` 执行）。行是按 cast 读取的
（`packages/database/src/workflowRepositories.ts:207`），**删枚举不会崩读取**；但删值会让类型系统对历史数据
撒谎，也让「这条记录当初是什么」不可解释。⇒ **值保留、产线停用、检查路径删除、定义保留**。

#### 顺序

- 第 2 步：关闭「可规划 / 可选中」（层 1）——**可回滚**，切回 `backend-node` 即恢复；
- 第 3 / 5 步：删除检查路径（层 3）——不可回滚，但在 F1 验证之后进行；
- **层 2 定义与实现全程不动**：agent 定义留在目录里，只是没有任何运行中的 profile 能派发它；注册表页面按当前 profile 隐藏未启用项（`docs/266`）。

---

## 6. 迁移方案（五步，先加后删）

| 步    | 做什么                                                                                                                                                                                  | 验收                                                                      | 回滚                                        |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| **1** | 定义 profile 类型 + **`backend-node`（现状等价物）**，让 §4.3 五处读它                                                                                                                  | **零行为变化**：全仓测试绿；同一夹具跑一轮，oracle 与链完成读数与基线一致 | 切回常量（代码只加不删）                    |
| **2** | 加 `frontend-vue` profile；后端 profile 仍为默认                                                                                                                                        | 规划器按 profile 出清单；前端任务检查含 `test`                            | 默认 profile 切回 `backend-node`            |
| **3** | `uiSmoke` 与 `serverSmoke` 并列，按 `profile.boundaryCheck` 选                                                                                                                          | `docs/233` §6.2 的 mutant 反向必须命中                                    | 切回 `server`                               |
| **4** | F1 夹具 + tier `F1` + 批次脚本                                                                                                                                                          | `docs/233` §6.2 全部通过                                                  | 停用 F1 批次脚本                            |
| **5** | **退役**：从 plannable 移除 BACKEND/DATABASE、删除检查路径（`CHECK_CANDIDATES.DATABASE`/`MIGRATION_*`/`DEV_TASK_TYPES` 项）、归档九个后端夹具、裁剪交付尾段。**agent 定义保留**（层 2） | 前端 profile 端到端一轮通过                                               | 恢复 profile 取值即回滚（代码退役另立提交） |

**为什么必须"先加后删"**：任何一步出问题都能靠切换 profile 回到上一个可用形态；而"先删后加"会让中间态
既跑不了旧能力、也没有新能力。

### 6.1 第 1 步实施状态（2026-10-27）

**已接线（零行为变化）**：

| 接缝            | 位置                                                                     | 变化                                                                                                                |
| --------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 可规划类型      | `packages/agent-core/src/planning/prompts/task-planning.prompt.ts`       | 清单由 profile 渲染；`backend-node` 与迁移前**逐字相同**                                                            |
| 工作类型 / 回退 | `packages/workflow-engine/src/WorkflowEngine.ts`（`fixWorkTargetType`）  | 遍历 `profile.taskTypes.work`；回退取 `profile.taskTypes.fixFallback`（不再是字面量 `"BACKEND"`）                   |
| 检查候选        | `apps/server/src/services/taskVerifierRules.ts`                          | 删除 `CHECK_CANDIDATES`，改读 `profile.checks`                                                                      |
| 智能体          | `packages/agent-core/src/professional/AgentRegistry.ts`（`resolveTask`） | 只派发 profile 启用的 agent；未启用 **fail-closed**（§5.2 层 2）                                                    |
| 常量同源        | `packages/shared/src/index.ts`                                           | 新增 `CapabilityProfile` / `BACKEND_NODE_PROFILE` / `DEFAULT_CAPABILITY_PROFILE`；`WORK_TASK_TYPES` 由 profile 派生 |

**定义但未接线**（消费者尚未存在，留到对应步骤）：`boundaryCheck`（第 3 步 `uiSmoke`）、
`fixtureTier`（第 4 步）、`specs` 与 `delivery.chain`（提示词里的交付链仍是静态文本）、
`testParser`（仍走既有 `parseAcResults`）。

**等价性守卫**：`packages/shared/src/capabilityProfile.test.ts` 用黄金断言钉住每个字段与迁移前一致；
`AgentRegistry` / `taskPlanningPrompt` / `resolveVerificationChecks` 各有「自定义 profile 立即生效」的正向用例。

**门禁（2026-10-27）**：`corepack pnpm -r run lint` 0 问题；**15 个包 typecheck 全过**；
`corepack pnpm -r run test` **228 个测试文件 / 2070 条用例全绿**（exit 0）。

**尚未完成的验收半句**：`docs/235` §6 第 1 步的判据还有「**同一夹具跑一轮**，oracle 与链完成读数与
基线一致」——代码级等价已经证明，**批次级等价尚未测量**（需一次真实回归，约 3 小时 / 72M token）。
未跑之前不宣称第 1 步完整通过。

### 6.2 第 2 步实施状态（2026-10-27）

**做了什么**：`FRONTEND_VUE_PROFILE` 落在 `packages/shared`，`DEFAULT_CAPABILITY_PROFILE` **仍是
`backend-node`**——第 2 步只「加」，不「切」。

| 字段                                           | 取值                                                    | 与 `backend-node` 的差                               |
| ---------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| `taskTypes.plannable`                          | ANALYSIS, DESIGN, FRONTEND, TEST, REVIEW, BUILD, DEPLOY | 去掉 DATABASE / BACKEND                              |
| `taskTypes.work` / `fixFallback`               | `[FRONTEND]` / `FRONTEND`                               | 不再回退 BACKEND                                     |
| `agents`                                       | PLANNER, FRONTEND, QA, REVIEWER, DEVOPS                 | 去掉 BACKEND / DATABASE（定义仍在注册表，§5.2 层 2） |
| `specs.generate` / `consume`                   | REQ, FUNCTIONAL, UI, TECHNICAL / **API**                | API 从后端生成物变成输入；阶段仍运行，见 `docs/269`  |
| `checks.FRONTEND`                              | build, lint, **test**                                   | §5.1 的必选项                                        |
| `testParser` / `boundaryCheck` / `fixtureTier` | vitest / `ui` / F1                                      | 前端一套                                             |

**三个接缝上的实测落点**（每个都有一条用例，不是"声明了就算"）：

| 接缝         | 用例读数                                                                                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 规划提示词   | 传 `FRONTEND_VUE_PROFILE` 时 `Plannable task types:` 整行不再出现 `BACKEND` / `DATABASE`（按词边界判定，避免 `FRONTEND` 里的子串干扰）；不传 profile 时仍是完整清单                                                        |
| 任务验证器   | `resolveVerificationChecks("FRONTEND", scripts, "FRONTEND", FRONTEND_VUE_PROFILE)` → `build, lint, test` 且 `test` 的 `expectation = pass`；工作区缺 `test` script 时 `missing = ["test"]`（**证据面缺失**，不是静默通过） |
| Agent 注册表 | `FRONTEND` 仍解析到 `frontend-agent`；`BACKEND` / `DATABASE` 在 `frontend-vue` 下 **fail-closed**（`docs/235` §5.2 层 2）                                                                                                  |

**结构性不变量**（`capabilityProfile.test.ts`，对**任何** profile 生效）：工作类型与回退类型必须都在
可规划集合内；检查候选只能挂在可规划类型上；交付链以 CI 起头、非 CI 步骤必须带环境。这三条是给后续
新增 profile 留的守卫——取值越界先在这里红，而不是运行期冒出一个谁都接不住的任务。

**文档与代码的两处冲突（本次核对发现，已按代码修正文档）**：

1. §4.1 的契约写作 `delivery: { chain: DeliveryAction[] }`，但仓库里**没有 `DeliveryAction` 这个类型**
   ——交付动作的真实类型是 `DeliveryTask`（`DeliveryTaskSchema`，`packages/shared/src/index.ts:748`）。
   已按代码落字段，类型用 `DeliveryTask`。
2. §6.1 早先把 `delivery.chain` 列进「定义但未接线」，但当时接口里**根本没有这个字段**（只有 `specs`
   是真定义了没接线）。第 2 步把字段补上，两处说法统一为「已定义、未接线」。

**门禁（2026-10-27）**：`corepack pnpm -r run lint` 0 问题；全仓 typecheck 15 个包全过；
`corepack pnpm -r run test` **228 个测试文件 / 2085 条用例全绿**（exit 0；比第 1 步多 15 条，全为本次新增）。

**一次偶发（非本次改动）**：`apps/server` 首次全量跑时 `planningEscalation.e2e.test.ts` 报
`Parse Error: Expected HTTP/, RTSP/ or ICE/`，单文件复跑与随后整包复跑均通过。属既知的「后端忙时
server e2e 偶发失败」形状；不登记为缺陷，但若复现频率上升需查端口竞争。

**本步没做的事**：没有任何调用方**选中** `frontend-vue`——profile 目前只能由测试传进去。选择机制
（谁把哪个 profile 交给规划器 / 验证器 / 注册表，以及新任务的 `input.profile` 怎么写，见 §7）尚未实现。

### 6.3 第 3 步实施状态（2026-10-27）

**做了什么**：`uiSmoke.ts` 落地（`docs/233` §5.2 的 UI 版边界冒烟），边界门由 profile 的
`boundaryCheck` 选。

| 落点                                  | 内容                                                                                                                                                                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/services/uiSmoke.ts` | `extractTestIds`（只认 AC 点名的 `data-testid`，三种写法）、`staticTestIds`、`uiTestIdSkipReason`、`buildUiSmokeCommand`、`parseUiSmokeOutput`、`evaluateUiSmoke`                                                                                                    |
| `taskVerifierRules.ts`                | `VerificationCheckName` += `ui-smoke`                                                                                                                                                                                                                                |
| `taskVerifier.ts`                     | `CHECK_TOOL_BY_NAME["ui-smoke"] = run_command`；`VerificationFailureCode` += `PAGE_UNREACHABLE` / `SURFACE_MISSING` / `CONSOLE_ERROR`；证据新增 `ui` 块；`TaskVerifierDependencies.profile`；`maybeSliceBoundaryCheck` 按 `boundaryCheck` 分派；失败码提取两种门共用 |
| `serverSmoke.ts`                      | 导出 `isEnvironmentBootFailure`（两门共用同一条「这是不是环境问题」判据，不写第二份）                                                                                                                                                                                |

**判定表**（`evaluateUiSmoke`，顺序即判据强度）：

| 输入                                   | 结论                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| AC 没点名 testid / 只点名动态 testid   | `skipped` `NO_TESTIDS` / `ONLY_DYNAMIC_TESTIDS`（且**不起进程**） |
| 起不来 + 环境原因（缺依赖 / 无网）     | `skipped` `BOOT_ENV_UNRESOLVED`                                   |
| 起不来 / 首页 `>= 400`                 | `failed` `PAGE_UNREACHABLE`                                       |
| 工作区没有可用浏览器                   | `skipped` `BROWSER_UNAVAILABLE`                                   |
| 页面 200，点名的 testid **一个都不在** | `failed` `SURFACE_MISSING`                                        |
| 元素在，但载入期控制台有 error         | `failed` `CONSOLE_ERROR`（可用 `consoleErrorsFatal: false` 放宽） |
| 元素在 + 控制台干净                    | `passed`                                                          |

**两条顺序是有意的**：`BROWSER_UNAVAILABLE` 必须排在 `SURFACE_MISSING` **之前**——没有浏览器时
`present` 恒为空，排在后面就会把「没看过」读成「元素不在」，正是 N-49/N-53/N-54 那一族的假阴性。
`SURFACE_MISSING` 排在 `CONSOLE_ERROR` 之前——一个元素都没挂上时，报错只是症状。

**零行为变化**：缺省 profile 仍是 `backend-node`（`boundaryCheck: "server"`）。有一条用例专门钉住
「缺省下 `ui-smoke` 不出现，且那条含 `loadBrowser` 的命令根本没发出去」。`none` 时两门都不跑，
`smokeSkipped = "boundary-check-disabled"`。

**mutant 反向命中（`docs/233` §6.2 第 3 条，本步的验收）**——三条用例跑**真进程 + 真 Chromium**：

| 用例                                          | 读数                                                     |
| --------------------------------------------- | -------------------------------------------------------- |
| testid 由**脚本注入**（不在 `index.html` 里） | `passed`——证明断言的是渲染后的 DOM，不是抓 HTML 找字符串 |
| `empty-shell`（页面起得来、什么都不渲染）     | `failed` `SURFACE_MISSING`                               |
| 元素在 + `console.error`                      | `failed` `CONSOLE_ERROR`                                 |
| 工作区没有 playwright                         | `skipped` `BROWSER_UNAVAILABLE`                          |

**一个测出来的坑（记下来）**：vitest 会给子进程注入 `NODE_PATH` 指向仓库 `node_modules`，于是
探测程序「意外」解析到了 playwright，`BROWSER_UNAVAILABLE` 那条用例假通过。修法是测试里显式清空
`NODE_PATH`，让解析**只**来自工作区（生产沙箱没有这个变量）。任何「探测程序解析依赖」的用例都
会被这个坑咬到。

**必须说清的缺口（本步没有解决的问题）**：

1. **沙箱镜像里没有浏览器**。探测程序从**工作区**解析 `playwright`（F1 夹具将自带该依赖），
   但 chromium 二进制需要镜像预装（`docs/234` 的 `Dockerfile.ui` + `WITH_BROWSER=1`，2.72GB）。
   镜像决定之前，真批次里 `frontend-vue` 的边界门会**每次都 `BROWSER_UNAVAILABLE` 跳过**——
   留痕，不静默，但那道门实际上不响。⇒ **在镜像决定之前不许把默认 profile 切成 `frontend-vue`。**
2. **测试与生产不同构的那一环**：探测程序、命令串、判定逻辑完全一致，但用例在**宿主机**上跑
   （临时工作区 + 符号链接的 playwright），没有过「每条命令一个新容器」「`--cpus 1` / 512MB」
   这一层。容器内的内存与启动开销仍待 `docs/234` 的探针读数来确认。

**门禁（2026-10-27）**：全仓 lint 0 问题；**全仓 typecheck 15 包全过**（首轮 `apps/web` 报
`shared/dist/index.d.ts is not a module`，是 `pnpm -r` 并行时别的包正在重写该 `dist` 的竞争，单独
复跑即过——既有门禁命令的偶发，不是本次改动）；`corepack pnpm -r run test` **229 个测试文件 /
2112 条用例全绿**（exit 0，比第 2 步多 1 个文件、27 条用例）。

---

### 6.4 第 4 步实施状态（2026-10-27）

**做了什么**：F1 夹具、tier `F1`、批次脚本落地（`docs/233` §3 / §4 的落地形态）。

| 落点                                                              | 内容                                                                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/eval/fixtures/F1/`                                      | `fixture.json`（`requirementText` = `prd.md` 原文）、`prd.md`、`ac-map.md`、`oracle.mjs`、`README.md`                                              |
| 四个工作区                                                        | `template/`（空骨架）、`reference/`（参考实现）、`mutants/empty-shell/`、`mutants/no-console-clean/`                                               |
| `packages/eval/src/types.ts`                                      | `Tier` += `"F1"`（分档表按记录动态生成，`report.ts` 无需加行——与 §5.1 的措辞不一致，按代码为准）                                                   |
| `packages/eval/package.json`                                      | `playwright@1.61.0` 作 devDependency（`docs/233` §4.5；与 `packages/browser` 同版本，已在本地 store，无新下载）                                    |
| `packages/eval/scripts/f1-frontend-x3.sh` / `f1-frontend-stop.sh` | 批次与停批脚本（ASCII、`bash -n` 通过）                                                                                                            |
| 测试                                                              | `fixtures.test.ts` 清单更新；新增 `f1Fixture.test.ts`（mock/锁文件四份逐字相同、oracle 逐条覆盖 AC-01..24、需求文案必须用 `data-testid="x"` 形式） |

**`docs/233` §6.2 的五条判据，逐条读数（2026-10-27，本机实测）**：

| #   | 判据                                                            | 读数                                                                                                                         | 状态 |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | reference：Must 20/20，连跑 3 轮，0 条 AC 翻转                  | **24/24 × 3**（Must 20 + Should 4），**flips = 0**                                                                           | ✅   |
| 2   | template：≥15 条 Must 失败                                      | **19 条 Must 失败**（1/24 通过，唯一通过的是 AC-20）                                                                         | ✅   |
| 3   | `empty-shell`：`uiSmoke` 报 `SURFACE_MISSING`，oracle 必须失败  | oracle **19 条 Must 失败**；`uiSmoke` **`SURFACE_MISSING`**（真进程 + 真 Chromium，页面 200、点名的 8 个 testid 一个都不在） | ✅   |
| 4   | `no-console-clean`：AC-20 必须失败                              | **只有 AC-20 失败**（其余 23 条通过）                                                                                        | ✅   |
| 5   | 端到端 1 次批次（4 切片、CI + staging deploy + staging verify） | **未执行**：见下                                                                                                             | ⛔   |

**第 5 条为什么没跑**：批次脚本在两道前提上**主动拒绝启动**（exit 7 / exit 8），不是"还没写"：

1. 平台还不能选中 `frontend-vue`（§10「profile 选择机制」），`/health` 也不暴露当前 profile ⇒
   跑了只会测到 `backend-node` 的行为，却记成 F1 的读数；
2. 沙箱镜像没有浏览器（`docs/234`）⇒ `ui-smoke` 会每次 `BROWSER_UNAVAILABLE` 跳过。

脚本把这两条写成**断言**（不是开关）：`capabilityProfile` 必须是 `frontend-vue`；`SANDBOX_IMAGE`
的 `Config.Env` 必须含 `PLAYWRIGHT_BROWSERS_PATH`。没有环境变量能绕过。

**过程中发现并修掉的两个真问题（都属"门会误判"这一类）**：

1. **AC 文本的写法决定门会不会响**。`prd.md` 最初把元素写成反引号里的名字（`` `app-title` ``），
   而 `extractTestIds` 只认 `data-testid="app-title"` ⇒ 真批次里 F1 的边界门会**恒记 `NO_TESTIDS`
   跳过**。这不是探针坏了，是**输入文本没按契约写**。已把 20 条 AC 全部改成契约形式，并写进
   `prd.md` §四（"平台只认这个形式，不会从散文里猜"），同时加了 `f1Fixture.test.ts` 的守卫。
2. **散文里的示例串会被当成真 testid**。同一份文档里那句「一律写成 `data-testid="名字"` 的形式」
   让提取器产出了一个名为 `名字` 的"必须存在的元素"——真批次里它会进入缺失清单，极端情况下造出
   一次**假的 `SURFACE_MISSING`**。已在 `extractTestIds` 加边界校验（ASCII 字母开头），并有用例。

**另一个对齐修正**：`uiSmoke` 的控制台门原本把所有 error 都算致命，包括浏览器对网络失败的
`Failed to load resource` 日志。F1 的参考实现在"接口不可达但页面正常降级"时会因此被误判成缺陷。
现与 oracle 的 AC-20 同口径（网络 4xx/5xx 的资源日志不算应用错误），并有用例钉住。

**测试环境与生产不同构的一环（照实记）**：四条读数都在**宿主机**上跑（临时工作区 + 本机 chromium），
没经过"每条命令一个新容器 / 1 CPU / 512MB / 无网"。oracle 与 `uiSmoke` 的程序、命令串、判定逻辑
完全一致，但容器内的安装与启动开销仍未测——这正是第 5 条要回答的事。

**门禁（2026-10-27）**：全仓 lint 0 问题；全仓 typecheck 15 包全过；`corepack pnpm -r run test`
**230 个测试文件 / 2119 条用例全绿**（exit 0）。

**一次偶发（非本次改动）**：全量跑时 `terminationPropagation.e2e.test.ts` 的 FX-35（取消传播）
失败过一次，单文件复跑 5/5 通过；当时机器上正并行跑着浏览器 oracle。属既知的「后端 e2e 在负载下
偶发超时」形状，不登记为缺陷——但如果同类偶发变密，该查的是这些 e2e 的等待窗口，不是平台逻辑。

**一个副作用要记**：`packages/eval` 的 `test` 脚本是 `vitest run src`——`src` 是**子串过滤**而不是
根目录，于是夹具里的 `*/src/*.test.ts` 会被一起收进仓库测试套件（实测多了 3 个文件 / 15 条用例）。
已把参考实现的单测移到各工作区的 `test/`（vitest 默认 include 仍会收），夹具自测照常可跑。

---

### 6.5 第 5 步：**未开工**（2026-10-27 核对，前置未满足）

**结论：第 5 步一行代码都没删，也不该现在删。** 它自己的验收是「前端 profile 端到端一轮通过」，
而这件事今天做不到——不是慢，是平台**选不中**前端 profile。

核对证据（当次实测，非推断）：

| 前置                  | 现状                                                                                                                | 证据                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 能选中 `frontend-vue` | **不能**。五处接缝全部 `?? DEFAULT_CAPABILITY_PROFILE`，没有任何环境变量 / 配置项 / 接口能换                        | `taskVerifier.ts:6,1389`、`taskVerifierRules.ts:3,121`、`WorkflowEngine.ts:5,126`、`AgentRegistry.ts:5,362`、`task-planning.prompt.ts:1,52`；`FRONTEND_VUE_PROFILE` 的引用**只出现在测试里** |
| 沙箱镜像带浏览器      | **不带**。`ai-se-sandbox:22-pnpm9` 的 `Config.Env` 只有 `PATH` / `NODE_VERSION` / `YARN_VERSION` / `PNPM_STORE_DIR` | `docker image inspect` 直读                                                                                                                                                                  |

**为什么不能"先把东西删了再说"**：

1. §6 的「先加后删」就是为这一刻写的——退役一旦先做，中间态**既跑不了旧能力、也没有新能力**，
   而它删除的是**共享代码路径**，不是前端专属分支；
2. 删除对象会被历史行依赖：库里现在有 **2340 条 BACKEND 任务、114 条 DATABASE 任务**
   （`select type,count(*) from tasks group by type`，当次查询）。`recover()` 会重新验证这些行，
   删掉检查路径等于让恢复路径改判；
3. §5.2 的顺序把「删除检查路径」排在**第 3 / 5 步**，明确写着「不可回滚，但在 F1 验证之后进行」。

**本步待删清单（等前置满足后一次做完）**：

| #   | 对象                                                               | 位置                                                  | 影响                                            |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------- |
| 1   | DATABASE 分支 + `MIGRATION_UP/DOWN_SCRIPTS` + `hasMigrationScript` | `taskVerifierRules.ts:61,62,135-152`                  | DATABASE 任务不再有迁移检查（该能力本就不覆盖） |
| 2   | `DEV_TASK_TYPES` 的 `DATABASE` 项                                  | `taskVerifierRules.ts:55`                             | 防篡改 / 写范围审计不再覆盖 DATABASE            |
| 3   | 九个后端夹具归档                                                   | `packages/eval/fixtures/{E1,L1,L2,M1,M2,M3,S1,S2,S3}` | 后端批次不可再跑（`cli.ts` 按目录发现夹具）     |
| 4   | 交付尾段裁剪                                                       | `delivery.chain`（未接线）                            | 需先接线，否则「裁剪」只是改一个没人读的字段    |

**建议的补步（本次没有执行，需要单独授权）**：在 5 之前插一个命名的子步——**profile 选择机制**
（`CAPABILITY_PROFILE` 配置项 → 组合根读一次 → 交给五处接缝 → 把 `profile.id` + `version` 写进
新任务的 `input.profile`）。它可逆、零行为变化（缺省仍是 `backend-node`）、且是第 5 步验收的
唯一前置。之后才是：镜像决定（`docs/234`）→ F1 批次 → 第 5 步删除。

---

### 6.6 补步：profile 选择机制（2026-10-27，已完成）

**为什么插这一步**：§6.5 的核对证明第 5 步的验收（「前端 profile 端到端一轮通过」）不可达——平台
**选不中** profile。五处接缝全写着 `?? DEFAULT_CAPABILITY_PROFILE`，`FRONTEND_VUE_PROFILE` 只在
测试里出现过。这一步就是把那个洞补上。

**做法**：一处解析、显式注入。

| 层                                | 变化                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared`                 | `CAPABILITY_PROFILES` + `resolveCapabilityProfile(id)`：**唯一入口**，未知 id 抛错（fail-closed，不静默退回默认）                                            |
| `apps/server/src/config.ts`       | `CAPABILITY_PROFILE`（缺省 `backend-node`），启动时解析成 `CapabilityProfile`；未知名直接启动失败                                                            |
| 组合根 `index.ts`                 | 解析结果注入五处：`TaskVerifier`、`AgentRegistry`、`WorkflowService`（→ `WorkflowEngine`）、`PlanningService`（→ `PlanningAgent` → 规划提示词）、`createApp` |
| `AgentRegistry`                   | profile 由**构造**决定（装配处看得见），`resolveTask` 默认用它                                                                                               |
| `PlanningAgent` / `PlanningGraph` | profile 一路传到 `taskPlanningPrompt`，可规划清单按它渲染                                                                                                    |
| `/health`                         | 新增 `capabilityProfile` 字段（与 N-39 的 `verificationGate` 同因：批次脚本要能断言口径）                                                                    |
| 任务落盘                          | 新任务的 `input.profile = "<id>@<version>"`（§7），缺省不落键                                                                                                |

**零行为变化的证据**（不是断言，是读数）：

- 缺省启动的 `/health` 现在是
  `{"status":"ok","verificationGate":"enforce","capabilityProfile":"backend-node"}`；
- `WorkflowEngine` 用例：同一场景下 `fixFallback` 从 profile 读——`frontend-vue` 形态 → `FRONTEND`，
  缺省 → `BACKEND`（反向对照在同一条用例里）；
- `AgentRegistry` 用例：构造时注入 `frontend-vue` → `BACKEND`/`DATABASE` fail-closed，`FRONTEND` 正常；
- `planningRepositories` 用例：传 profile 落 `input.profile`，不传不落键；
- 全仓 232 文件 / 2130 用例全绿。

**线上核对（2026-10-27 16:14）**：重建 `apps/server/dist`（16:12）→ 重启进程（pid 46300，16:14，
**晚于构建**）→ `/health` 直读出 `capabilityProfile: "backend-node"`。重启前该进程跑的是旧构建
（`/health` 只有 `verificationGate`），这就是"改了但没生效"的典型形状，所以按例核对时间戳。

**顺带修的一处**：`f1-frontend-x3.sh` 的默认端口是 47559，而平台实际在 47558（沿用既有批次脚本）
⇒ 守卫第一步就报 `health=000`，看不出真正的原因。已改为 47558。

**守卫现在的行为（实测）**：平台在 `backend-node` 下运行时，`f1-frontend-x3.sh` 依次断言
health / gate / provider / **profile**，在 profile 这一关 **exit 7**，并提示用
`CAPABILITY_PROFILE=frontend-vue` 重启——这是"拒绝产出会被误读的读数"，不是故障。

**回滚**：不设 `CAPABILITY_PROFILE`（或重启）即回到 `backend-node`。没有数据迁移、没有历史行改动。

**仍然缺的一件**：镜像里没有浏览器（`docs/234`）。这一步只让「选中前端 profile」成为可能，
没有改变「真批次里 `ui-smoke` 会 `BROWSER_UNAVAILABLE` 跳过」这件事。

---

### 6.7 镜像：沙箱内置浏览器（2026-10-27，已完成）

**裁定**：浏览器并进**默认 tag**（`ai-se-sandbox:22-pnpm9`），**不**再开第二个镜像。

理由：两个 tag 会立刻长出「哪个 profile 用哪个镜像」的配置矩阵，而矩阵的每一格都是一次
「跑错镜像、读数作废」的机会。代价只有磁盘（1.17GB → **2.63GB**），运行期资源限制一个字没改
（`--network none --cpus 1 --memory 512m --pids-limit 128`）。

**镜像改了什么**（`packages/sandbox/Dockerfile`，两阶段）：

| 项                                    | 内容                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 依赖预热                              | 两个 seed 各自的 **lockfile** 精确预热到同一个 store：`probes/ui-stack/`（`docs/234` 探针工程）+ `probes/f1-stack/`（F1 依赖集） |
| 为什么用 seed 而不是 `pnpm store add` | 运行期是 `--frozen-lockfile`：`store add` 按**范围**浮动解析，差一个补丁版本就是 `ENOTCACHED`，而失败发生在沙箱里                |
| 浏览器                                | `npm i -g playwright@1.61.0` + `playwright install --with-deps chromium`（playwright **没有 postinstall**，`docs/234` §8.1）     |
| 环境变量                              | `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`、`NODE_PATH=/usr/local/lib/node_modules`                                           |

**为什么 playwright 装在镜像里而不是让项目自带**：`uiSmoke` 要在任意项目目录里驱动浏览器；
要求被测产品依赖测试工具，等于让交付物背验收工具的包袱。镜像提供是正确的位置。
`uiSmoke` 的解析因此改成**两级**：先工作区（项目锁定的版本优先），再镜像全局（`NODE_PATH`），
两级都没有才 `BROWSER_UNAVAILABLE`。

**seed 漂移守卫**：`probes/f1-stack/{package.json,pnpm-lock.yaml}` 必须与
`packages/eval/fixtures/F1/template/` 的同名文件**逐字相同**（`f1Fixture.test.ts` 断言）——
漂移的后果是离线安装失败，而那个失败只会在沙箱日志里露一小角。

**容器内验证（生产同款参数，2026-10-27）**：

```
--network none --cpus 1 --memory 512m --pids-limit 128 --security-opt no-new-privileges --cap-drop ALL
-v <fixture>:/workspace -w /workspace ai-se-sandbox:22-pnpm9 sh -lc '<install && build && <uiSmoke 命令>>'
```

| 断言                            | 读数                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| 镜像内解析 playwright           | `/usr/local/lib/node_modules/playwright/index.js`，`Version 1.61.0`                           |
| 浏览器二进制                    | `chromium-1228`、`chromium_headless_shell-1228`、`ffmpeg-1011`                                |
| 离线安装（参考实现）            | **1,900ms**（`--frozen-lockfile --offline`），`node_modules` **83M**                          |
| 构建                            | **913ms**，`dist` **76K**                                                                     |
| **F1 reference 的 uiSmoke**     | `passed`：`pageStatus 200`、`browser: playwright`、**10 个 testid 命中**、`consoleErrors: []` |
| **F1 `empty-shell` 的 uiSmoke** | `present: []` ⇒ 判定 **`SURFACE_MISSING`**（页面 200，点名的元素一个不在）                    |
| 镜像体积                        | **2.63GB**（原 1.17GB，+1.46GB）                                                              |
| 批次守卫的第二道断言            | `docker image inspect` 的 `Config.Env` 现含 `PLAYWRIGHT_BROWSERS_PATH` ⇒ 通过                 |

**这一步解开了什么**：`ui-smoke` 在真批次里不再恒跳过。F1 批次现在只差**把平台以
`CAPABILITY_PROFILE=frontend-vue` 启动**（默认仍是 `backend-node`，这是刻意的），之后才是第 5 步。

**没有做的**：`DEFAULT_LIMITS` 未动（浏览器在 512MB 下已验证可用，不需要放宽）；`Dockerfile.ui`
保留（它是 `docs/234` 的探针产物，已被默认镜像取代，头注释标明）。

---

### 6.8 F1 批次第一轮读数（2026-10-28，4/5 切片）

**这是平台第一次在 `frontend-vue` profile 下跑真实批次**。批次参数：`--autonomy-l1`、
`CAPABILITY_PROFILE=frontend-vue`、沙箱镜像含浏览器、run 1 带 `--replan`。

| 指标                       | 读数                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------ |
| 切片                       | slice-1 ✅ 16/16、slice-2 ✅ 10/10、slice-3 ✅ 11/12、**slice-4 ❌**、slice-5 未开始 |
| 任务                       | SUCCESS 47 / FAILED 7 / PENDING 2（共 56，含 9 个 REPLAN/DEBUG 派生）                |
| 耗时                       | **4h25m**（15,891,697ms）                                                            |
| token                      | 输入 78.07M / 输出 1.12M                                                             |
| 假阳性                     | **0**（自报失败、oracle 不通过，两边一致）                                           |
| 链完成 / 交付 / staging 段 | 全 false（停在 slice-4）                                                             |
| 失败分层                   | 规划 0 / 验证门 2 / agent 5                                                          |
| 失败码                     | `LLM_ERROR` 1、`REPLAN_REQUESTED` 4、`VERIFICATION_FAILED` 2                         |

**`docs/233` §6.2 第 5 条的三项**：

| 判据                                 | 结果                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------- |
| 4 个切片走通                         | **否**（3/4）                                                             |
| 逐任务门无 Node 契约类假失败         | **是**——§6.8 之前的 reporter 修复生效，全轮无一条「被别的任务的测试判死」 |
| CI + staging deploy + staging verify | 未到达（交付链在最终切片，链停在 4）                                      |

**三处已修的平台缺陷在这一轮被验证**（前一晚连续三次尝试暴露的）：

1. **策略**：`--autonomy-l1` 让 REPLAN 可兑现——本轮 4 次 REPLAN 全部实际执行，其中 slice-3 的
   `T-10`（REVIEW，`LLM_ERROR`）被修好，整片仍 SUCCESS；
2. **规划**：骨架任务落在工作类型（FRONTEND），不再是写不进 `src/` 的 BUILD；
3. **验证**：vitest 项目按作用域 AC 判定，`test` 检查 23 次通过、无一误判。

**slice-4 的失败是门在正确工作，不是平台缺陷**（两条独立证据，均来自库内）：

| 任务            | 形状                                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `T-03`          | TEST 写出 `tests/ac18-delete.test.ts`，其中一条断言把**列表顺序写错**（AC 要求保持 mock 顺序）。修复任务要让它绿只能改测试 ⇒ `antiTamper.weakened = ["tests/ac18-delete.test.ts"]` ⇒ 门拦下 ⇒ REPLAN 耗尽 |
| `T-05-REPLAN-1` | TEST 在测试里用 `test.fails(...)` 把当前缺陷钉成「预期失败」，注释写着"修好后改回 test"。实现落地后那条反而变红，改它同样撞门 ⇒ `weakened = ["test/unit/t05-…spec.ts"]`                                   |

共同点：**测试先行**变成了**把错误的契约写进受保护文件**。门只能拒绝，不能告诉 agent 怎么写才对。

**本轮的已知噪声**：`parseRecoveryRuns: 1`（一次解析降级，已自愈）；`LLM_ERROR: 1` 是上游模型
调用的瞬时失败。

---

### 6.9 补步：写测试的 agent 不得把缺陷固化成「预期失败」（2026-10-28）

**依据**：§6.8 的 slice-4。两个独立任务各自把缺陷写进了**受保护**的测试文件（一个断言顺序写错，
一个用 `test.fails(...)` 占坑），修复任务只能改测试 ⇒ 撞防篡改门 ⇒ REPLAN 耗尽。

**做法**：`TEST_CONTRACT_CONSTRAINT` 加在 `qa-agent` 的指令里（不是加在门上——门只能拒绝，
不能告诉 agent 怎么写才对）：

> 断言必须按 AC 自己的措辞写（AC 定了顺序/计数/选择器就照它断言）；不得用 `test.fails` /
> `test.skip` / `describe.skip` / 空测试体把缺陷记成「预期失败」，也不得把自己的占位标成 pending
> ——后续任务无法在不改这个文件的前提下修好它，而防篡改规则禁止改弱断言。
> **一条「必须改测试才能让实现通过」的测试是错的测试，不是严格的测试。**

**为什么不加在 reviewer / backend / frontend 上**：它们不写 AC 测试，加上只会稀释指令。测试里
有一条反向用例钉住这点。

**验证**：`agent-core` 297 用例全绿（新增 3 条：qa 背着、只读与实现类不背、与既有 AC 命名要求并存）。

**这一条按「声明」处理**：它在下一批才能被验证，本轮读数不受影响。

---

## 7. 数据与兼容

- **历史行不动**：`tasks.type`、`agent_runs`、`workflow_events` 保持原样（`AGENTS.md` §6 红线）；
  profile 版本写进**新**任务的 `input.profile`，便于把读数归属到口径。
- **历史读数不可混比**：九个后端夹具的批次数（含第十二次回归的 100% 链完成）属于 `backend-node` 口径；
  F1 的读数另表统计，不合并。
- **tier 表**新增 `F1` 行（`packages/eval/src/types.ts:5`、`report.ts:119`）。

---

## 8. 风险与对策

| 风险                                                          | 影响                                             | 对策                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| `fixWorkTargetType` 回退 `BACKEND`（`WorkflowEngine.ts:136`） | 每次 REVIEW/QA 失败会造出不可验证的 BACKEND 任务 | profile 的 `fixFallback` 必须被该函数读取；第 1 步就要等价化并加单测 |
| FRONTEND 无 `test` 检查（`:52`）                              | 逐任务门形同虚设                                 | profile 显式加 `test`（§5.1）                                        |
| 规划提示词是字符串常量（`task-planning.prompt.ts:5`）         | 改 profile 不会自动改提示词                      | 提示词由 profile **渲染**，禁止再写第二份清单                        |
| profile 被当成插件（塞逻辑/新工具）                           | 长成第二套执行路径                               | §4.2 三条硬规则；code review 检查项                                  |
| mock 与真实后端漂移                                           | 前端"验证通过"但接不上                           | `docs/233` §7；后续独立 conformance 阶段                             |
| 视觉/交互验收抖动                                             | 读数不稳                                         | `docs/233` §6.3 flake 门                                             |

---

## 9. 明确不做

- 不实现 Java / Python / .NET profile（profile 只是留出位置，不提前建）；
- 不做多 profile 同时在一条链上混用（一次只用一块）；
- 不改工作流引擎状态机、不新增任务状态；
- 不动 Permission / Approval / Audit / Secret 体系；
- 不删除 `apps/server`、`packages/database` 等平台自身后端；
- **不从枚举里删除 `DATABASE` / `BACKEND` 值**（历史 114 条 DATABASE、2340 条 BACKEND 任务需要保持可解释）；
  退役的是「可规划 / 有检查路径」这两件事，不是类型名本身；
- **不删除 `backend-agent` / `database-agent` 的定义**（§5.2 层 2）：只让它们不可达；
- 不在本设计里改任何夹具、提示词或服务代码。

---

## 10. 进度与未开始事项

**已完成（第 1 步，2026-10-27）**：

- `CapabilityProfile` / `BACKEND_NODE_PROFILE` / `DEFAULT_CAPABILITY_PROFILE` 落在 `packages/shared`；
- 四处接缝改读 profile：可规划类型（提示词）、检查候选（验证器）、工作类型与回退（引擎）、
  agent 可达性（注册表，含 fail-closed），详见 §6.1；
- 门禁全绿（lint / 15 包 typecheck / 228 文件 2070 用例）；
- **批次级等价未测**——第 1 步的完整验收需要一次真实回归，尚未执行。

**已完成（第 2 步，2026-10-27）**：

- `FRONTEND_VUE_PROFILE` 落在 `packages/shared`，默认 profile **未切换**（仍是 `backend-node`）；
- 三个接缝的用例读数：提示词清单收窄、FRONTEND 检查含 `test`（并能报出缺失的 `test` script）、
  BACKEND/DATABASE 在 `frontend-vue` 下 fail-closed；
- profile 结构性不变量用例（工作/回退类型 ⊆ 可规划、检查只挂可规划类型、交付链以 CI 起头）；
- 接口补齐 `delivery.chain`（§6.2 的两处文档冲突已按代码修正）；
- 门禁全绿（lint / 15 包 typecheck / 228 文件 2085 用例）。

**已完成（第 3 步，2026-10-27）**：

- `uiSmoke.ts` + `extractTestIds` 落地，`ui-smoke` 进检查名与工具映射，证据与失败码已接线（§6.3）；
- 切片边界门按 `profile.boundaryCheck` 选：`server` / `ui` / `none`，缺省仍是 `server`（零行为变化）；
- **mutant 反向命中**：真进程 + 真 Chromium 上 `empty-shell` → `SURFACE_MISSING`；
  脚本注入的 testid → `passed`（证明断的是 DOM，不是 HTML 文本）；
- 门禁全绿（lint / 15 包 typecheck / 229 文件 2112 用例）。

**已完成（第 4 步，2026-10-27）**：

- F1 夹具（template / reference / 两个 mutant）、`prd.md`、`ac-map.md`、浏览器 oracle 落地；
- `Tier` += `F1`；`@ai-se/eval` 加 `playwright@1.61.0` devDependency（§4.5 的落点）；
- `docs/233` §6.2 的判据 **1-4 实测通过**（reference 24/24 × 3 且 0 翻转、template 19 条 Must 失败、
  `empty-shell` 上 oracle 失败且 `uiSmoke` 报 `SURFACE_MISSING`、`no-console-clean` 上只有 AC-20 失败），
  **第 5 条（端到端批次）未执行**，详见 §6.4；
- 批次脚本 `f1-frontend-x3.sh` / `f1-frontend-stop.sh`：前提不足时**拒绝启动**（exit 7 / 8）；
- 门禁全绿（lint / 15 包 typecheck / 230 文件 2119 用例）。

**已完成（补步 · profile 选择机制，2026-10-27）**：

- `CAPABILITY_PROFILE` 配置 → `resolveCapabilityProfile`（一处解析、未知 id 启动即失败）→ 组合根
  显式注入五处接缝；`/health` 暴露 `capabilityProfile`；新任务 `input.profile = "<id>@<version>"`；
- 缺省仍是 `backend-node`（零行为变化），已重启并在 `/health` 上直读出该值（§6.6）；
- 门禁全绿（lint / 15 包 typecheck / 232 文件 2130 用例）。

**已完成（补步 · 沙箱镜内置浏览器，2026-10-27）**：

- 默认镜像 `ai-se-sandbox:22-pnpm9` 现在带 Chromium + playwright + F1 依赖闭包（2.63GB，§6.7）；
- 容器内（生产同款限制、断网）实测：离线安装 1.9s、构建 0.9s、**uiSmoke 在 reference 上 10 个
  testid 命中并 passed**、在 `empty-shell` 上 `SURFACE_MISSING`；
- 门禁全绿（lint / 15 包 typecheck / 232 文件 2131 用例）。

**已完成（补步 · F1 批次第一轮 + 测试契约约束，2026-10-28）**：

- 平台首次在 `frontend-vue` 下跑真实批次：**4/5 切片**（3 片全绿、slice-4 失败），耗时 4h25m，
  78.07M 输入 token，**假阳性 0**；三处前置修复（策略 / 规划 / 验证）全部被这一轮验证（§6.8）；
- slice-4 的失败是**门在正确工作**（防篡改拦住「改测试让测试通过」），根因是 TEST 任务把错误契约
  写进受保护文件；
- 据此加 `TEST_CONTRACT_CONSTRAINT`（§6.9），下一批验证；
- 门禁：`agent-core` 297 用例全绿。

**未开始事项（STOP）**：

- **第 5 步（退役）未开工**：验收是「前端 profile 端到端一轮通过」，本轮是 **4/5**，不满足。
  按 §6 的「先加后删」，删检查路径必须等一轮真正通过——本步没有删除任何代码；
- **F1 第二轮未跑**：§6.9 的约束、以及 slice-4 是否可过，都要下一批才知道（本轮已按你的决定
  在 run 1 后停止，未跑 2/3 轮）；
- **默认 profile 仍是 `backend-node`**：`frontend-vue` 可以选择（§6.6），但要不要设成默认，取决于
  F1 批次读数；在那一轮通过之前不切换；
- **§6.2 第 5 条未达成**：第一轮 4/5 切片（§6.8），CI + staging deploy + staging verify 三段未到达；
- 退役未开始（第 5 步）：可规划集合未收窄、`CHECK_CANDIDATES.DATABASE` / `MIGRATION_*` /
  `DEV_TASK_TYPES` 原样；`backend-agent` / `database-agent` 定义**按 §5.2 层 2 保留**；
- `specs` / `delivery.chain` / `testParser` / `fixtureTier` 字段已定义但**未接线**（提示词里的交付链
  仍是静态文本，测试输出仍走 `parseAcResults`）；
- **批次级等价仍未测**：第 1 步的完整验收要一次真实回归（`backend-node` 口径下的同一夹具）；
- **staging 段未验证**：它属交付链尾段，chain 停在 4 意味着三段（CI / staging deploy / staging verify）
  一次都没跑过。
