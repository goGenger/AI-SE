import {
  AgentRun,
  AgentRunDetailView,
  AgentRunStreamPayload,
  AgentRunSummary,
  AgentRunView,
  ApiResponse,
  CreateAgentRunInput,
  WorkflowEvent
} from "@ai-se/shared";
import { authHeaders } from "./auth";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...init?.headers
    }
  }).catch(() => {
    throw new Error("网络请求失败：无法连接后端服务");
  });
  const payload = (await response.json().catch(() => {
    throw new Error(`请求失败（HTTP ${response.status}）`);
  })) as ApiResponse<T>;

  if (!payload.success) {
    throw new Error(payload.error.message);
  }

  return payload.data;
}

export function createAgentRun(input: CreateAgentRunInput): Promise<AgentRun> {
  return requestJson<AgentRun>("/api/agent-runs", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function listAgentRuns(): Promise<AgentRunSummary[]> {
  return requestJson<AgentRunSummary[]>("/api/agent-runs");
}

export function getAgentRun(id: string): Promise<AgentRunDetailView> {
  return requestJson<AgentRunDetailView>(`/api/agent-runs/${id}`);
}

export function cancelAgentRun(id: string): Promise<AgentRun> {
  return requestJson<AgentRun>(`/api/agent-runs/${id}/cancel`, {
    method: "POST"
  });
}

export function listAgentRunEvents(id: string): Promise<WorkflowEvent[]> {
  return requestJson<WorkflowEvent[]>(`/api/agent-runs/${id}/events`);
}

export function openAgentRunStream(
  id: string,
  onSnapshot: (payload: AgentRunStreamPayload) => void,
  onError: () => void
): EventSource {
  const source = new EventSource(`${API_BASE_URL}/api/agent-runs/${id}/stream`);
  source.addEventListener("snapshot", (event) => {
    onSnapshot(JSON.parse(event.data) as AgentRunStreamPayload);
  });
  source.onerror = () => onError();
  return source;
}

export function runCodingAgentDemo(task: string): Promise<AgentRunView> {
  return requestJson<AgentRunView>("/api/agent-runs/coding-demo", {
    method: "POST",
    body: JSON.stringify({ task })
  });
}
