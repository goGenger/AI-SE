import type { ApiResponse } from "@ai-se/shared";
import { authHeaders } from "./auth";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export type AutonomyOutcome = "in_progress" | "repaired" | "exhausted" | "failed";

export interface AutonomyRepairTaskSummary {
  taskKey: string;
  title: string;
  type: string;
  status: string;
  fixTaskType?: string | null;
  typeRetargeted?: boolean;
}

/** 与 GET /api/autonomy-runs 聚合结果对齐（只读）。 */
export interface AutonomyRunRecord {
  id: string;
  triggeredAt: string;
  projectId: string;
  projectName: string | null;
  requirementId: string;
  requirementName: string | null;
  workflowId: string;
  workflowStatus: string;
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
  round: number | null;
  maxRetries: number | null;
  outcome: AutonomyOutcome;
  link: string;
}

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...authHeaders() }
  }).catch(() => {
    throw new Error("网络请求失败：无法连接后端服务");
  });
  const payload = (await response.json().catch(() => {
    throw new Error(`请求失败（HTTP ${response.status}）`);
  })) as ApiResponse<T>;
  if (!payload.success) throw new Error(payload.error.message);
  return payload.data;
}

export function listAutonomyRuns(params?: {
  workflowId?: string;
  limit?: number;
}): Promise<AutonomyRunRecord[]> {
  const query = new URLSearchParams();
  if (params?.workflowId) query.set("workflowId", params.workflowId);
  if (params?.limit != null) query.set("limit", String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return requestJson(`/api/autonomy-runs${suffix}`);
}
