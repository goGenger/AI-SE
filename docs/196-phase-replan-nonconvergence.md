# 196 · 「replan 不收敛」判定（结论：**登记机制不成立，不实施**）

> 立项：2026-10-20。用户指令「按你的推荐，开工 ③」（③＝已登记缺陷清单第 3 项「replan 不收敛」）。
> 基线：`docs/194`（N-20）、`docs/195`（N-15′）。登记处：`docs/189` §9.3 / `docs/127` §375 / `docs/187` §2.5 第 2 项。
> 状态：**判据未落地。本文件记录「为什么不做」，连同可复现的库内普查。**

---

## 1. 登记说的是什么

`docs/187` §2.5 第 2 项（原话）：

> **replan 路由不收敛**（`WorkflowEngine.ts:90-91`）：`fixWorkTargetType` 在源任务已是工作类型时
> **原样返回**。于是「缺陷在 `tests/`、要交给 TEST agent」的意见被 replan 成**又一个 BACKEND**
> ——而 BACKEND 写不了 `tests/`。评审自己写了 `tests/ is outside the allowed backend paths`，
> 循环只能重复这句话。

⇒ 登记的机制是**类型路由错**：重试任务与源任务同类，而那一类做不了这件事。

`docs/189` §9.3 登记的现象（L1-M4m run 3）：

> run 3 的 `TASK-007-REPLAN-1-REPLAN-2` 仍 FAILED；`TASK-008/009/010-REPLAN-1-DEBUG-2`
> 在工作流判 FAILED 时仍停在 `READY`，`…-REPLAN-1-REPLAN-2` 停在 `PENDING`。

---

## 2. 实测：机制不成立

### 2.1 全库普查：13 条深度 2 的 replan 链，1 条收敛

```sql
WITH chain AS (
  SELECT workflow_run_id, task_key, type, status,
         output->'verification'->>'reason' AS reason,
         output->'verification'->'checks'->1->>'failureCode' AS fc,
         replace(replace(task_key,'-REPLAN-2',''),'-REPLAN-1','') AS base
  FROM tasks WHERE task_key LIKE '%REPLAN-%'
)
SELECT … FROM chain c2 JOIN chain c1 ON 同工作流 AND 同 base
WHERE c2.task_key LIKE '%-REPLAN-2' AND c1.task_key LIKE '%-REPLAN-1';
```

13 条链里**只有 1 条收敛**（`bb5f0610` 的 `T-05`：REPLAN-1 FAILED → REPLAN-2 SUCCESS）。

### 2.2 失败原因：**全部是 N-13 的作用域命令挂死**，没有一条是路由

对 `32e4d903` / `8b92fc3e` / `d9119cf4` / `bf51cf12` 四条链的**每一条失败检查**逐行核对：

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `command LIKE '%--test-name-pattern%'` | **t**（全部） | 是**作用域**测试命令 |
| `exitCode` | **null**（全部 `test` 检查） | 命令**没有正常退出**——被沙箱掐掉 |
| `command LIKE '%--test-timeout%'` | **f**（全部） | 这些工作流**早于 PL-M20**，命令里根本没有每文件超时 |

⇒ 这是 **N-13 的修前形态**：`node --test --test-name-pattern '…'` 在「零匹配测试的文件」上挂死。
批次的 `reason` 把它读成 `checks failed: test`，**但 `exitCode` 是 null**，不是真的断言失败。

`8b4b1811`（登记点名的那个工作流）更直接：它的命令**已带** `--test-timeout=100000`（PL-M20 之后），
于是同一件事以 **`CHECK_TIMEOUT`** 的形态出现：

| 任务 | `test` 检查 |
| --- | --- |
| `TASK-007`（**原任务**） | `exitCode 1` —— 真实的测试失败 |
| `TASK-007-REPLAN-1`（**重试**） | **`CHECK_TIMEOUT`** —— 挂死 |
| `TASK-007-REPLAN-1-REPLAN-2`（**再重试**） | **`CHECK_TIMEOUT`** —— 挂死 |

**原任务与重试失败的原因不同**：原任务是真实红灯，两次重试是**挂死**。
⇒ 这条链不收敛的原因**不是路由**，是 **N-13**——而 N-13 已由 **PL-M20 + PL-M24 (1)** 修复（`docs/188` / `docs/192`）。

### 2.3 登记的机制在登记点名的链里**从未触发**

