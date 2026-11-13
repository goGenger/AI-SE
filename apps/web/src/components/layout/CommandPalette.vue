<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { Search } from "@lucide/vue";
import {
  buildDataEntries,
  filterEntries,
  groupEntries,
  type PaletteEntry
} from "../../viewmodels/commandPaletteViewModel";
import { useAgentsStore } from "../../stores/agents";
import { useDeploymentsStore } from "../../stores/deployments";
import { useMCPStore } from "../../stores/mcp";
import { useProjectsStore } from "../../stores/projects";
import { useRequirementsStore } from "../../stores/requirements";
import { useWorkflowsStore } from "../../stores/workflows";

/**
 * 全局搜索 / 命令面板（W4 新增，Cmd / Ctrl + K 唤起）。
 *
 * 全站此前没有任何搜索。结果有两类：**页面**（静态路由，永远可用）与**数据**
 * （各 store 已加载的实体）。条目映射、过滤、分组的判断全在
 * `viewmodels/commandPaletteViewModel.ts`，本组件只负责交互与渲染。
 *
 * 数据来源：打开面板时按需触发一次各列表的加载（仅当该 store 为空且未在加载中），
 * 因此不会在应用启动时凭空多出请求，也不会每次打开都重复拉取。
 * 需求的列表接口需要 projectId、无法整表拉取，只搜索当前已加载的那一批。
 */

const open = defineModel<boolean>("open", { default: false });

const router = useRouter();
const projects = useProjectsStore();
const requirements = useRequirementsStore();
const workflows = useWorkflowsStore();
const deployments = useDeploymentsStore();
const agents = useAgentsStore();
const mcp = useMCPStore();

const dataEntries = computed<PaletteEntry[]>(() =>
  buildDataEntries({
    projects: projects.projects,
    requirements: requirements.requirements,
    workflows: workflows.workflows,
    deployments: deployments.deployments,
    agents: agents.agents,
    mcpServers: mcp.servers
  })
);

const query = ref("");
const activeIndex = ref(0);
const listEl = ref<HTMLElement | null>(null);

const visibleEntries = computed(() => filterEntries(dataEntries.value, query.value));
const groupedEntries = computed(() => groupEntries(visibleEntries.value));

/** 条目 id → 全局序号；渲染高亮与键盘遍历共用同一套下标。 */
const indexOf = computed(() => {
  const map = new Map<string, number>();
  visibleEntries.value.forEach((entry, index) => map.set(entry.id, index));
  return map;
});

watch(visibleEntries, () => {
  activeIndex.value = 0;
});

watch(activeIndex, async () => {
  await nextTick();
  listEl.value
    ?.querySelector<HTMLElement>('[data-active="true"]')
    ?.scrollIntoView({ block: "nearest" });
});

/** 打开面板时才按需拉取，且只在对应 store 为空时拉一次。 */
function ensureDataLoaded(): void {
  const pending: Promise<unknown>[] = [];
  if (projects.projects.length === 0 && !projects.loading) pending.push(projects.fetchProjects());
  if (workflows.workflows.length === 0 && !workflows.loading) pending.push(workflows.loadWorkflows());
  if (deployments.deployments.length === 0 && !deployments.loading) pending.push(deployments.load());
  if (agents.agents.length === 0 && !agents.loading) pending.push(agents.load());
  if (mcp.servers.length === 0 && !mcp.loading) pending.push(mcp.fetchServers());
  // store 自身吞掉异常并写入 error，这里的失败不需要额外处理
  void Promise.allSettled(pending);
}

watch(open, (isOpen) => {
  if (!isOpen) return;
  query.value = "";
  activeIndex.value = 0;
  ensureDataLoaded();
});

function select(entry: PaletteEntry | undefined): void {
  if (!entry) return;
  open.value = false;
  void router.push(entry.to);
}

function move(delta: number): void {
  const total = visibleEntries.value.length;
  if (total === 0) return;
  activeIndex.value = (activeIndex.value + delta + total) % total;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    move(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    select(visibleEntries.value[activeIndex.value]);
  }
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-foreground/40" />
      <DialogContent
        class="fixed left-1/2 top-[12vh] z-50 flex max-h-[70vh] w-[min(640px,92vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-[var(--shadow-overlay)]"
      >
        <DialogTitle class="sr-only">全局搜索</DialogTitle>

        <div class="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            v-model="query"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-label="搜索页面与数据"
            placeholder="搜索页面、项目、需求、工作流…"
            class="w-full border-0 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground"
            @keydown="onKeydown"
          />
        </div>

        <ul
          id="command-palette-list"
          ref="listEl"
          role="listbox"
          aria-label="搜索结果"
          class="m-0 min-h-0 flex-1 list-none overflow-y-auto p-2"
        >
          <li
            v-if="visibleEntries.length === 0"
            class="px-3 py-6 text-center text-secondary text-muted-foreground"
          >
            没有匹配的结果。
          </li>
          <template v-for="section in groupedEntries" :key="section.group">
            <li
              class="px-3 pb-1 pt-2 text-caption font-medium text-muted-foreground"
              aria-hidden="true"
            >
              {{ section.group }}
            </li>
            <li
              v-for="entry in section.entries"
              :key="entry.id"
              role="option"
              :aria-selected="indexOf.get(entry.id) === activeIndex"
              :data-active="indexOf.get(entry.id) === activeIndex"
              class="flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-body"
              :class="
                indexOf.get(entry.id) === activeIndex
                  ? 'bg-primary-light text-primary'
                  : 'text-foreground hover:bg-muted'
              "
              @click="select(entry)"
              @mouseenter="activeIndex = indexOf.get(entry.id) ?? activeIndex"
            >
              <span class="truncate">{{ entry.label }}</span>
              <span class="shrink-0 text-caption text-muted-foreground">{{ entry.hint }}</span>
            </li>
          </template>
        </ul>

        <div
          class="flex items-center gap-4 border-t border-border px-4 py-2 text-caption text-muted-foreground"
        >
          <span>↑ ↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
