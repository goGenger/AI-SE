# 232 · 功能清点执行记录（T0–T5）

> 清点表：**`docs/231`** ｜ 三项裁定：用户 2026-10-23「都按推荐值，从 T0 备份开始」
> 本文件按 T 序号逐段追加，每段一个阶段边界（`AGENTS.md` §9）。

---

## T0 · 备份（2026-10-23）

### 1. 为什么要备份

本目录**没有 git**（`AGENTS.md` §1）。T1 要删除 **2,070 行**代码，删除后唯一的还原路径就是这份归档。
备份不是仪式，它是「移除」这个动作能被批准的前提。

### 2. 产物

| 项 | 值 |
| --- | --- |
| 归档 | `~/Desktop/study/ai-se-backups/ai-se-full-20261023-165040.tar.gz` |
| 体积 | 8,656,049 字节（8.3 MB） |
| sha256 | `b1d49251ea8133527c6893005229767e861c532fcf3a9546023a9b77df3e1710` |
| 条目数 | 3,305 |
| 清单 | 同目录 `manifest-T0-20261023-165040.txt`（sha256 + 行数，含锁文件基线） |
| 位置 | **仓库之外**（`~/Desktop/study/ai-se-backups/`），避免被下一次备份或清理卷进去 |

**为什么在仓库外**：归档如果放在 `AI_SE/` 里，会同时被后续的全仓门禁、`du`、以及下一次备份扫到，
既污染读数又可能自我嵌套。

### 3. 范围与排除项

| 内容 | 处置 | 理由 |
| --- | --- | --- |
| 全部源码（`apps/` `packages/` `docs/` `examples/` `infrastructure/` 配置） | **纳入** | 这是要保护的东西 |
| 各包 `dist/` | **纳入**（842 条） | 还原后不必重新构建即可启动平台；体积可忽略 |
| 根 `node_modules/` | **排除** | 405 MB / 441 MB，全是 pnpm 链接，可重建 |
| `.DS_Store` | 排除 | 无意义 |
| `.env` | **纳入**（必须） | 缺它平台起不来 |

**如实标注的副作用**：包级 `node_modules/*` 里的 pnpm 符号链接指向根 `node_modules/.pnpm/`，
根目录被排除 ⇒ **还原后必须先 `corepack pnpm install --no-frozen-lockfile`**，否则 `dist/` 在、
依赖链断。归档不是「解压即运行」，是「解压 + install 即运行」。

**安全提示**：`.env` 含凭据，随归档一起打包。这份 tar 不得上传、不得复制到共享盘、不得贴进任何外部工具。

### 4. 验证（三项，全部实跑）

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 压缩完整性 | `gzip -t` | **GZIP_OK** |
| 关键路径在档 | `tar -tzf … <path>` 逐条 | `AGENTS.md` / `.env` / `packages/failure-recovery/src` / `actionRecoveryExecutor.ts` / `failureRecovery.e2e.test.ts` / `packages/browser/package.json` **全部 PRESENT** |
| **还原演练** | 解出 `packages/failure-recovery` 到临时目录，与在用目录 `diff -r --no-dereference` | **DIFF_EXIT=0，零差异**（21 个文件 + 3 个符号链接逐字节一致） |

还原演练选 `failure-recovery` 不是随手挑的——**它就是 T1 要删的那个包**。演练对象与待删对象一致，
这份归档才真的能兜住 T1。

### 5. 删除集合的清点核对（与 `docs/231` §5.1 对齐）

按 `manifest-T0` 实测行数：

| 文件 | 行数 |
| --- | --- |
| `packages/failure-recovery/src/{classification,index,reobserve,router,routing}.ts` | 120 + 13 + 43 + 106 + 99 = **381** |
| `packages/failure-recovery/src/__tests__/failureRecovery.test.ts` | **363** |
| `apps/server/src/services/actionRecoveryExecutor.ts` | **292** |
| `apps/server/src/__tests__/failureRecovery.e2e.test.ts` | **1,034** |
| 合计 | **2,070** |

与 `docs/231` §5.1 的表**逐项吻合**，无需修正。

### 6. 读数基线（T1 完成后用来声明变化）

上一次全仓门禁（`docs/230` §8，D1 阶段收尾，此后无代码变更）：

| 指标 | 基线 |
| --- | --- |
| 全仓测试 | **1944 / 1944 通过**，16 个包全绿 |
| `@ai-se/failure-recovery` | **16 例** |
| `apps/server` | **370 例**（含 `failureRecovery.e2e.test.ts` 的用例） |
| 包数 | **16** |

T1 完成后预期：包数 16 → **15**，全仓测试数下降（删掉的是用例而不是让用例失败），
`typecheck` / `lint` / `test` 三个退出码仍须全 0。

---

## 7. T0 验收

| 判据（`docs/231` §9 T0 出口） | 结果 |
| --- | --- |
| 备份存在 | ✅ 8.3 MB 归档 + sha256 旁挂 |
| 可解压 | ✅ `gzip -t` 通过；还原演练逐字节一致 |

**T0 完成。**

---

## T1 · 移除 `failure-recovery`（2026-10-23）

用户「开始 T1」。结论：**删除 2,070 行、1 个包、26 条用例；全仓门禁 1922/1922 通过。**

### 1. 动手前的引用普查（没有这步就删是不可逆的）

全树 grep（排除 `node_modules` / `dist` / `docs`）三个关键词：`@ai-se/failure-recovery`、
`ActionRecoveryExecutor`、`createRecoveryRouter`。结果：

| 命中位置 | 性质 | 处置 |
| --- | --- | --- |
| `packages/failure-recovery/**` | 被删对象自身 | 删 |
| `apps/server/src/services/actionRecoveryExecutor.ts` | 被删对象自身 | 删 |
| `apps/server/src/__tests__/failureRecovery.e2e.test.ts` | 被删对象自身 | 删 |
| `apps/server/package.json` ×3 | `build` / `typecheck` 链 + `workspace:*` 依赖 | 摘除 |
| `README.md:66` | 活文档「接线状态」表的一行 | 删行 + 追加说明 |
| `pnpm-lock.yaml` ×3 | 依赖记录 | `pnpm install` 自动摘 |

**生产代码零引用**——组合根 `apps/server/src/index.ts` 里没有任何 `failureRouter` 传参，
与 `docs/231` §5.1「死代码」的判断一致。

### 2. 一处必须说清的边界：`failureRouter` 不是这个包

`WorkflowEngine.failureRouter`（`packages/workflow-engine/src/WorkflowEngine.ts:190`）的**类型**
`FailureRouter` 定义在 `packages/workflow-engine/src/types.ts:146`——**是引擎自己的扩展点**，
不是 `@ai-se/failure-recovery` 导出的东西。`workflow-engine` 只依赖 `@ai-se/shared`。

因此删包**不动引擎**：`WorkflowEngine.test.ts` 里 5 处 `failureRouter` 用法（用本地 `routerFor`
构造）继续有效，`workflowService.ts:70/90` 的透传参数也保留。删掉的只是这个接缝的**一个实现者**。
这是本次改动爆炸半径最小的关键事实。

### 3. 实际删除清单（与 §5 的清点逐项吻合）

| 路径 | 行数 | 状态 |
| --- | --- | --- |
| `packages/failure-recovery/`（整目录，含 `dist/`） | 生产 381 + 测试 363 | 已删 |
| `apps/server/src/services/actionRecoveryExecutor.ts` | 292 | 已删 |
| `apps/server/src/__tests__/failureRecovery.e2e.test.ts` | 1,034 | 已删 |
| 合计 | **2,070** | |

**同时清掉的陈旧构建产物**（`tsc` 不会删除已消失源文件的输出，留着就是指向不存在包的雷）：
`apps/server/dist/services/actionRecoveryExecutor.{js,d.ts}`、`dist/__tests__/failureRecovery.e2e.test.{js,d.ts}`。
清理后 `grep -rl "failure-recovery|actionRecoveryExecutor" apps/server/dist` → **零命中**。

`pnpm install --no-frozen-lockfile` 后：`pnpm-lock.yaml` 零残留、
`apps/server/node_modules/@ai-se/` 剩 12 个包（无 failure-recovery）。

### 4. 门禁读数

**三个阶段分开跑，退出码逐条记录**：

| 命令 | 结果 |
| --- | --- |
| `corepack pnpm -r run typecheck` | **TYPECHECK_EXIT=0** |
| `corepack pnpm -r run lint` | **LINT_EXIT=0** |
| `corepack pnpm -r run test` | **TEST_EXIT=0** — **1922/1922 通过**，**15 个包全绿** |

各包读数：`agent-core` **269**、`server` **360**、`web` **509**、`mcp` **235**、`shared` **178**、
`visual` **83**、`workflow-engine` **68**、`eval` **65**、`database` **52**、`browser` **38**、
`tool-runtime` **32**、`action-policy` **13**、`evidence` **9**、`sandbox` **8**、`observability` **3**。

### 5. 读数变化声明（预先说清，避免被误读成回归）

| 指标 | T0 基线 | T1 之后 | 差 |
| --- | --- | --- | --- |
| 测试通过数 | 1944 | **1922** | **−22** |
| 包数 | 16 | **15** | −1 |
| 删除的用例 | — | 26 条（`failure-recovery` 16 + e2e 10） | |

−22 而不是 −26 的差额是 **+4**：`docs/230` §8 记的 `web` **505** 是那次门禁的读数，
而 `fileDropzone.test.ts` 的 4 例是同一阶段后补的，现在 `web` 是 **509**。
即：**1944 − 26 + 4 = 1922**。这是文档读数与最后一次实测之间的记账差，不是新增覆盖面。

**没有任何一条用例从「通过」变成「失败」**——减少的全是被删掉的用例本身。

### 6. 三次 e2e 抖动的逐次记录（按现行口径）

| 次 | 失败 | 证据 | 结论 |
| --- | --- | --- | --- |
| 第 1 次全仓 | `evidenceApi.e2e.test.ts` 单例超时 **5009ms** | 单独复跑 **5/5 通过（3.19s）** | 负载抖动 |
| 单包复跑 `apps/server` | `apiToken` / `workflowApi` / `workflowTrace` 共 3 例，`Error: socket hang up` | 三文件单独复跑 **15/15 通过（7.29s）** | **被测方的干扰**，见下 |
| 第 3 次全仓（环境静置后） | 无 | **1922/1922，TEST_EXIT=0** | 采纳为 T1 读数 |

第 2 次的成因已查实：开发服务器由 `tsx watch` 监管且 `--include ../../packages/*/dist/**`，
我执行 `pnpm --filter @ai-se/server build`（连带重建依赖包 dist）触发它在 **17:02:42** 重启，
而该次 `apps/server` 测试 **17:02:54** 开跑——中间只有 12 秒，平台正在连库、连 Redis，
`socket hang up` 是连接被重启进程掐断的形态，不是断言失败。**这类失败只出现在「构建/重启与测试重叠」时**，
所以第 3 次静置后重跑即全绿。

### 7. 平台重启时序（`restart-must-postdate-build`）

第一次核对**不合格**：`apps/server/dist/index.js` mtime `17:02:46`，而平台子进程启动于 `17:02:42`——
进程比构建早 4 秒。虽然平台以 `tsx watch src/index.ts` 直跑源码、且 `packages/*/dist` 均早于 17:02:42，
但按这条不变量的口径**不能算过**。

处置：确认库内无 `RUNNING`/`PENDING` 工作流（`workflow_runs` 最近 3 条为 FAILED / SUCCESS / CANCELLED）
后，`touch apps/server/src/index.ts` 触发 watcher 自身的重启机制（不是杀进程）。结果：
新子进程 **17:08:08** 启动 > 最后一次产物 **17:02:46**，`/health` → **200**。

### 8. 文档口径改写

| 文件 | 动作 |
| --- | --- |
| `README.md` | 删除「接线状态」表里 `failure-recovery` 那一行，并在表下追加一行说明（2026-10-23 按 `docs/231` 清点，该包已移除） |
| `docs/17` | 追加「功能清点 T1」节（历史条目按 `docs/146` §6 规则 7 冻结，只追加不改写） |
| `docs/146` §7 | 追加一条更新日志 |
| `docs/18` | 追加进度条目 |
| `docs/231` | 状态改「执行中」并登记三项裁定 |

---

## 9. T1 验收

| 判据（`docs/231` §9 T1 出口） | 结果 |
| --- | --- |
| 代码与测试已删除，不留半成品 | ✅ 2,070 行、1 个包、3 类陈旧产物；源码/配置/锁文件零残留引用 |
| 全仓门禁绿 | ✅ typecheck 0 / lint 0 / **test 1922/1922，15 包全绿** |
| 读数变化已声明 | ✅ §5：−22 = −26 删除 + 4 记账差，无「通过→失败」的转化 |
| 平台可运行 | ✅ 重启晚于构建，`/health` 200 |

**T1 完成。**

---

## T2 · MCP 工具联邦接入（2026-10-23）

用户「开始 T2」。这一阶段的目标是 `docs/231` §3.4 的那句：**能手动添加服务器、绑定、agent 真的调到工具**。
实施中发现的两件事比原计划更重要，先写在前面。

### 1. 两个必须纠正的前提（实测，不是推断）

#### 1.1 点号命名在模型 API 上直接 400

`docs/231` §3.3 第 1 条裁定的是 `mcp.<server>.<tool>`。对当前 `OPENAI_BASE_URL` 实测：

| 工具名 | 结果 |
| --- | --- |
| `mcp.demo.echo` | **HTTP 400**：`Invalid 'tools[0].function.name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'` |
| `mcp__demo__echo` | **HTTP 200** |

这不是风格偏好——带点号的工具名会让**整次模型调用**失败，等于 T2 白做。已按用户 2026-10-23 的再裁定
改为 **`mcp__<server>__<tool>`**。工具名里其余非法字符一律降为 `_`（`search.web` → `search_web`）。

> 探测方法：`POST {OPENAI_BASE_URL}/chat/completions`，带 `x-opencode-session` 头（缺它会先被路由层 400 挡住）。

#### 1.2 工具默认是关的，而且没有开关

`migrations/008_phase5_mcp_registry.sql`：`mcp_tools.enabled BOOLEAN NOT NULL DEFAULT FALSE`
（原文注释「must be explicitly enabled」）。而可见性链是：

```
isMCPToolVisible = serverEnabled && projectBound && agentBound && toolEnabled && policyAllowed
```

也就是说，**项目级绑定与 agent 级绑定必须同时存在**（不是 `docs/231` §3.2 暗示的三选一），
并且**工具本身必须已启用**。而全仓此前**没有任何工具启停接口或界面**——`routes/mcp.ts` 只 `GET /tools`，
详情页工具区是只读的。

结论：即使补上注册入口和注入点，**agent 依然永远调不到工具**。所以 T2 的范围里必须包含工具启停。

### 2. 实际改了什么

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 契约 | `packages/shared/src/index.ts` | `CreateMCPServerSchema`（形状校验，`.strict()`，**无 env 字段**）、`UpdateMCPToolSchema` |
| 服务 | `apps/server/src/services/mcpService.ts` | `createServer`（建行 → 启用即连接 → 发现工具；连不上仍返回，状态落 `lastError`）、`setToolEnabled`；`registryFor` 拆出 `registryForTransport` |
| 路由 | `apps/server/src/routes/mcp.ts` | `POST /api/mcp/servers`、`PATCH /api/mcp/servers/:serverId/tools/:toolId`；`MCPContractError` → 400 `MCP_SERVER_INVALID` |
| 注入 | `apps/server/src/services/mcpTaskToolSource.ts` | **新增**：`forTask()` 取一次快照，命名空间 + 上限 20 + 按绑定点名度排序 |
| 执行器 | `apps/server/src/services/workflowTaskExecutor.ts` | `mcpTools?` 依赖；任务开始时把 MCP 工具并入同一个 `ToolRuntime`；截断 / 不可用各记一条事件 |
| 组合根 | `apps/server/src/index.ts` | MCP store 与 registry 构造**上移到执行器之前**（同一批 registry 供 console 与任务共用） |
| 前端 | `api/mcp.ts` / `stores/mcp.ts` / `MCPServersView.vue` / `MCPServerDetailView.vue` / `viewmodels/mcpViewModel.ts` | 添加服务器对话框；工具启停按钮；`mcp__<名称>__<工具>` 的可见提示；空态动作改成「添加服务器」 |

### 3. 三条裁定的落地方式

| # | 裁定 | 落点 |
| --- | --- | --- |
| 1 | 命名空间 | `namespaceToolName()` + `assignServerAliases()`（同名服务器按 id 顺序得到 `-2`、`-3`，同一批内绝不撞名） |
| 2 | 上限 20 | `MCP_TASK_TOOL_LIMIT`；超出后**先留「点名了具体工具」的绑定**，再按名称稳定排序截断；调用方记 `mcp_tools_truncated` |
| 3 | 任务开始快照 | 每个任务只调一次 `forTask()`，任务期间不重算；掉线由 registry 的 `canExecute` 在**每次调用**时重新判定并 DENY |

**关于「掉线即 DENY」为什么不需要额外代码**：`toUnifiedToolDefinition` 的 `canExecute` 闭包在每次执行前
重新读 store 并重跑可见性链，fail-closed。快照只决定「工具名集合」，不决定「这次能不能调」。

**关于失败语义**：MCP 取不到工具**不阻断任务**（MCP 是可选能力来源，不是前置条件），
但会记 `mcp_tools_unavailable` 事件，避免「悄悄少了一批工具」。

### 4. 测试

| 文件 | 例数 | 覆盖 |
| --- | --- | --- |
| `apps/server/src/__tests__/mcpServerCreate.api.test.ts` | **5** | 201 + 立即连接发现；缺 command → 400 `MCP_SERVER_INVALID`；`env` 未知字段 → 400 `VALIDATION_ERROR`；端点内嵌凭据 → 400；连接失败仍 201 且状态 DEGRADED |
| `apps/server/src/__tests__/mcpTaskToolSource.test.ts` | **11** | 未绑定不可见；**只有项目级绑定也不可见**；工具默认关闭；命名空间与字符清洗；跨项目不漏；25→20 截断且报告总数；点名绑定优先；停用服务器不贡献；别名去重；空名回落 |
| `apps/web/src/__tests__/mcpServerForm.test.ts` | **8** | 表单 → 载荷：参数切分、必填缺失、传输方式决定字段、空描述不提交、禁用态 |

两个 server 侧测试用的是**真实的** `PersistentMCPRegistry` + `InMemoryMCPRegistryStore`，
只有 MCP 协议客户端是假的——可见性链、契约校验、发现顺序都是真跑的。

### 5. 门禁

| 命令 | 结果 |
| --- | --- |
| `corepack pnpm -r run typecheck` | **TYPECHECK_EXIT=0** |
| `corepack pnpm -r run lint` | **LINT_EXIT=0** |
| `corepack pnpm -r run test` | **1945 / 1946** —— 15 个包，唯一失败是既登记抖动（见下） |

各包读数：`web` **517**、`server` **376**、`agent-core` **269**、`mcp` **235**、`shared` **178**、
`visual` **83**、`workflow-engine` **68**、`eval` **65**、`database` **52**、`browser` **38**、
`tool-runtime` **32**、`action-policy` **13**、`evidence` **9**、`sandbox` **8**、`observability` **3**。

总数 1922 → **1946**（+24：server +16、web +8）。

**抖动逐次记录（按仓库既有口径，不据此改任何测试）**：

| 次 | 失败 | 隔离复跑 | 结论 |
| --- | --- | --- | --- |
| 并行全仓 #1 | `packages/browser` 真实 Chromium「launches / navigates / screenshots」 | **38/38 通过** | 并行争用 |
| 并行全仓 #2 | `packages/browser` 的 `interaction` + `responsive` 两例 | **38/38 通过** | 同上 |
| 串行全仓 | `apps/server` `terminationPropagation.e2e`「FX-35 任务取消」 | **5/5 通过** | `docs/178` / `docs/182` 已登记的同族抖动 |

串行跑（`--workspace-concurrency=1`）是为了拿一份**没有包间争用**的读数；即便如此仍有 1 例失败，
而它单独复跑即绿——与 `docs/167` 记录的方法一致：**先隔离复跑，再判定**。

### 6. 未做的验证（如实标注）

**没有对运行中的平台发过写请求。** 既有边界是「只读真实后端走查可以、写接口不行」，
所以「页面上点一次添加服务器 → 真实 discovery → agent 真调到工具」这条完整链路**没有实测**，
只到「API 级 + 注入层单测」。这条留到 **T5**（真实文档全流程，需要用户提供文档并允许写入）。

### 7. T2 验收

| 判据（`docs/231` §9 T2 出口） | 结果 |
| --- | --- |
| 能手动添加服务器 | ✅ `POST /api/mcp/servers` + 前端对话框（未在运行中的平台实测，见 §6） |
| 能绑定 | ✅ 既有绑定 API 未改；本阶段补齐了「必须项目级 + agent 级同时存在」的说明 |
| agent 真的调到工具 | ⚠️ **注入层已证**（真实 registry 产出的命名空间工具集）；**工作流级未跑**，随 T5 |

**T2 完成（代码与注入层）；端到端留到 T5。**

**平台**：`apps/server` 重建后最后产物为 `17:58:08`，`tsx watch` 子进程当时是 `17:58:04`（早 4 秒，不合格）；
用 watcher 自身机制触发一次干净重启 → 新子进程 **`17:58:45`** > `17:58:08`，`/health` **200**。
**只读**验证新路由已挂载：空 body 的 `POST /api/mcp/servers` 返回 **400 `VALIDATION_ERROR`**（不是 404），未写入任何数据。

---

## T3 · 浏览器 / 视觉（2026-10-23）

用户「开始 T3」。这一阶段按计划先解决硬阻塞，然后是**一个必须在动手前说清的发现**。

> 2026-11-11 更新：T3 落地的任务级视觉取证仍是非阻塞附加证据（`file://`、失败不挡任务）。切片末会红灯的官方设计意图审查见 [docs/265](./265-visual-intent-gate.md) 第 2 步，不再把本阶段的取证路径当成视觉验收。

### 1. 硬阻塞已解：`playwright` 从 devDependency 提升为 dependencies

`packages/browser/package.json`：`playwright@1.61.0` 移到 `dependencies`，`@playwright/test` 留在
`devDependencies`（测试专用）。锁文件已核对：`packages/browser.dependencies.playwright: 1.61.0`。
本机 Chromium 可用（`packages/browser` 的 38 例真实 Chromium e2e 一直全绿）。

### 2. 发现：视觉修复闭环缺的不是 VLM，是**参照侧**

`runVisualFixLoop`（`apps/server/src/services/visualFixLoop.ts:182`）的输入是
`reference: EvaluationSide` 与 `candidate: EvaluationSide` 两侧的 VLM 分析，比较后才产出问题清单。

| 输入 | 生产来源 | 状态 |
| --- | --- | --- |
| 候选截图 | 浏览器现拍 | ✅ 本阶段已打通 |
| 候选分析 | VLM（`OpenAIWireVLMProvider`） | ✅ 网关接受图片输入（实测 HTTP 200） |
| **参照侧（设计稿）** | **无** | ❌ 产品里没有上传设计参照的入口；`VisualSpecification` 在仓库里**只由测试构造**（`grep` 生产代码零产出） |

