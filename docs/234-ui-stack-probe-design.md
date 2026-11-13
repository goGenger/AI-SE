# 234 · React + TS + Tailwind 离线构建探针（实施设计）

> **文档性质**：实施设计，**不含实现**。按 `AGENTS.md` §9，本文定义探针要验什么、怎么装、怎么判、
> 失败读数各自意味着什么；实现另立命名阶段。
>
> **上游**：`docs/233`（前端专用夹具与浏览器验收）。本文只做**最小可行性探针**，不建夹具、不建门。

---

## 1. 探针要回答的三个问题

| # | 问题 | 为什么必须先答 |
| --- | --- | --- |
| Q1 | 在**断网**沙箱里能否装齐 React + TS + Tailwind 的依赖闭包？ | 装不上则整条前端路线不成立 |
| Q2 | 在 `cpus=1 / memory=512m / pids=128` 下能否构建出一个 Vite 产物？ | 资源不够会让「能装」变成「装完也构建不出」 |
| Q3 | 浏览器断言能否在**同一个沙箱容器里**完成（构建 → 预览 → 断言）？ | `uiSmoke` 与前端 oracle 都依赖这条路径 |

三个问题都能用一条命令答完；答完就有资格决定是否投入 `docs/233` 的夹具与门。

---

## 2. 现状（探针的起点，已核对）

| 事实 | 位置 |
| --- | --- |
| 沙箱**默认断网** | `packages/sandbox/src/index.ts:54` `network: "none"`；`apps/server/src/index.ts:176` 未覆盖 |
| 资源默认 `cpus 1 / 512m / pids 128 / timeout 30s` | `packages/sandbox/src/index.ts:47-53` |
| 镜像**构建期有网、运行期无网** | `packages/sandbox/Dockerfile` 注释（PL-M6 裁定） |
| 预热机制已存在：`pnpm store add ${PREWARM_PACKAGES}` | `packages/sandbox/Dockerfile`，当前清单 `lodash express zod vitest` |
| 镜像内 pnpm **9.15.0**（非仓库的 12.3.4） | `packages/sandbox/Dockerfile` `ARG PNPM_VERSION=9.15.0` |
| 仓库已用 Tailwind 4.3.3 / Vite 8.2.2 | `apps/web/package.json:27,31,32` |
| 现有前端链路是**零依赖** JS | `examples/frontend-task-test-project`（`node scripts/build.mjs`） |

**结论**：Q1 的机制已经存在，探针要做的是**把 React 闭包加进预热清单并验证版本严格对齐**；真正的未知
是 Q2 与 Q3。

---

## 3. 探针工程（seed）

```
packages/sandbox/probes/ui-stack/        # 镜像构建上下文内的资产（不是 workspace 包，不进 pnpm workspace）
  package.json
  pnpm-lock.yaml                         # 由 pnpm 9.15.0 生成（见 §4）
  index.html
  src/main.tsx
  src/App.tsx
  vite.config.ts
  tsconfig.json
  probe.mjs                              # 一条命令完成 构建→预览→断言（§6）
```

**固定版本（探针口径，不追求最新）**

| 包 | 版本 | 依据 |
| --- | --- | --- |
| `react` / `react-dom` | 19.x **精确钉死** | 仓库无 React，需新选；钉死才能预热门控 |
| `vite` | **8.2.2** | 与 `apps/web` 一致 |
| `@vitejs/plugin-react` | 与 Vite 8 兼容的版本，随 lockfile 解析 | 不在设计里手写，避免猜 |
| `typescript` | 仓库当前主版本 | 与 `tsconfig.base.json` 对齐 |
| `tailwindcss` / `@tailwindcss/vite` | **4.3.3** | 与 `apps/web` 一致 |
| `playwright` | **1.61.0** | 与 `packages/browser` 一致 |

