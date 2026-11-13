<script setup lang="ts">
import { DeliveryEnvironment } from "@ai-se/shared";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  PageContainer,
  PageHeader,
  SectionHeader,
  StatusBadge
} from "../components/common";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, type SelectOption } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import {
  canRollback,
  ciProviderLabel,
  ciStatusLabel,
  deploymentStatusLabel,
  deploymentStatusTone,
  environmentLabel,
  shortVersion
} from "../viewmodels/deploymentViewModel";
import { useDeploymentsStore } from "../stores/deployments";
import { useProjectsStore } from "../stores/projects";
import { useModEnterSubmit } from "../composables/useModEnterSubmit";

/**
 * DeploymentsView（W5：统一页面骨架）。
 *
 * 业务层完全冻结（未改动一行）：
 *   · onMounted → Promise.all(fetchProjects, deployments.load()) → 有 :id 再 select
 *   · watch(projectId) → load(id || undefined)；watch(selectedId) → select(id)
 *   · saveEnvironment() 守卫 + `adapter: "docker"` + `configuration: { hostPort, containerPort }`
 *     + `secretReference: secretReference || undefined`（仅引用、不含明文）
 *   · 列表点击 → router.push(`/deployments/${id}`)
 *   · 回滚表单 submit → deployments.rollback(rollbackReason)（**无 confirm**）
 *   · canRollback() 作为回滚表单渲染 gate、deployments.acting 作为两个按钮的 disabled
 *   · 全部业务文案、表单约束（required / type=url / min / max / rows）、状态分支与顺序
 *
 * W5 结构变化：
 *   · 「环境」表单从常驻左栏移进 Dialog（页头 actions 触发）。它是**保存一次就完事的设置**，
 *     不该常驻挤占主列表的宽度。左栏因此只剩「历史」主列表。
 *   · **保留主从两栏**（历史 320px | 详情 1fr）—— 这是真正的 master-detail，
 *     与 `ProjectsView` 那种「常驻新建表单占左栏」不是一回事（见 docs/137 §四 决策 4）。
 *   · 四种状态统一：历史列表 加载 → LoadingSkeleton、页面级错误 → ErrorState（可重试）、
 *     空 → EmptyState、有数据 → 列表项（见 src/styles/README.md §14）。
 *   · 列表项的 Card 外观与截断改为工具类；scoped 只留「选中态的左侧强调条」
 *     （带令牌色的 inset 阴影工具类表达不了，README §0 的 `[data-*]` 例外）。
 */
/** W8：表单内 Cmd/Ctrl + Enter 提交（`<textarea>` 里 Enter 是换行，提交不了）。 */
const onFormKeydown = useModEnterSubmit();
const route = useRoute();
const router = useRouter();
const deployments = useDeploymentsStore();
const projects = useProjectsStore();
const environmentOpen = ref(false);
const projectId = ref("");
const environment = ref<DeliveryEnvironment>("staging");
const endpoint = ref("http://localhost:18001");
const hostPort = ref(18001);
const containerPort = ref(3000);
const secretReference = ref("");
const rollbackReason = ref("恢复到上一个已知可用版本");
const selectedId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));

/** 项目下拉选项（首项为既有文案「选择项目」） */
const projectOptions = computed<SelectOption[]>(() => [
  { value: "", label: "选择项目" },
  ...projects.projects.map((project) => ({ value: project.id, label: project.name }))
]);

/** 环境下拉选项（选项文案与顺序与既有实现一致） */
const environmentOptions: SelectOption[] = [
  { value: "dev", label: "开发（dev）" },
  { value: "staging", label: "预发（staging）" },
  { value: "production", label: "生产（production）" }
];

watch(projectId, (id) => void deployments.load(id || undefined));
watch(selectedId, (id) => {
  if (id) void deployments.select(id);
});

async function saveEnvironment() {
  if (!projectId.value) return;
  await deployments.saveEnvironment({
    projectId: projectId.value,
    name: environment.value,
    endpoint: endpoint.value,
    adapter: "docker",
    configuration: { hostPort: hostPort.value, containerPort: containerPort.value },
    secretReference: secretReference.value || undefined
  });
}

/** 错误态的重试：沿用既有取数方法。 */
function reload() {
  void deployments.load(projectId.value || undefined);
}

onMounted(async () => {
  await Promise.all([projects.fetchProjects(), deployments.load()]);
  if (selectedId.value) await deployments.select(selectedId.value);
});
</script>

