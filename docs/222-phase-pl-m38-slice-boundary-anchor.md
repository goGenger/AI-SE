# 222 · PL-M38 实施记录（N-35：replan 已解决的失败不再吞掉切片边界检查）

> 阶段：**PL-M38** ｜ 缺陷登记：`docs/146` §3 N-35 ｜ 发现场：`l1-m4t` 的 `DATABASE×1` 调查
> 用户 2026-10-22 指令「修 N-35」。

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `packages/workflow-engine/src/index.ts` | 修改 | 导出 `isFailureResolved` / `unresolvedFailedTasks` / `hasUnresolvedFailure`（PL-M19 已有的唯一「已解决」判定） |
| `apps/server/src/services/taskVerifier.ts` | 修改 | `maybeSliceBoundaryCheck` 的锚点判定：由「兄弟任务 `status !== "SUCCESS"` 即不跑」改为「兄弟任务未收尾即不跑」，其中 `FAILED` 一律问 `isFailureResolved` |
| `apps/server/src/__tests__/taskVerifier.test.ts` | 修改 | **+3 条用例**（66 → 69） |
| `docs/222-phase-pl-m38-slice-boundary-anchor.md` | 新增 | 本文件 |

**零依赖、零 migration、零数据库改动、零新概念。**

---

## 2. Implementation

### 2.1 缺陷（机制 + 三分片对照 + 全库普查）

```ts
// 旧：apps/server/src/services/taskVerifier.ts
const anchorSiblings = sliceTasks.filter(
  (entry) => entry.id !== task.id && !hasDeliveryBlock(entry)
);
if (anchorSiblings.some((entry) => entry.status !== "SUCCESS")) return null;
```

`replan()` **不改源任务行的 `status`**——它把 `resolvedByTaskId` 指向下一层的 retry 任务，retry 是
**另一行新任务**（`source_task_id` 指回源码）。于是：**任何发生过 replan 的切片，源任务行永远是
`FAILED`** ⇒ 锚点判定恒为「未收尾」⇒ **整片拿不到边界检查**。

**批次内三分片互相对照**（`l1-m4t`，同一份计划、同一套代码）：

| 工作流 | 本切片有 FAILED？ | 边界检查 | 判定 |
| --- | --- | --- | --- |
| run 1 `be352ed8`（slice-3） | 否（失败在 slice-2） | `verified` | 跑了 |
| run 2 `faa2b6e5`（slice-3） | 否（失败在 slice-1/2） | `failed` | 跑了 |
| **run 3 `4f061d31`（slice-3）** | **是（`T05`、`T09`）** | **不存在** | **没跑** |

**全库普查**（`tasks` 按 `workflow_run_id` 聚合，`output.verification.checks` 含 `slice-boundary`）：

| 工作流集合 | 有边界检查 | 无边界检查 |
| --- | --- | --- |
| 含 FAILED 任务（**169**） | 24 | **145（86%）** |
| 不含 FAILED 任务（105） | 92（88%） | 13 |

**这条缺陷的严重度会随已修缺陷上升**：N-29（DEBUG 交接）与 N-11（REPLAN 策略）让 replan 成为常态，
replan 越正常，边界检查越少。**「修好 A 让 B 显形」**，与 `docs/146` 记的
`coverage-fixes-look-like-regressions` 同一类，但方向相反：不是数字变差，而是**一道门静默消失**。

### 2.2 改动

```ts
const byId = new Map(tasks.map((entry) => [entry.id, entry]));
const unfinished = anchorSiblings.some(
  (entry) =>
    entry.status !== "SUCCESS" &&
    !(entry.status === "FAILED" && isFailureResolved(entry, byId))
);
if (unfinished) return null;
```

`isFailureResolved` 是 PL-M19（`docs/186`）为 N-12 建的**唯一**「失败是否已被解决」判定：
沿 `resolvedByTaskId` 链走到头，尽头 `SUCCESS` ⇒ 已解决；断链 / 成环 / 尽头仍失败 ⇒ 未解决
（fail-closed），深度由策略的 `maxRetries` 界定、不写死层数。

**为什么不是自己写一个 `status === "FAILED" && resolvedByTaskId`**：那会造出**第二套**「已解决」定义。
`docs/160`（PL-M10 / PL-M12）已经记过这一成因——两份定义必然漂移。本次是把 PL-M19 的判定**上移到包导出**，
让消费方复用它，而不是各写一份。

**`BLOCKED` / `CANCELLED` / 仍在跑的一律仍算未收尾**（`isFailureResolved` 只对 `FAILED` 生效，
外层 `entry.status !== "SUCCESS"` 仍然拦住其余状态）——切片真坏掉时边界检查照旧不跑。

---

## 3. Architecture Changes

**无新增抽象。** 唯一的结构变化是 `@ai-se/workflow-engine` 的 `index.ts` 多导出了三个既有函数
（原本只在包内使用）。`apps/server` 已依赖该包，未新增依赖边。

---

## 4. Dependencies

**无新增、无升级、无删除。**

---

## 5. Tests

**`taskVerifier.test.ts` 新增 3 条**（66 → 69，全绿）：

| 用例 | 断言 |
| --- | --- |
| 兄弟任务 `FAILED` 但已被 replan 救回 | 边界检查**存在**、`passed === true`、`scopedAcKeys === ["AC-01","AC-02"]` |
| 负控：replan 自己也失败（链走到头仍未解决） | 边界检查**不存在** |
| 负控：兄弟任务仍在 `RUNNING` / 无指针的 `FAILED` | 边界检查**不存在** |

