# Phase 9-B — Deployments UI 重构（实施记录）

> 阶段：Phase 9-B（`DeploymentsView.vue` 视觉层重构）
> 前置：Phase 9-A PASS（`docs/80-phase-9-deployments-analysis.md`）
> 依据：`docs/design/*`、`docs/ui-reference/ai-se-home.png`、Phase 3-B / 3-C / 4 / 5 / 6 / 7 / 8 既有实现、9-A §6 迁移映射
> 原则：**Visual Redesign, Functional Preservation**
> 日期：2026-09-15

---

## 1. 修改文件

| 文件 | 变更 | 行数 |
| --- | --- | --- |
| `apps/web/src/views/DeploymentsView.vue` | template + 页面 scoped 样式重写；`<script setup>` 业务代码**逐行未改**（仅新增组件/tone 导入） | 224 → **416** |
| `apps/web/src/viewmodels/deploymentViewModel.ts` | **仅新增** `DeploymentStatusTone` + `deploymentStatusTone()`（其余 6 个导出逐字未改） | 49 → **78** |
| `apps/web/src/__tests__/deploymentViewModel.test.ts` | +2 例 tone 断言 | 33 → **47** |
| `apps/web/src/__tests__/deploymentsView.test.ts` | **新增**：页面契约测试（12 例） | **400**（新） |

未改动（mtime 核对）：`api/deployments.ts`（9-14）、`stores/deployments.ts`（9-14）、`router/index.ts`（9-11）、`styles.css`（960 行 / 11:41）、`package.json`（12:12）、`stores/__tests__/deployments.test.ts`（9-11）、其他 6 个视图（`WorkflowsView` 15:47 / `AgentsView` 16:05 / `AgentRunView` 等）。**未创建任何测试业务数据**（`/api/deployments`、`/api/environments` 复核仍为 `[]`）。

复用组件（无新增组件 / 依赖 / 路由 / Token）：`PageHeader`、`SectionHeader`、`Card`、`Button`、`Input`、`Textarea`、`Label`、`StatusBadge`、`EmptyState`。

## 2. 测试结果

```
Test Files  25 passed (25)     ← 24 → 25（+1 文件）
Tests      172 passed (172)   ← 158 → 172（+14 例）
```
四道门禁：`typecheck` ✅ 0 error｜`lint` ✅ 0 warning/error｜`test` ✅ 全绿｜`build` ✅。
`prettier --check`：`viewmodels/deploymentViewModel.ts` ✅ 通过（与既有 viewmodel 一致）。

新增页面契约测试覆盖（任务书逐项对应）：

- **loading / empty / error**：列表「加载中…」（空态不出现）+ 两处空态文案 + `text-danger` 错误行（保留后端原文 `Deployment not found`，且断言不再出现 `error-banner`）✓
- **deployment list + active**：2 项、`deployment-item--active`、`环境 · 状态` 文案（预发 · 成功 / 预发 · 失败）、`shortVersion` 截断（`abcdef123456`）、不含 `deployment-list-item` ✓
- **detail metadata**：6 字段 + 完整版本 + 镜像 + `href="/workflows/<id>"` + 端点外链 `target="_blank" rel="noreferrer"` + 2 列 grid ✓
- **health check**：`JSON.stringify(…, null, 2)` 内容 + `pre` 仅 `overflow-auto`（**无 max-height**）✓
- **CI**：无 `ciRun` 整块不渲染；有则「成功 · GitHub」+「拉取请求 #42」+ 链接；`url`/`pullRequest` 缺失时相应节点不渲染 ✓
- **logs**：空态 + `time`/`level` 原值/`message` + `grid-cols-[80px_minmax(0,1fr)]` 与 `min-[900px]:grid-cols-[100px_minmax(0,1fr)_90px]` + `col-start-2` / `min-[900px]:col-start-auto` ✓
- **rollback gate**：`DEPLOY+SUCCESS`、`DEPLOY+FAILED` 渲染；`operation=ROLLBACK`、`status=RUNNING` 不渲染；默认原因、`rows="3"`、`required`、destructive 按钮、FAILED 时 `bg-danger-bg` ✓
- **production 提示**：仅 `environment === "production"` 出现；`acting` 时「保存」「回滚」两按钮均 disabled ✓
- **表单属性及默认值**：项目 select `required` + 「选择项目」+ 真实项目；环境默认 `staging` + 3 个选项文案；端点 `type="url" required` + 默认值；端口 `type="number" min="1" max="65535"` ×2 + 默认 18001/3000；Secret placeholder「仅引用，不含明文」✓
- **tone mapping**：7 状态全量断言（viewmodel）+ 页面徽标 7 种 tone 类抽样断言 ✓
- **legacy class 不得出现**：17 个 legacy 类名/片段一次性断言 ✓

