import { DeliveryEnvironment, Deployment, DeploymentStatus } from "@ai-se/shared";

const STATUS_LABELS: Record<DeploymentStatus, string> = {
  PENDING: "等待中",
  RUNNING: "进行中",
  SUCCESS: "成功",
  FAILED: "失败",
  ROLLING_BACK: "回滚中",
  ROLLED_BACK: "已回滚",
  ROLLBACK_FAILED: "回滚失败"
};

export function deploymentStatusLabel(status: DeploymentStatus): string {
  return STATUS_LABELS[status] ?? status;
}

const ENVIRONMENT_LABELS: Record<DeliveryEnvironment, string> = {
  dev: "开发",
  staging: "预发",
  production: "生产"
};

export function environmentLabel(environment: DeliveryEnvironment): string {
  return ENVIRONMENT_LABELS[environment] ?? environment;
}

export function ciProviderLabel(provider: string): string {
  return provider === "github" ? "GitHub" : provider === "local" ? "本地" : provider;
}

const CI_STATUS_LABELS: Record<string, string> = {
  QUEUED: "排队中",
  RUNNING: "进行中",
  SUCCESS: "成功",
  FAILED: "失败",
  CANCELLED: "已取消"
};

export function ciStatusLabel(status: string): string {
  return CI_STATUS_LABELS[status] ?? status;
}

export function canRollback(deployment: Deployment): boolean {
  return deployment.operation === "DEPLOY" && ["SUCCESS", "FAILED"].includes(deployment.status);
}

/**
 * DeploymentStatus → StatusBadge tone 的**纯展示映射**（Phase 9-B 新增）。
 *
 * 只读取既有 DeploymentStatus 枚举，不改变任何业务状态；与 canRollback /
 * deploymentStatusLabel 完全解耦（tone 不参与判定、不改变任何文案）。
 * 语义与 4 / 6-B / 7-B / 8-B 的 tone 体系一致。
 */
export type DeploymentStatusTone =
  | "pending"
  | "running"
  | "warning"
  | "success"
  | "error"
  | "neutral";

const STATUS_TONES: Record<DeploymentStatus, DeploymentStatusTone> = {
  PENDING: "pending",
  RUNNING: "running",
  SUCCESS: "success",
  FAILED: "error",
  ROLLING_BACK: "warning",
  ROLLED_BACK: "neutral",
  ROLLBACK_FAILED: "error"
};

export function deploymentStatusTone(status: DeploymentStatus): DeploymentStatusTone {
  return STATUS_TONES[status];
}

export function shortVersion(version: string): string {
  return version.length > 12 ? version.slice(0, 12) : version;
}
