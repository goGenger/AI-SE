# 233 · 前端专用夹具与浏览器验收（设计提案）

> **文档性质**：设计提案，**不含实现**。按 `AGENTS.md` §9，本文只把「要建什么、判据是什么、怎么算通过」
> 定清楚；实现另立命名阶段，需另行授权。
>
> **输入判断**（用户 2026-10-27）：平台应做**前端动态工作流**，不再试图覆盖后端语言的多样性与高度定制化
> 开发。本文把该判断落成一套可测量的夹具与门。

---

## 1. 判断与产品口径

### 1.1 为什么后端不可涵盖

后端没有通用的验证面。每个技术栈的构建、测试、打包、部署约定都不同，行为正确性还藏在「起服务 + 造数据」
之后。评价这套平台时我们刚用十二轮回归证明：**一个**后端栈（Node、零依赖）要稳定通过，代价集中在验证
契约上（N-13/N-26/N-27/N-34/N-49/N-53/N-54/N-55 全部产自这一层）。换成 Java/Go/.NET，这套契约要
逐语言重写一遍。

### 1.2 为什么前端可以涵盖

不是因为前端简单，而是因为**验证面可以收敛到一个通用层：浏览器**。Vue / React / Svelte 的工程形态不同，
但「页面打开后看到什么、点了之后发生什么、控制台有没有报错」对所有框架是同一套判定面。栈的多样性被这一层
吸收。

同时有一个容易被忽略的事实：**前端工程本身也是 Node 生态**（Vite / Vitest / pnpm），所以平台现有的
「package.json scripts → 检查」这一层，在前端场景下**恰好是对的**，不需要拆。结论：

> 这次转向是**加法**：保留 Node 脚本契约（承担逐任务验证），新增浏览器 oracle 与 UI 边界冒烟
> （承担切片边界与端到端判定）。**不重写** N-55 那一套。

### 1.3 产品口径（建议写进定位）

> 平台把「PRD + 既有后端契约」变成「**经验证的前端**」；后端不生成、不改写，只按契约消费。

这条边界一旦写死，平台的验证契约就只有一套，也才有资格说「涵盖得住」。

---

## 2. 范围与非目标

**本阶段范围**

- 一个新夹具 **F1**（前端专用），固定单栈；
- 一个黑盒 **浏览器 oracle**（Playwright），按 AC 逐条判定；
- 一个 **UI 边界冒烟**（切到「页面起没起来、关键元素在不在、控制台干不干净」）；
- 一条可测量的 **前端交付链**：CI 构建 → staging 静态预览 → staging 浏览器验证。

**非目标（明确不做）**

| 不做 | 理由 |
| --- | --- |
| 生成后端 / BFF | 与本转向相反，会把砍掉的复杂度请回来 |
| 接真实后端 | 本阶段用固定契约 + mock；接真实后端是后续独立阶段 |
| 视觉回归（像素比对） | 截图只作失败证据，不做 diff；像素门对字体/抗锯齿极其敏感 |
| 多框架夹具（React/Svelte） | 本阶段固定 Vue 3；框架多样性是产品层议题 |
| production 部署 | 没有真实托管环境；F1 的交付链止于 staging verify |
| 每任务跑浏览器验证 | 成本与抖动都太高；浏览器判定只在边界与 oracle |

---

## 3. F1 夹具设计

### 3.1 被测产品

**TaskBoard UI**：与 E1 同域（任务看板），降低理解成本，但**只有前端**。

| 项 | 取值 |
| --- | --- |
| 技术栈（固定） | Vue 3 + TypeScript + Vite + Vitest + `@vue/test-utils` |
| 后端 | 夹具自带 `mock-server`（Node 标准库，读 JSON fixtures，端口读 `PORT`） |
| 前后端连接 | 前端只读 `VITE_API_BASE`；Vite dev/preview 由该变量指向 mock |
| 构建产物 | `dist/`，`pnpm build` 退出 0 |

