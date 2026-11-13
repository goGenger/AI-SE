# F 期 L3 出口回归评测汇总（S/M/L x3）

- 生成：2026-10-12 ｜ 口径版本：**29 Must + 1 Should（唯一 Should = AC-22）**（见 `caliber-check.md`）
- 批次契约：24 runs = S1..L2 x3；每档 run1 `--replan`；F 期受控实例（`PLANNING_MODE=two-level` / `VERIFICATION_GATE=enforce` / `SUBMIT_RESULT_MODE=tool`）；逐 run checkpoint；20M 周护栏。
- 执行史：2026-10-09 首批（11 runs，按令停机封账于上一窗口 18.50M）→ 2026-10-12 断点续跑（13 runs，09:11-14:45，5h33m；本窗口耗 8.63M / 20M）。
- F 期运行环境含修复：上游网关 reasoning_content 回传补丁（`patches/@langchain__openai@1.5.11.patch`）+ AgentRegistry 工具面修复（`src`/`test` 路径覆盖）。

## 1. 总分（L3 vs E-2b）

| 指标 | L3（F 期） | E-2b（基线） |
| --- | --- | --- |
| oracle 通过 | **15/24 (62.5%)** | 8/23 (34.8%) |
| 自报成功 | 2/24 | 0/23 |
| 链完成（F1-8 真实字段） | 2/24 | 0（仅代理口径；见 `f18-recompute.md`） |
| 交付成功 deliveredSuccess | **2/24**（L1-run2 / L1-run3） | 0（代理口径；B 批 14/45 为历史唯一非零） |
| 假阴性 falseNegative | 13/24 | 8（E-2b 明细见 f18-recompute） |
| 超范围写入 scopeViolation | 1（L2-run3） | 事件面未上线（无数据） |

Fisher 精确检验（双侧）：p = 0.0820（样本量小，方向性证据：+27.7pp）。

## 2. 分档对照

| 档位 | L3 oracle | 自报 | 链完成 | 交付 | 假阴性 | E-2b oracle |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | **1/3** | 0/3 | 0/3 | 0/3 | 1 | 3/3 |
| S2 | **1/3** | 0/3 | 0/3 | 0/3 | 1 | 3/3 |
| S3 | **3/3** | 0/3 | 0/3 | 0/3 | 3 | 0/3 |
| M1 | **3/3** | 0/3 | 0/3 | 0/3 | 3 | 0/3 |
| M2 | **0/3** | 0/3 | 0/3 | 0/3 | 0 | 0/3 |
| M3 | **3/3** | 0/3 | 0/3 | 0/3 | 3 | 1/2 |
| L1 | **2/3** | 2/3 | 2/3 | 2/3 | 0 | 1/3 |
| L2 | **2/3** | 0/3 | 0/3 | 0/3 | 2 | 0/3 |

## 3. 全 run 明细（24 runs）

| run | oracle | 自报 | 链 | 交付 | 假阴 | 超范围 | sliceReached | 时长 | tokens(in) | errorTypes | verificationFailureCodes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1-run1 | Y | N | N | N | Y | N | slice-3 | 23min | 478203 | VFx1 | VACx2 |
| S1-run2 | N | N | N | N | N | N | slice-3 | 6min | 81856 | EFAx1 | - |
| S1-run3 | N | N | N | N | N | N | slice-3 | 5min | 74176 | - | - |
| S2-run1 | Y | N | N | N | Y | N | slice-2-unit-parsing | 18min | 337237 | - | - |
| S2-run2 | N | N | N | N | N | N | slice-2-unit-parsing | 1min | 46881 | VFx1 | - |
| S2-run3 | N | N | N | N | N | N | slice-2-unit-parsing | 2min | 70302 | VFx1 | - |
| S3-run1 | Y | N | N | N | Y | N | slice-2 | 11min | 167042 | - | - |
| S3-run2 | Y | N | N | N | Y | N | slice-2 | 12min | 159115 | - | - |
| S3-run3 | Y | N | N | N | Y | N | slice-2 | 18min | 113691 | TOx2 | - |
| M1-run1 | Y | N | N | N | Y | N | patch-delete-endpoints | 29min | 837080 | VFx1 | VACx2 |
| M1-run2 | Y | N | N | N | Y | N | get-filtering | 33min | 827809 | - | - |
| M1-run3 | Y | N | N | N | Y | N | get-filtering | 23min | 723618 | VFx1 | VACx2 |
| M2-run1 | N | N | N | N | N | N | slice-2 | 28min | 808793 | - | - |
| M2-run2 | N | N | N | N | N | N | slice-2 | 16min | 381012 | VFx2 | VACx4 |
| M2-run3 | N | N | N | N | N | N | slice-2 | 8min | 225677 | VFx1 | - |
| M3-run1 | Y | N | N | N | Y | N | merge-fallback-immutability | 16min | 443275 | - | - |
| M3-run2 | Y | N | N | N | Y | N | merge-fallback-immutability | 20min | 498365 | VFx1 | VACx2 |
| M3-run3 | Y | N | N | N | Y | N | merge-fallback-immutability | 18min | 378632 | VFx1 | VACx2 |
| L1-run1 | N | N | N | N | N | N | render-page | 9min | 242370 | VFx1 | - |
| L1-run2 | Y | Y | Y | Y | N | N | build-site | 38min | 1095854 | TOx1 | - |
| L1-run3 | Y | Y | Y | Y | N | N | build-site | 24min | 1311732 | - | - |
| L2-run1 | Y | N | N | N | Y | N | slice-2 | 42min | 1303195 | VFx1 | VACx2 |
| L2-run2 | N | N | N | N | N | N | slice-2 | 18min | 298602 | VFx1 | VACx2 |
| L2-run3 | Y | N | N | N | Y | Y | slice-3 | 27min | 538090 | VFx1 | VACx2 |

