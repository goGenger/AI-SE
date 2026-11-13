import { z } from "zod";

export const ProjectStatusSchema = z.enum(["active", "archived"]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

const RepositoryUrlSchema = z.string().trim().url("Repository must be a valid URL").max(500);

export const CreateProjectSchema = z
  .object({
    name: z.string().trim().min(1, "Project name is required").max(120),
    description: z.string().trim().max(1000).optional().default(""),
    // UX-01: repository is optional — a project may start workspace-first.
    repository: RepositoryUrlSchema.optional(),
    /**
     * Local absolute workspace path under AGENT_WORKSPACE_ROOT.
     * Optional on create: when omitted the server allocates `{root}/projects/{slug}-{id}` and persists it.
     */
    workspacePath: z.string().trim().min(1).max(1000).optional(),
    status: ProjectStatusSchema.optional().default("active")
  })
  .strict();

export type CreateProjectInput = z.input<typeof CreateProjectSchema>;
export type CreateProjectData = z.output<typeof CreateProjectSchema>;

/** UX-01: attach (or replace) the Git repository of an existing project. */
export const AttachProjectRepositorySchema = z
  .object({
    repository: RepositoryUrlSchema
  })
  .strict();

export type AttachProjectRepositoryData = z.infer<typeof AttachProjectRepositorySchema>;

/** Set or replace the durable local workspace path on an existing project. */
export const UpdateProjectWorkspacePathSchema = z
  .object({
    workspacePath: z.string().trim().min(1).max(1000)
  })
  .strict();

export type UpdateProjectWorkspacePathData = z.infer<typeof UpdateProjectWorkspacePathSchema>;

export interface Project {
  id: string;
  name: string;
  description: string;
  /** UX-01: null when the project has no Git repository configured. */
  repository: string | null;
  /**
   * Local absolute workspace directory (under AGENT_WORKSPACE_ROOT).
   * Null only for legacy rows created before this field existed; create + ensure always persist one.
   */
  workspacePath: string | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export type ApiResponse<T> =
  | {
      success: true;
      data: T;
      requestId: string;
    }
  | {
      success: false;
      error: ApiErrorBody;
      requestId: string;
    };

export const AgentRunStatusSchema = z.enum([
  "created",
  "running",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled",
  "timed_out"
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const CreateAgentRunSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    taskId: z.string().uuid().optional(),
    task: z.string().trim().min(1, "Task is required").max(2000),
    maxIterations: z.number().int().positive().max(50).optional(),
    timeoutMs: z.number().int().positive().max(300_000).optional()
  })
  .strict();

export type CreateAgentRunInput = z.input<typeof CreateAgentRunSchema>;
export type CreateAgentRunData = z.output<typeof CreateAgentRunSchema>;

export type JsonObject = Record<string, unknown>;

export interface AgentRun {
  id: string;
  projectId?: string;
  taskId: string;
  status: AgentRunStatus;
  input: JsonObject;
  output?: JsonObject;
  currentIteration: number;
  maxIterations: number;
  retryCount: number;
  startedAt?: string;
  finishedAt?: string;
  error?: ApiErrorBody;
  tokenUsage?: JsonObject;
  estimatedCost?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * UX-03: list-facing DTO. `AgentRun` plus the engineering context the run list
 * needs without opening the detail — names are resolved server-side from the
 * existing entities (project / workflow+requirement / task); no second client
 * mapping.
 */
export interface AgentRunSummary extends AgentRun {
  projectName: string | null;
  workflowRunId: string | null;
  requirementName: string | null;
  planningVersion: number | null;
  taskKey: string | null;
  taskTitle: string | null;
  agentName: string | null;
  agentType: string | null;
}

export const ToolCallStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out"
]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export interface ToolCallAudit {
  id: string;
  agentRunId: string;
  iteration: number;
  toolCallId: string;
  toolName: string;
  input: JsonObject;
  output?: JsonObject;
  status: ToolCallStatus;
  error?: ApiErrorBody;
  duration?: number;
  startedAt: string;
  finishedAt?: string;
  createdAt: string;
}

export interface WorkflowEvent {
  id: string;
  workflowRunId?: string;
  taskId?: string;
  agentRunId?: string;
  eventType: string;
  payload: JsonObject;
  createdAt: string;
}

export interface AgentToolCallView {
  toolCallId: string;
  toolName: string;
  status: ToolCallStatus;
  iteration: number;
  duration?: number;
  resultSummary: string;
  errorCode?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AgentRunView {
  agentRunId: string;
  taskId: string;
  projectId?: string;
  status: AgentRunStatus;
  currentIteration: number;
  maxIterations?: number;
  retryCount?: number;
  toolCalls: AgentToolCallView[];
  events?: WorkflowEvent[];
  testResult: string;
  finalResult: string;
  error?: ApiErrorBody;
  startedAt?: string;
  finishedAt?: string;
  duration?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentRunDetailView {
  run: AgentRun;
  toolCalls: ToolCallAudit[];
  events: WorkflowEvent[];
  /** UX-03: engineering context chain (Project → Workflow → Task), server-resolved. */
  context: AgentRunContext;
  /** UX-03: retry / re-plan / recovery state derived from existing task + engine events. */
  recovery: AgentRunRecoveryView | null;
  /** UX-03: artifacts already linked to this run (existing agent_artifacts rows). */
  artifacts: AgentArtifact[];
  /** UX-03: evidence already linked to this run (existing evidence_records rows). */
  evidence: EvidenceRecord[];
}

/**
 * UX-03: the readable context chain for one agent run. Values come from the
 * existing entities; absent linkage (standalone coding runs) degrades to null.
 */
export interface AgentRunContext {
  projectName: string | null;
  workflow: {
    id: string;
    requirementName: string | null;
    planningVersion: number;
  } | null;
  task: {
    id: string;
    taskKey: string;
    title: string;
    type: string;
    status: string;
    origin: string;
    retryCount: number;
    creationReason?: string;
    /** Agent 自报结果状态（run 成功但任务失败时用于解释差异）。 */
    outcome?: string;
    /** 任务级结果摘要（失败原因）。 */
    summary?: string;
  } | null;
  agentName: string | null;
  agentType: string | null;
  /** workflow policy maxRetries (task-level attempt denominator), when linked. */
  maxRetries: number | null;
}

/** UX-03: recovery chain derived from existing engine events + tasks. */
export interface AgentRunRecoveryView {
  taskRetryCount: number;
  maxRetries: number | null;
  /** FAILURE_ROUTED strategy (e.g. RETRY / REPLAN / DEBUG / HUMAN). */
  strategy: string | null;
  reason: string | null;
  humanRequired: boolean;
  stalled: boolean;
  /** Diagnostic / retry task created from the failed task, when it exists. */
  recoveryTask: {
    id: string;
    taskKey: string;
    title: string;
    type: string;
  } | null;
}

export type AgentRunStreamPayload = AgentRunDetailView;

export const RequirementStatusSchema = z.enum([
  "DRAFT",
  "ANALYZING",
  "ANALYZED",
  "PLANNING_REVIEW",
  "FAILED"
]);
export type RequirementStatus = z.infer<typeof RequirementStatusSchema>;

/**
 * 自治级别（`docs/17`「自治 L1 · 策略内自治」节 + `docs/227` 自治 L2）。
 *
 * - `"L1"`：策略内自治——staging 与低风险自动，生产仍人工。
 * - `"L2"`：在 L1 之上把关口 1（切片计划人工确认）纳入自治契约（`docs/227`）。
 *   **L2 ⊇ L1**：声明 L2 的工作流逐项继承 L1 的全部行为。
 *
 * 缺省（undefined）= 现状：验证门沿用全局 `VERIFICATION_GATE`，不写自治决策事件。
 * L3 未定义，不预留空壳值（沿用 2026-10-15 裁定，`docs/154` §6 第 4 项）。
 *
 * 位置说明：必须定义在 `CreateRequirementSchema` **之前**——需求的 `autonomyLevel`
 * 需要它，而模块级 `const` 按声明顺序求值，放后面会撞 TDZ。**只有这一份定义**。
 */
export const AutonomyLevelSchema = z.enum(["L1", "L2"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

/** 类型守卫：把库里的 `string | null` 收窄成 `AutonomyLevel`（不认识的值不伪造）。 */
export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return AutonomyLevelSchema.safeParse(value).success;
}

/**
 * N-61（`docs/232` §10）：**上游模型服务不可用**时失败任务上的标记。
 *
 * 两端共用一份字面量，免得两个手抄副本漂移（`AGENTS.md` §3：跨包契约放这里）：
 * 写方是 `agent-core`（重试耗尽后写进 `error.details.reason`），读方是 `workflow-engine`
 * （据此不走 REPLAN）；中间的 `apps/server` 只做转发（`output.errorReason`）。
 *
 * 它**不是**错误码——`RuntimeErrorCode` 是封闭集合（`AGENTS.md` §10），任务仍是 `LLM_ERROR`。
 */
export const PROVIDER_UNAVAILABLE_REASON = "PROVIDER_UNAVAILABLE" as const;

/**
 * Round16 / docs/129 L4 事故 5：OpenCode Go「usage limit exceeded」是**配额耗尽**，
 * 不是短时容量 429。与 PROVIDER_UNAVAILABLE 区分——后者适合退避重试；前者重试只会
 * 空烧预算，应停下来等人换 key / 等重置 / 换端点。
 */
export const QUOTA_EXHAUSTED_REASON = "QUOTA_EXHAUSTED" as const;

/**
 * D1（`docs/229`）：需求正文与单份技术文档的字符上限。
 * 原先 2 万字装不下真实的 PRD，文件形态的 PRD 更是必然超——上限统一按 20 万字。
 * 超限**截断并显性告知**（`truncated`），不静默丢弃。
 */
export const REQUIREMENT_CONTENT_MAX_CHARS = 200_000;

export const CreateRequirementSchema = z
  .object({
    title: z.string().trim().min(1, "Requirement title is required").max(160),
    description: z.string().trim().max(1000).optional().default(""),
    rawContent: z
      .string()
      .trim()
      .min(1, "Requirement content is required")
      .max(REQUIREMENT_CONTENT_MAX_CHARS),
    /**
     * 自治 L2（`docs/227`）：需求级自治级别。**可选、无默认值**——
     * 缺省即现状（关口 1 一律等人工），不改变任何既有调用方的行为。
     */
    autonomyLevel: AutonomyLevelSchema.optional()
  })
  .strict();

export type CreateRequirementInput = z.input<typeof CreateRequirementSchema>;
export type CreateRequirementData = z.output<typeof CreateRequirementSchema>;

export const AnalyzeRequirementSchema = z
  .object({
    regenerate: z.boolean().optional().default(false)
  })
  .strict();

export type AnalyzeRequirementInput = z.input<typeof AnalyzeRequirementSchema>;
export type AnalyzeRequirementData = z.output<typeof AnalyzeRequirementSchema>;

export interface Requirement {
  id: string;
  projectId: string;
  title: string;
  description: string;
  rawContent: string;
  /** 自治 L2：需求级自治级别；缺省 = 关口 1 一律等人工确认（现状）。 */
  autonomyLevel?: AutonomyLevel;
  status: RequirementStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** D1（`docs/229`）+ UI 参照：需求文档种类。PRD 至多一份；技术文档与 UI 参照图可多份。 */
export const RequirementDocumentKindSchema = z.enum(["PRD", "TECHNICAL", "UI_REFERENCE"]);
export type RequirementDocumentKind = z.infer<typeof RequirementDocumentKindSchema>;

/** 单份上传文件的字节上限（抽文本之前的原始体积；UI 参照图同限）。 */
export const REQUIREMENT_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

/** 单个需求最多挂多少张 UI 参照图（可选、不挡开工）。 */
export const REQUIREMENT_UI_REFERENCE_MAX_COUNT = 8;

/**
 * 文档元数据。**不含正文与原件**——列表接口不返回大字段，
 * 规划侧另走 `findContentsByRequirementId` 读取 `content_text`。
 */
export interface RequirementDocument {
  id: string;
  requirementId: string;
  kind: RequirementDocumentKind;
  fileName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  charCount: number;
  truncated: boolean;
  createdAt: string;
}

/** D1：需求文档列表视图。`planningStale` 为真时旧规划不应继续使用（D1-8）。 */
export interface RequirementDocumentsView {
  documents: RequirementDocument[];
  planningStale: boolean;
  latestAnalysisAt: string | null;
  documentsChangedAt: string | null;
}

/**
 * D1（`docs/229`）：进入规划输入的技术文档投影。
 * 与 `Requirement.rawContent` **并列**、绝不合并——rawContent 是 AC/FR 解析器的唯一输入。
 */
export interface ProvidedTechnicalDocument {
  fileName: string;
  text: string;
  truncated: boolean;
}

/**
 * UI 参照图（intake）：进入规划 / Agent 上下文的视觉参照投影。
 * 与 rawContent、技术文档并列；不进视觉修复闭环。
 * 规划前优先 vision describe 写入 `note`；OpenCode/atlas 等不支持多模态的路径应去掉 `base64`。
 * `base64` 仅在原生多模态规划调用时携带；列表/TaskContext 可只带元数据。
 */
export interface ProvidedUiReference {
  fileName: string;
  mimeType: string;
  /** 给人 / 规划看的短说明（含 vision describe 结果；无 OCR）。 */
  note: string;
  /** 原生多模态规划路径：PNG/JPEG/WebP 原件的 base64；缺省 = 仅元数据。 */
  base64?: string;
}

/**
 * 冲突裁决选择：跟 PRD、跟技术文档（TRD）、或自定义说明。
 * 身份键 = requirementId + topic + source（与上报项对齐）。
 */
export const ConflictResolutionChoiceSchema = z.enum(["FOLLOW_PRD", "FOLLOW_TRD", "CUSTOM"]);
export type ConflictResolutionChoice = z.infer<typeof ConflictResolutionChoiceSchema>;

export const ConflictResolutionInputSchema = z
  .object({
    topic: z.string().trim().min(1).max(500),
    source: z.string().trim().min(1).max(500),
    prdSays: z.string().trim().min(1).max(5000),
    documentSays: z.string().trim().min(1).max(5000),
    choice: ConflictResolutionChoiceSchema,
    note: z.string().trim().max(2000).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.choice === "CUSTOM" && !(value.note && value.note.length > 0)) {
      context.addIssue({
        code: "custom",
        path: ["note"],
        message: "自定义裁决必须填写说明"
      });
    }
  });
export type ConflictResolutionInput = z.input<typeof ConflictResolutionInputSchema>;
export type ConflictResolutionData = z.output<typeof ConflictResolutionInputSchema>;

export const UpsertConflictResolutionsSchema = z
  .object({
    resolutions: z.array(ConflictResolutionInputSchema).min(1).max(50)
  })
  .strict();
export type UpsertConflictResolutionsInput = z.input<typeof UpsertConflictResolutionsSchema>;
export type UpsertConflictResolutionsData = z.output<typeof UpsertConflictResolutionsSchema>;

export interface ConflictResolution {
  id: string;
  requirementId: string;
  topic: string;
  source: string;
  prdSays: string;
  documentSays: string;
  choice: ConflictResolutionChoice;
  note: string | null;
  resolvedAt: string;
}

/** 进入规划各阶段 input 的冲突裁决投影（无 id）。 */
export interface ProvidedConflictResolution {
  topic: string;
  source: string;
  prdSays: string;
  documentSays: string;
  choice: ConflictResolutionChoice;
  note?: string;
}

export const RequirementPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type RequirementPriority = z.infer<typeof RequirementPrioritySchema>;

/**
 * docs/268：UI 关键页 / 关键态官方视觉基线缺口。把缺口写进计划即合规；
 * 不得假装基线已经存在。有界面且没有任何参照图时，缺省或空数组由规划校验拒绝。
 */
export const VisualBaselineGapSchema = z
  .object({
    page: z.string().trim().min(1),
    state: z.string().trim().min(1).optional(),
    note: z.string().trim().min(1)
  })
  .strict();
export type VisualBaselineGap = z.infer<typeof VisualBaselineGapSchema>;

export const RequirementAnalysisSchema = z
  .object({
    id: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    goals: z.array(z.string().trim().min(1)).min(1),
    constraints: z.array(z.string().trim().min(1)).default([]),
    assumptions: z.array(z.string().trim().min(1)).default([]),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
    risks: z.array(z.string().trim().min(1)).default([]),
    /**
     * D1（`docs/229`）：用户提供的技术文档与 PRD 的冲突项。非空 = 权威输入与需求不一致，
     * 交人工裁决；规划**不因此失败**（一个措辞差异不该卡住整条链），但必须可被看见。
     */
    technicalDocumentConflicts: z
      .array(
        z
          .object({
            topic: z.string().trim().min(1),
            prdSays: z.string().trim().min(1),
            documentSays: z.string().trim().min(1),
            source: z.string().trim().min(1)
          })
          .strict()
      )
      .optional(),
    /**
     * 两级规划（N2）：第一级切片覆盖检查的 FR 集基准。
     * 单级旧路径可缺省；two-level 模式下为空时第一级将判失败并重做。
     */
    functionalRequirements: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            title: z.string().trim().min(1)
          })
          .strict()
      )
      .optional(),
    /**
     * docs/268：UI 关键页 / 关键态基线缺口。记录缺口即合规；不得假装基线已有。
     */
    visualBaselineGaps: z.array(VisualBaselineGapSchema).optional()
  })
  .strict();
export type RequirementAnalysis = z.infer<typeof RequirementAnalysisSchema>;

export const FunctionalRequirementSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    priority: RequirementPrioritySchema,
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1)
  })
  .strict();
