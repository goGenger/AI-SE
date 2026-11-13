import {
  JsonObject,
  Task,
  TaskDependencyView,
  TaskStatus,
  WorkflowEvent,
  WorkflowFailureStrategy,
  WorkflowStatus,
  WorkflowSummary
} from "@ai-se/shared";

const STATUS_LABELS: Record<WorkflowStatus, string> = {
  PENDING: "等待中",
  RUNNING: "运行中",
  PAUSED: "已暂停",
  WAITING_APPROVAL: "等待审批",
  SUCCESS: "成功",
  FAILED: "失败",
  CANCELLED: "已取消"
};

export function workflowStatusLabel(status: WorkflowStatus): string {
  return STATUS_LABELS[status] ?? status;
}

const STRATEGY_LABELS: Record<WorkflowFailureStrategy, string> = {
  FAIL_FAST: "快速失败",
  RETRY: "重试",
  CONTINUE: "继续",
  REPLAN: "重规划",
  ROLLBACK: "回滚部署"
};

export function failureStrategyLabel(strategy: WorkflowFailureStrategy): string {
  return STRATEGY_LABELS[strategy] ?? strategy;
}

const FAILURE_CLASS_LABELS: Record<string, string> = {
  GATE_FAILURE: "门禁失败",
  "gate-failure": "门禁失败",
  DEPENDENCIES_MISSING: "依赖/环境缺失",
  AGENT_TIMEOUT: "Agent 超时",
  INFRA_RETRY_EXHAUSTED: "基础设施重试耗尽",
  SPEC_CONFLICT: "规格冲突",
  TEST_FIXTURE_GAP: "测试夹具/装配缺口",
  DOCS_GAP: "文档/README 缺口",
  ENV_GAP: "环境/浏览器缺失",
  "repair-exhausted": "修复轮次耗尽"
};

export function autonomyFailureClassLabel(failureClass: string | undefined | null): string {
  if (!failureClass) return "未知失败类";
  return FAILURE_CLASS_LABELS[failureClass] ?? failureClass;
}


/** 展示值格式化：对象/数组 JSON 序列化，避免 String(obj) → "[object Object]"。 */
export function formatDisplayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

export interface AutonomyRepairProgress {
  /** 工作流仍在跑且最近一次 FAILURE_ROUTED 指向 REPLAN。 */
  active: boolean;
  /** 最近一次路由为 repair-exhausted / FAIL。 */
  exhausted: boolean;
  /** 修复轮次（FAILURE_ROUTED.attempt，缺省用 REPLAN 事件计数）。 */
  round: number | null;
  failureClass: string | null;
  evidenceLine: string | null;
  label: string;
}

/**
 * AFC-M5：从工作流事件推导自治修复进度（轮次 / 失败类 / 一行证据）。
 * 只读既有 FAILURE_ROUTED / REPLAN_* 事件，不新造状态机。
 */
export function deriveAutonomyRepairProgress(
  events: readonly WorkflowEvent[] | null | undefined,
  workflowStatus?: WorkflowStatus
): AutonomyRepairProgress | null {
  const list = events ?? [];
  const routed = [...list].reverse().find((event) => event.eventType === "FAILURE_ROUTED");
  if (!routed) return null;
  const payload = (routed.payload ?? {}) as JsonObject;
  const strategy = typeof payload.strategy === "string" ? payload.strategy.toUpperCase() : "";
  const failureClass =
    typeof payload.failureClass === "string" && payload.failureClass.length > 0
      ? payload.failureClass
      : null;
  const rawEvidence =
    (typeof payload.evidenceSummary === "string" && payload.evidenceSummary.trim()) ||
    (typeof payload.reason === "string" && payload.reason.trim()) ||
    null;
  const evidenceLine = rawEvidence
    ? rawEvidence.replace(/\[object Object\]/g, "").replace(/\s+/g, " ").trim() || null
    : null;
  const attempt =
    typeof payload.attempt === "number" && Number.isFinite(payload.attempt)
      ? payload.attempt
      : null;
  const replanCount = list.filter((event) => event.eventType === "REPLAN_STARTED").length;
  const round = attempt !== null ? attempt + 1 : replanCount > 0 ? replanCount : null;
  const exhausted =
    failureClass === "repair-exhausted" ||
    strategy === "FAIL" ||
    (typeof evidenceLine === "string" && /repair exhausted/i.test(evidenceLine));
  const running =
    workflowStatus === "RUNNING" ||
    workflowStatus === "WAITING_APPROVAL" ||
    workflowStatus === "PAUSED";
  const active = !exhausted && strategy === "REPLAN" && (running || workflowStatus === undefined);
  if (!active && !exhausted) return null;
  const classLabel = autonomyFailureClassLabel(failureClass);
  const label = exhausted
    ? `自治修复已耗尽（${classLabel}）`
    : round !== null
      ? `自治修复中 · 第 ${round} 轮 · ${classLabel}`
      : `自治修复中 · ${classLabel}`;
  return {
    active,
    exhausted,
    round,
    failureClass,
    evidenceLine,
    label
  };
}


