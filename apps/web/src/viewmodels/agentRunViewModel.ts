import {
  AgentRun,
  AgentRunDetailView,
  AgentRunStatus,
  JsonObject,
  Task,
  ToolCallAudit,
  ToolCallStatus,
  WorkflowEvent
} from "@ai-se/shared";
import {
  workflowEventView,
  type WorkflowEventDetail,
  type WorkflowEventTone
} from "./workflowViewModel";

export function agentStatusLabel(status: AgentRunStatus): string {
  const labels: Record<AgentRunStatus, string> = {
    created: "已创建",
    running: "运行中",
    succeeded: "已成功",
    failed: "失败",
    cancelling: "取消中",
    cancelled: "已取消",
    timed_out: "已超时"
  };

  return labels[status];
}

export function toolStatusLabel(tool: ToolCallAudit): string {
  if (tool.status === "failed") {
    return tool.error?.code ?? "失败";
  }

  return agentStatusLabel(tool.status === "timed_out" ? "timed_out" : tool.status);
}

export function isActiveRun(run: AgentRun): boolean {
  return ["created", "running", "cancelling"].includes(run.status);
}

/** UX-03：轨迹行内状态枚举 → 中文标签（枚举值不得原样渲染）。 */
export function toolCallStatusLabel(status: string): string {
  const known: AgentRunStatus[] = [
    "created",
    "running",
    "succeeded",
    "failed",
    "cancelling",
    "cancelled",
    "timed_out"
  ];
  return known.includes(status as AgentRunStatus)
    ? agentStatusLabel(status as AgentRunStatus)
    : status;
}

/**
 * AgentRunStatus / ToolCallStatus → StatusBadge tone 的**纯展示映射**（Phase 8-B 新增）。
 *
 * 只读取既有枚举，不改变任何业务状态；与 isActiveRun / agentStatusLabel / toolStatusLabel
 * 完全解耦（tone 不参与任何业务判定，也不改变任何文案）。
 * 语义与 4 / 6-B / 7-B 的 tone 体系一致：进行中=info、待执行/取消=中性、
 * 取消中/超时=warning、失败=error、成功=success。
 */
export type AgentRunStatusTone =
  | "pending"
  | "running"
  | "warning"
  | "success"
  | "error"
  | "neutral";

const AGENT_RUN_STATUS_TONES: Record<AgentRunStatus, AgentRunStatusTone> = {
  created: "pending",
  running: "running",
  succeeded: "success",
  failed: "error",
  cancelling: "warning",
  cancelled: "neutral",
  timed_out: "warning"
};

export function agentStatusTone(status: AgentRunStatus): AgentRunStatusTone {
  return AGENT_RUN_STATUS_TONES[status];
}

const TOOL_CALL_STATUS_TONES: Record<ToolCallStatus, AgentRunStatusTone> = {
  running: "running",
  succeeded: "success",
  failed: "error",
  cancelled: "neutral",
  timed_out: "warning"
};

export function toolStatusTone(status: ToolCallStatus): AgentRunStatusTone {
  return TOOL_CALL_STATUS_TONES[status];
}

