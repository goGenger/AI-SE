# 241 · F1 批次对比报告（`frontend-vue`；早期轮次 + round20 收口）

> **文档性质**：对比报告。对齐两轮 F1 批次的读数、失败点与结论。
> 上游：`docs/235` §6.8（第一轮）、`docs/236`–`docs/240`（沙箱开网四步）。
>
> **一句话结论**：两轮都没通过，但**失败点在移动**——第一轮死在平台门（slice-4 防篡改），
> 第二轮死在 agent 输出质量（testid 命名自创、配置写错）。**开网不是本轮变差的原因**，
> 它在本轮一次都没被触发（下详）。

---

## 1. 两轮的基本读数

| 指标 | 第一轮（`docs/235` §6.8） | 第二轮（本轮） | 变化 |
| --- | --- | --- | --- |
| 结束方式 | 自然跑完 | **`runTimeoutMs` 触发**（90 分钟/切片） | ⚠ 变差 |
| 总耗时 | 4h25m | **2h14m**（批处理墙钟） | 更短但被切断 |
| 到达切片 | 4 / 5 | **2 / 4** | ⚠ 变差 |
| 任务（SUCCESS/FAILED） | 47 / 7 | 21 / 4（+1 RUNNING +2 PENDING 随取消中止） | — |
| 输入 token | 78.07M | **28.75M** | 更少 |
| 假阳性 | **0** | **0** | ✅ 持平 |
| 链完成 / 交付 / staging 段 | 全 false | 全 false | 持平 |
| 失败分层（规划/门/agent） | 0 / 2 / 5 | 0 / 3 / 1 | 主体从 agent 移到门 |
| 解析降级 | 1 | 0 | ✅ 改善 |

**注意 1**：两轮的切片总数不同（第一轮 5 片、本轮 4 片）——`docs/235` §6.8 的"4/5"与
`docs/233` §6.2 要求的"4 个切片"统计口径不同。本报告按**实际到达的切片**比较，不按比例。

**注意 2（记账口径）**：`run-1.json` 里的 `durationMs = 1,687,950`（28 分钟）**不是本批总耗时**。
`harness.ts:911-919` 只累加**有 `finishedAt` 的已完成工作流**；slice-2 被 CANCELLED
（`finishedAt` 有值但状态非完成），实际被跳过。按库内 `started_at` 重算：

| 切片 | 墙钟 |
| --- | --- |
| slice-1 | 28 分钟（07:12:59 → 07:41:07 UTC） |
| slice-2 | **92 分钟**（07:45:55 → 09:18:11 UTC，撞满 90 分钟 `runTimeoutMs`） |

**这本身是一条记账缺陷（已登记 N-59）**：`durationMs` 在批次被超时/取消终止时会严重低报
（本例 28 分钟 vs 实际 120 分钟，低报 **4.3 倍**），任何"耗时"口径都不能直接用它。

---

## 2. 逐切片对齐

| 切片 | 第一轮 | 第二轮 | 判读 |
| --- | --- | --- | --- |
| slice-1 foundation-list | ✅ 16/16 | ✅ **7/7** | 持平（两轮全绿） |
| slice-2 create-task | ✅ 10/10 | ⚠️ 15 成功 / **4 失败**，REPLAN 链未收敛 | ⚠ **本轮退步** |
| slice-3 | ✅ 11/12 | 未到达 | — |
| slice-4 | ❌ 防篡改门拦下 | 未到达 | — |

**唯一可直接对比的退步点是 slice-2**（上轮全绿、本轮 4 个失败）。

---

## 3. 本轮的 4 个失败：两个根因

### 3.1 根因 A：testid 命名自创（影响 3 条 Must）

PRD 第四节给的是定值表，并明写「命名不得自创、不得改写」：

| PRD 要求 | agent 实际写的 |
| --- | --- |
| `task-done-toggle` | `task-toggle` |
| `task-delete-button` | `task-delete` |

oracle 的实测证据（AC-23 的 Tab 顺序里直接看得到真实 testid）：

```
["search-input","filter-all","filter-active","filter-done","new-task-button",
 "task-toggle","task-delete","task-toggle","task-delete","task-toggle","task-delete", ...]
                            ↑ 应为 task-done-toggle / task-delete-button
```

后果是连带的：

