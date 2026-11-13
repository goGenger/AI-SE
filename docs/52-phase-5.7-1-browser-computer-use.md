# Phase 5.7-1 Browser Computer Use — Completion Report

> 项目:AI-SE(Computer Use / External Engineering Tools)
> 阶段:Phase 5.7-1(Browser Computer Use)
> 状态:**PASS**
> 完成日期:2026-09-13
> 开发模式:ponytail(适配层 + 固定脚本,零新运行时)+ 以代码为准
> 参考:5.7-0 契约(docs/43)+ 5.6-3 Browser Runtime / 5.6-6 Interaction(代码复读)

---

## 1. Status

**PASS** — docs/17 §5.7-1 九项全部实现;browser **33/33**(21 基线 + 12 新);
server **51/51**(49 基线 + 2 新);全仓四门禁 exit 0(见 §8)。

```text
Agent
  ↓
ToolRuntime(权限/超时/取消/审计)
  ↓
Browser Tool(browser.observe / browser.action.*)
  ↓
BrowserSession(唯一 Playwright 边界,未重写)
  ↓
Playwright
```

## 2. 修改 / 新增文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/browser/src/session.ts` | 修改 | `PageLike` 增 `url()` / `evaluate()`(固定脚本专用)/ `ariaSnapshot()`;新增 `BrowserDomNode` 类型 |
| `packages/browser/src/browserSession.ts` | 修改 | 新增 `observe()`(固定自包含 DOM 脚本 + aria snapshot;脱敏单源 + 契约截断)与 `currentUrl()`;模块级页面侧最小声明(不放开整包 DOM lib) |
| `packages/browser/src/computerUseTools.ts` | **新增** | 5 个工具定义(`browser.observe` + `browser.action.{navigate,click,type,screenshot}`)+ 5.7-0 Observation/ActionResult 映射适配层(零新运行时) |
| `packages/browser/src/index.ts` | 修改 | 导出新工具面与类型 |
| `packages/browser/src/__tests__/browserSession.test.ts` | 修改 | harness 增 `url/evaluate/ariaSnapshot` 假件 + `newContext` 参数捕获;+1 例(零凭据注入) |
| `packages/browser/src/__tests__/computerUseTools.test.ts` | **新增** | 8 例适配层单测(严格 schema、失败归一、取消不变式、base64 红线、scheme 拒绝) |
| `packages/browser/src/__tests__/computerUse.e2e.test.ts` | **新增** | 2 例真实 Chromium E2E(全链路 + 治理封套) |
| `apps/server/src/__tests__/browserComputerUse.e2e.test.ts` | **新增** | 2 例:ToolRuntimeBackend 权限门 + Agent 路径真实执行(含审计);agent-core 静态边界断言 |

**未触碰**:既有 7 个 5.6 Browser Tool(注册表原样)、Playwright 适配边界(仍仅
`playwrightAdapter.ts` 导入)、Browser Runtime 生命周期语义、ToolRuntime /
AgentRuntime / Workflow Engine 核心、shared 契约(消费 5.7-0,零修改)。

## 3. Observation 实现

- `browser.observe`(LOW)→ **严格 5.7-0 `Observation`**:
  - `dom`:固定自包含页面脚本(Playwright 序列化,无闭包)按文档序扫描,
    产出 `{ref, role, name, clickable, text}`(≤2000 节点,text ≤2000/name ≤300
    由脚本内截断;`maxNodes` 会话侧再截,默认 500);ref 通过 `data-ai-se-ref`
    属性生成稳定选择器(`[data-ai-se-ref="r3"]`),**观察到的 ref 可直接作为
    后续动作选择器**;
  - `accessibility`:Playwright `ariaSnapshot()` 序列化树文本(≤200000 硬截断)+
    `interactiveCount`(交互角色行计数);
  - 双形态至少一者(输入 schema 层拒绝"两者都关"的空观察);
  - URL 上下文经 `actionRef.target` 承载(5.7-0 契约无独立 url/viewport 字段,
    见 §7 限制);截图像素不进观察,`screenshotRef` 走 `screenshot://`。
- 过滤:不渲染(无 client rects)/`visibility` 非 visible / `aria-hidden` /
  script/style 等跳过;输入元素当前值进入 `text`(观察即可见表单值)。

## 4. Action 实现

| 工具 | 风险 | 输出 | 说明 |
|---|---|---|---|
| `browser.action.navigate` | LOW | ActionResult | goto + waitForRender;后置观察 dom+a11y(target=URL) |
| `browser.action.click` | MEDIUM | ActionResult | 选择器或观察 ref;后置观察 dom(target=selector) |
| `browser.action.type` | MEDIUM | ActionResult | 同左 + 文本(≤10000) |
| `browser.action.screenshot` | LOW | ActionResult | **复用 5.6-3 资产管线**(`assetRefFor` → `screenshot://<sessionId>/<seq>.png`),`observation.screenshotRef` 携带引用,**base64 永不进契约**(测试锁定) |

- **分层语义**(适配层映射,非重写):ToolResult = ToolRuntime 治理封套——非法输入 /
  超时 / 取消分别为 `TOOL_ERROR` / `TIMEOUT_ERROR` / `CANCELLED_ERROR`;动作"已执行"
  后的结果(成功或动作自身失败)载于 ActionResult(动作失败 → `status:"failed"` +
  `error.code` 取 BrowserError 代码域,如 `BROWSER_NAV_FAILED`)。取消另有双层:
  ToolRuntime 封套 = CANCELLED_ERROR;工具自见 signal 时可产出
  `status:"cancelled"` + `cancelledAt`(契约不变式,单测锁定)。
