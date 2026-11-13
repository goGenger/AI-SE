<script setup lang="ts">
import type { AcceptanceTraceabilityEntry, Requirement, RequirementDocument } from "@ai-se/shared";
import {
  deleteRequirementDocument,
  listRequirementDocuments,
  requirementDocumentRawUrl,
  uploadRequirementDocument
} from "../api/requirements";
import { storeToRefs } from "pinia";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  DetailRow,
  EmptyState,
  ErrorState,
  FileDropzone,
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
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, type SelectOption } from "../components/ui/select";
import { Table, type TableColumn } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import { eventLabel, eventSummary, formatDateTime } from "../viewmodels/agentRunViewModel";
import {
  dependencyLabel,
  latestSpecifications,
  latestTasks,
  requirementAnalysisProgress,
  requirementStatusLabel,
  requirementStatusTone,
  canStartSliceWorkflow,
  shouldShowAnalysisProgress,
  sliceStatusLabel,
  sliceStatusTone,
  specificationIsEmpty,
  specificationTypeLabel,
  taskSourceSummary,
  taskStatusLabel,
  taskStatusTone,
  taskTypeLabel
} from "../viewmodels/requirementViewModel";
import { useProjectsStore } from "../stores/projects";
import { useRequirementsStore } from "../stores/requirements";
import { useModEnterSubmit } from "../composables/useModEnterSubmit";

/**
 * RequirementsView（布局重构：表格 + 分页 + 抽屉详情 + 弹窗新建）。
 *
 * 本次仅改布局与交互呈现，业务层完全冻结（未改动一行 store / api / viewmodel）：
 *   · onMounted → fetchProjects → 默认选中 projects[0]；watch(selectedProjectId) → loadRequirements（并回到第 1 页）
 *   · 创建守卫 / 创建成功后**不清空表单** / 分析入口仍调用 analyzeSelectedRequirement(false)
 *   · SSE 实时更新、unmount → stopRealtime、表单约束（maxlength 160/1000/20000、rows=7、无 required）
 *     与全部业务文案原样
 *
 * 布局与交互变化（本次要求）：
 *   · 需求列表 → 组件库 Table（标题/状态/创建时间/操作）+ 内置分页（W7 起默认每页 10 条，纯前端分页，未改接口）
 *   · 操作列 = 「详情」（打开右侧抽屉）+「分析」（打开抽屉并触发分析）
 *   · 需求详情（指标 + 详情 + 切片计划 + 规划事件 + 规格 + 任务 DAG）移入组件库 Drawer
 *   · 「新建需求」独立为页头按钮，表单位于组件库 Dialog 弹窗中（创建成功后关闭弹窗、不清空字段）
 *   · W11：详情抽屉与 URL 同步（`?requirement=<id>`），补齐 `components/README.md` 里登记
 *     的「这两个抽屉不同步 URL」遗留项 —— 现在可分享、可后退，`?requirement=` 深链接直接落在详情上
 */
/** W8：表单内 Cmd/Ctrl + Enter 提交（`<textarea>` 里 Enter 是换行，提交不了）。 */
const onFormKeydown = useModEnterSubmit();
const DEFAULT_PRD = "创建一个简单的 Todo 管理系统，支持用户创建、查看、修改和删除 Todo。";

const projectsStore = useProjectsStore();
const requirementsStore = useRequirementsStore();
const route = useRoute();
const router = useRouter();
const { projects } = storeToRefs(projectsStore);
const {
  requirements,
  selectedRequirement,
  specifications,
  taskGraph,
  slices,
  acceptanceCriteria,
  traceability,
  conflictResolutions,
  currentAgentRun,
  loading,
  detailLoading,
  creating,
  analyzing,
  startingSliceWorkflow,
  resolvingConflicts,
  error
} = storeToRefs(requirementsStore);

/** C-5（N5）：追溯表状态标签/徽标（复用既有语义色，不新增色板）。 */
function traceabilityStatusLabel(status: AcceptanceTraceabilityEntry["status"]): string {
  if (status === "passed") return "通过";
  if (status === "failed") return "失败";
  if (status === "unverified") return "未验证";
  return "无测试覆盖";
}

function traceabilityStatusVariant(
  status: AcceptanceTraceabilityEntry["status"]
): "success" | "destructive" | "warning" | "secondary" {
  if (status === "passed") return "success";
  if (status === "failed") return "destructive";
  if (status === "unverified") return "warning";
  return "secondary";
}

const selectedProjectId = ref("");
/** D1（`docs/229`）：PRD 与技术需求文档（TRD）也可以是以文件方式给过来的。 */
const prdFiles = ref<File[]>([]);
const prdFile = computed(() => prdFiles.value[0] ?? null);
const trdFiles = ref<File[]>([]);
/** 新建时可选的 UI 参照图（不挡开工）。 */
const uiRefFiles = ref<File[]>([]);
/** 详情页的补传区：选中即上传，上传后清空。 */
const detailFiles = ref<File[]>([]);
/** 详情页补传 UI 参照图。 */
const detailUiFiles = ref<File[]>([]);
const documents = ref<RequirementDocument[]>([]);
const planningStale = ref(false);
const documentsError = ref("");
const documentsBusy = ref(false);
const title = ref("Todo 管理系统");
const description = ref("阶段 3 规划示例");
const rawContent = ref(DEFAULT_PRD);

/** 列表分页页码（纯前端分页：只切片已加载的 requirements，不请求接口）。 */
const listPage = ref(1);
/** 「新建需求」弹窗开合。 */
const createOpen = ref(false);