**App.tsx（断言靶子）**：一个 `<h1 data-testid="probe-title">` 加一个**计算结果无歧义**的 Tailwind 类：
`text-[#123456]`（→ `rgb(18, 52, 86)`）与 `p-4`（→ `padding: 16px`）。**只断言类名存在是不够的**——
类名在 HTML 里不代表 CSS 真的生成并生效。

**为什么 lockfile 必须由 pnpm 9.15.0 生成**：镜像内是 9.15.0。若用仓库的 pnpm 12 生成，
`lockfileVersion` 可能不一致，运行期会退化成「重新解析」而失败。生成方式见 §4 第 1 步。

---

## 4. 镜像设计

新 tag：`ai-se-sandbox:22-pnpm9-ui`。**不修改默认**（`SANDBOX_IMAGE` 仍指向旧 tag），探针通过后再议切换。

**两阶段构建**（上下文 = `packages/sandbox`）：

```dockerfile
# stage 1：按 seed 的 lockfile 精确预热 store（同时产出 playwright 可执行文件）
FROM node:22-bookworm AS warm
ARG PNPM_VERSION=9.15.0
ENV PNPM_STORE_DIR=/opt/pnpm-store
RUN npm install --global pnpm@${PNPM_VERSION}
COPY probes/ui-stack/ /seed/
RUN cd /seed && pnpm install --frozen-lockfile

# stage 2：运行镜像
FROM node:22-bookworm
ARG PNPM_VERSION=9.15.0
ENV PNPM_STORE_DIR=/opt/pnpm-store
RUN npm install --global pnpm@${PNPM_VERSION} \
 && pnpm config set --global store-dir "${PNPM_STORE_DIR}"
COPY --from=warm /opt/pnpm-store /opt/pnpm-store
# 可选（Q3）：浏览器。playwright 包**没有 postinstall**，浏览器只能显式安装。
ARG WITH_BROWSER=0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
COPY --from=warm /seed /seed
RUN if [ "$WITH_BROWSER" = "1" ]; then \
      cd /seed && pnpm exec playwright install --with-deps chromium && rm -rf /seed ; \
    else rm -rf /seed ; fi
```

要点：

- **不用 `pnpm store add <手写清单>`**，而是「按 lockfile 安装」——手写清单会漏传递依赖，且版本可能与
  lockfile 不一致（这正是 `ENOTCACHED` 的成因）。
- `WITH_BROWSER=0` 先答 Q1/Q2，`=1` 再答 Q3。两阶段分开，避免浏览器问题污染依赖问题。
- 浏览器路径固定 `/opt/ms-playwright`，运行期只读。

**预期代价**（要实测记录，不是估算）：镜像体积增量、store 目录大小、构建时长。

---

## 5. 探针命令（在沙箱容器内执行）

一条命令完成全部步骤（沙箱每条命令是**新容器**，所以构建、预览、断言必须同一条命令内）：

```sh
cd /workspace && \
pnpm install --offline --frozen-lockfile && \
pnpm build && \
node probe.mjs
```

`probe.mjs` 内部：

1. 起 `pnpm preview --port $PORT --strictPort`（`PORT` 由探针注入，避开占用）；
2. TCP 轮询直到端口可达（≤60s），再 `fetch` 首页确认 200；
3. 启动 chromium（`--no-sandbox`、`--disable-dev-shm-usage`）；
4. 导航到 `/`，断言：
   - `[data-testid="probe-title"]` 可见且文本非空；
   - `getComputedStyle(h1).color === "rgb(18, 52, 86)"`（Tailwind 真的生效）；
   - `getComputedStyle(h1).paddingTop === "16px"`；
   - 控制台 error 数为 0（排除 404 favicon）；
5. 截图到临时目录（不写工作区），把路径放进输出；
6. 按**进程组**杀 preview，输出 JSON：

```json
{"ok":true,"steps":{"install":0,"build":0,"preview":0,"assert":0},
 "readings":{"installMs":0,"buildMs":0,"previewMs":0,"distBytes":0},
 "detail":{"color":"rgb(18, 52, 86)","padding":"16px","consoleErrors":0}}
```

