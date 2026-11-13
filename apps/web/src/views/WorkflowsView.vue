<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import type {
  Task,
  UpdateWorkflowPolicyInput,
  WorkflowStatus,
  WorkflowSummary
} from "@ai-se/shared";
import { listRequirements } from "../api/requirements";
import {
  ConfirmDialog,
  CopyableId,
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
import { Checkbox } from "../components/ui/checkbox";
import { Dialog } from "../components/ui/dialog";
import { Drawer } from "../components/ui/drawer";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Pagination } from "../components/ui/pagination";
import { Select, type SelectOption } from "../components/ui/select";
import { Table, type TableColumn } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import TraceTree from "../components/TraceTree.vue";
import { useProjectsStore } from "../stores/projects";
import { WORKFLOW_EVENTS_PAGE_SIZE, useWorkflowsStore } from "../stores/workflows";
import { eventLabel } from "../viewmodels/agentRunViewModel";
import { taskTypeLabel } from "../viewmodels/requirementViewModel";
import {
  canPause,
  canResume,
  canRetry,
  canStart,
  displayTaskStatusLabel,
  displayTaskStatusTone,
  eventTimeLabel,
  failureStrategyLabel,
  filterWorkflows,
  normalizeWorkspacePath,
  taskAgentRunId,
  taskDependencies,
  taskResolutionNote,
  deriveAutonomyRepairProgress,
  workflowDurationLabel,
  workflowEventView,
  workflowProgressLabel,
  workflowStatusLabel,
  workflowStatusTone,
  workflowTaskProgress,
  workflowTimeLabel
} from "../viewmodels/workflowViewModel";
import {
  defaultExpandedTraceNodeIds,
  toggleTraceNodeId,
  traceCountsLabel
} from "../viewmodels/workflowTraceViewModel";
import { useModEnterSubmit } from "../composables/useModEnterSubmit";

/**
 * WorkflowsView（布局重构：表格 + 分页 + 抽屉详情 + 弹窗新建；承接 Phase 7-B / UX-02）。
 *
 * 业务层完全冻结（未改动一行 store / api / viewmodel / router 路由表）：
 *   · onMounted → Promise.all(fetchProjects, loadWorkflows) → 有深链接 id 时 loadWorkflow
 *   · watch(selectedId) → 同步抽屉开合 + loadWorkflow（深链接 / 详情按钮 / 创建后跳转共用）
 *   · watch(projectId) → 清空 requirementId + 直连 listRequirements（**不经 requirements store**）
 *   · create() 守卫 + normalizeWorkspacePath + policy（allowRetry/allowReplan 由策略推导）
 *   · Start / Pause / Resume / Retry / Cancel 的可见性条件与 `disabled="acting"` 逐字保留
 *   · Approval approve（一键，**无 disabled**）/ reject（W12 起走统一 ConfirmDialog 收集修改意见）、
 *     SSE + 2s 轮询兜底、onBeforeUnmount → stopRealtime
 *   · 表单字段与校验（required / min / max / maxlength / v-model.trim / v-model.number）原样
 *   · 全部业务文案、状态枚举、Loading / Error / Empty 分支原样
 *
 * 布局与交互变化（与需求页同构）：
 *   · 工作流列表 → 组件库 Table（状态 / 需求 / 项目 / 进度 / 更新时间 / 操作）+ 内置分页
 *     （W7 起默认每页 10 条，纯前端切片，未改接口）；筛选（全部项目 / 全部状态）上移到列表工具行
 *   · 操作列 = 「详情」（走既有 /workflows/:id 路由，打开右侧抽屉）+ 状态主操作
 *     （开始 / 暂停 / 继续 / 重试失败任务，与详情页同源判定）；「复制 ID」已改为需求列里
 *     ID 文本本身可点复制（W7，不再占按钮位）
 *   · 工作流详情（状态与生命周期操作 + 元数据 + 预算调整 + 审批 + 工作流图 + 追踪 + 事件时间线）
 *     整体移入组件库 Drawer；关闭抽屉回到 /workflows（URL 与可见状态一致，深链接不受影响）
 *   · 「新建工作流」独立为页头按钮，表单位于组件库 Dialog 弹窗中（创建成功后关闭弹窗并进入详情）
 *
 * TF-M3（追踪前端）：详情内新增「追踪」区，渲染 7-C 的端到端追踪树（按需加载，不并入 loadWorkflow）。
 */
/** W8：表单内 Cmd/Ctrl + Enter 提交（`<textarea>` 里 Enter 是换行，提交不了）。 */
const onFormKeydown = useModEnterSubmit();
const route = useRoute();
const router = useRouter();
const projects = useProjectsStore();
const workflows = useWorkflowsStore();
const projectId = ref("");
const requirementId = ref("");
const sliceKey = ref("");
const planningVersion = ref("");
const requirements = ref<Awaited<ReturnType<typeof listRequirements>>>([]);
const workspacePath = ref("");
const maxConcurrency = ref(2);
const maxRetries = ref(1);
const failureStrategy = ref<"FAIL_FAST" | "RETRY" | "CONTINUE" | "REPLAN" | "ROLLBACK">(
  "FAIL_FAST"
);
const approvalRequired = ref(false);
// T6：预算上限（创建表单；空 = 不限制）
const budgetCostUsd = ref("");
const budgetTokens = ref("");
const budgetWallClockMs = ref("");
// T6：预算调整（详情面板；空 = 清除该上限）
const editCostUsd = ref("");
const editTokens = ref("");
const editWallClock = ref("");