第一条是主判据；后两条防止「为了修好主判据而把切片未收尾的情况也放行」。
**既有 66 条全绿**——特别是原有的 `切片边界检查同形` 与 N-26 三条。

**全量 `apps/server`（52 文件 / 354 条）跑了两次**：

| 次 | 结果 |
| --- | --- |
| 第 1 次 | **353/354**——`v1GoldenScenario.e2e.test.ts > server restart` 的 `waitFor timed out`（30s） |
| 单文件复跑 | **4/4 通过** |
| 第 2 次 | **354/354 全绿** |
| **全仓 `-r test`** | 同一用例**再次**在并行负载下超时（`apps/server` 其余 353 条全绿），其余 15 包全通过 |

**已排除与本改动相关**：该用例用的是 `crashExecutor`（假 executor），等的是「任务 A SUCCESS 且 B RUNNING」，
**不经过 `TaskVerifier`**，本改动在它的路径上不存在。判定为 `docs/145` #7 / `docs/149` / `docs/155` /
`docs/160` 记录的**负载敏感 flake**（全量并行时 30s 可能不够）——**未改测试、未放宽断言**。

---

## 6. Lint

- `eslint src/services/taskVerifier.ts src/__tests__/taskVerifier.test.ts` → **exit 0**
- `--filter @ai-se/workflow-engine lint` → **exit 0**

## 7. Typecheck

- `tsc -p tsconfig.json --noEmit`（`@ai-se/server`）→ **exit 0**
- `--filter @ai-se/workflow-engine build`（含 `tsc`）→ **exit 0**
- `--filter @ai-se/workflow-engine test` → **68/68**

---

## 8. E2E

**未做批次验证**（下一批要等配额窗口 2026-10-25 23:00 UTC）。

判据：

| 判据 | 内容 |
| --- | --- |
| **38a** | 含 replan 的切片出现 `slice-boundary` 检查（本批三例：run 3 的 slice-3 应当首次出现） |
| **38b** | 「含 FAILED 工作流的边界检查覆盖率」从 **24/169（14%）** 明显上升 |
| **38c** | **假阳性率保持 0**——边界检查是真跑测试，不放宽任何判定 |

**为什么单列 38c**：这是一次**收紧**（多跑一道门）。按 `docs/146` 的经验，收紧后数字可能变差，
这正是门在起作用；但**假阳性率不应对它敏感**，因为它不改变任何 `passed` 的判定规则。

---

## 9. Known Issues

1. **边界检查会多跑一次测试**：含 replan 的切片现在会跑边界检查，单切片多一次全量测试。
   在 N-34（PL-M35）落地后单次成本已从 120s 降到个位数秒，故可接受；若其后仍见 `CHECK_TIMEOUT`
   堆积，需再看。
2. **「无 FAILED 却也没有边界检查」的 13 个工作流——已查清（2026-10-22）**。
   所属需求：**E1×10、M1×1、S1×1、S3×1**，全部 SUCCESS、全部无交付任务，创建日期集中在
   **10-07 … 10-18**（**10-19 之后一批都没有**）。逐条机制：

   | 机制 | 工作流 | 数量 |
   | --- | --- | --- |
   | **早于该特性**（`SLICE_BOUNDARY_CHECKED` 最早出现于 **10-09 10:04**） | `ba500ded`（10-08） | 1 |
   | **`sliceAcKeys` 为空**——任务全都没有 `acKeys`，`taskVerifier.ts:1231` 早退 | `0a1f807d`、`0ec0e82d`、`25af2aaf`、`408e0089`、`89d118c8` | 5 |
   | **最后一次验证时工作区没有 `test` 脚本**——`scriptText === ""`，`taskVerifier.ts:1202` 早退 | `252f17db`、`b5a190ad`、`a0ea1e1c`、`ebb2e0e6` | 4 |
   | **任务没有验证记录**（6~7 个任务里只有 2~4 个被验证，边界只能由「被验证的任务」触发） | `3a55451c`、`49961fe5`、`ba142a27` | 3 |

   证据要点：`b5a190ad` 的 `TEST-1` 在 19:03 拿到 `test` 检查、其余 6 个任务在 19:10 全部
   `unavailable`（当时 `build`/`test` 两个脚本都不可用）⇒ 最后一次验证时 `scriptText` 为空。

   **结论：这 13 个不是活跃的策略洞**——全是「数据年代」（早于 AC 关联 / 早于特性）或
   「工作区确实没有测试脚本」（此时不跑边界检查是正确语义）。
   **10-19 之后没有新的此类实例**，近期的缺口由 N-35（本条缺陷）解释。
3. **本次不修 N-1b**（DATABASE 任务无迁移脚本即零检查）。两者相邻但独立：N-1b 是**任务类型适用性**，
   N-35 是**边界检查的锚点判定**。N-1b 修好之前，DATABASE 任务仍可能整片无检查——
   但边界检查恢复后至少有了第二道兜底。

---

## 10. Acceptance Result

交付物是「1 处判定改动 + 1 个包导出 + 3 条用例 + 包级门禁全绿」。

判 **「已实施、单测验证通过、批次验证待下一批」**，**不判「已关闭」**。

---

## 11. Next Phase Boundary

**未开始事项（STOP）**：

1. **38a / 38b / 38c 待下一批**（需重建 + 重启平台）。
2. **N-1b**（DATABASE 类型适用性）**未修**——修法已有推荐（无迁移脚本时回退 `build`+`test`），
   其中一个设计选择待定：只在迁移脚本**完全缺失**时回退，还是缺一半也回退（推荐前者）。
3. **13 个「无失败也无边界检查」的工作流**未查。
4. **全仓 `-r` 门禁**在本阶段收尾前重跑一次。
