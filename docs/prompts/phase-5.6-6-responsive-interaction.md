# Phase 5.6-6 — Responsive & UI State Validation

开始前必须阅读：
- `docs/17-acceptance-checklist.md` §5.6-6
- `docs/23-phase-5.6-implementation-plan.md`
- `docs/38-phase-5.6-3-browser-runtime.md`
- `docs/39-phase-5.6-4-visual-evaluation.md`
- `packages/browser`
- `packages/visual`
- `packages/shared` VisualState schema

目标：真实验证不同 viewport 和 UI state 的视觉结果，并复用 5.6-4 Visual Evaluation。

要求：
1. 至少 desktop / mobile 两个 viewport。
2. Responsive 必须真实触发 CSS/layout breakpoint。
3. UI State 必须通过真实页面状态或真实受控交互产生，不能仅构造 JSON 差异。
4. 覆盖 loading / empty / error / disabled / focus / active / hover / expanded / modal 等已有状态；无法真实触发的状态必须在报告中明确原因，不得假装 PASS。
5. 所有截图重新经过 `evaluateVisuals`。
6. 不创建新的评分体系或第二套 Visual Evaluation。
7. 不实现 Auto Fix。

测试至少覆盖：
- desktop
- mobile
- breakpoint change
- real state transition
- screenshot
- visual evaluation
- state regression
- cleanup

完成后运行全仓验证并 STOP。
