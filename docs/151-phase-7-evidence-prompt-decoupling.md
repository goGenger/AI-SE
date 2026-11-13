# 151 · 阶段 7 裁定与实施：验证证据不进 Agent 输入

> 日期：2026-10-15 ｜ 类型：**单项裁定 + 实施**（用户裁定：「如果这个很有必要的话，就改为观测通道存放」→ 经实测给出推荐值后，用户选择**整个拿掉**）
> 依据：`docs/147` §6 第 4 项（7-E 的前置）、§7 红线；`AGENTS.md` §9/§11；`docs/146` §6 规则 7/8。
> 承接：`docs/149`（M1）、`docs/150`（7-C）。**本文件同时关闭 `docs/147` §6 的第 4 项**（它是 7-E 开工的唯一前置）。

## Modified Files

**代码（修改 1）**
- `apps/server/src/services/taskContextBuilder.ts`：新增模块内 `withoutVerification()`，`dependencyResults[].output` 不再携带 `verification`。

**测试（新增 1）**
- `apps/server/src/__tests__/taskContextBuilder.test.ts`（2 条：验证记录不进输入且存储对象未被就地改动；无验证记录的输出原样保留）。

**文档（新增 1 / 修改 3）**：本文件；`docs/147`（§1 基线行、§6 第 4 项裁定值、§9 审阅轮记录）、`docs/146`（§4 本批裁定）、`docs/150`（Next Phase Boundary：该问题已关闭）。

**未修改**：`tasks.output.verification` 的写入路径与内容、`traceability.ts`、`taskVerifier.ts`、任何迁移与表结构、`dist/`。

## Implementation

**裁定：验证证据留在任务输出里，但不进 Agent 输入。**

1. **改动只有一处**：`taskContextBuilder.ts` 在组装 `dependencyResults` 时剥掉 `output.verification`。
   - `dependencyResults` 只有一个产出点（该文件）与一个消费点（`isolateTaskContext` → 提示词），没有别的读取方（全树核对）。
   - `withoutVerification()` 返回**新对象**：同一条记录仍被 AC 覆盖判定与追溯表读取，不能就地删。
2. **存储与读取方一律不动**：`output.verification` 仍由 `verifyingTaskExecutor` 写入，仍是切片 AC 覆盖判定（`taskVerifier.ts:189`）与追溯表（`traceability.ts:54`）的事实来源，仍可通过既有 API 读到。
3. **效果**：`observe` 模式从此**只观测**——它写证据、不改任务结果，也不再改变 Agent 的输入。这是当初把质量门默认值改为 `observe` 时留下的唯一行为耦合（`docs/148` Known Issue 2）。

## 为什么不是「改存观测通道」

裁定前用本机真实库做了实测，结论是**存放位置不是问题**：

| 事实 | 数值 / 出处 |
| --- | --- |
| 带验证记录的任务 | 1186 个（有输出的任务共 1921 个） |
| 验证记录平均大小 | 2.9 KB（最大 9.2 KB） |
| 其中原始 `stdoutTail` / `stderrTail` | 1.5 KB，**占 53%**（最大 4.3 KB） |
| 验证记录占该任务输出的比例 | ≈ 95%（对这些任务而言，输出基本就是这段验证） |
| 两个生产读取方实际读的字段 | `checks[].acResults`、`command`、`exitCode`、`commitSha`、`finishedAt`——**从不读那两个尾部** |
| `dependencyResults` 的产出/消费点 | 各 1 处（`taskContextBuilder.ts:58`；`isolateTaskContext` 的 `slice(-20)`） |

把证据迁到事件或表：**零功能收益**（存储不是瓶颈），却要新增迁移、并重接两个位于**验收路径上**的读取方——风险落在 AC 门禁与追溯表上。真正的问题从来不是「存在哪儿」，而是「它进了 Agent 的提示词」。

## Architecture Changes

- 无接口、契约、状态机、审批语义或包边界变化。改的是 `TaskContext` 的**内容组装**：`dependencyResults[].output` 少一个键。
- Agent 可见输入因此回落到「任务输出里与验证无关的部分」；证据仍在任务输出里，只是不再流向下游。

## Dependencies

无新增依赖。

## Tests

