/** 任务板前端的纯逻辑（可单测的那一半；DOM 行为由 oracle 判定）。 */

export interface Task {
  id: string;
  title: string;
  done: boolean;
  createdAt: string;
}

export type Filter = "all" | "active" | "done";

/** 搜索与筛选**叠加**：结果同时满足两者（AC-15）。 */
export function filterTasks(tasks: readonly Task[], query: string, filter: Filter): Task[] {
  const needle = query.trim().toLowerCase();
  return tasks.filter((task) => {
    if (filter === "active" && task.done) return false;
    if (filter === "done" && !task.done) return false;
    if (needle !== "" && !task.title.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** 标题校验：去首尾空格后非空（AC-07 的前端侧）。 */
export function isTitleValid(title: string): boolean {
  return title.trim() !== "";
}
