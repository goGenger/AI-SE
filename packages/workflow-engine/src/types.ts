import {
  Approval,
  ApiErrorBody,
  JsonObject,
  Task,
  TaskDependencyView,
  TaskStatus,
  WorkflowEvent,
  WorkflowRun,
  WorkflowStatus
} from "@ai-se/shared";

export interface WorkflowTaskPatch {
  status?: TaskStatus;
  assignedAgent?: string;
  output?: JsonObject;
  retryCount?: number;
  resolvedByTaskId?: string;
  failureHandled?: boolean;
  startedAt?: string;
  finishedAt?: string;
  clearClaim?: boolean;
  /** DEBUG 交接后纠正兄弟 REPLAN 的派发类型（taskflow-vue v8）。 */
  type?: Task["type"];
  title?: string;
  description?: string;
  input?: JsonObject;
}

export interface WorkflowRunPatch {
  status?: WorkflowStatus;
  output?: JsonObject;
  error?: ApiErrorBody;
  startedAt?: string;
  finishedAt?: string;
  /** retry 翻转 FAILED → RUNNING 时置 true:清空 error(否则 COALESCE 保留上次失败原因)。 */
  clearError?: boolean;
  /** retry 翻转时置 true:清空 finished_at(否则列表"用时"停留在上次失败时刻)。 */
  clearFinishedAt?: boolean;
}

export interface DynamicTaskInput {
  id: string;
  workflowRunId: string;
  projectId: string;
  requirementId: string;
  planTaskId?: string;
  taskKey: string;
  title: string;
  description: string;
  type: Task["type"];
  priority: Task["priority"];
  input: JsonObject;
  sourceTaskId: string;
  creationReason: string;
  approvalRequired: boolean;
}

export interface DynamicDependencyInput {
  sourceTaskId: string;
  targetTaskId: string;
}

export interface ReplanInput {
  workflowRunId: string;
  sourceTaskId: string;
  resolvedByTaskId: string;
  tasks: DynamicTaskInput[];
  dependencies: DynamicDependencyInput[];
  deactivateDependencyIds: string[];
}

/** T6：按工作流聚合的 agent run 用量（预算检查的输入，窄读、不新表）。 */
export interface WorkflowRunUsage {
  inputTokens: number;
  outputTokens: number;
  /** 全部 run 均无成本数据时为 null —— maxCostUsd 仅在存在成本数据时生效。 */
  estimatedCostUsd: number | null;
}

export interface WorkflowStore {
  findWorkflowById(id: string): Promise<WorkflowRun | null>;
  findWorkflowsByStatuses(statuses: WorkflowStatus[]): Promise<WorkflowRun[]>;
  updateWorkflow(
    id: string,
    expectedStatuses: WorkflowStatus[],
    patch: WorkflowRunPatch
  ): Promise<WorkflowRun | null>;
  /** T6：按 workflowRunId 聚合本工作流 agent run 的 token/成本。 */
  sumRunUsage(workflowRunId: string): Promise<WorkflowRunUsage>;
  /** T6：既有事件读（PAUSED/RESUMED 段推导 + 预算告警去重）。 */
  findEvents(workflowRunId: string): Promise<WorkflowEvent[]>;
  findTasks(workflowRunId: string): Promise<Task[]>;
  findDependencies(workflowRunId: string): Promise<TaskDependencyView[]>;
  updateTask(
    id: string,
    expectedStatuses: TaskStatus[],
    patch: WorkflowTaskPatch
  ): Promise<Task | null>;
  claimNextTask(workflowRunId: string, claimToken: string): Promise<Task | null>;
  claimFailureHandling(taskId: string): Promise<Task | null>;
  cancelNonTerminalTasks(workflowRunId: string): Promise<Task[]>;
  recoverRunningTasks(workflowRunId: string): Promise<number>;
  createApproval(workflowRunId: string, taskId: string, reason: string): Promise<Approval>;
  findApprovals(workflowRunId: string): Promise<Approval[]>;
  findApprovalById(id: string): Promise<Approval | null>;
  decideApproval(
    id: string,
    status: "APPROVED" | "REJECTED",
    comment: string
  ): Promise<Approval | null>;
  applyReplan(input: ReplanInput): Promise<void>;
  /**
   * Flip `task_dependencies.active` for existing rows (no insert).
   * Used to restore source→downstream edges when an exhausted REPLAN chain still
   * holds DYNAMIC outs after the source is retried or succeeds again.
   */
  setDependenciesActive(
    workflowRunId: string,
    updates: Array<{ id: string; active: boolean }>
  ): Promise<void>;
  createEvent(input: {
    workflowRunId: string;
    taskId?: string;
    agentRunId?: string;
    eventType: string;
    payload: JsonObject;
  }): Promise<WorkflowEvent>;
}

export interface TaskExecutionResult {
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  output?: JsonObject;
  error?: ApiErrorBody;
  agentRunId?: string;
  assignedAgent?: string;
}

/**
 * Phase 5.7-5: failure routing hook. When wired, the router decides the
 * recovery strategy per failure (RETRY / REPLAN keep the EXISTING chains;
 * HUMAN reuses the EXISTING WAITING_APPROVAL approval flow; FAIL terminates).
 * Returning `undefined` keeps the built-in workflow.policy strategy handling.
 * The hook receives only real persisted facts (task row incl. executor-written
 * output.recovery, workflow policy, approvals) — never agent self-reports.
 */
export interface FailureRouteInput {
  workflow: WorkflowRun;
  task: Task;
  approvals: Approval[];
}

export interface FailureRoute {
  strategy: "RETRY" | "REPLAN" | "ROLLBACK" | "CONTINUE" | "HUMAN" | "FAIL";
  reason?: string;
  failureClass?: string;
  stalled?: boolean;
  /** AFC-M2/M3：当前 executionAttempt（修复轮次记账，禁止无限套娃）。 */
  attempt?: number;
  /** AFC-M2/M5：一行证据摘要，供 FAILURE_ROUTED / UI 展示。 */
  evidenceSummary?: string;
  /** AFC-M2：结构化失败码（与 task.output.errorType 对齐）。 */
  errorType?: string;
  /** docs/253：自治路由给出的修复任务类型（如 DOCS_GAP→BUILD），供 replan 在 output 缺省时使用。 */
  fixTaskType?: string;
}

export type FailureRouter = (input: FailureRouteInput) => FailureRoute | undefined;

export interface WorkflowTaskExecutor {
  execute(workflow: WorkflowRun, task: Task): Promise<TaskExecutionResult>;
  cancel(task: Task): Promise<void>;
}