保留既有 Store / ViewModel 测试：`stores/__tests__/deployments.test.ts`（2 例）与 viewmodel 原有 2 例**未改动且继续通过** ✓

## 3. 构建体积变化

| | Phase 8-B | Phase 9-B | Δ |
| --- | --- | --- | --- |
| CSS | `index-CcyfClsR.css` 30.67 kB | `index-CtRNV1K9.css` **32.62 kB** | **+1.95 kB** |
| JS | `index-472K6Bww.js` 329.55 kB | `index-DUOHtz6V.js` **332.24 kB** | **+2.69 kB** |
| gzip | 6.40 / 102.94 kB | 6.59 / 103.02 kB | +0.19 / +0.08 kB |

（增量来自 Deployments 页两种原生控件/列表项的 scoped 样式与组件引用。）

## 4. 浏览器验证结果

环境：`vite preview --port 5173`（真实后端 :3000；`/deployments` 与 `/api/environments` **真实数据为空**，未创建任何记录）+ 应用加载前注入 console hook。

| # | 验证项 | 实测结果 |
| --- | --- | --- |
| 1 | `/deployments` 结构 | h1 **24px/600**「部署」+ eyebrow「阶段 6」；根容器 `max-width: 1180px`；两栏 **320px + 717px**、gap 24；侧栏 2 张 Card |
| 2 | 环境表单（原生控件） | 6 字段标签齐全；2 个 `<select>`：h **36px** / fs **14px** / 边框 `rgb(232,234,240)`（`--input`）/ 圆角 10px / `appearance: auto`（保留原生箭头）；项目 `required` + 「选择项目」+ 真实项目「Mini Todo」；环境默认 `staging` + 3 选项 |
| 3 | 输入控件 | 4 个 input 全部 36px/14px：端点 `type=url required` 默认 `http://localhost:18001`；两个端口 `number min=1 max=65535` 默认 18001/3000；Secret placeholder「仅引用，不含明文」 |
| 4 | 保存按钮 | 文案「保存」、底 **`rgb(108,92,231)`（Primary）**、h 36px、圆角 10px、未禁用 |
| 5 | 空态 | 「暂无部署记录。」+「请选择部署。」均以 Token 文字色渲染，无 legacy `.empty` 样式 |
| 6 | 404 深链接 | `/deployments/<不存在 uuid>` → 顶部 `mb-5 text-body text-danger` / **`rgb(220,38,38)`** 显示后端原文 **`Deployment not found`**；`.error-banner` 命中 **0**；详情不渲染；空态照常 |
| 7 | 响应式 | @1440 → 1180 上限 + 320/836；@1280 → 320/717；**@900 → 320/337（两栏，按既有「≥900 两栏」约定）**；**@899 → 单列 680px**；**四档 `overflowX = 0`** |
| 8 | scoped 规则运行时探针 | 注入带 `data-v-b8f7b650` 的测试节点（**仅浏览器内存，未触碰业务数据**）：`.deployment-item` → padding 12 / radius **12px** / 白底 / 边框 `rgb(232,234,240)` / grid / 14px；`--active` → 底 `rgb(240,237,255)` + 边框 `rgb(108,92,231)` + `inset 3px 0`；`:focus-visible` → 2px Primary 环；`.deployment-item-meta` → `ellipsis + nowrap` |
| 9 | 真实 API | `/api/projects`、`/api/deployments`、`/api/environments` 正常调用（空结果） |
| 10 | 控制台 | **0 console error / 0 Vue warning**（全流程） |
| 11 | 其他页面回归 | `/`、`/projects`、`/requirements`、`/workflows`、`/agents`、`/agent-run`、`/mcp` 均正常（未受 9-B 改动影响） |

