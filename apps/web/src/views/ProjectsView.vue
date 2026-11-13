<script setup lang="ts">
import { CreateProjectInput, Project } from "@ai-se/shared";
import { storeToRefs } from "pinia";
import { onMounted, reactive, ref } from "vue";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageContainer,
  PageHeader,
  StatusBadge,
  TableSkeleton
} from "../components/common";
import { Button, buttonVariants } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, type TableColumn } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import { useModEnterSubmit } from "../composables/useModEnterSubmit";
import {
  formatProjectDate,
  normalizeRepository,
  normalizeWorkspacePath,
  projectStatusLabel,
  projectStatusTone,
  repositoryLabel,
  workspacePathLabel
} from "../viewmodels/projectViewModel";
import { useProjectsStore } from "../stores/projects";

/**
 * ProjectsView（W5：统一的列表页骨架 + 收敛到 Dialog）。
 *
 * 业务逻辑与数据来源**完全未变**：
 *   · onMounted → projectsStore.fetchProjects() → GET /api/projects
 *   · 表单仍提交 { name, description, repository }，成功后清空三个字段，失败写 createError
 *   · 删除仍是两步确认（pendingDeleteId → removeProject），期间 deletingId 控制「删除中…」+ disabled
 *   · 文案、错误处理、状态分支的判定条件全部原样
 *
 * 结构变化（W5 要求）：
 *   · 「新建项目」表单从常驻的 360px 左栏移进 Dialog，触发器放入 PageHeader 的 actions 插槽，
 *     与其余 8 个页面一致 —— 列表因此占满内容宽度
 *   · 四种状态统一：加载 → TableSkeleton，错误 → ErrorState（可重试），
 *     空 → EmptyState（带下一步动作），有数据 → Card + Table（见 src/styles/README.md §14）
 *   · 删掉整个 <style scoped>：仓库列的截断改用工具类 `max-w-35 truncate`
 *
 * 与既有 Dialog 页面的一处差异：本页保留创建成功提示（createdNotice）。
 * 表单移入 Dialog 后它会随 Dialog 一起被卸载，因此提到列表上方常驻渲染 —— 这是**保留**
 * 既有反馈，而不是新增文案。
 */
const projectsStore = useProjectsStore();
const { projects, loading, error } = storeToRefs(projectsStore);
const createOpen = ref(false);
const creating = ref(false);
const createError = ref("");
/** 待删除的项目（W8：行内二次确认改为统一的 ConfirmDialog，开合由它是否为 null 决定）。 */
const pendingDelete = ref<Project | null>(null);
const deleting = ref(false);
const deleteError = ref("");
const createdNotice = ref("");
const form = reactive<CreateProjectInput>({
  name: "",
  description: "",
  repository: "",
  workspacePath: ""
});
/** W8：表单内 Cmd/Ctrl + Enter 提交（`<textarea>` 里 Enter 是换行，提交不了）。 */
const onFormKeydown = useModEnterSubmit();

/** 表格列定义（文案与顺序与既有实现一致；对齐见 styles/README.md §15） */
const projectColumns: TableColumn<Project>[] = [
  { key: "name", label: "项目名称", sortable: true },
  { key: "description", label: "描述" },
  { key: "workspacePath", label: "本地工作区" },
  { key: "repository", label: "仓库" },
  { key: "status", label: "状态", sortable: true },
  { key: "createdAt", label: "创建时间", align: "right", sortable: true },
  { key: "actions", label: "操作", align: "right" }
];

onMounted(() => {
  void projectsStore.fetchProjects();
});

async function submitProject() {
  creating.value = true;
  createError.value = "";
  createdNotice.value = "";

  try {
    const project = await projectsStore.createProject({
      name: form.name,
      description: form.description,
      // UX-01: 仓库可留空 —— 空输入不提交该字段，先创建、之后在项目详情绑定。
      repository: normalizeRepository(form.repository),
      // 本地工作区可选；空 = 服务端在 AGENT_WORKSPACE_ROOT/projects/ 下自动分配并持久化。
      workspacePath: normalizeWorkspacePath(
        typeof form.workspacePath === "string" ? form.workspacePath : undefined
      )
    });
    createdNotice.value = `已创建「${project.name}」。`;
    form.name = "";
    form.description = "";
    form.repository = "";
    form.workspacePath = "";
    createOpen.value = false;
  } catch (error) {
    createError.value = error instanceof Error ? error.message : "创建项目失败";
  } finally {
    creating.value = false;
  }
}

/** 错误态的重试：沿用既有取数方法（store 内部会重置 loading / error）。 */
function reload() {
  void projectsStore.fetchProjects();
}

async function removeProject() {
  const target = pendingDelete.value;
  if (!target) return;

  deleting.value = true;
  deleteError.value = "";
  try {
    await projectsStore.deleteProject(target.id);
    pendingDelete.value = null;
  } catch (error) {
    // 删除失败时**不关闭确认框**并把原因显示在里面：关掉它等于告诉用户「已经删了」。
    deleteError.value = error instanceof Error ? error.message : "删除项目失败";
  } finally {
    deleting.value = false;
  }
}

/** 打开某一行的删除确认（每次打开都清掉上一次的失败信息）。 */
function openDeleteConfirm(project: Project) {
  deleteError.value = "";
  pendingDelete.value = project;
}
</script>

