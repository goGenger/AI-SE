# 230 · 文档入口实施记录（PRD / 技术需求文档以文件进入系统）

> 阶段：**D1 文档入口** ｜ 任务书 **`docs/229`**（§6 八项按推荐值裁定）｜ 用户 2026-10-23「都按推荐值，开始实现」
> 验收编号：**D1-1 … D1-8** ｜ 验收落点：`docs/17` 新增「文档入口」节

---

## 1. Modified Files

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `packages/shared/src/index.ts` | 修改 | `REQUIREMENT_CONTENT_MAX_CHARS = 200_000`（`rawContent` 上限 2 万 → 20 万）；`RequirementDocumentKindSchema`、`RequirementDocument`、`RequirementDocumentsView`、`ProvidedTechnicalDocument`；`RequirementAnalysisSchema` 增**可选** `technicalDocumentConflicts` |
| `packages/database/migrations/018_phaseD1_requirement_documents.sql` | 新增 | `requirement_documents`（含 `raw_bytes` 原件、`content_text`、`truncated`、PRD 部分唯一索引）+ `requirements.documents_changed_at` |
| `packages/database/src/requirementDocumentRepository.ts` | 新增 | 落库 / 列表 / 规划读取 / 删除 / 查找 |
| `packages/database/src/planningRepositories.ts` | 修改 | `updateRequirementContent`（文件 PRD 回写 `raw_content`）、`touchDocumentsChanged`、`documentsChangedAt`、`latestAnalysisAt` |
| `packages/database/src/migrate.test.ts` | 修改 | 17 → **18**；文件清单 +1；`at(-1)` 同步 |
| `packages/agent-core/src/planning/PlanningGraph.ts` | 修改 | 图状态新增 `providedTechnicalDocs`；`inputForStage` 与两个入口都带上它（与 `requirement` 并列） |
| `packages/agent-core/src/planning/PlanningAgent.ts` | 修改 | `PlanningAgentRunOptions.providedTechnicalDocs`，透传到两级/单级图 |
| `packages/agent-core/src/planning/prompts/provided-documents.prompt.ts` | 新增 | **权威输入**约束句（唯一一处措辞来源） |
| `packages/agent-core/src/planning/prompts/{technical-spec,architecture,api-spec,database-spec,requirement-analysis}.prompt.ts` | 修改 | 拼接上述约束句 |
| `apps/server/src/services/documentExtraction.ts` | 新增 | md / txt / docx 抽取；二进制伪装拒绝；空文档拒绝；超长截断 |
| `apps/server/src/services/documentService.ts` | 新增 | 上传（含 PRD 回写）、列表（含 `planningStale`）、删除、规划输入投影 |
| `apps/server/src/routes/documents.ts` | 新增 | `POST/GET /api/requirements/:id/documents`、`DELETE /api/documents/:id`（raw body，零 multipart 依赖） |
| `apps/server/src/app.ts` / `src/index.ts` | 修改 | 装配 DocumentService 与路由 |
| `apps/server/src/services/planningService.ts` | 修改 | 规划前读取技术文档并作为 `providedTechnicalDocs` 传入；两处规划路径都发 `TECHNICAL_DOCUMENT_CONFLICTS` 事件 |
| `apps/web/src/api/requirements.ts` | 修改 | 列表 / 上传（raw body）/ 删除三个客户端函数 |
| `apps/web/src/views/RequirementsView.vue` | 修改 | 新建需求支持上传 PRD 文件；详情页新增「技术文档」分区（上传/列表/删除/截断标记）、规划过期提示、冲突列表 |
| `apps/web/src/__tests__/requirementsView.test.ts` | 修改 | `maxlength` 断言 20000 → 200000 |

---

## 2. Implementation

### 2.1 三条硬约束的落点

1. **技术文档绝不进 `rawContent`**（任务书 §2）：`PlanningGraph.inputForStage` 里两者是并列字段；测试同时断言「每个阶段的输入都带 `providedTechnicalDocs`」与「`requirement` 序列化后不含文档正文」。
2. **文件 PRD 才写 `rawContent`**：`DocumentService.upload` 在 `kind === "PRD"` 时调用 `updateRequirementContent`，AC/FR 解析器因此看到的仍是同一处文本。
3. **PRD 至多一份**：`018` 的部分唯一索引 `WHERE kind = 'PRD'`，仓储侧在插入前删除旧 PRD（同一事务），避免「哪份算数」无法回答。

