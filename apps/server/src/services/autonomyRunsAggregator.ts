import type {
  JsonObject,
  Task,
  TaskStatus,
  WorkflowEvent,
  WorkflowRun,
  WorkflowStatus
} from "@ai-se/shared";

/** 自治闭环结果（相对「事件」页的 Phase 8 SRE 事件而言，这是工作流内修复环）。 */
export type AutonomyOutcome = "in_progress" | "repaired" | "exhausted" | "failed";

export interface AutonomyRepairTaskSummary {
  taskKey: string;
  title: string;
  type: string;
  status: TaskStatus;
  /** 诊断建议的修复类型（若有）。 */
  fixTaskType?: string | null;
  /** 是否出现过 REPLAN_TYPE_RETARGETED。 */
  typeRetargeted?: boolean;
}

export interface AutonomyRunRecord {
  /** `${workflowId}:${sourceTaskKey}` */
  id: string;
  triggeredAt: string;
  projectId: string;
  projectName: string | null;
  requirementId: string;
  requirementName: string | null;
  workflowId: string;
  workflowStatus: WorkflowStatus;
  planningVersion: number;
  sliceKey: string | null;
  sourceTaskKey: string;
  sourceTaskTitle: string;
  sourceTaskType: string;
  sourceTaskId: string;
  triggerReason: string | null;
  failureClass: string | null;
  errorType: string | null;
  diagnosisSummary: string | null;
  repairTasks: AutonomyRepairTaskSummary[];
  /** 当前/最近一轮（FAILURE_ROUTED.attempt + 1，或 REPLAN_STARTED 计数）。 */
  round: number | null;
  maxRetries: number | null;
  outcome: AutonomyOutcome;
  /** 控制台深链，形如 /workflows/:id */
  link: string;
}

export interface AutonomyAggregateWorkflowInput {
  workflow: WorkflowRun;
  projectName?: string | null;
  requirementName?: string | null;
  tasks: readonly Task[];
  events: readonly WorkflowEvent[];
}

const AUTONOMY_EVENT_TYPES = new Set([
  "FAILURE_ROUTED",
  "REPLAN_STARTED",
  "REPLAN_COMPLETED",
  "AUTO_RETRIED",
  "VERIFICATION_ENFORCED_FAILURE",
  "REPLAN_TYPE_RETARGETED"
]);

const DYNAMIC_KEY_SUFFIX = /-(DEBUG|REPLAN)-\d+$/;

/** 剥掉尾部 -DEBUG-N / -REPLAN-N，得到发起自治的源任务 key。 */
export function rootTaskKey(taskKey: string): string {
  let key = taskKey;
  while (DYNAMIC_KEY_SUFFIX.test(key)) {
    key = key.replace(DYNAMIC_KEY_SUFFIX, "");
  }
  return key;
}

export function isAutonomyDynamicTaskKey(taskKey: string): boolean {
  return DYNAMIC_KEY_SUFFIX.test(taskKey);
}

/** 避免 UI 出现 [object Object]；对象走 JSON。 */
export function sanitizeAutonomyText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const cleaned = value.replace(/\[object Object\]/g, "").replace(/\s+/g, " ").trim();
    return cleaned.length > 0 ? cleaned : null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    try {
      const text = JSON.stringify(value);
      return text && text !== "{}" ? text : null;
    } catch {
      return null;
    }
  }
  return String(value);
}

function payloadOf(event: WorkflowEvent): JsonObject {
  return (event.payload ?? {}) as JsonObject;
}

