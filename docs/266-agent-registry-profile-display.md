# 266 · 注册表展示跟随当前能力面

> 状态：**已落地**（2026-11-11 Asia/Shanghai）。本轮只改注册表展示 / `GET /agents`，未删 backend-agent / database-agent 的定义或实现，未改指标口径、派发或 `.env`。

相关前文：[docs/235](./235-capability-profile-design.md) §5.2。

## 变更

默认能力面是 `frontend-vue`，启用的 agent 只有 PLANNER、FRONTEND、QA、REVIEWER、DEVOPS。此前 `GET /agents` 把目录里全部 7 个定义都标成「可用」，包括已停用的 backend-agent 与 database-agent。

现在注册表页面使用的列表接口改为 `AgentRegistry.listEnabled()`，过滤条件与派发相同（`capabilityProfile.agents`）：

- `frontend-vue` 下返回 `planner-agent`、`frontend-agent`、`qa-agent`、`reviewer-agent`、`devops-agent`。
- 若切换到启用 BACKEND / DATABASE 的 profile（如 `backend-node`），这两项会自动重新出现。
- `list()` / `get()` 仍是全量目录；`resolveTask` 对未启用类型继续 fail-closed。

实现与提示词都保留，不从代码里删除。
