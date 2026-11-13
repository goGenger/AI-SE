# 143 · W11 前端收尾（路由分割 / 抽屉深链接 / 无障碍扫描器）

**阶段**：W11（W1–W10 收口后，对 `docs/142` 里登记的遗留项做一次集中清理）
**日期**：2026-10-14
**前置**：[142-phase-w10-acceptance.md](142-phase-w10-acceptance.md)（W10 终验，登记了本阶段要清的四项）
**性质**：**不改业务逻辑、不改接口契约、不改写文案**。四项全是「W10 登记了但没做」的工程债，外加两个由新扫描器查出来的真实缺陷。
**批次说明**：这是一次**打包执行**（四项一次做完再统一验收），偏离 `AGENTS.md` §9「一次任务只做一个已命名的阶段」。偏离已获用户明确授权（同 W7–W10）。

---

## 一、本阶段做的四件事

| # | 事项 | 来源 |
| --- | --- | --- |
| 1 | **路由级代码分割** —— build 消除「单 chunk > 500 kB」警告 | docs/142 §3.2「前端路由级代码分割：未做」 |
| 2 | **两个详情抽屉同步 URL** —— `?requirement=` / `?agent=` | docs/142 §3.2、`components/README.md:45-47` |
| 3 | **200% 缩放 / 强制高对比度 / 文本间距实测** | docs/142 §3.2「200% 缩放 / 强制高对比度：未测」 |
| 4 | **接入 axe 自动扫描器** —— 补上「没有自动化 a11y 工具」的缺口 | docs/142 §3.2「未跑自动化 a11y 扫描器」 |

**外加两处修复**（由第 4 项查出来，见第三节）与**一处版式调整**（仪表盘，见第四节）。

---

## 二、第 1 项 · 路由级代码分割

### 改了什么

`apps/web/src/router/index.ts`：13 条路由原先全部**静态 import**（11 个 view 模块写在文件顶部），整站打进同一个 chunk。改为在路由表里就地 `() => import(...)`。

`WorkflowsView` 与 `DeploymentsView` 各被两条路由引用，动态 import 同一个说明符由 Vite 自动去重成一个共享块 —— 不需要手工起名或抽公共 chunk。

### 证据

**改动前**（docs/142 记录的终验构建输出）：

```
dist/assets/index-BNhaGWaz.js   569.62 kB │ gzip: 172.07 kB
✓ built   ← 伴随 "Some chunks are larger than 500 kB after minification" 警告
```

**改动后**：

```
$ corepack pnpm --filter @ai-se/web build
dist/assets/DeploymentsView-Y8fApllt.css          0.07 kB
dist/assets/index-DDkXUvp6.css                   27.23 kB │ gzip:  6.31 kB
dist/assets/card-B8tqb8_Z.js                      0.37 kB
dist/assets/projectViewModel-5dZbKB4H.js          0.39 kB
dist/assets/textarea-DpuxuAE2.js                  0.84 kB
dist/assets/input-g-wi3JQS.js                     0.89 kB
dist/assets/agentRegistryViewModel-DapdYogT.js    1.04 kB
dist/assets/useModEnterSubmit-hpTzJH-y.js         1.13 kB
dist/assets/mcpViewModel-jpJ8iweK.js              1.60 kB
dist/assets/requirementViewModel-CHzYv-hD.js      1.91 kB
dist/assets/drawer-BgSllmRL.js                    2.33 kB
dist/assets/MCPServersView-A8OW_NeD.js            3.03 kB
dist/assets/ProjectDetailView-CjIYr6vY.js         4.89 kB
dist/assets/VisuallyHidden-DnjYIK-F.js            5.42 kB
dist/assets/ProjectsView-CdLD9Fw6.js              5.64 kB
dist/assets/DashboardView-CM5C9wmw.js             5.97 kB
dist/assets/AgentsView-CEAnBMIa.js                6.10 kB
dist/assets/checkbox-CHG9GGnU.js                  8.56 kB
dist/assets/DeploymentsView-Cu8nEa5L.js          10.78 kB
dist/assets/table-BX7P_PE0.js                    11.37 kB
dist/assets/MCPServerDetailView-B43SSsjX.js      14.74 kB
dist/assets/RequirementsView-DERGkFju.js         17.36 kB
dist/assets/agentRunViewModel-Ybfc9YK4.js        18.21 kB
dist/assets/WorkflowsView-C7nXpyrO.js            22.22 kB
dist/assets/AgentRunView-BfaVaSsR.js             22.28 kB
dist/assets/common-BqSGyB6w.js                   43.61 kB │ gzip: 13.91 kB
dist/assets/select-W-3yKv8_.js                   52.91 kB │ gzip: 17.46 kB
dist/assets/index-DDjI3y8s.js                    65.94 kB │ gzip: 22.63 kB
dist/assets/MCPAppView-AphEn9uK.js              110.26 kB │ gzip: 31.64 kB
dist/assets/auth-CMOvKU48.js                    143.78 kB │ gzip: 52.67 kB
✓ built in 516ms      ← 警告消失
```

