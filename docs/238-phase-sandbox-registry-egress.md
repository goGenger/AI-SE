# 238 · 沙箱出口收敛（`docs/236` §10 第 2 步）实施记录

> **文档性质**：实施记录与验收报告。上游设计 `docs/236-sandbox-egress-design.md` §3 / §10。
> **本阶段只做第 2 步：registry 拓扑。**
>
> 第 3 步（按命令授权）、第 4 步（对夹具开放 `registry`）**未开始**。
> 前置第 1 步（容器加固）已完成，见 `docs/237`。

---

## 1. 做了什么

### 1.1 网络类型：删掉 `"bridge"`，加 `"registry"`

`docs/236` §3 的裁定原话是「设计上应把它从类型里删掉，只保留 `"none" | "registry"`」。
本步执行了：

```ts
export type SandboxNetwork = "none" | "registry";
```

`"bridge"` 的理由：它是**裸出网**——只要这个选项存在，任何一次配置失误都会让生成物拿到
完整互联网。删掉它，代码里就不存在「一条命令把沙箱挂到公网」的写法。

### 1.2 `registry` 模式做的事

| 项 | 内容 |
| --- | --- |
| 网络 | `--network ai-se-egress`（`--internal`，无默认路由） |
| registry 地址 | `npm_config_registry=http://ai-se-registry:4873/` |
| pnpm store | 改指容器内 tmpfs `/tmp/pnpm-store`（见 §3.2） |

出口参数走 `DockerSandboxOptions.egress`（`{ network, registry }`），默认 `DEFAULT_EGRESS`
对齐 compose 的服务名。分成可覆盖的选项是为了让测试能起自己的拓扑。

### 1.3 compose：把拓扑固化

`compose.yaml` 增加 `registry`（verdaccio 6）与 `ai_se_egress`（`internal: true`）。
网络名用 `name: ai-se-egress` **显式钉住**——compose 默认会加 `ai-se_` 前缀，而
`DEFAULT_EGRESS` 和沙箱的 `--network` 参数用的是钉住后的名字。

---

## 2. 验收（`docs/236` §10 第 2 步原文）

> 探针在 `network: registry` 下装任意依赖成功；同时**证明**打 `1.1.1.1` 与元数据地址失败。

两条都做了，且**两半都写进了测试**（`packages/sandbox/src/__tests__/sandboxPnpm.e2e.test.ts`
的 `sandbox registry egress` 组，5 条用例）：

| 用例 | 断言 |
| --- | --- |
| 从 registry 装未预热的包 | `pnpm install` exit 0；`chalk` + `nanoid` 落进 `node_modules` |
| 同工作区在 `none` 下装不上 | exit ≠ 0（证明网络**按需授予**，不是默认打开） |
| registry 模式下打 `1.1.1.1` | exit ∈ {3, 4}（网络错误 / 悬挂自退），不是 0 |
| registry 模式下打 `169.254.169.254` | 同上 |
| registry 模式下打 `https://registry.npmjs.org/zod` | 同上 |
| 外部域名解析 | **`EAI_AGAIN`**（不是「解析到了连不上」） |
| registry 自身可达 | `/-/ping` 200（否则上面几条失败证明不了任何事） |

最后一条是必需的对照组：如果 registry 本身不可达，「打不通互联网」就毫无意义。

### 2.1 读数

环境：`ai-se-sandbox:22-pnpm9`、linux/arm64、Docker Desktop on macOS。

| 项 | 读数 |
| --- | --- |
| 全套 sandbox 测试（不含 registry 组） | 12 passed |
| 全套 sandbox 测试（含 registry 组，用生产拓扑） | 17 passed |
| 装 2 个未预热包（经 registry） | **778ms**；store 用量 **124KB** |
| 同 2 个包在 `none` 下 | `ERR_PNPM_META_FETCH_FAIL` + `getaddrinfo EAI_AGAIN` |
| `1.1.1.1` / 元数据地址 / npmjs | 全部阻断 |
| 外部域名 DNS | `EAI_AGAIN` |

### 2.2 关键性质实测

`--internal` 网络的行为（这一条的证明力最强，因为它绕开了 DNS）：

```
registry.npmjs.org -> DNS FAIL EAI_AGAIN
example.com        -> DNS FAIL EAI_AGAIN
1.1.1.1            -> 1.1.1.1      ← IP 字面量当然"解析"得出来
fetch('http://1.1.1.1/') -> BLOCKED
```

所以阻断来自**没有路由**，不是「DNS 恰好挂了」。换成一个已知 IP 也出不去。

另外验了「拿 registry 域名当隧道」：

```
fetch('http://ai-se-registry:4873/https://evil.example.com') -> 404
```

verdaccio 不转发任意路径，这也是 `docs/236` §8 里那条残余风险的边界。

---

