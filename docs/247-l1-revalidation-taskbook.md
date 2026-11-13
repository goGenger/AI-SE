# 247 · 自治 L1 复验任务书（让策略内自治真正用起来）

> 状态：**已中止 / aborted**（2026-11-04 ~16:01 Asia/Shanghai）。用户确认平台**不再开发后端任务**；E1 + `backend-node` 复验超出产品范围。批次经 `l1-rv1-stop.sh` 停干净；残留 S4 工作流 `093a4780…` 已 `CANCELLED`；看门狗 routine 已删。旧 poisoned 归档仍在 `packages/eval/results/l1-rv1/poisoned-20261104-mock-frontend-vue/`（不计入）。**不重开**本复验；前端主线改走 `frontend-vue` 默认 + F1。
> 性质：在 **F1 round20 全绿 + 门禁 P1 + Phase 8 已落地** 的当前平台上，对自治 L1 做一次**严格实机复验**——目标不是重开 L1 清单勾选（`docs/17` L1 节 / `docs/224` 已于 2026-10-23 记达成），而是证明 **staging 段仍稳、且策略内决策被真实行使并可记账**。
> 依据：`docs/17`「自治 L1」验收正本；`docs/154`（原 L1 任务书）；`docs/224`（L1-8 收口批次 `l1-m4u`）；`docs/233` / F1 round20；门禁 P1（矛盾期望 → `fixTaskType=TEST` → DEBUG 改测 → 同契约 CI）；Phase 8（`docs/242`…`docs/246`）。
> 编号：批次建议名 **`l1-rv1`**（revalidation）；验收仍沿用 L1-1…L1-9，本文件不新造验收码。
> **纪律**：本文件写明「先审后跑」。**未获用户明确开跑指令前：不启批次、不改 `.env`、不重启平台。**

---

## 0. 一句话目标

在**当前**平台（OpenCode + 门禁 P1 + 修后 REPLAN + Phase 8 骨架已生效）上，用 **E1×3 + `--autonomy-l1`** 再打一轮，让 **staging 交付（CI ∧ staging DEPLOY ∧ staging VERIFY）≥ 2/3**，并留下可复核的 **`AUTO_APPROVED` / `AUTO_ROLLED_BACK`（及同族）决策事件记账**——证明「自治」不是只在单测里绿，而是在真链上被踩到。

---

## 1. 为什么现在复验（而不是再加模块）

| 事实 | 含义 |
| --- | --- |
| F1 round20 正式全绿 | 交付链与前端夹具已证明可绿；**不替代** L1 的 E1 数据门槛与决策事件复验 |
| 门禁 P1 已重启加载 | 矛盾期望不再盲目重跑坏测；REPLAN 可改测——历史许多「死在 CI/计划」应更少挡住自治层 |
| Phase 8-A→8-D 已收口 | 告警→诊断→白名单受控修已可用；**与本复验正交**（本批不测 Incident） |
| `docs/224` / L1-8 曾达标（`l1-m4u`） | 清单已勾；但长串 PL-M 时代大量批次 **staging 未达 / 自治事件 0 次**；F1 之后平台又变了一截，**缺的是「绿链上反复打到策略内决策」的新证据** |
| 历史失败模式 | 常死在规划 / CI / 契约，**到不了** staging DEPLOY ⇒ `AUTO_APPROVED` / 回滚路径从未被真实批次行使 |

**结论**：现在缺的不是更多能力面，而是 **在绿链上把 L1 决策门真正打响并记账**。

---

## 2. 目标 / 非目标

### 2.1 做（目标）