const EVENT_LABELS: Record<string, string> = {
  // Agent runtime events
  agent_action: "动作",
  agent_final: "最终结果",
  agent_iteration: "迭代",
  agent_run_cancel_requested: "已请求取消",
  agent_run_created: "已创建",
  agent_run_finished: "已结束",
  agent_run_recovered: "已恢复",
  agent_run_started: "已开始",
  agent_resolved: "Agent 已确定",
  agent_artifact_created: "产出物已创建",
  llm_retry: "模型重试",
  tool_call_finished: "工具完成",
  tool_call_started: "工具开始",
  // Workflow engine events
  WORKFLOW_CREATED: "工作流已创建",
  WORKFLOW_STARTED: "工作流已启动",
  WORKFLOW_PAUSED: "工作流已暂停",
  WORKFLOW_RESUMED: "工作流已恢复",
  WORKFLOW_COMPLETED: "工作流已完成",
  WORKFLOW_FAILED: "工作流失败",
  WORKFLOW_CANCELLED: "工作流已取消",
  WORKFLOW_DEADLOCK: "工作流死锁",
  WORKFLOW_TASK_FAILED: "工作流因任务失败而失败",
  TASK_CREATED: "任务已创建",
  TASK_READY: "任务就绪",
  TASK_STARTED: "任务开始",
  TASK_COMPLETED: "任务完成",
  TASK_FAILED: "任务失败",
  TASK_BLOCKED: "任务阻塞",
  TASK_CANCELLED: "任务取消",
  TASK_RETRYING: "任务重试中",
  TASK_EXECUTION_ERROR: "任务执行错误",
  REPLAN_STARTED: "重规划开始",
  REPLAN_COMPLETED: "重规划完成",
  REPLAN_VALIDATION_ERROR: "重规划校验失败",
  APPROVAL_REQUIRED: "需要审批",
  APPROVAL_GRANTED: "审批已通过",
  APPROVAL_REJECTED: "审批已拒绝",
  FAILURE_ROUTED: "失败已分类路由",
  FAILURE_HUMAN_REQUIRED: "需要人工介入",
  ROLLBACK_TASK_CREATED: "已创建回滚任务",
  ROLLBACK_NOT_SUPPORTED: "不支持回滚",
  ROLLBACK_VALIDATION_ERROR: "回滚校验失败",
  // Delivery events
  CI_STARTED: "CI 开始",
  CI_FINISHED: "CI 完成",
  CI_FAILED: "CI 失败",
  CI_RELEASE_NOT_FOUND: "未找到 CI 发布",
  DEPLOYMENT_STARTED: "部署开始",
  DEPLOYMENT_FINISHED: "部署完成",
  DEPLOYMENT_FAILED: "部署失败",
  DEPLOYMENT_NOT_FOUND: "未找到部署",
  DEPLOYMENT_ROLLBACK_FINISHED: "部署回滚完成",
  ROLLBACK_FAILED: "回滚失败",
  ROLLBACK_VERSION_NOT_FOUND: "未找到可回滚版本",
  // Planning events
  PLANNING_STARTED: "规划开始",
  PLANNING_COMPLETED: "规划完成",
  PLANNING_FAILED: "规划失败",
  PLANNING_ERROR: "规划出错",
  PLANNING_PERSISTED: "规划已持久化",
  PLANNING_REPAIR_REQUESTED: "规划修复已请求",
  PLANNING_REPAIR_COMPLETED: "规划修复完成",
  PLANNING_SCHEMA_VALIDATION_FAILED: "规划结构校验失败",
  REQUIREMENT_ANALYSIS_FAILED: "需求分析失败",
  SLICE_PLANNING_FAILED: "切片规划失败",
  SLICE_PLANNING_ESCALATED: "切片规划已升级人工确认",
  SLICE_PLANNING_COMPLETED: "切片规划完成",
  SLICE_PLANNING_PERSISTED: "切片规划已持久化",
  UI_REFERENCE_DESCRIBED: "UI 参照图已视觉描述",
  UI_SPEC_GENERATION_STARTED: "UI 规格生成开始",
  UI_SPEC_GENERATION_COMPLETED: "UI 规格生成完成"
};

export function eventLabel(event: WorkflowEvent): string {
  return EVENT_LABELS[event.eventType] ?? event.eventType;
}

export function eventSummary(event: WorkflowEvent): string {
  const payload = event.payload;
  const pieces = [
    typeof payload.action === "string" ? payload.action : "",
    typeof payload.toolName === "string" ? payload.toolName : "",
    typeof payload.status === "string" ? payload.status : "",
    typeof payload.errorCode === "string" ? payload.errorCode : "",
    typeof payload.sliceKey === "string" ? payload.sliceKey : "",
    typeof payload.errorMessage === "string" ? payload.errorMessage : "",
    Array.isArray(payload.warnings) && payload.warnings.length > 0
      ? `warnings=${payload.warnings.length}`
      : "",
    typeof payload.describedCount === "number" ? `described=${payload.describedCount}` : ""
  ].filter(Boolean);

  return pieces.join(" / ") || "已记录";
}

