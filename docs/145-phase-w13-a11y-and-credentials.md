# 145 · W13 a11y 扫描器扩展 / 屏幕朗读转录 / X1 模型与凭据配置

**阶段**：W13（承接 W12 收尾时押后的两项，加上排在 W 线之后的 X1）
**日期**：2026-10-15
**前置**：[144-phase-w12-frontend-leftovers.md](144-phase-w12-frontend-leftovers.md)（裁定表第 6/7/11 项）
**性质**：前端新增一个页面与一条路由；后端新增一个服务与一个只读+覆盖端点；**不新增 migration**；`packages/mcp` 首次获得 `MCPCredentialResolver` 的实现与接线。
**批次说明**：三项**打包执行**（做完再统一验收），偏离 `AGENTS.md` §9「一次任务只做一个已命名的阶段」。偏离已获用户明确授权（同 W7–W12）。

---

## 一、动手前先核实的两件事

1. **后端跑在 `tsx watch` 下**（端口 3000 = `tsx watch --include "../../packages/*/dist/**" src/index.ts` 的子进程）。这意味着改 `apps/server/src/**`、甚至只跑 `--filter @ai-se/server typecheck`（它会重建 `packages/*/dist`）都会**自动重启用户的真实后端**。当场核实：285 条工作流、3034 次运行**全部处于终态**（仅 1 条 `WAITING_APPROVAL`，那是等人不是等进程），重启不会打断任何执行。就此单独问过一次，用户裁定「三项全做，允许重启」。
2. **`MCPCredentialResolver` 仍然只是类型**（W12 已核实，本阶段复核确认）。`docs/15` 要求 X1 复用的「既有 Secret Provider」并不存在，所以 X1 的第一件事是**把它造出来**。

---

## 二、裁定表第 6 项 · axe 扫描器扩展（数据态 / 弹窗态 / 抽屉态）

### 问题

扫描器把每条 `:id` 都换成全零 UUID，于是**每个详情页都是在错误态下被扫的**：真正渲染出来的表格行、详情字段、时间线、审批卡、抽屉，从来没见过扫描器。弹窗与抽屉同样从未进过扫描。

### 改了什么

`apps/web/scripts/a11y.mjs` 原有 5 个阶段（axe 浅色 / axe 暗色 / 200% 缩放 / 强制高对比度 / 文本间距）在相位名、输出格式、退出码、以及「至少扫到 10 条路由」的反空扫断言上**一字未动**，只在其后追加 4 个阶段：

| 新阶段 | 扫什么 | 实际扫到 |
| --- | --- | --- |
| `axe/data` | 参数化路由改用**运行时发现的真实 id** | 5 条（3 条真实 + 2 条占位） |
| `axe/dialog-open` | 5 个页面的新建/设置弹窗打开后 | 5 条 |
| `axe/drawer-open` | `/workflows/:id` 的工作流详情抽屉 | 1 条 |
| `axe/reject-confirm` | 抽屉内「拒绝」审批确认框 | 1 条 |

真实 id 由**只读 GET** 在扫描开始时发现（`/api/projects`、`/api/workflows`、`/api/deployments`），偏好挑 `WAITING_APPROVAL` 的工作流（它渲染的内容最全）。发现逻辑抽到 `apps/web/scripts/a11yTargets.mjs`，与转录脚本共用，避免两份真相。

**发现失败不伪装成数据态**：后端不可达或响应形状不符时，退回占位符并把该阶段明确标成 `placeholder (未见真实数据)`，同时打印 `⚠ … 发现失败`。这条路径单独验过（把后端指到不存在的地址），不崩、不静默。

**`axe/reject-confirm` 绝不提交决定**：它只点抽屉里的「拒绝」（打开确认框），扫描，按 Esc 关闭，然后**三重断言**没有提交——①确认框已隐藏；②抽屉里的「拒绝」按钮仍在（提交后待审批项会消失）；③只读 GET 比对扫描前后待审批集合完全一致。任一不成立即记为硬错误并使退出码为 1。这条用的是用户**真实的**待审批记录。

### 证据

