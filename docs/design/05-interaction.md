# AI-SE Interaction Specification

## 1. Philosophy

AI-SE 是工程工具，不是展示型网站。

交互必须：

-   predictable
-   clear
-   fast
-   reversible when possible
-   feedback-driven

避免过度动画。

## 2. Hover

Hover 只提供轻量反馈。

适用：

``` text
Card
Table Row
Button
Navigation Item
```

不要明显位移或缩放。

## 3. Focus

所有可交互元素必须保留清晰 focus：

``` text
Button
Input
Select
Tabs
Navigation
Dialog
```

## 4. Loading

页面首次加载优先 Skeleton。

按钮提交：

``` text
Loading
+
Disabled
```

长期任务：

``` text
Running
Progress
Current Step
Logs
```

## 5. Empty

列表必须有 Empty State：

``` text
Title
Description
Primary Action
```

## 6. Error

推荐：

``` text
操作失败

无法启动工作流，请稍后重试。

[重试]
```

不要只显示 Error 500。

## 7. Toast

用于：

-   保存成功
-   删除成功
-   部署成功
-   操作失败

重要业务信息不要全部塞入 Toast。

## 8. Dialog

适合：

``` text
删除确认
创建项目
编辑配置
选择环境
```

危险操作必须明确：

``` text
取消
确认删除
```

## 9. Drawer

适合：

``` text
任务详情
Agent Run
Tool Call
执行日志
项目快速详情
```

Drawer 不替代复杂详情页面。

## 10. Long Running Operations

以下操作可能长期运行：

``` text
Agent Run
Workflow Run
Test
Build
Deployment
```

必须显示：

``` text
状态
开始时间
当前阶段
进度（如果可计算）
日志
停止 / 取消（如果业务支持）
```

## 11. Workflow Interaction

节点状态：

``` text
Pending
Running
Success
Failed
Skipped
Cancelled
```

Running 可以轻微动画，但不得高强度闪烁。

## 12. Agent Interaction

执行过程可以展示：

``` text
Thinking / Running
Tool Call
Tool Result
Next Step
Completed
Failed
```

已有 Action Policy / Approval 机制时，UI
必须复用现有机制，不得绕过权限或审批。

## 13. Confirmation

原则上确认：

``` text
Delete
Stop running task
Cancel deployment
Rollback
Remove agent/tool configuration
```

已有确认规则必须保持。

## 14. Form

``` text
Input
 ↓
Validation
 ↓
Submit
 ↓
Loading
 ↓
Success / Error
```

不得修改原业务校验规则。

## 15. Search

建议：

-   debounce
-   loading
-   clear
-   empty state

如果现有 API 已支持服务端搜索，优先继续使用服务端搜索。

## 16. Table

支持时：

``` text
Sort
Filter
Selection
Pagination
Row Action
```

但必须保持原业务功能。

## 17. Animation

``` text
Fast
Subtle
Purposeful
```

推荐 150-250ms。

避免长时间循环动画。

## 18. Responsive Interaction

``` text
Sidebar → Collapsed
Grid → Wrap
Table → Horizontal Scroll
Actions → Wrap / Dropdown
```

不得隐藏关键业务操作。

## 19. Interaction Regression

检查：

``` text
Click
Submit
Cancel
Delete
Search
Filter
Pagination
Navigation
Dialog
Drawer
Workflow Run
Agent Run
Deployment
```

任何交互行为变化都必须显式说明。