**首屏实际传输量**（不是估算：对着 `vite preview` 数每一个响应体，脚本见 `/tmp/w11-payload.cjs`）：

```
首屏（http://localhost:4398/）实际传输：
  script       282.5 kB
  stylesheet    26.6 kB
  document       0.8 kB
  合计          309.9 kB

    140.4 kB  script     /assets/auth-CMOvKU48.js
     64.4 kB  script     /assets/index-DDjI3y8s.js
     42.6 kB  script     /assets/common-BqSGyB6w.js
     26.6 kB  stylesheet /assets/index-DDkXUvp6.css
     17.8 kB  script     /assets/agentRunViewModel-Ybfc9YK4.js
     11.1 kB  script     /assets/table-BX7P_PE0.js
      5.8 kB  script     /assets/DashboardView-CM5C9wmw.js
      0.4 kB  script     /assets/card-B8tqb8_Z.js
```

打开仪表盘只需 309.9 kB（未压缩），而改动前**任意页面**都要先吃下那个 569.62 kB 的单 chunk。**注意**：`auth-*.js`（140 kB）与 `common-*.js`（43 kB）是入口的静态依赖，首屏仍然要加载 —— 首屏没有「只剩 66 kB」那么夸张，真正被推迟的是另外 10 个页面各自的 view。

**未测**：压缩后（gzip / brotli）的首屏传输量。`vite preview` 默认不压缩，上表是未压缩字节数；生产环境走 CDN 压缩后会更小，但本阶段**没有在压缩环境下量过**。

---

## 三、第 2 项 · 两个详情抽屉同步 URL

### 改了什么

`RequirementsView`（`?requirement=<id>`）与 `AgentsView`（`?agent=<name>`）。四个详情抽屉（需求 / 工作流 / Agent 运行 / Agent）现在**全部**同步 URL，`components/README.md` 里那条「这两个页面记为待补」的注记已改为「W11 已补齐」。

落法照抄既有的 `WorkflowsView` / `AgentRunView`：**URL 是唯一真源** —— 行内「详情」按钮只 `router.push`，开抽屉与取数由一处 `watch(选中的 id)` 承担，再把「关抽屉 → 清掉 query」接上。深链接、前进后退、行内按钮因此走同一条路径，不会各写一套。

`AgentsView` 用 `name` 而不是新造一个 id：注册表一直以 `name` 作主键（列表 `row-key` 与 `store.select(name)` 都用它）。

`RequirementsView` 多做了一件事：`loadRequirement` 一次会扇出 **6 个并行请求**（需求本体 + 规格 / 任务 / 切片 / AC / 追溯），所以取数收口到一个 `ensureRequirementLoaded(id)`，**按 id 去重一次在途请求** —— 否则「watch(URL)」与行内「分析」会各发一遍。这是本阶段唯一一处为了正确性新增的小机制，约 10 行。

### 证据（真实后端 + 真实 Chromium，18/18 通过）

