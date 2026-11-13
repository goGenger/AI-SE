<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { ChevronRight, Search } from "@lucide/vue";
import CommandPalette from "./CommandPalette.vue";
import { useDeploymentsStore } from "../../stores/deployments";
import { useIncidentsStore } from "../../stores/incidents";
import { useMCPStore } from "../../stores/mcp";
import { useProjectsStore } from "../../stores/projects";
import { useWorkflowsStore } from "../../stores/workflows";

/**
 * 全局顶栏（W4 重建）。
 *
 * 改造前这条 52px 的高度只显示两个字（路由 meta.group），最黄金的一条位置被浪费。
 * 现在承担两件事：
 *   · **面包屑**：分组 / 页面 / 对象（对象名取自已加载的 store，未加载时不显示该段）；
 *   · **全局搜索入口**：点击或 Cmd / Ctrl + K 唤起命令面板（见 CommandPalette.vue）。
 *
 * 关于「通知入口 / 用户菜单」：审评建议留结构占位，但本应用**没有**对应的数据源——
 * 没有登录态、没有用户模型（`api/auth.ts` 只是可选的 API Token 头），也没有通知实体。
 * 按审评自己的原则「不要为了填满布局而编造」，这里不放点了没反应的假控件。
 * 详见 docs/136-phase-w4-appshell-ia.md「偏离」。
 */

const route = useRoute();
const projects = useProjectsStore();
const workflows = useWorkflowsStore();
const deployments = useDeploymentsStore();
const incidents = useIncidentsStore();
const mcp = useMCPStore();

interface Section {
  prefix: string;
  label: string;
}

/** 一级页面（列表页）。详情路由按路径前缀归到这里。 */
const SECTIONS: Section[] = [
  { prefix: "/projects", label: "项目" },
  { prefix: "/requirements", label: "需求" },
  { prefix: "/workflows", label: "工作流" },
  { prefix: "/deployments", label: "部署" },
  { prefix: "/agents", label: "专业 Agent" },
  { prefix: "/agent-run", label: "Agent 运行" },
  { prefix: "/mcp", label: "MCP 服务器" },
  { prefix: "/incidents", label: "事件" },
  { prefix: "/autonomy-runs", label: "自治记录" }
];

interface Crumb {
  label: string;
  to?: string;
}

/** 详情路由的对象名。取不到（未加载 / 不存在）就返回空串，面包屑少一段而不是显示空壳。 */
function objectLabel(section: Section, path: string): string {
  const rest = path.slice(section.prefix.length).replace(/^\//, "");
  if (!rest) return "";
  if (section.prefix === "/projects") return projects.selectedProject?.name ?? "";
  if (section.prefix === "/deployments") {
    const current = deployments.current;
    return current ? `${current.deployment.environment} · ${current.deployment.version}` : "";
  }
  if (section.prefix === "/mcp") return mcp.selectedServer?.name ?? "";
  if (section.prefix === "/workflows") {
    const id = rest.split("/")[0];
    const summary = workflows.workflows.find((workflow) => workflow.id === id);
    return summary?.requirementName ?? summary?.projectName ?? "";
  }
  if (section.prefix === "/incidents") {
    return incidents.current?.title ?? "";
  }
  return "";
}

const crumbs = computed<Crumb[]>(() => {
  const path = route.path;
  if (path === "/") return [{ label: "仪表盘" }];

  const section = SECTIONS.find(
    (candidate) => path === candidate.prefix || path.startsWith(`${candidate.prefix}/`)
  );
  if (!section) return keepLabelled([{ label: route.meta.group ?? route.meta.title ?? "" }]);

  const items: Crumb[] = [{ label: route.meta.group ?? "" }];
  items.push(
    path === section.prefix ? { label: section.label } : { label: section.label, to: section.prefix }
  );

  const object = objectLabel(section, path);
  if (object) items.push({ label: object });
  return keepLabelled(items);
});

/** 路由未声明分组时，第一段会是空串——丢掉它，而不是渲染一个空壳。 */
function keepLabelled(items: Crumb[]): Crumb[] {
  return items.filter((item) => item.label !== "");
}

/* ── 命令面板与快捷键 ────────────────────────────────────────────────────── */
const paletteOpen = ref(false);

const isApple = computed(
  () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent)
);
const shortcutLabel = computed(() => (isApple.value ? "⌘K" : "Ctrl K"));

function onWindowKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    paletteOpen.value = !paletteOpen.value;
  }
}

onMounted(() => window.addEventListener("keydown", onWindowKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onWindowKeydown));
</script>

<template>
  <header
    class="flex h-[var(--app-header-height)] shrink-0 items-center gap-3 border-b border-border bg-card px-[var(--app-main-padding)]"
  >
    <nav aria-label="面包屑" class="flex min-w-0 flex-1 items-center gap-1.5 text-secondary">
      <template v-for="(crumb, index) in crumbs" :key="`${index}-${crumb.label}`">
        <ChevronRight
          v-if="index > 0"
          class="size-3.5 shrink-0 text-foreground-disabled"
          aria-hidden="true"
        />
        <RouterLink
          v-if="crumb.to"
          :to="crumb.to"
          class="truncate text-muted-foreground transition-colors hover:text-foreground"
        >
          {{ crumb.label }}
        </RouterLink>
        <span
          v-else-if="index === crumbs.length - 1"
          class="truncate text-foreground"
          aria-current="page"
        >
          {{ crumb.label }}
        </span>
        <span v-else class="truncate text-muted-foreground">{{ crumb.label }}</span>
      </template>
    </nav>

    <!--
      这个按钮**故意不写 aria-label**：写了就必须让无障碍名称完整包含可见文字，否则违反
      SC 2.5.3「Label in Name」（axe 报 label-content-name-mismatch）。实测过 ——
      `aria-label="全局搜索"` 配可见文字「搜索… ⌘K」会被判违规，而把「⌘K」写进 aria-label
      只是迎合检查器。名称直接取自可见文字最省事也最正确。
      代价是窄屏：这段文字原本是 `hidden`，`<640px` 时按钮会变成**没有名称**的图标按钮。
      因此改用 `sr-only sm:not-sr-only` —— 窄屏下仍留在无障碍树里，宽屏下照常显示。
    -->
    <button
      type="button"
      class="flex h-8 w-9 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-card text-body text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-60 sm:justify-start sm:px-3"
      :aria-keyshortcuts="isApple ? 'Meta+K' : 'Control+K'"
      @click="paletteOpen = true"
    >
      <Search class="size-4 shrink-0" aria-hidden="true" />
      <span class="sr-only sm:not-sr-only sm:block sm:flex-1 sm:truncate sm:text-left">搜索…</span>
      <kbd
        class="hidden shrink-0 rounded-sm border border-border px-1.5 text-caption sm:inline"
      >{{ shortcutLabel }}</kbd>
    </button>
  </header>

  <CommandPalette v-model:open="paletteOpen" />
</template>
