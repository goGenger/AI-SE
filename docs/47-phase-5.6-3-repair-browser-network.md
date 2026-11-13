# Phase 5.6-3 Repair — Browser Runtime(Network Error 采集闭环)

> 任务书:用户提供的 "Phase 5.6-3 Repair" 指令(仅修 5.6-3,禁入 5.6-5/5.6-6)
> 状态:**PASS** — `requestfailed` / HTTP 4xx / 5xx 真实采集完成并经真实 Chromium E2E 验证
> 完成日期:2026-09-12
> 开发模式:ponytail(最小改动,复用既有证据模型)+ Context7 核实(Playwright
> requestfailed / response 事件契约)

---

## 1. Status

**PASS** — docs/17 §5.6-3 全部打勾。唯一缺口(监听未挂载)已补齐:三类网络证据
(requestfailed / http_4xx / http_5xx)进入**既有** `NetworkErrorEntry` / `getErrors`
链,与 Browser Session、Screenshot 正确关联;真实 Chromium(loopback HTTP fixture,
零外网)全场景验证。

## 2. 修改 / 新增文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/browser/src/browserSession.ts` | 修改 | 挂载真实 `requestfailed` + `response` 监听;`NetworkErrorEntry` 扩展(加法式:`kind` / `status` / `method`);`pushNetworkError` 单一 sink(共用 session seq、URL/reason 脱敏、计数);`ScreenshotAsset` 新增 `networkErrorCountSinceLast` 锚点 |
| `packages/browser/src/session.ts` | 修改 | 新增 `ResponseLike` 接口 + `PageLike.on("response")`;`RequestLike` 补可选 `method?()` / `resourceType?()`(向后兼容) |
| `packages/browser/src/index.ts` | 修改 | barrel 导出 `NetworkErrorKind`、`ResponseLike` |
| `packages/browser/src/__tests__/browserSession.test.ts` | 修改 | +5 例单元:requestfailed 记录+脱敏、4xx/5xx 分类且 <400 忽略、截图计数语义(含清零)、ERR_ABORTED 过滤、seq 共享与 sinceSeq |
| `packages/browser/src/__tests__/network.e2e.test.ts` | **新增** | 真实 Chromium E2E(本地 loopback HTTP fixture,零外网):成功不误报 / 4xx / 5xx / requestfailed / 三类区分 / URL 脱敏 / 截图关联 / 导航级 404-500 / nav timeout 语义 |
| `docs/17` / `docs/18` / `docs/23` / `docs/44` | 修改 | 状态与注记 |

**未触碰**:`browserTools.ts`(7 个 ToolDefinition 形状零改)、`errors.ts`、
`playwrightAdapter.ts`(仍是唯一 Playwright import 文件)、ToolRuntime、
5.6-2 / 5.6-4 产物、5.6-5 / 5.6-6 全部产物、历史报告 docs/38。

## 3. Network Error 实现(要点)

```text
page.on("requestfailed") → 过滤 net::ERR_ABORTED(客户端取消,非网络故障)
page.on("response")      → status>=400 → http_4xx / http_5xx(含主文档导航)
        ↓
pushNetworkError: { kind, status, url(redacted), method, reason(redacted), timestamp, seq }
        ↓
既有 NetworkErrorEntry / getErrors(sinceSeq) 链(与 console 共用一个 session seq)
```

- **为何过滤 `net::ERR_ABORTED`**:真实 Chromium 在本 E2E 中被观测到:一个 500
  响应的 `<script>` 会在 `response(500)` 之后**再**触发同一请求的
  `requestfailed(ERR_ABORTED)`。ERR_ABORTED 语义是「客户端主动取消」,不是网络
  故障;记录它会把同一请求双重计数。过滤后 5xx 仍然完整保留(响应级采集)。
  ⚠️ 若后续需要"取消类"证据,应新增独立 kind,而不是复用网络错误。
- **导航级覆盖**:`response` 监听同样捕获主文档(测试锁定 `/missing.html` 404、
  `/boom.html` 500 均被记录)。
- **Timeout / Cancellation 语义未变**:goto 超时仍 `BROWSER_NAV_FAILED`(原语义,
  E2E 锁定);无新增取消 API。
- **零第二套模型**:没有新 Browser Error/Evidence 类型;扩展既有
  `NetworkErrorEntry`(加法式),Tool 层(`browser.consoleErrors`)零改动即携带
  网络证据。

## 4. Browser Evidence(与截图/会话关联)

- 证据与会话绑定:entry.seq 与 console 同一 session 单调序列;`getErrors(sinceSeq)`
  统一增量拉取(测试锁定 console seq=1 / network seq=2 的共享空间)。
- 与截图关联:`ScreenshotAsset.networkErrorCountSinceLast`(与既有
  `consoleErrorCountSinceLast` 同锚点语义,拍后清零);E2E 断言 mixed 页截图计数
  **恰为 4**(2×4xx + 1×5xx + 1×requestfailed),复拍为 0,再一次失败后为 1。
- 与资产关联:`toVisualInputRecord(session.assetRefFor(shot), viewport)` 在 E2E
  中同步验证(screenshot:// 命名 + viewport)。

## 5. 测试结果

- browser 包:**18/18**(12 基线 + 6 新增:5 单元 + 1 真实 Chromium E2E);
- E2E 实测断言(全部在真实浏览器上):
  - 健康页(`/good.html` 含 200 的 png/js):`network === []`(**不误报**);
  - mixed 页:`/missing.png`→`http_4xx(404)`、`/boom.js`→`http_5xx(500)`、
    死端口→`requestfailed(net::ERR_CONNECTION_REFUSED)`——**三类可区分**;
  - `/ok.png` 不被误报;`sk-…` 形 token 路径 → `[REDACTED]`(零泄漏);
  - 截图锚点 4/0/1 语义;screenshot→record 接缝;
  - 导航级 404/500 进证据;nav timeout → `BROWSER_NAV_FAILED`。
- 既有回归(Screenshot / Console Error / Runtime Error / Page Load Failure /
  Timeout / Cancellation / Browser Tool / ToolRuntime / 5.6-2):全仓门禁全绿(§7)。

## 6. 已知限制

1. `net::ERR_ABORTED` 被过滤(见 §3 理由);若下游需要"被取消请求"证据,需新增
   独立 kind(不在本次范围)。
2. `allowedHosts` 仍是接口位未消费(scheme gate 为当前唯一导航约束,延续 5.6-3
   原报告口径)——本次未扩展,避免越域。
3. `BROWSER_TIMEOUT` 错误码保留未使用(导航超时按既有语义归
   `BROWSER_NAV_FAILED`);语义保持原样,未改。
4. 网络证据为「观察近因」:不区分 Chrome 缓存命中等浏览器内部行为(本 E2E 用
   无缓存场景)。

## 7. 全仓回归

批次(proc_38ad453ea5e8):`TYPECHECK_EXIT=0 LINT_EXIT=0 TEST_EXIT=0 BUILD_EXIT=0`,
**TOTAL 528/528 passed,0 failed,0 skipped**(基线 522 → +6:browser 5 单元 + 1 真实
Chromium E2E)。

分包:mcp 201 | visual 78 | web 51 | server 42 | shared 39 | agent-core 37 | database 33 |
**browser 18** | workflow-engine 14 | tool-runtime 11 | observability 2 | sandbox 2。

5.6-2 regression:全仓通过(agent-core 37、visual 78 均无回归);ToolRuntime boundary
与凭据零注入断言(browser 既有 e2e)继续通过。