### 2.2 上传协议：为什么是 raw body

单文件上传用 raw body + query 元数据（`kind` / `fileName`），**不引 multipart 解析依赖**；浏览器 `fetch(url, { body: file })` 可直接使用。`limit` 设为 6 MB 而服务侧上限 5 MB —— 让「太大」由我们自己给出可读原因，而不是 express 的裸错误。

### 2.3 docx 解析

用 `mammoth`（任务书 §6 第 3 项 A）。测试里用**手搓的真实 ZIP + OOXML**（`deflateRawSync` + CRC32 + 中央目录）走通全链，不 mock 解析器——`AGENTS.md` §7 要求核心链路真实验证。

### 2.4 「规划过期」的判定

`requirements.documents_changed_at` 由**任何一次上传或删除**推进（删除不会改变其它行的 `created_at`，只看文档表无法察觉），与 `latestAnalysisAt`（`MAX(specifications.created_at)`）比较得出 `planningStale`。

### 2.5 两个入口，而不是一个

**修正**：第一版只把技术文档入口放在「需求详情」抽屉里，用户 2026-10-23 实看后指出
「新建需求时只有填 PRD 的地方」。正确的落点有两个：

1. **新建需求弹窗**（用户实际会找的地方）：PRD 可粘贴或上传文件；技术需求文档（TRD）可**多选**上传，
   创建成功后按「PRD → 各技术文档」顺序立即上传；
2. **需求详情抽屉**：后续补传 / 删除 / 查看截断与规划过期状态，以及冲突列表。

### 2.6 上传区的样式（用户 2026-10-23 反馈「两个上传框太丑」）

原生 `<input type="file">` 在本项目里必然难看——`apps/web` **未启用 Tailwind preflight**
（`styles/README.md` §0），UA 的按钮外观不会被清掉。改为新的共享组件
**`components/common/FileDropzone.vue`**，只保留原生控件作语义载体（`sr-only`，键盘可达）：

| 状态 | 表现 |
| --- | --- |
| 静止 | `bg-card` + `border-dashed border-input`（表单域允许线，房规例外） |
| 悬停 / 拖拽悬停 | 只走**色调台阶**（`bg-muted` / `bg-primary-light`），不加阴影、不加渐变 |
| 键盘焦点 | `focus-within:ring-2 ring-ring`，与 `Input` 同一套焦点语言 |
| 已选文件 | 逐条列出文件名 + 体积，可逐项移除；多选时持续追加 |
| 禁用 | `opacity-60` + 不响应拖拽 |

三处入口统一用它：新建弹窗的 PRD、新建弹窗的 TRD（多选）、详情页的补传。
详情页原来的「还没有上传任何文档。」空态与拖拽区文案重复，已删除。

### 2.7 冲突上报

`RequirementAnalysisSchema` 新增**可选** `technicalDocumentConflicts`（`.strict()` 下可选字段是向后兼容的加法）；规划提示词要求「记录冲突而不是自己选边」；`planningService` 在**两级与单级两条路径**上都发 `TECHNICAL_DOCUMENT_CONFLICTS` 事件。

---

## 3. Architecture Changes

- **新增一张表**（`requirement_documents`）与**一个需求级时间戳列**（`documents_changed_at`）。
- **规划输入多了一条通道**（`providedTechnicalDocs`），与 `rawContent` 并列而非合并——这是本阶段最重要的架构边界。
- **没有**新增审批 / 审计 / 错误码体系；上传失败走既有 `AppError` 封套。

---

## 4. Dependencies

| 依赖 | 变化 | 理由 |
| --- | --- | --- |
| `mammoth` | **新增**（`apps/server`） | .docx 解析；任务书 §6 第 3 项已裁定接受 |
| 其它 | 无 | 上传不引 multipart |

---

## 5. Tests