也就是说：硬接 `runVisualFixLoop` 会得到一条**每次都在比较这一步失败**的路径——
正是清点表 §4 警告的「跑不通的路径」。**因此本阶段只接取证那一半**，
并用 `unavailable` 表达另一半（§4.2b 的降级口径）。

### 3. 实际改了什么

| 文件 | 内容 |
| --- | --- |
| `packages/browser/package.json` | playwright → dependencies |
| `apps/server/src/services/visualEvidenceService.ts` | **新增**：判断 UI 交付物 → 选入口页 → 真实 Chromium 以 `file:` 打开（该会话的最小权限 allowlist 只有 `file`）→ 等渲染稳定 → 截图 + 控制台/网络错误计数 |
| `apps/server/src/services/workflowTaskExecutor.ts` | `visualEvidence?` 依赖；任务 **SUCCESS** 且有 UI 写入时取证；截图落 `agent_artifacts`，发 `visual_evidence_captured` / `visual_evidence_unavailable` |
| `apps/server/src/index.ts` | 用 `createRealPlaywright()` 装配 |

**三条边界**（§4.2 的落地）：

| 裁定 | 落点 |
| --- | --- |
| a. 只在 UI 交付物成功后跑一次 | 仅当 `outcome.status === "SUCCESS"` 且本任务写过 `.html/.vue/.tsx/.jsx/.css` 时触发 |
| b. 缺失即 `unavailable` | 无 UI 交付物 / 无入口页 / 浏览器起不来 → 记事件并**跳过**，不判失败也不静默通过 |
| c. 附加证据，不改变判据 | 截图不进验证门；`verify` 段的判据一字未动 |

**为什么用 `GENERATED_FILE` 而不是 `SCREENSHOT`**：`agent_artifacts.type` 是带 CHECK 的封闭集合
（迁移 005），没有这个类型。截图确实是本任务生成的文件，用 `GENERATED_FILE` + `metadata.kind = "ui_screenshot"`
区分，不为一条证据行加迁移。

### 4. 测试

| 文件 | 例数 | 覆盖 |
| --- | --- | --- |
| `apps/server/src/__tests__/visualEvidenceService.test.ts` | **9** | 扩展名判定；入口页优先级；无 UI/无入口**不碰浏览器**；浏览器失败 → `browser-failed` 带可读原因；**真实 Chromium** 渲染临时页面并截出非空 PNG |

### 5. 门禁

| 命令 | 结果 |
| --- | --- |
| `corepack pnpm -r run typecheck` | **TYPECHECK_EXIT=0** |
| `corepack pnpm -r run lint` | **LINT_EXIT=0** |
| `corepack pnpm -r --workspace-concurrency=1 run test` | **1961 / 1964**；3 例失败全部是既登记抖动，两文件**隔离复跑 9/9 通过** |

各包读数：`web` **517**、`server` **391**、`agent-core` **269**、`mcp` **235**、`shared` **178**、
`visual` **83**、`workflow-engine` **68**、`eval` **65**、`database` **55**、`browser` **38**、
`tool-runtime` **32**、`action-policy` **13**、`evidence` **9**、`sandbox` **8**、`observability` **3**。

总数 1946 → **1964**（+18：`server` +15 取证与基线、`database` +3 基线查询）。

**抖动（逐次记录，不据此改测试）**：`apps/server` 的 `terminationPropagation`（FX-35、FX-36）与
`v1GoldenScenario`（server restart）共 3 例失败；**两文件一起隔离复跑 9/9 通过**。
它们都是 `docs/178` / `docs/182` 记录在案的重型 e2e，本轮之前已有同一族不同用例多次被点到。

### 6. 平台重启（含一次事故）

重建 `apps/server` 后（产物 `18:42:49`）发现 **`tsx watch` 的开发服务器已经不在运行**：
父进程 `11365` 消失、3000 端口无监听、`/health` 无响应。用与原来相同的入口（`apps/server` 下
`corepack pnpm dev`，与消失实例的命令行一致）重新拉起，新进程 **`18:45:17`** 启动 > 构建 `18:42:49`，
`/health` **200**、日志有 `server started`。

**如实记录两点**：①这台开发服务器在 T2 期间由 `touch` 触发的多次重启中消失，**原因未查明**
（`tsx watch` 的父进程直接不在了，不是子进程崩溃后父进程存活那种形态）；②新实例走 `pnpm dev`，
验证门口径取配置默认（`observe`）——「口径由启动方式决定」正是 **N-39**，属 T4 范围。

### 6. 基线回归（用户 2026-10-23 裁定 ②）

参照侧不来自设计稿，来自**这个项目自己**：同一入口页的**第一次**截图即基线，之后每次比「是否比上次更糟」。

| 项 | 落点 |
| --- | --- |
| 基线存储 | `agent_artifacts`，`metadata.kind = "ui_screenshot_baseline"`（首次），后续为 `"ui_screenshot"` |
| 基线查询 | `PgAgentArtifactRepository.findLatestByMetadataKind(projectId, kind)`（新增；`metadata->>'kind'` + 按项目隔离） |
| 比较 | `compareVisualEvidence(baseline, candidate)` **纯函数**，只用不依赖 VLM 的确定性指标 |
| 回归信号 | `render-no-longer-settles`（基线收敛、候选超时）/ `console-errors-increased` / `network-errors-increased` / `screenshot-empty` |
| 上报 | `visual_regression_detected` 事件（含基线与候选的全部指标、基线工件 id） |

**只把「变多」算回归**：错误变少或持平都不算——页面可能在改进。
**入口页不同则不比较**：那是另一个页面，先记它自己的基线。

**为什么没有自动产出 FIX 任务（须明说）**：仓库里触发修复的唯一通道是「任务失败 → 引擎的
REPLAN/DEBUG 分派」。要让一次视觉回归走这条通道，必须把一个**已经成功**的任务翻成失败——
那会把成功率读数和 `agent_runs.status` 一起污染，并且在没有真实数据前无法判断会不会形成
「改页面 → 判回归 → 修页面」的循环。本阶段因此把基线回归做成**可观测信号**（事件 + 工件），
修复动作等拿到真实信号质量后再定。这与 §4.2a「复用既有机制」不冲突：**没有新建失败体系**，
只是没有强行把一个成功任务改写成失败。

### 7. 未做的部分（如实标注）

1. **DOM 断言未做**：需要一个消费它的校验规则；当前只落截图与错误计数。
2. **运行中端到端未跑**：与 T2 同理，需要一次真实任务；随 T5。
3. **回归 → 自动修复未接**：见 §6 最后一段的理由。

### 8. T3 验收

| 判据（`docs/231` §9 T3 出口） | 结果 |
| --- | --- |
| `playwright` 运行时化 | ✅ dependencies，锁文件已核对 |
| 触发点接入 | ✅ UI 交付物成功后一次 |
| `unavailable` 口径 | ✅ 三种原因，均不阻断任务 |
| 截图证据进入任务输出 | ✅ `agent_artifacts`（`metadata.kind = "ui_screenshot"`）+ 事件 |
| 视觉修复闭环 | ⚠️ **基线回归已接（检测 + 事件）**；自动产出 FIX 任务未接，理由见 §6 |

**T3 完成（取证 + 基线回归检测）；自动修复未接，理由已写明。**

---

## T4 · 三条缺陷（2026-10-23）

用户「开始 T4」。三条都是「读数不可信」类的缺陷，修法都尽量小。

### 1. N-37 · 崩溃恢复绕过状态机、不消耗重试预算

**现场**：`PgWorkflowStore.recoverRunningTasks` 是一条裸 `UPDATE ... SET status='RETRYING'`，
而任务状态机里 **`RUNNING` 根本没有 `RETRYING` 这条边**（`RUNNING: [SUCCESS, FAILED, CANCELLED]`）。
所以它不只是「绕过校验」，它是**在表里非法的情况下照写不误**；并且不加 `retry_count`，
进程反复崩溃时同一任务可以被无上限地重新排队。

**修法（三处）**：

| 文件 | 改动 |
| --- | --- |
| `packages/workflow-engine/src/stateMachine.ts` | 把 `RUNNING → RETRYING` 变成**显式合法的崩溃恢复边**（并注明它只用于恢复） |
| `packages/workflow-engine/src/WorkflowEngine.ts` | `recover()` 先取任务、对每个 `RUNNING` 调 `assertTaskTransition(..., "RETRYING")`，再落库 |
| `packages/database/src/workflowRepositories.ts` | 恢复写入同时 `retry_count = retry_count + 1` 与 `updated_at = now()` |

**没有**新增错误体系或新表：只是让既有写入过既有的状态机，并把预算记上。

### 2. N-39 · 验证门口径由「平台怎么启动」决定

**现场**：`modeFor()` 是 `isAutonomyAtLeastL1(policy) ? "enforce" : this.mode`，而 `this.mode` 来自
`VERIFICATION_GATE` 环境变量（默认 `observe`）。启动脚本会导出 `enforce`，直接 `pnpm dev` 不会——
于是两批读数可以在不同规则下产生，而批次脚本只查 dist 时间，看不出这件事。

**修法**：把口径暴露到**运行时可达**的地方，让「起跑前断言」成为可能。

| 文件 | 改动 |
| --- | --- |
| `apps/server/src/app.ts` | `AppDependencies.verificationGate?`；`/health` 返回 `{ status, verificationGate? }`（未配置则字段缺席，不编造） |
| `apps/server/src/index.ts` | 传入 `config.verificationGate` |
| `packages/eval/scripts/l1-m4v-e1-x3.sh` | 健康检查之后**断言** `verificationGate == $EXPECTED_GATE`（默认 `enforce`），不符即 `exit 5`，不花配额 |

**边界（如实）**：`/health` 报的是**全局默认**。L1/L2 策略仍会按 `modeFor` 强制 `enforce`，
所以「全局 observe + L1 策略」下实际执行仍是 enforce——这个字段帮不到那一层，见 Known Issues。

### 3. N-40 · 验证门按 AC 编号选测试，编号却从没告诉 agent

**现场**：`taskVerifier` 的 test 检查用 `[AC-xx]` 标记选取；任务没声明 `acKeys` 时用同切片的并集
（`sliceScopeFallback`）。而**任务提示词里没有任何编号**——agent 写出的测试没有标记，选取恒为零，
任务被判「没有证据」。`l1-m4v` 连续三次死在这一步。

**修法**：把「切片 AC 范围」的**唯一口径**上移，让提示词与校验器共用它。

| 文件 | 改动 |
| --- | --- |
| `packages/shared/src/index.ts` | 新增 `taskAcKeys(task)` / `sliceAcKeys(sliceTasks, first?)`（从 `taskVerifier` 上移，实现一字未改） |
| `apps/server/src/services/taskVerifier.ts` | 删掉本地两份定义，改从 `@ai-se/shared` 导入 |
| `apps/server/src/services/taskContextBuilder.ts` | 新增 `acceptanceScope(workflow, task)`：任务自声明优先，否则同切片并集；读库失败降级为空数组 |
| `apps/server/src/services/workflowTaskExecutor.ts` | 提示词末尾追加 `Acceptance criteria this task must cover: …` 与「测试名必须带标记」的说明 |

### 4. 测试

| 包 | 新增 | 覆盖 |
| --- | --- | --- |
| `packages/shared` | **+5** | `taskAcKeys` 的 trim/降级；`sliceAcKeys` 的并集、去重、`first` 顺序、空集合 |
| `packages/workflow-engine` | **+2** | `RUNNING → RETRYING` 合法且可断言；没有打开其它新的 `RUNNING` 出口 |
| `packages/database` | **+1** | 真 PG：恢复把 RUNNING 改成 RETRYING **且 `retry_count` +1** |
| `apps/server` | **+6** | `/health` 回报口径、未配置时字段缺席（2）；`acceptanceScope` 四条路径（4） |

### 5. 门禁

| 命令 | 结果 |
| --- | --- |
| `corepack pnpm -r run typecheck` | **TYPECHECK_EXIT=0** |
| `corepack pnpm -r run lint` | **LINT_EXIT=0** |
| `corepack pnpm -r --workspace-concurrency=1 run test` | **TEST_EXIT=0** — **1978 / 1978**，15 个包全绿，零失败 |

总数 1964 → **1978**（+14：`shared` +5、`workflow-engine` +2、`database` +1、`server` +6）。

**抖动**：单跑 `apps/server` 时 `budgetApi` 与 `terminationPropagation`（FX-35）各失败一次；
两文件**一起隔离复跑 6/6 通过**；随后的串行全仓零失败。

### 6. 平台与实证

重建后最后产物 `19:10:49`，`tsx watch` 子进程当时是 `19:10:45`（早 4 秒，不合格）→ 触发一次干净重启，
新子进程 **`19:11:02`**，`/health` 200。**N-39 的修复在运行中的平台上可见**：

```
GET /health -> {"status":"ok","verificationGate":"observe"}
```

当前开发实例跑的是配置默认 `observe`；因此一条 `EXPECTED_GATE=enforce` 的批次会在起跑前 `exit 5`
——**这正是断言该有的行为**（要跑验收批次，就得用带 `VERIFICATION_GATE=enforce` 的方式启动平台）。

### 7. 未做的验证（如实标注）

1. **N-39 只在批次脚本里断言**，其它入口（手工 curl、网页）不受约束；`/health` 报的是全局默认，
   L1/L2 策略仍会按 `modeFor` 强制 enforce，那一层读不到。
2. **N-40 只保证编号进了提示词**；模型是否据此写标记、门是否因此转绿，要等一次真实运行（T5）。
   可参考的存量事实：库里 4060 条运行时任务中 **1733 条没有自己的 `acKeys`**（靠切片兜底），
   它们此前拿不到任何编号。
3. **N-37 的恢复边**在真实 `kill -9` 下的行为没有实测（需要一次服务端崩溃实验）。

### 8. 回归检查尝试（2026-10-23，`l1-m4v` 1 run）——**被规划器挡下**

用户「先跑 l1-m4v 回归检查」。N-39 的断言先起了作用：开发实例（`:3000`）报 `verificationGate=observe`，
按新规则批次会直接 `exit 5`。于是另起一个 **`VERIFICATION_GATE=enforce`** 的实例（`:47559`，
`node dist/index.js`，dist 为 T4 后构建），`/health` 确认 `enforce` 后开跑。

**第一个拦路石（已修）**：harness 按标题复用需求，项目 `[eval] E1` 里那条 **2026-09-30 起就是 FAILED**
的同名需求被盲复用，批次 60 秒即「规划失败」。修法：复用前剔除 `FAILED`/`CANCELLED`，按创建时间取最新
（`packages/eval/src/harness.ts`）。eval 包 typecheck / lint / 65 例全绿。

**第二个拦路石（N-41）——证据被一次配置失误污染，必须更正**：

修好后规划走到关口 1、切出 2 个切片，然后 slice-1 规划连续失败：

```
VALIDATION_ERROR: Task DAG validation failed: Task TASK-007 is a delivery task
but this is not the final slice (DELIVERY_TASK_OUTSIDE_FINAL_SLICE)
```

两次批次、共 **7 次规划尝试全部同一个错误**。

**更正（2026-10-23 19:43 自查）**：那 7 次所在的实例是 `node dist/index.js` 直接起的，
**没有 `source .env`**——而本仓的 `.env` 不由代码加载，是启动脚本注入环境的。该实例因此跑在
**默认 mock 模型**上（`/api/model-config` 实测 `provider: "mock"`、`apiKeyConfigured: false`）。
mock 规划器出的是一份**固定脚本计划**，它把交付任务放在非最终切片——所以那 7 次失败
**不能证明真实模型不收敛**。

**结论修正**：
- 「真实模型对 `DELIVERY_TASK_OUTSIDE_FINAL_SLICE` 不收敛」——**未证实，撤回**。
- 规则 0 仍然成立：mock 脚本计划是仓库里真实存在的计划形态（测试与 dev 都在用），它必然被校验器
  判死；确定性剔除非最终切片的交付任务是**形态修复**，不依赖模型行为。但它的价值是「拦住一种必然
  非法、而修复轮不保证能改的形态」，**不是**「解决线上规划不收敛」。
- **教训**：起实例必须带 `.env`；`/api/model-config` 是判断口径最快的入口，跑批前应断言
  `provider != "mock"`。当前 preflight 只断言了 `verificationGate`，**没断言 provider**——
  同一类「跑起来才发现口径不对」的缺陷，已登记 **N-42**（`docs/17` T4 节）。

**第三次尝试（配置正确，19:44–19:53）——回归检查结果：不通过**

- 平台：`provider=openai / deepseek-v4.1-flash`、`verificationGate=enforce`（均已实测确认）。
- 规划：**首轮通过**，4 条确定性自动修复；切片/规格的创建时间（19:45 / 19:49）证明计划由**live 模型**产出，
  未受 mock 污染。
- 执行：S1-foundation 工作流启动后 **4 分钟失败**，`WORKFLOW_TASK_FAILED`。
  - `S1-T01`（**BUILD**）跑 9 轮、写 **1 个文件**、调 `run_build` 两次 → 验证门判 `checks failed: build` → FAILED；
  - `S1-T01-DEBUG-1` / `-DEBUG-2` 各 17 轮，仍 `checks failed: build` → FAILED → 工作流终止。
- oracle：**Must 0/29**；工作区 `node_modules missing`、`pnpm start` 报 `MODULE_NOT_FOUND`。

**判读**（不夸大）：这是**当前能力**下的如实结果——agent 在一个基础切片里只写了 1 个文件就交了，
验证门把它拦下（门是按设计工作的），两轮 DEBUG 也没能补齐。与 T2–T4 无关：MCP / 截图 / AC 编号
都不在这条失败路径上，且 N-40 的编号已进提示词。
**它不是「回归通过」**，也不能当作「T2–T4 让平台退化了」的证据——历史上 `l1-m4v` 的读数本来就在 0%~部分完成之间。
回归检查的结论：**平台在当前模型与 enforce 口径下仍不能交付 E1**。

**已修（N-41，用户 2026-10-23 裁定「按 ①」）**：在既有的确定性修复层 `autoFixTaskPlan` 新增
**规则 0 `non-final-slice-delivery`**——`isFinalSlice === false` 时把交付链任务（复用校验器导出的
`isDeliveryChainTask`：`DEPLOY` 或带 `delivery` 块）从本切片**剔除**，并清掉其它任务指向它们的依赖，
避免悬空边。必须排在其它规则之前：后面的规则都基于任务图。

**同批更新的三处既有断言**（它们编码的是旧行为，按仓库规矩同步改、不弱化）：

| 文件 | 改动 |
| --- | --- |
| `autoFixTaskPlan.test.ts` | 「非最终切片不补块」→「非最终切片剔除交付任务」；新增 1 例：保留非交付任务、清掉悬空依赖、最终切片/单级规划不删 |
| `planningAutoFixReplay.test.ts`（FX-09 录像回放） | 同一份真实坏计划现在**同轮通过**（`taskPlanAttempts` 2→1），不再产出 `TASK_DAG_VALIDATION_FAILED` / `PLANNING_REPAIR_REQUESTED`，`PLAN_AUTOFIXED` 多一条该规则 |
| `planningFinalSliceScale.test.ts` | 校验错误面只剩 `GLOBAL_AC_OUTSIDE_FINAL_SLICE`（交付任务已被确定性剔除），并断言规则 0 的 `PLAN_AUTOFIXED` 事件存在——LLM 修复路径仍由全局性 AC 这条覆盖 |

`agent-core` **270/270 通过**（+1）。

---

### 9. N-43 · 骨架先行契约（用户 2026-10-23：「先加骨架约束，再重跑回归」）

#### 9.1 机制（先证，再改）

第三次回归的失败不是「模型太弱」这种笼统判断，它在库里有一个**确定性的形状**（2026-10-23 复查）：

```
S1-T01（BUILD）验证记录：
  command   pnpm build
  stderr    Error: Cannot find module '/workspace/scripts/build.js'
S1-T01-DEBUG-1 诊断原文：
  "the previous BUILD attempt wrote exactly one file, package.json, and stopped.
   Every artifact that package.json's five scripts point at was never created."
```

而计划里 `scripts/build.js` 属于 **S1-T06**（五个任务之后）：

| 任务 | 类型 | 内容 |
| --- | --- | --- |
| `S1-T01` | BUILD | 「建立单包 pnpm 工程清单与五个约定脚本」——**7 条 AC 全部只描述 `package.json` 字段** |
| `S1-T06` | BUILD | 「实现 lint / typecheck / build 三个零依赖自检脚本」——真正的脚本文件在这里 |

于是三件事叠在一起，让首任务在**计划层面就不可能通过**：

1. 验证门的检查集按**任务类型**派生（`taskVerifierRules.ts`：`BUILD: ["build"]`），不读任务自己的 AC；
2. agent 照着 AC 干活——AC 只要求清单，它就只写清单（9 轮、`write_file`×1）；
3. DEBUG 任务继承同一检查，两轮补不回来。

**结论**：缺的不是能力，是**契约**。「声明了一个脚本」与「让这个脚本能跑」被拆到了两个任务里，
而前者被判定的标准恰恰是后者。这正是用户裁定的「骨架约束」要补的那一条。

#### 9.2 实现

新增 `packages/agent-core/src/planning/validateSkeletonPlan.ts`：

- **骨架任务** = 声明了 `build` 的任务（构建契约的锚点）；无人声明时取计划顺序里第一个根任务。
- **可执行条款自动补齐**（确定性 auto-fix，不改任务图、不改 AC 编号映射）：骨架任务若在其 AC 里
  没有「该脚本真实可执行、退出码 0」的条款，按 `start/test/lint/typecheck/build` 逐一追加：
  `Project skeleton is executable (<s>): after this task, \`pnpm run <s>\` must have a real
  implementation in the repository and exit 0 — declaring the script name in package.json without
  the code it runs does not satisfy this criterion.`
- **单一提供者**（硬错误 `SKELETON_SCRIPT_MULTIPLE_PROVIDERS`）：同一脚本被切片内两个任务同时声明
  ——那正是「声明在前、实现在后」的拆分形态，交修复轮合并。

接线：`PlanningGraph` 在 `autoFixTaskPlan` 之后、DAG 校验之前执行补 AC（事件 `PLAN_AUTOFIXED`
`rule: "skeleton-script-ac"`，`TASK_DAG_GENERATED` 增加 `skeletonAcCount`），并把硬错误并入错误面；
新增 `PlanningGraphOptions.isFirstSlice` / `PlanningAgentRunOptions.isFirstSlice`，由
`planningService` 按 `requirement_slices.slice_order` 判定（与 N-39 的 `isFinalSlice` 同一取法）。
**只在第一个切片生效**：骨架只建一次，后续切片不再改写 AC。

提示词同步加一条 `Project skeleton:`（`prompts/task-planning.prompt.ts`）：清单与脚本实现必须在
同一个任务里交付，骨架任务无依赖，其 AC 必须写明每个脚本真实运行且退出码 0。

#### 9.3 测试

