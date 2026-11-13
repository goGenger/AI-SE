# 267 · 规划 / 测试质量 / 评审证据合同 skills

> 状态：**已落地**（2026-11-12 Asia/Shanghai）。本轮只新增三份框架无关的 common skills，并接入 `resolveSkills` 声明式注入。未改 `.env`、沙箱镜像、产品 Playwright 钉版，未删 backend / database agent 实现，也未改 taskflow-vue。

相关前文：[docs/252](./252-agent-skills.md)、[docs/265](./265-visual-intent-gate.md)。结构原则借鉴 Superpowers `writing-plans` / `test-driven-development` / `verification-before-completion`、Matt Pocock `to-tickets` / `tdd`、Addy Osmani `code-review-and-quality`（只取「小步可验证、测试须能证明行为、没有客观证据不能自称完成」），正文为平台原创，未搬开源工作流。不把强制红绿重构、人工追问循环、仅限 git PR 的审查仪式或安全审计剧本写进合同。

---

## 1. 为什么补这三块

实现、夹具、调试和视觉契约已经按能力面声明式注入。空着的是规划、测试质量和评审：这三段几乎不注 skill，却决定基线会不会被静默跳过、测试会不会自相矛盾或空断言、评审会不会只看智能体自报。

这三份都是通用合同，正文不得点名具体 UI 框架或组件库。Vue 夹具 / 实现 / 视觉落地 skill 继续各司其职，本轮不新增 frontend-vue skill 文件。

## 2. 三份合同

正文在 `packages/agent-core/skills/common/<id>/SKILL.md`。

| id | 核心规则 |
| --- | --- |
| `planning-intent-contract` | 只规划当前 `capabilityProfile` 启用的 agent / 任务类型；缺关键页和关键态 UI 基线必须点明，不得假装已有；拆成带依赖、可独立验收的小切片；官方 E2E / 视觉审查放在切片末或 CI |
| `test-quality-contract` | 测试必须能证明行为；不得用空断言、互相矛盾的用例、改验收标准或改文案刷绿；按任务/切片收窄，中途不回退全量测试命令；Playwright 版本和浏览器安装留给平台契约。`vue-test-fixture` 仍只负责装配 |
| `review-evidence-contract` | 官方 E2E 和官方视觉门禁才是真相来源，不是自报成功；缺基线、业务页直接使用组件库默认皮肤、或规定关键态打不开，都是失败；审查设计意图而非像素级差分；缺少证据就失败或阻塞，不得找借口通过 |

规划合同用「当前能力面是否启用 backend / database 工作」来写，不在 skill 正文里点名某个 profile。默认 `frontend-vue` 下，派发层本来就会拒掉这两类任务；合同要求规划阶段也不要再发明它们。

## 3. 注入矩阵

任务类型以 `packages/shared` 的 `TaskTypeSchema` 为准。职业规划 agent（`PLANNER`）承接的是 **`ANALYSIS` / `DESIGN`**，平台没有 `PLAN` 或 `PLANNER` 任务类型。测试是 `TEST`，评审是 `REVIEW`。

`resolveSkills` 按声明注入（模型不自选），经 `AgentRegistry.resolveTask` → `formatInjectedSkillsBlock` 拼进系统提示：

| 条件 | 新增注入 | 仍保留的既有注入 |
| --- | --- | --- |
| `ANALYSIS` 或 `DESIGN`（任意 profile） | `planning-intent-contract` | 无 Vue pack |
| `TEST` + `frontend-vue` | `test-quality-contract` | `vue-test-fixture` |
| `TEST` + 非 Vue profile | `test-quality-contract` | 无 Vue pack |
| `REVIEW`（任意 profile） | `review-evidence-contract` | 无视觉合同（评审看官方门禁结果，不在实现任务上重注视觉 mapping） |
| `FRONTEND` / `DEBUG` + `frontend-vue` | 无这三份 | `visual-intent-contract` + `vue-visual-contract` + 既有实现/夹具/修复 skill |
| `SPEC_CONFLICT` | 无这三份（不比既有 `vue-test-fixture` 绑得更宽） | 仅 `vue-test-fixture` |
| `BACKEND` / `DATABASE` | 无这三份 | 无 |

本轮不把 `test-quality-contract` 打进全部 `DEBUG`，以免把与测试无关的前端修复也淹没在测试质量合同里。Playwright 钉版与防空烧仍由平台强制执行，不写成 skill 去让智能体在沙箱里升级或装浏览器。

需求级 / 切片级 / 任务级规划图（`PlanningAgent`）走自己的 prompt，不经过 `resolveSkills`。同一份 `planning-intent-contract` SKILL.md 已由 `planningIntentContractBlock` 注入该规划图（见 [docs/268](./268-planning-graph-intent-contract.md)）。

## 4. 相关

- `docs/252-agent-skills.md`：frontend-vue 实现 / 夹具 / 修复 skill 绑定表。
- `docs/265-visual-intent-gate.md`：通用视觉契约 + frontend-vue 落地 skill，以及官方视觉门禁。
- `docs/264-platform-playwright-browser-contract.md`：Playwright / 浏览器由平台契约负责。
- `docs/268-planning-graph-intent-contract.md`：同一份规划合同注入需求/切片/任务规划图，以及能力面、基线缺口、命名检查的硬校验。
