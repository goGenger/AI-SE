# 173 · N-6「网关消息形状 400」实施记录（PL-M13）

> 状态：**已实施并收尾**（2026-10-17）。用户裁定「**都按你的建议，开工 PL-M13**」——即任务书 `docs/172` §7 七项待裁定全部按推荐值接受。实施中据实测提出 §2 的 **3 处更正**，**判据强度以本文件为准**。
> 依据：任务书 `docs/172`、**实探**（`packages/agent-core/scripts/probe-gateway-message-shape.ts`，本批新增）、L1-M4d run 1/2/3 实测、代码实查（`DeepAgentLLMProvider.ts` / `LangChainLLMProvider.ts` / `@langchain/core` / `@langchain/openai` / `deepagents`）、`docs/129` §事故 2（既有诊断）。
> 性质：**本文件是实施结果正本**。任务书 `docs/172` 的方案部分仍有效，**被本文件 §2 更正的 3 处以其为准**（`docs/146` §6 规则 7：不追改历史记录，更正以追加块形式落在这里）。

## Modified Files

| 文件 | 改动 |
| --- | --- |
| `packages/agent-core/scripts/probe-gateway-message-shape.ts` | **新增**。真实工厂 + 录制型假网关的探针：`createOpenAIChatModel` → 真 `ChatOpenAI` → 真转换器；`ToolRuntimeBackend` + 真 `ToolRuntime(createPhase1Tools())` + 脚本化沙箱；`DeepAgentLLMProvider`。6 个场景（A/B/C/G/E/F），落盘每次出站 body，检查 INV-1 / INV-2 |
| `packages/agent-core/src/professional/DeepAgentLLMProvider.ts` | `invoke` 重建 `AIMessage` 时补 `additional_kwargs: message.additional_kwargs`（**丢失点 ①，探针实测确证**） |
| `packages/agent-core/src/llm/LangChainLLMProvider.ts` | `invoke` **挂成本时**的重建补 `additional_kwargs: response.additional_kwargs`（**丢失点 ②，本批新定位**） |
| `patches/@langchain__openai@1.5.11.patch` | 扩展：`.js` / `.cjs` 各再加一行，把 `role:"tool"` 的非字符串 content 归一为字符串 |
| `packages/agent-core/src/professional/DeepAgentLLMProvider.test.ts` | +1 例（`additional_kwargs` 在重建后存活）+ 模型替身 `ReasoningReportingDeepAgentModel` |
| `packages/agent-core/src/__tests__/llmProvider.test.ts` | +1 例（挂成本的重建保留 `additional_kwargs`） |

## Implementation

### 第 1 层：探针定位（先做，决定改动面）

按任务书 §5，**先抓载荷、不先改代码**。探针把 `OPENAI_BASE_URL` 指向本机「录制型假网关」——出站字节仍由平台自己的代码路径产生，但**离线、可复现、不花网关配额、不需要 Docker**。

**修复前的探针输出（关键部分）**：

```
--- request #2  scenario=B_accumulate ---
  role=user      content=string  reasoning=no   probe task
  role=assistant content=string  reasoning=no   A answer          <- 丢失
--- request #3  scenario=C_control ---
  role=assistant content=string  reasoning=YES  C answer          <- 保留
--- request #5  scenario=G_real_read_file ---
  role=assistant content=string  reasoning=YES
  role=tool      content=array   reasoning=no   [{"type":"text","text":"     1\tPROBE_FI...
--- request #6  scenario=E_tool_array ---
  role=tool      content=array   reasoning=no   ["block-a","block-b"]
INV-1  B_accumulate: reasoning_content ABSENT      C_control: PRESENT
INV-2  VIOLATION #5 (G_real_read_file): tool content type=array
```