| 文件 | 覆盖 |
| --- | --- |
| `validateSkeletonPlan.test.ts`（新，8 例） | 骨架任务识别（声明优先 / 根任务回退 / 空计划）；实值形状补 5 条 AC 且**入参不被就地修改**；已覆盖的不重复补；非首个切片 / 非 Node 工程 / 显式 `false` 无动作；重复提供者报错 |
| `planningSkeletonContract.test.ts`（新，3 例） | 图级接线：首个切片补 5 条 AC + `skeletonAcCount=5`；未传 `isFirstSlice` 时**既有行为逐字不变**（AC 仍 2 条、无该事件）；重复提供者 → 校验失败入修复轮 |

`agent-core` **282/282 通过**（+12），typecheck / lint 全绿。
全仓收尾门：`typecheck` 0 错误、`lint` 0 问题；`test` 1 例失败（`workflowApi.e2e` UX-02，并发负载下的
既有重 e2e），**隔离重跑 11/11 通过**——按仓库既有口径记为负载抖动，不弱化。

#### 9.4 重跑回归（2026-10-23 23:10 → 2026-10-24 02:35，`l1-m4v` 1 run）

平台：`provider=openai / deepseek-v4.1-flash`、`verificationGate=enforce`（preflight 两条断言都过了，
N-39 + N-42 同时生效）；pid 68881 启动于 23:09:11，晚于 `agent-core`（23:08:41）与 `server`
（23:09:01）的 dist —— 重启落后于构建的老问题没有复发。

**规划侧**：切片的键与标题整体换了（`slice-1-foundation` … `slice-5-ui-deploy`），证明计划由
本轮重新生成。首个切片的骨架任务 `T1`（BACKEND）拿到的 AC 里，模型自己已经写了「五个脚本可执行、
退出码 0」，确定性补齐只补了缺的 `start` 一条（`PLAN_AUTOFIXED` / `skeleton-script-ac`）。
工作区实测：`package.json`、`pnpm-lock.yaml`、`README.md`、`src/server.js`、
`src/scripts/{build,lint,typecheck,gate-utils}.js`、`test/*.js` 全部落盘——**上一轮只有 `package.json`**。

**执行结果**：

| 指标 | 上一轮（无约束） | 本轮（N-43 生效） |
| --- | --- | --- |
| oracle Must | **0/29** | **25/29** |
| 切片到达 | 第 1 片即失败 | **第 5 片（最终切片）** |
| 切片结果 | — | slice-1…slice-4 **DONE**；slice-5 有任务失败 |
| 任务账 | 34 个任务里大量 FAILED | SUCCESS 34 / FAILED 8 / 未跑完 14 |
| 假阳性 | 否 | 否 |
| token | ~0.39M（3 个 agent 任务） | 81.98M 输入 / 0.88M 输出 |

**四条未过的 Must AC 是同一个原因**（容器交付）：

```
AC-24 / AC-25 / AC-26 / AC-29  →  docker build 失败
  #9 [4/8] RUN npm install -g --no-fund --no-audit pnpm@9.12.3
  npm error code EEXIST
  npm error path /usr/local/bin/pnpm
  npm error File exists: /usr/local/bin/pnpm
```

**在宿主机上复现确认，这不是偶发网络问题**：Dockerfile 先 `RUN corepack enable`（生成
`/usr/local/bin/pnpm` 的 shim），再 `RUN npm install -g pnpm@9.12.3` 往同一个路径写 → `EEXIST`。
确定性缺陷，一条 `--force` 或删掉 `corepack enable` 即可。它是**产物侧**的缺陷，不是平台侧：
`docker build` 属于交付链，而本项目未绑定 Git 仓库（`deliveryConfigured=false`），交付链本轮没有执行，
所以验证门也不可能在这里拦住它——这正是 T5（真实仓库 + 真实 PRD/TRD）要覆盖的那一段。

**如实标注**：

- **真成功率仍是 0%**：slice-5 有 5 次验证门失败（`checks failed: test`）与 3 次 REPLAN，
  工作流没有 Run = SUCCESS；链完成 / 交付 / staging 段均为 0（交付链未执行）。
- 失败分层：规划 3 / 验证门 5 / agent 3；人工介入 2（切片计划关口重审）。
- 42 轮「自动修复」里包含本轮的骨架 AC 补齐（每条脚本一条事件）。
- 与上一轮相比的**唯一变量**是 N-43（外加 N-42 的 preflight）；除此之外没有改任何执行期代码。

**结论**：骨架约束解决了它该解决的那件事——首个切片不再自相矛盾，平台第一次把 E1 的五片全部跑完、
交出 25/29。剩下的 4 条不再是「agent 只写一个文件」这种能力问题，而是一条**具体、可复核的 Dockerfile
缺陷**；交付链与容器验证属于 T5 的范围。

#### 9.5 slice-5 的 5 次 `checks failed: test` 归因（用户 2026-10-24：「把 slice-5 的 5 次归因一下」）

**结论：不是产物问题，是验证门的命令过滤器把正确产物判了死。已登记 N-44。**

五条失败分别是 `T2`、`T2-DEBUG-1`、`T7`、`T7-DEBUG-1`、`T7-DEBUG-1-DEBUG-2`。逐条查库，五次是
**同一个机制**：

1. 这五个任务的 `test` 检查都是 `scopingMode: "command-filter"` —— 校验器按 AC 编号挑出测试文件，
   执行 `pnpm test -- '<file>' … --test-name-pattern '…'`（`taskVerifierRules.ts:349`
   `buildAcScopedTestCommand`）。
2. 文件清单里包含 `test/docker-entrypoint.test.js`、`test/docker-volume.test.js` 等路径。
3. `run_unit_test` 的工具入口先跑 `assertCommandAllowed(command)`
   （`packages/tool-runtime/src/tools/commandTools.ts:38`），它用
   `BLOCKED_COMMANDS = /\b(curl|wget|ssh|scp|docker|kubectl|nc|telnet)\b/`
   **对整条命令字符串**做匹配——**不区分引号**。`-` 是词边界，于是
   `docker-entrypoint.test.js` 命中 `\bdocker\b`。
4. 命令被拒（`TOOL_ERROR: Command is blocked by Phase 1 sandbox policy`，耗时 1–5 ms，无
   stdout/stderr），检查记 `exitCode: null`，两次尝试都一样，任务判 `checks failed: test`。

时间戳可以逐条对上：`T7` 的验证 `startedAt = 18:00:19.945Z`，两条 verifier 侧工具错误在
`18:00:21.094Z` / `18:00:21.096Z`（`actor: TaskVerifier`，taskId 正是 `T7`）；`T2` 同理
（`18:06:49.727Z` → `18:06:50.934Z` / `.939Z`）。

**反证：被拦的那条命令本身是通过的。** 在最终工作区里手工执行 `T7` 记录的那条完整命令：

```
pnpm test -- 'test/deploy-contract.test.js' 'test/deployment-contract.test.js' \
  'test/deployment-runtime.test.js' 'test/docker-entrypoint.test.js' \
  --test-name-pattern '\[AC-24\]|\[AC-25\]|\[AC-26\]' --test-timeout=24000
→ 16 tests / 16 pass / 0 fail，exit 0
```

**为什么 DEBUG 救不回来**：DEBUG 任务继承同一组 AC ⇒ 同一套 scoped 文件清单 ⇒ 同一条命令 ⇒ 同样被拦。
更糟的是 `T7-DEBUG-1` 自己又新增了 `test/docker-volume.test.js`，**让下一次的清单里多一个带 `docker`
的路径**——每一次修复都把它钉得更死。三次尝试后 REPLAN 出来的任务仍是同一 AC 集合，形状不变。

**为什么 T1/T6 用同一种 scoped 命令却过了**：那一刻清单里还没有 docker 命名的测试文件；T1 的清单是
`baseline` + `deployment-contract`。所以拦不拦取决于**文件名**，而不是命令是否安全。

**性质**：这是与 N-13 / N-42 同一族的**假阴性工厂**——门对「正确产物」永远判失败，且失败不可恢复。
影响面不止 E1：任何被 AC 作用域选中的测试文件，只要路径里含 `docker` / `curl` / `ssh` / `scp` /
`kubectl` / `nc` / `telnet` 中任一词，就永远过不了。

**修法（未实施，等裁定）**：`assertCommandAllowed` 应当只看**命令头与引号外的 token**，复用
`packageManager.ts` 里已有的引号感知扫描（`containsUnquotedShellSyntax` 同一范式），而不是对整串正则；
并补一条回归测试：`pnpm test -- 'test/docker-entrypoint.test.js'` 必须放行。这条修复不属于本阶段的
「骨架约束」，按阶段纪律停在这里。

#### 9.6 N-44 修复与第二次回归（用户 2026-10-24：「修 N-44，修完再跑一遍回归」）

**改了什么**（`packages/tool-runtime/src/tools/commandTools.ts`）：

- 黑名单从「整串正则」改为**引号感知分词 + 精确匹配**：命令头按 basename 比对（`/usr/bin/docker`
  仍拦），其余**未加引号**的 token 必须与黑名单**完全相等**才拦（`sudo docker`、`xargs docker` 覆盖到，
  `test/docker-entrypoint.test.js`、`docker-entrypoint.test.js` 这类路径放行）；
- 引号内是数据；唯一例外是解释器 `-c/-e/--eval/-p/--print` 的载荷——那是**要执行的代码**，
  仍按旧口径整串严格匹配，堵住 `sh -c "docker …"`、`node -e "…execSync('docker ps')"` 的绕道；
- 半引号拼接（`doc'ker' ps`）不豁免，防止拼接绕过。

测试：`packages/tool-runtime/src/__tests__/commandPolicy.test.ts`（5 例）——实值 AC 作用域命令放行、
未加引号路径放行、真命令词仍拦、解释器载荷仍拦、半引号不豁免。`tool-runtime` 37/37 通过，
typecheck / lint 全绿。收尾全仓门：typecheck 0 错误、lint 0 问题、`pnpm -r run test` 全绿
（`apps/server` 397/397，上一轮那条负载抖动未复发）。

**第二次回归（2026-10-24 12:21 → 13:58，`l1-m4v` 1 run）**：

| 指标 | 上一轮（N-43） | 本轮（+N-44） |
| --- | --- | --- |
| oracle Must | 25/29 | **29/29 通过** |
| 真成功率 | 0% | **100%** |
| 假阳性 / 假阴性 | 0 / 0 | 0 / **1**（平台自报失败、oracle 判通过） |
| 切片 | 5 片（最后一篇未跑完） | **3 片全部 DONE** |
| token | 81.98M / 0.88M | **34.26M / 0.52M** |

**N-44 的修复在生产里生效**：整轮只有 **1 次**「Command is blocked by Phase 1 sandbox policy」，
且来自 `reviewer-agent` 自己的 `run_build` 尝试（任务本身 SUCCESS）；**verifier 侧 0 次**。
上一轮是 10 次（5 个任务 × 2 次重试）。

**唯一剩下的失败不是验证门，是 CI 的环境隔离**（见下），已登记 **N-45**。

#### 9.7 N-45 · 本地 CI 把平台自己的环境变量带进了工作区测试

`T-11`（CI BUILD）三次 FAILED，`errorType: CI_FAILED`，三次的逐条结果**都是 AC-01 失败、其余 29 条
全过**。查库 + 复现：

1. `LocalCiOperations.runCi`（`apps/server/src/services/deliveryAdapters.ts:137`）用
   `spawn(..., { env: process.env })`（同文件 `command()`，第 21 行）在**工作区**跑六步契约；
2. 平台的进程环境里带着 `PORT=47558`（本实例就是用它启动的）；
3. E1 的 AC-01 有一条测试断言「未设置 `PORT` 时默认 3000」，而项目代码按 PRD 读 `PORT`——
   继承来的 47558 让它失败：`[AC-01] config reads PORT with default 3000 … → not ok 40`；
4. **复现确认**：在工作区干净地跑 `pnpm test`，AC-01 全绿；加 `PORT=47558 pnpm test`，
   同一条 `not ok 40` 立刻出现。

性质：本地 CI 对工作区**没有环境隔离**——平台怎么启动（端口、`DATA_DIR`、`NODE_ENV`、闸门开关…）
都会漏进被测项目的六步契约里。真实项目里任何依赖环境变量的测试都会被平台自身的启动参数污染。

**修法（未实施，等裁定）**：`runCi` 的子进程环境改成白名单（`PATH`、`HOME`、`LANG`、`TMPDIR`、
代理变量等），不带平台自己的 `PORT` / `DATABASE_URL` / `VERIFICATION_GATE` 等；并补一条回归测试：
平台以 `PORT=<被占用端口>` 启动时，CI 仍然通过。

#### 9.8 N-45 修复与第三次回归（用户 2026-10-24：「修 N-45，修完再跑一遍回归」）

**改了什么**（`apps/server/src/services/deliveryAdapters.ts`）：

- 新增 `ciEnvironment()`：只保留执行所需的**定位/本地化/代理/容器 daemon** 变量
  （`PATH`、`HOME`、`SHELL`、`USER`、`TMPDIR`/`TMP`/`TEMP`、`LANG`/`LC_*`/`TZ`、`COREPACK_HOME`、
  `HTTP(S)_PROXY`/`NO_PROXY`、`NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`、`DOCKER_HOST`/`DOCKER_CONFIG`/
  `DOCKER_CONTEXT`/`DOCKER_BUILDKIT`）；
- `command()` 新增 `env` 选项；`LocalCiOperations.runCi` 的 `git rev-parse` 与六步契约全部走
  `ciEnvironment()`。部署侧的宿主 `docker` 调用**保持原样**（不动 `DOCKER_*` 之外的环境，避免误伤真实 daemon 配置）。

测试：`apps/server/src/__tests__/deliveryAdapterEnv.test.ts`（3 例：平台变量一律不带 / 执行所需保留 /
未设置的变量不出现），外加 `deliveryLifecycle.e2e` 回归。`server` typecheck / lint 全绿。
全仓收尾门：typecheck 0 错误、lint 0 问题；`test` 1 例（`v1GoldenScenario` 的 restart 场景，
并发负载下的既有重 e2e）失败，**隔离重跑 4/4 通过**——按仓库口径记为负载抖动。

**第三次回归（2026-10-24）分了两次**：

1. **15:08 首跑**：`task_planning` 阶段连续两次撞 150s 阶段预算 →
   `Planning stage timed out`，切片 S1 直接 FAILED，10 分钟结束。读数无意义，归档到
   `results/l1-m4v/prev-20261024-planner-timeout/`。**这是上游延迟，不是代码问题**（同一份代码前一天
   三次规划都正常）。
2. **15:21 重跑**（新需求 `8c03fa79`，5 个切片）：

| 切片 | 结果 |
| --- | --- |
| slice-1-foundation-auth | **DONE**（任务 10/10 SUCCESS） |
| slice-2-task-create-list | **DONE**（11 SUCCESS，2 次 REPLAN 后收敛） |
| slice-3-task-lifecycle | **DONE**（11/11） |
| slice-4-ui-runtime-deploy | **DONE**（5/5） |
| slice-5-docs-contract-tests | **FAILED —— 死在同一份计划的规划阶段**（见 §9.9） |

因为有一片失败，harness 按既有口径把整次 run 记为「未完成」（`运行数：0`，oracle 未执行）。

**N-45 的修复这一轮没有被端到端走到**：交付链（CI → DEPLOY → VERIFY）这次被规划在 slice-5，
而 slice-5 在规划阶段就死了。单元层已证明 `ciEnvironment()` 剔除平台变量，但「CI 真跑起来不再
被 `PORT` 污染」仍缺一次实测。**如实标注，不当作已验证。**

#### 9.9 N-46 · 交付切片的「测试先行」在规划期无解（第三次回归的新拦路石）

slice-5 的三次规划尝试，错误面完全一样：

```
Task DAG validation failed: Implementation task T-04 must depend on test task T-10
  (shared ACs: AC-24, AC-25, AC-26, AC-29) to keep tests first.
```

（三次的任务号不同：T4/T8、T-04/T-10、T3/T11——**形状相同**。）

库内统计（近 90 分钟）：

| 事件 | 计数 |
| --- | --- |
| `PLAN_AUTOFIXED` / `test-first-edge` / **cycle-blocked** | **11** |
| `TASK_DAG_VALIDATION_FAILED` | 10 |
| `PLANNING_REPAIR_REQUESTED` | 7 |

机制：AC-24/25/26/29 是部署类验收。模型很自然地把**部署测试排在部署实现之后**
（`TEST → BUILD/DEPLOY`），而 N4 测试先行要求**实现任务依赖覆盖同一 AC 的 TEST 任务**
（`BUILD/DEPLOY → TEST`）。确定性修复层规则 1 只**增边**，遇到成环就记 `cycle-blocked` 交 LLM；
而 LLM 三轮都给出同一种自然顺序——于是每一轮都无解。

**修法（未实施，等裁定）**：把规则 3（脚本提供者）已经在用的手法搬给规则 1——当补边成环、且环上
**第一条边是「测试 → 实现」这种 N4 未强制的倒置边**时，删掉该倒置边再补正边（规则 3 的
`isTestFirstMandatedEdge` 判定可复用）；只有倒置边本身也是 N4 强制时才保持 `cycle-blocked`。

#### 9.10 N-46 修复与第四次回归（用户 2026-10-25：「修 N-46，修完再跑一遍回归」）

**改了什么**（`packages/agent-core/src/planning/autoFixTaskPlan.ts`）：

规则 1 补边成环时，先沿环逐条断开**倒置的测试先行边**——「TEST 依赖实现（共享 AC）」，也就是
N4 否定的那个方向——再补正边。判定直接复用 `isTestFirstMandatedEdge`（同名判定只保留一份：
在 adjacency 里 `source → target` 表示「target 依赖 source」，它描述的正是这条倒置边）。
没有可断的倒置边时口径不变，仍记 `cycle-blocked` 交 LLM。fix 事件新增 `removedEdges`（仅在真删了边时出现，
既有事件形状不变）。

测试：`autoFixTaskPlan.test.ts` 的「成环不修复」用例改为新行为，并新增
「环上没有倒置边 → 仍 blocked（口径没有放宽）」；`PlanningGraph.test.ts` 的「补边成环 → LLM 重做」
用例改用一个**没有倒置边**的环（中间夹一个 BUILD 任务），继续守住 LLM 修复路径。
同一手法同步到 `apps/server` 的 `planningEscalation.e2e.test.ts`（它用同一份倒置边计划驱动
「修复耗尽 → 人工关口」，N-46 之后那份计划会同轮修好，升级路径就再也走不到）。
`agent-core` **283/283 通过**，typecheck / lint 全绿；全仓收尾门：typecheck 0 错误、lint 0 问题，
`test` 1 例失败（`terminationPropagation` FX-35，并发负载下的既有重 e2e），**隔离重跑 5/5 通过**。

**第四次回归（2026-10-25 00:08 → 02:03）**：

| 项 | 读数 |
| --- | --- |
| 规划 | **0 次 cycle-blocked**（上一轮 11 次）——N-46 的死锁消失；切片照常规划出 5 片 |
| slice-1 `s1-deployable-shell` | **DONE 7/7**（含 Dockerfile 任务） |
| slice-2 `s2-auth-persistence` | **DONE 13/13** |
| slice-3 `s3-task-create-list` | **FAILED**（任务 CRUD 未交付，见 §9.11） |
| slice-4 / slice-5 | 未开始 |
| oracle | Must **17/29**——失败集中在 AC-14…20/23/27/28（创建/列表/CRUD，正是 slice-3 没交付的那批）与 AC-25 |
| token | 47.44M 输入 / 0.59M 输出 |

17/29 不是退化：平台这一轮只交付到"注册 + 登录"，任务相关 AC 全都在未执行的切片里；
AC-24/26/29 这三条容器 AC 依旧通过。

#### 9.11 N-47 · 没有 acKeys 的任务被整片的测试判死（第四次回归的拦路石）

`slice-3` 的失败链：

1. `s3-03-task-repository`（DATABASE）**没有 acKeys**；
2. `TaskContextBuilder.acceptanceScope` / 校验器按「本切片 AC 并集」兜底 → 作用域变成
   AC-14…18、AC-23（`s3-02-test-create` 先写的 18 条测试）；
3. 验证门的绿灯 `test` 检查因此跑起 `test/tasks-create.test.mjs` 等——**那是 `s3-04-create-api`
   的交付物**，此刻还没实现；
4. 工作区复现：同一命令 **18 条里 6 条失败，全部是建任务相关的**（AC-14…18）；同一份材料里
   仓库层的测试是通过的；
5. 任务 FAILED → `DEBUG-1` → `DEBUG-1-DEBUG-2` → `REPLAN-1` → `DEBUG-1-REPLAN-2`，**五次都继承同一份
   acKeys（空）**，因此五次跑的都是同一条命令、都失败 → 切片 FAILED。

**这不是「模型太弱」，是两个设计假设撞在一起**：N4 测试先行要求**先把整片的测试写完**，
而逐任务的绿灯 `test` 检查假设**这个任务自己能把这组 AC 全部点亮**。中间的实现任务必然做不到。

**可选修法（都需要裁定）**：

- **(a) 规划侧**：要求多 AC 切片的实现任务各自携带**不重叠**的 acKeys（新增校验器），
  这样每个任务的绿灯检查只看自己那几条；
- **(b) 验证侧**：没有 acKeys 的任务不参与 AC 作用域的 `test` 检查，只跑 `build` +
  切片边界的整体检查（承认「中间实现任务不可能独自点亮整片」）；
- **(c) 判据侧**：实现任务的 `test` 检查降级为**观察项**，由切片边界检查承担绿灯职责。

停在这里，等裁定。

#### 9.12 N-47 修复（用户 2026-10-25：「按 ② 修」）

按 **(b)** 落地（`apps/server/src/services/taskVerifier.ts`）：

- dev 任务**自身没有 acKeys、却能通过 PL-M8 兜底拿到本切片 AC 并集**时，**不跑**逐任务的绿灯
  `test` 检查——绿灯职责交给 `build` 与切片边界检查；
- 跳过不是静默的：记录新增 `skippedChecks: [{ name: "test", reason: "NO_AC_SCOPE" }]`，批次后可查；
- **口径收窄到位而不是一刀切**：切片内根本没有 AC 记录时不存在「AC 作用域」，维持旧口径
  （无作用域的全量套件）；DEBUG 指向 TEST 任务时跑的是**红灯**检查（空转测试必须失败），也不跳过；
- `taskTestScope` 只保留「任务自身 acKeys」一种来源；`sliceScopeFallback` 仅用于**判定是否跳过**，
  不再作为检查作用域。

测试：`taskVerifier.test.ts` 的 PL-M8 两例改成 N-47 的新口径（跳过 + `skippedChecks` 留痕 +
不再被同片其他任务的测试拖垮），并新增「切片内无 AC 记录 → 维持旧口径」；两个 CHECK_TIMEOUT 用例
改为给任务声明自己的 acKeys（超时语义与作用域来源无关）。`server` **69/69**（taskVerifier 文件），
typecheck / lint 全绿；全仓收尾门 typecheck 0 错误、lint 0 问题，`test` 2 例失败
（`evidenceApi`、`finalSliceGovernance`，并发负载下的重 e2e），**隔离重跑 7/7 通过**。

**第五次回归（2026-10-25 11:29 → 11:56）——被一次 jsonb 写入挡下**：

