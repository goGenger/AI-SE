# AI-SE Navigation Specification

## 1. Navigation Philosophy

AI-SE 是 AI Software Engineering
Platform。导航必须体现软件工程生命周期和平台能力，而不是普通后台菜单堆叠。

一级菜单：

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

## 2. Sidebar

Sidebar 属于全局 AppShell。

``` text
Width: 164px
Position: fixed / sticky
Background: #FFFFFF
Border-right: 1px solid border
```

业务页面不得自行创建 Sidebar。

## 3. Level 1

要求：

-   统一图标
-   统一高度
-   统一字体
-   统一 hover
-   统一 active
-   active 使用 Primary Light
-   active text/icon 使用 Primary

## 4. Level 2

示例：

``` text
项目管理
  项目列表
  项目模板
  项目归档

工作流
  工作流列表
  工作流运行
  工作流模板

任务管理
  任务列表
  执行记录
  失败任务

智能体
  Agent 列表
  Agent 运行
  Agent 配置

部署管理
  环境管理
  部署记录
  发布管理
```

二级菜单：

-   同一 Sidebar
-   左侧缩进约 12px
-   字体 13px
-   muted foreground
-   active 使用浅紫背景
-   不增加新颜色体系

## 5. Level 3

仅在确实需要时使用：

-   更小视觉权重
-   增加缩进
-   不使用独立卡片
-   不使用新背景色
-   不使用新品牌色

## 6. Expanded / Collapsed

支持：

``` text
Expanded
Collapsed
```

Collapsed：

-   保留图标
-   隐藏文字
-   Tooltip 显示菜单名称

业务页面不能依赖 Sidebar 展开状态决定功能。

## 7. Active State

Active 必须由 Router 状态驱动，不要在组件内部维护独立 active 状态。

``` text
Route
 ↓
Navigation Resolver
 ↓
Active Menu
```

## 8. Breadcrumb

详情页可以使用：

``` text
项目管理 / Todo 应用 / 项目详情
```

当前页面默认不可点击，上级页面可以点击。

## 9. Header

``` text
Height: 52px
Background: white
Border-bottom: 1px solid border
```

内容：

``` text
Search
System Status
Notification
User
```

业务页面不得重新设计 Header。

## 10. Quick Actions

首页快速开始不属于 Sidebar 第二栏。

正确：

``` text
Main Content
 ├── Welcome Banner
 ├── Quick Actions
 └── Dashboard
```

错误：

``` text
Main Sidebar
Secondary Quick Start Sidebar
Main Content
```

## 11. Navigation Interaction

Hover：轻微背景变化。

Active：Primary Light + Primary text/icon。

Focus：可见 focus ring。

Disabled：muted + 不可点击。

## 12. Constraints

禁止：

-   为不同业务模块设计不同 Sidebar
-   每个页面独立 Header
-   一级菜单使用不同颜色
-   二级菜单使用不同视觉体系
-   复杂渐变导航背景
-   大量动画改变导航结构
