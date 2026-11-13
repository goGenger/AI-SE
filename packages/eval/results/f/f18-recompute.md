# F1-8（FX-27）历史批次离线重算（新口径 = FX-26 冻结）

生成时间：2026-10-08T11:27:59.375Z｜口径版本：29 Must + 1 Should（唯一 Should = AC-22）

> 代理说明：工件无切片状态面——`链完成` 以「全部任务 SUCCESS」为代理；`已执行片数` = workflowIds 数；超范围写入（F2-1 前）无事件面。

| 批次 | 运行数 | oracle 通过 | 链完成（代理） | 真交付成功 | 假阴性 | 已执行片数分布 |
| --- | --- | --- | --- | --- | --- | --- |
| B | 45 | 25/45 | 16/45 | 14/45 | 11 | 1 片×26 2 片×8 3 片×5 4 片×4 5 片×2 |
| C-6 | 3 | 0/3 | 0/3 | 0/3 | 0 | 1 片×3 |
| E-1 | 3 | 1/3 | 0/3 | 0/3 | 1 | 1 片×3 |
| E-2 | 24 | 6/24 | 0/24 | 0/24 | 6 | 1 片×24 |
| E-2b | 23 | 8/23 | 0/23 | 0/23 | 8 | 1 片×23 |

## 假阴性明细（oracle 过但链未完成）

- B / S1 #1
- B / S2 #1
- B / L2 #2
- B / L2 #3
- B / M3 #2
- B / L2 #1
- B / L2 #2
- B / L2 #3
- B / M1 #1
- B / M1 #2
- B / M1 #3
- E-1 / E1 #1
- E-2 / M3 #1
- E-2 / M3 #1
- E-2 / M3 #1
- E-2 / S2 #1
- E-2 / S2 #1
- E-2 / S2 #1
- E-2b / L1 #1
- E-2b / M3 #1
- E-2b / S1 #1
- E-2b / S1 #1
- E-2b / S1 #1
- E-2b / S2 #1
- E-2b / S2 #1
- E-2b / S2 #1

## 错误码分布（各批次合计）

- B：TIMEOUT×26
- C-6：VERIFICATION_FAILED×1 TIMEOUT×5
- E-1：EMPTY_FINAL_ANSWER×2 TIMEOUT×6 VERIFICATION_FAILED×1
- E-2：VERIFICATION_FAILED×23 INVALID_AGENT_RESULT×2
- E-2b：VERIFICATION_FAILED×25 INVALID_AGENT_RESULT×2 EMPTY_FINAL_ANSWER×3

## E-1 口径标注（任务书点名）

- E-1：真成功（oracle）**1/3**；链完成（代理）**0/3** —「真成功 1/3」同时标注「链完成 0/3」✓

## 未完成失败（既有记录，不重算）

- B：S2（planning）：规划失败：92df0d15-bcec-4131-b1a6-abf2a7d56f74
- B：L1（run）：切片 build-module 未被链式编排启动
- B：L1（run）：切片 build-module 未被链式编排启动
- B：L2（run）：切片 quality-gates 失败
- B：M1（run）：切片 slice-patch-todo 未被链式编排启动
- B：M1（run）：切片 slice-patch-todo 未被链式编排启动
- B：M2（run）：切片 slice-2 未被链式编排启动
- B：M2（run）：切片 slice-2 未被链式编排启动
- B：L2（run）：fetch failed
- B：L2（run）：fetch failed
- B：M2（run）：fetch failed
- B：E1（planning）：规划失败：a30f30cc-64f5-4b31-9bbb-9b3d5bbaba53
- E-2b：M3（planning）：规划失败：0194bf8d-7602-4c06-80c7-18324fc33e66