```
PASS  Agent 页：点「详情」→ URL 带 ?agent= 且抽屉打开
PASS  Agent 页：Esc 关抽屉 → URL 回到 /agents 且抽屉关闭
PASS  Agent 页：浏览器后退 → 抽屉重新打开（URL 与可见状态一致）
PASS  Agent 页：`?agent=` 深链接直接落在详情抽屉上
PASS  需求页：点「详情」→ URL 带 ?requirement= 且抽屉打开
PASS  需求页：Esc 关抽屉 → URL 回到 /requirements
PASS  需求页：`?requirement=` 深链接直接落在详情抽屉上
```

---

## 四、第 3 项 · 仪表盘 ①② 并排（W10 那条「差 15px」）

W10 §3.1 实测：1440×900 下「最近工作流」第 5 行的底边在 915px，差 15px 落在折线以下。W10 没改（终验阶段不版式改动），留了三条候选修法。**本阶段采用候选①：把「需要处理」与「正在运行」两张指标卡并排。**

`DashboardView.vue`：`①` 与 `②` 两张 `Card` 包进一个 `<div class="grid gap-[var(--section-gap)] lg:grid-cols-2">`，两张卡加 `content-start`。1024px 以下仍上下堆叠（那时每张卡只剩约 330px，三列数字会挤）。

**证据**：

```
PASS  仪表盘：1440×900 首屏「最近工作流」5 行全部完整可见
PASS  仪表盘：①② 指标卡并排（同一行、左右分开）
```

截图 `/tmp/w11-dashboard-1440x900.png`（真实后端数据）显示 5 行全部在折线以上，第 5 行下方还有明显余量。

**副作用与理由**：「最近工作流」与「项目」两块整体上移约 160px，页面总高度缩短。这**是**一次真实的版式改动，W10 之所以没做是因为它是终验阶段；本阶段它是被用户明确挑中的工作项（在「① ② 并排 / 摘要降到 4 条 / 压缩内距 / 保持不动」四选一中选了并排）。

---

## 五、第 4 项 · axe 自动扫描器，以及它查出来的两个真实缺陷

### 5.1 接入方式与「为什么不进 test 门禁」

- 依赖：`apps/web` 新增 devDependency **`axe-core@4.14.0`** 与 **`playwright@1.61.0`**（后者工作区里已有，`packages/browser` 用的就是同一版本；此处只是把它链进 `apps/web`，不是引入新包）。
- 脚本：`apps/web/scripts/a11y.mjs`，命令 `corepack pnpm --filter @ai-se/web a11y`。
- **不进 `test` 门禁**：`apps/web` 的测试环境是**纯 Node（无 jsdom）**，而 axe 一半的规则（对比度、目标尺寸、层级）需要真实排版引擎；塞进 vitest 要么引入 jsdom（规则失真），要么让每次 `pnpm test` 都拉起浏览器。因此它是独立命令，本阶段的证据由它当场产出。

四个阶段分开报告，不混成一个数字：

1. **axe**：13 条路由 × 浅色 / 暗色
2. **200% 缩放等价视口**（1440/2 × 900/2）—— SC 1.4.4 文本缩放
3. **强制高对比度**（`forced-colors: active`）
4. **文本间距覆盖**（SC 1.4.12）

路由清单**从 `src/router/index.ts` 反向提取**（正则读 `path:`），新增路由自动纳入；并断言「至少扫到 10 条」，防止正则失效导致「空扫描 = 永远通过」—— 这条是 W10 学到的教训。

脚本**不自己拉服务器**：后端 CORS 只放行 5173，换端口起服务会全站报「无法连接后端服务」，扫出来是一堆错误页。因此它要求 dev server 已起在 `A11Y_BASE_URL`（默认 `http://localhost:5173`），并在失败时打印启动命令。

### 5.2 首轮扫描：查出 2 类真实违规

```
✗ axe 报告 10 类违规（合计 65 处）：

  [serious] axe/light · label-content-name-mismatch ×12
      Elements must have their visible text as part of their accessible name
      例：/ → .w-9
  [critical] axe/light · button-name ×1
      Buttons must have discernible text
      例：/workflows → #workflow-filter-project
  （其余 8 类是上述两条在暗色 / 200% / 强制高对比度 / 文本间距四个阶段下的重复）
```

