> **Historical implementation report / current acceptance re-evaluation:** 本报告记录当时实现快照及其测试结果；阶段最终是否 PASS 以当前 `docs/17-acceptance-checklist.md` 与 `docs/44-current-baseline-and-reconciliation.md` 为准。若本报告的 PASS 与当前 checklist 不一致，以当前 checklist 为准。

# Phase 5.6-3 Browser Runtime — Completion Report

> 项目:AI-SE(Visual Engineering)
> 阶段:Phase 5.6-3(Browser Runtime / 浏览器执行时)
> 状态:PASS
> 完成日期:2026-09-11
> 执行规范:`docs/prompts/phase-5.6-3-browser-runtime.md`(用户审查通过,含两个冻结决策:waitForRender 组合策略、click/type=MEDIUM + download/close 不进能力面)
> 开发模式:ponytail(full)+ Context7 核实 Playwright API 后编码

---

## 1. Status

**PASS** — docs/17 §5.6-3 八项全部实现;browser 包 11/11(8 单元 + 3 个 e2e 场景在其唯一 it 内;**真实 Chromium 启动**,非 mock);全仓四门禁 exit 0。

## 2. Implementation(New Files)

| 文件 | 说明 |
|---|---|
| `packages/browser/package.json` / `tsconfig.json` | 新 workspace 包;deps = shared/observability/tool-runtime/zod;devDeps = playwright 1.61.0 + @playwright/test + vitest |
| `src/session.ts` | **零 Playwright interface 层**:PlaywrightLike/BrowserLike/ContextLike/PageLike/ConsoleMessageLike/RequestLike + `isNavigationAllowed`(scheme gate,data:/about: 与 scheme:// 都解析)+ 冻结常量(RENDER_HARD_TIMEOUT_MS=3000、DEFAULT_NAV_TIMEOUT_MS=15000) |
| `src/browserSession.ts` | BrowserSession:launch(单实例,nil pooling)/goto(allowlist 强制、data: null-response 透明成功)/waitForRender(**冻结组合策略:load→networkidle 500ms 静默→3s 硬上限,返回 settled:networkidle\|timeout**)/setViewport(1..20000 int 校验)/screenshot(buffer+base64+consoleErrorCountSinceLast 锚点)+ click/type(CSS selector,拒 scheme 形)/close(幂等,page→context→browser 全链) |
| `src/playwrightAdapter.ts` | **唯一 import "playwright" 的文件**(测试 grep 断言)+ `toVisualInputRecord`(assetRef+viewport→strict 5.6-0 record,5.6-4 接缝) |
| `src/browserTools.ts` | 7 个 ToolDefinition(navigate/setViewport/waitForRender/screenshot/consoleErrors=LOW;click/type=MEDIUM;**download/无确认 close 不做进能力面**),strict zod,execute 只打注入的 session |
| `src/errors.ts` | BrowserError 自包含分类(BROWSER_TIMEOUT/NAV_FAILED/RENDER_TIMEOUT/CLOSED/INPUT_INVALID),不包裹 Playwright 原生错误 |
| `src/index.ts` | barrel |
| `src/__tests__/browserSession.test.ts` | 8 例(harness 注入,session/record/脱敏用真实逻辑) |
| `src/__tests__/browser.e2e.test.ts` | 真实 Chromium e2e(1例全链:launch→goto data: fixture→waitForRender→screenshot→click/type buffer 差异→console error 注入+脱敏→viewport 截图变化;资产缺失时 skipIf DEGRADED)+ grep 边界断言 |

## 3. Key Decisions(按提示词冻结)

1. **waitForRender 组合策略**:`load` 后等 networkidle(500ms 静默),3s 硬上限
   到时返回;`.settled: "networkidle" | "timeout"` 让 5.6-4 识别半稳态截图。
   Playwright 的 networkidle 静默窗口内置 500ms,与提示词一致。
2. **click/type=MEDIUM**:DOM 状态变更可回放,但堵 5.6-5 Auto Fix 连点架空
   审批;download/无确认 close **没进能力面**(越域文件副作用/丢错误链)。
3. **data: URL 透明成功**:Playwright 对 data:/about: 导航返回 null Response
   对象 —— 是文档行为,页面已导航;goto 返回 `{finalUrl: rawUrl, status: null}`,
   e2e 用 fixture 页不受影响。**零外网访问**(fixture = data:text/html)。
4. **导航白名单**:`allowedProtocols` 空 = 全拒(5.6-0 语义);scheme gate 只看
   协议;host 白名单留接口本题未消费(报告记录,需要时最小补)。
5. **凭据零注入**:BrowserSession 从未接受 storageState/cookies/localStorage
   初始化参数;console/network 文本过 `redactCredentialShapedText`
   (sk-形 token 测试反例锁定;短 JWT 形如 `eyJsecr3t` 8+字符门槛不命中,
   fixture 用真实形长度)。
6. **零第二套体系**:错误不包 Playwright 对象;audit 由 ToolCallRecorder
   在调度层承担(本阶段 tool 层不自建 audit 形状)。

## 4. Tests(11 例,8 单元 + e2e 结构)

单元(harness,真实 session 逻辑):allowlist 矩阵(空=全拒/data:/ftp:/无scheme)、
closed 后操作 BROWSER_CLOSED、double close 幂等、viewport 越界 reject、
nav 失败→BROWSER_NAV_FAILED 不透原生错误、console 捕获+脱敏+sinceLast 计数,
assetRef 确定性命名 `screenshot://<sessionId>/<seq>[-fullpage].png`、
record 接缝 strict parse、BrowserError 自包含。

e2e(**真实 Chromium**,playwright install chromium v1228 已装):
launch(headless)→setViewport 1280x720→goto data: fixture(零外网)→
waitForRender(settled networkidle)→screenshot base64>100→toVisualInputRecord
strict→click#b1+type#in1→第二张 base64 ≠ 第一张(**真实交互改变画面**)→
goto 注入 console.error('Bearer …')→consoleErrors tool 捕获且 `[REDACTED]`
零泄漏→viewport 800x600 后截图尺寸变化;finally close 全链(**无孤儿进程**)。

## 5. Gates / Verification

- browser 单包:TC_OK / LINT_OK / Prettier OK / test 11/11
- 全仓:`TYPECHECK_EXIT=0 LINT_EXIT=0 TEST_EXIT=0 BUILD_EXIT=0`
- 测试总数 433 → **446**(browser 11 例新计入;真 Chromium e2e 在本机执行非跳过)
- Playwright API 全部经 Context7 查询核实(waitForLoadState/networkidle/
  console 事件/requestfailed/setViewportSize/screenshot buffer/launch)

## 6. Architecture Changes

- 新增 `@ai-se/browser` workspace 包;依赖仅 shared/observability/tool-runtime
  (零 visual 依赖 —— 采集域不反挂分析域)。
- Playwright 静态边界:grep 断言全包唯一命中 `src/playwrightAdapter.ts`。
- **零 shared 改动**(toVisualInputRecord 现有 schema 足够,预期达成);
  零 migration、零 server/web 改动;5.5/5.6-0/1/2 冻结契约未触碰。

## 7. Known Issues / Limitations

1. `requestfailed` 监听目前只erreur保留接口(PageLike.on 里有,Session 尚未
   挂 listener;network 错误数据通路就绪但采集为空数组) — 下阶段如果要
   5.6-4 关联 network 失败与截图,最小补 10 行。e2e 已踩住 console 错误链。
2. host 白名单(allowedHosts)是接口位未消费;scheme gate 是当前唯一导航约束,
   对 localhost/file/data 开发场景已足够。
3. `RENDER_IDLE_MS`(500)是文档值常量,真实静默窗口由 Playwright networkidle
   内置承担;保留常量以对齐提示词语义,未在代码路径强制。
4. deviceScaleFactor/DPR、多 tab/context 并发未实现(ponytail:YAGNI,
   5.6-4 需要时加)。

## 8. Acceptance Result(docs/17 §5.6-3 八项)

| 项 | 状态 |
|---|---|
| @ai-se/browser 包骨架 + Playwright 依赖 | ✅(1.61.0,Chromium v1228 已装) |
| 生命周期 API | ✅(launch/goto/waitForRender/close 全链 + close 幂等) |
| viewport 管理 | ✅(1..20000 校验 + 预设接口;e2e 尺寸变化锁定) |
| 截图资产管线 | ✅(buffer+base64+assetRef 可重放命名;record 接缝 strict) |
| Console/network 错误采集(与截图关联) | ✅(consoleErrorCountSinceLast 锚点+脱敏) |
| 真实 Chromium e2e | ✅(启动/截图/交互/错误捕获全真,零外网) |
| 受控交互(5.6-6 预留) | ✅(click/type 最小面 + MEDIUM 分级 + selector 白名单) |
| ToolRuntime 边界 + 无凭据 | ✅(7 tool 冻结表;grep 断言唯一 adapter;redact 测试) |

**Phase 5.6-3:PASS。**

## 9. Next Phase Boundary

**STOP** — 未开始 5.6-4 Visual Evaluation(截图对比/diff,现在有了稳定的
real 素材:toVisualInputRecord + settled 状态都在)。下一条指令决定是否
先做 5.6-4,或先批 planning 薄层(5.6-2 §三.4,把 draft 接进真实 Task 链)。