/** `?requirement=<id>` 深链接主键（与工作流页 / 运行页同一形态）。 */
const selectedRequirementId = computed(() =>
  typeof route.query.requirement === "string" ? route.query.requirement : ""
);
/** 需求详情抽屉开合（与 `?requirement=` 同步：有值 = 打开）。 */
const detailOpen = ref(Boolean(selectedRequirementId.value));

/**
 * 详情取数（唯一入口，按 id 去重一次在途请求）。
 *
 * `loadRequirement` 一次会扇出 6 个并行请求（需求本体 + 规格 / 任务 / 切片 / AC / 追溯），
 * 所以不能让「watch(URL)」和行内「分析」各发一遍。这里记住在途的那个 Promise：
 * 谁先发起都行，后来者拿到同一个 Promise，等的是同一次请求。
 */
let pendingLoad: { id: string; promise: Promise<void> } | null = null;

function ensureRequirementLoaded(id: string): Promise<void> {
  // 同一 id 的在途请求去重，避免 URL watch 与「分析」按钮各打一遍。
  if (pendingLoad?.id === id) return pendingLoad.promise;
  const selected = requirementsStore.selectedRequirement;
  // 已选中且不是分析中：沿用内存详情（测试与日常浏览）。
  // 分析中则回源：避免 SSE 丢失后详情永久停在过期的「分析中」，与列表/服务端脱节。
  if (selected?.id === id && selected.status !== "ANALYZING") {
    return Promise.resolve();
  }
  const promise = requirementsStore.loadRequirement(id).finally(() => {
    if (pendingLoad?.id === id) pendingLoad = null;
  });
  pendingLoad = { id, promise };
  return promise;
}

const currentSpecifications = computed(() => latestSpecifications(specifications.value));
const technicalDocuments = computed(() =>
  documents.value.filter((doc) => doc.kind === "TECHNICAL" || doc.kind === "PRD")
);
const uiReferenceDocuments = computed(() =>
  documents.value.filter((doc) => doc.kind === "UI_REFERENCE")
);

/** D1-6：技术文档与 PRD 的冲突项（由规划分析产出，非空即需人工裁决）。 */
const technicalConflicts = computed(() => {
  const analysis = currentSpecifications.value.find(
    (entry) => entry.type === "REQUIREMENT_ANALYSIS"
  );
  const value = (analysis?.content as { technicalDocumentConflicts?: unknown } | undefined)
    ?.technicalDocumentConflicts;
  return Array.isArray(value)
    ? (value as Array<{ topic: string; prdSays: string; documentSays: string; source: string }>)
    : [];
});

type ConflictChoice = "FOLLOW_PRD" | "FOLLOW_TRD" | "CUSTOM" | "";

function conflictIdentity(topic: string, source: string): string {
  return `${topic}\u0000${source}`;
}

const conflictDrafts = ref<Record<string, { choice: ConflictChoice; note: string }>>({});

function savedResolution(topic: string, source: string) {
  return conflictResolutions.value.find(
    (entry) => entry.topic === topic && entry.source === source
  );
}

function ensureDraft(topic: string, source: string) {
  const key = conflictIdentity(topic, source);
  if (!conflictDrafts.value[key]) {
    const saved = savedResolution(topic, source);
    conflictDrafts.value[key] = {
      choice: (saved?.choice as ConflictChoice) ?? "",
      note: saved?.note ?? ""
    };
  }
  return conflictDrafts.value[key];
}

function draftFor(topic: string, source: string) {
  return ensureDraft(topic, source);
}

watch(
  [technicalConflicts, conflictResolutions],
  () => {
    for (const item of technicalConflicts.value) {
      ensureDraft(item.topic, item.source);
    }
  },
  { immediate: true, deep: true }
);

function choiceLabel(choice: string): string {
  if (choice === "FOLLOW_PRD") return "跟 PRD";
  if (choice === "FOLLOW_TRD") return "跟 TRD";
  if (choice === "CUSTOM") return "自定义";
  return choice;
}

const unresolvedConflictCount = computed(
  () =>
    technicalConflicts.value.filter((item) => !savedResolution(item.topic, item.source)).length
);

async function submitConflictResolutions() {
  const payload: Array<{
    topic: string;
    source: string;
    prdSays: string;
    documentSays: string;
    choice: "FOLLOW_PRD" | "FOLLOW_TRD" | "CUSTOM";
    note?: string;
  }> = [];
  for (const item of technicalConflicts.value) {
    const draft = draftFor(item.topic, item.source);
    if (!draft.choice) continue;
    if (draft.choice === "CUSTOM" && !draft.note.trim()) {
      requirementsStore.error = `「${item.topic}」选了自定义，请填写说明`;
      return;
    }
    payload.push({
      topic: item.topic,
      source: item.source,
      prdSays: item.prdSays,
      documentSays: item.documentSays,
      choice: draft.choice,
      ...(draft.choice === "CUSTOM" || draft.note.trim()
        ? { note: draft.note.trim() || undefined }
        : {})
    });
  }
  if (payload.length === 0) {
    requirementsStore.error = "请至少为一条冲突选择裁决";
    return;
  }
  const saved = await requirementsStore.saveConflictResolutions(payload);
  if (saved) {
    for (const item of saved) {
      conflictDrafts.value[conflictIdentity(item.topic, item.source)] = {
        choice: item.choice,
        note: item.note ?? ""
      };
    }
  }
}

