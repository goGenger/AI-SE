<script setup lang="ts">
import { CreateMCPBindingInput, MCPBindingSummary, MCPToolSummary } from "@ai-se/shared";
import { Link2, Wrench } from "@lucide/vue";
import { storeToRefs } from "pinia";
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { listProjects } from "../api/projects";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  PageContainer,
  PageHeader,
  SectionHeader,
  StatusBadge
} from "../components/common";
import { Button, buttonVariants } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  approvalLabel,
  approvalTone,
  bindingScopeLabel,
  bindingTargetLabel,
  enabledLabel,
  enabledTone,
  formatMCPTimestamp,
  riskLabel,
  riskTone,
  serverStatusHint,
  serverStatusLabel,
  serverStatusTone,
  transportLabel
} from "../viewmodels/mcpViewModel";
import { useMCPStore } from "../stores/mcp";
import { useModEnterSubmit } from "../composables/useModEnterSubmit";

/**
 * MCP 服务器详情（Phase 10-B 布局重构）。
 *
 * 业务功能、数据与交互**完全未变**：
 *   · onMounted：fetchServerDetail(serverId) → 再 listProjects()（失败静默为 []）填 datalist
 *   · 三个内嵌 Tab 仍是本地 ref 切换（不发请求、不改路由）
 *   · createBinding / setBindingEnabled / deleteBinding（含 window.confirm）调用与参数构造不变，
 *     提交成功后清空 agent/tool、保留 projectId；错误仍由本地 formError 呈现
 *   · 行级操作仍以 busyBindingId 禁用；loading → error（清空数据）→ 详情 的顺序与全部文案不变
 *
 * 视觉层：PageHeader / Card + SectionHeader 三层信息层级 + StatusBadge（serverStatusTone /
 * riskTone / approvalTone / enabledTone）+ Button / Input / Label。legacy 类
 * （page / panel / tab-bar / compact-list / mcp-detail-grid / mcp-status-* / mcp-risk-* /
 * mcp-note / status）全部停用；凭据说明与错误文案逐字保留。
 * 未新增组件 / 依赖 / Token / 接口；未触碰 mcpAppBridge 与任何沙箱逻辑。
 */
/** W8：表单内 Cmd/Ctrl + Enter 提交（`<textarea>` 里 Enter 是换行，提交不了）。 */
const onFormKeydown = useModEnterSubmit();
const route = useRoute();
const serverId = computed(() => String(route.params.serverId));

const mcpStore = useMCPStore();
const { selectedServer, tools, bindings, loading, error } = storeToRefs(mcpStore);

const activeTab = ref<"overview" | "tools" | "bindings">("overview");
const projectOptions = ref<Array<{ id: string; name: string }>>([]);
const saving = ref(false);
const formError = ref("");
const busyBindingId = ref("");

const form = reactive({
  projectId: "",
  agentName: "",
  toolName: "",
  enabled: true
});

const projectBindings = computed(() => bindings.value.filter((binding) => !binding.agentName));
const agentBindings = computed(() =>
  bindings.value.filter((binding): binding is MCPBindingSummary & { agentName: string } =>
    Boolean(binding.agentName)
  )
);

onMounted(async () => {
  await mcpStore.fetchServerDetail(serverId.value);
  projectOptions.value = await listProjects()
    .then((projects) => projects.map((project) => ({ id: project.id, name: project.name })))
    .catch(() => []);
});

/** 错误态的重试：沿用既有取数方法（store 内部会清空详情并重置 loading / error）。 */
function reload() {
  void mcpStore.fetchServerDetail(serverId.value);
}

async function submitBinding() {
  saving.value = true;
  formError.value = "";
  try {
    const input: CreateMCPBindingInput = {
      projectId: form.projectId,
      agentName: form.agentName.trim() === "" ? undefined : form.agentName.trim(),
      toolName: form.toolName.trim() === "" ? undefined : form.toolName.trim(),
      enabled: form.enabled
    };
    await mcpStore.createBinding(serverId.value, input);
    form.agentName = "";
    form.toolName = "";
  } catch (error) {
    formError.value = error instanceof Error ? error.message : "创建绑定失败";
  } finally {
    saving.value = false;
  }
}