**为什么固定单栈**：夹具要能跨批次比较。让规划器自选框架会让读数无法归因——那是产品层要单独论证的事。

**为什么 mock 用独立进程而不是 MSW**：service worker 在 preview 下多一层注册失败面；独立 mock server
更可控、更接近「真实契约」，也便于按 journey 注入延迟/错误（见 §4.3）。

**固定契约（mock 实现，6 个端点）**

```
GET    /api/tasks               → 200 [{id,title,done,createdAt}]
POST   /api/tasks               → 201 {…}     400 标题为空
PATCH  /api/tasks/:id           → 200 {…}
DELETE /api/tasks/:id           → 204
GET    /api/tasks?error=1       → 500（供错误态 journey）
GET    /__mock/requests         → 200 [{method,path,body}]（请求计数，供「不该发请求」的断言）
```

### 3.2 写进 `requirementText` 的硬性约束

1. **工程契约**：pnpm 工程，提交 `pnpm-lock.yaml`；`package.json` 提供 `start`（`vite preview`，端口读
   `PORT`）、`test`（vitest run）、`lint`、`typecheck`、`build`。
2. **UI 契约**：所有被 AC 点名的交互元素必须带 `data-testid`，命名见下表；**禁止**用文本/CSS 类作为
   验收选择器。
3. **网络**：只允许访问 `VITE_API_BASE`；禁止外部 CDN、禁止内联远程字体。
4. **状态**：加载 / 空 / 错误 / 有数据四态都必须可达（mock 可控触发）。
5. **不写后端**：不得新增任何后端实现；不得修改 mock 的行为。

**testid 命名表（AC 与 UI 共用，避免命名漂移）**

```
app-title  loading-indicator  error-banner  retry-button
search-input  filter-all  filter-active  filter-done  task-count
task-list  task-item  task-title  task-done-toggle  task-delete-button
empty-state  no-results  new-task-button  new-task-dialog
task-title-input  save-task-button  cancel-task-button  form-error
```

### 3.3 AC 清单（20 条 Must + 4 条 Should）

**每条都写成「可观察」陈述**，并注明由谁判定：`O` = oracle（浏览器）、`B` = 边界冒烟、`T` = 项目自测。

| AC | 陈述 | 判定 |
| --- | --- | --- |
| AC-01 | 打开 `/` 后 `app-title` 可见且文本非空 | O |
| AC-02 | 首屏加载期间出现 `loading-indicator`，数据到达后消失（mock 延迟 800ms 可控） | O |
| AC-03 | mock 返回 3 条时 `task-item` 恰好 3 个，顺序与 mock 一致 | O/B |
| AC-04 | 每个 `task-item` 内 `task-title` 文本等于 mock 的 title | O |
| AC-05 | mock 返回 0 条时显示 `empty-state`，且不渲染任何 `task-item` | O |
| AC-06 | 点击 `new-task-button` 打开 `new-task-dialog` | O |
| AC-07 | 标题为空点 `save-task-button` → 出现 `form-error`，且 `/__mock/requests` 无 POST | O |
| AC-08 | 填标题保存 → 对话框关闭、列表新增一项**且新任务位于列表首位**、`task-count` 加 1 | O |
| AC-09 | 保存遇 500 → `error-banner` 可见且对话框保持打开 | O |
| AC-10 | 保存进行中 `save-task-button` 处于 disabled，完成后恢复 | O |
| AC-11 | 输入关键字 → 仅匹配项可见，非匹配项消失 | O |
| AC-12 | 搜索无结果 → 显示 `no-results`，不显示 `empty-state` | O |
| AC-13 | 点 `filter-done` → 仅已完成项可见 | O |
| AC-14 | 点 `filter-all` → 恢复全部 | O |
| AC-15 | 搜索 + 筛选叠加 → 结果同时满足两者 | O |
| AC-16 | 点某任务 `task-done-toggle` → 该项 `data-done="true"` | O |
| AC-17 | 已完成状态在刷新后保持（经 mock 持久化） | O |
| AC-18 | 点 `task-delete-button` → 该项消失、`task-count` 减 1 | O |
| AC-19 | 列表首次 500 → `error-banner`；点 `retry-button` 后正常渲染 | O |
| AC-20 | 整个 oracle 运行期间浏览器控制台 **无 error**（网络 4xx 日志除外） | O |
| AC-21 | 列表首屏在 3s 内出现 `task-item`（性能口径，非动画） | O |
| AC-22 | 375px 视口下页面无横向滚动 | O |
| AC-23 | 键盘 Tab 可依次到达搜索框、新建按钮、首个任务项 | O |
| AC-24 | 暗色模式下 `task-item` 背景取暗色 token（计算样式比对） | O |