export type FunctionalRequirement = z.infer<typeof FunctionalRequirementSchema>;

export const FunctionalSpecSchema = z
  .object({
    requirements: z.array(FunctionalRequirementSchema).min(1)
  })
  .strict();
export type FunctionalSpecContent = z.infer<typeof FunctionalSpecSchema>;

export const TechnicalRequirementSchema = z
  .object({
    id: z.string().trim().min(1),
    category: z.string().trim().min(1),
    description: z.string().trim().min(1),
    constraints: z.array(z.string().trim().min(1)).default([])
  })
  .strict();
export type TechnicalRequirement = z.infer<typeof TechnicalRequirementSchema>;

export const TechnicalSpecSchema = z
  .object({
    requirements: z.array(TechnicalRequirementSchema).min(1)
  })
  .strict();
export type TechnicalSpecContent = z.infer<typeof TechnicalSpecSchema>;

export const ArchitectureSpecSchema = z
  .object({
    components: z
      .array(
        z
          .object({
            name: z.string().trim().min(1),
            responsibility: z.string().trim().min(1),
            dependencies: z.array(z.string().trim().min(1)).default([])
          })
          .strict()
      )
      .default([]),
    dataFlow: z.array(z.string().trim().min(1)).default([])
  })
  .strict();
export type ArchitectureSpecContent = z.infer<typeof ArchitectureSpecSchema>;

export const HttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const ApiEndpointSchema = z
  .object({
    method: HttpMethodSchema,
    path: z
      .string()
      .trim()
      .regex(/^\/[A-Za-z0-9/_:.-]*$/, "API path must start with /"),
    description: z.string().trim().min(1),
    request: z.record(z.string(), z.unknown()).default({}),
    response: z.record(z.string(), z.unknown()).default({}),
    errors: z.array(z.string().trim().min(1)).default([])
  })
  .strict();

export const ApiContractGapSchema = z
  .object({
    topic: z.string().trim().min(1).optional(),
    note: z.string().trim().min(1)
  })
  .strict();
export type ApiContractGap = z.infer<typeof ApiContractGapSchema>;

/**
 * docs/269：消费 API 的能力面用来规划前端封装（客户端包装与页面对接）。
 * 生成 API 的能力面可以不填。
 */
export const FrontendApiEncapsulationSchema = z
  .object({
    source: z.string().trim().min(1),
    client: z.string().trim().min(1),
    pages: z.array(z.string().trim().min(1)).default([]),
    notes: z.string().trim().min(1).optional()
  })
  .strict();
export type FrontendApiEncapsulation = z.infer<typeof FrontendApiEncapsulationSchema>;

export const ApiSpecSchema = z
  .object({
    // 允许空数组：需求不涉及 API 时「无端点」是正确输出，禁止为过校验虚构端点。
    endpoints: z.array(ApiEndpointSchema).default([]),
    /**
     * docs/269：前端如何封装已消费的接口，以及接到哪些页面。
     * 消费 API 的能力面使用；生成 API 的能力面可省略。
     */
    encapsulation: z.array(FrontendApiEncapsulationSchema).optional(),
    /**
     * docs/269：缺少 API 契约或封装示例时的缺口记录。记下缺口即合规，不得假装契约已有，
     * 也不得为此虚构服务端端点。
     */
    apiContractGaps: z.array(ApiContractGapSchema).optional()
  })
  .strict();
export type ApiSpecContent = z.infer<typeof ApiSpecSchema>;

export const DatabaseSpecSchema = z
  .object({
    // 允许空数组：无持久化需求时「无数据表」是正确输出，禁止为过校验虚构表。
    tables: z
      .array(
        z
          .object({
            name: z.string().trim().min(1),
            columns: z.array(z.string().trim().min(1)).min(1),
            indexes: z.array(z.string().trim().min(1)).default([]),
            relations: z.array(z.string().trim().min(1)).default([])
          })
          .strict()
      )
      .default([])
  })
  .strict();
export type DatabaseSpecContent = z.infer<typeof DatabaseSpecSchema>;

export const UiSpecSchema = z
  .object({
    // 允许空数组：需求不涉及界面时「无页面」是正确输出。
    // 页面对象不用 .strict()：视觉参照会诱使模型多吐 additionalElements 等扩展键，
    // 默认 strip 即可，避免整段 ui_spec 因多余字段解析失败。
    pages: z
      .array(
        z.object({
          name: z.string().trim().min(1),
          components: z.array(z.string().trim().min(1)).min(1),
          interactions: z.array(z.string().trim().min(1)).default([]),
          states: z.array(z.string().trim().min(1)).default([])
        })
      )
      .default([]),
    /**
     * docs/268：本 UI 规格里缺失官方视觉基线的关键页 / 关键态。
     * 记录缺口即合规；有页面却既无参照图也无缺口记录时，规划校验拒绝。
     */
    visualBaselineGaps: z.array(VisualBaselineGapSchema).optional()
  })
  .strict();
export type UiSpecContent = z.infer<typeof UiSpecSchema>;

export const SpecificationTypeSchema = z.enum([
  "REQUIREMENT_ANALYSIS",
  "FUNCTIONAL",
  "TECHNICAL",
  "ARCHITECTURE",
  "API",
  "DATABASE",
  "UI"
]);
export type SpecificationType = z.infer<typeof SpecificationTypeSchema>;

export const SpecificationStatusSchema = z.enum(["DRAFT", "GENERATED", "VALIDATED", "FAILED"]);
export type SpecificationStatus = z.infer<typeof SpecificationStatusSchema>;

