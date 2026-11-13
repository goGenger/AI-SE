# 231 · 功能清点：接入 / 移除 / 明确不做

> 触发：用户 2026-10-23——「之前的 `l1-m4v` 任务已经没有意义了，因为都不是真实的 PRD 和 TRD 文档……
> 更重要的是把现在项目上做了一半的功能进行接入或去除掉，等功能都确认了以后用真实的文档进行一次全流程测试。」
> 状态：**执行中**。§10 三项已由用户 2026-10-23「都按推荐值，从 T0 备份开始」全部按推荐值裁定；
> MCP 的三条裁定见 §3.3。执行记录见 **`docs/232`**（按 T 序号追加，T0 已完成）。

---

## 1. 这份表要解决什么

仓库里有一批**代码已存在、但生产主链路走不到**的能力。它们此前被有意保留（`README.md`「接线状态」），
代价是：真实需求一旦点名这些能力，平台接不住，而验收读数里**完全看不出**这件事。

本表对每一项做**三选一**，并写清代价：

| 结论 | 含义 |
| --- | --- |
| **接入** | 接进生产主链路，纳入验收与读数 |
| **移除** | 删除代码与测试，不留半成品（**不可逆，见 §5**） |
| **明确不做** | 保留现状，但在 README / `docs/17` 里写成结论，不再叫「接线状态」 |

---

## 2. 总表

| # | 能力 | 证据（2026-10-23 实查） | 现状 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | **MCP 工具联邦** | `toUnifiedToolDefinition`（`packages/mcp/src/integration/adapter.ts:157`）；`listVisibleToolDefinitions`（`packages/mcp/src/registry/persistentRegistry.ts:466`）；注入点 `apps/server/src/services/workflowTaskExecutor.ts:342` | 注册/发现/绑定/控制台全通；**agent 拿不到 MCP 工具**；**没有 `POST /api/mcp/servers`** | **接入** |
| 2 | **浏览器 / computer-use** | `@ai-se/browser` 1368 行（生产）；`playwright` 在 `packages/browser/package.json` 里是 **devDependency** | 无生产调用者；生产依赖里没有 playwright | **接入** |
| 3 | **视觉修复闭环** | `runVisualFixLoop`（`apps/server/src/services/visualFixLoop.ts:182`）**零生产调用者**；`@ai-se/visual` 3207 行 | 只有测试在调；需要真实 VLM，平台**没有视觉模型配置** | **接入**（与 2 绑定） |
| 4 | **`failure-recovery` 包** | 包 381 行 + 测试 363 行；`ActionRecoveryExecutor`（`apps/server/src/services/actionRecoveryExecutor.ts`，292 行）**无构造点**；e2e 1034 行 | 死代码；`WorkflowEngine` 已有 RETRY/REPLAN/ROLLBACK/HUMAN | **移除** |
| 5 | **`audit_logs` 表** | 全仓**零写入方**（只有 `packages/mcp/src/persistence.ts:20` 的一句注释） | 空表 | **明确不做**（不删表，见 §5.2） |
| 6 | **并行调度** | `enforceSerialWorkflowPolicy`（`packages/shared/src/index.ts:1215`）在 `workflowService.ts:102` **实时生效** | 钳制生效中，调度器本身支持并行 | **明确不做** |
| 7 | **用户体系 / 鉴权** | `users` 表**零引用**；只有可选静态 Bearer Token | 无用户模型 | **明确不做** |

---

## 3. 接入组 ①：MCP 工具联邦

### 3.1 三段缺口（全部实查）

| 缺口 | 现状 |
| --- | --- |
| **注册入口** | `routes/mcp.ts` 只有 `GET /servers`、`GET /servers/:id`、`GET /servers/:id/tools`、绑定 CRUD；**没有 `POST /servers`**，前端 MCP 页也没有「添加」 |
| **注入点** | `workflowTaskExecutor.ts:342` 只拿 `createPhase1Tools()`，MCP 定义一条都进不了 `ToolRuntime` |
| **允许判定** | `definition.tools` 是 agent 的静态白名单；MCP 工具名不在里面会被同一行 filter 掉 |
| **工具开关**（实施时新发现） | `mcp_tools.enabled` 建表默认 **FALSE**（迁移 008 原话「must be explicitly enabled」），而可见性链要求 `tool.enabled`；**全仓没有任何启停接口或界面** ⇒ 发现的工具永远不可用 |

### 3.2 选择模型（已经存在的答案）

平台**不在运行时「选」MCP**——绑定就是授权。漏斗：

```
① 服务器级 enabled && status != REVOKED && 连得上
② 绑定期   项目绑定 / 项目+agent / 项目+agent+工具（CreateMCPBindingSchema 三个可选维度）
③ 策略级   policyFor() 拒绝的不注入
④ 白名单   agentToolAllowlist ∩ agent.tools
⑤ 任务期   转成 ToolDefinition 注入 ToolRuntime
⑥ 模型期   LLM 按工具名与描述挑一个调用
```