1. **严格 L1 复验批次**：E1×3，策略 `--autonomy-l1`（与平台 `L1_WORKFLOW_POLICY` 一致）。
2. **staging 段数据门槛**：与 L1-8 同口径——CI SUCCESS ∧ staging DEPLOY SUCCESS ∧ staging VERIFY SUCCESS；汇总 **≥ 2/3**（用 `collectStagingSegment` **取最终一次尝试**，`docs/224` N-36）。
3. **决策事件记账（本复验的新增强调）**：按 `workflowRunId` 从 `workflow_events`（或 `/events` / `/trace`）统计至少：
   - `AUTO_APPROVED`（staging 策略内跳过人工、直接执行）——**期望：凡到达 staging DEPLOY 的 run ≥ 1 次/run**；
   - 若本批出现 staging DEPLOY 失败并走回滚：`AUTO_ROLLED_BACK`（契约事件名以 `docs/152` / 写入方为准）须落库；
   - 可选观测：`AUTO_RETRIED` / `VERIFICATION_ENFORCED_FAILURE`（有则记，无则不伪装）。
4. **人审收敛**：生产 DEPLOY / HIGH·CRITICAL **仍人工**（L1-9 红线）；评测 harness 对生产关口的代批准**计入 `humanInterventions`**，不得写成「自治批准生产」。
5. **产物归档**：`packages/eval/results/l1-rv1/`（`run-{1,2,3}.json` + summary）+ 本批记录文档（开跑后另立 `docs/248+`，本任务书不预占）。

### 2.2 不做（非目标）

- **不开跑**直至用户审完本任务书并明确说开跑；
- **不改根 `.env`**（保持 OpenCode；禁止改成 DeepSeek 直连「省事」）；
- **不把本批分数记成 F1**；不重跑整轮 F1；
- **不测 Phase 8 Incident 闭环**（可与本批并行规划，但不是本批出口）；
- **不推进自治 L2**（关口 1 策略化仍见 `docs/227`；本复验 ⊇ L1 行为即可）；
- **不扩大** `INCIDENT_AUTO_REMEDIATE` 白名单、不把该开关写入 `.env`；
- **不借机**引入外部 OTel/Grafana 全家桶；
- 已知确定性缺陷未修前**不得硬开下一批**（`fix-known-defects-before-batches`）。

---

## 3. 成功判据（冻结）

| # | 判据 | 通过线 | 证据落点 |
| --- | --- | --- | --- |
| S1 | staging 段交付 | **≥ 2/3** run 的 `stagingSegment.delivered === true` | 各 `run-*.json` + summary「staging 段交付率」 |
| S2 | 假阳性 | **0** | summary `falsePositiveRate` |
| S3 | 决策事件：AUTO_APPROVED | 每个 **staging DEPLOY 曾 SUCCESS** 的 run，对应工作流事件中 **`AUTO_APPROVED` ≥ 1** | SQL / `GET /api/workflows/:id/events`；记入批次记录 |
| S4 | 决策事件：回滚（条件） | 若本批有 staging DEPLOY 失败且策略应 ROLLBACK：须有 **`AUTO_ROLLED_BACK`（或现行写入方事件名）**；若全批无 DEPLOY 失败 ⇒ 本项 **N/A**，不扣分 | 同上 |
| S5 | 红线 | production 仍 `WAITING_APPROVAL`（或等价人工门）；HIGH/CRITICAL 不可被 L1 关掉 | 抽查最终切片生产 DEPLOY；对照 L1-2 / L1-3 / L1-9 |
| S6 | 路由约束 | 全程 OpenCode（与现网一致）；**.env 未被本批改写** | 启动前后 `.env` 指纹或进程环境抽查 |

**未达 S1**：如实 **PASS-PARTIAL** + 逐 run 归因（沿用 `docs/127` §9），**不回退** `docs/17` 已勾的 L1-8（除非用户书面要求重开勾选）。  
**S1 达标但 S3 为 0**：视为**复验未达成「真正用起来」**——即使 staging 绿，也必须调查「为何没写 AUTO_APPROVED」（观测缺口 vs 路径未走到），不得只报「绿了」。

---

## 4. 批次规模与夹具

