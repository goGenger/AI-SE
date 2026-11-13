import { Project, ProjectStatus } from "@ai-se/shared";

export function projectStatusLabel(status: ProjectStatus): string {
  return status === "active" ? "启用" : "已归档";
}

/**
 * 业务状态 → StatusBadge tone 的**纯展示映射**（Phase 4）。
 *
 * 只读取既有的 `ProjectStatus` 枚举，不修改任何业务状态、不改动 `projectStatusLabel`
 * 的既有语义；与 `StatusBadge`（components/common）之间通过字符串字面量联合类型关联，
 * 避免让 viewmodel 依赖 UI 层类型。
 */
export type ProjectStatusTone = "success" | "neutral";

export function projectStatusTone(status: ProjectStatus): ProjectStatusTone {
  return status === "active" ? "success" : "neutral";
}

export function latestProjects(projects: Project[], limit = 5): Project[] {
  return [...projects]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, limit);
}

export function formatProjectDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

/** UX-01: 未配置仓库时展示中文兜底文案（列表与详情共用）。 */
export function repositoryLabel(repository: string | null): string {
  return repository ?? "未配置";
}

/** UX-01: 表单空输入 → undefined（省略字段，创建后可在详情页绑定仓库）。 */
export function normalizeRepository(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 本地工作区路径展示；null = 尚未持久化（旧数据，服务端会在启动工作流时补齐）。 */
export function workspacePathLabel(workspacePath: string | null): string {
  return workspacePath ?? "未设置（启动工作流时自动分配）";
}

/** 表单空输入 → undefined（服务端按项目名自动分配目录）。 */
export function normalizeWorkspacePath(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
}
