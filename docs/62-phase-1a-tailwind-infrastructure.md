# Phase 1-A — Tailwind CSS 4 基础设施（实施记录）

> 阶段：Phase 1-A（Tailwind CSS 4 基础设施接入）
> 依据：`docs/61-phase-0-ui-refactoring-decisions.md`（决策 T1/T2/T3/T4/T9）
> 范围：仅 Tailwind 基础设施；不含 Design Token、不含任何 UI 重构
> 日期：2026-09-15

---

## 1. 修改文件

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `apps/web/package.json` | devDependencies 增加 2 项（精确锁版本，符合仓库风格）：`"@tailwindcss/vite": "4.3.3"`、`"tailwindcss": "4.3.3"` | 仅动 devDependencies；dependencies 未变 |
| `apps/web/vite.config.ts` | `import tailwindcss from "@tailwindcss/vite";` + `plugins: [vue(), tailwindcss()]` | 官方 Vite 插件；未新增 `@` 别名（本阶段不需要，推迟到 Phase 3，见 §7 记录项 1） |
| `apps/web/src/main.ts` | 新增 `import "./styles/app.css";`，置于 `import "./styles.css";` **之前** | 顺序契约：legacy 在最后导入 |

**允许清单外的必要改动（1 项，须说明）**

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `pnpm-lock.yaml`（仓库根） | 新增 tailwind 相关依赖条目 | **安装依赖的必然结果**。不做此改动则依赖无法解析、无法构建。除此之外未改动其他任何文件 |

> 未修改：`apps/web/tsconfig.json`（本阶段不需要 `@` 别名，故未触碰 —— 与 Phase 0 文档 §3 的建议相比，这里做了**收窄**：既然本阶段不生成 shadcn 组件，就不引入没有消费者的路径别名）。

## 2. 新增文件

| 文件 | 内容 |
| --- | --- |
| `apps/web/src/styles/app.css` | Tailwind 4 最小导入（无 preflight、无 token、无自定义组件、无页面样式） |

```css
@layer theme, base, components, utilities;

@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities) source(none);

@source "../";
@source "../../index.html";
```

（文件内另有解释性注释，说明 preflight 被有意省略、以及 `@source` 的原因。）

## 3. 安装的依赖

| 包 | 版本 | 类型 |
| --- | --- | --- |
| `tailwindcss` | 4.3.3 | devDependency（直接） |
| `@tailwindcss/vite` | 4.3.3 | devDependency（直接） |
| 传递依赖 | — | 共 `+28` 个包（含 `@tailwindcss/node`、`@tailwindcss/oxide`、`@tailwindcss/oxide-darwin-arm64`、`lightningcss`、`jiti` 等） |

- **未安装**：shadcn-vue、Reka UI、Lucide、clsx、tailwind-merge、class-variance-authority、tw-animate-css（全部按计划推迟）。
- `pnpm-workspace.yaml` **未修改**：oxide 的原生二进制以可选依赖分发，无需 `allowBuilds` 放行（实测安装过程无审批提示，文件 mtime 仍为 9 月 8 日）。
- 安装命令：`corepack pnpm --filter @ai-se/web add -D --save-exact tailwindcss@4.3.3 @tailwindcss/vite@4.3.3`

## 4. Tailwind 配置说明

| 配置点 | 取值 | 原因 |
| --- | --- | --- |
| 插件 | `@tailwindcss/vite`（官方） | Tailwind 4 的 CSS-first 模式不需要 `tailwind.config.js`，也不需要 `postcss.config.js` |
| 层序 | `@layer theme, base, components, utilities;` | 采用官方"只导入需要的部分"写法，保留 `base` 槽位但**不导入其内容** |
| Preflight | **未导入** | preflight 位于 `@layer base`，会把 `h1-h6` 的 `font-size/weight` 重置为 `inherit`；当前 `styles.css` 的面板标题依赖浏览器默认字号 ⇒ 导入即产生全站视觉变化（决策 T1/T4） |
| theme | `@import "tailwindcss/theme.css" layer(theme);` | 默认主题变量；本阶段不覆写、不新增 token（token 属 Phase 1-B） |
| utilities | `@import "tailwindcss/utilities.css" layer(utilities) source(none);` | `source(none)` 关闭自动内容探测 |
| 扫描源 | `@source "../";` + `@source "../../index.html";`（相对 `app.css` 解析 → `apps/web/src/` 与 `apps/web/index.html`） | 本仓库**没有 `.git`**（AGENTS.md §1），Tailwind 的自动探测失去 `.gitignore` 依据，会连同 `dist/` 一起扫描；显式登记可避免产物目录被当作源 |
| Legacy 共存 | `styles.css` 未做任何 layer 包装 | 未分层普通声明优先于任何 `@layer` 内的普通声明（MDN），因此迁移期 legacy 恒定胜出 —— 这是既定前提，本阶段**不调整** |

