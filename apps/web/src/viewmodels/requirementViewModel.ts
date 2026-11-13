import {
  AgentRunDetailView,
  RequirementStatus,
  SliceStatus,
  Specification,
  SpecificationType,
  Task,
  TaskDependencyView,
  TaskStatus,
  TaskType,
  WorkflowEvent
} from "@ai-se/shared";

export function requirementStatusLabel(status: RequirementStatus): string {
  const labels: Record<RequirementStatus, string> = {
    DRAFT: "草稿",
    ANALYZING: "分析中",
    PLANNING_REVIEW: "规划待确认",
    ANALYZED: "已分析",
    FAILED: "失败"
  };

  return labels[status];
}

/**
 * 业务状态 → StatusBadge tone 的**纯展示映射**（Phase 6-B 新增）。
 *
 * 只读取既有枚举，不改变任何已有 Label / Type / Status 文案函数。
 * 与 StatusBadge 之间通过字符串字面量联合类型关联，避免 viewmodel 依赖 UI 层类型
 * （与 Phase 4 的 projectStatusTone 采用同一约定）。
 */
export type RequirementStatusTone = "pending" | "running" | "warning" | "success" | "error";

const REQUIREMENT_STATUS_TONES: Record<RequirementStatus, RequirementStatusTone> = {
  DRAFT: "pending",
  ANALYZING: "running",
  PLANNING_REVIEW: "warning",
  ANALYZED: "success",
  FAILED: "error"
};

export function requirementStatusTone(status: RequirementStatus): RequirementStatusTone {
  return REQUIREMENT_STATUS_TONES[status];
}

/** N2 切片状态 → 中文标签（关口 1 切片计划展示）。 */
export function sliceStatusLabel(status: SliceStatus): string {
  const labels: Record<SliceStatus, string> = {
    PENDING: "待规划",
    PLANNING: "规划中",
    PLANNED: "已规划",
    RUNNING: "运行中",
    DONE: "已完成",
    FAILED: "失败"
  };

  return labels[status];
}

export type SliceStatusTone = "pending" | "running" | "success" | "error";

const SLICE_STATUS_TONES: Record<SliceStatus, SliceStatusTone> = {
  PENDING: "pending",
  PLANNING: "running",
  PLANNED: "running",
  RUNNING: "running",
  DONE: "success",
  FAILED: "error"
};

export function sliceStatusTone(status: SliceStatus): SliceStatusTone {
  return SLICE_STATUS_TONES[status];
}

const SPECIFICATION_TYPE_LABELS: Record<SpecificationType, string> = {
  REQUIREMENT_ANALYSIS: "需求分析",
  FUNCTIONAL: "功能",
  TECHNICAL: "技术",
  ARCHITECTURE: "架构",
  API: "API",
  DATABASE: "数据库",
  UI: "UI"
};

export function specificationTypeLabel(type: SpecificationType): string {
  return SPECIFICATION_TYPE_LABELS[type] ?? type;
}

/**
 * 空规格判定：所有顶层值都是空数组（如 `{ endpoints: [] }`、
 * `{ components: [], dataFlow: [] }`）表示该类别不适用于本需求；
 * 严禁为过校验虚构条目，因此"空"是合法且应展示为「不适用」的状态。
 */
export function specificationIsEmpty(content: Record<string, unknown>): boolean {
  const values = Object.values(content);
  if (values.length === 0) {
    return true;
  }
  return values.every((value) => Array.isArray(value) && value.length === 0);
}

const TASK_TYPE_LABELS: Record<TaskType, string> = {
  ANALYSIS: "分析",
  DESIGN: "设计",
  DATABASE: "数据库",
  BACKEND: "后端",
  FRONTEND: "前端",
  TEST: "测试",
  REVIEW: "评审",
  DEBUG: "调试",
  BUILD: "构建",
  DEPLOY: "部署",
  MONITOR: "监控",
  INCIDENT: "事故"
};

export function taskTypeLabel(type: TaskType): string {
  return TASK_TYPE_LABELS[type] ?? type;
}

