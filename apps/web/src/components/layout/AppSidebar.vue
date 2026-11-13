<script setup lang="ts">
import type { Component } from "vue";
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import {
  Activity,
  Bot,
  FileText,
  FolderKanban,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Rocket,
  Server,
  Settings,
  RefreshCw,
  Siren,
  Workflow
} from "@lucide/vue";
import { useWorkflowsStore } from "../../stores/workflows";

/**
 * 全局侧栏（W4 重建）。
 *
 * 三处相对改造前的实质变化：
 *   1. **图标真正渲染**。此前 8 个图标全部 import 了却只渲染一个圆点，是死代码；
 *      现在图标即导航的图形语言，圆点（`.nav-dot`）整体删除。
 *   2. **选中态明确**。从「圆点空心变实心」改为背景 + 文字色 + 图标色同时变
 *      （`bg-primary-light text-primary`，图标走 currentColor）。
 *   3. **工作流失败数**。取 `useWorkflowsStore` 的真实数据；store 未加载或加载失败时
 *      **不显示徽标**，不编造数字。
 *
 * 折叠：宽度在 `--app-sidebar-width`（164px）与 `--app-sidebar-width-collapsed`（64px）
 * 之间切换，折叠后只留图标（`title` 提供名称），用户选择持久化到 localStorage。
 */

interface NavItem {
  label: string;
  to: string;
  icon: Component;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const home: NavItem = { label: "仪表盘", to: "/", icon: LayoutDashboard };

const groups: NavGroup[] = [
  {
    title: "构建",
    items: [
      { label: "项目", to: "/projects", icon: FolderKanban },
      { label: "需求", to: "/requirements", icon: FileText },
      { label: "工作流", to: "/workflows", icon: Workflow },
      { label: "部署", to: "/deployments", icon: Rocket }
    ]
  },
  {
    title: "运行",
    items: [
      { label: "Agent", to: "/agents", icon: Bot },
      { label: "Agent 运行", to: "/agent-run", icon: Activity },
      { label: "MCP 服务器", to: "/mcp", icon: Server },
      { label: "事件", to: "/incidents", icon: Siren },
      { label: "自治记录", to: "/autonomy-runs", icon: RefreshCw }
    ]
  },
  {
    // W13（X1）：模型与凭据配置。它既不属于「构建」也不属于「运行」，单开一组，
    // 与路由的 `meta.group: "系统"` 对应（顶栏据此显示当前区域）。
    title: "系统",
    items: [{ label: "设置", to: "/settings", icon: Settings }]
  }
];

/* ── 失败计数 ────────────────────────────────────────────────────────────────
   侧栏要在任何页面都能回答「哪里出问题了」，所以工作流列表在这里主动加载一次
   （store 自身吞掉异常并写入 error，不会抛出）。失败时 store 为空 ⇒ 不显示徽标。 */
const workflows = useWorkflowsStore();

const failedWorkflowCount = computed(
  () => workflows.workflows.filter((workflow) => workflow.status === "FAILED").length
);

onMounted(() => {
  if (workflows.workflows.length === 0 && !workflows.loading) void workflows.loadWorkflows();
});

/** 目前只有「工作流」有可判定的失败语义；其余菜单项不显示计数，以免出现无意义的 0。 */
function badgeFor(to: string): number {
  return to === "/workflows" ? failedWorkflowCount.value : 0;
}

function badgeTitle(to: string): string | undefined {
  const count = badgeFor(to);
  return count > 0 ? `${count} 个工作流失败` : undefined;
}

/* ── 折叠与持久化 ────────────────────────────────────────────────────────────
   在 setup 阶段同步读取（而不是 onMounted），避免首帧先展开再收起的闪动；
   SSR 下 `localStorage` 不存在，返回默认的展开态。 */
const COLLAPSE_STORAGE_KEY = "ai-se.sidebar.collapsed";

function readCollapsed(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
  } catch {
    // 隐私模式 / 存储被禁用：折叠仍可用，只是不跨会话保留
    return false;
  }
}

const collapsed = ref(readCollapsed());

watch(collapsed, (value) => {
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // 同上：写入失败不影响本次会话内的折叠
  }
});

const route = useRoute();

/** 详情路由（`/projects/:id` 等）按路径前缀归到所属菜单；`/` 仅精确匹配。 */
function isActive(to: string): boolean {
  return to === "/" ? route.path === "/" : route.path === to || route.path.startsWith(`${to}/`);
}
</script>

<template>
  <aside
    class="sticky top-0 flex h-screen shrink-0 self-start flex-col overflow-y-auto bg-card transition-[width] duration-150"
    :class="collapsed ? 'w-[var(--app-sidebar-width-collapsed)]' : 'w-[var(--app-sidebar-width)]'"
  >
    <div
      class="flex h-[var(--app-header-height)] shrink-0 items-center gap-1"
      :class="collapsed ? 'px-2' : 'px-3'"
    >
      <RouterLink
        to="/"
        :title="collapsed ? 'AI-SE' : undefined"
        class="flex min-w-0 flex-1 items-center gap-2 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span class="size-3 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
        <span v-if="!collapsed" class="truncate text-section-title font-medium tracking-tight">AI-SE</span>
      </RouterLink>
      <button
        type="button"
        class="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
        :aria-expanded="!collapsed"
        @click="collapsed = !collapsed"
      >
        <PanelLeftOpen v-if="collapsed" class="size-4" aria-hidden="true" />
        <PanelLeftClose v-else class="size-4" aria-hidden="true" />
      </button>
    </div>

    <nav class="flex flex-col gap-5 pb-4 pt-3" :class="collapsed ? 'px-2' : 'px-3'">
      <RouterLink
        :to="home.to"
        :title="collapsed ? home.label : undefined"
        class="flex items-center rounded-full py-1.5 text-body transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :class="[
          collapsed ? 'justify-center px-0' : 'gap-2.5 px-3',
          isActive(home.to)
            ? 'bg-primary-light font-medium text-primary'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        ]"
      >
        <component :is="home.icon" class="size-4 shrink-0" aria-hidden="true" />
        <span v-if="!collapsed" class="truncate">{{ home.label }}</span>
      </RouterLink>

      <div v-for="group in groups" :key="group.title" class="flex flex-col gap-0.5">
        <span
          v-if="!collapsed"
          class="px-3 pb-1 text-caption font-medium text-muted-foreground"
        >{{ group.title }}</span>
        <hr v-else class="mx-2 mb-1 border-0 border-t border-border" />
        <RouterLink
          v-for="item in group.items"
          :key="item.to"
          :to="item.to"
          :title="collapsed ? item.label : undefined"
          class="flex items-center rounded-full py-1.5 text-body transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :class="[
            collapsed ? 'justify-center px-0' : 'gap-2.5 px-3',
            isActive(item.to)
              ? 'bg-primary-light font-medium text-primary'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          ]"
        >
          <component :is="item.icon" class="size-4 shrink-0" aria-hidden="true" />
          <span v-if="!collapsed" class="truncate">{{ item.label }}</span>
          <span
            v-if="!collapsed && badgeFor(item.to) > 0"
            class="ml-auto shrink-0 rounded-full bg-danger-bg px-1.5 text-caption font-medium tabular-nums text-danger-foreground"
            :title="badgeTitle(item.to)"
          >{{ badgeFor(item.to) }}</span>
        </RouterLink>
      </div>
    </nav>
  </aside>
</template>
