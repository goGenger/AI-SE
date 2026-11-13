# Phase 5.6-5 — Auto Fix / Re-plan

开始前必须阅读：
- `docs/17-phase-5.6` acceptance section
- `docs/18-phase-engineering-goals.md` §Phase 5.6
- `docs/23-phase-5.6-implementation-plan.md`
- `docs/37-phase-5.6-2-spec-to-frontend-task.md`
- `docs/39-phase-5.6-4-visual-evaluation.md`
- `packages/visual`
- `packages/agent-core`
- `packages/tool-runtime`
- `packages/sandbox`
- `packages/workflow-engine`

目标：把 Visual Issue 真正转成 Fix Task，并执行 Frontend Agent 修复，再自动截图和重新评估。

核心链路：

Visual Issue
→ Fix Task
→ Frontend Agent
→ ToolRuntime / Sandbox
→ Code Change
→ Browser
→ Screenshot
→ Visual Evaluation
→ Outcome

要求：
1. 复用现有 Task / Agent / Sandbox / ToolRuntime，不创建第二套执行器。
2. Fix Task Draft 不能作为最终执行结果。
3. `autoSubmitted=false` 不能作为完成态；必须提供真实执行路径。
4. max rounds、no-progress、regression detection 必须真实生效。
5. STALLED 必须进入既有 human/workflow boundary。
6. 风险与审批不得由 visual 包独立决定，继续复用现有平台治理。
7. 全链路 evidence / audit 必须可追溯并脱敏。

测试至少覆盖：
- issue → task
- real frontend agent fix
- code diff
- browser rerun
- screenshot rerun
- automatic re-evaluation
- resolved / new issue / regression
- max rounds
- stall
- approval / permission
- audit

完成后运行全仓验证并 STOP。