export function taskStatusLabel(status: TaskStatus): string {
  const labels: Record<TaskStatus, string> = {
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

  return labels[status];
}

/**
 * TaskStatus → StatusBadge tone 的**纯展示映射**（Phase 6-B 新增）。
 * 语义对齐 docs/design/04-component-system.md §8 的状态集合：
 * 进行中=info、待执行=中性、等待审批=warning、失败=error、结束/取消=中性。
 */
export type TaskStatusTone = "pending" | "running" | "warning" | "success" | "error" | "neutral";

const TASK_STATUS_TONES: Record<TaskStatus, TaskStatusTone> = {
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

export function taskStatusTone(status: TaskStatus): TaskStatusTone {
  return TASK_STATUS_TONES[status];
}

export function latestSpecifications(specifications: Specification[]): Specification[] {
  const latestVersion = Math.max(
    0,
    ...specifications.map((specification) => specification.version)
  );
  return specifications.filter((specification) => specification.version === latestVersion);
}

export function latestTasks(tasks: Task[]): Task[] {
  const latestVersion = Math.max(0, ...tasks.map((task) => task.version));
  return tasks.filter((task) => task.version === latestVersion);
}

export function dependencyLabel(dependency: TaskDependencyView): string {
  return `${dependency.sourceTaskKey} -> ${dependency.targetTaskKey}`;
}

export function taskSourceSummary(task: Task): string {
  const sourceSpecTypes = task.input.sourceSpecTypes;
  return Array.isArray(sourceSpecTypes) &&
    sourceSpecTypes.every((entry) => typeof entry === "string")
    ? sourceSpecTypes.map((entry) => specificationTypeLabel(entry as SpecificationType)).join("、")
    : "";
}

/** 产品补齐：已规划且未在跑的切片可手动启动 / 重试工作流。 */
export function canStartSliceWorkflow(slice: {
  status: SliceStatus;
  planningVersion: number | null;
}): boolean {
  if (!slice.planningVersion) return false;
  return slice.status === "PLANNED" || slice.status === "FAILED" || slice.status === "DONE";
}

/** 详情页分析进度：只映射真实 status / agent-run 事件 / 关口审批，不编造步骤。 */
export type RequirementAnalysisProgress = {
  label: string;
  detail?: string;
  tone: RequirementStatusTone;
};

/** 规划相关事件 → 进度文案（按事件流从新到旧取第一条命中）。 */
const ANALYSIS_PROGRESS_BY_EVENT: Record<string, string> = {
  UI_REFERENCE_DESCRIBED: "UI 参照图已描述，继续规划",
  PLANNING_STARTED: "正在生成规格与任务",
  PLANNING_PERSISTED: "规格已落盘，继续规划",
  PLANNING_REPAIR_REQUESTED: "规划结构需修复，重试中",
  PLANNING_REPAIR_COMPLETED: "规划修复完成，继续",
  PLANNING_SCHEMA_VALIDATION_FAILED: "规划结构校验失败",
  UI_SPEC_GENERATION_STARTED: "正在生成 UI 规格",
  UI_SPEC_GENERATION_COMPLETED: "UI 规格已生成",
  SLICE_PLANNING_PERSISTED: "切片计划已落盘",
  SLICE_PLANNING_COMPLETED: "切片规划完成",
  SLICE_PLANNING_ESCALATED: "切片规划需人工确认",
  SLICE_PLANNING_FAILED: "切片规划失败",
  PLANNING_COMPLETED: "规划完成",
  PLANNING_FAILED: "规划失败",
  PLANNING_ERROR: "规划出错",
  REQUIREMENT_ANALYSIS_FAILED: "需求分析失败"
};

function latestProgressEvent(events: WorkflowEvent[]): WorkflowEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && ANALYSIS_PROGRESS_BY_EVENT[event.eventType]) {
      return event;
    }
  }
  return undefined;
}

function agentRunErrorDetail(agentRun: AgentRunDetailView | null | undefined): string | undefined {
  const error = agentRun?.run.error;
  if (!error?.message) return undefined;
  return error.code ? `[${error.code}] ${error.message}` : error.message;
}

/**
 * 从需求状态 + 规划 Agent Run 事件 + 关口 1 审批推导「走到哪了」。
 * 列表与详情共用同一套 status 文案；本函数只给详情补充进度说明。
 */
export function requirementAnalysisProgress(input: {
  status: RequirementStatus;
  analyzing?: boolean;
  agentRun?: AgentRunDetailView | null;
  approval?: { status: string; reason?: string | null } | null;
}): RequirementAnalysisProgress {
  const tone = requirementStatusTone(input.status);

  if (input.status === "FAILED") {
    return {
      label: "分析失败",
      detail: agentRunErrorDetail(input.agentRun),
      tone
    };
  }

  if (input.status === "PLANNING_REVIEW") {
    const pending = input.approval?.status === "PENDING";
    return {
      label: pending ? "等待确认切片计划" : "规划待确认",
      detail: input.approval?.reason?.trim() || undefined,
      tone
    };
  }

  if (input.status === "ANALYZED") {
    return { label: "已分析完成", tone };
  }

  if (input.status === "DRAFT") {
    return { label: "待分析", tone };
  }

  // ANALYZING（或未知兜底）：优先用最新规划事件
  const event = latestProgressEvent(input.agentRun?.events ?? []);
  if (event) {
    const summaryPieces = [
      typeof event.payload.sliceKey === "string" ? event.payload.sliceKey : "",
      typeof event.payload.errorMessage === "string" ? event.payload.errorMessage : "",
      Array.isArray(event.payload.warnings) && event.payload.warnings.length > 0
        ? `警告 ${event.payload.warnings.length} 条`
        : "",
      typeof event.payload.describedCount === "number"
        ? `已描述 ${event.payload.describedCount} 张`
        : ""
    ].filter(Boolean);
    return {
      label: ANALYSIS_PROGRESS_BY_EVENT[event.eventType] ?? event.eventType,
      detail: summaryPieces.join(" · ") || undefined,
      tone
    };
  }

  if (input.analyzing || input.agentRun?.run.status === "running") {
    return {
      label: "分析进行中",
      detail: "已启动规划 Agent，等待首个事件…",
      tone
    };
  }

  return {
    label: requirementStatusLabel(input.status),
    tone
  };
}

/** 详情是否展示进度行（已分析/草稿只靠状态徽标即可，避免重复文案）。 */
export function shouldShowAnalysisProgress(status: RequirementStatus, analyzing = false): boolean {
  return (
    analyzing ||
    status === "ANALYZING" ||
    status === "PLANNING_REVIEW" ||
    status === "FAILED"
  );
}
