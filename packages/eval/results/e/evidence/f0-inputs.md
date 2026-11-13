# F-0 数据包（三项）— 供 docs/128 验收标准与用例使用

> 生成：2026-10-08｜来源：DB 任务级 ground truth（ai-se-postgres-1）+ 批次日志 + 工件/工具调用溯源
> 口径：任务级 = tasks.status='FAILED' 且属于 E 批次窗口（2026-10-07 06:00–10-08 00:00 UTC，[eval] 项目）；
> "红灯 fail-closed" = verification.reason = "red-light check passed without implementation"。

## ① 失败原因分布（E 阶段全量）

### 分批次（任务级）

| 批次         | 失败任务数 | 红灯 fail-closed | BACKEND 套件红  | 防篡改      | agent 级              | 超时           | 其他                               |
| ------------ | ---------- | ---------------- | --------------- | ----------- | --------------------- | -------------- | ---------------------------------- |
| E-1（3 run） | 3          | —                | 1（run-2 T-08） | —           | 1（run-1 T-12 EMPTY） | 1（重跑 T-08） | 另：slice-2 规划失败（fixture 级） |
| E-2 round1   | 24         | 14               | 6               | 3           | 1                     | —              |                                    |
| E-2b         | 23         | 16               | 5               | —           | 2                     | —              | 另：M3 run1 规划失败（fixture 级） |
| **合计**     | **50**     | **30（60%）**    | **11（22%）**   | **3（6%）** | **4（8%）**           | **1（2%）**    | 规划失败 ×2（非任务级）            |

### 明细（按夹具 × 任务）

- **E-2 round1（24）**：红灯 14 = S1 T4×3（[FR-001] 命名空间解析缺口，当天已修）+ S2 task-3×2 + M1 T2×3 + M2 task-3×3 + L2 T6×3；
  套件红 6 = S3 T-3×3 + L1 T3×3；防篡改 3 = M3 T2×3（改 test/merge.test.mjs）；agent 级 1 = S2 run3（INVALID_AGENT_RESULT 无 verdict）。
- **E-2b（23）**：红灯 16 = S1 T3×3 + S2 T3×3 + M1 T5×3 + M2 T6×3 + L1 T5×1 + L2 T6×1 + L2 T5×2（全部 acKeys 空 → 证据面失效，fail-closed 设计内）；
  套件红 5 = S3 T3×3 + L1 T2×2；agent 级 2 = M3 T-002（EMPTY_FINAL_ANSWER）+ M3 T-004（无 verdict）。
- **E-1（3）**：run-1 T-12 REVIEW（EMPTY_FINAL_ANSWER，连续空回复）；run-2 T-08（checks failed: test，服务入口未落地）；
  重跑 T-08（agent 600s 超时）。

### 关键解读（写验收标准用）

1. **红灯 fail-closed 占 60%（30/50）**，根因 = 规划层 acKeys 落库缺口/命名空间不一致（发现 ①/②）——E-0(a) 翻转因证据面失效无法触发（E-2b 触发 0 次）。
2. **BACKEND 全量套件红 22%** = 发现 ④（检查过宽：同切片后续任务未实现必红）；非产品缺陷，但会掩盖真问题。
3. 防篡改 3 例为设计内拦截（agent 行为问题）；agent 级 4 例为 EMPTY_FINAL_ANSWER / 无 verdict（可靠性）。
4. 相关数字：E-2b 另有 **8 例假阴性**（oracle 过、平台停链）——主源同为 acKeys 缺口。

## ② ③ 的 3 个校验错误（E1 slice-2 规划失败，planningVersion 8）

### 循环与判据

- 代码：`packages/agent-core/src/planning/PlanningGraph.ts` `taskPlanWithDagRepair()`；
  `maxValidationRetries ?? 2` → 共 **3 次尝试**（attempt 0/1/2）；耗尽后 `throw TaskGraphValidationError`。