### 4.1 关键机制验证（实证，非推测）

1. **A/B 对照（`source(none)` 开 / 关）**：两次构建产物 **SHA-256 完全一致**
   （`4d4c7470dfaa38e30c5f53664855e7f0bb27b6a57f4479e17ab7f95cbe4e62a2`）⇒ 当前源码与产物中不存在任何 Tailwind 类名，`source(none)` 的可观测差异要到页面开始使用工具类后才出现；两种配置当下等价。
2. **扫描→生成链路（构建模式）**：临时把一个项目外部的探针文件登记为 `@source`，5 个类被正确生成于 `@layer utilities{…}` 内（如 `.p-5{padding:calc(var(--spacing) * 5)}`），随后移除探针并重建，产物哈希回到对照值 ⇒ **显式 `@source` + `source(none)` 的链路可用**。
3. **扫描→生成链路（开发模式）**：dev server 直取 `app.css` 输出为
   `.p-5 { padding: calc(var(--spacing) * 5); }`（位于 `@layer utilities { … }`）⇒ **HMR 路径同样可用**。
4. **Preflight 缺席（真实浏览器）**：向页面注入 `h2` / `ul` / `a` 探针元素，实测 `h2` = **24px/700（UA 默认）**、`ul` = `list-style-type: disc`（UA 默认）。若 preflight 生效则为 `16px/inherit` 与 `none`。
5. **产物层结构**：构建产物中 `@layer` 出现次数 = 1（仅 `@layer theme,base,components,utilities` 声明），无 `@layer base{…}` 块；preflight 指纹（`border:0 solid`、`font-size:inherit;font-weight:inherit`、`list-style:none}`、`resize:vertical`、`appearance:button` 等）命中数 **全部为 0**。

## 5. 四项门禁结果

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| Type Check | `corepack pnpm --filter @ai-se/web typecheck` | **PASS**（exit 0） |
| Lint | `corepack pnpm --filter @ai-se/web lint` | **PASS**（exit 0） |
| Test | `corepack pnpm --filter @ai-se/web test` | **PASS**：Test Files 15 passed (15) / Tests 53 passed (53) |
| Build | `corepack pnpm --filter @ai-se/web build` | **PASS**（exit 0，164 modules，267-357ms） |

附加：`prettier --check` 对 4 个改动文件 **PASS**。

## 6. 是否存在视觉变化

**不存在主动或被动视觉变化。** 证据：

| 检查 | 结果 |
| --- | --- |
| 构建产物 CSS | 11 504 → 11 609 字节（**+105 字节**，仅 Tailwind banner + `@layer` 声明；无任何样式规则增加） |
| 构建产物 JS | 271 444 字节（与基线**完全相同**；文件名哈希因模块图变化而变，体积未变） |
| Preflight 是否泄漏 | 无（见 §4.1 第 4、5 项） |
| 真实渲染抽样 | `.sidebar` 背景 `rgb(16,32,51)`、`.page-header h1` 32px/700、`.metric strong` 28px、`.button.primary` 背景 `rgb(29,111,211)`、`.nav a.router-link-active` 背景 `rgb(33,57,82)`、`body` margin 0、`box-sizing: border-box` —— 与改动前 `styles.css` 的声明逐项一致 |
| 样式表数量 | 1 份（`index-DguI796u.css`），`styles.css` 内容原样保留 |

## 7. 是否存在风险

