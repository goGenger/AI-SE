# 236 · 沙箱联网与出口收敛（设计）

> **文档性质**：架构设计，**不含实现**。定义「允许装任意依赖」且「生成物到不了互联网」的网络形态、
> 授权点、容器加固基线、残余风险与落地顺序。实现另立命名阶段，需另行授权。
>
> **上游**：用户 2026-10-27 的判断——预热清单覆盖不了真实依赖面，需要联网；
> `docs/127`（默认断网）、`docs/158` PL-M6（构建期预热）、`docs/234`（离线构建探针）。

---

## 1. 两种风险，解法不同

| 风险 | 本质 | 断网能不能解决 |
| --- | --- | --- |
| **数据外泄** | 生成物把工作区内容发到任意地址；扫内网；打云元数据地址 | **能**——没有路由就发不出去 |
| **容器逃逸** | 打穿容器到宿主内核 | **不能**——断网与内核隔离无关 |

`docs/127` 用断网一次性消掉了第一类；一旦联网，必须用**出口收敛**替代它。第二类要靠容器加固与
（可选的）gVisor 解决，与联网与否正交。

**本文的立场**：沙箱**永远不到达互联网**；只允许它到达一个**我们自己控制的出口**。

---

## 2. 不变量

1. **默认仍是 `network: "none"`**（`packages/sandbox/src/index.ts:49-55`）。开网是**按项目/夹具声明**的例外。
2. **沙箱进程没有到互联网的路由**——这是**拓扑**保证，不是配置约束。删掉环境变量、直接打 IP、打
   `169.254.169.254`，一律无路由。
3. **网络按命令授予，不按任务授予**——沙箱本来就是「每条命令一个新容器」，天然可以逐条决定。
4. **由平台判定，不由 agent 选择**：Tool Runtime 仍是唯一执行路径，agent 没有任何「开网」参数。
5. **不新增第二套审计**：安装行为落进既有的 `tool_calls` 与 evidence 通道。

---

## 3. 拓扑

```
                  ┌──────────── 互联网 ────────────┐
                  │                                │
            [bridge 网络：仅 registry 接入]
                  │
        ┌─────────┴──────────┐
        │  ai-se-registry    │   verdaccio（缓存 + 上游 npmjs）
        │  （唯一出口）       │
        └─────────┬──────────┘
                  │  ai-se-egress（--internal，无外网路由）
        ┌─────────┴──────────┐
        │   沙箱容器          │   .npmrc → http://ai-se-registry:4873
        └────────────────────┘   能解析到的只有 registry 服务名
```

**关键性质**：

- `docker network create --internal ai-se-egress` —— Docker 对该网络**不配置默认路由**，容器无法访问
  任何外部地址，也无法解析外部域名；
- registry 容器同时加入 `ai-se-egress`（供沙箱访问）与一个普通 bridge 网络（它自己出网）；
- **出网只发生在 registry 进程**：它是有界服务，不是任意代码。

**为什么不用 `bridge`**：`SandboxLimits.network` 现在是 `"none" | "bridge"`（`:13`）。`bridge` 是**裸出网**，
只要它存在，任何一次配置失误都会让生成物拿到完整互联网。设计上应把它从类型里删掉，只保留
`"none" | "registry"`。

**为什么不用「代理环境变量 + 防火墙」**：`HTTPS_PROXY` 是约定，不是边界；进程可以直接忽略它。
拓扑（没有路由）才是边界。

---

## 4. 授权模型

### 4.1 网络规格从「构造级」改为「命令级」

| 现状 | 目标 |
| --- | --- |
| `SandboxLimits.network` 在构造时固定（`:8-15`） | `SandboxCommand` 增加 `network?: "none" \| "registry"`（`:17-22`），未指定时取默认 |
| 两个构造点各自写死：`apps/server/src/index.ts:176`（默认 none）、`apps/server/src/services/agentRunService.ts:381-391`（显式 none） | 保持默认 none；只有**被授权的命令**带 `network: "registry"` |

### 4.2 谁决定

