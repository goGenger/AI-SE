# 159 · 沙箱边界实施记录：写范围（PL-M5）与离线依赖 store（PL-M6）

> 日期：2026-10-16 ｜ 类型：**平台边界修复**（`docs/158` §3 的 PL-M5 / PL-M6；用户 2026-10-16「把沙箱能力修复好」授权）
> 依据：`docs/158`（任务书 + §1.6 基线事实 + §6 第 6 项裁定）、`docs/127` §5 #8、`docs/146` §3、`AGENTS.md` §9/§10。
> 范围：**只做 PL-M5 与 PL-M6**。**PL-M1 … PL-M4 未开工**（计划器实现覆盖校验 / 切片边界锚点 / 修复任务类型合法性 / 批次复验）。

## Modified Files

**`packages/shared`（判据上移）**
- `src/index.ts`：新增 `isTestFilePath(relPath): boolean`——**唯一**的「这是不是一个测试文件」判据（文件名匹配 `*.test.*` / `*.spec.*`，或路径含 `test` / `tests` / `__tests__` 段；排除 `node_modules` / `.git` / `dist` / `coverage` / `.next`）。
- `src/testFilePath.test.ts`（新增，19 条）：判据矩阵 + Windows 分隔符。

**`packages/agent-core`（写权限）**
- `src/professional/AgentRegistry.ts`：`AgentPermissions` 新增**可选** `writeTestFiles?: boolean`；**仅** `qa-agent` 置 `true`。
- `src/professional/ToolRuntimeBackend.ts`：
  - 新增私有 `writeAllowed(relative)`——白名单前缀 **或**（`writeTestFiles` 且 `isTestFilePath`）；
  - 新增模块级 `describeWriteScope(permissions)`——把生效的写范围写进拒绝信息；
  - 新增私有 `denyWrite(toolName, relative)`——**拒绝留痕**：走与 `executeTool` 同一条通道（`onToolEvent` + `toolCallRecorder` + push 进 `results`）；
  - `write()` / `edit()` 的拒绝分支改走上述两者。
- `src/professional/AgentRegistry.test.ts`（+1 条）：只有 qa-agent 声明 `writeTestFiles`。
- `src/professional/ToolRuntimeBackend.test.ts`（重写，6 条）：QA 可写任意位置的测试文件 / 非测试文件仍被拒 / 未声明者行为不变 / 拒绝留痕。
- `src/__tests__/frontendTask.e2e.test.ts`（改 1 处断言）：原断言「被拒的写入不产生 Tool Call 记录」与 PL-M5 的设计**直接冲突**，改为「**没有任何一次写入成功执行**」+ 磁盘未变（原意图保留）。

**`apps/server`（消费共享判据）**
- `src/services/taskVerifierRules.ts`：`isProtectedTestPath` 改为**委托** `@ai-se/shared` 的 `isTestFilePath`，删除本地重复实现与随之无用的 `EXCLUDED_SEGMENTS` / `TEST_FILE_PATTERN`。

**`packages/sandbox`（离线依赖）**
- `Dockerfile`：新增 `ARG PREWARM_PACKAGES`（默认 `lodash@4.18.1 express@5.3.0 zod@4.6.7 vitest@5.0.5`）；`pnpm config set --global store-dir /opt/pnpm-store` + `pnpm store add $PREWARM_PACKAGES`。
- `package.json`：`build:image` 透传 `PREWARM_PACKAGES`（未设置时不加 `--build-arg`，走 Dockerfile 默认）。
- `src/__tests__/sandboxPnpm.e2e.test.ts`：原用例 (c)「带第三方依赖离线安装**失败**」**翻转为通过**（改名 (c) 正向），并新增 (d) 反向——预热清单**外**的依赖仍失败。

**文档**：本文件；`docs/158`（§9 记录实施）、`docs/146` §3、`docs/127` §5 #8。

## Implementation

### PL-M5 沙箱写范围

