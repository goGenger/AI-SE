# Phase 5.6-1 — Visual Analysis

开始前必须阅读：
- `docs/17-acceptance-checklist.md` §5.6-1
- `docs/18-phase-engineering-goals.md` §Phase 5.6
- `docs/23-phase-5.6-implementation-plan.md`
- `docs/35-phase-5.6-0-visual-contract.md`
- `packages/shared` Visual Contract 实际代码
- `packages/visual` 当前实现
- `packages/observability` 脱敏能力

目标：完成 Screenshot / Figma / URL → Visual Analysis → UI Specification 的真实分析链路。

要求：
1. 复用 5.6-0 冻结 Contract，不自行重定义 Visual Specification。
2. 使用可替换 `VLMProvider`；Fake Provider 仅用于测试，不能作为完整能力验收。
3. Screenshot、Figma、URL 三类输入必须有明确入口与校验；外部访问继续走受控边界。
4. 输出必须严格符合 UI Specification / VisualAnalysisReport。
5. 几何、排序、ID、schema 校验等确定性逻辑不得依赖 VLM 自由文本。
6. 不实现 Frontend Agent、Browser Runtime、Visual Evaluation、Auto Fix。
7. 敏感 URL / 文本 / metadata 必须脱敏，不进入 state/log。

测试至少覆盖：
- Screenshot真实分析
- Figma输入
- URL输入
- malformed analysis
- provider timeout/cancel
- strict schema
- 结果稳定性
- secret redaction

完成后运行 typecheck / lint / test / build，全仓回归；输出报告并 STOP。
