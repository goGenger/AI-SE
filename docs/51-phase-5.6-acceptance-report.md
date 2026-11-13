# Phase 5.6 验收报告 — Global Regression Gate(5.6 → 5.7)

> 项目:AI-SE
> 范围:全仓全部 workspace(typecheck / lint / test / build)+ 数据库 migration + 架构边界 + 安全边界 + bundle 扫描
> 执行日期:2026-09-13
> 命令基线:`corepack pnpm -r run typecheck / lint / test / build`(Node 22.22.2 nvm + corepack pnpm 12.3.4)
> 证据日志:`/tmp/gate6-tc.log`、`/tmp/gate6-lint.log`、`/tmp/gate6-test.log`、`/tmp/gate6-build.log`(本轮全新执行,未沿用任何历史结果)
> 说明:历史阶段报告(docs/35~42)仅用于确认变更事实;本报告的每项断言均以本轮实际工具输出与当前代码为准。

---

## 1. 结论

**GLOBAL REGRESSION: PASS / PHASE 5.6: FROZEN / PHASE 5.7: READY**

```text
TYPECHECK_EXIT=0
LINT_EXIT=0
TEST_EXIT=0
BUILD_EXIT=0
```

零修复即通过(§7 失败项为空);全仓 **543 passed / 0 failed / 0 skipped**;
架构与安全边界静态扫描全部干净;零残留容器。

## 2. 全局质量门禁(本轮全新执行)

| 门禁 | 结果 |
|---|---|
| Full typecheck | **PASS**(exit 0) |
| Full lint | **PASS**(exit 0) |
| Full test | **PASS**(exit 0) |
| Full build | **PASS**(exit 0) |
| Database migrations | **PASS**(fresh-PG e2e 全绿,见 §4) |
| Migration checksum | **PASS**(sha256 校验路径真实执行,无 mismatch;见 §4) |
| Integration / E2E | **PASS**(docker Postgres / 真实 Chromium / stdio+HTTP MCP fixtures) |

### 2.1 测试明细(Total 543 / Passed 543 / Failed 0 / Skipped 0)

| 包/应用 | 测试数 | 内容 |
|---|---|---|
| mcp | 201 | 契约/客户端/registry/resource-prompt/federation/apps(stdio + Streamable HTTP 真实协议 fixture) |
| visual | 83 | 5.6-1 分析(26:realInputProviders 12 + visualAnalyzer 14)+ 5.6-2 转换(13)+ 5.6-4 评估(15)+ 5.6-5 自动修复(16)+ 5.6-6 验证(13) |
| web | 51 | console 视图 + mcpSecurity(bridge 拒绝矩阵)+ mcpAppBridge |
| server | 49 | API e2e(projects/agents/planning/workflow/delivery/agentRunPersistence/mcpConsole/mcpApps)+ 5.6-5 visualFixLoop.e2e + 5.6-6 uiStateValidation.e2e |
| shared | 39 | 基础 schema + 5.6-0 Visual Contract(视觉输入/规格/令牌/组件图) |
| agent-core | 37 | AgentRuntime(agentGraph/agentRunner/agentState/codingAgent/llmProvider/TaskContext/ToolRuntimeBackend)+ frontendTask(5.6-2 含 Docker e2e) |
| database | 33 | migrate + 仓库层 + 5.5 联邦/注册表 e2e(fresh PG 容器) |
| browser | 21 | 5.6-3 session + 真实 Chromium e2e + network e2e(5.6-3 Repair)+ responsive e2e + interaction e2e(5.6-6) |
| workflow-engine | 14 | 任务状态机 / DAG / scheduler(retry 语义) |
| tool-runtime | 11 | ToolDefinition / 审计 / 错误规范化 |
| observability | 2 | 日志脱敏单源 |
| sandbox | 2 | Docker 沙箱边界 |
| **合计** | **543** | **0 failed / 0 skipped** |

### 2.2 Phase ↔ 测试映射

| 阶段 | 证据 |
|---|---|
| Phase 0–4(核心平台) | agent-core 37 + workflow-engine 14 + tool-runtime 11 + sandbox 2 + database 33 + server API e2e + web 51 |
| 5.5-0 ~ 5.5-7 | mcp 201(stdio/remote/third-party 真实协议)+ database mcpFederation/mcpRegistryStore/mcpRemoteFederation e2e + server mcpConsoleApi/mcpAppsApi e2e + web mcpSecurity/mcpAppBridge/mcpViewModel |
| 5.6-0 | shared visualContract.test.ts(输入 URI 契约 / VisualInputRecord / UI Specification / Design Tokens / Component Map 冻结) |
| 5.6-1 | visual visualAnalyzer.test.ts + realInputProviders.test.ts(screenshot/figma/url 三链路;live 外网 e2e 见 §6) |
| 5.6-2 | visual converter.test.ts + agent-core frontendTask.test.ts + frontendTask.e2e.test.ts(Docker 真实改码闭环) |
| 5.6-3 | browser browserSession.test.ts + browser.e2e.test.ts + network.e2e.test.ts(真实 Chromium:4xx/5xx/requestfailed/console/runtime/超时/取消) |
| 5.6-4 | visual evaluation.test.ts(结构 diff 四通道 + 像素 + 评分链 + 热力图) |
| 5.6-5 | visual autoFix.test.ts + server visualFixLoop.e2e.test.ts(真实 Agent/ToolRuntime/DockerSandbox/Chromium 四场景闭环) |
| 5.6-6 | visual validation.test.ts + server uiStateValidation.e2e.test.ts(十态真实触发)+ browser responsive/interaction e2e |