## 3. 实测出来的两个设计修正

### 3.1 compose 的网络别名不是容器名

第一版用 `container_name: ai-se-registry` 之前，compose 生成的容器叫 `ai-se-registry-1`，
网络别名只有 `registry` / `ai-se-registry-1`。`DEFAULT_EGRESS.registry = "ai-se-registry:4873"`
解析失败（`EAI_AGAIN`）。⇒ 钉住 `container_name`，并在 compose 里写清这一点。

同样的坑在网络侧：`networks.ai_se_egress` 默认会被 compose 改名为 `ai-se_ai_se_egress`，
与 `DEFAULT_EGRESS.network` 不一致。⇒ `name: ai-se-egress` 显式钉住。

**两条都要钉，否则「看起来起起来了、其实连不上」。**

### 3.2 registry 模式下不可能用镜像里的只读 store

这是第 1 步遗留的已知限制（`docs/237` §5）在这一步的具体化：

- 镜像里 `/opt/pnpm-store` 是 **root 所有、只读**；
- 加固后容器以工作区属主运行 ⇒ **任何未预热的包都写不进 store**；
- 实测症状：`ERR_PNPM_EROFS ... open '/opt/pnpm-store/v3/files/...'`。

两个候选都比过：

| 方案 | 为什么否 |
| --- | --- |
| 让镜内 store 可写 | 等于允许任意代码往共享缓存里塞包，且容器间互相污染 |
| 把预热 store 复制进 tmpfs 再用 | F1 实测 **217MB**，每条命令多一次 217MB 拷贝，而且预热的意义已经消失（有 registry 就不需要预热） |

采用第三个：registry 模式下用**空的 tmpfs store**（`/tmp/pnpm-store`，512MB）。
包全部从 registry 拉，跨命令复用靠 **verdaccio 自己的磁盘缓存**（`registry_storage` 卷）。
实测两个包 store 只用 124KB。

---

## 4. 回归

| 项 | 结果 |
| --- | --- |
| `@ai-se/sandbox` typecheck / lint | 通过 |
| `@ai-se/sandbox` 测试（无 registry env） | **12 passed / 5 skipped**（registry 组需显式 env，刻意如此） |
| `@ai-se/sandbox` 测试（有 registry env） | **17 passed** |
| `@ai-se/tool-runtime` typecheck / test | 通过 / **37 passed** |
| `@ai-se/server` typecheck / test | 通过 / **488 passed（63 files）** |
| `@ai-se/agent-core` typecheck / test | 通过 / **297 passed（40 files）** |
| **第 1 步验收复测**（`ui-stack` 探针：装→构建→浏览器断言） | exit 0，`color = rgb(18, 52, 86)`、`paddingTop = 16px`、`consoleErrors = 0` |

第 1 步的加固路径没有被本步打破。

---

## 5. 架构影响

- **不新增审计 / 权限 / 错误码体系**；出口是执行参数。
- **默认仍是 `network: "none"`**——本阶段没有给任何生产路径打开网络。`registry` 目前只能由
  代码显式传入（第 4 步才会对夹具开放）。
- `SandboxLimits.network` 的类型收窄（去掉 `"bridge"`）是**编译期破坏性变更**：任何写
  `network: "bridge"` 的调用方现在编译不过。实测全树 grep 只有 `packages/sandbox/src/index.ts`
  自己的类型定义出现过，无外部使用者。

### 已知限制

1. **registry 是单点**。它挂着时 `registry` 模式的命令全部失败（没有回退到直连——这是刻意的，
   回退就等于绕开出口收敛）。
2. **供应链恶意包不解决**（`docs/236` §8 已列为残余风险）：lockfile 固定、`--ignore-scripts`、
   人工评审。本条目的 `--ignore-scripts` 已在第 1 步落地。
3. **verdaccio 的缓存无容量上限**。长期跑会涨；`registry_storage` 是命名卷，需要单独定清理策略。
   本阶段只留位置，不做。
4. **`network: "registry"` 目前没有任何生产调用点**——只有测试与夹具用。按 `docs/236` §10，
   开放给夹具是第 4 步。

---

## 6. 未开始事项（STOP）

- **第 3 步：按命令授权。** `SandboxCommand` 未加 `network`；工具层未实现 `install` 命令分类
  （`pnpm install|npm i|yarn add` 等，且拼接/管道/`sh -c` 一律不算 install）；
  `REGISTRY_UNAVAILABLE` 错误码、`dependency-install` 证据字段均未定义。
- **第 4 步：对夹具/项目开放 `registry`。** 当前只有代码显式传入才能用。
- 容器加固之外的更强隔离（gVisor）——`docs/236` §9 明确「只留位置」。
- verdaccio 缓存容量策略、私有 registry / 私有 git 依赖——`docs/236` §8 列为不解决。
