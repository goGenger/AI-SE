# Phase 5.7-4 Evidence & Verification — Completion Report

> 项目:AI-SE(Evidence & Verification / 统一证据)
> 阶段:Phase 5.7-4(Evidence & Verification)
> 状态:**PASS**
> 完成日期:2026-09-13
> 开发模式:ponytail(单一证据模型 + 复用 5.7-0 Observation / ActionResult / actionRef,零第二套审计/验证引擎)+ 以代码为准
> 参考:docs/17 §5.7-4、docs/24、docs/43(5.7-0)、docs/52/53(5.7-1)、docs/54(5.7-2)、docs/55(5.7-3)

---

## 1. Status

**PASS** — 任务书 §2~§10 与 docs/17 §5.7-4 六项全部达成;真实 E2E:

```text
Action
  ↓ before observation(真实 Observation / 真实外部数据)
Execute(经既有 ToolRuntime → Browser / MCP)
  ↓ after observation(真实)
Verification(before / after / expected → VERIFIED | FAILED)
  ↓
EvidenceRecord(migration 009,PostgreSQL)
  ↓
Evidence API(list / detail,最小 REST 面)
```

- Browser 与 External 使用**同一 Evidence 模型**;before/after 均为真实捕获数据
  (浏览器 arm = 真实 Chromium Observation;外部 arm = 真实 MCP 数据)。
- Approval denied / 失败路径:`Failure → FAILED Evidence 保留失败事实`(见 §7)。
- 全仓四门禁 exit 0(§9)。

```text
Browser Action ─┐
                ├→ EvidenceCapture(before → action → after → screenshot)
External Action ┘        ↓                    ↓
                 buildEvidenceDraft   verifyActionEvidence(真实数据)
                         ↓                    ↓
                    redaction sink → EvidenceRecordDraft(冻结契约校验)
                         ↓
              PgEvidenceRepository(migration 009)→ /api/evidence
```

## 2. EvidenceRecord(契约,复用优先)

`packages/shared/src/index.ts` 追加 **Phase 5.7-4 Evidence Contract** 块(纯 schema,零行为改动),
全部复用既有定义、零新 id 体系:

| 字段                                                     | 来源                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `actionRef`                                              | **5.7-0 `ExternalActionRefSchema` 原样复用**(browser / mcp / sandbox 三臂)                                         |
| `before` / `after`                                       | `EvidenceSnapshotSchema`:`observation`(5.7-0 `ObservationSchema`)或 `result`(真实外部数据,untrusted data),必填其一 |
| `result`                                                 | **5.7-0 `ActionResultSchema` 原样复用**                                                                            |
| `screenshotRef`                                          | `screenshot://` 前缀锁定(5.6-3 Artifact 管线)**大图只存引用,零内联字节**                                           |
| `externalId`                                             | 外部系统对象 id(如 `ISS-101`)                                                                                      |
| `workflowRunId` / `taskId` / `agentRunId` / `toolCallId` | 既有 id 关联(无新 id 体系)                                                                                         |
| `verification`                                           | `EvidenceVerificationSchema`(见 §4)                                                                                |
| `id` / `createdAt` / `updatedAt`                         | 归持久化(`EvidenceRecordDraftSchema = omit`)                                                                       |

- strict:未知字段拒绝;`screenshotBase64` 之类内联字节直接解析失败(测试锁定)。

## 3. Evidence Persistence(新 migration 009)

`packages/database/migrations/009_phase5_evidence.sql`:

- 表 `evidence_records`:`project_id`(FK,级联)+ `workflow_run_id` / `task_id` / `agent_run_id`(FK,SET NULL)
  - `tool_call_id VARCHAR(160)` + `action_ref` / `before_snapshot` / `after_snapshot` / `result` / `verification` JSONB
  - `external_id` + `screenshot_ref`(仅引用);
- 索引:`(project_id, created_at DESC)` / `workflow_run_id` / `task_id`;`set_updated_at()` 触发器(phase5 惯例);
- checksum/文件清单由既有 `migrate.ts` 机制覆盖,`migrate.test.ts` 文件清单断言已加入 `009_phase5_evidence.sql`;
- 仓储 `PgEvidenceRepository`(`create` / `findById` / `findMany` 按 project / workflowRun / task / toolCall 过滤);
- 写入内容 = builder 已脱敏 + 已过冻结契约的 draft(repo 保持薄);读回与写入全等(测试锁定)。

## 4. Verification(before / after / expected → VERIFIED | FAILED)