export interface Specification {
  id: string;
  projectId: string;
  requirementId: string;
  type: SpecificationType;
  version: number;
  status: SpecificationStatus;
  content: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export const TaskTypeSchema = z.enum([
  "ANALYSIS",
  "DESIGN",
  "DATABASE",
  "BACKEND",
  "FRONTEND",
  "TEST",
  "REVIEW",
  "DEBUG",
  "BUILD",
  "DEPLOY",
  "MONITOR",
  "INCIDENT"
]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

/**
 * 运行期专属任务类型：由 Workflow Engine 在 REPLAN 链里**自己创建**，没有任何职业 agent 承接。
 * 计划项里出现它们、或把它们当作 DEBUG 任务的目标类型，执行期都必然瞬失败
 * （真实案例 2026-09-28：计划项 T8 type=DEBUG → 3 次瞬失败、整条工作流 FAILED）。
 *
 * 判定**只有这一份**：`agent-core/src/planning`（计划期拦截）、`workflow-engine`（修复路由回退）、
 * `agent-core/src/professional`（任务派发）三处消费方共用。重复定义必然漂移。
 */
export const RUNTIME_ONLY_TASK_TYPES: readonly TaskType[] = ["DEBUG", "MONITOR", "INCIDENT"];

export function isRuntimeOnlyTaskType(value: string): boolean {
  return (RUNTIME_ONLY_TASK_TYPES as readonly string[]).includes(value);
}

/**
 * 「可作为 DEBUG 任务目标类型」的判定：必须是 `TaskType` 成员，有职业 agent 可承接。
 * 排除：运行期专属类型（`DEBUG` / `MONITOR` / `INCIDENT`），以及 **`DEPLOY`**
 * （交付编排器独占，`TASK_AGENT_TYPES` 无映射——DEBUG→DEPLOY 会在派发期瞬失败，
 * 实测 F1 round17：`T-09-DEBUG-2` → "No professional agent for DEBUG task…"）。
 */
export function isUsableTargetTaskType(value: unknown): value is TaskType {
  return (
    typeof value === "string" &&
    (TaskTypeSchema.options as readonly string[]).includes(value) &&
    !isRuntimeOnlyTaskType(value) &&
    value !== "DEPLOY"
  );
}

/**
 * `docs/235`：**能力面**的声明式表达——平台能规划什么、谁来写、怎么验、边界门用哪种。
 *
 * 这是把「平台能做什么」从散落的常量收到一处的第一步。本阶段只落 `backend-node`（与既有常量
 * 逐字等价），profile 的消费者按需接线：**先等价，再扩能力**。
 */
export type CapabilityCheckName =
  | "build"
  | "test"
  | "lint"
  | "typecheck"
  | "migrate-up"
  | "migrate-down";

export interface CapabilityProfile {
  id: string;
  version: string;
  taskTypes: {
    /** 规划器可用的类型。 */
    plannable: readonly TaskType[];
    /** 直接产出产品代码、可作为修复目标的类型。 */
    work: readonly TaskType[];
    /** 失败任务派不出工作类型时的回退。 */
    fixFallback: TaskType;
  };
  /** 该 profile 启用的专业 agent。 */
  agents: readonly AgentType[];
  specs: {
    generate: readonly SpecificationType[];
    consume: readonly SpecificationType[];
  };
  /** 各任务类型可用的脚本级检查（`slice-boundary` / `server-smoke` 是结构性检查，不在此列）。 */
  checks: Partial<Record<TaskType, readonly CapabilityCheckName[]>>;
  testParser: "node-tap" | "vitest" | "surefire-xml";
  boundaryCheck: "ui" | "server" | "none";
  /**
   * `docs/236` 第 4 步：本能力面允许的**装依赖出网**档位。
   *
   * - `"none"`（默认）：装依赖只能用镜像里预热好的 store，未预热的包装不上。
   * - `"registry"`：install 类命令接到 `ai-se-egress` 上的 registry（`docs/238`），其余命令
   *   仍然无网（`docs/239` 按命令分类）。这是**出网上限**，不是「整条命令链都有网」。
   *
   * 缺省为 `"none"`——新增 profile 不写这个字段就等于不出网，与第 3 步之前完全一致。
   * 回滚方式就是把它改回 `"none"`（`docs/236` §10）。
   */
  dependencyNetwork?: "none" | "registry";
  /**
   * 交付尾段。**当前未接线**：交付块的文案与契约仍由规划提示词静态给出
   * （`task-planning.prompt.ts` 的 `DELIVERY_READY_LINE`），这里只是把「这段链到哪为止」
   * 声明出来，供后续步骤替换静态文案。
   */
  delivery: { chain: readonly DeliveryTask[] };
  fixtureTier: string;
}

/**
 * `backend-node`：**现状等价物**（`docs/235` §6 第 1 步）。
 *
 * 每个字段都必须与迁移前的硬编码**逐字一致**——这就是本步的验收判据（零行为变化）：
 * - `taskTypes.plannable` ↔ 规划提示词里的类型清单（`task-planning.prompt.ts`）
 * - `taskTypes.work` / `fixFallback` ↔ `WORK_TASK_TYPES` 与 `fixWorkTargetType` 的回退
 * - `checks` ↔ `CHECK_CANDIDATES`（`apps/server/src/services/taskVerifierRules.ts`）
 * - `agents` ↔ `AgentRegistry` 注册的七个 agent
 */
export const BACKEND_NODE_PROFILE: CapabilityProfile = {
  id: "backend-node",
  version: "1",
  taskTypes: {
    plannable: [
      "ANALYSIS",
      "DESIGN",
      "DATABASE",
      "BACKEND",
      "FRONTEND",
      "TEST",
      "REVIEW",
      "BUILD",
      "DEPLOY"
    ],
    work: ["BACKEND", "FRONTEND", "DATABASE"],
    fixFallback: "BACKEND"
  },
  agents: ["PLANNER", "BACKEND", "DATABASE", "FRONTEND", "QA", "REVIEWER", "DEVOPS"],
  specs: {
    generate: [
      "REQUIREMENT_ANALYSIS",
      "FUNCTIONAL",
      "TECHNICAL",
      "ARCHITECTURE",
      "API",
      "DATABASE",
      "UI"
    ],
    consume: []
  },
  checks: {
    BACKEND: ["build", "test"],
    FRONTEND: ["build", "lint"],
    TEST: ["test"],
    BUILD: ["build"]
  },
  testParser: "node-tap",
  boundaryCheck: "server",
  // 默认不出网：装依赖只能靠镜像预热的 store。`docs/236` 第 4 步之前的行为。
  dependencyNetwork: "none",
  // 与规划提示词里写死的四段交付链逐字对应（CI → staging 部署 → staging 验证 → production 部署）。
  delivery: {
    chain: [
      { action: "CI" },
      { action: "DEPLOY", environment: "staging" },
      { action: "VERIFY", environment: "staging" },
      { action: "DEPLOY", environment: "production" }
    ]
  },
  fixtureTier: "E1"
};

/**
 * `frontend-vue`：**只做前端**的能力面（`docs/235` §5）。
 *
 * 与 `backend-node` 的差别就是这次转向的全部表达，**集中在下面几行**，没有散落的分支：
 * - 不再规划 BACKEND / DATABASE，写范围与修复目标只有 FRONTEND；
 * - 不再启用 backend-agent / database-agent（定义仍在注册表里，按 §5.2 层 2 保留但不可达）；
 * - API 契约作为**输入**（`specs.consume`），不再作为后端生成物；`api_spec` 阶段仍会运行，
 *   但改为消费 TRD / API 契约并规划前端封装，而不是生成或实现服务端接口（`docs/269`）；
 * - 前端任务**加 `test` 检查**——`backend-node` 的 `[build, lint]` 让每个前端任务的逐任务门
 *   只看「能编译、能过 lint」，UI 行为要等到 oracle 才验一次（§5.1）；
 * - 边界门换成 `ui`（`docs/233` §5.2 的浏览器冒烟），交付链止于 staging 验证。
 */
export const FRONTEND_VUE_PROFILE: CapabilityProfile = {
  id: "frontend-vue",
  version: "1",
  taskTypes: {
    plannable: ["ANALYSIS", "DESIGN", "FRONTEND", "TEST", "REVIEW", "BUILD", "DEPLOY"],
    work: ["FRONTEND"],
    fixFallback: "FRONTEND"
  },
  agents: ["PLANNER", "FRONTEND", "QA", "REVIEWER", "DEVOPS"],
  specs: {
    generate: ["REQUIREMENT_ANALYSIS", "FUNCTIONAL", "UI", "TECHNICAL"],
    consume: ["API"]
  },
  checks: {
    FRONTEND: ["build", "lint", "test"],
    TEST: ["test"],
    BUILD: ["build"]
  },
  testParser: "vitest",
  boundaryCheck: "ui",
  /**
   * `docs/236` 第 4 步：前端夹具的依赖面**不可能**全部预热进镜像（`docs/234` 的教训），
   * 所以这个 profile 允许 install 走 registry。其余命令仍无网（按命令分类，`docs/239`）。
   *
   * 注意这是**能力面**的声明，不等于「本项目已获准」——装配处还要看是否有 registry 拓扑。
   */
  dependencyNetwork: "registry",
  delivery: {
    chain: [
      { action: "CI" },
      { action: "DEPLOY", environment: "staging" },
      { action: "VERIFY", environment: "staging" }
    ]
  },
  fixtureTier: "F1"
};

/** 产品默认：前端动态工作流（`docs/235`；2026-11-04 起切离 backend-node）。遗留 E1 须显式 `CAPABILITY_PROFILE=backend-node`。 */
export const DEFAULT_CAPABILITY_PROFILE: CapabilityProfile = FRONTEND_VUE_PROFILE;

/** 已知能力 profile。**新增 profile 只加这里**，配置校验与解析都以它为准。 */
export const CAPABILITY_PROFILES: readonly CapabilityProfile[] = [
  BACKEND_NODE_PROFILE,
  FRONTEND_VUE_PROFILE
];

/**
 * `docs/235` §6.5 的补步：**profile 选择**的唯一入口。
 *
 * 调用方（配置层）在启动时解析一次，然后把结果显式注入各接缝。**未知 id 直接抛错**
 * （fail-closed）：配置写错时必须启动失败，而不是静默退回默认 profile——后者会让一批
 * 读数被记到错误的口径下，且事后无法分辨。
 */
export function resolveCapabilityProfile(id: string): CapabilityProfile {
  const found = CAPABILITY_PROFILES.find((profile) => profile.id === id);
  if (!found) {
    throw new Error(
      `Unknown capability profile "${id}". Known profiles: ${CAPABILITY_PROFILES.map((profile) => profile.id).join(", ")}`
    );
  }
  return found;
}

/**
 * docs/268：当前能力面是否启用数据层 / 后端工作（可规划类型或可生成的 DATABASE 规格）。
 * `frontend-vue` 为 false：不得规划 data-layer 切片，也不得用 `involvesData=true`（或省略）打开 `database_spec`。
 */
export function profileEnablesDataLayer(profile: CapabilityProfile): boolean {
  const plannable = profile.taskTypes.plannable as readonly string[];
  if (plannable.includes("DATABASE") || plannable.includes("BACKEND")) {
    return true;
  }
  return (profile.specs.generate as readonly string[]).includes("DATABASE");
}

/**
 * docs/269：当前能力面是否把 API 当作输入来消费（而不是生成一份后端接口规格）。
 * `frontend-vue` 为 true：`api_spec` 阶段仍运行，但只规划前端封装，不得发明服务端接口。
 * 若一个 profile 同时 generate 与 consume API，以 generate 为准，避免破坏 backend-node 路径。
 */
export function profileConsumesApi(profile: CapabilityProfile): boolean {
  const consume = (profile.specs.consume as readonly string[]).includes("API");
  const generate = (profile.specs.generate as readonly string[]).includes("API");
  return consume && !generate;
}

/**
 * 自治 REPLAN 的 fixTaskType 是否被当前能力面允许。
 * 先过 `isUsableTargetTaskType`，再要求落在 `profile.plannable` 或 `profile.work`
 * （frontend-vue 因此拒绝 BACKEND/DATABASE，避免诊断把修复派到不可达 agent）。
 */
export function isProfileAllowedRepairType(
  value: unknown,
  profile: CapabilityProfile = DEFAULT_CAPABILITY_PROFILE
): value is TaskType {
  if (!isUsableTargetTaskType(value)) return false;
  return (
    (profile.taskTypes.plannable as readonly string[]).includes(value) ||
    (profile.taskTypes.work as readonly string[]).includes(value)
  );
}

/**
 * PL-M18（N-11）：**工作类型**——直接产出/修改产品代码的任务类型。
 *
 * 与 `RUNTIME_ONLY_TASK_TYPES` 相对：`DEBUG` / `MONITOR` / `INCIDENT` 是引擎自己造的运行期
 * 任务，而 `REVIEW` / `DESIGN` / `TEST` / `BUILD` / `DEPLOY` 是**对工作产物的检查或编排**，
 * 它们自己不交付产品代码。
 *
 * 用途（唯一）：失败任务的**修复任务**必须落在工作类型上。改动前 `replan()` 的 retry 任务
 * 直接继承源任务类型，于是一个 REPORT「不通过」的 `REVIEW` 会被 replan 成**另一个 `REVIEW`**
 * ——同一个诚实负结论必然重现，循环到深度守卫（实测 L1-M4i 的 `T-S4-R2`）。
 *
 * `docs/235`：取值改由 `BACKEND_NODE_PROFILE.taskTypes.work` 派生，常量本身保留给既有调用方。
 */
export const WORK_TASK_TYPES: readonly TaskType[] = BACKEND_NODE_PROFILE.taskTypes.work;

export function isWorkTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && (WORK_TASK_TYPES as readonly string[]).includes(value);
}

/**
 * N-23（`docs/200`）：**交付任务类型**——它们的 `type` 不是「谁来做」的标签，而是**平台契约**。
 *
 * `DeliveryOrchestrator.canHandle` 就是按 `task.type` 分派的
 * （`deploymentOrchestrator.ts:76-84`：`BUILD`+`CI` / `DEPLOY`+`DEPLOY|ROLLBACK` / `TEST`+`VERIFY`）。
 * 因此**把这三个类型换成工作类型**（PL-M18 的兜底对 REVIEW 是对的）会**悄悄作废 `input.delivery`**：
 * 契约字段还在，但没人再读它——任务照跑、还能报 SUCCESS，而它该做的那件事从未发生。
 *
 * 实测（L1-M4n run 3）：`T7`（BUILD/CI）失败 → `T7-REPLAN-1` 变成 `BACKEND` ⇒ **没写下任何 `ci_runs`**
 * 却自报 SUCCESS ⇒ 下游 `T8`（DEPLOY）死在 `CI_RELEASE_NOT_FOUND`。**这是 PL-M18 的溢出。**
 *
 * 用途（唯一）：`debugTargetType` 的第 3 步兜底**不得**改变这三个类型。
 */
export const DELIVERY_TASK_TYPES: readonly TaskType[] = ["BUILD", "DEPLOY", "TEST"];

export function isDeliveryTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && (DELIVERY_TASK_TYPES as readonly string[]).includes(value);
}

export const TaskStatusSchema = z.enum([
  "PENDING",
  "READY",
  "RUNNING",
  "WAITING_APPROVAL",
  "SUCCESS",
  "FAILED",
  "RETRYING",
  "BLOCKED",
  "CANCELLED"
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const DeliveryEnvironmentSchema = z.enum(["dev", "staging", "production"]);
export type DeliveryEnvironment = z.infer<typeof DeliveryEnvironmentSchema>;

export const DeliveryTaskSchema = z
  .object({
    action: z.enum(["CI", "DEPLOY", "VERIFY", "ROLLBACK"]),
    environment: DeliveryEnvironmentSchema.optional(),
    ref: z.string().trim().min(1).max(200).optional(),
    workflowFile: z.string().trim().min(1).max(200).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action !== "CI" && !value.environment) {
      context.addIssue({
        code: "custom",
        path: ["environment"],
        message: "Environment is required for delivery actions"
      });
    }
  });
export type DeliveryTask = z.infer<typeof DeliveryTaskSchema>;

export const TaskPlanItemSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    type: TaskTypeSchema,
    priority: TaskPrioritySchema.default("MEDIUM"),
    dependencies: z.array(z.string().trim().min(1)).default([]),
    estimatedComplexity: z.number().int().min(1).max(10),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
    /** N3：任务覆盖的 AC 编号集（引用需求 AC 记录的 acKey；无编号 PRD 可为空/缺省）。 */
    acKeys: z.array(z.string().trim().min(1)).optional(),
    /**
     * PL-M9 9b（`docs/166` §3）：本任务在工作区**创建**的 npm script 名（如项目骨架任务的
     * `["test","build"]`）。计划期守卫据此要求「消费者（其客观检查需要该 script 的任务）
     * 必须（传递）依赖提供者」——`apps/server` 的检查可用性判定读的是**运行期工作区**的
     * `package.json`，而计划期对此一无所知（`docs/166` §2.1 ①）。
     * 缺省 = 本任务不创建任何 script（既有计划与夹具不受影响）。
     */
    providesScripts: z.array(z.string().trim().min(1)).optional(),
    sourceSpecTypes: z.array(SpecificationTypeSchema).min(1),
    delivery: DeliveryTaskSchema.optional()
  })
  .strict();

export type TaskPlanItem = z.infer<typeof TaskPlanItemSchema>;

export const TaskPlanSchema = z
  .object({
    summary: z.string().trim().min(1),
    tasks: z.array(TaskPlanItemSchema).min(1)
  })
  .strict();

export type TaskPlan = z.infer<typeof TaskPlanSchema>;