- **`B_accumulate` 就是平台自己的回灌形状**（`AgentGraph.agentNode` 把 provider 返回的 `AIMessage` 放回 `state.messages` 再送进去）。它**丢字段**，而 `C_control`（消息自身仍带该字段）**不丢**——同一转换器、同一网关，差别只在消息本身。
- **请求 #5 是端到端实证**：真实 `read_file` 工具产出的 tool 消息，content **就是数组**。

**由此查明错误 ② 的完整链条（三环，每环实查）**：

| 环 | 位置 | 事实 |
| --- | --- | --- |
| 1 | `deepagents` dist（`read_file` 工具） | 返回 `[{type:"text", text: …}]`（二进制走 `[{type:"image"\|"audio"\|"video"\|"file", …}]`）。**`ls` 返回字符串**——所以只有读文件的任务出事 |
| 2 | `@langchain/core/dist/tools/index.js:335` | `typeof content === "string" \|\| Array.isArray(content) && content.every(_isMessageContentBlockShaped)` → **原样放进 `ToolMessage.content`**；否则才 `_stringify` |
| 3 | `@langchain/openai` 转换器（`completions.js:577`） | `typeof content === "string" ? content : content.flatMap(...)` → 非字符串原样发出 |

### 修复 ①：`additional_kwargs` 在两处重建点被丢掉

探针指认后定点修，**未预设改动面**（任务书 §4 裁定 1）：

- `DeepAgentLLMProvider.invoke`（`:89-98`）——重建时只复制 `content` / `usage_metadata` / `response_metadata`。
- `LangChainLLMProvider.invoke`（`:119-125`）——**挂成本时**的第二次重建，同样只复制这四项。**这一处是实施中新定位的**（见 §2 更正 1/2）。

依赖补丁（`docs/129` §事故 2 加的）的回传条件是「assistant 消息自身携带非空 `additional_kwargs.reasoning_content`」——所以只要有一处重建丢掉它，补丁就对该轮失效。

### 修复 ②：扩展 `@langchain/openai` 补丁，把 tool content 归一为字符串

沿用**既有补丁的同一文件、同一机制**（`pnpm patch` + `pnpm patch-commit`，注册在 `pnpm-workspace.yaml` 的 `patchedDependencies`），`.js` / `.cjs` 各再加一行：

```js
if (completionParam.role === "tool" && typeof completionParam.content !== "string")
  completionParam.content =
    Array.isArray(completionParam.content) &&
    completionParam.content.every((block) => block && block.type === "text" && typeof block.text === "string")
      ? completionParam.content.map((block) => block.text).join("\n")
      : JSON.stringify(completionParam.content);
```

**归一策略是「保语义优先」**：纯文本块 → **拼成文本**（模型看到的仍是文件内容本身，不是 JSON 包装）；其余（含 image/audio 等）→ JSON 字符串兜底。这与「直接 `JSON.stringify` 一切」不同，后者会让模型看到 `[{"type":"text","text":"…"}]` 这样的包装。

### 修复后的探针输出

```
--- request #5  scenario=G_real_read_file ---
  role=assistant content=string  reasoning=YES
  role=tool      content=string  reasoning=no        1\tPROBE_FILE_LINE_ONE
                                                     2\tPROBE_FILE_LINE_TWO
INV-1  B_accumulate: PRESENT      C_control: PRESENT
INV-2  no non-string tool content observed in this probe window
```

## §2 对 `docs/172` 的更正（3 处，均据实测）

### 更正 1：**§2.4 的「丢失点 ②」（`toAIMessage` 的 chunk 分支）是错的——那是死代码**

任务书 §2.4 称 `LangChainLLMProvider.toAIMessage`（`:84-98`）的 `AIMessageChunk → AIMessage` 重建是第二处丢失点。**实测证伪**：

```
AIMessage.isInstance(chunk)      = true
AIMessageChunk.isInstance(chunk) = true
chunk instanceof AIMessage       = true
```

