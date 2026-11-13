import {
  AgentLifecycleHooks,
  PlanningAgent,
  PlanningAgentResult,
  PlanningGraphResult,
  PlanningLevel1Result,
  PlanningModel,
  ScriptedPlanningModel,
  describeUiReferencesForPlanning,
  hashAcceptanceText,
  isGlobalAcceptanceCriterion,
  parseAcceptanceCriteriaFromPrd
} from "@ai-se/agent-core";
import {
  PgAgentRunStore,
  PgConflictResolutionRepository,
  PgPlanningRepository,
  PgRequirementDocumentRepository,
  PgWorkflowEventStore,
  PgWorkflowRepository,
  ProjectRepository
} from "@ai-se/database";
import type { AcceptanceCriterionRecord, PgDeploymentRepository } from "@ai-se/database";
import { createLogger, sanitizeLogData } from "@ai-se/observability";
import {
  AcceptanceCriterion,
  AgentRun,
  AnalyzeRequirementData,
  AnalyzeRequirementResult,
  Approval,
  ConflictResolution,
  ConflictResolutionData,
  CreateRequirementData,
  CreateWorkflowData,
  JsonObject,
  ProvidedConflictResolution,
  ProvidedUiReference,
  Requirement,
  RequirementAnalysis,
  RequirementAcceptanceCriteriaView,
  RequirementTraceabilityView,
  RequirementPlanningResult,
  RequirementSlice,
  RequirementSlicesView,
  RequirementTasksView,
  Specification,
  Task,
  TaskDependencyView,
  evaluateSlicePlanGate,
  profileEnablesDataLayer,
  SLICE_PLAN_GATE_CRITERIA,
  WorkflowEvent,
  WorkflowPolicy,
  WorkflowRun,
  type CapabilityProfile
} from "@ai-se/shared";
import { resolveSliceWorkflowPolicy } from "@ai-se/shared";
import { randomUUID } from "node:crypto";
import { Logger } from "pino";
import { AppError } from "../http/errors";
import { CancellationStore } from "./cancellationStore";
import { buildRequirementTraceability } from "./traceability";
import { checkCrossSpecConsistency } from "./crossSpecConsistency";

const PLANNING_MAX_ITERATIONS = 8;
const PLANNING_TIMEOUT_MS = 180_000;
/** N1 决策默认值（config 可覆盖）：阶段 150s / 重试 1；第一级 300s；第二级单切片 900s。 */
const DEFAULT_STAGE_TIMEOUT_MS = 150_000;
const DEFAULT_STAGE_RETRIES = 1;
const DEFAULT_LEVEL1_TIMEOUT_MS = 300_000;
/**
 * N-51（`docs/232` §9.20 F3）：600s → 900s。近 30 天**成功**的单切片规划 run 平均 174s、最长 591s
 * （194 个样本）——旧值几乎贴着分布尾部，一次慢阶段或一次阶段重试就必然越界。
 * 900s 给阶段 150s×2 的重试留出两级余量，而不是让重试吃掉全部预算后把 run 掐死（F2）。
 */
const DEFAULT_SLICE_TIMEOUT_MS = 900_000;
/**
 * N-52（`docs/232` §9.22）：`task_planning` 单独一档。第九次回归里同一阶段**六次尝试全部卡在 150s**
 * （3 个 run × 2 次重试），而三次 run 总时长只有 424–435s——瓶颈是这一阶段的规模（要产出整片任务的
 * DAG），不是外层预算。其余阶段维持 150s，不给真卡住的阶段翻倍烧时间。
 */
const DEFAULT_TASK_PLANNING_TIMEOUT_MS = 300_000;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

/** F1-3：交付块补全可用的环境名（DeliveryEnvironment 枚举直值）。 */
const DELIVERY_ENVIRONMENT_NAMES = new Set(["dev", "staging", "production"]);

/**
 * F1-3：切片规划升级人工关口的审批 reason 契约。
 * 复用需求级审批（approvals 表 + 既有审批端点/决定回调），reason 前缀即路由契约：
 * 批准 = 仅重试该切片规划；拒绝 = 该切片置 FAILED，已完成切片零影响。
 */
const PLANNING_ESCALATION_PREFIX = "[planning-escalation:";

/**
 * F1-3 增补（L3 前置修复）：同切片升级轮数上限——达上限后按终态失败处理，不再建审批。
 * 防止「确定性失败 + 自动批准」（如评测 harness 自动批准一切 PENDING）形成无限重试循环。
 */
const MAX_SLICE_PLANNING_ESCALATION_RETRIES = 2;

export function planningEscalationReason(
  sliceKey: string,
  errorCode = "VALIDATION_ERROR",
  detail?: string
): string {
  const base = `${PLANNING_ESCALATION_PREFIX}${sliceKey}] Slice planning failed (${errorCode}); approve to retry planning for this slice only`;
  if (!detail || detail.trim() === "") {
    return base.slice(0, 500);
  }
  const clipped = detail.replace(/\s+/g, " ").trim();
  const room = Math.max(0, 500 - base.length - 10);
  return (room > 0 ? `${base}. Detail: ${clipped.slice(0, room)}` : base).slice(0, 500);
}

/**
 * N-51（`docs/232` §9.20 F1）：哪些规划失败值得**升级人工关口并重试该切片**。
 *
 * 旧口径只认 `VALIDATION_ERROR`——而校验失败恰恰是最不瞬态的一类（同样的输入多半再失败一次），
 * 超时才是瞬态的。第八次回归里 slice-1/2/3 已经做完，第四片规划超时就把整轮夹具掐了、前三片白跑；
 * 普查近 30 天 15 条终态规划失败（TIMEOUT 9 / 阶段超时 2 / JSON 解析 3 / 其它 1），**没有一条**
 * 走到过升级路径。
 *
 * N-69（`docs/232` §10）：**模型输出解析失败也走这条路**。旧注释的假设「一个阶段内重采样 3 次就够」
 * 在第九次回归里被证否：slice-2 的 3 次采样全部吐坏 JSON（`{"requirements:[{"`），切片直接终态失败、
 * 整轮掐死。解析失败是**采样级**的偶发（同一提示词换一次运行就可能成功），因此与超时同类；
 * 但 `PLANNING_ERROR` 还包含非解析类失败（如 provider 报错），所以按消息再收窄一层——
 * 只有解析形态的 `PLANNING_ERROR` 才放开，其余保持终态。上限仍由
 * `MAX_SLICE_PLANNING_ESCALATION_RETRIES` 兜住，不会形成无限重试。
 */
const PLANNING_PARSE_FAILURE_PATTERN = /OUTPUT_PARSING_FAILURE|Failed to parse/i;

export function isEscalatablePlanningFailure(errorCode: string, message = ""): boolean {
  if (errorCode === "VALIDATION_ERROR" || errorCode === "TIMEOUT_ERROR") {
    return true;
  }
  return errorCode === "PLANNING_ERROR" && PLANNING_PARSE_FAILURE_PATTERN.test(message);
}

function clipPlanningErrorMessage(message: string | undefined, max = 500): string | undefined {
  if (!message) return undefined;
  const clipped = message.replace(/\s+/g, " ").trim();
  if (clipped.length === 0) return undefined;
  return clipped.length <= max ? clipped : `${clipped.slice(0, max - 1)}…`;
}

export function parsePlanningEscalationReason(reason: string): { sliceKey: string } | null {
  if (!reason.startsWith(PLANNING_ESCALATION_PREFIX)) {
    return null;
  }
  const end = reason.indexOf("]", PLANNING_ESCALATION_PREFIX.length);
  if (end === -1) {
    return null;
  }
  const sliceKey = reason.slice(PLANNING_ESCALATION_PREFIX.length, end).trim();
  return sliceKey === "" ? null : { sliceKey };
}

/**
 * F1-4（FX-15b）：最终切片拆分的关口 1 审批 reason 契约（与 F1-3 同一前缀路由模式）。
 * reason: `[planning-split:<sliceKey>|<deploySliceKey>] …`——
 * 批准 = 按拆分继续（规划「工程契约」段）；拒绝 = 两段置 FAILED（人工否定拆分）。
 */
const PLANNING_SPLIT_PREFIX = "[planning-split:";

export function planningSplitReason(sliceKey: string, deploySliceKey: string): string {
  return `${PLANNING_SPLIT_PREFIX}${sliceKey}|${deploySliceKey}] Final slice plan exceeded the task limit after LLM compression; approve to split it into engineering-contract + deployment-verification slices`;
}

export function parsePlanningSplitReason(
  reason: string
): { sliceKey: string; deploySliceKey: string } | null {
  if (!reason.startsWith(PLANNING_SPLIT_PREFIX)) {
    return null;
  }
  const end = reason.indexOf("]", PLANNING_SPLIT_PREFIX.length);
  if (end === -1) {
    return null;
  }
  const [sliceKey, deploySliceKey] = reason
    .slice(PLANNING_SPLIT_PREFIX.length, end)
    .split("|")
    .map((part) => part.trim());
  return sliceKey && deploySliceKey ? { sliceKey, deploySliceKey } : null;
}

/** N2 规划预算（阶段级 + 级别总预算；与 docs/115 §N1 决策一致）。 */
export interface PlanningBudgets {
  stageTimeoutMs: number;
  stageRetries: number;
  level1TimeoutMs: number;
  sliceTimeoutMs: number;
  /** N-52：`task_planning` 单独一档（缺省 = `DEFAULT_TASK_PLANNING_TIMEOUT_MS`）。 */
  taskPlanningTimeoutMs: number;
}

interface ActivePlanningRun {
  controller: AbortController;
  promise: Promise<void>;
}

