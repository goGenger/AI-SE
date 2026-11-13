# Phase 5.6-3 — Browser Runtime

开始前必须阅读：
- `docs/17-acceptance-checklist.md` §5.6-3
- `docs/23-phase-5.6-implementation-plan.md`
- `docs/38-phase-5.6-3-browser-runtime.md`
- `packages/tool-runtime`
- `packages/browser` 当前实现

目标：完成受控 Browser Runtime，并真实采集 screenshot、console、network、runtime error。

要求：
1. Playwright 只存在于 browser adapter 层。
2. Agent 不得直接 import / control Playwright。
3. 继续复用 ToolRuntime / timeout / cancellation / audit / redaction。
4. 保持现有 navigation allowlist 和无凭据注入边界。
5. `page.on('requestfailed')` 必须真实接入，Network Evidence 与 session/screenshot 正确关联。
6. HTTP 4xx/5xx、request failure、console error、pageerror 必须可区分。
7. 不实现 Visual Evaluation 或 Auto Fix。

测试至少覆盖：
- real Chromium
- navigation
- viewport
- screenshot
- console error
- requestfailed
- HTTP error
- runtime error
- timeout
- cancellation
- cleanup
- no credential injection

完成后运行全仓验证并 STOP。
