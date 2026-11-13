# 239 · 沙箱按命令授权（`docs/236` §10 第 3 步）实施记录

> **文档性质**：实施记录与验收报告。上游设计 `docs/236-sandbox-egress-design.md` §4 / §10。
> **本阶段只做第 3 步：按命令授权。**
>
> 第 1 步（容器加固）见 `docs/237`，第 2 步（registry 拓扑）见 `docs/238`。
> 第 4 步（对夹具开放 `registry`）**未开始**。

---

## 1. 做了什么

### 1.1 网络从「构造级」改为「命令级」

```ts
export interface SandboxCommand {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  network?: SandboxNetwork;   // ← 新增
}
```

未指定时取 `SandboxLimits.network`（默认 `"none"`）。

**不能自行升级**：`resolveNetwork()` 在一条命令要求 `"registry"` 而构造侧是 `"none"` 时**抛错**，
而不是静默降级或静默放行。否则授权就从平台转移到了调用方。反向（构造 `registry`、命令要
`none`）是收紧，允许。

### 1.2 命令分类

`packages/tool-runtime/src/tools/packageManager.ts` 新增 `isDependencyInstallCommand()`：

1. 含**引号外**的 shell 语法（`;` `|` `&` `<` `>` `` ` `` `$` 换行）或未闭合引号 ⇒ 不是 install；
2. 命令头必须**恰好**是 `pnpm` / `npm` / `yarn`（`/usr/local/bin/pnpm`、`env pnpm` 都不算）；
3. 第一个子命令必须**恰好**是 `install` / `i` / `ci` / `add`。

第 1 条复用了既有的 `containsUnquotedShellSyntax`——与 N-44 命令黑名单同一个引号口径，没有第
二套词法。

### 1.3 授权在工具层，agent 看不到开关

```ts
const network =
  context.dependencyInstallAllowed && isDependencyInstallCommand(resolved.command)
    ? "registry"
    : undefined;
