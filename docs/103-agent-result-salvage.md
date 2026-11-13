# Agent 结果锚点抢救 — 长字符串破损不再判失败

> 来源：docs/102 的容错修复未覆盖真实破损（2026-09-28 20:26 真实运行仍报
> 「Professional Agent returned an invalid structured result.」）。
> 本修复改为**确定性锚点抢救**：破损只发生在长字符串**内部**时，按顶层字段锚点取回 status / summary；
> 另加一条提示词 JSON 卫生规则与失败答案全量落盘（诊断）。

## 侦察结论（真实数据，2026-09-28 20:26 本地 / 12:26 UTC）

run `dfb569c8`（T2，37s，9 迭代，status `succeeded`，`answerLength = 2739`）：

| 证据                                | 值                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 答案形态                            | 散文一行 + ` ```json ` 围栏块（围栏内才是结果 JSON）                                                                                                                        |
| 散文行                              | `All acceptance criteria verified: 17/17 static structure checks and 24/24 runtime state checks (loading, empty, error, success) pass.`                                     |
| `answerHead`（前 300 字，真实原文） | `{"status":"SUCCESS","summary":"T2 complete. The single self-contained deliverable /workspace/index.html (28,375 bytes, 875 lines) delivers the HTML skeleton `             |
| `answerTail`（后 500 字，真实原文） | `engine; no uncaught runtime errors across all injected failure modes.","verification":{…"fileCoverage":"single deliverable, no other files required to run"}}}` + 围栏收尾 |
| 结论                                | 破损在长 summary **内部**；`"status":"` 与 `","verification":` 两个顶层锚点完好                                                                                             |

**为什么 docs/102 的启发式修复没救回来**：引号判据"引号后第一个非空白字符不是 `,` `:` `}` `]` 即内层引号"存在盲区 ——
长 summary 里 `the states "loading", "empty" and "error" all render` 这类片段，内层引号后面正好跟 `,`，被误判为闭合引号，
字符串状态提前退出，修复后的文本仍不可解析。（本轮用例把该形态写进回归：真实头/尾逐字 + 同形态破损中间段。）

## 修复

| #   | 文件                                                        | 变更                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/agent-core/src/professional/ProfessionalAgent.ts` | 新增 `salvageOutcome`（锚点抢救）+ `unescapeJsonText`：JSON 整体不可解析时，按 `"status":"…"` 与 `"summary":"…","<下一个键>":` 两个锚点取回字段；**只读锚点之间的原文、不做任何推断**；status 不在枚举内或 summary 锚点缺失 → 返回 undefined，继续走 INVALID 兜底（截断不会被"抢救"成成功） |
| 2   | 同上                                                        | 提示词 `RESULT_INSTRUCTIONS` 增 JSON 卫生规则：字符串单行、内层引号一律 `\"`、少贴 HTML/JS 片段（根因缓解）                                                                                                                                                                                 |
| 3   | 同上 + `apps/server/src/services/workflowTaskExecutor.ts`   | 失败答案全量落盘 `answerText`（≤ 8000 字）+ `parseRecovery` 字段透出（诊断 / 可观测）                                                                                                                                                                                                       |

## 测试

| 用例                                                                                                               | 结果 |
| ------------------------------------------------------------------------------------------------------------------ | ---- |
| `salvages status and summary from a fenced answer whose long string is broken`（真实头/尾逐字 + 同形态破损中间段） | 通过 |
| `does not salvage an outcome whose status is outside the enum`（抢救不绕过枚举校验）                               | 通过 |
| 既有 69 例（含 docs/98、docs/102 全部解析用例）不回归                                                              | 通过 |

`packages/agent-core`：**71/71 通过**。

## 门禁（本轮）

- `typecheck / lint / build`：全仓 exit 0；`prettier --check` 全绿。
- `apps/server`：**21 文件 / 95 例全过**（单跑两轮均全过）。
- 全仓回归：**988 例 / 980 通过 / 8 失败** —— 7 个为 apps/web 的 eyebrow 先存失败，1 个为 `failureRecovery.e2e`
  「external CANCELLED action is not auto-recovered」的**固有竞态**（见已知问题 5；该用例单文件三连跑为 过/失败/过，
  与本次改动无关：该文件不经过 Agent 结果解析层，失败任务为 external action）。
- 服务随 dist 重建自动重启（20:38:33，`/health` 200），新逻辑即时生效。

## 边界与已知问题

1. 抢救的适用前提是"顶层锚点完好、破损在字符串内部"（真实观测两次都是这一形态）；锚点本身破损时仍判 INVALID（此时 `answerText` 已落盘，可直接定位新形态）。
2. 抢救结果带 `metadata.parseRecovery = "salvage"` 标记，便于统计"多少次是抢救回来的"。
3. 未做（待用户决策）：结构化输出（JSON mode）收尾、把修复轮改为无工具的"纯重排版"调用。
4. docs/102 的启发式修复保留（对"内层引号后不跟 `,:}]`"的形态仍有效），抢救是其后的最后一道。
5. **先存竞态（非本次引入）**：`failureRecovery.e2e` 的「external CANCELLED action」用例等任务进入 RUNNING 后立即
   `executor.cancel()`，取消可能抢在外部调用派发之前 → `client.requestCount("issues.slow")` 停在 +0，断言失败。
   该文件不经过 Agent 结果解析层（失败任务为 external action），单文件三连跑为 过/失败/过；建议后续把"等待派发"
   写成显式轮询（`requestCount > slowBefore` 后再取消）以消除竞态 —— 本次未修（超范围，仅记录）。

**完 —— 等待下一条指令。**