/* ───────────────────────────────────────────────────────────────────────────
 * REPLAN 接替后的失败展示（与 workflow-engine isFailureResolved 同形）。
 *
 * 不改 DB 里的历史 task.status：FAILED 行仍是 FAILED，但展示/进度把它算作已解决。
 * web 不依赖 @ai-se/workflow-engine，故在此复制链判定；数据库列表进度走引擎导出。
 * ─────────────────────────────────────────────────────────────────────────── */

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  PENDING: "待处理",
  READY: "就绪",
  RUNNING: "运行中",
  WAITING_APPROVAL: "等待审批",
  SUCCESS: "成功",
  FAILED: "失败",
  RETRYING: "重试中",
  BLOCKED: "阻塞",
  CANCELLED: "已取消"
};

/** 沿 resolvedByTaskId 走到 SUCCESS ⇒ 该 FAILED 已被接替解决（同引擎口径）。 */
export function isTaskFailureResolved(
  task: Pick<Task, "status" | "resolvedByTaskId">,
  tasks: readonly Pick<Task, "id" | "status" | "resolvedByTaskId">[]
): boolean {
  if (task.status !== "FAILED") return false;
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
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

/**
 * 卡片徽章用的展示状态。
 * 被 REPLAN 链解决的 FAILED → 专用「已解决」（成功色），其余保持原 status。
 */
export type DisplayTaskStatus = TaskStatus | "RESOLVED";

export function displayTaskStatus(
  task: Pick<Task, "status" | "resolvedByTaskId">,
  tasks: readonly Pick<Task, "id" | "status" | "resolvedByTaskId">[]
): DisplayTaskStatus {
  if (isTaskFailureResolved(task, tasks)) return "RESOLVED";
  return task.status;
}

export function displayTaskStatusLabel(
  task: Pick<Task, "status" | "resolvedByTaskId">,
  tasks: readonly Pick<Task, "id" | "status" | "resolvedByTaskId">[]
): string {
  const display = displayTaskStatus(task, tasks);
  if (display === "RESOLVED") return "已解决";
  return TASK_STATUS_LABELS[display] ?? display;
}

export type DisplayTaskStatusTone =
  | "pending"
  | "running"
  | "warning"
  | "success"
  | "error"
  | "neutral";

const DISPLAY_TASK_STATUS_TONES: Record<TaskStatus, DisplayTaskStatusTone> = {
  PENDING: "pending",
  READY: "pending",
  RUNNING: "running",
  WAITING_APPROVAL: "warning",
  SUCCESS: "success",
  FAILED: "error",
  RETRYING: "running",
  BLOCKED: "warning",
  CANCELLED: "neutral"
};

export function displayTaskStatusTone(
  task: Pick<Task, "status" | "resolvedByTaskId">,
  tasks: readonly Pick<Task, "id" | "status" | "resolvedByTaskId">[]
): DisplayTaskStatusTone {
  const display = displayTaskStatus(task, tasks);
  if (display === "RESOLVED") return "success";
  return DISPLAY_TASK_STATUS_TONES[display];
}

/** 已解决失败的说明：「已由 TASK-09-REPLAN-1 解决」；未解决返回 null。 */
export function taskResolutionNote(
  task: Pick<Task, "status" | "resolvedByTaskId">,
  tasks: readonly Pick<Task, "id" | "status" | "resolvedByTaskId" | "taskKey">[]
): string | null {
  if (!isTaskFailureResolved(task, tasks)) return null;
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  let next = task.resolvedByTaskId;
  let successKey: string | undefined;
  while (next && !seen.has(next)) {
    seen.add(next);
    const resolver = byId.get(next);
    if (!resolver) break;
    if (resolver.status === "SUCCESS") {
      successKey = resolver.taskKey;
      break;
    }
    next = resolver.resolvedByTaskId;
  }
  return successKey ? `已由 ${successKey} 解决` : "已由后续任务解决";
}

/**
 * 详情进度：total = 全部任务；completed = SUCCESS + 已解决 FAILED。
 * 与列表服务端 countWorkflowTaskProgress / 引擎 isFailureResolved 对齐。
 */
export function workflowTaskProgress(
  tasks: readonly Pick<Task, "id" | "status" | "resolvedByTaskId">[]
): { completed: number; total: number } {
  let completed = 0;
  for (const task of tasks) {
    if (task.status === "SUCCESS") completed += 1;
    else if (isTaskFailureResolved(task, tasks)) completed += 1;
  }
  return { completed, total: tasks.length };
}

export function taskDependencies(task: Task, dependencies: TaskDependencyView[]): string[] {
  return dependencies
    .filter((dependency) => dependency.active !== false && dependency.targetTaskId === task.id)
    .map((dependency) => dependency.sourceTaskKey);
}

/**
 * 任务「当前/最近一次」Agent 运行 id。
 *
 * 任务 output.agentRunId 只在运行结束时写入 —— 重试/再次运行期间它仍指向上一次
 * （可能已失败的）运行，卡片上的跳转因此会与任务状态矛盾。快照事件里该任务最新
 * 带 agentRunId 的事件在运行中就有值，优先用它，output 仅作回退。
 */
export function taskAgentRunId(
  task: Pick<Task, "id" | "output">,
  events: readonly WorkflowEvent[]
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.taskId !== task.id) continue;
    if (typeof event.agentRunId === "string" && event.agentRunId) return event.agentRunId;
  }
  return typeof task.output?.agentRunId === "string" ? task.output.agentRunId : undefined;
}

