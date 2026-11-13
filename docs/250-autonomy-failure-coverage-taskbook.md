# 250 · 自治失败覆盖扩展任务书（Workflow Failure → Autonomy Repair）

> 状态：**已裁定并落地**（实施记录 `docs/251-autonomy-failure-coverage.md`；全量 M1–M5）。
> 产品口径（用户 2026-11-05）：**只要在工作流过程中，平台自己重试后仍然失败的问题，都应归入自治**（诊断 → 修复任务 → 再跑），而不是停给人点「重试」。
> 依据：`docs/57`（failure recovery）、`docs/99`/`docs/100`（人工重试）、`docs/154`/`docs/227`（自治 L1/L2）、`packages/shared/src/gateFailureRepair.ts`（已落地：门禁/QA 证据 → REPLAN）、taskflow-vue 真实事故（exit 127、darwin/linux 原生包、TASK-06 自报成功但 AC 红）。
> 编号：里程碑 **AFC-M1 … AFC-M5**；验收 **AFC-1 … AFC-10**。实施记录预留 `docs/251`。
> 约束：主线 `frontend-vue`；保持 OpenCode（`LLM_PROVIDER=openai`）；不改 DeepSeek 直连；不自动开 E1/backend-node 评测批；生产 DEPLOY 审批**不**绕过。

---

## 0. 一句话目标

把「工作流内、平台已重试仍失败」的失败，统一收敛到**同一条自治修复链**；客观证据优先于 Agent 自报；修复轮次耗尽才终态，并给出可读原因。

---

## 1. 基线事实（2026-11-05 实查 + 真实交付）

| 事项 | 现状 | 含义 |
| --- | --- | --- |
| 客观门禁 | `TaskVerifier` 按 profile 跑 build/lint/test；`VERIFICATION_GATE` 默认多为 observe，L1/切片策略可 enforce | 只覆盖「命令跑红」，盖不住自报 SUCCESS |
| QA/REVIEW | Agent 自跑四门禁并 `submit_result`；「Approval withheld」≠ 平台审批实体 | 长失败正文若未标 FAILED，可能不进修复 |
| 切片策略 | 已改为 `SLICE_WORKFLOW_POLICY`：`REPLAN` + `allowReplan` + `maxRetries:2`；旧 FAIL_FAST 切片可被 router 升级 | **仅覆盖带失败证据的任务失败** |
| `gateFailureRepair` / `failureRouter` | 有报错证据 → REPLAN；耗尽 → FAIL；生产 DEPLOY 不绕过 | 已具备「失败 → 修」骨架 |
| 原生依赖 | Mac `node_modules` 绑进 Linux 沙箱曾缺 `@rollup/rollup-linux-*`；已加 probe/`--no-save` heal | 环境类失败仍可能复发，需进自治而非人肉 |
| TASK-06 事故 | Agent 自报交付成功，正文承认 AC-12 红 + `storage.service` TS2307；**未触发 REPLAN** | **自报 SUCCESS + 客观红灯**是当前最大漏洞 |
| Agent 超时 | 约 900s 掐断 → 任务失败；旧 FAIL_FAST 下需人点重试；重试常很快过 | 超时属可恢复失败，应进自治（有限次） |
| 人工重试 | `docs/99`：FAILED 工作流可手动重排 | 自治补齐后，人工重试是兜底，不是主路径 |

**结论**：门禁/QA 证据路径已部分接通；缺口是——**凡「平台重试后仍失败」未统一入自治**，尤其是自报成功、超时、环境/依赖、片间规格冲突。

---

## 2. 产品原则（冻结候选，推荐全部采纳）

| # | 原则 | 推荐 |
| --- | --- | --- |
| P1 | 工作流内，**平台自动重试耗尽后仍失败** → 必须进入自治修复链（REPLAN/DEBUG→工作类型修复→重验） | ✅ |
| P2 | **客观证据优先于自报**：type-check / lint / test / build / Verifier 红灯 ⇒ 任务不得以 SUCCESS 落盘 | ✅ |
| P3 | 失败原因全文（stdout/stderr/审批正文/超时码）写入修复任务输入，禁止空修复 | ✅ |
| P4 | 修复有硬上限（与切片 `maxRetries` 对齐或显式配置）；耗尽 → 终态 FAILED + 可读 `FAILURE_ROUTED(repair-exhausted)` | ✅ |
| P5 | **仍须人工**：生产 DEPLOY 审批、需求级产品冲突裁决（PRD/TRD）、配额耗尽需人换钥、修复耗尽后的终态确认 | ✅ |
| P6 | 不做第二套引擎；复用 `failureRouter` + REPLAN + `TaskVerifier` + 既有事件模型 | ✅ |