未绑定 = 不可见（`isToolVisible` 里 `!query.projectId → false`，fail-closed）。
**谁该用哪个 MCP 是授权问题，不是调度问题**——平台若在运行时「智能选」，就失去了解释「它为什么调了生产库」的能力。

**实施时校正（2026-10-23）**：上表 ② 的三种绑定维度**不是三选一**。`isMCPToolVisible` 是
`serverEnabled && projectBound && agentBound && toolEnabled && policyAllowed` 的 AND——
项目级与 agent 级绑定必须**同时存在**，且工具本身必须已启用。三步缺一，工具就是不可见。

### 3.3 三条裁定（用户 2026-10-23「都按推荐值」已落定）

| # | 问题 | 裁定 |
| --- | --- | --- |
| 1 | 同名工具撞车 | **命名空间** ~~`mcp.<server别名>.<tool>`~~ → **`mcp__<server别名>__<tool>`**（见下方修正）；绑定期拒绝重名。不靠运行时去重 |
| 2 | 可见工具过多 | 每任务注入**上限 20 个**，超出按绑定优先级截断，记「被截断」事件 |
| 3 | 服务器中途掉线 | 任务开始时**快照**工具集；掉线工具的调用直接 DENY，不重算列表 |

**第 1 条的修正（2026-10-23，实施时实测）**：点号命名在模型 API 上跑不通。对当前
`OPENAI_BASE_URL` 实测：

| 工具名 | 结果 |
| --- | --- |
| `mcp.demo.echo` | **HTTP 400** — `Invalid 'tools[0].function.name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'` |
| `mcp__demo__echo` | **HTTP 200** |

用户 2026-10-23 再裁定：**改用双下划线**。信息量相同，且是 MCP 桥接的事实惯例。
工具名里其余非法字符（如 `.`）一律降为 `_`（`search.web` → `search_web`）。

### 3.4 代价

- `POST /api/mcp/servers` + 前端表单（传输方式 stdio/http、命令/地址、凭据）
- 注入点改造 + 命名空间 + 上限 + 快照
- **验证边界扩大**：MCP 工具改的是外部系统，验证门只看工作区 ⇒ 写操作必须走既有 approval，默认只放行只读/低风险

---

## 4. 接入组 ②：浏览器 + 视觉修复闭环

两者是一件事的两半：浏览器负责截图与 DOM 断言，视觉闭环负责把「看起来不对」变成可执行的修复任务。
只接一半等于多一条永远跑不通的路径，**必须同批接入**。

### 4.1 新发现的硬阻塞

**`playwright` 是 `@ai-se/browser` 的 devDependency**（`packages/browser/package.json`）。
生产环境里这个包一旦被调用就会缺依赖。接入前必须：
1. 把 `playwright` 提升为 **dependencies**；
2. 部署侧保证 Chromium 可用（本机 `~/Library/Caches/ms-playwright` 已有 chromium-1228/1234）。

**已于 T3 解决**（`docs/232` §T3）：`playwright@1.61.0` 移入 `dependencies`，`@playwright/test` 留 dev。

### 4.1b 实施时的新发现：缺的是**参照侧**，不是 VLM

`runVisualFixLoop` 的输入是「候选截图 vs 参照截图」两侧的 VLM 分析。实测与普查结果：

| 输入 | 生产来源 | 状态 |
| --- | --- | --- |
| 候选截图 | 浏览器现拍 | ✅ T3 已打通（真实 Chromium） |
| 候选分析 | `OpenAIWireVLMProvider` | ✅ 网关接受图片（实测 HTTP 200） |
| **参照侧（设计稿）** | **无** | ❌ 没有上传入口；`VisualSpecification` 在生产代码里**零产出**，只由测试构造 |

于是闭环卡在「比较」这一步。**只接取证那一半**，并用 `unavailable` 表达另一半（§4.2b）。

**参照侧已裁定（用户 2026-10-23「按 ② 基线回归」）**：不引入设计稿上传，改用**基线回归**——
同一入口页的第一次截图即基线，之后比「是否比上次更糟」（渲染是否仍收敛、控制台/网络错误是否变多、
截图为空）。信号以 `visual_regression_detected` 事件上报；自动产出修复任务**未接**
（理由见 `docs/232` §T3-6）。

### 4.2 设计裁定（推荐值，待确认）

| # | 事项 | 推荐 |
| --- | --- | --- |
| a | **何时触发** | 只在「本切片有 UI 交付物」的任务成功**之后**跑一次；失败产出 FIX 任务，**复用既有 REPLAN/DEBUG 机制**，不新建失败体系 |
| b | **VLM 缺失时** | 平台没有视觉模型配置 ⇒ 闭环记 `unavailable` 并**跳过**，既不判失败也不静默通过（与 `N-15′` 的不可裁决口径一致） |
| c | **在判定中的位置** | 截图与 DOM 断言是**附加证据**，不替代现有验证门，不改变 staging 段判据 |
| d | **成本** | Chromium 是重依赖（镜像体积 + 内存）；沙箱当前 `--cpus 1`，截图任务会拖长单任务时间 |

