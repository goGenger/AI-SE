<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import type { AutonomyOutcome, AutonomyRunRecord } from "../api/autonomyRuns";
import {
  DetailRow,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  PageContainer,
  PageHeader,
  SectionHeader,
  StatusBadge,
  TableSkeleton
} from "../components/common";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Drawer } from "../components/ui/drawer";
import { Select, type SelectOption } from "../components/ui/select";
import { Table, type TableColumn } from "../components/ui/table";
import { useAutonomyRunsStore } from "../stores/autonomyRuns";
import { useProjectsStore } from "../stores/projects";
import {
  autonomyDiagnosisText,
  autonomyFailureLabel,
  autonomyOutcomeLabel,
  autonomyOutcomeTone,
  autonomyRepairTaskLine,
  autonomyRoundLabel,
  autonomySliceRequirementLabel,
  autonomyTriggerReasonDistinct,
  autonomyWorkflowLinkLabel,
  filterAutonomyRuns,
  formatAutonomyDateTime
} from "../viewmodels/autonomyRunViewModel";

/**
 * 自治记录：与「工作流」同构（列表表格 + 项目筛选 + 抽屉详情）。
 * 与「事件」告警台相互独立。
 */

const route = useRoute();
const router = useRouter();
const projects = useProjectsStore();
const autonomy = useAutonomyRunsStore();

const selectedId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));

const workflowFilter = computed(() => {
  const value = route.query.workflowId;
  return typeof value === "string" ? value : "";
});

/** 项目筛选：与 ?projectId= 同步，便于深链与工作流横幅带参。 */
const filterProjectId = computed({
  get: () => {
    const value = route.query.projectId;
    return typeof value === "string" ? value : "";
  },
  set: (value: string) => {
    void replaceListQuery({ projectId: value || undefined });
  }
});

const filterOutcome = ref<AutonomyOutcome | "">("");
const detailOpen = ref(Boolean(selectedId.value));
const listPage = ref(1);

const filterProjectOptions = computed<SelectOption[]>(() => [
  { value: "", label: "全部项目" },
  ...projects.projects.map((project) => ({ value: project.id, label: project.name }))
]);

const filterOutcomeOptions: SelectOption[] = [
  { value: "", label: "全部结果" },
  { value: "in_progress", label: autonomyOutcomeLabel("in_progress") },
  { value: "repaired", label: autonomyOutcomeLabel("repaired") },
  { value: "exhausted", label: autonomyOutcomeLabel("exhausted") },
  { value: "failed", label: autonomyOutcomeLabel("failed") }
];

const runColumns: TableColumn<AutonomyRunRecord>[] = [
  { key: "task", label: "任务", sortable: true, sortValue: (row) => row.sourceTaskKey },
  { key: "project", label: "项目", sortable: true, sortValue: (row) => row.projectName || "" },
  {
    key: "slice",
    label: "切片/需求",
    sortable: true,
    sortValue: (row) => autonomySliceRequirementLabel(row)
  },
  { key: "outcome", label: "结果", sortable: true, sortValue: (row) => row.outcome },
  {
    key: "triggeredAt",
    label: "触发时间",
    align: "right",
    sortable: true,
    sortValue: (row) => row.triggeredAt
  },
  { key: "actions", label: "操作", align: "right" }
];

const visibleRuns = computed(() =>
  filterAutonomyRuns(autonomy.runs, {
    projectId: filterProjectId.value,
    workflowId: workflowFilter.value,
    outcome: filterOutcome.value
  })
);

const showDistinctTriggerReason = computed(() => {
  const current = autonomy.current;
  if (!current) return false;
  return autonomyTriggerReasonDistinct(current.triggerReason, current.diagnosisSummary);
});

/** 保留列表筛选 query（关闭抽屉 / 打开详情共用）。 */
function listQuery(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const next: Record<string, string | undefined> = {
    projectId: filterProjectId.value || undefined,
    workflowId: workflowFilter.value || undefined,
    ...overrides
  };
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(next)) {
    if (value) cleaned[key] = value;
  }
  return cleaned;
}

function replaceListQuery(overrides: Record<string, string | undefined>) {
  const path = selectedId.value
    ? `/autonomy-runs/${encodeURIComponent(selectedId.value)}`
    : "/autonomy-runs";
  void router.replace({ path, query: listQuery(overrides) });
}

function openDetail(id: string) {
  void router.push({
    path: `/autonomy-runs/${encodeURIComponent(id)}`,
    query: listQuery()
  });
}

function closeDetail() {
  void router.push({ path: "/autonomy-runs", query: listQuery() });
}

