# AI-SE Component System

## 1. Component Architecture

``` text
UI Primitives
    ↓
AI-SE Common Components
    ↓
Business Components
    ↓
Page Components
```

## 2. UI Primitives

优先使用 shadcn-vue / Reka UI：

``` text
Button
Card
Dialog
Drawer
DropdownMenu
Input
Select
Textarea
Tabs
Tooltip
Popover
Badge
Progress
Separator
Skeleton
```

不要重复实现已有基础组件。

## 3. Layout Components

统一：

``` text
AppShell
AppSidebar
AppHeader
PageContainer
```

AppShell 不负责具体业务数据。

## 4. Common Components

推荐：

``` text
PageHeader
FilterBar
DataTable
StatusBadge
EmptyState
ErrorState
LoadingState
ConfirmDialog
SearchInput
Pagination
```

## 5. Business Components

根据 AI-SE 业务建立：

``` text
ProjectCard
ProjectStatus
WorkflowProgress
WorkflowNode
AgentStatus
AgentRun
DeploymentStatus
DeploymentHistory
TaskStatus
TaskTimeline
ToolCall
ExecutionLog
```

## 6. PageHeader

统一：

``` text
Title
Description
Actions
```

Actions 使用 Button。

## 7. FilterBar

统一处理：

-   Search
-   Select
-   Status
-   Date range
-   More filters
-   Reset

FilterBar 不直接调用业务 API。

推荐：

``` text
UI
 ↓
Emit filter change
 ↓
Page
 ↓
API / Store
```

## 8. StatusBadge

统一状态：

``` text
success
running
pending
warning
error
disabled
```

组件负责 status → visual mapping。

## 9. DataTable

DataTable 负责：

-   columns
-   rows
-   sorting
-   selection
-   loading
-   empty
-   pagination hooks

业务页面负责 API、data mapping、business actions。

## 10. EmptyState

统一：

``` text
Icon
Title
Description
Action
```

## 11. Loading

优先 Skeleton。

按钮提交使用：

``` text
Loading + Disabled
```

## 12. Error

错误信息：

-   清晰
-   可理解
-   不泄露敏感信息
-   适用时提供重试

## 13. Dialog

用于：

-   确认
-   创建
-   编辑
-   删除

危险操作使用 destructive variant。

## 14. Component Reuse

``` text
1 occurrence → page local
2 occurrences → evaluate
3+ occurrences → strongly consider shared component
```

## 15. Naming

Vue 文件使用：

``` text
PascalCase.vue
```

例如：

``` text
PageHeader.vue
StatusBadge.vue
WorkflowProgress.vue
ProjectCard.vue
```

## 16. Props / Emits

必须：

-   明确 Props 类型
-   明确 Emits 类型
-   不使用隐式 any
-   不直接修改父状态
-   不直接调用无关 API

## 17. Business Logic Separation

推荐：

``` text
Page
 ↓
Composable / Store
 ↓
API
```

纯 UI 组件：

``` text
Props
 ↓
Render
 ↓
Emit
```

## 18. Design Token

优先：

``` text
bg-background
bg-card
bg-primary
text-foreground
text-muted-foreground
border-border
```

禁止大量硬编码颜色。

## 19. Accessibility

必须考虑：

-   keyboard navigation
-   focus
-   aria-label
-   disabled
-   tooltip
-   dialog focus management
