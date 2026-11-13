<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { AgentRunSummary, AgentType, TaskStatus } from "@ai-se/shared";
import {
  CopyableId,
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
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Dialog } from "../components/ui/dialog";
import { Drawer } from "../components/ui/drawer";
import { Label } from "../components/ui/label";
import { Table, type TableColumn } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import { agentTypeLabel, artifactTypeLabel } from "../viewmodels/agentRegistryViewModel";
import {
  agentOutcomeLabel,
  agentRunFailureView,
  agentRunTask,
  agentStatusLabel,
  agentStatusTone,
  attemptLabel,
  buildExecutionTrace,
  evidenceStatusLabel,
  formatDateTime,
  formatDuration,
  isActiveRun,
  issueSeverityLabel,
  recoveryBadgeText,
  recoveryStrategyText,
  taskOutcomeNote as buildTaskOutcomeNote,
  toolCallStatusLabel,
  traceKindLabel
} from "../viewmodels/agentRunViewModel";
import { taskStatusLabel } from "../viewmodels/requirementViewModel";
import { useAgentRunsStore } from "../stores/agentRuns";
import { useModEnterSubmit } from "../composables/useModEnterSubmit";

/**
 * AgentRunView（布局重构：表格 + 分页 + 抽屉详情 + 弹窗新建；承接 Phase 8-B / UX-03）。
 *
 * 业务层完全冻结（未改动一行 store / api / viewmodel / router 路由表）：
 *   · onMounted → loadRuns() + `route.query.run`（仅 onMounted 读取一次）
 *   · createRun 表单约束（DEFAULT_TASK / rows=5 / maxlength=2000 / v-model.trim /
 *     disabled = creating || !task.trim()）；cancelCurrentRun（无 confirm）；
 *     SSE snapshot + 2 秒轮询兜底；onUnmounted → stopRealtime()；`?run=` 深链接。
 *
 * UX-03 展示层全部保留（文案与结构一字未改）：
 *   · 列表：执行上下文（Agent / 项目 / 工作流 / 任务 / 尝试 / 用时）+ ID 降级 + 复制
 *   · 详情：执行摘要（目标 + 上下文链）、Execution Trace（工具调用 + 事件，时间升序、
 *     tool_call_* 去重、30+30 双头预览）、最终结果与产出物、失败上下文、恢复链路、Evidence。
 *
 * 布局与交互变化（与需求页 / 工作流页同构）：
 *   · 运行列表 → 组件库 Table（W7 收敛为 5 列：状态 / 任务 / 来源 / 尝试 · 用时 / 操作）
 *     + 内置分页（W7 起默认每页 10 条，纯前端切片，0 接口改动）
 *   · 操作列 = 「详情」（走既有 `/agent-run?run=` 深链接形态，打开右侧抽屉）+「取消」
 *     （仅活动运行，与详情按钮同一 store 动作）；「复制 ID」已改为任务列里 ID 文本本身
 *     可点复制（W7，不再占按钮位）
 *   · 详情（原右栏全部卡片）整体移入组件库 Drawer；关闭抽屉回到 /agent-run（URL 与可见
 *     状态一致，`?run=` 深链接与前进/后退不受影响）
 *   · 「新建运行」独立为页头按钮（替代原页头「创建运行」快捷按钮），表单位于组件库
 *     Dialog 弹窗中；创建成功后关闭弹窗并进入该运行的详情抽屉
 */
/** W8：表单内 Cmd/Ctrl + Enter 提交（`<textarea>` 里 Enter 是换行，提交不了）。 */
const onFormKeydown = useModEnterSubmit();
const DEFAULT_TASK = "修复项目中的测试失败问题，并确保所有测试通过。";

const store = useAgentRunsStore();
const route = useRoute();
const router = useRouter();
const { runs, currentRun, loading, detailLoading, creating, cancelling, error } =
  storeToRefs(store);
const task = ref(DEFAULT_TASK);

