import { sanitizeLogData } from "@ai-se/observability";
import {
  AcceptanceCriterion,
  ApiSpecSchema,
  ArchitectureSpecSchema,
  DatabaseSpecSchema,
  DEFAULT_CAPABILITY_PROFILE,
  FunctionalSpecSchema,
  JsonObject,
  ProvidedConflictResolution,
  ProvidedTechnicalDocument,
  ProvidedUiReference,
  Requirement,
  RequirementAnalysis,
  RequirementAnalysisSchema,
  SlicePlan,
  SlicePlanSchema,
  TaskPlan,
  TaskPlanSchema,
  TechnicalSpecSchema,
  UiSpecSchema,
  type CapabilityProfile,
  type UiSpecContent
} from "@ai-se/shared";
import { END, START, Annotation, MemorySaver, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { AgentLifecycleHooks } from "../agent/AgentLifecycle";
import { PlanningModel } from "./PlanningModel";
import {
  PlanningGraphResult,
  PlanningLevel1Result,
  PlanningSliceScope,
  PlanningStage,
  PlanningState
} from "./PlanningState";
import { apiSpecPrompt } from "./prompts/api-spec.prompt";
import { architecturePrompt } from "./prompts/architecture.prompt";
import { DATABASE_SPEC_PROMPT } from "./prompts/database-spec.prompt";
import { FUNCTIONAL_SPEC_PROMPT } from "./prompts/functional-spec.prompt";
import { REPAIR_PROMPT } from "./prompts/repair.prompt";
import { requirementAnalysisPrompt } from "./prompts/requirement-analysis.prompt";
import { taskPlanningPrompt } from "./prompts/task-planning.prompt";
import { slicePlanningPrompt } from "./prompts/slice-planning.prompt";
import { TECHNICAL_SPEC_PROMPT } from "./prompts/technical-spec.prompt";
import { uiSpecPrompt } from "./prompts/ui-spec.prompt";
import { TaskGraphValidationError, validateTaskGraph } from "./validateTaskGraph";
import { validatePlanningSpecifications } from "./validatePlanningOutput";
import { validateSlicePlan } from "./validateSlicePlan";
import { validateNamedPlanChecks } from "./validateNamedPlanChecks";
import { validateVisualBaselineGaps } from "./validateVisualBaselineGaps";
import { validateConsumedApiSpec } from "./validateConsumedApiSpec";
import {
  isGlobalAcceptanceCriterion,
  parseAcceptanceCriteriaFromPrd,
  selectAcceptanceCriteriaForSlice
} from "./acceptanceCriteria";
import { finalSliceOverloadError, measureFinalSliceScale } from "./finalSliceScale";
import { validateAcceptanceCoverage } from "./validateAcceptanceCoverage";
import { validateImplementationCoverage } from "./validateImplementationCoverage";
import { validatePlannableTaskTypes } from "./validatePlannableTaskTypes";
import { findUnanchoredTestTasks, validateTaskAnchors } from "./validateTaskAnchors";
import { AcKeysPresenceResult, validateAcKeysPresence } from "./validateAcKeysPresence";
import { backfillTaskPlanAcKeys } from "./acKeysBackfill";
import { autoFixTaskPlan } from "./autoFixTaskPlan";
import { validateScriptProviders } from "./validateScriptProviders";
import { repairSkeletonAcceptanceCriteria, validateSkeletonPlan } from "./validateSkeletonPlan";
import { validateMustAcTestCoverage, validateTestFirstOrder } from "./validateTestFirstPlan";

/**
 * N-51（`docs/232` §9.20 F4）：**阶段墙钟耗尽是一个可识别的失败类**，不再伪装成普通错误。
 *
 * 此前 `stageWithBudget` 抛的是裸 `Error`，于是「模型太慢」与「模型吐出非法 JSON」在
 * `agent_runs.error.code` 上同为 `PLANNING_ERROR`——而两者的处置方式相反：前者是瞬态的，
 * 应当重试/升级；后者是产物质量问题，重排整个切片未必有帮助。批次账本因此分不开这两类。
 */
export class PlanningStageTimeoutError extends Error {
  constructor(
    readonly stage: PlanningStage,
    readonly budgetMs: number,
    options?: { cause?: unknown }
  ) {
    super(`Planning stage timed out: ${stage} (${budgetMs}ms)`, options);
    this.name = "PlanningStageTimeoutError";
  }
}

export interface PlanningGraphOptions {
  agentRunId: string;
  taskId: string;
  requirement: Requirement;
  model: PlanningModel;
  lifecycle?: AgentLifecycleHooks;
  signal?: AbortSignal;
  maxValidationRetries?: number;
  /** 项目是否已绑定 Git 仓库（false 时规划期拒绝交付链，见 validateTaskGraph）。 */
  deliveryConfigured?: boolean;
  /**
   * N3 库记录（F1-1）：判定「需求是否有 AC 记录」的第二来源；编号 PRD 解析为空时
   * 兜底作为校验用 AC 集（无编号 PRD 的 LLM 提取记录）。
   */
  acceptanceCriteria?: AcceptanceCriterion[];
  /**
   * D1（`docs/229`）：用户提供的技术需求文档。**权威输入**——规划产出必须与之保持一致，
   * 与 PRD 冲突时写进 `technicalDocumentConflicts` 交人工，不得自行取舍。
   */
  providedTechnicalDocs?: ProvidedTechnicalDocument[];
  /**
   * UI 参照图（intake）：可选视觉参照，与技术文档并列进入各阶段 input。
   * 多模态由 LangChainPlanningModel 附着；不做 OCR、不进视觉修复闭环。
   */
  providedUiReferences?: ProvidedUiReference[];
  /**
   * 人工冲突裁决：已落库决定，随各阶段 input 注入；模型须服从，不得对已裁决 topic 再取舍。
   */
  conflictResolutions?: ProvidedConflictResolution[];
  /** F1-3：当前切片是否最终切片（二级规划传入；undefined = 不校验归属，full/单级不变）。 */
  isFinalSlice?: boolean;
  /**
   * `docs/235` §6.5 / `docs/268` / `docs/269`：能力 profile。影响可规划类型清单、切片
   * `involvesData`、`api_spec` 的消费/生成模式，以及计划期 `validatePlannableTaskTypes` /
   * 规划合同硬校验；缺省 = 产品默认 profile。
   */
  profile?: CapabilityProfile;
  /**
   * N-43：当前切片是否第一个切片（`requirement_slices.slice_order` 最小者）。显式 true 时启用骨架
   * 先行契约（首个切片的骨架任务必须真正实现它声明的脚本）；undefined/false 保持既有行为。
   */
  isFirstSlice?: boolean;
  /** F1-3：补块环境名（仅最终切片 DEPLOY 交付块补全；缺省 = 不补块）。 */
  deliveryEnvironment?: string | null;
  /** F1-4：最终切片任务数上限（enforce；缺省 = observe 只记录 `FINAL_SLICE_SCALE_OBSERVED`、不判失败）。 */
  finalSliceMaxTasks?: number;
  /** N2：full=旧单级全流程（默认）；level2=两级规划第二层（单切片）。 */
  pipeline?: "full" | "level2";
  /** 第二级切片范围（pipeline=level2 必填）；同时作为切片范围的模型输入。 */
  slice?: PlanningSliceScope;
  /** 第二级跳过的阶段（如纯后端切片跳过 ui_spec；跳过会发事件留痕）。 */
  skipStages?: PlanningStage[];
  /** 第二级种子：从库中载入的 requirement_analysis（第一级产物）。 */
  seedAnalysis?: RequirementAnalysis;
  /** 第一级被关口 1 拒绝后的修改意见（重做切片计划时作为修复输入）。 */
  sliceFeedback?: string;
  /** 阶段级墙钟上限与重试（N1 决策默认 150s / 1；总预算仍由上层 run timeout 兜底）。 */
  stageTimeoutMs?: number;
  /**
   * N-52（`docs/232` §9.22）：`task_planning` 单独一档阶段预算。
   *
   * 第九次回归里同一个切片的 `task_planning` **六次尝试全部卡在 150s**（3 个 run × 2 次重试），
   * 而三次 run 总时长只有 424–435s——瓶颈不是外层预算，是这一阶段的规模（这一阶段要产出整片任务的
   * DAG，输出最大）。其余阶段维持 `stageTimeoutMs`，不给真卡住的阶段翻倍烧时间。
   */
  taskPlanningTimeoutMs?: number;
  stageRetries?: number;
  /**
   * N-25（`docs/206`）：每次模型调用的用量回调。由 `PlanningAgent` 汇总成 `PlanningAgentResult.tokenUsage`，
   * 经 `onRunFinished` 落到 `agent_runs.token_usage`——守卫与指标读的就是那一个字段。
   */
  onTokenUsage?: (usage: JsonObject) => void;
}

export class PlanningValidationError extends Error {
  constructor(
    message: string,
    public readonly validationErrors: string[]
  ) {
    super(message);
  }
}

const STAGE_EVENTS: Record<PlanningStage, string> = {
  requirement_analysis: "REQUIREMENT_ANALYSIS",
  slice_planning: "SLICE_PLANNING",
  functional_spec: "FUNCTIONAL_SPEC",
  technical_spec: "TECHNICAL_SPEC",
  architecture: "ARCHITECTURE_GENERATION",
  api_spec: "API_SPEC_GENERATION",
  database_spec: "DATABASE_SPEC_GENERATION",
  ui_spec: "UI_SPEC_GENERATION",
  task_planning: "TASK_PLANNING"
};

const STAGE_ITERATIONS: Record<PlanningStage, number> = {
  requirement_analysis: 1,
  slice_planning: 2,
  functional_spec: 3,
  technical_spec: 4,
  architecture: 5,
  api_spec: 6,
  database_spec: 7,
  ui_spec: 8,
  task_planning: 9
};

/** N1 决策（docs/115 §N1）：阶段级墙钟上限与重试的默认值。 */
const DEFAULT_STAGE_TIMEOUT_MS = 150_000;
const DEFAULT_STAGE_RETRIES = 1;

/**
 * F1-4：最终切片超限（enforce）时的 LLM 压缩提示——进入修复轮的追加指令。
 * 口径：压缩不增删 AC 映射（任务集收敛、映射关系保持）。
 */
const FINAL_SLICE_COMPRESSION_PROMPT =
  "The previous attempt exceeded the final-slice task limit. Compress the plan: merge or drop non-essential work while keeping every acceptance-criteria mapping unchanged — do NOT add or remove AC mappings.";

const PlanningStateAnnotation = Annotation.Root({
  requirement: Annotation<Requirement>(),
  providedTechnicalDocs: Annotation<ProvidedTechnicalDocument[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  providedUiReferences: Annotation<ProvidedUiReference[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  conflictResolutions: Annotation<ProvidedConflictResolution[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  projectId: Annotation<string>(),
  requirementId: Annotation<string>(),
  requirementAnalysis: Annotation<PlanningState["requirementAnalysis"]>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  functionalSpec: Annotation<PlanningState["functionalSpec"]>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  technicalSpec: Annotation<PlanningState["technicalSpec"]>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  architectureSpec: Annotation<PlanningState["architectureSpec"]>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  apiSpec: Annotation<PlanningState["apiSpec"]>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  databaseSpec: Annotation<PlanningState["databaseSpec"]>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  uiSpec: Annotation<PlanningState["uiSpec"]>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  slice: Annotation<PlanningState["slice"]>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  slicePlan: Annotation<PlanningState["slicePlan"]>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  taskPlan: Annotation<PlanningState["taskPlan"]>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  validationErrors: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  currentStage: Annotation<PlanningStage>({
    reducer: (_left, right) => right,
    default: () => "requirement_analysis"
  }),
  status: Annotation<PlanningState["status"]>({
    reducer: (_left, right) => right,
    default: () => "running"
  })
});

type GraphState = typeof PlanningStateAnnotation.State;
type GraphUpdate = typeof PlanningStateAnnotation.Update;

function eventPayload(payload: Record<string, unknown>): JsonObject {
  const sanitized = sanitizeLogData(payload);
  return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)
    ? (sanitized as JsonObject)
    : {};
}

function zodErrors(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${field}: ${issue.message}`;
  });
}

function mergeSignals(parent: AbortSignal | undefined, controller: AbortController): AbortSignal {
  if (!parent) {
    return controller.signal;
  }

  if (parent.aborted) {
    controller.abort();
  } else {
    parent.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return controller.signal;
}

/** 第二级：把切片范围注入阶段提示词（同一切片的全部阶段共享同一 scope 行）。 */
function withSliceScope(prompt: string, slice: PlanningSliceScope | undefined): string {
  if (!slice) {
    return prompt;
  }

  return [
    prompt,
    `Scope: implement ONLY the slice ${slice.key} (${slice.title}). Goal: ${slice.goal}. Covered FRs: ${slice.frKeys.join(", ")}.`
  ].join("\n");
}

function promptForAttempt(basePrompt: string, validationErrors: string[]): string {
  if (validationErrors.length === 0) {
    return basePrompt;
  }

  return [basePrompt, REPAIR_PROMPT, `Validation Errors:\n${validationErrors.join("\n")}`].join(
    "\n\n"
  );
}

function inputForStage(state: GraphState): JsonObject {
  return {
    slice: state.slice ?? null,
    requirement: {
      id: state.requirement.id,
      projectId: state.projectId,
      title: state.requirement.title,
      description: state.requirement.description,
      rawContent: state.requirement.rawContent,
      version: state.requirement.version
    },
    // 与 rawContent **并列**、绝不合并：rawContent 是 AC/FR 解析器的唯一输入。
    providedTechnicalDocs: state.providedTechnicalDocs ?? [],
    providedUiReferences: state.providedUiReferences ?? [],
    conflictResolutions: state.conflictResolutions ?? [],
    requirementAnalysis: state.requirementAnalysis,
    functionalSpec: state.functionalSpec,
    technicalSpec: state.technicalSpec,
    architectureSpec: state.architectureSpec,
    apiSpec: state.apiSpec,
    databaseSpec: state.databaseSpec,
    uiSpec: state.uiSpec
  };
}

function assertComplete(
  state: GraphState,
  skipUi: boolean,
  skipDatabase: boolean
): PlanningGraphResult {
  const missing: string[] = [];
  if (!state.requirementAnalysis) missing.push("requirementAnalysis");
  if (!state.functionalSpec) missing.push("functionalSpec");
  if (!state.technicalSpec) missing.push("technicalSpec");
  if (!state.architectureSpec) missing.push("architectureSpec");
  if (!state.apiSpec) missing.push("apiSpec");
  if (!state.databaseSpec && !skipDatabase) missing.push("databaseSpec");
  if (!state.uiSpec && !skipUi) missing.push("uiSpec");
  if (!state.taskPlan) missing.push("taskPlan");

  if (missing.length > 0) {
    throw new PlanningValidationError("Planning graph ended without complete output", [
      `Missing planning outputs: ${missing.join(", ")}`
    ]);
  }

  return {
    requirementAnalysis: state.requirementAnalysis!,
    functionalSpec: state.functionalSpec!,
    technicalSpec: state.technicalSpec!,
    architectureSpec: state.architectureSpec!,
    apiSpec: state.apiSpec!,
    ...(state.databaseSpec ? { databaseSpec: state.databaseSpec } : {}),
    ...(state.uiSpec ? { uiSpec: state.uiSpec } : {}),
    taskPlan: state.taskPlan!,
    validationErrors: state.validationErrors
  };
}

async function emit(
  options: PlanningGraphOptions,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  await options.lifecycle?.onEvent?.({
    agentRunId: options.agentRunId,
    eventType,
    payload: eventPayload(payload)
  });
}

async function markIteration(options: PlanningGraphOptions, stage: PlanningStage): Promise<void> {
  await options.lifecycle?.onIteration?.({
    agentRunId: options.agentRunId,
    iteration: STAGE_ITERATIONS[stage],
    status: "running"
  });
}

async function generateWithRepair<TOutput extends JsonObject>(
  options: PlanningGraphOptions,
  state: GraphState,
  stage: PlanningStage,
  prompt: string,
  schema: z.ZodType<TOutput>,
  domainValidate?: (output: TOutput) => string[]
): Promise<TOutput> {
  const maxRetries = options.maxValidationRetries ?? 2;
  let validationErrors: string[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (options.signal?.aborted) {
      throw new Error("Planning run cancelled");
    }

    const output = await options.model.generateStructured({
      stage,
      prompt: promptForAttempt(prompt, validationErrors),
      schema,
      input: inputForStage(state),
      validationErrors,
      signal: options.signal,
      ...(options.onTokenUsage ? { onUsage: options.onTokenUsage } : {})
    });
    const parsed = schema.safeParse(output);

    if (parsed.success) {
      const domainErrors = domainValidate?.(parsed.data) ?? [];
      if (domainErrors.length === 0) {
        if (attempt > 0) {
          await emit(options, "PLANNING_REPAIR_COMPLETED", { stage, attempt });
        }
        return parsed.data;
      }
      validationErrors = domainErrors;
    } else {
      validationErrors = zodErrors(parsed.error);
    }

    await emit(options, "PLANNING_SCHEMA_VALIDATION_FAILED", {
      stage,
      attempt,
      validationErrors
    });

    if (attempt < maxRetries) {
      await emit(options, "PLANNING_REPAIR_REQUESTED", { stage, attempt: attempt + 1 });
    }
  }

  throw new PlanningValidationError(
    `Structured output validation failed at ${stage}`,
    validationErrors
  );
}

async function taskPlanWithDagRepair(
  options: PlanningGraphOptions,
  state: GraphState
): Promise<{ taskPlan: TaskPlan; acProtection: AcKeysPresenceResult["acProtection"] }> {
  const maxRetries = options.maxValidationRetries ?? 2;
  let validationErrors: string[] = [];
  // N3：PRD 编号 AC 的确定性解析（无编号形态 → 空）。
  const parsedCriteria = parseAcceptanceCriteriaFromPrd(state.requirement.rawContent ?? "");
  // F1-1（发现②）：编号解析为空时以 N3 库记录兜底（无编号 PRD 的 LLM 提取记录）；
  // 二者皆空 = 需求本身没有 AC 记录 —— 允许跳过，但必须显式标注 acProtection=none。
  const criteria =
    parsedCriteria.acs.length > 0 ? parsedCriteria.acs : (options.acceptanceCriteria ?? []);
  // F1-4：全局性 AC（Deploy/Doc 类验证）编号集——非最终切片归属守卫与最终切片规模度量的输入。
  const globalAcKeys = criteria.filter(isGlobalAcceptanceCriterion).map((ac) => ac.acKey);
  // F1-1/F1-4：切片范围选择（携带 isFinalSlice 时按全局性 AC 归属过滤：非最终剔除、最终并入）。
  const requiredCriteria = selectAcceptanceCriteriaForSlice(criteria, state.slice?.frKeys, {
    ...(options.isFinalSlice !== undefined ? { isFinalSlice: options.isFinalSlice } : {})
  });
  const acHint =
    requiredCriteria.length > 0
      ? [
          "Acceptance criteria coverage: the requirement defines numbered acceptance criteria.",
          `For every task provide acKeys: the subset of these numbers the task delivers: ${requiredCriteria
            .map((ac) => ac.acKey)
            .join(", ")}.`,
          "Every listed AC must be referenced by at least one task's acKeys; uncovered ACs fail the plan.",
          // N-30（`docs/213`）：`validateImplementationCoverage` **必然**要求这条，此前从未写进提示词
          // ⇒ 规划器只能靠猜，最终切片（全局性 AC 只归这里）连续三轮修复都无法收敛、整次运行止步。
          "Every Must AC must additionally be referenced by at least one implementation task (BACKEND, FRONTEND or DATABASE); TEST, REVIEW, BUILD and DEPLOY tasks do not satisfy this. For Must ACs about deployment, containers, logs or commands, add an implementation task that produces that artifact (for example a BACKEND task that writes the Dockerfile and runtime configuration) and list those AC numbers in its acKeys.",
          "Order tasks test-first: TEST tasks write tests named with their AC numbers (e.g. [AC-01]) and must precede implementation; every implementation task (BACKEND/FRONTEND/DATABASE) that delivers an AC must depend (directly or transitively) on the TEST task covering it, and every Must AC needs a TEST task."
        ].join(" ")
      : "";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const prompt = [
      taskPlanningPrompt({
        deliveryConfigured: options.deliveryConfigured,
        ...(options.isFinalSlice !== undefined ? { isFinalSlice: options.isFinalSlice } : {}),
        ...(options.profile ? { profile: options.profile } : {})
      }),
      ...(acHint !== "" ? [acHint] : []),
      ...(validationErrors.length > 0
        ? [REPAIR_PROMPT, `Validation Errors:\n${validationErrors.join("\n")}`]
        : []),
      ...(validationErrors.some((error) => error.includes("FINAL_SLICE_OVERLOAD"))
        ? [FINAL_SLICE_COMPRESSION_PROMPT]
        : [])
    ].join("\n\n");

    const taskPlan = await stageWithBudget(
      options,
      { ...state, validationErrors },
      "task_planning",
      prompt,
      TaskPlanSchema
    );
    // F1-2（发现①）：acKeys 确定性回填——LLM 引用只作参考（解析 / FR→AC 展开 / 范围回填），
    // 前后差异写入 PLAN_ACKEYS_BACKFILLED 事件；未知格式经 PLAN_ACKEYS_INVALID 进入修复轮。
    const backfill = backfillTaskPlanAcKeys({
      tasks: taskPlan.tasks,
      criteria,
      ...(state.slice ? { frKeys: state.slice.frKeys } : {}),
      ...(options.isFinalSlice !== undefined ? { isFinalSlice: options.isFinalSlice } : {})
    });
    for (const change of backfill.changes) {
      await emit(options, "PLAN_ACKEYS_BACKFILLED", {
        stage: "task_planning",
        attempt,
        taskId: change.taskId,
        before: change.before,
        after: change.after,
        ...(change.added.length > 0 ? { added: change.added } : {}),
        ...(change.expanded.length > 0 ? { expanded: change.expanded } : {}),
        ...(change.dropped.length > 0 ? { dropped: change.dropped } : {})
      });
    }
    // F1-3（发现③）：确定性自动修复层——LLM 修复循环之前，白名单内机械修复：
    // ① 测试先行依赖补边（成环不修、记录环路径）；② 最终切片 DEPLOY 交付块补全。
    // 只增依赖边、只补交付块字段：不增删任务、不改 AC 映射。
    const autoFix = autoFixTaskPlan({
      tasks: backfill.tasks,
      criteria,
      ...(state.slice ? { frKeys: state.slice.frKeys } : {}),
      ...(options.isFinalSlice !== undefined ? { isFinalSlice: options.isFinalSlice } : {}),
      ...(options.deliveryEnvironment !== undefined
        ? { deliveryEnvironment: options.deliveryEnvironment }
        : {})
    });
    for (const fix of autoFix.fixes) {
      await emit(options, "PLAN_AUTOFIXED", {
        stage: "task_planning",
        attempt,
        rule: fix.rule,
        taskId: fix.taskId,
        ...fix.detail
      });
    }
    for (const entry of autoFix.blocked) {
      await emit(options, "PLAN_AUTOFIXED", {
        stage: "task_planning",
        attempt,
        rule: entry.rule ?? "test-first-edge",
        status: "cycle-blocked",
        implementationTaskId: entry.implementationTaskId,
        testTaskId: entry.testTaskId,
        cyclePath: entry.cyclePath
      });
    }

    // N-43（`docs/232` §T4-9）：骨架先行契约——第一个切片的骨架任务必须**真正实现**它声明的每个脚本，
    // 而不只是把脚本名写进 `package.json`。实测：S1-T01 的 7 条 AC 全在描述清单字段，agent 就只写了
    // 清单；验证门按 BUILD 跑 `pnpm build`，脚本文件由 5 个任务之后才创建 ⇒ 首任务必然失败。
    // 契约写进 AC，是因为 AC 才是 agent 照着做的清单（`TaskContext` 原文进提示词）。
    const skeleton = repairSkeletonAcceptanceCriteria({
      tasks: autoFix.tasks,
      ...(options.isFirstSlice !== undefined ? { isFirstSlice: options.isFirstSlice } : {})
    });
    for (const repair of skeleton.repairs) {
      await emit(options, "PLAN_AUTOFIXED", {
        stage: "task_planning",
        attempt,
        rule: "skeleton-script-ac",
        taskId: repair.taskId,
        script: repair.script
      });
    }

    const plannedPlan: TaskPlan = { ...taskPlan, tasks: skeleton.tasks };
    const dag = validateTaskGraph(plannedPlan, {
      deliveryConfigured: options.deliveryConfigured,
      ...(options.isFinalSlice !== undefined ? { isFinalSlice: options.isFinalSlice } : {}),
      ...(options.isFinalSlice === false && globalAcKeys.length > 0 ? { globalAcKeys } : {})
    });
    const validationTasks = plannedPlan.tasks.map((task) => ({
      id: task.id,
      type: task.type,
      acKeys: task.acKeys,
      providesScripts: task.providesScripts,
      dependencies: task.dependencies
    }));
    const coverageErrors = validateAcceptanceCoverage({
      criteria,
      tasks: validationTasks,
      ...(state.slice ? { frKeys: state.slice.frKeys } : {}),
      ...(options.isFinalSlice !== undefined ? { isFinalSlice: options.isFinalSlice } : {})
    });
    // N4：测试先行顺序 + Must AC 测试覆盖（确定性；无 AC 记录时为空）。
    const testFirstErrors = validateTestFirstOrder({
      criteria,
      tasks: validationTasks,
      ...(state.slice ? { frKeys: state.slice.frKeys } : {})
    });
    const mustCoverageErrors = validateMustAcTestCoverage({
      criteria,
      tasks: validationTasks,
      ...(state.slice ? { frKeys: state.slice.frKeys } : {}),
      ...(options.isFinalSlice !== undefined ? { isFinalSlice: options.isFinalSlice } : {})
    });
    // PL-M1：Must AC 的实现覆盖（与上一条对称；只报错，交给修复轮重规划）。
    const implementationCoverageErrors = validateImplementationCoverage({
      criteria,
      tasks: validationTasks,
      ...(state.slice ? { frKeys: state.slice.frKeys } : {}),
      ...(options.isFinalSlice !== undefined ? { isFinalSlice: options.isFinalSlice } : {})
    });
    // docs/235 / l1-rv1：不可规划类型必须在计划期失败，不能拖到运行期 AgentRegistry。
    const plannableTypeErrors = validatePlannableTaskTypes({
      tasks: validationTasks,
      profile: options.profile ?? DEFAULT_CAPABILITY_PROFILE
    });
    const namedCheckErrors = validateNamedPlanChecks({
      items: plannedPlan.tasks,
      kind: "task"
    });
    const ackeysPresence = validateAcKeysPresence({
      tasks: validationTasks,
      inScopeCriteriaCount: requiredCriteria.length
    });
    // PL-M7 7a：非最终切片的任务**声明**的锚点必须落在切片范围内（硬错误，交给修复轮重规划）。
    const anchorErrors = validateTaskAnchors({
      criteria,
      tasks: validationTasks,
      ...(state.slice ? { frKeys: state.slice.frKeys } : {}),
      ...(options.isFinalSlice !== undefined ? { isFinalSlice: options.isFinalSlice } : {})
    });
    // PL-M7 7b：无锚点的 TEST 任务是**观察项**（不产生错误，见 docs/165 §2）——先积累实测证据，
    // 再据实测裁定是否收紧为硬错误。
    for (const finding of findUnanchoredTestTasks({
      criteria,
      tasks: validationTasks,
      ...(state.slice ? { frKeys: state.slice.frKeys } : {}),
      ...(options.isFinalSlice !== undefined ? { isFinalSlice: options.isFinalSlice } : {})
    })) {
      await emit(options, "PLAN_TEST_TASK_UNANCHORED", {
        stage: "task_planning",
        attempt,
        taskId: finding.taskId,
        inScope: finding.inScope
      });
    }
    // PL-M9 9b：脚本提供者守卫——TEST 任务必须（传递）依赖声明了 `test` script 的任务
    // （`docs/166` §3）。只报错、不自动造任务；补边已由 `autoFixTaskPlan` 规则 3 先行尝试。
    const scriptProviderErrors = validateScriptProviders({ tasks: validationTasks });
    // N-43：骨架契约的硬错误部分（同一脚本被两个任务声明）——补 AC 已在上面确定性完成。
    const skeletonErrors = validateSkeletonPlan({
      tasks: plannedPlan.tasks.map((task) => ({
        id: task.id,
        type: task.type,
        dependencies: task.dependencies,
        ...(task.providesScripts ? { providesScripts: task.providesScripts } : {}),
        acceptanceCriteria: task.acceptanceCriteria
      })),
      ...(options.isFirstSlice !== undefined ? { isFirstSlice: options.isFirstSlice } : {})
    });
    // F1-4：最终切片规模度量——observe 记录事件（默认）/ enforce 超限错误（FINAL_SLICE_OVERLOAD）。
    const finalScale =
      options.isFinalSlice === true
        ? measureFinalSliceScale({
            tasks: plannedPlan.tasks,
            globalAcKeys: requiredCriteria
              .filter(isGlobalAcceptanceCriterion)
              .map((ac) => ac.acKey),
            frCount: state.slice?.frKeys?.length ?? 0
          })
        : null;
    const overloadError = finalScale
      ? finalSliceOverloadError(finalScale, options.finalSliceMaxTasks)
      : null;
    const errors = [
      ...dag.errors,
      ...backfill.errors,
      ...coverageErrors,
      ...testFirstErrors,
      ...mustCoverageErrors,
      ...implementationCoverageErrors,
      ...plannableTypeErrors,
      ...namedCheckErrors,
      ...ackeysPresence.errors,
      ...anchorErrors,
      ...scriptProviderErrors,
      ...skeletonErrors,
      ...(overloadError !== null ? [overloadError] : [])
    ];

    await emit(options, "TASK_DAG_VALIDATION_STARTED", {
      stage: "task_planning",
      attempt,
      taskCount: taskPlan.tasks.length
    });

    if (errors.length === 0) {
      await emit(options, "TASK_DAG_GENERATED", {
        attempt,
        taskCount: plannedPlan.tasks.length,
        dependencyCount: dag.edges.length,
        roots: dag.roots,
        leaves: dag.leaves,
        autofixCount: autoFix.fixes.length,
        ...(skeleton.repairs.length > 0 ? { skeletonAcCount: skeleton.repairs.length } : {}),
        ...(autoFix.blocked.length > 0 ? { autofixBlockedCount: autoFix.blocked.length } : {}),
        ...(ackeysPresence.acProtection === "none" ? { acProtection: "none" } : {})
      });
      if (requiredCriteria.length > 0) {
        await emit(options, "AC_COVERAGE_VALIDATED", {
          stage: "task_planning",
          attempt,
          requiredCount: requiredCriteria.length,
          taskCount: plannedPlan.tasks.length
        });
      }
      if (finalScale !== null) {
        // F1-4 observe：只记录规模，不判失败（enforce 时携带阈值标记）。
        await emit(options, "FINAL_SLICE_SCALE_OBSERVED", {
          stage: "task_planning",
          attempt,
          mode: options.finalSliceMaxTasks === undefined ? "observe" : "enforce",
          ...finalScale,
          ...(options.finalSliceMaxTasks !== undefined
            ? { threshold: options.finalSliceMaxTasks }
            : {})
        });
      }
      if (ackeysPresence.acProtection === "none") {
        await emit(options, "AC_PROTECTION_NONE", {
          stage: "task_planning",
          acProtection: "none",
          reason: "no acceptance criteria in scope (no numbered PRD section, no stored AC records)"
        });
      }
      return { taskPlan: plannedPlan, acProtection: ackeysPresence.acProtection };
    }

    validationErrors = errors;
    await emit(options, "TASK_DAG_VALIDATION_FAILED", {
      attempt,
      errorCount: errors.length,
      validationErrors
    });

    if (attempt < maxRetries) {
      await emit(options, "PLANNING_REPAIR_REQUESTED", {
        stage: "task_planning",
        attempt: attempt + 1,
        validationErrors
      });
    }
  }

  throw new TaskGraphValidationError(validationErrors);
}

/**
 * N-52（`docs/232` §9.22）：阶段预算的取值规则——**只有 `task_planning` 认它自己的那一档**，
 * 其余阶段一律走通用 `stageTimeoutMs`。抽成纯函数是为了让这条规则可测：它决定「一次慢调用能烧多久」，
 * 写错方向会静默地把所有阶段的预算一起放大。
 */
export function stageBudgetMs(
  stage: PlanningStage,
  options: { stageTimeoutMs?: number; taskPlanningTimeoutMs?: number }
): number {
  if (stage === "task_planning" && options.taskPlanningTimeoutMs !== undefined) {
    return options.taskPlanningTimeoutMs;
  }
  return options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
}

async function stageWithBudget<TOutput extends JsonObject>(
  options: PlanningGraphOptions,
  state: GraphState,
  stage: PlanningStage,
  prompt: string,
  schema: z.ZodType<TOutput>,
  domainValidate?: (output: TOutput) => string[]
): Promise<TOutput> {
  const budgetMs = stageBudgetMs(stage, options);
  const retries = options.stageRetries ?? DEFAULT_STAGE_RETRIES;
  const scopedPrompt = withSliceScope(prompt, state.slice);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const signal = mergeSignals(options.signal, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, budgetMs);

    try {
      return await generateWithRepair(
        { ...options, signal },
        state,
        stage,
        scopedPrompt,
        schema,
        domainValidate
      );
    } catch (error) {
      if (timedOut) {
        await emit(options, "PLANNING_STAGE_TIMEOUT", {
          stage,
          attempt,
          budgetMs,
          willRetry: attempt < retries
        });
        if (attempt < retries) {
          continue;
        }
        throw new PlanningStageTimeoutError(stage, budgetMs, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Planning stage retry loop exhausted: ${stage}`);
}

function createStageNodeRunner(options: PlanningGraphOptions) {
  return async function stageNode<TOutput extends JsonObject>(
    state: GraphState,
    stage: PlanningStage,
    prompt: string,
    schema: z.ZodType<TOutput>,
    domainValidate?: (output: TOutput) => string[]
  ): Promise<TOutput> {
    await emit(options, `${STAGE_EVENTS[stage]}_STARTED`, { stage });
    const started = Date.now();
    const output = await stageWithBudget(options, state, stage, prompt, schema, domainValidate);
    await markIteration(options, stage);
    await emit(options, `${STAGE_EVENTS[stage]}_COMPLETED`, {
      stage,
      duration: Date.now() - started,
      status: "succeeded"
    });
    return output;
  };
}

/**
 * N2 第一级切片计划：生成 + 确定性覆盖检查（FR 全覆盖 / 无虚构 / 结构约束）。
 * 不通过 → 携覆盖错误重做（上限 2 次；关口 1 拒绝意见作为首次修复输入）；仍失败 → PlanningValidationError。
 */
async function slicePlanningWithCoverageRepair(
  options: PlanningGraphOptions,
  state: GraphState
): Promise<SlicePlan> {
  const maxRedos = options.maxValidationRetries ?? 2;
  const feedback = options.sliceFeedback?.trim() ?? "";
  let validationErrors: string[] = [];

  for (let attempt = 0; attempt <= maxRedos; attempt += 1) {
    if (options.signal?.aborted) {
      throw new Error("Planning run cancelled");
    }

    const profile = options.profile ?? DEFAULT_CAPABILITY_PROFILE;
    const prompt = [
      slicePlanningPrompt({ profile }),
      ...(feedback !== "" && attempt === 0
        ? [`Gate-1 reviewer feedback (fix the previous slice plan accordingly):\n${feedback}`]
        : []),
      ...(validationErrors.length > 0
        ? [REPAIR_PROMPT, `Coverage validation errors:\n${validationErrors.join("\n")}`]
        : [])
    ].join("\n\n");

    const slicePlan = await stageWithBudget(
      options,
      state,
      "slice_planning",
      prompt,
      SlicePlanSchema
    );
    const errors = validateSlicePlan({
      slicePlan,
      functionalRequirements: state.requirementAnalysis?.functionalRequirements ?? [],
      profile,
      providedUiReferences: options.providedUiReferences,
      ...(state.requirementAnalysis ? { requirementAnalysis: state.requirementAnalysis } : {})
    });

    if (errors.length === 0) {
      await emit(options, "SLICE_PLAN_GENERATED", {
        sliceCount: slicePlan.slices.length,
        milestoneCount: slicePlan.milestones.length
      });
      return slicePlan;
    }

    validationErrors = errors;
    await emit(options, "SLICE_PLAN_VALIDATION_FAILED", { attempt, validationErrors });
    if (attempt < maxRedos) {
      await emit(options, "SLICE_PLAN_REDO_REQUESTED", {
        attempt: attempt + 1,
        validationErrors
      });
    }
  }

  throw new PlanningValidationError("Slice plan coverage validation failed", validationErrors);
}

export async function runPlanningGraph(
  options: PlanningGraphOptions
): Promise<PlanningGraphResult> {
  const pipeline = options.pipeline ?? "full";
  const skipUi = pipeline === "level2" && (options.skipStages ?? []).includes("ui_spec");
  // G2（GX-06）：无数据层变更的切片跳过 database_spec 阶段（机制与 skipUi 同构）。
  const skipDatabase =
    pipeline === "level2" && (options.skipStages ?? []).includes("database_spec");
  const stageNode = createStageNodeRunner(options);

  if (pipeline === "level2" && !options.slice) {
    throw new PlanningValidationError("Level-2 planning requires a slice scope", ["Missing slice"]);
  }
  if (skipUi) {
    await emit(options, "SLICE_STAGE_SKIPPED", {
      stage: "ui_spec",
      slice: options.slice?.key ?? "",
      reason: "slice delivers no user-visible UI"
    });
  }
  if (skipDatabase) {
    await emit(options, "SLICE_STAGE_SKIPPED", {
      stage: "database_spec",
      slice: options.slice?.key ?? "",
      reason: "slice introduces no data-layer changes"
    });
  }

  // 指令式构图：把节点名联合放宽为 string，以支持按 pipeline 条件增删节点（langgraph 校验可达性）。
  const builder = new StateGraph(PlanningStateAnnotation) as StateGraph<
    typeof PlanningStateAnnotation,
    GraphState,
    GraphUpdate,
    string
  >;

  if (pipeline !== "level2") {
    builder.addNode(
      "analyzeRequirement",
      async (state): Promise<GraphUpdate> => ({
        currentStage: "requirement_analysis",
        requirementAnalysis: await stageNode(
          state,
          "requirement_analysis",
          requirementAnalysisPrompt(),
          RequirementAnalysisSchema
        )
      })
    );
  }
  builder.addNode(
    "functionalSpecNode",
    async (state): Promise<GraphUpdate> => ({
      currentStage: "functional_spec",
      functionalSpec: await stageNode(
        state,
        "functional_spec",
        FUNCTIONAL_SPEC_PROMPT,
        FunctionalSpecSchema
      )
    })
  );
  builder.addNode(
    "technicalSpecNode",
    async (state): Promise<GraphUpdate> => ({
      currentStage: "technical_spec",
      technicalSpec: await stageNode(
        state,
        "technical_spec",
        TECHNICAL_SPEC_PROMPT,
        TechnicalSpecSchema
      )
    })
  );
  builder.addNode(
    "architectureNode",
    async (state): Promise<GraphUpdate> => ({
      currentStage: "architecture",
      architectureSpec: await stageNode(
        state,
        "architecture",
        architecturePrompt({ profile: options.profile ?? DEFAULT_CAPABILITY_PROFILE }),
        ArchitectureSpecSchema
      )
    })
  );
  builder.addNode(
    "apiSpecNode",
    async (state): Promise<GraphUpdate> => ({
      currentStage: "api_spec",
      apiSpec: await stageNode(
        state,
        "api_spec",
        apiSpecPrompt({ profile: options.profile ?? DEFAULT_CAPABILITY_PROFILE }),
        ApiSpecSchema,
        (apiSpec) =>
          validateConsumedApiSpec({
            profile: options.profile ?? DEFAULT_CAPABILITY_PROFILE,
            apiSpec,
            providedTechnicalDocs: options.providedTechnicalDocs,
            requirement: options.requirement
          })
      )
    })
  );
  if (!skipDatabase) {
    builder.addNode(
      "databaseSpecNode",
      async (state): Promise<GraphUpdate> => ({
        currentStage: "database_spec",
        databaseSpec: await stageNode(
          state,
          "database_spec",
          DATABASE_SPEC_PROMPT,
          DatabaseSpecSchema
        )
      })
    );
  }
  if (!skipUi) {
    builder.addNode(
      "uiSpecNode",
      async (state): Promise<GraphUpdate> => ({
        currentStage: "ui_spec",
        uiSpec: await stageNode(
          state,
          "ui_spec",
          uiSpecPrompt(),
          UiSpecSchema,
          (uiSpec: UiSpecContent) =>
            validateVisualBaselineGaps({
              uiFacing: uiSpec.pages.length > 0,
              providedUiReferences: options.providedUiReferences,
              gaps: uiSpec.visualBaselineGaps
            })
        )
      })
    );
  }
  builder.addNode("taskPlanNode", async (state): Promise<GraphUpdate> => {
    await emit(options, "TASK_PLANNING_STARTED", { stage: "task_planning" });
    const started = Date.now();
    const planned = await taskPlanWithDagRepair(options, state);
    await markIteration(options, "task_planning");
    await emit(options, "TASK_PLANNING_COMPLETED", {
      stage: "task_planning",
      taskCount: planned.taskPlan.tasks.length,
      duration: Date.now() - started,
      status: "succeeded",
      ...(planned.acProtection === "none" ? { acProtection: "none" } : {})
    });
    return {
      currentStage: "task_planning",
      taskPlan: planned.taskPlan
    };
  });
  builder.addNode("validateSpecifications", async (state): Promise<GraphUpdate> => {
    const complete = assertComplete(state, skipUi, skipDatabase);
    const specificationCount = (complete.uiSpec ? 7 : 6) - (complete.databaseSpec ? 0 : 1);
    await emit(options, "SPEC_VALIDATION_STARTED", {
      specificationCount
    });
    const errors = validatePlanningSpecifications(complete);
    if (errors.length > 0) {
      await emit(options, "SPEC_VALIDATION_FAILED", { validationErrors: errors });
      throw new PlanningValidationError("Specification domain validation failed", errors);
    }
    await emit(options, "SPEC_VALIDATION_COMPLETED", {
      status: "succeeded",
      specificationCount
    });
    return {
      status: "succeeded",
      validationErrors: []
    };
  });

  if (pipeline === "level2") {
    builder.addEdge(START, "functionalSpecNode");
  } else {
    builder.addEdge(START, "analyzeRequirement");
    builder.addEdge("analyzeRequirement", "functionalSpecNode");
  }
  builder.addEdge("functionalSpecNode", "technicalSpecNode");
  builder.addEdge("technicalSpecNode", "architectureNode");
  builder.addEdge("architectureNode", "apiSpecNode");
  builder.addEdge(
    "apiSpecNode",
    skipDatabase ? (skipUi ? "taskPlanNode" : "uiSpecNode") : "databaseSpecNode"
  );
  if (!skipDatabase) {
    builder.addEdge("databaseSpecNode", skipUi ? "taskPlanNode" : "uiSpecNode");
  }
  if (!skipUi) {
    builder.addEdge("uiSpecNode", "taskPlanNode");
  }
  builder.addEdge("taskPlanNode", "validateSpecifications");
  builder.addEdge("validateSpecifications", END);

  const graph = builder.compile({ checkpointer: new MemorySaver() });

  const finalState = await graph.invoke(
    {
      requirement: options.requirement,
      providedTechnicalDocs: options.providedTechnicalDocs ?? [],
      providedUiReferences: options.providedUiReferences ?? [],
      conflictResolutions: options.conflictResolutions ?? [],
      projectId: options.requirement.projectId,
      requirementId: options.requirement.id,
      ...(options.seedAnalysis ? { requirementAnalysis: options.seedAnalysis } : {}),
      ...(options.slice ? { slice: options.slice } : {}),
      validationErrors: [],
      currentStage: pipeline === "level2" ? "functional_spec" : "requirement_analysis",
      status: "running"
    },
    { configurable: { thread_id: options.agentRunId } }
  );

  return assertComplete(finalState, skipUi, skipDatabase);
}

/** N2 第一级：requirement_analysis + slice_planning（覆盖检查重做 ≤2），产出切片计划。 */
export async function runLevel1PlanningGraph(
  options: PlanningGraphOptions
): Promise<PlanningLevel1Result> {
  const stageNode = createStageNodeRunner(options);

  const graph = new StateGraph(PlanningStateAnnotation)
    .addNode(
      "analyzeRequirement",
      async (state): Promise<GraphUpdate> => ({
        currentStage: "requirement_analysis",
        requirementAnalysis: await stageNode(
          state,
          "requirement_analysis",
          requirementAnalysisPrompt(),
          RequirementAnalysisSchema
        )
      })
    )
    .addNode("slicePlanningNode", async (state): Promise<GraphUpdate> => {
      await emit(options, "SLICE_PLANNING_STARTED", { stage: "slice_planning" });
      const started = Date.now();
      const slicePlan = await slicePlanningWithCoverageRepair(options, state);
      await markIteration(options, "slice_planning");
      await emit(options, "SLICE_PLANNING_COMPLETED", {
        stage: "slice_planning",
        sliceCount: slicePlan.slices.length,
        duration: Date.now() - started,
        status: "succeeded"
      });
      return {
        currentStage: "slice_planning",
        slicePlan
      };
    })
    .addEdge(START, "analyzeRequirement")
    .addEdge("analyzeRequirement", "slicePlanningNode")
    .addEdge("slicePlanningNode", END)
    .compile({ checkpointer: new MemorySaver() });

  const finalState = await graph.invoke(
    {
      requirement: options.requirement,
      providedTechnicalDocs: options.providedTechnicalDocs ?? [],
      providedUiReferences: options.providedUiReferences ?? [],
      conflictResolutions: options.conflictResolutions ?? [],
      projectId: options.requirement.projectId,
      requirementId: options.requirement.id,
      validationErrors: [],
      currentStage: "requirement_analysis",
      status: "running"
    },
    { configurable: { thread_id: options.agentRunId } }
  );

  if (!finalState.requirementAnalysis || !finalState.slicePlan) {
    throw new PlanningValidationError("Level-1 planning ended without complete output", [
      "Missing requirement analysis or slice plan"
    ]);
  }

  return {
    requirementAnalysis: finalState.requirementAnalysis,
    slicePlan: finalState.slicePlan,
    validationErrors: finalState.validationErrors
  };
}
