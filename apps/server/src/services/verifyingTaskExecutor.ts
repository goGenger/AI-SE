import {
  DEFAULT_CAPABILITY_PROFILE,
  isAutonomyAtLeastL1,
  JsonObject,
  Task,
  WorkflowRun,
  type CapabilityProfile
} from "@ai-se/shared";
import { TaskExecutionResult, WorkflowTaskExecutor } from "@ai-se/workflow-engine";
import {
  classifyAutonomyFailure,
  objectiveClosingOverride,
  resolveRepairFixTaskType
} from "./gateFailureRepair";
import {
  resolveTaskWorkspace,
  TaskVerifier,
  type ProtectedSnapshot,
  type TaskVerificationRecord
} from "./taskVerifier";
import {
  VERIFICATION_FAILED_ERROR_TYPE,
  isDevTaskType,
  type VerificationMode
} from "./taskVerifierRules";

/**
 * C-3（T1）验证门包装层（先例 `RoutingWorkflowTaskExecutor`）：
 * 先由内层执行器完成任务（自报），随后 TaskVerifier 按其类型做客观检查——
 *  - observe：完整执行检查并记录，不覆盖任务结果（对比用）；
 *  - enforce：verdict=failed 时覆盖自报 → 任务 FAILED + errorType=VERIFICATION_FAILED（走既有失败策略）。
 * 关闭（off）时不装配本包装层，行为与旧版一致。
 *
 * 自治 L1（L1-4）：模式**按工作流取**——L1 工作流一律 enforce（不论全局 `VERIFICATION_GATE`），
 * 非 L1 工作流沿用全局值。否则「L1 是否强制」会取决于一个全局开关，L1-4 的判据就不成立。
 *
 * AFC-M1（docs/250）：enforce 下即使 verifier 未标 failed，自报 SUCCESS 却含客观红证据
 * （TASK-06 类）也强制 FAILED，走既有 gateFailureRepair / REPLAN。
 *
 * DEBUG 例外（taskflow-vue v8）：诊断任务仍跑目标类型检查并记入 `verification`（N-15′ 证据面保留），
 * 但收尾按 **observe**——不得因产品 `npm test` / type-check 红而把诊断 SUCCESS 盖成
 * `VERIFICATION_FAILED`。否则 `-DEBUG-N` 失败会卡住依赖它的 `-REPLAN-N`（引擎依赖边），
 * 实现任务永远 PENDING。Agent 自身崩溃/超时仍由内层直接失败，不受本例外影响。
 */
export class VerifyingWorkflowTaskExecutor implements WorkflowTaskExecutor {
  constructor(
    private readonly verifier: TaskVerifier,
    private readonly inner: WorkflowTaskExecutor,
    private readonly mode: VerificationMode,
    private readonly profile: CapabilityProfile = DEFAULT_CAPABILITY_PROFILE
  ) {}

  private modeFor(workflow: WorkflowRun, task: Task): VerificationMode {
    // DEBUG = 诊断/交接节点：检查只观察，不盖成功→失败（见类注释）。
    if (task.type === "DEBUG") return "observe";
    return isAutonomyAtLeastL1(workflow.policy) ? "enforce" : this.mode;
  }

