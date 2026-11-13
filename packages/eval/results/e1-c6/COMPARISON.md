# C-6 · E1 ×3 对比数据（2026-10-07）

> 完整叙述见 `docs/117-phase-c-record.md` §C-6。本文件为紧凑对照表（机读/归档用）。

## 批次元数据
- 平台：受控实例 47557（全部 C 代码 + `VERIFICATION_GATE=enforce`、`SUBMIT_RESULT_MODE=tool`、`PLANNING_MODE=two-level`）
- 计划：重规划 v6（level-1）→ slice-1 v7；AC 一等记录 30 条；slices 2–5 未推进
- 窗口：2026-10-07 07:47:32 → 11:18:13 CST（3h31m；无睡眠事件）
- 周配额（记录值）：5,809,657 → 7,625,327 输入 token（护栏 20M 未触发）

## 对照表

| 项 | B 基线 ×3 | run-1 | run-2 | run-3 |
| --- | --- | --- | --- | --- |
| workflow | （基线三项） | 6c841bd2 | 830cef53 | bd0a66a1 |
| oracle 真通过 | 1/3 (33.3%) | ✗ Must 5/29 | ✗ Must 7/29 | ✗ Must 28/29 (AC-30 失败) |
| 自报 | 0/3 | 失败 | 失败 | 失败 |
| 假阳性 | 0/3 | 0 | 0 | 0 |
| 降级率 | ~79% | 0% | 0% | 0% |
| 人工介入 | 0 | 0 | 0 | 0 |
| tokens in/out | 5.63M/0.19M | 848,588/40,684 | 894,595/50,592 | 72,487/9,650 |
| 时长 | 4h06m+1h42m+1h11m | 57m08s | 69m23s | 24m09s |
| 任务 | — | 13✓/1✗(T-13 红灯误杀) | 13✓/1✗(T-13 QA 自判失败) | 3✓/1✗(T-08 超时×2) |
| 验证门 | — | verified×8; T-13 failed(red-light) | verified×8; T-13 自报失败 | T-08 无验证块 |
| 幽灵泄漏 | — | T-10 +4min | T-14 +2min | T-08#1 +23min(捕获仍活)/#2 +10min |

## 发现（对照 docs/117 §C-6 编号）
1. 红灯检查误杀回归型 TEST（run-1 T-13：套件合法全绿 8/8 AC 被覆盖 FAILED → 链停）
2. 超时 ≠ 终止：4 个 timed_out run 死后仍持续工具调用/写工作区（证据 `evidence/ghosts.txt`）
3. timed_out run token=0（成本为下界）
4. QA 自我诚实失败正向样本（run-2 T-13：自判假绿并给修复建议）
5. E1 沙箱无 pnpm/网络（L1#1 复现；5 步链第 1 步不可执行）
6. run-3 的 28/29 为幽灵进行时快照，不得作为链路可达证据

## 产物
- `run-{1,2,3}.json` / `run-{1,2,3}-summary.md`（harness 原始输出）
- `evidence/preflight.txt`（开跑前 + 重规划后快照）
- `evidence/ghosts.txt`（超时泄漏证据）