| AC | 失败表现 | 真实原因 |
| --- | --- | --- |
| AC-16 | 点不到 `task-done-toggle`（30s 超时） | 元素存在，名字不对 |
| AC-17 | 完成后刷新不保持 | 上一条点不到 ⇒ 状态从未写入 |
| AC-18 | 点不到 `task-delete-button`（30s 超时） | 元素存在，名字不对 |

**功能是实现了的**（按钮渲染出来了，也能 Tab 到），只是名字与契约不符。这是**契约违背**，
不是能力缺失。

### 3.2 根因 B：新建后排序错（1 条 Must）

AC-08 要求新任务出现在列表**首位**，实测：

```
["Alpha task","Beta task","Gamma task","Write docs"]   ← 新任务在末尾
```

agent 自述里写的是「appends the task returned by the 201」（追加），而 AC 要求的是前插。
**自述与 AC 不符，且 agent 没发现自己违背了**。

### 3.3 本轮 slice-2 的 4 个任务级失败

| 任务 | 失败码 | 内容 |
| --- | --- | --- |
| `T-03` | `VERIFICATION_FAILED` | REVIEW 指出 `vitest.config.ts` 把插件工厂当值传（`vuePlugin as never`，没调用 `vue()`）⇒ `.vue` 永远编译不了；上游因此**绕开 SFC** 改用 `.ts` 视图 |
| `T-04` | `VERIFICATION_FAILED` | `test/fr2-create-task-dialog.spec.ts:421` 有 `any` 类型错误 ⇒ **全仓 `pnpm typecheck` 退出 2** |
| `T-03-DEBUG-1` | `VERIFICATION_FAILED` | 修复链未收敛 |
| `T-04-DEBUG-1` | `VERIFICATION_FAILED` | 修复链未收敛 |

共同结构：**一个任务留下的错误会污染后续所有任务**（`typecheck` / `test` 是全仓的），
而 REPLAN 链每修一次就消耗一次预算，最终撞上 `runTimeoutMs`。

---

## 4. 第一轮的失败（作为对照）

`docs/235` §6.8：slice-4 的两个 TEST 任务把**错误的契约写进了受保护文件**——一个断言把列表
顺序写错、一个用 `test.fails(...)` 把缺陷钉成"预期失败"。修复任务只能改测试 ⇒ 撞防篡改门
⇒ REPLAN 耗尽 ⇒ 整片 FAILED。

**那是门在正确工作**，不是平台缺陷。据此加了 `TEST_CONTRACT_CONSTRAINT`（`docs/235` §6.9）。

**本轮的验证结果**：这条约束**没有被证伪**——本轮根本没走到 slice-4，所以它是否有效仍然未知。

---

## 5. 开网在第二轮的实际作用：**零**

这是本报告最需要说清的一条，因为它关系到"四步开网工作是否值得"。

| 证据 | 读数 |
| --- | --- |
| `ai-se-registry` 访问日志（本批时段） | **零请求**（只有我自己的健康探针） |
| 本批含 `install` 的工具调用 | 5 条，全部是 `run_build` 跑项目 `deps` 脚本 |
| `node_modules` 来源 | 镜像**预热**（`pnpm store`），不是 registry |

原因（已在 `docs/239` §4.2 记）：

```
run_build 跑 projects 的 deps 脚本 → resolved.command = "pnpm run deps"
  ↓ isDependencyInstallCommand("pnpm run deps") = false
network = none ⇒ 脚本内部的 pnpm install 在无网容器里跑 ⇒ 只能命中预热
```

所以：**开网链路本身是通的**（`docs/240` §2.2 实测：真实依赖 `none` 装不上、`registry` 5.1s
装成），但**本轮批次没有用到它**。本轮与第一轮在这条上完全等价。

> **不要把本轮的失败归因于开网，也不要把本轮的成功归因于开网——它没参与。**

---

## 6. 结论

### 6.1 平台在改善的部分

| 项 | 证据 |
| --- | --- |
| 策略（REPLAN 可兑现） | 第一轮 4 次 REPLAN 全部实际执行 |
| 规划（骨架落工作类型） | 两轮均未再现"任务写给谁都不对"的失败 |
| 验证（vitest 按作用域 AC） | 两轮均无 Node 契约类假失败 |
| 假阳性 | 两轮均为 **0** |
| 沙箱能力（加固 + 出网） | 已实现，本轮未触发 |

### 6.2 平台仍缺的部分