两条在浏览器里逐条复核过（诊断脚本：读取违规节点的 `outerHTML` + 失败摘要）：

#### 缺陷 A（critical）· `WorkflowsView` 的两个筛选下拉没有无障碍名称

```
<button id="workflow-filter-project" role="combobox" type="button" …>
  <span style="pointer-events: none;">全部项目</span>   ← 有文字，但不被当作名称
```

**根因不是「没文字」，是 ARIA 规则**：`Select` 的触发器是 `<button role="combobox">`，而 **`combobox` 的名称只能来自 author**（不支持 name from content）—— 里头的「全部项目」不会被算作名称。这个下拉在工具行里也没有配 `<Label>`，于是它从 W5 起就是一个**无名控件**，屏幕阅读器只会读出「组合框」。

对比：`RequirementsView` 的同名筛选有 `<Label for="requirement-project-filter">项目</Label>`，而 `<button>` 是可被 `<label for>` 命名的元素，所以那边一直是对的。**只有工作流页的两个漏了。**

**修法**：给两个 `Select` 加 `aria-label="按项目筛选"` / `aria-label="按状态筛选"`（组件已把非 root 属性透传到触发器）。没有改放可见 `<Label>` —— 那会破坏 W5/W7 定下的紧凑工具行版式。

**先验证过不会引发新违规**：读了 axe 的 `label-content-name-mismatch-matches`（`axe.js:32958`），它在角色**不支持 name from content** 时直接返回 false —— `combobox` 正好在豁免之列，所以加 `aria-label` 不会反过来触发 SC 2.5.3。

#### 缺陷 B（serious）· 顶栏搜索按钮的 `aria-label` 与可见文字不匹配

```
<button aria-label="全局搜索" …>
  <svg aria-hidden="true">…</svg>
  <span>搜索…</span>
  <kbd>⌘K</kbd>
```

无障碍名称是「全局搜索」，可见文字是「搜索… ⌘K」，两者对不上 → 违反 SC 2.5.3（Label in Name）。

**修法不是「把 ⌘K 塞进 aria-label」**（那只是迎合检查器）。实测了 6 个候选（见下），最终选：

```html
<button … :aria-keyshortcuts="isApple ? 'Meta+K' : 'Control+K'">
  <Search aria-hidden="true" />
  <span class="sr-only sm:not-sr-only sm:block sm:flex-1 sm:truncate sm:text-left">搜索…</span>
  <kbd class="hidden … sm:inline">{{ shortcutLabel }}</kbd>
</button>
```

**删掉 `aria-label`，让名称直接取自可见文字**；再把这行文字从 `hidden` 换成 `sr-only sm:not-sr-only`。

**这个改动顺带修掉了一个更严重的既有缺陷**：原来那行文字在 `<640px` 是 `hidden`，也就是说**窄屏下这个按钮根本没有名称**（实测确认：删掉 `aria-label` 后，1440px 与 720px 通过，375px 报 `button-name`）—— 是那个手写的 `aria-label` 一直在替它兜底。换成 `sr-only` 后窄屏下名称仍在无障碍树里。

候选实测记录（`1400/720/375` 三个视口 × 6 个候选）：

| 候选 | 1440 | 720 | 375 |
| --- | --- | --- | --- |
| ① 基线 `aria-label="全局搜索"` | FAIL | FAIL | PASS |
| ② `aria-label="搜索… ⌘K"` | PASS | PASS | PASS |
| ③ `aria-label="搜索…（⌘K）"` | FAIL | FAIL | PASS |
| ④ `aria-label="搜索 ⌘K"` | PASS | PASS | PASS |
| ⑤ 删掉 `aria-label` | PASS | PASS | **FAIL（无名称）** |
| ⑥ 删掉 `aria-label` + `sr-only sm:not-sr-only` | PASS | PASS | PASS |

