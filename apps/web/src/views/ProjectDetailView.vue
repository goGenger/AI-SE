<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  PageContainer,
  PageHeader,
  StatusBadge
} from "../components/common";
import { Button, buttonVariants } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useModEnterSubmit } from "../composables/useModEnterSubmit";
import {
  formatProjectDate,
  projectStatusLabel,
  projectStatusTone,
  repositoryLabel,
  workspacePathLabel
} from "../viewmodels/projectViewModel";
import { useProjectsStore } from "../stores/projects";

/**
 * ProjectDetailView（Phase 11-B：Resource Workspace 布局重构）。
 *
 * 业务逻辑与数据来源**完全未变**：
 *   · onMounted → fetchProject(route.params.id)；watch(projectId) 参数变化时重新拉取
 *   · loading / error / !selectedProject（未找到该项目。）/ 内容 四分支顺序与判定条件原样
 *   · 删除走统一的 ConfirmDialog（W8；原为 `window.confirm("确定删除该项目吗？")`）→ deleteProject
 *     → router.push("/projects")
 *   · 字段文案与「暂无描述。」兜底、两个日期格式化的用法原样
 *
 * 仅重构布局层：原来的「字段清单 Card + 独立操作 Card」→「资源身份 Card + 信息 Card」，
 * 且「删除项目」上移至 PageHeader actions（「返回」保留）。未新增 Tabs / Breadcrumb /
 * 数据获取；未新增组件、依赖或 Design Token。
 */
const route = useRoute();
const router = useRouter();
const projectsStore = useProjectsStore();
const { selectedProject, loading, error } = storeToRefs(projectsStore);
const projectId = computed(() => String(route.params.id));
// UX-01：未配置仓库的项目，在详情页提供「后续绑定」入口。
const repositoryInput = ref("");
const attaching = ref(false);
const attachError = ref("");
const workspacePathInput = ref("");
const updatingWorkspace = ref(false);
const workspaceError = ref("");
/** W8：删除项目改走统一的 ConfirmDialog（原为 `window.confirm`）。 */
const confirmDeleteOpen = ref(false);
const deleting = ref(false);
const deleteError = ref("");
/** W8：表单内 Cmd/Ctrl + Enter 提交。 */
const onFormKeydown = useModEnterSubmit();

onMounted(() => {
  void projectsStore.fetchProject(projectId.value);
});

watch(selectedProject, (project) => {
  workspacePathInput.value = project?.workspacePath ?? "";
});

/** 错误态的重试：沿用既有取数方法（store 内部会重置 loading / error）。 */
function reload() {
  void projectsStore.fetchProject(projectId.value);
}

watch(projectId, (id) => {
  void projectsStore.fetchProject(id);
});

async function attachRepository() {
  if (!selectedProject.value) {
    return;
  }

  attaching.value = true;
  attachError.value = "";

  try {
    await projectsStore.attachRepository(selectedProject.value.id, repositoryInput.value);
    repositoryInput.value = "";
  } catch (error) {
    attachError.value = error instanceof Error ? error.message : "绑定仓库失败";
  } finally {
    attaching.value = false;
  }
}

async function saveWorkspacePath() {
  if (!selectedProject.value) {
    return;
  }

  updatingWorkspace.value = true;
  workspaceError.value = "";

  try {
    await projectsStore.updateWorkspacePath(
      selectedProject.value.id,
      workspacePathInput.value.trim()
    );
  } catch (error) {
    workspaceError.value = error instanceof Error ? error.message : "更新工作区路径失败";
  } finally {
    updatingWorkspace.value = false;
  }
}