**Should（AC-21..AC-24）** 不参与「Must 全过」判定，但会被记录；它们的作用是提前暴露「门只能看功能、
看不见可用性」的盲区。

### 3.4 切片划分（4 片）

| 切片 | 目标 | AC | 依赖 | involvesUi |
| --- | --- | --- | --- | --- |
| `f1-skeleton-list` | 骨架 + 四态 + 列表渲染 | AC-01..05 | — | true |
| `f1-create-task` | 新建对话框、校验、失败态 | AC-06..10 | skeleton | true |
| `f1-search-filter` | 搜索、筛选、叠加 | AC-11..15 | create | true |
| `f1-toggle-delete-resilience` | 完成/删除、错误重试、刷新保持 | AC-16..20 | search-filter | true |

四片都声明 `involvesUi: true`（该字段已存在，`packages/shared/src/index.ts:937`，当前只用于跳过 `ui_spec`；
本设计复用为 UI 边界冒烟的触发条件，见 §5.2）。

### 3.5 模板 / 参考实现 / 变异体

```
packages/eval/fixtures/F1/
  fixture.json           # {id:"F1", tier:"F1", requirementText, oracle, oracleTimeoutMs, runTimeoutMs}
  oracle.mjs             # 黑盒浏览器 oracle（§4）
  mock-server.mjs        # 契约 mock（模板与 oracle 共用一份）
  template/              # 初始工作区：骨架 + mock + 空 App（无任何业务 UI）
  reference/             # 参考实现（只用于 oracle 自检与 flake 测量；不得进入工作区/提示词）
  mutants/
    empty-shell/         # 与 reference 相同，但 `/` 渲染空容器 —— 反向门必须命中
    no-console-clean/    # 与 reference 相同，但故意 console.error —— AC-20 必须命中
```

**镜像约定**沿用 E1：`reference/`、`mutants/` 与 `oracle.mjs` **不进被测工作区、不进提示词**。

---

## 4. Oracle 设计（`F1/oracle.mjs`）

### 4.1 契约（与 E1 逐字同形，便于复用解析）

```
用法：node oracle.mjs <workspacePath>          # cwd = 夹具目录；只读工作区
输出：人读一行 + F1_RESULTS_JSON:{fixture,workspace,results:[{ac,must,passed,detail}]}
退出：0 = 所有 Must 通过；1 = 有 Must 失败；2 = 用法错误
超时：oracle 15 min（初值）；run 90 min（初值）
```

### 4.2 执行流程

1. `pnpm install --frozen-lockfile`（工作区副本内，不改原目录）；
2. `pnpm build`；
3. 起 mock（端口 A，`MOCK_DELAY_MS` 可注入）与静态预览（端口 B，`VITE_API_BASE` 指向 A）；
4. 等两个端口都可达（TCP + HTTP 200），超时 60s；
5. 按 journey 逐条执行 AC（每个 journey 用全新 browser context）；
6. 每条 AC 收集：结果、`detail`、失败截图路径、DOM 片段（≤4KB）、该 journey 的 console 记录；
7. 关闭浏览器/进程组，清理临时目录；
8. 汇总输出。

### 4.3 确定性规则（写进 oracle 的硬约束）

