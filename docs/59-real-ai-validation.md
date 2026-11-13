# Real AI Validation

> 文档类型：V1 后验收 / AI 决策能力验证
>
> 本文不是功能开发文档，不新增 Runtime / Workflow / Agent / Tool。
> 本文用于验证 AI-SE 在接入真实 LLM 后，是否能够真正完成自主软件工程任务。

---

# 1. Purpose

AI-SE 已完成：

- Dynamic Workflow
- Multi-Agent
- ToolRuntime
- MCP
- Browser Computer Use
- Visual Engineering
- Evidence
- Failure Recovery
- Delivery

此前阶段主要验证系统工程能力。

本阶段验证：

> 真实 LLM 是否能够驱动这些能力完成真实软件工程任务。

核心区别：

```text
Scripted Model
    ↓
验证系统“能否执行”

vs

Real LLM
    ↓
验证 AI“是否能够做出正确决策”
2. Validation Scope

本阶段只验证真实 AI 决策能力：

2.1 Planning
PRD
↓
Requirement
↓
Specification
↓
Task
↓
Dependency
↓
DAG

验证：

需求理解
任务拆解
依赖判断
任务完整性
任务粒度
2.2 Agent Decision
Task
↓
Agent
↓
Tool Selection
↓
Code Change

验证：

是否选择正确 Agent
是否选择正确 Tool
是否正确读取上下文
是否正确修改代码
是否正确执行测试
2.3 Dynamic Recovery
Failure
↓
Diagnosis
↓
Re-plan
↓
New Task
↓
Fix
↓
Verification

验证：

是否理解失败
是否改变原计划
是否产生合理新任务
是否避免重复错误
是否最终收敛
2.4 Autonomy

验证：

是否需要人工修改 Workflow
是否需要人工修改 Task
是否需要人工告诉 Agent 下一步
是否出现死循环
是否频繁人工干预
3. Validation Principle
3.1 Black-box

给 AI-SE：

PRD
+
初始项目
+
技术约束

不提前提供：

Task DAG
Agent 分工
Tool 调用顺序
修复方案
代码实现方案
3.2 Platform capability must remain unchanged

测试期间不得为了某个 PRD：

修改 Workflow
修改 Agent Runtime
修改 ToolRuntime
增加专用 Tool
手工修改 Task
手工修正 Planning

否则实验结果无效。

3.3 Separate model capability from platform capability

实验结果必须区分：

Platform Failure
Model Failure
Environment Failure
Prompt Failure
External Configuration Failure
4. Golden Project

定义一个用于重复实验的最小项目。

要求：

前后端
数据库
API
前端页面
测试
可构建
可部署

项目初始状态必须固定。

每次实验：

Git Commit / Snapshot
↓
恢复到同一初始状态
↓
重新执行

禁止实验之间污染工作区。

5. Golden PRD

第一阶段使用一个中等复杂度的小型全栈需求。

推荐：

Todo / Issue Management System

需求至少包含：

CRUD
数据持久化
REST API
前端页面
Loading
Empty
Error
Validation
Unit Test
API Test
Build
Deployment

PRD 本身必须只描述：

What
Why
Acceptance Criteria

不要提前描述：

How
Task
Agent
Tool
Workflow
6. Experiment Matrix
Run A — Normal Execution

目标：

验证正常情况下真实 LLM 能否完成：

PRD
→ Planning
→ Task DAG
→ Multi-Agent
→ Code
→ Test
→ Review
→ Delivery
Run B — Failure Injection

在预定位置引入一个可控失败。

例如：

API test failure

验证：

Failure
→ Diagnosis
→ Re-plan
→ New Task
→ Fix
→ Re-test
Run C — Independent Repeat

保持：

PRD
初始代码
Model
Prompt
Tools

不变，重新执行。

用于观察：

Planning consistency
Tool selection consistency
Recovery consistency
Final outcome consistency
7. Model Configuration

本节只记录“实验变量”，不负责介绍环境部署。

记录：

Model:
Provider:
Model Version:
Temperature:
Max Tokens:
Context Window:
Tool Calling:
Structured Output:
Prompt Version:

不同模型测试必须使用同一套：

PRD
Initial Project
Acceptance Criteria
Tool permissions
Workflow rules

这样才能进行 A/B。

8. Metrics
Planning
Task Count
Missing Task Count
Duplicate Task Count
Dependency Correctness
Task Granularity
Agent
Agent Selection Accuracy
Tool Call Count
Invalid Tool Calls
Unnecessary Tool Calls
Code Change Count
Test Pass Rate
Recovery
Failure Count
Correct Diagnosis
Retry Count
Re-plan Count
New Task Quality
Recovery Success
Autonomy
Manual Workflow Edits
Manual Task Edits
Manual Agent Intervention
Approval Count
Human Recovery Count
Outcome
Build PASS
Test PASS
Review PASS
Staging PASS
Deployment PASS
9. Success Criteria
Minimum
Build = PASS
Test = PASS
No unrecovered failure
Dynamic Workflow
Manual Workflow Edit = 0
Manual Task Edit = 0
Failure can trigger Re-plan
Re-plan can create valid Task
Agent
Tool calls valid
Code changes valid
Tests eventually PASS
No infinite loop
Overall
Real LLM
→ Planning
→ Dynamic Workflow
→ Multi-Agent
→ Code
→ Test
→ Recovery
→ Delivery

完整运行成功。

10. Failure Classification

实验中出现失败时必须分类：

PLATFORM_FAILURE
MODEL_FAILURE
PROMPT_FAILURE
ENVIRONMENT_FAILURE
EXTERNAL_CONFIG_FAILURE

例如：

PLATFORM_FAILURE

Workflow / persistence / ToolRuntime / Sandbox 本身错误。

MODEL_FAILURE

模型错误拆解任务、错误选择工具、错误实现。

PROMPT_FAILURE

系统 Prompt / Agent Contract 导致模型无法正确执行。

ENVIRONMENT_FAILURE

Docker / PostgreSQL / Browser / network 等实验环境问题。

EXTERNAL_CONFIG_FAILURE

VLM / GitHub / GHCR / production 等外部依赖缺失。

11. Experiment Record

每次 Run 保存：

Run ID
Date
Model
Prompt Version
PRD Version
Project Snapshot
Task Graph
Agent Runs
Tool Calls
Failures
Retries
Re-plans
Human Interventions
Final Test
Final Build
Final Deployment

同时保存：

Workflow events
Agent runs
Tool calls
Task graph
Evidence
Final artifacts
12. Real LLM Acceptance

最终判断分为：

Platform Capability

PASS / FAIL

Dynamic Workflow Capability

PASS / PARTIAL / FAIL

Real AI Decision Capability

PASS / PARTIAL / FAIL

Autonomous Engineering

PASS / PARTIAL / FAIL

Overall
ACCEPTED
/
CONDITIONALLY ACCEPTED
/
NOT ACCEPTED
13. First Validation Target

第一轮建议使用：

Golden Project
+
Golden PRD
+
一个真实 Coding / Reasoning Model

先只验证：

Planning
→ Dynamic Workflow
→ Multi-Agent
→ Test
→ Recovery

暂不把：

GitHub
GHCR
Production
Figma
VLM

作为第一轮必要条件。

这些属于 External Validation。

14. Model Comparison

第二阶段可以使用相同 Golden Scenario 比较：

Model A
Model B
Qwen

比较：

Planning
Tool Calling
Code Quality
Failure Recovery
Task Efficiency
Human Intervention

目标不是比较“谁分数高”，而是确定：

哪种模型最适合作为 AI-SE 的决策层。

15. Final Acceptance Principle

最终不要用：

Tests Passed

直接证明 AI-SE 成功。

最终判断必须满足：

Real LLM
+
Real PRD
+
Real Task Planning
+
Real Agent Execution
+
Real Failure
+
Real Re-plan
+
Real Verification
+
Minimal Human Intervention