# Phase 3-A — shadcn-vue 基础设施（实施记录）

> 阶段：Phase 3-A（shadcn-vue 基础设施）
> 依据：`docs/design/00-design-system.md`、`04-component-system.md`、`docs/61-phase-0-ui-refactoring-decisions.md`、`docs/ui-reference/ai-se-home.png`、`docs/64`/`65`/`66`
> 范围：仅组件基础设施；不生成任何具体 UI 组件、不改任何业务页面
> 日期：2026-09-15

---

## 1. 新增文件

| 文件 | 内容 |
| --- | --- |
| `apps/web/components.json` | shadcn-vue 配置（见 §4） |
| `apps/web/src/components/ui/utils.ts` | `cn()` 统一 className 合并工具（见 §5） |

> 未生成任何具体组件（未执行 `shadcn-vue add …`，未创建 Button / Card / Badge / Input / Dialog / Table 等）。`components/` 目录下当前仅有 `layout/`（Phase 2）与 `ui/utils.ts`。

## 2. 修改文件

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `apps/web/package.json` | dependencies 增加 4 个包（见 §3） | shadcn-vue 基础依赖 |
| `apps/web/vite.config.ts` | `resolve.alias` 增加 `"@" → ./src` | shadcn-vue 生成产物统一用 `@/` 前缀导入 |
| `apps/web/tsconfig.json` | 增加 `paths: {"@/*": ["./src/*"]}` | 让 `vue-tsc` 解析同一别名 |
| `apps/web/vitest.config.ts` | 增加同款 `"@"` 别名 | 否则任何 `import "@/…"` 的模块在 vitest 下无法解析（潜在陷阱） |
| `apps/web/src/styles/app.css` | 增加 8 个 shadcn 兼容别名变量 + 对应 `@theme inline` 映射 | 见 §6 |
| `pnpm-workspace.yaml` | 修正 `allowBuilds` 中 pnpm 自动写入的占位符 | 见 §8「过程中修复的两个问题」 |
| `pnpm-lock.yaml` | 新增依赖条目 | 安装依赖的必然结果 |

**未改动**：`styles.css`（11:41:13，仍 Phase 2-A）、`App.vue`（11:41:01）、`AppSidebar.vue`（11:53:54）、`AppHeader.vue` / `AppShell.vue`（12:06:28）、`router/index.ts`（9 月 11 日）、任何业务 View（≤9 月 14 日）、`main.ts`。

## 3. 新增依赖

| 包 | 版本 | 类型 | 用途 |
| --- | --- | --- | --- |
| `reka-ui` | 2.10.4 | dependencies | shadcn-vue 的无障碍基础组件库 |
| `clsx` | 2.1.1 | dependencies | `cn()` 的条件类名合并 |
| `tailwind-merge` | 3.7.0 | dependencies | `cn()` 的 Tailwind 冲突类消解（TW4 兼容线） |
| `class-variance-authority` | 0.7.1 | dependencies | 组件 variant 定义 |

传递依赖：`+22` 个包（含 `@vueuse/core`、`@vueuse/shared`、`@floating-ui/dom`、`vue-demi` 等）。
**未引入**：`shadcn-vue` CLI 本身不需要作为运行时依赖；`tw-animate-css` 本阶段**未安装**（不在阶段技术清单内，仅当后续生成含动画的组件时才需要，见 §9）。

## 4. components.json 配置

```json
{
  "$schema": "https://shadcn-vue.com/schema.json",
  "style": "new-york",
  "typescript": true,
  "tailwind": {
    "config": "",
    "css": "src/styles/app.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "ui": "@/components/ui",
    "utils": "@/components/ui/utils",
    "lib": "@/components/ui",
    "composables": "@/composables"
  }
}
```

关键取值与依据：

| 字段 | 取值 | 依据 |
| --- | --- | --- |
| `style` | `new-york` | 取自官方 schema 的 style 枚举；视觉最终由 AI-SE Token 决定 |
| `tailwind.config` | `""` | Tailwind 4 无配置文件（CSS-first） |
| `tailwind.css` | `src/styles/app.css` | 唯一包含 `@import "tailwindcss"` 的文件 |
| `tailwind.baseColor` | `neutral` | 仅提供占位；实际颜色全部来自 AI-SE Token，**不接受 CLI 写入的中性调色板**（Phase 0 决策 T7） |
| `cssVariables` | `true` | 组件通过 CSS 变量取色（与 Phase 1-B 的 `:root` + `@theme inline` 一致） |
| `aliases.utils` | `@/components/ui/utils` | 见 §5 |
| `aliases.lib` | `@/components/ui` | 不新建 `lib/` 目录（AGENTS.md §5） |
| `aliases.composables` | `@/composables` | AGENTS.md §5 规划目录（本阶段不创建该目录） |

