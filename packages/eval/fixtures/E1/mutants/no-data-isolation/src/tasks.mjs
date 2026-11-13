// 任务领域逻辑：创建 / 列表（含搜索）/ 查询 / 更新 / 删除；全部按 userId 作用域。
import { randomUUID } from "node:crypto";
import { validateDueDate, validateTitle } from "./validate.mjs";

export const CREATE_TASK_FIELDS = new Set(["title", "dueDate"]);
export const PATCH_TASK_FIELDS = new Set(["title", "dueDate", "done"]);

export function findUnknownField(body, allowed) {
  return Object.keys(body).find((key) => !allowed.has(key)) ?? null;
}

export function publicTask(task) {
  return {
    id: task.id,
    title: task.title,
    dueDate: task.dueDate ?? null,
    done: Boolean(task.done),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

export function createTask(store, userId, body) {
  const title = validateTitle(body.title);
  if (!title.ok) {
    return { error: { status: 400, code: "TITLE_INVALID" } };
  }
  const dueDate = validateDueDate(body.dueDate);
  if (!dueDate.ok) {
    return { error: { status: 400, code: "DATE_INVALID" } };
  }
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    userId,
    title: title.value,
    dueDate: dueDate.value,
    done: false,
    createdAt: now,
    updatedAt: now
  };
  store.state.tasks.push(task);
  store.persist();
  return { task: publicTask(task) };
}

export function listTasks(store, userId, rawQuery) {
  const query = typeof rawQuery === "string" ? rawQuery.trim().toLowerCase() : "";
  return store.state.tasks
    .filter(() => true)
    .filter((task) => query === "" || task.title.toLowerCase().includes(query))
    .map(publicTask);
}

export function getTask(store, userId, id) {
  const task = store.state.tasks.find((entry) => entry.id === id);
  return task ? publicTask(task) : null;
}

export function updateTask(store, userId, id, body) {
  const task = store.state.tasks.find((entry) => entry.id === id);
  if (!task) {
    return { error: { status: 404, code: "NOT_FOUND" } };
  }
  if ("title" in body) {
    const title = validateTitle(body.title);
    if (!title.ok) {
      return { error: { status: 400, code: "TITLE_INVALID" } };
    }
    task.title = title.value;
  }
  if ("dueDate" in body) {
    const dueDate = validateDueDate(body.dueDate);
    if (!dueDate.ok) {
      return { error: { status: 400, code: "DATE_INVALID" } };
    }
    task.dueDate = dueDate.value;
  }
  if ("done" in body) {
    if (typeof body.done !== "boolean") {
      return { error: { status: 400, code: "VALIDATION_ERROR" } };
    }
    task.done = body.done;
  }
  task.updatedAt = new Date().toISOString();
  store.persist();
  return { task: publicTask(task) };
}

export function deleteTask(store, userId, id) {
  const index = store.state.tasks.findIndex((entry) => entry.id === id);
  if (index === -1) {
    return false;
  }
  store.state.tasks.splice(index, 1);
  store.persist();
  return true;
}
