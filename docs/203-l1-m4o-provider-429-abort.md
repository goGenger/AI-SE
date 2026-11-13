# 203 · L1-M4o 批次中止记录（上游 provider 429）与重开计划

> 批次：`packages/eval/scripts/l1-m4o-e1-x3.sh`（第十五次 L1-8 尝试，PL-M25 的真实批次验证）。
> 中止时间：2026-10-21 09:39 CST（run 1 于 09:37 结束后、冷却期内）。
> 性质：**环境中止，不是平台缺陷，也不是 PL-M25 的问题。**

---

## 1. 发生了什么

| 项 | 值 |
| --- | --- |
| run 1 | 28 分钟即止于 **slice `S1-engineering`**（`ff211882`），任务 `FAILED×6 SUCCESS×10 READY×1 PENDING×6` |
| oracle | 不通过（Must **5 / 29**） |
| staging 段 | 未尝试（`-/-/-`） |
| token | 输入 **2,533,969** / 输出 112,988（远低于一次正常 run 的 30M–70M） |
| 失败分布 | **`EMPTY_FINAL_ANSWER: 5`** + `VERIFICATION_FAILED: 1` |

**根因（查库，非推断）**：5 个 `EMPTY_FINAL_ANSWER` 任务的 `agent_runs` 全部带

```
429 Upstream request failed: Endpoint is unavailable.   (MODEL_RATE_LIMIT)
```

且 `outcomeMode = text-fallback`、`answerLength = 0`、`error.code = LLM_ERROR`
⇒ **模型调用被上游 429 掉**，平台的「重问」也被 429 吃掉，`重问次数已用尽`。

**16 次 agent run 里 5 次 429**，且是**间歇性爆发**而非持续中断：
`S1-01` 秒失败（1 秒）后，`S1-01-DEBUG-1`（**`tool` 模式，拿到真 verdict**）与
`S1-02/03/04/05/06` **全部成功**；`S1-07` 链在 01:34 UTC 撞上第二波 429，
`S1-07-DEBUG-1` / `-DEBUG-2` 连续 429 ⇒ 链尽头 FAILED ⇒ 工作流判死。

---

## 2. 为什么判「不是 PL-M25 的问题」

1. **错误码是 `LLM_ERROR` / 429**，来自模型网关，与路由、schema、提示词无关。
2. **`tool` 模式通了**：`S1-01-DEBUG-1` 以 `outcomeMode = tool` 正常提交并拿到真 `VERIFICATION_FAILED`
   ——若是我改的 schema/提示词有问题，`tool` 模式会先崩。
3. **replan 链跑起来了**：`S1-01-REPLAN-1`、`S1-08-REPLAN-1`、`S1-01-DEBUG-1-REPLAN-2` 均 SUCCESS
   ——PL-M25 改的路由在这段里**没有制造新问题**（只是这批没有交付任务，26d 未被行使）。
4. **独立探针复核**（2026-10-21 09:40 CST，直连网关、最小请求）：

   | 探针 | 结果 |
   | --- | --- |
   | 1 | **429** `Endpoint is unavailable` |
   | 2 | **200** ✓ |
   | 3 | **429** |

   ⇒ **当前约 50% 失败率**，与批次内观测一致。

---

## 3. 为什么停批而不是让它跑下去

run 2 会在冷却（30 分钟）后启动。**已知上游约 50% 失败时，run 2 极可能同样早死**——
按记忆 [[fix-known-defects-before-batches]] 的同一条纪律：**已预知无效的运行不该继续花配额**。
已执行 `l1-m4o-stop.sh`：批次脚本与冷却 `sleep` 均已杀、`RUNNING`/`PENDING` 工作流 **0 条**（已核对）。

**另一条独立理由**：run 1 的读数**已被环境污染**，留着它会让本批的 staging 段分母含一条无效运行
（L1-8 的判据是 `E1×3`，不是「2 条有效 + 1 条无效」）。故 **run 1 的产物已改名为
`provider-429-aborted-run-1.{json,md}`**（放在同一结果目录内，**不删**——它是这次中止的记录），
使重开时 run 1 能干净地重跑。

---

## 4. Modified Files

| 文件 | 动作 |
| --- | --- |
| `packages/eval/scripts/l1-m4o-e1-x3.sh` | 新增（批次脚本，`bash -n` ✓、ASCII-only ✓） |
| `packages/eval/scripts/l1-m4o-stop.sh` | 新增（**必须有**：`l1-m4n-stop.sh` 的 pattern 不覆盖本批，且它只会杀掉冷却 `sleep`，反而会把循环推进到下一轮） |
| `packages/eval/results/l1-m4o/provider-429-aborted-run-1.{json,md}` | 新增（**改名保留**的中止产物） |
| `docs/203-l1-m4o-provider-429-abort.md` | 新增（本文件） |

**零 `src/` 改动、零依赖改动、零测试改动。**

---

## 5. Known Issues

1. **PL-M25 仍未在真实批次验证**（`docs/202` §6.2 的判据 26d / 25f 都还没被行使）。
2. **上游 429 的恢复时间未知**——它是**外部条件**，不在本仓库的可控面内。
3. **`EMPTY_FINAL_ANSWER` 的机制登记仍为空**（L1-M4n 脚本 watch item 14：L1-M4h 5 次 / L1-M4i 1 次 /
   L1-M4j 1 次，机制未知）。**本批给了这条一个具体实例**：它是**上游 429 的表现形式之一**——
   `LLM_ERROR` + `answerLength = 0` + `outcomeMode = text-fallback`。
   **建议**：把「`EMPTY_FINAL_ANSWER` 的 `agent_runs.error` 是否带 429」补进下一批的普查口径，
   否则这条会被误读成平台缺陷。
4. **周配额**：331,271,625（run 1 后约 333.8M）/ 700,000,000。中止未造成显著浪费。

---

## 6. 重开计划

1. **探测上游直到恢复**（连续探针 ≥ 5/6 成功视为可用）。
2. **重开一个新的结果目录批次**（按仓库惯例：一次批次一个目录；`l1-m4o` 保留为「被上游中止」的批次）。
3. **重开前的前置**：确认 `RUNNING`/`PENDING` 为 0、平台健康、`.env` 的 provider 未被改动。
4. 重开后按 `l1-m4o` 脚本头的 watch item 1（判据 26d）在 CI 任务首次出现时查库验证。

**未开始事项（STOP）**：重开批次、26d/25f 的验证、以及 `docs/202` §9 列出的其余各项。
