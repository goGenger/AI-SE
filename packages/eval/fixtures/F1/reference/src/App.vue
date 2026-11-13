<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { filterTasks, isTitleValid, type Filter, type Task } from "./tasks";

/** 只读 `VITE_API_BASE`（构建时注入）；未设置时用相对路径（同源代理）。 */
const apiBase = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

const tasks = ref<Task[]>([]);
const loading = ref(true);
const error = ref("");
const query = ref("");
const filter = ref<Filter>("all");

const dialogOpen = ref(false);
const draft = ref("");
const saving = ref(false);
const formError = ref("");

const visible = computed(() => filterTasks(tasks.value, query.value, filter.value));
const isEmpty = computed(() => !loading.value && error.value === "" && tasks.value.length === 0);
const noResults = computed(() => tasks.value.length > 0 && visible.value.length === 0);

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const response = await fetch(`${apiBase}/api/tasks`);
    if (!response.ok) throw new Error(`list failed with ${response.status}`);
    const payload = (await response.json()) as { items: Task[] };
    tasks.value = payload.items;
  } catch {
    error.value = "Could not load tasks.";
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});

async function toggle(task: Task): Promise<void> {
  const response = await fetch(`${apiBase}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ done: !task.done })
  });
  if (!response.ok) {
    error.value = "Could not update the task.";
    return;
  }
  const payload = (await response.json()) as { task: Task };
  tasks.value = tasks.value.map((entry) => (entry.id === task.id ? payload.task : entry));
}

async function remove(task: Task): Promise<void> {
  const response = await fetch(`${apiBase}/api/tasks/${task.id}`, { method: "DELETE" });
  if (!response.ok) {
    error.value = "Could not delete the task.";
    return;
  }
  tasks.value = tasks.value.filter((entry) => entry.id !== task.id);
}

function openDialog(): void {
  dialogOpen.value = true;
  draft.value = "";
  formError.value = "";
}

function closeDialog(): void {
  dialogOpen.value = false;
  formError.value = "";
}

async function save(): Promise<void> {
  formError.value = "";
  if (!isTitleValid(draft.value)) {
    formError.value = "Title is required.";
    return;
  }
  saving.value = true;
  try {
    const response = await fetch(`${apiBase}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: draft.value.trim() })
    });
    if (!response.ok) {
      error.value = "Could not create the task.";
      return;
    }
    const payload = (await response.json()) as { task: Task };
    tasks.value = [payload.task, ...tasks.value];
    closeDialog();
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <header class="app-header">
    <h1 data-testid="app-title">TaskBoard</h1>
    <span class="count">Tasks: <strong data-testid="task-count">{{ tasks.length }}</strong></span>
  </header>

  <main class="app-main">
    <p v-if="loading" class="loading" data-testid="loading-indicator">Loading tasks…</p>

    <div v-if="error" class="error" data-testid="error-banner">
      <span>{{ error }}</span>
      <button type="button" data-testid="retry-button" @click="load">Retry</button>
    </div>

    <section class="toolbar">
      <input v-model="query" data-testid="search-input" placeholder="Search tasks" />
      <div class="filters">
        <button type="button" data-testid="filter-all" @click="filter = 'all'">All</button>
        <button type="button" data-testid="filter-active" @click="filter = 'active'">Active</button>
        <button type="button" data-testid="filter-done" @click="filter = 'done'">Done</button>
      </div>
      <button type="button" data-testid="new-task-button" @click="openDialog">New task</button>
    </section>

    <p v-if="isEmpty" class="empty" data-testid="empty-state">No tasks yet.</p>
    <p v-else-if="noResults" class="empty" data-testid="no-results">No tasks match.</p>

    <ul data-testid="task-list" class="task-list">
      <li
        v-for="task in visible"
        :key="task.id"
        class="task-item"
        data-testid="task-item"
        :data-done="task.done ? 'true' : 'false'"
      >
        <span class="title" data-testid="task-title">{{ task.title }}</span>
        <span class="spacer"></span>
        <button type="button" data-testid="task-done-toggle" @click="toggle(task)">
          {{ task.done ? "Undo" : "Done" }}
        </button>
        <button type="button" data-testid="task-delete-button" @click="remove(task)">Delete</button>
      </li>
    </ul>

    <div v-if="dialogOpen" class="dialog" role="dialog" aria-label="New task" data-testid="new-task-dialog">
      <label class="field">
        <span>Title</span>
        <input v-model="draft" data-testid="task-title-input" />
      </label>
      <p v-if="formError" class="form-error" data-testid="form-error">{{ formError }}</p>
      <div class="dialog-actions">
        <button type="button" data-testid="save-task-button" :disabled="saving" @click="save">
          {{ saving ? "Saving…" : "Save" }}
        </button>
        <button type="button" data-testid="cancel-task-button" @click="closeDialog">Cancel</button>
      </div>
    </div>
  </main>
</template>
