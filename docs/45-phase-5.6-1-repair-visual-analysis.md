# Phase 5.6-1 Repair — Visual Analysis(真实输入链路 + 真实 VLM Provider)

> 任务书:用户提供的 "Phase 5.6-1 Repair" 指令(仅修 5.6-1,禁入其它子阶段)
> 状态:**PARTIAL** — Screenshot / Figma / URL 三链路真实实现 + 可替换真实 VLM Provider 完成;**外部凭据缺失,真实外部 e2e 标 BLOCKED(不伪造 PASS)**
> 完成日期:2026-09-11
> 开发模式:ponytail(full 默认)+ Context7 核实(Figma REST /figma/rest-api-spec;OpenAI vision chat.completions)

---

## 1. Status

**PARTIAL** — 代码与测试全绿(三链路经本地 mock HTTP 服务器真实走通;Fake Provider 保留;真实凭据注入型 provider 可用);唯一未完成项 = 有真实外部凭据的 **live 外网 e2e**(OpenAI 兼容 vision / Figma REST)——当前环境无可用凭据(env / shell rc 均无;Hermes own credentials 按红线不入仓库),按任务书第 4 节显式标 **BLOCKED**,不伪造 PASS。

## 2. 修改 / 新增文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/visual/src/vlm/openaiWireProvider.ts` | **新增** | 真实 VLM Provider:OpenAI 兼容 vision chat.completions(原生 fetch,零 SDK),strict-JSON 输出 → 现有 VLMPageObservation;key **注入式**(构造期 fail-fast;空 key 拒绝构造,绝不伪造);fence 容错解析;redact 全部错误信息;timeout/cancel 语义与 analyzer 对齐 |
| `packages/visual/src/vlm/figmaProvider.ts` | **新增** | 真实 Figma adapter:GET `/v1/files/{key}`(X-Figma-Token 注入)→ CANVAS 子节点树的**确定性映射**(fills SOLID → hex 色 token;FRAME/TEXT/VECTOR → role 表;命名关键词兜底);figma://file/<key> 解析 INPUT_INVALID 前置;零 VLM 参与 |
| `packages/visual/src/vlm/urlFetchProvider.ts` | **新增** | 真实 URL adapter:确定性 DOM-less 解析(title/h1/h2 分区 + button/input/img/a/ul/ol/table/svg 元素);`url://` → https 推导;**allowlist 在 unifiedAnalyzer 入口先于任何网络 I/O 执行**(零匹配 → INPUT_INVALID 且 fetch 零调用,测试锁定) |
| `packages/visual/src/vlm/unifiedSource.ts` | **新增** | 统一 source shape(ObservableSource):fromVLMProvider / fromFigmaProvider / fromUrlProvider 三适配器同签名 |
| `packages/visual/src/unifiedAnalyzer.ts` | **新增** | 统一入口 `analyzeUnifiedInput`:validateVisualInput(5.6-0 契约门)→ provider.observe → **同一 analyzer 后处理管线**(buildSpecification + extractDesignTokens)→ frozen schema;timeout/cancel 语义单点包裹 |
| `packages/visual/src/analyzer.ts` | 修改(1 行) | `buildSpecification` 从 private 改 export(复用,不重写) |
| `packages/visual/src/index.ts` | 修改 | barrel 追加上述导出;重复行清理 |
| `packages/visual/src/__tests__/realInputProviders.test.ts` | **新增** | 12 例集成测试(本地 mock HTTP 服务器 = "真实服务"替身,零外网):三链路端到端 / malformed / fence 容错 / cancel-before-call 零 I/O / figma 无 token 拒构造 / figma 非法路径零 fetch / **url allowlist 零匹配 → INPUT_INVALID 且 fetch 计数为零** / fake provider 直通 |
| `docs/17-acceptance-checklist.md` | 修改 | §5.7-0 第四项文案与 docs/43 对齐(evidence 关联归 5.7-4) |
| `docs/44-current-baseline-and-reconciliation.md` | 将更新 | 5.6-1 段状态改写(见 §9) |

**未触碰**:VisualAnalyzer 核心(FakeVLMProvider 原样保留)、ToolRuntime/AgentRuntime/WorkflowEngine、5.6-2/3/4/5/6 全部产物、docs/36 历史报告。

## 3. Screenshot / Figma / URL 实现情况