```

- `ToolExecutionContext.dependencyInstallAllowed` 是**项目级能力上限**（第 4 步才由平台按夹具
  声明设置）；缺省 `false` ⇒ 与之前完全一致。
- `run_command` / `run_unit_test` / `run_lint` / `run_build` 的**入参 schema 没有任何网络字段**
  ——agent 无法请求出网，只能由平台按命令内容判定。

### 1.4 失败判别与证据

| `docs/236` §4.3 要求 | 实现 |
| --- | --- |
| registry 不可达 ⇒ 明确错误 | `details.reason = "REGISTRY_UNAVAILABLE"` |
| 不回退到联网、不换地址重试 | 无回退代码路径；出口地址只来自构造参数 |
| 包不在 registry ⇒ 原样返回 404 | `ERR_PNPM_FETCH_404` / `NO_MATCHING_VERSION` **显式排除**在判别之外 |
| install 被拒 ⇒ `COMMAND_POLICY_BLOCKED` | 由既有 `assertCommandAllowed` 拒绝，行为不变 |
| 安装产物入证据 | `tool_calls.output.dependencyInstall = { ok, exitCode, durationMs, packages[] }` |

**没有新造 `RuntimeErrorCode`**：`AGENTS.md` §10 禁止第二套错误码体系，`RuntimeErrorCode` 是
全仓共用闭集（`mcp` 包有专门用例断言只用这套）。`REGISTRY_UNAVAILABLE` 因此落在既有的
`COMMAND_ERROR` 的 `details.reason` 上——这与 `commandFailureDetails` 的其他字段同层，可被
批次统计按 `reason` 过滤。

---

## 2. 验收（`docs/236` §10 第 3 步原文）

> `build`/`test` 命令仍无网；`install` 命令有网；拼接命令被拒。

三条都做了，且分三层验：

### 2.1 命令分类（纯函数，44 条）

`packages/tool-runtime/src/__tests__/dependencyInstallCommand.test.ts`

| 组 | 条数 | 内容 |
| --- | --- | --- |
| 认得的安装命令 | 14 | `pnpm install` / `pnpm i` / `pnpm ci` / `pnpm add x` / `npm ci` / `yarn add` … |
| 拼接/管道/替换一律不算 | 17 | `&&`、`&&` 在前、`\|`、`;`、`\|\|`、`>`、反引号、`$()`、`$VAR`、换行、未闭合引号、`sh -c`、`bash -c`、`node -e`、`env` 前缀、`nohup` 前缀、绝对路径 |
| 非安装类不给出网 | 10 | `build` / `test` / `run build` / `preview` / `update` / `upgrade` / `remove` / `audit` / `publish` / `npm run install-deps` |
| 边界 | 3 | `npm run install` 不是安装（那是项目脚本）；空串；引号内的 `&&` 是数据 |

### 2.2 授权传递（14 条，假沙箱记录入参）

`packages/tool-runtime/src/__tests__/commandNetworkGrant.test.ts`

- `pnpm install` + 项目获准 ⇒ `network: "registry"`；
- `pnpm build` / `pnpm test` / `pnpm preview` / `ls` / `git status` ⇒ **无** `network` 字段；
- 项目**未**获准 ⇒ install 也无网；**缺省不传** ⇒ 无网（既有调用方零行为变化）；
- `run_unit_test` / `run_lint` / `run_build` 三个工具 ⇒ 永不拿网；
- 拼接命令**先被既有黑名单拒绝**（一次 `runCommand` 都没发生），网络判定不会成为绕过黑名单的新路径；
- 不带黑名单关键词的拼接（`pnpm install && node -e …`）⇒ 分类器自己拒绝，无网。

### 2.3 真沙箱 + 真 registry（端到端）

环境：`ai-se-sandbox:22-pnpm9`、`ai-se-egress`（internal）、`ai-se-registry`（verdaccio 6）。

| 场景 | 结果 |
| --- | --- |
| 全新工作区 `pnpm install`（两个未预热包） | success，`network: "registry"`，`packages: ["chalk@5.3.0", "nanoid@5.1.6"]` |
| **同一沙箱、同一项目获准**跑 `fetch('http://1.1.1.1/')` | **BLOCKED**（exit 3） |
| registry 停掉后 `pnpm install` | `code: COMMAND_ERROR`、`reason: REGISTRY_UNAVAILABLE` |
| registry 里没有的包 | 不标 `REGISTRY_UNAVAILABLE`，原样 404 |

第二行是这一步最关键的读数：**授权是逐条命令的，不是逐任务/逐容器的**。同一个沙箱对象、同
一个获准项目，install 拿得到出口，下一条命令立刻回到无网。

### 2.4 边界用例（2 条）

`packages/sandbox/src/__tests__/networkGrant.test.ts`：构造 `none` 时命令要求 `registry` ⇒
抛错；要求 `none` / 不指定 ⇒ 放行。

---

## 3. 门槛

| 项 | 结果 |
| --- | --- |
| `@ai-se/sandbox` typecheck / lint | 通过 |
| `@ai-se/sandbox` test（含 registry 组） | **19 passed（3 files）** |
| `@ai-se/tool-runtime` typecheck / lint | 通过 |
| `@ai-se/tool-runtime` test | **99 passed（7 files，原 37）** |
| `@ai-se/server` typecheck / test | 见 §3.1 |
| `@ai-se/agent-core` typecheck / test | 见 §3.1 |

### 3.1 下游回归

| 项 | 结果 |
| --- | --- |
| `@ai-se/agent-core` typecheck / test | 通过 / **297 passed（40 files）** |
| `@ai-se/server` typecheck / test | 通过 / **487 passed / 1 failed（63 files）** |

server 的 1 条失败是 `v1GoldenScenario.e2e` 的 server-restart 用例（`waitFor timed out`），
**与网络无关**（它直接构造 `WorkflowService`，不经过 `DockerSandbox`），单独跑 **4/4 通过**。
这是 `docs/237` §4.3 已登记在案的并行负载 flake，本步未新增该现象。

---

## 4. 架构影响

- **不新增权限 / 审计 / 错误码体系**：网络是执行参数；失败判别落在既有 `RuntimeErrorCode` 的
  `details.reason`；证据落在既有 `tool_calls.output`。
- **Tool Runtime 仍是唯一执行路径**：分类与授权都在工具层，`assertCommandAllowed` 之前。
- **默认仍是 `none`**：`dependencyInstallAllowed` 缺省 `false`，没有任何生产调用点传它
  （第 4 步才做）。

### 已知限制

1. **分类是文本级的，不是执行级的。** `pnpm install` 里的 `install` 是 pnpm 的动词；如果项目
   的 `packageManager` 指向一个被篡改的 `node_modules/.bin/pnpm`，分类器看不出来。这条与
   `docs/236` §8「供应链恶意包不解决」是同一类残余风险，不是新引入的。
2. **install 期间的 `postinstall` 已禁用**（第 1 步的 `--ignore-scripts`），所以即使包有恶意
   安装脚本也不会执行——代价是依赖原生模块的项目装完不能直接用（`docs/237` §5 已记）。
3. **`dependencyInstallAllowed` 还没有任何生产赋值点**。当前只有测试与手工脚本会置真。
   把它接到夹具声明上是第 4 步。
4. **非 install 命令的失败信息里不会出现 `network` 字段**——这是刻意的（保持既有结果形状），
   但也意味着「这条命令没网」只能从没有该字段推断，而不是显式 `network: "none"`。

### 4.1 后续修正（2026-10-28，第 4 步之后、批次之前）

**缺陷**：`resolveNetwork()` 原先让**未指定 `network` 的命令继承构造级**（`return this.limits.network`）。
第 3 步时构造级恒为 `"none"`，这条继承分支从不生效，所以测试全绿；但第 4 步把
`frontend-vue` 的构造级改成 `"registry"` 之后，**每一条命令**（含 agent 自己写的任意 shell、
`build`、`test`、`preview`）都会拿到 registry 路——「按命令授予」退化成「按任务授予」，
本步做的分类等于白做。

实测确认（构造 `registry` + 不传 `network` + 容器内 `fetch` registry）：

```
未指定 network 的普通命令 → REGISTRY REACHABLE 200   ← 缺陷
修好后                     → BLOCKED (exit 3)          ← 正确
```

**修法**：未指定恒为 `"none"`；构造级 `network` 只作**能力上限**（决定能否被授予
`registry`），不再充当默认值。

```
显式 "registry" + 构造允许  → registry
显式 "registry" + 构造 none → 抛错（不能自行升级）
其余（不指定 / "none"）     → none
```

回归用例：`packages/sandbox/src/__tests__/networkGrant.test.ts` 新增两条
（未指定无网 / 显式才有网）。

> 这条缺陷的教训：**「默认值继承」这种语义在只有一个取值时无法被测出**。第 3 步的测试全部
> 显式传了 `network`，于是继承分支一次都没被走到。

### 4.2 实测发现的覆盖缺口：**项目脚本里的 install 拿不到网**

2026-10-28 的 F1 批次（`frontend-vue` + registry 已开）跑到 slice-1 时实测：

- agent 用 `run_build` 跑项目的 `deps` 脚本（`"deps": "pnpm install"`），**成功**装出了
  `node_modules`；
- 但 `ai-se-registry` 的访问日志里**一次都没有来自沙箱的请求**；
- 原因：`runSandboxCommand` 拆开看是

  ```
  resolved.command = "pnpm run deps"        ← 项目脚本，不是 install 形态
    ↓ isDependencyInstallCommand(...) = false
  network = undefined ⇒ none
  ```

  于是脚本**内部的** `pnpm install` 在无网容器里执行，只能命中镜像预热。

**这不是缺陷，是设计的直接后果**：分类器看的是**工具收到的命令字符串**，不是项目脚本的展开
内容——它不做、也不该做项目代码的静态分析。但它有一个必须写明的推论：

> **开网只对「agent 直接执行 install 命令」生效**（`run_command("pnpm install")`）。
> 如果项目把安装包装成 npm script（`deps` / `prepare` / `preinstall`），那条路径永远拿不到网，
> 只能依赖镜像预热。

对 F1 夹具而言无害（依赖集恰好在预热闭包里），但对「依赖面覆盖不了」的真实项目，**这是开网
仍然救不回来的那一半**。要覆盖它需要「按脚本名识别安装脚本」一类的规则，那会重新引入
「文本级分类不可靠」的问题（`§4` 已知限制 1），本步不做。

**已登记为 N-57**（`docs/232` §10），含机制 file:line、F1 二轮实证与三条候选做法。

**批次口径**：F1 批次的读数**不能**被解读为「开网已验证」。开网链路本身的验证见
`docs/240` §2.2（真实依赖 `none` 装不上 / `registry` 5.1s 装成），那里是直接 install 命令。

### 4.3 补修 N-57（2026-10-29）：脚本里的安装也能拿网

§4.2 记的缺口已修，判据仍落在**命令内容**上，只是把脚本**展开一层**：

```
pnpm run deps
  → scriptInvocationName("pnpm run deps") = "deps"
  → 沙箱内探测 package.json：scripts.deps = "pnpm install"
  → isDependencyInstallCommand("pnpm install") = true ⇒ network = registry
