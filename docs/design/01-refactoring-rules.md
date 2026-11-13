# AI-SE Frontend Refactoring Rules

> Version: 1.0\
> Refactoring Type: UI/UX Refactoring\
> Principle: Visual Redesign, Functional Preservation

## 1. Core Principle

AI-SE 当前前后端业务已经开发完成。本阶段不是重写项目，而是：

-   重构前端视觉
-   引入 Tailwind CSS 4
-   引入 shadcn-vue
-   建立 Design System
-   优化组件结构
-   保持原有业务功能

> **Visual Redesign ≠ Business Rewrite**

## 2. Protected Areas

以下内容默认属于保护范围：

-   Backend API
-   API endpoint
-   Request parameters
-   Response semantics
-   Authentication
-   Authorization
-   Permission codes
-   Business rules
-   Data persistence
-   Route paths
-   Existing critical user flows
-   Existing business state

没有明确任务时不得修改。

## 3. Refactorable Areas

允许重点修改：

-   Page layout
-   CSS
-   Tailwind classes
-   UI components
-   Component composition
-   Visual states
-   Spacing
-   Typography
-   Color
-   Border
-   Shadow
-   Responsive behavior

## 4. API Contract Preservation

API 必须保持兼容。

如果新 UI 所需数据结构与旧 API 不同：

``` text
Existing API
    ↓
Adapter / Mapper
    ↓
View Model
    ↓
New UI
```

优先在前端增加 Adapter，不修改后端。

## 5. Route Preservation

允许调整 Route Component 和 Meta，但未经授权不得修改：

-   URL path
-   Route name
-   Permission metadata

## 6. Permission Preservation

必须保持：

-   页面权限
-   菜单权限
-   按钮权限
-   操作权限
-   数据权限

UI 重构不得绕过权限。

## 7. State Preservation

不要因为引入新 UI 框架而重写所有 Store。

优先：

``` text
Existing Store
    ↓
View Adapter
    ↓
New UI
```

## 8. No Unrelated Refactoring

Agent 不得顺手：

-   重命名大量文件
-   重构后端
-   重写 API 层
-   替换状态管理
-   更换 Router
-   更换构建工具
-   删除"看起来没用"的代码
-   升级无关依赖
-   修改数据库
-   改变业务逻辑

发现潜在问题应记录，不在当前任务中擅自处理。

## 9. Baseline Freeze

开始重构前建立 baseline：

``` text
Build
Type Check
Lint
Test
Route Count
Page Count
Critical User Flows
```

重构完成后重新验证。

## 10. Functional Equivalence

每个页面必须验证：

-   原有功能仍存在
-   原有按钮仍存在
-   原有 API 正常
-   原有路由正常
-   原有权限正常
-   原有表单校验正常
-   Loading / Error / Empty 正常
-   原有用户流程可以完成

## 11. Page-by-Page Strategy

禁止一次性重构整个前端。

``` text
Baseline
 ↓
AppShell
 ↓
Homepage
 ↓
Project Management
 ↓
Workflow
 ↓
Task Management
 ↓
Agent
 ↓
Deployment
 ↓
Repository
 ↓
Settings
 ↓
Global Regression
```

一次只处理一个业务域。

## 12. Two-Phase Page Refactoring

### Phase A: Visual

只替换 Layout、CSS、Components、Styling，尽可能不动 API、Store、Business
Logic。

### Phase B: Componentization

将重复结构逐步抽取为：

-   PageHeader
-   FilterBar
-   DataTable
-   StatusBadge
-   EmptyState
-   ConfirmDialog

## 13. Change Report

每次任务结束输出：

``` text
Modified Files
New Files
Deleted Files
API Changes
Route Changes
State Changes
Business Logic Changes
Potential Risks
Validation Results
```

如果 API、Route、State 或 Business Logic 被修改，必须明确说明原因。

## 14. AI Coding Safety Rule

开始修改前必须判断：

``` text
Visual Change
or
Functional Change
```

Visual Change 不得扩大修改范围。

Functional Change 必须明确受影响的业务契约。

## 15. Definition of Done

页面只有同时满足以下条件才算完成：

-   Visual QA PASS
-   Functional QA PASS
-   Type Check PASS
-   Lint PASS
-   Test PASS（如果项目已有测试）
-   No unintended API change
-   No unintended route change
-   No unintended permission change
-   No unrelated refactoring