| 缺口 | 本轮证据 | 归谁 | 编号 |
| --- | --- | --- | --- |
| **契约违背不可检测** | testid 自创 → 3 条 Must 失败 | agent 侧（提示词），不是门 |
| **错误跨任务传染** | 一个 `any` 让全仓 `typecheck` 挂 | 平台侧（增量检查？） |
| **单切片预算** | slice-2 的 REPLAN 链吃满 90 分钟 | 平台侧（`runTimeoutMs` 口径） |
| **脚本内安装无网** | `deps` 脚本走预热 | 沙箱侧（`docs/239` §4.2） |
| **停止脚本假成功** | `http=000` 仍打 "done" | 工具侧（`f1-frontend-stop.sh`） |

### 6.3 与 `docs/233` §6.2 第 5 条的距离

| 判据 | 第一轮 | 第二轮 |
| --- | --- | --- |
| 4 个切片走通 | 否（3/4） | 否（2/4） |
| 逐任务门无 Node 契约类假失败 | **是** | **是** |
| CI + staging deploy + staging verify | 未到达 | 未到达 |

**两轮都没达成 5 条判据，且第二轮更远。**

---

## 7. 建议的下一步（未执行，等你裁定）

按「先修再跑」的既有纪律（`fix-known-defects-before-batches`），下一批之前应至少处理：

| 优先 | 项 | 理由 |
| --- | --- | --- |
| **P0** | testid 契约违背 | 3 条 Must，且可检测（AC 文本里已是定值表）——可加一条**局部**校验：任务声明的 testid 必须逐字来自 PRD 表 |
| **P0** | `runTimeoutMs` 口径（**N-60**，**已修**） | 裁定「按任务计时」：预算 = max(下界, 任务数 × 6 min)，每轮重算 |
| P1 | 错误跨任务传染 | `typecheck` / `lint` 是**全仓**的，一个任务的遗留错误会判死后续所有任务。可考虑只检查任务自己写的文件 |
| P2 | 停止脚本的假成功（**N-58**，**已修**） | 根因是 `.env` 的 `PORT=3000` 覆盖了批处理端口；现已 source 后赋值 + 回读库 + 非零退出 |
| P3 | 脚本内安装无网（**N-57**，**已修**） | 把脚本展开一层判定脚本体；真实链路双向实测（授权 → verdaccio 有请求，不授权 → `EAI_AGAIN`） |
| P3 | `durationMs` 低报（**N-59**，**已修**） | 未完成片按 now 计入 + 批次墙钟兜底，新增 `incompleteWorkflows` 标注 |

> 上述任一项都**没有开工授权**。这是建议清单，不是计划。

---

## 8. 第三轮（2026-10-29，24 分钟，**被上游 429 终止，不是有效读数**）

第四步修复 N-58/59/60 之后的验证批次。**结论：这轮不能用来验证 N-60。**

| 项 | 读数 |
| --- | --- |
| 结束方式 | slice-1 的 `T7`（REVIEW）撞 **429 限流** ⇒ REPLAN/DEBUG 链三次全撞 ⇒ 整批 1/5 切片 |
| 耗时 | 24 分钟（09:15:14 → 09:39:05） |
| 到达切片 | **1 / 5** |
| oracle | 19/24，Must 失败 4（`AC-08` / `AC-16` / `AC-17` / `AC-18`） |
| 失败分层 | 规划 0 / 验证门 0 / **agent 3（全部 `LLM_ERROR`）** |

### 8.1 三条修复的验证状态

| 修复 | 验证到 | 依据 |
| --- | --- | --- |
| **N-59**（耗时低报） | **是** | `durationMs = 22.5 min`，实际墙钟 24 min，吻合；第二轮是 28 vs 120 |
| **N-60**（按任务计时） | **否** | slice-1 有 11 个任务 ⇒ 预算 `max(90, 66) = 90 min`，实际只用 22.5 min 就因 429 死掉，**全程没有预算压力** |
| N-58（停止脚本） | 未涉及 | 只在停止批次时生效；已用死端口双向测过 |

### 8.2 新发现：N-61（已登记）

上游说的是 `retry shortly (after 21 s)`，而平台**6 秒内跑完三次完整 agent_run**：

| 任务 | 开始 | 结束 | 耗时 |
| --- | --- | --- | --- |
| `T7` | 01:37:39 | 01:37:41 | 1.6s |
| `T7-DEBUG-1` | 01:37:42 | 01:37:43 | 1.0s |
| `T7-DEBUG-1-DEBUG-2` | 01:37:43 | 01:37:45 | 1.6s |

