# 237 · 沙箱容器加固（`docs/236` §10 第 1 步）实施记录

> **文档性质**：实施记录与验收报告。上游设计是 `docs/236-sandbox-egress-design.md` §5 / §10。
> **本阶段只做第 1 步：容器加固，不含联网。**
>
> 第 2 步（registry 拓扑）、第 3 步（按命令授权）、第 4 步（对夹具开放 `registry`）**未开始**。

---

## 1. 做了什么

`packages/sandbox/src/index.ts` 增加一个 `harden` 开关（**默认 `true`**），开启后每次
`docker run` 追加四项：

| 加固项 | 参数 | 防的是什么 |
| --- | --- | --- |
| 根文件系统只读 | `--read-only` + `--tmpfs /tmp:rw,size=512m` | 生成物改镜像内的 pnpm/node/playwright；把后门写进镜像层（`--rm` 之后那些改动本该消失，但被读改写的运行时文件不会） |
| 非 root | `--user <工作区属主 uid>:<gid>` | 容器内提权面；顺带修掉「容器写出的 root 属主文件宿主删不掉」 |
| `HOME` 重定向 | `--env HOME=/tmp` | 只读根文件系统下有可写的 `$HOME` |
| 依赖生命周期脚本 | `--env npm_config_ignore_scripts=true` | 依赖的 `postinstall` 在安装期执行任意代码 |

另有一项**不是加固、是修既有缺陷**：

| 项 | 内容 |
| --- | --- |
| store 配置全局可读 | `Dockerfile` 增加 `/usr/local/etc/npmrc`，内容 `store-dir=/opt/pnpm-store` |

原因见 §3.1——它是加固的**前置条件**，不修则加固一开，离线预热就整个失效。

---

## 2. 门槛

```
corepack pnpm --filter @ai-se/sandbox typecheck && lint && test
```

| 项 | 结果 |
| --- | --- |
| typecheck | 通过 |
| lint | 通过 |
| test | **12 passed**（原 8 + 新增 4 加固用例） |

新增用例（`packages/sandbox/src/__tests__/sandbox.test.ts` 的 hardening describe）：

1. **以工作区属主身份运行**——断言 `id -u`/`id -g` 等于挂载目录的宿主 uid/gid，且非 0。
   写死 1000 在这里会立刻露馅（macOS 宿主是 501）。
2. **根文件系统只读**——`/opt` 写不进去，`/workspace` 与 `$HOME` 可以，且 `HOME=/tmp`。
3. **store 目录显式传入**——非 root 下 `pnpm config get store-dir` 返回 `/opt/pnpm-store`。
4. **回滚开关有效**——`harden: false` 时回到 root、可写 `/opt`。

---

## 3. 实测读数（2026-10-28）

环境：`ai-se-sandbox:22-pnpm9`、linux/arm64、Docker Desktop on macOS（宿主 uid 501 / gid 20）。

### 3.1 三条实测出来的坑（都是「加了参数就静默坏掉」型）

**(a) `--user` 不能写死 1000——必须用工作区属主。**

绑定挂载的属主是宿主 uid。`--user 1000:1000` 对着 501 的挂载，`pnpm install` 直接 EACCES。
所以 `workspaceOwner()` 读挂载点的 uid/gid 传给 `--user`。这在 Linux 宿主同样成立（那里通常
确实是 1000，但那是巧合，不是约束）。

**(b) 非 root 读不到 `/root/.config/pnpm/rc`，离线预热会静默失效。**

镜像原先用 `pnpm config set --global store-dir`，它写的是 `/root/.config/pnpm/rc`。以 uid 1000
运行时：

```
$ pnpm config get store-dir
undefined
```

于是 pnpm 认为 store 在默认位置（`~/.local/share/pnpm/store`），预热好的 2.6GB store 一个都
用不上，转去联网，失败形态是 `EAI_AGAIN`（**不是** `ENOTCACHED`）——看起来像网络问题，
实际是配置没读到。

修法：镜像里额外写 `/usr/local/etc/npmrc`（npm 的全局配置，对所有 uid 可读），代码里再用
`npm_config_store_dir` env 兜一层。两层都留着：前者让**任何**入口（不止我们这个沙箱类）都正确，
后者让 `storeDir` 可被构造覆盖。

**(c) `--read-only` 下 `$HOME` 默认是 `/`，任何 `mkdir ~/.npm` 都失败。**

非 root 且无 passwd 条目时 `HOME=/`。根文件系统只读 ⇒ 不可写。指向 tmpfs 的 `/tmp`。

### 3.2 加固后验收（`docs/236` §10 第 1 步要求的「`docs/234` 探针仍能安装与构建」）

跑的是 `packages/sandbox/probes/ui-stack`（React + TS + Tailwind 4 + Playwright），
经 `DockerSandbox` 真实路径（不是手写 docker 命令）：

| 断言 | 结果 | 读数 |
| --- | --- | --- |
| A1 离线安装 | exit 0 | `pnpm install --frozen-lockfile` |
| A2 构建 | exit 0 | `pnpm build`，dist 228K |
| A3 预览可达 | 通过 | HTTP 200，端口就绪 877ms |
| A4 Tailwind 生效 | **通过** | `color = rgb(18, 52, 86)`、`paddingTop = 16px` |
| A5 控制台干净 | **通过** | `consoleErrors = 0` |
| Chromium 启动 | 通过 | 595ms |

`docs/234` §7 预判的失败模式**一个都没有出现**。

F1 夹具（`packages/eval/fixtures/F1/template`，Vue 3 + Vite 8 + Vitest 5）在加固下：
`pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm typecheck` —— exit 0。

### 3.3 资源读数