const selectedId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));

/** 「新建工作流」弹窗开合。 */
const createOpen = ref(false);
/** 工作流详情抽屉开合（与路由 :id 同步：有 id = 打开）。 */
const detailOpen = ref(Boolean(selectedId.value));
/** 列表分页页码（纯前端分页：只切片已加载并筛选后的列表）。 */
const listPage = ref(1);

/** 项目下拉选项（首项沿用既有文案「选择项目」） */
const projectOptions = computed<SelectOption[]>(() => [
  { value: "", label: "选择项目" },
  ...projects.projects.map((project) => ({ value: project.id, label: project.name }))
]);

/** 需求下拉选项（仅 ANALYZED，沿用既有过滤条件与文案） */
const requirementOptions = computed<SelectOption[]>(() => [
  { value: "", label: "选择已分析的需求" },
  ...requirements.value
    .filter((item) => item.status === "ANALYZED")
    .map((item) => ({ value: item.id, label: item.title }))
]);

/** 失败策略下拉选项（选项文案与顺序与既有实现一致） */
const failureStrategyOptions: SelectOption[] = [
  { value: "FAIL_FAST", label: "快速失败" },
  { value: "RETRY", label: "重试" },
  { value: "CONTINUE", label: "继续" },
  { value: "REPLAN", label: "重规划" },
  { value: "ROLLBACK", label: "回滚部署" }
];
const activeApprovals = computed(
  () => workflows.current?.approvals.filter((approval) => approval.status === "PENDING") ?? []
);

/**
 * 拒绝任务审批：走统一的 `ConfirmDialog`（W8 定的全站唯一危险确认方式），并在其中收集
 * **修改意见**。整条链路本来就支持 comment（`ApprovalDecisionSchema` 允许 ≤1000 字，
 * `WorkflowEngine.reject(id, comment)` 会落库）—— 之前只是这个页面没接。
 *
 * 批准**不套确认框**：批准不需要理由，多一步纯属摩擦；它也因此保持一键提交（未改）。
 * 待拒绝的审批只存 id，标题由 taskId 反查当前任务 —— 不另存一份可能过期的副本。
 */
const pendingRejectId = ref<string | null>(null);
const rejectComment = ref("");
const rejecting = ref(false);
const rejectError = ref("");

const pendingRejectTitle = computed(() => {
  const approval = workflows.current?.approvals.find((item) => item.id === pendingRejectId.value);
  return workflows.current?.tasks.find((task) => task.id === approval?.taskId)?.title ?? "";
});

/** 打开某一行的拒绝确认（每次打开都清掉上一次的意见与失败信息）。 */
function openRejectConfirm(approvalId: string) {
  rejectError.value = "";
  rejectComment.value = "";
  pendingRejectId.value = approvalId;
}

async function confirmReject() {
  const approvalId = pendingRejectId.value;
  if (!approvalId) return;
  rejecting.value = true;
  rejectError.value = "";
  const ok = await workflows.decide(approvalId, "reject", rejectComment.value.trim());
  rejecting.value = false;
  if (ok) {
    pendingRejectId.value = null;
    rejectComment.value = "";
    return;
  }
  // 失败时**不关闭确认框**并把原因显示在里面：关掉它等于告诉用户「已经拒了」
  // （同 `ProjectsView.removeProject`；页面级 `workflows.error` 也照旧会显示同一条）。
  rejectError.value = workflows.error || "拒绝失败";
}

/** 工作流列表表格列（字段与旧列表项一致：状态 / 需求 / 项目 / 进度 / 时间 + 操作）。 */
const workflowColumns: TableColumn<WorkflowSummary>[] = [
  { key: "status", label: "状态", sortable: true },
  { key: "requirement", label: "需求", sortable: true },
  { key: "project", label: "项目", sortable: true },
  {
    key: "progress",
    label: "进度",
    sortable: true,
    sortValue: (row) => row.taskProgress.completed
  },
  { key: "updatedAt", label: "更新时间", align: "right", sortable: true },
  { key: "actions", label: "操作", align: "right" }
];

// ── UX-02：Workflow Context & Timeline ──────────────────────────────────────
// 列表筛选（Project 数据复用既有 projects store，不新建独立 Store）
const filterProjectId = ref("");
const filterStatus = ref<WorkflowStatus | "">("");

const filterProjectOptions = computed<SelectOption[]>(() => [
  { value: "", label: "全部项目" },
  ...projects.projects.map((project) => ({ value: project.id, label: project.name }))
]);

const filterStatusOptions: SelectOption[] = [
  { value: "", label: "全部状态" },
  ...(
    ["PENDING", "RUNNING", "PAUSED", "WAITING_APPROVAL", "SUCCESS", "FAILED", "CANCELLED"] as const
  ).map((status) => ({ value: status, label: workflowStatusLabel(status) }))
];

const visibleWorkflows = computed(() =>
  filterWorkflows(workflows.workflows, {
    projectId: filterProjectId.value,
    status: filterStatus.value
  })
);

/** 详情上下文（项目 / 需求名）：取自已加载的列表 Summary，不新增请求。 */
const currentSummary = computed(() =>
  workflows.workflows.find((workflow) => workflow.id === workflows.current?.workflow.id)
);