`debugTargetType`（`WorkflowEngine.ts:63-78`）的解析顺序是：

1. `source.output.fixTaskType` **可用** ⇒ **用它**（agent 自己说的修复类型）；
2. 否则源任务若是 DEBUG 且 `input.targetTaskType` 可用 ⇒ 继承；
3. 否则 `isWorkTaskType(source.type) ? source.type : fixWorkTargetType(...)` ← 登记点名的 `:90-91`

**第 1 步在第 3 步之前**——所以「源任务是工作类型 ⇒ 原样返回」**不可能覆盖** agent 明确给出的
`fixTaskType`。而 `8b4b1811` 里：

| 任务 | `output.fixTaskType` |
| --- | --- |
| `TASK-007` / `TASK-008` / `TASK-009` / `TASK-010` | **空** |
| 全部 `-DEBUG-1` / `-DEBUG-2` | **空** |
| 全部 `-REPLAN-1` / `-REPLAN-2` | **空** |

⇒ 第 1、2 步都没命中，走的是第 3 步；源任务是 BACKEND ⇒ BACKEND。
**这恰恰是 `fixWorkTargetType` 注释里写明的有意行为**：「源任务自己已经是工作类型 ⇒ 原样
（**照旧重试同一类工作**）」。

### 2.4 诊断通道是**通的**，不是「循环只能重复这句话」

重试任务依赖 DEBUG 任务（`WorkflowEngine.ts:1002` 的 `debugId → retryId`），而
`taskContextBuilder.ts:83-102` 把**依赖任务的输出**放进 `dependencyResults`。
实测 DEBUG 任务的诊断**具体、带证据、还给了重试指引**：

> 「…the AC-01 work had already been delivered by TASK-001, so an Implement retry has nothing to
> add and any attempt to re-create the routes is a no-op… **Root cause of the earlier failures is
> process, not code**… Retry guidance: verify only, using `node --test`…」

**诊断是对的。** 重试仍然失败，是因为它跑的那条作用域命令**挂死了**——不是因为它不知道发生了什么。

---

## 3. Modified Files

| 文件 | 动作 |
| --- | --- |
| `docs/196-phase-replan-nonconvergence.md` | **新增**（本文件） |
| `docs/189` / `docs/127` / `docs/146` | 改：登记行与台账追加判定 |

**零 `src/` 改动、零测试改动、零依赖改动。** 按文件清单核对：`apps/` 与 `packages/*/src/` 下无源文件变更。

---

## 4. Implementation

**无。** 这是一次**否决**，不是一次实施。登记的机制在 §2 被库内普查推翻，故**不写入代码**。

---

## 5. Architecture Changes

**无。**

---

## 6. Dependencies

**无新增、无升级、无删除。**

---

## 7. Tests / Lint / Typecheck / E2E

**均未运行**——本批**零代码改动**，没有需要门禁的对象。按 `AGENTS.md` §7 的口径如实标注：**不适用**。

可复现的实测命令（离线、零配额、只读）：

```bash
set -a; source .env; set +a
# ① 13 条深度 2 的 replan 链及各自的终态
docker exec -i ai-se-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
WITH chain AS (
  SELECT workflow_run_id, task_key, type, status,
         output->'verification'->>'reason' AS reason,
         output->'verification'->'checks'->1->>'failureCode' AS fc,
         replace(replace(task_key,'-REPLAN-2',''),'-REPLAN-1','') AS base
  FROM tasks WHERE task_key LIKE '%REPLAN-%')
SELECT c2.workflow_run_id, c2.base, c1.status AS s1, c1.fc AS fc1, c2.status AS s2, c2.fc AS fc2
FROM chain c2 JOIN chain c1 ON c1.workflow_run_id=c2.workflow_run_id AND c1.base=c2.base
WHERE c2.task_key LIKE '%-REPLAN-2' AND c1.task_key LIKE '%-REPLAN-1';"

# ② 每条失败检查的形状（scoped? exitCode? 有 --test-timeout 吗）
docker exec -i ai-se-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT task_key, c->>'name', c->>'exitCode', c->>'failureCode',
       (c->>'command' LIKE '%--test-name-pattern%') AS scoped,
       (c->>'command' LIKE '%--test-timeout%') AS has_timeout
FROM tasks, jsonb_array_elements(output->'verification'->'checks') c
WHERE c->>'passed'='false';"

# ③ 登记链里 fixTaskType 是否为空
docker exec -i ai-se-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT task_key, type, status, output->>'fixTaskType' FROM tasks
WHERE workflow_run_id='8b4b1811-145d-4a68-944d-1084cd2231c8' ORDER BY task_key;"
```