| 项 | 读数 |
| --- | --- |
| `/tmp` 峰值占用（装→构建→Chromium 全流程） | **2.8 MB**（上限设 512MB，两个数量级余量） |
| 内存峰值 | **373 MB / 512 MB（73%）** |
| `pids` | 未触限 |

### 3.4 未采用的两项（有理由，不是遗漏）

| 项 | 为什么不做 |
| --- | --- |
| `--tmpfs /tmp:noexec` | 实测 Chromium 在 `noexec` 下仍能启动，但 pnpm 在 `/tmp` 解包后要执行 lifecycle 脚本；加了会把「将来需要构建的原生依赖」这条路堵死。收益（防 `/tmp` 里执行）在一个已经没有外网、没有写权限的容器里很小。 |
| 自定义 seccomp profile | Docker 默认 profile 已够；自定义 profile 容易误伤 Node/Chromium。`docs/236` §5 原文也是「默认即可」。 |

---

## 4. 既有链路回归

加固默认开启，所以**每一个**用 `DockerSandbox` 的地方都被影响。

### 4.1 定向用例（全部通过）

| 用例 | 结果 |
| --- | --- |
| `@ai-se/sandbox` 全套（含新增 4 条加固用例） | **12 passed** |
| `@ai-se/tool-runtime` 全套（沙箱唯一消费方） | **37 passed** |
| `@ai-se/agent-core` 全套 | **297 passed / 40 files** |
| `@ai-se/agent-core` `codingAgent.e2e` | 1 passed |
| `@ai-se/agent-core` `frontendTask.e2e` | 2 passed |
| `@ai-se/server` `injectionRedteam.e2e` | 2 passed |
| `@ai-se/server` `verificationGate.e2e` | 10 passed |
| `@ai-se/server` `professionalAgents.e2e` | 2 passed |
| `@ai-se/server` `visualFixLoop.e2e` | 4 passed |

### 4.2 生产路径模拟（不经单测，直接走 `DockerSandbox`）

| 场景 | 结果 |
| --- | --- |
| `git init && config && add && commit` | exit 0（平台第一条命令） |
| `git status --porcelain` / `rev-parse` / `diff --stat` | exit 0 |
| 模拟 `uiSmoke`：起 preview + 全局 playwright 断言 `data-testid` | **9 个 testid，控制台 0 error** |
| F1 模板 `install && build && test && typecheck` | exit 0 |

### 4.3 全仓 `apps/server` 回归：2 次，各 1–3 条失败（**与加固无关**）

| 次 | 结果 | 失败用例 |
| --- | --- | --- |
| 1 | 485 passed / 3 failed | `planningEscalation.e2e`、`projects.test`、`v1GoldenScenario.e2e`（golden 主流程） |
| 2 | 487 passed / 1 failed | `v1GoldenScenario.e2e`（**另一个**用例：server restart） |

判定与加固无关，依据三条：

1. **每次失败的集合都不同**，且与第 1 次不重叠；
2. **三个用例单独跑全部通过**（`projects` 6/6、`planningEscalation` 2/2、`v1GoldenScenario` 4/4）；
3. 失败点是 `waitFor timed out`，位于**直接构造 `WorkflowService`** 的重启用例——不经过
   `DockerSandbox`，加固参数物理上影响不到它。

这是本仓库已登记在案的**并行负载 flake**（GUI 负载下 `v1GoldenScenario` / `workflowApi` /
`terminationPropagation` 反复出现，单独跑必过），不是本阶段的回归。

---

## 5. 架构影响

- **不新增权限/审计/错误码体系**——加固是执行参数，落在既有 `DockerSandbox` 里。
- **Tool Runtime 仍是唯一执行路径**——没有新的执行入口。
- `SandboxLimits` 增加一个 `harden: boolean`（默认 true）。类型上这是**行为变更**：
  任何不传 `limits` 的构造点从此都在加固下运行。回滚方式是显式 `limits: { harden: false }`。

### 已知限制

1. **非 root 无法写「未预热」的包。** 这是加固与离线预热的交叉限制，已实测确认：
   容器以工作区属主运行时，`/opt/pnpm-store` 是 root 所有、只读；命中预热的包能装（只读），
   未命中的包会 `ERR_PNPM_EACCES`（尝试写 store 被拒）。**这条正是 `docs/236` 第 2–4 步要
   解决的东西**：开 registry 之后，包从网络来、写进工作区的 `node_modules`，不再需要写 store。
2. **`--ignore-scripts` 只挡依赖的生命周期脚本**，不挡项目自己的 `pre*`/`post*`（实测
   `prebuild` 照常执行）。这符合预期：前者是第三方代码，后者是被测项目自己的代码。
3. **`/tmp` 上限 512MB。** 实测峰值 2.8MB；但一个大型前端项目的 Vite 构建缓存可能更大。
   若将来触限，调 `HARDENED_TMPFS_SIZE`，不要改成可写根文件系统。

---

## 6. 未开始事项（STOP）

- `SandboxLimits.network` 仍是 `"none" | "bridge"`；`SandboxCommand` 未加 `network`；
  `"bridge"` 这个裸出网选项**仍在类型里**（`docs/236` §3 要求删掉，属第 2 步）。
- 未创建 `ai-se-egress`（`--internal`）网络，未部署 registry 容器。
- 工具层未实现 `install` 命令分类（第 3 步）。
- `REGISTRY_UNAVAILABLE` 错误码、`dependency-install` 证据字段未定义（第 3 步）。
- gVisor 未实现（`docs/236` §9 明确「只留位置」）。
- **默认仍是 `network: "none"`**——本阶段没有打开任何网络。