> **验证限制（承 9-A R1）**：本页无真实部署数据（0 条），故**列表项/详情 6 项元数据/健康检查/CI/日志时间线/回滚表单**在浏览器中无真实样本 ⇒ 这些路径由 **12 例 SSR 契约测试**覆盖（注入 store 状态），scoped 视觉规则由 §4-8 探针覆盖。真实端到端（含真实回滚）需在获得授权创建测试部署后进行。

## 5. Legacy CSS Audit

**静态**：`DeploymentsView.vue` 中 19 个 legacy 类（`page` / `deployment-page` / `page-header` / `eyebrow` / `error-banner` / `deployment-layout` / `deployment-sidebar` / `deployment-detail` / `deployment-list` / `deployment-list-item` / `deployment-metadata` / `deployment-empty` / `form-panel` / `stacked-form` / `panel` / `panel-header` / `status-pill` / `event-timeline` / `empty` / `button`）**命中数 = 0**。

**运行时**（浏览器内遍历 `document.styleSheets`，对每条相关 legacy 选择器执行 `querySelectorAll`）：
```
legacyHits: {}        // 页面内 legacy 类元素数
leaks: []             // 命中新 markup 的 legacy 规则数
```
⇒ 不仅未复用类名，**没有任何 legacy CSS 规则命中新 markup**（含 `.deployment-list-item span`、`.event-timeline li`、`.status-pill`、`.panel`、`.empty`、`.button` 等复合选择器）。

**新增页面 scoped 类**（一次性在注释中说明「为何不复用 legacy 名」，并在测试中断言防回归）：`deployment-select`、`deployment-item`、`deployment-item--active`、`deployment-item-meta`、`deployment-link`。构建产物中确认 4 组规则随 `data-v-b8f7b650` 作用域正确输出。

**`styles.css` 未改动**：960 行 / mtime 11:41；legacy 定义（`grep -c` = 12 处）原样保留（其他页面仍在用 `page` / `stacked-form` / `panel` / `empty` / `button`）。
**全局级联陷阱处理**：`a{color:#1d4f91}` → `.deployment-link` scoped 重声明（3 个链接：工作流 / 端点 / CI）；`button,input,select,textarea{font:inherit}` → 组件自带 scoped 兜底 + `.deployment-select` 显式 `font-size`；**未使用 `!important`**、未新增全局规则。

## 6. 业务冻结确认

| 项 | 结论 |
| --- | --- |
| **API** | 未变化（5 个导出、endpoint、`?projectId=` 过滤、`PUT /api/environments`、404 原文透传） |
| **Store** | 未变化（`load`/`select` 复用 loading/`saveEnvironment` upsert 且不重载/`rollback` 的 load→select 链/`environment()` 保留） |
| **Router** | 未变化（2 条路由同组件、`:id` 深链接、列表点击 push） |
| **SSE / polling** | 未变化（**本页本来就无实时通道**，未新增） |
| **canRollback()** | **逐字未改**（`operation === "DEPLOY" && ["SUCCESS","FAILED"].includes(status)`），仍作为回滚表单渲染 gate |
| **secretReference** | **保持 `secretReference \|\| undefined`**；placeholder「仅引用，不含明文」保留 |
| **文案** | 全部业务文案逐字保留（含 `阶段 6`/`部署`/`环境`/`历史`/`部署详情`/`健康检查`/`CI`/`日志`/`回滚`/三处空态/`加载中…`/环境选项/`仅引用，不含明文`/默认回滚原因/production 提示） |
| **表单约束** | `required` ×3（项目 / 端点 / 回滚原因）、`type=url`、`type=number min=1 max=65535` ×2、`rows=3`、默认值（staging / 18001 / 3000 / 空 / 默认原因）、`v-model.number` 端口 |
| **Loading/Error/Empty** | 分支与顺序不变（列表 `loading → empty → list`；详情 `current ? … : 请选择部署。`；CI 纯 `v-if`；日志 `empty → list`） |
| **Confirm / Toast / Dialog / Skeleton** | **均未新增**（保存环境后无可见反馈的既有行为保留） |
| **ViewModel 既有输出** | `deploymentStatusLabel` / `environmentLabel` / `ciProviderLabel` / `ciStatusLabel` / `shortVersion` 逐字未改；`canRollback` 语义未改 |
| **业务数据** | 零变化（deployments / environments 复核仍为 `[]`） |

