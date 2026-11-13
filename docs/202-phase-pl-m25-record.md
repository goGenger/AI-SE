# 202 · PL-M25 实施记录（N-22 + N-23：`REPLAN` 的通道与交付契约）

> 阶段：**PL-M25**，用户 2026-10-20 授权「**后面的任务如果没有一定要我确认的你就按照推荐继续跑**」。
> 任务书：**`docs/199`（N-22）+ `docs/200`（N-23）**——两者**同批**，缺一不可。
> 依据：L1-M4n 批次（`docs/201`）的两个致败点。**实施前该批次已跑完**（run 3 落盘于 2026-10-21 00:30 CST）。
> **未在真实批次验证 ⇒ 不判「已关闭」**（记忆 [[fix-known-defects-before-batches]]）。

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `packages/shared/src/index.ts` | 修改 | 新增 `DELIVERY_TASK_TYPES`（`BUILD`/`DEPLOY`/`TEST`）与 `isDeliveryTaskType` |
| `packages/workflow-engine/src/WorkflowEngine.ts` | 修改 | ① `debugTargetType` 第 3 步之前加**交付类型短路**；② 新增 `failedTaskOutput` 并把任务失败路径改用它 |
| `packages/workflow-engine/src/WorkflowEngine.test.ts` | 修改 | 新增 `describe`×2（N-23 交付类型保持 ×4、N-22 判据 25e ×2） |
| `packages/agent-core/src/professional/outcomeSchema.ts` | 修改 | `SubmitResultSchema` 根上新增可选 `fixTaskType` |
| `packages/agent-core/src/professional/types.ts` | 修改 | `ProfessionalOutcome.fixTaskType?: string`（与 schema 同契约的两处表述，**必须同步**） |
| `packages/agent-core/src/professional/ProfessionalAgent.ts` | 修改 | 提示词：四个 `status` 各一句语义；`REPLAN` 要求带 `fixTaskType` |
| `packages/agent-core/src/professional/AgentRegistry.ts` | 修改 | 新增共享常量 `REPLAN_CONSTRAINT`，接到**六个** agent；qa 原有那句改用共享常量 |
| `packages/agent-core/src/professional/submitResult.test.ts` | 修改 | 新增 3 个用例（根字段接受 / 缺省合法 / `metadata` 仍容忍） |
| `packages/agent-core/src/professional/AgentRegistry.test.ts` | 修改 | 新增 1 个用例（六个 agent 都带指令 + planner 反向对照） |
| `apps/server/src/services/workflowTaskExecutor.ts` | 修改 | 抽出并导出 `resolveOutcomeFixTaskType` / `resolveOutcomeErrorType`，输出对象改用它们 |
| `apps/server/src/__tests__/outcomeRouting.test.ts` | **新增** | 8 个用例（两函数的正/负/边界） |
| `docs/199` / `docs/200` | 修改 | 实施时的**设计收敛**（见 §3.2 / §3.3） |
| `docs/202-phase-pl-m25-record.md` | **新增** | 本文件 |

---

## 2. Implementation

### 2.1 N-23：交付任务的类型不得被 replan 换掉

**`WorkflowEngine.ts` 的 `debugTargetType`**——在第 3 步之前插入：

```ts
  // N-23（`docs/200`）：交付任务的 `type` 是**平台契约**，不是「谁来做」的标签……
  if (isDeliveryTaskType(source.type)) {
    return { type: source.type, rejectedFixTaskType };
  }
```

**为什么位置是「第 3 步之前、第 1 步之后」**：见 §3.2——放在第 1 步之前会让 agent 的显式
`fixTaskType`（N-22 刚开的通道）被立刻无视，两个修复互相打架。

### 2.2 N-22：`REPLAN` 的通道与可归因性

四处协同，**缺一不可**：

1. **schema**（`outcomeSchema.ts`）：根上 `fixTaskType: z.string().optional()`——让它成为**契约**，
   而不是藏在无校验的 `metadata` 里。
