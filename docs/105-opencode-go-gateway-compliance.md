# 105 · OpenCode Go 网关接入（x-opencode-session 合规头）

## 背景
LLM 端点从 DeepSeek 直连切到 OpenCode Go 订阅（`https://opencode.ai/zen/go/v1`）后，
平台第一次真实调用被网关拒绝，`agent_runs.error` 原文：

    400 inference_failed
    Request is missing x-opencode-session and cannot be routed efficiently.
    Please see https://opencode.ai/docs/go/#where-can-i-use-it

即 Go 文档「Where can I use it?」的客户端要求不是建议而是**强制**：缺 `x-opencode-session` 直接 400。
（该轮 frontend-agent 3 次运行全在 26ms 内失败 —— 请求被网关立即拒绝，未进入推理。）

## 定位过程（只读探针）
1. `GET {base}/models` + 最小 chat 请求（带合规头）→ 200，`deepseek-v4.1-flash` 在模型列表内；
2. 对照探针：自有 UA / langchainjs 默认 UA / 换模型 → 全部 200，排除 key、模型、区域、UA；
3. 结论落到平台侧错误原文：唯一缺失项就是 `x-opencode-session`。

## 改动（3 个文件）
- `packages/agent-core/src/llm/LangChainLLMProvider.ts`
  - 新增 `openCodeGatewayHeaders(baseUrl, sessionId)`：仅当端点指向 opencode 网关时产出
    `User-Agent: ai-se-platform/1.0` + `x-opencode-session`（非 opencode 端点零注入）；
  - 新增 `openCodeGatewayConfiguration(...)`：返回 `{ baseURL, defaultHeaders, fetch }`，
    UA 在 fetch 层再改写一次 —— LangChain 合并时会覆盖 `defaultHeaders` 里的 UA（实测验证）；
  - `createOpenAIChatModel` 与 `LangChainPlanningModel` 共用该助手。
- `apps/server/src/services/workflowTaskExecutor.ts`：每次任务执行传 `sessionId: task.id`
  （同一任务的重试复用同一会话，利于网关侧路由与 prompt 缓存）。
- `apps/server/src/index.ts`：规划模型固定会话 `ai-se-planning`。

## 验证
- agent-core 78/78（+4：头派生 / 模型 clientConfig 注入 / 仅 opencode 注入 / fetch 层 UA 改写）、
  apps/server 95/95（含 5.7-2 边界守卫：agent-core 不得依赖传输层与外部 API 客户端）、
  typecheck / lint / prettier 全绿；
- **真实网关端到端**（用平台自己的 dist 代码路径 + `.env`）：
  - `createOpenAIChatModel` → `REPLY = "ok"`（2.4s，HTTP 200）；
  - `LangChainPlanningModel.generateStructured`（jsonMode）→ `{"status":"SUCCESS",...}`（3.4s）；
  - `bindTools` 工具调用 → `tool_calls=1`，名称与参数正确（2.0s）。
- 运行实例：`:3000` 由用户 `tsx watch` 拉起新进程，`/health` 200。

## 回滚
`.env` 中旧 DeepSeek 三行保留为注释；代码侧对非 opencode 端点零注入，切回即恢复原行为。

## 运维备注
- `.env` 行内注释已上移（shell 能容忍，dotenv 类解析器会把注释并进值）；
- `:3000` 曾被 9/28 的孤儿进程占用，新 dev 服务因端口冲突未绑定 —— 清理后由 tsx watch 正常接管；
- Go 为订阅制（按模型的美元上限），平台 `estimated_cost` 是用量价值而非账单。