| 规则 | 做法 |
| --- | --- |
| 只用 `data-testid` 定位 | 禁止文本/CSS 类选择器（AC 已规定） |
| 等状态，不等时间 | `expect(locator).toBeVisible({timeout})`；禁止 `waitForTimeout` |
| 时序由 mock 控制 | 延迟/错误通过 `MOCK_DELAY_MS`、`?error=1` 注入，不靠人肉 sleep |
| 每个 journey 独立上下文 | 新建 context + 清 mock 数据，避免用例间串味 |
| 无外部网络 | preview 期间 mock 必须命中；外部请求一律记失败证据 |

### 4.4 失败证据

- 截图：`<tmp>/f1-evidence/<ac>.png`（**不写入工作区**，路径写进 `detail`）；
- DOM 片段：失败的 locator 最近的容器 `outerHTML`（截断 4KB）；
- console：该 journey 的 error/warning 列表；
- 请求记录：`/__mock/requests` 快照（用于 AC-07 这类「不该发请求」的断言）。

### 4.5 依赖

`playwright` 作为 `@ai-se/eval` 的 **devDependency**（`apps/web` 与 `packages/browser` 已有 1.61.0，
版本对齐）。**不**从 `@ai-se/browser/dist` 导入——oracle 是黑盒脚本，必须与平台实现解耦；平台侧的浏览器
能力仍走 `@ai-se/browser`。

---

## 5. 平台侧改动（设计级，不实现）

### 5.1 tier 扩展

`packages/eval/src/types.ts:5` 的 `Tier = "S"|"M"|"L"|"E1"` → 增加 `"F1"`；`report.ts` 的分档表新增一行。

### 5.2 UI 边界冒烟 `uiSmoke.ts`（与 `serverSmoke.ts` 并列，同一范式）

**职责**：在切片边界回答一个问题——**页面真的起得来、关键元素真的挂上了吗**。不做业务断言。

| 判定 | 条件 |
| --- | --- |
| `PAGE_UNREACHABLE` | preview 起不来或超时（环境类失败 → 跳过，记 `BOOT_ENV_UNRESOLVED`） |
| `SURFACE_MISSING` | 页面 200，但**所有** AC 点名的 testid 都不存在（这正是 N-49 的 UI 版形状） |
| `CONSOLE_ERROR` | 关键 journey 期间控制台有 error（可配置是否致命） |
| `passed` | 至少一个被点名的 testid 存在，且无致命 console error |
| `skipped` | AC 未点名任何 testid（`NO_TESTIDS`）；或只有动态 testid（`ONLY_DYNAMIC_TESTIDS`） |

**触发条件**：`slice.involvesUi === true`（复用既有字段）。非 UI 切片不跑，零成本。

**与 `serverSmoke` 的对称性**（同一套教义，避免第二种门）：

- 同一 `node -e`/单命令范式、探测在**一条命令内**完成（沙箱每条命令是新容器）；
- 起点用项目声明的 `start` 脚本；
- **只认 AC 点名的元素**，不猜；
- 跳过必须留痕（`smokeSkipped`），不静默。

### 5.3 AC 抽取：`extractTestIds`

新增纯函数，从 AC 文本提取 `data-testid="x"` / `` `[data-testid="x"]` `` 形式的名字；与
`extractHttpRoutes` 同构（同一套「只认文本点名的东西」的规则）。动态 testid（含 `:id`/`{id}`）归入
`ONLY_DYNAMIC_TESTIDS` 跳过。

### 5.4 前端交付链的含义

| 任务 | 前端语义 |
| --- | --- |
| CI（BUILD） | `pnpm install --frozen-lockfile && lint && typecheck && test && build` |
| staging DEPLOY | 起静态预览（`pnpm start`，端口读 `PORT`），在 `deployments` 记一条 staging |
| staging VERIFY（TEST，action=VERIFY） | 浏览器子集：AC-01 / AC-03 / AC-10（起得来、列表在、交互可用） |
| production DEPLOY | **本阶段非目标**（无真实托管） |

`chainCompleted` 的口径沿用现有实现，不新增第三套定义。

