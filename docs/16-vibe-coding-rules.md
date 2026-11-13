# Vibe Coding Rules

1. 只实现当前 Phase。
2. 不提前实现后续 Phase。
3. 修改前阅读相关代码和文档。
4. 不重复实现已有能力。
5. 核心逻辑必须有测试。
6. 每次修改运行 lint/typecheck/test。
7. 架构问题先报告，不偷偷大规模重构。
8. 新依赖必须说明原因和版本/兼容性。
9. 禁止滥用 any。
10. 禁止 TODO 代替核心实现。
11. 禁止 Mock 代替核心逻辑。
12. 禁止硬编码 API Key。
13. Workflow 必须可恢复、可取消。
14. 敏感信息不得进入日志。
15. Agent 不得绕过 Tool Runtime。
16. Tool 不得绕过 Sandbox 执行代码。
17. 不要把 LangGraph 当成整个业务 Workflow Engine。
18. 不要在 Phase 1 引入 Deep Agents。
19. Phase 5 才允许引入 Deep Agents，并说明其与 LangGraph 的职责边界。
20. 每个 Phase 完成后更新文档。

## AI Framework 选择规则

- LangGraph：Agent execution graph / state / routing / persistence integration。
- LangChain：LLM、Message、Tool 等基础抽象。
- Deep Agents：高级 Coding Agent Harness，仅在 Phase 5 使用。
- 自研代码：平台业务 Runtime、Tool Runtime、Policy、Sandbox、Workflow、Task、Audit 等。

禁止为了“自己实现框架”而重新实现 LangGraph 已提供的底层 graph execution 能力。

## 完成报告

必须包含：

Modified Files、Implementation、Architecture Changes、Dependencies、Tests、Lint、Typecheck、E2E、Known Issues、Acceptance Result、Next Phase Boundary。


## MCP Engineering Rules

20. MCP 只能通过 Tool Runtime 使用，禁止 Agent 直接访问 MCP Client/Server。
21. 不自行实现 MCP Protocol，优先使用官方 MCP SDK。
22. 不建立第二套 Permission / Approval / Audit / Secret 系统。
23. MCP Tool 必须经过统一 ToolDefinition / Policy / Audit。
24. 默认未绑定 MCP Server / Tool 为 DENY。
25. Policy DENY 时必须保证 MCP Server 不收到请求。
26. 明文 credential/token 不得进入 Prompt、State、Task、Log、Result 或 Git。
27. 每次 Phase 5.5 只实现一个 Sub-phase，完成后停止，不自动进入下一阶段。
28. Remote MCP 不自建 OAuth Provider。
29. MCP Apps 不得绕过 Tool Runtime。
30. MCP Resource / Prompt 不得强行塞入 ToolDefinition 或 Agent State。