**问题不是错误信息，是白名单本身。** QA agent 的 `writePaths = ["test","tests","__tests__"]`，而 `allowed()` 是**相对仓库根的前缀匹配**（`ToolRuntimeBackend.ts:62-72`）——`src/__tests__/x.test.ts` 不在任何前缀下。可**本仓库自己的规范**就是测试放 `apps/web/src/__tests__/`、`packages/*/src/__tests__/`（`AGENTS.md` §5/§6）。平台交付不出按它自己规范布局的项目。

三处改动：

1. **判据上移而非复制**。`isTestFilePath` 的语义与 `apps/server` 既有的 `isProtectedTestPath`（防篡改用）**完全相同**。两份定义必然漂移，而漂移正是这类缺陷的成因，故上移到 `packages/shared`，`apps/server` 改为消费它。既有的 20 条 `taskVerifierRules` 用例原样通过——它们现在同时充当**行为等价性验证**。
2. **一条语义化放行条件**。`writeAllowed = 白名单前缀 || (writeTestFiles && isTestFilePath)`。**没有放宽任何 `writePaths` 数组**，也**没有**改成「可写任意路径」——QA 写 `src/server.ts`、`probe.txt` 仍被拒（有用例）。
3. **拒绝可发现 + 可审计**。原样返回裸 `Path is not writable`，且拒绝发生在调用 Tool Runtime **之前**，`tool_calls` 表一条都不留。现在：信息带上生效范围（`(allowed: test/, tests/, __tests__/, and test files anywhere …)`），并补记一条 failed 工具调用。

**这不是新缺陷，是复发三次的旧缺陷**：`docs/115`（阶段 B）「发现 2：`Path is not writable` = 写权限模型 + 计划分派错位」；`docs/129`（阶段 F）「`tool_calls` 表仅 2 行——**权限拒绝发生在 deepagents FS 中间件层，不落表**」，agent 最终 `submit_result("Blocked: … every filesystem tool call is denied")`；`docs/155` M4 的 run 2 同形。本项修的是后两次记录里的同一件事。

### PL-M6 沙箱离线依赖 store

**关键事实**（`docs/158` §1.6）：agent 与**验证门**都在沙箱内跑测试，沙箱 `network: "none"` 且无 store；而**交付链的 CI 在宿主机 spawn、有宿主网络**。所以缺的不是「整条链不能装依赖」，而是 **agent 与验证门不能**。

修法沿用 `docs/127` 已定的方向「**镜像预置离线 store + 默认断网**」：构建期**有网**，把清单内的包灌进 store；运行期仍 `network: none`。**不改** `DEFAULT_LIMITS.network`，**不引入**运行期 registry 代理。

## Architecture Changes

- 「什么是测试文件」从 `apps/server` 的一个私有函数升格为 `packages/shared` 的**跨包判据**，由防篡改与写权限两处消费。
- `AgentPermissions` 新增一个**可选**字段；**缺省即现状**，非 QA 的 agent 行为逐项不变。
- 沙箱镜像从「只有 pnpm 二进制」变为「pnpm 二进制 + 预热 store」。**沙箱的默认网络、权限模型、错误码体系均未改动。**

## Dependencies

无新增（含 devDependencies）。镜像内的 `PREWARM_PACKAGES` 是**镜像内容**，不是仓库依赖。

## Tests

| 范围 | 结果 |
| --- | --- |
| `@ai-se/shared` test | **81/81 通过（8 文件）**（改动前 62，+19） |
| `@ai-se/agent-core` test | **165/165 通过（29 文件）**（改动前 164，+1） |
| `@ai-se/sandbox` test（真 Docker） | **8/8 通过（2 文件）**（改动前 7，+1） |
| `apps/server` 定向 `taskVerifierRules.test.ts` | **20/20 通过** |
| `apps/server` 全量 | **265/266**（50 文件）——一条失败见下 |
| 全仓 `corepack pnpm -r run typecheck` | **通过** |
| 全仓 `corepack pnpm -r run lint` | **通过** |
| 全仓 `corepack pnpm -r run test` | 15 个包全绿；`apps/server` **265/266**——失败的又是 `v1GoldenScenario.e2e.test.ts` 的「server restart」用例 |

