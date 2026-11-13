import type { AutonomyOutcome, AutonomyRunRecord } from "../api/autonomyRuns";
import {
  autonomyFailureClassLabel,
  formatDisplayValue
} from "./workflowViewModel";

export type AutonomyOutcomeTone =
  | "pending"
  | "running"
  | "warning"
  | "success"
  | "error"
  | "neutral";

const OUTCOME_LABELS: Record<AutonomyOutcome, string> = {
  in_progress: "修复中",
  repaired: "已修复",
  exhausted: "已耗尽",
  failed: "失败"
};

const OUTCOME_TONES: Record<AutonomyOutcome, AutonomyOutcomeTone> = {
  in_progress: "warning",
  repaired: "success",
  exhausted: "error",
  failed: "error"
};

export function autonomyOutcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome as AutonomyOutcome] ?? outcome;
}

export function autonomyOutcomeTone(outcome: string): AutonomyOutcomeTone {
  return OUTCOME_TONES[outcome as AutonomyOutcome] ?? "neutral";
}

export function autonomyFailureLabel(failureClass: string | null | undefined): string {
  return autonomyFailureClassLabel(failureClass);
}

/** 列表副标题：项目 · 切片或规划版本（不含源任务 key，key 已单独展示）。 */
export function autonomyListMeta(run: AutonomyRunRecord): string {
  const project = run.projectName?.trim() || "未命名项目";
  const slice =
    run.sliceKey?.trim() ||
    (run.planningVersion ? `v${run.planningVersion}` : "工作流");
  return `${project} · ${slice}`;
}

export function autonomyRoundLabel(run: AutonomyRunRecord): string {
  if (run.round == null) return "—";
  if (run.maxRetries == null) return `第 ${run.round} 轮`;
  return `第 ${run.round} / ${run.maxRetries} 轮`;
}

export function formatAutonomyDateTime(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

/** 诊断摘要展示：对象已在服务端清洗；这里再挡一层 [object Object]。 */
export function autonomyDiagnosisText(value: unknown): string {
  const formatted = formatDisplayValue(value).replace(/\[object Object\]/g, "").trim();
  return formatted || "—";
}

/** 工作流链接可读文案：需求 / 切片，或短 id。 */
export function autonomyWorkflowLinkLabel(run: {
  requirementName?: string | null;
  sliceKey?: string | null;
  workflowId: string;
}): string {
  const requirement = run.requirementName?.trim() || "";
  const slice = run.sliceKey?.trim() || "";
  if (requirement && slice) return `${requirement} / ${slice}`;
  if (requirement) return requirement;
  if (slice) return slice;
  const id = run.workflowId.trim();
  if (id.length <= 12) return id || "—";
  return `${id.slice(0, 8)}…`;
}

/** 修复任务副行：类型 · 状态（+ 可选目标类型 / 已切换）。taskKey 由调用方单独展示。 */
export function autonomyRepairTaskLine(task: {
  taskKey: string;
  type: string;
  status: string;
  fixTaskType?: string | null;
  typeRetargeted?: boolean;
}): string {
  const bits = [task.type, task.status];
  if (task.fixTaskType) bits.push(`→ ${task.fixTaskType}`);
  if (task.typeRetargeted) bits.push("类型已切换");
  return bits.join(" · ");
}

/** 触发原因与诊断是否实质相同（相同则只展示一次）。 */
export function autonomyTriggerReasonDistinct(
  triggerReason: unknown,
  diagnosisSummary: unknown
): boolean {
  const trigger = autonomyDiagnosisText(triggerReason);
  if (trigger === "—") return false;
  const diagnosis = autonomyDiagnosisText(diagnosisSummary);
  return trigger.trim() !== diagnosis.trim();
}

/** 列表筛选：按项目 / 工作流 / 结果（空值表示不过滤）。 */
export function filterAutonomyRuns(
  runs: AutonomyRunRecord[],
  filter: { projectId?: string; workflowId?: string; outcome?: string }
): AutonomyRunRecord[] {
  const projectId = filter.projectId?.trim() || "";
  const workflowId = filter.workflowId?.trim() || "";
  const outcome = filter.outcome?.trim() || "";
  return runs.filter(
    (run) =>
      (!projectId || run.projectId === projectId) &&
      (!workflowId || run.workflowId === workflowId) &&
      (!outcome || run.outcome === outcome)
  );
}

/** 表格「切片/需求」列：切片优先，否则需求名，并附规划版本。 */
export function autonomySliceRequirementLabel(run: AutonomyRunRecord): string {
  const main = run.sliceKey?.trim() || run.requirementName?.trim() || "—";
  return `${main} · v${run.planningVersion}`;
}