**`AIMessageChunk` 在本版本 `@langchain/core`（1.2.9）里继承 `AIMessage`**，所以 `toAIMessage` 的第一个分支 `if (AIMessage.isInstance(output)) return output;` 就把它原样返回了——**第二个分支不可达**。

我是怎么发现的：我先按任务书写了「chunk 路径保留 `additional_kwargs`」的用例，**它在我把该分支的修复回退之后照样通过**——这才回头去验 `isInstance` 语义。**该分支的改动与用例都已撤回**（不在本批的 Modified Files 里）。

### 更正 2：**真正的第二处丢失点是 `LangChainLLMProvider.invoke` 挂成本时的重建**

顺着更正 1 的线索读 `invoke`，发现 `:119-125` 在 `estimateCostUsd` 返回数值时**又重建了一次** `AIMessage`，同样不带 `additional_kwargs`。这处**是可达的**：`apps/server/src/index.ts:107` 用 `LangChainLLMProvider.fromOpenAI({...})`（生产路径），而 `workflowTaskExecutor.ts:277-279` 会传 `modelPricing`。

**判断依据**：该分支只在配置了价目时走到；未配置价目时 `invoke` 直接 `return response`（`:118`），字段得以保留。所以它是一个**条件性**丢失点，而不是无条件丢失。用例按「配了价目」构造，已验证**回退修复即失败**。

### 更正 3：**错误 ② 的根因不是「未查明」，而是 `deepagents` 的 `read_file` 返回内容块数组**

任务书 §2.2 把错误 ② 记为「机制未查明」。**现已查明**（Implementation 第 1 层的三环链条 + 探针请求 #5 的端到端实证）。任务书 §2.2 里那张「候选来源 / 结论」表的五条排除**依然成立**——只是当时缺了「谁**返回**非字符串」这一环，而那不在排除范围内。

**附带更正**：任务书 §2.2 末段推测「错误 ① 与 ② 共享 `request_id` 前缀，可能同源」。**实测表明两者根因不同**（一个是我们重建消息丢字段，一个是第三方工具返回数组），**只是同一天、同一网关节点上暴露**。该推测作废。

## Architecture Changes

- **无新增包 / 无新增顶层目录 / 无新增依赖。**
- 新增一个包内脚本目录 `packages/agent-core/scripts/`（**先例**：`apps/server/scripts/*.ts` 三个同形诊断脚本）。**注意**：该目录**在门禁之外**——`packages/agent-core/tsconfig.json` 与 `apps/server/tsconfig.json` 都只 `include: ["src/**/*.ts"]`，`lint` 也只扫 `src/**`。这是**既有惯例**，不是本批引入的疏漏。
- 依赖补丁**扩展**（不是新增补丁）：`patches/@langchain__openai@1.5.11.patch` 由 2 个 hunk 变 4 个；`pnpm-workspace.yaml` 的 `patchedDependencies` 条目不变（同一条目、新内容 → patch hash 由 `490ce73a…` 变 `7cc3de24…`）。
- **不启用** `thinking:{type:"disabled"}`（任务书 §7 第 2 项裁定）。

## Dependencies

无新增运行时依赖。**`@langchain/openai@1.5.11` 的补丁内容有变**（这是本批唯一动到的第三方件）。

## Tests

| 层 | 内容 |
| --- | --- |
| **探针（第 1 层）** | `packages/agent-core/scripts/probe-gateway-message-shape.ts`。6 场景；输出落 `packages/eval/results/n6-probe/{captured-bodies.json,probe-report.txt}`。**这是本批定位的手段，也是修复的证据** |
| 单测（丢失点 ①） | `DeepAgentLLMProvider.test.ts`：`ReasoningReportingDeepAgentModel` 让内层消息带 `additional_kwargs.reasoning_content`，断言 provider 返回的消息仍带着它。**已验「回退修复即失败」** |
| 单测（丢失点 ②） | `llmProvider.test.ts`：配 `{inputPerMTok:1, outputPerMTok:1}` 走挂成本的重建，断言 `estimatedCostUsd === 1` 且 `additional_kwargs.reasoning_content` 存活。**已验「回退修复即失败」** |
| 探针（第 4 层，真实栈回放） | 修复后重跑：INV-1 两个场景均 PRESENT、INV-2 零违规（见 Implementation） |
| 回归 | `agent-core` 全量 **241/241（35 文件）**；`apps/server` **285/285（50 文件）**；全仓 16 包全绿 |
| 共享夹具核对（`AGENTS.md` §7） | 全树 grep 了 `additional_kwargs` / `reasoning_content` / `toAIMessage` 的消费方；**未发现**依赖旧行为的精确断言 |
| 门禁 | 见下 |

