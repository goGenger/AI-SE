# Sandbox and Security

> ## 基线状态（2026-10-15 逐条核实）
>
> 本文写于**平台实现之前**（第一版路线图的沙箱与安全设计），是**实现前设计**，不是 as-built 描述，
> **不构成开工依据**。原文一字未删（保留当初的设计意图），下面是对照现状的核实表：
>
> | 本文条款 | 与当前实现的关系 |
> | --- | --- |
> | 沙箱链 `Agent → Tool Runtime → **Policy** → **Sandbox Manager** → Docker Container → Command` | **两个中间级都不存在**。真实链：`ToolRuntime.execute` → 工具实现 → `context.sandbox.runCommand` → `docker run … sh -lc`（`packages/tool-runtime/src/ToolRuntime.ts`、`packages/sandbox/src/index.ts`）。**没有独立的 Policy 模块、也没有 Sandbox Manager**——`DockerSandbox` 既是管理器也是执行器。命令策略是**执行前的预检**，在 `packages/tool-runtime/src/tools/commandTools.ts`；`packages/action-policy` 是另一条线（browser / 外部动作），不在这条链上 |
> | 限制：CPU | **已实现**：`--cpus`（默认 1） |
> | 限制：memory | **已实现**：`--memory`（默认 512m） |
> | 限制：process count | **已实现**：`--pids-limit`（默认 128） |
> | 限制：execution timeout | **已实现**：`setTimeout(stop, timeoutMs)`（默认 30s） |
> | 限制：filesystem mount allowlist | **已实现**：`resolveWorkspace` + `isInside` 判定，且**只挂载 workspace 一个卷** |
> | 限制：network policy | **已实现**：`--network none` 默认（见下行） |
> | 限制：command policy | **有实现，但不是本文说的 allowlist**：它是**denylist**（`BLOCKED_COMMANDS` 正则 + 构建/测试类工具的 `scriptOnly` 限制）。**别把它当成白名单**——放行是默认态，拦截靠枚举 |
> | 「默认关闭网络」 | **成立**：`DEFAULT_LIMITS.network = "none"`（`packages/sandbox/src/index.ts`），只能经构造参数覆盖；有 e2e 探针验证 |
> | 禁止：host Docker socket | **间接成立**：`docker` 被列为阻断命令，且**没有任何 socket 挂载** |
> | 禁止：任意宿主机文件系统 | **成立**：挂载白名单 + 单卷挂载 |
> | 禁止：production credentials | **ABSENT——全仓没有任何相关代码** |
> | 禁止：SSH private key | **部分**：`ssh` / `scp` 被阻断，但**用文件工具读工作区里的 `id_rsa` 并没有被拦** |
> | 禁止：cloud credentials | **ABSENT——全仓没有任何相关代码** |
> | 禁止：未经策略允许的网络访问 | **成立**：`--network none` + 阻断 `curl` / `wget` |
> | Secret「不进入源码、Prompt、Graph State、普通日志和 Tool Result。需要时由受控 Secret Provider / 运行时注入」 | **机制已建**：`createEnvCredentialResolver` 把 `secret:<path>` 映射到 `MCP_SECRET_*` 环境变量（`apps/server/src/services/envCredentialResolver.ts`，在组合根接线），解析出的值只流向 `RemoteMCPClient.resolveHeaders` 的 `Authorization` 头与 `knownSecrets`，**错误信息不带值**；脱敏出口是 `sanitizeLogData` / `redactCredentialShapedText`（`packages/observability`）。**两处 caveat**：① 容器可带任意 `command.env`；② stdio 的 `env` 会**持久化进 `mcp_servers.env` 的 JSONB**——键经过校验，但**值是存下来的** |
> | 「HIGH/CRITICAL 操作进入 approval flow。生产部署、数据库迁移、环境变量修改等不得通过 Agent 私自绕过审批」 | **门存在，但三个例子里只有一个真被门挡着**。`withApprovalGate` 在未带 `metadata.approved === true` 时抛错；**生产部署确实被门控**（`deliver_release` / `rollback_release` 为 HIGH）。**数据库迁移与环境变量修改根本没有对应的 Agent 工具**——所以它们不是「被审批挡住」，而是**压根到不了**。写新交付工具时要自己接门，别以为有统一的兜底 |
> | 审计「至少记录」12 项（requestId / projectId / workflowRunId / taskId / agentRunId / toolCallId / toolName / riskLevel / status / duration / actor） | **10 项在，2 项不在审计类型上**：`ToolAuditInfo`（`packages/tool-runtime/src/types.ts`）有 requestId / projectId? / workflowRunId? / taskId / agentRunId / toolCallId / toolName / riskLevel / actor；**`status` 与 `duration` 只在 `ToolCallFinishedRecord` 上**，不在 `ToolAuditInfo` 里。若要「一条审计记录自含状态与耗时」，得另取那张记录 |
> | MCP 凭据「只能通过 credentialRef / secretRef → Secret Provider → MCP Connection」 | **成立**：`credentialRef` / `authRef` 按**引用**校验，明文被拒；stdio 的凭据形状 env 键被拒；endpoint 内嵌凭据被拒；再由 resolver 注入连接 |
> | 禁止把明文凭据写入 7 处（Prompt / State / Task I/O / Tool Result / Workflow Event / Audit Log / Git Repository） | **脱敏出口已接，但守卫方式与字面不同**。`sanitizeLogData` 已施加在：工具日志与审计、任务输出（`redactingTaskExecutor`）、证据（`packages/evidence/src/redact.ts`）、MCP 错误。**没有源码扫描测试、也没有针对 Git 仓库的守卫**——Git 只受命令 denylist 保护。**这 7 处的保护是「出口脱敏 + 命令拦截」，不是「入口禁止」** |
> | Remote MCP「必须采用受控 credential reference；AI-SE 不自建 OAuth Provider，不把 OAuth token 当普通业务字段持久化」 | **成立**：全仓 grep `oauth` **零命中**；任何迁移里都没有 OAuth / token 列，只有 `credential_ref` 与 `secret_reference` 两个引用列 |
> | MCP Apps「UI 必须运行在受控、沙箱化的 iframe 中」，链 `MCP App UI → Sandboxed iframe → Host Bridge → AI-SE controlled action → Tool Runtime`；「UI 不得直接访问宿主机文件系统、凭据或 MCP Transport」 | **成立**：iframe 的 `sandbox` 只开 **`allow-scripts`**（`apps/web/src/viewmodels/mcpAppBridge.ts`），配合 `srcdoc` 形成不透明源；Host Bridge 校验来源身份、严格 schema、参数体积上限，再转发到后端 `ToolRuntime`，且用 `blockedSandbox` 阻止 app 借用编码沙箱。UI 够不到凭据与 MCP Transport |
>
> **结论**：**这份文档的两半成熟度差得很远。** 「限制」那一半**基本都真在执行**（CPU / 内存 / 进程数 / 超时 / 挂载白名单 / 默认断网六项都有对应的 docker 参数），是本文最有价值的部分。但三处要修正：① **链上的 Policy 与 Sandbox Manager 两级都不存在**；② **command policy 是 denylist 不是 allowlist**；③ 「禁止」清单里的 **production credentials 与 cloud credentials 全仓没有任何代码**，SSH key 只挡了命令没挡读文件——**这三项是愿景，不是现状**。另有：审批门只覆盖生产部署，数据库迁移与环境变量修改是「没有工具」而非「被门挡住」；审计的 `status` / `duration` 不在 `ToolAuditInfo` 上；明文凭据的保护是**出口脱敏 + 命令拦截**，没有源码扫描或 Git 守卫。
> 依据：`AGENTS.md` §9「代码权威于文档；冲突必须报告，禁止默默改任一方来对齐」。