- 工具层（`packages/tool-runtime`）新增**命令分类**：`install`（装依赖）与 `other`。
- 只有 `install` 类命令拿 `registry` 网络；`build` / `test` / `preview` / 任意 shell 仍 `none`。
- 分类规则（保守，与既有 N-44 命令策略同一套拒绝口径）：
  - 命令头匹配 `pnpm install|pnpm add|npm install|npm i|npm ci|yarn add`；
  - 出现管道、命令替换、`sh -c` 包装、`&&` 串联时**不算** install（宁可拒绝联网，也不放过拼接）。
- **agent 看不到这个开关**：`run_command` 的入参 schema 不新增任何网络字段（`commandTools.ts:258`）。

### 4.3 失败模式

| 情形 | 行为 |
| --- | --- |
| registry 不可达 | 明确错误码 `REGISTRY_UNAVAILABLE`，**不回退到联网**，不重试到别的地址 |
| 包不在 registry | 原样返回 pnpm 的 `ERR_PNPM_FETCH_404` |
| install 命令被拒（含拼接） | `COMMAND_POLICY_BLOCKED`，与既有的命令拒绝同码同审计 |

---

## 5. 容器加固基线

现状（`packages/sandbox/src/index.ts:216-244`）：`--rm`、`--network`、`--cpus`、`--memory`、`--pids-limit`、
`no-new-privileges`、`--cap-drop ALL`、workspace 挂载、**仅显式 `--env`（不透传宿主 env）**。

| 项 | 现状 | 目标 | 副作用 / 注意 |
| --- | --- | --- | --- |
| 容器内用户 | **root** | `--user 1000:1000` | workspace 属主需匹配（挂载前 chown，或 userns-remap） |
| 根文件系统 | 可写 | `--read-only` + `--tmpfs /tmp` | pnpm store、构建缓存要写 `/tmp`；`/workspace` 保持可写 |
| 安装脚本 | 允许 | `--ignore-scripts` | **必须逐包验证**：esbuild/oxc 一类包的二进制来源要实测（本仓库的 Vite 8 依赖 oxc） |
| seccomp | Docker 默认 | 默认即可；需要更强时上自定义 profile | 自定义 profile 容易误伤 Node/Chromium |
| 元数据地址 | 靠断网 | internal 网络天然无路由 | 不需要额外防火墙规则 |
| 宿主 env | 不透传 ✅ | 保持 | — |

> `--ignore-scripts` 与「能不能构建」直接冲突，属于**需要实测再定**的一项：`docs/234` 的探针必须先量
> 「关掉 postinstall 后 Vite/Tailwind 还能不能构建」，不能凭直觉打开。

---

## 6. 供应链控制

联网只解决「能不能装」，不解决「装到坏包」。四条同时做：

1. **lockfile 固定**：安装一律 `--frozen-lockfile`；版本变更必须是一次**显式**的解析步骤（不是 agent 顺手 `pnpm add`）。
2. **registry 固定**：`.npmrc` 写死 mirror；拒绝 git 依赖、tarball URL、非 mirror 的 scope registry。
3. **安装产物入证据**：lockfile diff、包清单（`name@version`）、来源 registry、耗时。
4. **可观察的审计**（先不做成门）：`pnpm audit --json` 的结果落 evidence，供人工看趋势。

---

## 7. 审计与证据

沿用既有通道，不新增表：

- 每次安装是一次 `tool_calls` 记录（`command`、`exitCode`、`duration`）；
- 安装结果追加一条 **evidence**：`{ kind: "dependency-install", lockfileDigest, packages[], registry, durationMs }`；
- 命令被拒（策略）与 registry 不可达各有独立错误码，便于批次统计。

---

## 8. 威胁模型：解决什么、不解决什么

| 场景 | 出口收敛后 |
| --- | --- |
| 生成物 POST 工作区内容到任意地址 | **阻断**（无路由） |
| 扫描内网 / 打云元数据地址 | **阻断**（internal 网络无路由） |
| 通过 registry 域名做隧道 | 需要 registry 配合（缓存代理不理解自定义隧道，但仍应监控异常请求体） |
| 恶意包（typosquatting、恶意 postinstall） | **不解决**——靠 lockfile 固定、`--ignore-scripts`、人工评审 |
| 内核提权 / 容器逃逸 | **不解决**——需要 gVisor 一类更强隔离 |
| 私有 git 依赖 / 私有 registry | **不解决**——需要单独的出口配置，属另一个议题 |

---