**为什么不用三个独立命令**：N-49 的既有教义——沙箱每条命令是新容器，进程与文件状态不跨命令保留；
把构建、预览、断言放进同一条命令是唯一可行的形态（`serverSmoke.ts` 同一范式）。

---

## 6. 断言与判据

| 断言 | 判据 | 失败含义 |
| --- | --- | --- |
| A1 离线安装 | `pnpm install --offline --frozen-lockfile` 退出 0 | 预热清单/版本不匹配（`ENOTCACHED`） |
| A2 构建 | `pnpm build` 退出 0 且 `dist/index.html` 存在 | 资源不足或依赖缺失 |
| A3 预览可达 | 端口可达且首页 200（≤60s） | preview 启动方式或端口语义问题 |
| A4 Tailwind 生效 | 计算样式颜色/内边距精确匹配 | CSS 未生成或未注入（类名存在不算） |
| A5 控制台干净 | error 数 0 | 运行时错误（覆盖 UI 验收的基本前提） |
| A6 读数 | 记录 install/build/preview 耗时、dist 体积、峰值内存 | 用于决定批次预算 |

---

## 7. 读前声明：预期失败模式与含义

| 症状 | 含义 | 下一步 |
| --- | --- | --- |
| `ERR_PNPM_ENOTCACHED` / `Cannot find package` | store 缺包或版本不一致 | 检查 lockfile 是否由 9.15.0 生成；确认两阶段构建的 COPY 路径 |
| `lockfileVersion` 不匹配警告 | 生成与运行 pnpm 版本不一致 | 重新在 9.15.0 容器内生成 lockfile |
| 构建中途 Killed / `JS heap out of memory` | `512m` 不够 | **记录最小可用内存**，据此提「per-command limits」，不要直接改全局默认 |
| `Failed to launch chromium` / `pids` 相关 | `pids=128` 不够或缺少系统库 | 记录所需值；`--with-deps` 是否装齐 |
| 预览端口超时 | `vite preview` 绑定地址/端口参数不对 | 检查 `--host 127.0.0.1 --port $PORT --strictPort` |
| A4 失败但 A2 通过 | Tailwind 配置未接入（`@tailwindcss/vite` 插件缺失） | 属探针工程问题，不是平台问题 |

**红线**：任何一步失败都**不得**通过放宽断言来「修好」——探针的价值就在这些读数。

---

## 8. 通过条件

- **P1（无浏览器）**：A1–A3 在默认限制（`cpus=1 / 512m / pids=128 / network=none`）下全部通过；
- **P2（有浏览器）**：A4–A5 通过；若默认限制下失败，则记录**最小可用限制**，标记为「条件通过」；
- 两次运行（P1 / P2）各产出 §5 的 JSON，读数记入本节表格；
- **不**改平台默认镜像、**不**改 `DEFAULT_LIMITS`（改动留到结论之后）。

**结论只允许三种**：可行（默认限制）/ 条件可行（需放宽 X）/ 不可行（并说明卡在哪一步）。

### 8.1 第 1 步读数（2026-10-27 实测，seed 落地）

环境：`node:22-bookworm`（node **22.23.2**）、pnpm **9.15.0**、linux/arm64。

| 项 | 读数 |
| --- | --- |
| `lockfileVersion` | **9.0** |
| 解析包数 | **89**（`packages:` 段 84 条） |
| `pnpm-lock.yaml` 大小 | 29,339 字节 |
| 关键版本（解析结果） | react / react-dom **19.3.1**、vite **8.2.2**、@vitejs/plugin-react **6.1.2**、tailwindcss / @tailwindcss/vite **4.3.3**、typescript **6.0.3**、playwright **1.61.0**、@types/react(-dom) **19.3.0** |
| `pnpm install --frozen-lockfile` | **3s** 完成；`node_modules` **134M** |
| `pnpm build`（`tsc --noEmit && vite build`） | **2s** 完成；`dist` **228K**（js 219.71 kB / gzip 68.68 kB；**css 4.29 kB / gzip 1.45 kB**） |

