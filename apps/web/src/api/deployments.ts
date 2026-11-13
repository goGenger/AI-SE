import {
  ApiResponse,
  Deployment,
  DeploymentDetailView,
  DeploymentEnvironmentConfig,
  RollbackDeploymentInput,
  UpsertDeploymentEnvironmentInput
} from "@ai-se/shared";
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

export function listDeployments(projectId?: string): Promise<Deployment[]> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return requestJson(`/api/deployments${query}`);
}

export function getDeployment(id: string): Promise<DeploymentDetailView> {
  return requestJson(`/api/deployments/${id}`);
}

export function listEnvironments(projectId?: string): Promise<DeploymentEnvironmentConfig[]> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return requestJson(`/api/environments${query}`);
}

export function saveEnvironment(
  input: UpsertDeploymentEnvironmentInput
): Promise<DeploymentEnvironmentConfig> {
  return requestJson("/api/environments", { method: "PUT", body: JSON.stringify(input) });
}

export function rollbackDeployment(
  id: string,
  input: RollbackDeploymentInput
): Promise<Deployment> {
  return requestJson(`/api/deployments/${id}/rollback`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}