```

三种情况下仍然不给网：探测失败、脚本不存在、脚本体本身不是 install 形态
（带 `&&` / 管道 / 命令替换的脚本必然落到第三种）。**跳过探测**只用一份**黑名单**
（`test` / `build` / `lint` / `dev` / `start` …），因为声明式清单会随着 agent 换个脚本名而静默失效
——F1 二轮的 `deps` 正是 agent 自己起的名字，夹具模板里没有它。

真实链路实测（双向）：`{"scripts":{"deps":"pnpm install"}}` + 预热清单外的 `is-odd@3.0.1`，
授权时 `network=registry` 且 verdaccio 日志出现 `/is-odd` 与 `.tgz` 请求；不授权时同一条命令
`EAI_AGAIN`。详见 `docs/232` §10 N-57。

---

## 5. 未开始事项（STOP）

- **第 4 步：对夹具/项目开放 `registry`。** `dependencyInstallAllowed` 目前没有任何生产赋值
  点；接上它需要夹具/项目的声明面，且要保证默认仍 `false`。
- gVisor（`docs/236` §9 明确「只留位置」）。
- verdaccio 缓存容量策略（`docs/238` §5 已列为已知限制）。
- 私有 registry / 私有 git 依赖（`docs/236` §8 明确不解决）。