## 7. 风险 / 有意视觉差异

**有意视觉差异（Design System 对齐）**

1. **h1 32px/700 → 24px/600**（`--text-page-title`）。
2. **面板/卡片**：边框 `#dde5ee` → `--border #e8eaf0`；圆角 8px → `--radius-lg 12px`；内距仍 20px。
3. **原生控件**：select 42px/16px → **36px/14px**；input 40px/16px → **36px/14px**；边框统一 `--input`；焦点环统一 2px `--primary`。
4. **按钮**：保存 旧蓝 `#1d6fd3` → **Primary `#6C5CE7`**（h 40 → 36、圆角 8 → 10）；回滚 `.danger` 浅红底 → `Button variant="destructive"`（实心 `--danger`）。
5. **状态展示**：`.status-pill`（无颜色语义的描边胶囊）→ `StatusBadge` + `deploymentStatusTone()`（7 状态语义化）。
6. **列表项**：旧蓝 active `#1d6fd3` → Primary 体系（含 `inset 3px`）；边框/圆角/内距对齐 Token；次行保持单行省略。
7. **空态/次要文字**：`#65758a` → `--muted-foreground #6b7280`；空态改用 `EmptyState` 组件（内距/字号按组件规范）。
8. **错误提示**：`.error-banner`（**从未定义样式**）→ `text-body text-danger`（首次上色，同 7-B/8-B 先例）。
9. **日志时间线**：列定义与 ≤900 折叠**逐项复现**（`80px+1fr` 默认、第 3 单元 `col-start-2`；`≥900` 为 `100px+1fr+90px`）；颜色由 `#65758a` → Token；**结构未改**（message 仍在第三单元）。
10. **900px 边界**：沿用既有约定「≥900 两栏」（legacy `max-width:900` 在恰好 900 时折叠；1px 语义差，与前 5 个阶段一致）。

**风险 / 限制**

11. **无真实数据的覆盖盲区**（承 9-A R1）：列表项/详情/健康检查/CI/日志/回滚在浏览器中无真实样本，仅由 SSR 契约测试 + scoped 探针覆盖；真实回滚链路（含后端审批前置）**未端到端验证**。
12. **`environments` 仍不被 UI 消费**：保存环境后无可见反馈（既有行为，未"顺手"加 toast）。
13. `a{color}` 与 `font:inherit` 两个全局级联陷阱仍需逐页 scoped 规避（根治留 Phase 11）。
14. 未清理项（按纪律保留）：`store.environment()` 无调用方、`stores/deployments` 无 SSE（非缺失）、其他页面 legacy 类。

## 8. Phase 9-B 结论

**PASS**

判定依据：① 允许范围内 4 个文件修改，`api`/`store`/`router`/`styles.css`/`package.json`/其他页面 mtime 零变化；② 四道门禁全绿（25 files / 172 tests，+14 例）；③ 构建成功且体积变化记录在案（CSS +1.95 kB / JS +2.69 kB）；④ 页面 legacy 类命中 **0**、运行时 **leaks = 0**；⑤ 浏览器实测：结构/控件/空态/404/响应式（1280·1440·900·899，`overflowX = 0`）/真实 API/控制台 0 噪声/其他 7 路由回归全部通过；⑥ 业务冻结逐项确认，业务数据零变化；⑦ 未新增组件/依赖/路由/Dialog/Toast/Skeleton/SSE。

---

**Code changed: ONLY Deployments-related files**（`views/DeploymentsView.vue`、`viewmodels/deploymentViewModel.ts`、`__tests__/deploymentsView.test.ts`、`__tests__/deploymentViewModel.test.ts`）
**API changed: NO** ｜ **Store changed: NO** ｜ **Router changed: NO** ｜ **SSE changed: NO** ｜ **Dependencies changed: NO** ｜ **styles.css changed: NO** ｜ **Business data changed: NO**

按阶段纪律**在此停止**，不进入 Phase 10。