切片规划正常，slice-1 跑到第 5 个任务后，`T-06` / `T-07` 及其 DEBUG 共 5 个任务全部以
`LLM_ERROR: unsupported Unicode escape sequence` 失败，切片 FAILED，run 结束。oracle 7/29
（只交付到骨架+注册的一部分）。

**归因（第一次判断错了，查库后更正）**：我先把它当成模型网关的 Go `encoding/json` 报错，猜是
未配对代理项；**这个判断是错的**。实测 Postgres：

```
select '"\u0000"'::jsonb;      → ERROR:  unsupported Unicode escape sequence   ← 与失败信息逐字一致
select '"\ud83d"'::jsonb;      → ERROR:  invalid input syntax for type json    ← 不同
```

也就是说：**jsonb 存不下 U+0000**。agent 的产出（模型文本或命令输出）里出现一个 NUL，写
`agent_runs.output` / `tasks.output` / `worker_events.payload` 时就会抛这条错，重试与 DEBUG 都会在
同一个写点再炸一次。

#### 9.13 N-48 修复（用户 2026-10-25：「修 N-48，修完再跑一遍回归」）

新增 `packages/database/src/jsonbSafe.ts`：持久化前**深度去掉 U+0000**（字符串、数组、对象递归；
`null`/数字/布尔/`Date` 原样；循环引用不死循环）。jsonb 无法表达 NUL，这是**存储边界**的职责，
内存里的字符串语义不动。

写入点（全部是 jsonb 列）：

| 存储 | 字段 |
| --- | --- |
| `agent_runs` | `input`（create）、`output` / `error` / `token_usage`（update） |
| `tool_calls` | `input`（start）、`output` / `error`（finish） |
| `tasks` | `input`（insert）、`output`（update） |
| `workflow_runs` | `output`（update） |
| `workflow_events` | `payload`（insert） |

测试：`jsonbSafe.test.ts`（5 例：顶层/嵌套/标量/循环引用/非纯对象）。`database` typecheck / lint 全绿。

**第六次回归（2026-10-25 12:50 → 14:28）**：

| 项 | 读数 |
| --- | --- |
| `unsupported Unicode escape sequence` | **0 次**（上一轮 5 次）——N-48 生效 |
| N-47 的形状（无 acKeys 的实现任务被整片测试判死） | **没有再出现**：slice-1/2 的所有 BACKEND 任务全部 SUCCESS |
| slice-auth-persistence | **DONE** |
| slice-task-crud-isolation | **FAILED**（见下） |
| slice-runtime-ui-docs | 未开始 |
| oracle | Must **2/29** |
| token | 35.26M / 0.40M |

**slice-2 的失败链**：`T-10`（REVIEW）→ `REPLAN_REQUESTED` → 引擎建了 `target=TEST` 的 DEBUG →
两轮都是 `checks failed: test`。全量 136 条测试里只红 1 条：

```
not ok 15 - [AC-11] the protected /api/tasks prefix answers 401 without a token
            and 404 NOT_FOUND with a valid one
```

这条是认证切片写的**跨切片期望**（任务接口此时应回 404）。DEBUG 两轮没把它改绿——属于产物质量问题，
不是新机制。

**但 oracle 只过 2/29，且 `AC-01` 通过、`AC-02` 的 detail 是「状态码 404」**：应用进程起来了
（健康端点 200），而 `/api/register` 根本不存在。也就是说 slice-1 交付的是**一堆模块 + 单元测试**，
**没有把路由挂进服务器**，而项目自己的 136 条测试里 135 条是绿的（它们直接调 handler，不启动服务）。

**这是本次最值得记的一条**：逐任务检查与切片边界检查跑的都是项目自己的测试，**没人启动过一次真实服务**。
只有 oracle 这个黑盒能看见「路由没挂」。已登记 **N-49**（`docs/17`），修法（是否在切片边界加一条
「起进程 + 打健康端点 + 打一条业务路由」的冒烟）需要裁定——它会改变门的成本与口径。

#### 9.14 N-49 修复（用户 2026-10-25：「修 N-49，修完再跑一遍回归」）

**机制**：切片边界现在多一条独立检查 `server-smoke`——**起一次真实进程，再按本切片验收标准里点名的
路由打一遍 HTTP**。它与 `slice-boundary`（= 用同一条测试命令再跑一遍）并列，两者看到的不是同一件事：

| 检查 | 看到什么 | 看不见什么 |
| --- | --- | --- |
| `test` / `slice-boundary` | 项目自己的测试是否绿 | 服务有没有被启动过（测试直接调 handler） |
| `server-smoke` | 业务端点在**运行中的服务**上是否存在 | 业务正确性（仍归测试与 oracle） |

**判据只有一条**：切片 AC 里点名的业务路由，在真实进程上不能**全部** 404。

设计上的几个取舍（都为避免把门变成假阴性来源）：

- **路由只从 AC 文本取，不猜**。`POST /api/tasks`、`` `/api/register` `` 这类文本里的路径被抽出来；
  文本里没点名路由就记 `NO_ROUTES` 跳过——按 FR 编号推 REST 形状会把「门自己的假设」变成失败依据。
- **健康端点不参与判定**。`/healthz` 200 只证明进程活着；把它算进「已挂载」正是 N-49 的形状
  （第六次回归里 `/healthz` 200 而 `/api/register` 404）。判定只在业务路由上做。
- **带占位符的路由不能单独作证**。`/api/tasks/:id` 对不存在的资源返回 404 是合法的；切片只点名这类
  路由时记 `ONLY_PARAMETERIZED_ROUTES` 跳过。
- **环境类启动失败不判交付缺陷**。沙箱 `--network none`、`node_modules` 未装时 `start` 起不来是环境
  问题（`BOOT_ENV_UNRESOLVED`）。探针自身没跑出结论（`PROBE_ERROR`）同样只留痕——门不能因为自己的
  探针坏了把切片判死。四种跳过原因都写进 `verification.smokeSkipped`，不静默。
- **每种失败单独一个诊断码**：`BOOT_FAILED`（起不来）与 `SURFACE_UNMOUNTED`（起来了但路由没挂）进
  `verificationFailureCodes` 分布，批次账本能把两类分开统计。

**实现**：`apps/server/src/services/serverSmoke.ts`（`node -e` 单命令 + 纯函数解析，与
`buildPackageFactsProbeCommand` 同一范式——沙箱每条命令都是**新容器**，起进程与探测必须在同一条命令里
完成）；`taskVerifier.ts` 在切片边界（最后一个经验证门的任务）调用 `serverSmokeCheck`。进程用
`detached` 起、结束时按**进程组**杀；`PORT` / `DATA_DIR` 注入临时值，避免污染工作区。

**测试**：`serverSmoke.test.ts` 18 例，其中两例是**真实进程**（起一个真 HTTP 服务，跑
`buildServerSmokeCommand` 产出的那条命令，验证「挂上了→通过」与「起来了但 404→SURFACE_UNMOUNTED」）；
`taskVerifier.test.ts` 增两例接线（失败判定 + `failureCode` 传播、环境失败只留痕）。
另在真实 `ai-se-sandbox:22-pnpm9` 容器里（`--network none`、`cpus 1`、`pids-limit 128`）手工核对了
两个方向：`/api/register` 404 → 判定未挂；改成 400 → 判定已挂。

**第七次回归的启动参数（开跑前登记）**：`L1_M4V_RUNS=1`，`VERIFICATION_GATE=enforce`（N-39 预检通过），
provider `openai` / `deepseek-v4.1-flash`（N-42 预检通过），平台 pid 启动于 15:34:02 —— **晚于**
15:33 的全仓构建，`@ai-se/server` 走 `dist/`，新检查确实在运行的代码里。周窗口用量起跑前
1,237.5M / 1,400M。
**这一轮要读的**：(a) `server-smoke` 的判定分布与 `smokeSkipped` 原因码分布；(b) 是否有切片因为它
被判失败——若有，逐个核对是真缺陷还是门自己猜错；(c) 它是否在 slice-1 就拦住第六次回归的形状。

#### 9.15 第七次回归（2026-10-25 15:34 → 18:04）

第一次尝试在规划阶段超时（`Planning stage timed out: task_planning (150000ms)`，与
`prev-20261024-planner-timeout/` 同一种既有抖动），归档到 `prev-20261025-n49-planner-timeout/` 后重跑。

| 项 | 读数 | 上一轮 |
| --- | --- | --- |
| oracle Must | **16/29** | 2/29 |
| AC-01..AC-13（认证切片） | **全部通过** | AC-02 起全 404 |
| AC-14..AC-20/23/27/28（任务 CRUD） | 全部 404 | 404 |
| 假阳性 | 0 | 0 |
| 失败分层 | 规划 0 / 验证门 5 / agent 6 | — |
| 切片到达 | S2（共 4） | S2 |
| token | 35.34M 输入 / 0.55M 输出 | 35.26M |

S1 真的把注册/登录/令牌挂上了（AC-01..AC-13 全过，与前两轮「模块+测试、服务没挂」形成对照），
S2 的 30 个任务在 REPLAN/DEBUG 链上打转后仍未收敛（含 `S2-T04-DEBUG-1-DEBUG-2` 这种「DEBUG 的
DEBUG」），任务 CRUD 的路由因此始终不存在。

**N-49 的端到端效果：仍未验证。** 整轮：

```
select count(*) from workflow_events where event_type='SLICE_BOUNDARY_CHECKED'  → 0
select count(*) from tool_calls where input::text like '%ai-se-smoke%'          → 0
```

新检查一次都没跑。两个切片各自的原因不同：

- **S2**：工作流 FAILED、切片从未收敛 ⇒ 边界检查按设计跳过（`siblings-unfinished:` 列的都是真实
  未完成/未解决的失败）。这一条不算缺陷。
- **S1**：工作流 **SUCCESS**，边界检查同样没跑 —— 这是一条**新缺陷**。

#### 9.16 N-50 切片最后一个任务是失败任务的解决者时，边界检查恒不触发

`S1` 的执行序：`S1-T5`(REVIEW) FAILED → 重排出 `S1-T5-REPLAN-1`(BACKEND) 并 SUCCESS。
`S1-T5-REPLAN-1` 是切片最后一个经验证门的任务，它的 `boundarySkipped` 是
`siblings-unfinished:S1-T5:FAILED`——而库里 `S1-T5.resolved_by_task_id` 正指向 **`S1-T5-REPLAN-1`
自己**：

```
  S1-T5 | resolved_by = S1-T5-REPLAN-1 | resolver_status = SUCCESS（最终态）
```

**机制**：`maybeSliceBoundaryCheck` 在 verify 内部执行，此刻 `S1-T5-REPLAN-1` 这一行还是 `RUNNING`
（SUCCESS 是验证通过之后才写回的）。`isFailureResolved` 沿 `resolvedByTaskId` 走到这个任务，看到
「非 SUCCESS」就判源任务未解决 ⇒ `pendingSiblings` 非空 ⇒ 边界检查不触发。

这正是 N-35 修过的同一族缺陷的**自引用残留**：N-35 解决了「失败源任务永远 FAILED」，没解决
「解决者就是当前正在验证的那个任务」。

**普查**（近 20 天、带验证记录的切片）：126 个切片拿到了边界检查；9 个因这条原因没拿到；另有
38 条任务记录的跳过原因串里出现 `FAILED`。

**影响**：N-49 的 `server-smoke` 与边界检查共用同一个触发点，因此被这条缺陷一并挡住——这是本轮
`server-smoke` 一次没跑的直接原因（S1 是唯一「成功但没拿到边界检查」的切片）。

**修法（待裁定）**：判定「已解决」时把**当前任务自身**算作成功（它即将变 SUCCESS；若它的验证失败，
任务本来就判失败，边界检查结果不影响结论），或在 `pendingSiblings` 计算前先看 `entry.resolvedByTaskId`
是否落在当前任务上。**未修**：本轮到此为止。

#### 9.17 N-50 修复（用户 2026-10-25：「修 N-50，修完再跑一遍回归」）

按上面的第一个修法落地，且**不另立第二套「已解决」定义**（`docs/160`）：

- `packages/workflow-engine/src/resolution.ts`：`isFailureResolved` 增加可选第三参
  `{ pendingSuccessId?: string }`——链上某个解决者就是**调用方正在判定的那个任务**时视为已解决。
  默认不传 = 口径逐字不变（`retry` 的重排范围、工作流终局判定都不受影响）。
- `apps/server/src/services/taskVerifier.ts:1291`：切片边界的 `pendingSiblings` 改传
  `{ pendingSuccessId: task.id }`。

**为什么是「视为已解决」而不是「跳过这一条」**：验证在任务变成 `SUCCESS` **之前**执行，`RUNNING`
只是时序产物；如果这个任务的验证失败，任务本身判失败，边界检查的结论不进任何最终状态——所以两种
写法在语义上等价，而放进同一个判定函数能保证「已解决」只有一处定义。

**测试**：`resolution.test.ts` +3（单层 / 多层链末端是当前任务、当前任务不在链上时口径不变）；
`taskVerifier.test.ts` +2（S1 形状：边界检查照常触发并通过；反向：解决者仍是别的 PENDING 任务时
仍旧跳过）。`workflow-engine` 73/73、`server` 73/73。

**读前声明（第八次回归）**：边界检查的覆盖率会上升——这是**门在补上此前的免检缺口**，不是新缺陷；
随之每个切片会多一次全片测试，且首次真正执行 `server-smoke`（起进程 + 打路由）。如果某个切片因此
判失败，先逐个核对「真缺陷 vs 门自己猜错」再下结论；耗时与 token 也会比上一轮高。

#### 9.18 第八次回归（2026-10-25 20:33 → 23:58，三次尝试）

平台 20:33:07 启动（晚于 20:32 全仓构建），`enforce` + `deepseek-v4.1-flash`。三次尝试：

| # | 结果 | 终止原因 |
| --- | --- | --- |
| 1 | 规划阶段失败 | slice-S1 任务规划 600s 超时（`This operation was aborted`） |
| 2 | slice-1 SUCCESS、slice-2 失败 | slice-2 任务规划：模型输出非法 JSON（`{"requirements：[{`，全角冒号），3 次重采样全部不可用 |
| 3 | **slice-1/2/3 SUCCESS、slice-4 失败** | slice-4 任务规划 600s 超时 |

第三次尝试是至今最好的一次：**三个切片连续 DONE**（此前最多两个，且 slice-1 从未完成过）。
代价是整轮在 slice-4 中止，**没有 oracle 读数**。

| 项 | 读数 |
| --- | --- |
| 切片 | slice-1 / slice-2 / slice-3 **DONE**，slice-4 FAILED（规划） |
| `slice-boundary` | 三个收敛切片**全部拿到**（T-09 / T-09 / T9，均 passed） |
| `server-smoke` | **执行 2 次、通过 2 次**；slice-1 以 `no-routes` 留痕跳过 |
| oracle | 无（夹具在 slice-4 中止） |
| 假阳性 | 无 |
| token | 本轮 55.1M；周窗口 1,359.7M / 1,400M |

**N-49 的读数（正向）**：`server-smoke` 第一次在真实批次里执行并通过——
slice-2 `T-09`、slice-3 `T9` 的检查都是 `server-smoke:true, slice-boundary:true`。两个切片的产物都
真的把路由挂上了，**没有出现误判**。反向（拦住 `SURFACE_UNMOUNTED`）仍未在真实批次里出现：
本轮没有「收敛但路由没挂」的切片。

**N-50 的读数**：三个收敛切片的最后一个任务都拿到了边界检查，但**没有一个是「失败任务的解决者」**
（`T-09` / `T9` 都是原始任务），因此这条修复的具体形状尚未在真实批次里被走到，仍只有单测证据。

**跳过原因是设计内的**：slice-1 的计划（v4）里，切片 AC 文本只提到健康端点、没有点名任何业务路由，
`server-smoke` 记 `smokeSkipped: no-routes` 跳过——不静默，也不猜 REST 形状。这同时说明它的覆盖面
取决于计划把路由写进 AC；写不进去的切片它看不见（**已知边界，未另立缺陷**）。

#### 9.19 观察：切片任务规划阶段今天连续四次卡住（归因见 §9.20）

| 时间 | 形状 |
| --- | --- |
| 15:36 | `Planning stage timed out: task_planning (150000ms)` |
| 20:34 | slice-S1 任务规划 600s（`This operation was aborted`） |
| 21:22 | slice-2 任务规划：模型输出非法 JSON，3 次重采样全部失败 |
| 23:48 | slice-4 任务规划 600s（`This operation was aborted`） |

四次的共同后果：**一个切片的规划失败会中止整个夹具**，前面的切片全部白跑。三次是超时、一次是
JSON 不合法，都属于「模型/网关不稳定」这一层，不是验证门或规划图本身。
**归因见 §9.20**（用户 2026-10-26 要求查超时与重试）；登记为 **N-51**。

#### 9.20 规划阶段的超时与重试（用户 2026-10-26：「查规划阶段的超时与重试」）

四层预算，两层重试：

| 层 | 值 | 位置 | 超时后的行为 |
| --- | --- | --- | --- |
| 单阶段 | 150s，**重试 1 次**（共 2 次尝试） | `PlanningGraph.ts:696-737`（`stageWithBudget`） | 抛 `Planning stage timed out: <stage> (150000ms)` |
| 单次 run（切片） | **600s** | `planningService.ts:61` + `:1225`；`PlanningAgent.ts:135-142` | abort，`status=timed_out`、`code=TIMEOUT_ERROR`，**无重试** |
| 单次 run（第一级） | 300s | `planningService.ts:50` + `:486-490` | 同上 |
| 切片失败后的重试 | 升级人工关口，最多 2 轮 | `planningService.ts:78`（上限）/ `:1248-1309` | **只对 `VALIDATION_ERROR` 生效** |

**F1（主因）：唯一会被重试的失败类别恰好不是瞬态的那一类。**
`planningService.ts:1248` 只在 `errorCode === "VALIDATION_ERROR"` 时走升级/重试；其余一律落到
`:1313` `updateSliceStatus(slice.id, "FAILED")` 终态。而超时（`TIMEOUT_ERROR`）和 JSON 解析失败
（`PLANNING_ERROR`）正是**最该重试**的瞬态失败。实证：今天四次的切片状态都是 `FAILED`、**没有任何
审批行**（`approvals` 表当天只有 3 条关口 1 审批）；而 `harness.ts:427-451` 本来会自动批准
`PLANNING_REVIEW` 的审批——也就是说**重试机制是通的，只是超时进不去**。

**F2：阶段级重试会吃掉外层预算。**
事件实证（`workflow_events` 的 `PLANNING_STAGE_TIMEOUT`）：

```
15:58:10  stage=task_planning attempt=0 willRetry=true
15:58:39  同一 run 结束：status=timed_out，error="This operation was aborted"
```

阶段定时器在 150s 触发并决定重试，但外层 600s 已在重试进行中耗尽，整个 run 被 abort ——
**执行层上「重试」等于「直接掐死」**。近 30 天 18 条 `PLANNING_STAGE_TIMEOUT` 里，重试成功的有 7 条，
被外层掐掉的是今天这两条。

**F3：600s 与实测分布几乎零余量。** 近 30 天成功的切片规划 run：平均 **174s**、最长 **591s**
（194 个样本）。最大值已经贴到 600s 上限，一次慢阶段或一次阶段重试就会越界。

**F4（记账）：阶段超时被记成 `PLANNING_ERROR`。** `PlanningGraph.ts:730` 抛的是普通 `Error`，
而只有外层定时器才会把状态写成 `timed_out`/`TIMEOUT_ERROR`（`PlanningAgent.ts:270-278`）。于是
「阶段超时」与「模型输出非法 JSON」同码，批次账本分不开。

**普查（近 30 天 planning-agent 失败/超时）**：`VALIDATION_ERROR` 595（有重试）、`TIMEOUT_ERROR` 9、
`PLANNING_ERROR`(JSON 解析) 3、`PLANNING_ERROR`(阶段超时) 2、其它 `PLANNING_ERROR` 1
—— **后 15 条全部终态，没有一条走到升级路径**。

**修法建议（未实施，等开工授权）**：

1. `TIMEOUT_ERROR`（以及可判定的瞬态 `PLANNING_ERROR`）走同一升级路径——机制现成（上限 2 轮、
   harness 自动批准），改的是 `planningService.ts:1248` 的判断而不是新建一套。
2. 阶段重试要么额外给预算，要么延长外层 deadline；否则 F2 会让重试变成摆设。
3. 600s → 覆盖成功分布的 p99（实测 max 591s，建议 ≥900s），或按「阶段数 × 阶段预算」推导。
4. 阶段超时单独一个错误码（F4），让账本能区分「慢」与「模型吐了垃圾」。

#### 9.21 N-51 修复（用户 2026-10-26：「修 N-51，修完再跑一遍回归」）

按 §9.20 的建议 1 + 3 落地，并把 F4 一并补上（否则「超时」在代码里无法被可靠识别，建议 1 无从下手）：

| 项 | 改动 |
| --- | --- |
| F4 | `PlanningGraph.ts` 新增 `PlanningStageTimeoutError`（带 `stage` / `budgetMs`），阶段预算耗尽改抛它；`PlanningAgent.ts` 把「外层定时器」与「阶段超时」统一记成 `timed_out` / `TIMEOUT_ERROR` |
| F1 | `planningService.ts` 新增 `isEscalatablePlanningFailure(errorCode)`（`VALIDATION_ERROR` 或 `TIMEOUT_ERROR`），切片失败的升级/重试分支改用它——**机制现成**（上限 2 轮、harness 自动批准），不新建第二套 |
| F3 | 单切片总预算 600s → **900s**（`planningService.ts` 与 `config.ts` 两处默认值同步；`.env` 未覆盖该项） |

**没做的事**：`PLANNING_ERROR`（模型输出非法 JSON）**不**放开重试——一个阶段内已重采样 3 次，
重排整个切片未必有帮助，盲目放开会让确定性失败也进重试循环。它仍是终态，只是现在与超时分得开了。

**升级 reason 带错误码**：`planningEscalationReason(sliceKey, errorCode)` 现在是
`[planning-escalation:<sliceKey>] Slice planning failed (TIMEOUT_ERROR); …`——前缀路由契约不变
（`parsePlanningEscalationReason` 仍只认前缀），批次账本能看出这次重试是「慢」还是「校验失败」。

**测试**：`planningStageTimeout.test.ts` 2 例（阶段超时抛可识别错误类；agent 记为
`timed_out`/`TIMEOUT_ERROR` 且消息保留）、`planningApprovalReasons.test.ts` +2（可升级判定的四个码；
reason 带错误码）、`PlanningGraph.test.ts` 既有阶段超时用例不变；`planningEscalation.e2e.test.ts`
2/2 仍通过（校验类失败的升级路径未被改变）。

#### 9.22 第九次回归（2026-10-26 09:25 → 10:21）：N-51 生效，暴露出下一个卡点

一轮跑完，三个修复全部得到实测读数：

| 项 | 读数 |
| --- | --- |
| slice-1-auth-persistence | **DONE，9/9 任务全绿**；最后一任务 `T-09` 的检查是 `server-smoke:true, slice-boundary:true` |
| slice-2-task-crud | 规划**超时三次**后按上限转终态 FAILED，夹具中止 |
| slice-3-ui-deploy | 未开始 |
| oracle | 无（夹具在 slice-2 中止） |
| 本轮 token | 12.15M |
| 假阳性 | 无 |

