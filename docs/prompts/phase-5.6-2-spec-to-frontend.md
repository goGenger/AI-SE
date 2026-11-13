# Phase 5.6-2 — UI Specification → Frontend

开始前必须阅读：
- `docs/17-acceptance-checklist.md` §5.6-2
- `docs/18-phase-engineering-goals.md` §Phase 5.6
- `docs/23-phase-5.6-implementation-plan.md`
- `docs/35-phase-5.6-0-visual-contract.md`
- `docs/36-phase-5.6-1-visual-analysis.md`
- `packages/visual`
- `packages/agent-core` Frontend Agent
- `packages/tool-runtime`
- `packages/sandbox`
- `packages/workflow-engine` Task 模型

目标：不是只生成 Frontend Task Draft，而是让 Frontend Agent 真正消费 UI Specification 并完成页面代码修改。

要求：
1. 保留现有 FrontendTaskDraft 作为中间结构，不创建第二套 Task。
2. Component Map 优先匹配现有组件库；缺失组件必须显式报告。
3. Design Tokens、Layout、Assets 必须进入 Frontend 实现上下文。
4. Frontend Agent 必须通过现有 Agent → ToolRuntime → Sandbox/Tools 执行代码修改。
5. 禁止 Visual 包直接写文件、执行 shell 或绕过 Sandbox。
6. 完成至少一个真实页面的 build / run / render E2E。
7. 修复/生成失败必须返回结构化结果。

测试至少覆盖：
- spec → task draft
- task → frontend agent
- 实际代码修改
- build
- browser render
- component reuse
- missing component
- permission / sandbox / audit regression

完成后运行全仓验证并 STOP。
