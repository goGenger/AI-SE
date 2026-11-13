# F1 AC 映射（谁判定 · 用哪些 testid · 哪个变体必须让它失败）

> 判据来源：`O` = oracle（`oracle.mjs`，真实浏览器）；`B` = 平台 UI 边界冒烟（`uiSmoke`）；
> `T` = 项目自测（`pnpm test`，只覆盖纯逻辑）。`docs/233` §3.3 的判定列与本文一致。

## 1. 逐条映射

| AC | 优先级 | 判定 | 依赖的 testid | `empty-shell` 上必须 | `no-console-clean` 上必须 |
| --- | --- | --- | --- | --- | --- |
| AC-01 | Must | O/B | `app-title` | 失败 | 通过 |
| AC-02 | Must | O | `loading-indicator`、`task-item` | 失败 | 通过 |
| AC-03 | Must | O/B | `task-item` | 失败 | 通过 |
| AC-04 | Must | O | `task-item`、`task-title` | 失败 | 通过 |
| AC-05 | Must | O | `empty-state`、`task-item` | 失败 | 通过 |
| AC-06 | Must | O/B | `new-task-button`、`new-task-dialog` | 失败 | 通过 |
| AC-07 | Must | O | `task-title-input`、`save-task-button`、`form-error` | 失败 | 通过 |
| AC-08 | Must | O | `new-task-dialog`、`task-item`、`task-count` | 失败 | 通过 |
| AC-09 | Must | O | `error-banner`、`new-task-dialog` | 失败 | 通过 |
| AC-10 | Must | O | `save-task-button` | 失败 | 通过 |
| AC-11 | Must | O | `search-input`、`task-item` | 失败 | 通过 |
| AC-12 | Must | O | `no-results`、`empty-state` | 失败 | 通过 |
| AC-13 | Must | O | `filter-done`、`task-item` | 失败 | 通过 |
| AC-14 | Must | O | `filter-all`、`task-item` | 失败 | 通过 |
| AC-15 | Must | O | `search-input`、`filter-done`、`task-item` | 失败 | 通过 |
| AC-16 | Must | O | `task-done-toggle`、`task-item[data-done]` | 失败 | 通过 |
| AC-17 | Must | O | `task-item[data-done]` | 失败 | 通过 |
| AC-18 | Must | O | `task-delete-button`、`task-count` | 失败 | 通过 |
| AC-19 | Must | O | `error-banner`、`retry-button`、`task-item` | 失败 | 通过 |
| AC-20 | Must | O | —（汇总所有 journey 的 console） | **通过**（没有脚本，就不会报错） | **失败** |
| AC-21 | Should | O | `task-item` | 失败 | 通过 |
| AC-22 | Should | O | —（`scrollWidth`） | 失败 | 通过 |
| AC-23 | Should | O | `search-input`、`new-task-button`、`task-done-toggle` | 失败 | 通过 |
| AC-24 | Should | O | `task-item`（计算样式） | 失败 | 通过 |

`empty-shell` 的 AC-20「必须通过」不是笔误：它什么都渲染、也就什么都不报错——**这正是那一道门
单独存在的原因**，另外 23 条把它挡住了，AC-20 挡不住。

## 2. 切片与 AC 的对应（`docs/233` §3.4）

| 切片 | AC | `involvesUi` |
| --- | --- | --- |
| `f1-skeleton-list` | AC-01..05 | true |
| `f1-create-task` | AC-06..10 | true |
| `f1-search-filter` | AC-11..15 | true |
| `f1-toggle-delete-resilience` | AC-16..20 | true |

切片由平台自己规划（PRD 不指定切片），这张表是**读数归因**用的：某一片的边界门报
`SURFACE_MISSING` 时，应当只有该片点名的 testid 出现在证据里。

## 3. 判定方的能力边界（读之前先看）

| 门 | 看得见 | 看不见 |
| --- | --- | --- |
| oracle（`O`） | 浏览器里的真实行为、四态、交互、控制台 | 代码结构、可维护性、性能上限 |
| uiSmoke（`B`） | 页面起没起来、点名的元素在不在渲染后的 DOM 上 | 业务正确性、时序、多点交互 |
| 项目自测（`T`） | 纯逻辑（搜索/筛选组合、标题校验） | 一切 DOM 行为 |

`B` 的判定是「AC 点名的 testid **至少有一个**存在」（`docs/233` §5.2），它在切片边界跑、成本低、
**故意不判业务**。把它当业务门来读，会得到「通过了但什么都没验」的错误安全感。
