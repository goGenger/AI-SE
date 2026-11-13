# Phase 5.7-0 任务提示词 — Computer Use Contract(契约冻结)

> 使用方式:复制下方分割线内全部内容,作为 Phase 5.7-0 的执行指令。
> 沿用 5.6-0 成功模式:契约冻结、零行为实现、独立完成报告、完成后 STOP。
> 本提示词已按 AGENTS.md 校准;编码默认 ponytail + 以代码为准。

---

You are now implementing AI-SE Phase 5.7-0: Computer Use Contract.

本阶段唯一目标:在 `@ai-se/shared` 冻结 Phase 5.7 全阶段的**数据契约** —— GUI/Browser Action、Observation(DOM/Accessibility 双形态)、ActionResult、ExternalActionRef(browser / mcp / sandbox 三来源 discriminated union)、Cancellation / Timeout 语义。**零行为实现**:不做任何采集 / 执行 / 持久化 / 浏览器 / 网络行为;不安装 Playwright(已有)、不新增依赖、零 migration。

不要实现 5.7-1 Browser Computer Use(不 observe 不动作)、5.7-2 External Systems(不接外部)、5.7-3 Policy(不定级)、5.7-4 Evidence(不落库)、5.7-5 Recovery。
不修改 Phase 0~5.6 已冻结契约与测试基线;**shared 只允许本阶段加法式追加一个代码块,零既有结构修改**。

---

### 一、开始实现前必须先阅读

以代码为准,先阅读:

1. `docs/17-acceptance-checklist.md` §5.7-0(**六项** —— 见 §七验收对照)
2. 5.6-0 契约先例(必须同构的冻结模式)
- `packages/shared/src/index.ts` Phase 5.6-0 段:VisualInputType 枚举 + 前缀、
  VisualInputRecord(zod strict + validate)、UI Spec 四层、
  ComponentMapEntry(refine 不变量)—— **5.7-0 契约追加在同一文件的
  新代码块**,沿用 strict zod + 手写 URL 解析(无 DOM lib)惯例;
  测试追加 `packages/shared/src/computerUseContract.test.ts`(平级测试惯例
  以本仓库现状 `src/__tests__/` 为准,见 shared 现有测试位置)
3. 上游引用面(契约必须能承接它们的输出形状)
- `packages/browser/src/*`:BrowserSession 现有输出(NavigationResult /
  ConsoleEntry / ScreenshotAsset 命名)、7 个 ToolDefinition 的
  name/description/riskLevel(5.6-3 冻结)—— Observation/ActionResult
  必须能承载这些形状的**映射后数据**,而不是照抄 Playwright 类型
- `packages/workflow-engine/src/types.ts`:retryCount/policy.maxRetries、
  `WAITING_APPROVAL` —— ActionResult 的元数据面要能标注重试轮次
- `packages/mcp/src/contracts.ts`:MCP tool 调用输入输出面 —— ExternalActionRef
  的 mcp arm 必须能用 serverName/toolName/callId 描述一次调用
- `packages/sandbox/src/index.ts`:SandboxCommand/SandboxResult —— sandbox arm
  承接命令执行
4. 脱敏惯例
- `@ai-se/observability` 的 redactCredentialShapedText(契约字段注释标明
  "内容级字段入报告/审计前须过 redact";但 5.7-0 不实现行为)

如果实际代码与上述不一致,先搜索定位真实实现;doc-vs-code 偏差写入报告,不默默修改。

---

### 二、先做架构分析,再动手

```text
(Phase 5.7-1/2/4 的行为层将各自产出这些契约的实例;5.7-0 只冻结形状)
ExternalActionRef = { source: "browser"|"mcp"|"sandbox", ...arm fields }
GuiAction / BrowserAction / McpAction / SandboxAction(判别联合)
Observation = { observationId, target: ExternalActionRef,
                dom?: DomSnapshot, accessibility?: A11ySnapshot,
                screenshotRef?: string, takenAt, consoleErrors?: string[] }
ActionResult = { resultId, actionRef: ExternalActionRef,
                 status: "success"|"failed"|"cancelled",
                 error?: { code, message(redacted) },
                 observation?: Observation,
                 retryRound?: number, maxRetries?: number,
                 durationMs, occurredAt }
```

动手前在报告中逐一确认的架构判定:

1. **判别联合而非类继承**:ExternalActionRef 是 discriminated union
   (`source` 判别),三 arm 各自最小字段(browser: sessionId/target;
   mcp: serverName/toolName/callId;sandbox: commandId/runId)——
   **不照抄 Playwright/SDK 原生类型**,文件头注释引用对应包已冻结面。
