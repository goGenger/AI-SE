# 175 · N-7「外层 AgentGraph 撞 LangGraph 默认递归上限」实施记录（PL-M14）

> 状态：**已实施并收尾**（2026-10-17）。用户裁定「**都按你的建议，开工 PL-M14**」——即任务书 `docs/174` §7 七项待裁定全部按推荐值接受。**判据强度以本文件为准**。
> 依据：任务书 `docs/174`、**实探**（`packages/agent-core/scripts/probe-agent-recursion-limit.ts`，本批新增）、L1-M4e run 1 实测、代码实查（`AgentGraph.ts` / `AgentRunner.ts` / `PlanningGraph.ts` / `ProfessionalAgent.ts` / `workflowTaskExecutor.ts`）、依赖实查（`@langchain/langgraph@1.4.14` / `deepagents@1.13.3` / `langchain@1.5.10`）。
> 性质：**本文件是实施结果正本**。

> **〔勘误 2026-10-17，PL-M16 / `docs/180`〕** 本文件把 N-7 记为**独立缺陷**（外层图撞 LangGraph 默认上限）。实测更正：**那是同一个空转被框架的 25 超步提前掐断的形态**——PL-M13 保留 `additional_kwargs` 之后，外层在 `submit_result` 被接受后每轮重复请求同一个工具调用、内层零模型调用地立即返回（**N-9**，任务书 `docs/179`）。**不传 `recursionLimit` 时**空转在 ~13 轮撞 `Recursion limit of 25`（探针 `scripts/probe-outer-loop-spin.ts` 场景 C 实测），**传了之后**在 50 轮撞平台守卫。**PL-M14 的成果本身仍然正确且必要**：`recursionLimitFor` 让平台自己的守卫成为生效的那一个，错误形态由框架的 `UNKNOWN_ERROR` 变为平台的 `TOOL_ERROR`（L1-M4f 已证实）——**这一点不受本勘误影响**。变的只是**归因**：N-7 与 N-9 是同一个控制流缺陷的两个阶段，而非两个缺陷。N-9 由 PL-M16 修复后，探针场景 C 的 `Recursion limit of 25` **一并消失**（49 轮 → 3 轮 / `succeeded`）。**本文件正文按历史记录保留不改**（`docs/146` §6 规则 7）。

## Modified Files

| 文件 | 改动 |
| --- | --- |
| `packages/agent-core/src/agent/AgentRunner.ts` | 新增导出 `recursionLimitFor(maxIterations)`；`graph.invoke` 传 `recursionLimit`（**唯一行为改动**） |
| `packages/agent-core/scripts/probe-agent-recursion-limit.ts` | **新增**。真实 `AgentRunner` + 永不收敛的脚本化 `LLMProvider` + 桩沙箱；落盘前/后测量值 |
| `packages/agent-core/src/__tests__/agentRunner.test.ts` | +2 例（行为回归 + 换算函数） |
| `packages/eval/results/n7-probe/{before,after}/` | **新增**。探针证据（`probe-report.txt` / `probe-measurements.json`） |

## Implementation

### 第 1 层：探针定位（先做，决定余量）

按任务书 §5，**先抓测量、不先改代码**。探针用真实的 `AgentRunner` 跑真实的 `AgentGraph`，配一个**永不收敛**的 provider（每次都返回新的 `tool_call`）——所以循环只可能停在上限上。

**修复前的探针输出**：

```
maxIterations requested : 50
status                  : failed
error code              : UNKNOWN_ERROR
error message           : Recursion limit of 25 reached without hitting a stop condition.
agentNode executions    : 13   (= provider invocations = loop iterations)
toolsNode executions    : 12
approx. supersteps      : 26
iterations reported     : 0
N7-PRESENT  the graph stopped at LangGraph's default recursionLimit (25),
            not at the platform guard (50).
```

**与生产同形**：错误码、错误消息、`S1-01` 那三条记录的形态完全一致。**13 轮**而不是请求的 50 轮。

**修复后的探针输出**：

```
maxIterations requested : 50
status                  : failed
error code              : TOOL_ERROR
error message           : Agent reached max iterations
agentNode executions    : 50
toolsNode executions    : 50
approx. supersteps      : 101
iterations reported     : 50
N7-FIXED    the graph ran to the platform's own guard and reported TOOL_ERROR
            at 50 iterations. The framework limit no longer binds.
```

