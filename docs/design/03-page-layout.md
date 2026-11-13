# AI-SE Page Layout Specification

## 1. Global Layout

所有业务页面必须基于：

``` text
AppShell
├── Sidebar
├── Header
└── Main
    └── PageContainer
```

## 2. PageContainer

``` text
padding: 20px
background: #F6F7FB
min-height: calc(100vh - Header)
```

内容区域不要使用固定高度。

## 3. PageHeader

统一结构：

``` text
PageHeader
├── Breadcrumb (optional)
├── Title
├── Description (optional)
└── Actions
```

Primary Action 最多一个。

## 4. Dashboard Template

首页：

``` text
Welcome Banner
        ↓
Quick Actions
        ↓
Statistics
        ↓
Main Dashboard Grid
        ↓
Project Table
```

核心区域：

``` text
Current Workflow
Recent Activity
System Status
Recent Deployments
```

## 5. List Page

``` text
PageHeader
     ↓
FilterBar
     ↓
DataTable
     ↓
Pagination
```

推荐：

``` text
PageHeader
├── Title
├── Description
└── Primary Action

FilterBar
├── Search
├── Select
├── Status
└── More Filters

DataTable

Pagination
```

## 6. Detail Page

``` text
Breadcrumb
PageHeader
Tabs
Content
```

示例：

``` text
项目管理 / Todo 应用

Todo 应用
全栈待办事项应用

[概览] [工作流] [任务] [部署] [设置]
```

## 7. Configuration Page

``` text
PageHeader
Content Card
    Form
    Actions
```

复杂配置可以使用 Sidebar + Configuration Panel。

## 8. Workflow Page

工作流是 AI-SE 核心页面。

推荐：

``` text
PageHeader
Workflow Status
Workflow Graph
Execution Panel
Logs
```

生命周期：

``` text
REQUIREMENT
    ↓
DESIGN
    ↓
DEVELOPMENT
    ↓
VERIFICATION
    ↓
DELIVERY
    ↓
OPERATIONS
```

## 9. Agent Page

``` text
PageHeader
Agent List
    ↓
Agent Detail

Model
Prompt
Tools
Permissions
Execution
History
```

## 10. Deployment Page

``` text
PageHeader
Environment Selector
Deployment Status
Deployment History
Logs
```

状态：

``` text
待部署
部署中
成功
失败
回滚
```

## 11. Page Width

Dashboard 充分利用屏幕。

详情型页面内容较少时可以合理限制 max-width，但不要制造大面积空白。

## 12. Grid

推荐：

``` text
grid-cols-4
grid-cols-3
grid-cols-2
```

Dashboard：

``` text
Current Workflow: 60-65%
Recent Activity: remaining
```

## 13. Page States

每个页面必须考虑：

``` text
Loading
Empty
Error
Success
Partial Data
Permission Denied
```

## 14. Modal / Drawer

统一宽度、Header、Footer、操作按钮、Loading 和错误反馈。

不得改变原业务流程。

## 15. Constraints

禁止：

-   大量 absolute positioning
-   通过固定像素复制截图
-   页面自己创建 Header
-   页面自己创建 Sidebar
-   页面自己创建颜色体系
-   每个页面独立设计 Card