**两条设计修正（由实测得出）**：

1. `playwright@1.61.0` **没有 postinstall 脚本**（安装后 `scripts: {}`）⇒ 浏览器**不会**在 `pnpm install`
   时被下载；必须在镜像 stage 2 显式 `playwright install --with-deps chromium`。运行期离线安装也因此
   不会尝试联网下载浏览器。
2. stage 1 必须做**完整安装**（不是 `--lockfile-only`）：stage 2 需要 `/seed/node_modules/playwright` 才能
   执行 `playwright install`。用完即删 `/seed`，避免把 134M 的 node_modules 留在镜像里。

**边界**：以上读数都在**无沙箱资源限制**下取得（宿主 Docker，默认 CPU/内存）。`cpus=1 / 512m / pids=128`
下能否构建，是第 2 步 P1 要回答的问题，本节不预设结论。

### 8.2 第 2 步读数（2026-10-27 实测，P1：离线安装 → 构建 → 预览）

镜像：`ai-se-sandbox:22-pnpm9-ui`，**1.44GB**（默认镜像 1.17GB，+270MB，全部增量来自 React/Vite/Tailwind
依赖闭包的 store）。

运行参数（**与平台当前默认完全一致**）：

```
--network none --cpus 1 --memory 512m --pids-limit 128
--security-opt no-new-privileges --cap-drop ALL
```

| 断言 | 结果 | 读数 |
| --- | --- | --- |
| **A1** 离线安装 | **exit 0** | `pnpm install --offline --frozen-lockfile` **1,860ms** |
| **A2** 构建 | **exit 0** | `pnpm build` **3,058ms**；`dist` 228K |
| **A3** 预览可达 | **exit 0** | HTTP **200**，端口就绪 **853ms**；HTML 405B，含 `id="root"` 与 `type="module"` |
| 产物 | — | `node_modules` 148M；CSS 4.29 kB（Tailwind 已生成） |

**结论（P1）：可行。** 按 lockfile 预热的 store 足以在**断网 + 1 核 + 512MB** 下完成安装与构建，
`docs/234` §7 预判的三个失败模式（`ENOTCACHED` / OOM / 端口超时）**一个都没有出现**。

未验证：A4（Tailwind 计算样式）与 A5（控制台无错）需要浏览器，属第 3 步。

### 8.3 第 3 步读数（2026-10-27 实测，P2：浏览器断言）

镜像：`ai-se-sandbox:22-pnpm9-ui`（`WITH_BROWSER=1`），**2.72GB**——浏览器增量 **+1.28GB**
（无浏览器版 1.44GB，默认镜像 1.17GB）。

运行参数与 P1 **完全相同**（`--network none --cpus 1 --memory 512m --pids-limit 128`，
`--security-opt no-new-privileges --cap-drop ALL`）。

| 断言 | 结果 | 读数 |
| --- | --- | --- |
| A1 离线安装 | exit 0 | 2,989ms |
| A2 构建 | exit 0 | 3,410ms |
| A3 预览可达 | exit 0 | 200，端口就绪 871ms |
| **A4 Tailwind 生效** | **通过** | `color = rgb(18, 52, 86)`、`paddingTop = 16px`（**计算样式**，非类名） |
| **A5 控制台干净** | **通过** | `consoleErrors = 0`（favicon 噪声已排除） |
| 浏览器启动 | 通过 | chromium 启动 **730ms** |
| 资源 | **未触限** | 内存峰值 **367MiB / 512MiB（72%）**；`pids=128` 未触发限制 |

**结论（P2）：可行，默认限制即可，不需要放宽。** §7 预判的两个浏览器侧失败模式
（`pids=128` 不够、`512m` OOM）**都没有发生**；内存仍有余量（约 145MiB）。

**整体结论（`docs/234` §8 三选一）：可行。** 断网、1 核、512MB 的沙箱里，
React + TS + Tailwind 的「装 → 构建 → 预览 → 浏览器断言」全链路成立。

