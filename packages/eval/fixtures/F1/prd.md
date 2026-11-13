# TaskBoard 前端 · 产品需求文档（F1 夹具 / 纯前端）

> 本文是平台的**需求输入**。据此交付一个**只有前端**的 TaskBoard 页面：不写后端、不改 mock，
> 只按契约消费 `VITE_API_BASE`。所有验收标准（AC）都由隐藏的浏览器 oracle 客观判定，
> **不得用文本或 CSS 类作为验收依据**。

## 一、交付目标

一个可构建、可预览、可测试的 **TaskBoard 任务看板**单页应用：加载任务列表、四态（加载 / 空 / 错误 / 有数据）
可切换、可新建任务（含校验与失败态）、可搜索、可按状态筛选（搜索与筛选叠加）、可切换完成状态、可删除。

## 二、技术约束（硬性）

1. **栈固定**：Vue 3 + TypeScript + Vite + Vitest。不得换成 React / Svelte / 其他框架。
2. **工程形态**：pnpm 工程，必须提交 `pnpm-lock.yaml`（构建以 `pnpm install --frozen-lockfile` 开始）。
   `package.json` 必须提供脚本：
   - `start`：`vite preview`，端口读 `PORT`（**必须** `--host 127.0.0.1` 且 `--strictPort`）
   - `build`：`vite build`，产物在 `dist/`
   - `test`：`vitest run`（至少一个真实用例）
   - `lint`、`typecheck`：退出码 0 即通过
3. **依赖集固定**：`package.json` 里的 `dependencies` / `devDependencies` 就是全部——
   **不得新增、不得删除、不得改版本**，也不得修改 `pnpm-lock.yaml`。构建以
   `pnpm install --frozen-lockfile` 开始，lockfile 与 `package.json` 一旦不一致，验收直接失败。
   测试工具链（`vitest` + `@vue/test-utils` + `jsdom`，DOM 环境已在 `vitest.config.ts` 配好）与
   `lint` / `typecheck` 脚本都已提供；要写组件测试直接用它们，不需要也不要自己装 eslint 之类的东西。
4. **接口地址**：前端只能通过 `import.meta.env.VITE_API_BASE` 读取后端地址——它在 **`pnpm build` 时**
   由环境变量注入（Vite 会在构建期内联 `import.meta.env`）。**不得**在运行期读取配置文件、不得硬编码端口。
5. **网络**：除 `VITE_API_BASE` 外不得发起任何外部请求（禁止 CDN、远程字体、埋点）。
6. **不写后端**：不得新增任何服务端实现，**不得修改 `mock-server.mjs` 的行为**（它是输入契约的一部分）。
7. 页面不得出现横向滚动（375px 视口下同样成立）。

## 三、mock 契约（已随夹具提供，`pnpm mock` 启动，端口读 `PORT`）

```
GET    /api/tasks            → 200 {"items":[{id,title,done,createdAt}]}
POST   /api/tasks            → 201 {"task":{…}} | 400 {"error":{"code":"TITLE_INVALID"}}
PATCH  /api/tasks/:id        → 200 {"task":{…}} | 404 {"error":{"code":"NOT_FOUND"}}
DELETE /api/tasks/:id        → 204 | 404
GET    /api/tasks?error=1    → 500（错误态用）
GET    /__mock/requests      → 200 {"requests":[{method,path,body}]}（**只给验收用，前端不得调用**）
```

`/__mock/*` 是测试控制面（`reset` / `config`），**前端不得调用**。

## 四、UI 契约：testid 命名（硬性）

所有被 AC 点名的元素**必须**带 `data-testid`，取值只能是下表里的名字。命名不得自创、不得改写。
验收标准里的元素一律写成 `data-testid=` 加引号包裹的完整形式——平台的 UI 边界冒烟**只认这个形式**，
不会从散文里猜名字。

| testid | 用途 |
| --- | --- |
| `app-title` | 页面标题（文本非空） |
| `loading-indicator` | 首屏加载中提示（数据到达后消失） |
| `error-banner` | 错误横幅（列表加载失败 / 新建失败） |
| `retry-button` | 错误横幅里的重试按钮 |
| `search-input` | 搜索输入框 |
| `filter-all` / `filter-active` / `filter-done` | 三个筛选按钮 |
| `task-count` | 当前任务总数（文本为数字） |
| `task-list` | 列表容器 |
| `task-item` | 每个任务行；**完成态必须体现在 `data-done="true"/"false"` 属性上** |
| `task-title` | 任务行内的标题文本 |
| `task-done-toggle` | 切换完成状态 |
| `task-delete-button` | 删除该任务 |
| `empty-state` | 「一条任务都没有」时的空态（源列表为空） |
| `no-results` | 「筛选/搜索无匹配」时的空态（源列表非空） |
| `new-task-button` | 打开新建对话框 |
| `new-task-dialog` | 新建对话框容器 |
| `task-title-input` | 新建对话框里的标题输入框 |
| `save-task-button` | 保存（请求进行中必须 `disabled`） |
| `cancel-task-button` | 取消 |
| `form-error` | 前端校验错误提示 |