**校验**：按官方 schema 核对，`style` / `tailwind` / `aliases` 三个必填项齐备；`tailwind` 的 `config` / `css` / `baseColor` / `cssVariables` 必填项齐备；`aliases` 的 `utils` / `components` 必填项齐备（脚本校验通过）。

## 5. cn() 位置

**`apps/web/src/components/ui/utils.ts`**（导入路径：`@/components/ui/utils`）。

```ts
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

**为什么不是 shadcn-vue 默认的 `@/lib/utils`**：AGENTS.md §5 明确禁止在已规划的 `components/`、`composables/`、`types/`、`constants/` 之外另立 `lib/`、`shared/`、`helpers/` 等同名变体目录。放在已批准的 `components/ui/` 下既满足阶段推荐的位置，也不新增任何目录体系；`components.json` 的 `aliases.utils` 已指向同一路径，后续由 CLI 生成的组件会自动使用该位置，不需要二次改动。

## 6. Design Token 是否保持不变

**Token 值全部保持不变**（Phase 1-B 的颜色/排版/圆角/阴影/布局/状态色一个都没有改数值），仅在 `app.css` **新增 8 个 shadcn 兼容别名**，全部指向既有 Token：

| 新增别名 | 指向 | 说明 |
| --- | --- | --- |
| `--popover` / `--popover-foreground` | `var(--card)` / `var(--card-foreground)` | 浮层用卡片色 |
| `--secondary` / `--secondary-foreground` | `var(--muted)` / `var(--foreground)` | 次要底色 |
| `--accent` / `--accent-foreground` | `var(--muted)` / `var(--foreground)` | 悬停/强调底色 |
| `--destructive` / `--destructive-foreground` | `var(--danger)` / `var(--primary-foreground)` | 危险操作色；前景复用白色 Token |

- **未引入第二套颜色体系**：以上全部是 `var()` 引用，**没有新增任何颜色值**。
- `@theme inline` 同步新增 8 条 `--color-*` 映射（`bg-popover` / `bg-secondary` / `bg-accent` / `bg-destructive` 等工具类可用）。
- **Primary 仍为 `#6C5CE7`**（浏览器实测 `--primary: #6c5ce7`）；**仍为 Light only**（未新增 `.dark` 块、未新增 `@custom-variant dark`）。
- **Preflight 仍未启用**（浏览器注入探针实测 `h2` = 24px UA 默认值）。

## 7. 是否修改业务 / API / Router / Store / ViewModel / SSE

**全部为「否」**：业务 View（≤9月14日）、Router（9月11日）、API 7 模块、7 个 Store、8 个 ViewModel、SSE 三处通道、`App.vue`、`AppShell/AppSidebar/AppHeader`、`styles.css` 全部未改动；未新增菜单/页面/路由/数据。

## 8. typecheck / lint / test / build

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `corepack pnpm --filter @ai-se/web typecheck` | **PASS**（exit 0） |
| lint | `corepack pnpm --filter @ai-se/web lint` | **PASS**（exit 0） |
| test | `corepack pnpm --filter @ai-se/web test` | **PASS**：15 files / 53 tests |
| build | `corepack pnpm --filter @ai-se/web build` | **PASS**（`index-_jlxA5tD.css` 17.01 kB / `index-DDf1mu48.js` 277.46 kB） |

附加：`pnpm install --frozen-lockfile` 干净通过（见下）。

### 过程中修复的两个问题（均为基础设施必需，非业务改动）

1. **TypeScript 6 拒绝 `baseUrl`**：初次加别名时写入 `baseUrl: "."`，`vue-tsc` 报 `TS5101: Option 'baseUrl' is deprecated and will stop functioning in TypeScript 7.0` ⇒ 移除 `baseUrl`，只保留 `paths`（TS 5+/6 支持 `paths` 独立使用，按 tsconfig 所在目录解析）。修复后 typecheck 0 错误。
2. **pnpm 自动写入非法占位符**：安装 reka-ui 时 pnpm 检测到传递依赖 `vue-demi@0.14.10` 有构建脚本被策略忽略，在 `pnpm-workspace.yaml` 的 `allowBuilds` 中自动写入字面量 `vue-demi: set this to true or false`（不是布尔值），导致此后**每次 `pnpm install` 都报 `ERR_PNPM_IGNORED_BUILDS`**（含 CI）。核对后确认：该 postinstall 只做「按 Vue 版本切换 lib 入口」，而本仓库为 Vue 3、该包随包发布的 `lib/index.{mjs,cjs,d.ts}` **本身已是 v3 版本**（`isVue3 = true`），因此**无需执行**⇒ 显式置为 `vue-demi: false` 并加注原因。修复后 `pnpm install --frozen-lockfile` 输出 `Lockfile is up to date … Done`，零错误。