export interface Task {
  id: string;
  projectId: string;
  requirementId?: string;
  workflowRunId?: string;
  /** N2：第二级任务计划的切片归属（单级/旧数据缺省）。 */
  sliceKey?: string;
  taskKey: string;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgent?: string;
  input: JsonObject;
  output?: JsonObject;
  retryCount: number;
  version: number;
  planTaskId?: string;
  origin?: "ORIGINAL" | "RUNTIME" | "DYNAMIC";
  creationReason?: string;
  sourceTaskId?: string;
  resolvedByTaskId?: string;
  approvalRequired?: boolean;
  claimToken?: string;
  claimedAt?: string;
  failureHandled?: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface TaskDependency {
  id: string;
  sourceTaskId: string;
  targetTaskId: string;
  workflowRunId?: string;
  origin?: "ORIGINAL" | "RUNTIME" | "DYNAMIC";
  active?: boolean;
  createdAt: string;
}

/** 任务声明的 `acKeys`（去空、去非字符串、trim）。 */
export function taskAcKeys(task: Task): string[] {
  const raw = task.input.acKeys;
  return Array.isArray(raw)
    ? raw
        .filter((key): key is string => typeof key === "string")
        .map((key) => key.trim())
        .filter((key) => key !== "")
    : [];
}

/**
 * 切片 AC 范围：同切片全部任务声明的 `acKeys` 去重并集。
 *
 * 这是「本切片范围」的**唯一**定义——校验器的切片边界检查、dev 任务 test 检查的兜底作用域，
 * 以及（N-40）**告诉 agent 该覆盖哪些编号**，三处共用它，避免出现第二份口径。
 * `first` 的键排在最前（保持 F1-5 既有的顺序语义）。
 */
export function sliceAcKeys(sliceTasks: Task[], first?: Task): string[] {
  const ordered = first
    ? [first, ...sliceTasks.filter((entry) => entry.id !== first.id)]
    : sliceTasks;
  return [...new Set(ordered.flatMap(taskAcKeys).filter((key) => key !== ""))];
}

export interface TaskDependencyView extends TaskDependency {
  sourceTaskKey: string;
  targetTaskKey: string;
}

export interface RequirementPlanningResult {
  requirement: Requirement;
  specifications: Specification[];
  tasks: Task[];
  dependencies: TaskDependencyView[];
}

export interface RequirementTasksView {
  tasks: Task[];
  dependencies: TaskDependencyView[];
}

/**
 * N2 两级规划：第一级切片计划的条目（LLM 输出 schema）。
 * `frKeys` 引用 requirement_analysis.functionalRequirements 的编号集（上限 5＝“每片规模上限 3–5 个 FR”）。
 */
export const SlicePlanItemSchema = z
  .object({
    id: z.string().trim().min(1).max(40),
    title: z.string().trim().min(1).max(160),
    goal: z.string().trim().min(1),
    frKeys: z.array(z.string().trim().min(1)).min(1).max(5),
    dependsOn: z.array(z.string().trim().min(1)).default([]),
    order: z.number().int().min(1),
    /** 该切片是否交付用户可见 UI；false 时第二级跳过 ui_spec 阶段并留事件。 */
    involvesUi: z.boolean().default(true),
    /** G2（GX-06）：该切片是否涉及数据层变更；false 时第二级跳过 database_spec 阶段（缺省 = 涉及，零行为变化）。 */
    involvesData: z.boolean().optional(),
    /**
     * docs/268：本切片可独立验收的命名检查（验收标准或官方门禁）。
     * schema 缺省为空数组以兼容旧夹具；规划校验要求至少一条。
     */
    acceptanceCriteria: z.array(z.string().trim().min(1)).default([])
  })
  .strict();
export type SlicePlanItem = z.infer<typeof SlicePlanItemSchema>;

export const SlicePlanSchema = z
  .object({
    slices: z.array(SlicePlanItemSchema).min(1),
    milestones: z.array(z.string().trim().min(1)).default([]),
    /**
     * docs/268：切片计划级的官方视觉基线缺口。可与 requirement analysis / UI spec 的同名字段并存；
     * 任一处点明即合规。
     */
    visualBaselineGaps: z.array(VisualBaselineGapSchema).optional()
  })
  .strict();
export type SlicePlan = z.infer<typeof SlicePlanSchema>;

/**
 * 自治 L2（`docs/227` §2 判据 B）：关口 1 的**确定性判据**。
 *
 * 纯函数——输入只有计划、权威 FR 集合与规模估值，没有时间/随机/IO，可单测、可回放。
 * 四条判据必须**全部**满足才允许自动批准；否则返回未命中的判据名，交人工确认。
 */
export const SLICE_PLAN_GATE_MAX_SLICES = 5;
export const SLICE_PLAN_GATE_MAX_FR_PER_SLICE = 3;
export const SLICE_PLAN_GATE_MAX_FINAL_SLICE_TASKS = 18;

export type SlicePlanGateReason =
  | "fr-coverage"
  | "slice-scope"
  | "slice-dependencies"
  | "final-slice-scale";

/** 判据全集（顺序即评估顺序）；四个都满足才允许自动批准。 */
export const SLICE_PLAN_GATE_CRITERIA: readonly SlicePlanGateReason[] = [
  "fr-coverage",
  "slice-scope",
  "slice-dependencies",
  "final-slice-scale"
];

export interface SlicePlanGateInput {
  plan: SlicePlan;
  /** 一级分析给出的**权威** FR 集合；空数组表示无法判定（判据 1 直接不满足）。 */
  functionalRequirementKeys: string[];
  /** 最终切片预估任务数（FR 数 + 全局性 AC 数，沿用 FINAL_SLICE_SCALE_PREVIEW 口径）。 */
  estimatedFinalSliceTasks: number;
  maxFinalSliceTasks?: number;
}

export interface SlicePlanGateResult {
  satisfied: boolean;
  /** 未命中的判据名；空数组 = 全部满足。 */
  unmet: SlicePlanGateReason[];
}

const FR_GATE_REASON: SlicePlanGateReason = "fr-coverage";
const SCOPE_GATE_REASON: SlicePlanGateReason = "slice-scope";
const DEPENDENCY_GATE_REASON: SlicePlanGateReason = "slice-dependencies";
const SCALE_GATE_REASON: SlicePlanGateReason = "final-slice-scale";

export function evaluateSlicePlanGate(input: SlicePlanGateInput): SlicePlanGateResult {
  const unmet = new Set<SlicePlanGateReason>();
  const { plan } = input;

  // 判据 1：FR 覆盖完整——各切片 frKeys 的并集恰好等于权威 FR 集合（缺一个或多一个都不算）。
  const canonical = new Set(input.functionalRequirementKeys.map((key) => key.trim()));
  const covered = new Set(plan.slices.flatMap((slice) => slice.frKeys.map((key) => key.trim())));
  if (canonical.size === 0) {
    unmet.add(FR_GATE_REASON);
  } else {
    for (const key of canonical) {
      if (!covered.has(key)) unmet.add(FR_GATE_REASON);
    }
    for (const key of covered) {
      if (!canonical.has(key)) unmet.add(FR_GATE_REASON);
    }
  }

  // 判据 2：范围可控——切片数在 [1, 5]，每个切片的 FR 数 ≤ 3。
  if (plan.slices.length < 1 || plan.slices.length > SLICE_PLAN_GATE_MAX_SLICES) {
    unmet.add(SCOPE_GATE_REASON);
  }
  if (plan.slices.some((slice) => slice.frKeys.length > SLICE_PLAN_GATE_MAX_FR_PER_SLICE)) {
    unmet.add(SCOPE_GATE_REASON);
  }

  // 判据 3：依赖健康——dependsOn 只指向**更小 order** 的切片，且全部存在（无悬空即无环）。
  const orderById = new Map(plan.slices.map((slice) => [slice.id, slice.order]));
  for (const slice of plan.slices) {
    for (const dependency of slice.dependsOn) {
      const dependencyOrder = orderById.get(dependency);
      if (dependencyOrder === undefined || dependencyOrder >= slice.order) {
        unmet.add(DEPENDENCY_GATE_REASON);
      }
    }
  }

  // 判据 4：最终切片不超规模。
  const maxFinalSliceTasks = input.maxFinalSliceTasks ?? SLICE_PLAN_GATE_MAX_FINAL_SLICE_TASKS;
  if (input.estimatedFinalSliceTasks > maxFinalSliceTasks) {
    unmet.add(SCALE_GATE_REASON);
  }

  return { satisfied: unmet.size === 0, unmet: [...unmet] };
}

export const SliceStatusSchema = z.enum([
  "PENDING",
  "PLANNING",
  "PLANNED",
  "RUNNING",
  "DONE",
  "FAILED"
]);
export type SliceStatus = z.infer<typeof SliceStatusSchema>;

/** 已持久化的切片（requirement_slices 行）。 */
export interface RequirementSlice {
  id: string;
  projectId: string;
  requirementId: string;
  /** 该切片第二级产物（specifications/tasks）的规划版本；未规划时为 null。 */
  planningVersion: number | null;
  sliceKey: string;
  title: string;
  goal: string;
  frKeys: string[];
  dependsOn: string[];
  order: number;
  involvesUi: boolean;
  /** G2（GX-06）：切片数据层声明；缺省（undefined）= 涉及数据（不跳过 database_spec）。 */
  involvesData?: boolean;
  status: SliceStatus;
  workflowRunId?: string;
  createdAt: string;
  updatedAt: string;
}

/** 需求页切片视图：切片列表 + 待确认的关口 1 审批（无则 null）。 */
export interface RequirementSlicesView {
  slices: RequirementSlice[];
  approval: Approval | null;
}

/**
 * N3：验收标准（AC）一等记录——编号 / 文本 / 优先级 / 验证方式 / 是否 smoke + FR 编号集。
 * 编号形态与 PRD 一致（如 `AC-01`）；无编号 PRD 的 LLM 提取按出现顺序生成同形编号。
 */
export const AcceptanceCriterionSchema = z
  .object({
    acKey: z.string().trim().min(1).max(20),
    text: z.string().trim().min(1),
    priority: z.enum(["Must", "Should"]).nullable().default(null),
    verification: z.string().trim().min(1).max(160).nullable().default(null),
    smoke: z.boolean().default(false),
    frKeys: z.array(z.string().trim().min(1)).default([])
  })
  .strict();
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/** N3 需求页 AC 视图：AC 记录 + 任务映射数（按各切片最新计划的 tasks.input.acKeys 计数）。 */
export interface AcceptanceCriterionView extends AcceptanceCriterion {
  mappingCount: number;
}
export interface RequirementAcceptanceCriteriaView {
  criteria: AcceptanceCriterionView[];
}

/** N5：追溯表（零 LLM 确定性生成）——FR → AC → 测试 → 执行结果 → 证据。 */
export type TraceabilityStatus = "passed" | "failed" | "unverified" | "no-test";

export interface TraceabilityTestRef {
  taskKey: string;
  taskType: TaskType;
  sliceKey?: string;
  /** 证据来自验证门检查的期望语义（pass = 绿灯验证；fail = 红灯检查）。 */
  expected: "pass" | "fail";
  /** 该检查中本 AC 的逐条结果。 */
  result: "passed" | "failed";
  command?: string;
  exitCode?: number | null;
  finishedAt?: string;
  /** F1-5：证据对应的 Git commit（交付前全量以 CI 的 gitCommit 为准；其余取验证时工作区 HEAD）。 */
  commitSha?: string;
  /** F1-5：交付前全量（CI）证据——存在时覆盖早期的绿灯证据（追溯表以这一次为准）。 */
  authoritative?: boolean;
}

export interface AcceptanceTraceabilityEntry {
  acKey: string;
  text: string;
  priority: "Must" | "Should" | null;
  smoke: boolean;
  frKeys: string[];
  status: TraceabilityStatus;
  tests: TraceabilityTestRef[];
}

export interface RequirementTraceabilitySummary {
  total: number;
  passed: number;
  failed: number;
  unverified: number;
  noTest: number;
}

export interface RequirementTraceabilityView {
  requirementId: string;
  generatedAt: string;
  summary: RequirementTraceabilitySummary;
  criteria: AcceptanceTraceabilityEntry[];
}

export interface AnalyzeRequirementResult {
  requirementId: string;
  agentRunId?: string;
  status: RequirementStatus;
  version: number;
  accepted: boolean;
}

export const WorkflowStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "PAUSED",
  "WAITING_APPROVAL",
  "SUCCESS",
  "FAILED",
  "CANCELLED"
]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const WorkflowFailureStrategySchema = z.enum([
  "FAIL_FAST",
  "RETRY",
  "CONTINUE",
  "REPLAN",
  "ROLLBACK"
]);
export type WorkflowFailureStrategy = z.infer<typeof WorkflowFailureStrategySchema>;

/**
 * L1-5：DEPLOY 任务失败时的处置。**只定义 ROLLBACK**（自动回滚）——缺省 = 沿用
 * `failureStrategy`（现状：失败即按该策略处理，不会自动回滚）。
 * 回滚任务本身仍遵守既有审批规则：production 的回滚任务照样要人工批准（L1-9 红线）。
 */
export const DeployFailureStrategySchema = z.enum(["ROLLBACK"]);
export type DeployFailureStrategy = z.infer<typeof DeployFailureStrategySchema>;

export const WorkflowPolicySchema = z
  .object({
    maxConcurrency: z.number().int().min(1).max(16).default(2),
    maxRetries: z.number().int().min(0).max(10).default(1),
    failureStrategy: WorkflowFailureStrategySchema.default("FAIL_FAST"),
    allowRetry: z.boolean().default(true),
    allowReplan: z.boolean().default(false),
    approvalRequired: z.boolean().default(false),
    /** T6：工作流级预算上限（正数；缺省 = 不限制）。maxCostUsd 仅在存在成本数据时生效。 */
    maxCostUsd: z.number().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxWallClockMs: z.number().int().positive().optional(),
    /** 自治 L1：缺省 = 非自治工作流，行为与既有版本逐项一致（L1-7 判据）。 */
    autonomyLevel: AutonomyLevelSchema.optional(),
    /** 自治 L1-5：仅在声明时生效；未声明时 DEPLOY 失败沿用 failureStrategy。 */
    deployFailureStrategy: DeployFailureStrategySchema.optional()
  })
  .strict();
export type WorkflowPolicy = z.infer<typeof WorkflowPolicySchema>;

/** 工作流策略默认值（创建输入缺省时使用；F1-7/FX-23 的钳制在其上做）。 */
export const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy = {
  maxConcurrency: 2,
  maxRetries: 1,
  failureStrategy: "FAIL_FAST",
  allowRetry: true,
  allowReplan: false,
  approvalRequired: false
};

/**
 * 自治 L1 的策略预设（`docs/154` §6 裁定）：调用方把它并进 policy 即得到 L1 行为。
 * 各字段的含义沿用既有语义——L1 不新增第二套失败/重试机制，只是把这组值声明出来：
 *  - `failureStrategy: "RETRY"` + `maxRetries: 2`：失败自动恢复，上限 2（L1-5 裁定值）；
 *  - `deployFailureStrategy: "ROLLBACK"`：DEPLOY 失败自动回滚（仅 staging 生效于无审批路径）；
 *  - `autonomyLevel: "L1"`：验证门按 enforce 取（L1-4）、写自治决策事件（L1-6）。
 * **不含 `approvalRequired`**：生产与高风险的人工门不由策略关闭（L1-9 红线）。
 */
export const L1_WORKFLOW_POLICY = {
  autonomyLevel: "L1",
  // PL-M18（N-11）：由 `RETRY` 改为 `REPLAN` 并打开 `allowReplan`——详见 `isWorkTaskType` 与
  // `packages/eval/src/cli.ts` 的 `L1_POLICY_OVERRIDE`。两份定义**必须保持一致**（该处注明
  // 「取值与平台 L1_WORKFLOW_POLICY 一致」），否则又是本仓反复出现过的「两份定义漂移」缺陷。
  failureStrategy: "REPLAN",
  allowRetry: true,
  maxRetries: 2,
  allowReplan: true,
  deployFailureStrategy: "ROLLBACK"
} as const satisfies Partial<WorkflowPolicy>;

/**
 * 切片自治工作流默认策略：自动启动的 slice workflow 走这条，而不是 DEFAULT FAIL_FAST。
 *
 * 产品意图：门禁 / QA / 验证门只要给出可行动的报错证据，就应进入既有 REPLAN 修复链
 * （DEBUG → 工作类型修复 → 重跑），而不是「审批不通过 / 等人工」死掉。
 * 取值与 L1 对齐（REPLAN + allowReplan + maxRetries:2 + autonomyLevel），
 * **仍不含 approvalRequired**——生产 DEPLOY 人工门由交付规则单独强制，不被本预设绕过。
 */
export const SLICE_WORKFLOW_POLICY = {
  ...L1_WORKFLOW_POLICY
} as const satisfies Partial<WorkflowPolicy>;

/**
 * 切片启动时的策略：合并 DEFAULT + SLICE_WORKFLOW_POLICY。
 *
 * 显式传入若已是自治 REPLAN（allowReplan + failureStrategy=REPLAN + L1/L2）则原样保留；
 * 否则（含从旧 FAIL_FAST 工作流 inherit 来的策略）**升级**为切片自治默认——否则重开/重试
 * 会继续 FAIL_FAST，门禁报错进不了修复链。手工非切片工作流仍走 DEFAULT_WORKFLOW_POLICY。
 */
export function resolveSliceWorkflowPolicy(explicit?: WorkflowPolicy): WorkflowPolicy {
  const sliceDefault: WorkflowPolicy = {
    ...DEFAULT_WORKFLOW_POLICY,
    ...SLICE_WORKFLOW_POLICY
  };
  if (!explicit) return sliceDefault;
  if (
    isAutonomyAtLeastL1(explicit) &&
    explicit.allowReplan === true &&
    explicit.failureStrategy === "REPLAN"
  ) {
    return explicit;
  }
  return {
    ...sliceDefault,
    approvalRequired: explicit.approvalRequired,
    ...(explicit.maxCostUsd !== undefined ? { maxCostUsd: explicit.maxCostUsd } : {}),
    ...(explicit.maxTokens !== undefined ? { maxTokens: explicit.maxTokens } : {}),
    ...(explicit.maxWallClockMs !== undefined ? { maxWallClockMs: explicit.maxWallClockMs } : {})
  };
}

/**
 * 工作流是否享有**自治 L1 基线**（唯一判据，避免各处自行读字段）。
 * **L2 ⊇ L1**：声明 L2 的工作流同样返回 `true`（`docs/227` §8 红线「L2 不得回退 L1」）。
 */
export function isAutonomyAtLeastL1(policy: WorkflowPolicy): boolean {
  return policy.autonomyLevel === "L1" || policy.autonomyLevel === "L2";
}

const EXCLUDED_TEST_PATH_SEGMENTS = new Set(["node_modules", ".git", "dist", "coverage", ".next"]);
const TEST_FILE_NAME_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * PL-M10（`docs/168` §4 裁定 3）：仓库根级工程清单/配置文件集合。口径**逐条沿用**
 * `apps/server/src/services/writeScopeAudit.ts` 原先的 `CONFIG_PATH`（审计侧的既有语义），
 * 本判据只是把它上移为两侧共用的一份实现。
 */