```
# 路由 14 条 × 4 阶段（axe 浅色 / axe 暗色 / 200% 缩放 / 强制高对比度 / 文本间距）
# 真实数据 id 发现：
#   /projects/:id          ← f16af318-… ［真实数据］
#   /workflows/:id         ← 57f98bf9-…（WAITING_APPROVAL，含审批与拒绝确认框） ［真实数据］
#   /deployments/:id       ← 1cf7426a-… ［真实数据］
#   /mcp/:serverId         ← 无真实数据（/api/mcp/servers 返回 0 条）→ 占位符 ［placeholder (未见真实数据)］
#   /mcp/:serverId/app     ← 同上 ［placeholder (未见真实数据)］
# 各阶段实际扫描路由数：axe/light 14 · axe/dark 14 · zoom200 14 · forcedColors 14 ·
#                      textSpacing 14 · axe/data 5 · axe/dialog-open 5 · axe/drawer-open 1 · axe/reject-confirm 1
✓ axe 无 WCAG A/AA 违规。
✓ 无水平溢出（200% 缩放 / 文本间距两阶段）。
```

`drawer-open 1` 与 `reject-confirm 1` 这两个计数就是证据本身：阶段失败会打出一条 `阶段失败` 并使退出码非 0，**不会**留下一个「扫了 0 条但报通过」的假绿灯。

**结果：零违规。** 所以本阶段没有任何违规可修，也没有为了「让数字好看」而放宽规则集（`runOnly` 仍是 `wcag2a/2aa/21a/21aa/22aa`）。

### 一处文档与代码不一致（按 `AGENTS.md` §9 报告，未默默对齐）

下达任务时把 `/workflows` 的弹窗触发器写成了「创建工作流」，**代码里实际是「新建工作流」**——「创建工作流」是那个弹窗的**标题**（`WorkflowsView.vue:403`）。若照任务书的字面去点，会得到一个永久的假失败「触发器缺失」。已按**代码**取按钮文案，并把「触发按钮认按钮文本、断言认弹窗标题」写进了脚本注释——正是这种不一致让二者不能写死成同一个串。

### 边界（未做）

- `/mcp/:serverId` 与 `/mcp/:serverId/app` **仍无真实数据**（库里 0 个 MCP server），因此仍是占位符扫描，且被明确标注。它反映的是当前事实，不是跳过。
- 弹窗阶段只覆盖任务点名的 5 个页面；`/settings` 走通用 5 阶段（它本阶段新增，已独立验过，见第四节）。
- `apps/web` 的 lint 是 `eslint "src/**/*.{ts,vue}"`，**不覆盖 `scripts/`**。这是既有状况（`a11y.mjs` 一直如此），本阶段不改 lint 门禁范围，只对新脚本跑了 prettier。

---

## 三、裁定表第 7 项 · 屏幕朗读转录

### 它是什么，不是什么

W12 说的是「交付 a11y 树快照作为可审阅替代品，并说明它不能替代真实 SR 走查」。本阶段交付的 `apps/web/scripts/a11yTree.mjs`（`corepack pnpm --filter @ai-se/web a11y:tree`）**不是屏幕阅读器录音**：它用 CDP `Accessibility.getFullAXTree` 取浏览器无障碍树，按树序推导出一条**线性朗读顺序**，并把交互控件里「名字为空」或「名字来自 placeholder」的项单独列为「命名问题」。

> 必须说清楚：**真实屏幕阅读器走查仍然需要人耳**。转录能证明「树是对的」，证明不了「念出来是顺的」。

`page.accessibility.snapshot()` 在 Playwright 1.61 里已不存在，CDP 是唯一路径。

### 产物

[145-a11y-transcript.txt](145-a11y-transcript.txt)（约 79 KB，10 个状态：7 个列表页、1 个真实数据详情页、1 个打开的弹窗、1 个打开的工作流详情抽屉）。

**一个具体的跨阶段收获**：弹窗状态的树里能看到

```
dialog "新建项目" (focusable, describedby=reka-dialog-description-v-2)
  // desc: "项目是需求、工作流与部署的归属单位；仓库地址可以留空，之后在项目详情页绑定。"
```

W12 补的那 5 句可见描述，第一次以「屏幕阅读器真的会念出来」的形式被观察到——在此之前它只是「属性存在」和「告警消失」。

**10 个状态的「命名问题」全部为 0。** 检测器本身单独验过：给它一个只有 placeholder 的 `<input>` 和一个无名的 `<button>`，它确实报得出来（不是一个恒真的空扫描）。