**F4 生效**：三次失败在 `agent_runs` 里都是 `status=timed_out`、`code=TIMEOUT_ERROR`、消息
`Planning stage timed out: task_planning (150000ms)`——旧代码这里是 `failed` / `PLANNING_ERROR`。

**F1 生效**：第一次超时后建了升级审批并重试，第二次超时再建一次；两次都被 harness 自动批准：

```
[planning-escalation:slice-2-task-crud] Slice planning failed (TIMEOUT_ERROR); approve to retry …
```

——**修复前第一次超时就会把整轮掐死**（第八次回归三次死法相同）。上限仍是 2 轮，第三次失败转终态，
这条行为符合设计。

**F3 没有帮上忙，因为约束不在那一层**：三次 run 分别跑了 435s / 426s / 424s，都**远低于** 900s 的
外层预算；掐死它们的是**阶段预算** `task_planning` 150s × 2 次。同一阶段六次尝试（3 个 run × 2 次
重试）全部卡在 150s，且**每次都卡在同一阶段**——这不是随机的网关抖动，更像这个切片的
task_planning 提示词/输出规模就是超过 150s。

**下一个卡点（未修，未登记）**：`PLANNING_STAGE_TIMEOUT_MS`（150s，`config.ts:69`）对
`task_planning` 偏紧。可选修法：① 给 `task_planning` 单独一档（如 300s），其余阶段仍 150s；
② 全局抬到 300s（代价：真卡住时一次阶段要烧 600s）。**建议 ①**——证据指向的正是这一个阶段。

#### 9.23 N-52 `task_planning` 独立阶段预算（用户 2026-10-26：「那你继续做修复工作」）

按 §9.22 的建议 ① 落地：**只给 `task_planning` 一档新预算（300s），其余阶段维持 150s**。
选 ① 而不是把全局抬到 300s 的理由是证据的形状——六次失败全部落在同一阶段，全局抬会把「真卡住」
的其他阶段也一起翻倍烧时间。

| 层 | 改动 |
| --- | --- |
| `PlanningGraph.ts` | `PlanningGraphOptions.taskPlanningTimeoutMs`；取值规则抽成纯函数 `stageBudgetMs(stage, options)`（只有 `task_planning` 认自己那一档，缺省回落通用预算） |
| `PlanningAgent.ts` | 透传 `taskPlanningTimeoutMs`（两级图各一处） |
| `planningService.ts` | `PlanningBudgets.taskPlanningTimeoutMs` + 默认 `DEFAULT_TASK_PLANNING_TIMEOUT_MS = 300_000`，接到切片规划（唯一会跑 `task_planning` 的 pipeline） |
| `config.ts` / `index.ts` | `PLANNING_TASK_PLANNING_TIMEOUT_MS`（默认 300s）→ `config.planningTaskPlanningTimeoutMs` → 预算对象 |

**取值规则写成纯函数**（`stageBudgetMs`）而不是内联三元：它决定「一次慢调用能烧多久」，写错方向会
静默地把所有阶段的预算一起放大，值得一条能跑的单测。

**测试**：`planningStageTimeout.test.ts` +2（只有 `task_planning` 认新档；不配时沿用通用预算 =
旧行为逐字不变）、`config.test.ts` +1（默认值 150s / 300s / 900s 与显式覆盖）。`agent-core` 17/17、
`server` 配置 13/13、`planningEscalation.e2e` 2/2。

**第十次回归的读前声明**：`task_planning` 单次最坏耗时从 300s（150×2）变成 600s（300×2），
切片最坏 600+130≈730s < 900s 外层预算，仍在界内；**如果这一轮 slice-2 仍然卡在 300s，
说明它不是「慢」而是「挂住」，那时该换的是重试策略而不是继续加预算。**

#### 9.24 第十次回归（2026-10-26 09:25 → 15:30，人工中止）：三个修复生效，但 N-49 误判了一个体积路径

| 项 | 读数 |
| --- | --- |
| slice-1 | **DONE**；边界任务 `T-09`：`server-smoke:true, slice-boundary:true` |
| slice-2 | **DONE**；`T-07`：`server-smoke:true, slice-boundary:true`；**规划 251s 一次过**（上一轮同切片六次全挂） |
| slice-3 | **DONE，14/14 零失败** |
| slice-4（最终切片） | FAILED，人工中止 |
| oracle | 无 |

**N-52 生效**：slice-2 规划 251s 成功、**0 次升级审批**——同样的切片在 150s 阶段预算下六次全挂。

**N-51 又救了一次**：slice-4 首次规划在 **`functional_spec`**（不是 task_planning）超时 300s，
自动建升级审批 `[planning-escalation:slice-4] Slice planning failed (TIMEOUT_ERROR)` → harness 自动批准
→ 重试成功、工作流照常启动。**没有这条修复，这一下会把三个已完成的切片一起废掉。**

#### 9.25 N-53：`server-smoke` 把容器数据卷路径当成了 HTTP 路由（自伤，已修）

**现象**：slice-4 的 `T-12`(REVIEW) 与 `T-12-REPLAN-1` 都以 `checks failed: server-smoke` 失败，
证据里写的是：

```
detail: the server is up but every business route named by this slice's acceptance criteria returned 404
probes: [{GET /, 200}, {GET /data, 404}]
failureCode: SURFACE_UNMOUNTED
```

**这不是交付缺陷，是门的误判。** `/data` 来自这些 AC 文本：

```
T-14: 容器以非 root 用户运行，挂载 /data 数据卷，DATA_DIR=/data。
T-15: staging 容器以非 root 用户运行，声明并使用 /data 数据卷。
T-05: 测试静态断言 Dockerfile 包含 VOLUME /data 且 DATA_DIR=/data。
```

`/data` 是 **Docker 数据卷路径**，裸路径正则把它当成了 `GET /data`。

**为什么必须停批**：这个切片的 AC 里恒定含 `/data`，所以任何边界任务都会再次命中同一条 → 切片**不可能收敛**。
继续跑只会把剩下的预算烧在一个已知的误判上，因此人工停批（工作流已自行 FAILED，`cancel` 为非法转移）。

**修法**（`serverSmoke.ts`）：口径按两个方向的不对称代价来定——漏掉一个真实路由只会让冒烟记
`NO_ROUTES` 跳过（便宜），误判会把整个切片做废（昂贵）：

- **带方法的路径直接信任**：AC 写 `GET /data` 就当它是路由；
- **裸路径只认 `/api…` 与健康端点**：`VOLUME /data`、`DATA_DIR=/data`、`挂载 /data 数据卷` 一律不收；
- 顺带补上全角标点（`，；）`）作为路径分隔符——`注册点，/api/tasks` 这种写法此前根本没被抽出。

**修完的实测核对**（用这一轮真实的 AC 文本跑提取器）：

| 切片 | 业务路由 |
| --- | --- |
| slice-2 | `POST /api/login, GET /api/login, GET /api/tasks, POST /api/register` |
| slice-3 | `GET /api/tasks, GET /api/tasks/:id, POST /api/tasks` |
| slice-4 | **（无）** → 记 `NO_ROUTES` 跳过（这一片只有部署/文档 AC，本来就没有业务路由） |

`serverSmoke.test.ts` +4（卷路径不产生路由；裸 `/api/...` 仍收；带方法的 `/data` 信任；裸健康端点保留）。
**第十一次回归的读前声明**：slice-4 的冒烟会变成跳过，这是**正确的收紧**，不是覆盖率回退；
`smokeSkipped: no-routes` 会如实写进验证记录。

#### 9.26 跑批前自检：把 N-53 的判据放到全库历史 AC 上普查，发现 N-54（用户 2026-10-26：「自检一次，不要因为这种很小的问题浪费 token 的轮次」）

N-49 / N-53 是同一类缺陷：**判死规则（`SURFACE_UNMOUNTED`）的输入来自对自然语言的抽取**。此前只用
第十轮那四个切片的 AC 验过——等于用样本验规则。按「判死规则先普查」，开新轮之前对全库做了一次普查。

**方法**（不复制正则）：直接 import 生产函数 `extractHttpRoutes` / `businessRoutes`
（`apps/server/src/services/serverSmoke.ts`），喂全库历史 AC。

- 6289 个任务带 AC 数组，7874 条不同 AC 文本，其中 **1901 条含路径**；按 (project, slice) 聚合成 **133 个切片**。

**三个读数**：

1. **形状干净**：1901 条文本只抽出 **24 条不同路由**，无空格段/大写段/异常段；非 `/api` 的 10 条
   全是显式方法写法（`GET /todos`、`PUT /items/:id`、`GET /stats`）——说明「显式方法直接信任」
   这一侧没有误收。
2. **一个真误判入口**：`/api/*` 的 `*` 不在字符类里，被截成 `/api/`，再去尾斜杠变成 `/api`；而
   「未实现健康端点、首页 HTML 与 `/api` 路由（留待后续切片）」「静态断言…不含 `/api/*` 路由实现」
   这类**否定句与通配散文**都产出了 `GET /api`。
3. **不是理论风险**：逐切片复算，`S1-foundation` 的业务路由**只有 `GET /api` 一条**——只要它走到
   边界检查而 `/api` 返回 404，整个切片被单条 404 判死。另有 4 个切片的业务路由里含 `GET /api`，
   但它们同时有真路由（401/400 会先把「已挂载」判出来），暂不致命。

**修法（N-54）**：通配路径不是「一个端点」，`normalizePath` 直接拒掉含 `*` 的路径；裸的 `/api`
是**挂载点**不是端点，裸路径要求 `/api/` 之后还有一段（显式方法的 `GET /api` 仍信任——AC 明写就是
端点声明）。

**A/B（同一普查脚本，改前 → 改后）**：

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 不同路由 | 24 | **23**（只少 `/api`） |
| 抽出业务路由的切片 | 65 | **64**（正好是 `S1-foundation`） |
| 业务路由含 `GET /api` 的切片 | 5 | **0** |

即：**只删掉那一条病态路由，真实路由一条没丢**。`serverSmoke.test.ts` 22 → **26 例**（新增四例
直接使用普查里命中的**原文**，而不是我编的样例）。

**对本轮（第十一次回归）的预测**——不拿「以后可能」当理由停批：slice-1-auth-foundation 的 13 个
任务、72 条 AC 抽出来只有 `/healthz`、`/health`、`/ready`，业务路由为空 → 边界检查会记
`smokeSkipped: no-routes` 跳过。slice-2 / slice-3 的任务在各自切片规划时才生成，生成后按同一脚本复核。

**下次跑批前的固定自检清单**（本节产出）：

1. 目标包 `typecheck` + `lint` + `test`（跨包改动则全仓）；
2. 构建完成后**再**重启平台（`restart-must-postdate-build`），并核对 `VERIFICATION_GATE=enforce`、
   provider、`.env` 已 `source`；
3. **切片任务生成后、边界检查触发前**，用生产抽取函数对本轮真实 AC 复算业务路由，确认没有病态路由
   （`/data`、`/api`、「未实现…」这类）；
4. 长跑挂看门狗（`eval-batch-watchdog.sh`），退出即通知。

第 3 条是这轮新加的：它是唯一能在花掉整轮之前发现「判死规则误判」的位置。

#### 9.27 第十一次回归（15:30 → 18:19，2h29m）：**oracle 29/29 全过**，自报失败是门读错了输入（N-55）

**结果**：`真成功率 100% / 自报成功率 0% / 假阳性 0% / **假阴性 1** / 链完成 0% / staging 0%`，
token 68.36M 输入 + 687k 输出。

| 切片 | 结果 |
| --- | --- |
| slice-1-auth-foundation | **DONE** 13/13（`T-08` 失败一次 → DEBUG + REPLAN 通过） |
| slice-2-task-crud-isolation | **DONE** 10/10 |
| slice-3-ui-deploy-docs | FAILED：`T7`（Dockerfile / 容器契约）连败 3 次（原件 + 2 次 replan），`T8/T9/T10-T12` 未启动 |

**N-49 的两个方向都拿到了读数**（跑前复算与实测逐条一致）：

- slice-1：AC 只有健康端点 → `smokeSkipped: "no-routes"` 跳过（跳过不产生检查项，只写这个字段）；
- slice-2：`T10-review-task-api` 边界检查 `smoke_passed=true`、`boundary_passed=true`，探针
  `GET /healthz` 200 + `POST/GET/PATCH/DELETE /api/tasks` 全部 401（需鉴权），**证明业务面真的挂上了**。

**根因（N-55）：AC 覆盖判定建立在被截断的 stdout 上。**

- `packages/sandbox/src/index.ts:69-76` 的 `appendLimited` 只保留**最后** `maxOutputBytes`
  （`:97` 默认 **96,000 字节**，server 未覆盖）；
- `taskVerifier.ts:870` 用 `parseAcResults(`${stdout}\n${stderr}`)` 在这段**已被截断**的文本上判 AC 覆盖；
- 本轮 slice-3 的测试输出 **137KB**（258 条用例）> 96KB ⇒ 排在前面的用例整段消失。

**A/B（生产解析函数，同一份真实输出）**：

| 解析输入 | 解析到的 AC |
| --- | --- |
| 完整 137KB | **30 个**（含 AC-24/25/26/29） |
| 截断后 96KB | 15 个 |
| 被丢掉 | AC-01,02,03,05,06,07,08,11,21,22,**24,25,26,29**,30 |

于是 `T7` 的检查**退出码 0、`# tests 258 / # pass 258 / # fail 0`**，却报
`uncoveredAcKeys: ["AC-24","AC-25","AC-26","AC-29"]`——同一条证据自相矛盾。T7 的 agent 其实
**写了**带 `[AC-24]` 标记的用例（`test/deploy-runtime.test.js`、`test/deploy-contract.test.js`），
现在在工程里全绿。

**次级缺陷（N-55b）：`--test-name-pattern` 被追加在脚本命令之后，Node 直接忽略。**
`taskVerifierRules.ts:366` 生成 `pnpm test -- --test-name-pattern '...'`，而工程脚本是
`node --test "test/**/*.test.js"`；最小实验：

```
node --test --test-name-pattern '\[AC-24\]' a.test.js   → # tests 1   （过滤生效）
node --test a.test.js --test-name-pattern '\[AC-24\]'   → # tests 2   （过滤被当成脚本参数）
```

所以在这种（最常见的）脚本形态下，`command-filter` **从未真正筛选过**——作用域检查实际跑全量，
`scopingMode` 却记成 `command-filter`。这既放大了 N-55 的截断概率，也让「只跑本切片的用例」这一
设计意图落空。

**结论**：本轮**不是产品缺陷**。oracle 29/29 说明交付物功能完整；自报失败是验证门把「排在前面的
用例」当成了「不存在」。修 N-55 之前，任何测试文件多、AC 覆盖面广的切片都会**确定性地**被判失败。

#### 9.28 N-55 修复（用户 2026-10-26：「修 N-55，修完再跑一遍回归」）

两处一起改，缺一不可：

**(a) 覆盖判定不再以「被截断的输入」为依据。** 新增纯函数
`detectTestOutputTruncation`（`taskVerifierRules.ts`）：用 Node TAP 自带的 `# tests N` 与**实际解析到的
结果行数**相比，少了就是被截断——**不依赖沙箱的 96,000 字节常量**。`resolveCheckOutcome` 在
`relevant.length === 0` 分支里先问这一句：被截断时**不判「未覆盖」**，按命令退出码裁决，并在检查证据里
记 `coverageTruncated: true`。零匹配（`# tests 0`）**不算截断**，N-27 的空转判定原样保留。

**(b) 作用域命令真正生效。** `buildAcScopedTestCommand` 遇到「脚本自带位置参数」的形状
（`node --test "<glob>"`）时**改写调用**，把 `--test-name-pattern` / `--test-timeout` 排到位置参数**之前**；
探测到具体测试文件时用它们**替换**脚本自带的路径（不是追加——追加只会取并集）。裸 `node --test`
维持既有追加形态，行为逐字不变。

**为什么 (b) 必须带「替换文件」这一半**：过滤真正生效后，`node --test` 仍会**加载**同目录下兄弟切片的
文件并执行其顶层钩子；实测真实 E1 工作区，只加标志、保留 glob 时 **19 个文件挂到 `--test-timeout`、
整条命令 60s、19 条 cancelled**。按文件选取后这两个代价都归零。

**真实工作区 A/B（同一份 E1 产出）**：

| 形态 | 用例数 | 输出 | 结果 | 耗时 |
| --- | --- | --- | --- | --- |
| 修复前（追加标志，标志被忽略） | 258 跑全量 | **137KB（被截断到 96KB）** | 15/30 个 AC 可解析 | ~37s |
| 只修标志、保留 glob | 54 | 28.7KB | 19 个文件钩子超时、19 cancelled | **60s** |
| 修标志 + 按文件选取 | **25** | **5.7KB** | **25/25 通过、exit 0、0 cancelled** | **10.5s** |

四个作用域 AC 全部解析到：AC-24×8、AC-25×8、AC-26×3、AC-29×6。

**测试**：`taskVerifierRules.test.ts` +5（改写形态三条、标志值不当位置参数、截断检测四条）、
`taskVerifier.test.ts` +1（截断时按退出码裁决并留痕）。门禁：typecheck 0 错、lint 0 问题、
`@ai-se/server` **60/60 测试文件通过**。

**生效时间线**：构建 18:50:59 → 平台重启 **18:51:32**（晚于构建）→ 第十二次回归 18:52:17 启动。

**读前声明**：本轮若 slice-3 仍出现 `uncoveredAcKeys`，那就不再是截断——要么用例真的没写，要么名字里
没有 `[AC-xx]` 标记；`coverageTruncated` 会告诉我们到底是哪一种。

#### 9.29 第十二次回归（18:52 → 22:00，2h43m）：**五个切片全 DONE、交付链首次跑通**

**这是本阶段第一次把整条链走完**：

| 指标 | 读数 |
| --- | --- |
| 切片 | **5/5 DONE**（foundation / auth / task-create-list-search / task-query-update-delete / engineering-docs） |
| oracle E1 | **Must 29/29 通过** |
| 链完成率 | **100%**（此前一直是 0） |
| 真交付成功率 | **100%** |
| **staging 段** | **100%（CI ∧ staging DEPLOY ∧ staging VERIFY 全 SUCCESS）** |
| 假阳性 / 假阴性 | 0 / 0 |
| token / 耗时 | 72.14M 输入 + 824k 输出 / 9,752,452ms |

**交付链的库内证据**（不是只看 summary）：

- `ci_runs` 22:00:00 **SUCCESS**（上一次 CI 记录是 2026-10-24 的两次 FAILED）；
- `deployments` staging 22:00:09 **SUCCESS**、production 22:00:19 **SUCCESS**。

**N-55 修复的实测读数**：全轮没有任何 `uncoveredAcKeys`，也没有 `coverageTruncated`；作用域命令全部是
新形态（`node --test --test-name-pattern … <files>`，标志在前、按文件选取）。上一轮「exit 0 却报未覆盖」
的自相矛盾没有再出现。

**写范围那一族第 6 次复现，但这次三种机制都正常工作**：`T4-readme-contract-test`（TEST）被要求交付
`README.md`，写入策略只允许测试路径 ⇒ agent **拒绝越权、明确报告、请求 REPLAN**；系统随即建出
`T4-readme-contract-test-REPLAN-1`（类型 **BACKEND**）并成功。该片最终 SUCCESS，交付链继续往下走。

**一个记账口径问题（不是产品缺陷，待裁定）**：summary 里「自报成功率 **0%**」与「五个切片全 DONE」
矛盾。`collectTaskMetrics`（`packages/eval/src/harness.ts:78`）的规则是
`reportedSuccess = 所有任务行都是 SUCCESS`，而**已被 replan 替代的失败祖先行仍然计入**——本轮
`T-001`/`T6`/`T4` 三行 FAILED 都是祖先，后继全部 SUCCESS。对照：`falseNegative` 的定义是
`oracle.passed && !chainCompleted`（`harness.ts:971`），本轮链完成 ⇒ 假阴性 0，这是自洽的。
⇒ 「自报成功率」对**有恢复的运行**系统性偏低，建议改为按切片工作流的最终状态计，或在读数旁注明；
未改之前，读「自报成功率」必须同时看「链完成」与「假阴性」。（已按 §9.30 修复：改为沿
`resolvedByTaskId` 排除已恢复的失败祖先。）

#### 9.30 N-56 修复：自报成功率不再把「已恢复的失败祖先」算成当前失败（用户 2026-10-27：「修 N-56，先不跑回归测试」）

**改动**（`packages/eval/src/harness.ts` 的 `collectTaskMetrics`）：判自报成功时，**沿 `resolvedByTaskId` 链
走到成功后继的失败行不计入**（可跨多跳，链断或解决者未成功一律按失败计，fail-closed）。
`taskStatuses` 是普查口径，**保持原样**——祖先行仍会被统计，只是不再决定自报结论。

与 `@ai-se/workflow-engine` 的 `isFailureResolved` 同形；eval 不依赖该包（`packages/eval/package.json`
只有 `@types/node`），故在本地实现同语义判定并在注释里指回原实现。

**真实数据 A/B**（不是构造样例：把第十二次回归五个工作流的 `tasks` 从 `/api/workflows/:id` 原样取回，
喂给同一个生产函数）：

| 口径 | 读数 |
| --- | --- |
| 任务行 | 54（SUCCESS 50 / FAILED 4） |
| 旧规则（`every SUCCESS`） | **false** ← summary 里那句「自报成功率 0%」 |
| 新规则 | **true** |

四条失败行的解决链逐条核对（全部直达成功后继）：

```
T-001:FAILED                    -> T-001-REPLAN-1:SUCCESS
T6:FAILED                       -> T6-REPLAN-1:SUCCESS
T6-DEBUG-1:FAILED               -> T6-DEBUG-1-REPLAN-2:SUCCESS
T4-readme-contract-test:FAILED  -> T4-readme-contract-test-REPLAN-1:SUCCESS
```

**API 面已核实**：`GET /api/workflows/:id` 返回的 task 对象带 `resolvedByTaskId`（本轮四条失败行都有值），
所以这条判定在真实链路上拿得到输入，不是只对库内数据成立。

**测试**：`metrics.test.ts` +3（真实形状的祖先排除、未解决/解决者未成功/解析者缺失三种 fail-closed、
多跳链）。门禁：`@ai-se/eval` typecheck 0 错、lint 0 问题、**68/68 测试通过**。

**未做**：按要求**没有跑新回归**。这条修复的批次级读数留待下一次回归；在此之前，本轮 §9.29 的 headline
仍应读成「真成功率 100% / 链完成 100% / 假阴性 0」，而「自报成功率」按新口径重算为 100%。





**顺带核实的一条读数**：库里 `verification.smokeSkipped = "no-routes"` 确有 1 条（`T-09`/`slice-1`，
任务仍 SUCCESS）——**跳过时不会产生名为 `server-smoke` 的检查项**，只写这个字段；因此按
`output LIKE '%server-smoke%'` 统计会漏掉所有跳过样本（我第一次统计时正是这样读错了 0 条）。
统计冒烟覆盖率时两个口径要分开数：**执行过的**（有检查项）与**留痕跳过的**（只有 `smokeSkipped`）。