---

## 3. 必须纳入自治的失败类（本任务书范围）

| ID | 失败类 | 典型信号 | 期望自治动作 |
| --- | --- | --- | --- |
| F1 | 客观门禁红灯 | npm/pnpm type-check/lint/test/build 非 0；Verifier failedChecks | FAILED → REPLAN（FRONTEND/BUILD…）→ 重跑门禁 |
| F2 | 依赖/环境 | exit 127、空 `.bin`、缺原生 optional dep、Node 过旧、`DEPENDENCIES_MISSING` | 修复任务优先「重装/补平台包/对齐 Node」再重验 |
| F3 | QA/REVIEW 不通过 | Approval withheld、REPLAN_REQUESTED、长失败正文 | 视为 GATE_FAILURE → 修复 → 重跑 QA |
| F4 | **自报 SUCCESS 但客观红** | submit SUCCESS 但同工作区门禁或任务声明的测试未绿（TASK-06 类） | Verifier/收尾闸强制 FAILED → 进 F1 链 |
| F5 | Agent 运行超时 | 约 900s（或配置值）掐断；平台级任务重试仍失败 | 计入失败证据 → REPLAN 或有限次换策略重跑（见 §5 D3） |
| F6 | 工具/瞬时错误耗尽 | 网关 5xx、sandbox 拉起失败、短时 ECONNRESET 等，平台 retry 用尽 | 同上进入 REPLAN；区分「可修代码」vs「基础设施」事件 |
| F7 | 片间/规格互斥 | 同仓测试互相矛盾（foundation 禁 LS vs 持久化要 LS）；修复一轮后仍同错 | 修复任务显式「对齐本片 AC + 更新过时规格」；可升为 DEBUG 说明冲突源 |

**不在本任务自动绕过**：生产 DEPLOY 审批、关口 1 产品范围（属 L2 契约）、用户明确拒绝的审批。

---

## 4. 里程碑

### AFC-M1 — 客观收尾闸（优先，配额紧时只做这一刀）

- 任务落盘前（至少 FRONTEND/BUILD/TEST/QA）：跑（或复用刚跑过的）type-check/lint/test/build 证据。
- 自报 SUCCESS 但任一 enforce 检查红 → 覆盖为 FAILED，附 `failureCode` + 日志尾，走既有 `gateFailureRepair`。
- 单测：SUCCESS+红灯 ⇒ FAILED；SUCCESS+全绿 ⇒ SUCCESS；生产审批路径不变。

**验收**：AFC-1、AFC-2。

### AFC-M2 — 失败类标签与路由表

- 统一 `errorType` / `failureCode`：`GATE_FAILURE`、`DEPENDENCIES_MISSING`、`AGENT_TIMEOUT`、`INFRA_RETRY_EXHAUSTED`、`SPEC_CONFLICT`（可枚举扩展）。
- `failureRouter`：按标签选 `fixTaskType` 与提示模板（安装修复 vs 代码修复 vs 规格对齐）。
- 事件：`FAILURE_ROUTED` payload 含标签、证据摘要、attempt。

**验收**：AFC-3、AFC-4。

### AFC-M3 — 超时与平台重试耗尽

- Agent 超时、执行器/sandbox 短重试耗尽后，进入自治而非仅人工 `POST /retry`。
- 明确与「任务级 maxRetries」「工作流 REPLAN maxRetries」的计数关系（禁止无限套娃）。
- 可选：对纯超时且无代码变更的首次 REPLAN 使用「续跑/升温」提示，降低重复烧额度。

**验收**：AFC-5、AFC-6。

### AFC-M4 — 环境/原生依赖自愈升级

- 固化 probe：工作区 `node_modules` 存在但沙箱平台三元组不匹配 → 必须 heal/重装，不得跳过。
- 将「heal 失败」提升为 F2 证据进入 REPLAN（而非静默后让 QA 再报一次）。

**验收**：AFC-7。

### AFC-M5 — 可观测与控制台

- 需求/工作流详情展示：当前是否在自治修复、第几轮、失败类、最新证据一行。
- 修复耗尽时展示明确文案（非空白 FAILED）。

**验收**：AFC-8、AFC-9。

（全里程碑回归冒烟：AFC-10。）

---

## 5. 待裁定决策（开工前冻结；推荐值如下）