### 它证不到的（照录）

- 朗读**顺序**是否符合心智模型、措辞是否顺耳 —— 需要人耳。
- 动态播报（`role="status"` 的实时区域在真实交互中是否真的被念）—— 需要人耳。
- 转录是**某一时刻的快照**，数据一变就过时；它是文档，不是门禁。

### 裁定：不做真实屏幕阅读器走查（2026-10-15，用户）

本项从 W11 起以「未做 / 押后」的形式被承接了两轮。用户裁定**不再安排人耳走查**，本项**就此关闭**，不是「押后」——后续阶段的「未做事项」清单**不应再列它**。

**关闭它意味着放弃的覆盖面**（照录，不粉饰）：转录能证明「无障碍树是结构正确的、每个控件都有像样的名字」，但证明不了四件事——①念出来顺不顺耳、有没有歧义；②动态插入的内容（**尤其是表单提交失败的提示**）有没有被播报；③焦点走向（开弹层后落在哪、关掉后回哪、报错后跑哪）；④不使用眼睛能否真的完成任务。这四条里，②在本仓有**已知的具体候选**：`ProjectsView` / `SettingsView` / `ProjectDetailView` / `MCPServerDetailView` 的表单错误提示是普通 `<p class="text-danger">`，**不是 live region**（`role="alert"`），用户按了提交而失败时很可能什么都听不到。**该项不修**：它不属于 WCAG A/AA 的失败项，且现在没有能验收它的手段（验收手段正是被关闭的这项）。

保留的一句话：**本仓因此不声称「全站对屏幕阅读器可用」**，只声称「axe 在 14 路由 × 9 阶段零 WCAG A/AA 违规」与「无障碍树结构可审阅」。这与 W9/W10 一贯的限定口径一致。

---

## 四、X1 · 模型与凭据配置

### 4.1 X1-a · 让「既有 Secret Provider」第一次真实存在

`packages/mcp/src/security/credentials.ts` 自述 *"deliberately not a secret store"*，全仓**零实现、生产零接线**。不接线的后果是 `RemoteMCPClient.ts:474` 对任何带 `credentialRef`/`authRef` 的服务器直接抛 CONNECTION 错（fail-closed，行为正确但等于该功能不可用）。

新增 `apps/server/src/services/envCredentialResolver.ts` 并在组合根注入（`index.ts` 的 `new RemoteMCPClient({ credentialResolver: createEnvCredentialResolver(), … })`）：

- `secret:mcp/servers/github` → 环境变量 `MCP_SECRET_MCP_SERVERS_GITHUB`
- **映射结果永远带 `MCP_SECRET_` 前缀**，所以一个引用无法点名任意环境变量（`secret:../etc/passwd` 只会被压成一个同前缀的名字）
- 非 `secret:` 前缀的引用一律不解析（返回 undefined），不去猜
- 全空白视为未配置（配错成空格比没配更隐蔽）；有内容时**原样**返回，不 trim —— 静默改掉一个密钥的值比让它失败更糟
- 未配置 → 返回 undefined → 客户端走既有 fail-closed 路径，错误文案不变

它**只读进程环境变量**：没有表、没有文件、没有第二套密钥体系。解出来的值只交给构建请求头的代码，不进日志、不进 State、不回显。

### 4.2 X1-b · 运行时可改的模型配置

新增 `apps/server/src/services/modelConfigService.ts`：持有 `{ model, baseUrl, apiKey }`，启动值来自环境变量，控制台写入的覆盖只活在进程内存。

**为什么「就地改写同一个对象」而不是每次返回新对象**——这是本阶段最容易踩空的地方。组合根把 `getOptions()` 的返回值交给了 `PersistentWorkflowTaskExecutor`，而它在**每个任务开始时**才 `createOpenAIChatModel({ ...this.dependencies.llmOptions, sessionId: task.id })`。执行器持有的是那个**引用**：换成新对象等于换掉引用，控制台改完配置也不会生效。所以 `ModelConfigService` 改的是对象本身，`getOptions()` 返回同一个引用。有一条测试专门钉这个不变量。