async function toggleBinding(binding: MCPBindingSummary) {
  busyBindingId.value = binding.id;
  formError.value = "";
  try {
    await mcpStore.setBindingEnabled(binding.id, !binding.enabled);
  } catch (error) {
    formError.value = error instanceof Error ? error.message : "更新绑定失败";
  } finally {
    busyBindingId.value = "";
  }
}

/** T2：发现的工具默认是关的——不打开它，绑定做得再全 agent 也看不到。 */
const busyToolId = ref("");

async function toggleTool(tool: MCPToolSummary) {
  if (!selectedServer.value) return;
  busyToolId.value = tool.id;
  formError.value = "";
  try {
    await mcpStore.setToolEnabled(selectedServer.value.id, tool.id, !tool.enabled);
  } catch (error) {
    formError.value = error instanceof Error ? error.message : "更新工具失败";
  } finally {
    busyToolId.value = "";
  }
}
/** W8：撤销绑定改走统一的 ConfirmDialog（原为 `window.confirm`）。 */
const pendingRevoke = ref<MCPBindingSummary | null>(null);
const revokeError = ref("");

function askRemoveBinding(binding: MCPBindingSummary) {
  revokeError.value = "";
  pendingRevoke.value = binding;
}

async function removeBinding() {
  const target = pendingRevoke.value;
  if (!target) return;

  busyBindingId.value = target.id;
  revokeError.value = "";
  try {
    await mcpStore.deleteBinding(target.id);
    pendingRevoke.value = null;
  } catch (error) {
    // 失败时不关闭确认框：关掉它等于告诉用户「已经撤销了」。
    revokeError.value = error instanceof Error ? error.message : "删除绑定失败";
  } finally {
    busyBindingId.value = "";
  }
}

function bindingRowKey(binding: MCPBindingSummary): string {
  return binding.id;
}

function bindingRowLabel(binding: MCPBindingSummary): string {
  return `${bindingScopeLabel(binding)} · ${bindingTargetLabel(binding)}`;
}
</script>