const ROOT_MANIFEST_PATTERNS: readonly RegExp[] = [
  /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml)$/i,
  /^[^/]*\.config\.[a-z]+$/i,
  /^\.env(\.|$)/,
  /^\.(gitignore|eslintrc[^/]*|prettierrc[^/]*|prettierignore|npmrc|nvmrc)$/i,
  /^(eslint\.config|prettier\.config|vite\.config|vitest\.config|jest\.config)\.[a-z]+$/i,
  /^Makefile$/i
];

/**
 * PL-M5（`docs/158` §3）：**唯一**的「这是不是一个测试文件」判据。
 * 两处消费，故置于 shared——两份定义必然漂移，而漂移正是写范围缺陷的成因类型：
 *  - `apps/server` 的防篡改（受保护测试文件快照比对，原 `isProtectedTestPath`）；
 *  - `@ai-se/agent-core` 的写权限（以写测试为职责的 agent 可写**任意位置**的测试文件）。
 * 判定：文件名匹配 `*.test.*` / `*.spec.*`，或路径中出现 `test` / `tests` / `__tests__` 段；
 * 依赖目录与构建产物目录内的同名文件不算。
 */
export function isTestFilePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!normalized) return false;
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => EXCLUDED_TEST_PATH_SEGMENTS.has(segment))) return false;
  const base = segments[segments.length - 1] ?? "";
  if (TEST_FILE_NAME_PATTERN.test(base)) return true;
  return segments
    .slice(0, -1)
    .some((segment) => segment === "test" || segment === "tests" || segment === "__tests__");
}

/**
 * PL-M10（`docs/168`）：**唯一**的「这是不是一个工程清单/配置文件」判据。只判**仓库根级**
 * 条目（任何带 `/` 的路径一律为假）。
 *
 * 两处消费，故与 `isTestFilePath` 同置于 shared——两份定义必然漂移，而漂移正是本缺陷的成因：
 *  - `apps/server` 的写范围审计（原 `writeScopeAudit.ts` 内的 `CONFIG_PATH` 正则表）；
 *  - `@ai-se/agent-core` 的写权限（声明了 `writeProjectManifests` 的 agent 可写仓库根清单）。
 *
 * 修前两侧**互相矛盾**：审计早已把根级 `package.json` 判为 BACKEND 任务的合法写入，而强制侧的
 * 前缀白名单（`apps/server`、`server`、`backend`、`src`）把它全部拒绝——工程骨架任务因此写不出
 * `package.json`（L1-M4b run 1 在第一个任务上即致败）。
 */
export function isProjectManifestPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!normalized || normalized.includes("/")) return false;
  return ROOT_MANIFEST_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * PL-M11（`docs/170` §4 裁定 4）：仓库根级**交付物**集合。口径**逐条沿用**
 * `apps/server/src/services/writeScopeAudit.ts` 的 `DEVOPS_PATH` 中交付物那几条（审计侧的既有
 * 语义），本判据只是把它上移为两侧共用的一份实现。
 *
 * 与 `isProjectManifestPath` 并列而非合并：工程清单/配置与交付物是两类东西（前者是「工程怎么
 * 组织」，后者是「交付出去的东西」），口径来源也不同（审计侧的 `CONFIG_PATH` vs 当时的
 * `DEVOPS_PATH`——后者已于 N-18（`docs/190`）删除，devops 的构建属地改为从 `writePaths` 派生）。
 */
const ROOT_DELIVERY_ARTIFACT_PATTERNS: readonly RegExp[] = [
  /^Dockerfile(\.[^/]+)?$/i,
  /^\.dockerignore$/i,
  /^(docker-)?compose(\.[^/]*)?\.ya?ml$/i,
  /^README(\.[^/]+)?$/i
];

/**
 * PL-M11（`docs/170`）：**唯一**的「这是不是一个仓库根交付物」判据。只判**仓库根级**条目
 * （任何带 `/` 的路径一律为假）。
 *
 * 两处消费，故与 `isTestFilePath` / `isProjectManifestPath` 同置于 shared：
 *  - `apps/server` 的写范围审计（原 `DEVOPS_PATH` 的 Dockerfile / compose / .dockerignore /
 *    README 四条正则，且只挂在 `DEPLOY` 上）；
 *  - `@ai-se/agent-core` 的写权限（声明了 `writeRootDeliveryArtifacts` 的 agent 可写仓库根交付物）。
 *
 * 修前这两件事在计划里都是 `BACKEND` 任务，而没有任何 agent 能写仓库根（前缀白名单表达不了
 * 「根本身」）：L1-M4c run 2 的 S4-10（「编写 Dockerfile … 保证 `docker build -t taskboard .`
 * 成功」）三次尝试全部被拒，把同一份 Dockerfile 写到 `backend/` / `server/` / `apps/server/`，
 * 而 oracle 的容器段在仓库根执行 `docker build` —— AC-24/25/26/29 四条 Must 全灭。
 */
export function isRootDeliveryArtifactPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!normalized || normalized.includes("/")) return false;
  return ROOT_DELIVERY_ARTIFACT_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * PL-M12（`docs/170` §4 裁定 7）：**唯一**的「路径是否落在任一条前缀白名单下」判据。
 *
 * 语义与 `ToolRuntimeBackend` 的 `allowed()` 逐字相同：`"."` 表示「全部」；条目可以是目录前缀
 * （`src`）也可以是**单个根文件**（`package.json`、`Dockerfile`）。
 *
 * 两处消费：`@ai-se/agent-core` 的读写权限判定，与 `apps/server` 的写范围审计（后者原先用一张
 * 手抄的正则表 `SOURCE_PATH` 表达同一件事——那张表描述的是 `app/`（单数）、`pages/`、`lib/`、
 * `components/` 这类本仓库并不存在的布局，于是对真实的 `apps/`、`packages/` 一律误报越界）。
 */
export function isPathUnderPrefixes(relPath: string, prefixes: readonly string[]): boolean {
  const relative = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return prefixes.some((prefix) => {
    const normalizedPrefix = prefix.replace(/\\/g, "/").replace(/^\/+/, "");
    return (
      normalizedPrefix === "." ||
      relative === normalizedPrefix ||
      relative.startsWith(`${normalizedPrefix}/`)
    );
  });
}

/**
 * F1-7（FX-23）：T3（并行执行器）完成前不开放并行——工作流创建期把 `maxConcurrency` 钳为 1。
 * 返回 `requestedMaxConcurrency` 供事件/提示记录（钳制事实必须可观测，不静默）。
 */
export function enforceSerialWorkflowPolicy(policy: WorkflowPolicy): {
  policy: WorkflowPolicy;
  requestedMaxConcurrency: number;
  clamped: boolean;
} {
  const requestedMaxConcurrency = policy.maxConcurrency;
  if (requestedMaxConcurrency <= 1) {
    return { policy, requestedMaxConcurrency, clamped: false };
  }
  return { policy: { ...policy, maxConcurrency: 1 }, requestedMaxConcurrency, clamped: true };
}

/** T6：PATCH /api/workflows/:id/policy 的输入（null = 清除该上限；缺省 = 保持不变）。 */
export const UpdateWorkflowPolicySchema = z
  .object({
    maxCostUsd: z.number().positive().nullable().optional(),
    maxTokens: z.number().int().positive().nullable().optional(),
    maxWallClockMs: z.number().int().positive().nullable().optional()
  })
  .strict();
export type UpdateWorkflowPolicyInput = z.input<typeof UpdateWorkflowPolicySchema>;
export type UpdateWorkflowPolicyData = z.output<typeof UpdateWorkflowPolicySchema>;

export const CreateWorkflowSchema = z
  .object({
    projectId: z.string().uuid(),
    requirementId: z.string().uuid(),
    workspacePath: z.string().trim().min(1).max(1000).optional(),
    planningVersion: z.number().int().positive().optional(),
    /** N2：工作流仅绑定该切片的计划任务（缺省=绑定该版本全部计划任务，旧行为）。 */
    sliceKey: z.string().trim().min(1).max(40).optional(),
    policy: WorkflowPolicySchema.optional().default(DEFAULT_WORKFLOW_POLICY),
    approvalTaskKeys: z.array(z.string().trim().min(1).max(80)).default([])
  })
  .strict();
export type CreateWorkflowInput = z.input<typeof CreateWorkflowSchema>;
export type CreateWorkflowData = z.output<typeof CreateWorkflowSchema>;

