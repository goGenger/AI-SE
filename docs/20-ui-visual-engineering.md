# UI Visual Engineering

## 1. Purpose

AI-SE 的 Frontend Agent 不仅负责按照文字需求开发页面，还需要支持 Screenshot、Figma、URL 和 Existing UI Code 驱动的视觉还原。

目标不是“截图看起来差不多”，而是建立可验证的视觉工程闭环：

```text
Input
  ↓
Visual Analysis
  ↓
UI Specification
  ↓
Design Tokens
  ↓
Component Mapping
  ↓
Frontend Implementation
  ↓
Browser Render
  ↓
Screenshot
  ↓
Visual Evaluation
  ↓
Fix / Re-plan
```

## 2. Input

支持：

- Screenshot / PNG / JPG / WebP
- Figma design
- Existing web URL
- Existing frontend code
- Textual UI requirements

输入最终必须转换为结构化 UI Specification，而不是让 Agent 仅凭自然语言猜测。Screenshot / Figma / URL 是 Phase 5.6 的核心输入类型；Existing UI Code 可作为扩展输入，但不应阻塞 MVP。

## 3. UI Specification

至少包含：

```text
page
viewport
layout
sections
components
spacing
typography
colors
borders
shadows
states
responsive rules
interactions
assets
```

## 4. Design Tokens

视觉分析结果优先转换为：

```text
color tokens
spacing tokens
font tokens
radius tokens
shadow tokens
container widths
breakpoints
z-index rules
```

避免每个页面出现大量随机 magic numbers。

## 5. Component Map

Frontend Agent 在实现前建立：

```text
UI Element → Existing Component / New Component
```

优先复用项目已有组件库。

## 6. Browser Runtime

使用受控 Browser Runtime / Playwright：

- 启动项目
- 打开目标 URL
- 设置 viewport
- 执行交互
- 截图
- 收集 console error
- 收集 network error
- 检查关键 DOM

Browser Tool 必须进入 Tool Runtime，不允许 Agent 直接控制宿主浏览器。

## 7. Visual Evaluation

视觉评估至少检查：

- layout
- position
- spacing
- size
- typography
- color
- border/radius
- shadow
- image/icon
- responsive behavior

评价链目标：

```text
Reference Screenshot
        ↓
Candidate Screenshot
        ↓
Visual Evaluation
        ↓
Issue List
        ↓
Fix Task
        ↓
Frontend Agent
        ↓
Re-evaluation
```

## 8. Acceptance

不能只使用“HTTP 200”或“页面能打开”作为视觉验收。

必须同时满足：

- functional checks
- console error checks
- screenshot comparison
- visual issue threshold
- responsive checks（适用时）

## 9. Security

Screenshot、Figma、URL 中的敏感信息不能自动写入日志或 Agent State。

Browser Runtime 仍必须遵守 Tool Runtime Policy、Sandbox 和 Secret Redaction。

---

切片末的官方视觉验收按 [docs/265](./265-visual-intent-gate.md) 的**设计意图门禁**执行：对照已挂 UI 基线，拦住整体跑偏、默认组件皮肤和缺基线静默跳过，而不是以像素差分或 2% 阈值作为通过条件。