export function formatDuration(ms?: number): string {
  if (typeof ms !== "number") {
    return "-";
  }

  if (ms < 1000) {
    return `${ms}ms`;
  }

  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatDateTime(value?: string): string {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

// ─────────────────────────────────────────────────────────────────────────────
// UX-03 — AgentRun Context / Execution Trace / Failure Context（纯展示逻辑）
// ─────────────────────────────────────────────────────────────────────────────

const FAILURE_TYPE_LABELS: Record<string, string> = {
  LLM_ERROR: "模型错误",
  TOOL_ERROR: "工具错误",
  SANDBOX_ERROR: "沙箱错误",
  COMMAND_ERROR: "命令执行失败",
  TEST_ERROR: "测试失败",
  TIMEOUT_ERROR: "执行超时",
  CANCELLED_ERROR: "已取消",
  UNKNOWN_ERROR: "未知错误"
};

/** 失败类型中文标签（未知类型回退原文，不吞信息）。 */
export function failureTypeLabel(code?: string): string {
  if (!code) {
    return "未知错误";
  }
  return FAILURE_TYPE_LABELS[code] ?? code;
}

const FAILURE_TYPE_TONES: Record<string, AgentRunStatusTone> = {
  TIMEOUT_ERROR: "warning",
  CANCELLED_ERROR: "neutral"
};

export function failureTypeTone(code?: string): AgentRunStatusTone {
  if (!code) {
    return "error";
  }
  return FAILURE_TYPE_TONES[code] ?? "error";
}

/** Agent 级尝试次数：retryCount + 1（现有数据无 maxRetries 字段，不伪造分母）。 */
export function attemptLabel(retryCount: number): string {
  return `第 ${retryCount + 1} 次尝试`;
}

/** 运行目标（coded demo 运行来自 input.task；工作流派生的运行由任务标题承担）。 */
export function agentRunTask(input?: JsonObject): string {
  return input && typeof input.task === "string" ? input.task : "编码任务";
}

const RECOVERY_STRATEGY_LABELS: Record<string, string> = {
  RETRY: "重试",
  REPLAN: "重规划",
  DEBUG: "创建诊断任务",
  HUMAN: "人工介入",
  FAIL: "终止",
  ROLLBACK: "回滚",
  CONTINUE: "继续"
};

export function recoveryStrategyLabel(strategy?: string | null): string {
  if (!strategy) {
    return "未触发恢复";
  }
  return RECOVERY_STRATEGY_LABELS[strategy.toUpperCase()] ?? strategy;
}

/** 策略行完整文案：中文标签（原始值）；未知策略只显示原文，不吞信息。 */
export function recoveryStrategyText(strategy?: string | null): string {
  if (!strategy) {
    return "未触发恢复";
  }
  const label = recoveryStrategyLabel(strategy);
  return label === strategy ? strategy : `${label}（${strategy}）`;
}

/**
 * 恢复卡片徽标文案：有路由策略时用策略；仅有诊断任务时（当前默认路径 ——
 * failureRouter 未接时引擎不发 FAILURE_ROUTED）说明已创建诊断任务。
 */
export function recoveryBadgeText(recovery: {
  strategy: string | null;
  recoveryTask: unknown;
}): string {
  if (recovery.strategy) {
    return recoveryStrategyLabel(recovery.strategy);
  }
  return recovery.recoveryTask ? "已创建诊断任务" : "已恢复";
}

export function evidenceStatusLabel(status: string): string {
  if (status === "VERIFIED") return "已验证";
  if (status === "FAILED") return "验证失败";
  return status;
}

/** Agent 自报结果（run.output.outcome）→ 中文标签；未知枚举回退原文。 */
export function agentOutcomeLabel(outcome?: string): string {
  const labels: Record<string, string> = {
    SUCCESS: "成功",
    FAILED: "失败",
    RETRY: "请求重试",
    REPLAN: "请求重规划"
  };
  return outcome ? (labels[outcome] ?? outcome) : "—";
}

/** 问题严重度（outcome.issues）→ 中文标签。 */
export function issueSeverityLabel(severity: string): string {
  const labels: Record<string, string> = {
    LOW: "低",
    MEDIUM: "中",
    HIGH: "高",
    CRITICAL: "严重"
  };
  return labels[severity.toUpperCase()] ?? severity;
}

/**
 * run 与 task 判定差异说明：运行成功但任务最终未通过时，解释"为什么运行页显示成功、
 * 工作流里任务却是失败" —— 任务判定由结果/引擎负责，本次运行本身已完成。
 */
export function taskOutcomeNote(detail: AgentRunDetailView): string | null {
  const task = detail.context.task;
  if (!task) return null;
  const taskFailed = task.status === "FAILED" || task.status === "CANCELLED";
  if (detail.run.status !== "succeeded" || !taskFailed) return null;
  const reason = typeof task.summary === "string" && task.summary !== "" ? `：${task.summary}` : "";
  return `本次运行成功，但任务 ${task.taskKey} 最终未通过${reason}`;
}

// ── Execution Trace ──────────────────────────────────────────────────────────

export type ExecutionTraceKind =
  | "agent"
  | "tool"
  | "retry"
  | "recovery"
  | "artifact"
  | "failure"
  | "result"
  | "event";

/** 统一 trace 节点：结构化工程信息（阶段 → 动作 → Tool → 结果），不含模型思维链。 */
export interface ExecutionTraceNode {
  id: string;
  at: string;
  kind: ExecutionTraceKind;
  label: string;
  summary: string;
  tone: WorkflowEventTone;
  toolName?: string;
  status?: string;
  durationMs?: number;
  anchorId?: string;
  agentRunId?: string;
  details: WorkflowEventDetail[];
}

const TRACE_KIND_LABELS: Record<ExecutionTraceKind, string> = {
  agent: "Agent",
  tool: "工具调用",
  retry: "重试",
  recovery: "恢复",
  artifact: "产出物",
  failure: "失败",
  result: "结果",
  event: "事件"
};

export function traceKindLabel(kind: ExecutionTraceKind): string {
  return TRACE_KIND_LABELS[kind];
}

function traceKind(eventType: string): ExecutionTraceKind {
  if (
    ["agent_run_created", "agent_run_started", "agent_resolved", "agent_run_recovered"].includes(
      eventType
    )
  ) {
    return "agent";
  }
  if (
    ["agent_run_finished", "agent_final", "TASK_COMPLETED", "WORKFLOW_COMPLETED"].includes(
      eventType
    )
  ) {
    return "result";
  }
  if (["llm_retry", "TASK_RETRYING"].includes(eventType)) {
    return "retry";
  }
  if (
    [
      "FAILURE_ROUTED",
      "REPLAN_STARTED",
      "REPLAN_COMPLETED",
      "TASK_CREATED",
      "ROLLBACK_TASK_CREATED"
    ].includes(eventType)
  ) {
    return "recovery";
  }
  if (eventType === "agent_artifact_created") {
    return "artifact";
  }
  if (
    [
      "TASK_FAILED",
      "TASK_EXECUTION_ERROR",
      "WORKFLOW_FAILED",
      "WORKFLOW_TASK_FAILED",
      "FAILURE_HUMAN_REQUIRED",
      "CI_FAILED",
      "DEPLOYMENT_FAILED",
      "ROLLBACK_FAILED",
      "ROLLBACK_VALIDATION_ERROR",
      "REPLAN_VALIDATION_ERROR"
    ].includes(eventType)
  ) {
    return "failure";
  }
  return "event";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function toolTraceNode(tool: ToolCallAudit): ExecutionTraceNode {
  const details: WorkflowEventDetail[] = [];
  const push = (label: string, value: unknown): void => {
    if (value === undefined || value === null || value === "") return;
    details.push({ label, value: String(value) });
  };
  const input = tool.input;
  push("命令", typeof input.command === "string" ? truncate(input.command, 160) : undefined);
  push(
    "路径",
    typeof input.path === "string"
      ? input.path
      : typeof input.filePath === "string"
        ? input.filePath
        : undefined
  );
  push("迭代", tool.iteration);
  push("耗时", tool.duration === undefined ? undefined : formatDuration(tool.duration));
  push("错误码", tool.error?.code);

  const failed = tool.status === "failed" || tool.status === "timed_out";
  const rawSummary = typeof tool.output?.summary === "string" ? tool.output.summary.trim() : "";
  // 摘要为 JSON 串时不平铺（§8）：折叠进「输出」明细，摘要退回状态描述。
  const jsonish = rawSummary.startsWith("{") || rawSummary.startsWith("[");
  if (jsonish) {
    push("输出", truncate(rawSummary, 200));
  }
  const summary = failed
    ? tool.error?.message || "执行失败"
    : rawSummary !== "" && !jsonish
      ? rawSummary
      : tool.status === "running"
        ? "执行中…"
        : "执行完成";

  const toolTone = toolStatusTone(tool.status);

  return {
    id: `tool-${tool.id}`,
    at: tool.startedAt,
    kind: "tool",
    label: `工具调用 · ${tool.toolName}`,
    summary,
    tone: toolTone === "pending" ? "neutral" : toolTone,
    toolName: tool.toolName,
    status: tool.status,
    ...(tool.duration === undefined ? {} : { durationMs: tool.duration }),
    anchorId: `tool-${tool.toolCallId}`,
    details
  };
}

/**
 * UX-03：把工具调用与（非 tool_call_* 的）事件合并为一条按时间升序的执行轨迹。
 * 只呈现结构化工程信息 —— 工具、状态、耗时、错误与恢复；不包含任何模型思维链。
 * `tool_call_started/finished` 事件由 ToolCallAudit 行代表，避免重复节点。
 */
export function buildExecutionTrace(detail: AgentRunDetailView): ExecutionTraceNode[] {
  const contextTask = detail.context.task;
  const pseudoTask = {
    id: contextTask?.id ?? detail.run.taskId,
    title: contextTask?.title ?? agentRunTask(detail.run.input),
    assignedAgent: detail.context.agentName ?? undefined,
    retryCount: contextTask?.retryCount ?? detail.run.retryCount,
    output: detail.run.output ?? {}
  } as unknown as Task;

  const nodes: ExecutionTraceNode[] = [];

  for (const event of detail.events) {
    if (event.eventType === "tool_call_started" || event.eventType === "tool_call_finished") {
      continue;
    }
    const view = workflowEventView(event, {
      tasks: [pseudoTask],
      ...(detail.context.maxRetries === null ? {} : { maxRetries: detail.context.maxRetries })
    });
    const kind = traceKind(event.eventType);
    nodes.push({
      id: `event-${event.id}`,
      at: event.createdAt,
      kind,
      label: eventLabel(event),
      summary: view.summary,
      tone: view.tone,
      ...(event.agentRunId ? { agentRunId: event.agentRunId } : {}),
      details: view.details
    });
  }

  for (const tool of detail.toolCalls) {
    nodes.push(toolTraceNode(tool));
  }

  return nodes.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// ── Failure Context ──────────────────────────────────────────────────────────

export interface AgentRunFailureView {
  typeCode: string;
  typeLabel: string;
  tone: AgentRunStatusTone;
  summary: string;
  errorMessage: string;
  failedTool: ToolCallAudit | null;
  attempt: string;
  taskRetry: string | null;
}

/** UX-03：失败运行时（failed / timed_out）的失败上下文；复用现有错误分类字段。 */
export function agentRunFailureView(detail: AgentRunDetailView): AgentRunFailureView | null {
  const { run, toolCalls } = detail;
  if (run.status !== "failed" && run.status !== "timed_out") {
    return null;
  }

  const failedTool =
    [...toolCalls]
      .reverse()
      .find((tool) => tool.status === "failed" || tool.status === "timed_out") ?? null;
  const code = run.error?.code ?? failedTool?.error?.code ?? "";
  const errorMessage = run.error?.message ?? failedTool?.error?.message ?? "";
  const summary = failedTool
    ? `工具 ${failedTool.toolName} 执行失败${failedTool.error?.message ? `：${failedTool.error.message}` : ""}`
    : errorMessage || `运行以「${agentStatusLabel(run.status)}」结束`;

  const task = detail.context.task;
  return {
    typeCode: code || "UNKNOWN_ERROR",
    typeLabel: failureTypeLabel(code || undefined),
    tone: failureTypeTone(code || undefined),
    summary,
    errorMessage,
    failedTool,
    attempt: attemptLabel(run.retryCount),
    taskRetry:
      task === null
        ? null
        : detail.context.maxRetries === null
          ? `${task.retryCount}`
          : `${task.retryCount} / ${detail.context.maxRetries}`
  };
}
