import {
  ApiResponse,
  Approval,
  ApprovalDecisionInput,
  CreateWorkflowInput,
  Task,
  TaskDependencyView,
  UpdateWorkflowPolicyInput,
  WorkflowDetailView,
  WorkflowEventPage,
  WorkflowRun,
  WorkflowStreamPayload,
  WorkflowSummary,
  WorkflowTraceView
} from "@ai-se/shared";
import { authHeaders } from "./auth";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

/**
 * 失败响应的错误码随 Error 一起抛出（`ApiErrorBody.code`）。
 * 追踪视图需要把「工作流不存在（WORKFLOW_NOT_FOUND）」与网络 / 服务端故障分开给文案（TF-04），
 * 而 `error.message` 是后端文案、不可用于判定；`code` 才是稳定标识。
 * 这是**既有错误通道的附加字段**，不新增第二套错误体系（AGENTS.md §10）。
 */
export interface ApiError extends Error {
  code?: string;
}

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
  if (!payload.success) {
    const error: ApiError = new Error(payload.error.message);
    error.code = payload.error.code;
    throw error;
  }
  return payload.data;
}

export function createWorkflow(input: CreateWorkflowInput): Promise<WorkflowRun> {
  return requestJson("/api/workflows", { method: "POST", body: JSON.stringify(input) });
}

export function listWorkflows(): Promise<WorkflowSummary[]> {
  return requestJson("/api/workflows");
}

export function getWorkflow(id: string): Promise<WorkflowDetailView> {
  return requestJson(`/api/workflows/${id}`);
}

export function workflowAction(
  id: string,
  action: "start" | "pause" | "resume" | "cancel" | "retry"
): Promise<WorkflowRun> {
  return requestJson(`/api/workflows/${id}/${action}`, { method: "POST" });
}

export function listWorkflowTasks(id: string): Promise<Task[]> {
  return requestJson(`/api/workflows/${id}/tasks`);
}

/** UX-02: server-side paginated timeline page (created_at DESC, newest first). */
export function listWorkflowEvents(
  id: string,
  page = 1,
  pageSize = 20
): Promise<WorkflowEventPage> {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return requestJson(`/api/workflows/${id}/events?${query.toString()}`);
}

export function getWorkflowGraph(
  id: string
): Promise<{ tasks: Task[]; dependencies: TaskDependencyView[] }> {
  return requestJson(`/api/workflows/${id}/graph`);
}

export function listWorkflowApprovals(id: string): Promise<Approval[]> {
  return requestJson(`/api/workflows/${id}/approvals`);
}

/**
 * 7-C 端到端追踪树（TF-01）。返回的是后端遍历既有事实表组装好的整棵树
 * （真实运行可达 500+ 工具调用节点），所以**不并入 `getWorkflow`**——
 * 详情每次打开都拉一棵这么大的树不划算，改由追踪区按需触发。
 */
export function getWorkflowTrace(id: string): Promise<WorkflowTraceView> {
  return requestJson(`/api/workflows/${id}/trace`);
}

/** T6：调整工作流级预算（仅 RUNNING/PAUSED；null = 清除该上限）。 */
export function updateWorkflowPolicy(
  id: string,
  input: UpdateWorkflowPolicyInput
): Promise<WorkflowRun> {
  return requestJson(`/api/workflows/${id}/policy`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function decideApproval(
  id: string,
  action: "approve" | "reject",
  input: ApprovalDecisionInput = {}
): Promise<{ id: string; status: string }> {
  return requestJson(`/api/approvals/${id}/${action}`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function openWorkflowStream(
  id: string,
  onSnapshot: (payload: WorkflowStreamPayload) => void,
  onError: () => void
): EventSource {
  const source = new EventSource(`${API_BASE_URL}/api/workflows/${id}/stream`);
  source.addEventListener("snapshot", (event) => {
    onSnapshot(JSON.parse(event.data) as WorkflowStreamPayload);
  });
  source.onerror = onError;
  return source;
}
