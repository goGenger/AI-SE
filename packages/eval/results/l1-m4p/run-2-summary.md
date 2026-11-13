# P0 评测结果（2026-10-21T06:12:06.765Z）

- 平台：http://127.0.0.1:47558
- 运行数：1
- 真成功率：0.0% 自报成功率：0.0% **假阳性率：0.0%**
- 解析降级率：0.0% 人工介入：0
- token：输入 31685097 / 输出 374545 估算成本：$0.0000
- **链完成率：0.0% 真交付成功率：0.0% 假阴性数：0** 超范围写入：0
- **staging 段交付率：0.0%**（CI ∧ staging DEPLOY ∧ staging VERIFY 三段均成功）
- 任务级验证分歧：1 验证门失败码：（无）
- 检查不可判定：1（DATABASE×1）
- 失败分层：规划 0 / 验证门 1 / agent 8
- 规划修复：自动 0 轮 / LLM 0 轮 / 切片校验失败 0 轮；首轮通过率 100.0% 收敛率 100.0%
- 切片到达分布：task-core×1

## 分档

| 档 | 运行数 | 真成功率 | 假阳性率 |
| --- | --- | --- | --- |
| S | 0 | 0.0% | 0.0% |
| M | 0 | 0.0% | 0.0% |
| L | 0 | 0.0% | 0.0% |
| E1 | 1 | 0.0% | 0.0% |

## 失败原因分布

- LLM_ERROR: 4
- VERIFICATION_FAILED: 1
- REPLAN_REQUESTED: 3
- EMPTY_FINAL_ANSWER: 1

## 噪声线（本次 - 上次）

- trueSuccessRate: 0
- reportedSuccessRate: 0
- falsePositiveRate: 0
- parseRecoveryRate: 0
- humanInterventions: -1
- estimatedCostUsd: 0

## 逐次运行

| 夹具 | 档 | # | 工作流 | 任务状态 | 自报 | oracle | 假阳性 | 链完成 | 交付 | staging 段 | 降级 | 介入 | 耗时(ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | E1 | 1 | 54446733-6fd0-478c-af00-cc035ee57273 | SUCCESS×22 FAILED×9 PENDING×9 READY×1 | 失败 | 不通过 | 否 | 否 | 否 | 否（-/-/-） | 0 | 0 | 4373197 |

