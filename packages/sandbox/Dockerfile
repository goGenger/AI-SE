# F1-7（FX-24a）：AI-SE 沙箱镜像。
#
# 构建期预置**真实 pnpm 二进制**（直达 PATH、不经 corepack 下载）：
#   - 运行时 `docker run --rm --network none` 内 `pnpm install --frozen-lockfile` 可离线执行；
#   - 版本随实施锁定（9.15.0，与仓库 corepack 一致）；不追求逐版本覆盖；
#   - 项目 packageManager 字段声明的版本可能与预置不一致——按裁决「忽略该字段、使用预置版本」处理
#     （验收探针在版本不一致时记录该事实，不阻断安装；见 packages/sandbox/src/__tests__/sandboxPnpm.e2e.test.ts）。
#
# PL-M6（`docs/158` §3）：构建期**预热 pnpm store**。
#   - 构建期**有网**、运行期 `network: "none"` 无网——这是唯一能既保住「默认断网」又能装第三方依赖的路径；
#   - 预热清单经 `PREWARM_PACKAGES` 声明（包名列表，浮动解析）；
#   - **不改变沙箱的默认网络**（`DEFAULT_LIMITS.network` 仍为 `"none"`），也不引入运行期 registry 代理。
#   - 清单**外**的依赖仍然装不上——这是刻意的边界，验收用例会钉住它。
#
# `docs/235` §6.7：镜像**内置浏览器（Chromium）与前端依赖闭包**。
#   - `uiSmoke`（`docs/233` §5.2）要在沙箱里开**真实浏览器**断言渲染后的 DOM。浏览器必须来自镜像：
#     让每个被测项目自带 playwright，等于要求产品依赖测试工具（交付物不该背这个）。
#     因此本镜像全局安装 playwright 并设 `NODE_PATH`，任何工作区都能 `require.resolve('playwright')`。
#   - 另外再安装 `PLAYWRIGHT_PRODUCT_VERSION`（平台契约，默认 1.64.1）的 Chromium rev 1248，
#     避免产品工作区的 playwright 在 `/opt/ms-playwright` 里找不到匹配 rev（docs/255 / docs/264）。
#     产品必须钉死该版本；不要为单个项目再打一层更新的 Chromium。
#   - 前端依赖用 **seed 的 lockfile** 精确预热，而不是 `pnpm store add` 的浮动解析：
#     运行期是 `--frozen-lockfile`，差一个补丁版本就是 `ENOTCACHED`。
#   - 代价是镜像从 1.17GB 变成约 2.7GB（磁盘）；**运行期限制不变**：1 核 / 512MB / 无网 / 128 pid。
#     容量读数见 `docs/234` §8.3（P2 在默认限制下全过）。
#
# 构建：docker build -t ai-se-sandbox:22-pnpm9 packages/sandbox
#      （或 pnpm --filter @ai-se/sandbox run build:image）
FROM node:22-bookworm AS warm

ARG PNPM_VERSION=9.15.0
# 通用预热清单：以「平台可能交付的真实项目」为准，不是以「验收用例恰好要用的那一个」为准。
ARG PREWARM_PACKAGES="lodash@4.18.1 express@5.3.0 zod@4.6.7 vitest@5.0.5"
ENV PNPM_STORE_DIR=/opt/pnpm-store

RUN npm install --global pnpm@${PNPM_VERSION} \
  && pnpm --version \
  && pnpm config set --global store-dir "${PNPM_STORE_DIR}" \
  && pnpm store add ${PREWARM_PACKAGES} \
  && pnpm store path

# 前端依赖闭包：两个 seed 各自的 lockfile 精确预热到同一个 store。
#   - `probes/ui-stack/`：`docs/234` 的探针工程（React + Tailwind）；
#   - `probes/f1-stack/`：F1 夹具的依赖集（Vue + Vite + Vitest），与
#     `packages/eval/fixtures/F1/template/package.json` 逐字相同（有守卫用例）。
COPY probes/ui-stack/ /seed-ui/
COPY probes/f1-stack/ /seed-f1/
RUN cd /seed-ui && pnpm install --frozen-lockfile \
  && cd /seed-f1 && pnpm install --frozen-lockfile

FROM node:22-bookworm

ARG PNPM_VERSION=9.15.0
ARG PLAYWRIGHT_VERSION=1.61.0
# 平台契约（docs/264）：产品官方 E2E 钉死 playwright@1.64.1 → chromium rev 1248。
# 与全局 1.61.0（chromium-1228，供平台 uiSmoke）并存于同一 PLAYWRIGHT_BROWSERS_PATH。
# 升级须正式发布镜像与模板，禁止产品把 Playwright 当普通依赖上浮。
ARG PLAYWRIGHT_PRODUCT_VERSION=1.64.1
ENV PNPM_STORE_DIR=/opt/pnpm-store
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# 全局 playwright 的模块目录：`node -e` 里不带 paths 的 `require.resolve` 会走 NODE_PATH，
# 这是 `uiSmoke` 探针的第二级回退（工作区没带 playwright 时）。
ENV NODE_PATH=/usr/local/lib/node_modules

RUN npm install --global pnpm@${PNPM_VERSION} \
  && pnpm --version \
  && pnpm config set --global store-dir "${PNPM_STORE_DIR}" \
  && pnpm store path

# `docs/236` §5：store 目录写进**全局** npmrc（`/usr/local/etc/npmrc`），而不是只写进
# `pnpm config set --global` 生成的 `/root/.config/pnpm/rc`。后者只有 root 读得到——
# 加固后容器以工作区属主身份运行，`pnpm config get store-dir` 会返回 undefined，于是 pnpm
# 认为 store 在默认位置、离线预热整个失效（实测表现是转而联网后 EAI_AGAIN，不是 ENOTCACHED）。
RUN mkdir -p /usr/local/etc \
  && echo "store-dir=${PNPM_STORE_DIR}" > /usr/local/etc/npmrc \
  && chmod 0644 /usr/local/etc/npmrc

# 浏览器：playwright 包**没有 postinstall**（`docs/234` §8.1），浏览器只能显式安装。
# 放在 store 拷贝**之前**：改 seed（依赖集变化）时这一层仍然命中缓存，不必重下 300MB 的浏览器。
RUN npm install --global playwright@${PLAYWRIGHT_VERSION} \
  && playwright install --with-deps chromium \
  && npx --yes playwright@${PLAYWRIGHT_PRODUCT_VERSION} install --with-deps chromium \
  && chmod -R a+rX /opt/ms-playwright \
  && rm -rf /root/.npm /var/lib/apt/lists/*

COPY --from=warm /opt/pnpm-store /opt/pnpm-store
