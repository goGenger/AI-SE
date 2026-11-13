> **Historical implementation report / current acceptance re-evaluation:** 本报告记录当时实现快照及其测试结果；阶段最终是否 PASS 以当前 `docs/17-acceptance-checklist.md` 与 `docs/44-current-baseline-and-reconciliation.md` 为准。若本报告的 PASS 与当前 checklist 不一致，以当前 checklist 为准。

# Phase 5.6-5 Auto Fix / Re-plan — Completion Report

> 项目:AI-SE(Visual Engineering)
> 阶段:Phase 5.6-5(Auto Fix / Re-plan / 自动修复与重评估)
> 状态:PASS
> 完成日期:2026-09-11
> 执行规范:`docs/prompts/phase-5.6-5-auto-fix-replan.md`(整份一次写就 + 通读复查)
> 开发模式:ponytail(full,默认)+ 以代码为准

---

## 1. Status

**PASS** — docs/17 §5.6-5 六项全部实现;visual 包 **64/64**(14+11+15+9+16);零 shared 改动;全仓四门禁见 §7(与全局回归合并执行)。

## 2. Implementation(New / Modified Files)

| 文件 | 说明 |
|---|---|
| `packages/visual/src/autoFix.ts` | 问题分类 → Fix Draft(复用 5.6-2)→ 三态判定 → 循环推进 → 审计串,全部纯函数 |
| `packages/visual/src/__tests__/autoFix.test.ts` | 16 例(见 §4) |
| `packages/visual/src/index.ts` | barrel 追加 autoFix 导出 |

零修改:shared、agent-core、workflow-engine、mcp、browser、apps/*、5.6-0~4/6 冻结产物。

## 3. Key Decisions(按提示词冻结)

1. **IssueKind 补 "style"**:5.6-4 的 MismatchKind 含 style(autoFix 映射时
   原样继承);提示词枚举四类遗漏 style —— 运行时补齐并保留 gap 第五类
   (docs/17 的"文案"kind 仍**不新增**:5.6-0 契约无文案层数据面,扩展须
   先改规则)。
2. **gap 不进修复候选**:`attributableToKnownGap` 的 issue 供人审
   (kind=gap);buildFixTaskDrafts 只消费 fix 候选集合。测试:
   gap-onlyissues → drafts=[]。
3. **autoSubmitted 恒 false**(类型为字面量 false,不是 boolean):执行面
   零新增 —— 提交/执行走现有 agent/approval 链,本阶段不实现 runner。
4. **三态判定的 severity 表**:`PASS(0) < STYLE(1) < COMPONENT(2) <
   LAYOUT(3)`(冻结导出 SCORE_SEVERITY);REGRESSED = after 分数更差 或
   unchanged 集含 geometry issue。**RESOLVED 判据修复**:实现第一版要求
   before 非空才 RESOLVED,导致"双侧回归集都空"落到 NEW_ISSUE —— 
   语义应为"回归-only 集空 = 无可修问题",已改为 `afterCandidates.length
   === 0 → RESOLVED`(测试 gap-only 用例锁定)。
5. **循环推进纯函数**:`advanceFixLoop` append 轮次后 else-if 判定
   (RESOLVED→DONE / 达 maxRounds→MAX_ROUNDS / 连续 stallThreshold 轮同向
   非 RESOLVED→STALLED / 其余 RUNNING);**不 mutate 输入**(测试锁定);
   STALLED 是转发信号,人审动作在既有链(workflow-engine approval)。
6. **审计串拼接而非新报告**:头部+issues+fix draft 三行+前后 score 摘要;
   helpers.serializeReport 注入点保留(将来可复用 5.6-4 逐行 serialize,
   当前传 score 即可 —— ponytail:YAGNI);每行过 redactCredentialShapedText。

## 4. Tests(16 例)

- 分类:kind 判定(gap/geometry/elements)、fixCandidate 排除 gap、
  issueId 确定性(`issue:<viewport>:<sectionId>`)、分类即脱敏(Bearer 反例)
- Fix Draft:复用 5.6-2 buildFrontendTasks 原样产出、契约字面量
  (taskKey/assignedAgent/type)、autoSubmitted=false 锁定、
  submissionRisk 派生(missing→LOW)、gap-only → drafts=[]
- 三态:RESOLVED(before 有 after 无 / 双空)、NEW_ISSUE(新 id)、
  REGRESSED(score 严序变差 或 unchanged 含 geometry)、gap 不计三态
- 循环:常量冻结断言、RESOLVED→DONE、达上限→MAX_ROUNDS、
  连续 2 轮同向非 RESOLVED→STALLED(1 轮→RUNNING)、纯函数不 mutate
- 审计串:分段结构、泄漏 `sk-` 零泄漏含 `[REDACTED]`、剥 evaluatedAt 重放

## 5. Gates / Verification

- visual:TC_OK / LINT_OK / Prettier OK / **64/64**
- 全仓(与全局回归合并):**见 docs/42 全局回归报告**(独立落盘)

## 6. Architecture Changes

- visual 包加法式扩展(1 模块 + 1 测试);零 shared/跨包修改;
  零 migration、零 REST、零 server/web 改动;Playwright 无新 API。
- 不建第二套:审批/重试语义映射 workflow-engine,fix draft 与 5.6-2
  FrontendTaskDraft 同构,报告/审计沿用既有 serialize。

## 7. Known Issues / Limitations

1. IssueKind 含 "style" 但 5.6-4 当前无 style-kind 产出(docs/39 §3.4 的
   per-section token 留白);style kind 判据就位,token 补齐后自动生效。
2. STALLED 后的实际转人动作(审批/工单)属现有链,本阶段只置状态。
3. Audit trail 的 helpers.serializeReport 是注入点(目前只传 score)——
   5.6-5 的元数据面不需要完整报告重排;5.7 若要全量嵌入,传
   serializeVisualEvaluationReportMd 即可,签名不破。

## 8. Acceptance Result(docs/17 §5.6-5 六项)

| 项 | 状态 |
|---|---|
| Visual issue → Fix Task(schema + 分类) | ✅(visualIssuesFromReport 五 kind;真实只含四,layout/组件/风格原生覆盖;"文案"诚实缺席并记录) |
| Fix Task 具名提交(风险分级,复用 5.5 审批矩阵) | ✅(submissionRisk 冻结派生 + autoSubmitted=false + 现有 approval 链引用) |
| 重截图 → 重评估 → 三态判定 | ✅(determineFixOutcome 纯函数,issue 集比较) |
| 自动重评估循环(上限/死循环检测,复用 workflow-engine retry) | ✅(FixLoopState 纯数据 + 冻结常量;STALLED/MAX_ROUNDS 状态面) |
| 审计串全链可重放 | ✅(serializeFixAuditTrailMd,逐行脱敏) |
| Re-plan 触发:连续 N 轮无进展 → 转 human | ✅(STALLED 状态语义,冻结 stallThreshold=2) |

**Phase 5.6-5:PASS。Phase 5.6 全部子阶段(0~6)至此完成。**
