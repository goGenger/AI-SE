# P0 评测结果（2026-10-19T18:34:02.537Z）

- 平台：http://127.0.0.1:47558
- 运行数：1
- 真成功率：0.0% 自报成功率：0.0% **假阳性率：0.0%**
- 解析降级率：0.0% 人工介入：0
- token：输入 77874028 / 输出 1005246 估算成本：$0.0000
- **链完成率：0.0% 真交付成功率：0.0% 假阴性数：0** 超范围写入：0
- **staging 段交付率：100.0%**（CI ∧ staging DEPLOY ∧ staging VERIFY 三段均成功）
- 任务级验证分歧：2 验证门失败码：（无）
- 检查不可判定：1（DATABASE×1）
- 失败分层：规划 0 / 验证门 2 / agent 6
- 规划修复：自动 0 轮 / LLM 1 轮 / 切片校验失败 0 轮；首轮通过率 0.0% 收敛率 100.0%
- 切片到达分布：slice-4-runtime-ui×1

## 分档

| 档 | 运行数 | 真成功率 | 假阳性率 |
| --- | --- | --- | --- |
| S | 0 | 0.0% | 0.0% |
| M | 0 | 0.0% | 0.0% |
| L | 0 | 0.0% | 0.0% |
| E1 | 1 | 0.0% | 0.0% |

## 失败原因分布

- TIMEOUT: 6
- VERIFICATION_FAILED: 2

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
| E1 | E1 | 1 | 4860c374-b0bb-4fbf-9691-cdfe1ccb1974 | SUCCESS×63 FAILED×7 WAITING_APPROVAL×1 | 失败 | 不通过 | 否 | 否 | 否 | 是（SUCCESS/SUCCESS/SUCCESS） | 0 | 0 | 11220002 |

