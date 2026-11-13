# 214 · PL-M31 实施记录（N-30：把实现覆盖规则告诉规划器）

> 阶段：**PL-M31** ｜ 发现场：**L1-M4r run 3**（`docs/213` §5）
> 用户 2026-10-21 授权自主排期后直接开工（记忆中「按你推荐的来 / 尽快落地」）。
> **未在真实批次验证 ⇒ 不判「已关闭」。**

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `packages/agent-core/src/planning/PlanningGraph.ts` | 修改 | `acHint` 增加一句：Must AC 必须被**实现类**任务覆盖，并给出部署/容器类 AC 的处理方式 |
| `packages/agent-core/src/planning/PlanningGraph.test.ts` | 修改 | **+1 个用例**（断言提示词含该规则） |
| `docs/213-phase-l1-m4r-record.md` | 新增 | 批次记录（本缺陷的发现场） |
| `docs/214-phase-pl-m31-implementation-coverage-hint.md` | 新增 | 本文件 |

**零依赖改动、零 migration、零校验器改动。**

---

## 2. Implementation

### 2.1 缺口

`validateImplementationCoverage.ts:32` 要求：切片范围内每个 Must AC 必须被
**BACKEND / FRONTEND / DATABASE** 任务引用（`IMPLEMENTATION_TYPES`，`validateTestFirstPlan.ts:32`）。

而 `PlanningGraph.ts` 给规划器的 `acHint` 只说：

- 「每个 AC 至少被**某个**任务的 `acKeys` 引用」——`DEPLOY` / `TEST` 也算「某个」；
- 「每个 Must AC 需要 TEST 任务」；
- 「实现任务若交付某 AC，必须依赖覆盖它的 TEST 任务」。

**从未说过覆盖者必须是实现类。** 规划器无从得知，三轮修复轮只能靠猜。

### 2.2 改动

在 `acHint` 中补一句（`PlanningGraph.ts`，紧随「每个 AC 至少被某个任务引用」之后）：

```
Every Must AC must additionally be referenced by at least one implementation task
(BACKEND, FRONTEND or DATABASE); TEST, REVIEW, BUILD and DEPLOY tasks do not satisfy this.
For Must ACs about deployment, containers, logs or commands, add an implementation task that
produces that artifact (for example a BACKEND task that writes the Dockerfile and runtime
configuration) and list those AC numbers in its acKeys.
```

**为什么给出「怎么写」而不只给「什么不行」**：`docker build` 这类 AC 的产物是 Dockerfile，
规划器需要知道它可以落在一个 BACKEND 任务上，否则即使知道规则也不知道该怎么满足。

### 2.3 为什么改提示词而不是改校验器

PL-M1（`docs/160`）**就是要**报出这 5 条错误——它的 E2E 判据逐字写着「修后报出 5 条」。
规则本身是对的：那条规则防的是「红测试没有实现任务把它转绿」。

三个改法的取舍：

| 方案 | 问题 |
| --- | --- |
| 把 `BUILD`/`DEPLOY` 加进 `IMPLEMENTATION_TYPES` | 会让**任何** Must AC 都能被交付任务「覆盖」，把 PL-M1 修的洞重新打开 |
| 让全局性 AC 豁免 | 同上：容器类 AC 仍然需要有人写出 Dockerfile，豁免等于承认没人负责 |
| **把规则写进提示词** | 保留 PL-M1 的判定，只补上**信息**——模型此前拿不到的就是这条 |

### 2.4 生效路径（已核对，不是假设）

`PlanningGraph.ts:404-411` 每次 attempt 都**重新拼装**提示词：

```
taskPlanningPrompt(…)  +  acHint  +  [REPAIR_PROMPT, Validation Errors…]
```

`acHint` 因而**同时进入首轮与每一个修复轮**，不需要单独改 `repair.prompt.ts`。

---

## 3. Architecture Changes

**无。** 不改校验器语义、不新增校验通道、不新增错误码、不改 `autoFixTaskPlan` 的白名单
（它「不增删任务、不改 AC 映射」的裁定仍然成立）。

---

## 4. Dependencies

**无新增、无升级、无删除。**

---

## 5. Tests

**新增 1 条**（`PlanningGraph.test.ts`）：以一条**容器类** Must AC（`verification: "容器运行"`）跑一次
`runPlanningGraph`，断言任务规划提示词同时包含

- `at least one implementation task (BACKEND, FRONTEND or DATABASE)`
- `TEST, REVIEW, BUILD and DEPLOY tasks do not satisfy this`

**为什么测这个**：这条规则的**唯一载体就是提示词**。删掉那句话，所有既有校验器测试照样全绿，
而缺陷完整回归——和 PL-M30 抽 `resolveOutcomeTaskStatus` 的理由同源。

| 包 | typecheck | lint | test |
| --- | --- | --- | --- |
| `@ai-se/agent-core` | ✅ exit 0 | ✅ exit 0 | **258 / 258**（35 文件） |

---

## 6. Lint / 7. Typecheck

见 §5 表：均 **exit 0**。

---

## 8. E2E

**未跑真实批次（写作时进行中）。** `packages/agent-core` 已重建 dist，平台服务已重启
（**注意**：dist 重建**不会**热重载已在运行的 server——本次实测该进程已跨过一次重建存活
3h39m，必须显式重启）。

判据（批次 `l1-m4s`，`docs/215` 记录）：

| 判据 | 内容 |
| --- | --- |
| **32a** | 最终切片 `slice-3-tasks` 的 DAG 校验在 attempt 0 或修复后通过 |
| **32b** | 有 run 进入交付链（CI BUILD / staging DEPLOY / staging VERIFY） |
| **32c** | staging 段交付率变成可测（> 0，或为 0 但有具名阻塞点） |
| 回归 | 切片 1、2 仍能通过（M4r run 3 两条都过了） |

---

## 9. Known Issues

1. **这是提示词改动，不是确定性保证**：模型可能仍不遵守。若 `l1-m4s` 仍撞同一堵墙，下一步应改成
   **把错误信息本身写成可执行的**（`validateImplementationCoverage` 的错误文案点名所需任务类型），
   因为修复轮逐字接收 `validationErrors`。本次**没有**顺手改文案，是为了不牵动 9 处既有断言。
2. **不解决 `fixTaskType` 合法率低**（`docs/213` §6 第 1 项，9/45 非法值）——那是另一条独立的形状。
3. **不解决交付段本身的缺陷**：至今没有任何 run 进入过 CI / DEPLOY / VERIFY，那里仍是**零覆盖**区。

---

## 10. Acceptance Result

**交付物是「1 句规则 + 1 条回归用例 + 两包门禁」**（本阶段只涉及 `@ai-se/agent-core`）。

按仓库记账纪律判 **「已实施、未在真实批次验证」**，**不判「已关闭」**。

**判据对照**：**32a / 32b / 32c 均未行使**。

---

## 11. Next Phase Boundary

**未开始事项（STOP）**：

1. **`l1-m4s` 批次结果**——32a/32b/32c 只在那一批里能验证。
2. **若 32a 仍不通过**：把错误文案改成可执行的（见 §9 第 1 项）。
3. **交付段零覆盖**——即使 32a 通过，CI / DEPLOY / VERIFY 的缺陷仍是未知数。
4. **N-27 / N-28 / `fixTaskType` 校验**均未开工。
