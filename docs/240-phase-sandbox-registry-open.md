# 240 · 沙箱对夹具开放 registry（`docs/236` §10 第 4 步）实施记录

> **文档性质**：实施记录与验收报告。上游设计 `docs/236-sandbox-egress-design.md` §10。
> **本阶段只做第 4 步：对夹具/项目开放 `registry` 模式，默认不变。**
>
> 前置：第 1 步 `docs/237`（容器加固）、第 2 步 `docs/238`（registry 拓扑）、
> 第 3 步 `docs/239`（按命令授权）。
>
> **这一步之后 `docs/236` 的四步全部完成。**

---

## 0. 批次前的修正（2026-10-28）

第 4 步落地后、F1 批次启动前，实测发现第 3 步留下的一处语义缺陷：`resolveNetwork()` 让
**未指定 `network` 的命令继承构造级**。第 3 步构造级恒为 `none`，继承分支从不生效；第 4 步把
`frontend-vue` 的构造级改成 `registry` 后，**每条命令**都会拿到 registry 路——按命令授予退化
成按任务授予。

已修（未指定恒为 `none`；构造级只作能力上限），回归用例两条，细节见 `docs/239` §4.1。

---

## 1. 做了什么

### 1.1 出网能力写成 capability profile 的声明

```ts
export interface CapabilityProfile {
  // …
  /**
   * 本能力面允许的装依赖出网档位。缺省 `"none"`。
   */
  dependencyNetwork?: "none" | "registry";
}
```

| profile | 声明 | 理由 |
| --- | --- | --- |
| `backend-node`（默认） | `"none"` | 缺省 profile **零行为变化** |
| `frontend-vue` | `"registry"` | 前端依赖面**不可能**全预热（`docs/234` 的原始教训） |

选 `capability profile` 而不是新配置项，是因为 `docs/236` §10 的回滚列写的就是「**profile 切回
`none`**」——这一步只是把设计里已经写好的回滚手段变成可执行的字段。

### 1.2 三处接线

| 位置 | 作用 |
| --- | --- |
| `apps/server/src/index.ts` 的 `DockerSandbox` | `limits.network` 取 `profile.dependencyNetwork ?? "none"`（构造级上限） |
| `apps/server/src/index.ts` 的 `PersistentWorkflowTaskExecutor` | profile 为 `registry` 时注入 `dependencyInstallAllowed: true` |
| `AgentContext` → `ToolRuntimeBackend` → `ToolExecutionContext` | 透传到工具层，由 `docs/239` 的命令分类决定给不给网 |

`apps/server/src/services/agentRunService.ts` 那条链（单任务 agent run）**保持 `network: "none"`**
——它不是夹具/项目交付，没有理由获得出网。

### 1.3 为什么是三层而不是一个开关

```
profile.dependencyNetwork      ← 能力面声明（谁能出网）
  ↓
SandboxLimits.network          ← 构造级上限（这个沙箱最高到哪）
  ↓
SandboxCommand.network         ← 命令级授权（这一条命令给不给）
```

缺任何一层都会退化成「一个开关打开全链路」：第 3 步的 `resolveNetwork()` 保证命令不能超越
构造级，第 4 步的 profile 保证构造级不能凭空打开。

---

## 2. 验收（`docs/236` §10 第 4 步原文）

> 一次真实前端夹具跑通安装。

### 2.1 F1 夹具（`packages/eval/fixtures/F1/template`）

`network: registry` 下：`pnpm install --frozen-lockfile` → `pnpm build` → `pnpm test`，
**exit 0，11.6s**（install 9s / build 194ms）。

### 2.2 「真实依赖面」——这一步真正的判据

F1 模板的依赖恰好都在镜像预热里，跑通它**证明不了**放开 registry 的价值。所以另测一组
**镜像里没有预热、也不在 seed lockfile 里**的真实前端依赖：

| 包 | 用途 |
| --- | --- |
| `axios@1.12.2` | HTTP |
| `dayjs@1.11.13` | 日期 |
| `echarts@6.0.0` | 图表（大包） |
| `lodash-es@4.17.23` | 工具库 |

| 网络 | 结果 | 读数 |
| --- | --- | --- |
| `none` | **装不上** | exit 1，70.8s（pnpm 重试到 `EAI_AGAIN`），`ERR_PNPM_META_FETCH_FAIL` |
| `registry` | **装成** | exit 0，**5.1s** |