export interface WorkflowRun {
  id: string;
  projectId: string;
  requirementId: string;
  planningVersion: number;
  status: WorkflowStatus;
  policy: WorkflowPolicy;
  input: JsonObject;
  output?: JsonObject;
  error?: ApiErrorBody;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const ApprovalStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalDecisionSchema = z
  .object({
    comment: z.string().trim().max(1000).optional().default("")
  })
  .strict();
export type ApprovalDecisionInput = z.input<typeof ApprovalDecisionSchema>;
export type ApprovalDecisionData = z.output<typeof ApprovalDecisionSchema>;

export interface Approval {
  id: string;
  /** 任务级审批（既有）；需求级（关口 1）审批两者缺省。 */
  workflowRunId?: string;
  taskId?: string;
  /** N2 关口 1：需求级切片计划审批的归属需求。 */
  requirementId?: string;
  status: ApprovalStatus;
  reason: string;
  comment: string;
  requestedAt: string;
  decidedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowGraph {
  tasks: Task[];
  dependencies: TaskDependencyView[];
}

export interface WorkflowDetailView {
  workflow: WorkflowRun;
  tasks: Task[];
  dependencies: TaskDependencyView[];
  approvals: Approval[];
  events: WorkflowEvent[];
}

export type WorkflowStreamPayload = WorkflowDetailView;

/**
 * 7-C：端到端追踪视图——由既有事实表派生（`workflow_runs` / `tasks` / `agent_runs` /
 * `tool_calls` / `deployments`），不引入 span 概念，也不新增埋点。
 */
export type TraceNodeKind = "workflow" | "task" | "agentRun" | "toolCall" | "deployment";

export interface TraceNode {
  kind: TraceNodeKind;
  /** 各表自身的行 ID。 */
  id: string;
  /** 可读标签（workflowId / taskKey / Agent 名 / toolName / `environment operation`）。 */
  label: string;
  /** 该表自身的状态词（TaskStatus / AgentRunStatus / ToolCallStatus / DeploymentStatus）。 */
  status: string;
  startedAt?: string;
  finishedAt?: string;
  /** 两端时间戳齐全时的毫秒差；工具调用回落到记录的 `duration`。 */
  durationMs?: number;
  /** 白名单字段的只读摘要；字符串已过 `redactCredentialShapedText`。不含工具输入 / 输出。 */
  detail: JsonObject;
  children: TraceNode[];
}

/** OB-07：逐类节点数，与库中行数一一对应。 */
export interface WorkflowTraceCounts {
  tasks: number;
  agentRuns: number;
  toolCalls: number;
  deployments: number;
}

export interface WorkflowTraceView {
  workflowRunId: string;
  /** 触发该运行的 HTTP 请求 ID（`WORKFLOW_STARTED` payload）；7-A 之前启动的运行没有。 */
  requestId?: string;
  generatedAt: string;
  root: TraceNode;
  counts: WorkflowTraceCounts;
}

/**
 * 7-E：自治决策事件契约（供 `docs/17`「自治 L1」的 L1-6 使用）。
 *
 * 事件写进**既有** `workflow_events` 表：`event_type` = 下表的事件名，`payload` = 对应 schema。
 * 不新增表、不新增事件体系。本阶段**只有契约、没有写入方**（7-E 不改变任何现有行为）；
 * 写入方属自治 L1 的实现，排在 M2 之后。
 *
 * 红线（`docs/147` §7）：payload 不含密钥；`reason` 由写入方在落库前走既有脱敏路径
 * （`@ai-se/observability` 的 sanitize）——本契约不重复实现脱敏，也不放宽任何人工门。
 */
export const AutonomyDecisionEventTypeSchema = z.enum([
  "AUTO_APPROVED",
  "AUTO_RETRIED",
  "AUTO_ROLLED_BACK",
  "VERIFICATION_ENFORCED_FAILURE",
  /** 自治 L2（`docs/227`）：关口 1 的切片计划被判据自动批准。 */
  "GATE1_AUTO_APPROVED"
]);
export type AutonomyDecisionEventType = z.infer<typeof AutonomyDecisionEventTypeSchema>;
export const AUTONOMY_DECISION_EVENT_TYPES: readonly AutonomyDecisionEventType[] =
  AutonomyDecisionEventTypeSchema.options;

/** 四个事件的公共字段：策略标识与依据（L1-6）+ 归属（可按 `workflowRunId` 查询）。 */
const autonomyDecisionBase = {
  /** 做出该决策的自治策略标识。L1-7 的策略载体落地前，约定用级别名（如 `"L1"`）。 */
  policyId: z.string().trim().min(1).max(64),
  /** 决策依据（人可读；不含密钥）。 */
  reason: z.string().trim().min(1).max(500),
  workflowRunId: z.string().uuid(),
  taskId: z.string().uuid()
};

/**
 * 自动批准。**仅 staging**——生产审批门不可由策略关闭（L1-9 红线），
 * 因此 `production` 在契约层就不可表达，而不是靠写入方自觉。
 */
export const AutoApprovedDecisionPayloadSchema = z
  .object({
    ...autonomyDecisionBase,
    environment: z.literal("staging"),
    /** 被自动批准的那条审批记录（存在时）。 */
    approvalId: z.string().uuid().optional()
  })
  .strict();

/** 自动重试。`attempt <= maxAttempts`——L1-5 的「有界」在契约层成立。 */
export const AutoRetriedDecisionPayloadSchema = z
  .object({
    ...autonomyDecisionBase,
    attempt: z.number().int().min(1),
    maxAttempts: z.number().int().min(1)
  })
  .strict()
  .refine((value) => value.attempt <= value.maxAttempts, {
    path: ["attempt"],
    message: "attempt must not exceed maxAttempts"
  });

/** 自动回滚（L1-5 的 staging 失败自动回滚）。 */
export const AutoRolledBackDecisionPayloadSchema = z
  .object({
    ...autonomyDecisionBase,
    environment: DeliveryEnvironmentSchema,
    /** 被回滚的那个部署。 */
    deploymentId: z.string().uuid(),
    /** 回滚到的部署（存在时）。 */
    rollbackDeploymentId: z.string().uuid().optional()
  })
  .strict();

/** 质量门在 `enforce` 下的失败判定（L1-4）。只带检查名，不带输出。 */
export const VerificationEnforcedFailurePayloadSchema = z
  .object({
    ...autonomyDecisionBase,
    failedChecks: z.array(z.string().trim().min(1).max(120)).min(1),
    gateMode: z.literal("enforce"),
    commitSha: z.string().trim().min(1).max(80).optional()
  })
  .strict();

/**
 * 关口 1 自动批准（自治 L2，`docs/227`）。
 *
 * **不复用 `AUTO_APPROVED`**：那条契约把 `environment` 锁死为 `"staging"`，且公共字段要求
 * `workflowRunId` / `taskId` —— 关口 1 发生在**任何工作流之前**，这两个 uuid 尚不存在。
 * 故本事件自带 `requirementId` 归属，不继承 `autonomyDecisionBase`。
 */
export const Gate1AutoApprovedPayloadSchema = z
  .object({
    policyId: z.string().trim().min(1).max(64),
    /** 决策依据（人可读；落库前走既有 sanitize）。 */
    reason: z.string().trim().min(1).max(500),
    requirementId: z.string().uuid(),
    /** 被自动批准的那条关口 1 审批（存在时）。 */
    approvalId: z.string().uuid().optional(),
    sliceCount: z.number().int().min(1),
    /** 命中的判据名（设备可读；与 `evaluateSlicePlanGate` 的判据集同源）。 */
    satisfiedReasons: z.array(z.string().trim().min(1).max(64)).min(1),
    estimatedFinalSliceTasks: z.number().int().min(0)
  })
  .strict();

export type AutoApprovedDecisionPayload = z.infer<typeof AutoApprovedDecisionPayloadSchema>;
export type AutoRetriedDecisionPayload = z.infer<typeof AutoRetriedDecisionPayloadSchema>;
export type AutoRolledBackDecisionPayload = z.infer<typeof AutoRolledBackDecisionPayloadSchema>;
export type VerificationEnforcedFailurePayload = z.infer<
  typeof VerificationEnforcedFailurePayloadSchema
>;
export type Gate1AutoApprovedPayload = z.infer<typeof Gate1AutoApprovedPayloadSchema>;
export type AutonomyDecisionPayload =
  | AutoApprovedDecisionPayload
  | AutoRetriedDecisionPayload
  | AutoRolledBackDecisionPayload
  | VerificationEnforcedFailurePayload
  | Gate1AutoApprovedPayload;

/** 事件名 → payload 契约的唯一映射（写入方与审计方共用这一处）。 */
export const AUTONOMY_DECISION_PAYLOAD_SCHEMAS = {
  AUTO_APPROVED: AutoApprovedDecisionPayloadSchema,
  AUTO_RETRIED: AutoRetriedDecisionPayloadSchema,
  AUTO_ROLLED_BACK: AutoRolledBackDecisionPayloadSchema,
  VERIFICATION_ENFORCED_FAILURE: VerificationEnforcedFailurePayloadSchema,
  GATE1_AUTO_APPROVED: Gate1AutoApprovedPayloadSchema
} as const;

/** 校验一条自治决策事件的 payload；不合法时抛 `ZodError`。 */
export function parseAutonomyDecisionPayload(
  eventType: AutonomyDecisionEventType,
  payload: unknown
): AutonomyDecisionPayload {
  return AUTONOMY_DECISION_PAYLOAD_SCHEMAS[eventType].parse(payload);
}

/**
 * UX-02: list-facing DTO. `WorkflowRun` plus the business context the workflow
 * list needs without opening the detail or maintaining a second client-side
 * project/requirement mapping (names are resolved server-side).
 */
export interface WorkflowSummary extends WorkflowRun {
  projectName: string | null;
  requirementName: string | null;
  taskProgress: {
    /** All runtime tasks of the workflow run. */
    total: number;
    /** Tasks in SUCCESS state. */
    completed: number;
  };
}

/** UX-02: server-side paginated workflow events (created_at DESC). */
export interface WorkflowEventPage {
  items: WorkflowEvent[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export const AgentTypeSchema = z.enum([
  "PLANNER",
  "FRONTEND",
  "BACKEND",
  "DATABASE",
  "QA",
  "REVIEWER",
  "DEVOPS"
]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export type AgentCapability =
  | "PLAN"
  | "FRONTEND_CODE"
  | "BACKEND_CODE"
  | "DATABASE_SCHEMA"
  | "TEST"
  | "REVIEW"
  | "BUILD";

export interface AgentPermissionView {
  tools: string[];
  pathPrefixes: string[];
  readOnly: boolean;
}

export interface AgentDefinitionView {
  name: string;
  type: AgentType;
  description: string;
  capabilities: AgentCapability[];
  tools: string[];
  permissions: AgentPermissionView;
  status: "available";
}

export type AgentArtifactType =
  | "CODE_DIFF"
  | "TEST_RESULT"
  | "REVIEW_RESULT"
  | "BUILD_RESULT"
  | "DOCUMENTATION"
  | "GENERATED_FILE";

export interface AgentArtifact {
  id: string;
  projectId: string;
  taskId: string;
  agentRunId: string;
  agentName: string;
  type: AgentArtifactType;
  name: string;
  content: JsonObject;
  metadata: JsonObject;
  createdAt: string;
}

export interface AgentEvaluationMetrics {
  agentSuccessRate?: number;
  taskSuccessRate?: number;
  toolSuccessRate?: number;
  testPassRate?: number;
  reviewPassRate?: number;
  repairSuccessRate?: number;
  averageAgentIterations?: number;
  averageTaskDurationMs?: number;
  tokenUsage?: number;
  estimatedCost?: number;
}

export interface AgentRegistryDetail {
  definition: AgentDefinitionView;
  runs: AgentRun[];
  artifacts: AgentArtifact[];
}

export const CiRunStatusSchema = z.enum(["QUEUED", "RUNNING", "SUCCESS", "FAILED", "CANCELLED"]);
export type CiRunStatus = z.infer<typeof CiRunStatusSchema>;

export const DeploymentStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "SUCCESS",
  "FAILED",
  "ROLLING_BACK",
  "ROLLED_BACK",
  "ROLLBACK_FAILED"
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

export interface DeploymentEnvironmentConfig {
  id: string;
  projectId: string;
  name: DeliveryEnvironment;
  endpoint: string;
  /** N-73：`static` = 工作区优先的前端（静态预览 + 浏览器验证）。 */
  adapter: "docker" | "static";
  configuration: JsonObject;
  secretReference?: string;
  createdAt: string;
  updatedAt: string;
}

export const UpsertDeploymentEnvironmentSchema = z
  .object({
    projectId: z.string().uuid(),
    name: DeliveryEnvironmentSchema,
    endpoint: z.string().url(),
    /** N-73：`static` = 工作区优先的前端（起静态预览 + 浏览器验证），缺省仍是 docker。 */
    adapter: z.enum(["docker", "static"]).default("docker"),
    configuration: z.record(z.string(), z.unknown()).default({}),
    secretReference: z.string().trim().min(1).max(300).optional()
  })
  .strict();
export type UpsertDeploymentEnvironmentInput = z.input<typeof UpsertDeploymentEnvironmentSchema>;
export type UpsertDeploymentEnvironmentData = z.output<typeof UpsertDeploymentEnvironmentSchema>;

export interface CiRun {
  id: string;
  projectId: string;
  workflowRunId: string;
  taskId: string;
  agentRunId?: string;
  provider: "github" | "local";
  providerRunId?: string;
  workflowFile: string;
  gitCommit?: string;
  pullRequest?: number;
  image?: string;
  status: CiRunStatus;
  url?: string;
  error?: ApiErrorBody;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Deployment {
  id: string;
  projectId: string;
  workflowRunId: string;
  taskId: string;
  agentRunId?: string;
  ciRunId?: string;
  version: string;
  environment: DeliveryEnvironment;
  image: string;
  gitCommit: string;
  operation: "DEPLOY" | "ROLLBACK";
  status: DeploymentStatus;
  endpoint: string;
  healthCheck: JsonObject;
  rollbackVersion?: string;
  rollbackDeploymentId?: string;
  rollbackReason?: string;
  rollbackAt?: string;
  error?: ApiErrorBody;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentLog {
  id: string;
  deploymentId: string;
  level: "info" | "warn" | "error";
  message: string;
  metadata: JsonObject;
  createdAt: string;
}

export interface DeploymentDetailView {
  deployment: Deployment;
  logs: DeploymentLog[];
  ciRun?: CiRun;
  environment?: DeploymentEnvironmentConfig;
}

export const CreateDeploymentSchema = z
  .object({
    projectId: z.string().uuid(),
    workflowRunId: z.string().uuid(),
    taskId: z.string().uuid(),
    version: z.string().trim().min(1).max(160),
    environment: DeliveryEnvironmentSchema,
    image: z.string().trim().min(1).max(500),
    gitCommit: z.string().trim().min(7).max(160),
    ciRunId: z.string().uuid().optional()
  })
  .strict();
export type CreateDeploymentInput = z.input<typeof CreateDeploymentSchema>;
export type CreateDeploymentData = z.output<typeof CreateDeploymentSchema>;

export const RollbackDeploymentSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();
export type RollbackDeploymentInput = z.input<typeof RollbackDeploymentSchema>;
export type RollbackDeploymentData = z.output<typeof RollbackDeploymentSchema>;

// ─── MCP Console (Phase 5.5-5) ─────────────────────────────────────────────
//
// DTOs for the MCP management API. They mirror — but deliberately do NOT
// import — @ai-se/mcp / @ai-se/tool-runtime: the browser must never depend on
// the MCP runtime packages (no MCP SDK, no MCP client in the frontend).

export type MCPServerStatus =
  | "REGISTERED"
  | "CONNECTING"
  | "CONNECTED"
  | "DEGRADED"
  | "RECONNECTING"
  | "DISCONNECTED"
  | "REVOKED";

export type MCPTransportKind = "stdio" | "streamable-http";

export type MCPToolRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface MCPServerSummary {
  id: string;
  name: string;
  description: string;
  transport: MCPTransportKind;
  enabled: boolean;
  status: MCPServerStatus;
  toolCount: number;
  lastConnectedAt?: string;
  lastError?: string;
}

export interface MCPServerDetail extends MCPServerSummary {
  /** stdio transport only. */
  command?: string;
  args?: string[];
  /** streamable-http transport only. */
  endpoint?: string;
  /** References only — never credential values. */
  authRef?: string;
  credentialRef?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MCPToolSummary {
  id: string;
  serverId: string;
  name: string;
  description: string;
  enabled: boolean;
  riskLevel: MCPToolRisk;
  requiresApproval: boolean;
  /** Compact input schema summary (first console version has no editor). */
  inputSchemaSummary: string;
}

export interface MCPBindingSummary {
  id: string;
  projectId: string;
  projectName?: string;
  agentName?: string;
  serverId: string;
  serverName?: string;
  toolId?: string;
  toolName?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export const CreateMCPBindingSchema = z
  .object({
    projectId: z.string().uuid(),
    agentName: z.string().trim().min(1).max(160).optional(),
    toolName: z.string().trim().min(1).max(160).optional(),
    enabled: z.boolean().optional()
  })
  .strict();
export type CreateMCPBindingInput = z.input<typeof CreateMCPBindingSchema>;
export type CreateMCPBindingData = z.output<typeof CreateMCPBindingSchema>;

export const UpdateMCPBindingSchema = z.object({ enabled: z.boolean() }).strict();
export type UpdateMCPBindingInput = z.input<typeof UpdateMCPBindingSchema>;
export type UpdateMCPBindingData = z.output<typeof UpdateMCPBindingSchema>;

/**
 * 控制台注册一台 MCP 服务器（T2）。
 *
 * 只收**形状**：传输方式的强制项（stdio 要有 command、http 要有合法且不含凭据的
 * endpoint）由 `@ai-se/mcp` 的 `validateMCPServerDefinition` 权威判定——
 * 那是冻结契约（`docs/25`），这里再抄一份只会漂移。
 *
 * **没有 env 字段**：stdio 的 env 会把明文凭据落到 `mcp_servers.env`，
 * 与 `AGENTS.md` §10 冲突；需要 env 的服务走带外注册。
 */
export const CreateMCPServerSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).optional(),
    transport: z.enum(["stdio", "streamable-http"]),
    /** stdio transport only. */
    command: z.string().trim().min(1).max(500).optional(),
    args: z.array(z.string().max(500)).max(50).optional(),
    cwd: z.string().trim().min(1).max(1000).optional(),
    /** streamable-http transport only. */
    endpoint: z.string().trim().min(1).max(2000).optional(),
    /** Reference only — never a credential value. */
    credentialRef: z.string().trim().min(1).max(200).optional(),
    /** 缺省 true：控制台加进来的服务器是要用的，不是摆设。 */
    enabled: z.boolean().optional()
  })
  .strict();
export type CreateMCPServerInputData = z.input<typeof CreateMCPServerSchema>;
export type CreateMCPServerData = z.output<typeof CreateMCPServerSchema>;

/**
 * 工具的启停（T2）。
 *
 * `mcp_tools.enabled` 建表默认 FALSE（迁移 008 的原话是「must be explicitly enabled」），
 * 而可见性链要求 `tool.enabled` —— 所以没有这个开关，发现的工具**永远不可用**。
 * 默认值不改：发现即启用等于让任何被加进来的服务器自动获得调用权。
 */
export const UpdateMCPToolSchema = z.object({ enabled: z.boolean() }).strict();
export type UpdateMCPToolInput = z.input<typeof UpdateMCPToolSchema>;
export type UpdateMCPToolData = z.output<typeof UpdateMCPToolSchema>;

// ─── MCP Apps (Phase 5.5-7) ────────────────────────────────────────────────
//
// Sandboxed-iframe bridge contract. Messages are schema-validated on BOTH
// sides with strict objects (unknown fields rejected). The channel carries no
// credentials by construction: the browser never holds MCP credentials, and
// the backend re-authorizes every controlled action through the existing
// permission/policy/approval chain.

export const MCP_APP_CHANNEL = "ai-se.mcp-app" as const;
/** Maximum serialized argument payload accepted from an app. */
export const MCP_APP_MAX_ARGUMENT_BYTES = 65_536;

/** One controlled action an app may ask the host to run. */
export const MCPAppActionSchema = z
  .object({
    kind: z.literal("tool"),
    toolName: z.string().trim().min(1).max(160),
    arguments: z.record(z.string(), z.unknown()).optional()
  })
  .strict();
export type MCPAppAction = z.infer<typeof MCPAppActionSchema>;

/** app → host messages (validated by the host bridge). */
export const MCPAppInboundMessageSchema = z.discriminatedUnion("type", [
  z.object({ channel: z.literal(MCP_APP_CHANNEL), type: z.literal("app/ready") }).strict(),
  z
    .object({
      channel: z.literal(MCP_APP_CHANNEL),
      type: z.literal("app/action"),
      id: z.string().trim().min(1).max(64),
      action: MCPAppActionSchema
    })
    .strict()
]);
export type MCPAppInboundMessage = z.infer<typeof MCPAppInboundMessageSchema>;

/** host → app messages (validated before posting). */
export const MCPAppOutboundMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      channel: z.literal(MCP_APP_CHANNEL),
      type: z.literal("host/init"),
      serverId: z.string().min(1).max(120),
      toolName: z.string().min(1).max(160).optional(),
      resourceUri: z.string().min(1).max(2000)
    })
    .strict(),
  z
    .object({
      channel: z.literal(MCP_APP_CHANNEL),
      type: z.literal("host/action-result"),
      id: z.string().min(1).max(64),
      ok: z.boolean(),
      data: z.unknown().optional(),
      error: z
        .object({ code: z.string().min(1).max(120), message: z.string().max(2000) })
        .strict()
        .optional()
    })
    .strict()
]);
export type MCPAppOutboundMessage = z.infer<typeof MCPAppOutboundMessageSchema>;

/** One UI-app link (tool `_meta.ui`) exposed to the console. */
export interface MCPAppLink {
  toolName: string;
  resourceUri: string;
}

/** The UI resource payload the console embeds (sandboxed iframe srcdoc). */
export interface MCPAppUiResource {
  uri: string;
  mimeType: string;
  html: string;
}

/** Console → backend controlled action request (backend re-authorizes everything). */
export const MCPAppActionRequestSchema = z
  .object({
    serverId: z.string().trim().min(1).max(120),
    projectId: z.string().uuid(),
    agentName: z.string().trim().min(1).max(160),
    toolName: z.string().trim().min(1).max(160),
    arguments: z.record(z.string(), z.unknown()).optional(),
    /** Host-side allowlist derived from the app context; enforced server-side. */
    allowedTools: z.array(z.string().trim().min(1).max(160)).max(64).optional(),
    timeoutMs: z.number().int().min(100).max(60_000).optional()
  })
  .strict();
export type MCPAppActionRequest = z.infer<typeof MCPAppActionRequestSchema>;

/** Audit metadata returned with a successful action (existing ToolAuditInfo). */
export interface MCPAppActionAudit {
  toolName: string;
  actor: string;
  riskLevel: MCPToolRisk;
  requestId: string;
}

export interface MCPAppActionResult {
  data?: unknown;
  duration: number;
  audit: MCPAppActionAudit;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5.6-0 — Visual Contract (frozen)
//
// Input / data-structure contracts ONLY. No parsing, no collection, no browser
// behavior, no persistence (docs/17 §5.6-0). Credential rule carried over from
// 5.5-0: reference fields (`*Ref`) point at external stores; no token / key /
// secret values anywhere in these structures.
// ─────────────────────────────────────────────────────────────────────────────

/** Visual input sources (Phase 5.6-0). `url://` is restricted to an allowlist. */
export const VisualInputTypeSchema = z.enum(["screenshot", "figma", "url", "code"]);
export type VisualInputType = z.infer<typeof VisualInputTypeSchema>;

/** Per-type URI schemes; a record's URI prefix MUST match its inputType. */
export const VISUAL_INPUT_URI_PREFIXES: Readonly<Record<VisualInputType, string>> = Object.freeze({
  screenshot: "screenshot://",
  figma: "figma://",
  url: "url://",
  code: "code://"
});

/** Viewport descriptor (positive integers only; shared by input and analysis). */
export const VisualViewportSchema = z
  .object({
    width: z.number().int().min(1).max(20_000),
    height: z.number().int().min(1).max(20_000)
  })
  .strict();
export type VisualViewport = z.infer<typeof VisualViewportSchema>;

/** Optional label buckets carried on any node (Phase 5.6-1 fills them). */
export const VisualStateNameSchema = z.enum([
  "default",
  "hover",
  "focus",
  "disabled",
  "loading",
  "empty",
  "error"
]);
export type VisualStateName = z.infer<typeof VisualStateNameSchema>;

/** Absolute rectangle in source-image or viewport coordinates (pixels). */
export const VisualRectSchema = z
  .object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().min(1),
    height: z.number().int().min(1)
  })
  .strict();
export type VisualRect = z.infer<typeof VisualRectSchema>;

/** Visual input types that MUST pass the controlled-origin allowlist. */
const ALLOWLIST_CHECKED_TYPES: readonly VisualInputType[] = ["url"];

export const VisualInputRecordSchema = z
  .object({
    inputType: VisualInputTypeSchema,
    /** `<inputType>://<path-or-reference>`; prefix MUST match inputType. */
    source: z.string().trim().min(1).max(2_000),
    viewport: VisualViewportSchema,
    /** External asset reference (file path or asset id) — never inline content. */
    assetRef: z.string().trim().min(1).max(500).optional(),
    /** Existing agent run reference, when the input belongs to a run. */
    agentRunRef: z.string().trim().min(1).max(120).optional()
  })
  .strict();

export type VisualInputRecord = z.infer<typeof VisualInputRecordSchema>;

/** Controlled origins (origin strings or host:port entries); empty = deny all. */
export type VisualInputAllowlist = readonly string[];

function matchesAllowlist(source: string, allowlist: VisualInputAllowlist): boolean {
  const sourceParts = parseHttpOrigin(source);
  if (!sourceParts) return false;
  return allowlist.some((entry) => {
    const entryParts = parseHttpOrigin(entry.startsWith("http") ? entry : `http://${entry}`);
    if (!entryParts) return false;
    // `url://` sources name a page by host:port; the allowlist entry decides
    // the effective protocol. Exact host:port match, or a localhost
    // / 127.0.0.1 family match with the same host (local dev previews).
    const sourceHostPort = `${sourceParts.hostname}${sourceParts.port ? `:${sourceParts.port}` : ""}`;
    const entryHostPort = `${entryParts.hostname}${entryParts.port ? `:${entryParts.port}` : ""}`;
    if (entryParts.protocol === "http:" || entryParts.protocol === "https:") {
      return sourceHostPort === entryHostPort;
    }
    return false;
  });
}

/** Origin parse without DOM `URL` (shared stays free of DOM lib types). */
interface URLParts {
  protocol: string;
  hostname: string;
  port: string;
  origin: string;
}

function parseHttpOrigin(value: string): URLParts | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(value);
  if (!match) return null;
  const protocol = `${match[1].toLowerCase()}:`;
  let authority = match[2];
  // Strip userinfo (@-part) and split host:port for comparison.
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1);
  const colon = authority.indexOf(":");
  const hostname = (colon >= 0 ? authority.slice(0, colon) : authority).toLowerCase();
  if (!hostname) return null;
  const port = colon >= 0 ? authority.slice(colon + 1) : "";
  const defaultPort = protocol === "http:" ? "80" : protocol === "https:" ? "443" : "";
  return {
    protocol,
    hostname,
    port,
    origin: `${protocol}//${hostname}${port && port !== defaultPort ? `:${port}` : ""}`
  };
}

