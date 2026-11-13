# Phase 5.7-2 External Engineering Systems — Completion Report

> 项目:AI-SE(Computer Use / External Engineering Tools)
> 阶段:Phase 5.7-2(External Engineering Systems / MCP 通道)
> 状态:**PASS**
> 完成日期:2026-09-13
> 开发模式:ponytail(复用 5.5 冻结面,零新传输/零新权限/零直连外部 API)+ 以代码为准
> 参考:docs/17 §5.7-2、docs/24、docs/43(5.7-0 契约)、docs/52/53(5.7-1/Repair)

---

## 1. Status

**PASS** — 任务书 §3 必须实现项与 docs/17 §5.7-2 六项全部达成;真实 MCP stdio +
credentialRef 真实 Streamable HTTP 注入 E2E 锁定;全仓 **591/591** 四门禁 exit 0。

建立并验证:

```text
External System
    ↓
MCP Client          (5.5-1 stdio / 5.5-4 Streamable HTTP,冻结面)
    ↓
ExternalToolDefinition   (catalog 声明 + 平台侧 risk/审批)
    ↓
ToolDefinition      (既有统一形态:schema/permission/risk/execute)
    ↓
ToolRuntime         (既有治理:验证/审计/超时/取消/错误规范化)
    ↓
ActionResult        (5.7-0 冻结契约,与 5.7-1 同构)
```

概念覆盖:GitHub / Issue / Project / 文档 / CI-CD(以 catalog 分类承载;
本阶段只建立统一接入能力,fake/echo harness 验证,**不实现真实平台集成**)。

## 2. 修改/新增文件

