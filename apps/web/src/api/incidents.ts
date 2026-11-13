import { ApiResponse, Incident } from "@ai-se/shared";
import { authHeaders } from "./auth";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...init?.headers }
  }).catch(() => {
    throw new Error("网络请求失败：无法连接后端服务");
  });
  const payload = (await response.json().catch(() => {
    throw new Error(`请求失败（HTTP ${response.status}）`);
  })) as ApiResponse<T>;
  if (!payload.success) throw new Error(payload.error.message);
  return payload.data;
}

export function listIncidents(params?: {
  projectId?: string;
  status?: string;
}): Promise<Incident[]> {
  const query = new URLSearchParams();
  if (params?.projectId) query.set("projectId", params.projectId);
  if (params?.status) query.set("status", params.status);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return requestJson(`/api/incidents${suffix}`);
}

export function getIncident(id: string, projectId?: string): Promise<Incident> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return requestJson(`/api/incidents/${id}${query}`);
}

export function diagnoseIncident(id: string, projectId?: string): Promise<Incident> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return requestJson(`/api/incidents/${id}/diagnose${query}`, { method: "POST" });
}

export function remediateIncident(
  id: string,
  body: { startWorkflow?: boolean; workspacePath?: string } = {},
  projectId?: string
): Promise<{ incident: Incident; remediation: NonNullable<Incident["remediation"]> }> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return requestJson(`/api/incidents/${id}/remediate${query}`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}
