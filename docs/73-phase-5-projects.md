# Phase 5-B — Projects 视觉重构（实施记录）

> 阶段：Phase 5-B（Projects 两页视觉重构）
> 前置：`docs/72-phase-5-projects-analysis.md`（Phase 5-A 现状分析与冻结清单）
> 依据：`docs/design/*`、`docs/ui-reference/ai-se-home.png`、`docs/60`–`docs/72`
> 范围：仅 `/projects` 与 `/projects/:id`
> 日期：2026-09-15

---

## 1. 修改文件

### 修改
| 文件 | 改动 |
| --- | --- |
| `apps/web/src/views/ProjectsView.vue` | template / class / 组件组合 + 页面级 scoped 链接色；`<script setup>` 业务逻辑逐行未改 |
| `apps/web/src/views/ProjectDetailView.vue` | 同上 |

### 新增
| 文件 | 说明 |
| --- | --- |
| `apps/web/src/__tests__/projectsView.test.ts` | 列表页契试（7 例） |
| `apps/web/src/__tests__/projectDetailView.test.ts` | 详情页契约测试（6 例） |

### 未改动
`styles.css`（仍 960 行 / mtime 11:41）、Design Token（`styles/app.css` 未碰）、API（`api/projects.ts` 9月14）、Store（`stores/projects.ts` 9月14）、Router（`router/index.ts` 9月11）、ViewModel（`viewmodels/projectViewModel.ts` 14:11 = Phase 4）、Dashboard、其他 8 个页面、依赖。**未新增任何组件。**

## 2. 视觉迁移

### ProjectsView（列表 + 常驻创建表单）
| Legacy | New |
| --- | --- |
| `.page .two-column .main-column` | `<section class="grid max-w-[1180px] grid-cols-1 gap-6 min-[900px]:grid-cols-[minmax(0,1fr)_360px]">` + `min-w-0` |
| `.page-header` + `.eyebrow` + h1 | `PageHeader eyebrow="项目" title="项目"`（无 actions，与迁移前一致） |
| `.state` / `.state.error` | Tailwind `<p>`：`text-body text-muted-foreground` / `text-body text-danger` |
| `.empty` | `EmptyState title="暂无项目。"` |
| `.project-list` / `.project-row` | `ul + li` + `Card`（12px 圆角 / `--border` / `p-4`） |
| `.project-title`（18px/700） | `text-card-title`（**14px/600**）+ 页面 scoped 链接色 `--primary` |
| `.project-row p` / `span` | `text-secondary text-muted-foreground`（13px）+ `break-words` |
| `.row-actions` | `flex shrink-0 items-center gap-3` |
| `.status`（固定绿） | `StatusBadge :tone="projectStatusTone(project.status)"`（**复用 Phase 4 函数**） |
| `.button.subtle`（打开） | `buttonVariants({ variant: "secondary" })`（RouterLink，scoped 链接色 `--foreground`） |
| `.button.danger`（删除） | `<Button variant="destructive">` |
| `.form-panel` | `Card` + `SectionHeader title="新建项目"` + `Label`/`Input`/`Textarea`/`Button` |
| `.form-panel input/textarea`（`#cbd5df` / 8px / 16px） | `Input` / `Textarea` 组件（`--input` / 10px / `text-body` 14px） |
| 包裹式 `<label><span>` | `Label for` + 控件 `id`（`project-name` / `project-repository` / `project-description`） |
| `.button.primary`（创建） | `<Button type="submit">`（Primary `#6C5CE7`） |

### ProjectDetailView（详情）
| Legacy | New |
| --- | --- |
| `.page` | `max-w-[1180px]`（保留原页面宽度上限） |
| `.page-header` + `.eyebrow` | `PageHeader :title="selectedProject?.name || '项目'" eyebrow="项目详情"` + `#actions` 放「返回」 |
| `.button.subtle`（返回） | `buttonVariants({ variant: "secondary" })`（RouterLink，scoped 链接色） |
| `.state` / `.empty` | 同列表页（`EmptyState title="未找到该项目。"`） |
| `.detail-grid` | `grid grid-cols-1 gap-6 min-[900px]:grid-cols-[minmax(0,1fr)_280px]` |
| `.detail-list`（白卡 + 8px 圆角 + `#edf1f5` 分隔线） | `Card` + `<dl class="divide-y divide-border">`，行 = `grid-cols-[140px_1fr]` + `px-[var(--card-padding)] py-4` |
| `.detail-list dt` / `dd`（16px） | `dt`：`text-body font-medium text-muted-foreground`；`dd`：`text-body text-foreground`（**14px**） |
| 状态纯文本 | `StatusBadge :tone="projectStatusTone(...)"` |
| `.panel.action-panel` | `Card class="grid gap-4 self-start p-[var(--card-padding)]"` + `SectionHeader title="操作"` |
| `.button.danger`（删除项目） | `<Button variant="destructive">` |