新包 **`@ai-se/evidence`**(packages/evidence,依赖仅 shared + observability):

| 文件             | 职责                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/verify.ts`  | `verifyActionEvidence`:固定 verdict 词表 **VERIFIED / FAILED** + 逐条 findings(结构化对照,不新建评分体系——延续 5.6-4 思想,放弃其 fix-loop 三态词表) |
| `src/capture.ts` | `captureActionEvidence`(before → act → after → screenshot 真实编排)+ `buildEvidenceDraft`(verify + 脱敏 + 冻结契约校验)                             |
| `src/redact.ts`  | **单一脱敏 sink**:对每个字符串先 `redactCredentialShapedText` 再 `redactString`(均来自 `@ai-se/observability`),有界递归(深度 10 / 8000 节点)        |
| `src/index.ts`   | barrel                                                                                                                                              |

冻结 expectation 词表(3 类,strict):

- `action-succeeded` — 动作自身 ActionResult 必须 success;
- `contains` — **AFTER 快照**必须包含该值(DOM/a11y 文本或外部 result 数据);
- `changed` — AFTER 快照内容必须与 BEFORE 不同(比较内容投影,忽略 observationId/callId/时间戳等易变身份)。

Verification 只读**真实现场**(before/after 快照 + ActionResult),禁止:
Agent 自报成功 / 手工伪造 before / after / 用 ActionResult 替代真实 Observation
(测试锁定:verdict 由证据推导;失败时 findings 逐条保留)。

## 5. Browser 五步链(真实 Chromium)

`apps/server/src/__tests__/evidenceLifecycle.e2e.test.ts`:

```text
browser.observe(before,真实 Observation)
  → browser.action.click(经 ToolRuntime,真实 Chromium)
  → browser.observe(after,真实 Observation)
  → browser.action.screenshot(5.6-3 资产管线 → screenshot:// 引用)
  → verification(VERIFIED)
  → EvidenceRecord 持久化(真实 PostgreSQL)
```

- 断言:before 计数 `0` / after `1`(真实数据流);`screenshotRef` 命中
  `screenshot://browser:evidence:1/<seq>.png`;`workflowRunId` / `taskId` / `toolCallId`
  关联;click 的 `actionRef` 来自**动作自身的真实 ref**。

## 6. External 链(真实 MCP stdio)

```text
issues.list(before,真实 MCP 数据快照)
  → issues.create(经 ToolRuntime → MCPToolAdapter → 真实 stdio 子进程)
  → issues.list(after,真实数据:created issue 出现在列表中)
  → verification(VERIFIED;contains "ISS-101" + changed)
  → EvidenceRecord(externalId = "ISS-101")
```

- mock 外部系统(5.7-2 fixture)**升级为进程内有状态**:create 后 list 可见
  (fresh 进程 id 仍确定性:`ISS-101`);外部返回始终是 DATA,不构成指令。
- E2E 断言 before/after 列表真实变化(`ISS-1, ISS-2` → `ISS-1, ISS-2, ISS-101`)。

## 7. Failure 证据(失败事实保留)

- **动作失败**(browser `#missing` / external `issues.fail`):ActionResult = failed,
  after 快照照常捕获 → findings `[false, false]` → **FAILED** 入库,`result.error.code` 保留;
- **期望未达成**(动作成功但 `contains "count: 99"` 不成立):findings `[true, false]` → **FAILED**,
  after 快照仍记录真实变化(`1`)——**失败也是事实,不伪装成成功**。

## 8. Security(凭据隔离)

- Evidence 内容全量过 §4 单一 sink(既有 `redactCredentialShapedText` + `redactString`,零新规则、零新 Secret Store);
- 凭据零明文锁定面:`EvidenceRecord` / before / after / result / API response / 数据库行
  (E2E:凭据经**真实 MCP 流**进入 issue 标题 → 快照中只能是 `[REDACTED]`;
  raw SQL 直读 `before_snapshot::text / after_snapshot::text / result::text` 无原文);
- API 层:跨项目读取 → **403 `EVIDENCE_ACCESS_DENIED`,响应体零证据载荷**;未知 id → 404;
  非法 id/查询 → 400。零新 auth 系统:复用平台既有 project 作用域模型 + 既有 `AppError(403)` 模式。

## 9. API(最小查询面)

`apps/server/src/routes/evidence.ts` + `services/evidenceService.ts`:

- `GET /api/evidence?projectId&workflowRunId&taskId&toolCallId&limit` — list(>200 上限钳制);
- `GET /api/evidence/:id?projectId` — detail(带 scope 时校验归属);
- 只读面,无管理后台扩展(capture 持久化由服务端链路调用 `EvidenceService.create`)。

## 10. E2E 与回归

| 套件                                    | 结果                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `evidenceLifecycle.e2e.test.ts`(server) | 6/6 — 真实 Chromium + 真实 MCP stdio + 真实 PostgreSQL(成功 / 动作失败 / 期望未达成 / 外部成功 / 外部失败 / 凭据隔离) |
| `evidenceApi.e2e.test.ts`(server)       | 5/5 — 真实 PG:list 过滤 / detail / 跨项目 403 零泄漏 / 404 / 400 / 凭据已脱敏                                         |
| `evidenceRepository.test.ts`(database)  | 4/4 — migration 009 幂等 / 全契约形状读写 / 关联与过滤 / 零内联截图字节                                               |
| `evidence.test.ts`(evidence 包)         | 9/9 — verdict / findings / changed 内容投影 / 脱敏 sink / capture 编排与失败事实                                      |
| `evidenceContract.test.ts`(shared)      | 7/7 — 契约 strict / 快照非空 / 词表冻结 / VERIFIED⇔findings 一致性                                                    |
| 5.7-1 / 5.7-2 / 5.7-3 回归              | browser 38/38(含 5.7-1 安全 E2E)、mcp 235/235(含 5.7-2 E2E)、action-policy 13/13、server 68/68(含 5.7-3 审批链 E2E)   |
| 全仓四门禁                              | `pnpm -r typecheck / lint / test / build` 全部 exit 0,测试 **646/646,0 failed**                                       |

Architecture 红线复核:Evidence 只记录事实,不含 retry / re-plan / recovery / approval lifecycle /
action policy 逻辑;无 Evidence Runtime / Evidence Workflow / 第二套 Audit / 第二套 Verification Engine;
未实现任何 5.7-5 面(失败分类冻结表 / re-observe / retry orchestration / re-plan / human intervention)。

## 11. Known limitations

1. **敏感输入的原始值不进入 Evidence 的强保证来自分层脱敏**:浏览器层(5.7-1 结构化屏蔽)、
   MCP 层(5.7-2 untrusted data 脱敏)、Evidence sink(本阶段)。E2E 断言的是**组合保证**
   (各层各自有单独测试;Evidence sink 的独立覆盖在 `evidence.test.ts` 与 API E2E)。
2. **`changed` 期望只比内容投影**(DOM 节点 role/name/text + a11y tree + result 数据);
   纯视觉像素级 before/after 差异未纳入(5.6-4 像素评估面未接线,任务书未要求)。
3. **外部 before/after 快照依赖调用方显式编排**(先 list 再 act 再 list 的模式);
   没有自动推断"该观察什么"的能力(属 5.7-5 re-observe 范畴)。
4. **Evidence API 为只读最小面**;写路径仅服务端内部(避免未授权写入面),无分页游标(limit 钳制 200)。
5. 浏览器截图引用绑定 session 生命周期(5.6-3 内存资产),持久层只存引用不存字节——
   跨进程恢复截图需要资产层扩展(超出本阶段范围)。

## 12. 修改/新增文件

- 契约:`packages/shared/src/index.ts`(追加 Evidence 契约块)、`packages/shared/src/evidenceContract.test.ts`(新)
- 新包:`packages/evidence/{package.json,tsconfig.json}`、`src/{verify.ts,capture.ts,redact.ts,index.ts}`、`src/__tests__/evidence.test.ts`
- 持久化:`packages/database/migrations/009_phase5_evidence.sql`(新)、`src/evidenceRepository.ts`(新)、`src/evidenceRepository.test.ts`(新)、`src/index.ts`、`src/migrate.test.ts`
- 服务端:`apps/server/src/services/evidenceService.ts`(新)、`src/routes/evidence.ts`(新)、`src/app.ts`、`src/index.ts`、`package.json`
- E2E:`apps/server/src/__tests__/{evidenceLifecycle,evidenceApi}.e2e.test.ts`(新)
- fixture:`packages/mcp/src/testing/external-system-entry.js`(issues 状态化,零断言破坏)
- 零改动红线:5.7-0 Contract / 5.7-1 / 5.7-2 / 5.7-3 历史报告与核心实现未改。

**完 —— 本阶段到此 STOP,不进入 5.7-5。**
