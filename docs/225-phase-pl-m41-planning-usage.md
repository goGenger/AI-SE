# 225 · PL-M41 实施记录（N-25：规划段用量采集）

> 阶段：**PL-M41** ｜ 任务书 `docs/206`（2026-10-21，三项裁定已定）｜ 用户 2026-10-23 选择实施
> 任务书 §7 裁定 1：「留到 L1-8 验收批次跑完后实施」——**L1-8 已于 2026-10-23 达成**（`docs/224`），本项到期。

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `packages/agent-core/src/planning/PlanningModel.ts` | 修改 | `PlanningModelRequest` 增 `onUsage?` 回调；新增 `addTokenUsage`（累加，唯一实现） |
| `packages/agent-core/src/planning/LangChainPlanningModel.ts` | 修改 | `handleLLMEnd` 回调取 `usage_metadata`，每次模型调用报一次 |
| `packages/agent-core/src/planning/PlanningGraph.ts` | 修改 | `PlanningGraphOptions` 增 `onTokenUsage`；`generateWithRepair` 把它传给模型请求 |
| `packages/agent-core/src/planning/PlanningAgent.ts` | 修改 | 累计用量；`PlanningAgentResult` 增 `tokenUsage`；**成功与失败两条** `onRunFinished` 都带上 |
| `packages/agent-core/src/__tests__/planningUsage.test.ts` | 新增 | **4 条用例**（28a / 28b / 28c 的算术 / 28d） |
| `packages/agent-core/src/__tests__/langChainPlanningModel.test.ts` | 修改 | **+1 条**（28c：解析失败那次也要报用量） |
| `packages/eval/scripts/l1-m4v-e1-x3.sh` | 修改 | 预先声明 28e 的口径变化（守卫从此看得见规划段），守卫上限提至 1400M；平台前置改为 pid 42567（载 N-25） |
| `packages/eval/scripts/l1-m4v-stop.sh` | 新增 | **收尾时才发现它此前并不存在**（交接记录误记为已建）。按 `stop-batch-cancels-workflow` 纪律补建：杀角色 **＋** 取消服务端工作流，缺了它用户无法安全停批 |
| `docs/225-phase-pl-m41-planning-usage.md` | 新增 | 本文件 |

**零依赖、零 migration、零新增记账字段**（沿用既有 `agent_runs.token_usage`）。

---

## 2. Implementation

### 2.1 缺陷（任务书 §1/§2 已逐层指到 `file:line`）

规划段跑的是**真模型**，但 807 次 `planning-agent` run 的 `token_usage` **全空**——
从模型接口到落盘路径三层缺位。影响：**周用量守卫与 eval 指标都看不见规划段的花费**，
而规划恰恰是全流程提示词最长的一段。

### 2.2 **与任务书设计的偏离（重要）**

任务书 §3.1 的方案是：把 `generateStructured` 的返回类型改成**带用量的信封**
（`{ value, tokenUsage }`）。**实施时发现这个方案拿不到 28c 要的那部分用量**：

> `OutputParserException` 的字段只有 `llmOutput?: string` / `observation?` / `sendToLLM`
> （`@langchain/core/dist/output_parsers/base.d.ts:102-107`）——**不含用量**。
> 而重采样循环正是「解析失败 → 再调一次」，失败那几次的消耗**在返回路径上不可见**。

**改用 LangChain 回调**：`structured.invoke(messages, { callbacks: [{ handleLLMEnd }] })`。
`handleLLMEnd` 在**模型调用结束**时触发，与后续解析成败无关 ⇒ 失败的重采样也能计上。

| 任务书设计 | 实际实施 | 差异 |
| --- | --- | --- |
| 返回类型改信封 | **返回类型不变**（仍是 `Promise<unknown>`） | 侵入更小：`PlanningGraph` 的调用点、`LivePlanningModel` 的转发都不用改 |
| 从 `includeRaw` 取 `raw.usage_metadata` | 从 `handleLLMEnd(output).generations[0][0].message.usage_metadata` 取 | 同样拿到 LangChain 的 `usage_metadata`，但**覆盖解析失败的那次** |
| 逐阶段聚合 | 回调逐次累加（`addTokenUsage`） | 语义相同，实现更直接 |

**这是对任务书手段的实质更正，不是偏离目标**——判据 28a–28e 一条未改。按 `docs/165` 的先例记录。

