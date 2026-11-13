# 217 · L1-M4t 批次记录（E1×3，第二十一次 L1-8 尝试）

> 批次：`l1-m4t` ｜ 结果目录 `packages/eval/results/l1-m4t/`
> 起止：**2026-10-22 09:44 → 19:13 CST**（9h29m 墙钟）
> 判定：**L1-8 未达成**（staging 段 **0/3**，判据 ≥ 2/3）。**但三个 run 全部走完全链并真交付**——这是本批最大的正向变化。

---

## 1. 逐 run 数据（全部对库核实）

| 指标 | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| 起止（CST） | 09:44–11:58 | 12:28–15:17 | 15:47–19:12 |
| 耗时 | 7,532,615 ms（2h06m） | 10,156,695 ms（2h49m） | 12,290,054 ms（3h25m） |
| 真成功率 | **100%** | **100%** | **100%** |
| 假阳性率 | **0%** | **0%** | **0%** |
| 链完成率 | **100%** | **100%** | **100%** |
| 真交付成功率 | **100%**（oracle Must 29/29） | **100%** | **100%** |
| **staging 段** | **0%**（ci=SUCCESS deploy=SUCCESS **verify=-**） | **0%** | **0%** |
| 人工介入 | 2 | 1 | 1 |
| token（输入/输出） | 50,392,054 / 642,480 | 46,816,819 / 623,071 | 46,013,200 / 660,919 |
| 任务 SUCCESS/FAILED | 46 / 1 | 47 / 2 | 51 / 6 |
| 任务级验证分歧 | 1 | 7（`CHECK_TIMEOUT`×6） | 4（无失败码） |
| 检查不可判定 | 1（DATABASE×1） | 1（DATABASE×1） | 1（DATABASE×1） |

**批次合计**：输入 **143.22M** / 输出 **1.93M** token。

---

## 2. 本批最重要的正向信号：三个 run 全部走完全链

此前 20 次 E1 run 的最好成绩是「部分 run 到达最终切片」，链完成率长期 0/3。**本批 3/3 到达切片 3、
3/3 完成交付链、3/3 oracle 29/29 通过、假阳性 0。** 平台首次在整批尺度上稳定跑完「规划 → 三切片 →
CI → staging 部署 → production 部署（人工审批）」的全链路。

推进它的两个修复（均在本批之前落地）：

| 缺陷 | 修复 | 本批证据 |
| --- | --- | --- |
| **N-30 / PL-M31** | 「每个 Must AC 必须被实现类任务覆盖」写进规划提示词 | 三个 run 的最终切片计划**首轮通过**（`规划修复：自动 0 轮 / LLM 0 轮`，首轮通过率 100%） |
| **N-33 / PL-M34** | 交付块的动作写进提示词 | **本批一次都没验到**——见 §5 |

---

## 3. 失败归因（逐条查库，不采信 summary 的分布）

全批 **9 个 FAILED 任务**，分布在三个 run：

| run | 切片 | 任务 | 类型 | `errorType` |
| --- | --- | --- | --- | --- |
| r1 | slice-2-auth | `T-015` 审查认证切片实现与 AC 覆盖 | REVIEW | `REPLAN_REQUESTED` |
| r2 | slice-1-foundation | `T-10` 编写 Dockerfile 与 .dockerignore | BACKEND | `REPLAN_REQUESTED` |
| r2 | slice-2-auth | `T-012` 实现 HMAC 签名令牌服务与密钥持久化 | BACKEND | **`TIMEOUT`** |
| r3 | slice-1-foundation | `T-05` 编写部署契约静态测试 | TEST | `REPLAN_REQUESTED` |
| r3 | slice-1-foundation | `T-05-REPLAN-1` Retry 编写部署契约静态测试 | BACKEND | `REPLAN_REQUESTED` |
| r3 | slice-2-auth | `T-005` 编写密码哈希落盘与持久化测试 [AC-04] | TEST | `REPLAN_REQUESTED` |
| r3 | slice-3-tasks | `T05` 多用户数据隔离测试 [AC-27] | TEST | `REPLAN_REQUESTED` |
| r3 | slice-3-tasks | `T05-REPLAN-1` Retry 多用户数据隔离测试 [AC-27] | BACKEND | `REPLAN_REQUESTED` |
| r3 | slice-3-tasks | `T09` 任务输入校验与错误封套 | BACKEND | `REPLAN_REQUESTED` |

**8/9 是 `REPLAN_REQUESTED`（agent 主动请求重规划），1/9 是 `TIMEOUT`（run 2 的 `T-012` 撞 900s 墙钟）。**
`失败分层：规划 0 / 验证门 0 / agent N` 在三个 run 里都是**规划与验证门各 0**——
即：**没有一处失败来自平台控制流或验证门**，全部是 agent 侧产出/自评。这是与既往批次最本质的区别。

### 3.1 关键观察：replan 链**收敛**，且深度 ≤ 2

r3 里两条失败链完整走到底：

```text
T-05  (TEST, FAILED) → DEBUG-1 ─┐
                                ├→ REPLAN-1 (BACKEND, FAILED) → DEBUG-2 → REPLAN-2 (BACKEND, SUCCESS)
T05   (TEST, FAILED) → DEBUG-1 ─┘→ REPLAN-1 (BACKEND, FAILED) → DEBUG-2 → REPLAN-2 (TEST, SUCCESS)
T005  (TEST, FAILED) → REPLAN-1 (BACKEND, SUCCESS)
T09   (BACKEND, FAILED) → REPLAN-1 (TEST, SUCCESS)
```