<template>
  <PageContainer width="wide">
    <PageHeader title="部署">
      <template #actions>
        <Dialog
          v-model:open="environmentOpen"
          title="环境设置"
          description="为项目登记一套部署环境；同一项目下同名环境会被覆盖。"
        >
          <template #trigger>
            <Button variant="secondary" type="button">环境设置</Button>
          </template>
          <form
            class="grid gap-3"
            @submit.prevent="saveEnvironment"
            @keydown="onFormKeydown"
          >
            <div class="grid gap-1.5">
              <Label for="deployment-project">项目</Label>
              <Select
                id="deployment-project"
                v-model="projectId"
                :options="projectOptions"
                required
              />
            </div>
            <div class="grid gap-1.5">
              <Label for="deployment-environment">环境</Label>
              <Select
                id="deployment-environment"
                v-model="environment"
                :options="environmentOptions"
              />
            </div>
            <div class="grid gap-1.5">
              <Label for="deployment-endpoint">端点</Label>
              <Input id="deployment-endpoint" v-model="endpoint" type="url" required />
            </div>
            <div class="grid gap-1.5">
              <Label for="deployment-host-port">主机端口</Label>
              <Input
                id="deployment-host-port"
                v-model.number="hostPort"
                type="number"
                min="1"
                max="65535"
              />
            </div>
            <div class="grid gap-1.5">
              <Label for="deployment-container-port">容器端口</Label>
              <Input
                id="deployment-container-port"
                v-model.number="containerPort"
                type="number"
                min="1"
                max="65535"
              />
            </div>
            <div class="grid gap-1.5">
              <Label for="deployment-secret">Secret 引用</Label>
              <Input
                id="deployment-secret"
                v-model="secretReference"
                placeholder="仅引用，不含明文"
              />
            </div>
            <Button type="submit" :disabled="deployments.acting">保存</Button>
          </form>
        </Dialog>
      </template>
    </PageHeader>

    <ErrorState
      v-if="deployments.error"
      class="mb-[var(--section-gap)]"
      :message="deployments.error"
      @retry="reload"
    />

    <!-- 主从两栏：<1024px（lg 以下）单列 / ≥1024px 320px 主列表 + 1fr 详情 -->
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside class="grid content-start gap-3">
        <Card class="grid gap-4 p-[var(--card-padding)]">
          <SectionHeader title="历史" />
          <div
            v-if="deployments.loading && !deployments.deployments.length"
            class="grid gap-2"
            role="status"
            aria-label="加载中"
          >
            <LoadingSkeleton v-for="row in 3" :key="row" class="h-16 rounded-lg" />
          </div>
          <EmptyState
            v-else-if="!deployments.deployments.length"
            title="暂无部署记录。"
            size="compact"
          />
          <div v-else class="grid gap-2">
            <button
              v-for="item in deployments.deployments"
              :key="item.id"
              type="button"
              class="grid w-full cursor-pointer gap-1 rounded-lg border border-border bg-card p-3 text-left text-body text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :class="
                item.id === selectedId ? 'border-primary bg-primary-light' : 'hover:bg-muted'
              "
              :data-active="item.id === selectedId ? 'true' : undefined"
              @click="router.push(`/deployments/${item.id}`)"
            >
              <strong class="text-body font-semibold text-foreground">
                {{ environmentLabel(item.environment) }} · {{ deploymentStatusLabel(item.status) }}
              </strong>
              <span
                class="truncate text-secondary text-muted-foreground"
                :title="`${shortVersion(item.version)} · ${new Date(item.createdAt).toLocaleString('zh-CN')}`"
              >
                {{ shortVersion(item.version) }} ·
                {{ new Date(item.createdAt).toLocaleString("zh-CN") }}
              </span>
            </button>
          </div>
        </Card>
      </aside>

      <main v-if="deployments.current" class="grid content-start gap-3">
        <Card class="p-[var(--card-padding)]">
          <SectionHeader eyebrow="部署详情" :title="deployments.current.deployment.id">
            <template #actions>
              <StatusBadge :tone="deploymentStatusTone(deployments.current.deployment.status)">
                {{ deploymentStatusLabel(deployments.current.deployment.status) }}
              </StatusBadge>
            </template>
          </SectionHeader>
          <dl class="m-0 grid grid-cols-2 gap-4">
            <div>
              <dt class="text-caption text-muted-foreground">环境</dt>
              <dd class="m-0 mt-1 break-words text-body text-foreground">
                {{ environmentLabel(deployments.current.deployment.environment) }}
              </dd>
            </div>
            <div>
              <dt class="text-caption text-muted-foreground">版本</dt>
              <dd class="m-0 mt-1 break-words text-body text-foreground">
                {{ deployments.current.deployment.version }}
              </dd>
            </div>
            <div>
              <dt class="text-caption text-muted-foreground">Git 提交</dt>
              <dd class="m-0 mt-1 break-words text-body text-foreground">
                {{ deployments.current.deployment.gitCommit }}
              </dd>
            </div>
            <div>
              <dt class="text-caption text-muted-foreground">Docker 镜像</dt>
              <dd class="m-0 mt-1 break-words text-body text-foreground">
                {{ deployments.current.deployment.image }}
              </dd>
            </div>
            <div>
              <dt class="text-caption text-muted-foreground">工作流</dt>
              <dd class="m-0 mt-1 break-words text-body">
                <RouterLink
                  class="text-primary hover:underline"
                  :to="`/workflows/${deployments.current.deployment.workflowRunId}`"
                >
                  {{ deployments.current.deployment.workflowRunId }}
                </RouterLink>
              </dd>
            </div>
            <div>
              <dt class="text-caption text-muted-foreground">端点</dt>
              <dd class="m-0 mt-1 break-words text-body">
                <a
                  class="text-primary hover:underline"
                  :href="deployments.current.deployment.endpoint"
                  target="_blank"
                  rel="noreferrer"
                >
                  {{ deployments.current.deployment.endpoint }}
                </a>
              </dd>
            </div>
          </dl>
        </Card>

        <Card class="p-[var(--card-padding)]">
          <SectionHeader title="健康检查" />
          <pre
            class="m-0 overflow-auto rounded-lg border border-border bg-muted p-3 text-secondary text-foreground"
            >{{ JSON.stringify(deployments.current.deployment.healthCheck, null, 2) }}</pre
          >
        </Card>

        <Card v-if="deployments.current.ciRun" class="p-[var(--card-padding)]">
          <SectionHeader title="CI" />
          <p class="m-0 text-body text-foreground">
            {{ ciStatusLabel(deployments.current.ciRun.status) }} ·
            {{ ciProviderLabel(deployments.current.ciRun.provider) }}
          </p>
          <p
            v-if="deployments.current.ciRun.pullRequest"
            class="m-0 mt-1 text-body text-foreground"
          >
            拉取请求 #{{ deployments.current.ciRun.pullRequest }}
          </p>
          <a
            v-if="deployments.current.ciRun.url"
            class="mt-1 inline-block text-body text-primary hover:underline"
            :href="deployments.current.ciRun.url"
            target="_blank"
            rel="noreferrer"
          >
            打开 CI 运行
          </a>
        </Card>

        <Card class="p-[var(--card-padding)]">
          <SectionHeader title="日志" />
          <EmptyState
            v-if="!deployments.current.logs.length"
            title="暂无部署日志。"
            size="compact"
          />
          <ol v-else class="m-0 grid list-none gap-0 p-0">
            <li
              v-for="entry in deployments.current.logs"
              :key="entry.id"
              class="grid grid-cols-[80px_minmax(0,1fr)] gap-3 border-t border-border py-3 first:border-t-0 first:pt-0 lg:grid-cols-[100px_minmax(0,1fr)_90px]"
            >
              <time class="text-secondary text-muted-foreground">
                {{ new Date(entry.createdAt).toLocaleTimeString("zh-CN") }}
              </time>
              <strong class="text-body font-semibold text-foreground">{{ entry.level }}</strong>
              <span
                class="col-start-2 break-words text-secondary text-muted-foreground lg:col-start-auto"
              >
                {{ entry.message }}
              </span>
            </li>
          </ol>
        </Card>

        <Card
          v-if="canRollback(deployments.current.deployment)"
          class="grid gap-3 p-[var(--card-padding)]"
        >
          <SectionHeader title="回滚" />
          <form
            class="grid gap-3"
            @submit.prevent="deployments.rollback(rollbackReason)"
            @keydown="onFormKeydown"
          >
            <div class="grid gap-1.5">
              <Label for="deployment-rollback-reason">原因</Label>
              <Textarea
                id="deployment-rollback-reason"
                v-model="rollbackReason"
                rows="3"
                required
              />
            </div>
            <p
              v-if="deployments.current.deployment.environment === 'production'"
              class="m-0 text-secondary text-muted-foreground"
            >
              关联的生产部署任务必须已通过人工审批。
            </p>
            <Button variant="destructive" type="submit" :disabled="deployments.acting">
              回滚
            </Button>
          </form>
        </Card>
      </main>

      <!--
        详情区的空态不设动作按钮：下一步动作就是「从旁边的历史列表里选一条」，
        列表就在同一屏内，再放一个按钮是冗余控件。
      -->
      <EmptyState v-else title="请选择部署。" />
    </div>
  </PageContainer>
</template>

<style scoped>
/*
 * 选中态的左侧强调条。
 *
 * 这是 W5 之后本页唯一保留的 scoped 规则：带令牌色的 inset 阴影无法用工具类表达，
 * 属于 README §0 明确列出的例外（`[data-*]` 变体）。边框与底色已由调用处的工具类给出，
 * 这里只补那条 3px 强调条。
 */
[data-active="true"] {
  box-shadow: inset 3px 0 0 var(--primary);
}
</style>
