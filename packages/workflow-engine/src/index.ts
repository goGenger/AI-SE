export { WorkflowEngine, computeBudgetWallClockMs, nextReplanKeyAttempt } from "./WorkflowEngine";
export { blockedTaskIds, readyTaskIds, validateWorkflowGraph } from "./scheduler";
/**
 * N-35（`docs/146`）：`apps/server` 的切片边界检查要复用这一个「已解决」判定，
 * 不再自己比 `status`——否则「replan 之后源任务行永远是 FAILED」会让边界检查整片不跑。
 */
export { countWorkflowTaskProgress, hasUnresolvedFailure, isFailureResolved, isSupersededBySuccessfulPredecessor, planSupersededReplanEdgeRestore, replanRootTaskKey, retryableFailedTasks, unresolvedFailedTasks } from "./resolution";
export {
  assertTaskTransition,
  assertWorkflowTransition,
  canTransitionTask,
  canTransitionWorkflow
} from "./stateMachine";
export type {
  DynamicDependencyInput,
  DynamicTaskInput,
  FailureRoute,
  FailureRouteInput,
  FailureRouter,
  ReplanInput,
  TaskExecutionResult,
  WorkflowRunPatch,
  WorkflowRunUsage,
  WorkflowStore,
  WorkflowTaskExecutor,
  WorkflowTaskPatch
} from "./types";
export { extractOfficialEvidenceFingerprint, extractOfficialGateFailureHint, formatOfficialGateFailureBriefing, mergeAcKeys, officialEvidenceFingerprintsEqual, stripOutputDurations, withOfficialFailedGateBriefing } from "./officialGateFailure";
export type { OfficialEvidenceFingerprint } from "./officialGateFailure";