const selectedRun = computed(() => currentRun.value?.run ?? null);
const canCancel = computed(() => (selectedRun.value ? isActiveRun(selectedRun.value) : false));

/** `?run=` 深链接主键（既有深链接形态；抽屉开合与之一致）。 */
const selectedRunId = computed(() => (typeof route.query.run === "string" ? route.query.run : ""));
/** 「新建运行」弹窗开合。 */
const createOpen = ref(false);
/** 运行详情抽屉开合（与 `?run=` 同步：有 id = 打开）。 */
const detailOpen = ref(Boolean(selectedRunId.value));
/** 列表分页页码（纯前端分页：只切片已加载的列表）。 */
const listPage = ref(1);

/**
 * 运行列表表格列（W7 收敛：7 列 → 5 列）。
 *
 * 原来 7 列平铺在 1100px 宽里，一行有 4 个「标签：值」小段，扫读时眼睛要横向折返。
 * 现在把 **Agent / 项目** 并进「任务」列的次行（它们是同一条运行的执行上下文），
 * **工作流 / 任务键** 合成「来源」列，于是主列只剩一个可扫的名字。
 * 操作列不再有平级的第三个按钮：「复制 ID」改由任务列里的 ID 文本本身承担（`CopyableId`）。
 */
const runColumns: TableColumn<AgentRunSummary>[] = [
  { key: "status", label: "状态", sortable: true },
  {
    key: "task",
    label: "任务",
    sortable: true,
    sortValue: (row) => row.taskTitle || agentRunTask(row.input)
  },
  { key: "origin", label: "来源" },
  {
    key: "attempt",
    label: "尝试 · 用时",
    align: "right",
    sortable: true,
    sortValue: (row) => elapsedMs(row.startedAt, row.finishedAt) ?? null
  },
  { key: "actions", label: "操作", align: "right" }
];

/** 任务结果行：任务状态 + Agent 自报结果（解释 run 与 task 的判定差异）。 */
const taskResultText = computed(() => {
  const task = currentRun.value?.context.task;
  if (!task) {
    return "—";
  }
  const status = taskStatusLabel(task.status as TaskStatus);
  return task.outcome ? `${status} · Agent 结果：${agentOutcomeLabel(task.outcome)}` : status;
});

/** 运行成功但任务未通过时的解释（工作流页显示失败、运行页显示成功的原因所在）。 */
const taskNote = computed(() => (currentRun.value ? buildTaskOutcomeNote(currentRun.value) : null));

/** Agent 自报结果（run.output.outcome），专业 Agent 运行才有。 */
const agentOutcome = computed(() => {
  const outcome = currentRun.value?.run.output?.outcome;
  return typeof outcome === "string" && outcome !== "" ? outcome : undefined;
});

interface ResultIssueRow {
  severity: string;
  description: string;
  recommendation?: string;
}

/** 结果中的问题列表（run.output.issues，结构化结果的一部分）。 */
const resultIssues = computed<ResultIssueRow[]>(() => {
  const raw = currentRun.value?.run.output?.issues;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const description = typeof record.description === "string" ? record.description : "";
    if (description === "") {
      return [];
    }
    return [
      {
        severity: typeof record.severity === "string" ? record.severity : "MEDIUM",
        description,
        ...(typeof record.recommendation === "string"
          ? { recommendation: record.recommendation }
          : {})
      }
    ];
  });
});

/** Execution Summary：这次运行是为了完成什么。 */
const goal = computed(() => {
  if (!currentRun.value) {
    return "";
  }
  return currentRun.value.context.task?.title || agentRunTask(currentRun.value.run.input);
});

const failure = computed(() => (currentRun.value ? agentRunFailureView(currentRun.value) : null));

const traceNodes = computed(() => (currentRun.value ? buildExecutionTrace(currentRun.value) : []));

/**
 * Trace 预览：默认展示最早的 30 个 + 最近的 30 个节点（"从开始到结束"的阅读顺序 +
 * 运行现场可见）。中间部分通过「展开中间 N 条」按需加载 —— 现有 API 不分页，先复用
 * 现有数据能力（见 docs/96 后续优化点）。
 */