这正是 `docs/236` 开头那句「预热清单覆盖不了真实依赖面」的实测闭环。

### 2.3 平台装配链路端到端

用真实的 `ToolRuntimeBackend` + 真实沙箱，**同一份代码只换 profile**：

| profile | 结果 | `network` | 装到的包 |
| --- | --- | --- | --- |
| `frontend-vue` | success | `registry` | `dayjs@1.11.13`、`lodash-es@4.17.23` |
| `backend-node`（默认） | **失败** | —（无字段） | — `getaddrinfo EAI_AGAIN registry.npmjs.org` |

第二行是**默认不变**的证据：不配 `CAPABILITY_PROFILE` 时，行为与第 4 步之前完全一致。

### 2.4 profile 声明的不变量（4 条用例）

`packages/shared/src/capabilityDependencyNetwork.test.ts`：

1. `frontend-vue.dependencyNetwork === "registry"`；
2. `backend-node.dependencyNetwork === "none"`；
3. 默认 profile 就是 `backend-node`（不配即不出网）；
4. **两个已知 profile 都显式声明**该字段，不留 `undefined` 让调用方猜。

---

## 3. 门槛

| 项 | 结果 |
| --- | --- |
| `@ai-se/shared` typecheck / test | 通过 / **207 passed（15 files）** |
| `@ai-se/sandbox` test | **14 passed / 5 skipped**（registry 组需 env） |
| `@ai-se/tool-runtime` test | **99 passed（7 files）** |
| `@ai-se/agent-core` lint / test | 通过 / 见 §3.1 |
| `@ai-se/server` typecheck / lint | 通过 |

### 3.1 下游回归

| 项 | 结果 |
| --- | --- |
| `@ai-se/agent-core` lint / test | 通过 / **297 passed（40 files）** |
| `@ai-se/server` typecheck / lint / test | 通过 / 通过 / **487 passed / 1 failed（63 files）** |

server 的 1 条失败仍是 `v1GoldenScenario.e2e` 的 server-restart 用例（`waitFor timed out`），
与出网无关（它直接构造 `WorkflowService`，不经 `DockerSandbox`），单独跑 4/4 通过——
`docs/237` §4.3 已登记的并行负载 flake，本步未新增该现象。

---

## 4. 架构影响

- **不新增权限 / 审计 / 错误码体系**：出网是 profile 声明 + 执行参数。
- **Tool Runtime 仍是唯一执行路径**；agent 仍然看不到任何网络开关。
- **默认（`backend-node`）行为零变化**：`dependencyNetwork: "none"` ⇒ 构造级 `network: "none"`
  ⇒ 任何命令都无法请求 registry（`resolveNetwork` 抛错）。

### 已知限制

1. **开关是 profile 级的，不是项目级的。** 切到 `frontend-vue` 之后**所有**走这条执行器的项目
   都获得 registry 能力，而不是逐项目声明。要逐项目控制需要项目表加字段——那是另一件事，
   本步按 `docs/236` §10 的原文（「对夹具/项目开放」）做到 profile 粒度。
2. **registry 必须真的起着。** 没起 `ai-se-registry` 容器时，`frontend-vue` 的 install 会
   失败并报 `REGISTRY_UNAVAILABLE`（`docs/239` §1.4）——不会静默回退到「那就装本地预热的吧」。
3. **`agentRunService` 那条链仍无网**。它是单任务的调试/演示运行，不是项目交付；如果将来
   它也需要装依赖，要单独评估而不是顺手打开。
4. **`dependencyNetwork` 是构建期声明**（profile 是常量），改它要改代码 + 重建，不能靠环境
   变量切换。这与「默认不可被运维误开」是同一个取舍。

---

## 5. `docs/236` 四步全览（本步完成后）

| 步 | 内容 | 记录 |
| --- | --- | --- |
| 1 | 容器加固 | `docs/237` |
| 2 | registry 拓扑 | `docs/238` |
| 3 | 按命令授权 | `docs/239` |
| 4 | 对夹具开放 `registry` | 本文 |

**仍未做**（`docs/236` §9 / §11 明确排除或只留位置）：

- gVisor（更强的内核隔离）——只留位置；
- 供应链恶意包检测（lockfile 固定 + `--ignore-scripts` + 人工评审之外的办法）；
- 私有 registry / 私有 git 依赖；
- verdaccio 缓存容量策略（`docs/238` §5）。