2. **Observation 双形态**:dom 与 accessibility 至少一个存在(不上屏的
   snapshot 不落 contract);screenshotRef 是**引用**(string 前缀
   `screenshot://`,对齐 5.6-0),base64 **不进 contract 字段**(由调用方
   传递 —— 5.6-1 惯例)。
3. **ActionResult 的 failure 面**只挂 error code 分类占位
   (`error.code: string`),**分类表冻结推迟到 5.7-5**(本阶段枚举不冻结,
   只保证字段存在;将来 5.7-5 的失败分类表进来直接覆盖注释)。
4. **取消/超时是字段不是机制**:cancelledAt/timeoutAt 进 ActionResult /
   GuiAction 契约;取消行为本身归 workflow-engine(零第二套)。

---

### 三、交付物定义

**位置**:全部在 `packages/shared/src/index.ts`(**追加一个
`── Phase 5.7-0: Computer Use Contract ──` 代码块**) + 新测试文件
`packages/shared/src/__tests__/computerUseContract.test.ts`(跟随本包现状)。
导出经既有 barrel(本包无单独 barrel;测试直接从 `../index` import)。

**1. ExternalActionRef(discriminated union,zod strict)**

```ts
export const ExternalActionRefSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("browser"),
    sessionId: z.string().trim().min(1).max(120),
    /** stableId of the browser tool that ran (browser.navigate 等 5.6-3 名)。 */
    toolName: z.string().trim().min(1).max(120),
    /** 任选:目标 URL / selector;不做语义解析,原样带出。 */
    target: z.string().trim().min(1).max(2000)
  }).strict(),
  z.object({
    source: z.literal("mcp"),
    serverName: z.string().trim().min(1).max(200),
    toolName: z.string().trim().min(1).max(200),
    /** 调用序号 / id(经 ToolRuntime 的 toolCallId)。 */
    callId: z.string().trim().min(1).max(120)
  }).strict(),
  z.object({
    source: z.literal("sandbox"),
    commandId: z.string().trim().min(1).max(120),
    runId: z.string().trim().min(1).max(120).optional()
  }).strict()
]);
```

- 每个 arm ≤5 字段;**不新增第二套 id 体系**(契约复用各包既有 id 字段名)。

**2. Observation(zod strict)**

```ts
export const DomSnapshotSchema = z.object({
  nodes: z.array(z.object({
    ref: z.string().trim().min(1).max(120),        // 稳定引用(页面内)
    role: z.string().trim().min(1).max(60),
    name: z.string().trim().max(300),              // accessible name(入审计前 redact)
    clickable: z.boolean(),
    text: z.string().max(2000)
  }).strict()).max(2000)
}).strict();

export const A11ySnapshotSchema = z.object({
  tree: z.string().max(200_000),                   // 序列化 AOM 文本(实施自定,注释记录)
  interactiveCount: z.number().int().min(0)
}).strict();

export const ObservationSchema = z.object({
  observationId: z.string().trim().min(1).max(120),
  actionRef: ExternalActionRefSchema,
  dom: DomSnapshotSchema.optional(),
  accessibility: A11ySnapshotSchema.optional(),
  /** 对齐 5.6-0:`screenshot://<sessionId>/<seq>.png` 引用,base64 不入契约。 */
  screenshotRef: z.string().trim().regex(/^screenshot:\/\//).optional(),
  takenAt: z.string().datetime()
}).strict()
  // dom 与 accessibility 至少一个存在(不上屏的观察不是 Observation)
  .refine((observation) => Boolean(observation.dom || observation.accessibility), {
    message: "observation requires at least one of dom or accessibility",
    path: ["dom"]
  });
```

**3. ActionResult(zod strict)+ GuiAction/BrowserAction 基面**

```ts
export const ActionResultSchema = z.object({
  resultId: z.string().trim().min(1).max(120),
  actionRef: ExternalActionRefSchema,
  status: z.enum(["success", "failed", "cancelled"]),
  /** 失败码占位;枚举表 5.7-5 冻结(本阶段注释,不做枚举)。 */
  error: z.object({
    code: z.string().trim().min(1).max(80),
    /** 已脱敏(message 构造方须先过 redact;契约只存结果)。 */
    message: z.string().trim().max(2000)
  }).strict().optional(),
  /** 动作后的观察(可缺,由实现方决定是否挂 snapshot)。 */
  observation: ObservationSchema.optional(),
  /** 重试元数据(语义归 workflow-engine;字段面冻结在此)。 */
  retryRound: z.number().int().min(0).optional(),
  maxRetries: z.number().int().min(0).optional(),
  durationMs: z.number().int().min(0),
  occurredAt: z.string().datetime(),
  /** 取消/超时时间戳(status=cancelled 的证据;凭证由链路写入)。 */
  cancelledAt: z.string().datetime().optional(),
  timeoutAt: z.string().datetime().optional()
}).strict()
  // cancelled 状态必须携带 cancelledAt;failed 必须带 error。
  .refine((result) => result.status !== "cancelled" || Boolean(result.cancelledAt), {
    message: "cancelled result requires cancelledAt", path: ["cancelledAt"]
  })
  .refine((result) => result.status !== "failed" || Boolean(result.error), {
    message: "failed result requires error", path: ["error"]
  });

