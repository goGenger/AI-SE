# AI-SE 项目开发约束（AGENTS.md）

本文件描述的是**仓库实际状态**（as-built）。所有规则以现有代码为准；当本文件与实际代码冲突时，代码优先，并须报告冲突而不是默默对齐。

---

## 1. 环境约束

- Node >= 22.12，以 `.nvmrc`（22.22.2）为准；默认系统 node（16）以旧，必须先切换。
- 统一使用 `corepack pnpm`（12.3.4）；系统 pnpm（7.5.0）太旧，禁止使用。
- 所有命令从仓库根目录 `/Users/shixianbao/Desktop/study/AI_SE` 执行。
- 该目录**没有 git**：变更核对以文件清单为准，禁止依赖 `git status` / `git diff`。
- 构建产物只存在于各包 `dist/`（已被 .gitignore 忽略）。禁止读取或"修复" `dist/` 内文件；上游实现的权威参考是各包 `src/` 与已安装依赖的 `.d.ts`。

## 2. 顶层目录规则

| 目录 | 用途 |
| --- | --- |
| `apps/` | 可运行应用（`server`、`web`） |
| `packages/` | 可复用能力（workspace 包） |
| `docs/` | 设计文档与阶段报告，编号命名 `NN-<主题>.md` |
| `examples/` | 示例项目，**不在 pnpm workspace 内**，禁止从中导入 workspace 包做测试 |
| `infrastructure/` | 部署与基础设施（Docker 等） |

- 未经明确批准禁止新增顶层目录。
- 未经明确要求禁止移动既有文件、禁止无关重构；优先满足需求的最小改动。

## 3. 包规则

- 包之间禁止循环依赖；包禁止导入 `apps/` 下的任何内容。
- 新建包前必须先确认已有包不能复用；非必要不新建包。
- 新建 workspace 包时镜像 `packages/tool-runtime/{package.json,tsconfig.json}` 的形态（**不加 `"type": "module"` 字段**），再执行 `corepack pnpm install --no-frozen-lockfile` 完成链接。`apps/web` 是唯一的例外（vite/ESM 应用）。
- 代码内枚举、类型与实现同居于所属模块；**跨包共享的类型/契约放 `packages/shared`**。禁止创建全局性的 `types/`、`utils/`、`constants/` 目录。

## 4. 后端（apps/server）结构

```
apps/server/src/
  index.ts        # 组合根：构造并注入全部服务
  app.ts          # Express 应用装配
  config.ts
  http/           # 错误映射、请求日志、统一响应
  routes/         # HTTP 路由（按资源一个文件）
  services/       # 业务服务（业务逻辑集中于此）
```

- server 内 **不再使用 `repositories/`**：数据访问已全部下沉到 `packages/database`（`index.ts` 全部从 `@ai-se/database` 导入 Pg* 存储）。禁止在 `apps/server/src/` 下重新建立 `repositories/` 目录或仓储实现（2026-10-15 核对：该目录已不存在）。
- 新增 HTTP 能力：`routes/<资源>.ts` + `services/<资源>Service.ts`，并把服务构造加入 `index.ts` 组合根。
- server 测试统一放 `src/__tests__/`，API 级测试以 `*.e2e.test.ts` 命名端到端用例。

## 5. 前端（apps/web）结构

```
apps/web/src/
  main.ts · App.vue · router/index.ts
  api/            # 后端 REST 客户端，按资源一文件（fetch 封装）
  stores/         # Pinia store，按资源一文件，与 api 层对接
  views/          # 页面级组件（*.vue），一页一文件
  viewmodels/     # 展示逻辑层（*ViewModel.ts 与 mcpAppBridge 等纯逻辑，被 views/ 消费，可独立测试）
  components/     # 跨页面复用的 UI 组件（已建立）
  composables/    # Vue 组合式函数，use* 命名（已建立）
  types/          # （规划中，逐步建立）前端共享类型
  constants/      # （规划中，逐步建立）前端共享常量
  __tests__/      # 单元测试目录（src 根与各子目录均可放置 __tests__）
  styles/         # 样式：app.css 为入口（main.ts 引入），README.md 为样式规范
```