/**
 * Parses and validates a VisualInputRecord. Validation is pure: no network,
 * no file system. `url://` inputs are only valid when their absolute origin is
 * on the provided allowlist (an empty allowlist denies every `url://` input).
 */
export function validateVisualInput(
  input: {
    inputType: VisualInputType;
    source: string;
    viewport: VisualViewport;
    assetRef?: string;
    agentRunRef?: string;
  },
  allowlist: VisualInputAllowlist = []
): { ok: true; record: VisualInputRecord } | { ok: false; reason: string } {
  const parsed = VisualInputRecordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Visual input is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`
    };
  }
  const record = parsed.data;
  const prefix = VISUAL_INPUT_URI_PREFIXES[record.inputType];
  if (!record.source.startsWith(prefix)) {
    return {
      ok: false,
      reason: `Visual input URI prefix must be "${prefix}" for inputType "${record.inputType}"`
    };
  }
  if (ALLOWLIST_CHECKED_TYPES.includes(record.inputType)) {
    if (!matchesAllowlist(record.source, allowlist)) {
      return {
        ok: false,
        reason: `Visual input URI "${record.source}" is not on the controlled-origin allowlist`
      };
    }
  }
  return { ok: true, record };
}

// ── UI Specification (page → section → element → state) ─────────────────────

export const VisualCoordinatesSchema = z
  .object({
    x: z.number().min(0),
    y: z.number().min(0)
  })
  .strict();
export type VisualCoordinates = z.infer<typeof VisualCoordinatesSchema>;

/** Geometry is REQUIRED on sections, optional (optional field) on elements. */
export const VisualNodeGeometrySchema = z
  .object({
    rect: VisualRectSchema,
    anchor: VisualCoordinatesSchema.optional()
  })
  .strict();
export type VisualNodeGeometry = z.infer<typeof VisualNodeGeometrySchema>;

/** A named UI state (hover / focus / ...) with optional geometry and notes. */
export const VisualStateSchema = z
  .object({
    state: VisualStateNameSchema,
    geometry: VisualNodeGeometrySchema.optional(),
    notes: z.string().trim().max(2_000).optional()
  })
  .strict();
export type VisualState = z.infer<typeof VisualStateSchema>;

export const VisualElementSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    role: z.enum([
      "text",
      "button",
      "input",
      "image",
      "icon",
      "link",
      "list",
      "table",
      "container",
      "other"
    ]),
    description: z.string().trim().max(2_000),
    geometry: VisualNodeGeometrySchema.optional(),
    states: z.array(VisualStateSchema).max(16).optional()
  })
  .strict();
export type VisualElement = z.infer<typeof VisualElementSchema>;

export const VisualSectionSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(300),
    /** REQUIRED on sections — the Phase 5.6-1 analysis anchor. */
    geometry: VisualNodeGeometrySchema,
    elements: z.array(VisualElementSchema).max(500).optional(),
    childSections: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
    states: z.array(VisualStateSchema).max(16).optional()
  })
  .strict();
export type VisualSection = z.infer<typeof VisualSectionSchema>;

export const VisualPageSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(300),
    viewport: VisualViewportSchema,
    sections: z.array(VisualSectionSchema).max(100)
  })
  .strict();
export type VisualPage = z.infer<typeof VisualPageSchema>;

/**
 * Complete page-level specification for one visual input.
 *
 * STABLE-ID CONTRACT (Phase 5.6-0, frozen): ids must be deterministic — the
 * same source analyzed twice MUST produce identical ids. `deterministicVisualId`
 * provides the canonical generator (level-ordered slug with a 1-based index).
 */
export const VisualSpecificationSchema = z
  .object({
    input: VisualInputRecordSchema,
    page: VisualPageSchema,
    generatedAt: z.string().datetime()
  })
  .strict();
export type VisualSpecification = z.infer<typeof VisualSpecificationSchema>;

/** Deterministic, collision-safe-within-page id: `"<level>:<name>:<index>"`. */
export function deterministicVisualId(
  level: "page" | "section" | "element",
  name: string,
  index: number
): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${level}:${slug || "unnamed"}:${index}`;
}

// ── Design Tokens ────────────────────────────────────────────────────────────

export const VisualTokenValueSchema = z.union([z.string().trim().min(1).max(500), z.number()]);
export type VisualTokenValue = string | number;

/** True when the value is a token reference (`@ref:<token-path>`). */
export function isTokenRef(value: VisualTokenValue): value is `@ref:${string}` {
  return typeof value === "string" && value.startsWith("@ref:");
}

export const DesignTokensSchema = z
  .object({
    colors: z.record(z.string(), z.union([z.string().max(200), z.number()])).optional(),
    typography: z.record(z.string(), z.union([z.string().max(200), z.number()])).optional(),
    spacing: z.record(z.string(), z.union([z.string().max(200), z.number()])).optional(),
    radii: z.record(z.string(), z.union([z.string().max(200), z.number()])).optional(),
    shadows: z.record(z.string(), z.union([z.string().max(500), z.number()])).optional(),
    motion: z.record(z.string(), z.union([z.string().max(200), z.number()])).optional()
  })
  .strict();
export type DesignTokens = z.infer<typeof DesignTokensSchema>;

/** Token namespaces that may exist on a DesignTokens object. */
export const DESIGN_TOKEN_NAMESPACES = [
  "colors",
  "typography",
  "spacing",
  "radii",
  "shadows",
  "motion"
] as const;

// ── Component Map ────────────────────────────────────────────────────────────

/**
 * Maps one UI-Spec node to an implementation component. `matched: false` IS
 * valid data (an explicit gap for 5.6-2); it must never be dropped silently.
 */
export const ComponentMapEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    componentName: z.string().trim().min(1).max(200).optional(),
    matched: z.boolean(),
    confidence: z.number().min(0).max(1).optional(),
    /** Reason when unmatched (required for gaps so callers get a definite message). */
    unmatchedReason: z.string().trim().min(1).max(500).optional()
  })
  .strict()
  // Gap invariants: an entry with `matched: false` MUST carry a definite
  // unmatchedReason and must not claim confidence / componentName.
  .refine((entry) => entry.matched || Boolean(entry.unmatchedReason), {
    message: "Structure mismatch needs a definite unmatchedReason (matched: false is real data)",
    path: ["unmatchedReason"]
  })
  .refine((entry) => entry.matched || !entry.confidence, {
    message: "confidence is only meaningful when matched is true",
    path: ["confidence"]
  });
export type ComponentMapEntry = z.infer<typeof ComponentMapEntrySchema>;

export const VisualComponentMapSchema = z
  .object({
    sourceInput: VisualInputRecordSchema,
    entries: z.array(ComponentMapEntrySchema).max(1_000)
  })
  .strict();
export type VisualComponentMap = z.infer<typeof VisualComponentMapSchema>;

// ── Phase 5.6-1: Visual Analysis Report (additive to the frozen 5.6-0 set) ──

/** Per-viewport analysis outcome summary. */
export interface VisualAnalysisViewportSummary {
  viewport: VisualViewport;
  /** Sections discovered for this viewport pass. */
  sectionCount: number;
  /** Elements discovered for this viewport pass. */
  elementCount: number;
}

/**
 * Structured summary of one analysis run (Phase 5.6-1). The full page detail
 * lives in the sibling VisualSpecification; this carries counts, the token
 * vocabulary seen and non-blocking warnings.
 */
export interface VisualAnalysisReport {
  /** Mirrors the specification's input source (for standalone reading). */
  inputSource: string;
  /** ISO datetime of the analysis pass. */
  analyzedAt: string;
  viewports: VisualAnalysisViewportSummary[];
  sectionCount: number;
  elementCount: number;
  /** Design token names seen (deduplicated, sorted). */
  tokenSummary: string[];
  /** Non-blocking analyzer/provider notes (low confidence, noise, [REDACTED]). */
  warnings: string[];
}

// ── Phase 5.7-0: Computer Use Contract (additive; zero behavior) ────────────

/**
 * Unified identity for one external action, discriminated by source.
 * Field names mirror the producing packages' existing ids — no second id
 * system. Arm contents are transport facts, never credentials.
 */
export const ExternalActionRefSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("browser"),
      sessionId: z.string().trim().min(1).max(120),
      /** stableId of the browser tool that ran (browser.navigate 等 5.6-3 名)。 */
      toolName: z.string().trim().min(1).max(120),
      /** Target URL / selector as-is; no semantic parsing here. */
      target: z.string().trim().min(1).max(2000)
    })
    .strict(),
  z
    .object({
      source: z.literal("mcp"),
      serverName: z.string().trim().min(1).max(200),
      toolName: z.string().trim().min(1).max(200),
      /** ToolRuntime toolCallId for the invocation. */
      callId: z.string().trim().min(1).max(120)
    })
    .strict(),
  z
    .object({
      source: z.literal("sandbox"),
      commandId: z.string().trim().min(1).max(120),
      runId: z.string().trim().min(1).max(120).optional()
    })
    .strict()
]);
export type ExternalActionRef = z.infer<typeof ExternalActionRefSchema>;