## 9. 浏览器验证

真实浏览器 + 构建产物（`vite preview` :5173 = 后端 `CORS_ORIGIN`，走真实 API）：

### 9.1 八条一级路由

| 路由 | 挂载 | 侧栏 | Header | Main 内距 | 菜单 | active | h1 | 错误态 | 横向溢出 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/` | ✓ | 164 | 52 | 20px | 8 | 仪表盘 | 仪表盘 | 无 | 0 |
| `/projects` | ✓ | 164 | 52 | 20px | 8 | 项目 | 项目 | 无 | 0 |
| `/requirements` | ✓ | 164 | 52 | 20px | 8 | 需求 | 需求 | 无 | ≤0 |
| `/workflows` | ✓ | 164 | 52 | 20px | 8 | 工作流 | 工作流 | 无 | ≤0 |
| `/deployments` | ✓ | 164 | 52 | 20px | 8 | 部署 | 部署 | 无 | ≤0 |
| `/agents` | ✓ | 164 | 52 | 20px | 8 | Agent | 专业 Agent | 无 | ≤0 |
| `/agent-run` | ✓ | 164 | 52 | 20px | 8 | Agent 运行 | Agent 运行 | 无 | ≤0 |
| `/mcp` | ✓ | 164 | 52 | 20px | 8 | MCP 服务器 | MCP 服务器 | 无 | 0 |

### 9.2 基础设施与 Token（运行时实测）

| 检查项 | 实测 |
| --- | --- |
| Tailwind 正常 | 侧栏 active 药丸底色 `rgb(240,237,255)`= `--primary-light`、文字 `rgb(108,92,231)`= `--primary`（工具类仍生效） |
| Token 层正常 | `--primary` = `#6c5ce7`、`--background` = `#f6f7fb` |
| **新增 shadcn 别名可用** | `--popover` = `#fff`、`--secondary` = `#f8f9fc`、`--accent` = `#f8f9fc`、`--destructive` = `#dc2626` 全部在浏览器中解析成功 |
| Preflight 仍未启用 | 注入探针 `h2` = 24px（UA 默认） |
| 业务页面未变（`/projects` 抽样） | `.page-header` + h1「项目」、双栏 grid `692px 360px`、项目行 1 条（Mini Todo）、创建表单与「创建」/「删除」按钮均在 |

### 9.3 基础设施的**功能**验证（临时探针测试，运行后已删除）

用一个临时 vitest 探针（`src/__tests__/infra-probe.test.ts`，跑完即删，未留痕）证明：

- `import { cn } from "@/components/ui/utils"` **在 vitest 下可解析**（`@/` 别名生效）；
- `cn("px-2 py-1", "px-4")` → `"py-1 px-4"`（tailwind-merge 冲突消解正确）、条件类名/对象写法均正确；
- `cva()` 变体默认值与覆盖均正确；
- `import { DialogRoot, Primitive } from "reka-ui"` 成功 ⇒ **reka-ui 及其 `vue-demi` 链路可用**（也反证 §8 第 2 项"跳过构建脚本无副作用"）。

探针结果：`Test Files 16 passed / Tests 56 passed`；删除探针后复跑为基线 **15 files / 53 tests**。

## 10. 结论

**PASS**

shadcn-vue 基础设施已就绪：`components.json`（schema 必填项齐备）、`cn()`（`@/components/ui/utils`，含 clsx + tailwind-merge）、`reka-ui`/`clsx`/`tailwind-merge`/`class-variance-authority` 四个基础依赖、`@/` 别名（vite + tsconfig + vitest 三处一致）；Design Token **值零改动**且新增的只是指向既有 Token 的 shadcn 兼容别名；未生成任何具体组件；业务/API/Router/Store/ViewModel/SSE 与 `styles.css` 零改动；四项门禁全绿并已在真实浏览器验证 8 条路由与真实 API。

按阶段纪律**在此停止**，不自动进入 Phase 3-B。

### 已知留给 Phase 3-B 的前置事项（记录）

1. `tw-animate-css` 未安装（不在本阶段技术清单内）；若 3-B 生成的组件含动画（Dialog/Drawer/Accordion 等），需补装并在 `app.css` 引入。
2. 若 3-B 使用 `shadcn-vue` CLI 生成组件：其 `init` 流程可能写入自己的中性调色板与 base 样式，**必须确认不覆盖现有 AI-SE Token 与不引入 Preflight**（Phase 0 决策 T7/T1）；CLI 生成的图标 import 包名也需统一映射到本项目已安装的 `@lucide/vue`。
3. 全局 `a { color: #1d4f91 }` 陷阱仍存在（见 `docs/64` §3.2），3-B 的组件契约中需明确链接类元素的处理方式。