---

---

## 10. Next Phase Boundary

**未开始事项（STOP）**：

- **E1 容器交付（AC-24/25/26/29）**：N-44 那一轮 **oracle 29/29**，四条容器 AC 全过——上一轮定位的
  Dockerfile `EEXIST` 是模型当场产出的一份坏 Dockerfile，不是稳定行为；产物侧不欠账。
- **N-48（已修，实测生效）**：jsonb 存不下 U+0000，持久化前由 `jsonbSafe` 去掉；第六次回归该错误 0 次。
- **N-49（已修；正向已实测，反向未实测）**：切片边界新增 `server-smoke`（§9.14）。第八次回归里它
  **执行 2 次、通过 2 次**（slice-2 `T-09`、slice-3 `T9`），另有 1 次以 `no-routes` 留痕跳过（§9.18）。
  「拦住 `SURFACE_UNMOUNTED`」这一反向**两次尝试都是判据自身的误判**（N-53 的 `/data`、N-54 的 `/api`），
  真正的反向案例仍未出现。
- **N-54（已修，构建生效需在下一批次边界重启）**：裸 `/api` 与 `/api/*` 被当成端点（§9.26，全库普查
  发现）。当前运行中的平台（15:30:34 启动、构建 15:30:15）**不含**这条修复；本轮 slice-1 的真实 AC
  复算为 `no-routes`，不受影响。
- **N-55（已修，第十二次回归实测通过）**：AC 覆盖判定建立在被截断的 stdout 上（§9.27/§9.28）。
  修法：覆盖判定先检测截断（TAP `# tests N` vs 实际结果行数），截断时按退出码裁决并记
  `coverageTruncated`；作用域命令改为「标志在前 + 探测到的文件替换 glob」。真实工作区从
  258 用例 / 137KB（只能解析 15/30 个 AC）降到 25 用例 / 5.7KB / 25 全过。**第十二次回归全轮零
  `uncoveredAcKeys`、零 `coverageTruncated`**，五个切片全 DONE。
- **N-50（已修；具体形状未在真实批次复现）**：`isFailureResolved` 增加 `pendingSuccessId`（§9.17）。
  第八次回归三个收敛切片都拿到了边界检查，但它们的最后一个任务都是原始任务，不是「失败任务的解决者」
  ——这条修复的形状仍只有单测证据。
- **N-51（已修，端到端待第九次回归）**：规划超时没有重试（§9.20）。落地：阶段超时有了独立错误类并统一记
  `TIMEOUT_ERROR`（F4）；升级/重试门槛放开到超时（F1，复用现成机制）；单切片预算 600s → 900s（F3）。
  `PLANNING_ERROR`（模型输出非法 JSON）仍不重试——与超时现在分得开了。
- **N-47 的效果**：第六次回归里旧形状没有再出现（slice-1/2 的 BACKEND 任务全绿），但整条链仍未跑通。
- **N-45 的端到端验证（已完成）**：第十二次回归里 CI / staging DEPLOY / staging VERIFY 全部 SUCCESS
  （`ci_runs` 22:00:00、`deployments` 22:00:09 / 22:00:19），`ciEnvironment()` 首次在真实批次被走到（§9.29）。
- **交付链与 staging 段（已完成）**：链完成率 **100%**、staging 段 **100%**——第十二次回归五个切片全
  DONE，产线部署也通过（§9.29）。
- **N-56（已修，批次级读数待下次回归）**：「自报成功率」把已恢复的失败祖先算成当前失败（§9.30）。
  改为沿 `resolvedByTaskId` 排除已恢复行；真实数据 A/B 54 行旧 false → 新 true，eval 68/68。
  按要求未跑新回归，故本次修复的效果尚无批次读数。
- **N-57（已修，2026-10-29，真实链路双向实测）**：**项目脚本里的安装拿不到网**——`docs/236` 四步开网对「agent 直接执行
  install 命令」生效，但项目把安装包成 npm script（`deps` / `prepare` / `preinstall`）时，
  那条路径永远无网。
  **机制（file:line）**：`packages/tool-runtime/src/tools/commandTools.ts:222` 的分类读的是
  **工具收到的命令字符串**——`run_build` 解析出的 `resolved.command` 是 `pnpm run deps`，
  不是 `pnpm install` ⇒ `isDependencyInstallCommand` 返回 false ⇒ `network` 不传 ⇒ `none`。
  分类器不做、也不该做项目代码的静态分析。
  **实证（2026-10-28 F1 第二轮）**：slice-1 的 `run_build` 跑 `deps` 脚本成功装出 `node_modules`
  （15:19:55），但 `ai-se-registry` 日志在该时段**零请求**——包全部来自镜像
  `/opt/pnpm-store` 预热。本轮开网**一次都没被触发**（`docs/241` §5）。
  **后果**：F1 无害（依赖集恰在预热闭包内）；对真实项目，这是开网仍救不回来的那一半。
  **可能的做法**（均未验证）：(a) 按脚本名识别安装脚本（`deps`/`prepare`/`preinstall`）——
  重新引入「文本级分类不可靠」的问题（`docs/239` §4 已知限制 1）；(b) 在生命周期上挂钩——
  要动项目代码；(c) 接受限制并在夹具侧要求「安装必须是独立可执行命令」。
  **判据（修完须验）**：一个把 `pnpm install` 包进 `deps` 脚本的夹具，在 `frontend-vue` profile 下
  能装到**预热清单之外**的包；同时 `ai-se-registry` 日志出现该请求。
  **归谁**：沙箱/工具层，不是 agent 侧。

  **已落地（2026-10-29）**：把脚本**展开一层**，但判定权仍在命令内容上。
  1. `packages/tool-runtime/src/tools/packageManager.ts` 新增 `scriptInvocationName`——
     把 `pnpm run deps` / `pnpm deps` / `npm run deps` 解析成脚本名，复用 `isScriptInvocation`
     原有的保守规则（引号外 shell 语法一律拒绝、脚本名合法、非包管理器保留子命令、名字之后只允许 `--`）；
     同时新增 `shouldProbeScriptBody`——**黑名单**（`test`/`build`/`lint`/`dev`/`start`/`serve`/`preview`/
     `mock`/`watch`/`typecheck`/`check`/`format`/`clean` 跳过，其余一律探测）。
  2. `commandTools.ts` 新增 `resolveCommandNetwork`：直接 install 命令照旧给网；否则解析脚本名，
     在**沙箱内**探测 package.json 的脚本体（工具层不读宿主机文件），脚本体本身
     `isDependencyInstallCommand` 通过才给 `registry`。探测失败/脚本不存在/脚本体不像 install ⇒ 不给网。
  3. 脚本体要过 `isDependencyInstallCommand`，因此带 `&&`、管道、命令替换的脚本**拿不到网**
     ——网络判定没有成为绕过拼接规则的新路径。

  **为什么是黑名单而不是白名单**：登记时提出的做法 (a) 是「按脚本名识别安装脚本」，但实战里
  **名字是 agent 自己起的**——F1 二轮的 `deps` 脚本在夹具模板里根本不存在，是 agent 写进
  package.json 的。任何「猜得到的名字清单」都会在下一次换个名字时静默退回无网，那正是 N-57 本身。
  跳过清单只用来省探测（每次探测要起一个容器），判定权始终在脚本体。

  **真实链路实测（双向，走真实工具 + 真实 docker，不是单测）**：
  探针工作区 `package.json` = `{"scripts":{"deps":"pnpm install"},"dependencies":{"is-odd":"3.0.1"}}`
  （`is-odd` 不在镜像预热闭包里），经 `run_command` → `DockerSandbox(network=registry)`：

  | 条件 | 结果 |
  | --- | --- |
  | `dependencyInstallAllowed = true` | `network: "registry"`、`exitCode: 0`、`packages: ["is-odd@3.0.1"]`、pnpm 报 `downloaded 2, reused 0` |
  | 同上，verdaccio 侧 | `GET /is-odd`、`GET /is-odd/-/is-odd-3.0.1.tgz` 均 200，且上游 `registry.npmjs.org` 被代理 |
  | `dependencyInstallAllowed = false`（负对照） | `command failed`、`EAI_AGAIN registry.npmjs.org`——**同一工作区、同一条命令，差别只在授权** |

  **测试**：`commandNetworkGrant.test.ts` 新增 8 条（脚本体是 install → registry；脚本体不是 → 无网；
  脚本体带 `&&` → 无网；项目未获准 → **不探测**且无网；已知非安装脚本 → 不探测；
  冷门脚本名照样探测；`run_build` 显式命令也能命中（F1 实测的正是这条路径）；探测失败 → fail closed）。
  `@ai-se/tool-runtime` 全套 **107 passed（7 files）**，typecheck / lint 干净。

  **已知边界**：脚本名落在跳过清单里（如 `test: "pnpm install"` 这种反常写法）仍拿不到网；
  跳过的目的是避免给每条 `pnpm test` 都起一个探测容器。

- **N-58（已修，双向实测通过）**：**停止脚本报成功，但取消可能根本没到服务端**。
  **机制（file:line）**：`packages/eval/scripts/f1-frontend-stop.sh:39-41` 里
  `code=$(curl ... || true)` 把连接失败吞成字符串 `000`，第 40 行无条件打印
  `cancelled $id (http=$code)`，第 47 行无条件打印 `done`。脚本**从不回读库**确认状态，
  也不把非 2xx 当失败。
  **实证（2026-10-28 F1 第二轮）**：批次超时终止后执行该脚本，输出
  `cancelled e2bb1ae6-… (http=000)` 与 `done`，但其自带的核验段在同一屏打印
  `e2bb1ae6-… | RUNNING`——**自相矛盾却仍打 done**。工作流实际仍在跑，直到手动
  `POST /api/workflows/:id/cancel` 才变成 CANCELLED。
  **后果**：与已登记的「停批要 cancel 工作流」纪律直接冲突——脚本看着停干净了，服务端继续
  烧 token（历史实测 27 分钟 / 7.61M token 的同类事故）。
  **根因（修时才发现，比登记时更具体）**：`PORT="${F1_PORT:-47558}"` 原在第 24 行，而
  `source .env` 在第 40 行——`.env` 的 `PORT=3000` **把它覆盖了**，于是 cancel 一直打的是
  dev server :3000，而不是批处理实例 :47558。`l1-m4-server-launch.sh` 里已记过同一个坑
  （"this bit the first launch"）。
  **修法（已落地）**：`packages/eval/scripts/f1-frontend-stop.sh`
  - `PORT` 改为 **source 之后**赋值；
  - `http=2xx` 才认成功，其余（含 `000`）打 `FAILED` 并置 `fail=1`；
  - 末尾回读库内 `count(*)`，非 0 或读不出 ⇒ 非零退出且**不打印 `done`**。
  **实测（双向）**：死端口 `F1_PORT=47599` ⇒ exit 1、打印 `FAILED to cancel … (http=000)`、
  `NOT DONE`；正确端口 ⇒ exit 0、`cancelled … (http=200)`、回读 0 行、`done`。

- **N-59（已修，单测 5 条 + 全套 79 通过）**：**`durationMs` 在批次被超时/取消终止时严重低报**。
  **机制（file:line）**：`packages/eval/src/harness.ts:911-919` 只累加**同时有
  `startedAt` 与 `finishedAt` 的工作流**。被超时终止的那一片状态是 `CANCELLED`，虽然
  `finishedAt` 有值，但该循环的语义是「累加已完成工作流的时长」，配合 `docs/241` §1 的
  实测：报告记 `1,687,950ms`（28 分钟），而库内 `started_at` 重算为 slice-1 28 分钟 +
  slice-2 **92 分钟** = 120 分钟，**低报 4.3 倍**。
  **实证（2026-10-28 F1 第二轮）**：`run-1.json` 的 `durationMs=1687950`；
  `workflow_runs` 两行按 `COALESCE(finished_at, now()) - started_at` 分别为 28 / 92 分钟。
  **后果**：「耗时」这一列在超时终止的批次上与墙钟无关，据此做预算判断会系统性偏乐观。
  **修法（已落地）**：抽出纯函数 `collectDurationMetrics(workflows, runStartedAt, nowMs)`
  （`packages/eval/src/harness.ts`），两条规则：
  1. 没有 `finishedAt` 的工作流按「now − startedAt」计入，并计入 `incompleteWorkflows`；
  2. 结果**不小于批次墙钟**（`now − runStartedAt`），写入 `durationMs`。
  记录新增可选字段 `incompleteWorkflows`（`types.ts`），非零即表示「至少这么久」。
  **实测**：新增 5 条单测，含按真实形状复算「28 分钟 vs 120 分钟」的那一条；
  `@ai-se/eval` 全套 **79 passed（8 files）**、typecheck / lint 通过。

- **N-60（已修，用户 2026-10-29 裁定「按任务计时」）**：**单切片 90 分钟预算装不下长 REPLAN 链**。
  **机制（file:line）**：`packages/eval/src/harness.ts:537`
  `const deadline = Date.now() + options.runTimeoutMs;` 位于 `waitWorkflowTerminal()`
  内部 ⇒ **每片各给一份**预算（不是整批共享）。`packages/eval/fixtures/F1/fixture.json`
  的 `runTimeoutMs = 5,400,000`（90 分钟）。
  **实证（2026-10-28 F1 第二轮）**：slice-1 用 28 分钟（7/7 全绿，无事）；slice-2 的
  4 次 REPLAN/DEBUG 派生链把 90 分钟吃满（92 分钟墙钟），该片被 `TIMEOUT` 终止，
  全批停在 2/4 切片。
  **裁定（用户 2026-10-29）**：按任务计时。
  **修法（已落地）**：`packages/eval/src/harness.ts` 新增纯函数
  `workflowBudgetMs(taskCount, runTimeoutMs, perTaskTimeoutMs)`：
  `预算 = max(下界, 任务数 × 每任务预算)`，`runTimeoutMs` 退化为**下界**；
  `waitWorkflowTerminal` **每轮重算**（REPLAN 派生出的新任务会把预算一起抬高）。
  每任务预算默认 `DEFAULT_PER_TASK_TIMEOUT_MS = 6 min`（实测两片为 4.0 / 4.4 min/task，留约
  40% 余量）；夹具与新 CLI 选项均可覆盖（`perTaskTimeoutMs`）。
  超时时打印**归因**：`预算 X min（N 个任务 × 6 min，下界 90 min）`——事后能分清「任务多」与
  「太慢」。
  **实测**：F1 两条真实读数回代——slice-1（7 任务）预算仍是 90 min（行为不变）；
  slice-2（21 任务）预算 **126 min**，其实际 92 min 落回预算内。
  **测试**：新增 8 条（6 条预算规则 + 2 条轮询随任务增长 + 1 条超时分支）；
  `@ai-se/eval` 全套 **88 passed（8 files）**、typecheck / lint / build 通过。

- **N-61（已修：退避 + 可区分标记 + REPLAN 归类，2026-10-29）**：**429 限流被当作任务失败重跑，没有退避也不读 `Retry-After`**。
  **机制（file:line，三处叠加）**：
  1. `packages/agent-core/src/graph/AgentGraph.ts:172-186` 的 `invokeLLMWithRetry` 循环里
     **两次尝试之间没有任何等待**（没有 sleep、没有指数退避、不解析 `Retry-After`）；
  2. `packages/agent-core/src/agent/AgentRunner.ts:147-160` 的 `onRetry` 只累计 `retryCount`
     并发 `llm_retry` 事件，**不做延迟**；
  3. `apps/server/src/services/workflowTaskExecutor.ts:447` 传 `maxRetries: 1` ⇒ 每次
     agent_run 共 2 次**立即**尝试；provider 层（`packages/agent-core/src/llm`）**没有任何
     重试/退避代码**（该目录 grep `retry|backoff|429|Retry-After` 零命中）。
  **实证（2026-10-29 F1 第三轮，slice-1）**：上游返回
  `429 Upstream request failed: [ttft_admission_refused] the cell is at capacity;
  retry shortly (after 21 s)`。三个 agent_run 的时间戳：

  | 任务 | 开始 | 结束 | 耗时 |
  | --- | --- | --- | --- |
  | `T7` | 01:37:39 | 01:37:41 | 1.6s |
  | `T7-DEBUG-1` | 01:37:42 | 01:37:43 | 1.0s |
  | `T7-DEBUG-1-DEBUG-2` | 01:37:43 | 01:37:45 | 1.6s |

  **6 秒内跑完三次完整 agent_run**，而上游明确要求等 21 秒。三次全部 `LLM_ERROR`，
  REVIEW 任务判失败 ⇒ REPLAN/DEBUG 链各自再撞一次 ⇒ **整个 slice-1 终止**，批次停在 1/5 切片。
  **后果**：(a) 一次**瞬时**的上游容量波动被放大成整片失败；(b) REPLAN 机制把基础设施故障当成
  任务质量故障处理，白烧 3 次调用；(c) 失败被记成 `failureLayers.agent=3`，事后看起来像
  「agent 不行」，而归因指向了错误的层。
  **修法方向**（均未验证）：(a) 429/5xx 走**指数退避 + 尊重 `Retry-After`**；
  (b) 重试耗尽后按**基础设施错误**归类（不进 REPLAN/DEBUG 判定），或允许整任务延后重试；
  (c) 上限要考虑 `runTimeoutMs` 预算（N-60 已按任务计时，退避可与它共存）。
  **判据**：在上游限流（429）期间，一个 REVIEW 任务不会在 1 分钟内连撞 3 次；若仍失败，
  错误类型应能区分「基础设施不可用」与「任务做错了」。
  **归谁**：`agent-core` 的 LLM/graph 层，不是 prompt 也不是门。

  **已落地（2026-10-29）**：
  1. 新模块 `packages/agent-core/src/llm/retryBackoff.ts`：
     `classifyLlmFailure`（429/5xx/网络 ⇒ 可重试；400/401/403/404 ⇒ 短路；**未知默认可重试**，
     与改动前行为一致）、`extractRetryAfterMs`（认 `after 21 s` / `Retry-After: 20` /
     `1500 ms`）、`backoffDelayMs`（`min(30s, max(上游建议, 2s × 2^(n-1)))`）、
     `sleepWithSignal`（可被 abort 打断）；
  2. `AgentGraph.invokeLLMWithRetry` 改为**先分类再等**：不可重试直接短路；累计退避超过
     `MAX_TOTAL_BACKOFF_MS = 90s` 就放弃重试（不退避吃掉整个 run 预算，与 N-60 按任务计时共存）；
  3. **可区分**：重试耗尽后 `error.details = { reason: "PROVIDER_UNAVAILABLE", kind }`
     —— 不新增 `RuntimeErrorCode`（`AGENTS.md` §10），由 `ProfessionalAgent` 透到
     `outcome.metadata.errorReason`。
  **测试**：`retryBackoff.test.ts` 17 条（含实测样张 `after 21 s` → 21000ms）；
  `agentGraph.test.ts` +4 条（429 真的等过 300ms、401 只打一次、耗尽后带标记、不可重试不带标记）；
  `agentRunner.test.ts` 的「retries transient」改为 10s 预算（1s 装不下 2s 退避），
  另加一条「预算小于退避 ⇒ 快速失败」。

  **补做（2026-10-29，REPLAN 归类）** —— 上一段留下的「未做」现已落地：

  标记要先**活着走到**引擎，才谈得上改判定。核查发现它原本在半路就丢了：
  `workflowTaskExecutor` 的 `output` 是**显式白名单**（不铺开 `outcome.metadata`），
  `metadata.errorReason` 因此进不了任务记录。三处改动：
  1. `packages/shared/src/index.ts` —— 新增 `PROVIDER_UNAVAILABLE_REASON`（跨包共用一份字面量，
     避免写方/读方各手抄一份而漂移；`AGENTS.md` §3）。写方 `AgentGraph` 改为引用它。
  2. `apps/server/src/services/workflowTaskExecutor.ts` —— `output` 增加
     `errorReason: string(outcome.metadata.errorReason)`（白名单漏了它，引擎就永远读不到）。
  3. `packages/workflow-engine/src/WorkflowEngine.ts` —— `handleFailures` 里新增
     `providerUnavailableFailure(task)`：策略解析为 `REPLAN` 时**改判为 `RETRY`**
     （原任务重试，重试会再次走 `AgentGraph` 的退避，真实恢复能接得住），并发一条
     `FAILURE_ROUTED { strategy: "RETRY", failureClass: "provider-unavailable" }`；
     重试额度用尽时如实终结，措辞点名 `Model provider unavailable`，
     **不再叠 DEBUG 诊断任务**。

  **测试**：`retryBackoff.test.ts` 17 条（含实测样张 `after 21 s` → 21000ms）；
  `agentGraph.test.ts` +4 条（429 真的等过 300ms、401 只打一次、耗尽后带标记、不可重试不带标记）；
  `agentRunner.test.ts` 的「retries transient」改为 10s 预算（1s 装不下 2s 退避），
  另加一条「预算小于退避 ⇒ 快速失败」；`WorkflowEngine.test.ts` +3 条
  （REPLAN 策略下改走原地重试且**不建诊断任务**、额度用尽如实终结且措辞点名、无标记的普通失败仍走 REPLAN）。
  **门槛**：`shared` 207 / `workflow-engine` 77 / `agent-core` 319 / `server` 488，全部通过；
  四个包的 typecheck 与 lint 干净。平台已重建（10:55:28）并在其后重启（10:56:23），
  `verificationGate=enforce`、`capabilityProfile=frontend-vue`。
  **仍未做**：批次层验证（需要上游健康的窗口；第三轮 429 期无法验）。

- **N-62（已修，2026-10-29）**：**harness 判定切片超时后不取消工作流——批次"跑完了"，平台还在跑**。
  **机制（file:line）**：`packages/eval/src/harness.ts:621-623` 的 `waitWorkflowTerminal`
  在预算耗尽时 `return { status: "TIMEOUT" }`，**没有任何 cancel 调用**；调用方
  （`harness.ts:887`、`:911`）拿到 TIMEOUT 后只记账并继续跑下一个切片/收尾。
  **实证（2026-10-29 F1 第四轮）**：15:54:42 批次打印 `run 1 done` / `F1_FRONTEND_X3_ALL_COMPLETE`，
  而 slice-4（`1a1dc5a4`）在库里仍是 `RUNNING`（12 成功 / 0 失败 / 3 未完成），
  直到 15:57 手工 `POST /api/workflows/:id/cancel` 才变成 `CANCELLED`。
  **后果**：这正是「停批要 cancel 工作流」那条纪律要防的事，只是这次不是人喊停、是 harness 自己判超时。
  窗口短（约 3 分钟、0 个 agent_run）所以本轮没烧到钱，但它是**必然**发生的形状：
  超时那一刻仍有任务在飞，harness 转身就走。
  **修法方向**（未验证）：TIMEOUT 分支在返回前调用既有的 cancel 接口，并回读确认状态；
  与 N-58 的「回读库、非零退出」同一手法，不新增取消机制。
  **判据**：一个必然超时的切片跑完后，该工作流在库里的状态是 `CANCELLED` 而不是 `RUNNING`。

  **已落地（2026-10-29）**：`packages/eval/src/harness.ts` 新增 `cancelTimedOutWorkflow`，
  `waitWorkflowTerminal` 在返回 `TIMEOUT` **之前**调用它：
  1. `POST /api/workflows/:id/cancel`（复用既有接口，不新增取消机制）；
  2. **回读确认**（`GET` 轮询 5 次，每次间隔 `pollIntervalMs`）——与 N-58 同一手法，
     不以「调用返回 200」当作已停；
  3. 调用失败、回读失败、回读后仍未停止 ⇒ 各留一条**点名要求手工 cancel** 的告警，
     并且**不抛错**：超时这件事已经发生了，不能因为收拾不干净就把结论丢掉。
  **测试**：`harness.test.ts` +3（超时后调 cancel 并回读确认 / 取消失败仍返回 TIMEOUT 且告警 /
  取消后仍未停止 ⇒ 告警而不假装已停）。`@ai-se/eval` **91 passed（8 files）**，typecheck / lint 干净。
  **生效时点**：批次进程在启动时就把 harness 读进内存，所以本修复**只对下一批生效**；
  正在跑的那一轮若超时仍需人工 cancel。