| 包 | 新增 | 内容 |
| --- | --- | --- |
| `apps/server` | `documentExtraction.test.ts` **7 例** | md/txt 归一化、真实 docx、二进制伪装、坏 docx、空文档、超长截断、格式白名单 |
| `apps/server` | `requirementDocuments.api.test.ts` **5 例** | 上传/列表不带正文、文件 PRD 回写 `raw_content`、不支持的扩展名、`planningStale`、删除后变化标记 |
| `packages/database` | `requirementDocumentRepository.test.ts` **4 例** | 真 postgres:16：落库/列表、只返回 TECHNICAL 正文、PRD 唯一与替换、删除幂等 |
| `packages/agent-core` | `PlanningGraph.test.ts` **+1 例** | 每个阶段输入都带技术文档，且 `requirement` 里不含文档正文（反向对照） |

---

## 6. Lint / 7. Typecheck

见 §8 的全仓门禁表。

**实施中一次自我更正**：`documentExtraction.ts` 的 BOM 正则最初写成了字面 BOM 字符，`no-irregular-whitespace` 报错——改为 `\uFEFF` 转义（测试里的输入字符串同步改为转义）。

---

## 8. E2E / 全仓门禁

**全仓门禁（阶段收尾，显式退出码）**：

| 命令 | 结果 |
| --- | --- |
| `-r run typecheck` | **TYPECHECK_EXIT=0** |
| `-r run lint` | **LINT_EXIT=0** |
| `-r run test` | **TEST_EXIT=0** — **1944/1944 通过**，16 个包全绿零失败 |

各包读数：`agent-core` **269**、`server` **370**、`database` **52**、`shared` **178**、`web` **505**、
`mcp` **235**、`visual` **83**、`workflow-engine` **68**、`eval` **65**、`browser` **38**、
`tool-runtime` **32**、`failure-recovery` **16**、`action-policy` **13**、`evidence` **9**、
`sandbox` **8**、`observability` **3**。

迁移已应用到开发库：`{"applied":["018_phaseD1_requirement_documents.sql"]}`。

---

## 9. Known Issues

1. **没有用真模型跑过一次**：`D1-5`（文档进入规划）与 `D1-6`（冲突上报）由**图输入断言 + 提示词约束**覆盖，但「模型是否真的按文档规划、是否真的产出冲突」没有真实读数。任务书 D1-6 要求「conflicts 非空并落事件、页面可见」——事件与展示都已接好，**缺一次真实规划回放**。
2. **失败形态**：如果创建需求成功但 PRD 文件上传失败，需求会带着占位正文 `（PRD 由文件导入：…）` 存在。前端已提示错误，用户可在详情页重新上传；**没有做自动回滚**（回滚需要删除需求，代价更大）。
3. **PDF 未支持**（任务书 §6 第 2 项已裁定不做）。
4. **删除文档不删除原件以外的任何东西**；`requirement_documents` 无软删除，删除即物理删除。

---

## 10. Acceptance Result

| 判据 | 结果 |
| --- | --- |
| D1-1 三格式上传抽取 | ✅ 单元 7 例（含真实 docx） |
| D1-2 文件 PRD 落 `raw_content` | ✅ API 用例断言正文含 `AC-01` |
| D1-3 技术文档不进 `raw_content` | ✅ 图输入反向对照 |
| D1-4 超长截断并告知 | ✅ 单元用例 + `truncated` 落库与前端标记 |
| D1-5 技术文档标为权威并进规划 | ✅ 输入断言 + 提示词；⚠️ 无真实模型读数 |
| D1-6 冲突上报 | ⚠️ 契约、事件、页面齐备；**未用真模型验证产出** |
| D1-7 加文档后标记规划过期 | ✅ API 用例 |
| D1-8 存量行为不变 + 全仓门禁 | 见门禁表 |

**判「已实施、单测与门禁通过；真实模型回放未做」，不判「已关闭」。**

---

## 11. Next Phase Boundary

**未开始事项（STOP）**：

1. **一次真实规划回放**（带一份技术文档，核对产出是否引用文档、冲突是否上报）——需要配额与一次规划运行。
2. PDF 支持（已裁定不做，留作后续）。
3. 上传失败时的事务回滚（Known Issue 2）。