## 五、功能需求与验收标准

### FR-1 首屏与列表

| 编号 | 验收标准 | 优先级 |
| --- | --- | --- |
| AC-01 | 打开 `/` 后 `data-testid="app-title"` 可见且文本非空 | Must |
| AC-02 | 首屏加载期间出现 `data-testid="loading-indicator"`，数据到达后消失 | Must |
| AC-03 | mock 返回 3 条时 `data-testid="task-item"` 恰好 3 个，**顺序与 mock 返回一致** | Must |
| AC-04 | 每个 `data-testid="task-item"` 内 `data-testid="task-title"` 的文本等于 mock 的 `title` | Must |
| AC-05 | mock 返回 0 条时显示 `data-testid="empty-state"`，且不渲染任何 `data-testid="task-item"` | Must |

### FR-2 新建任务

| 编号 | 验收标准 | 优先级 |
| --- | --- | --- |
| AC-06 | 点击 `data-testid="new-task-button"` 打开 `data-testid="new-task-dialog"` | Must |
| AC-07 | 标题为空（或只有空白）点 `data-testid="save-task-button"` → 出现 `data-testid="form-error"`，且**不得发出 POST** | Must |
| AC-08 | 填标题保存 → 对话框关闭、列表新增一项**且新任务位于列表首位**、`data-testid="task-count"` 加 1 | Must |
| AC-09 | 保存遇 500 → `data-testid="error-banner"` 可见，且对话框**保持打开** | Must |
| AC-10 | 保存进行中 `data-testid="save-task-button"` 处于 `disabled`，完成后恢复 | Must |

### FR-3 搜索与筛选

| 编号 | 验收标准 | 优先级 |
| --- | --- | --- |
| AC-11 | 输入关键字 → 仅匹配项可见，非匹配项消失 | Must |
| AC-12 | 搜索无结果 → 显示 `data-testid="no-results"`，**不得**显示 `data-testid="empty-state"` | Must |
| AC-13 | 点 `data-testid="filter-done"` → 仅已完成项可见 | Must |
| AC-14 | 点 `data-testid="filter-all"` → 恢复全部 | Must |
| AC-15 | 搜索 + 筛选叠加 → 结果同时满足两者 | Must |

### FR-4 完成、删除与韧性

| 编号 | 验收标准 | 优先级 |
| --- | --- | --- |
| AC-16 | 点某任务 `data-testid="task-done-toggle"` → 该 `data-testid="task-item"` 的 `data-done` 变为 `"true"` | Must |
| AC-17 | 完成状态在**刷新页面后保持**（经 mock 持久化） | Must |
| AC-18 | 点 `data-testid="task-delete-button"` → 该项消失、`data-testid="task-count"` 减 1 | Must |
| AC-19 | 列表首次请求 500 → `data-testid="error-banner"`；点 `data-testid="retry-button"` 后正常渲染 | Must |
| AC-20 | 整个验收运行期间浏览器控制台**无 error**（网络 4xx/5xx 的资源日志除外） | Must |

### FR-5 可用性（Should，不参与通过判定）

| 编号 | 验收标准 | 优先级 |
| --- | --- | --- |
| AC-21 | 列表首屏在 3s 内出现 `data-testid="task-item"` | Should |
| AC-22 | 375px 视口下页面无横向滚动 | Should |
| AC-23 | 键盘 Tab 可依次到达搜索框、新建按钮、首个任务的完成切换 | Should |
| AC-24 | 暗色模式（`prefers-color-scheme: dark`）下 `data-testid="task-item"` 背景取暗色 token | Should |

## 六、实现说明（非硬性）

- 样式、状态管理方式自定；不需要路由与多页面。
- 任务行可用任意语义标签，但完成态**必须**写在 `data-done` 属性上。
- 删除与切换失败时如何提示不参与判定（但控制台不得报错）。
