# 269 · frontend-vue 把 API 层规划成前端封装

> 状态：**已落地**（2026-11-12 Asia/Shanghai）。本轮纠正了「消费 API = 跳过或裁掉 `api_spec`」的误读：`frontend-vue` 仍然规划 API 层，但规划的是前端接口封装，权威输入是 TRD / 已提供的 API 契约 / 封装示例。不得发明服务端接口，也不得排出 BACKEND / DATABASE 任务。未改 `.env`、沙箱镜像、产品 Playwright 钉版，未删 backend / database agent 实现，也未改 taskflow-vue。

相关前文：[docs/268](./268-planning-graph-intent-contract.md)、[docs/235](./235-capability-profile-design.md)、[docs/233](./233-frontend-dynamic-workflow-platform.md)。

---

## 1. 口径

用户明确：`frontend-vue` 必须能处理 API 层，处理的是前端的接口封装。TRD 里常常会写出封装示例，前端任务要按示例落地。不能因为 `FRONTEND_VUE_PROFILE.specs.consume` 含 `API`，就把 API 相关规划阶段整段裁掉。

| 能力面 | `specs` | `api_spec` 阶段 | 行为 |
| --- | --- | --- | --- |
| `frontend-vue` | `consume: ["API"]`，不 generate API | **仍然运行** | 消费 TRD / API 契约 / 封装示例，规划前端封装与页面对接。不发明服务端接口，不排出 BACKEND / DATABASE 任务。 |
| `backend-node` | `generate` 含 `API`，`consume` 为空 | 仍然运行 | 保持既有「生成一份接口规格」行为。 |

若一个 profile 同时 generate 与 consume API，以 generate 为准，避免破坏 backend-node 路径。能力面合同本身不变：API 仍是输入，不是后端生成物。

---

## 2. 提示词与阶段接线

`apiSpecPrompt({ profile })` / `architecturePrompt({ profile })` 按当前 profile 分支。`PlanningGraph` 的两级（`level2`）与单级（`full`）路径都会跑 `architecture` → `api_spec`，并把 `capabilityProfile` 传入这两个阶段，接法与任务规划相同。

消费模式（提示词）：

- 角色是前端 API 封装规划，不是去设计一套后端服务；
- `providedTechnicalDocs` 与 TRD 封装示例是权威输入，不得矛盾或默改；
- 用 `encapsulation`（`source` / `client` / `pages` / 可选 `notes`）写下前端如何封装、接到哪些页面；
- `endpoints` 只列文档或 PRD 里已经写明的接口；
- 没有契约时，空 `endpoints` 是正确答案；只按 PRD/TRD 实际写到的范围规划薄封装，并在 `apiContractGaps` 记下缺口。记下缺口即可继续规划，不得假装契约已有。

生成模式：沿用原来的 API designer 提示词，不引入封装或缺口字段要求。

架构阶段只做了与同一口径相关的、按 profile 分支的收窄：在消费 API 或未启用数据层时，描述前端应用结构（含客户端 / 封装层），不得发明后端服务、数据库或服务端接口。`backend-node` 的架构提示词不变。任务规划在消费模式下追加一句：封装与页面对接按 FRONTEND 任务落地，不得发明服务端 API，也不得规划 BACKEND / DATABASE。可规划类型的硬校验仍然有效。

---

## 3. 硬校验与提示词

| 规则 | 硬校验 | 提示词 |
| --- | --- | --- |
| `api_spec` 在 `frontend-vue` 下仍运行 | 是（构图未跳过该节点；用例断言阶段事件）。 | 消费模式提示词明确本阶段的职责。 |
| 消费模式下不得发明未在文档 / PRD 中出现的服务端端点 | 是。`validateConsumedApiSpec`：端点 path 必须能在 `providedTechnicalDocs` 或需求正文里找到（`{id}` / `:id` 会归一化）。生成 API 的 profile 不走这条校验。 | 消费模式提示词禁止虚构服务端接口。 |
| 缺少 API 契约时不把规划卡住 | 是。空 `endpoints` 通过；发明无依据端点失败。记下 `apiContractGaps` 即可继续。 | 与 `visualBaselineGaps` 同构：记录缺口，不假装契约已有，也不因缺契约拒绝出计划。 |
| 不得排出 BACKEND / DATABASE 任务 | 是。沿用既有 `validatePlannableTaskTypes`。 | 切片与任务提示词继续列出当前 profile 的可规划类型；任务提示词在消费模式下再点明封装归 FRONTEND。 |
| 架构不发明后端服务 | 否（提示词约束）。组件是否「后端」难以稳定判定，故不做模糊硬拦截。 | 消费 / 无数据层 profile 使用收窄后的架构提示词。 |

`ApiSpec` 新增两个可选字段：`encapsulation`、`apiContractGaps`。旧的「只含 endpoints」规格仍然合法，backend-node 夹具不必改。权威输入仍是用户提供的技术文档，不得与之矛盾；冲突继续走既有 `technicalDocumentConflicts` / 人工裁决。官方 E2E 时机、Playwright 钉版、防空烧、视觉基线缺口和命名检查均未减弱。

---

## 4. 本轮没有做的

- 不把 `FRONTEND_VUE_PROFILE.specs.consume` 改成 generate，也不宣称 API 不再是输入。
- 不按 `specs.generate` 从规划图里拆掉 `api_spec` 或 `architecture`。
- 不把 `encapsulation` / `apiContractGaps` 写成独立数据库列；它们随 API 规格 JSON 落库。
- 不对架构组件名称做硬拦截，也不把 Playwright 钉版、防空烧或官方 E2E 时机写成新 skill。
- 不新增 skills 管理页、React / backend / database skills、Figma MCP，也不改产品视觉风格。

---

## 5. 相关

- `docs/235-capability-profile-design.md`：能力面契约；`consume: API` 的本意是输入，不是跳过阶段。
- `docs/268-planning-graph-intent-contract.md`：规划合同注入与视觉 / 命名检查硬校验。
- `docs/229-phase-doc-intake-taskbook.md`：提供的技术文档是权威输入。