- 参数 schema(zod strict):selector 禁 scheme(javascript:/data:/vbscript:)、
  URL ≤2000、text ≤10000、`timeoutMs` ≤30s(会话侧动作超时)。
- timeout/cancellation 经既有 ToolRuntime 机制(不新建);error normalization
  经既有 `BrowserError` 代码域 + 脱敏单源。

## 5. ToolRuntime 集成 / 权限 / 审计

- 全部动作经 `ToolRuntime.execute`(E2E 全程走 ToolRuntime,零直连);
- **权限**:既有 `AgentPermissions.tools` 白名单(ToolRuntimeBackend,5.5 机制,
  零第二套)——未授权工具立即拒绝("Tool X is not permitted",不触达 runtime);
  授权后真实执行(server E2E 双态验证);
- **审计**:既有 `ToolCallRecorder`(started/finished,status =
  succeeded/timed_out/cancelled/failed)双 E2E 断言;
- 工具上下文沿用既有 `context` 传递模式(session 随上下文注入,与 5.6 一致)。

## 6. Security / credential isolation

1. **浏览器上下文零凭据注入**:`newContext()` 以零参数调用,单元测试锁定
   (无 storageState/cookies/httpCredentials);
2. **观察内容脱敏**:DOM `name`/`text` 与 a11y 树经 `redactCredentialShapedText`
   单源脱敏后才离开会话(E2E 在真实页面注入 `sk-…` 形状文本,断言
   `[REDACTED]` 出现、原文绝不出现);
3. **actionRef.target 脱敏**(实现中发现并修复的真实泄漏路径):目标 URL 可能
   携带凭据形状内容(`?token=`、含密文的数据 URL);target 进入 Agent 可见状态/
   审计,故统一经脱敏单源——E2E 以"凭据嵌在 data:URL"的 fixture 锁定该路径;
4. base64 截图永不进入契约/审计(单测 + E2E 序列化断言);选择器/错误消息同经
   脱敏;
5. **边界**:`playwright` 导入面静态断言仍仅适配器一处;新增
   "agent-core 无 playwright/@ai-se/browser 依赖"静态断言(server E2E)。

## 7. Chromium E2E 证据(browser 包 2 例 + server 包 1 例)

**例 1(全链路,真实 Chromium,data: fixture,零外网)**:navigate → observe →
click → type → **observe(读回 "hello ai-se")** → screenshot(`screenshot://browser:cu:1/1.png`)
→ navigate(第二页在观察中可见);7 次调用审计全部 `succeeded`;脱敏与 base64
红线内联断言。

**例 2(治理封套)**:非法输入 → `TOOL_ERROR`;未知工具 → `TOOL_ERROR`;
scheme 选择器 → `TOOL_ERROR`;超时(300ms 杀不死选择器等待)→ `TIMEOUT_ERROR`;
预取消 → `CANCELLED_ERROR`;飞行中取消(150ms abort)→ `CANCELLED_ERROR`;
审计 statuses 含 `timed_out` / `cancelled`,超时记录经 toolCallId 关联回
`browser.action.click`。

**例 3(server,Agent 路径)**:未授权 `browser.observe` → "not permitted"(零触达);
授权后 navigate + observe 经 ToolRuntimeBackend 真实执行成功,审计两条
`succeeded`。

## 8. 全仓回归

- browser 33/33(+12)、server 51/51(+2)、visual 83、web 51、shared 39、
  agent-core 37、database 33、mcp 201、workflow-engine 14、tool-runtime 11、
  observability 2、sandbox 2;
- 全仓四门禁(根脚本):`TYPECHECK_EXIT=0 LINT_EXIT=0 TEST_EXIT=0 BUILD_EXIT=0`,
  **TOTAL 557/557,0 failed**(543 基线 + 14 新)。

## 9. 已知限制

1. 5.7-0 严格契约无 url/viewport 独立字段——观察上下文经 `actionRef.target`
   (URL)承载,viewport 由调用方自行掌握;不为此修改冻结契约。
2. `actionRef.target` 的"as-is"原则以安全为先:凭据形状内容被脱敏(契约注释
   允许,安全红线优先)。
3. 动作面按任务书最小集(click/type/navigate/screenshot);docs/24 提及的
   select/scroll 未含于本阶段验收,未实现(避免越域)。
4. DOM 快照脚本在页面内为节点写 `data-ai-se-ref` 属性(稳定 ref 机制);对页面
   DOM 属轻微标记,只增不改。
5. 超时/取消杀掉的浏览器调用在 Playwright 端仍会挂起到会话关闭(既有
   BrowserSession 语义,未改动)。
6. E2E 用 data: fixture;真实站点的巨大 a11y 树依赖 200k 截断(契约硬上限)。

## 10. 是否进入后续阶段

**否。** 仅实现 5.7-1;5.7-2(外部系统)/ 5.7-3(Policy)/ 5.7-4(Evidence)/
5.7-5(Recovery)零触碰;5.7-0 历史报告未修改。