<template>
  <PageContainer width="wide">
    <PageHeader title="项目">
      <template #actions>
        <Dialog
          v-model:open="createOpen"
          title="新建项目"
          description="项目是需求、工作流与部署的归属单位；本地工作区路径在此确定（可留空自动分配），Git 仓库可之后再绑。"
        >
          <template #trigger>
            <Button type="button">新建项目</Button>
          </template>
          <form class="grid gap-4" @submit.prevent="submitProject" @keydown="onFormKeydown">
            <div class="grid gap-2">
              <Label for="project-name">名称</Label>
              <Input
                id="project-name"
                v-model.trim="form.name"
                required
                maxlength="120"
                placeholder="AI-SE"
              />
            </div>
            <div class="grid gap-2">
              <Label for="project-workspace">本地工作区路径（可选）</Label>
              <Input
                id="project-workspace"
                v-model.trim="form.workspacePath"
                maxlength="1000"
                placeholder="/Users/你/Desktop/study/my-app"
              />
              <p class="m-0 text-secondary text-muted-foreground">
                本机绝对路径，且须在 AGENT_WORKSPACE_ROOT 下。留空则自动创建
                projects/项目名-短id 目录并持久化；切片工作流默认继承此路径。
              </p>
            </div>
            <div class="grid gap-2">
              <Label for="project-repository">仓库地址（可选）</Label>
              <Input
                id="project-repository"
                v-model.trim="form.repository"
                type="url"
                maxlength="500"
                placeholder="https://github.com/example/ai-se"
              />
              <p class="m-0 text-secondary text-muted-foreground">
                留空则先基于本地工作区开发，之后可在项目详情页绑定 Git 仓库。
              </p>
            </div>
            <div class="grid gap-2">
              <Label for="project-description">描述</Label>
              <Textarea
                id="project-description"
                v-model.trim="form.description"
                maxlength="1000"
                rows="5"
              />
            </div>
            <p v-if="createError" class="m-0 text-body text-danger">{{ createError }}</p>

            <Button type="submit" :disabled="creating">{{ creating ? "创建中…" : "创建" }}</Button>
          </form>
        </Dialog>
      </template>
    </PageHeader>

    <p
      v-if="createdNotice"
      role="status"
      class="m-0 mb-[var(--section-gap)] text-body text-success"
    >
      {{ createdNotice }}
    </p>

    <!-- 四种状态：加载 → 错误 → 空 → 有数据（顺序固定，见 src/styles/README.md §14） -->
    <TableSkeleton v-if="loading" :columns="projectColumns.length" />
    <ErrorState v-else-if="error" :message="error" @retry="reload" />
    <EmptyState v-else-if="projects.length === 0" title="暂无项目。">
      <template #actions>
        <Button type="button" @click="createOpen = true">新建项目</Button>
      </template>
    </EmptyState>
    <Card v-else class="overflow-hidden p-3">
      <Table
        :columns="projectColumns"
        :rows="projects"
        :row-key="(row) => row.id"
        min-width="min-w-160"
      >
        <template #cell-name="{ row }">
          <RouterLink
            class="text-body font-medium text-primary hover:underline"
            :to="`/projects/${row.id}`"
          >
            {{ row.name }}
          </RouterLink>
        </template>
        <template #cell-description="{ row }">
          <span class="text-secondary text-muted-foreground">{{ row.description || "—" }}</span>
        </template>
        <template #cell-workspacePath="{ row }">
          <span
            class="block max-w-45 truncate text-secondary text-muted-foreground"
            :title="workspacePathLabel(row.workspacePath)"
          >
            {{ workspacePathLabel(row.workspacePath) }}
          </span>
        </template>
        <template #cell-repository="{ row }">
          <span
            class="block max-w-35 truncate text-secondary text-muted-foreground"
            :title="repositoryLabel(row.repository)"
          >
            {{ repositoryLabel(row.repository) }}
          </span>
        </template>
        <template #cell-status="{ row }">
          <StatusBadge :tone="projectStatusTone(row.status)">
            {{ projectStatusLabel(row.status) }}
          </StatusBadge>
        </template>
        <template #cell-createdAt="{ row }">
          <span class="text-secondary text-muted-foreground">
            {{ formatProjectDate(row.createdAt) }}
          </span>
        </template>
        <template #cell-actions="{ row }">
          <div class="flex flex-wrap items-center justify-end gap-2">
            <RouterLink
              :class="buttonVariants({ variant: 'secondary', size: 'sm' })"
              :to="`/projects/${row.id}`"
            >
              打开
            </RouterLink>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              class="text-danger"
              @click="openDeleteConfirm(row)"
            >
              删除
            </Button>
          </div>
        </template>
      </Table>
    </Card>

    <!-- 危险操作确认：全站唯一的一种（W8），见 components/README.md §2 -->
    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="`删除项目「${pendingDelete?.name ?? ''}」`"
      description="删除后不可恢复：该项目下的需求、工作流与部署记录都会一并失去归属。"
      confirm-label="删除项目"
      busy-label="删除中…"
      :busy="deleting"
      :error="deleteError"
      @update:open="(open) => (pendingDelete = open ? pendingDelete : null)"
      @confirm="removeProject"
    />
  </PageContainer>
</template>