- **N-63（已修，2026-11-01，用户裁定「按 8 分钟改」）**：**每任务 6 分钟的预算常数没有余量**。
  **机制**：`packages/eval/src/harness.ts:53` `DEFAULT_PER_TASK_TIMEOUT_MS = 6 * 60 * 1000`；
  `workflowBudgetMs = max(runTimeoutMs, taskCount × 6min)`。切片任务数 ≥15 时
  `taskCount × 6min` 恰好等于 90 分钟下界 ⇒ **预算不随任务数增长**，等于退化成固定 90 分钟。
  **实证（2026-10-29 F1 第四轮，全批普查，不只看一个样本）**：

  | 切片 | 任务数 | 墙钟 | 每任务 |
  | --- | --- | --- | --- |
  | slice-1 | 11 | 38 min | 3.5 min |
  | slice-2 | 19 | 91 min | 4.8 min |
  | slice-3 | 12 | 55 min | 4.6 min |
  | slice-4 | 15 | **被 90 min 切断** | **> 6.2 min** |

  slice-1/2/3 都在 5 分钟/任务以内，slice-4 略超——而它恰好是**唯一一个预算 = 下界**的切片
  （15 × 6 = 90 = `runTimeoutMs`）。切断时 12 成功 / **0 失败** / 3 未完成：不是失败风暴，是没跑完。
  **后果**：任务更重、失败更少的切片反而更容易被切，因为它的预算增长被下界吃掉。
  **修法（用户 2026-11-01 裁定 (a)）**：`packages/eval/src/harness.ts:53`
  `DEFAULT_PER_TASK_TIMEOUT_MS` 由 **6 → 8 分钟**。于是 15 个任务的切片预算从 90 分钟（= 下界，
  等于没放大）抬到 **120 分钟**，其余行为不变：`workflowBudgetMs = max(runTimeoutMs, 任务数 × perTask)`
  的唯一计算处没有改动，小切片仍吃 90 分钟下界。
  **测试**：`harness.test.ts` 的默认值断言改为 8 分钟，两处按任务数放大的注释同步；eval 包
  typecheck / lint / **91 例**全绿。
  **判据（待下次回归实测）**：任务数 ≥15 的切片不再被固定 90 分钟切断；台账里这类切片
  `budgetMs` 应为 `任务数 × 8 min`。
  **未采纳**：方案 (b)「加固定余量」——它在长短任务间分配不均，8 分钟是把实测最慢任务
  （6.2 min/task）的抖动包住的最小整数。


- **N-64（已修，2026-10-29，参考实现 0 违规 / 实测产物 1 违规）**：**testid 命名契约不可检测**
  ——PRD 的定值表写了名字，但没有任何一条 AC 点名它，于是没有任何一道门看得见。
  **机制（file:line）**：`apps/server/src/services/taskVerifier.ts` 的 `uiSmokeCheck` 判据是
  `extractTestIds(acceptanceTexts(sliceTasks.map(e => e.input)))`（`:1654`）——**只从 AC 文本**里取
  testid；而 `uiSmoke.ts:87` 的 `extractTestIds` 只认 `data-testid="x"` 这种写法。
  PRD 第四节的定值表写的是 **`| \`task-title-input\` | … |`**（表格首列的反引号名字），
  两条判据都够不着它。
  **实证（2026-10-29 F1 第四轮）**：`task-title-input` 在整份需求里**只出现 1 次**（就在那张表里），
  AC-07/08/09/10 四条 Must 全部因为它失败；应用里实际写的是 `new-task-title`。
  同一批 agent 自己留下的诊断文档（`src/docs/diagnosis-t10-toggle-delete.md`）写着
  「实现侧无法读出原文，只能按语义自拟」——它把 AC 文本当成了唯一权威。
  第二轮同类（`task-done-toggle` → `task-toggle`）说明这不是一次偶发。
  **修法（已落地）**：新增边界检查 `testid-contract`，判据方向是「**不得自创**」，不是「必须全部到位」：
  1. `uiSmoke.ts` 新增 `extractContractTestIds(需求原文)`——契约名 = **markdown 表格首列的反引号名字**
     ∪ 正文里 `data-testid=` 点名的名字。首列必须是反引号：AC 表格首列是裸的 `AC-06`，不该被当成 testid。
  2. `taskVerifierRules.ts` 新增 `buildTestIdUsageScanCommand` / `parseTestIdUsageScan` /
     `testIdContractViolations`——在沙箱里遍历源码（跳过 node_modules/dist/coverage 与测试文件），
     收**非绑定**的 `data-testid=` 静态字面量（`:data-testid` 是表达式，运行期才知道，收了必误报）。
  3. `taskVerifier.ts` 新增 `testIdContractCheck`，**与冒烟解耦**：冒烟要 `start` 脚本、要起进程，
     而「名字是不是自创的」只读源码，起不来进程时同样要判。失败码 `TESTID_CONTRACT_VIOLATION`。
  4. 取不到需求原文 / 需求没声明任何契约名 ⇒ 跳过并留痕（`testIdContractSkipped`），**不判交付缺陷**。
  **校准（真实数据）**：

  | 对象 | 契约名 | 使用名 | 违规 |
  | --- | --- | --- | --- |
  | F1 参考实现 | 22 | 22 | **0** |
  | 第四轮 agent 产物 | 22 | 22 | **1**（`new-task-title` @ `src/components/NewTaskDialog.vue`） |

  **测试**：`uiSmoke.test.ts` +6（表格首列、`/` 分隔、裸 `AC-06` 不算、正文点名、无契约空集、去重保序）；
  `taskVerifierRules.test.ts` +4（**真跑命令**扫临时目录：绑定属性与动态值跳过、测试文件不计入、
  自创名判违规、不可解析按未探测处理）；`taskVerifier.test.ts` +3（违规判死并落 `TESTID_CONTRACT_VIOLATION`、
  全合规通过、无需求原文跳过留痕）。`@ai-se/server` **501 passed（63 files）**，typecheck / lint 干净。
  **平台**：重建 17:08:39 → 重启 17:08:53（晚于构建 ✓），`frontend-vue` + `enforce`。
  **已知边界**：扫描只认 `data-testid=` 属性写法；`id=` / class 选择器里的名字不在本契约内。

- **N-65（已修，2026-10-29；**是 N-64 家族的真根因**）**：**凭证脱敏把 PRD 自己的 testid 名字吃掉了**
  ——agent 读到的需求里，`task-title-input` 变成了 `ta[REDACTED]`。
  **机制（file:line）**：`packages/observability/src/index.ts:56` 的 `CREDENTIAL_SHAPED_PATTERN`
  含 `sk-[A-Za-z0-9_-]{8,}`（OpenAI 密钥形态）。`task-title-input` 的第 3–4 个字符正好是 `sk`，
  其后 `-title-input` 有 11 个字符 ⇒ 命中 ⇒ 整段替换成 `[REDACTED]`，留下 `ta[REDACTED]`。
  该函数被套在**每一条回到模型面前的工具结果**上：`packages/agent-core/src/professional/
  ToolRuntimeBackend.ts:295`（`JSON.stringify(sanitizeLogData(await this.executeTool(...)))`）
  与 `packages/agent-core/src/graph/AgentGraph.ts:137`（`toolResultForModel`）。
  于是 agent 读 PRD、读源码、读 lint 输出，看到的都是被打码的版本。
  **实证（对真实 PRD 跑现成的 `sanitizeLogData`）**：

  | testid | PRD 里有 | 脱敏后还在 | 历轮表现 |
  | --- | --- | --- | --- |
  | `task-title-input` | ✓ | **✗** | 第二轮/第四轮写成 `new-task-title`；第五轮 REVIEW 判「无法满足」 |
  | `task-done-toggle` | ✓ | **✗** | 第二轮写成 `task-toggle` |
  | `task-delete-button` | ✓ | **✗** | 第二轮写成 `task-delete` |
  | `task-item` / `task-count` / `app-title` / `search-input` | ✓ | ✓ | 每轮都对 |

  命中与否只取决于 `sk-` 之后的那段是否 ≥8 字符：`task-item`（`sk-item`=4）安然无恙，
  `task-title-input`（11）、`task-done-toggle`（11）、`task-delete-button`（13）全中。
  **这解释了「testid 自创」这一族为什么总是同一批名字**——不是 agent 粗心，是它根本读不到原文。
  第五轮 `T-12-REPLAN-1-REPLAN-2` 的 REVIEW 原文：*"The literal for that row is redacted in every
  artifact I may read (task context, PRD text, lint allow-list lines 55/56/61, and even lint failure
  output)"*，并明确拒绝自创（`命名不得自创`）——它在遵守规则，而规则被平台自己破坏了。
  **后果**：契约类 AC 在平台内**不可满足**；N-64 的门只能把「静默的假成功」变成「诚实的失败」，
  救不回交付。
  **修法方向（未验证）**：`sk-` 分支要求**至少含一个数字或大写字母**（DNS 名/kebab 词全是小写，
  真实密钥是 base62 随机串，48 字符里出现数字或大写的概率实质为 1）：
  `sk-(?=[A-Za-z0-9_-]{8,})(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{8,}`。
  不改「工具结果不过模型上下文」这条红线（`AGENTS.md` §10），只让凭证形态判定不误伤散文标识符。
  **判据**：真实 PRD 过一遍脱敏后，22 个 testid 一个不少；`sk-test-redteam-0123456789abcdef`
  这类样张仍被打码。

  **已落地（2026-10-29）**：`packages/observability/src/index.ts` 的 `sk-` 分支改为
  **放过 kebab 词组**：

  ```
  sk-(?=[A-Za-z0-9_-]{8,})(?![a-z]+(?:-[a-z]+)+(?![A-Za-z0-9_-]))[A-Za-z0-9_-]{8,}
  ```

  否定前瞻 `(?![a-z]+(?:-[a-z]+)+(?![A-Za-z0-9_-]))` 的含义是「`sk-` 之后**整段**都是
  两个以上小写单词用连字符连起来」。行为对照：

  | 样本 | 结果 | 理由 |
  | --- | --- | --- |
  | `sk-title-input` / `sk-done-toggle` / `sk-delete-button` | **保留** | kebab 词组 |
  | `sk-abcdefghijklmnop` | 打码 | 单段、无连字符 |
  | `sk-test-redteam-0123456789abcdef` | 打码 | 第三段含数字 |
  | `sk-proj-ABCDEFGHIJKLMNOP` | 打码 | 含大写 |
  | `sk-title-input-0123456789` | 打码 | 全段不满足「只有小写词组」 |

  **为什么不只按「含数字或大写」判**：第一版就是这么写的，结果把 `apps/server` 既有的
  `traceService.test.ts` 打红了——它要求 `sk-abcdefghijklmnop`（单段、纯小写）被打码。
  **没有改那条测试**（它是安全断言），而是把判据收紧到 kebab 词组。
  **实测（真实 PRD + 现成 `sanitizeLogData`）**：22 个契约名 **lost = []**；
  `key sk-test-redteam-0123456789abcdef here` → `key [REDACTED] here`。
  **测试**：`observability` +3（kebab 词组保留 / 单段与含数字含大写仍打码 / 带数字的 kebab 仍打码）。
  **门槛**：observability 6 / mcp 235 / agent-core 319 / server 501，全部通过；typecheck / lint 干净。
  平台重建 22:55:01 → 重启 22:55:13（晚于构建 ✓），`frontend-vue` + `enforce`。
  **已知代价**：纯小写、含连字符、每段都是字母的假想密钥会被放过。

- **N-66（已修，用户 2026-10-30 裁定方案 A：补进 PRD）**：**AC-08 的验收断言比 PRD 严**
  ——oracle 要求「新任务在列表首位」，而 PRD 从没写过位置。
  **机制（file:line）**：`packages/eval/fixtures/F1/oracle.mjs:413-417`
  `if (seen[0] !== "Write docs") throw new Error("new task not first")`；
  而 `prd.md:92` 与 `fixture.json` 的 `requirementText` 原文是
  「填标题保存 → 对话框关闭、列表新增一项、`task-count` 加 1」——**不含任何位置约束**；
  `ac-map.md:17` 的证据列也只有 `new-task-dialog` / `task-item` / `task-count`。
  **实证（第六轮，2026-10-30）**：`23/24`，**唯一**的 Must 失败就是
  `AC-08: new task not first: ["Alpha task","Beta task","Gamma task","Write docs"]`；
  第二轮、第四轮同样栽在这一条。
  **谁对**：参考实现是**前插**的（`reference/src/App.vue:91`
  `tasks.value = [payload.task, ...tasks.value]`），mock 的 POST 也是前插
  （`mock-server.mjs:116` `tasks = [task, ...tasks]`）⇒ **oracle 与参考实现一致，缺的只是 PRD 那句话**。
  **修法（方案 A，已落地）**：把位置要求写进需求，而不是放松验收：
  - `packages/eval/fixtures/F1/prd.md` 的 AC-08 改为
    「列表新增一项**且新任务位于列表首位**」；
  - `fixture.json` 的 `requirementText` 由 `prd.md` **重新生成**（两者必须逐字相同，
    `packages/eval/src/__tests__/fixtures.test.ts:53` 就在断言这件事）；
  - `docs/233` §AC 表里的同一行同步更新，避免留下过期副本。
  **测试**：`@ai-se/eval` **91 passed（8 files）**，含上面那条 `prd.md ≡ requirementText` 的漂移守卫。
  **影响**：N-64 的契约集合不受影响（AC-08 行首列是裸 `AC-08`，不产生新 testid）。

- **N-67（已修，2026-10-31；第八轮回测：**症状消失，但修复通路未被走到**）**：**工作区没装依赖时验证门判
  `VERIFICATION_FAILED`，把一个 24/24 的可用交付判死，且 REPLAN 不收敛**（**首个假阴性**）。
  **现象（第七轮，2026-10-30）**：`run-1-summary.md` 记
  **真成功率 100.0%、自报成功率 0.0%、假阴性数 1** ——oracle **24/24**（首次全绿），
  平台却判整片失败，工作流在 S1 就终止，19 个任务里 16 个**从未运行**。
  **机制（file:line）**：验证门直接跑项目 scripts（`pnpm build` / `vue-tsc --noEmit`），
  而工作区**没有 `node_modules`**（`prepareWorkspace` 从模板重建，oracle 自己另建临时目录安装，
  所以工作区始终是干净的）。三次失败逐字相同：

  | 任务 | build | lint |
  | --- | --- | --- |
  | `T01` | `sh: 1: vite: not found` | `sh: 1: vue-tsc: not found` |
  | `T01-DEBUG-1` | 同上 | 同上 |
  | `T01-DEBUG-1-DEBUG-2` | 同上 | — |

  **为什么 agent 没装**：三个脚本类工具都走 `scriptOnly` 策略
  （`packages/tool-runtime/src/tools/commandTools.ts:263-267`），而
  `isScriptOnlyCommand("pnpm install --frozen-lockfile")` 为 false——`install` 在
  `RESERVED_RUNNERS.pnpm` 里（`packageManager.ts:174-196`）⇒ 抛
  `blocked by script-only policy`。本轮 `run_build` / `run_unit_test` 各试过一次（记录 output 为空），
  随后 DEBUG 任务在 `submit_result` 里写下
  *"no dependency install is possible in this sandbox"* ——它只试了这三个工具，
  **没试 `run_command`**（错误信息里其实写了 "use run_command for general shell"）。
  **为什么代码其实没问题**：oracle 在临时目录里自己
  `corepack pnpm install --frozen-lockfile` + `pnpm build` + `pnpm preview`
  （`fixtures/F1/oracle.mjs:658-676`）后 24/24——**同一份源码能装能建、AC 全过**。
  **后果**：这是平台第一次把「可交付」判成「失败」（假阴性 1），而且失败原因被记成
  `VERIFICATION_FAILED`（听起来像代码不合格），REPLAN 派生的 DEBUG 任务重复同一环境失败，
  三次耗尽 ⇒ 整片终止。
  **修法（A+B 一起落地）**：
  (a) **先装再检查**：`TaskVerifier.verify` 在跑检查前调用 `ensureDependencies`
      （`apps/server/src/services/taskVerifier.ts:907-960`）——`node -e` 探针
      （`buildDependencyProbeCommand`，`apps/server/src/services/taskVerifierRules.ts:311-316`）
      判断 `node_modules` 在不在；缺则用 `dependencyInstallCommand(runner, true)` 装，
      `--frozen-lockfile` 失败再退回普通安装（`taskVerifier.ts:934-959`）。runner 由
      `packageRunnerFor` 判定，与默认命令解析**同源**
      （`packages/tool-runtime/src/tools/packageManager.ts:128-141`），不会出现「检查用 pnpm、
      装依赖用 npm」这种各装一套的组合。每次 `verify` 最多两条安装命令，装完即停。
  (b) **独立归因**：安装仍失败且检查也失败时，判定覆写为 `failureCode = DEPENDENCIES_MISSING`
      + `reason = "checks failed because dependencies are not installed: <安装 stderr 尾部>"`
      （`taskVerifier.ts:757-764`），安装尝试记进 `record.dependencyInstall`（`taskVerifier.ts:784`）。
      检查自身的失败证据**不删**——两条都留在记录里，便于批次后区分「环境没就绪」与「代码不合格」。
  **边界（刻意保守）**：
  - 只在 `profile.dependencyNetwork === "registry"` 时执行（`taskVerifier.ts:918-919`）；
    `backend-node` 行为逐字不变（它的依赖面靠镜像预热，装不了也不该假装能装）。
  - 探针返回 `"unknown"`（输出不可解析）时**按「存在」处理**，不为探针抖动去装依赖
    （`taskVerifierRules.ts:318-328`）。
  - 网络仍走 `dependencyInstallAllowed` 这一条通路（`taskVerifier.ts:2048-2052`），没有第二个授权入口。
  - (c)「计划里显式加安装任务」不采用：那会把环境职责摊到 agent 身上，且 agent 的三个脚本类工具
    受 `scriptOnly` 策略限制（本轮实测），计划无法保证被正确执行。
  **测试**：`taskVerifierRules.test.ts` 3 例（布尔解析 / 不可解析→unknown / 命令在真实目录里
  false→mkdir→true）；`taskVerifier.test.ts` 4 例（缺依赖→先装后检查且**顺序可证** / 已在位→不装 /
  装失败→`DEPENDENCIES_MISSING` / `backend-node`→不探测不安装）；`packageManager.test.ts` 3 例
  （runner 与 `planPackageScriptCommand` 同源 / frozen-relaxed 六种形态 / 生成命令都过 install 分类）。
  **判据（待下次回归实测）**：一个只写代码、没装依赖的任务，不应让整片因 `vite: not found` 终止；
  若终止，失败码必须是 `DEPENDENCIES_MISSING` 而不是 `VERIFICATION_FAILED`。
  **归谁**：平台侧（验证门 / 方法发现性），不是 agent 质量。
  **第八轮回测（2026-10-31，F1 单 run）**：**症状消失，但本修复未被走到**。四次切片的验证记录里
  `dependencyInstall` **一条都没有**（探针看到 `node_modules` 已存在），全库本轮
  `vite: not found` **0 次**。真正奏效的是 **N-57**：slice-1 的 `T-01` 自己在 `package.json` 里
  写了 `"setup-deps": "pnpm install --frozen-lockfile"`，`09:53:09` 用 `run_build` 执行
  `npm run setup-deps`——脚本体探测给了 registry 网络，17:53:15 装完。也就是说：**agent 这次
  自己绕过来了**，N-67 仍是没被触发过的兜底。下一条依赖类缺陷若要验它，必须构造
  「agent 不装依赖」的路径。

