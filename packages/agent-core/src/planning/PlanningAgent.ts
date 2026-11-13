import {
  AcceptanceCriterion,
  ApiErrorBody,
  AgentRunStatus,
  JsonObject,
  ProvidedConflictResolution,
  ProvidedTechnicalDocument,
  ProvidedUiReference,
  Requirement,
  type CapabilityProfile
} from "@ai-se/shared";
import { AgentLifecycleHooks } from "../agent/AgentLifecycle";
import { addTokenUsage, PlanningModel } from "./PlanningModel";
import {
  PlanningStageTimeoutError,
  PlanningValidationError,
  runLevel1PlanningGraph,
  runPlanningGraph
} from "./PlanningGraph";
import {
  PlanningGraphResult,
  PlanningLevel1Result,
  PLANNING_STAGES,
  PlanningSliceScope,
  PlanningStage
} from "./PlanningState";
import { TaskGraphValidationError } from "./validateTaskGraph";

export interface PlanningAgentContext {
  requestId: string;
  projectId: string;
  requirementId: string;
  taskId: string;
  agentRunId: string;
}

export interface PlanningAgentOptions {
  model: PlanningModel;
  lifecycle?: AgentLifecycleHooks;
  afterGraph?: (result: PlanningGraphResult) => Promise<void>;
  /** N2 第一级完成后的持久化钩子（切片计划）。 */
  afterSlicePlan?: (result: PlanningLevel1Result) => Promise<void>;
  defaultTimeoutMs?: number;
  defaultMaxValidationRetries?: number;
  /** N2：full（默认，旧单级）/ level1（切片计划）/ level2（单切片第二级）。 */
  pipeline?: "full" | "level1" | "level2";
  /** 第二级切片范围（pipeline=level2）。 */
  slice?: PlanningSliceScope;
  /** 第二级跳过阶段（如纯后端切片跳过 ui_spec）。 */
  skipStages?: PlanningStage[];
  /** N3 库记录（F1-1）：规划图判定「需求是否有 AC 记录」的第二来源（编号解析为空时兜底）。 */
  acceptanceCriteria?: AcceptanceCriterion[];
  /** 第一级被关口 1 拒绝后的修改意见（重做切片计划）。 */
  sliceFeedback?: string;
  /** 第二级种子：已持久化的 requirement_analysis。 */
  seedAnalysis?: PlanningGraphResult["requirementAnalysis"];
  /** 阶段级预算与重试（N1 决策：默认 150s / 1；single 旧路径由调用方关闭）。 */
  stageTimeoutMs?: number;
  stageRetries?: number;
  /** N-52：`task_planning` 单独一档预算（缺省 = 沿用 `stageTimeoutMs`）。 */
  taskPlanningTimeoutMs?: number;
  /**
   * `docs/235` §6.5 / `docs/268`：能力 profile。影响任务规划可规划类型、切片 involvesData、
   * 以及规划合同注入与硬校验；缺省 = 产品默认 profile。
   */
  profile?: CapabilityProfile;
}

export interface PlanningAgentRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxValidationRetries?: number;
  /** 项目是否已绑定 Git 仓库；false 时规划期不生成 CI/部署任务。 */
  deliveryConfigured?: boolean;
  /** F1-3：当前切片是否最终切片（交付链归属校验 + 补块门控；仅二级规划传入）。 */
  isFinalSlice?: boolean;
  /** N-43：当前切片是否第一个切片（启用骨架先行契约；仅二级规划传入）。 */
  isFirstSlice?: boolean;
  /** F1-3：交付块补全环境（项目 deployment_environments；仅最终切片使用）。 */
  deliveryEnvironment?: string | null;
  /** F1-4：最终切片任务数上限（enforce；缺省 = observe 只记录不判失败）。 */
  finalSliceMaxTasks?: number;
  /** D1（`docs/229`）：用户提供的技术文档——权威输入，随规划状态传到每个阶段。 */
  providedTechnicalDocs?: ProvidedTechnicalDocument[];
  /** UI 参照图（intake）：可选视觉参照，随规划状态传到每个阶段。 */
  providedUiReferences?: ProvidedUiReference[];
  /** 人工冲突裁决：已落库决定，随规划状态传到每个阶段。 */
  conflictResolutions?: ProvidedConflictResolution[];
}