| 命令 / 范围 | 结果 |
| --- | --- |
| `@ai-se/server` 新增用例 | `taskContextBuilder.test.ts` **2/2 通过** |
| `@ai-se/server` test（全量，共 2 次） | **261/263、263/263**。第一次的 2 条失败是 `agentsApi.test.ts`（5s 超时）与 `mcpConsoleApi.e2e.test.ts`（401），**单独复跑该两文件 9/9 通过**；第二次全量 **263/263（50 个文件）** 全绿。与本次改动无关（两处都不经过 `TaskContextBuilder`），属 `docs/145` #7 的负载抖动 |
| `@ai-se/server` typecheck / lint | 均通过（退出码 0） |
| 增量核对 | 7-C 收口时为 261 条；本次 +2 = 263 ✓ |

用例断言：`dependencyResults[].output` 等于去掉 `verification` 后的对象、序列化结果不含 `stdoutTail`、**传入的原始 output 对象仍带 `verification`**（防就地删）、无验证记录与 `output` 为空时原样保留。

## Lint

`corepack pnpm --filter @ai-se/server lint`：通过（退出码 0）。本次只改 `apps/server`，故按 `AGENTS.md` §7 跑该包门禁；全仓 `-r lint` / `-r typecheck` / `-r test` 已在同日 7-C 收口时跑过（`docs/150`）。

## Typecheck

`corepack pnpm --filter @ai-se/server typecheck`：通过（退出码 0）。该命令会重建相关包的 `dist`（构建产物，未读取）。

## E2E

- 未新增 e2e：本次改动是纯内容组装，已在单测里覆盖输入侧与存储侧两侧；既有 e2e（交付链、工作流、评测路径）在下方全量运行中一并复核。
- **未运行真实模型工作流**（未获授权，会消耗 token 与沙箱时间）。`observe` 与真实 Agent 的交互变化属行为层面，待下一次真实运行观察。

## Known Issues

1. **下游任务不再看到上游的验证记录**——包括失败测试的原始输出。这是裁定的**代价**，不是缺陷：判据是「`observe` 不得改变 Agent 输入」优先于「修复类任务可能受益于上游原始日志」。若日后真实运行显示修复类任务因此变差，回退选项是「只保留摘要（verdict / exit code / 命令）」，见 `docs/150` 的裁定选项 2。
2. **评测批次的输入随之变化**：历史批次（`docs/127` §4 的 L3 / E1 数字）是在「验证记录进提示词」的配置下取得的。本改动**不回溯**既有数字，但**后续批次的数字与它们不再逐字可比**，对比时须注明。
3. **`previousAttempts` 不受影响**：它取自 Agent Run，而 Agent Run 从不携带 `verification`（实库 0 行），因此本来就与本次裁定无关。
4. **存储侧未清理**：`output.verification` 仍在任务输出里，平均 2.9 KB / 任务。若日后在意存储或 API 载荷，属另一项裁定（本次只处理 Agent 输入）。
5. **未做的其他事项**（红线，不得误读为已完成）：7-E 决策事件契约、7-D 外部栈、`audit_logs` 处置、自治 L1、追踪前端。

## Acceptance Result

| 项 | 判定 | 证据 |
| --- | --- | --- |
| 裁定落实：验证证据不进 Agent 输入 | **已执行** | `taskContextBuilder.ts` 的 `withoutVerification()`；`taskContextBuilder.test.ts` 2/2 |
| 存储与两个生产读取方不受影响 | **已执行** | 未改写入路径与 `traceability.ts` / `taskVerifier.ts`；单测断言原对象仍带 `verification` |
| `docs/147` §6 第 4 项 | **已关闭** | 该节已写裁定值；7-E 的开工前置清空 |
| 门禁 | **通过** | `@ai-se/server` typecheck / lint 退出码 0；全量 test 263/263（另一次 261/263 的两条为已登记抖动，单独复跑通过） |

## Next Phase Boundary

**本项结束（STOP）。未开始事项**：
- **7-E 决策事件契约**：前置已清空，**可开工**（仍需用户点名）。
- **7-D 外部栈**：已裁定延期。
- **追踪前端**：已裁定另立阶段。
- **自治 L1 实现**（L1-4 … L1-8）与 L1-1 … L1-3 的回归断言：未开工。
- **`provider` 运行时切换**：未开工（沿用 `docs/145` 边界）。

**需要你回答**：无。`docs/147` §6 的五项已全部裁定并落地，M2 只剩 7-E 一件未开工的事。

## 后续（2026-10-15，追加）

本文件为**历史记录**（`docs/146` §6 规则 7），正文不回改。追加：**Phase 7 已于 2026-10-15 收口**（收口记录 `docs/153`）——7-E 已于同日交付（`docs/152`），`docs/17` 的 Phase 7 六项已逐项回填（完成 2 项 / 延期 4 项）。本文件「Next Phase Boundary」所列的「7-E 可开工」已由 `docs/152` 落实。