/** 详情进度：SUCCESS + 已解决 FAILED（与列表服务端 countWorkflowTaskProgress 同源）。 */
const detailProgress = computed(() => workflowTaskProgress(workflows.current?.tasks ?? []));

/** AFC-M5：自治修复进度（轮次 / 失败类 / 一行证据）；耗尽时可读。 */
const autonomyRepair = computed(() =>
  deriveAutonomyRepairProgress(
    workflows.events?.items ?? workflows.current?.events ?? [],
    workflows.current?.workflow.status
  )
);

/** 行内状态主操作（与详情页按钮同源判定：canStart / canPause / canResume / canRetry）。 */
function rowAction(
  status: WorkflowStatus
): { id: "start" | "pause" | "resume" | "retry"; label: string } | null {
  if (canStart(status)) return { id: "start", label: "开始" };
  if (canPause(status)) return { id: "pause", label: "暂停" };
  if (canResume(status)) return { id: "resume", label: "继续" };
  if (canRetry(status)) return { id: "retry", label: "重试失败任务" };
  return null;
}

/** 打开某工作流详情（走既有路由，不新增路由；watch(selectedId) 负责加载与开抽屉）。 */
function openDetail(id: string) {
  void router.push(`/workflows/${id}`);
}

/**
 * 行内主操作：先确保该工作流已加载为 current（act/decide 均作用于 current），
 * 再沿用既有 store 动作；加载失败时不对错误目标执行动作。
 */
async function handleRowAction(workflow: WorkflowSummary) {
  const action = rowAction(workflow.status);
  if (!action) return;
  if (workflows.current?.workflow.id !== workflow.id) {
    await workflows.loadWorkflow(workflow.id);
  }
  if (workflows.current?.workflow.id !== workflow.id) return;
  await workflows.act(action.id);
}

/**
 * 任务卡上的 Agent 运行跳转目标：优先取快照事件里该任务最新的运行
 * （运行中即有值），回退到任务 output.agentRunId。
 */
function taskRunId(task: Task): string | undefined {
  return taskAgentRunId(task, workflows.current?.events ?? []);
}

/** 时间线事件 → 展示模型（数据来自服务端分页页，created_at DESC）。 */
const eventViews = computed(() =>
  (workflows.events?.items ?? []).map((event) => ({
    event,
    view: workflowEventView(event, {
      tasks: workflows.current?.tasks,
      maxRetries: workflows.current?.workflow.policy.maxRetries
    })
  }))
);

function loadEventsPage(page: number): void {
  void workflows.loadEventsPage(page);
}

function jumpToLatest(): void {
  void workflows.jumpToLatest();
}