## 3. 数据库回归

- 全部 migration 在 fresh 容器真实执行:database 包 8 个测试文件(migrate / 仓库层 /
  联邦 3 个 e2e)各自启动独立 postgres:16-alpine 容器并跑 `runMigrations`,全绿;
- **checksum 校验**:`packages/database/src/migrate.ts` 以 sha256 逐文件比对
  `schema_migrations.checksum`,变更即 `throw Migration checksum changed`;
  本轮无任何 mismatch(校验路径随每次 fresh 执行真实走通);
- **Restart recovery**:`packages/database/src/mcpFederation.e2e.test.ts`
  "recovers after a restart without re-discovery and keeps revocations revoked"
  + `packages/mcp/src/__tests__/persistentRegistry.test.ts`
  "restores state after a restart and keeps revocations revoked"(真实 PG);
- Agent Run / Workflow Run / Tool Call / Workflow Event / Task 持久化:
  agentRunStores / workflowRepositories / planningRepositories / deploymentRepository
  + server agentRunPersistence.e2e / workflowApi.e2e / deliveryApi.e2e 全绿。

## 4. 架构边界回归(源码级扫描实证,全部干净)

| 检查 | 结果 |
|---|---|
| agent-core / workflow-engine 不依赖 `@ai-se/mcp` | ✅ 空命中 |
| agent-core 无 `MCPClientPort/MCPRegistry/MCPClient` 直连 | ✅ 空命中 |
| agent-core 不依赖 `@ai-se/browser`,无 playwright 引用 | ✅ 空命中 |
| `playwright` 导入面 | ✅ 仅 `packages/browser/src/playwrightAdapter.ts` 一处 |
| visual → browser / browser → visual 反向依赖 | ✅ 均无实际 import(仅注释提及) |
| browser → mcp(`@ai-se/mcp` / `@modelcontextprotocol`) | ✅ 空命中 |
| web 不依赖 `@ai-se/mcp` / `@modelcontextprotocol`(安全测试除外) | ✅ 空命中 |
| web 不依赖 `@ai-se/visual` / `@ai-se/browser` | ✅ 空命中 |
| 单例运行时(`ToolRuntime` / `BrowserSession` / `WorkflowEngine` 类定义) | ✅ 各恰好 1 处 |
| `evaluateVisuals` 定义 | ✅ 唯一(`packages/visual/src/evaluation.ts`) |
| server 无 MCP 协议代理端点(`tools/call` / `jsonrpc`) | ✅ 空命中(仅测试) |
| 第二套治理系统(ApprovalEngine / PermissionEngine / SecretManager / MCPSecretStore) | ✅ 空命中 |
| web 生产 bundle:MCP client token(`modelcontextprotocol`/`MCPClientPort`/`StdioMCPClient`/`tools/call`/`jsonrpc`) | ✅ 零命中 |
| web 生产 bundle:bridge 常量 `ai-se.mcp-app` | ✅ 存在(桥已随构建发布) |
| web 生产 bundle:playwright / visual / browser 泄漏 | ✅ 零命中 |
| 零残留容器(`docker ps | grep aise`) | ✅ 0 |

边界链保持:`Workflow Engine → Agent Runtime → ToolRuntime → Native Tool / MCP Tool /
Browser Tool → External System`;Agent 侧仅经 ToolRuntime,MCP 与 Browser 动作均经
ToolRuntime,无直连路径,无第二套 Runtime。

## 5. 安全回归

- **治理单源**:Permission / Policy / Approval / Audit / Timeout / Cancellation /
  Error normalization / Secret redaction 全部沿用既有体系,无第二套(扫描见 §4);
- **脱敏单源**:`redactCredentialShapedText` / `redactString` 仅存在于
  `@ai-se/observability`;5.6 新增面(浏览器证据、评估报告、自动修复审计、
  验证报告)全部经该单源脱敏(各自测试含泄漏反例);
- **凭据隔离**:浏览器上下文创建不注入任何凭据(`browser.newContext()` 无参数,
  无 cookie/storage 注入);visual/浏览器证据中 credential-shaped 内容走脱敏;
  web bundle 无 MCP client 代码;iframe 保持 sandbox,无 credential / parent DOM
  权限 / 后端通道(web mcpSecurity / mcpAppBridge 拒绝矩阵全绿);
- **ToolRuntime 边界**:5.6 的浏览器动作(导航/视口/截图/交互)与视觉产物均
  经由既有执行/证据/归一化面,未新增独立 Permission / Audit / Error 系统。