机制：`AgentGraph.ts:172-186` 的重试循环**两次尝试之间无等待**，`onRetry` 只计数不延迟，
provider 层无任何退避代码。详见 `docs/232` §10 N-61。

**后果**：一次瞬时容量波动被放大成整片失败；REPLAN 把基础设施故障当任务质量故障处理，
白烧 3 次调用；失败还被记进 `failureLayers.agent`，归因指向错误的层。

### 8.3 N-61 的修复（2026-10-29）

已按 `docs/232` §10 落地：重试先分类、可重试类按「`min(30s, max(上游 Retry-After, 2s×2^(n-1)))`」
退避、累计退避上限 90s、耗尽后标 `details.reason = PROVIDER_UNAVAILABLE`。

用**真实 429 样张**验证编译产物：

```
真实 429 样张 → {"kind":"rate-limit","retryable":true,"retryAfterMs":21000}
第一次重试等待 = 21 s（原实现 0s）
401 → {"kind":"not-retryable","retryable":false}
未知错误 → {"kind":"transient","retryable":true}
```

**补做（同日）**：标记原本在半路丢失（`workflowTaskExecutor` 的 `output` 是白名单，
不铺开 `outcome.metadata`）。现已接通三处——共用常量、output 点名转发、
`WorkflowEngine.handleFailures` 在 `PROVIDER_UNAVAILABLE` 时**改判 RETRY**（不造 DEBUG 诊断任务），
额度用尽则如实终结并点名原因。批次层验证仍待上游健康的窗口。

### 8.4 对「距离交付」判断的影响

第三轮说明：**在限流状态下跑批次，读数会被外部因素主导**。N-60 需要一个上游健康的窗口才能验。
不建议在 429 高发期重跑。

---

## 9. 第四轮（2026-10-29，4 小时 42 分，**首个进入 slice-4 的批次**）

修完 N-57/58/59/60/61 之后的验证批次。**结论：这个窗口里没有出现任何 429，N-61 没有被触发；
N-60 与 N-57 都在真实链路上留下了证据。**

### 9.1 基本读数

| 指标 | 第一轮 | 第二轮 | 第三轮 | **第四轮** |
| --- | --- | --- | --- | --- |
| 结束方式 | 自然跑完 | `runTimeoutMs` | 429 全片死 | **slice-4 超时**（其余三片通过） |
| 到达切片 | 4 / 5 | 2 / 4 | 1 / 5 | **4 / 5** |
| 通过的切片 | 3 | 1 | 0 | **3** |
| 任务（SUCCESS/FAILED） | 47 / 7 | 21 / 4 | 少 | **51 / 3** |
| 假阳性 | 0 | 0 | 0 | **0** |
| 失败分层（规划/门/agent） | 0 / 2 / 5 | 0 / 3 / 1 | 0 / 0 / 3 | **0 / 1 / 2** |
| `LLM_ERROR` | — | — | **3** | **0** |
| 失败码 | — | — | `LLM_ERROR`×3 | `VERIFICATION_FAILED`×1 + `REPLAN_REQUESTED`×2 |
| 耗时 | 4h25m | 2h14m（被切断） | 24m | **4h42m**（`durationMs=16,945,131`，与墙钟一致） |

### 9.2 逐切片

| 切片 | 状态 | 任务 | 耗时 | 失败 |
| --- | --- | --- | --- | --- |
| slice-1 foundation-list | ✅ SUCCESS | 11/11 | 38 min | 0 |
| slice-2 create-task | ✅ SUCCESS | 19（16 好 / 3 失败） | 91 min | `T-10` VERIFICATION_FAILED；`T-12` / `T-12-REPLAN-1` REPLAN_REQUESTED |
| slice-3 search-filter | ✅ SUCCESS | 12/12 | 55 min | 0 |
| slice-4 toggle-delete-resilience | ⏱ TIMEOUT（12 好 / **0 失败** / 3 未完成） | 15 | 被 90 min 切断 | — |

### 9.3 三条修复各自的验证结果