2. **提示词**（`ProfessionalAgent.ts`）：四个状态各一句语义 + 「`REPLAN` 必须带 `fixTaskType`」。
3. **指令**（`AgentRegistry.ts`）：共享常量 `REPLAN_CONSTRAINT` 接到**六个**会报 `REPLAN` 的 agent。
4. **执行器**（`workflowTaskExecutor.ts`）：读**根** `fixTaskType`，回落 `metadata`；并给
   `REPLAN` 结果的失败补 `errorType`。

### 2.3 N-22 判据 25e 的加宽部分：失败码不再有两个来源

`WorkflowEngine.ts` 的任务失败路径原先写
`output: result.output ?? { error: result.error?.message ?? "Task failed" }`——
**事件**带 `errorCode`（`:736`），**任务 `output` 不带**。实测 L1-M4n run 2：`T7` 的事件是
`CI_FAILED`、任务 `output.errorType` 为空 ⇒ 4 个失败只报出 1 个。改用：

```ts
function failedTaskOutput(result: TaskExecutionResult): JsonObject {
  const output: JsonObject = { ...(result.output ?? {}) };
  if (output.errorType === undefined && result.error?.code !== undefined) {
    output.errorType = result.error.code;
  }
  if (result.output === undefined) {
    output.error = result.error?.message ?? "Task failed";
  }
  return output;
}
```

**已有 `errorType` 时不覆盖**（agent 侧给的码更具体）——有测试守住。

---

## 3. Architecture Changes

### 3.1 新增两个跨包导出（`packages/shared`）

`DELIVERY_TASK_TYPES` / `isDeliveryTaskType` 与既有 `WORK_TASK_TYPES` / `isWorkTaskType` 同处
（`AGENTS.md` §3：跨包共享类型归 `packages/shared`）。**不新增顶层目录、不新增包。**

### 3.2 设计收敛一：交付短路的**位置**（`docs/200` §7 第 5 项初稿被更正）

任务书初稿写「本条优先：交付类型覆盖 agent 的 `fixTaskType`」。**实施时改为 agent 优先**：

- 若交付类型覆盖 agent 的显式请求，**N-22 刚开的通道会被 N-23 立刻无视**——两个修复互相打架。
- 放在第 1 步之后，本条的保证范围是「**agent 没说话时保留契约**」，正是两个实例的形状
  （`T7-REPLAN-1` / `T8-REPLAN-1` 的 `fixTaskType` 都是空）。
- **已知代价**：agent 若为一个 CI 任务指定 `TEST`，交付契约仍会被放弃——那是 `docs/200` §7.1 的
  「两步修复」问题，**本批不解决**。测试里有一条正向用例把这个行为**钉住**
  （「agent 明确给出的 `fixTaskType` 仍然优先」）。

### 3.3 设计收敛二：`REPLAN_CONSTRAINT` 的**范围**（`docs/199` 判据 25c 被加宽）

任务书初稿写「全部**工作类** agent（四个）」。**实施时定为六个**：
backend / frontend / database / qa **+ reviewer + devops**。

理由：`reviewer-agent` 与 `devops-agent` **同样会报 `REPLAN`**（普查里 devops 有 1 次）。
只补四个等于把同一个洞留在另两处。`planner-agent` 不做工作、不改文件，**不背**（有反向对照断言）。

### 3.4 一处文档/代码冲突（**须报告，未擅自对齐**）

`AGENTS.md` §6 把 `agent-core` 列为「集中式测试的包：测试放 `src/__tests__/`」。
**实际不是**：该包 35 个测试文件里只有 **9** 个在 `src/__tests__/`，其余 26 个**与源码同目录**
（`planning/*.test.ts` 16 个、`professional/*.test.ts` 7 个等）。

⇒ 本批新增的用例**跟随实际惯例**（放进 `professional/`），**未**按 `AGENTS.md` §6 迁到 `__tests__/`
——`AGENTS.md` 首句写明「**代码优先于文档**，冲突须报告而不是默默对齐」。
**建议**：另立一项裁定 `AGENTS.md` §6 的 agent-core 归类（要么改文档，要么迁测试）。

---

## 4. Dependencies

**无新增、无升级、无删除。**

---

## 5. Tests

**新增 20 个用例**（全部通过）：