export interface PlanningAgentResult {
  agentRunId: string;
  requirementId: string;
  status: AgentRunStatus;
  output?: JsonObject;
  error?: ApiErrorBody;
  currentIteration: number;
  startedAt: string;
  finishedAt: string;
  duration: number;
  /**
   * N-25（`docs/206`）：本次规划 run 的累计用量（阶段调用 + 重采样累加）。
   * 形状与 `agent_runs.token_usage` 一致。缺省 = 一次模型调用都没有（`ScriptedPlanningModel`）。
   */
  tokenUsage?: JsonObject;
}

function mergeSignals(
  parentSignal: AbortSignal | undefined,
  controller: AbortController
): AbortSignal {
  if (!parentSignal) {
    return controller.signal;
  }

  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return controller.signal;
}

function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return { code, message, details };
}

function outputForSuccess(
  requirementId: string,
  taskCount: number,
  specificationCount: number
): JsonObject {
  return {
    finalResult: "Planning completed",
    requirementId,
    specificationCount,
    taskCount
  };
}

export class PlanningAgent {
  readonly name = "planning-agent";

  constructor(private readonly options: PlanningAgentOptions) {}

  async run(
    requirement: Requirement,
    context: PlanningAgentContext,
    runOptions: PlanningAgentRunOptions = {}
  ): Promise<PlanningAgentResult> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const timeoutMs = runOptions.timeoutMs ?? this.options.defaultTimeoutMs ?? 180_000;
    const controller = new AbortController();
    const signal = mergeSignals(runOptions.signal, controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    await this.options.lifecycle?.onRunStarted?.({
      agentRunId: context.agentRunId,
      taskId: context.taskId,
      projectId: context.projectId,
      startedAt,
      maxIterations: PLANNING_STAGES.length
    });
    await this.options.lifecycle?.onEvent?.({
      agentRunId: context.agentRunId,
      eventType: "PLANNING_STARTED",
      payload: {
        projectId: context.projectId,
        requirementId: context.requirementId
      }
    });

    // N-25：本 run 的累计用量。声明在 try 之外，**失败路径也要带上**——
    // 规划失败同样花了钱（判据 28b），把它丢掉会让守卫继续看不见这段支出。
    let tokenUsage: JsonObject | undefined;
    const onTokenUsage = (usage: JsonObject): void => {
      tokenUsage = addTokenUsage(tokenUsage ?? {}, usage);
    };

    try {
      if (signal.aborted) {
        throw new Error("Planning run cancelled");
      }

      const pipeline = this.options.pipeline ?? "full";
      let output: JsonObject;
      let iteration: number;

      if (pipeline === "level1") {
        const level1 = await runLevel1PlanningGraph({
          agentRunId: context.agentRunId,
          taskId: context.taskId,
          requirement,
          model: this.options.model,
          lifecycle: this.options.lifecycle,
          signal,
          maxValidationRetries:
            runOptions.maxValidationRetries ?? this.options.defaultMaxValidationRetries ?? 2,
          deliveryConfigured: runOptions.deliveryConfigured,
          providedTechnicalDocs: runOptions.providedTechnicalDocs,
          providedUiReferences: runOptions.providedUiReferences,
          conflictResolutions: runOptions.conflictResolutions,
          sliceFeedback: this.options.sliceFeedback,
          stageTimeoutMs: this.options.stageTimeoutMs,
          stageRetries: this.options.stageRetries,
          taskPlanningTimeoutMs: this.options.taskPlanningTimeoutMs,
          ...(this.options.profile ? { profile: this.options.profile } : {}),
          onTokenUsage
        });
        await this.options.afterSlicePlan?.(level1);
        output = {
          finalResult: "Slice plan completed",
          requirementId: context.requirementId,
          sliceCount: level1.slicePlan.slices.length
        };
        iteration = 2;
      } else {
        const graphResult = await runPlanningGraph({
          agentRunId: context.agentRunId,
          taskId: context.taskId,
          requirement,
          model: this.options.model,
          lifecycle: this.options.lifecycle,
          signal,
          maxValidationRetries:
            runOptions.maxValidationRetries ?? this.options.defaultMaxValidationRetries ?? 2,
          deliveryConfigured: runOptions.deliveryConfigured,
          providedTechnicalDocs: runOptions.providedTechnicalDocs,
          providedUiReferences: runOptions.providedUiReferences,
          conflictResolutions: runOptions.conflictResolutions,
          isFinalSlice: runOptions.isFinalSlice,
          isFirstSlice: runOptions.isFirstSlice,
          deliveryEnvironment: runOptions.deliveryEnvironment,
          finalSliceMaxTasks: runOptions.finalSliceMaxTasks,
          acceptanceCriteria: this.options.acceptanceCriteria,
          pipeline: pipeline === "level2" ? "level2" : "full",
          slice: this.options.slice,
          skipStages: this.options.skipStages,
          seedAnalysis: this.options.seedAnalysis,
          stageTimeoutMs: this.options.stageTimeoutMs,
          stageRetries: this.options.stageRetries,
          taskPlanningTimeoutMs: this.options.taskPlanningTimeoutMs,
          // `docs/235` §6.5：能力 profile 决定**任务规划阶段**的可规划类型清单。
          ...(this.options.profile ? { profile: this.options.profile } : {}),
          onTokenUsage
        });
        await this.options.afterGraph?.(graphResult);
        output = outputForSuccess(
          context.requirementId,
          graphResult.taskPlan.tasks.length,
          graphResult.uiSpec ? 7 : 6
        );
        iteration = PLANNING_STAGES.length;
      }

      const finished = Date.now();
      const finishedAt = new Date(finished).toISOString();

      await this.options.lifecycle?.onRunFinished?.({
        agentRunId: context.agentRunId,
        status: "succeeded",
        output,
        currentIteration: iteration,
        retryCount: 0,
        finishedAt,
        ...(tokenUsage ? { tokenUsage } : {})
      });
      await this.options.lifecycle?.onEvent?.({
        agentRunId: context.agentRunId,
        eventType: "PLANNING_COMPLETED",
        payload: output
      });

      return {
        agentRunId: context.agentRunId,
        requirementId: context.requirementId,
        status: "succeeded",
        output,
        currentIteration: iteration,
        startedAt,
        finishedAt,
        duration: finished - started,
        ...(tokenUsage ? { tokenUsage } : {})
      };
    } catch (error) {
      const finished = Date.now();
      const finishedAt = new Date(finished).toISOString();
      // N-51（`docs/232` §9.20 F4）：阶段墙钟耗尽与外层定时器是同一个失败类——都记
      // `timed_out` / `TIMEOUT_ERROR`，否则超时在账本上会伪装成 `PLANNING_ERROR`。
      const stageTimeout = error instanceof PlanningStageTimeoutError;
      const isTimeout = timedOut || stageTimeout;
      const status: AgentRunStatus = isTimeout
        ? "timed_out"
        : signal.aborted
          ? "cancelled"
          : "failed";
      const code = isTimeout
        ? "TIMEOUT_ERROR"
        : signal.aborted
          ? "CANCELLED_ERROR"
          : error instanceof PlanningValidationError || error instanceof TaskGraphValidationError
            ? "VALIDATION_ERROR"
            : "PLANNING_ERROR";
      const body = errorBody(code, error instanceof Error ? error.message : "Planning failed");

      await this.options.lifecycle?.onRunFinished?.({
        agentRunId: context.agentRunId,
        status,
        output: {
          finalResult: "",
          requirementId: context.requirementId,
          status
        },
        currentIteration: 0,
        retryCount: 0,
        error: body,
        finishedAt,
        // N-25：失败也花了钱——丢弃这一段会让守卫低估规划成本（判据 28b）。
        ...(tokenUsage ? { tokenUsage } : {})
      });
      await this.options.lifecycle?.onEvent?.({
        agentRunId: context.agentRunId,
        eventType: "PLANNING_FAILED",
        payload: {
          requirementId: context.requirementId,
          status,
          errorCode: body.code
        }
      });

      return {
        agentRunId: context.agentRunId,
        requirementId: context.requirementId,
        status,
        error: body,
        currentIteration: 0,
        startedAt,
        finishedAt,
        duration: finished - started,
        ...(tokenUsage ? { tokenUsage } : {})
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
