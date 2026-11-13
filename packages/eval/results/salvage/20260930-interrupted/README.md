# B-4 第一批中断留证（2026-09-30）

- **批次**：B-4 第一批（S1,S2,S3,M1,M2,M3,L1,L2 ×3，两遍背靠背中的第一遍）
- **进程**：proc_6e731bf6662d；启动 08:33:50，终止 **09:21:16**（SIGTERM，`exit_code=-15`，`termination_source="agent_close"`——Hermes 生命周期清理；**根因：启动命令未加 `persist_on_release=true`**，长任务在该模式下会被例行生命周期事件回收）
- **已完成观察（中断批次，不计入正式样本）**：
  - **L1**：3/3 runs 真实失败（~9–11min/run；6/8 任务，oracle 同步不通过，无假阳性）
  - **L2**：run1 切片链 78min——`persistence-core` / `app-persistence-integration` / `new-api-endpoints` SUCCESS，末片 `quality-gates` FAILED（2/8）→ 链终止
- **内容**：
  - `L1-workspaces/run-1..3`、`L2-workspaces/run-1`：中断时的工作区快照
  - `batch.log`：批次原始日志（/tmp/b4-pass12.log 副本）
  - `workflows-snapshot.json`：全部 [eval] 工作流快照（API 导出）
  - `l2-slices.json`：L2 切片链状态（API 导出）
- **DB 补充证据**：工作流/任务/agent_runs 明细仍在开发库（[eval] 前缀），可用 API/SQL 查询（tokens、耗时、errorType 等）。
- **处置**：重启后重跑；本目录仅留证，不参与统计。