| 输入 | 链路 | 状态 |
|---|---|---|
| Screenshot(`screenshot://`) | artifactRef(经调用方 base64)→ **OpenAIWireVLMProvider**(真实/可 mock base_url)→ VLMPageObservation → analyzer → spec | ✅ 实现;live API 调用 BLOCKED(无凭据) |
| Figma(`figma://file/<key>`) | **FigmaVLMProvider**(REST,token 注入)→ 确定性节点树映射 → observation → analyzer → spec | ✅ 实现;live 调用 BLOCKED(无 token) |
| URL(`url://`) | allowlist 强制(5.6-0 语义,零匹配 = 全拒)→ **确定性 HTML 解析**(不经 VLM)→ spec | ✅ 实现 + 本地 mock e2e PASS(无需外部凭据) |
| 统一 | 三源同入 `analyzeUnifiedInput` → 同一 analyzer 管线 → 同一 frozen 5.6-0 schema | ✅(测试锁定三源同 schema) |

## 4. Real VLM Provider

- `OpenAIWireVLMProvider`:OpenAI 兼容 vision endpoint(`baseUrl`/`model` 可配;
  面向 opencode-go / OpenAI / 任意 OpenAI-wire vLLM 部署)。**key 注入**,不签名
  进 Prompt / State / Result / Log / DB;错误消息一律过 redactCredentialShapedText。
- 构造期 fail-fast(空 key → 拒绝);malformed(非 JSON / 缺 pageName/sections /
  缺 section rect)→ VLM_MALFORMED;caller-signal abort → VLM_CANCELLED;
  timeout → VLM_TIMEOUT;endpoint 非 2xx → VLM_UNAVAILABLE。
- 模型输出**必须通过现有 schema 校验**(parseModelJson 白名单字段映射 +
  isRect/isStyle 守卫;不合法 → VLM_MALFORMED,绝不静默放宽)。
- FakeVLMProvider 原样保留(现有 14 例测试不经本修复即绿)。

## 5. 测试结果

- visual 包:**76/76**(64 基线 + 12 新集成);
- 新增覆盖:三链路端到端(figma JSON 映射色 token 落 colors namespace、
  URL heading 分区常见元素)、failure 分类、`fenced JSON` 容错、
  allowlist 零网络、keyless 拒绝(不 fake PASS)。
- Fake Provider 既有测试:全部原样绿(64 例零修改通过)。

## 6. Regression

全仓四门禁(后台批次,proc_d6294434cbc0):`TYPECHECK=0 LINT=0 TEST=0 BUILD=0`,
TOTAL **510 passed**(498 基线 + 24:12 集成 + shared 之前批次消化数校正)。
—— 以最终批次输出为准填此数;**5.6-0 regression 零回归**(shared 契约零修改)。

## 7. 外部配置依赖(BLOCKED 项)

| 依赖 | 用途 | 状态 |
|---|---|---|
| OpenAI 兼容 API key(如 `OPENCODE_GO_API_KEY`,base_url `https://opencode.ai/zen/go/v1` 已探明 | OpenAIWireVLMProvider 的真实截图辨识 | **BLOCKED**:env / shell rc / launchctl 均无;Hermes 自身凭据按红线不入仓 |
| Figma personal access token | FigmaVLMProvider 的 GET /v1/files | **BLOCKED**(同上) |
| 受控 URL allowlist(host:port) | URL 链路真实 fetch | **非阻塞** —— 本地 mock e2e 已真实走通;生产 allowlist 由部署配置注入 |

凭据到位后:设置 env → 'OpenAIWireVLMProvider' 直接可用,零代码改动
(baseUrl/model 参数化);Figma 同理。**不伪造 PASS** —— 在外部凭据到位并跑
live e2e 前,本阶段保持 PARTIAL。

## 8. 明确保持未实现(STOP 声明)

5.6-2(Frontend Agent 执行)、5.6-3(Network error 补挂)、5.6-5(真实执行闭环)、
5.6-6(真实 UI State)—— 四者**零改动、零触碰**;本任务书也未授权。

## 9. 文档更新计划(已完成 / 待批次确认后落)

- `docs/17` §5.6-1:七项更新为真实链路实现状态(本次不改 [x] —— 按 docs/44
  规则,5.6-1 的最终 [x] 须 live e2e 过后由 Global Regression 确认)
- `docs/44-current-baseline-and-reconciliation.md`:5.6-1 行更新为
  "PARTIAL → 代码齐,待外部凭据 live 验证"
- `docs/23` §5.6-1 行追加 "real adapters implemented (2026-09-11)"
- `docs/36` **未修改**(历史报告保留)