②和④也能过，但把「⌘K」写进无障碍名称是**为了让检查器满意**，而且和已有的 `aria-keyshortcuts` 重复；⑥ 是「名称就等于可见文字」这一条原则的直接落地，故选 ⑥。

### 5.3 修复后复扫：全绿

```
$ corepack pnpm --filter @ai-se/web a11y
# 可访问性扫描 · http://localhost:5173
# 路由 13 条 × 4 阶段（axe 浅色 / axe 暗色 / 200% 缩放 / 强制高对比度 / 文本间距）

✓ axe 无 WCAG A/AA 违规。

✓ 无水平溢出（200% 缩放 / 文本间距两阶段）。

结果：全部通过。
```

13 条路由 × 4 阶段（axe 实跑 5 轮：浅色 / 暗色 / 200% / 强制高对比度 / 文本间距）= 65 次页面扫描，**零违规、零水平溢出**。

---

## 六、阶段报告

### Modified Files

**新增**

- `apps/web/scripts/a11y.mjs` —— axe 扫描脚本
- `docs/143-phase-w11-frontend-followups.md`（本文件）

**修改 · 源码**

- `apps/web/src/router/index.ts` —— 13 条路由静态 import → 动态 import
- `apps/web/src/views/DashboardView.vue` —— ①② 指标卡并排
- `apps/web/src/views/AgentsView.vue` —— `?agent=` URL 同步 + `watch` / `onMounted`
- `apps/web/src/views/RequirementsView.vue` —— `?requirement=` URL 同步 + `ensureRequirementLoaded` 去重
- `apps/web/src/views/WorkflowsView.vue` —— 两个筛选 `Select` 补 `aria-label`
- `apps/web/src/components/layout/AppHeader.vue` —— 删搜索按钮的 `aria-label`，文字改 `sr-only sm:not-sr-only`

**修改 · 测试**（4 个文件，+2 用例）

- `apps/web/src/__tests__/requirementsView.test.ts` —— 装真实 router（此前不装，`useRoute()` 返回 undefined）；新增 `?requirement=` 深链接开抽屉的用例
- `apps/web/src/__tests__/agentsView.test.ts` —— `renderAgents` 支持传路径；新增 `?agent=` 深链接用例
- `apps/web/src/__tests__/workflowsView.test.ts` —— 断言两个筛选的 `aria-label`
- `apps/web/src/__tests__/appShell.test.ts` —— 反向断言搜索按钮**不再**有 `aria-label`、改断言 `sr-only` 模式

**修改 · 文档**

- `apps/web/src/components/README.md` —— 「这两个页面记为待补」→「W11 已补齐」+ 落法说明
- `apps/web/src/styles/README.md` §14 —— 新增「工具行里的控件必须有无障碍名称」一段
- `docs/15-development-roadmap.md` / `docs/17-acceptance-checklist.md` / `docs/18-phase-engineering-goals.md`

**修改 · 依赖**

- `apps/web/package.json` —— devDependencies + `axe-core@4.14.0`、`playwright@1.61.0`；scripts + `a11y`；`pnpm-lock.yaml` 同步

### Implementation

四项工程债 + 两处由扫描器查出的真实缺陷，见第一至五节。**没有改任何业务逻辑、store、api、viewmodel 或接口契约**；`RequirementsView` 里新增的 `ensureRequirementLoaded` 是唯一一处新机制，用途是给一次会扇出 6 个请求的取数去重。

### Architecture Changes

**1. 首屏由「一个整包」变成「入口 + 按路由分块」。** 入口静态依赖（`index` 65.94 kB + `common` 43.61 kB + `auth` 143.78 kB）仍随首屏加载，10 个页面各自的 view 被推迟到真正导航时。代价是**多一次网络往返**（动态 import 不是 static import，不会进入口的 modulepreload），本阶段**没有测首屏 LCP**，因此不知道这次往返抵消了多少收益 —— 见 Known Issues。

**2.「URL 是唯一真源」从两页推广到四页。** 四个详情抽屉现在都是：行内按钮只改 URL，开抽屉与取数由 `watch(id)` 一处承担，关抽屉再把 URL 清干净。深链接 / 前进后退 / 行内按钮三条路径合一。