**这条 before/after 就是判据 14b 的证据**：同一个探针、同一个请求值，唯一的差别是 `graph.invoke` 有没有传 `recursionLimit`。

### 修复：把上限从 `maxIterations` 推导出来

```ts
export function recursionLimitFor(maxIterations: number): number {
  return maxIterations * 2 + 4;
}
```

```ts
const finalState = await graph.invoke(state, {
  // N-7（docs/174）：见 recursionLimitFor 的说明。少了这一行，图会撞 LangGraph 的默认上限 25。
  recursionLimit: recursionLimitFor(maxIterations),
  configurable: { thread_id: context.agentRunId }
});
```

**余量取 `+4` 而不是任务书初拟的 `+2`**：探针实测走到平台守卫需要 **101** 个超步，即最坏情形为 `2 * maxIterations + 1`——`+2` 只剩 **1 步**余量。按任务书 §4 裁定 3「宁可宽不可窄」（窄了就退化成「换个数字的同一个缺陷」，且失败模式是**悄悄退回**框架的 `UNKNOWN_ERROR`），落到 `+4`，留 3 步。

### 为什么不给内层 deep agent 也设上限（任务书 §4 裁定 4）

`deepagents@1.13.3` 与 `langchain@1.5.10` 的 `createAgent` 都不设 `recursionLimit`，所以内层**理论上也跑在默认 25 下**。但：

- 若内层撞限，异常会在 `DeepAgentLLMProvider.invoke` 内抛出 → 经 `invokeLLMWithRetry` 重抛 → 被 `agentNode` 的 catch 接住 → 码为 **`LLM_ERROR`**。**全历史 `LLM_ERROR` 形态的撞限 0 条**（`docs/174` §2.6）。
- 本批**无观测证据**，改了也无法用真实批次验证。

**维持不设，登记为观察项**（Known Issues 2）。

## §2 对 `docs/174` 的补充与更正

### 补充 1：**`PlanningGraph` 的两个图已被实查排除**（任务书未提）

任务书 §1 把范围定为「外层 `AgentGraph`」，但没有说清**平台里还有没有别的 LangGraph 图**。本批实查（全树 grep）：

| 图 | 位置 | 有环？ | 结论 |
| --- | --- | --- | --- |
| **AgentGraph** | `graph/AgentGraph.ts:397-403` | **有**（`addConditionalEdges("agent", shouldContinue, ["tools", END])`） | **唯一受影响的图** |
| PlanningGraph（pipeline） | `planning/PlanningGraph.ts:792-939` | 无（全 `addEdge`） | 节点 ≤ 9，最坏超步 ≈ 10 < 25，**不受影响** |
| PlanningGraph（level2） | `planning/PlanningGraph.ts:964-996` | 无（3 节点） | 同上 |

**全平台 `addConditionalEdges` 只出现 1 次**，就在 `AgentGraph.ts:401`。**⇒ 修复点完整，不存在第二处同形缺陷。**

### 补充 2：探针的 `--out` 曾写错位置（已修）

`pnpm --filter ... exec` 会把 CWD 设成**包目录**，所以探针里相对路径的 `--out` 会落到 `packages/agent-core/packages/eval/results/...` 而不是仓库根下的目标。首次使用时实际发生了（证据文件先落错、后手工搬回）。已在探针里改为 **`resolve(REPO_ROOT, outArg)`**。

### 补充 3：`AgentRunner` 外层 catch 把 `iterations` 写成 0（**观察项，本批不改**）

`AgentRunner.ts` 的 catch 分支构造 `AgentResult` 时 `iterations: 0`。所以**框架撞限那条路径**（异常逃出节点）落库的 `current_iteration` 不是结果里的 0，而是生命周期 `onIteration` 最后一次上报的值——这解释了 L1-M4e 里 `S1-01` 三条记录的 6 / 8 / 10。**不是缺陷**，但值得记下来：那个数字是「崩溃前最后一次上报」，不是终值。

## Architecture Changes

- **无新增包 / 无新增顶层目录 / 无新增依赖。**
- 新增包内脚本 `packages/agent-core/scripts/probe-agent-recursion-limit.ts`（沿用 PL-M13 已建立的先例）。**该目录在门禁之外**——`packages/agent-core/tsconfig.json` 与 `eslint` 都只覆盖 `src/**`。**既有惯例，不是本批引入的疏漏**（Known Issues 1）。
- **上限的单一出处**：`recursionLimitFor` 是 `maxIterations → recursionLimit` 的唯一换算点，定义在 `AgentRunner.ts`，紧邻 `maxIterations` 的唯一解析点（`:91`）。判据 14c 达成。