## 6. 外部验证状态(5.6-1,必须单独报告)

| 项 | 状态 |
|---|---|
| 5.6-1 Implementation(screenshot / figma / url 三链路 + 真实 VLM Provider 接口 + 统一规格 + schema 校验 + 脱敏) | **PASS**(本地 mock HTTP e2e 全绿) |
| 5.6-1 External Live Validation — OpenAI 兼容 vision(真实外网截图辨识) | **BLOCKED BY EXTERNAL CONFIG**(当前环境无 API key;`env` 复查 0 命中;不伪造 PASS) |
| 5.6-1 External Live Validation — Figma REST(真实 token) | **BLOCKED BY EXTERNAL CONFIG**(同上) |

说明:两 provider 均为凭据注入型设计(`baseUrl` / `token` 参数化),接入真实凭据后
无需代码改动即可执行 live e2e;当前按任务书要求显式标记,不计入 PASS 伪装。

## 7. 失败项

**无。** 本轮零修复通过(不存在需要定位/最小修复的回归)。

## 8. 技术债务(既有记录,本轮零新增,均不阻塞 5.7)

| 编号 | 项 | 来源 |
|---|---|---|
| TD-1 | 3 条 ARCHITECTURE WARNING(平台统一化缺口) | docs/28 |
| TD-2 | 独立 MCP App action 暂不写 `tool_calls`(FK 需真实 agent_run_id;recorder 为 DI,接入后直接复用) | docs/33 |
| TD-3 | `_meta.ui` 仅识别 `{ ui: { resourceUri } }` 稳定结构 | docs/33 |
| TD-4 | App 页面手工输入 projectId / agentName(Console 无登录态) | docs/33 |
| TD-5 | `ui://` HTML 无净洗 —— 安全边界完全依赖 iframe sandbox(设计选择) | docs/33 |
| TD-6 | Marketplace / OAuth / Resource-Prompt 持久化 / Apps 管理后台未实现(严格边界) | docs/31/32/33 |
| TD-7 | agent 绑定用 agent_name(无 agents 表,契约即 agentName) | docs/29 |
| TD-8 | 5.6-1 外部 live e2e(OpenAI / Figma)待凭据 | docs/45 |
| TD-9 | shared 状态枚举保持冻结(7 值);active/expanded/modal 为 5.6-6 验证层词汇,如需注记属契约变更任务 | docs/50 |
| TD-10 | Browser 7 工具注册表未扩充;UI 状态触发驱动在会话层,Agent 自主驱动待工具面评审 | docs/50 |
| TD-11 | 5.6-5/5.6-6 E2E 使用确定性模型替身(真实 VLM 为生产注入点) | docs/48/49/50 |
| TD-12 | `net::ERR_ABORTED` 过滤为有意语义(客户端取消非网络故障);如未来需要取消证据须新增独立 kind | docs/47 |
| TD-13 | `allowedHosts` 为接口位未消费(延续 5.6-3 口径);`BROWSER_TIMEOUT` 保留未使用 | docs/47 |

以上均为既有记录或阶段报告的显式 Known Limits;不构成当前 Regression,不破坏安全
边界,不阻塞 Phase 5.7。docs/42(旧 pre-5.7 回归)曾列的 3 项留白(hover 捕获 /
requestfailed 通路 / 真实 VLM provider)已分别在 docs/47 / docs/50 / docs/45 中关闭。

## 9. Phase 5.7 就绪声明

1. **Phase 5.6 是否完整完成?** — 是。5.6-0~5.6-6 全部目标达成(docs/17 §Phase 5.6
   全项 [x];5.6-1 实现 PASS,仅外部 live 凭据项按 §6 显式 BLOCKED)。
2. **是否存在 Regression?** — 无。全仓 543/543 零失败;架构/安全/边界扫描全干净;
   冻结契约(5.6-0 视觉契约、ToolRuntime 模型、MCP 契约、错误码)无任何修改。
3. **是否存在阻塞问题?** — 无。TD-1~TD-13 均不阻塞。
4. **5.6-1 外部 live E2E 状态?** — BLOCKED BY EXTERNAL CONFIG(OpenAI / Figma
   凭据缺失,复查确认;不伪装 PASS)。
5. **是否需要技术债务 Deferred?** — 是,§8 全部 DEFERRED。
6. **是否实现了任何 Phase 5.7 功能?** — 没有。5.7 行为开发零触碰;既有 docs/43
   (5.7-0 Computer Use Contract)为本回归周期之前的契约冻结,无行为实现。

---

## 最终结论

```
GLOBAL REGRESSION: PASS
PHASE 5.6: FROZEN
PHASE 5.7: READY
```

*本报告基于 2026-09-13 完整全局回归(全 typecheck / lint / test / build / 数据库
migration / 架构与安全静态扫描 / bundle 扫描)的实际工具输出;所有断言数字可由
`/tmp/gate6-*.log` 复查。5.6-1 外部验证按任务书要求单独报告,BLOCKED 未伪装 PASS。*