- **`types/` 与 `constants/` 仍是目标结构，尚未建立**；`components/` 与 `composables/` 已建立。后续迭代应逐步把内容归位到这些目录。在 `types/`、`constants/` 建立之前，禁止因"目录不存在"而在别处另立名目（如 `shared/`、`lib/`、`helpers/` 等同名变体）。
- **测试规则：所有测试文件统一放 `__tests__/` 目录**（源码同级或就近子目录均可），禁止再新增"测试与源码同目录"的文件；历史遗留的旁挂测试已一次性迁移完成，迁移后不允许"回填"到源码目录。
- **组件分层**：页面 `views/` 内单文件实现，配合 `viewmodels/` 的 `*ViewModel.ts`（可测的纯逻辑层）+ `stores/`（Pinia 状态）+ `api/`（网络层）。可测试的业务判断一律放进 ViewModel 或 store，不在 `.vue` 内堆积可测逻辑；新的展示逻辑文件放 `viewmodels/`，不再散落在 src 根目录（例外：`main.ts`、`App.vue`、`vite-env.d.ts`、`styles/` 为入口/约定文件，固定在 src 根）。
- **新内容必须放到规划中的对应位置，而不是再塞进 views/ 或根目录**：
  - 两个及以上页面复用的 UI 片段 → `components/`（组件文件用多词 PascalCase 命名）。
  - 跨组件复用的响应式逻辑 → `composables/`（`useXxx.ts` 命名）。
  - 被 2 处以上引用的前端类型 → `types/`；仅单个模块使用的类型继续 co-located。跨包类型仍只能来自 `@ai-se/shared`。
  - 魔法值、路由名、存储 key 等被 2 处以上引用的常量 → `constants/`。
  - 首次引入文件时即可建目录（`src/components/xxx.vue` 本身就创建了目录，无需单独批准——已获批准的是这份目录规划本身）。
- **测试与源码同目录已废止**：本节以上条款明确了新规则——测试必须迁移到 `__tests__/`（src 根或各子目录下均可），新测试一律放 `__tests__/`，不允许回填到源码目录。
- 修改任何 `api/`、`stores/`、ViewModel、`components/`、`composables/`，其对应测试（位于 `__tests__/`）须同步维护。

## 6. packages 内部结构（按既有惯例）

- 集中式测试的包（`mcp`、`tool-runtime`、`sandbox`、`agent-core`）：测试放 `src/__tests__/`。
- **同目录混放的包（`database`、`workflow-engine`、`shared`、`observability`、server 的 config）**：`*.test.ts` 放源码旁；`apps/web` 是唯一例外，测试必须统一迁入 `__tests__/`。
- **新文件跟随所在包的既存惯例**（web 例外：一律 `__tests__/`），禁止把一种惯例搬到另一种包里。
- `mcp` 包固定分层：`contracts.ts`（冻结契约）、`errors.ts`、`client/`（官方 SDK 封装）、`integration/`（工具/能力适配）、`registry/`（store 持久化）、`testing/`（fake 能力 fixture）、`security/`。
- `agent-core` 大包按域分子目录：`agent/`（核心运行时）、`llm/`（Provider 抽象与实现）、`planning/`（规划图与提示词，prompts/ 一域一文件）、`professional/`（职业 Agent 与注册）、`coding/`、`graph/`、`workflow/`。

## 7. 测试规则

- 新增业务逻辑必须带测试；核心链路（真实连接、真实协议、真实迁移）需真实验证，不允许全 mock 代替。
- 跨包的依赖型测试依赖消费方构建出的 `dist/`：把 `pnpm --filter <依赖包> build` 链入消费方的 build/typecheck 脚本。
- DB 测试统一复用 `packages/database/src/testPostgresContainer.ts`（postgres:16-alpine + 随机端口 + runMigrations）。
- 新增 SQL 迁移：遵循仓库风格（`CREATE TABLE IF NOT EXISTS`、`gen_random_uuid()`、每表一个 `set_updated_at()` 触发器、唯一键用 `NULLS NOT DISTINCT`、PG16），并扩展 `migrate.test.ts` 的文件清单断言。
- 修改共享 fixture（如 `mcp/src/testing/fake-capabilities.js`）前，先全树 grep 依赖它的精确断言（固定列表、`length).toBe(N)` 类逐字段比对），同一提交内同步更新，否则失败会被误读为回归。
- 安全类"源码扫描"测试只扫生产文件（排除 `*.test.ts`），禁词不得出现在生产注释中——调整注释措辞，不弱化扫描。
- 每完成一个包的改动跑：`corepack pnpm --filter @ai-se/<pkg> typecheck && lint && test`；每个阶段收尾前跑全仓 `corepack pnpm -r run typecheck && lint && test`。