<template>
  <PageContainer>
    <PageHeader :title="selectedServer?.name ?? '服务器'">
      <template #actions>
        <RouterLink
          :class="buttonVariants({ variant: 'secondary' })"
          :to="`/mcp/${serverId}/app`"
        >
          MCP 应用
        </RouterLink>
        <RouterLink
          :class="buttonVariants({ variant: 'secondary' })"
          to="/mcp"
        >
          返回列表
        </RouterLink>
      </template>
    </PageHeader>

    <!-- 四种状态：加载 → 错误 → 未找到 → 详情（顺序固定） -->
    <div v-if="loading" class="grid gap-4" role="status" aria-label="加载中">
      <LoadingSkeleton class="h-24 rounded-lg" />
      <LoadingSkeleton class="h-40 rounded-lg" />
    </div>
    <ErrorState v-else-if="error" :message="error" @retry="reload" />
    <!--
      空态：改造前这里**什么都没有** —— `selectedServer` 为 null 且非加载/错误时整页白屏
      （既没有空态也没有错误态）。W5 补上，并给出回到列表的下一步动作。
    -->
    <EmptyState v-else-if="!selectedServer" title="未找到该 MCP 服务器。">
      <template #actions>
        <RouterLink :class="buttonVariants({ variant: 'secondary', size: 'sm' })" to="/mcp">
          返回服务器列表
        </RouterLink>
      </template>
    </EmptyState>
    <template v-else>
      <!-- 状态摘要 -->
      <Card
        class="mb-[var(--section-gap)] flex flex-wrap items-center gap-3 p-[var(--card-padding)]"
      >
        <StatusBadge :tone="serverStatusTone(selectedServer.status)">
          {{ serverStatusLabel(selectedServer.status) }}
        </StatusBadge>
        <span class="m-0 text-secondary text-muted-foreground">
          {{ serverStatusHint(selectedServer.status) }}
        </span>
      </Card>

      <!-- 内嵌 Tab（本地切换，不改路由、不发请求） -->
      <div class="mb-[var(--section-gap)] flex flex-wrap gap-2">
        <button
          class="cursor-pointer rounded-md border border-border bg-card px-3 py-1 text-body font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :class="activeTab === 'overview' ? 'border-primary bg-primary-light text-primary' : ''"
          type="button"
          @click="activeTab = 'overview'"
        >
          概览
        </button>
        <button
          class="cursor-pointer rounded-md border border-border bg-card px-3 py-1 text-body font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :class="activeTab === 'tools' ? 'border-primary bg-primary-light text-primary' : ''"
          type="button"
          @click="activeTab = 'tools'"
        >
          工具（{{ tools.length }}）
        </button>
        <button
          class="cursor-pointer rounded-md border border-border bg-card px-3 py-1 text-body font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :class="activeTab === 'bindings' ? 'border-primary bg-primary-light text-primary' : ''"
          type="button"
          @click="activeTab = 'bindings'"
        >
          绑定（{{ bindings.length }}）
        </button>
      </div>

      <!-- Tab 1：概览 -->
      <div v-if="activeTab === 'overview'" class="grid gap-[var(--section-gap)]">
        <Card class="grid gap-4 p-[var(--card-padding)]">
          <SectionHeader title="连接" />
          <dl class="m-0 grid gap-x-6 gap-y-3 lg:grid-cols-3">
            <div>
              <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">状态</dt>
              <dd class="m-0 mt-1 break-words text-body text-foreground">{{ serverStatusLabel(selectedServer.status) }}</dd>
            </div>
            <div>
              <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">最近连接</dt>
              <dd class="m-0 mt-1 break-words text-body text-foreground">{{ formatMCPTimestamp(selectedServer.lastConnectedAt) }}</dd>
            </div>
            <div>
              <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">最近错误</dt>
              <dd class="m-0 mt-1 break-words text-body text-foreground">{{ selectedServer.lastError ?? "—" }}</dd>
            </div>
          </dl>
        </Card>

        <Card class="grid gap-4 p-[var(--card-padding)]">
          <SectionHeader title="元数据" />
          <dl class="m-0 grid gap-x-6 gap-y-3 lg:grid-cols-3">
            <div>
              <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">名称</dt>
              <dd class="m-0 mt-1 break-words text-body text-foreground">{{ selectedServer.name }}</dd>
            </div>
            <div>
              <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">描述</dt>
              <dd class="m-0 mt-1 break-words text-body text-foreground">{{ selectedServer.description || "—" }}</dd>
            </div>
            <div>
              <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">传输方式</dt>
              <dd class="m-0 mt-1 break-words text-body text-foreground">{{ transportLabel(selectedServer.transport) }}</dd>
            </div>
            <div>
              <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">启用状态</dt>
              <dd class="m-0 mt-1 break-words text-body text-foreground">{{ enabledLabel(selectedServer.enabled) }}</dd>
            </div>
          </dl>
        </Card>

        <Card class="grid gap-4 p-[var(--card-padding)]">
          <SectionHeader title="传输配置" />
          <dl class="m-0 grid gap-x-6 gap-y-3 lg:grid-cols-3">
            <template v-if="selectedServer.transport === 'stdio'">
              <div>
                <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">命令</dt>
                <dd class="m-0 mt-1 break-words text-body text-foreground">{{ selectedServer.command ?? "—" }}</dd>
              </div>
              <div>
                <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">参数</dt>
                <dd class="m-0 mt-1 break-words text-body text-foreground">{{ selectedServer.args?.join(" ") ?? "—" }}</dd>
              </div>
            </template>
            <template v-else>
              <div>
                <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">端点</dt>
                <dd class="m-0 mt-1 break-words text-body text-foreground">{{ selectedServer.endpoint ?? "—" }}</dd>
              </div>
            </template>
            <div>
              <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">authRef</dt>
              <dd class="m-0 mt-1 break-words text-body text-foreground">{{ selectedServer.authRef ?? "—" }}</dd>
            </div>
            <div>
              <dt class="text-caption font-semibold text-muted-foreground uppercase tracking-wide">credentialRef</dt>
              <dd class="m-0 mt-1 break-words text-body text-foreground">{{ selectedServer.credentialRef ?? "—" }}</dd>
            </div>
          </dl>
          <p class="m-0 text-secondary text-muted-foreground">仅展示凭据引用。凭据值永远不会到达浏览器。</p>
        </Card>
      </div>

      <!-- Tab 2：工具 -->
      <div v-else-if="activeTab === 'tools'" class="grid gap-[var(--section-gap)]">
        <p
          v-if="selectedServer.status === 'DEGRADED' || selectedServer.status === 'DISCONNECTED'"
          class="m-0 rounded-lg border border-border bg-muted px-4 py-3 text-secondary text-muted-foreground"
        >
          {{ serverStatusHint(selectedServer.status) }}以下工具读取自注册表。
        </p>
        <p
          class="m-0 rounded-lg border border-border bg-muted px-4 py-3 text-secondary text-muted-foreground"
        >
          工具发现后默认关闭。要让它真正进入 agent 的工具集，需要三件事同时成立：工具已启用、项目级绑定已建立、该 Agent 的绑定已建立。
        </p>
        <EmptyState v-if="tools.length === 0" :icon="Wrench" title="尚未发现工具。" />
        <ul v-else class="m-0 grid list-none gap-3 p-0">
          <li v-for="tool in tools" :key="tool.id" class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted px-4 py-4">
            <div class="min-w-0 flex-1 basis-70">
              <strong class="block text-body font-semibold text-foreground">{{ tool.name }}</strong>
              <p class="m-0 break-words text-secondary text-muted-foreground">{{ tool.description || "—" }}</p>
              <span class="mt-1 block break-words text-caption text-muted-foreground">{{ tool.inputSchemaSummary }}</span>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <StatusBadge :tone="riskTone(tool.riskLevel)">{{
                riskLabel(tool.riskLevel)
              }}</StatusBadge>
              <StatusBadge :tone="approvalTone(tool.requiresApproval)">
                {{ approvalLabel(tool.requiresApproval) }}
              </StatusBadge>
              <StatusBadge :tone="enabledTone(tool.enabled)">
                {{ enabledLabel(tool.enabled) }}
              </StatusBadge>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                :disabled="busyToolId === tool.id"
                @click="toggleTool(tool)"
              >
                {{ tool.enabled ? "停用" : "启用" }}
              </Button>
            </div>
          </li>
        </ul>
      </div>

      <!-- Tab 3：绑定 -->
      <div v-else class="grid gap-[var(--section-gap)]">
        <Card class="grid gap-4 p-[var(--card-padding)]">
          <SectionHeader title="项目绑定" />
          <EmptyState
            v-if="projectBindings.length === 0"
            :icon="Link2"
            size="compact"
            title="暂无项目绑定。"
          />
          <ul v-else class="m-0 grid list-none gap-3 p-0">
            <li
              v-for="binding in projectBindings"
              :key="bindingRowKey(binding)"
              class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted px-4 py-4"
            >
              <div class="min-w-0 flex-1 basis-55">
                <strong class="block text-body font-semibold text-foreground">{{ bindingRowLabel(binding) }}</strong>
                <p class="m-0 break-words text-secondary text-muted-foreground">{{ binding.projectName ?? binding.projectId }}</p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <StatusBadge :tone="enabledTone(binding.enabled)">
                  {{ enabledLabel(binding.enabled) }}
                </StatusBadge>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  :disabled="busyBindingId === binding.id"
                  @click="toggleBinding(binding)"
                >
                  {{ binding.enabled ? "停用" : "启用" }}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  class="text-danger"
                  :disabled="busyBindingId === binding.id"
                  @click="askRemoveBinding(binding)"
                >
                  撤销
                </Button>
              </div>
            </li>
          </ul>
        </Card>

        <Card class="grid gap-4 p-[var(--card-padding)]">
          <SectionHeader title="Agent 绑定" />
          <EmptyState
            v-if="agentBindings.length === 0"
            :icon="Link2"
            size="compact"
            title="暂无 Agent 绑定。"
          />
          <ul v-else class="m-0 grid list-none gap-3 p-0">
            <li
              v-for="binding in agentBindings"
              :key="bindingRowKey(binding)"
              class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted px-4 py-4"
            >
              <div class="min-w-0 flex-1 basis-55">
                <strong class="block text-body font-semibold text-foreground">{{ bindingRowLabel(binding) }}</strong>
                <p class="m-0 break-words text-secondary text-muted-foreground">{{ binding.projectName ?? binding.projectId }}</p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <StatusBadge :tone="enabledTone(binding.enabled)">
                  {{ enabledLabel(binding.enabled) }}
                </StatusBadge>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  :disabled="busyBindingId === binding.id"
                  @click="toggleBinding(binding)"
                >
                  {{ binding.enabled ? "停用" : "启用" }}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  class="text-danger"
                  :disabled="busyBindingId === binding.id"
                  @click="askRemoveBinding(binding)"
                >
                  撤销
                </Button>
              </div>
            </li>
          </ul>
        </Card>

        <Card class="grid gap-4 p-[var(--card-padding)]">
          <SectionHeader title="创建绑定" />
          <form
            class="grid gap-4"
            @submit.prevent="submitBinding"
            @keydown="onFormKeydown"
          >
            <div class="grid gap-1.5">
              <Label for="mcp-binding-project">项目</Label>
              <Input
                id="mcp-binding-project"
                v-model.trim="form.projectId"
                required
                list="mcp-project-options"
                placeholder="项目 UUID"
              />
              <datalist id="mcp-project-options">
                <option v-for="project in projectOptions" :key="project.id" :value="project.id">
                  {{ project.name }}
                </option>
              </datalist>
            </div>
            <div class="grid gap-1.5">
              <Label for="mcp-binding-agent">Agent（可选 — 留空为项目级）</Label>
              <Input id="mcp-binding-agent" v-model.trim="form.agentName" placeholder="dev-agent" />
            </div>
            <div class="grid gap-1.5">
              <Label for="mcp-binding-tool">工具（可选 — 留空为全部工具）</Label>
              <Input id="mcp-binding-tool" v-model.trim="form.toolName" placeholder="echo" />
            </div>
            <label class="flex cursor-pointer items-center gap-2 text-body text-foreground">
              <Checkbox v-model="form.enabled" />
              <span class="text-body text-foreground">启用</span>
            </label>
            <p v-if="formError" class="m-0 text-body text-danger">{{ formError }}</p>
            <div>
              <Button type="submit" :disabled="saving">
                {{ saving ? "创建中…" : "创建绑定" }}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </template>

    <!-- 危险操作确认：全站唯一的一种（W8），见 components/README.md §2 -->
    <ConfirmDialog
      :open="pendingRevoke !== null"
      title="撤销该绑定"
      description="撤销后立即生效：该 Agent 之后发起的调用会被直接拒绝，且不会自动恢复。"
      confirm-label="撤销绑定"
      busy-label="撤销中…"
      :busy="pendingRevoke !== null && busyBindingId === pendingRevoke.id"
      :error="revokeError"
      @update:open="(open) => (pendingRevoke = open ? pendingRevoke : null)"
      @confirm="removeBinding"
    />
  </PageContainer>
</template>