## 9. 可选的更强隔离（gVisor）

- 触发条件：威胁模型包含「不可信代码可能在容器内提权」；
- 做法：沙箱以 `runsc` 为 runtime，系统调用面从数百降到数十；
- 代价：构建变慢、部分 syscall 不支持（Chromium 需实测）、运维复杂度上升；
- **本阶段只留位置**，不实现。

---

## 10. 落地顺序（四步，每步停）

| 步 | 内容 | 验收 | 回滚 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 容器加固（不含联网）：`--user`、`--read-only`+tmpfs、`--ignore-scripts` 实测 | `docs/234` 探针在加固后仍能安装与构建 | 去掉加固参数 | **已完成**（`docs/237`） |
| 2 | registry 拓扑：internal 网络 + verdaccio（默认仍 `none`，只在一个探针里启用） | 探针在 `network: registry` 下装任意依赖成功；同时**证明**打 `1.1.1.1` 与元数据地址失败 | 关掉 registry 容器 | **已完成**（`docs/238`） |
| 3 | 按命令授权：`SandboxCommand.network` + 工具层分类 + 失败码 | build/test 命令仍无网；install 命令有网；拼接命令被拒 | 命令级字段回退为默认 | **已完成**（`docs/239`） |
| 4 | 对夹具/项目开放 `registry` 模式（默认不变） | 一次真实前端夹具跑通安装 | profile 切回 `none` | **已完成**（`docs/240`） |

### 10.1 第 1 步的实测修正（已落地，回写本节）

设计时的三项加固参数，实测后有两处必须改，一处必须加：

| 设计原文 | 实测结论 | 落地形态 |
| --- | --- | --- |
| `--user 1000:1000` | **写死 1000 会让所有写入 EACCES**——绑定挂载属主是宿主 uid | `--user <工作区属主 uid>:<gid>`（`workspaceOwner()` 读挂载点） |
| `--read-only` + `--tmpfs /tmp` | 成立，但 `$HOME` 默认是 `/`（非 root 无 passwd 条目），只读下写不进去 | 追加 `HOME=/tmp` |
| `--ignore-scripts` | 成立，且不影响项目自己的 `pre*`/`post*`（那是 `pnpm run` 的路径）；对 esbuild 也无影响（二进制来自平台包不是 postinstall） | `npm_config_ignore_scripts=true` |

另有一处**设计未预见、但加固的硬前置**：

- 镜像的 store 配置原先只写在 `/root/.config/pnpm/rc`，**非 root 读不到** ⇒ `pnpm config get
  store-dir` 返回 undefined ⇒ 离线预热整个失效，失败形态是转而联网后的 `EAI_AGAIN`（看起来像
  网络问题，不是 `ENOTCACHED`）。已在 `Dockerfile` 追加 `/usr/local/etc/npmrc`。

**由此暴露的新限制**（正是第 2–4 步存在的理由）：非 root 无法写只读的 `/opt/pnpm-store`，
所以「未预热」的包在加固后的离线沙箱里是 `ERR_PNPM_EACCES`，而不是原来的「装不上」。
开 registry 之后包从网络来、写进工作区 `node_modules`，这个限制自然消失。

细节与读数见 `docs/237-phase-sandbox-hardening.md`。

### 10.2 第 2 步的实测修正（已落地）

| 设计原文 | 实测结论 | 落地形态 |
| --- | --- | --- |
| `SandboxLimits.network = "none" \| "registry"` | 成立；`"bridge"` 已从类型删除 | `export type SandboxNetwork = "none" \| "registry"` |
| 沙箱 `.npmrc → http://ai-se-registry:4873` | 写文件会污染被测工作区（还会被 diff 审计算成生成物改动） | 改用 `npm_config_registry` env |
| （未预见）registry 模式下的 store | 镜像的 `/opt/pnpm-store` 只读，非 root 写不进 ⇒ `ERR_PNPM_EROFS` | registry 模式用空的 tmpfs store（`/tmp/pnpm-store`），包全从 registry 拉，跨命令复用靠 verdaccio 自己的缓存 |

另外两处**名字**必须钉住，否则「看起来起起来了、其实连不上」：