## Lint

`--filter @ai-se/agent-core lint` → 0；全仓 `corepack pnpm -r run lint` → **exit 0**。

## Typecheck

`--filter @ai-se/agent-core typecheck` → 0；全仓 `corepack pnpm -r run typecheck` → **exit 0**。

## E2E

全仓 `corepack pnpm -r run typecheck && lint && test` → **exit 0**（16 个 workspace 包全部通过）：

| 包 | 用例数 | 包 | 用例数 |
| --- | --- | --- | --- |
| **agent-core** | **241（35 文件）**（原 239，**+2**） | apps/server | 285（50 文件） |
| shared | 168（11 文件） | apps/web | 505 |
| mcp | 235 | database | 47 |
| workflow-engine | 45 | eval | 42 |
| browser | 38 | visual | 83 |
| tool-runtime | 32 | failure-recovery | 16 |
| action-policy | 13 | evidence | 9 |
| sandbox | 8 | observability | 3 |

**本轮无抖动**（上批 `failureRecovery.e2e` 的负载敏感失败未复现）。

## Known Issues

1. **`F_tool_object` 场景在本地抛 `TypeError: message.content.flatMap is not a function`**（`@langchain/openai` 转换器 `completions.js:577`）。即 content 既非字符串又非数组时，**请求根本发不出去**。这是**上游库的既有行为**，本批未改（没有平台侧构造这种消息的路径）。**登记为观察项**。
2. **`image` / `audio` / `video` / `file` 型 tool 内容被 JSON 字符串化**（补丁的兜底分支）。当前平台不产出这类内容（E1 夹具是纯文本项目），**未实测**。若将来引入多模态读取，需重新评估——JSON 化会丢失语义。
3. **探针在门禁之外**（`scripts/` 不在 `tsconfig.include` 与 `eslint` 范围内，与 `apps/server/scripts/` 同）。类型或风格问题不会被 `typecheck` / `lint` 拦住。**维持现状**（既有惯例），但**改动探针后必须手工跑一次**。
4. **`read_file` 的数组返回值仍在**（只是被转换器归一了）。即**上游库升级后若补丁失效，错误 ② 会原样复发**。这与既有 `reasoning_content` 补丁是同一风险面。
5. **两处丢失点只是「已定位的两处」**，不是「全部」。本批以「重建 `AIMessage` 必须保留 `additional_kwargs`」为不变量，但**没有机制保证**将来新增的重建点会遵守（无 lint 规则、无类型约束）。**登记**。
6. **N-6 的网关侧成分未定**：`reasoning_content` 的历史分布（10-07 3 次 / 10-09 7 次 / 10-14 3 次 / 10-17 3 次）说明网关**间歇性**进入 thinking 模式。本批修的是「平台没有回传」这一侧；**网关何时要求回传仍不可控**。若修后仍偶发，则说明还有第二个平台侧成因或确为网关侧——**以真实批次为准**。
7. **本批未做真实网关回放**（只做了假网关探针）。任务书 §5 第 4 层写的是「单个真实任务经 `:47558` 跑通，探针窗口内两类 400 零出现」——**这一层未执行**，理由见 §Next Phase Boundary（真实回放等价于跑批次，受配额与纪律约束）。**如实标注为未达成**。
8. 上一批的未修项全部维持登记（读侧放行 / 根级源码文件 / `scripts/` / `test/` / `canonicalAcKey` 副本 / N-1b / N-1c / N-3 / 7b / `CHECK_CANDIDATES` / 启动器陈旧实例）。