**3. 无障碍从「人工核对」变成「可重跑的命令」。** W9 的做法是逐元素实测 + 人工比对，结论只能声称「计划点名的九项通过」；现在有一条 `pnpm --filter @ai-se/web a11y` 覆盖 13 条路由 × 4 阶段，且**首跑就查出了两条 W1–W10 全程没发现的真实违规**（其中一条 critical）。这与 W10 把「人工跑一遍的机械检查」变成测试护栏是同一个思路。

### Dependencies

**新增 2 个 devDependency**（用户已批准）：`axe-core@4.14.0`、`playwright@1.61.0`。

- `axe-core` 是本工作区此前没有的包。
- `playwright` 工作区里**已有**（`packages/browser` 的 devDependency 就是 `1.61.0`），此处只是把它链进 `apps/web`，锁文件里没有新增第三方的 playwright 副本。
- 若把 playwright 也算作一次新增，那是**两个**而非一个 —— 但 axe 必须在真实浏览器里跑，没有驱动就无法执行。

**运行时不新增任何依赖**：`dependencies` 一字未改。

### Tests

```
apps/web      : Test Files  36 passed (36)   Tests  448 passed (448)    ← +2（446 → 448）
apps/server   : Test Files  40 passed (40)   Tests  227 passed (227)
全仓          : 16 包 / 175 文件 / 1436 用例（1434 → 1436），typecheck / lint / test 全部 exit 0
```

新增 2 条用例：

| 用例 | 覆盖 |
| --- | --- |
| `RequirementsView`：`?requirement=<id>` 深链接直接打开详情抽屉 | 与「不带 query 时默认关闭」对比，断言隐藏层数变少 |
| `AgentsView`：`?agent=<name>` 深链接直接打开详情抽屉 | 同上 |

另改 2 条既有用例的断言：搜索按钮改为**反向断言** `aria-label` 不存在（防止有人「顺手加回去」）、两个筛选改为断言 `aria-label` 存在。

**SSR 测试的一个坑（已处理）**：`requirementsView.test.ts` 此前**不装 router**，而本阶段起抽屉开合由 `route.query` 驱动 —— 不装 router 会让 `useRoute()` 返回 undefined、整个文件 21 个用例一起挂。已补上 router（`agentsView.test.ts` 本来就有）。

### Lint

`eslint "src/**/*.{ts,vue}"` 通过，无输出。全仓 `pnpm -r run lint` 全部 Done。

### Typecheck

`vue-tsc --noEmit` 通过，无输出。全仓 `pnpm -r run typecheck` 全部 Done。

### E2E

**本阶段第一次把前端改动对着真实后端 + 真实浏览器验证**（W1–W10 全部用页面内注入的 `fetch` mock）。真实数据下的 `apps/web` 18/18 通过（见第三节），API 级 e2e 未跑（未改后端）。

### Known Issues