**另外两条路径只在启动时构造一次**（planning 的模型、`AgentRunService` 的 provider），光靠上面的手法覆盖不到。新增 `apps/server/src/services/liveModel.ts` 的 `LiveLLMProvider` / `LivePlanningModel`：每次调用前比对配置版本号，变了就用最新配置重建真正的 provider。

选包装器而不是把 `PlanningModel` / `LLMProvider` 的依赖声明改成工厂函数，原因是**不改那两个服务的契约、也不动它们既有的测试**（`planningService` 的 `model` 依赖在 6 处测试里被构造）。分工是：**怎么建**由组合根通过 `build` 回调解出（它才知道要传 `sessionId`、`structuredOutputMethod`），**什么时候重建**由包装器决定。这也与组合根既有的装饰器文化一致（`VerifyingWorkflowTaskExecutor` / `RedactingWorkflowTaskExecutor`）。

于是「改配置」对三条模型路径**一致生效**——不一致的版本（「工作流任务生效了、Agent 运行没生效」）比完全不管用更难排查。

### 4.3 X1-c · 设置页

新增 `/settings`（`SettingsView.vue` + `api/modelConfig.ts` + `stores/modelConfig.ts` + `viewmodels/modelConfigViewModel.ts`）。侧栏新增「系统」组（与路由 `meta.group: "系统"` 对应），命令面板补上「设置」条目（它有一份显式页面清单，不补就与侧栏不一致）。

页面两件事：读**当前生效**的配置（提供方 / 模型 / Base URL / 密钥是否已配置 / 来源），以及改**运行时覆盖**（模型 / Base URL / API 密钥）。

四处刻意的取舍：

1. **密钥输入框永远是空的。** 服务端从不回显密钥，所以「把现有密钥读回输入框」这条路径根本不存在；留空 = **不改动**（不是「清除」——用户没输入不代表他想删）。
2. **只发送真的改了的字段。** 否则「打开页面 → 直接保存」会把环境变量里的值原样写成一个运行时覆盖：值没变、来源却变成 `runtime`，一个看不见的假改动。
3. **表单是「未编辑时直接呈现服务端当前值」**（可写计算属性 + 草稿），而不是「ref + watch 回填」。后者在配置读回来之前表单是空的，而空表单会被判定成「全改过」——手快一点就会把几个字段一起写成 `null`，等于清掉覆盖。加载完成前**只渲染骨架，不渲染表单**。
4. **提供方（mock / openai）只读。** 它是部署级选择，改它要重新装配整条模型链路，不是一次表单保存能承担的事。提供方是 mock 时，页面**明说**「下面的改动要等部署切到 openai 才会生效」，不让人对着一个不会生效的输入框发呆。

### 4.4 安全边界（AGENTS.md §10）

- 读回对象**没有 `apiKey` 字段**，只有 `apiKeyConfigured` 布尔；有一条测试断言整个响应文本里不含密钥值。
- 校验失败时**不返回** `parsed.error.flatten()`：这个请求体里可能有明文密钥，校验明细会把它的形状带回响应与错误日志。这里只回一句「不合法」。
- 密钥不落库、不落盘、不进日志。`update()` 不打印 patch。
- 需要说明的一处事实：`apiTokenGuard` 默认是**关**的（本地 localhost 开发），所以 `PUT /api/model-config` 在默认配置下**无需鉴权**。绑定到非回环地址时 `assertListenSecurity` 会拒绝启动，除非配了 `API_TOKEN`。这是既有设计，本阶段沿用，没有为这一个端点新造鉴权。

### 4.5 证据

设置页对**真实后端**的只读走查 **20/20 通过**（`/tmp/w13-browser.cjs`），要点：

```
PASS  侧栏「设置」是当前页（aria-current=page）        PASS  顶栏区域显示「系统」
PASS  读回「模型」与 API 一致                          PASS  读回「提供方」为 Mock
PASS  密钥框是密码类型 / 且是空的                      PASS  模型框回填了当前值
PASS  未改动时「保存」禁用                             PASS  改了模型后「保存」变为可用
PASS  改回原值后「保存」重新禁用（不制造假覆盖）       PASS  页面没有任何 console 警告/错误
PASS  走查未改动后端配置（仍是 env、无覆盖）           PASS  1440 下无水平溢出
```