| 修复 | 验证 | 依据 |
| --- | --- | --- |
| **N-60**（按任务计时） | **是** | slice-2 用时 **91 分钟**，REPLAN 把任务数推到 19 ⇒ 预算 `max(90, 114)=114`。第二轮同一片在固定 90 分钟被切断；本轮跑完且 SUCCESS。**多出来的 1 分钟就是旧口径的死刑线。** |
| **N-57**（脚本内安装） | **是** | 全批沙箱侧 registry 请求 **762 次，全部落在 03:15:40–03:18:10 这 2.5 分钟**——正是 `pnpm run deps` 那 3 次调用的窗口；pnpm 自报 `downloaded … reused 0`。第二轮同期**零请求**。 |
| **N-61**（429 退避） | **无法验（未触发）** | 全批 **0 个 `LLM_ERROR`**，上游一次 429 都没给。不是「修好了」，是「这一轮没用到」。 |

> N-61 的判据仍然成立但未被证伪：它要的是「限流期间不 1 分钟连撞 3 次」，而本轮没有限流。
> 下一批如再遇 429，按 `docs/232` §10 N-61 的标记 (`details.reason=PROVIDER_UNAVAILABLE`) 查库即可。

### 9.4 仍然卡住的是同一件事：testid 契约违背

oracle **20/24**，Must 失败 4 条，全部同一个原因：

| AC | 失败表现 |
| --- | --- |
| AC-07 / 08 / 09 / 10 | `waiting for getByTestId('task-title-input')` 超时 |

应用里实际的 testid 是 **`new-task-title`**，PRD 要求 `task-title-input`。
这与第二轮根因 A（`task-done-toggle` → `task-toggle`）**是同一类**：功能实现出来了，名字不符合契约。

顺带发现残留：`toggle-task-button` / `delete-task-button` 各 2 处与正确的
`task-done-toggle` / `task-delete-button` **并存**——说明改写时留下了旧副本。

**这一条是当前距离交付的最大单点**，且 `docs/241` §7 早已把它列为 P0，一直没做。

### 9.4.1 补修（2026-10-29，同日）：`testid-contract` 边界门

洞的位置很精确：`ui-smoke` 的判据是「**AC 文本点名的** testid 在不在页面上」，而 `task-title-input`
在整份需求里**只出现 1 次**——在第四节的定值表里（`| \`task-title-input\` | … |`），
**没有任何一条 AC 提到它**。所以那道门对它视而不见。

新增的判据方向相反：**源码里不得出现需求没声明过的 testid**。它不看 AC、不需要起进程，
因此在任何切片边界上都成立。校准结果：

| 对象 | 违规 |
| --- | --- |
| F1 参考实现 | **0** |
| 第四轮 agent 产物 | **1**（`new-task-title` @ `src/components/NewTaskDialog.vue`） |

详见 `docs/232` §10 N-64。按这条门，第四轮的 slice-2 边界就会判失败并触发 REPLAN，
而不是把问题一路带到 oracle。

### 9.4.2 真根因（2026-10-29 第五轮）：**脱敏把 PRD 的 testid 吃掉了**（N-65）

第五轮 slice-1 失败时，REVIEW 的原话是：

> The literal for that row is **redacted in every artifact I may read** (task context, PRD text,
> lint allow-list lines 55/56/61, and even lint failure output).

`CREDENTIAL_SHAPED_PATTERN` 里的 `sk-[A-Za-z0-9_-]{8,}` 把 `ta` + `sk-title-input` 当成了
OpenAI 密钥。对真实 PRD 跑现成的 `sanitizeLogData`：**22 个契约名里正好丢掉 3 个**——
`task-title-input` / `task-done-toggle` / `task-delete-button`，而它们正是每一轮失败的三个。
`task-item`（`sk-item` 只有 4 字符）等其余 19 个安然无恙，并且每一轮都被正确实现。

**「testid 自创」不是 agent 粗心，是平台把它要读的名字抹掉了。** 已修（`sk-` 分支放过 kebab 词组），
详见 `docs/232` §10 N-65。

### 9.5 本轮新发现

| 编号 | 内容 | 后果 |
| --- | --- | --- |
| **N-62** | harness 判超时后**不取消**工作流（`harness.ts:621-623`） | 批次打印 `run 1 done` 时 slice-4 仍在 `RUNNING`，手工 cancel 才停 |
| **N-63** | 每任务 6 分钟的常数没有余量；任务数 ≥15 时预算退化为固定 90 分钟 | slice-4 **0 失败**却被切断，因为它是唯一「预算 = 下界」的切片 |

详见 `docs/232` §10。

---

## 10. 第六轮（2026-10-30，87 分钟，**首个 oracle 上 23/24 的批次**）

