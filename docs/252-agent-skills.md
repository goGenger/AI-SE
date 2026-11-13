# 252 · Agent Skills（frontend-vue 声明式注入）

> 状态：**已落地**（2026-11-09 Asia/Shanghai）
> 动机：生成质量不能只押大模型；在进模型前用短 skills 钉住 Vue/Pinia/夹具/anti-tamper 约定。
> 素材：改编自 [vuejs-ai/skills](https://github.com/vuejs-ai/skills)（MIT），**未**整包 vendor / 未 `npx skills add`。

---

## 1. 目的

Skills = 执行 harness 的一层：按 **任务类型 / 失败类 / 能力面** 声明式注入，**模型不自选**。

与现有门禁、写权限、`TEST_FIXTURE_GAP` / `SPEC_CONFLICT` 分流同产品线。

## 2. 绑定表

| 条件 | 注入 |
| --- | --- |
| `FRONTEND` + `frontend-vue` | `vue-implement` + `vue-test-fixture` |
| `TEST` + `frontend-vue` | `vue-test-fixture` |
| `DEBUG` 或 `failureClass=TEST_FIXTURE_GAP` | `vue-test-fixture` + `vue-debug-repair` |
| `failureClass=SPEC_CONFLICT` | **仅** `vue-test-fixture` |
| 非 `frontend-vue` | 无 |

正文落在 `packages/agent-core/skills/frontend-vue/*/SKILL.md`；解析与注入：`skillResolver.ts` → `AgentRegistry.resolveTask` 拼接 `## Injected skills`。

视觉/组件契约 skills（通用 `visual-intent-contract` + frontend-vue 落地 `vue-visual-contract`）见 [docs/265](./265-visual-intent-gate.md)，同样由 `resolveSkills` 声明式注入，不在上表展开。

规划 / 测试质量 / 评审证据合同（通用 `planning-intent-contract`、`test-quality-contract`、`review-evidence-contract`）见 [docs/267](./267-planning-test-review-contracts.md)，由 `resolveSkills` 声明式注入：`ANALYSIS`/`DESIGN`、`TEST`、`REVIEW`。同一份规划合同进入需求/切片/任务规划图的路径见 [docs/268](./268-planning-graph-intent-contract.md)。不在上表展开。

REPLAN/DEBUG 任务会从源任务 `output.failureClass`（或已有 `input.failureClass`）拷进 `input`，供失败类绑定生效。

## 3. 从 vuejs-ai 借用 / 丢弃

**借用（压缩进三条 skill）：** Composition API + SFC 顺序、Pinia `getActivePinia` / `storeToRefs` / setup store 返回状态、Router 参数变更需 `watch`、VTU `flushPromises` + 测试里安装 Pinia/Router、少量响应式调试点。

**丢弃：** Options API / JSX skill、SSR/Nuxt 长文、Playwright E2E 选型长文、大段 reference 目录、社区安装器格式。

## 4. 非目标（本轮）

- Skills 管理页 / CRUD UI（下一步只读预览即可）
- MCP 绑定进 skill
- React skills
- 自动重试工作流

## 5. 下一步

任务详情只读展示「本任务已注入：…」；管理页后置。

## 6. 相关

- `docs/265-visual-intent-gate.md`：设计意图视觉/组件契约 skills 与后续官方视觉门禁方案。
- `docs/267-planning-test-review-contracts.md`：规划、测试质量与评审证据合同 skills 及注入矩阵。
- `docs/268-planning-graph-intent-contract.md`：规划合同注入需求/切片/任务规划图，以及配套硬校验。
- `docs/253-docs-gap-routing.md`：README/docs 断言 → `DOCS_GAP` → BUILD（与 frontend-vue skills 分流，不混进 FRONTEND 空烧）。
- `docs/254-env-gap-routing.md`：Playwright/浏览器缺失 → `ENV_GAP` → BUILD（禁止 FRONTEND 空烧）。
- `docs/255-env-gap-install-and-scoped-test-gates.md`：ENV_GAP 安装超时/缓存 + TEST AC 分段门禁。