- compose 网络默认会被改名成 `ai-se_ai_se_egress` ⇒ `name: ai-se-egress`；
- compose 容器默认叫 `ai-se-registry-1`、别名只有 `registry` ⇒ `container_name: ai-se-registry`。

### 10.3 第 3 步的实测修正（已落地）

| 设计原文 | 实测结论 | 落地形态 |
| --- | --- | --- |
| `SandboxCommand` 增加 `network?` | 需要**同时**限制「不得超过构造级授权」，否则一条命令就能自行升级到出网 | `resolveNetwork()`：命令要求 `registry` 而构造是 `none` 时**抛错** |
| `REGISTRY_UNAVAILABLE` 作为「明确错误码」 | 新造 `RuntimeErrorCode` 会违反 `AGENTS.md` §10（`mcp` 包有专门用例断言只用既有闭集） | 落成既有 `COMMAND_ERROR` 的 `details.reason = "REGISTRY_UNAVAILABLE"` |
| 证据 `{ kind: "dependency-install", lockfileDigest, packages[], registry, durationMs }` | `lockfileDigest` 要在装完之后再读一次工作区，而 `--frozen-lockfile` 失败时正是最需要证据的时候——多一次读会让失败路径更脆 | 落成 `tool_calls.output.dependencyInstall = { ok, exitCode, durationMs, packages[] }`，不读工作区 |

### 10.4 第 4 步的实测修正（已落地）

| 设计原文 | 实测结论 | 落地形态 |
| --- | --- | --- |
| 「对夹具/项目开放 `registry`」 | 回滚列写的是「profile 切回 `none`」——说明开关属于 **capability profile**，不是新配置项 | `CapabilityProfile.dependencyNetwork?: "none" \| "registry"`，缺省 `"none"` |
| （未预见）开关粒度 | profile 级 = 切到 `frontend-vue` 后**所有**走该执行器的项目都获得 registry；逐项目控制需要项目表字段，属另一件事 | 按原文做到 profile 粒度，限制写在 `docs/240` §4 |
| （未预见）`agentRunService` 的沙箱 | 那是单任务调试运行，不是项目交付 | 显式保持 `network: "none"`，不随 profile 走 |

**三层结构**（缺任一层都会退化成「一个开关打开全链路」）：

```
profile.dependencyNetwork   ← 能力面声明（谁能出网）
  ↓
SandboxLimits.network       ← 构造级上限（这个沙箱最高到哪）
  ↓
SandboxCommand.network      ← 命令级授权（这一条命令给不给）
```

---

## 11. 明确不做

- 不把默认网络改成联网；
- 不给 agent 任何网络开关（入参 schema 不加字段）；
- 不保留 `"bridge"` 这个裸出网选项；
- 不引入第二套审计或第二个凭证体系；
- 不在本阶段实现 gVisor；
- 不解决供应链恶意包问题（明确列为残余风险）。

---

## 12. 未开始事项（STOP）

`docs/236` 的四步已全部完成（见下）。仍未做的是本文**明确排除**或「只留位置」的部分：

- **gVisor**（§9）：只留位置，未实现；
- **供应链恶意包检测**（§8 残余风险）：只有 lockfile 固定 + `--ignore-scripts` + 人工评审；
- **私有 registry / 私有 git 依赖**（§8）：不解决；
- **verdaccio 缓存容量策略**：`registry_storage` 是命名卷，会持续增长，尚未定清理策略；
- **逐项目的出网开关**：当前粒度是 capability profile（`docs/240` §4），项目表没有该字段。

本文与 `docs/234` 的探针并行：探针继续走离线路线，本设计是**开网的正规路径**，两者不冲突。

**已完成（四步全览）**：

| 步 | 内容 | 记录 |
| --- | --- | --- |
| 1 | 容器加固（`--user` / `--read-only` / `--ignore-scripts` / `HOME` / store 配置） | `docs/237` |
| 2 | `SandboxLimits.network` → `"none" \| "registry"`（`"bridge"` 已删）+ `ai-se-egress` + verdaccio | `docs/238` |
| 3 | `SandboxCommand.network` + `install` 命令分类 + `REGISTRY_UNAVAILABLE` 判别 + 安装证据 | `docs/239` |
| 4 | `CapabilityProfile.dependencyNetwork`，`frontend-vue` 开放、`backend-node` 仍 `none` | `docs/240` |