最后一条是**用 API 复核的断言**：走查结束后 `GET /api/model-config` 仍是 `source=env, overridden=[]`，证明这次走查没有改动用户后端的状态。

设置页另做了**独立**的 axe 检查（不受扫描器改动影响），明/暗 × 桌面/手机四个组合：

```
PASS  light · 1440×900 / 390×844    PASS  dark · 1440×900 / 390×844
```

四个组合全部零违规、零水平溢出。这也顺带补上了 W12 登记过的一个缺口（「小视口未测」）的其中一页。

---

## 五、阶段报告

### Modified Files

**新增 · 服务端（4 + 3 测试）**

- `apps/server/src/services/modelConfigService.ts` —— 模型配置的唯一可变来源（活对象）
- `apps/server/src/services/liveModel.ts` —— `LiveLLMProvider` / `LivePlanningModel`（按版本号重建）
- `apps/server/src/services/envCredentialResolver.ts` —— `MCPCredentialResolver` 的第一个实现
- `apps/server/src/routes/modelConfig.ts` —— `GET` / `PUT /api/model-config`
- `apps/server/src/__tests__/modelConfig.test.ts`、`envCredentialResolver.test.ts`、`modelConfigApi.test.ts`

**新增 · 前端（4 + 3 测试）**

- `apps/web/src/api/modelConfig.ts`、`stores/modelConfig.ts`、`viewmodels/modelConfigViewModel.ts`、`views/SettingsView.vue`
- `apps/web/src/stores/__tests__/modelConfig.test.ts`、`__tests__/modelConfigViewModel.test.ts`、`__tests__/settingsView.test.ts`

**新增 · 脚本（2）**

- `apps/web/scripts/a11yTargets.mjs` —— 路由提取 + 真实 id 发现（无副作用，供两个脚本共用）
- `apps/web/scripts/a11yTree.mjs` —— 屏幕朗读转录 + 原始 AX 树导出

**新增 · 文档（2）**

- `docs/145-phase-w13-a11y-and-credentials.md`（本文件）、`docs/145-a11y-transcript.txt`（转录产物）

**修改**

- `packages/shared/src/index.ts` —— 新增 `ModelConfigField` / `ModelConfigSource` / `ModelConfigStatus` / `ModelConfigPatch`（跨包契约，按 §3）
- `apps/server/src/index.ts` —— `ModelConfigService` 接线；两条启动时构造的模型路径改走 `Live*`；`RemoteMCPClient` 注入 `credentialResolver`
- `apps/server/src/app.ts` —— 新增可选依赖 `modelConfigService` 与挂载
- `apps/web/src/router/index.ts`（+`/settings`）、`components/layout/AppSidebar.vue`（+「系统」组）、`viewmodels/commandPaletteViewModel.ts`（+设置）
- `apps/web/src/__tests__/appShell.test.ts` —— 导航项 8 → 9（既有护栏正常触发）
- `apps/web/scripts/a11y.mjs`、`apps/web/package.json`（+`a11y:tree`）
- `docs/09-api-design.md`（新端点的正本）

### Implementation

三项全部落地。后端**新增 1 个服务 + 1 个路由 + 1 个接线**，未新增 migration、未新增运行时依赖、未改任何既有接口契约（`/api/model-config` 是新增路径）。前端新增 1 页 1 路由 1 侧栏组；既有页面的业务逻辑一行未改。

### Architecture Changes

**1. `.env 启动时读一次` → `运行时可改、进程内存态`。** 模型配置从「启动时被捕获的常量」变成「组合根持有的唯一可变来源」。这不是把 `.env` 换成数据库，而是明确承认：在不新增第二套 Secret 体系（§10）的前提下，「运行时可改」与「不落盘」只能同时成立于内存。代价（重启即失效）写进了页面文案与 Known Issues，不伪装成完整方案。

**2. 两条「只在启动时构造一次」的路径改为惰性重建。** 用包装器而非改依赖契约，保住了 `planningService` / `agentRunService` 的接口与既有测试。判据是「配置变更后**三条**模型路径行为一致」，而不是「主路径能用就行」。

**3. 扫描器的覆盖对象从「路由」扩展到「状态」。** 此前扫的是「一条路由在错误态下的样子」，现在扫的是「列表/详情/弹窗/抽屉四种真实状态」。`axe/data` 的**真实 id 在运行时发现**，所以它不会随着数据变化而过时，也不会把占位符扫出来的错误态冒充成数据态。