## Sandbox

第一版使用 Docker Sandbox：

```text
Agent
 ↓
Tool Runtime
 ↓
Policy
 ↓
Sandbox Manager
 ↓
Docker Container
 ↓
Command
```

## 限制

- CPU
- memory
- process count
- execution timeout
- filesystem mount allowlist
- network policy
- command policy

默认关闭网络。

## 禁止

- host Docker socket
- 任意宿主机文件系统
- production credentials
- SSH private key
- cloud credentials
- 未经策略允许的网络访问

## Secret

Secret 不进入源码、Prompt、Graph State、普通日志和 Tool Result。需要时由受控 Secret Provider/运行时注入。

## 风险控制

HIGH/CRITICAL 操作进入 approval flow。生产部署、数据库迁移、环境变量修改等不得通过 Agent 私自绕过审批。

## 审计

至少记录：requestId、projectId、workflowRunId、taskId、agentRunId、toolCallId、toolName、riskLevel、status、duration、actor。


## MCP Security Addendum

MCP 接入不能降低现有 Sandbox 和 Tool Runtime 的安全等级。

### Credential Rules

凭据只能通过：

```text
credentialRef / secretRef
        ↓
Secret Provider
        ↓
MCP Connection
```

禁止把明文 credential/token 写入：

- Agent Prompt
- Agent State
- Task Input/Output
- Tool Result
- Workflow Event
- Audit Log
- Git Repository

### Remote MCP

Remote MCP 使用 HTTPS/Streamable HTTP 时，连接认证必须采用受控 credential reference。

AI-SE 不自建 OAuth Provider，不把 OAuth token 当普通业务字段持久化。

### MCP Apps

MCP Apps UI 必须运行在受控、沙箱化的 UI 容器/iframe 中：

```text
MCP App UI
    ↓
Sandboxed iframe
    ↓
Host Bridge
    ↓
AI-SE controlled action
    ↓
Tool Runtime
```

UI 不得直接访问宿主机文件系统、凭据或 MCP Transport。