const currentTasks = computed(() => latestTasks(taskGraph.value.tasks));

/** 详情进度：与列表同一 status 徽标，另附真实事件/审批推导的阶段说明。 */
const analysisProgress = computed(() => {
  if (!selectedRequirement.value) return null;
  return requirementAnalysisProgress({
    status: selectedRequirement.value.status,
    analyzing: analyzing.value,
    agentRun: currentAgentRun.value,
    approval: slices.value.approval
  });
});

const showAnalysisProgress = computed(
  () =>
    Boolean(selectedRequirement.value) &&
    shouldShowAnalysisProgress(selectedRequirement.value!.status, analyzing.value)
);

/** 需求列表表格列（数据来源与列表项字段一致：标题 / 状态 / 创建时间 + 操作）。 */
const requirementColumns: TableColumn<Requirement>[] = [
  { key: "title", label: "标题", sortable: true },
  { key: "status", label: "状态", sortable: true },
  { key: "createdAt", label: "创建时间", align: "right", sortable: true },
  { key: "actions", label: "操作", align: "right" }
];

/** 项目下拉选项（首项为既有文案「选择项目」） */
const projectOptions = computed<SelectOption[]>(() => [
  { value: "", label: "选择项目" },
  ...projects.value.map((project) => ({ value: project.id, label: project.name }))
]);
const currentDependencies = computed(() => {
  const currentTaskIds = new Set(currentTasks.value.map((task) => task.id));
  return taskGraph.value.dependencies.filter((dependency) => {
    return (
      currentTaskIds.has(dependency.sourceTaskId) && currentTaskIds.has(dependency.targetTaskId)
    );
  });
});

async function loadSelectedProjectRequirements() {
  if (selectedProjectId.value) {
    await requirementsStore.loadRequirements(selectedProjectId.value);
  }
}

async function createRequirement() {
  const file = prdFile.value;
  const text = rawContent.value.trim();
  if (!selectedProjectId.value || !title.value.trim() || (!text && !file)) {
    return;
  }

  const created = await requirementsStore.createRequirement(selectedProjectId.value, {
    title: title.value,
    description: description.value,
    // 文件形态的 PRD 先落一个占位正文（接口要求非空），紧接着上传文件把 raw_content 换成抽取结果。
    // 占位只在「创建成功 → 上传成功」这一瞬存在；上传失败时用户可在详情页重试。
    rawContent: text || `（PRD 由文件导入：${file?.name ?? ""}）`
  });
  if (!created) return;
  // 创建时一并上传：PRD 先落（它会替换 raw_content），技术文档随后。
  for (const entry of [
    ...(file ? [{ kind: "PRD" as const, file }] : []),
    ...trdFiles.value.map((trd) => ({ kind: "TECHNICAL" as const, file: trd })),
    ...uiRefFiles.value.map((img) => ({ kind: "UI_REFERENCE" as const, file: img }))
  ]) {
    try {
      await uploadRequirementDocument(created.id, entry);
    } catch (error) {
      documentsError.value = error instanceof Error ? error.message : String(error);
    }
  }
  prdFiles.value = [];
  trdFiles.value = [];
  uiRefFiles.value = [];
  createOpen.value = false;
}

async function loadDocuments(id: string) {
  documentsError.value = "";
  try {
    const view = await listRequirementDocuments(id);
    documents.value = view.documents;
    planningStale.value = view.planningStale;
  } catch (error) {
    documents.value = [];
    planningStale.value = false;
    documentsError.value = error instanceof Error ? error.message : String(error);
  }
}

async function uploadTechnicalDocuments(files: File[]) {
  const id = selectedRequirementId.value;
  if (!id || files.length === 0) return;
  documentsBusy.value = true;
  documentsError.value = "";
  try {
    for (const file of files) {
      await uploadRequirementDocument(id, { kind: "TECHNICAL", file });
    }
    await loadDocuments(id);
  } catch (error) {
    documentsError.value = error instanceof Error ? error.message : String(error);
  } finally {
    documentsBusy.value = false;
  }
}

async function uploadUiReferenceDocuments(files: File[]) {
  const id = selectedRequirementId.value;
  if (!id || files.length === 0) return;
  documentsBusy.value = true;
  documentsError.value = "";
  try {
    for (const file of files) {
      await uploadRequirementDocument(id, { kind: "UI_REFERENCE", file });
    }
    await loadDocuments(id);
  } catch (error) {
    documentsError.value = error instanceof Error ? error.message : String(error);
  } finally {
    documentsBusy.value = false;
  }
}

/** 详情页补传：选中即上传，随后清空选择区（避免「看起来还没传」）。 */
watch(detailFiles, (files) => {
  if (files.length === 0) return;
  const batch = [...files];
  detailFiles.value = [];
  void uploadTechnicalDocuments(batch);
});

watch(detailUiFiles, (files) => {
  if (files.length === 0) return;
  const batch = [...files];
  detailUiFiles.value = [];
  void uploadUiReferenceDocuments(batch);
});

async function removeDocument(id: string) {
  const requirementId = selectedRequirementId.value;
  if (!requirementId) return;
  documentsBusy.value = true;
  try {
    await deleteRequirementDocument(id);
    await loadDocuments(requirementId);
  } catch (error) {
    documentsError.value = error instanceof Error ? error.message : String(error);
  } finally {
    documentsBusy.value = false;
  }
}

