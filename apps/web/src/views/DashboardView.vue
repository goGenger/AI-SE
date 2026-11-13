<script setup lang="ts">
import { CircleCheck } from "@lucide/vue";
import { storeToRefs } from "pinia";
import { computed, onMounted } from "vue";
import type { WorkflowSummary } from "@ai-se/shared";
import {
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  PageContainer,
  PageHeader,
  SectionHeader,
  StatusBadge
} from "../components/common";
import { buttonVariants } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Table, type TableColumn } from "../components/ui/table";
import { formatDateTime } from "../viewmodels/agentRunViewModel";
import {
  WORKFLOW_ACTIVE_STATUSES,
  WORKFLOW_ATTENTION_STATUSES,
  countWorkflowsInStatus,
  latestWorkflows,
  workflowStatusLabel,
  workflowStatusTone
} from "../viewmodels/workflowViewModel";
import { useProjectsStore } from "../stores/projects";
import { useWorkflowsStore } from "../stores/workflows";

/**
 * DashboardView（W6：去海报化）。
 *
 * 首屏按「用户会问的问题」排序，而不是按「能摆什么」排序：
 *   ① 有没有东西卡住/失败了（状态色 + 数量，最优先）
 *   ② 正在跑的有几个
 *   ③ 最近的动态（最近工作流）
 *   ④ 总量统计（项目规模，最后）
 *
 * W6 删掉的：交付流水线圆点轨道（`.dashboard-rail` / `.dashboard-dot`）与整套入场动画 ——
 * 侧栏已经承担导航，该轨道是同一条导航的第二份；动画则是纯装饰。连带删掉本文件最后
 * 两处 `!important`（那是给动画做的 prefers-reduced-motion 守卫，动画没了守卫也就不需要）。
 *
 * 数据来源（用户裁决：projects + workflows）：
 *   · projectsStore —— 现有调用，未改
 *   · workflowsStore —— 侧栏（AppSidebar onMounted）**已全站加载**，这里只补一个
 *     「为空且未在加载」的守卫，保证直接深链到 `/` 时也有数据，且不会与侧栏重复请求。
 *     因此本页**不新增任何实际网络请求**。
 *
 * 所有数字都由 store 的真实数据算出；没有任何为填满布局而编造的内容。
 */
const projectsStore = useProjectsStore();
const workflowsStore = useWorkflowsStore();
const { projects, loading: projectsLoading, error: projectsError } = storeToRefs(projectsStore);
const { workflows, loading: workflowsLoading, error: workflowsError } =
  storeToRefs(workflowsStore);

/**
 * 数字的颜色**只在确实有东西时才用状态色** —— 「失败 0」标成红色会把平静的界面喊成告警。
 * 0 一律走中性灰，非 0 才按状态的语义色。
 */
const TONE_TEXT: Record<string, string> = {
  error: "text-danger",
  warning: "text-warning",
  running: "text-info",
  success: "text-success",
  pending: "text-muted-foreground",
  neutral: "text-muted-foreground"
};

function metricItems(statuses: readonly (typeof WORKFLOW_ATTENTION_STATUSES)[number][]) {
  return statuses.map((status) => ({
    status,
    label: workflowStatusLabel(status),
    tone: workflowStatusTone(status),
    count: countWorkflowsInStatus(workflows.value, [status])
  }));
}

const attentionItems = computed(() => metricItems(WORKFLOW_ATTENTION_STATUSES));
const activeItems = computed(() => metricItems(WORKFLOW_ACTIVE_STATUSES));
/** 需要处理的总数：为 0 时整块换成一句平静的话，而不是三个「0」。 */
const attentionTotal = computed(() =>
  attentionItems.value.reduce((sum, item) => sum + item.count, 0)
);

const recentWorkflows = computed(() => latestWorkflows(workflows.value));

const activeProjectCount = computed(
  () => projects.value.filter((project) => project.status === "active").length
);
const archivedProjectCount = computed(
  () => projects.value.filter((project) => project.status === "archived").length
);

const workflowColumns: TableColumn<WorkflowSummary>[] = [
  { key: "requirement", label: "需求" },
  { key: "project", label: "项目" },
  { key: "status", label: "状态" },
  { key: "createdAt", label: "创建时间", align: "right" }
];

function reloadWorkflows() {
  void workflowsStore.loadWorkflows();
}

function reloadProjects() {
  void projectsStore.fetchProjects();
}

onMounted(() => {
  void projectsStore.fetchProjects();
  // 仅为「直接深链到 / 时也有数据」兜底；侧栏已经加载过时这里是空操作。
  if (workflows.value.length === 0 && !workflowsLoading.value) {
    void workflowsStore.loadWorkflows();
  }
});
</script>