---

## 5. 移除组

### 5.1 `failure-recovery`（-2,070 行）

| 文件 | 行数 |
| --- | --- |
| `packages/failure-recovery/src`（生产） | 381 |
| `packages/failure-recovery/src/__tests__` | 363 |
| `apps/server/src/services/actionRecoveryExecutor.ts` | 292 |
| `apps/server/src/__tests__/failureRecovery.e2e.test.ts` | 1,034 |
| 合计 | **2,070** |

**为什么移除而不是接入**：`WorkflowEngine` 已有 RETRY / REPLAN / ROLLBACK / HUMAN 的分派，
再接一套分类 + 路由就是**第二套失败体系**，违反 `AGENTS.md` §10 的架构不变量。
且 `ActionRecoveryExecutor` 从来没有任何构造点——它连「半成品」都算不上，是死代码。

**副作用（须预先声明）**：`failureRecovery.e2e.test.ts` 是既有 flake 名单里的一条
（CANCELLED 形态）。删掉它**会减少一个测试文件**，读数下降不是回归。

### 5.2 `audit_logs` / `users`：不删表

**建议只做文档层面移除**（README 删除该行、`docs/17` 写明「不计划」），**不写 drop 迁移**：
删表需要一条不可回滚的迁移，而这张空表既不影响正确性也不影响体积；
在这个**没有 git** 的目录里，任何 `DROP` 都是净风险。

---

## 6. 明确不做组

| 项 | 写成什么结论 |
| --- | --- |
| **并行调度** | `maxConcurrency` 在创建期被钳为 1（`enforceSerialWorkflowPolicy`，实时生效）。单实例、无租约，解钳会引入新的并发缺陷；**当前缺的是稳定性不是吞吐** |
| **用户体系 / 鉴权** | 没有多租户目标；只有可选静态 Bearer Token。仓库定位是「带评测实验室的 PRD 级交付平台原型」，不是企业平台 |

---

## 7. 待验证项（不是半成品，是没验完）

| 项 | 状态 |
| --- | --- |
| **D1-5 / D1-6**（文档入口：技术文档进规划、冲突上报） | 契约、事件、页面齐备；**未用真实模型跑过**（`docs/230` §11） |

---

## 8. 缺陷项（与功能清点分开记）

| 编号 | 一句话 | 处置建议 |
| --- | --- | --- |
| **N-37** | 崩溃恢复路径绕过任务状态机、不消耗重试预算 | **先修**（`recover()` 是全仓唯一绕过 `assertTaskTransition` 的写入） |
| **N-39** | 验证门口径由「平台怎么启动」决定，批次脚本只查 dist 时间 | **先修**（起跑前断言运行时口径），否则任何批次读数都不可比 |
| **N-40** | 验证门按 AC 编号选测试，但编号从没告诉 agent | **先修**（把 AC 编号写进任务上下文） |

---

## 9. 建议的执行顺序

| 阶段 | 内容 | 出口 |
| --- | --- | --- |
| **T0 备份** | 无 git ⇒ 整仓打包（或至少 `packages/{browser,visual,failure-recovery}` + `apps/server`） | 备份存在且可解压 |
| **T1 移除** | `failure-recovery` + `ActionRecoveryExecutor` + 相关测试；README / `docs/17` 口径改写 | 全仓门禁绿；读数变化已声明 |
| **T2 MCP** | 注册入口 → 命名空间/上限/快照 → 注入 `ToolRuntime` | 能手动添加服务器、绑定、agent 真的调到工具 |
| **T3 浏览器视觉** | playwright 运行时化 → 触发点 → `unavailable` 口径 | UI 交付物的截图证据进入任务输出 |
| **T4 缺陷** | N-37 / N-39 / N-40 | 三条关闭 |
| **T5 真实文档全流程** | 一份真实 PRD + 一份真实 TRD（含 MCP 要求）+ 真实仓库 | 端到端跑通，产物可交付 |

**`l1-m4v` 的位置**：降级为**回归检查**，放在 T4 之后跑一次防退化，不再占验收位置。

---

## 10. 待裁定项（三项，均带推荐值）

**裁定结果（用户 2026-10-23「都按推荐值，从 T0 备份开始」）**：三项全部取推荐值 ——
①`failure-recovery` **移除**；②浏览器/视觉**按 §4.2 推荐值接入**；③T5 的真实文档**由用户提供**。

| # | 事项 | 选项 | 推荐 |
| --- | --- | --- | --- |
| 1 | **`failure-recovery` 处置** | A. 移除（§5.1）；B. 接入 | **A**。它是死代码 + 第二套失败体系 |
| 2 | **浏览器/视觉的触发与降级**（§4.2 a/b/c） | A. 按推荐值；B. 只接浏览器不接视觉；C. 都先不接 | **A**。接一半等于多一条跑不通的路径 |
| 3 | **T5 的「真实文档」从哪来** | A. 你提供 PRD + TRD；B. 用某个开源项目的真实文档 | **A**。这个阶段的判据就是「你的真实工作流能不能走通」 |