## Dependencies

无新增运行时依赖。**未改动任何第三方件**——本批只加了一个 `graph.invoke` 的配置键。

## Tests

| 层 | 内容 |
| --- | --- |
| **探针（第 1 层）** | `scripts/probe-agent-recursion-limit.ts`。修复前 13 轮 / `UNKNOWN_ERROR` / `Recursion limit of 25`；修复后 50 轮 / `TOOL_ERROR` / `max iterations`。证据落 `packages/eval/results/n7-probe/{before,after}/` |
| 单测（行为回归） | `agentRunner.test.ts`：永不收敛的 provider + `maxIterations: 50`，断言 `TOOL_ERROR` / `max iterations` / `iterations === 50`。**已验「回退修复即失败」**——回退后该例报 `expected 'UNKNOWN_ERROR' to be 'TOOL_ERROR'`，其余 8 例仍过 |
| 单测（换算函数） | `agentRunner.test.ts`：`recursionLimitFor(50) === 104`、`recursionLimitFor(12) === 28`、且 `> 2 * maxIterations + 1`（探针实测的 101 是这条不变量的下界） |
| 回归 | `agent-core` 全量 **243/243（35 文件）**，改动前 241（**+2**）；`apps/server` **285/285（50 文件）** |
| 共享夹具核对（`AGENTS.md` §7） | 全树 grep 了 `maxIterations` / `TOOL_ERROR` / 迭代计数的消费方；**未发现**依赖旧行为的精确断言 |
| 门禁 | 见下 |

## Lint

`--filter @ai-se/agent-core lint` → 0；全仓 `corepack pnpm -r run lint` → **exit 0**。

## Typecheck

`--filter @ai-se/agent-core typecheck` → 0；全仓 `corepack pnpm -r run typecheck` → **exit 0**。

## E2E

全仓 `corepack pnpm -r run typecheck && lint && test`：

| 包 | 用例数 | 包 | 用例数 |
| --- | --- | --- | --- |
| **agent-core** | **243（35 文件）**（原 241，**+2**） | apps/server | 285（50 文件） |
| shared | 168（11 文件） | apps/web | 505（41 文件） |
| mcp | 235（24 文件） | database | 47（10 文件） |
| workflow-engine | 45（3 文件） | eval | 42（5 文件） |
| browser | 38（8 文件） | visual | 83（6 文件） |
| tool-runtime | 32（3 文件） | failure-recovery | 16（1 文件） |
| action-policy | 13（1 文件） | evidence | 9（1 文件） |
| sandbox | 8（2 文件） | observability | 3（1 文件） |

**A/B 实测（任务书 §5 的强制流程）**：首轮全仓 test **exit 1**——`apps/server` 的 `mcpConsoleApi.e2e`（真实 PostgreSQL + 真实 stdio / Streamable HTTP MCP 服务器）失败一例：`binding changes take effect immediately: stale definitions DENY with zero requests`。**隔离复跑 5 轮 × 8/8 通过**，**第二轮全仓 exit 0（server 285/285、16 包全绿）** → 判定为 `docs/145` #7 同族**负载敏感抖动**（重型 e2e 在全量并行下超时），**非本次改动所致**。与 PL-M10 / PL-M11 / PL-M13 撞到的抖动同族，但**具体文件不同**（那几次是 `failureRecovery.e2e`）。

## Known Issues