## Acceptance Result

**PASS-PARTIAL**。任务书 `docs/172` §3 的判据逐条：

- **13a**（丢失点被消除）——**达成**。两处重建点补 `additional_kwargs`；`writePaths` / 写范围一字未动。
- **13b**（真实栈探针证明）——**达成**。探针 `B_accumulate` 由 ABSENT 变 PRESENT；`C_control` 对照组全程 PRESENT。
- **13c**（错误 ② 机制查明）——**达成**。三环链条 + 端到端实证（请求 #5）。
- **13d**（错误 ② 被修复）——**达成**。补丁归一后探针零违规；真实 `read_file` 的 tool content 由数组变字符串。
- **13e**（不引入语义漂移）——**达成**。未启用 `thinking:{type:"disabled"}`。
- **13f / 13g**（既有断言逐字不变）——**达成**。写范围与 LLM 层既有断言全绿。
- **13h**（探针窗口零 400 + **单个真实任务端到端跑通**）——**部分达成**。假网关探针窗口零违规；**真实网关的单个任务回放未执行**（Known Issues 7）。

**为什么是 PASS-PARTIAL 而不是 PASS**：13h 的后半句（真实栈回放）没做。我不想把「假网关探针通过」说成「真实链路验证通过」——**两者差一个真实网关**。按记忆里的验收记账纪律，边界项宁标「部分达成」也不勾选。

**另需如实标注**：本批**尚未证明**这两处修复能让真实批次不再 400。真正的验证是下一批 E1×3。

## Next Phase Boundary

**未开始事项（STOP）**：

- **本批未跑任何批次，也未做真实网关回放。** 下一步按任务书 `docs/172` §7 第 4 项：**另开一批 E1×3**（新结果目录），**不续跑 L1-M4d**。
- **下一批开工前的三件事**（与前几批同一口径）：① **确认周配额余量**（本批收尾时代理值 **113,409,420 / 200,000,000**；窗口 10-11 23:00 UTC 起，**10-18 23:00 UTC 刷新**）；② **先停掉 `:47558` 上的陈旧实例再重启**——本批改了 `packages/agent-core` 且 `typecheck` 触发了 `shared` / `observability` / `sandbox` 的 `dist` 重建，**现实例载的是改动前的代码**；`l1-m4-server-launch.sh` 只要端口有应答就报 `SERVER_ALREADY_UP` 并**静默复用**；③ harness 追踪的后台任务启动 + **立即** arm 看门狗（`--heartbeat-min 30 --stall-min 25`）。
- **下一批的头号观察项**：① 两类 400 是否**零出现**（这是本批修复的唯一真实检验）；② 能否越过切片 2 抵达交付切片 `ui-deploy-docs`——**PL-M11 / PL-M12 至今一次未被检验**（L1-M4d 三次都没跑到）；③ `PLAN_TEST_BEFORE_SCRIPT_PROVIDER` / `TASK_CHECK_UNAVAILABLE` 频率（L1-M4d run 1：0 条 / 2 条）。
- **未修项（均维持登记）**：Known Issues 1–6、8。
- 不改 `packages/eval` 的夹具与 oracle；不改 `EvalPolicy`；不改 L1-8 判据口径；不修改任何 `dist/`。
- 收口时同步登记账：`docs/146` §3（**新增 N-6 行**）、§4（本任务书 §7 的裁定行）、§5（下一批开工门槛）、`docs/127` §5/§6、`docs/129` 末尾追加勘误块（§事故 2 的「上游间歇性」归因**不完整**）。