### 5.5 规划提示词

只加一句，不动脚本契约：

> 若需求是纯前端，`providesScripts` 仍按 `package.json` 的 `start/test/lint/typecheck/build` 声明；
> 不规划任何后端实现任务，后端以 `VITE_API_BASE` 消费。

---

## 6. 度量与验收

### 6.1 读数（与 E1 同口径 + 两项前端专属）

| 指标 | 来源 |
| --- | --- |
| 真成功率 / 假阳性 / 假阴性 | oracle + chain（既有） |
| 链完成 / 交付成功 / staging 段 | 既有 |
| 首轮通过率 / 收敛率 / 规划修复轮次 | 既有 |
| token / 耗时 | 既有 |
| **AC 翻转率（flake）** | reference 连跑 3 轮，比较逐条 AC 结果 |
| **console 错误命中数** | oracle 的 AC-20 明细 |

### 6.2 通过条件（缺一不可）

1. **reference 工作区**：oracle **Must 20/20**，连跑 3 轮，**0 条 AC 翻转**；
2. **template 工作区**（空骨架）：oracle 至少 **15 条 Must 失败**——证明夹具能分辨「做没做」；
3. **mutant `empty-shell`**：`uiSmoke` 必须报 `SURFACE_MISSING`，oracle 必须失败——证明**反向门会响**；
4. **mutant `no-console-clean`**：AC-20 必须失败——证明控制台门不是摆设；
5. **端到端 1 次批次**：4 个切片；逐任务门**不产生** Node 契约类假失败；CI + staging deploy +
   staging verify 三段走通。

### 6.3 读前声明（避免把「门在起作用」当成回退）

- 第 1 次批次若 slice-1 因 `uiSmoke` 报 `SURFACE_MISSING`，那是**门第一次真的响**，不是夹具坏了；
- AC-20（console 无错）会让「能跑但满屏警告」的实现失败，这是**正确的收紧**；
- Should 项（AC-21..24）不参与通过判定，只作读数，避免把可用性议题混进功能门。

---

## 7. 风险与对策

| 风险 | 表现 | 对策 |
| --- | --- | --- |
| UI 抖动 | 同一实现两次跑出不同 AC | 状态等待 + mock 控时序 + 检查级**有界**重试；flake 门（3 轮 0 翻转）不达标就停 |
| 选择器脆弱 | 实现改样式导致门误判 | testid 由 AC 规定并写进 requirementText；禁止文本选择器 |
| mock 与真实后端漂移 | 上线才发现契约不符 | 本阶段 mock 手写并标注；后续用 OpenAPI 快照生成 mock |
| 浏览器资源 | 沙箱单 CPU 下慢/超时 | 镜像预装 chromium；沿用 maxConcurrency=1；oracle 单进程串行 |
| 「前端也能自选框架」 | 读数无法归因 | 本阶段固定 Vue 3；多框架另立议题 |
| 门只看功能 | 可用性/无障碍没覆盖 | Should AC 先作读数；独立门另行论证 |

---

## 8. 实施顺序（六步，每步停）

1. **夹具骨架**：`fixture.json` + `requirementText` + AC 表 + mock 契约（本文 §3 的落地形态）——**评审通过再往下**；
2. **reference + oracle**：先把 oracle 在 reference 上跑成 Must 20/20，再在 template 上跑成「大面积红」；
3. **变异体**：`empty-shell` / `no-console-clean`，先证明 oracle 能抓；
4. **平台接线**：tier `F1`、`uiSmoke.ts`、`extractTestIds`、边界检查触发条件；证明 mutant 上 `uiSmoke` 会响；
5. **批次脚本**：`l1-m4v-f1-x3.sh`（与 E1 脚本同形）+ 一次端到端；
6. **读数与结论**：按 §6.1 出表，写进 `docs/232`，并回答「这个方向能否涵盖住」。

### 8.1 实施进度（2026-10-27）

**已落地**（细节与读数见 `docs/235` §6.3 / §6.4）：

