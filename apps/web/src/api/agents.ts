import {
  AgentDefinitionView,
  AgentEvaluationMetrics,
  AgentRegistryDetail,
  ApiResponse
} from "@ai-se/shared";
import { authHeaders } from "./auth";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, { headers: authHeaders() }).catch(() => {
    throw new Error("网络请求失败：无法连接后端服务");
  });
  const payload = (await response.json().catch(() => {
    throw new Error(`请求失败（HTTP ${response.status}）`);
  })) as ApiResponse<T>;
  if (!payload.success) throw new Error(payload.error.message);
  return payload.data;
}

export function listAgents(): Promise<AgentDefinitionView[]> {
  return requestJson("/api/agents");
}

export function getAgent(name: string): Promise<AgentRegistryDetail> {
  return requestJson(`/api/agents/${encodeURIComponent(name)}`);
}

export function getAgentMetrics(): Promise<AgentEvaluationMetrics> {
  return requestJson("/api/agents/metrics");
}