export function canStart(status: WorkflowStatus): boolean {
  return status === "PENDING";
}

export function canPause(status: WorkflowStatus): boolean {
  return status === "RUNNING" || status === "WAITING_APPROVAL";
}

export function canResume(status: WorkflowStatus): boolean {
  return status === "PAUSED";
}

/** FAILED 工作流的人工重试出口；仅状态判定，不参与业务逻辑（与 canStart/canPause/canResume 同族）。 */
export function canRetry(status: WorkflowStatus): boolean {
  return status === "FAILED";
}

/**
 * WorkflowStatus → StatusBadge tone 的**纯展示映射**（Phase 7-B 新增）。
 *
 * 只读取既有 WorkflowStatus 枚举，不改变任何业务状态；
 * 与 canStart / canPause / canResume 等判定函数完全解耦（tone 不参与任何业务逻辑）。
 * 语义与 6-B 的 taskStatusTone 保持一致：进行中=info、待执行=中性、
 * 等待审批=warning、失败=error、结束/取消/暂停=中性。
 */
export type WorkflowStatusTone =
  | "pending"
  | "running"
  | "warning"
  | "success"
  | "error"
  | "neutral";

const WORKFLOW_STATUS_TONES: Record<WorkflowStatus, WorkflowStatusTone> = {
  PENDING: "pending",
  RUNNING: "running",
  PAUSED: "neutral",
  WAITING_APPROVAL: "warning",
  SUCCESS: "success",
  FAILED: "error",
  CANCELLED: "neutral"
};

export function workflowStatusTone(status: WorkflowStatus): WorkflowStatusTone {
  return WORKFLOW_STATUS_TONES[status];
}