| 包 | 文件 | 新增 | 内容 |
| --- | --- | --- | --- |
| `workflow-engine` | `WorkflowEngine.test.ts` | 6 | 交付类型保持（BUILD/DEPLOY/TEST 各一）+ agent 的 `fixTaskType` 仍优先 + 失败码落 `output.errorType`（正/不覆盖） |
| `agent-core` | `submitResult.test.ts` | 3 | 根 `fixTaskType` 被接受 / 缺省仍合法（25g 负控）/ `metadata` 仍容忍 |
| `agent-core` | `AgentRegistry.test.ts` | 1 | 六个 agent 都带指令 + planner 反向对照 |
| `apps/server` | `outcomeRouting.test.ts`（新） | 8 | 两函数的正/负/边界（根优先、回落、空串与非字符串、`REPLAN_REQUESTED`、不覆盖） |

**包级门禁**：

| 包 | typecheck | lint | test |
| --- | --- | --- | --- |
| `@ai-se/shared` | ✅ | — | — |
| `@ai-se/workflow-engine` | ✅ | ✅ | **68 / 68**（4 文件） |
| `@ai-se/agent-core` | ✅ | ✅ | **255 / 255**（35 文件） |
| `@ai-se/server` | ✅ | ✅ | **326 / 326**（51 文件，见 §6） |

**N-23 的负控**：既有 PL-M18 的三条用例（REVIEW → 工作类型）**全部保持绿色**——
本批**没有**动 `fixWorkTargetType`，只加了一道前置短路。

**全仓门禁（阶段收尾）**：

```
corepack pnpm -r run typecheck   -> exit 0
corepack pnpm -r run lint        -> exit 0
corepack pnpm -r run test        -> exit 0   全绿
```

`-r test` 逐包（15 个包、**1,864 用例，零失败**）：`eval` 59 · `shared` 168 · `evidence` 9 ·
`visual` 83 · `failure-recovery` 16 · **`workflow-engine` 68** · `web` 505 · `sandbox` 8 ·
`tool-runtime` 32 · `action-policy` 13 · **`agent-core` 255** · `browser` 38 · `mcp` 235 ·
`database` 47 · **`server` 326**。

⇒ §6.1 的抖动在**全仓这一次跑里没有复现**（server 326/326）。

---

## 6. Known Issues

### 6.1 全量 server 套件**不是确定性的绿**（一次已记录的抖动，非本批引入）

| 轮次 | 结果 | 备注 |
| --- | --- | --- |
| 1 | **325 / 326** | `v1GoldenScenario.e2e.test.ts` 的「server restart」用例 `waitFor timed out`（30s） |
| 2 | **325 / 326** | 同上 |
| 单独复跑该用例 | **通过**（3.39s） | `-t "server restart"` |
| 3 | **326 / 326** | 全量，35.61s |
| 4 | **326 / 326** | 全量 |

**判断：负载敏感的时序抖动，不是本批改动。** 三条依据：

1. **该用例不在本批改动的路径上**：它用**自己的 `crashExecutor`**（一个永不 settle 的 Promise 让
   「旧进程死在任务中」），策略是 `failureStrategy: "FAIL_FAST"` / `allowReplan: false` ⇒
   `debugTargetType` **根本不被调用**；等待窗口内 A 成功、B 挂起，**没有任何任务失败** ⇒
   `failedTaskOutput` 也不被调用；它不使用职业 agent ⇒ agent-core 的三处改动同样不可达。
2. **单独复跑 3.39s 通过**，全量下 30s 超时——差别在负载。
3. 第 3、4 轮全量**连续两次全绿**。

**⚠️ 诚实标注**：该用例**不在** `docs/144` #9 / `docs/145` #7 已记录的抖动清单里，是**新观察**。
按仓库既定做法（「单独复跑通过即记为该族」）处理，**未弱化任何测试**。
**建议**：把它补进该抖动清单，并考虑给这个 Docker+Chromium 用例放宽超时或标记为串行。

### 6.2 未在真实批次验证

判据 **26d**（replan 后的 CI 任务写下 `ci_runs`）与 **25f**（`REPLAN` + `fixTaskType` 产出指定类型）
**只能在下一批测**。**本批不判「已关闭」。**

