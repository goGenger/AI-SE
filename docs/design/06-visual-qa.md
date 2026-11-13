# AI-SE Visual QA Specification

## 1. Purpose

Visual QA 确保重构后的页面：

1.  与 AI-SE Design System 一致
2.  与 Figma / Reference Image 保持高还原
3.  不因不同页面由不同 AI 生成而产生视觉漂移

## 2. Reference Priority

``` text
AI-SE Design System
        ↓
Page Design Specification
        ↓
Reference Image
        ↓
Implementation
```

截图中的单个细节与 Design System 冲突时，Design System 优先。

## 3. Visual QA Dimensions

至少检查：

``` text
Overall Layout
Sidebar
Header
Page Width
Section Spacing
Card Size
Typography
Color
Border
Radius
Shadow
Icon
Alignment
Empty Space
Responsive
```

## 4. Overall Layout

检查：

-   页面整体比例
-   内容是否居中/铺满合理
-   模块顺序
-   Grid 比例
-   首屏信息密度

首页重点：

``` text
Welcome
Quick Actions
Statistics
Workflow
Recent Activity
System Status
Deployments
Projects
```

## 5. Sidebar QA

检查：

``` text
Width
Menu height
Icon size
Text size
Active background
Active color
Indentation
Collapsed state
```

禁止出现第二侧栏。

## 6. Header QA

检查：

``` text
Height
Search width
System status
Notification
User area
Border
Alignment
```

## 7. Typography QA

检查：

-   Title hierarchy
-   Font weight
-   Line height
-   Number size
-   Secondary text

## 8. Color QA

重点：

``` text
Primary
Primary Light
Background
Card
Border
Text
Status
```

如果多个页面存在颜色偏差，应优先修复 Design Token。

## 9. Spacing QA

使用 4px spacing system。

检查：

``` text
Page padding
Section gap
Card padding
Grid gap
Button gap
Table row spacing
```

## 10. Component QA

检查：

``` text
Button
Card
Badge
Table
Dialog
Drawer
Input
Select
Tabs
Tooltip
```

公共组件不一致时，修复公共组件，而不是只修当前页面。

## 11. Screenshot Comparison

``` text
Reference Image
      ↓
Current Browser Screenshot
      ↓
Visual Comparison
      ↓
Identify Differences
      ↓
Fix Top 10 Differences
      ↓
Screenshot Again
```

## 12. Difference Priority

### P0

-   页面结构错误
-   模块位置错误
-   Sidebar/Header 错误
-   核心布局比例错误

### P1

-   Card 尺寸
-   间距
-   字体层级
-   Primary color
-   Button 尺寸

### P2

-   Border
-   Radius
-   Shadow
-   Icon size

### P3

-   微小颜色偏差
-   细微间距差异

## 13. AI Visual QA Prompt

``` text
请对比 Reference Image 和当前页面截图。

只进行 Visual QA，不修改业务逻辑。

检查：

- Layout
- Sidebar
- Header
- Spacing
- Typography
- Color
- Border
- Radius
- Shadow
- Icon
- Alignment
- Responsive

按照影响程度列出最大的 10 个视觉差异。

然后只修复这些视觉差异。

不要重新设计页面。
不要修改 API。
不要修改 Store。
不要修改业务逻辑。
不要修改 Route。
```

## 14. Functional QA

Visual QA 通过并不代表完成。

必须额外验证：

``` text
API
Router
Permission
CRUD
Form
Search
Filter
Pagination
Loading
Error
Empty
Workflow
Agent
Deployment
```

## 15. Responsive QA

至少测试：

``` text
1440 × 900
1280 × 800
1024 × 768
```

检查：

-   无横向溢出
-   Sidebar 正常
-   Grid 正常换行
-   Table 可滚动
-   Dialog 正常
-   Button 不被遮挡
-   文字不异常截断

## 16. Definition of Done

页面只有同时满足：

``` text
Visual QA PASS
Functional QA PASS
Type Check PASS
Lint PASS
Test PASS
```

才可以进入下一个业务页面。

## 17. Global Consistency Check

完成多个页面后检查：

``` text
首页
项目管理
工作流
任务管理
智能体
部署管理
代码仓库
系统设置
```

比较：

``` text
Sidebar
Header
PageHeader
Button
Card
Table
StatusBadge
Dialog
Spacing
Typography
Colors
```

目标：

> 用户应该一眼认为所有页面都属于同一个 AI-SE 产品。