| 级别 | 风险 | 说明 / 处置 |
| --- | --- | --- |
| 低 | `source(none)` 的"限制效果"当前不可观测 | A/B 实测两种配置产物字节一致；其作用要到 Phase 2 页面开始用工具类后体现。**Phase 2 首个页面迁移时必须复核**：新增 `.vue` 中的类是否被构建与 dev 同时采集 |
| 低 | `@source` 目前只登记了 `src/` 与 `index.html` | 若后续有 `packages/**` 产出带 Tailwind 类的模板（当前没有），需追加 `@source`，否则那些类不会被生成 |
| 低 | 构建产物 CSS 名称哈希每次变更 | 属正常构建指纹变化；对 `docs/10` 无影响 |
| 记录项（**不建议本阶段处理**） | ① 未引入 `@` 别名（Phase 3 需要时再加，届时同时改 `vite.config.ts` 与 `tsconfig.json`）；② 允许清单外改动了 `pnpm-lock.yaml`（安装依赖的必然结果）；③ `apps/web/dist/` 被重新生成（构建产物，未纳入版本管理） | 均已在报告中显式记录，未自行扩大范围 |

### 7.1 本阶段期间出现的新输入：参考设计图（记录，不处理）

本阶段执行过程中，仓库新增了 `docs/ui-reference/ai-se-home.png`（1842×854 PNG，11:19 加入，非本阶段产物）。**这是 Phase 0 §20 Q5 里缺失的参考图**，因此改变了 Visual QA 的输入条件。已做只读分析，**未据此改动任何代码**：

| 项 | 实测/读取结果 | 与现状的关系 |
| --- | --- | --- |
| 侧栏右分隔线 | 像素扫描：x ≈ **179**（在 427 个采样行中有 404 行为局部暗线） | 若该图为 1× 截图，则与设计文档 164px 同量级；**当前代码是 240px**（明显更宽） |
| Header 下分隔线 | 像素扫描：y ≈ **53** | 与设计文档 52px **吻合**；当前代码**没有 Header** |
| 一级菜单（逐字读取） | 首页 / 项目管理 / 工作流 / 任务管理 / 智能体 / 部署管理 / 代码仓库 / 系统设置 | 与设计文档 §1 一致；**与当前代码的 8 项不同**（代码中是 仪表盘/项目/**需求**/工作流/部署/Agent/Agent 运行/MCP 服务器） |
| 主色 | 紫色系（目测 ≈ `#6366F1`–`#6D5EF3`） | 与决策 D7（`#6C5CE7`）方向一致 |
| 内容区块 | 欢迎横幅、快速开始（4 卡）、项目数据概览（4 指标）、当前工作流、最近动态、系统状态（API/DB/Redis/Docker）、最近部署、我的项目**表格**（6 列，含「最新工作流」列） | 这些区块**在当前代码中均不存在**；其中「我的项目」表格的「最新工作流」列在 `Project` 实体里**没有对应数据** |

**结论（记录，待你在 Phase 2/4 开工前裁决）**

1. 尺寸冲突按既有规则解决：`docs/design/06-visual-qa.md:23` 明确"截图与 Design System 冲突时，Design System 优先" ⇒ 侧栏 164px / Header 52px 以设计文档为准，且与参考图实测值同量级 ⇒ **Phase 2 把 240px 收敛到 164px 是"向设计与参考图同时收敛"**。
2. 菜单冲突仍是 D3 的直接后果（参考图与设计文档都含 3 个代码中不存在的页面）⇒ 需你确认：本轮是否**只做视觉、不动菜单**（则最终成品与参考图的菜单不一致，属预期差异）。
3. 参考图中"新建项目/启动工作流/访问代码仓库/查看使用指南"、系统状态、我的项目表格等区块**无法在不新增功能与数据的前提下还原** ⇒ 需要你明确：Dashboard（Phase 4）是"按参考图重构现有 3 个指标 + 最新项目列表"，还是"以参考图为目标但要裁剪掉无数据支撑的区块"。

**未发现超出本阶段范围的必须修复项。**

## 8. 最终结论

**PASS**

- 四项门禁全部通过；`styles.css`、11 个 View、Router、API、Store、ViewModel、SSE、业务逻辑**均未改动**（仅 `main.ts`/`app.css`/`vite.config.ts`/`package.json` 4 个允许文件 + 必然的锁文件更新）。
- Tailwind CSS 4 在 `apps/web` 的**构建模式与开发模式**均已验证可用，且 **Preflight 确认未引入**、视觉零变化。
- 下一步：**Phase 1-B（Design Token 落地）** —— 待指令，不自动推进。