/** DOM snapshot: stable per-page ref + accessibility role/name. */
export const DomSnapshotSchema = z
  .object({
    nodes: z
      .array(
        z
          .object({
            ref: z.string().trim().min(1).max(120),
            role: z.string().trim().min(1).max(60),
            /** Accessible name; redact before entering audit artifacts. */
            name: z.string().trim().max(300),
            clickable: z.boolean(),
            text: z.string().max(2000)
          })
          .strict()
      )
      .max(2000)
  })
  .strict();
export type DomSnapshot = z.infer<typeof DomSnapshotSchema>;

/** Accessibility snapshot as serialized text + interactive node count. */
export const A11ySnapshotSchema = z
  .object({
    tree: z.string().max(200000),
    interactiveCount: z.number().int().min(0)
  })
  .strict();
export type A11ySnapshot = z.infer<typeof A11ySnapshotSchema>;

/**
 * One observation pass. At least one of dom/accessibility must exist; a
 * screenshotRef is a 5.6-0 style reference (`screenshot://...`) — base64
 * content is NEVER carried in the contract (caller passes it like 5.6-1).
 */
export const ObservationSchema = z
  .object({
    observationId: z.string().trim().min(1).max(120),
    actionRef: ExternalActionRefSchema,
    dom: DomSnapshotSchema.optional(),
    accessibility: A11ySnapshotSchema.optional(),
    screenshotRef: z
      .string()
      .trim()
      .regex(/^screenshot:\/\//)
      .optional(),
    takenAt: z.string().datetime()
  })
  .strict()
  .refine((observation) => Boolean(observation.dom || observation.accessibility), {
    message: "observation requires at least one of dom or accessibility",
    path: ["dom"]
  });
export type Observation = z.infer<typeof ObservationSchema>;

/**
 * Result of one external action. Failure codes are a STRING placeholder —
 * the frozen failure classification table lands in Phase 5.7-5. Cancellation
 * and timeout are timestamps here; the behaviors live in workflow-engine.
 */
export const ActionResultSchema = z
  .object({
    resultId: z.string().trim().min(1).max(120),
    actionRef: ExternalActionRefSchema,
    status: z.enum(["success", "failed", "cancelled"]),
    error: z
      .object({
        code: z.string().trim().min(1).max(80),
        /** Already-redacted message (caller redacts before constructing). */
        message: z.string().trim().max(2000)
      })
      .strict()
      .optional(),
    /** Optional post-action observation snapshot. */
    observation: ObservationSchema.optional(),
    /** Retry metadata (semantics owned by workflow-engine). */
    retryRound: z.number().int().min(0).optional(),
    maxRetries: z.number().int().min(0).optional(),
    durationMs: z.number().int().min(0),
    occurredAt: z.string().datetime(),
    cancelledAt: z.string().datetime().optional(),
    timeoutAt: z.string().datetime().optional()
  })
  .strict()
  .refine((result) => result.status !== "cancelled" || Boolean(result.cancelledAt), {
    message: "cancelled result requires cancelledAt",
    path: ["cancelledAt"]
  })
  .refine((result) => result.status !== "failed" || Boolean(result.error), {
    message: "failed result requires error",
    path: ["error"]
  });
export type ActionResult = z.infer<typeof ActionResultSchema>;

// ── Phase 5.7-4: Evidence Contract (additive; zero behavior) ────────────────

/**
 * One captured state surrounding an action. Browser evidence carries a real
 * 5.7-0 Observation; external evidence carries the real external-system
 * payload (MCP result data — untrusted DATA). At least one form must be
 * present; content is redacted before it is persisted.
 */
export const EvidenceSnapshotSchema = z
  .object({
    observation: ObservationSchema.optional(),
    result: z.unknown().optional(),
    capturedAt: z.string().datetime()
  })
  .strict()
  .refine((snapshot) => snapshot.observation !== undefined || snapshot.result !== undefined, {
    message: "evidence snapshot requires observation or result",
    path: ["observation"]
  });
export type EvidenceSnapshot = z.infer<typeof EvidenceSnapshotSchema>;

/**
 * One caller-declared expectation verified against the real evidence.
 *  - action-succeeded: the action's ActionResult must be success.
 *  - contains: the AFTER snapshot must contain the value (DOM/a11y text or
 *    external result data).
 *  - changed: the AFTER snapshot content must differ from BEFORE.
 */
export const EvidenceExpectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("action-succeeded") }).strict(),
  z
    .object({
      kind: z.literal("contains"),
      value: z.string().trim().min(1).max(2000)
    })
    .strict(),
  z.object({ kind: z.literal("changed") }).strict()
]);
export type EvidenceExpectation = z.infer<typeof EvidenceExpectationSchema>;

/**
 * Binary verification verdict (VERIFIED / FAILED) plus per-expectation
 * findings — fixed vocabulary, no scores (5.6-4 spirit: structured comparison
 * against the expectation, no new scoring system). The verdict must agree
 * with the findings.
 */
export const EvidenceVerificationSchema = z
  .object({
    status: z.enum(["VERIFIED", "FAILED"]),
    findings: z
      .array(
        z
          .object({
            expectation: EvidenceExpectationSchema,
            ok: z.boolean(),
            /** Already-redacted detail (builder redacts before persist). */
            detail: z.string().max(2000)
          })
          .strict()
      )
      .min(1)
      .max(32),
    verifiedAt: z.string().datetime()
  })
  .strict()
  .refine(
    (verification) =>
      verification.status !== "VERIFIED" || verification.findings.every((finding) => finding.ok),
    {
      message: "VERIFIED requires every finding to be ok",
      path: ["status"]
    }
  )
  .refine(
    (verification) =>
      verification.status !== "FAILED" || verification.findings.some((finding) => !finding.ok),
    {
      message: "FAILED requires at least one failing finding",
      path: ["status"]
    }
  );
export type EvidenceVerification = z.infer<typeof EvidenceVerificationSchema>;

/**
 * Persisted evidence for one key action: action/target identity (5.7-0
 * actionRef — no second id system), the real before/after states, the action
 * result, the verification verdict, and the existing association ids
 * (workflow/task/agent run/tool call). Large screenshots stay behind
 * `screenshot://` artifact refs — never inline bytes.
 */
export const EvidenceRecordSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    workflowRunId: z.string().uuid().optional(),
    taskId: z.string().uuid().optional(),
    agentRunId: z.string().uuid().optional(),
    toolCallId: z.string().trim().min(1).max(160).optional(),
    actionRef: ExternalActionRefSchema,
    externalId: z.string().trim().min(1).max(300).optional(),
    before: EvidenceSnapshotSchema,
    after: EvidenceSnapshotSchema,
    result: ActionResultSchema,
    screenshotRef: z
      .string()
      .trim()
      .regex(/^screenshot:\/\//)
      .optional(),
    verification: EvidenceVerificationSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

/** Shared-contract red line: persistence assigns id/createdAt/updatedAt. */
export const EvidenceRecordDraftSchema = EvidenceRecordSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true
});
export type EvidenceRecordDraft = z.infer<typeof EvidenceRecordDraftSchema>;

// ── W13 X1 — Model & Credential Configuration (additive; zero behavior) ─────

/** 可以在运行时改的三个字段。provider 不在此列：它是部署级选择，改了要重新装配整条模型链路。 */
export type ModelConfigField = "model" | "baseUrl" | "apiKey";

/** `env` = 全部取自环境变量；`runtime` = 至少一个字段被控制台改过（重启即失效）。 */
export type ModelConfigSource = "env" | "runtime";

/**
 * 模型的当前配置。**刻意没有 apiKey 字段** —— 只有「是否已配置」这一个布尔：
 * 明文密钥不得进入 Response / Log / State（AGENTS.md §10），读回接口不该有它的位置。
 */
export interface ModelConfigStatus {
  provider: "mock" | "openai";
  model: string;
  baseUrl?: string;
  apiKeyConfigured: boolean;
  source: ModelConfigSource;
  overridden: ModelConfigField[];
}

/** `null` = 清除该字段的运行时覆盖、回落到环境变量；字段缺省 = 本次不动它。 */
export interface ModelConfigPatch {
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
}

// ── Phase 8-A — AI SRE alert / incident contracts (docs/242) ─────────────────

/** Alert severity for ingest + incident records. */
export const AlertSeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

/**
 * Incident lifecycle (8-A minimal set). Later milestones may advance status;
 * 8-A only creates `open` incidents from alerts.
 */
export const IncidentStatusSchema = z.enum([
  "open",
  "diagnosing",
  "mitigating",
  "resolved",
  "cancelled"
]);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

/**
 * Frozen alert ingest payload (docs/242 §5 #1).
 * `fingerprint` is the idempotency key within `source` while an incident is active.
 */
export const AlertIngestSchema = z
  .object({
    source: z.string().trim().min(1).max(120),
    fingerprint: z.string().trim().min(1).max(300),
    severity: AlertSeveritySchema,
    title: z.string().trim().min(1).max(300).optional(),
    summary: z.string().trim().max(4000).optional(),
    labels: z.record(z.string(), z.string()).default({}),
    raw: z.record(z.string(), z.unknown()).default({}),
    projectId: z.string().uuid().optional()
  })
  .strict();
export type AlertIngest = z.infer<typeof AlertIngestSchema>;

/** Evidence item attached to an incident diagnosis (8-B / SRE-05…06). */
export const IncidentEvidenceSourceKindSchema = z.enum([
  "metrics",
  "workflow_trace",
  "deployment",
  "workflow_summary",
  "alert",
  "log"
]);
export type IncidentEvidenceSourceKind = z.infer<typeof IncidentEvidenceSourceKindSchema>;

export const IncidentEvidenceSchema = z
  .object({
    sourceKind: IncidentEvidenceSourceKindSchema,
    /** Stable reference for humans / UI (metric name, workflow id, deployment id, …). */
    ref: z.string().trim().min(1).max(300),
    excerpt: z.string().trim().min(1).max(2000),
    collectedAt: z.string().datetime(),
    labels: z.record(z.string(), z.string()).default({})
  })
  .strict();
export type IncidentEvidence = z.infer<typeof IncidentEvidenceSchema>;

/**
 * Structured Incident Agent output (docs/13 / docs/242 SRE-05).
 * All six fields required; empty evidence[] is rejected by service rules (SRE-06).
 */
export const IncidentDiagnosisSchema = z
  .object({
    summary: z.string().trim().min(1).max(4000),
    rootCauseHypothesis: z.string().trim().min(1).max(4000),
    evidence: z.array(IncidentEvidenceSchema).min(1),
    fixPlan: z.string().trim().min(1).max(8000),
    risk: z.string().trim().min(1).max(4000),
    recommendedAction: z.string().trim().min(1).max(2000),
    /** Which synthesizer produced this (deterministic 8-B agent id). */
    agentName: z.string().trim().min(1).max(120).default("incident-agent"),
    diagnosedAt: z.string().datetime()
  })
  .strict();
export type IncidentDiagnosis = z.infer<typeof IncidentDiagnosisSchema>;

// ── Phase 8-C/8-D — controlled + optional auto remediation (docs/242 SRE-09…15) ─

/**
 * Written whitelist of fault types that may open a **staging-bound** fix workflow.
 * Frozen starter set (8-C); 8-D reuses the same table and does **not** expand it.
 * Auto-start through staging VERIFY requires both membership here **and**
 * `INCIDENT_AUTO_REMEDIATE=true` (default off). Expanding the set needs explicit approval.
 * Alerts should set `labels.faultType` (or `labels.fault_type`) to one of these values.
 */
export const INCIDENT_REMEDIATION_WHITELIST = [
  "staging_verify_flaky",
  "ci_release_missing",
  "config_drift_staging"
] as const;
export type IncidentRemediationFaultType = (typeof INCIDENT_REMEDIATION_WHITELIST)[number];
export const IncidentRemediationFaultTypeSchema = z.enum(INCIDENT_REMEDIATION_WHITELIST);

/**
 * 8-D: same written table as 8-C. Kept as an alias so call sites can name the
 * auto-remediation policy without implying a wider set.
 */
export const INCIDENT_AUTO_REMEDIATE_WHITELIST = INCIDENT_REMEDIATION_WHITELIST;
export type IncidentAutoRemediateFaultType = IncidentRemediationFaultType;

/** Audit record for a remediation attempt (whitelist open vs notify-only). */
export const IncidentRemediationDecisionSchema = z
  .object({
    decision: z.enum(["OPENED_STAGING_FIX_WORKFLOW", "NOTIFY_ONLY"]),
    faultType: z.string().trim().min(1).max(120).optional(),
    whitelisted: z.boolean(),
    reason: z.string().trim().min(1).max(2000),
    workflowRunId: z.string().uuid().optional(),
    requirementId: z.string().uuid().optional(),
    /** Whether WorkflowService.start was invoked after create. */
    started: z.boolean().optional(),
    /**
     * 8-D: true when server auto-start applied because `INCIDENT_AUTO_REMEDIATE`
     * was on (and request did not force startWorkflow=false). Audit only.
     */
    autoStarted: z.boolean().optional(),
    /** 8-D: snapshot of the server auto-remediate flag at decision time. */
    autoRemediateEnabled: z.boolean().optional(),
    decidedAt: z.string().datetime()
  })
  .strict();
export type IncidentRemediationDecision = z.infer<typeof IncidentRemediationDecisionSchema>;

/** Persisted incident (SRE-02; 8-B adds optional diagnosis). */
export const IncidentSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid().optional(),
    status: IncidentStatusSchema,
    source: z.string().trim().min(1).max(120),
    fingerprint: z.string().trim().min(1).max(300),
    severity: AlertSeveritySchema,
    title: z.string().trim().min(1).max(300),
    summary: z.string().trim().max(4000).optional(),
    labels: z.record(z.string(), z.string()),
    raw: z.record(z.string(), z.unknown()),
    linkedWorkflowRunId: z.string().uuid().optional(),
    diagnosis: IncidentDiagnosisSchema.optional(),
    diagnosedAt: z.string().datetime().optional(),
    remediation: IncidentRemediationDecisionSchema.optional(),
    remediatedAt: z.string().datetime().optional(),
    openedAt: z.string().datetime(),
    resolvedAt: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();
export type Incident = z.infer<typeof IncidentSchema>;

/** POST /api/alerts response: same incident id on replay (SRE-01). */
export const AlertIngestResultSchema = z
  .object({
    incident: IncidentSchema,
    deduplicated: z.boolean()
  })
  .strict();
export type AlertIngestResult = z.infer<typeof AlertIngestResultSchema>;

/** POST /api/incidents/:id/remediate response. */
export const IncidentRemediateResultSchema = z
  .object({
    incident: IncidentSchema,
    remediation: IncidentRemediationDecisionSchema
  })
  .strict();
export type IncidentRemediateResult = z.infer<typeof IncidentRemediateResultSchema>;