- §5.2 的 `uiSmoke` + §5.3 的 `extractTestIds`，边界门按 `profile.boundaryCheck` 选
  （`server` / `ui` / `none`）；
- §3 的 F1 夹具：`prd.md`、`ac-map.md`、`template/`、`reference/`、`mutants/empty-shell`、
  `mutants/no-console-clean`、`oracle.mjs`；
- §5.1 的 tier：`packages/eval/src/types.ts` 的 `Tier` 已加 `F1`（分档表按记录动态生成，
  `report.ts` 不需要单独加行）；
- §8 第 5 步的批次脚本 `f1-frontend-x3.sh` / `f1-frontend-stop.sh`。

**§6.2 的通过条件读数**：

| # | 判据 | 读数 |
| --- | --- | --- |
| 1 | reference Must 20/20，3 轮 0 翻转 | **24/24 × 3，flips = 0**（本机） |
| 2 | template ≥15 条 Must 失败 | **19 条**（本机） |
| 3 | `empty-shell`：`uiSmoke` 报 `SURFACE_MISSING`、oracle 失败 | **命中**（本机 + 容器内各一次） |
| 4 | `no-console-clean`：AC-20 失败 | **只有 AC-20 失败**（本机） |
| 5 | 端到端 1 次批次 | **✅ 正式达成（round20，2026-11-03）**：五片走通 + oracle 24/24 + staging CI/DEPLOY/VERIFY 全 SUCCESS；真交付 100%，假阳/假阴 0；归档 `packages/eval/results/f1-frontend/round20/` |

**第 5 条的三项拆开看**（2026-11-04 更新）：

- 逐任务门**没有** Node 契约类假失败 —— ✅（rounds 8–15、round20 均为 0）；
- 切片走通 —— ✅（round 12 / round20：五片全 SUCCESS、oracle 24/24、链完成 100%）；
- CI + staging deploy + staging verify —— ✅ **round20 正式跑通**（`SUCCESS/SUCCESS/SUCCESS`，约 168 分钟；
  对照：round 15 曾在交付前停、round19 staging 段失败）。

**第一轮的 slice-4 为什么失败**（历史记录）：防篡改门拦住了「改测试让测试通过」——TEST 任务先把错误
契约（顺序断言写错、`test.fails` 占坑）写进受保护文件，修复任务只能改它。门是对的，写测试的 agent
需要被约束（`docs/235` §6.9）。该约束的后续形态见 N-72（qa-agent 的 submit 语义）。

## 9. 未开始事项（STOP）

> **2026-11-04 更新**：F1 §6.2 五条通过条件已全部达成（正式验收轮 **round20**）。本阶段**停止扩功能**；
> 下一平台阶段是 **Phase 8 AI SRE**（`docs/13` / 任务书 `docs/242`），**不是** Agents UI 的 Phase 8-A/B。
> 逐轮读数见 `packages/eval/results/f1-frontend/`，勾选见 `docs/17` F1 节、总表 `docs/146` §1.1。

- **端到端批次 / 前端交付链**：✅ round20 正式验收——oracle 24/24、staging CI/DEPLOY/VERIFY 全 SUCCESS、
  真交付 100%、假阳/假阴 0；归档 `round20/`。矛盾期望门禁 + 门禁 P1（改测 REPLAN）已落地并重启加载。
- **连续多轮稳定读数**：加固项，未做；不阻塞收口。
- **mock 与真实后端的 conformance** 未开始（§7 的风险项，另立阶段）；
- 多框架（React / Svelte）、真实后端接入、视觉回归（像素 diff）均不在本阶段范围，未开始。

### 9.1 F1 运行约束（收口后仍有效）

- 批次走 **OpenCode**（`.env` **勿改** DeepSeek 直连）；停批：`packages/eval/scripts/f1-frontend-stop.sh`。
- 工作流 retry / 短路径冒烟 **≠** 正式 F1 分数；正式分数只认 harness 写出的 `run-1.json`。