## §3 追加勘误（2026-10-17 16:20，开 L1-M4e 批次前实查发现）

> 位置说明：`docs/172` §8 的 L1-M4d 记账数字有误，按 `docs/146` §6 规则 7「历史记录不追改，更正以追加块落在他处」，勘误落在这里（`docs/173` 是本批的实施结果正本）。**以下为实测值，取代 `docs/172` §8 / `docs/127` §6 / `docs/146` §2.2 的对应数字。**

### 更正 4：L1-M4d 的实际消耗是 **25.06M**，不是 26.8M；且**「停批」没有停干净**

**实测（`agent_runs` 按工作流窗口求和，2026-10-17 16:15 UTC 复算）**：

| 段 | 实测输入 token | `docs/172` §8 / `docs/127` §6 原记 | 差异来源 |
| --- | --- | --- | --- |
| run 1（工作流 `2af5e078`，04:35:56–05:15:18） | **15,661,690** | 24.98M | 原值把**批前单跑** `876616fb`（04:03–04:33，**9,322,557**）一并算了进去——9,322,557 + 15,661,690 = 24,984,247 |
| run 2（工作流 `3cf733a9`，05:45:27–05:57:20） | **1,790,090** | 1.79M | 一致 |
| run 3（工作流 `1e436a66`，06:27:23–**06:55:47**） | **7,607,635** | 约 0.04M | 原值只取了停批那一刻的第一行（39,934），**漏掉了停批后仍在跑的那 27 分钟** |
| **合计** | **25,059,415** | 26.8M | 原值 = 24,984,247 + 1,790,090 + 39,934 = 26,814,271 |

全天校验：34,381,972 = 批前单跑 9,322,557 + L1-M4d 25,059,415。**两项相加与全天总量逐位吻合**，故上表可信。

**更严重的一条：用户 14:29（06:29 UTC）裁定停止后，批次并没有停。**

- 停批时我只杀掉了 harness（`caffeinate` + `src/cli.ts`）。**工作流已经提交到服务端**，杀 CLI 不会取消它。
- `1e436a66` 因此继续运行到 **06:55:47 才 FAILED**：期间 06:30–06:48 又跑了 **8 次成功**的 agent run，烧掉约 **7.5M**；06:54–06:55 连续 4 次失败后工作流终止。
- 即：**「停下」之后又花了 7.61M**，比记账的 0.04M 多两个数量级。

**由此产生的两处状态订正**：

1. `docs/172` §8 / `docs/127` §6 记「工作流 `1e436a66`（run 3）**留在 `RUNNING`**」——**已过时**。它现为 **FAILED**（06:55:47 自行终止），**不在 `RUNNING`/`PENDING` 中**。库内 `RUNNING`/`PENDING` 工作流现为 **0 条**；唯一非终态是 10-14 的 `WAITING_APPROVAL` 孤儿 `57f98bf9`。
2. `docs/173` §Next Phase Boundary 记的「停批时配额 113,409,420」是**停批那一刻**的读数，**不是 L1-M4d 的最终成本**。开 L1-M4e 批次前实测为 **120,977,121 / 200,000,000**。

### 处置：补一个会 cancel 服务端的停机脚本

`g-m3-stop.sh`（G-M3 批次）**早就有正确做法**——杀角色 **+ `POST /api/workflows/<id>/cancel`**。L1-M4d 用的 `l1-m4d-e1-x3.sh` **没有配套停机脚本**，我停批时也没走这条路。

本批新增 `packages/eval/scripts/l1-m4e-stop.sh`：杀角色 → 取 `status in ('RUNNING','PENDING')` 的工作流 ID → 逐个 cancel → **复查确认无残留**。以后停 L1-M4e 用它，不要再只杀 harness。

**登记**：这是**操作纪律缺陷**（停机流程不完整），不是平台代码缺陷；**不阻塞批次**（配额余量足够），故未按 N 系列缺陷立项。但它是「已知缺陷先清掉再跑批次」纪律的一个**例外项**，如实登记于此。