### 2.3 落地路径

```text
LangChainPlanningModel.generateStructured
  → invoke(..., { callbacks: [{ handleLLMEnd }] })
  → request.onUsage(usage_metadata)                 [每次模型调用一次]
PlanningGraph.generateWithRepair
  → 把 options.onTokenUsage 作为 onUsage 传下去
PlanningAgent.run
  → tokenUsage = addTokenUsage(tokenUsage, usage)   [本地累加，try 之外声明]
  → onRunFinished({ …, tokenUsage })                [成功与失败都带]
  → PlanningAgentResult.tokenUsage
apps/server 的 agentRunService
  → agent_runs.token_usage                          [既有写入通道，未改]
```

**失败的 run 也带用量**：累加器声明在 `try` **之外**，`catch` 分支读得到——「失败也花了钱」（28b）。

---

## 3. Architecture Changes

**无新增抽象、无新增字段体系。** 只给 `PlanningModelRequest` 加了一个可选回调，
沿既有 `tokenUsage` 字段落盘（`AGENTS.md` §10：禁止第二套记账）。

---

## 4. Dependencies

**无新增、无升级、无删除。**

---

## 5. Tests

**`agent-core` 261 → 266（+5）**，全绿。

| 用例 | 判据 | 断言 |
| --- | --- | --- |
| `addTokenUsage` 累加 | 28c 的算术 | 数值相加、`input_token_details` 递归相加；非数值字段（`model`）不相加 |
| 成功 run 带累计用量 | **28a** | `result.tokenUsage` = 单次 × 模型调用次数；`onRunFinished` 收到同一份 |
| 失败 run 带用量 | **28b** | 模型第 1 次调用后抛错 ⇒ `status ≠ succeeded` 且 `tokenUsage` 仍在 |
| 脚本化模型不报用量 | **28d** | `ScriptedPlanningModel` 的 run `tokenUsage` 为 `undefined`（不造假值） |
| `LangChainPlanningModel` 每次调用都报 | **28c** | 第一次解析失败也报；两次累计 `[100/10, 200/20]` |

**28e 是批次判据**（守卫读数只增不减），见 §8。

---

## 6. Lint / 7. Typecheck

**按包门禁**：

- `--filter @ai-se/agent-core lint` → **exit 0**
- `--filter @ai-se/agent-core typecheck` → **exit 0**
- `--filter @ai-se/server` 的 `tsc --noEmit` → **exit 0**（接口是可选字段，调用点无需改）
- `@ai-se/agent-core build` → dist 已重建（09:37）；平台重启为 **pid 53988**（09:47:39，`/health` 200）

### 6.0 一处必须先修的启动顺序缺陷（收尾时发现）

第一次重启发生在 **09:35:59**，而 dist 是 **09:37** 才重建的——**进程加载的是旧代码**。
`@ai-se/agent-core` 的 `package.json` 是 `main: dist/index.js`，平台虽以 `tsx src/index.ts`
启动，**跨包导入仍走 dist**；进程只在启动那一刻读一次。

> **28a 会静默地不成立**：批次照跑，规划段用量依旧落空，而守卫和指标看不出任何异常——
> 因为「没有用量」与「没有采集」在数据上完全一样。

发现方式：`ps -o lstart=` 的时间早于 `ls -l dist/...` 的 mtime。已停旧实例（SIGTERM，
2 秒内退出，停机前库内 `RUNNING`/`PENDING` 为 0 条）并用 `l1-m4-server-launch.sh` 重启。
**判据：进程启动时间必须晚于 dist 的 mtime。** 下批起跑前按这一条核对。

**全仓门禁（阶段收尾，显式退出码）**：

| 命令 | 结果 |
| --- | --- |
| `-r run typecheck` | **TYPECHECK_EXIT=0** |
| `-r run lint` | **LINT_EXIT=0** |
| `-r run test` | **TEST_EXIT=1** — 1907/1911 通过，4 条失败**全部为 e2e 时序抖动**（见 §6.1） |

> **记一次工具陷阱**：后台任务的通知报了 `exit code 0`，而日志里是 `TEST_EXIT=1`——
> 通知采信的是包装器最后一条 `echo` 的退出码。按 `background-exit-codes-are-the-wrapper`
> 的纪律**一律读 output 文件**，本次是第三次撞上。

### 6.1 四条失败：全部隔离复跑通过（未改任何测试）

