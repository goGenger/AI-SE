# F 期 L4 出口验收汇总（E1 ×3 · 测量轮）

- 生成：2026-10-14 ｜ 口径：**29 Must + 1 Should（唯一 Should = AC-22）**
- 受控实例：`PLANNING_MODE=two-level` / `VERIFICATION_GATE=enforce` / `SUBMIT_RESULT_MODE=tool`；F 期代码 + 观察项小修（指标窗口化、sv 采集面补全）+ 新 API key（23:17 更新）
- 批次契约：E1×3；run1 `--replan`；20M 周护栏（本批次 +3.78M → 窗口 12.83M/20M）；**零 429**
- 执行史：17:44 首启（事故4：会话清理击杀）→ 18:25 重跑（事故5：提供方月度限额 → run1/2 作废，归档 `attempt1-provider429/`）→ **23:19:46 恢复重跑（本报告数据）→ 03:26:58 完成**（3h07m）

## 1. 总分（L4 vs E-1 基线）

| 指标 | L4（F 期） | E-1（基线） |
| --- | --- | --- |
| oracle 通过 | 0/3（**2/29、21/29、24/29**） | 1/3 |
| 链完成 chainCompleted | 0/3 | 0/3（代理口径） |
| 交付成功 deliveredSuccess | 0/3 | 0/3（代理口径） |
| 假阴性 falseNegative | 0/3 | — |
| 超范围写入 scopeViolation | 2/3（r2、r3） | 事件面未上线 |

> 假阴性 0 的语义：oracle 未通过（链深未达交付段），不构成「通过却未交付」；真交付仍为 0/3。

## 2. 链深度（本批次头条：首次越过 slice-2）

| run | sliceReached | oracle | 链停位置与原因 |
| --- | --- | --- | --- |
| 1 | slice-1-foundations | 2/29 | slice-1「pnpm 工程骨架与脚本契约」任务 **TIMEOUT×3**（600s） |
| 2 | **slice-3-create-list-search** | 21/29 | slice-3「运行切片集成验证与回归测试」任务判负（**VACUOUS_TEST×2**） |
| 3 | **slice-4-task-lifecycle-isolation** | 24/29 | slice-2 重跑（认证测试判负 VACUOUS_TEST）与平台并行链 slice-4（PATCH 测试判负）双双失败 |

切片链（计划 v31）：slice-1-foundations → slice-2-auth → slice-3-create-list-search → slice-4-task-lifecycle-isolation → slice-5-runtime-deploy。
**run2 越过 slice-2 达 slice-3；run3 达 slice-4（最远 4/5）**——E-1 基线止步于 slice-1/2。

## 3. 测量轮判读（docs/128 §8 两问）

1. **链是否首次越过 slice-2**：**✓ 是**（run2 → slice-3、run3 → slice-4）。
2. **失败是否从规划/门层迁移到 agent 级**：**✓ 是**。规划层失败 **0/3**（planningMetrics：首轮通过 2/3、收敛 3/3、LLM 修复 ≤1 轮）；失败现集中于 **agent 层**（TIMEOUT×3，run1）与**验证层**（VACUOUS_TEST 标记 ×4 → 3 处 TEST 任务判负）。

## 4. 全 run 明细（F1-8 全字段）

| run | oracle | 自报 | 链 | 交付 | 假阴 | sv | sliceReached | errorTypes | vfc | failureLayers | planningMetrics | 任务 | 时长 | tokens(in) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | N | N | N | N | N | N | slice-1-foundations | {"TIMEOUT": 3} | {} | {"planning": 0, "verification": 0, "agent": 3} | auto3/llm1/firstPass=False | {"SUCCESS": 1, "FAILED": 1, "PENDING": 8} | 22min | 11,774 |
| 2 | N | N | N | N | N | Y | slice-3-create-list-search | {"VERIFICATION_FAILED": 1, "TIMEOUT": 1} | {"VACUOUS_TEST": 2} | {"planning": 0, "verification": 1, "agent": 1} | auto0/llm0/firstPass=True | {"SUCCESS": 36, "FAILED": 1, "PENDING": 1} | 108min | 2,582,551 |
| 3 | N | N | N | N | N | Y | slice-4-task-lifecycle-isolation | {"VERIFICATION_FAILED": 2} | {"VACUOUS_TEST": 2} | {"planning": 0, "verification": 2, "agent": 0} | auto0/llm0/firstPass=True | {"SUCCESS": 12, "READY": 2, "FAILED": 1, "PENDING": 10} | 45min | 759,859 |

失败分层合计：**规划 0 / 验证 3 / agent 4**。任务级验证分歧：0 / 1 / 2。

## 5. 失败面与观察（归因）

- **VACUOUS_TEST 仍是链停主因**（与 L3 一致）：3 处 TEST 任务判负——run2 slice-3 集成验证、run3 slice-2 认证测试、run3 slice-4 PATCH 测试。下一步首要改进项：判定精化（真阳/假阳分离，含 TEST 任务的成功路径）。
- **run1 TIMEOUT×3**（600s 超时，slice-1 工程骨架任务）：同计划同切片在 run2 成功（36 任务 SUCCESS）→ 非计划缺陷；属 agent 长任务超时策略观察项。
- **超范围写入（采集面修复后首采，observe 未阻断）**：3 事件——r2 `T-03 BACKEND → README.md`；r3 `T-02 BACKEND → scripts/`、`T-03 BACKEND → README.md`。均工程文档类越界（BACKEND 白名单外），无危害、如实记录。
- **平台链推进在重跑场景的乱序行为**（登记观察）：run3 中 slice-1 成功后，平台 `advanceSliceChain` 取「首个 PENDING 切片」= slice-4（跳过 FAILED 的 slice-3）→ 重规划 v34 → 03:02:54 启动 slice-4；同时 harness 按 B-4 语义重启 DONE 的 slice-2 → **双链并行**。正常路径无影响；重跑/恢复路径语义待明确（阶段 G 候选：前序完整性校验）。

## 6. 结论（docs/128 §8 出口判定）

- 硬指标全过（FX-01..37、R1–R6、全仓测试、L2 演练、L4 报告含全部要求字段）。
- **deliveredSuccess = 0/3 < 2/3 → F-M1 = PASS-PARTIAL**（按裁决④：测量轮归因输出，不下调 PASS 线）。
- **归因**：链停全部发生在「后段切片 TEST 任务判负」（2/3 次）与「agent 超时」（1/3 次）；规划/门层失败清零、链深达 slice-4、oracle 最高 24/29（仅缺部署段 AC）——F 期目标（规划修复 + 失败层迁移）达成，剩余瓶颈 = 测试质量/验证判定精化。
- **F-M2 出口核对**：FX-29..37 完成 ✓；写范围审计 observe 数据与决策记录 ✓；**L3 回归成功率 62.5% ≥ T0 噪声线 58.3%** ✓ → 满足。
- **下一步（阶段 G 候选）**：① VACUOUS_TEST 判定精化；② 长任务超时策略（600s vs 任务规模）；③ 链推进前序完整性/乱序语义；④ 遗留观察（M2 难例、S1/S2 复核收口）。