export interface PlanningServiceDependencies {
  planning: PgPlanningRepository;
  /** D1（`docs/229`）+ UI 参照：技术文档与 UI 参照图进入规划。 */
  documents?: Pick<
    PgRequirementDocumentRepository,
    "findContentsByRequirementId" | "findUiReferencesByRequirementId"
  >;
  /** 人工冲突裁决：落库 + 规划回灌。 */
  conflictResolutions?: Pick<PgConflictResolutionRepository, "findByRequirementId" | "upsertMany">;
  agentRuns: Pick<PgAgentRunStore, "create" | "findMany" | "findById" | "update">;
  workflowEvents: Pick<PgWorkflowEventStore, "create" | "findByAgentRunId">;
  projects: ProjectRepository;
  cancellationStore: CancellationStore;
  notifyRunChanged?: (agentRunId: string) => void;
  model?: PlanningModel;
  logger?: Logger;
  /** N2：规划模式（缺省 two-level，与 config 默认一致）。 */
  mode?: "single" | "two-level";
  /** N2：阶段/级别预算（缺省用 N1 决策默认值）。 */
  budgets?: Partial<PlanningBudgets>;
  /** N2 关口 1：需求级审批（approvals 同表方法）。 */
  approvals?: Pick<
    PgWorkflowRepository,
    | "createRequirementApproval"
    | "findPendingApprovalByRequirement"
    | "countRejectedApprovalsByRequirement"
    | "countApprovalsByRequirement"
    /** 自治 L2：自动批准复用同一个 CAS 决策方法（**不新增第二套审批**）。 */
    | "decideApproval"
  >;
  /** N2 切片编排：读取前序工作流（workspacePath / policy）。 */
  workflows?: Pick<PgWorkflowRepository, "findWorkflowById">;
  /** N2 切片编排：创建并启动下一片工作流（复用 WorkflowService.create/start；不新建调度器）。 */
  startSliceWorkflow?: (input: CreateWorkflowData) => Promise<WorkflowRun>;
  /** F1-3：交付块补全的环境来源（deployment_environments；缺省 = 不补块）。 */
  deployments?: Pick<PgDeploymentRepository, "findEnvironments">;
  /**
   * F1-4（FX-15c）：最终切片任务数上限（enforce 开关；缺省 = observe 只记录不判失败）。
   * 由装配层按 `PLANNING_FINAL_SLICE_MAX_TASKS` 传入；校准值不低于 18（L2 实测后写入 docs/129）。
   */
  finalSliceMaxTasks?: number;
  /**
   * `docs/235` §6.5：本进程的能力 profile（组合根注入一次）。
   * 它决定任务规划阶段的可规划类型，并写进新任务的 `input.profile` 供读数归因。
   */
  capabilityProfile?: CapabilityProfile;
}

function sanitizeObject(value: JsonObject): JsonObject {
  const sanitized = sanitizeLogData(value);
  return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)
    ? (sanitized as JsonObject)
    : {};
}

function terminal(status: AgentRun["status"]): boolean {
  return TERMINAL_STATUSES.has(status);
}

function planningVersion(latestVersion: number): number {
  return latestVersion === 0 ? 1 : latestVersion + 1;
}

/** F1-1：N3 库记录 → 规划图可消费的 AC 集合（编号 PRD 解析为空时的兜底来源）。 */
function acceptanceCriteriaFromRecords(
  records: AcceptanceCriterionRecord[]
): AcceptanceCriterion[] {
  return records.map((record) => ({
    acKey: record.acKey,
    text: record.text,
    priority: record.priority,
    verification: record.verification,
    smoke: record.smoke,
    frKeys: record.frKeys
  }));
}

function specificationsFrom(result: PlanningGraphResult) {
  return [
    { type: "FUNCTIONAL" as const, content: result.functionalSpec },
    { type: "TECHNICAL" as const, content: result.technicalSpec },
    { type: "ARCHITECTURE" as const, content: result.architectureSpec },
    { type: "API" as const, content: result.apiSpec },
    ...(result.databaseSpec ? [{ type: "DATABASE" as const, content: result.databaseSpec }] : []),
    ...(result.uiSpec ? [{ type: "UI" as const, content: result.uiSpec }] : [])
  ];
}

export class PlanningService {
  private readonly activeRuns = new Map<string, ActivePlanningRun>();
  private readonly logger: Logger;
  private readonly model: PlanningModel;
  private readonly mode: "single" | "two-level";
  private readonly budgets: PlanningBudgets;
  private readonly finalSliceMaxTasks?: number;

  /**
   * `docs/235` §7：写进新任务 `input.profile` 的口径标签（`id@version`）。
   * 未配置 profile ⇒ undefined ⇒ 不落键（历史行为、历史行都不受影响）。
   */
  private get profileTag(): string | undefined {
    const profile = this.dependencies.capabilityProfile;
    return profile ? `${profile.id}@${profile.version}` : undefined;
  }

  constructor(private readonly dependencies: PlanningServiceDependencies) {
    this.logger = dependencies.logger ?? createLogger();
    this.model = dependencies.model ?? new ScriptedPlanningModel();
    this.mode = dependencies.mode ?? "two-level";
    this.finalSliceMaxTasks = dependencies.finalSliceMaxTasks;
    this.budgets = {
      stageTimeoutMs: dependencies.budgets?.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS,
      stageRetries: dependencies.budgets?.stageRetries ?? DEFAULT_STAGE_RETRIES,
      level1TimeoutMs: dependencies.budgets?.level1TimeoutMs ?? DEFAULT_LEVEL1_TIMEOUT_MS,
      sliceTimeoutMs: dependencies.budgets?.sliceTimeoutMs ?? DEFAULT_SLICE_TIMEOUT_MS,
      taskPlanningTimeoutMs:
        dependencies.budgets?.taskPlanningTimeoutMs ?? DEFAULT_TASK_PLANNING_TIMEOUT_MS
    };
  }

  async createRequirement(projectId: string, input: CreateRequirementData): Promise<Requirement> {
    const project = await this.dependencies.projects.findById(projectId);
    if (!project) {
      throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
    }

    return await this.dependencies.planning.createRequirement(projectId, input);
  }

  async listRequirements(projectId: string): Promise<Requirement[]> {
    const project = await this.dependencies.projects.findById(projectId);
    if (!project) {
      throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
    }

    return await this.dependencies.planning.findRequirementsByProjectId(projectId);
  }

  async getRequirement(id: string): Promise<Requirement | null> {
    return await this.dependencies.planning.findRequirementById(id);
  }

  async getRequirementPlanningResult(id: string): Promise<RequirementPlanningResult | null> {
    const requirement = await this.getRequirement(id);
    if (!requirement) {
      return null;
    }

    const tasks = await this.dependencies.planning.findTasksByRequirementId(id);
    return {
      requirement,
      specifications: await this.dependencies.planning.findSpecificationsByRequirementId(id),
      tasks,
      dependencies: await this.dependencies.planning.findDependenciesByRequirementId(id)
    };
  }

  async getSpecifications(requirementId: string): Promise<Specification[] | null> {
    const requirement = await this.getRequirement(requirementId);
    if (!requirement) {
      return null;
    }

    return await this.dependencies.planning.findSpecificationsByRequirementId(requirementId);
  }

  async getRequirementTasks(requirementId: string): Promise<RequirementTasksView | null> {
    const requirement = await this.getRequirement(requirementId);
    if (!requirement) {
      return null;
    }

    return {
      tasks: await this.dependencies.planning.findTasksByRequirementId(requirementId),
      dependencies: await this.dependencies.planning.findDependenciesByRequirementId(requirementId)
    };
  }

  async getTask(id: string): Promise<Task | null> {
    return await this.dependencies.planning.findTaskById(id);
  }

  async getTaskDependencies(id: string): Promise<TaskDependencyView[] | null> {
    const task = await this.getTask(id);
    if (!task) {
      return null;
    }

    return await this.dependencies.planning.findTaskDependencies(id);
  }

  async analyzeRequirement(
    requirementId: string,
    input: AnalyzeRequirementData,
    requestId: string
  ): Promise<AnalyzeRequirementResult> {
    const requirement = await this.getRequirement(requirementId);
    if (!requirement) {
      throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
    }

    if (requirement.status === "ANALYZING") {
      throw new AppError(409, "REQUIREMENT_ANALYZING", "Requirement is already being analyzed");
    }

    const latestVersion = await this.dependencies.planning.latestPlanningVersion(requirement.id);
    if (requirement.status === "ANALYZED" && !input.regenerate) {
      return {
        requirementId: requirement.id,
        status: "ANALYZED",
        version: latestVersion || requirement.version,
        accepted: false
      };
    }

    const version = planningVersion(latestVersion);
    await this.dependencies.planning.updateRequirementStatus(requirement.id, "ANALYZING");
    const run = await this.dependencies.agentRuns.create({
      projectId: requirement.projectId,
      taskId: randomUUID(),
      input: sanitizeObject({
        runtime: "planning-agent",
        requirementId: requirement.id,
        requirementVersion: requirement.version,
        planningVersion: version,
        title: requirement.title
      }),
      maxIterations: PLANNING_MAX_ITERATIONS
    });

    await this.recordEvent(run.id, "agent_run_created", {
      runtime: "planning-agent",
      projectId: requirement.projectId,
      requirementId: requirement.id,
      planningVersion: version
    });
    this.startBackgroundRun(requirement, run, version, requestId);

    return {
      requirementId: requirement.id,
      agentRunId: run.id,
      status: "ANALYZING",
      version,
      accepted: true
    };
  }