### 级联处理（未使用 `!important`、未改全局规则）
- 两个页面各带一段 **scoped** 样式，仅重声明 `<RouterLink>` 的 `color` / `text-decoration`（`--primary`、`--foreground`）——与 AppSidebar（Phase 2-A）及 Dashboard（Phase 4）完全相同的既有手法，用于对抗 `styles.css` 中**未分层**的全局 `a { color:#1d4f91 }`。
- 移除 `.form-panel` 类后，legacy 未分层的 `.form-panel input/select/textarea` 已不再作用于本页控件（Input/Textarea 组件的 Token 样式直接生效）。
- 迁移后两页内 legacy 类残留 **0 个**（浏览器实测）。

## 3. 业务冻结确认

| 冻结项 | 状态 |
| --- | --- |
| API endpoint / 参数 / 响应处理 | unchanged（浏览器记录到的真实请求：`POST /api/projects` → 201、`DELETE /api/projects/:id` → 200） |
| Store（`stores/projects.ts`） | unchanged（文件未碰） |
| Router / route meta / 权限 | unchanged（文件未碰；无新增路由或 meta） |
| 业务状态 `ProjectStatus` | unchanged（未改枚举、未改「启用/已归档」文案） |
| 业务规则 | unchanged（zod 校验属性 `required` / `type="url"` / `maxlength=120/500/1000` 与 `rows=5` 全部保留并实测） |
| 表单成功后清空 | ✅ 实测：提交后三个字段均回到空串 |
| 创建 / 删除 loading | ✅ 实测：按钮文案「创建中…」/「删除中…」逻辑保留（`creating` / `deletingId`） |
| `window.confirm` | ✅ 实测：拦截到的文案 = **「确定删除该项目吗？」**（与迁移前逐字一致） |
| 删除后跳转 | ✅ 详情页 `deleteProject` → `router.push("/projects")` 保留 |
| 详情页 `watch` 路由参数 | ✅ 代码原样保留 |
| `fetchProject` 失败 → error 优先于 empty | ✅ 分支顺序与判定未改（页面测试覆盖） |
| 9 项交互 | ✅ 全部保留（见上表与浏览器验证） |
| 新增功能 / 新 mock 数据 | 无（未新增任何按钮、字段、提示、假数据） |

**真实 API 端到端验证（数据净变化为零）**：以真实后端完成 `创建（名称故意带首尾空格）→ 列表出现 → 删除` 的完整往返，随后用 `curl` 核对数据库回到验证前的状态（`count = 1`，仅 `Mini Todo`）。

## 4. 测试结果

- **before：18 files / 98 tests** → **after：20 files / 111 tests**（+13：`projectsView.test.ts` 7 例、`projectDetailView.test.ts` 6 例；既有 98 例全部保留且未修改断言）
- 新增用例覆盖：PageHeader/表单结构、表单校验属性与控件类型、loading/error/empty/list 四分支互斥、行内链接与按钮、状态徽标 tone（success / neutral）、描述兜底文案、标题回退。

| 门禁 | 结果 |
| --- | --- |
| typecheck | **PASS**（exit 0） |
| lint | **PASS**（exit 0，0 problem） |
| test | **PASS**（20 files / 111 tests） |
| build | **PASS**（`index-gyywPRTY.css` 24.41 kB / `index-18sC6Cg7.js` 317.76 kB） |

## 5. 浏览器验证（真实 API + 真实浏览器）