## §4 追加勘误（2026-10-18，PL-M17 实施后）

> 位置说明：本文件的 Known Issues 6 / 7 的**状态已被 `docs/182` 取代**，按 `docs/146` §6 规则 7「历史记录不追改，更正以追加块落在他处」，勘误落在这里。

### KI 6 的状态：**已应验，且成因已查明**

原文逐字：「**N-6 的网关侧成分未定**……若修后仍偶发，则说明还有第二个平台侧成因或确为网关侧——**以真实批次为准**」。

**l1-m4h（三个 E1×3 run）就是那个「真实批次」，它复发了**：全批 64 个 agent run、5 个失败，**5/5 全是 N-6**（另 1 次触发落在最终成功的 run 里），共 **6 次**。

PL-M17（`docs/181` / `docs/182`）查明的结论：

- **不是「第二个平台侧丢失点」。** 本批逐条实查排除了全部五个候选（本文件的两处重建点、PL-M16 的 `withoutToolCalls`、依赖补丁、`deepagents` 的三处 AIMessage 重建）。
- **是网关的间歇性与平台无法补全之间的缺口**：网关**间歇性进入 thinking 模式**，而它要求历史里**每一条带 `tool_calls` 的 assistant 消息**都必须回传 `reasoning_content`——包括那些它在**非 thinking 轮次**产出的、因此从未给过该字段的消息。**平台无法凭空造出它。**
- **实测（真网关）**：该规则是「**存在**」而非「非空」——空字符串即可满足。PL-M17 因此在转换器补丁里补一个空 `reasoning_content`。

**⇒ KI 6 提出的两个可能，答案是「都不是」**：既不是「第二个平台侧丢失点」，也不是「平台侧无可修点」。它是**协议缺口**，且**平台侧可修**。

### KI 7 的状态：**仍未达成（第二次）**

原文：「本批未做真实网关回放……**如实标注为未达成**」。

PL-M17 把它写进判据 **17c** 并尝试补做，**再次未达成**——不是没做，是**做不成**：验证时网关的 thinking 规则窗口没有开启（`probe-n6-gateway-rule.ts` 连跑 20 轮，R1 全部 200）。探针**如实报告了这一点**（`rule did NOT fire in 20 rounds`），没有把 R7 的 200 冒认成通过。

**⇒ 真实网关上的修法验证，至今仍是一次都没做成的。** 探针已留在仓库（`packages/agent-core/scripts/probe-n6-gateway-rule.ts --rounds N`），窗口开启时重跑即可。

### 附带：本文件 Known Issues 5 的状态

原文：「两处丢失点只是『已定位的两处』，不是全部……**没有机制保证**将来新增的重建点会遵守（无 lint 规则、无类型约束）」。

**该风险本批未被触发**（复发成因不在这条链上），**但也没有被消除**——「重建消息必须保留 `additional_kwargs`」的不变量化按 `docs/181` §7 第 6 项**未做，另立议题**。**维持登记。**

### 再追加（2026-10-18，L1-M4i 批次收尾后）

上节末句「**真实网关上的修法验证，至今仍是一次都没做成的**」**在结论上仍未改变**，但**已有真实链路的旁证**：**L1-M4i 批次（E1×3 执行 2/3、因配额中止）里 N-6 零出现**——全批 **76 个 agent run（全部 succeeded）**，`reasoning_content` 400 **零条**（全库仍 22 条，未增）。**这不等于 17c 达成**：批次期间**未连续探测**网关的 thinking 规则（该规则分钟级翻转，批前 10:05 实测 R1=400、10:25 实测 R1=200），故**不能断言条件被行使过**。探针仍在仓库，**窗口开启时重跑即可**（必须显式 `--out`）。正本：`docs/182` 末尾勘误追加块、`docs/146` §3 的 N-6 行。