export type ExternalActionRef = z.infer<typeof ExternalActionRefSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type ActionResult = z.infer<typeof ActionResultSchema>;
```

**4. 契约测试(`computerUseContract.test.ts`,≥12 例)**

- **strict 拒绝**:每个 union arm 附加未知字段直接 parse 失败;Observation
  附加 `base64Screenshot` 之类字段 parse 失败(base64 不进契约的红线锁定)
- **Observation 至少一形态**:dom/accessibility 双缺 → parse 失败
- **screenshotRef 前缀**:非 `screenshot://` 前缀 → parse 失败
- **ActionResult 不变式**:failed 无 error → parse 失败;cancelled 无
  cancelledAt → parse 失败;success + error 并存 → 允许(注:错误对象
  只在 failed 时语义有效,但不作强制(记录在报告)
- **三 arm 判别**:browser/mcp/sandbox 各一 fixture → parse 通过;
  arm 间字段串包(如 browser arm 带 callId)→ parse 失败(strict)
- **Duration/occurredAt 类型**:int 非负 / ISO datetime 校验
- **零行为**:测试文件里不得出现 browser/playwright/sandbox 的 import
  (grep 断言;契约是纯数据)

---

### 四、测试要求

- 全部测试在 `packages/shared/src/__tests__/computerUseContract.test.ts`,
  遵守本包现状(测试与 5.6-0 同目录风格,不建第二个 test 目录)。
- 只测 **schema/校验/判别/不变式**;不引 browser/mcp/sandbox/visual 任何
  运行时(纯契约,不能有跨包 import)。
- 回归:`shared` 既有 27 例原样绿;全仓 `typecheck && lint && test` 全绿
  (本阶段只改 shared,四门禁以 shared + 相邻包为准)。

---

### 五、边界与红线

1. **零行为实现**:无 Playwright import、无 fetch、无文件 IO、无 migration;
   5.7-0 只落 schema + 校验 + 测试。
2. shared 只允许加法式新增代码块(一个代码块标注 `Phase 5.7-0`);
   **零既有结构修改**(5.6-0/5.6-1 契约未触碰)。
3. **不建第二套 id 体系**:各 arm 复用对应包既有 id 字段
   (sessionId/toolName/callId/commandId);不重定义。
4. **凭据红线**:契约字段不含任何 secret 形字段;注释标明"内容级字段入
   报告/审计前过 redact"。
5. 失败分类枚举表**推迟到 5.7-5**(本阶段 `error.code` 是 string 占位,
   注释明示);不做第二轮预测。
6. 取消/超时行为归 workflow-engine(零第二套);契约只存时间戳字段。

---

### 六、完成后

- 报告落 `docs/43-phase-5.7-0-computer-use-contract.md`(结构照 docs/36
  固定节;内含:三 arm 判别设计理由、Observation 双形态取舍、
  ActionResult error/retry 字段面、5.7-5 冻结推迟说明、doc-vs-code 偏差)。
- 更新:`docs/17` §5.7-0 六项 [x];`docs/15` roadmap 行;`docs/18` Phase 5.7
  阶段状态;本提示词文件保留原样。
- **完成 Phase 5.7-0 后立即 STOP。** 不开始 5.7-1/5.7-2/5.7-3/5.7-4/5.7-5。
- 输出完整完成报告(含 STOP 声明)。

---

### 七、验收对照(5.7-0 六项 → 提示词节)

| docs/17 checklist 项 | 对应 |
|---|---|
| GUI Action / Browser Action / Observation / Screenshot / ActionResult / Cancellation / Timeout 契约 | 三.3 + 三.5(cancellation/timeout 字段面) |
| ExternalActionRef(browser/mcp/sandbox 三来源 union) | 三.1 |
| Observation 数据结构(DOM/A11y 双形态 + screenshotRef) | 三.2 |
| ActionResult(success/failed/cancelled;evidence 关联由 5.7-4 建档,本阶段不加 evidenceRef 字段) | 三.3 |
| 契约测试(zod strict + fixture;零行为实现) | 三.4 + 四 |
| 边界冻结:不实现任何采集 / 执行 / 持久化行为 | 二 + 五.1 |