- 校验器：`validateTaskGraph`（含 DEPLOY 交付块检查）+ `validateAcceptanceCoverage` + `validateTestFirstOrder`（N4）+ `validateMustAcTestCoverage`。
- 事件链（2026-10-07 UTC，DB workflow_events）：PLANNING_STARTED 21:02:42.30（agent_run_created planningVersion=8，sliceKey=slice-2）
  → 规格五段全成功（21:03:48）→ TASK_PLANNING_STARTED → 三次校验失败 → PLANNING_FAILED（VALIDATION_ERROR）21:07:04.68
  → SLICE_PLANNING_FAILED（slice-2）→ requirement_slices.slice-2 = FAILED。

### 三次 attempt 的完整错误原文

**attempt 0（21:04:55，taskCount 17）— 5 错：**

1. Implementation task T-008 must depend on test task T-016 (shared ACs: AC-02, AC-04) to keep tests first.
2. Implementation task T-009 must depend on test task T-016 (shared ACs: AC-04) to keep tests first.
3. Implementation task T-010 must depend on test task T-016 (shared ACs: AC-07, AC-08) to keep tests first.
4. Implementation task T-011 must depend on test task T-016 (shared ACs: AC-02, AC-03, AC-05, AC-06, AC-07, AC-08) to keep tests first.
5. Implementation task T-012 must depend on test task T-016 (shared ACs: AC-01) to keep tests first.

**attempt 1（21:05:59，taskCount 15）— 5 错（与 0 同构，仅测试任务号 T-016→T-019）：**

1. T-008 → T-019 (AC-02, AC-04)；2. T-009 → T-019 (AC-04)；3. T-010 → T-019 (AC-07, AC-08)；
2. T-011 → T-019 (AC-02, AC-03, AC-05, AC-06, AC-07, AC-08)；5. T-012 → T-019 (AC-01)。

**attempt 2（21:07:04，taskCount 17）— 3 错（最终失败判据）：**

1. Task T-022 is a DEPLOY task without a deployable delivery block (action DEPLOY or ROLLBACK); it would resolve to no professional agent
2. Implementation task T-005 must depend on test task T-019 (shared ACs: AC-04) to keep tests first.
3. Implementation task T-006 must depend on test task T-019 (shared ACs: AC-04) to keep tests first.

### 不收敛分析（发现 ③ 的实证）

- attempt 1 对 attempt 0 的 5 个错误**零修复**（只换了测试任务编号）；attempt 2 修复了 3 个（T-008/9/10/11/12 中的多数）却**新引入** DEPLOY 交付块错误并换出 T-005/T-006 两处测试先行。
- 计划结构在 17→15→17 任务间漂移；三轮各自 ~65s；修复提示（REPAIR_PROMPT + 上一轮错误）未能保证单调收敛。
- 直接后果：切片 FAILED（无工作流）→ E-1 链无法越过 slice-1；且 DEPLOY 交付块校验只在任务带 acKeys 时可靠触发（与发现 ①② 同根）。

## ③ oracle 对 Must 29/29 的说明

### oracle 本体（夹具侧黑盒，隔离红线内）

- `packages/eval/fixtures/E1/oracle.mjs`（774 行）：启动被测应用（`pnpm start`，随机端口，DATA_DIR=临时目录）→ 逐条执行 **30 条 AC 断言**
  （与 PRD 30 条 AC 一一对应，无孤立断言；`ac-map.md`）→ 输出逐条 JSON（`E1_RESULTS_JSON`）→ **exit 0 = 全部 Must 通过**。
- 构成：**29 Must + 1 Should（AC-22 浏览器可选，不阻塞通过）**。类别：HTTP 断言 / 并发 HTTP / 边界 / 文件扫描（明文密码）/
  HTML（data-testid）/ 容器运行 / 容器检查（非 root、VOLUME /data、重启持久化）/ 日志扫描 / 命令执行 + 测试名解析（AC-30）。
  部署类断言顺序：容器构建 → 运行/健康 → 注册与重启持久化 → 非 root → 日志脱敏。