  async waitForPlanningRun(
    agentRunId: string,
    timeoutMs: number
  ): Promise<RequirementPlanningResult | null> {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const run = await this.dependencies.agentRuns.findById(agentRunId);
      if (run && terminal(run.status)) {
        const requirementId = run.input.requirementId;
        return typeof requirementId === "string"
          ? await this.getRequirementPlanningResult(requirementId)
          : null;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return null;
  }

  async recoverInterruptedRequirements(): Promise<number> {
    const requirements = await this.dependencies.planning.findRequirementsByStatus("ANALYZING");
    const runs = await this.dependencies.agentRuns.findMany();

    for (const requirement of requirements) {
      await this.dependencies.planning.updateRequirementStatus(requirement.id, "FAILED");
      const slices = await this.dependencies.planning.findSlicesByRequirementId(requirement.id);
      for (const slice of slices) {
        if (slice.status === "PLANNING") {
          await this.dependencies.planning.updateSliceStatus(slice.id, "FAILED");
        }
      }
      const run = runs.find((entry) => {
        return (
          entry.input.runtime === "planning-agent" && entry.input.requirementId === requirement.id
        );
      });

      if (run) {
        await this.recordEvent(run.id, "REQUIREMENT_ANALYSIS_RECOVERED", {
          requirementId: requirement.id,
          previousStatus: "ANALYZING",
          status: "FAILED"
        });
      }
    }

    return requirements.length;
  }

  private startBackgroundRun(
    requirement: Requirement,
    run: AgentRun,
    version: number,
    requestId: string
  ): void {
    const controller = new AbortController();
    const promise = this.executeRun(requirement, run, version, requestId, controller).catch(
      (error: unknown) => {
        this.logger.error(
          sanitizeLogData({ agentRunId: run.id, requirementId: requirement.id, error }),
          "planning run background execution failed"
        );
      }
    );

    this.activeRuns.set(run.id, { controller, promise });
  }

  private async executeRun(
    requirement: Requirement,
    run: AgentRun,
    version: number,
    requestId: string,
    controller: AbortController
  ): Promise<void> {
    const logger = this.logger.child({
      requestId,
      agentRunId: run.id,
      projectId: requirement.projectId,
      requirementId: requirement.id
    });
    const cancellationMonitor = setInterval(() => {
      this.dependencies.cancellationStore
        .isCancellationRequested(run.id)
        .then((cancelled) => {
          if (cancelled) {
            controller.abort();
          }
        })
        .catch((error: unknown) => {
          logger.warn(sanitizeLogData({ error }), "failed to check planning cancellation flag");
        });
    }, 500);

    try {
      // 未绑定 Git 仓库的项目不具备交付能力：规划期不得生成 CI/部署任务
      //（否则运行期 DeploymentOrchestrator 必然 REPOSITORY_NOT_CONFIGURED 失败）。
      const project = await this.dependencies.projects.findById(requirement.projectId);
      const context = {
        requestId,
        projectId: requirement.projectId,
        requirementId: requirement.id,
        taskId: run.taskId,
        agentRunId: run.id
      };
      const deliveryConfigured = await this.isDeliveryConfigured(project);
      // D1：技术文档与 rawContent **并列**进入规划（绝不合并——rawContent 只喂 AC 解析器）。
      // UI 参照图同理并列；先 vision describe 成 note，OpenCode 路径不再把原件多模态塞进规划。
      const providedTechnicalDocs = this.dependencies.documents
        ? (await this.dependencies.documents.findContentsByRequirementId(requirement.id)).map(
            (entry) => ({
              fileName: entry.fileName,
              text: entry.text,
              truncated: entry.truncated
            })
          )
        : [];
      const providedUiReferences = await this.prepareUiReferencesForPlanning(
        requirement.id,
        run.id
      );
      const conflictResolutions = await this.loadConflictResolutions(requirement.id);

      if (this.mode === "two-level") {
        // N2 第一级：requirement_analysis + slice_planning → 切片计划 + 关口 1。
        const agent = new PlanningAgent({
          model: this.model,
          pipeline: "level1",
          ...(this.dependencies.capabilityProfile
            ? { profile: this.dependencies.capabilityProfile }
            : {}),
          defaultTimeoutMs: this.budgets.level1TimeoutMs,
          stageTimeoutMs: this.budgets.stageTimeoutMs,
          stageRetries: this.budgets.stageRetries,
          lifecycle: this.createLifecycleHooks(),
          afterSlicePlan: async (level1) => {
            await this.persistSlicePlan(requirement, run, level1);
          }
        });
        const result = await agent.run(requirement, context, {
          timeoutMs: this.budgets.level1TimeoutMs,
          signal: controller.signal,
          deliveryConfigured,
          providedTechnicalDocs,
          providedUiReferences,
          conflictResolutions
        });
        await this.finishRequirementFromResult(requirement.id, result);
        return;
      }

      const acceptanceCriteria = acceptanceCriteriaFromRecords(
        await this.dependencies.planning.findAcceptanceCriteriaByRequirementId(requirement.id)
      );
      const agent = new PlanningAgent({
        model: this.model,
        acceptanceCriteria,
        ...(this.dependencies.capabilityProfile
          ? { profile: this.dependencies.capabilityProfile }
          : {}),
        defaultTimeoutMs: PLANNING_TIMEOUT_MS,
        // single 旧路径：不启用阶段级预算（总 180s 语义保持，N1 决策）。
        stageTimeoutMs: PLANNING_TIMEOUT_MS,
        stageRetries: 0,
        lifecycle: this.createLifecycleHooks(),
        afterGraph: async (graphResult) => {
          const saved = await this.dependencies.planning.savePlanningResult({
            projectId: requirement.projectId,
            requirementId: requirement.id,
            requirementVersion: requirement.version,
            version,
            analysis: graphResult.requirementAnalysis,
            specifications: specificationsFrom(graphResult),
            taskPlan: graphResult.taskPlan,
            ...(this.profileTag ? { profile: this.profileTag } : {})
          });
          await this.recordEvent(run.id, "PLANNING_PERSISTED", {
            requirementId: requirement.id,
            specificationCount: saved.specifications.length,
            taskCount: saved.tasks.length,
            dependencyCount: saved.dependencies.length,
            version
          });
          await this.recordCrossSpecConsistency(run.id, graphResult);
          await this.recordTechnicalConflicts(run.id, graphResult.requirementAnalysis);
          await this.ensureAcceptanceCriteria(requirement, run.id);
        }
      });
      const result = await agent.run(requirement, context, {
        timeoutMs: PLANNING_TIMEOUT_MS,
        signal: controller.signal,
        deliveryConfigured,
        providedTechnicalDocs,
        providedUiReferences,
        conflictResolutions
      });

      await this.finishRequirementFromResult(requirement.id, result);
    } finally {
      clearInterval(cancellationMonitor);
      this.activeRuns.delete(run.id);
      await this.dependencies.cancellationStore.clear(run.id);
    }
  }

  private createLifecycleHooks(): AgentLifecycleHooks {
    return {
      onRunStarted: async (record) => {
        await this.dependencies.agentRuns.update(record.agentRunId, {
          status: "running",
          startedAt: record.startedAt,
          currentIteration: 0
        });
      },
      onIteration: async (record) => {
        await this.dependencies.agentRuns.update(record.agentRunId, {
          status: record.status,
          currentIteration: record.iteration
        });
      },
      onRunFinished: async (record) => {
        await this.dependencies.agentRuns.update(record.agentRunId, {
          status: record.status,
          output: sanitizeObject(record.output),
          currentIteration: record.currentIteration,
          retryCount: record.retryCount,
          error: record.error,
          tokenUsage: record.tokenUsage,
          estimatedCost: record.estimatedCost,
          finishedAt: record.finishedAt
        });
      },
      onEvent: async (record) => {
        await this.recordEvent(record.agentRunId, record.eventType, record.payload);
      }
    };
  }

  /**
   * N-73（`docs/232` §10）：**交付能力不再只由 Git 仓库决定。**
   *
   * 项目绑定了仓库 ⇒ 走既有的 docker 交付链（E1）；没有仓库、但声明了 `static` 部署环境
   * ⇒ 走 `docs/233` §5.4 的工作区优先前端链（CI → staging DEPLOY → staging VERIFY）。
   * 两者都没有 ⇒ 维持旧行为：规划期不排任何交付任务。
   */
  private async isDeliveryConfigured(
    project: {
      id: string;
      repository?: string | null;
    } | null
  ): Promise<boolean> {
    if (!project) return false;
    if (project.repository) return true;
    const environments = (await this.dependencies.deployments?.findEnvironments(project.id)) ?? [];
    return environments.some((entry) => entry.adapter === "static");
  }

  private async finishRequirementFromResult(
    requirementId: string,
    result: PlanningAgentResult
  ): Promise<void> {
    if (result.status === "succeeded") {
      return;
    }

    await this.dependencies.planning.updateRequirementStatus(requirementId, "FAILED");
    await this.recordEvent(result.agentRunId, "REQUIREMENT_ANALYSIS_FAILED", {
      requirementId,
      errorCode: result.error?.code ?? "PLANNING_ERROR",
      errorMessage: clipPlanningErrorMessage(result.error?.message)
    });
  }

  /** N2 第一级产物落盘：切片计划 + 需求置 PLANNING_REVIEW + 关口 1 审批（PENDING）。 */

  /**
   * UI 参照：先走 vision describe（OpenAI-compatible），把布局/组件/风格写成 note，
   * OpenCode/atlas 路径再去掉 base64，避免规划阶段把 image_url 打进不支持多模态的网关。
   * describe 失败会记 warning 事件，但规划仍以文件名 note 尽力继续。
   */
  private async prepareUiReferencesForPlanning(
    requirementId: string,
    agentRunId?: string
  ): Promise<ProvidedUiReference[]> {
    if (!this.dependencies.documents?.findUiReferencesByRequirementId) {
      return [];
    }
    const rows = await this.dependencies.documents.findUiReferencesByRequirementId(requirementId);
    const raw: ProvidedUiReference[] = rows.map((entry) => ({
      fileName: entry.fileName,
      mimeType: entry.mimeType,
      note: entry.note,
      base64: entry.rawBytes.toString("base64")
    }));
    if (raw.length === 0) {
      return [];
    }

    const described = await describeUiReferencesForPlanning(raw, {
      sessionId: "ai-se-planning-vision"
    });
    if (described.warnings.length > 0) {
      this.logger.warn(
        sanitizeLogData({
          requirementId,
          warnings: described.warnings,
          describedCount: described.describedCount,
          textOnly: described.textOnly
        }),
        "UI reference vision describe completed with warnings"
      );
    } else {
      this.logger.info(
        sanitizeLogData({
          requirementId,
          describedCount: described.describedCount,
          textOnly: described.textOnly,
          count: described.references.length
        }),
        "UI reference vision describe ready for planning"
      );
    }
    if (agentRunId) {
      await this.recordEvent(agentRunId, "UI_REFERENCE_DESCRIBED", {
        requirementId,
        count: described.references.length,
        describedCount: described.describedCount,
        textOnly: described.textOnly,
        warnings: described.warnings.slice(0, 5)
      });
    }
    return described.references;
  }

  /** 把已落库裁决投影成规划 input（无 id）。 */
  private async loadConflictResolutions(
    requirementId: string
  ): Promise<ProvidedConflictResolution[]> {
    if (!this.dependencies.conflictResolutions) return [];
    const rows = await this.dependencies.conflictResolutions.findByRequirementId(requirementId);
    return rows.map((row) => ({
      topic: row.topic,
      source: row.source,
      prdSays: row.prdSays,
      documentSays: row.documentSays,
      choice: row.choice,
      ...(row.note ? { note: row.note } : {})
    }));
  }

  async listConflictResolutions(requirementId: string): Promise<ConflictResolution[]> {
    const requirement = await this.getRequirement(requirementId);
    if (!requirement) {
      throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
    }
    if (!this.dependencies.conflictResolutions) {
      return [];
    }
    return this.dependencies.conflictResolutions.findByRequirementId(requirementId);
  }

  async upsertConflictResolutions(
    requirementId: string,
    resolutions: ConflictResolutionData[]
  ): Promise<ConflictResolution[]> {
    const requirement = await this.getRequirement(requirementId);
    if (!requirement) {
      throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
    }
    if (!this.dependencies.conflictResolutions) {
      throw new AppError(
        501,
        "CONFLICT_RESOLUTIONS_UNAVAILABLE",
        "Conflict resolution storage is not configured"
      );
    }
    const saved = await this.dependencies.conflictResolutions.upsertMany(
      requirementId,
      resolutions
    );
    // 挂到该需求最近一次规划 run（若有），便于控制台时间线看见「已裁决」。
    // findMany 按 created_at DESC → 首个匹配即最近一次。
    const runs = await this.dependencies.agentRuns.findMany();
    const latestRun = runs.find(
      (run) => run.input.runtime === "planning-agent" && run.input.requirementId === requirementId
    );
    if (latestRun) {
      await this.recordEvent(latestRun.id, "TECHNICAL_DOCUMENT_CONFLICTS_RESOLVED", {
        requirementId,
        resolutionCount: resolutions.length,
        resolutions: resolutions.map((item) => ({
          topic: item.topic,
          source: item.source,
          choice: item.choice
        }))
      });
    }
    return saved;
  }

  /**
   * D1-6（`docs/229`）：技术文档与 PRD 的冲突必须**可被看见**，否则「权威输入」只是一句话。
   * 规划不因此失败（一个措辞差异不该卡住整条链），但冲突项进事件流、并在需求详情页展示。
   */
  private async recordTechnicalConflicts(
    agentRunId: string,
    analysis: RequirementAnalysis
  ): Promise<void> {
    const conflicts = analysis.technicalDocumentConflicts ?? [];
    if (conflicts.length === 0) return;
    await this.recordEvent(agentRunId, "TECHNICAL_DOCUMENT_CONFLICTS", {
      conflictCount: conflicts.length,
      conflicts
    });
  }

  private async persistSlicePlan(
    requirement: Requirement,
    run: AgentRun,
    level1: PlanningLevel1Result
  ): Promise<void> {
    await this.recordTechnicalConflicts(run.id, level1.requirementAnalysis);
    // 第一级产物：requirement_analysis 先行落盘（第二级种子 + 控制台可见），独立版本占位。
    const latestVersion = await this.dependencies.planning.latestPlanningVersion(requirement.id);
    await this.dependencies.planning.saveAnalysisSpecification({
      projectId: requirement.projectId,
      requirementId: requirement.id,
      requirementVersion: requirement.version,
      version: planningVersion(latestVersion),
      analysis: level1.requirementAnalysis
    });
    await this.dependencies.planning.replaceSlicePlan({
      projectId: requirement.projectId,
      requirementId: requirement.id,
      plan: level1.slicePlan
    });
    await this.ensureAcceptanceCriteria(requirement, run.id);
    // F1-4（FX-15a）：L1 同步预检——按 FR 数 + 全局性 AC 数预估最终切片规模（只记录、不判失败）。
    const records = await this.dependencies.planning.findAcceptanceCriteriaByRequirementId(
      requirement.id
    );
    const finalSlice = [...level1.slicePlan.slices].sort((a, b) => a.order - b.order).at(-1);
    const frCount = finalSlice?.frKeys.length ?? 0;
    const globalAcCount = records.filter((record) => isGlobalAcceptanceCriterion(record)).length;
    await this.recordEvent(run.id, "FINAL_SLICE_SCALE_PREVIEW", {
      requirementId: requirement.id,
      sliceKey: finalSlice?.id ?? null,
      frCount,
      globalAcCount,
      estimatedTaskCount: frCount + globalAcCount
    });
    await this.dependencies.planning.updateRequirementStatus(requirement.id, "PLANNING_REVIEW");
    const approval = await this.dependencies.approvals?.createRequirementApproval(
      requirement.id,
      "Slice plan requires human confirmation (gate 1)"
    );
    await this.recordEvent(run.id, "SLICE_PLAN_READY", {
      requirementId: requirement.id,
      sliceCount: level1.slicePlan.slices.length,
      milestoneCount: level1.slicePlan.milestones.length,
      version: requirement.version
    });
    await this.recordEvent(run.id, "approval_requested", {
      requirementId: requirement.id,
      approvalId: approval?.id ?? null,
      reason: "gate-1 slice plan review"
    });
    // 自治 L2（`docs/227`）：判据全满足则走既有批准路径自动放行；否则保持 PENDING 等人工。
    await this.maybeAutoApproveGate1(requirement, run, level1, approval, frCount + globalAcCount);
  }

  /**
   * 自治 L2：关口 1 的判决据化（`docs/227` §2 判据 B）。
   *
   * - 需求未声明 `autonomyLevel: "L2"` ⇒ **什么都不做**（现状：等人工，零行为变化）。
   * - 判据未全满足 ⇒ 保持 PENDING，并把未命中的判据名留给人工参考。
   * - 判据全满足 ⇒ 用**同一个** `decideApproval`（CAS：`WHERE status='PENDING'`）批准，
   *   写 `GATE1_AUTO_APPROVED` 决策事件，再走**既有** `handleSliceApprovalDecided` 续跑。
   *
   * 不新增第二套审批：批准走既有 `approvals` 表与既有续跑钩子；
   * 并发下`decideApproval` 返回 null（已被人决策）时直接让位，不重复推进。
   */
  private async maybeAutoApproveGate1(
    requirement: Requirement,
    run: AgentRun,
    level1: PlanningLevel1Result,
    approval: Approval | undefined,
    estimatedFinalSliceTasks: number
  ): Promise<void> {
    if (requirement.autonomyLevel !== "L2" || !approval) {
      return;
    }
    const gate = evaluateSlicePlanGate({
      plan: level1.slicePlan,
      functionalRequirementKeys: (level1.requirementAnalysis.functionalRequirements ?? []).map(
        (entry) => entry.id
      ),
      estimatedFinalSliceTasks,
      maxFinalSliceTasks: this.dependencies.finalSliceMaxTasks
    });
    if (!gate.satisfied) {
      await this.recordEvent(run.id, "GATE1_GATE_CHECKED", {
        requirementId: requirement.id,
        approvalId: approval.id,
        satisfied: false,
        unmet: gate.unmet
      });
      return;
    }
    const decided = await this.dependencies.approvals?.decideApproval(
      approval.id,
      "APPROVED",
      "gate-1 auto-approved by autonomy L2 (all deterministic criteria satisfied)"
    );
    if (!decided) {
      return;
    }
    await this.recordEvent(run.id, "GATE1_AUTO_APPROVED", {
      policyId: "L2",
      reason: "slice plan satisfied all deterministic gate-1 criteria",
      requirementId: requirement.id,
      approvalId: decided.id,
      sliceCount: level1.slicePlan.slices.length,
      satisfiedReasons: [...SLICE_PLAN_GATE_CRITERIA],
      estimatedFinalSliceTasks
    });
    await this.handleSliceApprovalDecided(decided);
  }

  /** N2：需求页切片视图（切片列表 + 待确认的关口 1 审批）。 */
  async getRequirementSlices(id: string): Promise<RequirementSlicesView | null> {
    const requirement = await this.getRequirement(id);
    if (!requirement) {
      return null;
    }
    const slices = await this.dependencies.planning.findSlicesByRequirementId(id);
    const approval = this.dependencies.approvals
      ? await this.dependencies.approvals.findPendingApprovalByRequirement(id)
      : null;
    return { slices, approval };
  }

  /** N3：需求页 AC 视图（一等记录 + 按最新计划 tasks.input.acKeys 汇总的任务映射数）。 */
  async getRequirementAcceptanceCriteria(
    id: string
  ): Promise<RequirementAcceptanceCriteriaView | null> {
    const requirement = await this.getRequirement(id);
    if (!requirement) {
      return null;
    }

    const [records, counts] = await Promise.all([
      this.dependencies.planning.findAcceptanceCriteriaByRequirementId(id),
      this.dependencies.planning.acceptanceCriteriaMappingCounts(id)
    ]);

    return {
      criteria: records.map((record) => ({
        acKey: record.acKey,
        text: record.text,
        priority: record.priority,
        verification: record.verification,
        smoke: record.smoke,
        frKeys: record.frKeys,
        mappingCount: counts.get(record.acKey) ?? 0
      }))
    };
  }

  /** C-5（N5）：追溯表（确定性生成，零 LLM）：FR → AC → 测试 → 执行结果 → 证据。 */
  async getRequirementTraceability(id: string): Promise<RequirementTraceabilityView | null> {
    const requirement = await this.getRequirement(id);
    if (!requirement) {
      return null;
    }

    const [records, runtimeTasks] = await Promise.all([
      this.dependencies.planning.findAcceptanceCriteriaByRequirementId(id),
      this.dependencies.planning.findRuntimeTasksByRequirementId(id)
    ]);

    return buildRequirementTraceability({
      requirementId: id,
      criteria: records.map((record) => ({
        acKey: record.acKey,
        text: record.text,
        priority: record.priority,
        verification: record.verification,
        smoke: record.smoke,
        frKeys: record.frKeys
      })),
      runtimeTasks
    });
  }

  /**
   * N2 关口 1：需求级审批已决（workflowService 落 decision 后回调）。
   * 接受 → 后台规划第一个切片；拒绝 → 重做第一级（上限 2 次，第 3 次拒绝置 FAILED）。
   */
  async handleSliceApprovalDecided(approval: Approval): Promise<void> {
    const requirementId = approval.requirementId;
    if (!requirementId) {
      return;
    }

    // F1-3：切片规划升级人工关口的决定（reason 前缀路由；与关口 1 审批并存于同一决定回调）。
    const escalation = parsePlanningEscalationReason(approval.reason);
    if (escalation) {
      if (approval.status === "APPROVED") {
        await this.recordApprovalEvent(
          requirementId,
          "SLICE_PLANNING_RETRY_APPROVED",
          approval.id,
          {
            sliceKey: escalation.sliceKey
          }
        );
        // 仅重试该切片规划（切片已复位 PENDING）；规划成功后 maybeAutoStartAfterPlan 会启动工作流。
        void this.planSlice(requirementId, escalation.sliceKey).catch((error: unknown) => {
          this.logger.error(
            sanitizeLogData({ requirementId, sliceKey: escalation.sliceKey, error }),
            "slice planning retry after escalation approval failed"
          );
        });
      } else {
        const slice = await this.dependencies.planning.findSliceByKey(
          requirementId,
          escalation.sliceKey
        );
        if (slice) {
          await this.dependencies.planning.updateSliceStatus(slice.id, "FAILED");
        }
        await this.dependencies.planning.updateRequirementStatus(requirementId, "ANALYZED");
        await this.recordApprovalEvent(
          requirementId,
          "SLICE_PLANNING_RETRY_REJECTED",
          approval.id,
          {
            sliceKey: escalation.sliceKey,
            comment: approval.comment
          }
        );
      }
      return;
    }

    // F1-4（FX-15b）：最终切片拆分的关口 1 审批（reason 前缀路由；与 F1-3 升级审批并存于同一决定回调）。
    const split = parsePlanningSplitReason(approval.reason);
    if (split) {
      if (approval.status === "APPROVED") {
        await this.recordApprovalEvent(
          requirementId,
          "SLICE_PLANNING_SPLIT_APPROVED",
          approval.id,
          {
            sliceKey: split.sliceKey,
            deploySliceKey: split.deploySliceKey
          }
        );
        // 批准 = 按拆分继续：规划「工程契约」段；规划成功后 maybeAutoStartAfterPlan 会启动工作流。
        void this.planSlice(requirementId, split.sliceKey).catch((error: unknown) => {
          this.logger.error(
            sanitizeLogData({ requirementId, sliceKey: split.sliceKey, error }),
            "slice planning after split approval failed"
          );
        });
      } else {
        const slices = await this.dependencies.planning.findSlicesByRequirementId(requirementId);
        for (const entry of slices) {
          if (entry.sliceKey === split.sliceKey || entry.sliceKey === split.deploySliceKey) {
            await this.dependencies.planning.updateSliceStatus(entry.id, "FAILED");
          }
        }
        await this.dependencies.planning.updateRequirementStatus(requirementId, "ANALYZED");
        await this.recordApprovalEvent(
          requirementId,
          "SLICE_PLANNING_SPLIT_REJECTED",
          approval.id,
          {
            sliceKey: split.sliceKey,
            deploySliceKey: split.deploySliceKey,
            comment: approval.comment
          }
        );
      }
      return;
    }

    if (approval.status === "APPROVED") {
      await this.recordApprovalEvent(requirementId, "approval_approved", approval.id, {});
      const slices = await this.dependencies.planning.findSlicesByRequirementId(requirementId);
      const next = slices.find((entry) => entry.status === "PENDING");
      if (!next) {
        return;
      }
      void this.planSlice(requirementId, next.sliceKey).catch((error: unknown) => {
        this.logger.error(
          sanitizeLogData({ requirementId, sliceKey: next.sliceKey, error }),
          "slice planning failed after gate-1 approval"
        );
      });
      return;
    }

    if (approval.status === "REJECTED") {
      const rejectedCount = this.dependencies.approvals
        ? await this.dependencies.approvals.countRejectedApprovalsByRequirement(requirementId)
        : 3;
      await this.recordApprovalEvent(requirementId, "approval_rejected", approval.id, {
        comment: approval.comment,
        rejectedCount
      });
      if (rejectedCount >= 3) {
        await this.dependencies.planning.updateRequirementStatus(requirementId, "FAILED");
        await this.recordApprovalEvent(requirementId, "SLICE_PLAN_REJECTED_FINAL", approval.id, {
          rejectedCount
        });
        return;
      }
      void this.redoLevel1(requirementId, approval.comment).catch((error: unknown) => {
        this.logger.error(
          sanitizeLogData({ requirementId, error }),
          "level-1 redo after gate-1 rejection failed"
        );
      });
    }
  }

  /** N2：切片工作流创建后登记（PLANNED → RUNNING + 关联 workflow_run_id）。 */
  async handleSliceWorkflowCreated(
    requirementId: string,
    sliceKey: string,
    workflowRunId: string
  ): Promise<void> {
    // 重跑场景（B-4 缺陷修复）：FAILED / DONE 切片被 harness 以新工作流重启时同样要登记，
    // 否则切片行仍指向旧工作流，advanceSliceChain 按 workflowRunId 匹配会失败、链不推进。
    const slice = await this.dependencies.planning.findSliceByKey(requirementId, sliceKey);
    if (slice && slice.status !== "RUNNING") {
      await this.dependencies.planning.updateSliceStatus(slice.id, "RUNNING", { workflowRunId });
    }
  }

  /**
   * 首片 / 补救：对已规划切片创建并启动工作流（create+start）。
   * 控制台按钮与 planSlice 成功后的自动启动共用此入口。
   */
  async startSliceWorkflowForSlice(
    requirementId: string,
    sliceKey: string,
    options: {
      workspacePath?: string;
      policy?: WorkflowPolicy;
      /** 链式推进时从前序工作流继承 workspace / policy。 */
      inheritFromWorkflowRunId?: string;
    } = {}
  ): Promise<WorkflowRun> {
    if (!this.dependencies.startSliceWorkflow) {
      throw new AppError(
        503,
        "SLICE_WORKFLOW_START_UNAVAILABLE",
        "Slice workflow auto-start is not configured in this process"
      );
    }

    const slice = await this.dependencies.planning.findSliceByKey(requirementId, sliceKey);
    if (!slice) {
      throw new AppError(404, "SLICE_NOT_FOUND", "Requirement slice not found");
    }
    if (!slice.planningVersion) {
      throw new AppError(
        409,
        "SLICE_NOT_PLANNED",
        "Slice has no planningVersion; plan the slice before starting its workflow"
      );
    }
    if (slice.status === "RUNNING") {
      throw new AppError(
        409,
        "SLICE_WORKFLOW_ALREADY_RUNNING",
        "Slice workflow is already running"
      );
    }
    if (slice.status === "PENDING" || slice.status === "PLANNING") {
      throw new AppError(
        409,
        "SLICE_NOT_READY",
        `Slice status ${slice.status} cannot start a workflow yet`
      );
    }

    const preflight = await this.deliveryEnvironmentPreflight(requirementId, slice);
    if (!preflight.ok) {
      await this.dependencies.planning.updateSliceStatus(slice.id, "FAILED");
      await this.recordEventOnLatestPlanningRun(
        requirementId,
        "DELIVERY_ENVIRONMENT_PREFLIGHT_FAILED",
        {
          sliceKey: slice.sliceKey,
          errorCode: "DELIVERY_ENVIRONMENT_MISSING",
          deliveryTaskCount: preflight.deliveryTaskCount,
          stage: "workflow_creation"
        }
      );
      throw new AppError(
        409,
        "DELIVERY_ENVIRONMENT_MISSING",
        "Delivery tasks require a project deployment environment before starting the slice workflow"
      );
    }

    let workspacePath = options.workspacePath;
    let policy = options.policy;
    const inheritId = options.inheritFromWorkflowRunId;
    if (inheritId && this.dependencies.workflows) {
      const previous = await this.dependencies.workflows.findWorkflowById(inheritId);
      if (previous) {
        if (!workspacePath && previous.input.workspacePath) {
          workspacePath = String(previous.input.workspacePath);
        }
        policy = policy ?? previous.policy;
      }
    }
    // Project-owned path: when no explicit / previous workflow path, inherit from project.
    // WorkflowService.create will still ensure/allocate if still missing (legacy null).
    if (!workspacePath && this.dependencies.projects) {
      const project = await this.dependencies.projects.findById(slice.projectId);
      if (project?.workspacePath) {
        workspacePath = project.workspacePath;
      }
    }

    const created = await this.dependencies.startSliceWorkflow({
      projectId: slice.projectId,
      requirementId: slice.requirementId,
      ...(workspacePath ? { workspacePath } : {}),
      planningVersion: slice.planningVersion,
      sliceKey: slice.sliceKey,
      policy: resolveSliceWorkflowPolicy(policy),
      approvalTaskKeys: []
    });
    // create() 钩子会走 handleSliceWorkflowCreated；这里再写一次保证 RUNNING + workflowRunId。
    await this.dependencies.planning.updateSliceStatus(slice.id, "RUNNING", {
      workflowRunId: created.id
    });
    return created;
  }

  /**
   * planSlice 成功后：若本片是最早未完成切片且仍为 PLANNED，则自动启动工作流。
   * 无 startSliceWorkflow 注入时跳过（L2 演练）；失败只记日志，切片保持 PLANNED 供补救按钮重试。
   */
  private async maybeAutoStartAfterPlan(requirementId: string, sliceKey: string): Promise<void> {
    if (!this.dependencies.startSliceWorkflow) {
      return;
    }
    const slices = await this.dependencies.planning.findSlicesByRequirementId(requirementId);
    const planned = slices.find((entry) => entry.sliceKey === sliceKey);
    if (!planned || planned.status !== "PLANNED" || !planned.planningVersion) {
      return;
    }
    const firstUnfinished = slices.find((entry) => entry.status !== "DONE");
    if (!firstUnfinished || firstUnfinished.sliceKey !== sliceKey) {
      return;
    }
    if (planned.workflowRunId) {
      return;
    }

    const earlierDone = slices.filter(
      (entry) =>
        entry.order < planned.order && entry.status === "DONE" && Boolean(entry.workflowRunId)
    );
    const inheritFromWorkflowRunId = earlierDone[earlierDone.length - 1]?.workflowRunId;

    try {
      await this.startSliceWorkflowForSlice(requirementId, sliceKey, {
        ...(inheritFromWorkflowRunId ? { inheritFromWorkflowRunId } : {})
      });
      await this.recordEventOnLatestPlanningRun(requirementId, "SLICE_WORKFLOW_AUTO_STARTED", {
        sliceKey,
        planningVersion: planned.planningVersion,
        inheritedWorkflowRunId: inheritFromWorkflowRunId ?? null
      });
    } catch (error: unknown) {
      this.logger.error(
        sanitizeLogData({ requirementId, sliceKey, error }),
        "auto-start slice workflow after plan failed; slice left PLANNED for manual retry"
      );
    }
  }

  /** N2：切片工作流终态 → 链式推进下一片（非切片工作流零影响；失败不自动前进）。 */
  handleWorkflowTerminal(workflowRunId: string, status: "SUCCESS" | "FAILED" | "CANCELLED"): void {
    void this.advanceSliceChain(workflowRunId, status).catch((error: unknown) => {
      this.logger.error(
        sanitizeLogData({ workflowRunId, status, error }),
        "slice chain advance failed"
      );
    });
  }

  private async advanceSliceChain(
    workflowRunId: string,
    status: "SUCCESS" | "FAILED" | "CANCELLED"
  ): Promise<void> {
    const slice = await this.dependencies.planning.findSliceByWorkflowRunId(workflowRunId);
    if (!slice) {
      return; // 常规（非切片）工作流：零影响
    }

    if (status !== "SUCCESS") {
      if (slice.status === "RUNNING") {
        await this.dependencies.planning.updateSliceStatus(slice.id, "FAILED");
      }
      return; // 失败按既有失败策略处理、不自动前进
    }

    await this.dependencies.planning.updateSliceStatus(slice.id, "DONE");
    const slices = await this.dependencies.planning.findSlicesByRequirementId(slice.requirementId);
    // G4（GX-11）：严格前序——仅当更早切片全部 DONE 时推进到首个 PENDING 切片；
    // 存在更早未完成（FAILED/PLANNING/PLANNED/RUNNING）切片时挂起并留事件（防乱序双链，见 docs/131）。
    const firstUnfinished = slices.find((entry) => entry.status !== "DONE");
    const next = firstUnfinished?.status === "PENDING" ? firstUnfinished : undefined;
    if (!next) {
      if (firstUnfinished) {
        await this.recordEventOnLatestPlanningRun(
          slice.requirementId,
          "SLICE_CHAIN_HELD_BY_EARLIER_SLICE",
          {
            sliceKey: slice.sliceKey,
            blockedBy: { sliceKey: firstUnfinished.sliceKey, status: firstUnfinished.status }
          }
        );
      }
      return;
    }

    await this.planSlice(slice.requirementId, next.sliceKey);

    const planned = await this.dependencies.planning.findSliceByKey(
      slice.requirementId,
      next.sliceKey
    );
    // planSlice 成功路径会 maybeAutoStartAfterPlan；若已 RUNNING 则无需再启。
    if (planned?.status === "RUNNING" && planned.workflowRunId) {
      return;
    }
    if (!planned || planned.status !== "PLANNED" || !planned.planningVersion) {
      return;
    }
    if (!this.dependencies.startSliceWorkflow || !this.dependencies.workflows) {
      return;
    }
    const previous = await this.dependencies.workflows.findWorkflowById(workflowRunId);
    if (!previous) {
      return;
    }
    // 回退：自动启动未跑或失败时，仍按前序工作流继承 workspace/policy 再启一次。
    await this.startSliceWorkflowForSlice(slice.requirementId, planned.sliceKey, {
      inheritFromWorkflowRunId: previous.id,
      policy: previous.policy,
      ...(previous.input.workspacePath
        ? { workspacePath: String(previous.input.workspacePath) }
        : {})
    });
  }

  /** N2 第二级：单切片规划（创建 agent run → 规划图 level2 → 切片 scoped 持久化）。 */
  private async planSlice(requirementId: string, sliceKey: string): Promise<void> {
    const requirement = await this.getRequirement(requirementId);
    if (!requirement) {
      return;
    }
    const slice = await this.dependencies.planning.findSliceByKey(requirementId, sliceKey);
    if (!slice || slice.status !== "PENDING") {
      return;
    }
    const analysis = await this.dependencies.planning.findLatestAnalysis(requirementId);
    if (!analysis) {
      await this.dependencies.planning.updateSliceStatus(slice.id, "FAILED");
      return;
    }

    const latestVersion = await this.dependencies.planning.latestPlanningVersion(requirementId);
    const version = planningVersion(latestVersion);
    await this.dependencies.planning.updateSliceStatus(slice.id, "PLANNING");
    if (requirement.status !== "ANALYZED") {
      await this.dependencies.planning.updateRequirementStatus(requirementId, "ANALYZING");
    }

    const run = await this.dependencies.agentRuns.create({
      projectId: requirement.projectId,
      taskId: randomUUID(),
      input: sanitizeObject({
        runtime: "planning-agent",
        requirementId,
        sliceKey,
        planningVersion: version
      }),
      maxIterations: PLANNING_MAX_ITERATIONS
    });
    await this.recordEvent(run.id, "agent_run_created", {
      runtime: "planning-agent",
      requirementId,
      sliceKey,
      planningVersion: version
    });

    await this.ensureAcceptanceCriteria(requirement, run.id);
    await this.executeSliceRun(requirement, slice, run, version, analysis);
  }

  /**
   * N3：AC 一等记录的确保落盘（提取=替换、幂等）。
   * PRD 已带编号 → 确定性 Markdown 解析（不调 LLM）；无编号 → 复用最新 requirement_analysis 的
   * LLM 提取串（确认走既有关口 1），按出现顺序生成 AC-01… 编号；两者皆无 → 不落盘。
   */
  private async ensureAcceptanceCriteria(
    requirement: Requirement,
    agentRunId?: string
  ): Promise<void> {
    const parsed = parseAcceptanceCriteriaFromPrd(requirement.rawContent ?? "");
    let records: AcceptanceCriterionRecord[];
    let source: "parsed" | "llm";

    if (parsed.acs.length > 0) {
      source = "parsed";
      records = parsed.acs.map((ac) => ({
        acKey: ac.acKey,
        text: ac.text,
        textHash: hashAcceptanceText(ac.text),
        priority: ac.priority,
        verification: ac.verification,
        smoke: ac.smoke,
        frKeys: ac.frKeys,
        source: "parsed" as const
      }));
    } else {
      const analysis = await this.dependencies.planning.findLatestAnalysis(requirement.id);
      const extracted = analysis?.acceptanceCriteria ?? [];
      if (extracted.length === 0) {
        return;
      }
      source = "llm";
      records = extracted.map((text, index) => ({
        acKey: `AC-${String(index + 1).padStart(2, "0")}`,
        text,
        textHash: hashAcceptanceText(text),
        priority: null,
        verification: null,
        smoke: false,
        frKeys: [],
        source: "llm" as const
      }));
    }

    await this.dependencies.planning.replaceAcceptanceCriteria({
      projectId: requirement.projectId,
      requirementId: requirement.id,
      records
    });

    if (agentRunId) {
      await this.recordEvent(agentRunId, "AC_CRITERIA_PERSISTED", {
        requirementId: requirement.id,
        source,
        count: records.length
      });
    }
  }

  private async executeSliceRun(
    requirement: Requirement,
    slice: RequirementSlice,
    run: AgentRun,
    version: number,
    analysis: RequirementAnalysis
  ): Promise<void> {
    const logger = this.logger.child({
      agentRunId: run.id,
      requirementId: requirement.id,
      sliceKey: slice.sliceKey
    });
    const controller = new AbortController();

    try {
      const project = await this.dependencies.projects.findById(requirement.projectId);
      const acceptanceCriteria = acceptanceCriteriaFromRecords(
        await this.dependencies.planning.findAcceptanceCriteriaByRequirementId(requirement.id)
      );
      // F1-3：交付链归属与补块上下文——「是否最终切片」取自库中 slice_order（最后一片即最终）；
      // 补块环境取自项目 deployment_environments（staging 优先，其余按名称序），无环境 = 不补块。
      const slices = await this.dependencies.planning.findSlicesByRequirementId(requirement.id);
      const isFinalSlice = slices[slices.length - 1]?.sliceKey === slice.sliceKey;
      // N-43：骨架先行契约只在第一个切片生效（工作区从空开始的那一片）。
      const isFirstSlice = slices[0]?.sliceKey === slice.sliceKey;
      const deliveryEnvironments = (await this.isDeliveryConfigured(project))
        ? ((await this.dependencies.deployments?.findEnvironments(requirement.projectId)) ?? [])
        : [];
      const deliveryEnvironment =
        deliveryEnvironments.find((entry) => entry.name === "staging")?.name ??
        deliveryEnvironments.find((entry) => DELIVERY_ENVIRONMENT_NAMES.has(entry.name))?.name ??
        null;
      const agent = new PlanningAgent({
        model: this.model,
        pipeline: "level2",
        acceptanceCriteria,
        ...(this.dependencies.capabilityProfile
          ? { profile: this.dependencies.capabilityProfile }
          : {}),
        slice: {
          key: slice.sliceKey,
          title: slice.title,
          goal: slice.goal,
          frKeys: slice.frKeys
        },
        skipStages: [
          ...(slice.involvesUi ? [] : (["ui_spec"] as const)),
          ...(slice.involvesData === false ||
          (this.dependencies.capabilityProfile !== undefined &&
            !profileEnablesDataLayer(this.dependencies.capabilityProfile))
            ? (["database_spec"] as const)
            : [])
        ],
        seedAnalysis: analysis,
        defaultTimeoutMs: this.budgets.sliceTimeoutMs,
        stageTimeoutMs: this.budgets.stageTimeoutMs,
        stageRetries: this.budgets.stageRetries,
        taskPlanningTimeoutMs: this.budgets.taskPlanningTimeoutMs,
        lifecycle: this.createLifecycleHooks(),
        afterGraph: async (graphResult) => {
          const saved = await this.dependencies.planning.saveSlicePlanningResult({
            projectId: requirement.projectId,
            requirementId: requirement.id,
            requirementVersion: requirement.version,
            version,
            sliceKey: slice.sliceKey,
            analysis,
            specifications: specificationsFrom(graphResult),
            taskPlan: graphResult.taskPlan,
            ...(this.profileTag ? { profile: this.profileTag } : {})
          });
          await this.recordEvent(run.id, "SLICE_PLANNING_PERSISTED", {
            requirementId: requirement.id,
            sliceKey: slice.sliceKey,
            version,
            specificationCount: saved.specifications.length,
            taskCount: saved.tasks.length
          });
          await this.recordCrossSpecConsistency(run.id, graphResult, slice.sliceKey);
        }
      });

      const providedTechnicalDocs = this.dependencies.documents
        ? (await this.dependencies.documents.findContentsByRequirementId(requirement.id)).map(
            (entry) => ({
              fileName: entry.fileName,
              text: entry.text,
              truncated: entry.truncated
            })
          )
        : [];
      const providedUiReferences = await this.prepareUiReferencesForPlanning(
        requirement.id,
        run.id
      );
      const conflictResolutions = await this.loadConflictResolutions(requirement.id);
      const result = await agent.run(
        requirement,
        {
          requestId: run.id,
          projectId: requirement.projectId,
          requirementId: requirement.id,
          taskId: run.taskId,
          agentRunId: run.id
        },
        {
          timeoutMs: this.budgets.sliceTimeoutMs,
          signal: controller.signal,
          deliveryConfigured: await this.isDeliveryConfigured(project),
          isFinalSlice,
          isFirstSlice,
          deliveryEnvironment,
          providedTechnicalDocs,
          providedUiReferences,
          conflictResolutions,
          ...(this.finalSliceMaxTasks !== undefined
            ? { finalSliceMaxTasks: this.finalSliceMaxTasks }
            : {})
        }
      );

      if (result.status === "succeeded") {
        await this.dependencies.planning.updateRequirementStatus(requirement.id, "ANALYZED");
        await this.recordEvent(run.id, "SLICE_PLANNING_COMPLETED", {
          requirementId: requirement.id,
          sliceKey: slice.sliceKey,
          version
        });
        // 产品补齐：首片（及链式 planSlice）规划成功后自动 create+start 切片工作流。
        await this.maybeAutoStartAfterPlan(requirement.id, slice.sliceKey);
        return;
      }

      const errorCode = result.error?.code ?? "PLANNING_ERROR";
      if (isEscalatablePlanningFailure(errorCode, result.error?.message ?? "")) {
        // F1-4（FX-15b）：最终切片超限且 LLM 压缩不收敛 → 一级重做拆分（工程契约 + 部署验证），
        // 经关口 1 审批；拆分只作用于尚未开始的最终切片（已完成切片的范围/任务/计划行零改动）。
        // 已拆分过（再失败）→ 落回 F1-3 升级路径（人工关口）。超时按消息不匹配，走下面的升级。
        if (isFinalSlice && (result.error?.message ?? "").includes("FINAL_SLICE_OVERLOAD")) {
          const split = await this.splitFinalSlice(requirement, slice, run);
          if (split) {
            return;
          }
        }
        // F1-3（发现③）：LLM 修复轮耗尽（校验类失败）→ 升级人工关口而非终态失败：
        // 切片保留可重试（PENDING），建需求级审批（复用关口 1 同一机制/端点）；
        // 批准后仅重试该切片规划；已完成切片的范围/任务/计划行零改动。
        //
        // N-51（`docs/232` §9.20 F1）：**超时也走这条路**。它是瞬态的，比重试确定性校验失败更有意义；
        // 上限仍是同一套（复用 `countApprovalsByRequirement` 的前缀计数），不另立第二套退避。
        //
        // F1-3 增补（L3 前置修复）：升级重试上限——同切片升级轮数达上限后按终态失败
        // 处理（不再建审批），防止确定性失败 + 自动批准形成无限重试循环。
        const priorEscalations =
          (await this.dependencies.approvals?.countApprovalsByRequirement(
            requirement.id,
            `${PLANNING_ESCALATION_PREFIX}${slice.sliceKey}]`
          )) ?? 0;
        if (priorEscalations >= MAX_SLICE_PLANNING_ESCALATION_RETRIES) {
          await this.dependencies.planning.updateSliceStatus(slice.id, "FAILED");
          const anyPlannedAfterRetries = slices.some((entry) =>
            ["PLANNED", "RUNNING", "DONE"].includes(entry.status)
          );
          await this.dependencies.planning.updateRequirementStatus(
            requirement.id,
            anyPlannedAfterRetries ? "ANALYZED" : "FAILED"
          );
          await this.recordEvent(run.id, "SLICE_PLANNING_FAILED", {
            requirementId: requirement.id,
            sliceKey: slice.sliceKey,
            errorCode,
            errorMessage: clipPlanningErrorMessage(result.error?.message),
            retriesExhausted: true
          });
          return;
        }
        await this.dependencies.planning.updateSliceStatus(slice.id, "PENDING");
        await this.dependencies.planning.updateRequirementStatus(requirement.id, "PLANNING_REVIEW");
        const pending = await this.dependencies.approvals?.findPendingApprovalByRequirement(
          requirement.id
        );
        const approval =
          pending ??
          (await this.dependencies.approvals?.createRequirementApproval(
            requirement.id,
            planningEscalationReason(slice.sliceKey, errorCode, result.error?.message)
          ));
        await this.recordEvent(run.id, "SLICE_PLANNING_FAILED", {
          requirementId: requirement.id,
          sliceKey: slice.sliceKey,
          errorCode,
          errorMessage: clipPlanningErrorMessage(result.error?.message),
          escalated: true
        });
        await this.recordEvent(run.id, "SLICE_PLANNING_ESCALATED", {
          requirementId: requirement.id,
          sliceKey: slice.sliceKey,
          errorCode,
          approvalId: approval?.id ?? null,
          retryable: true
        });
        return;
      }

      await this.dependencies.planning.updateSliceStatus(slice.id, "FAILED");
      const anyPlanned = slices.some((entry) =>
        ["PLANNED", "RUNNING", "DONE"].includes(entry.status)
      );
      await this.dependencies.planning.updateRequirementStatus(
        requirement.id,
        anyPlanned ? "ANALYZED" : "FAILED"
      );
      await this.recordEvent(run.id, "SLICE_PLANNING_FAILED", {
        requirementId: requirement.id,
        sliceKey: slice.sliceKey,
        errorCode,
        errorMessage: clipPlanningErrorMessage(result.error?.message)
      });
    } catch (error) {
      logger.error(sanitizeLogData({ error }), "slice planning run failed");
      throw error;
    }
  }

  /** N2：关口 1 拒绝后的第一级重做（拒绝意见作为修复输入）。 */
  private async redoLevel1(requirementId: string, feedback: string): Promise<void> {
    const requirement = await this.getRequirement(requirementId);
    if (!requirement) {
      return;
    }
    await this.dependencies.planning.updateRequirementStatus(requirementId, "ANALYZING");
    const run = await this.dependencies.agentRuns.create({
      projectId: requirement.projectId,
      taskId: randomUUID(),
      input: sanitizeObject({
        runtime: "planning-agent",
        requirementId,
        sliceRedo: true
      }),
      maxIterations: PLANNING_MAX_ITERATIONS
    });
    await this.recordEvent(run.id, "agent_run_created", {
      runtime: "planning-agent",
      requirementId,
      sliceRedo: true
    });

    const project = await this.dependencies.projects.findById(requirement.projectId);
    const controller = new AbortController();
    const agent = new PlanningAgent({
      model: this.model,
      pipeline: "level1",
      ...(this.dependencies.capabilityProfile
        ? { profile: this.dependencies.capabilityProfile }
        : {}),
      sliceFeedback: feedback,
      defaultTimeoutMs: this.budgets.level1TimeoutMs,
      stageTimeoutMs: this.budgets.stageTimeoutMs,
      stageRetries: this.budgets.stageRetries,
      lifecycle: this.createLifecycleHooks(),
      afterSlicePlan: (level1) => this.persistSlicePlan(requirement, run, level1)
    });

    const result = await agent.run(
      requirement,
      {
        requestId: run.id,
        projectId: requirement.projectId,
        requirementId: requirement.id,
        taskId: run.taskId,
        agentRunId: run.id
      },
      {
        timeoutMs: this.budgets.level1TimeoutMs,
        signal: controller.signal,
        deliveryConfigured: await this.isDeliveryConfigured(project)
      }
    );
    await this.finishRequirementFromResult(requirementId, result);
  }

  /**
   * F1-4（FX-15b）：最终切片超限后的「一级重做拆分」（确定性；沿用 redoLevel1 的关口 1 审批流）。
   * 将尚未开始的最终切片拆为「工程契约」（原行，FR 范围不变）+「部署验证」（新增行，承接交付链与
   * 全局性验收，frKeys = 全局性 AC 的 FR 并集）；已完成切片的 FR 范围/任务/计划行零改动
   * （只 INSERT 新行 + 更新原行展示字段，不标 SUPERSEDED）。返回 false = 不满足拆分条件（交升级路径）。
   */
  private async splitFinalSlice(
    requirement: Requirement,
    slice: RequirementSlice,
    run: AgentRun
  ): Promise<boolean> {
    const slices = await this.dependencies.planning.findSlicesByRequirementId(requirement.id);
    const last = slices[slices.length - 1];
    if (!last || last.sliceKey !== slice.sliceKey) {
      return false; // 只拆分当前（尚未开始的）最终切片
    }
    const deploySliceKey = `${slice.sliceKey}-deploy`;
    if (slices.some((entry) => entry.sliceKey === deploySliceKey)) {
      return false; // 已拆分过（再失败）→ 交 F1-3 升级路径
    }

    const records = await this.dependencies.planning.findAcceptanceCriteriaByRequirementId(
      requirement.id
    );
    const globalFrKeys = [
      ...new Set(
        records
          .filter((record) => isGlobalAcceptanceCriterion(record))
          .flatMap((record) => record.frKeys)
      )
    ];

    await this.dependencies.planning.updateSliceStatus(slice.id, "PENDING");
    await this.dependencies.planning.updateSliceMeta(slice.id, {
      title: `${slice.title}（工程契约）`,
      goal: `${slice.goal}（工程契约段：完成集成所需的工程化收尾；交付链与全局验收由部署验证切片承担）`
    });
    const deploySlice = await this.dependencies.planning.insertRequirementSlice({
      projectId: slice.projectId,
      requirementId: requirement.id,
      sliceKey: deploySliceKey,
      title: `部署验证：${slice.title}`,
      goal: "交付链收尾与全局性验收（最终集成段第二部分）。",
      frKeys: globalFrKeys.length > 0 ? globalFrKeys : slice.frKeys,
      dependsOn: [slice.sliceKey],
      order: slice.order + 1,
      involvesUi: false
    });

    await this.dependencies.planning.updateRequirementStatus(requirement.id, "PLANNING_REVIEW");
    const pending = await this.dependencies.approvals?.findPendingApprovalByRequirement(
      requirement.id
    );
    const approval =
      pending ??
      (await this.dependencies.approvals?.createRequirementApproval(
        requirement.id,
        planningSplitReason(slice.sliceKey, deploySlice.sliceKey)
      ));
    await this.recordEvent(run.id, "SLICE_PLANNING_FAILED", {
      requirementId: requirement.id,
      sliceKey: slice.sliceKey,
      errorCode: "VALIDATION_ERROR",
      escalated: false,
      split: true
    });
    await this.recordEvent(run.id, "FINAL_SLICE_SPLIT", {
      requirementId: requirement.id,
      sliceKey: slice.sliceKey,
      deploySliceKey: deploySlice.sliceKey,
      globalFrKeys,
      approvalId: approval?.id ?? null,
      reason: "FINAL_SLICE_OVERLOAD after LLM compression did not converge"
    });
    return true;
  }

  /**
   * F1-4（FX-13b）：工作流创建预检——切片计划含交付链任务（DEPLOY 或携带 delivery 块）时，
   * 项目必须已有环境记录（deployment_environments）；缺失 → 明确失败（不创建工作流）。
   * 补块处（F1-3）仅兜底；此处把「缺环境」从执行期失败提前到工作流创建时点。
   */
  private async deliveryEnvironmentPreflight(
    requirementId: string,
    slice: RequirementSlice
  ): Promise<{ ok: true } | { ok: false; deliveryTaskCount: number }> {
    const planTasks = (
      await this.dependencies.planning.findTasksByRequirementId(requirementId)
    ).filter((entry) => !entry.workflowRunId && entry.sliceKey === slice.sliceKey);
    const deliveryTasks = planTasks.filter(
      (entry) => entry.type === "DEPLOY" || (entry.input.delivery ?? null) !== null
    );
    if (deliveryTasks.length === 0) {
      return { ok: true };
    }
    const environments =
      (await this.dependencies.deployments?.findEnvironments(slice.projectId)) ?? [];
    return environments.length > 0
      ? { ok: true }
      : { ok: false, deliveryTaskCount: deliveryTasks.length };
  }

  /**
   * F1-4（FX-14b）：L2 规划演练驱动——按序规划全部 PENDING 切片，不创建任何切片工作流。
   * 演练脚本装配本服务时不注入 startSliceWorkflow/workflows，链式推进因此也不会创建工作流。
   */
  async planPendingSlicesInOrder(requirementId: string): Promise<void> {
    const slices = await this.dependencies.planning.findSlicesByRequirementId(requirementId);
    for (const slice of slices) {
      if (slice.status === "PENDING") {
        await this.planSlice(requirementId, slice.sliceKey);
      }
    }
  }

  /** F1-4：把需求级事件挂到该需求最近一次规划 run 的时间线上（先例 recordApprovalEvent）。 */
  private async recordEventOnLatestPlanningRun(
    requirementId: string,
    eventType: string,
    extra: JsonObject
  ): Promise<void> {
    // findMany 按 created_at DESC 返回 → 首个匹配即最近一次规划 run。
    const runs = await this.dependencies.agentRuns.findMany();
    const latest = runs.find(
      (entry) =>
        entry.input.runtime === "planning-agent" && entry.input.requirementId === requirementId
    );
    if (!latest) {
      return;
    }
    await this.recordEvent(latest.id, eventType, { requirementId, ...extra });
  }

  /**
   * G2（GX-06/07）：确定性跨规格一致性检查（非阻断）——结果作为事件留痕；
   * 检查失败不影响规划主流程（try/catch 记录 warn）。
   */
  private async recordCrossSpecConsistency(
    runId: string,
    graphResult: Parameters<typeof specificationsFrom>[0],
    sliceKey?: string
  ): Promise<void> {
    try {
      const { findings, checked } = checkCrossSpecConsistency({
        apiSpec: graphResult.apiSpec,
        databaseSpec: graphResult.databaseSpec,
        tasks: graphResult.taskPlan.tasks
      });
      await this.recordEvent(runId, "CROSS_SPEC_CONSISTENCY_CHECKED", {
        ...(sliceKey ? { sliceKey } : {}),
        findingCount: findings.length,
        findings: findings.slice(0, 20),
        checkedApiPaths: checked.apiPaths,
        checkedTables: checked.tables
      });
    } catch (error: unknown) {
      this.logger.warn(sanitizeLogData({ error }), "cross-spec consistency check failed");
    }
  }

  /** N2：把审批事件挂到该需求最近一次规划 run 的时间线上。 */
  private async recordApprovalEvent(
    requirementId: string,
    eventType: string,
    approvalId: string,
    extra: JsonObject
  ): Promise<void> {
    // findMany 按 created_at DESC 返回 → 首个匹配即最近一次规划 run（F1-4 修正反转取值）。
    const runs = await this.dependencies.agentRuns.findMany();
    const latest = runs.find(
      (entry) =>
        entry.input.runtime === "planning-agent" && entry.input.requirementId === requirementId
    );
    if (!latest) {
      return;
    }
    await this.recordEvent(latest.id, eventType, { requirementId, approvalId, ...extra });
  }

  private async recordEvent(
    agentRunId: string,
    eventType: string,
    payload: JsonObject
  ): Promise<WorkflowEvent> {
    const event = await this.dependencies.workflowEvents.create({
      agentRunId,
      eventType,
      payload: sanitizeObject(payload)
    });
    this.dependencies.notifyRunChanged?.(agentRunId);
    return event;
  }
}