function clearWorkflowFilter() {
  void router.replace({
    path: selectedId.value
      ? `/autonomy-runs/${encodeURIComponent(selectedId.value)}`
      : "/autonomy-runs",
    query: listQuery({ workflowId: undefined })
  });
}

function reload() {
  void autonomy.load("").then(() => {
    if (selectedId.value) autonomy.select(selectedId.value);
  });
}

watch(selectedId, (id) => {
  detailOpen.value = Boolean(id);
  if (id) autonomy.select(id);
  else autonomy.clearCurrent();
});

watch(detailOpen, (open) => {
  if (!open && selectedId.value) closeDetail();
});

watch([filterProjectId, filterOutcome, workflowFilter], () => {
  listPage.value = 1;
});

onMounted(async () => {
  await Promise.all([projects.fetchProjects(), autonomy.load("")]);
  if (selectedId.value) autonomy.select(selectedId.value);
});
</script>

<template>
  <PageContainer width="wide">
    <PageHeader
      title="自治记录"
      description="工作流失败后的自动诊断与修复记录，按项目查看；与「事件」告警台相互独立。"
    />

    <Card class="grid gap-4 p-[var(--card-padding)]">
      <SectionHeader title="自治记录列表" />
      <div class="flex flex-wrap items-center gap-2">
        <Select
          id="autonomy-filter-project"
          v-model="filterProjectId"
          :options="filterProjectOptions"
          aria-label="按项目筛选"
          class="w-60"
        />
        <Select
          id="autonomy-filter-outcome"
          v-model="filterOutcome"
          :options="filterOutcomeOptions"
          aria-label="按结果筛选"
          class="w-50"
        />
      </div>
      <div
        v-if="workflowFilter"
        class="flex flex-wrap items-center gap-2 text-caption text-muted-foreground"
      >
        <span class="min-w-0 truncate" :title="workflowFilter">
          已按工作流过滤 {{ workflowFilter.slice(0, 8) }}…
        </span>
        <Button type="button" variant="outline" size="sm" @click="clearWorkflowFilter">
          清除工作流过滤
        </Button>
      </div>

      <TableSkeleton
        v-if="autonomy.loading && !autonomy.runs.length"
        :columns="runColumns.length"
        :rows="3"
      />
      <ErrorState v-else-if="autonomy.error" :message="autonomy.error" @retry="reload" />
      <EmptyState
        v-else-if="!autonomy.runs.length"
        title="暂无自治记录"
        description="任务失败并进入自动诊断与修复后，会出现在这里。"
        size="compact"
      />
      <EmptyState
        v-else-if="!visibleRuns.length"
        title="没有符合筛选条件的自治记录。"
        size="compact"
      />
      <div v-else class="min-w-0">
        <Table
          v-model:page="listPage"
          :columns="runColumns"
          :rows="visibleRuns"
          :row-key="(row) => row.id"
          min-width="min-w-220"
        >
          <template #cell-task="{ row }">
            <span class="grid min-w-0 justify-items-start gap-1">
              <strong class="break-words text-body font-semibold text-foreground">
                {{ row.sourceTaskKey }}
              </strong>
              <span class="line-clamp-1 break-words text-caption text-muted-foreground">
                {{ row.sourceTaskTitle }}
              </span>
            </span>
          </template>
          <template #cell-project="{ row }">
            <span class="text-secondary text-muted-foreground">
              {{ row.projectName || "未关联项目" }}
            </span>
          </template>
          <template #cell-slice="{ row }">
            <span class="break-words text-secondary text-muted-foreground">
              {{ autonomySliceRequirementLabel(row) }}
            </span>
          </template>
          <template #cell-outcome="{ row }">
            <StatusBadge :tone="autonomyOutcomeTone(row.outcome)">
              {{ autonomyOutcomeLabel(row.outcome) }}
            </StatusBadge>
          </template>
          <template #cell-triggeredAt="{ row }">
            <span class="text-secondary text-muted-foreground">
              {{ formatAutonomyDateTime(row.triggeredAt) }}
            </span>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex flex-wrap items-center justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" @click="openDetail(row.id)">
                详情
              </Button>
            </div>
          </template>
        </Table>
      </div>
    </Card>

    <Drawer v-model:open="detailOpen" title="自治详情">
      <div
        v-if="autonomy.loading && !autonomy.current && selectedId"
        class="grid gap-4"
        role="status"
        aria-label="加载中"
      >
        <LoadingSkeleton class="h-24 rounded-lg" />
        <LoadingSkeleton class="h-40 rounded-lg" />
      </div>
      <EmptyState
        v-else-if="!autonomy.current"
        title="未找到该自治记录"
        description="谱系可能已不在列表中，请关闭后从列表重新打开。"
      />

      <div v-else class="grid gap-5">
        <Card class="grid gap-4 overflow-hidden p-[var(--card-padding)]">
          <SectionHeader eyebrow="自治谱系" :title="autonomy.current.sourceTaskKey">
            <template #actions>
              <StatusBadge :tone="autonomyOutcomeTone(autonomy.current.outcome)">
                {{ autonomyOutcomeLabel(autonomy.current.outcome) }}
              </StatusBadge>
            </template>
          </SectionHeader>

          <p class="m-0 break-words text-secondary text-muted-foreground">
            {{ autonomy.current.sourceTaskTitle }}
          </p>
          <p
            v-if="autonomy.current.sourceTaskId"
            class="m-0 truncate text-caption text-muted-foreground"
            :title="autonomy.current.sourceTaskId"
          >
            源任务 ID {{ autonomy.current.sourceTaskId }}
          </p>

          <dl class="m-0">
            <DetailRow label="触发时间">
              {{ formatAutonomyDateTime(autonomy.current.triggeredAt) }}
            </DetailRow>
            <DetailRow label="项目">
              {{ autonomy.current.projectName || "—" }}
            </DetailRow>
            <DetailRow label="需求">
              {{ autonomy.current.requirementName || "—" }}
            </DetailRow>
            <DetailRow v-if="autonomy.current.sliceKey" label="切片">
              {{ autonomy.current.sliceKey }}
            </DetailRow>
            <DetailRow label="规划版本">v{{ autonomy.current.planningVersion }}</DetailRow>
            <DetailRow label="源任务类型">
              {{ autonomy.current.sourceTaskType || "—" }}
            </DetailRow>
            <DetailRow label="失败类">
              {{ autonomyFailureLabel(autonomy.current.failureClass) }}
              <span v-if="autonomy.current.errorType" class="text-muted-foreground">
                · {{ autonomy.current.errorType }}
              </span>
            </DetailRow>
            <DetailRow label="轮次">{{ autonomyRoundLabel(autonomy.current) }}</DetailRow>
            <DetailRow label="工作流">
              <RouterLink class="break-words text-primary hover:underline" :to="autonomy.current.link">
                {{ autonomyWorkflowLinkLabel(autonomy.current) }}
              </RouterLink>
            </DetailRow>
          </dl>
        </Card>

        <Card class="grid gap-4 overflow-hidden p-[var(--card-padding)]">
          <SectionHeader title="诊断" />
          <div v-if="showDistinctTriggerReason" class="grid gap-2">
            <p class="m-0 text-caption font-semibold text-muted-foreground">触发原因</p>
            <div
              class="max-h-40 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-body leading-relaxed break-words whitespace-pre-wrap"
            >
              {{ autonomyDiagnosisText(autonomy.current.triggerReason) }}
            </div>
          </div>
          <div
            class="max-h-72 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-body leading-relaxed break-words whitespace-pre-wrap"
          >
            {{ autonomyDiagnosisText(autonomy.current.diagnosisSummary) }}
          </div>
        </Card>

        <Card class="grid gap-4 overflow-hidden p-[var(--card-padding)]">
          <SectionHeader title="修复任务" />
          <EmptyState
            v-if="autonomy.current.repairTasks.length === 0"
            title="尚无修复任务"
            description="仅出现失败路由、尚未创建动态修复任务。"
            size="compact"
          />
          <ul v-else class="m-0 grid list-none gap-3 p-0">
            <li
              v-for="task in autonomy.current.repairTasks"
              :key="task.taskKey"
              class="overflow-hidden rounded-lg border border-border bg-muted/40 px-3 py-2 text-body"
            >
              <div class="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                <span>{{ autonomyRepairTaskLine(task) }}</span>
              </div>
              <div class="mt-1 break-words font-semibold text-foreground">{{ task.taskKey }}</div>
              <p class="m-0 mt-0.5 line-clamp-2 break-words text-secondary text-muted-foreground">
                {{ task.title }}
              </p>
            </li>
          </ul>
          <div>
            <RouterLink
              class="inline-flex appearance-none items-center rounded-md border border-border bg-transparent px-3 py-1.5 text-body text-primary transition-colors hover:bg-muted"
              :to="autonomy.current.link"
            >
              打开原工作流
            </RouterLink>
          </div>
        </Card>
      </div>
    </Drawer>
  </PageContainer>
</template>