**4. 无障碍证据的形态从「零违规」扩展到「可审阅的朗读范围」。** 零违规是阈值证据，转录是可读证据——两者互不替代，本阶段都交付，并明确转录不是 SR 走查。

### Dependencies

无新增依赖（`dependencies` 与 `devDependencies` 一字未改）。`playwright` / `axe-core` 是 W11 已有的 devDependency。

### Tests

```
apps/web    : Test Files 39 passed (39)   Tests 473 passed (473)    ← 450 → 473
apps/server : Test Files 43 passed (43)   Tests 244 passed (244)    ← 227 → 244
全仓        : typecheck 16/16 Done · lint 16/16 Done
```

> `apps/server` 那一行是**按包单跑**的结果。收尾时的全仓 `-r run test` 出现过失时序敏感 e2e 失败 —— 见 Known Issues 7（与本次改动无关，机器负载所致）。

净增 40 条（web +23、server +17）：

| 用例组 | 覆盖 |
| --- | --- |
| `modelConfig`（服务端） | 状态不含密钥值 / `getOptions` 返回同一引用（「运行时可改」的不变量）/ `overridden` 与清除回落 / 版本号推进 / `apiKeyConfigured` 只反映有无 |
| `modelConfig`（服务端） | `LiveLLMProvider` 与 `LivePlanningModel` 的「未变复用、变更重建」与转发 |
| `envCredentialResolver` | 引用 → 环境变量名映射 / 命名空间前缀不可逃逸 / 未配置与空值返回 undefined |
| `modelConfigApi` | 回读无密钥 / 覆盖立即生效 / 空串与 null 同义 / 校验失败不回显请求体 |
| `modelConfigViewModel` | 未改动 → 空 patch / 只带改动字段 / 清空 → null / 密钥留空与只敲空格 / 表单回填映射 |
| `modelConfig`（store） | load 与 save 的成功失败通道 / `null` 的清除语义不被吞掉 |
| `settingsView` | 页头与读回 / 密钥框只写不读 / for-id 关联 / 保存与清除按钮的禁用条件 / mock 提示 / 加载骨架 / 错误态 |
| `appShell`（改） | 导航项 8 → 9 |

### Lint

`corepack pnpm -r run lint` 16 包全部 Done。`apps/web` 的 lint 只覆盖 `src/**/*.{ts,vue}`，**不含 `scripts/`**（既有状况，见 Known Issues 3）。

### Typecheck

`corepack pnpm -r run typecheck` 16 包全部 Done（`vue-tsc --noEmit` / `tsc --noEmit` 无输出）。

### E2E

- **设置页对真实后端只读走查 20/20**（§4.5），含「走查未改动后端配置」的 API 复核。
- **设置页「保存」往返 18/18**（收尾时补验，用户授权一次可回滚的写入）：浏览器实际发出 `PUT`、响应不含密钥、清除后回落 `env`，收尾状态与开工前逐字段一致。
- **扩展后的 axe 扫描：14 路由 × 9 阶段，零违规、零水平溢出**（§二）。
- **屏幕朗读转录：10 个状态，「命名问题」全部为 0**（§三）。
- **设置页独立 axe：明/暗 × 1440/390 四个组合零违规**（§4.5）。
- 服务端 API 级 e2e（supertest 打真实 Express 应用）覆盖 `/api/model-config` 的读写与校验失败路径。

### Known Issues

