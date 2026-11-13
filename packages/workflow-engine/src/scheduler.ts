import { Task, TaskDependencyView } from "@ai-se/shared";
import { isSupersededBySuccessfulPredecessor } from "./resolution";

function activeDependencies(dependencies: TaskDependencyView[]): TaskDependencyView[] {
  return dependencies.filter((dependency) => dependency.active !== false);
}

/** Predecessor counts as done for readiness: SUCCESS, or FAILED/CANCELLED superseded by a SUCCESS. */
function predecessorSatisfied(
  sourceTaskId: string,
  status: ReadonlyMap<string, Task["status"]>,
  byId: ReadonlyMap<string, Task>
): boolean {
  const current = status.get(sourceTaskId);
  if (current === "SUCCESS") return true;
  if (current !== "FAILED" && current !== "CANCELLED") return false;
  const task = byId.get(sourceTaskId);
  return task !== undefined && isSupersededBySuccessfulPredecessor(task, byId);
}

/** Predecessor blocks dependents: FAILED/BLOCKED/CANCELLED unless FAILED/CANCELLED is superseded. */
function predecessorBlocks(
  sourceTaskId: string,
  status: ReadonlyMap<string, Task["status"]>,
  byId: ReadonlyMap<string, Task>
): boolean {
  const current = status.get(sourceTaskId);
  if (current === "BLOCKED") return true;
  if (current !== "FAILED" && current !== "CANCELLED") return false;
  const task = byId.get(sourceTaskId);
  if (task && isSupersededBySuccessfulPredecessor(task, byId)) return false;
  return true;
}

export function readyTaskIds(tasks: Task[], dependencies: TaskDependencyView[]): string[] {
  const status = new Map(tasks.map((task) => [task.id, task.status]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const incoming = new Map<string, string[]>();

  for (const dependency of activeDependencies(dependencies)) {
    incoming.set(dependency.targetTaskId, [
      ...(incoming.get(dependency.targetTaskId) ?? []),
      dependency.sourceTaskId
    ]);
  }

  return tasks
    .filter((task) => task.status === "PENDING" || task.status === "RETRYING")
    .filter((task) =>
      (incoming.get(task.id) ?? []).every((sourceTaskId) =>
        predecessorSatisfied(sourceTaskId, status, byId)
      )
    )
    .map((task) => task.id);
}

export function blockedTaskIds(tasks: Task[], dependencies: TaskDependencyView[]): string[] {
  const status = new Map(tasks.map((task) => [task.id, task.status]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const incoming = new Map<string, string[]>();

  for (const dependency of activeDependencies(dependencies)) {
    incoming.set(dependency.targetTaskId, [
      ...(incoming.get(dependency.targetTaskId) ?? []),
      dependency.sourceTaskId
    ]);
  }

  return tasks
    .filter((task) => task.status === "PENDING" || task.status === "RETRYING")
    .filter((task) =>
      (incoming.get(task.id) ?? []).some((sourceTaskId) =>
        predecessorBlocks(sourceTaskId, status, byId)
      )
    )
    .map((task) => task.id);
}

export function validateWorkflowGraph(
  taskIds: string[],
  dependencies: Array<Pick<TaskDependencyView, "sourceTaskId" | "targetTaskId">>
): string[] {
  const errors: string[] = [];
  const ids = new Set(taskIds);
  const inDegree = new Map(taskIds.map((id) => [id, 0]));
  const adjacency = new Map(taskIds.map((id) => [id, [] as string[]]));
  const edges = new Set<string>();

  for (const dependency of dependencies) {
    const key = `${dependency.sourceTaskId}->${dependency.targetTaskId}`;
    if (!ids.has(dependency.sourceTaskId) || !ids.has(dependency.targetTaskId)) {
      errors.push(`Dependency references missing task: ${key}`);
      continue;
    }
    if (dependency.sourceTaskId === dependency.targetTaskId) {
      errors.push(`Task cannot depend on itself: ${dependency.sourceTaskId}`);
      continue;
    }
    if (edges.has(key)) {
      errors.push(`Duplicate dependency: ${key}`);
      continue;
    }
    edges.add(key);
    inDegree.set(dependency.targetTaskId, (inDegree.get(dependency.targetTaskId) ?? 0) + 1);
    adjacency.get(dependency.sourceTaskId)?.push(dependency.targetTaskId);
  }

  const queue = [...inDegree.entries()].filter(([, value]) => value === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) continue;
    visited += 1;
    for (const target of adjacency.get(id) ?? []) {
      const next = (inDegree.get(target) ?? 0) - 1;
      inDegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }

  if (visited !== taskIds.length) errors.push("Cycle detected in Workflow Task DAG");
  return errors;
}