| # | 决策点 | 推荐值 | 备选 |
| --- | --- | --- | --- |
| D1 | 客观闸默认强度 | 切片工作流 **enforce**；手工非切片保持现状 | 全局 enforce（可能影响旧脚本流） |
| D2 | 自报 SUCCESS 但红灯 | **强制 FAILED + REPLAN** | 仅记警告（否决：无法满足产品口径） |
| D3 | Agent 超时后 | 计入平台失败；若工作流仍有 REPLAN 预算 → 自治修复/重跑；**不**无限加长单次墙钟 | 默认已提到 **1800s**（2026-11-06）；加长不替代自治 |
| D4 | REPLAN 预算 | 保持切片 `maxRetries: 2`（约 2 轮）；耗尽终态 | 提到 3（配额紧不建议） |
| D5 | 基础设施失败（Docker/磁盘） | 打 `INFRA_*` 事件 + 有限次 REPLAN；仍失败则终态并提示人检查环境 | 一律人工 |
| D6 | 是否本周做全量 | **配额紧：只合并 AFC-M1 + 最小 M2 标签**；M3–M5 下迭代 | 一次做完（token 高） |

---

## 6. 非目标

- 不绕过生产 DEPLOY 审批。
- 不引入第二套工作流引擎 / 新表（除非事件字段不够且报告证明）。
- 不自动开 E1/backend-node 大批次；验证以单测 + 1 次前端切片冒烟为准。
- 不把「需求未分析 / 关口 1 未批」塞进本任务的修复链。
- 不保证像素级 UI；失败修复以门禁与 AC 证据为准。

---

## 7. 验收清单

| ID | 验收项 | 通过标准 |
| --- | --- | --- |
| AFC-1 | 自报 SUCCESS + test/type-check 红 | 任务 FAILED，出现 `FAILURE_ROUTED` / REPLAN，不出现「成功交付但门禁红」静默 |
| AFC-2 | 自报 SUCCESS + 门禁全绿 | 仍 SUCCESS，无多余修复 |
| AFC-3 | QA Approval withheld + 正文 | 进修复链，修复任务输入含正文摘要 |
| AFC-4 | exit 127 / 缺原生包 | 标签为依赖/环境类；修复提示含 install/heal |
| AFC-5 | Agent 超时且重试预算尽 | 进自治或明确终态事件；不必人先点工作流重试才能动 |
| AFC-6 | 计数不爆炸 | 单切片修复轮次 ≤ 配置上限；有单测锁死 |
| AFC-7 | 跨 OS node_modules | probe 失败会 heal 或进 F2，不再「有目录就跳过」 |
| AFC-8 | UI 可见修复中 | 详情能看到修复轮次/失败类（M5） |
| AFC-9 | 耗尽可读 | 终态原因含 repair-exhausted 与最后证据 |
| AFC-10 | 生产审批 | 自动化用例证明 PRODUCTION 仍 WAITING_APPROVAL |

---

## 8. 建议实施顺序（省配额）

1. **先评本任务书 §5 决策表**（用户一句「按推荐」即可）。
2. 实现 **AFC-M1**（客观收尾闸）+ **AFC-M2 最小标签**（GATE / DEPS / TIMEOUT）。
3. 单测绿；**不**开过夜真实交付批。
4. 用 taskflow-vue 类失败做一次**针对性重放**（或夹具）验证 AFC-1/AFC-4。
5. 配额宽裕再做 M3–M5。

预估（工程量，非承诺）：M1+最小 M2 ≈ **0.5–1 天**；M3–M5 另计。OpenCode token：以单测为主则低；避免反复真跑整单切片。

---

## 9. 开工前必读代码

- `packages/shared/src/gateFailureRepair.ts` 与 autonomyPolicy / SLICE_WORKFLOW_POLICY
- `apps/server/src/services/verifyingTaskExecutor.ts`、`taskVerifier.ts`、`workflowTaskExecutor.ts`
- `packages/workflow-engine`：`handleFailures` / FailureRouter
- `apps/server/src/index.ts`（failureRouter 接线）
- 相关单测：`gateFailureRepair`、`outcomeRouting`、`autonomyPolicy`

---

## 10. 报告要求（实施阶段）

实施记录写 `docs/251-autonomy-failure-coverage.md`，固定节：范围、决策落地、改动文件、验收 AFC-1…、Known Issues、Risks（仓库无 git 时用文件时间清单）。

---

## 11. 用户确认栏

- [x] §2 原则 P1–P6 按推荐采纳
- [x] §5 D1–D5 按推荐；D6 用户覆盖为全量 M1–M5
- [x] 全量 M1–M5 已实施（见 docs/251）

确认后复制本任务书分割线以下（若拆执行指令版）或直接回复「按推荐，先做 M1」开工。