---

## 8. Known Issues

1. **「replan 不收敛」不判「已修」，也不判「不存在」——判「已登记机制不成立」**，并**转为下一批的
   复核项**：N-13 修复后（PL-M24 (1)）重跑一批，再普查同样的 13 条形状。若仍不收敛，**那才是
   新的、未解释的缺陷**，届时须重新立项。
2. **本次没有证明「replan 会收敛」。** 只证明了**已知的 12 条不收敛链全都归因于 N-13**。
   N-13 修好后是否收敛，**未测**。
3. **一个仍然活着的候选（未登记，缺实例）**：`backend-agent.writePaths = ["apps/server","server","backend","src"]`
   （`AgentRegistry.ts:142`），**不含 `test`/`tests`，也没有 `writeTestFiles`**；而 `qa-agent` 有
   `writeTestFiles: true` 且被要求「report … a **fixTaskType**」（`:186`）。⇒ 一条 **QA 失败、
   修法落在测试文件**的链，会被路由到**写不了测试文件**的 agent。这与 `docs/187` §2.5 第 2 项的
   **意图**一致，也属 `write-scope-family-recurs`（已复现五次的同一族）。
   **但库内没有一条实例把它证成致败点**——按 [[defect-registration-needs-code-proof]]，
   **不登记**，只留此条备查；下一批复核时一并看。
4. **一处跨引用（不改结论，只记事实）**：`AgentRegistry.ts:80-83` 的 `WRITE_DENIAL_CONSTRAINT`
   注释里写着「…而 **replan 目前并不收敛（`docs/189` §9.3）**——那只会让链更早断」。
   那是 N-19 裁定（只记录、不判死）的**理由之一**，而该理由所依据的前提**已被本文件修正**。
   N-19 的**结论**（如实说明、不判死）仍可独立成立，**本文件不重开 N-19**；但该注释的前提
   已过时，**待下一批复核后再决定是否更新措辞**（改它属 N-19 的范围，不属本项）。
5. **本判定依赖 Node / 平台当时的 TAP 与检查形状**；若 PL-M24 之后作用域命令的行为再变，
   **须重新普查，不能沿用本文件的结论**。
6. **历史任务记录不回填**（33 条 DEBUG `unavailable` 之类同理）：修前落盘的失败形状是当时的
   观测记录，按 `docs/146` §6 规则 7 冻结，勘误只以追加块登记（本文件即该追加块）。

---

## 9. Acceptance Result

**NOT APPLICABLE（登记的机制不成立，任务被否决）。**

用户指令是「开工 ③」。**本批的交付物是「登记机制不成立的判定与证据」，不是实现。**
按记忆 [[verdict-rules-need-a-census]] 的同一条纪律：**先普查，再决定改不改**——
普查结果是「已知的不收敛全部由另一个已修缺陷解释」。

**这不是「没做完」，是「做实了不做」。** 若仍要落地一条路由侧的改动，须先回答：
**在 N-13 已修的前提下，重试还会因为什么不收敛？** 目前**没有任何库内实例**支持这个前提。

---

## 10. Next Phase Boundary

**未开始事项（STOP）**：

- **「replan 不收敛」未实施**，且**转为下一批的复核项**（见 §8 第 1 条）。
- **本次登记但未修的 1 项**：**agent 600s 墙上超时**（已登记缺陷清单第 4 项）。
- **本次新留备查 1 条**（缺实例，未登记）：QA 失败 → 路由到写不了测试文件的 BACKEND（§8 第 3 条）。
- **N-20 附带的口径待裁决 1 项仍未裁定**：`errorTypes` 是否应限定 `status = FAILED`
  （**推荐值：维持现状**，见 `docs/194` §13）。
- **N-18 / N-19 / PL-M24 (1) / N-20 / N-15′ 均未在真实批次验证。**
- **PL-M24 (1) 的探针仍未入库**（`docs/192` Known Issue 6）：`/tmp/n13-e1/runner.mjs` 须先落为
  `apps/server/scripts/probe-n13-e1-workspace.ts`，再开下一批。
- **未跑任何批次**；下一批开工前仍须先**停并重启 `:47558`**，并先跑 `deniedPaths` 普查。