function payloadString(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function payloadNumber(payload: JsonObject, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isFailureResolved(
  task: Pick<Task, "status" | "resolvedByTaskId">,
  byId: Map<string, Task>
): boolean {
  if (task.status === "SUCCESS") return true;
  if (task.status !== "FAILED") return false;
  const seen = new Set<string>();
  let next = task.resolvedByTaskId;
  while (next && !seen.has(next)) {
    seen.add(next);
    const resolver = byId.get(next);
    if (!resolver) return false;
    if (resolver.status === "SUCCESS") return true;
    next = resolver.resolvedByTaskId;
  }
  return false;
}

function workflowIsActive(status: WorkflowStatus): boolean {
  return status === "RUNNING" || status === "PAUSED" || status === "WAITING_APPROVAL";
}

function lineageTasks(rootKey: string, tasks: readonly Task[]): Task[] {
  return tasks
    .filter((task) => task.taskKey === rootKey || task.taskKey.startsWith(`${rootKey}-`))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function extractFixTaskType(task: Task): string | null {
  const output = (task.output ?? {}) as JsonObject;
  const fromOutput = output.fixTaskType;
  if (typeof fromOutput === "string" && fromOutput.trim()) return fromOutput.trim();
  const input = (task.input ?? {}) as JsonObject;
  const fromInput = input.fixTaskType;
  if (typeof fromInput === "string" && fromInput.trim()) return fromInput.trim();
  return null;
}

function diagnosisFromLineage(tasks: readonly Task[]): string | null {
  const debugTasks = tasks
    .filter((task) => task.type === "DEBUG" || /-(DEBUG)-\d+$/.test(task.taskKey))
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const task of debugTasks) {
    const output = (task.output ?? {}) as JsonObject;
    const summary = sanitizeAutonomyText(output.summary);
    if (summary) return summary.length > 480 ? `${summary.slice(0, 479)}…` : summary;
  }
  return null;
}

function resolveOutcome(args: {
  workflowStatus: WorkflowStatus;
  source: Task;
  lineage: readonly Task[];
  routedEvents: readonly WorkflowEvent[];
  byId: Map<string, Task>;
}): AutonomyOutcome {
  const exhausted = args.routedEvents.some((event) => {
    const payload = payloadOf(event);
    const failureClass = payloadString(payload, "failureClass");
    const strategy = payloadString(payload, "strategy")?.toUpperCase() ?? "";
    const reason = payloadString(payload, "reason") ?? "";
    return (
      failureClass === "repair-exhausted" ||
      /Autonomy repair exhausted/i.test(reason) ||
      (strategy === "FAIL" && /repair exhausted/i.test(reason))
    );
  });
  if (exhausted) return "exhausted";

  const activeRepair = args.lineage.some(
    (task) =>
      isAutonomyDynamicTaskKey(task.taskKey) &&
      ["PENDING", "READY", "RUNNING", "RETRYING", "WAITING_APPROVAL"].includes(task.status)
  );
  if (workflowIsActive(args.workflowStatus) && activeRepair) return "in_progress";

  const hasRepairSuccess = args.lineage.some(
    (task) =>
      isAutonomyDynamicTaskKey(task.taskKey) &&
      /-(REPLAN)-\d+$/.test(task.taskKey) &&
      task.status === "SUCCESS"
  );
  const unresolvedDynamicFailure = args.lineage.some(
    (task) =>
      isAutonomyDynamicTaskKey(task.taskKey) &&
      task.status === "FAILED" &&
      !isFailureResolved(task, args.byId)
  );

  // 源失败已被后续 REPLAN 接替解决，且谱系里没有仍挂起的修复任务 / 未接替失败。
  if (
    !activeRepair &&
    !unresolvedDynamicFailure &&
    (hasRepairSuccess || isFailureResolved(args.source, args.byId))
  ) {
    return "repaired";
  }

  return "failed";
}

/**
 * 从单个工作流的任务 + 事件推导自治谱系记录。
 * 只读聚合：不写库、不造新事件。
 */
export function aggregateAutonomyRunsForWorkflow(
  input: AutonomyAggregateWorkflowInput
): AutonomyRunRecord[] {
  const { workflow, tasks, events } = input;
  if (tasks.length === 0 || events.length === 0) return [];

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const autonomyEvents = events.filter((event) => AUTONOMY_EVENT_TYPES.has(event.eventType));
  if (autonomyEvents.length === 0) {
    // 仍可能只有动态 DEBUG/REPLAN 任务（极端：事件被截断）；以任务为准兜底。
    const hasDynamic = tasks.some((task) => isAutonomyDynamicTaskKey(task.taskKey));
    if (!hasDynamic) return [];
  }

  const rootKeys = new Set<string>();
  for (const task of tasks) {
    if (isAutonomyDynamicTaskKey(task.taskKey)) rootKeys.add(rootTaskKey(task.taskKey));
  }
  for (const event of autonomyEvents) {
    if (event.taskId) {
      const task = byId.get(event.taskId);
      if (task) rootKeys.add(rootTaskKey(task.taskKey));
    }
    const payload = payloadOf(event);
    const sourceTaskId = payloadString(payload, "sourceTaskId");
    if (sourceTaskId) {
      const source = byId.get(sourceTaskId);
      if (source) rootKeys.add(rootTaskKey(source.taskKey));
    }
  }

  const retargetedTaskIds = new Set<string>();
  for (const event of events) {
    if (event.eventType !== "REPLAN_TYPE_RETARGETED") continue;
    if (event.taskId) retargetedTaskIds.add(event.taskId);
    const payload = payloadOf(event);
    const replanId = payloadString(payload, "replanTaskId");
    if (replanId) retargetedTaskIds.add(replanId);
  }

  const sliceKeyRaw = workflow.input?.sliceKey;
  const sliceKey = typeof sliceKeyRaw === "string" && sliceKeyRaw.trim() ? sliceKeyRaw : null;
  const maxRetries =
    typeof workflow.policy?.maxRetries === "number" ? workflow.policy.maxRetries : null;

  const records: AutonomyRunRecord[] = [];

  for (const rootKey of rootKeys) {
    const lineage = lineageTasks(rootKey, tasks);
    if (lineage.length === 0) continue;
    const source = lineage.find((task) => task.taskKey === rootKey) ?? lineage[0];

    const lineageIds = new Set(lineage.map((task) => task.id));
    const routed = autonomyEvents
      .filter(
        (event) =>
          event.eventType === "FAILURE_ROUTED" &&
          ((event.taskId && lineageIds.has(event.taskId)) ||
            (() => {
              const sid = payloadString(payloadOf(event), "sourceTaskId");
              return sid ? lineageIds.has(sid) : false;
            })())
      )
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // 没有 FAILURE_ROUTED / 动态修复任务则不算进入自治。
    const dynamicInLineage = lineage.filter((task) => isAutonomyDynamicTaskKey(task.taskKey));
    if (routed.length === 0 && dynamicInLineage.length === 0) continue;

    const firstRouted = routed[0];
    const latestRouted = routed[routed.length - 1];
    // 展示用：优先最近一次 REPLAN/耗尽，避免被中间的 provider RETRY 盖住失败类。
    const displayRouted =
      [...routed]
        .reverse()
        .find((event) => {
          const payload = payloadOf(event);
          const strategy = (payloadString(payload, "strategy") ?? "").toUpperCase();
          const failureClass = payloadString(payload, "failureClass");
          return (
            strategy === "REPLAN" ||
            strategy === "FAIL" ||
            failureClass === "repair-exhausted"
          );
        }) ?? latestRouted;
    const triggerPayload = firstRouted ? payloadOf(firstRouted) : {};
    const latestPayload = displayRouted ? payloadOf(displayRouted) : triggerPayload;

    const replanStarted = autonomyEvents.filter(
      (event) =>
        event.eventType === "REPLAN_STARTED" &&
        ((event.taskId && lineageIds.has(event.taskId)) ||
          (() => {
            const sid = payloadString(payloadOf(event), "sourceTaskId");
            return sid ? lineageIds.has(sid) : false;
          })())
    );

    const attempt =
      payloadNumber(latestPayload, "attempt") ??
      (firstRouted ? payloadNumber(triggerPayload, "attempt") : null);
    const round =
      attempt !== null ? attempt + 1 : replanStarted.length > 0 ? replanStarted.length : null;

    const triggeredAt =
      firstRouted?.createdAt ??
      dynamicInLineage[0]?.createdAt ??
      source.createdAt;

    const repairTasks: AutonomyRepairTaskSummary[] = dynamicInLineage.map((task) => {
      const fixTaskType = extractFixTaskType(task);
      const summary: AutonomyRepairTaskSummary = {
        taskKey: task.taskKey,
        title: task.title,
        type: task.type,
        status: task.status,
        typeRetargeted: retargetedTaskIds.has(task.id)
      };
      if (fixTaskType) summary.fixTaskType = fixTaskType;
      return summary;
    });

    const outcome = resolveOutcome({
      workflowStatus: workflow.status,
      source,
      lineage,
      routedEvents: routed,
      byId
    });

    records.push({
      id: `${workflow.id}:${rootKey}`,
      triggeredAt,
      projectId: workflow.projectId,
      projectName: input.projectName ?? null,
      requirementId: workflow.requirementId,
      requirementName: input.requirementName ?? null,
      workflowId: workflow.id,
      workflowStatus: workflow.status,
      planningVersion: workflow.planningVersion,
      sliceKey,
      sourceTaskKey: source.taskKey,
      sourceTaskTitle: source.title,
      sourceTaskType: source.type,
      sourceTaskId: source.id,
      triggerReason: sanitizeAutonomyText(
        payloadString(latestPayload, "reason") ?? payloadString(triggerPayload, "reason")
      ),
      failureClass:
        payloadString(latestPayload, "failureClass") ??
        payloadString(triggerPayload, "failureClass"),
      errorType:
        payloadString(latestPayload, "errorType") ?? payloadString(triggerPayload, "errorType"),
      diagnosisSummary: diagnosisFromLineage(lineage),
      repairTasks,
      round,
      maxRetries,
      outcome,
      link: `/workflows/${workflow.id}`
    });
  }

  return records.sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt));
}

/** 跨工作流聚合；调用方已筛好候选工作流。 */
export function aggregateAutonomyRuns(
  workflows: readonly AutonomyAggregateWorkflowInput[]
): AutonomyRunRecord[] {
  const all: AutonomyRunRecord[] = [];
  for (const item of workflows) {
    all.push(...aggregateAutonomyRunsForWorkflow(item));
  }
  return all.sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt));
}

export const AUTONOMY_TRIGGER_EVENT_TYPES = [
  "FAILURE_ROUTED",
  "REPLAN_STARTED",
  "REPLAN_COMPLETED",
  "AUTO_RETRIED",
  "VERIFICATION_ENFORCED_FAILURE",
  "REPLAN_TYPE_RETARGETED"
] as const;