**那条失败是既有抖动，不是本阶段引入**：同一文件、**同一用例**在 `docs/149` 的 M1 全量运行、`docs/155` 的两次全量运行中已以同样方式出现过，**单独复跑 4/4 通过**（本次实测）。属 `docs/145` #7 / `docs/146` §5 已登记的负载敏感抖动。**未修，如实记录。**

**一处刻意的断言反转**：`frontendTask.e2e.test.ts:283` 原本断言「被拒的写入**不**出现在 `toolResults`」——这正是 PL-M5 要改掉的行为。改后钉住的是**原意图**：「没有任何一次写入成功执行」+ 磁盘未变。

## Lint

`shared` / `agent-core` / `server` / `sandbox` 的 `lint` 均退出码 0；全仓 `-r run lint` 通过。

## Typecheck

四个改动包的 `typecheck` 均退出码 0；全仓 `-r run typecheck` 通过（该命令会重建相关包的 `dist`，构建产物未读取）。

## E2E

**PL-M5**：`ToolRuntimeBackend.test.ts` 用**沙箱桩**区分两条路径——权限门放行则调用到达沙箱（计数器 +1），拒绝则根本不碰沙箱。QA 对 `src/__tests__/todo.test.ts` / `apps/web/src/__tests__/view.test.ts` / `test/z.test.js` / `tests/helpers/util.mjs` 四条全部到达沙箱；对 `src/server.ts` / `probe.txt` / `src/helpers/util.ts` 三条全部被拒且沙箱零调用。`reviewer-agent` 对同一测试路径仍被拒（反向对照，证明是 `writeTestFiles` 在起作用）。

**PL-M6**（真 Docker，`network: none` 默认）：
- **正向**：`lodash@4.18.1` 夹具 `pnpm install --frozen-lockfile` **exit 0**，输出 `downloaded 0` / `reused 1`，`node_modules/lodash` 存在——包取自镜像内预热好的 store。
- **反向**：`chalk@5.3.0`（**不在**预热清单）离线安装**仍失败**，错误可定位为无网络/无法获取依赖——证明是 store 生效，**不是把网络打开了**。
- 镜像内实测：`pnpm store path` → `/opt/pnpm-store/v3`；构建日志逐条列出 `+ express@5.3.0 / + vitest@5.0.5 / + lodash@4.18.1 / + zod@4.6.7`。

## Known Issues

1. **预热清单是固定的白名单**：清单**外**的依赖仍装不上（这是刻意的边界，有用例钉住）。要支持新依赖需重建镜像（`PREWARM_PACKAGES=... pnpm --filter @ai-se/sandbox run build:image`）。**这不是「已支持任意第三方依赖」，如实对外。**
2. **评测面仍覆盖不到这条能力**：九个夹具全部零依赖（`docs/158` §1.6）。PL-M6 只有沙箱级验收，**没有任何夹具走完整交付链验证带依赖的项目**。新夹具另立项（`docs/158` §6 第 7 项，推荐另立阶段）。
3. **读取侧的拒绝仍不留痕**：本次只改了写入。`read()` / `grep()` 的权限拒绝同样在调用 Tool Runtime 之前返回（`ToolRuntimeBackend.ts:113-114`），同样不落 `tool_calls`。**未修**——超出 PL-M5 的范围，登记待办。当前各 agent 的 `readPaths` 都是 `["."]`，实际不易触发。
4. **`writeTestFiles` 是命名/目录判定**：项目若把测试放在非常规位置（既非 `*.test.*` / `*.spec.*` 命名，也不在 `test`/`tests`/`__tests__` 目录下），仍写不进去。当前无此需求。
5. **镜像变大**：预热 `vitest` 会拉入 esbuild 等较大依赖。清单是显式声明、可覆盖的，代价已知。
6. **门禁抖动的既有口径不变**（`docs/146` §5）：全仓单次 `-r test` 可能出现时序敏感偶发失败；如实记录，不修不掩盖。
7. **未做（红线）**：未放宽任何 `writePaths` 数组；未把沙箱默认网络改成 `bridge`；未新增第二套 Permission / Audit / 错误码体系（拒绝复用 `TOOL_ERROR`）。

