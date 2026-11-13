import { ApiResponse, CreateProjectInput, Project } from "@ai-se/shared";
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

export function listProjects(): Promise<Project[]> {
  return requestJson<Project[]>("/api/projects");
}

export function getProject(id: string): Promise<Project> {
  return requestJson<Project>(`/api/projects/${id}`);
}

export function createProject(input: CreateProjectInput): Promise<Project> {
  return requestJson<Project>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

/** UX-01: 为已存在（未配置仓库）的项目绑定 Git 仓库。 */
export function attachProjectRepository(id: string, repository: string): Promise<Project> {
  return requestJson<Project>(`/api/projects/${id}/repository`, {
    method: "PUT",
    body: JSON.stringify({ repository })
  });
}

/** 设置 / 覆盖项目本地工作区路径（须在 AGENT_WORKSPACE_ROOT 下）。 */
export function updateProjectWorkspacePath(id: string, workspacePath: string): Promise<Project> {
  return requestJson<Project>(`/api/projects/${id}/workspace-path`, {
    method: "PUT",
    body: JSON.stringify({ workspacePath })
  });
}

export function deleteProject(id: string): Promise<{ id: string }> {
  return requestJson<{ id: string }>(`/api/projects/${id}`, {
    method: "DELETE"
  });
}