  async execute(workflow: WorkflowRun, task: Task): Promise<TaskExecutionResult> {
    const mode = this.modeFor(workflow, task);
    // 防篡改基线：dev 类任务执行前对受保护测试文件做哈希快照。
    let before: ProtectedSnapshot | undefined;
    if (isDevTaskType(task.type)) {
      before = await this.verifier.snapshotProtectedFiles(
        resolveTaskWorkspace(workflow, task),
        task
      );
    }
    // F2-1：写范围审计基线（observe/enforce 时捕获；非 git 工作区 → undefined，审计转 skipped）。
    const scopeBefore = await this.verifier.snapshotWriteScope(
      resolveTaskWorkspace(workflow, task),
      task
    );

    const result = await this.inner.execute(workflow, task);
    if (result.status !== "succeeded") {
      // DOCS_GAP / fixture etc.: agent-reported FAILED still needs fixTaskType on output
      // so WorkflowEngine.replan routes to BUILD/TEST instead of cloning FRONTEND.
      return this.enrichFailedResult(task, result);
    }

    let record: TaskVerificationRecord;
    try {
      record = await this.verifier.verify({ workflow, task, result, before, scopeBefore, mode });
    } catch (error) {
      record = {
        mode,
        verdict: "unavailable",
        verified: false,
        taskType: task.type,
        reason: `verifier error: ${error instanceof Error ? error.message : String(error)}`,
        checks: [],
        durationMs: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString()
      };
    }

    const output: JsonObject = {
      ...(result.output ?? {}),
      verification: record as unknown as JsonObject
    };

    if (mode === "enforce" && record.verdict === "failed") {
      // 依赖缺失等具体码优先于泛化的 VERIFICATION_FAILED，便于 REPLAN 归因与修复。
      const failureCode =
        typeof record.failureCode === "string" && record.failureCode.length > 0
          ? record.failureCode
          : VERIFICATION_FAILED_ERROR_TYPE;
      const existingFix =
        typeof output.fixTaskType === "string" && output.fixTaskType.length > 0
          ? output.fixTaskType
          : undefined;
      const failureClass = classifyAutonomyFailure({
        errorType: failureCode,
        summary: asString(output.summary) ?? record.reason,
        issues: output.issues,
        recommendations: output.recommendations,
        verification: output.verification as JsonObject | undefined,
        output: {
          ...output,
          summary: asString(output.summary) ?? record.reason
        }
      });
      const fixTaskType = resolveRepairFixTaskType({
        explicitFixTaskType: existingFix,
        profile: this.profile,
        taskType: task.type,
        failureClass,
        evidenceText: asString(output.summary) ?? record.reason
      });
      return {
        ...result,
        status: "failed",
        output: {
          ...output,
          errorType: failureCode,
          failureClass,
          ...(fixTaskType ? { fixTaskType } : {})
        },
        error: {
          code: failureCode,
          message: `Verification gate failed: ${record.reason ?? "objective checks failed"}`
        }
      };
    }

    // AFC-M1：自报 SUCCESS + 客观红证据（含 verifier unavailable 时仍承认失败的正文）→ 强制 FAILED。
    const closing = objectiveClosingOverride({
      taskType: task.type,
      mode,
      resultStatus: result.status,
      output,
      verificationVerdict: record.verdict,
      verificationFailureCode:
        typeof record.failureCode === "string" ? record.failureCode : undefined,
      verificationReason: record.reason,
      profile: this.profile
    });
    if (closing) {
      return {
        ...result,
        status: "failed",
        output: {
          ...output,
          errorType: closing.errorType,
          ...(closing.fixTaskType ? { fixTaskType: closing.fixTaskType } : {}),
          failureClass: closing.failureClass
        },
        error: {
          code: closing.errorType,
          message: closing.message
        }
      };
    }

    return { ...result, output };
  }

  cancel(task: Task): Promise<void> {
    return this.inner.cancel(task);
  }

  /**
   * docs/253–254：失败结果补齐 failureClass + fixTaskType（DOCS_GAP/ENV_GAP→BUILD 等），
   * 供 replan 读 output.fixTaskType；不覆盖 agent 已给出且能力面允许的显式值，
   * 但 DOCS_GAP / ENV_GAP 分类会压过错误的 FRONTEND（见 resolveRepairFixTaskType）。
   */
  private enrichFailedResult(task: Task, result: TaskExecutionResult): TaskExecutionResult {
    const output: JsonObject = { ...(result.output ?? {}) };
    const summary =
      asString(output.summary) ??
      (result.error && typeof result.error.message === "string" ? result.error.message : undefined);
    const errorType =
      asString(output.errorType) ??
      (result.error && typeof result.error.code === "string" ? result.error.code : undefined);
    const failureClass = classifyAutonomyFailure({
      errorType,
      summary,
      issues: output.issues,
      recommendations: output.recommendations,
      verification: output.verification as JsonObject | undefined,
      output
    });
    const existingFix =
      typeof output.fixTaskType === "string" && output.fixTaskType.length > 0
        ? output.fixTaskType
        : undefined;
    const fixTaskType = resolveRepairFixTaskType({
      explicitFixTaskType: existingFix,
      profile: this.profile,
      taskType: task.type,
      failureClass,
      evidenceText: summary
    });
    return {
      ...result,
      output: {
        ...output,
        failureClass,
        ...(fixTaskType ? { fixTaskType } : {})
      }
    };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
