> **Sequencing note:** 该契约文件证明 5.7-0 的契约实现已完成，但不代表 Phase 5.7 readiness。由于当前 Phase 5.6 尚未完成，5.7-1 及以后不得开始。

# Phase 5.7-0 Computer Use Contract — Completion Report

> 项目:AI-SE(Computer Use / External Engineering Tools)
> 阶段:Phase 5.7-0(Computer Use Contract / 契约冻结)
> 状态:PASS
> 完成日期:2026-09-11
> 执行规范:`docs/prompts/phase-5.7-0-computer-use-contract.md`(整份一次写就 + 通读复查)
> 开发模式:ponytail(full 默认)+ 以代码为准
> 参考:5.6-0 冻结模式(同构)

---

## 1. Status

**PASS** — docs/17 §5.7-0 六项全部实现;shared **39/39**(27 基线 + 12 新契约);零行为实现;零 migration;零新依赖;全仓四门禁 exit 0(见 §5)。

## 2. Implementation(Additive Files)

| 文件 | 说明 |
|---|---|
| `packages/shared/src/index.ts` | 追加 `── Phase 5.7-0: Computer Use Contract ──` 代码块(一个代码块):ExternalActionRef(DiscriminatedUnion)/ DomSnapshot / A11ySnapshot / Observation / ActionResult(zod strict + refine 不变量)+ 4 个类型导出;**零既有结构修改** |
| `packages/shared/src/computerUseContract.test.ts` | 12 例(strict 串包校验、三 arm fixture、双形态判别、screenshotRef 前缀锁、ActionResult 不变式、retry 元数据字段、纯契约红线) |

零修改:agent-core、workflow-engine、mcp、browser、visual、sandbox、apps/*;零既有 shared 契约(5.6-0/5.6-1 段原样)。

## 3. Key Decisions(按提示词冻结)

1. **ExternalActionRef 判别联合**(discriminatedUnion on `source`):三 arm
   最小字段化,字段名复用产出包既有 id 形状 —— browser(sessionId/
   toolName/target)、mcp(serverName/toolName/callId)、sandbox(commandId/
   runId optional)。测试:跨 arm 串包字段 → parse 失败(strict 红线);
   unknown source → 拒绝。
2. **Observation 双形态 + refine**:`dom`(≤2000 nodes,每 node
   ref/role/name/clickable/text)与 `accessibility`(序列化 tree 文本 +
   interactiveCount)至少一个存在 —— 不上屏的观察不是 Observation。
   `screenshotRef` 正则锁 `screenshot://` 前缀(5.6-0 语义);**base64
   不进契约字段**,`base64Screenshot` 之类字段 strict 直接拒绝(测试锁定
   —— 5.6-1 惯例由调用方传递)。
3. **ActionResult 完整不变式**:
   - `status: "success" | "failed" | "cancelled"`
   - failed ⇒ error 必填;cancelled ⇒ cancelledAt 必填(refine 锁定)
   - success + error 并存**允许但不强制**(错误对象在 failed 时语义有效;
     报告记录该设计取舍,不做 prescriptive 红线)
   - `retryRound/maxRetries` 是**纯字段**(语义归 workflow-engine 的
     retryCount/policy.maxRetries;本阶段零行为)
   - `durationMs` int 非负;`occurredAt/cancelledAt/timeoutAt` ISO datetime
4. **error.code 是 string 占位**:失败分类枚举**推迟到 5.7-5** 冻结
   (本阶段注释明示)—— 不预测失败表。
5. **纯契约红线**:契约块零跨包 import(browser/mcp/sandbox)、零
   playwright 字样;测试文件只 import `./index`(组件无 node types 需求;
   文件读断言改为模块图级断言 —— ponytail:shared 无 @types/node tsconfig,
   不为一条测试改工程配置)。
6. **取消/超时是字段不是机制**:cancelledAt/timeoutAt 契约字段;取消行为
   本身归 workflow-engine 现有链(零第二套)。

## 4. Tests(12 例)

- 三 arm parse 通过 + strict 跨 arm 串包拒绝 + unknown source 拒绝
- dom-only / a11y-only Observation 各一通过;双缺拒绝
- screenshotRef 前缀锁(非 `screenshot://` 拒);base64 字段 strict 拒
- failed/cancelled 必填不变式;success+error 允许;retry 字段直通
- occurredAt/durationMs 类型校验
- 纯契约红线(契约面无运行时依赖)

## 5. Gates / Verification

- shared:TC_OK / LINT_OK / Prettier OK / **39/39**
- 全仓:`TYPECHECK_EXIT=0 LINT_EXIT=0 TEST_EXIT=0 BUILD_EXIT=0`
  → **498 passed**(486 基线 + 12 契约)—— 后台批次确认(§7)

## 6. Architecture Changes

- 只加法式扩展 shared 一个代码块;**零 migration、零 REST、零 server/web
  改动**;零跨包行为实现。
- 下游(5.7-1/2)消费面就绪:browser observe/click/type 输出 → ActionResult
  的 browser arm;5.7-2 mcp arm;5.7-4 Evidence 引 actionRef/resultId。

## 7. Known Issues / Limitations

1. error.code 枚举推迟到 5.7-5(设计决定,非缺陷;§3.4)。
2. Observation 的 accessibility.tree 容量上限 200_000 字符(约 3 万节点
   AOM 序列化容忍;真实超界走分角截断,实施方在 5.7-1 处理)。
3. A11y snapshot 的序列化格式(tree 文本)由 5.7-1 实施方选定(契约只存
   text + 计数);本阶段不预提取 Aria 快照协议细节。
4. Evidence 字段在 ActionResult 不出现(5.7-4 概念;引用挂 drafting 层)。

## 8. Acceptance Result(docs/17 §5.7-0 六项)

| 项 | 状态 |
|---|---|
| GUI/Browser Action + Observation + Screenshot + ActionResult + Cancellation/Timeout 契约 | ✅(一个契约块:ExternalActionRef + Observation + ActionResult;cancellation/timeout 字段面) |
| ExternalActionRef 三来源 union | ✅(browser/mcp/sandbox discriminatedUnion;strict 红线测试) |
| Observation 数据结构 | ✅(DOM/A11y 双形态至少一 + screenshotRef 引用;base64 不入契约) |
| ActionResult 三态 + 不变式 | ✅(success/failed/cancelled refine;error/cancelledAt 必填分支) |
| 契约测试(zod strict + fixture;零行为) | ✅(12 例;纯契约文件级红线) |
| 边界冻结:不实现任何采集/执行/持久化 | ✅(零 Playwright/零 fetch/零 IO/零 migration;全仓回归绿) |

**Phase 5.7-0:PASS。**

## 9. Next Phase Boundary

**STOP** — 未开始 5.7-1 Browser Computer Use / 5.7-2 External Systems /
5.7-3 Policy / 5.7-4 Evidence / 5.7-5 Recovery。5.7-1 与 5.7-2 可并行
(共同依赖 = 本阶段契约)。下一条指令决定先走哪个。
