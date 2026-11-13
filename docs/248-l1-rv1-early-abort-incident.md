# 248 · l1-rv1 秒挂事故（空工作区 / TASK_EXECUTION_ERROR×3）

> 状态：**已定位并加固**（2026-11-04 上海时区）；**后续复验已产品中止**（同日 ~16:01：用户确认平台不做后端，E1/`backend-node` 复验不再重开，见 `docs/247`）。
> 关联：`docs/247`（任务书）、`docs/129`（mock 污染先例）、`docs/235`（能力 profile；同日默认已切 `frontend-vue`）。

> **事后注**：本记录的「须在正确进程环境上重开」已被产品裁定取消——不是技术未修好，而是夹具/能力面与产品方向冲突。修后守卫（计划期 `validatePlannableTaskTypes`、批脚本 profile/provider 断言）仍保留，防再混跑。

---

## 1. 现象

| 项 | 值 |
| --- | --- |
| 批次 | `l1-rv1`，日志 `packages/eval/results/l1-rv1/l1-rv1-20261104-135353.log` |
| 三跑 | staging 0/3；oracle Must 0/29；链未完成；每片约 4–9s |
| 失败码 | `TASK_EXECUTION_ERROR`×3（失败分层 = agent） |
| 工作区 | `/Users/shixianbao/Desktop/study/ai-se-eval/E1/run-1` 仅有 README/gitignore，无 `package.json` / Dockerfile |
| token | 输入/输出均为 0 |

## 2. 根因（两层，缺一不可）

1. **进程落在 `LLM_PROVIDER` 缺省 `mock`**：Phase 8-D 重启（PID 65510）只显式带了 `CAPABILITY_PROFILE=frontend-vue` / `VERIFICATION_GATE` / `INCIDENT_AUTO_REMEDIATE`，**未**把 `.env` 里的 `OPENAI_*` 与 `LLM_PROVIDER=openai` 带进进程（且根 `.env` 里 `LLM_PROVIDER=openai` 行本身是注释）。`/api/model-config` → `provider=mock`、`apiKeyConfigured=false` ⇒ 规划走 `ScriptedPlanningModel`，产出固定 **Todo** DAG（含 `DATABASE` / `BACKEND`），编码侧亦无脚本化 stub（`text-fallback`，~数十 ms），**周窗口 token 不增**。
2. **同一进程是 `frontend-vue`**：该 profile **禁用** `DATABASE`/`BACKEND` agent（`docs/235` §5.2）。SLICE-1 第一个实现任务 `Create Todo database migration` 在创建 agent_run 前即：
   `Agent DATABASE is not enabled by capability profile frontend-vue` → REPLAN/DEBUG 同错 → 工作流约 330ms 失败。E1 的 `fixtureTier` 本应是 `backend-node`，与 F1 的 `frontend-vue` 不可混跑。

空工作区与「无 package.json」是**后果**（agent 从未真正写码），不是脚手架拷贝失败——E1 `template/` 本就只有 README，代码应由 agent 生成。

## 3. 修复（本记录）

| 层 | 改动 |
| --- | --- |
| 计划期硬门 | 新增 `validatePlannableTaskTypes`：任务类型不在 `profile.taskTypes.plannable` → 计划期报错（不再拖到运行期秒挂） |
| 批脚本守卫 | `l1-rv1-e1-x3.sh` 对齐 F1：断言 `capabilityProfile=backend-node`，且 `provider≠mock` 且 `apiKeyConfigured=true`（exit 7 / 6） |
| 进程 | **不改 `.env`**。重开复验前须 `source .env` 后 **`export LLM_PROVIDER=openai`**，并 `CAPABILITY_PROFILE=backend-node`（E1），再启 `:47558` |

## 4. 重跑条件

- `/health.capabilityProfile === "backend-node"`
- `/api/model-config.provider === "openai"` 且 `apiKeyConfigured === true`
- OpenCode 路由保持（`.env` 未改写为 DeepSeek 直连）
- 旧 `l1-rv1/run-*.json` 须归档或换目录，避免与修后批次混读

## 5. 非目标

- 不把本批三跑算进 L1 复验 S1；不回退 `docs/17` 已勾 L1-8。
- 不在本记录里改 `.env` 正文（`LLM_PROVIDER` 注释问题留给运维/另开小修；启动脚本必须显式 export）。