<template>
  <PageContainer class="flex flex-col gap-[var(--section-gap)]">
    <PageHeader title="仪表盘" description="先看有没有卡住的，再看正在跑的，最后是规模。" />

    <!--
      三块工作流卡片共享一个 store，所以加载 / 错误只在最上面表达一次 ——
      否则会在三块里各显示一遍，或让「运行中 0」假装「没有在跑」。
    -->
    <Card v-if="workflowsLoading && workflows.length === 0" class="p-[var(--card-padding)]">
      <div class="grid gap-3" role="status" aria-label="加载中">
        <LoadingSkeleton class="h-6 w-40" />
        <LoadingSkeleton class="h-10" />
      </div>
    </Card>
    <ErrorState v-else-if="workflowsError" :message="workflowsError" @retry="reloadWorkflows" />

    <template v-else>
      <!--
        ① 与 ② 并排（W11）：两张指标卡原先各占一整行，各约 140px，把 ③ 的表格推到
        1440×900 首屏之外（第 5 行只差 15px 露不出来）。并排后省下约 160px，
        且两块本就是同一层级的问题（「有问题吗」/「在跑吗」），并排比上下更贴语义。
        1024px 以下仍上下堆叠 —— 那时每张卡只有约 330px，三列数字会挤。
      -->
      <div class="grid gap-[var(--section-gap)] lg:grid-cols-2">
        <!-- ① 需要处理：最优先，状态色 + 数量 -->
        <Card class="grid content-start gap-4 p-[var(--card-padding)]">
          <SectionHeader title="需要处理">
            <template #actions>
              <RouterLink
                :class="buttonVariants({ variant: 'link', size: 'sm' })"
                to="/workflows"
              >
                全部工作流
              </RouterLink>
            </template>
          </SectionHeader>

          <p
            v-if="attentionTotal === 0"
            class="m-0 flex items-center gap-2 text-body text-muted-foreground"
          >
            <CircleCheck class="size-4 shrink-0 text-success" aria-hidden="true" />
            当前没有失败、等待审批或已暂停的工作流。
          </p>
          <dl v-else class="m-0 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div v-for="item in attentionItems" :key="item.status" class="grid gap-1">
              <dt class="text-secondary text-muted-foreground">{{ item.label }}</dt>
              <dd
                class="m-0 text-metric tabular-nums"
                :class="item.count > 0 ? TONE_TEXT[item.tone] : 'text-muted-foreground'"
              >
                {{ item.count }}
              </dd>
            </div>
          </dl>
        </Card>

        <!-- ② 正在运行 -->
        <Card class="grid content-start gap-4 p-[var(--card-padding)]">
          <SectionHeader title="正在运行" />
          <dl class="m-0 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div v-for="item in activeItems" :key="item.status" class="grid gap-1">
              <dt class="text-secondary text-muted-foreground">{{ item.label }}</dt>
              <dd
                class="m-0 text-metric tabular-nums"
                :class="item.count > 0 ? TONE_TEXT[item.tone] : 'text-muted-foreground'"
              >
                {{ item.count }}
              </dd>
            </div>
          </dl>
        </Card>
      </div>

      <!-- ③ 最近的动态 -->
      <Card class="grid gap-4 p-[var(--card-padding)]">
        <SectionHeader title="最近工作流" />
        <EmptyState
          v-if="recentWorkflows.length === 0"
          title="还没有工作流。"
          description="需求分析会生成任务，从那里可以创建工作流。"
          size="compact"
        >
          <template #actions>
            <RouterLink
              :class="buttonVariants({ variant: 'secondary', size: 'sm' })"
              to="/requirements"
            >
              去看需求
            </RouterLink>
          </template>
        </EmptyState>
        <Card v-else class="overflow-hidden p-3">
          <Table
            :columns="workflowColumns"
            :rows="recentWorkflows"
            :row-key="(row) => row.id"
            :page-size="0"
            min-width="min-w-180"
          >
            <template #cell-requirement="{ row }">
              <RouterLink
                class="text-body font-medium text-primary hover:underline"
                :to="`/workflows/${row.id}`"
              >
                {{ row.requirementName || `需求 ${row.requirementId.slice(0, 8)}` }}
              </RouterLink>
            </template>
            <template #cell-project="{ row }">
              <span class="text-secondary text-muted-foreground">{{ row.projectName || "—" }}</span>
            </template>
            <template #cell-status="{ row }">
              <StatusBadge :tone="workflowStatusTone(row.status)">
                {{ workflowStatusLabel(row.status) }}
              </StatusBadge>
            </template>
            <template #cell-createdAt="{ row }">
              <span class="text-secondary text-muted-foreground">
                {{ formatDateTime(row.createdAt) }}
              </span>
            </template>
          </Table>
        </Card>
      </Card>
    </template>

    <!-- ④ 总量统计：最后 -->
    <Card class="grid gap-4 p-[var(--card-padding)]">
      <SectionHeader title="项目">
        <template #actions>
          <RouterLink :class="buttonVariants({ variant: 'link', size: 'sm' })" to="/projects">
            全部项目
          </RouterLink>
        </template>
      </SectionHeader>

      <div v-if="projectsLoading" class="grid gap-3" role="status" aria-label="加载中">
        <LoadingSkeleton class="h-10" />
      </div>
      <ErrorState v-else-if="projectsError" :message="projectsError" @retry="reloadProjects" />
      <!-- 一个项目都没有时，数字带给不出下一步；换成入口（沿用改造前的引导） -->
      <EmptyState
        v-else-if="projects.length === 0"
        title="还没有项目。"
        description="创建项目后即可绑定仓库，并开始需求与工作流。"
        size="compact"
      >
        <template #actions>
          <RouterLink :class="buttonVariants({ size: 'sm' })" to="/projects">新建项目</RouterLink>
        </template>
      </EmptyState>
      <dl v-else class="m-0 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div class="grid gap-1">
          <dt class="text-secondary text-muted-foreground">项目总数</dt>
          <dd class="m-0 text-metric tabular-nums text-foreground">{{ projects.length }}</dd>
        </div>
        <div class="grid gap-1">
          <dt class="text-secondary text-muted-foreground">启用中</dt>
          <dd class="m-0 text-metric tabular-nums text-primary">{{ activeProjectCount }}</dd>
        </div>
        <div class="grid gap-1">
          <dt class="text-secondary text-muted-foreground">已归档</dt>
          <dd class="m-0 text-metric tabular-nums text-foreground">{{ archivedProjectCount }}</dd>
        </div>
      </dl>
    </Card>
  </PageContainer>
</template>