## 8. TypeScript 与代码风格

- 严格模式由根 `tsconfig.base.json` + eslint 统一执行（`no-explicit-any: error` 已硬性生效），不再重复约束内容。
- 类型未定则用 `unknown` 收窄，不允许 any；共享类型放 `packages/shared`，模块内类型同居。
- Prettier：`printWidth 100`、双引号、`trailingComma: none`（见 `.prettierrc.json`）。

## 9. 阶段纪律（最高优先级）

- 一次任务**只做一个已命名的阶段/子阶段，做完即停**；禁止自动推进下一阶段、禁止顺手完善相邻功能。收尾报告须写明"未开始事项（STOP）"。
- 动手前：先读该任务点名的文档，再对照实际代码核实。**代码权威于文档**；文档与代码冲突必须报告，禁止默默修改任一方来"对齐"。
- 与冻结契约（如 `docs/25-mcp-contract-freeze.md`）冲突时：停下来报告 CONTRACT CONFLICT，禁止悄悄放宽或绕开契约。
- 每完成一个阶段：勾选 `docs/17-acceptance-checklist.md`、更新 `docs/15-development-roadmap.md` 与 `docs/18-phase-engineering-goals.md` 的进度、续写上一阶段契约文档的阶段边界表、产出 `docs/NN-phase-<name>.md` 实施记录与验收报告。
- **当前阶段**：Phase 8 AI SRE——**8-A→8-D 已收口并生效**（`docs/243`…`docs/246`；迁移 `020`–`022`；任务书 `docs/242`，设计 `docs/13`；开放项盘点 `docs/249`）。8-D：`INCIDENT_AUTO_REMEDIATE` **代码默认关**；本机 server **进程环境**可为 `true`（**.env 未写**）。**不是** Agents UI Phase 8（`docs/78`/`docs/79`）。**能力面默认**：`DEFAULT_CAPABILITY_PROFILE` / 缺省 `CAPABILITY_PROFILE` = **`frontend-vue`**（2026-11-04；产品不做后端；遗留 E1 须显式 `backend-node`）。F1 正式验收见 `docs/17` F1 节与 `packages/eval/results/f1-frontend/round20/`。**`docs/247` l1-rv1 已中止**（不做 E1 后端复验）。**下一步**：巩固前端主线（`frontend-vue` + F1）；Phase 8 仅余用户书面确认项（见 `docs/249`），不阻塞前端。

## 10. 架构不变量（禁止破坏）

- **Tool Runtime 是唯一执行路径**：Agent、MCP、MCP Apps 均不得绕过它执行能力。
- MCP 仅作为工具来源 / capability 适配（resources/prompts 走适配器），不是第二套 ToolDefinition 系统。
- 禁止第二套 Permission / Approval / Audit / Secret / 错误码体系；复用既有抽象（ToolResult、RuntimeErrorCode、audit）。
- Workflow 必须保持可恢复、可取消；授权验证必须证明"无过期授权"（测试中直接 SQL 改授权行，再断言调用 DENY）。
- 明文 credential / token 不得进入 Prompt、State、Task、Log、Result 或提交内容；敏感信息日志须走 `@ai-se/observability` 的 sanitize。
- 详细 MCP 工程规则见 `docs/16-vibe-coding-rules.md`（正本，本文不再复述其中清单）。

## 11. 完成报告

按 `docs/16-vibe-coding-rules.md` 的固定节顺序输出：Modified Files、Implementation、Architecture Changes、Dependencies、Tests、Lint、Typecheck、E2E、Known Issues、Acceptance Result、Next Phase Boundary（英文固定标题、中文正文）。独立报告落为 `docs/NN-<phase>-report.md`。
