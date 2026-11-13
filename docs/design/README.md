# AI-SE Design Documentation

本目录用于 AI-SE 前端 UI/UX 重构。

## Documents

1.  `00-design-system.md` --- 颜色、字体、间距、组件和 Tailwind 设计
    Token
2.  `01-refactoring-rules.md` ---
    前端重构边界、API/路由/权限保护和回归要求
3.  `02-navigation.md` ---
    Sidebar、一级/二级/三级菜单、Header、Breadcrumb
4.  `03-page-layout.md` ---
    Dashboard、列表页、详情页、Workflow、Agent、Deployment 页面模板
5.  `04-component-system.md` --- shadcn-vue、AI-SE
    公共组件和业务组件分层
6.  `05-interaction.md` ---
    Loading、Empty、Error、Dialog、Drawer、Workflow、Agent 等交互
7.  `06-visual-qa.md` --- Figma/截图视觉验收、功能回归和 Definition of
    Done

## Recommended reading order

``` text
00 Design System
       ↓
01 Refactoring Rules
       ↓
02 Navigation
       ↓
03 Page Layout
       ↓
04 Component System
       ↓
05 Interaction
       ↓
06 Visual QA
```

## Important

本规范默认前后端已有功能已经完成，本阶段是前端 UI/UX 重构。

核心原则：

> Visual Redesign, Functional Preservation.

不得因为 UI 重构而未经授权修改
API、路由、权限、业务规则、数据结构或核心状态。