const PREVIEW_HEAD = 30;
const PREVIEW_TAIL = 30;
const traceExpanded = ref(false);
const traceView = computed(() => {
  const nodes = traceNodes.value;
  if (traceExpanded.value || nodes.length <= PREVIEW_HEAD + PREVIEW_TAIL) {
    return { head: nodes, tail: [] as typeof nodes, collapsed: 0 };
  }
  return {
    head: nodes.slice(0, PREVIEW_HEAD),
    tail: nodes.slice(-PREVIEW_TAIL),
    collapsed: nodes.length - PREVIEW_HEAD - PREVIEW_TAIL
  };
});

/** 打开某运行的详情抽屉（走既有 `?run=` 深链接形态，不新增路由）。 */
function openDetail(id: string) {
  void router.push({ path: "/agent-run", query: { run: id } });
}

/**
 * 行内「取消」：先确保该运行已加载为 currentRun（cancelCurrentRun 作用于 currentRun），
 * 再沿用既有 store 动作；加载失败时不对错误目标执行动作。
 */
async function handleRowCancel(run: AgentRunSummary) {
  if (!isActiveRun(run)) return;
  if (store.currentRun?.run.id !== run.id) {
    await store.loadRun(run.id);
  }
  if (store.currentRun?.run.id !== run.id) return;
  await store.cancelCurrentRun();
}

async function createRun() {
  if (!task.value.trim()) return;
  const previousId = store.currentRun?.run.id;
  await store.create(task.value);
  const createdId = store.currentRun?.run.id;
  if (createdId && createdId !== previousId) {
    createOpen.value = false;
    await router.push({ path: "/agent-run", query: { run: createdId } });
  }
}

function cancelRun() {
  void store.cancelCurrentRun();
}

/** 列表错误态的重试：沿用既有取数方法（store 内部会重置 loading / error）。 */
function reloadRuns() {
  void store.loadRuns();
}

/** 详情错误态的重试：能确定是哪次运行就重载它，否则退回列表。 */
function reloadDetail() {
  const id = selectedRun.value?.id ?? selectedRunId.value;
  if (id) {
    void store.loadRun(id);
    return;
  }
  void store.loadRuns();
}

function elapsedMs(startedAt?: string, finishedAt?: string): number | undefined {
  if (!startedAt) {
    return undefined;
  }

  const started = Date.parse(startedAt);
  const finished = finishedAt ? Date.parse(finishedAt) : Date.now();
  return Number.isFinite(started) && Number.isFinite(finished)
    ? Math.max(0, finished - started)
    : undefined;
}

function artifactPreview(content: Record<string, unknown>): string {
  try {
    return JSON.stringify(content, null, 2).slice(0, 600);
  } catch {
    return "";
  }
}

watch(selectedRunId, (id) => {
  detailOpen.value = Boolean(id);
  if (id) void store.loadRun(id);
});

/** 关闭详情抽屉 → 回到列表路由（URL 与可见状态保持一致；深链接与前进/后退不受影响）。 */
watch(detailOpen, (open) => {
  if (!open && selectedRunId.value) void router.push({ path: "/agent-run" });
});

onMounted(() => {
  void store.loadRuns();
  if (typeof route.query.run === "string") void store.loadRun(route.query.run);
});

onUnmounted(() => {
  store.stopRealtime();
});
</script>