/**
 * Empty input means "let the server use its default" — omit the field entirely.
 * Browser drag-and-drop / copy from the address bar inserts `file:///…` URLs;
 * convert them to the plain local path the server expects (`%20` → space too).
 */
export function normalizeWorkspacePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const pathname = new URL(trimmed).pathname;
      if (pathname) return decodeURIComponent(pathname);
    } catch {
      // Not a parseable file URL — fall through and keep the raw value.
    }
  }
  return trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// UX-02 — Workflow Context & Timeline（纯展示逻辑，可单测）
// ─────────────────────────────────────────────────────────────────────────────

/** 进度："3 / 10"；无任务时 "—"。只消费服务端计数，不产生新的 Progress Entity。 */
export function workflowProgressLabel(completed: number, total: number): string {
  return total > 0 ? `${completed} / ${total}` : "—";
}

/** 列表 / 详情行紧凑时间："09-16 14:03"。 */
export function workflowTimeLabel(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

/** 时间线事件时间："09-16 14:03:56"。 */
export function eventTimeLabel(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

/** 毫秒 → 紧凑用时文案：<1s / 12s / 3m 05s / 1h 20m（追踪节点直接拿到毫秒，TF-M1 起复用）。 */
export function durationLabel(ms: number): string {
  if (ms < 1000) return "<1s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** 用时：<1s / 12s / 3m 05s / 1h 20m；未结束时返回「进行中」。 */
export function workflowDurationLabel(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return "—";
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return "—";
  if (!finishedAt) return "进行中";
  const finished = new Date(finishedAt).getTime();
  if (Number.isNaN(finished) || finished < started) return "—";
  return durationLabel(finished - started);
}

/** UX-02：列表筛选谓词（纯函数，可单测）。空值表示"全部"。 */
export function filterWorkflows<T extends { projectId: string; status: WorkflowStatus }>(
  items: T[],
  filter: { projectId?: string; status?: string }
): T[] {
  return items.filter(
    (item) =>
      (!filter.projectId || item.projectId === filter.projectId) &&
      (!filter.status || item.status === filter.status)
  );
}

export type WorkflowEventTone = "running" | "success" | "error" | "warning" | "neutral";

export interface WorkflowEventDetail {
  label: string;
  value: string;
}

export interface WorkflowEventView {
  /** 一句可读的业务描述（非原始 eventType）。 */
  summary: string;
  tone: WorkflowEventTone;
  taskId?: string;
  taskTitle?: string;
  agentName?: string;
  /** 关联 AgentRun（事件载荷或任务 output 中的 agentRunId）——用于跳转。 */
  agentRunId?: string;
  /** 按事件类型裁剪出的详情行（失败原因 / Attempt / Recovery / 环境等）。 */
  details: WorkflowEventDetail[];
}

export interface WorkflowEventContext {
  tasks?: Task[];
  /** workflow.policy.maxRetries — 用于 "2 / 3" 形式的 Attempt 展示。 */
  maxRetries?: number;
}

const ROUTE_STRATEGY_LABELS: Record<string, string> = {
  RETRY: "重试",
  REPLAN: "重规划",
  DEBUG: "创建诊断任务",
  HUMAN: "人工介入",
  FAIL: "终止",
  ROLLBACK: "回滚",
  CONTINUE: "继续"
};

function shortId(id: string): string {
  return id.slice(0, 8);
}

function payloadString(payload: JsonObject, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function payloadNumber(payload: JsonObject, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" ? value : undefined;
}

function payloadObject(payload: JsonObject, key: string): JsonObject | undefined {
  const value = payload[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function statusTone(value?: string): WorkflowEventTone {
  if (!value) return "neutral";
  const upper = value.toUpperCase();
  if (
    upper === "SUCCESS" ||
    upper === "COMPLETED" ||
    upper === "ROLLED_BACK" ||
    upper === "SUCCEEDED"
  )
    return "success";
  if (upper === "FAILED" || upper === "ERROR" || upper === "ROLLBACK_FAILED") return "error";
  if (upper === "TIMED_OUT" || upper === "TIMEOUT") return "warning";
  if (upper === "CANCELLED" || upper === "SKIPPED") return "neutral";
  return "running";
}

/**
 * 事件 → 时间线展示模型（UX-02）。仅做展示映射：
 * 读取既有事件载荷 / 任务字段，不新增事件模型、不改动 Workflow Engine。
 */
export function workflowEventView(
  event: WorkflowEvent,
  context: WorkflowEventContext = {}
): WorkflowEventView {
  const payload = (event.payload ?? {}) as JsonObject;
  const task = context.tasks?.find((item) => item.id === event.taskId);
  const output = (task?.output ?? {}) as JsonObject;
  const taskTitle = task?.title;
  const taskRef = taskTitle
    ? `「${taskTitle}」`
    : event.taskId
      ? `任务 ${shortId(event.taskId)}`
      : "";
  const agentName = task?.assignedAgent;
  const agentPrefix = agentName ? `${agentName} ` : "";
  const details: WorkflowEventDetail[] = [];
  const push = (label: string, value: unknown): void => {
    if (value === undefined || value === null || value === "") return;
    const formatted = formatDisplayValue(value);
    if (formatted === "") return;
    details.push({ label, value: formatted });
  };

  const errorMessage =
    payloadString(payload, "message") ??
    (typeof output.error === "string" ? output.error : undefined) ??
    (typeof output.summary === "string" ? output.summary : undefined);

  let summary: string;
  let tone: WorkflowEventTone = "neutral";

  switch (event.eventType) {
    case "WORKFLOW_CREATED": {
      summary = "工作流已创建";
      const version = payloadNumber(payload, "planningVersion");
      push("规划版本", version === undefined ? undefined : `v${version}`);
      break;
    }
    case "WORKFLOW_STARTED":
      summary = "工作流已启动";
      tone = "running";
      break;
    case "WORKFLOW_PAUSED":
      summary = "工作流已暂停";
      break;
    case "WORKFLOW_RESUMED":
      summary = "工作流已恢复运行";
      tone = "running";
      break;
    case "WORKFLOW_CANCELLED":
      summary = "工作流已取消";
      break;
    case "WORKFLOW_COMPLETED":
      summary = "工作流已完成";
      tone = "success";
      break;
    case "WORKFLOW_FAILED":
      summary = errorMessage ? `工作流失败：${errorMessage}` : "工作流失败";
      tone = "error";
      push("错误码", payloadString(payload, "code"));
      break;
    case "WORKFLOW_TASK_FAILED":
      summary = "工作流因任务失败而终止";
      tone = "error";
      push("错误码", payloadString(payload, "code"));
      push("原因", errorMessage);
      break;
    case "TASK_READY":
      summary = `${taskRef || "任务"}已就绪`;
      break;
    case "TASK_STARTED": {
      const retryCount = payloadNumber(payload, "retryCount") ?? task?.retryCount ?? 0;
      summary = `${agentPrefix}开始执行${taskRef || "任务"}`;
      if (retryCount > 0) summary += `（重试第 ${retryCount} 次）`;
      tone = "running";
      break;
    }
    case "TASK_COMPLETED":
      summary = `${agentPrefix}完成${taskRef || "任务"}`;
      tone = "success";
      break;
    case "TASK_FAILED": {
      // 任务失败 ≠ Agent 失败：run 可能成功而任务判定失败。摘要以任务为主体，
      // Agent 放到明细行，原因保留（payload message → 任务结果摘要）。
      summary = `${taskRef || "任务"}执行失败`;
      tone = "error";
      push("执行 Agent", agentName);
      push("错误类型", payloadString(payload, "errorCode"));
      push("原因", errorMessage);
      const attempt = task?.retryCount;
      push(
        "尝试",
        attempt === undefined
          ? undefined
          : context.maxRetries === undefined
            ? `${attempt}`
            : `${attempt} / ${context.maxRetries}`
      );
      break;
    }
    case "TASK_RETRYING": {
      const retryCount = payloadNumber(payload, "retryCount");
      summary = `${taskRef || "任务"}进入重试${
        retryCount === undefined ? "" : `（第 ${retryCount} 次）`
      }`;
      tone = "warning";
      break;
    }
    case "TASK_BLOCKED":
      summary = `${taskRef || "任务"}被阻塞`;
      tone = "warning";
      break;
    case "TASK_CANCELLED":
      summary = `${taskRef || "任务"}已取消`;
      break;
    case "TASK_EXECUTION_ERROR":
      summary = `${taskRef || "任务"}执行错误`;
      tone = "error";
      push("错误类型", payloadString(payload, "errorCode"));
      push("原因", errorMessage);
      break;
    case "TASK_CREATED":
      summary = `${taskRef || "任务"}已创建`;
      push("原因", payloadString(payload, "reason"));
      push("来源任务", task?.sourceTaskId ? shortId(task.sourceTaskId) : undefined);
      break;
    case "REPLAN_STARTED":
      summary = "开始重规划";
      tone = "warning";
      push("源任务", event.taskId ? shortId(event.taskId) : undefined);
      break;
    case "REPLAN_COMPLETED": {
      summary = "重规划完成";
      const dynamicIds = payload.dynamicTaskIds;
      push("新增动态任务", Array.isArray(dynamicIds) ? dynamicIds.length : undefined);
      break;
    }
    case "REPLAN_VALIDATION_ERROR":
      summary = "重规划校验失败";
      tone = "error";
      push("原因", errorMessage);
      break;
    case "FAILURE_ROUTED": {
      const strategy = payloadString(payload, "strategy");
      const strategyLabel = strategy
        ? (ROUTE_STRATEGY_LABELS[strategy.toUpperCase()] ?? strategy)
        : undefined;
      const failureClass = payloadString(payload, "failureClass");
      summary = strategyLabel ? `失败已路由：${strategyLabel}` : "失败已路由";
      if (failureClass === "repair-exhausted") {
        summary = "自治修复已耗尽";
        tone = "error";
      } else {
        tone = "warning";
      }
      push("失败分类", failureClass ? autonomyFailureClassLabel(failureClass) : undefined);
      push(
        "轮次",
        typeof payload.attempt === "number" ? String(payload.attempt + 1) : undefined
      );
      push("证据", payloadString(payload, "evidenceSummary"));
      push("错误码", payloadString(payload, "errorType"));
      push("原因", payloadString(payload, "reason"));
      push("状态", payload.stalled === true ? "已停滞" : undefined);
      break;
    }
    case "FAILURE_HUMAN_REQUIRED":
      summary = "需要人工介入";
      tone = "warning";
      push("失败分类", payloadString(payload, "failureClass"));
      push("原因", payloadString(payload, "reason"));
      break;
    case "TASK_RETRY_REQUESTED": {
      summary = `${taskRef || "任务"}已重新排队`;
      tone = "warning";
      push("来源", payloadString(payload, "from") === "BLOCKED" ? "解除阻塞" : "失败重试");
      break;
    }
    case "WORKFLOW_RETRIED": {
      const retried = Array.isArray(payload.retriedTaskKeys) ? payload.retriedTaskKeys.length : 0;
      const requeued = Array.isArray(payload.requeuedTaskKeys)
        ? payload.requeuedTaskKeys.length
        : 0;
      summary = `工作流已重试（失败任务 ${retried} 个 / 解除阻塞 ${requeued} 个）`;
      tone = "warning";
      break;
    }
    case "ROLLBACK_TASK_CREATED":
      summary = `${taskRef || "任务"}已创建回滚任务`;
      push("环境", payloadString(payload, "environment"));
      break;
    case "ROLLBACK_NOT_SUPPORTED":
      summary = "当前失败不支持自动回滚";
      tone = "warning";
      break;
    case "ROLLBACK_VALIDATION_ERROR":
      summary = "回滚校验失败";
      tone = "error";
      push("原因", errorMessage);
      break;
    case "APPROVAL_REQUIRED":
      summary = `${taskRef || "任务"}需要人工审批`;
      tone = "warning";
      push("原因", payloadString(payload, "reason"));
      break;
    case "APPROVAL_GRANTED":
      summary = `${taskRef || "任务"}审批已通过`;
      tone = "success";
      push("备注", payloadString(payload, "comment"));
      break;
    case "APPROVAL_REJECTED":
      summary = `${taskRef || "任务"}审批已拒绝`;
      tone = "error";
      push("备注", payloadString(payload, "comment"));
      break;
    case "CI_STARTED":
      summary = "CI 已开始";
      tone = "running";
      push(
        "CI 运行",
        payloadString(payload, "ciRunId") ? shortId(payloadString(payload, "ciRunId")!) : undefined
      );
      break;
    case "CI_FINISHED": {
      const status = payloadString(payload, "status");
      summary = status ? `CI 结束：${status}` : "CI 已结束";
      tone = statusTone(status);
      push(
        "CI 运行",
        payloadString(payload, "ciRunId") ? shortId(payloadString(payload, "ciRunId")!) : undefined
      );
      break;
    }
    case "CI_FAILED":
      summary = "CI 失败";
      tone = "error";
      push("原因", errorMessage);
      break;
    case "CI_RELEASE_NOT_FOUND":
      summary = "未找到可用的 CI 发布";
      tone = "warning";
      break;
    case "DEPLOYMENT_STARTED": {
      const environment = payloadString(payload, "environment");
      summary = environment ? `开始部署到 ${environment}` : "开始部署";
      tone = "running";
      break;
    }
    case "DEPLOYMENT_FINISHED": {
      const status = payloadString(payload, "status");
      summary = status ? `部署结束：${status}` : "部署已结束";
      tone = statusTone(status);
      break;
    }
    case "DEPLOYMENT_FAILED":
      summary = "部署失败";
      tone = "error";
      push("原因", errorMessage);
      break;
    case "DEPLOYMENT_NOT_FOUND":
      summary = "未找到可回滚的部署记录";
      tone = "warning";
      break;
    case "DEPLOYMENT_ROLLBACK_FINISHED":
      summary = "部署回滚完成";
      tone = "warning";
      break;
    case "ROLLBACK_FAILED":
      summary = "回滚失败";
      tone = "error";
      push("原因", errorMessage);
      break;
    case "ROLLBACK_VERSION_NOT_FOUND":
      summary = "未找到可回滚的版本";
      tone = "warning";
      break;
    case "RELEASE_VERIFIED": {
      const environment = payloadString(payload, "environment");
      summary = environment ? `发布验证通过（${environment}）` : "发布验证通过";
      tone = "success";
      break;
    }
    // Agent 运行时事件（与引擎事件共用 workflow_events 时间线）
    case "agent_action": {
      const action = payloadString(payload, "action");
      summary = action ? `执行动作：${action}` : "已记录";
      break;
    }
    case "agent_final": {
      summary = "Agent 已输出最终结果";
      tone = statusTone(payloadString(payload, "status") ?? "succeeded");
      push("动作", payloadString(payload, "action"));
      push("迭代", payloadNumber(payload, "iteration"));
      break;
    }
    case "agent_run_created": {
      const agent = payloadString(payload, "agentName");
      const key = payloadString(payload, "taskKey");
      summary = agent ? `Agent ${agent} 已接手${key ? `任务 ${key}` : "任务"}` : "Agent 运行已创建";
      push("Agent 类型", payloadString(payload, "agentType"));
      break;
    }
    case "agent_run_started":
      summary = "Agent 运行已开始";
      tone = "running";
      push("最大迭代", payloadNumber(payload, "maxIterations"));
      break;
    case "agent_run_finished": {
      const status = payloadString(payload, "status");
      summary = status ? `Agent 运行结束：${status}` : "Agent 运行已结束";
      tone = statusTone(status);
      push("错误码", payloadString(payload, "errorCode"));
      push("迭代", payloadNumber(payload, "currentIteration"));
      break;
    }
    case "agent_resolved": {
      const agent = payloadString(payload, "agentName");
      summary = agent ? `已选定 Agent：${agent}` : "Agent 已确定";
      push("任务类型", payloadString(payload, "taskType"));
      const capabilities = payload.capabilities;
      push("能力", Array.isArray(capabilities) ? capabilities.join("、") : undefined);
      break;
    }
    case "agent_artifact_created": {
      const name = payloadString(payload, "name");
      summary = name ? `已产出工件「${name}」` : "产出物已创建";
      push("类型", payloadString(payload, "type"));
      break;
    }
    case "llm_retry":
      summary = "模型调用重试";
      tone = "warning";
      push("原因", payloadString(payload, "message"));
      push("错误码", payloadString(payload, "errorCode"));
      push("重试次数", payloadNumber(payload, "retryCount"));
      break;
    case "tool_call_started": {
      const tool = payloadString(payload, "toolName") ?? "工具";
      summary = `调用工具 ${tool}`;
      tone = "running";
      push("迭代", payloadNumber(payload, "iteration"));
      break;
    }
    case "tool_call_finished": {
      const tool = payloadString(payload, "toolName") ?? "工具";
      const status = payloadString(payload, "status");
      const nested = payloadObject(payload, "error");
      const failed = status === "failed" || status === "error" || !!nested;
      summary = failed ? `工具 ${tool} 调用失败` : `工具 ${tool} 调用完成`;
      tone = failed ? "error" : "success";
      push("状态", status);
      push("原因", nested ? payloadString(nested, "message") : undefined);
      push("错误码", nested ? payloadString(nested, "code") : undefined);
      const duration = payloadNumber(payload, "duration");
      push("耗时", duration === undefined ? undefined : `${duration}ms`);
      push("迭代", payloadNumber(payload, "iteration"));
      break;
    }
    default: {
      const nested = payloadObject(payload, "error");
      summary =
        payloadString(payload, "summary") ??
        payloadString(payload, "message") ??
        (nested ? payloadString(nested, "message") : undefined) ??
        "已记录";
      tone = nested ? "error" : statusTone(payloadString(payload, "status"));
      const state = payloadString(payload, "status") ?? payloadString(payload, "action");
      push("状态", state);
      push("错误码", nested ? payloadString(nested, "code") : undefined);
      break;
    }
  }

  const agentRunId =
    event.agentRunId ?? (typeof output.agentRunId === "string" ? output.agentRunId : undefined);

  return {
    summary,
    tone,
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(taskTitle ? { taskTitle } : {}),
    ...(agentName ? { agentName } : {}),
    ...(agentRunId ? { agentRunId } : {}),
    details
  };
}

/* ───────────────────────────────────────────────────────────────────────────
 * 仪表盘（W6）：需要人工关注 / 仍在推进的工作流计数与最近列表。
 *
 * 口径直接取自 `WorkflowStatus` 本身，不另立一套「健康度」概念：
 *   关注 = FAILED（失败）+ WAITING_APPROVAL（等待审批）+ PAUSED（已暂停）
 *   推进 = RUNNING（运行中）+ PENDING（等待中）
 * SUCCESS / CANCELLED 两者都不属于，因此不计入任何一个数字。
 * ─────────────────────────────────────────────────────────────────────────── */

/** 需要人工关注的工作流状态（失败 / 卡住）。 */
export const WORKFLOW_ATTENTION_STATUSES: readonly WorkflowStatus[] = [
  "FAILED",
  "WAITING_APPROVAL",
  "PAUSED"
];

/** 仍在推进的工作流状态。 */
export const WORKFLOW_ACTIVE_STATUSES: readonly WorkflowStatus[] = ["RUNNING", "PENDING"];

/** 统计处于给定状态之一的工作流数量。 */
export function countWorkflowsInStatus(
  workflows: WorkflowSummary[],
  statuses: readonly WorkflowStatus[]
): number {
  const wanted = new Set<WorkflowStatus>(statuses);
  return workflows.filter((workflow) => wanted.has(workflow.status)).length;
}

/** 最近创建的工作流（默认 5 条），与项目页的 `latestProjects` 同一口径。 */
export function latestWorkflows(workflows: WorkflowSummary[], limit = 5): WorkflowSummary[] {
  return [...workflows]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, limit);
}
