import { ApiResponse, ModelConfigPatch, ModelConfigStatus } from "@ai-se/shared";
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

/** 读回当前模型配置。响应里**没有**密钥值，只有「是否已配置」。 */
export function getModelConfig(): Promise<ModelConfigStatus> {
  return requestJson<ModelConfigStatus>("/api/model-config");
}

/** 写入运行时覆盖。字段传 `null` = 清除该字段的覆盖、回落到环境变量。 */
export function updateModelConfig(patch: ModelConfigPatch): Promise<ModelConfigStatus> {
  return requestJson<ModelConfigStatus>("/api/model-config", {
    method: "PUT",
    body: JSON.stringify(patch)
  });
}
