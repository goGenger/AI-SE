/**
 * D-3（T8-c）：部署面 API Token（可选）。
 *
 * 未设置 `VITE_API_TOKEN` 时返回空对象——所有请求保持无鉴权头（本地默认零行为变化）。
 */
export function authHeaders(): Record<string, string> {
  const token = import.meta.env.VITE_API_TOKEN;
  return typeof token === "string" && token.length > 0 ? { Authorization: `Bearer ${token}` } : {};
}