| 文件 | 全量时的断言 | 隔离复跑 |
| --- | --- | --- |
| `failureRecovery.e2e`（external CANCELLED） | `expected +0 to be 1` | **10/10 通过** |
| `terminationPropagation.e2e`（FX-35） | `expected 0 to be greater than 0` | **5/5 通过** |
| `v1GoldenScenario.e2e`（server restart） | `expected undefined to be 1` | **4/4 通过** |
| `planningEscalation.e2e`（升级重试达上限） | `Parse Error: Expected HTTP/, RTSP/ or ICE/` | **2/2 通过** |

前三条是 `docs/145` #7 已登记的负载敏感抖动。**第四条是新的**（`planningEscalation`
此前登记过同类，但错误形态不同——这次是 HTTP 解析层的报错而非断言超时）。
它落在 N-25 改过的规划链路上，所以**没有按「同类」直接归类**：单独复跑 2/2 通过，
且该文件不含任何用量断言。判定为**同族负载抖动，非本次改动所致**。

全量运行时机器 1 分钟负载 **13.18**（10 核）；四条失败都是重型 e2e（真实 Docker /
Chromium / PostgreSQL），与既往各批的形状一致。**未弱化任何断言。**

---

## 8. E2E

**未做批次验证**（下一批 `l1-m4v`）。判据：

| 判据 | 内容 |
| --- | --- |
| **28a** | 一次真实规划 run 的 `agent_runs.token_usage` **非空**，`input_tokens` 量级与提示词长度相称 |
| **28b** | 失败的规划 run 也带用量 |
| **28c** | 触发重采样的规划，用量是**累计值**（正控；单测已覆盖算术，批次验真实调用） |
| **28d** | `ScriptedPlanningModel` 的 run 仍无用量（负控） |
| **28e** | `week_tokens()` 读数**变大**（守卫终于看得见规划段） |

### 8.1 预先声明的口径变化（任务书 §4 ⚠️）

**修完之后，同样的批次会报出更高的周用量。** 这不是回归，是**守卫终于能看见规划段**。
已写进 `packages/eval/scripts/l1-m4v-e1-x3.sh` 的脚本头，并把守卫上限提到 **1400M**。

---

## 9. Known Issues

1. **`usage_metadata` 缺失时不报**：若某个 provider 不回传该字段，`onUsage` 不会被调用，
   run 的 `tokenUsage` 保持缺省——**不造零值**（与 28d 同一判据：已知为真的事不造假数据）。
2. **`estimatedCost` 未填**：任务书 §7 裁定 2 明确不做（需要单价表，是另一个数据源）。
3. **本次只覆盖规划段**。agent 段与交付编排段原本就有用量（交付编排段零用量是正确的，
   它不调用模型——`docs/206` §2.1）。
4. **历史 807 条规划 run 仍为空**：不补写（改历史 `agent_runs` 是红线，`AGENTS.md` §6）。

---

## 10. Acceptance Result

交付物是「4 个源文件 + 5 条用例 + 批次脚本头预先声明 + 补建的停批脚本 +
**全仓门禁 typecheck/lint 全绿、1907/1911（4 条 e2e flake 全部隔离复跑通过）**
+ dist 重建与平台重启」。

判 **「已实施、单测验证通过、全仓门禁通过、批次验证待下一批」**，**不判「已关闭」**。

---

## 11. Next Phase Boundary

**未开始事项（STOP）**：

1. **28a–28e 待批次 `l1-m4v`**。该批同时验 N-36 与边界观测（见批次脚本头）。

   **起跑方式＝用户手动**（2026-10-23 选择，不自动启动）：

   ```bash
   caffeinate -s -d -i bash packages/eval/scripts/l1-m4v-e1-x3.sh
   ```

   停批：

   ```bash
   bash packages/eval/scripts/l1-m4v-stop.sh
   ```

   **起跑前须做**：① `curl /health` 为 200（当前 pid **53988**，须晚于 dist 的 mtime）；② 重读一次周用量
   （当前 `975,899,515`，上限 1400M，余量约 424M）；③ 按 `long-run-watchdog` 挂
   `eval-batch-watchdog.sh`。

2. **`VERIFICATION_GATE=enforce` 的全面切换评估**未开工。
3. **W11/W12/W13 未勾项**（多数已裁定不做或押后）。
4. **L2 无任务书**。
