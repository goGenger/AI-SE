import {
  ApiResponse,
  CreateMCPBindingInput,
  CreateMCPServerInputData,
  MCPAppActionResult,
  MCPAppActionRequest,
  MCPAppLink,
  MCPAppUiResource,
  MCPBindingSummary,
  MCPServerDetail,
  MCPServerSummary,
  MCPToolSummary
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

export function listMCPServers(): Promise<MCPServerSummary[]> {
  return requestJson<MCPServerSummary[]>("/api/mcp/servers");
}

export function getMCPServer(serverId: string): Promise<MCPServerDetail> {
  return requestJson<MCPServerDetail>(`/api/mcp/servers/${serverId}`);
}

/** T2：注册一台 MCP 服务器（后端会立即尝试连接并发现工具）。 */
export function createMCPServer(input: CreateMCPServerInputData): Promise<MCPServerDetail> {
  return requestJson<MCPServerDetail>("/api/mcp/servers", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function listMCPTools(serverId: string): Promise<MCPToolSummary[]> {
  return requestJson<MCPToolSummary[]>(`/api/mcp/servers/${serverId}/tools`);
}

/** T2：发现的工具默认关闭，必须显式启用后 agent 才看得到。 */
export function updateMCPTool(
  serverId: string,
  toolId: string,
  input: { enabled: boolean }
): Promise<MCPToolSummary> {
  return requestJson<MCPToolSummary>(`/api/mcp/servers/${serverId}/tools/${toolId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function listMCPBindings(serverId: string): Promise<MCPBindingSummary[]> {
  return requestJson<MCPBindingSummary[]>(`/api/mcp/servers/${serverId}/bindings`);
}

export function createMCPBinding(
  serverId: string,
  input: CreateMCPBindingInput
): Promise<MCPBindingSummary> {
  return requestJson<MCPBindingSummary>(`/api/mcp/servers/${serverId}/bindings`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateMCPBinding(
  bindingId: string,
  input: { enabled: boolean }
): Promise<MCPBindingSummary> {
  return requestJson<MCPBindingSummary>(`/api/mcp/bindings/${bindingId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteMCPBinding(bindingId: string): Promise<{ id: string }> {
  return requestJson<{ id: string }>(`/api/mcp/bindings/${bindingId}`, {
    method: "DELETE"
  });
}

// ── Phase 5.5-7: MCP Apps ───────────────────────────────────────────────────

export function listMCPApps(
  serverId: string,
  projectId: string,
  agentName: string
): Promise<MCPAppLink[]> {
  const query = new URLSearchParams({ projectId, agentName });
  return requestJson<MCPAppLink[]>(`/api/mcp/servers/${serverId}/ui-apps?${query}`);
}

export function getMCPUiResource(
  serverId: string,
  uri: string,
  projectId: string,
  agentName: string
): Promise<MCPAppUiResource> {
  const query = new URLSearchParams({ uri, projectId, agentName });
  return requestJson<MCPAppUiResource>(`/api/mcp/servers/${serverId}/ui-resource?${query}`);
}

export function runMCPAppAction(input: MCPAppActionRequest): Promise<MCPAppActionResult> {
  return requestJson<MCPAppActionResult>("/api/mcp/apps/actions", {
    method: "POST",
    body: JSON.stringify(input)
  });
}