| 项 | 取值 |
| --- | --- |
| 夹具 | **E1**（与 L1-8 / `l1-m4u` 同夹具；**不用 F1**） |
| 次数 | **×3**（`run-1`…`run-3`） |
| 策略 | CLI **`--autonomy-l1`**（`packages/eval/src/cli.ts` 的 `L1_POLICY_OVERRIDE`） |
| 结果目录 | `packages/eval/results/l1-rv1/` |
| 脚本（开跑时再建，ASCII-only） | 建议 `packages/eval/scripts/l1-rv1-e1-x3.sh` + `l1-rv1-stop.sh`，形态对齐 `l1-m4u-e1-x3.sh` |
| run 1 | **带 `--replan`**，避免共用陈旧切片计划（`l1-m4u` 教训） |
| 端口 | 默认 `http://127.0.0.1:47558` |
| 配额 | 开跑前确认周窗口用量；单批历史量级可达 **~100M–250M+ 输入 token**（`l1-m4u` 曾 ~235M）——**须用户确认余量** |
| 冷却 | run 间建议 ≥ 300s（可沿用 M4u 默认） |

**夹具选择说明**：F1 证明前端交付链；L1 数据门槛与历史对照系建立在 **E1** 上。混用 F1 分数会污染两边口径。

---

## 5. 平台前置（开跑 checklist 的硬条件）

开跑前须全部为真（只读核查，本任务书阶段**不**重启、不改配置）：

1. **Server 健康**：`GET /health` → 200；ready 正常；`VERIFICATION_GATE` 对 L1 工作流为 enforce（L1-4：按工作流 `autonomyLevel=L1`）。
2. **门禁 P1 已在进程内**：矛盾期望命中 → `fixTaskType=TEST` → DEBUG 改测 → 同契约 CI（2026-11-04 已加载过；若此后又起过旧进程，开跑前再确认一次源码/行为，**仍须用户批准才重启**）。
3. **模型路由**：根 `.env` 仍为 **OpenCode** 路径；本批脚本**不得**改写 `.env`。
4. **无并行占坑批次**：无其它 E1/F1 eval CLI 占用同一 server / 同一结果目录。
5. **迁移**：Phase 8 的 `020`–`022` 已应用与否**不阻塞**本 L1 复验（正交）；不必为本批再迁。
6. **已知缺陷门**：若开跑前又发现确定性平台缺陷（会结构性杀批），**先修再跑**，不拿配额撞墙。

---

## 6. 人审策略（收敛，不砍红线）

| 门 | L1 期望 | 本批评测怎么处理 |
| --- | --- | --- |
| staging DEPLOY / 低风险工具 | **自动**（应产生 `AUTO_APPROVED` 等） | harness **不得**再人工点 staging |
| production DEPLOY | **必须人工** | harness 可代批准以走完链，但计 **人工介入**；事件不得记成自治批准生产 |
| HIGH / CRITICAL 工具 | **必须人工** | 策略不得关闭；若批次触发，按既有审批 |
| 关口 1（切片计划） | 仍属 L1 外（L2 议题） | 沿用 harness 现行为；本复验**不**把关口 1 自动批准算进 L1 决策成功 |
| Phase 8 生产修复 | 仍审批 | 本批不触达 |

原则：**人只守硬门**；策略内失败优先走既有 RETRY / REPLAN / 改测（P1），减少「空等人工」却把失败伪装成自治不足。

---

## 7. 看门狗与值班节奏

- 使用既有 **`packages/eval/scripts/eval-batch-watchdog.sh`**：
  - `--batch-pattern l1-rv1-e1-x3.sh`
  - `--results-dir packages/eval/results/l1-rv1`
  - `--port 47558`
- 事件语义沿用脚本：批挂掉 / 新 `run-*.json` / 停滞 / health≠200 / heartbeat。
- 停批：`l1-rv1-stop.sh`（须同时取消 server 侧运行中工作流，对齐 `l1-m4u-stop.sh` 行为）。
- 聊天侧：正常进度可安静；**跑完、health 异常、停滞、配额守卫触发**再说。

---

## 8. 失败处置

