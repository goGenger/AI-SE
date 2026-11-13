# Product Requirements

> ## 基线状态（2026-10-15）
>
> 本文是**产品定义**，写于平台实现之前。其中**「核心原则」仍是现行有效的约束**——「AI 负责执行，人类负责高风险决策」「高风险操作必须有审批、审计和回滚」，它也是「自治 L1」的边界依据（`docs/17` 的「自治 L1 · 策略内自治」节）。「核心能力」清单是**产品目标，不是完成度声明**；逐项状态见 `docs/146` §1–§2。

## 产品

AI-SE（AI Software Engineer）

## 定位

让 AI 从需求开始参与完整软件生命周期：需求分析、设计、开发、测试、审查、交付，并最终扩展到运维诊断和受控自愈。

## 核心能力

1. Requirement Understanding
2. Specification
3. Task Planning
4. Coding Agent
5. Agent Runtime
6. Tool Runtime
7. Sandbox
8. Dynamic Workflow
9. Multi-Agent
10. Testing / Evaluation
11. CI/CD
12. Observability
13. AI SRE

## AI 技术分层

```text
Business Workflow / Application
            ↓
     Our Agent Runtime
            ↓
       LangGraph.js
            ↓
       LangChain.js
            ↓
        LLM Provider
```

高级 Coding Agent：

```text
Deep Agents
    ↓
LangGraph
    ↓
LangChain
```

Deep Agents 不是整个系统的 Workflow Engine，也不是 Phase 1 的依赖。

## 核心原则

- AI 负责执行，人类负责高风险决策。
- Agent 不直接访问外部系统，统一经过 Tool Runtime。
- Tool Runtime 是权限和审计边界。
- Docker Sandbox 是执行隔离边界。
- 高风险操作必须有审批、审计和回滚。
- 任何生产环境修改必须可追踪。
- 不展示模型隐藏 Chain-of-Thought。


## Final Architecture Addendum

本版本在原始产品定义基础上正式纳入 **UI/Visual Engineering** 与 **MCP Tool Federation**，但不改变 AI-SE 的核心定位。

### UI / Visual Engineering

AI-SE 支持从 Screenshot / Figma / URL / Existing UI Code 出发完成视觉还原：

```text
Visual Input
  ↓
Visual Analysis
  ↓
UI Specification
  ↓
Design Tokens / Component Map
  ↓
Frontend Agent
  ↓
Browser Runtime
  ↓
Screenshot
  ↓
Visual Evaluation
  ↓
Fix / Re-plan
```

视觉还原属于 Frontend Agent 的工程能力，不建立第二套 Agent Runtime。

### MCP

MCP 是外部工具接入协议，不是新的 Workflow Engine 或 Agent Runtime：

```text
Agent
  ↓
AI-SE Tool Runtime
  ↓
MCP Adapter
  ↓
Official MCP SDK
  ↓
MCP Server
  ↓
External System
```

Agent 永远不得直接调用 MCP Client/Server。MCP Tool 必须与 Native Tool 使用同一套 Policy、Risk、Approval、Audit、Timeout、Cancellation 和 Secret Redaction。

### 产品边界

AI-SE 自研的核心能力：

- Requirement / Specification / Task / Artifact
- Domain Workflow / Dynamic Re-planning
- Agent Registry / Capability Routing
- Tool Runtime / Policy / Audit
- Sandbox / Security
- Evaluation / Quality Gates
- Visual Evaluation
- Delivery Orchestration
- MCP Governance
- 后续 AI SRE

不自研：

- MCP Protocol
- MCP SDK
- 通用 OAuth Provider
- 通用 Agent Framework
- 通用 Workflow SaaS
- 通用 Browser Automation Framework