## Acceptance Result

| 里程碑（`docs/158` §3） | 判定 | 证据 |
| --- | --- | --- |
| **PL-M5** QA 能写项目实际放测试的地方 | **达成** | 真沙箱桩用例：`src/__tests__/…`、`apps/web/src/__tests__/…`、`test/…`、`tests/…` 四条全部到达沙箱 |
| **PL-M5** 非测试文件仍被拒（不放宽白名单） | **达成** | 三条非测试路径全部被拒、沙箱零调用；`writePaths` 数组未改 |
| **PL-M5** 拒绝可发现、可审计 | **达成** | 拒绝信息含生效范围；`results` 与 `tool_calls` 各多一条 failed 记录 |
| **PL-M5** 未声明 `writeTestFiles` 的 agent 行为不变 | **达成** | `reviewer-agent` 对同一路径仍被拒；`AgentRegistry.test.ts` 逐名断言 |
| **PL-M6** 预热清单内的依赖离线可装 | **达成** | 真 Docker + `network: none`：`lodash@4.18.1` exit 0，`downloaded 0` |
| **PL-M6** 清单外的依赖仍失败（边界未破） | **达成** | `chalk@5.3.0` 离线 exit≠0，错误可定位为无网络 |
| **PL-M6** 沙箱默认网络不变 | **达成** | `DEFAULT_LIMITS.network` 未改；验收在 `network: none` 下通过 |

**阶段判定：PL-M5 与 PL-M6 全部达成。** `docs/158` 的 PL-M1 … PL-M4 **未开工**。

## Next Phase Boundary

**本子阶段结束（STOP）。未开始事项**：

- **PL-M1 计划期实现覆盖校验**（核心）——`docs/158` §3；**这是 E1×3 三次 staging 段全否的根因**，仍未修。
- **PL-M2 切片边界绿灯锚点**、**PL-M3 修复任务类型合法性**——未开工。
- **PL-M4 批次复验**（E1×3）——未开工；**需先确认周配额余量**（M4 实测单批约 6.7M 输入 token）。
- **带第三方依赖的评测夹具**——`docs/158` §6 第 7 项，推荐另立阶段；**在此之前，PL-M6 的能力没有交付链级别的验证**。
- **读取侧拒绝留痕**（本文件 Known Issue 3）——未修。
- **`docs/158` §6 第 1 / 3 / 4 / 5 / 6 / 7 项**仍待裁定（第 2 项已落地为 PL-M5，第 6 项已按推荐值实施）。

**需要你回答**：是否现在开工 PL-M1（计划器根因）。它是 `docs/158` 里唯一直接决定 E1×3 能否跑到 staging 段的一项。

---

# 后续块：Known Issue 3（读取侧拒绝留痕）已修复（2026-10-16 追加）

> **本块是 2026-10-16 追加，不改动上文任何一行。** 上文「读取侧拒绝留痕——未修」等表述**以本块为准**。

- 用户同日质询「不应该是先把存在缺陷的地方都修复好了再跑任务验证测试吗」，并授权「先清掉这几条，再跑 PL-M4」（范围裁定 1+2+3）。**本文件 Known Issue 3 是其中第 1 条**，已作为 **PL-C1** 实施完成。
- 做法：`ToolRuntimeBackend` 的 `denyWrite` 抽出 `recordDeniedCall(toolName, relative, reason)`，读侧新增 `denyRead` 与 `describeReadScope`；`ls` / `read` / `grep` 的读权限拒绝改为**留痕**（`readRaw` 委托 `read`，自动覆盖）。复用同一条记录通道与 `TOOL_ERROR`，**不新增错误码**。拒绝信息含**生效的读范围**，与写侧对称。
- 本文件 Known Issue 3 同时指出「当前各 agent 的 `readPaths` 都是 `["."]`，实际不易触发」——**这一点仍然成立**（`devops-agent` 除外），本项的价值是**对称性与可审计性**，不是修复一个高频故障。
- 实施记录 **`docs/163`**（任务书 `docs/162`）。