/**
 * 打开某需求的详情抽屉：只改 URL。开抽屉与取数由 `watch(selectedRequirementId)` 一处承担
 * —— 与工作流页 / 运行页同一形态（URL 是唯一真源，深链接、前进/后退、行内按钮走同一条路径）。
 */
function openDetail(requirement: Requirement) {
  void router.push({ path: "/requirements", query: { requirement: requirement.id } });
}

/**
 * 对某需求触发分析：先打开它的详情、**等详情真的落到该需求**，再沿用既有分析动作。
 * 不等的话 `analyzeSelectedRequirement` 会作用在上一个选中的需求上。
 */
async function analyzeRequirement(requirement: Requirement) {
  await router.push({ path: "/requirements", query: { requirement: requirement.id } });
  await ensureRequirementLoaded(requirement.id);
  await requirementsStore.analyzeSelectedRequirement(false);
}

/** N2 关口 1：批准 → 第二级；拒绝（附修改意见）→ 重做第一级。 */
const sliceComment = ref("");
const decidingSlice = ref(false);

async function startSliceWorkflow(sliceKey: string) {
  await requirementsStore.startSliceWorkflow(sliceKey);
}

async function decideSlicePlan(action: "approve" | "reject") {
  decidingSlice.value = true;
  try {
    await requirementsStore.decideSliceApproval(action, sliceComment.value.trim());
    sliceComment.value = "";
  } finally {
    decidingSlice.value = false;
  }
}

function contentPreview(content: Record<string, unknown>): string {
  return JSON.stringify(content, null, 2);
}

/**
 * `?requirement=` 变化 → 开合并取数（深链接 / 行内「详情」「分析」/ 前进后退共用这一条路径）。
 * `immediate` 让初次进入也能直接落在 URL 指定的需求上，不必再在 onMounted 里补一次。
 */
watch(
  selectedRequirementId,
  (id) => {
    detailOpen.value = Boolean(id);
    if (id) {
      void ensureRequirementLoaded(id);
      void loadDocuments(id);
    }
  },
  { immediate: true }
);

/** 关闭详情抽屉 → 回到列表路由（URL 与可见状态保持一致）。 */
watch(detailOpen, (open) => {
  if (!open && selectedRequirementId.value) void router.push({ path: "/requirements" });
});

watch(selectedProjectId, () => {
  listPage.value = 1;
  void loadSelectedProjectRequirements();
});

onMounted(async () => {
  await projectsStore.fetchProjects();
  selectedProjectId.value = projects.value[0]?.id ?? "";
});

onUnmounted(() => {
  requirementsStore.stopRealtime();
});
</script>