| 文件                                                                | 状态    | 说明                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/mcp/src/external/catalog.ts` **新**                       | +170 行 | `ExternalToolCatalog`:外部系统声明(身份/分类/声明式 tool 清单/平台侧 risk+审批)+ `resolvePolicy`(远程自报零信任,未声明 DENY)+ `policyProvider()` + `servers()` + `credentialRefFor()` |
| `packages/mcp/src/external/connector.ts` **新**                     | +160 行 | `ExternalEngineeringConnector`(连接/发现/映射/描述子)+ `createExternalToolRegistry` + `toExternalToolDefinition`(动作输出包装)                                                        |
| `packages/mcp/src/external/outcome.ts` **新**                       | +150 行 | 统一外部动作输出(5.7-0 ActionResult + 不受信 result)、结构化脱敏、治理级失败判定                                                                                                      |
| `packages/mcp/src/testing/external-system-entry.js` **新**          |         | mock 外部工程系统(fake GitHub-like,官方 SDK,真实 stdio,CJS)                                                                                                                           |
| `packages/mcp/src/testing/externalSystemServer.ts` **新**           |         | 夹具(server 定义/目录声明/敌意载荷常量/凭据引用)                                                                                                                                      |
| `packages/mcp/src/index.ts`                                         | 修改    | barrel 导出(外部面 + 夹具)                                                                                                                                                            |
| `packages/mcp/package.json`                                         | 修改    | build 脚本追加复制 external-system-entry.js                                                                                                                                           |
| `packages/mcp/src/__tests__/externalToolCatalog.test.ts` **新**     |         | 目录单元 7 例                                                                                                                                                                         |
| `packages/mcp/src/__tests__/externalConnector.test.ts` **新**       |         | 连接器单元 16 例                                                                                                                                                                      |
| `packages/mcp/src/__tests__/externalEngineering.e2e.test.ts` **新** |         | 真实 MCP E2E 8 例(stdio 7 + 凭据 HTTP 1)                                                                                                                                              |
| `apps/server/src/__tests__/externalEngineering.e2e.test.ts` **新**  |         | Agent 链路 E2E 2 例(权限门 + 边界静态)                                                                                                                                                |

**零修改**:tool-runtime、agent-core、browser、visual、shared(5.7-0 契约原样)、
workflow-engine、5.5 冻结面(contracts/client/integration/registry 全部原样)。

## 3. ExternalToolCatalog

- 声明单元:`{id, displayName, category(source-control/issue-tracker/project-management/
documentation/ci-cd), server(完整 5.5-0 MCPServerDefinition), tools:[{name, riskLevel,
requiresApproval}], description?}` — zod strict;
- `server` 经**冻结的 `validateMCPServerDefinition`** 校验(reference-only credentialRef,
  plaintext 一律拒绝;stdio 配置必须存在);
- **risk 零信任**:`resolvePolicy(serverId, toolName)` 只接受两个 id,不看任何远程字段;
  未声明 tool → `undefined` → 冻结可见性链按 DENY 处理(fail-closed,双向兜底:
  声明了但未发现的 tool 不出现在可见列表,发现但未声明的 tool 恒不可用);
- `policyProvider()` 直接插入 `MCPToolRegistry.policyProvider` 槽位——零新策略系统;
- `credentialRefFor(systemId)` 只回引用,永不回秘密。

## 4. MCP Connector

- `createExternalToolRegistry({client, catalog, approvalGate})`:以 catalog servers 构造
  既有 `MCPToolRegistry` — 可见性链(server 启用 → project binding → agent binding →
  tool 允许 → policy 允许)完全复用,零新逻辑;
- `ExternalEngineeringConnector.connectAll()`:逐系统 `connectAndDiscover`(真实
  MCP initialize + tools/list);`ensureRegistered()` 幂等注册;
- `descriptors(query)`:外部元数据视图(systemId/category/serverName/risk/审批);
- `toolDefinitions(query)`:对每个「声明 ∩ 已发现 ∩ 可见」的 tool,经 **5.5-2
  `createMCPToolAdapter` + `toUnifiedToolDefinition`** 映射为既有 `ToolDefinition`
  (schema 单源 = JSON Schema→Zod 转换结果;call-time 可见性复检;审批门 fail-closed);
- **零直连面**:`packages/mcp/src/external/**` 静态扫描无 `node:http/https/net`、
  `fetch(`、`undici`、`axios`、`child_process`(测试锁定)——外部系统只能经 MCP。

## 5. ToolDefinition mapping

```text
ExternalToolDefinition(输出 ExternalToolOutcome)
  = 既有 ToolDefinition{name, description, riskLevel, inputSchema, execute}
    + execute 包装:冻结 5.7-0 ActionResult + 不受信 result 数据
```

不创建第二套 ToolDefinition:风险/审批来自 catalog,执行经 adapter 与既有 4 件套
(schema 验证/ToolRuntime 执行/权限/审计)。`releases.publish`(HIGH + 审批)与
`issues.create`(MEDIUM)逐例断言映射结果(risk 不来自远程)。

## 6. ActionResult

严格复用 5.7-0(与 5.7-1 同构;不新增第二套):

```text
ExternalToolOutcome {
  actionResult: ActionResult   // resultId / actionRef(source:"mcp", serverName, toolName,
                               // callId) / status success|failed|cancelled / error? / 计时
  result?: unknown             // 外部系统载荷,作为 DATA(不受信),已结构化脱敏
}
```

分层语义(与 5.7-1 完全同构,报告明示):**治理级失败留在 ToolResult 封套** ——
验证 `TOOL_ERROR`、超时 `TIMEOUT_ERROR`、取消 `CANCELLED_ERROR`、权限拒绝/审批拒绝
(adapter 门,零请求);**已执行动作的结果** —— 成功 / 远程失败映射为
`actionResult.status=failed`(error.code 取 MCP 分类,如 `MCP_REMOTE_TOOL`;
5.7-5 冻结词表前为占位字符串);预取消信号(直调路径)→ `status=cancelled` +
`cancelledAt`。

## 7. Security

- **credentialRef 注入接口**:引用存于系统声明的 server 定义 → 既有
  `MCPCredentialResolver`(5.5-4)在连接受控路径解析 → `Authorization: Bearer ***
注入真实 Streamable HTTP 连接;E2E 断言 resolver **只收到引用**、resolved secret
**零出现**于 ToolResult/审计、`authFailures=0`;plaintext credentialRef / 凭据形状
  key 在目录校验即拒绝;
- **不受信外部数据**:外部返回一律以 DATA 进入 `result`(ToolResult / Agent context);
  层内零解释、零执行;控制通道(status/error/actionRef/Result 封套)永不承载载荷;
- **敌意载荷实景测试**(真实协议下行):prompt injection(IGNORE ALL PREVIOUS
  INSTRUCTIONS…"触发动作"指令)、fake system message、malicious markdown(含隐藏
  HTML 注释/危险指令)、malicious link、fake tool-result JSON、credential-shaped
  内容 —— 全部以惰性数据通过;确切只产生 1 次 fixture 调用、无法触发任何其它动作;
  凭据形状内容经共享脱敏单源输出 `[REDACTED]`;
- **未授权 → 零 MCP 请求**:三重证据 —— (a) 无绑定查询可见 tool 为空且零请求;
  (b) 定义构建后撤销绑定 → call-time 复检拒绝 + 计数 0;(c) Agent 层权限门拒绝
  (ToolRuntimeBackend)→ 零请求且零审计;
- **Agent 零直连**:边界静态测试锁定 agent-core 无 `@ai-se/mcp` / octokit / http(s)
  / fetch 导入;`Agent → ToolRuntime → MCP → External Tool` 全程唯一路径。

## 8. E2E(真实 MCP)

- **mock 外部工程系统**(fake GitHub-like:issues.list/create、ci.status、docs.search、
  issues.fail、issues.slow、releases.publish、fixture.hostile)以**官方 SDK stdio 子进程**
  真实运行;客户端 = 生产 `StdioMCPClient`;registry/connector/ToolRuntime 全生产路径;
- 覆盖:目录发现(8 tool)、完整链路(issues.create → ActionResult success + result
  {id:"ISS-101"} + 审计 started/finished)、远程失败映射、审批 fail-closed/拒绝/通过
  (通过后真实执行)、超时(慢调用 + 运行后可继续)、未授权零请求、敌意载荷、
  credentialRef 真实 Streamable HTTP 注入(echo 工具 + auth 头 + hits.authFailures=0);
- **Agent 链路**(apps/server):AgentPermissions.tools 权限门 → ToolRuntimeBackend →
  ToolRuntime → 外部系统(真实 stdio),拒绝零请求、许可真实执行 + 审计、敌意数据惰性。

## 9. Regression

- mcp **232/232**(201 基线 + 31 新)、server **53/53**(51 + 2 新);全仓 **591/591,
  0 failed**;四门禁 `TYPECHECK/LINT/TEST/BUILD = 0`;零残留容器;
- 5.7-1 browser 34/34、5.6 系与 Phase 0–5.5 全部数值不变(零回归);
- Prettier 全绿(8 个新/改文件经 --write)。

## 10. Known Limitations

1. **真实平台集成未实现**(任务书边界):无 GitHub/CI-CD 生产连接器、无真实平台凭据;
   fake/echo harness + credentialRef 接口就绪,真实系统接入 = 后续任务;
2. `error.code` 为占位字符串(`MCP_<CATEGORY>`),失败分类词表冻结在 5.7-5;
3. CONNECTION / RATE_LIMITED / INTERNAL 等「已尝试但失败」统一切入
   `actionResult.status=failed`(报告 §6 映射决策;5.7-5 可细化重试语义);
4. 审批门为平台注入式(与 5.5-2 相同槽位);统一风险策略表归 5.7-3,本阶段只在
   catalog 声明 risk/审批,**不建统一策略**(未越域);
5. Observation/Evidence 与 ActionResult 的关联挂 5.7-4;失败恢复归 5.7-5;
6. 环境观察:`deliveryLifecycle.e2e`(Phase 6 遗留 docker 重型用例)在本阶段多次
   单跑中呈间歇性失败(healthy/rollback 相位随机,9.5s~21s 快速失败)后连续通过;
   快照证实有测试运行时流程正确(healthy SUCCESS → broken FAILED(/health,设计内)→
   ROLLBACK SUCCESS),与 5.7-2 改动无路径交集(不 import mcp);全量门禁中通过。
   记录为**环境性瞬时 flake**,未修饰、未修改该用例。

## 11. Boundary(严格禁止项核对)

未实现/未触碰:Action Policy、统一风险策略、Evidence persistence/API、Failure
Recovery、Re-plan、GitHub/CI-CD 生产集成、新 Permission/Approval/Audit、第二套
Tool Runtime/MCP 客户端/外部直连面。5.7-3/4/5 零开始。