- **N-68（已修，2026-10-31，A+B 一起落地；批次级读数待下次回归）**：**AC 没有 FR 归属，于是每个切片都被要求覆盖
  全部 24 条验收标准，切片之间互相重复实现，前一片写的测试成为后一片的门。**
  **现象（第八轮，2026-10-31）**：四个切片 slice-1/2/3 SUCCESS，slice-4 FAILED。
  oracle **24/24**，平台仍判失败（假阴性 1）。失败链：slice-4 的 `T-05`
  `checks failed: test`（184 过 / 1 红），红的是
  `[AC-18] DELETE 返回 404 时静默降级：该项保留、task-count 不变且控制台无 error`；
  `T-05-REPLAN-1` 同样失败，`T-05-REPLAN-1-REPLAN-2` REPLAN 预算耗尽 ⇒ 整片 FAILED，
  `T-06..T-10` 从未运行。
  **机制（file:line，逐环已证）**：
  1. `parseAcceptanceCriteriaFromPrd` 拒绝少于 5 列的 AC 表
     （`packages/agent-core/src/planning/acceptanceCriteria.ts:87` 的 `cells.length < 5`）。
     E1 的 PRD 是 5 列（`E1/prd.md:50`），**F1 的 PRD 是 3 列**（`F1/prd.md:78`）⇒ 实测
     `acs: 0 frs: 5`（用仓库内 `tsx` 直接跑过）。
  2. 解析为空 ⇒ 回落 N3 库记录（`PlanningGraph.ts:440-441`）；而库里 **24 条 AC 的
     `fr_keys` 全部是 `[]`**（`requirement_acceptance_criteria`，实查）。
  3. `selectAcceptanceCriteriaForSlice` 把 `fr_keys` 为空的 AC 当成**属于所有切片**
     （`acceptanceCriteria.ts:177` 的 `ac.frKeys.length === 0 || ...`）。
  4. 任务规划又要求「每条列出的 AC 至少被一个任务的 acKeys 引用」
     （`PlanningGraph.ts:455`），于是**每个切片都被迫为全部 24 条 AC 排任务**。
  **证据（库内）**：slice-1 的 5 个 FRONTEND 任务 acKeys 都是 AC-01..AC-24；slice-2 的
  `T09` 是 **FR-4** 的实现任务（`AC-16/17/18`），而该切片 `requirement_slices.fr_keys` 只有
  `["FR-2"]`；slice-3（`["FR-3"]`）的 `T2/T3` 同样挂着 `AC-16..AC-24`。同一组 AC 被三个切片
  重复实现，而 `T09` 写下的那条 404 用例（PRD 里没有 404 语义，`F1/prd.md:112` 只要求
  「该项消失、task-count 减 1」）成了 slice-4 `T-05` 的门。
  **为什么 REPLAN 不收敛**：`T-05` 是受保护测试的消费方——它不能改弱既有断言，DEBUG 两轮都
  得出「实现是对的」的结论，于是三次撞同一堵墙。这一环与 §9.13 记录的 E1 先例同形，但**根因
  不是产物质量**：如果 AC 有 FR 归属，slice-2 根本不会去实现 FR-4。
  **修法（A+B 一起落地）**：
  (a) **解析器收下 3 列表**：`parseAcceptanceCriteriaFromPrd` 的行宽门槛由 `cells.length < 5`
      放宽为 `< 3`（`packages/agent-core/src/planning/acceptanceCriteria.ts:87`），缺列按「未声明」
      处理（`verification = null`、`smoke = false`，与 5 列表里的 `-` / 空单元格同义）。frKeys 仍由
      所在的 `### FR-n` 小节推出（`:104`），因此 F1 的 PRD 现在解析出 **5 FR / 24 AC，每条 AC 只挂
      自己的 FR**（实跑确认，见测试）。
  (b) **库内回填**：`requirement_acceptance_criteria` 里 F1 那 24 行的 `fr_keys` 由同一份解析结果
      回填（`UPDATE 24`，实查 AC-01..05→FR-1、AC-06..10→FR-2、AC-11..15→FR-3、AC-16..20→FR-4、
      AC-21..24→FR-5）。这一步是**兜底**：原文可解析时规划不再依赖库记录，但原文缺失/不可解析的
      需求仍然只有库这一条路径。
  (c)「让规划器自行收敛」不采用：第八轮已证否——它只会把全部 AC 排进每个切片。
  **测试**：`acceptanceCriteria.test.ts` 新增 3 例——F1 PRD 解析出 5 FR / 24 AC 且 frKeys 逐条正确、
  4 列表按验证方式解析、少于 3 列不解析；原有 E1 5 列表用例保持不变（回归保护）。agent-core
  typecheck / lint / **322 例**全绿。
  **判据（第十轮实测通过，2026-10-31）**：修后切片的 `requiredCriteria` 只含本切片 `fr_keys`
  对应的 AC；slice-2 不再出现 FR-4 的实现任务；跨切片测试不再成为后续切片的门。
  **第十轮读数**：切分为 **FR-1 / FR-2 / FR-3 / FR-4 / FR-5 五片**；slice-2 全部任务只挂
  AC-06..AC-10、slice-3 只挂 AC-11..AC-15、slice-4 只挂 AC-16..AC-20（修前 slice-2 的 `T09`
  实现了 FR-4、slice-3 的 `T2/T3` 挂着 AC-16..AC-24）。**链完成率 100%、真成功率 100%、
  自报成功率 100%、假阴性 0**——F1 第一次跑到链尾并通过 oracle 24/24。
  **归谁**：平台侧（规划 / AC 归属），不是 agent 质量。

- **N-69（已修，2026-10-31；构建/重启待批次边界）**：**模型输出解析失败没有重试，一次坏采样就掐死
  整个切片与整轮夹具。**
  **现象（第九轮，2026-10-31）**：slice-1 正常收尾（15 分钟、5/5 通过），slice-2 规划 80 秒后
  直接 FAILED，批次以「未完成夹具」结束、`运行数 0`——整轮没有产生任何读数。
  **机制（file:line）**：规划 agent 的模型三次采样都吐坏 JSON
  （`agent_runs.error`：`Failed to parse. Text: "{"requirements:[{"…`，langchain
  `OUTPUT_PARSING_FAILURE`），`LangChainPlanningModel.generateStructured` 的 3 次重采样
  （`langChainPlanningModel.test.ts:107-137`）全部落空后抛出；`executeSliceRun` 拿到
  `PLANNING_ERROR`，而 `isEscalatablePlanningFailure` 只认 `VALIDATION_ERROR` / `TIMEOUT_ERROR`
  （`apps/server/src/services/planningService.ts:110-112` 旧口径）⇒ 切片终态失败、不进升级重试。
  旧注释的理由是「一个阶段内已经重采样 3 次」，第九轮实测证否：**3 次都坏时没有任何上层兜底**。
  **修法**：把**解析形态的** `PLANNING_ERROR` 纳入既有升级路径——`isEscalatablePlanningFailure`
  增加可选的错误消息参数，`PLANNING_ERROR` 只有命中
  `/OUTPUT_PARSING_FAILURE|Failed to parse/i` 才放开（`planningService.ts:110-121`），其余
  `PLANNING_ERROR`（provider 拒绝、权限、未知异常）保持终态，不把确定性失败塞进重试循环。
  走的是**同一条**升级路径：切片复位 `PENDING`、需求置 `PLANNING_REVIEW`、建
  `[planning-escalation:<sliceKey>]` 审批；批准后 `planSlice` 只重跑该切片
  （`planningService.ts:868-885`）。上限仍由 `MAX_SLICE_PLANNING_ESCALATION_RETRIES` 兜住，
  不新增第二套退避。
  **测试**：`planningApprovalReasons.test.ts` 新增 1 例（解析形态 → 可升级；`400 response_format`
  与空消息 → 仍终态），原有 5 例保持；server typecheck / lint 通过。
  **判据（待下次回归实测）**：规划阶段出现坏 JSON 时，切片应被复位并重试，而不是整轮终止；
  账本上应能看到 `SLICE_PLANNING_FAILED` + `SLICE_PLANNING_RETRY_APPROVED` 成对出现。
  **归谁**：平台侧（规划重试），不是 agent 质量。

- **N-70（已修，2026-11-01，按逐 AC 口径；批次级读数待下次回归）**：**同一批 AC 有两个
  TEST 任务时，自动修复会把「跑全片验证」的任务反转成其他任务的前置，于是验证任务先跑、必然红。**
  **现象（第十轮 slice-4，2026-10-31）**：`T6`（“Full slice-4 verification run”，TEST、AC-16..20）
  在实现任务 `T2..T5` 之前执行，报出「`TaskItem.vue` 没有 task-done-toggle / task-delete-button」
  后自报失败（唯一一个 FAILED，其余 27 个 SUCCESS）；REPLAN 生成的 `T6-REPLAN-1` 依赖方向正确、
  一次通过，整轮仍以链完成收尾。
  **机制（file:line，逐环已证）**：
  1. 规划器的原始计划是**正确**的：`T2/T3/T4/T5 → T6`（T6 依赖实现），见 `workflow_events`
     的 `PLAN_AUTOFIXED` 事件 `removedEdges: [{sourceTaskId:"T2",targetTaskId:"T6"}, …]`。
  2. 自动修复 `test-first-edge` 把四条边全删掉、补成反方向（同一事件里的
     `addedDependency: "T6"`），落库后 `task_dependencies` 里 `T6 → T2/T3/T4/T5` 全部是
     `active=f` 的历史边。
  3. 根因是修复清单**按 (实现任务, TEST 任务) 逐对**要求：任何 TEST 任务与实现任务共享 AC，
     实现任务就必须传递依赖它（`packages/agent-core/src/planning/validateTestFirstPlan.ts:84-94`）。
     切片里同时存在 `T1`（写红灯测试）与 `T6`（收尾验证）时，规划器把 T6 排在后面的意图
     恰好构成「倒置边」，`autoFixTaskPlan.ts:190-204` 于是先断边再补反向边。
  4. 反转后的计划**通过全部校验**（每个实现任务确实依赖了 T1 和 T6），LLM 修复轮看不到问题；
     `TASK_DAG_GENERATED` 的 `roots` 变成 `["T1","T6"]` —— 收尾验证任务成了根。
  **代价**：多一次 agent 失败 + 一次 REPLAN（本轮多一个动态任务、约 10 分钟）。
  **修法（逐 AC 口径）**：`listTestFirstEdgeRepairs`（`validateTestFirstPlan.ts:70-121`）从
  「实现任务 × 每个 TEST 任务」的逐对遍历改为**逐 AC 判定**——对实现任务覆盖的每条 AC，
  只要它已（传递）依赖**任一**覆盖该 AC 的 TEST 任务即视为满足；只有当某条 AC 的所有 TEST
  任务都排在它之后时，才从覆盖它的任务里取**第一个**补一条边。未满足的 AC 按补边目标归组，
  一个 (实现, 测试) 对仍只产生一条修复，事件形状与 `sharedAcKeys` 语义不变（只是更精确）。
  自动修复层本身未改：它现在根本收不到「收尾验证任务 → 实现任务」的修复请求。
  **测试**：`validateTestFirstPlan.test.ts` 新增 3 例（依赖红灯测试即满足、都没前置时只补一条、
  逐 AC 判定只报未满足的那条）；`autoFixTaskPlan.test.ts` 新增 1 例（第十轮 slice-4 的实值形状：
  收尾验证任务排在实现之后时不被反转、`T3` 的边原样保留）。agent-core typecheck / lint /
  **326 例**全绿（原 322 + 4）。
  **判据（待下次回归实测）**：含收尾验证任务的切片，其 DAG 根不应包含该验证任务；
  `PLAN_AUTOFIXED` 不再出现「删除 `实现 → 验证` 边」的记录。
  **归谁**：平台侧（规划 / 测试先行规则），不是 agent 质量。

- **N-71（已修，2026-11-01，按方案 1「起 mock」；批次级读数待下次回归）**：**ui-smoke 不启动
  mock，列表项永远看不见——只要某任务的验收标准只点名列表项级 testid，边界门必红。**
  **现象（第十一轮 slice-4，2026-11-01）**：`T11`（REVIEW）判 `SURFACE_MISSING`，
  `T11-REPLAN-1`、`T11-REPLAN-1-REPLAN-2` 同样红，三次耗尽 ⇒ 整片 FAILED、链止步；
  本轮 `假阴性 1`。而同一工作区的评审 agent 给出 **APPROVED**（125 条测试全绿、lint/typecheck
  均 0），oracle **23/24**（Must 失败 0）。
  **机制（file:line，逐环已证）**：
  1. `ui-smoke` 只起工作区的 `start` 脚本（`packages/eval/fixtures/F1/template/package.json`：
     `vite preview`），**不启动 mock API**；模板里的 `mock` 脚本从未被调用。
  2. 没有 `/api/tasks`，应用首次加载必然进错误态：`error-banner`、`retry-button` 在，
     `task-item`/`task-title`/`task-done-toggle`/`task-delete-button` 全不在。参考实现
     `packages/eval/fixtures/F1/reference/src/App.vue:27` 同样是裸 `fetch(`${apiBase}/api/tasks`)`，
     没有本地兜底——**参考实现也会这样红**。
  3. 判定是「required 一个都没命中才红」。第十轮以前的检查多半有 `app-title` 这类全局 testid
     兜住（第八轮 `T-09` 的 required 含 `task-item`，但 `app-title`/`empty-state` 命中即过）；
     第十一轮 `T11` 的 required 恰好只有四个列表项 testid ⇒ 全不命中。
  **证据（库内）**：`T11` 的 `ui` 记录——
  `required: ["task-item","task-title","task-done-toggle","task-delete-button"]`、
  `present: ["app-title","task-count","new-task-button","error-banner","retry-button",
  "search-input","filter-all","filter-active","filter-done"]`、
  `detail: "the page loaded (GET / -> 200) but none of the elements … are on it"`。
  **为什么 REPLAN 修不了**：问题不在产物——评审 agent 的结论与 oracle 都说明实现是对的；
  三轮重试只是重跑同一条探针。
  **修法（方案 1：起 mock）**：`ui-smoke` 的探测程序现在按 oracle 的同一套顺序做事
  （`apps/server/src/services/uiSmoke.ts` 的 `UI_SMOKE_PROGRAM`）：
  1. 先按 **mock 端口**重建一次（`VITE_API_BASE` 是构建期内联的，所以端口必须先定下来——
     与 `packages/eval/fixtures/F1/oracle.mjs:668-676` 逐字同构）；
  2. 起工作区的 `mock` 脚本（`PORT=<mockPort>`），等端口就绪；
  3. 再起 `start`（`vite preview`），等端口就绪后探页面。
  三个子进程一并按进程组回收；`mockBooted` / `buildExitCode` / `mockStderrTail` 进检查证据
  （`taskVerifier.ts` 的 `ui` 字段），起不来时能直接看到原因。
  边界：**工作区没有 `mock` 脚本时三个参数为空**，行为与改动前逐字一致；
  单次命令超时从 90s 提到 **110s**（构建 ≤30s + mock ≤20s + 启动 ≤30s + 探测 ≤15s），
  仍低于验证门单次工具调用的 125s 上限。
  **测试**：`uiSmoke.test.ts` 新增 3 例——命令里带 mock/构建/端口、没有 mock 脚本时三参数为空，
  以及一条**真实链路集成用例**（构建脚本读 `VITE_API_BASE` 写页面 → 起 mock → 页面取数 →
  渲染出 `task-item`；真浏览器，1.8s）。server typecheck / lint / **32 例**全绿。
  **判据（第十二轮实测通过，2026-11-01）**：只点名列表项 testid 的任务不再被判 `SURFACE_MISSING`；
  检查证据里 `mockBooted=true`、`buildExitCode=0`。
  **第十二轮读数**：slice-3 的 `T-12`（REVIEW）required 为
  `task-done-toggle, task-item, task-delete-button, task-count, error-banner, retry-button,
  loading-indicator, task-title`——正是第十一轮判死的形状——本轮 **passed**，证据
  `mockBooted=true` / `buildExitCode=0`。整轮 **SUCCESS×37、零失败任务**，
  链完成率 100%、真成功率 100%、自报成功率 100%、假阴性 0，oracle **24/24**。
  **代价**：启用 mock 的切片里 `ui-smoke` 多一次构建（本轮夹具约 2–3s/次），整轮耗时 3h20m。
  **归谁**：平台侧（边界门 / 探针口径），不是 agent 质量。

- **N-72（已修，2026-11-02，方案 a：提示词补齐 submit 语义；批次级读数待下次回归）**：**TEST 任务把
  「测出缺陷」当成自己失败，平台照单全收，每触发一次就多一轮 REPLAN。**
  **现象（第十三轮 slice-4/slice-5，2026-11-01）**：两片各一次——
  - slice-4 `T4`（TEST，写 AC-19/20 用例）：发现 `loadTasks()` 的 catch 调 `clearTasks()`，
    重试再次失败会清空已加载列表 → 提交失败，无验证记录；
  - slice-5 `T1`（TEST，写 AC-23 键盘顺序用例）：发现 `new-task-button` 在 DOM 里排在
    `search-input` 之前 → 提交失败，无验证记录。
  两例的任务 `output` 都是 `{"issues":[…]}`，`verification` 字段完全不存在——**失败发生在验证门之前**。
  **机制（file:line，逐环已证）**：
  1. `qa-agent` 的职责描述原文是「Writes AC-numbered tests first, runs them to show the red light,
     **and reports failures**」（`packages/agent-core/src/professional/AgentRegistry.ts:231`）——
     报出失败是它的设计行为。
  2. `submit_result` 的 `status` 是 `SUCCESS | FAILED | RETRY | REPLAN` 四选一
     （`packages/agent-core/src/professional/outcomeSchema.ts:45`），由 agent 自己填；
     agent 选了 `FAILED`，平台就把任务判失败，**验证门根本没跑**（所以既没有 `verdict`，
     也没有按 TEST 任务翻转红灯语义的机会）。
  3. 于是「红测试按设计写出、按设计报红」这条正常路径，变成任务失败 → 一轮 REPLAN。
  **代价**：每触发一次多一个动态任务 + 约 10 分钟；第十三轮两片各一次。
  **修法（方案 a）**：给 `qa-agent` 的 `systemInstructions` 追加一条
  `RED_TEST_OUTCOME_CONSTRAINT`（`packages/agent-core/src/professional/AgentRegistry.ts:135-145`）：
  「A red run is the expected outcome of this task, not a failure of it: once the AC-numbered tests
  exist and you have shown them failing for the right reason, submit status SUCCESS and attach that
  failing run as TEST_RESULT evidence. Submit FAILED only when the acceptance criteria cannot be met
  at all - never submit FAILED merely because the tests you were asked to write are red.」
  只加在写测试的那个 agent 上；实现类 agent 不继承这条语义（否则会被误读成「失败也算完成」）。
  平台侧判定**未改**：`submit_result` 仍按 agent 提交的 status 记账，验证门的红灯语义也不动。
  **测试**：`AgentRegistry.test.ts` 新增 1 例（qa-agent 含该条、frontend-agent 不含）；
  agent-core typecheck / lint / **327 例**全绿（原 326 + 1）。
  **判据（待下次回归实测）**：TEST 任务写出红灯用例后提交 `SUCCESS`；账本里不再出现
  「TEST 任务 FAILED 且无 `verification` 记录」的形状。
  **未采纳**：(b) 平台侧把「TEST 任务提交 FAILED 但产物是按 AC 命名的红用例」当正常终止——
  需要新判据、且会削弱「agent 自报失败」这个信号，风险高于收益。
  **归谁**：平台侧（agent 契约 / 提示词），不是产品缺陷。

- **N-73（已接线 2026-11-02；批次级读数已由 round20 关闭，2026-11-03）**：**前端交付链此前只是声明，从未被执行。**
  **现象**：rounds 8–13 的汇总里 staging 段恒为 `-/-/-`，`docs/233` §9 写着「交付链未接线」。
  **机制（file:line，逐环）**：
  1. 规划侧：`deliveryConfigured = Boolean(project?.repository)`（`planningService.ts:523` 等三处）
     ⇒ eval 项目没有仓库 ⇒ 提示词走 `NO_REPOSITORY_LINE` ⇒ **不排任何交付任务**；
     校验器还额外拒绝带 `delivery` 的任务（`validateTaskGraph.ts:65-69`）。
  2. 环境侧：没有 `deployment_environments` 行 ⇒ `DELIVERY_ENVIRONMENT_MISSING`；
     且该表有 `CHECK (adapter = 'docker')`，工作区优先项目**无法**声明 `static` 环境。
  3. 执行侧：`LocalCiOperations` 第一步就是 `git rev-parse HEAD`、最后一步 `docker build`；
     `LocalDockerOperations.deploy` 要镜像、`checkEndpoint` 探 `/health` + `/ready`——
     对一个静态预览站点，这三样都不成立。
  **修法（按 `docs/233` §5.4 的前端语义接线）**：
  - **适配器**：`CiInputSchema` / `ReleaseInputSchema` 增加 `adapter: docker|static`（缺省 docker，
    零行为变化），`repository` 改为仅 docker 必填（`packages/tool-runtime/src/tools/deliveryTools.ts`）；
    `LocalCiOperations` 在 static 模式下跳过 git 与 docker build，版本号取工作区内容摘要；
    新增 `LocalStaticOperations`：DEPLOY 起 `npm start` 静态预览（先按 `-sTCP:LISTEN` 停旧实例，
    避免对着旧 dist 假绿），VERIFY 用真浏览器探**已存在的 URL**（与 ui-smoke 同一套 testid 采集，
    `uiSmoke.ts` 新增 `urlProbeProgramArgs`），ROLLBACK 等价于重新部署
    （`apps/server/src/services/deliveryAdapters.ts`）。
  - **编排器**：`runCi` 按项目环境推断适配器，static 时不再要求仓库；deploy/verify/rollback 三条
    路径把 `adapter` 透传给工具（`deploymentOrchestrator.ts`）。
  - **规划门**：`isDeliveryConfigured(project)` = 有仓库 **或** 声明了 `static` 环境
    （`planningService.ts`）；最终切片的提示词按 profile 的 `delivery.chain` 选四个还是三个交付任务
    （`task-planning.prompt.ts`，前端链止于 staging，不再要求规划生产部署）。
  - **数据**：迁移 `019_n73_static_delivery_adapter.sql` 放宽 adapter 检查约束；
    `UpsertDeploymentEnvironmentSchema.adapter` 改为 `docker|static`（`packages/shared`）。
  - **评测侧**：夹具可声明 `delivery.environments`，harness 跑批前 upsert 进项目
    （`EvalFixture.delivery`、`harness.ts` 的 `ensureEnvironments`）；F1 声明
    `staging → http://127.0.0.1:18900 (static)`。
  **测试**：tool-runtime 2 例（static 的 run_ci 不要求 repository / docker 仍要求）；
  agent-core 2 例（前端 profile 只要三个交付任务 / backend profile 仍四个）；eval 3 例
  （环境逐个 PUT / 无声明不发请求 / 客户端没有 PUT 时明确失败）；server 2 例
  （真实子进程 + 真浏览器：deploy 起预览 + verify 命中 testid 通过；required 全不在时失败）；
  database 迁移清单与末位断言更新（3 例）。
  **已知边界**：`stopListening` 必须带 `-sTCP:LISTEN`——不带时 `lsof -ti tcp:<port>` 会把**连过**
  该端口的客户端进程一并列出（第一次实现因此杀掉了跑测试的 worker）。
  **判据（✅ round20 关闭，2026-11-03）**：最终切片排出 CI / staging DEPLOY / staging VERIFY 且全部
  SUCCESS；`run-1.json` 的 `stagingSegment` 为 `{ci:"SUCCESS",deploy:"SUCCESS",verify:"SUCCESS"}`，
  汇总「是（SUCCESS/SUCCESS/SUCCESS）」；oracle 24/24、真交付 100%、假阳/假阴 0；
  归档 `packages/eval/results/f1-frontend/round20/`。
  **归谁**：平台侧（交付链接入）。

- **N-74（已落地，2026-11-03；静态门 + 单测）**：**生成测试在同一状态段内写互斥期望 → CI 假阴性。**
  round18 形态：同一 `it` 里对同一查询先 `toEqual` 全量、再 `toEqual` 筛选子集，中间无状态变更；
  oracle 绿、CI 红。门禁 `CONTRADICTORY_TEST_EXPECTATIONS` 在 `pnpm test` 前静态扫描；
  `STATE_BOUNDARY_RE` 含 `.value=` / `setXxx(` 等。实现
  `apps/server/src/services/contradictoryTestExpectations.ts`，接入 Local CI。
  **归谁**：平台侧（测试卫生门）。

- **N-75 / 门禁 P1（已落地 2026-11-03；2026-11-04 09:06 上海时区重启 server 生效）**：
  矛盾门命中后若仍走「同契约盲目重跑 CI」，改测不会发生。P1：失败输出
  `fixTaskType=TEST`（`contradictoryCiReplanHint`）⇒ REPLAN =
  **DEBUG(target=TEST) → 同契约 CI retry**（`WorkflowEngine.replan` 拆派发键/契约键）。
  关键：`deploymentOrchestrator.ts`、`WorkflowEngine.ts`；单测含 workflow-engine「门禁P1」用例。
  **归谁**：平台侧（REPLAN 路由）。

- **T5 真实文档全流程**：需要用户提供真实 PRD + TRD（最好带 MCP 需求）**与一个真实仓库**；
  顺带补 T2/T3 的运行中链路实测，以及 T4 的三条「未做的验证」（`docs/232` §T4-5）。
- **视觉回归 → 自动开 FIX 任务**：按 §T3-7 的裁定仍然不做。