1. **浏览器 → API 的「保存」往返：已补验（收尾时，用户授权一次可回滚的写入）。** 原先按走查边界只验到 UI 的禁用条件、渲染与读路径，没有点下「保存」；W13 收尾时补跑了完整往返：浏览器填三处 → 保存 → 复核 → 清除覆盖 → 复核回落。**18/18 通过**，其中关键几条：浏览器**确实发出了** `PUT /api/model-config`（拦截网络确认，不是只断言 UI）；**响应体与整个页面文本里都不含探针密钥值**（只有 `apiKeyConfigured` 布尔）；服务端 `overridden` 三字段齐全；清除后 `source` 回到 `env`。**收尾状态与开工前逐字段比对完全一致**（探针密钥是明显假的字符串，且随覆盖一起清除）。
2. **`PUT /api/model-config` 在默认配置下无需鉴权。** `apiTokenGuard` 默认关闭（`apps/server/src/app.ts`），本地 localhost 开发即如此；非回环监听会被 `assertListenSecurity` 拒绝启动（需配 `API_TOKEN`）。这是既有设计，本阶段沿用，没有为单个端点另造一套鉴权。
3. **`apps/web` 的 lint 不覆盖 `scripts/`。** 新增的两个脚本只跑了 prettier。既有的 `a11y.mjs` 一直如此；本阶段**没有**扩大 lint 门禁（那是一次会影响所有人的配置改动）。
4. **MCP 凭据只能来自环境变量，设置页不管它。** `envCredentialResolver` 解决的是「引用能解析」，不是「引用能在界面上配」。而且库里 0 个 MCP server，所以它对真实数据的表现未被验证过。
5. **`provider` 不能在运行时改。** 提供方是 mock 时，用户改了密钥也不会生效——页面用一句话明说，没有把它做成看起来能用的控件。
6. **已经在跑的任务不会被换掉 provider。** `Live*` 在每次调用前重建，但按 run 构造出来的 provider 是那一刻的快照。这是刻意的：跑了一半的任务中途换密钥/模型，比直接失败更难查。
7. **`apps/server` 的 e2e 在当前机器负载下会偶发失败（与本次改动无关，但必须记下来）。** 收尾时连跑**三次**全仓 `-r` 与 `--filter @ai-se/server test`，失败的是**七个互不相同**的文件：`finalSliceGovernance` FX-13b、`terminationPropagation` FX-35、`failureRecovery`（external CANCELLED）、`projects.test`（coding agent demo）、`mcpAppsApi`（TIMEOUT）、`workflowApi`（两条 retry）、以及一次被截断的条目。**七个文件逐个单独复跑全部通过**（7/7、6/6、10/10、26/26 …）。三轮下来没有一个是重复的，这是负载抖动的典型形态，不是回归。**没有去修**：等待窗口是既有设计，调它是后端线的事（`AGENTS.md` §9）。**留给后端线登记。**
8. **`/settings` 的移动端是独立验过的，但弹窗描述的版式在窄视口下仍未量过**（W12 Known Issue 2 的延续，本轮未消）。
9. **转录是快照。** `docs/145-a11y-transcript.txt` 里含用户的真实数据（项目名、任务标题、真实 id），数据一变就过时；它是一次可审阅的证据，不是门禁。
10. **`docs/09-api-design.md` 是本阶段唯一更新的历史文档**（新增端点必须留档）。历史阶段报告一律未回改。
11. **`GET /api/workflows` 忽略 `pageSize` / `page`，返回全量（285 条）的裸数组**，而多数其它列表端点是 `{ items, total }` 信封。前端是纯客户端切片（W7）所以不受影响，扫描器的发现逻辑也三种形状都兜住了。记在这里是因为收尾核对时**我按 `{items}` 读它、拿到了空数组，一度误判「待审批数从 1 变成 0」**——真实原因是我自己的查询写错了信封字段，不是数据出了问题（复核：审批 `4fecaef8-…` 的 `updatedAt` 仍等于 `createdAt`，从未被更新，仍是 `PENDING`）。**这个不一致本身未修**（既有契约，不在本阶段范围）。

### Acceptance Result

**通过。**

| 三项工作 | 判定 | 证据 |
| --- | --- | --- |
| axe 扫描器扩展 | 已解决 | 14 路由 × 9 阶段零违规；`data/dialog-open/drawer-open/reject-confirm` 计数分别 5/5/1/1（真扫到了）；拒绝阶段三重断言未提交决定 |
| 屏幕朗读转录 | 已解决（**不是** SR 走查） | 10 状态转录已产出；「命名问题」全 0；W12 的弹窗描述首次在树里被观察到 |
| X1 · 模型与凭据配置 | 已解决 | 真实后端只读走查 20/20；独立 axe 四组合零违规；服务端 17 条新测试；密钥不回显有断言 |