/** T6：预算输入解析——空/非法 = null（创建时省略；调整时清除）。 */
function parsePolicyLimit(value: string): number | null {
  const parsed = Number(value);
  return value.trim() !== "" && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** T6：预算展示文案（undefined = 不限制）。 */
function policyLimitLabel(value: number | undefined, suffix: string): string {
  return value === undefined ? "不限制" : `${value}${suffix}`;
}

watch(
  () => workflows.current?.workflow,
  (workflow) => {
    if (!workflow) return;
    editCostUsd.value =
      workflow.policy.maxCostUsd !== undefined ? String(workflow.policy.maxCostUsd) : "";
    editTokens.value =
      workflow.policy.maxTokens !== undefined ? String(workflow.policy.maxTokens) : "";
    editWallClock.value =
      workflow.policy.maxWallClockMs !== undefined ? String(workflow.policy.maxWallClockMs) : "";
  },
  { immediate: true }
);

/** T6：保存预算调整（仅 RUNNING/PAUSED；超限暂停后放宽再走「继续」）。 */
function saveBudget(): void {
  const input: UpdateWorkflowPolicyInput = {
    maxCostUsd: parsePolicyLimit(editCostUsd.value),
    maxTokens: parsePolicyLimit(editTokens.value),
    maxWallClockMs: parsePolicyLimit(editWallClock.value)
  };
  void workflows.updatePolicy(input);
}

watch(projectId, async (id) => {
  requirementId.value = "";
  sliceKey.value = "";
  planningVersion.value = "";
  requirements.value = id ? await listRequirements(id) : [];
});

watch(selectedId, (id) => {
  detailOpen.value = Boolean(id);
  if (id) void workflows.loadWorkflow(id);
});

/** 关闭详情抽屉 → 回到列表路由（URL 与可见状态保持一致；深链接与前进/后退不受影响）。 */
watch(detailOpen, (open) => {
  if (!open && selectedId.value) void router.push("/workflows");
});

/** 筛选变化时回到第 1 页。 */
watch([filterProjectId, filterStatus], () => {
  listPage.value = 1;
});

/** 列表错误态的重试：沿用既有取数方法（store 内部会重置 loading / error）。 */
function reloadWorkflows() {
  void workflows.loadWorkflows();
}

/** 事件时间线错误态的重试：沿用既有的分页取数方法。 */
function reloadEvents() {
  loadEventsPage(workflows.eventsPage);
}

// ─────────────────────────────────────────────────────────────────────────────
// TF-M1 ~ TF-M3：端到端追踪（7-C 的 `GET /api/workflows/:id/trace`）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 追踪树**按需加载**（点「加载追踪」/「刷新」），不并入 `loadWorkflow`——
 * 真实运行实测 503 个工具调用节点（`docs/153`），每次打开详情都拉一棵不划算。
 * 同时校验 `workflowRunId`：切换工作流时即使旧的请求后到，也不会把上一棵渲染出来。
 */
const trace = computed(() =>
  workflows.trace && workflows.trace.workflowRunId === workflows.current?.workflow.id
    ? workflows.trace
    : null
);

/** TF-03：展开态是**纯本地状态**——展开 / 收起不触发任何请求。 */
const traceExpanded = ref<string[]>([]);

/** 新树到达时套用默认折叠策略（workflow / task 展开，agentRun / toolCall / deployment 收起）。 */
watch(
  () => trace.value?.workflowRunId,
  () => {
    traceExpanded.value = trace.value ? defaultExpandedTraceNodeIds(trace.value.root) : [];
  },
  { immediate: true }
);

function loadTrace(): void {
  void workflows.loadTrace();
}

function toggleTraceNode(key: string): void {
  traceExpanded.value = toggleTraceNodeId(traceExpanded.value, key);
}

async function create() {
  if (!projectId.value || !requirementId.value) return;
  const cost = parsePolicyLimit(budgetCostUsd.value);
  const tokens = parsePolicyLimit(budgetTokens.value);
  const wallClock = parsePolicyLimit(budgetWallClockMs.value);
  const trimmedSliceKey = sliceKey.value.trim();
  const parsedPlanningVersion = Number.parseInt(planningVersion.value, 10);
  const workflow = await workflows.create({
    projectId: projectId.value,
    requirementId: requirementId.value,
    workspacePath: normalizeWorkspacePath(workspacePath.value),
    ...(trimmedSliceKey ? { sliceKey: trimmedSliceKey } : {}),
    ...(Number.isInteger(parsedPlanningVersion) && parsedPlanningVersion > 0
      ? { planningVersion: parsedPlanningVersion }
      : {}),
    policy: {
      maxConcurrency: maxConcurrency.value,
      maxRetries: maxRetries.value,
      failureStrategy: failureStrategy.value,
      allowRetry: failureStrategy.value === "RETRY",
      allowReplan: failureStrategy.value === "REPLAN",
      approvalRequired: approvalRequired.value,
      ...(cost !== null ? { maxCostUsd: cost } : {}),
      ...(tokens !== null ? { maxTokens: tokens } : {}),
      ...(wallClock !== null ? { maxWallClockMs: wallClock } : {})
    }
  });
  if (workflow) {
    createOpen.value = false;
    await router.push(`/workflows/${workflow.id}`);
  }
}

onMounted(async () => {
  await Promise.all([projects.fetchProjects(), workflows.loadWorkflows()]);
  if (selectedId.value) await workflows.loadWorkflow(selectedId.value);
});

onBeforeUnmount(() => {
  workflows.stopRealtime();
});
</script>

<template>
  <PageContainer width="wide">
    <PageHeader title="工作流">
      <template #actions>
        <Dialog
          v-model:open="createOpen"
          title="创建工作流"
          description="选择项目与已分析需求；切片交付请填写 sliceKey 与 planningVersion，否则不会绑定切片任务。"
        >
          <template #trigger>
            <Button type="button">新建工作流</Button>
          </template>
          <form
            class="grid gap-4"
            @submit.prevent="create"
            @keydown="onFormKeydown"
          >
            <div class="grid gap-2">
              <Label for="workflow-project">项目</Label>
              <Select
                id="workflow-project"
                v-model="projectId"
                :options="projectOptions"
                required
              />
            </div>
            <div class="grid gap-2">
              <Label for="workflow-requirement">需求</Label>
              <Select
                id="workflow-requirement"
                v-model="requirementId"
                :options="requirementOptions"
                required
              />
            </div>
            <div class="grid gap-2">
              <Label for="workflow-slice-key">切片键 sliceKey（可选，切片工作流必填）</Label>
              <Input
                id="workflow-slice-key"
                v-model.trim="sliceKey"
                maxlength="40"
                placeholder="例如 slice-1-foundation"
              />
            </div>
            <div class="grid gap-2">
              <Label for="workflow-planning-version">规划版本 planningVersion（可选）</Label>
              <Input
                id="workflow-planning-version"
                v-model.trim="planningVersion"
                type="number"
                min="1"
                step="1"
                placeholder="与切片规划版本一致"
              />
            </div>
            <div class="grid gap-2">
              <Label for="workflow-workspace">覆盖项目工作区（可选）</Label>
              <Input
                id="workflow-workspace"
                v-model.trim="workspacePath"
                maxlength="1000"
                placeholder="/absolute/path/to/your/repo"
              />
            </div>
            <p class="m-0 text-secondary text-muted-foreground">
              默认继承项目的本地工作区路径。仅在需要单独目录时填写覆盖路径（须为
              AGENT_WORKSPACE_ROOT 下的本机绝对路径）。
            </p>
            <div class="grid gap-2">
              <Label for="workflow-concurrency">最大并发</Label>
              <Input
                id="workflow-concurrency"
                v-model.number="maxConcurrency"
                type="number"
                min="1"
                max="16"
              />
            </div>
            <div class="grid gap-2">
              <Label for="workflow-retries">最大重试次数</Label>
              <Input
                id="workflow-retries"
                v-model.number="maxRetries"
                type="number"
                min="0"
                max="10"
              />
            </div>
            <div class="grid gap-2">
              <Label for="workflow-strategy">失败策略</Label>
              <Select
                id="workflow-strategy"
                v-model="failureStrategy"
                :options="failureStrategyOptions"
              />
            </div>
            <div class="grid gap-2">
              <Label for="workflow-max-cost">预算：成本上限 USD（可空）</Label>
              <Input
                id="workflow-max-cost"
                v-model.trim="budgetCostUsd"
                type="number"
                min="0"
                step="0.01"
                placeholder="不限制"
              />
            </div>
            <div class="grid gap-2">
              <Label for="workflow-max-tokens">预算：Token 上限（可空）</Label>
              <Input
                id="workflow-max-tokens"
                v-model.trim="budgetTokens"
                type="number"
                min="1"
                placeholder="不限制"
              />
            </div>
            <div class="grid gap-2">
              <Label for="workflow-max-wall">预算：墙钟上限 ms（可空）</Label>
              <Input
                id="workflow-max-wall"
                v-model.trim="budgetWallClockMs"
                type="number"
                min="1"
                placeholder="不限制"
              />
            </div>
            <label class="flex cursor-pointer items-center gap-2">
              <Checkbox v-model="approvalRequired" />
              <span class="text-body text-foreground">需要人工审批</span>
            </label>
            <Button type="submit" :disabled="workflows.creating">
              {{ workflows.creating ? "创建中…" : "创建" }}
            </Button>
          </form>
        </Dialog>
      </template>
    </PageHeader>

    <Card class="grid gap-4 p-[var(--card-padding)]">
      <SectionHeader title="工作流列表" />
      <!--
        工具行（全站唯一有真实筛选控件的一处，见 src/styles/README.md §14）：
        项目 + 状态两个筛选，左到右；筛选逻辑在 viewmodel 里，本页只绑值。
      -->
      <div class="flex flex-wrap items-center gap-2">
        <!--
          `aria-label` 是必需的：Select 的触发器是 `<button role="combobox">`，
          而 combobox 的名称只能来自 author（ARIA 规定 combobox 不支持 name from content），
          里头的「全部项目」不会被当名称用 —— 不写就是 axe 的 button-name 违规。
          旁边没有再放可见的 <Label>，是为了保住 W5/W7 定下的紧凑工具行版式。
        -->
        <Select
          id="workflow-filter-project"
          v-model="filterProjectId"
          :options="filterProjectOptions"
          aria-label="按项目筛选"
          class="w-60"
        />
        <Select
          id="workflow-filter-status"
          v-model="filterStatus"
          :options="filterStatusOptions"
          aria-label="按状态筛选"
          class="w-50"
        />
      </div>
      <!-- 四种状态：加载 → 错误 → 空 → 有数据（顺序固定） -->
      <TableSkeleton
        v-if="workflows.loading && !workflows.workflows.length"
        :columns="workflowColumns.length"
        :rows="3"
      />
      <ErrorState
        v-else-if="workflows.error"
        :message="workflows.error"
        @retry="reloadWorkflows"
      />
      <EmptyState v-else-if="!workflows.workflows.length" title="暂无工作流。" size="compact" />
      <EmptyState
        v-else-if="!visibleWorkflows.length"
        title="没有符合筛选条件的工作流。"
        size="compact"
      />
      <div v-else class="min-w-0">
        <Table
          v-model:page="listPage"
          :columns="workflowColumns"
          :rows="visibleWorkflows"
          :row-key="(row) => row.id"
          min-width="min-w-220"
        >
          <template #cell-status="{ row }">
            <span class="grid justify-items-start gap-1">
              <StatusBadge :tone="workflowStatusTone(row.status)">
                {{ workflowStatusLabel(row.status) }}
              </StatusBadge>
              <span class="text-caption text-muted-foreground">v{{ row.planningVersion }}</span>
            </span>
          </template>
          <template #cell-requirement="{ row }">
            <span class="grid justify-items-start gap-1">
              <strong class="break-words text-body font-semibold text-foreground">
                {{ row.requirementName || `需求 ${row.requirementId.slice(0, 8)}` }}
              </strong>
              <CopyableId :id="row.id" />
            </span>
          </template>
          <template #cell-project="{ row }">
            <span class="text-secondary text-muted-foreground">
              {{ row.projectName || "未关联项目" }}
            </span>
          </template>
          <template #cell-progress="{ row }">
            <span class="grid justify-items-start gap-1">
              <span class="text-body text-foreground">
                进度
                {{ workflowProgressLabel(row.taskProgress.completed, row.taskProgress.total) }}
              </span>
              <span class="text-caption text-muted-foreground">
                开始 {{ workflowTimeLabel(row.startedAt) }} · 用时
                {{ workflowDurationLabel(row.startedAt, row.finishedAt) }}
              </span>
            </span>
          </template>
          <template #cell-updatedAt="{ row }">
            <span class="text-secondary text-muted-foreground">
              {{ workflowTimeLabel(row.updatedAt) }}
            </span>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex flex-wrap items-center justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" @click="openDetail(row.id)">
                详情
              </Button>
              <Button
                v-if="rowAction(row.status)"
                type="button"
                size="sm"
                :disabled="workflows.acting"
                @click="handleRowAction(row)"
              >
                {{ rowAction(row.status)?.label }}
              </Button>
            </div>
          </template>
        </Table>
      </div>
    </Card>

    <Drawer v-model:open="detailOpen" title="工作流详情">
      <ErrorState v-if="workflows.error" :message="workflows.error" @retry="reloadWorkflows" />
      <div
        v-else-if="!workflows.current && workflows.loading"
        class="grid gap-4"
        role="status"
        aria-label="加载中"
      >
        <LoadingSkeleton class="h-24 rounded-lg" />
        <LoadingSkeleton class="h-40 rounded-lg" />
      </div>
      <EmptyState v-else-if="!workflows.current" title="请选择或创建工作流。" />

      <div v-else class="grid gap-5">
        <Card class="p-[var(--card-padding)]">
          <SectionHeader :title="workflows.current.workflow.id">
            <template #actions>
              <StatusBadge :tone="workflowStatusTone(workflows.current.workflow.status)">
                {{ workflowStatusLabel(workflows.current.workflow.status) }}
              </StatusBadge>
            </template>
          </SectionHeader>
          <div class="flex flex-wrap gap-2">
            <Button
              v-if="canStart(workflows.current.workflow.status)"
              :disabled="workflows.acting"
              @click="workflows.act('start')"
            >
              开始
            </Button>
            <Button
              v-if="canPause(workflows.current.workflow.status)"
              variant="secondary"
              :disabled="workflows.acting"
              @click="workflows.act('pause')"
            >
              暂停
            </Button>
            <Button
              v-if="canResume(workflows.current.workflow.status)"
              :disabled="workflows.acting"
              @click="workflows.act('resume')"
            >
              继续
            </Button>
            <Button
              v-if="canRetry(workflows.current.workflow.status)"
              :disabled="workflows.acting"
              @click="workflows.act('retry')"
            >
              重试失败任务
            </Button>
            <Button
              v-if="!['SUCCESS', 'FAILED', 'CANCELLED'].includes(workflows.current.workflow.status)"
              variant="destructive"
              :disabled="workflows.acting"
              @click="workflows.act('cancel')"
            >
              取消
            </Button>
          </div>
          <div
            v-if="autonomyRepair"
            class="mt-4 rounded-md border px-3 py-2.5 text-body"
            :class="
              autonomyRepair.exhausted
                ? 'border-destructive/40 bg-destructive/5 text-destructive'
                : 'border-amber-500/40 bg-amber-500/5 text-foreground'
            "
            role="status"
            data-testid="autonomy-repair-banner"
          >
            <div class="flex flex-wrap items-start justify-between gap-2">
              <strong class="font-semibold">{{ autonomyRepair.label }}</strong>
              <RouterLink
                class="shrink-0 text-caption text-primary hover:underline"
                :to="{
                  path: '/autonomy-runs',
                  query: {
                    workflowId: workflows.current.workflow.id,
                    ...(workflows.current.workflow.projectId
                      ? { projectId: workflows.current.workflow.projectId }
                      : {})
                  }
                }"
                data-testid="autonomy-runs-link"
              >
                查看自治记录
              </RouterLink>
            </div>
            <p v-if="autonomyRepair.evidenceLine" class="m-0 mt-1 break-words text-caption text-muted-foreground">
              {{ autonomyRepair.evidenceLine }}
            </p>
          </div>
          <dl class="m-0 mt-5 grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div class="border-t border-border pt-2.5">
              <dt class="text-caption text-muted-foreground">项目</dt>
              <dd class="m-0 mt-1 break-words text-body font-semibold text-foreground">
                {{ currentSummary?.projectName || "—" }}
              </dd>
            </div>
            <div class="border-t border-border pt-2.5">
              <dt class="text-caption text-muted-foreground">需求</dt>
              <dd class="m-0 mt-1 break-words text-body font-semibold text-foreground">
                {{
                  currentSummary?.requirementName ||
                  workflows.current.workflow.requirementId.slice(0, 8)
                }}
              </dd>
            </div>
            <div class="border-t border-border pt-2.5">
              <dt class="text-caption text-muted-foreground">任务进度</dt>
              <dd class="m-0 mt-1 text-body font-semibold text-foreground">
                {{ workflowProgressLabel(detailProgress.completed, detailProgress.total) }}
              </dd>
            </div>
            <div class="border-t border-border pt-2.5">
              <dt class="text-caption text-muted-foreground">并发</dt>
              <dd class="m-0 mt-1 text-body font-semibold text-foreground">
                {{ workflows.current.workflow.policy.maxConcurrency }}
              </dd>
            </div>
            <div class="border-t border-border pt-2.5">
              <dt class="text-caption text-muted-foreground">重试</dt>
              <dd class="m-0 mt-1 text-body font-semibold text-foreground">
                {{ workflows.current.workflow.policy.maxRetries }}
              </dd>
            </div>
            <div class="border-t border-border pt-2.5">
              <dt class="text-caption text-muted-foreground">策略</dt>
              <dd class="m-0 mt-1 text-body font-semibold text-foreground">
                {{ failureStrategyLabel(workflows.current.workflow.policy.failureStrategy) }}
              </dd>
            </div>
            <div class="border-t border-border pt-2.5">
              <dt class="text-caption text-muted-foreground">预算：成本 / Token / 时长</dt>
              <dd class="m-0 mt-1 text-body font-semibold text-foreground">
                {{ policyLimitLabel(workflows.current.workflow.policy.maxCostUsd, " USD") }} /
                {{ policyLimitLabel(workflows.current.workflow.policy.maxTokens, "") }} /
                {{ policyLimitLabel(workflows.current.workflow.policy.maxWallClockMs, " ms") }}
              </dd>
            </div>
          </dl>
          <div
            v-if="['RUNNING', 'PAUSED'].includes(workflows.current.workflow.status)"
            class="mt-5 grid gap-3 border-t border-border pt-4"
          >
            <strong class="text-body font-semibold text-foreground">
              调整预算（仅运行中 / 已暂停）
            </strong>
            <div class="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <div class="grid gap-2">
                <Label for="workflow-edit-cost">成本上限 USD</Label>
                <Input
                  id="workflow-edit-cost"
                  v-model.trim="editCostUsd"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="不限制"
                />
              </div>
              <div class="grid gap-2">
                <Label for="workflow-edit-tokens">Token 上限</Label>
                <Input
                  id="workflow-edit-tokens"
                  v-model.trim="editTokens"
                  type="number"
                  min="1"
                  placeholder="不限制"
                />
              </div>
              <div class="grid gap-2">
                <Label for="workflow-edit-wall">墙钟上限 ms</Label>
                <Input
                  id="workflow-edit-wall"
                  v-model.trim="editWallClock"
                  type="number"
                  min="1"
                  placeholder="不限制"
                />
              </div>
            </div>
            <p class="m-0 text-secondary text-muted-foreground">
              留空 = 清除该上限。预算超限会暂停工作流（错误码
              BUDGET_EXCEEDED）；调整后点「继续」恢复。
            </p>
            <div>
              <Button variant="secondary" :disabled="workflows.acting" @click="saveBudget">
                保存预算
              </Button>
            </div>
          </div>
        </Card>

        <Card v-if="activeApprovals.length" class="p-[var(--card-padding)]">
          <SectionHeader title="审批" />
          <div class="grid gap-4">
            <div
              v-for="approval in activeApprovals"
              :key="approval.id"
              class="flex flex-wrap items-center justify-between gap-4"
            >
              <div class="min-w-0">
                <strong class="text-body font-semibold text-foreground">
                  {{ workflows.current.tasks.find((task) => task.id === approval.taskId)?.title }}
                </strong>
                <p class="m-0 text-secondary text-muted-foreground">{{ approval.reason }}</p>
              </div>
              <div class="flex flex-wrap gap-2">
                <Button @click="workflows.decide(approval.id, 'approve')">批准</Button>
                <Button variant="destructive" @click="openRejectConfirm(approval.id)">拒绝</Button>
              </div>
            </div>
          </div>
        </Card>

        <Card class="p-[var(--card-padding)]">
          <SectionHeader title="工作流图" />
          <div class="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
            <article
              v-for="task in workflows.current.tasks"
              :id="`task-${task.id}`"
              :key="task.id"
              class="grid content-start gap-2 rounded-lg border border-border bg-card p-3"
            >
              <div class="grid gap-1">
                <span class="text-caption font-semibold text-muted-foreground">{{
                  task.taskKey
                }}</span>
                <strong class="break-words text-body font-semibold text-foreground">{{
                  task.title
                }}</strong>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{{ taskTypeLabel(task.type) }}</Badge>
                <StatusBadge :tone="displayTaskStatusTone(task, workflows.current.tasks)">{{
                  displayTaskStatusLabel(task, workflows.current.tasks)
                }}</StatusBadge>
              </div>
              <p
                v-if="taskDependencies(task, workflows.current.dependencies).length"
                class="m-0 break-words text-secondary text-muted-foreground"
              >
                前置：{{ taskDependencies(task, workflows.current.dependencies).join("、") }}
              </p>
              <p
                v-if="task.origin === 'DYNAMIC'"
                class="m-0 break-words text-secondary text-muted-foreground"
              >
                动态任务 · {{ task.creationReason }}
              </p>
              <p
                v-if="task.assignedAgent"
                class="m-0 break-words text-secondary text-muted-foreground"
              >
                执行 Agent：{{ task.assignedAgent }}
              </p>
              <p
                v-if="taskResolutionNote(task, workflows.current.tasks)"
                class="m-0 break-words text-secondary text-muted-foreground"
              >
                {{ taskResolutionNote(task, workflows.current.tasks) }}
              </p>
              <p
                v-else-if="task.status === 'FAILED' && typeof task.output?.summary === 'string'"
                class="m-0 break-words text-danger"
              >
                失败原因：{{ task.output.summary }}
              </p>
              <RouterLink
                v-if="taskRunId(task)"
                class="text-secondary text-primary hover:underline"
                :to="`/agent-run?run=${taskRunId(task)}`"
              >
                查看 Agent 运行
              </RouterLink>
            </article>
          </div>
        </Card>

        <Card class="p-[var(--card-padding)]">
          <SectionHeader title="追踪" />
          <ErrorState
            v-if="workflows.traceError"
            :message="workflows.traceError"
            :retryable="!workflows.traceNotFound"
            @retry="loadTrace"
          />
          <div
            v-else-if="workflows.traceLoading && !trace"
            class="grid gap-3"
            role="status"
            aria-label="加载中"
          >
            <LoadingSkeleton v-for="row in 4" :key="row" class="h-8" />
          </div>
          <EmptyState
            v-else-if="!trace"
            title="尚未加载追踪。"
            description="追踪树按需加载：一次真实运行可能包含数百个工具调用节点。"
            size="compact"
          >
            <template #actions>
              <Button variant="secondary" @click="loadTrace">加载追踪</Button>
            </template>
          </EmptyState>
          <div v-else class="grid gap-3">
            <ul aria-label="端到端追踪树" class="m-0 grid list-none gap-1 p-0">
              <TraceTree :node="trace.root" :expanded="traceExpanded" @toggle="toggleTraceNode" />
            </ul>
            <div
              class="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
            >
              <span class="text-caption text-muted-foreground">
                {{ traceCountsLabel(trace.counts) }}
              </span>
              <Button
                variant="secondary"
                size="sm"
                :disabled="workflows.traceLoading"
                @click="loadTrace"
              >
                {{ workflows.traceLoading ? "刷新中…" : "刷新" }}
              </Button>
            </div>
          </div>
        </Card>

        <Card class="p-[var(--card-padding)]">
          <SectionHeader title="事件时间线" />
          <ErrorState
            v-if="workflows.eventsError"
            :message="workflows.eventsError"
            @retry="reloadEvents"
          />
          <div
            v-else-if="workflows.eventsLoading && !workflows.events"
            class="grid gap-3"
            role="status"
            aria-label="加载中"
          >
            <LoadingSkeleton v-for="row in 4" :key="row" class="h-8" />
          </div>
          <EmptyState v-else-if="!eventViews.length" title="暂无事件。" size="compact" />
          <ol v-else class="m-0 grid list-none gap-0 p-0">
            <li
              v-for="item in eventViews"
              :key="item.event.id"
              class="grid gap-1.5 border-t border-border py-3 first:border-t-0 first:pt-0"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span class="tone-dot" :data-tone="item.view.tone" aria-hidden="true" />
                <strong class="break-words text-body font-medium text-foreground">{{
                  eventLabel(item.event)
                }}</strong>
                <time class="text-caption text-muted-foreground" :datetime="item.event.createdAt">
                  {{ eventTimeLabel(item.event.createdAt) }}
                </time>
              </div>
              <p class="m-0 break-words text-body text-foreground">{{ item.view.summary }}</p>
              <div
                class="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground"
              >
                <span v-if="item.view.agentName">Agent：{{ item.view.agentName }}</span>
                <span v-if="item.view.taskTitle">任务：{{ item.view.taskTitle }}</span>
                <a
                  v-if="item.view.taskId"
                  class="text-primary hover:underline"
                  :href="`#task-${item.view.taskId}`"
                  >查看任务</a
                >
                <RouterLink
                  v-if="item.view.agentRunId"
                  class="text-primary hover:underline"
                  :to="`/agent-run?run=${item.view.agentRunId}`"
                >
                  查看 Agent 运行
                </RouterLink>
              </div>
              <dl
                v-if="item.view.details.length"
                class="m-0 grid gap-1 rounded-md border border-border bg-muted p-2"
              >
                <div
                  v-for="detail in item.view.details"
                  :key="detail.label"
                  class="flex flex-wrap gap-2 text-caption"
                >
                  <dt class="m-0 font-semibold text-muted-foreground">{{ detail.label }}</dt>
                  <dd class="m-0 break-all text-foreground">{{ detail.value }}</dd>
                </div>
              </dl>
            </li>
          </ol>
          <div
            v-if="
              (workflows.events?.totalPages ?? 0) > 1 ||
              workflows.eventsPage > 1 ||
              workflows.hasNewEvents
            "
            class="grid gap-2 border-t border-border pt-3"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <Button
                v-if="workflows.eventsPage > 1 || workflows.hasNewEvents"
                variant="secondary"
                size="sm"
                @click="jumpToLatest"
              >
                {{ workflows.hasNewEvents ? "回到最新（有新事件）" : "回到最新" }}
              </Button>
              <span class="text-caption text-muted-foreground">
                共 {{ workflows.events?.total ?? 0 }} 条 · 第 {{ workflows.eventsPage }} /
                {{ Math.max(1, workflows.events?.totalPages ?? 0) }} 页
              </span>
            </div>
            <Pagination
              v-if="(workflows.events?.totalPages ?? 0) > 1"
              :page="workflows.eventsPage"
              :total="workflows.events?.total ?? 0"
              :items-per-page="WORKFLOW_EVENTS_PAGE_SIZE"
              @update:page="loadEventsPage"
            />
          </div>
        </Card>
      </div>
    </Drawer>

    <!-- 危险操作确认：全站唯一的一种（W8），见 components/README.md §2。
         取消按钮改文案为「关闭」：工作流自己就有一个叫「取消」的生命周期动作，
         同一个弹层里出现两个「取消」会让「取消什么」变得歧义。 -->
    <ConfirmDialog
      :open="pendingRejectId !== null"
      :title="`拒绝任务「${pendingRejectTitle}」`"
      description="拒绝后该任务不会执行；下面填写的修改意见会记录在这次审批上。"
      confirm-label="拒绝"
      cancel-label="关闭"
      busy-label="提交中…"
      :busy="rejecting"
      :error="rejectError"
      @update:open="(open) => (pendingRejectId = open ? pendingRejectId : null)"
      @confirm="confirmReject"
    >
      <div class="grid gap-2">
        <Label for="approval-comment">修改意见（拒绝时填写）</Label>
        <Textarea id="approval-comment" v-model="rejectComment" rows="3" maxlength="1000" />
      </div>
    </ConfirmDialog>
  </PageContainer>
</template>