1. **首屏 LCP 未测。** 代码分割减少了首屏字节（309.9 kB 未压缩），但多了一次动态 import 往返。**没有测过 LCP 或任何性能指标**，因此不能声称「首屏变快了」—— 只能说「首屏字节变少了、build 警告消失了」。
2. **压缩后的传输量未测。** 上面那个 309.9 kB 是 `vite preview` 未压缩的数字。
3. **axe 未覆盖的状态。** 扫描对着真实后端跑，但 13 条路由里的详情页（`/projects/:id`、`/workflows/:id`、`/mcp/:serverId`）用的是**全零 UUID 的示例参数**，落的是「找不到」的错误态。因此**详情页的数据态、弹窗打开态、抽屉打开态没有进 axe 扫描**。
4. **未用真实屏幕阅读器走查**（VoiceOver / NVDA）。axe 只保证「没有已知的可机检违规」，不等于「好用」。
5. **`docs/142` 有一处 SC 编号引用是错的**（本阶段发现，未擅自改文档）：它把「强制高对比度模式」标为 **SC 1.4.12**，而 WCAG 2.2 的 1.4.12 是「Text Spacing」，强制配色（forced-colors）并没有对应的独立 SC。本阶段把这两件事**分开跑**（文本间距与强制高对比度各一阶段），但没有回头改 docs/142 的措辞 —— 那是终验报告的历史记录，改它属于改写已验证的结论。
6. **`docs/142` 另外登记的遗留项仍在**，本阶段未动：5 个新建弹窗缺可访问描述、表头 sticky（已判不做）、`showIcon` 零使用、`--input` 在 `--muted` 面 2.90:1。
7. **W6 的「最近项目 → 最近工作流」内容变更仍待用户确认**（本阶段未回退）。
8. **扫描脚本依赖 dev server 在 5173**（受后端 CORS 限制），所以它不是一个「拉起来就能跑」的自包含命令。
9. **仓库不是 Prettier 干净的，本阶段有意不做全量格式化。** `prettier --check` 在**未改动的**文件上也会报（实测：`MCPAppView.vue`、`PageHeader.vue`、`AgentsView.vue:204`、`DashboardView.vue:54` 都不是本阶段改的行）。`format:check` 不在任何门禁里，因此仓库现状是「格式规则未强制」。本阶段只保证**自己新增/改动的行**不引入新的偏离（改动期间误把 `requirementsView.test.ts` 的两行合成一行，已修回），没有顺手 `prettier --write` —— 那会把 diff 淹没在无关改动里。**若将来要统一格式，应当作为一次独立的、全仓范围的提交来做。**

### Acceptance Result

**通过。**

| 四项工作 | 判定 | 证据 |
| --- | --- | --- |
| 路由级代码分割 | 已解决 | build 警告消失；入口 chunk 569.62 → 65.94 kB；首屏实测 309.9 kB（未压缩） |
| 两个抽屉同步 URL | 已解决 | 真实浏览器 7/7（点开 / Esc / 后退 / 深链接 ×2） |
| 200% 缩放 / 强制高对比度 / 文本间距 | 已解决 | 13 条路由 × 3 阶段零违规、零水平溢出 |
| axe 自动扫描器 | 已解决（含 2 处修复） | 首轮报 2 类真实违规 → 修复 → 复扫全绿 |
| 仪表盘首屏 15px（W10 遗留） | 已解决 | 1440×900 下 5 行全部完整可见 |

```
apps/web : typecheck ✓  lint ✓  test 448/448 ✓  build ✓  a11y ✓（零违规）
全仓     : typecheck ✓  lint ✓  test 1436/1436 ✓  (16 包 / 175 文件, exit 0)
真实后端 : 浏览器走查 18/18 ✓
```

### Next Phase Boundary

**本阶段结束。** 边界：

- **未改后端**：`apps/server`、`packages/*` 一行未动（唯一触及工作区依赖的是把已有的 playwright 链进 `apps/web`）。
- **未改接口契约**：`api/`、`stores/`、`viewmodels/`、路由 `path`/`name` 的语义未变。
- **未改写文案**：两个新 `aria-label`（「按项目筛选」「按状态筛选」）是**新增的无障碍名称**，不是可见文案；页面上的可见文字一字未动。
- **未新增运行时依赖**。
- **未动 `dist/`**（只读 `vite build` 的 stdout 与 `vite preview` 的响应体）。

**仍未开始的**：`docs/142` 登记的其余遗留项（弹窗描述、表头 sticky、`showIcon`、`--input`/`--muted`）、真实后端下的全站走查、以及排在 W 线之后的 **X1 · 模型与凭据配置**。

**X1 的前置**（本阶段确认，值得在开 X1 前先裁定）：`docs/15` 要求 X1 的凭据「复用既有 Secret Provider 引用」，但 `packages/mcp/src/security/credentials.ts` 文件头写明它是 **resolver 接口而非 secret store**（"deliberately not a secret store: the platform supplies a resolver"），且只服务 MCP 作用域；LLM 的 API Key 目前是 `apps/server/src/config.ts:12` 读的明文环境变量。**「密钥存在哪儿」这个问题在 X1 开工前必须先裁定**，它决定后面所有代码的形状。