<template>
  <PageContainer width="wide">
    <PageHeader title="需求">
      <template #actions>
        <Dialog
          v-model:open="createOpen"
          title="新建需求"
          description="填入原始 PRD；创建后回到列表点「分析」，据此生成规格与任务。"
        >
          <template #trigger>
            <Button type="button">新建需求</Button>
          </template>
          <form
            class="grid gap-4"
            @submit.prevent="createRequirement"
            @keydown="onFormKeydown"
          >
            <div class="grid gap-2">
              <Label for="requirement-project">项目</Label>
              <Select
                id="requirement-project"
                v-model="selectedProjectId"
                :options="projectOptions"
              />
            </div>
            <div class="grid gap-2">
              <Label for="requirement-title">标题</Label>
              <Input id="requirement-title" v-model.trim="title" maxlength="160" />
            </div>
            <div class="grid gap-2">
              <Label for="requirement-description">描述</Label>
              <Input id="requirement-description" v-model.trim="description" maxlength="1000" />
            </div>
            <div class="grid gap-2">
              <Label for="requirement-prd">PRD</Label>
              <Textarea
                id="requirement-prd"
                v-model.trim="rawContent"
                rows="7"
                maxlength="200000"
              />
              <FileDropzone
                id="requirement-prd-file"
                v-model="prdFiles"
                label="或上传 PRD 文件"
                accept=".md,.markdown,.txt,.docx"
                hint=".md / .txt / .docx · 单份 ≤ 5 MB · 创建后会用它替换上面的 PRD 正文"
              />
            </div>
            <FileDropzone
              id="requirement-trd-file"
              v-model="trdFiles"
              label="技术需求文档（可选，可多份）"
              accept=".md,.markdown,.txt,.docx"
              multiple
              hint=".md / .txt / .docx · 单份 ≤ 5 MB · 视为既定方案，规划必须与之一致"
            />
            <FileDropzone
              id="requirement-ui-ref-file"
              v-model="uiRefFiles"
              label="UI 参照图（可选，可多份）"
              accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
              multiple
              hint="PNG / JPG / WebP · 单份 ≤ 5 MB · 最多 8 张 · 只作「大概长什么样」的视觉参照"
            />
            <Button
              type="submit"
              :disabled="
                creating ||
                !selectedProjectId ||
                !title.trim() ||
                (!rawContent.trim() && prdFiles.length === 0)
              "
            >
              {{ creating ? "创建中…" : "创建" }}
            </Button>
          </form>
        </Dialog>
      </template>
    </PageHeader>

    <Card class="grid gap-4 p-[var(--card-padding)]">
      <SectionHeader title="需求列表">
        <template #actions>
          <Badge variant="secondary">{{ requirements.length }}</Badge>
        </template>
      </SectionHeader>
      <div class="flex flex-wrap items-center gap-2">
        <Label for="requirement-project-filter">项目</Label>
        <Select
          id="requirement-project-filter"
          v-model="selectedProjectId"
          :options="projectOptions"
          class="w-60"
        />
      </div>
      <TableSkeleton v-if="loading" :columns="requirementColumns.length" :rows="3" />
      <ErrorState
        v-else-if="error"
        :message="error"
        @retry="loadSelectedProjectRequirements"
      />
      <EmptyState v-else-if="requirements.length === 0" title="暂无需求。" size="compact">
        <template #actions>
          <Button type="button" @click="createOpen = true">新建需求</Button>
        </template>
      </EmptyState>
      <div v-else class="min-w-0">
        <Table
          v-model:page="listPage"
          :columns="requirementColumns"
          :rows="requirements"
          :row-key="(row) => row.id"
        >
          <template #cell-title="{ row }">
            <strong class="text-body font-semibold text-foreground">{{ row.title }}</strong>
          </template>
          <template #cell-status="{ row }">
            <StatusBadge :tone="requirementStatusTone(row.status)">
              {{ requirementStatusLabel(row.status) }}
            </StatusBadge>
          </template>
          <template #cell-createdAt="{ row }">
            <span class="text-secondary text-muted-foreground">{{
              formatDateTime(row.createdAt)
            }}</span>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex flex-wrap items-center justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" @click="openDetail(row)">
                详情
              </Button>
              <Button
                type="button"
                size="sm"
                :disabled="analyzing || row.status === 'ANALYZING'"
                @click="analyzeRequirement(row)"
              >
                {{ analyzing && selectedRequirement?.id === row.id ? "分析中…" : "分析" }}
              </Button>
            </div>
          </template>
        </Table>
      </div>
    </Card>

    <Drawer v-model:open="detailOpen" title="需求详情">
      <div v-if="detailLoading" class="grid gap-4" role="status" aria-label="加载中">
        <LoadingSkeleton class="h-24 rounded-lg" />
        <LoadingSkeleton class="h-40 rounded-lg" />
      </div>
      <EmptyState v-else-if="!selectedRequirement" title="请选择或创建需求。" />

      <template v-else>
        <div class="mb-[var(--section-gap)] grid grid-cols-1 gap-4 lg:grid-cols-4">
          <Card class="grid gap-2 p-[var(--card-padding)]">
            <span class="text-body text-muted-foreground">状态</span>
            <strong class="text-metric text-foreground">
              <StatusBadge :tone="requirementStatusTone(selectedRequirement.status)">
                {{ requirementStatusLabel(selectedRequirement.status) }}
              </StatusBadge>
            </strong>
            <p
              v-if="showAnalysisProgress && analysisProgress"
              class="m-0 text-sm text-muted-foreground"
            >
              进度：{{ analysisProgress.label }}
              <template v-if="analysisProgress.detail">
                · {{ analysisProgress.detail }}
              </template>
            </p>
          </Card>
          <Card class="grid gap-2 p-[var(--card-padding)]">
            <span class="text-body text-muted-foreground">版本</span>
            <strong class="text-metric text-foreground">v{{ selectedRequirement.version }}</strong>
          </Card>
          <Card class="grid gap-2 p-[var(--card-padding)]">
            <span class="text-body text-muted-foreground">规格</span>
            <strong class="text-metric text-foreground">{{ currentSpecifications.length }}</strong>
          </Card>
          <Card class="grid gap-2 p-[var(--card-padding)]">
            <span class="text-body text-muted-foreground">任务</span>
            <strong class="text-metric text-foreground">{{ currentTasks.length }}</strong>
          </Card>
        </div>

        <div class="grid gap-6">
          <Card class="p-[var(--card-padding)]">
            <SectionHeader title="需求详情">
              <template #actions>
                <Badge variant="secondary" class="whitespace-normal text-left">
                  {{ selectedRequirement.title }}
                </Badge>
              </template>
            </SectionHeader>
            <dl class="m-0">
              <DetailRow label="描述">{{ selectedRequirement.description || "-" }}</DetailRow>
              <DetailRow label="创建时间">{{
                formatDateTime(selectedRequirement.createdAt)
              }}</DetailRow>
              <DetailRow label="PRD" value-class="min-w-0">
                <div
                  class="max-h-55 overflow-auto rounded-lg border border-border bg-muted p-3 text-secondary whitespace-pre-wrap"
                >
                  {{ selectedRequirement.rawContent }}
                </div>
              </DetailRow>
            </dl>
          </Card>

          <Card class="p-[var(--card-padding)]">
            <SectionHeader title="技术文档">
              <template #actions>
                <Badge variant="secondary">{{ technicalDocuments.length }} 份</Badge>
              </template>
            </SectionHeader>
            <p v-if="planningStale" class="m-0 text-sm text-danger">
              文档在最近一次规划之后发生变化 —— 需要重新「分析」才会进入规划。
            </p>
            <p v-if="documentsError" class="m-0 text-sm text-danger">{{ documentsError }}</p>
            <FileDropzone
              id="requirement-document-file"
              v-model="detailFiles"
              label="补传技术文档"
              accept=".md,.markdown,.txt,.docx"
              multiple
              :disabled="documentsBusy"
              hint="选中后立即上传 · .md / .txt / .docx · 单份 ≤ 5 MB"
            />
            <ul v-if="technicalDocuments.length > 0" class="m-0 grid list-none gap-2 p-0">
              <li
                v-for="doc in technicalDocuments"
                :key="doc.id"
                class="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
              >
                <div class="grid gap-1">
                  <span class="text-sm font-medium">{{ doc.fileName }}</span>
                  <span class="text-xs text-secondary">
                    {{ doc.kind === "PRD" ? "PRD" : "技术文档" }} · {{ doc.charCount }} 字 ·
                    {{ Math.round(doc.byteSize / 1024) }} KB
                    <template v-if="doc.truncated"> · 已按上限截断</template>
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  class="text-danger"
                  :disabled="documentsBusy"
                  @click="removeDocument(doc.id)"
                >
                  删除
                </Button>
              </li>
            </ul>
          </Card>

          <Card class="p-[var(--card-padding)]">
            <SectionHeader title="UI 参照图">
              <template #actions>
                <Badge variant="secondary">{{ uiReferenceDocuments.length }} 张</Badge>
              </template>
            </SectionHeader>
            <p class="m-0 text-sm text-muted-foreground">
              可选。规划阶段会当作「大概长什么样」的视觉参照；不做像素级对照。
            </p>
            <FileDropzone
              id="requirement-ui-ref-detail"
              v-model="detailUiFiles"
              label="补传 UI 参照图"
              accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
              multiple
              :disabled="documentsBusy"
              hint="选中后立即上传 · PNG / JPG / WebP · 单份 ≤ 5 MB · 最多 8 张"
            />
            <ul v-if="uiReferenceDocuments.length > 0" class="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
              <li
                v-for="doc in uiReferenceDocuments"
                :key="doc.id"
                class="grid gap-2 rounded-lg border border-border p-3"
              >
                <img
                  :src="requirementDocumentRawUrl(doc.id)"
                  :alt="doc.fileName"
                  class="max-h-40 w-full rounded-md border border-border object-contain bg-muted"
                />
                <div class="flex items-center justify-between gap-2">
                  <div class="grid gap-1 min-w-0">
                    <span class="truncate text-sm font-medium">{{ doc.fileName }}</span>
                    <span class="text-xs text-secondary">
                      {{ Math.round(doc.byteSize / 1024) }} KB
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    class="text-danger"
                    :disabled="documentsBusy"
                    @click="removeDocument(doc.id)"
                  >
                    删除
                  </Button>
                </div>
              </li>
            </ul>
          </Card>

          <Card v-if="technicalConflicts.length > 0" class="p-[var(--card-padding)]">
            <SectionHeader title="技术文档与 PRD 的冲突（人工裁决）">
              <template #actions>
                <Badge v-if="unresolvedConflictCount > 0" variant="secondary">
                  待裁决 {{ unresolvedConflictCount }}
                </Badge>
                <Badge v-else variant="secondary">已全部裁决</Badge>
              </template>
            </SectionHeader>
            <p class="m-0 mb-3 text-xs text-secondary">
              每条选「跟 PRD / 跟 TRD / 自定义」后提交；下次分析或切片规划会按你的决定执行。
            </p>
            <ul class="m-0 grid list-none gap-3 p-0">
              <li
                v-for="(item, index) in technicalConflicts"
                :key="conflictIdentity(item.topic, item.source)"
                class="grid gap-2 rounded-lg border border-border p-3"
              >
                <header class="flex flex-wrap items-center justify-between gap-2">
                  <strong class="text-sm">{{ item.topic }}</strong>
                  <Badge
                    v-if="savedResolution(item.topic, item.source)"
                    variant="secondary"
                  >
                    已裁决：{{
                      choiceLabel(savedResolution(item.topic, item.source)!.choice)
                    }}
                  </Badge>
                </header>
                <span class="text-xs text-secondary">PRD：{{ item.prdSays }}</span>
                <span class="text-xs text-secondary"
                  >文档：{{ item.documentSays }}（{{ item.source }}）</span
                >
                <fieldset class="m-0 grid gap-2 border-0 p-0">
                  <legend class="sr-only">裁决选择</legend>
                  <label class="flex items-center gap-2 text-sm">
                    <input
                      v-model="draftFor(item.topic, item.source).choice"
                      type="radio"
                      class="accent-primary"
                      value="FOLLOW_PRD"
                      :name="`conflict-choice-${index}`"
                    />
                    跟 PRD
                  </label>
                  <label class="flex items-center gap-2 text-sm">
                    <input
                      v-model="draftFor(item.topic, item.source).choice"
                      type="radio"
                      class="accent-primary"
                      value="FOLLOW_TRD"
                      :name="`conflict-choice-${index}`"
                    />
                    跟 TRD
                  </label>
                  <label class="flex items-center gap-2 text-sm">
                    <input
                      v-model="draftFor(item.topic, item.source).choice"
                      type="radio"
                      class="accent-primary"
                      value="CUSTOM"
                      :name="`conflict-choice-${index}`"
                    />
                    自定义
                  </label>
                </fieldset>
                <Textarea
                  v-if="draftFor(item.topic, item.source).choice === 'CUSTOM'"
                  v-model="draftFor(item.topic, item.source).note"
                  rows="2"
                  maxlength="2000"
                  placeholder="写明最终口径（必填）"
                />
              </li>
            </ul>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                :disabled="resolvingConflicts"
                @click="submitConflictResolutions"
              >
                {{ resolvingConflicts ? "提交中…" : "提交裁决" }}
              </Button>
              <span class="text-xs text-secondary">提交后可重新分析，规划将服从裁决</span>
            </div>
          </Card>

          <Card v-if="slices.slices.length > 0" class="p-[var(--card-padding)]">
            <SectionHeader title="切片计划（关口 1）">
              <template #actions>
                <StatusBadge
                  v-if="slices.approval"
                  :tone="slices.approval.status === 'PENDING' ? 'warning' : 'success'"
                >
                  {{ slices.approval.status === "PENDING" ? "待确认" : "已确认" }}
                </StatusBadge>
                <Badge v-else variant="secondary">{{ slices.slices.length }} 片</Badge>
              </template>
            </SectionHeader>
            <ul class="m-0 grid list-none gap-3 p-0">
              <li
                v-for="slice in slices.slices"
                :key="slice.id"
                class="grid content-start gap-2 rounded-lg border border-border p-3.5"
              >
                <header class="flex flex-wrap items-center justify-between gap-2">
                  <strong class="break-words text-body font-semibold text-foreground">
                    {{ slice.sliceKey }} · {{ slice.title }}
                  </strong>
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">顺序 {{ slice.order }}</Badge>
                    <Badge v-if="slice.involvesUi" variant="secondary">含 UI</Badge>
                    <StatusBadge :tone="sliceStatusTone(slice.status)">{{
                      sliceStatusLabel(slice.status)
                    }}</StatusBadge>
                    <Button
                      v-if="canStartSliceWorkflow(slice)"
                      type="button"
                      size="sm"
                      variant="secondary"
                      :disabled="startingSliceWorkflow"
                      @click="startSliceWorkflow(slice.sliceKey)"
                    >
                      {{ slice.status === "PLANNED" ? "启动切片工作流" : "重试切片工作流" }}
                    </Button>
                  </div>
                </header>
                <p class="m-0 break-words text-secondary text-muted-foreground">
                  {{ slice.goal }}
                </p>
                <div class="flex flex-wrap gap-2">
                  <Badge v-for="frKey in slice.frKeys" :key="frKey" variant="secondary">{{
                    frKey
                  }}</Badge>
                </div>
              </li>
            </ul>
            <div
              v-if="slices.approval && slices.approval.status === 'PENDING'"
              class="mt-4 grid gap-3 border-t border-border pt-4"
            >
              <p
                v-if="slices.approval.reason"
                class="m-0 break-words rounded-md border border-border bg-muted/40 px-3 py-2 text-secondary text-muted-foreground"
              >
                {{ slices.approval.reason }}
              </p>
              <div class="grid gap-2">
                <Label for="slice-approval-comment">修改意见（拒绝时填写；拒绝将重做第一级）</Label>
                <Textarea
                  id="slice-approval-comment"
                  v-model="sliceComment"
                  rows="2"
                  maxlength="1000"
                />
              </div>
              <div class="flex flex-wrap gap-2">
                <Button type="button" :disabled="decidingSlice" @click="decideSlicePlan('approve')">
                  批准切片计划
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  :disabled="decidingSlice"
                  @click="decideSlicePlan('reject')"
                >
                  拒绝并重做
                </Button>
              </div>
            </div>
          </Card>

          <Card v-if="acceptanceCriteria.criteria.length > 0" class="p-[var(--card-padding)]">
            <SectionHeader title="验收标准（AC）">
              <template #actions>
                <Badge variant="secondary">{{ acceptanceCriteria.criteria.length }} 条</Badge>
              </template>
            </SectionHeader>
            <ul class="m-0 grid list-none gap-3 p-0">
              <li
                v-for="criterion in acceptanceCriteria.criteria"
                :key="criterion.acKey"
                class="grid content-start gap-2 rounded-lg border border-border p-3.5"
              >
                <header class="flex flex-wrap items-center justify-between gap-2">
                  <strong class="text-body font-semibold text-foreground">
                    {{ criterion.acKey }}
                  </strong>
                  <div class="flex flex-wrap gap-2">
                    <Badge v-if="criterion.priority" variant="secondary">
                      {{ criterion.priority }}
                    </Badge>
                    <Badge v-if="criterion.smoke" variant="secondary">smoke</Badge>
                    <Badge variant="secondary">映射 {{ criterion.mappingCount }}</Badge>
                  </div>
                </header>
                <p class="m-0 break-words text-secondary text-muted-foreground">
                  {{ criterion.text }}
                </p>
              </li>
            </ul>
          </Card>

          <Card v-if="traceability.criteria.length > 0" class="p-[var(--card-padding)]">
            <SectionHeader title="追溯表（FR → AC → 测试 → 结果 → 证据）">
              <template #actions>
                <Badge variant="secondary">
                  通过 {{ traceability.summary.passed }}/{{ traceability.summary.total }}
                </Badge>
              </template>
            </SectionHeader>
            <ul class="m-0 grid list-none gap-3 p-0">
              <li
                v-for="entry in traceability.criteria"
                :key="entry.acKey"
                class="grid content-start gap-2 rounded-lg border border-border p-3.5"
              >
                <header class="flex flex-wrap items-center justify-between gap-2">
                  <strong class="text-body font-semibold text-foreground">
                    {{ entry.acKey }}
                  </strong>
                  <div class="flex flex-wrap gap-2">
                    <Badge :variant="traceabilityStatusVariant(entry.status)">
                      {{ traceabilityStatusLabel(entry.status) }}
                    </Badge>
                    <Badge v-if="entry.priority" variant="secondary">{{ entry.priority }}</Badge>
                    <Badge v-if="entry.smoke" variant="secondary">smoke</Badge>
                  </div>
                </header>
                <p class="m-0 break-words text-secondary text-muted-foreground">{{ entry.text }}</p>
                <ul v-if="entry.tests.length > 0" class="m-0 grid list-none gap-1 p-0">
                  <li
                    v-for="(testRef, index) in entry.tests"
                    :key="`${entry.acKey}-${testRef.taskKey}-${index}`"
                    class="text-secondary text-muted-foreground"
                  >
                    {{ testRef.taskKey }} · {{ testRef.expected === "fail" ? "红灯" : "绿灯" }} ·
                    {{ testRef.result === "passed" ? "通过" : "失败" }}
                    <span v-if="testRef.command"> · {{ testRef.command }}</span>
                    <span v-if="testRef.exitCode !== undefined">
                      · exit {{ testRef.exitCode ?? "null" }}
                    </span>
                  </li>
                </ul>
                <p v-else class="m-0 text-secondary text-muted-foreground">无测试/执行证据。</p>
              </li>
            </ul>
          </Card>

          <Card class="p-[var(--card-padding)]">
            <SectionHeader title="规划事件">
              <template #actions>
                <Badge variant="secondary">{{ currentAgentRun?.events.length ?? 0 }}</Badge>
              </template>
            </SectionHeader>
            <p
              v-if="currentAgentRun?.run?.error?.message"
              class="mb-3 break-words rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-secondary text-destructive"
            >
              {{ currentAgentRun.run.error.code ? `[${currentAgentRun.run.error.code}] ` : ""
              }}{{ currentAgentRun.run.error.message }}
            </p>
            <EmptyState
              v-if="!currentAgentRun || currentAgentRun.events.length === 0"
              title="暂无规划事件。"
              size="compact"
            />
            <ul v-else class="m-0 grid list-none gap-3 p-0">
              <li
                v-for="event in currentAgentRun.events"
                :key="event.id"
                class="grid grid-cols-1 gap-4 border-t border-border py-3 first:border-t-0 first:pt-0 lg:grid-cols-[minmax(0,1fr)_180px]"
              >
                <div>
                  <strong class="text-body font-semibold text-foreground">{{
                    eventLabel(event)
                  }}</strong>
                  <p class="m-0 break-words text-secondary text-muted-foreground">
                    {{ eventSummary(event) }}
                  </p>
                </div>
                <span class="text-secondary text-muted-foreground">{{
                  formatDateTime(event.createdAt)
                }}</span>
              </li>
            </ul>
          </Card>

          <Card class="p-[var(--card-padding)]">
            <SectionHeader title="规格">
              <template #actions>
                <Badge variant="secondary">{{ currentSpecifications.length }}</Badge>
              </template>
            </SectionHeader>
            <EmptyState
              v-if="currentSpecifications.length === 0"
              title="尚未生成规格。"
              size="compact"
            />
            <div v-else class="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <article
                v-for="specification in currentSpecifications"
                :key="specification.id"
                class="grid content-start gap-2 rounded-lg border border-border p-3.5"
              >
                <header class="flex flex-wrap items-center justify-between gap-2">
                  <strong class="text-body font-semibold text-foreground">
                    {{ specificationTypeLabel(specification.type) }}
                  </strong>
                  <span class="text-secondary text-muted-foreground"
                    >v{{ specification.version }}</span
                  >
                </header>
                <pre
                  v-if="!specificationIsEmpty(specification.content)"
                  class="m-0 max-h-55 overflow-auto rounded-lg border border-border bg-muted p-3 text-secondary text-foreground whitespace-pre-wrap"
                  >{{ contentPreview(specification.content) }}</pre
                >
                <p v-else class="m-0 text-secondary text-muted-foreground">
                  不适用：该类别在本需求中没有条目（分析不会为凑模板虚构内容）。
                </p>
              </article>
            </div>
          </Card>

          <Card class="p-[var(--card-padding)]">
            <SectionHeader title="任务 DAG">
              <template #actions>
                <Badge variant="secondary">{{ currentDependencies.length }} 条依赖</Badge>
              </template>
            </SectionHeader>
            <EmptyState v-if="currentTasks.length === 0" title="尚未生成任务。" size="compact" />
            <div v-else class="grid gap-4">
              <div class="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
                <article
                  v-for="task in currentTasks"
                  :key="task.id"
                  class="grid content-start gap-2 rounded-lg border border-border bg-muted p-3.5"
                >
                  <strong class="break-words text-body font-semibold text-foreground">
                    {{ task.taskKey }} · {{ task.title }}
                  </strong>
                  <p class="m-0 break-words text-secondary text-muted-foreground">
                    {{ task.description }}
                  </p>
                  <div class="flex flex-wrap gap-2">
                    <Badge variant="secondary">{{ taskTypeLabel(task.type) }}</Badge>
                    <StatusBadge :tone="taskStatusTone(task.status)">{{
                      taskStatusLabel(task.status)
                    }}</StatusBadge>
                    <Badge v-if="taskSourceSummary(task)" variant="secondary">{{
                      taskSourceSummary(task)
                    }}</Badge>
                  </div>
                </article>
              </div>
              <div class="grid gap-2">
                <strong class="text-body font-semibold text-foreground">依赖关系</strong>
                <div
                  class="flex max-h-45 flex-wrap content-start gap-2 overflow-auto rounded-lg border border-border bg-muted p-3"
                >
                  <Badge
                    v-for="dependency in currentDependencies"
                    :key="dependency.id"
                    variant="secondary"
                  >
                    {{ dependencyLabel(dependency) }}
                  </Badge>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </template>
    </Drawer>
  </PageContainer>
</template>