- **`-REPLAN-1` / `-REPLAN-2` 零 PENDING**，全部跑到终态；
- **6 个 DEBUG 任务 6/6 SUCCESS** —— N-29（PL-M30）的 DEBUG 交接在真实批次里稳定成立；
- **`fixTaskType` 本批 5/5 合法**（`BACKEND`×3、`TEST`×2）——与历史普查「753 个非空值仅 119 个合法」
  的 15.8% 有效率形成对照。**该普查数字反映的是修 N-22 之前的样本，不应再当作当前有效率引用。**
- `T05-REPLAN-2` 从 BACKEND **改判回 TEST**：agent 判定「该修的是测试而不是实现」。这是 `fixTaskType`
  的正确用法，不是抖动。

---

## 4. 人工介入（2 / 1 / 1）

r3 的日志有 `任务审批：批准（Task requires human approval；审批 f8855b44-…）`
⇒ **N-32 / PL-M33（harness 自动批准任务级审批）在真实批次确认生效**。此前同一形态会让工作流卡在
`WAITING_APPROVAL` 直到 2 小时超时。

---

## 5. staging 段为什么是 0/3（**结构性，非实现质量**）

三个 run 的 `staging 段` 显示 `ci=SUCCESS deploy=SUCCESS verify=-`：**CI 与 staging 部署都成功了，
VERIFY 一段根本不存在**。原因在计划里：最终切片的 `T18` 是
`type=DEPLOY, delivery={"action":"DEPLOY","environment":"staging"}`——标题写「验证 staging 环境」，
契约却是「再部署一次」。

**本批一次都没验到 N-33**（`docs/218` §12 勘误）：三个 run 共用 run 1 在 **11:02:49** 生成的同一份
计划，而 N-33 的提示词改动在 run 2 与 run 3 之间才落地（平台于 **15:19:52** 重启）。
**run 3 的 `T18` 与 run 1 是数据库里的同一行数据**，提示词改了它也不会变。

**规划探针（PL-M37，`docs/221`）已单独证明提示词有效**：同一批真实输入下，新提示词产出
`task-3-17 = TEST + {"action":"VERIFY","environment":"staging"}`（`VERIFY-PRESENT`）。
所以 §2 的结论不变——**该修的是「计划里没有这一格」，而这一格已经能规划出来了**。

---

## 6. 口径声明（本批的代码版本）

| run | 平台进程 | 差异 |
| --- | --- | --- |
| 1、2 | 15:19:52 之前的进程 | — |
| 3 | **15:19:52 启动**（`agent-core` 已重建含 N-33 提示词） | 提示词改动**未被读到**（计划复用），故 **run 3 的实际行为与 run 1/2 无差别** |

- **N-34 / PL-M35 与 N-27 / PL-M36 的改动在批次中途写入 `apps/server/src`，但平台从未重启**
  （tsx 无 watch）⇒ **本批三个 run 跑的都是这些改动之前的验证代码**。
- 因此：**本批三个 run 是真意义上的同代码、同计划对照**，内部可比性良好。

---

## 7. 判据

| 判据 | 状态 |
| --- | --- |
| L1-8：staging ≥ 2/3 | **未达成（0/3）**——见 §5，结构原因 |
| 链完成 3/3 | **达成**（历史首次） |
| 真交付 3/3（oracle 29/29） | **达成** |
| 假阳性 0 | **达成** |
| N-29：DEBUG 交接 | **达成**（6/6 DEBUG SUCCESS、replan 链收敛） |
| N-32：任务级审批自动批准 | **达成**（r3 日志确认） |
| 33a / 35a（VERIFY 任务存在且由编排器执行） | **未测**（计划无 VERIFY）；35a 由探针 `docs/221` 覆盖 |
| 35b / 35c | **未测**——运行期 |
| 34a/34b/34c（任务审批） | **达成** |

**L1-8 判定：PASS-PARTIAL，如实记录，不勾选。** 依 `docs/154` §5：不因批次未达而否定 M1–M3。

---

## 8. 已知问题

1. **`CHECK_TIMEOUT` 在 run 2 仍有 6 次**（任务级验证分歧 7）——N-34 的修复本批未生效
   （平台未重启）。run 3 的分歧降到 4 且无失败码。
2. **`检查不可判定：DATABASE×1` 三个 run 都有**——同一条，未查。
3. **run 2 的 `T-012 TIMEOUT`**：撞 900s agent 墙钟（N-21 的实施值）。单次，未复现。
4. **run 3 耗时 3h25m**，比 run 1 长 63%。三个 run 的 token 都在 46–50M，耗时增长来自工具轮次而非模型输出，
   未定位。

---

## 9. Next Phase Boundary

**未开始事项（STOP）**：

1. **下一批 E1×3**：run 1 带 `--replan` ⇒ 复核 `requirement_slices.planning_version` 递增
   ⇒ 才能读到新提示词。**周配额窗口 2026-10-25 23:00 UTC 重置**（本窗口 run 3 起跑时已用 694.8M/700M）。
2. **35b / 35c 待下一批**。
3. **`CHECK_TIMEOUT` 的批次级下降待下一批**（N-34/PL-M35 已实施，未生效）。
4. **`DATABASE×1` 不可判定**未查。
5. **全仓门禁**正在跑（批次边界）；`@ai-se/server` 重建与平台重启待门禁通过后进行。