| 检查项 | 实测结果 |
| --- | --- |
| 列表页 Token | h1 **24px/600**；行卡 12px 圆角 / `#E8EAF0` / `p-4`；项目名 **14px/600 `#6C5CE7`**；徽标 success `#059669` on `#ECFDF5`；「打开」`bg #F8F9FC` + 文字 `#1F2937`；「删除」`#DC2626` 白字；Label 13px/500；Input 36px / `#E8EAF0` / 10px / 14px |
| 详情页 Token | h1 = 真实项目名（24px/600）；eyebrow 项目详情；`dl` 五行 = 状态/仓库/描述/创建时间/更新时间（真实值，日期格式 `2026年9月14日 11:04` 未变）；`dt` 14px/500；`dd` 14px；返回 `#1F2937` on `#F8F9FC`；删除项目 `#DC2626`；卡片 12px |
| 数据绑定 | 状态徽标「启用」= success；描述空值走「暂无描述。」；两个日期用 `formatProjectDate` 原样 |
| hover（真实鼠标） | 项目名 → `#6C5CE7` + 下划线；打开 / 返回 → 文字 `#1F2937`、无下划线（scoped 规则稳定胜过 legacy `a:hover`） |
| focus-visible（真实键盘 Tab） | 「打开」「删除」「Input ×2」「Textarea」「创建」全部呈现 **2px Primary 焦点环**（`rgb(108,92,231)`）；行标题链接保留浏览器原生 `outline: auto`（与迁移前一致，见 §6 风险 6） |
| 列表页响应式 | 880 / 899px → **单列**；900 / 1024 / 1280 / 1440px → **1fr + 360px 两列**；`max-width: 1180px` 生效 |
| 详情页响应式 | 880 / 899px → **上下堆叠**；900 / 1024 / 1440px → **1fr + 280px 并排** |
| 横向溢出 | 全宽档位 **0**（含 880px） |
| 控制台 | 无 `window.onerror` / `unhandledrejection`，无 `[Vue warn]` |
| 其他页面回归 | Dashboard 仍 24px + 4 卡（Phase 4 未受影响）；`/requirements`、`/mcp`、`/agent-run` 仍为 legacy 32px 结构；均无溢出 |
| legacy 残留 | Projects 两页内 `.page/.page-header/.eyebrow/.two-column/.main-column/.project-*/.row-actions/.status/.form-panel/.state/.empty/.detail-*/.panel/.action-panel/.button` **全部为 0** |

## 6. 风险（只记录，未擅自扩大范围）

1. **`.trim` 修饰符实际生效（修正 Phase 3-B 的一处注释）**：本次实测证实 `defineModel()` **会**自动应用 `trim` 修饰符——向表单填入 `"  阶段5临时项目  "` 后，模型与 `POST` 请求体中的值均为已 trim 的 `"阶段5临时项目"`，与迁移前原生 input 的行为一致，**无功能差异**。但 `components/ui/input/Input.vue`、`textarea/Textarea.vue` 的注释仍写着「不会应用 `.trim`/`.lazy` 修饰符」，该说明**不准确**；`components/ui/` 不在本阶段允许修改的文件范围内，故仅记录，建议后续阶段更正注释。
2. **链接的焦点指示**：内容链接（项目名）沿用浏览器原生焦点轮廓，未加 Primary ring（与迁移前一致）。交互控件（Button/Input/Textarea）统一使用 Primary ring。
3. **保留 1180px 页面宽度上限**：与 Phase 4 Dashboard 的「铺满主区」不同——设计文档只对 Dashboard 明确要求「充分利用屏幕」，列表/详情型页面按 `03-page-layout.md` §11 保留宽度上限。若需统一为铺满，是一行改动，请后续阶段裁定。
4. **有意为之的视觉变化**（设计对齐，非回归）：项目名 18px/700 → 14px/600；删除按钮由「浅红底 + 红描边 + 红字」→ **实心 `--danger`**；行卡圆角 8px → 12px；输入框边框 `#cbd5df` → `--input`；`.status` 固定绿 → 按 tone 的语义色。
5. **`min-[900px]` 任意断点**：为逐字保留 legacy 的 900px 折叠点而使用；Tailwind 默认断点（1024）会让 900–1023px 区间的体验退化，故未采用默认断点。
6. **测试未覆盖真实点击 / confirm**：页面测试为 SSR 渲染契约（无 jsdom），交互（提交、删除确认、导航）依赖浏览器验证；后续如需自动化交互测试需引入 DOM 环境（本阶段不新增依赖）。
7. **页面间视觉代差**：Projects 两页已迁移，其余 8 个页面仍为 legacy 视觉，属于分阶段推进的预期状态。
8. **`styles.css` 中相关 legacy 类全部保留**（`.two-column`、`.action-panel` 等仍存在但已无使用者），按纪律留待 Phase 11 集中清理。

---

**Code changed:** `apps/web/src/views/ProjectsView.vue`、`apps/web/src/views/ProjectDetailView.vue`、`apps/web/src/__tests__/projectsView.test.ts`（新增）、`apps/web/src/__tests__/projectDetailView.test.ts`（新增）
**API/Store/Router changed:** NONE
**styles.css changed:** NONE（仍 960 行 / mtime 11:41）
**Dependencies changed:** NONE

按阶段纪律**在此停止**，不进入 Phase 5-C。