| 情况 | 动作 |
| --- | --- |
| 上游 429 / 配额守卫 | 停新 run；已完成 run 保留；记污染口径（可剔除 LLM_ERROR×429） |
| 确定性平台缺陷（同签名 ≥2 run） | **中止剩余 run**；登记 N-xx；先修；**禁止**修前/修后混进同一 `l1-rv1` 目录充数 |
| staging ＜ 2/3 | PASS-PARTIAL + 归因；不自动开下一批 |
| staging 达标但 AUTO_APPROVED=0 | 查写入方与查询路径；开「观测/路径」小修任务，**不**宣称复验成功 |
| 误改 `.env` / 误切 DeepSeek | **立即停批**；恢复 OpenCode；本批作废或标明污染 |

---

## 9. 与 F1 / Phase 8 的关系

```text
F1 round20     ──证明──► 交付链 + 前端夹具可绿
门禁 P1        ──减少──► 「坏测死循环」挡住 staging
Phase 8        ──提供──► 出事可告警/诊断/白名单修（日常运维面）
本复验 l1-rv1  ──证明──► 策略内自治在 E1 真链上被行使且可审计
```

- **不替代**：F1 正式分数仍只认 `f1-frontend/`；Phase 8 验收仍只认 `docs/17` Phase 8 / `docs/243`…`246`。
- **不阻塞**：Phase 8 日常告警源接入可另开任务；与本复验无互相开工阻塞。
- **顺序建议**：先审本任务书 →（确认配额）→ 开 `l1-rv1` → 批次记录 → 再谈 L2 或告警源。

---

## 10. 开跑 checklist（审阅通过后逐项勾）

> **现在全部未勾。** 用户说「开跑」后，执行代理按序做；本任务书阶段只写清单。

1. [x] 用户明确确认：审完 `docs/247`，同意开跑 `l1-rv1`
2. [ ] 确认周配额余量（预估单批可达亿级输入 token）
3. [x] 只读：`/health`、验证门、OpenCode `.env` 未改、无并行批次
4. [x] 只读：门禁 P1 / REPLAN 改测仍在当前 server 进程（否则**请示重启**，不得擅自重启）
5. [x] 新建 `l1-rv1-e1-x3.sh` / `l1-rv1-stop.sh`（ASCII），`OUT_DIR=.../l1-rv1`，run1 `--replan`
6. [x] `caffeinate` 启批 + 挂上 `eval-batch-watchdog.sh`
7. [ ] 跑完：归档 json/summary；统计 staging 段与 `AUTO_APPROVED` / 条件性回滚事件
8. [ ] 写批次记录（新 docs 号）；回写 `docs/146` §1.1 / §7 与本任务书状态行
9. [ ] STOP：不自动开 L2 / 不自动开下一 F1
10. [x] **产品中止（2026-11-04）**：用户确认不做后端；停批；不重开 E1 L1 复验

---

## 11. 退出与状态机

| 状态 | 含义 |
| --- | --- |
| 任务书待审 | 仅有本文；未开跑 |
| **已中止（当前）** | 产品不做后端；E1/`backend-node` 复验作废；见状态行 |
| 已裁定开跑 | 用户一句话批准；进入 checklist |
| 批次中 | `l1-rv1` 有进程 / 部分 `run-*.json` |
| 复验达成 | S1–S3（及适用的 S4–S6）满足 |
| PASS-PARTIAL | S1 未达或 S3 未达，有归因 |
| 中止 | 确定性缺陷或配额/上游污染，剩余 run 未跑 |

---

## 12. 建议的用户审阅焦点（不用改代码）

1. 是否接受 **E1×3**（而非 F1）作为复验夹具？
2. 是否接受把 **`AUTO_APPROVED` 记账**提升为与 staging≥2/3 **并列**的硬出口？
3. 配额是否够再烧一轮接近 `l1-m4u` 量级？
4. 开跑时若需重启 server 加载确认 P1，是否一并授权？

审阅意见直接回本对话即可；**默认下一步 = 你说「开跑」之后才建脚本启批。**