```
packages/shared · apps/server · apps/web 等 16 包 : typecheck ✓  lint ✓
apps/web    : test 473/473 ✓   build ✓   a11y 14 路由 × 9 阶段零违规 ✓
apps/server : test 244/244 ✓
真实后端    : 设置页只读走查 20/20 ✓（并复核未改动其配置）
```

> **一条保留**：全仓 `-r run test` 的**单次调用**反复出现「一条时序敏感的服务端 e2e 失败」，三轮七个文件全部不同、逐个复跑都通过（Known Issues 7）。上表的数字来自按包复核的结果，不是那几次 `-r` 调用的输出。**不声称「一次 `-r` 跑通」。**

### Next Phase Boundary

**本阶段结束。** 边界：

- **未改既有接口契约**：新增 `/api/model-config`；`apps/server/src/index.ts` 的两处 provider 构造改了实现（`LangChain*` → `Live*`），但下游服务的依赖类型与调用方式未变。
- **未新增 migration、未新增依赖**。`ModelConfigService` 不持久化任何东西。
- **未动 `dist/`**。
- **未改 W11/W12 的历史报告**（`docs/142`/`143`/`144` 一字未动）。
- **用户真实数据未被改动**：审批仍为 `PENDING`（扫描器自己用只读 GET 断言）、后端配置仍为 `source=env, overridden=[]`（走查脚本用 API 复核）。

**仍未开始**：`provider` 的运行时切换（需要重新装配模型链路，是独立的一次设计）。

**已裁定不做**：真实屏幕阅读器走查（VoiceOver / NVDA）。理由见 §三。

---

## 六 · 与 W12 裁定表的对应

| W12 裁定表第 N 项 | W13 处置 |
| --- | --- |
| 6 · axe 未覆盖数据态 / 弹窗态 / 抽屉态 | **本阶段做**：+4 阶段，含拒绝确认框；零违规 |
| 7 · 真实屏幕阅读器走查 | **以「朗读转录」替代，随后裁定不做**：交付可审阅转录并讲清它替代不了什么；用户 2026-10-15 裁定不再安排人耳走查 |
| 11 · X1 前提（密钥存哪儿） | **本阶段落地**：内存态运行时覆盖 + `envCredentialResolver`；`provider` 保持只读 |

---

## 七 · 勘误（追加块，2026-10-21）

> 依据 `docs/146` §6 规则 7：本文件是**历史记录（冻结）**，勘误**只以追加块**落地。
> 上方 Known Issues **7** 一字未动。

### 7.1 抖动清单新增一例（PL-M25 收尾时观察，`docs/202` §6.1）

**新观察的文件/用例**：`apps/server/src/__tests__/v1GoldenScenario.e2e.test.ts` 的
**「server restart」**用例——`waitFor timed out`（30s）。

**为什么归入同一族（即上方第 7 条的那一族）**：

| 轮次 | 结果 |
| --- | --- |
| 全量 1 | **325 / 326**，该用例超时 |
| 全量 2 | **325 / 326**，该用例超时 |
| **单独复跑**（`-t "server restart"`） | **通过，3.39s** |
| 全量 3 | **326 / 326**（35.61s） |
| 全量 4 | **326 / 326** |

⇒ 形态与第 7 条**完全一致**：全量下超时、单独复跑即过、轮次间不复现 ⇒ **负载敏感的时序抖动**。

**为什么确信与 PL-M25 无关（三条，均指到代码）**：

1. 该用例用**自己的 `crashExecutor`**（一个永不 settle 的 Promise 模拟「旧进程死在任务中」），
   策略为 `failureStrategy: "FAIL_FAST"` / `allowReplan: false` ⇒ `debugTargetType` **不被调用**；
2. 等待窗口内 A 成功、B 挂起，**没有任何任务失败** ⇒ `failedTaskOutput` 也**不被调用**；
3. 它不使用职业 agent ⇒ agent-core 的三处改动（`outcomeSchema` / `types` / `ProfessionalAgent`）
   **同样不可达**。

**未弱化任何测试**。该用例此前**不在**本清单里，是**新观察**，按仓库既定做法
（「单独复跑通过即记为该族」）补入。

**建议（未做，留待后端线）**：给这个 Docker + Chromium 用例**放宽超时**或**标记为串行**——
它的 30s 等待窗口在满负载的全量套件里余量不足。**本阶段不动**（`AGENTS.md` §9）。