async function removeProject() {
  if (!selectedProject.value) {
    return;
  }

  deleting.value = true;
  try {
    await projectsStore.deleteProject(selectedProject.value.id);
    confirmDeleteOpen.value = false;
    await router.push("/projects");
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : "删除项目失败";
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <PageContainer>
    <PageHeader :title="selectedProject?.name || '项目'">
      <template #actions>
        <RouterLink
          :class="buttonVariants({ variant: 'secondary' })"
          to="/projects"
        >
          返回
        </RouterLink>
        <Button
          variant="ghost"
          type="button"
          class="text-danger"
          @click="confirmDeleteOpen = true"
          >删除项目</Button
        >
      </template>
    </PageHeader>

    <!-- 四种状态：加载 → 错误 → 未找到 → 内容（顺序固定） -->
    <div v-if="loading" class="grid gap-4" role="status" aria-label="加载中">
      <LoadingSkeleton class="h-24 rounded-lg" />
      <LoadingSkeleton class="h-40 rounded-lg" />
    </div>
    <ErrorState v-else-if="error" :message="error" @retry="reload" />
    <EmptyState v-else-if="!selectedProject" title="未找到该项目。">
      <template #actions>
        <RouterLink :class="buttonVariants({ variant: 'secondary', size: 'sm' })" to="/projects">
          返回项目列表
        </RouterLink>
      </template>
    </EmptyState>
    <div v-else class="grid gap-[var(--section-gap)]">
      <!-- 资源身份：项目名称 + 状态 + 仓库 -->
      <Card class="flex flex-wrap items-center gap-4 p-[var(--card-padding)]">
        <div class="min-w-0 flex-1 basis-60">
          <p class="m-0 break-words text-section-title text-foreground">
            {{ selectedProject.name }}
          </p>
          <p
            class="m-0 mt-1 truncate text-secondary text-muted-foreground"
            :title="workspacePathLabel(selectedProject.workspacePath)"
          >
            {{ workspacePathLabel(selectedProject.workspacePath) }}
          </p>
          <p
            class="m-0 mt-1 truncate text-secondary text-muted-foreground"
            :title="repositoryLabel(selectedProject.repository)"
          >
            {{ repositoryLabel(selectedProject.repository) }}
          </p>
        </div>
        <StatusBadge :tone="projectStatusTone(selectedProject.status)">
          {{ projectStatusLabel(selectedProject.status) }}
        </StatusBadge>
      </Card>

      <!-- 信息：仓库 / 描述 / 创建时间 / 更新时间（≥900px 三列，<900px 单列） -->
      <Card class="p-[var(--card-padding)]">
        <dl class="m-0 grid gap-x-6 gap-y-4 lg:grid-cols-3">
          <div>
            <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">本地工作区</dt>
            <dd class="m-0 mt-1 break-words text-body text-foreground">{{ workspacePathLabel(selectedProject.workspacePath) }}</dd>
          </div>
          <div>
            <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">仓库</dt>
            <dd class="m-0 mt-1 break-words text-body text-foreground">{{ repositoryLabel(selectedProject.repository) }}</dd>
          </div>
          <div>
            <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">描述</dt>
            <dd class="m-0 mt-1 break-words text-body text-foreground">{{ selectedProject.description || "暂无描述。" }}</dd>
          </div>
          <div>
            <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">创建时间</dt>
            <dd class="m-0 mt-1 break-words text-body text-foreground">{{ formatProjectDate(selectedProject.createdAt) }}</dd>
          </div>
          <div>
            <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">更新时间</dt>
            <dd class="m-0 mt-1 break-words text-body text-foreground">{{ formatProjectDate(selectedProject.updatedAt) }}</dd>
          </div>
        </dl>

        <form
          class="mt-4 grid gap-2 border-t border-border pt-4"
          @submit.prevent="saveWorkspacePath"
          @keydown="onFormKeydown"
        >
          <Label for="project-workspace-path">本地工作区路径</Label>
          <div class="flex flex-wrap items-center gap-2">
            <Input
              id="project-workspace-path"
              v-model.trim="workspacePathInput"
              class="min-w-55 flex-1"
              required
              maxlength="1000"
              placeholder="/Users/你/Desktop/study/my-app"
            />
            <Button type="submit" :disabled="updatingWorkspace">
              {{ updatingWorkspace ? "保存中…" : "保存路径" }}
            </Button>
          </div>
          <p class="m-0 text-secondary text-muted-foreground">
            须为 AGENT_WORKSPACE_ROOT 下的本机绝对路径；切片 / 工作流默认继承，工作流表单可覆盖。
          </p>
          <p v-if="workspaceError" class="m-0 text-body text-danger">{{ workspaceError }}</p>
        </form>

        <!-- UX-01：未配置仓库时提供后续绑定入口；已配置的项目不显示该表单。 -->
        <form
          v-if="!selectedProject.repository"
          class="mt-4 grid gap-2 border-t border-border pt-4"
          @submit.prevent="attachRepository"
          @keydown="onFormKeydown"
        >
          <Label for="project-repository-bind">绑定 Git 仓库</Label>
          <div class="flex flex-wrap items-center gap-2">
            <Input
              id="project-repository-bind"
              v-model.trim="repositoryInput"
              class="min-w-55 flex-1"
              required
              type="url"
              maxlength="500"
              placeholder="https://github.com/example/ai-se"
            />
            <Button type="submit" :disabled="attaching">
              {{ attaching ? "绑定中…" : "绑定" }}
            </Button>
          </div>
          <p v-if="attachError" class="m-0 text-body text-danger">{{ attachError }}</p>
        </form>
      </Card>
    </div>

    <!-- 危险操作确认：全站唯一的一种（W8），见 components/README.md §2 -->
    <ConfirmDialog
      v-model:open="confirmDeleteOpen"
      :title="`删除项目「${selectedProject?.name ?? ''}」`"
      description="删除后不可恢复：该项目下的需求、工作流与部署记录都会一并失去归属。"
      confirm-label="删除项目"
      busy-label="删除中…"
      :busy="deleting"
      :error="deleteError"
      @confirm="removeProject"
    />
  </PageContainer>
</template>