**代价旁注**：带浏览器的镜像 2.72GB。是否给**所有**切片边界检查都装浏览器，需要单独裁定——
`uiSmoke`（`docs/233` §5.2）只需要「页面起没起来 + testid 在不在 + 控制台干净」，可以复用同一镜像，
但镜像体积与构建时间要计入运维成本。

---

## 9. 本探针**不做**的事

| 不做 | 留给 |
| --- | --- |
| UI 边界冒烟（`uiSmoke`） | `docs/233` §5.2 |
| 前端 oracle 与 20 条 AC | `docs/233` §3.3 |
| tier `F1`、批次脚本 | `docs/233` §5.1 |
| 夹具模板 / 变异体 | `docs/233` §3.5 |
| 多框架（Vue/React 并存） | 独立议题 |
| 真实后端接入 | 独立阶段 |

---

## 10. 实施顺序（四步，每步停）

1. **seed 落地**：固定版本 → 在 `node:22-bookworm + pnpm 9.15.0` 容器内生成 `pnpm-lock.yaml`
   → 记录 `lockfileVersion` 与依赖树规模；
2. **镜像（无浏览器）**：构建 `ai-se-sandbox:22-pnpm9-ui` → 跑 P1（A1–A3）→ 记录读数；
3. **镜像（含浏览器）**：`WITH_BROWSER=1` 重建 → 跑 P2（A4–A5）→ 记录读数与限制需求；
4. **结论**：按 §8 三选一写结论；若「条件可行」，列出需要的最小限制改动，作为后续独立阶段的输入。

---

## 11. 清理与回滚

- 探针镜像与默认镜像**并存**，`SANDBOX_IMAGE` 不变，删除新 tag 即回滚；
- `packages/sandbox/probes/ui-stack/` 是构建资产，不参与任何 workspace 包；
- 探针产物（截图、临时目录）只落在容器临时目录，不写仓库。

---

## 12. 进度与未开始事项

**已完成（2026-10-27）**：

- 第 1 步：seed 落地（`packages/sandbox/probes/ui-stack/`，9 个文件）+ lockfile（pnpm 9.15.0，`lockfileVersion 9.0`）；
- 第 2 步：`packages/sandbox/Dockerfile.ui` + P1（无浏览器）**全过**，§8.2；
- 第 3 步：含浏览器镜像 + P2（A4/A5）**全过**，§8.3；
- **结论：可行（默认限制）**。

**后续（2026-10-27 已裁定并落地）**：

- **裁定：浏览器并进默认 tag**（不是并存两套）。`packages/sandbox/Dockerfile` 改为两阶段：两个 seed
  的 lockfile 精确预热 store（`probes/ui-stack/` + `probes/f1-stack/`）+ 全局 playwright + Chromium；
  `PLAYWRIGHT_BROWSERS_PATH` / `NODE_PATH` 已设；镜像 1.17GB → **2.63GB**。细节与容器内读数见
  `docs/235` §6.7；
- `DEFAULT_LIMITS` **未动**：浏览器在 1 核 / 512MB 下验证可用，不需要放宽；
- `Dockerfile.ui` 保留为探针产物，已被默认镜像取代（头注释标明）；
- 探针目录 `probes/ui-stack/` 继续作为镜像的预热 seed（不再是"一次性探针资产"）；
  `probes/f1-stack/` 是 F1 的 seed，与夹具 template **逐字相同**（有守卫用例）。

**未开始事项（STOP）**：
- 探针**尚未接入平台**：没有 `uiSmoke`、没有 tier `F1`、没有批次脚本（这些属 `docs/233`/`docs/235`）；
- 带浏览器镜像 2.72GB 是否作为 `uiSmoke` 的默认镜像，**未裁定**；
- 探针目录 `packages/sandbox/probes/ui-stack/` 是构建资产，是否长期保留（还是迁进 F1 夹具）未定。
