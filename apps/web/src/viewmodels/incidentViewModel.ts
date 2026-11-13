import type {
  AlertSeverity,
  IncidentEvidenceSourceKind,
  IncidentRemediationFaultType,
  IncidentStatus
} from "@ai-se/shared";

/**
 * Incidents 控制台纯展示映射（Phase 8 前端打磨）。
 * 只负责中文标签 / tone / 日期格式；不改变任何业务状态或 API 契约。
 */

export type IncidentStatusTone =
  | "pending"
  | "running"
  | "warning"
  | "success"
  | "error"
  | "neutral";

const STATUS_LABELS: Record<IncidentStatus, string> = {
  open: "开启",
  diagnosing: "诊断中",
  mitigating: "修复中",
  resolved: "已解决",
  cancelled: "已取消"
};

export function incidentStatusLabel(status: string): string {
  return STATUS_LABELS[status as IncidentStatus] ?? status;
}

const STATUS_TONES: Record<IncidentStatus, IncidentStatusTone> = {
  open: "error",
  diagnosing: "warning",
  mitigating: "warning",
  resolved: "success",
  cancelled: "neutral"
};

export function incidentStatusTone(status: string): IncidentStatusTone {
  return STATUS_TONES[status as IncidentStatus] ?? "neutral";
}

const SEVERITY_LABELS: Record<AlertSeverity, string> = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低",
  info: "信息"
};

export function incidentSeverityLabel(severity: string): string {
  return SEVERITY_LABELS[severity as AlertSeverity] ?? severity;
}

const SEVERITY_TONES: Record<AlertSeverity, IncidentStatusTone> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "pending",
  info: "neutral"
};

export function incidentSeverityTone(severity: string): IncidentStatusTone {
  return SEVERITY_TONES[severity as AlertSeverity] ?? "neutral";
}

const REMEDIATION_DECISION_LABELS: Record<string, string> = {
  OPENED_STAGING_FIX_WORKFLOW: "已开预发修复工作流",
  NOTIFY_ONLY: "仅通知"
};

export function remediationDecisionLabel(decision: string): string {
  return REMEDIATION_DECISION_LABELS[decision] ?? decision;
}

const FAULT_TYPE_LABELS: Record<IncidentRemediationFaultType, string> = {
  staging_verify_flaky: "预发验证不稳定",
  ci_release_missing: "CI 发布缺失",
  config_drift_staging: "预发配置漂移"
};

export function faultTypeLabel(faultType: string): string {
  return FAULT_TYPE_LABELS[faultType as IncidentRemediationFaultType] ?? faultType;
}

const EVIDENCE_SOURCE_LABELS: Record<IncidentEvidenceSourceKind, string> = {
  metrics: "指标",
  workflow_trace: "工作流轨迹",
  deployment: "部署",
  workflow_summary: "工作流摘要",
  alert: "告警",
  log: "日志"
};

export function evidenceSourceKindLabel(kind: string): string {
  return EVIDENCE_SOURCE_LABELS[kind as IncidentEvidenceSourceKind] ?? kind;
}

/** 诊断 recommendedAction 是短 slug；未知值回退原文。 */
const RECOMMENDED_ACTION_LABELS: Record<string, string> = {
  await_human_review_then_propose_staging_fix: "人工复核后提出预发修复",
  collect_more_telemetry_then_rediagnose: "补充遥测后重新诊断"
};

export function recommendedActionLabel(action: string): string {
  return RECOMMENDED_ACTION_LABELS[action] ?? action;
}

/** 常见告警标签键 → 中文；未知键保留原文。 */
const LABEL_KEY_LABELS: Record<string, string> = {
  faultType: "故障类型",
  fault_type: "故障类型",
  service: "服务",
  env: "环境",
  environment: "环境",
  cluster: "集群",
  namespace: "命名空间",
  team: "团队",
  component: "组件"
};

export function incidentLabelKeyLabel(key: string): string {
  return LABEL_KEY_LABELS[key] ?? key;
}

export interface IncidentLabelChip {
  key: string;
  keyLabel: string;
  value: string;
  /** 值若是已知故障类型则已映射；否则为原文。 */
  valueLabel: string;
}

export function incidentLabelChips(labels: Record<string, string>): IncidentLabelChip[] {
  return Object.entries(labels).map(([key, value]) => {
    const isFault = key === "faultType" || key === "fault_type";
    return {
      key,
      keyLabel: incidentLabelKeyLabel(key),
      value,
      valueLabel: isFault ? faultTypeLabel(value) : value
    };
  });
}

export function yesNoLabel(value: boolean): string {
  return value ? "是" : "否";
}

export function formatIncidentDateTime(value?: string): string {
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

/** 列表副标题：来源 · 指纹截断。 */
export function incidentListMeta(source: string, fingerprint: string): string {
  const short =
    fingerprint.length > 24 ? `${fingerprint.slice(0, 24)}…` : fingerprint;
  return `${source} · ${short}`;
}