<template>
  <PageContainer width="wide">
    <PageHeader title="Agent 运行">
      <template #actions>
        <Dialog
          v-model:open="createOpen"
          title="新建运行"
          description="直接把任务描述交给 Agent 执行；创建后会自动打开这次运行的详情。"
        >
          <template #trigger>
            <Button type="button">新建运行</Button>
          </template>
          <form
            class="grid gap-3"
            @submit.prevent="createRun"
            @keydown="onFormKeydown"
          >
            <div class="grid gap-1.5">
              <Label for="agent-run-task">任务</Label>
              <Textarea id="agent-run-task" v-model.trim="task" rows="5" maxlength="2000" />
            </div>
            <Button type="submit" :disabled="creating || !task.trim()">
              {{ creating ? "创建中…" : "开始" }}
            </Button>
          </form>
        </Dialog>
      </template>
    </PageHeader>

    <Card class="grid gap-4 p-[var(--card-padding)]">
      <SectionHeader title="运行列表">
        <template #actions>
          <Badge variant="secondary">{{ runs.length }}</Badge>
        </template>
      </SectionHeader>
      <TableSkeleton v-if="loading" :columns="runColumns.length" :rows="3" />
      <ErrorState v-else-if="error" :message="error" @retry="reloadRuns" />
      <EmptyState v-else-if="runs.length === 0" title="暂无 Agent 运行记录。" size="compact">
        <template #actions>
          <Button type="button" @click="createOpen = true">新建运行</Button>
        </template>
      </EmptyState>
      <div v-else class="min-w-0">
        <Table
          v-model:page="listPage"
          :columns="runColumns"
          :rows="runs"
          :row-key="(row) => row.id"
          min-width="min-w-240"
        >
          <template #cell-status="{ row }">
            <span class="grid justify-items-start gap-1">
              <StatusBadge :tone="agentStatusTone(row.status)">
                {{ agentStatusLabel(row.status) }}
              </StatusBadge>
              <span class="text-caption text-muted-foreground">
                {{ formatDateTime(row.startedAt ?? row.createdAt) }}
              </span>
            </span>
          </template>
          <template #cell-task="{ row }">
            <span class="grid justify-items-start gap-1">
              <strong class="break-words text-body font-semibold text-foreground">
                {{ row.taskTitle || agentRunTask(row.input) }}
              </strong>
              <span class="flex flex-wrap items-center gap-2 text-secondary text-muted-foreground">
                <span>Agent：{{ row.agentName || "编码 Agent" }}</span>
                <Badge v-if="row.agentType" variant="secondary">{{
                  agentTypeLabel(row.agentType as AgentType)
                }}</Badge>
                <span>项目：{{ row.projectName || "—" }}</span>
              </span>
              <CopyableId :id="row.id" />
            </span>
          </template>
          <template #cell-origin="{ row }">
            <span class="grid justify-items-start gap-1">
              <span class="text-secondary text-muted-foreground">
                工作流：{{ row.requirementName || row.workflowRunId?.slice(0, 8) || "—" }}
              </span>
              <span class="text-caption text-muted-foreground">
                任务：{{ row.taskKey ? `${row.taskKey} · ` : "" }}{{ row.taskTitle || "—" }}
              </span>
            </span>
          </template>
          <template #cell-attempt="{ row }">
            <span class="text-secondary text-muted-foreground">
              尝试 {{ attemptLabel(row.retryCount) }} · 用时
              {{ formatDuration(elapsedMs(row.startedAt, row.finishedAt)) }}
            </span>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex flex-wrap items-center justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" @click="openDetail(row.id)">
                详情
              </Button>
              <Button
                v-if="isActiveRun(row)"
                type="button"
                variant="destructive"
                size="sm"
                :disabled="cancelling"
                @click="handleRowCancel(row)"
              >
                {{ cancelling ? "取消中…" : "取消" }}
              </Button>
            </div>
          </template>
        </Table>
      </div>
    </Card>

    <Drawer v-model:open="detailOpen" title="运行详情">
      <ErrorState v-if="error" :message="error" @retry="reloadDetail" />
      <div
        v-else-if="detailLoading"
        class="grid gap-4"
        role="status"
        aria-label="加载中"
      >
        <LoadingSkeleton class="h-24 rounded-lg" />
        <LoadingSkeleton class="h-40 rounded-lg" />
      </div>
      <EmptyState v-else-if="!currentRun" title="请选择或创建 Agent 运行。" />

      <div v-else class="grid gap-5">
        <!-- 执行摘要：这次运行是为了完成什么 -->
        <Card class="p-[var(--card-padding)]">
          <SectionHeader title="执行摘要">
            <template #actions>
              <Button
                v-if="canCancel"
                variant="destructive"
                type="button"
                :disabled="cancelling"
                @click="cancelRun"
              >
                {{ cancelling ? "取消中…" : "取消" }}
              </Button>
            </template>
          </SectionHeader>
          <div class="grid gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <StatusBadge :tone="agentStatusTone(currentRun.run.status)">{{
                agentStatusLabel(currentRun.run.status)
              }}</StatusBadge>
              <Badge v-if="currentRun.context.agentType" variant="secondary">{{
                agentTypeLabel(currentRun.context.agentType as AgentType)
              }}</Badge>
              <span class="text-body font-semibold text-foreground">{{
                currentRun.context.agentName || "编码 Agent"
              }}</span>
            </div>
            <p class="m-0 break-words text-page-title font-semibold text-foreground">
              {{ goal }}
            </p>
            <dl class="m-0 grid grid-cols-1 gap-3 lg:grid-cols-3">
              <div class="border-t border-border pt-2.5">
                <dt class="text-caption text-muted-foreground">项目</dt>
                <dd class="m-0 mt-1 break-words text-body font-semibold text-foreground">
                  {{ currentRun.context.projectName || "—" }}
                </dd>
              </div>
              <div class="border-t border-border pt-2.5">
                <dt class="text-caption text-muted-foreground">工作流</dt>
                <dd class="m-0 mt-1 break-words text-body font-semibold text-foreground">
                  {{
                    currentRun.context.workflow
                      ? `${currentRun.context.workflow.requirementName || "需求"} · v${currentRun.context.workflow.planningVersion}`
                      : "—"
                  }}
                </dd>
              </div>
              <div class="border-t border-border pt-2.5">
                <dt class="text-caption text-muted-foreground">任务</dt>
                <dd class="m-0 mt-1 break-words text-body font-semibold text-foreground">
                  {{
                    currentRun.context.task
                      ? `${currentRun.context.task.taskKey} · ${currentRun.context.task.title}`
                      : "—"
                  }}
                </dd>
              </div>
              <div v-if="currentRun.context.task" class="border-t border-border pt-2.5">
                <dt class="text-caption text-muted-foreground">任务结果</dt>
                <dd class="m-0 mt-1 break-words text-body font-semibold text-foreground">
                  {{ taskResultText }}
                </dd>
              </div>
              <div class="border-t border-border pt-2.5">
                <dt class="text-caption text-muted-foreground">开始时间</dt>
                <dd class="m-0 mt-1 text-body font-semibold text-foreground">
                  {{ formatDateTime(currentRun.run.startedAt) }}
                </dd>
              </div>
              <div class="border-t border-border pt-2.5">
                <dt class="text-caption text-muted-foreground">耗时</dt>
                <dd class="m-0 mt-1 text-body font-semibold text-foreground">
                  {{
                    formatDuration(elapsedMs(currentRun.run.startedAt, currentRun.run.finishedAt))
                  }}
                </dd>
              </div>
              <div class="border-t border-border pt-2.5">
                <dt class="text-caption text-muted-foreground">尝试 · 迭代</dt>
                <dd class="m-0 mt-1 text-body font-semibold text-foreground">
                  {{ attemptLabel(currentRun.run.retryCount) }} ·
                  {{ currentRun.run.currentIteration }} / {{ currentRun.run.maxIterations }}
                </dd>
              </div>
            </dl>
            <p
              v-if="taskNote"
              class="m-0 break-words rounded-lg border border-border bg-muted px-3 py-2 text-body text-foreground"
            >
              {{ taskNote }}
              <RouterLink
                v-if="currentRun.context.workflow"
                class="ml-2 text-primary hover:underline"
                :to="`/workflows/${currentRun.context.workflow.id}`"
                >查看任务</RouterLink
              >
            </p>
            <CopyableId :id="currentRun.run.id" display="full" class="max-w-full" />
          </div>
        </Card>

        <!-- Execution Trace：阶段 → 动作 → Tool → 结果（时间升序，从开始看到结束） -->
        <Card class="p-[var(--card-padding)]">
          <SectionHeader title="执行轨迹">
            <template #actions>
              <Badge variant="secondary">{{ traceNodes.length }}</Badge>
            </template>
          </SectionHeader>
          <EmptyState v-if="traceNodes.length === 0" title="暂无执行记录。" size="compact" />
          <template v-else>
            <ol class="m-0 grid list-none gap-0 p-0">
              <li
                v-for="node in traceView.head"
                :id="node.anchorId"
                :key="node.id"
                class="grid gap-1.5 border-t border-border py-2.5 first:border-t-0 first:pt-0"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <span class="tone-dot" :data-tone="node.tone" aria-hidden="true" />
                  <strong class="break-words text-body font-medium text-foreground">{{
                    node.label
                  }}</strong>
                  <span class="text-caption text-muted-foreground">{{
                    traceKindLabel(node.kind)
                  }}</span>
                  <time class="text-caption text-muted-foreground" :datetime="node.at">{{
                    formatDateTime(node.at)
                  }}</time>
                  <span v-if="node.status" class="text-caption text-muted-foreground">{{
                    toolCallStatusLabel(node.status)
                  }}</span>
                  <span
                    v-if="node.durationMs !== undefined"
                    class="text-caption text-muted-foreground"
                    >{{ formatDuration(node.durationMs) }}</span
                  >
                </div>
                <p class="m-0 break-words text-body text-foreground">{{ node.summary }}</p>
                <dl
                  v-if="node.details.length"
                  class="m-0 grid gap-1 rounded-md border border-border bg-muted p-2"
                >
                  <div
                    v-for="detail in node.details"
                    :key="detail.label"
                    class="flex flex-wrap gap-2 text-caption"
                  >
                    <dt class="m-0 font-semibold text-muted-foreground">{{ detail.label }}</dt>
                    <dd class="m-0 break-all text-foreground">{{ detail.value }}</dd>
                  </div>
                </dl>
              </li>
            </ol>
            <div v-if="traceView.collapsed > 0" class="border-t border-border py-2.5">
              <Button variant="secondary" size="sm" @click="traceExpanded = true">
                展开中间 {{ traceView.collapsed }} 条
              </Button>
            </div>
            <ol
              v-if="traceView.tail.length"
              class="m-0 grid list-none gap-0 border-t border-border p-0 pt-2.5"
            >
              <li
                v-for="node in traceView.tail"
                :id="node.anchorId"
                :key="node.id"
                class="grid gap-1.5 border-t border-border py-2.5 first:border-t-0 first:pt-0"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <span class="tone-dot" :data-tone="node.tone" aria-hidden="true" />
                  <strong class="break-words text-body font-medium text-foreground">{{
                    node.label
                  }}</strong>
                  <span class="text-caption text-muted-foreground">{{
                    traceKindLabel(node.kind)
                  }}</span>
                  <time class="text-caption text-muted-foreground" :datetime="node.at">{{
                    formatDateTime(node.at)
                  }}</time>
                  <span v-if="node.status" class="text-caption text-muted-foreground">{{
                    toolCallStatusLabel(node.status)
                  }}</span>
                  <span
                    v-if="node.durationMs !== undefined"
                    class="text-caption text-muted-foreground"
                    >{{ formatDuration(node.durationMs) }}</span
                  >
                </div>
                <p class="m-0 break-words text-body text-foreground">{{ node.summary }}</p>
                <dl
                  v-if="node.details.length"
                  class="m-0 grid gap-1 rounded-md border border-border bg-muted p-2"
                >
                  <div
                    v-for="detail in node.details"
                    :key="detail.label"
                    class="flex flex-wrap gap-2 text-caption"
                  >
                    <dt class="m-0 font-semibold text-muted-foreground">{{ detail.label }}</dt>
                    <dd class="m-0 break-all text-foreground">{{ detail.value }}</dd>
                  </div>
                </dl>
              </li>
            </ol>
          </template>
        </Card>

        <!-- 结果：状态 / 摘要 / 输出 / 产出物（既有 agent_artifacts） -->
        <Card class="p-[var(--card-padding)]">
          <SectionHeader title="最终结果" />
          <div class="grid gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <StatusBadge :tone="agentStatusTone(currentRun.run.status)">{{
                agentStatusLabel(currentRun.run.status)
              }}</StatusBadge>
              <Badge v-if="agentOutcome" variant="secondary"
                >Agent 结果：{{ agentOutcomeLabel(agentOutcome) }}</Badge
              >
              <span
                v-if="typeof currentRun.run.output?.summary === 'string'"
                class="break-words text-body text-foreground"
                >{{ currentRun.run.output.summary }}</span
              >
            </div>
            <pre
              class="m-0 max-h-55 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted p-3 text-body text-foreground"
              >{{
                currentRun.run.output?.finalResult ||
                currentRun.run.error?.message ||
                (isActiveRun(currentRun.run)
                  ? "等待中"
                  : "本次运行没有文本输出（结构化结果见上）。")
              }}</pre
            >
            <div v-if="resultIssues.length" class="grid gap-2">
              <strong class="text-body font-semibold text-foreground"
                >问题（{{ resultIssues.length }}）</strong
              >
              <div
                v-for="(issue, index) in resultIssues.slice(0, 5)"
                :key="index"
                class="grid gap-1 rounded-lg border border-border p-3"
              >
                <div class="flex flex-wrap items-start gap-2">
                  <Badge variant="secondary">{{ issueSeverityLabel(issue.severity) }}</Badge>
                  <span class="break-words text-body text-foreground">{{ issue.description }}</span>
                </div>
                <p
                  v-if="issue.recommendation"
                  class="m-0 break-words text-caption text-muted-foreground"
                >
                  {{ issue.recommendation }}
                </p>
              </div>
            </div>
            <div v-if="currentRun.artifacts.length" class="grid gap-2">
              <strong class="text-body font-semibold text-foreground"
                >产出物（{{ currentRun.artifacts.length }}）</strong
              >
              <div
                v-for="artifact in currentRun.artifacts"
                :key="artifact.id"
                class="grid gap-2 rounded-lg border border-border p-3"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{{ artifactTypeLabel(artifact.type) }}</Badge>
                  <strong class="break-words text-body font-semibold text-foreground">{{
                    artifact.name
                  }}</strong>
                  <span class="text-caption text-muted-foreground">{{
                    formatDateTime(artifact.createdAt)
                  }}</span>
                </div>
                <details>
                  <summary class="cursor-pointer text-caption text-muted-foreground">
                    查看内容
                  </summary>
                  <pre
                    class="m-0 mt-2 max-h-55 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted p-3 text-caption text-foreground"
                    >{{ artifactPreview(artifact.content) }}</pre
                  >
                </details>
              </div>
            </div>
          </div>
        </Card>

        <!-- 失败上下文：类型 / 摘要 / 错误 / 任务 / 工具 / 尝试 -->
        <Card v-if="failure" class="p-[var(--card-padding)]">
          <SectionHeader title="失败上下文">
            <template #actions>
              <StatusBadge :tone="failure.tone">{{ failure.typeLabel }}</StatusBadge>
            </template>
          </SectionHeader>
          <dl class="m-0">
            <DetailRow label="失败类型">
              {{ failure.typeLabel }}（{{ failure.typeCode }}）
            </DetailRow>
            <DetailRow label="摘要">{{ failure.summary }}</DetailRow>
            <DetailRow
              v-if="failure.errorMessage"
              label="错误"
              value-class="break-all whitespace-pre-wrap"
            >
              {{ failure.errorMessage }}
            </DetailRow>
            <DetailRow v-if="currentRun.context.task" label="任务">
              {{ currentRun.context.task.taskKey }} · {{ currentRun.context.task.title }}
              <RouterLink
                v-if="currentRun.context.workflow"
                class="ml-2 text-primary hover:underline"
                :to="`/workflows/${currentRun.context.workflow.id}`"
                >查看任务</RouterLink
              >
            </DetailRow>
            <DetailRow v-if="failure.failedTool" label="工具">
              {{ failure.failedTool.toolName }}（{{ failure.failedTool.error?.code || "失败" }}）
              <a
                class="ml-2 text-primary hover:underline"
                :href="`#tool-${failure.failedTool.toolCallId}`"
                >查看工具调用</a
              >
            </DetailRow>
            <DetailRow label="尝试">
              {{ failure.attempt }}
              <template v-if="failure.taskRetry !== null">
                · 任务重试 {{ failure.taskRetry }}
              </template>
            </DetailRow>
          </dl>
        </Card>

        <!-- 恢复链路：Retry / Re-plan / Recovery（既有引擎事件与诊断任务） -->
        <Card v-if="currentRun.recovery" class="p-[var(--card-padding)]">
          <SectionHeader title="恢复">
            <template #actions>
              <Badge variant="secondary">{{ recoveryBadgeText(currentRun.recovery) }}</Badge>
            </template>
          </SectionHeader>
          <dl class="m-0">
            <DetailRow v-if="currentRun.recovery.strategy" label="策略">
              {{ recoveryStrategyText(currentRun.recovery.strategy) }}
            </DetailRow>
            <DetailRow v-if="currentRun.recovery.reason" label="原因">
              {{ currentRun.recovery.reason }}
            </DetailRow>
            <DetailRow label="任务级重试">
              {{
                currentRun.recovery.maxRetries === null
                  ? `${currentRun.recovery.taskRetryCount}`
                  : `${currentRun.recovery.taskRetryCount} / ${currentRun.recovery.maxRetries}`
              }}
              <template v-if="currentRun.recovery.humanRequired"> · 需要人工介入</template>
              <template v-if="currentRun.recovery.stalled"> · 已停滞</template>
            </DetailRow>
            <DetailRow v-if="currentRun.recovery.recoveryTask" label="诊断任务">
              {{ currentRun.recovery.recoveryTask.taskKey }} ·
              {{ currentRun.recovery.recoveryTask.title }}
              <RouterLink
                v-if="currentRun.context.workflow"
                class="ml-2 text-primary hover:underline"
                :to="`/workflows/${currentRun.context.workflow.id}`"
                >查看恢复任务</RouterLink
              >
            </DetailRow>
          </dl>
        </Card>

        <!-- Evidence：仅展示已存在的记录（当前数据源为空时不渲染） -->
        <Card v-if="currentRun.evidence.length" class="p-[var(--card-padding)]">
          <SectionHeader title="Evidence">
            <template #actions>
              <Badge variant="secondary">{{ currentRun.evidence.length }}</Badge>
            </template>
          </SectionHeader>
          <ul class="m-0 grid list-none gap-0 p-0">
            <li
              v-for="record in currentRun.evidence"
              :key="record.id"
              class="flex flex-wrap items-center gap-2 border-t border-border py-2.5 first:border-t-0 first:pt-0"
            >
              <StatusBadge
                :tone="record.verification.status === 'VERIFIED' ? 'success' : 'error'"
                >{{ evidenceStatusLabel(record.verification.status) }}</StatusBadge
              >
              <span class="text-body text-foreground">结果：{{ record.result.status }}</span>
              <span class="text-caption text-muted-foreground">{{
                formatDateTime(record.createdAt)
              }}</span>
            </li>
          </ul>
        </Card>
      </div>
    </Drawer>
  </PageContainer>
</template>