1. **探针在门禁之外**（`scripts/` 不在 `tsconfig.include` 与 `eslint` 范围内）。类型或风格问题不会被拦住。**维持现状**（既有惯例），但**改动探针后必须手工跑一次**。
2. **内层 deep agent 仍跑在 LangGraph 默认 25 下**（`docs/174` §2.6）。本批**未观测到内层撞限**（那会是 `LLM_ERROR` 形态，全历史 0 条），故不改。**登记为观察项**——若修完外层后真实批次出现 `LLM_ERROR` 形态的撞限，须单独立项。
3. **`recursionLimitFor` 的余量是「静态推导 + 一次实测」**，没有机制保证将来往 `AgentGraph` 里加节点后仍然够。若环的形状变了（例如三节点环），`* 2` 就不再成立。**登记**——与 PL-M13 Known Issues 5 同类（「已定位的点不是全部」）。
4. **`AgentRunner` 外层 catch 的 `iterations: 0`**（§2 补充 3）。不是缺陷，但让「崩溃那条路径」的落库迭代数依赖生命周期上报。**登记**。
5. **本批未做真实链路回放**。任务书 §5 第 4 层写的是「单个真实任务经 `:47558` 跑通，N-7 零出现且链越过 `S1-01`」——**这一层未执行**，理由见 Next Phase Boundary。**如实标注为未达成**。
6. 上一批的未修项全部维持登记（读侧放行 / 根级源码文件 / `scripts/` / `test/` / `canonicalAcKey` 副本 / N-1b / N-1c / N-3 / 7b / `CHECK_CANDIDATES` / 启动器陈旧实例 / 库内孤儿行）。

## Acceptance Result

**PASS-PARTIAL**。任务书 `docs/174` §3 的判据逐条：

- **14a**（超步上限由平台自己决定）——**达成**。`graph.invoke` 传 `recursionLimit: recursionLimitFor(maxIterations)`。
- **14b**（探针证明）——**达成**。同一探针：13 轮 / `UNKNOWN_ERROR` / `Recursion limit of 25` → **50 轮 / `TOOL_ERROR` / `max iterations`**。
- **14c**（换算关系单一出处）——**达成**。`recursionLimitFor` 是唯一换算点，紧邻 `maxIterations` 的唯一解析点。
- **14d**（不引入语义漂移）——**达成**。未改迭代语义、事件类型、状态码、生命周期回调时机；未改 `maxIterations` 取值与语义。
- **14e**（既有断言逐字不变）——**达成**。`agent-core` 全量 243/243，既有 8 例 `agentRunner` 断言全绿。
- **14f**（真实批次里 N-7 零出现，且链越过 `S1-01`）——**未达成**。本批**未跑任何批次**（任务书 §6 明确「本批不跑 E1×3 批次」）。

**为什么是 PASS-PARTIAL 而不是 PASS**：14f 是唯一一条需要真实链路的判据，而它没做。探针是**完整的机制证明**（同码、同消息、精确步数、before/after 唯一变量），但**它不是真实链路**。按记忆里的验收记账纪律，边界项宁标「未达成」也不勾选。

**另需如实标注**：本批**尚未证明**外层撞限在真实批次里不再出现。真正的验证是下一批 E1×3。

## Next Phase Boundary

**未开始事项（STOP）**：

- **本批未跑任何批次，也未做真实链路回放。** 下一步按任务书 `docs/174` §7 第 5 项：**另开一批 E1×3**（新结果目录），**不续跑 L1-M4e**。
- **下一批开工前的三件事**（与前几批同一口径）：① **确认周配额余量**（本批收尾时代理值见 `docs/146` §5；窗口 10-11 23:00 UTC 起，**10-18 23:00 UTC 刷新**）；② **先停掉 `:47558` 上的陈旧实例再重启**——本批改了 `packages/agent-core`，**现实例载的是改动前的代码**；`l1-m4-server-launch.sh` 只要端口有应答就报 `SERVER_ALREADY_UP` 并**静默复用**；③ harness 追踪的后台任务启动 + **立即** arm 看门狗（`--heartbeat-min 30 --stall-min 25`），停机用 `packages/eval/scripts/l1-m4e-stop.sh` 形态的脚本（**必须 cancel 服务端工作流**，见 `docs/173` §3 勘误）。
- **下一批的头号观察项**：① **N-7 是否零出现**（本批修复的唯一真实检验），且**链能否越过 `S1-01`**；② 两类网关 400 是否仍为 0（PL-M13）；③ 能否首次抵达交付切片 `ui-deploy-docs`——**PL-M11 / PL-M12 至今一次未被检验**；④ 若出现 `LLM_ERROR` 形态的撞限，说明内层也有问题（Known Issues 2）。
- **未修项（均维持登记）**：Known Issues 1–6。
- 不改 `packages/eval` 的夹具与 oracle；不改 `EvalPolicy`；不改 L1-8 判据口径；不修改任何 `dist/`。
- 收口时同步登记账：`docs/146` §3（N-7 行状态）、§4（本任务书 §7 的裁定行）、§5（本批记录）、`docs/127` §5/§6。