合计：时长 446 分钟 ｜ tokens(in) 合计 11,442,607（其中续跑 13 run 段 = 8.24M，与护栏读数逐点一致）

## 4. 失败面与重点记录

- **主失败机制 = 任务级判负（VERIFICATION_FAILED x14），其中 VACUOUS_TEST 标记合计 20 处**：F 期验证加固（空泛测试检出）在真实评测中的首个规模化检出面；大量「oracle 通过但链未完成」（假阴性 13/24）由此产生——任务判负令链停在后段。
- **S1/S2 滑落（观察项）**：两档均从 E-2b 的 3/3 降至 1/3。机制：slice-1 AC-10 `pnpm test` 未绿即被 gate 判负（S1r2/r3），S2r2/r3 为交付骨架未达验证判定。S 总 5/9 vs E-2b 6/9（n=3 噪声区间内），与 S3（0/3->3/3）形成分布互换；登记观察，转 L4/E1 复核。
- **M2 双期同挂 0/3**（两期完全一致）：renderTable 属稳定难例，非 F 期退步。
- **L2-run2**：PUT 断言 404 挂（`PUT 应返回 200`）。
- **超范围写入首例（L2-run3）**：`SCOPE_VIOLATION` x2（observe 模式未阻断；T03 TEST 任务写 `src/app.mjs`、T-06 BACKEND 任务写 `test/app.startup.test.mjs`）；run 仍 oracle 通过。
- **首个交付成功（L1-run2 / L1-run3）**：自报=Y、链=Y、oracle=Y —— F1-8 口径下首批 deliveredSuccess=TRUE 的 run（无 VACUOUS 标记，全程 gate 绿）。
- **L2-run3 sliceReached=slice-3**：全批次最深的交付进度之一（也是超范围事件所在 run）；链因后段验证判负未完成。

## 5. F 期新增能力在 L3 的执行性验证

| 能力（FX） | L3 观测 | 判定 |
| --- | --- | --- |
| F1-8 口径字段（链完成/交付/假阴性/超范围） | 全 24 run 采集成功 | 生效 |
| VACUOUS_TEST 检出（F1 期加固） | 20 处（9 个 run） | **生效且规模化** |
| scopeViolation（F2-1 observe） | 首个真实标注（L2r3） | 生效（observe 未阻断） |
| 工具面修复（L3 事故 3 修复） | 全部实现类任务文件工具可用（写入成功率恢复） | 生效 |
| 交付守卫（F1-3/F1-4） | 无「交付任务出现在非最终切片」类违规 | 生效 |

## 6. 已知限制与观察项（登记）

1. **S1 planningMetrics 污染**：S1 三 run 同值 `llmRepairRounds=1141 / VALIDATION_ERROR=1710`（该需求历经 4 次批次 + mock 事故的历史事件累计）；干净档位（M/L）为 `firstPass=true / converged=true / llmRepairRounds=0`，非本轮新增。规划指标口径需按「每批次基线重置」复核。
2. **scopeViolation 记录面 vs 事件面小差异**：M1 档 10-09 存在 1 条 `SCOPE_VIOLATION`（工作流 6901ffa5，未收录于 M1-run2 记录的 workflowIds）；L2-run3 的 slice-3 工作流 9ffd86b8 同样在记录集外但其事件已计入。低严重度，采集面口径待完善。
3. **S1/S2 分档滑落**（见 §4），n=3 无法定论，转 L4。
4. **链完成率整体仍低**（2/24）：gate=enforce 收紧口径下的真实状态；假阴性 13/24 为主线，改善空间在后段任务（测试类交付）的验证一次性通过率。

## 7. 结论

- **FX-34「评测回归集成功率不下降」：成立**（总 15/24 vs 8/23，+27.7pp，Fisher p=0.082）。
- **L3 出口回归：PASS（含 4 项登记观察）**；首个 deliveredSuccess=TRUE 出现，F 期修复目标口径闭环。
- 未开始事项（STOP）：L4（E1 x3 出口批次）未跑；下一配额窗口或按用户放行执行。
