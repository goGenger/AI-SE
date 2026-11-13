# P0 评测结果（2026-10-20T16:30:09.554Z）

- 平台：http://127.0.0.1:47558
- 运行数：1
- 真成功率：100.0% 自报成功率：0.0% **假阳性率：0.0%**
- 解析降级率：0.0% 人工介入：0
- token：输入 71374431 / 输出 853834 估算成本：$0.0000
- **链完成率：0.0% 真交付成功率：0.0% 假阴性数：1** 超范围写入：0
- **staging 段交付率：0.0%**（CI ∧ staging DEPLOY ∧ staging VERIFY 三段均成功）
- 任务级验证分歧：1 验证门失败码：（无）
- 检查不可判定：1（DATABASE×1）
- 失败分层：规划 0 / 验证门 1 / agent 0
- 规划修复：自动 0 轮 / LLM 0 轮 / 切片校验失败 0 轮；首轮通过率 100.0% 收敛率 100.0%
- 切片到达分布：slice-4-runtime-deployment-docs×1

## 分档

| 档 | 运行数 | 真成功率 | 假阳性率 |
| --- | --- | --- | --- |
| S | 0 | 0.0% | 0.0% |
| M | 0 | 0.0% | 0.0% |
| L | 0 | 0.0% | 0.0% |
| E1 | 1 | 100.0% | 0.0% |

## 失败原因分布

- VERIFICATION_FAILED: 1

## 噪声线（本次 - 上次）

- trueSuccessRate: 1
- reportedSuccessRate: 0
- falsePositiveRate: 0
- parseRecoveryRate: 0
- humanInterventions: -1
- estimatedCostUsd: 0

## 逐次运行

| 夹具 | 档 | # | 工作流 | 任务状态 | 自报 | oracle | 假阳性 | 链完成 | 交付 | staging 段 | 降级 | 介入 | 耗时(ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | E1 | 1 | 8b4f3640-a3df-430b-91ac-6cffc18cc8d1 | SUCCESS×46 FAILED×5 WAITING_APPROVAL×1 | 失败 | 通过 | 否 | 否 | 否 | 否（FAILED/FAILED/FAILED） | 0 | 0 | 6191154 |