修完 N-64（契约门）、N-65（脱敏吃掉 PRD）、N-62（超时不取消）之后的验证批次。

### 10.1 读数

| 指标 | 第二轮 | 第四轮 | 第五轮 | **第六轮** |
| --- | --- | --- | --- | --- |
| oracle | 20/24 | 20/24 | —（1 片即止） | **23/24** |
| Must 失败 | 4 | 4 | — | **1** |
| 到达切片 | 2 / 4 | 4 / 5 | 1 / 5 | 2（slice-1 ✅ / slice-2 ❌） |
| 假阳性 | 0 | 0 | 0 | **0** |
| token 输入 | 28.75M | 71.79M | — | **18.20M** |
| 耗时 | 2h14m | 4h42m | ~90m | **87 min** |

### 10.2 三个修复的验证

| 编号 | 结论 | 依据 |
| --- | --- | --- |
| **N-65**（脱敏吃掉 PRD） | **✅ 证实** | 源码里 `task-title-input` / `task-done-toggle` / `task-delete-button` 全部写对；AC-07 / AC-09 / AC-10 由「元素点不到」变成**全部通过** |
| **N-64**（testid 契约门） | **✅ 跑通且无误伤** | slice-1 边界的 `testid-contract` 扫到 6 个名字、全部在契约内、`passed: true`（477ms）。slice-2 因工作流失败未到边界 |
| **N-62**（超时不取消） | **未触发** | 本轮无任何切片超时——没超时就验不到 |

> N-65 是本批最重要的一条：连续三轮栽在同一个名字上，修完脱敏后一次全绿。

### 10.3 最后的 Must 失败不在 agent 身上（N-66）

`AC-08: new task not first: ["Alpha task","Beta task","Gamma task","Write docs"]`。

查三处：PRD 的 AC-08 只说「列表新增一项、task-count 加 1」；`ac-map.md` 的证据列也没有顺序元素；
只有 `oracle.mjs:413-417` 要求 `seen[0] === "Write docs"`。而参考实现与 mock **都是前插的**——
oracle 与参考实现一致，缺的只是 PRD 那句话。

**裁定（用户 2026-10-30）：方案 A，补进 PRD**（而不是放松断言）。
`prd.md` 的 AC-08 已加「且新任务位于列表首位」，`fixture.json` 的 `requirementText` 由它重新生成
（`fixtures.test.ts:53` 守着两者逐字相同）。详见 `docs/232` §10 N-66。

### 10.4 slice-2 的失败链

`task-14`(TEST) 请求 REPLAN → `task-14-REPLAN-1`(FRONTEND) 去改
`src/__tests__/slice2-regression.spec.ts` → **防篡改门拦下**（`protected test files weakened`）
→ REPLAN-2 同样 → 整片 FAILED。

门是对的；问题在 REPLAN 把「改测试文件」派给了 FRONTEND 任务（N-22/N-11 家族），本轮不是主要矛盾。

---

## 11. 正式验收收口（round20，2026-11-03）

> 本节只记**收口事实**；早期轮次对比正文不变。勾选与约束见 `docs/17` F1 节；总表 `docs/146` §1.1。

| 指标 | round20（正式验收） |
| --- | --- |
| 墙钟 | ~168 分钟（2026-11-03 15:03→17:51 上海时区） |
| 任务 | SUCCESS×41；人工介入 1 |
| oracle | **24/24** |
| 假阳性 / 假阴性 | **0 / 0** |
| 链完成 / 真交付 / staging 段 | **100% / 100% / SUCCESS·SUCCESS·SUCCESS** |
| 归档 | `packages/eval/results/f1-frontend/round20/` |

**平台侧同期落地（非本对比表主体，但影响后续 REPLAN）**：

1. 矛盾期望门禁 `CONTRADICTORY_TEST_EXPECTATIONS` + `STATE_BOUNDARY_RE`（含 `.value=` / `setXxx(`）；
2. 门禁 P1：命中 → `fixTaskType=TEST` → DEBUG 改测 → 同契约 CI；2026-11-04 09:06 上海时区重启加载。

**约束**：F1 继续走 OpenCode（`.env` 勿改 DeepSeek 直连）；`f1-frontend-stop.sh` 停批；
单工作流 retry 冒烟 ≠ 正式 F1 分数。下一阶段：**Phase 8 AI SRE**（`docs/242`），不是 UI Phase 8。

