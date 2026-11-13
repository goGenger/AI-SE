import {
  AnalyzeRequirementInput,
  AnalyzeRequirementResult,
  ApiResponse,
  ConflictResolution,
  ConflictResolutionInput,
  CreateRequirementInput,
  Requirement,
  RequirementAcceptanceCriteriaView,
  RequirementDocument,
  RequirementDocumentKind,
  RequirementDocumentsView,
  RequirementTraceabilityView,
  RequirementSlicesView,
  RequirementTasksView,
  Specification,
  Task,
  TaskDependencyView,
  WorkflowRun
} from "@ai-se/shared";
import { authHeaders } from "./auth";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

async function parseApiResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => {
    throw new Error(`请求失败（HTTP ${response.status}）`);
  })) as ApiResponse<T>;

  if (!payload.success) {
    throw new Error(payload.error.message);
  }

  return payload.data;
}

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

  return parseApiResponse<T>(response);
}

export function createRequirement(
  projectId: string,
  input: CreateRequirementInput
): Promise<Requirement> {
  return requestJson<Requirement>(`/api/projects/${projectId}/requirements`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function listRequirements(projectId: string): Promise<Requirement[]> {
  return requestJson<Requirement[]>(`/api/projects/${projectId}/requirements`);
}

export function getRequirement(id: string): Promise<Requirement> {
  return requestJson<Requirement>(`/api/requirements/${id}`);
}

export function analyzeRequirement(
  id: string,
  input: AnalyzeRequirementInput = {}
): Promise<AnalyzeRequirementResult> {
  return requestJson<AnalyzeRequirementResult>(`/api/requirements/${id}/analyze`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function listRequirementSpecifications(id: string): Promise<Specification[]> {
  return requestJson<Specification[]>(`/api/requirements/${id}/specifications`);
}

export function listRequirementTasks(id: string): Promise<RequirementTasksView> {
  return requestJson<RequirementTasksView>(`/api/requirements/${id}/tasks`);
}

/** N2 关口 1：切片计划 + 待确认审批（单级模式返回空列表）。 */
export function listRequirementSlices(id: string): Promise<RequirementSlicesView> {
  return requestJson<RequirementSlicesView>(`/api/requirements/${id}/slices`);
}

/** N3：验收标准（AC）记录 + 任务映射数（无记录返回空列表）。 */
export function listRequirementAcceptanceCriteria(
  id: string
): Promise<RequirementAcceptanceCriteriaView> {
  return requestJson<RequirementAcceptanceCriteriaView>(
    `/api/requirements/${id}/acceptance-criteria`
  );
}

/** C-5（N5）：追溯表（确定性生成，零 LLM）。 */
export function listRequirementTraceability(id: string): Promise<RequirementTraceabilityView> {
  return requestJson<RequirementTraceabilityView>(`/api/requirements/${id}/traceability`);
}

export function getTask(id: string): Promise<Task> {
  return requestJson<Task>(`/api/tasks/${id}`);
}

export function getTaskDependencies(id: string): Promise<TaskDependencyView[]> {
  return requestJson<TaskDependencyView[]>(`/api/tasks/${id}/dependencies`);
}

/** D1（`docs/229`）：需求文档列表。`planningStale` 为真时旧规划不应继续使用。 */
export function listRequirementDocuments(requirementId: string): Promise<RequirementDocumentsView> {
  return requestJson<RequirementDocumentsView>(`/api/requirements/${requirementId}/documents`);
}

/**
 * 上传用 **raw body**（`docs/229` §6 第 4 项）：不引 multipart，
 * 浏览器直接把 `File` 当请求体发出去，元数据走 query。
 */
export async function uploadRequirementDocument(
  requirementId: string,
  input: { kind: RequirementDocumentKind; file: File }
): Promise<RequirementDocument> {
  const query = new URLSearchParams({ kind: input.kind, fileName: input.file.name });
  const response = await fetch(
    `${API_BASE_URL}/api/requirements/${requirementId}/documents?${query.toString()}`,
    {
      method: "POST",
      headers: {
        "Content-Type": input.file.type || "application/octet-stream",
        ...authHeaders()
      },
      body: input.file
    }
  ).catch(() => {
    throw new Error("网络请求失败：无法连接后端服务");
  });

  return parseApiResponse<RequirementDocument>(response);
}

export function deleteRequirementDocument(id: string): Promise<{ deleted: boolean }> {
  return requestJson<{ deleted: boolean }>(`/api/documents/${id}`, { method: "DELETE" });
}

/** 产品补齐：手动启动 / 重试已规划切片的工作流（带 sliceKey + planningVersion）。 */
export function startRequirementSliceWorkflow(
  requirementId: string,
  sliceKey: string,
  input: { workspacePath?: string } = {}
): Promise<WorkflowRun> {
  return requestJson<WorkflowRun>(
    `/api/requirements/${requirementId}/slices/${encodeURIComponent(sliceKey)}/start-workflow`,
    {
      method: "POST",
      body: JSON.stringify(input)
    }
  );
}

/** UI 参照图 / 原件预览：直接拉字节（非 JSON 封套）。 */
export function requirementDocumentRawUrl(documentId: string): string {
  return `${API_BASE_URL}/api/documents/${documentId}/raw`;
}

/** 列出已落库的 PRD/TRD 冲突裁决。 */
export function listRequirementConflictResolutions(
  requirementId: string
): Promise<ConflictResolution[]> {
  return requestJson<ConflictResolution[]>(
    `/api/requirements/${requirementId}/conflict-resolutions`
  );
}

/** 提交冲突裁决（跟 PRD / 跟 TRD / 自定义），规划会回灌服从。 */
export function upsertRequirementConflictResolutions(
  requirementId: string,
  resolutions: ConflictResolutionInput[]
): Promise<ConflictResolution[]> {
  return requestJson<ConflictResolution[]>(
    `/api/requirements/${requirementId}/conflict-resolutions`,
    {
      method: "POST",
      body: JSON.stringify({ resolutions })
    }
  );
}