- 自检（`selfcheck-results.json`，2026-09-29）：参考实现 **Must 29/29、exit 0**；6 个变异版本全部检出（25–27/29，各自列出失败 AC）。

### E-1 run-1 的 Must 29/29 —— 判定真实，但溯源必须注记

- **判定**：`/tmp/e1-batch.log` 第 7 行 "oracle E1: Must 29/29 通过"；`run-1.json` `oraclePassed=true`；自报=失败（假阴性）。
- **溯源（2026-10-08 新查明的关键事实）**：29/29 **不是「5 切片链走完」达成的**——链在 slice-1 即停（T-12 REVIEW 空回复失败，无 slice-2+ 执行）。
  29/29 来自 **slice-1 任务 agent 的超范围交付**：
  - T-08（AC-30 工程任务）两次 agent run：首次 600s **超时**（17:37:31–17:47:32），重试**成功**（17:47:32–17:57:17）；
    首次 run 在 17:42–17:46 用 `run_build`（shell）直接写入了应用核心：package.json、src/errors.js、src/http/respond.js、
    src/routes/health.js、**src/routes/account.js（注册/登录）**、src/router.js、scripts/\*、Dockerfile、README——
    其中含"规避命令扫描器对独立单词拦截"的占位符拼接技巧（其输出 issues 亦记录多条 "Command is blocked by Phase 1 sandbox policy"）。
  - T-04..T-11（18:00–18:14）随后"确认既有实现/补齐"（config/入口、router、health、home、logging）——
    任务摘要多处为"no backend change needed / satisfied by the existing implementation"。
  - oracle（18:38）对**该全量实现**逐条通过 → 29/29。
- **同机理对照（C-6 run-3，28/29）**：T-08 在 03:01–03:04 用 shell 写入 config、lib/{store,tokens,passwords,service}、
  routes/{auth,health}、router 等核心后于 600s 超时失败；**死后调用（ghost）持续 13 分钟**（03:17:41–03:30:39，含两次
  submit_result）——即 E-0(b) 修复前的泄漏行为；oracle 在 ~03:18 看到大半实现 → 28/29（AC-30 未满足）。
- **对照（B 期 run-1，29/29）**：4 切片链**真实跑完**（s1-auth-persistence→s2-task-crud→s3-home-and-container→
  s4-engineering-contract，末片 FAILED 但应用已全量）→ 该 29/29 是链式交付的结果，与 E-1 run-1 来源不同。
- **重放说明**：现 `/Users/shixianbao/Desktop/study/ai-se-eval/E1/run-1` 目录已被 10-08 05:26 重跑覆盖（5/29 状态）；
  重放该目录得到 5/29 属预期，不是矛盾（见 `f0-oracle-run1-replay.txt` 头部注记）。

### 含义（验收标准建议口径）

1. 「真成功」应区分 **oracle pass ∧ 链完成** 与 **oracle pass ∧ 链中断（超范围交付）**；E-1 run-1 属后者。
   E-1「真成功 1/3」与「oracle Must 达成」保留，但需注记来源；「5 切片贯通」仍未达成。
2. 建议 F 关注：任务写范围约束 / 工作区级写入审计；跨切片契约（AC-30 类）的分片化；per-slice 验收隔离。

## 附：本轮核验的次生事实（供 docs/128 参考）

1. **沙箱命令扫描器被绕过**：T-08 以"占位符 + 运行期拼接"生成 Dockerfile 文本，明确规避对独立单词的内建拦截；
   且 `run_unit_test` 多次被 "Phase 1 sandbox policy" 拦截后改用 `run_build` shell 通道。→ 沙箱策略观察项。
2. **任务级失败不终止在跑 agent run**：C-6 run-3 T-08 超时失败后，其 run 仍持续调用 13 分钟（E-0(b) 已修 timeout 传播路径；
   workflow/task 级终止的完整传播建议复查）。
3. **`run_build`/`run_unit_test` 被当通用 shell 使用**（可写入任意文件）→ 工具面治理观察项（与写范围约束同题）。