### 6.3 `docs/200` §7.1 的「两步修复」问题仍未解决

「CI 任务因过期测试失败」需要**先改测试、再重跑 CI**，而 `replan()` 只造一个 retry 任务。
本批**不解决**（已登记、不立项）。**因此不得声称「修完这两件，run 2 那条链会收敛」。**

### 6.4 `AGENTS.md` §6 的 agent-core 归类冲突（§3.4），未擅自对齐。

---

## 7. E2E

**本阶段未跑真实批次**（`docs/201` 的 L1-M4n 已在本阶段开工前跑完）。
下一批是这两个修复的真实检验场，主判据见 `docs/199` §3（25f/25g）与 `docs/200` §3（26a–26f）。

---

## 8. Acceptance Result

**本阶段的交付物是「两个缺陷的修复 + 20 个用例 + 包级门禁全绿」，已全部给出。**
`workflow-engine` 68/68、`agent-core` 255/255、`server` 326/326（第 3、4 轮）；
typecheck / lint 三个包全绿。

**但按本仓库的记账纪律，两者均判「已实施、未在真实批次验证」，不判「已关闭」。**

---

## 9. Next Phase Boundary

**未开始事项（STOP）**：

1. **PL-M25 的真实批次检验未做**——须另开一批 E1×3（消耗周配额，开工前确认余量）。
   **该批次不得与 L1-M4n 的读数逐字比较**：本批改了作用域命令之外的**路由**行为，
   且新增了 `REPLAN_REQUESTED` 错误码与 `output.errorType` 的落盘方式（§2.3）⇒
   **`errorTypes` 的分布必然变化**，须预先声明到具体指标。
2. ~~**`docs/17` 的 12 项 V1 Real AI Validation 仍未勾选**（`docs/198` §14 第 1 项）。~~
   **已完成（2026-10-21）**：11 项勾 `[x]` 并附读数与 `file:line`，第 12 项按「部分行使」
   **保持未勾**（`docs/198` §16.5）。**同次发现新缺口**：该节的三个子节
   （Dynamic Workflow 6 / AI Decision Validation 5 / External Environment 6）
   **不在 `docs/198` 普查范围内**，已留空并写明 STOP ⇒ **子节普查待另起**（见下方第 9 项）。
3. **token 记账缺口未修**——**已更正为一条**（规划段）。`docs/198` §16.4 勘误：
   「交付编排」那条**不成立**（`deploymentOrchestrator.ts` 零模型调用，无 token 可记），
   原登记是从库内形状倒推的误判。规划段那条**比原文更严重**（整条规划流水线从未采集用量）。
   **已立任务书 `docs/206`（N-25）**，含机制四层 `file:line`、修法设计、判据 28a–28e。
   **裁定 1：留到 L1-8 验收批次跑完后实施**（在批次前改会污染该批的用量读数与归因）。
4. **「两步修复」问题未立项**（`docs/200` §7.1）。
5. **`docs/` 写范围未立项**（`docs/201` §10.3，缺致败实例）。
6. **`AGENTS.md` §6 的 agent-core 归类冲突未裁定**（§3.4）。
7. ~~**全量 server 套件的抖动清单未更新**（§6.1）。~~ **已完成（2026-10-21）**：
   `v1GoldenScenario.e2e.test.ts` 的「server restart」用例已按「单独复跑通过即记为该族」
   补入 `docs/145` §七 追加块（该文件是冻结的历史记录，故**只追加不改正文**）。
   **建议（未做）**：给该 Docker + Chromium 用例放宽超时或标记为串行。
8. ~~**`docs/146` §3 / §5 尚未回填本阶段**。~~ **已完成**（`docs/146` 头部链与 §5 均已回填，
   状态格为「已实施、未验证」）。
9. **`docs/17` §V1 Real AI Validation 的三个子节未普查**（本次新识别）——
   Dynamic Workflow 6 项 / AI Decision Validation 5 项 / External Environment 6 项。
   **收口动作**：另起一次只读普查（同 `docs/198` 口径）后再勾，**不凭推断补勾**。

